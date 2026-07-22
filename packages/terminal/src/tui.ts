import { isKeyRelease, matchesKey } from "./keys.js";
import type { Terminal } from "./terminal.js";
import { isOsc11BackgroundColorResponse, parseOsc11BackgroundColor, parseTerminalColorSchemeReport, type RgbColor, type TerminalColorScheme } from "./terminal-colors.js";
import { deleteKittyImage, getCapabilities, isImageLine, setCellDimensions } from "./terminal-image.js";
import { extractSegments, normalizeTerminalOutput, sliceByColumn, sliceWithWidth, visibleWidth } from "./utils.js";

export interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  wantsKeyRelease?: boolean;
  invalidate(): void;
}
/** One zero-based, single-column glyph on a host-owned background plane. */
export interface BackgroundCell {
  row: number;
  column: number;
  text: string;
}
/** A bounded background projection. The host remains the only terminal writer. */
export interface BackgroundComponent {
  render(width: number, height: number): readonly BackgroundCell[];
  invalidate(): void;
  dispose?(): void;
}
export interface Focusable { focused: boolean }
export function isFocusable(component: Component | null): component is Component & Focusable { return component !== null && "focused" in component; }
export const CURSOR_MARKER = "\x1b_rigyn:c\x07";

export type OverlayAnchor = "center" | "top-left" | "top-right" | "bottom-left" | "bottom-right" | "top-center" | "bottom-center" | "left-center" | "right-center";
export interface OverlayMargin { top?: number; right?: number; bottom?: number; left?: number }
export type SizeValue = number | `${number}%`;
export interface OverlayOptions {
  width?: SizeValue; minWidth?: number; maxHeight?: SizeValue; anchor?: OverlayAnchor;
  offsetX?: number; offsetY?: number; row?: SizeValue; col?: SizeValue; margin?: OverlayMargin | number;
  visible?: (terminalWidth: number, terminalHeight: number) => boolean; nonCapturing?: boolean;
}
export interface OverlayUnfocusOptions { target: Component | null }
export interface OverlayHandle {
  hide(): void; setHidden(hidden: boolean): void; isHidden(): boolean; focus(): void; unfocus(options?: OverlayUnfocusOptions): void; isFocused(): boolean;
}
type InputListener = (data: string) => { consume?: boolean; data?: string } | undefined;
interface OverlayEntry { component: Component; options: OverlayOptions; previous: Component | null; hidden: boolean; order: number }
type OverlayResume = { kind: "overlay" } | { kind: "target"; target: Component | null };
type OverlayRestore =
  | { kind: "inactive" }
  | { kind: "eligible"; entry: OverlayEntry }
  | { kind: "blocked"; entry: OverlayEntry; blocker: Component; resume: OverlayResume };

export class Container implements Component {
  children: Component[] = [];
  addChild(component: Component): void { this.children.push(component); }
  removeChild(component: Component): void { const index = this.children.indexOf(component); if (index >= 0) this.children.splice(index, 1); }
  clear(): void { this.children = []; }
  invalidate(): void { for (const child of this.children) child.invalidate(); }
  render(width: number): string[] { return this.children.flatMap((child) => child.render(width)); }
}

function valueOf(value: SizeValue | undefined, reference: number): number | undefined {
  if (typeof value === "number") return value;
  const match = value ? /^(\d+(?:\.\d+)?)%$/u.exec(value) : undefined;
  return match ? Math.floor(reference * Number(match[1]) / 100) : undefined;
}
function margins(value: number | OverlayMargin | undefined): Required<OverlayMargin> {
  if (typeof value === "number") return { top: Math.max(0, value), right: Math.max(0, value), bottom: Math.max(0, value), left: Math.max(0, value) };
  return { top: Math.max(0, value?.top ?? 0), right: Math.max(0, value?.right ?? 0), bottom: Math.max(0, value?.bottom ?? 0), left: Math.max(0, value?.left ?? 0) };
}
function imageIds(line: string): number[] {
  const ids: number[] = [];
  for (const match of line.matchAll(/\x1b_G([^;]*);/gu)) for (const part of match[1]!.split(",")) {
    const [name, value] = part.split("="); const id = Number(value);
    if (name === "i" && Number.isInteger(id) && id > 0) ids.push(id);
  }
  return ids;
}
function imageRows(line: string): number { const value = /(?:^|,)r=(\d+)(?:,|;)/u.exec(line)?.[1]; return Math.max(1, Number(value ?? 1)); }

