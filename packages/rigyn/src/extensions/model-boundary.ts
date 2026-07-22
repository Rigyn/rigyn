import type { StreamFn, ThinkingLevel } from "@rigyn/kernel";
import { createAssistantMessageEventStream } from "@rigyn/models";
import { Type } from "typebox";
import type {
  Api,
  AssistantMessage,
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
  ThinkingBudgets,
  Usage,
} from "@rigyn/models";

import { isJsonValue, toJsonValue } from "../core/json.js";
import { createId } from "../core/ids.js";
import {
  assistantDiagnosticsFromProviderResponse,
  canonicalAssistantDiagnostics,
} from "../core/assistant-diagnostics.js";
import {
  assistantContentFromProviderState,
  canonicalAssistantContent,
  publicAssistantContent,
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
  ToolDefinition,
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
  ProviderRefreshContext,
  ProviderStreamContext,
  ProviderStreamOptions,
} from "../providers/models.js";

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
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: Model<Api>["compat"];
}

export interface ExtensionOAuthConfig {
  name: string;
  usesCallbackServer?: boolean;
  login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
  refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
  getApiKey(credentials: OAuthCredentials): string;
  modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
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
  ["gateway-messages", "gateway-messages"],
  ["gemini-generate-content", "gemini-generate-content"],
  ["google-generative-ai", "gemini-generate-content"],
  ["google-vertex", "gemini-generate-content"],
  ["gemini-interactions", "gemini-interactions"],
  ["mistral-conversations", "mistral-conversations"],
  ["ollama-chat", "ollama-chat"],
  ["openai-codex-responses", "openai-responses"],
  ["openai-chat-completions", "openai-chat-completions"],
  ["openai-completions", "openai-chat-completions"],
  ["openai-responses", "openai-responses"],
  ["rigyn-messages", "gateway-messages"],
]);

const INTERNAL_TO_PUBLIC_API: Record<ModelProtocolFamily, Api> = {
  "anthropic-messages": "anthropic-messages",
  "bedrock-converse": "bedrock-converse-stream",
  "gateway-messages": "rigyn-messages",
  "gemini-generate-content": "google-generative-ai",
  "gemini-interactions": "gemini-interactions",
  "mistral-conversations": "mistral-conversations",
  "ollama-chat": "openai-completions",
  "openai-chat-completions": "openai-completions",
  "openai-responses": "openai-responses",
};

/** Translate a public provider API into the protocol used by the core run loop. */
export function protocolFromPublicApi(api: Api): ModelProtocolFamily {
  return PUBLIC_TO_INTERNAL_API.get(api) ?? "gateway-messages";
}

