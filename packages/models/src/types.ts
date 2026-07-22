import type { TSchema } from "typebox";
import type { AssistantMessageDiagnostic } from "./utils/diagnostics.js";
import type { AssistantMessageEventStream } from "./utils/event-stream.js";

export type KnownApi =
  | "openai-completions"
  | "mistral-conversations"
  | "openai-responses"
  | "azure-openai-responses"
  | "openai-codex-responses"
  | "anthropic-messages"
  | "bedrock-converse-stream"
  | "google-generative-ai"
  | "google-vertex"
  | "rigyn-messages";
export type Api = KnownApi | (string & {});
export type KnownImagesApi = "openrouter-images";
export type ImagesApi = KnownImagesApi | (string & {});
export type KnownProvider =
  | "amazon-bedrock" | "anthropic" | "google" | "google-vertex" | "openai"
  | "azure-openai-responses" | "openai-codex" | "github-copilot" | "xai"
  | "groq" | "cerebras" | "openrouter" | "vercel-ai-gateway" | "mistral"
  | "deepseek" | "fireworks" | "together" | "huggingface" | "ollama"
  | "opencode" | "opencode-go" | "kimi-coding" | "cloudflare-workers-ai"
  | "cloudflare-ai-gateway" | "qwen-token-plan" | "qwen-token-plan-cn"
  | "xiaomi" | "xiaomi-token-plan-cn" | "xiaomi-token-plan-ams"
  | "xiaomi-token-plan-sgp" | "zai" | "zai-coding-cn" | "minimax"
  | "minimax-cn" | "moonshotai" | "moonshotai-cn" | "nvidia" | "ant-ling";
export type ProviderId = KnownProvider | (string & {});
export type KnownImagesProvider = "openrouter";
export type ImagesProviderId = KnownImagesProvider | (string & {});

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelThinkingLevel = "off" | ThinkingLevel;
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;
export interface ThinkingBudgets { minimal?: number; low?: number; medium?: number; high?: number; xhigh?: number; max?: number; }
export type CacheRetention = "none" | "short" | "long";
export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";
export type ProviderEnv = Record<string, string>;
export type ProviderHeaders = Record<string, string | null>;
export type SessionAffinityFormat = "openai" | "openai-nosession" | "openrouter";
export interface ProviderResponse { status: number; headers: Record<string, string>; }

export interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  apiKey?: string;
  transport?: Transport;
  cacheRetention?: CacheRetention;
  sessionId?: string;
  onPayload?: (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
  onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
  headers?: ProviderHeaders;
  timeoutMs?: number;
  websocketConnectTimeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  metadata?: Record<string, unknown>;
  env?: ProviderEnv;
  fetch?: typeof fetch;
}
export interface SimpleStreamOptions extends StreamOptions { reasoning?: ThinkingLevel; thinkingBudgets?: ThinkingBudgets; }
export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;
export type ModelsStreamTransforms = { transformHeaders?: (headers: ProviderHeaders) => ProviderHeaders | Promise<ProviderHeaders> };
export type ModelsSimpleStreamOptions = SimpleStreamOptions & ModelsStreamTransforms;
export type ModelsApiStreamOptions<TApi extends Api> = ApiStreamOptions<TApi> & ModelsStreamTransforms;

