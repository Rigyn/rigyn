import type { AssistantMessage, Context, ImageContent, Message, TextContent, Tool, Usage } from "../types.js";

export interface ContextUsageEstimate {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
  lastUsageIndex: number | null;
}

const charactersPerToken = 4;
const estimatedImageCharacters = 4_800;

export function calculateContextTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function jsonLength(value: unknown): number {
  try { return (JSON.stringify(value) ?? "undefined").length; } catch { return 16; }
}

export function estimateTextTokens(text: string): number { return Math.ceil(text.length / charactersPerToken); }

export function estimateTextAndImageContentTokens(content: string | Array<TextContent | ImageContent>): number {
  if (typeof content === "string") return estimateTextTokens(content);
  return Math.ceil(content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : estimatedImageCharacters), 0) / charactersPerToken);
}

export function estimateMessageTokens(message: Message): number {
  if (message.role === "user" || message.role === "toolResult") return estimateTextAndImageContentTokens(message.content);
  let characters = 0;
  for (const block of message.content) {
    if (block.type === "text") characters += block.text.length;
    else if (block.type === "thinking") characters += block.thinking.length;
    else characters += block.name.length + jsonLength(block.arguments);
  }
  return Math.ceil(characters / charactersPerToken);
}

function latestApplicableUsage(messages: readonly Message[]): { usage: Usage; index: number } | undefined {
  let prefixTimestamp = Number.NEGATIVE_INFINITY;
  let result: { usage: Usage; index: number } | undefined;
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") {
      const assistant = message as AssistantMessage;
      if (assistant.timestamp >= prefixTimestamp && assistant.stopReason !== "error" && assistant.stopReason !== "aborted" && calculateContextTokens(assistant.usage) > 0) result = { usage: assistant.usage, index };
    }
    prefixTimestamp = Math.max(prefixTimestamp, message.timestamp);
  }
  return result;
}

function toolTokens(tools: readonly Tool[] | undefined): number { return tools?.length ? Math.ceil(jsonLength(tools) / charactersPerToken) : 0; }

export function estimateContextTokens(value: Context | readonly Message[]): ContextUsageEstimate {
  const isMessages = Array.isArray(value);
  const context = isMessages ? undefined : value as Context;
  const messages: readonly Message[] = isMessages ? value as readonly Message[] : context!.messages;
  const usage = latestApplicableUsage(messages);
  if (usage !== undefined) {
    let trailingTokens = messages.slice(usage.index + 1).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    if (context !== undefined) {
      const added = new Set(messages.slice(usage.index + 1).flatMap((message) => message.role === "toolResult" ? message.addedToolNames ?? [] : []));
      trailingTokens += toolTokens(context.tools?.filter((tool) => added.has(tool.name)));
    }
    const usageTokens = calculateContextTokens(usage.usage);
    return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usage.index };
  }
  let trailingTokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  if (context !== undefined) trailingTokens += (context.systemPrompt ? estimateTextTokens(context.systemPrompt) : 0) + toolTokens(context.tools);
  return { tokens: trailingTokens, usageTokens: 0, trailingTokens, lastUsageIndex: null };
}
