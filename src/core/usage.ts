import { isJsonValue, type JsonValue } from "./json.js";
import type { NormalizedUsage } from "./types.js";

export const MAX_NORMALIZED_USAGE_RAW_BYTES = 64 * 1024;

const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "serverToolCalls",
  "durationMs",
] as const satisfies readonly (keyof NormalizedUsage)[];

const USAGE_FIELDS = new Set<string>([...TOKEN_FIELDS, "cost", "raw"]);

function token(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function decimalCost(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || Buffer.byteLength(value, "utf8") > 128) return false;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(value)) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0;
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
  if (usage.cost !== undefined && !decimalCost(usage.cost)) return false;
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
