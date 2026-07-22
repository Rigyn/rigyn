import { randomUUID } from "node:crypto";

import type {
  AdapterEvent,
  CanonicalMessage,
  ModelInfo,
  ModelProtocolFamily,
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  ProviderState,
} from "../core/types.js";
import { normalizeProviderModelCatalog } from "./registry.js";

const MAX_ROUTES = 20_000;
const MAX_PROVIDER_ID_BYTES = 128;
const MAX_MODEL_ID_BYTES = 512;
const PROTOCOL_FAMILIES = new Set<ModelProtocolFamily>([
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
  "gemini-generate-content",
  "gemini-interactions",
  "bedrock-converse",
  "mistral-conversations",
  "ollama-chat",
  "gateway-messages",
]);

export interface RoutedProviderRoute {
  /** Exact model ID exposed by the composed provider. */
  model: string;
  /** Explicit wire protocol used by this route. */
  protocolFamily: ModelProtocolFamily;
  /** Existing adapter configured with this route's endpoint and credentials. */
  adapter: ProviderAdapter;
  /** Exact model ID sent to the delegate. Defaults to `model`. */
  upstreamModel?: string;
  /**
   * Optional validated catalog metadata for endpoints without model discovery.
   * `id` and `provider` are rewritten to the public route identity.
   */
  modelInfo?: ModelInfo;
}

export interface RoutedProviderAdapterDefinition {
  id: ProviderId;
  routes: readonly RoutedProviderRoute[];
  /**
   * `owned` transfers delegate lifecycle to the routed adapter. `borrowed`
   * leaves disposal with the caller so delegates may be shared safely.
   */
  delegateOwnership: "owned" | "borrowed";
}

interface NormalizedRoute {
  model: string;
  upstreamModel: string;
  protocolFamily: ModelProtocolFamily;
  adapter: ProviderAdapter;
  modelInfo?: ModelInfo;
  stateScope: string;
}

function providerId(value: unknown, label: string): ProviderId {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_PROVIDER_ID_BYTES
  ) {
    throw new TypeError(`${label} must be an exact non-empty provider ID without surrounding whitespace or control characters and no larger than ${MAX_PROVIDER_ID_BYTES} bytes`);
  }
  return value;
}

function modelId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_MODEL_ID_BYTES
  ) {
    throw new TypeError(`${label} must be an exact non-empty model ID without surrounding whitespace or control characters and no larger than ${MAX_MODEL_ID_BYTES} bytes`);
  }
  return value;
}

function normalizeRoutes(definition: RoutedProviderAdapterDefinition): Map<string, NormalizedRoute> {
  if (!Array.isArray(definition.routes) || definition.routes.length === 0 || definition.routes.length > MAX_ROUTES) {
    throw new TypeError(`Routed provider ${definition.id} must define 1 through ${MAX_ROUTES} routes`);
  }
  const routes = new Map<string, NormalizedRoute>();
  for (const [index, route] of definition.routes.entries()) {
    if (route === null || typeof route !== "object") {
      throw new TypeError(`Routed provider ${definition.id} route ${index} must be an object`);
    }
    if (
      route.adapter === null ||
      typeof route.adapter !== "object" ||
      typeof route.adapter.stream !== "function" ||
      typeof route.adapter.listModels !== "function"
    ) {
      throw new TypeError(`Routed provider ${definition.id} route ${index} has an invalid adapter`);
    }
    providerId(route.adapter.id, `Routed provider ${definition.id} route ${index} adapter ID`);
    const model = modelId(route.model, `Routed provider ${definition.id} route ${index} model`);
    if (routes.has(model)) {
      throw new TypeError(`Routed provider ${definition.id} has ambiguous routes for model ${model}`);
    }
    if (!PROTOCOL_FAMILIES.has(route.protocolFamily)) {
      throw new TypeError(`Routed provider ${definition.id} route ${index} has an invalid protocol family`);
    }
    routes.set(model, {
      model,
      upstreamModel: modelId(
        route.upstreamModel ?? model,
        `Routed provider ${definition.id} route ${index} upstream model`,
      ),
      protocolFamily: route.protocolFamily,
      adapter: route.adapter,
      ...(route.modelInfo === undefined ? {} : { modelInfo: structuredClone(route.modelInfo) }),
      stateScope: randomUUID(),
    });
  }
  return routes;
}

function stateMatchesProtocol(state: ProviderState, protocol: ModelProtocolFamily): boolean {
  switch (protocol) {
    case "openai-responses":
      return state.kind === "openai_responses";
    case "openai-chat-completions":
      return state.kind === "chat_completions" || state.kind === "openrouter_chat";
    case "anthropic-messages":
      return state.kind === "anthropic_messages";
    case "gemini-generate-content":
      return state.kind === "gemini_generate_content";
    case "gemini-interactions":
      return state.kind === "gemini_interactions";
    case "bedrock-converse":
      return state.kind === "bedrock_converse";
    case "mistral-conversations":
      return state.kind === "mistral_chat";
    case "ollama-chat":
      return state.kind === "ollama_chat";
    case "gateway-messages":
      return state.kind === "gateway_messages";
  }
}

