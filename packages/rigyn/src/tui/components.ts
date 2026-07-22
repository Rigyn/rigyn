import type { CustomMessage } from "@rigyn/kernel";
import type { Component } from "@rigyn/terminal";
import type { KeyEvent } from "./keys.js";
import type { JsonValue } from "../core/json.js";
import type { ImageBlock, NormalizedUsage, TextBlock } from "../core/types.js";
import type { CustomEntry } from "../extensions/session-contract.js";
import type { ThemeName } from "./types.js";
import type { Theme } from "./theme.js";
import { THEME_ROLES, type ThemeRole } from "./theme.js";
import { cellWidth, sanitizeTerminalText, truncateCells } from "./unicode.js";

export const DEFAULT_RUNTIME_UI_MAX_LINES = 128;
export const DEFAULT_RUNTIME_UI_MAX_BYTES = 256 * 1024;
export const DEFAULT_RUNTIME_UI_MAX_SPANS_PER_LINE = 256;

const THEME_ROLE_SET = new Set<ThemeRole>(THEME_ROLES);

export interface RuntimeUiSpan {
  text: string;
  role?: ThemeRole;
}

export interface RuntimeUiLine {
  spans: readonly RuntimeUiSpan[];
  fill?: boolean;
}

export interface RuntimeUiBlock {
  lines: readonly RuntimeUiLine[];
  cursor?: { row: number; column: number };
}

export interface RuntimeUiRenderContext {
  width: number;
  height: number;
  focused: boolean;
  expanded: boolean;
  theme: {
    name: ThemeName;
    color: boolean;
    unicode: boolean;
  };
}

