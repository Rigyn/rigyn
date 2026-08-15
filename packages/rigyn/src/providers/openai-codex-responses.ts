import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

import { uuidv7 } from "@rigyn/models";
import {
  CloseEvent as NetworkCloseEvent,
  ErrorEvent as NetworkErrorEvent,
  MessageEvent as NetworkMessageEvent,
} from "undici";

import type { ModelInfo, ProviderRequest } from "../core/types.js";
import { isJsonValue } from "../core/json.js";
import { INTERNAL_WEBSOCKET_MAX_PAYLOAD_BYTES } from "../net/fetch.js";
import type { NetworkWebSocket, NetworkWebSocketFactory } from "../net/index.js";
import {
  consumeWebSocketNativeErrorCode,
  safeWebSocketNativeErrorCode,
} from "../net/websocket-native-error.js";
import {
  buildResponsesBody,
  httpResponsesWireEvents,
  ResponsesAdapter,
  responsesTerminalOutcome,
  type ResponsesEventStreamInput,
  type ResponsesWireEvent,
} from "./openai-responses.js";
import { markResponsesAttemptReset } from "./openai-responses-wire-internal.js";
import { openAIPromptCacheKey } from "./openai-affinity.js";
import {
  OPENAI_CODEX_TRANSPORT_OBSERVER,
  type OpenAICodexObservabilityOptions,
  type OpenAICodexOutputBoundary,
  type OpenAICodexTransportFailureClass,
  type OpenAICodexTransportObservation,
  type OpenAICodexTransportObserver,
} from "./openai-codex-observability.js";
import { modelEvidence } from "./model-metadata.js";
import { stringifyProviderJson } from "./json.js";
import type { ProviderWireOperation, ProviderWireTransportHost } from "./wire.js";
import {
  asNumber,
  asRecord,
  asString,
  assertSecureEndpoint,
  HttpResponseError,
  PrematureStreamEndError,
  ProtocolError,
  ProviderStreamError,
  type FetchLike,
} from "./transport.js";
import { transportErrorCode } from "./transport-error.js";

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
  wire?: ProviderWireTransportHost;
  /**
   * Defaults to automatic cached WebSocket with pre-output SSE fallback;
   * without a WebSocket factory, auto uses SSE.
   */
  transport?: OpenAICodexTransport;
  webSocketConnectTimeoutMs?: number;
  webSocketIdleTimeoutMs?: number;
}

export type OpenAICodexTransport = "sse" | "websocket" | "websocket-cached" | "auto";

const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_WEBSOCKET_IDLE_TIMEOUT_MS = 300_000;
const WEBSOCKET_SESSION_IDLE_MS = 5 * 60_000;
const WEBSOCKET_MAX_AGE_MS = 55 * 60_000;
const MAX_QUEUED_WEBSOCKET_MESSAGES = 1_024;
const MAX_QUEUED_WEBSOCKET_BYTES = 32 * 1_024 * 1_024;
const MAX_SSE_FALLBACK_IDENTITIES = 1_024;
const RESPONSE_NOT_FOUND = "previous_response_not_found";
const CONNECTION_LIMIT = "websocket_connection_limit_reached";
const SSE_BETA = "responses=experimental";
const WEBSOCKET_BETA = "responses_websockets=2026-02-06";

function codexSseEvents(input: ResponsesEventStreamInput): AsyncIterable<ResponsesWireEvent> {
  return httpResponsesWireEvents(input, { compressZstd: true });
}

function isSuccessfulCodexSseTerminal(wire: ResponsesWireEvent): boolean {
  try {
    const event = asRecord(JSON.parse(wire.data));
    if (event === undefined) return false;
    const type = asString(event.type) ?? wire.event;
    if (type === undefined) return false;
    const outcome = responsesTerminalOutcome(type, asRecord(event?.response));
    return outcome === "completed" || outcome === "incomplete";
  } catch {
    return false;
  }
}

interface CodexModelDefinition {
  id: string;
  displayName: string;
  contextTokens: number;
  images: boolean;
  reasoningEfforts: readonly string[];
  deferredTools?: boolean;
}

const CODEX_MODELS: readonly CodexModelDefinition[] = Object.freeze([
  { id: "gpt-5.4", displayName: "GPT-5.4", contextTokens: 272_000, images: true, reasoningEfforts: ["low", "medium", "high", "xhigh"], deferredTools: true },
  { id: "gpt-5.4-mini", displayName: "GPT-5.4 mini", contextTokens: 272_000, images: true, reasoningEfforts: ["low", "medium", "high", "xhigh"], deferredTools: true },
  { id: "gpt-5.5", displayName: "GPT-5.5", contextTokens: 272_000, images: true, reasoningEfforts: ["low", "medium", "high", "xhigh"], deferredTools: true },
  { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", contextTokens: 272_000, images: true, reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], deferredTools: true },
  { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", contextTokens: 272_000, images: true, reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], deferredTools: true },
  { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", contextTokens: 272_000, images: true, reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], deferredTools: true },
]);

function codexDeferredToolsSupported(model: string): boolean | undefined {
  const definition = CODEX_MODELS.find((candidate) => candidate.id === model);
  return definition === undefined ? undefined : definition.deferredTools === true;
}

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
    ...(() => {
      const configured = sourceRequest.modelSettings?.compatibility?.supportsToolSearch;
      const supported = configured ?? codexDeferredToolsSupported(sourceRequest.model);
      if (supported === undefined) return {};
      return {
        modelSettings: {
          ...(sourceRequest.modelSettings ?? {}),
          compatibility: {
            ...(sourceRequest.modelSettings?.compatibility ?? {}),
            supportsToolSearch: supported,
          },
        },
      };
    })(),
  };
  const body = buildResponsesBody(withoutSystem, false, true);
  body.instructions = codexInstructions(sourceRequest);
  body.text = { verbosity: "low" };
  if (sourceRequest.toolChoice === undefined) body.tool_choice = "auto";
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
      capabilities: { tools, reasoning, images },
      compatibility: {
        protocolFamily: modelEvidence("openai-responses", "maintained", observedAt),
        inputModalities: modelEvidence(definition.images ? ["text", "image"] : ["text"], "maintained", observedAt),
        outputModalities: modelEvidence(["text"], "maintained", observedAt),
        reasoningEfforts: modelEvidence([...definition.reasoningEfforts], "maintained", observedAt),
        strictTools: tools,
        toolStreaming: tools,
        cacheMode: modelEvidence("automatic", "maintained", observedAt),
        cacheAffinity: modelEvidence("prefix", "maintained", observedAt),
        sessionAffinity: modelEvidence("stateless", "maintained", observedAt),
        deferredTools: modelEvidence(definition.deferredTools === true ? "supported" : "unsupported", "maintained", observedAt),
      },
    };
  });
}

interface CachedCodexContinuation {
  request: Record<string, unknown>;
  responseId: string;
  responseItems: unknown[];
}

interface CachedCodexSocket {
  socket: NetworkWebSocket;
  busy: boolean;
  createdAt: number;
  continuation?: CachedCodexContinuation;
  idleTimer?: NodeJS.Timeout;
}

interface AcquiredCodexSocket {
  socket: NetworkWebSocket;
  entry?: CachedCodexSocket;
  reused: boolean;
  release(keep: boolean, continuation?: CachedCodexContinuation): void;
}

class CodexWebSocketControlError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CodexWebSocketControlError";
    this.code = code;
  }
}

