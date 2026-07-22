import type { ImageContent } from "@rigyn/models";
import { join } from "node:path";

import type { ImageBlock } from "../core/types.js";
import type { ExtensionCommandContextActions } from "../extensions/direct.js";
import { extensionSessionManager } from "../extensions/session-contract.js";
import {
  bindInteractiveSessionPresentation,
  interactiveTranscriptHistory,
} from "../interactive/session-presentation.js";
import { AnthropicSubscriptionWarning } from "../interactive/anthropic-warning.js";
import { RELOAD_RESOURCE_SUMMARY, renderInteractiveCommandHelp } from "../interactive/commands.js";
import { manageLlamaRouter } from "../providers/llama-management.js";
import { LlamaRouterClient } from "../providers/llama-router.js";
import { resolveModelsForScope, SCOPED_MODELS_NONE } from "../providers/model-scope.js";
import type { AgentSession } from "../service/agent-session.js";
import type { AgentSessionRuntime } from "../service/agent-session-runtime.js";
import { TuiController } from "../tui/controller.js";
import { Keybindings as ConfiguredKeybindings, loadKeybindings } from "../tui/keybindings.js";
import type { PickerItem, TuiAction, TuiControllerOptions, TuiInputImageAttachment } from "../tui/types.js";
import {
  BoundedDeferredSubmissionQueue,
  classifyActiveSubmission,
} from "../cli/active-submission.js";
import {
  applyInteractiveSetting,
  interactiveSettingItems,
} from "../cli/interactive-settings.js";
import {
  InteractiveCommandCoordinator,
  type InteractiveShellRequest,
} from "./interactive-command-coordinator.js";
import { runInteractiveShell } from "./interactive-shell.js";
import { InteractiveSessionOperations } from "./interactive-session-operations.js";
import { bindInteractiveRuntimeUi, type InteractiveRuntimeUiBinding } from "./interactive-runtime-ui.js";
import { presentStartupChangelog, readPackageChangelog } from "./startup-changelog.js";

export interface InteractiveModeOptions {
  migratedProviders?: string[];
  modelFallbackMessage?: string;
  autoTrustOnReloadCwd?: string;
  initialMessage?: string;
  initialImages?: ImageContent[];
  initialMessages?: string[];
  verbose?: boolean;
  /** Optional terminal owner for embedding and deterministic tests. */
  terminal?: TuiController;
  /** Applied only when the mode creates its terminal. */
  terminalOptions?: TuiControllerOptions;
}

function canonicalImages(images: readonly ImageContent[] | undefined): ImageBlock[] | undefined {
  if (images === undefined) return undefined;
  return images.map((image) => ({ type: "image", data: image.data, mediaType: image.mimeType }));
}

function inputImages(images: readonly TuiInputImageAttachment[] | undefined): ImageBlock[] | undefined {
  if (images === undefined || images.length === 0) return undefined;
  return images.map((image) => ({ ...image.block }));
}

