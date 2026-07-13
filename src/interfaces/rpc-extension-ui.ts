import { randomBytes } from "node:crypto";

import type {
  RuntimeCommandUi,
  RuntimeInitialUiOperation,
  RuntimeUiNoticeKind,
  RuntimeUiThemeSnapshot,
} from "../extensions/runtime.js";

const EXTENSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const RESOURCE_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;

export const RPC_EXTENSION_UI_LIMITS = {
  maxPendingPerPeer: 64,
  maxOptions: 256,
  maxPromptBytes: 16 * 1024,
  maxOptionLabelBytes: 4 * 1024,
  maxOptionDetailBytes: 8 * 1024,
  maxNotificationBytes: 64 * 1024,
  maxStatusBytes: 8 * 1024,
  maxWidgetBytes: 256 * 1024,
  maxHeaderBytes: 64 * 1024,
  maxFooterBytes: 64 * 1024,
  maxTitleBytes: 1024,
  maxThemeNameBytes: 256,
  maxInputBytes: 64 * 1024,
  maxEditorBytes: 1024 * 1024,
  defaultTimeoutMs: 5 * 60 * 1_000,
  maxTimeoutMs: 15 * 60 * 1_000,
} as const;

export interface RpcExtensionUiSelectOption {
  id: string;
  label: string;
  detail?: string;
}

interface RpcExtensionUiBaseRequest {
  id: string;
  extensionId: string;
}

export type RpcExtensionUiRequest =
  | (RpcExtensionUiBaseRequest & {
      method: "select";
      prompt: string;
      options: RpcExtensionUiSelectOption[];
      timeoutMs: number;
    })
  | (RpcExtensionUiBaseRequest & {
      method: "confirm";
      title: string;
      message: string;
      timeoutMs: number;
    })
  | (RpcExtensionUiBaseRequest & {
      method: "input";
      title: string;
      placeholder?: string;
      timeoutMs: number;
    })
  | (RpcExtensionUiBaseRequest & {
      method: "editor";
      title: string;
      prefill?: string;
      timeoutMs: number;
    })
  | (RpcExtensionUiBaseRequest & {
      method: "theme_get";
      timeoutMs: number;
    })
  | (RpcExtensionUiBaseRequest & {
      method: "theme_set";
      name: string;
      timeoutMs: number;
    })
  | (RpcExtensionUiBaseRequest & {
      method: "notify";
      message: string;
      noticeKind: RuntimeUiNoticeKind;
    })
  | (RpcExtensionUiBaseRequest & {
      method: "status";
      key: string;
      value?: string;
    })
  | (RpcExtensionUiBaseRequest & {
      method: "widget";
      key: string;
      value?: string;
    })
  | (RpcExtensionUiBaseRequest & {
      method: "header";
      key: string;
      value?: string;
    })
  | (RpcExtensionUiBaseRequest & {
      method: "footer";
      key: string;
      value?: string;
    })
  | (RpcExtensionUiBaseRequest & {
      method: "title";
      value: string;
    })
  | (RpcExtensionUiBaseRequest & {
      method: "working_message";
      value?: string;
    })
  | (RpcExtensionUiBaseRequest & {
      method: "working_visible";
      visible?: boolean;
    })
  | (RpcExtensionUiBaseRequest & {
      method: "editor_text";
      value: string;
    });

export type RpcExtensionUiResponse =
  | { id: string; cancelled: true }
  | { id: string; value: string }
  | { id: string; confirmed: boolean };

export interface RuntimeRpcCommandUi extends RuntimeCommandUi {
  confirm(title: string, message: string, signal?: AbortSignal): Promise<boolean>;
  input(title: string, placeholder?: string, signal?: AbortSignal): Promise<string | undefined>;
  editor(title: string, prefill?: string, signal?: AbortSignal): Promise<string | undefined>;
  setEditorText(value: string): void;
  getEditorText(): string;
}

export interface RpcExtensionUiBridgeOptions {
  emit(peerId: string, request: RpcExtensionUiRequest): Promise<void>;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxPendingPerPeer?: number;
}

interface PendingRequest {
  peerId: string;
  complete(response: RpcExtensionUiResponse): void;
  reject(error: Error): void;
}

interface ContextOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function bounded(value: string, label: string, maximum: number, allowEmpty = true): string {
  if ((!allowEmpty && value.length === 0) || value.includes("\0") || Buffer.byteLength(value) > maximum) {
    throw new Error(`${label} is invalid or exceeds ${maximum} bytes`);
  }
  return value;
}

