import { defaultSecretRedactor } from "../auth/redaction.js";
import { isJsonValue } from "../core/json.js";
import type {
  ModelCacheAffinity,
  ModelCacheMode,
  ModelCacheTier,
  ModelCapability,
  ModelCompatibility,
  ModelEvidence,
  ModelInfo,
  ModelMetadataSource,
  ModelModality,
  ModelPricing,
  ModelPricingTier,
  ModelProtocolFamily,
  ModelSessionAffinity,
  ProviderAdapter,
  ProviderId,
} from "../core/types.js";
import type { ModelCatalogStore } from "./model-catalog-store.js";
import { withUsagePricing } from "./pricing.js";
import { maintainedModelMetadata } from "./maintained-model-catalog.js";

const DEFAULT_MODEL_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_PROVIDERS = 128;
const DEFAULT_MAX_MODELS_PER_PROVIDER = 20_000;
const DEFAULT_MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_PROVIDER_ID_BYTES = 128;
const MAX_MODEL_ID_BYTES = 512;
const MAX_DISPLAY_NAME_BYTES = 1_024;
const MAX_DESCRIPTION_BYTES = 4 * 1_024;
const MAX_REFERENCE_BYTES = 1_024;
const MAX_ERROR_BYTES = 2_048;
const MAX_REASONING_EFFORTS = 32;
const MAX_REASONING_EFFORT_BYTES = 64;
const MAX_REASONING_EFFORT_AGGREGATE_BYTES = 2_048;
const MAX_PRICING_TIERS = 32;
const MAX_PRICING_TIER_NAME_BYTES = 128;
const MAX_LIVE_MODEL_METADATA_BYTES = 1024 * 1024;
const MAX_CONFIGURED_MODELS = 1_024;
const MAX_CONFIGURED_MODEL_TOKENS = 2_147_483_647;
const SNAPSHOT_VERSION = 1;

const MODEL_SOURCES = ["provider", "configuration", "maintained", "observed"] as const satisfies readonly ModelMetadataSource[];
const PROTOCOL_FAMILIES = [
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
  "gemini-generate-content",
  "gemini-interactions",
  "bedrock-converse",
  "mistral-conversations",
  "ollama-chat",
] as const satisfies readonly ModelProtocolFamily[];
const MODALITIES = ["text", "image", "audio", "video", "file"] as const satisfies readonly ModelModality[];
const CACHE_MODES = ["none", "automatic", "explicit"] as const satisfies readonly ModelCacheMode[];
const CACHE_AFFINITIES = ["none", "prefix", "session"] as const satisfies readonly ModelCacheAffinity[];
const CACHE_TIERS = ["default", "5m", "1h", "in-memory", "24h", "session", "provider-managed"] as const satisfies readonly ModelCacheTier[];
const SESSION_AFFINITIES = ["stateless", "optional", "required"] as const satisfies readonly ModelSessionAffinity[];

export type ModelCatalogProvenance = "none" | "live" | "persisted";

export interface ModelCatalogError {
  category: "provider" | "persistence" | "validation";
  message: string;
  at: string;
}

export interface ModelCatalogStatus {
  provider: ProviderId;
  provenance: ModelCatalogProvenance;
  fetchedAt?: string;
  stale: boolean;
  refreshing: boolean;
  modelCount: number;
  error?: ModelCatalogError;
}

export interface ModelCatalogRefreshResult {
  provider: ProviderId;
  ok: boolean;
  status: ModelCatalogStatus;
}

export const MODEL_REASONING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ModelReasoningEffort = typeof MODEL_REASONING_EFFORTS[number];

export type ModelReferenceMatch = "exact" | "fuzzy" | "ambiguous" | "none" | "unsupported-thinking";

export interface ModelReferenceResolution {
  query: string;
  match: ModelReferenceMatch;
  model?: ModelInfo;
  candidates: ModelInfo[];
  providerCandidates?: ProviderId[];
  reasoningEffort?: ModelReasoningEffort;
  supportedReasoningEfforts?: ModelReasoningEffort[];
}

export interface ResolvedModelSelection {
  provider: ProviderId;
  model: string;
  info?: ModelInfo;
  match: "exact" | "fuzzy" | "custom";
  reasoningEffort?: ModelReasoningEffort;
}

export class ModelReferenceResolutionError extends Error {
  readonly resolution: ModelReferenceResolution;

  constructor(resolution: ModelReferenceResolution) {
    super(modelReferenceFailureMessage(resolution));
    this.name = "ModelReferenceResolutionError";
    this.resolution = resolution;
  }
}

export interface ProviderRegistryOptions {
  cacheTtlMs?: number;
  catalogStore?: ModelCatalogStore;
  configuredModels?: readonly ConfiguredModel[];
  maxProviders?: number;
  maxModelsPerProvider?: number;
  maxSnapshotBytes?: number;
  now?: () => number;
}

export interface ConfiguredModelPricing {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  validUntil?: string;
  tiers?: ModelPricingTier[];
}

export interface ConfiguredModel {
  provider: ProviderId;
  id: string;
  displayName?: string;
  description?: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  tools?: boolean;
  reasoning?: boolean;
  images?: boolean;
  reasoningEfforts?: ModelReasoningEffort[];
  pricing?: ConfiguredModelPricing;
  /** Internal provenance used by the bundled fallback catalog. */
  metadataSource?: "maintained";
}

export interface ModelListOptions {
  refresh?: boolean;
  /** Return only IDs observed in the latest successful live provider listing. */
  verifiedOnly?: boolean;
}

export interface ModelReferenceOptions {
  provider?: ProviderId;
  refresh?: boolean;
  allowUnknownModel?: boolean;
  reasoningEffort?: string;
}

interface CatalogRecord {
  models: ModelInfo[];
  fetchedAt: number;
  provenance: Exclude<ModelCatalogProvenance, "none">;
  verifiedIds?: Set<string>;
}

interface ActiveRefresh {
  controller: AbortController;
  promise: Promise<void>;
  waiters: Set<symbol>;
  settled: boolean;
}

interface PersistedSnapshot {
  version: 1;
  savedAt: string;
  providers: Array<{
    provider: ProviderId;
    provenance: Exclude<ModelCatalogProvenance, "none">;
    fetchedAt: string;
    models: ModelInfo[];
  }>;
}

class CatalogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogValidationError";
  }
}

function positiveSafeInteger(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) throw new RangeError(`${label} must be a positive safe integer`);
  return selected;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !accepted.has(key));
  if (unknown.length > 0) throw new CatalogValidationError(`${label} contains unknown fields: ${unknown.join(", ")}`);
}

function boundedString(value: unknown, maxBytes: number, label: string): string {
  if (typeof value !== "string") throw new CatalogValidationError(`${label} must be a string`);
  const result = value.trim();
  if (result === "" || result.includes("\0") || /[\u0001-\u001f\u007f]/u.test(result)) {
    throw new CatalogValidationError(`${label} is invalid`);
  }
  if (Buffer.byteLength(result, "utf8") > maxBytes) throw new CatalogValidationError(`${label} is too long`);
  return result;
}

function boundedOptionalString(value: unknown, maxBytes: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  return boundedString(value, maxBytes, label);
}

function positiveOptionalInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new CatalogValidationError(`${label} must be a positive integer`);
  return value as number;
}

function nonNegativeOptionalInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CatalogValidationError(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function configuredId(value: unknown, maximumBytes: number, label: string): string {
  const result = boundedString(value, maximumBytes, label);
  if (value !== result) throw new CatalogValidationError(`${label} must not contain surrounding whitespace`);
  return result;
}

function configuredBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new CatalogValidationError(`${label} must be a boolean`);
  return value;
}

function configuredTokenLimit(value: unknown, label: string): number | undefined {
  const result = positiveOptionalInteger(value, label);
  if (result !== undefined && result > MAX_CONFIGURED_MODEL_TOKENS) {
    throw new CatalogValidationError(`${label} must not exceed ${MAX_CONFIGURED_MODEL_TOKENS}`);
  }
  return result;
}

