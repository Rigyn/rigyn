import type { JsonValue } from "../core/json.js";
import type {
  AdapterEvent,
  FinishReason,
  ImageBlock,
  ModelCapability,
  ModelInfo,
  NormalizedUsage,
  ProviderAdapter,
  ProviderRequest,
} from "../core/types.js";
import type { GeminiConfig } from "./gemini.js";
import { normalizeImageSource, requireImageUrlProtocol } from "./images.js";
import { stringifyProviderJson } from "./json.js";
import { providerWireRequest } from "./messages.js";
import { toolResultText } from "./tool-results.js";
import { normalizeUsage } from "./usage.js";
import { requireBody } from "./lines.js";
import { decodeSSE } from "./sse.js";
import {
  baseModelCompatibility,
  modelEvidence,
  providerModalities,
  providerReasoningEfforts,
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
  requestIdFromHeaders,
  readJsonResponse,
  resolveToken,
} from "./transport.js";

const DEFAULT_MAX_EVENT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_STREAM_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_STEPS = 10_000;

export interface GeminiInteractionsConfig extends GeminiConfig {
  store?: boolean;
  maxEventBytes?: number;
  maxStreamBytes?: number;
  maxSteps?: number;
}

interface StepAccumulator {
  index: number;
  step: Record<string, unknown>;
  type: string;
  arguments: string;
  toolIndex?: number;
  ended: boolean;
}

/** Direct adapter for the stable Gemini Developer API Interactions v1 protocol. */
export class GeminiInteractionsAdapter implements ProviderAdapter {
  readonly id = "gemini";
  readonly #config: GeminiInteractionsConfig;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #store: boolean;
  readonly #maxEventBytes: number;
  readonly #maxStreamBytes: number;
  readonly #maxSteps: number;

