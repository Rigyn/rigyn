import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  PushableAssistantMessageEventStream,
  SimpleStreamOptions,
  StopReason,
  Tool,
  ToolCall,
  Usage,
} from "./contracts.js";
import { fetchEventStream, normalizedHeaders, type HttpStreamRequest } from "./http-engine.js";
import { promptCacheKey } from "./api/openai-prompt-cache.js";
import { createAssistantMessageEventStream, emptyUsage } from "./streaming.js";
import { calculateCost, contentText, errorMessage } from "./utilities.js";

type RecordValue = Record<string, unknown>;

const MAX_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_WEBSOCKET_BYTES = 64 * 1024 * 1024;
const MAX_WEBSOCKET_EVENTS = 65_536;
const MAX_ASSISTANT_BLOCKS = 1_024;
const MAX_ASSISTANT_FIELD_BYTES = 4 * 1024 * 1024;
const MAX_ASSISTANT_CONTENT_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_ID_BYTES = 4_096;
const MAX_RESPONSE_MODEL_BYTES = 1_024;
const MAX_TOOL_CALL_ID_BYTES = 1_024;
const MAX_TOOL_CALL_NAME_BYTES = 256;
const MAX_TOOL_ARGUMENT_VALUES = 8_192;
const MAX_TOOL_ARGUMENT_CONTAINERS = 8_192;
const MAX_TOOL_ARGUMENT_DEPTH = 59;
const MAX_RETRIES = 10;
const MAX_TIMER = 2_147_483_647;
const MAX_CACHED_WEBSOCKETS = 16;
const WEBSOCKET_LIFETIME_MS = 55 * 60 * 1000;
const EMPTY_TOOL_ARGUMENT_BYTES = 2;
const utf8Encoder = new TextEncoder();

interface WebSocketLike extends EventTarget {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

type WebSocketConstructor = new (
  url: string,
  options?: { headers?: Record<string, string> },
) => WebSocketLike;

interface CachedWebSocket {
  key: string;
  socket: WebSocketLike;
  tail: Promise<void>;
  previousResponseId: string | undefined;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  lifetimeTimer: ReturnType<typeof setTimeout>;
  cachePromise: Promise<CachedWebSocket> | undefined;
}

const cachedWebSockets = new Map<string, Promise<CachedWebSocket>>();
const CURRENT_REASONING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const OPENAI_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

function assertCurrentReasoningLevel(value: unknown, model: Model): void {
  const mappedValues = Object.values(model.thinkingLevelMap ?? {}).filter((candidate) => candidate !== null);
  if (
    value !== undefined &&
    (typeof value !== "string" || (!CURRENT_REASONING_LEVELS.has(value) && !mappedValues.includes(value)))
  ) {
    throw new RangeError(`Reasoning level must be one of: ${[...CURRENT_REASONING_LEVELS].join(", ")}`);
  }
  assertCurrentProviderReasoningEffort(value);
}

function assertCurrentProviderReasoningEffort(value: unknown): void {
  if (typeof value === "string" && value.toLocaleLowerCase("en-US") === "ultra") {
    throw new RangeError("Reasoning effort ultra is not supported");
  }
}

function assertOpenAIReasoningEffort(value: unknown): void {
  if (value !== undefined && value !== null && (typeof value !== "string" || !OPENAI_REASONING_EFFORTS.has(value))) {
    throw new RangeError(`OpenAI reasoning effort must be one of: ${[...OPENAI_REASONING_EFFORTS].join(", ")}`);
  }
}

class CanonicalWriter {
  readonly stream: PushableAssistantMessageEventStream;
  readonly #model: Model;
  readonly #message: AssistantMessage;
  readonly #arguments = new Map<number, string>();
  readonly #argumentBytes = new Map<number, number>();
  readonly #fieldBytes = new Map<number, number>();
  readonly #signatureBytes = new Map<number, number>();
  readonly #open = new Set<number>();
  #contentBytes = 0;

  constructor(model: Model, onCancel?: () => void) {
    this.#model = model;
    this.stream = createAssistantMessageEventStream(onCancel);
    this.#message = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "pending",
      timestamp: Date.now(),
    };
    this.stream.push({ type: "start", partial: this.snapshot() });
  }

  snapshot(): AssistantMessage {
    const message = this.#message;
    return {
      ...message,
      content: message.content.map((block) => block.type === "toolCall"
        ? { ...block, arguments: structuredClone(block.arguments) }
        : { ...block }),
      usage: {
        ...message.usage,
        ...(message.usage.cost === undefined ? {} : { cost: { ...message.usage.cost } }),
      },
      ...(message.diagnostics === undefined ? {} : { diagnostics: structuredClone(message.diagnostics) }),
      ...(message.providerState === undefined ? {} : { providerState: structuredClone(message.providerState) }),
    };
  }

  setResponseIdentity(id: unknown, model: unknown): string | undefined {
    const responseId = optionalResponseIdentity(id, "response ID", MAX_RESPONSE_ID_BYTES);
    const responseModel = optionalResponseIdentity(model, "response model", MAX_RESPONSE_MODEL_BYTES);
    if (responseModel !== undefined) this.#message.responseModel = responseModel;
    if (responseId !== undefined) this.#message.responseId = responseId;
    return responseId;
  }

  clearResponseIdentity(): void {
    delete this.#message.responseId;
    delete this.#message.responseModel;
  }

  text(delta: string, thinking = false): void {
    if (!delta) return;
    const kind = thinking ? "thinking" : "text";
    let index = this.#message.content.length - 1;
    let block = this.#message.content[index];
    const deltaBytes = byteLength(delta);
    const fieldBytes = block?.type === kind && this.#open.has(index) ? this.#fieldBytes.get(index) ?? 0 : 0;
    if (deltaBytes > MAX_ASSISTANT_FIELD_BYTES - fieldBytes) {
      throw new RangeError(`Assistant ${kind} content exceeded 4 MiB`);
    }
    if (deltaBytes > MAX_ASSISTANT_CONTENT_BYTES - this.#contentBytes) {
      throw new RangeError("Assistant content exceeded 8 MiB");
    }
    if (block?.type !== kind || !this.#open.has(index)) {
      if (this.#message.content.length >= MAX_ASSISTANT_BLOCKS) {
        throw new RangeError(`Assistant content exceeded ${MAX_ASSISTANT_BLOCKS} blocks`);
      }
      index = this.#message.content.length;
      block = thinking ? { type: "thinking", thinking: "" } : { type: "text", text: "" };
      this.#message.content.push(block);
      this.#open.add(index);
      this.stream.push(thinking
        ? { type: "thinking_start", contentIndex: index, partial: this.snapshot() }
        : { type: "text_start", contentIndex: index, partial: this.snapshot() });
    }
    if (block.type === "thinking") block.thinking += delta;
    else if (block.type === "text") block.text += delta;
    this.#fieldBytes.set(index, fieldBytes + deltaBytes);
    this.#contentBytes += deltaBytes;
    this.stream.push(thinking
      ? { type: "thinking_delta", contentIndex: index, delta, partial: this.snapshot() }
      : { type: "text_delta", contentIndex: index, delta, partial: this.snapshot() });
  }

