import type { OAuthRegistrationConfig } from "./registry.js";

/** Public native-client registration used by xAI's device authorization flow. */
export const XAI_OAUTH_REGISTRATION_ID = "rigyn.xai.subscription";

export const XAI_OAUTH_REGISTRATION: OAuthRegistrationConfig = Object.freeze({
  provider: "xai",
  flow: "device",
  clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  deviceEndpoint: "https://auth.x.ai/oauth2/device/code",
  tokenEndpoint: "https://auth.x.ai/oauth2/token",
  scopes: ["openid", "profile", "email", "offline_access", "grok-cli:access", "api:access"],
  deviceParameters: { referrer: "rigyn" },
  label: "Sign in with SuperGrok or X Premium",
});
