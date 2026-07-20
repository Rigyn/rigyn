import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createHarnessRuntime } from "../../src/public-runtime.js";
import { createScriptedProvider } from "../../src/testing/index.js";

test("owned public runtime loads resources, runs offline, waits idle, and closes idempotently", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-public-runtime-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const originalConfig = process.env.XDG_CONFIG_HOME;
  const originalState = process.env.XDG_STATE_HOME;
  const configHome = join(root, "config");
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.XDG_STATE_HOME = join(root, "state");
  t.after(() => {
    if (originalConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalConfig;
    if (originalState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = originalState;
  });

  const extension = join(configHome, "rigyn", "extensions", "public-lifecycle");
  await mkdir(join(extension, "runtime"), { recursive: true, mode: 0o700 });
  await writeFile(join(extension, "extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "public-lifecycle",
    name: "Public lifecycle fixture",
    version: "1.0.0",
    contributions: { runtime: [{ path: "runtime/index.mjs" }] },
  }));
  await writeFile(join(extension, "runtime", "index.mjs"), `export default (api) => {
    const record = (name, event) => {
      globalThis.__publicRuntimeLifecycle ??= [];
      globalThis.__publicRuntimeLifecycle.push({ name, threadId: event.threadId });
    };
    for (const name of [
      "session_start", "session_end", "session_shutdown", "model_select", "thinking_level_select",
      "agent_start", "agent_end", "agent_settled", "turn_start", "turn_end", "message_start", "message_update", "event"
    ]) api.on(name, (event) => { record(name, event); });
  };
  `);
  (globalThis as Record<string, unknown>).__publicRuntimeLifecycle = [];

  const runtime = await createHarnessRuntime({
    workspace,
    extensions: true,
  });
  const provider = createScriptedProvider({
    id: "public-offline",
    models: [{ id: "model-a" }, { id: "model-b" }],
    scripts: [{ kind: "turn", content: [{ type: "text", text: "offline result" }] }],
  });
  runtime.providers.register(provider);
  await assert.rejects(
    runtime.start({ prompt: "ambiguous", provider: provider.id, model: "model" }),
    /ambiguous/u,
  );
  assert.equal(runtime.store.listThreads({ workspaceRoot: workspace }).length, 0);

  const run = await runtime.start({ prompt: "test", provider: provider.id, model: "model-a" });
  assert.match(run.threadId, /^thread_/u);
  const result = await run.result;
  assert.equal(run.cancelRetry(), false);
  assert.equal(result.threadId, run.threadId);
  assert.equal(result.results.at(-1)?.finalText, "offline result");
  await runtime.waitForIdle();
  assert.equal(runtime.store.getThread(run.threadId).threadId, run.threadId);

  provider.appendScripts([{
    kind: "turn",
    content: [{ type: "text", text: "should be cancelled" }],
    eventDelayMs: 100,
  }]);
  const cancelled = await runtime.start({ prompt: "cancel", provider: provider.id, model: "model-a" });
  cancelled.cancel("consumer cancellation");
  const cancelledResult = await cancelled.result;
  assert.equal(cancelledResult.results.at(-1)?.finishReason, "cancelled");
  await runtime.waitForIdle();

  provider.appendScripts([{ kind: "turn", content: [{ type: "text", text: "resumed first session" }] }]);
  const resumed = await runtime.start({
    threadId: run.threadId,
    prompt: "resume first",
    provider: provider.id,
    model: "model-a",
  });
  assert.equal((await resumed.result).results.at(-1)?.finishReason, "stop");
  await runtime.close();
  await runtime.close();

  const records = (globalThis as Record<string, unknown>).__publicRuntimeLifecycle as Array<{ name: string; threadId?: string }>;
  const lifecycle = records.map((entry) => entry.name);
  const sessionStart = lifecycle.indexOf("session_start");
  const modelSelect = lifecycle.indexOf("model_select");
  const thinkingSelect = lifecycle.indexOf("thinking_level_select");
  const agentStart = lifecycle.indexOf("agent_start");
  const turnStart = lifecycle.indexOf("turn_start");
  const messageStart = lifecycle.indexOf("message_start");
  const messageUpdate = lifecycle.indexOf("message_update");
  const turnEnd = lifecycle.indexOf("turn_end");
  const agentEnd = lifecycle.indexOf("agent_end");
  const agentSettled = lifecycle.indexOf("agent_settled");
  const sessionEnd = lifecycle.indexOf("session_end");
  const shutdown = lifecycle.indexOf("session_shutdown");
  assert.ok(sessionStart < modelSelect && modelSelect < agentStart);
  assert.equal(thinkingSelect, -1, "off-to-off reasoning is not a selection change");
  assert.ok(agentStart < turnStart && turnStart < messageStart && messageStart < messageUpdate && messageUpdate < turnEnd);
  assert.ok(turnEnd < agentEnd && agentEnd < agentSettled && agentSettled < sessionEnd && sessionEnd < shutdown);
  assert.ok(lifecycle.includes("event"));
  assert.deepEqual(
    records.filter((entry) => entry.name === "session_start").map((entry) => entry.threadId),
    [run.threadId, cancelled.threadId],
  );
  assert.equal(records.filter((entry) => entry.name === "session_end").length, 2);
  assert.equal(records.filter((entry) => entry.name === "session_shutdown").length, 1);
  delete (globalThis as Record<string, unknown>).__publicRuntimeLifecycle;
});

test("owned public runtime serializes pending starts with idle waits and close", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-public-runtime-race-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const originalConfig = process.env.XDG_CONFIG_HOME;
  const originalState = process.env.XDG_STATE_HOME;
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_STATE_HOME = join(root, "state");
  t.after(() => {
    if (originalConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalConfig;
    if (originalState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = originalState;
  });

  const runtime = await createHarnessRuntime({
    workspace,
    extensions: false,
  });
  t.after(async () => await runtime.close().catch(() => undefined));
  const provider = createScriptedProvider({
    id: "public-delayed-catalog",
    models: [{ id: "model-a" }],
    scripts: [{ kind: "turn", content: [{ type: "text", text: "settled" }], eventDelayMs: 100 }],
  });
  let enterCatalog!: () => void;
  const catalogEntered = new Promise<void>((resolve) => { enterCatalog = resolve; });
  let releaseCatalog!: () => void;
  const catalogGate = new Promise<void>((resolve) => { releaseCatalog = resolve; });
  runtime.providers.register({
    id: provider.id,
    stream: provider.stream.bind(provider),
    async listModels(signal) {
      enterCatalog();
      await catalogGate;
      signal.throwIfAborted();
      return await provider.listModels(signal);
    },
  });

  const starting = runtime.start({ prompt: "race", provider: provider.id, model: "model-a" });
  await catalogEntered;
  let idleSettled = false;
  const waiting = runtime.waitForIdle().then(() => { idleSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(idleSettled, false, "waitForIdle must include start setup that has not registered its run yet");

  const closing = runtime.close();
  releaseCatalog();
  const handle = await starting;
  assert.match(handle.threadId, /^thread_/u);
  await waiting;
  await closing;
  assert.equal(idleSettled, true);
  assert.ok(["cancelled", "stop"].includes((await handle.result).results.at(-1)?.finishReason ?? ""));
  await assert.rejects(
    runtime.start({ prompt: "late", provider: provider.id, model: "model-a" }),
    /closing/u,
  );
});