  startTool(id: string, name: string, index?: number): number {
    const toolId = requiredToolIdentity(id, "tool-call ID", MAX_TOOL_CALL_ID_BYTES);
    const toolName = requiredToolIdentity(name, "tool-call name", MAX_TOOL_CALL_NAME_BYTES);
    const target = index ?? this.#message.content.length;
    if (!Number.isSafeInteger(target) || target < 0 || target >= MAX_ASSISTANT_BLOCKS) {
      throw new RangeError(`Assistant tool-call index must be below ${MAX_ASSISTANT_BLOCKS}`);
    }
    const present = this.#message.content[target];
    if (present?.type !== "toolCall") {
      const retainedBytes = this.#contentBytes -
        (this.#fieldBytes.get(target) ?? 0) -
        (this.#signatureBytes.get(target) ?? 0);
      if (EMPTY_TOOL_ARGUMENT_BYTES > MAX_ASSISTANT_CONTENT_BYTES - retainedBytes) {
        throw new RangeError("Assistant content exceeded 8 MiB");
      }
      this.#contentBytes = retainedBytes + EMPTY_TOOL_ARGUMENT_BYTES;
    }
    while (this.#message.content.length < target) this.#message.content.push({ type: "text", text: "" });
    const existing = this.#message.content[target];
    if (existing?.type !== "toolCall") {
      this.#fieldBytes.delete(target);
      this.#signatureBytes.delete(target);
      this.#message.content[target] = { type: "toolCall", id: toolId, name: toolName, arguments: {} };
      this.#arguments.set(target, "");
      this.#argumentBytes.set(target, 0);
      this.#open.add(target);
      this.stream.push({
        type: "toolcall_start",
        contentIndex: target,
        id: toolId,
        name: toolName,
        partial: this.snapshot(),
      });
    }
    return target;
  }

  toolDelta(index: number, delta: string): void {
    if (!delta) return;
    if (this.#message.content[index]?.type !== "toolCall" || !this.#open.has(index)) {
      throw new TypeError("Tool arguments require an active tool call");
    }
    const deltaBytes = byteLength(delta);
    const argumentBytes = this.#argumentBytes.get(index) ?? 0;
    if (deltaBytes > MAX_ASSISTANT_FIELD_BYTES - argumentBytes) {
      throw new RangeError("Tool arguments exceeded 4 MiB");
    }
    const retainedBytes = this.#contentBytes - Math.max(argumentBytes, EMPTY_TOOL_ARGUMENT_BYTES);
    const nextArgumentBytes = argumentBytes + deltaBytes;
    const nextContentBytes = retainedBytes + Math.max(nextArgumentBytes, EMPTY_TOOL_ARGUMENT_BYTES);
    if (nextContentBytes > MAX_ASSISTANT_CONTENT_BYTES) {
      throw new RangeError("Assistant content exceeded 8 MiB");
    }
    this.#arguments.set(index, (this.#arguments.get(index) ?? "") + delta);
    this.#argumentBytes.set(index, nextArgumentBytes);
    this.#contentBytes = nextContentBytes;
    this.stream.push({ type: "toolcall_delta", contentIndex: index, delta, partial: this.snapshot() });
  }

  thinkingSignature(delta: string): void {
    if (!delta) return;
    const index = this.#message.content.length - 1;
    const block = this.#message.content[index];
    if (block?.type !== "thinking" || !this.#open.has(index)) {
      throw new TypeError("Thinking signatures require active thinking content");
    }
    const deltaBytes = byteLength(delta);
    const signatureBytes = this.#signatureBytes.get(index) ?? 0;
    if (deltaBytes > MAX_ASSISTANT_FIELD_BYTES - signatureBytes) {
      throw new RangeError("Thinking signature exceeded 4 MiB");
    }
    if (deltaBytes > MAX_ASSISTANT_CONTENT_BYTES - this.#contentBytes) {
      throw new RangeError("Assistant content exceeded 8 MiB");
    }
    block.thinkingSignature = (block.thinkingSignature ?? "") + delta;
    this.#signatureBytes.set(index, signatureBytes + deltaBytes);
    this.#contentBytes += deltaBytes;
  }

  finishTool(index: number, finalArguments?: unknown): void {
    const block = this.#message.content[index];
    if (block?.type !== "toolCall" || !this.#open.has(index)) return;
    const raw = this.#arguments.get(index) ?? "";
    const retainedBytes = this.#contentBytes - Math.max(
      this.#argumentBytes.get(index) ?? 0,
      EMPTY_TOOL_ARGUMENT_BYTES,
    );
    try {
      const finalized = canonicalArguments(finalArguments ?? parseArguments(raw));
      if (finalized.bytes > MAX_ASSISTANT_CONTENT_BYTES - retainedBytes) {
        throw new RangeError("Assistant content exceeded 8 MiB");
      }
      this.#completeTool(index, block, finalized.value, finalized.bytes, retainedBytes);
    } catch (cause) {
      this.#discardTool(index, retainedBytes);
      throw cause;
    }
  }

  #discardTool(index: number, retainedBytes: number): void {
    this.#message.content.splice(index, 1);
    this.#contentBytes = retainedBytes;
    this.#removeIndex(this.#arguments, index);
    this.#removeIndex(this.#argumentBytes, index);
    this.#removeIndex(this.#fieldBytes, index);
    this.#removeIndex(this.#signatureBytes, index);
    this.#open.delete(index);
    for (const current of [...this.#open]) {
      if (current <= index) continue;
      this.#open.delete(current);
      this.#open.add(current - 1);
    }
  }

  #removeIndex<T>(values: Map<number, T>, index: number): void {
    values.delete(index);
    for (const [current, value] of [...values]) {
      if (current <= index) continue;
      values.delete(current);
      values.set(current - 1, value);
    }
  }

  #completeTool(
    index: number,
    block: ToolCall,
    argumentsValue: RecordValue,
    argumentBytes: number,
    retainedBytes: number,
  ): void {
    block.arguments = argumentsValue;
    this.#contentBytes = retainedBytes + argumentBytes;
    this.#arguments.delete(index);
    this.#argumentBytes.delete(index);
    this.#open.delete(index);
    this.stream.push({ type: "toolcall_end", contentIndex: index, toolCall: structuredClone(block), partial: this.snapshot() });
  }

  usage(value: Partial<Usage>): void {
    const usage = this.#message.usage;
    for (const field of ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "totalTokens"] as const) {
      const candidate = value[field];
      if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0) usage[field] = candidate;
    }
    if (usage.cacheWrite1h !== undefined && (
      usage.cacheWrite === undefined || usage.cacheWrite1h > usage.cacheWrite
    )) delete usage.cacheWrite1h;
    const knownComponents = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
      .filter((candidate): candidate is number => candidate !== undefined);
    const knownTotal = tokenSum(...knownComponents);
    if (knownComponents.length > 0 && knownTotal === undefined) {
      delete usage.input;
      delete usage.output;
      delete usage.cacheRead;
      delete usage.cacheWrite;
      delete usage.cacheWrite1h;
      delete usage.totalTokens;
      return;
    }
    if (usage.totalTokens !== undefined && knownTotal !== undefined && usage.totalTokens < knownTotal) {
      delete usage.totalTokens;
    }
    if (
      usage.input !== undefined && usage.output !== undefined &&
      usage.cacheRead !== undefined && usage.cacheWrite !== undefined
    ) {
      const total = tokenSum(usage.input, usage.output, usage.cacheRead, usage.cacheWrite);
      if (total === undefined) {
        delete usage.input;
        delete usage.output;
        delete usage.cacheRead;
        delete usage.cacheWrite;
        delete usage.cacheWrite1h;
        delete usage.totalTokens;
      } else {
        usage.totalTokens = total;
      }
    }
  }

  done(reason: Exclude<StopReason, "pending" | "error" | "aborted"> = "stop"): void {
    this.#closeParts();
    this.#message.stopReason = reason;
    const usage = this.#message.usage;
    if (
      usage.totalTokens === undefined && usage.input !== undefined && usage.output !== undefined &&
      usage.cacheRead !== undefined && usage.cacheWrite !== undefined
    ) {
      const total = tokenSum(usage.input, usage.output, usage.cacheRead, usage.cacheWrite);
      if (total !== undefined) usage.totalTokens = total;
    }
    const cost = calculateCost(this.#model, usage);
    if (cost !== undefined) usage.cost = cost;
    this.stream.push({ type: "done", reason, message: this.snapshot() });
  }

  fail(cause: unknown, aborted = false): void {
    this.#closeParts(true);
    this.#message.stopReason = aborted ? "aborted" : "error";
    if (!aborted) this.#message.errorMessage = errorMessage(cause);
    const error = this.snapshot();
    this.stream.push({ type: "error", reason: aborted ? "aborted" : "error", error });
  }

  #closeParts(ignoreToolErrors = false): void {
    for (const index of [...this.#open]) {
      const block = this.#message.content[index];
      if (block?.type === "toolCall") {
        try { this.finishTool(index); } catch (cause) {
          if (!ignoreToolErrors) throw cause;
        }
      }
      else if (block?.type === "text") {
        this.#open.delete(index);
        this.stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: this.snapshot() });
      } else if (block?.type === "thinking") {
        this.#open.delete(index);
        this.stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: this.snapshot() });
      }
    }
  }
}

function parseArguments(raw: string): unknown {
  if (!raw.trim()) return {};
  if (byteLength(raw) > MAX_ASSISTANT_FIELD_BYTES) throw new Error("Tool arguments exceeded 4 MiB");
  try { return JSON.parse(raw); } catch { throw new TypeError("Tool arguments must be valid JSON"); }
}

function canonicalArguments(value: unknown): { value: RecordValue; bytes: number } {
  const selected = recordArguments(value);
  let serialized: string | undefined;
  try { serialized = JSON.stringify(selected); } catch { throw new TypeError("Tool arguments must be JSON-serializable"); }
  if (serialized === undefined) throw new TypeError("Tool arguments must be JSON-serializable");
  const bytes = byteLength(serialized);
  if (bytes > MAX_ASSISTANT_FIELD_BYTES) throw new RangeError("Tool arguments exceeded 4 MiB");
  const detached: unknown = JSON.parse(serialized);
  if (!isRecord(detached)) throw new TypeError("Tool arguments must serialize to an object");
  validateToolArgumentComplexity(detached);
  return { value: detached, bytes };
}

function validateToolArgumentComplexity(value: RecordValue): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let values = 0;
  let containers = 0;
  while (pending.length > 0) {
    const selected = pending.pop();
    if (selected === undefined) break;
    values += 1;
    if (values > MAX_TOOL_ARGUMENT_VALUES) {
      throw new RangeError(`Tool arguments exceeded ${MAX_TOOL_ARGUMENT_VALUES} JSON values`);
    }
    if (selected.depth > MAX_TOOL_ARGUMENT_DEPTH) {
      throw new RangeError(`Tool arguments exceeded ${MAX_TOOL_ARGUMENT_DEPTH} levels`);
    }
    if (selected.value === null || typeof selected.value !== "object") continue;
    containers += 1;
    if (containers > MAX_TOOL_ARGUMENT_CONTAINERS) {
      throw new RangeError(`Tool arguments exceeded ${MAX_TOOL_ARGUMENT_CONTAINERS} JSON containers`);
    }
    const children = Array.isArray(selected.value) ? selected.value : Object.values(selected.value);
    if (children.length > MAX_TOOL_ARGUMENT_VALUES - values - pending.length) {
      throw new RangeError(`Tool arguments exceeded ${MAX_TOOL_ARGUMENT_VALUES} JSON values`);
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({ value: children[index], depth: selected.depth + 1 });
    }
  }
}

function byteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

function optionalResponseIdentity(value: unknown, label: string, maximumBytes: number): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" || value === "" || byteLength(value) > maximumBytes ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) throw new TypeError(`Invalid ${label}`);
  return value;
}

function requiredToolIdentity(value: unknown, label: string, maximumBytes: number): string {
  const selected = optionalResponseIdentity(value, label, maximumBytes);
  if (selected === undefined) throw new TypeError(`Invalid ${label}`);
  return selected;
}

function recordArguments(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { input: value };
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function tokenSum(...values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  if (present.length === 0) return undefined;
  const total = present.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : undefined;
}

function apiKey(options: SimpleStreamOptions): string {
  const value = options.apiKey;
  if (typeof value !== "string" || !value) throw new Error("Transport requires an API key");
  return value;
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/${path.replace(/^\/+/, "")}`;
}

function userContent(
  content: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>,
  style: "responses" | "chat" | "anthropic" | "google",
): unknown {
  if (typeof content === "string") return style === "google" ? [{ text: content }] : content;
  if (style === "responses") return content.map((part) => part.type === "text"
    ? { type: "input_text", text: part.text }
    : { type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}` });
  if (style === "chat") return content.map((part) => part.type === "text"
    ? { type: "text", text: part.text }
    : { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } });
  if (style === "anthropic") return content.map((part) => part.type === "text"
    ? { type: "text", text: part.text }
    : { type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } });
  return content.map((part) => part.type === "text"
    ? { text: part.text }
    : { inlineData: { mimeType: part.mimeType, data: part.data } });
}

function messageMatchesModel(message: AssistantMessage, model: Model | undefined): boolean {
  return model !== undefined && message.api === model.api && message.provider === model.provider && message.model === model.id;
}

