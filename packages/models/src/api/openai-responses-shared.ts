import type { Context, Model, OpenAIResponsesCompat, StreamOptions, ThinkingLevel, Tool } from "../types.js";
import { shortHash } from "../utils/hash.js";
import { splitDeferredTools } from "../utils/deferred-tools.js";
import { providerFailureDiagnostic, providerResponseDiagnostic } from "../utils/diagnostics.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { transformMessages } from "./transform-messages.js";
import { failureDiagnosticDetails, PrematureProviderEofError, providerFetch, ProviderProtocolError, ProviderStreamError, readSse, responseDiagnostics, type SseRecord } from "./internal/http.js";
import type { MessageStreamBuilder } from "./internal/message-stream.js";

export interface ResponsesOptions extends StreamOptions {
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  reasoningSummary?: "auto" | "detailed" | "concise" | "off" | "on" | null;
  serviceTier?: string;
  textVerbosity?: "low" | "medium" | "high";
  toolChoice?: unknown;
}
export interface ResponsesTransport<TOptions extends ResponsesOptions = ResponsesOptions> {
  endpoint(model: Model<string>, options?: TOptions): string;
  headers(model: Model<string>, options?: TOptions, context?: Context): HeadersInit;
  modifyBody?(body: Record<string, unknown>, model: Model<string>, options?: TOptions): void;
}
type Record_ = Record<string, unknown>;
const object = (value: unknown): Record_ | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record_ : undefined;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

function callId(id: string): string { return id.split("|", 1)[0] || id; }
function inputContent(content: Context["messages"][number] extends never ? never : string | Array<{ type: string; [key: string]: unknown }>): unknown[] {
  if (typeof content === "string") return [{ type: "input_text", text: sanitizeSurrogates(content) }];
  return content.map((block) => block.type === "text" ? { type: "input_text", text: sanitizeSurrogates(String(block.text ?? "")) } : { type: "input_image", image_url: `data:${String(block.mimeType)};base64,${String(block.data)}` });
}
function wireTool(tool: Tool, deferred = false): Record_ { return { type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: true, ...(deferred ? { defer_loading: true } : {}) }; }
function replayedOutputItems(message: Extract<Context["messages"][number], { role: "assistant" }>, model: Model<string>): unknown[] | undefined {
  const state = message.providerState;
  if (state?.source.api !== model.api || state.source.provider !== model.provider || state.source.model !== model.id) return undefined;
  const items = object(state.value)?.outputItems;
  return Array.isArray(items) && items.length > 0 ? structuredClone(items) : undefined;
}
function contextInput(model: Model<string>, context: Context, deferredTools: ReadonlyMap<string, Tool>): unknown[] {
  const output: unknown[] = [];
  const loaded = new Set<string>();
  for (const message of transformMessages(context.messages, model, (value) => `fc_${shortHash(value)}`)) {
    if (message.role === "user") output.push({ role: "user", content: inputContent(message.content as never) });
    else if (message.role === "assistant") {
      const replay = replayedOutputItems(message, model);
      if (replay !== undefined) { output.push(...replay); continue; }
      const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
      if (text) output.push({ role: "assistant", content: [{ type: "output_text", text: sanitizeSurrogates(text), annotations: [] }] });
      for (const block of message.content) {
        if (block.type === "thinking" && block.thinkingSignature) {
          try { output.push(JSON.parse(block.thinkingSignature) as unknown); } catch { /* signatures from another protocol are not replayed */ }
        }
        if (block.type === "toolCall") output.push({ type: "function_call", call_id: callId(block.id), name: block.name, arguments: JSON.stringify(block.arguments), ...(block.id.includes("|") ? { id: block.id.slice(block.id.indexOf("|") + 1) } : {}) });
      }
    } else {
      const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") || "No output";
      output.push({ type: "function_call_output", call_id: callId(message.toolCallId), output: sanitizeSurrogates(text) });
      const images = message.content.filter((block) => block.type === "image");
      if (images.length) output.push({ role: "user", content: images.map((block) => ({ type: "input_image", image_url: `data:${block.mimeType};base64,${block.data}` })) });
      const newlyLoaded: Tool[] = [];
      for (const name of message.addedToolNames ?? []) {
        const tool = deferredTools.get(name);
        if (tool && !loaded.has(name)) { loaded.add(name); newlyLoaded.push(tool); }
      }
      if (newlyLoaded.length) {
        const names = newlyLoaded.map((tool) => tool.name);
        const id = `rigyn_tool_load_${shortHash(`${message.toolCallId}:${names.join(",")}`)}`;
        output.push({ type: "tool_search_call", call_id: id, execution: "client", status: "completed", arguments: { query: names.join(" "), limit: names.length } });
        output.push({ type: "tool_search_output", call_id: id, execution: "client", status: "completed", tools: newlyLoaded.map((tool) => wireTool(tool, true)) });
      }
    }
  }
  return output;
}

