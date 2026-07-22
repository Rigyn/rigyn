import type { ConfiguredModel, ConfiguredModelPricing, ModelReasoningEffort } from "./registry.js";

// Maintained entries are deliberately conservative fallbacks. Provider discovery
// remains authoritative; fields omitted here stay unknown rather than being guessed.
const OPENAI_54_EFFORTS: ModelReasoningEffort[] = ["off", "low", "medium", "high", "xhigh"];
const OPENAI_56_EFFORTS: ModelReasoningEffort[] = ["off", "low", "medium", "high", "xhigh", "max"];
const ANTHROPIC_FULL_EFFORTS: ModelReasoningEffort[] = ["off", "low", "medium", "high", "xhigh", "max"];

interface ModelDefaults extends Omit<ConfiguredModel, "provider" | "id"> {}

function models(provider: string, ids: readonly string[], defaults: ModelDefaults = {}): ConfiguredModel[] {
  return ids.map((id) => ({ provider, id, metadataSource: "maintained", ...defaults }));
}

function openAiPricing(
  input: number,
  output: number,
  cacheRead: number,
  options: { longContext?: boolean } = {},
): ConfiguredModelPricing {
  const cacheWrite = input * 1.25;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(options.longContext !== true
      ? {}
      : {
          tiers: [{
            name: "over-272k-input",
            minimumInputTokens: 272_001,
            input: input * 2,
            output: output * 1.5,
            cacheRead: cacheRead * 2,
            cacheWrite: cacheWrite * 2,
          }],
        }),
  };
}

function anthropicPricing(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite5m: number,
  cacheWrite1h: number,
): ConfiguredModelPricing {
  return { input, output, cacheRead, cacheWrite: cacheWrite5m, cacheWrite5m, cacheWrite1h };
}

// Sources checked 2026-07-11:
// https://developers.openai.com/api/docs/models
const OPENAI_EXACT = [
  ...models("openai", ["o3-mini"], {
    contextTokens: 200_000,
    maxOutputTokens: 100_000,
    tools: true,
    reasoning: true,
    images: false,
    reasoningEfforts: ["low", "medium", "high"],
    pricing: { input: 1.1, output: 4.4, cacheRead: 0.55 },
  }),
  ...models("openai", ["gpt-5.6", "gpt-5.6-sol"], {
    contextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    tools: true,
    reasoning: true,
    images: true,
    reasoningEfforts: OPENAI_56_EFFORTS,
    pricing: openAiPricing(5, 30, 0.5, { longContext: true }),
  }),
  ...models("openai", ["gpt-5.6-terra"], {
    contextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    tools: true,
    reasoning: true,
    images: true,
    reasoningEfforts: OPENAI_56_EFFORTS,
    pricing: openAiPricing(2.5, 15, 0.25, { longContext: true }),
  }),
  ...models("openai", ["gpt-5.6-luna"], {
    contextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    tools: true,
    reasoning: true,
    images: true,
    reasoningEfforts: OPENAI_56_EFFORTS,
    pricing: openAiPricing(1, 6, 0.1, { longContext: true }),
  }),
  ...models("openai", ["gpt-5.4"], {
    contextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    tools: true,
    reasoning: true,
    images: true,
    reasoningEfforts: OPENAI_54_EFFORTS,
    pricing: openAiPricing(2.5, 15, 0.25, { longContext: true }),
  }),
  ...models("openai", ["gpt-5.4-mini"], {
    contextTokens: 400_000,
    maxOutputTokens: 128_000,
    tools: true,
    reasoning: true,
    images: true,
    reasoningEfforts: OPENAI_54_EFFORTS,
    pricing: openAiPricing(0.75, 4.5, 0.075),
  }),
  ...models("openai", ["gpt-5.4-nano"], {
    contextTokens: 400_000,
    maxOutputTokens: 128_000,
    tools: true,
    reasoning: true,
    images: true,
    reasoningEfforts: OPENAI_54_EFFORTS,
    pricing: openAiPricing(0.2, 1.25, 0.02),
  }),
];

const OPENAI_FALLBACK = models("openai", [
  "gpt-5",
  "gpt-5-codex",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5-pro",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.2-pro",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.4-pro",
  "gpt-5.5",
  "gpt-5.5-pro",
  "o1",
  "o1-pro",
  "o3",
  "o3-deep-research",
  "o3-pro",
  "o4-mini",
  "o4-mini-deep-research",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-5-chat-latest",
  "gpt-5.1-chat-latest",
  "gpt-5.2-chat-latest",
  "gpt-5.3-chat-latest",
]);

