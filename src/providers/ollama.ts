import type { JsonValue } from "../core/json.js";
import type {
  AdapterEvent,
  FinishReason,
  ModelCapability,
  ModelInfo,
  NormalizedUsage,
  ProviderAdapter,
  ProviderRequest,
  ProviderState,
} from "../core/types.js";
import { catalogId, catalogLimit } from "./catalog.js";
import { decodeNDJSON } from "./ndjson.js";
import { normalizeImageSource, unsupportedImageUrl } from "./images.js";
import { stringifyProviderJson } from "./json.js";
import { providerWireRequest } from "./messages.js";
import { requireBody } from "./lines.js";
import { toolResultText } from "./tool-results.js";
import { normalizeUsage } from "./usage.js";
import { baseModelCompatibility, capabilityModalities } from "./model-metadata.js";
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
  requestIdFromHeaders,
  readJsonResponse,
  resolveToken,
  type TokenSource,
} from "./transport.js";

export interface OllamaConfig {
  host?: string;
  apiKey?: TokenSource;
  headers?: HeadersInit;
  fetch?: FetchLike;
}

interface OllamaTool {
  index: number;
  id?: string;
  name: string;
  arguments: JsonValue;
}

export class OllamaAdapter implements ProviderAdapter {
  readonly id = "ollama" as const;
  readonly #host: string;
  readonly #apiKey: TokenSource | undefined;
  readonly #headersInit: HeadersInit | undefined;
  readonly #fetch: FetchLike;

