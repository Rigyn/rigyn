import type { Context, Model, SimpleStreamOptions, StreamFunction } from "../types.js";
import { shortHash } from "../utils/hash.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { streamTask, type MessageStreamBuilder } from "./internal/message-stream.js";
import { convertMessages, convertTools, isThinkingPart, mapGoogleStopReason, retainThoughtSignature, type GoogleThinkingLevel } from "./google-shared.js";
import type { GoogleRuntimeOptions } from "./google-runtime.js";
import { buildBaseOptions, resolveSimpleReasoning } from "./simple-options.js";

export interface GoogleVertexOptions extends GoogleRuntimeOptions { project?: string; location?: string; }
type Record_ = Record<string, unknown>;
const object = (value: unknown): Record_ | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record_ : undefined;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

function realApiKey(value: string | undefined): string | undefined { const key = value?.trim(); return !key || key === "gcp-vertex-credentials" || /^<[^>]+>$/u.test(key) ? undefined : key; }
function customBaseUrl(baseUrl: string): string | undefined { const value = baseUrl.trim(); return !value || value.includes("{location}") ? undefined : value; }
function versioned(baseUrl: string): boolean { try { return new URL(baseUrl).pathname.split("/").some((part) => /^v\d+(?:beta\d*)?$/u.test(part)); } catch { return /(?:^|\/)v\d+(?:beta\d*)?(?:\/|$)/u.test(baseUrl); } }
function headerRecord(headers: Record<string, string | null> | undefined): Record<string, string> | undefined { const values = Object.fromEntries(Object.entries(headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== null)); return Object.keys(values).length ? values : undefined; }

export function buildGoogleVertexClientConfig(model: Model<"google-vertex">, options: GoogleVertexOptions | undefined, collectionScope: unknown): Record<string, unknown> {
  const apiKey = realApiKey(options?.apiKey);
  const baseUrl = customBaseUrl(model.baseUrl);
  const headers = headerRecord({ ...model.headers, ...options?.headers });
  const httpOptions = baseUrl || headers ? { ...(baseUrl ? { baseUrl, baseUrlResourceScope: collectionScope, ...(versioned(baseUrl) ? { apiVersion: "" } : {}) } : {}), ...(headers ? { headers } : {}) } : undefined;
  if (apiKey) return { vertexai: true, apiKey, apiVersion: "v1", ...(httpOptions ? { httpOptions } : {}) };
  const project = options?.project ?? options?.env?.GOOGLE_CLOUD_PROJECT ?? options?.env?.GCLOUD_PROJECT;
  if (!project) throw new Error("Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.");
  const location = options?.location ?? options?.env?.GOOGLE_CLOUD_LOCATION;
  if (!location) throw new Error("Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.");
  const keyFilename = options?.env?.GOOGLE_APPLICATION_CREDENTIALS;
  return { vertexai: true, project, location, apiVersion: "v1", ...(keyFilename ? { googleAuthOptions: { keyFilename } } : {}), ...(httpOptions ? { httpOptions } : {}) };
}
async function client(model: Model<"google-vertex">, options?: GoogleVertexOptions) {
  const sdk = await import("@google/genai");
  return new sdk.GoogleGenAI(buildGoogleVertexClientConfig(model, options, sdk.ResourceScope.COLLECTION) as never);
}

function params(model: Model<"google-vertex">, context: Context, options?: GoogleVertexOptions): Record_ {
  const config: Record_ = { maxOutputTokens: Math.max(1, Math.min(options?.maxTokens ?? model.maxTokens, model.maxTokens)) };
  if (options?.temperature !== undefined) config.temperature = options.temperature;
  if (context.systemPrompt) config.systemInstruction = sanitizeSurrogates(context.systemPrompt);
  const tools = convertTools(context.tools); if (tools) config.tools = tools;
  if (context.tools?.length && options?.toolChoice) config.toolConfig = { functionCallingConfig: { mode: options.toolChoice.toUpperCase() } };
  if (options?.thinking) config.thinkingConfig = options.thinking.enabled
    ? { includeThoughts: true, ...(options.thinking.budgetTokens === undefined ? {} : { thinkingBudget: options.thinking.budgetTokens }), ...(options.thinking.level === undefined ? {} : { thinkingLevel: options.thinking.level }) }
    : { thinkingBudget: 0 };
  if (options?.signal) config.abortSignal = options.signal;
  return { model: model.id, contents: convertMessages(model, context), config };
}

