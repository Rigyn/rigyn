import { createHash } from "node:crypto";

import type { JsonValue } from "../core/json.js";
import type {
  AdapterEvent,
  FinishReason,
  ImageBlock,
  ModelCapability,
  ModelInfo,
  NormalizedUsage,
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  ProviderState,
} from "../core/types.js";
import { catalogId, catalogLimit } from "./catalog.js";
import { requireBody } from "./lines.js";
import { normalizeImageSource, requireImageUrlProtocol } from "./images.js";
import { stringifyProviderJson } from "./json.js";
import { providerWireRequest } from "./messages.js";
import { decodeSSE } from "./sse.js";
import { toolResultText } from "./tool-results.js";
import { normalizeUsage } from "./usage.js";
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
  InvalidProviderRequestError,
  normalizeError,
  ProtocolError,
  ProviderStreamError,
  requestIdFromHeaders,
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
  | "minimax";

export interface OpenRouterConfig {
  apiKey?: TokenSource;
  baseUrl?: string;
  appName?: string;
  siteUrl?: string;
  headers?: HeadersInit;
  fetch?: FetchLike;
  promptCache?: "off" | "5m" | "1h";
}

export interface MistralConfig {
  apiKey?: TokenSource;
  baseUrl?: string;
  headers?: HeadersInit;
  fetch?: FetchLike;
  promptCache?: "off" | "session";
  reasoningMode?: "effort" | "prompt";
}

interface ChatTransportConfig {
  id: ProviderId;
  baseUrl: string;
  token: TokenSource | undefined;
  headers: HeadersInit | undefined;
  includeUsage: boolean;
  profile: OpenAICompatibleProfile;
  openRouter: boolean;
  mistral: boolean;
  promptCache: "off" | "5m" | "1h";
  mistralPromptCache: boolean;
  mistralReasoningMode: "effort" | "prompt";
  fetch: FetchLike;
}