export function buildResponsesBody(model: Model<string>, context: Context, options?: ResponsesOptions): Record_ {
  const placement = splitDeferredTools(context, (model.compat as OpenAIResponsesCompat | undefined)?.supportsToolSearch ?? false);
  const body: Record_ = { model: model.id, input: contextInput(model, context, placement.deferred), stream: true, store: false };
  if (context.systemPrompt) body.instructions = sanitizeSurrogates(context.systemPrompt);
  if (placement.immediate.length) body.tools = placement.immediate.map((tool) => wireTool(tool));
  else if (context.messages.some((message) => message.role === "toolResult")) body.tools = [];
  if (options?.toolChoice !== undefined) body.tool_choice = options.toolChoice;
  body.max_output_tokens = Math.max(1, Math.min(options?.maxTokens ?? model.maxTokens, model.maxTokens));
  if (options?.temperature !== undefined && !model.reasoning) body.temperature = options.temperature;
  if (model.reasoning) {
    const effort = options?.reasoningEffort ?? (typeof model.thinkingLevelMap?.off === "string" ? model.thinkingLevelMap.off : undefined);
    if (effort && effort !== "none") {
      body.reasoning = { effort: model.thinkingLevelMap?.[effort as ThinkingLevel] ?? effort, ...(options?.reasoningSummary === undefined || options.reasoningSummary === null || options.reasoningSummary === "off" ? {} : { summary: options.reasoningSummary === "on" ? "auto" : options.reasoningSummary }) };
      body.include = ["reasoning.encrypted_content"];
    }
  }
  if (options?.textVerbosity) body.text = { verbosity: options.textVerbosity };
  if (options?.serviceTier) body.service_tier = options.serviceTier;
  const compat = model.compat as OpenAIResponsesCompat | undefined;
  const cacheRetention = options?.cacheRetention ?? (options?.env?.RIGYN_CACHE_RETENTION === "long" ? "long" : "short");
  if (options?.sessionId && cacheRetention !== "none") body.prompt_cache_key = Array.from(options.sessionId).slice(0, 64).join("");
  if (cacheRetention === "long" && (compat?.supportsLongCacheRetention ?? true)) body.prompt_cache_retention = "24h";
  return body;
}

function applyUsage(builder: MessageStreamBuilder<string>, value: unknown): void {
  const usage = object(value); if (!usage) return; const input = number(usage.input_tokens) ?? 0; const output = number(usage.output_tokens) ?? 0; const inputDetails = object(usage.input_tokens_details); const outputDetails = object(usage.output_tokens_details); const cacheRead = number(inputDetails?.cached_tokens) ?? 0; const cacheWrite = number(inputDetails?.cache_write_tokens) ?? 0;
  builder.usage({ input: Math.max(0, input - cacheRead - cacheWrite), output, cacheRead, cacheWrite, reasoning: number(outputDetails?.reasoning_tokens) ?? 0, totalTokens: number(usage.total_tokens) ?? input + output });
}

