import type { OAuthRefresher } from "./refresh.js";
import { requestOAuthJson } from "./oauth-http.js";
import {
  oauthErrorCode,
  oauthTokenExpiresAt,
  parseOAuthTokenResponse,
} from "./oauth-token.js";
import { defaultSecretRedactor } from "./redaction.js";

function secureEndpoint(value: string): URL {
  const endpoint = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new Error("OAuth token endpoint must use HTTPS or loopback HTTP");
  }
  if (endpoint.username !== "" || endpoint.password !== "") throw new Error("OAuth token endpoint contains credentials");
  if (endpoint.hash !== "") throw new Error("OAuth token endpoint contains a fragment");
  return endpoint;
}

export async function refreshGenericOAuthWithFetch(
  credential: Parameters<OAuthRefresher>[0],
  signal: Parameters<OAuthRefresher>[1],
  fetchImplementation: typeof fetch,
  options: { timeoutMs?: number; now?: () => number } = {},
): ReturnType<OAuthRefresher> {
  if (credential.tokenEndpoint === undefined || credential.clientId === undefined) {
    throw new Error("OAuth credential has no public refresh endpoint/client registration");
  }
  if (
    credential.refreshToken === undefined ||
    credential.refreshToken === "" ||
    /[\x00-\x1f\x7f]/u.test(credential.refreshToken) ||
    Buffer.byteLength(credential.refreshToken, "utf8") > 48 * 1024
  ) throw new Error("OAuth credential has no valid refresh token");
  if (
    credential.clientId === "" ||
    /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(credential.clientId) ||
    Buffer.byteLength(credential.clientId, "utf8") > 4096
  ) throw new Error("OAuth credential has no valid public client registration");
  const endpoint = secureEndpoint(credential.tokenEndpoint);
  const response = await requestOAuthJson(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: credential.clientId,
      refresh_token: credential.refreshToken,
    }),
  }, {
    label: "OAuth refresh endpoint",
    fetch: fetchImplementation,
    ...(signal === undefined ? {} : { signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const record = response.value;
  if (!response.ok) {
    const code = oauthErrorCode(record.error, "refresh_failed");
    throw new Error(`OAuth refresh failed (${response.status} ${code})`);
  }
  const token = parseOAuthTokenResponse(record, "OAuth refresh endpoint");
  defaultSecretRedactor.register(token.accessToken);
  defaultSecretRedactor.register(token.refreshToken);
  return {
    accessToken: token.accessToken,
    expiresAt: oauthTokenExpiresAt(token, (options.now ?? Date.now)()),
    ...(token.refreshToken === undefined ? {} : { refreshToken: token.refreshToken }),
    tokenType: token.tokenType,
    ...(token.scope === undefined ? {} : { scopes: token.scope.split(" ").filter(Boolean) }),
  };
}

export const refreshGenericOAuth: OAuthRefresher = async (credential, signal) =>
  await refreshGenericOAuthWithFetch(credential, signal, globalThis.fetch);
