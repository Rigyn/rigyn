import { isDeepStrictEqual } from "node:util";
import { isJsonValue, type JsonValue } from "../core/json.js";
import { canonicalAssistantContent } from "../core/public-assistant-content.js";
import type {
  AdapterEvent,
  FinishReason,
  ModelCapability,
  ModelCompatibility,
  ModelInfo,
  ModelPricing,
  NormalizedUsage,
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  ProviderResponseDiagnostics,
  ProviderState,
} from "../core/types.js";
import { requireBody } from "./lines.js";
import { sanitizeUnicode, stringifyProviderJson } from "./json.js";
import { providerWireRequest } from "./messages.js";
import { modelEvidence } from "./model-metadata.js";
import { decodeSSE } from "./sse.js";
import { toolResultText } from "./tool-results.js";
import {
  asRecord,
  assertResponseOk,
  assertSecureEndpoint,
  type FetchLike,
  InvalidProviderRequestError,
  jsonValueOrString,
  normalizeError,
  PrematureStreamEndError,
  ProtocolError,
  requestIdFromHeaders,
  responseDiagnostics,
  readJsonResponse,
  resolveToken,
  type TokenSource,
} from "./transport.js";
import { normalizeUsage } from "./usage.js";

export type GatewayCacheRetention = "none" | "short" | "long";
export type GatewayToolChoice = "auto" | "none" | "required";

export interface GatewayMessagesConfig {
  id: ProviderId;
  /** Versioned gateway root. Discovery is requested from `<gatewayUrl>/config`. */
  gatewayUrl: string;
  accessToken: TokenSource;
  cacheRetention?: GatewayCacheRetention;
  toolChoice?: GatewayToolChoice;
  temperature?: number;
  fetch?: FetchLike;
}

interface GatewayCatalog {
  baseUrl: string;
  models: GatewayCatalogModel[];
}

interface GatewayCatalogModel {
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input: Array<"text" | "image">;
  cost: GatewayCost;
  contextWindow: number;
  maxTokens: number;
}

interface GatewayCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface StreamBlock {
  wire: Record<string, JsonValue>;
  ended: boolean;
  rawArguments?: string;
}

const MAX_CATALOG_MODELS = 20_000;
const MAX_CONTENT_INDEX = 100_000;
const MAX_ID_BYTES = 4 * 1024;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_STREAM_BYTES = 256 * 1024 * 1024;
const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const REASONING_LEVEL_SET = new Set<string>(REASONING_LEVELS);

