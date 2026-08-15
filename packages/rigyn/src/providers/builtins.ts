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
  descriptor("anthropic", "Anthropic", messages, ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"], { baseUrl: "https://api.anthropic.com", oauth: true }),
  descriptor("google", "Google", ["gemini-generate-content"], ["GEMINI_API_KEY"], { baseUrl: "https://generativelanguage.googleapis.com/v1beta" }),
  descriptor("openai", "OpenAI", responses, ["OPENAI_API_KEY"], { baseUrl: "https://api.openai.com/v1" }),
  descriptor("openai-codex", "OpenAI Codex", responses, [], { baseUrl: "https://chatgpt.com/backend-api", oauth: true }),
  descriptor("deepseek", "DeepSeek", chat, ["DEEPSEEK_API_KEY"], { baseUrl: "https://api.deepseek.com" }),
  descriptor("kimi-code", "Kimi Code", chat, ["KIMI_CODE_API_KEY"], { baseUrl: "https://api.kimi.com/coding/v1", oauth: true }),
  descriptor("github-copilot", "GitHub Copilot", ["anthropic-messages", "openai-chat-completions", "openai-responses"], ["COPILOT_GITHUB_TOKEN"], { baseUrl: "https://api.individual.githubcopilot.com", oauth: true }),
  descriptor("xai", "xAI", responses, ["XAI_API_KEY"], { baseUrl: "https://api.x.ai/v1", oauth: true }),
  descriptor("openrouter", "OpenRouter", chat, ["OPENROUTER_API_KEY"], { baseUrl: "https://openrouter.ai/api/v1", oauth: true }),
  descriptor("opencode", "OpenCode Zen", ["anthropic-messages", "gemini-generate-content", "openai-chat-completions", "openai-responses"], ["OPENCODE_API_KEY"]),
  descriptor("opencode-go", "OpenCode Go", ["anthropic-messages", "openai-chat-completions", "openai-responses"], ["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"]),
  descriptor("ollama", "Ollama", ["ollama-chat"], ["OLLAMA_API_KEY"]),
]);

const descriptors = new Map(BUILTIN_PROVIDER_DESCRIPTORS.map((entry) => [entry.id, entry]));

export function getBuiltinProviderDescriptor(id: string): BuiltinProviderDescriptor | undefined {
  return descriptors.get(id);
}

export function canonicalProviderId(id: string): string {
  if (id === "gemini") return "google";
  return id;
}

export function environmentProviderAuth(descriptor: BuiltinProviderDescriptor): ProviderApiKeyAuth {
  return {
    name: `${descriptor.name} credentials`,
    async login(interaction) {
      if (descriptor.environment.length === 0) {
        throw new Error(`${descriptor.name} does not support API-key login`);
      }
      const key = await interaction.prompt({ type: "secret", message: `Enter ${descriptor.name} API key` });
      return {
        type: "api_key",
        key,
      };
    },
    async resolve({ ctx, credential }) {
      if (credential?.key !== undefined) {
        return {
          auth: descriptor.id === "anthropic" && credential.key.startsWith("sk-ant-oat")
            ? { headers: { Authorization: `Bearer ${credential.key}` } }
            : { apiKey: credential.key },
          ...(credential.env === undefined ? {} : { env: credential.env }),
          source: "stored credential",
        };
      }
      for (const variable of descriptor.environment) {
        const value = await ctx.env(variable);
        if (value !== undefined && /(?:KEY|TOKEN)$/u.test(variable)) {
          return {
            auth: variable === "ANTHROPIC_AUTH_TOKEN" || variable === "ANTHROPIC_OAUTH_TOKEN"
              ? { headers: { Authorization: `Bearer ${value}` } }
              : { apiKey: value },
            source: variable,
          };
        }
      }
      return undefined;
    },
  };
}
