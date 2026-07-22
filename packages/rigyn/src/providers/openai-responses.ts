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
  ProviderResponseDiagnostics,
  ProviderState,
} from "../core/types.js";
import { catalogId } from "./catalog.js";
import { requireBody } from "./lines.js";
import { normalizeImageSource, requireImageMediaType, requireImageUrlProtocol } from "./images.js";
import { stringifyProviderJson } from "./json.js";
import { providerWireRequest } from "./messages.js";
import { decodeSSE, wasSseEventDispatchedAtEof } from "./sse.js";
import { toolResultText } from "./tool-results.js";
import { normalizeUsage } from "./usage.js";
import { parseJsonWithRepair } from "./streaming-json.js";
import { baseModelCompatibility, mergeModelCompatibility, modelEvidence } from "./model-metadata.js";
import { createAzureOpenAISdkEventStream, createOpenAISdkEventStream } from "./openai-sdk-transport.js";
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
  PrematureStreamEndError,
  ProtocolError,
  ProviderStreamError,
  requestIdFromHeaders,
  responseDiagnostics,
  readJsonResponse,
  resolveToken,
  type TokenSource,
} from "./transport.js";

export interface OpenAIResponsesConfig {
  apiKey?: TokenSource;
  accessToken?: TokenSource;
  baseUrl?: string;
  organization?: string;
  project?: string;
  headers?: HeadersInit;
  fetch?: FetchLike;
  store?: boolean;
  promptCacheOptions?: OpenAIPromptCacheOptions;
  promptCacheRetention?: "in-memory" | "24h";
  serviceTier?: OpenAIServiceTier;
  /** Enable documented OpenAI hosted tool search on a compatible endpoint. */
  deferredToolLoading?: boolean;
}

export interface OpenAIPromptCacheOptions {
  ttl: "30m";
}

export type OpenAIServiceTier = "auto" | "default" | "flex" | "priority";

export interface AzureOpenAIResponsesConfig {
  endpoint: string;
  apiKey?: TokenSource;
  accessToken?: TokenSource;
  apiVersion?: string;
  deploymentName?: string;
  headers?: HeadersInit;
  fetch?: FetchLike;
  store?: boolean;
}

export interface ResponsesTransportConfig {
  baseUrl: string;
  headers: HeadersInit | undefined;
  fetch: FetchLike;
  authorize: (headers: Headers, signal: AbortSignal) => Promise<void>;
  prepareHeaders?: (headers: Headers, request: ProviderRequest) => void | Promise<void>;
  buildBody?: (request: ProviderRequest) => Record<string, unknown>;
  streamEvents?: (input: ResponsesEventStreamInput) => AsyncIterable<ResponsesWireEvent>;
  listModels?: (signal: AbortSignal) => Promise<ModelInfo[]>;
  stateful: boolean;
  retainResponseId?: boolean;
  promptCache: boolean;
  promptCacheOptions?: OpenAIPromptCacheOptions;
  promptCacheRetention?: "in-memory" | "24h";
  serviceTier?: OpenAIServiceTier;
  deferredToolLoading: boolean;
}

export interface ResponsesWireEvent {
  data: string;
  event?: string;
  requestId?: string;
  diagnostics?: ProviderResponseDiagnostics;
}

export interface ResponsesEventStreamInput {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
  request: ProviderRequest;
  signal: AbortSignal;
  fetch: FetchLike;
  onResponse?: (diagnostics: ProviderResponseDiagnostics, requestId?: string) => void;
}

interface ToolAccumulator {
  index: number;
  id?: string;
  itemId?: string;
  name?: string;
  arguments: string;
  ended: boolean;
}

const parsedResponsesWireEvents = new WeakMap<ResponsesWireEvent, unknown>();
const eofResponsesWireEvents = new WeakSet<ResponsesWireEvent>();

