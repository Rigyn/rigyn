import { isDeepStrictEqual } from "node:util";
import type { JsonValue } from "../core/json.js";
import { validateProviderResponseDiagnostics } from "../core/provider-diagnostics.js";
import { validatedAssistantContent } from "../core/public-assistant-content.js";
import type {
  AdapterError,
  AdapterEvent,
  CapabilityValue,
  FinishReason,
  ModelInfo,
  NormalizedUsage,
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  ProviderState,
} from "../core/types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { isNormalizedUsage } from "../core/usage.js";

export const SCRIPTED_PROVIDER_LIMITS = Object.freeze({
  models: 128,
  queuedScripts: 1_024,
  eventsPerScript: 4_096,
  contentBlocksPerTurn: 1_024,
  fragmentsPerBlock: 4_096,
  scriptBytes: 8 * 1024 * 1024,
  queuedScriptBytes: 32 * 1024 * 1024,
  catalogBytes: 8 * 1024 * 1024,
  eventTextBytes: 1024 * 1024,
  requestBytes: 16 * 1024 * 1024,
  capturedRequests: 1_024,
  cacheEntries: 256,
  jsonDepth: 64,
  jsonNodes: 100_000,
  delayMs: 60_000,
  totalDelayMs: 5 * 60_000,
});

export interface ScriptedProviderModel {
  id: string;
  displayName?: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  capabilities?: Partial<Record<"tools" | "reasoning" | "images", CapabilityValue>>;
  metadata?: JsonValue;
}

export interface ScriptedProviderEvent {
  event: AdapterEvent;
  /** Delay before this event is emitted. Cancellation interrupts the delay. */
  delayMs?: number;
}

export interface ScriptedEventSequence {
  kind: "events";
  events: readonly (AdapterEvent | ScriptedProviderEvent)[];
}

export interface ScriptedTextBlock {
  type: "text";
  text: string;
  part?: number;
  fragments?: readonly string[];
}

export interface ScriptedReasoningBlock {
  type: "reasoning";
  text: string;
  part?: number;
  visibility?: "summary" | "provider_trace";
  fragments?: readonly string[];
}

export interface ScriptedToolCallBlock {
  type: "tool_call";
  name: string;
  id?: string;
  index?: number;
  arguments?: JsonValue;
  rawArguments?: string;
  fragments?: readonly string[];
  parseError?: string;
}

export type ScriptedTurnBlock = ScriptedTextBlock | ScriptedReasoningBlock | ScriptedToolCallBlock;

export type ScriptedTurnTerminal =
  | { type: "finish"; reason?: FinishReason; rawReason?: string; explanation?: string; state?: ProviderState }
  | { type: "error"; error: AdapterError };

export interface ScriptedTurn {
  kind: "turn";
  content?: readonly ScriptedTurnBlock[];
  responseId?: string;
  requestId?: string;
  usage?: NormalizedUsage | "estimate" | false;
  terminal?: ScriptedTurnTerminal;
  eventDelayMs?: number;
}

export type ResolvedScriptedProviderStep = ScriptedEventSequence | ScriptedTurn;

export interface ScriptedProviderFactoryContext {
  request: ProviderRequest;
  model: ModelInfo;
  callCount: number;
}

export type ScriptedProviderFactory = (
  context: ScriptedProviderFactoryContext,
  signal: AbortSignal,
) => ResolvedScriptedProviderStep | Promise<ResolvedScriptedProviderStep>;

export type ScriptedProviderStep = ResolvedScriptedProviderStep | ScriptedProviderFactory;

export interface ScriptedProviderOptions {
  id?: ProviderId;
  models?: readonly ScriptedProviderModel[];
  scripts?: readonly ScriptedProviderStep[];
  defaultEventDelayMs?: number;
  defaultFragmentCharacters?: number;
  estimateCache?: boolean;
  maxCapturedRequests?: number;
}

interface NormalizedEventStep {
  event: AdapterEvent;
  delayMs: number;
}

const DEFAULT_OBSERVED_AT = "1970-01-01T00:00:00.000Z";
const DEFAULT_PROVIDER_ID = "scripted";
const DEFAULT_MODEL_ID = "scripted-model";
const FINISH_REASONS = new Set<FinishReason>([
  "stop",
  "tool_calls",
  "length",
  "context_limit",
  "content_filter",
  "refusal",
  "pause",
  "cancelled",
  "error",
  "incomplete",
  "unknown",
]);
const ERROR_CATEGORIES = new Set<AdapterError["category"]>([
  "authentication",
  "permission",
  "rate_limit",
  "invalid_request",
  "not_found",
  "overloaded",
  "network",
  "timeout",
  "protocol",
  "cancelled",
  "provider",
]);
const CAPABILITIES = new Set<CapabilityValue>(["supported", "unsupported", "unknown"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) throw new Error(`${label} contains unknown field ${JSON.stringify(key)}`);
  }
}

function required(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing required field ${JSON.stringify(key)}`);
  }
}

function boundedString(
  value: unknown,
  label: string,
  options: { empty?: boolean; controls?: boolean; maxBytes?: number } = {},
): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (options.empty !== true && value.length === 0) throw new Error(`${label} cannot be empty`);
  const maxBytes = options.maxBytes ?? SCRIPTED_PROVIDER_LIMITS.eventTextBytes;
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  if (options.controls !== true && /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} cannot contain control characters`);
  }
  return value;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function optionalInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): void {
  if (value !== undefined) boundedInteger(value, label, 0, maximum);
}

function validateJson(value: unknown, label: string): asserts value is JsonValue {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (entry: unknown, path: string, depth: number): void => {
    nodes += 1;
    if (nodes > SCRIPTED_PROVIDER_LIMITS.jsonNodes) {
      throw new Error(`${label} exceeds ${SCRIPTED_PROVIDER_LIMITS.jsonNodes} JSON nodes`);
    }
    if (depth > SCRIPTED_PROVIDER_LIMITS.jsonDepth) {
      throw new Error(`${label} exceeds JSON depth ${SCRIPTED_PROVIDER_LIMITS.jsonDepth}`);
    }
    if (entry === null || typeof entry === "boolean") return;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw new Error(`${path} must be a finite JSON number`);
      return;
    }
    if (typeof entry === "string") {
      boundedString(entry, path, { empty: true, controls: true });
      return;
    }
    if (typeof entry !== "object") throw new Error(`${path} is not a JSON value`);
    if (ancestors.has(entry)) throw new Error(`${path} contains a JSON cycle`);
    ancestors.add(entry);
    if (Array.isArray(entry)) {
      for (let index = 0; index < entry.length; index += 1) {
        if (!Object.hasOwn(entry, index)) throw new Error(`${path} contains a sparse array slot`);
        visit(entry[index], `${path}[${index}]`, depth + 1);
      }
    } else {
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must be a plain JSON object`);
      for (const [key, child] of Object.entries(entry)) {
        boundedString(key, `${path} key`, { empty: true, controls: true });
        visit(child, `${path}.${key}`, depth + 1);
      }
    }
    ancestors.delete(entry);
  };
  visit(value, label, 0);
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > SCRIPTED_PROVIDER_LIMITS.scriptBytes) {
    throw new Error(`${label} exceeds ${SCRIPTED_PROVIDER_LIMITS.scriptBytes} serialized bytes`);
  }
}

function validateJsonArray(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  validateJson(value, label);
}

function cloneBounded<T>(value: T, label: string, maximumBytes: number): T {
  let cloned: T;
  try {
    cloned = structuredClone(value);
  } catch (error) {
    throw new Error(`${label} cannot be cloned: ${error instanceof Error ? error.message : String(error)}`);
  }
  const serialized = JSON.stringify(cloned);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} serialized bytes`);
  }
  return cloned;
}

