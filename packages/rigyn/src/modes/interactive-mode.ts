import type { ImageContent } from "@rigyn/models";

import { defaultSecretRedactor } from "../auth/redaction.js";
import { errorMessage } from "../core/errors.js";
import { SettingsManager } from "../core/settings-manager.js";
import type { ImageBlock } from "../core/types.js";
import type { ExtensionCommandContextActions } from "../extensions/direct.js";
import { extensionSessionManager } from "../extensions/session-contract.js";
import {
  bindInteractiveSessionPresentation,
  interactiveTranscriptHistory,
  interactiveTranscriptUsageBaseline,
} from "../interactive/session-presentation.js";
import { AnthropicApiBearerBillingWarning } from "../interactive/anthropic-warning.js";
import { REFRESH_RESOURCE_SUMMARY, renderInteractiveCommandHelp } from "../interactive/commands.js";
import { renderInteractiveResourceReport } from "../interactive/resource-report.js";
import { resolveModelsForScope, SCOPED_MODELS_NONE } from "../providers/model-scope.js";
import { modelCacheReadPrice } from "../providers/models.js";
import { providerLoginMethods, type ProviderLoginPath } from "../providers/login-path.js";
import type { AgentSession } from "../service/agent-session.js";
import type { AgentSessionRuntime } from "../service/agent-session-runtime.js";
import { TuiController, TuiSelectionCancelledError } from "../tui/controller.js";
import { rigynCompactSignature, rigynTerminalLockup } from "../tui/brand.js";
import { Keybindings as ConfiguredKeybindings, parseKeybindings } from "../tui/keybindings.js";
import type {
  PickerItem,
  ScopedModelSelection,
  TuiAction,
  TuiControllerOptions,
  TuiInputImageAttachment,
} from "../tui/types.js";
import {
  BoundedDeferredSubmissionQueue,
  classifyActiveSubmission,
  deliverActiveSubmission,
} from "../cli/active-submission.js";
import {
  applyInteractiveSetting,
  interactiveSettingItems,
  tuiOperatorPreferences,
} from "../cli/interactive-settings.js";
import {
  InteractiveCommandCoordinator,
  type InteractiveShellRequest,
} from "./interactive-command-coordinator.js";
import { interactiveSkillCommands } from "./interactive-command-items.js";
import { applyInteractiveThinking } from "./interactive-thinking.js";
import {
  dispatchActiveInteractiveResourceSlash,
  resolveInteractiveResourceSlash,
  type InteractiveResourceCatalog,
} from "./interactive-resource-commands.js";
import {
  dispatchInteractiveSubmissionAfterInterruption,
  interruptInteractiveRunForCommand,
  localInterruptionMarker,
  restoreInterruptedSubmission,
} from "./interactive-interruption-recovery.js";
import { createInteractiveTuiContext } from "./interactive-tui-context.js";
import {
  restoreAllQueuedMessages,
  restoreQueuedMessagesThenAbort,
} from "./interactive-queue.js";
import {
  beginInteractiveShellPresentation,
  runInteractiveShell,
  type InteractiveShellPresentation,
} from "./interactive-shell.js";
import { InteractiveSessionOperations } from "./interactive-session-operations.js";
import { attachClipboardImage } from "./interactive-terminal-actions.js";
import { bindInteractiveRuntimeUi, type InteractiveRuntimeUiBinding } from "./interactive-runtime-ui.js";
import { presentStartupChangelog, readPackageChangelog } from "./startup-changelog.js";
import { RIGYN_VERSION } from "../version.js";

export interface InteractiveModeOptions {
  verbose?: boolean;
  /** Applied only when the mode creates its terminal. */
  terminalOptions?: TuiControllerOptions;
  /** Optional terminal owner for embedding and deterministic tests. */
  terminal?: TuiController;
  initialMessages?: string[];
  initialImages?: ImageContent[];
  initialMessage?: string;
  autoTrustOnRefreshCwd?: string;
  modelFallbackMessage?: string;
  migratedProviders?: string[];
  /** Optional static extension commands and prompts exposed by the embedding host. */
  extensionCatalog?: InteractiveResourceCatalog;
}

type ModelSelectionOwner = {
  generation: number;
  controller: AbortController;
};

function canonicalImages(images: readonly ImageContent[] | undefined): ImageBlock[] | undefined {
  if (images === undefined) return undefined;
  return images.map((image) => ({ type: "image", data: image.data, mediaType: image.mimeType }));
}

function inputImages(images: readonly TuiInputImageAttachment[] | undefined): ImageBlock[] | undefined {
  if (images === undefined || images.length === 0) return undefined;
  return images.map((image) => ({ ...image.block }));
}

interface ModelPickerValue {
  provider: string;
  model: string;
  thinkingLevel?: string;
}

function modelItem(model: { provider: string; id: string; name?: string }): PickerItem<ModelPickerValue> {
  return {
    id: `${model.provider}/${model.id}`,
    label: model.name ?? model.id,
    detail: `${model.provider}/${model.id}`,
    keywords: [model.provider, model.id, model.name ?? ""],
    value: { provider: model.provider, model: model.id },
  };
}

function scopedModelCycleItems(
  items: readonly PickerItem<ModelPickerValue>[],
  scopedModels: readonly { model: { provider: string; id: string }; thinkingLevel?: string }[],
): PickerItem<ModelPickerValue>[] {
  const available = new Map(items.map((item) => [item.id, item]));
  return scopedModels.flatMap((entry) => {
    const item = available.get(`${entry.model.provider}/${entry.model.id}`);
    if (item === undefined) return [];
    return [{
      ...item,
      value: {
        ...item.value,
        ...(entry.thinkingLevel === undefined ? {} : { thinkingLevel: entry.thinkingLevel }),
      },
    }];
  });
}

const KEY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  escape: "Esc",
  enter: "Enter",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
});

function displayKey(value: string): string {
  return value.split("+").map((part) => KEY_NAMES[part] ?? (part.length === 1 ? part.toUpperCase() : part)).join("+");
}

function formatHotkeys(keybindings = new ConfiguredKeybindings()): string {
  const hint = (action: Parameters<ConfiguredKeybindings["keys"]>[0], maximum = 3) =>
    keybindings.keys(action).slice(0, maximum).map(displayKey).join("/");
  return [
    `${hint("app.interrupt")} interrupt`,
    `${hint("app.clear")} clear/exit`,
    `${hint("app.exit")} exit`,
    "/ commands",
  ].filter((value) => !value.startsWith(" ")).join(" · ");
}

function waitForInteractiveOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolveOperation, rejectOperation) => {
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => settle(() => rejectOperation(signal.reason));
    operation.then(
      (value) => settle(() => resolveOperation(value)),
      (error: unknown) => settle(() => rejectOperation(error)),
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Interactive terminal owner for an already-created session runtime. */
export class InteractiveMode {
  readonly #runtime: AgentSessionRuntime;
  readonly #options: InteractiveModeOptions;
  readonly #terminal: TuiController;
  readonly #operatorPreferenceOverrides: NonNullable<TuiControllerOptions["operatorPreferences"]>;
  readonly #doubleEscapeActionOverride: TuiControllerOptions["doubleEscapeAction"];
  readonly #coordinator: InteractiveCommandCoordinator<ImageBlock>;
  readonly #sessionOperations: InteractiveSessionOperations;
  #keybindings = new ConfiguredKeybindings();
  readonly #deferredSubmissions = new BoundedDeferredSubmissionQueue<ImageBlock>((image) =>
    Buffer.byteLength(image.data ?? image.url ?? "", "utf8"));
  #unsubscribe = (): void => undefined;
  #uiBinding: InteractiveRuntimeUiBinding | undefined;
  #sessionBindingAbort: AbortController | undefined;
  #boundSession: AgentSession | undefined;
  #initialized = false;
  #closed = false;
  #actionTail: Promise<void> = Promise.resolve();
  #activePrompt: Promise<void> | undefined;
  #modelRefresh: { controller: AbortController; operation: Promise<void> } | undefined;
  #modelSelectionGeneration = 0;
  #modelSelectionAbort: AbortController | undefined;
  readonly #modelSelectionOwners = new WeakMap<object, ModelSelectionOwner>();
  readonly #operationAborts = new Set<AbortController>();
  #treeSummaryCancel: (() => void) | undefined;
  #resolveExit: (() => void) | undefined;
  #exit: Promise<void> | undefined;
  #submissionOrder = 0;
  #drainingDeferred = false;
  #locallyInterruptedOperationId: string | undefined;
  readonly #pendingUserInputs: Array<{
    resolve(value: string): void;
    reject(error: Error): void;
  }> = [];
  readonly #anthropicApiBearerBillingWarning = new AnthropicApiBearerBillingWarning();

  constructor(runtime: AgentSessionRuntime, options: InteractiveModeOptions = {}) {
    this.#runtime = runtime;
    this.#options = options;
    const {
      doubleEscapeAction,
      operatorPreferences,
      ...terminalOptions
    } = options.terminalOptions ?? {};
    const settings = runtime.session.settingsManager;
    this.#operatorPreferenceOverrides = options.terminal === undefined ? operatorPreferences ?? {} : {};
    this.#doubleEscapeActionOverride = options.terminal === undefined ? doubleEscapeAction : undefined;
    this.#terminal = options.terminal ?? new TuiController({
      operatorPreferences: {
        ...tuiOperatorPreferences(settings),
        ...operatorPreferences,
      },
      doubleEscapeAction: doubleEscapeAction ?? settings.getDoubleEscapeAction(),
      ...terminalOptions,
      cacheReadPrice: options.terminalOptions?.cacheReadPrice ?? ((provider, model, promptTokens) => {
        try {
          const selected = this.#runtime.session.modelRegistry.find(provider, model);
          return selected === undefined ? undefined : modelCacheReadPrice(selected, promptTokens);
        } catch {
          return undefined;
        }
      }),
    });
    this.#sessionOperations = new InteractiveSessionOperations({
      runtime,
      terminal: this.#terminal,
      refreshTranscript: (refreshOptions) => {
        this.#terminal.replaceTranscript(interactiveTranscriptHistory(this.#runtime.session), "main", refreshOptions);
        const usage = interactiveTranscriptUsageBaseline(this.#runtime.session);
        this.#terminal.setUsageBaseline(
          usage.usage,
          usage.latestCacheHitRate,
          usage.latestCacheUsage,
          usage.reportedUsage,
        );
      },
      updateContext: () => this.#updateContext(),
      registerSummaryCancelHandler: (handler) => {
        this.#treeSummaryCancel = handler;
        return () => {
          if (this.#treeSummaryCancel === handler) this.#treeSummaryCancel = undefined;
        };
      },
    });
    this.#coordinator = this.#createCoordinator();
    this.#terminal.setActionHandler((action) => {
      if (action.type === "select" && action.picker === "model") this.#beginModelSelection(action);
      if (action.type === "cancel" || action.type === "exit" || action.type === "extension_shortcut" || action.type === "suspend") {
        void this.#coordinator.dispatchAction(action).catch((error: unknown) => this.#reportError(error));
        return;
      }
      this.#actionTail = this.#actionTail
        .then(async () => await this.#coordinator.dispatchAction(action))
        .catch((error: unknown) => this.#reportError(error));
    });
  }

  #createCoordinator(): InteractiveCommandCoordinator<ImageBlock> {
    return new InteractiveCommandCoordinator<ImageBlock>({
      commands: {
        quit: () => this.stop(),
        cancel: async () => await this.#cancelActiveRun("Cancelled by user"),
        login: async ({ args }) => {
          await this.#runOperation(async (signal) => await this.#login(args, signal));
        },
        logout: async ({ args }) => {
          await this.#runOperation(async (signal) => await this.#logout(args, signal));
        },
        model: async ({ args }) => {
          await this.#runOperation(async (signal) => await this.#chooseModel(args, signal));
        },
        thinking: ({ args }) => this.#setThinking(args),
        new: async () => {
          await this.#runOperation(async (signal) => await this.#sessionOperations.newSession(signal));
        },
        resume: async ({ args }) => {
          await this.#runOperation(async (signal) => await this.#sessionOperations.resume(args, signal));
        },
        recover: async ({ args }) => {
          await this.#runOperation(async (signal) => await this.#sessionOperations.recover(args, signal));
        },
        refresh: async () => {
          await this.#runOperation(async (signal) => await this.#refresh(signal));
        },
        name: async ({ args }) => await this.#sessionOperations.name(args),
        session: async () => await this.#sessionOperations.showSession(),
        tree: async () => {
          await this.#runOperation(async (signal) => await this.#sessionOperations.navigateTree(signal));
        },
        fork: async () => {
          await this.#runOperation(async (signal) => await this.#sessionOperations.forkSession(signal));
        },
        clone: async ({ args }) => {
          await this.#runOperation(async (signal) => await this.#sessionOperations.cloneSession(args, signal));
        },
        export: async ({ args }) => await this.#sessionOperations.exportSession(args, false),
        share: async ({ args }) => {
          await this.#runOperation(async (signal) => await this.#sessionOperations.shareSession(args, signal));
        },
        context: () => this.#sessionOperations.showContext(),
        resources: () => this.#showResources(),
        copy: async () => await this.#sessionOperations.copyLatestAssistant(),
        hotkeys: () => this.#showHotkeys(),
        compact: async ({ args }) => await this.#sessionOperations.compact(args),
        help: () => this.#terminal.notify(renderInteractiveCommandHelp()),
        settings: async () => await this.#showSettings(),
        "scoped-models": async () => await this.#showScopedModels(),
        changelog: async () => await this.#showChangelog(),
        import: async ({ args }) => {
          await this.#runOperation(async (signal) => await this.#sessionOperations.importSession(args, signal));
        },
        trust: async () => await this.#sessionOperations.saveProjectTrust(),
      },
      unknownCommand: ({ input, images }) => {
        const route = resolveInteractiveResourceSlash(
          this.#runtime.session,
          input,
          this.#options.extensionCatalog,
        );
        if (route === undefined) {
          this.#terminal.notify(`Unknown command: /${input.slice(1).trim().split(/\s/u, 1)[0] ?? ""}`, "error");
          return true;
        }
        this.#startPrompt(route.prompt, [...images]);
        return true;
      },
      submissions: {
        prompt: (text, images) => {
          if (images.length > 0 || !this.#resolveUserInput(text)) this.#startPrompt(text, [...images]);
        },
        shell: async (request) => {
          await this.#runOperation(async (signal) => await this.#runShell(request, signal));
        },
      },
      actions: {
        exit: () => this.stop(),
        error: (action) => this.#reportError(action.error),
        cancel: async () => await this.#cancelActiveRun("Cancelled by user"),
        submit: async (action) => {
          await this.#dispatchInteractiveSubmission(
            action.text,
            this.#actionImages(action),
            {
              text: action.text,
              ...(action.images === undefined ? {} : { images: action.images }),
              ...(action.recoveredImages === undefined ? {} : { recoveredImages: action.recoveredImages }),
            },
          );
        },
        activeSubmission: async (action) => await this.#dispatchInteractiveSubmission(
          action.type === "follow_up" ? `/follow ${action.text}` : action.text,
          this.#actionImages(action),
          {
            text: action.text,
            mode: action.type === "follow_up" ? "follow_up" : "steer",
            ...(action.images === undefined ? {} : { images: action.images }),
            ...(action.recoveredImages === undefined ? {} : { recoveredImages: action.recoveredImages }),
          },
        ),
        dequeue: () => this.#dequeueMessage(),
        queueRestoreDiscard: () => this.#updateContext(),
        modelCatalog: () => {
          this.#applyAvailableModels();
          this.#startModelRefresh();
        },
        sessionCatalog: async (action) => await this.#sessionOperations.handleCatalogAction(action),
        sessionMutation: async (action) => await this.#sessionOperations.handleMutation(action),
        selectSession: async (action) => {
          await this.#runOperation(async (signal) =>
            await this.#sessionOperations.switchSession(String(action.item.value), signal));
        },
        selectModel: async (action) => {
          const selection = this.#takeModelSelection(action);
          await this.#runOperation(async (signal) => await this.#selectModelItem(action.item, signal, selection));
        },
        command: (action) => this.#terminal.setEditorText(String(action.item.value)),
        copy: async () => await this.#sessionOperations.copyLatestAssistant(false),
        copyText: async (action) => await this.#terminal.copyToClipboard(action.text),
        cycleThinking: () => {
          if (this.#runtime.session.cycleThinkingLevel() === undefined) {
            this.#terminal.notify("The selected model does not expose configurable thinking levels", "status");
          }
          this.#updateContext();
        },
        toggleThinkingVisibility: () => { this.#terminal.toggleReasoning(); },
        extensionShortcut: async (action) => {
          await this.#runOperation(async (signal) =>
            await this.#runtime.session.extensionRunner.getRuntimeHost().runShortcut(action.shortcut, {
              threadId: this.#runtime.session.sessionId,
              signal: AbortSignal.any([signal, action.generation]),
              ui: undefined as never,
            }));
        },
        other: async (action) => {
          if (action.type === "paste_image") {
            await this.#runOperation(async (signal) => {
              await attachClipboardImage(this.#terminal, this.#runtime.session.settingsManager, signal);
            });
          } else if (action.type === "suspend") {
            this.#terminal.suspend();
          }
        },
      },
    });
  }

  /** Initialize the terminal and bind the current extension generation once. */
  async init(): Promise<void> {
    if (this.#closed) throw new Error("Interactive mode is closed");
    if (this.#initialized) return;
    this.#initialized = true;
    try {
      this.#keybindings = parseKeybindings(this.#runtime.session.settingsManager.getKeybindings());
      this.#terminal.setKeybindings(this.#keybindings);
      this.#terminal.start();
      this.#terminal.setStartup(
        `${rigynCompactSignature(RIGYN_VERSION, this.#terminal.capabilities.unicode)}\n/help commands`,
        `${rigynTerminalLockup(RIGYN_VERSION, this.#terminal.capabilities.unicode)}\n/exit quit · /cancel interrupt · /model choose · /refresh resources · !command shell`,
      );
      this.#terminal.setInterruptHandler(() => {
        if (this.#operationAborts.size > 0) {
          void this.#cancelActiveRun("Interrupted").catch((error: unknown) => this.#reportError(error));
          return true;
        }
        if (this.#runtime.session.isIdle) return false;
        const marker = localInterruptionMarker(this.#runtime.session);
        if (marker !== undefined) this.#locallyInterruptedOperationId = marker;
        void this.#cancelActiveRun("Interrupted").catch((error: unknown) => this.#reportError(error));
        return true;
      });
      this.#runtime.setBeforeSessionInvalidate(() => {
        this.#invalidateModelSelection(new Error("Session replaced"));
        this.#locallyInterruptedOperationId = undefined;
        this.#modelRefresh?.controller.abort(new Error("Session replaced"));
        this.#unbindSession();
      });
      this.#runtime.setRebindSession(async (session) => {
        this.#invalidateModelSelection(new Error("Session replaced"));
        this.#keybindings = parseKeybindings(session.settingsManager.getKeybindings());
        this.#terminal.setKeybindings(this.#keybindings);
        await this.#bindSession(true, session);
        this.#applyAvailableModels(session);
      });
      await this.#bindSession(true);
      if (this.#runtime.session.suspendedRun !== undefined) {
        this.#terminal.setInputBlocked("Recovering interrupted operation...", "recovery");
        try {
          await this.#sessionOperations.recoverAtStartup();
        } finally {
          this.#terminal.setInputBlocked();
        }
      }
      this.#applyAvailableModels();
      this.#startModelRefresh();
      await presentStartupChangelog(this.#runtime.session.settingsManager, (message) => this.#terminal.notify(message));
      await this.#maybeWarnAboutAnthropicApiBearerBilling();

      if ((this.#options.migratedProviders?.length ?? 0) > 0) {
        this.showWarning(`Migrated credentials: ${this.#options.migratedProviders!.join(", ")}`);
      }
      if (this.#options.modelFallbackMessage !== undefined) {
        this.showWarning(this.#options.modelFallbackMessage);
      }
    } catch (error) {
      const refresh = this.#modelRefresh;
      refresh?.controller.abort(new Error("Interactive initialization failed"));
      await refresh?.operation.catch(() => undefined);
      this.#runtime.setBeforeSessionInvalidate(undefined);
      this.#runtime.setRebindSession(undefined);
      this.#unbindSession();
      this.#terminal.setInputBlocked();
      this.#terminal.setInterruptHandler(undefined);
      this.#initialized = false;
      throw error;
    }
  }

  async run(): Promise<void> {
    await this.init();
    const initial = [this.#options.initialMessage, ...(this.#options.initialMessages ?? [])]
      .filter((message): message is string => message !== undefined && message.trim() !== "");
    for (let index = 0; index < initial.length && !this.#closed; index += 1) {
      try {
        const images = index === 0 ? canonicalImages(this.#options.initialImages) : undefined;
        await this.#runtime.session.prompt(initial[index]!, {
          ...(images === undefined ? {} : { images }),
          source: "interactive",
        });
      } catch (error) {
        this.#reportError(error);
      }
    }
    if (this.#closed) return;
    if (this.#exit === undefined) {
      this.#exit = new Promise<void>((resolve) => { this.#resolveExit = resolve; });
    }
    await this.#exit;
  }

  stop(): void {
    if (this.#closed) return;
    this.#invalidateModelSelection(new Error("Terminal closed"));
    this.#locallyInterruptedOperationId = undefined;
    this.#modelRefresh?.controller.abort(new Error("Terminal closed"));
    this.#abortOperations(new Error("Terminal closed"));
    for (const pending of this.#pendingUserInputs.splice(0)) pending.reject(new Error("Terminal closed"));
    this.#closed = true;
    this.#runtime.setBeforeSessionInvalidate(undefined);
    this.#runtime.setRebindSession(undefined);
    this.#unbindSession();
    this.#terminal.setInterruptHandler(undefined);
    this.#terminal.setActionHandler(undefined);
    this.#terminal.close();
    this.#resolveExit?.();
  }

  close(): void { this.stop(); }

  /** Rebuild the visible transcript from the active session branch. */
  renderInitialMessages(): void {
    this.#terminal.replaceTranscript(interactiveTranscriptHistory(this.#runtime.session), "main");
    const usage = interactiveTranscriptUsageBaseline(this.#runtime.session);
    this.#terminal.setUsageBaseline(
      usage.usage,
      usage.latestCacheHitRate,
      usage.latestCacheUsage,
      usage.reportedUsage,
    );
    this.#updateContext();
  }

  /** Wait for the next text-only prompt entered while the session is idle. */
  getUserInput(): Promise<string> {
    if (this.#closed) return Promise.reject(new Error("Interactive mode is closed"));
    return new Promise<string>((resolve, reject) => {
      this.#pendingUserInputs.push({ resolve, reject });
    });
  }

  clearEditor(): void { this.#terminal.setEditorText(""); }

  showError(message: string): void {
    this.#terminal.notify(defaultSecretRedactor.redact(message), "error");
  }

  showWarning(message: string): void { this.#terminal.notify(message, "warning"); }

  showNewVersionNotification(release: { version: string; packageName?: string; note?: string }): void {
    const lines = [
      `rigyn ${release.version} is available. Run rigyn self-update to update this installation.`,
      ...(release.packageName === undefined ? [] : [`Package: ${release.packageName}`]),
      ...(release.note?.trim() ? [release.note.trim()] : []),
    ];
    this.#terminal.notify(lines.join("\n"), "warning");
  }

  showPackageUpdateNotification(packages: string[]): void {
    if (packages.length === 0) return;
    this.#terminal.notify([
      "Package updates are available. Run rigyn update --all to install them.",
      ...packages.map((name) => `- ${name}`),
    ].join("\n"), "warning");
  }

  #commandItems(session: AgentSession): PickerItem<string>[] {
    const commands = session.extensionRunner.getRegisteredCommands().map((command): PickerItem<string> => ({
      id: `extension:${command.invocationName}`,
      label: `/${command.invocationName}`,
      value: `/${command.invocationName}`,
      ...(command.description === undefined ? {} : { detail: command.description }),
    }));
    const prompts = session.promptTemplates.map((prompt): PickerItem<string> => ({
      id: `prompt:${prompt.name}`,
      label: `/${prompt.name}`,
      value: `/${prompt.name}`,
      ...(prompt.description === undefined ? {} : { detail: prompt.description }),
    }));
    const skills = session.settingsManager.getEnableSkillCommands()
      ? interactiveSkillCommands(
          session.resourceLoader.getSkills().skills,
          session.promptTemplates.map((prompt) => prompt.name),
        ).map((skill): PickerItem<string> => ({
          id: `skill:${skill.name}`,
          label: `/skill:${skill.name}`,
          value: `/skill:${skill.name}`,
          detail: skill.description,
        }))
      : [];
    return [...commands, ...prompts, ...skills];
  }

  #commandActions(session: AgentSession): ExtensionCommandContextActions {
    return {
      waitForIdle: async () => await session.waitForIdle(),
      newSession: async (options = {}, signal) => await this.#runtime.newSession({
        ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
        ...(options.setup === undefined ? {} : {
          setup: async (manager) => await options.setup?.(extensionSessionManager(manager)),
        }),
        ...(options.withSession === undefined ? {} : {
          withSession: async (context) => await options.withSession?.(context),
        }),
        ...(signal === undefined ? {} : { signal }),
      }),
      fork: async (entryId, options = {}, signal) => await this.#runtime.fork(entryId, {
        ...(options.position === undefined ? {} : { position: options.position }),
        ...(options.withSession === undefined ? {} : {
          withSession: async (context) => await options.withSession?.(context),
        }),
        ...(signal === undefined ? {} : { signal }),
      }),
      navigateTree: async (targetId, options = {}, signal) => {
        signal?.throwIfAborted();
        const result = await session.navigateTree(targetId, options);
        signal?.throwIfAborted();
        return { cancelled: result.cancelled };
      },
      switchSession: async (sessionPath, options = {}, signal) => await this.#runtime.switchSession(sessionPath, {
        ...(options.withSession === undefined ? {} : {
          withSession: async (context) => await options.withSession?.(context),
        }),
        ...(signal === undefined ? {} : { signal }),
      }),
      refresh: async (signal) => await this.#refresh(signal),
    };
  }

  async #bindSession(start: boolean, session: AgentSession = this.#runtime.session): Promise<void> {
    this.#unbindSession();
    this.#terminal.setOperatorPreferences({
      ...tuiOperatorPreferences(session.settingsManager),
      ...this.#operatorPreferenceOverrides,
    });
    this.#terminal.setDoubleEscapeAction(
      this.#doubleEscapeActionOverride ?? session.settingsManager.getDoubleEscapeAction(),
    );
    const themes = session.resourceLoader.getThemes().themes;
    this.#terminal.setCustomThemes(themes.map((theme) => theme.definition));
    const configuredTheme = session.settingsManager.getThemeSetting() ?? "signal";
    try { this.#terminal.setTheme(configuredTheme); }
    catch { this.#terminal.notify(`Configured theme ${configuredTheme} is unavailable`, "warning"); }
    const uiBinding = bindInteractiveRuntimeUi(
      this.#terminal,
      session.extensionRunner,
      this.#runtime.cwd,
      () => this.#commandItems(session),
      {
        settings: session.settingsManager,
        themePath: (name) => {
          try {
            return session.resourceLoader.getThemes().themes.find((theme) => theme.name === name)?.sourcePath;
          } catch {
            return undefined;
          }
        },
      },
      session.toolRendererBinding(),
    );
    this.#uiBinding = uiBinding;
    this.#boundSession = session;
    const extensionBindings = {
      mode: "tui" as const,
      uiContext: uiBinding.uiContext,
      commandContextActions: this.#commandActions(session),
      abortHandler: () => { void session.abort("Cancelled by extension"); },
      shutdownHandler: () => this.stop(),
      onError: (error: { extensionPath: string; error: string }) => {
        this.showError(`${error.extensionPath}: ${error.error}`);
      },
    };
    if (start) {
      const bindingAbort = new AbortController();
      this.#sessionBindingAbort = bindingAbort;
      try {
        await session.bindExtensions(extensionBindings, bindingAbort.signal);
      } catch (error) {
        if (bindingAbort.signal.aborted && this.#uiBinding !== uiBinding) return;
        throw error;
      }
      if (this.#uiBinding !== uiBinding) {
        if (uiBinding.dispose()) session.clearExtensionBindings();
        return;
      }
      uiBinding.restoreDirectContext();
    } else session.updateExtensionBindings(extensionBindings);
    this.#unsubscribe = bindInteractiveSessionPresentation(session, this.#terminal, {
      onEnvelope: () => this.#updateContext(session, false),
      onSessionEvent: (event) => this.#updateContext(session, event.type === "entry_appended"),
      preserveTranscript: !start,
    });
    this.#terminal.setCommandItems(this.#commandItems(session));
    this.#updateContext(session);
    void this.#maybeWarnAboutAnthropicApiBearerBilling(session);
  }

  #unbindSession(): void {
    this.#unsubscribe();
    this.#unsubscribe = (): void => undefined;
    this.#sessionBindingAbort?.abort(new Error("Interactive session binding disposed"));
    this.#sessionBindingAbort = undefined;
    const owned = this.#uiBinding?.dispose() ?? false;
    this.#uiBinding = undefined;
    const session = this.#boundSession;
    this.#boundSession = undefined;
    if (owned) session?.clearExtensionBindings();
  }

  #updateContext(session: AgentSession = this.#runtime.session, includeContextUsage = true): void {
    if (this.#closed) return;
    const recoveryPending = !session.isStreaming && session.suspendedRun !== undefined;
    const active = (!session.isIdle && !recoveryPending) || this.#operationAborts.size > 0;
    this.#terminal.setQueuedMessages(session.getQueuedMessages());
    this.#terminal.setSteering(!active
      ? undefined
      : (line, images, recovered) => {
          if (classifyActiveSubmission(line).kind === "cancel") {
            void this.#cancelActiveRun("Cancelled by user")
              .catch((error: unknown) => this.#reportError(error));
            return;
          }
          const blocks = [
            ...(inputImages(images) ?? []),
            ...(recovered ?? []).map((image) => ({ ...image })),
          ];
          if (this.#operationAborts.size > 0) {
            return this.#dispatchInteractiveSubmission(line, blocks, {
              text: line,
              ...(images === undefined ? {} : { images }),
              ...(recovered === undefined ? {} : { recoveredImages: recovered }),
            });
          }
          const operation = this.#actionTail
            .then(async () => await this.#dispatchInteractiveSubmission(line, blocks, {
              text: line,
              ...(images === undefined ? {} : { images }),
              ...(recovered === undefined ? {} : { recoveredImages: recovered }),
            }));
          this.#actionTail = operation.catch(() => undefined);
          return operation;
        });
    this.#terminal.setContext(createInteractiveTuiContext(
      session,
      this.#runtime.cwd,
      session.sessionName,
      active,
      {
        includeContextUsage,
        operationOnly: this.#operationAborts.size > 0 && session.isIdle,
      },
    ));
  }

  async #refreshModels(options: { force?: boolean; allowNetwork?: boolean; signal?: AbortSignal } = {}) {
    const session = this.#runtime.session;
    await session.modelRegistry.refresh({
      force: options.force ?? true,
      allowNetwork: options.allowNetwork ?? true,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    options.signal?.throwIfAborted();
    return this.#applyAvailableModels();
  }

  #applyAvailableModels(session: AgentSession = this.#runtime.session) {
    const models = session.modelRegistry.getAvailable();
    const items = models.map(modelItem).sort((left, right) => left.label.localeCompare(right.label));
    const scopedModels = session.scopedModels;
    const scoped = scopedModels.length === 0
      ? undefined
      : scopedModelCycleItems(items, scopedModels);
    this.#terminal.setModelPickerItems(items, scoped);
    this.#terminal.setModelCycleItems(scoped ?? items);
    this.#terminal.setModelPickerEmptyMessage(items.length === 0
      ? session.modelRegistry.getError() ?? "No authenticated models are currently available"
      : undefined);
    return { models, items };
  }

  #startModelRefresh(): (() => void) | undefined {
    if (this.#modelRefresh !== undefined || this.#closed) return undefined;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    this.#terminal.setModelPickerLoading(true);
    const operation = this.#refreshModels({ signal }).then(() => undefined, (error: unknown) => {
      if (!signal.aborted) this.#reportError(error);
    }).finally(() => {
      if (this.#modelRefresh?.controller === controller) this.#modelRefresh = undefined;
      if (!this.#closed) this.#terminal.setModelPickerLoading(false);
    });
    this.#modelRefresh = { controller, operation };
    return () => controller.abort(new Error("Model picker closed"));
  }

  async #refresh(signal?: AbortSignal): Promise<void> {
    this.#terminal.setInputBlocked(`Refreshing ${REFRESH_RESOURCE_SUMMARY}...`, "refresh");
    try {
      const session = this.#runtime.session;
      let refreshedKeybindings: ConfiguredKeybindings | undefined;
      await session.refresh({
        ...(signal === undefined ? {} : { signal }),
        validateSettings: async (settings) => {
          const candidate = SettingsManager.inMemory(settings);
          candidate.getToolSettings();
          refreshedKeybindings = parseKeybindings(candidate.getKeybindings());
        },
        beforeSessionStart: async () => {
          if (refreshedKeybindings === undefined) throw new Error("Refreshed keybindings were not validated");
          this.#keybindings = refreshedKeybindings;
          this.#terminal.setKeybindings(this.#keybindings);
          await this.#bindSession(false);
        },
      });
      this.#uiBinding?.restoreDirectContext();
      await this.#refreshModels({ force: false, allowNetwork: false });
      this.#terminal.notify(`Refreshed ${REFRESH_RESOURCE_SUMMARY}`);
      await this.#maybeWarnAboutAnthropicApiBearerBilling();
    } finally {
      this.#terminal.setInputBlocked();
    }
  }

  async #login(argument: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const registry = this.#runtime.session.modelRegistry;
    const models = registry.models();
    const requested = argument.trim();
    let provider = requested === "" ? undefined : models.getProvider(requested);
    let path: ProviderLoginPath | undefined;
    if (provider === undefined && requested !== "") throw new Error(`Unknown provider: ${requested}`);
    if (provider === undefined) {
      const available = (["subscription", "api_key"] as const).map((value) => ({
        value,
        candidates: models.getProviders().filter((entry) =>
          providerLoginMethods(entry.auth).some((method) => method.path === value)),
      })).filter((entry) => entry.candidates.length > 0);
      if (available.length === 0) throw new Error("No interactive login is registered");
      path = available.length === 1
        ? available[0]!.value
        : await this.#terminal.choose("Select authentication method", available.map(({ value }) => ({
            label: value === "subscription"
              ? "Use a subscription or provider account"
              : "Use a key, token, or local credentials",
            value,
          })), signal);
      const candidates = available.find((entry) => entry.value === path)?.candidates;
      if (candidates === undefined) throw new Error("The selected login method is no longer available");
      provider = await this.#terminal.choose("Select provider", candidates.map((entry) => ({
        label: entry.name,
        detail: entry.id,
        value: entry,
      })), signal);
    }
    const methods = providerLoginMethods(provider.auth).filter((method) => path === undefined || method.path === path);
    if (methods.length === 0) throw new Error(`${provider.name} does not expose an interactive login method`);
    const method = methods.length === 1 ? methods[0]! : await this.#terminal.choose(`Connect ${provider.name}`, methods.map((entry) => ({
      label: entry.label,
      value: entry,
    })), signal);
    await models.login(provider.id, method.type, {
      signal,
      prompt: async (prompt) => {
        const selectedSignal = prompt.signal ?? signal;
        if (prompt.type === "secret") return await this.#terminal.readSecret(`${prompt.message}: `, selectedSignal);
        if (prompt.type === "select") {
          return await this.#terminal.choose(prompt.message, prompt.options.map((entry) => ({
            label: entry.label,
            ...(entry.description === undefined ? {} : { detail: entry.description }),
            value: entry.id,
          })), selectedSignal);
        }
        return await this.#terminal.question(prompt.message, selectedSignal);
      },
      notify: (event) => {
        if (event.type === "auth_url") this.#terminal.notify(`${event.instructions ?? "Open this URL to sign in:"}\n${event.url}`);
        else if (event.type === "device_code") this.#terminal.notify(`Open ${event.verificationUri} and enter code ${event.userCode}`);
        else {
          const links = event.links?.map((link) => `${link.label ?? link.url}: ${link.url}`).join("\n");
          this.#terminal.notify(links === undefined ? event.message : `${event.message}\n${links}`);
        }
      },
    });
    signal.throwIfAborted();
    await this.#refreshModels({ signal });
    signal.throwIfAborted();
    this.#terminal.notify(`Connected ${provider.name}. Use /model to choose a model.`);
    await this.#maybeWarnAboutAnthropicApiBearerBilling();
  }

  async #logout(argument: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const models = this.#runtime.session.modelRegistry.models();
    const requested = argument.trim();
    const provider = requested || await (async () => {
      const available = (await Promise.all(models.getProviders().map(async (entry) => ({
        entry,
        auth: await models.checkAuth(entry.id),
      })))).filter((entry) => entry.auth !== undefined);
      signal.throwIfAborted();
      if (available.length === 0) throw new Error("No stored credentials are available to remove");
      return await this.#terminal.choose("Remove provider authentication", available.map(({ entry, auth }) => ({
        label: entry.name,
        ...(auth?.source === undefined ? {} : { detail: auth.source }),
        value: entry.id,
      })), signal);
    })();
    signal.throwIfAborted();
    if (models.getProvider(provider) === undefined) throw new Error(`Unknown provider: ${provider}`);
    await models.logout(provider);
    signal.throwIfAborted();
    await this.#refreshModels({ signal });
    signal.throwIfAborted();
    this.#terminal.notify(`Signed out for ${provider}`);
  }

  #beginModelSelection(action?: object): ModelSelectionOwner {
    const generation = ++this.#modelSelectionGeneration;
    this.#modelSelectionAbort?.abort(new Error("A newer model selection started"));
    const controller = new AbortController();
    this.#modelSelectionAbort = controller;
    const owner = { generation, controller };
    if (action !== undefined) this.#modelSelectionOwners.set(action, owner);
    return owner;
  }

  #takeModelSelection(action: object): ModelSelectionOwner {
    const owner = this.#modelSelectionOwners.get(action) ?? this.#beginModelSelection();
    this.#modelSelectionOwners.delete(action);
    return owner;
  }

  #invalidateModelSelection(reason: Error): void {
    this.#modelSelectionGeneration += 1;
    this.#modelSelectionAbort?.abort(reason);
    this.#modelSelectionAbort = undefined;
  }

  async #chooseModel(
    argument: string,
    operationSignal: AbortSignal,
    thinkingLevel?: string,
    ownedSelection?: ModelSelectionOwner,
  ): Promise<void> {
    operationSignal.throwIfAborted();
    const selected = argument.trim();
    if (selected === "") {
      operationSignal.throwIfAborted();
      this.#applyAvailableModels();
      this.#terminal.openPicker("model", "Models");
      this.#startModelRefresh();
      return;
    }
    const owner = ownedSelection ?? this.#beginModelSelection();
    const signal = AbortSignal.any([operationSignal, owner.controller.signal]);
    const session = this.#runtime.session;
    const current = (): boolean =>
      this.#modelSelectionGeneration === owner.generation
      && this.#modelSelectionAbort === owner.controller
      && this.#runtime.session === session
      && !this.#closed
      && !signal.aborted;
    try {
      const requestedThinkingLevel = session.thinkingLevel;
      const model = await session.resolveModel(selected, { signal });
      if (!current()) return;
      await session.setModel(model);
      if (!current()) return;
      if (thinkingLevel !== undefined) session.setThinkingLevel(thinkingLevel, "cycle");
      if (!current()) return;
      session.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
      await session.settingsManager.flush();
      if (!current()) return;
      this.#updateContext();
      const effectiveThinkingLevel = session.thinkingLevel;
      this.#terminal.notify(effectiveThinkingLevel === requestedThinkingLevel
        ? `Model ${model.provider}/${model.id}`
        : `Model ${model.provider}/${model.id} · thinking ${requestedThinkingLevel} → ${effectiveThinkingLevel}`);
      await this.#maybeWarnAboutAnthropicApiBearerBilling();
    } catch (error) {
      if (!current() || signal.aborted) return;
      throw error;
    } finally {
      if (this.#modelSelectionAbort === owner.controller) this.#modelSelectionAbort = undefined;
    }
  }

  async #selectModelItem(item: PickerItem, signal: AbortSignal, selection: ModelSelectionOwner): Promise<void> {
    const value = item.value as { provider?: unknown; model?: unknown; thinkingLevel?: unknown };
    if (typeof value.provider !== "string" || typeof value.model !== "string") throw new Error("Invalid model selection");
    if (value.thinkingLevel !== undefined && typeof value.thinkingLevel !== "string") {
      throw new Error("Invalid model thinking level");
    }
    await this.#chooseModel(`${value.provider}/${value.model}`, signal, value.thinkingLevel, selection);
  }

  #setThinking(argument: string): void {
    const session = this.#runtime.session;
    const level = applyInteractiveThinking(session, argument);
    if (argument.trim() === "") this.#terminal.notify(`Thinking: ${level}`);
    this.#updateContext();
  }

  async #showSettings(): Promise<void> {
    const session = this.#runtime.session;
    await this.#terminal.chooseSettings(
      interactiveSettingItems(session.settingsManager, session, this.#terminal.themeNames()),
      async (item, value) => {
        applyInteractiveSetting(item, value, session.settingsManager, session, this.#terminal);
        await session.settingsManager.flush();
        this.#terminal.setCommandItems(this.#commandItems(session));
        this.#updateContext();
      },
    );
    await this.#maybeWarnAboutAnthropicApiBearerBilling();
  }

  async #maybeWarnAboutAnthropicApiBearerBilling(session: AgentSession = this.#runtime.session): Promise<void> {
    await this.#anthropicApiBearerBillingWarning.maybeNotify({
      enabled: session.settingsManager.getWarnings().anthropicExtraUsage !== false,
      model: session.model,
      models: session.modelRegistry.models(),
      notify: (message) => this.#terminal.notify(message, "warning"),
    });
  }

  async #showScopedModels(): Promise<void> {
    const session = this.#runtime.session;
    const { items } = this.#applyAvailableModels();
    const stopRefresh = this.#startModelRefresh();
    const catalog = session.modelRegistry.getAll();
    const configured = session.settingsManager.getEnabledModels();
    const hasConfiguredScope = configured !== undefined && configured.length > 0;
    const selected = hasConfiguredScope
      ? configured.filter((pattern) => pattern !== SCOPED_MODELS_NONE)
      : session.scopedModels.map((entry) => `${entry.model.provider}/${entry.model.id}`);
    const all = !hasConfiguredScope && session.scopedModels.length === 0;
    if (items.length === 0 && selected.length === 0 && all) {
      this.#terminal.notify(session.modelRegistry.getError() ?? "No authenticated models are currently available", "warning");
      return;
    }
    let committedSelection: ScopedModelSelection = all
      ? { mode: "all" }
      : selected.length === 0 ? { mode: "none" } : { mode: "models", patterns: [...selected] };
    const applySelection = (selection: ScopedModelSelection): void => {
      const scoped = selection.mode !== "models" ? [] : resolveModelsForScope(
        catalog.map((model) => ({ provider: model.provider, model: model.id })),
        selection.patterns,
      ).models.flatMap((entry) => {
        const model = catalog.find((candidate) => candidate.provider === entry.provider && candidate.id === entry.model);
        return model === undefined ? [] : [{
          model,
          ...(entry.reasoningEffort === undefined ? {} : { thinkingLevel: entry.reasoningEffort }),
        }];
      });
      session.setScopedModels(scoped, { cyclingEnabled: selection.mode !== "none" });
      this.#terminal.setModelCycleItems(selection.mode === "all"
        ? items
        : selection.mode === "none"
          ? []
          : scopedModelCycleItems(items, session.scopedModels));
    };
    const saveSelection = async (selection: ScopedModelSelection): Promise<void> => {
      applySelection(selection);
      session.settingsManager.setEnabledModels(selection.mode === "all"
        ? undefined
        : selection.mode === "none" ? [SCOPED_MODELS_NONE] : selection.patterns);
      await session.settingsManager.flush();
      committedSelection = selection.mode === "models"
        ? { mode: "models", patterns: [...selection.patterns] }
        : { mode: selection.mode };
      this.#terminal.notify("Saved model cycling selection");
    };
    try {
      const selection = await this.#terminal.chooseScopedModels(items, {
        all,
        selected,
        live: true,
        onChange: applySelection,
        onSave: saveSelection,
      });
      applySelection(selection);
    } catch (error) {
      applySelection(committedSelection);
      if (!(error instanceof TuiSelectionCancelledError)) throw error;
    } finally {
      stopRefresh?.();
    }
  }

  async #showChangelog(): Promise<void> {
    const content = await readPackageChangelog();
    this.#terminal.notify(content.trim() || "No changelog entries found");
  }

  #showResources(): void {
    this.#terminal.notify(renderInteractiveResourceReport(this.#runtime.session, this.#runtime.cwd));
  }

  #showHotkeys(): void { this.#terminal.notify(formatHotkeys(this.#keybindings)); }

  async #runShell(request: InteractiveShellRequest, signal: AbortSignal): Promise<void> {
    const session = this.#runtime.session;
    let presentation: InteractiveShellPresentation | undefined;
    const beginPresentation = (command: string): InteractiveShellPresentation => presentation ??= beginInteractiveShellPresentation({
      terminal: this.#terminal,
      threadId: session.sessionId,
      command,
      hidden: request.hidden,
    });
    try {
      const result = await runInteractiveShell({
        command: request.command,
        hidden: request.hidden,
        workspace: this.#runtime.cwd,
        host: session.extensionRunner.getRuntimeHost(),
        session,
        signal,
        onPrepared: beginPresentation,
        onChunk: (chunk) => beginPresentation(request.command).onChunk(chunk),
      });
      beginPresentation(request.command).complete(result);
    } catch (cause) {
      beginPresentation(request.command).fail(cause);
      throw cause;
    }
  }

  #actionImages(action: Extract<TuiAction, { type: "submit" | "steer" | "follow_up" }>): ImageBlock[] {
    return [
      ...(inputImages(action.images) ?? []),
      ...(action.recoveredImages ?? []).map((image) => ({ ...image })),
    ];
  }

  async #dispatchInteractiveSubmission(
    text: string,
    images: readonly ImageBlock[],
    draft: Parameters<typeof restoreInterruptedSubmission>[1],
  ): Promise<void> {
    const session = this.#runtime.session;
    await dispatchInteractiveSubmissionAfterInterruption({
      session,
      locallyInterruptedOperationId: this.#locallyInterruptedOperationId,
      clearLocalInterruptionMarker: () => { this.#locallyInterruptedOperationId = undefined; },
      ...(this.#sessionBindingAbort === undefined ? {} : { signal: this.#sessionBindingAbort.signal }),
      text,
      draft,
      terminal: this.#terminal,
      canDispatchIdle: () => session.isIdle && this.#operationAborts.size === 0,
      dispatchIdle: async () => await this.#coordinator.dispatchSubmission(text, images),
      dispatchActive: async () => await this.#dispatchActiveSubmission(text, images),
      updateContext: () => this.#updateContext(),
    });
  }

  async #dispatchActiveSubmission(text: string, images: readonly ImageBlock[]): Promise<void> {
    const session = this.#runtime.session;
    if (session.isIdle && this.#operationAborts.size === 0) {
      await this.#coordinator.dispatchSubmission(text, images);
      return;
    }
    const resourceRoute = text.trim().startsWith("/")
      ? resolveInteractiveResourceSlash(session, text, this.#options.extensionCatalog)
      : undefined;
    const classified = classifyActiveSubmission(text, { resourceCommand: resourceRoute !== undefined });
    if (classified.kind === "cancel") { await this.#cancelActiveRun("Cancelled by user"); return; }
    if (classified.kind === "reject") {
      this.#terminal.notify(`/${classified.command} is unavailable while work is active`, "warning");
      return;
    }
    if (classified.kind === "unknown") {
      this.#terminal.notify(`Unknown command: /${classified.command}`, "error");
      return;
    }
    if (classified.kind === "command") {
      if (this.#operationAborts.size > 0) {
        this.#terminal.notify("Another command is active; finish or cancel it before starting this command", "warning");
        return;
      }
      if (classified.interrupt) {
        const recovery = await interruptInteractiveRunForCommand({
          session,
          command: classified.text,
          terminal: this.#terminal,
          ...(this.#sessionBindingAbort === undefined ? {} : { signal: this.#sessionBindingAbort.signal }),
          interrupt: async () => await this.#cancelActiveRun(`${classified.text} requested`),
        });
        if (recovery?.operationId === this.#locallyInterruptedOperationId) {
          this.#locallyInterruptedOperationId = undefined;
        }
      }
      await this.#coordinator.dispatchSlash(classified.text, images);
      this.#updateContext();
      return;
    }
    if (classified.kind === "resource") {
      if (this.#operationAborts.size > 0) {
        this.#terminal.notify("Another command is active; finish or cancel it before starting this command", "warning");
        return;
      }
      if (resourceRoute === undefined) {
        this.#terminal.notify("The command is no longer available", "error");
        return;
      }
      await this.#runOperation(async (signal) =>
        await dispatchActiveInteractiveResourceSlash(session, resourceRoute, images, signal));
      this.#updateContext();
      return;
    }
    if (classified.kind === "defer" || this.#operationAborts.size > 0) {
      const result = this.#deferredSubmissions.enqueue(classified.text, images, this.#submissionOrder++);
      if (!result.accepted) throw new Error(result.reason === "items"
        ? "Too many commands are waiting for the current turn to finish"
        : "Commands waiting for the current turn exceed the input byte limit");
      this.#terminal.notify("Command queued until the current turn finishes");
      return;
    }
    await deliverActiveSubmission(session, classified, images);
    this.#updateContext();
  }

  #abortOperations(reason: Error): boolean {
    if (this.#operationAborts.size === 0) return false;
    for (const controller of this.#operationAborts) controller.abort(reason);
    return true;
  }

  async #runOperation<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    const controller = new AbortController();
    this.#operationAborts.add(controller);
    this.#updateContext();
    try {
      const pending = Promise.resolve().then(async () => await operation(controller.signal));
      return await waitForInteractiveOperation(pending, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      return undefined;
    } finally {
      this.#operationAborts.delete(controller);
      this.#updateContext();
      if (!this.#closed && this.#operationAborts.size === 0) await this.#drainDeferredSubmissions();
    }
  }

  async #drainDeferredSubmissions(): Promise<void> {
    if (this.#drainingDeferred || this.#operationAborts.size > 0 || !this.#runtime.session.isIdle) return;
    this.#drainingDeferred = true;
    try {
      while (
        this.#runtime.session.isIdle
        && this.#activePrompt === undefined
        && this.#operationAborts.size === 0
      ) {
        const next = this.#deferredSubmissions.shift();
        if (next === undefined) return;
        await this.#coordinator.dispatchSubmission(next.text, next.images);
      }
    } finally {
      this.#drainingDeferred = false;
    }
  }

  async #cancelActiveRun(reason: string): Promise<void> {
    const marker = localInterruptionMarker(this.#runtime.session);
    if (marker !== undefined) this.#locallyInterruptedOperationId = marker;
    if (this.#treeSummaryCancel !== undefined) {
      this.#treeSummaryCancel();
      this.#updateContext();
      return;
    }
    const operationActive = this.#abortOperations(new Error(reason));
    if (!this.#runtime.session.isIdle) {
      await restoreQueuedMessagesThenAbort(this.#runtime.session, this.#terminal, reason);
    } else if (!operationActive) {
      await this.#runtime.session.abort(reason);
    }
    this.#updateContext();
  }

  #dequeueMessage(): void {
    const restored = restoreAllQueuedMessages(this.#runtime.session, this.#terminal);
    if (restored === 0) this.#terminal.notify("The editor queue is empty");
    else this.#terminal.notify(`Returned ${restored} queued message${restored === 1 ? "" : "s"} to the editor`);
    this.#updateContext();
  }

  #startPrompt(text: string, images?: ImageBlock[]): void {
    const selected = text.trim();
    if (selected === "") return;
    const session = this.#runtime.session;
    const operation = session.prompt(selected, {
      ...(images === undefined || images.length === 0 ? {} : { images }),
      source: "interactive",
    }).then(() => undefined, (error: unknown) => this.#reportError(error)).finally(() => {
      if (this.#activePrompt === operation) this.#activePrompt = undefined;
      this.#updateContext();
      void this.#drainDeferredSubmissions().catch((error: unknown) => this.#reportError(error));
    });
    this.#activePrompt = operation;
    this.#updateContext();
  }

  #resolveUserInput(text: string): boolean {
    const pending = this.#pendingUserInputs.shift();
    if (pending === undefined) return false;
    pending.resolve(text);
    return true;
  }

  #reportError(error: unknown): void {
    if (this.#closed) return;
    this.showError(errorMessage(error));
  }
}