function responsesWireEventFromValue(
  value: unknown,
  requestId?: string,
  diagnostics?: ProviderResponseDiagnostics,
): ResponsesWireEvent {
  const wire: ResponsesWireEvent = {
    data: "",
    ...(requestId === undefined ? {} : { requestId }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
  parsedResponsesWireEvents.set(wire, value);
  return wire;
}

export class ResponsesAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  readonly #transport: ResponsesTransportConfig;

  constructor(id: ProviderId, transport: ResponsesTransportConfig) {
    this.id = id;
    this.#transport = transport;
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    yield* this.#streamAttempt(request, signal, true);
  }

  async *#streamAttempt(
    request: ProviderRequest,
    signal: AbortSignal,
    allowEarlyEofRetry: boolean,
  ): AsyncIterable<AdapterEvent> {
    let partial = false;
    let terminal = false;
    let requestId: string | undefined;
    let diagnostics: ProviderResponseDiagnostics | undefined;

    try {
      const headers = new Headers(this.#transport.headers);
      headers.set("content-type", "application/json");
      headers.set("accept", "text/event-stream");
      await this.#transport.authorize(headers, signal);
      await this.#transport.prepareHeaders?.(headers, request);
      applyResponsesSessionHeaders(headers, request);

      const url = `${this.#transport.baseUrl}/responses`;
      const body = this.#transport.buildBody?.(request) ?? buildResponsesBody(
        request,
        this.#transport.stateful,
        this.#transport.promptCache,
        this.#transport.promptCacheRetention,
        this.#transport.serviceTier,
        this.#transport.promptCacheOptions,
        this.#transport.deferredToolLoading,
      );
      const onResponse = (observedDiagnostics: ProviderResponseDiagnostics, observedRequestId?: string): void => {
        diagnostics = observedDiagnostics;
        requestId ??= observedRequestId;
      };
      const wireEvents = this.#transport.streamEvents?.({
        url,
        headers,
        body,
        request,
        signal,
        fetch: this.#transport.fetch,
        onResponse,
      }) ?? httpResponsesWireEvents({ url, headers, body, signal, fetch: this.#transport.fetch, onResponse });

      let started = false;
      let responseId: string | undefined;
      let responseModel = request.model;
      const outputItems = new Map<number, JsonValue>();
      const tools = new Map<string, ToolAccumulator>();
      const textParts = new Map<string, string>();
      const reasoningParts = new Map<string, number>();
      const reasoningText = new Map<string, string>();
      let nextReasoningPart = 0;
      let sawToolCall = false;
      let sawRefusal = false;
      const startResponse = (): AdapterEvent | undefined => {
        if (started) return undefined;
        started = true;
        const start: AdapterEvent = {
          type: "response_start",
          model: responseModel,
          ...(diagnostics === undefined ? {} : { diagnostics }),
        };
        if (responseId !== undefined) start.responseId = responseId;
        if (requestId !== undefined) start.requestId = requestId;
        return start;
      };

      for await (const wire of wireEvents) {
        requestId ??= wire.requestId;
        diagnostics ??= wire.diagnostics;
        const hasParsedEvent = parsedResponsesWireEvents.has(wire);
        if (!hasParsedEvent && wire.data.trim() === "[DONE]") break;
        let parsed: unknown;
        if (hasParsedEvent) {
          parsed = parsedResponsesWireEvents.get(wire);
        } else {
          try {
            parsed = parseJson(wire.data, "OpenAI Responses stream event");
          } catch (error) {
            if (error instanceof ProtocolError && eofResponsesWireEvents.has(wire)) {
              throw new PrematureStreamEndError("Responses stream ended before a terminal event", wire.data);
            }
            throw error;
          }
        }
        const event = asRecord(parsed);
        if (event === undefined) throw new ProtocolError("Responses event was not an object", jsonValueOrString(parsed));
        const type = asString(event.type) ?? wire.event;
        if (type === undefined) throw new ProtocolError("Responses event did not contain a type", jsonValueOrString(parsed));
        if (isIgnorableCodexInformationalEvent(this.id, type)) continue;

        const responseObject = asRecord(event.response);
        responseId = asString(responseObject?.id) ?? responseId;
        responseModel = asString(responseObject?.model) ?? responseModel;

        if (type === "response.created" || type === "response.in_progress" || type === "response.queued") {
          continue;
        }

        if (type === "response.output_text.delta") {
          const text = asString(event.delta) ?? "";
          if (text !== "") {
            const keys = responsePartKeys(
              asNumber(event.output_index),
              asString(event.item_id),
              asNumber(event.content_index) ?? 0,
            );
            const complete = `${firstMappedPart(textParts, keys) ?? ""}${text}`;
            for (const key of keys) textParts.set(key, complete);
            partial = true;
            const start = startResponse();
            if (start !== undefined) yield start;
            yield { type: "text_delta", part: asNumber(event.content_index) ?? 0, text };
          }
          continue;
        }

        if (type === "response.refusal.delta") {
          const text = asString(event.delta) ?? "";
          if (text !== "") {
            const keys = responsePartKeys(
              asNumber(event.output_index),
              asString(event.item_id),
              asNumber(event.content_index) ?? 0,
            );
            const complete = `${firstMappedPart(textParts, keys) ?? ""}${text}`;
            for (const key of keys) textParts.set(key, complete);
            sawRefusal = true;
            partial = true;
            const start = startResponse();
            if (start !== undefined) yield start;
            yield { type: "text_delta", part: asNumber(event.content_index) ?? 0, text };
          }
          continue;
        }

        if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
          const text = asString(event.delta) ?? "";
          if (text !== "") {
            partial = true;
            const start = startResponse();
            if (start !== undefined) yield start;
            const visibility = type.includes("summary") ? "summary" : "provider_trace";
            const index = asNumber(event.summary_index) ?? asNumber(event.content_index) ?? 0;
            const itemId = asString(event.item_id);
            const outputIndex = asNumber(event.output_index);
            const keys = responsePartKeys(outputIndex, itemId, index).map((key) => `${visibility}:${key}`);
            let part = firstMappedPart(reasoningParts, keys);
            if (part === undefined) {
              part = nextReasoningPart;
              nextReasoningPart += 1;
            }
            for (const key of keys) reasoningParts.set(key, part);
            const complete = `${firstMappedPart(reasoningText, keys) ?? ""}${text}`;
            for (const key of keys) reasoningText.set(key, complete);
            yield {
              type: "reasoning_delta",
              part,
              text,
              visibility,
            };
          }
          continue;
        }

        if (type === "response.output_item.added" || type === "response.output_item.done") {
          const index = asNumber(event.output_index) ?? outputItems.size;
          const item = asRecord(event.item);
          if (item !== undefined) outputItems.set(index, jsonValueOrString(item));
          if (type === "response.output_item.done" && item?.type === "message") {
            const itemId = asString(item.id);
            for (const [contentIndex, value] of asArray(item.content).entries()) {
              const content = asRecord(value);
              const contentType = asString(content?.type);
              const text = contentType === "output_text"
                ? asString(content?.text)
                : contentType === "refusal"
                  ? asString(content?.refusal)
                  : undefined;
              if (contentType === "refusal") sawRefusal = true;
              if (text === undefined) continue;
              const keys = responsePartKeys(index, itemId, contentIndex);
              const streamed = firstMappedPart(textParts, keys) ?? "";
              const missing = text.startsWith(streamed) ? text.slice(streamed.length) : "";
              if (missing === "") continue;
              for (const key of keys) textParts.set(key, text);
              partial = true;
              const start = startResponse();
              if (start !== undefined) yield start;
              yield { type: "text_delta", part: contentIndex, text: missing };
            }
          }
          if (type === "response.output_item.done" && item?.type === "reasoning") {
            const itemId = asString(item.id);
            const content = [
              ...asArray(item.summary).map((value, part) => ({ value, part, visibility: "summary" as const })),
              ...asArray(item.content).map((value, part) => ({ value, part, visibility: "provider_trace" as const })),
            ];
            for (const entry of content) {
              const text = asString(asRecord(entry.value)?.text) ?? "";
              const keys = responsePartKeys(index, itemId, entry.part).map((key) => `${entry.visibility}:${key}`);
              let part = firstMappedPart(reasoningParts, keys);
              const streamed = firstMappedPart(reasoningText, keys) ?? "";
              const missing = text.startsWith(streamed) ? text.slice(streamed.length) : "";
              if (missing === "") continue;
              if (part === undefined) {
                part = nextReasoningPart;
                nextReasoningPart += 1;
              }
              for (const key of keys) reasoningParts.set(key, part);
              for (const key of keys) reasoningText.set(key, text);
              partial = true;
              const start = startResponse();
              if (start !== undefined) yield start;
              yield { type: "reasoning_delta", part, text: missing, visibility: entry.visibility };
            }
          }
          if (item?.type === "function_call") {
            sawToolCall = true;
            const key = asString(item.id) ?? `index:${index}`;
            let tool = tools.get(key);
            if (tool === undefined) {
              tool = {
                index,
                arguments: asString(item.arguments) ?? "",
                ended: false,
              };
              const id = asString(item.call_id);
              const itemId = asString(item.id);
              const name = asString(item.name);
              if (id !== undefined) tool.id = id;
              if (itemId !== undefined) tool.itemId = itemId;
              if (name !== undefined) tool.name = name;
              tools.set(key, tool);
              partial = true;
              const responseStart = startResponse();
              if (responseStart !== undefined) yield responseStart;
              const start: AdapterEvent = { type: "tool_call_start", index };
              if (tool.id !== undefined) start.id = tool.id;
              if (tool.name !== undefined) start.name = tool.name;
              yield start;
            } else {
              tool.arguments = asString(item.arguments) ?? tool.arguments;
              const name = asString(item.name);
              const id = asString(item.call_id);
              if (name !== undefined) tool.name = name;
              if (id !== undefined) tool.id = id;
            }
            if (type.endsWith(".done") && !tool.ended) yield finishTool(tool);
          }
          continue;
        }

        if (type === "response.function_call_arguments.delta") {
          const found = findTool(tools, event);
          const tool = found.tool;
          if (found.created) {
            partial = true;
            const responseStart = startResponse();
            if (responseStart !== undefined) yield responseStart;
            const start: AdapterEvent = { type: "tool_call_start", index: tool.index };
            yield start;
          }
          const fragment = asString(event.delta) ?? "";
          tool.arguments += fragment;
          partial = true;
          yield { type: "tool_call_delta", index: tool.index, jsonFragment: fragment };
          continue;
        }

        if (type === "response.function_call_arguments.done") {
          const found = findTool(tools, event);
          const tool = found.tool;
          if (found.created) {
            partial = true;
            const responseStart = startResponse();
            if (responseStart !== undefined) yield responseStart;
            const start: AdapterEvent = { type: "tool_call_start", index: tool.index };
            yield start;
          }
          tool.arguments = asString(event.arguments) ?? tool.arguments;
          if (!tool.ended) yield finishTool(tool);
          continue;
        }

        if (type === "response.completed" || type === "response.incomplete") {
          const start = startResponse();
          if (start !== undefined) yield start;
          for (const tool of tools.values()) {
            if (!tool.ended) yield finishTool(tool);
          }
          for (const [index, item] of asArray(responseObject?.output).entries()) {
            outputItems.set(index, jsonValueOrString(item));
          }
          const usage = usageFromResponse(responseObject?.usage);
          if (usage !== undefined) yield { type: "usage", usage, semantics: "final" };
          const rawReason = incompleteReason(responseObject);
          const reason =
            type === "response.incomplete"
              ? mapIncompleteReason(rawReason)
              : sawToolCall
                ? "tool_calls"
                : sawRefusal
                  ? "refusal"
                  : "stop";
          terminal = true;
          const end: AdapterEvent = {
            type: "response_end",
            reason,
            state: responsesState(this.#transport.stateful || this.#transport.retainResponseId === true ? responseId : undefined, outputItems),
          };
          if (rawReason !== undefined) end.rawReason = rawReason;
          yield end;
          return;
        }

        if (type === "error" || type === "response.failed") {
          const rawError = asRecord(event.error) ?? asRecord(responseObject?.error) ?? event;
          throw new ProviderStreamError(
            asString(rawError.message) ?? "OpenAI response failed",
            asString(rawError.code) ?? asString(rawError.type),
            jsonValueOrString(event),
          );
        }

        if (isIgnorableResponsesEvent(type)) continue;
        yield { type: "unknown_provider_event", provider: this.id, raw: jsonValueOrString(event) };
      }

      if (!terminal) throw new PrematureStreamEndError("Responses stream ended before a terminal event");
    } catch (error) {
      if (!terminal) {
        if (
          allowEarlyEofRetry &&
          !partial &&
          !signal.aborted &&
          error instanceof PrematureStreamEndError
        ) {
          yield* this.#streamAttempt(request, signal, false);
          return;
        }
        terminal = true;
        yield { type: "error", error: normalizeError(this.id, error, { partial, signal, requestId, diagnostics }) };
      }
    }
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    if (this.#transport.listModels !== undefined) return this.#transport.listModels(signal);
    const headers = new Headers(this.#transport.headers);
    headers.set("accept", "application/json");
    await this.#transport.authorize(headers, signal);
    const response = await this.#transport.fetch(`${this.#transport.baseUrl}/models`, { headers, signal, redirect: "error" });
    await assertResponseOk(response);
    const body = await readJsonResponse(response);
    const data = asArray(asRecord(body)?.data);
    const observedAt = new Date().toISOString();
    return data.flatMap((entry): ModelInfo[] => {
      const model = asRecord(entry);
      const id = catalogId(model?.id);
      if (id === undefined) return [];
      const capabilities = unknownCapabilities(observedAt);
      const compatibility = baseModelCompatibility("openai-responses", capabilities.tools, observedAt);
      if (this.#transport.promptCache) {
        compatibility.cacheMode = modelEvidence("automatic", "configuration", observedAt);
        compatibility.cacheAffinity = modelEvidence("prefix", "configuration", observedAt);
        if (this.#transport.promptCacheRetention !== undefined) {
          compatibility.cacheTiers = modelEvidence([this.#transport.promptCacheRetention], "configuration", observedAt);
        }
      }
      if (this.#transport.stateful) {
        compatibility.sessionAffinity = modelEvidence("optional", "configuration", observedAt);
      }
      compatibility.deferredTools = this.#transport.deferredToolLoading
        ? openAIDeferredToolsCapability(id, observedAt)
        : modelEvidence("unknown", "configuration", observedAt);
      return [
        mergeModelCompatibility({
          id,
          provider: this.id,
          capabilities,
          metadata: jsonValueOrString(model),
        }, compatibility),
      ];
    });
  }
}

export async function* httpResponsesWireEvents(input: {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
  signal: AbortSignal;
  fetch: FetchLike;
  onResponse?: (diagnostics: ProviderResponseDiagnostics, requestId?: string) => void;
}): AsyncGenerator<ResponsesWireEvent> {
  const response = await input.fetch(input.url, {
    method: "POST",
    headers: input.headers,
    body: stringifyProviderJson(input.body),
    signal: input.signal,
    redirect: "error",
  });
  const requestId = requestIdFromHeaders(response.headers);
  const diagnostics = responseDiagnostics(response);
  await assertResponseOk(response);
  input.onResponse?.(diagnostics, requestId);
  for await (const sse of decodeSSE(requireBody(response))) {
    const wire: ResponsesWireEvent = {
      data: sse.data,
      ...(sse.event === undefined ? {} : { event: sse.event }),
      ...(requestId === undefined ? {} : { requestId }),
      diagnostics,
    };
    if (wasSseEventDispatchedAtEof(sse)) eofResponsesWireEvents.add(wire);
    yield wire;
  }
}

export class OpenAIResponsesAdapter extends ResponsesAdapter {
  constructor(config: OpenAIResponsesConfig) {
    const fetchImplementation = config.fetch ?? globalThis.fetch;
    const baseUrl = trimSlash(config.baseUrl ?? "https://api.openai.com/v1");
    assertSecureEndpoint(baseUrl, "OpenAI base URL");
    if (config.deferredToolLoading !== undefined && typeof config.deferredToolLoading !== "boolean") {
      throw new TypeError("OpenAI deferredToolLoading must be a boolean");
    }
    super("openai", {
      baseUrl,
      headers: config.headers,
      fetch: fetchImplementation,
      authorize: async (headers, signal) => {
        const token = (await resolveToken(config.accessToken, signal)) ?? (await resolveToken(config.apiKey, signal));
        if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
        if (config.organization !== undefined) headers.set("openai-organization", config.organization);
        if (config.project !== undefined) headers.set("openai-project", config.project);
      },
      ...(baseUrl === "https://api.openai.com/v1"
        ? {
            streamEvents: createOpenAISdkEventStream({
              baseUrl,
              fetch: fetchImplementation,
              fallback: httpResponsesWireEvents,
              eventFromValue: responsesWireEventFromValue,
            }),
          }
        : {}),
      stateful: config.store ?? false,
      promptCache: true,
      deferredToolLoading: config.deferredToolLoading ?? baseUrl === "https://api.openai.com/v1",
      ...(config.promptCacheOptions === undefined
        ? {}
        : { promptCacheOptions: openAIPromptCacheOptions(config.promptCacheOptions) }),
      ...(config.promptCacheRetention === undefined
        ? {}
        : { promptCacheRetention: promptCacheRetention(config.promptCacheRetention) }),
      ...(config.serviceTier === undefined ? {} : { serviceTier: openAIServiceTier(config.serviceTier) }),
    });
  }
}

export class AzureOpenAIResponsesAdapter extends ResponsesAdapter {
  constructor(config: AzureOpenAIResponsesConfig) {
    const fetchImplementation = config.fetch ?? globalThis.fetch;
    const baseUrl = trimSlash(azureV1Base(config.endpoint));
    assertSecureEndpoint(baseUrl, "Azure OpenAI endpoint");
    super("azure-openai", {
      baseUrl,
      headers: config.headers,
      fetch: fetchImplementation,
      authorize: async (headers, signal) => {
        const accessToken = await resolveToken(config.accessToken, signal);
        if (accessToken !== undefined) {
          headers.set("authorization", `Bearer ${accessToken}`);
          return;
        }
        const apiKey = await resolveToken(config.apiKey, signal);
        if (apiKey !== undefined) headers.set("api-key", apiKey);
      },
      ...(config.deploymentName === undefined
        ? {}
        : {
            buildBody: (request) => buildResponsesBody(
              { ...request, model: config.deploymentName! },
              config.store ?? false,
              false,
            ),
          }),
      streamEvents: createAzureOpenAISdkEventStream({
        baseUrl,
        apiVersion: config.apiVersion ?? "v1",
        fetch: fetchImplementation,
        eventFromValue: responsesWireEventFromValue,
      }),
      stateful: config.store ?? false,
      promptCache: false,
      deferredToolLoading: false,
    });
  }
}

export function buildResponsesBody(
  request: ProviderRequest,
  stateful: boolean,
  promptCache: boolean,
  retention?: "in-memory" | "24h",
  serviceTier?: OpenAIServiceTier,
  cacheOptions?: OpenAIPromptCacheOptions,
  deferredToolLoading = false,
): Record<string, unknown> {
  request = providerWireRequest(request, request.providerState?.kind === "openai_responses");
  const compatibility = request.modelSettings?.compatibility;
  const body: Record<string, unknown> = {
    model: request.model,
    input: buildResponsesInput(request, compatibility?.supportsDeveloperRole === true),
    stream: true,
    store: stateful,
  };
  if (!stateful) body.include = ["reasoning.encrypted_content"];
  if (request.maxOutputTokens !== undefined) body.max_output_tokens = request.maxOutputTokens;
  if (request.reasoningEffort !== undefined) body.reasoning = { effort: request.reasoningEffort };
  if (request.tools.length > 0) {
    const supportsToolSearch = compatibility?.supportsToolSearch ?? (
      deferredToolLoading && request.provider === "openai" && openAIDeferredToolsSupported(request.model)
    );
    const useDeferredTools = supportsToolSearch &&
      request.tools.some((tool) => tool.loading === "deferred");
    const tools = request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false,
      ...(useDeferredTools && tool.loading === "deferred" ? { defer_loading: true } : {}),
    }));
    body.tools = useDeferredTools ? [...tools, { type: "tool_search" }] : tools;
  }
  if (request.metadata !== undefined) body.metadata = request.metadata;
  if (promptCache && request.sessionId !== undefined && request.sessionId !== "") {
    body.prompt_cache_key = promptCacheKey(request.sessionId);
  }
  if (promptCache && cacheOptions !== undefined) {
    body.prompt_cache_options = { ttl: cacheOptions.ttl };
  }
  // Current wire values: https://developers.openai.com/api/docs/guides/prompt-caching#prompt-cache-retention
  // The API uses an underscore even though the harness setting uses the more
  // readable `in-memory` spelling.
  if (
    promptCache &&
    retention !== undefined &&
    !(retention === "24h" && compatibility?.supportsLongCacheRetention === false)
  ) {
    body.prompt_cache_retention = retention === "in-memory" ? "in_memory" : retention;
  }
  if (serviceTier !== undefined) body.service_tier = serviceTier;
  const state = request.providerState?.kind === "openai_responses" ? request.providerState : undefined;
  if (stateful && state?.previousResponseId !== undefined) body.previous_response_id = state.previousResponseId;
  return body;
}

function openAIPromptCacheOptions(value: unknown): OpenAIPromptCacheOptions {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("OpenAI promptCacheOptions must be an object");
  }
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => key !== "ttl");
  if (unknown.length > 0) {
    throw new TypeError(`OpenAI promptCacheOptions contains unknown keys: ${unknown.join(", ")}`);
  }
  if (input.ttl !== "30m") throw new TypeError("OpenAI promptCacheOptions.ttl must be 30m");
  return { ttl: "30m" };
}

