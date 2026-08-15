import { createHash } from "node:crypto";

const MAX_OPENAI_AFFINITY_CHARACTERS = 64;

export function openAIPromptCacheKey(sessionId: string): string {
  return Array.from(sessionId).length <= MAX_OPENAI_AFFINITY_CHARACTERS
    ? sessionId
    : createHash("sha256").update(sessionId).digest("hex");
}
