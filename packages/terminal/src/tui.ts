import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Terminal } from "./terminal.js";
import { isKeyRelease, matchesKey } from "./keys.js";
import { parseOsc11BackgroundColor, parseTerminalColorSchemeReport, type RgbColor, type TerminalColorScheme } from "./terminal-colors.js";
import { scheduleTimeout, type ManagedTimeout, validateTimerDelay } from "./internal-timer.js";
import { visibleWidth } from "./utils.js";
import { compositeTerminalLine } from "./compositor.js";
import { deleteKittyImage } from "./terminal-image.js";

export const CURSOR_MARKER = "\x1b_rigyn:c\x07";

export interface Component { render(width: number): string[]; handleInput?(data: string): void; invalidate(): void; focused?: boolean; wantsKeyRelease?: boolean }
export interface Focusable extends Component { focused: boolean }
export interface BackgroundCell { row: number; column: number; text: string }
export interface BackgroundComponent {
  render(width: number, height: number): readonly BackgroundCell[];
  invalidate(): void;
  dispose?(): void;
}
export type SizeValue = number | `${number}%`;
export type OverlayAnchor = "top-left" | "top-center" | "top-right" | "left-center" | "center" | "right-center" | "bottom-left" | "bottom-center" | "bottom-right";
export interface OverlayMargin { top?: number; right?: number; bottom?: number; left?: number }
export interface OverlayOptions { width?: SizeValue; height?: SizeValue; maxHeight?: SizeValue; anchor?: OverlayAnchor; row?: number; col?: number; offsetX?: number; offsetY?: number; margin?: number | OverlayMargin; visible?: (width: number, height: number) => boolean; nonCapturing?: boolean }
export interface OverlayUnfocusOptions { target: Component | null; restoreFocus?: boolean }
export interface OverlayHandle {
  hide(): void;
  setHidden(hidden: boolean): void;
  isHidden(): boolean;
  focus(): void;
  unfocus(options?: OverlayUnfocusOptions): void;
  isFocused(): boolean;
}
export type TuiInputListenerResult = void | { consume?: boolean; data?: string };
export type TuiInputListener = (data: string) => TuiInputListenerResult;
export interface ViewportTUI { setLayoutRoot(component: Component | undefined): void }

interface OverlayState { component: Component; options: OverlayOptions; hidden: boolean; previousFocus?: Component }
interface PendingQuery<T> { accept: (value: T | undefined) => void; timer: ManagedTimeout }

export function isFocusable(value: Component): value is Focusable { return typeof value.focused === "boolean" && typeof value.handleInput === "function"; }
export function isViewportTUI(value: unknown): value is ViewportTUI { return typeof value === "object" && value !== null && "setLayoutRoot" in value && typeof (value as ViewportTUI).setLayoutRoot === "function"; }

export class Container implements Component {
  children: Component[] = [];
  addChild(component: Component): void { if (!this.children.includes(component)) this.children.push(component); }
  removeChild(component: Component): void { const index = this.children.indexOf(component); if (index >= 0) this.children.splice(index, 1); }
  clear(): void { this.children.length = 0; }
  render(width: number): string[] { return this.children.flatMap((child) => child.render(width)); }
  invalidate(): void { for (const child of this.children) child.invalidate(); }
}

export class TUI extends Container {
  readonly terminal: Terminal;
  #showHardwareCursor: boolean;
  #clearOnShrink = false;
  readonly #logDirectory: string | undefined;
  readonly #listeners: TuiInputListener[] = [];
  readonly #overlays: OverlayState[] = [];
  readonly #backgroundQueries: Array<PendingQuery<RgbColor>> = [];
  readonly #schemeQueries: Array<PendingQuery<TerminalColorScheme>> = [];
  readonly #schemeListeners = new Set<(scheme: TerminalColorScheme) => void>();
  #focus: Component | undefined;
  #running = false;
  #scheduled = false;
  #forceFullRedraw = false;
  #lines: string[] = [];
  fullRedraws = 0;
  onDebug?: () => void;

  constructor(terminal: Terminal, showHardwareCursor = false, logDirectory?: string) {
    super();
    this.terminal = terminal;
    this.#showHardwareCursor = showHardwareCursor;
    this.#logDirectory = logDirectory ?? (process.env.RIGYN_DEBUG_REDRAW === "1" ? join(process.env.RIGYN_HOME ?? join(process.env.HOME ?? ".", ".rigyn"), "logs") : undefined);
  }