function promptCacheRetention(value: string): "in-memory" | "24h" {
  if (value !== "in-memory" && value !== "24h") {
    throw new TypeError("OpenAI promptCacheRetention must be in-memory or 24h");
  }
  return value;
}

function openAIServiceTier(value: string): OpenAIServiceTier {
  if (value !== "auto" && value !== "default" && value !== "flex" && value !== "priority") {
    throw new TypeError("OpenAI serviceTier must be auto, default, flex, or priority");
  }
  return value;
}

function promptCacheKey(sessionId: string): string {
  const characters = Array.from(sessionId);
  if (characters.length <= 64) return sessionId;
  return createHash("sha256").update(sessionId).digest("hex");
}

function openAIDeferredToolsSupported(model: string): boolean {
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/u.exec(model);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 4);
}

function openAIDeferredToolsCapability(model: string, observedAt: string): ModelCapability {
  const recognized = /^gpt-\d+(?:\.\d+)?(?:-|$)/u.test(model);
  return modelEvidence(
    openAIDeferredToolsSupported(model) ? "supported" : recognized ? "unsupported" : "unknown",
    "maintained",
    observedAt,
  );
}

function buildResponsesInput(request: ProviderRequest, supportsDeveloperRole: boolean): unknown[] {
  const state = request.providerState?.kind === "openai_responses" ? request.providerState : undefined;
  const lastAssistant = findLastAssistant(request);
  if (state?.previousResponseId !== undefined && lastAssistant >= 0) {
    return request.messages.slice(lastAssistant + 1).flatMap((message) =>
      messageToResponsesItems(message, request.provider, supportsDeveloperRole));
  }
  if (state !== undefined && state.outputItems.length > 0 && lastAssistant >= 0) {
    return [
      ...request.messages.slice(0, lastAssistant).flatMap((message) =>
        messageToResponsesItems(message, request.provider, supportsDeveloperRole)),
      ...state.outputItems,
      ...request.messages.slice(lastAssistant + 1).flatMap((message) =>
        messageToResponsesItems(message, request.provider, supportsDeveloperRole)),
    ];
  }
  return request.messages.flatMap((message) =>
    messageToResponsesItems(message, request.provider, supportsDeveloperRole));
}