  constructor(config: OllamaConfig = {}) {
    this.#host = trimSlash(config.host ?? "http://127.0.0.1:11434");
    assertSecureEndpoint(this.#host, "Ollama host");
    this.#apiKey = config.apiKey;
    this.#headersInit = config.headers;
    this.#fetch = config.fetch ?? globalThis.fetch;
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    let partial = false;
    let terminal = false;
    let requestId: string | undefined;

    try {
      const headers = await this.#headers(signal);
      headers.set("content-type", "application/json");
      headers.set("accept", "application/x-ndjson");
      const response = await this.#fetch(`${this.#host}/api/chat`, {
        method: "POST",
        headers,
        body: stringifyProviderJson(buildOllamaBody(request)),
        signal,
        redirect: "error",
      });
      requestId = requestIdFromHeaders(response.headers);
      await assertResponseOk(response);

      let started = false;
      let content = "";
      let thinking = "";
      let rawReason: string | undefined;
      const tools = new Map<number, OllamaTool>();

      for await (const value of decodeNDJSON(requireBody(response))) {
        const chunk = asRecord(value);
        if (chunk === undefined) throw new ProtocolError("Ollama stream item was not an object", value);
        if (typeof chunk.error === "string") {
          throw new ProviderStreamError(chunk.error, "ollama_stream_error", value);
        }

        const model = asString(chunk.model) ?? request.model;
        if (!started) {
          started = true;
          const start: AdapterEvent = { type: "response_start", model };
          if (requestId !== undefined) start.requestId = requestId;
          yield start;
        }

        const message = asRecord(chunk.message);
        const thinkingDelta = asString(message?.thinking) ?? "";
        if (thinkingDelta !== "") {
          thinking += thinkingDelta;
          partial = true;
          yield { type: "reasoning_delta", part: 0, text: thinkingDelta, visibility: "provider_trace" };
        }
        const text = asString(message?.content) ?? "";
        if (text !== "") {
          content += text;
          partial = true;
          yield { type: "text_delta", part: 0, text };
        }

        for (const callValue of asArray(message?.tool_calls)) {
          const call = asRecord(callValue);
          const fn = asRecord(call?.function);
          if (fn === undefined) {
            yield { type: "unknown_provider_event", provider: this.id, raw: jsonValueOrString(callValue) };
            continue;
          }
          const index = asNumber(fn.index) ?? asNumber(call?.index) ?? tools.size;
          if (tools.has(index)) continue;
          const name = asString(fn.name) ?? "unknown_tool";
          const argumentsValue = jsonValueOrString(fn.arguments ?? {});
          const tool: OllamaTool = { index, name, arguments: argumentsValue };
          const id = asString(call?.id);
          if (id !== undefined) tool.id = id;
          tools.set(index, tool);
          partial = true;
          const start: AdapterEvent = { type: "tool_call_start", index, name };
          if (id !== undefined) start.id = id;
          yield start;
          const rawArguments = stringifyProviderJson(argumentsValue);
          yield { type: "tool_call_delta", index, jsonFragment: rawArguments };
          const end: AdapterEvent = {
            type: "tool_call_end",
            index,
            name,
            rawArguments,
            arguments: argumentsValue,
          };
          if (id !== undefined) end.id = id;
          yield end;
        }

        if (chunk.done === true) {
          rawReason = asString(chunk.done_reason);
          const usage = ollamaUsage(chunk);
          if (usage !== undefined) yield { type: "usage", usage, semantics: "final" };
          terminal = true;
          const end: AdapterEvent = {
            type: "response_end",
            reason: mapOllamaFinish(rawReason, tools.size > 0),
            state: ollamaState(content, thinking, tools),
          };
          if (rawReason !== undefined) end.rawReason = rawReason;
          yield end;
          return;
        }
      }

      if (!terminal) throw new ProtocolError("Ollama stream ended without done: true");
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
    const response = await this.#fetch(`${this.#host}/api/tags`, { headers, signal, redirect: "error" });
    await assertResponseOk(response);
    const body = await readJsonResponse(response);
    const observedAt = new Date().toISOString();
    const entries = asArray(asRecord(body)?.models).flatMap((entry): Array<{ id: string; model: Record<string, unknown> }> => {
      const model = asRecord(entry);
      const id = catalogId(model?.model) ?? catalogId(model?.name);
      return id === undefined || model === undefined ? [] : [{ id, model }];
    });
    const models: ModelInfo[] = [];
    for (let index = 0; index < entries.length; index += 8) {
      const batch = entries.slice(index, index + 8);
      const resolved = await Promise.all(batch.map((entry) => this.#modelInfo(entry.id, entry.model, observedAt, signal)));
      models.push(...resolved.filter((entry): entry is ModelInfo => entry !== undefined));
    }
    return models;
  }

  async #modelInfo(
    id: string,
    listEntry: Record<string, unknown> | undefined,
    observedAt: string,
    signal: AbortSignal,
  ): Promise<ModelInfo | undefined> {
    let show: Record<string, unknown> | undefined;
    try {
      const headers = await this.#headers(signal);
      headers.set("content-type", "application/json");
      const response = await this.#fetch(`${this.#host}/api/show`, {
        method: "POST",
        headers,
        body: stringifyProviderJson({ model: id }),
        signal,
        redirect: "error",
      });
      await assertResponseOk(response);
      show = asRecord(await readJsonResponse(response));
    } catch (error) {
      if (signal.aborted) throw error;
    }
    const metadata: Record<string, JsonValue> = { list: jsonValueOrString(listEntry ?? {}) };
    if (show !== undefined) metadata.show = jsonValueOrString(show);
    const capabilities = asArray(show?.capabilities).filter((value): value is string => typeof value === "string");
    if (capabilities.length > 0 && !capabilities.includes("completion")) return undefined;
    const info: ModelInfo = {
      id,
      provider: this.id,
      capabilities: ollamaCapabilities(show, observedAt),
      metadata,
    };
    info.compatibility = baseModelCompatibility("ollama-chat", info.capabilities.tools, observedAt);
    const inputModalities = capabilityModalities(info.capabilities.images, observedAt);
    if (inputModalities !== undefined) info.compatibility.inputModalities = inputModalities;
    const contextTokens = ollamaContextTokens(show);
    if (contextTokens !== undefined) info.contextTokens = contextTokens;
    return info;
  }

  async #headers(signal: AbortSignal): Promise<Headers> {
    const headers = new Headers(this.#headersInit);
    const apiKey = await resolveToken(this.#apiKey, signal);
    if (apiKey !== undefined) headers.set("authorization", `Bearer ${apiKey}`);
    return headers;
  }
}

function buildOllamaBody(request: ProviderRequest): Record<string, unknown> {
  request = providerWireRequest(request, request.providerState?.kind === "ollama_chat");
  const body: Record<string, unknown> = {
    model: request.model,
    messages: buildOllamaMessages(request),
    stream: true,
  };
  if (request.maxOutputTokens !== undefined) body.options = { num_predict: request.maxOutputTokens };
  if (request.reasoningEffort !== undefined) {
    body.think = request.reasoningEffort === "none" ? false : request.reasoningEffort;
  }
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    }));
  }
  return body;
}

