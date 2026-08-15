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

const TOKEN_PRICE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
type TokenPriceField = typeof TOKEN_PRICE_FIELDS[number];

const sourceModelInfo = new WeakMap<ProviderModel, ModelInfo>();

function projectTokenPrices(
  source: Partial<Record<TokenPriceField, number>> | undefined,
): Record<TokenPriceField, number> {
  const projected = {} as Record<TokenPriceField, number>;
  for (const field of TOKEN_PRICE_FIELDS) projected[field] = source?.[field] ?? 0;
  return projected;
}

/**
 * Maps the product adapter boundary into the direct model runtime without
 * allowing request credentials to enter the canonical ProviderRequest.
 */
export function providerFromAdapter(
  adapter: ProviderAdapter,
  options: {
    name?: string;
    auth: ProviderAuth;
    baseUrl?: string;
    initialModels?: readonly ModelInfo[];
    model?: (info: ModelInfo) => ProviderModel;
    allowUnauthenticatedRefresh?: boolean;
    listModels?(signal: AbortSignal): Promise<readonly ModelInfo[]>;
    streamRequest?(
      request: ProviderRequest,
      streamOptions: import("./models.js").ProviderStreamOptions,
      signal: AbortSignal,
      model: ProviderModel,
    ): AsyncIterable<AdapterEvent>;
  },
): Provider {
  const convert: (info: ModelInfo) => ProviderModel = options.model ?? ((info) => providerModelFromInfo(info));
  const baseline = (options.initialModels ?? []).map(convert);
  let models: ProviderModel[] = [...baseline];
  const request = (
    model: ProviderModel,
    context: import("./models.js").ProviderStreamContext,
    streamOptions: import("./models.js").ProviderStreamOptions,
  ): ProviderRequest => ({
    provider: adapter.id,
    model: model.id,
    api: model.api,
    messages: context.messages,
    tools: context.tools ?? [],
    ...(streamOptions.toolChoice === undefined ? {} : { toolChoice: streamOptions.toolChoice }),
    ...(streamOptions.temperature === undefined ? {} : { temperature: streamOptions.temperature }),
    ...(streamOptions.cacheRetention === undefined ? {} : { cacheRetention: streamOptions.cacheRetention }),
    ...(context.providerState === undefined ? {} : { providerState: context.providerState }),
    ...(streamOptions.maxOutputTokens === undefined ? {} : { maxOutputTokens: streamOptions.maxOutputTokens }),
    ...(streamOptions.reasoningEffort === undefined ? {} : { reasoningEffort: streamOptions.reasoningEffort }),
    ...(streamOptions.thinkingBudgets === undefined ? {} : { thinkingBudgets: streamOptions.thinkingBudgets }),
    ...(streamOptions.sessionId === undefined ? {} : { sessionId: streamOptions.sessionId }),
    ...(streamOptions.metadata === undefined ? {} : { metadata: streamOptions.metadata }),
    ...(streamOptions.transport === undefined ? {} : { transport: streamOptions.transport }),
    ...(streamOptions.timeoutMs === undefined ? {} : { timeoutMs: streamOptions.timeoutMs }),
    ...(streamOptions.maxRetries === undefined ? {} : { maxRetries: streamOptions.maxRetries }),
    ...(streamOptions.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: streamOptions.maxRetryDelayMs }),
    ...(streamOptions.onPayload === undefined ? {} : { onPayload: streamOptions.onPayload }),
    ...(streamOptions.onResponse === undefined ? {} : { onResponse: streamOptions.onResponse }),
    ...(
      model.name === model.id && model.compat === undefined && model.headers === undefined &&
      model.thinkingLevelMap === undefined
      ? {}
      : {
          modelSettings: {
            ...(model.name === model.id ? {} : { displayName: model.name }),
            ...(model.headers === undefined ? {} : { headers: structuredClone(model.headers) }),
            ...(model.thinkingLevelMap === undefined
              ? {}
              : { reasoningEffortMap: structuredClone(model.thinkingLevelMap) }),
            ...(model.compat === undefined ? {} : { compatibility: structuredClone(model.compat) }),
          },
        }),
  });
  const stream = (
    model: ProviderModel,
    context: import("./models.js").ProviderStreamContext,
    streamOptions: import("./models.js").ProviderStreamOptions,
  ): AsyncIterable<AdapterEvent> => {
    const signal = streamOptions.signal ?? new AbortController().signal;
    const selected = request(model, context, streamOptions);
    return options.streamRequest === undefined
      ? adapter.stream(selected, signal)
      : options.streamRequest(selected, streamOptions, signal, model);
  };
  return {
    id: adapter.id,
    name: options.name ?? adapter.id,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    auth: options.auth,
    getModels: () => models,
    async refreshModels(context) {
      models = [...baseline];
      const stored = await context.store.read();
      if (stored !== undefined) models = [...stored.models];
      if (!context.allowNetwork || context.signal?.aborted) return;
      if (context.credential === undefined && options.allowUnauthenticatedRefresh !== true) return;
      const signal = context.signal ?? new AbortController().signal;
      const refreshed = (await (options.listModels ?? adapter.listModels.bind(adapter))(signal)).map(convert);
      if (context.signal?.aborted) return;
      models = refreshed;
      if (models.every((model) =>
        Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0 &&
        Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0)) {
        await context.store.write({ models, checkedAt: Date.now() });
      }
    },
    stream(model, context, streamOptions = {}) {
      return stream(model, context, streamOptions);
    },
    streamSimple(model, context, streamOptions = {}) {
      return stream(model, context, streamOptions);
    },
  };
}

