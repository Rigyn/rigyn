import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createEmbeddingHarness,
  createInMemoryHarness,
} from "../../src/embedding/index.js";
import type { EventEnvelope } from "../../src/core/events.js";
import { createScriptedProvider } from "../../src/testing/index.js";

const FORBIDDEN_FACADE_PROPERTIES = [
  "auth",
  "config",
  "credentials",
  "providers",
  "service",
  "store",
] as const;

test("in-memory embedding runs and resumes without exposing host internals", async () => {
  const provider = createScriptedProvider({
    id: "embedding-memory",
    models: [{ id: "model-a" }],
    scripts: [
      { kind: "turn", content: [{ type: "text", text: "first" }] },
      { kind: "turn", content: [{ type: "text", text: "second" }] },
    ],
  });
  await using harness = await createInMemoryHarness({ provider, model: "model-a" });

  for (const property of FORBIDDEN_FACADE_PROPERTIES) assert.equal(property in harness, false);
  const first = await harness.run({ prompt: "one" });
  assert.equal(first.threadId, "thread_memory_000001");
  assert.equal(first.results.at(-1)?.finalText, "first");
  const second = await harness.run({ threadId: first.threadId, prompt: "two" });
  assert.equal(second.threadId, first.threadId);
  assert.equal(second.results.at(-1)?.finalText, "second");
  const requests = provider.capturedRequests();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0]?.tools, []);
  assert.equal(
    requests[1]?.messages.some((message) =>
      message.role === "assistant" &&
      message.content.some((block) => block.type === "text" && block.text === "first")),
    true,
  );
  await harness.waitForIdle();
});

test("in-memory embedding applies selection, timeout, cancellation, and close bounds", async () => {
  const defaultProvider = createScriptedProvider({
    id: "embedding-default",
    models: [{ id: "default-model" }],
    scripts: [{
      kind: "turn",
      content: [{ type: "text", text: "deadline" }],
      eventDelayMs: 500,
    }],
  });
  const alternateProvider = createScriptedProvider({
    id: "embedding-alternate",
    models: [{ id: "alternate-model" }],
    scripts: [{ kind: "turn", content: [{ type: "text", text: "alternate" }] }],
  });
  const harness = await createInMemoryHarness({
    provider: defaultProvider,
    model: "default-model",
    additionalProviders: [alternateProvider],
    timeoutMs: 50,
  });

  await assert.rejects(
    harness.run({
      prompt: "fuzzy selection",
      selection: { provider: alternateProvider.id, model: "alternate" },
    }),
    /must be exact/u,
  );
  const alternate = await harness.run({
    prompt: "select",
    selection: { provider: alternateProvider.id, model: "alternate-model" },
  });
  assert.equal(alternate.results.at(-1)?.finalText, "alternate");

  const timed = await harness.start({ prompt: "bounded" });
  const timedResult = await timed.result;
  assert.equal(timedResult.results.at(-1)?.finishReason, "cancelled");
  await harness.waitForIdle();

  defaultProvider.appendScripts([{
    kind: "turn",
    content: [{ type: "text", text: "manual cancellation" }],
    eventDelayMs: 500,
  }]);
  const cancelled = await harness.start({ prompt: "cancel" });
  cancelled.cancel("test cancellation");
  assert.equal((await cancelled.result).results.at(-1)?.finishReason, "cancelled");

  defaultProvider.appendScripts([{
    kind: "turn",
    content: [{ type: "text", text: "close cancellation" }],
    eventDelayMs: 500,
  }]);
  const closing = await harness.start({ prompt: "close" });
  await harness.close();
  assert.equal((await closing.result).results.at(-1)?.finishReason, "cancelled");
  await harness.close();
  await assert.rejects(harness.start({ prompt: "late" }), /closing/u);
});

test("in-memory embedding rejects a fuzzy default model", async () => {
  const provider = createScriptedProvider({
    id: "embedding-exact",
    models: [{ id: "exact-model" }],
  });
  await assert.rejects(
    createInMemoryHarness({ provider, model: "model" }),
    /must be exact/u,
  );
});

