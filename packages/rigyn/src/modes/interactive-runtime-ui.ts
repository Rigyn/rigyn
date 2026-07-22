import type { ExtensionRunner } from "../extensions/compat-runtime.js";
import { resolveRuntimeShortcuts } from "../cli/extension-shortcuts.js";
import type {
  RuntimeAdvancedUiOperation,
  RuntimeCommandUi,
  RuntimeInitialUiOperation,
} from "../extensions/runtime.js";
import {
  createInteractiveDirectUiContext,
  type InteractiveDirectUiServices,
} from "../tui/direct-ui.js";
import { createNativeUiHost, createUnsafeTerminalHost } from "../tui/native-ui.js";
import { TuiController, TuiSelectionCancelledError } from "../tui/controller.js";
import type { PickerItem } from "../tui/types.js";

function combined(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
  return secondary === undefined ? primary : AbortSignal.any([primary, secondary]);
}

function commandUi(
  terminal: TuiController,
  extensionId: string,
  generation: AbortSignal,
): RuntimeCommandUi {
  const key = (value: string): string => `${extensionId}:${value}`;
  const cancelled = (cause: unknown, signal: AbortSignal): boolean =>
    cause instanceof TuiSelectionCancelledError || signal.aborted;
  return {
    notify(message, kind = "status") { generation.throwIfAborted(); terminal.notify(message, kind); },
    setStatus(name, value) { generation.throwIfAborted(); terminal.setExtensionStatus(key(name), value); },
    setWidget(name, value) { generation.throwIfAborted(); terminal.setExtensionWidget(key(name), value); },
    setHeader(name, value) { generation.throwIfAborted(); terminal.setExtensionHeader(key(name), value); },
    setFooter(name, value) { generation.throwIfAborted(); terminal.setExtensionFooter(key(name), value); },
    setWorkingMessage(value) { generation.throwIfAborted(); terminal.setExtensionWorkingMessage(extensionId, value); },
    setWorkingVisible(value) { generation.throwIfAborted(); terminal.setExtensionWorkingVisible(extensionId, value); },
    setTitle(value) { generation.throwIfAborted(); terminal.setTitle(value); },
    async getTheme(signal) {
      combined(generation, signal).throwIfAborted();
      return { name: terminal.selectedThemeName(), available: terminal.themeNames() };
    },
    async setTheme(name, signal) {
      combined(generation, signal).throwIfAborted();
      terminal.setTheme(name);
      return { name: terminal.selectedThemeName(), available: terminal.themeNames() };
    },
    async select(prompt, options, signal) {
      return await terminal.choose(prompt, options.map((option) => ({ ...option })), combined(generation, signal));
    },
    async confirm(title, message, signal) {
      const selected = combined(generation, signal);
      try {
        return await terminal.choose(`${title}: ${message}`, [
          { label: "Yes", value: true },
          { label: "No", value: false },
        ], selected);
      } catch (cause) {
        if (cancelled(cause, selected)) return false;
        throw cause;
      }
    },
    async input(title, placeholder, signal) {
      const selected = combined(generation, signal);
      try { return await terminal.requestInput(title, placeholder, selected); }
      catch (cause) { if (cancelled(cause, selected)) return undefined; throw cause; }
    },
    async editor(title, prefill, signal) {
      const selected = combined(generation, signal);
      try { return await terminal.editor(title, prefill, selected); }
      catch (cause) { if (cancelled(cause, selected)) return undefined; throw cause; }
    },
    setEditorText(value) { generation.throwIfAborted(); terminal.setEditorText(value); },
    getEditorText() { generation.throwIfAborted(); return terminal.getEditorText(); },
    async custom(factory, options, signal) {
      return await terminal.custom(factory, options, combined(generation, signal));
    },
    showOverlay(factory, options, signal) {
      return terminal.showOverlay(factory, options, combined(generation, signal));
    },
  };
}

function applyInitialUi(terminal: TuiController, operation: RuntimeInitialUiOperation): void {
  const ui = commandUi(terminal, operation.extensionId, new AbortController().signal);
  if (operation.type === "notify") ui.notify(operation.value, operation.kind);
  else if (operation.type === "title") ui.setTitle(operation.value);
  else if (operation.type === "status") ui.setStatus(operation.key ?? "default", operation.value || undefined);
  else if (operation.type === "widget") ui.setWidget(operation.key ?? "default", operation.value || undefined);
  else if (operation.type === "header") ui.setHeader(operation.key ?? "default", operation.value || undefined);
  else if (operation.type === "footer") ui.setFooter(operation.key ?? "default", operation.value || undefined);
  else if (operation.type === "working_message") ui.setWorkingMessage(operation.value || undefined);
  else ui.setWorkingVisible(operation.visible);
}