export class GatewayMessagesAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  readonly #gatewayUrl: string;
  readonly #accessToken: TokenSource;
  readonly #cacheRetention: GatewayCacheRetention | undefined;
  readonly #toolChoice: GatewayToolChoice | undefined;
  readonly #temperature: number | undefined;
  readonly #fetch: FetchLike;

  constructor(config: GatewayMessagesConfig) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(config.id)) {
      throw new TypeError("Gateway Messages provider ID is invalid");
    }
    if (config.cacheRetention !== undefined && !["none", "short", "long"].includes(config.cacheRetention)) {
      throw new TypeError("Gateway Messages cacheRetention must be none, short, or long");
    }
    if (config.toolChoice !== undefined && !["auto", "none", "required"].includes(config.toolChoice)) {
      throw new TypeError("Gateway Messages toolChoice must be auto, none, or required");
    }
    if (
      config.temperature !== undefined &&
      (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2)
    ) throw new TypeError("Gateway Messages temperature must be between 0 and 2");
    this.id = config.id;
    this.#gatewayUrl = trimSlash(config.gatewayUrl);
    assertSecureEndpoint(this.#gatewayUrl, "Gateway Messages gateway URL");
    this.#accessToken = config.accessToken;
    this.#cacheRetention = config.cacheRetention;
    this.#toolChoice = config.toolChoice;
    this.#temperature = config.temperature;
    this.#fetch = config.fetch ?? globalThis.fetch;
  }

  async *stream(input: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    let partial = false;
    let terminal = false;
    let requestId: string | undefined;
    let diagnostics: ProviderResponseDiagnostics | undefined;
    try {
      if (input.provider !== this.id) {
        throw new InvalidProviderRequestError(`Gateway Messages provider ${this.id} cannot serve ${input.provider}`);
      }
      const request = providerWireRequest(input, input.providerState?.kind === "gateway_messages");
      // Discovery is credential-conditioned. Resolve one credential for both
      // discovery and generation so an account change cannot reuse or race an
      // endpoint selected for a different credential.
      const { catalog, token } = await this.#loadCatalog(signal);
      const model = catalog.models.find((entry) => entry.id === request.model);
      if (model === undefined) {
        throw new InvalidProviderRequestError(`Gateway Messages catalog does not contain model ${request.model}`);
      }
      const headers = new Headers({
        accept: "text/event-stream",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      });
      const response = await this.#fetch(`${catalog.baseUrl}/messages`, {
        method: "POST",
        headers,
        body: stringifyProviderJson(buildRequestBody(
          request,
          model.thinkingLevelMap,
          this.#temperature,
          this.#cacheRetention,
          this.#toolChoice,
        )),
        signal,
      });
      requestId = requestIdFromHeaders(response.headers);
      diagnostics = responseDiagnostics(response);
      await assertResponseOk(response);

      const blocks = new Map<number, StreamBlock>();
      let sawStart = false;
      let responseStarted = false;
      const startResponse = (): AdapterEvent | undefined => {
        if (responseStarted) return undefined;
        responseStarted = true;
        return {
          type: "response_start",
          model: request.model,
          ...(requestId === undefined ? {} : { requestId }),
          ...(diagnostics === undefined ? {} : { diagnostics }),
        };
      };
      for await (const sse of decodeSSE(requireBody(response), {
        maxEventBytes: MAX_TEXT_BYTES,
        maxStreamBytes: MAX_STREAM_BYTES,
      })) {
        signal.throwIfAborted();
        if (sse.data === "[DONE]") {
          throw new ProtocolError("Gateway Messages stream used a sentinel instead of a terminal event");
        }
        const raw = parseJson(sse.data);
        const event = record(raw, "Gateway Messages stream event");
        const type = requiredText(event.type, "Gateway Messages stream event type", 128);

        switch (type) {
          case "start":
            exactKeys(event, ["type"], "Gateway Messages start event");
            if (sawStart) throw new ProtocolError("Gateway Messages stream started more than once");
            sawStart = true;
            break;
          case "text_start": {
            exactKeys(event, ["type", "contentIndex"], "Gateway Messages text_start event");
            const index = contentIndex(event.contentIndex);
            beginBlock(blocks, index, { type: "text", text: "" });
            const start = startResponse();
            if (start !== undefined) yield start;
            yield { type: "text_start", part: index };
            break;
          }
          case "text_delta": {
            exactKeys(event, ["type", "contentIndex", "delta"], "Gateway Messages text_delta event");
            const index = contentIndex(event.contentIndex);
            const delta = boundedText(event.delta, "Gateway Messages text delta", MAX_TEXT_BYTES, true);
            const block = blockOfType(blocks, index, "text");
            block.wire.text = `${stringField(block.wire.text) ?? ""}${delta}`;
            if (delta !== "") {
              partial = true;
              const start = startResponse();
              if (start !== undefined) yield start;
              yield { type: "text_delta", part: index, text: delta };
            }
            break;
          }
          case "text_end": {
            exactKeys(event, ["type", "contentIndex", "content", "contentSignature"], "Gateway Messages text_end event");
            const index = contentIndex(event.contentIndex);
            const block = blockOfType(blocks, index, "text");
            const content = boundedText(event.content, "Gateway Messages text content", MAX_TEXT_BYTES, true);
            const accumulated = stringField(block.wire.text) ?? "";
            if (!content.startsWith(accumulated)) {
              throw new ProtocolError("Gateway Messages final text did not match its streamed prefix");
            }
            const suffix = content.slice(accumulated.length);
            if (suffix !== "") {
              partial = true;
              const start = startResponse();
              if (start !== undefined) yield start;
              yield { type: "text_delta", part: index, text: suffix };
            }
            block.wire.text = content;
            const signature = optionalText(event.contentSignature, "Gateway Messages text signature", MAX_TEXT_BYTES, true);
            if (signature !== undefined) block.wire.textSignature = signature;
            block.ended = true;
            yield {
              type: "text_end",
              part: index,
              text: content,
              ...(signature === undefined ? {} : { textSignature: signature }),
            };
            break;
          }
          case "thinking_start": {
            exactKeys(event, ["type", "contentIndex"], "Gateway Messages thinking_start event");
            const index = contentIndex(event.contentIndex);
            beginBlock(blocks, index, { type: "thinking", thinking: "" });
            const start = startResponse();
            if (start !== undefined) yield start;
            yield { type: "reasoning_start", part: index, visibility: "provider_trace" };
            break;
          }
          case "thinking_delta": {
            exactKeys(event, ["type", "contentIndex", "delta"], "Gateway Messages thinking_delta event");
            const index = contentIndex(event.contentIndex);
            const delta = boundedText(event.delta, "Gateway Messages thinking delta", MAX_TEXT_BYTES, true);
            const block = blockOfType(blocks, index, "thinking");
            block.wire.thinking = `${stringField(block.wire.thinking) ?? ""}${delta}`;
            // Redaction is not known until thinking_end. Buffer the block so a
            // late redacted marker cannot retract text already shown to users
            // or delivered to observers.
            if (delta !== "") partial = true;
            break;
          }
          case "thinking_end": {
            exactKeys(
              event,
              ["type", "contentIndex", "content", "contentSignature", "redacted"],
              "Gateway Messages thinking_end event",
            );
            const index = contentIndex(event.contentIndex);
            const block = blockOfType(blocks, index, "thinking");
            const content = boundedText(event.content, "Gateway Messages thinking content", MAX_TEXT_BYTES, true);
            const accumulated = stringField(block.wire.thinking) ?? "";
            if (!content.startsWith(accumulated)) {
              throw new ProtocolError("Gateway Messages final thinking did not match its streamed prefix");
            }
            let redacted = false;
            if (event.redacted !== undefined) {
              if (typeof event.redacted !== "boolean") throw new ProtocolError("Gateway Messages redacted must be boolean");
              redacted = event.redacted;
              block.wire.redacted = redacted;
            }
            if (content !== "") partial = true;
            if (content !== "" && !redacted) {
              const start = startResponse();
              if (start !== undefined) yield start;
              yield { type: "reasoning_delta", part: index, text: content, visibility: "provider_trace" };
            }
            block.wire.thinking = content;
            const signature = optionalText(event.contentSignature, "Gateway Messages thinking signature", MAX_TEXT_BYTES, true);
            if (signature !== undefined) block.wire.thinkingSignature = signature;
            block.ended = true;
            yield {
              type: "reasoning_end",
              part: index,
              text: content,
              visibility: "provider_trace",
              ...(signature === undefined ? {} : { thinkingSignature: signature }),
              ...(event.redacted === undefined ? {} : { redacted }),
            };
            break;
          }
          case "toolcall_start": {
            exactKeys(event, ["type", "contentIndex", "id", "toolName"], "Gateway Messages toolcall_start event");
            const index = contentIndex(event.contentIndex);
            const id = requiredText(event.id, "Gateway Messages tool call ID", MAX_ID_BYTES);
            const name = requiredText(event.toolName, "Gateway Messages tool name", MAX_ID_BYTES);
            beginBlock(blocks, index, { type: "toolCall", id, name, arguments: {} });
            blocks.get(index)!.rawArguments = "";
            partial = true;
            const start = startResponse();
            if (start !== undefined) yield start;
            yield { type: "tool_call_start", index, id, name };
            break;
          }
          case "toolcall_delta": {
            exactKeys(event, ["type", "contentIndex", "delta"], "Gateway Messages toolcall_delta event");
            const index = contentIndex(event.contentIndex);
            const delta = boundedText(event.delta, "Gateway Messages tool arguments delta", MAX_TEXT_BYTES, true);
            const block = blockOfType(blocks, index, "toolCall");
            block.rawArguments = `${block.rawArguments ?? ""}${delta}`;
            partial = true;
            const start = startResponse();
            if (start !== undefined) yield start;
            yield { type: "tool_call_delta", index, jsonFragment: delta };
            break;
          }
          case "toolcall_end": {
            exactKeys(event, ["type", "contentIndex", "toolCall"], "Gateway Messages toolcall_end event");
            const index = contentIndex(event.contentIndex);
            const block = blockOfType(blocks, index, "toolCall");
            const toolCall = parseToolCall(event.toolCall);
            const existingId = stringField(block.wire.id);
            const existingName = stringField(block.wire.name);
            if (existingId !== toolCall.id || existingName !== toolCall.name) {
              throw new ProtocolError("Gateway Messages tool call end did not match its start event");
            }
            block.wire = toolCall.wire;
            block.ended = true;
            const rawArguments = block.rawArguments === ""
              ? stringifyProviderJson(toolCall.arguments)
              : block.rawArguments ?? stringifyProviderJson(toolCall.arguments);
            if (block.rawArguments !== "") {
              const streamedArguments = asRecord(parseJson(rawArguments));
              if (
                streamedArguments === undefined
                || !isJsonValue(streamedArguments)
                || !isDeepStrictEqual(streamedArguments, toolCall.arguments)
              ) {
                throw new ProtocolError("Gateway Messages final tool arguments did not match their streamed value");
              }
            }
            const start = startResponse();
            if (start !== undefined) yield start;
            yield {
              type: "tool_call_end",
              index,
              id: toolCall.id,
              name: toolCall.name,
              rawArguments,
              arguments: toolCall.arguments,
              ...(typeof toolCall.wire.thoughtSignature === "string"
                ? { thoughtSignature: toolCall.wire.thoughtSignature }
                : {}),
            };
            break;
          }
          case "done": {
            exactKeys(event, ["type", "reason", "usage", "responseId", "rewrite"], "Gateway Messages done event");
            if ([...blocks.values()].some((block) => !block.ended)) {
              throw new ProtocolError("Gateway Messages stream ended with an incomplete content block");
            }
            const start = startResponse();
            if (start !== undefined) yield start;
            const usage = gatewayUsage(event.usage);
            yield { type: "usage", usage, semantics: "final" };
            const rewrite = parseRewrite(event.rewrite);
            if (rewrite !== undefined) yield { type: "unknown_provider_event", provider: this.id, raw: rewrite };
            const reason = mapFinishReason(event.reason);
            const responseId = optionalText(event.responseId, "Gateway Messages response ID", MAX_ID_BYTES);
            const state = gatewayState(blocks, responseId);
            terminal = true;
            yield {
              type: "response_end",
              reason,
              rawReason: requiredText(event.reason, "Gateway Messages finish reason", 64),
              state,
              content: canonicalAssistantContent(state.assistantContent),
            };
            return;
          }
          case "error": {
            exactKeys(
              event,
              ["type", "reason", "usage", "errorMessage", "responseId", "rewrite"],
              "Gateway Messages error event",
            );
            const start = startResponse();
            if (start !== undefined) yield start;
            const usage = gatewayUsage(event.usage);
            yield { type: "usage", usage, semantics: "final" };
            const rewrite = parseRewrite(event.rewrite);
            if (rewrite !== undefined) yield { type: "unknown_provider_event", provider: this.id, raw: rewrite };
            const reason = requiredText(event.reason, "Gateway Messages error reason", 64);
            if (reason !== "aborted" && reason !== "error") {
              throw new ProtocolError("Gateway Messages error reason must be aborted or error");
            }
            const message = optionalText(event.errorMessage, "Gateway Messages error message", 4 * 1024, true) ??
              (reason === "aborted" ? "Gateway request was aborted" : "Gateway request failed");
            terminal = true;
            yield {
              type: "error",
              error: {
                category: reason === "aborted" ? "cancelled" : "provider",
                message,
                retryable: false,
                partial,
                ...(partial ? { bodyStarted: true } : {}),
                ...(requestId === undefined ? {} : { requestId }),
                ...(diagnostics === undefined ? {} : { diagnostics }),
              },
            };
            return;
          }
          default:
            partial = true;
            {
              const start = startResponse();
              if (start !== undefined) yield start;
            }
            yield {
              type: "unknown_provider_event",
              provider: this.id,
              raw: { type: "unknown_gateway_event", eventType: type },
            };
        }
      }
      throw new PrematureStreamEndError("Gateway Messages stream ended without a terminal event");
    } catch (error) {
      if (!terminal) {
        terminal = true;
        yield { type: "error", error: normalizeError(this.id, error, { partial, signal, requestId, diagnostics }) };
      }
    }
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    const { catalog } = await this.#loadCatalog(signal);
    const observedAt = new Date().toISOString();
    return catalog.models.map((model) => modelInfo(this.id, model, observedAt));
  }

  async #loadCatalog(signal: AbortSignal): Promise<{ catalog: GatewayCatalog; token: string }> {
    const token = await this.#token(signal);
    const response = await this.#fetch(`${this.#gatewayUrl}/config`, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      signal,
    });
    await assertResponseOk(response);
    const catalog = parseCatalog(await readJsonResponse(response));
    return { catalog, token };
  }

  async #token(signal: AbortSignal): Promise<string> {
    const token = await resolveToken(this.#accessToken, signal);
    if (token === undefined || token === "") {
      throw new InvalidProviderRequestError(`No bearer credential is configured for ${this.id}`);
    }
    return token;
  }
}

