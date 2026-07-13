import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createEmbeddingHarness,
  createInMemoryHarness,
} from "../../src/embedding/index.js";
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
