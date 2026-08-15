import { createHash } from "node:crypto";

import type { JsonValue } from "../core/json.js";
import type {
  AdapterEvent,
  FinishReason,
  ImageBlock,
  ModelCapability,
  ModelRequestCompatibility,
  ModelModality,
  ModelInfo,
  NormalizedUsage,
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  ProviderResponseDiagnostics,
  ProviderState,
  ModelProtocolFamily,
} from "../core/types.js";
import { catalogId, catalogLimit } from "./catalog.js";
import { normalizeImageSource, requireImageUrlProtocol } from "./images.js";
import { stringifyProviderJson } from "./json.js";
import {
  assertCurrentProviderReasoningEffort,
  assertOpenAIReasoningEffort,
  providerWireRequest,
} from "./messages.js";
import { streamOpenAIChatWithSdk } from "./openai-chat-sdk-transport.js";
import { toolResultText } from "./tool-results.js";
import { normalizeUsage } from "./usage.js";
import { parseJsonWithRepair } from "./streaming-json.js";
import {
  appendGrammarInputDelta,
  providerGrammarInput,
  providerGrammarProperties,
  providerGrammarTool,
  providerStrictTool,
  type GrammarInputBuffer,
} from "./constrained-sampling.js";
import {
  baseModelCompatibility,
  mergeModelCompatibility,
  modelEvidence,
  openRouterPricing,
  providerModalities,
  providerReasoningEfforts,
  vercelGatewayPricing,
} from "./model-metadata.js";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  assertResponseOk,
  assertSecureEndpoint,
  type FetchLike,
  jsonValueOrString,
  normalizeError,
  ProtocolError,
  ProviderStreamError,
  readJsonResponse,
  resolveToken,
  type TokenSource,
} from "./transport.js";

export interface OpenAICompatibleConfig {
  id?: ProviderId;
  baseUrl: string;
  apiKey?: TokenSource;
  accessToken?: TokenSource;
  headers?: HeadersInit;
  includeUsage?: boolean;
  profile?: OpenAICompatibleProfile;
  fetch?: FetchLike;
}

export type OpenAICompatibleProfile =
  | "default"
  | "vercel-ai-gateway"
  | "zai"
  | "kimi-coding"
  | "minimax"
  | "qwen-token-plan"
  | "xiaomi"
  | "moonshot"
  | "opencode"
  | "cloudflare-ai-gateway";

export interface OpenRouterConfig {
  apiKey?: TokenSource;
  baseUrl?: string;
  appName?: string;
  siteUrl?: string;
  headers?: HeadersInit;
  fetch?: FetchLike;
  promptCache?: "off" | "5m" | "1h";
}

interface ChatTransportConfig {
  id: ProviderId;
  baseUrl: string;
  token: TokenSource | undefined;
  headers: HeadersInit | undefined;
  includeUsage: boolean;
  profile: OpenAICompatibleProfile;
  openRouter: boolean;
  promptCache: "off" | "5m" | "1h";
  protocolFamily: ModelProtocolFamily;
  fetch: FetchLike;
}

interface ToolAccumulator {
  index: number;
  id?: string;
  name: string;
  arguments: string;
  grammar?: { property: string; input: GrammarInputBuffer };
  ended: boolean;
}

type ChatProviderState = Extract<
  ProviderState,
  { kind: "chat_completions" | "openrouter_chat" }
>;

const MAX_STREAM_TOOL_CALLS = 1_024;

function streamToolIndex(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= MAX_STREAM_TOOL_CALLS) {
    throw new ProtocolError(`Chat tool index must be an integer from 0 to ${MAX_STREAM_TOOL_CALLS - 1}`);
  }
  return value as number;
}

function streamToolId(value: unknown): string | undefined {
  const id = asString(value);
  return id === undefined || id === "" ? undefined : id;
}

function toolWithId(tools: ReadonlyMap<number, ToolAccumulator>, id: string): ToolAccumulator | undefined {
  for (const tool of tools.values()) {
    if (tool.id === id) return tool;
  }
  return undefined;
}

function nextToolIndex(tools: ReadonlyMap<number, ToolAccumulator>): number {
  for (let index = 0; index < MAX_STREAM_TOOL_CALLS; index += 1) {
    if (!tools.has(index)) return index;
  }
  throw new ProtocolError(`Chat completion exceeded ${MAX_STREAM_TOOL_CALLS} tool calls`);
}

function resolveStreamTool(
  tools: Map<number, ToolAccumulator>,
  call: Record<string, unknown>,
  position: number,
  callsInChunk: number,
  activeBeforeChunk: readonly ToolAccumulator[],
): { tool: ToolAccumulator; created: boolean } {
  const index = streamToolIndex(call.index);
  const id = streamToolId(call.id);
  if (index !== undefined) {
    const existing = tools.get(index);
    if (existing !== undefined) {
      // Several compatible providers mutate the streamed ID on later chunks.
      // The first usable ID is the one correlated with the emitted start event.
      if (existing.id === undefined && id !== undefined) {
        const match = toolWithId(tools, id);
        if (match !== undefined && match !== existing) throw new ProtocolError("Chat tool ID refers to multiple indexes");
        existing.id = id;
      }
      return { tool: existing, created: false };
    }
    if (id !== undefined && toolWithId(tools, id) !== undefined) {
      throw new ProtocolError("Chat tool ID changed indexes during streaming");
    }
    const tool: ToolAccumulator = { index, name: "", arguments: "", ended: false };
    if (id !== undefined) tool.id = id;
    tools.set(index, tool);
    return { tool, created: true };
  }
  if (id !== undefined) {
    const existing = toolWithId(tools, id);
    if (existing !== undefined) return { tool: existing, created: false };

    const positional = callsInChunk > 1 && callsInChunk === activeBeforeChunk.length
      ? activeBeforeChunk[position]
      : undefined;
    if (positional !== undefined) {
      if (positional.id === undefined) positional.id = id;
      return { tool: positional, created: false };
    }

    const onlyActive = activeBeforeChunk.length === 1 ? activeBeforeChunk[0] : undefined;
    const functionName = asString(asRecord(call.function)?.name) ?? "";
    if (onlyActive !== undefined && (functionName === "" || onlyActive.name === "")) {
      if (onlyActive.id === undefined) onlyActive.id = id;
      return { tool: onlyActive, created: false };
    }
    if (activeBeforeChunk.length > 1 && functionName === "") {
      throw new ProtocolError("Chat tool fragment has an unknown ID and multiple active calls are ambiguous");
    }

    const allocated = nextToolIndex(tools);
    const tool: ToolAccumulator = { index: allocated, id, name: "", arguments: "", ended: false };
    tools.set(allocated, tool);
    return { tool, created: true };
  }

  if (callsInChunk > 1 && callsInChunk === activeBeforeChunk.length) {
    const positional = activeBeforeChunk[position];
    if (positional !== undefined) return { tool: positional, created: false };
  }

  const candidates = activeBeforeChunk;
  if (candidates.length === 1) return { tool: candidates[0]!, created: false };
  if (candidates.length > 1) throw new ProtocolError("Chat tool fragment has no index or ID and is ambiguous");
  const allocated = nextToolIndex(tools);
  const tool: ToolAccumulator = { index: allocated, name: "", arguments: "", ended: false };
  tools.set(allocated, tool);
  return { tool, created: true };
}

class ChatCompletionsAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  readonly #config: ChatTransportConfig;

  constructor(config: ChatTransportConfig) {
    this.id = config.id;
    this.#config = config;
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    let partial = false;
    let terminal = false;
    let requestId: string | undefined;
    let diagnostics: ProviderResponseDiagnostics | undefined;

    try {
      const headers = await this.#headers(signal);
      applySessionAffinityHeaders(headers, request, this.#config.openRouter);
      for (const [name, value] of Object.entries(request.modelSettings?.headers ?? {})) headers.set(name, value);
      if (request.cacheRetention === "none") clearSessionAffinityHeaders(headers);
      const body = buildChatBody(
        request,
        this.#config.includeUsage,
        this.#config.openRouter,
        this.#config.promptCache,
        this.#config.profile,
        this.#config.id,
      );
      const apiKey = bearerToken(headers.get("authorization"));
      const chunks = streamOpenAIChatWithSdk({
        baseUrl: this.#config.baseUrl,
        ...(apiKey === undefined ? {} : { apiKey }),
        headers,
        body,
        signal,
        fetch: this.#config.fetch,
        onResponse(value, valueRequestId) {
          diagnostics = value;
          requestId = valueRequestId;
        },
      });

      let started = false;
      let sawDone = false;
      let responseId: string | undefined;
      let responseModel = request.model;
      let finishReason: string | undefined;
      let nativeFinishReason: string | undefined;
      let content = "";
      let reasoning = "";
      let refusal = "";
      const reasoningDetails = new Map<string, Record<string, unknown>>();
      const reasoningParts = new Map<string, number>();
      const reasoningPart = (source: string, visibility: "summary" | "provider_trace"): number => {
        const key = `${visibility}:${source}`;
        const existing = reasoningParts.get(key);
        if (existing !== undefined) return existing;
        const part = reasoningParts.size;
        reasoningParts.set(key, part);
        return part;
      };
      const tools = new Map<number, ToolAccumulator>();
      const grammarProperties = providerGrammarProperties(
        request.tools,
        request.modelSettings?.compatibility?.supportsOpenAIGrammarTools === true,
      );

      for await (const parsed of chunks) {
        const chunk = asRecord(parsed);
        if (chunk === undefined) throw new ProtocolError("Chat completion chunk was not an object", jsonValueOrString(parsed));

        const chunkError = asRecord(chunk.error);
        if (chunkError !== undefined) {
          const error = chunkError ?? chunk;
          const metadata = asRecord(chunkError?.metadata);
          throw new ProviderStreamError(
            asString(error.message) ?? "Chat completion stream failed",
            asString(metadata?.error_type) ?? stringCode(error.code) ?? asString(error.type),
            jsonValueOrString(chunk),
          );
        }

        responseId = asString(chunk.id) ?? responseId;
        responseModel = asString(chunk.model) ?? responseModel;
        if (!started) {
          started = true;
          const start: Extract<AdapterEvent, { type: "response_start" }> = {
            type: "response_start",
            model: responseModel,
            ...(diagnostics === undefined ? {} : { diagnostics }),
          };
          if (responseId !== undefined) start.responseId = responseId;
          if (requestId !== undefined) start.requestId = requestId;
          yield start;
          signal.throwIfAborted();
        }

        const chunkUsage = chatUsage(chunk.usage);
        if (chunkUsage !== undefined) {
          yield { type: "usage", usage: chunkUsage, semantics: "final" };
          signal.throwIfAborted();
        }

        for (const choiceValue of asArray(chunk.choices)) {
          const choice = asRecord(choiceValue);
          if (choice === undefined) continue;
          const choiceIndex = asNumber(choice.index) ?? 0;
          if (choiceIndex !== 0) {
            yield { type: "unknown_provider_event", provider: this.id, raw: jsonValueOrString(choice) };
            continue;
          }
          if (chunkUsage === undefined) {
            const choiceUsage = chatUsage(choice.usage);
            if (choiceUsage !== undefined) yield { type: "usage", usage: choiceUsage, semantics: "final" };
          }
          const delta = asRecord(choice.delta);
          if (delta !== undefined) {
            const text = asString(delta.content) ?? "";
            if (text !== "") {
              content += text;
              partial = true;
              yield { type: "text_delta", part: 0, text };
              signal.throwIfAborted();
            }

            const refusalDelta = asString(delta.refusal) ?? "";
            if (refusalDelta !== "") {
              refusal += refusalDelta;
              partial = true;
              yield { type: "text_delta", part: 0, text: refusalDelta };
              signal.throwIfAborted();
            }

            const reasoningDelta = asString(delta.reasoning)
              ?? asString(delta.reasoning_content)
              ?? asString(delta.reasoning_text)
              ?? "";
            if (reasoningDelta !== "") {
              reasoning += reasoningDelta;
              partial = true;
              const visibility = "summary" as const;
              yield {
                type: "reasoning_delta",
                part: reasoningPart("raw", visibility),
                text: reasoningDelta,
                visibility,
              };
              signal.throwIfAborted();
            }

            for (const [detailIndex, detail] of asArray(delta.reasoning_details).entries()) {
              const record = asRecord(detail);
              const key = record === undefined ? undefined : reasoningDetailKey(record, detailIndex);
              const summary = asString(record?.summary);
              const detailText = asString(record?.text);
              let emitted = summary ?? detailText;
              if (key !== undefined && emitted !== undefined && this.#config.profile === "minimax") {
                const previous = reasoningDetails.get(key);
                const previousText = asString(previous?.[summary !== undefined ? "summary" : "text"]) ?? "";
                if (previousText !== "" && emitted.startsWith(previousText)) emitted = emitted.slice(previousText.length);
              }
              if (record !== undefined && key !== undefined) {
                mergeReasoningDetail(reasoningDetails, key, record, this.#config.profile === "minimax");
              }
              if (emitted !== undefined && emitted !== "") {
                partial = true;
                const visibility = reasoningDetailVisibility(record);
                yield {
                  type: "reasoning_delta",
                  part: reasoningPart(`detail:${key ?? detailIndex}`, visibility),
                  text: emitted,
                  visibility,
                };
                signal.throwIfAborted();
              }
            }

            const streamedCalls = asArray(delta.tool_calls)
              .map(asRecord)
              .filter((call): call is Record<string, unknown> => call !== undefined);
            const activeBeforeChunk = [...tools.values()]
              .filter((tool) => !tool.ended)
              .sort((left, right) => left.index - right.index);
            for (const [position, call] of streamedCalls.entries()) {
              const functionDelta = asRecord(call.function);
              const customDelta = asRecord(call.custom);
              const { tool, created } = resolveStreamTool(
                tools,
                call,
                position,
                streamedCalls.length,
                activeBeforeChunk,
              );
              if (created) {
                partial = true;
                const start: AdapterEvent = { type: "tool_call_start", index: tool.index };
                if (tool.id !== undefined) start.id = tool.id;
                const initialName = asString(functionDelta?.name) ?? asString(customDelta?.name);
                if (initialName !== undefined) start.name = initialName;
                yield start;
                signal.throwIfAborted();
              }
              const nameFragment = asString(functionDelta?.name) ?? asString(customDelta?.name) ?? "";
              tool.name += nameFragment;
              const property = grammarProperties.get(tool.name);
              if (!tool.grammar && property !== undefined) {
                tool.grammar = { property, input: { value: "", opened: false, closed: false } };
              }
              const fragment = asString(functionDelta?.arguments) ?? "";
              tool.arguments += fragment;
              if (fragment !== "") {
                yield { type: "tool_call_delta", index: tool.index, jsonFragment: fragment };
                signal.throwIfAborted();
              }
              const customInput = asString(customDelta?.input) ?? "";
              if (customInput !== "") {
                if (!tool.grammar) throw new ProtocolError("Custom tool input did not match a declared grammar tool", jsonValueOrString(call));
                const jsonFragment = appendGrammarInputDelta(
                  tool.grammar.input,
                  tool.grammar.property,
                  tool.grammar.input.value + customInput,
                  false,
                );
                if (jsonFragment) {
                  tool.arguments += jsonFragment;
                  yield { type: "tool_call_delta", index: tool.index, jsonFragment };
                  signal.throwIfAborted();
                }
              }
            }
          }

          const rawFinish = asString(choice.finish_reason);
          if (rawFinish !== undefined) finishReason = rawFinish;
          nativeFinishReason = asString(choice.native_finish_reason) ?? nativeFinishReason;
        }
      }
      sawDone = true;

      if (!started) throw new ProtocolError("Chat completion stream ended before any response chunk");
      if (finishReason === undefined) {
        throw new ProtocolError(
          sawDone
            ? "Chat completion emitted [DONE] without a finish reason"
            : "Chat completion stream ended before a finish reason",
        );
      }
      const mappedFinishReason = mapChatFinish(finishReason, tools.size > 0, refusal !== "");
      if (mappedFinishReason === "error") {
        throw new ProviderStreamError(`Provider finish_reason: ${finishReason}`, finishReason);
      }
      for (const tool of tools.values()) {
        if (!tool.ended) {
          if (tool.grammar && !tool.grammar.input.closed) {
            const fragment = appendGrammarInputDelta(tool.grammar.input, tool.grammar.property, tool.grammar.input.value, true);
            if (fragment) {
              tool.arguments += fragment;
              yield { type: "tool_call_delta", index: tool.index, jsonFragment: fragment };
            }
          }
          yield finishTool(tool);
        }
      }
      terminal = true;
      const end: AdapterEvent = {
        type: "response_end",
        reason: mappedFinishReason,
        state: chatState(
          this.id,
          content,
          reasoning,
          refusal,
          [...reasoningDetails.values()].map(jsonValueOrString),
          tools,
          this.#config.profile,
        ),
        rawReason: nativeFinishReason ?? finishReason,
      };
      yield end;
    } catch (error) {
      if (!terminal) {
        terminal = true;
        yield { type: "error", error: normalizeError(this.id, error, { partial, signal, requestId, diagnostics }) };
      }
    }
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    const headers = await this.#headers(signal);
    headers.set("accept", "application/json");
    const response = await this.#config.fetch(`${this.#config.baseUrl}/models`, { headers, signal, redirect: "error" });
    await assertResponseOk(response);
    const body = await readJsonResponse(response);
    const observedAt = new Date().toISOString();
    return asArray(asRecord(body)?.data).flatMap((entry): ModelInfo[] => {
      const model = asRecord(entry);
      const id = catalogId(model?.id);
      if (id === undefined) return [];
      if (this.id === "nvidia" && !nvidiaChatModel(model, id)) return [];
      const xiaomiModel = this.#config.profile === "xiaomi" ? documentedXiaomiChatModel(id) : undefined;
      if (this.#config.profile === "xiaomi" && xiaomiModel === undefined) return [];
      if (this.#config.profile === "vercel-ai-gateway") {
        const type = asString(model?.type);
        if (type !== "language") return [];
      }
      const architecture = asRecord(model?.architecture);
      const vercelModalities = asRecord(model?.modalities);
      const inputModalities = this.#config.profile === "vercel-ai-gateway"
        ? vercelModalities?.input
        : architecture?.input_modalities;
      const outputModalities = asArray(
        this.#config.profile === "vercel-ai-gateway" ? vercelModalities?.output : architecture?.output_modalities,
      )
        .filter((value): value is string => typeof value === "string");
      if (outputModalities.length > 0 && !outputModalities.includes("text")) return [];
      const capabilities = xiaomiModel === undefined
        ? modelCapabilities(model, observedAt, this.#config.profile)
        : {
            tools: documentedCapability(true, observedAt),
            reasoning: documentedCapability(true, observedAt),
            images: documentedCapability(xiaomiModel.images, observedAt),
          };
      const compatibility = baseModelCompatibility(this.#config.protocolFamily, capabilities.tools, observedAt);
      const inputModalityEvidence = providerModalities(inputModalities, observedAt);
      const outputModalityEvidence = providerModalities(outputModalities, observedAt);
      const reasoningEfforts = this.#config.openRouter
        ? openRouterReasoningEfforts(model, observedAt)
        : this.#config.profile === "vercel-ai-gateway"
          ? vercelGatewayReasoningEfforts(model, observedAt)
          : providerReasoningEfforts(
              model?.supported_reasoning_efforts ?? asRecord(model?.capabilities)?.reasoning_efforts,
              observedAt,
            );
      if (inputModalityEvidence !== undefined) compatibility.inputModalities = inputModalityEvidence;
      if (outputModalityEvidence !== undefined) compatibility.outputModalities = outputModalityEvidence;
      if (reasoningEfforts !== undefined) compatibility.reasoningEfforts = reasoningEfforts;
      if (xiaomiModel !== undefined) {
        const inputModalities: ModelModality[] = xiaomiModel.images ? ["text", "image"] : ["text"];
        compatibility.inputModalities = modelEvidence(inputModalities, "maintained", observedAt);
        compatibility.reasoningEfforts = modelEvidence(["off", "high"], "maintained", observedAt);
      }
      if (this.#config.openRouter && this.#config.promptCache !== "off") {
        compatibility.cacheMode = modelEvidence("explicit", "configuration", observedAt);
        compatibility.cacheAffinity = modelEvidence("prefix", "configuration", observedAt);
        compatibility.cacheTiers = modelEvidence([this.#config.promptCache], "configuration", observedAt);
      }
      const pricing = this.#config.openRouter
        ? openRouterPricing(model, observedAt)
        : this.#config.profile === "vercel-ai-gateway"
          ? vercelGatewayPricing(model, observedAt)
          : undefined;
      const info: ModelInfo = {
        id,
        provider: this.id,
        capabilities,
        compatibility,
        ...(pricing === undefined ? {} : { pricing }),
        metadata: jsonValueOrString(model),
      };
      const displayName = asString(model?.name) ?? xiaomiModel?.displayName;
      const description = asString(model?.description) ?? xiaomiModel?.description;
      const contextTokens = catalogLimit(
        model?.context_length ?? model?.max_context_length ??
        (this.#config.profile === "vercel-ai-gateway" ? model?.context_window : undefined),
      ) ?? xiaomiModel?.contextTokens;
      const maxOutputTokens = catalogLimit(
        asRecord(model?.top_provider)?.max_completion_tokens ?? model?.max_output_tokens ??
        (this.#config.profile === "vercel-ai-gateway" ? model?.max_tokens : undefined),
      ) ?? xiaomiModel?.maxOutputTokens;
      if (displayName !== undefined) info.displayName = displayName;
      if (description !== undefined) info.description = description;
      if (contextTokens !== undefined) info.contextTokens = contextTokens;
      if (maxOutputTokens !== undefined) info.maxOutputTokens = maxOutputTokens;
      return [mergeModelCompatibility(info)];
    });
  }

  async #headers(signal: AbortSignal): Promise<Headers> {
    const headers = new Headers(this.#config.headers);
    const token = await resolveToken(this.#config.token, signal);
    if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
    return headers;
  }
}

export class OpenAICompatibleAdapter extends ChatCompletionsAdapter {
  constructor(config: OpenAICompatibleConfig) {
    const baseUrl = trimSlash(config.baseUrl);
    assertSecureEndpoint(baseUrl, "OpenAI-compatible base URL");
    const profile = config.profile ?? "default";
    if (!["default", "vercel-ai-gateway", "zai", "kimi-coding", "minimax", "qwen-token-plan", "xiaomi", "moonshot", "opencode", "cloudflare-ai-gateway"].includes(profile)) {
      throw new TypeError("OpenAI-compatible profile is unsupported");
    }
    super({
      id: config.id ?? "openai-compatible",
      baseUrl,
      token: config.accessToken ?? config.apiKey,
      headers: config.headers,
      includeUsage: config.includeUsage ?? profile !== "zai",
      profile,
      openRouter: false,
      promptCache: "off",
      protocolFamily: "openai-chat-completions",
      fetch: config.fetch ?? globalThis.fetch,
    });
  }
}

export class OpenRouterAdapter extends ChatCompletionsAdapter {
  constructor(config: OpenRouterConfig) {
    if (config.promptCache !== undefined && !["off", "5m", "1h"].includes(config.promptCache)) {
      throw new TypeError("OpenRouter promptCache must be off, 5m, or 1h");
    }
    const headers = new Headers(config.headers);
    if (config.appName !== undefined) headers.set("x-title", config.appName);
    if (config.siteUrl !== undefined) headers.set("http-referer", config.siteUrl);
    const baseUrl = trimSlash(config.baseUrl ?? "https://openrouter.ai/api/v1");
    assertSecureEndpoint(baseUrl, "OpenRouter base URL");
    super({
      id: "openrouter",
      baseUrl,
      token: config.apiKey,
      headers,
      includeUsage: true,
      profile: "default",
      openRouter: true,
      promptCache: config.promptCache ?? "off",
      protocolFamily: "openai-chat-completions",
      fetch: config.fetch ?? globalThis.fetch,
    });
  }
}

function buildChatBody(
  request: ProviderRequest,
  includeUsage: boolean,
  openRouter: boolean,
  promptCache: "off" | "5m" | "1h",
  profile: OpenAICompatibleProfile,
  provider: ProviderId,
): Record<string, unknown> {
  const moonshotSchema = moonshotToolSchemaRoute(request, profile, provider);
  request = providerWireRequest(
    request,
    request.providerState?.kind === chatStateKind(openRouter),
  );
  const compatibility = request.modelSettings?.compatibility;
  const requestedPromptCache = promptCache === "off" || request.cacheRetention === "none"
    ? "off"
    : request.cacheRetention === "long"
      ? "1h"
      : request.cacheRetention === "short"
        ? "5m"
        : promptCache;
  const effectivePromptCache = requestedPromptCache === "1h" && compatibility?.supportsLongCacheRetention === false
    ? "5m"
    : requestedPromptCache;
  const messages = buildChatMessages(request, openRouter, moonshotSchema);
  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    stream: true,
    n: 1,
  };
  if (compatibility?.supportsStore === true) body.store = false;
  if (compatibility?.supportsUsageInStreaming ?? includeUsage) body.stream_options = { include_usage: true };
  if (request.maxOutputTokens !== undefined) {
    const maxTokensField = compatibility?.maxTokensField
      ?? (["deepseek", "github-copilot", "opencode", "opencode-go", "xai"].includes(provider) ||
        profile === "zai" || profile === "moonshot" || profile === "opencode" || profile === "cloudflare-ai-gateway"
        ? "max_tokens"
        : "max_completion_tokens");
    body[maxTokensField] = request.maxOutputTokens;
  }
  if (request.temperature !== undefined) body.temperature = request.temperature;
  applyReasoningParameters(body, request, openRouter, profile);
  let tools: Array<Record<string, unknown>> | undefined;
  if (request.tools.length > 0) {
    const deferred = chatDeferredToolNames(request, compatibility);
    tools = request.tools
      .filter((tool) => !deferred.has(tool.name))
      .map((tool) => chatTool(tool, compatibility, moonshotSchema));
    if (tools.length > 0) {
      body.tools = tools;
      if (compatibility?.zaiToolStream ?? profile === "zai") body.tool_stream = true;
      if (profile === "default" || profile === "vercel-ai-gateway") body.parallel_tool_calls = true;
    }
  }
  if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
  const anthropicCacheControl = compatibility?.cacheControlFormat === "anthropic" ||
    (openRouter && routedAnthropicModel(request.model));
  if (anthropicCacheControl && request.cacheRetention !== "none") {
    applyAnthropicCacheControl(messages, tools, {
      type: "ephemeral",
      ...(compatibility?.cacheControlTtl === "1h" ? { ttl: "1h" } : {}),
    });
  }
  if (profile === "minimax") body.reasoning_split = true;
  if (openRouter && request.metadata !== undefined) body.metadata = request.metadata;
  if (openRouter && request.sessionId !== undefined && request.cacheRetention !== "none") {
    body.session_id = request.sessionId;
  }
  if (profile === "kimi-coding" && request.sessionId !== undefined && request.sessionId !== "") {
    body.prompt_cache_key = sessionAffinityKey(request.sessionId);
  }
  if (openRouter && effectivePromptCache !== "off") {
    body.cache_control = {
      type: "ephemeral",
      ...(effectivePromptCache === "1h" ? { ttl: "1h" } : {}),
    };
  }
  if (compatibility?.openRouterRouting !== undefined) {
    body.provider = structuredClone(compatibility.openRouterRouting);
  }
  if (compatibility?.vercelGatewayRouting !== undefined) {
    body.providerOptions = { gateway: structuredClone(compatibility.vercelGatewayRouting) };
  }
  return body;
}

function routedAnthropicModel(model: string): boolean {
  return (model.startsWith("~") ? model.slice(1) : model).startsWith("anthropic/");
}

function reasoningEnabled(request: ProviderRequest): boolean {
  return request.reasoningEffort !== undefined && !["off", "none"].includes(request.reasoningEffort);
}

function mappedReasoningEffort(request: ProviderRequest, offDefault?: string): string | undefined {
  const effort = request.reasoningEffort === "none" ? "off" : request.reasoningEffort;
  const selected = effort ?? "off";
  const mapping = request.modelSettings?.reasoningEffortMap;
  const mapped = mapping !== undefined && Object.hasOwn(mapping, selected)
    ? mapping[selected] ?? undefined
    : selected === "off" ? offDefault : selected;
  assertCurrentProviderReasoningEffort(mapped);
  if (request.provider === "openai" || request.provider === "openai-codex" || request.provider === "azure-openai") {
    assertOpenAIReasoningEffort(mapped);
  }
  return mapped;
}

function applyReasoningParameters(
  body: Record<string, unknown>,
  request: ProviderRequest,
  openRouter: boolean,
  profile: OpenAICompatibleProfile,
): void {
  const compatibility = request.modelSettings?.compatibility;
  if (compatibility?.reasoningOutputFormat !== undefined) {
    body.reasoning_format = compatibility.reasoningOutputFormat;
  } else if (compatibility?.includeReasoning !== undefined) {
    body.include_reasoning = compatibility.includeReasoning;
  }
  const format = compatibility?.reasoningFormat;
  const enabled = reasoningEnabled(request);
  if (format !== undefined) {
    if (format === "zai") {
      body.thinking = enabled ? { type: "enabled", clear_thinking: false } : { type: "disabled" };
      const effort = mappedReasoningEffort(request);
      if (enabled && compatibility?.supportsReasoningEffort === true && effort !== undefined) {
        body.reasoning_effort = effort;
      }
      return;
    }
    if (format === "qwen") {
      body.enable_thinking = enabled;
      if (profile === "qwen-token-plan") body.preserve_thinking = true;
      return;
    }
    if (format === "qwen-chat-template") {
      body.chat_template_kwargs = { enable_thinking: enabled, preserve_thinking: true };
      return;
    }
    if (format === "chat-template") {
      const parameters = resolveChatTemplateParameters(request);
      if (parameters !== undefined) body.chat_template_kwargs = parameters;
      return;
    }
    if (format === "deepseek") {
      if (enabled) body.thinking = { type: "enabled" };
      else if (request.modelSettings?.reasoningEffortMap?.off !== null) body.thinking = { type: "disabled" };
      const effort = mappedReasoningEffort(request);
      if (enabled && compatibility?.supportsReasoningEffort === true && effort !== undefined) {
        body.reasoning_effort = effort;
      }
      return;
    }
    if (format === "openrouter") {
      const effort = mappedReasoningEffort(request, "none");
      if (effort !== undefined) body.reasoning = { effort };
      return;
    }
    if (format === "ant-ling") {
      const effort = mappedReasoningEffort(request);
      if (effort === "enable" || effort === "disable") body.thinking = { type: effort };
      else if (enabled && effort !== undefined) body.reasoning = { effort };
      return;
    }
    if (format === "together") {
      body.reasoning = { enabled };
      const effort = mappedReasoningEffort(request);
      if (enabled && compatibility?.supportsReasoningEffort === true && effort !== undefined) {
        body.reasoning_effort = effort;
      }
      return;
    }
    if (format === "string-thinking") {
      const effort = mappedReasoningEffort(request, "none");
      if (effort !== undefined) body.thinking = effort;
      return;
    }
    const effort = mappedReasoningEffort(request);
    if (effort !== undefined && compatibility?.supportsReasoningEffort !== false) body.reasoning_effort = effort;
    return;
  }

  if (profile === "qwen-token-plan") {
    body.enable_thinking = enabled;
    body.preserve_thinking = true;
  } else if (profile === "xiaomi") {
    body.thinking = { type: enabled ? "enabled" : "disabled" };
  } else if (profile === "moonshot") {
    if (enabled || request.modelSettings?.reasoningEffortMap?.off !== null) {
      body.thinking = { type: enabled ? "enabled" : "disabled" };
    }
  } else if (profile === "cloudflare-ai-gateway") {
    // The gateway accepts the model's native reasoning behavior but rejects
    // the generic Chat Completions reasoning_effort field.
  } else if (
    request.reasoningEffort !== undefined ||
    Object.hasOwn(request.modelSettings?.reasoningEffortMap ?? {}, "off")
  ) {
    const effort = mappedReasoningEffort(request, request.reasoningEffort);
    if (openRouter && effort !== undefined) body.reasoning = { effort };
    else if (
      effort !== undefined &&
      (
        compatibility?.supportsReasoningEffort !== false ||
        Object.hasOwn(
          request.modelSettings?.reasoningEffortMap ?? {},
          request.reasoningEffort === "none" ? "off" : request.reasoningEffort ?? "off",
        )
      )
    ) {
      body.reasoning_effort = profile === "zai" ? normalizeNoneReasoningEffort(effort) : effort;
    }
  }
}

function resolveChatTemplateParameters(request: ProviderRequest): Record<string, unknown> | undefined {
  const configured = request.modelSettings?.compatibility?.chatTemplateParameters;
  if (configured === undefined) return undefined;
  const resolve = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(resolve).filter((entry) => entry !== undefined);
    }
    const record = asRecord(value);
    if (record === undefined) return value;
    if (record.$var === "thinking.enabled" || record.$var === "thinking.effort") {
      if (record.omitWhenOff === true && !reasoningEnabled(request)) return undefined;
      return record.$var === "thinking.enabled" ? reasoningEnabled(request) : mappedReasoningEffort(request);
    }
    return Object.fromEntries(Object.entries(record).flatMap(([key, entry]) => {
      const resolved = resolve(entry);
      return resolved === undefined ? [] : [[key, resolved]];
    }));
  };
  const result = resolve(configured) as Record<string, unknown>;
  return Object.keys(result).length === 0 ? undefined : result;
}

interface AnthropicCacheControl {
  type: "ephemeral";
  ttl?: "1h";
}

function applyAnthropicCacheControl(
  messages: unknown[],
  tools: Array<Record<string, unknown>> | undefined,
  cacheControl: AnthropicCacheControl,
): void {
  const instruction = messages.find((message) => {
    const role = asString(asRecord(message)?.role);
    return role === "system" || role === "developer";
  });
  if (instruction !== undefined) addCacheControlToText(instruction, cacheControl);
  if (tools !== undefined && tools.length > 0) tools[tools.length - 1]!.cache_control = cacheControl;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const role = asString(asRecord(message)?.role);
    if ((role === "user" || role === "assistant" || role === "tool") && addCacheControlToText(message, cacheControl)) break;
  }
}

function addCacheControlToText(value: unknown, cacheControl: AnthropicCacheControl): boolean {
  const message = asRecord(value);
  if (message === undefined) return false;
  if (typeof message.content === "string") {
    if (message.content === "") return false;
    message.content = [{ type: "text", text: message.content, cache_control: cacheControl }];
    return true;
  }
  if (!Array.isArray(message.content)) return false;
  for (let index = message.content.length - 1; index >= 0; index -= 1) {
    const part = asRecord(message.content[index]);
    if (part?.type !== "text") continue;
    part.cache_control = cacheControl;
    return true;
  }
  return false;
}

const SCHEMA_COMBINATORS = ["anyOf", "oneOf", "allOf", "not", "if", "then", "else", "$ref"] as const;
const SCHEMA_OBJECT_HINTS = ["properties", "additionalProperties", "patternProperties", "propertyNames", "required", "minProperties", "maxProperties"] as const;
const SCHEMA_ARRAY_HINTS = ["items", "prefixItems", "minItems", "maxItems", "uniqueItems", "contains"] as const;

function schemaValueType(value: unknown): string | undefined {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return ["boolean", "object", "string"].includes(typeof value) ? typeof value : undefined;
}

function missingSchemaType(node: Record<string, unknown>): string {
  const values = Array.isArray(node.enum) && node.enum.length > 0
    ? node.enum
    : Object.hasOwn(node, "const") ? [node.const] : [];
  if (values.length > 0) {
    const types = new Set(values.map(schemaValueType).filter((value): value is string => value !== undefined));
    if (types.size === 1) return [...types][0]!;
    if (types.size === 2 && types.has("integer") && types.has("number")) return "number";
    return "string";
  }
  if (SCHEMA_OBJECT_HINTS.some((key) => Object.hasOwn(node, key))) return "object";
  if (SCHEMA_ARRAY_HINTS.some((key) => Object.hasOwn(node, key))) return "array";
  if (["minLength", "maxLength", "pattern", "format"].some((key) => Object.hasOwn(node, key))) return "string";
  if (["minimum", "maximum", "multipleOf", "exclusiveMinimum", "exclusiveMaximum"].some((key) => Object.hasOwn(node, key))) return "number";
  return "string";
}

function normalizeMoonshotSchemaNode(value: unknown, property: boolean): void {
  const node = asRecord(value);
  if (node === undefined) return;
  if (property && node.type === undefined && !SCHEMA_COMBINATORS.some((key) => Object.hasOwn(node, key))) {
    node.type = missingSchemaType(node);
  }
  for (const key of ["properties", "patternProperties", "dependentSchemas", "$defs", "definitions"] as const) {
    const entries = asRecord(node[key]);
    if (entries !== undefined) for (const child of Object.values(entries)) normalizeMoonshotSchemaNode(child, true);
  }
  for (const key of ["items", "prefixItems"] as const) {
    const child = node[key];
    if (Array.isArray(child)) for (const item of child) normalizeMoonshotSchemaNode(item, true);
    else normalizeMoonshotSchemaNode(child, true);
  }
  for (const key of ["additionalProperties", "contains", "propertyNames", "not", "if", "then", "else"] as const) {
    normalizeMoonshotSchemaNode(node[key], true);
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = node[key];
    if (Array.isArray(branches)) for (const branch of branches) normalizeMoonshotSchemaNode(branch, true);
  }
}

function moonshotToolParameters<T extends object>(parameters: T): T {
  const normalized = structuredClone(parameters);
  normalizeMoonshotSchemaNode(normalized, false);
  return normalized;
}

function moonshotToolSchemaRoute(
  request: ProviderRequest,
  profile: OpenAICompatibleProfile,
  provider: ProviderId,
): boolean {
  const model = request.model.toLowerCase();
  const opencode = profile === "opencode" || provider === "opencode" || provider === "opencode-go" ||
    request.provider === "opencode" || request.provider === "opencode-go";
  return profile === "kimi-coding" || profile === "moonshot" || request.modelSettings?.compatibility?.deferredToolsMode === "kimi" ||
    (opencode && /^kimi(?:-|$)/u.test(model));
}

function chatTool(
  tool: ProviderRequest["tools"][number],
  compatibility: ModelRequestCompatibility | undefined,
  moonshotSchema: boolean,
): Record<string, unknown> {
  const grammar = providerGrammarTool(tool, compatibility?.supportsOpenAIGrammarTools === true);
  if (grammar) {
    return {
      type: "custom",
      custom: {
        name: tool.name,
        description: tool.description,
        format: { type: "grammar", grammar: { syntax: grammar.format, definition: grammar.definition } },
      },
    };
  }
  const supportsStrict = compatibility?.supportsStrictMode ?? true;
  const strict = providerStrictTool(tool, supportsStrict);
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: moonshotSchema ? moonshotToolParameters(tool.inputSchema) : tool.inputSchema,
      ...(supportsStrict ? { strict: strict ?? false } : {}),
    },
  };
}

function chatDeferredToolNames(
  request: ProviderRequest,
  compatibility = request.modelSettings?.compatibility,
): Set<string> {
  if (compatibility?.deferredToolsMode !== "kimi") return new Set();
  const available = new Set(request.tools.map((tool) => tool.name));
  const deferred = new Set<string>();
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      for (const name of block.addedToolNames ?? []) if (available.has(name)) deferred.add(name);
    }
  }
  return deferred;
}

function compatibleAssistantState(
  value: Record<string, unknown>,
  compatibility: ModelRequestCompatibility | undefined,
): Record<string, unknown> {
  const output = structuredClone(value);
  if (compatibility?.requiresThinkingAsText === true) {
    const reasoning = asString(output.reasoning_content)
      ?? asString(output.reasoning)
      ?? asString(output.reasoning_text);
    if (reasoning !== undefined && reasoning !== "") {
      const content = Array.isArray(output.content)
        ? output.content
        : typeof output.content === "string" && output.content !== ""
          ? [{ type: "text", text: output.content }]
          : [];
      output.content = [{ type: "text", text: reasoning }, ...content];
      delete output.reasoning_content;
      delete output.reasoning;
      delete output.reasoning_text;
    }
  } else if (compatibility?.requiresReasoningContentOnAssistantMessages === true) {
    const reasoning = asString(output.reasoning_content)
      ?? asString(output.reasoning)
      ?? asString(output.reasoning_text);
    output.reasoning_content = reasoning ?? "";
    delete output.reasoning;
    delete output.reasoning_text;
  }
  return output;
}

function buildChatMessages(request: ProviderRequest, openRouter: boolean, moonshotSchema: boolean): unknown[] {
  const compatibility = request.modelSettings?.compatibility;
  const deferred = chatDeferredToolNames(request, compatibility);
  const toolsByName = new Map(request.tools.map((tool) => [tool.name, tool]));
  const grammarProperties = providerGrammarProperties(
    request.tools,
    compatibility?.supportsOpenAIGrammarTools === true,
  );
  const introduced = new Set<string>();
  const state: ChatProviderState | undefined =
    request.providerState?.kind === chatStateKind(openRouter)
      ? request.providerState as ChatProviderState
      : undefined;
  const lastAssistant = findLastAssistant(request);
  const output: unknown[] = [];
  let previousHadToolResult = false;
  for (const [index, message] of request.messages.entries()) {
    if (
      compatibility?.requiresAssistantAfterToolResult === true &&
      previousHadToolResult &&
      message.role === "user"
    ) {
      output.push({ role: "assistant", content: "Tool results received and handled." });
    }
    if (state !== undefined && index === lastAssistant) {
      const assistantState = asRecord(state.assistantMessage);
      output.push(assistantState === undefined
        ? structuredClone(state.assistantMessage)
        : compatibleAssistantState(assistantState, compatibility));
      previousHadToolResult = false;
      continue;
    }
    const toolResults = message.content.filter((block) => block.type === "tool_result");
    const images = [
      ...message.content.filter((block) => block.type === "image"),
      ...toolResults.flatMap((block) => block.images ?? []),
    ];
    if (toolResults.length > 0) {
      output.push(...toolResults.map((block) => ({
        role: "tool",
        tool_call_id: block.callId,
        content: toolResultText(block),
        ...(compatibility?.requiresToolResultName === true ? { name: block.name } : {}),
      })));
      if (images.length > 0) output.push({ role: "user", content: chatImageParts(images) });
      for (const block of toolResults) {
        const newlyLoaded = (block.addedToolNames ?? [])
          .filter((name) => deferred.has(name) && !introduced.has(name))
          .flatMap((name) => {
            introduced.add(name);
            const tool = toolsByName.get(name);
            return tool === undefined ? [] : [chatTool(tool, compatibility, moonshotSchema)];
          });
        if (newlyLoaded.length > 0) output.push({ role: "system", tools: newlyLoaded });
      }
      previousHadToolResult = true;
      continue;
    }

    const text = message.content.filter((block) => block.type === "text").map((block) => block.text);
    const content: unknown =
      images.length === 0
        ? text.join("\n")
        : [
            ...text.map((value) => ({ type: "text", text: value })),
            ...chatImageParts(images),
          ];
    const messageOutput: Record<string, unknown> = {
      role: message.role === "system" && compatibility?.supportsDeveloperRole === true
        ? "developer"
        : message.role,
      content,
    };
    const calls = message.content.filter((block) => block.type === "tool_call");
    if (calls.length > 0) {
      messageOutput.tool_calls = calls.map((call) => {
        const property = grammarProperties.get(call.name);
        return property === undefined
          ? {
              id: call.callId,
              type: "function",
              function: { name: call.name, arguments: stringifyProviderJson(call.arguments) },
            }
          : {
              id: call.callId,
              type: "custom",
              custom: {
                name: call.name,
                input: providerGrammarInput(call.name, call.arguments as Record<string, unknown>, property),
              },
            };
      });
    }
    if (
      message.role === "assistant" &&
      compatibility?.requiresReasoningContentOnAssistantMessages === true
    ) {
      messageOutput.reasoning_content = "";
    }
    output.push(messageOutput);
    previousHadToolResult = false;
  }
  return output;
}

function chatImageParts(images: ImageBlock[]): unknown[] {
  return images.map((image) => {
    const source = normalizeImageSource(image, "OpenAI-compatible Chat Completions");
    requireImageUrlProtocol(source, "OpenAI-compatible Chat Completions", ["http:", "https:"]);
    return {
      type: "image_url",
      image_url: {
        url: source.kind === "url" ? source.url : `data:${source.mediaType};base64,${source.data}`,
      },
    };
  });
}

function findLastAssistant(request: ProviderRequest): number {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    if (request.messages[index]?.role === "assistant") return index;
  }
  return -1;
}

