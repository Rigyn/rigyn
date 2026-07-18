import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AdapterEvent, ModelInfo, ProviderAdapter, ProviderRequest } from "../../src/core/types.js";
import { RuntimeExtensionHost } from "../../src/extensions/runtime.js";
import { RpcRuntimeDispatcher } from "../../src/interfaces/rpc-runtime.js";
import type { RpcRequest } from "../../src/interfaces/rpc.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { CapturePeer, createTestRuntime } from "./rpc-helpers.js";

const observedAt = "2026-01-01T00:00:00.000Z";
const unknown = { value: "unknown" as const, source: "provider" as const, observedAt };

function request(method: string, params?: unknown): RpcRequest {
  return { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) };
}

async function within<T>(operation: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class RpcSelectionProvider implements ProviderAdapter {
  readonly id = "rpc-selection-provider";
  readonly requests: ProviderRequest[] = [];
  closed = false;

  close(): void {
    this.closed = true;
  }

  async *stream(input: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    signal.throwIfAborted();
    if (this.closed) throw new Error("Selected provider was closed before the run started");
    this.requests.push(structuredClone(input));
    yield { type: "response_start", model: input.model };
    yield { type: "text_delta", part: 0, text: "rpc selected" };
    yield {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "rpc selected" } },
    };
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    signal.throwIfAborted();
    if (this.closed) throw new Error("Selected provider was closed during model resolution");
    return ["coder-v1", "coder-v2"].map((id) => ({
      provider: this.id,
      id,
      capabilities: { tools: unknown, reasoning: unknown, images: unknown },
      compatibility: {
        reasoningEfforts: { value: ["low", "high"], source: "provider", observedAt },
      },
    }));
  }
}

class GatedInputHost extends RuntimeExtensionHost {
  readonly inputReached: Promise<void>;
  readonly #announceInput: () => void;
  readonly #inputGate: Promise<void>;
  readonly #releaseInput: () => void;

  constructor(root: string) {
    super(root);
    let announceInput!: () => void;
    this.inputReached = new Promise<void>((resolve) => { announceInput = resolve; });
    this.#announceInput = announceInput;
    let releaseInput!: () => void;
    this.#inputGate = new Promise<void>((resolve) => { releaseInput = resolve; });
    this.#releaseInput = releaseInput;
  }

  releaseInput(): void {
    this.#releaseInput();
  }

  override async reduceInput() {
    this.#announceInput();
    await this.#inputGate;
    return { action: "continue" as const };
  }
}

class GatedSelectionProvider extends RpcSelectionProvider {
  readonly resolutionReached: Promise<void>;
  readonly #announceResolution: () => void;
  readonly #resolutionGate: Promise<void>;
  readonly #releaseResolution: () => void;

  constructor() {
    super();
    let announceResolution!: () => void;
    this.resolutionReached = new Promise<void>((resolve) => { announceResolution = resolve; });
    this.#announceResolution = announceResolution;
    let releaseResolution!: () => void;
    this.#resolutionGate = new Promise<void>((resolve) => { releaseResolution = resolve; });
    this.#releaseResolution = releaseResolution;
  }

  releaseResolution(): void {
    this.#releaseResolution();
  }

  override async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    this.#announceResolution();
    await this.#resolutionGate;
    return await super.listModels(signal);
  }
}

test("RPC run selection accepts canonical shorthand without a separate provider and persists canonical state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-rpc-model-selection-"));
  const provider = new RpcSelectionProvider();
  const runtime = await createTestRuntime(root, join(root, "sessions.sqlite"), provider);
  const dispatcher = new RpcRuntimeDispatcher({ runtime });
  const peer = new CapturePeer("rpc-model-selection");
  t.after(async () => {
    await dispatcher.close("test complete");
    await runtime.close();
  });
  t.after(async () => await rm(root, { recursive: true, force: true }));

  const started = await dispatcher.dispatch(peer, request("run.start", {
    prompt: "select",
    model: "rpc-selection/coder-v1:HIGH",
  })) as { threadId: string };
  await dispatcher.dispatch(peer, request("run.wait", { threadId: started.threadId }));
  assert.deepEqual(
    provider.requests.map(({ provider: selectedProvider, model, reasoningEffort }) => ({
      provider: selectedProvider,
      model,
      reasoningEffort,
    })),
    [{ provider: "rpc-selection-provider", model: "coder-v1", reasoningEffort: "high" }],
  );
  const state = await dispatcher.dispatch(peer, request("thread.state", { threadId: started.threadId })) as {
    provider?: string;
    model?: string;
    reasoningEffort?: string;
  };
  assert.deepEqual(
    { provider: state.provider, model: state.model, reasoningEffort: state.reasoningEffort },
    { provider: "rpc-selection-provider", model: "coder-v1", reasoningEffort: "high" },
  );

  const threadCount = runtime.store.listThreads({ workspaceRoot: root }).length;
  await assert.rejects(
    dispatcher.dispatch(peer, request("run.start", { prompt: "ambiguous", model: "coder" })),
    /ambiguous; choose one of/u,
  );
  assert.equal(runtime.store.listThreads({ workspaceRoot: root }).length, threadCount);

  const resolved = await dispatcher.dispatch(peer, request("models.resolve", {
    reference: "rpc-selection/coder-v1",
    reasoningEffort: "off",
    refresh: false,
  })) as {
    match: string;
    candidates: ModelInfo[];
    reasoningEffort?: string;
    supportedReasoningEfforts?: string[];
  };
  assert.deepEqual({
    match: resolved.match,
    candidates: resolved.candidates.map((model) => `${model.provider}/${model.id}`),
    reasoningEffort: resolved.reasoningEffort,
    supportedReasoningEfforts: resolved.supportedReasoningEfforts,
  }, {
    match: "unsupported-thinking",
    candidates: ["rpc-selection-provider/coder-v1"],
    reasoningEffort: "off",
    supportedReasoningEfforts: ["low", "high"],
  });
});