function messageToResponsesItems(
  message: ProviderRequest["messages"][number],
  provider: ProviderId,
  supportsDeveloperRole: boolean,
): unknown[] {
  const items: unknown[] = [];
  const text: string[] = [];
  const content: Array<Record<string, string>> = [];
  let hasImage = false;
  for (const block of message.content) {
    if (block.type === "text") {
      text.push(block.text);
      content.push({ type: "input_text", text: block.text });
    } else if (block.type === "image") {
      hasImage = true;
      content.push(responsesImageContent(block));
    } else if (block.type === "tool_result") {
      const output = (block.images?.length ?? 0) === 0
        ? toolResultText(block)
        : [
            { type: "input_text", text: toolResultText(block) },
            ...(block.images ?? []).map(responsesImageContent),
          ];
      items.push({ type: "function_call_output", call_id: block.callId, output });
    } else if (block.type === "tool_call") {
      items.push({
        type: "function_call",
        call_id: block.callId,
        name: block.name,
        arguments: stringifyProviderJson(block.arguments),
      });
    } else if (block.type === "provider_opaque" && block.provider === provider) {
      items.push(block.value);
    }
  }
  if (content.length > 0) {
    items.unshift({
      role: message.role === "tool"
        ? "user"
        : message.role === "system" && supportsDeveloperRole
          ? "developer"
          : message.role,
      content: hasImage ? content : text.join("\n"),
    });
  }
  return items;
}