function applySessionAffinityHeaders(headers: Headers, request: ProviderRequest, openRouter: boolean): void {
  if (request.cacheRetention === "none") return;
  const compatibility = request.modelSettings?.compatibility;
  if (compatibility?.sendSessionAffinityHeaders !== true) return;
  const sessionId = sessionAffinityKey(request.sessionId);
  if (sessionId === undefined) return;
  const format = compatibility.sessionAffinityFormat ?? (openRouter ? "openrouter" : "openai");
  if (format === "openrouter") {
    headers.set("x-session-id", sessionId);
    return;
  }
  if (format === "openai") headers.set("session_id", sessionId);
  for (const name of ["x-client-request-id", "x-session-affinity"]) {
    headers.set(name, sessionId);
  }
}

function clearSessionAffinityHeaders(headers: Headers): void {
  headers.delete("x-affinity");
  headers.delete("x-session-id");
  headers.delete("session_id");
  headers.delete("x-client-request-id");
  headers.delete("x-session-affinity");
}

function sessionAffinityKey(sessionId: string | undefined): string | undefined {
  if (sessionId === undefined || sessionId === "") return undefined;
  if (/^[A-Za-z0-9._:-]{1,128}$/u.test(sessionId)) return sessionId;
  return `session_${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`;
}

function normalizeNoneReasoningEffort(value: string): string {
  return value === "off" ? "none" : value;
}

