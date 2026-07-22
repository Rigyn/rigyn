import type { CacheRetention, Context, Model, SimpleStreamOptions, StreamFunction, StreamOptions, ThinkingLevel } from "../types.js";
import { buildBaseOptions, resolveSimpleReasoning } from "./simple-options.js";
import { failureDiagnosticDetails, HttpProviderError, PrematureProviderEofError, providerFetch, ProviderProtocolError, ProviderStreamError, readSse, responseDiagnostics, type SseRecord } from "./internal/http.js";
import { MessageStreamBuilder, streamTask } from "./internal/message-stream.js";
import { shortHash } from "../utils/hash.js";
import { providerFailureDiagnostic, providerResponseDiagnostic, type ProviderResponseDiagnostics } from "../utils/diagnostics.js";
import { parseJsonWithRepair } from "../utils/json-parse.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { transformMessages } from "./transform-messages.js";
import { buildCopilotDynamicHeaders } from "./github-copilot-headers.js";
import { splitDeferredTools } from "../utils/deferred-tools.js";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.js";

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type AnthropicThinkingDisplay = "summarized" | "omitted";
export interface AnthropicOptions extends StreamOptions {
  thinkingEnabled?: boolean; thinkingBudgetTokens?: number; effort?: AnthropicEffort;
  thinkingDisplay?: AnthropicThinkingDisplay; interleavedThinking?: boolean;
  toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
  client?: unknown;
}
type Record_ = Record<string, unknown>;
const object = (value: unknown): Record_ | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record_ : undefined;
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const utf8 = new TextEncoder();
function endpoint(base: string): string { const value = base.replace(/\/+$/u, ""); return /\/messages$/u.test(value) ? value : /\/v1$/u.test(value) ? `${value}/messages` : `${value}/v1/messages`; }
function toolName(name: string): string { const cleaned = name.replace(/[^a-z0-9_-]/giu, "_"); return cleaned.length <= 64 ? cleaned : `${cleaned.slice(0, 55)}_${shortHash(name).slice(0, 8)}`; }
function adaptive(model: Model<"anthropic-messages">): boolean {
  if (model.compat?.forceAdaptiveThinking !== undefined) return model.compat.forceAdaptiveThinking;
  return /(?:opus|sonnet|haiku)[-_ ]?4[-_. ]?(?:6|7|8|9)|mythos|fable/iu.test(model.id);
}
function cacheRetention(options?: AnthropicOptions): CacheRetention {
  return options?.cacheRetention ?? (options?.env?.RIGYN_CACHE_RETENTION === "long" ? "long" : "short");
}
function cacheControl(model: Model<"anthropic-messages">, options?: AnthropicOptions): { type: "ephemeral"; ttl?: "1h" } | undefined {
  const retention = cacheRetention(options);
  if (retention === "none") return undefined;
  return retention === "long" && model.compat?.supportsLongCacheRetention !== false ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}
function refusalExplanation(value: unknown): string | undefined {
  const explanation = string(value)?.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim();
  if (!explanation) return undefined;
  let output = "";
  let bytes = 0;
  for (const character of explanation) {
    const size = utf8.encode(character).byteLength;
    if (bytes + size > 4 * 1_024) break;
    output += character;
    bytes += size;
  }
  return output;
}
function streamErrorMessage(value: unknown, fallback: string): string {
  const error = object(value);
  const message = string(error?.message) ?? fallback;
  const code = string(error?.code) ?? string(error?.type);
  return code ? `${code}: ${message}` : message;
}
function sdkError(error: unknown): Error {
  const normalized = normalizeProviderError(error); const message = formatProviderError(normalized, "Anthropic API error");
  return normalized.status === undefined ? new Error(message, { cause: error }) : new HttpProviderError(normalized.status, normalized.body ?? "", {}, message);
}
function isOAuthToken(value: string | undefined): boolean { return value?.includes("sk-ant-oat") ?? false; }
const subscriptionToolNames = new Map<string, string>([
  ["read", "Read"], ["write", "Write"], ["edit", "Edit"], ["bash", "Bash"], ["grep", "Grep"], ["glob", "Glob"],
  ["askuserquestion", "AskUserQuestion"], ["enterplanmode", "EnterPlanMode"], ["exitplanmode", "ExitPlanMode"],
  ["killshell", "KillShell"], ["notebookedit", "NotebookEdit"], ["skill", "Skill"], ["task", "Task"],
  ["taskoutput", "TaskOutput"], ["todowrite", "TodoWrite"], ["webfetch", "WebFetch"], ["websearch", "WebSearch"],
]);
function subscriptionToolName(name: string): string { return subscriptionToolNames.get(name.toLowerCase()) ?? name; }
function supportsToolReferences(model: Model<"anthropic-messages">): boolean {
  if (model.compat?.supportsToolReferences !== undefined) return model.compat.supportsToolReferences;
  if (model.provider !== "anthropic" || model.id.includes("haiku")) return false;
  const match = /^claude-(?:opus|sonnet|fable)-(\d+)(?:-(\d+))?(?:-|$)/u.exec(model.id);
  if (!match?.[1]) return false;
  const major = Number(match[1]); const minor = match[2] && match[2].length < 8 ? Number(match[2]) : 0;
  return major > 4 || (major === 4 && minor >= 5);
}

