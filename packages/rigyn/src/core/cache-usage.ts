import type { NormalizedUsage } from "./types.js";
import { normalizedContextTokens } from "./usage.js";

/** Cache-read share of an exactly reported prompt for one completed request. */
export function normalizedCacheHitRate(usage: NormalizedUsage): number | undefined {
  if (usage.cacheReadTokens === undefined) return undefined;
  const promptTokens = normalizedContextTokens(usage);
  return promptTokens === undefined || promptTokens <= 0
    ? undefined
    : usage.cacheReadTokens / promptTokens * 100;
}
