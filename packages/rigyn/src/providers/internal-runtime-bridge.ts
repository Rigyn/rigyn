import type {
  AdapterEvent,
  ModelInfo,
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
} from "../core/types.js";
import {
  getSupportedThinkingLevels,
  type Models,
  type Provider,
  type ProviderAuth,
  type ProviderModel,
  type ProviderModelThinkingLevel,
} from "./models.js";

const THINKING_LEVELS: readonly ProviderModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const legacyModelInfo = new WeakMap<ProviderModel, ModelInfo>();

/** Temporary internal bridge while the run loop still consumes ProviderAdapter. */
export function providerFromAdapter(
  adapter: ProviderAdapter,
  options: {
    name?: string;
    auth: ProviderAuth;
    baseUrl?: string;
    initialModels?: readonly ModelInfo[];
    model?: (info: ModelInfo) => ProviderModel;
    allowUnauthenticatedRefresh?: boolean;
  },
): Provider {
  const convert: (info: ModelInfo) => ProviderModel = options.model ?? ((info) => providerModelFromInfo(info));
  let models: ProviderModel[] = (options.initialModels ?? []).map(convert);
  return {
    id: adapter.id,
    name: options.name ?? adapter.id,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    auth: options.auth,
    getModels: () => models,
    async refreshModels(context) {
      const stored = await context.store.read();
      if (stored !== undefined) models = [...stored.models];
      if (!context.allowNetwork || context.signal?.aborted) return;
      if (context.credential === undefined && options.allowUnauthenticatedRefresh !== true) return;
      const refreshed = (await adapter.listModels(context.signal ?? new AbortController().signal)).map(convert);
      if (context.signal?.aborted) return;
      models = refreshed;
      await context.store.write({ models, checkedAt: Date.now() });
    },
    stream(model, context, streamOptions = {}) {
      return adapter.stream({
        provider: adapter.id,
        model: model.id,
        api: model.api,
        messages: context.messages,
        tools: context.tools ?? [],
        ...(context.providerState === undefined ? {} : { providerState: context.providerState }),
        ...(streamOptions.maxOutputTokens === undefined ? {} : { maxOutputTokens: streamOptions.maxOutputTokens }),
        ...(streamOptions.reasoningEffort === undefined ? {} : { reasoningEffort: streamOptions.reasoningEffort }),
        ...(streamOptions.thinkingBudgets === undefined ? {} : { thinkingBudgets: streamOptions.thinkingBudgets }),
        ...(streamOptions.sessionId === undefined ? {} : { sessionId: streamOptions.sessionId }),
        ...(streamOptions.metadata === undefined ? {} : { metadata: streamOptions.metadata }),
        ...(streamOptions.transport === undefined ? {} : { transport: streamOptions.transport }),
        ...(streamOptions.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: streamOptions.maxRetryDelayMs }),
        ...(streamOptions.onPayload === undefined ? {} : { onPayload: streamOptions.onPayload }),
        ...(streamOptions.onResponse === undefined ? {} : { onResponse: streamOptions.onResponse }),
      }, streamOptions.signal ?? new AbortController().signal);
    },
    streamSimple(model, context, streamOptions = {}) {
      return adapter.stream({
        provider: adapter.id,
        model: model.id,
        api: model.api,
        messages: context.messages,
        tools: context.tools ?? [],
        ...(context.providerState === undefined ? {} : { providerState: context.providerState }),
        ...(streamOptions.maxOutputTokens === undefined ? {} : { maxOutputTokens: streamOptions.maxOutputTokens }),
        ...(streamOptions.reasoningEffort === undefined ? {} : { reasoningEffort: streamOptions.reasoningEffort }),
        ...(streamOptions.thinkingBudgets === undefined ? {} : { thinkingBudgets: streamOptions.thinkingBudgets }),
        ...(streamOptions.sessionId === undefined ? {} : { sessionId: streamOptions.sessionId }),
        ...(streamOptions.metadata === undefined ? {} : { metadata: streamOptions.metadata }),
        ...(streamOptions.transport === undefined ? {} : { transport: streamOptions.transport }),
        ...(streamOptions.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: streamOptions.maxRetryDelayMs }),
        ...(streamOptions.onPayload === undefined ? {} : { onPayload: streamOptions.onPayload }),
        ...(streamOptions.onResponse === undefined ? {} : { onResponse: streamOptions.onResponse }),
      }, streamOptions.signal ?? new AbortController().signal);
    },
  };
}

