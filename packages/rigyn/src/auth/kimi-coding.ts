import { setTimeout as delay } from "node:timers/promises";

import { CloudAuthIoError, requestBounded } from "./cloud-http.js";
import { pollDeviceToken } from "./device.js";
import { OAUTH_HTTP_TIMEOUT_MS, OAUTH_MAX_RESPONSE_BYTES } from "./oauth-http.js";
import { oauthTokenExpiresAt, parseOAuthTokenResponse } from "./oauth-token.js";
import type {
  ProviderAuthDescriptor,
  ProviderManagedOAuthAuthMethod,
  ProviderManagedOAuthCredential,
} from "./provider-descriptor.js";
import { defaultSecretRedactor } from "./redaction.js";

export const KIMI_CODING_OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
export const KIMI_CODING_OAUTH_HOST = "https://auth.kimi.com";

const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const REFRESH_MAX_RETRIES = 3;

interface KimiDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

export interface KimiCodingManagedOAuthOptions {
  fetch?: typeof fetch;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function jsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function secureUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "" || Buffer.byteLength(value, "utf8") > 16 * 1024) {
    throw new Error(`${label} is invalid`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" || url.password !== "" || url.hash !== ""
  ) {
    throw new Error(`${label} must use HTTPS or loopback HTTP without credentials or a fragment`);
  }
  return url.toString();
}

function oauthHost(environment: NodeJS.ProcessEnv): string {
  const selected = (environment.KIMI_CODE_OAUTH_HOST?.trim() ||
    environment.KIMI_OAUTH_HOST?.trim() ||
    KIMI_CODING_OAUTH_HOST).replace(/\/+$/u, "");
  const url = new URL(secureUrl(selected, "Kimi Code OAuth host"));
  if (url.search !== "" || (url.pathname !== "" && url.pathname !== "/")) {
    throw new Error("Kimi Code OAuth host must contain only an origin");
  }
  return url.origin;
}

function publicString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" || value === "" || Buffer.byteLength(value, "utf8") > maximum ||
    /[\x00-\x1f\x7f]/u.test(value)
  ) throw new Error(`Kimi Code device authorization response has an invalid ${label}`);
  return value;
}

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : fallback;
}

async function requestForm(
  url: string,
  body: URLSearchParams,
  fetchImplementation: typeof fetch,
  signal?: AbortSignal,
) {
  return await requestBounded(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    redirect: "error",
  }, {
    fetch: fetchImplementation,
    timeoutMs: OAUTH_HTTP_TIMEOUT_MS,
    maxResponseBytes: OAUTH_MAX_RESPONSE_BYTES,
    label: "Kimi Code OAuth endpoint",
    ...(signal === undefined ? {} : { signal }),
  });
}

async function startDeviceAuthorization(
  host: string,
  fetchImplementation: typeof fetch,
  signal: AbortSignal,
): Promise<KimiDeviceAuthorization> {
  const response = await requestForm(
    `${host}/api/oauth/device_authorization`,
    new URLSearchParams({ client_id: KIMI_CODING_OAUTH_CLIENT_ID }),
    fetchImplementation,
    signal,
  );
  const value = jsonRecord(response.text);
  if (!response.ok) throw new Error(`Kimi Code device authorization failed with status ${response.status}`);

  const deviceCode = publicString(value?.device_code, "device_code", 8192);
  const userCode = publicString(value?.user_code, "user_code", 1024);
  const verificationUri = secureUrl(value?.verification_uri, "Kimi Code verification URI");
  const verificationUriComplete = secureUrl(
    value?.verification_uri_complete,
    "Kimi Code complete verification URI",
  );
  defaultSecretRedactor.register(deviceCode);
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    intervalSeconds: positiveInteger(value?.interval, DEFAULT_POLL_INTERVAL_SECONDS),
    expiresInSeconds: positiveInteger(value?.expires_in, DEVICE_CODE_TIMEOUT_SECONDS),
  };
}

function managedCredential(
  value: Record<string, unknown> | undefined,
  operation: "poll" | "refresh",
  now: number,
): ProviderManagedOAuthCredential {
  if (
    typeof value?.access_token !== "string" || value.access_token === "" ||
    typeof value.refresh_token !== "string" || value.refresh_token === "" ||
    typeof value.expires_in !== "number" || !Number.isSafeInteger(value.expires_in) || value.expires_in <= 0
  ) {
    throw new Error(`Kimi Code token ${operation} response missing required fields`);
  }
  const token = parseOAuthTokenResponse(value, `Kimi Code token ${operation}`);
  defaultSecretRedactor.registerAll([token.accessToken, token.refreshToken]);
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken!,
    expiresAt: oauthTokenExpiresAt(token, now),
    tokenType: "Bearer",
    ...(token.scope === undefined ? {} : { scopes: token.scope.split(/ +/u).filter(Boolean) }),
  };
}