  constructor(config: GeminiInteractionsConfig = {}) {
    this.#config = config;
    this.#baseUrl = trimSlash(config.baseUrl ?? "https://generativelanguage.googleapis.com/v1");
    assertSecureEndpoint(this.#baseUrl, "Gemini Interactions base URL");
    this.#fetch = config.fetch ?? globalThis.fetch;
    this.#store = config.store ?? false;
    this.#maxEventBytes = positiveInteger(config.maxEventBytes, DEFAULT_MAX_EVENT_BYTES, "maxEventBytes");
    this.#maxStreamBytes = positiveInteger(config.maxStreamBytes, DEFAULT_MAX_STREAM_BYTES, "maxStreamBytes");
    this.#maxSteps = positiveInteger(config.maxSteps, DEFAULT_MAX_STEPS, "maxSteps");
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    let partial = false;
    let terminal = false;
    let requestId: string | undefined;

    try {
      const headers = new Headers(this.#config.headers);
      headers.set("content-type", "application/json");
      headers.set("accept", "text/event-stream");
      await this.#authorize(headers);

      const response = await this.#fetch(`${this.#baseUrl}/interactions`, {
        method: "POST",
        headers,
        body: stringifyProviderJson(buildInteractionsBody(request, this.#store)),
        signal,
        redirect: "error",
      });
      requestId = requestIdFromHeaders(response.headers);
      await assertResponseOk(response);

      let started = false;
      let completed = false;
      let interactionId: string | undefined;
      let responseModel = request.model;
      let status: string | undefined;
      let latestUsage: NormalizedUsage | undefined;
      let finalUsage: NormalizedUsage | undefined;
      let nextToolIndex = 0;
      const steps = new Map<number, StepAccumulator>();

      for await (const sse of decodeSSE(requireBody(response), {
        maxEventBytes: this.#maxEventBytes,
        maxStreamBytes: this.#maxStreamBytes,
      })) {
        if (sse.data.trim() === "[DONE]") break;

        const parsed: unknown = parseJson(sse.data);
        const event = asRecord(parsed);
        if (event === undefined) {
          throw new ProtocolError("Gemini Interactions event was not an object", jsonValueOrString(parsed));
        }
        const eventType = asString(event.event_type) ?? asString(event.type) ?? sse.event;
        if (eventType === undefined) {
          throw new ProtocolError("Gemini Interactions event did not include a type", jsonValueOrString(event));
        }

        const eventError = asRecord(event.error);
        if (eventType === "error" || eventError !== undefined) {
          throw new ProviderStreamError(
            asString(eventError?.message) ?? "Gemini Interactions stream failed",
            asString(eventError?.code),
            jsonValueOrString(event),
          );
        }

        latestUsage = interactionUsage(asRecord(event.metadata)?.total_usage) ?? latestUsage;

        if (eventType === "interaction.created" || eventType === "interaction.start") {
          if (started) throw new ProtocolError("Gemini Interactions stream created the interaction more than once");
          const interaction = interactionFromEvent(event);
          interactionId = asString(interaction.id) ?? interactionId;
          responseModel = asString(interaction.model) ?? responseModel;
          status = asString(interaction.status) ?? status;
          started = true;
          const start: AdapterEvent = { type: "response_start", model: responseModel };
          if (interactionId !== undefined) start.responseId = interactionId;
          if (requestId !== undefined) start.requestId = requestId;
          yield start;
          continue;
        }

        const terminalStatus = terminalStatusFromEventType(eventType);
        if (eventType === "interaction.status_update" || eventType === "interaction.in_progress" || terminalStatus !== undefined) {
          const interaction = interactionFromEvent(event);
          status =
            asString(event.status) ??
            asString(interaction.status) ??
            terminalStatus ??
            status;
          interactionId = asString(event.interaction_id) ?? asString(interaction.id) ?? interactionId;
          responseModel = asString(interaction.model) ?? responseModel;
          if (terminalStatus !== undefined) {
            finalUsage = interactionUsage(interaction.usage) ?? interactionUsage(event.usage);
            completed = true;
          }
          continue;
        }

        if (eventType === "step.start" || eventType === "content.start") {
          requireStarted(started);
          const index = stepIndex(event.index);
          if (steps.has(index)) throw new ProtocolError(`Gemini Interactions step ${index} started more than once`);
          if (steps.size >= this.#maxSteps) {
            throw new ProtocolError(`Gemini Interactions stream exceeded ${this.#maxSteps} steps`);
          }
          const rawStep = asRecord(event.step) ?? asRecord(event.content);
          if (rawStep === undefined) throw new ProtocolError(`Gemini Interactions step ${index} had no step object`);
          const type = asString(rawStep.type);
          if (type === undefined) throw new ProtocolError(`Gemini Interactions step ${index} had no type`);
          const accumulator: StepAccumulator = {
            index,
            step: rawStep,
            type,
            arguments: "",
            ended: false,
          };
          if (type === "function_call") {
            accumulator.toolIndex = nextToolIndex;
            nextToolIndex += 1;
            partial = true;
            const toolStart: AdapterEvent = {
              type: "tool_call_start",
              index: accumulator.toolIndex,
            };
            const id = asString(rawStep.id);
            const name = asString(rawStep.name);
            if (id !== undefined) toolStart.id = id;
            if (name !== undefined) toolStart.name = name;
            yield toolStart;
          } else if (!knownStepType(type)) {
            yield { type: "unknown_provider_event", provider: this.id, raw: jsonValueOrString(event) };
          }
          steps.set(index, accumulator);
          continue;
        }

        if (eventType === "step.delta" || eventType === "content.delta") {
          requireStarted(started);
          const index = stepIndex(event.index);
          const accumulator = activeStep(steps, index);
          const delta = asRecord(event.delta);
          if (delta === undefined) throw new ProtocolError(`Gemini Interactions step ${index} delta was not an object`);
          const deltaType = asString(delta.type);
          if (deltaType === undefined) throw new ProtocolError(`Gemini Interactions step ${index} delta had no type`);

          if (deltaType === "text") {
            const text = asString(delta.text);
            if (text === undefined) throw new ProtocolError(`Gemini Interactions text delta for step ${index} had no text`);
            appendText(accumulator.step, text);
            if (text !== "") {
              partial = true;
              yield { type: "text_delta", part: index, text };
            }
          } else if (deltaType === "thought_summary") {
            const content = asRecord(delta.content) ?? thoughtTextContent(delta);
            if (content !== undefined) {
              appendThoughtSummary(accumulator.step, content);
              const text = asString(content.text);
              if (text !== undefined && text !== "") {
                partial = true;
                yield { type: "reasoning_delta", part: index, text, visibility: "summary" };
              }
            }
          } else if (deltaType === "thought_signature") {
            const signature = asString(delta.signature);
            if (signature !== undefined) accumulator.step.signature = signature;
          } else if (deltaType === "thought") {
            const text = asString(delta.text);
            if (text !== undefined) {
              appendThoughtSummary(accumulator.step, { type: "text", text });
              if (text !== "") {
                partial = true;
                yield { type: "reasoning_delta", part: index, text, visibility: "provider_trace" };
              }
            }
          } else if (deltaType === "arguments_delta" || deltaType === "arguments") {
            const fragment = asString(delta.arguments) ?? asString(delta.partial_arguments);
            if (fragment === undefined) {
              throw new ProtocolError(`Gemini Interactions arguments delta for step ${index} had no fragment`);
            }
            accumulator.arguments += fragment;
            if (accumulator.toolIndex !== undefined && fragment !== "") {
              partial = true;
              yield { type: "tool_call_delta", index: accumulator.toolIndex, jsonFragment: fragment };
            }
          } else if (["image", "audio", "document"].includes(deltaType)) {
            appendMedia(accumulator.step, delta);
          } else if (deltaType === "text_annotation_delta") {
            appendTextAnnotations(accumulator.step, delta.annotations);
          } else if (deltaType === accumulator.type || knownServerToolDelta(deltaType)) {
            mergeStepDelta(accumulator.step, delta);
          } else {
            yield { type: "unknown_provider_event", provider: this.id, raw: jsonValueOrString(event) };
          }
          continue;
        }

        if (eventType === "step.stop" || eventType === "content.stop") {
          requireStarted(started);
          const index = stepIndex(event.index);
          const accumulator = activeStep(steps, index);
          accumulator.ended = true;
          latestUsage = interactionUsage(event.usage) ?? interactionUsage(asRecord(event.metadata)?.total_usage) ?? latestUsage;
          if (accumulator.type === "function_call" && accumulator.toolIndex !== undefined) {
            const toolEnd = finishTool(accumulator);
            yield toolEnd;
          }
          continue;
        }

        if (eventType === "interaction.completed" || eventType === "interaction.complete") {
          requireStarted(started);
          const interaction = interactionFromEvent(event);
          interactionId = asString(interaction.id) ?? asString(event.id) ?? interactionId;
          responseModel = asString(interaction.model) ?? responseModel;
          status = asString(interaction.status) ?? asString(event.status) ?? status;
          finalUsage = interactionUsage(interaction.usage) ?? interactionUsage(event.usage);
          completed = true;
          continue;
        }

        yield { type: "unknown_provider_event", provider: this.id, raw: jsonValueOrString(event) };
      }

      if (!started) throw new ProtocolError("Gemini Interactions stream ended before interaction.created");
      if (!completed) throw new ProtocolError("Gemini Interactions stream ended before a terminal interaction event");
      for (const step of steps.values()) {
        if (!step.ended) throw new ProtocolError(`Gemini Interactions stream ended before step ${step.index} stopped`);
      }

      const usage = finalUsage ?? latestUsage;
      if (usage !== undefined) yield { type: "usage", usage, semantics: "final" };
      const outputSteps = [...steps.values()]
        .sort((left, right) => left.index - right.index)
        .filter((step) => outputStateStep(step.type))
        .map((step) => jsonValueOrString(step.step));
      const state: {
        kind: "gemini_interactions";
        previousInteractionId?: string;
        steps: JsonValue[];
      } = { kind: "gemini_interactions", steps: outputSteps };
      if (this.#store && interactionId !== undefined) state.previousInteractionId = interactionId;

      terminal = true;
      yield {
        type: "response_end",
        reason: mapInteractionStatus(status, nextToolIndex > 0),
        state,
        ...(status === undefined ? {} : { rawReason: status }),
      };
    } catch (error) {
      if (!terminal) {
        terminal = true;
        yield { type: "error", error: normalizeError(this.id, error, { partial, signal, requestId }) };
      }
    }
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    const headers = new Headers(this.#config.headers);
    headers.set("accept", "application/json");
    await this.#authorize(headers);
    const entries: unknown[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const url = new URL(`${this.#baseUrl}/models`);
      url.searchParams.set("pageSize", "1000");
      if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
      const response = await this.#fetch(url, { headers, signal, redirect: "error" });
      await assertResponseOk(response);
      const body = asRecord(await readJsonResponse(response));
      entries.push(...asArray(body?.models));
      const next = asString(body?.nextPageToken);
      if (next === undefined || next === "") break;
      if (seen.has(next)) throw new ProtocolError("Gemini model catalog repeated a page token");
      seen.add(next);
      pageToken = next;
    }
    const observedAt = new Date().toISOString();
    return entries.flatMap((entry): ModelInfo[] => {
      const model = asRecord(entry);
      const rawName = asString(model?.name);
      if (rawName === undefined) return [];
      const capabilities = unknownCapabilities(observedAt);
      const compatibility = baseModelCompatibility("gemini-interactions", capabilities.tools, observedAt);
      const inputModalities = providerModalities(
        model?.inputModalities ?? model?.input_modalities,
        observedAt,
      );
      const outputModalities = providerModalities(
        model?.outputModalities ?? model?.output_modalities,
        observedAt,
      );
      const reasoningEfforts = providerReasoningEfforts(
        model?.supportedReasoningEfforts ?? model?.supported_reasoning_efforts,
        observedAt,
      );
      if (inputModalities !== undefined) compatibility.inputModalities = inputModalities;
      if (outputModalities !== undefined) compatibility.outputModalities = outputModalities;
      if (reasoningEfforts !== undefined) compatibility.reasoningEfforts = reasoningEfforts;
      if (this.#store) compatibility.sessionAffinity = modelEvidence("optional", "configuration", observedAt);
      const info: ModelInfo = {
        id: rawName.replace(/^models\//, ""),
        provider: this.id,
        capabilities,
        compatibility,
        metadata: jsonValueOrString(model),
      };
      const displayName = asString(model?.displayName) ?? asString(model?.display_name);
      const contextTokens = asNumber(model?.inputTokenLimit) ?? asNumber(model?.input_token_limit);
      const maxOutputTokens = asNumber(model?.outputTokenLimit) ?? asNumber(model?.output_token_limit);
      if (displayName !== undefined) info.displayName = displayName;
      if (contextTokens !== undefined) info.contextTokens = contextTokens;
      if (maxOutputTokens !== undefined) info.maxOutputTokens = maxOutputTokens;
      return [info];
    });
  }

  async #authorize(headers: Headers): Promise<void> {
    const accessToken = await resolveToken(this.#config.accessToken);
    if (accessToken !== undefined) {
      headers.set("authorization", `Bearer ${accessToken}`);
      const userProject = await resolveToken(this.#config.userProject);
      if (userProject !== undefined) headers.set("x-goog-user-project", userProject);
      return;
    }
    const apiKey = await resolveToken(this.#config.apiKey);
    if (apiKey !== undefined) headers.set("x-goog-api-key", apiKey);
  }
}

function buildInteractionsBody(request: ProviderRequest, store: boolean): Record<string, unknown> {
  request = providerWireRequest(request, request.providerState?.kind === "gemini_interactions");
  const state = request.providerState?.kind === "gemini_interactions" ? request.providerState : undefined;
  const stateful = store && state?.previousInteractionId !== undefined;
  const body: Record<string, unknown> = {
    model: stripModelPrefix(request.model),
    input: buildInteractionInput(request, stateful),
    stream: true,
    store,
  };
  if (stateful && state?.previousInteractionId !== undefined) {
    body.previous_interaction_id = state.previousInteractionId;
  }

  const systemInstruction = request.messages
    .filter((message) => message.role === "system")
    .flatMap((message) => message.content)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  if (systemInstruction !== "") body.system_instruction = systemInstruction;
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
  }

  const generationConfig: Record<string, unknown> = {};
  if (request.maxOutputTokens !== undefined) generationConfig.max_output_tokens = request.maxOutputTokens;
  const thinkingLevel = mapThinkingLevel(request.reasoningEffort);
  if (thinkingLevel !== undefined) generationConfig.thinking_level = thinkingLevel;
  if (Object.keys(generationConfig).length > 0) body.generation_config = generationConfig;
  return body;
}

function buildInteractionInput(request: ProviderRequest, stateful: boolean): unknown[] {
  const state = request.providerState?.kind === "gemini_interactions" ? request.providerState : undefined;
  const lastAssistant = findLastAssistant(request);
  if (stateful && state?.previousInteractionId !== undefined) {
    const start = lastAssistant < 0 ? 0 : lastAssistant + 1;
    return request.messages.slice(start).flatMap(messageToInteractionSteps);
  }
  if (state !== undefined && lastAssistant >= 0) {
    return [
      ...request.messages.slice(0, lastAssistant).flatMap(messageToInteractionSteps),
      ...state.steps,
      ...request.messages.slice(lastAssistant + 1).flatMap(messageToInteractionSteps),
    ];
  }
  return request.messages.flatMap(messageToInteractionSteps);
}

function messageToInteractionSteps(message: ProviderRequest["messages"][number]): unknown[] {
  if (message.role === "system") return [];
  const content: unknown[] = [];
  const steps: unknown[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      content.push(interactionsImageContent(block));
    } else if (block.type === "tool_call") {
      steps.push({ type: "function_call", id: block.callId, name: block.name, arguments: block.arguments });
    } else if (block.type === "tool_result") {
      steps.push({
        type: "function_result",
        call_id: block.callId,
        name: block.name,
        result: [
          { type: "text", text: toolResultText(block) },
          ...(block.images ?? []).map(interactionsImageContent),
        ],
        is_error: block.isError,
      });
    } else if (block.type === "provider_opaque" && block.provider === "gemini") {
      const opaque = asRecord(block.value);
      if (asString(opaque?.type) !== undefined) steps.push(block.value);
    }
  }
  if (content.length > 0) {
    steps.unshift({ type: message.role === "assistant" ? "model_output" : "user_input", content });
  }
  return steps;
}

function interactionsImageContent(block: ImageBlock): unknown {
  const source = normalizeImageSource(block, "Gemini Interactions");
  requireImageUrlProtocol(source, "Gemini Interactions", ["https:"]);
  return source.kind === "base64"
    ? { type: "image", mime_type: source.mediaType, data: source.data }
    : { type: "image", mime_type: source.mediaType, uri: source.url };
}

function findLastAssistant(request: ProviderRequest): number {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    if (request.messages[index]?.role === "assistant") return index;
  }
  return -1;
}

function appendText(step: Record<string, unknown>, text: string): void {
  const content = mutableArray(step, "content");
  const last = asRecord(content.at(-1));
  if (last !== undefined && asString(last.type) === "text") {
    last.text = (asString(last.text) ?? "") + text;
  } else {
    content.push({ type: "text", text });
  }
}

function appendMedia(step: Record<string, unknown>, delta: Record<string, unknown>): void {
  const content = mutableArray(step, "content");
  const type = asString(delta.type);
  const last = asRecord(content.at(-1));
  if (
    type !== undefined &&
    last !== undefined &&
    asString(last.type) === type &&
    asString(last.mime_type) === asString(delta.mime_type) &&
    asString(delta.data) !== undefined
  ) {
    last.data = (asString(last.data) ?? "") + (asString(delta.data) ?? "");
    return;
  }
  content.push(jsonValueOrString(delta));
}

function appendThoughtSummary(step: Record<string, unknown>, content: Record<string, unknown>): void {
  mutableArray(step, "summary").push(jsonValueOrString(content));
}

function thoughtTextContent(delta: Record<string, unknown>): Record<string, unknown> | undefined {
  const text = asString(delta.text);
  return text === undefined ? undefined : { type: "text", text };
}

function appendTextAnnotations(step: Record<string, unknown>, value: unknown): void {
  const content = asArray(step.content);
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const item = asRecord(content[index]);
    if (asString(item?.type) !== "text" || item === undefined) continue;
    const annotations = mutableArray(item, "annotations");
    if (Array.isArray(value)) annotations.push(...value.map(jsonValueOrString));
    else if (value !== undefined) annotations.push(jsonValueOrString(value));
    return;
  }
}

function mergeStepDelta(step: Record<string, unknown>, delta: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(delta)) {
    if (key === "type") continue;
    const current = asRecord(step[key]);
    const update = asRecord(value);
    if (current !== undefined && update !== undefined) Object.assign(current, update);
    else step[key] = value;
  }
}

function mutableArray(record: Record<string, unknown>, key: string): unknown[] {
  const existing = record[key];
  if (Array.isArray(existing)) return existing;
  const values = existing === undefined ? [] : [existing];
  record[key] = values;
  return values;
}

function finishTool(step: StepAccumulator): AdapterEvent {
  const rawArguments =
    step.arguments !== "" ? step.arguments : stringifyProviderJson(jsonValueOrString(step.step.arguments ?? {}));
  const event: AdapterEvent = {
    type: "tool_call_end",
    index: step.toolIndex ?? 0,
    name: asString(step.step.name) ?? "unknown_tool",
    rawArguments,
  };
  const id = asString(step.step.id);
  if (id !== undefined) event.id = id;
  try {
    const parsed: unknown = JSON.parse(rawArguments === "" ? "{}" : rawArguments);
    event.arguments = jsonValueOrString(parsed);
    step.step.arguments = event.arguments;
  } catch (error) {
    event.parseError = error instanceof Error ? error.message : String(error);
    step.step.arguments = rawArguments;
  }
  return event;
}

function interactionUsage(value: unknown): NormalizedUsage | undefined {
  const usage = asRecord(value);
  if (usage === undefined) return undefined;
  return normalizeUsage({
    raw: jsonValueOrString(usage),
    inputTokens: usage.total_input_tokens ?? usage.prompt_tokens,
    outputTokens: usage.total_output_tokens ?? usage.completion_tokens,
    reportedTotalTokens: usage.total_tokens,
    cacheReadTokens: usage.total_cached_tokens,
    reasoningTokens: usage.total_thought_tokens,
    inputIncludesCache: true,
    reconcileOutputFromTotal: true,
  });
}

function interactionFromEvent(event: Record<string, unknown>): Record<string, unknown> {
  return asRecord(event.interaction) ?? event;
}

function stepIndex(value: unknown): number {
  const index = asNumber(value);
  if (index === undefined || !Number.isSafeInteger(index) || index < 0) {
    throw new ProtocolError("Gemini Interactions event had an invalid step index", jsonValueOrString(value));
  }
  return index;
}

function activeStep(steps: Map<number, StepAccumulator>, index: number): StepAccumulator {
  const step = steps.get(index);
  if (step === undefined) throw new ProtocolError(`Gemini Interactions step ${index} was not started`);
  if (step.ended) throw new ProtocolError(`Gemini Interactions step ${index} received data after it stopped`);
  return step;
}

function requireStarted(started: boolean): void {
  if (!started) throw new ProtocolError("Gemini Interactions event arrived before interaction.created");
}

function knownStepType(type: string): boolean {
  return [
    "model_output",
    "thought",
    "function_call",
    "function_result",
    "user_input",
    "code_execution_call",
    "code_execution_result",
    "url_context_call",
    "url_context_result",
    "google_search_call",
    "google_search_result",
    "file_search_call",
    "file_search_result",
    "google_maps_call",
    "google_maps_result",
  ].includes(type);
}

function knownServerToolDelta(type: string): boolean {
  return [
    "function_result",
    "code_execution_call",
    "code_execution_result",
    "url_context_call",
    "url_context_result",
    "google_search_call",
    "google_search_result",
    "file_search_call",
    "file_search_result",
    "google_maps_call",
    "google_maps_result",
  ].includes(type);
}

function outputStateStep(type: string): boolean {
  return type !== "user_input" && type !== "function_result";
}

function mapInteractionStatus(status: string | undefined, sawTools: boolean): FinishReason {
  if (status === "requires_action" || sawTools) return "tool_calls";
  if (status === "completed") return "stop";
  if (status === "incomplete" || status === "budget_exceeded") return "incomplete";
  if (status === "cancelled") return "cancelled";
  if (status === "failed") return "error";
  return "unknown";
}

function terminalStatusFromEventType(eventType: string): string | undefined {
  if (eventType === "interaction.requires_action") return "requires_action";
  if (eventType === "interaction.failed") return "failed";
  if (eventType === "interaction.cancelled") return "cancelled";
  if (eventType === "interaction.incomplete") return "incomplete";
  return undefined;
}

function mapThinkingLevel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "none") return "minimal";
  if (normalized === "xhigh") return "high";
  return ["minimal", "low", "medium", "high"].includes(normalized) ? normalized : undefined;
}

function unknownCapabilities(observedAt: string): ModelInfo["capabilities"] {
  return {
    tools: unknownCapability(observedAt),
    reasoning: unknownCapability(observedAt),
    images: unknownCapability(observedAt),
  };
}

function unknownCapability(observedAt: string): ModelCapability {
  return { value: "unknown", source: "provider", observedAt };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError("Malformed Gemini Interactions SSE event", text);
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new RangeError(`${name} must be positive`);
  return result;
}

function stripModelPrefix(model: string): string {
  return model.replace(/^models\//, "");
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