function configuredPricing(value: unknown, label: string): ConfiguredModelPricing | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CatalogValidationError(`${label} must be an object`);
  }
  const input = value as Record<string, unknown>;
  exactKeys(input, [
    "input", "output", "cacheRead", "cacheWrite", "cacheWrite5m", "cacheWrite1h", "validUntil", "tiers",
  ], label);
  const result = tokenPrices(input, label);
  const validUntil = input.validUntil === undefined
    ? undefined
    : new Date(timestamp(input.validUntil, `${label}.validUntil`)).toISOString();
  let tiers: ModelPricingTier[] | undefined;
  if (input.tiers !== undefined) {
    if (!Array.isArray(input.tiers) || input.tiers.length === 0 || input.tiers.length > MAX_PRICING_TIERS) {
      throw new CatalogValidationError(`${label}.tiers must contain 1 to ${MAX_PRICING_TIERS} entries`);
    }
    tiers = input.tiers.map((entry, index) => pricingTier(entry, `${label}.tiers[${index}]`));
    if (new Set(tiers.map((entry) => entry.name)).size !== tiers.length) {
      throw new CatalogValidationError(`${label}.tiers contains duplicate names`);
    }
    assertNonOverlappingPricingTiers(tiers, `${label}.tiers`);
  }
  if (Object.keys(result).length === 0 && tiers === undefined) {
    throw new CatalogValidationError(`${label} must contain at least one price or tier`);
  }
  return {
    ...result,
    ...(validUntil === undefined ? {} : { validUntil }),
    ...(tiers === undefined ? {} : { tiers }),
  };
}

export function parseConfiguredModels(value: unknown): ConfiguredModel[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new CatalogValidationError("models must be an array");
  if (value.length > MAX_CONFIGURED_MODELS) {
    throw new CatalogValidationError(`models must contain at most ${MAX_CONFIGURED_MODELS} entries`);
  }
  const seen = new Set<string>();
  return value.map((entry, index): ConfiguredModel => {
    const label = `models[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new CatalogValidationError(`${label} must be an object`);
    }
    const input = entry as Record<string, unknown>;
    exactKeys(input, [
      "provider", "id", "displayName", "description", "contextTokens", "maxOutputTokens",
      "tools", "reasoning", "images", "reasoningEfforts", "pricing", "metadataSource",
    ], label);
    const provider = configuredId(input.provider, MAX_PROVIDER_ID_BYTES, `${label}.provider`) as ProviderId;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(provider)) {
      throw new CatalogValidationError(`${label}.provider is invalid`);
    }
    const id = configuredId(input.id, MAX_MODEL_ID_BYTES, `${label}.id`);
    const key = `${provider}\0${id}`;
    if (seen.has(key)) throw new CatalogValidationError(`Configured model ${provider}/${id} is duplicated`);
    seen.add(key);
    const displayName = boundedOptionalString(input.displayName, MAX_DISPLAY_NAME_BYTES, `${label}.displayName`);
    const description = boundedOptionalString(input.description, MAX_DESCRIPTION_BYTES, `${label}.description`);
    const contextTokens = configuredTokenLimit(input.contextTokens, `${label}.contextTokens`);
    const maxOutputTokens = configuredTokenLimit(input.maxOutputTokens, `${label}.maxOutputTokens`);
    const tools = configuredBoolean(input.tools, `${label}.tools`);
    const reasoning = configuredBoolean(input.reasoning, `${label}.reasoning`);
    const images = configuredBoolean(input.images, `${label}.images`);
    const reasoningEfforts = input.reasoningEfforts === undefined
      ? undefined
      : uniqueArray(
          input.reasoningEfforts,
          MODEL_REASONING_EFFORTS,
          MODEL_REASONING_EFFORTS.length,
          `${label}.reasoningEfforts`,
        );
    if (reasoning === false && reasoningEfforts !== undefined) {
      throw new CatalogValidationError(`${label}.reasoningEfforts cannot be set when reasoning is false`);
    }
    const normalizedPricing = configuredPricing(input.pricing, `${label}.pricing`);
    if (input.metadataSource !== undefined && input.metadataSource !== "maintained") {
      throw new CatalogValidationError(`${label}.metadataSource is invalid`);
    }
    return {
      provider,
      id,
      ...(displayName === undefined ? {} : { displayName }),
      ...(description === undefined ? {} : { description }),
      ...(contextTokens === undefined ? {} : { contextTokens }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(tools === undefined ? {} : { tools }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(images === undefined ? {} : { images }),
      ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
      ...(normalizedPricing === undefined ? {} : { pricing: normalizedPricing }),
      ...(input.metadataSource === "maintained" ? { metadataSource: "maintained" as const } : {}),
    };
  });
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== "string" || value.length > 64) throw new CatalogValidationError(`${label} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new CatalogValidationError(`${label} must be a canonical ISO timestamp`);
  }
  return parsed;
}

function source(value: unknown, label: string): ModelMetadataSource {
  if (!MODEL_SOURCES.includes(value as ModelMetadataSource)) throw new CatalogValidationError(`${label} is invalid`);
  return value as ModelMetadataSource;
}

function evidence<T>(
  value: unknown,
  label: string,
  parse: (input: unknown, label: string) => T,
): ModelEvidence<T> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CatalogValidationError(`${label} must be an evidence object`);
  }
  const input = value as Record<string, unknown>;
  exactKeys(input, ["value", "source", "observedAt"], label);
  const result: ModelEvidence<T> = {
    value: parse(input.value, `${label}.value`),
    source: source(input.source, `${label}.source`),
    observedAt: new Date(timestamp(input.observedAt, `${label}.observedAt`)).toISOString(),
  };
  return result;
}

function enumValue<T extends string>(values: readonly T[], value: unknown, label: string): T {
  if (!values.includes(value as T)) throw new CatalogValidationError(`${label} is invalid`);
  return value as T;
}

function uniqueArray<T extends string>(
  value: unknown,
  values: readonly T[],
  maximum: number,
  label: string,
): T[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new CatalogValidationError(`${label} must contain 1 to ${maximum} values`);
  }
  const result = value.map((entry, index) => enumValue(values, entry, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new CatalogValidationError(`${label} contains duplicates`);
  return result;
}

function reasoningEfforts(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REASONING_EFFORTS) {
    throw new CatalogValidationError(`${label} must contain 1 to ${MAX_REASONING_EFFORTS} values`);
  }
  let aggregate = 0;
  const result = value.map((entry, index) => {
    const effort = boundedString(entry, MAX_REASONING_EFFORT_BYTES, `${label}[${index}]`);
    aggregate += Buffer.byteLength(effort, "utf8");
    return effort;
  });
  if (aggregate > MAX_REASONING_EFFORT_AGGREGATE_BYTES) throw new CatalogValidationError(`${label} is too large`);
  if (new Set(result).size !== result.length) throw new CatalogValidationError(`${label} contains duplicates`);
  return result;
}

function capability(value: unknown, label: string): ModelCapability {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CatalogValidationError(`${label} must be an object`);
  }
  const input = value as Record<string, unknown>;
  exactKeys(input, ["value", "source", "observedAt"], label);
  if (!["supported", "unsupported", "unknown"].includes(String(input.value))) {
    throw new CatalogValidationError(`${label}.value is invalid`);
  }
  if (!["provider", "configuration", "maintained", "observed"].includes(String(input.source))) {
    throw new CatalogValidationError(`${label}.source is invalid`);
  }
  const observedAt = new Date(timestamp(input.observedAt, `${label}.observedAt`)).toISOString();
  return {
    value: input.value as ModelCapability["value"],
    source: input.source as ModelMetadataSource,
    observedAt,
  };
}

