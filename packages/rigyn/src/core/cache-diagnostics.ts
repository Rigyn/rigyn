import type { NormalizedUsage } from "./types.js";
import { sha256 } from "../tools/hash.js";

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

export interface CacheRequestBaseline {
  provider: string;
  model: string;
  promptTokens: number;
  timestamp: number;
  /** Provider reported at least one cache counter, including an explicit zero. */
  cacheObserved: boolean;
  /** Opaque, content-free identity for the structural cache prefix. */
  cacheBoundary?: string;
}

export type CacheBoundaryReason =
  | "provider"
  | "model"
  | "api"
  | "endpoint"
  | "credential"
  | "instructions"
  | "tools"
  | "retention"
  | "transport"
  | "continuation"
  | "session"
  | "branch"
  | "compaction"
  | "unknown";

/**
 * Content-free inputs for a structural prompt-cache boundary. Values must be
 * stable non-secret identifiers or hashes. In particular, callers must not
 * pass credentials or URLs that contain credentials.
 */
export interface CacheBoundaryParts {
  api?: string;
  endpointScope?: string;
  credentialScope?: string;
  instructionFingerprint?: string;
  toolFingerprint?: string;
  cacheRetention?: string;
  transport?: string;
  continuationGeneration?: string;
  session?: string;
  branch?: string;
  compaction?: string;
}

export interface CacheMiss {
  modelChanged: boolean;
  idleMs: number;
  missedCost: number;
  missedTokens: number;
  /** True only when a provider policy says idle expiry is possible. */
  possibleIdleExpiry?: boolean;
}

export interface CacheWasteTotals {
  missCount: number;
  missedCost: number;
  missedTokens: number;
}

export interface CacheRequestObservation {
  current: CacheRequestBaseline | undefined;
  miss: CacheMiss | undefined;
  /** Expected cold boundary that deliberately was not counted as cache waste. */
  boundaryChange?: CacheBoundaryReason;
}

export interface CacheRequestInput {
  provider: string;
  model: string;
  usage: NormalizedUsage;
  timestamp: number;
  /** Cache-read price in USD per million tokens for a full-miss cost estimate. */
  cacheReadPrice?: number;
  /** Opaque fingerprint produced from non-secret structural cache inputs. */
  cacheBoundary?: string;
  /** Most specific reason for a caller-supplied boundary change. */
  cacheBoundaryReason?: CacheBoundaryReason;
  /** Known provider idle-retention window. Omit when the window is not guaranteed. */
  cacheIdleExpiryMs?: number;
  /** Provider policy says idle expiry can occur, but does not promise an exact window. */
  cacheIdleExpiryPossible?: boolean;
}

export const CACHE_MISS_NOISE_FLOOR_TOKENS = 1_024;
export const CACHE_MISS_NOTICE_TOKENS = 20_000;
export const CACHE_MISS_NOTICE_COST = 0.1;

const CACHE_BOUNDARY_KEYS = [
  "api",
  "endpointScope",
  "credentialScope",
  "instructionFingerprint",
  "toolFingerprint",
  "cacheRetention",
  "transport",
  "continuationGeneration",
  "session",
  "branch",
  "compaction",
] as const satisfies readonly (keyof CacheBoundaryParts)[];

