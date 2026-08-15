import { execFile } from "node:child_process";
import { resolve } from "node:path";

import {
  type AutocompleteItem,
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
import { boundedTuiFailureText } from "./diagnostics.js";
import { byteTruncate, sanitizeTerminalText, splitGraphemes } from "./unicode.js";
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

type InteractiveDirectUiFacadeFactory = (signal: AbortSignal) => RuntimeDirectUiContext;
const interactiveDirectUiFacades = new WeakMap<RuntimeDirectUiContext, InteractiveDirectUiFacadeFactory>();
type InteractiveDirectTerminalFacadeFactory = (signal: AbortSignal) => Terminal;
const interactiveDirectTerminalFacades = new WeakMap<Terminal, InteractiveDirectTerminalFacadeFactory>();
const callbackTuiFacades = new WeakMap<TUI, WeakMap<AbortSignal, TUI>>();

/** @internal Creates a callback-scoped facade over one generation-owned rich UI context. */
export function createInteractiveDirectUiFacade(
  context: RuntimeDirectUiContext,
  signal: AbortSignal,
): RuntimeDirectUiContext {
  signal.throwIfAborted();
  const factory = interactiveDirectUiFacades.get(context);
  if (factory === undefined) throw new Error("Interactive direct UI context is not facade-capable");
  return factory(signal);
}

function callbackTerminal(terminal: Terminal, signal: AbortSignal): Terminal {
  signal.throwIfAborted();
  const factory = interactiveDirectTerminalFacades.get(terminal);
  if (factory === undefined) throw new Error("Interactive direct terminal is not facade-capable");
  return factory(signal);
}

function callbackTui(tui: TUI, signal: AbortSignal): TUI {
  const facades = callbackTuiFacades.get(tui) ?? new WeakMap<AbortSignal, TUI>();
  callbackTuiFacades.set(tui, facades);
  const existing = facades.get(signal);
  if (existing !== undefined) return existing;
  const cleanups = new Set<() => void>();
  const childOwners = new Map<Component, () => void>();
  const overlayOwners = new Set<() => void>();
  const inputOwners = new Map<Parameters<TUI["addInputListener"]>[0], () => void>();
  const own = (cleanup: () => void): (() => void) => {
    let active = true;
    const selected = (): void => {
      if (!active) return;
      active = false;
      cleanups.delete(selected);
      cleanup();
    };
    cleanups.add(selected);
    return selected;
  };
  signal.addEventListener("abort", () => {
    for (const cleanup of [...cleanups]) cleanup();
  }, { once: true });
  const methods = new Map<PropertyKey, unknown>();
  const facade = new Proxy(tui, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (property === "terminal") return callbackTerminal(value as Terminal, signal);
      if (typeof value !== "function") return value;
      const cached = methods.get(property);
      if (cached !== undefined) return cached;
      const selected = property === "showOverlay"
        ? (component: Component, options?: OverlayOptions) => {
            signal.throwIfAborted();
            const handle = target.showOverlay(component, options);
            let hide!: () => void;
            hide = own(() => {
              overlayOwners.delete(hide);
              handle.hide();
            });
            overlayOwners.add(hide);
            return Object.freeze({ ...handle, hide });
          }
        : property === "addChild"
          ? (component: Component) => {
              signal.throwIfAborted();
              childOwners.get(component)?.();
              target.addChild(component);
              let release!: () => void;
              release = own(() => {
                if (childOwners.get(component) === release) childOwners.delete(component);
                target.removeChild(component);
              });
              childOwners.set(component, release);
            }
          : property === "removeChild"
            ? (component: Component) => {
                signal.throwIfAborted();
                const release = childOwners.get(component);
                if (release === undefined) target.removeChild(component);
                else release();
              }
            : property === "clear"
              ? () => {
                  signal.throwIfAborted();
                  for (const release of [...childOwners.values()]) release();
                  target.clear();
                }
              : property === "hideOverlay"
                ? () => {
                    signal.throwIfAborted();
                    const hide = [...overlayOwners].at(-1);
                    if (hide === undefined) target.hideOverlay();
                    else hide();
                  }
                : property === "addInputListener"
                  ? (listener: Parameters<TUI["addInputListener"]>[0]) => {
                      signal.throwIfAborted();
                      inputOwners.get(listener)?.();
                      const dispose = target.addInputListener(listener);
                      let release!: () => void;
                      release = own(() => {
                        if (inputOwners.get(listener) === release) inputOwners.delete(listener);
                        dispose();
                      });
                      inputOwners.set(listener, release);
                      return release;
                    }
                  : property === "removeInputListener"
                    ? (listener: Parameters<TUI["addInputListener"]>[0]) => {
                        signal.throwIfAborted();
                        const release = inputOwners.get(listener);
                        if (release === undefined) target.removeInputListener(listener);
                        else release();
                      }
                    : property === "onTerminalColorSchemeChange"
                      ? (listener: Parameters<TUI["onTerminalColorSchemeChange"]>[0]) => {
                          signal.throwIfAborted();
                          const dispose = target.onTerminalColorSchemeChange(listener);
                          return own(dispose);
                        }
                      : (...args: unknown[]) => {
                          signal.throwIfAborted();
                          return Reflect.apply(value, target, args);
                        };
      methods.set(property, selected);
      return selected;
    },
  });
  facades.set(signal, facade);
  if (signal.aborted) {
    for (const cleanup of [...cleanups]) cleanup();
  }
  return facade;
}