function validateUsage(value: unknown, label: string): asserts value is NormalizedUsage {
  const usage = record(value, label);
  exactKeys(usage, [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "cacheWrite1hTokens",
    "reasoningTokens",
    "serverToolCalls",
    "cost",
    "durationMs",
    "raw",
  ], label);
  for (const key of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "cacheWrite1hTokens",
    "reasoningTokens",
    "serverToolCalls",
    "durationMs",
  ]) optionalInteger(usage[key], `${label}.${key}`);
  if (usage.raw !== undefined) validateJson(usage.raw, `${label}.raw`);
  if (usage.totalTokens !== undefined) {
    const components = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens];
    if (components.some((entry) => entry !== undefined)) {
      const total = components.reduce<number>((sum, entry) => sum + (typeof entry === "number" ? entry : 0), 0);
      if (usage.totalTokens !== total) throw new Error(`${label}.totalTokens does not equal its normalized components`);
    }
  }
  if (!isNormalizedUsage(usage)) throw new Error(`${label} is not valid normalized usage`);
}

function validateError(value: unknown, label: string): asserts value is AdapterError {
  const error = record(value, label);
  exactKeys(error, [
    "category",
    "message",
    "httpStatus",
    "providerCode",
    "requestId",
    "retryAfterMs",
    "retryable",
    "partial",
    "bodyStarted",
    "diagnostics",
    "raw",
  ], label);
  required(error, ["category", "message", "retryable", "partial"], label);
  if (!ERROR_CATEGORIES.has(error.category as AdapterError["category"])) throw new Error(`${label}.category is invalid`);
  boundedString(error.message, `${label}.message`, { controls: true, maxBytes: 64 * 1024 });
  optionalInteger(error.httpStatus, `${label}.httpStatus`, 999);
  if (error.providerCode !== undefined) boundedString(error.providerCode, `${label}.providerCode`, { maxBytes: 4_096 });
  if (error.requestId !== undefined) boundedString(error.requestId, `${label}.requestId`, { maxBytes: 4_096 });
  optionalInteger(error.retryAfterMs, `${label}.retryAfterMs`, 24 * 60 * 60_000);
  if (typeof error.retryable !== "boolean") throw new Error(`${label}.retryable must be boolean`);
  if (typeof error.partial !== "boolean") throw new Error(`${label}.partial must be boolean`);
  if (error.bodyStarted !== undefined && typeof error.bodyStarted !== "boolean") {
    throw new Error(`${label}.bodyStarted must be boolean`);
  }
  if (error.bodyStarted === true && error.partial !== true) {
    throw new Error(`${label}.bodyStarted cannot be true when partial is false`);
  }
  if (error.diagnostics !== undefined) validateProviderResponseDiagnostics(error.diagnostics);
  if (error.raw !== undefined) validateJson(error.raw, `${label}.raw`);
}

function validateState(value: unknown, label: string): asserts value is ProviderState {
  const state = record(value, label);
  const kind = state.kind;
  if (typeof kind !== "string") throw new Error(`${label}.kind must be a string`);
  const stateKeys = (keys: string[]) => [...keys, "routed"];
  if (state.routed !== undefined) {
    const routed = record(state.routed, `${label}.routed`);
    exactKeys(routed, ["provider", "model", "delegate", "upstreamModel", "protocolFamily", "scope"], `${label}.routed`);
    required(routed, ["provider", "model", "delegate", "upstreamModel", "protocolFamily", "scope"], `${label}.routed`);
    const routedIdentity = (value: unknown, field: string, maxBytes: number) => {
      const identity = boundedString(value, `${label}.routed.${field}`, { maxBytes });
      if (identity.trim() !== identity || /[\u007f-\u009f]/u.test(identity)) {
        throw new Error(`${label}.routed.${field} must be canonical`);
      }
    };
    routedIdentity(routed.provider, "provider", 128);
    routedIdentity(routed.model, "model", 512);
    routedIdentity(routed.delegate, "delegate", 128);
    routedIdentity(routed.upstreamModel, "upstreamModel", 512);
    if (![
      "openai-responses",
      "openai-chat-completions",
      "anthropic-messages",
      "gemini-generate-content",
      "gemini-interactions",
      "bedrock-converse",
      "mistral-conversations",
      "ollama-chat",
      "gateway-messages",
    ].includes(String(routed.protocolFamily))) throw new Error(`${label}.routed.protocolFamily is invalid`);
    if (
      typeof routed.scope !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(routed.scope)
    ) throw new Error(`${label}.routed.scope is invalid`);
  }
  switch (kind) {
    case "openai_responses":
      exactKeys(state, stateKeys(["kind", "previousResponseId", "outputItems"]), label);
      required(state, ["kind", "outputItems"], label);
      if (state.previousResponseId !== undefined) boundedString(state.previousResponseId, `${label}.previousResponseId`);
      validateJsonArray(state.outputItems, `${label}.outputItems`);
      break;
    case "anthropic_messages":
      exactKeys(state, stateKeys(["kind", "assistantBlocks"]), label);
      required(state, ["kind", "assistantBlocks"], label);
      validateJsonArray(state.assistantBlocks, `${label}.assistantBlocks`);
      break;
    case "gemini_interactions":
      exactKeys(state, stateKeys(["kind", "previousInteractionId", "steps"]), label);
      required(state, ["kind", "steps"], label);
      if (state.previousInteractionId !== undefined) boundedString(state.previousInteractionId, `${label}.previousInteractionId`);
      validateJsonArray(state.steps, `${label}.steps`);
      break;
    case "mistral_chat":
      exactKeys(state, stateKeys(["kind", "assistantMessage"]), label);
      required(state, ["kind", "assistantMessage"], label);
      validateJson(state.assistantMessage, `${label}.assistantMessage`);
      break;
    case "gemini_generate_content":
      exactKeys(state, stateKeys(["kind", "parts"]), label);
      required(state, ["kind", "parts"], label);
      validateJsonArray(state.parts, `${label}.parts`);
      break;
    case "gateway_messages":
      exactKeys(state, stateKeys(["kind", "assistantContent", "responseId"]), label);
      required(state, ["kind", "assistantContent"], label);
      validateJsonArray(state.assistantContent, `${label}.assistantContent`);
      if (state.responseId !== undefined) boundedString(state.responseId, `${label}.responseId`, { maxBytes: 4_096 });
      break;
    case "bedrock_converse":
      exactKeys(state, stateKeys(["kind", "assistantMessage"]), label);
      required(state, ["kind", "assistantMessage"], label);
      validateJson(state.assistantMessage, `${label}.assistantMessage`);
      break;
    case "chat_completions":
    case "openrouter_chat":
    case "ollama_chat":
      exactKeys(state, stateKeys(["kind", "assistantMessage"]), label);
      required(state, ["kind", "assistantMessage"], label);
      validateJson(state.assistantMessage, `${label}.assistantMessage`);
      break;
    default:
      throw new Error(`${label}.kind is invalid`);
  }
}