function buildRequestBody(
  request: ProviderRequest,
  thinkingLevelMap: Record<string, string | null> | undefined,
  temperature: number | undefined,
  cacheRetention: GatewayCacheRetention | undefined,
  toolChoice: GatewayToolChoice | undefined,
): JsonValue {
  const mappedReasoning = request.reasoningEffort === undefined
    ? undefined
    : thinkingLevelMap !== undefined && Object.hasOwn(thinkingLevelMap, request.reasoningEffort)
      ? thinkingLevelMap[request.reasoningEffort]
      : request.reasoningEffort;
  const options: Record<string, JsonValue> = {};
  if (temperature !== undefined) options.temperature = temperature;
  if (request.maxOutputTokens !== undefined) options.maxTokens = request.maxOutputTokens;
  if (mappedReasoning !== undefined && mappedReasoning !== null) options.reasoning = mappedReasoning;
  if (cacheRetention !== undefined) options.cacheRetention = cacheRetention;
  if (request.sessionId !== undefined) options.sessionId = request.sessionId;
  if (toolChoice !== undefined) options.toolChoice = toolChoice;
  return {
    model: request.model,
    context: gatewayContext(request),
    options,
  };
}

function gatewayContext(request: ProviderRequest): JsonValue {
  const systemPrompt = request.messages
    .filter((message) => message.role === "system")
    .flatMap((message) => message.content)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
  const lastAssistant = request.messages.findLastIndex((message) => message.role === "assistant");
  const messages: JsonValue[] = [];
  for (const [index, message] of request.messages.entries()) {
    if (message.role === "system") continue;
    const timestamp = timestampMs(message.createdAt);
    if (message.role === "tool") {
      for (const block of message.content) {
        if (block.type !== "tool_result") continue;
        messages.push({
          role: "toolResult",
          toolCallId: block.callId,
          toolName: block.name,
          content: [
            { type: "text", text: toolResultText(block) },
            ...(block.images ?? []).map((image) => gatewayImage(image, "tool result")),
          ],
          isError: block.isError,
          timestamp,
        });
      }
      continue;
    }
    if (message.role === "assistant") {
      const state = index === lastAssistant && request.providerState?.kind === "gateway_messages"
        ? request.providerState
        : undefined;
      messages.push({
        role: "assistant",
        content: state?.assistantContent ?? gatewayAssistantContent(message.content, request.provider),
        api: "gateway-messages",
        provider: request.provider,
        model: request.model,
        ...(state?.responseId === undefined ? {} : { responseId: state.responseId }),
        usage: emptyGatewayUsage(),
        stopReason: "stop",
        timestamp,
      });
      continue;
    }
    const content = message.content.flatMap((block): JsonValue[] => {
      if (block.type === "text") return [{ type: "text", text: block.text }];
      if (block.type === "image") return [gatewayImage(block, "user message")];
      return [];
    });
    messages.push({ role: "user", content, timestamp });
  }
  const context: Record<string, JsonValue> = { messages };
  if (systemPrompt !== "") context.systemPrompt = systemPrompt;
  if (request.tools.length > 0) {
    context.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
  }
  return context;
}

