import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AdapterEvent, ModelInfo, ProviderAdapter, ProviderRequest } from "../../src/core/types.js";
import { RpcRuntimeDispatcher } from "../../src/interfaces/rpc-runtime.js";
import type { RpcRequest } from "../../src/interfaces/rpc.js";
import { CapturePeer, createTestRuntime } from "./rpc-helpers.js";

function request(method: string, params?: unknown): RpcRequest {
  return { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) };
}

class RetryFailureProvider implements ProviderAdapter {
  readonly id = "retry-control-provider";
  calls = 0;

  async *stream(_request: ProviderRequest, _signal: AbortSignal): AsyncIterable<AdapterEvent> {
    this.calls += 1;
    yield {
      type: "error",
      error: {
        category: "network",
        message: "temporary connection failure",
        retryable: true,
        partial: false,
        bodyStarted: false,
      },
    };
  }

  async listModels(_signal: AbortSignal): Promise<ModelInfo[]> {
    return [];
  }
}

test("RPC toggles automatic retry and cancels only an owned scheduled delay", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-rpc-retry-"));
  const provider = new RetryFailureProvider();
  const runtime = await createTestRuntime(root, join(root, "sessions.sqlite"), provider);
  const dispatcher = new RpcRuntimeDispatcher({ runtime });
  t.after(async () => {
    await dispatcher.close("test complete");
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const owner = new CapturePeer("retry-owner");
  const other = new CapturePeer("retry-other");

  assert.deepEqual(
    (await dispatcher.dispatch(owner, request("capabilities")) as { retryControl: unknown }).retryControl,
    { runtimeToggle: "retry.set", cancelScheduled: "run.retry.cancel" },
  );
  assert.deepEqual(await dispatcher.dispatch(owner, request("retry.get")), { enabled: true });
  assert.deepEqual(await dispatcher.dispatch(owner, request("retry.set", { enabled: false })), { enabled: false });
  await assert.rejects(
    dispatcher.dispatch(owner, request("retry.set", { enabled: "yes" })),
    /must be a boolean/u,
  );

  const disabled = await dispatcher.dispatch(owner, request("run.start", {
    prompt: "disabled",
    provider: provider.id,
    model: "retry-model",
  })) as { threadId: string };
  await assert.rejects(
    dispatcher.dispatch(owner, request("run.wait", { threadId: disabled.threadId })),
    /temporary connection failure/u,
  );
  assert.equal(provider.calls, 1);
  assert.equal(runtime.store.listEvents(disabled.threadId).some((entry) => entry.event.type === "retry_scheduled"), false);

  assert.deepEqual(await dispatcher.dispatch(owner, request("retry.set", { enabled: true })), { enabled: true });
  const scheduled = await dispatcher.dispatch(owner, request("run.start", {
    prompt: "cancel delay",
    provider: provider.id,
    model: "retry-model",
  })) as { threadId: string };
  const retryDeadline = Date.now() + 2_000;
  while (
    Date.now() < retryDeadline &&
    !runtime.store.listEvents(scheduled.threadId).some((entry) => entry.event.type === "retry_scheduled")
  ) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(runtime.store.listEvents(scheduled.threadId).some((entry) => entry.event.type === "retry_scheduled"), true);
  await assert.rejects(
    dispatcher.dispatch(other, request("run.retry.cancel", { threadId: scheduled.threadId })),
    /No RPC-owned run/u,
  );
  assert.deepEqual(
    await dispatcher.dispatch(owner, request("run.retry.cancel", { threadId: scheduled.threadId })),
    { accepted: true },
  );
  await assert.rejects(
    dispatcher.dispatch(owner, request("run.wait", { threadId: scheduled.threadId })),
    /Automatic retry cancelled: temporary connection failure/u,
  );
  assert.equal(runtime.store.listRuns(scheduled.threadId).at(-1)?.state, "failed");
  assert.equal(provider.calls, 2);
});
