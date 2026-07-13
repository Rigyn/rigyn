import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";

import type { EventEnvelope } from "../core/events.js";
import { decodeRpcLines, RpcWriter, type RpcId } from "./rpc.js";
import type {
  RpcMethod,
  RpcMethodParams,
  RpcMethodResult,
  RpcNotification,
  RpcNotificationMap,
  RpcNotificationParams,
} from "./rpc-protocol.js";

export interface RpcClientOptions {
  input: AsyncIterable<string | Uint8Array>;
  output: NodeJS.WritableStream;
  maxLineBytes?: number;
  maxQueuedOutputBytes?: number;
  closeTransport?: () => void | Promise<void>;
  onError?: (error: Error) => void;
}

export interface RpcRequestOptions {
  signal?: AbortSignal;
}

export class RpcRemoteError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcRemoteError";
    this.code = code;
    this.data = data;
  }
}

export class RpcClientClosedError extends Error {
  constructor(message = "RPC client is closed", options?: ErrorOptions) {
    super(message, options);
    this.name = "RpcClientClosedError";
  }
}

export class RpcClientProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RpcClientProtocolError";
  }
}

type NotificationListener<K extends RpcNotification> = (
  params: RpcNotificationParams<K>,
) => void | Promise<void>;

type AnyNotificationListener = (method: string, params: unknown) => void | Promise<void>;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

export interface RpcEventSubscription {
  readonly subscriptionId: string;
  readonly replayedThrough: number;
  unsubscribe(): Promise<void>;
}

export interface RpcEventSubscriptionOptions extends RpcRequestOptions {
  onError?: (error: Error) => void;
}

function error(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(value === undefined ? fallback : String(value));
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const selected = new Error("RPC request was aborted");
  selected.name = "AbortError";
  return selected;
}

function own(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function responseId(value: unknown): RpcId {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new RpcClientProtocolError("RPC response has an invalid ID");
}

function remoteError(value: unknown): RpcRemoteError {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RpcClientProtocolError("RPC error response is invalid");
  }
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.code) || typeof record.message !== "string") {
    throw new RpcClientProtocolError("RPC error response is invalid");
  }
  return new RpcRemoteError(record.code as number, record.message, record.data);
}

export class RpcClient {
  readonly #writer: RpcWriter;
  readonly #maxLineBytes: number | undefined;
  readonly #closeTransport: (() => void | Promise<void>) | undefined;
  readonly #onError: ((error: Error) => void) | undefined;
  readonly #pending = new Map<RpcId, PendingRequest>();
  readonly #ignoredIds = new Set<RpcId>();
  readonly #listeners = new Map<string, Set<(params: unknown) => void | Promise<void>>>();
  readonly #anyListeners = new Set<AnyNotificationListener>();
  readonly #closedPromise: Promise<Error>;
  #resolveClosed!: (reason: Error) => void;
  #nextId = 1;
  #closedReason: Error | undefined;
  #transportClosing: Promise<void> | undefined;

  constructor(options: RpcClientOptions) {
    if (options.maxLineBytes !== undefined && (!Number.isSafeInteger(options.maxLineBytes) || options.maxLineBytes < 1)) {
      throw new RangeError("RPC client maximum line size must be a positive safe integer");
    }
    if (
      options.maxQueuedOutputBytes !== undefined &&
      (!Number.isSafeInteger(options.maxQueuedOutputBytes) || options.maxQueuedOutputBytes < 1)
    ) {
      throw new RangeError("RPC client output queue size must be a positive safe integer");
    }
    this.#writer = new RpcWriter(options.output, options.maxQueuedOutputBytes);
    this.#maxLineBytes = options.maxLineBytes;
    this.#closeTransport = options.closeTransport;
    this.#onError = options.onError;
    this.#closedPromise = new Promise<Error>((resolve) => { this.#resolveClosed = resolve; });
    void this.#read(options.input);
  }

  get closed(): boolean {
    return this.#closedReason !== undefined;
  }

  get pendingRequestCount(): number {
    return this.#pending.size;
  }

  request<K extends RpcMethod>(
    method: K,
    ...args: [RpcMethodParams<K>] extends [undefined]
      ? [options?: RpcRequestOptions]
      : undefined extends RpcMethodParams<K>
        ? [params?: Exclude<RpcMethodParams<K>, undefined>, options?: RpcRequestOptions]
        : [params: RpcMethodParams<K>, options?: RpcRequestOptions]
  ): Promise<RpcMethodResult<K>> {
    return this.#request(method, args as unknown[]) as Promise<RpcMethodResult<K>>;
  }

  onNotification<K extends RpcNotification>(method: K, listener: NotificationListener<K>): () => void {
    this.#assertOpen();
    let listeners = this.#listeners.get(method);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(method, listeners);
    }
    const selected = listener as (params: unknown) => void | Promise<void>;
    listeners.add(selected);
    return () => {
      listeners!.delete(selected);
      if (listeners!.size === 0 && this.#listeners.get(method) === listeners) this.#listeners.delete(method);
    };
  }

