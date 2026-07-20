import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { EventEnvelope } from "../../src/core/events.js";
import type { ImageBlock } from "../../src/core/types.js";
import type {
  EmbeddingModelSelection,
  EmbeddingSessionRunOptions,
} from "../../src/embedding/index.js";
import {
  createRpcMode,
  runInteractiveMode,
  runOwnedInteractiveMode,
  runPrintMode,
  runRpcMode,
  type InteractiveModeHost,
  type InteractiveModeHostContext,
  type ModeSession,
  type ModeSessionOwner,
} from "../../src/modes/index.js";
import { createHarnessRuntime, type HarnessRuntime } from "../../src/public-runtime.js";
import type { LoadedRuntime } from "../../src/cli/runtime.js";
import { loadRuntimeExtensions } from "../../src/extensions/runtime.js";
import { registerOwnedRuntime } from "../../src/internal/runtime-owner.js";
import type { HarnessRun } from "../../src/service/harness.js";
import { createScriptedProvider } from "../../src/testing/index.js";
import { sha256 } from "../../src/tools/hash.js";
import { createTestRuntime, QueueProvider } from "../interfaces/rpc-helpers.js";

function envelope(
  type: "run_started" | "text_delta" | "run_completed",
  sequence: number,
): EventEnvelope {
  return {
    eventId: `event-${sequence}`,
    threadId: "mode-thread",
    runId: "mode-run",
    sequence,
    timestamp: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
    event: type === "run_started"
      ? { type, provider: "mode-provider", model: "mode-model" }
      : type === "text_delta"
        ? { type, text: "embedded answer", part: 0 }
        : { type, finishReason: "stop" },
  };
}

class FakeSession implements ModeSession {
  readonly threadId = "mode-thread";
  readonly branch = "main";
  readonly prompts: string[] = [];
  readonly selections: Array<EmbeddingModelSelection | undefined> = [];
  readonly steering: Array<{ mode: "steer" | "follow_up"; text: string; images?: ImageBlock[] }> = [];
  aborts = 0;

  async run(options: EmbeddingSessionRunOptions): Promise<HarnessRun> {
    this.prompts.push(options.prompt);
    this.selections.push(options.selection);
    for (const event of [envelope("run_started", 0), envelope("text_delta", 1), envelope("run_completed", 2)]) {
      await options.onEvent?.(event);
    }
    return {
      threadId: this.threadId,
      results: [{
        runId: "mode-run",
        finishReason: "stop",
        finalText: "embedded answer",
        steps: 1,
        queuedFollowUps: [],
        queuedMessages: [],
      }],
    };
  }

  steer(text: string, images?: ImageBlock[]): void {
    this.steering.push({ mode: "steer", text, ...(images === undefined ? {} : { images }) });
  }

  followUp(text: string, images?: ImageBlock[]): void {
    this.steering.push({ mode: "follow_up", text, ...(images === undefined ? {} : { images }) });
  }

  abort(): void { this.aborts += 1; }

  getModel(): EmbeddingModelSelection {
    return { provider: "mode-provider", model: "mode-model", reasoningEffort: "high" };
  }
}

class FakeOwner implements ModeSessionOwner {
  readonly session = new FakeSession();
  creates = 0;
  opens = 0;

  async createSession(): Promise<ModeSession> {
    this.creates += 1;
    return this.session;
  }

  async openSession(): Promise<ModeSession> {
    this.opens += 1;
    return this.session;
  }
}

test("print mode borrows an owner, preserves one session, and emits text or JSON", async () => {
  const owner = new FakeOwner();
  let text = "";
  const result = await runPrintMode(owner, {
    prompts: ["first", "second"],
    selection: { provider: "mode-provider", model: "mode-model" },
    write: (chunk) => { text += chunk; },
  });
  assert.equal(owner.creates, 1);
  assert.deepEqual(owner.session.prompts, ["first", "second"]);
  assert.equal(text, "embedded answer\nembedded answer\n");
  assert.equal(result.finalText, "embedded answer");

  let json = "";
  await runPrintMode(owner, {
    prompts: "third",
    session: { threadId: owner.session.threadId },
    format: "json",
    write: (chunk) => { json += chunk; },
  });
  assert.equal(owner.opens, 1);
  const events = json.trim().split("\n").map((line) => JSON.parse(line) as EventEnvelope);
  assert.deepEqual(events.map((entry) => entry.event.type), ["run_started", "text_delta", "run_completed"]);
});

