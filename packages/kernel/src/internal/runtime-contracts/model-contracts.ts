import type { JsonValue } from "../../runtime/core/json.js";
import type { ProviderId } from "./provider-identity.js";

export type CapabilityValue = "supported" | "unsupported" | "unknown";
export type ModelMetadataSource = "provider" | "configuration" | "maintained" | "observed";

export interface ModelEvidence<T> {
  value: T;
  source: ModelMetadataSource;
  observedAt: string;
}

export interface ModelCapability extends ModelEvidence<CapabilityValue> {}

export type ModelProtocolFamily =
  | "openai-responses"
  | "openai-chat-completions"
  | "anthropic-messages"
  | "gemini-generate-content"
  | "gemini-interactions"
  | "bedrock-converse"
  | "ollama-chat"
  | "extension-stream";

export type ModelModality = "text" | "image" | "audio" | "video" | "file";
export type ModelCacheMode = "none" | "automatic" | "explicit";
export type ModelCacheAffinity = "none" | "prefix" | "session";
export type ModelCacheTier = "default" | "5m" | "1h" | "in-memory" | "24h" | "session" | "provider-managed";
export type ProviderCacheRetention = "none" | "short" | "long";
export type ModelSessionAffinity = "stateless" | "optional" | "required";

export interface ModelCompatibility {
  protocolFamily?: ModelEvidence<ModelProtocolFamily>;
  inputModalities?: ModelEvidence<ModelModality[]>;
  outputModalities?: ModelEvidence<ModelModality[]>;
  reasoningEfforts?: ModelEvidence<string[]>;
  strictTools?: ModelCapability;
  toolStreaming?: ModelCapability;
  deferredTools?: ModelCapability;
  cacheMode?: ModelEvidence<ModelCacheMode>;
  cacheAffinity?: ModelEvidence<ModelCacheAffinity>;
  cacheTiers?: ModelEvidence<ModelCacheTier[]>;
  sessionAffinity?: ModelEvidence<ModelSessionAffinity>;
}

export interface ModelTokenPrices {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

export interface ModelPricingTier extends ModelTokenPrices {
  name: string;
  minimumInputTokens?: number;
  maximumInputTokens?: number;
}

export interface ModelPricing extends ModelTokenPrices {
  currency: "USD";
  unit: "per_million_tokens";
  source: ModelMetadataSource;
  observedAt: string;
  /** Exclusive ISO instant after which this price must not be used. */
  validUntil?: string;
  tiers?: ModelPricingTier[];
}

export interface ModelInfo {
  id: string;
  provider: ProviderId;
  displayName?: string;
  description?: string;
  contextTokens?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  capabilities: {
    tools: ModelCapability;
    reasoning: ModelCapability;
    images: ModelCapability;
  };
  compatibility?: ModelCompatibility;
  pricing?: ModelPricing;
  metadata?: JsonValue;
}

export type ModelReasoningFormat =
  | "openai"
  | "openrouter"
  | "deepseek"
  | "together"
  | "zai"
  | "qwen"
  | "qwen-chat-template"
  | "chat-template"
  | "string-thinking"
  | "ant-ling";

export type ModelSessionAffinityFormat = "openai" | "openai-nosession" | "openrouter";

export interface ModelChatTemplateVariable {
  $var: "thinking.enabled" | "thinking.effort";
  omitWhenOff?: boolean;
}

export type ModelChatTemplateValue = JsonValue | ModelChatTemplateVariable;

export interface ModelOpenRouterRouting {
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  data_collection?: "allow" | "deny";
  zdr?: boolean;
  enforce_distillable_text?: boolean;
  order?: string[];
  only?: string[];
  ignore?: string[];
  quantizations?: string[];
  sort?: string | { by?: string; partition?: string | null };
  max_price?: {
    prompt?: number | string;
    completion?: number | string;
    image?: number | string;
    audio?: number | string;
    request?: number | string;
  };
  preferred_min_throughput?: number | { p50?: number; p75?: number; p90?: number; p99?: number };
  preferred_max_latency?: number | { p50?: number; p75?: number; p90?: number; p99?: number };
}

export interface ModelVercelGatewayRouting {
  only?: string[];
  order?: string[];
}

/** Explicit wire differences for one configured provider model. */
export interface ModelRequestCompatibility {
  forceAdaptiveThinking?: boolean;
  allowEmptySignature?: boolean;
  supportsEagerToolInputStreaming?: boolean;
  supportsToolReferences?: boolean;
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsUsageInStreaming?: boolean;
  supportsStrictMode?: boolean;
  supportsOpenAIGrammarTools?: boolean;
  supportsStrictTools?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  supportsReasoningEffort?: boolean;
  requiresThinkingAsText?: boolean;
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresReasoningContentOnAssistantMessages?: boolean;
  supportsReasoningSummaries?: boolean;
  exposesReasoningText?: boolean;
  supportsThinkingDisplay?: boolean;
  reasoningOutputFormat?: "parsed";
  includeReasoning?: boolean;
  reasoningFormat?: ModelReasoningFormat;
  chatTemplateParameters?: Record<string, ModelChatTemplateValue>;
  zaiToolStream?: boolean;
  deferredToolsMode?: "kimi";
  supportsToolSearch?: boolean;
  supportsExplicitPromptCacheMode?: boolean;
  supportsPromptCacheBreakpoints?: boolean;
  cacheControlFormat?: "anthropic";
  cacheControlTtl?: "5m" | "1h";
  supportsLongCacheRetention?: boolean;
  supportsPromptCaching?: boolean;
  supportsCacheControlOnTools?: boolean;
  supportsTemperature?: boolean;
  sendSessionAffinityHeaders?: boolean;
  sessionAffinityFormat?: ModelSessionAffinityFormat;
  openRouterRouting?: ModelOpenRouterRouting;
  vercelGatewayRouting?: ModelVercelGatewayRouting;
}
