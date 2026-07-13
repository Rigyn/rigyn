import { Agent, EnvHttpProxyAgent, fetch as undiciFetch, WebSocket, type Dispatcher } from "undici";

import { defaultSecretRedactor, type SecretRedactor } from "../auth/redaction.js";

const MAX_PROXY_URL_BYTES = 8 * 1024;
const MAX_NO_PROXY_BYTES = 32 * 1024;
const MAX_TIMEOUT_MS = 10 * 60_000;

export interface NetworkProxyOptions {
  http?: string | false;
  https?: string | false;
  all?: string | false;
  noProxy?: string | false;
}

export interface NetworkTransportOptions {
  environment?: NodeJS.ProcessEnv;
  proxy?: NetworkProxyOptions;
  connectTimeoutMs?: number;
  headersTimeoutMs?: number;
  bodyTimeoutMs?: number;
  redactor?: SecretRedactor;
}

export interface NetworkTransportInfo {
  proxied: boolean;
  httpProxy?: string;
  httpsProxy?: string;
  noProxyConfigured: boolean;
}

export interface NetworkTransport {
  readonly fetch: typeof fetch;
  readonly openWebSocket?: NetworkWebSocketFactory;
  readonly info: NetworkTransportInfo;
  close(): Promise<void>;
}

export type NetworkWebSocket = InstanceType<typeof WebSocket>;
export type NetworkWebSocketFactory = (url: string | URL, headers: HeadersInit) => NetworkWebSocket;

export function createNetworkTransport(options: NetworkTransportOptions = {}): NetworkTransport {
  const environment = options.environment ?? process.env;
  const proxy = options.proxy ?? {};
  const all = resolveProxyValue(proxy.all, environment.all_proxy, environment.ALL_PROXY);
  const http = normalizeProxyUrl(resolveProxyValue(proxy.http, environment.http_proxy, environment.HTTP_PROXY) ?? all, "HTTP proxy", options.redactor);
  const https = normalizeProxyUrl(resolveProxyValue(proxy.https, environment.https_proxy, environment.HTTPS_PROXY) ?? all, "HTTPS proxy", options.redactor);
  const noProxy = normalizeNoProxy(resolveProxyValue(proxy.noProxy, environment.no_proxy, environment.NO_PROXY));
  const dispatcherOptions = {
    connectTimeout: timeout(options.connectTimeoutMs, 10_000, "connectTimeoutMs"),
    headersTimeout: timeout(options.headersTimeoutMs, 300_000, "headersTimeoutMs"),
    bodyTimeout: timeout(options.bodyTimeoutMs, 300_000, "bodyTimeoutMs"),
  };
  const dispatcher: Dispatcher = http !== undefined || https !== undefined
    ? new EnvHttpProxyAgent({
        ...dispatcherOptions,
        // Empty values prevent the agent from consulting process.env after we
        // have resolved the caller's scoped environment and explicit opt-outs.
        httpProxy: http ?? "",
        httpsProxy: https ?? "",
        noProxy: noProxy ?? "",
      })
    : new Agent(dispatcherOptions);
  let closed = false;
  const transportFetch: typeof fetch = async (input, init) => {
    if (closed) throw new Error("Network transport is closed");
    return await undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      { ...init, dispatcher } as Parameters<typeof undiciFetch>[1],
    ) as unknown as Response;
  };
  const openWebSocket: NetworkWebSocketFactory = (url, headers) => {
    if (closed) throw new Error("Network transport is closed");
    return new WebSocket(url, { headers: [...new Headers(headers).entries()], dispatcher });
  };
  const effectiveHttps = https ?? http;
  return {
    fetch: transportFetch,
    openWebSocket,
    info: {
      proxied: http !== undefined || effectiveHttps !== undefined,
      ...(http === undefined ? {} : { httpProxy: publicProxyOrigin(http) }),
      ...(effectiveHttps === undefined ? {} : { httpsProxy: publicProxyOrigin(effectiveHttps) }),
      noProxyConfigured: noProxy !== undefined && noProxy !== "",
    },
    async close() {
      if (closed) return;
      closed = true;
      await dispatcher.close();
    },
  };
}

function resolveProxyValue(
  explicit: string | false | undefined,
  lowercase: string | undefined,
  uppercase: string | undefined,
): string | undefined {
  if (explicit === false) return undefined;
  if (explicit !== undefined) return explicit;
  return nonEmpty(lowercase) ?? nonEmpty(uppercase);
}

function normalizeProxyUrl(value: string | undefined, label: string, redactor = defaultSecretRedactor): string | undefined {
  const selected = nonEmpty(value);
  if (selected === undefined) return undefined;
  if (Buffer.byteLength(selected, "utf8") > MAX_PROXY_URL_BYTES || /[\u0000-\u001f\u007f]/u.test(selected)) {
    throw new TypeError(`${label} is invalid or exceeds ${MAX_PROXY_URL_BYTES} bytes`);
  }
  let url: URL;
  try {
    url = new URL(selected);
  } catch {
    throw new TypeError(`${label} must be an absolute HTTP or HTTPS URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`${label} protocol ${url.protocol || "unknown"} is unsupported; SOCKS and PAC proxies require an explicit transport extension`);
  }
  if (url.hostname === "" || (url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "") {
    throw new TypeError(`${label} must contain only an HTTP(S) origin and optional credentials`);
  }
  redactor.register(selected);
  if (url.username !== "") redactor.register(decodeURIComponent(url.username));
  if (url.password !== "") redactor.register(decodeURIComponent(url.password));
  return url.toString();
}

function normalizeNoProxy(value: string | undefined): string | undefined {
  const selected = nonEmpty(value);
  if (selected === undefined) return undefined;
  if (Buffer.byteLength(selected, "utf8") > MAX_NO_PROXY_BYTES || /[\u0000-\u001f\u007f]/u.test(selected)) {
    throw new TypeError(`NO_PROXY is invalid or exceeds ${MAX_NO_PROXY_BYTES} bytes`);
  }
  return selected;
}

function publicProxyOrigin(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.host}`;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function timeout(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > MAX_TIMEOUT_MS) {
    throw new RangeError(`${label} must be an integer from 1 through ${MAX_TIMEOUT_MS}`);
  }
  return selected;
}
