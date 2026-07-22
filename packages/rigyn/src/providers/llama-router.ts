import type {
  AdapterEvent,
  ModelInfo,
  ModelModality,
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
} from "../core/types.js";
import { setTimeout as delay } from "node:timers/promises";
import { OpenAICompatibleAdapter } from "./openai-compatible.js";
import type { FetchLike, TokenSource } from "./transport.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_CATALOG_BYTES = 4 * 1_024 * 1_024;
const MAX_MODELS = 10_000;
const OPERATION_TIMEOUT_MS = 60 * 60 * 1_000;

export type LlamaRouterModelStatus = "unloaded" | "loading" | "loaded" | "downloading" | "sleeping";

export interface LlamaRouterModel {
  id: string;
  aliases?: readonly string[];
  status: {
    value: LlamaRouterModelStatus;
    failed?: boolean;
    exitCode?: number;
    progress?: Readonly<Record<string, { done: number; total: number }>>;
  };
  inputModalities?: readonly string[];
  contextTokens?: number;
  trainingContextTokens?: number;
  sizeBytes?: number;
  fileType?: string;
}

export interface LlamaRouterEvent {
  model: string;
  event: string;
  data?: unknown;
}

export interface LlamaRouterProgress {
  message: string;
  ratio?: number;
  detail?: string;
}

export interface LlamaRouterClientOptions {
  baseUrl?: string;
  apiKey?: TokenSource;
  fetch?: FetchLike;
  timeoutMs?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined;
}

function normalizedStatus(value: unknown): LlamaRouterModelStatus | undefined {
  return value === "unloaded" || value === "loading" || value === "loaded"
    || value === "downloading" || value === "sleeping" ? value : undefined;
}

function modelEntry(value: unknown): LlamaRouterModel | undefined {
  const source = record(value);
  const statusSource = record(source?.status);
  const status = normalizedStatus(statusSource?.value);
  if (typeof source?.id !== "string" || source.id === "" || Buffer.byteLength(source.id) > 4_096 || status === undefined) {
    return undefined;
  }
  const architecture = record(source.architecture);
  const metadata = record(source.meta);
  const progressSource = record(statusSource?.progress);
  const progress = progressSource === undefined ? undefined : Object.fromEntries(
    Object.entries(progressSource).flatMap(([name, entry]) => {
      const item = record(entry);
      const done = typeof item?.done === "number" && Number.isFinite(item.done) && item.done >= 0 ? item.done : undefined;
      const total = typeof item?.total === "number" && Number.isFinite(item.total) && item.total >= 0 ? item.total : undefined;
      return done === undefined || total === undefined ? [] : [[name, { done, total }]];
    }),
  );
  const inputModalities = Array.isArray(architecture?.input_modalities)
    ? architecture.input_modalities.filter((item): item is string => typeof item === "string").slice(0, 16)
    : undefined;
  const aliases = Array.isArray(source.aliases)
    ? source.aliases.filter((item): item is string => typeof item === "string" && item !== "").slice(0, 128)
    : undefined;
  return {
    id: source.id,
    ...(aliases === undefined || aliases.length === 0 ? {} : { aliases }),
    status: {
      value: status,
      ...(statusSource?.failed === true ? { failed: true } : {}),
      ...(Number.isSafeInteger(statusSource?.exit_code) ? { exitCode: statusSource!.exit_code as number } : {}),
      ...(progress === undefined || Object.keys(progress).length === 0 ? {} : { progress }),
    },
    ...(inputModalities === undefined || inputModalities.length === 0 ? {} : { inputModalities }),
    ...(positiveInteger(metadata?.n_ctx) === undefined ? {} : { contextTokens: positiveInteger(metadata?.n_ctx)! }),
    ...(positiveInteger(metadata?.n_ctx_train) === undefined
      ? {}
      : { trainingContextTokens: positiveInteger(metadata?.n_ctx_train)! }),
    ...(positiveInteger(metadata?.size) === undefined ? {} : { sizeBytes: positiveInteger(metadata?.size)! }),
    ...(typeof metadata?.ftype !== "string" ? {} : { fileType: metadata.ftype }),
  };
}

function routerError(value: unknown, fallback: string): Error {
  const message = record(record(value)?.error)?.message;
  return new Error(typeof message === "string" && message !== "" ? message : fallback);
}

