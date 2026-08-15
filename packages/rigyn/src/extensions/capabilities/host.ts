import type { CustomMessage, Usage } from "@rigyn/kernel";
import type { Api, Model } from "@rigyn/models";

import type { ThinkingLevel } from "../../core/settings-manager.js";
import type { ReadonlyExtensionSessionManager } from "../session-contract.js";
import type { ExtensionModelRegistry } from "../model-boundary.js";
import type {
  RuntimeDirectAutocompleteProviderFactory,
  RuntimeDirectBackgroundFactory,
  RuntimeDirectEditorFactory,
  RuntimeDirectFooterFactory,
  RuntimeDirectTerminalInputHandler,
  RuntimeDirectUiContext,
  RuntimeDirectWidgetOptions,
  RuntimeDirectWorkingIndicatorOptions,
  RuntimeDiscoveryView,
} from "../runtime.js";

export type ExtensionMode = "tui" | "rpc" | "json" | "print" | "serve" | "sdk";
export type InputSource = "interactive" | "rpc" | "serve" | "extension";
export type ModelSelectSource = "set" | "cycle" | "restore" | "run";

export type ExtensionUIContext = RuntimeDirectUiContext;
export type ExtensionUIDialogOptions = Parameters<ExtensionUIContext["select"]>[2];
export type WorkingIndicatorOptions = RuntimeDirectWorkingIndicatorOptions;
export type ExtensionWidgetOptions = RuntimeDirectWidgetOptions;
export type TerminalInputHandler = RuntimeDirectTerminalInputHandler;
export type AutocompleteProviderFactory = RuntimeDirectAutocompleteProviderFactory;
export type EditorFactory = RuntimeDirectEditorFactory;
export type BackgroundFactory = RuntimeDirectBackgroundFactory;
export type FooterFactory = RuntimeDirectFooterFactory;
export type DiscoveryView = RuntimeDiscoveryView;
export type DiscoverableResource = RuntimeDiscoveryView["resources"][number];

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface CompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter: number;
  details?: unknown;
  usage?: Usage;
}

export interface CompactOptions {
  customInstructions?: string;
  onComplete?(result: CompactionResult): void;
  onError?(error: Error): void;
}

export interface ExtensionDataPaths {
  readonly userData: string;
  readonly workspaceData: string;
}

export interface ExtensionScopedModel {
  readonly model: Model<Api>;
  readonly thinkingLevel?: ThinkingLevel;
}

interface ExtensionContextOperations {
  abort(): void;
  compact(options?: CompactOptions): void;
  getContextUsage(): ContextUsage | undefined;
  getSystemPrompt(): string;
  hasPendingMessages(): boolean;
  isIdle(): boolean;
  isProjectTrusted(): boolean;
  shutdown(): void;
}

/** Services that are valid for every direct extension callback. */
export interface ExtensionContext extends ExtensionContextOperations {
  readonly ui: ExtensionUIContext;
  readonly mode: ExtensionMode;
  readonly hasUI: boolean;
  readonly cwd: string;
  readonly paths: ExtensionDataPaths;
  readonly signal: AbortSignal | undefined;
  readonly sessionManager: ReadonlyExtensionSessionManager;
  readonly modelRegistry: ExtensionModelRegistry;
  readonly model: Model<Api> | undefined;
  readonly scopedModels: readonly ExtensionScopedModel[];
  readonly thinkingLevel: ThinkingLevel;
}

export interface ExecOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeout?: number;
}

export interface ExecResult {
  code: number;
  killed: boolean;
  stderr: string;
  stdout: string;
}

export interface CustomMessageDeliveryOptions {
  triggerTurn?: boolean;
  deliverAs?: "steer" | "followUp" | "nextTurn";
}

export interface UserMessageDeliveryOptions {
  deliverAs?: "steer" | "followUp";
}

export type ExtensionMessage = Pick<CustomMessage, "customType" | "content" | "display" | "details">;

export type {
  AppKeybinding,
} from "../../tui/public-components.js";
export type { AppKeybindings, KeybindingsManager } from "../../tui/keybindings.js";
export type {
  ExtensionConfigDataRoots,
  ExtensionConfigReadOptions,
  ExtensionConfigScope,
  ExtensionConfigSnapshot,
  ExtensionConfigStore,
  ExtensionConfigStoreOptions,
  ExtensionConfigWriteOptions,
} from "../config-store.js";
export type {
  ExtensionProcessId,
  ExtensionProcessOutputMode,
  ExtensionProcessReadResult,
  ExtensionProcessResult,
  ExtensionProcessService,
  ExtensionProcessSpec,
  ExtensionProcessState,
  ExtensionProcessStatus,
  ExtensionProcessWaitOptions,
} from "../../process/managed-process.js";
