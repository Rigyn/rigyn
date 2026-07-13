import type {
  AdapterEvent,
  CapabilityValue,
  ModelCapability,
  ModelInfo,
  ModelMetadataSource,
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
} from "../core/types.js";
import { normalizeProviderModelCatalog } from "./registry.js";

export type ProviderModelCapability = boolean | CapabilityValue | ModelCapability;

export type ProviderModelDefinition = Omit<ModelInfo, "provider" | "capabilities"> & {
  provider?: never;
  capabilities?: {
    tools?: ProviderModelCapability;
    reasoning?: ProviderModelCapability;
    images?: ProviderModelCapability;
  };
};

export interface ProviderAdapterDefinition {
  id: ProviderId;
  models:
    | readonly ProviderModelDefinition[]
    | ((signal: AbortSignal) =>
        readonly ProviderModelDefinition[] | Promise<readonly ProviderModelDefinition[]>);
  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent>;
  /** Evidence source used only for shorthand boolean/string capabilities. */
  modelSource?: ModelMetadataSource;
  /** Defaults to the time each catalog result is observed. */
  observedAt?: string | (() => string);
  dispose?(): Promise<void> | void;
}

function capability(
  value: ProviderModelCapability | undefined,
  source: ModelMetadataSource,
  observedAt: string,
): ModelCapability {
  if (value !== null && typeof value === "object") return structuredClone(value);
  return {
    value: typeof value === "boolean" ? (value ? "supported" : "unsupported") : value ?? "unknown",
    source,
    observedAt,
  };
}

function canonicalModel(
  value: ProviderModelDefinition,
  provider: ProviderId,
  source: ModelMetadataSource,
  observedAt: string,
): ModelInfo {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Provider ${provider} returned a non-object model definition`);
  }
  const { capabilities, ...metadata } = value;
  return {
    ...metadata,
    provider,
    capabilities: {
      tools: capability(capabilities?.tools, source, observedAt),
      reasoning: capability(capabilities?.reasoning, source, observedAt),
      images: capability(capabilities?.images, source, observedAt),
    },
  };
}

/**
 * Builds a canonical provider adapter without taking ownership of wire format or
 * authentication. The authored `stream` callback remains the only wire adapter;
 * runtime credentials stay behind `api.auth.fetch`.
 */
export function defineProviderAdapter(definition: ProviderAdapterDefinition): ProviderAdapter {
  const { id, models, stream, dispose } = definition;
  const observation = definition.observedAt;
  const observedAt = (): string =>
    typeof observation === "function"
      ? observation()
      : observation ?? new Date().toISOString();
  const source = definition.modelSource ?? "provider";
  return {
    id,
    async *stream(request, signal) {
      signal.throwIfAborted();
      if (request.provider !== id) {
        throw new Error(`Provider ${id} cannot serve a request for ${request.provider}`);
      }
      for await (const event of stream(request, signal)) {
        signal.throwIfAborted();
        yield event;
      }
    },
    async listModels(signal) {
      signal.throwIfAborted();
      const values = typeof models === "function" ? await models(signal) : models;
      signal.throwIfAborted();
      const time = observedAt();
      const canonical = values.map((value) => canonicalModel(value, id, source, time));
      return normalizeProviderModelCatalog(canonical, id, time);
    },
    ...(dispose === undefined ? {} : { dispose }),
  };
}