function progressTotals(value: unknown): { done: number; total: number } | undefined {
  const source = record(value);
  if (source === undefined) return undefined;
  let done = 0;
  let total = 0;
  for (const candidate of Object.values(source)) {
    const entry = record(candidate);
    if (typeof entry?.done !== "number" || typeof entry.total !== "number") continue;
    if (!Number.isFinite(entry.done) || !Number.isFinite(entry.total) || entry.done < 0 || entry.total < 0) continue;
    done += entry.done;
    total += entry.total;
  }
  return total > 0 ? { done, total } : undefined;
}

function downloadProgress(value: unknown): LlamaRouterProgress | undefined {
  const source = record(value);
  const totals = progressTotals(source?.progress ?? value);
  if (totals === undefined) return undefined;
  return {
    message: "Downloading model",
    ratio: Math.max(0, Math.min(1, totals.done / totals.total)),
    detail: `${totals.done} / ${totals.total} bytes`,
  };
}

function loadProgress(value: unknown): LlamaRouterProgress | undefined {
  const progress = record(record(value)?.progress);
  if (progress === undefined) return undefined;
  const stage = typeof progress.current === "string"
    ? progress.current
    : typeof progress.stage === "string" ? progress.stage : undefined;
  const stages = Array.isArray(progress.stages)
    ? progress.stages.filter((entry): entry is string => typeof entry === "string")
    : [];
  const partial = typeof progress.value === "number" && Number.isFinite(progress.value)
    ? Math.max(0, Math.min(1, progress.value))
    : undefined;
  const index = stage === undefined ? -1 : stages.indexOf(stage);
  const ratio = index < 0 || stages.length === 0 ? partial : (index + (partial ?? 0)) / stages.length;
  return {
    message: stage === undefined ? "Loading model" : `Loading ${stage.replaceAll("_", " ")}`,
    ...(ratio === undefined ? {} : { ratio }),
  };
}