const directEditorFactories = new WeakMap<TuiController, DirectEditorFactoryOwner[]>();
const BRANCH_POLL_MS = 2_000;

interface SharedBranchProbe {
  readonly cwd: string;
  readonly listeners: Set<() => void>;
  readonly abort: AbortController;
  contexts: number;
  initialized: boolean;
  value: string | null;
  lastProbe: number;
  inFlight: Promise<void> | undefined;
  timer: NodeJS.Timeout | undefined;
  disposed: boolean;
  refresh(): Promise<void>;
  subscribe(listener: () => void): () => void;
  release(): void;
}

const sharedBranchProbes = new WeakMap<TuiController, Map<string, SharedBranchProbe>>();

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
      selectedText: (text) => theme.fg("accent", text),
      selectedPrefix: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("muted", text),
      noMatch: (text) => theme.fg("muted", text),
    },
  };
}

function liveTheme(controller: TuiController): Theme {
  const current = () => controller.currentThemeObject();
  return Object.freeze(Object.defineProperties({
    fg: (color: Parameters<Theme["fg"]>[0], text: string) => current().fg(color, text),
    bg: (color: Parameters<Theme["bg"]>[0], text: string) => current().bg(color, text),
    bold: (text: string) => current().bold(text),
    italic: (text: string) => current().italic(text),
    underline: (text: string) => current().underline(text),
    inverse: (text: string) => current().inverse(text),
    strikethrough: (text: string) => current().strikethrough(text),
    getFgAnsi: (color: Parameters<Theme["getFgAnsi"]>[0]) => current().getFgAnsi(color),
    getBgAnsi: (color: Parameters<Theme["getBgAnsi"]>[0]) => current().getBgAnsi(color),
    getColorMode: () => current().getColorMode(),
    getThinkingBorderColor: (level: Parameters<Theme["getThinkingBorderColor"]>[0]) =>
      (text: string) => current().getThinkingBorderColor(level)(text),
    getBashModeBorderColor: () => (text: string) => current().getBashModeBorderColor()(text),
  }, {
    name: { enumerable: true, get: () => current().name },
    ansi: { enumerable: true, get: () => current().ansi },
    unicode: { enumerable: true, get: () => current().unicode },
    glyphs: { enumerable: true, get: () => current().glyphs },
    codes: { enumerable: true, get: () => current().codes },
  })) as Theme;
}

function linesComponent(lines: readonly string[]): Component {
  if (lines.length > 128) throw new RangeError("Direct UI text components cannot exceed 128 source lines");
  let bytes = 0;
  const selected = lines.map((line) => {
    if (typeof line !== "string") throw new TypeError("Direct UI text component lines must be strings");
    const value = byteTruncate(sanitizeTerminalText(line), 32 * 1024);
    bytes += Buffer.byteLength(value);
    if (bytes > 256 * 1024) throw new RangeError("Direct UI text components cannot exceed 256 KiB");
    return value;
  });
  return { render: () => [...selected], invalidate() {} };
}

async function branch(cwd: string, signal: AbortSignal): Promise<string | null> {
  if (signal.aborted) return null;
  return await new Promise((resolve) => {
    execFile(
      "git",
      ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
      { cwd, encoding: "utf8", maxBuffer: 16 * 1024, timeout: 1_000, windowsHide: true, signal },
      (cause, stdout) => {
        if (cause !== null) resolve(null);
        else {
          const selected = byteTruncate(
            sanitizeTerminalText(stdout).replaceAll(/[\r\n\t]+/gu, " ").trim(),
            1_024,
          );
          resolve(selected || null);
        }
      },
    );
  });
}

