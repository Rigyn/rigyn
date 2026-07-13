import type {
  AdapterEvent,
  ModelCacheTier,
  ModelInfo,
  ModelPricing,
  ModelTokenPrices,
  NormalizedUsage,
  ProviderAdapter,
  ProviderRequest,
} from "../core/types.js";
import type { JsonValue } from "../core/json.js";

interface Decimal {
  coefficient: bigint;
  scale: number;
}

export interface UsagePricingContext {
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function record(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function observedCacheWrites(usage: NormalizedUsage): UsagePricingContext {
  const raw = record(usage.raw);
  const creation = record(raw?.cache_creation);
  if (creation === undefined) return {};
  const cacheWrite5mTokens = tokenCount(creation.ephemeral_5m_input_tokens);
  const cacheWrite1hTokens = tokenCount(creation.ephemeral_1h_input_tokens);
  return {
    ...(cacheWrite5mTokens === undefined ? {} : { cacheWrite5mTokens }),
    ...(cacheWrite1hTokens === undefined ? {} : { cacheWrite1hTokens }),
  };
}

/** Carries Anthropic's cache-write lifetime breakdown across cumulative usage snapshots. */
export function mergeUsagePricingContext(
  previous: UsagePricingContext | undefined,
  usage: NormalizedUsage,
): UsagePricingContext {
  return { ...(previous ?? {}), ...observedCacheWrites(usage) };
}

function decimal(value: number): Decimal {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/u.exec(value.toString().toLowerCase());
  if (match === null) throw new TypeError("Model price must be a finite non-negative number");
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");
  let coefficient = BigInt(`${match[1]}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { coefficient, scale };
}

function formatDecimal(coefficient: bigint, scale: number): string {
  if (coefficient === 0n) return "0";
  const digits = coefficient.toString().padStart(scale + 1, "0");
  if (scale === 0) return digits;
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/u, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

function selectedPrices(pricing: ModelPricing, inputTokens: number): ModelTokenPrices {
  const tier = pricing.tiers?.find((candidate) =>
    inputTokens >= (candidate.minimumInputTokens ?? 0) &&
    inputTokens <= (candidate.maximumInputTokens ?? Number.MAX_SAFE_INTEGER));
  return tier === undefined ? pricing : { ...pricing, ...tier };
}

function cacheWriteCharges(
  tokens: number,
  prices: ModelTokenPrices,
  context: UsagePricingContext,
  defaultTier: ModelCacheTier | undefined,
): Array<{ tokens: number; price: number }> | undefined {
  const fiveMinutes = context.cacheWrite5mTokens;
  const oneHour = context.cacheWrite1hTokens;
  if (fiveMinutes !== undefined || oneHour !== undefined) {
    const detailed = (fiveMinutes ?? 0) + (oneHour ?? 0);
    if (!Number.isSafeInteger(detailed) || detailed > tokens) return undefined;
    const charges: Array<{ tokens: number; price: number }> = [];
    if ((fiveMinutes ?? 0) > 0) {
      const price = prices.cacheWrite5m ?? prices.cacheWrite;
      if (price === undefined) return undefined;
      charges.push({ tokens: fiveMinutes!, price });
    }
    if ((oneHour ?? 0) > 0) {
      const price = prices.cacheWrite1h ?? prices.cacheWrite;
      if (price === undefined) return undefined;
      charges.push({ tokens: oneHour!, price });
    }
    const remaining = tokens - detailed;
    if (remaining > 0) {
      const price = prices.cacheWrite;
      if (price === undefined) return undefined;
      charges.push({ tokens: remaining, price });
    }
    return charges;
  }
  const price = defaultTier === "1h"
    ? prices.cacheWrite1h ?? prices.cacheWrite
    : defaultTier === "5m"
      ? prices.cacheWrite5m ?? prices.cacheWrite
      : prices.cacheWrite;
  return price === undefined ? undefined : [{ tokens, price }];
}

/**
 * Calculates an exact decimal USD cost from mutually-exclusive normalized counters.
 * Returns undefined instead of under-reporting when any non-zero counter lacks a price.
 */
export function calculateUsageCost(
  usage: NormalizedUsage,
  pricing: ModelPricing | undefined,
  options: UsagePricingContext & { defaultCacheWriteTier?: ModelCacheTier; at?: number } = {},
): string | undefined {
  if (usage.cost !== undefined) return usage.cost;
  if (pricing === undefined) return undefined;
  if (pricing.validUntil !== undefined && (options.at ?? Date.now()) >= Date.parse(pricing.validUntil)) return undefined;
  const inputVolume = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  if (!Number.isSafeInteger(inputVolume)) return undefined;
  const prices = selectedPrices(pricing, inputVolume);
  const charges: Array<{ tokens: number; price: number }> = [];
  for (const [tokens, price] of [
    [usage.inputTokens, prices.input],
    [usage.outputTokens, prices.output],
    [usage.cacheReadTokens, prices.cacheRead],
  ] as const) {
    if (tokens === undefined || tokens === 0) continue;
    if (price === undefined) return undefined;
    charges.push({ tokens, price });
  }
  if ((usage.cacheWriteTokens ?? 0) > 0) {
    const cacheCharges = cacheWriteCharges(
      usage.cacheWriteTokens!,
      prices,
      options,
      options.defaultCacheWriteTier,
    );
    if (cacheCharges === undefined) return undefined;
    charges.push(...cacheCharges);
  }
  const hasCounters = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
  ].some((value) => value !== undefined);
  if (!hasCounters) return undefined;
  const parsed = charges.map((charge) => ({ ...charge, decimal: decimal(charge.price) }));
  const scale = Math.max(0, ...parsed.map((charge) => charge.decimal.scale));
  const coefficient = parsed.reduce((sum, charge) =>
    sum + BigInt(charge.tokens) * charge.decimal.coefficient * 10n ** BigInt(scale - charge.decimal.scale), 0n);
  return formatDecimal(coefficient, scale + 6);
}

export function applyUsagePricing(
  usage: NormalizedUsage,
  model: ModelInfo | undefined,
  context: UsagePricingContext = {},
): NormalizedUsage {
  if (usage.cost !== undefined) return usage;
  const tiers = model?.compatibility?.cacheTiers?.value ?? [];
  const defaultCacheWriteTier = tiers.length === 1 ? tiers[0] : undefined;
  const cost = calculateUsageCost(usage, model?.pricing, {
    ...context,
    ...(defaultCacheWriteTier === undefined ? {} : { defaultCacheWriteTier }),
  });
  return cost === undefined ? usage : { ...usage, cost };
}

/** Stable adapter facade used by the runtime; public registry identity remains unchanged. */
export function withUsagePricing(
  adapter: ProviderAdapter,
  model: (id: string) => ModelInfo | undefined,
): ProviderAdapter {
  return {
    id: adapter.id,
    async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
      let context: UsagePricingContext = {};
      for await (const event of adapter.stream(request, signal)) {
        if (event.type !== "usage") {
          yield event;
          continue;
        }
        context = mergeUsagePricingContext(context, event.usage);
        yield { ...event, usage: applyUsagePricing(event.usage, model(request.model), context) };
      }
    },
    async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
      return await adapter.listModels(signal);
    },
    ...(adapter.dispose === undefined ? {} : { dispose: async () => await adapter.dispose!() }),
  };
}
