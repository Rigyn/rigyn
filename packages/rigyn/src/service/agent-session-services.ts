import { resolve } from "node:path";

import { getAgentDir } from "../config/paths.js";
import {
  DefaultResourceLoader,
  type DefaultResourceLoaderOptions,
  type ResourceLoader,
  type ResourceLoaderRefreshOptions,
} from "../core/resource-loader.js";
import { errorMessage } from "../core/errors.js";
import { SettingsManager, type ThinkingLevel } from "../core/settings-manager.js";
import type { SessionStartEvent } from "../extensions/direct.js";
import { getExtensionRuntimeHost } from "../extensions/compat.js";
import { ModelRuntime } from "../providers/model-compat.js";
import type { ProviderWireLifecycleHost } from "../providers/wire.js";
import {
  createAgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
} from "../sdk/index.js";
import type { SessionManager } from "../storage/session-manager.js";
import type { AgentSessionRuntimeDiagnostic } from "./agent-session-runtime.js";

export interface CreateAgentSessionServicesOptions {
  agentDir?: string;
  cwd: string;
  extensionFlagValues?: ReadonlyMap<string, boolean | string>;
  modelRuntime?: ModelRuntime;
  resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
  resourceLoaderRefreshOptions?: ResourceLoaderRefreshOptions;
  settingsManager?: SettingsManager;
}

export interface AgentSessionServices {
  agentDir: string;
  cwd: string;
  diagnostics: AgentSessionRuntimeDiagnostic[];
  modelRuntime: ModelRuntime;
  resourceLoader: ResourceLoader;
  settingsManager: SettingsManager;
}

export interface CreateAgentSessionFromServicesOptions {
  customTools?: CreateAgentSessionOptions["customTools"];
  excludeTools?: CreateAgentSessionOptions["excludeTools"];
  model?: CreateAgentSessionOptions["model"];
  modelCyclingEnabled?: boolean;
  noTools?: CreateAgentSessionOptions["noTools"];
  providerWireLifecycle?: ProviderWireLifecycleHost;
  scopedModels?: CreateAgentSessionOptions["scopedModels"];
  services: AgentSessionServices;
  sessionManager: SessionManager;
  sessionStartEvent?: SessionStartEvent;
  thinkingLevel?: ThinkingLevel;
  toolBackend?: CreateAgentSessionOptions["toolBackend"];
  toolAuthorizationHandler?: CreateAgentSessionOptions["toolAuthorizationHandler"];
  tools?: string[];
}

export async function createAgentSessionServices(
  options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
  const cwd = resolve(options.cwd);
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const providedSettingsManager = options.settingsManager;
  const settingsManager = providedSettingsManager ?? SettingsManager.create(cwd, agentDir);
  const modelRuntime = options.modelRuntime ?? await ModelRuntime.create({
    authPath: resolve(agentDir, "auth.json"),
    modelsPath: resolve(agentDir, "model-providers.json"),
  });
  const loaderConfiguration: DefaultResourceLoaderOptions = {
    ...(options.resourceLoaderOptions ?? {}),
    agentDir,
    cwd,
    settingsManager,
  };
  const resourceLoader = new DefaultResourceLoader(loaderConfiguration);
  await resourceLoader.refresh(options.resourceLoaderRefreshOptions);

  const extensionsResult = resourceLoader.getExtensions();
  const extensionHost = getExtensionRuntimeHost(extensionsResult.runtime);
  const diagnostics: AgentSessionRuntimeDiagnostic[] = (extensionHost?.diagnostics() ?? []).map((entry) => ({
    type: "warning",
    message: entry.message,
  }));
  if (options.extensionFlagValues !== undefined) {
    const runtimeFlags = extensionsResult.runtime.flagValues;
    for (const [name, value] of options.extensionFlagValues) {
      try {
        runtimeFlags.set(name, value);
        extensionHost?.setFlagValue(name, value);
      } catch (error) {
        diagnostics.push({ type: "error", message: errorMessage(error) });
      }
    }
  }
  return { cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics };
}

export async function createAgentSessionFromServices(
  options: CreateAgentSessionFromServicesOptions,
): Promise<CreateAgentSessionResult> {
  const result = await createAgentSession({
    cwd: options.services.cwd,
    agentDir: options.services.agentDir,
    modelRuntime: options.services.modelRuntime,
    resourceLoader: options.services.resourceLoader,
    settingsManager: options.services.settingsManager,
    sessionManager: options.sessionManager,
    ...(options.sessionStartEvent === undefined ? {} : { sessionStartEvent: options.sessionStartEvent }),
    ...(options.providerWireLifecycle === undefined ? {} : { providerWireLifecycle: options.providerWireLifecycle }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.modelCyclingEnabled === undefined ? {} : { modelCyclingEnabled: options.modelCyclingEnabled }),
    ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
    ...(options.scopedModels === undefined ? {} : { scopedModels: options.scopedModels }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.excludeTools === undefined ? {} : { excludeTools: options.excludeTools }),
    ...(options.noTools === undefined ? {} : { noTools: options.noTools }),
    ...(options.customTools === undefined ? {} : { customTools: options.customTools }),
    ...(options.toolBackend === undefined ? {} : { toolBackend: options.toolBackend }),
    ...(options.toolAuthorizationHandler === undefined
      ? {}
      : { toolAuthorizationHandler: options.toolAuthorizationHandler }),
  });
  if (!("modelFallbackMessage" in result)) {
    Object.defineProperty(result, "modelFallbackMessage", {
      configurable: true,
      enumerable: true,
      value: undefined,
      writable: true,
    });
  }
  return result;
}