function openAiResponsesInput(context: Context, model?: Model): unknown[] {
  const input: unknown[] = [];
  for (const message of context.messages) {
    if (message.role === "user") input.push({ role: "user", content: userContent(message.content, "responses") });
    else if (message.role === "toolResult") input.push({
      type: "function_call_output",
      call_id: message.toolCallId,
      output: typeof message.content === "string" ? message.content : contentText(message.content),
    });
    else {
      const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
      if (text) input.push({ role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
      for (const part of message.content) {
        if (part.type === "toolCall") input.push({ type: "function_call", call_id: part.id, name: part.name, arguments: JSON.stringify(part.arguments) });
      }
      const state = message.providerState;
      if (
        state
        && model !== undefined
        && messageMatchesModel(message, model)
        && state.source.api === model.api
        && state.source.provider === model.provider
        && state.source.model === model.id
        && isRecord(state.value)
      ) {
        input.push(structuredClone(state.value));
      }
    }
  }
  return input;
}

function toolSchema(tool: Tool, kimi: boolean): RecordValue {
  const schema = structuredClone(tool.parameters) as unknown;
  return isRecord(schema) ? (kimi ? normalizeKimiSchema(schema) : schema) : { type: "object", properties: {} };
}

function normalizeKimiSchema(schema: RecordValue): RecordValue {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isRecord(value)) return value;
    const copy: RecordValue = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
    if (isRecord(copy.properties) && typeof copy.type !== "string") copy.type = "object";
    if (copy.items !== undefined && typeof copy.type !== "string") copy.type = "array";
    if (Array.isArray(copy.enum) && typeof copy.type !== "string" && copy.enum.length > 0) {
      const kind = typeof copy.enum[0];
      if (kind === "string" || kind === "number" || kind === "boolean") copy.type = kind === "number" ? "number" : kind;
    }
    return copy;
  };
  return visit(schema) as RecordValue;
}

function openAiTools(
  tools: readonly Tool[] | undefined,
  responses: boolean,
  kimi = false,
  compatibility?: Model["compat"],
): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => {
    const sampling = tool.constrainedSampling || undefined;
    const grammar = sampling?.type === "grammar" ? sampling : undefined;
    if (grammar && responses && (compatibility?.supportsOpenAIGrammarTools || compatibility?.supportsGrammarTools)) {
      const selected = grammar.variants.openai_lark !== undefined
        ? { syntax: "lark", definition: grammar.variants.openai_lark }
        : grammar.variants.openai_regex !== undefined
          ? { syntax: "regex", definition: grammar.variants.openai_regex }
          : undefined;
      if (selected) return {
        type: "custom",
        name: tool.name,
        description: tool.description,
        format: { type: "grammar", ...selected },
      };
    }
    const definition = {
      name: tool.name,
      description: tool.description,
      parameters: toolSchema(tool, kimi),
      ...(sampling?.type === "json_schema" && (compatibility?.supportsStrictMode || compatibility?.supportsStrictTools)
        ? { strict: true }
        : {}),
    };
    return responses ? { type: "function", ...definition } : { type: "function", function: definition };
  });
}

function openAiCacheOptions(model: Model, options: SimpleStreamOptions): RecordValue {
  const retention = options.cacheRetention;
  const sessionId = options.sessionId?.trim();
  const explicit = model.compat?.supportsExplicitPromptCacheMode === true;
  if (retention === "long" && (explicit || model.compat?.supportsLongCacheRetention === false)) {
    throw new Error(`Model ${model.id} does not support long prompt-cache retention`);
  }
  const key = sessionId && retention !== "none" ? promptCacheKey(sessionId, model.id) : undefined;
  if (key && new TextEncoder().encode(key).byteLength > 64) {
    throw new RangeError("OpenAI prompt cache key must not exceed 64 bytes");
  }
  return {
    ...(key ? { prompt_cache_key: key } : {}),
    ...(retention === "none" && explicit ? { prompt_cache_options: { mode: "explicit" } } : {}),
    ...(retention === "short"
      ? explicit ? { prompt_cache_options: { ttl: "30m" } } : { prompt_cache_retention: "in_memory" }
      : {}),
    ...(retention === "long" ? { prompt_cache_retention: "24h" } : {}),
  };
}

function openAiResponseBody(
  model: Model,
  context: Context,
  options: SimpleStreamOptions,
  platformFeatures = true,
): RecordValue {
  const tools = openAiTools(context.tools, true, false, model.compat);
  const reasoning = options.reasoning;
  const mappedReasoning = reasoning === undefined || reasoning === "off"
    ? undefined
    : Object.hasOwn(model.thinkingLevelMap ?? {}, reasoning)
      ? model.thinkingLevelMap?.[reasoning]
      : reasoning;
  assertCurrentProviderReasoningEffort(mappedReasoning);
  if (model.provider === "openai" || model.provider === "openai-codex" || model.provider === "azure-openai") {
    assertOpenAIReasoningEffort(mappedReasoning);
  }
  return {
    model: model.id,
    stream: true,
    input: openAiResponsesInput(context, model),
    ...(context.systemPrompt ? { instructions: context.systemPrompt } : {}),
    ...(tools ? { tools } : {}),
    ...(options.toolChoice ? { tool_choice: openAiToolChoice(options.toolChoice) } : {}),
    ...(options.maxTokens ? { max_output_tokens: options.maxTokens } : {}),
    ...(model.reasoning && reasoning && reasoning !== "off" && mappedReasoning !== null
      ? { reasoning: { effort: mappedReasoning ?? reasoning, summary: "auto" } }
      : {}),
    ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
    ...(typeof options.serviceTier === "string" ? { service_tier: options.serviceTier } : {}),
    ...(platformFeatures && options.metadata !== undefined ? { metadata: structuredClone(options.metadata) } : {}),
    ...(platformFeatures ? openAiCacheOptions(model, options) : {}),
  };
}

function openAiToolChoice(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return value.type === "tool" && typeof value.name === "string" ? { type: "function", name: value.name } : value;
}

export function streamOpenAIResponses(
  model: Model<"openai-responses">,
  context: Context,
  options: SimpleStreamOptions = {},
): AssistantMessageEventStream {
  return run(model, async (writer, selectedOptions) => {
    const body = openAiResponseBody(model, context, selectedOptions);
    const transport = selectedOptions.transport ?? "sse";
    if (transport === "sse") {
      await streamOpenAiResponseSse(writer, model, body, selectedOptions);
      return;
    }
    const state = openAiResponseState();
    try {
      await streamOpenAiResponseWebSocket(writer, model, context, body, selectedOptions, state);
    } catch (cause) {
      if (transport !== "auto" || state.substantive || selectedOptions.signal?.aborted) throw cause;
      writer.clearResponseIdentity();
      await streamOpenAiResponseSse(writer, model, body, selectedOptions);
    }
  }, options);
}

interface OpenAiResponseState {
  tools: Map<string, number>;
  textParts: Map<string, string>;
  reasoningParts: Map<string, string>;
  substantive: boolean;
  responseId: string | undefined;
}

class ResponsesStreamConnectionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResponsesStreamConnectionError";
  }
}

class ResponsesWebSocketConnectionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResponsesWebSocketConnectionError";
  }
}

function isNativeError(value: unknown): value is Error {
  const isError = (Error as ErrorConstructor & { isError?: (candidate: unknown) => boolean }).isError;
  return isError?.(value) === true;
}

function safeTransportErrorCode(cause: unknown): string | undefined {
  const seen = new Set<Error>();
  let selected = cause;
  for (let depth = 0; depth < 5 && isNativeError(selected) && !seen.has(selected); depth += 1) {
    seen.add(selected);
    const codeDescriptor = Object.getOwnPropertyDescriptor(selected, "code");
    const code = codeDescriptor !== undefined && "value" in codeDescriptor ? codeDescriptor.value : undefined;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(code)) return code;
    const causeDescriptor = Object.getOwnPropertyDescriptor(selected, "cause");
    selected = causeDescriptor !== undefined && "value" in causeDescriptor ? causeDescriptor.value : undefined;
  }
  return undefined;
}

function webSocketEventError(event: Event): Error | undefined {
  let selected: unknown;
  try { selected = (event as ErrorEvent).error; } catch { return undefined; }
  return isNativeError(selected) ? selected : undefined;
}

function webSocketCloseCode(event: Event): number | undefined {
  let code: unknown;
  try {
    code = (event as CloseEvent).code;
  } catch {
    return undefined;
  }
  return typeof code === "number" && Number.isInteger(code) && code >= 1_000 && code <= 4_999
    ? code
    : undefined;
}

function webSocketCloseLabel(code: number): string {
  switch (code) {
    case 1000: return "normal closure";
    case 1001: return "going away";
    case 1002: return "protocol error";
    case 1003: return "unsupported data";
    case 1005: return "no status received";
    case 1006: return "abnormal closure";
    case 1007: return "invalid payload";
    case 1008: return "policy violation";
    case 1009: return "message too big";
    case 1010: return "required extension missing";
    case 1011: return "server error";
    case 1012: return "service restart";
    case 1013: return "try again later";
    case 1014: return "bad gateway";
    case 1015: return "TLS handshake failure";
    default: return code >= 3000 ? "application closure" : "unrecognized closure";
  }
}

function webSocketFailure(message: string, cause?: Error): ResponsesWebSocketConnectionError {
  const code = safeTransportErrorCode(cause);
  return new ResponsesWebSocketConnectionError(
    `${message}${code === undefined ? "" : ` (${code})`}`,
    cause,
  );
}

function webSocketCloseFailure(message: string, event: Event, cause?: Error): ResponsesWebSocketConnectionError {
  const closeCode = webSocketCloseCode(event);
  const transportCode = safeTransportErrorCode(cause);
  const detail = closeCode === undefined ? "unknown" : `${closeCode}: ${webSocketCloseLabel(closeCode)}`;
  return new ResponsesWebSocketConnectionError(
    `${message} (${detail}${transportCode === undefined ? "" : `; ${transportCode}`})`,
    cause,
  );
}

async function* safeOpenAiResponseEvents(events: AsyncIterable<{ event: string; data: string }>): AsyncGenerator<{
  event: string;
  data: string;
}> {
  try {
    yield* events;
  } catch (cause) {
    if (!isNativeError(cause) || !(cause instanceof TypeError)) throw cause;
    const code = safeTransportErrorCode(cause);
    throw new ResponsesStreamConnectionError(
      `Responses stream connection terminated${code === undefined ? "" : ` (${code})`}`,
      cause,
    );
  }
}

function openAiResponseState(): OpenAiResponseState {
  return {
    tools: new Map(),
    textParts: new Map(),
    reasoningParts: new Map(),
    substantive: false,
    responseId: undefined,
  };
}

