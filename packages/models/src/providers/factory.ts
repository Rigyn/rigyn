import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.js";
import { azureOpenAIResponsesApi } from "../api/azure-openai-responses.lazy.js";
import { bedrockConverseStreamApi } from "../api/bedrock-converse-stream.lazy.js";
import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.js";
import { googleVertexApi } from "../api/google-vertex.lazy.js";
import { mistralConversationsApi } from "../api/mistral-conversations.lazy.js";
import { openAICodexResponsesApi } from "../api/openai-codex-responses.lazy.js";
import { openAICompletionsApi } from "../api/openai-completions.lazy.js";
import { openAIResponsesApi } from "../api/openai-responses.lazy.js";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.js";
import { loadAnthropicOAuth, loadGitHubCopilotOAuth, loadOpenAICodexOAuth, loadXaiOAuth } from "../auth/oauth/load.js";
import type { ApiKeyAuth, ProviderAuth } from "../auth/types.js";
import { BUILTIN_MODEL_CATALOG } from "../models.generated.js";
import { createProvider, type Provider } from "../models.js";
import type { Api, Model, ProviderStreams } from "../types.js";
import { cloudflareAIGatewayAuth, cloudflareWorkersAIAuth } from "./cloudflare-auth.js";
import { cloudflareStreams } from "./cloudflare-stream.js";

interface ProviderMetadata {
  name: string;
  apis: readonly Api[];
  environment?: readonly string[];
  baseUrl?: string;
  oauth?: "anthropic" | "github-copilot" | "openai-codex" | "xai";
  auth?: () => ApiKeyAuth;
}

const completions = ["openai-completions"] as const;
const messages = ["anthropic-messages"] as const;
const responses = ["openai-responses"] as const;

