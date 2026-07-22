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

/** Bridges trusted extension dialogs to the RPC host's request/response records. */
export class RpcExtensionUiBridge {
  readonly #emit: RpcExtensionUiBridgeOptions["emit"];
  readonly #pending = new Map<string, PendingRequest>();
  #editorText = "";
  #closed = false;

  constructor(options: RpcExtensionUiBridgeOptions) {
    this.#emit = options.emit;
  }

  get pendingCount(): number { return this.#pending.size; }

  context(_extensionId: string, signal: AbortSignal): RuntimeDirectUiContext {
    const emit = (request: RpcExtensionUiRequest): void => {
      if (this.#closed) return;
      void Promise.resolve(this.#emit(request)).catch(() => undefined);
    };
    const dialog = <T>(
      options: RuntimeDirectUiDialogOptions | undefined,
      fallback: T,
      request: RpcExtensionUiRequestBody,
      parse: (response: RpcExtensionUiResponse) => T,
    ): Promise<T> => {
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
        if (options?.timeout !== undefined) timer = setTimeout(cancel, options.timeout);
        this.#pending.set(id, {
          complete(response) {
            cleanup();
            resolve(parse(response));
          },
          cancel,
        });
        emit({ type: "extension_ui_request", id, ...request } as RpcExtensionUiRequest);
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
        emit({ type: "extension_ui_request", id: randomUUID(), method: "notify", message, ...(type === undefined ? {} : { notifyType: type }) });
      },
      onTerminalInput() { return () => undefined; },
      setStatus(key, text) {
        emit({ type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey: key, statusText: text });
      },
      setWorkingMessage() {},
      setWorkingVisible() {},
      setWorkingIndicator() {},
      setHiddenThinkingLabel() {},
      setBackground() {},
      setWidget(key, content, options) {
        if (content !== undefined && !Array.isArray(content)) return;
        emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          widgetKey: key,
          widgetLines: content as string[] | undefined,
          ...(options?.placement === undefined
            ? {}
            : { widgetPlacement: options.placement }),
        });
      },
      setFooter() {},
      setHeader() {},
      setTitle(title) {
        emit({ type: "extension_ui_request", id: randomUUID(), method: "setTitle", title });
      },
      async custom<T>(): Promise<T> { return undefined as T; },
      pasteToEditor(text) {
        this.setEditorText(text);
      },
      setEditorText: (text) => {
        this.#editorText = text;
        emit({ type: "extension_ui_request", id: randomUUID(), method: "set_editor_text", text });
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
  }
}