function applyAdvancedUi(terminal: TuiController, operation: RuntimeAdvancedUiOperation): void {
  if (operation.type === "component") {
    terminal.setPersistentComponent(
      operation.slot,
      `${operation.extensionId}:${operation.key}`,
      operation.factory,
      operation.signal,
    );
  } else if (operation.type === "working_indicator") {
    terminal.setKeyedWorkingIndicator(`${operation.extensionId}:global`, operation.value, operation.signal);
  } else if (operation.type === "hidden_reasoning_label") {
    terminal.setKeyedHiddenReasoningLabel(`${operation.extensionId}:global`, operation.value, operation.signal);
  } else if (operation.type === "tool_output_expanded") {
    terminal.setKeyedToolOutputExpanded(`${operation.extensionId}:global`, operation.expanded, operation.signal);
  } else {
    terminal.setNormalizedKeyObserver(
      `${operation.extensionId}:${operation.key}`,
      operation.observer,
      operation.signal,
    );
  }
}

/** Binds one extension generation to the embedded interactive terminal. */
export interface InteractiveRuntimeUiBinding {
  readonly uiContext: ReturnType<typeof createInteractiveDirectUiContext>;
  restoreDirectContext(): void;
  dispose(): void;
}

export function bindInteractiveRuntimeUi(
  terminal: TuiController,
  runner: ExtensionRunner,
  cwd: string,
  commandItems: () => readonly PickerItem<string>[],
  directUiServices: InteractiveDirectUiServices = {},
): InteractiveRuntimeUiBinding {
  const host = runner.getRuntimeHost();
  const signal = host.lifecycleSignal();
  signal.throwIfAborted();
  terminal.clearExtensionUi();

  const bindToolRenderers = (): void => terminal.setToolRenderers(host.toolRendererBinding(), signal);
  const bindSessionRenderers = (): void => terminal.setSessionRenderers({
    renderEntry: (entry, options, theme) => host.entryRenderer(entry.customType)?.(entry, options, theme),
    renderMessage: (message, options, theme) => host.messageRenderer(message.customType)?.(message, options, theme),
  }, signal);
  const bindInputs = (): void => {
    const resolved = resolveRuntimeShortcuts(host.shortcuts(), terminal);
    for (const diagnostic of resolved.diagnostics) terminal.notify(diagnostic, "warning");
    terminal.setExtensionShortcuts(resolved.shortcuts.map((shortcut) => ({
      shortcut: shortcut.shortcut,
      ...(shortcut.description === undefined ? {} : { description: shortcut.description }),
    })), signal);
    terminal.setCommandCompletionProvider(
      async (name, prefix, completionSignal) => await host.completeCommandArguments(name, prefix, completionSignal),
      signal,
    );
    terminal.setCommandItems(commandItems());
  };

  bindToolRenderers();
  bindSessionRenderers();
  bindInputs();
  for (const operation of host.initialUi()) applyInitialUi(terminal, operation);
  host.setUiHandler((operation) => applyInitialUi(terminal, operation));
  host.setAdvancedUiHandler({
    apply: (operation) => applyAdvancedUi(terminal, operation),
    getToolOutputExpanded: () => terminal.getToolOutputExpanded(),
  });
  host.setNativeUiHandler((extensionId, extensionSignal) => createNativeUiHost(terminal, extensionId, extensionSignal));
  host.setUnsafeTerminalHandler((extensionId, extensionSignal) => createUnsafeTerminalHost(terminal, extensionId, extensionSignal));
  host.setInteractiveUiHandler((extensionId, extensionSignal) => commandUi(terminal, extensionId, extensionSignal));
  const unsubscribeThemeChange = terminal.onThemeChange((change) => {
    void host.dispatch("theme_change", {
      previous: change.previous,
      current: change.current,
      available: [...change.available],
      reason: change.reason,
    }).catch(() => undefined);
  }, signal);
  const direct = new Map<string, {
    signal: AbortSignal;
    context: ReturnType<typeof createInteractiveDirectUiContext>;
  }>();
  const restoreDirectContext = (): void => host.setDirectUiHandler((extensionId, extensionSignal) => {
    const present = direct.get(extensionId);
    if (present?.signal === extensionSignal) return present.context;
    const created = createInteractiveDirectUiContext(terminal, extensionId, cwd, extensionSignal, directUiServices);
    direct.set(extensionId, { signal: extensionSignal, context: created });
    const release = (): void => {
      if (direct.get(extensionId)?.context === created) direct.delete(extensionId);
    };
    extensionSignal.addEventListener("abort", release, { once: true });
    if (extensionSignal.aborted) release();
    return created;
  });
  restoreDirectContext();
  const unsubscribe = host.onChange((change) => {
    if (change === "tool_renderer") bindToolRenderers();
    else if (change === "session_renderer") bindSessionRenderers();
    else if (["command", "shortcut"].includes(change)) bindInputs();
  });
  const dispose = (): void => {
    unsubscribe();
    unsubscribeThemeChange();
    direct.clear();
  };
  signal.addEventListener("abort", dispose, { once: true });
  return {
    uiContext: createInteractiveDirectUiContext(terminal, "runtime", cwd, signal, directUiServices),
    restoreDirectContext,
    dispose() {
      signal.removeEventListener("abort", dispose);
      dispose();
    },
  };
}
