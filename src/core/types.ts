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
  | "error"
  | "incomplete"
  | "unknown";

export interface TextBlock {
  type: "text";
  text: string;
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
}

export interface ToolResultBlock {
  type: "tool_result";
  callId: ToolCallId;
  name: string;
  content: string;
  isError: boolean;
  status?: "success" | "warning" | "error";
  summary?: string;
  nextActions?: string[];
  images?: ImageBlock[];
  artifactIds?: string[];
  metadata?: JsonValue;
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
  | ImageBlock
  | ToolCallBlock
  | ToolResultBlock
  | OpaqueBlock;

export interface CanonicalMessage {
  id: MessageId;
  role: "system" | "user" | "assistant" | "tool";
  content: ContentBlock[];
  displayText?: string;
  createdAt: string;
  provider?: ProviderId;
  purpose?: "instructions" | "compaction";
}

export interface ToolDefinition {
  name: string;
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
  reasoningTokens?: number;
  serverToolCalls?: number;
  cost?: string;
  durationMs?: number;
  raw?: JsonValue;
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
  raw?: JsonValue;
}

export type ProviderState =
  | { kind: "openai_responses"; previousResponseId?: string; outputItems: JsonValue[] }
  | { kind: "anthropic_messages"; assistantBlocks: JsonValue[] }
  | { kind: "gemini_interactions"; previousInteractionId?: string; steps: JsonValue[] }
  | { kind: "gemini_generate_content"; parts: JsonValue[] }
  | { kind: "bedrock_converse"; assistantMessage: JsonValue }
  | {
      kind: "mistral_conversations";
      conversationId?: string;
      model: string;
      requestFingerprint: string;
      outputs: JsonValue[];
    }
  | { kind: "chat_completions"; assistantMessage: JsonValue }
  | { kind: "openrouter_chat"; assistantMessage: JsonValue }
  | { kind: "ollama_chat"; assistantMessage: JsonValue };

export type AdapterEvent =
  | {
      type: "response_start";
      model: string;
      responseId?: string;
      requestId?: string;
    }
  | { type: "text_delta"; part: number; text: string }
  | {
      type: "reasoning_delta";
      part: number;
      text: string;
      visibility: "summary" | "provider_trace";
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
      rawReason?: string;
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
  | "ollama-chat";

export type ModelModality = "text" | "image" | "audio" | "video" | "file";
export type ModelCacheMode = "none" | "automatic" | "explicit";
export type ModelCacheAffinity = "none" | "prefix" | "session";
export type ModelCacheTier = "default" | "5m" | "1h" | "in-memory" | "24h" | "session" | "provider-managed";
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

export interface ProviderRequest {
  provider: ProviderId;
  model: string;
  messages: CanonicalMessage[];
  tools: ToolDefinition[];
  providerState?: ProviderState;
  maxOutputTokens?: number;
  reasoningEffort?: string;
  metadata?: Record<string, string>;
  sessionId?: string;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent>;
  listModels(signal: AbortSignal): Promise<ModelInfo[]>;
  dispose?(): Promise<void> | void;
}
