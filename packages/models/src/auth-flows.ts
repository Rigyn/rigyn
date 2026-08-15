import type {
  ApiKeyAuth,
  AuthInteraction,
  Credential,
  CredentialStore,
  OAuthAuth,
  OAuthCredentials,
} from "./contracts.js";

const encoder = new TextEncoder();
const TOKEN_RESPONSE_LIMIT = 64 * 1024;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function randomOAuthValue(bytes = 32): string {
  if (!Number.isSafeInteger(bytes) || bytes < 16 || bytes > 128) {
    throw new RangeError("OAuth random value size must be between 16 and 128 bytes");
  }
  const value = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(value);
  return base64Url(value);
}

export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomOAuthValue(48);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  [name: string]: unknown;
}

export async function oauthTokenRequest(
  url: string,
  body: Record<string, string>,
  options: {
    fetch?: typeof globalThis.fetch;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  } = {},
): Promise<OAuthTokenResponse> {
  validateOAuthEndpoint(url);
  const response = await (options.fetch ?? globalThis.fetch)(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      ...options.headers,
    },
    body: new URLSearchParams(body),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const text = await boundedText(response, TOKEN_RESPONSE_LIMIT);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (!response.ok) throw new Error(oauthError(parsed, "OAuth token request failed with HTTP " + response.status));
  if (!isRecord(parsed) || typeof parsed.access_token !== "string" || parsed.access_token === "") {
    throw new Error("OAuth token response did not contain an access token");
  }
  return parsed as OAuthTokenResponse;
}

function validateOAuthEndpoint(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))) {
    throw new TypeError("OAuth endpoints must use HTTPS or loopback HTTP");
  }
}

async function boundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error("OAuth response exceeded 64 KiB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function oauthError(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback;
  if (typeof value.error_description === "string") return value.error_description;
  if (typeof value.message === "string") return value.message;
  if (typeof value.error === "string") return value.error;
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface BrowserOAuthConfig {
  name: string;
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: readonly string[];
  redirectUri?: string;
  extraAuthorize?: Record<string, string>;
  extraToken?: Record<string, string>;
  tokenHeaders?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export function browserOAuthMethod(config: BrowserOAuthConfig): OAuthAuth {
  validateOAuthEndpoint(config.authorizationUrl);
  validateOAuthEndpoint(config.tokenUrl);
  if (!config.clientId.trim()) throw new TypeError("OAuth client registration is required");
  const redirectUri = config.redirectUri ?? "http://127.0.0.1:1455/auth/callback";
  validateOAuthEndpoint(redirectUri);
  return {
    name: config.name,
    async login(interaction) {
      const pkce = await createPkcePair();
      const state = randomOAuthValue();
      const url = new URL(config.authorizationUrl);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: config.clientId,
        redirect_uri: redirectUri,
        scope: config.scopes.join(" "),
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
        state,
        ...config.extraAuthorize,
      }).toString();
      await interaction.notify({ type: "auth_url", url: url.toString() });
      const answer = await interaction.prompt({
        type: "manual_code",
        message: "Paste the OAuth callback URL or authorization code",
      });
      if (typeof answer !== "string" || !answer.trim()) throw new Error("OAuth authorization was cancelled");
      const code = callbackCode(answer.trim(), state);
      const token = await oauthTokenRequest(config.tokenUrl, {
        grant_type: "authorization_code",
        client_id: config.clientId,
        redirect_uri: redirectUri,
        code,
        code_verifier: pkce.verifier,
        ...config.extraToken,
      }, {
        ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
        ...(interaction.signal === undefined ? {} : { signal: interaction.signal }),
        ...(config.tokenHeaders === undefined ? {} : { headers: config.tokenHeaders }),
      });
      return tokenCredential(token, undefined, config.now);
    },
    async refresh(credential, signal) {
      if (!credential.refresh) return credential;
      const token = await oauthTokenRequest(config.tokenUrl, {
        grant_type: "refresh_token",
        client_id: config.clientId,
        refresh_token: credential.refresh,
        ...config.extraToken,
      }, {
        ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
        ...(signal === undefined ? {} : { signal }),
        ...(config.tokenHeaders === undefined ? {} : { headers: config.tokenHeaders }),
      });
      return tokenCredential(token, credential.refresh, config.now);
    },
    async toAuth(credential) {
      return { apiKey: credential.access };
    },
  };
}

function callbackCode(answer: string, expectedState: string): string {
  if (!answer.includes("://")) return answer;
  const url = new URL(answer);
  const error = url.searchParams.get("error");
  if (error) throw new Error(url.searchParams.get("error_description") ?? error);
  if (url.searchParams.get("state") !== expectedState) throw new Error("OAuth callback state did not match");
  const code = url.searchParams.get("code");
  if (!code) throw new Error("OAuth callback did not contain a code");
  return code;
}

