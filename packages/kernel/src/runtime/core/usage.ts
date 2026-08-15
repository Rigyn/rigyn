import { boundedJsonSnapshot } from "./bounded-json.js";
import type { JsonValue } from "./json.js";
import type { NormalizedUsage, UsageCost } from "./types.js";

export const MAX_NORMALIZED_USAGE_RAW_BYTES = 64 * 1024;

const MAX_NORMALIZED_USAGE_BYTES = MAX_NORMALIZED_USAGE_RAW_BYTES + (16 * 1024);
const MAX_NORMALIZED_USAGE_VALUES = 8_224;
const MAX_NORMALIZED_USAGE_CONTAINERS = 4_100;
const MAX_NORMALIZED_USAGE_DEPTH = 61;
const MAX_NORMALIZED_USAGE_RAW_VALUES = 8_192;
const MAX_NORMALIZED_USAGE_RAW_CONTAINERS = 4_096;
const MAX_NORMALIZED_USAGE_RAW_DEPTH = 59;
const MAX_NORMALIZED_USAGE_RAW_MEASUREMENT_BYTES = 8 * 1024 * 1024;

const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "cacheWrite1hTokens",
  "reasoningTokens",
  "serverToolCalls",
  "durationMs",
] as const satisfies readonly (keyof NormalizedUsage)[];

const USAGE_FIELDS = new Set<string>([...TOKEN_FIELDS, "cost", "raw"]);

function token(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isUsageCost(value: unknown): value is UsageCost {
  let cost: Record<string, JsonValue>;
  try {
    const snapshot = boundedJsonSnapshot(value, {
      label: "Normalized usage cost",
      maximumBytes: 1_024,
      maximumValues: 6,
      maximumContainers: 1,
      maximumDepth: 1,
    }).value;
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
    cost = snapshot;
  } catch {
    return false;
  }
  const fields = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
  if (Object.keys(cost).length !== fields.length || fields.some((field) => !Object.hasOwn(cost, field))) return false;
  if (fields.some((field) => typeof cost[field] !== "number" || !Number.isFinite(cost[field]) || cost[field] < 0)) {
    return false;
  }
  const components = Number(cost.input) + Number(cost.output) + Number(cost.cacheRead) + Number(cost.cacheWrite);
  const total = Number(cost.total);
  return Math.abs(total - components) <= Math.max(1e-12, Math.abs(total) * 1e-9);
}

export function canonicalUsageCost(value: unknown): UsageCost | undefined {
  if (!isUsageCost(value)) return undefined;
  const input = value.input;
  const output = value.output;
  const cacheRead = value.cacheRead;
  const cacheWrite = value.cacheWrite;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function componentTotal(usage: NormalizedUsage): number | null | undefined {
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = usage;
  if (
    inputTokens === undefined
    || outputTokens === undefined
    || cacheReadTokens === undefined
    || cacheWriteTokens === undefined
  ) return undefined;
  if (![inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].every(token)) return null;
  const result = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  return Number.isSafeInteger(result) ? result : null;
}

function knownComponentTotal(usage: NormalizedUsage): number | null | undefined {
  const values = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
  ];
  let observed = false;
  let result = 0;
  for (const value of values) {
    if (value === undefined) continue;
    if (!token(value)) return null;
    observed = true;
    result += value;
    if (!Number.isSafeInteger(result)) return null;
  }
  return observed ? result : undefined;
}

function discardComponentCounters(usage: NormalizedUsage): void {
  delete usage.inputTokens;
  delete usage.outputTokens;
  delete usage.cacheReadTokens;
  delete usage.cacheWriteTokens;
  delete usage.cacheWrite1hTokens;
  delete usage.totalTokens;
}

function reconcileAggregatedComponents(usage: NormalizedUsage): void {
  const known = knownComponentTotal(usage);
  if (known === null) {
    discardComponentCounters(usage);
    return;
  }
  const complete = componentTotal(usage);
  if (complete !== undefined) {
    if (complete === null) discardComponentCounters(usage);
    else usage.totalTokens = complete;
    return;
  }
  if (usage.totalTokens !== undefined && known !== undefined && usage.totalTokens < known) {
    delete usage.totalTokens;
  }
}

/** Returns true only for canonical, bounded, mutually-exclusive usage counters. */
export function isNormalizedUsage(value: unknown): value is NormalizedUsage {
  try {
    const snapshot = boundedJsonSnapshot(value, {
      label: "Normalized usage",
      maximumBytes: MAX_NORMALIZED_USAGE_BYTES,
      maximumValues: MAX_NORMALIZED_USAGE_VALUES,
      maximumContainers: MAX_NORMALIZED_USAGE_CONTAINERS,
      maximumDepth: MAX_NORMALIZED_USAGE_DEPTH,
    }).value;
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
    const usage = snapshot as Record<string, JsonValue>;
    if (Object.keys(usage).some((key) => !USAGE_FIELDS.has(key))) return false;
    for (const field of TOKEN_FIELDS) {
      if (usage[field] !== undefined && !token(usage[field])) return false;
    }
    if (usage.cost !== undefined && !isUsageCost(usage.cost)) return false;
    if (
      usage.cacheWrite1hTokens !== undefined &&
      (usage.cacheWriteTokens === undefined || Number(usage.cacheWrite1hTokens) > Number(usage.cacheWriteTokens))
    ) return false;
    if (usage.raw !== undefined) {
      try {
        boundedJsonSnapshot(usage.raw, {
          label: "Normalized usage raw telemetry",
          maximumBytes: MAX_NORMALIZED_USAGE_RAW_BYTES,
          maximumValues: MAX_NORMALIZED_USAGE_RAW_VALUES,
          maximumContainers: MAX_NORMALIZED_USAGE_RAW_CONTAINERS,
          maximumDepth: MAX_NORMALIZED_USAGE_RAW_DEPTH,
        });
      } catch {
        return false;
      }
    }
    const components = componentTotal(usage as NormalizedUsage);
    if (components === null) return false;
    const known = knownComponentTotal(usage as NormalizedUsage);
    if (known === null) return false;
    if (usage.totalTokens !== undefined && known !== undefined && Number(usage.totalTokens) < known) return false;
    return components === undefined || usage.totalTokens === undefined || usage.totalTokens === components;
  } catch {
    return false;
  }
}

const ADDITIVE_USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "cacheWrite1hTokens",
  "reasoningTokens",
  "serverToolCalls",
  "durationMs",
] as const satisfies readonly (keyof NormalizedUsage)[];