export async function executeResponses<TOptions extends ResponsesOptions>(builder: MessageStreamBuilder<string>, model: Model<string>, context: Context, options: TOptions | undefined, transport: ResponsesTransport<TOptions>): Promise<void> {
  const body = buildResponsesBody(model, context, options); transport.modifyBody?.(body, model, options);
  builder.start();
  const retries = Math.max(0, Math.min(10, options?.maxRetries ?? 2));
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response: Response;
    try {
      response = await providerFetch({ model, url: transport.endpoint(model, options), body, ...(options === undefined ? {} : { options }), headers: transport.headers(model, options, context) });
    } catch (error) {
      builder.diagnostic(providerFailureDiagnostic(failureDiagnosticDetails(error, { partial: false, ...(options?.signal === undefined ? {} : { aborted: options.signal.aborted }) })));
      throw error;
    }
    const observedResponse = responseDiagnostics(response);
    type TextState = { index: number; finished?: boolean };
    type ToolState = { tool: { index: number; json: string }; finished?: boolean };
    const texts = new Map<string, TextState>();
    const tools = new Map<string, ToolState>();
    type ReasoningState = { index?: number; item?: Record_; finished?: boolean };
    const reasoning = new Map<string, ReasoningState>();
    const outputItems = new Map<number, unknown>();
    const unknownEvents: unknown[] = [];
    const unknownItemIndices = new Set<number>();
    let terminal = false;
    let incomplete = false;
    let semantic = false;
    let failure: unknown;
    let responseId: string | undefined;
    let responseModel: string | undefined;

    const responseMetadata = (): void => builder.response({
      ...(responseId === undefined ? {} : { responseId }),
      ...(responseModel === undefined ? {} : { responseModel }),
    });
    const itemKeys = (event: Record_, item?: Record_): string[] => {
      const keys: string[] = []; const id = string(item?.id) ?? string(event.item_id); const outputIndex = number(event.output_index);
      if (id !== undefined) keys.push(`id:${id}`); if (outputIndex !== undefined) keys.push(`output:${outputIndex}`); if (keys.length === 0) keys.push("unscoped"); return keys;
    };
    const textState = (event: Record_, item?: Record_, create = false): TextState | undefined => {
      const keys = itemKeys(event, item); let state = keys.map((key) => texts.get(key)).find((value) => value !== undefined);
      if (!state && create) { responseMetadata(); state = { index: builder.textStart() }; }
      if (state) for (const key of keys) texts.set(key, state); return state;
    };
    const textFromItem = (item: Record_): string => array(item.content).map((part) => { const value = object(part); return string(value?.text) ?? string(value?.refusal) ?? ""; }).join("");
    const updateText = (state: TextState, text: string): void => {
      const block = builder.message.content[state.index]; const current = block?.type === "text" ? block.text : "";
      const delta = text.startsWith(current) ? text.slice(current.length) : current === "" ? text : ""; if (delta) builder.textDelta(state.index, delta); else if (block?.type === "text" && text !== current) block.text = text;
    };
    const finishText = (state: TextState, item: Record_): void => { updateText(state, textFromItem(item)); if (!state.finished) { builder.textEnd(state.index); state.finished = true; } };
    const toolState = (event: Record_, item?: Record_, create = false): ToolState | undefined => {
      const keys = itemKeys(event, item); let state = keys.map((key) => tools.get(key)).find((value) => value !== undefined);
      if (!state && create) {
        responseMetadata(); const itemId = string(item?.id); const outputIndex = number(event.output_index); const fallback = shortHash(JSON.stringify(item ?? event));
        const responseItemId = itemId ?? `fc_${outputIndex ?? fallback}`; const id = `${string(item?.call_id) ?? `call_${outputIndex ?? fallback}`}|${responseItemId}`;
        state = { tool: builder.toolStart(id, string(item?.name) ?? "tool") };
      }
      if (state) for (const key of keys) tools.set(key, state); return state;
    };
    const finishTool = (state: ToolState, item?: Record_): void => {
      if (state.finished) return; const arguments_ = string(item?.arguments);
      if (arguments_ !== undefined) { const delta = arguments_.startsWith(state.tool.json) ? arguments_.slice(state.tool.json.length) : state.tool.json === "" ? arguments_ : ""; if (delta) builder.toolDelta(state.tool, delta); else if (arguments_ !== state.tool.json) state.tool.json = arguments_; }
      builder.toolEnd(state.tool); state.finished = true;
    };
    const reasoningKeys = (event: Record_, item?: Record_): string[] => {
      const keys: string[] = [];
      const id = string(item?.id) ?? string(event.item_id);
      const outputIndex = number(event.output_index);
      if (id !== undefined) keys.push(`id:${id}`);
      if (outputIndex !== undefined) keys.push(`output:${outputIndex}`);
      return keys;
    };
    const reasoningState = (event: Record_, item?: Record_, create = false): ReasoningState | undefined => {
      const keys = reasoningKeys(event, item);
      let state = keys.map((key) => reasoning.get(key)).find((value) => value !== undefined);
      if (!state && create) state = {};
      if (state) for (const key of keys) reasoning.set(key, state);
      return state;
    };
    const visibleReasoning = (item: Record_): string => {
      const summary = array(item.summary).map((part) => string(object(part)?.text)).filter((part): part is string => part !== undefined).join("\n\n");
      const content = array(item.content).map((part) => string(object(part)?.text)).filter((part): part is string => part !== undefined).join("\n\n");
      return summary || content;
    };
    const ensureReasoning = (state: ReasoningState): number => {
      if (state.index === undefined) { responseMetadata(); state.index = builder.thinkingStart(); }
      return state.index;
    };
    const finishReasoning = (state: ReasoningState, item: Record_): void => {
      const previous = state.item;
      const previousEncrypted = string(previous?.encrypted_content);
      const merged = { ...(previous ?? {}), ...item, ...(previousEncrypted === undefined ? {} : { encrypted_content: previousEncrypted }) };
      const index = ensureReasoning(state);
      const block = builder.message.content[index];
      const text = visibleReasoning(merged);
      if (block?.type === "thinking" && text) {
        const delta = text.startsWith(block.thinking) ? text.slice(block.thinking.length) : block.thinking === "" ? text : "";
        if (delta) builder.thinkingDelta(index, delta); else if (text !== block.thinking) block.thinking = text;
      }
      state.item = merged;
      if (state.finished) {
        if (block?.type === "thinking") block.thinkingSignature = JSON.stringify(merged);
      } else {
        builder.thinkingEnd(index, JSON.stringify(merged));
        state.finished = true;
      }
    };
    const closeOpenBlocks = (): void => {
      for (const state of new Set(texts.values())) if (!state.finished) { builder.textEnd(state.index); state.finished = true; }
      for (const state of new Set(reasoning.values())) if (state.index !== undefined && !state.finished) builder.thinkingEnd(state.index);
      for (const state of new Set(tools.values())) finishTool(state);
    };
    const rememberOutput = (event: Record_, item: Record_): number => { const index = number(event.output_index) ?? outputItems.size; outputItems.set(index, item); return index; };
    const unknownItem = (index: number, item: Record_): void => {
      if (unknownItemIndices.has(index)) return; unknownItemIndices.add(index); const itemType = string(item.type) ?? "unknown";
      builder.diagnostic({ type: "unknown_provider_output_item", message: "Provider emitted an unknown output item", details: { provider: model.provider, itemType, outputIndex: index }, timestamp: Date.now() });
    };

    try {
      for await (const raw of responseRecords(response)) {
        if (raw.data === "[DONE]") break;
        let parsed: unknown;
        try { parsed = JSON.parse(raw.data); } catch (error) {
          if (raw.dispatchedAtEof) throw new PrematureProviderEofError("Responses stream ended in a truncated SSE event", { cause: error });
          throw new ProviderProtocolError("Responses stream contained malformed JSON", { cause: error });
        }
        const event = object(parsed); if (!event) throw new ProviderProtocolError("Responses stream event was not an object");
        const type = string(event.type) ?? raw.event;
        if (type === undefined) throw new ProviderProtocolError("Responses stream event did not contain a type");
        const response_ = object(event.response); responseId = string(response_?.id) ?? responseId; responseModel = string(response_?.model) ?? responseModel;
        if (type === "response.created" || type === "response.in_progress" || type === "response.queued") {
        } else if (type === "response.output_text.delta") {
          const delta = string(event.delta) ?? "";
          if (delta) { const state = textState(event, undefined, true)!; builder.textDelta(state.index, delta); semantic = true; }
        } else if (type === "response.refusal.delta") {
          const delta = string(event.delta) ?? ""; if (delta) { const state = textState(event, undefined, true)!; builder.textDelta(state.index, delta); semantic = true; }
        } else if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
          const delta = string(event.delta) ?? "";
          if (delta) { const state = reasoningState(event, undefined, true)!; builder.thinkingDelta(ensureReasoning(state), delta); semantic = true; }
        } else if (type === "response.output_item.added") {
          const item = object(event.item) ?? {};
          rememberOutput(event, item);
          if (item.type === "function_call") {
            const state = toolState(event, item, true)!; const initial = string(item.arguments); if (initial) builder.toolDelta(state.tool, initial);
            semantic = true;
          } else if (item.type === "message") {
            const state = textState(event, item, true)!; updateText(state, textFromItem(item)); semantic = true;
          } else if (item.type === "reasoning") {
            const state = reasoningState(event, item, true)!;
            state.item = item;
          } else {
            const outputIndex = number(event.output_index) ?? outputItems.size - 1; const itemType = string(item.type) ?? "";
            if (!["tool_search_call", "tool_search_output", "computer_call", "web_search_call", "file_search_call"].includes(itemType)) unknownItem(outputIndex, item);
            responseMetadata(); semantic = true;
          }
        } else if (type === "response.function_call_arguments.delta") {
          const delta = string(event.delta) ?? "";
          if (delta) { const state = toolState(event, undefined, true)!; builder.toolDelta(state.tool, delta); semantic = true; }
        } else if (type === "response.function_call_arguments.done") {
          const state = toolState(event, undefined, true)!; const arguments_ = string(event.arguments);
          if (arguments_ !== undefined) { const delta = arguments_.startsWith(state.tool.json) ? arguments_.slice(state.tool.json.length) : state.tool.json === "" ? arguments_ : ""; if (delta) builder.toolDelta(state.tool, delta); }
          semantic = true;
        } else if (type === "response.output_item.done") {
          const item = object(event.item) ?? {};
          const outputIndex = rememberOutput(event, item);
          if (item.type === "function_call") {
            const state = toolState(event, item, true)!; finishTool(state, item); semantic = true;
          } else if (item.type === "reasoning") {
            const state = reasoningState(event, item, true)!;
            state.item = item;
            if (state.index !== undefined || visibleReasoning(item) !== "" || string(item.encrypted_content) !== undefined) { finishReasoning(state, item); semantic = true; }
          } else if (item.type === "message") {
            const state = textState(event, item, true)!; finishText(state, item); semantic = true;
          } else {
            unknownItem(outputIndex, item); semantic = true;
          }
        } else if (type === "response.completed" || type === "response.incomplete") {
          const completed = object(event.response) ?? {};
          responseId = string(completed.id) ?? responseId;
          responseModel = string(completed.model) ?? responseModel;
          responseMetadata();
          applyUsage(builder, completed.usage);
          for (const [outputIndex, output] of array(completed.output).entries()) {
            const item = object(output);
            if (!item) continue; outputItems.set(outputIndex, item);
            if (item.type === "reasoning") { const state = reasoningState({ output_index: outputIndex }, item, true)!; finishReasoning(state, item); }
            else if (item.type === "message") finishText(textState({ output_index: outputIndex }, item, true)!, item);
            else if (item.type === "function_call") finishTool(toolState({ output_index: outputIndex }, item, true)!, item);
            else if (!["tool_search_call", "tool_search_output", "computer_call", "web_search_call", "file_search_call"].includes(string(item.type) ?? "")) unknownItem(outputIndex, item);
          }
          for (const state of new Set(reasoning.values())) if (state.item !== undefined && !state.finished) finishReasoning(state, state.item);
          incomplete = type === "response.incomplete";
          terminal = true;
        } else if (type === "response.failed" || type === "error") {
          const error = object(event.error) ?? object(object(event.response)?.error);
          const message = string(error?.message) ?? `Responses provider emitted ${type}`;
          const code = string(error?.code) ?? string(error?.type);
          throw new ProviderStreamError(code ? `${code}: ${message}` : message, code);
        } else if (!isIgnorableResponsesEvent(type)) {
          const outputIndex = number(event.output_index); unknownEvents.push(event); semantic = true; responseMetadata();
          builder.diagnostic({ type: "unknown_provider_event", message: "Provider emitted an unknown event", details: { provider: model.provider, eventType: type, ...(outputIndex === undefined ? {} : { outputIndex }) }, timestamp: Date.now() });
        }
      }
    } catch (error) {
      failure = error;
    }

    if (failure !== undefined) {
      if (failure instanceof PrematureProviderEofError && !semantic && attempt < retries && options?.signal?.aborted !== true) continue;
      closeOpenBlocks();
      builder.diagnostic(providerFailureDiagnostic(failureDiagnosticDetails(failure, { partial: semantic, ...(options?.signal === undefined ? {} : { aborted: options.signal.aborted }), response: observedResponse })));
      throw failure;
    }
    if (!terminal && !semantic && attempt < retries) continue;
    closeOpenBlocks();
    if (!terminal) {
      const error = new PrematureProviderEofError(`Responses stream ended before a terminal response event${semantic ? " after partial output" : ""}`);
      builder.diagnostic(providerFailureDiagnostic(failureDiagnosticDetails(error, { partial: semantic, ...(options?.signal === undefined ? {} : { aborted: options.signal.aborted }), response: observedResponse })));
      throw error;
    }
    const stateValue: Record_ = { outputItems: [...outputItems.entries()].sort(([left], [right]) => left - right).map(([, item]) => item) };
    if (unknownEvents.length) stateValue.unknownEvents = unknownEvents;
    builder.providerState({ source: { api: model.api, provider: model.provider, model: model.id }, value: stateValue });
    builder.diagnostic(providerResponseDiagnostic(observedResponse));
    const hasTools = builder.message.content.some((block) => block.type === "toolCall"); builder.done(incomplete ? "length" : hasTools ? "toolUse" : "stop"); return;
  }
}

function isIgnorableResponsesEvent(type: string): boolean {
  return type === "response.output_text.done" || type === "response.refusal.done" || type === "response.reasoning_summary_text.done" || type === "response.reasoning_text.done" || type === "response.reasoning_summary_part.added" || type === "response.reasoning_summary_part.done" || type === "response.content_part.added" || type === "response.content_part.done";
}

async function* responseRecords(response: Response): AsyncIterable<SseRecord> {
  try {
    yield* readSse(response);
  } catch (error) {
    if (error instanceof PrematureProviderEofError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new PrematureProviderEofError(`Responses streaming body ended unexpectedly: ${message}`, { cause: error });
  }
}