test("interactive mode renders a complete borrowed run and leaves the owner open", async () => {
  const owner = new FakeOwner();
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

  const result = await runInteractiveMode(owner, {
    initialPrompts: ["hello", "/exit"],
    terminal: { input, output, mode: "accessible", handleSignals: false, environment: {} },
  });

  assert.equal(owner.creates, 1);
  assert.deepEqual(owner.session.prompts, ["hello"]);
  assert.equal(result.finalText, "embedded answer");
  assert.match(Buffer.concat(chunks).toString("utf8"), /embedded answer/u);
});

test("interactive mode keeps one host context and routes handled and transformed input", async () => {
  const owner = new FakeOwner();
  const input = new PassThrough();
  const output = new PassThrough();
  let attached: InteractiveModeHostContext | undefined;
  let repaints = 0;
  let detached = 0;
  const host: InteractiveModeHost = {
    attach(context) {
      attached = context;
      return () => { detached += 1; };
    },
    repaint(context) {
      assert.equal(context, attached);
      repaints += 1;
    },
    route(text, _images, context) {
      assert.equal(context, attached);
      return text === "/handled"
        ? { action: "handled" }
        : { action: "submit", text: `host:${text}` };
    },
  };

  await runInteractiveMode(owner, {
    host,
    initialPrompts: ["/handled", "hello", "/exit"],
    terminal: { input, output, mode: "accessible", handleSignals: false, environment: {} },
  });

  assert.deepEqual(owner.session.prompts, ["host:hello"]);
  assert.equal(repaints, 1);
  assert.equal(detached, 1);
});

test("owned interactive mode applies the configured default to a new unselected session", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-owned-default-selection-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".rigyn"), { recursive: true });
  await writeFile(join(workspace, ".rigyn", "config.jsonc"), JSON.stringify({
    defaultProvider: "owned-selection",
    defaultModel: "model-a",
  }), "utf8");
  const runtime = await createHarnessRuntime({
    workspace,
    projectTrusted: true,
    sessionDirectory: join(root, "sessions"),
    extensions: false,
    skills: false,
    promptTemplates: false,
    themes: false,
  });
  context.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const provider = createScriptedProvider({
    id: "owned-selection",
    models: [{ id: "model-a" }, { id: "model-b" }],
    scripts: [{ kind: "turn", content: [{ type: "text", text: "default selected" }] }],
  });
  runtime.providers.register(provider);
  runtime.auth.register({
    providerId: provider.id,
    credentialId: provider.id,
    displayName: "Owned selection fixture",
    local: true,
  });
  const output = new PassThrough();
  output.resume();

  const result = await runOwnedInteractiveMode(runtime, {
    initialPrompts: ["use the configured default", "/exit"],
    terminal: {
      input: new PassThrough(),
      output,
      mode: "accessible",
      handleSignals: false,
      environment: {},
    },
  });

  assert.deepEqual(provider.capturedRequests().map((request) => request.model), ["model-a"]);
  assert.deepEqual(runtime.store.getModelSelection(result.threadId, result.branch), {
    provider: "owned-selection",
    model: "model-a",
  });
});

