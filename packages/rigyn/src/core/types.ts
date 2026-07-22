import type { AssistantMessageDiagnostic, SimpleStreamOptions, Transport } from "@rigyn/models";

import type { JsonValue } from "./json.js";
import type { MessageId, ToolCallId } from "./ids.js";

export type ProviderId =
  | "openai"
  | "azure-openai"
  | "anthropic"
  | "gemini"
  | "vertex"
  | "bedrock"
  | "openrouter"
  | "mistral"
  | "ollama"
  | "openai-compatible"
  | (string & {});

/** Controls whether validated, durable image sources may cross a model boundary. */
export type OutboundImagePolicy = "allow" | "block";

export type FinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "context_limit"
  | "content_filter"
  | "refusal"
  | "pause"
  | "cancelled"
  | "aborted"
  | "error"
  | "incomplete"
  | "unknown";

export interface TextBlock {
  type: "text";
  text: string;
  /** Provider-owned signature replayable only at the exact source model boundary. */
  textSignature?: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  /** Provider-owned signature replayable only at the exact source model boundary. */
  thinkingSignature?: string;
  /** True when the provider returned an opaque/redacted reasoning block. */
  redacted?: boolean;
  /** Visibility retained for terminal and extension stream projection. */
  visibility?: "summary" | "provider_trace";
}

export interface ImageBlock {
  type: "image";
  mediaType: string;
  data?: string;
  url?: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  callId: ToolCallId;
  name: string;
  arguments: JsonValue;
  rawArguments?: string;
  /** Provider-owned reasoning signature replayable only at the exact source model boundary. */
  thoughtSignature?: string;
}

export interface ToolResultBlock {
  type: "tool_result";
  callId: ToolCallId;
  name: string;
  content: string;
  /** Original ordered extension-facing text/image content when available. */
  contentBlocks?: (TextBlock | ImageBlock)[];
  isError: boolean;
  status?: "success" | "warning" | "error";
  summary?: string;
  nextActions?: string[];
  images?: ImageBlock[];
  artifactIds?: string[];
  metadata?: JsonValue;
  addedToolNames?: string[];
}

export interface OpaqueBlock {
  type: "provider_opaque";
  provider: ProviderId;
  mediaType: string;
  value: JsonValue;
  serialized?: string;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ImageBlock
  | ToolCallBlock
  | ToolResultBlock
  | OpaqueBlock;

/** Ordered assistant blocks that may be finalized by a normalized provider stream. */
export type AssistantContentBlock = TextBlock | ThinkingBlock | ToolCallBlock;

export interface CanonicalMessage {
  id: MessageId;
  role: "system" | "user" | "assistant" | "tool";
  content: ContentBlock[];
  displayText?: string;
  createdAt: string;
  provider?: ProviderId;
  model?: string;
  api?: ModelProtocolFamily;
  /** Exact public API identifier when an extension API is carried by a core protocol. */
  publicApi?: string;
  purpose?: "instructions" | "compaction";
  /** Terminal metadata retained for assistant history and resume diagnostics. */
  stopReason?: FinishReason;
  errorMessage?: string;
  usage?: NormalizedUsage;
  /** Actual provider-selected model when it differs from the requested model. */
  responseModel?: string;
  /** Provider response identity used for diagnostics and supported continuations. */
  responseId?: string;
  /** Bounded, redacted, JSON-safe public response diagnostics. */
  diagnostics?: AssistantMessageDiagnostic[];
  /** A failed attempt kept in history but excluded from subsequent model context. */
  retryTransient?: true;
  /** Host-only identity for extension-authored context projected to providers as a user message. */
  custom?: {
    customType: string;
    display: boolean;
    details?: unknown;
    timestamp: number;
  };
}

export interface ToolDefinition {
  name: string;
  /** Concise human-facing name used by interactive renderers. */
  label?: string;
  description: string;
  inputSchema: Record<string, JsonValue>;
  /** Hint that supporting providers may load this executable definition on demand. */
  loading?: "eager" | "deferred";
  /** Optional concise system-prompt entry for an active tool. */
  promptSnippet?: string;
  /** Optional active-tool guidance appended to the system prompt. */
  promptGuidelines?: string[];
}

export interface NormalizedUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Portion of cacheWriteTokens created with a one-hour lifetime. */
  cacheWrite1hTokens?: number;
  reasoningTokens?: number;
  serverToolCalls?: number;
  cost?: UsageCost;
  durationMs?: number;
  raw?: JsonValue;
}

export interface UsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export type PromptCompositionSourceKind =
  | "instruction"
  | "system_prompt"
  | "append_system_prompt"
  | "additional_instructions";

/** Content-free provenance for one source included in a composed system prompt. */
export interface PromptCompositionSource {
  kind: PromptCompositionSourceKind;
  source: string;
  bytes: number;
  sha256: string;
  truncated?: boolean;
}

/** Bounded, content-free metadata for the exact system prompt sent to a run. */
export interface PromptCompositionMetadata {
  bytes: number;
  sha256: string;
  sources: PromptCompositionSource[];
  tools: string[];
  skills: Array<{ name: string; manifestPath: string }>;
  truncated: boolean;
}

export interface AdapterError {
  category:
    | "authentication"
    | "permission"
    | "rate_limit"
    | "invalid_request"
    | "not_found"
    | "overloaded"
    | "network"
    | "timeout"
    | "protocol"
    | "cancelled"
    | "provider";
  message: string;
  httpStatus?: number;
  providerCode?: string;
  requestId?: string;
  retryAfterMs?: number;
  retryable: boolean;
  partial: boolean;
  bodyStarted?: boolean;
  /** Safe, allowlisted transport metadata for an observed HTTP response. */
  diagnostics?: ProviderResponseDiagnostics;
  raw?: JsonValue;
}