function validateEvent(value: unknown, label: string): asserts value is AdapterEvent {
  const event = record(value, label);
  if (typeof event.type !== "string") throw new Error(`${label}.type must be a string`);
  switch (event.type) {
    case "response_start":
      exactKeys(event, ["type", "model", "responseId", "requestId"], label);
      required(event, ["type", "model"], label);
      boundedString(event.model, `${label}.model`, { maxBytes: 1_024 });
      if (event.responseId !== undefined) boundedString(event.responseId, `${label}.responseId`, { maxBytes: 4_096 });
      if (event.requestId !== undefined) boundedString(event.requestId, `${label}.requestId`, { maxBytes: 4_096 });
      break;
    case "text_delta":
      exactKeys(event, ["type", "part", "text"], label);
      required(event, ["type", "part", "text"], label);
      boundedInteger(event.part, `${label}.part`, 0, SCRIPTED_PROVIDER_LIMITS.contentBlocksPerTurn);
      boundedString(event.text, `${label}.text`, { empty: true, controls: true });
      break;
    case "text_start":
      exactKeys(event, ["type", "part"], label);
      required(event, ["type", "part"], label);
      boundedInteger(event.part, `${label}.part`, 0, SCRIPTED_PROVIDER_LIMITS.contentBlocksPerTurn);
      break;
    case "text_end":
      exactKeys(event, ["type", "part", "text", "textSignature"], label);
      required(event, ["type", "part", "text"], label);
      boundedInteger(event.part, `${label}.part`, 0, SCRIPTED_PROVIDER_LIMITS.contentBlocksPerTurn);
      boundedString(event.text, `${label}.text`, { empty: true, controls: true });
      if (event.textSignature !== undefined) boundedString(event.textSignature, `${label}.textSignature`, { empty: true, controls: true });
      break;
    case "reasoning_start":
      exactKeys(event, ["type", "part", "visibility"], label);
      required(event, ["type", "part", "visibility"], label);
      boundedInteger(event.part, `${label}.part`, 0, SCRIPTED_PROVIDER_LIMITS.contentBlocksPerTurn);
      if (event.visibility !== "summary" && event.visibility !== "provider_trace") throw new Error(`${label}.visibility is invalid`);
      break;
    case "reasoning_delta":
      exactKeys(event, ["type", "part", "text", "visibility"], label);
      required(event, ["type", "part", "text", "visibility"], label);
      boundedInteger(event.part, `${label}.part`, 0, SCRIPTED_PROVIDER_LIMITS.contentBlocksPerTurn);
      boundedString(event.text, `${label}.text`, { empty: true, controls: true });
      if (event.visibility !== "summary" && event.visibility !== "provider_trace") {
        throw new Error(`${label}.visibility is invalid`);
      }
      break;
    case "reasoning_end":
      exactKeys(event, ["type", "part", "text", "visibility", "thinkingSignature", "redacted"], label);
      required(event, ["type", "part", "text", "visibility"], label);
      boundedInteger(event.part, `${label}.part`, 0, SCRIPTED_PROVIDER_LIMITS.contentBlocksPerTurn);
      boundedString(event.text, `${label}.text`, { empty: true, controls: true });
      if (event.visibility !== "summary" && event.visibility !== "provider_trace") throw new Error(`${label}.visibility is invalid`);
      if (event.thinkingSignature !== undefined) boundedString(event.thinkingSignature, `${label}.thinkingSignature`, { empty: true, controls: true });
      if (event.redacted !== undefined && typeof event.redacted !== "boolean") throw new Error(`${label}.redacted must be boolean`);
      break;
    case "tool_call_start":
      exactKeys(event, ["type", "index", "id", "name"], label);
      required(event, ["type", "index"], label);
      boundedInteger(event.index, `${label}.index`, 0, SCRIPTED_PROVIDER_LIMITS.contentBlocksPerTurn);
      if (event.id !== undefined) boundedString(event.id, `${label}.id`, { maxBytes: 4_096 });
      if (event.name !== undefined) boundedString(event.name, `${label}.name`, { maxBytes: 1_024 });
      break;
    case "tool_call_delta":
      exactKeys(event, ["type", "index", "jsonFragment"], label);
      required(event, ["type", "index", "jsonFragment"], label);
      boundedInteger(event.index, `${label}.index`, 0, SCRIPTED_PROVIDER_LIMITS.contentBlocksPerTurn);
      boundedString(event.jsonFragment, `${label}.jsonFragment`, { empty: true, controls: true });
      break;
    case "tool_call_end":
      exactKeys(event, ["type", "index", "name", "rawArguments", "id", "arguments", "parseError", "thoughtSignature"], label);
      required(event, ["type", "index", "name", "rawArguments"], label);
      boundedInteger(event.index, `${label}.index`, 0, SCRIPTED_PROVIDER_LIMITS.contentBlocksPerTurn);
      boundedString(event.name, `${label}.name`, { maxBytes: 1_024 });
      boundedString(event.rawArguments, `${label}.rawArguments`, { empty: true, controls: true });
      if (event.id !== undefined) boundedString(event.id, `${label}.id`, { maxBytes: 4_096 });
      if (event.arguments !== undefined) validateJson(event.arguments, `${label}.arguments`);
      if (event.parseError !== undefined) boundedString(event.parseError, `${label}.parseError`, { maxBytes: 16 * 1024 });
      if (event.thoughtSignature !== undefined) boundedString(event.thoughtSignature, `${label}.thoughtSignature`, { empty: true, controls: true });
      if ((event.arguments === undefined) === (event.parseError === undefined)) {
        throw new Error(`${label} must contain exactly one of arguments or parseError`);
      }
      break;
    case "usage":
      exactKeys(event, ["type", "usage", "semantics"], label);
      required(event, ["type", "usage", "semantics"], label);
      validateUsage(event.usage, `${label}.usage`);
      if (event.semantics !== "incremental" && event.semantics !== "cumulative" && event.semantics !== "final") {
        throw new Error(`${label}.semantics is invalid`);
      }
      break;
    case "unknown_provider_event":
      exactKeys(event, ["type", "provider", "raw"], label);
      required(event, ["type", "provider", "raw"], label);
      boundedString(event.provider, `${label}.provider`, { maxBytes: 256 });
      validateJson(event.raw, `${label}.raw`);
      break;
    case "response_end":
      exactKeys(event, ["type", "reason", "state", "content", "rawReason", "explanation"], label);
      required(event, ["type", "reason", "state"], label);
      if (!FINISH_REASONS.has(event.reason as FinishReason)) throw new Error(`${label}.reason is invalid`);
      validateState(event.state, `${label}.state`);
      if (event.content !== undefined) validatedAssistantContent(event.content);
      if (event.rawReason !== undefined) boundedString(event.rawReason, `${label}.rawReason`, { maxBytes: 4_096 });
      if (event.explanation !== undefined) boundedString(event.explanation, `${label}.explanation`, { maxBytes: 4_096 });
      break;
    case "error":
      exactKeys(event, ["type", "error"], label);
      required(event, ["type", "error"], label);
      validateError(event.error, `${label}.error`);
      break;
    default:
      throw new Error(`${label}.type is invalid`);
  }
}