function gatewayAssistantContent(content: ProviderRequest["messages"][number]["content"], provider: ProviderId): JsonValue[] {
  return content.flatMap((block): JsonValue[] => {
    if (block.type === "text") return [{ type: "text", text: block.text }];
    if (block.type === "tool_call") {
      const argumentsValue = asRecord(block.arguments);
      if (argumentsValue === undefined) {
        throw new InvalidProviderRequestError("Gateway Messages tool arguments must be an object");
      }
      return [{ type: "toolCall", id: block.callId, name: block.name, arguments: argumentsValue as JsonValue }];
    }
    if (block.type === "provider_opaque" && block.provider === provider) {
      const opaque = asRecord(block.value);
      if (opaque !== undefined && ["text", "thinking", "toolCall"].includes(String(opaque.type))) return [block.value];
    }
    return [];
  });
}

function gatewayImage(image: { mediaType: string; data?: string; url?: string }, label: string): JsonValue {
  if (image.data === undefined) {
    throw new InvalidProviderRequestError(`Gateway Messages ${label} images require inline base64 data`);
  }
  return { type: "image", data: image.data, mimeType: image.mediaType };
}

function emptyGatewayUsage(): JsonValue {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function gatewayState(
  blocks: Map<number, StreamBlock>,
  responseId: string | undefined,
): Extract<ProviderState, { kind: "gateway_messages" }> {
  return {
    kind: "gateway_messages",
    assistantContent: [...blocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, block]) => structuredClone(block.wire)),
    ...(responseId === undefined ? {} : { responseId }),
  };
}

