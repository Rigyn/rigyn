import type { Message } from "../types.js";

export function inferCopilotInitiator(messages: readonly Message[]): "user" | "agent" {
  const last = messages.at(-1);
  return last !== undefined && last.role !== "user" ? "agent" : "user";
}

export function hasCopilotVisionInput(messages: readonly Message[]): boolean {
  return messages.some((message) =>
    (message.role === "user" || message.role === "toolResult") &&
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === "image"),
  );
}

export function buildCopilotDynamicHeaders(input: {
  messages: readonly Message[];
  hasImages?: boolean;
}): Record<string, string> {
  return {
    "X-Initiator": inferCopilotInitiator(input.messages),
    "Openai-Intent": "conversation-edits",
    ...((input.hasImages ?? hasCopilotVisionInput(input.messages)) ? { "Copilot-Vision-Request": "true" } : {}),
  };
}