function buildOllamaMessages(request: ProviderRequest): unknown[] {
  const state = request.providerState?.kind === "ollama_chat" ? request.providerState : undefined;
  const lastAssistant = findLastAssistant(request);
  return request.messages.flatMap((message, index): unknown[] => {
    if (state !== undefined && index === lastAssistant) return [state.assistantMessage];
    const results = message.content.filter((block) => block.type === "tool_result");
    const imageBlocks = [
      ...message.content.filter((block) => block.type === "image"),
      ...results.flatMap((block) => block.images ?? []),
    ];
    const images = imageBlocks.map((block) => {
      const source = normalizeImageSource(block, "Ollama");
      if (source.kind === "url") return unsupportedImageUrl("Ollama", source.url);
      return source.data;
    });
    if (results.length > 0) {
      const output: unknown[] = results.map((result) => ({
        role: "tool",
        tool_name: result.name,
        content: toolResultText(result),
      }));
      if (images.length > 0) output.push({ role: "user", content: "", images });
      return output;
    }
    const output: Record<string, unknown> = {
      role: message.role,
      content: message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"),
    };
    if (images.length > 0) output.images = images;
    const calls = message.content.filter((block) => block.type === "tool_call");
    if (calls.length > 0) {
      output.tool_calls = calls.map((call) => ({
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }));
    }
    return [output];
  });
}

function findLastAssistant(request: ProviderRequest): number {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    if (request.messages[index]?.role === "assistant") return index;
  }
  return -1;
}

function ollamaState(
  content: string,
  thinking: string,
  tools: Map<number, OllamaTool>,
): ProviderState {
  const message: Record<string, JsonValue> = { role: "assistant", content };
  if (thinking !== "") message.thinking = thinking;
  if (tools.size > 0) {
    message.tool_calls = [...tools.values()]
      .sort((left, right) => left.index - right.index)
      .map((tool) => ({
        type: "function",
        function: { name: tool.name, arguments: tool.arguments, index: tool.index },
      }));
  }
  return { kind: "ollama_chat", assistantMessage: message };
}

function ollamaUsage(chunk: Record<string, unknown>): NormalizedUsage | undefined {
  const normalized = normalizeUsage({
    raw: jsonValueOrString(chunk),
    inputTokens: chunk.prompt_eval_count,
    outputTokens: chunk.eval_count,
  });
  const duration = asNumber(chunk.total_duration);
  if (duration !== undefined) normalized.durationMs = duration / 1_000_000;
  return Object.keys(normalized).length === 1 ? undefined : normalized;
}

function mapOllamaFinish(reason: string | undefined, sawTools: boolean): FinishReason {
  if (sawTools) return "tool_calls";
  if (reason === "stop") return "stop";
  if (reason === "length") return "length";
  return reason === undefined ? "unknown" : "unknown";
}

function ollamaCapabilities(
  show: Record<string, unknown> | undefined,
  observedAt: string,
): ModelInfo["capabilities"] {
  const capabilities = asArray(show?.capabilities).filter((value): value is string => typeof value === "string");
  return {
    tools: capability(capabilities.includes("tools"), capabilities.length > 0, observedAt),
    reasoning: capability(capabilities.includes("thinking"), capabilities.length > 0, observedAt),
    images: capability(capabilities.includes("vision"), capabilities.length > 0, observedAt),
  };
}

function ollamaContextTokens(show: Record<string, unknown> | undefined): number | undefined {
  const modelInfo = asRecord(show?.model_info);
  if (modelInfo === undefined) return undefined;
  const architecture = catalogId(modelInfo["general.architecture"]);
  const direct = architecture === undefined ? undefined : catalogLimit(modelInfo[`${architecture}.context_length`]);
  if (direct !== undefined) return direct;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith(".context_length")) {
      const contextTokens = catalogLimit(value);
      if (contextTokens !== undefined) return contextTokens;
    }
  }
  return undefined;
}

function capability(supported: boolean, known: boolean, observedAt: string): ModelCapability {
  return { value: known ? (supported ? "supported" : "unsupported") : "unknown", source: "provider", observedAt };
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
