import type { JsonValue } from "../core/json.js";
import type { NormalizedUsage } from "../core/types.js";
import { boundedUsageRaw, canonicalUsageCost } from "../core/usage.js";

export interface NormalizeUsageInput {
  raw: JsonValue;
  inputTokens?: unknown;
  outputTokens?: unknown;
  reportedTotalTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
  cacheWrite1hTokens?: unknown;
  reasoningTokens?: unknown;
  serverToolCalls?: unknown;
  cost?: unknown;
  inputIncludesCache?: boolean;
  reconcileInputFromTotal?: boolean;
  reconcileOutputFromTotal?: boolean;
  additionalInputTokens?: unknown;
}

function safeTokenSum(...values: number[]): number | undefined {
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : undefined;
}

/**
 * Normalized components are mutually exclusive. `reasoningTokens` remains a
 * detail of output, while reported cache reads/writes are removed from inclusive input.
 * The provider-native counters remain available under `raw` for diagnostics.
 */
export function normalizeUsage(input: NormalizeUsageInput): NormalizedUsage {
  const nativeInput = tokenCount(input.inputTokens);
  const cacheRead = tokenCount(input.cacheReadTokens);
  const cacheWrite = tokenCount(input.cacheWriteTokens);
  const reportedCacheWrite1h = tokenCount(input.cacheWrite1hTokens);
  const cacheWrite1h = cacheWrite !== undefined && reportedCacheWrite1h !== undefined && reportedCacheWrite1h <= cacheWrite
    ? reportedCacheWrite1h
    : undefined;
  const additionalInput = tokenCount(input.additionalInputTokens);
  const reportedTotal = tokenCount(input.reportedTotalTokens);
  let uncachedInput = nativeInput;
  if (uncachedInput !== undefined && input.inputIncludesCache === true) {
    const reportedCache = safeTokenSum(cacheRead ?? 0, cacheWrite ?? 0);
    uncachedInput = reportedCache === undefined || reportedCache > uncachedInput
      ? undefined
      : uncachedInput - reportedCache;
  }
  if (additionalInput !== undefined) {
    uncachedInput = uncachedInput === undefined ? undefined : safeTokenSum(uncachedInput, additionalInput);
  }

  let output = tokenCount(input.outputTokens);
  if (input.reconcileOutputFromTotal === true && reportedTotal !== undefined) {
    const nonOutput = uncachedInput === undefined
      ? undefined
      : safeTokenSum(uncachedInput, cacheRead ?? 0, cacheWrite ?? 0);
    if (nonOutput !== undefined) {
      const reconciled = reportedTotal - nonOutput;
      if (reconciled >= 0 && (output === undefined || reconciled >= output)) output = reconciled;
    }
  }
  if (input.reconcileInputFromTotal === true && reportedTotal !== undefined && output !== undefined) {
    const nonInput = safeTokenSum(output, cacheRead ?? 0, cacheWrite ?? 0);
    if (nonInput !== undefined) {
      const reconciled = reportedTotal - nonInput;
      if (reconciled >= 0 && (uncachedInput === undefined || reconciled >= uncachedInput)) uncachedInput = reconciled;
    }
  }

  const normalized: NormalizedUsage = { raw: boundedUsageRaw(input.raw) };
  if (uncachedInput !== undefined) normalized.inputTokens = uncachedInput;
  if (output !== undefined) normalized.outputTokens = output;
  if (cacheRead !== undefined) normalized.cacheReadTokens = cacheRead;
  if (cacheWrite !== undefined) normalized.cacheWriteTokens = cacheWrite;
  if (cacheWrite1h !== undefined) normalized.cacheWrite1hTokens = cacheWrite1h;
  const reasoning = tokenCount(input.reasoningTokens);
  if (reasoning !== undefined) normalized.reasoningTokens = reasoning;
  const serverToolCalls = tokenCount(input.serverToolCalls);
  if (serverToolCalls !== undefined) normalized.serverToolCalls = serverToolCalls;
  const cost = canonicalUsageCost(input.cost);
  if (cost !== undefined) normalized.cost = cost;
  const knownComponents = [uncachedInput, output, cacheRead, cacheWrite]
    .filter((candidate): candidate is number => candidate !== undefined);
  const knownTotal = safeTokenSum(...knownComponents);
  const completeComponents = uncachedInput !== undefined && output !== undefined &&
    cacheRead !== undefined && cacheWrite !== undefined;
  if (
    reportedTotal !== undefined && knownTotal !== undefined && reportedTotal >= knownTotal &&
    (!completeComponents || reportedTotal === knownTotal)
  ) {
    normalized.totalTokens = reportedTotal;
  } else if (
    uncachedInput !== undefined && output !== undefined &&
    (input.inputIncludesCache === true || (cacheRead !== undefined && cacheWrite !== undefined))
  ) {
    const total = safeTokenSum(uncachedInput, output, cacheRead ?? 0, cacheWrite ?? 0);
    if (total !== undefined) normalized.totalTokens = total;
  }
  if (
    uncachedInput !== undefined && output !== undefined && cacheRead !== undefined && cacheWrite !== undefined &&
    safeTokenSum(uncachedInput, output, cacheRead, cacheWrite) === undefined
  ) {
    delete normalized.inputTokens;
    delete normalized.outputTokens;
    delete normalized.cacheReadTokens;
    delete normalized.cacheWriteTokens;
    delete normalized.cacheWrite1hTokens;
    delete normalized.totalTokens;
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
  if (current.totalTokens === undefined) {
    if (
      merged.inputTokens !== undefined && merged.outputTokens !== undefined &&
      merged.cacheReadTokens !== undefined && merged.cacheWriteTokens !== undefined
    ) {
      const total = safeTokenSum(
        merged.inputTokens,
        merged.outputTokens,
        merged.cacheReadTokens,
        merged.cacheWriteTokens,
      );
      if (total === undefined) {
        delete merged.inputTokens;
        delete merged.outputTokens;
        delete merged.cacheReadTokens;
        delete merged.cacheWriteTokens;
        delete merged.cacheWrite1hTokens;
        delete merged.totalTokens;
      } else {
        merged.totalTokens = total;
      }
    } else delete merged.totalTokens;
  }
  if (current.cost === undefined) delete merged.cost;
  return merged;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