function blockContent(content: Context["messages"][number] extends never ? never : string | Array<Record_>): Record_[] {
  if (typeof content === "string") return [{ type: "text", text: sanitizeSurrogates(content) }];
  return content.map((block) => block.type === "text" ? { type: "text", text: sanitizeSurrogates(String(block.text ?? "")) } : { type: "image", source: { type: "base64", media_type: String(block.mimeType), data: String(block.data) } });
}
function replayedAssistantBlocks(message: Extract<Context["messages"][number], { role: "assistant" }>, model: Model<"anthropic-messages">): Record_[] | undefined {
  const state = message.providerState;
  if (state?.source.api !== model.api || state.source.provider !== model.provider || state.source.model !== model.id) return undefined;
  const blocks = object(state.value)?.assistantBlocks;
  return Array.isArray(blocks) && blocks.length > 0 ? structuredClone(blocks) as Record_[] : undefined;
}
function convert(model: Model<"anthropic-messages">, context: Context, deferred: ReadonlySet<string>, normalizeName: (name: string) => string, cache?: { type: "ephemeral"; ttl?: "1h" }): Record_[] {
  const messages: Record_[] = [];
  const loaded = new Set<string>();
  const push = (role: "user" | "assistant", content: Record_[]) => {
    if (content.length === 0) return;
    const last = messages.at(-1);
    if (last?.role === role && Array.isArray(last.content)) (last.content as Record_[]).push(...content);
    else messages.push({ role, content });
  };
  for (const message of transformMessages(context.messages, model, (value) => { const clean = value.replace(/[^a-z0-9_-]/giu, "_"); return clean.length <= 64 ? clean : `${clean.slice(0, 55)}_${shortHash(value).slice(0, 8)}`; })) {
    if (message.role === "user") push("user", blockContent(message.content as never));
    else if (message.role === "assistant") {
      const replay = replayedAssistantBlocks(message, model);
      if (replay !== undefined) { push("assistant", replay); continue; }
      const content: Record_[] = [];
      for (const block of message.content) {
        if (block.type === "text" && block.text) content.push({ type: "text", text: sanitizeSurrogates(block.text) });
        else if (block.type === "thinking") {
          if (block.redacted) content.push({ type: "redacted_thinking", data: block.thinkingSignature ?? "" });
          else {
            const signature = block.thinkingSignature?.trim() ?? "";
            if (signature) content.push({ type: "thinking", thinking: sanitizeSurrogates(block.thinking), signature });
            else if (block.thinking && model.compat?.allowEmptySignature) content.push({ type: "thinking", thinking: sanitizeSurrogates(block.thinking), signature: "" });
            else if (block.thinking) content.push({ type: "text", text: sanitizeSurrogates(block.thinking) });
          }
        } else if (block.type === "toolCall") content.push({ type: "tool_use", id: block.id.split("|", 1)[0], name: toolName(normalizeName(block.name)), input: block.arguments });
      }
      push("assistant", content);
    } else {
      const references: Record_[] = [];
      for (const name of message.addedToolNames ?? []) {
        const normalized = normalizeName(name);
        if (!deferred.has(normalized) || loaded.has(normalized)) continue;
        loaded.add(normalized); references.push({ type: "tool_reference", tool_name: normalized });
      }
      const output = blockContent(message.content as never);
      push("user", [{ type: "tool_result", tool_use_id: message.toolCallId.split("|", 1)[0], content: references.length ? references : output.length ? output : [{ type: "text", text: "No output" }], is_error: message.isError }, ...(references.length ? output : [])]);
    }
  }
  if (cache) {
    const last = messages.at(-1);
    const content = last?.role === "user" && Array.isArray(last.content) ? last.content as Record_[] : undefined;
    const block = content?.at(-1);
    if (block && (block.type === "text" || block.type === "image" || block.type === "tool_result")) content![content!.length - 1] = { ...block, cache_control: cache };
  }
  return messages;
}
function requestBody(model: Model<"anthropic-messages">, context: Context, options?: AnthropicOptions): Record_ {
  const oauth = isOAuthToken(options?.apiKey); const normalizeName = oauth ? subscriptionToolName : (name: string) => name;
  const placement = splitDeferredTools(context, supportsToolReferences(model), normalizeName);
  let immediate = placement.immediate; let deferred = [...placement.deferred.values()];
  if (immediate.length === 0 && deferred.length > 0) { immediate = deferred; deferred = []; }
  const deferredNames = new Set(deferred.map((tool) => normalizeName(tool.name)));
  const cache = cacheControl(model, options);
  const body: Record_ = { model: model.id, messages: convert(model, context, deferredNames, normalizeName, cache), stream: true, max_tokens: Math.max(1, Math.min(options?.maxTokens ?? model.maxTokens, model.maxTokens)) };
  const system: Record_[] = [];
  if (oauth) system.push({ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", ...(cache ? { cache_control: cache } : {}) });
  if (context.systemPrompt) system.push({ type: "text", text: sanitizeSurrogates(context.systemPrompt), ...(cache ? { cache_control: cache } : {}) });
  if (system.length) body.system = system;
  if (immediate.length || deferred.length) {
    const all = [...immediate.map((tool) => ({ tool, deferred: false })), ...deferred.map((tool) => ({ tool, deferred: true }))];
    body.tools = all.map(({ tool, deferred: deferLoading }, index) => ({ name: toolName(normalizeName(tool.name)), description: tool.description, input_schema: tool.parameters, ...(model.compat?.supportsEagerToolInputStreaming === false ? {} : { eager_input_streaming: true }), ...(deferLoading ? { defer_loading: true } : {}), ...(cache && index === all.length - 1 && model.compat?.supportsCacheControlOnTools !== false ? { cache_control: cache } : {}) }));
  }
  if (options?.toolChoice !== undefined && options.toolChoice !== "none") body.tool_choice = typeof options.toolChoice === "string" ? { type: options.toolChoice } : { type: "tool", name: toolName(options.toolChoice.name) };
  if (options?.thinkingEnabled) {
    if (adaptive(model)) { body.thinking = { type: "adaptive", ...(options.thinkingDisplay ? { display: options.thinkingDisplay } : {}) }; if (options.effort) body.output_config = { effort: model.thinkingLevelMap?.[options.effort] ?? options.effort }; }
    else body.thinking = { type: "enabled", budget_tokens: Math.max(1_024, Math.min(options.thinkingBudgetTokens ?? 1_024, Math.max(1_024, (body.max_tokens as number) - 1))) };
  } else if (model.thinkingLevelMap?.off === "disabled") body.thinking = { type: "disabled" };
  if (options?.temperature !== undefined && (!options.thinkingEnabled || model.compat?.supportsTemperature !== false)) body.temperature = options.temperature;
  if (typeof options?.metadata?.user_id === "string") body.metadata = { user_id: options.metadata.user_id };
  return body;
}
function requestHeaders(model: Model<"anthropic-messages">, context: Context, options: AnthropicOptions | undefined, contextHasTools: boolean): Headers {
  const headers = new Headers(model.headers); headers.set("anthropic-version", "2023-06-01");
  if (model.provider === "github-copilot") {
    for (const [name, value] of Object.entries(buildCopilotDynamicHeaders({ messages: context.messages }))) headers.set(name, value);
    if (options?.apiKey && !headers.has("authorization")) headers.set("authorization", `Bearer ${options.apiKey}`);
    headers.delete("x-api-key");
  } else if (isOAuthToken(options?.apiKey)) {
    if (!headers.has("authorization")) headers.set("authorization", `Bearer ${options!.apiKey}`);
    headers.set("anthropic-beta", ["claude-code-20250219", "oauth-2025-04-20", headers.get("anthropic-beta")].filter(Boolean).join(","));
    headers.set("user-agent", "claude-cli/2.1.75"); headers.set("x-app", "cli"); headers.delete("x-api-key");
  } else if (options?.apiKey && !headers.has("x-api-key") && !headers.has("authorization")) headers.set("x-api-key", options.apiKey);
  if (options?.sessionId && options.cacheRetention !== "none" && model.compat?.sendSessionAffinityHeaders) headers.set("x-session-affinity", options.sessionId);
  const beta = new Set((headers.get("anthropic-beta") ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  if (options?.thinkingEnabled && options.interleavedThinking !== false && !adaptive(model)) beta.add("interleaved-thinking-2025-05-14");
  if (contextHasTools && model.compat?.supportsEagerToolInputStreaming === false) beta.add("fine-grained-tool-streaming-2025-05-14");
  if (beta.size) headers.set("anthropic-beta", [...beta].join(","));
  return headers;
}
function parseWireRecord(record: SseRecord): Record_ {
  let parsed: unknown;
  try { parsed = record.dispatchedAtEof ? JSON.parse(record.data) : parseJsonWithRepair(record.data); } catch (error) {
    if (record.dispatchedAtEof) throw new PrematureProviderEofError("Anthropic stream ended in a truncated SSE event", { cause: error });
    throw new ProviderProtocolError("Anthropic stream contained malformed JSON", { cause: error });
  }
  const event = object(parsed); if (!event) throw new ProviderProtocolError("Anthropic stream event was not an object");
  const type = string(event.type) ?? record.event; if (type === undefined) throw new ProviderProtocolError("Anthropic stream event did not contain a type");
  return event.type === undefined ? { ...event, type } : event;
}
async function* anthropicRecords(response: Response): AsyncIterable<SseRecord> {
  try { yield* readSse(response); } catch (error) {
    if (error instanceof PrematureProviderEofError || error instanceof ProviderProtocolError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new PrematureProviderEofError(`Anthropic streaming body ended unexpectedly: ${message}`, { cause: error });
  }
}
async function* wireEvents(model: Model<"anthropic-messages">, context: Context, options: AnthropicOptions | undefined, observeResponse: (response: ProviderResponseDiagnostics) => void): AsyncIterable<Record_> {
  const body = requestBody(model, context, options);
  if (options?.client) {
    const client = options.client as { messages?: {
      stream?: (body: Record_, request?: { signal?: AbortSignal }) => AsyncIterable<unknown>;
      create?: (body: Record_, request?: { signal?: AbortSignal; maxRetries?: number; timeout?: number }) => unknown;
    } };
    if (client.messages?.create) {
      let response: Response | undefined;
      try {
        const request = await client.messages.create({ ...body, stream: true }, { ...(options.signal ? { signal: options.signal } : {}), ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }), maxRetries: options.maxRetries ?? 0 });
        response = typeof (request as { asResponse?: unknown }).asResponse === "function" ? await (request as { asResponse(): Promise<Response> }).asResponse() : undefined;
      } catch (error) {
        throw sdkError(error);
      }
      if (!response) throw new Error("Injected Anthropic client did not return a streaming response");
      await options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers.entries()) }, model);
      observeResponse(responseDiagnostics(response));
      for await (const record of anthropicRecords(response)) yield parseWireRecord(record);
      return;
    }
    if (client.messages?.stream) {
      try {
        for await (const event of client.messages.stream(body, options.signal ? { signal: options.signal } : undefined)) { const record = object(event); if (record) yield record; }
      } catch (error) {
        throw sdkError(error);
      }
      return;
    }
    throw new Error("Injected Anthropic client does not expose a streaming messages API");
  }
  const response = await providerFetch({ model, url: endpoint(model.baseUrl), body, ...(options === undefined ? {} : { options }), headers: requestHeaders(model, context, options, (context.tools?.length ?? 0) > 0) });
  observeResponse(responseDiagnostics(response));
  for await (const record of anthropicRecords(response)) yield parseWireRecord(record);
}
type AnthropicUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number; totalTokens: number };
function mergeUsage(previous: AnthropicUsage, usage: unknown): AnthropicUsage {
  const value = object(usage); if (!value) return previous; const input = number(value.input_tokens) ?? previous.input; const output = number(value.output_tokens) ?? previous.output; const cacheRead = number(value.cache_read_input_tokens) ?? previous.cacheRead; const cacheWrite = number(value.cache_creation_input_tokens) ?? previous.cacheWrite; const details = object(value.cache_creation); const cacheWrite1h = number(details?.ephemeral_1h_input_tokens) ?? previous.cacheWrite1h;
  return { input, output, cacheRead, cacheWrite, ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }), totalTokens: input + output + cacheRead + cacheWrite };
}
async function execute(builder: MessageStreamBuilder<"anthropic-messages">, model: Model<"anthropic-messages">, context: Context, options?: AnthropicOptions): Promise<void> {
  builder.start(); const retries = Math.max(0, Math.min(10, options?.maxRetries ?? 2));
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    type BlockState = { type: string; index?: number; tool?: { index: number; json: string }; signature?: string; redacted?: boolean; finished?: boolean };
    const blocks = new Map<number, BlockState>(); const wireBlocks = new Map<number, Record_>(); const unknownEvents: unknown[] = [];
    let responseId: string | undefined; let responseModel: string | undefined; let usage: AnthropicUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    let committed = false; let semantic = false; let bodyStarted = false; let terminal: "stop" | "length" | "toolUse" | undefined; let sawStop = false; let observedResponse: ProviderResponseDiagnostics | undefined;
    const commitMetadata = (): void => { builder.response({ ...(responseId === undefined ? {} : { responseId }), ...(responseModel === undefined ? {} : { responseModel }) }); builder.usage(usage); committed = true; };
    const finishBlock = (wireIndex: number, state: BlockState): void => {
      if (state.finished) return;
      if (state.type === "text" && state.index !== undefined) builder.textEnd(state.index);
      else if (state.type === "thinking" && state.index !== undefined) builder.thinkingEnd(state.index, state.signature, state.redacted);
      else if (state.tool) { const call = builder.toolEnd(state.tool); const wire = wireBlocks.get(wireIndex); if (wire) wire.input = call.arguments; }
      state.finished = true;
    };
    const closeBlocks = (): void => { for (const [index, state] of blocks) finishBlock(index, state); };
    const unknown = (event: Record_, eventType: string, outputIndex?: number): void => {
      unknownEvents.push(event); builder.diagnostic({ type: "unknown_provider_event", message: "Provider emitted an unknown event", details: { provider: model.provider, eventType, ...(outputIndex === undefined ? {} : { outputIndex }) }, timestamp: Date.now() });
    };
    try {
      for await (const event of wireEvents(model, context, options, (response) => { observedResponse = response; })) {
        if (sawStop) continue; const type = string(event.type)!;
        if (type === "ping") continue;
        if (type === "message_start") {
          const message = object(event.message); responseId = string(message?.id) ?? responseId; responseModel = string(message?.model) ?? responseModel; usage = mergeUsage(usage, message?.usage); if (committed) commitMetadata();
        } else if (type === "content_block_start") {
          bodyStarted = true; semantic = true; commitMetadata(); const wireIndex = number(event.index) ?? blocks.size; const block = object(event.content_block); if (!block) throw new ProviderProtocolError("Anthropic content block start omitted its block");
          const retained = structuredClone(block); wireBlocks.set(wireIndex, retained); const kind = string(block.type); if (kind === undefined) throw new ProviderProtocolError("Anthropic content block did not contain a type");
          if (kind === "text" || kind === "refusal") { const index = builder.textStart(); blocks.set(wireIndex, { type: "text", index }); const initial = string(block.text) ?? string(block.refusal); if (initial) builder.textDelta(index, initial); }
          else if (kind === "thinking" || kind === "redacted_thinking") { const index = builder.thinkingStart(); const signature = kind === "redacted_thinking" ? string(block.data) : string(block.signature); const redacted = kind === "redacted_thinking"; blocks.set(wireIndex, { type: "thinking", index, redacted, ...(signature === undefined ? {} : { signature }) }); const initial = redacted ? "[Reasoning redacted]" : string(block.thinking); if (initial) builder.thinkingDelta(index, initial); }
          else if (kind === "tool_use") { const tool = builder.toolStart(string(block.id) ?? `tool_${wireIndex}_${shortHash(JSON.stringify(block))}`, string(block.name) ?? "tool"); blocks.set(wireIndex, { type: "tool", tool }); const input = object(block.input); if (input && Object.keys(input).length) builder.toolDelta(tool, JSON.stringify(input)); }
          else { blocks.set(wireIndex, { type: "unknown" }); builder.diagnostic({ type: "unknown_provider_output_item", message: "Provider emitted an unknown content block", details: { provider: model.provider, itemType: kind, outputIndex: wireIndex }, timestamp: Date.now() }); }
        } else if (type === "content_block_delta") {
          bodyStarted = true; semantic = true; commitMetadata(); const wireIndex = number(event.index) ?? -1; const state = blocks.get(wireIndex); const wire = wireBlocks.get(wireIndex); const delta = object(event.delta); if (!state || !wire || !delta) throw new ProviderProtocolError("Anthropic content delta did not match an open block"); const kind = string(delta.type);
          if (state.type === "text" && state.index !== undefined && (kind === "text_delta" || kind === "refusal_delta")) { const text = string(delta.text) ?? string(delta.refusal) ?? ""; builder.textDelta(state.index, text); const field = kind === "refusal_delta" ? "refusal" : "text"; wire[field] = `${string(wire[field]) ?? ""}${text}`; }
          else if (state.type === "thinking" && state.index !== undefined && kind === "thinking_delta") { const text = string(delta.thinking) ?? ""; builder.thinkingDelta(state.index, text); wire.thinking = `${string(wire.thinking) ?? ""}${text}`; }
          else if (state.type === "thinking" && kind === "signature_delta") { const signature = string(delta.signature) ?? ""; state.signature = (state.signature ?? "") + signature; wire.signature = `${string(wire.signature) ?? ""}${signature}`; }
          else if (state.tool && kind === "input_json_delta") builder.toolDelta(state.tool, string(delta.partial_json) ?? "");
          else unknown(event, `content_block_delta:${kind ?? "unknown"}`, wireIndex);
        } else if (type === "content_block_stop") {
          bodyStarted = true; semantic = true; commitMetadata(); const wireIndex = number(event.index) ?? -1; const state = blocks.get(wireIndex); if (!state) throw new ProviderProtocolError("Anthropic content block stop did not match an open block"); finishBlock(wireIndex, state);
        } else if (type === "message_delta") {
          bodyStarted = true; usage = mergeUsage(usage, event.usage); if (committed) commitMetadata(); const delta = object(event.delta); const stop = string(delta?.stop_reason);
          if (stop === "refusal") throw new Error(refusalExplanation(object(delta?.stop_details)?.explanation) ?? "The model refused to complete the request"); if (stop === "sensitive") throw new Error("The provider blocked sensitive content"); terminal = stop === "max_tokens" ? "length" : stop === "tool_use" ? "toolUse" : "stop";
        } else if (type === "message_stop") {
          bodyStarted = true; sawStop = true; commitMetadata(); closeBlocks(); terminal ??= builder.message.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
        } else if (type === "error") {
          bodyStarted = true; const error = object(event.error); const code = string(error?.code) ?? string(error?.type); throw new ProviderStreamError(streamErrorMessage(event.error, "Anthropic stream error"), code);
        } else {
          bodyStarted = true; semantic = true; commitMetadata(); unknown(event, type, number(event.index));
        }
      }
      if (!sawStop) throw new PrematureProviderEofError(`Anthropic stream ended before message_stop${semantic ? " after partial output" : ""}`);
    } catch (error) {
      if (error instanceof PrematureProviderEofError && !semantic && attempt < retries && options?.signal?.aborted !== true) continue;
      if (semantic) closeBlocks();
      builder.diagnostic(providerFailureDiagnostic(failureDiagnosticDetails(error, { partial: semantic, bodyStarted, ...(options?.signal === undefined ? {} : { aborted: options.signal.aborted }), ...(observedResponse === undefined ? {} : { response: observedResponse }) })));
      throw error;
    }
    const value: Record_ = { assistantBlocks: [...wireBlocks.entries()].sort(([left], [right]) => left - right).map(([, block]) => block) }; if (unknownEvents.length) value.unknownEvents = unknownEvents;
    builder.providerState({ source: { api: model.api, provider: model.provider, model: model.id }, value }); if (observedResponse) builder.diagnostic(providerResponseDiagnostic(observedResponse)); builder.done(terminal ?? "stop"); return;
  }
}
export const stream: StreamFunction<"anthropic-messages", AnthropicOptions> = (model, context, options) => streamTask(model, (builder) => execute(builder, model, context, options), options?.signal);
export const streamSimple: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (model, context, options) => { const effort = resolveSimpleReasoning(model, options?.reasoning); const mapped = effort === undefined ? undefined : model.thinkingLevelMap?.[effort] ?? effort; const allowed: AnthropicEffort | undefined = mapped === "low" || mapped === "medium" || mapped === "high" || mapped === "xhigh" || mapped === "max" ? mapped : undefined; const budgets: Partial<Record<ThinkingLevel, number>> = options?.thinkingBudgets ?? {}; return stream(model, context, { ...buildBaseOptions(model, context, options), thinkingEnabled: effort !== undefined, ...(allowed === undefined ? {} : { effort: allowed }), ...(effort === undefined ? {} : { thinkingBudgetTokens: budgets[effort] }) }); };