function openAiResponsePartKeys(outputIndex: number | undefined, itemId: string | undefined, part: number): string[] {
  const keys: string[] = [];
  if (itemId !== undefined) keys.push(`item:${itemId}:${part}`);
  if (outputIndex !== undefined) keys.push(`output:${outputIndex}:${part}`);
  return keys.length > 0 ? keys : [`unscoped:${part}`];
}

function firstOpenAiResponsePart(parts: Map<string, string>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = parts.get(key);
    if (value !== undefined) return value;
  }
  return "";
}

function appendOpenAiResponseDelta(parts: Map<string, string>, keys: readonly string[], delta: string): void {
  const complete = `${firstOpenAiResponsePart(parts, keys)}${delta}`;
  for (const key of keys) parts.set(key, complete);
}

function reconcileOpenAiResponseSnapshot(
  writer: CanonicalWriter,
  state: OpenAiResponseState,
  parts: Map<string, string>,
  keys: readonly string[],
  text: string,
  thinking = false,
  visible = true,
): void {
  if (text === "") return;
  state.substantive = true;
  const previous = firstOpenAiResponsePart(parts, keys);
  const missing = text.startsWith(previous) ? text.slice(previous.length) : "";
  if (missing === "") return;
  for (const key of keys) parts.set(key, text);
  if (visible) writer.text(missing, thinking);
}

function openAiResponseContentHasSemanticContent(value: unknown): boolean {
  if (!isRecord(value)) return true;
  if (value.type === "output_text") {
    const text = string(value.text);
    return text === undefined
      || (value.annotations !== undefined && !Array.isArray(value.annotations))
      || text !== ""
      || (Array.isArray(value.annotations) && value.annotations.length > 0);
  }
  if (value.type === "refusal") {
    const refusal = string(value.refusal);
    return refusal === undefined || refusal !== "";
  }
  if (value.type === "reasoning_text" || value.type === "summary_text") {
    const text = string(value.text);
    return text === undefined || text !== "";
  }
  return true;
}

function openAiResponseContentListHasSemanticContent(
  value: unknown,
  allowedTypes?: ReadonlySet<string>,
): boolean {
  if (value === undefined) return false;
  return !Array.isArray(value) || value.some((entry) => {
    if (allowedTypes !== undefined && (!isRecord(entry) || !allowedTypes.has(string(entry.type) ?? ""))) return true;
    return openAiResponseContentHasSemanticContent(entry);
  });
}

const openAiMessageContentTypes = new Set(["output_text", "refusal"]);
const openAiReasoningSummaryTypes = new Set(["summary_text"]);
const openAiReasoningContentTypes = new Set(["reasoning_text"]);

function openAiResponseItemHasSemanticContent(item: RecordValue): boolean {
  if (item.type === "function_call" || item.type === "custom_tool_call") return true;
  if (item.type === "message") {
    return item.content === undefined
      || openAiResponseContentListHasSemanticContent(item.content, openAiMessageContentTypes);
  }
  if (item.type === "reasoning") {
    if (
      item.encrypted_content !== undefined
      && item.encrypted_content !== null
      && string(item.encrypted_content) === undefined
    ) return true;
    return (string(item.encrypted_content) ?? "") !== ""
      || openAiResponseContentListHasSemanticContent(item.summary, openAiReasoningSummaryTypes)
      || openAiResponseContentListHasSemanticContent(item.content, openAiReasoningContentTypes);
  }
  return true;
}

function openAiResponseObjectHasSemanticOutput(value: unknown): boolean {
  const output = isRecord(value) ? value.output : undefined;
  if (output === undefined) return false;
  if (!Array.isArray(output)) return true;
  return output.some((item) => !isRecord(item) || openAiResponseItemHasSemanticContent(item));
}

async function streamOpenAiResponseSse(
  writer: CanonicalWriter,
  model: Model,
  body: RecordValue,
  options: SimpleStreamOptions,
  request?: Pick<HttpStreamRequest, "url" | "model" | "authorization">,
): Promise<void> {
  let allowTransportRetry = true;
  while (true) {
    const response = await fetchEventStream({
      url: request?.url ?? endpoint(model.baseUrl, "responses"),
      body,
      model: request?.model ?? model,
      headers: options.headers,
      options,
      authorization: request?.authorization ?? { value: apiKey(options) },
    });
    const state = openAiResponseState();
    try {
      for await (const event of safeOpenAiResponseEvents(response.events)) {
        if (event.data === "[DONE]") break;
        if (applyOpenAiResponseEvent(writer, state, parseRecord(event.data), event.event)) return;
      }
      throw new ResponsesStreamConnectionError("OpenAI Responses stream ended before response.completed");
    } catch (cause) {
      if (
        !(cause instanceof ResponsesStreamConnectionError)
        || !allowTransportRetry
        || state.substantive
        || options.signal?.aborted
      ) throw cause;
      allowTransportRetry = false;
      writer.clearResponseIdentity();
    }
  }
}

function applyOpenAiResponseEvent(
  writer: CanonicalWriter,
  state: OpenAiResponseState,
  value: RecordValue,
  eventType?: string,
): boolean {
  const type = string(value.type) ?? eventType;
  if (
    type === "response.created"
    || type === "response.in_progress"
    || type === "response.queued"
    || type === "response.metadata"
    || type === "codex.rate_limits"
    || type === "codex.response.metadata"
    || type === "responsesapi.websocket_timing"
  ) {
    const responseValue = value.response;
    const response = isRecord(responseValue) ? responseValue : undefined;
    if (type === "response.created" && response !== undefined) {
      state.responseId = writer.setResponseIdentity(response.id, response.model);
    }
    const requiresResponse = type === "response.created"
      || type === "response.in_progress"
      || type === "response.queued";
    state.substantive ||= response === undefined
      ? requiresResponse || responseValue !== undefined
      : openAiResponseObjectHasSemanticOutput(response);
  } else if (type === "response.output_text.delta" || type === "response.refusal.delta") {
    const delta = string(value.delta);
    if (delta === undefined) {
      state.substantive = true;
    } else if (delta !== "") {
      state.substantive = true;
      const keys = openAiResponsePartKeys(
        number(value.output_index),
        string(value.item_id),
        number(value.content_index) ?? 0,
      );
      appendOpenAiResponseDelta(state.textParts, keys, delta);
      writer.text(delta);
    }
  } else if (type === "response.reasoning_summary_text.delta") {
    const delta = string(value.delta);
    if (delta === undefined) {
      state.substantive = true;
    } else if (delta !== "") {
      state.substantive = true;
      const keys = openAiResponsePartKeys(
        number(value.output_index),
        string(value.item_id),
        number(value.summary_index) ?? 0,
      ).map((key) => `summary:${key}`);
      appendOpenAiResponseDelta(state.reasoningParts, keys, delta);
      writer.text(delta, true);
    }
  } else if (type === "response.reasoning_text.delta") {
    // Raw reasoning text is provider-private. It still makes the attempt
    // substantive, so automatic transport fallback cannot replay the request.
    const delta = string(value.delta);
    if (delta === undefined) {
      state.substantive = true;
    } else if (delta !== "") {
      state.substantive = true;
      const keys = openAiResponsePartKeys(
        number(value.output_index),
        string(value.item_id),
        number(value.content_index) ?? 0,
      ).map((key) => `reasoning:${key}`);
      appendOpenAiResponseDelta(state.reasoningParts, keys, delta);
    }
  } else if (type === "response.output_text.done" || type === "response.refusal.done") {
    const text = type === "response.refusal.done" ? string(value.refusal) : string(value.text);
    if (text !== undefined) {
      reconcileOpenAiResponseSnapshot(
        writer,
        state,
        state.textParts,
        openAiResponsePartKeys(
          number(value.output_index),
          string(value.item_id),
          number(value.content_index) ?? 0,
        ),
        text,
      );
    } else {
      state.substantive = true;
    }
  } else if (type === "response.reasoning_summary_text.done" || type === "response.reasoning_text.done") {
    const text = string(value.text);
    if (text !== undefined) {
      const summary = type === "response.reasoning_summary_text.done";
      reconcileOpenAiResponseSnapshot(
        writer,
        state,
        state.reasoningParts,
        openAiResponsePartKeys(
          number(value.output_index),
          string(value.item_id),
          summary ? number(value.summary_index) ?? 0 : number(value.content_index) ?? 0,
        ).map((key) => `${summary ? "summary" : "reasoning"}:${key}`),
        text,
        summary,
        summary,
      );
    } else {
      state.substantive = true;
    }
  } else if (type === "response.content_part.added" || type === "response.content_part.done") {
    const part = isRecord(value.part) ? value.part : undefined;
    const validPart = part?.type === "output_text" || part?.type === "refusal" || part?.type === "reasoning_text";
    state.substantive ||= !validPart || openAiResponseContentHasSemanticContent(part);
    const keys = openAiResponsePartKeys(
      number(value.output_index),
      string(value.item_id),
      number(value.content_index) ?? 0,
    );
    if (part?.type === "output_text" || part?.type === "refusal") {
      const text = part.type === "refusal" ? string(part.refusal) : string(part.text);
      if (text !== undefined) {
        reconcileOpenAiResponseSnapshot(writer, state, state.textParts, keys, text);
      }
    } else if (part?.type === "reasoning_text") {
      const text = string(part.text);
      if (text !== undefined) {
        reconcileOpenAiResponseSnapshot(
          writer,
          state,
          state.reasoningParts,
          keys.map((key) => `reasoning:${key}`),
          text,
          false,
          false,
        );
      }
    }
  } else if (type === "response.reasoning_summary_part.added" || type === "response.reasoning_summary_part.done") {
    const part = isRecord(value.part) ? value.part : undefined;
    state.substantive ||= part?.type !== "summary_text" || openAiResponseContentHasSemanticContent(part);
    if (part?.type === "summary_text") {
      const text = string(part.text);
      if (text !== undefined) {
        reconcileOpenAiResponseSnapshot(
          writer,
          state,
          state.reasoningParts,
          openAiResponsePartKeys(
            number(value.output_index),
            string(value.item_id),
            number(value.summary_index) ?? 0,
          ).map((key) => `summary:${key}`),
          text,
          true,
        );
      }
    }
  } else if (type === "response.output_item.added" || type === "response.output_item.done") {
    const item = isRecord(value.item) ? value.item : undefined;
    state.substantive ||= item === undefined || openAiResponseItemHasSemanticContent(item);
    if (item?.type === "function_call" || item?.type === "custom_tool_call") {
      const key = string(item.id) ?? string(item.call_id) ?? String(value.output_index ?? state.tools.size);
      if (type === "response.output_item.added") {
        const index = writer.startTool(string(item.call_id) ?? key, string(item.name) ?? "tool");
        state.tools.set(key, index);
      } else {
        const index = state.tools.get(key);
        if (index !== undefined) {
          if (item.type === "custom_tool_call") writer.finishTool(index, { input: string(item.input) ?? "" });
          else {
            const finalArguments = string(item.arguments);
            writer.finishTool(index, finalArguments === undefined ? undefined : parseArguments(finalArguments));
          }
        }
      }
    } else if (item?.type === "message" && Array.isArray(item.content)) {
      const outputIndex = number(value.output_index);
      const itemId = string(item.id);
      for (const [contentIndex, candidate] of item.content.entries()) {
        const part = isRecord(candidate) ? candidate : undefined;
        const text = part?.type === "output_text"
          ? string(part.text)
          : part?.type === "refusal"
            ? string(part.refusal)
            : undefined;
        if (text !== undefined) {
          reconcileOpenAiResponseSnapshot(
            writer,
            state,
            state.textParts,
            openAiResponsePartKeys(outputIndex, itemId, contentIndex),
            text,
          );
        }
      }
    } else if (item?.type === "reasoning") {
      const outputIndex = number(value.output_index);
      const itemId = string(item.id);
      const reasoning = [
        ...(Array.isArray(item.summary)
          ? item.summary.map((part, index) => ({ part, index, summary: true }))
          : []),
        ...(Array.isArray(item.content)
          ? item.content.map((part, index) => ({ part, index, summary: false }))
          : []),
      ];
      for (const entry of reasoning) {
        const text = string(isRecord(entry.part) ? entry.part.text : undefined);
        if (text !== undefined) {
          reconcileOpenAiResponseSnapshot(
            writer,
            state,
            state.reasoningParts,
            openAiResponsePartKeys(outputIndex, itemId, entry.index)
              .map((key) => `${entry.summary ? "summary" : "reasoning"}:${key}`),
            text,
            entry.summary,
            entry.summary,
          );
        }
      }
    }
  } else if (type === "response.function_call_arguments.delta" || type === "response.custom_tool_call_input.delta") {
    state.substantive = true;
    const key = string(value.item_id) ?? String(value.output_index ?? "");
    const index = state.tools.get(key) ?? writer.startTool(string(value.call_id) ?? key, string(value.name) ?? "tool");
    writer.toolDelta(index, string(value.delta) ?? "");
  } else if (type === "response.function_call_arguments.done" || type === "response.custom_tool_call_input.done") {
    state.substantive = true;
  } else if (type === "response.completed" || type === "response.incomplete") {
    const response = isRecord(value.response) ? value.response : {};
    applyOpenAiUsage(writer, response.usage);
    state.responseId = writer.setResponseIdentity(response.id, response.model) ?? state.responseId;
    writer.done(type === "response.incomplete" ? "length" : state.tools.size ? "toolUse" : "stop");
    return true;
  } else if (type === "response.failed" || type === "error") {
    const response = isRecord(value.response) ? value.response : value;
    throw new Error(string((isRecord(response.error) ? response.error : {}).message) ?? "OpenAI response failed");
  } else {
    state.substantive = true;
  }
  return false;
}

