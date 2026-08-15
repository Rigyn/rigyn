import { isProxy } from "node:util/types";

import type { StreamFn, ThinkingLevel } from "@rigyn/kernel";
import { snapshotAdapterEvent } from "@rigyn/kernel/runtime/core/adapter-event";
import { ASSISTANT_CONTENT_LIMITS } from "@rigyn/kernel/runtime/core/assistant-content-limits";
import { boundedJsonSnapshot } from "@rigyn/kernel/runtime/core/bounded-json";
import { validateProviderState } from "@rigyn/kernel/runtime/core/provider-state";
import { createAssistantMessageEventStream } from "@rigyn/models";
import { Type } from "typebox";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Credential,
  ImageContent,
  Model,
  OAuthCredentials,
  OAuthLoginCallbacks,
  Provider as ExtensionProvider,
  RefreshModelsContext,
  SimpleStreamOptions,
  StreamOptions,
  TextContent,
  Usage,
} from "@rigyn/models";

import { errorMessage } from "../core/errors.js";
import { isJsonValue, toJsonValue, type JsonValue } from "../core/json.js";
import {
  MAX_TOOL_CALL_STREAM_DELTA_BYTES,
  MAX_TOOL_CALL_STREAM_ID_BYTES,
  MAX_TOOL_CALL_STREAM_NAME_BYTES,
} from "../core/events.js";
import { createId } from "../core/ids.js";
import {
  assistantDiagnosticsFromProviderResponse,
  canonicalAssistantDiagnostics,
} from "../core/assistant-diagnostics.js";
import {
  assistantContentFromProviderState,
  canonicalAssistantContent,
  publicAssistantContent,
  withThinkingVisibility,
} from "../core/public-assistant-content.js";
import type {
  AdapterEvent,
  CanonicalMessage,
  FinishReason,
  ModelProtocolFamily,
  ModelRequestCompatibility,
  NormalizedUsage,
  ProviderState,
  ProviderRequest,
  TextBlock,
  ProviderToolDefinition,
  ToolResultBlock,
} from "../core/types.js";
import {
  ModelRegistry as InternalModelRegistry,
  type ProviderAuthStatus,
  type ProviderConfigInput as InternalProviderConfig,
  type ProviderConfigModel as InternalProviderModelConfig,
  type ResolvedRequestAuth,
} from "../providers/model-registry.js";
import type {
  Provider as InternalProvider,
  ProviderAuth as InternalProviderAuth,
  ProviderModel,
  ProviderOAuthCredential,
  ProviderRefreshContext,
  ProviderStreamContext,
  ProviderStreamOptions,
} from "../providers/models.js";
import { ProviderStreamProjector } from "../providers/stream-envelope.js";

/** Public provider-model declaration used by trusted direct extensions. */
export interface ExtensionProviderModelConfig {
  id: string;
  name: string;
  api?: Api;
  baseUrl?: string;
  reasoning: boolean;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  input: Array<"text" | "image">;
  cost: Model<Api>["cost"];
  contextWindow: number;
  maxInputTokens?: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: Model<Api>["compat"];
}

export interface ExtensionOAuthConfig {
  name: string;
  getApiKey(credentials: OAuthCredentials): string;
  login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
  modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
  refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
}

/** Public configuration accepted by direct extension provider registration. */
export interface ExtensionProviderConfig {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: Api;
  streamSimple?(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
  headers?: Record<string, string>;
  authHeader?: boolean;
  oauth?: ExtensionOAuthConfig;
  models?: ExtensionProviderModelConfig[];
  refreshModels?(context: RefreshModelsContext): Promise<ExtensionProviderModelConfig[]>;
}

const PUBLIC_TO_INTERNAL_API = new Map<string, ModelProtocolFamily>([
  ["anthropic-messages", "anthropic-messages"],
  ["azure-openai-responses", "openai-responses"],
  ["bedrock-converse", "bedrock-converse"],
  ["bedrock-converse-stream", "bedrock-converse"],
  ["extension-stream", "extension-stream"],
  ["gemini-generate-content", "gemini-generate-content"],
  ["google-generative-ai", "gemini-generate-content"],
  ["google-vertex", "gemini-generate-content"],
  ["gemini-interactions", "gemini-interactions"],
  ["ollama-chat", "ollama-chat"],
  ["openai-codex-responses", "openai-responses"],
  ["openai-chat-completions", "openai-chat-completions"],
  ["openai-completions", "openai-chat-completions"],
  ["openai-responses", "openai-responses"],
]);

const INTERNAL_TO_PUBLIC_API: Partial<Record<ModelProtocolFamily, Api>> = {
  "anthropic-messages": "anthropic-messages",
  "bedrock-converse": "bedrock-converse-stream",
  "extension-stream": "extension-stream",
  "gemini-generate-content": "google-generative-ai",
  "gemini-interactions": "gemini-interactions",
  "ollama-chat": "openai-completions",
  "openai-chat-completions": "openai-completions",
  "openai-responses": "openai-responses",
};

/** Translate a public provider API into the protocol used by the core run loop. */
export function protocolFromPublicApi(api: Api): ModelProtocolFamily {
  return PUBLIC_TO_INTERNAL_API.get(api) ?? "extension-stream";
}

/** Translate a core protocol into its canonical public provider API. */
export function publicApiFromProtocol(protocol: ModelProtocolFamily): Api {
  const api = INTERNAL_TO_PUBLIC_API[protocol];
  if (api === undefined) throw new TypeError(`Unsupported model protocol: ${protocol}`);
  return api;
}

function modelKey(provider: string, id: string): string {
  return `${provider}\0${id}`;
}

function compatibilityFromInternal(
  compatibility: ModelRequestCompatibility | undefined,
): Model<Api>["compat"] {
  if (compatibility === undefined) return undefined;
  return {
    ...(compatibility.supportsStore === undefined ? {} : { supportsStore: compatibility.supportsStore }),
    ...(compatibility.supportsDeveloperRole === undefined ? {} : { supportsDeveloperRole: compatibility.supportsDeveloperRole }),
    ...(compatibility.supportsUsageInStreaming === undefined ? {} : { supportsUsageInStreaming: compatibility.supportsUsageInStreaming }),
    ...(compatibility.supportsStrictMode === undefined ? {} : { supportsStrictMode: compatibility.supportsStrictMode }),
    ...(compatibility.supportsOpenAIGrammarTools === undefined ? {} : { supportsOpenAIGrammarTools: compatibility.supportsOpenAIGrammarTools }),
    ...(compatibility.supportsStrictTools === undefined ? {} : { supportsStrictTools: compatibility.supportsStrictTools }),
    ...(compatibility.maxTokensField === undefined ? {} : { maxTokensField: compatibility.maxTokensField }),
    ...(compatibility.requiresToolResultName === undefined ? {} : { requiresToolResultName: compatibility.requiresToolResultName }),
    ...(compatibility.requiresAssistantAfterToolResult === undefined ? {} : { requiresAssistantAfterToolResult: compatibility.requiresAssistantAfterToolResult }),
    ...(compatibility.requiresThinkingAsText === undefined ? {} : { requiresThinkingAsText: compatibility.requiresThinkingAsText }),
    ...(compatibility.requiresReasoningContentOnAssistantMessages === undefined ? {} : { requiresReasoningContentOnAssistantMessages: compatibility.requiresReasoningContentOnAssistantMessages }),
    ...(compatibility.supportsReasoningEffort === undefined ? {} : { supportsReasoningEffort: compatibility.supportsReasoningEffort }),
    ...(compatibility.supportsReasoningSummaries === undefined ? {} : { supportsReasoningSummaries: compatibility.supportsReasoningSummaries }),
    ...(compatibility.exposesReasoningText === undefined ? {} : { exposesReasoningText: compatibility.exposesReasoningText }),
    ...(compatibility.supportsThinkingDisplay === undefined ? {} : { supportsThinkingDisplay: compatibility.supportsThinkingDisplay }),
    ...(compatibility.reasoningOutputFormat === undefined ? {} : { reasoningOutputFormat: compatibility.reasoningOutputFormat }),
    ...(compatibility.includeReasoning === undefined ? {} : { includeReasoning: compatibility.includeReasoning }),
    ...(compatibility.reasoningFormat === undefined ? {} : { reasoningFormat: compatibility.reasoningFormat }),
    ...(compatibility.chatTemplateParameters === undefined ? {} : { chatTemplateKwargs: compatibility.chatTemplateParameters }),
    ...(compatibility.zaiToolStream === undefined ? {} : { zaiToolStream: compatibility.zaiToolStream }),
    ...(compatibility.deferredToolsMode === undefined ? {} : { deferredToolsMode: compatibility.deferredToolsMode }),
    ...(compatibility.supportsToolSearch === undefined ? {} : { supportsToolSearch: compatibility.supportsToolSearch }),
    ...(compatibility.supportsExplicitPromptCacheMode === undefined
      ? {}
      : { supportsExplicitPromptCacheMode: compatibility.supportsExplicitPromptCacheMode }),
    ...(compatibility.supportsPromptCacheBreakpoints === undefined
      ? {}
      : { supportsPromptCacheBreakpoints: compatibility.supportsPromptCacheBreakpoints }),
    ...(compatibility.cacheControlFormat === undefined ? {} : { cacheControlFormat: compatibility.cacheControlFormat }),
    ...(compatibility.cacheControlTtl === undefined ? {} : { cacheControlTtl: compatibility.cacheControlTtl }),
    ...(compatibility.supportsLongCacheRetention === undefined ? {} : { supportsLongCacheRetention: compatibility.supportsLongCacheRetention }),
    ...(compatibility.supportsPromptCaching === undefined ? {} : { supportsPromptCaching: compatibility.supportsPromptCaching }),
    ...(compatibility.supportsCacheControlOnTools === undefined ? {} : { supportsCacheControlOnTools: compatibility.supportsCacheControlOnTools }),
    ...(compatibility.supportsTemperature === undefined ? {} : { supportsTemperature: compatibility.supportsTemperature }),
    ...(compatibility.sendSessionAffinityHeaders === undefined ? {} : { sendSessionAffinityHeaders: compatibility.sendSessionAffinityHeaders }),
    ...(compatibility.sessionAffinityFormat === undefined ? {} : { sessionAffinityFormat: compatibility.sessionAffinityFormat }),
    ...(compatibility.openRouterRouting === undefined ? {} : { openRouterRouting: compatibility.openRouterRouting }),
    ...(compatibility.vercelGatewayRouting === undefined ? {} : { vercelGatewayRouting: compatibility.vercelGatewayRouting }),
    ...(compatibility.supportsEagerToolInputStreaming === undefined ? {} : { supportsEagerToolInputStreaming: compatibility.supportsEagerToolInputStreaming }),
    ...(compatibility.forceAdaptiveThinking === undefined ? {} : { forceAdaptiveThinking: compatibility.forceAdaptiveThinking }),
    ...(compatibility.allowEmptySignature === undefined ? {} : { allowEmptySignature: compatibility.allowEmptySignature }),
    ...(compatibility.supportsToolReferences === undefined ? {} : { supportsToolReferences: compatibility.supportsToolReferences }),
  };
}

function compatibilityToInternal(compatibility: Model<Api>["compat"]): ModelRequestCompatibility | undefined {
  if (compatibility === undefined) return undefined;
  const selected = compatibility as Record<string, unknown>;
  const result: ModelRequestCompatibility = {};
  if (typeof selected.supportsStore === "boolean") result.supportsStore = selected.supportsStore;
  if (typeof selected.supportsDeveloperRole === "boolean") result.supportsDeveloperRole = selected.supportsDeveloperRole;
  if (typeof selected.supportsUsageInStreaming === "boolean") result.supportsUsageInStreaming = selected.supportsUsageInStreaming;
  if (typeof selected.supportsStrictMode === "boolean") result.supportsStrictMode = selected.supportsStrictMode;
  if (typeof selected.supportsOpenAIGrammarTools === "boolean") result.supportsOpenAIGrammarTools = selected.supportsOpenAIGrammarTools;
  if (typeof selected.supportsStrictTools === "boolean") result.supportsStrictTools = selected.supportsStrictTools;
  if (selected.maxTokensField === "max_completion_tokens" || selected.maxTokensField === "max_tokens") result.maxTokensField = selected.maxTokensField;
  if (typeof selected.requiresToolResultName === "boolean") result.requiresToolResultName = selected.requiresToolResultName;
  if (typeof selected.requiresAssistantAfterToolResult === "boolean") result.requiresAssistantAfterToolResult = selected.requiresAssistantAfterToolResult;
  if (typeof selected.requiresThinkingAsText === "boolean") result.requiresThinkingAsText = selected.requiresThinkingAsText;
  if (typeof selected.requiresReasoningContentOnAssistantMessages === "boolean") result.requiresReasoningContentOnAssistantMessages = selected.requiresReasoningContentOnAssistantMessages;
  if (typeof selected.supportsReasoningEffort === "boolean") result.supportsReasoningEffort = selected.supportsReasoningEffort;
  if (typeof selected.supportsReasoningSummaries === "boolean") result.supportsReasoningSummaries = selected.supportsReasoningSummaries;
  if (typeof selected.exposesReasoningText === "boolean") result.exposesReasoningText = selected.exposesReasoningText;
  if (typeof selected.supportsThinkingDisplay === "boolean") result.supportsThinkingDisplay = selected.supportsThinkingDisplay;
  if (selected.reasoningOutputFormat === "parsed") result.reasoningOutputFormat = "parsed";
  if (typeof selected.includeReasoning === "boolean") result.includeReasoning = selected.includeReasoning;
  const reasoningFormat = selected.reasoningFormat ?? selected.thinkingFormat;
  if (typeof reasoningFormat === "string") result.reasoningFormat = reasoningFormat as NonNullable<ModelRequestCompatibility["reasoningFormat"]>;
  if (selected.chatTemplateKwargs !== undefined && isJsonValue(selected.chatTemplateKwargs)) {
    result.chatTemplateParameters = selected.chatTemplateKwargs as NonNullable<ModelRequestCompatibility["chatTemplateParameters"]>;
  }
  if (selected.cacheControlFormat === "anthropic") result.cacheControlFormat = "anthropic";
  if (selected.cacheControlTtl === "5m" || selected.cacheControlTtl === "1h") result.cacheControlTtl = selected.cacheControlTtl;
  if (typeof selected.zaiToolStream === "boolean") result.zaiToolStream = selected.zaiToolStream;
  if (selected.deferredToolsMode === "kimi") result.deferredToolsMode = "kimi";
  if (typeof selected.supportsToolSearch === "boolean") result.supportsToolSearch = selected.supportsToolSearch;
  if (typeof selected.supportsExplicitPromptCacheMode === "boolean") {
    result.supportsExplicitPromptCacheMode = selected.supportsExplicitPromptCacheMode;
  }
  if (typeof selected.supportsPromptCacheBreakpoints === "boolean") {
    result.supportsPromptCacheBreakpoints = selected.supportsPromptCacheBreakpoints;
  }
  if (typeof selected.supportsLongCacheRetention === "boolean") result.supportsLongCacheRetention = selected.supportsLongCacheRetention;
  if (typeof selected.supportsPromptCaching === "boolean") result.supportsPromptCaching = selected.supportsPromptCaching;
  if (typeof selected.supportsCacheControlOnTools === "boolean") result.supportsCacheControlOnTools = selected.supportsCacheControlOnTools;
  if (typeof selected.supportsTemperature === "boolean") result.supportsTemperature = selected.supportsTemperature;
  if (typeof selected.sendSessionAffinityHeaders === "boolean") result.sendSessionAffinityHeaders = selected.sendSessionAffinityHeaders;
  if (selected.sessionAffinityFormat === "openai" || selected.sessionAffinityFormat === "openai-nosession" || selected.sessionAffinityFormat === "openrouter") {
    result.sessionAffinityFormat = selected.sessionAffinityFormat;
  }
  if (selected.openRouterRouting !== undefined && isJsonValue(selected.openRouterRouting)) {
    result.openRouterRouting = selected.openRouterRouting as NonNullable<ModelRequestCompatibility["openRouterRouting"]>;
  }
  if (selected.vercelGatewayRouting !== undefined && isJsonValue(selected.vercelGatewayRouting)) {
    result.vercelGatewayRouting = selected.vercelGatewayRouting as NonNullable<ModelRequestCompatibility["vercelGatewayRouting"]>;
  }
  if (typeof selected.supportsEagerToolInputStreaming === "boolean") result.supportsEagerToolInputStreaming = selected.supportsEagerToolInputStreaming;
  if (typeof selected.forceAdaptiveThinking === "boolean") result.forceAdaptiveThinking = selected.forceAdaptiveThinking;
  if (typeof selected.allowEmptySignature === "boolean") result.allowEmptySignature = selected.allowEmptySignature;
  if (typeof selected.supportsToolReferences === "boolean") result.supportsToolReferences = selected.supportsToolReferences;
  return Object.keys(result).length === 0 ? undefined : result;
}

function normalizedUsageFromPublic(usage: Usage): NormalizedUsage {
  return {
    ...(usage.input === undefined ? {} : { inputTokens: usage.input }),
    ...(usage.output === undefined ? {} : { outputTokens: usage.output }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.cacheRead === undefined ? {} : { cacheReadTokens: usage.cacheRead }),
    ...(usage.cacheWrite === undefined ? {} : { cacheWriteTokens: usage.cacheWrite }),
    ...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1hTokens: usage.cacheWrite1h }),
    ...(usage.reasoning === undefined ? {} : { reasoningTokens: usage.reasoning }),
    ...(usage.cost === undefined ? {} : { cost: { ...usage.cost } }),
  };
}

