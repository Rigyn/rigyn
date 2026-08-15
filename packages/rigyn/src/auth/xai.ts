import type { OAuthRegistrationConfig } from "./registry.js";
import { validateOAuthClientId } from "./oauth-client-registration.js";
import { XAI_OAUTH_TOKEN_ENDPOINT } from "./builtin-oauth-refresh.js";

export const XAI_OAUTH_REGISTRATION_ID = "rigyn.xai.subscription";
export { XAI_OAUTH_TOKEN_ENDPOINT } from "./builtin-oauth-refresh.js";

/** Creates an xAI device registration for a client owned or reviewed by the caller. */
export function xaiOAuthRegistration(clientId: string): OAuthRegistrationConfig {
  return {
    provider: "xai",
    flow: "device",
    clientId: validateOAuthClientId(clientId, "xAI OAuth client ID"),
    deviceEndpoint: "https://auth.x.ai/oauth2/device/code",
    tokenEndpoint: XAI_OAUTH_TOKEN_ENDPOINT,
    scopes: ["openid", "profile", "email", "offline_access", "api:access"],
    label: "Sign in with xAI",
    requireRefreshToken: true,
  };
}
