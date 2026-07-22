import { pollDeviceToken, requestDeviceAuthorization } from "./device.js";
import { createLoopbackAuthorization, exchangeAuthorizationCode } from "./loopback.js";
import { requestOAuthJson } from "./oauth-http.js";
import { oauthErrorCode, oauthTokenExpiresAt, parseOAuthTokenResponse, type OAuthTokenResponse } from "./oauth-token.js";
import type {
  ProviderManagedAuthInteraction,
  ProviderManagedOAuthAuthMethod,
  ProviderManagedOAuthCredential,
} from "./provider-descriptor.js";
import { defaultSecretRedactor } from "./redaction.js";

const CALLBACK_PORT = 1456;
const CALLBACK_PATH = "/oauth/callback";
const TOKEN_EXPIRY_SKEW_MS = 60_000;

interface GatewayOAuthDiscovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  deviceAuthorizationEndpoint: string;
  verificationEndpoint: string;
  clientId: string;
  scopes: string[];
  deviceCodeGrantType: string;
}

export interface GatewayManagedOAuthOptions {
  name: string;
  gatewayUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function secureEndpoint(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "" || Buffer.byteLength(value, "utf8") > 16 * 1024) {
    throw new Error(`${label} is invalid`);
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname);
  if (
    (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error(`${label} must use HTTPS or loopback HTTP without credentials or a fragment`);
  }
  return endpoint.toString();
}

function publicValue(value: unknown, label: string, maximum = 4096): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    Buffer.byteLength(value, "utf8") > maximum ||
    /[\x00-\x1f\x7f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function scopes(value: unknown): string[] {
  const raw = publicValue(value, "Gateway OAuth scope", 16 * 1024);
  const result = raw.split(/ +/u).filter(Boolean);
  if (
    result.length > 256 ||
    result.some((scope) => Buffer.byteLength(scope, "utf8") > 1024 || /\s/u.test(scope))
  ) {
    throw new Error("Gateway OAuth scope is invalid");
  }
  return result;
}

function gatewayRoot(value: string): string {
  const endpoint = new URL(secureEndpoint(value, "Gateway URL"));
  if (endpoint.search !== "") throw new Error("Gateway URL must not contain a query");
  return endpoint.toString().replace(/\/+$/u, "");
}

async function discover(
  gateway: string,
  fetchImplementation: typeof fetch,
  signal: AbortSignal,
): Promise<GatewayOAuthDiscovery> {
  const response = await requestOAuthJson(`${gateway}/oauth`, {
    headers: { accept: "application/json" },
  }, {
    label: "Gateway OAuth discovery",
    fetch: fetchImplementation,
    signal,
  });
  if (!response.ok) {
    throw new Error(`Gateway OAuth discovery failed (${response.status} ${oauthErrorCode(response.value.error, "discovery_failed")})`);
  }
  const value = response.value;
  const grantType = publicValue(value.deviceCodeGrantType, "Gateway OAuth device grant type");
  if (!/^[\x21-\x7e]+$/u.test(grantType) || /secret|password/iu.test(grantType)) {
    throw new Error("Gateway OAuth device grant type is invalid");
  }
  // Validate optional authority metadata even though requests use the exact
  // discovered endpoints below.
  if (value.issuer !== undefined) secureEndpoint(value.issuer, "Gateway OAuth issuer");
  if (value.deviceAuthorizationEventsEndpoint !== undefined) {
    secureEndpoint(value.deviceAuthorizationEventsEndpoint, "Gateway OAuth device events endpoint");
  }
  return {
    authorizationEndpoint: secureEndpoint(value.authorizationEndpoint, "Gateway OAuth authorization endpoint"),
    tokenEndpoint: secureEndpoint(value.tokenEndpoint, "Gateway OAuth token endpoint"),
    deviceAuthorizationEndpoint: secureEndpoint(
      value.deviceAuthorizationEndpoint,
      "Gateway OAuth device authorization endpoint",
    ),
    verificationEndpoint: secureEndpoint(value.verificationEndpoint, "Gateway OAuth verification endpoint"),
    clientId: publicValue(value.clientId, "Gateway OAuth client ID"),
    scopes: scopes(value.scope),
    deviceCodeGrantType: grantType,
  };
}

function managedCredential(
  token: OAuthTokenResponse,
  discovered: GatewayOAuthDiscovery,
  now: number,
): ProviderManagedOAuthCredential {
  const expiresAt = oauthTokenExpiresAt(token, now) - TOKEN_EXPIRY_SKEW_MS;
  if (expiresAt <= now) throw new Error("Gateway OAuth token lifetime is too short");
  defaultSecretRedactor.register(token.accessToken);
  defaultSecretRedactor.register(token.refreshToken);
  return {
    accessToken: token.accessToken,
    ...(token.refreshToken === undefined ? {} : { refreshToken: token.refreshToken }),
    expiresAt,
    tokenType: "Bearer",
    scopes: token.scope?.split(/ +/u).filter(Boolean) ?? discovered.scopes,
  };
}

async function refreshToken(
  discovered: GatewayOAuthDiscovery,
  refreshTokenValue: string,
  fetchImplementation: typeof fetch,
  signal: AbortSignal,
): Promise<OAuthTokenResponse> {
  const response = await requestOAuthJson(discovered.tokenEndpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: discovered.clientId,
      refresh_token: refreshTokenValue,
    }),
  }, {
    label: "Gateway OAuth token refresh",
    fetch: fetchImplementation,
    signal,
  });
  if (!response.ok) {
    throw new Error(`Gateway OAuth token refresh failed (${response.status} ${oauthErrorCode(response.value.error, "refresh_failed")})`);
  }
  return parseOAuthTokenResponse(response.value, "Gateway OAuth token refresh");
}