function finishTool(tool: ToolAccumulator): AdapterEvent {
  tool.ended = true;
  const event: AdapterEvent = {
    type: "tool_call_end",
    index: tool.index,
    name: tool.name || "unknown_tool",
    rawArguments: tool.arguments,
  };
  if (tool.id !== undefined) event.id = tool.id;
  try {
    event.arguments = jsonValueOrString(parseJsonWithRepair(tool.arguments === "" ? "{}" : tool.arguments));
  } catch (error) {
    event.parseError = error instanceof Error ? error.message : String(error);
  }
  return event;
}

function chatState(
  provider: ProviderId,
  content: string,
  reasoning: string,
  refusal: string,
  reasoningDetails: JsonValue[],
  tools: Map<number, ToolAccumulator>,
  profile: OpenAICompatibleProfile,
): ProviderState {
  const message: Record<string, JsonValue> = { role: "assistant", content };
  if (reasoning !== "") {
    message[profile === "zai" || profile === "kimi-coding" || profile === "minimax" || profile === "xiaomi" || profile === "moonshot"
      ? "reasoning_content"
      : "reasoning"] = reasoning;
  }
  if (refusal !== "") message.refusal = refusal;
  if (reasoningDetails.length > 0) message.reasoning_details = reasoningDetails;
  if (tools.size > 0) {
    message.tool_calls = [...tools.values()]
      .sort((left, right) => left.index - right.index)
      .map((tool) => tool.grammar
        ? {
            id: tool.id ?? `call_${tool.index}`,
            type: "custom",
            custom: { name: tool.name || "unknown_tool", input: tool.grammar.input.value },
          }
        : {
            id: tool.id ?? `call_${tool.index}`,
            type: "function",
            function: { name: tool.name || "unknown_tool", arguments: tool.arguments },
          });
  }
  return {
    kind: provider === "openrouter" ? "openrouter_chat" : "chat_completions",
    assistantMessage: message,
  } as ProviderState;
}

