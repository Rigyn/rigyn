import type { ImageBlock } from "../core/types.js";
import { loadSkill } from "../context/skills.js";
import type { LoadedRuntime } from "../cli/runtime.js";
import type {
  RuntimeAdvancedUiOperation,
  RuntimeInitialUiOperation,
} from "../extensions/index.js";
import { renderExtensionCommand, renderExtensionPrompt } from "../extensions/templates.js";
import { createNativeUiHost, createUnsafeTerminalHost } from "../tui/native-ui.js";
import type { PickerItem, TuiAction } from "../tui/types.js";
import type { HarnessResourceCatalog } from "../service/resource-catalog.js";
import type {
  InteractiveModeHost,
  InteractiveModeHostContext,
  InteractiveModeOwner,
  InteractiveModeRouteResult,
  ModeSession,
  OwnedInteractiveDelegatedAction,
  OwnedInteractiveDelegatedActionHandler,
  OwnedInteractiveDelegatedCommand,
  OwnedInteractiveDelegatedCommandHandler,
} from "./index.js";

export interface OwnedInteractiveHostOptions {
  noBrowser?: boolean;
  historyEvents?: number;
  historyBytes?: number;
  delegatedCommands?: Partial<Record<OwnedInteractiveDelegatedCommand, OwnedInteractiveDelegatedCommandHandler>>;
  delegatedActions?: Partial<Record<OwnedInteractiveDelegatedAction, OwnedInteractiveDelegatedActionHandler>>;
}

export interface OwnedInteractiveModeHost extends InteractiveModeHost {
  dispose(): Promise<void>;
}

export const OWNED_INTERACTIVE_COMMANDS = Object.freeze([
  { name: "model", syntax: "model [PROVIDER/MODEL]", description: "Select an available model" },
  { name: "resume", syntax: "resume [THREAD_ID]", description: "Resume a workspace session" },
  { name: "new", syntax: "new [NAME]", description: "Create a workspace session" },
  { name: "name", syntax: "name [NAME]", description: "Set or clear the current session name" },
  { name: "compact", syntax: "compact [INSTRUCTIONS]", description: "Compact the current session" },
  { name: "reload", syntax: "reload", description: "Reload runtime resources transactionally" },
  { name: "login", syntax: "login [PROVIDER]", description: "Connect a provider" },
  { name: "logout", syntax: "logout [PROVIDER]", description: "Remove a saved provider credential" },
  { name: "session", syntax: "session", description: "Show the current session identity" },
  { name: "resources", syntax: "resources", description: "Show the active resource inventory" },
  { name: "clone", syntax: "clone [NAME]", description: "Clone the current session path" },
  { name: "copy", syntax: "copy", description: "Copy the latest assistant message" },
  { name: "hotkeys", syntax: "hotkeys", description: "Show embedded terminal shortcuts" },
  { name: "quit", syntax: "quit", description: "Close embedded interactive mode" },
] as const);

const DELEGATED_COMMANDS: Readonly<Record<OwnedInteractiveDelegatedCommand, { syntax: string; description: string }>> = Object.freeze({
  settings: { syntax: "settings", description: "Open host settings" },
  llama: { syntax: "llama", description: "Open host local-model management" },
  "scoped-models": { syntax: "scoped-models", description: "Configure host model cycling scope" },
  export: { syntax: "export [OPTIONS] [FILE]", description: "Export through host policy" },
  share: { syntax: "share [FILE]", description: "Create a share artifact through host policy" },
  changelog: { syntax: "changelog", description: "Show the host changelog" },
  import: { syntax: "import [FILE]", description: "Import through host policy" },
  context: { syntax: "context", description: "Show host context provenance" },
  fork: { syntax: "fork", description: "Fork through host branch-selection policy" },
  tree: { syntax: "tree", description: "Open the host session tree" },
  trust: { syntax: "trust", description: "Change trust through host policy" },
});

type OwnedInteractiveCommandName = typeof OWNED_INTERACTIVE_COMMANDS[number]["name"];
type RuntimeUiFactory = typeof import("../cli/main.js")["runtimeUi"];
type LoginInteractively = typeof import("../cli/main.js")["loginInteractively"];
type RefreshModelPicker = typeof import("../cli/main.js")["refreshModelPicker"];
type IsAgentOpenAIModel = typeof import("../cli/main.js")["isAgentOpenAIModel"];

interface SessionSelection {
  threadId: string;
  branch: string;
}

interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
  reasoningEfforts?: string[];
}

const SUPPORTED_COMMANDS = new Set<string>(OWNED_INTERACTIVE_COMMANDS.map((command) => command.name));

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function commandParts(text: string): { name: string; args: string } {
  const trimmed = text.trim();
  const whitespace = trimmed.search(/\s/u);
  return whitespace < 0
    ? { name: trimmed.slice(1), args: "" }
    : { name: trimmed.slice(1, whitespace), args: trimmed.slice(whitespace + 1).trim() };
}

function modelSelection(value: unknown): ModelSelection | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (!("provider" in value) || typeof value.provider !== "string") return undefined;
  if (!("model" in value) || typeof value.model !== "string") return undefined;
  if ("reasoningEffort" in value && value.reasoningEffort !== undefined && typeof value.reasoningEffort !== "string") {
    return undefined;
  }
  return {
    provider: value.provider,
    model: value.model,
    ...("reasoningEffort" in value && typeof value.reasoningEffort === "string"
      ? { reasoningEffort: value.reasoningEffort }
      : {}),
    ...("reasoningEfforts" in value && Array.isArray(value.reasoningEfforts)
      && value.reasoningEfforts.every((entry) => typeof entry === "string")
      ? { reasoningEfforts: [...value.reasoningEfforts] }
      : {}),
  };
}