interface ToolAccumulator {
  index: number;
  id?: string;
  name: string;
  arguments: string;
  ended: boolean;
}

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

    try {
      const headers = await this.#headers(signal);
      const generatedCacheKey = this.#config.mistral && this.#config.mistralPromptCache
        ? mistralCacheKey(request.sessionId)
        : undefined;
      if (generatedCacheKey !== undefined && !headers.has("x-affinity")) headers.set("x-affinity", generatedCacheKey);
      const cacheKey = this.#config.mistral && this.#config.mistralPromptCache
        ? headers.get("x-affinity") ?? generatedCacheKey
        : undefined;
      headers.set("content-type", "application/json");
      headers.set("accept", "text/event-stream");
      const response = await this.#config.fetch(`${this.#config.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: stringifyProviderJson(buildChatBody(
          request,
          this.#config.includeUsage,
          this.#config.openRouter,
          this.#config.promptCache,
          this.#config.mistral,
          this.#config.mistralReasoningMode,
          cacheKey,
          this.#config.profile,
        )),
        signal,
        redirect: "error",
      });
      requestId = requestIdFromHeaders(response.headers);
      await assertResponseOk(response);

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
      const tools = new Map<number, ToolAccumulator>();

      for await (const sse of decodeSSE(requireBody(response))) {
        if (sse.data.trim() === "[DONE]") {
          sawDone = true;
          break;
        }
        const parsed: unknown = parseJson(sse.data);
        const chunk = asRecord(parsed);
        if (chunk === undefined) throw new ProtocolError("Chat completion chunk was not an object", jsonValueOrString(parsed));

        const chunkError = asRecord(chunk.error);
        if (chunkError !== undefined || sse.event === "error") {
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
          const start: AdapterEvent = { type: "response_start", model: responseModel };
          if (responseId !== undefined) start.responseId = responseId;
          if (requestId !== undefined) start.requestId = requestId;
          yield start;
        }

        const chunkUsage = chatUsage(chunk.usage);
        if (chunkUsage !== undefined) yield { type: "usage", usage: chunkUsage, semantics: "final" };

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
            }

            const refusalDelta = asString(delta.refusal) ?? "";
            if (refusalDelta !== "") {
              refusal += refusalDelta;
              partial = true;
              yield { type: "text_delta", part: 0, text: refusalDelta };
            }

            const reasoningDelta = asString(delta.reasoning) ?? asString(delta.reasoning_content) ?? "";
            if (reasoningDelta !== "") {
              reasoning += reasoningDelta;
              partial = true;
              yield {
                type: "reasoning_delta",
                part: 0,
                text: reasoningDelta,
                visibility: "provider_trace",
              };
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
                yield {
                  type: "reasoning_delta",
                  part: asNumber(record?.index) ?? 0,
                  text: emitted,
                  visibility: summary !== undefined ? "summary" : "provider_trace",
                };
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
                const initialName = asString(functionDelta?.name);
                if (initialName !== undefined) start.name = initialName;
                yield start;
              }
              const nameFragment = asString(functionDelta?.name) ?? "";
              tool.name += nameFragment;
              const fragment = asString(functionDelta?.arguments) ?? "";
              tool.arguments += fragment;
              if (fragment !== "") yield { type: "tool_call_delta", index: tool.index, jsonFragment: fragment };
            }
          }

          const rawFinish = asString(choice.finish_reason);
          if (rawFinish !== undefined) finishReason = rawFinish;
          nativeFinishReason = asString(choice.native_finish_reason) ?? nativeFinishReason;
        }
      }

      if (!started) throw new ProtocolError("Chat completion stream ended before any response chunk");
      if (finishReason === "error") {
        throw new ProviderStreamError("Chat completion ended with an error", "provider_error");
      }
      if (finishReason === undefined) {
        throw new ProtocolError(
          sawDone
            ? "Chat completion emitted [DONE] without a finish reason"
            : "Chat completion stream ended before a finish reason",
        );
      }
      for (const tool of tools.values()) {
        if (!tool.ended) yield finishTool(tool);
      }
      terminal = true;
      const end: AdapterEvent = {
        type: "response_end",
        reason: mapChatFinish(finishReason, tools.size > 0, refusal !== ""),
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
        yield { type: "error", error: normalizeError(this.id, error, { partial, signal, requestId }) };
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
      if (this.#config.profile === "vercel-ai-gateway") {
        const type = asString(model?.type);
        if (type !== "language") return [];
      }
      const architecture = asRecord(model?.architecture);
      const outputModalities = asArray(architecture?.output_modalities)
        .filter((value): value is string => typeof value === "string");
      if (outputModalities.length > 0 && !outputModalities.includes("text")) return [];
      const capabilities = modelCapabilities(model, observedAt, this.#config.profile);
      const compatibility = baseModelCompatibility("openai-chat-completions", capabilities.tools, observedAt);
      const inputModalityEvidence = providerModalities(architecture?.input_modalities, observedAt);
      const outputModalityEvidence = providerModalities(architecture?.output_modalities, observedAt);
      const reasoningEfforts = providerReasoningEfforts(
        model?.supported_reasoning_efforts ?? asRecord(model?.capabilities)?.reasoning_efforts,
        observedAt,
      );
      if (inputModalityEvidence !== undefined) compatibility.inputModalities = inputModalityEvidence;
      if (outputModalityEvidence !== undefined) compatibility.outputModalities = outputModalityEvidence;
      if (reasoningEfforts !== undefined) compatibility.reasoningEfforts = reasoningEfforts;
      if (this.#config.openRouter && this.#config.promptCache !== "off") {
        compatibility.cacheMode = modelEvidence("explicit", "configuration", observedAt);
        compatibility.cacheAffinity = modelEvidence("prefix", "configuration", observedAt);
        compatibility.cacheTiers = modelEvidence([this.#config.promptCache], "configuration", observedAt);
      } else if (this.#config.mistralPromptCache) {
        compatibility.cacheMode = modelEvidence("automatic", "configuration", observedAt);
        compatibility.cacheAffinity = modelEvidence("session", "configuration", observedAt);
        compatibility.cacheTiers = modelEvidence(["session"], "configuration", observedAt);
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
      const displayName = asString(model?.name);
      const description = asString(model?.description);
      const contextTokens = catalogLimit(
        model?.context_length ?? model?.max_context_length ??
        (this.#config.profile === "vercel-ai-gateway" ? model?.context_window : undefined),
      );
      const maxOutputTokens = catalogLimit(
        asRecord(model?.top_provider)?.max_completion_tokens ?? model?.max_output_tokens ??
        (this.#config.profile === "vercel-ai-gateway" ? model?.max_tokens : undefined),
      );
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
    if (!["default", "vercel-ai-gateway", "zai", "kimi-coding", "minimax"].includes(profile)) {
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
      mistral: false,
      promptCache: "off",
      mistralPromptCache: false,
      mistralReasoningMode: "effort",
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
      mistral: false,
      promptCache: config.promptCache ?? "off",
      mistralPromptCache: false,
      mistralReasoningMode: "effort",
      fetch: config.fetch ?? globalThis.fetch,
    });
  }
}

export class MistralAdapter extends ChatCompletionsAdapter {
  constructor(config: MistralConfig = {}) {
    if (config.promptCache !== undefined && config.promptCache !== "off" && config.promptCache !== "session") {
      throw new TypeError("Mistral promptCache must be off or session");
    }
    if (config.reasoningMode !== undefined && config.reasoningMode !== "effort" && config.reasoningMode !== "prompt") {
      throw new TypeError("Mistral reasoningMode must be effort or prompt");
    }
    const headers = new Headers(config.headers);
    const affinity = headers.get("x-affinity");
    if (affinity !== null && !/^[A-Za-z0-9._:-]{1,128}$/u.test(affinity)) {
      throw new TypeError("Mistral x-affinity header must be 1 to 128 safe characters");
    }
    const baseUrl = trimSlash(config.baseUrl ?? "https://api.mistral.ai/v1");
    assertSecureEndpoint(baseUrl, "Mistral base URL");
    super({
      id: "mistral",
      baseUrl,
      token: config.apiKey,
      headers,
      includeUsage: true,
      profile: "default",
      openRouter: false,
      mistral: true,
      promptCache: "off",
      mistralPromptCache: config.promptCache !== "off",
      mistralReasoningMode: config.reasoningMode ?? "effort",
      fetch: config.fetch ?? globalThis.fetch,
    });
  }
}

function buildChatBody(
  request: ProviderRequest,
  includeUsage: boolean,
  openRouter: boolean,
  promptCache: "off" | "5m" | "1h",
  mistral: boolean,
  mistralReasoningMode: "effort" | "prompt",
  mistralCacheKey: string | undefined,
  profile: OpenAICompatibleProfile,
): Record<string, unknown> {
  request = providerWireRequest(
    request,
    request.providerState?.kind === (openRouter ? "openrouter_chat" : "chat_completions"),
  );
  const body: Record<string, unknown> = {
    model: request.model,
    messages: buildChatMessages(request, openRouter, mistral),
    stream: true,
    n: 1,
  };
  if (includeUsage) body.stream_options = { include_usage: true };
  if (request.maxOutputTokens !== undefined) {
    body[mistral || profile === "zai" ? "max_tokens" : "max_completion_tokens"] = request.maxOutputTokens;
  }
  if (request.reasoningEffort !== undefined) {
    if (openRouter) body.reasoning = { effort: request.reasoningEffort };
    else if (mistral && mistralReasoningMode === "prompt") {
      if (!["off", "none"].includes(request.reasoningEffort)) body.prompt_mode = "reasoning";
    } else {
      body.reasoning_effort = mistral || profile === "zai"
        ? mistralReasoningEffort(request.reasoningEffort)
        : request.reasoningEffort;
    }
  }
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    }));
    if (profile === "zai") body.tool_stream = true;
    if (profile === "default" || profile === "vercel-ai-gateway") body.parallel_tool_calls = true;
  }
  if (profile === "minimax") body.reasoning_split = true;
  if ((openRouter || mistral) && request.metadata !== undefined) body.metadata = request.metadata;
  if (openRouter && request.sessionId !== undefined) body.session_id = request.sessionId;
  if (openRouter && promptCache !== "off") {
    body.cache_control = {
      type: "ephemeral",
      ...(promptCache === "1h" ? { ttl: "1h" } : {}),
    };
  }
  if (mistralCacheKey !== undefined) body.prompt_cache_key = mistralCacheKey;
  return body;
}

