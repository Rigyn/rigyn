import { AsyncLocalStorage } from "node:async_hooks";
import { isJsonValue, type JsonValue } from "../core/json.js";
import type { ProviderId } from "../core/types.js";
import { stringifyProviderJson } from "./json.js";
import { assertSecureEndpoint, type FetchLike } from "./transport.js";

const MAX_LIFECYCLE_HEADER_PATCHES = 128;
const MAX_LIFECYCLE_HEADER_NAME_BYTES = 256;
const MAX_LIFECYCLE_HEADER_VALUE_BYTES = 64 * 1024;
const MAX_LIFECYCLE_HEADER_PATCH_BYTES = 256 * 1024;
const MAX_LIFECYCLE_BODY_PATCH_BYTES = 16 * 1024 * 1024;
const MAX_LIFECYCLE_SCOPE_FIELD_BYTES = 1_024;

export interface ProviderWireRequest {
  provider: ProviderId;
  /** Credential-bearing URL parameters are redacted. */
  url: string;
  method: string;
  /** Credential-bearing request headers are omitted. */
  headers: Readonly<Record<string, string>>;
  /** Present only when the request contains a JSON payload. */
  body?: JsonValue;
  /** Omitted for ordinary HTTP requests. */
  transport?: "websocket";
  /** Identifies the WebSocket operation represented by this request. */
  phase?: "handshake" | "frame";
}

export interface ProviderWireRequestPatch {
  body?: JsonValue;
  /** A null value removes the header. */
  headers?: Readonly<Record<string, string | null>>;
  /** Replaces the complete request URL. Use baseUrl to preserve private query values. */
  url?: string;
  /** Prepends this secure endpoint path to the original request path while preserving its private query values. */
  baseUrl?: string;
}

export interface ProviderWireResponse {
  provider: ProviderId;
  url: string;
  status: number;
  statusText: string;
  /** Complete response headers; the response body is never exposed here. */
  headers: Readonly<Record<string, string>>;
  /** Omitted for ordinary HTTP responses. */
  transport?: "websocket";
  /** WebSocket handshakes expose no response headers in the host transport. */
  phase?: "open" | "frame";
  /** Bounded metadata for an incoming frame; frame contents remain private. */
  frame?: Readonly<{
    direction: "receive";
    bytes: number;
    type?: string;
  }>;
}

export interface ProviderWireInterceptor {
  interceptRequest?(
    request: ProviderWireRequest,
    signal: AbortSignal,
  ): ProviderWireRequestPatch | void | Promise<ProviderWireRequestPatch | void>;
  observeResponse?(response: ProviderWireResponse, signal: AbortSignal): void | Promise<void>;
}

/** Identifies the agent turn that owns a provider transport operation. */
export interface ProviderWireLifecycleScope {
  readonly threadId: string;
  readonly runId: string;
  /** Exact branch when the owning host can resolve it. */
  readonly branch?: string;
  readonly step: number;
}

interface ProviderWireLifecycleRequestBase extends ProviderWireLifecycleScope {
  readonly provider: ProviderId;
  /** Credential-bearing URL parameters are redacted. */
  readonly url: string;
  readonly method: string;
  /** Complete assembled request headers for trusted direct hooks. */
  readonly headers: Readonly<Record<string, string>>;
  /** Omitted for ordinary HTTP requests. */
  readonly transport?: "websocket";
  readonly phase?: "handshake" | "frame";
}

export interface ProviderWireBeforeHeaders extends ProviderWireLifecycleRequestBase {}

export interface ProviderWireBeforeRequest extends ProviderWireLifecycleRequestBase {
  /** A detached copy of the provider-specific JSON request payload. */
  readonly body: JsonValue;
}

export interface ProviderWireLifecycleHeadersPatch {
  /** A string sets a header and null deletes it. */
  readonly headers: Readonly<Record<string, string | null>>;
}

export interface ProviderWireLifecycleBodyPatch {
  /** Replaces the complete provider-specific JSON request payload. */
  readonly body: JsonValue;
}

export interface ProviderWireAfterResponse extends ProviderWireLifecycleScope {
  readonly provider: ProviderId;
  /** Credential-bearing URL parameters are redacted. */
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  /** Complete normalized response headers for trusted direct hooks. */
  readonly headers: Readonly<Record<string, string>>;
  readonly transport?: "websocket";
  readonly phase?: "open" | "frame";
  /** Bounded metadata only; incoming WebSocket frame contents are never exposed. */
  readonly frame?: Readonly<{
    direction: "receive";
    bytes: number;
    type?: string;
  }>;
}