function applyResponsesSessionHeaders(headers: Headers, request: ProviderRequest): void {
  if (
    request.sessionId === undefined ||
    request.sessionId === "" ||
    request.cacheRetention === "none"
  ) return;
  const format = request.modelSettings?.compatibility?.sessionAffinityFormat ?? "openai";
  if (format === "openrouter") {
    headers.set("x-session-id", request.sessionId);
    return;
  }
  if (format === "openai") headers.set("session_id", request.sessionId);
  headers.set("x-client-request-id", request.sessionId);
}

function responsesImageContent(block: ImageBlock): Record<string, string> {
  const source = normalizeImageSource(block, "OpenAI Responses");
  requireImageMediaType(source, "OpenAI Responses", ["image/jpeg", "image/png", "image/gif", "image/webp"]);
  requireImageUrlProtocol(source, "OpenAI Responses", ["http:", "https:"]);
  return {
    type: "input_image",
    image_url: source.kind === "url" ? source.url : `data:${source.mediaType};base64,${source.data}`,
  };
}

function findLastAssistant(request: ProviderRequest): number {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    if (request.messages[index]?.role === "assistant") return index;
  }
  return -1;
}

function findTool(
  tools: Map<string, ToolAccumulator>,
  event: Record<string, unknown>,
): { tool: ToolAccumulator; created: boolean } {
  const itemId = asString(event.item_id);
  const index = asNumber(event.output_index);
  for (const tool of tools.values()) {
    if ((itemId !== undefined && tool.itemId === itemId) || (index !== undefined && tool.index === index)) {
      return { tool, created: false };
    }
  }
  const tool: ToolAccumulator = { index: index ?? tools.size, arguments: "", ended: false };
  if (itemId !== undefined) tool.itemId = itemId;
  tools.set(itemId ?? `index:${tool.index}`, tool);
  return { tool, created: true };
}

