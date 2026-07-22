import type { Context, ImageContent, Model, SimpleStreamOptions, StreamFunction, StreamOptions, TextContent, ToolCall } from "../types.js";
import { streamTask, type MessageStreamBuilder } from "./internal/message-stream.js";
import { buildBaseOptions, resolveSimpleReasoning } from "./simple-options.js";
import { shortHash } from "../utils/hash.js";
import { transformMessages } from "./transform-messages.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";

type MistralReasoningEffort = "none" | "high";
export interface MistralOptions extends StreamOptions { toolChoice?: "auto" | "none" | "any" | "required" | { type: "function"; function: { name: string } }; promptMode?: "reasoning"; reasoningEffort?: MistralReasoningEffort; }
type Record_ = Record<string, unknown>;
const object = (value: unknown): Record_ | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record_ : undefined;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
function id(value: string): string { const normalized = value.replace(/[^a-z0-9]/giu, ""); return normalized.length === 9 ? normalized : shortHash(normalized || value).replace(/[^a-z0-9]/giu, "").slice(0, 9); }
function content(value: string | Array<TextContent | ImageContent>): unknown { if (typeof value === "string") return sanitizeSurrogates(value); return value.map((block) => block.type === "text" ? { type: "text", text: sanitizeSurrogates(block.text) } : { type: "image_url", imageUrl: `data:${block.mimeType};base64,${block.data}` }); }
function messages(model: Model<"mistral-conversations">, context: Context): Record_[] {
  const output: Record_[] = context.systemPrompt ? [{ role: "system", content: sanitizeSurrogates(context.systemPrompt) }] : [];
  for (const message of transformMessages(context.messages, model, (value) => id(value))) {
    if (message.role === "user") output.push({ role: "user", content: content(message.content) });
    else if (message.role === "assistant") { const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join(""); const thoughts = message.content.filter((block) => block.type === "thinking").map((block) => block.thinking).join("\n"); const calls = message.content.filter((block): block is ToolCall => block.type === "toolCall"); const entry: Record_ = { role: "assistant", content: text }; if (thoughts) entry.reasoning = thoughts; if (calls.length) entry.toolCalls = calls.map((call) => ({ id: id(call.id), function: { name: call.name, arguments: JSON.stringify(call.arguments) }, type: "function" })); if (text || thoughts || calls.length) output.push(entry); }
    else { output.push({ role: "tool", toolCallId: id(message.toolCallId), name: message.toolName, content: message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") || "No output" }); const images = message.content.filter((block) => block.type === "image"); if (images.length && model.input.includes("image")) output.push({ role: "user", content: images.map((block) => ({ type: "image_url", imageUrl: `data:${block.mimeType};base64,${block.data}` })) }); }
  }
  return output;
}
function body(model: Model<"mistral-conversations">, context: Context, options?: MistralOptions): Record_ { const result: Record_ = { model: model.id, messages: messages(model, context), stream: true }; if (context.tools?.length) result.tools = context.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } })); if (options?.temperature !== undefined) result.temperature = options.temperature; if (options?.maxTokens !== undefined) result.maxTokens = Math.min(model.maxTokens, options.maxTokens); if (options?.toolChoice) result.toolChoice = options.toolChoice; if (options?.promptMode) result.promptMode = options.promptMode; if (options?.reasoningEffort) result.reasoningEffort = options.reasoningEffort; if (options?.sessionId && options.cacheRetention !== "none") result.promptCacheKey = options.sessionId; return result; }
async function execute(builder: MessageStreamBuilder<"mistral-conversations">, model: Model<"mistral-conversations">, context: Context, options?: MistralOptions): Promise<void> {
  if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
  const module = await import("@mistralai/mistralai");
  const client = new module.Mistral({ apiKey: options.apiKey, serverURL: model.baseUrl });
  let payload: unknown = body(model, context, options); payload = await options.onPayload?.(payload, model) ?? payload;
  const wireHeaders = new Headers(model.headers); for (const [name, value] of Object.entries(options.headers ?? {})) if (value !== null) wireHeaders.set(name, value); const headers = Object.fromEntries(wireHeaders.entries());
  if (options.sessionId && options.cacheRetention !== "none" && headers["x-affinity"] === undefined) headers["x-affinity"] = options.sessionId;
  const events = await client.chat.stream(payload as never, { retries: { strategy: "none" }, ...(options.signal === undefined ? {} : { signal: options.signal }), ...(Object.keys(headers).length ? { headers } : {}) });
  await options.onResponse?.({ status: 200, headers: {} }, model); builder.start(); let textIndex: number | undefined; let thinkingIndex: number | undefined; const tools = new Map<number, { index: number; json: string }>(); let terminal: "stop" | "length" | "toolUse" | undefined;
  for await (const envelope of events) { const chunk = object((envelope as { data?: unknown }).data) ?? {}; const responseId = string(chunk.id); const responseModel = string(chunk.model); builder.response({ ...(responseId === undefined ? {} : { responseId }), ...(responseModel === undefined ? {} : { responseModel }) }); const usage = object(chunk.usage); if (usage) { const prompt = number(usage.promptTokens) ?? number(usage.prompt_tokens) ?? 0; const completion = number(usage.completionTokens) ?? number(usage.completion_tokens) ?? 0; const cached = number(object(usage.promptTokensDetails)?.cachedTokens) ?? number(object(usage.prompt_tokens_details)?.cached_tokens) ?? number(usage.numCachedTokens) ?? 0; builder.usage({ input: Math.max(0, prompt - cached), output: completion, cacheRead: Math.min(prompt, cached), cacheWrite: 0, totalTokens: number(usage.totalTokens) ?? number(usage.total_tokens) ?? prompt + completion }); }
    const choice = object(array(chunk.choices)[0]); if (!choice) continue; const delta = object(choice.delta) ?? {}; const rawContent = delta.content;
    if (typeof rawContent === "string") { textIndex ??= builder.textStart(); builder.textDelta(textIndex, rawContent); }
    else for (const rawPart of array(rawContent)) { const part = object(rawPart) ?? {}; const type = string(part.type); const text = string(part.text) ?? string(part.content); if (type === "thinking" || type === "reasoning") { thinkingIndex ??= builder.thinkingStart(); builder.thinkingDelta(thinkingIndex, text ?? ""); } else if (text) { textIndex ??= builder.textStart(); builder.textDelta(textIndex, text); } }
    const reasoning = string(delta.reasoning) ?? string(delta.reasoningContent); if (reasoning) { thinkingIndex ??= builder.thinkingStart(); builder.thinkingDelta(thinkingIndex, reasoning); }
    for (const rawCall of array(delta.toolCalls ?? delta.tool_calls)) { const call = object(rawCall) ?? {}; const index = number(call.index) ?? tools.size; const fn = object(call.function) ?? {}; let tool = tools.get(index); if (!tool) { tool = builder.toolStart(id(string(call.id) ?? `${Date.now()}${index}`), string(fn.name) ?? "tool"); tools.set(index, tool); } const fragment = string(fn.arguments); if (fragment) builder.toolDelta(tool, fragment); }
    const finish = string(choice.finishReason) ?? string(choice.finish_reason); if (finish) terminal = finish === "length" || finish === "model_length" ? "length" : finish.includes("tool") ? "toolUse" : "stop";
  }
  if (textIndex !== undefined) builder.textEnd(textIndex); if (thinkingIndex !== undefined) builder.thinkingEnd(thinkingIndex); for (const tool of tools.values()) builder.toolEnd(tool); if (!terminal) throw new Error("Mistral stream ended before a finish reason"); builder.done(terminal);
}
export const stream: StreamFunction<"mistral-conversations", MistralOptions> = (model, context, options) => streamTask(model, (builder) => execute(builder, model, context, options), options?.signal);
export const streamSimple: StreamFunction<"mistral-conversations", SimpleStreamOptions> = (model, context, options) => { const reasoning = resolveSimpleReasoning(model, options?.reasoning); const usesEffort = /magistral/iu.test(model.id); return stream(model, context, { ...buildBaseOptions(model, context, options), ...(reasoning === undefined ? {} : usesEffort ? { reasoningEffort: "high" } : { promptMode: "reasoning" }) }); };
