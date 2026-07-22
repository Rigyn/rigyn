import { join, resolve } from "node:path";

import { setDefaultStreamFn } from "@rigyn/kernel";
import type { Api, Model } from "@rigyn/models";
import { streamSimple } from "@rigyn/models/compat";

import { canonicalExistingPath } from "../config/canonical-path.js";
import { getAgentDir } from "../config/paths.js";
import {
  DefaultResourceLoader,
  type ResourceExtensionsResult,
  type ResourceLoader,
} from "../core/resource-loader.js";
import { SettingsManager, type ThinkingLevel } from "../core/settings-manager.js";
import type { SessionStartEvent } from "../extensions/direct.js";
import {
  ensureExtensionRuntimeHost,
  getExtensionRuntimeHost,
} from "../extensions/compat.js";
import { extensionModelRegistry } from "../extensions/model-boundary.js";
import { loadRuntime, type LoadedRuntime } from "../cli/runtime.js";
import {
  type ProviderModel,
} from "../providers/index.js";
import { ModelRegistry as InternalModelRegistry } from "../providers/model-registry.js";
import { ModelRuntime } from "../providers/model-compat.js";
import {
  ModelRegistry as PublicModelRegistry,
  unwrapPublicModelRegistry,
} from "../providers/public-model-registry.js";
import {
  providerAdapterFromModels,
  providerModelToInfo,
} from "../providers/internal-runtime-bridge.js";
import { ProviderRegistry } from "../providers/registry.js";
import {
  AgentSession,
  type AgentSessionModel,
  type AgentSessionScopedModel,
} from "../service/agent-session.js";
import { attachAgentSessionOwner } from "../service/agent-session-owner.js";
import { SessionManager } from "../storage/session-manager.js";
import type { HarnessTool } from "../tools/types.js";

const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";
const DEFAULT_ACTIVE_BUILTINS = ["read", "bash", "edit", "write"] as const;
const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

// Preserve the legacy fallback for extensions that construct Agent instances
// or invoke low-level loops without passing the renamed streamFn option.
setDefaultStreamFn(streamSimple);

export interface CreateAgentSessionOptions {
  /** Working directory for project-local discovery. Default: process.cwd(). */
  cwd?: string;
  /** Global configuration directory. Default: ~/.rigyn/agent. */
  agentDir?: string;
  /** Canonical model/auth runtime. */
  modelRuntime?: PublicModelRegistry | ModelRuntime;
  /** Initial model. Restored session state and configured defaults are used when omitted. */
  model?: ProviderModel | Model<Api>;
  /** Initial thinking level. */
  thinkingLevel?: ThinkingLevel;
  /** Models available to model cycling. */
  scopedModels?: Array<{ model: ProviderModel | Model<Api>; thinkingLevel?: ThinkingLevel }>;
  /** Suppress every tool, or only the default built-ins. */
  noTools?: "all" | "builtin";
  /** Exact active-tool allowlist. */
  tools?: string[];
  /** Tool names removed after the allowlist/default policy. */
  excludeTools?: string[];
  /** Custom tools registered alongside built-ins and extension tools. */
  customTools?: HarnessTool[];
  /** Resource loader. Default: DefaultResourceLoader with normal discovery. */
  resourceLoader?: ResourceLoader;
  /** Session manager. Default: a new persistent session for cwd. */
  sessionManager?: SessionManager;
  /** Settings manager. Default: SettingsManager.create(cwd, agentDir). */
  settingsManager?: SettingsManager;
  /** Metadata supplied to the initial extension session_start event. */
  sessionStartEvent?: SessionStartEvent;
}

export type LoadExtensionsResult = ResourceExtensionsResult;

export interface CreateAgentSessionResult {
  session: AgentSession;
  extensionsResult: LoadExtensionsResult;
  modelFallbackMessage?: string;
}

function toSessionModel(model: ProviderModel): AgentSessionModel {
  return {
    provider: model.provider,
    api: model.api,
    id: model.id,
    info: providerModelToInfo(model),
  };
}

