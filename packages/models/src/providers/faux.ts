import { createProvider, type Provider } from "../models.js";
import type { AssistantMessage, AssistantMessageEventStream, Context, ImageContent, Message, Model, SimpleStreamOptions, StreamFunction, StreamOptions, TextContent, ThinkingContent, ToolCall, Usage } from "../types.js";
import { createAssistantMessageEventStream } from "../utils/event-stream.js";
import { uuidv7 } from "../utils/uuid.js";

const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
export interface FauxModelDefinition { id: string; name?: string; reasoning?: boolean; input?: Array<"text" | "image">; cost?: Usage["cost"]; contextWindow?: number; maxTokens?: number; }
export type FauxContentBlock = TextContent | ThinkingContent | ToolCall;
export function fauxText(text: string): TextContent { return { type: "text", text }; }
export function fauxThinking(thinking: string): ThinkingContent { return { type: "thinking", thinking }; }
export function fauxToolCall(name: string, arguments_: ToolCall["arguments"], options: { id?: string } = {}): ToolCall { return { type: "toolCall", id: options.id ?? `tool_${uuidv7()}`, name, arguments: arguments_ }; }
export function fauxAssistantMessage(content: string | FauxContentBlock | FauxContentBlock[], options: { stopReason?: AssistantMessage["stopReason"]; errorMessage?: string; responseId?: string; timestamp?: number } = {}): AssistantMessage {
  const blocks = typeof content === "string" ? [fauxText(content)] : Array.isArray(content) ? content : [content];
  return { role: "assistant", content: blocks, api: "faux", provider: "faux", model: "faux-1", usage: zeroUsage(), stopReason: options.stopReason ?? "stop", ...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }), ...(options.responseId === undefined ? {} : { responseId: options.responseId }), timestamp: options.timestamp ?? Date.now() };
}
export type FauxResponseFactory = (context: Context, options: StreamOptions | undefined, state: { callCount: number }, model: Model<string>) => AssistantMessage | Promise<AssistantMessage>;
export type FauxResponseStep = AssistantMessage | FauxResponseFactory;
export interface RegisterFauxProviderOptions { api?: string; provider?: string; models?: FauxModelDefinition[]; tokensPerSecond?: number; tokenSize?: { min?: number; max?: number }; }
interface FauxControls { api: string; models: [Model<string>, ...Model<string>[]]; getModel(): Model<string>; getModel(modelId: string): Model<string> | undefined; state: { callCount: number }; setResponses(responses: FauxResponseStep[]): void; appendResponses(responses: FauxResponseStep[]): void; getPendingResponseCount(): number; }
export interface FauxProviderHandle extends FauxControls { provider: Provider; }
export interface FauxProviderRegistration extends FauxControls { unregister(): void; }

function contentText(content: string | Array<TextContent | ImageContent>): string { return typeof content === "string" ? content : content.map((block) => block.type === "text" ? block.text : `[image:${block.mimeType}:${block.data.length}]`).join("\n"); }
function messageText(message: Message): string {
  if (message.role === "user") return contentText(message.content);
  if (message.role === "toolResult") return [message.toolName, contentText(message.content)].join("\n");
  return message.content.map((block) => block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : `${block.name}:${JSON.stringify(block.arguments)}`).join("\n");
}
function serialize(context: Context): string { return [...(context.systemPrompt ? [`system:${context.systemPrompt}`] : []), ...context.messages.map((message) => `${message.role}:${messageText(message)}`), ...(context.tools?.length ? [`tools:${JSON.stringify(context.tools)}`] : [])].join("\n\n"); }
function prefixLength(left: string, right: string): number { let index = 0; while (index < left.length && index < right.length && left[index] === right[index]) index += 1; return index; }
function outputText(message: AssistantMessage): string { return message.content.map((block) => block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : `${block.name}:${JSON.stringify(block.arguments)}`).join("\n"); }
function applyUsage(message: AssistantMessage, context: Context, options: StreamOptions | undefined, cache: Map<string, string>): AssistantMessage {
  const prompt = serialize(context); const promptTokens = Math.ceil(prompt.length / 4); const output = Math.ceil(outputText(message).length / 4); let input = promptTokens; let cacheRead = 0; let cacheWrite = 0;
  if (options?.sessionId && options.cacheRetention !== "none") { const previous = cache.get(options.sessionId); if (previous) { const shared = prefixLength(previous, prompt); cacheRead = Math.ceil(shared / 4); cacheWrite = Math.ceil((prompt.length - shared) / 4); input = Math.max(0, promptTokens - cacheRead); } else cacheWrite = promptTokens; cache.set(options.sessionId, prompt); }
  return { ...message, usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: zeroUsage().cost } };
}
function chunks(text: string, minimum: number, maximum: number): string[] { const output: string[] = []; for (let index = 0; index < text.length;) { const tokens = minimum + Math.floor(Math.random() * (maximum - minimum + 1)); const end = index + Math.max(1, tokens * 4); output.push(text.slice(index, end)); index = end; } return output.length ? output : [""]; }
function snapshot(message: AssistantMessage): AssistantMessage { return structuredClone(message); }
function failure(model: Model<string>, error: unknown, reason: "error" | "aborted" = "error"): AssistantMessage { return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: reason, errorMessage: reason === "aborted" ? "Request was aborted" : error instanceof Error ? error.message : String(error), timestamp: Date.now() }; }

