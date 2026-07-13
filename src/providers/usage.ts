import type { JsonValue } from "../core/json.js";
import type { NormalizedUsage } from "../core/types.js";
import { boundedUsageRaw } from "../core/usage.js";

export interface NormalizeUsageInput {
  raw: JsonValue;
  inputTokens?: unknown;
  outputTokens?: unknown;
  reportedTotalTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
  reasoningTokens?: unknown;
  serverToolCalls?: unknown;
  cost?: string;
  inputIncludesCache?: boolean;
  reconcileOutputFromTotal?: boolean;
  additionalInputTokens?: unknown;
}

/**
 * Normalized components are mutually exclusive. `reasoningTokens` remains a
 * detail of output, while cache reads/writes are removed from inclusive input.
 * The provider-native counters remain available under `raw` for diagnostics.
 */
export function normalizeUsage(input: NormalizeUsageInput): NormalizedUsage {
  const nativeInput = tokenCount(input.inputTokens);
  const cacheRead = tokenCount(input.cacheReadTokens);
  const cacheWrite = tokenCount(input.cacheWriteTokens);
  const additionalInput = tokenCount(input.additionalInputTokens);
  const reportedTotal = tokenCount(input.reportedTotalTokens);
  let uncachedInput = nativeInput;
  if (uncachedInput !== undefined && input.inputIncludesCache === true) {
    uncachedInput = Math.max(0, uncachedInput - (cacheRead ?? 0) - (cacheWrite ?? 0));
  }
  if (additionalInput !== undefined) uncachedInput = (uncachedInput ?? 0) + additionalInput;

  let output = tokenCount(input.outputTokens);
  if (input.reconcileOutputFromTotal === true && reportedTotal !== undefined) {
    const nonOutput = (uncachedInput ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
    const reconciled = reportedTotal - nonOutput;
    if (reconciled >= 0 && (output === undefined || reconciled >= output)) output = reconciled;
  }

  const normalized: NormalizedUsage = { raw: boundedUsageRaw(input.raw) };
  if (uncachedInput !== undefined) normalized.inputTokens = uncachedInput;
  if (output !== undefined) normalized.outputTokens = output;
  if (cacheRead !== undefined) normalized.cacheReadTokens = cacheRead;
  if (cacheWrite !== undefined) normalized.cacheWriteTokens = cacheWrite;
  const reasoning = tokenCount(input.reasoningTokens);
  if (reasoning !== undefined) normalized.reasoningTokens = reasoning;
  const serverToolCalls = tokenCount(input.serverToolCalls);
  if (serverToolCalls !== undefined) normalized.serverToolCalls = serverToolCalls;
  if (input.cost !== undefined) normalized.cost = input.cost;
  if ([uncachedInput, output, cacheRead, cacheWrite].some((value) => value !== undefined)) {
    normalized.totalTokens = (uncachedInput ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  } else if (reportedTotal !== undefined) {
    normalized.totalTokens = reportedTotal;
  }
  return normalized;
}

export function mergeUsageSnapshots(
  previous: NormalizedUsage | undefined,
  current: NormalizedUsage,
): NormalizedUsage {
  if (previous === undefined) return current;
  const merged: NormalizedUsage = { ...previous, ...current };
  if (current.raw !== undefined) merged.raw = current.raw;
  else if (previous.raw !== undefined) merged.raw = previous.raw;
  if ([merged.inputTokens, merged.outputTokens, merged.cacheReadTokens, merged.cacheWriteTokens]
    .some((value) => value !== undefined)) {
    merged.totalTokens = (merged.inputTokens ?? 0) +
      (merged.outputTokens ?? 0) +
      (merged.cacheReadTokens ?? 0) +
      (merged.cacheWriteTokens ?? 0);
  }
  return merged;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
