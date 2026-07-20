import type { RuntimeUiComponentFactory } from "./components.js";
import type { TuiEditorImplementation } from "./editor.js";
import type { Keybindings } from "./keybindings.js";
import type { KeyEvent } from "./keys.js";
import type { Theme } from "./theme.js";
import type { TerminalCapabilities, TuiAutocompleteProvider, TuiPersistentComponentSlot } from "./types.js";

export type NativeUiInputResult =
  | { action: "pass" }
  | { action: "consume" }
  | { action: "rewrite"; event: KeyEvent };

/** Runs synchronously after terminal decoding and before host keybindings. */
export type NativeUiInputHandler = (
  event: Readonly<KeyEvent>,
  signal: AbortSignal,
) => NativeUiInputResult | void;

export type NativeUiEditorWrapper = (
  previous: TuiEditorImplementation,
) => TuiEditorImplementation;

export type NativeUiAutocompleteWrapper = (
  previous: TuiAutocompleteProvider,
) => TuiAutocompleteProvider;

export type NativeUiDisposer = () => void;

export interface UnsafeTerminalInputResult {
  consume?: boolean;
  data?: string;
}

/** Raw terminal input. This deliberately permits terminal escape sequences. */
export type UnsafeTerminalInputHandler = (
  data: string,
  signal: AbortSignal,
) => UnsafeTerminalInputResult | void;

/**
 * Unrestricted terminal authority for explicitly trusted local packages.
 * Raw writes can corrupt the current frame; callers must request a redraw after
 * completing any out-of-band terminal protocol.
 */
export interface UnsafeTerminalHost {
  readonly extensionId: string;
  readonly signal: AbortSignal;
  onInput(handler: UnsafeTerminalInputHandler): NativeUiDisposer;
  write(data: string): void;
  requestRender(): void;
  size(): Readonly<{ columns: number; rows: number }>;
  capabilities(): Readonly<TerminalCapabilities>;
  keybindings(): Keybindings;
  dispose(): void;
}

/** Focused privileged surface; it intentionally does not expose the terminal controller. */
export interface NativeUiHost {
  readonly extensionId: string;
  readonly signal: AbortSignal;
  onInput(handler: NativeUiInputHandler): NativeUiDisposer;
  getEditor(): TuiEditorImplementation;
  replaceEditor(editor: TuiEditorImplementation): NativeUiDisposer;
  wrapEditor(wrapper: NativeUiEditorWrapper): NativeUiDisposer;
  mountHeader(factory: RuntimeUiComponentFactory<void>): NativeUiDisposer;
  mountFooter(factory: RuntimeUiComponentFactory<void>): NativeUiDisposer;
  mountWidget(factory: RuntimeUiComponentFactory<void>, placement?: "above" | "below"): NativeUiDisposer;
  replaceHeader(factory: RuntimeUiComponentFactory<void>): NativeUiDisposer;
  replaceFooter(factory: RuntimeUiComponentFactory<void>): NativeUiDisposer;
  currentTheme(): Theme;
  themeCatalog(): readonly Theme[];
  applyTheme(theme: Theme): NativeUiDisposer;
  pasteToEditor(value: string): void;
  wrapAutocomplete(wrapper: NativeUiAutocompleteWrapper): NativeUiDisposer;
  dispose(): void;
}

/** @internal Controller bridge used to keep the privileged surface narrow. */
export interface NativeUiControllerBridge {
  assertNativeUiAvailable(): void;
  registerNativeInputHandler(handler: NativeUiInputHandler, signal: AbortSignal): NativeUiDisposer;
  getEditorImplementation(): TuiEditorImplementation;
  replaceNativeEditor(editor: TuiEditorImplementation, signal: AbortSignal): NativeUiDisposer;
  wrapNativeEditor(wrapper: NativeUiEditorWrapper, signal: AbortSignal): NativeUiDisposer;
  setPersistentComponent(
    slot: TuiPersistentComponentSlot,
    key: string,
    factory: RuntimeUiComponentFactory<void>,
    signal: AbortSignal,
  ): void;
  currentThemeObject(): Theme;
  themeCatalogObjects(): readonly Theme[];
  applyNativeTheme(theme: Theme, signal: AbortSignal): NativeUiDisposer;
  insertClipboardText(value: string): void;
  wrapNativeAutocompleteProvider(wrapper: NativeUiAutocompleteWrapper, signal: AbortSignal): NativeUiDisposer;
  registerUnsafeTerminalInputHandler(handler: UnsafeTerminalInputHandler, signal: AbortSignal): NativeUiDisposer;
  writeUnsafeTerminal(data: string): void;
  requestUnsafeTerminalRender(): void;
  unsafeTerminalSize(): Readonly<{ columns: number; rows: number }>;
  unsafeTerminalCapabilities(): Readonly<TerminalCapabilities>;
  unsafeTerminalKeybindings(): Keybindings;
}