async function streamOpenAiResponseWebSocket(
  writer: CanonicalWriter,
  model: Model,
  context: Context,
  body: RecordValue,
  options: SimpleStreamOptions,
  state: OpenAiResponseState,
): Promise<void> {
  const cached = options.transport === "websocket-cached"
    || (options.transport === "auto" && Boolean(options.sessionId?.trim()));
  if (options.transport === "websocket-cached" && !options.sessionId?.trim()) {
    throw new Error("websocket-cached transport requires a non-empty sessionId");
  }
  const retries = boundedOption("maxRetries", options.maxRetries, 0, MAX_RETRIES);
  const maxRetryDelayMs = boundedOption("maxRetryDelayMs", options.maxRetryDelayMs, 60_000, MAX_TIMER);
  const url = webSocketUrl(endpoint(model.baseUrl, "responses"));
  const headers = normalizedHeaders({ authorization: `Bearer ${apiKey(options)}` }, options.headers);
  for (let attempt = 1; ; attempt += 1) {
    let connection: CachedWebSocket | undefined;
    let socket: WebSocketLike | undefined;
    try {
      if (cached) {
        const key = await webSocketCacheKey(url, options.sessionId!.trim(), headers, model);
        connection = await getCachedWebSocket(key, url, headers, model, options, attempt);
        await useCachedWebSocket(connection, async () => {
          if (connection?.idleTimer) {
            clearTimeout(connection.idleTimer);
            connection.idleTimer = undefined;
          }
          const payload = await openAiWebSocketPayload(model, context, body, options, connection?.previousResponseId);
          await readOpenAiWebSocket(connection!.socket, url, headers, payload, writer, state, options, attempt);
          connection!.previousResponseId = state.responseId;
          scheduleCachedWebSocketIdle(connection!, options);
        });
      } else {
        socket = await openWebSocket(url, headers, model, options, attempt);
        const payload = await openAiWebSocketPayload(model, context, body, options);
        await readOpenAiWebSocket(socket, url, headers, payload, writer, state, options, attempt);
      }
      return;
    } catch (cause) {
      if (connection) closeCachedWebSocket(connection);
      else socket?.close(1011, "request failed");
      if (state.substantive || options.signal?.aborted || attempt > retries) throw cause;
      state.responseId = undefined;
      writer.clearResponseIdentity();
      await webSocketRetryWait(
        maxRetryDelayMs === 0
          ? Math.min(250 * 2 ** Math.max(0, attempt - 1), MAX_TIMER)
          : Math.min(250 * 2 ** Math.max(0, attempt - 1), maxRetryDelayMs),
        options.signal,
      );
    } finally {
      if (!cached) socket?.close(1000, "response complete");
    }
  }
}

async function openAiWebSocketPayload(
  model: Model,
  context: Context,
  body: RecordValue,
  options: SimpleStreamOptions,
  previousResponseId?: string,
): Promise<RecordValue> {
  const payload = structuredClone(body);
  delete payload.stream;
  delete payload.background;
  payload.type = "response.create";
  const incremental = previousResponseId === undefined ? undefined : openAiIncrementalInput(context, previousResponseId, model);
  if (incremental !== undefined) {
    payload.previous_response_id = previousResponseId;
    payload.input = incremental;
  }
  const replacement = options.onPayload
    ? await options.onPayload(structuredClone(payload), model)
    : undefined;
  if (replacement !== undefined) {
    if (!isRecord(replacement)) throw new TypeError("WebSocket payload hook must return an object");
    return { ...replacement, type: "response.create" };
  }
  return payload;
}

function openAiIncrementalInput(context: Context, responseId: string, model: Model): unknown[] | undefined {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message?.role === "assistant" && message.responseId === responseId && messageMatchesModel(message, model)) {
      return openAiResponsesInput({ ...context, messages: context.messages.slice(index + 1) }, model);
    }
  }
  return undefined;
}

async function readOpenAiWebSocket(
  socket: WebSocketLike,
  url: string,
  headers: Record<string, string>,
  payload: RecordValue,
  writer: CanonicalWriter,
  state: OpenAiResponseState,
  options: SimpleStreamOptions,
  attempt: number,
): Promise<void> {
  const idleTimeout = boundedOption("websocketIdleTimeoutMs", options.websocketIdleTimeoutMs, 60_000, MAX_TIMER);
  const requestTimeout = boundedOption("timeoutMs", options.timeoutMs, 0, MAX_TIMER);
  await options.onRequest?.({
    url,
    method: "WEBSOCKET",
    headers: redactTransportHeaders(headers),
    body: structuredClone(payload),
    attempt,
  });
  await new Promise<void>((resolve, reject) => {
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let requestTimer: ReturnType<typeof setTimeout> | undefined;
    let eventCount = 0;
    let totalBytes = 0;
    let settled = false;
    let pendingSocketError: Error | undefined;
    let pendingSocketErrorImmediate: ReturnType<typeof setImmediate> | undefined;
    const finish = (cause?: unknown) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (requestTimer) clearTimeout(requestTimer);
      if (pendingSocketErrorImmediate !== undefined) {
        clearImmediate(pendingSocketErrorImmediate);
        pendingSocketErrorImmediate = undefined;
      }
      socket.removeEventListener("message", message);
      socket.removeEventListener("error", failed);
      socket.removeEventListener("close", closed);
      options.signal?.removeEventListener("abort", aborted);
      if (cause === undefined) resolve();
      else reject(cause);
    };
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (idleTimeout === 0) return;
      idleTimer = setTimeout(() => finish(new Error("Responses WebSocket became idle")), idleTimeout);
      unrefTimer(idleTimer);
    };
    const message = (event: Event) => {
      try {
        eventCount += 1;
        if (eventCount > MAX_WEBSOCKET_EVENTS) {
          throw new Error(`Responses WebSocket exceeded ${MAX_WEBSOCKET_EVENTS} events`);
        }
        const data = (event as MessageEvent<unknown>).data;
        if (typeof data !== "string") throw new Error("Responses WebSocket event was not text JSON");
        const dataBytes = byteLength(data);
        if (dataBytes > MAX_EVENT_BYTES) throw new Error("WebSocket event exceeded 8 MiB");
        if (dataBytes > MAX_WEBSOCKET_BYTES - totalBytes) throw new Error("Responses WebSocket exceeded 64 MiB");
        totalBytes += dataBytes;
        resetIdle();
        if (data === "[DONE]") {
          throw new Error("Responses WebSocket ended before response.completed");
        } else if (applyOpenAiResponseEvent(writer, state, parseRecord(data))) finish();
      } catch (cause) {
        state.substantive = true;
        finish(cause);
      }
    };
    const failed = (event: Event) => {
      pendingSocketError = webSocketEventError(event);
      pendingSocketErrorImmediate ??= setImmediate(() => {
        pendingSocketErrorImmediate = undefined;
        finish(webSocketFailure("Responses WebSocket failed", pendingSocketError));
      });
    };
    const closed = (event: Event) => {
      if (pendingSocketErrorImmediate !== undefined) {
        clearImmediate(pendingSocketErrorImmediate);
        pendingSocketErrorImmediate = undefined;
      }
      finish(webSocketCloseFailure(
        "Responses WebSocket closed before completion",
        event,
        pendingSocketError,
      ));
    };
    const aborted = () => finish(options.signal?.reason ?? new DOMException("Aborted", "AbortError"));
    socket.addEventListener("message", message);
    socket.addEventListener("error", failed);
    socket.addEventListener("close", closed);
    options.signal?.addEventListener("abort", aborted, { once: true });
    if (options.signal?.aborted) {
      aborted();
      return;
    }
    resetIdle();
    if (requestTimeout > 0) {
      requestTimer = setTimeout(() => finish(new Error("Responses WebSocket request timed out")), requestTimeout);
      unrefTimer(requestTimer);
    }
    try { socket.send(JSON.stringify(payload)); } catch (cause) { finish(cause); }
  });
}