  onAnyNotification(listener: AnyNotificationListener): () => void {
    this.#assertOpen();
    this.#anyListeners.add(listener);
    return () => this.#anyListeners.delete(listener);
  }

  async subscribeEvents(
    params: RpcMethodParams<"events.subscribe">,
    listener: (event: EventEnvelope) => void | Promise<void>,
    options: RpcEventSubscriptionOptions = {},
  ): Promise<RpcEventSubscription> {
    options.signal?.throwIfAborted();
    let subscriptionId: string | undefined;
    const buffered: Array<RpcNotificationMap["events.event"]> = [];
    const failures: Array<RpcNotificationMap["events.error"]> = [];
    const report = (cause: unknown): void => (options.onError ?? this.#onError)?.(error(cause, "RPC event subscription failed"));
    const deliver = (event: EventEnvelope): void => {
      try {
        void Promise.resolve(listener(event)).catch(report);
      } catch (cause) {
        report(cause);
      }
    };
    const offEvent = this.onNotification("events.event", (notification) => {
      if (subscriptionId === undefined) buffered.push(notification);
      else if (notification.subscriptionId === subscriptionId) deliver(notification.event);
    });
    const offError = this.onNotification("events.error", (notification) => {
      if (subscriptionId === undefined) failures.push(notification);
      else if (notification.subscriptionId === subscriptionId) report(new Error(notification.reason));
    });
    let result: RpcMethodResult<"events.subscribe">;
    try {
      result = await this.request("events.subscribe", params, options);
    } catch (cause) {
      offEvent();
      offError();
      throw cause;
    }
    subscriptionId = result.subscriptionId;
    for (const notification of buffered) {
      if (notification.subscriptionId === subscriptionId) deliver(notification.event);
    }
    for (const notification of failures) {
      if (notification.subscriptionId === subscriptionId) report(new Error(notification.reason));
    }
    let active = true;
    return {
      subscriptionId,
      replayedThrough: result.replayedThrough,
      unsubscribe: async () => {
        if (!active) return;
        active = false;
        offEvent();
        offError();
        if (!this.closed) await this.request("events.unsubscribe", { subscriptionId: subscriptionId! });
      },
    };
  }

  waitForClose(): Promise<Error> {
    return this.#closedPromise;
  }

  async close(reason = "RPC client closed"): Promise<void> {
    this.#terminate(new RpcClientClosedError(reason));
    await this.#closeOwnedTransport();
  }

  async #request(method: RpcMethod, args: unknown[]): Promise<unknown> {
    this.#assertOpen();
    const methodHasParams = args.length > 1 || (args.length > 0 && !this.#requestOptions(args[0]));
    const params = methodHasParams ? args[0] : undefined;
    const options = (methodHasParams ? args[1] : args[0]) as RpcRequestOptions | undefined;
    options?.signal?.throwIfAborted();
    const id = this.#nextRequestId();
    let abortListener: (() => void) | undefined;
    const result = new Promise<unknown>((resolve, reject) => {
      const cleanup = (): void => {
        if (abortListener !== undefined) options?.signal?.removeEventListener("abort", abortListener);
      };
      const pending: PendingRequest = {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (cause) => {
          cleanup();
          reject(cause);
        },
        cleanup,
      };
      this.#pending.set(id, pending);
      if (options?.signal !== undefined) {
        abortListener = () => {
          if (this.#pending.delete(id)) {
            cleanup();
            this.#rememberIgnoredId(id);
            reject(abortError(options.signal!));
          }
        };
        options.signal.addEventListener("abort", abortListener, { once: true });
      }
    });
    try {
      await this.#writer.send({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      });
    } catch (cause) {
      const failure = error(cause, "RPC request could not be written");
      this.#terminate(failure);
      void this.#closeOwnedTransport();
    }
    return await result;
  }

  #requestOptions(value: unknown): value is RpcRequestOptions {
    if (value === undefined) return true;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length === 0 || (keys.length === 1 && keys[0] === "signal");
  }

  #nextRequestId(): number {
    const id = this.#nextId;
    if (id >= Number.MAX_SAFE_INTEGER) this.#nextId = 1;
    else this.#nextId += 1;
    if (this.#pending.has(id) || this.#ignoredIds.has(id)) throw new Error("RPC request ID space is exhausted");
    return id;
  }

  async #read(input: AsyncIterable<string | Uint8Array>): Promise<void> {
    try {
      const lines = this.#maxLineBytes === undefined
        ? decodeRpcLines(input)
        : decodeRpcLines(input, this.#maxLineBytes);
      for await (const line of lines) {
        if (this.closed) return;
        if (line.trim() === "") continue;
        this.#receive(line);
      }
      if (!this.closed) this.#terminate(new RpcClientClosedError("RPC input closed"));
    } catch (cause) {
      const failure = cause instanceof RpcClientProtocolError
        ? cause
        : new RpcClientProtocolError("RPC input failed", { cause });
      this.#terminate(failure);
      this.#report(failure);
    } finally {
      await this.#closeOwnedTransport();
    }
  }