function chatStateKind(openRouter: boolean): ProviderState["kind"] {
  return openRouter ? "openrouter_chat" : "chat_completions";
}

function chatUsage(value: unknown): NormalizedUsage | undefined {
  const usage = asRecord(value);
  if (usage === undefined) return undefined;
  const promptDetails = asRecord(usage.prompt_tokens_details);
  const completionDetails = asRecord(usage.completion_tokens_details);
  const toolDetails = asRecord(usage.server_tool_use_details);
  return normalizeUsage({
    raw: jsonValueOrString(usage),
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    reportedTotalTokens: usage.total_tokens,
    cacheReadTokens: promptDetails?.cached_tokens ?? usage.cached_tokens ?? usage.prompt_cache_hit_tokens ??
      usage.cache_read_tokens ?? usage.cache_read_input_tokens,
    cacheWriteTokens: promptDetails?.cache_write_tokens ?? usage.cache_write_tokens ?? usage.cache_creation_input_tokens,
    reasoningTokens: completionDetails?.reasoning_tokens,
    serverToolCalls: toolDetails?.tool_calls_executed,
    inputIncludesCache: true,
  });
}

function reasoningDetailKey(fragment: Record<string, unknown>, fallbackIndex: number): string {
  return asString(fragment.id) ??
    `${asString(fragment.type) ?? "unknown"}:${asNumber(fragment.index) ?? fallbackIndex}`;
}