function gatewayUsage(value: unknown): NormalizedUsage {
  const usage = record(value, "Gateway Messages usage");
  exactKeys(
    usage,
    ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "totalTokens", "cost"],
    "Gateway Messages usage",
  );
  const input = tokenCount(usage.input, "Gateway Messages input usage");
  const output = tokenCount(usage.output, "Gateway Messages output usage");
  const cacheRead = tokenCount(usage.cacheRead, "Gateway Messages cache-read usage");
  const cacheWrite = tokenCount(usage.cacheWrite, "Gateway Messages cache-write usage");
  const cacheWrite1h = usage.cacheWrite1h === undefined
    ? undefined
    : tokenCount(usage.cacheWrite1h, "Gateway Messages one-hour cache-write usage");
  if (cacheWrite1h !== undefined && cacheWrite1h > cacheWrite) {
    throw new ProtocolError("Gateway Messages one-hour cache-write usage exceeded aggregate cache writes");
  }
  const total = tokenCount(usage.totalTokens, "Gateway Messages total usage");
  if (total !== input + output + cacheRead + cacheWrite) {
    throw new ProtocolError("Gateway Messages usage total did not match its token components");
  }
  const cost = record(usage.cost, "Gateway Messages usage cost");
  exactKeys(cost, ["input", "output", "cacheRead", "cacheWrite", "total"], "Gateway Messages usage cost");
  const inputCost = nonNegativeNumber(cost.input, "Gateway Messages input cost");
  const outputCost = nonNegativeNumber(cost.output, "Gateway Messages output cost");
  const cacheReadCost = nonNegativeNumber(cost.cacheRead, "Gateway Messages cache-read cost");
  const cacheWriteCost = nonNegativeNumber(cost.cacheWrite, "Gateway Messages cache-write cost");
  const totalCost = nonNegativeNumber(cost.total, "Gateway Messages total cost");
  const tolerance = Math.max(1e-12, Math.abs(totalCost) * 1e-9);
  if (Math.abs(totalCost - (inputCost + outputCost + cacheReadCost + cacheWriteCost)) > tolerance) {
    throw new ProtocolError("Gateway Messages usage cost total did not match its components");
  }
  return normalizeUsage({
    raw: jsonValueOrString(usage),
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    cacheWrite1hTokens: cacheWrite1h,
    reasoningTokens: usage.reasoning,
    reportedTotalTokens: total,
    cost: {
      input: inputCost,
      output: outputCost,
      cacheRead: cacheReadCost,
      cacheWrite: cacheWriteCost,
      total: totalCost,
    },
  });
}

