import type { ModelInfo, ProviderRequest } from "../core/types.js";
import type { NetworkWebSocket, NetworkWebSocketFactory } from "../net/index.js";
import {
  buildResponsesBody,
  httpResponsesWireEvents,
  ResponsesAdapter,
  type ResponsesEventStreamInput,
  type ResponsesWireEvent,
} from "./openai-responses.js";
import { modelEvidence } from "./model-metadata.js";
import { stringifyProviderJson } from "./json.js";
import {
  asRecord,
  asString,
  assertSecureEndpoint,
  ProtocolError,
  type FetchLike,
} from "./transport.js";

export interface OpenAICodexTransportCredential {
  accessToken: string;
  accountId: string;
}

export interface OpenAICodexResponsesConfig {
  credential: (signal?: AbortSignal) => Promise<OpenAICodexTransportCredential>;
  baseUrl?: string;
  headers?: HeadersInit;
  fetch?: FetchLike;
  webSocket?: NetworkWebSocketFactory;
  transport?: OpenAICodexTransport;
  webSocketConnectTimeoutMs?: number;
  webSocketIdleTimeoutMs?: number;
}

export type OpenAICodexTransport = "sse" | "websocket" | "websocket-cached" | "auto";

const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_WEBSOCKET_IDLE_TIMEOUT_MS = 300_000;
const WEBSOCKET_SESSION_IDLE_MS = 5 * 60_000;
const WEBSOCKET_MAX_AGE_MS = 55 * 60_000;
const MAX_WEBSOCKET_MESSAGE_BYTES = 16 * 1_024 * 1_024;
const MAX_QUEUED_WEBSOCKET_MESSAGES = 1_024;
const MAX_QUEUED_WEBSOCKET_BYTES = 32 * 1_024 * 1_024;
const RESPONSE_NOT_FOUND = "previous_response_not_found";
const CONNECTION_LIMIT = "websocket_connection_limit_reached";

interface CodexModelDefinition {
  id: string;
  displayName: string;
  contextTokens: number;
  images: boolean;
  maxThinking?: boolean;
}

