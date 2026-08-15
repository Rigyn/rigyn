import { createHash } from "node:crypto";

import {
  CredentialBroker,
  ExplicitCredentialSource,
} from "../auth/broker.js";
import {
  authorizeOpenAICodex,
  openAICodexIdentity,
  refreshOpenAICodexCredential,
} from "../auth/openai-codex.js";
import { authorizeAnthropic, refreshAnthropicOAuth } from "../auth/anthropic-oauth.js";
import {
  authorizeGitHubCopilot,
  configuredGitHubCopilotHost,
  refreshGitHubCopilotOAuth,
} from "../auth/github-copilot.js";
import { refreshGenericOAuthWithFetch } from "../auth/oauth.js";
import { configuredOAuthClientId } from "../auth/oauth-client-registration.js";
import { kimiCodeOAuthRegistration } from "../auth/kimi-code.js";
import { authorizeOAuthRegistration, type OAuthRegistrationConfig } from "../auth/registry.js";
import type { AuthCredential } from "../auth/types.js";
import { xaiOAuthRegistration } from "../auth/xai.js";
import type {
  AdapterEvent,
  ProviderAdapter,
  ProviderRequest,
} from "../core/types.js";
import { createNetworkTransport, type NetworkTransport } from "../net/index.js";
import { ProviderWireInterceptorRegistry } from "./wire.js";
import { BUILTIN_MODEL_CATALOG } from "./builtin-models.generated.js";
import {
  BUILTIN_PROVIDER_DESCRIPTORS,
  environmentProviderAuth,
  type BuiltinProviderDescriptor,
} from "./builtins.js";
import {
  createModels,
  type CreateModelsOptions,
  type MutableModels,
  type Provider,
  type ProviderAuth,
  type ProviderModel,
  type ProviderOAuthCredential,
  type ProviderStreamContext,
  type ProviderStreamOptions,
} from "./models.js";
import {
  hostOAuthCredential,
  providerOAuthCredential,
} from "./auth-store-adapter.js";
import { providerModelFromInfo } from "./internal-runtime-bridge.js";
import { openAICodexModels } from "./openai-codex-responses.js";
import { openRouterBrowserAccount } from "./openrouter-browser-auth.js";
import {
  BuiltinProviderResources,
  type BuiltinProviderResourceLease,
} from "./builtin-provider-resources.js";
import { cleanupProviderStreamResources, type ProviderStreamFailure } from "./stream-resource-cleanup.js";

const modelsByProvider = new Map<string, readonly ProviderModel[]>();
for (const descriptor of BUILTIN_PROVIDER_DESCRIPTORS) modelsByProvider.set(descriptor.id, []);
for (const model of BUILTIN_MODEL_CATALOG) {
  const existing = modelsByProvider.get(model.provider) ?? [];
  modelsByProvider.set(model.provider, [...existing, model]);
}
const codexBaseUrl = BUILTIN_PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.id === "openai-codex")?.baseUrl;
if (codexBaseUrl === undefined) throw new Error("OpenAI Codex built-in provider has no base URL");
modelsByProvider.set("openai-codex", openAICodexModels().map((info) => ({
  ...providerModelFromInfo(info),
  baseUrl: codexBaseUrl,
})));

const staticProviderIds = Object.freeze(
  [...modelsByProvider].filter(([, models]) => models.length > 0).map(([provider]) => provider),
);

/** Provider identities with entries in the synchronous built-in model catalog. */
export type BuiltinProvider = (typeof staticProviderIds)[number];

/** Read one model from the immutable built-in catalog. */
export function getBuiltinModel(provider: string, modelId: string): ProviderModel | undefined {
  return modelsByProvider.get(provider)?.find((model) => model.id === modelId);
}

/** Provider identities with entries in the synchronous built-in model catalog. */
export function getBuiltinProviders(): BuiltinProvider[] {
  return [...staticProviderIds];
}

/** Read all static models for one built-in provider. */
export function getBuiltinModels(provider: string): ProviderModel[] {
  return [...(modelsByProvider.get(provider) ?? [])];
}