class CodexWebSocketFrameProtocolError extends ProtocolError {}

class CodexWebSocketHostError extends Error {
  readonly original: unknown;

  constructor(original: unknown) {
    super("OpenAI Codex provider wire hook failed");
    this.name = "CodexWebSocketHostError";
    this.original = original;
  }
}

async function runCodexWebSocketHostHook<T>(hook: () => T | Promise<T>): Promise<T> {
  try {
    return await hook();
  } catch (error) {
    throw new CodexWebSocketHostError(error);
  }
}

async function beginCodexWebSocketHostOperation(
  wire: ProviderWireTransportHost,
): Promise<ProviderWireOperation | undefined> {
  return await runCodexWebSocketHostHook(() => {
    const operation = wire.begin("openai-codex");
    return operation.active === true ? operation : undefined;
  });
}

class CodexWebSocketNetworkError extends TypeError {
  readonly failureClass: OpenAICodexTransportFailureClass;
  readonly closeCode: number | undefined;
  readonly transportCode: string | undefined;

  constructor(
    message: string,
    options: ErrorOptions & {
      failureClass?: OpenAICodexTransportFailureClass;
      closeCode?: number;
      transportCode?: string;
    } = {},
  ) {
    const transportCode = safeWebSocketNativeErrorCode(
      options.transportCode ?? transportErrorCode(options.cause),
    );
    super(message);
    this.name = "CodexWebSocketNetworkError";
    this.failureClass = options.failureClass ?? "network";
    this.closeCode = options.closeCode;
    this.transportCode = transportCode
      ?? (options.closeCode === undefined ? undefined : `WS_CLOSE_${options.closeCode}`);
  }
}

function transportTimeout(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 0 || selected > 2_147_483_647) {
    throw new RangeError(`${label} must be an integer from 0 through 2147483647`);
  }
  return selected;
}

function codexWebSocketUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function codexSocketIdentity(url: string, headers: Headers): string {
  const handshake = stringifyProviderJson([url, [...headers.entries()]]);
  return createHash("sha256").update(handshake).digest("hex");
}

function codexFallbackIdentity(url: string, headers: Headers, sessionId: string): string {
  const scope = stringifyProviderJson([sessionId, url, headers.get("chatgpt-account-id") ?? ""]);
  return createHash("sha256").update(scope).digest("hex");
}

function sameJson(left: unknown, right: unknown): boolean {
  return stringifyProviderJson(left) === stringifyProviderJson(right);
}

function continuationIndependentBody(body: Record<string, unknown>): Record<string, unknown> {
  const { input: _input, previous_response_id: _previousResponseId, ...remaining } = body;
  return remaining;
}

function compatibleContinuationBody(
  entry: CachedCodexSocket,
  fullBody: Record<string, unknown>,
  deltaBody: Record<string, unknown>,
  previousResponseId: string | undefined,
): Record<string, unknown> {
  const continuation = entry.continuation;
  if (
    continuation === undefined
    || previousResponseId !== continuation.responseId
    || deltaBody.previous_response_id !== continuation.responseId
    || !sameJson(
      continuationIndependentBody(fullBody),
      continuationIndependentBody(continuation.request),
    )
  ) {
    delete entry.continuation;
    return fullBody;
  }

  const previousInput = Array.isArray(continuation.request.input) ? continuation.request.input : [];
  const currentInput = Array.isArray(fullBody.input) ? fullBody.input : [];
  const expectedPrefix = [...previousInput, ...continuation.responseItems];
  if (
    currentInput.length < expectedPrefix.length
    || !sameJson(currentInput.slice(0, expectedPrefix.length), expectedPrefix)
  ) {
    delete entry.continuation;
    return fullBody;
  }

  const expectedDelta = currentInput.slice(expectedPrefix.length);
  if (!Array.isArray(deltaBody.input) || !sameJson(deltaBody.input, expectedDelta)) {
    delete entry.continuation;
    return fullBody;
  }
  return deltaBody;
}

function closeSocket(socket: NetworkWebSocket, reason = "complete"): void {
  if (socket.readyState === 2 || socket.readyState === 3) return;
  try {
    socket.close(1000, reason.slice(0, 123));
  } catch {
    // A transport that is already tearing down needs no further cleanup.
  }
}

function isErrorObject(value: unknown): value is Error {
  const isError = (Error as ErrorConstructor & { isError?: (candidate: unknown) => boolean }).isError;
  return isError?.(value) === true;
}

function errorInstance<TError extends Error>(
  value: unknown,
  constructor: abstract new (...argumentsValue: never[]) => TError,
): value is TError {
  if (!isErrorObject(value)) return false;
  try { return value instanceof constructor; }
  catch { return false; }
}

