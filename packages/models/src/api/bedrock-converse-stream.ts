import type { Context, Model, SimpleStreamOptions, StreamFunction, StreamOptions, ThinkingBudgets, ThinkingLevel } from "../types.js";
import { streamTask, type MessageStreamBuilder } from "./internal/message-stream.js";
import { buildBaseOptions, resolveSimpleReasoning } from "./simple-options.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { shortHash } from "../utils/hash.js";
import { transformMessages } from "./transform-messages.js";

export type BedrockThinkingDisplay = "summarized" | "omitted";
export interface BedrockOptions extends StreamOptions {
  region?: string; profile?: string; toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
  reasoning?: ThinkingLevel; thinkingBudgets?: ThinkingBudgets; interleavedThinking?: boolean;
  thinkingDisplay?: BedrockThinkingDisplay; requestMetadata?: Record<string, string>; bearerToken?: string;
}
type Record_ = Record<string, unknown>;
const object = (value: unknown): Record_ | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record_ : undefined;
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
function imageFormat(mime: string): "png" | "jpeg" | "gif" | "webp" { if (mime === "image/png") return "png"; if (mime === "image/gif") return "gif"; if (mime === "image/webp") return "webp"; return "jpeg"; }
function messages(model: Model<"bedrock-converse-stream">, context: Context): Record_[] {
  const output: Record_[] = [];
  for (const message of transformMessages(context.messages, model, (value) => { const clean = value.replace(/[^a-z0-9_-]/giu, "_"); return clean.length <= 64 ? clean : `${clean.slice(0, 55)}_${shortHash(value).slice(0, 8)}`; })) {
    if (message.role === "user") { const content = typeof message.content === "string" ? [{ text: sanitizeSurrogates(message.content) }] : message.content.map((block) => block.type === "text" ? { text: sanitizeSurrogates(block.text) } : { image: { format: imageFormat(block.mimeType), source: { bytes: Uint8Array.from(Buffer.from(block.data, "base64")) } } }); if (content.length) output.push({ role: "user", content }); }
    else if (message.role === "assistant") { const content: Record_[] = []; for (const block of message.content) { if (block.type === "text" && block.text) content.push({ text: sanitizeSurrogates(block.text) }); else if (block.type === "thinking") { if (block.redacted) content.push({ reasoningContent: { redactedContent: Uint8Array.from(Buffer.from(block.thinkingSignature ?? "", "base64")) } }); else content.push({ reasoningContent: { reasoningText: { text: sanitizeSurrogates(block.thinking), signature: block.thinkingSignature ?? "" } } }); } else if (block.type === "toolCall") content.push({ toolUse: { toolUseId: block.id.split("|", 1)[0], name: block.name, input: block.arguments } }); } if (content.length) output.push({ role: "assistant", content }); }
    else { const content: Record_[] = message.content.map((block) => block.type === "text" ? { text: sanitizeSurrogates(block.text) } : { image: { format: imageFormat(block.mimeType), source: { bytes: Uint8Array.from(Buffer.from(block.data, "base64")) } } }); output.push({ role: "user", content: [{ toolResult: { toolUseId: message.toolCallId.split("|", 1)[0], content: content.length ? content : [{ text: "No output" }], status: message.isError ? "error" : "success" } }] }); }
  }
  return output;
}
function reasoningFields(model: Model<"bedrock-converse-stream">, options?: BedrockOptions): Record_ | undefined { if (!options?.reasoning) return undefined; const defaults: Record<ThinkingLevel, number> = { minimal: 1_024, low: 2_048, medium: 8_192, high: 16_384, xhigh: 32_768, max: 65_536 }; const budget = options.thinkingBudgets?.[options.reasoning] ?? defaults[options.reasoning]; return { thinking: { type: "enabled", budget_tokens: Math.min(Math.max(1_024, budget), model.maxTokens - 1), ...(options.thinkingDisplay ? { display: options.thinkingDisplay } : {}) }, ...(options.interleavedThinking === false ? {} : { anthropic_beta: ["interleaved-thinking-2025-05-14"] }) }; }
function body(model: Model<"bedrock-converse-stream">, context: Context, options?: BedrockOptions): Record_ {
  const result: Record_ = { modelId: model.id, messages: messages(model, context), inferenceConfig: { maxTokens: Math.max(1, Math.min(options?.maxTokens ?? model.maxTokens, model.maxTokens)), ...(options?.temperature === undefined ? {} : { temperature: options.temperature }) } };
  if (context.systemPrompt) result.system = [{ text: sanitizeSurrogates(context.systemPrompt) }];
  if (context.tools?.length) { const toolConfig: Record_ = { tools: context.tools.map((tool) => ({ toolSpec: { name: tool.name, description: tool.description, inputSchema: { json: tool.parameters } } })) }; if (options?.toolChoice && options.toolChoice !== "none") toolConfig.toolChoice = typeof options.toolChoice === "string" ? { [options.toolChoice]: {} } : { tool: { name: options.toolChoice.name } }; result.toolConfig = toolConfig; }
  const reasoning = reasoningFields(model, options); if (reasoning) result.additionalModelRequestFields = reasoning;
  if (options?.requestMetadata) result.requestMetadata = options.requestMetadata;
  return result;
}
function region(model: Model<"bedrock-converse-stream">, options?: BedrockOptions): string { return /^arn:aws(?:-[a-z0-9-]+)?:bedrock:([a-z0-9-]+):/iu.exec(model.id)?.[1] ?? options?.region ?? options?.env?.AWS_REGION ?? options?.env?.AWS_DEFAULT_REGION ?? "us-east-1"; }
function middleware(client: { middlewareStack?: { add(middleware: unknown, options: unknown): void } }, headers: Record<string, string | null> | undefined): void { const clean = Object.fromEntries(Object.entries(headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== null)); if (!Object.keys(clean).length || !client.middlewareStack) return; const handler = (next: (args: unknown) => Promise<unknown>) => async (args: unknown) => { const request = object(object(args)?.request); if (request) request.headers = { ...(object(request.headers) ?? {}), ...clean }; return next(args); }; client.middlewareStack.add(handler, { step: "build", name: "rigynCustomHeaders", priority: "low" }); }
function applyUsage(builder: MessageStreamBuilder<"bedrock-converse-stream">, value: unknown): void { const usage = object(value); if (!usage) return; const input = number(usage.inputTokens) ?? 0; const output = number(usage.outputTokens) ?? 0; const cacheRead = number(usage.cacheReadInputTokens) ?? 0; const cacheWrite = number(usage.cacheWriteInputTokens) ?? 0; builder.usage({ input, output, cacheRead, cacheWrite, totalTokens: number(usage.totalTokens) ?? input + output + cacheRead + cacheWrite }); }
async function execute(builder: MessageStreamBuilder<"bedrock-converse-stream">, model: Model<"bedrock-converse-stream">, context: Context, options?: BedrockOptions): Promise<void> {
  const sdk = await import("@aws-sdk/client-bedrock-runtime"); const bearer = options?.bearerToken ?? options?.apiKey ?? options?.env?.AWS_BEARER_TOKEN_BEDROCK; const config: Record_ = { region: region(model, options), ...(options?.profile ? { profile: options.profile } : {}), ...(bearer ? { token: { token: bearer }, authSchemePreference: ["httpBearerAuth"] } : {}) };
  if (!/bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com/iu.test(model.baseUrl) || options?.region) config.endpoint = model.baseUrl;
  if (options?.env?.AWS_ACCESS_KEY_ID && options.env.AWS_SECRET_ACCESS_KEY) config.credentials = { accessKeyId: options.env.AWS_ACCESS_KEY_ID, secretAccessKey: options.env.AWS_SECRET_ACCESS_KEY, ...(options.env.AWS_SESSION_TOKEN ? { sessionToken: options.env.AWS_SESSION_TOKEN } : {}) };
  if (options?.env?.AWS_BEDROCK_SKIP_AUTH === "1") config.credentials = { accessKeyId: "local", secretAccessKey: "local" };
  const client = new sdk.BedrockRuntimeClient(config as never); middleware(client, options?.headers); let payload: unknown = body(model, context, options); payload = await options?.onPayload?.(payload, model) ?? payload; const command = new sdk.ConverseStreamCommand(payload as never); const response = await client.send(command, options?.signal ? { abortSignal: options.signal } : undefined) as unknown as Record_;
  const metadata = object(response.$metadata); const status = number(metadata?.httpStatusCode); if (status !== undefined) await options?.onResponse?.({ status, headers: string(metadata?.requestId) ? { "x-amzn-requestid": string(metadata?.requestId)! } : {} }, model);
  const wire = response.stream as AsyncIterable<unknown> | undefined; if (!wire) throw new Error("Bedrock returned no response stream"); let started = false; let terminal: "stop" | "length" | "toolUse" | undefined; const blocks = new Map<number, { type: string; index?: number; tool?: { index: number; json: string }; signature?: string }>();
  for await (const raw of wire) { const event = object(raw) ?? {};
    if (event.messageStart) { builder.start(); started = true; }
    else if (event.contentBlockStart) { const start = object(event.contentBlockStart) ?? {}; const index = number(start.contentBlockIndex) ?? blocks.size; const block = object(start.start) ?? {}; const tool = object(block.toolUse); if (tool) blocks.set(index, { type: "tool", tool: builder.toolStart(string(tool.toolUseId) ?? `tool_${shortHash(`${Date.now()}:${index}`)}`, string(tool.name) ?? "tool") }); }
    else if (event.contentBlockDelta) { const value = object(event.contentBlockDelta) ?? {}; const index = number(value.contentBlockIndex) ?? -1; const delta = object(value.delta) ?? {}; const text = string(delta.text); const reasoning = object(delta.reasoningContent); const toolUse = object(delta.toolUse); let state = blocks.get(index);
      if (text !== undefined) { if (!state) { state = { type: "text", index: builder.textStart() }; blocks.set(index, state); } builder.textDelta(state.index!, text); }
      else if (reasoning) { if (!state) { state = { type: "thinking", index: builder.thinkingStart() }; blocks.set(index, state); } const thought = string(object(reasoning.reasoningText)?.text) ?? string(reasoning.text); if (thought) builder.thinkingDelta(state.index!, thought); const signature = string(object(reasoning.reasoningText)?.signature) ?? string(reasoning.signature); if (signature !== undefined) state.signature = signature; }
      else if (toolUse) { let tool = state?.tool; if (!tool) { tool = builder.toolStart(`tool_${shortHash(`${Date.now()}:${index}`)}`, "tool"); state = { type: "tool", tool }; blocks.set(index, state); } builder.toolDelta(tool, string(toolUse.input) ?? ""); }
    } else if (event.contentBlockStop) { const value = object(event.contentBlockStop) ?? {}; const state = blocks.get(number(value.contentBlockIndex) ?? -1); if (state?.type === "text" && state.index !== undefined) builder.textEnd(state.index); else if (state?.type === "thinking" && state.index !== undefined) builder.thinkingEnd(state.index, state.signature); else if (state?.tool) builder.toolEnd(state.tool); }
    else if (event.messageStop) { const reason = string(object(event.messageStop)?.stopReason); terminal = reason === "max_tokens" ? "length" : reason === "tool_use" ? "toolUse" : "stop"; }
    else if (event.metadata) applyUsage(builder, object(event.metadata)?.usage);
    else { const error = Object.entries(event).find(([name]) => name.endsWith("Exception")); if (error) throw new Error(`${error[0]}: ${string(object(error[1])?.message) ?? "Bedrock stream failure"}`); }
  }
  if (!started) builder.start(); if (!terminal) throw new Error("Bedrock stream ended before messageStop"); builder.done(terminal);
}
export const stream: StreamFunction<"bedrock-converse-stream", BedrockOptions> = (model, context, options) => streamTask(model, (builder) => execute(builder, model, context, options), options?.signal);
export const streamSimple: StreamFunction<"bedrock-converse-stream", SimpleStreamOptions> = (model, context, options) => { const reasoning = resolveSimpleReasoning(model, options?.reasoning); return stream(model, context, { ...buildBaseOptions(model, context, options), ...(reasoning === undefined ? {} : { reasoning }), ...(options?.thinkingBudgets === undefined ? {} : { thinkingBudgets: options.thinkingBudgets }) }); };
