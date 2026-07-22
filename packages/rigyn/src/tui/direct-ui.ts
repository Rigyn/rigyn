import { spawnSync } from "node:child_process";

import {
  type AutocompleteProvider,
  type Component,
  type EditorTheme,
  type KeybindingsManager,
  type OverlayHandle,
  type OverlayOptions,
  type Terminal,
  TUI,
  matchesKey,
} from "@rigyn/terminal";

import type {
  RuntimeDirectEditorFactory,
  RuntimeDirectPersistentComponentFactory,
  RuntimeDirectUiContext,
  RuntimeDirectUiDialogOptions,
} from "../extensions/runtime.js";
import type { Theme } from "./theme.js";
import type { TuiAutocompleteCompletion, TuiAutocompleteProvider, TuiPersistentComponentSlot } from "./types.js";
import type { ReadonlyFooterDataProvider } from "./footer-data.js";
import type { TuiController } from "./controller.js";
import { splitGraphemes } from "./unicode.js";
import type { RuntimeUiComponentHandle, RuntimeUiCustomOptions } from "./components.js";

interface DirectEditorFactoryOwner {
  token: object;
  factory: RuntimeDirectEditorFactory;
}

export interface InteractiveDirectUiServices {
  readonly settings?: {
    setTheme(value: string): void;
    setShowHardwareCursor?(value: boolean): void;
    setClearOnShrink?(value: boolean): void;
  };
  readonly themePath?: (name: string) => string | undefined;
}

const directEditorFactories = new WeakMap<TuiController, DirectEditorFactoryOwner[]>();

function removeDirectEditorFactory(controller: TuiController, token: object): void {
  const owners = directEditorFactories.get(controller);
  if (owners === undefined) return;
  const index = owners.findIndex((owner) => owner.token === token);
  if (index >= 0) owners.splice(index, 1);
  if (owners.length === 0) directEditorFactories.delete(controller);
}

function interactionSignal(base: AbortSignal, options?: RuntimeDirectUiDialogOptions): AbortSignal {
  const signals = [base, ...(options?.signal === undefined ? [] : [options.signal])];
  if (options?.timeout !== undefined) {
    if (!Number.isSafeInteger(options.timeout) || options.timeout < 1 || options.timeout > 3_600_000) {
      throw new RangeError("Extension UI timeout must be from 1 through 3600000 milliseconds");
    }
    signals.push(AbortSignal.timeout(options.timeout));
  }
  return signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
}

function editorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: (text) => theme.fg("borderMuted", text),
    selectList: {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("muted", text),
      noMatch: (text) => theme.fg("muted", text),
    },
  };
}

function linesComponent(lines: readonly string[]): Component {
  const selected = [...lines];
  return { render: () => [...selected], invalidate() {} };
}

function branch(cwd: string): string | null {
  try {
    const result = spawnSync("git", ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    });
    const selected = result.status === 0 ? result.stdout.trim() : "";
    return selected || null;
  } catch { return null; }
}