/** Translate a core protocol into its canonical public provider API. */
export function publicApiFromProtocol(protocol: ModelProtocolFamily): Api {
  return INTERNAL_TO_PUBLIC_API[protocol];
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
    ...(compatibility.maxTokensField === undefined ? {} : { maxTokensField: compatibility.maxTokensField }),
    ...(compatibility.requiresToolResultName === undefined ? {} : { requiresToolResultName: compatibility.requiresToolResultName }),
    ...(compatibility.requiresAssistantAfterToolResult === undefined ? {} : { requiresAssistantAfterToolResult: compatibility.requiresAssistantAfterToolResult }),
    ...(compatibility.requiresThinkingAsText === undefined ? {} : { requiresThinkingAsText: compatibility.requiresThinkingAsText }),
    ...(compatibility.requiresReasoningContentOnAssistantMessages === undefined ? {} : { requiresReasoningContentOnAssistantMessages: compatibility.requiresReasoningContentOnAssistantMessages }),
    ...(compatibility.supportsReasoningEffort === undefined ? {} : { supportsReasoningEffort: compatibility.supportsReasoningEffort }),
    ...(compatibility.reasoningFormat === undefined ? {} : { reasoningFormat: compatibility.reasoningFormat }),
    ...(compatibility.chatTemplateParameters === undefined ? {} : { chatTemplateKwargs: compatibility.chatTemplateParameters }),
    ...(compatibility.zaiToolStream === undefined ? {} : { zaiToolStream: compatibility.zaiToolStream }),
    ...(compatibility.deferredToolsMode === undefined ? {} : { deferredToolsMode: compatibility.deferredToolsMode }),
    ...(compatibility.supportsToolSearch === undefined ? {} : { supportsToolSearch: compatibility.supportsToolSearch }),
    ...(compatibility.cacheControlFormat === undefined ? {} : { cacheControlFormat: compatibility.cacheControlFormat }),
    ...(compatibility.supportsLongCacheRetention === undefined ? {} : { supportsLongCacheRetention: compatibility.supportsLongCacheRetention }),
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
  if (selected.maxTokensField === "max_completion_tokens" || selected.maxTokensField === "max_tokens") result.maxTokensField = selected.maxTokensField;
  if (typeof selected.requiresToolResultName === "boolean") result.requiresToolResultName = selected.requiresToolResultName;
  if (typeof selected.requiresAssistantAfterToolResult === "boolean") result.requiresAssistantAfterToolResult = selected.requiresAssistantAfterToolResult;
  if (typeof selected.requiresThinkingAsText === "boolean") result.requiresThinkingAsText = selected.requiresThinkingAsText;
  if (typeof selected.requiresReasoningContentOnAssistantMessages === "boolean") result.requiresReasoningContentOnAssistantMessages = selected.requiresReasoningContentOnAssistantMessages;
  if (typeof selected.supportsReasoningEffort === "boolean") result.supportsReasoningEffort = selected.supportsReasoningEffort;
  const reasoningFormat = selected.reasoningFormat ?? selected.thinkingFormat;
  if (typeof reasoningFormat === "string") result.reasoningFormat = reasoningFormat as NonNullable<ModelRequestCompatibility["reasoningFormat"]>;
  if (selected.chatTemplateKwargs !== undefined && isJsonValue(selected.chatTemplateKwargs)) {
    result.chatTemplateParameters = selected.chatTemplateKwargs as NonNullable<ModelRequestCompatibility["chatTemplateParameters"]>;
  }
  if (selected.cacheControlFormat === "anthropic") result.cacheControlFormat = "anthropic";
  if (typeof selected.zaiToolStream === "boolean") result.zaiToolStream = selected.zaiToolStream;
  if (selected.deferredToolsMode === "kimi") result.deferredToolsMode = "kimi";
  if (typeof selected.supportsToolSearch === "boolean") result.supportsToolSearch = selected.supportsToolSearch;
  if (typeof selected.supportsLongCacheRetention === "boolean") result.supportsLongCacheRetention = selected.supportsLongCacheRetention;
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
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    ...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1hTokens: usage.cacheWrite1h }),
    ...(usage.reasoning === undefined ? {} : { reasoningTokens: usage.reasoning }),
    cost: { ...usage.cost },
  };
}