export function providerModelToInfo(model: ProviderModel): ModelInfo {
  const preserved = legacyModelInfo.get(model);
  if (preserved !== undefined) return structuredClone(preserved);
  const observedAt = new Date().toISOString();
  const capability = (supported: boolean) => ({
    value: supported ? "supported" as const : "unsupported" as const,
    source: "configuration" as const,
    observedAt,
  });
  const reasoningEfforts = model.reasoning ? getSupportedThinkingLevels(model) : [];
  return {
    id: model.id,
    provider: model.provider,
    displayName: model.name,
    contextTokens: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    capabilities: {
      tools: capability(true),
      reasoning: capability(model.reasoning),
      images: capability(model.input.includes("image")),
    },
    compatibility: {
      protocolFamily: { value: model.api, source: "configuration", observedAt },
      inputModalities: { value: model.input, source: "configuration", observedAt },
      outputModalities: { value: ["text"], source: "configuration", observedAt },
      ...(reasoningEfforts.length === 0
        ? {}
        : { reasoningEfforts: { value: reasoningEfforts, source: "configuration", observedAt } }),
    },
    pricing: {
      currency: "USD",
      unit: "per_million_tokens",
      source: "configuration",
      observedAt,
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
    },
  };
}

export function providerAdapterFromModels(models: Models, providerId: ProviderId): ProviderAdapter {
  return {
    id: providerId,
    async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
      const model = models.getModel(providerId, request.model);
      if (model === undefined) {
        yield* errorStream(`Unknown model: ${providerId}/${request.model}`);
        return;
      }
      if (request.api !== undefined && request.api !== model.api) {
        yield* errorStream(`Model ${providerId}/${request.model} declares API ${model.api}, not ${request.api}`);
        return;
      }
      const requestedEffort = request.reasoningEffort as ProviderModelThinkingLevel | undefined;
      const mappedEffort = requestedEffort === undefined
        ? undefined
        : model.thinkingLevelMap?.[requestedEffort] ?? requestedEffort;
      yield* models.stream(model, {
        messages: request.messages,
        tools: request.tools,
        ...(request.providerState === undefined ? {} : { providerState: request.providerState }),
      }, {
        signal,
        ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
        ...(mappedEffort === undefined || mappedEffort === null ? {} : { reasoningEffort: mappedEffort }),
        ...(request.thinkingBudgets === undefined ? {} : { thinkingBudgets: request.thinkingBudgets }),
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
        ...(request.transport === undefined ? {} : { transport: request.transport }),
        ...(request.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: request.maxRetryDelayMs }),
        ...(request.onPayload === undefined ? {} : { onPayload: request.onPayload }),
        ...(request.onResponse === undefined ? {} : { onResponse: request.onResponse }),
        ...(request.modelSettings?.headers === undefined ? {} : { headers: request.modelSettings.headers }),
      });
    },
    async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
      signal.throwIfAborted();
      await models.refresh({ signal });
      signal.throwIfAborted();
      return [...await models.getAvailable(providerId)].map(providerModelToInfo);
    },
  };
}

export function providerModelFromInfo(
  info: ModelInfo,
  providerProtocol?: ProviderModel["api"],
): ProviderModel {
  const api = info.compatibility?.protocolFamily?.value ?? providerProtocol;
  if (api === undefined) throw new TypeError(`Model ${info.provider}/${info.id} does not declare an API protocol`);
  const reasoning = info.capabilities.reasoning.value === "supported";
  const reportedReasoningEfforts = reasoning ? info.compatibility?.reasoningEfforts?.value : undefined;
  const thinkingLevelMap = reportedReasoningEfforts === undefined
    ? undefined
    : (() => {
        const normalized = new Set(reportedReasoningEfforts.map((effort) => effort.trim().toLocaleLowerCase("en-US")));
        if (normalized.has("none")) normalized.add("off");
        return Object.fromEntries(THINKING_LEVELS.map((level) => [
          level,
          normalized.has(level) ? level : null,
        ])) as NonNullable<ProviderModel["thinkingLevelMap"]>;
      })();
  const model: ProviderModel = {
    id: info.id,
    name: info.displayName ?? info.id,
    api,
    provider: info.provider,
    baseUrl: "",
    reasoning,
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    input: info.capabilities.images.value === "supported" ? ["text", "image"] : ["text"],
    cost: {
      input: info.pricing?.input ?? 0,
      output: info.pricing?.output ?? 0,
      cacheRead: info.pricing?.cacheRead ?? 0,
      cacheWrite: info.pricing?.cacheWrite ?? 0,
    },
    contextWindow: info.contextTokens ?? 0,
    maxTokens: info.maxOutputTokens ?? 0,
  };
  legacyModelInfo.set(model, structuredClone(info));
  return model;
}

async function* errorStream(message: string): AsyncIterable<AdapterEvent> {
  yield {
    type: "error",
    error: {
      category: "provider",
      message,
      retryable: false,
      partial: false,
    },
  };
}