function footerData(controller: TuiController, cwd: string, signal: AbortSignal): ReadonlyFooterDataProvider {
  const callbacks = new Set<() => void>();
  let selected = branch(cwd);
  let timer: NodeJS.Timeout | undefined;
  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    callbacks.clear();
  };
  signal.addEventListener("abort", stop, { once: true });
  return Object.freeze({
    getGitBranch: () => selected,
    getExtensionStatuses: () => controller.extensionStatusSnapshot(),
    getAvailableProviderCount: () => controller.availableProviderCount(),
    onBranchChange(callback: () => void): () => void {
      signal.throwIfAborted();
      if (typeof callback !== "function") throw new TypeError("Branch listener must be a function");
      callbacks.add(callback);
      timer ??= setInterval(() => {
        const next = branch(cwd);
        if (next === selected) return;
        selected = next;
        for (const listener of callbacks) {
          try { listener(); } catch {}
        }
      }, 500);
      timer.unref();
      return () => {
        callbacks.delete(callback);
        if (callbacks.size === 0 && timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
  });
}

function rawTerminal(controller: TuiController, signal: AbortSignal): Terminal {
  let close: (() => void) | undefined;
  let progressTimer: NodeJS.Timeout | undefined;
  const write = (value: string): void => {
    signal.throwIfAborted();
    controller.writeUnsafeTerminal(value);
  };
  const terminal: Terminal = {
    start(onInput, onResize) {
      signal.throwIfAborted();
      if (close !== undefined) return;
      const input = controller.registerUnsafeTerminalInputHandler((data) => { onInput(data); return { consume: true }; }, signal);
      const resize = () => onResize();
      controller.output.on("resize", resize);
      close = () => {
        input();
        controller.output.off("resize", resize);
        close = undefined;
      };
    },
    stop() {
      close?.();
      if (progressTimer !== undefined) {
        clearInterval(progressTimer);
        progressTimer = undefined;
        try { write("\u001b]9;4;0;\u0007"); } catch {}
      }
    },
    async drainInput(maxMs, idleMs) {
      signal.throwIfAborted();
      await controller.drainInput(maxMs, idleMs);
      signal.throwIfAborted();
    },
    write,
    get columns() { return controller.unsafeTerminalSize().columns; },
    get rows() { return controller.unsafeTerminalSize().rows; },
    get kittyProtocolActive() { return controller.unsafeTerminalKittyProtocolActive(); },
    moveBy(lines) { if (Number.isFinite(lines) && lines !== 0) write(`\u001b[${Math.abs(Math.trunc(lines))}${lines < 0 ? "A" : "B"}`); },
    hideCursor() { write("\u001b[?25l"); },
    showCursor() { write("\u001b[?25h"); },
    clearLine() { write("\u001b[K"); },
    clearFromCursor() { write("\u001b[0J"); },
    clearScreen() { write("\u001b[2J\u001b[H"); },
    setTitle(title) { controller.setTitle(title); },
    setProgress(active) {
      if (active) {
        write("\u001b]9;4;3\u0007");
        progressTimer ??= setInterval(() => {
          try { write("\u001b]9;4;3\u0007"); }
          catch {
            if (progressTimer !== undefined) clearInterval(progressTimer);
            progressTimer = undefined;
          }
        }, 1_000);
        progressTimer.unref();
      } else {
        if (progressTimer !== undefined) clearInterval(progressTimer);
        progressTimer = undefined;
        write("\u001b]9;4;0;\u0007");
      }
    },
  };
  signal.addEventListener("abort", () => {
    terminal.stop();
    try { controller.requestUnsafeTerminalRender(); } catch {}
  }, { once: true });
  return terminal;
}

function rawTui(
  controller: TuiController,
  extensionId: string,
  signal: AbortSignal,
  services: InteractiveDirectUiServices,
): TUI {
  const terminal = rawTerminal(controller, signal);
  const tui = new TUI(terminal);
  const children = tui.children;
  const childKeys = new WeakMap<Component, string>();
  const mountedChildren = new Set<Component>();
  const listeners = new Set<(data: string) => { consume?: boolean; data?: string } | undefined>();
  const overlays: Array<{ handle: OverlayHandle; close(): void; paused: boolean }> = [];
  const notificationOwner = {};
  let started = true;
  let ordinal = 0;
  const mount = (component: Component): void => {
    const key = childKeys.get(component);
    if (key === undefined) return;
    if (mountedChildren.has(component)) controller.setRawPersistentComponentVisible("widget", key, true);
    else {
      controller.setRawPersistentComponent("widget", key, component, signal);
      mountedChildren.add(component);
    }
  };
  const unmount = (component: Component): void => {
    const key = childKeys.get(component);
    if (key !== undefined) controller.setRawPersistentComponent("widget", key);
    mountedChildren.delete(component);
  };
  const pause = (component: Component): void => {
    const key = childKeys.get(component);
    if (key !== undefined && mountedChildren.has(component)) {
      controller.setRawPersistentComponentVisible("widget", key, false);
    }
  };
  controller.registerUnsafeTerminalInputHandler((initial) => {
    if (!started) return undefined;
    let data = initial;
    for (const listener of listeners) {
      const result = listener(data);
      if (result?.consume === true) return { consume: true };
      if (result?.data !== undefined) {
        if (typeof result.data !== "string") throw new TypeError("Trusted TUI input rewrites must be strings");
        data = result.data;
      }
    }
    if (matchesKey(data, "shift+ctrl+d") && tui.onDebug !== undefined) {
      tui.onDebug();
      return { consume: true };
    }
    return data === initial ? undefined : { data };
  }, signal);
  Object.assign(tui, {
    addChild(component: Component) {
      signal.throwIfAborted();
      if (children.includes(component)) return;
      children.push(component);
      const key = `${extensionId}:root:${++ordinal}`;
      childKeys.set(component, key);
      if (started) mount(component);
    },
    removeChild(component: Component) {
      const index = children.indexOf(component);
      if (index >= 0) children.splice(index, 1);
      unmount(component);
    },
    clear() { for (const component of [...children]) tui.removeChild(component); },
    invalidate() {
      for (const component of children) component.invalidate();
      if (started) controller.requestRawRender();
    },
    render(width: number) { return children.flatMap((component) => component.render(width)); },
    setFocus(component: Component | null) { controller.focusRawComponent(component); },
    showOverlay(component: Component, options: OverlayOptions = {}) {
      signal.throwIfAborted();
      if (!started) throw new Error("Trusted TUI is stopped");
      const mounted = controller.showRawOverlay(component, options, signal);
      overlays.push({ handle: mounted.handle, close: () => mounted.close(), paused: false });
      return mounted.handle;
    },
    hideOverlay() { overlays.pop()?.close(); },
    hasOverlay() { return overlays.some((entry) => !entry.handle.isHidden()); },
    start() {
      signal.throwIfAborted();
      if (started) return;
      started = true;
      for (const component of children) mount(component);
      for (const overlay of overlays) {
        if (!overlay.paused) continue;
        overlay.paused = false;
        overlay.handle.setHidden(false);
      }
      controller.requestRawRender();
    },
    stop() {
      if (!started) return;
      started = false;
      for (const component of children) pause(component);
      for (const overlay of overlays) {
        if (overlay.handle.isHidden()) continue;
        overlay.paused = true;
        overlay.handle.setHidden(true);
      }
      controller.requestRawRender();
    },
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      signal.throwIfAborted();
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    removeInputListener(listener: (data: string) => unknown) {
      listeners.delete(listener as (data: string) => { consume?: boolean; data?: string } | undefined);
    },
    onTerminalColorSchemeChange(listener: (scheme: "dark" | "light") => void) {
      return controller.onUnsafeTerminalColorSchemeChange(listener, signal);
    },
    setTerminalColorSchemeNotifications(enabled: boolean) {
      controller.setUnsafeTerminalColorSchemeNotifications(notificationOwner, enabled, signal);
    },
    requestRender(force = false) { if (started) controller.requestRawRender(force); },
    async queryTerminalBackgroundColor({ timeoutMs }: { timeoutMs: number }) {
      return await controller.queryUnsafeTerminalBackgroundColor(timeoutMs, signal);
    },
    async queryTerminalColorScheme({ timeoutMs }: { timeoutMs: number }) {
      return await controller.queryUnsafeTerminalColorScheme(timeoutMs, signal);
    },
    getShowHardwareCursor() { return controller.rawShowHardwareCursor(); },
    setShowHardwareCursor(value: boolean) {
      controller.setRawShowHardwareCursor(value);
      services.settings?.setShowHardwareCursor?.(value);
    },
    getClearOnShrink() { return controller.rawClearOnShrink(); },
    setClearOnShrink(value: boolean) {
      controller.setRawClearOnShrink(value);
      services.settings?.setClearOnShrink?.(value);
    },
  });
  Object.defineProperty(tui, "fullRedraws", {
    configurable: true,
    enumerable: true,
    get: () => controller.rawFullRedraws(),
  });
  signal.addEventListener("abort", () => {
    listeners.clear();
    for (const overlay of overlays.splice(0)) overlay.close();
    tui.clear();
  }, { once: true });
  return tui;
}

function rawProvider(current: TuiAutocompleteProvider): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const before = lines.slice(0, cursorLine).join("\n");
      const offset = splitGraphemes(before).length + (cursorLine === 0 ? 0 : 1) + cursorCol;
      const text = lines.join("\n");
      const values = await current(text, offset, options.signal);
      if (values === null || values.length === 0) return null;
      return {
        prefix: "",
        items: values.map((value) => ({ value: value.value, label: value.label ?? value.value, ...(value.detail === undefined ? {} : { description: value.detail }) })),
      };
    },
    applyCompletion(lines, cursorLine, cursorCol, item) {
      const selected = [...lines];
      const line = selected[cursorLine] ?? "";
      selected[cursorLine] = `${line.slice(0, cursorCol)}${item.value}${line.slice(cursorCol)}`;
      return { lines: selected, cursorLine, cursorCol: cursorCol + item.value.length };
    },
  };
}

