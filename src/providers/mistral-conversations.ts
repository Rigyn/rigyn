import { createHash } from "node:crypto";

import type { JsonValue } from "../core/json.js";
import type {
  AdapterEvent,
  ImageBlock,
  ModelCapability,
  ModelInfo,
  NormalizedUsage,
  ProviderAdapter,
  ProviderRequest,
  ProviderState,
} from "../core/types.js";
import { catalogId, catalogLimit } from "./catalog.js";
import { normalizeImageSource, requireImageUrlProtocol } from "./images.js";
import { stringifyProviderJson } from "./json.js";
import { providerWireRequest } from "./messages.js";
import { requireBody } from "./lines.js";
import { decodeSSE } from "./sse.js";
import { toolResultText } from "./tool-results.js";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  assertResponseOk,
  assertSecureEndpoint,
  type FetchLike,
  InvalidProviderRequestError,
  jsonValueOrString,
  normalizeError,
  ProtocolError,
  ProviderStreamError,
  readJsonResponse,
  requestIdFromHeaders,
  resolveToken,
  type TokenSource,
} from "./transport.js";
import { normalizeUsage } from "./usage.js";
import {
  baseModelCompatibility,
  capabilityModalities,
  modelEvidence,
  providerReasoningEfforts,
} from "./model-metadata.js";

export interface MistralConversationsConfig {
  apiKey?: TokenSource;
  baseUrl?: string;
  headers?: HeadersInit;
  fetch?: FetchLike;
  /** Remote conversation persistence. Defaults to true. */
  store?: boolean;
  maxEventBytes?: number;
  maxStreamBytes?: number;
}

interface MessagePart {
  contentIndex: number;
  sequence: number;
  value: JsonValue;
}

interface MessageAccumulator {
  kind: "message";
  outputIndex: number;
  id: string;
  model?: string;
  agentId?: string;
  parts: MessagePart[];
}

interface FunctionAccumulator {
  kind: "function";
  outputIndex: number;
  entryId: string;
  callId: string;
  name: string;
  arguments: string;
}

interface ToolExecutionAccumulator {
  kind: "tool_execution";
  outputIndex: number;
  id: string;
  name: string;
  arguments: string;
  info?: JsonValue;
}

type OutputAccumulator = MessageAccumulator | FunctionAccumulator | ToolExecutionAccumulator;

const MAX_STREAM_OUTPUTS = 1_024;
const MAX_CONTENT_INDEX = 4_095;
const MAX_ID_BYTES = 4_096;
const DEFAULT_MAX_EVENT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_STREAM_BYTES = 128 * 1024 * 1024;

/** Direct adapter for Mistral's public, stateful Conversations endpoint. */
export class MistralConversationsAdapter implements ProviderAdapter {
  readonly id = "mistral" as const;
  readonly #baseUrl: string;
  readonly #token: TokenSource | undefined;
  readonly #headersInit: HeadersInit | undefined;
  readonly #fetch: FetchLike;
  readonly #store: boolean;
  readonly #maxEventBytes: number;
  readonly #maxStreamBytes: number;