function header(headers: Record<string, string | null> | undefined, name: string): string | undefined {
  const target = name.toLowerCase();
  return Object.entries(headers ?? {}).find(([key, value]) => key.toLowerCase() === target && value !== null)?.[1] ?? undefined;
}

function explicitCredential(
  provider: string,
  modelProvider: string,
  options: ProviderStreamOptions,
): AuthCredential | undefined {
  const authorization = header(options.headers, "authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/iu)?.[1];
  const secret = options.apiKey ?? bearer;
  if (secret === undefined) return undefined;
  if (modelProvider === "openai-codex") {
    const accountId = header(options.headers, "chatgpt-account-id");
    return {
      kind: "oauth",
      provider,
      accessToken: secret,
      expiresAt: Date.now() + 60 * 60_000,
      tokenType: "Bearer",
      scopes: [],
      ...(accountId === undefined ? {} : { accountId }),
    };
  }
  if (options.authSource === "OAuth") {
    return {
      kind: "oauth",
      provider,
      accessToken: secret,
      expiresAt: Date.now() + 60 * 60_000,
      tokenType: "Bearer",
      scopes: [],
    };
  }
  if (modelProvider === "anthropic" && (bearer !== undefined || secret.startsWith("sk-ant-oat"))) {
    return {
      kind: "bearer",
      provider,
      accessToken: secret,
    };
  }
  return { kind: "api_key", provider, apiKey: secret };
}

function combinedSignal(lifecycle: AbortSignal | undefined, interaction: AbortSignal | undefined): AbortSignal | undefined {
  if (lifecycle === undefined) return interaction;
  if (interaction === undefined) return lifecycle;
  return AbortSignal.any([lifecycle, interaction]);
}

function githubCopilotProviderOAuth(
  clientId: string,
  lifecycleSignal?: AbortSignal,
  environment: NodeJS.ProcessEnv = process.env,
): NonNullable<ProviderAuth["oauth"]> {
  const toProviderCredential = (credential: AuthCredential): ProviderOAuthCredential => {
    const converted = providerOAuthCredential(credential);
    if (converted === undefined) throw new Error("GitHub Copilot authorization did not return OAuth credentials");
    return converted;
  };
  return {
    name: "GitHub Copilot account",
    loginLabel: "Sign in with GitHub Copilot",
    async login(interaction) {
      const signal = combinedSignal(lifecycleSignal, interaction.signal);
      return toProviderCredential(await authorizeGitHubCopilot({
        clientId,
        experimentalTokenBroker: true,
        requestHost: async () => configuredGitHubCopilotHost(environment),
        showDeviceCode({ url, userCode }) {
          interaction.notify({
            type: "device_code",
            userCode,
            verificationUri: url.href,
          });
        },
        showProgress(message) {
          interaction.notify({ type: "progress", message });
        },
        ...(signal === undefined ? {} : { signal }),
      }));
    },
    async refresh(credential, signal) {
      const enterpriseHost = configuredGitHubCopilotHost(environment);
      const current = {
        ...hostOAuthCredential("github-copilot", credential),
        providerData: { enterpriseHost },
      };
      const refreshed = await refreshGitHubCopilotOAuth(
        current,
        combinedSignal(lifecycleSignal, signal),
      );
      return toProviderCredential({
        ...current,
        ...refreshed,
        providerData: { enterpriseHost },
      });
    },
    async toAuth(credential) {
      return { apiKey: credential.access };
    },
  };
}

function registeredProviderOAuth(
  providerId: string,
  providerName: string,
  registration: OAuthRegistrationConfig,
  lifecycleSignal?: AbortSignal,
): NonNullable<ProviderAuth["oauth"]> {
  const toProviderCredential = (credential: AuthCredential): ProviderOAuthCredential => {
    const converted = providerOAuthCredential(credential);
    if (converted === undefined) throw new Error(`${providerName} authorization did not return OAuth credentials`);
    return converted;
  };
  return {
    name: `${providerName} account`,
    loginLabel: registration.label ?? `Sign in with ${providerName}`,
    async login(interaction) {
      const signal = combinedSignal(lifecycleSignal, interaction.signal);
      return toProviderCredential(await authorizeOAuthRegistration(registration, providerId, {
        showAuthorization({ url, userCode }) {
          if (userCode === undefined) interaction.notify({ type: "auth_url", url: url.href });
          else interaction.notify({
            type: "device_code",
            userCode,
            verificationUri: url.href,
          });
        },
        ...(signal === undefined ? {} : { signal }),
      }));
    },
    async refresh(credential, signal) {
      const current = {
        ...hostOAuthCredential(providerId, credential),
        tokenEndpoint: registration.tokenEndpoint,
        clientId: registration.clientId,
      };
      const refreshed = await refreshGenericOAuthWithFetch(
        current,
        combinedSignal(lifecycleSignal, signal),
        globalThis.fetch,
      );
      return toProviderCredential({ ...current, ...refreshed });
    },
    async toAuth(credential) {
      return { apiKey: credential.access };
    },
  };
}

function substituteEnvironment(value: string, environment: NodeJS.ProcessEnv): string {
  return value.replace(/\{([A-Z][A-Z0-9_]*)\}/gu, (_match, name: string) => environment[name] ?? `{${name}}`);
}

function materializeEnvironment<T>(value: T, environment: NodeJS.ProcessEnv): T {
  if (typeof value === "string") return substituteEnvironment(value, environment) as T;
  if (Array.isArray(value)) return value.map((entry) => materializeEnvironment(entry, environment)) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, entry]) => [name, materializeEnvironment(entry, environment)]),
  ) as T;
}

