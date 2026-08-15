import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";

const nativeSocketErrorCodes = new Set([
  "EADDRNOTAVAIL",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_INFO",
  "UND_ERR_SOCKET",
]);

interface NativeErrorCapture {
  socket?: object;
  code?: string;
}

const activeCapture = new AsyncLocalStorage<NativeErrorCapture>();
const socketCaptures = new WeakMap<object, NativeErrorCapture>();

channel("undici:websocket:socket_error").subscribe((error) => {
  try {
    const capture = activeCapture.getStore();
    const socket = capture?.socket;
    if (
      capture === undefined
      || socket === undefined
      || capture.code !== undefined
      || socketCaptures.get(socket) !== capture
    ) return;
    const code = nativeErrorCode(error);
    if (code !== undefined) capture.code = code;
  } catch {
    // Diagnostics must never interfere with the WebSocket lifecycle.
  }
});

/** @internal Constructs one WebSocket inside a correlation scope for Undici diagnostics. */
export function createWebSocketWithNativeErrorCapture<TSocket extends object>(create: () => TSocket): TSocket {
  const capture: NativeErrorCapture = {};
  const socket = activeCapture.run(capture, create);
  capture.socket = socket;
  socketCaptures.set(socket, capture);
  return socket;
}

/** @internal Consumes the allowlisted native transport code captured for one WebSocket. */
export function consumeWebSocketNativeErrorCode(socket: object): string | undefined {
  const capture = socketCaptures.get(socket);
  if (capture === undefined) return undefined;
  socketCaptures.delete(socket);
  return capture.code;
}

/** @internal Retains only native transport codes approved for local diagnostics. */
export function safeWebSocketNativeErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && nativeSocketErrorCodes.has(value) ? value : undefined;
}

function nativeErrorCode(value: unknown): string | undefined {
  const isError = (Error as ErrorConstructor & { isError?: (candidate: unknown) => boolean }).isError;
  if (isError?.(value) !== true) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, "code");
  if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string") return undefined;
  return safeWebSocketNativeErrorCode(descriptor.value);
}