function buildChatMessages(request: ProviderRequest, openRouter: boolean, mistral: boolean): unknown[] {
  const normalizeToolId = mistral ? createMistralToolIdNormalizer() : (value: string) => value;
  const state =
    request.providerState?.kind === (openRouter ? "openrouter_chat" : "chat_completions")
      ? request.providerState
      : undefined;
  const lastAssistant = findLastAssistant(request);
  return request.messages.flatMap((message, index): unknown[] => {
    if (state !== undefined && index === lastAssistant) return [state.assistantMessage];
    const toolResults = message.content.filter((block) => block.type === "tool_result");
    const images = [
      ...message.content.filter((block) => block.type === "image"),
      ...toolResults.flatMap((block) => block.images ?? []),
    ];
    if (toolResults.length > 0) {
      const output: unknown[] = toolResults.map((block) => ({
        role: "tool",
        tool_call_id: normalizeToolId(block.callId),
        content: toolResultText(block),
      }));
      if (images.length > 0) output.push({ role: "user", content: chatImageParts(images) });
      return output;
    }

    const text = message.content.filter((block) => block.type === "text").map((block) => block.text);
    const content: unknown =
      images.length === 0
        ? text.join("\n")
        : [
            ...text.map((value) => ({ type: "text", text: value })),
            ...chatImageParts(images),
          ];
    const output: Record<string, unknown> = { role: message.role, content };
    const calls = message.content.filter((block) => block.type === "tool_call");
    if (calls.length > 0) {
      output.tool_calls = calls.map((call) => ({
        id: normalizeToolId(call.callId),
        type: "function",
        function: { name: call.name, arguments: stringifyProviderJson(call.arguments) },
      }));
    }
    return [output];
  });
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

function mistralCacheKey(sessionId: string | undefined): string | undefined {
  if (sessionId === undefined || sessionId === "") return undefined;
  if (/^[A-Za-z0-9._:-]{1,128}$/u.test(sessionId)) return sessionId;
  return `session_${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`;
}

function createMistralToolIdNormalizer(): (value: string) => string {
  const byInput = new Map<string, string>();
  const byOutput = new Map<string, string>();
  return (value: string) => {
    const existing = byInput.get(value);
    if (existing !== undefined) return existing;
    const compact = value.replace(/[^A-Za-z0-9]/gu, "");
    for (let attempt = 0; attempt < 1_024; attempt += 1) {
      const candidate = attempt === 0 && compact.length === 9
        ? compact
        : createHash("sha256").update(attempt === 0 ? value : `${value}:${attempt}`).digest("hex").slice(0, 9);
      const owner = byOutput.get(candidate);
      if (owner === undefined || owner === value) {
        byInput.set(value, candidate);
        byOutput.set(candidate, value);
        return candidate;
      }
    }
    throw new InvalidProviderRequestError("Mistral tool call IDs could not be normalized uniquely");
  };
}

function mistralReasoningEffort(value: string): string {
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
    event.arguments = jsonValueOrString(JSON.parse(tool.arguments === "" ? "{}" : tool.arguments));
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
    message[profile === "zai" || profile === "kimi-coding" || profile === "minimax"
      ? "reasoning_content"
      : "reasoning"] = reasoning;
  }
  if (refusal !== "") message.refusal = refusal;
  if (reasoningDetails.length > 0) message.reasoning_details = reasoningDetails;
  if (tools.size > 0) {
    message.tool_calls = [...tools.values()]
      .sort((left, right) => left.index - right.index)
      .map((tool) => ({
        id: tool.id ?? `call_${tool.index}`,
        type: "function",
        function: { name: tool.name || "unknown_tool", arguments: tool.arguments },
      }));
  }
  return provider === "openrouter"
    ? { kind: "openrouter_chat", assistantMessage: message }
    : { kind: "chat_completions", assistantMessage: message };
}