test("owned interactive mode follows a later model selection instead of pinning its initial run selection", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-owned-changing-selection-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const runtime = await createHarnessRuntime({
    workspace,
    projectTrusted: true,
    sessionDirectory: join(root, "sessions"),
    extensions: false,
    skills: false,
    promptTemplates: false,
    themes: false,
  });
  context.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const provider = createScriptedProvider({
    id: "owned-selection",
    models: [{ id: "model-a" }, { id: "model-b" }],
    scripts: [
      { kind: "turn", content: [{ type: "text", text: "first model" }] },
      { kind: "turn", content: [{ type: "text", text: "second model" }] },
    ],
  });
  runtime.providers.register(provider);
  runtime.auth.register({
    providerId: provider.id,
    credentialId: provider.id,
    displayName: "Owned selection fixture",
    local: true,
  });
  const output = new PassThrough();
  output.resume();

  const result = await runOwnedInteractiveMode(runtime, {
    run: {
      selection: { provider: "owned-selection", model: "model-a" },
      maxOutputTokens: 321,
    },
    initialPrompts: [
      "use the initial model",
      "/model owned-selection/model-b",
      "use the newly selected model",
      "/exit",
    ],
    terminal: {
      input: new PassThrough(),
      output,
      mode: "accessible",
      handleSignals: false,
      environment: {},
    },
  });

  assert.deepEqual(runtime.store.getModelSelection(result.threadId, result.branch), {
    provider: "owned-selection",
    model: "model-b",
  });
  const requests = provider.capturedRequests();
  assert.deepEqual(requests.map((request) => request.model), ["model-a", "model-b"]);
  assert.deepEqual(requests.map((request) => request.maxOutputTokens), [321, 321]);
});

test("in-process RPC modes borrow one runtime and provide typed requests", async (context) => {
  const runtime = await createTestRuntime(process.cwd(), ":memory:", new QueueProvider(["ready"]));
  context.after(async () => await runtime.close());
  const owner = runtime as unknown as HarnessRuntime;
  registerOwnedRuntime(owner, runtime as unknown as LoadedRuntime, () => {});

  const rpc = createRpcMode(owner, { peerId: "mode-test" });
  const health = await rpc.request("health");
  assert.equal(health.status, "ok");
  assert.equal(health.clients, 1);
  await rpc.close();

  const version = await runRpcMode(owner, async (scoped) => await scoped.request("version"), {
    peerId: "mode-scoped",
  });
  assert.equal(version.name, "rigyn");

  const thread = await runtime.service.createSession({ name: "runtime-still-open" });
  assert.equal(runtime.store.getThread(thread.threadId)?.name, "runtime-still-open");
});

test("owned RPC mode privately binds extension runtime behavior and leases it exclusively", async (context) => {
  assert.throws(
    () => createRpcMode({} as HarnessRuntime, { peerId: "unowned" }),
    /requires a runtime returned by createHarnessRuntime/u,
  );
  const root = await mkdtemp(join(tmpdir(), "rigyn-mode-owner-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const source = `export default (api) => api.registerCommand({ name: "owned-command", async execute() { return { handled: true }; } });\n`;
  const sourcePath = join(root, "extension.mjs");
  await writeFile(sourcePath, source, "utf8");
  const runtimeExtensions = await loadRuntimeExtensions([{
    extensionId: "owned-mode-test",
    sourcePath,
    sha256: sha256(source),
  }], { workspace: root });
  const base = await createTestRuntime(root, ":memory:", new QueueProvider([]));
  context.after(async () => {
    await runtimeExtensions.close();
    await base.close();
  });
  const owner = base as unknown as HarnessRuntime;
  let restores = 0;
  const fullRuntime = {
    ...base,
    runtimeExtensions,
    setExtensionShutdownHandler(handler: Parameters<typeof runtimeExtensions.setShutdownHandler>[0]) {
      runtimeExtensions.setShutdownHandler(handler);
    },
  } as unknown as LoadedRuntime;
  registerOwnedRuntime(owner, fullRuntime, () => {
    restores += 1;
    runtimeExtensions.setShutdownHandler(undefined);
  });

  const first = createRpcMode(owner, { peerId: "owned-first" });
  assert.deepEqual((await first.request("extension.command.list")).map((command) => command.name), ["owned-command"]);
  assert.throws(() => createRpcMode(owner, { peerId: "owned-conflict" }), /already has an active/u);
  await first.close();
  assert.equal(restores, 1);

  await using second = createRpcMode(owner, { peerId: "owned-second" });
  assert.deepEqual((await second.request("extension.command.list")).map((command) => command.name), ["owned-command"]);
});
