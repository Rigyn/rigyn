import type { AssistantMessage, AssistantMessageEvent, Model, SimpleStreamOptions, StreamFunction, StreamOptions, ThinkingLevel, ToolCall, Usage } from "../types.js";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.js";
import { createAssistantMessageEventStream } from "../utils/event-stream.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { providerFetch, readSse } from "./internal/http.js";
import { buildBaseOptions, resolveSimpleReasoning } from "./simple-options.js";

export interface RigynMessagesOptions extends StreamOptions { reasoning?: ThinkingLevel; toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } }; debug?: boolean; }
export type RigynMessagesRewriteImpact = { policyId: string; policyVersion: number; changed: boolean; tokenCountChange: number; messageCountChange: number; systemPromptChanged: boolean };
export type RigynMessagesEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string; contentSignature?: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string; contentSignature?: string; redacted?: boolean }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; usage: Usage; responseId?: string; rewrite?: RigynMessagesRewriteImpact }
  | { type: "error"; reason: "aborted" | "error"; usage: Usage; errorMessage?: string; responseId?: string; rewrite?: RigynMessagesRewriteImpact };

export class RigynMessagesResponseError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, readonly diagnosticDetails: Record<string, unknown>, message: string) { super(message); this.name = "RigynMessagesResponseError"; }
}
const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
function errorMessage(model: Model<"rigyn-messages">, error: unknown, aborted: boolean): AssistantMessage { const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: aborted ? "aborted" : "error", errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now() }; if (error instanceof RigynMessagesResponseError) appendAssistantMessageDiagnostic(message, { type: "rigyn_messages_response_failure", message: error.message, error: { name: error.name, message: error.message, status: error.status, ...(error.code === undefined ? {} : { code: error.code }) }, details: error.diagnosticDetails, timestamp: Date.now() }); return message; }
function converter(model: Model<"rigyn-messages">): (event: RigynMessagesEvent) => AssistantMessageEvent {
  const partial: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: "stop", timestamp: Date.now() }; const json = new Map<number, string>();
  return (event) => {
    if (event.type === "done") { partial.stopReason = event.reason; partial.usage = event.usage; if (event.responseId) partial.responseId = event.responseId; if (event.rewrite) appendAssistantMessageDiagnostic(partial, { type: "rigyn_messages_rewrite", message: "Gateway policy rewrote the request", details: { ...event.rewrite }, timestamp: Date.now() }); return { type: "done", reason: event.reason, message: structuredClone(partial) }; }
    if (event.type === "error") { partial.stopReason = event.reason; partial.usage = event.usage; if (event.errorMessage) partial.errorMessage = event.errorMessage; if (event.responseId) partial.responseId = event.responseId; if (event.rewrite) appendAssistantMessageDiagnostic(partial, { type: "rigyn_messages_rewrite", message: "Gateway policy rewrote the request", details: { ...event.rewrite }, timestamp: Date.now() }); return { type: "error", reason: event.reason, error: structuredClone(partial) }; }
    if (event.type === "start") return { type: "start", partial: structuredClone(partial) };
    if (event.type === "text_start") partial.content[event.contentIndex] = { type: "text", text: "" };
    else if (event.type === "text_delta") { const block = partial.content[event.contentIndex]; if (block?.type === "text") block.text += event.delta; }
    else if (event.type === "text_end") { partial.content[event.contentIndex] = { type: "text", text: event.content, ...(event.contentSignature === undefined ? {} : { textSignature: event.contentSignature }) }; }
    else if (event.type === "thinking_start") partial.content[event.contentIndex] = { type: "thinking", thinking: "" };
    else if (event.type === "thinking_delta") { const block = partial.content[event.contentIndex]; if (block?.type === "thinking") block.thinking += event.delta; }
    else if (event.type === "thinking_end") partial.content[event.contentIndex] = { type: "thinking", thinking: event.content, ...(event.contentSignature === undefined ? {} : { thinkingSignature: event.contentSignature }), ...(event.redacted === undefined ? {} : { redacted: event.redacted }) };
    else if (event.type === "toolcall_start") { partial.content[event.contentIndex] = { type: "toolCall", id: event.id, name: event.toolName, arguments: {} }; json.set(event.contentIndex, ""); }
    else if (event.type === "toolcall_delta") { const value = (json.get(event.contentIndex) ?? "") + event.delta; json.set(event.contentIndex, value); const block = partial.content[event.contentIndex]; if (block?.type === "toolCall") block.arguments = parseStreamingJson(value); }
    else if (event.type === "toolcall_end") { partial.content[event.contentIndex] = event.toolCall; json.delete(event.contentIndex); return { type: "toolcall_end", contentIndex: event.contentIndex, toolCall: structuredClone(event.toolCall), partial: structuredClone(partial) }; }
    return { ...event, partial: structuredClone(partial) } as AssistantMessageEvent;
  };
}
export const stream: StreamFunction<"rigyn-messages", RigynMessagesOptions> = (model, context, options) => {
  const output = createAssistantMessageEventStream(); const convert = converter(model); queueMicrotask(() => void (async () => { try { if (!options?.apiKey) throw new Error(`No API key provided for provider "${model.provider}"`); const base = model.baseUrl.replace(/\/+$/u, ""); const url = `${base}/messages${options.debug ? "?debug=1" : ""}`; const response = await providerFetch({ model, url, body: { model: model.id, context, options: { ...(options.temperature === undefined ? {} : { temperature: options.temperature }), ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }), ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }), ...(options.cacheRetention === undefined ? {} : { cacheRetention: options.cacheRetention }), ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }), ...(options.toolChoice === undefined ? {} : { toolChoice: options.toolChoice }) } }, options, headers: { authorization: `Bearer ${options.apiKey}` } }); let terminal = false; for await (const raw of readSse(response)) { if (raw.data === "[DONE]") continue; const event = JSON.parse(raw.data) as RigynMessagesEvent; const converted = convert(event); output.push(converted); if (converted.type === "done" || converted.type === "error") { terminal = true; break; } } if (!terminal) throw new Error(`${model.provider} stream ended without a terminal event`); } catch (error) { const message = errorMessage(model, error, options?.signal?.aborted ?? false); output.push({ type: "error", reason: message.stopReason as "error" | "aborted", error: message }); } })()); return output;
};
export const streamSimple: StreamFunction<"rigyn-messages", SimpleStreamOptions> = (model, context, options) => { const reasoning = resolveSimpleReasoning(model, options?.reasoning); return stream(model, context, { ...buildBaseOptions(model, context, options), ...(reasoning === undefined ? {} : { reasoning }) }); };