function usage(builder: MessageStreamBuilder<"google-vertex">, metadata: unknown): void {
  const value = object(metadata); if (!value) return; const prompt = number(value.promptTokenCount) ?? 0; const cacheRead = number(value.cachedContentTokenCount) ?? 0; const answer = number(value.candidatesTokenCount) ?? 0; const reasoning = number(value.thoughtsTokenCount) ?? 0;
  builder.usage({ input: Math.max(0, prompt - cacheRead), output: answer + reasoning, cacheRead, cacheWrite: 0, reasoning, totalTokens: number(value.totalTokenCount) ?? prompt + answer + reasoning });
}

async function execute(builder: MessageStreamBuilder<"google-vertex">, model: Model<"google-vertex">, context: Context, options?: GoogleVertexOptions): Promise<void> {
  const instance = await client(model, options); let payload: unknown = params(model, context, options); payload = await options?.onPayload?.(payload, model) ?? payload;
  const chunks = await instance.models.generateContentStream(payload as never); builder.start();
  let current: { type: "text" | "thinking"; index: number; signature?: string } | undefined; let finish: string | undefined; let tools = 0;
  const close = () => { if (!current) return; if (current.type === "text") { const block = builder.message.content[current.index]; if (block?.type === "text" && current.signature) block.textSignature = current.signature; builder.textEnd(current.index); } else builder.thinkingEnd(current.index, current.signature); current = undefined; };
  for await (const raw of chunks as AsyncIterable<unknown>) {
    const chunk = object(raw) ?? {}; usage(builder, chunk.usageMetadata); const responseId = string(chunk.responseId); const responseModel = string(chunk.modelVersion); builder.response({ ...(responseId ? { responseId } : {}), ...(responseModel ? { responseModel } : {}) });
    const candidate = object(array(chunk.candidates)[0]); if (!candidate) continue; finish = string(candidate.finishReason) ?? finish; const content = object(candidate.content);
    for (const value of array(content?.parts)) {
      const part = object(value) ?? {}; const text = string(part.text); const thinking = isThinkingPart(part); const signature = string(part.thoughtSignature);
      if (text !== undefined) {
        const type = thinking ? "thinking" : "text";
        if (current?.type !== type) { close(); current = { type, index: type === "thinking" ? builder.thinkingStart() : builder.textStart() }; }
        const retained = retainThoughtSignature(current.signature, signature); if (retained !== undefined) current.signature = retained;
        if (type === "thinking") builder.thinkingDelta(current.index, text); else builder.textDelta(current.index, text);
      }
      const call = object(part.functionCall); if (call) { close(); const provided = string(call.id); const id = provided && !builder.message.content.some((block) => block.type === "toolCall" && block.id === provided) ? provided : `call_${shortHash(`${Date.now()}:${tools}`)}`; const tool = builder.toolStart(id, string(call.name) ?? "tool"); builder.toolDelta(tool, JSON.stringify(object(call.args) ?? {})); builder.toolEnd(tool, signature); tools += 1; }
    }
  }
  close(); if (!finish) throw new Error("Google Vertex stream ended before a finish reason"); builder.done(mapGoogleStopReason(finish, tools > 0));
}

export const stream: StreamFunction<"google-vertex", GoogleVertexOptions> = (model, context, options) => streamTask(model, (builder) => execute(builder, model, context, options), options?.signal);
export const streamSimple: StreamFunction<"google-vertex", SimpleStreamOptions> = (model, context, options) => {
  const reasoning = resolveSimpleReasoning(model, options?.reasoning); const levels: Record<NonNullable<typeof reasoning>, GoogleThinkingLevel> = { minimal: "MINIMAL", low: "LOW", medium: "MEDIUM", high: "HIGH", xhigh: "HIGH", max: "HIGH" };
  return stream(model, context, { ...buildBaseOptions(model, context, options), thinking: { enabled: reasoning !== undefined, ...(reasoning === undefined ? {} : { level: levels[reasoning], budgetTokens: options?.thinkingBudgets?.[reasoning] ?? -1 }) } });
};