function hasUsageValues(value: NormalizedUsage | undefined): value is NormalizedUsage {
  return value !== undefined && (
    value.cost !== undefined || ADDITIVE_USAGE_FIELDS.some((field) => value[field] !== undefined)
  );
}

export function sumUsageCosts(left: UsageCost, right: UsageCost): UsageCost | undefined {
  const input = left.input + right.input;
  const output = left.output + right.output;
  const cacheRead = left.cacheRead + right.cacheRead;
  const cacheWrite = left.cacheWrite + right.cacheWrite;
  return canonicalUsageCost({ input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite });
}

/** Adds correlated incremental usage deltas without reporting a partial known cost. */
export function addNormalizedUsage(
  left: NormalizedUsage | undefined,
  right: NormalizedUsage,
): NormalizedUsage {
  const result: NormalizedUsage = {};
  for (const field of ADDITIVE_USAGE_FIELDS) {
    if (left?.[field] !== undefined || right[field] !== undefined) {
      const sum = (left?.[field] ?? 0) + (right[field] ?? 0);
      if (Number.isSafeInteger(sum)) result[field] = sum;
    }
  }
  reconcileAggregatedComponents(result);

  if (!hasUsageValues(left)) {
    const cost = canonicalUsageCost(right.cost);
    if (cost !== undefined) result.cost = cost;
  } else if (left.cost !== undefined && right.cost !== undefined) {
    const cost = sumUsageCosts(left.cost, right.cost);
    if (cost !== undefined) result.cost = cost;
  }
  return result;
}