function parseCatalog(value: unknown): GatewayCatalog {
  const catalog = record(value, "Gateway Messages catalog");
  exactKeys(catalog, ["baseUrl", "models"], "Gateway Messages catalog");
  const baseUrl = trimSlash(requiredText(catalog.baseUrl, "Gateway Messages catalog baseUrl", 16 * 1024));
  assertSecureEndpoint(baseUrl, "Gateway Messages catalog baseUrl");
  if (!Array.isArray(catalog.models) || catalog.models.length > MAX_CATALOG_MODELS) {
    throw new ProtocolError(`Gateway Messages catalog models must contain at most ${MAX_CATALOG_MODELS} entries`);
  }
  const models = catalog.models.map((entry, index) => parseCatalogModel(entry, index));
  if (new Set(models.map((model) => model.id)).size !== models.length) {
    throw new ProtocolError("Gateway Messages catalog contains duplicate model IDs");
  }
  return { baseUrl, models };
}

function parseCatalogModel(value: unknown, index: number): GatewayCatalogModel {
  const label = `Gateway Messages catalog model ${index}`;
  const model = record(value, label);
  exactKeys(
    model,
    ["id", "name", "reasoning", "thinkingLevelMap", "input", "cost", "contextWindow", "maxTokens"],
    label,
  );
  const id = requiredText(model.id, `${label} ID`, 1024);
  const name = requiredText(model.name, `${label} name`, 1024);
  if (typeof model.reasoning !== "boolean") throw new ProtocolError(`${label} reasoning must be boolean`);
  if (!Array.isArray(model.input) || model.input.length < 1 || model.input.length > 2) {
    throw new ProtocolError(`${label} input must contain text and optionally image`);
  }
  const input = model.input.map((entry) => {
    if (entry !== "text" && entry !== "image") throw new ProtocolError(`${label} input contains an unsupported modality`);
    return entry;
  });
  if (!input.includes("text") || new Set(input).size !== input.length) {
    throw new ProtocolError(`${label} input must contain text without duplicates`);
  }
  const costRecord = record(model.cost, `${label} cost`);
  exactKeys(costRecord, ["input", "output", "cacheRead", "cacheWrite"], `${label} cost`);
  const cost: GatewayCost = {
    input: nonNegativeNumber(costRecord.input, `${label} input cost`),
    output: nonNegativeNumber(costRecord.output, `${label} output cost`),
    cacheRead: nonNegativeNumber(costRecord.cacheRead, `${label} cache-read cost`),
    cacheWrite: nonNegativeNumber(costRecord.cacheWrite, `${label} cache-write cost`),
  };
  const contextWindow = positiveTokenCount(model.contextWindow, `${label} contextWindow`);
  const maxTokens = positiveTokenCount(model.maxTokens, `${label} maxTokens`);
  if (maxTokens > contextWindow) throw new ProtocolError(`${label} maxTokens must not exceed contextWindow`);
  const thinkingLevelMap = parseThinkingLevelMap(model.thinkingLevelMap, label);
  if (!model.reasoning && thinkingLevelMap !== undefined) {
    throw new ProtocolError(`${label} cannot define thinkingLevelMap when reasoning is false`);
  }
  return {
    id,
    name,
    reasoning: model.reasoning,
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    input,
    cost,
    contextWindow,
    maxTokens,
  };
}