  override addChild(component: Component): void { super.addChild(component); this.compositionChanged(); this.requestRender(); }
  override removeChild(component: Component): void { super.removeChild(component); if (this.#focus === component) this.#focus = undefined; this.compositionChanged(); this.requestRender(); }
  override clear(): void { super.clear(); this.#focus = undefined; this.compositionChanged(); this.requestRender(); }
  setFocus(component: Component | null | undefined): void { if (this.#focus !== undefined && isFocusable(this.#focus)) this.#focus.focused = false; this.#focus = component ?? undefined; if (component != null && isFocusable(component)) component.focused = true; }
  addInputListener(listener: TuiInputListener): () => void { this.#listeners.push(listener); return () => { const index = this.#listeners.indexOf(listener); if (index >= 0) this.#listeners.splice(index, 1); }; }
  removeInputListener(listener: TuiInputListener): void { const index = this.#listeners.indexOf(listener); if (index >= 0) this.#listeners.splice(index, 1); }
  onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void { this.#schemeListeners.add(listener); return () => { this.#schemeListeners.delete(listener); }; }
  setTerminalColorSchemeNotifications(enabled: boolean): void { this.terminal.write(enabled ? "\x1b[?2031h" : "\x1b[?2031l"); }
  getShowHardwareCursor(): boolean { return this.#showHardwareCursor; }
  setShowHardwareCursor(value: boolean): void { this.#showHardwareCursor = value; if (this.#running) { if (value) this.terminal.showCursor(); else this.terminal.hideCursor(); } }
  getClearOnShrink(): boolean { return this.#clearOnShrink; }
  setClearOnShrink(value: boolean): void { this.#clearOnShrink = value; }
  hasOverlay(): boolean { return this.#overlays.some((overlay) => !overlay.hidden); }
  hideOverlay(): void { this.#removeOverlay(this.#overlays.at(-1)); }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    try {
      this.beforeTerminalStart();
      this.terminal.start((data) => this.#input(data), () => { this.fullRedraws += 1; this.requestRender(true); });
      if (this.#showHardwareCursor) this.terminal.showCursor(); else this.terminal.hideCursor();
      this.fullRedraws += 1;
      this.#diagnostic("rigyn-debug.log", "full-redraw reason=initial");
      this.requestRender(true);
    } catch (error) {
      try { this.beforeTerminalStop(); } finally { this.terminal.showCursor(); this.terminal.stop(); this.#running = false; }
      throw error;
    }
  }

  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    this.#settleQueries();
    try {
      if (this.#lines.some((line) => line.includes(CURSOR_MARKER))) this.terminal.write(" ");
      this.beforeTerminalStop();
      if (!(this instanceof Object && "setLayoutRoot" in this)) this.terminal.write("\r\n");
    } finally {
      this.terminal.showCursor();
      this.terminal.stop();
      this.#scheduled = false;
      this.#lines = [];
    }
  }

  requestRender(full = false): void {
    this.#forceFullRedraw ||= full;
    if (!this.#running || this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      if (!this.#running) return;
      try { this.#paint(); } catch (error) { this.#renderFailure(error); }
    });
  }

  showOverlay(component: Component, options: OverlayOptions = {}): OverlayHandle {
    const state: OverlayState = { component, options, hidden: false, ...(this.#focus === undefined ? {} : { previousFocus: this.#focus }) };
    this.#overlays.push(state);
    if (options.nonCapturing !== true) this.setFocus(component);
    this.compositionChanged();
    this.requestRender();
    return {
      hide: () => this.#removeOverlay(state),
      setHidden: (hidden) => { state.hidden = hidden; if (hidden && this.#focus === component) this.setFocus(state.previousFocus); else if (!hidden && options.nonCapturing !== true) this.setFocus(component); this.requestRender(); },
      isHidden: () => state.hidden || !this.#overlays.includes(state),
      focus: () => { if (!state.hidden) this.setFocus(component); },
      unfocus: (selected) => { if (this.#focus === component) this.setFocus(selected?.target ?? (selected?.restoreFocus === false ? undefined : state.previousFocus)); },
      isFocused: () => this.#focus === component,
    };
  }

  compositeLineAt(background: string, foreground: string, column: number, width: number, frameWidth: number): string {
    return compositeTerminalLine(background, foreground, column, width, frameWidth);
  }

  queryTerminalBackgroundColor(options: { timeoutMs?: number } = {}): Promise<RgbColor | undefined> {
    const timeout = validateTimerDelay(options.timeoutMs === undefined ? 100 : options.timeoutMs, "terminal query timeout");
    this.terminal.write("\x1b]11;?\x07");
    return new Promise((accept) => {
      const pending: PendingQuery<RgbColor> = { accept, timer: undefined as never };
      pending.timer = scheduleTimeout(() => { const index = this.#backgroundQueries.indexOf(pending); if (index >= 0) this.#backgroundQueries.splice(index, 1); accept(undefined); }, timeout);
      this.#backgroundQueries.push(pending);
    });
  }

  queryTerminalColorScheme(options: { timeoutMs?: number } = {}): Promise<TerminalColorScheme | undefined> {
    const timeout = validateTimerDelay(options.timeoutMs === undefined ? 100 : options.timeoutMs, "terminal query timeout");
    this.terminal.write("\x1b[?996n");
    return new Promise((accept) => {
      const pending: PendingQuery<TerminalColorScheme> = { accept, timer: undefined as never };
      pending.timer = scheduleTimeout(() => { const index = this.#schemeQueries.indexOf(pending); if (index >= 0) this.#schemeQueries.splice(index, 1); accept(undefined); }, timeout);
      this.#schemeQueries.push(pending);
    });
  }

  protected compositionChanged(): void {}
  protected frameComposed(_lines: readonly string[]): void {}
  protected beforeTerminalStart(): void {}
  protected beforeTerminalStop(): void {}

  #removeOverlay(state: OverlayState | undefined): void {
    if (state === undefined) return;
    const index = this.#overlays.indexOf(state);
    if (index < 0) return;
    this.#overlays.splice(index, 1);
    if (this.#focus === state.component) this.setFocus(state.previousFocus);
    this.compositionChanged();
    this.requestRender();
  }

  #input(initial: string): void {
    const background = parseOsc11BackgroundColor(initial);
    if (background !== undefined && this.#backgroundQueries.length > 0) { const query = this.#backgroundQueries.shift()!; query.timer.clear(); query.accept(background); return; }
    const scheme = parseTerminalColorSchemeReport(initial);
    if (scheme !== undefined) {
      for (const listener of [...this.#schemeListeners]) listener(scheme);
      if (this.#schemeQueries.length > 0) { const query = this.#schemeQueries.shift()!; query.timer.clear(); query.accept(scheme); }
      return;
    }
    let data = initial;
    try {
      for (const listener of [...this.#listeners]) {
        const result = listener(data);
        if (result?.data !== undefined) data = result.data;
        if (result?.consume === true) return;
      }
      if (matchesKey(data, "shift+ctrl+d") && this.onDebug !== undefined) { this.onDebug(); return; }
      const target = this.#inputTarget();
      if (target === undefined || (isKeyRelease(data) && target.wantsKeyRelease !== true)) return;
      target.handleInput?.(data);
    } catch (error) { this.stop(); throw error; }
  }

  #activeOverlay(): Component | undefined {
    for (let index = this.#overlays.length - 1; index >= 0; index -= 1) {
      const overlay = this.#overlays[index]!;
      if (!overlay.hidden && overlay.options.nonCapturing !== true && overlay.options.visible?.(this.terminal.columns, this.terminal.rows) !== false) return overlay.component;
    }
    return undefined;
  }

  #contains(component: Component, candidate: Component): boolean {
    if (component === candidate) return true;
    const children = "children" in component && Array.isArray(component.children)
      ? component.children as Component[]
      : [];
    return children.some((child) => this.#contains(child, candidate));
  }

  #mounted(component: Component | undefined): boolean {
    return component !== undefined && this.children.some((child) => this.#contains(child, component));
  }

  #inputTarget(): Component | undefined {
    const overlay = this.#activeOverlay();
    if (overlay !== undefined) {
      const state = this.#overlays.find((candidate) => candidate.component === overlay);
      if (this.#focus === overlay || this.#focus === state?.previousFocus) {
        this.setFocus(overlay);
        return overlay;
      }
      if (this.#mounted(this.#focus)) return this.#focus;
      this.setFocus(overlay);
      return overlay;
    }
    const focusedOverlay = this.#overlays.find((state) => state.component === this.#focus);
    if (focusedOverlay !== undefined) return this.#mounted(focusedOverlay.previousFocus)
      ? focusedOverlay.previousFocus
      : this.children.at(-1);
    return this.#focus ?? this.children.at(-1);
  }

  #compose(): string[] {
    let lines = this.render(this.terminal.columns);
    for (const overlay of this.#overlays) {
      if (overlay.hidden || overlay.options.visible?.(this.terminal.columns, this.terminal.rows) === false) continue;
      const width = this.#size(overlay.options.width, this.terminal.columns, Math.min(this.terminal.columns, 40));
      let rendered = overlay.component.render(width);
      const height = this.#size(overlay.options.height, this.terminal.rows, rendered.length);
      const maxHeight = this.#size(overlay.options.maxHeight, this.terminal.rows, this.terminal.rows);
      rendered = rendered.slice(0, Math.min(height, maxHeight));
      const margin = typeof overlay.options.margin === "number"
        ? { top: overlay.options.margin, right: overlay.options.margin, bottom: overlay.options.margin, left: overlay.options.margin }
        : overlay.options.margin ?? {};
      const anchor = overlay.options.anchor ?? "center";
      const vertical = anchor.startsWith("top") ? margin.top ?? 0
        : anchor.startsWith("bottom") ? this.terminal.rows - rendered.length - (margin.bottom ?? 0)
          : Math.floor((this.terminal.rows - rendered.length) / 2);
      const horizontal = anchor.endsWith("left") || anchor === "left-center" ? margin.left ?? 0
        : anchor.endsWith("right") || anchor === "right-center" ? this.terminal.columns - width - (margin.right ?? 0)
          : Math.floor((this.terminal.columns - width) / 2);
      const row = overlay.options.row ?? Math.max(0, vertical + (overlay.options.offsetY ?? 0));
      const column = overlay.options.col ?? Math.max(0, horizontal + (overlay.options.offsetX ?? 0));
      lines = this.#compositeRows(lines, rendered, row, column, width);
    }
    return lines;
  }

  #size(value: SizeValue | undefined, total: number, fallback: number): number {
    if (typeof value === "number") return Math.max(0, Math.min(total, Math.trunc(value)));
    if (typeof value === "string") return Math.max(0, Math.min(total, Math.floor(total * Number.parseFloat(value) / 100)));
    return fallback;
  }

  #compositeRows(background: readonly string[], foreground: readonly string[], row: number, column: number, width: number): string[] {
    const output = [...background];
    for (let index = 0; index < foreground.length; index += 1) {
      const target = row + index;
      while (output.length <= target) output.push("");
      output[target] = this.compositeLineAt(output[target] ?? "", foreground[index] ?? "", column, width, this.terminal.columns);
    }
    return output;
  }

  #paint(): void {
    const lines = this.#compose();
    lines.forEach((line, row) => {
      const width = visibleWidth(line);
      if (width > this.terminal.columns) throw new Error(`render-width row=${row} width=${width} terminal=${this.terminal.columns} rows=${lines.length}`);
    });
    this.frameComposed(lines);
    const changed = lines.length !== this.#lines.length || lines.some((line, index) => line !== this.#lines[index]);
    if (!changed && !this.#forceFullRedraw) return;
    const oldImageIds = new Set<number>();
    for (const line of this.#lines) {
      for (const match of line.matchAll(/(?:^|,)i=(\d+)(?:,|;)/gu)) oldImageIds.add(Number(match[1]));
    }
    const deleteImages = oldImageIds.size === 0 ? "" : [...oldImageIds].map(deleteKittyImage).join("");
    let body: string;
    if (isViewportTUI(this)) {
      body = `\x1b[H${lines.map((line) => `\r\x1b[2K${line}`).join("\r\n")}`;
    } else if (this.#forceFullRedraw) {
      body = `\x1b[2J\x1b[H${lines.map((line) => `\r\x1b[2K${line}`).join("\r\n")}`;
    } else if (this.#lines.length > 0 && lines.length > this.#lines.length
      && this.#lines.every((line, index) => line === lines[index])) {
      body = lines.slice(this.#lines.length).map((line) => `\r\n\x1b[2K${line}`).join("");
    } else {
      const previousRows = this.#lines.length;
      const rows = Math.max(previousRows, lines.length, 1);
      const up = previousRows > 1 ? `\x1b[${previousRows - 1}A` : "";
      const rewritten = Array.from({ length: rows }, (_, row) => `\r\x1b[2K${lines[row] ?? ""}`).join("\r\n");
      const restore = rows > Math.max(1, lines.length) ? `\x1b[${rows - Math.max(1, lines.length)}A` : "";
      body = `${up}${rewritten}${restore}`;
    }
    this.terminal.write(`\x1b[?2026h${deleteImages}${body.replaceAll(CURSOR_MARKER, "")}\x1b[?2026l`);
    this.#lines = [...lines];
    this.#forceFullRedraw = false;
  }

  #renderFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : "render failed";
    this.#diagnostic("rigyn-crash.log", message);
    this.stop();
    queueMicrotask(() => { throw error; });
  }

  #diagnostic(filename: string, message: string): void {
    if (this.#logDirectory === undefined) return;
    try {
      const directory = resolve(this.#logDirectory);
      try {
        const existing = lstatSync(directory);
        if (existing.isSymbolicLink() || !existing.isDirectory()) return;
      } catch { /* a missing directory is created below */ }
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, filename);
      try { if (lstatSync(path).isSymbolicLink()) return; } catch { /* a missing file is safe to create */ }
      writeFileSync(path, `${new Date().toISOString()} ${message.slice(0, 1024)}\n`, { mode: 0o600, flag: filename === "rigyn-crash.log" ? "w" : "a" });
    } catch { /* diagnostics never own rendering */ }
  }

  #settleQueries(): void {
    for (const query of this.#backgroundQueries.splice(0)) { query.timer.clear(); query.accept(undefined); }
    for (const query of this.#schemeQueries.splice(0)) { query.timer.clear(); query.accept(undefined); }
  }
}