function compatibility(value: unknown, label: string): ModelCompatibility {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CatalogValidationError(`${label} must be an object`);
  }
  const input = value as Record<string, unknown>;
  const keys = [
    "protocolFamily", "inputModalities", "outputModalities", "reasoningEfforts", "strictTools",
    "toolStreaming", "deferredTools", "cacheMode", "cacheAffinity", "cacheTiers", "sessionAffinity",
  ] as const;
  exactKeys(input, keys, label);
  const result: ModelCompatibility = {};
  if (input.protocolFamily !== undefined) {
    result.protocolFamily = evidence(input.protocolFamily, `${label}.protocolFamily`, (entry, child) =>
      enumValue(PROTOCOL_FAMILIES, entry, child));
  }
  if (input.inputModalities !== undefined) {
    result.inputModalities = evidence(input.inputModalities, `${label}.inputModalities`, (entry, child) =>
      uniqueArray(entry, MODALITIES, MODALITIES.length, child));
  }
  if (input.outputModalities !== undefined) {
    result.outputModalities = evidence(input.outputModalities, `${label}.outputModalities`, (entry, child) =>
      uniqueArray(entry, MODALITIES, MODALITIES.length, child));
  }
  if (input.reasoningEfforts !== undefined) {
    result.reasoningEfforts = evidence(input.reasoningEfforts, `${label}.reasoningEfforts`, reasoningEfforts);
  }
  if (input.strictTools !== undefined) result.strictTools = capability(input.strictTools, `${label}.strictTools`);
  if (input.toolStreaming !== undefined) result.toolStreaming = capability(input.toolStreaming, `${label}.toolStreaming`);
  if (input.deferredTools !== undefined) result.deferredTools = capability(input.deferredTools, `${label}.deferredTools`);
  if (input.cacheMode !== undefined) {
    result.cacheMode = evidence(input.cacheMode, `${label}.cacheMode`, (entry, child) => enumValue(CACHE_MODES, entry, child));
  }
  if (input.cacheAffinity !== undefined) {
    result.cacheAffinity = evidence(input.cacheAffinity, `${label}.cacheAffinity`, (entry, child) =>
      enumValue(CACHE_AFFINITIES, entry, child));
  }
  if (input.cacheTiers !== undefined) {
    result.cacheTiers = evidence(input.cacheTiers, `${label}.cacheTiers`, (entry, child) =>
      uniqueArray(entry, CACHE_TIERS, CACHE_TIERS.length, child));
  }
  if (input.sessionAffinity !== undefined) {
    result.sessionAffinity = evidence(input.sessionAffinity, `${label}.sessionAffinity`, (entry, child) =>
      enumValue(SESSION_AFFINITIES, entry, child));
  }
  if (Object.keys(result).length === 0) throw new CatalogValidationError(`${label} must not be empty`);
  return result;
}

function normalizedPrice(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new CatalogValidationError(`${label} must be a finite non-negative normalized price`);
  }
  return value;
}

function tokenPrices(input: Record<string, unknown>, label: string): {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
} {
  const inputPrice = normalizedPrice(input.input, `${label}.input`);
  const output = normalizedPrice(input.output, `${label}.output`);
  const cacheRead = normalizedPrice(input.cacheRead, `${label}.cacheRead`);
  const cacheWrite = normalizedPrice(input.cacheWrite, `${label}.cacheWrite`);
  const cacheWrite5m = normalizedPrice(input.cacheWrite5m, `${label}.cacheWrite5m`);
  const cacheWrite1h = normalizedPrice(input.cacheWrite1h, `${label}.cacheWrite1h`);
  return {
    ...(inputPrice === undefined ? {} : { input: inputPrice }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    ...(cacheWrite5m === undefined ? {} : { cacheWrite5m }),
    ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
  };
}

function pricingTier(value: unknown, label: string): ModelPricingTier {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CatalogValidationError(`${label} must be an object`);
  }
  const input = value as Record<string, unknown>;
  exactKeys(input, [
    "name", "minimumInputTokens", "maximumInputTokens", "input", "output", "cacheRead", "cacheWrite",
    "cacheWrite5m", "cacheWrite1h",
  ], label);
  const minimumInputTokens = input.minimumInputTokens === undefined
    ? undefined
    : nonNegativeOptionalInteger(input.minimumInputTokens, `${label}.minimumInputTokens`);
  const maximumInputTokens = input.maximumInputTokens === undefined
    ? undefined
    : positiveOptionalInteger(input.maximumInputTokens, `${label}.maximumInputTokens`);
  if (minimumInputTokens !== undefined && maximumInputTokens !== undefined && minimumInputTokens > maximumInputTokens) {
    throw new CatalogValidationError(`${label} has an inverted token range`);
  }
  const prices = tokenPrices(input, label);
  if (Object.keys(prices).length === 0) throw new CatalogValidationError(`${label} must contain at least one price`);
  return {
    name: boundedString(input.name, MAX_PRICING_TIER_NAME_BYTES, `${label}.name`),
    ...(minimumInputTokens === undefined ? {} : { minimumInputTokens }),
    ...(maximumInputTokens === undefined ? {} : { maximumInputTokens }),
    ...prices,
  };
}

function assertNonOverlappingPricingTiers(tiers: readonly ModelPricingTier[], label: string): void {
  for (let index = 0; index < tiers.length; index += 1) {
    const left = tiers[index]!;
    const leftMinimum = left.minimumInputTokens ?? 0;
    const leftMaximum = left.maximumInputTokens ?? Number.MAX_SAFE_INTEGER;
    for (let other = index + 1; other < tiers.length; other += 1) {
      const right = tiers[other]!;
      const rightMinimum = right.minimumInputTokens ?? 0;
      const rightMaximum = right.maximumInputTokens ?? Number.MAX_SAFE_INTEGER;
      if (leftMinimum <= rightMaximum && rightMinimum <= leftMaximum) {
        throw new CatalogValidationError(`${label} contains overlapping ranges: ${left.name}, ${right.name}`);
      }
    }
  }
}

function pricing(value: unknown, label: string): ModelPricing {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CatalogValidationError(`${label} must be an object`);
  }
  const input = value as Record<string, unknown>;
  exactKeys(input, [
    "currency", "unit", "source", "observedAt", "input", "output", "cacheRead", "cacheWrite",
    "cacheWrite5m", "cacheWrite1h", "validUntil", "tiers",
  ], label);
  if (input.currency !== "USD" || input.unit !== "per_million_tokens") {
    throw new CatalogValidationError(`${label} must use normalized USD per-million-token units`);
  }
  const prices = tokenPrices(input, label);
  let tiers: ModelPricingTier[] | undefined;
  if (input.tiers !== undefined) {
    if (!Array.isArray(input.tiers) || input.tiers.length === 0 || input.tiers.length > MAX_PRICING_TIERS) {
      throw new CatalogValidationError(`${label}.tiers must contain 1 to ${MAX_PRICING_TIERS} entries`);
    }
    tiers = input.tiers.map((entry, index) => pricingTier(entry, `${label}.tiers[${index}]`));
    if (new Set(tiers.map((entry) => entry.name)).size !== tiers.length) {
      throw new CatalogValidationError(`${label}.tiers contains duplicate names`);
    }
    assertNonOverlappingPricingTiers(tiers, `${label}.tiers`);
  }
  if (Object.keys(prices).length === 0 && tiers === undefined) {
    throw new CatalogValidationError(`${label} must contain a price or pricing tier`);
  }
  return {
    currency: "USD",
    unit: "per_million_tokens",
    source: source(input.source, `${label}.source`),
    observedAt: new Date(timestamp(input.observedAt, `${label}.observedAt`)).toISOString(),
    ...(input.validUntil === undefined
      ? {}
      : { validUntil: new Date(timestamp(input.validUntil, `${label}.validUntil`)).toISOString() }),
    ...prices,
    ...(tiers === undefined ? {} : { tiers }),
  };
}

/** Adds only conservative maintained evidence, and never overrides provider/configuration evidence. */
export function applyMaintainedModelMetadata(model: ModelInfo, observedAt: string): ModelInfo {
  const maintained = maintainedModelMetadata(model.provider, model.id);
  return maintained === undefined ? model : applyConfiguredModel(maintained, model, observedAt);
}