function parseThinkingLevelMap(value: unknown, label: string): Record<string, string | null> | undefined {
  if (value === undefined) return undefined;
  const input = record(value, `${label} thinkingLevelMap`);
  const output: Record<string, string | null> = {};
  for (const [level, mapped] of Object.entries(input)) {
    if (!REASONING_LEVEL_SET.has(level)) throw new ProtocolError(`${label} thinkingLevelMap contains an unsupported level`);
    if (mapped !== null && (typeof mapped !== "string" || mapped === "" || Buffer.byteLength(mapped) > 128)) {
      throw new ProtocolError(`${label} thinkingLevelMap values must be null or bounded strings`);
    }
    output[level] = mapped;
  }
  return output;
}

function modelInfo(provider: ProviderId, model: GatewayCatalogModel, observedAt: string): ModelInfo {
  const tools: ModelCapability = modelEvidence("supported", "provider", observedAt);
  const reasoning: ModelCapability = modelEvidence(model.reasoning ? "supported" : "unsupported", "provider", observedAt);
  const images: ModelCapability = modelEvidence(model.input.includes("image") ? "supported" : "unsupported", "provider", observedAt);
  const compatibility: ModelCompatibility = {
    protocolFamily: modelEvidence("gateway-messages", "provider", observedAt),
    inputModalities: modelEvidence(model.input, "provider", observedAt),
    outputModalities: modelEvidence(["text"], "provider", observedAt),
    strictTools: modelEvidence("unsupported", "maintained", observedAt),
    toolStreaming: modelEvidence("supported", "provider", observedAt),
    cacheMode: modelEvidence("automatic", "provider", observedAt),
    cacheAffinity: modelEvidence("session", "provider", observedAt),
    cacheTiers: modelEvidence(["provider-managed"], "provider", observedAt),
    sessionAffinity: modelEvidence("optional", "provider", observedAt),
  };
  if (model.reasoning) {
    compatibility.reasoningEfforts = modelEvidence(
      REASONING_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null),
      "provider",
      observedAt,
    );
  }
  const pricing: ModelPricing = {
    currency: "USD",
    unit: "per_million_tokens",
    source: "provider",
    observedAt,
    input: perMillion(model.cost.input),
    output: perMillion(model.cost.output),
    cacheRead: perMillion(model.cost.cacheRead),
    cacheWrite: perMillion(model.cost.cacheWrite),
  };
  return {
    id: model.id,
    provider,
    displayName: model.name,
    contextTokens: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    capabilities: { tools, reasoning, images },
    compatibility,
    pricing,
  };
}

function parseRewrite(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  const rewrite = record(value, "Gateway Messages rewrite impact");
  exactKeys(
    rewrite,
    ["policyId", "policyVersion", "changed", "tokenCountChange", "messageCountChange", "systemPromptChanged"],
    "Gateway Messages rewrite impact",
  );
  const policyId = requiredText(rewrite.policyId, "Gateway Messages rewrite policy ID", 1024);
  const policyVersion = integer(rewrite.policyVersion, "Gateway Messages rewrite policy version");
  const tokenCountChange = integer(rewrite.tokenCountChange, "Gateway Messages rewrite token change");
  const messageCountChange = integer(rewrite.messageCountChange, "Gateway Messages rewrite message change");
  if (typeof rewrite.changed !== "boolean" || typeof rewrite.systemPromptChanged !== "boolean") {
    throw new ProtocolError("Gateway Messages rewrite flags must be boolean");
  }
  return {
    type: "gateway_rewrite",
    policyId,
    policyVersion,
    changed: rewrite.changed,
    tokenCountChange,
    messageCountChange,
    systemPromptChanged: rewrite.systemPromptChanged,
  };
}