export interface RuntimeUiKeyEvent {
  key: string;
  text?: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export interface RuntimeUiComponent {
  render(context: RuntimeUiRenderContext): RuntimeUiBlock;
  handleKey?(event: Readonly<RuntimeUiKeyEvent>): boolean;
  invalidate?(): void;
  dispose?(): void;
}

export interface RuntimeUiComponentHost<T> {
  readonly signal: AbortSignal;
  requestRender(): void;
  close(value: T): void;
}

export interface RuntimeToolRenderView {
  callId: string;
  name: string;
  input?: JsonValue;
  result?: {
    content: string;
    contentBlocks?: readonly (TextBlock | ImageBlock)[];
    isError: boolean;
    metadata?: JsonValue;
    usage?: NormalizedUsage;
    addedToolNames?: readonly string[];
  };
  /** Embedded result images retained for trusted direct tool renderers. */
  images?: readonly ImageBlock[];
  /** True when result is a replaceable live update rather than the terminal tool result. */
  isPartial?: boolean;
  status: "pending" | "running" | "completed" | "failed" | "in_doubt";
  expanded: boolean;
}

/** Live TUI facilities supplied only by the host while a tool renderer runs. */
export interface RuntimeToolRenderBridge {
  readonly theme: Theme;
  readonly showImages: boolean;
  invalidate(): void;
}

export interface RuntimeToolRenderer {
  /** Default keeps the host card; self lets the renderer own all framing. */
  renderShell?: "default" | "self";
  renderCall?(
    view: Readonly<RuntimeToolRenderView>,
    context: RuntimeUiRenderContext,
    bridge?: RuntimeToolRenderBridge,
  ): RuntimeUiBlock | undefined;
  renderResult?(
    view: Readonly<RuntimeToolRenderView>,
    context: RuntimeUiRenderContext,
    bridge?: RuntimeToolRenderBridge,
  ): RuntimeUiBlock | undefined;
}

export interface RuntimeToolRendererBinding {
  has(name: string): boolean;
  renderShell?(name: string): "default" | "self" | undefined;
  renderCall(
    name: string,
    view: RuntimeToolRenderView,
    context: RuntimeUiRenderContext,
    bridge?: RuntimeToolRenderBridge,
  ): RuntimeUiBlock | undefined;
  renderResult(
    name: string,
    view: RuntimeToolRenderView,
    context: RuntimeUiRenderContext,
    bridge?: RuntimeToolRenderBridge,
  ): RuntimeUiBlock | undefined;
}

/** Bounded editor state exposed to an extension renderer. Input handling stays host-owned. */
export interface RuntimeEditorRenderView {
  text: string;
  /** Grapheme-indexed cursor in text. */
  cursor: number;
  label: string;
  mode: "normal" | "follow_up";
  blocked: boolean;
}

/** Replaces only the structural editor block; core editing and submission semantics remain host-owned. */
export interface RuntimeEditorRenderer {
  render(view: Readonly<RuntimeEditorRenderView>, context: RuntimeUiRenderContext): RuntimeUiBlock | undefined;
}

export interface RuntimeEditorRendererBinding {
  render(view: RuntimeEditorRenderView, context: RuntimeUiRenderContext): RuntimeUiBlock | undefined;
}

export interface RuntimeSessionRendererBinding {
  renderEntry(
    entry: Readonly<CustomEntry>,
    options: { expanded: boolean },
    theme: Theme,
  ): Component | undefined;
  renderMessage(
    message: Readonly<CustomMessage>,
    options: { expanded: boolean },
    theme: Theme,
  ): Component | undefined;
}

export type RuntimeUiComponentFactory<T = void> = (
  host: RuntimeUiComponentHost<T>,
) => RuntimeUiComponent | Promise<RuntimeUiComponent>;

export type RuntimeUiOverlayAnchor =
  | "top-left"
  | "top-center"
  | "top-right"
  | "left-center"
  | "center"
  | "right-center"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export type RuntimeUiOverlayLength = number | `${number}%`;

export interface RuntimeUiOverlayMargin {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

export interface RuntimeUiComponentHandle {
  close(): void;
  /** @deprecated Permanent alias for close(). Use setHidden(true) for temporary hiding. */
  hide(): void;
  setHidden(hidden: boolean): void;
  isHidden(): boolean;
  focus(): void;
  unfocus(options?: RuntimeUiOverlayUnfocusOptions): void;
  isFocused(): boolean;
}

export interface RuntimeUiOverlayUnfocusOptions {
  target: RuntimeUiComponentHandle | null;
}

export interface RuntimeUiOverlayHandle<T = void> extends RuntimeUiComponentHandle {
  readonly result: Promise<T | undefined>;
}

export interface RuntimeUiOverlayOptions {
  anchor?: RuntimeUiOverlayAnchor;
  width?: RuntimeUiOverlayLength;
  minWidth?: number;
  maxHeight?: RuntimeUiOverlayLength;
  row?: RuntimeUiOverlayLength;
  col?: RuntimeUiOverlayLength;
  margin?: number | RuntimeUiOverlayMargin;
  offsetX?: number;
  offsetY?: number;
  nonCapturing?: boolean;
  visible?(terminalWidth: number, terminalHeight: number): boolean;
}

export interface RuntimeUiCustomOptions {
  overlay?: boolean;
  overlayOptions?: RuntimeUiOverlayOptions | (() => RuntimeUiOverlayOptions);
  onHandle?(handle: RuntimeUiComponentHandle): void;
}

export interface RuntimeUiBlockLimits {
  width: number;
  maxLines?: number;
  maxBytes?: number;
  maxSpansPerLine?: number;
}

export type RuntimeUiRenderResult =
  | { ok: true; block: RuntimeUiBlock }
  | { ok: false; error: Error };

export interface RuntimeUiComponentMountOptions<T> {
  signal: AbortSignal;
  requestRender(): void;
  onClose?(value: T | undefined, reason: "component" | "generation" | "owner"): void;
  onError?(error: Error): void;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new TypeError(`${label} contains unknown keys: ${unknown.join(", ")}`);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer`);
  return value;
}

function error(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function reportError(callback: ((error: Error) => void) | undefined, cause: unknown): void {
  try {
    callback?.(error(cause));
  } catch {}
}

export function sanitizeRuntimeUiRenderContext(value: RuntimeUiRenderContext): RuntimeUiRenderContext {
  const width = positiveInteger(value.width, "Runtime UI width");
  const height = positiveInteger(value.height, "Runtime UI height");
  if (typeof value.focused !== "boolean" || typeof value.expanded !== "boolean") {
    throw new TypeError("Runtime UI focus and expansion state must be boolean");
  }
  if (value.theme === null || typeof value.theme !== "object") throw new TypeError("Runtime UI theme must be an object");
  if (typeof value.theme.name !== "string" || typeof value.theme.color !== "boolean" || typeof value.theme.unicode !== "boolean") {
    throw new TypeError("Runtime UI theme is invalid");
  }
  return Object.freeze({
    width,
    height,
    focused: value.focused,
    expanded: value.expanded,
    theme: Object.freeze({ ...value.theme }),
  });
}

/**
 * Converts an extension-produced block into bounded terminal-safe data. Text is
 * never trusted as ANSI: all escape/control sequences are stripped before the
 * host applies its own theme roles.
 */
export function sanitizeRuntimeUiBlock(value: unknown, limits: RuntimeUiBlockLimits): RuntimeUiBlock {
  const width = positiveInteger(limits.width, "Runtime UI width");
  const maxLines = positiveInteger(limits.maxLines ?? DEFAULT_RUNTIME_UI_MAX_LINES, "Runtime UI line limit");
  const maxBytes = positiveInteger(limits.maxBytes ?? DEFAULT_RUNTIME_UI_MAX_BYTES, "Runtime UI byte limit");
  const maxSpansPerLine = positiveInteger(
    limits.maxSpansPerLine ?? DEFAULT_RUNTIME_UI_MAX_SPANS_PER_LINE,
    "Runtime UI span limit",
  );
  const block = object(value, "Runtime UI block");
  exact(block, ["lines", "cursor"], "Runtime UI block");
  if (!Array.isArray(block.lines)) throw new TypeError("Runtime UI block lines must be an array");
  if (block.lines.length > maxLines) throw new RangeError(`Runtime UI block exceeds ${maxLines} lines`);

  let bytes = 0;
  const lines = block.lines.map((lineValue, lineIndex): RuntimeUiLine => {
    const line = object(lineValue, `Runtime UI line ${lineIndex}`);
    exact(line, ["spans", "fill"], `Runtime UI line ${lineIndex}`);
    if (!Array.isArray(line.spans)) throw new TypeError(`Runtime UI line ${lineIndex} spans must be an array`);
    if (line.spans.length > maxSpansPerLine) throw new RangeError(`Runtime UI line ${lineIndex} exceeds ${maxSpansPerLine} spans`);
    if (line.fill !== undefined && typeof line.fill !== "boolean") throw new TypeError(`Runtime UI line ${lineIndex} fill must be boolean`);

    let remaining = width;
    const spans: RuntimeUiSpan[] = [];
    for (const [spanIndex, spanValue] of line.spans.entries()) {
      const span = object(spanValue, `Runtime UI line ${lineIndex} span ${spanIndex}`);
      exact(span, ["text", "role"], `Runtime UI line ${lineIndex} span ${spanIndex}`);
      if (typeof span.text !== "string") throw new TypeError(`Runtime UI line ${lineIndex} span ${spanIndex} text must be a string`);
      bytes += Buffer.byteLength(span.text, "utf8");
      if (bytes > maxBytes) throw new RangeError(`Runtime UI block exceeds ${maxBytes} bytes`);
      if (span.role !== undefined && (typeof span.role !== "string" || !THEME_ROLE_SET.has(span.role as ThemeRole))) {
        throw new TypeError(`Runtime UI line ${lineIndex} span ${spanIndex} role is invalid`);
      }
      const safe = sanitizeTerminalText(span.text).replaceAll("\n", " ");
      const clipped = remaining === 0 ? "" : truncateCells(safe, remaining, "");
      remaining = Math.max(0, remaining - cellWidth(clipped));
      if (clipped !== "") spans.push(Object.freeze({
        text: clipped,
        ...(span.role === undefined ? {} : { role: span.role as ThemeRole }),
      }));
    }
    return Object.freeze({
      spans: Object.freeze(spans),
      ...(line.fill === undefined ? {} : { fill: line.fill }),
    });
  });

  let cursor: RuntimeUiBlock["cursor"];
  if (block.cursor !== undefined) {
    const input = object(block.cursor, "Runtime UI cursor");
    exact(input, ["row", "column"], "Runtime UI cursor");
    if (!Number.isSafeInteger(input.row) || !Number.isSafeInteger(input.column)) throw new TypeError("Runtime UI cursor coordinates must be safe integers");
    const row = input.row as number;
    const column = input.column as number;
    if (row < 0 || row >= lines.length || column < 0 || column > width) throw new RangeError("Runtime UI cursor is outside the rendered block");
    const lineWidth = lines[row]?.spans.reduce((total, span) => total + cellWidth(span.text), 0) ?? 0;
    if (column > lineWidth) throw new RangeError("Runtime UI cursor is outside its rendered line");
    cursor = Object.freeze({ row, column });
  }

  return Object.freeze({
    lines: Object.freeze(lines),
    ...(cursor === undefined ? {} : { cursor }),
  });
}

export function runtimeUiKeyEvent(value: KeyEvent): RuntimeUiKeyEvent {
  return Object.freeze({
    key: value.key,
    ...(value.text === undefined ? {} : { text: sanitizeTerminalText(value.text) }),
    ctrl: value.ctrl === true,
    alt: value.alt === true,
    shift: value.shift === true,
  });
}

/** Owns one generation-bound component without exposing terminal resources. */
export class RuntimeUiComponentMount<T = void> {
  #component: RuntimeUiComponent | undefined;
  readonly #signal: AbortSignal;
  readonly #generationSignal: AbortSignal;
  readonly #closeController: AbortController;
  readonly #onClose: ((value: T | undefined, reason: "component" | "generation" | "owner") => void) | undefined;
  readonly #onError: ((error: Error) => void) | undefined;
  readonly #onGenerationAbort: () => void;
  #closed = false;
  #disposed = false;

  private constructor(
    component: RuntimeUiComponent | undefined,
    closeController: AbortController,
    signal: AbortSignal,
    generationSignal: AbortSignal,
    options: RuntimeUiComponentMountOptions<T>,
    onGenerationAbort: () => void,
  ) {
    this.#component = component;
    this.#closeController = closeController;
    this.#signal = signal;
    this.#generationSignal = generationSignal;
    this.#onClose = options.onClose;
    this.#onError = options.onError;
    this.#onGenerationAbort = onGenerationAbort;
  }

  static create<T = void>(factory: RuntimeUiComponentFactory<T>, options: RuntimeUiComponentMountOptions<T>): RuntimeUiComponentMount<T> {
    options.signal.throwIfAborted();
    const closeController = new AbortController();
    const signal = AbortSignal.any([options.signal, closeController.signal]);
    let mount: RuntimeUiComponentMount<T> | undefined;
    let pendingClose: T | undefined;
    let closeRequested = false;
    const onGenerationAbort = () => {
      if (mount !== undefined) mount.#finish(undefined, "generation");
    };
    const host: RuntimeUiComponentHost<T> = Object.freeze({
      signal,
      requestRender: () => {
        if (mount === undefined || mount.#closed) return;
        try {
          options.requestRender();
        } catch (cause) {
          reportError(options.onError, cause);
        }
      },
      close: (value: T) => {
        if (mount === undefined) {
          pendingClose = value;
          closeRequested = true;
        } else mount.#finish(value, "component");
      },
    });
    let result: RuntimeUiComponent | Promise<RuntimeUiComponent>;
    try {
      result = factory(host);
    } catch (cause) {
      closeController.abort(error(cause));
      throw cause;
    }
    const pending = result instanceof Promise || (
      result !== null && typeof result === "object" && typeof (result as unknown as PromiseLike<unknown>).then === "function"
    );
    if (!pending && !runtimeUiComponent(result)) {
      closeController.abort(new TypeError("Runtime UI component factory must return a component with render()"));
      throw new TypeError("Runtime UI component factory must return a component with render()");
    }
    mount = new RuntimeUiComponentMount(
      pending ? undefined : result as RuntimeUiComponent,
      closeController,
      signal,
      options.signal,
      options,
      onGenerationAbort,
    );
    options.signal.addEventListener("abort", onGenerationAbort, { once: true });
    if (options.signal.aborted) onGenerationAbort();
    else if (closeRequested) mount.#finish(pendingClose, "component");
    if (pending) {
      void Promise.resolve(result).then((component) => {
        if (!runtimeUiComponent(component)) {
          throw new TypeError("Runtime UI component factory must return a component with render()");
        }
        if (mount!.#closed) {
          try { component.dispose?.(); } catch (cause) { reportError(options.onError, cause); }
          return;
        }
        mount!.#component = component;
        try { options.requestRender(); } catch (cause) { reportError(options.onError, cause); }
      }).catch((cause: unknown) => {
        reportError(options.onError, cause);
        if (mount !== undefined) mount.#finish(undefined, "owner");
      });
    }
    return mount;
  }

  get signal(): AbortSignal {
    return this.#signal;
  }

  get closed(): boolean {
    return this.#closed;
  }

  render(context: RuntimeUiRenderContext, limits: Omit<RuntimeUiBlockLimits, "width"> = {}): RuntimeUiRenderResult {
    if (this.#closed) return { ok: false, error: new Error("Runtime UI component is closed") };
    if (this.#component === undefined) return { ok: true, block: Object.freeze({ lines: Object.freeze([]) }) };
    try {
      const selected = sanitizeRuntimeUiRenderContext(context);
      const block = sanitizeRuntimeUiBlock(this.#component.render(selected), { ...limits, width: selected.width });
      return { ok: true, block };
    } catch (cause) {
      const selected = error(cause);
      reportError(this.#onError, selected);
      return { ok: false, error: selected };
    }
  }

  handleKey(event: KeyEvent): boolean {
    if (this.#closed || this.#component?.handleKey === undefined) return false;
    try {
      return this.#component.handleKey(runtimeUiKeyEvent(event)) === true;
    } catch (cause) {
      reportError(this.#onError, cause);
      return false;
    }
  }

  invalidate(): void {
    if (this.#closed || this.#component?.invalidate === undefined) return;
    try {
      this.#component.invalidate();
    } catch (cause) {
      reportError(this.#onError, cause);
    }
  }

  close(): void {
    this.#finish(undefined, "owner");
  }

  #finish(value: T | undefined, reason: "component" | "generation" | "owner"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeController.abort(new Error(reason === "generation" ? "Runtime UI generation ended" : "Runtime UI component closed"));
    this.#generationSignal.removeEventListener("abort", this.#onGenerationAbort);
    this.#dispose();
    try {
      this.#onClose?.(value, reason);
    } catch (cause) {
      reportError(this.#onError, cause);
    }
  }

  #dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      this.#component?.dispose?.();
    } catch (cause) {
      reportError(this.#onError, cause);
    }
  }
}

function runtimeUiComponent(value: unknown): value is RuntimeUiComponent {
  return value !== null && typeof value === "object" && typeof (value as RuntimeUiComponent).render === "function";
}