function reasoningDetailVisibility(
  fragment: Record<string, unknown> | undefined,
): "summary" | "provider_trace" {
  if (fragment === undefined || fragment.redacted === true) return "provider_trace";
  const type = asString(fragment.type)?.toLowerCase() ?? "";
  if (type === "reasoning.summary" && asString(fragment.summary) !== undefined) return "summary";
  if (type === "reasoning.text" && asString(fragment.text) !== undefined) return "summary";
  return "provider_trace";
}

function mergeReasoningDetail(
  target: Map<string, Record<string, unknown>>,
  key: string,
  fragment: Record<string, unknown>,
  cumulative: boolean,
): void {
  const current = target.get(key);
  if (current === undefined) {
    target.set(key, { ...fragment });
    return;
  }
  for (const [name, value] of Object.entries(fragment)) {
    if (["text", "summary", "data"].includes(name) && typeof value === "string") {
      current[name] = cumulative ? value : (asString(current[name]) ?? "") + value;
    } else if (value !== undefined) {
      current[name] = value;
    }
  }
}

function mapChatFinish(reason: string, sawTools: boolean, refused: boolean): FinishReason {
  if (reason === "tool_calls" || reason === "function_call" || (reason === "stop" && sawTools)) return "tool_calls";
  if (reason === "length" || reason === "model_context_window_exceeded") return "length";
  if (reason === "content_filter" || reason === "sensitive") return "error";
  if (reason === "refusal" || refused) return "refusal";
  if (reason === "stop") return "stop";
  return "error";
}

