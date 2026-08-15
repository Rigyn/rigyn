import type { OAuthRegistrationConfig } from "./registry.js";
import { validateOAuthClientId } from "./oauth-client-registration.js";
import { KIMI_CODE_OAUTH_TOKEN_ENDPOINT } from "./builtin-oauth-refresh.js";

export const KIMI_CODE_OAUTH_REGISTRATION_ID = "rigyn.kimi-code.account";
export { KIMI_CODE_OAUTH_TOKEN_ENDPOINT } from "./builtin-oauth-refresh.js";

/** Creates the public Kimi Code device registration used by the account flow. */
export function kimiCodeOAuthRegistration(clientId: string): OAuthRegistrationConfig {
  return {
    provider: "kimi-code",
    flow: "device",
    clientId: validateOAuthClientId(clientId, "Kimi Code OAuth client ID"),
    deviceEndpoint: "https://auth.kimi.com/api/oauth/device_authorization",
    tokenEndpoint: KIMI_CODE_OAUTH_TOKEN_ENDPOINT,
    scopes: [],
    label: "Sign in with Kimi Code",
    requireRefreshToken: true,
  };
}
