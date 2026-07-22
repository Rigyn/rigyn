import { pollDeviceToken, requestDeviceAuthorization } from "./device.js";
import { requestOAuthJson } from "./oauth-http.js";
import { oauthErrorCode } from "./oauth-token.js";
import { defaultSecretRedactor } from "./redaction.js";
import type { OAuthRefreshResult } from "./refresh.js";
import type { OAuthCredential } from "./types.js";
import { RIGYN_VERSION } from "../version.js";

export const GITHUB_COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
export const GITHUB_COPILOT_DEFAULT_HOST = "github.com";

const COPILOT_TOKEN_LIFETIME_SKEW_MS = 60_000;

export interface GitHubCopilotAuthorizationOptions {
  requestHost(signal: AbortSignal): Promise<string | undefined>;
  showDeviceCode(input: { url: URL; userCode: string }): void | Promise<void>;
  openUrl?(url: URL): void | Promise<void>;
  showProgress?(message: string): void | Promise<void>;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export function normalizeGitHubHost(value: string | undefined): string {
  const input = value?.trim() ?? "";
  if (input === "") return GITHUB_COPILOT_DEFAULT_HOST;
  let parsed: URL;
  try {
    parsed = new URL(input.includes("://") ? input : `https://${input}`);
  } catch {
    throw new Error("GitHub host must be a valid HTTPS hostname");
  }
  if (
    parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" ||
    parsed.port !== "" || (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search !== "" || parsed.hash !== "" || parsed.hostname.length > 253
  ) throw new Error("GitHub host must be an HTTPS hostname without a path, port, or credentials");
  return parsed.hostname.toLowerCase();
}

function githubEndpoints(host: string): { device: string; token: string; copilot: string } {
  return {
    device: `https://${host}/login/device/code`,
    token: `https://${host}/login/oauth/access_token`,
    copilot: `https://api.${host}/copilot_internal/v2/token`,
  };
}

function copilotHeaders(): HeadersInit {
  return {
    accept: "application/json",
    "user-agent": `rigyn/${RIGYN_VERSION}`,
    "editor-version": `rigyn/${RIGYN_VERSION}`,
    "editor-plugin-version": `rigyn/${RIGYN_VERSION}`,
    "copilot-integration-id": "vscode-chat",
  };
}

function serviceToken(value: Record<string, unknown>, now: number): { accessToken: string; expiresAt: number } {
  const accessToken = value.token;
  const expiresAtSeconds = value.expires_at;
  if (
    typeof accessToken !== "string" || accessToken === "" || Buffer.byteLength(accessToken, "utf8") > 48 * 1024 ||
    /[\x00-\x20\x7f]/u.test(accessToken)
  ) throw new Error("GitHub Copilot token response omitted a valid token");
  if (
    typeof expiresAtSeconds !== "number" || !Number.isSafeInteger(expiresAtSeconds) ||
    expiresAtSeconds <= Math.floor(now / 1000)
  ) throw new Error("GitHub Copilot token response omitted a valid expiry");
  const expiresAt = expiresAtSeconds * 1000 - COPILOT_TOKEN_LIFETIME_SKEW_MS;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new Error("GitHub Copilot token expires too soon");
  return { accessToken, expiresAt };
}

export async function exchangeGitHubCopilotToken(
  githubToken: string,
  host: string,
  options: { signal?: AbortSignal; fetch?: typeof fetch; now?: () => number },
): Promise<{ accessToken: string; expiresAt: number }> {
  defaultSecretRedactor.register(githubToken);
  const response = await requestOAuthJson(githubEndpoints(host).copilot, {
    headers: { ...copilotHeaders(), authorization: `Bearer ${githubToken}` },
  }, {
    label: "GitHub Copilot token endpoint",
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!response.ok) {
    throw new Error(`GitHub Copilot token exchange failed (${response.status} ${oauthErrorCode(response.value.error, "token_exchange_failed")})`);
  }
  const token = serviceToken(response.value, (options.now ?? Date.now)());
  defaultSecretRedactor.register(token.accessToken);
  return token;
}

export async function authorizeGitHubCopilot(options: GitHubCopilotAuthorizationOptions): Promise<OAuthCredential> {
  const controller = new AbortController();
  const signal = options.signal === undefined
    ? controller.signal
    : AbortSignal.any([controller.signal, options.signal]);
  signal.throwIfAborted();
  const host = normalizeGitHubHost(await options.requestHost(signal));
  const endpoints = githubEndpoints(host);
  const device = await requestDeviceAuthorization({
    deviceEndpoint: endpoints.device,
    clientId: GITHUB_COPILOT_CLIENT_ID,
    scopes: ["read:user"],
    signal,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const verificationUrl = new URL(device.verificationUriComplete ?? device.verificationUri);
  await options.showDeviceCode({ url: verificationUrl, userCode: device.userCode });
  await options.openUrl?.(verificationUrl);
  const github = await pollDeviceToken({
    tokenEndpoint: endpoints.token,
    clientId: GITHUB_COPILOT_CLIENT_ID,
    deviceCode: device.deviceCode,
    expiresInSeconds: device.expiresInSeconds,
    intervalSeconds: device.intervalSeconds,
    signal,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
  await options.showProgress?.("Connecting to GitHub Copilot...");
  const token = await exchangeGitHubCopilotToken(github.accessToken, host, options);
  return {
    kind: "oauth",
    provider: "github-copilot",
    accessToken: token.accessToken,
    refreshToken: github.accessToken,
    expiresAt: token.expiresAt,
    tokenType: "Bearer",
    scopes: github.scope?.split(" ").filter(Boolean) ?? ["read:user"],
    tokenEndpoint: endpoints.copilot,
    clientId: GITHUB_COPILOT_CLIENT_ID,
    ...(host === GITHUB_COPILOT_DEFAULT_HOST ? {} : { providerData: { enterpriseHost: host } }),
  };
}

export async function refreshGitHubCopilotOAuth(
  credential: OAuthCredential,
  signal?: AbortSignal,
  fetchImplementation: typeof fetch = globalThis.fetch,
  now: () => number = Date.now,
): Promise<OAuthRefreshResult> {
  if (credential.provider !== "github-copilot" || credential.refreshToken === undefined) {
    throw new Error("GitHub Copilot OAuth credential cannot be refreshed");
  }
  const host = normalizeGitHubHost(credential.providerData?.enterpriseHost);
  const token = await exchangeGitHubCopilotToken(credential.refreshToken, host, {
    ...(signal === undefined ? {} : { signal }),
    fetch: fetchImplementation,
    now,
  });
  return {
    accessToken: token.accessToken,
    expiresAt: token.expiresAt,
    refreshToken: credential.refreshToken,
    tokenType: "Bearer",
    providerData: host === GITHUB_COPILOT_DEFAULT_HOST ? {} : { enterpriseHost: host },
  };
}

export function githubCopilotBaseUrl(accessToken: string, enterpriseHost?: string): string {
  const match = /(?:^|;)proxy-ep=([^;]+)(?:;|$)/u.exec(accessToken);
  if (match?.[1] !== undefined) {
    const proxyHost = match[1].toLowerCase();
    if (/^[a-z0-9.-]+\.githubcopilot\.com$/u.test(proxyHost)) {
      return `https://${proxyHost.replace(/^proxy\./u, "api.")}`;
    }
  }
  const host = normalizeGitHubHost(enterpriseHost);
  return host === GITHUB_COPILOT_DEFAULT_HOST
    ? "https://api.individual.githubcopilot.com"
    : `https://copilot-api.${host}`;
}

export function githubCopilotRequestHeaders(accessToken: string): Headers {
  const headers = new Headers(copilotHeaders());
  headers.set("authorization", `Bearer ${accessToken}`);
  return headers;
}