function publicUsageFromNormalized(usage: NormalizedUsage | undefined): Usage {
  return {
    ...(usage?.inputTokens === undefined ? {} : { input: usage.inputTokens }),
    ...(usage?.outputTokens === undefined ? {} : { output: usage.outputTokens }),
    ...(usage?.cacheReadTokens === undefined ? {} : { cacheRead: usage.cacheReadTokens }),
    ...(usage?.cacheWriteTokens === undefined ? {} : { cacheWrite: usage.cacheWriteTokens }),
    ...(usage?.cacheWrite1hTokens === undefined ? {} : { cacheWrite1h: usage.cacheWrite1hTokens }),
    ...(usage?.reasoningTokens === undefined ? {} : { reasoning: usage.reasoningTokens }),
    ...(usage?.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage?.cost === undefined ? {} : { cost: { ...usage.cost } }),
  };
}

function publicStopReason(reason: FinishReason | undefined): AssistantMessage["stopReason"] {
  if (reason === "length" || reason === "context_limit") return "length";
  if (reason === "tool_calls") return "toolUse";
  if (reason === "cancelled" || reason === "aborted") return "aborted";
  if (reason === "error" || reason === "content_filter" || reason === "refusal") return "error";
  return "stop";
}

function internalFinishReason(reason: AssistantMessage["stopReason"]): FinishReason {
  if (reason === "pending") return "incomplete";
  if (reason === "length") return "length";
  if (reason === "toolUse") return "tool_calls";
  if (reason === "aborted") return "aborted";
  if (reason === "error") return "error";
  return "stop";
}

function textFromCanonical(message: CanonicalMessage): string {
  return message.content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function publicContextFromInternal(
  context: ProviderStreamContext,
  model: Model<Api>,
): Context {
  const systemPrompt = context.messages
    .filter((message) => message.role === "system")
    .map(textFromCanonical)
    .filter(Boolean)
    .join("\n\n");
  const messages: Context["messages"] = [];
  for (const message of context.messages) {
    const timestamp = Number.isFinite(Date.parse(message.createdAt)) ? Date.parse(message.createdAt) : Date.now();
    if (message.role === "system") continue;
    if (message.role === "user") {
      const content: Array<TextContent | ImageContent> = [];
      for (const block of message.content) {
        if (block.type === "text") content.push({ type: "text", text: block.text });
        if (block.type === "image" && block.data !== undefined) {
          content.push({ type: "image", data: block.data, mimeType: block.mediaType });
        }
      }
      messages.push({ role: "user", content, timestamp });
      continue;
    }
    if (message.role === "assistant") {
      const content = publicAssistantContent(message.content);
      const diagnostics = canonicalAssistantDiagnostics(message.diagnostics);
      messages.push({
        role: "assistant",
        content,
        api: message.publicApi ?? (message.api === undefined ? model.api : publicApiFromProtocol(message.api)),
        provider: message.provider ?? model.provider,
        model: message.model ?? model.id,
        ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
        ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
        ...(diagnostics === undefined ? {} : { diagnostics }),
        usage: publicUsageFromNormalized(message.usage),
        stopReason: publicStopReason(message.stopReason),
        ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
        timestamp,
      });
      continue;
    }
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      messages.push({
        role: "toolResult",
        toolCallId: block.callId,
        toolName: block.name,
        content: [
          { type: "text", text: block.content },
          ...(block.images ?? []).flatMap((image) => image.data === undefined
            ? []
            : [{ type: "image" as const, data: image.data, mimeType: image.mediaType }]),
        ],
        ...(block.metadata === undefined ? {} : { details: block.metadata }),
        isError: block.isError,
        timestamp,
      });
    }
  }
  if (context.providerState !== undefined) {
    const lastAssistant = messages.findLast((message): message is AssistantMessage => message.role === "assistant");
    if (lastAssistant !== undefined && isJsonValue(context.providerState)) {
      lastAssistant.providerState = {
        source: { api: lastAssistant.api, provider: lastAssistant.provider, model: lastAssistant.model },
        value: context.providerState,
      };
    }
  }
  const tools = context.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: Type.Unsafe(tool.inputSchema),
    ...(tool.constrainedSampling === undefined
      ? {}
      : { constrainedSampling: structuredClone(tool.constrainedSampling) }),
  }));
  return {
    ...(systemPrompt === "" ? {} : { systemPrompt }),
    messages,
    ...(tools === undefined ? {} : { tools }),
  };
}

