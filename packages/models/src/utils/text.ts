import type { CustomContextMessage, ImageContent, Message, TextContent, ThinkingContent, ToolCall } from "../types.js";

type Content = TextContent | ImageContent | ThinkingContent | ToolCall;
export function contentText(content: string | readonly Content[], separator = "\n"): string {
  if (typeof content === "string") return content;
  return content.flatMap((entry) => entry.type === "text" ? [entry.text] : []).join(separator);
}

/** Converts extension-authored context to a normal user message only at provider dispatch. */
export function projectCustomContextMessage(message: CustomContextMessage): Extract<Message, { role: "user" }> {
  return {
    role: "user",
    content: typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content,
    timestamp: message.timestamp,
  };
}