function modelCapabilities(
  model: Record<string, unknown> | undefined,
  observedAt: string,
  profile: OpenAICompatibleProfile = "default",
): ModelInfo["capabilities"] {
  const parameters = new Set(asArray(model?.supported_parameters).filter((value): value is string => typeof value === "string"));
  const tags = new Set(asArray(model?.tags).filter((value): value is string => typeof value === "string"));
  const providerTagsKnown = profile === "vercel-ai-gateway" && Array.isArray(model?.tags);
  const modalities = asArray(
    profile === "vercel-ai-gateway"
      ? asRecord(model?.modalities)?.input
      : asRecord(model?.architecture)?.input_modalities,
  )
    .filter((value): value is string => typeof value === "string");
  const capabilities = asRecord(model?.capabilities);
  const tools = capabilities?.function_calling;
  const reasoning = capabilities?.reasoning;
  const vision = capabilities?.vision;
  const providerReasoning = asRecord(model?.reasoning);
  const reasoningOptionsKnown = profile === "vercel-ai-gateway" && Array.isArray(model?.reasoning_options);
  const reasoningOptions = reasoningOptionsKnown ? asArray(model?.reasoning_options) : [];
  return {
    tools: capability(
      tools === true || parameters.has("tools") || parameters.has("tool_choice") || tags.has("tool-use"),
      typeof tools === "boolean" || parameters.size > 0 || providerTagsKnown,
      observedAt,
    ),
    reasoning: capability(
      reasoning === true || providerReasoning !== undefined || reasoningOptions.length > 0 ||
        parameters.has("reasoning") || parameters.has("reasoning_effort") || tags.has("reasoning"),
      typeof reasoning === "boolean" || providerReasoning !== undefined || reasoningOptionsKnown ||
        parameters.size > 0 || providerTagsKnown,
      observedAt,
    ),
    images: capability(
      vision === true || modalities.includes("image") || tags.has("vision"),
      typeof vision === "boolean" || modalities.length > 0 || providerTagsKnown,
      observedAt,
    ),
  };
}

