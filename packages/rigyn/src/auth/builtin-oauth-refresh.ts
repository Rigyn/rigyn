import { configuredOAuthClientId } from "./oauth-client-registration.js";
import type { OAuthCredential } from "./types.js";

export const KIMI_CODE_OAUTH_TOKEN_ENDPOINT = "https://auth.kimi.com/api/oauth/token";
export const XAI_OAUTH_TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";

export function pinnedBuiltinOAuthRefreshCredential(
  provider: "kimi-code" | "xai",
  credential: OAuthCredential,
  environment: NodeJS.ProcessEnv,
): OAuthCredential & { tokenEndpoint: string; clientId: string } {
  return {
    ...credential,
    tokenEndpoint: provider === "kimi-code" ? KIMI_CODE_OAUTH_TOKEN_ENDPOINT : XAI_OAUTH_TOKEN_ENDPOINT,
    clientId: configuredOAuthClientId(provider, environment),
  };
}