async function runtimeConfig(
  provider: string,
  environment: NodeJS.ProcessEnv,
): Promise<import("../service/provider-factory.js").RuntimeProviderConfig> {
  const runtime = await import("../cli/runtime.js");
  const alias = provider === "google" ? "gemini" : provider;
  const configured = runtime.BUILTIN_PROVIDER_CONFIGS[alias];
  if (configured !== undefined) return materializeEnvironment(configured, environment);
  throw new Error(`No built-in transport configuration exists for ${provider}`);
}

function sortedEntries(values: Record<string, string | null | undefined>): Array<[string, string | null]> {
  return Object.entries(values)
    .filter((entry): entry is [string, string | null] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
}

const requestFunctionIds = new WeakMap<object, number>();
let nextRequestFunctionId = 1;
function requestFunctionId(value: object | undefined): number | undefined {
  if (value === undefined) return undefined;
  const existing = requestFunctionIds.get(value);
  if (existing !== undefined) return existing;
  const selected = nextRequestFunctionId;
  nextRequestFunctionId += 1;
  requestFunctionIds.set(value, selected);
  return selected;
}

function retainedCodexResourceKey(
  config: import("../service/provider-factory.js").RuntimeProviderConfig,
  credential: AuthCredential | undefined,
  environment: NodeJS.ProcessEnv,
  model: ProviderModel,
  options: ProviderStreamOptions,
): string | undefined {
  if (
    config.kind !== "openai-codex"
    || (config.transport ?? "auto") === "sse"
    || config.transport === "websocket"
    || credential?.kind !== "oauth"
  ) return undefined;
  const hash = createHash("sha256");
  hash.update(JSON.stringify({
    config,
    credential: {
      accessToken: credential.accessToken,
      accountId: credential.accountId,
    },
    headers: sortedEntries(options.headers ?? {}),
    environment: sortedEntries(environment),
    model,
    fetch: requestFunctionId(options.fetch),
    onPayload: requestFunctionId(options.onPayload),
    onResponse: requestFunctionId(options.onResponse),
  }));
  return hash.digest("hex");
}

function credentialProvider(
  config: import("../service/provider-factory.js").RuntimeProviderConfig,
  publicProvider: string,
): string {
  if (config.credentialProvider !== undefined) return config.credentialProvider;
  if (publicProvider === "google") return "gemini";
  return publicProvider;
}

async function* streamBuiltinModel(
  model: ProviderModel,
  context: ProviderStreamContext,
  options: ProviderStreamOptions = {},
  resources?: BuiltinProviderResources,
): AsyncIterable<AdapterEvent> {
  let adapter: ProviderAdapter | undefined;
  let network: NetworkTransport | undefined;
  let resourceLease: BuiltinProviderResourceLease | undefined;
  let failure: ProviderStreamFailure | undefined;
  try {
    const environment = { ...process.env, ...options.env };
    const baseConfig = await runtimeConfig(model.provider, environment);
    const config: import("../service/provider-factory.js").RuntimeProviderConfig = baseConfig.kind === "openai-codex"
      ? {
          ...baseConfig,
          ...(options.transport === undefined ? {} : { transport: options.transport }),
          ...(options.websocketConnectTimeoutMs === undefined
            ? {}
            : { webSocketConnectTimeoutMs: options.websocketConnectTimeoutMs }),
          ...(options.websocketIdleTimeoutMs === undefined
            ? {}
            : { webSocketIdleTimeoutMs: options.websocketIdleTimeoutMs }),
        }
      : baseConfig;
    const credentialId = credentialProvider(config, model.provider);
    const credential = explicitCredential(credentialId, model.provider, options);
    const credentials = credential === undefined
      ? new Map<string, AuthCredential>()
      : new Map<string, AuthCredential>([[credentialId, credential]]);
    const broker = new CredentialBroker([new ExplicitCredentialSource(credentials)]);
    const wire = new ProviderWireInterceptorRegistry();
    const { createProviderAdapter, runtimeProviderId } = await import("../service/provider-factory.js");
    const runtime = await import("../cli/runtime.js");
    const requestWire = runtime.requestWireTransport(
      wire,
      runtimeProviderId(config),
      options.headers,
      options.onPayload === undefined && options.onResponse === undefined
        ? undefined
        : {
            model,
            ...(options.onPayload === undefined ? {} : { onPayload: options.onPayload }),
            ...(options.onResponse === undefined ? {} : { onResponse: options.onResponse }),
          },
    );
    const effectiveCodexTransport = config.kind === "openai-codex"
      ? config.transport ?? "auto"
      : undefined;
    const createResource = () => {
      const selectedNetwork = effectiveCodexTransport !== undefined && effectiveCodexTransport !== "sse"
        ? createNetworkTransport({ environment })
        : undefined;
      const selectedAdapter = createProviderAdapter(config, broker, {
        environment,
        wire: requestWire,
        ...(options.fetch === undefined && selectedNetwork === undefined
          ? {}
          : { fetch: options.fetch ?? selectedNetwork!.fetch }),
        ...(selectedNetwork?.openWebSocket === undefined ? {} : { webSocket: selectedNetwork.openWebSocket }),
      });
      return {
        adapter: selectedAdapter,
        ...(selectedNetwork === undefined ? {} : { network: selectedNetwork }),
      };
    };
    if (resources === undefined) {
      const created = createResource();
      adapter = created.adapter;
      network = created.network;
    } else {
      resourceLease = resources.acquire(
        retainedCodexResourceKey(config, credential, environment, model, options),
        createResource,
      );
      adapter = resourceLease.adapter;
      network = resourceLease.network;
    }
    const request: ProviderRequest = {
      provider: adapter.id,
      model: model.id,
      api: model.api,
      messages: context.messages,
      tools: context.tools ?? [],
      ...(context.providerState === undefined ? {} : { providerState: context.providerState }),
      ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
      ...(options.toolChoice === undefined ? {} : { toolChoice: options.toolChoice }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.cacheRetention === undefined ? {} : { cacheRetention: options.cacheRetention }),
      ...(options.thinkingBudgets === undefined ? {} : { thinkingBudgets: options.thinkingBudgets }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
      ...(options.transport === undefined ? {} : { transport: options.transport }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
      ...(options.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: options.maxRetryDelayMs }),
      ...(options.onPayload === undefined ? {} : { onPayload: options.onPayload }),
      ...(options.onResponse === undefined ? {} : { onResponse: options.onResponse }),
      ...(model.name === model.id && model.compat === undefined
        ? {}
        : {
            modelSettings: {
              ...(model.name === model.id ? {} : { displayName: model.name }),
              ...(model.compat === undefined ? {} : { compatibility: structuredClone(model.compat) }),
            },
          }),
    };
    yield* adapter.stream(request, options.signal ?? new AbortController().signal);
  } catch (error) {
    failure = { error };
  } finally {
    failure = resourceLease === undefined
      ? await cleanupProviderStreamResources(failure, adapter, network)
      : await resourceLease.release(failure);
  }
  if (failure !== undefined) {
    const { error } = failure;
    yield {
      type: "error",
      error: {
        category: "provider",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        partial: false,
      },
    };
  }
}

function openAICodexProviderOAuth(oauthClientId: string): NonNullable<ProviderAuth["oauth"]> {
  const toProviderCredential = (credential: AuthCredential): ProviderOAuthCredential => {
    const converted = providerOAuthCredential(credential);
    if (converted === undefined) throw new Error("OpenAI Codex authorization did not return OAuth credentials");
    return converted;
  };
  const credentialUse: NonNullable<ProviderAuth["oauth"]> = {
    name: "ChatGPT/Codex account",
    async toAuth(credential) {
      const identity = openAICodexIdentity(credential.access);
      if (typeof credential.accountId === "string" && credential.accountId !== identity.accountId) {
        throw new Error("OpenAI Codex credential account identity does not match its access token");
      }
      return {
        apiKey: credential.access,
        headers: { "chatgpt-account-id": identity.accountId },
      };
    },
    async refresh(credential, signal) {
      const clientId = typeof credential.clientId === "string" ? credential.clientId : oauthClientId;
      const refreshed = await refreshOpenAICodexCredential(
        { ...hostOAuthCredential("openai-codex", credential), clientId },
        signal,
      );
      return toProviderCredential(refreshed);
    },
  };
  return {
    ...credentialUse,
    async login(interaction) {
      const method = await interaction.prompt({
        type: "select",
        message: "Select login method:",
        options: [
          { id: "browser", label: "Browser login" },
          { id: "device", label: "Device code login", description: "For remote or headless systems" },
        ],
        ...(interaction.signal === undefined ? {} : { signal: interaction.signal }),
      });
      if (method !== "browser" && method !== "device") throw new Error(`Unknown login method: ${method}`);
      return toProviderCredential(await authorizeOpenAICodex({
        clientId: oauthClientId,
        flow: method,
        ...(interaction.signal === undefined ? {} : { signal: interaction.signal }),
        showAuthorization({ url, userCode }) {
          if (userCode === undefined) {
            interaction.notify({ type: "auth_url", url: url.href });
          } else {
            interaction.notify({
              type: "device_code",
              userCode,
              verificationUri: url.href,
              expiresInSeconds: 15 * 60,
            });
          }
        },
        ...(method === "browser"
          ? {
              requestManualAuthorization: async ({ redirectUri }, signal) => {
                const value = await interaction.prompt({
                  type: "manual_code",
                  message: "Paste the authorization code or final redirect URL, or press Enter to wait for the browser callback:",
                  placeholder: redirectUri,
                  signal,
                });
                return value.trim() === "" ? undefined : value;
              },
            }
          : {}),
      }));
    },
  };
}

function anthropicProviderOAuth(
  oauthClientId: string,
  lifecycleSignal?: AbortSignal,
): NonNullable<ProviderAuth["oauth"]> {
  const toProviderCredential = (credential: AuthCredential): ProviderOAuthCredential => {
    const converted = providerOAuthCredential(credential);
    if (converted === undefined) throw new Error("Anthropic authorization did not return OAuth credentials");
    return converted;
  };
  const credentialUse: NonNullable<ProviderAuth["oauth"]> = {
    name: "Anthropic account",
    async toAuth(credential) {
      return { apiKey: credential.access };
    },
    async refresh(credential, signal) {
      const clientId = typeof credential.clientId === "string" ? credential.clientId : oauthClientId;
      const current = { ...hostOAuthCredential("anthropic", credential), clientId };
      const refreshed = await refreshAnthropicOAuth(current, signal);
      const refreshToken = refreshed.refreshToken ?? current.refreshToken;
      return toProviderCredential({
        ...current,
        ...refreshed,
        ...(refreshToken === undefined ? {} : { refreshToken }),
      });
    },
  };
  return {
    ...credentialUse,
    async login(interaction) {
      const signal = lifecycleSignal === undefined
        ? interaction.signal
        : interaction.signal === undefined
          ? lifecycleSignal
          : AbortSignal.any([lifecycleSignal, interaction.signal]);
      return toProviderCredential(await authorizeAnthropic({
        clientId: oauthClientId,
        ...(signal === undefined ? {} : { signal }),
        showAuthorization({ url }) {
          interaction.notify({ type: "auth_url", url: url.href });
        },
        requestManualAuthorization: async ({ redirectUri }, promptSignal) => {
          const value = await interaction.prompt({
            type: "manual_code",
            message: "Paste the authorization code or final redirect URL, or press Enter to wait for the browser callback:",
            placeholder: redirectUri,
            signal: promptSignal,
          });
          return value.trim() === "" ? undefined : value;
        },
      }));
    },
  };
}

function builtinProvider(
  descriptor: BuiltinProviderDescriptor,
  resources?: BuiltinProviderResources,
  environment: NodeJS.ProcessEnv = process.env,
): Provider {
  const models = modelsByProvider.get(descriptor.id) ?? [];
  const environmentAuth = descriptor.environment.length === 0
    ? undefined
    : environmentProviderAuth(descriptor);
  return {
    id: descriptor.id,
    name: descriptor.name,
    ...(descriptor.baseUrl === undefined ? {} : { baseUrl: descriptor.baseUrl }),
    auth: {
      ...(environmentAuth === undefined ? {} : { apiKey: environmentAuth }),
      ...(descriptor.id === "openai-codex"
        ? { oauth: openAICodexProviderOAuth(configuredOAuthClientId("openai-codex", environment)) }
        : {}),
      ...(descriptor.id === "anthropic"
        ? { oauth: anthropicProviderOAuth(configuredOAuthClientId("anthropic", environment), resources?.signal) }
        : {}),
      ...(descriptor.id === "github-copilot"
        ? { oauth: githubCopilotProviderOAuth(
            configuredOAuthClientId("github-copilot", environment),
            resources?.signal,
            environment,
          ) }
        : {}),
      ...(descriptor.id === "xai"
        ? { oauth: registeredProviderOAuth(
            "xai",
            "xAI",
            xaiOAuthRegistration(configuredOAuthClientId("xai", environment)),
            resources?.signal,
          ) }
        : {}),
      ...(descriptor.id === "kimi-code"
        ? { oauth: registeredProviderOAuth(
            "kimi-code",
            "Kimi Code",
            kimiCodeOAuthRegistration(configuredOAuthClientId("kimi-code", environment)),
            resources?.signal,
          ) }
        : {}),
      ...(descriptor.id === "openrouter"
        ? { providerAccount: openRouterBrowserAccount(resources === undefined ? {} : { signal: resources.signal }) }
        : {}),
    },
    getModels: () => models,
    stream: (model, context, options) => streamBuiltinModel(model, context, options, resources),
    streamSimple: (model, context, options) => streamBuiltinModel(model, context, options, resources),
  };
}

/** All built-in providers, freshly constructed. Dynamic providers may initially have no models. */
export function builtinProviders(environment: NodeJS.ProcessEnv = process.env): Provider[] {
  return BUILTIN_PROVIDER_DESCRIPTORS.map((descriptor) => builtinProvider(descriptor, undefined, environment));
}

/** A direct mutable model collection with every built-in provider registered. */
export function builtinModels(options?: CreateModelsOptions): MutableModels & {
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
} {
  const resources = new BuiltinProviderResources();
  const models = createModels(options);
  for (const descriptor of BUILTIN_PROVIDER_DESCRIPTORS) {
    models.setProvider(builtinProvider(descriptor, resources));
  }
  return Object.assign(models, {
    close: () => resources.close(),
    [Symbol.asyncDispose]: () => resources.close(),
  });
}