function parseToolCall(value: unknown): { id: string; name: string; arguments: JsonValue; wire: Record<string, JsonValue> } {
  const toolCall = record(value, "Gateway Messages tool call");
  exactKeys(toolCall, ["type", "id", "name", "arguments", "thoughtSignature"], "Gateway Messages tool call");
  if (toolCall.type !== "toolCall") throw new ProtocolError("Gateway Messages tool call type is invalid");
  const id = requiredText(toolCall.id, "Gateway Messages tool call ID", MAX_ID_BYTES);
  const name = requiredText(toolCall.name, "Gateway Messages tool call name", MAX_ID_BYTES);
  const argumentsRecord = asRecord(toolCall.arguments);
  if (argumentsRecord === undefined || !isJsonValue(argumentsRecord)) {
    throw new ProtocolError("Gateway Messages tool call arguments must be a JSON object");
  }
  const thoughtSignature = optionalText(toolCall.thoughtSignature, "Gateway Messages tool thought signature", MAX_TEXT_BYTES, true);
  const argumentsValue = structuredClone(argumentsRecord) as JsonValue;
  return {
    id,
    name,
    arguments: argumentsValue,
    wire: {
      type: "toolCall",
      id,
      name,
      arguments: argumentsValue,
      ...(thoughtSignature === undefined ? {} : { thoughtSignature }),
    },
  };
}

function beginBlock(blocks: Map<number, StreamBlock>, index: number, wire: Record<string, JsonValue>): void {
  if (blocks.has(index)) throw new ProtocolError(`Gateway Messages content index ${index} started more than once`);
  blocks.set(index, { wire, ended: false });
}

function blockOfType(blocks: Map<number, StreamBlock>, index: number, type: string): StreamBlock {
  const block = blocks.get(index);
  if (block === undefined || block.wire.type !== type || block.ended) {
    throw new ProtocolError(`Gateway Messages ${type} event did not follow a matching start event`);
  }
  return block;
}

function mapFinishReason(value: unknown): FinishReason {
  const reason = requiredText(value, "Gateway Messages finish reason", 64);
  if (reason === "stop") return "stop";
  if (reason === "length") return "length";
  if (reason === "toolUse") return "tool_calls";
  throw new ProtocolError("Gateway Messages finish reason must be stop, length, or toolUse");
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new ProtocolError("Gateway Messages stream event was not valid JSON", value.slice(0, 4096));
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  const result = asRecord(value);
  if (result === undefined) throw new ProtocolError(`${label} must be an object`, jsonValueOrString(value));
  return result;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !accepted.has(key));
  if (unknown.length > 0) throw new ProtocolError(`${label} contains unknown fields: ${unknown.join(", ")}`);
}

function requiredText(value: unknown, label: string, maxBytes: number): string {
  const result = optionalText(value, label, maxBytes);
  if (result === undefined) throw new ProtocolError(`${label} is required`);
  return result;
}

function optionalText(value: unknown, label: string, maxBytes: number, allowEmpty = false): string | undefined {
  if (value === undefined) return undefined;
  return boundedText(value, label, maxBytes, allowEmpty);
}

function boundedText(value: unknown, label: string, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value === "")) throw new ProtocolError(`${label} must be a string`);
  const normalized = sanitizeUnicode(value);
  if (normalized.includes("\0") || Buffer.byteLength(normalized, "utf8") > maxBytes) {
    throw new ProtocolError(`${label} is invalid or too large`);
  }
  return normalized;
}

function stringField(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function contentIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_CONTENT_INDEX) {
    throw new ProtocolError(`Gateway Messages contentIndex must be from 0 through ${MAX_CONTENT_INDEX}`);
  }
  return value as number;
}

function tokenCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ProtocolError(`${label} must be a non-negative integer`);
  return value as number;
}

function positiveTokenCount(value: unknown, label: string): number {
  const result = tokenCount(value, label);
  if (result < 1) throw new ProtocolError(`${label} must be positive`);
  return result;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new ProtocolError(`${label} must be an integer`);
  return value as number;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ProtocolError(`${label} must be a non-negative finite number`);
  }
  return value;
}

function perMillion(value: number): number {
  const result = value * 1_000_000;
  if (!Number.isFinite(result) || result > Number.MAX_SAFE_INTEGER) {
    throw new ProtocolError("Gateway Messages model price is too large");
  }
  return Number(result.toPrecision(15));
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}