  constructor(config: MistralConversationsConfig = {}) {
    const baseUrl = trimSlash(config.baseUrl ?? "https://api.mistral.ai/v1");
    assertSecureEndpoint(baseUrl, "Mistral Conversations base URL");
    this.#baseUrl = baseUrl;
    this.#token = config.apiKey;
    this.#headersInit = config.headers;
    this.#fetch = config.fetch ?? globalThis.fetch;
    this.#store = config.store ?? true;
    this.#maxEventBytes = boundedPositiveInteger(
      config.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES,
      "Mistral Conversations maxEventBytes",
      64 * 1024 * 1024,
    );
    this.#maxStreamBytes = boundedPositiveInteger(
      config.maxStreamBytes ?? DEFAULT_MAX_STREAM_BYTES,
      "Mistral Conversations maxStreamBytes",
      1024 * 1024 * 1024,
    );
    if (this.#maxStreamBytes < this.#maxEventBytes) {
      throw new TypeError("Mistral Conversations maxStreamBytes must be at least maxEventBytes");
    }
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    let partial = false;
    let terminal = false;
    let requestId: string | undefined;

    try {
      request = providerWireRequest(request, request.providerState?.kind === "mistral_conversations");
      const fingerprint = requestFingerprint(request);
      const previous = request.providerState?.kind === "mistral_conversations"
        ? request.providerState
        : undefined;
      const append = this.#store &&
        previous?.conversationId !== undefined &&
        previous.model === request.model &&
        previous.requestFingerprint === fingerprint;
      const inputs = buildInputs(request, previous, append);
      if (!append && inputs.length === 0) {
        throw new InvalidProviderRequestError("Mistral Conversations requires at least one non-system input entry");
      }

      const body = append
        ? buildAppendBody(inputs, this.#store, request)
        : buildStartBody(inputs, this.#store, request);
      const url = append
        ? `${this.#baseUrl}/conversations/${encodeConversationId(previous.conversationId!)}`
        : `${this.#baseUrl}/conversations`;
      const headers = await this.#headers();
      headers.set("content-type", "application/json");
      headers.set("accept", "text/event-stream");
      const response = await this.#fetch(url, {
        method: "POST",
        headers,
        body: stringifyProviderJson(body),
        signal,
        redirect: "error",
      });
      requestId = requestIdFromHeaders(response.headers);
      await assertResponseOk(response);

      let started = false;
      let done = false;
      let conversationId: string | undefined;
      const outputs = new Map<number, OutputAccumulator>();
      let sequence = 0;

      for await (const sse of decodeSSE(requireBody(response), {
        maxEventBytes: this.#maxEventBytes,
        maxStreamBytes: this.#maxStreamBytes,
      })) {
        if (sse.data.trim() === "[DONE]") {
          if (!done) throw new ProtocolError("Mistral Conversations emitted [DONE] before conversation.response.done");
          break;
        }
        const parsed = parseEventJson(sse.data);
        const data = asRecord(parsed);
        if (data === undefined) {
          throw new ProtocolError("Mistral Conversations event data was not an object", jsonValueOrString(parsed));
        }
        const type = asString(data.type);
        if (type === undefined || type === "") {
          throw new ProtocolError("Mistral Conversations event omitted its type", jsonValueOrString(data));
        }
        if (sse.event === undefined || sse.event === "") {
          throw new ProtocolError("Mistral Conversations SSE event omitted its event name", jsonValueOrString(data));
        }
        if (sse.event !== type) {
          throw new ProtocolError("Mistral Conversations SSE event name did not match its data type", jsonValueOrString(data));
        }
        if (done) throw new ProtocolError("Mistral Conversations emitted data after conversation.response.done");

        switch (type) {
          case "conversation.response.started": {
            if (started) throw new ProtocolError("Mistral Conversations emitted more than one response start");
            conversationId = requiredBoundedString(data.conversation_id, "conversation ID", MAX_ID_BYTES);
            started = true;
            const event: AdapterEvent = {
              type: "response_start",
              model: request.model,
              responseId: conversationId,
            };
            if (requestId !== undefined) event.requestId = requestId;
            yield event;
            break;
          }
          case "message.output.delta": {
            requireStarted(started, type);
            const outputIndex = boundedIndex(data.output_index, "output", MAX_STREAM_OUTPUTS - 1);
            const contentIndex = boundedIndex(data.content_index, "content", MAX_CONTENT_INDEX);
            const id = requiredBoundedString(data.id, "message entry ID", MAX_ID_BYTES);
            const accumulator = messageAccumulator(outputs, outputIndex, id, data);
            const content = messageContent(data.content);
            accumulator.parts.push({ contentIndex, sequence, value: content });
            sequence += 1;
            const emitted = emittedContent(content, contentIndex);
            for (const event of emitted.events) yield event;
            if (emitted.unknown) {
              yield { type: "unknown_provider_event", provider: this.id, raw: jsonValueOrString(data) };
            }
            if (emitted.events.length > 0 || emitted.unknown) partial = true;
            break;
          }
          case "function.call.delta": {
            requireStarted(started, type);
            const outputIndex = boundedIndex(data.output_index, "output", MAX_STREAM_OUTPUTS - 1);
            const entryId = requiredBoundedString(data.id, "function entry ID", MAX_ID_BYTES);
            const callId = requiredBoundedString(data.tool_call_id, "tool call ID", MAX_ID_BYTES);
            const name = requiredBoundedString(data.name, "tool name", 1_024);
            const fragment = asString(data.arguments);
            if (fragment === undefined) throw new ProtocolError("Mistral Conversations function arguments were not a string");
            const found = outputs.get(outputIndex);
            let accumulator: FunctionAccumulator;
            if (found === undefined) {
              accumulator = { kind: "function", outputIndex, entryId, callId, name, arguments: "" };
              outputs.set(outputIndex, accumulator);
              yield { type: "tool_call_start", index: outputIndex, id: callId, name };
            } else {
              if (found.kind !== "function") throw outputCollision(outputIndex);
              accumulator = found;
              if (accumulator.entryId !== entryId || accumulator.callId !== callId || accumulator.name !== name) {
                throw new ProtocolError(`Mistral Conversations function output ${outputIndex} changed identity while streaming`);
              }
            }
            accumulator.arguments += fragment;
            if (fragment !== "") yield { type: "tool_call_delta", index: outputIndex, jsonFragment: fragment };
            partial = true;
            break;
          }
          case "tool.execution.started":
          case "tool.execution.delta":
          case "tool.execution.done": {
            requireStarted(started, type);
            mergeToolExecution(outputs, data);
            partial = true;
            yield { type: "unknown_provider_event", provider: this.id, raw: jsonValueOrString(data) };
            break;
          }
          case "agent.handoff.started":
          case "agent.handoff.done": {
            requireStarted(started, type);
            partial = true;
            yield { type: "unknown_provider_event", provider: this.id, raw: jsonValueOrString(data) };
            break;
          }
          case "conversation.response.error": {
            requireStarted(started, type);
            const message = requiredBoundedString(data.message, "response error message", 16 * 1024);
            const code = stringCode(data.code);
            throw new ProviderStreamError(message, code, jsonValueOrString(data));
          }
          case "conversation.response.done": {
            requireStarted(started, type);
            done = true;
            for (const output of orderedOutputs(outputs)) {
              if (output.kind === "function") yield finishFunction(output);
            }
            const usage = conversationUsage(data.usage);
            if (usage !== undefined) yield { type: "usage", usage, semantics: "final" };
            const state: Extract<ProviderState, { kind: "mistral_conversations" }> = {
              kind: "mistral_conversations",
              model: request.model,
              requestFingerprint: fingerprint,
              outputs: orderedOutputs(outputs).map(outputEntry),
            };
            if (this.#store && conversationId !== undefined) state.conversationId = conversationId;
            terminal = true;
            yield {
              type: "response_end",
              reason: [...outputs.values()].some((output) => output.kind === "function") ? "tool_calls" : "stop",
              state,
              rawReason: type,
            };
            break;
          }
          default:
            requireStarted(started, type);
            partial = true;
            yield { type: "unknown_provider_event", provider: this.id, raw: jsonValueOrString(data) };
            break;
        }
        if (done) break;
      }

      if (!started) throw new ProtocolError("Mistral Conversations stream ended before conversation.response.started");
      if (!done) throw new ProtocolError("Mistral Conversations stream ended before conversation.response.done");
    } catch (error) {
      if (!terminal) {
        terminal = true;
        yield { type: "error", error: normalizeError(this.id, error, { partial, signal, requestId }) };
      }
    }
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    const headers = await this.#headers();
    headers.set("accept", "application/json");
    const response = await this.#fetch(`${this.#baseUrl}/models`, {
      method: "GET",
      headers,
      signal,
      redirect: "error",
    });
    await assertResponseOk(response);
    const body = asRecord(await readJsonResponse(response));
    const observedAt = new Date().toISOString();
    return asArray(body?.data).flatMap((entry): ModelInfo[] => {
      const model = asRecord(entry);
      const capabilities = asRecord(model?.capabilities);
      const id = catalogId(model?.id);
      if (id === undefined || model?.archived === true || capabilities?.completion_chat === false) return [];
      const modelCapabilities: ModelInfo["capabilities"] = {
        tools: booleanCapability(capabilities?.function_calling, observedAt),
        reasoning: unknownCapability(observedAt),
        images: booleanCapability(capabilities?.vision, observedAt),
      };
      const compatibility = baseModelCompatibility("mistral-conversations", modelCapabilities.tools, observedAt);
      const inputModalities = capabilityModalities(modelCapabilities.images, observedAt);
      const reasoningEfforts = providerReasoningEfforts(
        capabilities?.reasoning_efforts ?? model?.supported_reasoning_efforts,
        observedAt,
      );
      if (inputModalities !== undefined) compatibility.inputModalities = inputModalities;
      if (reasoningEfforts !== undefined) compatibility.reasoningEfforts = reasoningEfforts;
      if (this.#store) compatibility.sessionAffinity = modelEvidence("optional", "configuration", observedAt);
      const info: ModelInfo = {
        id,
        provider: this.id,
        capabilities: modelCapabilities,
        compatibility,
        metadata: jsonValueOrString(model),
      };
      const displayName = asString(model?.name);
      const contextTokens = catalogLimit(model?.max_context_length);
      if (displayName !== undefined) info.displayName = displayName;
      if (contextTokens !== undefined) info.contextTokens = contextTokens;
      return [info];
    });
  }

  /** Deletes explicitly selected remote state; normal adapter shutdown intentionally preserves resumability. */
  async deleteConversation(conversationId: string, signal: AbortSignal): Promise<void> {
    const headers = await this.#headers();
    headers.set("accept", "application/json");
    const response = await this.#fetch(
      `${this.#baseUrl}/conversations/${encodeConversationId(conversationId)}`,
      { method: "DELETE", headers, signal, redirect: "error" },
    );
    await assertResponseOk(response);
  }

  async #headers(): Promise<Headers> {
    const headers = new Headers(this.#headersInit);
    const token = await resolveToken(this.#token);
    if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
    return headers;
  }
}

