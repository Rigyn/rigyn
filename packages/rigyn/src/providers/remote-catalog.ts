import type { Api } from "@rigyn/models";

import type { ModelProtocolFamily } from "../core/types.js";
import { protocolFromPublicApi } from "../extensions/model-boundary.js";
import { RIGYN_VERSION } from "../version.js";
import type { Provider, ProviderModel, ProviderRefreshContext } from "./models.js";

const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1_000;
const INTERNAL_PROTOCOLS = new Set<ModelProtocolFamily>([
  "anthropic-messages",
  "bedrock-converse",
  "gateway-messages",
  "gemini-generate-content",
  "gemini-interactions",
  "mistral-conversations",
  "ollama-chat",
  "openai-chat-completions",
  "openai-responses",
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`Remote model ${name} must be a finite non-negative number`);
  }
  return value;
}

function protocol(value: unknown): ModelProtocolFamily {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError("Remote model API must be a non-empty string");
  return INTERNAL_PROTOCOLS.has(value as ModelProtocolFamily)
    ? value as ModelProtocolFamily
    : protocolFromPublicApi(value as Api);
}

function modelFromCatalog(provider: Provider, value: unknown): ProviderModel {
  if (!record(value) || typeof value.id !== "string" || value.id.trim() === "") {
    throw new TypeError(`Remote model catalog for ${provider.id} contains an invalid model`);
  }
  const existing = provider.getModels().find((model) => model.id === value.id);
  const baseUrl = typeof value.baseUrl === "string" && value.baseUrl.trim() !== ""
    ? value.baseUrl
    : existing?.baseUrl ?? provider.baseUrl;
  if (baseUrl === undefined) throw new TypeError(`Remote model ${provider.id}/${value.id} is missing baseUrl`);
  const input = Array.isArray(value.input)
    ? value.input.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image")
    : existing?.input;
  if (input === undefined || input.length === 0) throw new TypeError(`Remote model ${provider.id}/${value.id} is missing input modes`);
  const cost = record(value.cost) ? value.cost : existing?.cost;
  if (cost === undefined) throw new TypeError(`Remote model ${provider.id}/${value.id} is missing cost metadata`);
  return {
    id: value.id,
    name: typeof value.name === "string" && value.name.trim() !== "" ? value.name : existing?.name ?? value.id,
    api: protocol(value.api ?? existing?.api),
    provider: provider.id,
    baseUrl,
    reasoning: typeof value.reasoning === "boolean" ? value.reasoning : existing?.reasoning ?? false,
    input,
    cost: {
      input: finite(cost.input, "input cost"),
      output: finite(cost.output, "output cost"),
      cacheRead: finite(cost.cacheRead, "cache-read cost"),
      cacheWrite: finite(cost.cacheWrite, "cache-write cost"),
      ...(Array.isArray(cost.tiers) ? { tiers: structuredClone(cost.tiers) as NonNullable<ProviderModel["cost"]["tiers"]> } : {}),
    },
    contextWindow: finite(value.contextWindow ?? existing?.contextWindow, "context window"),
    maxTokens: finite(value.maxTokens ?? existing?.maxTokens, "maximum output tokens"),
    ...(record(value.thinkingLevelMap) ? { thinkingLevelMap: structuredClone(value.thinkingLevelMap) as NonNullable<ProviderModel["thinkingLevelMap"]> } : {}),
    ...(record(value.headers) ? { headers: Object.fromEntries(Object.entries(value.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")) } : {}),
    ...(record(value.compat) ? { compat: structuredClone(value.compat) as NonNullable<ProviderModel["compat"]> } : {}),
  };
}

function catalogEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (record(value) && Array.isArray(value.models)) return value.models;
  if (record(value)) return Object.values(value);
  throw new TypeError("Remote model catalog response must contain models");
}

function mergeModels(baseline: readonly ProviderModel[], overlay: readonly ProviderModel[]): ProviderModel[] {
  const merged = [...baseline];
  for (const model of overlay) {
    const index = merged.findIndex((entry) => entry.id === model.id);
    if (index < 0) merged.push(model);
    else merged[index] = model;
  }
  return merged;
}

/** Add an explicitly configured, persisted HTTP catalog overlay to a provider. */
export function withRemoteCatalog(provider: Provider, catalogBaseUrl: string): Provider {
  let overlay: readonly ProviderModel[] = [];
  let active: Promise<void> | undefined;
  return {
    ...provider,
    getModels: () => mergeModels(provider.getModels(), overlay),
    refreshModels(context: ProviderRefreshContext) {
      active ??= (async () => {
        try {
          const stored = await context.store.read();
          if (stored !== undefined) overlay = stored.models.filter((model) => model.provider === provider.id);
          if (!context.allowNetwork || context.signal?.aborted) return;
          if (!context.force && stored?.checkedAt !== undefined && Date.now() - stored.checkedAt < REFRESH_INTERVAL_MS) return;
          const url = new URL(`/api/models/providers/${encodeURIComponent(provider.id)}`, catalogBaseUrl);
          const response = await fetch(url, {
            headers: { accept: "application/json", "user-agent": `rigyn/${RIGYN_VERSION}` },
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          });
          if (context.signal?.aborted) return;
          const checkedAt = Date.now();
          if (response.status === 404 || response.status === 501) {
            await context.store.write({ models: overlay, checkedAt });
            return;
          }
          if (!response.ok) {
            await context.store.write({ models: overlay, checkedAt });
            throw new Error(`Remote model catalog request failed for ${provider.id}: ${response.status}`);
          }
          const next = catalogEntries(await response.json()).map((entry) => modelFromCatalog(provider, entry));
          if (context.signal?.aborted) return;
          overlay = next;
          await context.store.write({ models: next, checkedAt });
        } finally {
          active = undefined;
        }
      })();
      return active;
    },
  };
}
