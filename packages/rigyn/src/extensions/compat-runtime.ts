import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";

import type { Api, ImageContent, Model, Provider, TextContent } from "@rigyn/models";
import type { KeyId, KeybindingsConfig } from "@rigyn/terminal";

import type { ResourceDiagnostic } from "../core/diagnostics.js";
import type { JsonValue } from "../core/json.js";
import type { BuildSystemPromptOptions } from "../core/system-prompt.js";
import { ModelRegistry } from "../providers/model-registry.js";
import { runProcess } from "../process/runner.js";
import { SessionManager } from "../storage/session-manager.js";
import { createTheme } from "../tui/theme.js";
import {
  extensionModelRegistry,
  type ExtensionModelRegistry,
} from "./model-boundary.js";
import {
  canonicalAgentMessages,
  canonicalMessage,
  canonicalUsage,
  extensionCanonicalMessages,
  extensionMessage,
  extensionSessionManager,
  extensionUsage,
} from "./session-contract.js";
import {
  RuntimeExtensionHost,
  type RuntimeDirectActionsHandler,
  type RuntimeDirectCompactOptions,
  type RuntimeDirectReplacementContext,
  type RuntimeExtensionEvent,
  type RuntimeRunScope,
} from "./runtime.js";
import type {
  BeforeAgentStartEventResult,
  BeforeProviderHeadersEvent,
  BeforeProviderRequestEvent,
  CompactOptions,
  ContextUsage,
  Extension,
  ExtensionActions,
  ExtensionCommandContext,
  ExtensionCommandContextActions,
  ExtensionContext,
  ExtensionContextActions,
  ExtensionError,
  ExtensionEvent,
  ExtensionFlag,
  ExtensionMode,
  ExtensionRuntime,
  ExtensionShortcut,
  ExtensionUIContext,
  InputEventResult,
  InputSource,
  MessageEndEvent,
  MessageRenderer,
  EntryRenderer,
  ProviderConfig,
  ReplacedSessionContext,
  RegisteredTool,
  ResolvedCommand,
  SessionBeforeCompactResult,
  SessionBeforeForkResult,
  SessionBeforeSwitchResult,
  SessionBeforeTreeResult,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  ToolResultEventResult,
  UserBashEvent,
  UserBashEventResult,
} from "./direct.js";

interface CompatibilityRuntimeRecord {
  host?: RuntimeExtensionHost;
}

const compatibilityRuntimes = new WeakMap<ExtensionRuntime, CompatibilityRuntimeRecord>();
const extensionRuntimeOwners = new WeakMap<Extension, RuntimeExtensionHost>();

function runtimeRecord(runtime: ExtensionRuntime): CompatibilityRuntimeRecord {
  let selected = compatibilityRuntimes.get(runtime);
  if (selected === undefined) {
    selected = {};
    compatibilityRuntimes.set(runtime, selected);
  }
  return selected;
}

/** Internal bridge used by the loader to attach a public runtime to its one native authority. */
export function attachExtensionRuntimeHost(runtime: ExtensionRuntime, host: RuntimeExtensionHost): void {
  const record = runtimeRecord(runtime);
  if (record.host !== undefined && record.host !== host) {
    throw new Error("Extension runtime is already attached to another host generation");
  }
  record.host = host;
}

/** Internal bridge used by session composition; it is intentionally not exported from the package root. */
export function getExtensionRuntimeHost(runtime: ExtensionRuntime): RuntimeExtensionHost | undefined {
  return runtimeRecord(runtime).host;
}

/** Creates the native authority lazily for a caller-supplied, otherwise empty runtime. */
export function ensureExtensionRuntimeHost(runtime: ExtensionRuntime, cwd: string): RuntimeExtensionHost {
  const existing = getExtensionRuntimeHost(runtime);
  if (existing !== undefined) return existing;
  const host = new RuntimeExtensionHost(cwd);
  attachExtensionRuntimeHost(runtime, host);
  return host;
}

/** Brands a loader-produced projection without creating a second execution registry. */
export function attachExtensionProjection(
  extension: Extension,
  runtime: ExtensionRuntime,
): void {
  const host = getExtensionRuntimeHost(runtime);
  if (host === undefined) throw new Error("Extension runtime has no attached host generation");
  const owner = extensionRuntimeOwners.get(extension);
  if (owner !== undefined && owner !== host) throw new Error("Extension projection belongs to another host generation");
  extensionRuntimeOwners.set(extension, host);
}

/**
 * Creates the public pre-bind action bridge. Extension registration remains
 * owned by the native host attached later by a loader or runner.
 */
export function createExtensionRuntime(): ExtensionRuntime {
  let staleMessage: string | undefined;
  let runtime!: ExtensionRuntime;
  const assertActive = (): void => {
    if (staleMessage !== undefined) throw new Error(staleMessage);
  };
  const unavailable = (): never => {
    assertActive();
    throw new Error("Extension runtime actions are unavailable before the session host is bound");
  };

  runtime = {
    sendMessage: unavailable,
    sendUserMessage: unavailable,
    appendEntry: unavailable,
    setSessionName: unavailable,
    getSessionName: unavailable,
    setLabel: unavailable,
    getActiveTools: unavailable,
    getAllTools: unavailable,
    setActiveTools: unavailable,
    refreshTools: () => {},
    getCommands: unavailable,
    setModel: async () => {
      assertActive();
      throw new Error("Extension runtime actions are unavailable before the session host is bound");
    },
    getThinkingLevel: unavailable,
    setThinkingLevel: unavailable,
    flagValues: new Map(),
    pendingProviderRegistrations: [],
    pendingNativeProviderRegistrations: [],
    assertActive,
    invalidate(message) {
      staleMessage ??= message ?? "Extension runtime context is stale after session replacement or reload";
    },
    registerProvider(name, config, extensionPath = "<unknown>") {
      assertActive();
      runtime.pendingProviderRegistrations.push({ name, config, extensionPath });
    },
    registerNativeProvider(provider, extensionPath = "<unknown>") {
      assertActive();
      runtime.pendingNativeProviderRegistrations.push({ provider, extensionPath });
    },
    unregisterProvider(name) {
      assertActive();
      runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((entry) => entry.name !== name);
      runtime.pendingNativeProviderRegistrations = runtime.pendingNativeProviderRegistrations.filter(
        (entry) => entry.provider.id !== name,
      );
    },
  };
  compatibilityRuntimes.set(runtime, {});
  return runtime;
}

type RunnerEmitEvent = Exclude<
  ExtensionEvent,
  | ToolCallEvent
  | { type: "project_trust" }
  | ToolResultEvent
  | UserBashEvent
  | { type: "context" }
  | BeforeProviderRequestEvent
  | BeforeProviderHeadersEvent
  | { type: "before_agent_start" }
  | MessageEndEvent
  | { type: "resources_discover" }
  | { type: "input" }
>;