function buildStartBody(inputs: JsonValue[], store: boolean, request: ProviderRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    inputs,
    stream: true,
    store,
  };
  const instructions = systemInstructions(request);
  if (instructions !== "") body.instructions = instructions;
  if (request.tools.length > 0) body.tools = functionTools(request);
  const completionArgs = completionArguments(request);
  if (Object.keys(completionArgs).length > 0) body.completion_args = completionArgs;
  if (request.metadata !== undefined) body.metadata = request.metadata;
  return body;
}

function buildAppendBody(inputs: JsonValue[], store: boolean, request: ProviderRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { inputs, stream: true, store };
  const completionArgs = completionArguments(request);
  if (Object.keys(completionArgs).length > 0) body.completion_args = completionArgs;
  return body;
}

function functionTools(request: ProviderRequest): unknown[] {
  return request.tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false,
    },
  }));
}

function completionArguments(request: ProviderRequest): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (request.maxOutputTokens !== undefined) args.max_tokens = request.maxOutputTokens;
  if (request.reasoningEffort !== undefined) {
    args.reasoning_effort = ["off", "none"].includes(request.reasoningEffort) ? "none" : "high";
  }
  return args;
}

function systemInstructions(request: ProviderRequest): string {
  const text: string[] = [];
  for (const message of request.messages) {
    if (message.role !== "system") continue;
    for (const block of message.content) {
      if (block.type !== "text") {
        throw new InvalidProviderRequestError("Mistral Conversations supports only text in system messages");
      }
      text.push(block.text);
    }
  }
  return text.join("\n");
}

