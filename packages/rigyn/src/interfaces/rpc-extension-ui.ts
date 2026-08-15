import { randomUUID } from "node:crypto";

import type { RuntimeDirectUiContext, RuntimeDirectUiDialogOptions } from "../extensions/runtime.js";
import { createTheme } from "../tui/theme.js";
import type { RpcExtensionUiRequest, RpcExtensionUiResponse } from "./rpc-protocol.js";

export type { RpcExtensionUiRequest, RpcExtensionUiResponse } from "./rpc-protocol.js";
export type RpcExtensionUIRequest = RpcExtensionUiRequest;
export type RpcExtensionUIResponse = RpcExtensionUiResponse;

type RpcExtensionUiRequestBody = RpcExtensionUiRequest extends infer T
  ? T extends RpcExtensionUiRequest ? Omit<T, "type" | "id"> : never
  : never;

export interface RpcExtensionUiBridgeOptions {
  emit(request: RpcExtensionUiRequest): void | Promise<void>;
}

interface PendingRequest {
  complete(response: RpcExtensionUiResponse): void;
  cancel(): void;
}

interface RpcPresentationOwner {
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

function validatedTimeout(options: RuntimeDirectUiDialogOptions | undefined): number | undefined {
  const timeout = options?.timeout;
  if (timeout === undefined) return undefined;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3_600_000) {
    throw new RangeError("Extension UI timeout must be from 1 through 3600000 milliseconds");
  }
  return timeout;
}

/** Bridges trusted extension dialogs to the RPC host's request/response records. */
export class RpcExtensionUiBridge {
  readonly #emit: RpcExtensionUiBridgeOptions["emit"];
  readonly #pending = new Map<string, PendingRequest>();
  readonly #statusOwners = new Map<string, RpcPresentationOwner>();
  readonly #widgetOwners = new Map<string, RpcPresentationOwner>();
  #editorText = "";
  #closed = false;

  constructor(options: RpcExtensionUiBridgeOptions) {
    this.#emit = options.emit;
  }