function publicOptionsFromInternal(options: ProviderStreamOptions): SimpleStreamOptions {
  const selected = options.reasoningEffort;
  const reasoning = selected === "minimal" || selected === "low" || selected === "medium" || selected === "high" || selected === "xhigh" || selected === "max"
    ? selected
    : undefined;
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.maxOutputTokens === undefined ? {} : { maxTokens: options.maxOutputTokens }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(options.toolChoice === undefined ? {} : { toolChoice: options.toolChoice }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.cacheRetention === undefined ? {} : { cacheRetention: options.cacheRetention }),
    ...(options.thinkingBudgets === undefined ? {} : { thinkingBudgets: options.thinkingBudgets }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.websocketConnectTimeoutMs === undefined
      ? {}
      : { websocketConnectTimeoutMs: options.websocketConnectTimeoutMs }),
    ...(options.websocketIdleTimeoutMs === undefined
      ? {}
      : { websocketIdleTimeoutMs: options.websocketIdleTimeoutMs }),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    ...(options.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: options.maxRetryDelayMs }),
    ...(options.onPayload === undefined ? {} : { onPayload: options.onPayload }),
    ...(options.onResponse === undefined ? {} : { onResponse: options.onResponse }),
  };
}

function providerStateProtocol(state: ProviderState): ModelProtocolFamily {
  switch (state.kind) {
    case "openai_responses": return "openai-responses";
    case "anthropic_messages": return "anthropic-messages";
    case "gemini_interactions": return "gemini-interactions";
    case "gemini_generate_content": return "gemini-generate-content";
    case "extension_stream": return "extension-stream";
    case "bedrock_converse": return "bedrock-converse";
    case "chat_completions":
    case "openrouter_chat": return "openai-chat-completions";
    case "ollama_chat": return "ollama-chat";
  }
}

function stateFromAssistant(message: AssistantMessage, api: ModelProtocolFamily): ProviderState {
  const explicit = message.providerState;
  if (
    explicit !== undefined &&
    explicit.source.api === message.api &&
    explicit.source.provider === message.provider &&
    explicit.source.model === message.model &&
    isProviderState(explicit.value) &&
    providerStateProtocol(explicit.value) === api
  ) {
    return {
      ...structuredClone(explicit.value),
      source: { provider: message.provider, model: message.model, api },
    } as ProviderState;
  }

  const assistantContent = message.content.map((block) => toJsonValue(block));
  const source = { provider: message.provider, model: message.model, api };
  switch (api) {
    case "openai-responses": return {
      kind: "openai_responses",
      outputItems: assistantContent,
      ...(message.responseId === undefined ? {} : { previousResponseId: message.responseId }),
      source,
    };
    case "anthropic-messages": return { kind: "anthropic_messages", assistantBlocks: assistantContent, source };
    case "gemini-interactions": return {
      kind: "gemini_interactions",
      steps: assistantContent,
      ...(message.responseId === undefined ? {} : { previousInteractionId: message.responseId }),
      source,
    };
    case "gemini-generate-content": return { kind: "gemini_generate_content", parts: assistantContent, source };
    case "bedrock-converse": return {
      kind: "bedrock_converse",
      assistantMessage: { role: "assistant", content: assistantContent },
      source,
    };
    case "ollama-chat": return {
      kind: "ollama_chat",
      assistantMessage: { role: "assistant", content: assistantContent },
      source,
    };
    case "openai-chat-completions": return {
      kind: "chat_completions",
      assistantMessage: { role: "assistant", content: assistantContent },
      source,
    };
    case "extension-stream": return {
      kind: "extension_stream",
      assistantContent,
      ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
      source,
    };
  }
}

const MAX_PUBLIC_STREAM_TOOL_CALLS = 256;
const MAX_PUBLIC_STREAM_MESSAGE_BYTES = 20 * 1024 * 1024;

function publicStreamRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
    throw new TypeError(`${label} must be a non-proxy plain object`);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain object`);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 32) throw new TypeError(`${label} contains too many fields`);
  const selected = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") throw new TypeError(`${label} must not contain symbol fields`);
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new TypeError(`${label} must contain only enumerable data fields`);
    }
    selected[key] = descriptor.value;
  }
  return selected;
}

function publicStreamMessage(value: unknown, label: string): AssistantMessage {
  const snapshot = boundedJsonSnapshot(value, {
    label,
    maximumBytes: MAX_PUBLIC_STREAM_MESSAGE_BYTES,
    maximumValues: (ASSISTANT_CONTENT_LIMITS.argumentValues * 2) + ASSISTANT_CONTENT_LIMITS.blocks,
    maximumContainers: (ASSISTANT_CONTENT_LIMITS.containers * 2) + ASSISTANT_CONTENT_LIMITS.blocks,
    maximumDepth: ASSISTANT_CONTENT_LIMITS.argumentDepth + 2,
  });
  if (snapshot.value === null || typeof snapshot.value !== "object" || Array.isArray(snapshot.value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return JSON.parse(snapshot.serialized) as AssistantMessage;
}

function publicStreamIndex(value: unknown, kind: "text" | "thinking" | "tool"): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`Provider returned an invalid public stream ${kind} index`);
  }
  return value as number;
}

function publicStreamString(value: unknown, label: string, maximumBytes: number): { value: string; bytes: number } {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maximumBytes) throw new RangeError(`${label} exceeds ${maximumBytes} bytes`);
  return { value, bytes };
}

function publicStreamToolArguments(value: unknown): { value: JsonValue; serialized: string } {
  const snapshot = boundedJsonSnapshot(value, {
    label: "Provider public stream tool arguments",
    maximumBytes: MAX_TOOL_CALL_STREAM_DELTA_BYTES,
    maximumValues: ASSISTANT_CONTENT_LIMITS.argumentValues,
    maximumContainers: ASSISTANT_CONTENT_LIMITS.containers,
    maximumDepth: ASSISTANT_CONTENT_LIMITS.argumentDepth,
  });
  if (snapshot.value === null || typeof snapshot.value !== "object" || Array.isArray(snapshot.value)) {
    throw new TypeError("Provider public stream tool arguments must be a plain JSON object");
  }
  return { value: JSON.parse(snapshot.serialized) as JsonValue, serialized: snapshot.serialized };
}

function publicToolArgumentsRecord(value: JsonValue | undefined): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function publicBoundaryProviderState(value: unknown, api: ModelProtocolFamily): ProviderState {
  const selected = validateProviderState(value);
  if (selected.api !== api) {
    throw new TypeError(`Provider returned ${selected.api} continuation state for a ${api} stream`);
  }
  return JSON.parse(selected.serialized) as ProviderState;
}

type StreamPartKind = "text" | "thinking";

class StreamPartRetention {
  readonly #label: string;
  readonly #values = { text: new Map<number, string>(), thinking: new Map<number, string>() };
  readonly #bytes = { text: new Map<number, number>(), thinking: new Map<number, number>() };
  readonly #signatureBytes = { text: new Map<number, number>(), thinking: new Map<number, number>() };
  readonly #started = { text: new Set<number>(), thinking: new Set<number>() };
  readonly #completed = { text: new Set<number>(), thinking: new Set<number>() };
  #aggregateBytes = 0;

  constructor(label: string) {
    this.#label = label;
  }

  start(kind: StreamPartKind, part: number, explicit: boolean): boolean {
    if (this.#completed[kind].has(part)) throw new Error(`${this.#label} emitted ${kind} after completed part ${part}`);
    if (this.#started[kind].has(part)) {
      if (explicit) throw new Error(`${this.#label} emitted more than one ${kind}_start for part ${part}`);
      return false;
    }
    const other = kind === "text" ? this.#started.thinking : this.#started.text;
    if (this.#started[kind].size + other.size >= ASSISTANT_CONTENT_LIMITS.blocks) {
      throw new RangeError(`${this.#label} content exceeds ${ASSISTANT_CONTENT_LIMITS.blocks} streamed blocks`);
    }
    this.#started[kind].add(part);
    return true;
  }

  append(kind: StreamPartKind, part: number, delta: string): boolean {
    const deltaBytes = Buffer.byteLength(delta, "utf8");
    const totalBytes = (this.#bytes[kind].get(part) ?? 0) + deltaBytes;
    if (totalBytes > ASSISTANT_CONTENT_LIMITS.fieldBytes) {
      throw new RangeError(`${this.#label} ${kind} part ${part} exceeds ${ASSISTANT_CONTENT_LIMITS.fieldBytes} bytes`);
    }
    this.#setAggregate(this.#aggregateBytes + deltaBytes);
    const started = this.start(kind, part, false);
    this.#values[kind].set(part, `${this.#values[kind].get(part) ?? ""}${delta}`);
    this.#bytes[kind].set(part, totalBytes);
    return started;
  }

  finish(
    kind: StreamPartKind,
    part: number,
    content: string,
    signature = "",
  ): { newlyStarted: boolean; suffix: string } {
    if (this.#completed[kind].has(part)) throw new Error(`${this.#label} emitted more than one ${kind}_end for part ${part}`);
    const emitted = this.#values[kind].get(part) ?? "";
    if (!content.startsWith(emitted)) throw new Error(`${this.#label} final ${kind} did not match its streamed prefix`);
    const contentBytes = Buffer.byteLength(content, "utf8");
    const signatureBytes = Buffer.byteLength(signature, "utf8");
    this.#setAggregate(
      this.#aggregateBytes
        - (this.#bytes[kind].get(part) ?? 0)
        - (this.#signatureBytes[kind].get(part) ?? 0)
        + contentBytes
        + signatureBytes,
    );
    const newlyStarted = this.start(kind, part, false);
    this.#values[kind].set(part, content);
    this.#bytes[kind].set(part, contentBytes);
    this.#signatureBytes[kind].set(part, signatureBytes);
    this.#completed[kind].add(part);
    return { newlyStarted, suffix: content.slice(emitted.length) };
  }

  content(kind: StreamPartKind, part: number): string {
    return this.#values[kind].get(part) ?? "";
  }

  isCompleted(kind: StreamPartKind, part: number): boolean {
    return this.#completed[kind].has(part);
  }

  started(kind: StreamPartKind): ReadonlySet<number> {
    return this.#started[kind];
  }

  #setAggregate(value: number): void {
    if (value > ASSISTANT_CONTENT_LIMITS.contentBytes) {
      throw new RangeError(`${this.#label} content exceeds ${ASSISTANT_CONTENT_LIMITS.contentBytes} aggregate bytes`);
    }
    this.#aggregateBytes = value;
  }
}

async function* adapterEventsFromPublicStream(
  stream: AssistantMessageEventStream,
  api: ModelProtocolFamily,
): AsyncIterable<AdapterEvent> {
  let terminal = false;
  let started = false;
  const retainedParts = new StreamPartRetention("Provider public stream");
  const startedTools = new Set<number>();
  const completedTools = new Set<number>();
  const compatibilityProjector = new ProviderStreamProjector("extension-stream");

  const addTool = (index: number, explicit: boolean): void => {
    if (completedTools.has(index)) throw new Error(`Provider emitted a tool event after toolcall_end for index ${index}`);
    if (startedTools.has(index)) {
      if (explicit) throw new Error(`Provider emitted more than one toolcall_start for index ${index}`);
      return;
    }
    if (startedTools.size >= MAX_PUBLIC_STREAM_TOOL_CALLS) {
      throw new RangeError(
        `Provider returned more than ${MAX_PUBLIC_STREAM_TOOL_CALLS} streaming tool calls in one step`,
      );
    }
    startedTools.add(index);
  };

  for await (const rawEvent of stream) {
    if (terminal) throw new Error("Provider emitted an event after a terminal event");
    const event = publicStreamRecord(rawEvent, "Provider public stream event") as unknown as AssistantMessageEvent;
    if (typeof event.type !== "string") throw new TypeError("Provider public stream event type must be a string");
    const normalized = event as unknown as AdapterEvent;
    const isNormalized = normalized.type === "response_start"
      || normalized.type === "response_end"
      || normalized.type === "usage"
      || (normalized.type === "text_start" && "part" in normalized)
      || (normalized.type === "text_end" && "part" in normalized)
      || normalized.type === "reasoning_start"
      || normalized.type === "reasoning_end"
      || normalized.type === "reasoning_delta"
      || normalized.type === "tool_call_start"
      || normalized.type === "tool_call_delta"
      || normalized.type === "tool_call_end"
      || (normalized.type === "text_delta" && "text" in normalized)
      || (normalized.type === "error" && !("reason" in normalized));
    if (isNormalized) {
      const selected = snapshotAdapterEvent(normalized);
      const projected = compatibilityProjector.project(selected);
      if (projected === undefined) continue;
      if (selected.type === "response_start") {
        if (started) throw new Error("Provider emitted more than one start event");
        started = true;
      } else if (selected.type === "text_start") {
        retainedParts.start("text", selected.part, true);
      } else if (selected.type === "text_delta") {
        retainedParts.append("text", selected.part, selected.text);
      } else if (selected.type === "text_end") {
        retainedParts.finish("text", selected.part, selected.text, selected.textSignature);
      } else if (selected.type === "reasoning_start") {
        retainedParts.start("thinking", selected.part, true);
      } else if (selected.type === "reasoning_delta") {
        retainedParts.append("thinking", selected.part, selected.text);
      } else if (selected.type === "reasoning_end") {
        retainedParts.finish("thinking", selected.part, selected.text, selected.thinkingSignature);
      } else if (selected.type === "tool_call_start") {
        addTool(selected.index, true);
      } else if (selected.type === "tool_call_delta") {
        addTool(selected.index, false);
      } else if (selected.type === "tool_call_end") {
        addTool(selected.index, false);
        completedTools.add(selected.index);
      } else if (selected.type === "response_end" || selected.type === "error") {
        terminal = true;
      }
      yield selected;
    } else if (event.type === "start") {
      if (started) throw new Error("Provider emitted more than one start event");
      started = true;
      const partial = publicStreamRecord(event.partial, "Provider public stream start partial");
      const responseModel = partial.responseModel ?? partial.model;
      if (typeof responseModel !== "string") throw new TypeError("Provider public stream model must be a string");
      if (partial.responseId !== undefined && typeof partial.responseId !== "string") {
        throw new TypeError("Provider public stream response ID must be a string");
      }
      yield {
        type: "response_start",
        model: responseModel,
        ...(partial.responseId === undefined ? {} : { responseId: partial.responseId }),
      };
    } else if (event.type === "text_start") {
      const part = publicStreamIndex(event.contentIndex, "text");
      retainedParts.start("text", part, true);
      yield { type: "text_start", part };
    } else if (event.type === "text_delta") {
      const part = publicStreamIndex(event.contentIndex, "text");
      const delta = publicStreamString(
        event.delta,
        "Provider public stream text delta",
        ASSISTANT_CONTENT_LIMITS.fieldBytes,
      );
      if (retainedParts.append("text", part, delta.value)) {
        yield { type: "text_start", part };
      }
      yield { type: "text_delta", part, text: delta.value };
    } else if (event.type === "text_end") {
      const part = publicStreamIndex(event.contentIndex, "text");
      const content = publicStreamString(
        event.content,
        "Provider public stream final text",
        ASSISTANT_CONTENT_LIMITS.fieldBytes,
      );
      const signature = event.contentSignature === undefined
        ? undefined
        : publicStreamString(
            event.contentSignature,
            `Provider public stream text signature ${part}`,
            ASSISTANT_CONTENT_LIMITS.fieldBytes,
          );
      const completed = retainedParts.finish("text", part, content.value, signature?.value);
      if (completed.newlyStarted) {
        yield { type: "text_start", part };
      }
      if (completed.suffix !== "") yield { type: "text_delta", part, text: completed.suffix };
      yield {
        type: "text_end",
        part,
        text: content.value,
        ...(signature === undefined ? {} : { textSignature: signature.value }),
      };
    } else if (event.type === "thinking_start") {
      const part = publicStreamIndex(event.contentIndex, "thinking");
      retainedParts.start("thinking", part, true);
      yield { type: "reasoning_start", part, visibility: "provider_trace" };
    } else if (event.type === "thinking_delta") {
      const part = publicStreamIndex(event.contentIndex, "thinking");
      const delta = publicStreamString(
        event.delta,
        "Provider public stream thinking delta",
        ASSISTANT_CONTENT_LIMITS.fieldBytes,
      );
      if (retainedParts.append("thinking", part, delta.value)) {
        yield { type: "reasoning_start", part, visibility: "provider_trace" };
      }
      yield { type: "reasoning_delta", part, text: delta.value, visibility: "provider_trace" };
    } else if (event.type === "thinking_end") {
      const part = publicStreamIndex(event.contentIndex, "thinking");
      const content = publicStreamString(
        event.content,
        "Provider public stream final thinking",
        ASSISTANT_CONTENT_LIMITS.fieldBytes,
      );
      const signature = event.contentSignature === undefined
        ? undefined
        : publicStreamString(
            event.contentSignature,
            `Provider public stream thinking signature ${part}`,
            ASSISTANT_CONTENT_LIMITS.fieldBytes,
          );
      if (event.redacted !== undefined && typeof event.redacted !== "boolean") {
        throw new TypeError("Provider public stream thinking redacted marker must be a boolean");
      }
      const completed = retainedParts.finish("thinking", part, content.value, signature?.value);
      if (completed.newlyStarted) {
        yield { type: "reasoning_start", part, visibility: "provider_trace" };
      }
      if (completed.suffix !== "" && event.redacted !== true) {
        yield { type: "reasoning_delta", part, text: completed.suffix, visibility: "provider_trace" };
      }
      yield {
        type: "reasoning_end",
        part,
        text: content.value,
        visibility: "provider_trace",
        ...(signature === undefined ? {} : { thinkingSignature: signature.value }),
        ...(event.redacted === undefined ? {} : { redacted: event.redacted }),
      };
    } else if (event.type === "toolcall_start") {
      const index = publicStreamIndex(event.contentIndex, "tool");
      addTool(index, true);
      yield { type: "tool_call_start", index };
    } else if (event.type === "toolcall_delta") {
      const index = publicStreamIndex(event.contentIndex, "tool");
      addTool(index, false);
      const delta = publicStreamString(
        event.delta,
        "Provider public stream tool call delta",
        MAX_TOOL_CALL_STREAM_DELTA_BYTES,
      );
      yield { type: "tool_call_delta", index, jsonFragment: delta.value };
    } else if (event.type === "toolcall_end") {
      const index = publicStreamIndex(event.contentIndex, "tool");
      addTool(index, false);
      const toolCall = publicStreamRecord(event.toolCall, "Provider public stream tool call");
      const id = publicStreamString(toolCall.id, "Provider public stream tool call ID", MAX_TOOL_CALL_STREAM_ID_BYTES);
      const name = publicStreamString(toolCall.name, "Provider public stream tool call name", MAX_TOOL_CALL_STREAM_NAME_BYTES);
      const signature = toolCall.thoughtSignature === undefined
        ? undefined
        : publicStreamString(
            toolCall.thoughtSignature,
            "Provider public stream tool call signature",
            ASSISTANT_CONTENT_LIMITS.fieldBytes,
          );
      const argumentsSnapshot = publicStreamToolArguments(toolCall.arguments);
      completedTools.add(index);
      yield {
        type: "tool_call_end",
        index,
        id: id.value,
        name: name.value,
        arguments: argumentsSnapshot.value,
        rawArguments: argumentsSnapshot.serialized,
        ...(signature === undefined ? {} : { thoughtSignature: signature.value }),
      };
    } else if (event.type === "done") {
      terminal = true;
      const message = publicStreamMessage(event.message, "Provider public stream terminal message");
      const terminalContent = canonicalAssistantContent(message.content);
      for (const part of retainedParts.started("text")) {
        if (terminalContent[part]?.type !== "text") {
          throw new Error(`Provider terminal message omitted streamed text part ${part}`);
        }
      }
      for (const part of retainedParts.started("thinking")) {
        if (terminalContent[part]?.type !== "thinking") {
          throw new Error(`Provider terminal message omitted streamed thinking part ${part}`);
        }
      }
      if (!started) {
        yield {
          type: "response_start",
          model: message.responseModel ?? message.model,
          ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
        };
      }
      for (const [index, block] of terminalContent.entries()) {
        if (block.type === "text") {
          const emitted = retainedParts.content("text", index);
          if (!block.text.startsWith(emitted)) throw new Error("Provider terminal text did not match its streamed prefix");
          const completed = retainedParts.isCompleted("text", index);
          if (completed && block.text !== emitted) {
            throw new Error(`Provider terminal message changed completed streamed text part ${index}`);
          }
          if (!completed && retainedParts.start("text", index, false)) {
            yield { type: "text_start", part: index };
          }
          if (!completed && block.text.length > emitted.length) {
            yield { type: "text_delta", part: index, text: block.text.slice(emitted.length) };
          }
          if (!completed) {
            yield {
              type: "text_end",
              part: index,
              text: block.text,
              ...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }),
            };
          }
        } else if (block.type === "thinking") {
          const emitted = retainedParts.content("thinking", index);
          if (!block.thinking.startsWith(emitted)) throw new Error("Provider terminal thinking did not match its streamed prefix");
          const completed = retainedParts.isCompleted("thinking", index);
          if (completed && block.thinking !== emitted) {
            throw new Error(`Provider terminal message changed completed streamed thinking part ${index}`);
          }
          if (!completed && retainedParts.start("thinking", index, false)) {
            yield { type: "reasoning_start", part: index, visibility: "provider_trace" };
          }
          if (!completed && block.thinking.length > emitted.length) {
            yield { type: "reasoning_delta", part: index, text: block.thinking.slice(emitted.length), visibility: "provider_trace" };
          }
          if (!completed) {
            yield {
              type: "reasoning_end",
              part: index,
              text: block.thinking,
              visibility: "provider_trace",
              ...(block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature }),
              ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
            };
          }
        } else if (!completedTools.has(index)) {
          addTool(index, false);
          const argumentsSnapshot = publicStreamToolArguments(block.arguments);
          yield { type: "tool_call_start", index, id: block.callId, name: block.name };
          yield {
            type: "tool_call_end",
            index,
            id: block.callId,
            name: block.name,
            arguments: argumentsSnapshot.value,
            rawArguments: argumentsSnapshot.serialized,
            ...(block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature }),
          };
        }
      }
      yield { type: "usage", usage: normalizedUsageFromPublic(message.usage), semantics: "final" };
      yield {
        type: "response_end",
        reason: internalFinishReason(message.stopReason),
        state: stateFromAssistant({
          ...message,
          content: publicAssistantContent(terminalContent),
        }, api),
        content: terminalContent.map((block) =>
          block.type === "thinking"
            ? withThinkingVisibility(block, "provider_trace")
            : block),
        ...(() => {
          const diagnostics = canonicalAssistantDiagnostics(message.diagnostics);
          return diagnostics === undefined ? {} : { assistantDiagnostics: diagnostics };
        })(),
      };
    } else if (event.type === "error") {
      terminal = true;
      const message = publicStreamMessage(event.error, "Provider public stream error message");
      yield { type: "usage", usage: normalizedUsageFromPublic(message.usage), semantics: "final" };
      yield {
        type: "error",
        error: {
          category: event.reason === "aborted" ? "cancelled" : "provider",
          message: message.errorMessage ?? "Provider stream failed",
          retryable: false,
          partial: message.content.length > 0,
        },
      };
    }
  }
  if (!terminal) {
    yield {
      type: "error",
      error: {
        category: "protocol",
        message: "Provider stream ended without a terminal event",
        retryable: true,
        partial: true,
      },
    };
  }
}