let hostOrdinal = 0;

class ControllerNativeUiHost implements NativeUiHost {
  readonly extensionId: string;
  readonly signal: AbortSignal;
  readonly #controller: NativeUiControllerBridge;
  readonly #closeController = new AbortController();
  readonly #keyPrefix: string;
  #componentOrdinal = 0;

  constructor(
    controller: NativeUiControllerBridge,
    extensionId: string,
    generationSignal: AbortSignal,
  ) {
    if (typeof extensionId !== "string" || extensionId.trim() === "" || Buffer.byteLength(extensionId, "utf8") > 1_024) {
      throw new Error("Native UI extension ID must contain 1 to 1024 bytes");
    }
    generationSignal.throwIfAborted();
    controller.assertNativeUiAvailable();
    this.#controller = controller;
    this.extensionId = extensionId;
    this.signal = AbortSignal.any([generationSignal, this.#closeController.signal]);
    this.#keyPrefix = `native-ui:${++hostOrdinal}`;
  }

  onInput(handler: NativeUiInputHandler): NativeUiDisposer {
    if (typeof handler !== "function") throw new TypeError("Native input handler must be a function");
    return this.#registration((signal) => this.#controller.registerNativeInputHandler(handler, signal));
  }

  getEditor(): TuiEditorImplementation {
    this.#current();
    return this.#controller.getEditorImplementation();
  }

  replaceEditor(editor: TuiEditorImplementation): NativeUiDisposer {
    return this.#registration((signal) => this.#controller.replaceNativeEditor(editor, signal));
  }

  wrapEditor(wrapper: NativeUiEditorWrapper): NativeUiDisposer {
    if (typeof wrapper !== "function") throw new TypeError("Native editor wrapper must be a function");
    return this.#registration((signal) => this.#controller.wrapNativeEditor(wrapper, signal));
  }

  mountHeader(factory: RuntimeUiComponentFactory<void>): NativeUiDisposer {
    return this.#mount("header", factory);
  }

  mountFooter(factory: RuntimeUiComponentFactory<void>): NativeUiDisposer {
    return this.#mount("footer", factory);
  }

  mountWidget(factory: RuntimeUiComponentFactory<void>, placement: "above" | "below" = "above"): NativeUiDisposer {
    if (placement !== "above" && placement !== "below") throw new TypeError("Native UI widget placement must be above or below");
    return this.#mount(placement === "above" ? "widget-above" : "widget-below", factory);
  }

  replaceHeader(factory: RuntimeUiComponentFactory<void>): NativeUiDisposer {
    return this.#mount("header-replacement", factory);
  }

  replaceFooter(factory: RuntimeUiComponentFactory<void>): NativeUiDisposer {
    return this.#mount("footer-replacement", factory);
  }

  currentTheme(): Theme {
    this.#current();
    return this.#controller.currentThemeObject();
  }

  themeCatalog(): readonly Theme[] {
    this.#current();
    return this.#controller.themeCatalogObjects();
  }

  applyTheme(theme: Theme): NativeUiDisposer {
    return this.#registration((signal) => this.#controller.applyNativeTheme(theme, signal));
  }

  pasteToEditor(value: string): void {
    this.#current();
    if (typeof value !== "string") throw new TypeError("Native editor paste must be a string");
    this.#controller.insertClipboardText(value);
  }

  wrapAutocomplete(wrapper: NativeUiAutocompleteWrapper): NativeUiDisposer {
    if (typeof wrapper !== "function") throw new TypeError("Native autocomplete wrapper must be a function");
    return this.#registration((signal) => this.#controller.wrapNativeAutocompleteProvider(wrapper, signal));
  }

  dispose(): void {
    if (!this.#closeController.signal.aborted) {
      this.#closeController.abort(new Error(`Native UI host disposed: ${this.extensionId}`));
    }
  }

  #mount(slot: TuiPersistentComponentSlot, factory: RuntimeUiComponentFactory<void>): NativeUiDisposer {
    if (typeof factory !== "function") throw new TypeError(`Native UI ${slot} factory must be a function`);
    const key = `${this.#keyPrefix}:${++this.#componentOrdinal}`;
    return this.#registration((signal) => {
      this.#controller.setPersistentComponent(slot, key, factory, signal);
      return () => undefined;
    });
  }

  #registration(install: (signal: AbortSignal) => NativeUiDisposer): NativeUiDisposer {
    this.#current();
    const registration = new AbortController();
    const signal = AbortSignal.any([this.signal, registration.signal]);
    let cleanup: NativeUiDisposer;
    try {
      cleanup = install(signal);
    } catch (cause) {
      registration.abort(cause);
      throw cause;
    }
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      registration.abort(new Error(`Native UI registration disposed: ${this.extensionId}`));
      cleanup();
    };
  }

  #current(): void {
    this.signal.throwIfAborted();
    this.#controller.assertNativeUiAvailable();
  }
}

