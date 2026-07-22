import assert from "node:assert/strict";
import test from "node:test";

import {
  createEmbeddingHarnessFromRuntime,
} from "../../src/embedding/index.js";
import type { HarnessRuntime } from "../../src/public-runtime.js";
import type { AgentSession, AgentSessionModel } from "../../src/service/agent-session.js";
import { createInMemoryHarness } from "../../src/embedding/index.js";
import { createScriptedProvider } from "../../src/testing/scripted-provider.js";

function fakeSession(id: string) {
  const calls: string[] = [];
  const selected: AgentSessionModel = {
    provider: "fixture-provider",
    api: "openai-chat-completions",
    id: `${id}-model`,
  };
  const session = {
    sessionId: id,
    cwd: `/workspace/${id}`,
    model: selected,
    isIdle: true,
    async waitForIdle() { calls.push("idle"); },
    async resolveModel(reference: string) {
      calls.push(`resolve:${reference}`);
      return { ...selected, id: reference };
    },
    async setModel(model: AgentSessionModel) { calls.push(`set:${model.id}`); },
    setThinkingLevel(level: string) { calls.push(`thinking:${level}`); },
    setSessionName(name: string) { calls.push(`name:${name}`); },
    onEvent() { calls.push("subscribe"); return () => calls.push("unsubscribe"); },
    steer(text: string) { calls.push(`steer:${text}`); },
    followUp(text: string) { calls.push(`follow:${text}`); },
    abort(reason?: string) { calls.push(`abort:${reason ?? ""}`); },
    cancelRetry() { return false; },
    prompt() { throw new Error("not used by this boundary test"); },
  } as unknown as AgentSession;
  return { session, calls };
}

test("configured embedding sessions remain live when reload replaces the runtime session", async () => {
  let current = fakeSession("before");
  const replacement = fakeSession("after");
  const runtime = {
    get session() { return current.session; },
    async reload() { current = replacement; return { warnings: [] }; },
    async close() {},
  } as unknown as HarnessRuntime;

  const harness = createEmbeddingHarnessFromRuntime(runtime);
  const session = harness.session;
  assert.equal(session, harness.session);
  assert.equal(session.id, "before");

  await session.waitForIdle();
  assert.deepEqual(current.calls, ["idle"]);

  await harness.reload();
  assert.equal(session.id, "after");
  assert.equal(session.cwd, "/workspace/after");
  assert.equal((await session.resolveModel("selected")).id, "selected");
  await session.setModel({ provider: "fixture-provider", api: "openai-chat-completions", id: "selected" });
  const steering = session.steer("adjust");
  const followUp = session.followUp("continue");
  assert.equal(steering instanceof Promise, true);
  assert.equal(followUp instanceof Promise, true);
  await Promise.all([steering, followUp]);
  assert.deepEqual(replacement.calls, ["resolve:selected", "set:selected", "steer:adjust", "follow:continue"]);
});

test("an embedding run handle can cancel immediately after start", async () => {
  const provider = createScriptedProvider({
    id: "embedding-cancel",
    models: [{ id: "fixture" }],
    scripts: [{
      kind: "turn",
      content: [{ type: "text", text: "late response" }],
      eventDelayMs: 1_000,
    }],
  });
  await using harness = await createInMemoryHarness({
    provider,
    model: "fixture",
    api: "openai-chat-completions",
  });

  const run = harness.session.start({ prompt: "cancel now" });
  run.abort("test cancellation");

  const result = await run.result;
  assert.equal(result.results.at(-1)?.finishReason, "cancelled");
});

test("the offline in-memory harness preserves an explicit API when scripted catalog metadata omits it", async () => {
  const provider = createScriptedProvider({
    id: "embedding-explicit-api",
    models: [{ id: "fixture" }],
    scripts: [{ kind: "turn", content: [{ type: "text", text: "explicit API works" }] }],
  });
  await using harness = await createInMemoryHarness({
    provider,
    model: "fixture",
    api: "openai-chat-completions",
  });

  const result = await harness.session.run({ prompt: "offline" });
  assert.equal(result.results.at(-1)?.finalText, "explicit API works");
});

test("the in-memory harness still requires catalog API metadata when no explicit API is supplied", async () => {
  const provider = createScriptedProvider({
    id: "embedding-missing-api",
    models: [{ id: "fixture" }],
    scripts: [],
  });
  await assert.rejects(
    createInMemoryHarness({ provider, model: "fixture" } as unknown as Parameters<typeof createInMemoryHarness>[0]),
    /does not declare an API protocol/u,
  );
});