/** @internal Adapt a low-level agent stream hook to the canonical provider event boundary. */
export async function* streamFunctionAdapterEvents(
  model: Model<Api>,
  request: ProviderRequest,
  signal: AbortSignal,
  streamFunction: StreamFn,
  overrides: SimpleStreamOptions = {},
): AsyncIterable<AdapterEvent> {
  const options = publicOptionsFromInternal({
    signal,
    ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
    ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
    ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.cacheRetention === undefined ? {} : { cacheRetention: request.cacheRetention }),
    ...(request.thinkingBudgets === undefined ? {} : { thinkingBudgets: request.thinkingBudgets }),
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
    ...(request.transport === undefined ? {} : { transport: request.transport }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(request.maxRetries === undefined ? {} : { maxRetries: request.maxRetries }),
    ...(request.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: request.maxRetryDelayMs }),
    ...(request.onPayload === undefined ? {} : { onPayload: request.onPayload }),
    ...(request.onResponse === undefined ? {} : { onResponse: request.onResponse }),
    ...(request.modelSettings?.headers === undefined ? {} : { headers: request.modelSettings.headers }),
  });
  const stream = await streamFunction(model, publicContextFromInternal({
    messages: request.messages,
    tools: request.tools,
    ...(request.providerState === undefined ? {} : { providerState: request.providerState }),
  }, model), { ...options, ...overrides, signal });
  yield* adapterEventsFromPublicStream(stream, request.api ?? protocolFromPublicApi(model.api));
}

const PROVIDER_STATE_KINDS = new Set([
  "anthropic_messages",
  "bedrock_converse",
  "chat_completions",
  "extension_stream",
  "gemini_generate_content",
  "gemini_interactions",
  "ollama_chat",
  "openai_responses",
  "openrouter_chat",
]);

function isProviderState(value: unknown): value is ProviderState {
  if (!isJsonValue(value) || value === null || Array.isArray(value) || typeof value !== "object") return false;
  if (typeof value.kind !== "string" || !PROVIDER_STATE_KINDS.has(value.kind)) return false;
  switch (value.kind) {
    case "openai_responses":
      return Array.isArray(value.outputItems) && (value.previousResponseId === undefined || typeof value.previousResponseId === "string");
    case "anthropic_messages": return Array.isArray(value.assistantBlocks);
    case "gemini_interactions":
      return Array.isArray(value.steps) && (value.previousInteractionId === undefined || typeof value.previousInteractionId === "string");
    case "gemini_generate_content": return Array.isArray(value.parts);
    case "extension_stream":
      return Array.isArray(value.assistantContent) && (value.responseId === undefined || typeof value.responseId === "string");
    case "bedrock_converse":
    case "chat_completions":
    case "openrouter_chat":
    case "ollama_chat": return Object.hasOwn(value, "assistantMessage");
    default: return false;
  }
}

function internalContextFromPublic(context: Context): ProviderStreamContext {
  const messages: CanonicalMessage[] = [];
  if (context.systemPrompt !== undefined && context.systemPrompt !== "") {
    messages.push({
      id: createId("message"),
      role: "system",
      content: [{ type: "text", text: context.systemPrompt }],
      createdAt: new Date().toISOString(),
      purpose: "instructions",
    });
  }
  let providerState: ProviderState | undefined;
  for (const message of context.messages) {
    const createdAt = new Date(message.timestamp).toISOString();
    if (message.role === "user") {
      const content = typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content.map((block) => block.type === "text"
          ? { type: "text" as const, text: block.text }
          : { type: "image" as const, mediaType: block.mimeType, data: block.data });
      messages.push({ id: createId("message"), role: "user", content, createdAt });
      continue;
    }
    if (message.role === "assistant") {
      const api = protocolFromPublicApi(message.api);
      const content = canonicalAssistantContent(message.content);
      const diagnostics = canonicalAssistantDiagnostics(message.diagnostics);
      messages.push({
        id: createId("message"),
        role: "assistant",
        content,
        createdAt,
        provider: message.provider,
        model: message.model,
        ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
        ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
        ...(diagnostics === undefined ? {} : { diagnostics }),
        api,
        ...(publicApiFromProtocol(api) === message.api ? {} : { publicApi: message.api }),
        stopReason: internalFinishReason(message.stopReason),
        ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
        usage: normalizedUsageFromPublic(message.usage),
      });
      if (message.providerState !== undefined && isJsonValue(message.providerState.value)) {
        const value = message.providerState.value;
        providerState = isProviderState(value)
          ? value
          : {
              kind: "extension_stream",
              assistantContent: [],
              source: {
                provider: message.providerState.source.provider,
                model: message.providerState.source.model,
                api: protocolFromPublicApi(message.providerState.source.api),
              },
            };
      }
      continue;
    }
    const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const images = message.content.flatMap((block) => block.type === "image"
      ? [{ type: "image" as const, mediaType: block.mimeType, data: block.data }]
      : []);
    const result: ToolResultBlock = {
      type: "tool_result",
      callId: message.toolCallId,
      name: message.toolName,
      content: text,
      isError: message.isError,
      ...(images.length === 0 ? {} : { images }),
      ...(message.details === undefined || !isJsonValue(message.details) ? {} : { metadata: message.details }),
    };
    messages.push({ id: createId("message"), role: "tool", content: [result], createdAt });
  }
  const tools: ProviderToolDefinition[] | undefined = context.tools?.map((tool) => {
    if (!isJsonValue(tool.parameters) || tool.parameters === null || Array.isArray(tool.parameters) || typeof tool.parameters !== "object") {
      throw new TypeError(`Tool ${tool.name} parameters must be a JSON object`);
    }
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
      ...(tool.constrainedSampling === undefined
        ? {}
        : { constrainedSampling: structuredClone(tool.constrainedSampling) }),
    };
  });
  return {
    messages,
    ...(tools === undefined ? {} : { tools }),
    ...(providerState === undefined ? {} : { providerState }),
  };
}

function canonicalToolChoice(value: unknown): ProviderRequest["toolChoice"] | undefined {
  if (value === "auto" || value === "none" || value === "required") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const selected = value as { type?: unknown; function?: unknown };
  if (selected.type !== "function" || selected.function === null || typeof selected.function !== "object") {
    return undefined;
  }
  const name = (selected.function as { name?: unknown }).name;
  return typeof name === "string" ? { type: "function", function: { name } } : undefined;
}

function internalOptionsFromPublic(
  options: (StreamOptions & {
    reasoning?: SimpleStreamOptions["reasoning"];
    thinkingBudgets?: SimpleStreamOptions["thinkingBudgets"];
    toolChoice?: unknown;
  }) | undefined,
): ProviderStreamOptions {
  const metadata = options?.metadata === undefined
    ? undefined
    : Object.fromEntries(Object.entries(options.metadata).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const toolChoice = canonicalToolChoice(options?.toolChoice);
  return {
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
    ...(options?.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options?.headers === undefined ? {} : { headers: options.headers }),
    ...(options?.env === undefined ? {} : { env: options.env }),
    ...(options?.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options?.maxTokens === undefined ? {} : { maxOutputTokens: options.maxTokens }),
    ...(options?.reasoning === undefined ? {} : { reasoningEffort: options.reasoning }),
    ...(toolChoice === undefined ? {} : { toolChoice }),
    ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options?.cacheRetention === undefined ? {} : { cacheRetention: options.cacheRetention }),
    ...(options?.thinkingBudgets === undefined ? {} : { thinkingBudgets: options.thinkingBudgets }),
    ...(options?.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(options?.transport === undefined ? {} : { transport: options.transport }),
    ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options?.websocketConnectTimeoutMs === undefined
      ? {}
      : { websocketConnectTimeoutMs: options.websocketConnectTimeoutMs }),
    ...(options?.websocketIdleTimeoutMs === undefined
      ? {}
      : { websocketIdleTimeoutMs: options.websocketIdleTimeoutMs }),
    ...(options?.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    ...(options?.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: options.maxRetryDelayMs }),
    ...(options?.onPayload === undefined ? {} : { onPayload: options.onPayload }),
    ...(options?.onResponse === undefined ? {} : { onResponse: options.onResponse }),
  };
}