function finishTool(tool: ToolAccumulator): AdapterEvent {
  tool.ended = true;
  const name = tool.name ?? "unknown_tool";
  const event: AdapterEvent = {
    type: "tool_call_end",
    index: tool.index,
    name,
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

function responsePartKeys(outputIndex: number | undefined, itemId: string | undefined, part: number): string[] {
  const keys: string[] = [];
  if (itemId !== undefined) keys.push(`item:${itemId}:${part}`);
  if (outputIndex !== undefined) keys.push(`output:${outputIndex}:${part}`);
  if (keys.length === 0) keys.push(`unscoped:${part}`);
  return keys;
}

function firstMappedPart<T>(parts: Map<string, T>, keys: string[]): T | undefined {
  for (const key of keys) {
    const part = parts.get(key);
    if (part !== undefined) return part;
  }
  return undefined;
}

function usageFromResponse(value: unknown): NormalizedUsage | undefined {
  const usage = asRecord(value);
  if (usage === undefined) return undefined;
  const inputDetails = asRecord(usage.input_tokens_details);
  const outputDetails = asRecord(usage.output_tokens_details);
  return normalizeUsage({
    raw: jsonValueOrString(usage),
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    reportedTotalTokens: usage.total_tokens,
    cacheReadTokens: inputDetails?.cached_tokens,
    cacheWriteTokens: inputDetails?.cache_write_tokens,
    reasoningTokens: outputDetails?.reasoning_tokens,
    inputIncludesCache: true,
  });
}

function responsesState(responseId: string | undefined, items: Map<number, JsonValue>): ProviderState {
  const state: Extract<ProviderState, { kind: "openai_responses" }> = {
    kind: "openai_responses",
    outputItems: [...items.entries()].sort(([left], [right]) => left - right).map(([, value]) => value),
  };
  if (responseId !== undefined) state.previousResponseId = responseId;
  return state;
}

function incompleteReason(response: Record<string, unknown> | undefined): string | undefined {
  return asString(asRecord(response?.incomplete_details)?.reason);
}

function mapIncompleteReason(reason: string | undefined): FinishReason {
  if (reason === "max_output_tokens") return "length";
  if (reason?.includes("context") === true) return "context_limit";
  if (reason?.includes("filter") === true) return "content_filter";
  return "incomplete";
}

function isIgnorableResponsesEvent(type: string): boolean {
  return (
    type.endsWith(".done") ||
    type === "response.metadata" ||
    type === "response.content_part.added" ||
    type === "response.content_part.done" ||
    type === "response.reasoning_summary_part.added"
  );
}

function isIgnorableCodexInformationalEvent(provider: ProviderId, type: string): boolean {
  return provider === "openai-codex" && (type === "codex.rate_limits" || type === "codex.response.metadata");
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError(`Malformed ${label}`, text);
  }
}

function unknownCapabilities(observedAt: string): ModelInfo["capabilities"] {
  const capability = { value: "unknown" as const, source: "provider" as const, observedAt };
  return { tools: capability, reasoning: capability, images: capability };
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function azureV1Base(endpoint: string): string {
  const trimmed = trimSlash(endpoint);
  return trimmed.endsWith("/openai/v1") ? trimmed : `${trimmed}/openai/v1`;
}
