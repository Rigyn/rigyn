export const OAUTH_CLIENT_ID_ENVIRONMENT = Object.freeze({
  "openai-codex": "RIGYN_OPENAI_CODEX_OAUTH_CLIENT_ID",
  anthropic: "RIGYN_ANTHROPIC_OAUTH_CLIENT_ID",
  "github-copilot": "RIGYN_GITHUB_COPILOT_OAUTH_CLIENT_ID",
  "kimi-code": "RIGYN_KIMI_CODE_OAUTH_CLIENT_ID",
  xai: "RIGYN_XAI_OAUTH_CLIENT_ID",
} as const);

export type ExplicitOAuthProvider = keyof typeof OAUTH_CLIENT_ID_ENVIRONMENT;

/** Public native-client registrations used by the supported provider account flows. */
export const DEFAULT_OAUTH_CLIENT_IDS: Readonly<Record<ExplicitOAuthProvider, string>> = Object.freeze({
  "openai-codex": "app_EMoamEEZ73f0CkXaXp7hrann",
  anthropic: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "github-copilot": "Iv1.b507a08c87ecfe98",
  "kimi-code": "17e5f671-d194-4dfb-9706-5516cb48c098",
  xai: "b1a00492-073a-47ea-816f-4c329264a828",
});

const MAX_CLIENT_ID_BYTES = 512;

export function validateOAuthClientId(value: unknown, label = "OAuth client ID"): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > MAX_CLIENT_ID_BYTES ||
    !/^[\x21-\x7e]+$/u.test(value)
  ) {
    throw new TypeError(`${label} must contain 1 through ${MAX_CLIENT_ID_BYTES} visible ASCII characters`);
  }
  return value;
}

export function configuredOAuthClientId(
  provider: ExplicitOAuthProvider,
  environment: NodeJS.ProcessEnv,
): string {
  const variable = OAUTH_CLIENT_ID_ENVIRONMENT[provider];
  const value = environment[variable];
  return value === undefined
    ? DEFAULT_OAUTH_CLIENT_IDS[provider]
    : validateOAuthClientId(value, variable);
}
