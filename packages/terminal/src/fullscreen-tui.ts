import type { Terminal } from "./terminal.js";
import { graphemeWidth } from "./internal-unicode.js";
import { type Component, TUI } from "./tui.js";
import { extractAnsiCode, getGraphemeSegmenter } from "./utils.js";
import {
  cancelViewportPointer,
  dispatchViewportPointer,
  fitViewportRows,
  renderViewport,
  type ViewportPointerEvent,
  type ViewportPointerTarget,
} from "./viewport.js";

const ENTER_FULLSCREEN = "\x1b[?1049h";
const LEAVE_FULLSCREEN = "\x1b[?1049l";
const DISABLE_LINE_WRAP = "\x1b[?7l";
const ENABLE_LINE_WRAP = "\x1b[?7h";
const ENABLE_POINTER = "\x1b[?1000h\x1b[?1003h\x1b[?1006h\x1b[?1004h";
const DISABLE_POINTER = "\x1b[?1004l\x1b[?1006l\x1b[?1003l\x1b[?1000l";

interface PointerInput {
  data: string;
  events: ViewportPointerEvent[];
  focusLost: boolean;
  reportSeen: boolean;
}

export interface FullscreenTUIOptions {
  mouse?: boolean;
  wheelScrollLines?: number;
  openUrl?: (target: string) => void;
}

interface ClickState {
  row: number;
  column: number;
  dragged: boolean;
}

function pointerButton(code: number): ViewportPointerEvent["button"] {
  const selected = code & 3;
  return selected === 0 ? "left" : selected === 1 ? "middle" : selected === 2 ? "right" : "none";
}