function sessionSelection(value: unknown): SessionSelection | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (!("threadId" in value) || typeof value.threadId !== "string") return undefined;
  if (!("branch" in value) || typeof value.branch !== "string") return undefined;
  return { threadId: value.threadId, branch: value.branch };
}

function skillInvocation(name: string, location: string, directory: string, instructions: string, args: string): string {
  const attribute = (value: string): string => value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
  return [
    `<skill name="${attribute(name)}" location="${attribute(location)}">`,
    `References are relative to ${directory}.`,
    instructions,
    "</skill>",
    args,
  ].filter((value, index) => index < 4 || value !== "").join("\n");
}

function applyInitialUi(
  factory: RuntimeUiFactory,
  terminal: InteractiveModeHostContext["terminal"],
  operation: RuntimeInitialUiOperation,
  signal: AbortSignal,
): void {
  const ui = factory(terminal, operation.extensionId, signal);
  if (operation.type === "notify") ui.notify(operation.value, operation.kind);
  else if (operation.type === "title") ui.setTitle(operation.value);
  else if (operation.type === "status") ui.setStatus(operation.key ?? "default", operation.value || undefined);
  else if (operation.type === "widget") ui.setWidget(operation.key ?? "default", operation.value || undefined);
  else if (operation.type === "header") ui.setHeader(operation.key ?? "default", operation.value || undefined);
  else if (operation.type === "footer") ui.setFooter(operation.key ?? "default", operation.value || undefined);
  else if (operation.type === "working_message") ui.setWorkingMessage(operation.value || undefined);
  else ui.setWorkingVisible(operation.visible);
}

function applyAdvancedUi(terminal: InteractiveModeHostContext["terminal"], operation: RuntimeAdvancedUiOperation): void {
  const key = `${operation.extensionId}:${"key" in operation ? operation.key : "global"}`;
  if (operation.type === "component") {
    terminal.setPersistentComponent(operation.slot, key, operation.factory, operation.signal);
  } else if (operation.type === "working_indicator") {
    terminal.setKeyedWorkingIndicator(key, operation.value, operation.signal);
  } else if (operation.type === "hidden_reasoning_label") {
    terminal.setKeyedHiddenReasoningLabel(key, operation.value, operation.signal);
  } else if (operation.type === "tool_output_expanded") {
    terminal.setKeyedToolOutputExpanded(key, operation.expanded, operation.signal);
  } else {
    terminal.setNormalizedKeyObserver(key, operation.observer, operation.signal);
  }
}

class RuntimeOwnedInteractiveHost implements OwnedInteractiveModeHost {
  readonly #runtime: LoadedRuntime;
  readonly #owner: InteractiveModeOwner;
  readonly #options: OwnedInteractiveHostOptions;
  #context: InteractiveModeHostContext | undefined;
  #runtimeUi: RuntimeUiFactory | undefined;
  #loginInteractively: LoginInteractively | undefined;
  #refreshModelPicker: RefreshModelPicker | undefined;
  #isAgentOpenAIModel: IsAgentOpenAIModel | undefined;
  #modelItems: PickerItem<ModelSelection>[] = [];
  #sessionCursor: string | undefined;
  #sessionSearch = "";
  #extensionSession: { threadId: string; branch: string } | undefined;
  #changeCleanup: (() => void) | undefined;
  #publicationCleanup: (() => void) | undefined;
  #disposePromise: Promise<void> | undefined;

  constructor(runtime: LoadedRuntime, owner: InteractiveModeOwner, options: OwnedInteractiveHostOptions) {
    this.#runtime = runtime;
    this.#owner = owner;
    this.#options = options;
  }