const CODEX_MODELS: readonly CodexModelDefinition[] = Object.freeze([
  { id: "gpt-5.3-codex-spark", displayName: "GPT-5.3 Codex Spark", contextTokens: 128_000, images: false },
  { id: "gpt-5.4", displayName: "GPT-5.4", contextTokens: 272_000, images: true },
  { id: "gpt-5.4-mini", displayName: "GPT-5.4 mini", contextTokens: 272_000, images: true },
  { id: "gpt-5.5", displayName: "GPT-5.5", contextTokens: 272_000, images: true },
  { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", contextTokens: 372_000, images: true, maxThinking: true },
  { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", contextTokens: 372_000, images: true, maxThinking: true },
  { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", contextTokens: 372_000, images: true, maxThinking: true },
]);

function codexBaseUrl(value: string): string {
  const normalized = value.replace(/\/+$/u, "");
  if (normalized.endsWith("/codex/responses")) return normalized.slice(0, -"/responses".length);
  if (normalized.endsWith("/codex")) return normalized;
  return `${normalized}/codex`;
}

function credentialValue(value: string, label: string): string {
  if (value === "" || Buffer.byteLength(value, "utf8") > 48 * 1024 || /[\x00-\x20\x7f]/u.test(value)) {
    throw new Error(`OpenAI Codex ${label} is invalid`);
  }
  return value;
}

function codexInstructions(request: ProviderRequest): string {
  const values = request.messages.flatMap((message) => message.role !== "system"
    ? []
    : message.content.flatMap((block) => block.type === "text" ? [block.text] : []));
  return values.join("\n\n") || "You are a helpful coding assistant.";
}

export function buildOpenAICodexResponsesBody(
  request: ProviderRequest,
  continuation = false,
): Record<string, unknown> {
  const state = request.providerState?.kind === "openai_responses" ? request.providerState : undefined;
  const stateWithoutPrevious = state === undefined
    ? undefined
    : (({ previousResponseId: _previousResponseId, ...remaining }) => remaining)(state);
  const sourceRequest: ProviderRequest = !continuation && state?.previousResponseId !== undefined
    ? { ...request, providerState: stateWithoutPrevious! }
    : request;
  const withoutSystem: ProviderRequest = {
    ...sourceRequest,
    messages: sourceRequest.messages.filter((message) => message.role !== "system"),
    ...(sourceRequest.reasoningEffort === "minimal" ? { reasoningEffort: "low" } : {}),
  };
  if (sourceRequest.reasoningEffort === "off") delete withoutSystem.reasoningEffort;
  const body = buildResponsesBody(withoutSystem, false, true);
  body.instructions = codexInstructions(sourceRequest);
  body.text = { verbosity: "low" };
  body.tool_choice = "auto";
  body.parallel_tool_calls = true;
  delete body.max_output_tokens;
  delete body.metadata;
  if (body.reasoning !== null && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)) {
    (body.reasoning as Record<string, unknown>).summary = "auto";
  }
  if (continuation && state?.previousResponseId !== undefined) body.previous_response_id = state.previousResponseId;
  return body;
}

export function openAICodexModels(observedAt = new Date().toISOString()): ModelInfo[] {
  return CODEX_MODELS.map((definition) => {
    const tools = { value: "supported" as const, source: "maintained" as const, observedAt };
    const reasoning = { value: "supported" as const, source: "maintained" as const, observedAt };
    const images = {
      value: definition.images ? "supported" as const : "unsupported" as const,
      source: "maintained" as const,
      observedAt,
    };
    return {
      id: definition.id,
      provider: "openai-codex",
      displayName: definition.displayName,
      contextTokens: definition.contextTokens,
      maxOutputTokens: 128_000,
      capabilities: { tools, reasoning, images },
      compatibility: {
        protocolFamily: modelEvidence("openai-responses", "maintained", observedAt),
        inputModalities: modelEvidence(definition.images ? ["text", "image"] : ["text"], "maintained", observedAt),
        outputModalities: modelEvidence(["text"], "maintained", observedAt),
        reasoningEfforts: modelEvidence(
          definition.maxThinking
            ? ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
            : ["off", "minimal", "low", "medium", "high", "xhigh"],
          "maintained",
          observedAt,
        ),
        strictTools: tools,
        toolStreaming: tools,
        cacheMode: modelEvidence("automatic", "maintained", observedAt),
        cacheAffinity: modelEvidence("prefix", "maintained", observedAt),
        sessionAffinity: modelEvidence("stateless", "maintained", observedAt),
      },
    };
  });
}

interface CachedCodexSocket {
  socket: NetworkWebSocket;
  busy: boolean;
  createdAt: number;
  lastResponseId?: string;
  idleTimer?: NodeJS.Timeout;
}

interface AcquiredCodexSocket {
  socket: NetworkWebSocket;
  entry?: CachedCodexSocket;
  reused: boolean;
  release(keep: boolean, responseId?: string): void;
}

class CodexWebSocketControlError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CodexWebSocketControlError";
    this.code = code;
  }
}

function transportTimeout(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 0 || selected > 10 * 60_000) {
    throw new RangeError(`${label} must be an integer from 0 through 600000`);
  }
  return selected;
}

function codexWebSocketUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function closeSocket(socket: NetworkWebSocket, reason = "complete"): void {
  if (socket.readyState === 2 || socket.readyState === 3) return;
  try {
    socket.close(1000, reason.slice(0, 123));
  } catch {
    // A transport that is already tearing down needs no further cleanup.
  }
}

function socketError(event: Event, fallback: string): TypeError {
  const value = event as Event & { message?: unknown; error?: unknown; code?: unknown; reason?: unknown };
  if (value.error instanceof Error && value.error.message !== "") return new TypeError(value.error.message);
  if (typeof value.message === "string" && value.message !== "") return new TypeError(value.message);
  const suffix = [value.code, value.reason].filter((item) => item !== undefined && item !== "").join(" ");
  return new TypeError(suffix === "" ? fallback : `${fallback}: ${suffix}`);
}

