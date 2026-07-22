import type { ModelProtocolFamily, ProviderId } from "../core/types.js";
import type { ProviderApiKeyAuth } from "./models.js";

export interface BuiltinProviderDescriptor {
  id: ProviderId;
  name: string;
  baseUrl?: string;
  apis: readonly ModelProtocolFamily[];
  environment: readonly string[];
  oauth?: true;
  ambient?: "aws" | "google";
}

function descriptor(
  id: ProviderId,
  name: string,
  apis: readonly ModelProtocolFamily[],
  environment: readonly string[],
  options: Omit<BuiltinProviderDescriptor, "id" | "name" | "apis" | "environment"> = {},
): BuiltinProviderDescriptor {
  return Object.freeze({ id, name, apis: Object.freeze([...apis]), environment: Object.freeze([...environment]), ...options });
}

const chat = ["openai-chat-completions"] as const;
const responses = ["openai-responses"] as const;
const messages = ["anthropic-messages"] as const;

/** Stable public identities and request families for the built-in provider set. */
export const BUILTIN_PROVIDER_DESCRIPTORS: readonly BuiltinProviderDescriptor[] = Object.freeze([
  descriptor("amazon-bedrock", "Amazon Bedrock", ["bedrock-converse"], ["AWS_BEARER_TOKEN_BEDROCK", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_WEB_IDENTITY_TOKEN_FILE"], { ambient: "aws" }),
  descriptor("ant-ling", "Ant Ling", chat, ["ANT_LING_API_KEY"], { baseUrl: "https://api.ant-ling.com/v1" }),
  descriptor("anthropic", "Anthropic", messages, ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"], { baseUrl: "https://api.anthropic.com", oauth: true }),
  descriptor("google", "Google", ["gemini-generate-content"], ["GEMINI_API_KEY"], { baseUrl: "https://generativelanguage.googleapis.com/v1beta" }),
  descriptor("google-vertex", "Google Vertex AI", ["gemini-generate-content"], ["GOOGLE_CLOUD_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"], { ambient: "google" }),
  descriptor("openai", "OpenAI", responses, ["OPENAI_API_KEY"], { baseUrl: "https://api.openai.com/v1" }),
  descriptor("azure-openai-responses", "Azure OpenAI", responses, ["AZURE_OPENAI_API_KEY"]),
  descriptor("openai-codex", "OpenAI Codex", responses, [], { baseUrl: "https://chatgpt.com/backend-api", oauth: true }),
  descriptor("radius", "Radius", ["gateway-messages"], ["RADIUS_API_KEY", "RADIUS_GATEWAY"], { oauth: true }),
  descriptor("nvidia", "NVIDIA", chat, ["NVIDIA_API_KEY"], { baseUrl: "https://integrate.api.nvidia.com/v1" }),
  descriptor("deepseek", "DeepSeek", chat, ["DEEPSEEK_API_KEY"], { baseUrl: "https://api.deepseek.com" }),
  descriptor("github-copilot", "GitHub Copilot", ["anthropic-messages", "openai-chat-completions", "openai-responses"], ["COPILOT_GITHUB_TOKEN"], { baseUrl: "https://api.individual.githubcopilot.com", oauth: true }),
  descriptor("xai", "xAI", ["openai-chat-completions", "openai-responses"], ["XAI_API_KEY"], { baseUrl: "https://api.x.ai/v1", oauth: true }),
  descriptor("groq", "Groq", chat, ["GROQ_API_KEY"], { baseUrl: "https://api.groq.com/openai/v1" }),
  descriptor("cerebras", "Cerebras", chat, ["CEREBRAS_API_KEY"], { baseUrl: "https://api.cerebras.ai/v1" }),
  descriptor("openrouter", "OpenRouter", chat, ["OPENROUTER_API_KEY"], { baseUrl: "https://openrouter.ai/api/v1" }),
  descriptor("vercel-ai-gateway", "Vercel AI Gateway", messages, ["AI_GATEWAY_API_KEY"], { baseUrl: "https://ai-gateway.vercel.sh" }),
  descriptor("zai", "Z.AI", chat, ["ZAI_API_KEY"], { baseUrl: "https://api.z.ai/api/coding/paas/v4" }),
  descriptor("zai-coding-cn", "Z.AI Coding CN", chat, ["ZAI_CODING_CN_API_KEY"], { baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" }),
  descriptor("mistral", "Mistral", ["mistral-conversations"], ["MISTRAL_API_KEY"], { baseUrl: "https://api.mistral.ai" }),
  descriptor("minimax", "MiniMax", messages, ["MINIMAX_API_KEY"], { baseUrl: "https://api.minimax.io/anthropic" }),
  descriptor("minimax-cn", "MiniMax CN", messages, ["MINIMAX_CN_API_KEY"], { baseUrl: "https://api.minimaxi.com/anthropic" }),
  descriptor("moonshotai", "Moonshot AI", chat, ["MOONSHOT_API_KEY"], { baseUrl: "https://api.moonshot.ai/v1" }),
  descriptor("moonshotai-cn", "Moonshot AI CN", chat, ["MOONSHOT_API_KEY"], { baseUrl: "https://api.moonshot.cn/v1" }),
  descriptor("huggingface", "Hugging Face", chat, ["HF_TOKEN"], { baseUrl: "https://router.huggingface.co/v1" }),
  descriptor("fireworks", "Fireworks", ["anthropic-messages", "openai-chat-completions"], ["FIREWORKS_API_KEY"], { baseUrl: "https://api.fireworks.ai/inference" }),
  descriptor("together", "Together", chat, ["TOGETHER_API_KEY"], { baseUrl: "https://api.together.ai/v1" }),
  descriptor("opencode", "OpenCode Zen", ["anthropic-messages", "gemini-generate-content", "openai-chat-completions", "openai-responses"], ["OPENCODE_API_KEY"]),
  descriptor("opencode-go", "OpenCode Zen Go", ["anthropic-messages", "openai-chat-completions", "openai-responses"], ["OPENCODE_API_KEY"]),
  descriptor("kimi-coding", "Kimi For Coding", messages, ["KIMI_API_KEY"], { baseUrl: "https://api.kimi.com/coding", oauth: true }),
  descriptor("cloudflare-workers-ai", "Cloudflare Workers AI", chat, ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"]),
  descriptor("cloudflare-ai-gateway", "Cloudflare AI Gateway", ["anthropic-messages", "openai-chat-completions", "openai-responses"], ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"]),
  descriptor("qwen-token-plan", "Qwen Token Plan", chat, ["QWEN_TOKEN_PLAN_API_KEY"], { baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1" }),
  descriptor("qwen-token-plan-cn", "Qwen Token Plan CN", chat, ["QWEN_TOKEN_PLAN_CN_API_KEY"], { baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1" }),
  descriptor("xiaomi", "Xiaomi", chat, ["XIAOMI_API_KEY"], { baseUrl: "https://api.xiaomimimo.com/v1" }),
  descriptor("xiaomi-token-plan-cn", "Xiaomi Token Plan CN", chat, ["XIAOMI_TOKEN_PLAN_CN_API_KEY"], { baseUrl: "https://token-plan-cn.xiaomimimo.com/v1" }),
  descriptor("xiaomi-token-plan-ams", "Xiaomi Token Plan AMS", chat, ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"], { baseUrl: "https://token-plan-ams.xiaomimimo.com/v1" }),
  descriptor("xiaomi-token-plan-sgp", "Xiaomi Token Plan SGP", chat, ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"], { baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1" }),
]);

const descriptors = new Map(BUILTIN_PROVIDER_DESCRIPTORS.map((entry) => [entry.id, entry]));

export function getBuiltinProviderDescriptor(id: string): BuiltinProviderDescriptor | undefined {
  return descriptors.get(id);
}

export function canonicalProviderId(id: string): string {
  if (id === "bedrock") return "amazon-bedrock";
  if (id === "gemini") return "google";
  if (id === "vertex") return "google-vertex";
  if (id === "azure-openai") return "azure-openai-responses";
  return id;
}

export function environmentProviderAuth(descriptor: BuiltinProviderDescriptor): ProviderApiKeyAuth {
  return {
    name: `${descriptor.name} credentials`,
    async login(interaction) {
      if (descriptor.environment.length === 0) {
        throw new Error(`${descriptor.name} does not support API-key login`);
      }
      return {
        type: "api_key",
        key: await interaction.prompt({ type: "secret", message: `Enter ${descriptor.name} API key` }),
      };
    },
    async resolve({ ctx, credential }) {
      if (credential?.key !== undefined) {
        return {
          auth: { apiKey: credential.key },
          ...(credential.env === undefined ? {} : { env: credential.env }),
          source: "stored credential",
        };
      }
      for (const variable of descriptor.environment) {
        const value = await ctx.env(variable);
        if (value !== undefined && /(?:KEY|TOKEN)$/u.test(variable)) {
          return { auth: { apiKey: value }, source: variable };
        }
      }
      return undefined;
    },
  };
}