async function readTextBounded(response: Response, maximumBytes: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("llama.cpp router response exceeded 4 MiB");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export function normalizeLlamaRouterUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("llama.cpp router URL must be absolute");
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("llama.cpp router URL must use HTTPS or loopback HTTP");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("llama.cpp router URL must not contain credentials, a query, or a fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "") || "/";
  return url.toString().replace(/\/$/u, "");
}

async function tokenValue(source: TokenSource | undefined, signal?: AbortSignal): Promise<string | undefined> {
  if (source === undefined) return undefined;
  return typeof source === "function" ? source(signal) : source;
}

export class LlamaRouterClient {
  readonly baseUrl: string;
  readonly #apiKey: TokenSource | undefined;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: LlamaRouterClientOptions = {}) {
    this.baseUrl = normalizeLlamaRouterUrl(options.baseUrl ?? "http://127.0.0.1:8080");
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 120_000) {
      throw new RangeError("llama.cpp router timeout must be 250-120000ms");
    }
    this.#timeoutMs = timeoutMs;
  }

  async #request(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const selectedSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const headers = new Headers(init.headers);
    const apiKey = await tokenValue(this.#apiKey, selectedSignal);
    if (apiKey !== undefined && apiKey !== "") headers.set("authorization", `Bearer ${apiKey}`);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    headers.set("accept", "application/json");
    const response = await this.#fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      signal: selectedSignal,
      redirect: "error",
    });
    const text = await readTextBounded(response, MAX_CATALOG_BYTES);
    let payload: unknown;
    try {
      payload = text === "" ? undefined : JSON.parse(text);
    } catch {
      throw new Error(`llama.cpp router returned invalid JSON (${response.status})`);
    }
    if (!response.ok) throw routerError(payload, `llama.cpp router returned HTTP ${response.status}`);
    return payload;
  }

  async list(options: { reload?: boolean; signal?: AbortSignal } = {}): Promise<LlamaRouterModel[]> {
    const payload = await this.#request(`/models${options.reload === true ? "?reload=1" : ""}`, {}, options.signal);
    const data = record(payload)?.data;
    if (!Array.isArray(data) || data.length > MAX_MODELS) throw new Error("llama.cpp router returned an invalid model catalog");
    const models = data.map(modelEntry);
    if (models.some((model) => model === undefined)) throw new Error("llama.cpp server is not in router mode");
    return models as LlamaRouterModel[];
  }

  async load(model: string, signal?: AbortSignal): Promise<void> {
    await this.#mutate("/models/load", model, signal);
  }

  async loadAndWait(
    model: string,
    onProgress?: (progress: LlamaRouterProgress) => void,
    signal?: AbortSignal,
  ): Promise<LlamaRouterModel> {
    const operationSignal = signal === undefined
      ? AbortSignal.timeout(OPERATION_TIMEOUT_MS)
      : AbortSignal.any([signal, AbortSignal.timeout(OPERATION_TIMEOUT_MS)]);
    const watcher = new AbortController();
    let eventLoaded = false;
    let eventFailure: string | undefined;
    void this.watch((event) => {
      if (event.model !== model || (event.event !== "model_status" && event.event !== "status_change")) return;
      const data = record(event.data);
      if (data?.status === "loaded" || data?.status === "sleeping") eventLoaded = true;
      if (data?.status === "unloaded") eventFailure = `llama.cpp router failed to load ${model}`;
      const progress = loadProgress(event.data);
      if (progress !== undefined) onProgress?.(progress);
    }, AbortSignal.any([operationSignal, watcher.signal])).catch(() => undefined);
    try {
      await this.load(model, operationSignal);
      onProgress?.({ message: "Loading model" });
      while (true) {
        operationSignal.throwIfAborted();
        const entry = (await this.list({ signal: operationSignal })).find((candidate) => candidate.id === model);
        if (entry?.status.failed === true || eventFailure !== undefined) {
          const exit = entry?.status.exitCode === undefined ? "" : ` (exit ${entry.status.exitCode})`;
          throw new Error(`${eventFailure ?? `llama.cpp router failed to load ${model}`}${exit}`);
        }
        if (entry?.status.value === "loaded" || entry?.status.value === "sleeping") return entry;
        if (eventLoaded && entry === undefined) return { id: model, status: { value: "loaded" } };
        await delay(250, undefined, { signal: operationSignal });
      }
    } finally {
      watcher.abort();
    }
  }

  async unload(model: string, signal?: AbortSignal): Promise<void> {
    await this.#mutate("/models/unload", model, signal);
  }

  async unloadAndWait(model: string, signal?: AbortSignal): Promise<void> {
    const operationSignal = signal === undefined
      ? AbortSignal.timeout(OPERATION_TIMEOUT_MS)
      : AbortSignal.any([signal, AbortSignal.timeout(OPERATION_TIMEOUT_MS)]);
    await this.unload(model, operationSignal);
    while (true) {
      const entry = (await this.list({ signal: operationSignal })).find((candidate) => candidate.id === model);
      if (entry === undefined || entry.status.value === "unloaded") return;
      if (entry.status.failed === true) throw new Error(`llama.cpp router failed to unload ${model}`);
      await delay(100, undefined, { signal: operationSignal });
    }
  }

  async download(model: string, signal?: AbortSignal): Promise<void> {
    await this.#mutate("/models", model, signal);
  }

  async downloadAndWait(
    model: string,
    onProgress?: (progress: LlamaRouterProgress) => void,
    signal?: AbortSignal,
  ): Promise<LlamaRouterModel> {
    const operationSignal = signal === undefined
      ? AbortSignal.timeout(OPERATION_TIMEOUT_MS)
      : AbortSignal.any([signal, AbortSignal.timeout(OPERATION_TIMEOUT_MS)]);
    const watcher = new AbortController();
    let eventFinished = false;
    let eventFailure: string | undefined;
    let sawDownloading = false;
    let polls = 0;
    void this.watch((event) => {
      if (event.model !== model) return;
      if (event.event === "download_finished") eventFinished = true;
      if (event.event === "download_failed") eventFailure = routerError(event.data, `llama.cpp router failed to download ${model}`).message;
      if (event.event === "download_progress") {
        sawDownloading = true;
        const progress = downloadProgress(event.data);
        if (progress !== undefined) onProgress?.(progress);
      }
    }, AbortSignal.any([operationSignal, watcher.signal])).catch(() => undefined);
    try {
      await this.download(model, operationSignal);
      onProgress?.({ message: "Downloading model" });
      while (true) {
        operationSignal.throwIfAborted();
        if (eventFailure !== undefined) throw new Error(eventFailure);
        const entry = (await this.list({ signal: operationSignal })).find((candidate) => candidate.id === model);
        polls += 1;
        if (entry?.status.failed === true) throw new Error(`llama.cpp router failed to download ${model}`);
        if (entry?.status.value === "downloading") {
          sawDownloading = true;
          const progress = downloadProgress(entry.status.progress);
          if (progress !== undefined) onProgress?.(progress);
        } else if (entry !== undefined && (eventFinished || sawDownloading || polls >= 2)) {
          return entry;
        }
        await delay(500, undefined, { signal: operationSignal });
      }
    } finally {
      watcher.abort();
    }
  }

  async #mutate(path: string, model: string, signal?: AbortSignal): Promise<void> {
    if (model === "" || model.includes("\0") || Buffer.byteLength(model) > 4_096) {
      throw new Error("llama.cpp router model ID was invalid");
    }
    await this.#request(path, { method: "POST", body: JSON.stringify({ model }) }, signal);
  }

  async watch(onEvent: (event: LlamaRouterEvent) => void, signal?: AbortSignal): Promise<void> {
    const timeout = AbortSignal.timeout(24 * 60 * 60 * 1_000);
    const selectedSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const headers = new Headers({ accept: "text/event-stream" });
    const apiKey = await tokenValue(this.#apiKey, selectedSignal);
    if (apiKey !== undefined && apiKey !== "") headers.set("authorization", `Bearer ${apiKey}`);
    const response = await this.#fetch(`${this.baseUrl}/models/sse`, { headers, signal: selectedSignal, redirect: "error" });
    if (!response.ok || response.body === null) throw new Error(`llama.cpp router event stream returned HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
      if (Buffer.byteLength(buffer) > 1024 * 1024) throw new Error("llama.cpp router event frame exceeded 1 MiB");
      for (let boundary = buffer.indexOf("\n\n"); boundary >= 0; boundary = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart()).join("\n");
        if (data === "") continue;
        try {
          const parsed = record(JSON.parse(data));
          if (typeof parsed?.model === "string" && typeof parsed.event === "string") {
            onEvent({ model: parsed.model, event: parsed.event, ...(parsed.data === undefined ? {} : { data: parsed.data }) });
          }
        } catch {
          // Catalog polling remains authoritative when one event is malformed.
        }
      }
    }
  }
}

export interface LlamaRouterAdapterConfig extends LlamaRouterClientOptions {
  id?: ProviderId;
}

export class LlamaRouterAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  readonly client: LlamaRouterClient;
  readonly #delegate: OpenAICompatibleAdapter;

  constructor(config: LlamaRouterAdapterConfig = {}) {
    this.id = config.id ?? "llama.cpp";
    this.client = new LlamaRouterClient(config);
    this.#delegate = new OpenAICompatibleAdapter({
      id: this.id,
      baseUrl: `${this.client.baseUrl}/v1`,
      ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    });
  }

  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    return this.#delegate.stream({
      ...request,
      modelSettings: {
        ...(request.modelSettings ?? {}),
        compatibility: {
          supportsUsageInStreaming: false,
          maxTokensField: "max_tokens",
          supportsReasoningEffort: false,
          ...(request.modelSettings?.compatibility ?? {}),
        },
      },
    }, signal);
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    const observedAt = new Date().toISOString();
    const models = await this.client.list({ signal });
    return models.filter((model) => model.status.value === "loaded" || model.status.value === "sleeping").map((model) => {
      const contextTokens = model.contextTokens ?? model.trainingContextTokens ?? 128_000;
      const supportsImages = model.inputModalities?.includes("image") === true;
      const inputModalities: ModelModality[] = supportsImages ? ["text", "image"] : ["text"];
      return {
        id: model.id,
        provider: this.id,
        displayName: model.id,
        contextTokens,
        maxOutputTokens: Math.min(16_384, contextTokens),
        capabilities: {
          tools: { value: "unknown", source: "provider", observedAt },
          reasoning: { value: "unknown", source: "provider", observedAt },
          images: { value: supportsImages ? "supported" : "unknown", source: "provider", observedAt },
        },
        compatibility: {
          protocolFamily: { value: "openai-chat-completions", source: "provider", observedAt },
          inputModalities: { value: inputModalities, source: "provider", observedAt },
        },
        metadata: {
          status: model.status.value,
          ...(model.aliases === undefined ? {} : { aliases: [...model.aliases] }),
          ...(model.sizeBytes === undefined ? {} : { sizeBytes: model.sizeBytes }),
          ...(model.fileType === undefined ? {} : { fileType: model.fileType }),
        },
      } satisfies ModelInfo;
    });
  }
}