function acquireBranchProbe(controller: TuiController, cwd: string): SharedBranchProbe {
  let probes = sharedBranchProbes.get(controller);
  if (probes === undefined) {
    probes = new Map();
    sharedBranchProbes.set(controller, probes);
  }
  const key = resolve(cwd);
  let probe = probes.get(key);
  if (probe === undefined) {
    const listeners = new Set<() => void>();
    const abort = new AbortController();
    const schedule = (selected: SharedBranchProbe, delay = BRANCH_POLL_MS): void => {
      if (selected.disposed || selected.listeners.size === 0 || selected.timer !== undefined) return;
      selected.timer = setTimeout(() => {
        selected.timer = undefined;
        void selected.refresh();
      }, delay);
      selected.timer.unref();
    };
    probe = {
      cwd: key,
      listeners,
      abort,
      contexts: 0,
      initialized: false,
      value: null,
      lastProbe: 0,
      inFlight: undefined,
      timer: undefined,
      disposed: false,
      async refresh(): Promise<void> {
        if (this.disposed) return;
        if (this.inFlight !== undefined) return await this.inFlight;
        const remaining = BRANCH_POLL_MS - (Date.now() - this.lastProbe);
        if (this.lastProbe > 0 && remaining > 0) {
          schedule(this, remaining);
          return;
        }
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
        this.lastProbe = Date.now();
        const operation = (async () => {
          const next = await branch(this.cwd, this.abort.signal);
          if (this.disposed) return;
          const changed = this.initialized ? next !== this.value : next !== null;
          this.initialized = true;
          this.value = next;
          if (changed) {
            controller.requestRawRender();
            for (const listener of this.listeners) {
              try { listener(); } catch {}
            }
          }
        })().finally(() => {
          if (this.inFlight === operation) this.inFlight = undefined;
          schedule(this);
        });
        this.inFlight = operation;
        await operation;
      },
      subscribe(listener: () => void): () => void {
        if (this.disposed) return () => undefined;
        this.listeners.add(listener);
        void this.refresh();
        return () => {
          this.listeners.delete(listener);
          if (this.listeners.size === 0 && this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
          }
        };
      },
      release(): void {
        if (this.disposed || this.contexts > 1) {
          this.contexts = Math.max(0, this.contexts - 1);
          return;
        }
        this.contexts = 0;
        this.disposed = true;
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
        this.listeners.clear();
        this.abort.abort(new Error("Branch probe released"));
        if (probes!.get(key) === this) probes!.delete(key);
        if (probes!.size === 0) sharedBranchProbes.delete(controller);
      },
    };
    probes.set(key, probe);
  }
  probe.contexts += 1;
  return probe;
}

function footerData(controller: TuiController, cwd: string, signal: AbortSignal): ReadonlyFooterDataProvider {
  const callbacks = new Set<() => void>();
  const probe = acquireBranchProbe(controller, cwd);
  let unsubscribe: (() => void) | undefined;
  let released = false;
  const notify = () => {
    if (signal.aborted) return;
    for (const listener of callbacks) {
      try { listener(); } catch {}
    }
  };
  const stop = () => {
    if (released) return;
    released = true;
    unsubscribe?.();
    unsubscribe = undefined;
    callbacks.clear();
    probe.release();
  };
  signal.addEventListener("abort", stop, { once: true });
  return Object.freeze({
    getSnapshot: () => controller.footerDataSnapshot(),
    getGitBranch: () => { if (!signal.aborted) void probe.refresh(); return probe.value; },
    getExtensionStatuses: () => controller.extensionStatusSnapshot(),
    getAvailableProviderCount: () => controller.availableProviderCount(),
    onBranchChange(callback: () => void): () => void {
      signal.throwIfAborted();
      if (typeof callback !== "function") throw new TypeError("Branch listener must be a function");
      callbacks.add(callback);
      unsubscribe ??= probe.subscribe(notify);
      return () => {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          unsubscribe?.();
          unsubscribe = undefined;
        }
      };
    },
  });
}