function requestFingerprint(request: ProviderRequest): string {
  return createHash("sha256").update(stringifyProviderJson({
    model: request.model,
    instructions: systemInstructions(request),
    tools: functionTools(request),
  })).digest("hex");
}

function buildInputs(
  request: ProviderRequest,
  state: Extract<ProviderState, { kind: "mistral_conversations" }> | undefined,
  append: boolean,
): JsonValue[] {
  const lastAssistant = findLastAssistant(request);
  if (append) {
    const start = lastAssistant < 0 ? 0 : lastAssistant + 1;
    return request.messages.slice(start).flatMap(messageToEntries);
  }
  if (state !== undefined && state.outputs.length > 0 && lastAssistant >= 0) {
    return [
      ...request.messages.slice(0, lastAssistant).flatMap(messageToEntries),
      ...state.outputs,
      ...request.messages.slice(lastAssistant + 1).flatMap(messageToEntries),
    ];
  }
  return request.messages.flatMap(messageToEntries);
}

function messageToEntries(message: ProviderRequest["messages"][number]): JsonValue[] {
  if (message.role === "system") return [];
  const entries: JsonValue[] = [];
  let chunks: JsonValue[] = [];
  const role = message.role === "assistant" ? "assistant" : "user";
  const flush = (): void => {
    if (chunks.length === 0) return;
    entries.push({ object: "entry", type: "message.input", role, content: chunks });
    chunks = [];
  };

  for (const block of message.content) {
    if (block.type === "text") {
      chunks.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "image") {
      chunks.push(imageChunk(block));
      continue;
    }
    if (block.type === "tool_call") {
      flush();
      entries.push({
        object: "entry",
        type: "function.call",
        tool_call_id: block.callId,
        name: block.name,
        arguments: block.arguments,
      });
      continue;
    }
    if (block.type === "tool_result") {
      flush();
      const result = toolResultText(block);
      entries.push({
        object: "entry",
        type: "function.result",
        tool_call_id: block.callId,
        result: block.isError ? `[Tool error] ${result}` : result,
      });
      if ((block.images?.length ?? 0) > 0) {
        entries.push({
          object: "entry",
          type: "message.input",
          role: "user",
          content: [
            { type: "text", text: `Image output from tool ${block.name}.` },
            ...(block.images ?? []).map(imageChunk),
          ],
        });
      }
      continue;
    }
    if (block.type === "provider_opaque" && block.provider === "mistral") {
      flush();
      entries.push(block.value);
    }
  }
  flush();
  return entries;
}

