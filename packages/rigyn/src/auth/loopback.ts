import { createServer, type Server, type ServerResponse } from "node:http";

import { createOAuthState, createPkcePair } from "./pkce.js";
import { requestOAuthJson } from "./oauth-http.js";
import {
  oauthErrorCode,
  parseOAuthTokenResponse,
  type OAuthTokenResponse,
} from "./oauth-token.js";
import { defaultSecretRedactor } from "./redaction.js";

export type { OAuthTokenResponse } from "./oauth-token.js";

const RESERVED_AUTHORIZATION_PARAMETERS = new Set([
  "client_id",
  "client_secret",
  "code_challenge",
  "code_challenge_method",
  "redirect_uri",
  "response_type",
  "state",
]);

const RESERVED_TOKEN_PARAMETERS = new Set([
  "client_id",
  "client_secret",
  "code",
  "code_verifier",
  "grant_type",
  "redirect_uri",
]);

export interface AuthorizationCodeCallback {
  code: string;
  state: string;
}

export interface LoopbackAuthorizationSession {
  authorizationUrl: URL;
  redirectUri: string;
  verifier: string;
  state: string;
  waitForCallback(): Promise<AuthorizationCodeCallback>;
  cancel(reason?: Error): void;
}

export interface LoopbackAuthorizationOptions {
  authorizationEndpoint: string | URL;
  clientId: string;
  scopes: readonly string[];
  callbackPath?: string;
  port?: number;
  redirectHostname?: "127.0.0.1" | "localhost";
  timeoutMs?: number;
  extraParameters?: Readonly<Record<string, string>>;
}

function assertEndpoint(url: URL, label: string): void {
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new TypeError(`${label} must use HTTPS or an HTTP loopback address`);
  }
  if (url.username !== "" || url.password !== "") throw new TypeError(`${label} must not contain credentials`);
  if (url.hash !== "") throw new TypeError(`${label} must not contain a fragment`);
}

function writeResponse(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end(message);
}

async function listen(server: Server, requestedPort: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const failed = (error: Error): void => reject(error);
    server.once("error", failed);
    server.listen(requestedPort, "127.0.0.1", () => {
      server.off("error", failed);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Loopback authorization server did not expose a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

export async function createLoopbackAuthorization(
  options: LoopbackAuthorizationOptions,
): Promise<LoopbackAuthorizationSession> {
  const authorizationEndpoint = new URL(options.authorizationEndpoint);
  assertEndpoint(authorizationEndpoint, "Authorization endpoint");
  if (
    options.clientId.length === 0 ||
    /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(options.clientId) ||
    Buffer.byteLength(options.clientId, "utf8") > 4096
  ) throw new TypeError("clientId is invalid");
  if (
    options.scopes.length > 256 ||
    options.scopes.some((scope) => scope === "" || /[\s\0]/u.test(scope) || Buffer.byteLength(scope, "utf8") > 1024)
  ) throw new TypeError("OAuth scopes are invalid");
  const callbackPath = options.callbackPath ?? "/oauth/callback";
  if (
    !callbackPath.startsWith("/") ||
    callbackPath.includes("?") ||
    callbackPath.includes("#") ||
    /[\x00-\x1f\x7f\\]/u.test(callbackPath) ||
    Buffer.byteLength(callbackPath, "utf8") > 1024
  ) {
    throw new TypeError("callbackPath must be an absolute URL path");
  }
  const extraParameters = options.extraParameters ?? {};
  if (
    Object.keys(extraParameters).length > 64 ||
    Object.entries(extraParameters).some(([name, value]) =>
      !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/u.test(name) ||
      RESERVED_AUTHORIZATION_PARAMETERS.has(name.toLowerCase()) ||
      (/secret|password|token/iu.test(name) && name !== "id_token_add_organizations") ||
      /[\0\r\n]/u.test(value) ||
      Buffer.byteLength(value, "utf8") > 4096)
  ) throw new TypeError("OAuth authorization parameters are invalid");
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30 * 60_000) {
    throw new TypeError("timeoutMs must be an integer between 1 and 1800000");
  }
  const requestedPort = options.port ?? 0;
  if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new TypeError("port must be an integer between 0 and 65535");
  }
  const state = createOAuthState();
  const pkce = createPkcePair();
  let settle: ((value: AuthorizationCodeCallback) => void) | undefined;
  let fail: ((reason: unknown) => void) | undefined;
  let completed = false;
  let timeout: NodeJS.Timeout | undefined;

  const callback = new Promise<AuthorizationCodeCallback>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  void callback.catch(() => undefined);
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url === undefined) {
      writeResponse(response, 404, "Not found");
      return;
    }
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    if (requestUrl.pathname !== callbackPath) {
      writeResponse(response, 404, "Not found");
      return;
    }
    if (requestUrl.searchParams.get("state") !== state) {
      writeResponse(response, 400, "Invalid OAuth state");
      return;
    }
    const providerError = requestUrl.searchParams.get("error");
    if (providerError !== null) {
      writeResponse(response, 400, "Authorization was not completed");
      finish(() => fail?.(new Error(`OAuth authorization failed: ${oauthErrorCode(providerError, "authorization_failed")}`)));
      return;
    }
    const code = requestUrl.searchParams.get("code");
    if (
      code === null ||
      code.length === 0 ||
      Buffer.byteLength(code, "utf8") > 4096 ||
      /[\x00-\x1f\x7f]/u.test(code)
    ) {
      writeResponse(response, 400, "Missing authorization code");
      return;
    }
    writeResponse(response, 200, "Authorization complete. You can close this window.");
    finish(() => settle?.({ code, state }));
  });

  const finish = (operation: () => void): void => {
    if (completed) return;
    completed = true;
    if (timeout !== undefined) clearTimeout(timeout);
    server.close();
    operation();
  };
  server.on("error", (error) => finish(() => fail?.(error)));
  const port = await listen(server, requestedPort);
  const redirectHostname = options.redirectHostname ?? "127.0.0.1";
  const redirectUri = `http://${redirectHostname}:${port}${callbackPath}`;
  const authorizationUrl = new URL(authorizationEndpoint);
  for (const [name, value] of Object.entries(extraParameters)) {
    authorizationUrl.searchParams.set(name, value);
  }
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", options.clientId);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  if (options.scopes.length > 0) authorizationUrl.searchParams.set("scope", options.scopes.join(" "));
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", pkce.challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");

  timeout = setTimeout(
    () => finish(() => fail?.(new Error("OAuth loopback authorization timed out"))),
    timeoutMs,
  );
  timeout.unref();

  return {
    authorizationUrl,
    redirectUri,
    verifier: pkce.verifier,
    state,
    waitForCallback: () => callback,
    cancel: (reason = new Error("OAuth loopback authorization cancelled")) => {
      finish(() => fail?.(reason));
    },
  };
}