export class TUI extends Container {
  terminal: Terminal;
  onDebug?: () => void;
  readonly #listeners = new Set<InputListener>();
  readonly #schemeListeners = new Set<(scheme: TerminalColorScheme) => void>();
  readonly #overlays: OverlayEntry[] = [];
  #focus: Component | null = null;
  #restore: OverlayRestore = { kind: "inactive" };
  #previous: string[] = [];
  #previousImages = new Set<number>();
  #previousWidth = 0;
  #previousHeight = 0;
  #cursorRow = 0;
  #hardwareRow = 0;
  #viewportTop = 0;
  #maxRows = 0;
  #order = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #requested = false;
  #stopped = true;
  #lastRender = 0;
  #hardwareCursor = process.env.RIGYN_HARDWARE_CURSOR === "1";
  #clearOnShrink = process.env.RIGYN_CLEAR_ON_SHRINK === "1";
  #fullRedraws = 0;
  #schemeNotifications = false;
  readonly #backgroundQueries: Array<{ done: boolean; resolve(value: RgbColor | undefined): void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(terminal: Terminal, showHardwareCursor?: boolean) {
    super(); this.terminal = terminal; if (showHardwareCursor !== undefined) this.#hardwareCursor = showHardwareCursor;
  }
  get fullRedraws(): number { return this.#fullRedraws; }
  getShowHardwareCursor(): boolean { return this.#hardwareCursor; }
  setShowHardwareCursor(value: boolean): void { this.#hardwareCursor = value; if (!value) this.terminal.hideCursor(); this.requestRender(); }
  getClearOnShrink(): boolean { return this.#clearOnShrink; }
  setClearOnShrink(value: boolean): void { this.#clearOnShrink = value; }

  setFocus(component: Component | null): void {
    this.#setFocus(component, "clear");
  }

  #setFocus(component: Component | null, policy: "clear" | "preserve"): void {
    const previous = this.#focus; let next = component;
    const previousOverlay = previous ? this.#overlays.find((entry) => entry.component === previous && this.#visible(entry)) : undefined;
    const nextIsOverlay = next !== null && this.#overlays.some((entry) => entry.component === next);
    const restore = this.#visibleRestore();
    if (next !== null && !nextIsOverlay) {
      if (restore.kind === "blocked" && restore.blocker === previous) {
        if (restore.resume.kind === "target" || !this.#mounted(restore.blocker)) next = this.#resolveRestore(restore);
        else this.#restore = { ...restore, blocker: next };
      } else if (previousOverlay && restore.kind !== "inactive" && restore.entry === previousOverlay && !this.#isFocusAncestor(previousOverlay, next)) {
        this.#restore = { kind: "blocked", entry: previousOverlay, blocker: next, resume: { kind: "overlay" } };
      }
    } else if (next === null) {
      if (restore.kind === "blocked" && restore.blocker === previous) next = this.#resolveRestore(restore);
      else if (policy === "clear") this.#restore = { kind: "inactive" };
    }
    if (isFocusable(this.#focus)) this.#focus.focused = false;
    this.#focus = next;
    if (isFocusable(next)) next.focused = true;
    const focusedOverlay = next ? this.#overlays.find((entry) => entry.component === next && this.#visible(entry)) : undefined;
    if (focusedOverlay) this.#restore = { kind: "eligible", entry: focusedOverlay };
  }

  #visibleRestore(): OverlayRestore {
    if (this.#restore.kind === "inactive") return this.#restore;
    return this.#overlays.includes(this.#restore.entry) && this.#visible(this.#restore.entry) ? this.#restore : { kind: "inactive" };
  }

  #resolveRestore(restore: Extract<OverlayRestore, { kind: "blocked" }>): Component | null {
    if (restore.resume.kind === "overlay") return restore.entry.component;
    this.#restore = { kind: "inactive" }; return restore.resume.target;
  }

  #clearRestore(entry?: OverlayEntry): void {
    if (!entry || (this.#restore.kind !== "inactive" && this.#restore.entry === entry)) this.#restore = { kind: "inactive" };
  }

  #isFocusAncestor(entry: OverlayEntry, target: Component): boolean {
    const visited = new Set<Component>(); let current = entry.previous;
    while (current && !visited.has(current)) {
      visited.add(current); if (current === target) return true;
      current = this.#overlays.find((candidate) => candidate.component === current)?.previous ?? null;
    }
    return false;
  }

  #mounted(target: Component): boolean {
    const contains = (root: Component): boolean => root === target || (root instanceof Container && root.children.some(contains));
    return this.children.some(contains);
  }

  #retargetRemoved(entry: OverlayEntry): void {
    for (const candidate of this.#overlays) if (candidate !== entry && candidate.previous === entry.component) candidate.previous = entry.previous;
  }

  showOverlay(component: Component, options: OverlayOptions = {}): OverlayHandle {
    const entry: OverlayEntry = { component, options, previous: this.#focus, hidden: false, order: ++this.#order };
    this.#overlays.push(entry);
    if (!options.nonCapturing && this.#visible(entry)) this.setFocus(component);
    this.terminal.hideCursor(); this.requestRender();
    let removed = false;
    return {
      hide: () => {
        if (removed) return; removed = true;
        this.#clearRestore(entry); this.#retargetRemoved(entry);
        const index = this.#overlays.indexOf(entry); if (index >= 0) this.#overlays.splice(index, 1);
        if (this.#focus === component) this.setFocus(this.#top()?.component ?? entry.previous);
        this.requestRender();
      },
      setHidden: (hidden) => {
        if (removed || entry.hidden === hidden) return; entry.hidden = hidden;
        if (hidden) this.#clearRestore(entry);
        if (hidden && this.#focus === component) this.setFocus(this.#top(entry)?.component ?? entry.previous);
        else if (!hidden && !entry.options.nonCapturing && this.#visible(entry)) { entry.order = ++this.#order; this.setFocus(component); }
        this.requestRender();
      },
      isHidden: () => removed || entry.hidden,
      focus: () => { if (!removed && this.#visible(entry)) { entry.order = ++this.#order; this.setFocus(component); this.requestRender(); } },
      unfocus: (unfocus) => {
        if (removed) return;
        const restore = this.#restore; const focused = this.#focus === component;
        const pending = restore.kind !== "inactive" && restore.entry === entry;
        if (!focused && !pending) return;
        if (restore.kind === "blocked" && restore.entry === entry && this.#focus === restore.blocker) {
          if (unfocus) this.#restore = { ...restore, resume: { kind: "target", target: unfocus.target } };
          else this.#clearRestore(entry);
          this.requestRender(); return;
        }
        this.#clearRestore(entry);
        if (focused || unfocus) this.setFocus(unfocus ? unfocus.target : this.#top(entry)?.component ?? entry.previous);
        this.requestRender();
      },
      isFocused: () => !removed && this.#focus === component,
    };
  }
  hideOverlay(): void {
    const entry = this.#overlays.at(-1); if (!entry) return;
    this.#clearRestore(entry); this.#retargetRemoved(entry);
    this.#overlays.pop(); if (this.#focus === entry.component) this.setFocus(this.#top()?.component ?? entry.previous); this.requestRender();
  }
  hasOverlay(): boolean { return this.#overlays.some((entry) => this.#visible(entry)); }
  #visible(entry: OverlayEntry): boolean { return !entry.hidden && (entry.options.visible?.(this.terminal.columns, this.terminal.rows) ?? true); }
  #top(exclude?: OverlayEntry): OverlayEntry | undefined { return this.#overlays.filter((entry) => entry !== exclude && !entry.options.nonCapturing && this.#visible(entry)).sort((a, b) => b.order - a.order)[0]; }

  override invalidate(): void { super.invalidate(); for (const overlay of this.#overlays) overlay.component.invalidate(); }
  start(): void {
    this.#stopped = false;
    this.terminal.start((data) => this.#handleInput(data), () => this.requestRender());
    this.terminal.hideCursor();
    if (this.#schemeNotifications) this.terminal.write("\x1b[?2031h");
    if (getCapabilities().images) this.terminal.write("\x1b[16t");
    this.requestRender();
  }
  stop(): void {
    if (this.#stopped) return; this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined;
    if (this.#schemeNotifications) this.terminal.write("\x1b[?2031l");
    if (this.#previous.length > 0) {
      let output = " "; const target = this.#previous.length; const delta = target - this.#hardwareRow;
      if (delta) output += `\x1b[${Math.abs(delta)}${delta > 0 ? "B" : "A"}`;
      this.terminal.write(output + "\r\n");
    }
    this.terminal.showCursor(); this.terminal.stop();
  }

  addInputListener(listener: InputListener): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  removeInputListener(listener: InputListener): void { this.#listeners.delete(listener); }
  onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void { this.#schemeListeners.add(listener); return () => this.#schemeListeners.delete(listener); }
  setTerminalColorSchemeNotifications(value: boolean): void {
    if (this.#schemeNotifications === value) return; this.#schemeNotifications = value;
    if (!this.#stopped) this.terminal.write(value ? "\x1b[?2031h" : "\x1b[?2031l");
  }

  requestRender(force = false): void {
    if (this.#stopped) return;
    if (force) {
      this.#previous = []; this.#previousWidth = -1; this.#previousHeight = -1; this.#cursorRow = 0; this.#hardwareRow = 0; this.#viewportTop = 0; this.#maxRows = 0;
      if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined;
    }
    if (this.#requested) return; this.#requested = true;
    queueMicrotask(() => {
      if (this.#stopped || !this.#requested || this.#timer) return;
      const delay = Math.max(0, 16 - (performance.now() - this.#lastRender));
      this.#timer = setTimeout(() => { this.#timer = undefined; if (this.#stopped || !this.#requested) return; this.#requested = false; this.#lastRender = performance.now(); this.#render(); }, delay);
    });
  }

  #handleInput(initial: string): void {
    if (this.#backgroundQueries.length > 0 && isOsc11BackgroundColorResponse(initial)) {
      const query = this.#backgroundQueries.shift()!; query.done = true; clearTimeout(query.timer); query.resolve(parseOsc11BackgroundColor(initial)); return;
    }
    const scheme = parseTerminalColorSchemeReport(initial);
    if (scheme) { for (const listener of this.#schemeListeners) listener(scheme); return; }
    const cell = /^\x1b\[6;(\d+);(\d+)t$/u.exec(initial);
    if (cell) { if (Number(cell[1]) > 0 && Number(cell[2]) > 0) { setCellDimensions({ widthPx: Number(cell[2]), heightPx: Number(cell[1]) }); this.invalidate(); this.requestRender(); } return; }
    let data = initial;
    for (const listener of this.#listeners) { const result = listener(data); if (result?.consume) return; if (result?.data !== undefined) data = result.data; }
    if (!data) return;
    if (matchesKey(data, "shift+ctrl+d") && this.onDebug) { this.onDebug(); return; }
    const focusedOverlay = this.#overlays.find((entry) => entry.component === this.#focus);
    if (focusedOverlay && !this.#visible(focusedOverlay)) {
      const top = this.#top();
      if (top) this.setFocus(top.component); else this.#setFocus(focusedOverlay.previous, "preserve");
    }
    if (!this.#overlays.some((entry) => entry.component === this.#focus)) {
      const restore = this.#visibleRestore();
      if (restore.kind === "eligible") this.setFocus(restore.entry.component);
      else if (restore.kind === "blocked" && restore.blocker !== this.#focus) {
        if (restore.resume.kind === "overlay") this.setFocus(restore.entry.component);
        else { const target = restore.resume.target; this.#restore = { kind: "inactive" }; this.setFocus(target); }
      }
    }
    if (this.#focus?.handleInput && (!isKeyRelease(data) || this.#focus.wantsKeyRelease)) { this.#focus.handleInput(data); this.requestRender(); }
  }

  #layout(entry: OverlayEntry, height: number): { width: number; maxHeight?: number; row: number; col: number } {
    const options = entry.options; const terminalWidth = this.terminal.columns; const terminalHeight = this.terminal.rows; const margin = margins(options.margin);
    const availableWidth = Math.max(1, terminalWidth - margin.left - margin.right); const availableHeight = Math.max(1, terminalHeight - margin.top - margin.bottom);
    let width = valueOf(options.width, terminalWidth) ?? Math.min(80, availableWidth); width = Math.min(availableWidth, Math.max(1, options.minWidth ?? 1, width));
    const maxHeightValue = valueOf(options.maxHeight, terminalHeight); const maxHeight = maxHeightValue === undefined ? undefined : Math.min(availableHeight, Math.max(1, maxHeightValue));
    const actualHeight = Math.min(height, maxHeight ?? height); const anchor = options.anchor ?? "center";
    const anchorRow = anchor.startsWith("top") ? margin.top : anchor.startsWith("bottom") ? margin.top + availableHeight - actualHeight : margin.top + Math.floor((availableHeight - actualHeight) / 2);
    const anchorCol = anchor.endsWith("left") || anchor.startsWith("left") ? margin.left : anchor.endsWith("right") || anchor.startsWith("right") ? margin.left + availableWidth - width : margin.left + Math.floor((availableWidth - width) / 2);
    const position = (value: SizeValue | undefined, size: number, available: number, edge: number, fallback: number) => typeof value === "number" ? value : typeof value === "string" ? edge + Math.floor(Math.max(0, available - size) * Number(value.slice(0, -1)) / 100) : fallback;
    const row = Math.max(margin.top, Math.min(terminalHeight - margin.bottom - actualHeight, position(options.row, actualHeight, availableHeight, margin.top, anchorRow) + (options.offsetY ?? 0)));
    const col = Math.max(margin.left, Math.min(terminalWidth - margin.right - width, position(options.col, width, availableWidth, margin.left, anchorCol) + (options.offsetX ?? 0)));
    return { width, ...(maxHeight === undefined ? {} : { maxHeight }), row, col };
  }

  #composite(lines: string[]): string[] {
    if (!this.hasOverlay()) return lines;
    const result = [...lines]; const visible = this.#overlays.filter((entry) => this.#visible(entry)).sort((a, b) => a.order - b.order);
    const rendered = visible.map((entry) => {
      const first = this.#layout(entry, 0); let content = entry.component.render(first.width);
      if (first.maxHeight !== undefined) content = content.slice(0, first.maxHeight);
      const final = this.#layout(entry, content.length); return { content, ...final };
    });
    const minimum = Math.max(this.terminal.rows, result.length, ...rendered.map((item) => item.row + item.content.length));
    while (result.length < minimum) result.push("");
    const viewport = Math.max(0, result.length - this.terminal.rows);
    for (const overlay of rendered) for (let offset = 0; offset < overlay.content.length; offset += 1) {
      const row = viewport + overlay.row + offset; if (row >= result.length) continue;
      const source = result[row]!; const content = visibleWidth(overlay.content[offset]!) > overlay.width ? sliceByColumn(overlay.content[offset]!, 0, overlay.width, true) : overlay.content[offset]!;
      result[row] = this.compositeLineAt(source, content, overlay.col, overlay.width, this.terminal.columns);
    }
    return result;
  }

  private compositeLineAt(base: string, overlay: string, column: number, overlayWidth: number, totalWidth: number): string {
    if (isImageLine(base)) return base;
    const afterColumn = column + overlayWidth;
    const segments = extractSegments(base, column, afterColumn, totalWidth - afterColumn, true);
    const selected = sliceWithWidth(overlay, 0, overlayWidth, true);
    const reset = "\x1b[0m\x1b]8;;\x07";
    let result = segments.before
      + " ".repeat(Math.max(0, column - segments.beforeWidth))
      + reset + selected.text + " ".repeat(Math.max(0, overlayWidth - selected.width))
      + reset + segments.after;
    result += " ".repeat(Math.max(0, totalWidth - visibleWidth(result)));
    return visibleWidth(result) > totalWidth ? sliceByColumn(result, 0, totalWidth, true) : result;
  }

  #cursor(lines: string[]): { row: number; col: number } | undefined {
    const top = Math.max(0, lines.length - this.terminal.rows);
    for (let row = lines.length - 1; row >= top; row -= 1) {
      const index = lines[row]!.indexOf(CURSOR_MARKER); if (index < 0) continue;
      const col = visibleWidth(lines[row]!.slice(0, index)); lines[row] = lines[row]!.slice(0, index) + lines[row]!.slice(index + CURSOR_MARKER.length); return { row, col };
    }
    return undefined;
  }

  #reservedImageRows(lines: string[], index: number, maximum = lines.length - 1): number {
    const declared = imageRows(lines[index] ?? "");
    if (declared <= 1) return 1;
    const limit = Math.min(declared, maximum - index + 1, lines.length - index);
    let count = 1;
    while (count < limit) {
      const line = lines[index + count] ?? "";
      if (isImageLine(line) || visibleWidth(line) > 0) break;
      count += 1;
    }
    return count;
  }

  #imageAwareRange(first: number, last: number, lines: string[]): { first: number; last: number } {
    let expandedFirst = first; let expandedLast = last;
    const include = (candidate: string[]) => {
      for (let index = 0; index < candidate.length; index += 1) {
        if (imageIds(candidate[index]!).length === 0) continue;
        const end = index + this.#reservedImageRows(candidate, index) - 1;
        if (index >= first || (index <= last && end >= first)) {
          expandedFirst = Math.min(expandedFirst, index);
          expandedLast = Math.max(expandedLast, end);
        }
      }
    };
    include(this.#previous); include(lines);
    return { first: expandedFirst, last: expandedLast };
  }

  #render(): void {
    const width = this.terminal.columns; const height = this.terminal.rows;
    let lines = this.render(width); lines = this.#composite(lines); const cursor = this.#cursor(lines);
    lines = lines.map((line) => isImageLine(line) ? line : normalizeTerminalOutput(line) + "\x1b[0m\x1b]8;;\x07");
    const widthChanged = this.#previousWidth !== 0 && this.#previousWidth !== width; const heightChanged = this.#previousHeight !== 0 && this.#previousHeight !== height;
    const full = (clear: boolean) => {
      this.#fullRedraws += 1; let output = "\x1b[?2026h";
      if (clear) { for (const id of this.#previousImages) output += deleteKittyImage(id); output += "\x1b[2J\x1b[H\x1b[3J"; }
      for (let index = 0; index < lines.length; index += 1) { if (index) output += "\r\n"; const rows = isImageLine(lines[index]!) ? imageRows(lines[index]!) : 1; if (rows > 1 && rows <= height) { output += "\r\n".repeat(rows - 1) + `\x1b[${rows - 1}A${lines[index]}\x1b[${rows - 1}B`; index += rows - 1; } else output += lines[index]; }
      this.terminal.write(output + "\x1b[?2026l"); this.#cursorRow = Math.max(0, lines.length - 1); this.#hardwareRow = this.#cursorRow; this.#maxRows = clear ? lines.length : Math.max(this.#maxRows, lines.length); this.#viewportTop = Math.max(0, Math.max(height, lines.length) - height); this.#finish(lines, width, height, cursor);
    };
    if (this.#previous.length === 0 && !widthChanged && !heightChanged) { full(false); return; }
    if (widthChanged || (heightChanged && !process.env.TERMUX_VERSION) || (this.#clearOnShrink && lines.length < this.#maxRows && !this.hasOverlay())) { full(true); return; }
    let first = -1; let last = -1; const count = Math.max(lines.length, this.#previous.length);
    for (let index = 0; index < count; index += 1) if ((lines[index] ?? "") !== (this.#previous[index] ?? "")) { if (first < 0) first = index; last = index; }
    const appended = lines.length > this.#previous.length;
    if (appended) { if (first < 0) first = this.#previous.length; last = lines.length - 1; }
    if (first < 0) { this.#position(cursor, lines.length); this.#previousHeight = height; return; }
    ({ first, last } = this.#imageAwareRange(first, last, lines));
    const appendStart = appended && first === this.#previous.length && first > 0;
    if (first >= lines.length && Math.max(0, lines.length - 1) < this.#viewportTop) { full(true); return; }
    if (first >= lines.length) {
      const target = Math.max(0, lines.length - 1); const extra = this.#previous.length - lines.length;
      if (extra > height) { full(true); return; }
      let output = "\x1b[?2026h";
      for (const id of new Set(this.#previous.slice(first, last + 1).flatMap(imageIds))) output += deleteKittyImage(id);
      const delta = target - this.#hardwareRow;
      if (delta) output += `\x1b[${Math.abs(delta)}${delta > 0 ? "B" : "A"}`;
      output += "\r";
      const startBelowContent = lines.length === 0 ? 0 : 1;
      if (startBelowContent) output += "\x1b[1B";
      for (let index = 0; index < extra; index += 1) {
        output += "\r\x1b[2K";
        if (index < extra - 1) output += "\x1b[1B";
      }
      const returnRows = Math.max(0, extra - 1 + startBelowContent);
      if (returnRows) output += `\x1b[${returnRows}A`;
      this.terminal.write(output + "\x1b[?2026l");
      this.#cursorRow = target; this.#hardwareRow = target; this.#position(cursor, lines.length);
      this.#previous = lines; this.#previousImages = new Set(lines.flatMap(imageIds)); this.#previousWidth = width; this.#previousHeight = height;
      return;
    }
    if (first < this.#viewportTop) { full(true); return; }
    const previousBottom = this.#viewportTop + height - 1; if (first > previousBottom) { full(true); return; }
    let output = "\x1b[?2026h"; const oldIds = new Set(this.#previous.slice(first, last + 1).flatMap(imageIds)); for (const id of oldIds) output += deleteKittyImage(id);
    const moveTarget = appendStart ? first - 1 : first;
    const delta = moveTarget - this.#hardwareRow; if (delta) output += `\x1b[${Math.abs(delta)}${delta > 0 ? "B" : "A"}`; output += appendStart ? "\r\n" : "\r";
    const renderLast = Math.min(last, lines.length - 1);
    for (let index = first; index <= renderLast; index += 1) {
      if (index > first) output += "\r\n";
      const line = lines[index]!; const reserved = isImageLine(line) ? this.#reservedImageRows(lines, index, renderLast) : 1;
      if (reserved > 1) {
        const screenRow = index - this.#viewportTop;
        if (screenRow < 0 || screenRow + reserved > height) { full(true); return; }
        output += "\x1b[2K";
        for (let row = 1; row < reserved; row += 1) output += "\r\n\x1b[2K";
        output += `\x1b[${reserved - 1}A${line}\x1b[${reserved - 1}B`;
        index += reserved - 1;
      } else output += `\x1b[2K${line}`;
    }
    if (this.#previous.length > lines.length) { for (let index = lines.length; index < this.#previous.length; index += 1) output += "\r\n\x1b[2K"; if (this.#previous.length > lines.length) output += `\x1b[${this.#previous.length - lines.length}A`; }
    this.terminal.write(output + "\x1b[?2026l"); this.#cursorRow = Math.max(0, lines.length - 1); this.#hardwareRow = Math.max(first, renderLast); this.#viewportTop = Math.max(this.#viewportTop, this.#hardwareRow - height + 1); this.#maxRows = Math.max(this.#maxRows, lines.length); this.#finish(lines, width, height, cursor);
  }

  #finish(lines: string[], width: number, height: number, cursor?: { row: number; col: number }): void {
    this.#position(cursor, lines.length); this.#previous = lines; this.#previousImages = new Set(lines.flatMap(imageIds)); this.#previousWidth = width; this.#previousHeight = height;
  }
  #position(cursor: { row: number; col: number } | undefined, total: number): void {
    if (!cursor || total === 0) { this.terminal.hideCursor(); return; }
    const row = Math.max(0, Math.min(cursor.row, total - 1)); const delta = row - this.#hardwareRow;
    this.terminal.write(`${delta ? `\x1b[${Math.abs(delta)}${delta > 0 ? "B" : "A"}` : ""}\x1b[${Math.max(0, cursor.col) + 1}G`); this.#hardwareRow = row;
    if (this.#hardwareCursor) this.terminal.showCursor(); else this.terminal.hideCursor();
  }

  queryTerminalBackgroundColor({ timeoutMs }: { timeoutMs: number }): Promise<RgbColor | undefined> {
    return new Promise((resolve) => { const query = { done: false, resolve, timer: setTimeout(() => { if (!query.done) { query.done = true; resolve(undefined); } }, timeoutMs) }; this.#backgroundQueries.push(query); this.terminal.write("\x1b]11;?\x07"); });
  }
  queryTerminalColorScheme({ timeoutMs }: { timeoutMs: number }): Promise<TerminalColorScheme | undefined> {
    return new Promise((resolve) => { let done = false; const unsubscribe = this.onTerminalColorSchemeChange((scheme) => { if (!done) { done = true; clearTimeout(timer); unsubscribe(); resolve(scheme); } }); const timer = setTimeout(() => { if (!done) { done = true; unsubscribe(); resolve(undefined); } }, timeoutMs); this.terminal.write("\x1b[?996n"); });
  }
}

export { visibleWidth };