function autocompleteWrapper(factory: (current: AutocompleteProvider) => AutocompleteProvider):
  (current: TuiAutocompleteProvider) => TuiAutocompleteProvider {
  return (current) => {
    const provider = factory(rawProvider(current));
    if (provider === null || typeof provider !== "object" || typeof provider.getSuggestions !== "function"
      || typeof provider.applyCompletion !== "function") throw new TypeError("Autocomplete factory must return a provider");
    return async (text, cursor, signal): Promise<readonly TuiAutocompleteCompletion[] | null> => {
      const graphemes = splitGraphemes(text);
      const before = graphemes.slice(0, cursor).join("");
      const cursorLines = before.split("\n");
      const lines = text.split("\n");
      const cursorLine = cursorLines.length - 1;
      const cursorCol = cursorLines.at(-1)?.length ?? 0;
      const suggestions = await provider.getSuggestions(lines, cursorLine, cursorCol, { signal });
      if (suggestions === null) return null;
      return suggestions.items.map((item) => {
        const applied = provider.applyCompletion(lines, cursorLine, cursorCol, item, suggestions.prefix);
        const value = applied.lines.join("\n");
        let start = 0;
        while (start < graphemes.length && start < splitGraphemes(value).length && graphemes[start] === splitGraphemes(value)[start]) start += 1;
        let oldEnd = graphemes.length;
        let newEnd = splitGraphemes(value).length;
        const next = splitGraphemes(value);
        while (oldEnd > start && newEnd > start && graphemes[oldEnd - 1] === next[newEnd - 1]) { oldEnd -= 1; newEnd -= 1; }
        return {
          start,
          end: oldEnd,
          value: next.slice(start, newEnd).join(""),
          label: item.label,
          ...(item.description === undefined ? {} : { detail: item.description }),
        };
      });
    };
  };
}

