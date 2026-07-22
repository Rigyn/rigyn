import type { Context, Model, Tool } from "../types.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { transformMessages } from "./transform-messages.js";

export type GoogleThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
type Record_ = Record<string, unknown>;
const validSignature = (value: string | undefined): value is string => value !== undefined && value.length % 4 === 0 && /^[a-z0-9+/]+={0,2}$/iu.test(value);
export function isThinkingPart(part: { thought?: boolean; thoughtSignature?: string }): boolean { return part.thought === true; }
export function retainThoughtSignature(current: string | undefined, incoming: string | undefined): string | undefined { return incoming ? incoming : current; }
export function requiresToolCallId(modelId: string): boolean { return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-"); }
const major = (modelId: string): number | undefined => { const match = /^gemini(?:-live)?-(\d+)/iu.exec(modelId); return match?.[1] ? Number(match[1]) : undefined; };

export function convertMessages<T extends "google-generative-ai" | "google-vertex">(model: Model<T>, context: Context): Record_[] {
  const contents: Record_[] = [];
  for (const message of transformMessages(context.messages, model, (value) => value.replace(/[^a-z0-9_-]/giu, "_").slice(0, 64))) {
    if (message.role === "user") {
      const parts = typeof message.content === "string" ? [{ text: sanitizeSurrogates(message.content) }] : message.content.map((block) => block.type === "text" ? { text: sanitizeSurrogates(block.text) } : { inlineData: { mimeType: block.mimeType, data: block.data } });
      if (parts.length) contents.push({ role: "user", parts });
    } else if (message.role === "assistant") {
      const same = message.provider === model.provider && message.model === model.id; const parts: Record_[] = [];
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim()) parts.push({ text: sanitizeSurrogates(block.text), ...(same && validSignature(block.textSignature) ? { thoughtSignature: block.textSignature } : {}) });
        else if (block.type === "thinking" && block.thinking.trim()) parts.push(same ? { thought: true, text: sanitizeSurrogates(block.thinking), ...(validSignature(block.thinkingSignature) ? { thoughtSignature: block.thinkingSignature } : {}) } : { text: sanitizeSurrogates(block.thinking) });
        else if (block.type === "toolCall") parts.push({ functionCall: { name: block.name, args: block.arguments, ...(requiresToolCallId(model.id) ? { id: block.id.replace(/[^a-z0-9_-]/giu, "_").slice(0, 64) } : {}) }, ...(same && validSignature(block.thoughtSignature) ? { thoughtSignature: block.thoughtSignature } : {}) });
      }
      if (parts.length) contents.push({ role: "model", parts });
    } else {
      const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"); const images = model.input.includes("image") ? message.content.filter((block) => block.type === "image") : []; const imageParts = images.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } })); const supportsNested = (major(model.id) ?? 3) >= 3;
      const functionResponse = { functionResponse: { name: message.toolName, response: message.isError ? { error: text || (images.length ? "See attached image" : "") } : { output: text || (images.length ? "See attached image" : "") }, ...(supportsNested && imageParts.length ? { parts: imageParts } : {}), ...(requiresToolCallId(model.id) ? { id: message.toolCallId.replace(/[^a-z0-9_-]/giu, "_").slice(0, 64) } : {}) } };
      const last = contents.at(-1); const lastParts = Array.isArray(last?.parts) ? last.parts as unknown[] : undefined;
      if (last?.role === "user" && lastParts?.some((part) => typeof part === "object" && part !== null && "functionResponse" in part)) lastParts.push(functionResponse); else contents.push({ role: "user", parts: [functionResponse] });
      if (imageParts.length && !supportsNested) contents.push({ role: "user", parts: [{ text: "Tool result image:" }, ...imageParts] });
    }
  }
  return contents;
}

function stripSchemaMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSchemaMetadata);
  if (value === null || typeof value !== "object") return value;
  const result: Record_ = {};
  for (const [key, nested] of Object.entries(value)) if (!["$schema", "$id", "$defs", "definitions", "$anchor", "$dynamicAnchor", "$vocabulary", "$comment"].includes(key)) result[key] = stripSchemaMetadata(nested);
  return result;
}
export function convertTools(tools: readonly Tool[] | undefined): Record_[] | undefined { return tools?.length ? [{ functionDeclarations: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: stripSchemaMetadata(tool.parameters) })) }] : undefined; }
export function mapGoogleStopReason(reason: string | undefined, hasTools: boolean): "stop" | "length" | "toolUse" { if (hasTools) return "toolUse"; return reason === "MAX_TOKENS" ? "length" : "stop"; }