  #receive(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (cause) {
      throw new RpcClientProtocolError("RPC response is not valid JSON", { cause });
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new RpcClientProtocolError("RPC response must be an object");
    }
    const record = value as Record<string, unknown>;
    if (record.jsonrpc !== "2.0") throw new RpcClientProtocolError("RPC response must use JSON-RPC 2.0");
    if (own(record, "id")) {
      if (own(record, "method")) throw new RpcClientProtocolError("RPC response cannot contain both id and method");
      const id = responseId(record.id);
      const pending = this.#pending.get(id);
      if (pending === undefined) {
        if (this.#ignoredIds.delete(id)) return;
        throw new RpcClientProtocolError(`RPC response references unknown request ID ${String(id)}`);
      }
      if (own(record, "result") === own(record, "error")) {
        throw new RpcClientProtocolError("RPC response must contain exactly one of result or error");
      }
      const failure = own(record, "error") ? remoteError(record.error) : undefined;
      this.#pending.delete(id);
      if (failure === undefined) pending.resolve(record.result);
      else pending.reject(failure);
      return;
    }
    if (typeof record.method !== "string" || record.method === "") {
      throw new RpcClientProtocolError("RPC notification method is invalid");
    }
    this.#dispatchNotification(record.method, record.params);
  }

  #dispatchNotification(method: string, params: unknown): void {
    for (const listener of this.#listeners.get(method) ?? []) this.#invokeListener(async () => await listener(params));
    for (const listener of this.#anyListeners) this.#invokeListener(async () => await listener(method, params));
  }

  #invokeListener(listener: () => void | Promise<void>): void {
    try {
      void Promise.resolve(listener()).catch((cause) => this.#report(error(cause, "RPC notification listener failed")));
    } catch (cause) {
      this.#report(error(cause, "RPC notification listener failed"));
    }
  }

  #rememberIgnoredId(id: RpcId): void {
    this.#ignoredIds.add(id);
    if (this.#ignoredIds.size > 1_024) this.#ignoredIds.delete(this.#ignoredIds.values().next().value!);
  }

  #terminate(reason: Error): void {
    if (this.#closedReason !== undefined) return;
    this.#closedReason = reason;
    for (const pending of this.#pending.values()) pending.reject(reason);
    this.#pending.clear();
    this.#listeners.clear();
    this.#anyListeners.clear();
    this.#resolveClosed(reason);
  }

  #assertOpen(): void {
    if (this.#closedReason !== undefined) throw this.#closedReason;
  }

  #report(failure: Error): void {
    try {
      this.#onError?.(failure);
    } catch {
      // A diagnostic callback cannot interfere with transport cleanup.
    }
  }

  #closeOwnedTransport(): Promise<void> {
    if (this.#closeTransport === undefined) return Promise.resolve();
    this.#transportClosing ??= Promise.resolve().then(this.#closeTransport).catch((cause) => {
      this.#report(error(cause, "RPC transport cleanup failed"));
    });
    return this.#transportClosing;
  }
}

export interface SpawnRpcClientOptions extends Omit<SpawnOptionsWithoutStdio, "stdio"> {
  command: string;
  args?: readonly string[];
  stderr?: "inherit" | "ignore" | "pipe";
  killSignal?: NodeJS.Signals;
  killTimeoutMs?: number;
  client?: Omit<RpcClientOptions, "input" | "output" | "closeTransport">;
}

export interface SpawnedRpcClient {
  client: RpcClient;
  child: ChildProcess;
}

/** Spawns and owns a newline-delimited RPC subprocess. Use args `["rpc"]` for the Rigyn CLI. */
export function spawnRpcClient(options: SpawnRpcClientOptions): SpawnedRpcClient {
  if (options.command === "" || options.command.includes("\0") || Buffer.byteLength(options.command, "utf8") > 16 * 1024) {
    throw new TypeError("RPC child command is invalid");
  }
  if (options.shell !== undefined && options.shell !== false) {
    throw new TypeError("RPC child transport requires direct executable-plus-argv spawning without a shell");
  }
  if (options.args?.some((argument) => typeof argument !== "string" || argument.includes("\0") || Buffer.byteLength(argument, "utf8") > 256 * 1024)) {
    throw new TypeError("RPC child argument is invalid");
  }
  const timeout = options.killTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 60_000) {
    throw new RangeError("RPC child kill timeout must be from 0 through 60000 milliseconds");
  }
  const {
    command,
    args = [],
    stderr = "inherit",
    killSignal = "SIGTERM",
    killTimeoutMs: _killTimeoutMs,
    client: clientOptions = {},
    ...spawnOptions
  } = options;
  const child = spawn(command, [...args], {
    ...spawnOptions,
    stdio: ["pipe", "pipe", stderr],
  });
  const closeTransport = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin?.end();
    child.kill(killSignal);
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      child.once("exit", done);
      timer = setTimeout(() => {
        child.off("exit", done);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve();
      }, timeout);
    });
  };
  const client = new RpcClient({
    ...clientOptions,
    input: child.stdout!,
    output: child.stdin!,
    closeTransport,
  });
  child.once("error", (cause) => {
    void client.close(`RPC child process failed: ${cause.message}`);
  });
  return { client, child };
}