type RunnerEmitResult<TEvent extends RunnerEmitEvent> = TEvent extends { type: "session_before_switch" }
  ? SessionBeforeSwitchResult | undefined
  : TEvent extends { type: "session_before_fork" }
    ? SessionBeforeForkResult | undefined
    : TEvent extends { type: "session_before_compact" }
      ? SessionBeforeCompactResult | undefined
      : TEvent extends { type: "session_before_tree" }
        ? SessionBeforeTreeResult | undefined
        : undefined;

export type ExtensionErrorListener = (error: ExtensionError) => void;

const reservedShortcutActions = new Set([
  "app.interrupt",
  "app.clear",
  "app.exit",
  "app.suspend",
  "app.thinking.cycle",
  "app.model.cycleForward",
  "app.model.cycleBackward",
  "app.model.select",
  "app.tools.expand",
  "app.thinking.toggle",
  "app.editor.external",
  "app.message.copy",
  "app.message.followUp",
  "tui.input.submit",
  "tui.select.confirm",
  "tui.select.cancel",
  "tui.input.copy",
  "tui.editor.deleteToLineEnd",
]);

const fallbackTheme = createTheme("mono", { color: false, unicode: false });
const noUi: ExtensionUIContext = {
  select: async () => undefined,
  confirm: async () => false,
  input: async () => undefined,
  notify() {},
  onTerminalInput: () => () => {},
  setStatus() {},
  setWorkingMessage() {},
  setWorkingVisible() {},
  setWorkingIndicator() {},
  setHiddenThinkingLabel() {},
  setWidget() {},
  setFooter() {},
  setHeader() {},
  setTitle() {},
  custom: async () => undefined as never,
  pasteToEditor() {},
  setEditorText() {},
  getEditorText: () => "",
  editor: async () => undefined,
  addAutocompleteProvider() {},
  setEditorComponent() {},
  getEditorComponent: () => undefined,
  get theme() { return fallbackTheme; },
  getAllThemes: () => [],
  getTheme: () => undefined,
  setTheme: () => ({ success: false, error: "Interactive UI is unavailable" }),
  getToolsExpanded: () => false,
  setToolsExpanded() {},
};

function publicImages(images: readonly import("../core/types.js").ImageBlock[] | undefined): ImageContent[] | undefined {
  if (images === undefined) return undefined;
  return images.map((image) => ({
    type: "image",
    data: image.data ?? "",
    mimeType: image.mediaType,
  }));
}

function nativeImages(images: readonly ImageContent[] | undefined): import("../core/types.js").ImageBlock[] | undefined {
  if (images === undefined) return undefined;
  return images.map((image) => ({ type: "image", data: image.data, mediaType: image.mimeType }));
}

function publicContent(
  blocks: readonly (import("../core/types.js").TextBlock | import("../core/types.js").ImageBlock)[],
): Array<TextContent | ImageContent> {
  return blocks.map((block) => block.type === "text"
    ? { type: "text", text: block.text }
    : { type: "image", data: block.data ?? "", mimeType: block.mediaType });
}

function nativeContent(
  blocks: readonly (TextContent | ImageContent)[],
): Array<import("../core/types.js").TextBlock | import("../core/types.js").ImageBlock> {
  return blocks.map((block) => block.type === "text"
    ? { type: "text", text: block.text }
    : { type: "image", data: block.data, mediaType: block.mimeType });
}

/** Public runner facade over exactly one RuntimeExtensionHost generation. */
export class ExtensionRunner {
  readonly #extensions: Extension[];
  readonly #runtime: ExtensionRuntime;
  readonly #host: RuntimeExtensionHost;
  readonly #cwd: string;
  readonly #sessionManager: SessionManager;
  readonly #modelRegistry: ModelRegistry;
  readonly #publicSessionManager: ReturnType<typeof extensionSessionManager>;
  readonly #publicModelRegistry: ExtensionModelRegistry;
  readonly #errorListeners = new Set<ExtensionErrorListener>();
  #ui: ExtensionUIContext = noUi;
  #mode: ExtensionMode = "print";
  #shortcutDiagnostics: ResourceDiagnostic[] = [];
  #commandDiagnostics: ResourceDiagnostic[] = [];
  #getModel: () => Model<Api> | undefined = () => undefined;
  #isIdle: () => boolean = () => true;
  #isProjectTrusted: () => boolean = () => true;
  #getSignal: () => AbortSignal | undefined = () => undefined;
  #abort: () => void = () => {};
  #hasPendingMessages: () => boolean = () => false;
  #shutdown: () => void = () => {};
  #getContextUsage: () => ContextUsage | undefined = () => undefined;
  #compact: (options?: CompactOptions) => void = () => {};
  #getSystemPrompt: () => string = () => "";
  #getSystemPromptOptions: () => BuildSystemPromptOptions;
  #waitForIdle: () => Promise<void> = async () => {};
  #newSession: ExtensionCommandContextActions["newSession"] = async () => ({ cancelled: false });
  #fork: ExtensionCommandContextActions["fork"] = async () => ({ cancelled: false });
  #navigateTree: ExtensionCommandContextActions["navigateTree"] = async () => ({ cancelled: false });
  #switchSession: ExtensionCommandContextActions["switchSession"] = async () => ({ cancelled: false });
  #reload: ExtensionCommandContextActions["reload"] = async () => {};
  #staleMessage: string | undefined;
  #unsubscribeHostError: (() => void) | undefined;