const OPENROUTER_REASONING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function openRouterReasoningEfforts(
  model: Record<string, unknown> | undefined,
  observedAt: string,
): ReturnType<typeof providerReasoningEfforts> {
  const reasoning = asRecord(model?.reasoning);
  if (reasoning === undefined) {
    return providerReasoningEfforts(
      model?.supported_reasoning_efforts ?? asRecord(model?.capabilities)?.reasoning_efforts,
      observedAt,
    );
  }

  const mandatory = reasoning.mandatory;
  if (reasoning.supported_efforts === null) {
    return modelEvidence(
      OPENROUTER_REASONING_EFFORTS.filter((effort) => effort !== "off" || mandatory !== true),
      "provider",
      observedAt,
    );
  }
  const reported = providerReasoningEfforts(reasoning.supported_efforts, observedAt);
  if (reported === undefined) return undefined;
  const normalized = reported.value.map((effort) => effort === "none" ? "off" : effort);
  const values = [
    ...(mandatory === false && !normalized.includes("off") ? ["off"] : []),
    ...normalized.filter((effort) => effort !== "off" || mandatory !== true),
  ];
  return modelEvidence([...new Set(values)], "provider", observedAt);
}

function vercelGatewayReasoningEfforts(
  model: Record<string, unknown> | undefined,
  observedAt: string,
): ReturnType<typeof providerReasoningEfforts> {
  const values = asArray(model?.reasoning_options).flatMap((entry): unknown[] => {
    const option = asRecord(entry);
    return asString(option?.type) === "effort" ? asArray(option?.values) : [];
  });
  return providerReasoningEfforts(values, observedAt);
}

const NON_GENERATIVE_NVIDIA_KIND = /^(?:embed(?:ding)?|rerank(?:er|ing)?|retrieval|reward|safety|moderation|classification)$/iu;
const GENERATIVE_NVIDIA_KIND = /^(?:chat|chat-completion|completion|generation|language|text-generation)$/iu;
const NON_GENERATIVE_NVIDIA_ID = /(?:^|[\/._-])(?:bge|embed(?:ding|code|qa)?|nemoguard|nemoretriever|nvclip|rerank(?:er|ing)?|reward|safety|guard|detector|parse)(?:$|[\/._-])/iu;

function nvidiaChatModel(model: Record<string, unknown> | undefined, id: string): boolean {
  const explicitKinds = [model?.type, model?.model_type, model?.task]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim());
  if (explicitKinds.some((kind) => NON_GENERATIVE_NVIDIA_KIND.test(kind))) return false;
  if (explicitKinds.some((kind) => GENERATIVE_NVIDIA_KIND.test(kind))) return true;

  const advertisedTasks = asArray(model?.supported_tasks ?? model?.tasks ?? model?.capabilities)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim());
  if (advertisedTasks.some((kind) => GENERATIVE_NVIDIA_KIND.test(kind))) return true;
  if (advertisedTasks.length > 0 && advertisedTasks.every((kind) => NON_GENERATIVE_NVIDIA_KIND.test(kind))) return false;
  return !NON_GENERATIVE_NVIDIA_ID.test(id);
}

interface DocumentedXiaomiChatModel {
  displayName: string;
  description: string;
  contextTokens: number;
  maxOutputTokens: number;
  images: boolean;
}

function documentedXiaomiChatModel(id: string): DocumentedXiaomiChatModel | undefined {
  if (id === "mimo-v2-pro") {
    return {
      displayName: "MiMo V2 Pro",
      description: "Xiaomi text, reasoning, and agent model",
      contextTokens: 262_144,
      maxOutputTokens: 32_768,
      images: false,
    };
  }
  if (id === "mimo-v2.5-pro") {
    return {
      displayName: "MiMo V2.5 Pro",
      description: "Xiaomi text, reasoning, and agent model",
      contextTokens: 1_000_000,
      maxOutputTokens: 128_000,
      images: false,
    };
  }
  if (id === "mimo-v2.5") {
    return {
      displayName: "MiMo V2.5",
      description: "Xiaomi multimodal reasoning and agent model",
      contextTokens: 1_000_000,
      maxOutputTokens: 128_000,
      images: true,
    };
  }
  return undefined;
}

function documentedCapability(supported: boolean, observedAt: string): ModelCapability {
  return { value: supported ? "supported" : "unsupported", source: "maintained", observedAt };
}

function capability(supported: boolean, known: boolean, observedAt: string): ModelCapability {
  return { value: known ? (supported ? "supported" : "unsupported") : "unknown", source: "provider", observedAt };
}

function bearerToken(authorization: string | null): string | undefined {
  return /^Bearer\s+(.+)$/iu.exec(authorization ?? "")?.[1];
}

function stringCode(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
