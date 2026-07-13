import type { AdapterEvent, ModelInfo, ProviderAdapter, ProviderRequest } from "../../src/core/types.js";
import type { RpcRuntimePeer } from "../../src/interfaces/rpc-runtime.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { HarnessService } from "../../src/service/harness.js";
import { SessionStore } from "../../src/storage/store.js";

export class CapturePeer implements RpcRuntimePeer {
  readonly id: string;
  readonly notifications: Array<{ method: string; params?: unknown }> = [];
  readonly #waiters = new Set<{
    method: string;
    resolve(value: { method: string; params?: unknown }): void;
  }>();

  constructor(id: string) {
    this.id = id;
  }

  async notification(method: string, params?: unknown): Promise<void> {
    const value = { method, ...(params === undefined ? {} : { params }) };
    this.notifications.push(value);
    for (const waiter of this.#waiters) {
      if (waiter.method !== method) continue;
      this.#waiters.delete(waiter);
      waiter.resolve(value);
      break;
    }
  }

  async waitFor(method: string, timeoutMs = 2_000): Promise<{ method: string; params?: unknown }> {
    const existing = this.notifications.find((entry) => entry.method === method);
    if (existing !== undefined) return existing;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        new Promise<{ method: string; params?: unknown }>((resolve) => this.#waiters.add({ method, resolve })),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export class QueueProvider implements ProviderAdapter {
  readonly id = "test-provider";
  readonly requests: ProviderRequest[] = [];
  readonly #outputs: string[];

  constructor(outputs: string[]) {
    this.#outputs = outputs;
  }

  async *stream(request: ProviderRequest, _signal: AbortSignal): AsyncIterable<AdapterEvent> {
    this.requests.push(request);
    const output = this.#outputs.shift() ?? "done";
    yield { type: "response_start", model: request.model };
    yield { type: "text_delta", part: 0, text: output };
    yield {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: output } },
    };
  }

  async listModels(_signal: AbortSignal): Promise<ModelInfo[]> {
    return [];
  }
}

export class GatedProvider implements ProviderAdapter {
  readonly id = "test-provider";
  readonly requests: ProviderRequest[] = [];
  readonly ready: Promise<void>;
  readonly #readyResolve: () => void;
  readonly #release: Promise<void>;
  readonly #releaseResolve: () => void;

  constructor() {
    let readyResolve: () => void = () => {};
    let releaseResolve: () => void = () => {};
    this.ready = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });
    this.#release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    this.#readyResolve = readyResolve;
    this.#releaseResolve = releaseResolve;
  }

  release(): void {
    this.#releaseResolve();
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    this.requests.push(request);
    yield { type: "response_start", model: request.model };
    yield { type: "text_delta", part: 0, text: "before" };
    this.#readyResolve();
    await Promise.race([
      this.#release,
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    ]);
    yield { type: "text_delta", part: 0, text: " after" };
    yield {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "before after" } },
    };
  }

  async listModels(_signal: AbortSignal): Promise<ModelInfo[]> {
    return [];
  }
}

export async function createTestRuntime(
  workspace: string,
  database: string,
  provider: ProviderAdapter,
) {
  const store = new SessionStore(database);
  const providers = new ProviderRegistry([provider]);
  const service = new HarnessService({ store, workspace, providers, projectTrusted: false });
  await service.initialize();
  return {
    workspace,
    store,
    providers,
    service,
    async close(): Promise<void> {
      await service.close();
      store.close();
    },
  };
}
