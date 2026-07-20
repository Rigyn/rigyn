import { setTimeout as delay } from "node:timers/promises";

import { requestOAuthJson } from "./oauth-http.js";
import {
  oauthErrorCode,
  parseOAuthTokenResponse,
  type OAuthTokenResponse,
} from "./oauth-token.js";
import { defaultSecretRedactor } from "./redaction.js";

export interface DeviceAuthorizationOptions {
  deviceEndpoint: string | URL;
  clientId: string;
  scopes?: string[];
  signal?: AbortSignal;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface DeviceAuthorizationResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export interface DevicePollOptions {
  tokenEndpoint: string | URL;
  clientId: string;
  deviceCode: string;
  expiresInSeconds: number;
  intervalSeconds?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  requestTimeoutMs?: number;
}

async function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  try {
    await delay(milliseconds, undefined, signal === undefined ? undefined : { signal });
  } catch (error) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("OAuth device authorization cancelled");
    throw error;
  }
}

function secureEndpoint(value: string | URL, label: string): URL {
  const endpoint = new URL(value);
  const loopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost" || endpoint.hostname === "::1";
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new TypeError(`${label} must use HTTPS or a loopback address`);
  }
  if (endpoint.username !== "" || endpoint.password !== "") throw new TypeError(`${label} must not contain credentials`);
  if (endpoint.hash !== "") throw new TypeError(`${label} must not contain a fragment`);
  return endpoint;
}

function responseString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value === "" || Buffer.byteLength(value) > maximum) {
    throw new Error(`OAuth device response has an invalid ${label}`);
  }
  return value;
}

export async function requestDeviceAuthorization(options: DeviceAuthorizationOptions): Promise<DeviceAuthorizationResponse> {
  const endpoint = secureEndpoint(options.deviceEndpoint, "Device authorization endpoint");
  if (
    !/^[\x21-\x7e]+$/u.test(options.clientId) ||
    Buffer.byteLength(options.clientId, "utf8") > 4096
  ) {
    throw new TypeError("clientId is invalid");
  }
  const scopes = options.scopes ?? [];
  if (scopes.length > 256 || scopes.some((scope) => scope === "" || /[\s\0]/u.test(scope) || Buffer.byteLength(scope) > 1024)) {
    throw new TypeError("OAuth device scopes are invalid");
  }
  options.signal?.throwIfAborted();
  const response = await requestOAuthJson(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: options.clientId, ...(scopes.length === 0 ? {} : { scope: scopes.join(" ") }) }),
  }, {
    label: "OAuth device authorization endpoint",
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const parsed = response.value;
  if (!response.ok) {
    const code = oauthErrorCode(parsed.error, "unknown_error");
    throw new Error(`OAuth device authorization failed (${response.status} ${code})`);
  }
  const deviceCode = responseString(parsed.device_code, "device_code", 8192);
  if (!/^[\x21-\x7e]+$/u.test(deviceCode)) throw new Error("OAuth device response has an invalid device_code");
  const userCode = responseString(parsed.user_code, "user_code", 1024);
  if (!/^[\x20-\x7e]+$/u.test(userCode)) throw new Error("OAuth device response has an invalid user_code");
  const verificationUri = secureEndpoint(responseString(parsed.verification_uri, "verification_uri", 16 * 1024), "Verification URI").toString();
  const verificationUriComplete = parsed.verification_uri_complete === undefined
    ? undefined
    : secureEndpoint(responseString(parsed.verification_uri_complete, "verification_uri_complete", 16 * 1024), "Complete verification URI").toString();
  const expiresInSeconds = parsed.expires_in;
  // Some interoperable device providers return zero to request the RFC default.
  const intervalSeconds = parsed.interval === 0 ? 5 : parsed.interval ?? 5;
  if (!Number.isSafeInteger(expiresInSeconds) || (expiresInSeconds as number) <= 0 || (expiresInSeconds as number) > 7 * 24 * 60 * 60) {
    throw new Error("OAuth device response has an invalid expires_in");
  }
  if (!Number.isSafeInteger(intervalSeconds) || (intervalSeconds as number) <= 0 || (intervalSeconds as number) > 300) {
    throw new Error("OAuth device response has an invalid interval");
  }
  defaultSecretRedactor.register(deviceCode);
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(verificationUriComplete === undefined ? {} : { verificationUriComplete }),
    expiresInSeconds: expiresInSeconds as number,
    intervalSeconds: intervalSeconds as number,
  };
}

export async function pollDeviceToken(options: DevicePollOptions): Promise<OAuthTokenResponse> {
  const endpoint = secureEndpoint(options.tokenEndpoint, "Device token endpoint");
  if (
    !/^[\x21-\x7e]+$/u.test(options.clientId) ||
    Buffer.byteLength(options.clientId, "utf8") > 4096 ||
    !/^[\x21-\x7e]+$/u.test(options.deviceCode) ||
    Buffer.byteLength(options.deviceCode, "utf8") > 8192
  ) {
    throw new TypeError("clientId or deviceCode is invalid");
  }
  defaultSecretRedactor.register(options.deviceCode);
  if (
    !Number.isSafeInteger(options.expiresInSeconds) ||
    options.expiresInSeconds <= 0 ||
    options.expiresInSeconds > 7 * 24 * 60 * 60
  ) {
    throw new TypeError("expiresInSeconds must be positive");
  }
  const now = options.now ?? Date.now;
  const startedAt = now();
  if (!Number.isFinite(startedAt)) throw new TypeError("OAuth device clock is invalid");
  const expiresAt = startedAt + options.expiresInSeconds * 1000;
  if (!Number.isSafeInteger(expiresAt)) throw new TypeError("OAuth device expiry is invalid");
  let intervalMs = (options.intervalSeconds ?? 5) * 1000;
  if (!Number.isSafeInteger(options.intervalSeconds ?? 5) || intervalMs <= 0 || intervalMs > 300_000) {
    throw new TypeError("intervalSeconds must be positive");
  }
  const sleep = options.sleep ?? defaultSleep;
  const fetchImplementation = options.fetch ?? fetch;

  while (now() < expiresAt) {
    options.signal?.throwIfAborted();
    await sleep(intervalMs, options.signal);
    options.signal?.throwIfAborted();
    if (now() >= expiresAt) break;

    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: options.clientId,
      device_code: options.deviceCode,
    });
    const response = await requestOAuthJson(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    }, {
      label: "OAuth device token endpoint",
      fetch: fetchImplementation,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.requestTimeoutMs === undefined ? {} : { timeoutMs: options.requestTimeoutMs }),
    });
    const parsed = response.value;
    if (response.ok) {
      const token = parseOAuthTokenResponse(parsed, "OAuth device token endpoint");
      defaultSecretRedactor.register(token.accessToken);
      defaultSecretRedactor.register(token.refreshToken);
      return token;
    }

    const oauthError = oauthErrorCode(parsed.error, "unknown_error");
    switch (oauthError) {
      case "authorization_pending":
        continue;
      case "slow_down":
        if (intervalMs > 295_000) throw new Error("OAuth device polling interval exceeded 300 seconds");
        intervalMs += 5_000;
        continue;
      case "expired_token":
        throw new Error("OAuth device code expired");
      case "access_denied":
        throw new Error("OAuth device authorization was denied");
      default:
        throw new Error(`OAuth device authorization failed (${response.status} ${oauthError})`);
    }
  }
  throw new Error("OAuth device code expired");
}