async function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await delay(milliseconds, undefined, signal === undefined ? undefined : { signal });
}

async function refreshToken(
  host: string,
  refreshTokenValue: string,
  signal: AbortSignal,
  fetchImplementation: typeof fetch,
  now: () => number,
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
): Promise<ProviderManagedOAuthCredential> {
  defaultSecretRedactor.register(refreshTokenValue);
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= REFRESH_MAX_RETRIES; attempt += 1) {
    signal.throwIfAborted();
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1), signal);
    signal.throwIfAborted();

    let response: Awaited<ReturnType<typeof requestForm>>;
    try {
      response = await requestForm(
        `${host}/api/oauth/token`,
        new URLSearchParams({
          client_id: KIMI_CODING_OAUTH_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: refreshTokenValue,
        }),
        fetchImplementation,
        signal,
      );
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof CloudAuthIoError)) throw error;
      lastError = error;
      continue;
    }

    const value = jsonRecord(response.text);
    if (response.ok) return managedCredential(value, "refresh", now());
    if (response.status === 401 || response.status === 403 || value?.error === "invalid_grant") {
      throw new Error(`Kimi Code token refresh unauthorized (status ${response.status})`);
    }
    if ((response.status === 429 || response.status >= 500) && attempt < REFRESH_MAX_RETRIES) {
      lastError = new Error(`Kimi Code token refresh failed with status ${response.status}`);
      continue;
    }
    throw new Error(`Kimi Code token refresh failed with status ${response.status}`);
  }
  throw lastError ?? new Error("Kimi Code token refresh failed");
}

/** Kimi Code subscription login and rotating refresh-token behavior. */
export function createKimiCodingManagedOAuth(
  options: KimiCodingManagedOAuthOptions = {},
): ProviderManagedOAuthAuthMethod {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const environment = options.environment ?? process.env;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  return {
    kind: "managed_oauth",
    id: "subscription",
    label: "Sign in with Kimi Code",
    detail: "Kimi Code (subscription) · device authorization",
    async login(interaction) {
      interaction.signal.throwIfAborted();
      const host = oauthHost(environment);
      const device = await startDeviceAuthorization(host, fetchImplementation, interaction.signal);
      await interaction.showDeviceCode({
        userCode: device.userCode,
        verificationUri: device.verificationUriComplete,
        intervalSeconds: device.intervalSeconds,
        expiresInSeconds: device.expiresInSeconds,
      });
      const token = await pollDeviceToken({
        tokenEndpoint: `${host}/api/oauth/token`,
        clientId: KIMI_CODING_OAUTH_CLIENT_ID,
        deviceCode: device.deviceCode,
        expiresInSeconds: device.expiresInSeconds,
        intervalSeconds: device.intervalSeconds,
        signal: interaction.signal,
        fetch: fetchImplementation,
        now,
        sleep,
        requestTimeoutMs: OAUTH_HTTP_TIMEOUT_MS,
      });
      return managedCredential({
        access_token: token.accessToken,
        refresh_token: token.refreshToken,
        expires_in: token.expiresIn,
        token_type: token.tokenType,
        ...(token.scope === undefined ? {} : { scope: token.scope }),
      }, "poll", now());
    },
    async refresh(credential, signal) {
      signal.throwIfAborted();
      if (credential.refreshToken === undefined) throw new Error("Kimi Code OAuth credential has no refresh token");
      return await refreshToken(
        oauthHost(environment),
        credential.refreshToken,
        signal,
        fetchImplementation,
        now,
        sleep,
      );
    },
  };
}

/** Core provider descriptor used by both CLI-only and full runtime auth surfaces. */
export function createKimiCodingAuthDescriptor(
  options: KimiCodingManagedOAuthOptions = {},
): ProviderAuthDescriptor {
  return {
    provider: "kimi-coding",
    displayName: "Kimi For Coding",
    methods: [createKimiCodingManagedOAuth(options)],
    request: {
      origins: ["https://api.kimi.com"],
      bearer: { header: "authorization", prefix: "Bearer " },
    },
  };
}
