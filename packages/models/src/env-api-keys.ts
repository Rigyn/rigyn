import type { ProviderEnv } from "./types.js";
import { getProviderEnvValue } from "./utils/provider-env.js";

const API_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "ant-ling": ["ANT_LING_API_KEY"], anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  "azure-openai-responses": ["AZURE_OPENAI_API_KEY"], cerebras: ["CEREBRAS_API_KEY"],
  "cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY"], "cloudflare-workers-ai": ["CLOUDFLARE_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"], fireworks: ["FIREWORKS_API_KEY"], "github-copilot": ["COPILOT_GITHUB_TOKEN"],
  google: ["GEMINI_API_KEY"], "google-vertex": ["GOOGLE_CLOUD_API_KEY"], groq: ["GROQ_API_KEY"],
  huggingface: ["HF_TOKEN"], "kimi-coding": ["KIMI_API_KEY"], minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_CN_API_KEY"], mistral: ["MISTRAL_API_KEY"], moonshotai: ["MOONSHOT_API_KEY"],
  "moonshotai-cn": ["MOONSHOT_API_KEY"], nvidia: ["NVIDIA_API_KEY"], openai: ["OPENAI_API_KEY"],
  opencode: ["OPENCODE_API_KEY"], "opencode-go": ["OPENCODE_API_KEY"], openrouter: ["OPENROUTER_API_KEY"],
  "qwen-token-plan": ["QWEN_TOKEN_PLAN_API_KEY"], "qwen-token-plan-cn": ["QWEN_TOKEN_PLAN_CN_API_KEY"],
  together: ["TOGETHER_API_KEY"], "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"], xai: ["XAI_API_KEY"],
  xiaomi: ["XIAOMI_API_KEY"], "xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
  "xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"], "xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
  zai: ["ZAI_API_KEY"], "zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
});

export function findEnvKeys(provider: string, env?: ProviderEnv): string[] | undefined {
  const found = (API_KEYS[provider] ?? []).filter((name) => getProviderEnvValue(name, env) !== undefined);
  return found.length === 0 ? undefined : found;
}

export function getEnvApiKey(provider: string, env?: ProviderEnv): string | undefined {
  const key = findEnvKeys(provider, env)?.[0];
  if (key) return getProviderEnvValue(key, env);
  if (provider === "amazon-bedrock") {
    if (getProviderEnvValue("AWS_PROFILE", env)
      || getProviderEnvValue("AWS_BEARER_TOKEN_BEDROCK", env)
      || getProviderEnvValue("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", env)
      || getProviderEnvValue("AWS_CONTAINER_CREDENTIALS_FULL_URI", env)
      || getProviderEnvValue("AWS_WEB_IDENTITY_TOKEN_FILE", env)
      || (getProviderEnvValue("AWS_ACCESS_KEY_ID", env) && getProviderEnvValue("AWS_SECRET_ACCESS_KEY", env))) return "<authenticated>";
  }
  if (provider === "google-vertex") {
    const project = getProviderEnvValue("GOOGLE_CLOUD_PROJECT", env) ?? getProviderEnvValue("GCLOUD_PROJECT", env);
    if (project && getProviderEnvValue("GOOGLE_CLOUD_LOCATION", env)
      && getProviderEnvValue("GOOGLE_APPLICATION_CREDENTIALS", env)) return "<authenticated>";
  }
  return undefined;
}