function tokenCredential(
  token: OAuthTokenResponse,
  previousRefresh?: string,
  now: () => number = Date.now,
): OAuthCredentials {
  return {
    type: "oauth",
    access: token.access_token,
    refresh: token.refresh_token ?? previousRefresh ?? "",
    expires: now() + Math.max(0, token.expires_in ?? 3600) * 1000,
  };
}

export async function modifyCredential(
  store: CredentialStore,
  provider: string,
  update: (current: Credential | undefined) => Credential | undefined | Promise<Credential | undefined>,
): Promise<Credential | undefined> {
  return store.modify(provider, update);
}

export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

export interface DeviceOAuthConfig {
  name: string;
  clientId: string;
  deviceUrl: string;
  tokenUrl: string;
  scopes: readonly string[];
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export function deviceOAuthMethod(config: DeviceOAuthConfig): OAuthAuth {
  validateOAuthEndpoint(config.deviceUrl);
  validateOAuthEndpoint(config.tokenUrl);
  if (!config.clientId.trim()) throw new TypeError("OAuth client registration is required");
  return {
    name: config.name,
    async login(interaction) {
      const fetcher = config.fetch ?? globalThis.fetch;
      const response = await fetcher(config.deviceUrl, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", ...config.headers },
        body: new URLSearchParams({ client_id: config.clientId, scope: config.scopes.join(" ") }),
        ...(interaction.signal === undefined ? {} : { signal: interaction.signal }),
      });
      const parsed = await boundedText(response, TOKEN_RESPONSE_LIMIT);
      let device: DeviceAuthorization;
      try { device = JSON.parse(parsed) as DeviceAuthorization; } catch { throw new Error("OAuth device authorization returned invalid JSON"); }
      if (!response.ok || !device.device_code || !Number.isFinite(device.expires_in)) {
        throw new Error("OAuth device authorization failed");
      }
      await interaction.notify({
        type: "device_code",
        userCode: device.user_code,
        verificationUri: device.verification_uri_complete ?? device.verification_uri,
        ...(device.interval === undefined ? {} : { intervalSeconds: device.interval }),
        expiresInSeconds: device.expires_in,
      });
      const now = config.now ?? Date.now;
      const deadline = now() + Math.max(0, device.expires_in) * 1000;
      let intervalMs = Math.max(1, device.interval ?? 5) * 1000;
      while (now() < deadline) {
        await abortableDelay(intervalMs, interaction.signal);
        const tokenResponse = await fetcher(config.tokenUrl, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", ...config.headers },
          body: new URLSearchParams({
            client_id: config.clientId,
            device_code: device.device_code,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
          ...(interaction.signal === undefined ? {} : { signal: interaction.signal }),
        });
        const tokenText = await boundedText(tokenResponse, TOKEN_RESPONSE_LIMIT);
        let token: Record<string, unknown>;
        try { token = JSON.parse(tokenText) as Record<string, unknown>; } catch { throw new Error("OAuth device token response returned invalid JSON"); }
        if (typeof token.access_token === "string") return tokenCredential(token as OAuthTokenResponse, undefined, config.now);
        if (token.error === "slow_down") intervalMs += 5000;
        else if (token.error !== "authorization_pending") throw new Error(oauthError(token, "OAuth device flow failed"));
      }
      throw new Error("OAuth device code expired");
    },
    async refresh(credential, signal) {
      if (!credential.refresh) return credential;
      const token = await oauthTokenRequest(config.tokenUrl, {
        grant_type: "refresh_token",
        client_id: config.clientId,
        refresh_token: credential.refresh,
      }, {
        ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
        ...(signal === undefined ? {} : { signal }),
        ...(config.headers === undefined ? {} : { headers: config.headers }),
      });
      return tokenCredential(token, credential.refresh, config.now);
    },
    async toAuth(credential) {
      return { apiKey: credential.access };
    },
  };
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

export function apiKeyMethod(name = "API key", environment: readonly string[] = []): ApiKeyAuth {
  return {
    name,
    async login(interaction: AuthInteraction) {
      const answer = await interaction.prompt({ type: "secret", message: "API key" });
      const key = typeof answer === "string" ? answer.trim() : "";
      if (!key || key.includes("\0")) throw new TypeError("API key must not be empty");
      return { type: "api_key", key };
    },
    async resolve({ ctx, credential }) {
      if (credential?.key?.trim()) {
        return { auth: { apiKey: credential.key }, source: "stored credential", ...(credential.env ? { env: credential.env } : {}) };
      }
      for (const name of environment) {
        const value = credential?.env?.[name] ?? await ctx.env(name);
        if (value?.trim()) return { auth: { apiKey: value }, source: name, ...(credential?.env ? { env: credential.env } : {}) };
      }
      return undefined;
    },
  };
}