export function providerModelToInfo(model: ProviderModel): ModelInfo {
  const preserved = sourceModelInfo.get(model);
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
    ...(model.maxInputTokens === undefined ? {} : { maxInputTokens: model.maxInputTokens }),
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
      ...projectTokenPrices(model.cost),
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
      const reasoningEffortMap = request.modelSettings?.reasoningEffortMap ?? model.thinkingLevelMap;
      const mappedEffort = requestedEffort === undefined
        ? undefined
        : Object.hasOwn(reasoningEffortMap ?? {}, requestedEffort)
          ? reasoningEffortMap?.[requestedEffort]
          : requestedEffort;
      const wireEffort = model.api === "openai-responses" && mappedEffort === "off"
        ? "none"
        : mappedEffort;
      const requestModel = request.modelSettings === undefined
        ? model
        : {
            ...model,
            ...(request.modelSettings.displayName === undefined
              ? {}
              : { name: request.modelSettings.displayName }),
            ...(request.modelSettings.reasoningEffortMap === undefined
              ? {}
              : { thinkingLevelMap: structuredClone(request.modelSettings.reasoningEffortMap) }),
            ...(request.modelSettings.compatibility === undefined
              ? {}
              : { compat: structuredClone(request.modelSettings.compatibility) }),
          };
      yield* models.stream(requestModel, {
        messages: request.messages,
        tools: request.tools,
        ...(request.providerState === undefined ? {} : { providerState: request.providerState }),
      }, {
        signal,
        ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
        ...(wireEffort === undefined || wireEffort === null ? {} : { reasoningEffort: wireEffort }),
        ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.cacheRetention === undefined ? {} : { cacheRetention: request.cacheRetention }),
        ...(request.thinkingBudgets === undefined ? {} : { thinkingBudgets: request.thinkingBudgets }),
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
        ...(request.transport === undefined ? {} : { transport: request.transport }),
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        ...(request.maxRetries === undefined ? {} : { maxRetries: request.maxRetries }),
        ...(request.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: request.maxRetryDelayMs }),
        ...(request.onPayload === undefined ? {} : { onPayload: request.onPayload }),
        ...(request.onResponse === undefined ? {} : { onResponse: request.onResponse }),
        ...(request.modelSettings?.headers === undefined ? {} : { headers: request.modelSettings.headers }),
      });
    },
    async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
      signal.throwIfAborted();
      await models.refreshProvider(providerId, { signal });
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
  const reportedReasoningEfforts = info.capabilities.reasoning.value === "unsupported"
    ? undefined
    : info.compatibility?.reasoningEfforts?.value;
  const reasoning = info.capabilities.reasoning.value === "supported" ||
    reportedReasoningEfforts?.some((effort) => !["off", "none"].includes(effort.trim().toLocaleLowerCase("en-US"))) === true;
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
    cost: projectTokenPrices(info.pricing),
    contextWindow: info.contextTokens ?? 0,
    ...(info.maxInputTokens === undefined ? {} : { maxInputTokens: info.maxInputTokens }),
    maxTokens: info.maxOutputTokens ?? 0,
  };
  sourceModelInfo.set(model, structuredClone(info));
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