/** Adds independent observations while retaining only counters reported by every observation. */
export function addCompleteNormalizedUsage(
  left: NormalizedUsage | undefined,
  right: NormalizedUsage,
): NormalizedUsage {
  const result: NormalizedUsage = {};
  for (const field of ADDITIVE_USAGE_FIELDS) {
    const rightValue = right[field];
    if (left === undefined) {
      if (rightValue !== undefined) result[field] = rightValue;
      continue;
    }
    const leftValue = left[field];
    if (leftValue === undefined || rightValue === undefined) continue;
    const sum = leftValue + rightValue;
    if (Number.isSafeInteger(sum)) result[field] = sum;
  }
  reconcileAggregatedComponents(result);

  if (left === undefined) {
    const cost = canonicalUsageCost(right.cost);
    if (cost !== undefined) result.cost = cost;
  } else if (left.cost !== undefined && right.cost !== undefined) {
    const cost = sumUsageCosts(left.cost, right.cost);
    if (cost !== undefined) result.cost = cost;
  }
  return result;
}

/** Formats the structured total only at a human-facing boundary. */
export function formatUsageCost(cost: UsageCost | undefined, fractionDigits = 6): string | undefined {
  if (cost === undefined) return undefined;
  const digits = Math.max(0, Math.min(12, Math.trunc(fractionDigits)));
  return `$${cost.total.toFixed(digits).replace(/0+$/u, "").replace(/\.$/u, "")}`;
}

/** Exact input tokens occupying provider context, including cache reads/writes. */
export function normalizedContextTokens(usage: NormalizedUsage): number | undefined {
  if (
    token(usage.totalTokens)
    && token(usage.outputTokens)
    && usage.totalTokens >= usage.outputTokens
  ) {
    return usage.totalTokens - usage.outputTokens;
  }
  const { inputTokens, cacheReadTokens, cacheWriteTokens } = usage;
  if (!token(inputTokens) || !token(cacheReadTokens) || !token(cacheWriteTokens)) return undefined;
  const result = inputTokens + cacheReadTokens + cacheWriteTokens;
  return Number.isSafeInteger(result) ? result : undefined;
}

/** Total billable/token-accounting units without double-counting reasoning output detail. */
export function normalizedTotalTokens(usage: NormalizedUsage): number | undefined {
  const components = componentTotal(usage);
  if (components === null) return undefined;
  const known = knownComponentTotal(usage);
  if (known === null) return undefined;
  if (usage.totalTokens !== undefined) {
    if (
      !token(usage.totalTokens)
      || (known !== undefined && usage.totalTokens < known)
      || (components !== undefined && usage.totalTokens !== components)
    ) return undefined;
    return usage.totalTokens;
  }
  return components;
}

/** Detaches provider telemetry and replaces oversized raw payloads with size metadata. */
export function boundedUsageRaw(value: JsonValue): JsonValue {
  try {
    const snapshot = boundedJsonSnapshot(value, {
      label: "Normalized usage raw telemetry",
      maximumBytes: MAX_NORMALIZED_USAGE_RAW_BYTES,
      maximumValues: MAX_NORMALIZED_USAGE_RAW_VALUES,
      maximumContainers: MAX_NORMALIZED_USAGE_RAW_CONTAINERS,
      maximumDepth: MAX_NORMALIZED_USAGE_RAW_DEPTH,
    });
    return JSON.parse(snapshot.serialized) as JsonValue;
  } catch {
    try {
      const measured = boundedJsonSnapshot(value, {
        label: "Normalized usage raw telemetry",
        maximumBytes: MAX_NORMALIZED_USAGE_RAW_MEASUREMENT_BYTES,
        maximumValues: MAX_NORMALIZED_USAGE_RAW_VALUES,
        maximumContainers: MAX_NORMALIZED_USAGE_RAW_CONTAINERS,
        maximumDepth: MAX_NORMALIZED_USAGE_RAW_DEPTH,
      });
      return { originalBytes: measured.bytes, truncated: true };
    } catch {
      return { invalid: true, truncated: true };
    }
  }
}
