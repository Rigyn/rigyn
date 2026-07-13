import {
  createLoopbackAuthorization,
  type AuthorizationCodeCallback,
  type LoopbackAuthorizationSession,
} from "./loopback.js";
import { requestOAuthJson } from "./oauth-http.js";
import { oauthErrorCode, oauthTokenExpiresAt, parseOAuthTokenResponse } from "./oauth-token.js";
import { createOAuthState, createPkcePair } from "./pkce.js";
import { defaultSecretRedactor } from "./redaction.js";
import type { OAuthRefreshResult } from "./refresh.js";
import type { OAuthCredential } from "./types.js";

export const ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const ANTHROPIC_OAUTH_AUTHORIZATION_ENDPOINT = "https://claude.ai/oauth/authorize";
export const ANTHROPIC_OAUTH_TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
export const ANTHROPIC_OAUTH_CALLBACK_PORT = 53_692;
export const ANTHROPIC_OAUTH_CALLBACK_PATH = "/callback";
export const ANTHROPIC_OAUTH_SCOPES = Object.freeze([
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
]);

const AUTHORIZATION_TIMEOUT_MS = 15 * 60_000;

export interface AnthropicAuthorizationOptions {
  showAuthorization(input: { url: URL }): void | Promise<void>;
  openUrl?(url: URL): void | Promise<void>;
  requestManualAuthorization?(
    input: { authorizationUrl: URL; redirectUri: string; state: string },
    signal: AbortSignal,
  ): Promise<string | undefined>;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  now?: () => number;
}

function validText(value: unknown, label: string, maximum = 4096): string {
  if (
    typeof value !== "string" || value === "" || Buffer.byteLength(value, "utf8") > maximum ||
    /[\x00-\x1f\x7f]/u.test(value)
  ) throw new Error(`Anthropic OAuth ${label} is invalid`);
  return value;
}

function manualCallback(value: string, expected: { state: string; redirectUri: string }): AuthorizationCodeCallback {
  const input = value.trim();
  if (input === "" || Buffer.byteLength(input, "utf8") > 16 * 1024) {
    throw new Error("Anthropic OAuth callback is empty or too large");
  }
  let code: string | undefined;
  let state: string | undefined;
  try {
    const callback = new URL(input);
    const redirect = new URL(expected.redirectUri);
    if (
      callback.protocol !== redirect.protocol || callback.hostname !== redirect.hostname ||
      callback.port !== redirect.port || callback.pathname !== redirect.pathname ||
      callback.username !== "" || callback.password !== ""
    ) throw new Error("Anthropic OAuth callback does not match the local redirect URL");
    const providerError = callback.searchParams.get("error");
    if (providerError !== null) {
      throw new Error(`Anthropic OAuth failed: ${oauthErrorCode(providerError, "authorization_failed")}`);
    }
    code = callback.searchParams.get("code") ?? undefined;
    state = callback.searchParams.get("state") ?? undefined;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Anthropic OAuth")) throw error;
    const hash = input.lastIndexOf("#");
    code = hash < 0 ? input : input.slice(0, hash);
    state = hash < 0 ? expected.state : input.slice(hash + 1);
  }
  if (state !== expected.state) throw new Error("Anthropic OAuth state mismatch");
  return { code: validText(code, "authorization code"), state };
}

function manualSession(): LoopbackAuthorizationSession {
  const state = createOAuthState();
  const pkce = createPkcePair();
  const redirectUri = `http://localhost:${ANTHROPIC_OAUTH_CALLBACK_PORT}${ANTHROPIC_OAUTH_CALLBACK_PATH}`;
  const authorizationUrl = new URL(ANTHROPIC_OAUTH_AUTHORIZATION_ENDPOINT);
  authorizationUrl.searchParams.set("code", "true");
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", ANTHROPIC_OAUTH_CLIENT_ID);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("scope", ANTHROPIC_OAUTH_SCOPES.join(" "));
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", pkce.challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  return {
    authorizationUrl,
    redirectUri,
    state,
    verifier: pkce.verifier,
    waitForCallback: () => new Promise<never>(() => undefined),
    cancel: () => undefined,
  };
}

