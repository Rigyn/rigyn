import { isJsonValue, type JsonValue } from "./json.js";
import type { NormalizedUsage, UsageCost } from "./types.js";

export const MAX_NORMALIZED_USAGE_RAW_BYTES = 64 * 1024;

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
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const cost = value as Record<string, unknown>;
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
  const values = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens];
  if (values.every((value) => value === undefined)) return undefined;
  const result = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return Number.isSafeInteger(result) ? result : null;
}

/** Returns true only for canonical, bounded, mutually-exclusive usage counters. */
export function isNormalizedUsage(value: unknown): value is NormalizedUsage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
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
    if (!isJsonValue(usage.raw)) return false;
    let serialized: string;
    try {
      serialized = JSON.stringify(usage.raw);
    } catch {
      return false;
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_NORMALIZED_USAGE_RAW_BYTES) return false;
  }
  const components = componentTotal(usage as NormalizedUsage);
  if (components === null) return false;
  return components === undefined || usage.totalTokens === undefined || usage.totalTokens === components;
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

export function sumUsageCosts(left: UsageCost, right: UsageCost): UsageCost {
  const input = left.input + right.input;
  const output = left.output + right.output;
  const cacheRead = left.cacheRead + right.cacheRead;
  const cacheWrite = left.cacheWrite + right.cacheWrite;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

/** Adds independent usage observations without reporting a partial known cost. */
export function addNormalizedUsage(
  left: NormalizedUsage | undefined,
  right: NormalizedUsage,
): NormalizedUsage {
  const result: NormalizedUsage = {};
  for (const field of ADDITIVE_USAGE_FIELDS) {
    if (left?.[field] !== undefined || right[field] !== undefined) {
      result[field] = (left?.[field] ?? 0) + (right[field] ?? 0);
    }
  }
  const components = componentTotal(result);
  if (components !== undefined && components !== null) result.totalTokens = components;

  if (!hasUsageValues(left)) {
    const cost = canonicalUsageCost(right.cost);
    if (cost !== undefined) result.cost = cost;
  } else if (left.cost !== undefined && right.cost !== undefined) {
    result.cost = sumUsageCosts(left.cost, right.cost);
  }
  return result;
}

/** Formats the structured total only at a human-facing boundary. */
export function formatUsageCost(cost: UsageCost | undefined, fractionDigits = 6): string | undefined {
  if (cost === undefined) return undefined;
  const digits = Math.max(0, Math.min(12, Math.trunc(fractionDigits)));
  return `$${cost.total.toFixed(digits).replace(/0+$/u, "").replace(/\.$/u, "")}`;
}

/** Input tokens currently occupying provider context, including cache reads/writes. */
export function normalizedContextTokens(usage: NormalizedUsage): number | undefined {
  const values = [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens];
  if (values.every((value) => value === undefined) || values.some((value) => value !== undefined && !token(value))) {
    return undefined;
  }
  const result = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return Number.isSafeInteger(result) ? result : undefined;
}

/** Total billable/token-accounting units without double-counting reasoning output detail. */
export function normalizedTotalTokens(usage: NormalizedUsage): number | undefined {
  const components = componentTotal(usage);
  if (components === null) return undefined;
  if (usage.totalTokens !== undefined) {
    if (!token(usage.totalTokens) || (components !== undefined && usage.totalTokens !== components)) return undefined;
    return usage.totalTokens;
  }
  return components;
}

/** Detaches provider telemetry and replaces oversized raw payloads with size metadata. */
export function boundedUsageRaw(value: JsonValue): JsonValue {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { invalid: true, truncated: true };
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_NORMALIZED_USAGE_RAW_BYTES) return { originalBytes: bytes, truncated: true };
  try {
    return JSON.parse(serialized) as JsonValue;
  } catch {
    return { invalid: true, truncated: true };
  }
}