function terminalEvent(event: AdapterEvent): boolean {
  return event.type === "response_end" || event.type === "error";
}

function normalizeEventSequence(value: unknown, defaultDelayMs: number): NormalizedEventStep[] {
  const script = record(value, "event script");
  exactKeys(script, ["kind", "events"], "event script");
  required(script, ["kind", "events"], "event script");
  if (script.kind !== "events") throw new Error("event script.kind must be events");
  if (!Array.isArray(script.events)) throw new Error("event script.events must be an array");
  if (script.events.length === 0 || script.events.length > SCRIPTED_PROVIDER_LIMITS.eventsPerScript) {
    throw new Error(`event script.events must contain 1 to ${SCRIPTED_PROVIDER_LIMITS.eventsPerScript} events`);
  }
  let totalDelayMs = 0;
  const normalized = script.events.map((candidate, index): NormalizedEventStep => {
    let event: unknown = candidate;
    let delayMs = defaultDelayMs;
    if (isRecord(candidate) && Object.hasOwn(candidate, "event")) {
      exactKeys(candidate, ["event", "delayMs"], `event script.events[${index}]`);
      required(candidate, ["event"], `event script.events[${index}]`);
      event = candidate.event;
      if (candidate.delayMs !== undefined) {
        delayMs = boundedInteger(candidate.delayMs, `event script.events[${index}].delayMs`, 0, SCRIPTED_PROVIDER_LIMITS.delayMs);
      }
    }
    validateEvent(event, `event script.events[${index}]`);
    totalDelayMs += delayMs;
    return {
      event: cloneBounded(event, `event script.events[${index}]`, SCRIPTED_PROVIDER_LIMITS.scriptBytes),
      delayMs,
    };
  });
  if (totalDelayMs > SCRIPTED_PROVIDER_LIMITS.totalDelayMs) {
    throw new Error(`event script cumulative delay exceeds ${SCRIPTED_PROVIDER_LIMITS.totalDelayMs} ms`);
  }
  validateEventProtocol(normalized);
  cloneBounded(normalized, "event script", SCRIPTED_PROVIDER_LIMITS.scriptBytes);
  return normalized;
}

function validateEventProtocol(steps: readonly NormalizedEventStep[]): void {
  let terminals = 0;
  let starts = 0;
  let bodyStarted = false;
  const tools = new Map<number, { raw: string; ended: boolean; id?: string; name?: string }>();
  for (let index = 0; index < steps.length; index += 1) {
    const event = steps[index]!.event;
    if (terminalEvent(event)) {
      terminals += 1;
      if (index !== steps.length - 1) throw new Error("event script terminal event must be last");
      if (event.type === "error" && bodyStarted && !event.error.partial) {
        throw new Error("event script error after body data must set partial to true");
      }
      continue;
    }
    bodyStarted = true;
    if (event.type === "response_start") {
      starts += 1;
      if (index !== 0) throw new Error("event script response_start must be first");
      if (starts > 1) throw new Error("event script cannot contain multiple response_start events");
    } else if (starts === 0) {
      throw new Error(`${event.type} requires an earlier response_start event`);
    }
    if (event.type === "tool_call_start") {
      if (tools.has(event.index)) throw new Error(`event script starts tool index ${event.index} more than once`);
      tools.set(event.index, {
        raw: "",
        ended: false,
        ...(event.id === undefined ? {} : { id: event.id }),
        ...(event.name === undefined ? {} : { name: event.name }),
      });
    } else if (event.type === "tool_call_delta") {
      const tool = tools.get(event.index);
      if (tool === undefined || tool.ended) throw new Error(`event script has an out-of-order delta for tool index ${event.index}`);
      tool.raw += event.jsonFragment;
    } else if (event.type === "tool_call_end") {
      const tool = tools.get(event.index);
      if (tool === undefined || tool.ended) throw new Error(`event script has an out-of-order end for tool index ${event.index}`);
      if (tool.raw !== event.rawArguments) throw new Error(`event script fragments do not equal raw arguments for tool index ${event.index}`);
      if (tool.id !== undefined && event.id !== tool.id) throw new Error(`event script changes the ID for tool index ${event.index}`);
      if (tool.name !== undefined && event.name !== tool.name) throw new Error(`event script changes the name for tool index ${event.index}`);
      if (event.arguments !== undefined) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.rawArguments);
        } catch {
          throw new Error(`event script raw arguments are not JSON for tool index ${event.index}`);
        }
        if (!isDeepStrictEqual(parsed, event.arguments)) {
          throw new Error(`event script raw and parsed arguments differ for tool index ${event.index}`);
        }
      }
      tool.ended = true;
    }
  }
  if (terminals !== 1) throw new Error("event script must contain exactly one terminal event");
  for (const [index, tool] of tools) {
    if (!tool.ended) throw new Error(`event script does not end tool index ${index}`);
  }
}

function validateFragments(value: unknown, expected: string, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > SCRIPTED_PROVIDER_LIMITS.fragmentsPerBlock) {
    throw new Error(`${label} must contain at most ${SCRIPTED_PROVIDER_LIMITS.fragmentsPerBlock} fragments`);
  }
  const fragments = value.map((fragment, index) =>
    boundedString(fragment, `${label}[${index}]`, { empty: true, controls: true }));
  if (fragments.join("") !== expected) throw new Error(`${label} must concatenate exactly to the declared content`);
  return fragments;
}