/** Run-scoped transport lifecycle callbacks. Callbacks execute in registration order. */
export interface ProviderWireLifecycleObserver {
  beforeHeaders?(
    request: ProviderWireBeforeHeaders,
    signal: AbortSignal,
  ): ProviderWireLifecycleHeadersPatch | void | Promise<ProviderWireLifecycleHeadersPatch | void>;
  beforeRequest?(
    request: ProviderWireBeforeRequest,
    signal: AbortSignal,
  ): ProviderWireLifecycleBodyPatch | void | Promise<ProviderWireLifecycleBodyPatch | void>;
  afterResponse?(response: ProviderWireAfterResponse, signal: AbortSignal): void | Promise<void>;
}

export interface ProviderWireFetchHost {
  wrapFetch(provider: ProviderId, fetchImplementation: FetchLike): FetchLike;
}

export interface ProviderWireOperationRequest {
  url: string;
  method: string;
  headers: Headers;
  body?: JsonValue;
  transport?: "websocket";
  phase?: "handshake" | "frame";
}

export interface ProviderWirePreparedRequest {
  url: string;
  headers: Headers;
  body?: JsonValue;
  bodyChanged: boolean;
  headersChanged: boolean;
  urlChanged: boolean;
}

export interface ProviderWireOperation {
  readonly active: boolean;
  intercept(request: ProviderWireOperationRequest, signal: AbortSignal): Promise<ProviderWirePreparedRequest>;
  observe(response: Omit<ProviderWireResponse, "provider">, signal: AbortSignal): Promise<void>;
}

export interface ProviderWireTransportHost extends ProviderWireFetchHost {
  begin(provider: ProviderId): ProviderWireOperation;
}

export interface ProviderWireLifecycleHost {
  registerLifecycle(observer: ProviderWireLifecycleObserver): () => void;
  withScope<T>(scope: ProviderWireLifecycleScope, operation: () => T): T;
}

interface RegisteredInterceptor {
  token: symbol;
  interceptor: ProviderWireInterceptor;
}

interface RegisteredLifecycleObserver {
  token: symbol;
  observer: ProviderWireLifecycleObserver;
}

/** Host-owned provider transport interception with ownership-safe registration. */
export class ProviderWireInterceptorRegistry implements ProviderWireTransportHost, ProviderWireLifecycleHost {
  readonly #interceptors = new Map<ProviderId, RegisteredInterceptor[]>();
  readonly #lifecycleObservers: RegisteredLifecycleObserver[] = [];
  readonly #scope = new AsyncLocalStorage<Readonly<ProviderWireLifecycleScope>>();

