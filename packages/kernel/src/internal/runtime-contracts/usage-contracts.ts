import type { JsonValue } from "../../runtime/core/json.js";

export interface NormalizedUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Portion of cacheWriteTokens created with a one-hour lifetime. */
  cacheWrite1hTokens?: number;
  reasoningTokens?: number;
  serverToolCalls?: number;
  cost?: UsageCost;
  durationMs?: number;
  raw?: JsonValue;
}

export interface UsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}