async function openWebSocket(
  url: string,
  headers: Record<string, string>,
  model: Model,
  options: SimpleStreamOptions,
  attempt: number,
): Promise<WebSocketLike> {
  if (!globalThis.process?.versions?.node) {
    throw new Error("Authenticated Responses WebSocket transport requires Node.js");
  }
  const Constructor = globalThis.WebSocket as unknown as WebSocketConstructor | undefined;
  if (typeof Constructor !== "function") throw new Error("This Node.js runtime does not provide WebSocket");
  const connectTimeout = boundedOption("websocketConnectTimeoutMs", options.websocketConnectTimeoutMs, 30_000, MAX_TIMER);
  const socket = new Constructor(url, { headers });
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingSocketError: Error | undefined;
    let pendingSocketErrorImmediate: ReturnType<typeof setImmediate> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (pendingSocketErrorImmediate !== undefined) {
        clearImmediate(pendingSocketErrorImmediate);
        pendingSocketErrorImmediate = undefined;
      }
      socket.removeEventListener("open", opened);
      socket.removeEventListener("error", failed);
      socket.removeEventListener("close", closed);
      options.signal?.removeEventListener("abort", aborted);
    };
    const opened = () => { cleanup(); resolve(); };
    const failed = (event: Event) => {
      pendingSocketError = webSocketEventError(event);
      pendingSocketErrorImmediate ??= setImmediate(() => {
        pendingSocketErrorImmediate = undefined;
        cleanup();
        reject(webSocketFailure("Responses WebSocket connection failed", pendingSocketError));
      });
    };
    const closed = (event: Event) => {
      cleanup();
      reject(webSocketCloseFailure("Responses WebSocket closed while connecting", event, pendingSocketError));
    };
    const aborted = () => {
      cleanup();
      socket.close(1000, "aborted");
      reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    socket.addEventListener("open", opened);
    socket.addEventListener("error", failed);
    socket.addEventListener("close", closed);
    options.signal?.addEventListener("abort", aborted, { once: true });
    if (options.signal?.aborted) {
      aborted();
      return;
    }
    if (connectTimeout > 0) {
      timer = setTimeout(() => {
        cleanup();
        socket.close(1000, "connect timeout");
        reject(new Error("Responses WebSocket connection timed out"));
      }, connectTimeout);
      unrefTimer(timer);
    }
  });
  await options.onResponse?.({ url, status: 101, headers: {}, attempt }, model);
  return socket;
}

async function webSocketCacheKey(
  url: string,
  sessionId: string,
  headers: Record<string, string>,
  model: Model,
): Promise<string> {
  const data = JSON.stringify([
    url,
    sessionId,
    model.api,
    model.provider,
    model.id,
    Object.entries(headers).sort(([left], [right]) => left.localeCompare(right)),
  ]);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function getCachedWebSocket(
  key: string,
  url: string,
  headers: Record<string, string>,
  model: Model,
  options: SimpleStreamOptions,
  attempt: number,
): Promise<CachedWebSocket> {
  const present = cachedWebSockets.get(key);
  if (present) {
    const entry = await present;
    if (entry.socket.readyState === 1) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      cachedWebSockets.delete(key);
      cachedWebSockets.set(key, present);
      return entry;
    }
    closeCachedWebSocket(entry);
  }
  while (cachedWebSockets.size >= MAX_CACHED_WEBSOCKETS) {
    const oldest = cachedWebSockets.entries().next().value as [string, Promise<CachedWebSocket>] | undefined;
    if (!oldest) break;
    cachedWebSockets.delete(oldest[0]);
    void oldest[1].then(closeCachedWebSocket, () => undefined);
  }
  const pending = (async () => {
    const socket = await openWebSocket(url, headers, model, options, attempt);
    const entry: CachedWebSocket = {
      key,
      socket,
      tail: Promise.resolve(),
      previousResponseId: undefined,
      idleTimer: undefined,
      lifetimeTimer: setTimeout(() => closeCachedWebSocket(entry), WEBSOCKET_LIFETIME_MS),
      cachePromise: undefined,
    };
    unrefTimer(entry.lifetimeTimer);
    return entry;
  })();
  cachedWebSockets.set(key, pending);
  try {
    const entry = await pending;
    entry.cachePromise = pending;
    return entry;
  } catch (cause) {
    if (cachedWebSockets.get(key) === pending) cachedWebSockets.delete(key);
    throw cause;
  }
}

async function useCachedWebSocket<T>(entry: CachedWebSocket, operation: () => Promise<T>): Promise<T> {
  const result = entry.tail.then(operation, operation);
  entry.tail = result.then(() => undefined, () => undefined);
  return result;
}

function scheduleCachedWebSocketIdle(entry: CachedWebSocket, options: SimpleStreamOptions): void {
  const timeout = boundedOption("websocketIdleTimeoutMs", options.websocketIdleTimeoutMs, 60_000, MAX_TIMER);
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  if (timeout === 0) return;
  entry.idleTimer = setTimeout(() => closeCachedWebSocket(entry), timeout);
  unrefTimer(entry.idleTimer);
}

function closeCachedWebSocket(entry: CachedWebSocket): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  clearTimeout(entry.lifetimeTimer);
  if (cachedWebSockets.get(entry.key) === entry.cachePromise) cachedWebSockets.delete(entry.key);
  if (entry.socket.readyState < 2) entry.socket.close(1000, "cache expired");
}

function webSocketUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  else if (parsed.protocol === "http:") parsed.protocol = "ws:";
  else if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") throw new Error("Responses WebSocket requires an HTTP(S) base URL");
  return parsed.href;
}

function redactTransportHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name,
    /authorization|api[-_]?key|token|cookie/iu.test(name) ? "[redacted]" : value,
  ]));
}