async function browserLogin(
  discovered: GatewayOAuthDiscovery,
  interaction: ProviderManagedAuthInteraction,
  fetchImplementation: typeof fetch,
): Promise<OAuthTokenResponse> {
  const session = await createLoopbackAuthorization({
    authorizationEndpoint: discovered.authorizationEndpoint,
    clientId: discovered.clientId,
    scopes: discovered.scopes,
    callbackPath: CALLBACK_PATH,
    port: CALLBACK_PORT,
    extraParameters: { handoff: "url" },
  });
  const abort = (): void => session.cancel(
    interaction.signal.reason instanceof Error ? interaction.signal.reason : new Error("Gateway OAuth login cancelled"),
  );
  interaction.signal.addEventListener("abort", abort, { once: true });
  try {
    await interaction.showProgress(`Listening for the authorization callback on ${session.redirectUri}`);
    await interaction.showAuthorization({ url: session.authorizationUrl });
    const callback = await session.waitForCallback();
    return await exchangeAuthorizationCode({
      tokenEndpoint: discovered.tokenEndpoint,
      clientId: discovered.clientId,
      code: callback.code,
      redirectUri: session.redirectUri,
      verifier: session.verifier,
      signal: interaction.signal,
      fetch: fetchImplementation,
    });
  } finally {
    interaction.signal.removeEventListener("abort", abort);
    session.cancel();
  }
}

async function deviceLogin(
  discovered: GatewayOAuthDiscovery,
  interaction: ProviderManagedAuthInteraction,
  fetchImplementation: typeof fetch,
  now: () => number,
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
): Promise<OAuthTokenResponse> {
  const authorization = await requestDeviceAuthorization({
    deviceEndpoint: discovered.deviceAuthorizationEndpoint,
    clientId: discovered.clientId,
    scopes: discovered.scopes,
    verificationUriFallback: discovered.verificationEndpoint,
    signal: interaction.signal,
    fetch: fetchImplementation,
  });
  await interaction.showDeviceCode({
    userCode: authorization.userCode,
    verificationUri: authorization.verificationUriComplete ?? authorization.verificationUri,
    intervalSeconds: authorization.intervalSeconds,
    expiresInSeconds: authorization.expiresInSeconds,
  });
  return await pollDeviceToken({
    tokenEndpoint: discovered.tokenEndpoint,
    clientId: discovered.clientId,
    deviceCode: authorization.deviceCode,
    expiresInSeconds: authorization.expiresInSeconds,
    intervalSeconds: authorization.intervalSeconds,
    grantType: discovered.deviceCodeGrantType,
    signal: interaction.signal,
    fetch: fetchImplementation,
    now,
    ...(sleep === undefined ? {} : { sleep }),
  });
}

/** Create a trusted OAuth method whose public-client endpoints come from a gateway. */
export function createGatewayManagedOAuth(options: GatewayManagedOAuthOptions): ProviderManagedOAuthAuthMethod {
  const gateway = gatewayRoot(options.gatewayUrl);
  const fetchImplementation = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  return {
    kind: "managed_oauth",
    id: "gateway",
    label: `Sign in to ${options.name}`,
    detail: "Gateway-discovered browser or device authorization",
    async login(interaction) {
      interaction.signal.throwIfAborted();
      const discovered = await discover(gateway, fetchImplementation, interaction.signal);
      const selected = await interaction.select({
        message: `Sign in to ${options.name}`,
        options: [
          { id: "browser", label: "Browser sign-in", detail: "Recommended" },
          { id: "device", label: "Device code", detail: "Use another device" },
        ],
      });
      if (selected !== "browser" && selected !== "device") throw new Error("Gateway OAuth login was cancelled");
      const token = selected === "browser"
        ? await browserLogin(discovered, interaction, fetchImplementation)
        : await deviceLogin(discovered, interaction, fetchImplementation, now, options.sleep);
      return managedCredential(token, discovered, now());
    },
    async refresh(credential, signal) {
      signal.throwIfAborted();
      if (credential.refreshToken === undefined) throw new Error("Gateway OAuth credential has no refresh token");
      const discovered = await discover(gateway, fetchImplementation, signal);
      const token = await refreshToken(discovered, credential.refreshToken, fetchImplementation, signal);
      return managedCredential(token, discovered, now());
    },
    getApiKey: (credential) => credential.accessToken,
  };
}
