import type {
  ModelCapability,
  ModelCompatibility,
  ModelEvidence,
  ModelInfo,
  ModelMetadataSource,
  ModelModality,
  ModelPricing,
  ModelProtocolFamily,
} from "../core/types.js";
import { asArray, asRecord } from "./transport.js";

const MODALITIES = ["text", "image", "audio", "video", "file"] as const satisfies readonly ModelModality[];
const MODALITY_ORDER = new Map(MODALITIES.map((value, index) => [value, index]));

export function modelEvidence<T>(value: T, source: ModelMetadataSource, observedAt: string): ModelEvidence<T> {
  return { value, source, observedAt };
}

export function baseModelCompatibility(
  protocolFamily: ModelProtocolFamily,
  tools: ModelCapability,
  observedAt: string,
): ModelCompatibility {
  return {
    protocolFamily: modelEvidence(protocolFamily, "maintained", observedAt),
    outputModalities: modelEvidence(["text"], "maintained", observedAt),
    strictTools: modelEvidence("unsupported", "maintained", observedAt),
    toolStreaming: modelEvidence(tools.value, tools.value === "unsupported" ? tools.source : "maintained", observedAt),
    sessionAffinity: modelEvidence("stateless", "maintained", observedAt),
  };
}

function priority(source: ModelMetadataSource): number {
  if (source === "provider" || source === "configuration") return 3;
  if (source === "observed") return 2;
  return 1;
}

export function mergeModelCompatibility(
  model: ModelInfo,
  ...overlays: Array<ModelCompatibility | undefined>
): ModelInfo {
  const compatibility: ModelCompatibility = { ...(model.compatibility ?? {}) };
  for (const overlay of overlays) {
    if (overlay === undefined) continue;
    for (const key of Object.keys(overlay) as Array<keyof ModelCompatibility>) {
      const incoming = overlay[key];
      if (incoming === undefined) continue;
      const current = compatibility[key];
      if (current !== undefined && priority(current.source) >= priority(incoming.source)) continue;
      Object.assign(compatibility, { [key]: structuredClone(incoming) });
    }
  }
  return { ...model, compatibility };
}

export function providerModalities(value: unknown, observedAt: string): ModelEvidence<ModelModality[]> | undefined {
  const unique = new Set<ModelModality>();
  const rawValues = asArray(value);
  if (rawValues.length === 0) return undefined;
  for (const raw of rawValues) {
    if (typeof raw !== "string") return undefined;
    const normalized = raw.trim().toLocaleLowerCase("en-US");
    if (!(MODALITIES as readonly string[]).includes(normalized)) return undefined;
    unique.add(normalized as ModelModality);
  }
  return modelEvidence(
    [...unique].sort((left, right) => MODALITY_ORDER.get(left)! - MODALITY_ORDER.get(right)!),
    "provider",
    observedAt,
  );
}

export function capabilityModalities(
  capability: ModelCapability,
  observedAt: string,
): ModelEvidence<ModelModality[]> | undefined {
  if (capability.value === "unknown") return undefined;
  return modelEvidence(
    capability.value === "supported" ? ["text", "image"] : ["text"],
    capability.source,
    observedAt,
  );
}

export function providerReasoningEfforts(value: unknown, observedAt: string): ModelEvidence<string[]> | undefined {
  const rawValues = asArray(value);
  if (rawValues.length === 0 || rawValues.length > 32) return undefined;
  const values: string[] = [];
  for (const entry of rawValues) {
    if (typeof entry !== "string") return undefined;
    const normalized = entry.trim();
    if (normalized === "" || normalized.includes("\0") || Buffer.byteLength(normalized, "utf8") > 64) return undefined;
    values.push(normalized);
  }
  const unique = [...new Set(values)];
  return unique.length === 0 ? undefined : modelEvidence(unique, "provider", observedAt);
}

function perMillion(value: unknown): number | undefined {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value.trim())
      ? Number(value)
      : undefined;
  if (parsed === undefined || !Number.isFinite(parsed) || parsed < 0) return undefined;
  const normalized = parsed * 1_000_000;
  return Number.isFinite(normalized) && normalized <= Number.MAX_SAFE_INTEGER
    ? Number(normalized.toPrecision(15))
    : undefined;
}

/** Normalizes OpenRouter's provider-reported per-token prices without retaining its raw metadata. */
export function openRouterPricing(model: unknown, observedAt: string): ModelPricing | undefined {
  const pricing = asRecord(asRecord(model)?.pricing);
  if (pricing === undefined) return undefined;
  const input = perMillion(pricing.prompt);
  const output = perMillion(pricing.completion);
  const cacheRead = perMillion(pricing.input_cache_read);
  const cacheWrite = perMillion(pricing.input_cache_write);
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) return undefined;
  return {
    currency: "USD",
    unit: "per_million_tokens",
    source: "provider",
    observedAt,
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

/**
 * Vercel publishes per-token prices. Tiered rows are intentionally left
 * unknown until every tier can be represented without boundary ambiguity.
 */
export function vercelGatewayPricing(model: unknown, observedAt: string): ModelPricing | undefined {
  const pricing = asRecord(asRecord(model)?.pricing);
  if (pricing === undefined) return undefined;
  if (Object.entries(pricing).some(([name, value]) => name.endsWith("_tiers") && asArray(value).length > 0)) {
    return undefined;
  }
  const input = perMillion(pricing.input);
  const output = perMillion(pricing.output);
  const cacheRead = perMillion(pricing.input_cache_read);
  const cacheWrite = perMillion(pricing.input_cache_write);
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) return undefined;
  return {
    currency: "USD",
    unit: "per_million_tokens",
    source: "provider",
    observedAt,
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}
