import type { Api, AssistantMessage, AssistantMessageEventStream, Model, OpaqueProviderState, StopReason, ToolCall, Usage } from "../../types.js";
import type { AssistantMessageDiagnostic } from "../../utils/diagnostics.js";
import { calculateCost } from "../../models.js";
import { createAssistantMessageEventStream } from "../../utils/event-stream.js";
import { parseStreamingJson } from "../../utils/json-parse.js";

export function emptyUsage(): Usage { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; }

export class MessageStreamBuilder<TApi extends Api> {
  readonly stream: AssistantMessageEventStream = createAssistantMessageEventStream();
  readonly message: AssistantMessage;
  #terminal = false;
  constructor(readonly model: Model<TApi>) {
    this.message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: emptyUsage(), stopReason: "stop", timestamp: Date.now() };
  }
  start(): void { this.stream.push({ type: "start", partial: structuredClone(this.message) }); }
  textStart(): number { const index = this.message.content.length; this.message.content.push({ type: "text", text: "" }); this.stream.push({ type: "text_start", contentIndex: index, partial: structuredClone(this.message) }); return index; }
  textDelta(index: number, delta: string): void { if (!delta) return; const block = this.message.content[index]; if (block?.type !== "text") throw new Error("Text delta targeted a non-text content block"); block.text += delta; this.stream.push({ type: "text_delta", contentIndex: index, delta, partial: structuredClone(this.message) }); }
  textEnd(index: number): void { const block = this.message.content[index]; if (block?.type !== "text") return; this.stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: structuredClone(this.message) }); }
  thinkingStart(): number { const index = this.message.content.length; this.message.content.push({ type: "thinking", thinking: "" }); this.stream.push({ type: "thinking_start", contentIndex: index, partial: structuredClone(this.message) }); return index; }
  thinkingDelta(index: number, delta: string): void { if (!delta) return; const block = this.message.content[index]; if (block?.type !== "thinking") throw new Error("Thinking delta targeted a non-thinking content block"); block.thinking += delta; this.stream.push({ type: "thinking_delta", contentIndex: index, delta, partial: structuredClone(this.message) }); }
  thinkingEnd(index: number, signature?: string, redacted?: boolean): void { const block = this.message.content[index]; if (block?.type !== "thinking") return; if (signature !== undefined) block.thinkingSignature = signature; if (redacted !== undefined) block.redacted = redacted; this.stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: structuredClone(this.message) }); }
  toolStart(id: string, name: string): { index: number; json: string } { const index = this.message.content.length; this.message.content.push({ type: "toolCall", id, name, arguments: {} }); this.stream.push({ type: "toolcall_start", contentIndex: index, partial: structuredClone(this.message) }); return { index, json: "" }; }
  toolDelta(tool: { index: number; json: string }, delta: string): void { tool.json += delta; const block = this.message.content[tool.index]; if (block?.type === "toolCall") block.arguments = parseStreamingJson(tool.json); this.stream.push({ type: "toolcall_delta", contentIndex: tool.index, delta, partial: structuredClone(this.message) }); }
  toolEnd(tool: { index: number; json: string }, thoughtSignature?: string): ToolCall { const block = this.message.content[tool.index]; if (block?.type !== "toolCall") throw new Error("Tool completion targeted a non-tool content block"); block.arguments = parseStreamingJson(tool.json); if (thoughtSignature !== undefined) block.thoughtSignature = thoughtSignature; this.stream.push({ type: "toolcall_end", contentIndex: tool.index, toolCall: structuredClone(block), partial: structuredClone(this.message) }); return block; }
  usage(values: Partial<Omit<Usage, "cost">>): void { Object.assign(this.message.usage, values); this.message.usage.totalTokens ||= this.message.usage.input + this.message.usage.output + this.message.usage.cacheRead + this.message.usage.cacheWrite; }
  response(values: { responseId?: string; responseModel?: string }): void { if (values.responseId !== undefined) this.message.responseId = values.responseId; if (values.responseModel !== undefined) this.message.responseModel = values.responseModel; }
  diagnostic(value: AssistantMessageDiagnostic): void { this.message.diagnostics = [...(this.message.diagnostics ?? []), value]; }
  providerState(value: OpaqueProviderState): void { this.message.providerState = value; }
  done(reason: Extract<StopReason, "stop" | "length" | "toolUse">): void { if (this.#terminal) return; this.#terminal = true; this.message.stopReason = reason; calculateCost(this.model, this.message.usage); this.stream.push({ type: "done", reason, message: structuredClone(this.message) }); }
  fail(error: unknown, aborted = false): void { if (this.#terminal) return; this.#terminal = true; this.message.stopReason = aborted ? "aborted" : "error"; this.message.errorMessage = aborted ? "Request was aborted" : error instanceof Error ? error.message : String(error); calculateCost(this.model, this.message.usage); this.stream.push({ type: "error", reason: this.message.stopReason, error: structuredClone(this.message) }); }
  get terminal(): boolean { return this.#terminal; }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (typeof error !== "object" || error === null) return false;
  const shaped = error as { name?: unknown; code?: unknown };
  return shaped.name === "AbortError" || shaped.code === "ABORT_ERR";
}

export function streamTask<TApi extends Api>(model: Model<TApi>, task: (builder: MessageStreamBuilder<TApi>) => Promise<void>, signal?: AbortSignal): AssistantMessageEventStream {
  const builder = new MessageStreamBuilder(model);
  queueMicrotask(() => void task(builder).catch((error) => builder.fail(error, signal?.aborted === true || isAbortError(error))));
  return builder.stream;
}
