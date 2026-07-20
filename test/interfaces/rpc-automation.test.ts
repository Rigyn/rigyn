import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AdapterEvent, ModelInfo, ProviderAdapter, ProviderRequest } from "../../src/core/types.js";
import { RpcRuntimeDispatcher } from "../../src/interfaces/rpc-runtime.js";
import type { RpcRequest } from "../../src/interfaces/rpc.js";
import { CapturePeer, createTestRuntime } from "./rpc-helpers.js";

const observedAt = "2026-01-01T00:00:00.000Z";
const unknown = { value: "unknown" as const, source: "provider" as const, observedAt };

function request(method: string, params?: unknown): RpcRequest {
  return { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) };
}

class AutomationProvider implements ProviderAdapter {
  readonly id = "automation-provider";
  readonly requests: ProviderRequest[] = [];

  async *stream(input: ProviderRequest): AsyncIterable<AdapterEvent> {
    this.requests.push(input);
    yield { type: "response_start", model: input.model };
    yield {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "done" } },
    };
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    signal.throwIfAborted();
    return [{
      provider: this.id,
      id: "coder",
      capabilities: { tools: unknown, reasoning: unknown, images: unknown },
      compatibility: {
        reasoningEfforts: { value: ["off", "low", "high"], source: "provider", observedAt },
      },
    }];
  }
}

test("RPC mutates an idle thread model and thinking level without starting an agent run", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-rpc-automation-selection-"));
  const provider = new AutomationProvider();
  const runtime = await createTestRuntime(root, join(root, "sessions.sqlite"), provider);
  const dispatcher = new RpcRuntimeDispatcher({ runtime });
  const peer = new CapturePeer("selection-owner");
  t.after(async () => {
    await dispatcher.close("test complete");
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  const thread = await runtime.service.createSession({ name: "automation" });
  const selected = await dispatcher.dispatch(peer, request("thread.model.set", {
    threadId: thread.threadId,
    reference: "automation/coder",
    reasoningEffort: "low",
  }));
  assert.deepEqual(selected, {
    provider: "automation-provider",
    model: "coder",
    reasoningEffort: "low",
  });
  assert.equal(provider.requests.length, 0);
  assert.equal(runtime.store.listRuns(thread.threadId).length, 0);

  const thinking = await dispatcher.dispatch(peer, request("thread.thinking.set", {
    threadId: thread.threadId,
    reasoningEffort: "high",
  }));
  assert.deepEqual(thinking, {
    provider: "automation-provider",
    model: "coder",
    reasoningEffort: "high",
  });
  const state = await dispatcher.dispatch(peer, request("thread.state", { threadId: thread.threadId })) as {
    provider?: string;
    model?: string;
    reasoningEffort?: string;
  };
  assert.deepEqual(state, {
    ...state,
    provider: "automation-provider",
    model: "coder",
    reasoningEffort: "high",
  });
  assert.equal(runtime.store.listRuns(thread.threadId).length, 0);
  assert.equal(
    runtime.store.listEvents(thread.threadId).filter((entry) => entry.event.type === "model_selected").length,
    2,
  );
});

test("RPC user shell execution is bounded to its workspace and persists only visible results", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-rpc-automation-shell-"));
  const provider = new AutomationProvider();
  const runtime = await createTestRuntime(root, join(root, "sessions.sqlite"), provider);
  const dispatcher = new RpcRuntimeDispatcher({ runtime });
  const peer = new CapturePeer("shell-owner");
  t.after(async () => {
    await dispatcher.close("test complete");
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  const thread = await runtime.service.createSession({ name: "shell" });
  const visible = await dispatcher.dispatch(peer, request("shell.run", {
    runId: "visible-shell",
    threadId: thread.threadId,
    command: "printf rpc-visible",
  })) as {
    runId: string;
    threadId: string;
    branch: string;
    excludedFromContext: boolean;
    result: { text: string; exitCode: number | null };
  };
  assert.equal(visible.runId, "visible-shell");
  assert.equal(visible.threadId, thread.threadId);
  assert.equal(visible.branch, "main");
  assert.equal(visible.excludedFromContext, false);
  assert.equal(visible.result.exitCode, 0);
  assert.match(visible.result.text, /rpc-visible[\s\S]*exit 0/u);
  const visibleEvents = runtime.store.listEvents(thread.threadId);
  assert.equal(visibleEvents.length, 1);
  assert.equal(visibleEvents[0]?.event.type, "message_appended");

  await dispatcher.dispatch(peer, request("shell.run", {
    runId: "hidden-shell",
    threadId: thread.threadId,
    command: "printf rpc-hidden",
    excludeFromContext: true,
  }));
  assert.equal(runtime.store.listEvents(thread.threadId).length, 1);

  await assert.rejects(
    dispatcher.dispatch(peer, request("shell.run", {
      runId: "outside-shell",
      threadId: thread.threadId,
      command: "pwd",
      cwd: tmpdir(),
    })),
    /outside the workspace|escapes (?:the )?workspace/u,
  );
});

test("RPC user shell cancellation is explicit and peer-owned", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-rpc-automation-cancel-"));
  const provider = new AutomationProvider();
  const runtime = await createTestRuntime(root, join(root, "sessions.sqlite"), provider);
  const dispatcher = new RpcRuntimeDispatcher({ runtime });
  const owner = new CapturePeer("shell-owner");
  const foreign = new CapturePeer("shell-foreign");
  t.after(async () => {
    await dispatcher.close("test complete");
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  const thread = await runtime.service.createSession({ name: "cancel" });
  const running = dispatcher.dispatch(owner, request("shell.run", {
    runId: "cancel-shell",
    threadId: thread.threadId,
    command: "while :; do sleep 1; done",
    excludeFromContext: true,
  }));
  const activeState = await dispatcher.dispatch(owner, request("thread.state", {
    threadId: thread.threadId,
  })) as { active: boolean; operation: string | null };
  assert.equal(activeState.active, true);
  assert.equal(activeState.operation, "shell");
  await assert.rejects(
    dispatcher.dispatch(foreign, request("shell.cancel", { runId: "cancel-shell" })),
    /Unknown RPC user shell run/u,
  );
  assert.deepEqual(
    await dispatcher.dispatch(owner, request("shell.cancel", { runId: "cancel-shell", reason: "stop test shell" })),
    { accepted: true },
  );
  await assert.rejects(running, /stop test shell/u);
  assert.equal(runtime.store.listEvents(thread.threadId).length, 0);
});