  register(provider: ProviderId, interceptor: ProviderWireInterceptor): () => void {
    const token = Symbol(provider);
    const entries = this.#interceptors.get(provider) ?? [];
    entries.push({ token, interceptor });
    this.#interceptors.set(provider, entries);

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const current = this.#interceptors.get(provider);
      if (current === undefined) return;
      const index = current.findIndex((entry) => entry.token === token);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) this.#interceptors.delete(provider);
    };
  }

  registerLifecycle(observer: ProviderWireLifecycleObserver): () => void {
    if (observer === null || typeof observer !== "object" || Array.isArray(observer)) {
      throw new TypeError("Provider wire lifecycle observer must be an object");
    }
    if (
      observer.beforeHeaders !== undefined && typeof observer.beforeHeaders !== "function" ||
      observer.beforeRequest !== undefined && typeof observer.beforeRequest !== "function" ||
      observer.afterResponse !== undefined && typeof observer.afterResponse !== "function"
    ) {
      throw new TypeError("Provider wire lifecycle observer callbacks must be functions");
    }
    const token = Symbol("provider-wire-lifecycle");
    this.#lifecycleObservers.push({ token, observer });
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const index = this.#lifecycleObservers.findIndex((entry) => entry.token === token);
      if (index >= 0) this.#lifecycleObservers.splice(index, 1);
    };
  }

  withScope<T>(scope: ProviderWireLifecycleScope, operation: () => T): T {
    if (typeof operation !== "function") throw new TypeError("Provider wire scoped operation must be a function");
    return this.#scope.run(normalizeLifecycleScope(scope), operation);
  }

  wrapFetch(provider: ProviderId, fetchImplementation: FetchLike): FetchLike {
    return async (input, init) => {
      const operation = this.begin(provider);
      if (!operation.active) return await fetchImplementation(input, init);
      const request = new Request(input, init);
      const body = await requestJsonBody(request);
      const prepared = await operation.intercept({
        url: request.url,
        method: request.method,
        headers: request.headers,
        ...(body === undefined ? {} : { body }),
      }, request.signal);
      request.signal.throwIfAborted();
      if (prepared.bodyChanged) prepared.headers.delete("content-length");
      const outgoing = prepared.bodyChanged || prepared.headersChanged
        || prepared.urlChanged
        ? new Request(prepared.url, {
            method: request.method,
            headers: prepared.headers,
            signal: request.signal,
            redirect: request.redirect,
            ...(prepared.bodyChanged ? { body: stringifyProviderJson(prepared.body!) } : {}),
            ...(!prepared.bodyChanged && request.body !== null ? { body: request.body, duplex: "half" } : {}),
          })
        : request;
      const response = await fetchImplementation(outgoing);
      await operation.observe({
        url: response.url || outgoing.url,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
      }, request.signal);
      return response;
    };
  }

  begin(provider: ProviderId): ProviderWireOperation {
    const entries = [...(this.#interceptors.get(provider) ?? [])];
    const scope = this.#scope.getStore();
    const lifecycleEntries = scope === undefined ? [] : [...this.#lifecycleObservers];
    return {
      active: entries.length > 0 || lifecycleEntries.length > 0,
      intercept: async (request, signal) => {
        let body = request.body === undefined ? undefined : structuredClone(request.body);
        const headers = new Headers(request.headers);
        let url = request.url;
        let bodyChanged = false;
        let headersChanged = false;
        let urlChanged = false;

        if (scope !== undefined) {
          for (const entry of lifecycleEntries) {
            if (!this.#lifecycleRegistered(entry.token)) continue;
            const { beforeHeaders } = entry.observer;
            if (beforeHeaders === undefined) continue;
            signal.throwIfAborted();
            const patch = await beforeHeaders(lifecycleRequest({
              scope,
              provider,
              request,
              headers,
            }), signal);
            signal.throwIfAborted();
            if (patch === undefined) continue;
            applyLifecycleHeadersPatch(patch, headers, () => { headersChanged = true; });
          }

          if (body !== undefined) {
            for (const entry of lifecycleEntries) {
              if (!this.#lifecycleRegistered(entry.token)) continue;
              const { beforeRequest } = entry.observer;
              if (beforeRequest === undefined) continue;
              signal.throwIfAborted();
              const patch = await beforeRequest({
                ...lifecycleRequest({ scope, provider, request, headers }),
                body: structuredClone(body),
              }, signal);
              signal.throwIfAborted();
              if (patch === undefined) continue;
              body = lifecycleBodyPatch(patch);
              bodyChanged = true;
            }
          }
        }

        for (const entry of entries) {
          if (!this.#registered(provider, entry.token)) continue;
          const { interceptor } = entry;
          signal.throwIfAborted();
          if (interceptor.interceptRequest === undefined) continue;
          const patch = await interceptor.interceptRequest({
            provider,
            url: publicWireUrl(request.url),
            method: request.method,
            headers: publicRequestHeaders(headers),
            ...(body === undefined ? {} : { body: structuredClone(body) }),
            ...(request.transport === undefined ? {} : { transport: request.transport }),
            ...(request.phase === undefined ? {} : { phase: request.phase }),
          }, signal);
          if (patch === undefined) continue;
          if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
            throw new TypeError("Provider wire request patch must be an object");
          }
          if (Object.prototype.hasOwnProperty.call(patch, "body")) {
            if (!isJsonValue(patch.body)) throw new TypeError("Provider wire request body patch must be JSON");
            body = structuredClone(patch.body);
            bodyChanged = true;
          }
          if (patch.url !== undefined && patch.baseUrl !== undefined) {
            throw new TypeError("Provider wire request patch cannot set both url and baseUrl");
          }
          if (patch.url !== undefined || patch.baseUrl !== undefined) {
            if (request.transport === "websocket" && request.phase === "frame") {
              throw new TypeError("Provider wire WebSocket frame cannot change its URL");
            }
            const selected = patch.url === undefined
              ? rebaseProviderUrl(url, patch.baseUrl!)
              : secureProviderUrl(patch.url, "Provider wire request URL");
            if (selected !== url) {
              url = selected;
              urlChanged = true;
            }
          }
          if (patch.headers !== undefined) {
            if (patch.headers === null || typeof patch.headers !== "object" || Array.isArray(patch.headers)) {
              throw new TypeError("Provider wire request header patch must be an object");
            }
            for (const [name, value] of Object.entries(patch.headers)) {
              if (value === null) {
                if (headers.has(name)) {
                  headers.delete(name);
                  headersChanged = true;
                }
              } else if (typeof value === "string") {
                if (headers.get(name) !== value) {
                  headers.set(name, value);
                  headersChanged = true;
                }
              } else throw new TypeError("Provider wire request header values must be strings or null");
            }
          }
        }

        signal.throwIfAborted();
        return {
          url,
          headers,
          ...(body === undefined ? {} : { body }),
          bodyChanged,
          headersChanged,
          urlChanged,
        };
      },
      observe: async (response, signal) => {
        if (scope !== undefined) {
          for (const entry of lifecycleEntries) {
            if (!this.#lifecycleRegistered(entry.token)) continue;
            const { afterResponse } = entry.observer;
            if (afterResponse === undefined) continue;
            signal.throwIfAborted();
            await afterResponse(lifecycleResponse(scope, provider, response), signal);
            signal.throwIfAborted();
          }
        }
        for (const entry of entries) {
          if (!this.#registered(provider, entry.token)) continue;
          const { interceptor } = entry;
          if (interceptor.observeResponse === undefined) continue;
          signal.throwIfAborted();
          await interceptor.observeResponse({ provider, ...response, url: publicWireUrl(response.url) }, signal);
          signal.throwIfAborted();
        }
      },
    };
  }

  #registered(provider: ProviderId, token: symbol): boolean {
    return this.#interceptors.get(provider)?.some((entry) => entry.token === token) === true;
  }

  #lifecycleRegistered(token: symbol): boolean {
    return this.#lifecycleObservers.some((entry) => entry.token === token);
  }
}

function normalizeLifecycleScope(scope: ProviderWireLifecycleScope): Readonly<ProviderWireLifecycleScope> {
  if (scope === null || typeof scope !== "object" || Array.isArray(scope)) {
    throw new TypeError("Provider wire lifecycle scope must be an object");
  }
  const threadId = lifecycleScopeField(scope.threadId, "threadId");
  const runId = lifecycleScopeField(scope.runId, "runId");
  const branch = scope.branch === undefined ? undefined : lifecycleScopeField(scope.branch, "branch");
  if (!Number.isSafeInteger(scope.step) || scope.step < 0) {
    throw new TypeError("Provider wire lifecycle scope step must be a non-negative safe integer");
  }
  return Object.freeze({
    threadId,
    runId,
    ...(branch === undefined ? {} : { branch }),
    step: scope.step,
  });
}

function lifecycleScopeField(value: string, name: string): string {
  if (
    typeof value !== "string" || value.trim() === "" || value.includes("\0") || /[\r\n]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_LIFECYCLE_SCOPE_FIELD_BYTES
  ) {
    throw new TypeError(`Provider wire lifecycle scope ${name} must be a non-empty single-line string no larger than ${MAX_LIFECYCLE_SCOPE_FIELD_BYTES} bytes`);
  }
  return value;
}

function lifecycleRequest(input: {
  scope: Readonly<ProviderWireLifecycleScope>;
  provider: ProviderId;
  request: ProviderWireOperationRequest;
  headers: Headers;
}): ProviderWireBeforeHeaders {
  return {
    ...input.scope,
    provider: input.provider,
    url: publicWireUrl(input.request.url),
    method: input.request.method,
    headers: completeWireHeaders(input.headers),
    ...(input.request.transport === undefined ? {} : { transport: input.request.transport }),
    ...(input.request.phase === undefined ? {} : { phase: input.request.phase }),
  };
}

function applyLifecycleHeadersPatch(
  patch: ProviderWireLifecycleHeadersPatch,
  headers: Headers,
  changed: () => void,
): void {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    throw new TypeError("Provider wire lifecycle headers patch must be an object");
  }
  if (!Object.prototype.hasOwnProperty.call(patch, "headers")) {
    throw new TypeError("Provider wire lifecycle headers patch must contain headers");
  }
  const selected: unknown = patch.headers;
  if (selected === null || typeof selected !== "object" || Array.isArray(selected)) {
    throw new TypeError("Provider wire lifecycle header values must be an object");
  }
  const entries = Object.entries(selected as Record<string, unknown>);
  if (entries.length > MAX_LIFECYCLE_HEADER_PATCHES) {
    throw new TypeError(`Provider wire lifecycle header patch may contain at most ${MAX_LIFECYCLE_HEADER_PATCHES} entries`);
  }
  let totalBytes = 0;
  for (const [name, value] of entries) {
    const nameBytes = Buffer.byteLength(name, "utf8");
    if (nameBytes === 0 || nameBytes > MAX_LIFECYCLE_HEADER_NAME_BYTES) {
      throw new TypeError(`Provider wire lifecycle header names must be no larger than ${MAX_LIFECYCLE_HEADER_NAME_BYTES} bytes`);
    }
    if (value !== null && typeof value !== "string") {
      throw new TypeError("Provider wire lifecycle header values must be strings or null");
    }
    const valueBytes = value === null ? 0 : Buffer.byteLength(value, "utf8");
    if (valueBytes > MAX_LIFECYCLE_HEADER_VALUE_BYTES) {
      throw new TypeError(`Provider wire lifecycle header values must be no larger than ${MAX_LIFECYCLE_HEADER_VALUE_BYTES} bytes`);
    }
    totalBytes += nameBytes + valueBytes;
    if (totalBytes > MAX_LIFECYCLE_HEADER_PATCH_BYTES) {
      throw new TypeError(`Provider wire lifecycle header patch must be no larger than ${MAX_LIFECYCLE_HEADER_PATCH_BYTES} bytes`);
    }
    if (value === null) {
      if (headers.has(name)) {
        headers.delete(name);
        changed();
      }
    } else if (headers.get(name) !== value) {
      headers.set(name, value);
      changed();
    }
  }
}

function lifecycleBodyPatch(patch: ProviderWireLifecycleBodyPatch): JsonValue {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    throw new TypeError("Provider wire lifecycle body patch must be an object");
  }
  if (!Object.prototype.hasOwnProperty.call(patch, "body") || !isJsonValue(patch.body)) {
    throw new TypeError("Provider wire lifecycle body patch must contain JSON body");
  }
  const serialized = stringifyProviderJson(patch.body);
  if (Buffer.byteLength(serialized, "utf8") > MAX_LIFECYCLE_BODY_PATCH_BYTES) {
    throw new TypeError(`Provider wire lifecycle body patch must be no larger than ${MAX_LIFECYCLE_BODY_PATCH_BYTES} bytes`);
  }
  return structuredClone(patch.body);
}

function lifecycleResponse(
  scope: Readonly<ProviderWireLifecycleScope>,
  provider: ProviderId,
  response: Omit<ProviderWireResponse, "provider">,
): ProviderWireAfterResponse {
  return {
    ...scope,
    provider,
    url: publicWireUrl(response.url),
    status: response.status,
    statusText: response.statusText,
    headers: completeWireHeaders(new Headers(response.headers)),
    ...(response.transport === undefined ? {} : { transport: response.transport }),
    ...(response.phase === undefined ? {} : { phase: response.phase }),
    ...(response.frame === undefined ? {} : { frame: Object.freeze({ ...response.frame }) }),
  };
}

function secureProviderUrl(value: string, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  assertSecureEndpoint(value, label);
  const selected = new URL(value);
  if (selected.hash !== "") throw new TypeError(`${label} must not contain a fragment`);
  return selected.toString();
}

function rebaseProviderUrl(value: string, baseUrl: string): string {
  const base = new URL(secureProviderUrl(baseUrl, "Provider wire base URL"));
  if (base.search !== "") throw new TypeError("Provider wire base URL must not contain query parameters");
  const original = new URL(value);
  const prefix = base.pathname.replace(/\/$/u, "");
  const suffix = original.pathname.startsWith("/") ? original.pathname : `/${original.pathname}`;
  base.pathname = `${prefix}${suffix}` || "/";
  base.search = original.search;
  return base.toString();
}

async function requestJsonBody(request: Request): Promise<JsonValue | undefined> {
  if (request.body === null) return undefined;
  const contentType = request.headers.get("content-type")?.toLocaleLowerCase("en-US");
  if (contentType !== undefined && !contentType.includes("/json") && !contentType.includes("+json")) {
    return undefined;
  }
  const text = await request.clone().text();
  if (text === "") return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isJsonValue(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function publicRequestHeaders(headers: Headers): Readonly<Record<string, string>> {
  return publicWireHeaders(headers);
}

function publicWireHeaders(headers: Headers): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(
    [...headers]
      .filter(([name]) => !sensitiveWireName(name))
      .sort(([left], [right]) => left.localeCompare(right, "en-US")),
  ));
}

function completeWireHeaders(headers: Headers): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(
    [...headers].sort(([left], [right]) => left.localeCompare(right, "en-US")),
  ));
}

function publicWireUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  for (const name of [...url.searchParams.keys()]) {
    if (sensitiveWireName(name)) url.searchParams.set(name, "[redacted]");
  }
  return url.toString();
}

function sensitiveWireName(value: string): boolean {
  const normalized = value.toLocaleLowerCase("en-US");
  return ["auth", "key", "password", "passwd", "sig"].includes(normalized) ||
    /authorization|api[-_]?key|account[-_]?id|token|secret|credential|cookie|signature/iu.test(normalized);
}