export function createInteractiveDirectUiContext(
  controller: TuiController,
  extensionId: string,
  cwd: string,
  signal: AbortSignal,
  services: InteractiveDirectUiServices = {},
): RuntimeDirectUiContext {
  signal.throwIfAborted();
  const tui = rawTui(controller, extensionId, signal, services);
  const keybindings = controller.keybindingsManager();
  const data = footerData(controller, cwd, signal);
  const editorOwner = {};
  let editorDisposer: (() => void) | undefined;
  let themeDisposer: (() => void) | undefined;
  signal.addEventListener("abort", () => removeDirectEditorFactory(controller, editorOwner), { once: true });
  const key = (value: string) => `${extensionId}:${value}`;
  const component = (
    slot: TuiPersistentComponentSlot,
    name: string,
    factory: RuntimeDirectPersistentComponentFactory | undefined,
  ): void => {
    const selectedKey = key(name);
    if (factory === undefined) controller.setRawPersistentComponent(slot, selectedKey);
    else controller.setRawPersistentComponent(slot, selectedKey, factory(tui, controller.currentThemeObject()), signal);
  };
  const overlayHandle = (handle: RuntimeUiComponentHandle): OverlayHandle => Object.freeze({
    hide: handle.hide,
    setHidden: handle.setHidden,
    isHidden: handle.isHidden,
    focus: handle.focus,
    unfocus: (options?: Parameters<OverlayHandle["unfocus"]>[0]) => {
      if (options === undefined) handle.unfocus();
      else {
        handle.unfocus({ target: null });
        controller.focusRawComponent(options.target);
      }
    },
    isFocused: handle.isFocused,
  });
  const custom = async <T>(
    factory: (
      selectedTui: TUI,
      theme: Theme,
      selectedKeybindings: KeybindingsManager,
      done: (result: T) => void,
    ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
    options?: {
      overlay?: boolean;
      overlayOptions?: OverlayOptions | (() => OverlayOptions);
      onHandle?: (handle: OverlayHandle) => void;
    },
  ): Promise<T> => {
    const selectedOptions: RuntimeUiCustomOptions | undefined = options === undefined ? undefined : {
      ...(options.overlay === undefined ? {} : { overlay: options.overlay }),
      ...(options.overlayOptions === undefined ? {} : { overlayOptions: options.overlayOptions }),
      ...(options.onHandle === undefined ? {} : { onHandle: (handle: RuntimeUiComponentHandle) => options.onHandle?.(overlayHandle(handle)) }),
    };
    return await controller.customRaw<T>(
      (done) => factory(tui, controller.currentThemeObject(), keybindings, done),
      selectedOptions,
      signal,
    ) as T;
  };
  return Object.freeze<RuntimeDirectUiContext>({
    async select(title, options, opts) {
      const selectedSignal = interactionSignal(signal, opts);
      try { return await controller.choose(title, options.map((value) => ({ label: value, value })), selectedSignal); }
      catch (cause) { if (selectedSignal.aborted) return undefined; throw cause; }
    },
    async confirm(title, message, opts) {
      const selectedSignal = interactionSignal(signal, opts);
      try {
        return await controller.choose(`${title}: ${message}`, [{ label: "Yes", value: true }, { label: "No", value: false }], selectedSignal);
      } catch (cause) { if (selectedSignal.aborted) return false; throw cause; }
    },
    async input(title, placeholder, opts) {
      const selectedSignal = interactionSignal(signal, opts);
      try { return await controller.requestInput(title, placeholder, selectedSignal); }
      catch (cause) { if (selectedSignal.aborted) return undefined; throw cause; }
    },
    notify(message, type = "info") { controller.notify(message, type === "info" ? "status" : type); },
    onTerminalInput(handler) { return controller.registerUnsafeTerminalInputHandler((value) => handler(value), signal); },
    setStatus(name, text) { controller.setExtensionStatus(key(name), text); },
    setWorkingMessage(message) { controller.setExtensionWorkingMessage(extensionId, message); },
    setWorkingVisible(visible) { controller.setExtensionWorkingVisible(extensionId, visible); },
    setWorkingIndicator(options) {
      controller.setKeyedWorkingIndicator(key("indicator"), options === undefined ? undefined : {
        frames: [...(options.frames ?? ["●"])],
        intervalMs: options.intervalMs ?? 80,
        ...(options.frames?.length === 0 ? { hidden: true } : {}),
      }, options === undefined ? undefined : signal);
    },
    setHiddenThinkingLabel(label) { controller.setKeyedHiddenReasoningLabel(key("reasoning"), label, label === undefined ? undefined : signal); },
    setWidget(name, content, options) {
      const slot = options?.placement === "belowEditor" ? "widget-below" : "widget-above";
      if (content === undefined) controller.setRawPersistentComponent(slot, key(name));
      else if (Array.isArray(content)) controller.setRawPersistentComponent(slot, key(name), linesComponent(content), signal);
      else controller.setRawPersistentComponent(slot, key(name), content(tui, controller.currentThemeObject()), signal);
    },
    setFooter(factory) {
      const selectedKey = key("footer");
      if (factory === undefined) controller.setRawPersistentComponent("footer-replacement", selectedKey);
      else controller.setRawPersistentComponent(
        "footer-replacement",
        selectedKey,
        factory(tui, controller.currentThemeObject(), data),
        signal,
      );
    },
    setHeader(factory) { component("header-replacement", "header", factory); },
    setTitle(title) { controller.setTitle(title); },
    custom,
    pasteToEditor(text) { controller.insertClipboardText(text); },
    setEditorText(text) { controller.setEditorText(text); },
    getEditorText() { return controller.getEditorText(); },
    async editor(title, prefill) {
      try { return await controller.editor(title, prefill, signal); }
      catch (cause) { if (signal.aborted) return undefined; throw cause; }
    },
    addAutocompleteProvider(factory) { controller.wrapNativeAutocompleteProvider(autocompleteWrapper(factory), signal); },
    setEditorComponent(factory) {
      editorDisposer?.();
      editorDisposer = undefined;
      removeDirectEditorFactory(controller, editorOwner);
      if (factory !== undefined) {
        const selected = factory(tui, editorTheme(controller.currentThemeObject()), keybindings);
        editorDisposer = controller.installRawEditor(selected, signal);
        const owners = directEditorFactories.get(controller) ?? [];
        owners.push({ token: editorOwner, factory });
        directEditorFactories.set(controller, owners);
      }
    },
    getEditorComponent() { return directEditorFactories.get(controller)?.at(-1)?.factory; },
    get theme() { return controller.currentThemeObject(); },
    getAllThemes() { return controller.themeNames().map((name) => ({ name, path: services.themePath?.(name) })); },
    getTheme(name) { return controller.themeCatalogObjects().find((theme) => theme.name === name); },
    setTheme(value) {
      try {
        const name = typeof value === "string" ? value : value.name;
        if (!controller.themeNames().includes(name)) throw new Error(`Unknown theme: ${name}`);
        themeDisposer?.();
        themeDisposer = undefined;
        if (typeof value === "string") controller.setTheme(value);
        else themeDisposer = controller.applyNativeTheme(value, signal);
        services.settings?.setTheme(name);
        return { success: true };
      } catch (cause) { return { success: false, error: cause instanceof Error ? cause.message : String(cause) }; }
    },
    getToolsExpanded() { return controller.getToolOutputExpanded(); },
    setToolsExpanded(expanded) { controller.setKeyedToolOutputExpanded(key("tools"), expanded, signal); },
  });
}