function validateTurn(value: unknown, defaultDelayMs: number, defaultFragmentCharacters: number): ScriptedTurn {
  const turn = record(value, "turn script");
  exactKeys(turn, ["kind", "content", "responseId", "requestId", "usage", "terminal", "eventDelayMs"], "turn script");
  required(turn, ["kind"], "turn script");
  if (turn.kind !== "turn") throw new Error("turn script.kind must be turn");
  if (turn.responseId !== undefined) boundedString(turn.responseId, "turn script.responseId", { maxBytes: 4_096 });
  if (turn.requestId !== undefined) boundedString(turn.requestId, "turn script.requestId", { maxBytes: 4_096 });
  if (turn.eventDelayMs !== undefined) {
    boundedInteger(turn.eventDelayMs, "turn script.eventDelayMs", 0, SCRIPTED_PROVIDER_LIMITS.delayMs);
  }
  if (turn.usage !== undefined && turn.usage !== "estimate" && turn.usage !== false) {
    validateUsage(turn.usage, "turn script.usage");
  }
  let expandedEvents = 2 + (turn.usage === false ? 0 : 1);
  if (turn.content !== undefined) {
    if (!Array.isArray(turn.content) || turn.content.length > SCRIPTED_PROVIDER_LIMITS.contentBlocksPerTurn) {
      throw new Error(`turn script.content must contain at most ${SCRIPTED_PROVIDER_LIMITS.contentBlocksPerTurn} blocks`);
    }
    const toolIndices = new Set<number>();
    let nextToolIndex = 0;
    for (let index = 0; index < turn.content.length; index += 1) {
      const block = record(turn.content[index], `turn script.content[${index}]`);
      if (block.type === "text") {
        exactKeys(block, ["type", "text", "part", "fragments"], `turn script.content[${index}]`);
        required(block, ["type", "text"], `turn script.content[${index}]`);
        const text = boundedString(block.text, `turn script.content[${index}].text`, { empty: true, controls: true });
        optionalInteger(block.part, `turn script.content[${index}].part`, SCRIPTED_PROVIDER_LIMITS.contentBlocksPerTurn);
        const fragments = validateFragments(block.fragments, text, `turn script.content[${index}].fragments`);
        expandedEvents += fragments?.length ?? splitText(text, defaultFragmentCharacters).length;
      } else if (block.type === "reasoning") {
        exactKeys(block, ["type", "text", "part", "visibility", "fragments"], `turn script.content[${index}]`);
        required(block, ["type", "text"], `turn script.content[${index}]`);
        const text = boundedString(block.text, `turn script.content[${index}].text`, { empty: true, controls: true });
        optionalInteger(block.part, `turn script.content[${index}].part`, SCRIPTED_PROVIDER_LIMITS.contentBlocksPerTurn);
        if (block.visibility !== undefined && block.visibility !== "summary" && block.visibility !== "provider_trace") {
          throw new Error(`turn script.content[${index}].visibility is invalid`);
        }
        const fragments = validateFragments(block.fragments, text, `turn script.content[${index}].fragments`);
        expandedEvents += fragments?.length ?? splitText(text, defaultFragmentCharacters).length;
      } else if (block.type === "tool_call") {
        exactKeys(block, ["type", "name", "id", "index", "arguments", "rawArguments", "fragments", "parseError"], `turn script.content[${index}]`);
        required(block, ["type", "name"], `turn script.content[${index}]`);
        boundedString(block.name, `turn script.content[${index}].name`, { maxBytes: 1_024 });
        if (block.id !== undefined) boundedString(block.id, `turn script.content[${index}].id`, { maxBytes: 4_096 });
        const toolIndex = block.index === undefined
          ? nextToolIndex
          : boundedInteger(block.index, `turn script.content[${index}].index`, 0, SCRIPTED_PROVIDER_LIMITS.contentBlocksPerTurn);
        if (toolIndices.has(toolIndex)) throw new Error(`turn script repeats tool index ${toolIndex}`);
        toolIndices.add(toolIndex);
        nextToolIndex = Math.max(nextToolIndex, toolIndex + 1);
        if ((block.arguments === undefined) === (block.parseError === undefined)) {
          throw new Error(`turn script.content[${index}] must contain exactly one of arguments or parseError`);
        }
        if (block.arguments !== undefined) validateJson(block.arguments, `turn script.content[${index}].arguments`);
        if (block.parseError !== undefined) {
          boundedString(block.parseError, `turn script.content[${index}].parseError`, { maxBytes: 16 * 1024 });
        }
        const raw = block.rawArguments === undefined
          ? block.arguments === undefined ? "" : JSON.stringify(block.arguments)
          : boundedString(block.rawArguments, `turn script.content[${index}].rawArguments`, { empty: true, controls: true });
        if (block.arguments !== undefined) {
          try {
            const parsed: unknown = JSON.parse(raw);
            if (!isDeepStrictEqual(parsed, block.arguments)) {
              throw new Error("value mismatch");
            }
          } catch {
            throw new Error(`turn script.content[${index}].rawArguments must encode arguments exactly`);
          }
        }
        const fragments = validateFragments(block.fragments, raw, `turn script.content[${index}].fragments`);
        expandedEvents += 2 + (fragments?.length ?? splitText(raw, defaultFragmentCharacters).length);
      } else {
        throw new Error(`turn script.content[${index}].type is invalid`);
      }
    }
  }
  if (turn.terminal !== undefined) {
    const terminal = record(turn.terminal, "turn script.terminal");
    if (terminal.type === "finish") {
      exactKeys(terminal, ["type", "reason", "rawReason", "explanation", "state"], "turn script.terminal");
      if (terminal.reason !== undefined && !FINISH_REASONS.has(terminal.reason as FinishReason)) {
        throw new Error("turn script.terminal.reason is invalid");
      }
      if (terminal.rawReason !== undefined) boundedString(terminal.rawReason, "turn script.terminal.rawReason", { maxBytes: 4_096 });
      if (terminal.explanation !== undefined) boundedString(terminal.explanation, "turn script.terminal.explanation", { maxBytes: 4_096 });
      if (terminal.state !== undefined) validateState(terminal.state, "turn script.terminal.state");
    } else if (terminal.type === "error") {
      exactKeys(terminal, ["type", "error"], "turn script.terminal");
      required(terminal, ["type", "error"], "turn script.terminal");
      validateError(terminal.error, "turn script.terminal.error");
      if (terminal.error.partial !== true) throw new Error("a turn error follows response_start and must set partial to true");
    } else {
      throw new Error("turn script.terminal.type is invalid");
    }
  }
  if (expandedEvents > SCRIPTED_PROVIDER_LIMITS.eventsPerScript) {
    throw new Error(`turn script expands beyond ${SCRIPTED_PROVIDER_LIMITS.eventsPerScript} events`);
  }
  const delayMs = turn.eventDelayMs === undefined ? defaultDelayMs : turn.eventDelayMs as number;
  if (expandedEvents * delayMs > SCRIPTED_PROVIDER_LIMITS.totalDelayMs) {
    throw new Error(`turn script cumulative delay exceeds ${SCRIPTED_PROVIDER_LIMITS.totalDelayMs} ms`);
  }
  return cloneBounded(turn as unknown as ScriptedTurn, "turn script", SCRIPTED_PROVIDER_LIMITS.scriptBytes);
}

function validateResolvedStep(
  value: unknown,
  defaultDelayMs: number,
  defaultFragmentCharacters: number,
): ResolvedScriptedProviderStep {
  if (!isRecord(value)) throw new Error("script step must be a turn, event sequence, or factory");
  if (value.kind === "events") {
    const normalized = normalizeEventSequence(value, defaultDelayMs);
    return {
      kind: "events",
      events: normalized.map((entry) => entry.delayMs === defaultDelayMs
        ? entry.event
        : { event: entry.event, delayMs: entry.delayMs }),
    };
  }
  if (value.kind === "turn") return validateTurn(value, defaultDelayMs, defaultFragmentCharacters);
  throw new Error("script step.kind must be turn or events");
}

function splitText(value: string, characters: number): string[] {
  if (value === "") return [];
  const points = [...value];
  const output: string[] = [];
  for (let index = 0; index < points.length; index += characters) output.push(points.slice(index, index + characters).join(""));
  return output;
}

function promptText(request: ProviderRequest): string {
  return JSON.stringify({
    messages: request.messages,
    tools: request.tools,
    ...(request.providerState === undefined ? {} : { providerState: request.providerState }),
    ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
    ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
    ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
  });
}

function estimateTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / 4);
}