function imageChunk(block: ImageBlock): JsonValue {
  const source = normalizeImageSource(block, "Mistral Conversations");
  requireImageUrlProtocol(source, "Mistral Conversations", ["http:", "https:"]);
  return {
    type: "image_url",
    image_url: source.kind === "url" ? source.url : `data:${source.mediaType};base64,${source.data}`,
  };
}

function findLastAssistant(request: ProviderRequest): number {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    if (request.messages[index]?.role === "assistant") return index;
  }
  return -1;
}

function messageAccumulator(
  outputs: Map<number, OutputAccumulator>,
  outputIndex: number,
  id: string,
  data: Record<string, unknown>,
): MessageAccumulator {
  const found = outputs.get(outputIndex);
  if (found !== undefined) {
    if (found.kind !== "message") throw outputCollision(outputIndex);
    if (found.id !== id) throw new ProtocolError(`Mistral Conversations message output ${outputIndex} changed ID`);
    return found;
  }
  const accumulator: MessageAccumulator = { kind: "message", outputIndex, id, parts: [] };
  const model = asString(data.model);
  const agentId = asString(data.agent_id);
  if (model !== undefined) accumulator.model = model;
  if (agentId !== undefined) accumulator.agentId = agentId;
  outputs.set(outputIndex, accumulator);
  return accumulator;
}

function messageContent(value: unknown): JsonValue {
  if (typeof value === "string") return { type: "text", text: value };
  const content = asRecord(value);
  if (content === undefined || asString(content.type) === undefined) {
    throw new ProtocolError("Mistral Conversations message content was invalid", jsonValueOrString(value));
  }
  return jsonValueOrString(content);
}

function emittedContent(content: JsonValue, part: number): { events: AdapterEvent[]; unknown: boolean } {
  const record = asRecord(content);
  if (record === undefined) return { events: [], unknown: true };
  if (record.type === "text") {
    const text = asString(record.text);
    if (text === undefined) throw new ProtocolError("Mistral Conversations text chunk omitted text", content);
    return { events: text === "" ? [] : [{ type: "text_delta", part, text }], unknown: false };
  }
  if (record.type === "thinking") {
    const events: AdapterEvent[] = [];
    for (const item of asArray(record.thinking)) {
      const chunk = asRecord(item);
      if (chunk?.type !== "text") continue;
      const text = asString(chunk.text);
      if (text === undefined) throw new ProtocolError("Mistral Conversations thinking text chunk omitted text", content);
      if (text !== "") events.push({ type: "reasoning_delta", part, text, visibility: "provider_trace" });
    }
    return { events, unknown: false };
  }
  return { events: [], unknown: true };
}

function mergeToolExecution(outputs: Map<number, OutputAccumulator>, data: Record<string, unknown>): void {
  const outputIndex = boundedIndex(data.output_index, "output", MAX_STREAM_OUTPUTS - 1);
  const id = requiredBoundedString(data.id, "tool execution ID", MAX_ID_BYTES);
  const name = requiredBoundedString(data.name, "tool execution name", 1_024);
  const found = outputs.get(outputIndex);
  let accumulator: ToolExecutionAccumulator;
  if (found === undefined) {
    accumulator = { kind: "tool_execution", outputIndex, id, name, arguments: "" };
    outputs.set(outputIndex, accumulator);
  } else {
    if (found.kind !== "tool_execution") throw outputCollision(outputIndex);
    accumulator = found;
    if (accumulator.id !== id || accumulator.name !== name) {
      throw new ProtocolError(`Mistral Conversations tool execution output ${outputIndex} changed identity`);
    }
  }
  const fragment = asString(data.arguments);
  if (fragment !== undefined) accumulator.arguments += fragment;
  if (data.info !== undefined) accumulator.info = jsonValueOrString(data.info);
}