const METADATA: Readonly<Record<string, ProviderMetadata>> = Object.freeze({
  "amazon-bedrock": { name: "Amazon Bedrock", apis: ["bedrock-converse-stream"], auth: bedrockAuth },
  "ant-ling": { name: "Ant Ling", apis: completions, environment: ["ANT_LING_API_KEY"], baseUrl: "https://api.ant-ling.com/v1" },
  anthropic: { name: "Anthropic", apis: messages, environment: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"], baseUrl: "https://api.anthropic.com", oauth: "anthropic" },
  "azure-openai-responses": { name: "Azure OpenAI", apis: ["azure-openai-responses"], environment: ["AZURE_OPENAI_API_KEY"] },
  cerebras: { name: "Cerebras", apis: completions, environment: ["CEREBRAS_API_KEY"], baseUrl: "https://api.cerebras.ai/v1" },
  "cloudflare-ai-gateway": { name: "Cloudflare AI Gateway", apis: ["anthropic-messages", "openai-completions", "openai-responses"], auth: cloudflareAIGatewayAuth },
  "cloudflare-workers-ai": { name: "Cloudflare Workers AI", apis: completions, auth: cloudflareWorkersAIAuth },
  deepseek: { name: "DeepSeek", apis: completions, environment: ["DEEPSEEK_API_KEY"], baseUrl: "https://api.deepseek.com" },
  fireworks: { name: "Fireworks", apis: ["anthropic-messages", "openai-completions"], environment: ["FIREWORKS_API_KEY"], baseUrl: "https://api.fireworks.ai/inference" },
  "github-copilot": { name: "GitHub Copilot", apis: ["anthropic-messages", "openai-completions", "openai-responses"], environment: ["COPILOT_GITHUB_TOKEN"], baseUrl: "https://api.individual.githubcopilot.com", oauth: "github-copilot" },
  google: { name: "Google", apis: ["google-generative-ai"], environment: ["GEMINI_API_KEY"], baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
  "google-vertex": { name: "Google Vertex AI", apis: ["google-vertex"], auth: vertexAuth },
  groq: { name: "Groq", apis: completions, environment: ["GROQ_API_KEY"], baseUrl: "https://api.groq.com/openai/v1" },
  huggingface: { name: "Hugging Face", apis: completions, environment: ["HF_TOKEN"], baseUrl: "https://router.huggingface.co/v1" },
  "kimi-coding": { name: "Kimi For Coding", apis: messages, environment: ["KIMI_API_KEY"], baseUrl: "https://api.kimi.com/coding" },
  minimax: { name: "MiniMax", apis: messages, environment: ["MINIMAX_API_KEY"], baseUrl: "https://api.minimax.io/anthropic" },
  "minimax-cn": { name: "MiniMax CN", apis: messages, environment: ["MINIMAX_CN_API_KEY"], baseUrl: "https://api.minimaxi.com/anthropic" },
  mistral: { name: "Mistral", apis: ["mistral-conversations"], environment: ["MISTRAL_API_KEY"], baseUrl: "https://api.mistral.ai" },
  moonshotai: { name: "Moonshot AI", apis: completions, environment: ["MOONSHOT_API_KEY"], baseUrl: "https://api.moonshot.ai/v1" },
  "moonshotai-cn": { name: "Moonshot AI CN", apis: completions, environment: ["MOONSHOT_API_KEY"], baseUrl: "https://api.moonshot.cn/v1" },
  nvidia: { name: "NVIDIA", apis: completions, environment: ["NVIDIA_API_KEY"], baseUrl: "https://integrate.api.nvidia.com/v1" },
  openai: { name: "OpenAI", apis: responses, environment: ["OPENAI_API_KEY"], baseUrl: "https://api.openai.com/v1" },
  "openai-codex": { name: "OpenAI Codex", apis: ["openai-codex-responses"], baseUrl: "https://chatgpt.com/backend-api", oauth: "openai-codex" },
  opencode: { name: "OpenCode Zen", apis: ["anthropic-messages", "google-generative-ai", "openai-completions", "openai-responses"], environment: ["OPENCODE_API_KEY"] },
  "opencode-go": { name: "OpenCode Zen Go", apis: ["anthropic-messages", "openai-completions", "openai-responses"], environment: ["OPENCODE_API_KEY"] },
  openrouter: { name: "OpenRouter", apis: completions, environment: ["OPENROUTER_API_KEY"], baseUrl: "https://openrouter.ai/api/v1" },
  "qwen-token-plan": { name: "Qwen Token Plan", apis: completions, environment: ["QWEN_TOKEN_PLAN_API_KEY"], baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1" },
  "qwen-token-plan-cn": { name: "Qwen Token Plan CN", apis: completions, environment: ["QWEN_TOKEN_PLAN_CN_API_KEY"], baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1" },
  together: { name: "Together", apis: completions, environment: ["TOGETHER_API_KEY"], baseUrl: "https://api.together.ai/v1" },
  "vercel-ai-gateway": { name: "Vercel AI Gateway", apis: messages, environment: ["AI_GATEWAY_API_KEY"], baseUrl: "https://ai-gateway.vercel.sh" },
  xai: { name: "xAI", apis: ["openai-completions", "openai-responses"], environment: ["XAI_API_KEY"], baseUrl: "https://api.x.ai/v1", oauth: "xai" },
  xiaomi: { name: "Xiaomi", apis: completions, environment: ["XIAOMI_API_KEY"], baseUrl: "https://api.xiaomimimo.com/v1" },
  "xiaomi-token-plan-ams": { name: "Xiaomi Token Plan AMS", apis: completions, environment: ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"], baseUrl: "https://token-plan-ams.xiaomimimo.com/v1" },
  "xiaomi-token-plan-cn": { name: "Xiaomi Token Plan CN", apis: completions, environment: ["XIAOMI_TOKEN_PLAN_CN_API_KEY"], baseUrl: "https://token-plan-cn.xiaomimimo.com/v1" },
  "xiaomi-token-plan-sgp": { name: "Xiaomi Token Plan SGP", apis: completions, environment: ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"], baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1" },
  zai: { name: "Z.AI", apis: completions, environment: ["ZAI_API_KEY"], baseUrl: "https://api.z.ai/api/coding/paas/v4" },
  "zai-coding-cn": { name: "Z.AI Coding CN", apis: completions, environment: ["ZAI_CODING_CN_API_KEY"], baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" },
});

function apiStreams(api: Api): ProviderStreams {
  switch (api) {
    case "anthropic-messages": return anthropicMessagesApi();
    case "azure-openai-responses": return azureOpenAIResponsesApi();
    case "bedrock-converse-stream": return bedrockConverseStreamApi();
    case "google-generative-ai": return googleGenerativeAIApi();
    case "google-vertex": return googleVertexApi();
    case "mistral-conversations": return mistralConversationsApi();
    case "openai-codex-responses": return openAICodexResponsesApi();
    case "openai-completions": return openAICompletionsApi();
    case "openai-responses": return openAIResponsesApi();
    default: throw new Error(`No built-in transport for ${api}`);
  }
}

function oauth(kind: ProviderMetadata["oauth"]): ProviderAuth["oauth"] {
  if (kind === "anthropic") return lazyOAuth({ name: "Anthropic subscription", load: loadAnthropicOAuth });
  if (kind === "github-copilot") return lazyOAuth({ name: "GitHub Copilot", load: loadGitHubCopilotOAuth });
  if (kind === "openai-codex") return lazyOAuth({ name: "OpenAI subscription", load: loadOpenAICodexOAuth });
  if (kind === "xai") return lazyOAuth({ name: "xAI subscription", loginLabel: "Sign in with your xAI account", load: loadXaiOAuth });
  return undefined;
}

function authFor(metadata: ProviderMetadata): ProviderAuth {
  const oauthMethod = metadata.oauth === undefined ? undefined : oauth(metadata.oauth);
  return {
    ...(metadata.auth === undefined ? {} : { apiKey: metadata.auth() }),
    ...(metadata.environment === undefined ? {} : { apiKey: envApiKeyAuth(`${metadata.name} API key`, metadata.environment) }),
    ...(oauthMethod === undefined ? {} : { oauth: oauthMethod }),
  };
}

export function getBuiltinProviderIds(): string[] { return Object.keys(METADATA); }
export function getBuiltinProviderModels(provider: string): readonly Model<Api>[] { return BUILTIN_MODEL_CATALOG.filter((model) => model.provider === provider); }

export function createBuiltinProvider(providerId: string): Provider {
  const metadata = METADATA[providerId];
  if (!metadata) throw new Error(`Unknown built-in provider: ${providerId}`);
  const models = getBuiltinProviderModels(providerId);
  const implementations: Partial<Record<Api, ProviderStreams>> = {};
  for (const api of metadata.apis) {
    const implementation = apiStreams(api);
    implementations[api] = providerId.startsWith("cloudflare-") ? cloudflareStreams(implementation) : implementation;
  }
  return createProvider({
    id: providerId,
    name: metadata.name,
    ...(metadata.baseUrl === undefined ? {} : { baseUrl: metadata.baseUrl }),
    auth: authFor(metadata),
    models,
    ...(providerId === "github-copilot" ? { filterModels: (entries: readonly Model<Api>[], credential: import("../auth/types.js").Credential | undefined) => {
      if (credential?.type !== "oauth" || !Array.isArray(credential.availableModelIds) || !credential.availableModelIds.every((id) => typeof id === "string")) return entries;
      const available = new Set(credential.availableModelIds);
      return entries.filter((model) => available.has(model.id));
    } } : {}),
    api: implementations,
  });
}

function bedrockAuth(): ApiKeyAuth {
  return {
    name: "AWS credentials or bearer token",
    async login(interaction) {
      const method = await interaction.prompt({ type: "select", message: "Select Amazon Bedrock authentication method", options: [
        { id: "bearer-token", label: "Bearer token" }, { id: "aws-profile", label: "AWS profile" }, { id: "credential-chain", label: "Existing AWS credential chain" },
      ] });
      if (method === "bearer-token") return { type: "api_key", key: await interaction.prompt({ type: "secret", message: "Enter Amazon Bedrock bearer token" }) };
      if (method === "aws-profile") return { type: "api_key", env: { AWS_PROFILE: await interaction.prompt({ type: "text", message: "Enter AWS profile name" }) } };
      if (method !== "credential-chain") throw new Error(`Unknown Amazon Bedrock authentication method: ${method}`);
      interaction.notify({ type: "info", message: "Configure AWS credentials, then continue." });
      await interaction.prompt({ type: "text", message: "Press Enter after configuring AWS credentials" });
      return { type: "api_key" };
    },
    async resolve({ ctx, credential }) {
      if (credential?.key) return { auth: { apiKey: credential.key }, source: "stored credential", ...(credential.env ? { env: credential.env } : {}) };
      const profile = credential?.env?.AWS_PROFILE ?? await ctx.env("AWS_PROFILE");
      if (profile) return { auth: {}, env: { ...(credential?.env ?? {}), AWS_PROFILE: profile }, source: credential?.env?.AWS_PROFILE ? "stored credential" : "AWS_PROFILE" };
      if (await ctx.env("AWS_BEARER_TOKEN_BEDROCK")) return { auth: {}, source: "AWS_BEARER_TOKEN_BEDROCK" };
      if (await ctx.env("AWS_ACCESS_KEY_ID") && await ctx.env("AWS_SECRET_ACCESS_KEY")) return { auth: {}, source: "AWS access keys" };
      if (await ctx.env("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") || await ctx.env("AWS_CONTAINER_CREDENTIALS_FULL_URI")) return { auth: {}, source: "AWS container credentials" };
      if (await ctx.env("AWS_WEB_IDENTITY_TOKEN_FILE")) return { auth: {}, source: "AWS web identity" };
      return undefined;
    },
  };
}

function vertexAuth(): ApiKeyAuth {
  return {
    name: "Google Cloud credentials",
    async login(interaction) {
      const method = await interaction.prompt({ type: "select", message: "Select Google Vertex authentication method", options: [
        { id: "api-key", label: "Google Cloud API key" }, { id: "adc", label: "Application Default Credentials" }, { id: "service-account", label: "Service account credentials file" },
      ] });
      if (method === "api-key") return { type: "api_key", key: await interaction.prompt({ type: "secret", message: "Enter Google Cloud API key" }) };
      if (method !== "adc" && method !== "service-account") throw new Error(`Unknown Google Vertex authentication method: ${method}`);
      const project = await interaction.prompt({ type: "text", message: "Enter Google Cloud project ID" });
      const location = await interaction.prompt({ type: "text", message: "Enter Google Cloud location" });
      const path = method === "service-account" ? await interaction.prompt({ type: "text", message: "Enter service account credentials file path" }) : undefined;
      return { type: "api_key", env: { GOOGLE_CLOUD_PROJECT: project, GOOGLE_CLOUD_LOCATION: location, ...(path ? { GOOGLE_APPLICATION_CREDENTIALS: path } : {}) } };
    },
    async resolve({ ctx, credential }) {
      const key = credential?.key ?? await ctx.env("GOOGLE_CLOUD_API_KEY");
      if (key) return { auth: { apiKey: key }, source: credential?.key ? "stored credential" : "GOOGLE_CLOUD_API_KEY", ...(credential?.env ? { env: credential.env } : {}) };
      const credentials = credential?.env?.GOOGLE_APPLICATION_CREDENTIALS ?? await ctx.env("GOOGLE_APPLICATION_CREDENTIALS");
      const present = await ctx.fileExists(credentials ?? "~/.config/gcloud/application_default_credentials.json");
      const project = credential?.env?.GOOGLE_CLOUD_PROJECT ?? await ctx.env("GOOGLE_CLOUD_PROJECT") ?? await ctx.env("GCLOUD_PROJECT");
      const location = credential?.env?.GOOGLE_CLOUD_LOCATION ?? await ctx.env("GOOGLE_CLOUD_LOCATION");
      return present && project && location ? { auth: {}, env: { ...(credential?.env ?? {}), GOOGLE_CLOUD_PROJECT: project, GOOGLE_CLOUD_LOCATION: location, ...(credentials ? { GOOGLE_APPLICATION_CREDENTIALS: credentials } : {}) }, source: credential ? "stored credential" : "application default credentials" } : undefined;
    },
  };
}