  get pendingCount(): number { return this.#pending.size; }

  context(ownerKey: string, signal: AbortSignal): RuntimeDirectUiContext {
    const emit = async (request: RpcExtensionUiRequest): Promise<void> => {
      if (this.#closed) throw new Error("RPC extension UI bridge is closed");
      await this.#emit(request);
    };
    const emitDetached = (request: RpcExtensionUiRequest): void => {
      void emit(request).catch(() => undefined);
    };
    const keyed = (key: string): string => `${ownerKey}:${key}`;
    const statusOwners = this.#statusOwners;
    const widgetOwners = this.#widgetOwners;
    const releaseOwner = (owners: Map<string, RpcPresentationOwner>, key: string): void => {
      const previous = owners.get(key);
      if (previous === undefined) return;
      previous.signal.removeEventListener("abort", previous.onAbort);
      owners.delete(key);
    };
    const own = (
      owners: Map<string, RpcPresentationOwner>,
      key: string,
      clear: () => void,
    ): void => {
      signal.throwIfAborted();
      releaseOwner(owners, key);
      let owner!: RpcPresentationOwner;
      const onAbort = (): void => {
        if (owners.get(key) !== owner) return;
        owners.delete(key);
        clear();
      };
      owner = { signal, onAbort };
      owners.set(key, owner);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    };
    const dialog = <T>(
      options: RuntimeDirectUiDialogOptions | undefined,
      fallback: T,
      request: RpcExtensionUiRequestBody,
      parse: (response: RpcExtensionUiResponse) => T,
    ): Promise<T> => {
      const timeout = validatedTimeout(options);
      if (this.#closed || signal.aborted || options?.signal?.aborted) return Promise.resolve(fallback);
      const id = randomUUID();
      return new Promise<T>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const combined = options?.signal === undefined ? signal : AbortSignal.any([signal, options.signal]);
        const cleanup = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          combined.removeEventListener("abort", cancel);
          this.#pending.delete(id);
        };
        const cancel = (): void => {
          cleanup();
          resolve(fallback);
        };
        combined.addEventListener("abort", cancel, { once: true });
        if (timeout !== undefined) timer = setTimeout(cancel, timeout);
        this.#pending.set(id, {
          complete(response) {
            cleanup();
            resolve(parse(response));
          },
          cancel,
        });
        void emit({ type: "extension_ui_request", id, ...request } as RpcExtensionUiRequest).catch(cancel);
      });
    };
    const mono = createTheme("mono", { color: false, unicode: true });
    const context: RuntimeDirectUiContext = {
      async select(title, options, opts) {
        return await dialog(opts, undefined, {
          method: "select",
          title,
          options,
          ...(opts?.timeout === undefined ? {} : { timeout: opts.timeout }),
        }, (response) => "value" in response ? response.value : undefined);
      },
      async confirm(title, message, opts) {
        return await dialog(opts, false, {
          method: "confirm",
          title,
          message,
          ...(opts?.timeout === undefined ? {} : { timeout: opts.timeout }),
        }, (response) => "confirmed" in response ? response.confirmed : false);
      },
      async input(title, placeholder, opts) {
        return await dialog(opts, undefined, {
          method: "input",
          title,
          ...(placeholder === undefined ? {} : { placeholder }),
          ...(opts?.timeout === undefined ? {} : { timeout: opts.timeout }),
        }, (response) => "value" in response ? response.value : undefined);
      },
      notify(message, type) {
        signal.throwIfAborted();
        emitDetached({ type: "extension_ui_request", id: randomUUID(), method: "notify", message, ...(type === undefined ? {} : { notifyType: type }) });
      },
      onTerminalInput() { return () => undefined; },
      setStatus(key, text) {
        signal.throwIfAborted();
        const statusKey = keyed(key);
        if (text === undefined) {
          releaseOwner(statusOwners, statusKey);
        } else {
          own(statusOwners, statusKey, () => emitDetached({
            type: "extension_ui_request",
            id: randomUUID(),
            method: "setStatus",
            statusKey,
            statusText: undefined,
          }));
        }
        emitDetached({ type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey, statusText: text });
      },
      setWorkingMessage() {},
      setWorkingVisible() {},
      setWorkingIndicator() {},
      setHiddenThinkingLabel() {},
      setBackground() {},
      setWidget(key, content, options) {
        signal.throwIfAborted();
        if (content !== undefined && !Array.isArray(content)) return;
        const widgetKey = keyed(key);
        if (content === undefined) {
          releaseOwner(widgetOwners, widgetKey);
        } else {
          own(widgetOwners, widgetKey, () => emitDetached({
            type: "extension_ui_request",
            id: randomUUID(),
            method: "setWidget",
            widgetKey,
            widgetLines: undefined,
          }));
        }
        emitDetached({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          widgetKey,
          widgetLines: content as string[] | undefined,
          ...(options?.placement === undefined
            ? {}
            : { widgetPlacement: options.placement }),
        });
      },
      setFooter() {},
      setHeader() {},
      setTitle(title) {
        signal.throwIfAborted();
        emitDetached({ type: "extension_ui_request", id: randomUUID(), method: "setTitle", title });
      },
      async custom<T>(): Promise<T> { return undefined as T; },
      pasteToEditor(text) {
        signal.throwIfAborted();
        this.setEditorText(text);
      },
      setEditorText: (text) => {
        signal.throwIfAborted();
        this.#editorText = text;
        emitDetached({ type: "extension_ui_request", id: randomUUID(), method: "set_editor_text", text });
      },
      getEditorText: () => this.#editorText,
      async editor(title, prefill) {
        return await dialog(undefined, undefined, {
          method: "editor",
          title,
          ...(prefill === undefined ? {} : { prefill }),
        }, (response) => "value" in response ? response.value : undefined);
      },
      addAutocompleteProvider() {},
      setEditorComponent() {},
      getEditorComponent() { return undefined; },
      theme: mono,
      getAllThemes() { return []; },
      getTheme() { return undefined; },
      setTheme() { return { success: false, error: "Theme switching is unavailable in RPC mode" }; },
      getToolsExpanded() { return false; },
      setToolsExpanded() {},
    };
    return Object.freeze(context);
  }

  handle(response: RpcExtensionUiResponse): boolean {
    const pending = this.#pending.get(response.id);
    if (pending === undefined) return false;
    pending.complete(response);
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.cancel();
    this.#pending.clear();
    for (const owner of this.#statusOwners.values()) owner.signal.removeEventListener("abort", owner.onAbort);
    for (const owner of this.#widgetOwners.values()) owner.signal.removeEventListener("abort", owner.onAbort);
    this.#statusOwners.clear();
    this.#widgetOwners.clear();
  }
}
