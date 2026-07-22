import { CURSOR_MARKER, visibleWidth, type Component } from "@rigyn/terminal";
import type { TuiRawBlock } from "./types.js";

const DEFAULT_MAX_LINES = 128;
const DEFAULT_MAX_BYTES = 256 * 1024;

export interface RawComponentMountOptions<T> {
  signal: AbortSignal;
  requestRender(): void;
  onClose?(value: T | undefined, reason: "component" | "generation" | "owner"): void;
  onError?(error: Error): void;
}

function error(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function report(callback: ((cause: Error) => void) | undefined, cause: unknown): void {
  try { callback?.(error(cause)); } catch {}
}

/** Owns one trusted raw component while the host remains the sole terminal renderer. */
export class RawComponentMount<T = void> {
  #component: (Component & { dispose?(): void }) | undefined;
  readonly #generationSignal: AbortSignal;
  readonly #closeController = new AbortController();
  readonly #onClose: RawComponentMountOptions<T>["onClose"];
  readonly #onError: RawComponentMountOptions<T>["onError"];
  readonly #onGenerationAbort: () => void;
  #closed = false;
  #disposed = false;

  constructor(
    component: (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
    options: RawComponentMountOptions<T>,
  ) {
    options.signal.throwIfAborted();
    this.#generationSignal = options.signal;
    this.#onClose = options.onClose;
    this.#onError = options.onError;
    this.#onGenerationAbort = () => this.#finish(undefined, "generation");
    options.signal.addEventListener("abort", this.#onGenerationAbort, { once: true });
    if (component instanceof Promise || (component !== null && typeof component === "object" && "then" in component)) {
      void Promise.resolve(component).then((resolved) => {
        if (!this.#valid(resolved)) throw new TypeError("Raw UI component must provide render() and invalidate()");
        if (this.#closed) {
          try { resolved.dispose?.(); } catch (cause) { report(this.#onError, cause); }
          return;
        }
        this.#component = resolved;
        options.requestRender();
      }).catch((cause: unknown) => {
        report(this.#onError, cause);
        this.#finish(undefined, "owner");
      });
    } else {
      if (!this.#valid(component)) throw new TypeError("Raw UI component must provide render() and invalidate()");
      this.#component = component;
    }
  }

  get signal(): AbortSignal {
    return AbortSignal.any([this.#generationSignal, this.#closeController.signal]);
  }

  get component(): Component | undefined { return this.#component; }
  get closed(): boolean { return this.#closed; }

  render(width: number, maximumLines = DEFAULT_MAX_LINES, maximumBytes = DEFAULT_MAX_BYTES):
    | { ok: true; block: TuiRawBlock }
    | { ok: false; error: Error } {
    if (this.#closed) return { ok: false, error: new Error("Raw UI component is closed") };
    if (this.#component === undefined) return { ok: true, block: Object.freeze({ lines: Object.freeze([]) }) };
    try {
      if (!Number.isSafeInteger(width) || width < 1) throw new RangeError("Raw UI width must be a positive safe integer");
      const rendered = this.#component.render(width);
      if (!Array.isArray(rendered)) throw new TypeError("Raw UI render() must return an array of strings");
      if (rendered.length > maximumLines) throw new RangeError(`Raw UI component exceeds ${maximumLines} lines`);
      let bytes = 0;
      let cursor: TuiRawBlock["cursor"];
      const lines = rendered.map((value, row) => {
        if (typeof value !== "string") throw new TypeError("Raw UI render() must return an array of strings");
        bytes += Buffer.byteLength(value, "utf8");
        if (bytes > maximumBytes) throw new RangeError(`Raw UI component exceeds ${maximumBytes} bytes`);
        const marker = value.indexOf(CURSOR_MARKER);
        if (marker >= 0 && cursor === undefined) cursor = { row, column: visibleWidth(value.slice(0, marker)) };
        return value.replaceAll(CURSOR_MARKER, "");
      });
      return {
        ok: true,
        block: Object.freeze({
          lines: Object.freeze(lines),
          ...(cursor === undefined ? {} : { cursor: Object.freeze(cursor) }),
        }),
      };
    } catch (cause) {
      const selected = error(cause);
      report(this.#onError, selected);
      return { ok: false, error: selected };
    }
  }

  handleInput(data: string): boolean {
    if (this.#closed || this.#component?.handleInput === undefined) return false;
    try {
      this.#component.handleInput(data);
      return true;
    } catch (cause) {
      report(this.#onError, cause);
      return false;
    }
  }

  invalidate(): void {
    if (this.#closed || this.#component === undefined) return;
    try { this.#component.invalidate(); } catch (cause) { report(this.#onError, cause); }
  }

  close(value?: T): void { this.#finish(value, "owner"); }

  #finish(value: T | undefined, reason: "component" | "generation" | "owner"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#generationSignal.removeEventListener("abort", this.#onGenerationAbort);
    this.#closeController.abort(new Error(reason === "generation" ? "Raw UI generation ended" : "Raw UI component closed"));
    this.#dispose();
    try { this.#onClose?.(value, reason); } catch (cause) { report(this.#onError, cause); }
  }

  #dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    try { this.#component?.dispose?.(); } catch (cause) { report(this.#onError, cause); }
  }

  #valid(value: unknown): value is Component & { dispose?(): void } {
    return value !== null && typeof value === "object"
      && typeof (value as Component).render === "function"
      && typeof (value as Component).invalidate === "function";
  }
}