function rawTerminal(controller: TuiController, titleKey: string, signal: AbortSignal): Terminal {
  const facades = new WeakMap<AbortSignal, Terminal>();
  let activeIoOwner: (() => void) | undefined;
  let activeProgressOwner: ((clear: boolean) => void) | undefined;
  const create = (ownerSignal: AbortSignal): Terminal => {
    let close: (() => void) | undefined;
    let progressTimer: NodeJS.Timeout | undefined;
    let ownsProgress = false;
    let wrote = false;
    const write = (value: string): void => {
      ownerSignal.throwIfAborted();
      controller.writeUnsafeTerminal(value);
      if (value !== "") wrote = true;
    };
    const releaseProgress = (clear: boolean): void => {
      if (!ownsProgress) return;
      ownsProgress = false;
      if (progressTimer !== undefined) clearInterval(progressTimer);
      progressTimer = undefined;
      if (activeProgressOwner !== releaseProgress) return;
      activeProgressOwner = undefined;
      if (!clear) return;
      try {
        controller.writeUnsafeTerminal("\u001b]9;4;0;\u0007");
        wrote = true;
      } catch {}
    };
    const terminal: Terminal = {
      start(onInput, onResize) {
        ownerSignal.throwIfAborted();
        if (close !== undefined) return;
        activeIoOwner?.();
        const input = controller.registerUnsafeTerminalInputHandler((data) => { onInput(data); return { consume: true }; }, ownerSignal);
        const resize = () => onResize();
        controller.output.on("resize", resize);
        let release!: () => void;
        release = () => {
          input();
          controller.output.off("resize", resize);
          if (close === release) close = undefined;
          if (activeIoOwner === release) activeIoOwner = undefined;
        };
        close = release;
        activeIoOwner = release;
      },
      stop() {
        close?.();
        releaseProgress(true);
      },
      async drainInput(maxMs, idleMs) {
        ownerSignal.throwIfAborted();
        await controller.drainInput(maxMs, idleMs);
        ownerSignal.throwIfAborted();
      },
      write,
      get columns() { ownerSignal.throwIfAborted(); return controller.unsafeTerminalSize().columns; },
      get rows() { ownerSignal.throwIfAborted(); return controller.unsafeTerminalSize().rows; },
      get kittyProtocolActive() { ownerSignal.throwIfAborted(); return controller.unsafeTerminalKittyProtocolActive(); },
      moveBy(lines) { if (Number.isFinite(lines) && lines !== 0) write(`\u001b[${Math.abs(Math.trunc(lines))}${lines < 0 ? "A" : "B"}`); },
      hideCursor() { write("\u001b[?25l"); },
      showCursor() { write("\u001b[?25h"); },
      clearLine() { write("\u001b[K"); },
      clearFromCursor() { write("\u001b[0J"); },
      clearScreen() { write("\u001b[2J\u001b[H"); },
      setTitle(title) { controller.setKeyedTitle(titleKey, title, ownerSignal); },
      setProgress(value) {
        ownerSignal.throwIfAborted();
        if (value !== undefined) {
          write("\u001b]9;4;3\u0007");
          if (!ownsProgress) {
            activeProgressOwner?.(false);
            ownsProgress = true;
            activeProgressOwner = releaseProgress;
          }
          progressTimer ??= setInterval(() => {
            try { write("\u001b]9;4;3\u0007"); }
            catch { releaseProgress(false); }
          }, 1_000);
          progressTimer.unref();
        } else {
          releaseProgress(true);
        }
      },
    };
    ownerSignal.addEventListener("abort", () => {
      terminal.stop();
      if (wrote) try { controller.requestUnsafeTerminalRender(); } catch {}
    }, { once: true });
    return terminal;
  };
  const terminal = create(signal);
  interactiveDirectTerminalFacades.set(terminal, (ownerSignal) => {
    if (ownerSignal === signal) return terminal;
    const existing = facades.get(ownerSignal);
    if (existing !== undefined) return existing;
    const created = create(ownerSignal);
    facades.set(ownerSignal, created);
    return created;
  });
  return terminal;
}

function rawTui(
  controller: TuiController,
  ownerKey: string,
  signal: AbortSignal,
  services: InteractiveDirectUiServices,
): TUI {
  const terminal = rawTerminal(controller, `${ownerKey}:title`, signal);
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
      const key = `${ownerKey}:root:${++ordinal}`;
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
      let closed = false;
      let entry!: { handle: OverlayHandle; close(): void; paused: boolean };
      const remove = () => { const index = overlays.indexOf(entry); if (index >= 0) overlays.splice(index, 1); };
      const close = () => { if (closed) return; closed = true; remove(); mounted.close(); };
      const handle: OverlayHandle = {
        hide: close,
        setHidden(hidden) { if (!closed) mounted.handle.setHidden(hidden); },
        isHidden: () => closed || mounted.handle.isHidden(),
        focus() { if (!closed) mounted.handle.focus(); },
        unfocus(unfocus) { if (!closed) mounted.handle.unfocus(unfocus); },
        isFocused: () => !closed && mounted.handle.isFocused(),
      };
      entry = { handle, close, paused: false };
      overlays.push(entry);
      void mounted.result.then(() => { closed = true; remove(); }, () => { closed = true; remove(); });
      return handle;
    },
    hideOverlay() { overlays.at(-1)?.close(); },
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

function autocompletePosition(text: string, cursor: number): {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
} {
  const lines = text.split("\n");
  const before = splitGraphemes(text).slice(0, cursor).join("").split("\n");
  return {
    lines,
    cursorLine: before.length - 1,
    cursorCol: before.at(-1)?.length ?? 0,
  };
}

function autocompleteCursor(lines: string[], cursorLine: number, cursorCol: number): number {
  if (lines.length === 0) return 0;
  const lineIndex = Math.max(0, Math.min(
    Number.isSafeInteger(cursorLine) ? cursorLine : lines.length - 1,
    lines.length - 1,
  ));
  const line = lines[lineIndex] ?? "";
  const column = Math.max(0, Math.min(
    Number.isSafeInteger(cursorCol) ? cursorCol : line.length,
    line.length,
  ));
  const before = lines.slice(0, lineIndex).join("\n");
  const local = line.slice(0, column);
  return splitGraphemes(before).length + (lineIndex === 0 ? 0 : 1) + splitGraphemes(local).length;
}