export function createNativeUiHost(
  controller: NativeUiControllerBridge,
  extensionId: string,
  generationSignal: AbortSignal,
): NativeUiHost {
  return new ControllerNativeUiHost(controller, extensionId, generationSignal);
}

class ControllerUnsafeTerminalHost implements UnsafeTerminalHost {
  readonly extensionId: string;
  readonly signal: AbortSignal;
  readonly #controller: NativeUiControllerBridge;
  readonly #closeController = new AbortController();

  constructor(controller: NativeUiControllerBridge, extensionId: string, generationSignal: AbortSignal) {
    if (typeof extensionId !== "string" || extensionId.trim() === "" || Buffer.byteLength(extensionId, "utf8") > 1_024) {
      throw new Error("Unsafe terminal extension ID must contain 1 to 1024 bytes");
    }
    generationSignal.throwIfAborted();
    controller.assertNativeUiAvailable();
    this.#controller = controller;
    this.extensionId = extensionId;
    this.signal = AbortSignal.any([generationSignal, this.#closeController.signal]);
  }

  onInput(handler: UnsafeTerminalInputHandler): NativeUiDisposer {
    this.#current();
    if (typeof handler !== "function") throw new TypeError("Unsafe terminal input handler must be a function");
    const registration = new AbortController();
    const signal = AbortSignal.any([this.signal, registration.signal]);
    const cleanup = this.#controller.registerUnsafeTerminalInputHandler(handler, signal);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      registration.abort(new Error(`Unsafe terminal input registration disposed: ${this.extensionId}`));
      cleanup();
    };
  }

  write(data: string): void {
    this.#current();
    this.#controller.writeUnsafeTerminal(data);
  }

  requestRender(): void {
    this.#current();
    this.#controller.requestUnsafeTerminalRender();
  }

  size(): Readonly<{ columns: number; rows: number }> {
    this.#current();
    return this.#controller.unsafeTerminalSize();
  }

  capabilities(): Readonly<TerminalCapabilities> {
    this.#current();
    return this.#controller.unsafeTerminalCapabilities();
  }

  keybindings(): Keybindings {
    this.#current();
    return this.#controller.unsafeTerminalKeybindings();
  }

  dispose(): void {
    if (!this.#closeController.signal.aborted) {
      this.#closeController.abort(new Error(`Unsafe terminal host disposed: ${this.extensionId}`));
    }
  }

  #current(): void {
    this.signal.throwIfAborted();
    this.#controller.assertNativeUiAvailable();
  }
}

export function createUnsafeTerminalHost(
  controller: NativeUiControllerBridge,
  extensionId: string,
  generationSignal: AbortSignal,
): UnsafeTerminalHost {
  return new ControllerUnsafeTerminalHost(controller, extensionId, generationSignal);
}