function boundedOption(name: string, value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 0 and ${maximum}`);
  }
  return value;
}

function webSocketRetryWait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    const aborted = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
}

function applyOpenAiUsage(writer: CanonicalWriter, value: unknown): void {
  if (!isRecord(value)) return;
  const inputDetails = isRecord(value.input_tokens_details) ? value.input_tokens_details : {};
  const outputDetails = isRecord(value.output_tokens_details) ? value.output_tokens_details : {};
  const nativeInput = number(value.input_tokens);
  const output = number(value.output_tokens);
  const cacheRead = number(inputDetails.cached_tokens);
  const cacheWrite = number(inputDetails.cache_write_tokens);
  const reportedCache = tokenSum(cacheRead ?? 0, cacheWrite ?? 0);
  const input = nativeInput === undefined || reportedCache === undefined || reportedCache > nativeInput
    ? undefined
    : nativeInput - reportedCache;
  const reportedTotal = number(value.total_tokens);
  const derivedTotal = nativeInput === undefined || output === undefined ? undefined : tokenSum(nativeInput, output);
  const totalTokens = reportedTotal === undefined || (
    derivedTotal !== undefined && reportedTotal < derivedTotal
  ) ? derivedTotal : reportedTotal;
  writer.usage({
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    ...(number(outputDetails.reasoning_tokens) === undefined ? {} : { reasoning: number(outputDetails.reasoning_tokens)! }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  });
}

function chatMessages(context: Context): unknown[] {
  const messages: unknown[] = [];
  if (context.systemPrompt) messages.push({ role: "system", content: context.systemPrompt });
  for (const message of context.messages) {
    if (message.role === "user") messages.push({ role: "user", content: userContent(message.content, "chat") });
    else if (message.role === "toolResult") messages.push({ role: "tool", tool_call_id: message.toolCallId, content: contentText(message.content) });
    else {
      const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
      const toolCalls = message.content.filter((part): part is ToolCall => part.type === "toolCall").map((part) => ({
        id: part.id,
        type: "function",
        function: { name: part.name, arguments: JSON.stringify(part.arguments) },
      }));
      messages.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    }
  }
  return messages;
}

export function streamOpenAICompletions(
  model: Model<"openai-completions">,
  context: Context,
  options: SimpleStreamOptions = {},
): AssistantMessageEventStream {
  return run(model, async (writer, selectedOptions) => {
    const kimi = model.provider === "kimi-code" ||
      (/^opencode(?:-go)?$/u.test(model.provider) && /kimi/i.test(model.id)) ||
      /moonshot/i.test(model.baseUrl);
    const tools = openAiTools(context.tools, false, kimi, model.compat);
    const maxTokensField = model.compat?.maxTokensField ?? "max_tokens";
    const reasoningEffort = model.provider === "kimi-code" && model.reasoning &&
      selectedOptions.reasoning !== undefined && selectedOptions.reasoning !== "off" &&
      model.compat?.supportsReasoningEffort !== false
      ? Object.hasOwn(model.thinkingLevelMap ?? {}, selectedOptions.reasoning)
        ? model.thinkingLevelMap?.[selectedOptions.reasoning] ?? undefined
        : selectedOptions.reasoning
      : undefined;
    assertCurrentProviderReasoningEffort(reasoningEffort);
    const body = {
      model: model.id,
      stream: true,
      stream_options: { include_usage: true },
      messages: chatMessages(context),
      ...(tools ? { tools } : {}),
      ...(selectedOptions.toolChoice ? { tool_choice: openAiToolChoice(selectedOptions.toolChoice) } : {}),
      ...(selectedOptions.maxTokens ? { [maxTokensField]: selectedOptions.maxTokens } : {}),
      ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
      ...(model.provider === "kimi-code" && selectedOptions.sessionId?.trim()
        ? { prompt_cache_key: selectedOptions.sessionId.trim() }
        : {}),
      ...(typeof selectedOptions.temperature === "number" ? { temperature: selectedOptions.temperature } : {}),
    };
    const response = await fetchEventStream({
      url: endpoint(model.baseUrl, "chat/completions"),
      body,
      model,
      headers: selectedOptions.headers,
      options: selectedOptions,
      authorization: { value: apiKey(selectedOptions) },
    });
    const toolsByIndex = new Map<number, number>();
    let reason: Exclude<StopReason, "pending" | "error" | "aborted"> = "stop";
    let done = false;
    for await (const event of response.events) {
      if (event.data === "[DONE]") {
        done = true;
        break;
      }
      const value = parseRecord(event.data);
      writer.setResponseIdentity(value.id, value.model);
      applyChatUsage(writer, value.usage);
      const choices = Array.isArray(value.choices) ? value.choices : [];
      for (const choice of choices) {
        if (!isRecord(choice)) continue;
        const delta = isRecord(choice.delta) ? choice.delta : {};
        writer.text(string(delta.content) ?? "");
        writer.text(string(delta.reasoning_content) ?? string(delta.reasoning) ?? "", true);
        for (const tool of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          if (!isRecord(tool)) continue;
          const wireIndex = number(tool.index) ?? toolsByIndex.size;
          const fn = isRecord(tool.function) ? tool.function : {};
          let index = toolsByIndex.get(wireIndex);
          if (index === undefined) {
            index = writer.startTool(string(tool.id) ?? `call_${wireIndex}`, string(fn.name) ?? "tool");
            toolsByIndex.set(wireIndex, index);
          }
          writer.toolDelta(index, string(fn.arguments) ?? "");
        }
        const finish = string(choice.finish_reason);
        if (finish === "length") reason = "length";
        else if (finish === "tool_calls" || finish === "function_call") reason = "toolUse";
      }
    }
    if (!done) throw new Error("OpenAI Chat Completions stream ended before [DONE]");
    for (const index of toolsByIndex.values()) writer.finishTool(index);
    writer.done(reason);
  }, options);
}

function applyChatUsage(writer: CanonicalWriter, value: unknown): void {
  if (!isRecord(value)) return;
  const prompt = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : {};
  const completion = isRecord(value.completion_tokens_details) ? value.completion_tokens_details : {};
  const nativeInput = number(value.prompt_tokens);
  const output = number(value.completion_tokens);
  const cacheRead = number(
    prompt.cached_tokens ?? value.cached_tokens ?? value.prompt_cache_hit_tokens ??
    value.cache_read_tokens ?? value.cache_read_input_tokens,
  );
  const cacheWrite = number(
    prompt.cache_write_tokens ?? value.cache_write_tokens ?? value.cache_creation_input_tokens,
  );
  const reportedCache = tokenSum(cacheRead ?? 0, cacheWrite ?? 0);
  const input = nativeInput === undefined || reportedCache === undefined || reportedCache > nativeInput
    ? undefined
    : nativeInput - reportedCache;
  const reportedTotal = number(value.total_tokens);
  const derivedTotal = nativeInput === undefined || output === undefined ? undefined : tokenSum(nativeInput, output);
  const totalTokens = reportedTotal === undefined || (
    derivedTotal !== undefined && reportedTotal < derivedTotal
  ) ? derivedTotal : reportedTotal;
  writer.usage({
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    ...(number(completion.reasoning_tokens) === undefined ? {} : { reasoning: number(completion.reasoning_tokens)! }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  });
}

function anthropicMessages(context: Context, model?: Model): unknown[] {
  return context.messages.flatMap((message) => {
    if (message.role === "user") return [{ role: "user", content: userContent(message.content, "anthropic") }];
    if (message.role === "toolResult") return [{ role: "user", content: [{
      type: "tool_result",
      tool_use_id: message.toolCallId,
      content: contentText(message.content),
      is_error: message.isError,
    }] }];
    const sameModel = messageMatchesModel(message, model);
    return [{ role: "assistant", content: message.content.flatMap((part) => {
      if (part.type === "text") return { type: "text", text: part.text };
      if (part.type === "thinking") {
        if (sameModel) return { type: "thinking", thinking: part.thinking, signature: part.thinkingSignature ?? "" };
        return !part.redacted && part.thinking.trim() !== "" ? { type: "text", text: part.thinking } : [];
      }
      return { type: "tool_use", id: part.id, name: part.name, input: part.arguments };
    }) }];
  });
}

export function streamAnthropicMessages(
  model: Model<"anthropic-messages">,
  context: Context,
  options: SimpleStreamOptions = {},
): AssistantMessageEventStream {
  return run(model, async (writer, selectedOptions) => {
    const body = {
      model: model.id,
      max_tokens: selectedOptions.maxTokens ?? model.maxTokens,
      stream: true,
      messages: anthropicMessages(context, model),
      ...(context.systemPrompt ? { system: context.systemPrompt } : {}),
      ...(context.tools?.length ? { tools: context.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: toolSchema(tool, false),
      })) } : {}),
      ...(model.reasoning && selectedOptions.reasoning && selectedOptions.reasoning !== "off"
        ? { thinking: { type: "enabled", budget_tokens: selectedOptions.thinkingBudgets?.[selectedOptions.reasoning] ?? Math.min(32000, model.maxTokens - 1) } }
        : {}),
      ...(typeof selectedOptions.temperature === "number" ? { temperature: selectedOptions.temperature } : {}),
    };
    const response = await fetchEventStream({
      url: endpoint(model.baseUrl, "v1/messages"),
      body,
      model,
      headers: selectedOptions.headers,
      options: selectedOptions,
      defaultHeaders: { "anthropic-version": "2023-06-01" },
      authorization: { header: "x-api-key", scheme: "raw", value: apiKey(selectedOptions) },
    });
    const blocks = new Map<number, number>();
    let reason: Exclude<StopReason, "pending" | "error" | "aborted"> = "stop";
    for await (const event of response.events) {
      const value = parseRecord(event.data);
      const type = string(value.type) ?? event.event;
      if (type === "message_start") {
        const message = isRecord(value.message) ? value.message : {};
        writer.setResponseIdentity(message.id, message.model);
        applyAnthropicUsage(writer, message.usage);
      } else if (type === "content_block_start") {
        const wireIndex = number(value.index) ?? blocks.size;
        const block = isRecord(value.content_block) ? value.content_block : {};
        if (block.type === "tool_use") blocks.set(wireIndex, writer.startTool(string(block.id) ?? `tool_${wireIndex}`, string(block.name) ?? "tool"));
      } else if (type === "content_block_delta") {
        const wireIndex = number(value.index) ?? 0;
        const delta = isRecord(value.delta) ? value.delta : {};
        if (delta.type === "text_delta") writer.text(string(delta.text) ?? "");
        else if (delta.type === "thinking_delta") writer.text(string(delta.thinking) ?? "", true);
        else if (delta.type === "signature_delta") writer.thinkingSignature(string(delta.signature) ?? "");
        else if (delta.type === "input_json_delta") {
          const index = blocks.get(wireIndex);
          if (index !== undefined) writer.toolDelta(index, string(delta.partial_json) ?? "");
        }
      } else if (type === "content_block_stop") {
        const index = blocks.get(number(value.index) ?? -1);
        if (index !== undefined) writer.finishTool(index);
      } else if (type === "message_delta") {
        const delta = isRecord(value.delta) ? value.delta : {};
        const stop = string(delta.stop_reason);
        if (stop === "max_tokens") reason = "length";
        else if (stop === "tool_use") reason = "toolUse";
        applyAnthropicUsage(writer, value.usage);
      } else if (type === "error") {
        const error = isRecord(value.error) ? value.error : {};
        throw new Error(string(error.message) ?? "Anthropic stream error");
      } else if (type === "message_stop") {
        writer.done(reason);
        return;
      }
    }
    throw new Error("Anthropic stream ended before message_stop");
  }, options);
}

function applyAnthropicUsage(writer: CanonicalWriter, value: unknown): void {
  if (!isRecord(value)) return;
  const input = number(value.input_tokens);
  const output = number(value.output_tokens);
  const cacheRead = number(value.cache_read_input_tokens);
  const cacheWrite = anthropicCacheCreationTokens(value);
  const cacheWrite1h = anthropicCacheWrite1hTokens(value);
  const totalTokens = input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined
    ? undefined
    : tokenSum(input, output, cacheRead, cacheWrite);
  writer.usage({
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  });
}

function anthropicCacheWrite1hTokens(usage: RecordValue): number | undefined {
  const creation = isRecord(usage.cache_creation) ? usage.cache_creation : undefined;
  return number(creation?.ephemeral_1h_input_tokens);
}

function anthropicCacheCreationTokens(usage: RecordValue): number | undefined {
  if (usage.cache_creation_input_tokens !== undefined) return number(usage.cache_creation_input_tokens);
  const creation = isRecord(usage.cache_creation) ? usage.cache_creation : undefined;
  if (creation === undefined) return undefined;
  const rawFiveMinutes = creation.ephemeral_5m_input_tokens;
  const rawOneHour = creation.ephemeral_1h_input_tokens;
  const fiveMinutes = number(rawFiveMinutes);
  const oneHour = number(rawOneHour);
  if (rawFiveMinutes !== undefined && fiveMinutes === undefined) return undefined;
  if (rawOneHour !== undefined && oneHour === undefined) return undefined;
  if (rawFiveMinutes === undefined && rawOneHour === undefined) return undefined;
  return tokenSum(fiveMinutes ?? 0, oneHour ?? 0);
}

function googleContents(context: Context, model?: Model): unknown[] {
  return context.messages.map((message) => {
    if (message.role === "user") return { role: "user", parts: userContent(message.content, "google") };
    if (message.role === "toolResult") return { role: "user", parts: [{ functionResponse: {
      name: message.toolName,
      response: { result: contentText(message.content), isError: message.isError },
    } }] };
    const sameModel = messageMatchesModel(message, model);
    return { role: "model", parts: message.content.flatMap((part) => {
      if (part.type === "text") return { text: part.text };
      if (part.type === "thinking") {
        if (sameModel) return {
          text: part.thinking,
          thought: true,
          ...(part.thinkingSignature === undefined ? {} : { thoughtSignature: part.thinkingSignature }),
        };
        return !part.redacted && part.thinking.trim() !== "" ? { text: part.thinking } : [];
      }
      return { functionCall: { id: part.id, name: part.name, args: part.arguments } };
    }) };
  });
}

export function streamGoogleGenerativeAI(
  model: Model<"google-generative-ai">,
  context: Context,
  options: SimpleStreamOptions = {},
): AssistantMessageEventStream {
  return googleStream(model, context, options, false);
}

export function streamGoogleVertex(
  model: Model<"google-vertex">,
  context: Context,
  options: SimpleStreamOptions = {},
): AssistantMessageEventStream {
  return googleStream(model, context, options, true);
}

function googleStream(model: Model, context: Context, options: SimpleStreamOptions, vertex: boolean): AssistantMessageEventStream {
  return run(model, async (writer, selectedOptions) => {
    const body = {
      contents: googleContents(context, model),
      ...(context.systemPrompt ? { systemInstruction: { parts: [{ text: context.systemPrompt }] } } : {}),
      ...(context.tools?.length ? { tools: [{ functionDeclarations: context.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: toolSchema(tool, false),
      })) }] } : {}),
      generationConfig: {
        ...(selectedOptions.maxTokens ? { maxOutputTokens: selectedOptions.maxTokens } : {}),
        ...(typeof selectedOptions.temperature === "number" ? { temperature: selectedOptions.temperature } : {}),
        ...(model.reasoning && selectedOptions.reasoning && selectedOptions.reasoning !== "off"
          ? { thinkingConfig: { thinkingBudget: selectedOptions.thinkingBudgets?.[selectedOptions.reasoning] ?? -1, includeThoughts: true } }
          : {}),
      },
    };
    const url = vertex
      ? `${model.baseUrl.replace(/\/+$/u, "")}:streamGenerateContent?alt=sse`
      : endpoint(model.baseUrl, `v1beta/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`);
    const response = await fetchEventStream({
      url,
      body,
      model,
      headers: selectedOptions.headers,
      options: selectedOptions,
      authorization: vertex
        ? { value: apiKey(selectedOptions) }
        : { header: "x-goog-api-key", scheme: "raw", value: apiKey(selectedOptions) },
    });
    let toolNumber = 0;
    let reason: Exclude<StopReason, "pending" | "error" | "aborted"> = "stop";
    let finished = false;
    for await (const event of response.events) {
      const value = parseRecord(event.data);
      writer.setResponseIdentity(value.responseId, value.modelVersion);
      applyGoogleUsage(writer, value.usageMetadata);
      for (const candidate of Array.isArray(value.candidates) ? value.candidates : []) {
        if (!isRecord(candidate)) continue;
        const content = isRecord(candidate.content) ? candidate.content : {};
        for (const part of Array.isArray(content.parts) ? content.parts : []) {
          if (!isRecord(part)) continue;
          if (typeof part.text === "string") writer.text(part.text, part.thought === true);
          if (isRecord(part.functionCall)) {
            const fn = part.functionCall;
            const index = writer.startTool(string(fn.id) ?? `google_tool_${toolNumber++}`, string(fn.name) ?? "tool");
            writer.finishTool(index, fn.args);
            reason = "toolUse";
          }
        }
        const finish = string(candidate.finishReason);
        if (finish !== undefined) {
          finished = true;
          if (finish === "MAX_TOKENS") reason = "length";
        }
      }
    }
    if (!finished) throw new Error("Google stream ended before a finish reason");
    writer.done(reason);
  }, options);
}

function applyGoogleUsage(writer: CanonicalWriter, value: unknown): void {
  if (!isRecord(value)) return;
  const nativeInput = number(value.promptTokenCount ?? value.prompt_token_count);
  const cacheRead = number(value.cachedContentTokenCount ?? value.cached_content_token_count);
  const toolInput = number(value.toolUsePromptTokenCount ?? value.tool_use_prompt_token_count);
  const reasoning = number(value.thoughtsTokenCount ?? value.thoughts_token_count);
  const baseInput = nativeInput === undefined || (cacheRead ?? 0) > nativeInput
    ? undefined
    : nativeInput - (cacheRead ?? 0);
  const input = baseInput === undefined ? undefined : tokenSum(baseInput, toolInput ?? 0);
  const reportedTotal = number(value.totalTokenCount ?? value.total_token_count);
  let output = number(value.candidatesTokenCount ?? value.candidates_token_count);
  if (reportedTotal !== undefined) {
    const nonOutput = input === undefined ? undefined : tokenSum(input, cacheRead ?? 0);
    if (nonOutput !== undefined) {
      const reconciled = reportedTotal - nonOutput;
      if (reconciled >= 0 && (output === undefined || reconciled >= output)) output = reconciled;
    }
  }
  const totalTokens = reportedTotal ?? (
    input === undefined || output === undefined
      ? undefined
      : tokenSum(input, output, cacheRead ?? 0)
  );
  writer.usage({
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  });
}

export function streamAzureOpenAIResponses(
  model: Model<"azure-openai-responses">,
  context: Context,
  options: SimpleStreamOptions = {},
): AssistantMessageEventStream {
  const base = model.baseUrl.replace(/\/+$/u, "");
  const apiVersion = typeof options.apiVersion === "string" ? options.apiVersion : "2025-04-01-preview";
  const separator = base.includes("?") ? "&" : "?";
  const adapted: Model<"openai-responses"> = { ...model, api: "openai-responses", baseUrl: base.includes("/responses") ? base : `${base}/responses${separator}api-version=${encodeURIComponent(apiVersion)}` };
  return run(model, async (writer, selectedOptions) => {
    const body = openAiResponseBody(adapted, context, selectedOptions, false);
    await streamOpenAiResponseSse(writer, adapted, body, selectedOptions, {
      url: adapted.baseUrl,
      model,
      authorization: { header: "api-key", scheme: "raw", value: apiKey(selectedOptions) },
    });
  }, options);
}

export function streamOpenAICodexResponses(
  model: Model<"openai-codex-responses">,
  context: Context,
  options: SimpleStreamOptions = {},
): AssistantMessageEventStream {
  if (options.transport === "websocket" || options.transport === "websocket-cached") {
    return run(model, async () => {
      throw new Error("ChatGPT Codex subscription transport supports SSE only");
    }, options);
  }
  const base = model.baseUrl || "https://chatgpt.com/backend-api/codex";
  const adapted: Model<"openai-responses"> = { ...model, api: "openai-responses", baseUrl: base };
  const headers = {
    "openai-beta": "responses=experimental",
    ...(typeof options.accountId === "string" ? { "chatgpt-account-id": options.accountId } : {}),
    ...Object.fromEntries(Object.entries(options.headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== null)),
  };
  const subscriptionOptions = { ...options, transport: "sse" as const, headers };
  delete subscriptionOptions.cacheRetention;
  if (options.cacheRetention === "none") delete subscriptionOptions.sessionId;
  delete subscriptionOptions.metadata;
  return streamOpenAIResponses(adapted, context, subscriptionOptions);
}

function parseRecord(data: string): RecordValue {
  let value: unknown;
  try { value = JSON.parse(data); } catch { throw new Error("Streaming event contained invalid JSON"); }
  if (!isRecord(value)) throw new Error("Streaming event JSON must be an object");
  return value;
}

function run(
  model: Model,
  operation: (writer: CanonicalWriter, options: SimpleStreamOptions) => Promise<void>,
  options: SimpleStreamOptions,
): AssistantMessageEventStream {
  const cancellation = new AbortController();
  const signal = options.signal === undefined
    ? cancellation.signal
    : AbortSignal.any([options.signal, cancellation.signal]);
  const selectedOptions = { ...options, signal };
  const writer = new CanonicalWriter(model, () => {
    cancellation.abort(new DOMException("Stream consumer cancelled", "AbortError"));
  });
  void Promise.resolve().then(() => {
    assertCurrentReasoningLevel(selectedOptions.reasoning, model);
    return operation(writer, selectedOptions);
  }).catch((cause) => writer.fail(cause, selectedOptions.signal.aborted));
  return writer.stream;
}

export const completeOpenAIResponses = async (model: Model<"openai-responses">, context: Context, options?: SimpleStreamOptions) => streamOpenAIResponses(model, context, options).result();
export const completeOpenAICompletions = async (model: Model<"openai-completions">, context: Context, options?: SimpleStreamOptions) => streamOpenAICompletions(model, context, options).result();
export const completeAnthropicMessages = async (model: Model<"anthropic-messages">, context: Context, options?: SimpleStreamOptions) => streamAnthropicMessages(model, context, options).result();
export const completeGoogleGenerativeAI = async (model: Model<"google-generative-ai">, context: Context, options?: SimpleStreamOptions) => streamGoogleGenerativeAI(model, context, options).result();
export const completeGoogleVertex = async (model: Model<"google-vertex">, context: Context, options?: SimpleStreamOptions) => streamGoogleVertex(model, context, options).result();

export function transformMessages(context: Context): Context {
  return structuredClone(context);
}

export function transformOpenAIResponsesMessages(context: Context): unknown[] {
  return structuredClone(openAiResponsesInput(context));
}

export function transformOpenAICompletionsMessages(context: Context): unknown[] {
  return structuredClone(chatMessages(context));
}

export function transformAnthropicMessages(context: Context): unknown[] {
  return structuredClone(anthropicMessages(context));
}

export function transformGoogleMessages(context: Context): unknown[] {
  return structuredClone(googleContents(context));
}

export function streamByApi(model: Model, context: Context, options: SimpleStreamOptions = {}): AssistantMessageEventStream {
  switch (model.api as Api) {
    case "openai-responses": return streamOpenAIResponses(model as Model<"openai-responses">, context, options);
    case "openai-codex-responses": return streamOpenAICodexResponses(model as Model<"openai-codex-responses">, context, options);
    case "azure-openai-responses": return streamAzureOpenAIResponses(model as Model<"azure-openai-responses">, context, options);
    case "openai-completions": return streamOpenAICompletions(model as Model<"openai-completions">, context, options);
    case "anthropic-messages": return streamAnthropicMessages(model as Model<"anthropic-messages">, context, options);
    case "google-generative-ai": return streamGoogleGenerativeAI(model as Model<"google-generative-ai">, context, options);
    case "google-vertex": return streamGoogleVertex(model as Model<"google-vertex">, context, options);
    default: {
      const writer = new CanonicalWriter(model);
      queueMicrotask(() => writer.fail(`Unsupported API: ${model.api}`));
      return writer.stream;
    }
  }
}