function rawProvider(current: TuiAutocompleteProvider): AutocompleteProvider {
  const nativeItems = new WeakMap<AutocompleteItem, TuiAutocompleteCompletion>();
  return {
    ...(current.triggerCharacters === undefined ? {} : { triggerCharacters: [...current.triggerCharacters] }),
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const text = lines.join("\n");
      const values = await current(text, autocompleteCursor(lines, cursorLine, cursorCol), options.signal, {
        ...(options.force === undefined ? {} : { force: options.force }),
      });
      if (values === null || values.length === 0) return null;
      return {
        prefix: "",
        items: values.map((value) => {
          const item = {
            value: value.value,
            label: value.label ?? value.value,
            ...(value.detail === undefined ? {} : { description: value.detail }),
          };
          nativeItems.set(item, value);
          return item;
        }),
      };
    },
    applyCompletion(lines, cursorLine, cursorCol, item) {
      const native = nativeItems.get(item);
      if (native !== undefined) {
        const graphemes = splitGraphemes(lines.join("\n"));
        const replacement = splitGraphemes(native.value);
        const updated = [
          ...graphemes.slice(0, native.start),
          ...replacement,
          ...graphemes.slice(native.end),
        ];
        return autocompletePosition(updated.join(""), native.cursor ?? native.start + replacement.length);
      }
      const selected = [...lines];
      const line = selected[cursorLine] ?? "";
      selected[cursorLine] = `${line.slice(0, cursorCol)}${item.value}${line.slice(cursorCol)}`;
      return { lines: selected, cursorLine, cursorCol: cursorCol + item.value.length };
    },
    ...(current.shouldTriggerFileCompletion === undefined
      ? {}
      : {
          shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
            return current.shouldTriggerFileCompletion?.(
              lines.join("\n"),
              autocompleteCursor(lines, cursorLine, cursorCol),
            ) ?? true;
          },
        }),
  };
}

function autocompleteWrapper(factory: (current: AutocompleteProvider) => AutocompleteProvider):
  (current: TuiAutocompleteProvider) => TuiAutocompleteProvider {
  return (current) => {
    const provider = factory(rawProvider(current));
    if (provider === null || typeof provider !== "object" || typeof provider.getSuggestions !== "function"
      || typeof provider.applyCompletion !== "function") throw new TypeError("Autocomplete factory must return a provider");
    const wrapped: TuiAutocompleteProvider = async (text, cursor, signal, options):
    Promise<readonly TuiAutocompleteCompletion[] | null> => {
      const graphemes = splitGraphemes(text);
      const position = autocompletePosition(text, cursor);
      const suggestions = await provider.getSuggestions(
        position.lines,
        position.cursorLine,
        position.cursorCol,
        { signal, ...(options?.force === undefined ? {} : { force: options.force }) },
      );
      if (suggestions === null) return null;
      return suggestions.items.map((item) => {
        const applied = provider.applyCompletion(
          position.lines,
          position.cursorLine,
          position.cursorCol,
          item,
          suggestions.prefix,
        );
        const value = applied.lines.join("\n");
        const next = splitGraphemes(value);
        let start = 0;
        while (start < graphemes.length && start < next.length && graphemes[start] === next[start]) start += 1;
        let oldEnd = graphemes.length;
        let newEnd = next.length;
        while (oldEnd > start && newEnd > start && graphemes[oldEnd - 1] === next[newEnd - 1]) { oldEnd -= 1; newEnd -= 1; }
        const completedCursor = autocompleteCursor(applied.lines, applied.cursorLine, applied.cursorCol);
        return {
          start,
          end: oldEnd,
          value: next.slice(start, newEnd).join(""),
          ...(completedCursor === newEnd ? {} : { cursor: completedCursor }),
          label: item.label,
          ...(item.description === undefined ? {} : { detail: item.description }),
        };
      });
    };
    const triggerCharacters = [...new Set([
      ...(current.triggerCharacters ?? []),
      ...(provider.triggerCharacters ?? []),
    ])];
    if (triggerCharacters.length > 0) {
      Object.defineProperty(wrapped, "triggerCharacters", {
        enumerable: true,
        value: Object.freeze(triggerCharacters),
      });
    }
    if (provider.shouldTriggerFileCompletion !== undefined) {
      wrapped.shouldTriggerFileCompletion = (text, cursor) => {
        const position = autocompletePosition(text, cursor);
        return provider.shouldTriggerFileCompletion?.(
          position.lines,
          position.cursorLine,
          position.cursorCol,
        ) ?? true;
      };
    }
    return wrapped;
  };
}

