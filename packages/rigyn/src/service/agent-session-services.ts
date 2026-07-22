import { resolve } from "node:path";

import { getAgentDir } from "../config/paths.js";
import {
  DefaultResourceLoader,
  type DefaultResourceLoaderOptions,
  type ResourceLoader,
  type ResourceLoaderReloadOptions,
} from "../core/resource-loader.js";
import { SettingsManager, type ThinkingLevel } from "../core/settings-manager.js";
import type { SessionStartEvent } from "../extensions/direct.js";
import { getExtensionRuntimeHost } from "../extensions/compat.js";
import { ModelRuntime } from "../providers/model-compat.js";
import type { ProviderModel } from "../providers/models.js";
import {
  createAgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
} from "../sdk/index.js";
import type { SessionManager } from "../storage/session-manager.js";
import type { HarnessTool } from "../tools/types.js";
import type { AgentSessionRuntimeDiagnostic } from "./agent-session-runtime.js";

export interface CreateAgentSessionServicesOptions {
  cwd: string;
  agentDir?: string;
  settingsManager?: SettingsManager;
  modelRuntime?: ModelRuntime;
  extensionFlagValues?: ReadonlyMap<string, boolean | string>;
  resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
  resourceLoaderReloadOptions?: ResourceLoaderReloadOptions;
}

export interface AgentSessionServices {
  cwd: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  settingsManager: SettingsManager;
  resourceLoader: ResourceLoader;
  diagnostics: AgentSessionRuntimeDiagnostic[];
}

export interface CreateAgentSessionFromServicesOptions {
  services: AgentSessionServices;
  sessionManager: SessionManager;
  sessionStartEvent?: SessionStartEvent;
  model?: ProviderModel;
  thinkingLevel?: ThinkingLevel;
  scopedModels?: Array<{ model: ProviderModel; thinkingLevel?: ThinkingLevel }>;
  tools?: string[];
  excludeTools?: CreateAgentSessionOptions["excludeTools"];
  noTools?: CreateAgentSessionOptions["noTools"];
  customTools?: HarnessTool[];
  toolBackend?: CreateAgentSessionOptions["toolBackend"];
}

export async function createAgentSessionServices(
  options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
  const cwd = resolve(options.cwd);
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
  const modelRuntime = options.modelRuntime ?? await ModelRuntime.create({
    authPath: resolve(agentDir, "auth.json"),
    modelsPath: resolve(agentDir, "model-providers.json"),
  });
  const resourceLoader = new DefaultResourceLoader({
    ...(options.resourceLoaderOptions ?? {}),
    cwd,
    agentDir,
    settingsManager,
  });
  await resourceLoader.reload(options.resourceLoaderReloadOptions);

  const extensionsResult = resourceLoader.getExtensions();
  const extensionHost = getExtensionRuntimeHost(extensionsResult.runtime);
  const diagnostics: AgentSessionRuntimeDiagnostic[] = (extensionHost?.diagnostics() ?? []).map((entry) => ({
    type: "warning",
    message: entry.message,
  }));
  if (options.extensionFlagValues !== undefined) {
    for (const [name, value] of options.extensionFlagValues) {
      try {
        extensionsResult.runtime.flagValues.set(name, value);
        extensionHost?.setFlagValue(name, value);
      } catch (error) {
        diagnostics.push({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics };
}

export async function createAgentSessionFromServices(
  options: CreateAgentSessionFromServicesOptions,
): Promise<CreateAgentSessionResult> {
  return await createAgentSession({
    cwd: options.services.cwd,
    agentDir: options.services.agentDir,
    modelRuntime: options.services.modelRuntime,
    resourceLoader: options.services.resourceLoader,
    settingsManager: options.services.settingsManager,
    sessionManager: options.sessionManager,
    ...(options.sessionStartEvent === undefined ? {} : { sessionStartEvent: options.sessionStartEvent }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
    ...(options.scopedModels === undefined ? {} : { scopedModels: options.scopedModels }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.excludeTools === undefined ? {} : { excludeTools: options.excludeTools }),
    ...(options.noTools === undefined ? {} : { noTools: options.noTools }),
    ...(options.customTools === undefined ? {} : { customTools: options.customTools }),
    ...(options.toolBackend === undefined ? {} : { toolBackend: options.toolBackend }),
  });
}