function chatUsage(value: unknown): NormalizedUsage | undefined {
  const usage = asRecord(value);
  if (usage === undefined) return undefined;
  const promptDetails = asRecord(usage.prompt_tokens_details);
  const completionDetails = asRecord(usage.completion_tokens_details);
  const toolDetails = asRecord(usage.server_tool_use_details);
  const cost = usage.cost;
  return normalizeUsage({
    raw: jsonValueOrString(usage),
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    reportedTotalTokens: usage.total_tokens,
    cacheReadTokens: promptDetails?.cached_tokens ?? usage.cached_tokens ?? usage.cache_read_tokens ?? usage.cache_read_input_tokens,
    cacheWriteTokens: promptDetails?.cache_write_tokens ?? usage.cache_write_tokens ?? usage.cache_creation_input_tokens,
    reasoningTokens: completionDetails?.reasoning_tokens,
    serverToolCalls: toolDetails?.tool_calls_executed,
    ...(typeof cost === "number" || typeof cost === "string" ? { cost: String(cost) } : {}),
    inputIncludesCache: true,
  });
}

function reasoningDetailKey(fragment: Record<string, unknown>, fallbackIndex: number): string {
  return asString(fragment.id) ??
    `${asString(fragment.type) ?? "unknown"}:${asNumber(fragment.index) ?? fallbackIndex}`;
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
  if (reason === "content_filter" || reason === "sensitive") return "content_filter";
  if (reason === "refusal" || refused) return "refusal";
  if (reason === "stop") return "stop";
  if (reason === "error" || reason === "network_error") return "error";
  return "unknown";
}