/** @internal Creates a rich UI context under a stable host-owned namespace. */
export function createOwnedInteractiveDirectUiContext(
  controller: TuiController,
  ownerKey: string,
  cwd: string,
  signal: AbortSignal,
  services: InteractiveDirectUiServices = {},
): RuntimeDirectUiContext {
  signal.throwIfAborted();
  const tui = rawTui(controller, ownerKey, signal, services);
  const keybindings = controller.keybindingsManager();
  const data = footerData(controller, cwd, signal);
  const theme = liveTheme(controller);
  const themedComponents = new Set<{ invalidate(): void }>();
  const keyedThemedComponents = new Map<string, {
    component: { invalidate(): void };
    signal: AbortSignal;
    onAbort(): void;
  }>();
  const widgetSlots = new Map<string, {
    slot: TuiPersistentComponentSlot;
    signal: AbortSignal;
    onAbort(): void;
  }>();
  const editorOwner = {};
  let editorDisposer: (() => void) | undefined;
  let editorPresentation: { signal: AbortSignal; onAbort(): void } | undefined;
  let titlePresentation: { signal: AbortSignal; onAbort(): void } | undefined;
  let themeDisposer: (() => void) | undefined;
  const removeThemeChange = controller.onThemeChange(() => {
    for (const mounted of themedComponents) {
      try { mounted.invalidate(); } catch {}
    }
    try { tui.invalidate(); } catch {}
    controller.requestRawRender();
  }, signal);
  signal.addEventListener("abort", () => {
    removeThemeChange();
    for (const owner of keyedThemedComponents.values()) {
      owner.signal.removeEventListener("abort", owner.onAbort);
    }
    for (const owner of widgetSlots.values()) owner.signal.removeEventListener("abort", owner.onAbort);
    themedComponents.clear();
    keyedThemedComponents.clear();
    widgetSlots.clear();
  }, { once: true });
  signal.addEventListener("abort", () => removeDirectEditorFactory(controller, editorOwner), { once: true });
  const key = (value: string) => `${ownerKey}:${value}`;
  const trackThemed = <T extends { invalidate(): void }>(
    owner: string,
    selected: T,
    presentationSignal: AbortSignal,
  ): T => {
    untrackThemed(owner);
    let tracked!: { component: T; signal: AbortSignal; onAbort(): void };
    const onAbort = (): void => {
      if (keyedThemedComponents.get(owner) !== tracked) return;
      keyedThemedComponents.delete(owner);
      themedComponents.delete(selected);
    };
    tracked = { component: selected, signal: presentationSignal, onAbort };
    keyedThemedComponents.set(owner, tracked);
    themedComponents.add(selected);
    presentationSignal.addEventListener("abort", onAbort, { once: true });
    if (presentationSignal.aborted) onAbort();
    return selected;
  };
  const untrackThemed = (owner: string): void => {
    const previous = keyedThemedComponents.get(owner);
    if (previous !== undefined) {
      previous.signal.removeEventListener("abort", previous.onAbort);
      themedComponents.delete(previous.component);
    }
    keyedThemedComponents.delete(owner);
  };
  const component = (
    slot: TuiPersistentComponentSlot,
    name: string,
    factory: RuntimeDirectPersistentComponentFactory | undefined,
    presentationSignal: AbortSignal,
  ): void => {
    const selectedKey = key(name);
    const owner = `persistent:${slot}:${selectedKey}`;
    untrackThemed(owner);
    if (factory === undefined) controller.setRawPersistentComponent(slot, selectedKey);
    else controller.setRawPersistentComponent(
      slot,
      selectedKey,
      trackThemed(owner, factory(callbackTui(tui, presentationSignal), theme), presentationSignal),
      presentationSignal,
    );
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
    presentationSignal: AbortSignal,
    factory: ((
      runtimeTui: TUI,
      activeTheme: Theme,
      activeKeybindings: KeybindingsManager,
      finish: (result: T) => void,
    ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>),
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
    let mounted: (Component & { dispose?(): void }) | undefined;
    try {
      return await controller.customRaw<T>(
        async (done) => {
          mounted = await factory(callbackTui(tui, presentationSignal), theme, keybindings, done);
          themedComponents.add(mounted);
          return mounted;
        },
        selectedOptions,
        presentationSignal,
      ) as T;
    } finally {
      if (mounted !== undefined) themedComponents.delete(mounted);
    }
  };
  const facades = new WeakMap<AbortSignal, RuntimeDirectUiContext>();
  const contextFor = (presentationSignal: AbortSignal): RuntimeDirectUiContext => {
    presentationSignal.throwIfAborted();
    const existing = facades.get(presentationSignal);
    if (existing !== undefined) return existing;
    let selectedTui: TUI | undefined;
    const runtimeTui = (): TUI => selectedTui ??= callbackTui(tui, presentationSignal);
    const active = (): void => { presentationSignal.throwIfAborted(); };
    const context = Object.freeze<RuntimeDirectUiContext>({
    async select(title, options, opts) {
      const selectedSignal = interactionSignal(presentationSignal, opts);
      try { return await controller.choose(title, options.map((value) => ({ label: value, value })), selectedSignal); }
      catch (cause) { if (selectedSignal.aborted) return undefined; throw cause; }
    },
    async confirm(title, message, opts) {
      const selectedSignal = interactionSignal(presentationSignal, opts);
      try {
        return await controller.choose(`${title}: ${message}`, [{ label: "Yes", value: true }, { label: "No", value: false }], selectedSignal);
      } catch (cause) { if (selectedSignal.aborted) return false; throw cause; }
    },
    async input(title, placeholder, opts) {
      const selectedSignal = interactionSignal(presentationSignal, opts);
      try { return await controller.requestInput(title, placeholder, selectedSignal); }
      catch (cause) { if (selectedSignal.aborted) return undefined; throw cause; }
    },
    notify(message, type = "info") { active(); controller.notify(message, type === "info" ? "status" : type); },
    onTerminalInput(handler) {
      return controller.registerUnsafeTerminalInputHandler((value) => handler(value), presentationSignal);
    },
    setStatus(name, text) {
      active();
      controller.setExtensionStatus(key(name), text, text === undefined ? undefined : presentationSignal);
    },
    setWorkingMessage(message) {
      active();
      controller.setExtensionWorkingMessage(ownerKey, message, message === undefined ? undefined : presentationSignal);
    },
    setWorkingVisible(visible) {
      active();
      controller.setExtensionWorkingVisible(ownerKey, visible, visible === undefined ? undefined : presentationSignal);
    },
    setWorkingIndicator(options) {
      active();
      controller.setKeyedWorkingIndicator(key("indicator"), options === undefined ? undefined : {
        frames: [...(options.frames ?? (controller.capabilities.unicode
          ? ["◐", "◓", "◑", "◒"]
          : [".", "o", "O", "o"]))],
        intervalMs: options.intervalMs ?? 80,
        ...(options.frames?.length === 0 ? { hidden: true } : {}),
      }, options === undefined ? undefined : presentationSignal);
    },
    setHiddenThinkingLabel(label) {
      active();
      controller.setKeyedHiddenReasoningLabel(key("reasoning"), label, label === undefined ? undefined : presentationSignal);
    },
    setBackground(factory) {
      active();
      const selectedKey = key("background");
      const owner = `background:${selectedKey}`;
      untrackThemed(owner);
      if (factory === undefined) controller.setRawBackgroundComponent(selectedKey);
      else if (controller.mode === "full") {
        controller.setRawBackgroundComponent(
          selectedKey,
          trackThemed(owner, factory(runtimeTui(), theme), presentationSignal),
          presentationSignal,
        );
      }
    },
    setWidget(name, content, options) {
      active();
      const slot = options?.placement === "belowEditor" ? "widget-below" : "widget-above";
      const selectedKey = key(name);
      const owner = `widget:${selectedKey}`;
      const previousSlot = widgetSlots.get(selectedKey);
      if (previousSlot !== undefined) {
        previousSlot.signal.removeEventListener("abort", previousSlot.onAbort);
        widgetSlots.delete(selectedKey);
      }
      if (previousSlot !== undefined && previousSlot.slot !== slot) {
        controller.setRawPersistentComponent(previousSlot.slot, selectedKey);
      }
      untrackThemed(owner);
      if (content === undefined) {
        controller.setRawPersistentComponent(slot, selectedKey);
      } else {
        let slotOwner!: { slot: TuiPersistentComponentSlot; signal: AbortSignal; onAbort(): void };
        const onAbort = (): void => {
          if (widgetSlots.get(selectedKey) === slotOwner) widgetSlots.delete(selectedKey);
        };
        slotOwner = { slot, signal: presentationSignal, onAbort };
        widgetSlots.set(selectedKey, slotOwner);
        presentationSignal.addEventListener("abort", onAbort, { once: true });
        if (presentationSignal.aborted) onAbort();
        if (Array.isArray(content)) {
          controller.setRawPersistentComponent(slot, selectedKey, linesComponent(content), presentationSignal);
        } else {
          controller.setRawPersistentComponent(
            slot,
            selectedKey,
            trackThemed(owner, content(runtimeTui(), theme), presentationSignal),
            presentationSignal,
          );
        }
      }
    },
    setFooter(factory) {
      active();
      const selectedKey = key("footer");
      const owner = `persistent:footer-replacement:${selectedKey}`;
      untrackThemed(owner);
      if (factory === undefined) controller.setRawPersistentComponent("footer-replacement", selectedKey);
      else controller.setRawPersistentComponent(
        "footer-replacement",
        selectedKey,
        trackThemed(owner, factory(runtimeTui(), theme, data), presentationSignal),
        presentationSignal,
      );
    },
    setHeader(factory) { active(); component("header-replacement", "header", factory, presentationSignal); },
    setTitle(title) {
      active();
      if (titlePresentation !== undefined) {
        controller.setKeyedTitle(key("title"), undefined, titlePresentation.signal);
        titlePresentation.signal.removeEventListener("abort", titlePresentation.onAbort);
        titlePresentation = undefined;
      }
      controller.setKeyedTitle(key("title"), title, presentationSignal);
      const onAbort = (): void => {
        if (titlePresentation?.onAbort === onAbort) titlePresentation = undefined;
      };
      titlePresentation = { signal: presentationSignal, onAbort };
      presentationSignal.addEventListener("abort", onAbort, { once: true });
      if (presentationSignal.aborted) onAbort();
    },
    async custom(factory, options) {
      return await custom(presentationSignal, factory, options);
    },
    pasteToEditor(text) { active(); controller.insertClipboardText(text); },
    setEditorText(text) { active(); controller.setEditorText(text); },
    getEditorText() { active(); return controller.getEditorText(); },
    async editor(title, prefill) {
      try { return await controller.editor(title, prefill, presentationSignal); }
      catch (cause) { if (presentationSignal.aborted) return undefined; throw cause; }
    },
    addAutocompleteProvider(factory) {
      active();
      controller.wrapNativeAutocompleteProvider(autocompleteWrapper(factory), presentationSignal);
    },
    setEditorComponent(factory) {
      active();
      editorDisposer?.();
      editorDisposer = undefined;
      if (editorPresentation !== undefined) {
        editorPresentation.signal.removeEventListener("abort", editorPresentation.onAbort);
        editorPresentation = undefined;
      }
      untrackThemed("editor");
      removeDirectEditorFactory(controller, editorOwner);
      if (factory !== undefined) {
        const selected = trackThemed("editor", factory(runtimeTui(), editorTheme(theme), keybindings), presentationSignal);
        const preferences = controller.rawEditorPreferences();
        selected.setPaddingX?.(preferences.paddingX);
        selected.setAutocompleteMaxVisible?.(preferences.autocompleteMaxVisible);
        editorDisposer = controller.installRawEditor(
          selected,
          presentationSignal,
          (provider) => selected.setAutocompleteProvider?.(rawProvider(provider)),
        );
        const owners = directEditorFactories.get(controller) ?? [];
        owners.push({ token: editorOwner, factory });
        directEditorFactories.set(controller, owners);
        const onAbort = (): void => {
          if (editorPresentation?.onAbort !== onAbort) return;
          editorPresentation = undefined;
          editorDisposer = undefined;
          removeDirectEditorFactory(controller, editorOwner);
        };
        editorPresentation = { signal: presentationSignal, onAbort };
        presentationSignal.addEventListener("abort", onAbort, { once: true });
        if (presentationSignal.aborted) onAbort();
      }
    },
    getEditorComponent() { active(); return directEditorFactories.get(controller)?.at(-1)?.factory; },
    get theme() { active(); return theme; },
    getAllThemes() { active(); return controller.themeNames().map((name) => ({ name, path: services.themePath?.(name) })); },
    getTheme(name) { active(); return controller.themeCatalogObjects().find((theme) => theme.name === name); },
    setTheme(value) {
      try {
        active();
        themeDisposer?.();
        themeDisposer = undefined;
        if (typeof value === "string") {
          if (!controller.themeNames().includes(value)) throw new Error(`Unknown theme: ${value}`);
          controller.setTheme(value);
          services.settings?.setTheme(value);
        } else {
          themeDisposer = controller.applyNativeTheme(value, presentationSignal);
        }
        return { success: true };
      } catch (cause) { return { success: false, error: boundedTuiFailureText(cause) }; }
    },
    getToolsExpanded() { active(); return controller.getToolOutputExpanded(); },
    setToolsExpanded(expanded) {
      active();
      controller.setKeyedToolOutputExpanded(key("tools"), expanded, presentationSignal);
    },
    });
    facades.set(presentationSignal, context);
    return context;
  };
  const context = contextFor(signal);
  interactiveDirectUiFacades.set(context, contextFor);
  return context;
}

export function createInteractiveDirectUiContext(
  controller: TuiController,
  extensionId: string,
  cwd: string,
  signal: AbortSignal,
  services: InteractiveDirectUiServices = {},
): RuntimeDirectUiContext {
  return createOwnedInteractiveDirectUiContext(
    controller,
    extensionId,
    cwd,
    signal,
    services,
  );
}