export async function exchangeAuthorizationCode(options: {
  tokenEndpoint: string | URL;
  clientId: string;
  code: string;
  redirectUri: string;
  verifier: string;
  extraParameters?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<OAuthTokenResponse> {
  const endpoint = new URL(options.tokenEndpoint);
  assertEndpoint(endpoint, "Token endpoint");
  if (
    options.clientId.length === 0 ||
    Buffer.byteLength(options.clientId, "utf8") > 4096 ||
    /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(options.clientId) ||
    options.code.length === 0 ||
    Buffer.byteLength(options.code, "utf8") > 4096 ||
    /[\x00-\x1f\x7f]/u.test(options.code) ||
    !/^[A-Za-z0-9._~-]{43,128}$/u.test(options.verifier)
  ) {
    throw new TypeError("OAuth clientId, code, or PKCE verifier is invalid");
  }
  if (Buffer.byteLength(options.redirectUri, "utf8") > 16 * 1024) {
    throw new TypeError("OAuth redirectUri is invalid");
  }
  let redirect: URL;
  try {
    redirect = new URL(options.redirectUri);
  } catch {
    throw new TypeError("OAuth redirectUri is invalid");
  }
  if (
    redirect.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1"].includes(redirect.hostname) ||
    redirect.port === "" ||
    redirect.username !== "" ||
    redirect.password !== "" ||
    redirect.search !== "" ||
    redirect.hash !== ""
  ) throw new TypeError("OAuth redirectUri must be an HTTP loopback URL with an explicit port");
  const extraParameters = options.extraParameters ?? {};
  if (
    Object.keys(extraParameters).length > 32 ||
    Object.entries(extraParameters).some(([name, value]) =>
      !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/u.test(name) ||
      RESERVED_TOKEN_PARAMETERS.has(name.toLowerCase()) ||
      /secret|password|token/iu.test(name) ||
      /[\x00-\x1f\x7f]/u.test(value) ||
      Buffer.byteLength(value, "utf8") > 4096)
  ) throw new TypeError("OAuth token exchange parameters are invalid");
  const body = new URLSearchParams(extraParameters);
  body.set("grant_type", "authorization_code");
  body.set("client_id", options.clientId);
  body.set("code", options.code);
  body.set("redirect_uri", options.redirectUri);
  body.set("code_verifier", options.verifier);
  const response = await requestOAuthJson(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  }, {
    label: "OAuth token endpoint",
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  if (!response.ok) {
    const code = oauthErrorCode(response.value.error, "token_exchange_failed");
    throw new Error(`OAuth token exchange failed (${response.status} ${code})`);
  }
  const token = parseOAuthTokenResponse(response.value, "OAuth token endpoint");
  defaultSecretRedactor.register(token.accessToken);
  defaultSecretRedactor.register(token.refreshToken);
  return token;
}
