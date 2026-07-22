import { requestBounded } from "./cloud-http.js";
import { OAUTH_HTTP_TIMEOUT_MS, OAUTH_MAX_RESPONSE_BYTES } from "./oauth-http.js";
import { oauthErrorCode } from "./oauth-token.js";
import { defaultSecretRedactor } from "./redaction.js";
import type { OAuthCredential } from "./types.js";

export interface OAuthRevocationResult {
  tokenTypeHint: "access_token" | "refresh_token";
}

function revocationEndpoint(value: string): URL {
  const endpoint = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new Error("OAuth revocation endpoint must use HTTPS or loopback HTTP");
  }
  if (endpoint.username !== "" || endpoint.password !== "" || endpoint.hash !== "") {
    throw new Error("OAuth revocation endpoint contains credentials or a fragment");
  }
  return endpoint;
}

/** Revoke the strongest available token using an explicitly configured RFC 7009 endpoint. */
export async function revokeGenericOAuthWithFetch(
  credential: OAuthCredential,
  fetchImplementation: typeof fetch,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<OAuthRevocationResult> {
  if (credential.revocationEndpoint === undefined) {
    throw new Error("OAuth credential has no public revocation endpoint");
  }
  if (
    credential.clientId === undefined ||
    credential.clientId === "" ||
    credential.clientId.includes("\0") ||
    Buffer.byteLength(credential.clientId, "utf8") > 4096
  ) {
    throw new Error("OAuth credential has no valid public client registration");
  }
  const token = credential.refreshToken ?? credential.accessToken;
  const tokenTypeHint = credential.refreshToken === undefined ? "access_token" : "refresh_token";
  defaultSecretRedactor.register(token);
  const response = await requestBounded(revocationEndpoint(credential.revocationEndpoint), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      token,
      token_type_hint: tokenTypeHint,
      client_id: credential.clientId,
    }),
    redirect: "error",
  }, {
    fetch: fetchImplementation,
    timeoutMs: options.timeoutMs ?? OAUTH_HTTP_TIMEOUT_MS,
    maxResponseBytes: OAUTH_MAX_RESPONSE_BYTES,
    label: "OAuth revocation endpoint",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!response.ok) {
    let error: unknown;
    try {
      const parsed: unknown = JSON.parse(response.text);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        error = (parsed as Record<string, unknown>).error;
      }
    } catch {}
    throw new Error(`OAuth revocation failed (${response.status} ${oauthErrorCode(error, "revocation_failed")})`);
  }
  return { tokenTypeHint };
}

export async function revokeGenericOAuth(
  credential: OAuthCredential,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<OAuthRevocationResult> {
  return revokeGenericOAuthWithFetch(credential, globalThis.fetch, options);
}