function requestId(): string {
  return `extension_ui_${randomBytes(16).toString("hex")}`;
}

function abortError(reason: unknown, fallback: string): Error {
  if (reason instanceof Error) return reason;
  const value = new Error(fallback);
  value.name = "AbortError";
  return value;
}

function timeoutError(): Error {
  const value = new Error("Extension UI request timed out");
  value.name = "TimeoutError";
  return value;
}

class CancelledSelectionError extends Error {
  constructor() {
    super("Extension selection cancelled");
    this.name = "AbortError";
  }
}

function own(record: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function validateExtensionId(value: string): string {
  if (!EXTENSION_ID.test(value)) throw new Error("Extension ID is invalid");
  return value;
}

function validateResourceKey(value: string): string {
  if (!RESOURCE_KEY.test(value)) throw new Error("Extension UI resource key is invalid");
  return value;
}

function validateNoticeKind(value: RuntimeUiNoticeKind): RuntimeUiNoticeKind {
  if (value !== "status" && value !== "warning" && value !== "error") {
    throw new Error("Extension notification kind is invalid");
  }
  return value;
}

function validateTimeout(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Extension UI timeout must be between 1 and ${maximum} milliseconds`);
  }
  return value;
}

function parseThemeSnapshot(value: string): RuntimeUiThemeSnapshot {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { throw new Error("Extension theme response must be JSON"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Extension theme response is invalid");
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["name", "available"].includes(key))
    || typeof record.name !== "string" || !Array.isArray(record.available) || record.available.length > 256) {
    throw new Error("Extension theme response is invalid");
  }
  const name = bounded(record.name, "Extension theme name", RPC_EXTENSION_UI_LIMITS.maxThemeNameBytes, false);
  const available = record.available.map((item) => bounded(
    typeof item === "string" ? item : "",
    "Extension available theme",
    RPC_EXTENSION_UI_LIMITS.maxThemeNameBytes,
    false,
  ));
  if (!available.includes(name)) throw new Error("Extension theme response does not include the selected theme");
  return { name, available };
}

export function parseRpcExtensionUiResponse(value: unknown): RpcExtensionUiResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Extension UI response must be an object");
  }
  const input = value as Record<string, unknown>;
  const id = bounded(typeof input.id === "string" ? input.id : "", "Extension UI request ID", 256, false);
  const fields = ["cancelled", "value", "confirmed"].filter((field) => own(input, field));
  if (fields.length !== 1) throw new Error("Extension UI response must contain exactly one result");
  if (fields[0] === "cancelled") {
    if (input.cancelled !== true) throw new Error("cancelled must be true");
    return { id, cancelled: true };
  }
  if (fields[0] === "confirmed") {
    if (typeof input.confirmed !== "boolean") throw new Error("confirmed must be a boolean");
    return { id, confirmed: input.confirmed };
  }
  if (typeof input.value !== "string") throw new Error("value must be a string");
  return { id, value: bounded(input.value, "Extension UI response value", RPC_EXTENSION_UI_LIMITS.maxEditorBytes) };
}

export class RpcExtensionUiBridge {
  readonly #emit: RpcExtensionUiBridgeOptions["emit"];
  readonly #defaultTimeoutMs: number;
  readonly #maxTimeoutMs: number;
  readonly #maxPendingPerPeer: number;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #editorText = new Map<string, string>();
  #closed = false;

  constructor(options: RpcExtensionUiBridgeOptions) {
    this.#emit = options.emit;
    this.#maxTimeoutMs = validateTimeout(
      options.maxTimeoutMs ?? RPC_EXTENSION_UI_LIMITS.maxTimeoutMs,
      RPC_EXTENSION_UI_LIMITS.maxTimeoutMs,
    );
    this.#defaultTimeoutMs = validateTimeout(
      options.defaultTimeoutMs ?? RPC_EXTENSION_UI_LIMITS.defaultTimeoutMs,
      this.#maxTimeoutMs,
    );
    this.#maxPendingPerPeer = options.maxPendingPerPeer ?? RPC_EXTENSION_UI_LIMITS.maxPendingPerPeer;
    if (!Number.isSafeInteger(this.#maxPendingPerPeer) || this.#maxPendingPerPeer < 1 || this.#maxPendingPerPeer > 1_024) {
      throw new Error("Extension UI pending request limit is invalid");
    }
  }

  context(peerId: string, extensionId: string, options: ContextOptions = {}): RuntimeRpcCommandUi {
    this.#assertOpen();
    bounded(peerId, "RPC peer ID", 256, false);
    validateExtensionId(extensionId);
    const timeoutMs = validateTimeout(options.timeoutMs ?? this.#defaultTimeoutMs, this.#maxTimeoutMs);
    const current = (): void => {
      this.#assertOpen();
      options.signal?.throwIfAborted();
    };
    const signals = (signal?: AbortSignal): AbortSignal[] => [options.signal, signal].filter(
      (value): value is AbortSignal => value !== undefined,
    );
    return {
      notify: (message, kind = "status") => {
        current();
        this.#send(peerId, {
          id: requestId(),
          extensionId,
          method: "notify",
          message: bounded(message, "Extension notification", RPC_EXTENSION_UI_LIMITS.maxNotificationBytes),
          noticeKind: validateNoticeKind(kind),
        });
      },
      setStatus: (key, value) => {
        current();
        this.#send(peerId, {
          id: requestId(),
          extensionId,
          method: "status",
          key: validateResourceKey(key),
          ...(value === undefined || value === "" ? {} : {
            value: bounded(value, "Extension status", RPC_EXTENSION_UI_LIMITS.maxStatusBytes),
          }),
        });
      },
      setWidget: (key, value) => {
        current();
        this.#send(peerId, {
          id: requestId(),
          extensionId,
          method: "widget",
          key: validateResourceKey(key),
          ...(value === undefined || value === "" ? {} : {
            value: bounded(value, "Extension widget", RPC_EXTENSION_UI_LIMITS.maxWidgetBytes),
          }),
        });
      },
      setHeader: (key, value) => {
        current();
        this.#send(peerId, {
          id: requestId(),
          extensionId,
          method: "header",
          key: validateResourceKey(key),
          ...(value === undefined || value === "" ? {} : {
            value: bounded(value, "Extension header", RPC_EXTENSION_UI_LIMITS.maxHeaderBytes),
          }),
        });
      },
      setFooter: (key, value) => {
        current();
        this.#send(peerId, {
          id: requestId(),
          extensionId,
          method: "footer",
          key: validateResourceKey(key),
          ...(value === undefined || value === "" ? {} : {
            value: bounded(value, "Extension footer", RPC_EXTENSION_UI_LIMITS.maxFooterBytes),
          }),
        });
      },
      setWorkingMessage: (value) => {
        current();
        this.#send(peerId, {
          id: requestId(), extensionId, method: "working_message",
          ...(value === undefined || value === "" ? {} : {
            value: bounded(value, "Extension working message", RPC_EXTENSION_UI_LIMITS.maxStatusBytes),
          }),
        });
      },
      setWorkingVisible: (visible) => {
        current();
        if (visible !== undefined && typeof visible !== "boolean") throw new Error("Extension working visibility must be boolean");
        this.#send(peerId, {
          id: requestId(), extensionId, method: "working_visible",
          ...(visible === undefined ? {} : { visible }),
        });
      },
      setTitle: (value) => {
        current();
        this.#send(peerId, {
          id: requestId(),
          extensionId,
          method: "title",
          value: bounded(value, "Extension title", RPC_EXTENSION_UI_LIMITS.maxTitleBytes),
        });
      },
      getTheme: async (signal) => await this.#request<RuntimeUiThemeSnapshot>(peerId, {
        id: requestId(), extensionId, method: "theme_get", timeoutMs,
      }, signals(signal), (response) => {
        if (own(response, "cancelled")) throw abortError(undefined, "Extension theme query cancelled");
        if (!own(response, "value")) throw new Error("Extension theme response must contain value");
        return parseThemeSnapshot((response as { value: string }).value);
      }),
      setTheme: async (name, signal) => await this.#request<RuntimeUiThemeSnapshot>(peerId, {
        id: requestId(), extensionId, method: "theme_set",
        name: bounded(name, "Extension theme name", RPC_EXTENSION_UI_LIMITS.maxThemeNameBytes, false),
        timeoutMs,
      }, signals(signal), (response) => {
        if (own(response, "cancelled")) throw abortError(undefined, "Extension theme selection cancelled");
        if (!own(response, "value")) throw new Error("Extension theme response must contain value");
        return parseThemeSnapshot((response as { value: string }).value);
      }),
      select: async <T>(prompt: string, choices: readonly { label: string; value: T; detail?: string }[], signal?: AbortSignal) => {
        current();
        if (choices.length < 1 || choices.length > RPC_EXTENSION_UI_LIMITS.maxOptions) {
          throw new Error(`Extension selection must contain between 1 and ${RPC_EXTENSION_UI_LIMITS.maxOptions} options`);
        }
        const optionsById = new Map<string, T>();
        const publicOptions = choices.map((choice, index): RpcExtensionUiSelectOption => {
          const id = String(index);
          optionsById.set(id, choice.value);
          return {
            id,
            label: bounded(choice.label, "Extension selection label", RPC_EXTENSION_UI_LIMITS.maxOptionLabelBytes, false),
            ...(choice.detail === undefined ? {} : {
              detail: bounded(choice.detail, "Extension selection detail", RPC_EXTENSION_UI_LIMITS.maxOptionDetailBytes),
            }),
          };
        });
        return await this.#request<T>(peerId, {
          id: requestId(),
          extensionId,
          method: "select",
          prompt: bounded(prompt, "Extension selection prompt", RPC_EXTENSION_UI_LIMITS.maxPromptBytes, false),
          options: publicOptions,
          timeoutMs,
        }, signals(signal), (response) => {
          if (own(response, "cancelled")) throw new CancelledSelectionError();
          if (!own(response, "value")) throw new Error("Extension selection response must contain an option ID");
          const selected = optionsById.get((response as { value: string }).value);
          if (selected === undefined && !optionsById.has((response as { value: string }).value)) {
            throw new Error("Extension selection response references an unknown option");
          }
          return selected as T;
        });
      },
      confirm: async (title, message, signal) => await this.#request<boolean>(peerId, {
        id: requestId(),
        extensionId,
        method: "confirm",
        title: bounded(title, "Extension confirmation title", RPC_EXTENSION_UI_LIMITS.maxPromptBytes, false),
        message: bounded(message, "Extension confirmation message", RPC_EXTENSION_UI_LIMITS.maxNotificationBytes),
        timeoutMs,
      }, signals(signal), (response) => {
        if (own(response, "cancelled")) return false;
        if (!own(response, "confirmed")) throw new Error("Extension confirmation response must contain confirmed");
        return (response as { confirmed: boolean }).confirmed;
      }),
      input: async (title, placeholder, signal) => await this.#request<string | undefined>(peerId, {
        id: requestId(),
        extensionId,
        method: "input",
        title: bounded(title, "Extension input title", RPC_EXTENSION_UI_LIMITS.maxPromptBytes, false),
        ...(placeholder === undefined ? {} : {
          placeholder: bounded(placeholder, "Extension input placeholder", RPC_EXTENSION_UI_LIMITS.maxInputBytes),
        }),
        timeoutMs,
      }, signals(signal), (response) => {
        if (own(response, "cancelled")) return undefined;
        if (!own(response, "value")) throw new Error("Extension input response must contain value");
        return bounded((response as { value: string }).value, "Extension input value", RPC_EXTENSION_UI_LIMITS.maxInputBytes);
      }),
      editor: async (title, prefill, signal) => await this.#request<string | undefined>(peerId, {
        id: requestId(),
        extensionId,
        method: "editor",
        title: bounded(title, "Extension editor title", RPC_EXTENSION_UI_LIMITS.maxPromptBytes, false),
        ...(prefill === undefined ? {} : {
          prefill: bounded(prefill, "Extension editor prefill", RPC_EXTENSION_UI_LIMITS.maxEditorBytes),
        }),
        timeoutMs,
      }, signals(signal), (response) => {
        if (own(response, "cancelled")) return undefined;
        if (!own(response, "value")) throw new Error("Extension editor response must contain value");
        return bounded((response as { value: string }).value, "Extension editor value", RPC_EXTENSION_UI_LIMITS.maxEditorBytes);
      }),
      setEditorText: (value) => {
        current();
        const validated = bounded(value, "Extension editor text", RPC_EXTENSION_UI_LIMITS.maxEditorBytes);
        this.#editorText.set(peerId, validated);
        this.#send(peerId, { id: requestId(), extensionId, method: "editor_text", value: validated });
      },
      getEditorText: () => {
        current();
        return this.#editorText.get(peerId) ?? "";
      },
      async custom<T>(): Promise<T | undefined> {
        current();
        throw new Error("Custom extension components are unavailable over RPC");
      },
      showOverlay(): never {
        current();
        throw new Error("Custom extension overlays are unavailable over RPC");
      },
    };
  }

  applyInitialOperation(peerId: string, operation: RuntimeInitialUiOperation): void {
    const ui = this.context(peerId, operation.extensionId);
    if (operation.type === "notify") ui.notify(operation.value, operation.kind);
    else if (operation.type === "title") ui.setTitle(operation.value);
    else if (operation.type === "status") ui.setStatus(operation.key ?? "default", operation.value || undefined);
    else if (operation.type === "widget") ui.setWidget(operation.key ?? "default", operation.value || undefined);
    else if (operation.type === "header") ui.setHeader(operation.key ?? "default", operation.value || undefined);
    else if (operation.type === "footer") ui.setFooter(operation.key ?? "default", operation.value || undefined);
    else if (operation.type === "working_message") ui.setWorkingMessage(operation.value || undefined);
    else ui.setWorkingVisible(operation.visible);
  }

  updateEditorText(peerId: string, value: string): void {
    this.#assertOpen();
    bounded(peerId, "RPC peer ID", 256, false);
    this.#editorText.set(peerId, bounded(value, "RPC editor text", RPC_EXTENSION_UI_LIMITS.maxEditorBytes));
  }

  editorText(peerId: string): string {
    this.#assertOpen();
    bounded(peerId, "RPC peer ID", 256, false);
    return this.#editorText.get(peerId) ?? "";
  }

  resolve(peerId: string, response: RpcExtensionUiResponse): void {
    this.#assertOpen();
    const pending = this.#pending.get(response.id);
    if (pending === undefined || pending.peerId !== peerId) throw new Error(`Unknown extension UI request ${response.id}`);
    pending.complete(response);
  }

  disconnect(peerId: string, reason = "RPC client disconnected"): void {
    for (const pending of this.#pending.values()) {
      if (pending.peerId !== peerId) continue;
      pending.reject(new Error(reason));
    }
    this.#editorText.delete(peerId);
  }

  close(reason = "RPC extension UI bridge closed"): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
    this.#editorText.clear();
  }

  pendingCount(peerId?: string): number {
    if (peerId === undefined) return this.#pending.size;
    return [...this.#pending.values()].filter((pending) => pending.peerId === peerId).length;
  }

  async #request<T>(
    peerId: string,
    request: Extract<RpcExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" | "theme_get" | "theme_set" }>,
    signals: AbortSignal[],
    parse: (response: RpcExtensionUiResponse) => T,
  ): Promise<T> {
    this.#assertOpen();
    for (const signal of signals) signal.throwIfAborted();
    if (this.pendingCount(peerId) >= this.#maxPendingPerPeer) {
      throw new Error("Too many pending extension UI requests for this RPC client");
    }
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
    const result = new Promise<T>((resolve, reject) => {
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        for (const entry of listeners) entry.signal.removeEventListener("abort", entry.listener);
        this.#pending.delete(request.id);
      };
      const fail = (cause: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      };
      const complete = (response: RpcExtensionUiResponse): void => {
        if (settled) return;
        let value: T;
        try {
          value = parse(response);
        } catch (cause) {
          if (cause instanceof CancelledSelectionError) {
            settled = true;
            cleanup();
            reject(cause);
            return;
          }
          throw cause;
        }
        settled = true;
        cleanup();
        resolve(value);
      };
      for (const signal of signals) {
        const listener = (): void => fail(abortError(signal.reason, "Extension UI request cancelled"));
        listeners.push({ signal, listener });
        signal.addEventListener("abort", listener, { once: true });
      }
      timer = setTimeout(() => fail(timeoutError()), request.timeoutMs);
      this.#pending.set(request.id, { peerId, complete, reject: fail });
    });
    let delivery: Promise<void>;
    try {
      delivery = this.#emit(peerId, request);
    } catch (cause) {
      const pending = this.#pending.get(request.id);
      pending?.reject(cause instanceof Error ? cause : new Error(String(cause)));
      return await result;
    }
    void delivery.catch((cause) => {
      const pending = this.#pending.get(request.id);
      pending?.reject(cause instanceof Error ? cause : new Error(String(cause)));
    });
    return await result;
  }

  #send(peerId: string, request: RpcExtensionUiRequest): void {
    this.#assertOpen();
    try {
      void this.#emit(peerId, request).catch(() => this.disconnect(peerId, "RPC extension UI delivery failed"));
    } catch {
      this.disconnect(peerId, "RPC extension UI delivery failed");
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("RPC extension UI bridge is closed");
  }
}
