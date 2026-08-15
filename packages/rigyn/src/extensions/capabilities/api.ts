import type { Api, Model, Provider } from "@rigyn/models";

import type { BuildSystemPromptOptions } from "../../core/system-prompt.js";
import type { CompactOptions, ContextUsage, ExtensionScopedModel } from "./host.js";
import type { ProviderConfig } from "./provider.js";
import type {
  ExtensionCatalogActions,
  ExtensionCatalogCapabilities,
} from "./internal/api/catalog.js";
import type { ExtensionLifecycleCapabilities } from "./internal/api/lifecycle.js";
import type { ExtensionRegistrationCapabilities } from "./internal/api/registration.js";
import type {
  ExtensionSessionActions,
  ExtensionSessionCapabilities,
} from "./internal/api/session.js";
import type {
  Extension,
  PendingNativeProviderRegistration,
  PendingProviderRegistration,
} from "./internal/api/state.js";

/** Registration and live-session capabilities exposed to one direct extension. */
export interface ExtensionAPI extends
  ExtensionLifecycleCapabilities,
  ExtensionRegistrationCapabilities,
  ExtensionSessionCapabilities,
  ExtensionCatalogCapabilities {}

export type ExtensionFactory = (rigyn: ExtensionAPI) => void | Promise<void>;
export type InlineExtension = ExtensionFactory | { name: string; factory: ExtensionFactory; hidden?: boolean };

export type { Extension, ExtensionError } from "./internal/api/state.js";

/** Host callbacks consumed by the compatibility facade. */
export interface ExtensionActions extends ExtensionSessionActions, ExtensionCatalogActions {
  refreshTools(): void;
}

interface ExtensionContextStateActions {
  getModel(): Model<Api> | undefined;
  getScopedModels?(): readonly ExtensionScopedModel[];
  getSignal(): AbortSignal | undefined;
  getContextUsage(): ContextUsage | undefined;
  getSystemPrompt(): string;
  getSystemPromptOptions?(): BuildSystemPromptOptions;
}

interface ExtensionContextControlActions {
  abort(): void;
  compact(options?: CompactOptions): void;
  hasPendingMessages(): boolean;
  isIdle(): boolean;
  isProjectTrusted(): boolean;
  shutdown(): void;
}

export interface ExtensionContextActions extends ExtensionContextControlActions, ExtensionContextStateActions {}

export interface ExtensionRuntime extends ExtensionActions {
  flagValues: Map<string, boolean | string>;
  pendingProviderRegistrations: PendingProviderRegistration[];
  pendingNativeProviderRegistrations: PendingNativeProviderRegistration[];
  assertActive(): void;
  invalidate(message?: string): void;
  registerProvider(name: string, config: ProviderConfig, extensionPath?: string): void;
  registerNativeProvider(provider: Provider, extensionPath?: string): void;
  unregisterProvider(name: string): void;
}

export interface LoadExtensionsResult {
  extensions: Extension[];
  errors: Array<{ path: string; error: string }>;
  runtime: ExtensionRuntime;
}

export type { ExtensionCommandContextActions } from "./session.js";