function clampThinkingLevel(model: ProviderModel | undefined, requested: ThinkingLevel): ThinkingLevel {
  if (model === undefined || !model.reasoning) return "off";
  const ordered: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const mapped = model.thinkingLevelMap;
  if (mapped === undefined || mapped[requested] !== null) return requested;
  const index = ordered.indexOf(requested);
  for (let offset = index - 1; offset >= 0; offset -= 1) {
    const candidate = ordered[offset]!;
    if (mapped[candidate] !== null) return candidate;
  }
  return "off";
}

function extensionResult(loader: ResourceLoader): LoadExtensionsResult {
  return loader.getExtensions();
}

function chooseInitialModel(
  modelRuntime: InternalModelRegistry,
  settings: SettingsManager,
  scopedModels: readonly AgentSessionScopedModel[],
): ProviderModel | undefined {
  const defaultProvider = settings.getDefaultProvider();
  const defaultModel = settings.getDefaultModel();
  if (defaultProvider !== undefined && defaultModel !== undefined) {
    const selected = modelRuntime.find(defaultProvider, defaultModel);
    if (selected !== undefined && modelRuntime.hasConfiguredAuth(selected)) return selected;
  }
  const scoped = scopedModels.find((entry) => modelRuntime.hasConfiguredAuth(entry.model));
  return scoped?.model ?? modelRuntime.getAvailable()[0];
}

function initialActiveTools(
  options: CreateAgentSessionOptions,
  extensionAndCustomNames: readonly string[],
): NonNullable<import("../service/agent-session.js").AgentSessionOptions["initialToolSelection"]> {
  let names: string[];
  let activateExtensionToolsOnBind = false;
  if (options.tools !== undefined) names = [...options.tools];
  else if (options.noTools === "all") names = [];
  else if (options.noTools === "builtin") {
    names = [...extensionAndCustomNames];
    activateExtensionToolsOnBind = true;
  } else {
    names = [...DEFAULT_ACTIVE_BUILTINS, ...extensionAndCustomNames];
    activateExtensionToolsOnBind = true;
  }
  return {
    names: [...new Set(names)],
    activateExtensionToolsOnBind,
    excludedNames: [...new Set(options.excludeTools ?? [])],
  };
}

async function defaultModelRuntime(cwd: string): Promise<{
  modelRuntime: InternalModelRegistry;
  providers: ProviderRegistry;
  owner: LoadedRuntime;
}> {
  // Reuse the same provider/auth construction as the CLI until that lower layer is
  // independently public. No session or discovered resource from this bootstrap is
  // exposed by the SDK factory.
  const owner = await loadRuntime({
    workspace: cwd,
    ephemeral: true,
    extensions: false,
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
  });
  return { modelRuntime: owner.modelRegistry, providers: owner.providers, owner };
}

