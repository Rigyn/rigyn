import type { Api, AssistantMessage, ImageContent, Message, Model, TextContent, ToolCall, ToolResultMessage } from "../types.js";

const USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

function withoutImages(content: Array<TextContent | ImageContent>, placeholder: string): TextContent[] {
  const output: TextContent[] = [];
  let placeholderWasLast = false;
  for (const block of content) {
    if (block.type === "image") {
      if (!placeholderWasLast) output.push({ type: "text", text: placeholder });
      placeholderWasLast = true;
    } else {
      output.push(block);
      placeholderWasLast = block.text === placeholder;
    }
  }
  return output;
}

export function transformMessages<TApi extends Api>(messages: Message[], model: Model<TApi>, normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string): Message[] {
  const idMap = new Map<string, string>();
  const normalized = messages.map((message) => {
    const value = (message as { content?: unknown }).content == null ? { ...message, content: [] } as Message : message;
    if (model.input.includes("image")) return value;
    if (value.role === "user" && Array.isArray(value.content)) return { ...value, content: withoutImages(value.content, USER_IMAGE_PLACEHOLDER) };
    if (value.role === "toolResult") return { ...value, content: withoutImages(value.content, TOOL_IMAGE_PLACEHOLDER) };
    return value;
  });
  const transformed = normalized.map((message): Message => {
    if (message.role === "toolResult") return idMap.has(message.toolCallId) ? { ...message, toolCallId: idMap.get(message.toolCallId)! } : message;
    if (message.role !== "assistant") return message;
    const same = message.provider === model.provider && message.api === model.api && message.model === model.id;
    const content: AssistantMessage["content"] = [];
    for (const block of message.content) {
      if (block.type === "thinking") {
        if (block.redacted) { if (same) content.push(block); continue; }
        if (same && block.thinkingSignature) { content.push(block); continue; }
        if (!block.thinking.trim()) continue;
        content.push(same ? block : { type: "text", text: block.thinking });
        continue;
      }
      if (block.type === "text") { content.push(same ? block : { type: "text", text: block.text }); continue; }
      let call: ToolCall = block;
      if (!same && block.thoughtSignature !== undefined) { call = { ...call }; delete call.thoughtSignature; }
      if (!same && normalizeToolCallId) {
        const id = normalizeToolCallId(block.id, model, message);
        if (id !== block.id) { idMap.set(block.id, id); call = { ...call, id }; }
      }
      content.push(call);
    }
    return { ...message, content };
  });
  const output: Message[] = [];
  let pending: ToolCall[] = [];
  let results = new Set<string>();
  const flush = () => {
    for (const call of pending) if (!results.has(call.id)) output.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "No result provided" }], isError: true, timestamp: Date.now() } satisfies ToolResultMessage);
    pending = []; results = new Set();
  };
  for (const message of transformed) {
    if (message.role === "assistant") {
      flush();
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      pending = message.content.filter((block): block is ToolCall => block.type === "toolCall");
      output.push(message);
    } else if (message.role === "toolResult") { results.add(message.toolCallId); output.push(message); }
    else { flush(); output.push(message); }
  }
  flush();
  return output;
}