function publicUsageFromNormalized(usage: NormalizedUsage | undefined): Usage {
  return {
    input: usage?.inputTokens ?? 0,
    output: usage?.outputTokens ?? 0,
    cacheRead: usage?.cacheReadTokens ?? 0,
    cacheWrite: usage?.cacheWriteTokens ?? 0,
    ...(usage?.cacheWrite1hTokens === undefined ? {} : { cacheWrite1h: usage.cacheWrite1hTokens }),
    ...(usage?.reasoningTokens === undefined ? {} : { reasoning: usage.reasoningTokens }),
    totalTokens: usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
    cost: usage?.cost === undefined
      ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      : { ...usage.cost },
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
    ...(options.maxOutputTokens === undefined ? {} : { maxTokens: options.maxOutputTokens }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.cacheRetention === undefined ? {} : { cacheRetention: options.cacheRetention }),
    ...(options.thinkingBudgets === undefined ? {} : { thinkingBudgets: options.thinkingBudgets }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    ...(options.transport === undefined ? {} : { transport: options.transport }),
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
    case "gateway_messages": return "gateway-messages";
    case "bedrock_converse": return "bedrock-converse";
    case "mistral_chat": return "mistral-conversations";
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
    case "mistral-conversations": return {
      kind: "mistral_chat",
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
    case "gateway-messages": return {
      kind: "gateway_messages",
      assistantContent,
      ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
      source,
    };
  };
}

async function* adapterEventsFromPublicStream(
  stream: AssistantMessageEventStream,
  api: ModelProtocolFamily,
): AsyncIterable<AdapterEvent> {
  let terminal = false;
  let started = false;
  const text = new Map<number, string>();
  const reasoning = new Map<number, string>();
  const startedText = new Set<number>();
  const startedReasoning = new Set<number>();
  const completedText = new Set<number>();
  const completedReasoning = new Set<number>();
  const completedTools = new Set<number>();
  for await (const event of stream) {
    const normalized = event as unknown as AdapterEvent;
    const isNormalized = normalized.type === "response_start"
      || normalized.type === "response_end"
      || normalized.type === "usage"
      || normalized.type === "text_start"
      || normalized.type === "text_end"
      || normalized.type === "reasoning_start"
      || normalized.type === "reasoning_end"
      || normalized.type === "reasoning_delta"
      || normalized.type === "tool_call_start"
      || normalized.type === "tool_call_delta"
      || normalized.type === "tool_call_end"
      || (normalized.type === "text_delta" && "text" in normalized)
      || (normalized.type === "error" && typeof normalized.error === "object" && normalized.error !== null && "category" in normalized.error);
    if (isNormalized) {
      yield normalized;
      if (normalized.type === "response_start") started = true;
      if (normalized.type === "response_end" || normalized.type === "error") terminal = true;
    } else if (event.type === "start") {
      started = true;
      yield {
        type: "response_start",
        model: event.partial.responseModel ?? event.partial.model,
        ...(event.partial.responseId === undefined ? {} : { responseId: event.partial.responseId }),
      };
    } else if (event.type === "text_start") {
      startedText.add(event.contentIndex);
      yield { type: "text_start", part: event.contentIndex };
    } else if (event.type === "text_delta") {
      if (!startedText.has(event.contentIndex)) {
        startedText.add(event.contentIndex);
        yield { type: "text_start", part: event.contentIndex };
      }
      text.set(event.contentIndex, `${text.get(event.contentIndex) ?? ""}${event.delta}`);
      yield { type: "text_delta", part: event.contentIndex, text: event.delta };
    } else if (event.type === "text_end") {
      if (!startedText.has(event.contentIndex)) {
        startedText.add(event.contentIndex);
        yield { type: "text_start", part: event.contentIndex };
      }
      const emitted = text.get(event.contentIndex) ?? "";
      if (!event.content.startsWith(emitted)) throw new Error("Provider final text did not match its streamed prefix");
      const suffix = event.content.slice(emitted.length);
      if (suffix !== "") yield { type: "text_delta", part: event.contentIndex, text: suffix };
      text.set(event.contentIndex, event.content);
      completedText.add(event.contentIndex);
      yield {
        type: "text_end",
        part: event.contentIndex,
        text: event.content,
        ...(event.contentSignature === undefined ? {} : { textSignature: event.contentSignature }),
      };
    } else if (event.type === "thinking_start") {
      startedReasoning.add(event.contentIndex);
      yield { type: "reasoning_start", part: event.contentIndex, visibility: "provider_trace" };
    } else if (event.type === "thinking_delta") {
      if (!startedReasoning.has(event.contentIndex)) {
        startedReasoning.add(event.contentIndex);
        yield { type: "reasoning_start", part: event.contentIndex, visibility: "provider_trace" };
      }
      reasoning.set(event.contentIndex, `${reasoning.get(event.contentIndex) ?? ""}${event.delta}`);
      yield { type: "reasoning_delta", part: event.contentIndex, text: event.delta, visibility: "provider_trace" };
    } else if (event.type === "thinking_end") {
      if (!startedReasoning.has(event.contentIndex)) {
        startedReasoning.add(event.contentIndex);
        yield { type: "reasoning_start", part: event.contentIndex, visibility: "provider_trace" };
      }
      const emitted = reasoning.get(event.contentIndex) ?? "";
      if (!event.content.startsWith(emitted)) throw new Error("Provider final thinking did not match its streamed prefix");
      const suffix = event.content.slice(emitted.length);
      if (suffix !== "") {
        yield { type: "reasoning_delta", part: event.contentIndex, text: suffix, visibility: "provider_trace" };
      }
      reasoning.set(event.contentIndex, event.content);
      completedReasoning.add(event.contentIndex);
      yield {
        type: "reasoning_end",
        part: event.contentIndex,
        text: event.content,
        visibility: "provider_trace",
        ...(event.contentSignature === undefined ? {} : { thinkingSignature: event.contentSignature }),
        ...(event.redacted === undefined ? {} : { redacted: event.redacted }),
      };
    } else if (event.type === "toolcall_start") {
      const block = event.partial.content[event.contentIndex];
      yield {
        type: "tool_call_start",
        index: event.contentIndex,
        ...(block?.type !== "toolCall" ? {} : { id: block.id, name: block.name }),
      };
    } else if (event.type === "toolcall_delta") {
      yield { type: "tool_call_delta", index: event.contentIndex, jsonFragment: event.delta };
    } else if (event.type === "toolcall_end") {
      completedTools.add(event.contentIndex);
      yield {
        type: "tool_call_end",
        index: event.contentIndex,
        id: event.toolCall.id,
        name: event.toolCall.name,
        arguments: isJsonValue(event.toolCall.arguments) && !Array.isArray(event.toolCall.arguments) && event.toolCall.arguments !== null
          ? event.toolCall.arguments
          : {},
        rawArguments: JSON.stringify(event.toolCall.arguments),
        ...(event.toolCall.thoughtSignature === undefined ? {} : { thoughtSignature: event.toolCall.thoughtSignature }),
      };
    } else if (event.type === "done") {
      terminal = true;
      if (!started) {
        yield {
          type: "response_start",
          model: event.message.responseModel ?? event.message.model,
          ...(event.message.responseId === undefined ? {} : { responseId: event.message.responseId }),
        };
      }
      for (const [index, block] of event.message.content.entries()) {
        if (block.type === "text") {
          const emitted = text.get(index) ?? "";
          if (!block.text.startsWith(emitted)) throw new Error("Provider terminal text did not match its streamed prefix");
          if (!startedText.has(index)) {
            startedText.add(index);
            yield { type: "text_start", part: index };
          }
          if (block.text.length > emitted.length) {
            yield { type: "text_delta", part: index, text: block.text.slice(emitted.length) };
          }
          if (!completedText.has(index)) {
            yield {
              type: "text_end",
              part: index,
              text: block.text,
              ...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }),
            };
          }
        } else if (block.type === "thinking") {
          const emitted = reasoning.get(index) ?? "";
          if (!block.thinking.startsWith(emitted)) throw new Error("Provider terminal thinking did not match its streamed prefix");
          if (!startedReasoning.has(index)) {
            startedReasoning.add(index);
            yield { type: "reasoning_start", part: index, visibility: "provider_trace" };
          }
          if (block.thinking.length > emitted.length) {
            yield { type: "reasoning_delta", part: index, text: block.thinking.slice(emitted.length), visibility: "provider_trace" };
          }
          if (!completedReasoning.has(index)) {
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
          const argumentsValue = toJsonValue(block.arguments);
          yield { type: "tool_call_start", index, id: block.id, name: block.name };
          yield {
            type: "tool_call_end",
            index,
            id: block.id,
            name: block.name,
            arguments: argumentsValue !== null && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)
              ? argumentsValue
              : {},
            rawArguments: JSON.stringify(block.arguments),
            ...(block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature }),
          };
        }
      }
      yield { type: "usage", usage: normalizedUsageFromPublic(event.message.usage), semantics: "final" };
      yield {
        type: "response_end",
        reason: internalFinishReason(event.message.stopReason),
        state: stateFromAssistant(event.message, api),
        content: canonicalAssistantContent(event.message.content),
        ...(() => {
          const diagnostics = canonicalAssistantDiagnostics(event.message.diagnostics);
          return diagnostics === undefined ? {} : { assistantDiagnostics: diagnostics };
        })(),
      };
    } else if (event.type === "error") {
      terminal = true;
      yield { type: "usage", usage: normalizedUsageFromPublic(event.error.usage), semantics: "final" };
      yield {
        type: "error",
        error: {
          category: event.reason === "aborted" ? "cancelled" : "provider",
          message: event.error.errorMessage ?? "Provider stream failed",
          retryable: false,
          partial: event.error.content.length > 0,
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
    ...(request.thinkingBudgets === undefined ? {} : { thinkingBudgets: request.thinkingBudgets }),
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
    ...(request.transport === undefined ? {} : { transport: request.transport }),
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
  "gateway_messages",
  "gemini_generate_content",
  "gemini_interactions",
  "mistral_chat",
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
    case "gateway_messages":
      return Array.isArray(value.assistantContent) && (value.responseId === undefined || typeof value.responseId === "string");
    case "bedrock_converse":
    case "mistral_chat":
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
              kind: "gateway_messages",
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
  const tools: ToolDefinition[] | undefined = context.tools?.map((tool) => {
    if (!isJsonValue(tool.parameters) || tool.parameters === null || Array.isArray(tool.parameters) || typeof tool.parameters !== "object") {
      throw new TypeError(`Tool ${tool.name} parameters must be a JSON object`);
    }
    return { name: tool.name, description: tool.description, inputSchema: tool.parameters };
  });
  return {
    messages,
    ...(tools === undefined ? {} : { tools }),
    ...(providerState === undefined ? {} : { providerState }),
  };
}

function internalOptionsFromPublic(
  options: (StreamOptions & { reasoning?: ThinkingLevel; thinkingBudgets?: ThinkingBudgets }) | undefined,
): ProviderStreamOptions {
  const metadata = options?.metadata === undefined
    ? undefined
    : Object.fromEntries(Object.entries(options.metadata).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return {
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
    ...(options?.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options?.headers === undefined ? {} : { headers: options.headers }),
    ...(options?.env === undefined ? {} : { env: options.env }),
    ...(options?.maxTokens === undefined ? {} : { maxOutputTokens: options.maxTokens }),
    ...(options?.reasoning === undefined ? {} : { reasoningEffort: options.reasoning }),
    ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options?.cacheRetention === undefined ? {} : { cacheRetention: options.cacheRetention }),
    ...(options?.thinkingBudgets === undefined ? {} : { thinkingBudgets: options.thinkingBudgets }),
    ...(options?.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(options?.transport === undefined ? {} : { transport: options.transport }),
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
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const textIndexes = new Map<number, number>();
    const thinkingIndexes = new Map<number, number>();
    const toolIndexes = new Map<number, number>();
    const toolFragments = new Map<number, string>();
    const endedText = new Set<number>();
    const endedThinking = new Set<number>();
    let started = false;
    let terminal = false;
    const snapshot = () => structuredClone(message);
    const start = () => {
      if (started) return;
      started = true;
      output.push({ type: "start", partial: snapshot() });
    };
    try {
      for await (const event of events) {
        signal?.throwIfAborted();
        if (event.type === "response_start") {
          message.responseModel = event.model;
          if (event.responseId !== undefined) message.responseId = event.responseId;
          const diagnostics = assistantDiagnosticsFromProviderResponse(event.diagnostics);
          if (diagnostics !== undefined) message.diagnostics = diagnostics;
          start();
        } else if (event.type === "text_start") {
          start();
          if (!textIndexes.has(event.part)) {
            const index = message.content.length;
            textIndexes.set(event.part, index);
            message.content.push({ type: "text", text: "" });
            output.push({ type: "text_start", contentIndex: index, partial: snapshot() });
          }
        } else if (event.type === "text_delta") {
          start();
          let index = textIndexes.get(event.part);
          if (index === undefined) {
            index = message.content.length;
            textIndexes.set(event.part, index);
            message.content.push({ type: "text", text: "" });
            output.push({ type: "text_start", contentIndex: index, partial: snapshot() });
          }
          const block = message.content[index];
          if (block?.type !== "text") throw new Error("Provider text stream index changed type");
          block.text += event.text;
          output.push({ type: "text_delta", contentIndex: index, delta: event.text, partial: snapshot() });
        } else if (event.type === "text_end") {
          start();
          let index = textIndexes.get(event.part);
          if (index === undefined) {
            index = message.content.length;
            textIndexes.set(event.part, index);
            message.content.push({ type: "text", text: "" });
            output.push({ type: "text_start", contentIndex: index, partial: snapshot() });
          }
          const block = message.content[index];
          if (block?.type !== "text") throw new Error("Provider text stream index changed type");
          block.text = event.text;
          if (event.textSignature !== undefined) block.textSignature = event.textSignature;
          endedText.add(event.part);
          output.push({
            type: "text_end",
            contentIndex: index,
            content: block.text,
            ...(block.textSignature === undefined ? {} : { contentSignature: block.textSignature }),
            partial: snapshot(),
          });
        } else if (event.type === "reasoning_start") {
          start();
          if (!thinkingIndexes.has(event.part)) {
            const index = message.content.length;
            thinkingIndexes.set(event.part, index);
            message.content.push({ type: "thinking", thinking: "" });
            output.push({ type: "thinking_start", contentIndex: index, partial: snapshot() });
          }
        } else if (event.type === "reasoning_delta") {
          start();
          let index = thinkingIndexes.get(event.part);
          if (index === undefined) {
            index = message.content.length;
            thinkingIndexes.set(event.part, index);
            message.content.push({ type: "thinking", thinking: "" });
            output.push({ type: "thinking_start", contentIndex: index, partial: snapshot() });
          }
          const block = message.content[index];
          if (block?.type !== "thinking") throw new Error("Provider reasoning stream index changed type");
          block.thinking += event.text;
          output.push({ type: "thinking_delta", contentIndex: index, delta: event.text, partial: snapshot() });
        } else if (event.type === "reasoning_end") {
          start();
          let index = thinkingIndexes.get(event.part);
          if (index === undefined) {
            index = message.content.length;
            thinkingIndexes.set(event.part, index);
            message.content.push({ type: "thinking", thinking: "" });
            output.push({ type: "thinking_start", contentIndex: index, partial: snapshot() });
          }
          const block = message.content[index];
          if (block?.type !== "thinking") throw new Error("Provider reasoning stream index changed type");
          block.thinking = event.text;
          if (event.thinkingSignature !== undefined) block.thinkingSignature = event.thinkingSignature;
          if (event.redacted !== undefined) block.redacted = event.redacted;
          endedThinking.add(event.part);
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
          const index = message.content.length;
          toolIndexes.set(event.index, index);
          toolFragments.set(event.index, "");
          message.content.push({ type: "toolCall", id: event.id ?? createId("tool"), name: event.name ?? "", arguments: {} });
          output.push({ type: "toolcall_start", contentIndex: index, partial: snapshot() });
        } else if (event.type === "tool_call_delta") {
          start();
          const index = toolIndexes.get(event.index);
          if (index === undefined) throw new Error("Provider tool-call delta arrived before start");
          toolFragments.set(event.index, `${toolFragments.get(event.index) ?? ""}${event.jsonFragment}`);
          output.push({ type: "toolcall_delta", contentIndex: index, delta: event.jsonFragment, partial: snapshot() });
        } else if (event.type === "tool_call_end") {
          start();
          const index = toolIndexes.get(event.index) ?? message.content.length;
          let block = message.content[index];
          if (block?.type !== "toolCall") {
            block = { type: "toolCall", id: event.id ?? createId("tool"), name: event.name, arguments: {} };
            message.content[index] = block;
          }
          block.id = event.id ?? block.id;
          block.name = event.name;
          block.arguments = event.arguments !== undefined && !Array.isArray(event.arguments) && event.arguments !== null && typeof event.arguments === "object"
            ? event.arguments
            : {};
          if (event.thoughtSignature !== undefined) block.thoughtSignature = event.thoughtSignature;
          output.push({ type: "toolcall_end", contentIndex: index, toolCall: structuredClone(block), partial: snapshot() });
        } else if (event.type === "usage") {
          message.usage = publicUsageFromNormalized(event.usage);
        } else if (event.type === "response_end") {
          start();
          if (event.assistantDiagnostics !== undefined) {
            message.diagnostics = canonicalAssistantDiagnostics(event.assistantDiagnostics)!;
          }
          const terminalContent = event.content ?? assistantContentFromProviderState(event.state);
          if (terminalContent !== undefined) {
            const startedTextParts = new Set(textIndexes.keys());
            const startedThinkingParts = new Set(thinkingIndexes.keys());
            message.content = publicAssistantContent(terminalContent);
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
            if (endedText.has(part)) continue;
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
            if (endedThinking.has(part)) continue;
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
          message.providerState = {
            source: { api: model.api, provider: model.provider, model: model.id },
            value: toJsonValue(event.state),
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
      message.errorMessage = error instanceof Error ? error.message : String(error);
      output.push({ type: "error", reason: message.stopReason, error: snapshot() });
    }
  })());
  return output;
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
    ...(auth.oauth === undefined ? {} : {
      oauth: {
        name: auth.oauth.name,
        ...(auth.oauth.loginLabel === undefined ? {} : { loginLabel: auth.oauth.loginLabel }),
        login: (interaction) => auth.oauth!.login(interaction),
        refresh: (credential, signal) => auth.oauth!.refresh(credential, signal),
        toAuth: (credential) => auth.oauth!.toAuth(credential),
      },
    }),
  };
}

function publicAuthFromInternal(auth: InternalProviderAuth): ExtensionProvider["auth"] {
  return {
    ...(auth.apiKey === undefined ? {} : {
      apiKey: {
        name: auth.apiKey.name,
        ...(auth.apiKey.login === undefined ? {} : { login: (interaction) => auth.apiKey!.login!(interaction) }),
        ...(auth.apiKey.check === undefined ? {} : { check: (input) => auth.apiKey!.check!(input) }),
        resolve: (input) => auth.apiKey!.resolve(input),
      },
    }),
    ...(auth.oauth === undefined ? {} : {
      oauth: {
        name: auth.oauth.name,
        ...(auth.oauth.loginLabel === undefined ? {} : { loginLabel: auth.oauth.loginLabel }),
        login: (interaction) => auth.oauth!.login(interaction),
        refresh: (credential, signal) => auth.oauth!.refresh(credential, signal),
        toAuth: (credential) => auth.oauth!.toAuth(credential),
      },
    }),
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
    maxTokens: model.maxTokens,
    ...(model.headers === undefined ? {} : { headers: { ...model.headers } }),
    ...(() => {
      const compat = compatibilityFromInternal(model.compat);
      return compat === undefined ? {} : { compat };
    })(),
  };
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
    if (config === undefined) throw new Error("Provider config is required when registering by name");
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
                  const selected = config.api === undefined || model.api !== "gateway-messages"
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