function finishFunction(output: FunctionAccumulator): AdapterEvent {
  const event: AdapterEvent = {
    type: "tool_call_end",
    index: output.outputIndex,
    id: output.callId,
    name: output.name,
    rawArguments: output.arguments,
  };
  try {
    event.arguments = jsonValueOrString(JSON.parse(output.arguments === "" ? "{}" : output.arguments));
  } catch (error) {
    event.parseError = error instanceof Error ? error.message : String(error);
  }
  return event;
}

function outputEntry(output: OutputAccumulator): JsonValue {
  if (output.kind === "message") {
    return {
      object: "entry",
      type: "message.output",
      id: output.id,
      role: "assistant",
      content: output.parts
        .sort((left, right) => left.contentIndex - right.contentIndex || left.sequence - right.sequence)
        .map((part) => part.value),
      ...(output.model === undefined ? {} : { model: output.model }),
      ...(output.agentId === undefined ? {} : { agent_id: output.agentId }),
    };
  }
  if (output.kind === "function") {
    let argumentsValue: JsonValue = output.arguments;
    try {
      argumentsValue = jsonValueOrString(JSON.parse(output.arguments === "" ? "{}" : output.arguments));
    } catch {
      // The public schema also permits an argument string.
    }
    return {
      object: "entry",
      type: "function.call",
      id: output.entryId,
      tool_call_id: output.callId,
      name: output.name,
      arguments: argumentsValue,
    };
  }
  return {
    object: "entry",
    type: "tool.execution",
    id: output.id,
    name: output.name,
    arguments: output.arguments,
    ...(output.info === undefined ? {} : { info: output.info }),
  };
}

function orderedOutputs(outputs: ReadonlyMap<number, OutputAccumulator>): OutputAccumulator[] {
  return [...outputs.values()].sort((left, right) => left.outputIndex - right.outputIndex);
}

function conversationUsage(value: unknown): NormalizedUsage | undefined {
  const usage = asRecord(value);
  if (usage === undefined) return undefined;
  const details = asRecord(usage.prompt_tokens_details);
  return normalizeUsage({
    raw: jsonValueOrString(usage),
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    reportedTotalTokens: usage.total_tokens,
    cacheReadTokens: details?.cached_tokens,
    cacheWriteTokens: details?.cache_write_tokens,
    inputIncludesCache: true,
  });
}

function booleanCapability(value: unknown, observedAt: string): ModelCapability {
  return typeof value === "boolean"
    ? { value: value ? "supported" : "unsupported", source: "provider", observedAt }
    : unknownCapability(observedAt);
}

function unknownCapability(observedAt: string): ModelCapability {
  return { value: "unknown", source: "provider", observedAt };
}

function parseEventJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError("Malformed Mistral Conversations SSE event", text.slice(0, 4_096));
  }
}

function boundedIndex(value: unknown, label: string, maximum: number): number {
  const number = asNumber(value);
  if (number === undefined || !Number.isSafeInteger(number) || number < 0 || number > maximum) {
    throw new ProtocolError(`Mistral Conversations ${label} index must be an integer from 0 to ${maximum}`);
  }
  return number;
}

function requiredBoundedString(value: unknown, label: string, maxBytes: number): string {
  const text = asString(value);
  if (text === undefined || text === "" || text.includes("\0") || Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new ProtocolError(`Mistral Conversations ${label} was invalid`);
  }
  return text;
}

function encodeConversationId(value: string): string {
  if (value === "" || value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_ID_BYTES) {
    throw new InvalidProviderRequestError("Mistral Conversations conversation ID was invalid");
  }
  return encodeURIComponent(value);
}

function outputCollision(index: number): ProtocolError {
  return new ProtocolError(`Mistral Conversations output ${index} changed type while streaming`);
}

function requireStarted(started: boolean, type: string): void {
  if (!started) throw new ProtocolError(`Mistral Conversations ${type} arrived before conversation.response.started`);
}

function stringCode(value: unknown): string | undefined {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function boundedPositiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}