function parsePointerInput(value: string, wheelScrollLines: number): PointerInput {
  const events: ViewportPointerEvent[] = [];
  let focusLost = false;
  let reportSeen = false;
  let output = "";
  let start = 0;
  const reports = /\x1b\[<([0-9]{1,3});([0-9]{1,5});([0-9]{1,5})([Mm])|\x1b\[([IO])/gu;
  for (const match of value.matchAll(reports)) {
    reportSeen = true;
    const index = match.index;
    output += value.slice(start, index);
    start = index + match[0].length;
    if (match[5] !== undefined) {
      focusLost ||= match[5] === "O";
      continue;
    }
    const code = Number(match[1]);
    const column = Number(match[2]) - 1;
    const row = Number(match[3]) - 1;
    if (!Number.isSafeInteger(code) || !Number.isSafeInteger(row) || !Number.isSafeInteger(column)
      || row < 0 || column < 0 || row > 9_999 || column > 9_999) continue;
    if ((code & 64) !== 0) {
      const direction = code & 3;
      if (direction < 2) events.push({
        type: "wheel",
        row,
        column,
        button: "none",
        deltaRows: direction === 0 ? -wheelScrollLines : wheelScrollLines,
      });
      continue;
    }
    const released = match[4] === "m" || ((code & 32) === 0 && (code & 3) === 3);
    events.push({
      type: released ? "release" : (code & 32) !== 0 ? "move" : "press",
      row,
      column,
      button: pointerButton(code),
    });
  }
  output += value.slice(start);
  return { data: output, events, focusLost, reportSeen };
}

function safeLinkTarget(value: string): string | undefined {
  if (value.length < 1 || value.length > 4_096 || /[\u0000-\u0020\u007f-\u009f]/u.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) return undefined;
    if (parsed.username !== "" || parsed.password !== "") return undefined;
    return parsed.href.length <= 4_096 ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function linkAtColumn(line: string, selectedColumn: number): string | undefined {
  if (!Number.isSafeInteger(selectedColumn) || selectedColumn < 0) return undefined;
  let target: string | undefined;
  let column = 0;
  let offset = 0;
  while (offset < line.length) {
    const escape = extractAnsiCode(line, offset);
    if (escape !== null) {
      if (escape.code.startsWith("\x1b]8;")) {
        const terminator = escape.code.endsWith("\x07") ? 1 : 2;
        const payload = escape.code.slice(4, -terminator);
        const separator = payload.indexOf(";");
        target = separator < 0 ? undefined : safeLinkTarget(payload.slice(separator + 1));
      }
      offset += escape.length;
      continue;
    }
    let end = offset;
    while (end < line.length && line[end] !== "\x1b") end += 1;
    for (const segment of getGraphemeSegmenter().segment(line.slice(offset, end))) {
      const visible = graphemeWidth(segment.segment);
      if (visible > 0 && selectedColumn >= column && selectedColumn < column + visible) return target;
      column += visible;
    }
    offset = end;
  }
  return undefined;
}

/** Fixed-height terminal surface. The existing TUI class remains the main-screen surface. */
export class FullscreenTUI extends TUI {
  #root: Component | undefined;
  #fullscreenActive = false;
  #capturedPointer: ViewportPointerTarget | undefined;
  #hoveredPointer: ViewportPointerTarget | undefined;
  readonly #mouse: boolean;
  readonly #wheelScrollLines: number;
  readonly #openUrl: ((target: string) => void) | undefined;
  #click: ClickState | undefined;
  #frame: string[] = [];

  constructor(
    terminal: Terminal,
    showHardwareCursor?: boolean,
    logDirectory?: string,
    options: FullscreenTUIOptions = {},
  ) {
    super(terminal, showHardwareCursor, logDirectory);
    const wheelScrollLines = Math.trunc(options.wheelScrollLines ?? 3);
    if (!Number.isSafeInteger(wheelScrollLines) || wheelScrollLines < 1 || wheelScrollLines > 100) {
      throw new RangeError("Fullscreen wheel scroll lines must be 1 to 100");
    }
    this.#mouse = options.mouse ?? true;
    this.#wheelScrollLines = wheelScrollLines;
    this.#openUrl = options.openUrl;
    this.addInputListener((data) => this.#handlePointerInput(data));
  }

  get root(): Component | undefined { return this.#root; }

  setRoot(component: Component | undefined): void {
    if (component === this.#root) return;
    this.#cancelPointer();
    this.#frame = [];
    super.clear();
    this.#root = component;
    if (component) super.addChild(component);
    this.requestRender(true);
  }

  /** Component-authoring alias for replacing the fixed-height layout root. */
  setLayoutRoot(component: Component | undefined): void { this.setRoot(component); }

  override addChild(component: Component): void {
    if (this.#root) throw new Error("FullscreenTUI accepts one root component; use a stack to compose children");
    this.#frame = [];
    this.#root = component;
    super.addChild(component);
  }

  override removeChild(component: Component): void {
    if (component !== this.#root) return;
    this.#cancelPointer();
    this.#frame = [];
    super.removeChild(component);
    this.#root = undefined;
  }

  override clear(): void {
    this.#cancelPointer();
    this.#frame = [];
    super.clear();
    this.#root = undefined;
  }

  override render(width: number): string[] {
    const columns = Math.max(0, Math.trunc(width));
    const rows = Math.max(0, Math.trunc(this.terminal.rows));
    if (!this.#root) return fitViewportRows([], columns, rows);
    return renderViewport(this.#root, columns, rows, () => this.requestRender());
  }

  protected override compositionChanged(): void { this.#frame = []; }

  protected override frameComposed(lines: readonly string[]): void {
    this.#frame = [...lines];
  }

  protected override beforeTerminalStart(): void {
    this.#fullscreenActive = true;
    this.terminal.write(`${ENTER_FULLSCREEN}${DISABLE_LINE_WRAP}${this.#mouse ? ENABLE_POINTER : ""}\x1b[2J\x1b[H`);
  }

  protected override beforeTerminalStop(): void {
    if (!this.#fullscreenActive) return;
    this.#cancelPointer();
    this.#fullscreenActive = false;
    this.#click = undefined;
    this.#frame = [];
    this.terminal.write(`\x1b[0m${this.#mouse ? DISABLE_POINTER : ""}${ENABLE_LINE_WRAP}${LEAVE_FULLSCREEN}`);
  }

  #handlePointerInput(data: string): { consume?: boolean; data?: string } | undefined {
    if (!this.#mouse) return undefined;
    const parsed = parsePointerInput(data, this.#wheelScrollLines);
    if (parsed.focusLost) this.#cancelPointer();
    for (const event of parsed.events) this.#dispatchPointer(event);
    if (!parsed.reportSeen) return undefined;
    return parsed.data === "" ? { consume: true } : { data: parsed.data };
  }

  #dispatchPointer(event: ViewportPointerEvent): void {
    const root = this.#root;
    if (root === undefined) return;
    const result = dispatchViewportPointer(
      root,
      event,
      this.terminal.columns,
      this.terminal.rows,
      this.#capturedPointer,
    );
    if (event.type === "press" && event.button === "left" && !result.handled) {
      this.#click = { row: event.row, column: event.column, dragged: false };
    } else if (event.type === "move" && this.#click !== undefined
      && (this.#click.row !== event.row || this.#click.column !== event.column)) {
      this.#click.dragged = true;
    } else if (event.type === "release") {
      const click = this.#click;
      this.#click = undefined;
      if (click !== undefined && !click.dragged && click.row === event.row && click.column === event.column) {
        const target = linkAtColumn(this.#frame[event.row] ?? "", event.column);
        if (target !== undefined) this.#openUrl?.(target);
      }
    }
    if (event.type === "move" && this.#capturedPointer === undefined) {
      if (this.#hoveredPointer !== undefined && this.#hoveredPointer !== result.target) {
        cancelViewportPointer(root, this.#hoveredPointer, this.terminal.columns, this.terminal.rows, "leave");
      }
      this.#hoveredPointer = result.target;
    }
    if (result.capture !== undefined) this.#capturedPointer = result.capture;
    if (result.releaseCapture === true || (this.#capturedPointer !== undefined && result.target === undefined)) {
      this.#capturedPointer = undefined;
    }
    if (result.handled) this.requestRender();
  }

  #cancelPointer(): void {
    const root = this.#root;
    if (root !== undefined) {
      if (this.#capturedPointer !== undefined) {
        cancelViewportPointer(root, this.#capturedPointer, this.terminal.columns, this.terminal.rows);
      }
      if (this.#hoveredPointer !== undefined && this.#hoveredPointer !== this.#capturedPointer) {
        cancelViewportPointer(root, this.#hoveredPointer, this.terminal.columns, this.terminal.rows);
      }
    }
    this.#capturedPointer = undefined;
    this.#hoveredPointer = undefined;
    this.#click = undefined;
  }
}
