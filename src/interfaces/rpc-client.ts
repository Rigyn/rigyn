import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { EventEnvelope } from "../core/events.js";
import { decodeRpcLines, RpcWriter, type RpcId } from "./rpc.js";
import type {
  RpcEventPage,
  RpcMethod,
  RpcMethodParams,
  RpcMethodResult,
  RpcNotification,
  RpcNotificationMap,
  RpcNotificationParams,
  RpcOversizedEvent,
  RpcThreadEventsPagedParams,
  RpcUserShellRunParams,
  RpcUserShellRunResult,
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
  readonly method: RpcMethod;
  readonly params: unknown;
  readonly eventSubscriptionHandoff?: EventSubscriptionHandoff;
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

type BufferedEventSubscriptionNotification =
  | { type: "event"; value: RpcNotificationMap["events.event"] }
  | { type: "error"; value: RpcNotificationMap["events.error"] };

interface EventSubscriptionHandoff {
  buffered: BufferedEventSubscriptionNotification[];
  bufferedBytes: number;
  subscriptionId?: string;
  overflow?: Error;
}

const eventSubscriptionCallback = new AsyncLocalStorage<object>();

export interface RpcEventSubscription {
  readonly subscriptionId: string;
  readonly replayedThrough: number;
  readonly nextCursor: number;
  readonly hasMore: boolean;
  readonly blocked?: RpcOversizedEvent;
  unsubscribe(): Promise<void>;
}

export interface RpcEventSubscriptionOptions extends RpcRequestOptions {
  onError?: (error: Error) => void;
  maxPendingEvents?: number;
  maxPendingBytes?: number;
}

export interface RpcUserShellRun {
  readonly runId: string;
  readonly result: Promise<RpcUserShellRunResult>;
  cancel(reason?: string): Promise<{ accepted: true }>;
}

export const RPC_EVENT_CLIENT_DEFAULT_MAX_PENDING_EVENTS = 1_024;
export const RPC_EVENT_CLIENT_DEFAULT_MAX_PENDING_BYTES = 8 * 1024 * 1024;
const RPC_EVENT_CLIENT_ABSOLUTE_MAX_PENDING_EVENTS = 16_384;
const RPC_EVENT_CLIENT_ABSOLUTE_MAX_PENDING_BYTES = 64 * 1024 * 1024;

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

function pendingLimit(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new RangeError(`${label} must be from 1 through ${maximum}`);
  }
  return selected;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
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
  readonly #ignoredRequests = new Map<RpcId, RpcMethod>();
  readonly #listeners = new Map<string, Set<(params: unknown) => void | Promise<void>>>();
  readonly #anyListeners = new Set<AnyNotificationListener>();
  readonly #eventSubscriptionIds = new Set<string>();
  readonly #externalEventSubscriptionIds = new Set<string>();
  readonly #pendingEventSubscriptionHandoffs = new Set<EventSubscriptionHandoff>();
  readonly #claimedEventSubscriptionHandoffs = new Map<string, EventSubscriptionHandoff>();
  readonly #unattributedEventSubscriptionNotifications = new Map<string, {
    notifications: BufferedEventSubscriptionNotification[];
    bytes: number;
  }>();
  readonly #closedPromise: Promise<Error>;
  #resolveClosed!: (reason: Error) => void;
  #nextId = 1;
  #unattributedEventSubscriptionEvents = 0;
  #unattributedEventSubscriptionBytes = 0;
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

  request(method: "thread.events", params: RpcThreadEventsPagedParams, options?: RpcRequestOptions): Promise<RpcEventPage>;
  request<K extends RpcMethod>(
    method: K,
    ...args: [RpcMethodParams<K>] extends [undefined]
      ? [options?: RpcRequestOptions]
      : undefined extends RpcMethodParams<K>
        ? [params?: Exclude<RpcMethodParams<K>, undefined>, options?: RpcRequestOptions]
        : [params: RpcMethodParams<K>, options?: RpcRequestOptions]
  ): Promise<RpcMethodResult<K>>;
  request(method: RpcMethod, ...args: unknown[]): Promise<unknown> {
    return this.#request(method, args);
  }

  currentSession(options?: RpcRequestOptions): Promise<RpcMethodResult<"session.current">> {
    return this.request("session.current", options);
  }

  newSession(
    params?: Exclude<RpcMethodParams<"session.new">, undefined>,
    options?: RpcRequestOptions,
  ): Promise<RpcMethodResult<"session.new">> {
    return this.request("session.new", params, options);
  }

  switchSession(
    params: RpcMethodParams<"session.switch">,
    options?: RpcRequestOptions,
  ): Promise<RpcMethodResult<"session.switch">> {
    return this.request("session.switch", params, options);
  }

  cloneSession(
    params?: Exclude<RpcMethodParams<"session.clone">, undefined>,
    options?: RpcRequestOptions,
  ): Promise<RpcMethodResult<"session.clone">> {
    return this.request("session.clone", params, options);
  }

  forkSession(
    params: RpcMethodParams<"session.fork">,
    options?: RpcRequestOptions,
  ): Promise<RpcMethodResult<"session.fork">> {
    return this.request("session.fork", params, options);
  }

  forkMessages(
    params: RpcMethodParams<"thread.forkMessages">,
    options?: RpcRequestOptions,
  ): Promise<RpcMethodResult<"thread.forkMessages">> {
    return this.request("thread.forkMessages", params, options);
  }

  cycleModel(
    params: RpcMethodParams<"thread.model.cycle">,
    options?: RpcRequestOptions,
  ): Promise<RpcMethodResult<"thread.model.cycle">> {
    return this.request("thread.model.cycle", params, options);
  }

  cycleThinking(
    params: RpcMethodParams<"thread.thinking.cycle">,
    options?: RpcRequestOptions,
  ): Promise<RpcMethodResult<"thread.thinking.cycle">> {
    return this.request("thread.thinking.cycle", params, options);
  }

  setAutoCompaction(
    params: RpcMethodParams<"thread.autoCompaction.set">,
    options?: RpcRequestOptions,
  ): Promise<RpcMethodResult<"thread.autoCompaction.set">> {
    return this.request("thread.autoCompaction.set", params, options);
  }

  runShell(
    params: Omit<RpcUserShellRunParams, "runId"> & { runId?: string },
    options?: RpcRequestOptions,
  ): RpcUserShellRun {
    const runId = params.runId ?? `rpc_shell_${randomBytes(16).toString("hex")}`;
    const result = this.request("shell.run", { ...params, runId }, options);
    return {
      runId,
      result,
      cancel: async (reason) => await this.request("shell.cancel", {
        runId,
        ...(reason === undefined ? {} : { reason }),
      }),
    };
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
    this.#assertOpen();
    const maxPendingEvents = pendingLimit(
      options.maxPendingEvents,
      RPC_EVENT_CLIENT_DEFAULT_MAX_PENDING_EVENTS,
      RPC_EVENT_CLIENT_ABSOLUTE_MAX_PENDING_EVENTS,
      "RPC event subscription pending event limit",
    );
    const maxPendingBytes = pendingLimit(
      options.maxPendingBytes,
      RPC_EVENT_CLIENT_DEFAULT_MAX_PENDING_BYTES,
      RPC_EVENT_CLIENT_ABSOLUTE_MAX_PENDING_BYTES,
      "RPC event subscription pending byte limit",
    );
    const handoff: EventSubscriptionHandoff = { buffered: [], bufferedBytes: 0 };
    this.#pendingEventSubscriptionHandoffs.add(handoff);
    const callbackToken = {};
    let subscriptionId: string | undefined;
    let accepting = true;
    let remoteStopped = false;
    let remoteStopRequested = false;
    let remoteOutcomePromise: Promise<{ ok: true } | { ok: false; failure: unknown }> | undefined;
    let pumpPromise: Promise<void> | undefined;
    let unsubscribePromise: Promise<void> | undefined;
    let reentrantUnsubscribePromise: Promise<void> | undefined;
    let retainedEvents = 0;
    let retainedBytes = 0;
    let bufferedBytes = 0;
    let terminalFailure: Error | undefined;
    let terminalReported = false;
    const pending: Array<{ event: EventEnvelope; bytes: number }> = [];
    const buffered: BufferedEventSubscriptionNotification[] = [];
    const report = (cause: unknown): void => {
      const failure = error(cause, "RPC event subscription failed");
      try {
        if (options.onError !== undefined) options.onError(failure);
        else this.#onError?.(failure);
      } catch {
        // A diagnostic callback cannot disrupt ordered subscription delivery.
      }
    };
    let offEvent = (): void => {};
    let offError = (): void => {};
    const detach = (): void => {
      if (!accepting) return;
      accepting = false;
      offEvent();
      offError();
    };
    const forgetSubscription = (): void => {
      if (subscriptionId !== undefined) this.#eventSubscriptionIds.delete(subscriptionId);
    };
    const remoteStop = (): void => {
      remoteStopRequested = true;
      if (remoteOutcomePromise !== undefined || subscriptionId === undefined) return;
      remoteOutcomePromise = (remoteStopped || this.closed
        ? Promise.resolve({ ok: true as const })
        : this.request("events.unsubscribe", { subscriptionId }).then(
          () => ({ ok: true as const }),
          (failure: unknown) => ({ ok: false as const, failure }),
        )).finally(forgetSubscription);
    };
    const pump = (): void => {
      if (pumpPromise !== undefined) return;
      pumpPromise = (async () => {
        while (pending.length > 0) {
          const selected = pending.shift()!;
          try {
            await eventSubscriptionCallback.run(callbackToken, async () => await listener(selected.event));
          } catch (cause) {
            report(cause);
          } finally {
            retainedEvents -= 1;
            retainedBytes -= selected.bytes;
          }
        }
        if (terminalFailure !== undefined && !terminalReported) {
          terminalReported = true;
          report(terminalFailure);
        }
      })().finally(() => {
        pumpPromise = undefined;
        if (pending.length > 0 || (terminalFailure !== undefined && !terminalReported)) pump();
      });
    };
    const stopLocally = (failure: Error): void => {
      if (terminalFailure === undefined) terminalFailure = failure;
      detach();
      remoteStop();
      pump();
    };
    const deliver = (event: EventEnvelope): void => {
      if (!accepting) return;
      const bytes = serializedBytes(event);
      if (retainedEvents >= maxPendingEvents || retainedBytes + bytes > maxPendingBytes) {
        stopLocally(new Error(
          `RPC event subscription delivery queue exceeded ${maxPendingEvents} events or ${maxPendingBytes} bytes`,
        ));
        return;
      }
      pending.push({ event, bytes });
      retainedEvents += 1;
      retainedBytes += bytes;
      pump();
    };
    const buffer = (
      notification:
        | { type: "event"; value: RpcNotificationMap["events.event"] }
        | { type: "error"; value: RpcNotificationMap["events.error"] },
    ): void => {
      if (!accepting) return;
      const bytes = serializedBytes(notification.value);
      if (buffered.length >= maxPendingEvents || bufferedBytes + bytes > maxPendingBytes) {
        stopLocally(new Error(
          `RPC event subscription handoff queue exceeded ${maxPendingEvents} notifications or ${maxPendingBytes} bytes`,
        ));
        return;
      }
      buffered.push(notification);
      bufferedBytes += bytes;
    };
    const fail = (notification: RpcNotificationMap["events.error"]): void => {
      if (!accepting) return;
      remoteStopped = true;
      detach();
      forgetSubscription();
      terminalFailure ??= new Error(notification.reason);
      pump();
    };
    offEvent = this.onNotification("events.event", (notification) => {
      if (subscriptionId !== undefined && notification.subscriptionId === subscriptionId) deliver(notification.event);
    });
    offError = this.onNotification("events.error", (notification) => {
      if (subscriptionId !== undefined && notification.subscriptionId === subscriptionId) fail(notification);
    });
    let result: RpcMethodResult<"events.subscribe">;
    try {
      result = await this.#request("events.subscribe", [params, options], handoff) as RpcMethodResult<"events.subscribe">;
    } catch (cause) {
      offEvent();
      offError();
      throw cause;
    }
    subscriptionId = result.subscriptionId;
    this.#activateEventSubscriptionHandoff(handoff, result.blocked === undefined);
    if (result.blocked !== undefined) remoteStopped = true;
    if (handoff.overflow !== undefined) stopLocally(handoff.overflow);
    else for (const notification of handoff.buffered) buffer(notification);
    for (const notification of buffered) {
      if (notification.value.subscriptionId !== subscriptionId) continue;
      if (notification.type === "event") deliver(notification.value.event);
      else fail(notification.value);
    }
    buffered.length = 0;
    bufferedBytes = 0;
    if (remoteStopRequested) remoteStop();
    return {
      subscriptionId,
      replayedThrough: result.replayedThrough,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      ...(result.blocked === undefined ? {} : { blocked: result.blocked }),
      unsubscribe: () => {
        detach();
        remoteStop();
        if (eventSubscriptionCallback.getStore() === callbackToken) {
          reentrantUnsubscribePromise ??= (async () => {
            const outcome = await remoteOutcomePromise!;
            if (!outcome.ok) throw outcome.failure;
          })();
          return reentrantUnsubscribePromise;
        }
        if (unsubscribePromise !== undefined) return unsubscribePromise;
        unsubscribePromise = (async () => {
          while (pumpPromise !== undefined) await pumpPromise;
          const outcome = await remoteOutcomePromise!;
          if (!outcome.ok) throw outcome.failure;
        })();
        return unsubscribePromise;
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

  #captureEventSubscriptionNotification(method: string, params: unknown): void {
    if (method !== "events.event" && method !== "events.error") return;
    if (params === null || typeof params !== "object" || Array.isArray(params)) return;
    const subscriptionId = (params as { subscriptionId?: unknown }).subscriptionId;
    if (typeof subscriptionId !== "string") return;
    const claimed = this.#claimedEventSubscriptionHandoffs.get(subscriptionId);
    if (claimed !== undefined) {
      const notification = method === "events.event"
        ? { type: "event" as const, value: params as RpcNotificationMap["events.event"] }
        : { type: "error" as const, value: params as RpcNotificationMap["events.error"] };
      const bytes = serializedBytes(notification.value);
      if (
        claimed.buffered.length >= RPC_EVENT_CLIENT_ABSOLUTE_MAX_PENDING_EVENTS
        || claimed.bufferedBytes + bytes > RPC_EVENT_CLIENT_ABSOLUTE_MAX_PENDING_BYTES
      ) {
        claimed.overflow ??= new Error(
          `RPC event subscription attribution queue exceeded ${RPC_EVENT_CLIENT_ABSOLUTE_MAX_PENDING_EVENTS} notifications or ${RPC_EVENT_CLIENT_ABSOLUTE_MAX_PENDING_BYTES} bytes`,
        );
      } else if (claimed.overflow === undefined) {
        claimed.buffered.push(notification);
        claimed.bufferedBytes += bytes;
      }
      return;
    }
    if (this.#eventSubscriptionIds.has(subscriptionId) || this.#externalEventSubscriptionIds.has(subscriptionId)) {
      if (method === "events.error") this.#externalEventSubscriptionIds.delete(subscriptionId);
      return;
    }
    const pending = [...this.#pendingEventSubscriptionHandoffs].filter((handoff) => handoff.overflow === undefined);
    if (pending.length === 0) return;
    const notification = method === "events.event"
      ? { type: "event" as const, value: params as RpcNotificationMap["events.event"] }
      : { type: "error" as const, value: params as RpcNotificationMap["events.error"] };
    const bytes = serializedBytes(notification.value);
    if (
      this.#unattributedEventSubscriptionEvents >= RPC_EVENT_CLIENT_ABSOLUTE_MAX_PENDING_EVENTS
      || this.#unattributedEventSubscriptionBytes + bytes > RPC_EVENT_CLIENT_ABSOLUTE_MAX_PENDING_BYTES
    ) {
      const failure = new Error(
        `RPC event subscription attribution queue exceeded ${RPC_EVENT_CLIENT_ABSOLUTE_MAX_PENDING_EVENTS} notifications or ${RPC_EVENT_CLIENT_ABSOLUTE_MAX_PENDING_BYTES} bytes`,
      );
      for (const handoff of pending) handoff.overflow = failure;
      this.#clearUnattributedEventSubscriptionNotifications();
      return;
    }
    let entry = this.#unattributedEventSubscriptionNotifications.get(subscriptionId);
    if (entry === undefined) {
      entry = { notifications: [], bytes: 0 };
      this.#unattributedEventSubscriptionNotifications.set(subscriptionId, entry);
    }
    entry.notifications.push(notification);
    entry.bytes += bytes;
    this.#unattributedEventSubscriptionEvents += 1;
    this.#unattributedEventSubscriptionBytes += bytes;
  }

  #attributeEventSubscription(
    subscriptionId: string,
    active: boolean,
    handoff?: EventSubscriptionHandoff,
  ): void {
    const entry = this.#takeUnattributedEventSubscriptionNotifications(subscriptionId);
    if (handoff === undefined) {
      if (active) this.#externalEventSubscriptionIds.add(subscriptionId);
    } else {
      this.#pendingEventSubscriptionHandoffs.delete(handoff);
      handoff.buffered = entry?.notifications ?? [];
      handoff.bufferedBytes = entry?.bytes ?? 0;
      handoff.subscriptionId = subscriptionId;
      if (active) this.#claimedEventSubscriptionHandoffs.set(subscriptionId, handoff);
    }
    if (this.#pendingEventSubscriptionHandoffs.size === 0) {
      this.#clearUnattributedEventSubscriptionNotifications();
    }
  }

  #cancelEventSubscriptionHandoff(handoff: EventSubscriptionHandoff): void {
    this.#pendingEventSubscriptionHandoffs.delete(handoff);
    if (handoff.subscriptionId !== undefined) {
      this.#claimedEventSubscriptionHandoffs.delete(handoff.subscriptionId);
    }
    if (this.#pendingEventSubscriptionHandoffs.size === 0) {
      this.#clearUnattributedEventSubscriptionNotifications();
    }
  }

  #activateEventSubscriptionHandoff(handoff: EventSubscriptionHandoff, active: boolean): void {
    if (handoff.subscriptionId === undefined) return;
    this.#claimedEventSubscriptionHandoffs.delete(handoff.subscriptionId);
    if (active && !this.closed) this.#eventSubscriptionIds.add(handoff.subscriptionId);
  }

  #takeUnattributedEventSubscriptionNotifications(subscriptionId: string): {
    notifications: BufferedEventSubscriptionNotification[];
    bytes: number;
  } | undefined {
    const entry = this.#unattributedEventSubscriptionNotifications.get(subscriptionId);
    if (entry === undefined) return undefined;
    this.#unattributedEventSubscriptionNotifications.delete(subscriptionId);
    this.#unattributedEventSubscriptionEvents -= entry.notifications.length;
    this.#unattributedEventSubscriptionBytes -= entry.bytes;
    return entry;
  }

  #clearUnattributedEventSubscriptionNotifications(): void {
    this.#unattributedEventSubscriptionNotifications.clear();
    this.#unattributedEventSubscriptionEvents = 0;
    this.#unattributedEventSubscriptionBytes = 0;
  }

  async #request(
    method: RpcMethod,
    args: unknown[],
    eventSubscriptionHandoff?: EventSubscriptionHandoff,
  ): Promise<unknown> {
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
        method,
        params,
        ...(eventSubscriptionHandoff === undefined ? {} : { eventSubscriptionHandoff }),
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (cause) => {
          cleanup();
          if (eventSubscriptionHandoff !== undefined) this.#cancelEventSubscriptionHandoff(eventSubscriptionHandoff);
          reject(cause);
        },
        cleanup,
      };
      this.#pending.set(id, pending);
      if (options?.signal !== undefined) {
        abortListener = () => {
          if (this.#pending.delete(id)) {
            this.#rememberIgnoredRequest(id, pending.method);
            pending.reject(abortError(options.signal!));
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
    if (this.#pending.has(id) || this.#ignoredRequests.has(id)) throw new Error("RPC request ID space is exhausted");
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
        const ignoredMethod = this.#ignoredRequests.get(id);
        if (ignoredMethod !== undefined) {
          this.#ignoredRequests.delete(id);
          this.#handleIgnoredResponse(ignoredMethod, record);
          return;
        }
        throw new RpcClientProtocolError(`RPC response references unknown request ID ${String(id)}`);
      }
      if (own(record, "result") === own(record, "error")) {
        throw new RpcClientProtocolError("RPC response must contain exactly one of result or error");
      }
      const failure = own(record, "error") ? remoteError(record.error) : undefined;
      if (failure === undefined && pending.method === "events.subscribe") {
        if (record.result === null || typeof record.result !== "object" || Array.isArray(record.result)) {
          throw new RpcClientProtocolError("RPC event subscription response is invalid");
        }
        const subscriptionId = (record.result as { subscriptionId?: unknown }).subscriptionId;
        if (typeof subscriptionId !== "string" || subscriptionId === "") {
          throw new RpcClientProtocolError("RPC event subscription response is invalid");
        }
        this.#attributeEventSubscription(
          subscriptionId,
          (record.result as { blocked?: unknown }).blocked === undefined,
          pending.eventSubscriptionHandoff,
        );
      }
      if (failure === undefined && pending.method === "events.unsubscribe") {
        const subscriptionId = (pending.params as { subscriptionId?: unknown } | undefined)?.subscriptionId;
        if (typeof subscriptionId === "string") {
          this.#eventSubscriptionIds.delete(subscriptionId);
          this.#externalEventSubscriptionIds.delete(subscriptionId);
        }
      }
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
    this.#captureEventSubscriptionNotification(method, params);
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

  #rememberIgnoredRequest(id: RpcId, method: RpcMethod): void {
    this.#ignoredRequests.set(id, method);
    if (this.#ignoredRequests.size > 1_024) {
      this.#ignoredRequests.delete(this.#ignoredRequests.keys().next().value!);
    }
  }

  #handleIgnoredResponse(method: RpcMethod, record: Record<string, unknown>): void {
    if (method !== "events.subscribe" || !own(record, "result") || own(record, "error")) return;
    const result = record.result;
    if (result === null || typeof result !== "object" || Array.isArray(result)) return;
    const subscriptionId = (result as { subscriptionId?: unknown }).subscriptionId;
    if (typeof subscriptionId !== "string" || subscriptionId === "") return;

    // A locally cancelled subscribe can still succeed remotely. Attribute any
    // replay notifications to that server-owned ID, then clean it up without
    // allowing its traffic to enter an unrelated helper handoff.
    this.#attributeEventSubscription(subscriptionId, true);
    void this.request("events.unsubscribe", { subscriptionId }).catch((cause) => {
      this.#report(error(cause, "Late RPC event subscription cleanup failed"));
    });
  }

  #terminate(reason: Error): void {
    if (this.#closedReason !== undefined) return;
    this.#closedReason = reason;
    for (const pending of this.#pending.values()) pending.reject(reason);
    this.#pending.clear();
    this.#ignoredRequests.clear();
    this.#listeners.clear();
    this.#anyListeners.clear();
    this.#eventSubscriptionIds.clear();
    this.#externalEventSubscriptionIds.clear();
    this.#pendingEventSubscriptionHandoffs.clear();
    this.#claimedEventSubscriptionHandoffs.clear();
    this.#clearUnattributedEventSubscriptionNotifications();
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

/** Spawns and owns a newline-delimited RPC subprocess from an explicit executable and argument vector. */
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

export interface SpawnRigynRpcClientOptions extends Omit<SpawnRpcClientOptions, "command" | "shell"> {}

/** Spawns this package's Rigyn RPC CLI through Node without relying on a shell or platform command shim. */
export function spawnRigynRpcClient(options: SpawnRigynRpcClientOptions = {}): SpawnedRpcClient {
  const { args = [], ...spawnOptions } = options;
  const entry = fileURLToPath(new URL("../../dist/bin/rigyn.js", import.meta.url));
  return spawnRpcClient({
    ...spawnOptions,
    command: process.execPath,
    args: [entry, "rpc", ...args],
    shell: false,
  });
}