function token(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

function safeTokenSum(...values: number[]): number | undefined {
  if (!values.every((value) => token(value))) return undefined;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : undefined;
}

function finiteCost(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;
}

function safeCostSum(...values: number[]): number | undefined {
  if (!values.every((value) => Number.isFinite(value) && value >= 0)) return undefined;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isFinite(total) ? total : undefined;
}

/** Builds a bounded, opaque identity without retaining any supplied values. */
export function cacheBoundaryFingerprint(parts: Readonly<CacheBoundaryParts>): string {
  const ordered = CACHE_BOUNDARY_KEYS.flatMap((key) => {
    const value = parts[key];
    return value === undefined ? [] : [[key, value] as const];
  });
  return `cache-v1:${sha256(JSON.stringify(ordered))}`;
}

export function emptyCacheWasteTotals(): CacheWasteTotals {
  return { missedTokens: 0, missedCost: 0, missCount: 0 };
}

export function addCacheMiss(total: CacheWasteTotals, miss: CacheMiss | undefined): CacheWasteTotals {
  if (
    !token(total.missedTokens) || !token(total.missCount) ||
    !Number.isFinite(total.missedCost) || total.missedCost < 0
  ) return emptyCacheWasteTotals();
  if (miss === undefined) return total;
  const missedTokens = safeTokenSum(total.missedTokens, miss.missedTokens);
  const missedCost = safeCostSum(total.missedCost, miss.missedCost);
  const missCount = safeTokenSum(total.missCount, 1);
  // The public shape has no completeness marker, so retain the last coherent
  // aggregate atomically instead of saturating or publishing a partial update.
  if (missedTokens === undefined || missedCost === undefined || missCount === undefined) return total;
  return {
    missedTokens,
    missedCost,
    missCount,
  };
}

/**
 * Compares one durable assistant request with its immediate predecessor.
 * Missing cache telemetry deliberately breaks the comparison chain.
 */
export function observeCacheRequest(
  previous: CacheRequestBaseline | undefined,
  input: CacheRequestInput,
): CacheRequestObservation {
  const usage = input.usage;
  if (
    usage.inputTokens === undefined ||
    usage.cacheReadTokens === undefined ||
    usage.cacheWriteTokens === undefined
  ) {
    return { current: undefined, miss: undefined };
  }
  const inputTokens = usage.inputTokens;
  const cacheReadTokens = usage.cacheReadTokens;
  const cacheWriteTokens = usage.cacheWriteTokens;
  const promptTokens = safeTokenSum(inputTokens, cacheReadTokens, cacheWriteTokens);
  if (promptTokens === undefined || promptTokens <= 0) return { current: undefined, miss: undefined };

  const current: CacheRequestBaseline = {
    provider: input.provider,
    model: input.model,
    promptTokens,
    timestamp: Number.isFinite(input.timestamp) ? input.timestamp : 0,
    cacheObserved: true,
    ...(input.cacheBoundary === undefined || input.cacheBoundary === ""
      ? {}
      : { cacheBoundary: input.cacheBoundary }),
  };
  if (previous === undefined) return { current, miss: undefined };

  if (current.provider !== previous.provider) {
    return { current, miss: undefined, boundaryChange: "provider" };
  }
  if (current.model !== previous.model) {
    return { current, miss: undefined, boundaryChange: "model" };
  }
  if (current.cacheBoundary !== previous.cacheBoundary) {
    return {
      current,
      miss: undefined,
      boundaryChange: input.cacheBoundaryReason ?? "unknown",
    };
  }

  const idleMs = Math.max(0, current.timestamp - previous.timestamp);
  if (
    input.cacheIdleExpiryMs !== undefined
    && Number.isSafeInteger(input.cacheIdleExpiryMs)
    && input.cacheIdleExpiryMs > 0
    && idleMs >= input.cacheIdleExpiryMs
  ) {
    return { current, miss: undefined, boundaryChange: "retention" };
  }

  if (!token(previous.promptTokens)) return { current, miss: undefined };
  const missedTokens = Math.min(previous.promptTokens, promptTokens) - cacheReadTokens;
  if (missedTokens <= CACHE_MISS_NOISE_FLOOR_TOKENS) return { current, miss: undefined };

  const paidTokens = safeTokenSum(inputTokens, cacheWriteTokens);
  const paidCost = safeCostSum(finiteCost(usage.cost?.input), finiteCost(usage.cost?.cacheWrite));
  if (paidTokens === undefined || paidCost === undefined) return { current, miss: undefined };
  const paidPerToken = paidTokens > 0 ? paidCost / paidTokens : 0;
  const readPerToken = cacheReadTokens > 0
    ? finiteCost(usage.cost?.cacheRead) / cacheReadTokens
    : finiteCost(input.cacheReadPrice) / 1_000_000;
  const missedCost = missedTokens * Math.max(0, paidPerToken - readPerToken);
  // A required numeric estimate cannot express unavailable without inventing
  // zero, so omit the miss when its derived cost is not representable.
  if (!Number.isFinite(missedCost) || missedCost < 0) return { current, miss: undefined };
  return {
    current,
    miss: {
      missedTokens,
      missedCost,
      idleMs,
      modelChanged: false,
      ...(input.cacheIdleExpiryPossible === true && idleMs > 0 ? { possibleIdleExpiry: true } : {}),
    },
  };
}

/**
 * Summarizes mutually-exclusive normalized input/cache counters. It deliberately
 * avoids estimating money saved because provider prices and cache tiers vary.
 */
export function analyzeCacheEffectiveness(usages: readonly NormalizedUsage[]): CacheEffectiveness {
  const totals = { input: 0, read: 0, write: 0, observed: 0 };
  let samples = 0;
  let complete = true;
  for (const usage of usages) {
    if (
      usage.inputTokens === undefined ||
      usage.cacheReadTokens === undefined ||
      usage.cacheWriteTokens === undefined
    ) {
      complete = false;
      continue;
    }
    const input = safeTokenSum(totals.input, usage.inputTokens);
    const read = safeTokenSum(totals.read, usage.cacheReadTokens);
    const write = safeTokenSum(totals.write, usage.cacheWriteTokens);
    const observed = input === undefined || read === undefined || write === undefined
      ? undefined
      : safeTokenSum(input, read, write);
    if (input === undefined || read === undefined || write === undefined || observed === undefined) {
      complete = false;
      continue;
    }
    totals.input = input;
    totals.read = read;
    totals.write = write;
    totals.observed = observed;
    samples += 1;
  }
  const observedInputTokens = totals.observed;
  const base = {
    samples,
    observedInputTokens,
    uncachedInputTokens: totals.input,
    cacheReadTokens: totals.read,
    cacheWriteTokens: totals.write,
  };
  // Without completeness fields, safe partial totals remain diagnostic only
  // and cannot be promoted to an effectiveness classification.
  if (!complete || samples === 0 || observedInputTokens === 0) {
    return { status: "unavailable", ...base };
  }

  const reuseRatio = totals.read / observedInputTokens;
  if (samples === 1 && totals.read === 0 && totals.write > 0) {
    return {
      status: "cold",
      ...base,
      reuseRatio,
      guidance: "A first cache write is normal; reuse can only appear on a later request with the same stable prefix.",
    };
  }
  if (samples >= 2 && totals.write > totals.read && reuseRatio < 0.2) {
    return {
      status: "write_churn",
      ...base,
      reuseRatio,
      guidance: "Cache writes exceed reads; keep instructions, tools, and the early conversation stable and preserve provider/session affinity.",
    };
  }
  if (samples >= 2 && reuseRatio < 0.25) {
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
