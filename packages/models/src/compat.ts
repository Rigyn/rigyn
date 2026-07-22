export * from "./api/anthropic-messages.lazy.js";
export * from "./api/azure-openai-responses.lazy.js";
export * from "./api/bedrock-converse-stream.lazy.js";
export * from "./api/google-generative-ai.lazy.js";
export * from "./api/google-vertex.lazy.js";
export * from "./api/mistral-conversations.lazy.js";
export * from "./api/openai-codex-responses.lazy.js";
export * from "./api/openai-completions.lazy.js";
export * from "./api/openai-responses.lazy.js";
export * from "./api/rigyn-messages.lazy.js";
export * from "./env-api-keys.js";
export * from "./image-models.generated.js";
export * from "./image-models.js";
export * from "./images.js";
export * from "./images-api-registry.js";
export * from "./index.js";
export * from "./legacy-api-aliases.js";
export * from "./providers/all.js";

import { anthropicMessagesApi } from "./api/anthropic-messages.lazy.js";
import { azureOpenAIResponsesApi } from "./api/azure-openai-responses.lazy.js";
import { bedrockConverseStreamApi } from "./api/bedrock-converse-stream.lazy.js";
import { googleGenerativeAIApi } from "./api/google-generative-ai.lazy.js";
import { googleVertexApi } from "./api/google-vertex.lazy.js";
import { mistralConversationsApi } from "./api/mistral-conversations.lazy.js";
import { openAICodexResponsesApi } from "./api/openai-codex-responses.lazy.js";
import { openAICompletionsApi } from "./api/openai-completions.lazy.js";
import { openAIResponsesApi } from "./api/openai-responses.lazy.js";
import { rigynMessagesApi } from "./api/rigyn-messages.lazy.js";
import { getEnvApiKey } from "./env-api-keys.js";
import { type RegisterFauxProviderOptions, createFauxCore, type FauxProviderRegistration } from "./providers/faux.js";
import { builtinModels, getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "./providers/all.js";
import type { Api, ApiStreamOptions, AssistantMessage, AssistantMessageEventStream, Context, Model, ProviderStreamOptions, ProviderStreams, SimpleStreamOptions, StreamFunction, StreamOptions } from "./types.js";

export const getModel = getBuiltinModel;
export const getModels = getBuiltinModels;
export const getProviders = getBuiltinProviders;

export interface ApiProvider<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> {
  api: TApi;
  stream: StreamFunction<TApi, TOptions>;
  streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}
interface InternalApiProvider { api: Api; stream: StreamFunction; streamSimple: StreamFunction<Api, SimpleStreamOptions>; }
interface RegisteredApiProvider { provider: InternalApiProvider; sourceId?: string; }
const registry = new Map<string, RegisteredApiProvider>();

export function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(provider: ApiProvider<TApi, TOptions>, sourceId?: string): void {
  registry.set(provider.api, { provider: {
    api: provider.api,
    stream(model, context, options) { if (model.api !== provider.api) throw new Error(`Mismatched API: ${model.api}; expected ${provider.api}`); return provider.stream(model as Model<TApi>, context, options as TOptions); },
    streamSimple(model, context, options) { if (model.api !== provider.api) throw new Error(`Mismatched API: ${model.api}; expected ${provider.api}`); return provider.streamSimple(model as Model<TApi>, context, options); },
  }, ...(sourceId === undefined ? {} : { sourceId }) });
}
export function getApiProvider(api: Api): InternalApiProvider | undefined { return registry.get(api)?.provider; }
export function getApiProviders(): readonly InternalApiProvider[] { return [...registry.values()].map((entry) => entry.provider); }
export function unregisterApiProviders(sourceId: string): void { for (const [api, entry] of registry) if (entry.sourceId === sourceId) registry.delete(api); }

const BUILTINS: readonly [Api, ProviderStreams][] = [
  ["anthropic-messages", anthropicMessagesApi()], ["azure-openai-responses", azureOpenAIResponsesApi()],
  ["bedrock-converse-stream", bedrockConverseStreamApi()], ["google-generative-ai", googleGenerativeAIApi()],
  ["google-vertex", googleVertexApi()], ["mistral-conversations", mistralConversationsApi()],
  ["openai-codex-responses", openAICodexResponsesApi()], ["openai-completions", openAICompletionsApi()],
  ["openai-responses", openAIResponsesApi()], ["rigyn-messages", rigynMessagesApi()],
];
const builtinInstances = new Map<Api, InternalApiProvider | undefined>();
export function registerBuiltInApiProviders(): void {
  for (const [api, implementation] of BUILTINS) {
    if (!getApiProvider(api)) registerApiProvider({ api, stream: implementation.stream, streamSimple: implementation.streamSimple });
    builtinInstances.set(api, getApiProvider(api));
  }
}
export function resetApiProviders(): void { registry.clear(); builtinInstances.clear(); registerBuiltInApiProviders(); }
registerBuiltInApiProviders();

const compatibleModels = builtinModels();
function explicit(value: string | undefined): value is string { return typeof value === "string" && value.trim().length > 0; }
function withEnvironment<T extends StreamOptions>(model: Model<Api>, options: T | undefined): T | undefined {
  if (explicit(options?.apiKey)) return options;
  const value = getEnvApiKey(model.provider, options?.env);
  return !value || value === "<authenticated>" ? options : { ...options, apiKey: value } as T;
}
function builtinFor(model: Model<Api>) {
  if (getApiProvider(model.api) !== builtinInstances.get(model.api)) return undefined;
  const provider = compatibleModels.getProvider(model.provider);
  return provider?.getModels().some((candidate) => candidate.api === model.api) ? provider : undefined;
}
function implementation(api: Api): InternalApiProvider { const provider = getApiProvider(api); if (!provider) throw new Error(`No API provider registered for ${api}`); return provider; }

export function stream<TApi extends Api>(model: Model<TApi>, context: Context, options?: ProviderStreamOptions): AssistantMessageEventStream {
  const provider = builtinFor(model);
  return provider ? provider.stream(model, context, withEnvironment(model, options) as ApiStreamOptions<TApi> | undefined) : implementation(model.api).stream(model, context, withEnvironment(model, options));
}
export async function complete<TApi extends Api>(model: Model<TApi>, context: Context, options?: ProviderStreamOptions): Promise<AssistantMessage> { return stream(model, context, options).result(); }
export function streamSimple<TApi extends Api>(model: Model<TApi>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const provider = builtinFor(model);
  return provider ? provider.streamSimple(model, context, withEnvironment(model, options)) : implementation(model.api).streamSimple(model, context, withEnvironment(model, options));
}
export async function completeSimple<TApi extends Api>(model: Model<TApi>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> { return streamSimple(model, context, options).result(); }

export function registerFauxProvider(options: RegisterFauxProviderOptions = {}): FauxProviderRegistration {
  const core = createFauxCore(options);
  const sourceId = `faux-${Math.random().toString(36).slice(2)}`;
  registerApiProvider({ api: core.api, stream: core.stream, streamSimple: core.streamSimple }, sourceId);
  return { api: core.api, models: core.models, getModel: core.getModel, state: core.state, setResponses: core.setResponses, appendResponses: core.appendResponses, getPendingResponseCount: core.getPendingResponseCount, unregister: () => unregisterApiProviders(sourceId) };
}