/** Create one directly composed AgentSession. */
export async function createAgentSession(
  options: CreateAgentSessionOptions = {},
): Promise<CreateAgentSessionResult> {
  const cwd = await canonicalExistingPath(resolve(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd()));
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  if (options.sessionManager !== undefined) {
    const sessionCwd = await canonicalExistingPath(resolve(options.sessionManager.getCwd()));
    if (sessionCwd !== cwd) throw new Error("SessionManager cwd must match createAgentSession cwd");
  }
  const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
  const sessionManager = options.sessionManager ?? SessionManager.create(cwd, join(agentDir, "sessions"));
  const resourceLoader = options.resourceLoader ?? new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
  });
  const ownsResourceLoader = options.resourceLoader === undefined;

  let bootstrap: LoadedRuntime | undefined;
  let extensionsResult: LoadExtensionsResult | undefined;
  let extensionHost: import("../extensions/runtime.js").RuntimeExtensionHost | undefined;
  let fallbackExtensionHost: import("../extensions/runtime.js").RuntimeExtensionHost | undefined;
  let session: AgentSession | undefined;
  let restoreBootstrapProviders: (() => void) | undefined;
  let ownedResourcesDisposed = false;
  const disposeOwnedResources = async (): Promise<void> => {
    if (ownedResourcesDisposed) return;
    ownedResourcesDisposed = true;
    const failures: unknown[] = [];
    const hosts = new Set<import("../extensions/runtime.js").RuntimeExtensionHost>();
    const runtimes = new Set<LoadExtensionsResult["runtime"]>();
    if (fallbackExtensionHost !== undefined) {
      hosts.add(fallbackExtensionHost);
      if (extensionsResult !== undefined) runtimes.add(extensionsResult.runtime);
    }
    if (ownsResourceLoader) {
      try {
        const currentResult = resourceLoader.getExtensions();
        runtimes.add(currentResult.runtime);
        const currentHost = getExtensionRuntimeHost(currentResult.runtime);
        if (currentHost !== undefined) hosts.add(currentHost);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const runtime of runtimes) {
      try { runtime.invalidate("Extension runtime owner was disposed"); } catch (error) { failures.push(error); }
    }
    for (const host of hosts) {
      try { await host.close(); } catch (error) { failures.push(error); }
    }
    try { await bootstrap?.close(); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "AgentSession owner cleanup failed");
  };
  try {
    if (ownsResourceLoader) await resourceLoader.reload();
    extensionsResult = extensionResult(resourceLoader);
    extensionHost = getExtensionRuntimeHost(extensionsResult.runtime);
    if (extensionHost === undefined) {
      extensionHost = ensureExtensionRuntimeHost(extensionsResult.runtime, cwd);
      fallbackExtensionHost = extensionHost;
    }

    let modelRuntime: InternalModelRegistry;
    let providers: ProviderRegistry;
    if (options.modelRuntime === undefined) {
      const defaults = await defaultModelRuntime(cwd);
      modelRuntime = defaults.modelRuntime;
      providers = defaults.providers;
      bootstrap = defaults.owner;
    } else {
      modelRuntime = options.modelRuntime instanceof ModelRuntime
        ? options.modelRuntime.internalRegistry()
        : unwrapPublicModelRegistry(options.modelRuntime);
      await modelRuntime.refresh({ allowNetwork: false });
    }
    providers ??= new ProviderRegistry(
      modelRuntime.models().getProviders().map((provider) =>
        providerAdapterFromModels(modelRuntime.models(), provider.id)),
    );
    const extensionModels = extensionModelRegistry(modelRuntime);
    const bootstrapProviders: Array<{
      name: string;
      native: ReturnType<typeof extensionModels.getRegisteredNativeProvider>;
      config: ReturnType<typeof extensionModels.getRegisteredProviderConfig>;
    }> = [];
    for (const registration of extensionHost.directProviderRegistrations()) {
      bootstrapProviders.push({
        name: registration.name,
        native: extensionModels.getRegisteredNativeProvider(registration.name),
        config: extensionModels.getRegisteredProviderConfig(registration.name),
      });
      if ("provider" in registration) {
        extensionModels.registerProvider(registration.provider);
      } else {
        extensionModels.registerProvider(registration.name, registration.config);
      }
    }
    if (bootstrapProviders.length > 0) {
      let restored = false;
      restoreBootstrapProviders = () => {
        if (restored) return;
        restored = true;
        for (const previous of [...bootstrapProviders].reverse()) {
          extensionModels.unregisterProvider(previous.name);
          if (previous.native !== undefined) extensionModels.registerProvider(previous.native);
          else if (previous.config !== undefined) extensionModels.registerProvider(previous.name, previous.config);
        }
      };
      await modelRuntime.refresh({ allowNetwork: false });
    }
    const existing = sessionManager.buildSessionContext();
    const hasExistingSession = existing.messages.length > 0;
    const hasThinkingEntry = sessionManager.getEntries().some((entry) => entry.type === "thinking_level_change");
    const publicModels = extensionModels;
    const scopedModels: AgentSessionScopedModel[] = (options.scopedModels ?? []).map((entry) => ({
      model: publicModels.resolve(entry.model as Model<Api>),
      ...(entry.thinkingLevel === undefined ? {} : { thinkingLevel: entry.thinkingLevel }),
    }));

    let model = options.model === undefined ? undefined : publicModels.resolve(options.model as Model<Api>);
    let modelFallbackMessage: string | undefined;
    if (model === undefined && hasExistingSession && existing.model !== null) {
      const restored = modelRuntime.find(existing.model.provider, existing.model.modelId);
      if (restored !== undefined && modelRuntime.hasConfiguredAuth(restored)) model = restored;
      else modelFallbackMessage = `Could not restore model ${existing.model.provider}/${existing.model.modelId}`;
    }
    if (model === undefined) {
      model = chooseInitialModel(modelRuntime, settingsManager, scopedModels);
      if (model === undefined) modelFallbackMessage ??= "No available model. Configure provider authentication.";
      else if (modelFallbackMessage !== undefined) modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
    }

    const persistedThinking = existing.thinkingLevel as ThinkingLevel;
    const requestedThinking = options.thinkingLevel ?? (
      hasExistingSession && hasThinkingEntry
        ? persistedThinking
        : settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL
    );
    const thinkingLevel = clampThinkingLevel(model, requestedThinking);
    if (!hasExistingSession) {
      if (model !== undefined) sessionManager.appendModelChange(model.provider, model.id);
      sessionManager.appendThinkingLevelChange(thinkingLevel);
    } else if (!hasThinkingEntry) {
      sessionManager.appendThinkingLevelChange(thinkingLevel);
    }

    const extensionTools = extensionHost.tools();
    const customTools = options.customTools ?? [];
    const extraTools = [...extensionTools, ...customTools];
    restoreBootstrapProviders?.();
    restoreBootstrapProviders = undefined;
    session = await AgentSession.create({
      sessionManager,
      providers,
      modelRegistry: modelRuntime,
      resourceLoader,
      extensionsResult,
      sessionStartEvent: options.sessionStartEvent ?? { type: "session_start", reason: "startup" },
      workspace: cwd,
      agentDirectory: agentDir,
      settingsManager,
      tools: extraTools,
      initialToolSelection: initialActiveTools(
        options,
        extraTools.map((tool) => tool.definition.name).filter((name) => !BUILTIN_TOOL_NAMES.has(name)),
      ),
      ...(model === undefined ? {} : { model: toSessionModel(model) }),
      thinkingLevel,
      scopedModels,
    });
    attachAgentSessionOwner(session, disposeOwnedResources);

    return {
      session,
      extensionsResult,
      ...(modelFallbackMessage === undefined ? {} : { modelFallbackMessage }),
    };
  } catch (error) {
    restoreBootstrapProviders?.();
    await session?.close().catch(() => undefined);
    await disposeOwnedResources().catch(() => undefined);
    throw error;
  }
}