function delegatedMessages(
  messages: CanonicalMessage[],
  provider: ProviderId,
  delegate: ProviderId,
): CanonicalMessage[] {
  if (provider === delegate) return messages;
  return messages.map((message) => {
    let changed = false;
    const content = message.content.map((block) => {
      if (block.type !== "provider_opaque" || block.provider !== provider) return block;
      changed = true;
      return { ...block, provider: delegate };
    });
    return changed ? { ...message, content } : message;
  });
}

function delegatedRequest(
  request: ProviderRequest,
  route: NormalizedRoute,
): ProviderRequest {
  const origin = request.providerState?.routed;
  let compatibleState: ProviderState | undefined;
  if (
    request.providerState !== undefined &&
    origin?.provider === request.provider &&
    origin.model === route.model &&
    origin.delegate === route.adapter.id &&
    origin.upstreamModel === route.upstreamModel &&
    origin.protocolFamily === route.protocolFamily &&
    origin.scope === route.stateScope &&
    stateMatchesProtocol(request.providerState, route.protocolFamily)
  ) {
    const { routed: _routed, ...nativeState } = request.providerState;
    compatibleState = nativeState as ProviderState;
  }
  const delegated: ProviderRequest = {
    ...request,
    provider: route.adapter.id,
    model: route.upstreamModel,
    messages: delegatedMessages(request.messages, request.provider, route.adapter.id),
  };
  if (compatibleState === undefined) delete delegated.providerState;
  else delegated.providerState = compatibleState;
  return delegated;
}

function publicEvent(event: AdapterEvent, provider: ProviderId, route: NormalizedRoute): AdapterEvent {
  if (event.type === "response_start") return { ...event, model: route.model };
  if (event.type === "unknown_provider_event") return { ...event, provider };
  if (event.type === "response_end") {
    return {
      ...event,
      state: {
        ...event.state,
        routed: {
          provider,
          model: route.model,
          delegate: route.adapter.id,
          upstreamModel: route.upstreamModel,
          protocolFamily: route.protocolFamily,
          scope: route.stateScope,
        },
      },
    };
  }
  return event;
}

function publicModel(model: ModelInfo, route: NormalizedRoute, provider: ProviderId, observedAt: string): ModelInfo {
  const declared = model.compatibility?.protocolFamily;
  if (declared !== undefined && declared.value !== route.protocolFamily) {
    throw new TypeError(
      `Routed provider ${provider} model ${route.model} declares ${route.protocolFamily} but delegate ${route.adapter.id}/${route.upstreamModel} advertises ${declared.value}`,
    );
  }
  return {
    ...model,
    id: route.model,
    provider,
    compatibility: {
      ...(model.compatibility ?? {}),
      protocolFamily: declared ?? {
        value: route.protocolFamily,
        source: "configuration",
        observedAt,
      },
    },
  };
}

/**
 * Composes existing adapters behind one provider ID using exact per-model routes.
 * Delegate adapters retain authentication, transport, and wire-state behavior;
 * lifecycle ownership is the explicit `delegateOwnership` policy.
 */
export function defineRoutedProviderAdapter(definition: RoutedProviderAdapterDefinition): ProviderAdapter {
  const id = providerId(definition.id, "Routed provider ID");
  if (definition.delegateOwnership !== "owned" && definition.delegateOwnership !== "borrowed") {
    throw new TypeError(`Routed provider ${id} delegateOwnership must be owned or borrowed`);
  }
  const routes = normalizeRoutes(definition);
  const delegates = [...new Set([...routes.values()].map((route) => route.adapter))];
  let disposal: Promise<void> | undefined;
  const adapter: ProviderAdapter = {
    id,
    async *stream(request, signal) {
      signal.throwIfAborted();
      if (request.provider !== id) {
        throw new Error(`Provider ${id} cannot serve a request for ${request.provider}`);
      }
      const route = routes.get(request.model);
      if (route === undefined) {
        throw new Error(`Routed provider ${id} has no explicit route for model ${request.model}`);
      }
      for await (const event of route.adapter.stream(delegatedRequest(request, route), signal)) {
        signal.throwIfAborted();
        yield publicEvent(event, id, route);
      }
    },
    async listModels(signal) {
      signal.throwIfAborted();
      const catalogs = new Map<ProviderAdapter, Map<string, ModelInfo>>();
      const discoverableDelegates = delegates.filter((delegate) =>
        [...routes.values()].some((route) => route.adapter === delegate && route.modelInfo === undefined));
      await Promise.all(discoverableDelegates.map(async (adapter) => {
        const models = await adapter.listModels(signal);
        signal.throwIfAborted();
        catalogs.set(adapter, new Map(models.map((model) => [model.id, model])));
      }));
      const observedAt = new Date().toISOString();
      const models = [...routes.values()].map((route) => {
        const model = route.modelInfo ?? catalogs.get(route.adapter)?.get(route.upstreamModel);
        if (model === undefined) {
          throw new Error(
            `Routed provider ${id} delegate ${route.adapter.id} did not advertise model ${route.upstreamModel}`,
          );
        }
        return publicModel(model, route, id, observedAt);
      });
      return normalizeProviderModelCatalog(models, id, observedAt);
    },
  };
  if (definition.delegateOwnership === "owned") {
    adapter.dispose = async () => {
      disposal ??= Promise.all(delegates.map(async (delegate) => await delegate.dispose?.())).then(() => undefined);
      await disposal;
    };
  }
  return adapter;
}