function ownErrorField(value: Error, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

const domExceptionNameGetter = typeof DOMException === "undefined"
  ? undefined
  : Object.getOwnPropertyDescriptor(DOMException.prototype, "name")?.get;

function isAbortError(value: unknown): boolean {
  if (!isErrorObject(value)) return false;
  const name = errorInstance(value, DOMException) && domExceptionNameGetter !== undefined
    ? domExceptionNameGetter.call(value)
    : ownErrorField(value, "name");
  return name === "AbortError" || ownErrorField(value, "code") === "ABORT_ERR";
}

function networkError(
  error: unknown,
  fallback: string,
  failureClass: OpenAICodexTransportFailureClass = "network",
  transportCode?: string,
): Error {
  if (
    errorInstance(error, CodexWebSocketNetworkError)
    || errorInstance(error, HttpResponseError)
    || errorInstance(error, PrematureStreamEndError)
    || errorInstance(error, ProtocolError)
    || errorInstance(error, ProviderStreamError)
  ) return error;
  if (isAbortError(error) && isErrorObject(error)) return error;
  return new CodexWebSocketNetworkError(fallback, {
    failureClass,
    ...(transportCode === undefined ? {} : { transportCode }),
    ...(isErrorObject(error) ? { cause: error } : {}),
  });
}

type EventGetter = (this: object) => unknown;

const errorEventErrorGetter = typeof ErrorEvent === "undefined"
  ? undefined
  : Object.getOwnPropertyDescriptor(ErrorEvent.prototype, "error")?.get;
const closeEventCodeGetter = typeof CloseEvent === "undefined"
  ? undefined
  : Object.getOwnPropertyDescriptor(CloseEvent.prototype, "code")?.get;
const closeEventReasonGetter = typeof CloseEvent === "undefined"
  ? undefined
  : Object.getOwnPropertyDescriptor(CloseEvent.prototype, "reason")?.get;
const messageEventDataGetter = typeof MessageEvent === "undefined"
  ? undefined
  : Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data")?.get;
const networkErrorEventErrorGetter = Object.getOwnPropertyDescriptor(NetworkErrorEvent.prototype, "error")?.get;
const networkCloseEventCodeGetter = Object.getOwnPropertyDescriptor(NetworkCloseEvent.prototype, "code")?.get;
const networkCloseEventReasonGetter = Object.getOwnPropertyDescriptor(NetworkCloseEvent.prototype, "reason")?.get;
const networkMessageEventDataGetter = Object.getOwnPropertyDescriptor(NetworkMessageEvent.prototype, "data")?.get;
const errorEventErrorGetters = [errorEventErrorGetter, networkErrorEventErrorGetter] as const;
const closeEventCodeGetters = [closeEventCodeGetter, networkCloseEventCodeGetter] as const;
const closeEventReasonGetters = [closeEventReasonGetter, networkCloseEventReasonGetter] as const;
const messageEventDataGetters = [messageEventDataGetter, networkMessageEventDataGetter] as const;

function socketEventField(
  event: Event,
  key: string,
  nativeGetters: readonly (EventGetter | undefined)[],
): unknown {
  if (isProxy(event)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(event, key);
  if (descriptor !== undefined) return "value" in descriptor ? descriptor.value : undefined;
  for (const nativeGetter of nativeGetters) {
    if (nativeGetter === undefined) continue;
    try { return nativeGetter.call(event); }
    catch { /* Try the next supported event implementation. */ }
  }
  return undefined;
}

function socketError(
  event: Event,
  fallback: string,
  failureClass: "close" | "network",
  originalCause?: Error,
  transportCode?: string,
): Error {
  const error = socketEventField(event, "error", errorEventErrorGetters);
  const code = socketEventField(event, "code", closeEventCodeGetters);
  const reason = socketEventField(event, "reason", closeEventReasonGetters);
  const closeCode = failureClass === "close" ? webSocketCloseCode(code) : undefined;
  if (isErrorObject(error) && failureClass !== "close") {
    return networkError(error, fallback, failureClass, transportCode);
  }
  if (failureClass === "close") {
    const closeReason = typeof reason === "string" ? reason.slice(0, 512) : undefined;
    const closeReasonId = closeReason === undefined || closeReason === ""
      ? undefined
      : createHash("sha256").update(closeReason).digest("hex").slice(0, 12);
    return new CodexWebSocketNetworkError(
      closeCode === undefined
        ? fallback
        : `${fallback}: ${closeCode} (${webSocketCloseLabel(closeCode)}${closeReasonId === undefined ? "" : `; reason ${closeReasonId}`})`,
      {
        failureClass,
        ...(closeCode === undefined ? {} : { closeCode }),
        ...(transportCode === undefined ? {} : { transportCode }),
        ...(originalCause === undefined ? {} : { cause: originalCause }),
      },
    );
  }
  return new CodexWebSocketNetworkError(fallback, {
    failureClass,
    ...(transportCode === undefined ? {} : { transportCode }),
    ...(isErrorObject(error) ? { cause: error } : {}),
  });
}

function webSocketCloseCode(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1_000 && value <= 4_999
    ? value
    : undefined;
}

function webSocketCloseLabel(code: number): string {
  switch (code) {
    case 1000: return "normal closure";
    case 1001: return "going away";
    case 1002: return "protocol error";
    case 1003: return "unsupported data";
    case 1005: return "no status received";
    case 1006: return "abnormal closure";
    case 1007: return "invalid payload";
    case 1008: return "policy violation";
    case 1009: return "message too big";
    case 1010: return "required extension missing";
    case 1011: return "server error";
    case 1012: return "service restart";
    case 1013: return "try again later";
    case 1014: return "bad gateway";
    case 1015: return "TLS handshake failure";
    default: return code >= 3000 ? "application closure" : "unrecognized closure";
  }
}

function transportFailure(error: unknown): {
  failureClass: OpenAICodexTransportFailureClass;
  closeCode?: number;
  transportCode?: string;
} {
  if (errorInstance(error, CodexWebSocketNetworkError)) {
    const transportCode = error.transportCode === (error.closeCode === undefined ? undefined : `WS_CLOSE_${error.closeCode}`)
      ? undefined
      : error.transportCode;
    return {
      failureClass: error.failureClass,
      ...(error.closeCode === undefined ? {} : { closeCode: error.closeCode }),
      ...(transportCode === undefined ? {} : { transportCode }),
    };
  }
  if (errorInstance(error, ProtocolError)) return { failureClass: "protocol" };
  if (errorInstance(error, PrematureStreamEndError)) return { failureClass: "premature_end" };
  if (errorInstance(error, HttpResponseError)) return { failureClass: "http" };
  if (errorInstance(error, ProviderStreamError)) return { failureClass: "provider" };
  if (errorInstance(error, CodexWebSocketControlError)) return { failureClass: "provider_control" };
  if (isAbortError(error)) return { failureClass: "cancelled" };
  return { failureClass: "unknown" };
}

function observeCodexTransport(
  observer: OpenAICodexTransportObserver | undefined,
  observation: OpenAICodexTransportObservation,
): void {
  try { observer?.(observation); }
  catch { /* Observability must not affect provider behavior. */ }
}

function assertWebSocketMessageSize(bytes: number): void {
  if (bytes > INTERNAL_WEBSOCKET_MAX_PAYLOAD_BYTES) {
    throw new CodexWebSocketFrameProtocolError(
      `OpenAI Codex WebSocket message exceeded ${INTERNAL_WEBSOCKET_MAX_PAYLOAD_BYTES} bytes`,
    );
  }
}

const blobSizeGetter = Object.getOwnPropertyDescriptor(Blob.prototype, "size")?.get;

function actualBlobSize(value: object): number | undefined {
  if (blobSizeGetter === undefined) return undefined;
  try { return blobSizeGetter.call(value) as number; }
  catch { return undefined; }
}

async function decodeWebSocketMessage(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (typeof data === "object" && data !== null && isProxy(data)) {
    throw new CodexWebSocketFrameProtocolError("OpenAI Codex WebSocket returned an unsupported message type");
  }
  let bytes: Uint8Array;
  if (data instanceof ArrayBuffer) {
    assertWebSocketMessageSize(data.byteLength);
    bytes = new Uint8Array(data);
  }
  else if (ArrayBuffer.isView(data)) {
    assertWebSocketMessageSize(data.byteLength);
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else if (data !== null && typeof data === "object") {
    const size = actualBlobSize(data);
    if (size === undefined) {
      throw new CodexWebSocketFrameProtocolError("OpenAI Codex WebSocket returned an unsupported message type");
    }
    assertWebSocketMessageSize(size);
    try {
      const buffer = await (data as Blob).arrayBuffer();
      bytes = new Uint8Array(buffer);
    } catch {
      throw new CodexWebSocketFrameProtocolError("OpenAI Codex WebSocket message could not be read");
    }
  } else {
    throw new CodexWebSocketFrameProtocolError("OpenAI Codex WebSocket returned an unsupported message type");
  }
  assertWebSocketMessageSize(bytes.byteLength);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CodexWebSocketFrameProtocolError("OpenAI Codex WebSocket message contained invalid UTF-8");
  }
}

function webSocketAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  const isError = (Error as ErrorConstructor & { isError?: (candidate: unknown) => boolean }).isError;
  return isError?.(reason) === true ? reason : new DOMException("Aborted", "AbortError");
}

function throwIfWebSocketAborted(signal: AbortSignal): void {
  if (signal.aborted) throw webSocketAbortError(signal);
}

async function waitForWebSocketOpen(
  socket: NetworkWebSocket,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  throwIfWebSocketAborted(signal);
  if (socket.readyState === 1) return;
  if (socket.readyState !== 0) {
    throw new CodexWebSocketNetworkError("OpenAI Codex WebSocket closed before opening", { failureClass: "connect" });
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let pendingError: Error | undefined;
    let pendingErrorImmediate: NodeJS.Immediate | undefined;
    const cleanup = (): void => {
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("open", onOpen);
      signal.removeEventListener("abort", onAbort);
      if (timer !== undefined) clearTimeout(timer);
      if (pendingErrorImmediate !== undefined) clearImmediate(pendingErrorImmediate);
    };
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    const onOpen = (): void => settle();
    const onError = (event: Event): void => {
      pendingError = socketError(
        event,
        "OpenAI Codex WebSocket connection failed",
        "network",
        undefined,
        consumeWebSocketNativeErrorCode(socket),
      );
      pendingErrorImmediate ??= setImmediate(() => {
        pendingErrorImmediate = undefined;
        settle(pendingError);
      });
    };
    const onClose = (event: Event): void => {
      if (pendingErrorImmediate !== undefined) {
        clearImmediate(pendingErrorImmediate);
        pendingErrorImmediate = undefined;
      }
      settle(socketError(
        event,
        "OpenAI Codex WebSocket closed before opening",
        "close",
        pendingError,
        consumeWebSocketNativeErrorCode(socket),
      ));
    };
    const onAbort = (): void => {
      settle(webSocketAbortError(signal));
      closeSocket(socket, "aborted");
    };
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
    socket.addEventListener("open", onOpen);
    signal.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        settle(new CodexWebSocketNetworkError(`OpenAI Codex WebSocket connect timeout after ${timeoutMs}ms`, {
          failureClass: "connect_timeout",
        }));
        closeSocket(socket, "connect_timeout");
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
  let pendingError: Error | undefined;
  let pendingErrorImmediate: NodeJS.Immediate | undefined;
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
    const data = socketEventField(event, "data", messageEventDataGetters);
    decodeTail = decodeTail.then(async () => {
      const text = await decodeWebSocketMessage(data);
      const bytes = Buffer.byteLength(text, "utf8");
      assertWebSocketMessageSize(bytes);
      if (queue.length >= MAX_QUEUED_WEBSOCKET_MESSAGES || queuedBytes + bytes > MAX_QUEUED_WEBSOCKET_BYTES) {
        throw new CodexWebSocketFrameProtocolError("OpenAI Codex WebSocket receive queue exceeded its safety limit");
      }
      queue.push({ text, bytes });
      queuedBytes += bytes;
      notify();
    }).catch((error) => {
      closeSocket(socket, "protocol_error");
      fail(isErrorObject(error) ? error : new CodexWebSocketFrameProtocolError(
        "OpenAI Codex WebSocket message decoding failed",
      ));
    });
  };
  const onError = (event: Event): void => {
    pendingError = socketError(
      event,
      "OpenAI Codex WebSocket failed",
      "network",
      undefined,
      consumeWebSocketNativeErrorCode(socket),
    );
    pendingErrorImmediate ??= setImmediate(() => {
      pendingErrorImmediate = undefined;
      decodeTail = decodeTail.then(() => fail(pendingError!));
    });
  };
  const onClose = (event: Event): void => {
    if (pendingErrorImmediate !== undefined) {
      clearImmediate(pendingErrorImmediate);
      pendingErrorImmediate = undefined;
    }
    decodeTail = decodeTail.then(() => fail(socketError(
      event,
      "OpenAI Codex WebSocket closed before a terminal event",
      "close",
      pendingError,
      consumeWebSocketNativeErrorCode(socket),
    )));
  };
  const onAbort = (): void => {
    fail(webSocketAbortError(signal));
    closeSocket(socket, "aborted");
  };
  socket.addEventListener("close", onClose);
  socket.addEventListener("error", onError);
  socket.addEventListener("message", onMessage);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
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
        let timer: NodeJS.Timeout | undefined;
        const resume = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          resolve();
        };
        wake = resume;
        if (idleTimeoutMs <= 0) return;
        timer = setTimeout(() => {
          if (wake !== resume) return;
          wake = undefined;
          closeSocket(socket, "idle_timeout");
          reject(new CodexWebSocketNetworkError(`OpenAI Codex WebSocket idle timeout after ${idleTimeoutMs}ms`, {
            failureClass: "idle_timeout",
          }));
        }, idleTimeoutMs);
      });
    }
  } finally {
    if (pendingErrorImmediate !== undefined) clearImmediate(pendingErrorImmediate);
    socket.removeEventListener("close", onClose);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("message", onMessage);
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

function responseContentEntryBoundary(value: unknown): OpenAICodexOutputBoundary | undefined {
  const content = asRecord(value);
  if (content === undefined) return "unknown_or_opaque";
  const type = asString(content.type);
  if (type === "output_text") {
    const text = asString(content.text);
    if (text === undefined) return "unknown_or_opaque";
    if (content.annotations !== undefined && !Array.isArray(content.annotations)) return "unknown_or_opaque";
    return text !== "" || (Array.isArray(content.annotations) && content.annotations.length > 0)
      ? "visible_text"
      : undefined;
  }
  if (type === "refusal") {
    const refusal = asString(content.refusal);
    return refusal === undefined
      ? "unknown_or_opaque"
      : refusal === "" ? undefined : "visible_text";
  }
  if (type === "reasoning_text") {
    const text = asString(content.text);
    return text === undefined
      ? "unknown_or_opaque"
      : text === "" ? undefined : "hidden_provider_reasoning";
  }
  if (type === "summary_text") {
    const text = asString(content.text);
    return text === undefined
      ? "unknown_or_opaque"
      : text === "" ? undefined : "visible_summary_reasoning";
  }
  return "unknown_or_opaque";
}

const outputBoundaryPriority: Readonly<Record<OpenAICodexOutputBoundary, number>> = {
  visible_text: 0,
  visible_summary_reasoning: 1,
  tool_draft: 2,
  hidden_provider_reasoning: 3,
  unknown_or_opaque: 4,
};

function preferredOutputBoundary(
  current: OpenAICodexOutputBoundary | undefined,
  candidate: OpenAICodexOutputBoundary | undefined,
): OpenAICodexOutputBoundary | undefined {
  if (candidate === undefined) return current;
  if (current === undefined || outputBoundaryPriority[candidate] < outputBoundaryPriority[current]) return candidate;
  return current;
}

function responseContentListBoundary(
  value: unknown,
  allowedTypes: ReadonlySet<string>,
): OpenAICodexOutputBoundary | undefined {
  if (!Array.isArray(value)) return "unknown_or_opaque";
  return value.reduce<OpenAICodexOutputBoundary | undefined>(
    (boundary, entry) => {
      const content = asRecord(entry);
      return preferredOutputBoundary(
        boundary,
        content === undefined || !allowedTypes.has(asString(content.type) ?? "")
          ? "unknown_or_opaque"
          : responseContentEntryBoundary(content),
      );
    },
    undefined,
  );
}

const responseMessageContentTypes = new Set(["output_text", "refusal"]);
const responseReasoningSummaryTypes = new Set(["summary_text"]);
const responseReasoningContentTypes = new Set(["reasoning_text"]);

function responseOutputItemBoundary(item: Record<string, unknown>): OpenAICodexOutputBoundary | undefined {
  if (item.type === "function_call" || item.type === "custom_tool_call") return "tool_draft";
  if (item.type === "message") return responseContentListBoundary(item.content, responseMessageContentTypes);
  if (item.type === "reasoning") {
    let boundary: OpenAICodexOutputBoundary | undefined;
    if (item.encrypted_content !== undefined && item.encrypted_content !== null) {
      const encrypted = asString(item.encrypted_content);
      if (encrypted === undefined) return "unknown_or_opaque";
      if (encrypted !== "") boundary = "hidden_provider_reasoning";
    }
    if (item.summary !== undefined) {
      boundary = preferredOutputBoundary(
        boundary,
        responseContentListBoundary(item.summary, responseReasoningSummaryTypes),
      );
    }
    if (item.content !== undefined) {
      boundary = preferredOutputBoundary(
        boundary,
        responseContentListBoundary(item.content, responseReasoningContentTypes),
      );
    }
    return boundary;
  }
  return "unknown_or_opaque";
}

function responseObjectOutputBoundary(value: unknown): OpenAICodexOutputBoundary | undefined {
  if (value === undefined) return undefined;
  const response = asRecord(value);
  if (response === undefined) return "unknown_or_opaque";
  const output = response.output;
  if (output === undefined) return undefined;
  if (!Array.isArray(output)) return "unknown_or_opaque";
  return output.reduce<OpenAICodexOutputBoundary | undefined>((boundary, item) => {
    const record = asRecord(item);
    return preferredOutputBoundary(
      boundary,
      record === undefined ? "unknown_or_opaque" : responseOutputItemBoundary(record),
    );
  }, undefined);
}

function webSocketEventOutputBoundary(
  event: Record<string, unknown>,
  type: string,
): OpenAICodexOutputBoundary | undefined {
  if (
    type === "response.created"
    || type === "response.in_progress"
    || type === "response.queued"
    || type === "response.metadata"
    || type === "codex.rate_limits"
    || type === "codex.response.metadata"
    || type === "responsesapi.websocket_timing"
  ) {
    if (
      event.response === undefined
      && (type === "response.created" || type === "response.in_progress" || type === "response.queued")
    ) return "unknown_or_opaque";
    return responseObjectOutputBoundary(event.response);
  }

  if (type === "response.output_text.delta" || type === "response.refusal.delta") {
    const delta = asString(event.delta);
    return delta === undefined ? "unknown_or_opaque" : delta === "" ? undefined : "visible_text";
  }

  if (type === "response.reasoning_summary_text.delta") {
    const delta = asString(event.delta);
    return delta === undefined ? "unknown_or_opaque" : delta === "" ? undefined : "visible_summary_reasoning";
  }

  if (type === "response.reasoning_text.delta") {
    const delta = asString(event.delta);
    return delta === undefined ? "unknown_or_opaque" : delta === "" ? undefined : "hidden_provider_reasoning";
  }

  if (type === "response.output_text.done") {
    const text = asString(event.text);
    return text === undefined ? "unknown_or_opaque" : text === "" ? undefined : "visible_text";
  }

  if (type === "response.reasoning_summary_text.done") {
    const text = asString(event.text);
    return text === undefined ? "unknown_or_opaque" : text === "" ? undefined : "visible_summary_reasoning";
  }

  if (type === "response.reasoning_text.done") {
    const text = asString(event.text);
    return text === undefined ? "unknown_or_opaque" : text === "" ? undefined : "hidden_provider_reasoning";
  }

  if (type === "response.refusal.done") {
    const refusal = asString(event.refusal);
    return refusal === undefined ? "unknown_or_opaque" : refusal === "" ? undefined : "visible_text";
  }

  if (type === "response.content_part.added" || type === "response.content_part.done") {
    const partType = asString(asRecord(event.part)?.type);
    if (partType !== "output_text" && partType !== "refusal" && partType !== "reasoning_text") {
      return "unknown_or_opaque";
    }
    return responseContentEntryBoundary(event.part);
  }

  if (type === "response.reasoning_summary_part.added" || type === "response.reasoning_summary_part.done") {
    if (asString(asRecord(event.part)?.type) !== "summary_text") return "unknown_or_opaque";
    return responseContentEntryBoundary(event.part);
  }

  if (type === "response.output_item.added" || type === "response.output_item.done") {
    const item = asRecord(event.item);
    return item === undefined ? "unknown_or_opaque" : responseOutputItemBoundary(item);
  }

  if (
    type === "response.function_call_arguments.delta"
    || type === "response.function_call_arguments.done"
    || type === "response.custom_tool_call_input.delta"
    || type === "response.custom_tool_call_input.done"
  ) return "tool_draft";

  if (responsesTerminalOutcome(type, asRecord(event.response)) !== undefined || type === "error") return undefined;
  return "unknown_or_opaque";
}

function canFallbackFromCodexWebSocket(error: unknown): boolean {
  if (errorInstance(error, ProviderStreamError)) return false;
  if (errorInstance(error, HttpResponseError)) return error.status >= 500;
  return errorInstance(error, CodexWebSocketNetworkError)
    || errorInstance(error, ProtocolError)
    || errorInstance(error, PrematureStreamEndError);
}

function outputBoundaryDescription(boundary: OpenAICodexOutputBoundary): string {
  switch (boundary) {
    case "visible_text": return "visible response text";
    case "visible_summary_reasoning": return "visible reasoning-summary text";
    case "hidden_provider_reasoning": return "hidden provider reasoning state";
    case "tool_draft": return "a tool-call draft";
    case "unknown_or_opaque": return "unknown or opaque provider state";
  }
}

function semanticWebSocketFailure(
  error: unknown,
  outputBoundary: OpenAICodexOutputBoundary,
  nextRequestUsesSse: boolean,
): Error {
  const message = `OpenAI Codex WebSocket failed after ${outputBoundaryDescription(outputBoundary)} was received. Rigyn did not replay the response because output or provider state may not be safe to repeat`
    + (nextRequestUsesSse
      ? "; Rigyn switched this session to HTTPS/SSE for subsequent requests."
      : ".");
  const cause = isErrorObject(error) ? error : undefined;
  if (errorInstance(error, ProtocolError)) return new ProtocolError(message, undefined, { cause });
  if (errorInstance(error, PrematureStreamEndError)) {
    return new PrematureStreamEndError(message, undefined, {
      cause,
      ...(error.transportCode === undefined ? {} : { transportCode: error.transportCode }),
    });
  }
  if (errorInstance(error, CodexWebSocketNetworkError)) {
    return new CodexWebSocketNetworkError(message, {
      cause: error,
      failureClass: error.failureClass,
      ...(error.closeCode === undefined ? {} : { closeCode: error.closeCode }),
      ...(error.transportCode === undefined ? {} : { transportCode: error.transportCode }),
    });
  }
  return new CodexWebSocketNetworkError(message, { ...(cause === undefined ? {} : { cause }) });
}

interface CodexWebSocketEvent {
  wire: ResponsesWireEvent;
  outputBoundary?: OpenAICodexOutputBoundary;
}

async function prepareCodexWebSocketFrame(
  operation: ProviderWireOperation | undefined,
  httpUrl: string,
  headers: Headers,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  if (operation === undefined) return stringifyProviderJson(body);
  if (!isJsonValue(body)) throw new TypeError("OpenAI Codex WebSocket request body must be JSON");
  return await runCodexWebSocketHostHook(async () => {
    const prepared = await operation.intercept({
      url: codexWebSocketUrl(httpUrl),
      method: "SEND",
      headers,
      body,
      transport: "websocket",
      phase: "frame",
    }, signal);
    if (prepared.headersChanged) {
      throw new TypeError("Provider wire WebSocket frame cannot modify handshake headers");
    }
    const selected = prepared.body ?? body;
    const record = asRecord(selected);
    if (record === undefined) throw new TypeError("OpenAI Codex WebSocket request body must be an object");
    return stringifyProviderJson(record);
  });
}

async function observeCodexWebSocketFrame(
  operation: ProviderWireOperation | undefined,
  httpUrl: string,
  data: string,
  type: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (operation === undefined) return;
  await runCodexWebSocketHostHook(() => operation.observe({
    url: codexWebSocketUrl(httpUrl),
    status: 101,
    statusText: "WebSocket Message",
    headers: {},
    transport: "websocket",
    phase: "frame",
    frame: {
      direction: "receive",
      bytes: Buffer.byteLength(data, "utf8"),
      ...(type === undefined ? {} : { type }),
    },
  }, signal));
}

class CodexWebSocketTransport {
  readonly #factory: NetworkWebSocketFactory;
  readonly #mode: Exclude<OpenAICodexTransport, "sse">;
  readonly #connectTimeoutMs: number;
  readonly #idleTimeoutMs: number;
  readonly #wire: ProviderWireTransportHost | undefined;
  readonly #observer: OpenAICodexTransportObserver | undefined;
  readonly #sessions = new Map<string, Map<string, CachedCodexSocket>>();
  readonly #pendingSockets = new Set<NetworkWebSocket>();
  readonly #activeSockets = new Set<NetworkWebSocket>();
  readonly #sseFallbackIdentities = new Set<string>();
  #closed = false;

  constructor(
    factory: NetworkWebSocketFactory,
    mode: Exclude<OpenAICodexTransport, "sse">,
    options: {
      connectTimeoutMs: number;
      idleTimeoutMs: number;
      wire?: ProviderWireTransportHost;
      observer?: OpenAICodexTransportObserver;
    },
  ) {
    this.#factory = factory;
    this.#mode = mode;
    this.#connectTimeoutMs = options.connectTimeoutMs;
    this.#idleTimeoutMs = options.idleTimeoutMs;
    this.#wire = options.wire;
    this.#observer = options.observer;
  }

  async *stream(input: ResponsesEventStreamInput): AsyncGenerator<ResponsesWireEvent> {
    if (this.#closed) throw new Error("OpenAI Codex WebSocket transport is closed");
    const fallbackSessionId = input.request.sessionId === undefined
      || input.request.sessionId === ""
      ? undefined
      : openAIPromptCacheKey(input.request.sessionId);
    const fullBody = buildOpenAICodexResponsesBody(input.request, false);
    const webSocketHeaders = new Headers(input.headers);
    if (input.request.cacheRetention === "none") {
      const requestId = uuidv7();
      webSocketHeaders.set("session-id", requestId);
      webSocketHeaders.set("x-client-request-id", requestId);
    }
    const webSocketInput = { ...input, headers: webSocketHeaders };
    const fallbackIdentity = fallbackSessionId === undefined
      ? undefined
      : codexFallbackIdentity(input.url, webSocketHeaders, fallbackSessionId);
    if (
      this.#mode === "auto"
      && fallbackIdentity !== undefined
      && this.#sseFallbackIdentities.has(fallbackIdentity)
    ) {
      this.#sseFallbackIdentities.delete(fallbackIdentity);
      this.#sseFallbackIdentities.add(fallbackIdentity);
      observeCodexTransport(this.#observer, {
        type: "selected",
        transport: "sse",
        sessionFallbackUsed: true,
      });
      for await (const wire of codexSseEvents({ ...input, body: fullBody })) {
        if (this.#closed) throw new Error("OpenAI Codex WebSocket transport is closed");
        yield wire;
      }
      return;
    }

    let forceFull = false;
    let connectionLimitRetries = 0;
    let missingContextRetries = 0;
    let resetWebSocketAttempt = false;
    while (true) {
      let outputBoundary: OpenAICodexOutputBoundary | undefined;
      try {
        for await (const event of this.#webSocketEvents(webSocketInput, fullBody, forceFull)) {
          outputBoundary = preferredOutputBoundary(outputBoundary, event.outputBoundary);
          yield resetWebSocketAttempt ? markResponsesAttemptReset(event.wire) : event.wire;
          resetWebSocketAttempt = false;
        }
        return;
      } catch (error) {
        if (errorInstance(error, CodexWebSocketHostError)) throw error.original;
        outputBoundary ??= errorInstance(error, CodexWebSocketFrameProtocolError)
          ? "unknown_or_opaque"
          : undefined;
        const code = errorInstance(error, CodexWebSocketControlError) ? error.code : undefined;
        if (outputBoundary === undefined && code === CONNECTION_LIMIT && connectionLimitRetries < 1) {
          connectionLimitRetries += 1;
          forceFull = true;
          resetWebSocketAttempt = true;
          continue;
        }
        if (outputBoundary === undefined && code === RESPONSE_NOT_FOUND && missingContextRetries < 1) {
          missingContextRetries += 1;
          forceFull = true;
          resetWebSocketAttempt = true;
          continue;
        }
        const failure = transportFailure(error);
        observeCodexTransport(this.#observer, {
          type: "websocket_failed",
          ...failure,
          partialOutput: outputBoundary !== undefined,
          ...(outputBoundary === undefined ? {} : { outputBoundary }),
        });
        const autoFallback = this.#mode === "auto"
          && !this.#closed
          && !input.signal.aborted
          && canFallbackFromCodexWebSocket(error);
        if (outputBoundary === undefined && autoFallback) {
          observeCodexTransport(this.#observer, {
            type: "selected",
            transport: "sse",
            sessionFallbackUsed: fallbackIdentity !== undefined,
          });
          let fallbackActivated = false;
          let resetAttemptState = true;
          for await (const wire of codexSseEvents({ ...input, body: fullBody })) {
            if (this.#closed) throw new Error("OpenAI Codex WebSocket transport is closed");
            if (
              !fallbackActivated
              && fallbackIdentity !== undefined
              && isSuccessfulCodexSseTerminal(wire)
            ) {
              fallbackActivated = this.#activateSseFallback(fallbackIdentity, failure.failureClass);
            }
            yield resetAttemptState ? markResponsesAttemptReset(wire) : wire;
            resetAttemptState = false;
          }
          return;
        }
        if (outputBoundary !== undefined && autoFallback) {
          const nextRequestUsesSse = fallbackIdentity !== undefined
            && this.#activateSseFallback(fallbackIdentity, failure.failureClass, outputBoundary);
          throw semanticWebSocketFailure(error, outputBoundary, nextRequestUsesSse);
        }
        throw error;
      }
    }
  }

  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const group of this.#sessions.values()) {
      for (const entry of group.values()) {
        if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
        closeSocket(entry.socket, "runtime_disposed");
      }
    }
    for (const socket of this.#pendingSockets) closeSocket(socket, "runtime_disposed");
    for (const socket of this.#activeSockets) closeSocket(socket, "runtime_disposed");
    this.#pendingSockets.clear();
    this.#activeSockets.clear();
    this.#sessions.clear();
    this.#sseFallbackIdentities.clear();
  }

  #activateSseFallback(
    identity: string,
    failureClass: OpenAICodexTransportFailureClass,
    outputBoundary?: OpenAICodexOutputBoundary,
  ): boolean {
    if (this.#closed) return false;
    this.#sseFallbackIdentities.delete(identity);
    this.#sseFallbackIdentities.add(identity);
    if (this.#sseFallbackIdentities.size > MAX_SSE_FALLBACK_IDENTITIES) {
      const oldest = this.#sseFallbackIdentities.keys().next();
      if (!oldest.done) this.#sseFallbackIdentities.delete(oldest.value);
    }
    observeCodexTransport(this.#observer, {
      type: "session_fallback_activated",
      failureClass,
      partialOutput: outputBoundary !== undefined,
      ...(outputBoundary === undefined ? {} : { outputBoundary }),
    });
    return true;
  }

  async *#webSocketEvents(
    input: ResponsesEventStreamInput,
    fullBody: Record<string, unknown>,
    forceFull: boolean,
  ): AsyncGenerator<CodexWebSocketEvent> {
    const cache = this.#mode === "auto" || this.#mode === "websocket-cached";
    const sessionId = input.request.cacheRetention === "none"
      || input.request.sessionId === undefined
      || input.request.sessionId === ""
      ? undefined
      : openAIPromptCacheKey(input.request.sessionId);
    const acquired = await this.#acquire(
      cache && !forceFull ? sessionId : undefined,
      input.url,
      input.headers,
      input.signal,
    );
    this.#activeSockets.add(acquired.socket);
    let keep = false;
    let continuation: CachedCodexContinuation | undefined;
    try {
      observeCodexTransport(this.#observer, {
        type: "selected",
        transport: "websocket",
        cachedSocketReused: acquired.reused,
        handshakeStatus: 101,
      });
      const previousId = input.request.providerState?.kind === "openai_responses"
        ? input.request.providerState.previousResponseId
        : undefined;
      const requestBody = !forceFull && acquired.reused && acquired.entry !== undefined
        ? compatibleContinuationBody(acquired.entry, fullBody, input.body, previousId)
        : fullBody;
      const outgoing: Record<string, unknown> = { ...requestBody, type: "response.create" };
      delete outgoing.stream;
      delete outgoing.background;

      const wire = this.#wire;
      const operation = wire === undefined
        ? undefined
        : await beginCodexWebSocketHostOperation(wire);
      let terminal = false;
      let responseId: string | undefined;
      const responseItems = new Map<number, unknown>();
      if (this.#closed) throw new Error("OpenAI Codex WebSocket transport is closed");
      throwIfWebSocketAborted(input.signal);
      const serializedFrame = await prepareCodexWebSocketFrame(
        operation,
        input.url,
        input.headers,
        outgoing,
        input.signal,
      );
      if (this.#closed) throw new Error("OpenAI Codex WebSocket transport is closed");
      throwIfWebSocketAborted(input.signal);
      try {
        acquired.socket.send(serializedFrame);
      } catch (error) {
        throw networkError(error, "OpenAI Codex WebSocket send failed", "send");
      }
      const diagnostics = { status: 101, headers: {} };
      input.onResponse?.(diagnostics);
      for await (const data of webSocketMessages(acquired.socket, input.signal, this.#idleTimeoutMs)) {
        if (this.#closed) throw new Error("OpenAI Codex WebSocket transport is closed");
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          await observeCodexWebSocketFrame(operation, input.url, data, undefined, input.signal);
          if (this.#closed) throw new Error("OpenAI Codex WebSocket transport is closed");
          throwIfWebSocketAborted(input.signal);
          throw new CodexWebSocketFrameProtocolError("Malformed OpenAI Codex WebSocket event", data.slice(0, 4096));
        }
        const event = asRecord(parsed);
        if (event === undefined) {
          await observeCodexWebSocketFrame(operation, input.url, data, undefined, input.signal);
          if (this.#closed) throw new Error("OpenAI Codex WebSocket transport is closed");
          throwIfWebSocketAborted(input.signal);
          throw new CodexWebSocketFrameProtocolError("OpenAI Codex WebSocket event was not an object");
        }
        const type = asString(event.type);
        await observeCodexWebSocketFrame(operation, input.url, data, type, input.signal);
        if (this.#closed) throw new Error("OpenAI Codex WebSocket transport is closed");
        throwIfWebSocketAborted(input.signal);
        if (type === undefined) {
          throw new CodexWebSocketFrameProtocolError("OpenAI Codex WebSocket event did not contain a type");
        }
        const code = responseEventCode(event);
        if (type === "error" && (code === RESPONSE_NOT_FOUND || code === CONNECTION_LIMIT)) {
          throw new CodexWebSocketControlError(code, asString(asRecord(event.error)?.message) ?? code);
        }
        responseId = responseEventId(event) ?? responseId;
        if (type === "response.output_item.added" || type === "response.output_item.done") {
          const item = event.item;
          if (item !== undefined) responseItems.set(asNumber(event.output_index) ?? responseItems.size, item);
        }
        const outcome = responsesTerminalOutcome(type, asRecord(event.response));
        if (outcome !== undefined) {
          terminal = true;
          keep = outcome === "completed" || outcome === "incomplete";
          if (outcome === "completed" && responseId !== undefined) {
            const response = asRecord(event.response);
            for (const [index, item] of (Array.isArray(response?.output) ? response.output : []).entries()) {
              responseItems.set(index, item);
            }
            continuation = {
              request: fullBody,
              responseId,
              responseItems: [...responseItems.entries()]
                .sort(([left], [right]) => left - right)
                .map(([, item]) => item),
            };
          }
        } else if (type === "error") {
          terminal = true;
        }
        const outputBoundary = webSocketEventOutputBoundary(event, type);
        yield {
          wire: { data, diagnostics },
          ...(outputBoundary === undefined ? {} : { outputBoundary }),
        };
        if (terminal) break;
      }
      if (!terminal) throw new PrematureStreamEndError("OpenAI Codex WebSocket ended before a terminal event");
    } finally {
      this.#activeSockets.delete(acquired.socket);
      acquired.release(keep, continuation);
    }
  }

  async #acquire(
    sessionId: string | undefined,
    httpUrl: string,
    headers: Headers,
    signal: AbortSignal,
  ): Promise<AcquiredCodexSocket> {
    if (this.#closed) throw new Error("OpenAI Codex WebSocket transport is closed");
    const socketHeaders = new Headers(headers);
    socketHeaders.delete("accept");
    socketHeaders.delete("content-type");
    socketHeaders.set("openai-beta", WEBSOCKET_BETA);
    const socketUrl = codexWebSocketUrl(httpUrl);
    const wire = this.#wire;
    const handshake = wire === undefined
      ? undefined
      : await beginCodexWebSocketHostOperation(wire);
    throwIfWebSocketAborted(signal);
    if (this.#closed) throw new Error("OpenAI Codex WebSocket transport is closed");
    const prepared = handshake === undefined
      ? undefined
      : await runCodexWebSocketHostHook(async () => {
          const intercepted = await handshake.intercept({
            url: socketUrl,
            method: "GET",
            headers: socketHeaders,
            transport: "websocket",
            phase: "handshake",
          }, signal);
          return {
            bodyChanged: intercepted.bodyChanged,
            url: intercepted.url,
            headers: new Headers(intercepted.headers),
          };
        });
    throwIfWebSocketAborted(signal);
    if (this.#closed) throw new Error("OpenAI Codex WebSocket transport is closed");
    if (prepared?.bodyChanged === true) {
      throw new TypeError("Provider wire WebSocket handshake cannot contain a body");
    }
    const effectiveSocketUrl = prepared?.url ?? socketUrl;
    const effectiveSocketHeaders = prepared?.headers ?? socketHeaders;
    const identity = sessionId === undefined
      ? undefined
      : codexSocketIdentity(effectiveSocketUrl, effectiveSocketHeaders);
    if (sessionId !== undefined) {
      const cached = identity === undefined ? undefined : this.#sessions.get(sessionId)?.get(identity);
      if (cached !== undefined) {
        if (cached.idleTimer !== undefined) clearTimeout(cached.idleTimer);
        delete cached.idleTimer;
        const expired = Date.now() - cached.createdAt >= WEBSOCKET_MAX_AGE_MS;
        if (!cached.busy && !expired && cached.socket.readyState === 1) {
          cached.busy = true;
          try {
            if (handshake !== undefined) {
              await runCodexWebSocketHostHook(() => handshake.observe({
                url: effectiveSocketUrl,
                status: 101,
                statusText: "Switching Protocols",
                headers: {},
                transport: "websocket",
                phase: "open",
              }, signal));
            }
            throwIfWebSocketAborted(signal);
            if (this.#closed) throw new Error("OpenAI Codex WebSocket transport is closed");
          } catch (error) {
            closeSocket(cached.socket, "handshake_observer_failed");
            this.#removeCached(sessionId, identity!, cached);
            throw error;
          }
          return this.#lease(sessionId, identity!, cached, true);
        }
        if (!cached.busy) {
          closeSocket(cached.socket, expired ? "connection_age_limit" : "connection_closed");
          this.#removeCached(sessionId, identity!, cached);
        }
      }
    }

    let socket: NetworkWebSocket;
    try {
      socket = this.#factory(effectiveSocketUrl, effectiveSocketHeaders);
      if (isProxy(socket)) {
        throw new CodexWebSocketNetworkError("OpenAI Codex WebSocket factory returned an invalid socket", {
          failureClass: "connect",
        });
      }
    } catch (error) {
      throw networkError(error, "OpenAI Codex WebSocket connection failed", "connect");
    }
    this.#pendingSockets.add(socket);
    try {
      await waitForWebSocketOpen(socket, signal, this.#connectTimeoutMs);
    } catch (error) {
      this.#pendingSockets.delete(socket);
      closeSocket(socket, "handshake_failed");
      throw networkError(error, "OpenAI Codex WebSocket connection failed", "connect");
    }
    if (signal.aborted) {
      this.#pendingSockets.delete(socket);
      closeSocket(socket, "aborted");
      throw webSocketAbortError(signal);
    }
    if (this.#closed) {
      this.#pendingSockets.delete(socket);
      closeSocket(socket, "runtime_disposed");
      throw new Error("OpenAI Codex WebSocket transport is closed");
    }
    try {
      if (handshake !== undefined) {
        await runCodexWebSocketHostHook(() => handshake.observe({
          url: effectiveSocketUrl,
          status: 101,
          statusText: "Switching Protocols",
          headers: {},
          transport: "websocket",
          phase: "open",
        }, signal));
      }
      throwIfWebSocketAborted(signal);
    } catch (error) {
      this.#pendingSockets.delete(socket);
      closeSocket(socket, "handshake_failed");
      throw error;
    }
    if (this.#closed) {
      this.#pendingSockets.delete(socket);
      closeSocket(socket, "runtime_disposed");
      throw new Error("OpenAI Codex WebSocket transport is closed");
    }
    this.#pendingSockets.delete(socket);
    const group = sessionId === undefined ? undefined : this.#sessions.get(sessionId);
    if (sessionId === undefined || identity === undefined || group?.has(identity) === true) {
      return {
        socket,
        reused: false,
        release: () => closeSocket(socket),
      };
    }
    const entry: CachedCodexSocket = { socket, busy: true, createdAt: Date.now() };
    const selectedGroup = group ?? new Map<string, CachedCodexSocket>();
    selectedGroup.set(identity, entry);
    this.#sessions.set(sessionId, selectedGroup);
    return this.#lease(sessionId, identity, entry, false);
  }

  #removeCached(sessionId: string, identity: string, expected: CachedCodexSocket): void {
    const group = this.#sessions.get(sessionId);
    if (group?.get(identity) !== expected) return;
    group.delete(identity);
    if (group.size === 0) this.#sessions.delete(sessionId);
  }

  #lease(
    sessionId: string,
    identity: string,
    entry: CachedCodexSocket,
    reused: boolean,
  ): AcquiredCodexSocket {
    let released = false;
    return {
      socket: entry.socket,
      entry,
      reused,
      release: (keep, continuation) => {
        if (released) return;
        released = true;
        if (!keep || entry.socket.readyState !== 1 || this.#sessions.get(sessionId)?.get(identity) !== entry) {
          closeSocket(entry.socket);
          this.#removeCached(sessionId, identity, entry);
          return;
        }
        entry.busy = false;
        if (continuation === undefined) delete entry.continuation;
        else entry.continuation = continuation;
        entry.idleTimer = setTimeout(() => {
          if (this.#sessions.get(sessionId)?.get(identity) !== entry || entry.busy) return;
          closeSocket(entry.socket, "idle_expired");
          this.#removeCached(sessionId, identity, entry);
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
    const mode = config.transport ?? "auto";
    const observer = (config as OpenAICodexResponsesConfig & OpenAICodexObservabilityOptions)[OPENAI_CODEX_TRANSPORT_OBSERVER];
    if (!(["sse", "websocket", "websocket-cached", "auto"] as const).includes(mode)) {
      throw new TypeError("OpenAI Codex transport must be sse, websocket, websocket-cached, or auto");
    }
    if ((mode === "websocket" || mode === "websocket-cached") && config.webSocket === undefined) {
      throw new TypeError(`OpenAI Codex ${mode} transport requires a WebSocket factory`);
    }
    const webSocketTransport = mode === "sse" || config.webSocket === undefined
      ? undefined
      : new CodexWebSocketTransport(config.webSocket!, mode, {
          connectTimeoutMs: transportTimeout(config.webSocketConnectTimeoutMs, DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS, "webSocketConnectTimeoutMs"),
          idleTimeoutMs: transportTimeout(config.webSocketIdleTimeoutMs, DEFAULT_WEBSOCKET_IDLE_TIMEOUT_MS, "webSocketIdleTimeoutMs"),
          ...(config.wire === undefined ? {} : { wire: config.wire }),
          ...(observer === undefined ? {} : { observer }),
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
        headers.set("openai-beta", SSE_BETA);
      },
      prepareHeaders: (headers, request) => {
        headers.set("x-codex-routing-hint", `model=${request.model}`);
        if (request.cacheRetention === "none") {
          headers.delete("session-id");
          headers.delete("session_id");
          headers.delete("x-session-id");
          headers.delete("x-client-request-id");
          headers.delete("x-session-affinity");
          return;
        }
        if (
          request.sessionId === undefined ||
          request.sessionId === ""
        ) return;
        const sessionId = openAIPromptCacheKey(request.sessionId);
        headers.set("session-id", sessionId);
        headers.set("x-client-request-id", sessionId);
      },
      buildBody: (request) => buildOpenAICodexResponsesBody(request, webSocketTransport !== undefined),
      streamEvents: (input: ResponsesEventStreamInput) => {
        if (webSocketTransport !== undefined) return webSocketTransport.stream(input);
        observeCodexTransport(observer, { type: "selected", transport: "sse", sessionFallbackUsed: false });
        return codexSseEvents(input);
      },
      listModels: async (signal) => {
        signal.throwIfAborted();
        return openAICodexModels();
      },
      stateful: false,
      retainResponseId: webSocketTransport !== undefined,
      promptCache: true,
      deferredToolLoading: true,
      supportsReasoningSummaries: false,
      reasoningTextVisibility: "provider_trace",
    });
    this.#webSocketTransport = webSocketTransport;
  }

  dispose(): void {
    this.#webSocketTransport?.dispose();
  }
}
