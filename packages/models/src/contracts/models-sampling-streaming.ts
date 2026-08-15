import type { TSchema } from "typebox";
import type {
  AssistantMessage,
  Context,
  StopReason,
  ToolCall,
} from "./content-messages.js";

export type KnownApi =
  | "anthropic-messages"
  | "azure-openai-responses"
  | "bedrock-converse-stream"
  | "google-generative-ai"
  | "google-vertex"
  | "openai-codex-responses"
  | "openai-completions"
  | "openai-responses"
  | "faux";
export type Api = KnownApi | (string & {});
export type ProviderId = string;
export type ModelId = string;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelReasoningEffort = ThinkingLevel;
export type ThinkingBudgets = Partial<Record<Exclude<ThinkingLevel, "off">, number>>;

export interface UsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: UsageCost;
}

export interface ModelCostTier {
  inputTokensAbove: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: ModelCostTier[];
}

export interface ModelCompatibility {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  supportsReasoningBudget?: boolean;
  supportsStrictTools?: boolean;
  supportsGrammarTools?: boolean;
  supportsParallelToolCalls?: boolean;
  supportsPromptCache?: boolean;
  supportsPromptCaching?: boolean;
  supportsExplicitPromptCacheMode?: boolean;
  supportsPromptCacheBreakpoints?: boolean;
  supportsReasoningSummaries?: boolean;
  supportsEagerToolInputStreaming?: boolean;
  supportsLongCacheRetention?: boolean;
  supportsStrictMode?: boolean;
  supportsOpenAIGrammarTools?: boolean;
  supportsToolSearch?: boolean;
  exposesReasoningText?: boolean;
  sendSessionAffinityHeaders?: boolean;
  supportsCacheControlOnTools?: boolean;
  supportsTemperature?: boolean;
  forceAdaptiveThinking?: boolean;
  allowEmptySignature?: boolean;
  supportsToolReferences?: boolean;
  supportsThinkingDisplay?: boolean;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  requiresReasoningContentOnAssistantMessages?: boolean;
  reasoningOutputFormat?: "parsed";
  includeReasoning?: boolean;
  reasoningFormat?: "ant-ling" | "chat-template" | "deepseek" | "openai" | "openrouter" | "qwen" | "qwen-chat-template" | "string-thinking" | "together" | "zai";
  thinkingFormat?: string;
  chatTemplateKwargs?: Record<string, unknown>;
  openRouterRouting?: object;
  vercelGatewayRouting?: object;
  zaiToolStream?: boolean;
  cacheControlFormat?: "anthropic";
  cacheControlTtl?: "5m" | "1h";
  deferredToolsMode?: "kimi";
  sessionAffinityFormat?: "openai" | "openai-nosession" | "openrouter";
}

export interface Model<TApi extends Api = Api> {
  id: string;
  name: string;
  api: TApi;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  input: Array<"text" | "image">;
  cost: ModelCost;
  contextWindow: number;
  maxInputTokens?: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: ModelCompatibility;
}

export interface JsonSchemaConstraint {
  type: "json_schema";
  strict: "prefer" | "require";
}

export type GrammarFormat = "openai_lark" | "openai_regex";
export type GrammarSyntax = "lark" | "regex";

export interface GrammarSamplingConfig {
  type: "grammar";
  variants: Partial<Record<GrammarFormat, string>>;
}

export interface GrammarConstraint {
  format: GrammarSyntax;
  definition: string;
  property: string;
}

export type ConstrainedSampling = JsonSchemaConstraint | GrammarSamplingConfig;
export type ConstrainedSamplingConfig = ConstrainedSampling;

export interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  label?: string;
  description: string;
  parameters: TParameters;
  constrainedSampling?: false | ConstrainedSampling;
}

export type ToolChoice = "auto" | "none" | "required" | {
  type: "function";
  function: { name: string };
};

export type ProviderHeaders = Record<string, string | null>;

export interface RequestDiagnostic {
  url: string;
  method: string;
  headers: Readonly<Record<string, string>>;
  body?: unknown;
  attempt: number;
}

export interface ResponseDiagnostic {
  url?: string;
  status: number;
  headers: Readonly<Record<string, string>>;
  attempt?: number;
}

export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";
export type CacheRetention = "none" | "short" | "long";

export interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  apiKey?: string;
  transport?: Transport;
  timeoutMs?: number;
  websocketConnectTimeoutMs?: number;
  websocketIdleTimeoutMs?: number;
  serviceTier?: string;
  apiVersion?: string;
  accountId?: string;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  headers?: ProviderHeaders;
  reasoning?: ThinkingLevel;
  thinkingBudgets?: ThinkingBudgets;
  cacheRetention?: CacheRetention;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  env?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  toolChoice?: ToolChoice;
  onPayload?: (payload: unknown, model: Model) => unknown | undefined | Promise<unknown | undefined>;
  onRequest?: (request: RequestDiagnostic) => void | Promise<void>;
  onResponse?: (response: ResponseDiagnostic, model: Model) => void | Promise<void>;
}

export interface SimpleStreamOptions extends StreamOptions {
  temperature?: number;
  maxTokens?: number;
}

export type ApiStreamOptions<TApi extends Api = Api> = StreamOptions & { api?: TApi };
export type ModelsApiStreamOptions<TApi extends Api = Api> = ApiStreamOptions<TApi>;
export type ModelsSimpleStreamOptions = SimpleStreamOptions;

type MessageProgress = { partial: AssistantMessage };
type IndexedProgress = MessageProgress & { contentIndex: number };
type ContentResult = { content: string; contentSignature?: string };

interface AssistantEventPayloads {
  start: MessageProgress;
  text_start: IndexedProgress;
  text_delta: IndexedProgress & { delta: string };
  text_end: IndexedProgress & ContentResult;
  thinking_start: IndexedProgress;
  thinking_delta: IndexedProgress & { delta: string };
  thinking_end: IndexedProgress & ContentResult & { redacted?: boolean };
  toolcall_start: IndexedProgress & { id?: string; name?: string };
  toolcall_delta: IndexedProgress & { delta: string };
  toolcall_end: IndexedProgress & { toolCall: ToolCall };
  done: { reason: Exclude<StopReason, "pending" | "error" | "aborted">; message: AssistantMessage };
  error: { reason: "error" | "aborted"; error: AssistantMessage; message?: AssistantMessage };
}

export type AssistantMessageEvent = {
  [Type in keyof AssistantEventPayloads]: { type: Type } & AssistantEventPayloads[Type];
}[keyof AssistantEventPayloads];

export interface AssistantMessageEventStream extends AsyncIterable<AssistantMessageEvent> {
  result(): Promise<AssistantMessage>;
}

export interface PushableAssistantMessageEventStream extends AssistantMessageEventStream {
  push(event: AssistantMessageEvent): void;
  fail(error: unknown): void;
}

export type StreamFn<TApi extends Api = Api> = (
  model: Model<TApi>,
  context: Context,
  options?: ApiStreamOptions<TApi>,
) => AssistantMessageEventStream;