  async attach(context: InteractiveModeHostContext): Promise<() => Promise<void>> {
    if (this.#context !== undefined) throw new Error("Interactive host is already attached");
    const cli = await import("../cli/main.js");
    this.#runtimeUi = cli.runtimeUi;
    this.#loginInteractively = cli.loginInteractively;
    this.#refreshModelPicker = cli.refreshModelPicker;
    this.#isAgentOpenAIModel = cli.isAgentOpenAIModel;
    this.#context = context;
    this.#runtime.setExtensionShutdownHandler(async () => {
      context.close();
      return { accepted: true, message: "Embedded interaction host closed" };
    });
    this.#bindGeneration(context);
    await this.#transitionSession(context.session(), "startup");
    await this.#refreshPresentation(context);
    return async () => await this.dispose();
  }

  async repaint(context: InteractiveModeHostContext): Promise<void> {
    this.#assertAttached(context);
    const session = context.session();
    await this.#transitionSession(session, "resume");
    const history = this.#runtime.store.listEventTail(session.threadId, session.branch, {
      ...(this.#options.historyEvents === undefined ? {} : { maxEvents: this.#options.historyEvents }),
      ...(this.#options.historyBytes === undefined ? {} : { maxBytes: this.#options.historyBytes }),
    });
    context.terminal.replaceTranscript(history.events, session.branch);
    if (history.truncated) {
      context.terminal.notify(
        history.events.length === 0
          ? "Saved history exceeds the embedded replay limit; the complete session remains stored."
          : `Showing the newest ${history.events.length} saved events; older session history remains stored.`,
        "warning",
      );
    }
  }

  async route(
    text: string,
    images: readonly ImageBlock[],
    context: InteractiveModeHostContext,
  ): Promise<InteractiveModeRouteResult> {
    this.#assertAttached(context);
    if (!text.trimStart().startsWith("/")) return await this.#reduceInput(text, images, context);
    const { name, args } = commandParts(text);
    if (SUPPORTED_COMMANDS.has(name)) {
      const routed = await this.#routeBuiltin(name as OwnedInteractiveCommandName, args, context);
      return routed.action === "submit"
        ? await this.#reduceInput(routed.text, routed.images ?? images, context)
        : routed;
    }
    if (Object.hasOwn(this.#options.delegatedCommands ?? {}, name)) {
      const handler = this.#options.delegatedCommands?.[name as OwnedInteractiveDelegatedCommand];
      if (handler === undefined) throw new Error(`Embedded command is not bound: /${name}`);
      const result = await handler(args, context);
      if (result === undefined || result.action === "handled") return { action: "handled" };
      return await this.#reduceInput(result.text, result.images ?? images, context);
    }
    const expanded = await this.#expandResource(name, args, context);
    if (expanded === undefined) throw new Error(`Unknown embedded command: /${name}`);
    if (expanded.action === "handled") return expanded;
    return await this.#reduceInput(expanded.text, expanded.images ?? images, context);
  }

  async action(action: TuiAction, context: InteractiveModeHostContext): Promise<boolean> {
    this.#assertAttached(context);
    switch (action.type) {
      case "submit": {
        const images = [
          ...(action.images ?? []).map((image) => ({ ...image.block })),
          ...(action.recoveredImages ?? []).map((image) => ({ ...image })),
        ];
        await context.submit(action.text, images);
        return true;
      }
      case "queue_restore_discard":
        return await this.#delegatedAction("queue_restore_discard", action, context);
      case "paste_image":
        return await this.#delegatedAction("paste_image", action, context);
      case "dequeue":
        return await this.#delegatedAction("dequeue", action, context);
      case "copy":
        await context.submit("/copy");
        return true;
      case "suspend":
        await context.terminal.drainInput();
        context.terminal.suspend();
        return true;
      case "session_open":
        await this.#refreshSessions(context, "", false);
        return true;
      case "session_search":
        await this.#refreshSessions(context, action.query, false);
        return true;
      case "session_more":
        await this.#refreshSessions(context, action.query, true);
        return true;
      case "session_scope":
        context.terminal.setSessionPickerScope("current", "Embedded mode lists sessions from the owned workspace only");
        return true;
      case "session_rename": {
        const selected = sessionSelection(action.item.value);
        if (selected === undefined) return false;
        const session = selected.threadId === context.session().threadId
          ? context.session()
          : await this.#owner.openSession({
              threadId: selected.threadId,
              branch: selected.branch,
              signal: context.signal,
            });
        if (session.setName === undefined) throw new Error("This session owner cannot rename sessions");
        await session.setName(action.name, context.signal);
        await this.#refreshSessions(context, action.query, false);
        context.terminal.notify(`Session renamed ${action.name}`);
        return true;
      }
      case "session_delete": {
        const selected = sessionSelection(action.item.value);
        if (selected === undefined) return false;
        if (selected.threadId === context.session().threadId) throw new Error("The active session cannot be deleted");
        await this.#runtime.service.deleteSession(selected.threadId);
        await this.#refreshSessions(context, action.query, false);
        context.terminal.notify(`Deleted session ${selected.threadId}`);
        return true;
      }
      case "cycle_thinking": {
        const current = context.session().getModel();
        if (current === undefined) throw new Error("Select a model before changing reasoning effort");
        const item = this.#modelItems.find((candidate) =>
          candidate.value.provider === current.provider && candidate.value.model === current.model);
        const efforts = item?.value.reasoningEfforts ?? [];
        if (efforts.length === 0) {
          context.terminal.notify("The active model catalog does not declare supported reasoning levels", "warning");
          return true;
        }
        const index = current.reasoningEffort === undefined ? -1 : efforts.indexOf(current.reasoningEffort);
        const reasoningEffort = efforts[(index + 1) % efforts.length];
        if (reasoningEffort === undefined) return true;
        await this.#selectModel({
          provider: current.provider,
          model: current.model,
          reasoningEffort,
          reasoningEfforts: efforts,
        }, context);
        return true;
      }
      case "extension_shortcut": {
        if (action.generation !== this.#runtime.generationSignal || action.generation.aborted) return true;
        const selected = this.#runtime.runtimeExtensions.shortcuts().find((entry) => entry.shortcut === action.shortcut);
        if (selected === undefined || this.#runtimeUi === undefined) return false;
        await this.#runtime.runtimeExtensions.runShortcut(action.shortcut, {
          threadId: context.session().threadId,
          branch: context.session().branch,
          signal: AbortSignal.any([context.signal, this.#runtime.generationSignal]),
          ui: this.#runtimeUi(context.terminal, selected.extensionId, this.#runtime.generationSignal),
        });
        this.#reportDiagnostics(context);
        return true;
      }
      case "command":
        if (typeof action.item.value !== "string") return false;
        await context.submit(action.item.value);
        return true;
      case "select": {
        if (action.picker === "model") {
          const selection = modelSelection(action.item.value);
          if (selection === undefined) return false;
          await this.#selectModel(selection, context);
          return true;
        }
        if (action.picker === "session") {
          const selected = sessionSelection(action.item.value);
          if (selected === undefined) return false;
          await this.#resume(selected.threadId, selected.branch, context);
          return true;
        }
        return await this.#delegatedAction(action.picker === "provider" ? "provider_select" : "file_select", action, context);
      }
      case "cancel":
      case "exit":
      case "signal":
      case "error":
      case "copy_text":
      case "steer":
      case "follow_up":
        // These are consumed by InteractiveMode before an optional host is invoked.
        return false;
      default: {
        const exhaustive: never = action;
        throw new Error(`Unhandled terminal action: ${String(exhaustive)}`);
      }
    }
  }

  async #delegatedAction(
    name: OwnedInteractiveDelegatedAction,
    action: TuiAction,
    context: InteractiveModeHostContext,
  ): Promise<boolean> {
    const handler = this.#options.delegatedActions?.[name];
    if (handler === undefined) {
      context.terminal.notify(`The embedding host did not provide the ${name.replaceAll("_", " ")} capability`, "warning");
      return true;
    }
    await handler(action, context);
    return true;
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#dispose();
    return this.#disposePromise;
  }

  async #dispose(): Promise<void> {
    const context = this.#context;
    this.#context = undefined;
    this.#changeCleanup?.();
    this.#changeCleanup = undefined;
    this.#publicationCleanup?.();
    this.#publicationCleanup = undefined;
    if (context !== undefined) context.terminal.clearExtensionUi();
    try { this.#runtime.setExtensionShutdownHandler(undefined); } catch {}
    if (this.#extensionSession !== undefined) {
      const ending = this.#extensionSession;
      this.#extensionSession = undefined;
      await this.#runtime.runtimeExtensions.dispatch("session_end", {
        ...ending,
        workspace: this.#runtime.workspace,
        reason: "quit",
      }).catch(() => undefined);
    }
  }

  async #routeBuiltin(
    name: OwnedInteractiveCommandName,
    args: string,
    context: InteractiveModeHostContext,
  ): Promise<InteractiveModeRouteResult> {
    switch (name) {
      case "model": {
        if (args === "") {
          await this.#refreshCatalog(context, true);
          context.terminal.openPicker("model", "Models");
        } else {
          await this.#refreshCatalog(context, true);
          const selected = this.#modelItems.find((item) => `${item.value.provider}/${item.value.model}` === args)?.value;
          if (selected === undefined) throw new Error(`Model is not in the active catalog: ${args}`);
          await this.#selectModel(selected, context);
        }
        return { action: "handled" };
      }
      case "resume": {
        if (args === "") {
          await this.#refreshSessions(context, "", false);
          context.terminal.openPicker("session", "Sessions");
        } else await this.#resume(args, undefined, context);
        return { action: "handled" };
      }
      case "new": {
        const session = await this.#owner.createSession({
          ...(args === "" ? {} : { name: args }),
          signal: context.signal,
        });
        await context.replaceSession(session);
        await this.#refreshSessions(context, "", false);
        context.terminal.notify(`Created session ${session.threadId}`);
        return { action: "handled" };
      }
      case "name": {
        const session = context.session();
        if (session.setName === undefined) throw new Error("This session owner cannot rename sessions");
        const requested = args === ""
          ? await context.terminal.requestInput("Session name (empty clears it)", undefined, context.signal)
          : args;
        await session.setName(requested.trim() === "" ? undefined : requested.trim(), context.signal);
        await this.#refreshSessions(context, "", false);
        context.terminal.notify(requested.trim() === "" ? "Session name cleared" : `Session named ${requested.trim()}`);
        return { action: "handled" };
      }
      case "compact": {
        const session = context.session();
        if (session.compact === undefined) throw new Error("This session owner cannot compact sessions");
        context.terminal.setInputBlocked("Compacting the current session...", "compact");
        try {
          await session.compact({
            ...(args === "" ? {} : { instructions: args }),
            signal: context.signal,
          });
          await this.repaint(context);
          context.terminal.notify("Session compacted");
        } finally {
          context.terminal.setInputBlocked();
        }
        return { action: "handled" };
      }
      case "reload": {
        await this.#reload(context, context.signal);
        return { action: "handled" };
      }
      case "login": {
        if (this.#loginInteractively === undefined) throw new Error("Interactive authentication is unavailable");
        const provider = await this.#loginInteractively(
          this.#runtime,
          context.terminal,
          args === "" ? undefined : args,
          context.signal,
          this.#options.noBrowser ?? false,
        );
        for (const affected of this.#runtime.auth.affectedProviders(provider)) this.#runtime.providers.invalidateModels(affected);
        await this.#refreshCatalog(context, true);
        context.terminal.notify(`Connected ${provider}`);
        return { action: "handled" };
      }
      case "logout": {
        const provider = args === "" ? await this.#chooseLogoutProvider(context) : args;
        const result = await this.#runtime.auth.logout(provider, {
          fetch: this.#runtime.network.fetch,
          signal: context.signal,
        });
        for (const affected of this.#runtime.auth.affectedProviders(provider)) this.#runtime.providers.invalidateModels(affected);
        await this.#refreshCatalog(context, true);
        context.terminal.notify(result.removedStored ? `Disconnected ${provider}` : `No saved credential existed for ${provider}`);
        return { action: "handled" };
      }
      case "session": {
        const session = context.session();
        const selected = session.getModel();
        context.terminal.notify([
          `Thread: ${session.threadId}`,
          `Branch: ${session.branch}`,
          selected === undefined ? "Model: not selected" : `Model: ${selected.provider}/${selected.model}`,
        ].join("\n"));
        return { action: "handled" };
      }
      case "resources": {
        const catalog = await this.#refreshCatalog(context);
        context.terminal.notify([
          `${catalog.extensions.filter((entry) => entry.status === "active").length} active extensions`,
          `${catalog.skills.length} skills`,
          `${catalog.prompts.length + catalog.commands.extensionTemplates.length + catalog.commands.runtimeExtensions.length} commands and prompts`,
          `${catalog.providers.reduce((total, provider) => total + provider.models.length, 0)} available models`,
          ...(catalog.bounds.truncated ? ["The bounded resource catalog omits additional entries"] : []),
        ].join(" · "));
        return { action: "handled" };
      }
      case "clone": {
        const session = context.session();
        if (session.fork === undefined) throw new Error("This session owner cannot clone sessions");
        const cloned = await session.fork({
          ...(args === "" ? {} : { name: args }),
          signal: context.signal,
        });
        await context.replaceSession(cloned);
        await this.#refreshSessions(context, "", false);
        context.terminal.notify(`Cloned session ${cloned.threadId}`);
        return { action: "handled" };
      }
      case "copy": {
        const events = this.#runtime.store.listEventTail(context.session().threadId, context.session().branch).events;
        const latest = events.toReversed().find((envelope) =>
          envelope.event.type === "message_appended" && envelope.event.message.role === "assistant");
        if (latest === undefined || latest.event.type !== "message_appended") {
          throw new Error("This session has no assistant text to copy");
        }
        const text = latest.event.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
        if (text === "") throw new Error("The latest assistant message contains no text");
        context.terminal.copyToClipboard(text);
        context.terminal.notify("Copied the latest assistant message");
        return { action: "handled" };
      }
      case "hotkeys":
        context.terminal.notify([
          "Esc interrupts the active run",
          "Ctrl+C clears input; repeat on an empty editor to exit",
          "Ctrl+D exits from an empty editor",
          "Ctrl+O expands or collapses tool output",
          "Use the configured model and session shortcuts to open their pickers",
        ].join("\n"));
        return { action: "handled" };
      case "quit":
        context.close();
        return { action: "handled" };
      default: {
        const exhaustive: never = name;
        throw new Error(`Unbound embedded command: ${exhaustive}`);
      }
    }
  }

  async #expandResource(
    name: string,
    args: string,
    context: InteractiveModeHostContext,
  ): Promise<InteractiveModeRouteResult | undefined> {
    if (name === "prompt") {
      const [id = "", ...rest] = args.split(/\s+/u);
      const prompt = id === "" ? undefined : this.#runtime.extensions.prompt(id);
      if (prompt === undefined) throw new Error(`Unknown prompt: ${id || "(missing ID)"}`);
      context.terminal.notify(`Expanded prompt /${id} from ${prompt.extensionId}`);
      return { action: "submit", text: renderExtensionPrompt(prompt, rest.join(" ")) };
    }
    if (name.startsWith("skill:")) {
      if (!this.#runtime.config.enableSkillCommands) return undefined;
      const skillName = name.slice("skill:".length);
      const skill = this.#runtime.service.skills.find((entry) => entry.name === skillName);
      if (skill === undefined) throw new Error(`Unknown skill: ${skillName}`);
      const loaded = await loadSkill(skill);
      return {
        action: "submit",
        text: skillInvocation(skill.name, skill.manifestPath, skill.directory, loaded.instructions, args),
      };
    }
    const runtimeCommand = this.#runtime.runtimeExtensions.commands().find((command) => command.name === name);
    if (runtimeCommand !== undefined) {
      if (this.#runtimeUi === undefined) throw new Error("Interactive extension UI is unavailable");
      const result = await this.#runtime.runtimeExtensions.runCommand(name, {
        args,
        threadId: context.session().threadId,
        branch: context.session().branch,
        signal: AbortSignal.any([context.signal, this.#runtime.generationSignal]),
        ui: this.#runtimeUi(context.terminal, runtimeCommand.extensionId, this.#runtime.generationSignal),
      });
      this.#reportDiagnostics(context);
      return result.prompt === undefined
        ? { action: "handled" }
        : { action: "submit", text: result.prompt };
    }
    const command = this.#runtime.extensions.command(name);
    if (command !== undefined) {
      context.terminal.notify(`Expanded /${name} from ${command.extensionId}`);
      return { action: "submit", text: renderExtensionCommand(command, args) };
    }
    const prompt = this.#runtime.extensions.prompt(name);
    if (prompt !== undefined) {
      context.terminal.notify(`Expanded /${name} from ${prompt.extensionId}`);
      return { action: "submit", text: renderExtensionPrompt(prompt, args) };
    }
    return undefined;
  }

  async #reduceInput(
    text: string,
    images: readonly ImageBlock[],
    context: InteractiveModeHostContext,
  ): Promise<InteractiveModeRouteResult> {
    const before = this.#runtime.runtimeExtensions.diagnostics().length;
    const result = await this.#runtime.runtimeExtensions.reduceInput({
      threadId: context.session().threadId,
      branch: context.session().branch,
      text,
      ...(images.length === 0 ? {} : { images: images.map((image) => ({ ...image })) }),
      source: "tui",
    }, AbortSignal.any([context.signal, this.#runtime.generationSignal]));
    this.#reportDiagnostics(context, before);
    if (result.action === "handled") return { action: "handled" };
    if (result.action === "continue") {
      return { action: "submit", text, images: images.map((image) => ({ ...image })) };
    }
    return {
      action: "submit",
      text: result.text,
      ...(result.images === undefined ? {} : { images: result.images.map((image) => ({ ...image })) }),
    };
  }

  async #selectModel(selection: ModelSelection, context: InteractiveModeHostContext): Promise<void> {
    const session = context.session();
    if (session.setModel === undefined) throw new Error("This session owner cannot select models");
    if (selection.reasoningEfforts !== undefined) {
      const item = this.#modelItems.find((candidate) =>
        candidate.value.provider === selection.provider && candidate.value.model === selection.model);
      if (item === undefined) {
        this.#modelItems.push({
          id: `${selection.provider}/${selection.model}`,
          label: `${selection.provider} / ${selection.model}`,
          value: { ...selection, reasoningEfforts: [...selection.reasoningEfforts] },
        });
      } else item.value.reasoningEfforts = [...selection.reasoningEfforts];
    }
    const selected = await session.setModel({
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    }, context.signal);
    context.terminal.setContext({
      threadId: context.session().threadId,
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { thinking: selected.reasoningEffort }),
      active: false,
      status: "idle",
    });
    context.terminal.notify(`Model ${selected.provider}/${selected.model}`);
  }

  async #resume(threadId: string, branch: string | undefined, context: InteractiveModeHostContext): Promise<void> {
    const session = await this.#owner.openSession({
      threadId,
      ...(branch === undefined ? {} : { branch }),
      signal: context.signal,
    });
    await context.replaceSession(session);
    await this.#refreshSessions(context, this.#sessionSearch, false);
    context.terminal.notify(`Resumed ${session.threadId}`);
  }

  async #chooseLogoutProvider(context: InteractiveModeHostContext): Promise<string> {
    const providers = this.#runtime.auth.providers();
    if (providers.length === 0) throw new Error("No provider authentication methods are registered");
    return await context.terminal.choose("Disconnect provider", providers.map((binding) => ({
      label: binding.displayName,
      detail: binding.providerId,
      value: binding.providerId,
    })), context.signal);
  }

  async #reload(context: InteractiveModeHostContext, signal: AbortSignal): Promise<void> {
    context.terminal.setInputBlocked("Reloading extensions, skills, prompts, themes, context, and providers...", "reload");
    try {
      const result = await this.#runtime.reload({
        session: { threadId: context.session().threadId, branch: context.session().branch },
        signal,
        onCommit: () => this.#bindGeneration(context),
      });
      await this.#refreshPresentation(context);
      for (const warning of result.warnings) context.terminal.notify(warning, "warning");
      context.terminal.notify("Runtime resources reloaded");
    } finally {
      context.terminal.setInputBlocked();
    }
  }

  #bindGeneration(context: InteractiveModeHostContext): void {
    this.#changeCleanup?.();
    this.#publicationCleanup?.();
    context.terminal.clearExtensionUi();
    const host = this.#runtime.runtimeExtensions;
    const generation = this.#runtime.generationSignal;
    const uiFactory = this.#runtimeUi;
    if (uiFactory === undefined) throw new Error("Interactive UI adapter is unavailable");

    const bindRenderers = (): void => {
      context.terminal.setToolRenderers({
        has: (name) => host.renderers().some((renderer) => renderer.kind === "tool" && renderer.key === name),
        renderCall: (name, view, renderContext) => host.renderToolCall(name, view, renderContext),
        renderResult: (name, view, renderContext) => host.renderToolResult(name, view, renderContext),
      }, generation);
      context.terminal.setSessionRenderers({
        renderState: (envelope, branch, renderContext) => host.renderExtensionState({
          ...envelope.event,
          threadId: envelope.threadId,
          branch,
          eventId: envelope.eventId,
          timestamp: envelope.timestamp,
        }, renderContext),
        renderMessage: (envelope, branch, renderContext) => host.renderExtensionMessage({
          ...envelope.event,
          threadId: envelope.threadId,
          branch,
          eventId: envelope.eventId,
          timestamp: envelope.timestamp,
        }, renderContext),
      }, generation);
      if (host.renderers().some((renderer) => renderer.kind === "editor")) {
        context.terminal.setEditorRenderer({
          render: (view, renderContext) => host.renderEditor(view, renderContext),
        }, generation);
      } else context.terminal.setEditorRenderer();
    };
    const bindInputs = (): void => {
      context.terminal.setExtensionShortcuts(host.shortcuts(), generation);
      context.terminal.setCommandCompletionProvider(
        async (name, prefix, signal) => await host.completeCommandArguments(name, prefix, signal),
        generation,
      );
      if (host.hasAutocompleteProviders()) {
        context.terminal.setAutocompleteProvider(
          async (text, cursor, signal) => await host.completeInput({ text, cursor }, signal),
          generation,
        );
      } else context.terminal.setAutocompleteProvider();
      if (host.hasEditorMiddleware()) {
        context.terminal.setEditorMiddleware(
          (event, snapshot) => host.handleEditorInput(event, snapshot),
          generation,
        );
      } else context.terminal.setEditorMiddleware();
    };

    bindRenderers();
    bindInputs();
    for (const operation of host.initialUi()) applyInitialUi(uiFactory, context.terminal, operation, generation);
    host.setUiHandler((operation) => applyInitialUi(uiFactory, context.terminal, operation, generation));
    host.setAdvancedUiHandler({
      apply: (operation) => applyAdvancedUi(context.terminal, operation),
      getToolOutputExpanded: () => context.terminal.getToolOutputExpanded(),
    });
    host.setNativeUiHandler((extensionId, signal) => createNativeUiHost(context.terminal, extensionId, signal));
    host.setUnsafeTerminalHandler((extensionId, signal) => createUnsafeTerminalHost(context.terminal, extensionId, signal));
    host.setInteractiveUiHandler((extensionId, signal) => uiFactory(context.terminal, extensionId, signal));
    host.setSessionFocusHandler(async (session, signal) => {
      const selected = await this.#owner.openSession({
        threadId: session.threadId,
        ...(session.branch === undefined ? {} : { branch: session.branch }),
        signal,
      });
      await context.replaceSession(selected);
    });
    host.setModelFocusHandler(async (target, selection, signal) => {
      const current = context.session();
      if (target.threadId !== current.threadId || (target.branch ?? current.branch) !== current.branch) return;
      if (current.setModel === undefined) throw new Error("This session owner cannot select models");
      const selected = await current.setModel(selection, signal);
      context.terminal.setContext({
        threadId: current.threadId,
        provider: selected.provider,
        model: selected.model,
        ...(selected.reasoningEffort === undefined ? {} : { thinking: selected.reasoningEffort }),
        active: false,
        status: "idle",
      });
    });
    host.setReloadHandler(async (input) => {
      await this.#reload(context, input.signal ?? context.signal);
      return { warnings: [] };
    });

    this.#publicationCleanup = this.#runtime.service.onExtensionSessionEvent((publication) => {
      const current = context.session();
      if (publication.envelope.threadId !== current.threadId || publication.branch !== current.branch) return;
      context.terminal.renderExtensionSession(publication.envelope, publication.branch);
    });
    this.#changeCleanup = host.onChange((change) => {
      if (generation.aborted || this.#context !== context) return;
      if (change === "tool_renderer" || change === "session_renderer" || change === "editor_renderer") bindRenderers();
      if (change === "shortcut" || change === "autocomplete" || change === "editor_middleware" || change === "command") bindInputs();
      if (change === "command" || change === "provider" || change === "provider_auth") {
        void this.#refreshPresentation(context).catch((cause) => {
          if (!context.signal.aborted) context.terminal.notify(`Presentation refresh failed: ${errorMessage(cause)}`, "warning");
        });
      }
    });
  }

  async #refreshPresentation(context: InteractiveModeHostContext): Promise<void> {
    const catalog = await this.#refreshCatalog(context);
    await this.#refreshSessions(context, this.#sessionSearch, false);
    const commandItems: PickerItem<string>[] = [
      ...OWNED_INTERACTIVE_COMMANDS.map((command) => ({
        id: `builtin:${command.name}`,
        label: `/${command.syntax}`,
        detail: command.description,
        value: `/${command.name}`,
        keywords: [command.name, command.description],
      })),
      ...Object.entries(this.#options.delegatedCommands ?? {}).flatMap(([name, handler]) => {
        if (handler === undefined || !Object.hasOwn(DELEGATED_COMMANDS, name)) return [];
        const command = DELEGATED_COMMANDS[name as OwnedInteractiveDelegatedCommand];
        return [{
          id: `delegated:${name}`,
          label: `/${command.syntax}`,
          detail: command.description,
          value: `/${name}`,
          keywords: [name, command.description, "host policy"],
        } satisfies PickerItem<string>];
      }),
      ...catalog.commands.runtimeExtensions.map((command) => ({
        id: `runtime:${command.extensionId}:${command.name}`,
        label: `/${command.name}`,
        ...(command.description === undefined ? {} : { detail: command.description }),
        value: `/${command.name}`,
        keywords: [command.extensionId, command.argumentHint ?? ""],
      })),
      ...catalog.commands.extensionTemplates.map((command) => ({
        id: `template:${command.extensionId}:${command.name}`,
        label: `/${command.name}`,
        ...(command.description === undefined ? {} : { detail: command.description }),
        value: `/${command.name}`,
        keywords: [command.extensionId, command.argumentHint ?? ""],
      })),
      ...catalog.prompts.map((prompt) => ({
        id: `prompt:${prompt.extensionId}:${prompt.id}`,
        label: `/${prompt.id}`,
        ...(prompt.description === undefined ? {} : { detail: prompt.description }),
        value: `/${prompt.id}`,
        keywords: [prompt.extensionId, prompt.argumentHint ?? "", "prompt"],
      })),
      ...(this.#runtime.config.enableSkillCommands ? catalog.skills.map((skill) => ({
        id: `skill:${skill.name}`,
        label: `/skill:${skill.name}`,
        detail: skill.description,
        value: `/skill:${skill.name}`,
        keywords: [skill.scope, "skill"],
      })) : []),
    ];
    context.terminal.setPickerItems("command", commandItems);
  }

  async #refreshCatalog(context: InteractiveModeHostContext, refreshModels = false): Promise<HarnessResourceCatalog> {
    const signal = AbortSignal.any([context.signal, this.#runtime.generationSignal]);
    const current = context.session().getModel();
    const pickerRefresh = this.#refreshModelPicker;
    const modelTask = pickerRefresh !== undefined
      ? pickerRefresh(
          this.#runtime.providers.list(),
          context.terminal,
          current === undefined ? undefined : { provider: current.provider, model: current.model },
          signal,
          [],
          this.#runtime.auth,
          undefined,
          this.#runtime.providers,
          { refresh: refreshModels },
        )
      : this.#runtime.providers.listModels(undefined, signal);
    const [catalog, loadedModels] = await Promise.all([
      this.#owner.resourceCatalog(signal),
      modelTask,
    ]);
    const detailedModels = loadedModels.filter((model) =>
      model.provider !== "openai" || this.#isAgentOpenAIModel?.(model.id) !== false);
    const details = new Map(detailedModels.map((model) => [`${model.provider}\0${model.id}`, model]));
    const candidates = pickerRefresh !== undefined
      ? detailedModels
      : catalog.providers.flatMap((provider) => provider.models.map((model) => ({ ...model, provider: provider.id })));
    this.#modelItems = candidates.map((model): PickerItem<ModelSelection> => {
      const detail = [model.displayName, model.description]
        .filter((value): value is string => value !== undefined && value !== "").join(" · ");
      const reasoningEfforts = details.get(`${model.provider}\0${model.id}`)?.compatibility?.reasoningEfforts?.value;
      return {
        id: `${model.provider}/${model.id}`,
        label: `${model.provider} / ${model.id}`,
        ...(detail === "" ? {} : { detail }),
        value: {
          provider: model.provider,
          model: model.id,
          ...(reasoningEfforts === undefined ? {} : { reasoningEfforts: [...reasoningEfforts] }),
        },
        keywords: [model.provider, model.id, model.displayName ?? "", model.description ?? ""],
      };
    });
    if (current !== undefined && !this.#modelItems.some((item) => item.value.provider === current.provider && item.value.model === current.model)) {
      this.#modelItems.push({
        id: `${current.provider}/${current.model}`,
        label: `${current.provider} / ${current.model}`,
        detail: "Current session model",
        value: {
          ...current,
          ...(details.get(`${current.provider}\0${current.model}`)?.compatibility?.reasoningEfforts?.value === undefined
            ? {}
            : { reasoningEfforts: [...details.get(`${current.provider}\0${current.model}`)!.compatibility!.reasoningEfforts!.value] }),
        },
      });
    }
    this.#modelItems.sort((left, right) => left.label.localeCompare(right.label));
    context.terminal.setModelPickerItems(this.#modelItems);
    context.terminal.setModelCycleItems(this.#modelItems);
    return catalog;
  }

  async #refreshSessions(context: InteractiveModeHostContext, search: string, append: boolean): Promise<void> {
    const selectedSearch = search.trim();
    const page = await this.#owner.listSessions({
      ...(selectedSearch === "" ? {} : { search: selectedSearch }),
      ...(append && this.#sessionCursor !== undefined ? { cursor: this.#sessionCursor } : {}),
      limit: 100,
      signal: context.signal,
    });
    this.#sessionSearch = selectedSearch;
    this.#sessionCursor = page.nextCursor;
    const current = context.session();
    const items = page.sessions.map((session): PickerItem<SessionSelection> => ({
      id: session.threadId,
      label: session.name === undefined || session.name === "" ? session.threadId : session.name,
      detail: session.threadId,
      value: { threadId: session.threadId, branch: session.defaultBranch },
      keywords: [session.threadId, session.name ?? ""],
      session: {
        ...(session.name === undefined ? {} : { name: session.name }),
        path: session.threadId,
        workspace: this.#runtime.workspace,
        updatedAt: session.updatedAt,
        createdAt: session.createdAt,
        current: session.threadId === current.threadId,
      },
    }));
    if (append) context.terminal.addPickerItems("session", items);
    else context.terminal.setPickerItems("session", items);
    context.terminal.setSessionPickerPagination(page.hasMore, page.hasMore ? "More workspace sessions are available" : undefined);
  }

  async #transitionSession(session: ModeSession, reason: "startup" | "resume"): Promise<void> {
    if (session.getModel() === undefined
      && session.setModel !== undefined
      && this.#runtime.config.defaultProvider !== undefined
      && this.#runtime.config.defaultModel !== undefined) {
      await session.setModel({
        provider: this.#runtime.config.defaultProvider,
        model: this.#runtime.config.defaultModel,
      }, this.#context?.signal);
    }
    if (this.#extensionSession?.threadId === session.threadId && this.#extensionSession.branch === session.branch) return;
    const previous = this.#extensionSession;
    if (previous !== undefined) {
      await this.#runtime.runtimeExtensions.dispatch("session_end", {
        ...previous,
        workspace: this.#runtime.workspace,
        reason,
        targetThreadId: session.threadId,
      }).catch(() => undefined);
    }
    this.#extensionSession = { threadId: session.threadId, branch: session.branch };
    await this.#runtime.runtimeExtensions.dispatch("session_start", {
      threadId: session.threadId,
      branch: session.branch,
      workspace: this.#runtime.workspace,
      reason,
      ...(previous === undefined ? {} : { previousThreadId: previous.threadId }),
    }).catch(() => undefined);
  }

  #reportDiagnostics(context: InteractiveModeHostContext, from = 0): void {
    for (const diagnostic of this.#runtime.runtimeExtensions.diagnostics().slice(from)) {
      context.terminal.notify(`Extension ${diagnostic.extensionId}: ${diagnostic.message}`, "warning");
    }
  }

  #assertAttached(context: InteractiveModeHostContext): void {
    if (this.#disposePromise !== undefined) throw new Error("Interactive host is disposed");
    if (this.#context !== context) throw new Error("Interactive host context is not active");
  }
}

/** Runtime-owned policy adapter used only by the opt-in full embedded mode. */
export function createOwnedInteractiveModeHost(
  runtime: LoadedRuntime,
  owner: InteractiveModeOwner,
  options: OwnedInteractiveHostOptions = {},
): OwnedInteractiveModeHost {
  return new RuntimeOwnedInteractiveHost(runtime, owner, options);
}
