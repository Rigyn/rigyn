import type { Context, Model, StreamOptions } from "../types.js";
import { providerFetch, readSse } from "./internal/http.js";
import type { MessageStreamBuilder } from "./internal/message-stream.js";
import { convertMessages, convertTools, mapGoogleStopReason, retainThoughtSignature, type GoogleThinkingLevel } from "./google-shared.js";
import { shortHash } from "../utils/hash.js";

export interface GoogleRuntimeOptions extends StreamOptions { toolChoice?: "auto" | "none" | "any"; thinking?: { enabled: boolean; budgetTokens?: number; level?: GoogleThinkingLevel }; }
export interface GoogleTransport<TOptions extends GoogleRuntimeOptions> { endpoint(model: Model<string>, options?: TOptions): string; headers(model: Model<string>, options?: TOptions): HeadersInit; }
type Record_ = Record<string, unknown>;
const object = (value: unknown): Record_ | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record_ : undefined;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
function body(model: Model<string>, context: Context, options?: GoogleRuntimeOptions): Record_ {
  const result: Record_ = { contents: convertMessages(model as Model<"google-generative-ai">, context), generationConfig: { maxOutputTokens: Math.max(1, Math.min(options?.maxTokens ?? model.maxTokens, model.maxTokens)), ...(options?.temperature === undefined ? {} : { temperature: options.temperature }), ...(options?.thinking ? { thinkingConfig: { includeThoughts: options.thinking.enabled, ...(options.thinking.budgetTokens === undefined ? {} : { thinkingBudget: options.thinking.budgetTokens }), ...(options.thinking.level === undefined ? {} : { thinkingLevel: options.thinking.level }) } } : {}) } };
  if (context.systemPrompt) result.systemInstruction = { parts: [{ text: context.systemPrompt }] };
  const tools = convertTools(context.tools); if (tools) result.tools = tools;
  if (options?.toolChoice) result.toolConfig = { functionCallingConfig: { mode: options.toolChoice.toUpperCase() } };
  return result;
}
function usage(builder: MessageStreamBuilder<string>, value: unknown): void { const entry = object(value); if (!entry) return; const prompt = number(entry.promptTokenCount) ?? 0; const cacheRead = number(entry.cachedContentTokenCount) ?? 0; const outputText = number(entry.candidatesTokenCount) ?? 0; const reasoning = number(entry.thoughtsTokenCount) ?? 0; builder.usage({ input: Math.max(0, prompt - cacheRead), output: outputText + reasoning, cacheRead, cacheWrite: 0, reasoning, totalTokens: number(entry.totalTokenCount) ?? prompt + outputText + reasoning }); }
export async function executeGoogle<TOptions extends GoogleRuntimeOptions>(builder: MessageStreamBuilder<string>, model: Model<string>, context: Context, options: TOptions | undefined, transport: GoogleTransport<TOptions>): Promise<void> {
  const response = await providerFetch({ model, url: transport.endpoint(model, options), body: body(model, context, options), ...(options === undefined ? {} : { options }), headers: transport.headers(model, options) }); builder.start();
  let textIndex: number | undefined; let textSignature: string | undefined; let thoughtIndex: number | undefined; let thoughtSignature: string | undefined; let finish: string | undefined; let toolCount = 0;
  for await (const raw of readSse(response)) {
    let chunk: Record_; try { chunk = JSON.parse(raw.data) as Record_; } catch { continue; } usage(builder, chunk.usageMetadata); const candidate = object(array(chunk.candidates)[0]); if (!candidate) continue; finish = string(candidate.finishReason) ?? finish; const content = object(candidate.content);
    for (const item of array(content?.parts)) { const part = object(item) ?? {}; const signature = string(part.thoughtSignature); const text = string(part.text); const thought = part.thought === true;
      if (text !== undefined && thought) { thoughtIndex ??= builder.thinkingStart(); thoughtSignature = retainThoughtSignature(thoughtSignature, signature); builder.thinkingDelta(thoughtIndex, text); }
      else if (text !== undefined) { textIndex ??= builder.textStart(); textSignature = retainThoughtSignature(textSignature, signature); builder.textDelta(textIndex, text); }
      const call = object(part.functionCall); if (call) { const id = string(call.id) ?? `call_${shortHash(`${Date.now()}:${toolCount}`)}`; const tool = builder.toolStart(id, string(call.name) ?? "tool"); builder.toolDelta(tool, JSON.stringify(object(call.args) ?? {})); builder.toolEnd(tool, signature); toolCount += 1; }
    }
    const responseId = string(chunk.responseId); const responseModel = string(chunk.modelVersion); builder.response({ ...(responseId === undefined ? {} : { responseId }), ...(responseModel === undefined ? {} : { responseModel }) });
  }
  if (textIndex !== undefined) { const block = builder.message.content[textIndex]; if (block?.type === "text" && textSignature) block.textSignature = textSignature; builder.textEnd(textIndex); }
  if (thoughtIndex !== undefined) builder.thinkingEnd(thoughtIndex, thoughtSignature);
  if (finish === undefined) throw new Error("Google stream ended before a finish reason"); builder.done(mapGoogleStopReason(finish, toolCount > 0));
}