// Sources checked 2026-07-11:
// https://platform.claude.com/docs/en/about-claude/models/overview
// https://platform.claude.com/docs/en/about-claude/pricing
const ANTHROPIC_EXACT = [
  ...models("anthropic", ["claude-fable-5"], {
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    tools: true,
    reasoning: true,
    images: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    pricing: anthropicPricing(10, 50, 1, 12.5, 20),
  }),
  ...models("anthropic", ["claude-opus-4-8"], {
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    tools: true,
    reasoning: true,
    images: true,
    reasoningEfforts: ANTHROPIC_FULL_EFFORTS,
    pricing: anthropicPricing(5, 25, 0.5, 6.25, 10),
  }),
  ...models("anthropic", ["claude-sonnet-5"], {
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    tools: true,
    reasoning: true,
    images: true,
    reasoningEfforts: ANTHROPIC_FULL_EFFORTS,
    // Introductory price published through 2026-08-31.
    pricing: {
      ...anthropicPricing(2, 10, 0.2, 2.5, 4),
      validUntil: "2026-09-01T00:00:00.000Z",
    },
  }),
  ...models("anthropic", ["claude-haiku-4-5", "claude-haiku-4-5-20251001"], {
    contextTokens: 200_000,
    maxOutputTokens: 64_000,
    tools: true,
    reasoning: false,
    images: true,
    pricing: anthropicPricing(1, 5, 0.1, 1.25, 2),
  }),
];

const ANTHROPIC_FALLBACK = models("anthropic", [
  "claude-opus-4-1",
  "claude-opus-4-1-20250805",
  "claude-opus-4-5",
  "claude-opus-4-5-20251101",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-6",
]);

// Sources checked 2026-07-11:
// https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash
// https://ai.google.dev/gemini-api/docs/pricing
const GEMINI_EXACT = models("gemini", ["gemini-3.5-flash"], {
  contextTokens: 1_048_576,
  maxOutputTokens: 65_536,
  tools: true,
  reasoning: true,
  images: true,
  reasoningEfforts: ["minimal", "low", "medium", "high"],
  pricing: { input: 1.5, output: 9, cacheRead: 0.15 },
});

const GEMINI_FALLBACK = models("gemini", [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
  "gemini-3-flash-preview",
  "gemini-3-pro-preview",
  "gemini-3.1-flash-lite",
  "gemini-3.1-flash-lite-preview",
  "gemini-3.1-pro-preview",
  "gemini-3.1-pro-preview-customtools",
  "gemini-flash-latest",
  "gemini-flash-lite-latest",
]);