function addressInUse(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error &&
    (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}

async function authorizationSession(manualAvailable: boolean): Promise<LoopbackAuthorizationSession> {
  try {
    return await createLoopbackAuthorization({
      authorizationEndpoint: ANTHROPIC_OAUTH_AUTHORIZATION_ENDPOINT,
      clientId: ANTHROPIC_OAUTH_CLIENT_ID,
      scopes: ANTHROPIC_OAUTH_SCOPES,
      callbackPath: ANTHROPIC_OAUTH_CALLBACK_PATH,
      port: ANTHROPIC_OAUTH_CALLBACK_PORT,
      redirectHostname: "localhost",
      timeoutMs: AUTHORIZATION_TIMEOUT_MS,
      extraParameters: { code: "true" },
    });
  } catch (error) {
    if (!manualAvailable || !addressInUse(error)) throw error;
    return manualSession();
  }
}

async function exchange(
  callback: AuthorizationCodeCallback,
  session: Pick<LoopbackAuthorizationSession, "redirectUri" | "verifier">,
  options: Pick<AnthropicAuthorizationOptions, "fetch" | "signal" | "now">,
): Promise<OAuthCredential> {
  const response = await requestOAuthJson(ANTHROPIC_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      code: callback.code,
      state: callback.state,
      redirect_uri: session.redirectUri,
      code_verifier: session.verifier,
    }),
  }, {
    label: "Anthropic OAuth token endpoint",
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!response.ok) {
    throw new Error(`Anthropic OAuth token exchange failed (${response.status} ${oauthErrorCode(response.value.error, "token_exchange_failed")})`);
  }
  const token = parseOAuthTokenResponse(response.value, "Anthropic OAuth token endpoint");
  if (token.refreshToken === undefined) throw new Error("Anthropic OAuth response omitted its refresh token");
  defaultSecretRedactor.register(token.accessToken);
  defaultSecretRedactor.register(token.refreshToken);
  return {
    kind: "oauth",
    provider: "anthropic",
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: oauthTokenExpiresAt(token, (options.now ?? Date.now)()),
    tokenType: token.tokenType,
    scopes: token.scope?.split(" ").filter(Boolean) ?? [...ANTHROPIC_OAUTH_SCOPES],
    tokenEndpoint: ANTHROPIC_OAUTH_TOKEN_ENDPOINT,
    clientId: ANTHROPIC_OAUTH_CLIENT_ID,
  };
}

export async function authorizeAnthropic(options: AnthropicAuthorizationOptions): Promise<OAuthCredential> {
  options.signal?.throwIfAborted();
  const session = await authorizationSession(options.requestManualAuthorization !== undefined);
  const cancel = (): void => session.cancel(
    options.signal?.reason instanceof Error ? options.signal.reason : new Error("Anthropic OAuth login cancelled"),
  );
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    await options.showAuthorization({ url: session.authorizationUrl });
    await options.openUrl?.(session.authorizationUrl);
    const manualAbort = new AbortController();
    const manualSignal = options.signal === undefined
      ? manualAbort.signal
      : AbortSignal.any([manualAbort.signal, options.signal]);
    const browser = session.waitForCallback().then((value) => ({ source: "browser" as const, value }));
    const manual = options.requestManualAuthorization === undefined
      ? new Promise<never>(() => undefined)
      : options.requestManualAuthorization({
          authorizationUrl: session.authorizationUrl,
          redirectUri: session.redirectUri,
          state: session.state,
        }, manualSignal).then((value) => value === undefined
          ? new Promise<never>(() => undefined)
          : { source: "manual" as const, value: manualCallback(value, session) });
    let selected: Awaited<typeof browser> | Awaited<typeof manual>;
    try {
      selected = await Promise.race([browser, manual]);
    } finally {
      manualAbort.abort(new Error("Anthropic OAuth completed through another input"));
    }
    if (selected.source === "manual") session.cancel(new Error("Manual Anthropic OAuth callback selected"));
    return await exchange(selected.value, session, options);
  } catch (error) {
    session.cancel(error instanceof Error ? error : new Error("Anthropic OAuth failed"));
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", cancel);
  }
}

export async function refreshAnthropicOAuth(
  credential: OAuthCredential,
  signal?: AbortSignal,
  fetchImplementation: typeof fetch = globalThis.fetch,
  now: () => number = Date.now,
): Promise<OAuthRefreshResult> {
  if (credential.provider !== "anthropic" || credential.refreshToken === undefined) {
    throw new Error("Anthropic OAuth credential cannot be refreshed");
  }
  const response = await requestOAuthJson(ANTHROPIC_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      refresh_token: credential.refreshToken,
    }),
  }, {
    label: "Anthropic OAuth refresh endpoint",
    fetch: fetchImplementation,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    throw new Error(`Anthropic OAuth refresh failed (${response.status} ${oauthErrorCode(response.value.error, "refresh_failed")})`);
  }
  const token = parseOAuthTokenResponse(response.value, "Anthropic OAuth refresh endpoint");
  defaultSecretRedactor.register(token.accessToken);
  defaultSecretRedactor.register(token.refreshToken);
  return {
    accessToken: token.accessToken,
    expiresAt: oauthTokenExpiresAt(token, now()),
    ...(token.refreshToken === undefined ? {} : { refreshToken: token.refreshToken }),
    tokenType: token.tokenType,
    ...(token.scope === undefined ? {} : { scopes: token.scope.split(" ").filter(Boolean) }),
  };
}