function commonPrefix(left: string, right: string): string {
  const maximum = Math.min(left.length, right.length);
  let index = 0;
  while (index < maximum && left[index] === right[index]) index += 1;
  return left.slice(0, index);
}

function defaultState(content: readonly ScriptedTurnBlock[], callCount: number): ProviderState {
  let toolIndex = 0;
  return {
    kind: "chat_completions",
    assistantMessage: {
      role: "assistant",
      content: content.map((block) => {
        if (block.type !== "tool_call") return { type: block.type, text: block.text };
        const index = block.index ?? toolIndex;
        toolIndex = Math.max(toolIndex, index + 1);
        return {
          type: "tool_call",
          name: block.name,
          id: block.id ?? `scripted_call_${callCount}_${index}`,
          ...(block.arguments === undefined ? {} : { arguments: block.arguments }),
        };
      }),
    },
  };
}

function validateModelDefinition(value: unknown, label: string, provider: ProviderId): ModelInfo {
  const definition = record(value, label);
  exactKeys(definition, ["id", "displayName", "contextTokens", "maxOutputTokens", "capabilities", "metadata"], label);
  required(definition, ["id"], label);
  const id = boundedString(definition.id, `${label}.id`, { maxBytes: 1_024 });
  if (definition.displayName !== undefined) boundedString(definition.displayName, `${label}.displayName`, { maxBytes: 4_096 });
  if (definition.contextTokens !== undefined) {
    boundedInteger(definition.contextTokens, `${label}.contextTokens`, 1, Number.MAX_SAFE_INTEGER);
  }
  if (definition.maxOutputTokens !== undefined) {
    boundedInteger(definition.maxOutputTokens, `${label}.maxOutputTokens`, 1, Number.MAX_SAFE_INTEGER);
  }
  const configured: Record<"tools" | "reasoning" | "images", CapabilityValue> = {
    tools: "supported",
    reasoning: "supported",
    images: "supported",
  };
  if (definition.capabilities !== undefined) {
    const capabilities = record(definition.capabilities, `${label}.capabilities`);
    exactKeys(capabilities, ["tools", "reasoning", "images"], `${label}.capabilities`);
    for (const key of ["tools", "reasoning", "images"] as const) {
      if (capabilities[key] !== undefined) {
        if (!CAPABILITIES.has(capabilities[key] as CapabilityValue)) throw new Error(`${label}.capabilities.${key} is invalid`);
        configured[key] = capabilities[key] as CapabilityValue;
      }
    }
  }
  if (definition.metadata !== undefined) validateJson(definition.metadata, `${label}.metadata`);
  const capability = (value: CapabilityValue) => ({ value, source: "configuration" as const, observedAt: DEFAULT_OBSERVED_AT });
  return {
    id,
    provider,
    ...(definition.displayName === undefined ? {} : { displayName: definition.displayName as string }),
    ...(definition.contextTokens === undefined ? { contextTokens: 128_000 } : { contextTokens: definition.contextTokens as number }),
    ...(definition.maxOutputTokens === undefined ? { maxOutputTokens: 16_384 } : { maxOutputTokens: definition.maxOutputTokens as number }),
    capabilities: {
      tools: capability(configured.tools),
      reasoning: capability(configured.reasoning),
      images: capability(configured.images),
    },
    ...(definition.metadata === undefined ? {} : { metadata: structuredClone(definition.metadata) as JsonValue }),
  };
}

function providerError(category: AdapterError["category"], message: string, partial = false): AdapterEvent {
  return {
    type: "error",
    error: {
      category,
      message: truncateUtf8(message, 64 * 1024),
      retryable: false,
      partial,
      ...(partial ? { bodyStarted: true } : {}),
    },
  };
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let bytes = 0;
  let output = "";
  for (const point of value) {
    const size = Buffer.byteLength(point, "utf8");
    if (bytes + size > maximumBytes) break;
    output += point;
    bytes += size;
  }
  return output;
}

function stepBytes(step: ScriptedProviderStep): number {
  if (typeof step === "function") return 0;
  return Buffer.byteLength(JSON.stringify(step), "utf8");
}

function cancelledEvent(signal: AbortSignal, partial: boolean): AdapterEvent {
  const reason = signal.reason;
  const message = reason instanceof Error
    ? reason.message
    : typeof reason === "string" && reason !== "" ? reason : "Scripted provider request was cancelled";
  return providerError("cancelled", message, partial);
}

async function waitForDelay(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  if (milliseconds === 0) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    return !signal.aborted;
  }
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve(true);
    }, milliseconds);
    const aborted = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", aborted, { once: true });
  });
}

async function resolveFactory(
  factory: ScriptedProviderFactory,
  context: ScriptedProviderFactoryContext,
  signal: AbortSignal,
): Promise<{ aborted: true } | { aborted: false; value: ResolvedScriptedProviderStep }> {
  if (signal.aborted) return { aborted: true };
  let removeAbort = (): void => {};
  const aborted = new Promise<{ aborted: true }>((resolve) => {
    const listener = (): void => resolve({ aborted: true });
    signal.addEventListener("abort", listener, { once: true });
    removeAbort = () => signal.removeEventListener("abort", listener);
  });
  try {
    const produced = Promise.resolve(factory(context, signal)).then((value) => ({ aborted: false as const, value }));
    return await Promise.race([produced, aborted]);
  } finally {
    removeAbort();
  }
}

/**
 * Offline `ProviderAdapter` for agent, extension, and integration tests.
 * Scripts are validated and cloned before queueing, consumed FIFO per call,
 * and always produce one normalized terminal event.
 */
export class ScriptedProvider implements ProviderAdapter {
  readonly id: ProviderId;
  readonly #models: ModelInfo[];
  readonly #modelById: Map<string, ModelInfo>;
  readonly #defaultEventDelayMs: number;
  readonly #defaultFragmentCharacters: number;
  readonly #estimateCache: boolean;
  readonly #maxCapturedRequests: number;
  readonly #promptCache = new Map<string, string>();
  readonly #requests: ProviderRequest[] = [];
  readonly #registries = new Set<ProviderRegistry>();
  readonly #lifetime = new AbortController();
  #scripts: ScriptedProviderStep[] = [];
  #queuedScriptBytes = 0;
  #callCount = 0;
  #disposed = false;

