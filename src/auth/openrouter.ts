import { createPkcePair } from "./pkce.js";
import { requestOAuthJson } from "./oauth-http.js";
import { defaultSecretRedactor } from "./redaction.js";

export const OPENROUTER_AUTHORIZATION_ENDPOINT = "https://openrouter.ai/auth";
export const OPENROUTER_KEY_EXCHANGE_ENDPOINT = "https://openrouter.ai/api/v1/auth/keys";

export interface OpenRouterAuthorization {
  authorizationUrl: URL;
  verifier: string;
}

function validateCallback(callback: URL): void {
  const loopback = callback.hostname === "localhost" || callback.hostname === "127.0.0.1";
  if (callback.protocol !== "https:" && !(callback.protocol === "http:" && loopback)) {
    throw new TypeError("OpenRouter callback must use HTTPS or an HTTP loopback address");
  }
  if (callback.username !== "" || callback.password !== "") {
    throw new TypeError("OpenRouter callback must not contain credentials");
  }
  if (callback.hash !== "" || Buffer.byteLength(callback.toString(), "utf8") > 16 * 1024) {
    throw new TypeError("OpenRouter callback must not contain a fragment or exceed 16 KiB");
  }
}

export function createOpenRouterAuthorization(callbackUrl: string | URL): OpenRouterAuthorization {
  const callback = new URL(callbackUrl);
  validateCallback(callback);
  const pkce = createPkcePair();
  const authorizationUrl = new URL(OPENROUTER_AUTHORIZATION_ENDPOINT);
  authorizationUrl.searchParams.set("callback_url", callback.toString());
  authorizationUrl.searchParams.set("code_challenge", pkce.challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  return { authorizationUrl, verifier: pkce.verifier };
}

export async function exchangeOpenRouterCode(options: {
  code: string;
  verifier: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<string> {
  if (
    options.code.length === 0 ||
    Buffer.byteLength(options.code, "utf8") > 4096 ||
    /[\x00-\x1f\x7f]/u.test(options.code) ||
    !/^[A-Za-z0-9_-]{43,128}$/u.test(options.verifier)
  ) {
    throw new TypeError("OpenRouter code or verifier is invalid");
  }
  const response = await requestOAuthJson(OPENROUTER_KEY_EXCHANGE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      code: options.code,
      code_verifier: options.verifier,
      code_challenge_method: "S256",
    }),
  }, {
    label: "OpenRouter key exchange",
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const key = response.value.key;
  if (
    !response.ok ||
    typeof key !== "string" ||
    key.length === 0 ||
    /[\s\x00-\x1f\x7f]/u.test(key) ||
    Buffer.byteLength(key, "utf8") > 48 * 1024
  ) {
    throw new Error(`OpenRouter key exchange failed (${response.status})`);
  }
  defaultSecretRedactor.register(key);
  return key;
}