const OTHER_FALLBACKS = [
  ...models("moonshotai", [
    "kimi-k2-0711-preview",
    "kimi-k2-0905-preview",
    "kimi-k2-thinking",
    "kimi-k2-thinking-turbo",
    "kimi-k2-turbo-preview",
    "kimi-k2.5",
    "kimi-k2.6",
    "kimi-k3",
  ]),
  ...models("moonshotai", ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"], {
    reasoning: true,
    reasoningEffortMap: { off: null },
  }),
  ...models("moonshotai-cn", [
    "kimi-k2-0711-preview",
    "kimi-k2-0905-preview",
    "kimi-k2-thinking",
    "kimi-k2-thinking-turbo",
    "kimi-k2-turbo-preview",
    "kimi-k2.5",
    "kimi-k2.6",
    "kimi-k3",
  ]),
  ...models("moonshotai-cn", ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"], {
    reasoning: true,
    reasoningEffortMap: { off: null },
  }),
  ...["xiaomi", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"].flatMap((provider) => [
    ...models(provider, ["mimo-v2-pro"], {
      contextTokens: 262_144,
      maxOutputTokens: 32_768,
      tools: true,
      reasoning: true,
      images: false,
      reasoningEfforts: ["off", "high"],
    }),
    ...models(provider, ["mimo-v2.5"], {
      contextTokens: 1_000_000,
      maxOutputTokens: 128_000,
      tools: true,
      reasoning: true,
      images: true,
      reasoningEfforts: ["off", "high"],
    }),
    ...models(provider, ["mimo-v2.5-pro"], {
      contextTokens: 1_000_000,
      maxOutputTokens: 128_000,
      tools: true,
      reasoning: true,
      images: false,
      reasoningEfforts: ["off", "high"],
    }),
  ]),
  ...models("mistral", [
    "codestral-latest",
    "devstral-2512",
    "devstral-latest",
    "devstral-medium-2507",
    "devstral-medium-latest",
    "devstral-small-2505",
    "devstral-small-2507",
    "labs-devstral-small-2512",
    "magistral-medium-latest",
    "magistral-small",
    "mistral-large-2512",
    "mistral-large-latest",
    "mistral-medium-2604",
    "mistral-medium-3.5",
    "mistral-medium-latest",
    "mistral-small-2603",
    "mistral-small-latest",
  ]),
  ...models("groq", [
    "llama-3.1-8b-instant",
    "llama-3.3-70b-versatile",
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "qwen/qwen3-32b",
  ]),
  ...models("cerebras", ["gemma-4-31b", "gpt-oss-120b", "zai-glm-4.7"]),
  ...models("deepseek", ["deepseek-v4-flash", "deepseek-v4-pro"]),
  ...models("xai", [
    "grok-4.3",
    "grok-4.5",
    "grok-build-0.1",
  ]),
  ...models("openrouter", ["auto", "moonshotai/kimi-k2.6", "moonshotai/kimi-k2.7-code"]),
  ...models("together", ["moonshotai/Kimi-K2.6", "openai/gpt-oss-120b"]),
  ...models("fireworks", ["accounts/fireworks/models/kimi-k2p6"]),
  ...models("huggingface", ["moonshotai/Kimi-K2.6"]),
  // Sources checked 2026-07-12:
  // https://vercel.com/docs/ai-gateway/models-and-providers
  // Live discovery is intentionally authoritative; this is only a tiny
  // connected/offline fallback rather than a copy of the gateway catalog.
  ...models("vercel-ai-gateway", [
    "anthropic/claude-sonnet-4.6",
    "openai/gpt-5.4",
  ]),
  // https://docs.z.ai/devpack/tool/others
  // https://docs.bigmodel.cn/cn/coding-plan/quick-start
  ...models("zai", ["glm-5.2", "glm-5.1", "glm-5", "glm-5-turbo", "glm-4.7"], {
    contextTokens: 200_000,
    maxOutputTokens: 131_072,
    tools: true,
    reasoning: true,
    images: false,
    reasoningEfforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  }),
  ...models("zai-coding-cn", ["glm-5.2", "glm-5.1", "glm-5", "glm-5-turbo", "glm-4.7"], {
    contextTokens: 200_000,
    maxOutputTokens: 131_072,
    tools: true,
    reasoning: true,
    images: false,
    reasoningEfforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  }),
  // https://www.kimi.com/code/docs/en/
  ...models("kimi-coding", ["kimi-for-coding", "kimi-for-coding-highspeed"], {
    contextTokens: 262_144,
    maxOutputTokens: 32_768,
    tools: true,
    reasoning: true,
    images: true,
    reasoningEfforts: ["off", "low", "medium", "high"],
  }),
  // https://platform.minimax.io/docs/api-reference/models/openai/list-models
  // The provider does not expose effort levels through this protocol, so
  // reasoning control remains unknown instead of inventing a wire mapping.
  ...models("minimax", ["MiniMax-M3"], {
    contextTokens: 1_000_000,
    tools: true,
    images: true,
  }),
  ...models("minimax", ["MiniMax-M2.7", "MiniMax-M2.5"], {
    contextTokens: 204_800,
    tools: true,
    images: false,
  }),
  ...models("minimax-cn", ["MiniMax-M3"], {
    contextTokens: 1_000_000,
    tools: true,
    images: true,
  }),
  ...models("minimax-cn", ["MiniMax-M2.7", "MiniMax-M2.5"], {
    contextTokens: 204_800,
    tools: true,
    images: false,
  }),
];

export const MAINTAINED_MODEL_CATALOG: readonly ConfiguredModel[] = Object.freeze([
  ...OPENAI_EXACT,
  ...OPENAI_FALLBACK,
  ...ANTHROPIC_EXACT,
  ...ANTHROPIC_FALLBACK,
  ...GEMINI_EXACT,
  ...GEMINI_FALLBACK,
  ...OTHER_FALLBACKS,
]);

const MAINTAINED_BY_REFERENCE = new Map(
  MAINTAINED_MODEL_CATALOG.map((model) => [`${model.provider}\0${model.id}`, model]),
);

export function maintainedModelMetadata(provider: string, id: string): ConfiguredModel | undefined {
  return MAINTAINED_BY_REFERENCE.get(`${provider}\0${id}`);
}

export function configuredModelsWithMaintainedCatalog(configured: readonly ConfiguredModel[]): ConfiguredModel[] {
  const overridden = new Set(configured.map((model) => `${model.provider}\0${model.id}`));
  return [
    ...MAINTAINED_MODEL_CATALOG.filter((model) => !overridden.has(`${model.provider}\0${model.id}`)),
    ...configured,
  ];
}