function normalizeLiveModel(
  value: unknown,
  provider: ProviderId,
  observedAt: string,
  allowMetadata: boolean,
): ModelInfo {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CatalogValidationError(`Provider ${provider} returned a non-object model`);
  }
  const input = value as Record<string, unknown>;
  exactKeys(input, [
    "id", "provider", "displayName", "description", "contextTokens", "maxOutputTokens", "capabilities",
    "compatibility", "pricing", ...(allowMetadata ? ["metadata"] : []),
  ], `Model from ${provider}`);
  const id = boundedString(input.id, MAX_MODEL_ID_BYTES, `Model ID from ${provider}`);
  if (input.provider !== provider) throw new CatalogValidationError(`Model ${id} belongs to a different provider`);
  const displayName = boundedOptionalString(input.displayName, MAX_DISPLAY_NAME_BYTES, `Display name for ${provider}/${id}`);
  const description = boundedOptionalString(input.description, MAX_DESCRIPTION_BYTES, `Description for ${provider}/${id}`);
  const contextTokens = positiveOptionalInteger(input.contextTokens, `Context size for ${provider}/${id}`);
  const maxOutputTokens = positiveOptionalInteger(input.maxOutputTokens, `Output size for ${provider}/${id}`);
  if (input.capabilities === null || typeof input.capabilities !== "object" || Array.isArray(input.capabilities)) {
    throw new CatalogValidationError(`Capabilities for ${provider}/${id} must be an object`);
  }
  const capabilities = input.capabilities as Record<string, unknown>;
  exactKeys(capabilities, ["tools", "reasoning", "images"], `Capabilities for ${provider}/${id}`);
  const normalizedCompatibility = input.compatibility === undefined
    ? undefined
    : compatibility(input.compatibility, `Compatibility for ${provider}/${id}`);
  const normalizedPricing = input.pricing === undefined
    ? undefined
    : pricing(input.pricing, `Pricing for ${provider}/${id}`);
  let metadata: ModelInfo["metadata"];
  if (input.metadata !== undefined) {
    if (!allowMetadata || !isJsonValue(input.metadata)) throw new CatalogValidationError(`Metadata for ${provider}/${id} is invalid`);
    const serialized = JSON.stringify(input.metadata);
    if (Buffer.byteLength(serialized, "utf8") > MAX_LIVE_MODEL_METADATA_BYTES) {
      throw new CatalogValidationError(`Metadata for ${provider}/${id} exceeds ${MAX_LIVE_MODEL_METADATA_BYTES} bytes`);
    }
    metadata = structuredClone(input.metadata);
  }
  return applyMaintainedModelMetadata({
    id,
    provider,
    ...(displayName === undefined ? {} : { displayName }),
    ...(description === undefined ? {} : { description }),
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    capabilities: {
      tools: capability(capabilities.tools, `Tool capability for ${provider}/${id}`),
      reasoning: capability(capabilities.reasoning, `Reasoning capability for ${provider}/${id}`),
      images: capability(capabilities.images, `Image capability for ${provider}/${id}`),
    },
    ...(normalizedCompatibility === undefined ? {} : { compatibility: normalizedCompatibility }),
    ...(normalizedPricing === undefined ? {} : { pricing: normalizedPricing }),
    ...(metadata === undefined ? {} : { metadata }),
  }, observedAt);
}