export interface TextSignatureV1 { v: 1; id: string; phase?: "commentary" | "final_answer"; }
export interface TextContent { type: "text"; text: string; textSignature?: string; }
export interface ThinkingContent { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean; }
export interface ImageContent { type: "image"; data: string; mimeType: string; }
export interface ToolCall { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; thoughtSignature?: string; }
export interface Usage {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  cacheWrite1h?: number; reasoning?: number; totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
/** Provider-owned continuation data. Consumers should persist it unchanged and only replay it at the exact source boundary. */
export interface OpaqueProviderState {
  source: { api: Api; provider: ProviderId; model: string };
  value: unknown;
}
export interface UserMessage { role: "user"; content: string | Array<TextContent | ImageContent>; timestamp: number; }
export interface AssistantMessage {
  role: "assistant"; content: Array<TextContent | ThinkingContent | ToolCall>;
  api: Api; provider: ProviderId; model: string; responseModel?: string; responseId?: string;
  diagnostics?: AssistantMessageDiagnostic[]; providerState?: OpaqueProviderState; usage: Usage; stopReason: StopReason;
  errorMessage?: string; timestamp: number;
}
export interface ToolResultMessage<TDetails = unknown> {
  role: "toolResult"; toolCallId: string; toolName: string;
  content: Array<TextContent | ImageContent>; details?: TDetails; addedToolNames?: string[];
  /** Usage incurred by the tool itself; excluded from primary model-context accounting. */
  usage?: Usage;
  isError: boolean; timestamp: number;
}
export type Message = UserMessage | AssistantMessage | ToolResultMessage;
export interface Tool<TParameters extends TSchema = TSchema> { name: string; description: string; parameters: TParameters; }
export interface Context { systemPrompt?: string; messages: Message[]; tools?: Tool[]; }

export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; contentSignature?: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; contentSignature?: string; redacted?: boolean; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
  | { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };
export type { AssistantMessageEventStream };

export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> =
  (model: Model<TApi>, context: Context, options?: TOptions) => AssistantMessageEventStream;
export interface ProviderStreams {
  stream(model: Model<Api>, context: Context, options?: StreamOptions): AssistantMessageEventStream;
  streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

export type ChatTemplateKwargValue = string | number | boolean | null | { $var: "thinking.enabled" | "thinking.effort"; omitWhenOff?: boolean };
export interface OpenRouterRouting {
  allow_fallbacks?: boolean; require_parameters?: boolean; data_collection?: "deny" | "allow"; zdr?: boolean;
  enforce_distillable_text?: boolean; order?: string[]; only?: string[]; ignore?: string[]; quantizations?: string[];
  sort?: string | { by?: string; partition?: string | null };
  max_price?: { prompt?: number | string; completion?: number | string; image?: number | string; audio?: number | string; request?: number | string };
  preferred_min_throughput?: number | { p50?: number; p75?: number; p90?: number; p99?: number };
  preferred_max_latency?: number | { p50?: number; p75?: number; p90?: number; p99?: number };
}
export interface VercelGatewayRouting { only?: string[]; order?: string[]; }
export interface OpenAICompletionsCompat {
  supportsStore?: boolean; supportsDeveloperRole?: boolean; supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean; maxTokensField?: "max_completion_tokens" | "max_tokens";
  requiresToolResultName?: boolean; requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean; requiresReasoningContentOnAssistantMessages?: boolean;
  reasoningFormat?: "openai" | "openrouter" | "deepseek" | "together" | "zai" | "qwen" | "chat-template" | "qwen-chat-template" | "string-thinking" | "ant-ling";
  /** @deprecated Use reasoningFormat. */
  thinkingFormat?: OpenAICompletionsCompat["reasoningFormat"];
  chatTemplateKwargs?: Record<string, ChatTemplateKwargValue>; openRouterRouting?: OpenRouterRouting;
  vercelGatewayRouting?: VercelGatewayRouting; zaiToolStream?: boolean; supportsStrictMode?: boolean;
  cacheControlFormat?: "anthropic"; sendSessionAffinityHeaders?: boolean; deferredToolsMode?: "kimi";
  sessionAffinityFormat?: SessionAffinityFormat; supportsLongCacheRetention?: boolean;
}
export interface OpenAIResponsesCompat { supportsDeveloperRole?: boolean; sessionAffinityFormat?: SessionAffinityFormat; supportsLongCacheRetention?: boolean; supportsToolSearch?: boolean; }
export interface AnthropicMessagesCompat {
  supportsEagerToolInputStreaming?: boolean; supportsLongCacheRetention?: boolean;
  sendSessionAffinityHeaders?: boolean; supportsCacheControlOnTools?: boolean; supportsTemperature?: boolean;
  forceAdaptiveThinking?: boolean; allowEmptySignature?: boolean; supportsToolReferences?: boolean;
}
export interface ModelCostRates { input: number; output: number; cacheRead: number; cacheWrite: number; }
export interface ModelCostTier extends ModelCostRates { inputTokensAbove: number; }
export interface ModelCost extends ModelCostRates { tiers?: ModelCostTier[]; }
export interface Model<TApi extends Api = Api> {
  id: string; name: string; api: TApi; provider: ProviderId; baseUrl: string; reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap; input: Array<"text" | "image">; cost: ModelCost;
  contextWindow: number; maxTokens: number; headers?: Record<string, string>;
  compat?: TApi extends "openai-completions" ? OpenAICompletionsCompat
    : TApi extends "openai-responses" | "openai-codex-responses" ? OpenAIResponsesCompat
      : TApi extends "anthropic-messages" ? AnthropicMessagesCompat : never;
}

export type ImagesInputContent = TextContent | ImageContent;
export type ImagesOutputContent = TextContent | ImageContent;
export interface ImagesContext { input: ImagesInputContent[]; }
export type ImagesStopReason = "stop" | "error" | "aborted";
export interface AssistantImages { api: ImagesApi; provider: ImagesProviderId; model: string; output: ImagesOutputContent[]; responseId?: string; usage?: Usage; stopReason: ImagesStopReason; errorMessage?: string; timestamp: number; }
export interface ImagesOptions extends Omit<StreamOptions, "temperature" | "maxTokens" | "transport" | "cacheRetention" | "sessionId" | "websocketConnectTimeoutMs" | "onPayload" | "onResponse"> {
  onPayload?: (payload: unknown, model: ImagesModel<ImagesApi>) => unknown | undefined | Promise<unknown | undefined>;
  onResponse?: (response: ProviderResponse, model: ImagesModel<ImagesApi>) => void | Promise<void>;
}
export type ProviderImagesOptions = ImagesOptions & Record<string, unknown>;
export interface ImagesModel<TApi extends ImagesApi = ImagesApi> extends Omit<Model<Api>, "api" | "provider" | "reasoning" | "contextWindow" | "maxTokens" | "compat"> { api: TApi; provider: ImagesProviderId; output: Array<"text" | "image">; }
export type ImagesFunction<TApi extends ImagesApi = ImagesApi, TOptions extends ImagesOptions = ImagesOptions> = (model: ImagesModel<TApi>, context: ImagesContext, options?: TOptions) => Promise<AssistantImages>;
export interface ProviderImages { generateImages(model: ImagesModel<ImagesApi>, context: ImagesContext, options?: ImagesOptions): Promise<AssistantImages>; }

export interface ApiOptionsMap {
  "anthropic-messages": StreamOptions;
  "openai-completions": StreamOptions;
  "openai-responses": StreamOptions;
  "openai-codex-responses": StreamOptions;
  "azure-openai-responses": StreamOptions;
  "google-generative-ai": StreamOptions;
  "google-vertex": StreamOptions;
  "mistral-conversations": StreamOptions;
  "bedrock-converse-stream": StreamOptions;
  "rigyn-messages": StreamOptions;
}
export type ApiStreamOptions<TApi extends Api> = TApi extends keyof ApiOptionsMap ? ApiOptionsMap[TApi] : StreamOptions & Record<string, unknown>;

/** Structural extension message accepted at the provider boundary without importing the agent package. */
export interface CustomContextMessage { role: "custom"; content: string | Array<TextContent | ImageContent>; timestamp: number; }
