import type {
  AdapterEvent,
  ModelCacheTier,
  ModelInfo,
  ModelPricing,
  ModelTokenPrices,
  NormalizedUsage,
  ProviderAdapter,
  ProviderRequest,
  UsageCost,
} from "../core/types.js";
import type { JsonValue } from "../core/json.js";
import { addNormalizedUsage, canonicalUsageCost } from "../core/usage.js";
import { validatedProviderAdapterEvents } from "./adapter-boundary.js";

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
  const cacheWrite5mTokens = tokenCount(creation?.ephemeral_5m_input_tokens);
  const cacheWrite1hTokens = usage.cacheWrite1hTokens ?? tokenCount(creation?.ephemeral_1h_input_tokens);
  return {
    ...(cacheWrite5mTokens === undefined ? {} : { cacheWrite5mTokens }),
    ...(cacheWrite1hTokens === undefined ? {} : { cacheWrite1hTokens }),
  };
}

function addUsagePricingContext(
  previous: UsagePricingContext,
  usage: NormalizedUsage,
): UsagePricingContext {
  const observed = observedCacheWrites(usage);
  const result: UsagePricingContext = { ...previous };
  for (const field of ["cacheWrite5mTokens", "cacheWrite1hTokens"] as const) {
    if (observed[field] === undefined) continue;
    const sum = (previous[field] ?? 0) + observed[field];
    if (Number.isSafeInteger(sum)) result[field] = sum;
    else delete result[field];
  }
  return result;
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

function chargeCost(charges: readonly { tokens: number; price: number }[]): number {
  const parsed = charges.map((charge) => ({ ...charge, decimal: decimal(charge.price) }));
  const scale = Math.max(0, ...parsed.map((charge) => charge.decimal.scale));
  const coefficient = parsed.reduce((sum, charge) =>
    sum + BigInt(charge.tokens) * charge.decimal.coefficient * 10n ** BigInt(scale - charge.decimal.scale), 0n);
  return Number(formatDecimal(coefficient, scale + 6));
}

function pricedComponent(tokens: number | undefined, price: number | undefined): number | undefined {
  if (tokens === undefined || tokens === 0) return 0;
  return price === undefined ? undefined : chargeCost([{ tokens, price }]);
}

const OPENAI_FLEX_MODELS = new Set([
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.4-pro",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "o3",
  "o4-mini",
]);

const OPENAI_FAST_MULTIPLIERS = new Map<string, number>([
  ["gpt-5.6", 2],
  ["gpt-5.6-sol", 2],
  ["gpt-5.6-terra", 2],
  ["gpt-5.6-luna", 2],
  ["gpt-5.5", 2.5],
  ["gpt-5.4", 2],
  ["gpt-5.4-mini", 2],
  ["gpt-5.3-codex", 2],
  ["gpt-5.2", 2],
  ["gpt-5.2-codex", 2],
  ["gpt-5.1", 2],
  ["gpt-5.1-codex-max", 2],
  ["gpt-5.1-codex", 2],
  ["gpt-5", 2],
  ["gpt-5-codex", 2],
  ["gpt-5-mini", 1.8],
  ["gpt-4.1", 1.75],
  ["gpt-4.1-mini", 1.75],
  ["gpt-4.1-nano", 2],
  ["gpt-4o", 1.7],
  ["gpt-4o-2024-05-13", 1.75],
  ["gpt-4o-mini", 5 / 3],
  ["o3", 1.75],
  ["o4-mini", 20 / 11],
]);

function serviceTierMultiplier(usage: NormalizedUsage, model: ModelInfo | undefined): number | undefined {
  if (model?.provider !== "openai" && model?.provider !== "openai-codex") return 1;
  const tier = record(usage.raw)?.service_tier;
  if (tier === "flex") return OPENAI_FLEX_MODELS.has(model.id) ? 0.5 : undefined;
  if (tier === "priority" || tier === "fast") return OPENAI_FAST_MULTIPLIERS.get(model.id);
  return 1;
}

function scaledCost(cost: UsageCost, multiplier: number): UsageCost | undefined {
  if (multiplier === 1) return cost;
  const input = cost.input * multiplier;
  const output = cost.output * multiplier;
  const cacheRead = cost.cacheRead * multiplier;
  const cacheWrite = cost.cacheWrite * multiplier;
  return canonicalUsageCost({ input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite });
}

/**
 * Calculates structured USD cost components from mutually-exclusive normalized counters.
 * Returns undefined instead of under-reporting when any non-zero counter lacks a price.
 */
export function calculateUsageCost(
  usage: NormalizedUsage,
  pricing: ModelPricing | undefined,
  options: UsagePricingContext & { defaultCacheWriteTier?: ModelCacheTier; at?: number } = {},
): UsageCost | undefined {
  if (usage.cost !== undefined) return canonicalUsageCost(usage.cost);
  if (pricing === undefined) return undefined;
  if (pricing.validUntil !== undefined && (options.at ?? Date.now()) >= Date.parse(pricing.validUntil)) return undefined;
  if (
    usage.inputTokens === undefined || usage.outputTokens === undefined ||
    usage.cacheReadTokens === undefined || usage.cacheWriteTokens === undefined
  ) return undefined;
  if (![usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]
    .every((value) => Number.isSafeInteger(value) && value >= 0)) return undefined;
  const inputVolume = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  if (!Number.isSafeInteger(inputVolume)) return undefined;
  const prices = selectedPrices(pricing, inputVolume);
  const input = pricedComponent(usage.inputTokens, prices.input);
  const output = pricedComponent(usage.outputTokens, prices.output);
  const cacheRead = pricedComponent(usage.cacheReadTokens, prices.cacheRead);
  if (input === undefined || output === undefined || cacheRead === undefined) return undefined;
  let cacheWrite = 0;
  if (usage.cacheWriteTokens > 0) {
    const cacheCharges = cacheWriteCharges(
      usage.cacheWriteTokens,
      prices,
      {
        ...options,
        ...(usage.cacheWrite1hTokens === undefined ? {} : { cacheWrite1hTokens: usage.cacheWrite1hTokens }),
      },
      options.defaultCacheWriteTier,
    );
    if (cacheCharges === undefined) return undefined;
    cacheWrite = chargeCost(cacheCharges);
  }
  return canonicalUsageCost({ input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite });
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
  const multiplier = serviceTierMultiplier(usage, model);
  const scaled = cost === undefined || multiplier === undefined ? undefined : scaledCost(cost, multiplier);
  return scaled === undefined ? usage : { ...usage, cost: scaled };
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
      let aggregate: NormalizedUsage | undefined;
      let lastUsageSemantics: Extract<AdapterEvent, { type: "usage" }>["semantics"] | undefined;
      for await (const event of validatedProviderAdapterEvents(adapter.stream(request, signal))) {
        if (event.type === "response_end") {
          if (lastUsageSemantics === "incremental" && aggregate !== undefined) {
            yield { type: "usage", semantics: "final", usage: applyUsagePricing(aggregate, model(request.model), context) };
          }
          yield event;
          continue;
        }
        if (event.type !== "usage") {
          yield event;
          continue;
        }
        if (event.semantics === "incremental") {
          context = addUsagePricingContext(context, event.usage);
          const previousRaw = aggregate?.raw;
          aggregate = addNormalizedUsage(aggregate, event.usage);
          const raw = event.usage.raw ?? previousRaw;
          if (raw !== undefined) aggregate.raw = raw;
          yield event;
        } else {
          context = mergeUsagePricingContext(context, event.usage);
          aggregate = event.usage;
          yield { ...event, usage: applyUsagePricing(event.usage, model(request.model), context) };
        }
        lastUsageSemantics = event.semantics;
      }
    },
    async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
      return await adapter.listModels(signal);
    },
    ...(adapter.dispose === undefined ? {} : { dispose: async () => await adapter.dispose!() }),
  };
}