function normalizeModels(
  values: unknown,
  provider: ProviderId,
  observedAt: string,
  maxModels: number,
  allowMetadata: boolean,
): ModelInfo[] {
  if (!Array.isArray(values)) throw new CatalogValidationError(`Provider ${provider} returned a non-array model catalog`);
  if (values.length > maxModels) throw new CatalogValidationError(`Provider ${provider} returned more than ${maxModels} models`);
  const unique = new Map<string, ModelInfo>();
  for (const value of values) {
    const model = normalizeLiveModel(value, provider, observedAt, allowMetadata);
    if (!unique.has(model.id)) unique.set(model.id, model);
  }
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** Normalizes an adapter-owned live catalog through the registry's public bounds. */
export function normalizeProviderModelCatalog(
  values: unknown,
  provider: ProviderId,
  observedAt: string,
): ModelInfo[] {
  const normalizedObservedAt = new Date(timestamp(observedAt, "Provider model observation time")).toISOString();
  return normalizeModels(values, provider, normalizedObservedAt, DEFAULT_MAX_MODELS_PER_PROVIDER, true);
}

function persistedModel(model: ModelInfo): ModelInfo {
  return {
    id: model.id,
    provider: model.provider,
    ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
    ...(model.description === undefined ? {} : { description: model.description }),
    ...(model.contextTokens === undefined ? {} : { contextTokens: model.contextTokens }),
    ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
    capabilities: {
      tools: { ...model.capabilities.tools },
      reasoning: { ...model.capabilities.reasoning },
      images: { ...model.capabilities.images },
    },
    ...(model.compatibility === undefined ? {} : { compatibility: structuredClone(model.compatibility) }),
    ...(model.pricing === undefined ? {} : { pricing: structuredClone(model.pricing) }),
  };
}

function detachedModel(model: ModelInfo): ModelInfo {
  return {
    ...persistedModel(model),
    ...(model.metadata === undefined ? {} : { metadata: structuredClone(model.metadata) }),
  };
}

function configuredCapability(value: boolean | undefined, observedAt: string): ModelCapability {
  return {
    value: value === undefined ? "unknown" : value ? "supported" : "unsupported",
    source: "configuration",
    observedAt,
  };
}

function applyConfiguredModel(
  configuration: ConfiguredModel,
  existing: ModelInfo | undefined,
  observedAt: string,
): ModelInfo {
  const source: ModelMetadataSource = configuration.metadataSource ?? "configuration";
  const base: ModelInfo = existing === undefined
    ? {
        id: configuration.id,
        provider: configuration.provider,
        capabilities: {
          tools: configuredCapability(undefined, observedAt),
          reasoning: configuredCapability(undefined, observedAt),
          images: configuredCapability(undefined, observedAt),
        },
      }
    : detachedModel(existing);
  const reasoning = configuration.reasoning ?? (configuration.reasoningEfforts === undefined ? undefined : true);
  const capability = (current: ModelCapability, value: boolean | undefined): ModelCapability => {
    if (value === undefined || (source === "maintained" && current.value !== "unknown")) return current;
    return { ...configuredCapability(value, observedAt), source };
  };
  const maintainedFallback = <T>(current: T | undefined, value: T | undefined): T | undefined =>
    source === "maintained" && current !== undefined ? current : value ?? current;
  const reasoningEfforts = source === "maintained" && base.compatibility?.reasoningEfforts !== undefined
    ? base.compatibility.reasoningEfforts
    : configuration.reasoningEfforts === undefined
      ? base.compatibility?.reasoningEfforts
      : { value: [...configuration.reasoningEfforts], source, observedAt };
  const compatibility = reasoningEfforts === undefined
    ? base.compatibility
    : { ...(base.compatibility ?? {}), reasoningEfforts };
  const pricing = source === "maintained" && base.pricing !== undefined
    ? base.pricing
    : configuration.pricing === undefined
      ? base.pricing
      : {
          currency: "USD" as const,
          unit: "per_million_tokens" as const,
          source,
          observedAt,
          ...configuration.pricing,
        };
  return {
    ...base,
    id: configuration.id,
    provider: configuration.provider,
    ...(maintainedFallback(base.displayName, configuration.displayName) === undefined
      ? {}
      : { displayName: maintainedFallback(base.displayName, configuration.displayName)! }),
    ...(maintainedFallback(base.description, configuration.description) === undefined
      ? {}
      : { description: maintainedFallback(base.description, configuration.description)! }),
    ...(maintainedFallback(base.contextTokens, configuration.contextTokens) === undefined
      ? {}
      : { contextTokens: maintainedFallback(base.contextTokens, configuration.contextTokens)! }),
    ...(maintainedFallback(base.maxOutputTokens, configuration.maxOutputTokens) === undefined
      ? {}
      : { maxOutputTokens: maintainedFallback(base.maxOutputTokens, configuration.maxOutputTokens)! }),
    capabilities: {
      tools: capability(base.capabilities.tools, configuration.tools),
      reasoning: capability(base.capabilities.reasoning, reasoning),
      images: capability(base.capabilities.images, configuration.images),
    },
    ...(compatibility === undefined ? {} : { compatibility }),
    ...(pricing === undefined ? {} : { pricing }),
  };
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = defaultSecretRedactor.redact(raw).replace(/[\r\n\t]+/gu, " ").trim() || "Model catalog operation failed";
  return Buffer.byteLength(redacted, "utf8") <= MAX_ERROR_BYTES
    ? redacted
    : `${Buffer.from(redacted, "utf8").subarray(0, MAX_ERROR_BYTES - 3).toString("utf8")}...`;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function waitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function fuzzyScore(query: string, model: ModelInfo): number | undefined {
  const needle = query.trim().toLocaleLowerCase("en-US");
  if (needle === "") return undefined;
  const id = model.id.toLocaleLowerCase("en-US");
  const canonical = `${model.provider}/${model.id}`.toLocaleLowerCase("en-US");
  const name = model.displayName?.toLocaleLowerCase("en-US");
  if (canonical === needle) return 0;
  if (id === needle) return 1;
  if (name === needle) return 2;
  if (canonical.startsWith(needle)) return 10 + canonical.length - needle.length;
  if (id.startsWith(needle)) return 20 + id.length - needle.length;
  const idIndex = id.indexOf(needle);
  if (idIndex >= 0) return 40 + idIndex;
  const canonicalIndex = canonical.indexOf(needle);
  if (canonicalIndex >= 0) return 60 + canonicalIndex;
  const nameIndex = name?.indexOf(needle) ?? -1;
  if (nameIndex >= 0) return 80 + nameIndex;
  let cursor = 0;
  let gaps = 0;
  for (const character of needle) {
    const next = canonical.indexOf(character, cursor);
    if (next < 0) return undefined;
    gaps += next - cursor;
    cursor = next + 1;
  }
  return 200 + gaps;
}

function datedModel(id: string): boolean {
  return /-(?:19|20)\d{6}$/u.test(id);
}

function compareFuzzy(
  left: { model: ModelInfo; score: number },
  right: { model: ModelInfo; score: number },
): number {
  if (left.score !== right.score) return left.score - right.score;
  const date = Number(datedModel(left.model.id)) - Number(datedModel(right.model.id));
  if (date !== 0) return date;
  return `${left.model.provider}/${left.model.id}`.localeCompare(`${right.model.provider}/${right.model.id}`);
}

export function parseModelReasoningReference(reference: string): { reference: string; reasoningEffort?: ModelReasoningEffort } {
  const separator = reference.lastIndexOf(":");
  if (separator < 1) return { reference };
  const suffix = reference.slice(separator + 1).toLocaleLowerCase("en-US");
  const reasoningEffort = suffix === "none" ? "off" : suffix;
  if (!MODEL_REASONING_EFFORTS.includes(reasoningEffort as ModelReasoningEffort)) return { reference };
  return { reference: reference.slice(0, separator), reasoningEffort: reasoningEffort as ModelReasoningEffort };
}

export function normalizeModelReasoningEffort(value: string): ModelReasoningEffort {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  const reasoningEffort = normalized === "none" ? "off" : normalized;
  if (!MODEL_REASONING_EFFORTS.includes(reasoningEffort as ModelReasoningEffort)) {
    throw new Error(`Thinking level must be one of: ${MODEL_REASONING_EFFORTS.join(", ")}`);
  }
  return reasoningEffort as ModelReasoningEffort;
}

export function modelReasoningEfforts(model: ModelInfo): readonly ModelReasoningEffort[] {
  if (model.capabilities.reasoning.value === "unsupported") return ["off"];
  const reported = model.compatibility?.reasoningEfforts?.value;
  if (reported === undefined) return MODEL_REASONING_EFFORTS;
  const normalized = new Set(reported.map((value) => value.trim().toLocaleLowerCase("en-US")));
  if (normalized.has("none")) normalized.add("off");
  return MODEL_REASONING_EFFORTS.filter((effort) => normalized.has(effort));
}

export function modelReferenceFailureMessage(resolution: ModelReferenceResolution): string | undefined {
  if (resolution.match === "exact" || resolution.match === "fuzzy") return undefined;
  if (resolution.match === "unsupported-thinking") {
    const candidate = resolution.candidates[0];
    const label = candidate === undefined ? resolution.query : `${candidate.provider}/${candidate.id}`;
    return `${label} does not support thinking level ${resolution.reasoningEffort ?? "requested"}; supported levels: ${(resolution.supportedReasoningEfforts ?? []).join(", ") || "none"}`;
  }
  if (resolution.match === "ambiguous") {
    const labels = resolution.providerCandidates
      ?? resolution.candidates.map((model) => `${model.provider}/${model.id}`);
    return `Model reference ${JSON.stringify(resolution.query)} is ambiguous; choose one of: ${labels.join(", ")}`;
  }
  return `No model matches ${JSON.stringify(resolution.query)}`;
}

export class ProviderRegistry {
  readonly #adapters = new Map<ProviderId, ProviderAdapter>();
  readonly #runtimeAdapters = new Map<ProviderId, ProviderAdapter>();
  readonly #catalogs = new Map<ProviderId, CatalogRecord>();
  #configuredModels = new Map<ProviderId, Map<string, ConfiguredModel>>();
  #configuredObservedAt: string;
  readonly #errors = new Map<ProviderId, ModelCatalogError>();
  readonly #forceRefresh = new Set<ProviderId>();
  readonly #retained = new Map<ProviderId, Set<string>>();
  readonly #active = new Map<ProviderId, ActiveRefresh>();
  readonly #cacheTtlMs: number;
  readonly #maxProviders: number;
  readonly #maxModelsPerProvider: number;
  readonly #maxSnapshotBytes: number;
  readonly #store: ModelCatalogStore | undefined;
  readonly #now: () => number;
  readonly #ready: Promise<void>;
  #persistenceError: ModelCatalogError | undefined;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(adapters: Iterable<ProviderAdapter> = [], options: ProviderRegistryOptions = {}) {
    this.#cacheTtlMs = positiveSafeInteger(options.cacheTtlMs, DEFAULT_MODEL_CACHE_TTL_MS, "Model catalog TTL");
    this.#maxProviders = positiveSafeInteger(options.maxProviders, DEFAULT_MAX_PROVIDERS, "Maximum catalog providers");
    this.#maxModelsPerProvider = positiveSafeInteger(
      options.maxModelsPerProvider,
      DEFAULT_MAX_MODELS_PER_PROVIDER,
      "Maximum models per provider",
    );
    this.#maxSnapshotBytes = positiveSafeInteger(
      options.maxSnapshotBytes,
      DEFAULT_MAX_SNAPSHOT_BYTES,
      "Maximum catalog snapshot size",
    );
    this.#store = options.catalogStore;
    this.#now = options.now ?? Date.now;
    this.#configuredObservedAt = new Date(this.#now()).toISOString();
    for (const adapter of adapters) this.register(adapter);
    if (options.configuredModels !== undefined) this.configureModels(options.configuredModels);
    this.#ready = this.#hydrate();
  }

  register(adapter: ProviderAdapter): void {
    boundedString(adapter.id, MAX_PROVIDER_ID_BYTES, "Provider adapter ID");
    if (this.#adapters.has(adapter.id)) throw new Error(`Provider adapter already registered: ${adapter.id}`);
    if (this.#adapters.size >= this.#maxProviders) throw new Error(`Provider registry cannot exceed ${this.#maxProviders} adapters`);
    this.#adapters.set(adapter.id, adapter);
    this.#runtimeAdapters.set(adapter.id, withUsagePricing(adapter, (model) =>
      this.#effectiveModels(adapter.id).find((entry) => entry.id === model)));
  }

  unregister(
    id: ProviderId,
    adapter?: ProviderAdapter,
    options: { preservePersistedCatalog?: boolean } = {},
  ): boolean {
    const current = this.#adapters.get(id);
    if (current === undefined || (adapter !== undefined && current !== adapter)) return false;
    this.#adapters.delete(id);
    this.#runtimeAdapters.delete(id);
    this.#active.get(id)?.controller.abort(new Error(`Provider adapter was unregistered: ${id}`));
    this.#catalogs.delete(id);
    this.#errors.delete(id);
    this.#forceRefresh.delete(id);
    this.#retained.delete(id);
    if (options.preservePersistedCatalog !== true) {
      void this.#ready.then(async () => await this.#persist()).catch(() => undefined);
    }
    return true;
  }

  get(id: ProviderId): ProviderAdapter {
    const adapter = this.#adapters.get(id);
    if (adapter === undefined) throw new Error(`Provider adapter is not registered: ${id}`);
    return adapter;
  }

  /** Adapter facade used for runs; it adds deterministic catalog-based costs when providers omit them. */
  runtimeAdapter(id: ProviderId): ProviderAdapter {
    const adapter = this.#runtimeAdapters.get(id);
    if (adapter === undefined) throw new Error(`Provider adapter is not registered: ${id}`);
    return adapter;
  }

  has(id: ProviderId): boolean {
    return this.#adapters.has(id);
  }

  list(): ProviderAdapter[] {
    return [...this.#adapters.values()];
  }

  configureModels(value: readonly ConfiguredModel[]): void {
    const configured = parseConfiguredModels(value);
    const grouped = new Map<ProviderId, Map<string, ConfiguredModel>>();
    for (const model of configured) {
      if (!this.#adapters.has(model.provider)) {
        throw new Error(`Configured model provider is not registered: ${model.provider}`);
      }
      let models = grouped.get(model.provider);
      if (models === undefined) {
        models = new Map();
        grouped.set(model.provider, models);
      }
      if (models.size >= this.#maxModelsPerProvider) {
        throw new Error(`Provider ${model.provider} cannot configure more than ${this.#maxModelsPerProvider} models`);
      }
      models.set(model.id, model);
    }
    for (const [provider, models] of grouped) {
      const total = new Set([
        ...(this.#catalogs.get(provider)?.models.map((model) => model.id) ?? []),
        ...models.keys(),
      ]).size;
      if (total > this.#maxModelsPerProvider) {
        throw new Error(`Provider ${provider} catalog plus configured models exceeds ${this.#maxModelsPerProvider} models`);
      }
    }
    this.#configuredModels = grouped;
    this.#configuredObservedAt = new Date(this.#now()).toISOString();
  }

  invalidateModels(provider?: ProviderId): void {
    if (provider === undefined) {
      for (const id of this.#adapters.keys()) this.#forceRefresh.add(id);
    } else {
      this.#forceRefresh.add(provider);
    }
  }

  retainModel(provider: ProviderId, model: string): boolean {
    this.get(provider);
    const id = boundedString(model, MAX_MODEL_ID_BYTES, "Retained model ID");
    let retained = this.#retained.get(provider);
    if (retained === undefined) {
      retained = new Set();
      this.#retained.set(provider, retained);
    }
    if (!retained.has(id) && retained.size >= this.#maxModelsPerProvider) {
      throw new Error(`Provider ${provider} cannot retain more than ${this.#maxModelsPerProvider} model selections`);
    }
    retained.add(id);
    return this.#effectiveModels(provider).some((entry) => entry.id === id);
  }

  releaseModel(provider: ProviderId, model: string): boolean {
    const retained = this.#retained.get(provider);
    if (retained === undefined) return false;
    const removed = retained.delete(model);
    if (retained.size === 0) this.#retained.delete(provider);
    return removed;
  }

  async resolveModel(provider: ProviderId, model: string, signal: AbortSignal): Promise<ModelInfo | undefined> {
    await this.#ready;
    signal.throwIfAborted();
    const requested = boundedString(model, MAX_MODEL_ID_BYTES, "Model ID");
    const previous = this.#effectiveModels(provider).find((entry) => entry.id === requested);
    if (previous !== undefined) this.retainModel(provider, requested);
    if (previous !== undefined && this.#configuredModels.get(provider)?.has(requested) === true) return previous;
    if (!this.#stale(provider)) return previous;
    await this.refreshModels(provider, signal);
    signal.throwIfAborted();
    const resolved = this.#effectiveModels(provider).find((entry) => entry.id === requested);
    if (resolved !== undefined) this.retainModel(provider, requested);
    return resolved ?? previous;
  }

  async listModels(
    provider: ProviderId | undefined,
    signal: AbortSignal,
    options: ModelListOptions = {},
  ): Promise<ModelInfo[]> {
    await this.#ready;
    signal.throwIfAborted();
    if (options.refresh === true) {
      if (provider === undefined) await this.refreshAllModels(signal);
      else await this.refreshModels(provider, signal);
    }
    if (provider !== undefined) {
      if (!this.#adapters.has(provider)) this.get(provider);
      return this.#effectiveModels(provider, options.verifiedOnly === true);
    }
    return [...this.#adapters.keys()]
      .sort((left, right) => left.localeCompare(right))
      .flatMap((id) => this.#effectiveModels(id, options.verifiedOnly === true));
  }

  async refreshModels(provider: ProviderId, signal: AbortSignal): Promise<ModelCatalogRefreshResult> {
    await this.#ready;
    this.get(provider);
    await this.#joinRefresh(provider, signal);
    const status = this.#status(provider);
    return { provider, ok: status.error === undefined || status.error.category === "persistence", status };
  }

  async refreshAllModels(signal: AbortSignal): Promise<ModelCatalogRefreshResult[]> {
    await this.#ready;
    signal.throwIfAborted();
    const providers = [...this.#adapters.keys()].sort((left, right) => left.localeCompare(right));
    return await Promise.all(providers.map(async (provider) => await this.refreshModels(provider, signal)));
  }

  async catalogStatus(provider?: ProviderId): Promise<ModelCatalogStatus[]> {
    await this.#ready;
    if (provider !== undefined) return [this.#status(provider)];
    return [...this.#adapters.keys()].sort((left, right) => left.localeCompare(right)).map((id) => this.#status(id));
  }

  async resolveModelReference(
    reference: string,
    signal: AbortSignal,
    options: ModelReferenceOptions = {},
  ): Promise<ModelReferenceResolution> {
    await this.#ready;
    signal.throwIfAborted();
    const query = boundedString(reference, MAX_REFERENCE_BYTES, "Model reference");
    let provider: ProviderId | undefined;
    if (options.provider !== undefined) {
      const providerResolution = this.#resolveProvider(options.provider);
      if (providerResolution.candidates.length > 1) {
        return {
          query,
          match: "ambiguous",
          candidates: [],
          providerCandidates: providerResolution.candidates.slice(0, 10),
        };
      }
      provider = providerResolution.provider;
      if (provider === undefined) return { query, match: "none", candidates: [] };
    }
    let modelQuery = query;
    if (provider === undefined && options.provider === undefined) {
      const slash = query.indexOf("/");
      if (slash > 0) {
        const prefix = query.slice(0, slash);
        const inferred = this.#resolveProvider(prefix);
        if (inferred.candidates.length > 1) {
          return {
            query,
            match: "ambiguous",
            candidates: [],
            providerCandidates: inferred.candidates.slice(0, 10),
          };
        }
        if (inferred.provider !== undefined) {
          provider = inferred.provider;
          modelQuery = query.slice(slash + 1);
        }
      }
    } else if (provider !== undefined) {
      const prefix = [provider, options.provider]
        .filter((value): value is string => value !== undefined)
        .find((value) => query.toLocaleLowerCase("en-US").startsWith(`${value.toLocaleLowerCase("en-US")}/`));
      if (prefix !== undefined) modelQuery = query.slice(prefix.length + 1);
    }

    const configuredResolution = this.#resolveConfiguredReference(
      modelQuery,
      provider,
      options.reasoningEffort,
    );
    if (configuredResolution.match !== "none") {
      if (configuredResolution.model !== undefined) {
        this.retainModel(configuredResolution.model.provider, configuredResolution.model.id);
      }
      return { query, ...configuredResolution };
    }

    const refresh = options.refresh ?? true;
    const models = await this.listModels(provider, signal, { refresh });
    const result = this.#resolveReferenceFromModels(modelQuery, models, provider, options.reasoningEffort);
    if (result.model !== undefined) this.retainModel(result.model.provider, result.model.id);
    return { query, ...result };
  }

  async requireModelReference(
    reference: string,
    signal: AbortSignal,
    options: ModelReferenceOptions = {},
  ): Promise<ResolvedModelSelection> {
    if (options.provider !== undefined) {
      const provider = this.#resolveProvider(options.provider);
      if (provider.provider === undefined && provider.candidates.length === 0) this.get(options.provider);
    }
    const resolution = await this.resolveModelReference(reference, signal, options);
    if ((resolution.match === "exact" || resolution.match === "fuzzy") && resolution.model !== undefined) {
      return {
        provider: resolution.model.provider,
        model: resolution.model.id,
        info: resolution.model,
        match: resolution.match,
        ...(resolution.reasoningEffort === undefined ? {} : { reasoningEffort: resolution.reasoningEffort }),
      };
    }
    if (resolution.match === "none" && options.allowUnknownModel === true) {
      const custom = this.#customModelSelection(resolution.query, options.provider, options.reasoningEffort);
      if (custom !== undefined) return custom;
    }
    throw new ModelReferenceResolutionError(resolution);
  }

  #effectiveModels(provider: ProviderId, verifiedOnly = false): ModelInfo[] {
    const record = this.#catalogs.get(provider);
    const catalog = verifiedOnly
      ? record?.provenance === "live"
        ? record.models.filter((model) => record.verifiedIds?.has(model.id) ?? true)
        : []
      : record?.models ?? [];
    const configured = this.#configuredModels.get(provider);
    if (configured === undefined) return [...catalog];
    const models = new Map(catalog.map((model) => [model.id, model]));
    for (const configuration of configured.values()) {
      if (verifiedOnly && !models.has(configuration.id)) continue;
      models.set(
        configuration.id,
        applyConfiguredModel(configuration, models.get(configuration.id), this.#configuredObservedAt),
      );
    }
    if (models.size > this.#maxModelsPerProvider) {
      throw new Error(`Provider ${provider} catalog plus configured models exceeds ${this.#maxModelsPerProvider} models`);
    }
    return [...models.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  async #hydrate(): Promise<void> {
    if (this.#store === undefined) return;
    try {
      const serialized = await this.#store.read(this.#maxSnapshotBytes);
      if (serialized === undefined || serialized.trim() === "") return;
      if (Buffer.byteLength(serialized, "utf8") > this.#maxSnapshotBytes) {
        throw new CatalogValidationError(`Persisted model catalog exceeds ${this.#maxSnapshotBytes} bytes`);
      }
      const parsed = JSON.parse(serialized) as unknown;
      const snapshot = this.#parseSnapshot(parsed);
      for (const [provider, record] of snapshot.records) this.#catalogs.set(provider, record);
      if (snapshot.error !== undefined) this.#persistenceError = this.#catalogError(snapshot.error, "validation");
    } catch (error) {
      this.#persistenceError = this.#catalogError(error, error instanceof CatalogValidationError ? "validation" : "persistence");
    }
  }

  #parseSnapshot(value: unknown): { records: Map<ProviderId, CatalogRecord>; error?: CatalogValidationError } {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new CatalogValidationError("Persisted model catalog must be an object");
    }
    const input = value as Record<string, unknown>;
    exactKeys(input, ["version", "savedAt", "providers"], "Persisted model catalog");
    if (input.version !== SNAPSHOT_VERSION) throw new CatalogValidationError("Persisted model catalog version is unsupported");
    timestamp(input.savedAt, "Persisted model catalog savedAt");
    if (!Array.isArray(input.providers)) throw new CatalogValidationError("Persisted model catalog providers must be an array");
    if (input.providers.length > this.#maxProviders) {
      throw new CatalogValidationError(`Persisted model catalog exceeds ${this.#maxProviders} providers`);
    }
    const result = new Map<ProviderId, CatalogRecord>();
    let firstError: CatalogValidationError | undefined;
    for (const raw of input.providers) {
      try {
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
          throw new CatalogValidationError("Persisted model catalog provider entry must be an object");
        }
        const entry = raw as Record<string, unknown>;
        exactKeys(entry, ["provider", "provenance", "fetchedAt", "models"], "Persisted model catalog provider entry");
        const provider = boundedString(entry.provider, MAX_PROVIDER_ID_BYTES, "Persisted provider ID") as ProviderId;
        if (entry.provenance !== "live" && entry.provenance !== "persisted") {
          throw new CatalogValidationError(`Persisted provenance for ${provider} is invalid`);
        }
        if (result.has(provider)) throw new CatalogValidationError(`Persisted provider ${provider} is duplicated`);
        const fetchedAt = timestamp(entry.fetchedAt, `Persisted fetchedAt for ${provider}`);
        const models = normalizeModels(entry.models, provider, new Date(fetchedAt).toISOString(), this.#maxModelsPerProvider, false);
        const modelIds = new Set(models.map((model) => model.id));
        const configuredAdditions = [...(this.#configuredModels.get(provider)?.keys() ?? [])]
          .filter((id) => !modelIds.has(id)).length;
        if (models.length + configuredAdditions > this.#maxModelsPerProvider) {
          throw new CatalogValidationError(
            `Provider ${provider} persisted catalog plus configured models exceeds ${this.#maxModelsPerProvider} models`,
          );
        }
        result.set(provider, { models, fetchedAt, provenance: "persisted" });
      } catch (error) {
        const selected = error instanceof CatalogValidationError
          ? error
          : new CatalogValidationError(error instanceof Error ? error.message : String(error));
        firstError ??= selected;
      }
    }
    return { records: result, ...(firstError === undefined ? {} : { error: firstError }) };
  }

  async #joinRefresh(provider: ProviderId, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    let active = this.#active.get(provider);
    if (active === undefined) {
      const controller = new AbortController();
      active = { controller, promise: Promise.resolve(), waiters: new Set(), settled: false };
      const operation = this.#runRefresh(provider, controller.signal).finally(() => {
        active!.settled = true;
        this.#active.delete(provider);
      });
      active.promise = operation;
      this.#active.set(provider, active);
      void operation.catch(() => undefined);
    }
    const token = Symbol(provider);
    active.waiters.add(token);
    try {
      await waitWithSignal(active.promise, signal);
    } finally {
      active.waiters.delete(token);
      if (!active.settled && active.waiters.size === 0) active.controller.abort(abortReason(signal));
    }
  }

  async #runRefresh(provider: ProviderId, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    try {
      const values = await this.get(provider).listModels(signal);
      signal.throwIfAborted();
      const fetchedAt = this.#now();
      const fetchedAtIso = new Date(fetchedAt).toISOString();
      let models = normalizeModels(values, provider, fetchedAtIso, this.#maxModelsPerProvider, true);
      const liveIds = new Set(models.map((model) => model.id));
      const previous = this.#catalogs.get(provider);
      const retained = this.#retained.get(provider);
      if (previous !== undefined && retained !== undefined) {
        const currentIds = new Set(models.map((model) => model.id));
        for (const model of previous.models) {
          if (retained.has(model.id) && !currentIds.has(model.id)) models.push(model);
        }
        models.sort((left, right) => left.id.localeCompare(right.id));
      }
      const configuredAdditions = [...(this.#configuredModels.get(provider)?.keys() ?? [])]
        .filter((id) => !liveIds.has(id)).length;
      if (models.length + configuredAdditions > this.#maxModelsPerProvider) {
        throw new CatalogValidationError(`Provider ${provider} catalog plus retained and configured models exceeds ${this.#maxModelsPerProvider} models`);
      }
      const record: CatalogRecord = { models, fetchedAt, provenance: "live", verifiedIds: liveIds };
      const prospective = new Map(this.#catalogs);
      prospective.set(provider, record);
      this.#serialize(prospective);
      this.#catalogs.set(provider, record);
      this.#errors.delete(provider);
      this.#forceRefresh.delete(provider);
      await this.#persist();
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      const category = error instanceof CatalogValidationError ? "validation" : "provider";
      this.#errors.set(provider, this.#catalogError(error, category));
      this.#forceRefresh.add(provider);
    }
  }

  async #persist(): Promise<void> {
    if (this.#store === undefined) return;
    let serialized: string;
    try {
      serialized = this.#serialize(this.#catalogs);
    } catch (error) {
      this.#persistenceError = this.#catalogError(error, "validation");
      return;
    }
    const operation = this.#writeTail.then(async () => await this.#store!.write(serialized));
    this.#writeTail = operation.catch(() => undefined);
    try {
      await operation;
      this.#persistenceError = undefined;
    } catch (error) {
      this.#persistenceError = this.#catalogError(error, "persistence");
    }
  }

  #serialize(records: ReadonlyMap<ProviderId, CatalogRecord>): string {
    const durableRecords = [...records.entries()].filter(([provider]) => this.#adapters.has(provider));
    if (durableRecords.length > this.#maxProviders) {
      throw new CatalogValidationError(`Model catalog exceeds ${this.#maxProviders} providers`);
    }
    const snapshot: PersistedSnapshot = {
      version: SNAPSHOT_VERSION,
      savedAt: new Date(this.#now()).toISOString(),
      providers: durableRecords
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([provider, record]) => ({
          provider,
          provenance: record.provenance,
          fetchedAt: new Date(record.fetchedAt).toISOString(),
          models: record.models.map(persistedModel),
        })),
    };
    const serialized = `${JSON.stringify(snapshot)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > this.#maxSnapshotBytes) {
      throw new CatalogValidationError(`Model catalog snapshot exceeds ${this.#maxSnapshotBytes} bytes`);
    }
    return serialized;
  }

  #stale(provider: ProviderId): boolean {
    const record = this.#catalogs.get(provider);
    if (record === undefined || this.#forceRefresh.has(provider) || this.#errors.has(provider)) return true;
    const now = this.#now();
    if (record.fetchedAt > now + 5 * 60_000) return true;
    return now - record.fetchedAt >= this.#cacheTtlMs;
  }

  #status(provider: ProviderId): ModelCatalogStatus {
    const record = this.#catalogs.get(provider);
    const error = this.#errors.get(provider) ?? this.#persistenceError;
    return {
      provider,
      provenance: record?.provenance ?? "none",
      ...(record === undefined ? {} : { fetchedAt: new Date(record.fetchedAt).toISOString() }),
      stale: this.#stale(provider),
      refreshing: this.#active.has(provider),
      modelCount: this.#effectiveModels(provider).length,
      ...(error === undefined ? {} : { error }),
    };
  }

  #catalogError(error: unknown, category: ModelCatalogError["category"]): ModelCatalogError {
    return { category, message: errorMessage(error), at: new Date(this.#now()).toISOString() };
  }

  #resolveProvider(query: string, fuzzy = true): { provider?: ProviderId; candidates: ProviderId[] } {
    const requested = boundedString(query, MAX_PROVIDER_ID_BYTES, "Provider reference");
    const providers = [...this.#adapters.keys()];
    if (providers.includes(requested)) return { provider: requested, candidates: [requested] };
    const folded = requested.toLocaleLowerCase("en-US");
    const insensitive = providers.filter((provider) => provider.toLocaleLowerCase("en-US") === folded);
    if (insensitive.length === 1) return { provider: insensitive[0]!, candidates: insensitive };
    if (insensitive.length > 1 || !fuzzy) return { candidates: insensitive };
    const candidates = providers
      .map((provider) => {
        const value = provider.toLocaleLowerCase("en-US");
        const score = value.startsWith(folded) ? value.length - folded.length : value.includes(folded) ? 100 + value.indexOf(folded) : undefined;
        return score === undefined ? undefined : { provider, score };
      })
      .filter((entry): entry is { provider: ProviderId; score: number } => entry !== undefined)
      .sort((left, right) => left.score - right.score || left.provider.localeCompare(right.provider));
    const matches = candidates.map((entry) => entry.provider);
    return matches.length === 1 ? { provider: matches[0]!, candidates: matches } : { candidates: matches };
  }

  #customModelSelection(
    reference: string,
    requestedProvider: ProviderId | undefined,
    explicitReasoningEffort: string | undefined,
  ): ResolvedModelSelection | undefined {
    let provider: ProviderId | undefined;
    let modelReference = reference;
    if (requestedProvider !== undefined) {
      provider = this.#resolveProvider(requestedProvider).provider;
      if (provider === undefined) return undefined;
      const prefix = [provider, requestedProvider]
        .find((value) => modelReference.toLocaleLowerCase("en-US").startsWith(`${value.toLocaleLowerCase("en-US")}/`));
      if (prefix !== undefined) {
        modelReference = modelReference.slice(prefix.length + 1);
      }
    } else {
      const slash = modelReference.indexOf("/");
      if (slash < 1) return undefined;
      const inferred = this.#resolveProvider(modelReference.slice(0, slash)).provider;
      if (inferred === undefined) return undefined;
      provider = inferred;
      modelReference = modelReference.slice(slash + 1);
    }
    const parsed = explicitReasoningEffort === undefined
      ? parseModelReasoningReference(modelReference)
      : { reference: modelReference, reasoningEffort: normalizeModelReasoningEffort(explicitReasoningEffort) };
    const model = boundedString(parsed.reference, MAX_MODEL_ID_BYTES, "Custom model ID");
    return {
      provider,
      model,
      match: "custom",
      ...(parsed.reasoningEffort === undefined ? {} : { reasoningEffort: parsed.reasoningEffort }),
    };
  }

  #resolveConfiguredReference(
    query: string,
    provider: ProviderId | undefined,
    explicitReasoningEffort: string | undefined,
  ): Omit<ModelReferenceResolution, "query"> {
    const providers = provider === undefined ? [...this.#configuredModels.keys()] : [provider];
    const models = providers.flatMap((providerId) => {
      const configured = this.#configuredModels.get(providerId);
      if (configured === undefined) return [];
      const catalog = new Map((this.#catalogs.get(providerId)?.models ?? []).map((model) => [model.id, model]));
      return [...configured.values()].map((configuration) =>
        applyConfiguredModel(configuration, catalog.get(configuration.id), this.#configuredObservedAt));
    });
    let result = this.#resolveExactModelId(query, models);
    if (explicitReasoningEffort !== undefined) {
      return result.match === "none"
        ? result
        : this.#applyReasoningEffort(result, normalizeModelReasoningEffort(explicitReasoningEffort));
    }
    if (result.match !== "none") return result;
    const parsed = parseModelReasoningReference(query);
    if (parsed.reasoningEffort === undefined) return result;
    result = this.#resolveExactModelId(parsed.reference, models);
    return result.match === "none" ? result : this.#applyReasoningEffort(result, parsed.reasoningEffort);
  }

  #resolveExactModelId(
    query: string,
    models: ModelInfo[],
  ): Omit<ModelReferenceResolution, "query"> {
    const folded = query.toLocaleLowerCase("en-US");
    const matches = (canonical: boolean, insensitive: boolean): ModelInfo[] => models.filter((model) => {
      const candidate = canonical ? `${model.provider}/${model.id}` : model.id;
      return insensitive ? candidate.toLocaleLowerCase("en-US") === folded : candidate === query;
    });
    for (const [canonical, insensitive] of [[true, false], [false, false], [true, true], [false, true]] as const) {
      const candidates = matches(canonical, insensitive);
      if (candidates.length === 1) return { match: "exact", model: candidates[0]!, candidates };
      if (candidates.length > 1) return { match: "ambiguous", candidates: candidates.slice(0, 10) };
    }
    return { match: "none", candidates: [] };
  }

  #resolveReferenceFromModels(
    query: string,
    models: ModelInfo[],
    provider: ProviderId | undefined,
    explicitReasoningEffort: string | undefined,
  ): Omit<ModelReferenceResolution, "query"> {
    const fullExact = this.#resolveFromModels(query, models, provider, false);
    if (explicitReasoningEffort !== undefined) {
      const result = fullExact.match === "none"
        ? this.#resolveFromModels(query, models, provider, true)
        : fullExact;
      return this.#applyReasoningEffort(result, normalizeModelReasoningEffort(explicitReasoningEffort));
    }
    if (fullExact.match !== "none") return fullExact;
    const parsed = parseModelReasoningReference(query);
    const result = this.#resolveFromModels(parsed.reference, models, provider, true);
    return parsed.reasoningEffort === undefined ? result : this.#applyReasoningEffort(result, parsed.reasoningEffort);
  }

  #applyReasoningEffort(
    result: Omit<ModelReferenceResolution, "query">,
    reasoningEffort: ModelReasoningEffort,
  ): Omit<ModelReferenceResolution, "query"> {
    if (result.model === undefined) return result;
    const supported = [...modelReasoningEfforts(result.model)];
    if (!supported.includes(reasoningEffort)) {
      return {
        match: "unsupported-thinking",
        candidates: [result.model],
        reasoningEffort,
        supportedReasoningEfforts: supported,
      };
    }
    return { ...result, reasoningEffort };
  }

  #resolveFromModels(
    query: string,
    models: ModelInfo[],
    provider: ProviderId | undefined,
    fuzzy: boolean,
  ): Omit<ModelReferenceResolution, "query"> {
    const folded = query.toLocaleLowerCase("en-US");
    const canonical = models.filter((model) => `${model.provider}/${model.id}` === query);
    if (canonical.length === 1) return { match: "exact", model: canonical[0]!, candidates: canonical };
    if (canonical.length > 1) return { match: "ambiguous", candidates: canonical.slice(0, 10) };
    const exact = models.filter((model) => model.id === query);
    if (exact.length === 1) return { match: "exact", model: exact[0]!, candidates: exact };
    if (exact.length > 1) return { match: "ambiguous", candidates: exact.slice(0, 10) };
    const insensitiveCanonical = models.filter(
      (model) => `${model.provider}/${model.id}`.toLocaleLowerCase("en-US") === folded,
    );
    if (insensitiveCanonical.length === 1) {
      return { match: "exact", model: insensitiveCanonical[0]!, candidates: insensitiveCanonical };
    }
    if (insensitiveCanonical.length > 1) return { match: "ambiguous", candidates: insensitiveCanonical.slice(0, 10) };
    const insensitive = models.filter((model) => model.id.toLocaleLowerCase("en-US") === folded);
    if (insensitive.length === 1) return { match: "exact", model: insensitive[0]!, candidates: insensitive };
    if (insensitive.length > 1) return { match: "ambiguous", candidates: insensitive.slice(0, 10) };
    const named = models.filter((model) => model.displayName?.toLocaleLowerCase("en-US") === folded);
    if (named.length === 1) return { match: "exact", model: named[0]!, candidates: named };
    if (named.length > 1) return { match: "ambiguous", candidates: named.slice(0, 10) };
    if (!fuzzy) return { match: "none", candidates: [] };
    const ranked = models
      .map((model) => {
        const score = fuzzyScore(provider === undefined ? query : `${provider}/${query}`, model)
          ?? fuzzyScore(query, model);
        return score === undefined ? undefined : { model, score };
      })
      .filter((entry): entry is { model: ModelInfo; score: number } => entry !== undefined)
      .sort(compareFuzzy);
    if (ranked.length === 0) return { match: "none", candidates: [] };
    const candidates = ranked.slice(0, 10).map((entry) => entry.model);
    return ranked.length === 1
      ? { match: "fuzzy", model: ranked[0]!.model, candidates }
      : { match: "ambiguous", candidates };
  }
}