  constructor(options: ScriptedProviderOptions = {}) {
    const optionsRecord = record(options, "scripted provider options");
    exactKeys(optionsRecord, [
      "id",
      "models",
      "scripts",
      "defaultEventDelayMs",
      "defaultFragmentCharacters",
      "estimateCache",
      "maxCapturedRequests",
    ], "scripted provider options");
    this.id = options.id === undefined
      ? DEFAULT_PROVIDER_ID
      : boundedString(options.id, "scripted provider options.id", { maxBytes: 256 });
    this.#defaultEventDelayMs = options.defaultEventDelayMs === undefined
      ? 0
      : boundedInteger(options.defaultEventDelayMs, "scripted provider options.defaultEventDelayMs", 0, SCRIPTED_PROVIDER_LIMITS.delayMs);
    this.#defaultFragmentCharacters = options.defaultFragmentCharacters === undefined
      ? 8
      : boundedInteger(options.defaultFragmentCharacters, "scripted provider options.defaultFragmentCharacters", 1, 4_096);
    if (options.estimateCache !== undefined && typeof options.estimateCache !== "boolean") {
      throw new Error("scripted provider options.estimateCache must be boolean");
    }
    this.#estimateCache = options.estimateCache ?? true;
    this.#maxCapturedRequests = options.maxCapturedRequests === undefined
      ? SCRIPTED_PROVIDER_LIMITS.capturedRequests
      : boundedInteger(options.maxCapturedRequests, "scripted provider options.maxCapturedRequests", 1, SCRIPTED_PROVIDER_LIMITS.capturedRequests);
    const definitions = options.models ?? [{ id: DEFAULT_MODEL_ID }];
    if (!Array.isArray(definitions) || definitions.length === 0 || definitions.length > SCRIPTED_PROVIDER_LIMITS.models) {
      throw new Error(`scripted provider models must contain 1 to ${SCRIPTED_PROVIDER_LIMITS.models} entries`);
    }
    this.#models = definitions.map((definition, index) => validateModelDefinition(definition, `scripted provider models[${index}]`, this.id));
    this.#modelById = new Map();
    for (const model of this.#models) {
      if (this.#modelById.has(model.id)) throw new Error(`scripted provider model ID is duplicated: ${model.id}`);
      this.#modelById.set(model.id, model);
    }
    cloneBounded(this.#models, "scripted provider catalog", SCRIPTED_PROVIDER_LIMITS.catalogBytes);
    if (options.scripts !== undefined) this.setScripts(options.scripts);
  }

  get callCount(): number {
    return this.#callCount;
  }

  get pendingScriptCount(): number {
    return this.#scripts.length;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  get models(): readonly ModelInfo[] {
    return this.#models.map((model) => structuredClone(model));
  }

  getModel(modelId?: string): ModelInfo | undefined {
    const model = modelId === undefined ? this.#models[0] : this.#modelById.get(modelId);
    return model === undefined ? undefined : structuredClone(model);
  }

  capturedRequests(): readonly ProviderRequest[] {
    return this.#requests.map((request) => structuredClone(request));
  }

  clearCapturedRequests(): void {
    this.#requests.length = 0;
  }

  /** Atomically replaces all pending response scripts. */
  setScripts(scripts: readonly ScriptedProviderStep[]): void {
    this.#assertActive();
    const validated = this.#validateSteps(scripts);
    const bytes = validated.reduce((sum, step) => sum + stepBytes(step), 0);
    if (bytes > SCRIPTED_PROVIDER_LIMITS.queuedScriptBytes) {
      throw new Error(`scripted provider queue exceeds ${SCRIPTED_PROVIDER_LIMITS.queuedScriptBytes} serialized bytes`);
    }
    this.#scripts = validated;
    this.#queuedScriptBytes = bytes;
  }

  /** Atomically appends response scripts without disturbing pending work. */
  appendScripts(scripts: readonly ScriptedProviderStep[]): void {
    this.#assertActive();
    if (this.#scripts.length + scripts.length > SCRIPTED_PROVIDER_LIMITS.queuedScripts) {
      throw new Error(`scripted provider queue exceeds ${SCRIPTED_PROVIDER_LIMITS.queuedScripts} scripts`);
    }
    const validated = this.#validateSteps(scripts);
    const bytes = validated.reduce((sum, step) => sum + stepBytes(step), 0);
    if (this.#queuedScriptBytes + bytes > SCRIPTED_PROVIDER_LIMITS.queuedScriptBytes) {
      throw new Error(`scripted provider queue exceeds ${SCRIPTED_PROVIDER_LIMITS.queuedScriptBytes} serialized bytes`);
    }
    this.#scripts.push(...validated);
    this.#queuedScriptBytes += bytes;
  }

  /** Registers this exact adapter and returns an idempotent cleanup function. */
  register(registry: ProviderRegistry): () => boolean {
    this.#assertActive();
    registry.register(this);
    this.#registries.add(registry);
    let active = true;
    return () => {
      if (!active) return false;
      active = false;
      this.#registries.delete(registry);
      return registry.unregister(this.id, this);
    };
  }

  unregister(registry?: ProviderRegistry): boolean {
    if (registry !== undefined) {
      this.#registries.delete(registry);
      return registry.unregister(this.id, this);
    }
    let removed = false;
    for (const current of this.#registries) removed = current.unregister(this.id, this) || removed;
    this.#registries.clear();
    return removed;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.unregister();
    this.#lifetime.abort(new Error("Scripted provider was disposed"));
    this.#scripts.length = 0;
    this.#queuedScriptBytes = 0;
    this.#requests.length = 0;
    this.#promptCache.clear();
    this.#disposed = true;
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    this.#assertActive();
    signal.throwIfAborted();
    return this.#models.map((model) => structuredClone(model));
  }

  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    this.#callCount += 1;
    const callCount = this.#callCount;
    let captured: ProviderRequest;
    let model: ModelInfo | undefined;
    let failure: AdapterEvent | undefined;
    if (this.#disposed) {
      failure = providerError("provider", "Scripted provider is disposed");
      captured = request;
    } else {
      try {
        if (request.provider !== this.id) throw new Error(`request provider ${request.provider} does not match ${this.id}`);
        boundedString(request.model, "provider request.model", { maxBytes: 1_024 });
        model = this.#modelById.get(request.model);
        if (model === undefined) throw new Error(`model is not in the scripted catalog: ${request.model}`);
        if (this.#requests.length >= this.#maxCapturedRequests) {
          throw new Error(`captured request limit ${this.#maxCapturedRequests} reached`);
        }
        captured = cloneBounded(request, "provider request", SCRIPTED_PROVIDER_LIMITS.requestBytes);
        this.#requests.push(captured);
      } catch (error) {
        captured = request;
        failure = providerError("invalid_request", error instanceof Error ? error.message : String(error));
      }
    }
    const script = failure === undefined ? this.#scripts.shift() : undefined;
    if (script !== undefined) this.#queuedScriptBytes -= stepBytes(script);
    const effectiveSignal = this.#disposed || signal === this.#lifetime.signal
      ? signal
      : AbortSignal.any([signal, this.#lifetime.signal]);
    return this.#run(script, captured, model, callCount, effectiveSignal, failure);
  }

  async *#run(
    queued: ScriptedProviderStep | undefined,
    request: ProviderRequest,
    model: ModelInfo | undefined,
    callCount: number,
    signal: AbortSignal,
    initialFailure: AdapterEvent | undefined,
  ): AsyncIterable<AdapterEvent> {
    if (initialFailure !== undefined) {
      yield initialFailure;
      return;
    }
    if (signal.aborted) {
      yield cancelledEvent(signal, false);
      return;
    }
    if (queued === undefined) {
      yield providerError("provider", "No scripted provider response remains");
      return;
    }
    let resolved: ResolvedScriptedProviderStep;
    try {
      if (typeof queued === "function") {
        const result = await resolveFactory(queued, {
          request: structuredClone(request),
          model: structuredClone(model!),
          callCount,
        }, signal);
        if (result.aborted) {
          yield cancelledEvent(signal, false);
          return;
        }
        resolved = validateResolvedStep(
          result.value,
          this.#defaultEventDelayMs,
          this.#defaultFragmentCharacters,
        );
      } else {
        resolved = queued;
      }
    } catch (error) {
      if (signal.aborted) yield cancelledEvent(signal, false);
      else yield providerError("protocol", `Script factory failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    let steps: NormalizedEventStep[];
    try {
      steps = resolved.kind === "events"
        ? normalizeEventSequence(resolved, this.#defaultEventDelayMs)
        : this.#turnEvents(resolved, request, callCount);
    } catch (error) {
      yield providerError("protocol", `Script expansion failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    let bodyStarted = false;
    for (const step of steps) {
      if (signal.aborted) {
        yield cancelledEvent(signal, bodyStarted);
        return;
      }
      if (!await waitForDelay(step.delayMs, signal)) {
        yield cancelledEvent(signal, bodyStarted);
        return;
      }
      const event = structuredClone(step.event);
      const terminal = terminalEvent(event);
      if (!terminal) bodyStarted = true;
      yield event;
      if (terminal) return;
    }
  }

  #turnEvents(turn: ScriptedTurn, request: ProviderRequest, callCount: number): NormalizedEventStep[] {
    const content = [...(turn.content ?? [])];
    const delayMs = turn.eventDelayMs ?? this.#defaultEventDelayMs;
    const events: AdapterEvent[] = [{
      type: "response_start",
      model: request.model,
      ...(turn.responseId === undefined ? {} : { responseId: turn.responseId }),
      ...(turn.requestId === undefined ? {} : { requestId: turn.requestId }),
    }];
    let textPart = 0;
    let reasoningPart = 0;
    let toolIndex = 0;
    let outputText = "";
    let reasoningText = "";
    for (const block of content) {
      if (block.type === "text") {
        const part = block.part ?? textPart;
        textPart = Math.max(textPart, part + 1);
        outputText += block.text;
        for (const fragment of block.fragments ?? splitText(block.text, this.#defaultFragmentCharacters)) {
          events.push({ type: "text_delta", part, text: fragment });
        }
      } else if (block.type === "reasoning") {
        const part = block.part ?? reasoningPart;
        reasoningPart = Math.max(reasoningPart, part + 1);
        outputText += block.text;
        reasoningText += block.text;
        for (const fragment of block.fragments ?? splitText(block.text, this.#defaultFragmentCharacters)) {
          events.push({ type: "reasoning_delta", part, text: fragment, visibility: block.visibility ?? "summary" });
        }
      } else {
        const index = block.index ?? toolIndex;
        toolIndex = Math.max(toolIndex, index + 1);
        const id = block.id ?? `scripted_call_${callCount}_${index}`;
        const rawArguments = block.rawArguments ?? (block.arguments === undefined ? "" : JSON.stringify(block.arguments));
        outputText += `${block.name}:${rawArguments}`;
        events.push({
          type: "tool_call_start",
          index,
          id,
          name: block.name,
        });
        for (const fragment of block.fragments ?? splitText(rawArguments, this.#defaultFragmentCharacters)) {
          events.push({ type: "tool_call_delta", index, jsonFragment: fragment });
        }
        events.push({
          type: "tool_call_end",
          index,
          name: block.name,
          rawArguments,
          id,
          ...(block.arguments === undefined ? {} : { arguments: block.arguments }),
          ...(block.parseError === undefined ? {} : { parseError: block.parseError }),
        });
      }
    }
    if (turn.usage !== false) {
      const usage = turn.usage === undefined || turn.usage === "estimate"
        ? this.#estimatedUsage(request, outputText, reasoningText)
        : structuredClone(turn.usage);
      events.push({ type: "usage", usage, semantics: "final" });
    }
    const terminal = turn.terminal;
    if (terminal?.type === "error") events.push({ type: "error", error: structuredClone(terminal.error) });
    else {
      const hasTools = content.some((block) => block.type === "tool_call");
      events.push({
        type: "response_end",
        reason: terminal?.reason ?? (hasTools ? "tool_calls" : "stop"),
        state: terminal?.state === undefined ? defaultState(content, callCount) : structuredClone(terminal.state),
        ...(terminal?.rawReason === undefined ? {} : { rawReason: terminal.rawReason }),
        ...(terminal?.explanation === undefined ? {} : { explanation: terminal.explanation }),
      });
    }
    const normalized = events.map((event) => ({ event, delayMs }));
    validateEventProtocol(normalized);
    if (normalized.length > SCRIPTED_PROVIDER_LIMITS.eventsPerScript) {
      throw new Error(`turn script expands beyond ${SCRIPTED_PROVIDER_LIMITS.eventsPerScript} events`);
    }
    if (normalized.length * delayMs > SCRIPTED_PROVIDER_LIMITS.totalDelayMs) {
      throw new Error(`turn script cumulative delay exceeds ${SCRIPTED_PROVIDER_LIMITS.totalDelayMs} ms`);
    }
    cloneBounded(normalized, "expanded turn script", SCRIPTED_PROVIDER_LIMITS.scriptBytes);
    return normalized;
  }

  #estimatedUsage(request: ProviderRequest, outputText: string, reasoningText: string): NormalizedUsage {
    const prompt = promptText(request);
    const promptTokens = estimateTokens(prompt);
    let inputTokens = promptTokens;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    if (this.#estimateCache && request.sessionId !== undefined && request.sessionId !== "") {
      const cacheKey = `${request.model}\0${request.sessionId}`;
      const previous = this.#promptCache.get(cacheKey);
      if (previous === undefined) cacheWriteTokens = promptTokens;
      else {
        const prefix = commonPrefix(previous, prompt);
        cacheReadTokens = estimateTokens(prefix);
        cacheWriteTokens = estimateTokens(prompt.slice(prefix.length));
      }
      inputTokens = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
      if (this.#promptCache.has(cacheKey)) this.#promptCache.delete(cacheKey);
      this.#promptCache.set(cacheKey, prompt);
      while (this.#promptCache.size > SCRIPTED_PROVIDER_LIMITS.cacheEntries) {
        const oldest = this.#promptCache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.#promptCache.delete(oldest);
      }
    }
    const outputTokens = estimateTokens(outputText);
    const reasoningTokens = estimateTokens(reasoningText);
    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
      ...(reasoningTokens === 0 ? {} : { reasoningTokens }),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      raw: { simulated: true },
    };
  }

  #validateSteps(scripts: readonly ScriptedProviderStep[]): ScriptedProviderStep[] {
    if (!Array.isArray(scripts)) throw new Error("scripted provider scripts must be an array");
    if (scripts.length > SCRIPTED_PROVIDER_LIMITS.queuedScripts) {
      throw new Error(`scripted provider queue exceeds ${SCRIPTED_PROVIDER_LIMITS.queuedScripts} scripts`);
    }
    return scripts.map((step, index) => {
      if (typeof step === "function") return step;
      try {
        return validateResolvedStep(step, this.#defaultEventDelayMs, this.#defaultFragmentCharacters);
      } catch (error) {
        throw new Error(`Invalid scripted provider step ${index}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("Scripted provider is disposed");
  }
}

export function createScriptedProvider(options: ScriptedProviderOptions = {}): ScriptedProvider {
  return new ScriptedProvider(options);
}