async function emit(stream: AssistantMessageEventStream, message: AssistantMessage, options: StreamOptions | undefined, minimum: number, maximum: number, rate?: number): Promise<void> {
  const partial: AssistantMessage = { ...message, content: [] };
  const wait = async (part: string) => { if (rate && rate > 0) await new Promise((resolve) => setTimeout(resolve, Math.ceil(part.length / 4 / rate * 1_000))); else await new Promise<void>((resolve) => queueMicrotask(resolve)); };
  const abort = () => { if (!options?.signal?.aborted) return false; const error = { ...partial, stopReason: "aborted" as const, errorMessage: "Request was aborted", timestamp: Date.now() }; stream.push({ type: "error", reason: "aborted", error }); return true; };
  if (abort()) return;
  stream.push({ type: "start", partial: snapshot(partial) });
  for (const [index, block] of message.content.entries()) {
    if (abort()) return;
    if (block.type === "text") {
      partial.content.push({ ...block, text: "" }); stream.push({ type: "text_start", contentIndex: index, partial: snapshot(partial) });
      for (const part of chunks(block.text, minimum, maximum)) { await wait(part); if (abort()) return; (partial.content[index] as TextContent).text += part; stream.push({ type: "text_delta", contentIndex: index, delta: part, partial: snapshot(partial) }); }
      stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: snapshot(partial) });
    } else if (block.type === "thinking") {
      partial.content.push({ ...block, thinking: "" }); stream.push({ type: "thinking_start", contentIndex: index, partial: snapshot(partial) });
      for (const part of chunks(block.thinking, minimum, maximum)) { await wait(part); if (abort()) return; (partial.content[index] as ThinkingContent).thinking += part; stream.push({ type: "thinking_delta", contentIndex: index, delta: part, partial: snapshot(partial) }); }
      stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: snapshot(partial) });
    } else {
      partial.content.push({ ...block, arguments: {} }); stream.push({ type: "toolcall_start", contentIndex: index, partial: snapshot(partial) });
      for (const part of chunks(JSON.stringify(block.arguments), minimum, maximum)) { await wait(part); if (abort()) return; stream.push({ type: "toolcall_delta", contentIndex: index, delta: part, partial: snapshot(partial) }); }
      partial.content[index] = block; stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: snapshot(partial) });
    }
  }
  if (message.stopReason === "error" || message.stopReason === "aborted") stream.push({ type: "error", reason: message.stopReason, error: message });
  else stream.push({ type: "done", reason: message.stopReason, message });
}

export function createFauxCore(options: RegisterFauxProviderOptions = {}) {
  const api = options.api ?? `faux-${uuidv7()}`; const provider = options.provider ?? "faux"; const minimum = Math.max(1, Math.min(options.tokenSize?.min ?? 3, options.tokenSize?.max ?? 5)); const maximum = Math.max(minimum, options.tokenSize?.max ?? 5); const cache = new Map<string, string>(); const state = { callCount: 0 }; let queue: FauxResponseStep[] = [];
  const definitions = options.models?.length ? options.models : [{ id: "faux-1", name: "Faux Model", input: ["text", "image"] as Array<"text" | "image"> }];
  const models = definitions.map((definition) => ({ id: definition.id, name: definition.name ?? definition.id, api, provider, baseUrl: "http://localhost:0", reasoning: definition.reasoning ?? false, input: definition.input ?? ["text", "image"], cost: definition.cost ?? zeroUsage().cost, contextWindow: definition.contextWindow ?? 128_000, maxTokens: definition.maxTokens ?? 16_384 })) as unknown as [Model<string>, ...Model<string>[]];
  const stream: StreamFunction<string, StreamOptions> = (model, context, streamOptions) => { const output = createAssistantMessageEventStream(); const step = queue.shift(); state.callCount += 1; queueMicrotask(() => void (async () => { try { await streamOptions?.onResponse?.({ status: 200, headers: {} }, model); if (!step) throw new Error("No faux response is queued"); const resolved = typeof step === "function" ? await step(context, streamOptions, state, model) : step; const message = applyUsage({ ...structuredClone(resolved), api, provider, model: model.id, timestamp: resolved.timestamp ?? Date.now() }, context, streamOptions, cache); await emit(output, message, streamOptions, minimum, maximum, options.tokensPerSecond); } catch (error) { const message = failure(model, error, streamOptions?.signal?.aborted ? "aborted" : "error"); output.push({ type: "error", reason: message.stopReason as "error" | "aborted", error: message }); } })()); return output; };
  function getModel(): Model<string>;
  function getModel(id: string): Model<string> | undefined;
  function getModel(id?: string): Model<string> | undefined { return id === undefined ? models[0] : models.find((model) => model.id === id); }
  return { api, provider, models, stream, streamSimple: stream as StreamFunction<string, SimpleStreamOptions>, getModel, state, setResponses(responses: FauxResponseStep[]) { queue = [...responses]; }, appendResponses(responses: FauxResponseStep[]) { queue.push(...responses); }, getPendingResponseCount() { return queue.length; } };
}
export function fauxProvider(options: RegisterFauxProviderOptions = {}): FauxProviderHandle {
  const core = createFauxCore(options); const provider = createProvider({ id: core.provider, auth: { apiKey: { name: "Faux", async resolve() { return { auth: {} }; } } }, models: core.models, api: { stream: core.stream, streamSimple: core.streamSimple } });
  return { provider, api: core.api, models: core.models, getModel: core.getModel, state: core.state, setResponses: core.setResponses, appendResponses: core.appendResponses, getPendingResponseCount: core.getPendingResponseCount };
}
