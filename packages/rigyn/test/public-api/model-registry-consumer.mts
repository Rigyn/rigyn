import {
  ModelRegistry,
  type ProviderConfigInput,
  type ResolvedRequestAuth,
} from "rigyn";
import { ModelRuntime } from "rigyn/sdk";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  AuthCheck,
  AuthInteraction,
  AuthResult,
  Credential,
  CredentialInfo,
  Model,
  ModelsApiStreamOptions,
  ModelsRefreshResult,
  Provider,
  ProviderHeaders,
} from "@rigyn/models";

declare const runtime: ModelRuntime;
declare const model: Model<"consumer-custom-api">;
declare const provider: Provider;
declare const interaction: AuthInteraction;

const registry = new ModelRegistry(runtime);
const all: Model<Api>[] = registry.getAll();
const models: readonly Model<Api>[] = registry.getModels();
const providerModels: readonly Model<Api>[] = registry.getModels(model.provider);
const available: Model<Api>[] = registry.getAvailable();
const availableSnapshot: readonly Model<Api>[] = registry.getAvailableSnapshot();
const found: Model<Api> | undefined = registry.find(model.provider, model.id);
const selected: Model<Api> | undefined = registry.getModel(model.provider, model.id);
const providers: readonly Provider[] = registry.getProviders();
const selectedProvider: Provider | undefined = registry.getProvider(model.provider);
const providerName: string = registry.getProviderDisplayName(model.provider);
const error: string | undefined = registry.getError();
const authCheck: Promise<AuthCheck | undefined> = registry.checkAuth(model.provider);
const configuredByModel: boolean = registry.hasConfiguredAuth(model);
const configuredById: boolean = registry.hasConfiguredAuth(model.provider);
const oauthByModel: boolean = registry.isUsingOAuth(model);
const oauthById: boolean = registry.isUsingOAuth(model.provider);
const authByModel: Promise<AuthResult | undefined> = registry.getAuth(model, { apiKey: "request-key" });
const authById: Promise<AuthResult | undefined> = registry.getAuth(model.provider, { minOAuthValidityMs: 0 });
const requestAuth: Promise<ResolvedRequestAuth> = registry.getApiKeyAndHeaders(model);
const compatibility: { headers?: ProviderHeaders; authHeader: boolean } =
  registry.getCompatibilityRequestConfig(model);
const refresh: Promise<ModelsRefreshResult> = registry.refresh({ allowNetwork: false });
const refreshConfig: Promise<void> = registry.refreshConfig();
const runtimeKey: Promise<void> = registry.setRuntimeApiKey(model.provider, "runtime-key", {
  allowNetwork: false,
});
const removeRuntimeKey: Promise<void> = registry.removeRuntimeApiKey(model.provider);
const credentials: Promise<readonly CredentialInfo[]> = registry.listCredentials();
const login: Promise<Credential> = registry.login(model.provider, "api_key", interaction);
const logout: Promise<void> = registry.logout(model.provider);

const config = {
  api: model.api,
  baseUrl: model.baseUrl,
  models: [{
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: ["text"],
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }],
} satisfies ProviderConfigInput;
registry.registerProvider(model.provider, config);
registry.registerProvider(provider);
registry.registerNativeProvider(provider);
registry.unregisterProvider(model.provider);
const registeredConfig: ProviderConfigInput | undefined = registry.getRegisteredProviderConfig(model.provider);
const registeredIds: readonly string[] = registry.getRegisteredProviderIds();
const registeredNative: Provider | undefined = registry.getRegisteredNativeProvider(model.provider);

function streamNarrowed<TApi extends Api>(
  target: ModelRegistry,
  selectedModel: Model<TApi>,
  options: ModelsApiStreamOptions<TApi>,
): AssistantMessageEventStream {
  return target.stream(selectedModel, { messages: [] }, options);
}

const stream: AssistantMessageEventStream = registry.stream(model, { messages: [] }, { api: model.api });
const narrowedStream: AssistantMessageEventStream = streamNarrowed(registry, model, { api: model.api });
const complete: Promise<AssistantMessage> = registry.complete(model, { messages: [] }, { api: model.api });
const simpleStream: AssistantMessageEventStream = registry.streamSimple(model, { messages: [] });
const simpleComplete: Promise<AssistantMessage> = registry.completeSimple(model, { messages: [] });
const close: Promise<void> = registry.close();
const dispose: Promise<void> = registry[Symbol.asyncDispose]();
const internal = registry.internalRegistry();
const internalModels = registry.models();
const authStatus = registry.getProviderAuthStatus(model.provider);

void [
  all,
  models,
  providerModels,
  available,
  availableSnapshot,
  found,
  selected,
  providers,
  selectedProvider,
  providerName,
  error,
  authCheck,
  configuredByModel,
  configuredById,
  oauthByModel,
  oauthById,
  authByModel,
  authById,
  requestAuth,
  compatibility,
  refresh,
  refreshConfig,
  runtimeKey,
  removeRuntimeKey,
  credentials,
  login,
  logout,
  registeredConfig,
  registeredIds,
  registeredNative,
  stream,
  narrowedStream,
  complete,
  simpleStream,
  simpleComplete,
  close,
  dispose,
  internal,
  internalModels,
  authStatus,
];