test("RPC run start retains its selected resource generation until the run owns it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-rpc-model-handoff-"));
  const provider = new GatedSelectionProvider();
  const runtime = await createTestRuntime(root, join(root, "sessions.sqlite"), provider);
  const inputHost = new GatedInputHost(root);
  const dispatcher = new RpcRuntimeDispatcher({ runtime: { ...runtime, runtimeExtensions: inputHost } });
  const peer = new CapturePeer("rpc-model-handoff");
  t.after(async () => {
    await dispatcher.close("test complete");
    await runtime.close();
    await inputHost.close();
  });
  t.after(async () => await rm(root, { recursive: true, force: true }));

  const starting = dispatcher.dispatch(peer, request("run.start", {
    prompt: "hold the resolved generation",
    model: "rpc-selection/coder-v1",
  })) as Promise<{ threadId: string }>;
  const replacementResources = {
    providers: new ProviderRegistry([]),
    projectTrusted: false,
    skills: [],
    extraTools: [],
  };
  const replacementOptions = { commit: () => provider.close() };

  await provider.resolutionReached;
  try {
    await assert.rejects(
      runtime.service.replaceRuntimeResources(replacementResources, replacementOptions),
      /run is starting/u,
    );
    assert.equal(provider.closed, false);
  } finally {
    provider.releaseResolution();
  }

  await inputHost.inputReached;
  try {
    await assert.rejects(
      runtime.service.replaceRuntimeResources(replacementResources, replacementOptions),
      /run is starting/u,
    );
    assert.equal(provider.closed, false);
  } finally {
    inputHost.releaseInput();
  }

  const started = await starting;
  await dispatcher.dispatch(peer, request("run.wait", { threadId: started.threadId }));
  assert.equal(provider.requests.length, 1);
  assert.equal(provider.closed, false);
});

test("RPC model lookup deadline does not cancel later input handoff work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-rpc-model-deadline-"));
  const provider = new RpcSelectionProvider();
  const runtime = await createTestRuntime(root, join(root, "sessions.sqlite"), provider);
  const inputHost = new GatedInputHost(root);
  const dispatcher = new RpcRuntimeDispatcher({ runtime: { ...runtime, runtimeExtensions: inputHost } });
  const peer = new CapturePeer("rpc-model-deadline");
  t.after(async () => {
    inputHost.releaseInput();
    await dispatcher.close("test complete");
    await runtime.close();
    await inputHost.close();
  });
  t.after(async () => await rm(root, { recursive: true, force: true }));

  const lookupDeadline = new AbortController();
  const timeout = AbortSignal.timeout;
  let substituted = false;
  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true,
    writable: true,
    value: (delay: number) => {
      if (!substituted && delay === 30_000) {
        substituted = true;
        return lookupDeadline.signal;
      }
      return timeout(delay);
    },
  });
  let starting: Promise<unknown>;
  try {
    starting = dispatcher.dispatch(peer, request("run.start", {
      prompt: "finish after lookup deadline",
      model: "rpc-selection/coder-v1",
    }));
  } finally {
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      writable: true,
      value: timeout,
    });
  }
  assert.equal(substituted, true);
  await inputHost.inputReached;
  lookupDeadline.abort(new Error("model lookup deadline elapsed"));
  inputHost.releaseInput();

  const started = await within(starting!, "post-lookup input handoff") as { threadId: string };
  await dispatcher.dispatch(peer, request("run.wait", { threadId: started.threadId }));
  assert.equal(provider.requests.length, 1);
});

test("RPC peer disconnect aborts model resolution before a run can be orphaned", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-rpc-model-disconnect-"));
  const provider = new GatedSelectionProvider();
  const runtime = await createTestRuntime(root, join(root, "sessions.sqlite"), provider);
  const dispatcher = new RpcRuntimeDispatcher({ runtime });
  const peer = new CapturePeer("rpc-model-disconnect");
  t.after(async () => {
    provider.releaseResolution();
    await dispatcher.close("test complete");
    await runtime.close();
  });
  t.after(async () => await rm(root, { recursive: true, force: true }));

  const starting = dispatcher.dispatch(peer, request("run.start", {
    prompt: "must not outlive the peer",
    model: "rpc-selection/coder-v1",
  }));
  await provider.resolutionReached;
  dispatcher.disconnect(peer.id);
  try {
    await assert.rejects(within(starting, "peer-owned model lookup"), /RPC client disconnected/u);
    assert.equal(runtime.store.listThreads({ workspaceRoot: root }).length, 0);
    assert.equal(provider.requests.length, 0);
  } finally {
    provider.releaseResolution();
  }
});