function modelItem(model: { provider: string; id: string; name?: string }): PickerItem<{ provider: string; model: string }> {
  return {
    id: `${model.provider}/${model.id}`,
    label: model.name ?? model.id,
    detail: `${model.provider}/${model.id}`,
    keywords: [model.provider, model.id, model.name ?? ""],
    value: { provider: model.provider, model: model.id },
  };
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

/** Interactive terminal owner for an already-created session runtime. */
export class InteractiveMode {
  readonly #runtime: AgentSessionRuntime;
  readonly #options: InteractiveModeOptions;
  readonly #terminal: TuiController;
  readonly #coordinator: InteractiveCommandCoordinator<ImageBlock>;
  readonly #sessionOperations: InteractiveSessionOperations;
  #keybindings = new ConfiguredKeybindings();
  readonly #deferredSubmissions = new BoundedDeferredSubmissionQueue<ImageBlock>((image) =>
    Buffer.byteLength(image.data ?? image.url ?? "", "utf8"));
  #unsubscribe = (): void => undefined;
  #uiBinding: InteractiveRuntimeUiBinding | undefined;
  #initialized = false;
  #closed = false;
  #actionTail: Promise<void> = Promise.resolve();
  #activePrompt: Promise<void> | undefined;
  #resolveExit: (() => void) | undefined;
  #exit: Promise<void> | undefined;
  #submissionOrder = 0;
  #drainingDeferred = false;
  readonly #anthropicSubscriptionWarning = new AnthropicSubscriptionWarning();

  constructor(runtime: AgentSessionRuntime, options: InteractiveModeOptions = {}) {
    this.#runtime = runtime;
    this.#options = options;
    this.#terminal = options.terminal ?? new TuiController(options.terminalOptions);
    this.#sessionOperations = new InteractiveSessionOperations({
      runtime,
      terminal: this.#terminal,
      refreshTranscript: () => this.#terminal.replaceTranscript(interactiveTranscriptHistory(this.#runtime.session), "main"),
      updateContext: () => this.#updateContext(),
    });
    this.#coordinator = this.#createCoordinator();
    this.#terminal.setActionHandler((action) => {
      this.#actionTail = this.#actionTail
        .then(async () => await this.#coordinator.dispatchAction(action))
        .catch((error: unknown) => this.#reportError(error));
    });
  }

  #createCoordinator(): InteractiveCommandCoordinator<ImageBlock> {
    return new InteractiveCommandCoordinator<ImageBlock>({
      commands: {
        quit: () => this.stop(),
        cancel: async () => await this.#runtime.session.abort("Cancelled by user"),
        login: async ({ args }) => await this.#login(args),
        logout: async ({ args }) => await this.#logout(args),
        model: async ({ args }) => await this.#chooseModel(args),
        thinking: ({ args }) => this.#setThinking(args),
        new: async () => await this.#sessionOperations.newSession(),
        resume: async ({ args }) => await this.#sessionOperations.resume(args),
        reload: async () => await this.#reload(),
        name: async ({ args }) => await this.#sessionOperations.name(args),
        session: async () => await this.#sessionOperations.showSession(),
        tree: async () => await this.#sessionOperations.navigateTree(),
        fork: async () => await this.#sessionOperations.forkSession(),
        clone: async () => await this.#sessionOperations.cloneSession(),
        export: async ({ args }) => await this.#sessionOperations.exportSession(args, false),
        share: async ({ args }) => await this.#sessionOperations.exportSession(args, true),
        context: () => this.#sessionOperations.showContext(),
        resources: () => this.#showResources(),
        copy: () => this.#sessionOperations.copyLatestAssistant(),
        hotkeys: () => this.#showHotkeys(),
        compact: async ({ args }) => await this.#sessionOperations.compact(args),
        help: () => this.#terminal.notify(renderInteractiveCommandHelp()),
        settings: async () => await this.#showSettings(),
        llama: async () => await this.#manageLocalModels(),
        "scoped-models": async () => await this.#showScopedModels(),
        changelog: async () => await this.#showChangelog(),
        import: async ({ args }) => await this.#sessionOperations.importSession(args),
        trust: async () => await this.#sessionOperations.saveProjectTrust(),
      },
      unknownCommand: () => false,
      submissions: {
        prompt: (text, images) => this.#startPrompt(text, [...images]),
        shell: async (request) => await this.#runShell(request),
      },
      actions: {
        exit: () => this.stop(),
        error: (action) => this.#reportError(action.error),
        cancel: async () => await this.#runtime.session.abort("Cancelled by user"),
        submit: async (action) => {
          const images = this.#actionImages(action);
          if (this.#runtime.session.isIdle) await this.#coordinator.dispatchSubmission(action.text, images);
          else await this.#dispatchActiveSubmission(action.text, images);
        },
        activeSubmission: async (action) => await this.#dispatchActiveSubmission(
          action.type === "follow_up" ? `/follow ${action.text}` : action.text,
          this.#actionImages(action),
        ),
        dequeue: () => this.#dequeueMessage(),
        queueRestoreDiscard: () => this.#updateContext(),
        sessionCatalog: async (action) => await this.#sessionOperations.handleCatalogAction(action),
        sessionMutation: async (action) => await this.#sessionOperations.handleMutation(action),
        selectSession: async (action) => await this.#sessionOperations.switchSession(String(action.item.value)),
        selectModel: async (action) => await this.#selectModelItem(action.item),
        command: (action) => this.#terminal.setEditorText(String(action.item.value)),
        copy: () => this.#sessionOperations.copyLatestAssistant(false),
        copyText: (action) => this.#terminal.copyToClipboard(action.text),
        cycleThinking: () => { this.#runtime.session.cycleThinkingLevel(); this.#updateContext(); },
        extensionShortcut: async (action) => {
          await this.#runtime.session.extensionRunner.getRuntimeHost().runShortcut(action.shortcut, {
            threadId: this.#runtime.session.sessionId,
            signal: action.generation,
            ui: undefined as never,
          });
        },
        other: () => undefined,
      },
    });
  }

  /** Initialize the terminal and bind the current extension generation once. */
  async init(): Promise<void> {
    if (this.#closed) throw new Error("Interactive mode is closed");
    if (this.#initialized) return;
    this.#initialized = true;
    this.#keybindings = await loadKeybindings(join(this.#runtime.services.agentDir, "keybindings.json"));
    this.#terminal.setKeybindings(this.#keybindings);
    this.#terminal.start();
    this.#terminal.setStartup(
      "Rigyn · Ready · /help commands",
      "Rigyn interactive mode\n/exit quit · /cancel interrupt · /model choose · /reload resources · !command shell",
    );
    this.#terminal.setInterruptHandler(() => {
      if (this.#runtime.session.isIdle) return false;
      void this.#runtime.session.abort("Interrupted");
      return true;
    });
    this.#runtime.setBeforeSessionInvalidate(() => this.#unbindSession());
    this.#runtime.setRebindSession(async () => await this.#bindSession(true));
    await this.#bindSession(true);
    await this.#refreshModels();
    await presentStartupChangelog(this.#runtime.session.settingsManager, (message) => this.#terminal.notify(message));
    await this.#maybeWarnAboutAnthropicSubscriptionAuth();

    if ((this.#options.migratedProviders?.length ?? 0) > 0) {
      this.#terminal.notify(`Migrated credentials: ${this.#options.migratedProviders!.join(", ")}`, "warning");
    }
    if (this.#options.modelFallbackMessage !== undefined) {
      this.#terminal.notify(this.#options.modelFallbackMessage, "warning");
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
    const skills = session.resourceLoader.getSkills().skills.map((skill): PickerItem<string> => ({
      id: `skill:${skill.name}`,
      label: `/skill:${skill.name}`,
      value: `/skill:${skill.name}`,
      detail: skill.description,
    }));
    return [...commands, ...prompts, ...skills];
  }

  #commandActions(session: AgentSession): ExtensionCommandContextActions {
    return {
      waitForIdle: async () => await session.waitForIdle(),
      newSession: async (options = {}) => await this.#runtime.newSession({
        ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
        ...(options.setup === undefined ? {} : {
          setup: async (manager) => await options.setup?.(extensionSessionManager(manager)),
        }),
        ...(options.withSession === undefined ? {} : {
          withSession: async (context) => await options.withSession?.(context),
        }),
      }),
      fork: async (entryId, options = {}) => await this.#runtime.fork(entryId, {
        ...(options.position === undefined ? {} : { position: options.position }),
        ...(options.withSession === undefined ? {} : {
          withSession: async (context) => await options.withSession?.(context),
        }),
      }),
      navigateTree: async (targetId, options = {}) => {
        const result = await session.navigateTree(targetId, options);
        return { cancelled: result.cancelled };
      },
      switchSession: async (sessionPath, options = {}) => await this.#runtime.switchSession(sessionPath, {
        ...(options.withSession === undefined ? {} : {
          withSession: async (context) => await options.withSession?.(context),
        }),
      }),
      reload: async () => await this.#reload(),
    };
  }

  async #bindSession(start: boolean): Promise<void> {
    this.#unbindSession();
    const session = this.#runtime.session;
    const themes = session.resourceLoader.getThemes().themes;
    this.#terminal.setCustomThemes(themes.map((theme) => theme.definition));
    const configuredTheme = session.settingsManager.getThemeSetting();
    if (configuredTheme !== undefined) {
      try { this.#terminal.setTheme(configuredTheme); }
      catch { this.#terminal.notify(`Configured theme ${configuredTheme} is unavailable`, "warning"); }
    }
    this.#uiBinding = bindInteractiveRuntimeUi(
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
    );
    if (start) {
      await session.bindExtensions({
        mode: "tui",
        uiContext: this.#uiBinding.uiContext,
        commandContextActions: this.#commandActions(session),
        abortHandler: () => { void session.abort("Cancelled by extension"); },
        shutdownHandler: () => this.stop(),
        onError: (error) => this.#terminal.notify(`${error.extensionPath}: ${error.error}`, "error"),
      });
      this.#uiBinding.restoreDirectContext();
    }
    this.#unsubscribe = bindInteractiveSessionPresentation(session, this.#terminal, {
      onEnvelope: () => this.#updateContext(),
      onSessionEvent: () => this.#updateContext(),
    });
    this.#terminal.setCommandItems(this.#commandItems(session));
    this.#updateContext();
    void this.#maybeWarnAboutAnthropicSubscriptionAuth();
  }

  #unbindSession(): void {
    this.#unsubscribe();
    this.#unsubscribe = (): void => undefined;
    this.#uiBinding?.dispose();
    this.#uiBinding = undefined;
  }

  #updateContext(): void {
    if (this.#closed) return;
    const session = this.#runtime.session;
    const model = session.model;
    this.#terminal.setQueuedMessages(session.getQueuedMessages());
    this.#terminal.setSteering(session.isIdle
      ? undefined
      : (line, images, recovered) => {
          const blocks = [
            ...(inputImages(images) ?? []),
            ...(recovered ?? []).map((image) => ({ ...image })),
          ];
          this.#actionTail = this.#actionTail
            .then(async () => await this.#dispatchActiveSubmission(line, blocks))
            .catch((error: unknown) => this.#reportError(error));
        });
    this.#terminal.setContext({
      threadId: session.sessionId,
      ...(session.sessionName === undefined ? {} : { sessionName: session.sessionName }),
      workspace: this.#runtime.cwd,
      ...(model === undefined ? {} : { provider: model.provider, model: model.id }),
      thinking: session.thinkingLevel,
      active: !session.isIdle,
      status: session.isIdle ? "idle" : "streaming",
      autoCompaction: session.autoCompactionEnabled,
    });
  }

  async #refreshModels(options: { force?: boolean; allowNetwork?: boolean } = {}) {
    const session = this.#runtime.session;
    await session.modelRegistry.refresh({
      force: options.force ?? true,
      allowNetwork: options.allowNetwork ?? true,
    });
    const models = session.modelRegistry.getAvailable();
    const items = models.map(modelItem).sort((left, right) => left.label.localeCompare(right.label));
    const scoped = session.scopedModels.length === 0
      ? undefined
      : items.filter((item) => session.scopedModels.some((entry) =>
          entry.model.provider === item.value.provider && entry.model.id === item.value.model));
    this.#terminal.setModelPickerItems(items, scoped);
    this.#terminal.setModelCycleItems(scoped ?? items);
    return { models, items };
  }

  async #reload(): Promise<void> {
    this.#terminal.setInputBlocked(`Reloading ${RELOAD_RESOURCE_SUMMARY}...`, "reload");
    try {
      const session = this.#runtime.session;
      const reloadedKeybindings = await loadKeybindings(join(this.#runtime.services.agentDir, "keybindings.json"));
      await session.reload({
        beforeSessionStart: async () => {
          this.#keybindings = reloadedKeybindings;
          this.#terminal.setKeybindings(this.#keybindings);
          await this.#bindSession(false);
        },
      });
      this.#uiBinding?.restoreDirectContext();
      await this.#refreshModels({ force: false, allowNetwork: false });
      this.#terminal.notify(`Reloaded ${RELOAD_RESOURCE_SUMMARY}`);
      await this.#maybeWarnAboutAnthropicSubscriptionAuth();
    } finally {
      this.#terminal.setInputBlocked();
    }
  }

  async #login(argument: string): Promise<void> {
    const registry = this.#runtime.session.modelRegistry;
    const models = registry.models();
    const requested = argument.trim();
    let provider = requested === "" ? undefined : models.getProvider(requested);
    let method: "api_key" | "oauth" | undefined;
    if (provider === undefined && requested !== "") throw new Error(`Unknown provider: ${requested}`);
    if (provider === undefined) {
      method = await this.#terminal.choose("Select authentication method", [
        { label: "Use a subscription", value: "oauth" as const },
        { label: "Use an API key", value: "api_key" as const },
      ]);
      const candidates = models.getProviders().filter((entry) =>
        method === "oauth" ? entry.auth.oauth !== undefined : entry.auth.apiKey?.login !== undefined);
      if (candidates.length === 0) throw new Error(`No ${method === "oauth" ? "subscription" : "API-key"} login is registered`);
      provider = await this.#terminal.choose("Select provider", candidates.map((entry) => ({
        label: entry.name,
        detail: entry.id,
        value: entry,
      })));
    }
    const methods = [
      ...(provider.auth.oauth === undefined ? [] : ["oauth" as const]),
      ...(provider.auth.apiKey?.login === undefined ? [] : ["api_key" as const]),
    ];
    if (methods.length === 0) throw new Error(`${provider.name} does not expose an interactive login method`);
    method ??= methods.length === 1 ? methods[0] : await this.#terminal.choose(`Connect ${provider.name}`, methods.map((value) => ({
      label: value === "oauth" ? provider.auth.oauth?.loginLabel ?? "Use a subscription" : "Use an API key",
      value,
    })));
    if (method === undefined || !methods.includes(method)) throw new Error(`${provider.name} does not support the selected login method`);
    const signal = new AbortController().signal;
    await models.login(provider.id, method, {
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
    await this.#refreshModels();
    this.#terminal.notify(`Connected ${provider.name}. Use /model to choose a model.`);
    await this.#maybeWarnAboutAnthropicSubscriptionAuth();
  }

  async #logout(argument: string): Promise<void> {
    const models = this.#runtime.session.modelRegistry.models();
    const requested = argument.trim();
    const provider = requested || await (async () => {
      const available = (await Promise.all(models.getProviders().map(async (entry) => ({
        entry,
        auth: await models.checkAuth(entry.id),
      })))).filter((entry) => entry.auth !== undefined);
      if (available.length === 0) throw new Error("No stored credentials are available to remove");
      return await this.#terminal.choose("Remove provider authentication", available.map(({ entry, auth }) => ({
        label: entry.name,
        ...(auth?.source === undefined ? {} : { detail: auth.source }),
        value: entry.id,
      })));
    })();
    if (models.getProvider(provider) === undefined) throw new Error(`Unknown provider: ${provider}`);
    await models.logout(provider);
    await this.#refreshModels();
    this.#terminal.notify(`Signed out for ${provider}`);
  }

  async #chooseModel(argument: string): Promise<void> {
    const selected = argument.trim();
    if (selected === "") {
      await this.#refreshModels();
      this.#terminal.openPicker("model", "Models");
      return;
    }
    const session = this.#runtime.session;
    const model = await session.resolveModel(selected);
    await session.setModel(model);
    session.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
    await session.settingsManager.flush();
    this.#updateContext();
    this.#terminal.notify(`Model ${model.provider}/${model.id}`);
    await this.#maybeWarnAboutAnthropicSubscriptionAuth();
  }

  async #selectModelItem(item: PickerItem): Promise<void> {
    const value = item.value as { provider?: unknown; model?: unknown };
    if (typeof value.provider !== "string" || typeof value.model !== "string") throw new Error("Invalid model selection");
    await this.#chooseModel(`${value.provider}/${value.model}`);
  }

  #setThinking(argument: string): void {
    const session = this.#runtime.session;
    if (argument === "") this.#terminal.notify(`Thinking: ${session.thinkingLevel}`);
    else session.setThinkingLevel(argument);
    this.#updateContext();
  }

  async #showSettings(): Promise<void> {
    const session = this.#runtime.session;
    await this.#terminal.chooseSettings(
      interactiveSettingItems(session.settingsManager, session, this.#terminal.themeNames()),
      async (item, value) => {
        applyInteractiveSetting(item, value, session.settingsManager, session, this.#terminal);
        await session.settingsManager.flush();
        this.#updateContext();
      },
    );
    await this.#maybeWarnAboutAnthropicSubscriptionAuth();
  }

  async #maybeWarnAboutAnthropicSubscriptionAuth(): Promise<void> {
    const session = this.#runtime.session;
    await this.#anthropicSubscriptionWarning.maybeNotify({
      enabled: session.settingsManager.getWarnings().anthropicExtraUsage !== false,
      model: session.model,
      models: session.modelRegistry.models(),
      notify: (message) => this.#terminal.notify(message, "warning"),
    });
  }

  async #showScopedModels(): Promise<void> {
    const session = this.#runtime.session;
    const { models, items } = await this.#refreshModels();
    if (items.length === 0) {
      this.#terminal.notify(session.modelRegistry.getError() ?? "No authenticated models are currently available", "warning");
      return;
    }
    const configured = session.settingsManager.getEnabledModels();
    const selected = session.scopedModels.length > 0
      ? session.scopedModels.map((entry) => `${entry.model.provider}/${entry.model.id}`)
      : resolveModelsForScope(models.map((model) => ({ provider: model.provider, model: model.id })), configured ?? [])
        .models.map((model) => `${model.provider}/${model.model}`);
    const selection = await this.#terminal.chooseScopedModels(items, {
      all: configured === undefined || configured.length === 0,
      selected,
    });
    const patterns = selection.mode === "all"
      ? undefined
      : selection.mode === "none" ? [SCOPED_MODELS_NONE] : selection.patterns;
    session.settingsManager.setEnabledModels(patterns);
    const scoped = selection.mode === "all"
      ? models.map((model) => ({ model }))
      : selection.mode === "none" ? [] : resolveModelsForScope(
          models.map((model) => ({ provider: model.provider, model: model.id })),
          selection.patterns,
        ).models.flatMap((entry) => {
          const model = models.find((candidate) => candidate.provider === entry.provider && candidate.id === entry.model);
          return model === undefined ? [] : [{ model, ...(entry.reasoningEffort === undefined ? {} : { thinkingLevel: entry.reasoningEffort }) }];
        });
    session.setScopedModels(scoped);
    this.#terminal.setModelCycleItems(selection.mode === "all"
      ? items
      : items.filter((item) => scoped.some((entry) => entry.model.provider === item.value.provider && entry.model.id === item.value.model)));
    await session.settingsManager.flush();
    this.#terminal.notify("Saved model cycling selection");
  }

  async #manageLocalModels(): Promise<void> {
    const configured = process.env.LLAMA_BASE_URL?.trim();
    await manageLlamaRouter({
      terminal: this.#terminal,
      client: new LlamaRouterClient(configured === undefined || configured === "" ? {} : { baseUrl: configured }),
      onStatus: (message) => this.#terminal.setTransientStatus(message),
    });
    await this.#refreshModels();
  }

  async #showChangelog(): Promise<void> {
    const content = await readPackageChangelog();
    this.#terminal.notify(content.trim() || "No changelog entries found");
  }

  #showResources(): void {
    const session = this.#runtime.session;
    const loader = session.resourceLoader;
    this.#terminal.notify([
      `Extensions: ${session.extensionRunner.getExtensionPaths().length}`,
      `Commands: ${session.extensionRunner.getRegisteredCommands().length}`,
      `Prompts: ${loader.getPrompts().prompts.length}`,
      `Skills: ${loader.getSkills().skills.length}`,
      `Themes: ${loader.getThemes().themes.length}`,
    ].join(" · "));
  }

  #showHotkeys(): void { this.#terminal.notify(formatHotkeys(this.#keybindings)); }

  async #runShell(request: InteractiveShellRequest): Promise<void> {
    const session = this.#runtime.session;
    const result = await runInteractiveShell({
      command: request.command,
      hidden: request.hidden,
      workspace: this.#runtime.cwd,
      host: session.extensionRunner.getRuntimeHost(),
      session,
      settings: session.settingsManager,
    });
    this.#terminal.notify(result.output);
  }

  #actionImages(action: Extract<TuiAction, { type: "submit" | "steer" | "follow_up" }>): ImageBlock[] {
    return [
      ...(inputImages(action.images) ?? []),
      ...(action.recoveredImages ?? []).map((image) => ({ ...image })),
    ];
  }

  async #dispatchActiveSubmission(text: string, images: readonly ImageBlock[]): Promise<void> {
    const session = this.#runtime.session;
    if (session.isIdle) { await this.#coordinator.dispatchSubmission(text, images); return; }
    const classified = classifyActiveSubmission(text);
    if (classified.kind === "cancel") { await session.abort("Cancelled by user"); this.#updateContext(); return; }
    if (classified.kind === "defer") {
      const result = this.#deferredSubmissions.enqueue(classified.text, images, this.#submissionOrder++);
      if (!result.accepted) throw new Error(result.reason === "items"
        ? "Too many commands are waiting for the current turn to finish"
        : "Commands waiting for the current turn exceed the input byte limit");
      this.#terminal.notify("Command queued until the current turn finishes");
      return;
    }
    if (classified.kind === "follow_up") session.followUp(classified.text, [...images]);
    else session.steer(classified.text, [...images]);
    this.#updateContext();
  }

  async #drainDeferredSubmissions(): Promise<void> {
    if (this.#drainingDeferred || !this.#runtime.session.isIdle) return;
    this.#drainingDeferred = true;
    try {
      while (this.#runtime.session.isIdle && this.#activePrompt === undefined) {
        const next = this.#deferredSubmissions.shift();
        if (next === undefined) return;
        await this.#coordinator.dispatchSubmission(next.text, next.images);
      }
    } finally {
      this.#drainingDeferred = false;
    }
  }

  #dequeueMessage(): void {
    const restored = this.#runtime.session.dequeueMessage();
    if (restored === undefined) this.#terminal.notify("No queued messages to restore");
    else this.#terminal.restoreQueuedMessages([restored]);
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

  #reportError(error: unknown): void {
    if (this.#closed) return;
    this.#terminal.notify(error instanceof Error ? error.message : String(error), "error");
  }
}