test("configured embedding facade hides broad runtime authority", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-embedding-facade-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const priorConfig = process.env.XDG_CONFIG_HOME;
  const priorState = process.env.XDG_STATE_HOME;
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_STATE_HOME = join(root, "state");
  context.after(() => {
    if (priorConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorConfig;
    if (priorState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = priorState;
  });

  const harness = await createEmbeddingHarness({ workspace: root, extensions: false, recover: false });
  try {
    for (const property of FORBIDDEN_FACADE_PROPERTIES) assert.equal(property in harness, false);
    assert.equal(typeof harness.run, "function");
    assert.equal(typeof harness.resourceCatalog, "function");
    assert.equal(typeof harness.reload, "function");
  } finally {
    await harness.close();
  }
});

test("configured embedding sessions provide a safe application facade", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-embedding-session-"));
  const workspace = join(root, "workspace");
  const configHome = join(root, "config");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const priorConfig = process.env.XDG_CONFIG_HOME;
  const priorState = process.env.XDG_STATE_HOME;
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.XDG_STATE_HOME = join(root, "state");
  context.after(() => {
    if (priorConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorConfig;
    if (priorState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = priorState;
  });

  await mkdir(configHome, { mode: 0o700 });
  await mkdir(join(configHome, "rigyn"), { mode: 0o700 });
  const extension = join(configHome, "rigyn", "extensions", "embedding-session-fixture");
  await mkdir(join(extension, "runtime"), { recursive: true });
  await writeFile(join(extension, "extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "embedding-session-fixture",
    name: "Embedding session fixture",
    version: "1.0.0",
    contributions: { runtime: [{ path: "runtime/index.mjs" }] },
  }));
  await writeFile(join(extension, "runtime", "index.mjs"), `export default function activate(api) {
    api.registerProvider({
      id: "embedding-session-fixture",
      async *stream(request, signal) {
        signal.throwIfAborted();
        const user = request.messages.filter((message) => message.role === "user").at(-1);
        const reply = user?.content.filter((block) => block.type === "text").map((block) => block.text).join("\\n") ?? "empty";
        yield { type: "response_start", model: request.model };
        yield { type: "reasoning_delta", part: 0, text: "provider-private reasoning", visibility: "provider_trace" };
        yield { type: "text_delta", part: 0, text: "embedded:" + reply };
        yield { type: "usage", semantics: "final", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, raw: { private: true } } };
        yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "embedded:" + reply } } };
      },
      async listModels() {
        const supported = { value: "supported", source: "provider", observedAt: "2026-07-17T00:00:00.000Z" };
        return [{
          id: "session-model",
          provider: "embedding-session-fixture",
          capabilities: { tools: supported, reasoning: supported, images: supported },
        }];
      },
    });
  }\n`);

  const harness = await createEmbeddingHarness({ workspace, extensions: true, recover: false });
  context.after(async () => await harness.close().catch(() => undefined));
  const resources = await harness.resourceCatalog();
  assert.ok(
    resources.extensions.some((entry) => entry.id === "embedding-session-fixture" && entry.status === "active"),
    "fixture extension was not active",
  );
  assert.ok(
    resources.providers.some((entry) => entry.id === "embedding-session-fixture"),
    "fixture provider was not registered",
  );
  const session = await harness.createSession({ name: "application session" });
  for (const property of FORBIDDEN_FACADE_PROPERTIES) assert.equal(property in session, false);
  assert.equal(session.branch, "main");
  assert.equal((await harness.listSessions()).sessions[0]?.threadId, session.threadId);
  await session.setModel({ provider: "embedding-session-fixture", model: "session-model" });
  assert.deepEqual(session.getModel(), { provider: "embedding-session-fixture", model: "session-model" });
  const openedBeforeRun = await harness.openSession({ threadId: session.threadId });
  assert.deepEqual(openedBeforeRun.getModel(), { provider: "embedding-session-fixture", model: "session-model" });

  const observed: EventEnvelope[] = [];
  const stopMutatingObserver = session.subscribe((event) => {
    if (event.event.type === "usage") event.event.usage.inputTokens = 999;
  });
  const unsubscribe = session.subscribe((event) => { observed.push(event); });
  const result = await session.run({ prompt: "hello from app" });
  stopMutatingObserver();
  unsubscribe();
  assert.equal(result.results.at(-1)?.finalText, "embedded:hello from app");
  assert.ok(observed.some((event) => event.event.type === "run_started"));
  assert.ok(observed.some((event) => event.event.type === "run_completed"));
  assert.equal(observed.some((event) =>
    event.event.type === "reasoning_delta" && event.event.visibility === "provider_trace"), false);
  const usage = observed.find((event) => event.event.type === "usage")?.event;
  assert.equal(usage?.type, "usage");
  if (usage?.type === "usage") {
    assert.equal(usage.usage.inputTokens, 1);
    assert.equal(usage.usage.raw, undefined);
  }
  const assistant = observed.find((event) =>
    event.event.type === "message_appended" && event.event.message.role === "assistant")?.event;
  assert.equal(assistant?.type, "message_appended");
  if (assistant?.type === "message_appended") {
    assert.equal(assistant.providerState, undefined);
    assert.equal(assistant.providerStateSerialized, undefined);
  }
  assert.deepEqual(session.getModel(), { provider: "embedding-session-fixture", model: "session-model" });
  assert.ok((await session.transcript()).entries.some((entry) => entry.kind === "message" && entry.role === "assistant"));

  await session.setName("renamed application session");
  const reopened = await harness.openSession({ threadId: session.threadId });
  assert.deepEqual(reopened.getModel(), { provider: "embedding-session-fixture", model: "session-model" });
  const navigated = await reopened.navigate({ targetBranch: "main", targetEventId: null, newBranch: "empty-branch" });
  assert.equal(navigated.cancelled, false);
  assert.equal(navigated.branch, "empty-branch");
  const emptyBranch = await harness.openSession({ threadId: session.threadId, branch: "empty-branch" });
  let startedResolve!: () => void;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  let releaseResolve!: () => void;
  const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const active = await emptyBranch.start({
    prompt: "hold the empty branch",
    selection: { provider: "embedding-session-fixture", model: "session-model" },
    onEvent: async (event) => {
      if (event.event.type !== "run_started") return;
      startedResolve();
      await release;
    },
  });
  await started;
  try {
    assert.throws(() => reopened.steer("wrong branch"), /Active run is on branch empty-branch, not main/u);
    assert.throws(() => reopened.followUp("wrong branch"), /Active run is on branch empty-branch, not main/u);
    assert.throws(() => reopened.abort("wrong branch"), /Active run is on branch empty-branch, not main/u);
  } finally {
    releaseResolve();
  }
  assert.equal((await active.result).results.at(-1)?.finalText, "embedded:hold the empty branch");
  const copied = await reopened.fork({ name: "application copy" });
  assert.notEqual(copied.threadId, reopened.threadId);
  assert.equal((await harness.listSessions()).sessions.length, 2);
  await harness.waitForIdle();

  await harness.close();
  assert.throws(() => session.subscribe(() => undefined), /Embedding harness is closing/u);
  assert.throws(() => session.getModel(), /Embedding harness is closing/u);
  await assert.rejects(session.transcript(), /Embedding harness is closing/u);
  await assert.rejects(harness.listSessions(), /Embedding harness is closing/u);

  const foreignWorkspace = join(root, "foreign-workspace");
  await mkdir(foreignWorkspace);
  const foreign = await createEmbeddingHarness({ workspace: foreignWorkspace, extensions: true, recover: false });
  try {
    assert.equal((await foreign.listSessions()).sessions.length, 0);
    await assert.rejects(foreign.openSession({ threadId: session.threadId }), /belongs to .* not /u);
  } finally {
    await foreign.close();
  }

  const restarted = await createEmbeddingHarness({ workspace, extensions: true, recover: false });
  try {
    const persisted = await restarted.openSession({ threadId: session.threadId });
    assert.deepEqual(persisted.getModel(), { provider: "embedding-session-fixture", model: "session-model" });
    assert.ok((await persisted.transcript()).entries.some((entry) =>
      entry.kind === "message" && entry.role === "assistant" && entry.text === "embedded:hello from app"));
  } finally {
    await restarted.close();
  }
});