export interface RoutedProviderStateProvenance {
  provider: ProviderId;
  model: string;
  delegate: ProviderId;
  upstreamModel: string;
  protocolFamily: ModelProtocolFamily;
  scope: string;
}

export interface ProviderStateSource {
  provider: ProviderId;
  model: string;
  api: ModelProtocolFamily;
}

type NativeProviderState =
  | { kind: "openai_responses"; previousResponseId?: string; outputItems: JsonValue[] }
  | { kind: "anthropic_messages"; assistantBlocks: JsonValue[] }
  | { kind: "gemini_interactions"; previousInteractionId?: string; steps: JsonValue[] }
  | { kind: "gemini_generate_content"; parts: JsonValue[] }
  | { kind: "gateway_messages"; assistantContent: JsonValue[]; responseId?: string }
  | { kind: "bedrock_converse"; assistantMessage: JsonValue }
  | { kind: "mistral_chat"; assistantMessage: JsonValue }
  | { kind: "chat_completions"; assistantMessage: JsonValue }
  | { kind: "openrouter_chat"; assistantMessage: JsonValue }
  | { kind: "ollama_chat"; assistantMessage: JsonValue };

export type ProviderState = NativeProviderState & {
  /** Exact model boundary that produced this replayable wire state. */
  source?: ProviderStateSource;
  /** Exact routed-adapter generation that produced this continuation state. */
  routed?: RoutedProviderStateProvenance;
};

export interface ProviderResponseDiagnostics {
  /** Final HTTP response status observed by the provider transport. */
  status: number;
  /** Small, explicitly allowlisted response-header projection. */
  headers: Record<string, string>;
}

/** Bounded failed-response metadata exposed to observers; raw provider bodies are excluded. */
export type ProviderResponseFailureMetadata = Omit<AdapterError, "raw" | "diagnostics">;

export type AdapterEvent =
  | {
      type: "response_start";
      model: string;
      responseId?: string;
      requestId?: string;
      diagnostics?: ProviderResponseDiagnostics;
    }
  | { type: "text_start"; part: number }
  | { type: "text_delta"; part: number; text: string }
  | { type: "text_end"; part: number; text: string; textSignature?: string }
  | { type: "reasoning_start"; part: number; visibility: "summary" | "provider_trace" }
  | {
      type: "reasoning_delta";
      part: number;
      text: string;
      visibility: "summary" | "provider_trace";
    }
  | {
      type: "reasoning_end";
      part: number;
      text: string;
      visibility: "summary" | "provider_trace";
      thinkingSignature?: string;
      redacted?: boolean;
    }
  | { type: "tool_call_start"; index: number; id?: string; name?: string }
  | { type: "tool_call_delta"; index: number; jsonFragment: string }
  | {
      type: "tool_call_end";
      index: number;
      name: string;
      rawArguments: string;
      id?: string;
      arguments?: JsonValue;
      parseError?: string;
      thoughtSignature?: string;
    }
  | {
      type: "usage";
      usage: NormalizedUsage;
      semantics: "incremental" | "cumulative" | "final";
    }
  | { type: "unknown_provider_event"; provider: ProviderId; raw: JsonValue }
  | {
      type: "response_end";
      reason: FinishReason;
      state: ProviderState;
      /** Validated ordered terminal assistant content, when the protocol exposes it. */
      content?: AssistantContentBlock[];
      /** Bounded public diagnostic records emitted by a provider implementation. */
      assistantDiagnostics?: AssistantMessageDiagnostic[];
      rawReason?: string;
      /** Bounded, provider-authored explanation for a non-success finish such as a refusal. */
      explanation?: string;
    }
  | { type: "error"; error: AdapterError };

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
  | "mistral-conversations"
  | "ollama-chat"
  | "gateway-messages";

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
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  requiresReasoningContentOnAssistantMessages?: boolean;
  supportsReasoningEffort?: boolean;
  reasoningFormat?: ModelReasoningFormat;
  chatTemplateParameters?: Record<string, ModelChatTemplateValue>;
  zaiToolStream?: boolean;
  deferredToolsMode?: "kimi";
  supportsToolSearch?: boolean;
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

/** Host-injected model settings. Authentication headers are never accepted here. */
export interface ProviderModelRequestSettings {
  headers?: Record<string, string>;
  reasoningEffortMap?: Record<string, string | null>;
  compatibility?: ModelRequestCompatibility;
}

export interface ProviderRequest {
  provider: ProviderId;
  model: string;
  api?: ModelProtocolFamily;
  messages: CanonicalMessage[];
  tools: ToolDefinition[];
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  temperature?: number;
  cacheRetention?: ProviderCacheRetention;
  providerState?: ProviderState;
  maxOutputTokens?: number;
  reasoningEffort?: string;
  /** Optional operator budgets for provider protocols that express reasoning in tokens. */
  thinkingBudgets?: ThinkingBudgets;
  metadata?: Record<string, string>;
  sessionId?: string;
  transport?: Transport;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  onPayload?: SimpleStreamOptions["onPayload"];
  onResponse?: SimpleStreamOptions["onResponse"];
  /** Supplied by the provider registry after extension request reducers have completed. */
  modelSettings?: ProviderModelRequestSettings;
}

export interface ThinkingBudgets {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent>;
  listModels(signal: AbortSignal): Promise<ModelInfo[]>;
  dispose?(): Promise<void> | void;
}