async function decodeWebSocketMessage(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  let bytes: Uint8Array;
  if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else if (data !== null && typeof data === "object" && "arrayBuffer" in data) {
    const buffer = await (data as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer();
    bytes = new Uint8Array(buffer);
  } else {
    throw new ProtocolError("OpenAI Codex WebSocket returned an unsupported message type");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProtocolError("OpenAI Codex WebSocket message contained invalid UTF-8");
  }
}

async function waitForWebSocketOpen(
  socket: NetworkWebSocket,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  if (socket.readyState === 1) return;
  if (socket.readyState !== 0) throw new TypeError("OpenAI Codex WebSocket closed before opening");
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
      if (timer !== undefined) clearTimeout(timer);
    };
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    const onOpen = (): void => settle();
    const onError = (event: Event): void => settle(socketError(event, "OpenAI Codex WebSocket connection failed"));
    const onClose = (event: Event): void => settle(socketError(event, "OpenAI Codex WebSocket closed before opening"));
    const onAbort = (): void => {
      closeSocket(socket, "aborted");
      settle(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        closeSocket(socket, "connect_timeout");
        settle(new TypeError(`OpenAI Codex WebSocket connect timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
    }
    if (signal.aborted) onAbort();
  });
}

async function* webSocketMessages(
  socket: NetworkWebSocket,
  signal: AbortSignal,
  idleTimeoutMs: number,
): AsyncGenerator<string> {
  const queue: Array<{ text: string; bytes: number }> = [];
  let queuedBytes = 0;
  let wake: (() => void) | undefined;
  let failure: Error | undefined;
  let closed = false;
  let decodeTail = Promise.resolve();
  const notify = (): void => {
    const pending = wake;
    wake = undefined;
    pending?.();
  };
  const fail = (error: Error): void => {
    failure ??= error;
    closed = true;
    notify();
  };
  const onMessage = (event: Event): void => {
    const data = (event as MessageEvent).data;
    decodeTail = decodeTail.then(async () => {
      const text = await decodeWebSocketMessage(data);
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > MAX_WEBSOCKET_MESSAGE_BYTES) {
        throw new ProtocolError(`OpenAI Codex WebSocket message exceeded ${MAX_WEBSOCKET_MESSAGE_BYTES} bytes`);
      }
      if (queue.length >= MAX_QUEUED_WEBSOCKET_MESSAGES || queuedBytes + bytes > MAX_QUEUED_WEBSOCKET_BYTES) {
        throw new ProtocolError("OpenAI Codex WebSocket receive queue exceeded its safety limit");
      }
      queue.push({ text, bytes });
      queuedBytes += bytes;
      notify();
    }).catch((error) => {
      closeSocket(socket, "protocol_error");
      fail(error instanceof Error ? error : new ProtocolError("OpenAI Codex WebSocket message decoding failed"));
    });
  };
  const onError = (event: Event): void => {
    decodeTail = decodeTail.then(() => fail(socketError(event, "OpenAI Codex WebSocket failed")));
  };
  const onClose = (event: Event): void => {
    decodeTail = decodeTail.then(() => fail(socketError(event, "OpenAI Codex WebSocket closed before a terminal event")));
  };
  const onAbort = (): void => {
    closeSocket(socket, "aborted");
    fail(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
  };
  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
  socket.addEventListener("close", onClose);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (queue.length > 0) {
        const next = queue.shift()!;
        queuedBytes -= next.bytes;
        yield next.text;
        continue;
      }
      if (failure !== undefined) throw failure;
      if (closed) return;
      await new Promise<void>((resolve, reject) => {
        wake = resolve;
        if (idleTimeoutMs <= 0) return;
        const timer = setTimeout(() => {
          if (wake !== resolve) return;
          wake = undefined;
          closeSocket(socket, "idle_timeout");
          reject(new TypeError(`OpenAI Codex WebSocket idle timeout after ${idleTimeoutMs}ms`));
        }, idleTimeoutMs);
        timer.unref();
        const original = wake;
        wake = () => {
          clearTimeout(timer);
          original?.();
        };
      });
    }
  } finally {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("close", onClose);
    signal.removeEventListener("abort", onAbort);
  }
}

function responseEventCode(value: Record<string, unknown>): string | undefined {
  const error = asRecord(value.error);
  return asString(error?.code) ?? asString(error?.type) ?? asString(value.code);
}

function responseEventId(value: Record<string, unknown>): string | undefined {
  return asString(asRecord(value.response)?.id);
}

class CodexWebSocketTransport {
  readonly #factory: NetworkWebSocketFactory;
  readonly #mode: Exclude<OpenAICodexTransport, "sse">;
  readonly #connectTimeoutMs: number;
  readonly #idleTimeoutMs: number;
  readonly #sessions = new Map<string, CachedCodexSocket>();
  readonly #fallbackUntil = new Map<string, number>();
  #closed = false;

  constructor(
    factory: NetworkWebSocketFactory,
    mode: Exclude<OpenAICodexTransport, "sse">,
    options: { connectTimeoutMs: number; idleTimeoutMs: number },
  ) {
    this.#factory = factory;
    this.#mode = mode;
    this.#connectTimeoutMs = options.connectTimeoutMs;
    this.#idleTimeoutMs = options.idleTimeoutMs;
  }

  async *stream(input: ResponsesEventStreamInput): AsyncGenerator<ResponsesWireEvent> {
    const sessionId = input.request.sessionId;
    const fullBody = buildOpenAICodexResponsesBody(input.request, false);
    if (this.#mode === "auto" && sessionId !== undefined && (this.#fallbackUntil.get(sessionId) ?? 0) > Date.now()) {
      yield* httpResponsesWireEvents({ ...input, body: fullBody });
      return;
    }

    let forceFull = false;
    let connectionLimitRetries = 0;
    let missingContextRetries = 0;
    while (true) {
      let emitted = false;
      try {
        for await (const event of this.#webSocketEvents(input, fullBody, forceFull)) {
          emitted = true;
          yield event;
        }
        if (sessionId !== undefined) this.#fallbackUntil.delete(sessionId);
        return;
      } catch (error) {
        const code = error instanceof CodexWebSocketControlError ? error.code : undefined;
        if (!emitted && code === CONNECTION_LIMIT && connectionLimitRetries < 1) {
          connectionLimitRetries += 1;
          forceFull = true;
          continue;
        }
        if (!emitted && code === RESPONSE_NOT_FOUND && missingContextRetries < 1) {
          missingContextRetries += 1;
          forceFull = true;
          continue;
        }
        if (!emitted && this.#mode === "auto" && !input.signal.aborted) {
          if (sessionId !== undefined) this.#fallbackUntil.set(sessionId, Date.now() + WEBSOCKET_SESSION_IDLE_MS);
          yield* httpResponsesWireEvents({ ...input, body: fullBody });
          return;
        }
        throw error;
      }
    }
  }

  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of this.#sessions.values()) {
      if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
      closeSocket(entry.socket, "runtime_disposed");
    }
    this.#sessions.clear();
    this.#fallbackUntil.clear();
  }

  async *#webSocketEvents(
    input: ResponsesEventStreamInput,
    fullBody: Record<string, unknown>,
    forceFull: boolean,
  ): AsyncGenerator<ResponsesWireEvent> {
    const cache = this.#mode === "auto" || this.#mode === "websocket-cached";
    const acquired = await this.#acquire(
      cache && !forceFull ? input.request.sessionId : undefined,
      input.url,
      input.headers,
      input.signal,
    );
    const previousId = input.request.providerState?.kind === "openai_responses"
      ? input.request.providerState.previousResponseId
      : undefined;
    const canContinue = !forceFull && acquired.reused && previousId !== undefined && acquired.entry?.lastResponseId === previousId;
    const requestBody = canContinue ? input.body : fullBody;
    const outgoing: Record<string, unknown> = { ...requestBody, type: "response.create" };
    delete outgoing.stream;
    delete outgoing.background;

    let terminal = false;
    let keep = false;
    let responseId: string | undefined;
    try {
      acquired.socket.send(stringifyProviderJson(outgoing));
      for await (const data of webSocketMessages(acquired.socket, input.signal, this.#idleTimeoutMs)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          throw new ProtocolError("Malformed OpenAI Codex WebSocket event", data.slice(0, 4096));
        }
        const event = asRecord(parsed);
        if (event === undefined) throw new ProtocolError("OpenAI Codex WebSocket event was not an object");
        const type = asString(event.type);
        if (type === undefined) throw new ProtocolError("OpenAI Codex WebSocket event did not contain a type");
        const code = responseEventCode(event);
        if (type === "error" && (code === RESPONSE_NOT_FOUND || code === CONNECTION_LIMIT)) {
          throw new CodexWebSocketControlError(code, asString(asRecord(event.error)?.message) ?? code);
        }
        responseId = responseEventId(event) ?? responseId;
        if (type === "response.completed" || type === "response.incomplete") {
          terminal = true;
          keep = true;
        } else if (type === "response.failed" || type === "error") {
          terminal = true;
        }
        yield { data };
        if (terminal) break;
      }
      if (!terminal) throw new TypeError("OpenAI Codex WebSocket ended before a terminal event");
    } finally {
      acquired.release(keep, responseId);
    }
  }

  async #acquire(
    sessionId: string | undefined,
    httpUrl: string,
    headers: Headers,
    signal: AbortSignal,
  ): Promise<AcquiredCodexSocket> {
    if (this.#closed) throw new Error("OpenAI Codex WebSocket transport is closed");
    if (sessionId !== undefined) {
      const cached = this.#sessions.get(sessionId);
      if (cached !== undefined) {
        if (cached.idleTimer !== undefined) clearTimeout(cached.idleTimer);
        delete cached.idleTimer;
        const expired = Date.now() - cached.createdAt >= WEBSOCKET_MAX_AGE_MS;
        if (!cached.busy && !expired && cached.socket.readyState === 1) {
          cached.busy = true;
          return this.#lease(sessionId, cached, true);
        }
        if (!cached.busy) {
          closeSocket(cached.socket, expired ? "connection_age_limit" : "connection_closed");
          this.#sessions.delete(sessionId);
        }
      }
    }

    const socketHeaders = new Headers(headers);
    socketHeaders.delete("accept");
    socketHeaders.delete("content-type");
    const socket = this.#factory(codexWebSocketUrl(httpUrl), socketHeaders);
    await waitForWebSocketOpen(socket, signal, this.#connectTimeoutMs);
    if (sessionId === undefined || this.#sessions.has(sessionId)) {
      return {
        socket,
        reused: false,
        release: () => closeSocket(socket),
      };
    }
    const entry: CachedCodexSocket = { socket, busy: true, createdAt: Date.now() };
    this.#sessions.set(sessionId, entry);
    return this.#lease(sessionId, entry, false);
  }

  #lease(sessionId: string, entry: CachedCodexSocket, reused: boolean): AcquiredCodexSocket {
    let released = false;
    return {
      socket: entry.socket,
      entry,
      reused,
      release: (keep, responseId) => {
        if (released) return;
        released = true;
        if (!keep || entry.socket.readyState !== 1 || this.#sessions.get(sessionId) !== entry) {
          closeSocket(entry.socket);
          if (this.#sessions.get(sessionId) === entry) this.#sessions.delete(sessionId);
          return;
        }
        entry.busy = false;
        if (responseId === undefined) delete entry.lastResponseId;
        else entry.lastResponseId = responseId;
        entry.idleTimer = setTimeout(() => {
          if (this.#sessions.get(sessionId) !== entry || entry.busy) return;
          closeSocket(entry.socket, "idle_expired");
          this.#sessions.delete(sessionId);
        }, WEBSOCKET_SESSION_IDLE_MS);
        entry.idleTimer.unref();
      },
    };
  }
}

export class OpenAICodexResponsesAdapter extends ResponsesAdapter {
  readonly #webSocketTransport: CodexWebSocketTransport | undefined;

  constructor(config: OpenAICodexResponsesConfig) {
    const baseUrl = codexBaseUrl(config.baseUrl ?? "https://chatgpt.com/backend-api");
    assertSecureEndpoint(baseUrl, "OpenAI Codex base URL");
    const mode = config.transport ?? (config.webSocket === undefined ? "sse" : "auto");
    if (!(["sse", "websocket", "websocket-cached", "auto"] as const).includes(mode)) {
      throw new TypeError("OpenAI Codex transport must be sse, websocket, websocket-cached, or auto");
    }
    if (mode !== "sse" && config.webSocket === undefined) {
      throw new TypeError(`OpenAI Codex ${mode} transport requires a WebSocket factory`);
    }
    const webSocketTransport = mode === "sse"
      ? undefined
      : new CodexWebSocketTransport(config.webSocket!, mode, {
          connectTimeoutMs: transportTimeout(config.webSocketConnectTimeoutMs, DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS, "webSocketConnectTimeoutMs"),
          idleTimeoutMs: transportTimeout(config.webSocketIdleTimeoutMs, DEFAULT_WEBSOCKET_IDLE_TIMEOUT_MS, "webSocketIdleTimeoutMs"),
        });
    super("openai-codex", {
      baseUrl,
      headers: config.headers,
      fetch: config.fetch ?? globalThis.fetch,
      authorize: async (headers, signal) => {
        const resolved = await config.credential(signal);
        headers.set("authorization", `Bearer ${credentialValue(resolved.accessToken, "access token")}`);
        headers.set("chatgpt-account-id", credentialValue(resolved.accountId, "account ID"));
        headers.set("originator", "rigyn");
        headers.set("openai-beta", "responses=experimental");
      },
      prepareHeaders: (headers, request) => {
        if (request.sessionId === undefined || request.sessionId === "") return;
        headers.set("session-id", request.sessionId);
        headers.set("x-client-request-id", request.sessionId);
      },
      buildBody: (request) => buildOpenAICodexResponsesBody(request, webSocketTransport !== undefined),
      ...(webSocketTransport === undefined ? {} : { streamEvents: (input: ResponsesEventStreamInput) => webSocketTransport.stream(input) }),
      listModels: async (signal) => {
        signal.throwIfAborted();
        return openAICodexModels();
      },
      stateful: false,
      retainResponseId: webSocketTransport !== undefined,
      promptCache: true,
      deferredToolLoading: false,
    });
    this.#webSocketTransport = webSocketTransport;
  }

  dispose(): void {
    this.#webSocketTransport?.dispose();
  }
}
