import { isJsonValue, type JsonValue } from "../core/json.js";
import type { ProviderId } from "../core/types.js";
import { stringifyProviderJson } from "./json.js";
import { assertSecureEndpoint, type FetchLike } from "./transport.js";

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

interface RegisteredInterceptor {
  token: symbol;
  interceptor: ProviderWireInterceptor;
}

/** Host-owned provider transport interception with ownership-safe registration. */
export class ProviderWireInterceptorRegistry implements ProviderWireTransportHost {
  readonly #interceptors = new Map<ProviderId, RegisteredInterceptor[]>();

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
    return {
      active: entries.length > 0,
      intercept: async (request, signal) => {
        let body = request.body === undefined ? undefined : structuredClone(request.body);
        const headers = new Headers(request.headers);
        let url = request.url;
        let bodyChanged = false;
        let headersChanged = false;
        let urlChanged = false;

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
        for (const entry of entries) {
          if (!this.#registered(provider, entry.token)) continue;
          const { interceptor } = entry;
          if (interceptor.observeResponse === undefined) continue;
          await interceptor.observeResponse({ provider, ...response, url: publicWireUrl(response.url) }, signal);
        }
      },
    };
  }

  #registered(provider: ProviderId, token: symbol): boolean {
    return this.#interceptors.get(provider)?.some((entry) => entry.token === token) === true;
  }
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
  return Object.fromEntries([...headers].filter(([name]) => !sensitiveWireName(name)));
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