function publicStreamFromAdapterEvents(
  model: Model<Api>,
  events: AsyncIterable<AdapterEvent>,
  signal?: AbortSignal,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  queueMicrotask(() => void (async () => {
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: publicUsageFromNormalized(undefined),
      stopReason: "pending",
      timestamp: Date.now(),
    };
    const textIndexes = new Map<number, number>();
    const thinkingIndexes = new Map<number, number>();
    const toolIndexes = new Map<number, number>();
    const retainedParts = new StreamPartRetention("Provider stream");
    const projector = new ProviderStreamProjector(model.provider);
    let started = false;
    let terminal = false;
    const snapshot = () => structuredClone(message);
    const appendContent = (block: AssistantMessage["content"][number]): number => {
      if (message.content.length >= ASSISTANT_CONTENT_LIMITS.blocks) {
        throw new RangeError(`Provider stream exceeds ${ASSISTANT_CONTENT_LIMITS.blocks} public content blocks`);
      }
      const index = message.content.length;
      message.content.push(block);
      return index;
    };
    const start = () => {
      if (started) return;
      started = true;
      output.push({ type: "start", partial: snapshot() });
    };
    try {
      for await (const sourceEvent of events) {
        signal?.throwIfAborted();
        const canonicalSourceEvent = snapshotAdapterEvent(sourceEvent);
        const projected = projector.project(canonicalSourceEvent);
        if (projected === undefined) continue;
        const { event } = projected;
        if (event.type === "response_start") {
          message.responseModel = event.model;
          if (event.responseId !== undefined) message.responseId = event.responseId;
          const diagnostics = assistantDiagnosticsFromProviderResponse(event.diagnostics);
          if (diagnostics !== undefined) message.diagnostics = diagnostics;
          start();
        } else if (event.type === "text_start") {
          start();
          retainedParts.start("text", event.part, true);
          const index = appendContent({ type: "text", text: "" });
          textIndexes.set(event.part, index);
          output.push({ type: "text_start", contentIndex: index, partial: snapshot() });
        } else if (event.type === "text_delta") {
          start();
          retainedParts.append("text", event.part, event.delta);
          let index = textIndexes.get(event.part);
          if (index === undefined) {
            index = appendContent({ type: "text", text: "" });
            textIndexes.set(event.part, index);
            output.push({ type: "text_start", contentIndex: index, partial: snapshot() });
          }
          const block = message.content[index];
          if (block?.type !== "text") throw new Error("Provider text stream index changed type");
          block.text += event.delta;
          output.push({ type: "text_delta", contentIndex: index, delta: event.delta, partial: snapshot() });
        } else if (event.type === "text_end") {
          start();
          retainedParts.finish("text", event.part, event.content, event.contentSignature);
          let index = textIndexes.get(event.part);
          if (index === undefined) {
            index = appendContent({ type: "text", text: "" });
            textIndexes.set(event.part, index);
            output.push({ type: "text_start", contentIndex: index, partial: snapshot() });
          }
          const block = message.content[index];
          if (block?.type !== "text") throw new Error("Provider text stream index changed type");
          block.text = event.content;
          if (event.contentSignature !== undefined) block.textSignature = event.contentSignature;
          output.push({
            type: "text_end",
            contentIndex: index,
            content: block.text,
            ...(block.textSignature === undefined ? {} : { contentSignature: block.textSignature }),
            partial: snapshot(),
          });
        } else if (event.type === "reasoning_start") {
          if (event.visibility === "provider_trace") continue;
          start();
          retainedParts.start("thinking", event.part, true);
          const index = appendContent({ type: "thinking", thinking: "" });
          thinkingIndexes.set(event.part, index);
          output.push({ type: "thinking_start", contentIndex: index, partial: snapshot() });
        } else if (event.type === "reasoning_delta") {
          if (event.visibility === "provider_trace") continue;
          start();
          retainedParts.append("thinking", event.part, event.delta);
          let index = thinkingIndexes.get(event.part);
          if (index === undefined) {
            index = appendContent({ type: "thinking", thinking: "" });
            thinkingIndexes.set(event.part, index);
            output.push({ type: "thinking_start", contentIndex: index, partial: snapshot() });
          }
          const block = message.content[index];
          if (block?.type !== "thinking") throw new Error("Provider reasoning stream index changed type");
          block.thinking += event.delta;
          output.push({ type: "thinking_delta", contentIndex: index, delta: event.delta, partial: snapshot() });
        } else if (event.type === "reasoning_end") {
          if (event.visibility === "provider_trace") continue;
          start();
          retainedParts.finish("thinking", event.part, event.content, event.contentSignature);
          let index = thinkingIndexes.get(event.part);
          if (index === undefined) {
            index = appendContent({ type: "thinking", thinking: "" });
            thinkingIndexes.set(event.part, index);
            output.push({ type: "thinking_start", contentIndex: index, partial: snapshot() });
          }
          const block = message.content[index];
          if (block?.type !== "thinking") throw new Error("Provider reasoning stream index changed type");
          block.thinking = event.content;
          if (event.contentSignature !== undefined) block.thinkingSignature = event.contentSignature;
          if (event.redacted !== undefined) block.redacted = event.redacted;
          output.push({
            type: "thinking_end",
            contentIndex: index,
            content: block.thinking,
            ...(block.thinkingSignature === undefined ? {} : { contentSignature: block.thinkingSignature }),
            ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
            partial: snapshot(),
          });
        } else if (event.type === "tool_call_start") {
          start();
          const index = appendContent({
            type: "toolCall",
            id: event.partial.id ?? createId("tool"),
            name: event.partial.name ?? "",
            arguments: publicToolArgumentsRecord(event.partial.arguments),
          });
          toolIndexes.set(event.index, index);
          output.push({ type: "toolcall_start", contentIndex: index, partial: snapshot() });
        } else if (event.type === "tool_call_delta") {
          start();
          let index = toolIndexes.get(event.index);
          if (index === undefined) {
            index = appendContent({
              type: "toolCall",
              id: event.partial.id ?? createId("tool"),
              name: event.partial.name ?? "",
              arguments: publicToolArgumentsRecord(event.partial.arguments),
            });
            toolIndexes.set(event.index, index);
            output.push({ type: "toolcall_start", contentIndex: index, partial: snapshot() });
          }
          const block = message.content[index];
          if (block?.type !== "toolCall") throw new Error("Provider tool-call stream index changed type");
          if (event.partial.id !== undefined) block.id = event.partial.id;
          if (event.partial.name !== undefined) block.name = event.partial.name;
          if (event.partial.arguments !== undefined) {
            block.arguments = publicToolArgumentsRecord(event.partial.arguments);
          }
          output.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta, partial: snapshot() });
        } else if (event.type === "tool_call_end") {
          start();
          const index = toolIndexes.get(event.index) ?? message.content.length;
          let block = message.content[index];
          if (block?.type !== "toolCall") {
            block = {
              type: "toolCall",
              id: event.toolCall.id ?? createId("tool"),
              name: event.toolCall.name ?? "",
              arguments: {},
            };
            if (index === message.content.length) appendContent(block);
            else message.content[index] = block;
          }
          toolIndexes.set(event.index, index);
          block.id = event.toolCall.id ?? block.id;
          block.name = event.toolCall.name ?? block.name;
          block.arguments = event.toolCall.arguments !== undefined
            && !Array.isArray(event.toolCall.arguments)
            && event.toolCall.arguments !== null
            && typeof event.toolCall.arguments === "object"
            ? event.toolCall.arguments
            : {};
          if (event.toolCall.thoughtSignature !== undefined) block.thoughtSignature = event.toolCall.thoughtSignature;
          output.push({ type: "toolcall_end", contentIndex: index, toolCall: structuredClone(block), partial: snapshot() });
        } else if (event.type === "usage") {
          message.usage = publicUsageFromNormalized(event.usage);
        } else if (event.type === "response_end") {
          if (canonicalSourceEvent.type !== "response_end") {
            throw new Error("Provider stream projection changed terminal type");
          }
          start();
          if (event.assistantDiagnostics !== undefined) {
            message.diagnostics = canonicalAssistantDiagnostics(event.assistantDiagnostics)!;
          }
          const terminalContent = event.content ?? assistantContentFromProviderState(canonicalSourceEvent.state);
          if (terminalContent !== undefined) {
            const startedTextParts = new Set(textIndexes.keys());
            const startedThinkingParts = new Set(thinkingIndexes.keys());
            message.content = publicAssistantContent(terminalContent.filter((block) =>
              block.type !== "thinking" || block.visibility === "summary"));
            textIndexes.clear();
            thinkingIndexes.clear();
            toolIndexes.clear();
            for (const [index, block] of message.content.entries()) {
              if (block.type === "text") {
                textIndexes.set(index, index);
                if (!startedTextParts.has(index)) output.push({ type: "text_start", contentIndex: index, partial: snapshot() });
              }
              else if (block.type === "thinking") {
                thinkingIndexes.set(index, index);
                if (!startedThinkingParts.has(index)) output.push({ type: "thinking_start", contentIndex: index, partial: snapshot() });
              }
              else toolIndexes.set(index, index);
            }
          }
          for (const [part, index] of textIndexes) {
            if (retainedParts.isCompleted("text", part)) continue;
            const block = message.content[index];
            if (block?.type === "text") output.push({
              type: "text_end",
              contentIndex: index,
              content: block.text,
              ...(block.textSignature === undefined ? {} : { contentSignature: block.textSignature }),
              partial: snapshot(),
            });
          }
          for (const [part, index] of thinkingIndexes) {
            if (retainedParts.isCompleted("thinking", part)) continue;
            const block = message.content[index];
            if (block?.type === "thinking") output.push({
              type: "thinking_end",
              contentIndex: index,
              content: block.thinking,
              ...(block.thinkingSignature === undefined ? {} : { contentSignature: block.thinkingSignature }),
              ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
              partial: snapshot(),
            });
          }
          message.stopReason = publicStopReason(event.reason);
          const providerState = publicBoundaryProviderState(
            canonicalSourceEvent.state,
            protocolFromPublicApi(model.api),
          );
          message.providerState = {
            source: { api: model.api, provider: model.provider, model: model.id },
            value: providerState as unknown as JsonValue,
          };
          terminal = true;
          output.push({
            type: "done",
            reason: message.stopReason === "length" ? "length" : message.stopReason === "toolUse" ? "toolUse" : "stop",
            message: snapshot(),
          });
          break;
        } else if (event.type === "error") {
          start();
          message.stopReason = event.error.category === "cancelled" ? "aborted" : "error";
          message.errorMessage = event.error.message;
          terminal = true;
          output.push({ type: "error", reason: message.stopReason, error: snapshot() });
          break;
        }
      }
      if (!terminal) throw new Error("Provider stream ended without a terminal event");
    } catch (error) {
      if (terminal) return;
      start();
      message.stopReason = signal?.aborted ? "aborted" : "error";
      message.errorMessage = errorMessage(error);
      output.push({ type: "error", reason: message.stopReason, error: snapshot() });
    }
  })());
  return output;
}

