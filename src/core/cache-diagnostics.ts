import type { NormalizedUsage } from "./types.js";

export type CacheEffectivenessStatus =
  | "unavailable"
  | "cold"
  | "effective"
  | "mixed"
  | "low_reuse"
  | "write_churn";

export interface CacheEffectiveness {
  status: CacheEffectivenessStatus;
  samples: number;
  observedInputTokens: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reuseRatio?: number;
  guidance?: string;
}

function tokens(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Summarizes mutually-exclusive normalized input/cache counters. It deliberately
 * avoids estimating money saved because provider prices and cache tiers vary.
 */
export function analyzeCacheEffectiveness(usages: readonly NormalizedUsage[]): CacheEffectiveness {
  const telemetry = usages.filter((usage) => usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined);
  const totals = telemetry.reduce((result, usage) => ({
    input: result.input + tokens(usage.inputTokens),
    read: result.read + tokens(usage.cacheReadTokens),
    write: result.write + tokens(usage.cacheWriteTokens),
  }), { input: 0, read: 0, write: 0 });
  const observedInputTokens = totals.input + totals.read + totals.write;
  const base = {
    samples: telemetry.length,
    observedInputTokens,
    uncachedInputTokens: totals.input,
    cacheReadTokens: totals.read,
    cacheWriteTokens: totals.write,
  };
  if (telemetry.length === 0 || observedInputTokens === 0) return { status: "unavailable", ...base };

  const reuseRatio = totals.read / observedInputTokens;
  if (telemetry.length === 1 && totals.read === 0 && totals.write > 0) {
    return {
      status: "cold",
      ...base,
      reuseRatio,
      guidance: "A first cache write is normal; reuse can only appear on a later request with the same stable prefix.",
    };
  }
  if (telemetry.length >= 2 && totals.write > totals.read && reuseRatio < 0.2) {
    return {
      status: "write_churn",
      ...base,
      reuseRatio,
      guidance: "Cache writes exceed reads; keep instructions, tools, and the early conversation stable and preserve provider/session affinity.",
    };
  }
  if (telemetry.length >= 2 && reuseRatio < 0.25) {
    return {
      status: "low_reuse",
      ...base,
      reuseRatio,
      guidance: "Cache reuse is low; avoid changing the stable prompt prefix between turns.",
    };
  }
  if (reuseRatio >= 0.5) return { status: "effective", ...base, reuseRatio };
  return { status: "mixed", ...base, reuseRatio };
}