export { AgentSession } from "../service/agent-session.js";
export type {
  AgentSessionAgent,
  AgentSessionAgentState,
  AgentSessionEvent,
  AgentSessionEventListener,
  AgentSessionModel,
  AgentSessionOptions,
  AgentSessionPromptOptions,
  AgentSessionRun,
  AgentSessionScopedModel,
} from "../service/agent-session.js";
export { SessionManager } from "../storage/session-manager.js";
export type { ReadonlySessionManager } from "../storage/session-manager.js";
export { DefaultResourceLoader } from "../core/resource-loader.js";
export type { ResourceExtensionsResult, ResourceLoader } from "../core/resource-loader.js";
export { SettingsManager } from "../core/settings-manager.js";
export type { ThinkingLevel } from "../core/settings-manager.js";
export { ModelRegistry } from "../providers/public-model-registry.js";
export { ModelRuntime } from "../providers/model-compat.js";
export type { ProviderModel } from "../providers/models.js";
export type { HarnessTool as ToolDefinition } from "../tools/types.js";
export {
  AgentSessionRuntime,
  createAgentSessionRuntime,
} from "../service/agent-session-runtime.js";
export type {
  AgentSessionRuntimeDiagnostic,
  CreateAgentSessionRuntimeFactory,
  CreateAgentSessionRuntimeResult,
} from "../service/agent-session-runtime.js";
export {
  createAgentSessionFromServices,
  createAgentSessionServices,
} from "../service/agent-session-services.js";
export type {
  AgentSessionServices,
  CreateAgentSessionFromServicesOptions,
  CreateAgentSessionServicesOptions,
} from "../service/agent-session-services.js";
