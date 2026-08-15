import { normalizeModelReasoningEffort } from "../providers/registry.js";

interface InteractiveThinkingSession {
  readonly thinkingLevel: string;
  setThinkingLevel(level: string): void;
}

/** Apply the same normalization policy in every interactive host. */
export function applyInteractiveThinking(
  session: InteractiveThinkingSession,
  argument: string,
): string {
  if (argument.trim() !== "") session.setThinkingLevel(normalizeModelReasoningEffort(argument));
  return session.thinkingLevel;
}