  constructor(
    extensions: Extension[],
    runtime: ExtensionRuntime,
    cwd: string,
    sessionManager: SessionManager,
    modelRegistry: ModelRegistry,
  ) {
    this.#extensions = [...extensions];
    this.#runtime = runtime;
    this.#cwd = cwd;
    this.#sessionManager = sessionManager;
    this.#modelRegistry = modelRegistry;
    this.#publicSessionManager = extensionSessionManager(sessionManager);
    this.#publicModelRegistry = extensionModelRegistry(modelRegistry);
    this.#getSystemPromptOptions = () => ({ cwd: this.#cwd });
    this.#host = ensureExtensionRuntimeHost(runtime, cwd);
    for (const extension of extensions) {
      const owner = extensionRuntimeOwners.get(extension);
      if (owner !== undefined && owner !== this.#host) {
        throw new Error(`Extension projection belongs to another host generation: ${extension.path}`);
      }
    }
    const observable = this.#host as RuntimeExtensionHost & {
      onError?: (listener: (entry: { sourcePath?: string; message: string; event?: string }) => void) => () => void;
    };
    this.#unsubscribeHostError = observable.onError?.((entry) => this.emitError({
      extensionPath: entry.sourcePath ?? "<runtime>",
      event: /^Runtime ([a-z_]+) handler failed:/u.exec(entry.message)?.[1] ?? "runtime",
      error: entry.message,
    }));
    this.#installStandaloneHostBridge();
  }

  bindCore(
    actions: ExtensionActions,
    contextActions: ExtensionContextActions,
    providerActions?: {
      registerProvider?: (name: string, config: ProviderConfig) => void;
      registerNativeProvider?: (provider: Provider) => void;
      unregisterProvider?: (name: string) => void;
    },
  ): void {
    this.#assertActive();
    this.#runtime.sendMessage = (message, options) => {
      this.#assertActive();
      actions.sendMessage(message, options);
    };
    this.#runtime.sendUserMessage = (content, options) => {
      this.#assertActive();
      actions.sendUserMessage(content, options);
    };
    this.#runtime.appendEntry = (customType, data) => {
      this.#assertActive();
      actions.appendEntry(customType, data);
    };
    this.#runtime.setSessionName = (name) => {
      this.#assertActive();
      actions.setSessionName(name);
    };
    this.#runtime.getSessionName = () => {
      this.#assertActive();
      return actions.getSessionName();
    };
    this.#runtime.setLabel = (entryId, label) => {
      this.#assertActive();
      actions.setLabel(entryId, label);
    };
    this.#runtime.getActiveTools = () => {
      this.#assertActive();
      return actions.getActiveTools();
    };
    this.#runtime.getAllTools = () => {
      this.#assertActive();
      return actions.getAllTools();
    };
    this.#runtime.setActiveTools = (toolNames) => {
      this.#assertActive();
      actions.setActiveTools(toolNames);
    };
    this.#runtime.refreshTools = () => {
      this.#assertActive();
      actions.refreshTools();
    };
    this.#runtime.getCommands = () => {
      this.#assertActive();
      return actions.getCommands();
    };
    this.#runtime.setModel = (model) => {
      this.#assertActive();
      return actions.setModel(model);
    };
    this.#runtime.getThinkingLevel = () => {
      this.#assertActive();
      return actions.getThinkingLevel();
    };
    this.#runtime.setThinkingLevel = (level) => {
      this.#assertActive();
      actions.setThinkingLevel(level);
    };
    this.#getModel = contextActions.getModel;
    this.#isIdle = contextActions.isIdle;
    this.#isProjectTrusted = contextActions.isProjectTrusted;
    this.#getSignal = contextActions.getSignal;
    this.#abort = contextActions.abort;
    this.#hasPendingMessages = contextActions.hasPendingMessages;
    this.#shutdown = contextActions.shutdown;
    this.#getContextUsage = contextActions.getContextUsage;
    this.#compact = contextActions.compact;
    this.#getSystemPrompt = contextActions.getSystemPrompt;
    this.#getSystemPromptOptions = contextActions.getSystemPromptOptions ?? (() => ({ cwd: this.#cwd }));

    for (const pending of this.#runtime.pendingProviderRegistrations) {
      try {
        (providerActions?.registerProvider ?? ((name, config) => this.#publicModelRegistry.registerProvider(name, config)))(
          pending.name,
          pending.config,
        );
      } catch (cause) {
        this.#providerError(pending.extensionPath, cause);
      }
    }
    this.#runtime.pendingProviderRegistrations = [];
    for (const pending of this.#runtime.pendingNativeProviderRegistrations) {
      try {
        (providerActions?.registerNativeProvider ?? ((provider) => this.#publicModelRegistry.registerProvider(provider)))(
          pending.provider,
        );
      } catch (cause) {
        this.#providerError(pending.extensionPath, cause);
      }
    }
    this.#runtime.pendingNativeProviderRegistrations = [];
    this.#runtime.registerProvider = (name, config) => {
      this.#assertActive();
      (providerActions?.registerProvider ?? ((providerName, selected) => this.#publicModelRegistry.registerProvider(providerName, selected)))(
        name,
        config,
      );
    };
    this.#runtime.registerNativeProvider = (provider) => {
      this.#assertActive();
      (providerActions?.registerNativeProvider ?? ((selected) => this.#publicModelRegistry.registerProvider(selected)))(provider);
    };
    this.#runtime.unregisterProvider = (name) => {
      this.#assertActive();
      (providerActions?.unregisterProvider ?? ((providerName) => this.#publicModelRegistry.unregisterProvider(providerName)))(name);
    };
    this.#host.setHostContext({ projectTrusted: this.#isProjectTrusted() });
  }

  bindCommandContext(actions?: ExtensionCommandContextActions): void {
    this.#assertActive();
    this.#waitForIdle = actions?.waitForIdle ?? (async () => {});
    this.#newSession = actions?.newSession ?? (async () => ({ cancelled: false }));
    this.#fork = actions?.fork ?? (async () => ({ cancelled: false }));
    this.#navigateTree = actions?.navigateTree ?? (async () => ({ cancelled: false }));
    this.#switchSession = actions?.switchSession ?? (async () => ({ cancelled: false }));
    this.#reload = actions?.reload ?? (async () => {});
  }

  setUIContext(uiContext?: ExtensionUIContext, mode: ExtensionMode = "print"): void {
    this.#assertActive();
    this.#ui = uiContext ?? noUi;
    this.#mode = mode;
    this.#host.setHostContext({ mode });
    this.#host.setDirectUiHandler(() => this.#ui);
  }

  getUIContext(): ExtensionUIContext { return this.#ui; }
  hasUI(): boolean { return this.#ui !== noUi; }
  getExtensionPaths(): string[] { return this.#extensions.map((extension) => extension.path); }

  /** @internal Native generation used by first-party mode adapters. */
  getRuntimeHost(): RuntimeExtensionHost {
    this.#assertActive();
    return this.#host;
  }

  getAllRegisteredTools(): RegisteredTool[] {
    const tools = new Map<string, RegisteredTool>();
    for (const extension of this.#extensions) {
      for (const tool of extension.tools.values()) {
        if (!tools.has(tool.definition.name)) tools.set(tool.definition.name, tool);
      }
    }
    return [...tools.values()];
  }

  getToolDefinition(name: string): RegisteredTool["definition"] | undefined {
    return this.getAllRegisteredTools().find((tool) => tool.definition.name === name)?.definition;
  }

  getFlags(): Map<string, ExtensionFlag> {
    const flags = new Map<string, ExtensionFlag>();
    for (const extension of this.#extensions) {
      for (const [name, flag] of extension.flags) if (!flags.has(name)) flags.set(name, flag);
    }
    return flags;
  }

  setFlagValue(name: string, value: boolean | string): void {
    this.#assertActive();
    this.#runtime.flagValues.set(name, value);
    if (this.#host.flags().some((flag) => flag.name === name)) this.#host.setFlagValue(name, value);
  }

  getFlagValues(): Map<string, boolean | string> { return new Map(this.#runtime.flagValues); }

  getShortcuts(keybindings: KeybindingsConfig): Map<KeyId, ExtensionShortcut> {
    this.#shortcutDiagnostics = [];
    const builtins = new Map<string, { action: string; reserved: boolean }>();
    for (const [action, configured] of Object.entries(keybindings)) {
      for (const shortcut of configured === undefined ? [] : Array.isArray(configured) ? configured : [configured]) {
        const normalized = shortcut.toLowerCase();
        const reserved = reservedShortcutActions.has(action);
        if (builtins.get(normalized)?.reserved === true && !reserved) continue;
        builtins.set(normalized, { action, reserved });
      }
    }
    const addDiagnostic = (message: string, path: string): void => {
      this.#shortcutDiagnostics.push({ type: "warning", message, path });
      if (!this.hasUI()) console.warn(message);
    };
    const selected = new Map<KeyId, ExtensionShortcut>();
    for (const extension of this.#extensions) {
      for (const [shortcut, registration] of extension.shortcuts) {
        const normalized = shortcut.toLowerCase() as KeyId;
        const builtin = builtins.get(normalized);
        if (builtin?.reserved === true) {
          addDiagnostic(
            `Extension shortcut '${shortcut}' from ${registration.extensionPath} conflicts with built-in shortcut. Skipping.`,
            registration.extensionPath,
          );
          continue;
        }
        const previous = selected.get(normalized);
        if (builtin !== undefined) {
          addDiagnostic(
            `Extension shortcut conflict: '${shortcut}' is built-in shortcut for ${builtin.action} and ${registration.extensionPath}. Using ${registration.extensionPath}.`,
            registration.extensionPath,
          );
        }
        if (previous !== undefined) {
          addDiagnostic(
            `Extension shortcut conflict: '${shortcut}' registered by both ${previous.extensionPath} and ${registration.extensionPath}. Using ${registration.extensionPath}.`,
            registration.extensionPath,
          );
        }
        selected.set(normalized, registration);
      }
    }
    return selected;
  }

  getShortcutDiagnostics(): ResourceDiagnostic[] { return [...this.#shortcutDiagnostics]; }

  invalidate(message = "Extension runtime context is stale after session replacement or reload"): void {
    if (this.#staleMessage !== undefined) return;
    this.#staleMessage = message;
    const unsubscribeHostError = this.#unsubscribeHostError;
    this.#unsubscribeHostError = undefined;
    unsubscribeHostError?.();
    this.#runtime.invalidate(message);
  }

  onError(listener: ExtensionErrorListener): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  emitError(error: ExtensionError): void {
    for (const listener of this.#errorListeners) listener(error);
  }

  hasHandlers(eventType: string): boolean {
    return this.#extensions.some((extension) => (extension.handlers.get(eventType)?.length ?? 0) > 0)
      || this.#host.hasListeners(eventType as RuntimeExtensionEvent);
  }

  getMessageRenderer(customType: string): MessageRenderer | undefined {
    for (const extension of this.#extensions) {
      const renderer = extension.messageRenderers.get(customType);
      if (renderer !== undefined) return renderer;
    }
    return undefined;
  }

  getEntryRenderer(customType: string): EntryRenderer | undefined {
    for (const extension of this.#extensions) {
      const renderer = extension.entryRenderers?.get(customType);
      if (renderer !== undefined) return renderer;
    }
    return undefined;
  }

  getModelRegistry(): ModelRegistry { return this.#modelRegistry; }

  getRegisteredCommands(): ResolvedCommand[] {
    this.#commandDiagnostics = [];
    const commands = this.#extensions.flatMap((extension) => [...extension.commands.values()]);
    const counts = new Map<string, number>();
    for (const command of commands) counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
    const seen = new Map<string, number>();
    const used = new Set<string>();
    return commands.map((command) => {
      const occurrence = (seen.get(command.name) ?? 0) + 1;
      seen.set(command.name, occurrence);
      let invocationName = (counts.get(command.name) ?? 0) > 1 ? `${command.name}:${occurrence}` : command.name;
      if (used.has(invocationName)) {
        let suffix = occurrence;
        do {
          suffix += 1;
          invocationName = `${command.name}:${suffix}`;
        } while (used.has(invocationName));
      }
      used.add(invocationName);
      return { ...command, invocationName };
    });
  }

  getCommandDiagnostics(): ResourceDiagnostic[] { return [...this.#commandDiagnostics]; }
  getCommand(name: string): ResolvedCommand | undefined {
    return this.getRegisteredCommands().find((command) => command.invocationName === name);
  }

  shutdown(): void { this.#shutdown(); }
  getActiveTools(): string[] { this.#assertActive(); return this.#runtime.getActiveTools(); }

  createContext(): ExtensionContext {
    const runner = this;
    return {
      get ui() { runner.#assertActive(); return runner.#ui; },
      get mode() { runner.#assertActive(); return runner.#mode; },
      get hasUI() { runner.#assertActive(); return runner.hasUI(); },
      get cwd() { runner.#assertActive(); return runner.#cwd; },
      get sessionManager() { runner.#assertActive(); return runner.#publicSessionManager; },
      get modelRegistry() { runner.#assertActive(); return runner.#publicModelRegistry; },
      get model() { runner.#assertActive(); return runner.#getModel(); },
      isIdle: () => { runner.#assertActive(); return runner.#isIdle(); },
      isProjectTrusted: () => { runner.#assertActive(); return runner.#isProjectTrusted(); },
      get signal() { runner.#assertActive(); return runner.#getSignal(); },
      abort: () => { runner.#assertActive(); runner.#abort(); },
      hasPendingMessages: () => { runner.#assertActive(); return runner.#hasPendingMessages(); },
      shutdown: () => { runner.#assertActive(); runner.#shutdown(); },
      getContextUsage: () => { runner.#assertActive(); return runner.#getContextUsage(); },
      compact: (options) => { runner.#assertActive(); runner.#compact(options); },
      getSystemPrompt: () => { runner.#assertActive(); return runner.#getSystemPrompt(); },
    };
  }

  createCommandContext(): ExtensionCommandContext {
    const context = Object.defineProperties(
      {},
      Object.getOwnPropertyDescriptors(this.createContext()),
    ) as ExtensionCommandContext;
    context.getSystemPromptOptions = () => { this.#assertActive(); return this.#getSystemPromptOptions(); };
    context.waitForIdle = async () => { this.#assertActive(); await this.#waitForIdle(); };
    context.newSession = (...args: Parameters<ExtensionCommandContextActions["newSession"]>) => {
      this.#assertActive();
      return this.#newSession(...args);
    };
    context.fork = (...args: Parameters<ExtensionCommandContextActions["fork"]>) => {
      this.#assertActive();
      return this.#fork(...args);
    };
    context.navigateTree = (...args: Parameters<ExtensionCommandContextActions["navigateTree"]>) => {
      this.#assertActive();
      return this.#navigateTree(...args);
    };
    context.switchSession = (...args: Parameters<ExtensionCommandContextActions["switchSession"]>) => {
      this.#assertActive();
      return this.#switchSession(...args);
    };
    context.reload = () => { this.#assertActive(); return this.#reload(); };
    return context;
  }

  async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
    this.#assertActive();
    if (
      !this.#usesNativeHost()
      || event.type === "session_before_compact"
      || event.type === "session_before_tree"
    ) {
      const context = this.createContext();
      let result: unknown;
      for (const { extension, handler } of this.#handlersFor(event.type)) {
        try {
          const selected = await handler(event, context);
          if (
            selected !== undefined
            && (
              event.type === "session_before_switch"
              || event.type === "session_before_fork"
              || event.type === "session_before_compact"
              || event.type === "session_before_tree"
            )
          ) {
            result = selected;
            if ((selected as { cancel?: unknown }).cancel === true) return selected as RunnerEmitResult<TEvent>;
          }
        } catch (cause) {
          this.#handlerError(extension.path, event.type, cause);
        }
      }
      return result as RunnerEmitResult<TEvent>;
    }
    const scope = this.#scope();
    if (event.type === "session_before_switch") {
      return await this.#host.reduceSessionBeforeSwitch({
        reason: event.reason,
        ...(event.targetSessionFile === undefined ? {} : { targetThreadId: event.targetSessionFile }),
      }) as RunnerEmitResult<TEvent>;
    }
    if (event.type === "session_before_fork") {
      return await this.#host.reduceSessionBeforeFork({
        sourceThreadId: scope.threadId,
        sourceEventId: event.entryId,
        position: event.position,
      }) as RunnerEmitResult<TEvent>;
    }
    try {
      await this.#host.dispatch(event.type as RuntimeExtensionEvent, this.#dispatchPayload(event, scope) as never);
    } catch {
      // The native host already reports each handler failure through its diagnostic stream.
      // The public runner contract isolates those failures from the caller.
    }
    return undefined as RunnerEmitResult<TEvent>;
  }

  async emitMessageEnd(event: MessageEndEvent): Promise<import("@rigyn/kernel").AgentMessage | undefined> {
    if (!this.#usesNativeHost()) {
      const context = this.createContext();
      let currentMessage = event.message;
      let modified = false;
      for (const { extension, handler } of this.#handlersFor("message_end")) {
        try {
          const selected = await handler({ ...event, message: currentMessage }, context) as
            | { message?: import("@rigyn/kernel").AgentMessage }
            | undefined;
          if (selected?.message === undefined) continue;
          if (selected.message.role !== currentMessage.role) {
            this.emitError({
              extensionPath: extension.path,
              event: "message_end",
              error: "message_end handlers must return a message with the same role",
            });
            continue;
          }
          currentMessage = selected.message;
          modified = true;
        } catch (cause) {
          this.#handlerError(extension.path, "message_end", cause);
        }
      }
      return modified ? currentMessage : undefined;
    }
    const initial = canonicalMessage(event.message) as import("../core/types.js").CanonicalMessage;
    const reduced = await this.#host.reduceMessageEnd({ ...this.#scope(), message: initial });
    return isDeepStrictEqual(initial, reduced) ? undefined : extensionMessage(reduced);
  }

  async emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
    if (!this.#usesNativeHost()) {
      const context = this.createContext();
      const currentEvent: ToolResultEvent = { ...event };
      let modified = false;
      for (const { extension, handler } of this.#handlersFor("tool_result")) {
        try {
          const selected = await handler(currentEvent, context) as ToolResultEventResult | undefined;
          if (selected === undefined) continue;
          if (selected.content !== undefined) { currentEvent.content = selected.content; modified = true; }
          if (selected.details !== undefined) { currentEvent.details = selected.details; modified = true; }
          if (selected.isError !== undefined) { currentEvent.isError = selected.isError; modified = true; }
          if (selected.usage !== undefined) { currentEvent.usage = selected.usage; modified = true; }
        } catch (cause) {
          this.#handlerError(extension.path, "tool_result", cause);
        }
      }
      return modified
        ? {
            content: currentEvent.content,
            details: currentEvent.details,
            isError: currentEvent.isError,
            ...(currentEvent.usage === undefined ? {} : { usage: currentEvent.usage }),
          }
        : undefined;
    }
    const blocks = nativeContent(event.content);
    const imageBlocks = event.content.filter((block): block is ImageContent => block.type === "image");
    const result = {
      content: blocks.filter((block): block is import("../core/types.js").TextBlock => block.type === "text")
        .map((block) => block.text).join(""),
      contentBlocks: blocks,
      isError: event.isError,
      ...(event.usage === undefined ? {} : { usage: canonicalUsage(event.usage) }),
      ...(event.details === undefined ? {} : { metadata: event.details as JsonValue }),
      ...(imageBlocks.length === 0 ? {} : { images: nativeImages(imageBlocks)! }),
    };
    const reduced = await this.#host.reduceToolResult({
      ...this.#scope(),
      invocation: { callId: event.toolCallId, name: event.toolName, input: event.input as JsonValue, index: 0 },
      result,
    });
    if (isDeepStrictEqual(result, reduced)) return undefined;
    const content = publicContent(reduced.contentBlocks ?? [
      ...(reduced.content === "" ? [] : [{ type: "text" as const, text: reduced.content }]),
      ...(reduced.images ?? []),
    ]);
    return {
      content,
      details: reduced.metadata,
      isError: reduced.isError,
      ...(reduced.usage === undefined ? {} : { usage: extensionUsage(reduced.usage) }),
    };
  }

  async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
    if (!this.#usesNativeHost()) {
      const context = this.createContext();
      let result: ToolCallEventResult | undefined;
      for (const { handler } of this.#handlersFor("tool_call")) {
        const selected = await handler(event, context) as ToolCallEventResult | undefined;
        if (selected !== undefined) {
          result = selected;
          if (selected.block === true) return selected;
        }
      }
      return result;
    }
    const reduced = await this.#host.reduceToolCall({
      ...this.#scope(),
      callId: event.toolCallId,
      name: event.toolName,
      input: event.input as JsonValue,
      index: 0,
    });
    if (reduced.invocation.input !== event.input && reduced.invocation.input !== null
      && typeof reduced.invocation.input === "object" && !Array.isArray(reduced.invocation.input)) {
      const input = event.input as Record<string, unknown>;
      for (const name of Object.keys(input)) delete input[name];
      Object.assign(input, reduced.invocation.input);
    }
    return reduced.blocked
      ? { block: true, ...(reduced.reason === undefined ? {} : { reason: reduced.reason }) }
      : undefined;
  }

  async emitUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined> {
    if (!this.#usesNativeHost()) {
      const context = this.createContext();
      for (const { extension, handler } of this.#handlersFor("user_bash")) {
        try {
          const selected = await handler(event, context) as UserBashEventResult | undefined;
          if (selected !== undefined) return selected;
        } catch (cause) {
          this.#handlerError(extension.path, "user_bash", cause);
        }
      }
      return undefined;
    }
    const reduced = await this.#host.reduceBeforeUserShell({
      command: event.command,
      cwd: event.cwd,
      hidden: event.excludeFromContext,
    });
    if (reduced.action === "handled") {
      return {
        result: {
          output: reduced.result.text,
          ...(reduced.result.exitCode === null ? {} : { exitCode: reduced.result.exitCode }),
          cancelled: reduced.result.signal !== undefined,
          truncated: false,
        },
      };
    }
    return reduced.operations === undefined ? undefined : { operations: reduced.operations };
  }

  async emitContext(messages: import("@rigyn/kernel").AgentMessage[]): Promise<import("@rigyn/kernel").AgentMessage[]> {
    if (!this.#usesNativeHost()) {
      const context = this.createContext();
      let currentMessages = structuredClone(messages);
      for (const { extension, handler } of this.#handlersFor("context")) {
        try {
          const selected = await handler({ type: "context", messages: currentMessages }, context) as
            | { messages?: import("@rigyn/kernel").AgentMessage[] }
            | undefined;
          if (selected?.messages !== undefined) currentMessages = selected.messages;
        } catch (cause) {
          this.#handlerError(extension.path, "context", cause);
        }
      }
      return currentMessages;
    }
    const canonical = canonicalAgentMessages(messages);
    return extensionCanonicalMessages(await this.#host.reduceContext({ ...this.#scope(), messages: canonical }));
  }

  async emitBeforeProviderRequest(payload: unknown): Promise<unknown> {
    if (!this.#usesNativeHost()) {
      const context = this.createContext();
      let currentPayload = payload;
      for (const { extension, handler } of this.#handlersFor("before_provider_request")) {
        try {
          const selected = await handler({ type: "before_provider_request", payload: currentPayload }, context);
          if (selected !== undefined) currentPayload = selected;
        } catch (cause) {
          this.#handlerError(extension.path, "before_provider_request", cause);
        }
      }
      return currentPayload;
    }
    return await this.#host.applyBeforeProviderRequestPayload(payload as JsonValue);
  }

  async emitBeforeProviderHeaders(headers: Record<string, string | null>): Promise<Record<string, string | null>> {
    if (!this.#usesNativeHost()) {
      const context = this.createContext();
      for (const { extension, handler } of this.#handlersFor("before_provider_headers")) {
        try {
          await handler({ type: "before_provider_headers", headers }, context);
        } catch (cause) {
          this.#handlerError(extension.path, "before_provider_headers", cause);
        }
      }
      return headers;
    }
    return await this.#host.applyBeforeProviderHeaders(headers);
  }

  async emitBeforeAgentStart(
    prompt: string,
    images: ImageContent[] | undefined,
    systemPrompt: string,
    systemPromptOptions: BuildSystemPromptOptions,
  ): Promise<{ messages?: NonNullable<BeforeAgentStartEventResult["message"]>[]; systemPrompt?: string } | undefined> {
    if (!this.#usesNativeHost()) {
      let currentSystemPrompt = systemPrompt;
      const context = Object.defineProperties(
        {},
        Object.getOwnPropertyDescriptors(this.createContext()),
      ) as ExtensionContext;
      context.getSystemPrompt = () => { this.#assertActive(); return currentSystemPrompt; };
      const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];
      let systemPromptModified = false;
      for (const { extension, handler } of this.#handlersFor("before_agent_start")) {
        try {
          const selected = await handler({
            type: "before_agent_start",
            prompt,
            images,
            systemPrompt: currentSystemPrompt,
            systemPromptOptions,
          }, context) as BeforeAgentStartEventResult | undefined;
          if (selected?.message !== undefined) messages.push(selected.message);
          if (selected?.systemPrompt !== undefined) {
            currentSystemPrompt = selected.systemPrompt;
            systemPromptModified = true;
          }
        } catch (cause) {
          this.#handlerError(extension.path, "before_agent_start", cause);
        }
      }
      if (messages.length === 0 && !systemPromptModified) return undefined;
      return {
        ...(messages.length === 0 ? {} : { messages }),
        ...(systemPromptModified ? { systemPrompt: currentSystemPrompt } : {}),
      };
    }
    const selectedImages = nativeImages(images);
    const reduced = await this.#host.reduceBeforeAgentStart({
      ...this.#scope(),
      prompt,
      ...(selectedImages === undefined ? {} : { images: selectedImages }),
      systemPrompt,
      systemPromptOptions,
    });
    const messages = reduced.messages.map((message) => ({
      customType: message.customType,
      content: typeof message.content === "string" ? message.content : publicContent(message.content),
      display: message.display,
      ...(message.details === undefined ? {} : { details: message.details }),
    }));
    if (messages.length === 0 && reduced.systemPrompt === systemPrompt) return undefined;
    return {
      ...(messages.length === 0 ? {} : { messages }),
      ...(reduced.systemPrompt === systemPrompt ? {} : { systemPrompt: reduced.systemPrompt }),
    };
  }

  async emitResourcesDiscover(
    cwd: string,
    reason: "startup" | "reload",
  ): Promise<{
    skillPaths: Array<{ path: string; extensionPath: string }>;
    promptPaths: Array<{ path: string; extensionPath: string }>;
    themePaths: Array<{ path: string; extensionPath: string }>;
  }> {
    if (!this.#usesNativeHost()) {
      const context = this.createContext();
      const result = {
        skillPaths: [] as Array<{ path: string; extensionPath: string }>,
        promptPaths: [] as Array<{ path: string; extensionPath: string }>,
        themePaths: [] as Array<{ path: string; extensionPath: string }>,
      };
      for (const { extension, handler } of this.#handlersFor("resources_discover")) {
        try {
          const selected = await handler({ type: "resources_discover", cwd, reason }, context) as
            | { skillPaths?: string[]; promptPaths?: string[]; themePaths?: string[] }
            | undefined;
          for (const path of selected?.skillPaths ?? []) result.skillPaths.push({ path, extensionPath: extension.path });
          for (const path of selected?.promptPaths ?? []) result.promptPaths.push({ path, extensionPath: extension.path });
          for (const path of selected?.themePaths ?? []) result.themePaths.push({ path, extensionPath: extension.path });
        } catch (cause) {
          this.#handlerError(extension.path, "resources_discover", cause);
        }
      }
      return result;
    }
    const resources = await this.#host.discoverResources(reason);
    const convert = (entries: typeof resources.skillPaths) => entries.map((entry) => ({
      path: entry.path,
      extensionPath: entry.sourcePath,
    }));
    return {
      skillPaths: convert(resources.skillPaths),
      promptPaths: convert(resources.promptPaths),
      themePaths: convert(resources.themePaths),
    };
  }

  async emitInput(
    text: string,
    images: ImageContent[] | undefined,
    source: InputSource,
    streamingBehavior?: "steer" | "followUp",
  ): Promise<InputEventResult> {
    if (!this.#usesNativeHost()) {
      const context = this.createContext();
      let currentText = text;
      let currentImages = images;
      for (const { extension, handler } of this.#handlersFor("input")) {
        try {
          const selected = await handler({
            type: "input",
            text: currentText,
            images: currentImages,
            source,
            streamingBehavior,
          }, context) as InputEventResult | undefined;
          if (selected?.action === "handled") return selected;
          if (selected?.action === "transform") {
            currentText = selected.text;
            currentImages = selected.images ?? currentImages;
          }
        } catch (cause) {
          this.#handlerError(extension.path, "input", cause);
        }
      }
      return currentText !== text || currentImages !== images
        ? {
            action: "transform",
            text: currentText,
            ...(currentImages === undefined ? {} : { images: currentImages }),
          }
        : { action: "continue" };
    }
    const selectedImages = nativeImages(images);
    const reduced = await this.#host.reduceInput({
      threadId: this.#sessionManager.getSessionId(),
      branch: "main",
      text,
      ...(selectedImages === undefined ? {} : { images: selectedImages }),
      source,
      ...(streamingBehavior === undefined ? {} : { streamingBehavior }),
    });
    if (reduced.action !== "transform") return reduced;
    const outputImages = publicImages(reduced.images);
    return {
      action: "transform",
      text: reduced.text,
      ...(outputImages === undefined ? {} : { images: outputImages }),
    };
  }

  #usesNativeHost(): boolean {
    if (this.#extensions.length === 0) return this.#host.extensions().length > 0;
    return this.#extensions.every((extension) => extensionRuntimeOwners.get(extension) === this.#host);
  }

  #installStandaloneHostBridge(): void {
    const runner = this;
    const directActions: RuntimeDirectActionsHandler = {
      sendMessage(message, options) {
        runner.#assertActive();
        runner.#runtime.sendMessage({
          customType: message.customType,
          content: typeof message.content === "string" ? message.content : publicContent(message.content),
          display: message.display,
          ...(message.details === undefined ? {} : { details: message.details }),
        }, options);
      },
      sendUserMessage(content, options) {
        runner.#assertActive();
        runner.#runtime.sendUserMessage(
          typeof content === "string" ? content : publicContent(content),
          options,
        );
      },
      appendEntry(customType, data) {
        runner.#assertActive();
        runner.#runtime.appendEntry(customType, data);
      },
      setSessionName(name) {
        runner.#assertActive();
        runner.#runtime.setSessionName(name);
      },
      getSessionName() {
        runner.#assertActive();
        return runner.#runtime.getSessionName();
      },
      setLabel(entryId, label) {
        runner.#assertActive();
        runner.#runtime.setLabel(entryId, label);
      },
      async exec(command, args, options = {}) {
        runner.#assertActive();
        if (command.trim() === "" || command.includes("\0") || args.some((argument) => argument.includes("\0"))) {
          throw new Error("Direct extension command is invalid");
        }
        const timeoutMs = options.timeout ?? 600_000;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
          throw new Error("Direct extension timeout must be between 1 and 3600000 milliseconds");
        }
        const result = await runProcess({
          argv: [command, ...args],
          cwd: resolve(runner.#cwd, options.cwd ?? runner.#cwd),
          timeoutMs,
          outputLimitBytes: 8 * 1024 * 1024,
        }, options.signal ?? new AbortController().signal);
        return {
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
          code: result.exitCode ?? (result.cancelled || result.timedOut ? 1 : 0),
          killed: result.cancelled || result.timedOut || result.signal !== null,
        };
      },
      getActiveTools() {
        runner.#assertActive();
        return runner.#runtime.getActiveTools();
      },
      getAllTools() {
        runner.#assertActive();
        const active = new Set(runner.#runtime.getActiveTools());
        return runner.#runtime.getAllTools().map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.parameters as never,
          active: active.has(tool.name),
          executionMode: "parallel",
          owner: { kind: "host" },
          ...(tool.promptGuidelines === undefined ? {} : { promptGuidelines: [...tool.promptGuidelines] }),
        }));
      },
      setActiveTools(toolNames) {
        runner.#assertActive();
        runner.#runtime.setActiveTools(toolNames);
      },
      setModel(model) {
        runner.#assertActive();
        return runner.#runtime.setModel(model);
      },
      getThinkingLevel() {
        runner.#assertActive();
        return runner.#runtime.getThinkingLevel();
      },
      setThinkingLevel(level) {
        runner.#assertActive();
        runner.#runtime.setThinkingLevel(level as never);
      },
      registerProvider(providerOrName, config?) {
        runner.#assertActive();
        if (typeof providerOrName === "string") {
          if (config === undefined || config === null || typeof config !== "object") {
            throw new Error("Provider config is required when registering by name");
          }
          runner.#runtime.registerProvider(providerOrName, config as ProviderConfig);
          return;
        }
        runner.#runtime.registerNativeProvider(providerOrName);
      },
      unregisterProvider(name) {
        runner.#assertActive();
        runner.#runtime.unregisterProvider(name);
      },
      getSystemPromptOptions() {
        runner.#assertActive();
        return runner.#getSystemPromptOptions();
      },
      waitForIdle() {
        runner.#assertActive();
        return runner.#waitForIdle();
      },
      newSession(options) {
        runner.#assertActive();
        if (options === undefined) return runner.#newSession();
        const withSession = options.withSession;
        return runner.#newSession({
          ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
          ...(options.setup === undefined ? {} : { setup: options.setup }),
          ...(withSession === undefined ? {} : {
            withSession: async (context) => await withSession(runner.#directReplacementContext(context)),
          }),
        });
      },
      fork(entryId, options) {
        runner.#assertActive();
        if (options === undefined) return runner.#fork(entryId);
        const withSession = options.withSession;
        return runner.#fork(entryId, {
          ...(options.position === undefined ? {} : { position: options.position }),
          ...(withSession === undefined ? {} : {
            withSession: async (context) => await withSession(runner.#directReplacementContext(context)),
          }),
        });
      },
      navigateTree(targetId, options) {
        runner.#assertActive();
        return runner.#navigateTree(targetId, options);
      },
      switchSession(sessionPath, options) {
        runner.#assertActive();
        if (options === undefined) return runner.#switchSession(sessionPath);
        const withSession = options.withSession;
        return runner.#switchSession(sessionPath, {
          ...(withSession === undefined ? {} : {
            withSession: async (context) => await withSession(runner.#directReplacementContext(context)),
          }),
        });
      },
      reload() {
        runner.#assertActive();
        return runner.#reload();
      },
    };
    this.#host.setDirectActionsHandler(directActions);
    this.#host.setDirectContextHandler((_target, signal) => {
      runner.#assertActive();
      signal.throwIfAborted();
      const selected = runner.#getModel();
      const model = selected === undefined
        ? undefined
        : runner.#modelRegistry.find(selected.provider, selected.id);
      return {
        sessionManager: runner.#publicSessionManager,
        modelRegistry: runner.#modelRegistry,
        ...(model === undefined ? {} : { model }),
        isIdle: () => runner.#isIdle(),
        hasPendingMessages: () => runner.#hasPendingMessages(),
        abort: () => runner.#abort(),
        shutdown: () => runner.#shutdown(),
        getContextUsage: () => runner.#getContextUsage(),
        compact: (options) => runner.#compact(runner.#publicCompactOptions(
          options,
          () => runner.#sessionManager.getSessionId(),
        )),
        getSystemPrompt: () => runner.#getSystemPrompt(),
      };
    });
    this.#host.setHostContext({ mode: this.#mode, projectTrusted: this.#isProjectTrusted() });
    this.#host.setDirectUiHandler(() => this.#ui);
  }

  #publicCompactOptions(
    options: RuntimeDirectCompactOptions | undefined,
    getThreadId: () => string,
  ): CompactOptions | undefined {
    if (options === undefined) return undefined;
    return {
      ...(options.customInstructions === undefined ? {} : { customInstructions: options.customInstructions }),
      ...(options.onComplete === undefined ? {} : {
        onComplete: (result) => options.onComplete?.({
          ...result,
          threadId: getThreadId(),
          branch: "main",
        }),
      }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
    };
  }

  #directReplacementContext(context: ReplacedSessionContext): RuntimeDirectReplacementContext {
    const runner = this;
    const wrapSession = (
      callback: ((selected: RuntimeDirectReplacementContext) => Promise<void>) | undefined,
    ): ((selected: ReplacedSessionContext) => Promise<void>) | undefined => callback === undefined
      ? undefined
      : async (selected) => await callback(runner.#directReplacementContext(selected));
    return {
      cwd: context.cwd,
      signal: context.signal,
      mode: context.mode,
      hasUI: context.hasUI,
      isProjectTrusted: () => context.isProjectTrusted(),
      ui: context.ui,
      sessionManager: context.sessionManager,
      modelRegistry: context.modelRegistry,
      model: context.model,
      isIdle: () => context.isIdle(),
      hasPendingMessages: () => context.hasPendingMessages(),
      abort: () => context.abort(),
      shutdown: () => context.shutdown(),
      getContextUsage: () => context.getContextUsage(),
      compact(options) {
        context.compact(runner.#publicCompactOptions(
          options,
          () => context.sessionManager.getSessionId(),
        ));
      },
      getSystemPrompt: () => context.getSystemPrompt(),
      getSystemPromptOptions: () => context.getSystemPromptOptions(),
      waitForIdle: async () => await context.waitForIdle(),
      newSession: async (options) => {
        if (options === undefined) return await context.newSession();
        const withSession = wrapSession(options.withSession);
        return await context.newSession({
          ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
          ...(options.setup === undefined ? {} : { setup: options.setup }),
          ...(withSession === undefined ? {} : { withSession }),
        });
      },
      fork: async (entryId, options) => {
        if (options === undefined) return await context.fork(entryId);
        const withSession = wrapSession(options.withSession);
        return await context.fork(entryId, {
          ...(options.position === undefined ? {} : { position: options.position }),
          ...(withSession === undefined ? {} : { withSession }),
        });
      },
      navigateTree: async (targetId, options) => await context.navigateTree(targetId, options),
      switchSession: async (sessionPath, options) => {
        if (options === undefined) return await context.switchSession(sessionPath);
        const withSession = wrapSession(options.withSession);
        return await context.switchSession(sessionPath, withSession === undefined ? {} : { withSession });
      },
      reload: async () => await context.reload(),
      async sendMessage(message, options) {
        await context.sendMessage({
          customType: message.customType,
          content: typeof message.content === "string" ? message.content : publicContent(message.content),
          display: message.display,
          ...(message.details === undefined ? {} : { details: message.details }),
        }, options);
      },
      async sendUserMessage(content, options) {
        await context.sendUserMessage(
          typeof content === "string" ? content : publicContent(content),
          options,
        );
      },
    };
  }

  #handlersFor(eventType: string): Array<{
    extension: Extension;
    handler: (...args: unknown[]) => Promise<unknown>;
  }> {
    const handlers: Array<{
      extension: Extension;
      handler: (...args: unknown[]) => Promise<unknown>;
    }> = [];
    for (const extension of this.#extensions) {
      for (const handler of extension.handlers.get(eventType) ?? []) handlers.push({ extension, handler });
    }
    return handlers;
  }

  #handlerError(extensionPath: string, event: string, cause: unknown): void {
    this.emitError({
      extensionPath,
      event,
      error: cause instanceof Error ? cause.message : String(cause),
      ...(cause instanceof Error && cause.stack !== undefined ? { stack: cause.stack } : {}),
    });
  }

  #assertActive(): void {
    if (this.#staleMessage !== undefined) throw new Error(this.#staleMessage);
    this.#runtime.assertActive();
  }

  #providerError(extensionPath: string, cause: unknown): void {
    this.emitError({
      extensionPath,
      event: "register_provider",
      error: cause instanceof Error ? cause.message : String(cause),
      ...(cause instanceof Error && cause.stack !== undefined ? { stack: cause.stack } : {}),
    });
  }

  #scope(): RuntimeRunScope {
    return {
      threadId: this.#sessionManager.getSessionId(),
      branch: "main",
      runId: "compatibility-runner",
      step: 1,
    };
  }

  #dispatchPayload(event: RunnerEmitEvent, scope: RuntimeRunScope): unknown {
    const { type: _type, ...payload } = event;
    if (event.type === "session_start" || event.type === "session_shutdown") return payload;
    if (event.type === "session_info_changed") return { ...payload, threadId: scope.threadId, branch: scope.branch };
    if (event.type === "agent_start") {
      const model = this.#getModel();
      return { ...scope, provider: model?.provider ?? "compatibility", model: model?.id ?? "compatibility" };
    }
    if (event.type === "agent_end") {
      return {
        ...scope,
        outcome: { status: "completed", finishReason: "stop" },
        messages: canonicalAgentMessages(event.messages),
        messagesTruncated: false,
      };
    }
    if (event.type === "agent_settled") {
      return {
        ...scope,
        outcome: { status: "completed", finishReason: "stop" },
        messages: [],
        messagesTruncated: false,
      };
    }
    if (event.type === "message_start") return { ...scope, message: canonicalMessage(event.message) };
    if (event.type === "message_update") {
      return { ...scope, step: 1, message: canonicalMessage(event.message), assistantMessageEvent: event.assistantMessageEvent };
    }
    if (event.type === "model_select") {
      return {
        threadId: scope.threadId,
        branch: scope.branch,
        provider: event.model.provider,
        model: event.model.id,
        ...(event.previousModel === undefined ? {} : {
          previousModel: { provider: event.previousModel.provider, model: event.previousModel.id },
        }),
        source: event.source,
      };
    }
    if (event.type === "thinking_level_select") {
      return { threadId: scope.threadId, branch: scope.branch, level: event.level, previousLevel: event.previousLevel, source: "set" };
    }
    return { ...scope, ...payload };
  }
}