function internalOAuthCredential(credential: OAuthCredentials): ProviderOAuthCredential {
  return { ...credential, type: "oauth" };
}

function publicOAuthCredential(credential: ProviderOAuthCredential): OAuthCredentials {
  return { ...credential, type: "oauth" };
}

function internalAuthFromPublic(auth: ExtensionProvider["auth"]): InternalProviderAuth {
  return {
    ...(auth.apiKey === undefined ? {} : {
      apiKey: {
        name: auth.apiKey.name,
        ...(auth.apiKey.login === undefined ? {} : { login: (interaction) => auth.apiKey!.login!(interaction) }),
        ...(auth.apiKey.check === undefined ? {} : { check: (input) => auth.apiKey!.check!(input) }),
        resolve: (input) => auth.apiKey!.resolve(input),
      },
    }),
    ...(auth.providerAccount === undefined ? {} : {
      providerAccount: {
        name: auth.providerAccount.name,
        ...(auth.providerAccount.loginLabel === undefined ? {} : { loginLabel: auth.providerAccount.loginLabel }),
        login: (interaction) => auth.providerAccount!.login(interaction),
      },
    }),
    ...(auth.oauth === undefined ? {} : {
      oauth: {
        name: auth.oauth.name,
        ...(auth.oauth.loginLabel === undefined ? {} : { loginLabel: auth.oauth.loginLabel }),
        async login(interaction) {
          return internalOAuthCredential(await auth.oauth!.login(interaction));
        },
        async refresh(credential, signal) {
          return internalOAuthCredential(await auth.oauth!.refresh(publicOAuthCredential(credential), signal));
        },
        toAuth: (credential) => auth.oauth!.toAuth(publicOAuthCredential(credential)),
      },
    }),
  };
}

function publicAuthFromInternal(auth: InternalProviderAuth): ExtensionProvider["auth"] {
  const internalOAuth = auth.oauth;
  const publicOAuth = internalOAuth?.login === undefined || internalOAuth.refresh === undefined
    ? undefined
    : {
        name: internalOAuth.name,
        ...(internalOAuth.loginLabel === undefined ? {} : { loginLabel: internalOAuth.loginLabel }),
        async login(interaction: Parameters<NonNullable<ExtensionProvider["auth"]["oauth"]>["login"]>[0]) {
          return publicOAuthCredential(await internalOAuth.login!(interaction));
        },
        async refresh(
          credential: OAuthCredentials,
          signal?: AbortSignal,
        ) {
          return publicOAuthCredential(await internalOAuth.refresh!(internalOAuthCredential(credential), signal));
        },
        toAuth: (credential: OAuthCredentials) => internalOAuth.toAuth(internalOAuthCredential(credential)),
      };
  return {
    ...(auth.apiKey === undefined ? {} : {
      apiKey: {
        name: auth.apiKey.name,
        ...(auth.apiKey.login === undefined ? {} : { login: (interaction) => auth.apiKey!.login!(interaction) }),
        ...(auth.apiKey.check === undefined ? {} : { check: (input) => auth.apiKey!.check!(input) }),
        resolve: (input) => auth.apiKey!.resolve(input),
      },
    }),
    ...(auth.providerAccount === undefined ? {} : {
      providerAccount: {
        name: auth.providerAccount.name,
        ...(auth.providerAccount.loginLabel === undefined ? {} : { loginLabel: auth.providerAccount.loginLabel }),
        login: (interaction) => auth.providerAccount!.login(interaction),
      },
    }),
    ...(publicOAuth === undefined ? {} : { oauth: publicOAuth }),
  };
}

function internalProviderConfigModel(
  definition: ExtensionProviderModelConfig,
): InternalProviderModelConfig {
  return {
    id: definition.id,
    name: definition.name,
    ...(definition.api === undefined ? {} : { api: protocolFromPublicApi(definition.api) }),
    ...(definition.baseUrl === undefined ? {} : { baseUrl: definition.baseUrl }),
    reasoning: definition.reasoning,
    ...(definition.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: definition.thinkingLevelMap }),
    input: [...definition.input],
    cost: { ...definition.cost, ...(definition.cost.tiers === undefined ? {} : { tiers: definition.cost.tiers.map((tier) => ({ ...tier })) }) },
    contextWindow: definition.contextWindow,
    ...(definition.maxInputTokens === undefined ? {} : { maxInputTokens: definition.maxInputTokens }),
    maxTokens: definition.maxTokens,
    ...(definition.headers === undefined ? {} : { headers: { ...definition.headers } }),
    ...(() => {
      const compat = compatibilityToInternal(definition.compat);
      return compat === undefined ? {} : { compat };
    })(),
  };
}

/** Present one core provider model through the stable public model contract. */
export function extensionModel(
  model: ProviderModel,
  api: Api = publicApiFromProtocol(model.api),
): Model<Api> {
  return {
    id: model.id,
    name: model.name,
    api,
    provider: model.provider,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: { ...model.thinkingLevelMap } }),
    input: [...model.input],
    cost: {
      ...model.cost,
      ...(model.cost.tiers === undefined ? {} : { tiers: model.cost.tiers.map((tier) => ({ ...tier })) }),
    },
    contextWindow: model.contextWindow,
    ...(model.maxInputTokens === undefined ? {} : { maxInputTokens: model.maxInputTokens }),
    maxTokens: model.maxTokens,
    ...(model.headers === undefined ? {} : { headers: { ...model.headers } }),
    ...(() => {
      const compat = compatibilityFromInternal(model.compat);
      return compat === undefined ? {} : { compat };
    })(),
  };
}

/** Clone and recursively freeze one extension-facing model snapshot. */
export function immutableExtensionModel(model: Model<Api>): Model<Api> {
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  };
  const snapshot = structuredClone(model);
  freeze(snapshot);
  return snapshot;
}

/** Extension-facing model directory backed by the active internal model registry. */
export class ExtensionModelRegistry {
  readonly #internal: InternalModelRegistry;
  readonly #publicModels = new Map<string, Model<Api>>();
  readonly #publicProviders = new Map<string, ExtensionProvider>();
  readonly #providerViews = new Map<string, ExtensionProvider>();
  readonly #publicConfigs = new Map<string, ExtensionProviderConfig>();

  constructor(internal: InternalModelRegistry) {
    this.#internal = internal;
  }