function modelCapabilities(
  model: Record<string, unknown> | undefined,
  observedAt: string,
  profile: OpenAICompatibleProfile = "default",
): ModelInfo["capabilities"] {
  const parameters = new Set(asArray(model?.supported_parameters).filter((value): value is string => typeof value === "string"));
  const tags = new Set(asArray(model?.tags).filter((value): value is string => typeof value === "string"));
  const providerTagsKnown = profile === "vercel-ai-gateway" && Array.isArray(model?.tags);
  const modalities = asArray(asRecord(model?.architecture)?.input_modalities)
    .filter((value): value is string => typeof value === "string");
  const capabilities = asRecord(model?.capabilities);
  const tools = capabilities?.function_calling;
  const reasoning = capabilities?.reasoning;
  const vision = capabilities?.vision;
  return {
    tools: capability(
      tools === true || parameters.has("tools") || parameters.has("tool_choice") || tags.has("tool-use"),
      typeof tools === "boolean" || parameters.size > 0 || providerTagsKnown,
      observedAt,
    ),
    reasoning: capability(
      reasoning === true || parameters.has("reasoning") || parameters.has("reasoning_effort") || tags.has("reasoning"),
      typeof reasoning === "boolean" || parameters.size > 0 || providerTagsKnown,
      observedAt,
    ),
    images: capability(
      vision === true || modalities.includes("image") || tags.has("vision"),
      typeof vision === "boolean" || modalities.length > 0 || providerTagsKnown,
      observedAt,
    ),
  };
}

function capability(supported: boolean, known: boolean, observedAt: string): ModelCapability {
  return { value: known ? (supported ? "supported" : "unsupported") : "unknown", source: "provider", observedAt };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError("Malformed chat completion SSE event", text);
  }
}

function stringCode(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
