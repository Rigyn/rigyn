import type { ExtensionRunner } from "../extensions/compat-runtime.js";
import { resolveRuntimeShortcuts } from "../cli/extension-shortcuts.js";
import type {
  RuntimeAdvancedUiOperation,
  RuntimeCommandUi,
  RuntimeInitialUiOperation,
} from "../extensions/runtime.js";
import { boundedRuntimeNotification } from "../extensions/runtime.js";
import type { RuntimeToolRendererBinding } from "../tui/components.js";
import {
  createInteractiveDirectUiFacade,
  createInteractiveDirectUiContext,
  createOwnedInteractiveDirectUiContext,
  type InteractiveDirectUiServices,
} from "../tui/direct-ui.js";
import { createNativeUiHost, createUnsafeTerminalHost } from "../tui/native-ui.js";
import { TuiController, TuiSelectionCancelledError } from "../tui/controller.js";
import type { PickerItem } from "../tui/types.js";

function combined(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
  return secondary === undefined ? primary : AbortSignal.any([primary, secondary]);
}

const activeBindings = new WeakMap<object, symbol>();

/** @internal Create the generation-bound interactive extension command UI. */
export function interactiveRuntimeCommandUi(
  terminal: TuiController,
  extensionId: string,
  generation: AbortSignal,
  ownerKey = extensionId,
): RuntimeCommandUi {
  const key = (value: string): string => `${ownerKey}:${value}`;
  const cancelled = (cause: unknown, signal: AbortSignal): boolean =>
    cause instanceof TuiSelectionCancelledError || signal.aborted;
  return {
    notify(message, kind = "status") {
      generation.throwIfAborted();
      terminal.notify(boundedRuntimeNotification(message), kind);
    },
    setStatus(name, value) { terminal.setExtensionStatus(key(name), value, generation); },
    setWidget(name, value) { terminal.setExtensionWidget(key(name), value, generation); },
    setHeader(name, value) { terminal.setExtensionHeader(key(name), value, generation); },
    setFooter(name, value) { terminal.setExtensionFooter(key(name), value, generation); },
    setWorkingMessage(value) { terminal.setExtensionWorkingMessage(ownerKey, value, generation); },
    setWorkingVisible(value) { terminal.setExtensionWorkingVisible(ownerKey, value, generation); },
    setTitle(value) { terminal.setKeyedTitle(key("title"), value, generation); },
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

function applyInitialUi(
  terminal: TuiController,
  operation: RuntimeInitialUiOperation,
  bindingSignal: AbortSignal,
): void {
  const signal = AbortSignal.any([operation.signal, bindingSignal]);
  const ui = interactiveRuntimeCommandUi(terminal, operation.extensionId, signal, operation.ownerKey);
  if (operation.type === "notify") ui.notify(operation.value, operation.kind);
  else if (operation.type === "title") ui.setTitle(operation.value);
  else if (operation.type === "status") ui.setStatus(operation.key ?? "default", operation.value || undefined);
  else if (operation.type === "widget") ui.setWidget(operation.key ?? "default", operation.value || undefined);
  else if (operation.type === "header") ui.setHeader(operation.key ?? "default", operation.value || undefined);
  else if (operation.type === "footer") ui.setFooter(operation.key ?? "default", operation.value || undefined);
  else if (operation.type === "working_message") ui.setWorkingMessage(operation.value || undefined);
  else ui.setWorkingVisible(operation.visible);
}

function applyAdvancedUi(
  terminal: TuiController,
  operation: RuntimeAdvancedUiOperation,
  bindingSignal: AbortSignal,
): void {
  const signal = AbortSignal.any([operation.signal, bindingSignal]);
  if (operation.type === "component") {
    terminal.setPersistentComponent(
      operation.slot,
      `${operation.ownerKey}:${operation.key}`,
      operation.factory,
      signal,
    );
  } else if (operation.type === "working_indicator") {
    terminal.setKeyedWorkingIndicator(`${operation.ownerKey}:global`, operation.value, signal);
  } else if (operation.type === "hidden_reasoning_label") {
    terminal.setKeyedHiddenReasoningLabel(`${operation.ownerKey}:global`, operation.value, signal);
  } else if (operation.type === "tool_output_expanded") {
    terminal.setKeyedToolOutputExpanded(`${operation.ownerKey}:global`, operation.expanded, signal);
  } else {
    terminal.setNormalizedKeyObserver(
      `${operation.ownerKey}:${operation.key}`,
      operation.observer,
      signal,
    );
  }
}

/** Binds one extension generation to the embedded interactive terminal. */
export interface InteractiveRuntimeUiBinding {
  readonly uiContext: ReturnType<typeof createInteractiveDirectUiContext>;
  restoreDirectContext(): void;
  /** True when this binding still owned and released the host UI surfaces. */
  dispose(): boolean;
}

export function bindInteractiveRuntimeUi(
  terminal: TuiController,
  runner: ExtensionRunner,
  cwd: string,
  commandItems: () => readonly PickerItem<string>[],
  directUiServices: InteractiveDirectUiServices = {},
  toolRendererBinding?: RuntimeToolRendererBinding,
): InteractiveRuntimeUiBinding {
  const host = runner.getRuntimeHost();
  const signal = host.lifecycleSignal();
  signal.throwIfAborted();
  const bindingAbort = new AbortController();
  const bindingSignal = AbortSignal.any([signal, bindingAbort.signal]);
  const bindingToken = Symbol("interactive-runtime-ui");
  activeBindings.set(host, bindingToken);
  terminal.clearExtensionUi();

  const selectedToolRendererBinding = toolRendererBinding ?? host.toolRendererBinding();
  const bindToolRenderers = (): void =>
    terminal.setToolRenderers(selectedToolRendererBinding, bindingSignal);
  const bindSessionRenderers = (): void => terminal.setSessionRenderers({
    renderEntry: (entry, options, theme) => host.entryRenderer(entry.customType)?.(entry, options, theme),
    renderMessage: (message, options, theme) => host.messageRenderer(message.customType)?.(message, options, theme),
    transformMarkdown: (markdown, context) => host.transformMarkdown(markdown, context),
  }, bindingSignal);
  const bindInputs = (): void => {
    const resolved = resolveRuntimeShortcuts(host.shortcuts(), terminal);
    for (const diagnostic of resolved.diagnostics) terminal.notify(diagnostic, "warning");
    terminal.setExtensionShortcuts(resolved.shortcuts.map((shortcut) => ({
      shortcut: shortcut.shortcut,
      ...(shortcut.description === undefined ? {} : { description: shortcut.description }),
    })), bindingSignal);
    terminal.setCommandCompletionProvider(
      async (name, prefix, completionSignal) => await host.completeCommandArguments(name, prefix, completionSignal),
      bindingSignal,
    );
    terminal.setCommandItems(commandItems());
  };

  bindToolRenderers();
  bindSessionRenderers();
  bindInputs();
  for (const operation of host.initialUi()) applyInitialUi(terminal, operation, bindingSignal);
  host.setUiHandler((operation) => applyInitialUi(terminal, operation, bindingSignal));
  host.setAdvancedUiHandler({
    apply: (operation) => applyAdvancedUi(terminal, operation, bindingSignal),
    getToolOutputExpanded: () => terminal.getToolOutputExpanded(),
  });
  host.setNativeUiHandler((extensionId, extensionSignal) => createNativeUiHost(
    terminal,
    extensionId,
    AbortSignal.any([extensionSignal, bindingSignal]),
  ));
  host.setUnsafeTerminalHandler((extensionId, extensionSignal) => createUnsafeTerminalHost(
    terminal,
    extensionId,
    AbortSignal.any([extensionSignal, bindingSignal]),
  ));
  host.setInteractiveUiHandler((extensionId, extensionSignal, ownerKey) => interactiveRuntimeCommandUi(
    terminal,
    extensionId,
    AbortSignal.any([extensionSignal, bindingAbort.signal]),
    ownerKey,
  ));
  const unsubscribeThemeChange = terminal.onThemeChange((change) => {
    void host.dispatch("theme_change", {
      previous: change.previous,
      current: change.current,
      available: [...change.available],
      reason: change.reason,
    }).catch(() => undefined);
  }, bindingSignal);
  const direct = new Map<string, {
    generationSignal: AbortSignal;
    ownerSignal: AbortSignal;
    callbackSignals: WeakMap<AbortSignal, AbortSignal>;
    context: ReturnType<typeof createInteractiveDirectUiContext>;
  }>();
  const restoreDirectContext = (): void => host.setDirectUiHandler((
    _extensionId,
    extensionSignal,
    ownerKey,
    generationSignal = extensionSignal,
  ) => {
    const present = direct.get(ownerKey);
    if (present?.generationSignal === generationSignal) {
      let presentationSignal = present.callbackSignals.get(extensionSignal);
      if (presentationSignal === undefined) {
        presentationSignal = AbortSignal.any([extensionSignal, present.ownerSignal]);
        present.callbackSignals.set(extensionSignal, presentationSignal);
      }
      return createInteractiveDirectUiFacade(present.context, presentationSignal);
    }
    const contextSignal = AbortSignal.any([generationSignal, bindingSignal]);
    const created = createOwnedInteractiveDirectUiContext(
      terminal,
      ownerKey,
      cwd,
      contextSignal,
      directUiServices,
    );
    const callbackSignals = new WeakMap<AbortSignal, AbortSignal>();
    const presentationSignal = extensionSignal === generationSignal
      ? contextSignal
      : AbortSignal.any([extensionSignal, contextSignal]);
    callbackSignals.set(extensionSignal, presentationSignal);
    direct.set(ownerKey, {
      generationSignal,
      ownerSignal: contextSignal,
      callbackSignals,
      context: created,
    });
    const release = (): void => {
      if (direct.get(ownerKey)?.context === created) direct.delete(ownerKey);
    };
    contextSignal.addEventListener("abort", release, { once: true });
    if (contextSignal.aborted) release();
    return createInteractiveDirectUiFacade(created, presentationSignal);
  });
  restoreDirectContext();
  const unsubscribe = host.onChange((change) => {
    if (change === "tool_renderer") bindToolRenderers();
    else if (change === "session_renderer") bindSessionRenderers();
    else if (["command", "shortcut"].includes(change)) bindInputs();
  });
  const dispose = (): boolean => {
    if (!bindingAbort.signal.aborted) bindingAbort.abort(new Error("Interactive UI binding disposed"));
    unsubscribe();
    unsubscribeThemeChange();
    direct.clear();
    if (activeBindings.get(host) !== bindingToken) return false;
    activeBindings.delete(host);
    terminal.clearExtensionUi();
    if (!signal.aborted) {
      host.setUiHandler(undefined);
      host.setAdvancedUiHandler(undefined);
      host.setNativeUiHandler(undefined);
      host.setUnsafeTerminalHandler(undefined);
      host.setInteractiveUiHandler(undefined);
      host.setDirectUiHandler(undefined);
    }
    return true;
  };
  signal.addEventListener("abort", dispose, { once: true });
  return {
    uiContext: createInteractiveDirectUiContext(terminal, "runtime", cwd, bindingSignal, directUiServices),
    restoreDirectContext,
    dispose() {
      signal.removeEventListener("abort", dispose);
      return dispose();
    },
  };
}