  #clearPublicModels(provider: string): void {
    for (const key of this.#publicModels.keys()) {
      if (key.startsWith(`${provider}\0`)) this.#publicModels.delete(key);
    }
  }

  async refresh(): Promise<void> { await this.#internal.refresh(); }
  getError(): string | undefined { return this.#internal.getError(); }

  #publicModel(model: ProviderModel): Model<Api> {
    const key = modelKey(model.provider, model.id);
    const preserved = this.#publicModels.get(key);
    const selected = extensionModel(model, preserved?.api);
    if (preserved?.compat !== undefined) selected.compat = preserved.compat;
    this.#publicModels.set(key, selected);
    return selected;
  }

  /** Present one internal model through the stable public provider contract. */
  present(model: ProviderModel): Model<Api> {
    return this.#publicModel(model);
  }

  resolve(model: Model<Api>): ProviderModel {
    const selected = this.#internal.find(model.provider, model.id);
    if (selected !== undefined) {
      this.#publicModels.set(modelKey(model.provider, model.id), model);
      return selected;
    }
    const converted: ProviderModel = {
      id: model.id,
      name: model.name,
      api: protocolFromPublicApi(model.api),
      provider: model.provider,
      baseUrl: model.baseUrl,
      reasoning: model.reasoning,
      ...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: { ...model.thinkingLevelMap } }),
      input: [...model.input],
      cost: { ...model.cost, ...(model.cost.tiers === undefined ? {} : { tiers: model.cost.tiers.map((tier) => ({ ...tier })) }) },
      contextWindow: model.contextWindow,
      ...(model.maxInputTokens === undefined ? {} : { maxInputTokens: model.maxInputTokens }),
      maxTokens: model.maxTokens,
      ...(model.headers === undefined ? {} : { headers: { ...model.headers } }),
      ...(() => {
        const compat = compatibilityToInternal(model.compat);
        return compat === undefined ? {} : { compat };
      })(),
    };
    this.#publicModels.set(modelKey(model.provider, model.id), model);
    return converted;
  }

  getAll(): Model<Api>[] { return this.#internal.getAll().map((model) => this.#publicModel(model)); }
  getAvailable(): Model<Api>[] { return this.#internal.getAvailable().map((model) => this.#publicModel(model)); }
  find(provider: string, modelId: string): Model<Api> | undefined {
    const model = this.#internal.find(provider, modelId);
    return model === undefined ? undefined : this.#publicModel(model);
  }
  hasConfiguredAuth(model: Model<Api>): boolean { return this.#internal.hasConfiguredAuth(model.provider); }
  getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> { return this.#internal.getApiKeyAndHeaders(this.resolve(model)); }
  getApiKeyForProvider(provider: string): Promise<string | undefined> { return this.#internal.getApiKeyForProvider(provider); }
  getProviderAuthStatus(provider: string): ProviderAuthStatus { return this.#internal.getProviderAuthStatus(provider); }
  getProviderDisplayName(provider: string): string { return this.#internal.getProviderDisplayName(provider); }
  getProviderAuth(provider: string) { return this.#internal.getProviderAuth(provider); }
  isUsingOAuth(model: Model<Api>): boolean { return this.#internal.isUsingOAuth(model.provider); }

  getProvider(provider: string): ExtensionProvider | undefined {
    const registered = this.#publicProviders.get(provider);
    if (registered !== undefined) return registered;
    const cached = this.#providerViews.get(provider);
    if (cached !== undefined) return cached;
    const internal = this.#internal.getProvider(provider);
    if (internal === undefined) return undefined;
    const view = publicProviderFromInternal(internal, this);
    this.#providerViews.set(provider, view);
    return view;
  }

  registerProvider(provider: ExtensionProvider): void;
  registerProvider(providerName: string, config: ExtensionProviderConfig): void;
  registerProvider(providerOrName: ExtensionProvider | string, config?: ExtensionProviderConfig): void {
    const id = typeof providerOrName === "string" ? providerOrName : providerOrName.id;
    if (typeof providerOrName !== "string") {
      this.#clearPublicModels(id);
      this.#publicProviders.set(id, providerOrName);
      this.#providerViews.delete(id);
      this.#publicConfigs.delete(id);
      for (const model of providerOrName.getModels()) this.#publicModels.set(modelKey(id, model.id), model);
      this.#internal.registerProvider(internalProviderFromExtension(providerOrName, this));
      return;
    }
    if (config === undefined) {
      throw new Error("A provider object is required when registration uses a string name");
    }
    const replacingNativeProvider = this.#publicProviders.has(id);
    this.#publicProviders.delete(id);
    this.#providerViews.delete(id);
    const merged = { ...this.#publicConfigs.get(id) } as ExtensionProviderConfig;
    for (const [name, value] of Object.entries(config)) {
      if (value !== undefined) (merged as Record<string, unknown>)[name] = value;
    }
    this.#publicConfigs.set(id, merged);
    if (replacingNativeProvider || config.models !== undefined) this.#clearPublicModels(id);
    if (config.models !== undefined) rememberConfigModels(this, id, merged, config.models);
    this.#internal.registerProvider(id, internalProviderConfigFromExtension(id, config, this));
  }

  unregisterProvider(providerName: string): void {
    this.#publicProviders.delete(providerName);
    this.#providerViews.delete(providerName);
    this.#publicConfigs.delete(providerName);
    this.#clearPublicModels(providerName);
    this.#internal.unregisterProvider(providerName);
  }

  getRegisteredProviderConfig(providerName: string): ExtensionProviderConfig | undefined {
    return this.#publicConfigs.get(providerName);
  }
  getRegisteredNativeProvider(providerName: string): ExtensionProvider | undefined {
    return this.#publicProviders.get(providerName);
  }
  getRegisteredProviderIds(): readonly string[] {
    return [...new Set([...this.#publicConfigs.keys(), ...this.#publicProviders.keys()])];
  }
}

const REGISTRY_VIEWS = new WeakMap<InternalModelRegistry, ExtensionModelRegistry>();

export function extensionModelRegistry(internal: InternalModelRegistry): ExtensionModelRegistry {
  const existing = REGISTRY_VIEWS.get(internal);
  if (existing !== undefined) return existing;
  const created = new ExtensionModelRegistry(internal);
  REGISTRY_VIEWS.set(internal, created);
  return created;
}

function rememberConfigModels(
  registry: ExtensionModelRegistry,
  provider: string,
  config: ExtensionProviderConfig,
  definitions: readonly ExtensionProviderModelConfig[],
): void {
  for (const definition of definitions) {
    const current = registry.find(provider, definition.id);
    const api = definition.api ?? config.api ?? current?.api;
    const baseUrl = definition.baseUrl ?? config.baseUrl ?? current?.baseUrl;
    if (api === undefined || baseUrl === undefined) continue;
    registry.resolve({
      id: definition.id,
      name: definition.name,
      api,
      provider,
      baseUrl,
      reasoning: definition.reasoning,
      ...(definition.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: { ...definition.thinkingLevelMap } }),
      input: [...definition.input],
      cost: {
        ...definition.cost,
        ...(definition.cost.tiers === undefined ? {} : { tiers: definition.cost.tiers.map((tier) => ({ ...tier })) }),
      },
      contextWindow: definition.contextWindow,
      ...(definition.maxInputTokens === undefined ? {} : { maxInputTokens: definition.maxInputTokens }),
      maxTokens: definition.maxTokens,
      ...(definition.headers === undefined ? {} : { headers: { ...definition.headers } }),
      ...(definition.compat === undefined ? {} : { compat: definition.compat }),
    });
  }
}

function publicProviderFromInternal(
  provider: InternalProvider,
  registry: ExtensionModelRegistry,
): ExtensionProvider {
  return {
    id: provider.id,
    name: provider.name,
    ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
    ...(provider.headers === undefined ? {} : { headers: provider.headers }),
    auth: publicAuthFromInternal(provider.auth),
    getModels: () => provider.getModels().map((model) => registry.present(model)),
    ...(provider.refreshModels === undefined ? {} : {
      async refreshModels(context) {
        await provider.refreshModels!({
          ...(context.credential === undefined ? {} : { credential: context.credential }),
          store: {
            async read() {
              const stored = await context.store.read();
              return stored === undefined
                ? undefined
                : { ...stored, models: stored.models.map((model) => registry.resolve(model)) };
            },
            async write(entry) {
              await context.store.write({ ...entry, models: entry.models.map((model) => registry.present(model)) });
            },
            delete: () => context.store.delete(),
          },
          allowNetwork: context.allowNetwork,
          ...(context.force === undefined ? {} : { force: context.force }),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
      },
    }),
    ...(provider.filterModels === undefined ? {} : {
      filterModels(models, credential) {
        return provider.filterModels!(models.map((model) => registry.resolve(model)), credential)
          .map((model) => registry.present(model));
      },
    }),
    stream(model, context, options) {
      const internal = registry.resolve(model);
      return publicStreamFromAdapterEvents(
        model,
        provider.stream(internal, internalContextFromPublic(context), internalOptionsFromPublic(options)),
        options?.signal,
      );
    },
    streamSimple(model, context, options) {
      const internal = registry.resolve(model);
      return publicStreamFromAdapterEvents(
        model,
        provider.streamSimple(internal, internalContextFromPublic(context), internalOptionsFromPublic(options)),
        options?.signal,
      );
    },
  };
}

function internalProviderFromExtension(
  provider: ExtensionProvider,
  registry: ExtensionModelRegistry,
): InternalProvider {
  let models = provider.getModels().map((model) => registry.resolve(model));
  return {
    id: provider.id,
    name: provider.name,
    ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
    ...(provider.headers === undefined ? {} : { headers: provider.headers }),
    auth: internalAuthFromPublic(provider.auth),
    getModels: () => models,
    ...(provider.refreshModels === undefined ? {} : {
      async refreshModels(context: ProviderRefreshContext) {
        await provider.refreshModels!({
          ...(context.credential === undefined ? {} : { credential: context.credential as Credential }),
          store: {
            async read() {
              const stored = await context.store.read();
              return stored === undefined
                ? undefined
                : { ...stored, models: stored.models.map((model) => registry.present(model)) };
            },
            async write(entry) {
              await context.store.write({ ...entry, models: entry.models.map((model) => registry.resolve(model)) });
            },
            delete: () => context.store.delete(),
          },
          allowNetwork: context.allowNetwork,
          ...(context.force === undefined ? {} : { force: context.force }),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
        models = provider.getModels().map((model) => registry.resolve(model));
      },
    }),
    ...(provider.filterModels === undefined ? {} : {
      filterModels(entries, credential) {
        const selected = provider.filterModels!(
          entries.map((model) => registry.present(model)),
          credential as Credential | undefined,
        );
        return selected.map((model) => registry.resolve(model));
      },
    }),
    stream(model, context, options = {}) {
      const publicModel = registry.find(model.provider, model.id) ?? (() => { throw new Error(`Unknown model: ${model.provider}/${model.id}`); })();
      return adapterEventsFromPublicStream(provider.stream(publicModel, publicContextFromInternal(context, publicModel), publicOptionsFromInternal(options)), model.api);
    },
    streamSimple(model, context, options = {}) {
      const publicModel = registry.find(model.provider, model.id) ?? (() => { throw new Error(`Unknown model: ${model.provider}/${model.id}`); })();
      return adapterEventsFromPublicStream(provider.streamSimple(publicModel, publicContextFromInternal(context, publicModel), publicOptionsFromInternal(options)), model.api);
    },
  };
}

function internalProviderConfigFromExtension(
  providerName: string,
  config: ExtensionProviderConfig,
  registry: ExtensionModelRegistry,
): InternalProviderConfig {
  return {
    ...(config.name === undefined ? {} : { name: config.name }),
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    ...(config.api === undefined ? {} : { api: protocolFromPublicApi(config.api) }),
    ...(config.headers === undefined ? {} : { headers: { ...config.headers } }),
    ...(config.authHeader === undefined ? {} : { authHeader: config.authHeader }),
    ...(config.models === undefined ? {} : { models: config.models.map(internalProviderConfigModel) }),
    ...(config.streamSimple === undefined ? {} : {
      streamSimple(model, context, options = {}) {
        const publicModel = registry.find(model.provider, model.id) ?? (() => { throw new Error(`Unknown model: ${model.provider}/${model.id}`); })();
        return adapterEventsFromPublicStream(config.streamSimple!(publicModel, publicContextFromInternal(context, publicModel), publicOptionsFromInternal(options)), model.api);
      },
    }),
    ...(config.oauth === undefined ? {} : {
      oauth: {
        name: config.oauth.name,
        async login(input) {
          return await config.oauth!.login({
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            onAuth: input.onAuth,
            onDeviceCode: input.onDeviceCode,
            onPrompt: input.onPrompt,
            onProgress: input.onProgress,
            onManualCodeInput: input.onManualCodeInput,
            async onSelect(prompt) { return await input.onSelect(prompt); },
          });
        },
        refreshToken: (credential) => config.oauth!.refreshToken(credential),
        getApiKey: (credential) => config.oauth!.getApiKey(credential),
        ...(config.oauth.modifyModels === undefined ? {} : {
          modifyModels(models, credential) {
            return config.oauth!.modifyModels!(
              models.map((model) => registry.find(model.provider, model.id) ?? (() => { throw new Error(`Unknown model: ${model.provider}/${model.id}`); })()),
              credential,
            ).map((model) => registry.resolve(model));
          },
        }),
      },
    }),
    ...(config.refreshModels === undefined ? {} : {
      async refreshModels(context: ProviderRefreshContext) {
        const models = await config.refreshModels!({
          ...(context.credential === undefined ? {} : { credential: context.credential as Credential }),
          store: {
            async read() {
              const stored = await context.store.read();
              return stored === undefined ? undefined : {
                ...stored,
                models: stored.models.map((model) => {
                  const exposed = registry.present(model);
                  const selected = config.api === undefined || model.api !== "extension-stream"
                    ? exposed
                    : { ...exposed, api: config.api };
                  registry.resolve(selected);
                  return selected;
                }),
              };
            },
            async write(entry) {
              await context.store.write({ ...entry, models: entry.models.map((model) => registry.resolve(model)) });
            },
            delete: () => context.store.delete(),
          },
          allowNetwork: context.allowNetwork,
          ...(context.force === undefined ? {} : { force: context.force }),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
        rememberConfigModels(registry, providerName, config, models);
        return models.map(internalProviderConfigModel);
      },
    }),
  };
}

export type ExtensionThinkingLevel = ThinkingLevel;
