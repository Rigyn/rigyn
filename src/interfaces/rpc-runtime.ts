import { randomBytes } from "node:crypto";
import { defaultSecretRedactor } from "../auth/redaction.js";
import type { LoadedRuntime } from "../cli/runtime.js";
import type { AgentRunResult, QueueMode } from "../core/agent.js";
import type { EventEnvelope } from "../core/events.js";
import type { NormalizedUsage, ProviderId } from "../core/types.js";
import { normalizedContextTokens, normalizedTotalTokens } from "../core/usage.js";
import type { RuntimeInputEvent, RuntimeInputResult } from "../extensions/runtime.js";
import type { HarnessRun } from "../service/harness.js";
import { exportThreadHtml, exportThreadMarkdown } from "../service/session-transfer.js";
import { sessionExportEnvelope } from "../storage/session-export.js";
import { RIGYN_VERSION } from "../version.js";
import {
  RPC_EXTENSION_UI_LIMITS,
  RpcExtensionUiBridge,
  parseRpcExtensionUiResponse,
  type RpcExtensionUiRequest,
} from "./rpc-extension-ui.js";
import { DEFAULT_RPC_MAX_LINE_BYTES, type RpcRequest } from "./rpc.js";
import {
  RPC_ERROR_CODES,
  RPC_METHOD_NAMES,
  type RpcEventSubscriptionResult,
  type RpcExtensionCommandResult,
  type RpcMethod,
  type RpcMethodResult,
  type RpcOversizedEvent,
  type RpcQueueBlockedItem,
} from "./rpc-protocol.js";
import {
  optionalOutboundImages,
  parseQueuedRunInput,
  parseRunStartInput,
  RPC_MAX_REASONING_EFFORT_BYTES,
  RPC_RUN_START_CAPABILITY,
} from "./run-input.js";

export const RIGYN_RPC_VERSION = RIGYN_VERSION;
const RPC_MAX_TRANSFORMED_INPUT_BYTES = 1024 * 1024;
const RPC_MAX_LAST_ASSISTANT_TEXT_BYTES = 8 * 1024 * 1024;
const RPC_MAX_INLINE_EXPORT_BYTES = 2 * 1024 * 1024;
const RPC_MAX_QUEUE_RESPONSE_BYTES = DEFAULT_RPC_MAX_LINE_BYTES - 4 * 1024;
export const RPC_EVENT_PAGE_DEFAULT_LIMIT = 256;
export const RPC_EVENT_PAGE_MAX_LIMIT = 1_024;
export const RPC_EVENT_PAGE_MAX_SERIALIZED_BYTES = 8 * 1024 * 1024;
const RPC_EVENT_PAGE_METADATA_RESERVE_BYTES = 4 * 1024;
export const RPC_EVENT_MAX_SERIALIZED_BYTES =
  RPC_EVENT_PAGE_MAX_SERIALIZED_BYTES - RPC_EVENT_PAGE_METADATA_RESERVE_BYTES;
export const RPC_SUBSCRIPTION_PENDING_MAX_EVENTS = 1_024;
export const RPC_SUBSCRIPTION_PENDING_MAX_BYTES = RPC_EVENT_PAGE_MAX_SERIALIZED_BYTES;

export const RIGYN_RPC_CAPABILITIES = {
  sessions: true,
  branches: true,
  steering: true,
  followUps: true,
  queuedMessages: true,
  durableQueuedMessages: {
    persistedBeforeAcknowledgement: true,
    recoveredIdleInspection: true,
    recoveredIdleDequeue: true,
    dequeueLease: { acknowledge: "run.dequeue.ack", release: "run.dequeue.release" },
    automaticReplay: false,
    branchScoped: true,
    inspectionPagination: true,
    dequeueItemsPerCall: 1,
    maxContentResponseBytes: RPC_MAX_QUEUE_RESPONSE_BYTES,
    oversizedItemsRemainQueued: true,
  },
  events: true,
  subscriptions: true,
  eventPagination: {
    cursor: "exclusive-sequence",
    defaultLimit: RPC_EVENT_PAGE_DEFAULT_LIMIT,
    maxLimit: RPC_EVENT_PAGE_MAX_LIMIT,
    maxSerializedBytes: RPC_EVENT_PAGE_MAX_SERIALIZED_BYTES,
    maxSerializedEventBytes: RPC_EVENT_MAX_SERIALIZED_BYTES,
    oversizedSingleEvent: "blocked",
    alwaysPaged: true,
  },
  subscriptionReplay: {
    boundedBatches: true,
    snapshotAtSubscribe: true,
    defaultLimit: RPC_EVENT_PAGE_DEFAULT_LIMIT,
    maxLimit: RPC_EVENT_PAGE_MAX_LIMIT,
    maxSerializedEventBytes: RPC_EVENT_MAX_SERIALIZED_BYTES,
    oversizedSingleEvent: "events.error",
    maxPendingLiveEvents: RPC_SUBSCRIPTION_PENDING_MAX_EVENTS,
    maxPendingLiveBytes: RPC_SUBSCRIPTION_PENDING_MAX_BYTES,
    deliveryFailure: "events.error",
  },
  reconnect: true,
  manualCompaction: true,
  runtimeExtensions: {
    commands: true,
    cancellation: true,
    sessionEntries: {
      durable: true,
      branchScoped: true,
      liveSubscriptions: true,
      rawDataOnly: true,
    },
    input: {
      runStart: true,
      steer: true,
      followUp: true,
      orderedPerThread: true,
      cancellable: true,
      results: ["continue", "handled", "transform"],
      maxTransformedTextBytes: RPC_MAX_TRANSFORMED_INPUT_BYTES,
    },
  },
  extensionUi: {
    notification: "extension.ui.request",
    responseMethod: "extension.ui.respond",
    interactive: ["select", "confirm", "input", "editor", "theme_get", "theme_set"],
    presentation: ["notify", "status", "widget", "header", "footer", "working_message", "working_visible", "title", "editor_text"],
    editorState: true,
    timeout: true,
  },
  modelCatalogs: {
    durable: true,
    status: true,
    refresh: true,
    fuzzyResolution: true,
    unambiguousFuzzyResolution: true,
    thinkingShorthand: true,
  },
  providerAuth: {
    status: true,
    profiles: true,
    select: true,
    fallback: true,
    set: ["api_key", "bearer"],
    delete: true,
    remoteRevocation: "opt-in",
    cancellation: true,
  },
  runStart: RPC_RUN_START_CAPABILITY,
  runSteer: { images: RPC_RUN_START_CAPABILITY.images },
  runFollowUp: { images: RPC_RUN_START_CAPABILITY.images },
  runQueueModes: {
    values: RPC_RUN_START_CAPABILITY.queueModes,
    readable: true,
    mutableDuringRun: true,
    ownerScoped: true,
  },
  threadState: {
    state: true,
    statistics: true,
    lastAssistantText: true,
    maxLastAssistantTextBytes: RPC_MAX_LAST_ASSISTANT_TEXT_BYTES,
    runSelection: "durable-read-only",
  },
  commandDiscovery: {
    builtins: true,
    runtimeExtensions: true,
    extensionTemplates: true,
    prompts: true,
    skills: true,
    unifiedResourceCatalog: true,
  },
  threadExport: {
    formats: ["jsonl", "markdown", "html"],
    maxInlineBytes: RPC_MAX_INLINE_EXPORT_BYTES,
  },
} as const;

export interface RpcThreadUsageTokens {
  input: number;
  output: number;
  total: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface RpcThreadStatistics {
  threadId: string;
  branch: string;
  branches: number;
  messages: { system: number; user: number; assistant: number; tool: number; total: number };
  tools: { calls: number; results: number };
  runs: { total: number; completed: number; failed: number; cancelled: number; active: number };
  tokens: RpcThreadUsageTokens;
  cost?: string;
  contextUsage?: { tokens: number; contextWindow: number; percent: number };
  createdAt: string;
  updatedAt: string;
}

export interface RpcThreadState {
  threadId: string;
  branch: string;
  name?: string;
  active: boolean;
  operation: "run" | "compaction" | null;
  pendingMessageCount: number;
  recoverableMessageCount?: number;
  provider?: ProviderId;
  model?: string;
  reasoningEffort?: string;
  queueModes?: { steeringMode: QueueMode; followUpMode: QueueMode };
}

export interface RpcRuntimePeer {
  id: string;
  notification(method: string, params?: unknown): Promise<void>;
}

interface RunningOperation {
  ownerId: string;
  branch: string;
  kind: "run" | "compaction";
  selection: { provider: ProviderId; model: string; reasoningEffort?: string };
  promise: Promise<HarnessRun | AgentRunResult>;
}

interface RpcQueueLease {
  ownerId: string;
  leaseId: string;
  threadId: string;
  branch: string;
}

interface Subscription {
  id: string;
  peerId: string;
  threadId: string;
  branch: string;
  cursor: number;
  replaying: boolean;
  pendingLive: Array<{ event: EventEnvelope; bytes: number }>;
  pendingLiveBytes: number;
  deliveryRunning: boolean;
  stopReason?: { reason: string; blocked?: RpcOversizedEvent };
}

interface EventReplayPage {
  events: EventEnvelope[];
  nextSequence: number;
  hasMore: boolean;
  snapshotSequence: number;
  blocked?: RpcOversizedEvent;
}

interface ExtensionCommandOperation {
  peerId: string;
  controller: AbortController;
  settled: Promise<void>;
}

interface RpcMethodHandlerContext {
  peer: RpcRuntimePeer;
  input: Record<string, unknown>;
}

type RpcMethodHandler<K extends RpcMethod> = (
  context: RpcMethodHandlerContext,
) => RpcMethodResult<K> | Promise<RpcMethodResult<K>>;

type RpcMethodHandlerRegistry = { [K in RpcMethod]: RpcMethodHandler<K> };

const RPC_METHOD_NAME_SET: ReadonlySet<string> = new Set(RPC_METHOD_NAMES);

function isRpcMethod(value: string): value is RpcMethod {
  return RPC_METHOD_NAME_SET.has(value);
}

function params(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("params must be an object");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${label} is required`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer`);
  return value as number;
}

function optionalCursor(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("afterSequence must be a non-negative integer");
  return value as number;
}

function eventPageLimit(value: unknown): number {
  const limit = optionalNumber(value, "limit") ?? RPC_EVENT_PAGE_DEFAULT_LIMIT;
  if (limit > RPC_EVENT_PAGE_MAX_LIMIT) throw new Error(`limit must not exceed ${RPC_EVENT_PAGE_MAX_LIMIT}`);
  return limit;
}

function serializedEventBytes(event: EventEnvelope): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

function rpcEventEnvelope(envelope: EventEnvelope): EventEnvelope {
  const projected = sessionExportEnvelope(envelope);
  if (
    projected.event.type === "warning" &&
    projected.event.code === "session_export_private_event_omitted"
  ) {
    return {
      ...projected,
      event: {
        type: "warning",
        code: "rpc_private_event_omitted",
        message: "Provider-private reasoning trace omitted from RPC output",
      },
    };
  }
  return projected;
}

function oversizedEvent(event: EventEnvelope, serializedBytes: number): RpcOversizedEvent {
  return {
    reason: "event_exceeds_serialized_byte_limit",
    sequence: event.sequence,
    serializedBytes,
    maximumBytes: RPC_EVENT_MAX_SERIALIZED_BYTES,
    resumeAfterSequence: event.sequence,
  };
}

function boundedEventPage(
  page: Omit<EventReplayPage, "blocked">,
  afterSequence: number,
): EventReplayPage {
  const events: EventEnvelope[] = [];
  let retainedBytes = 0;
  let blocked: RpcOversizedEvent | undefined;
  for (const storedEvent of page.events) {
    const event = rpcEventEnvelope(storedEvent);
    const bytes = serializedEventBytes(event);
    if (bytes > RPC_EVENT_MAX_SERIALIZED_BYTES) {
      blocked = oversizedEvent(event, bytes);
      break;
    }
    const delimiterBytes = events.length === 0 ? 0 : 1;
    if (retainedBytes + delimiterBytes + bytes > RPC_EVENT_MAX_SERIALIZED_BYTES) break;
    events.push(event);
    retainedBytes += delimiterBytes + bytes;
  }
  return {
    events,
    nextSequence: events.at(-1)?.sequence ?? afterSequence,
    hasMore: page.hasMore || events.length < page.events.length,
    snapshotSequence: page.snapshotSequence,
    ...(blocked === undefined ? {} : { blocked }),
  };
}

function optionalOffset(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("offset must be a non-negative integer");
  return value as number;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function boundedText(value: unknown, label: string, maximum: number, allowEmpty = true): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.includes("\0") || Buffer.byteLength(value) > maximum) {
    throw new Error(`${label} is invalid or exceeds ${maximum} bytes`);
  }
  return value;
}

type RpcThreadExportFormat = "jsonl" | "markdown" | "html";

function threadExportFormat(value: unknown): RpcThreadExportFormat | undefined {
  if (value === undefined) return undefined;
  if (value !== "jsonl" && value !== "markdown" && value !== "html") {
    throw new Error("format must be jsonl, markdown, or html");
  }
  return value;
}

function boundedThreadExport(value: string): { content: string; bytes: number } {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > RPC_MAX_INLINE_EXPORT_BYTES) {
    throw new Error(`RPC thread export exceeds ${RPC_MAX_INLINE_EXPORT_BYTES} bytes; use the CLI export command for large sessions`);
  }
  return { content: value, bytes };
}

function queuedMessageWireBytes(value: { mode: string; text: string; images?: readonly unknown[] }): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8") + 512;
}

function queuedMessageMetadata(value: {
  mode: "steer" | "follow_up";
  text: string;
  images?: readonly { mediaType: string; data?: string; url?: string }[];
}): RpcQueueBlockedItem["item"] {
  return {
    mode: value.mode,
    textBytes: Buffer.byteLength(value.text, "utf8"),
    imageCount: value.images?.length ?? 0,
    images: (value.images ?? []).map((image) => ({
      mediaType: image.mediaType,
      source: image.data === undefined ? "url" : "embedded",
      sourceBytes: Buffer.byteLength(image.data ?? image.url ?? "", "utf8"),
    })),
  };
}

function methodNotFound(method: string): Error {
  return Object.assign(new Error(`Method not found: ${method}`), { rpcCode: RPC_ERROR_CODES.methodNotFound });
}

const USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const satisfies readonly (keyof NormalizedUsage)[];

interface RunUsage {
  usage: NormalizedUsage;
  sequence: number;
}

function addUsage(left: NormalizedUsage | undefined, right: NormalizedUsage): NormalizedUsage {
  const result: NormalizedUsage = {};
  for (const field of USAGE_FIELDS) {
    if (left?.[field] !== undefined || right[field] !== undefined) {
      result[field] = (left?.[field] ?? 0) + (right[field] ?? 0);
    }
  }
  const leftCost = left?.cost === undefined ? undefined : Number(left.cost);
  const rightCost = right.cost === undefined ? undefined : Number(right.cost);
  if (Number.isFinite(leftCost) || Number.isFinite(rightCost)) {
    result.cost = String((Number.isFinite(leftCost) ? leftCost! : 0) + (Number.isFinite(rightCost) ? rightCost! : 0));
  }
  return result;
}

function usageByRun(events: readonly EventEnvelope[]): Map<string, RunUsage> {
  const result = new Map<string, RunUsage>();
  for (const envelope of events) {
    if (envelope.event.type !== "usage") continue;
    const key = envelope.runId ?? `${envelope.threadId}:unscoped`;
    const previous = result.get(key)?.usage;
    result.set(key, {
      usage: envelope.event.semantics === "incremental"
        ? addUsage(previous, envelope.event.usage)
        : { ...envelope.event.usage },
      sequence: envelope.sequence,
    });
  }
  return result;
}

function usageTokens(usage: NormalizedUsage): RpcThreadUsageTokens {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const reasoning = usage.reasoningTokens ?? 0;
  return {
    input,
    output,
    total: normalizedTotalTokens(usage) ?? 0,
    cacheRead,
    cacheWrite,
    reasoning,
  };
}

function queueMode(value: unknown, label: string): QueueMode | undefined {
  if (value === undefined) return undefined;
  if (value !== "all" && value !== "one-at-a-time") throw new Error(`${label} must be all or one-at-a-time`);
  return value;
}

export class RpcRuntimeDispatcher {
  readonly #runtime: Pick<LoadedRuntime, "workspace" | "store" | "service" | "providers"> & Partial<Pick<LoadedRuntime, "extensions" | "runtimeExtensions" | "generationSignal" | "auth" | "network" | "setExtensionShutdownHandler">>;
  readonly #requestShutdown: (() => void) | undefined;
  readonly #extensionUi: RpcExtensionUiBridge;
  readonly #peers = new Map<string, RpcRuntimePeer>();
  readonly #running = new Map<string, RunningOperation>();
  readonly #queueLeases = new Map<string, RpcQueueLease>();
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #extensionSessions = new Map<string, string>();
  readonly #extensionCommands = new Map<string, ExtensionCommandOperation>();
  readonly #inputControllers = new Map<string, Set<AbortController>>();
  readonly #inputTails = new Map<string, Promise<void>>();
  readonly #initialExtensionUiSent = new Set<string>();
  readonly #startedAt = Date.now();
  readonly #methodHandlers: RpcMethodHandlerRegistry;
  readonly #extensionSessionUnsubscribe: (() => void) | undefined;
  #closing = false;

  constructor(options: {
    runtime: Pick<LoadedRuntime, "workspace" | "store" | "service" | "providers"> & Partial<Pick<LoadedRuntime, "extensions" | "runtimeExtensions" | "generationSignal" | "auth" | "network" | "setExtensionShutdownHandler">>;
    requestShutdown?: () => void;
  }) {
    this.#runtime = options.runtime;
    this.#requestShutdown = options.requestShutdown;
    const extensionShutdown = async (): Promise<{ accepted: boolean; message: string }> => {
      if (this.#requestShutdown === undefined) {
        return { accepted: false, message: "The RPC host does not permit extension-requested shutdown." };
      }
      setImmediate(() => this.#requestShutdown?.());
      return { accepted: true, message: "The RPC host acknowledged graceful shutdown." };
    };
    if (typeof options.runtime.setExtensionShutdownHandler === "function") {
      options.runtime.setExtensionShutdownHandler(extensionShutdown);
    } else if (typeof options.runtime.runtimeExtensions?.setShutdownHandler === "function") {
      options.runtime.runtimeExtensions.setShutdownHandler(extensionShutdown);
    }
    this.#extensionUi = new RpcExtensionUiBridge({
      emit: async (peerId, request) => await this.#emitExtensionUi(peerId, request),
    });
    this.#extensionSessionUnsubscribe = options.runtime.service.onExtensionSessionEvent(({ branch, envelope }) => {
      this.#publishSubscriptions(branch, envelope);
    });
    if (typeof options.runtime.runtimeExtensions?.setUiHandler === "function") {
      options.runtime.runtimeExtensions.setUiHandler((operation) => {
        for (const peerId of this.#peers.keys()) {
          try {
            this.#extensionUi.applyInitialOperation(peerId, operation);
          } catch {
            // An invalid extension presentation update must not break the extension event loop.
          }
        }
      });
    }
    this.#methodHandlers = this.#createMethodHandlers();
  }

  connect(peer: RpcRuntimePeer): void {
    if (this.#closing) throw new Error("RPC dispatcher is shutting down");
    if (this.#peers.has(peer.id)) return;
    this.#peers.set(peer.id, peer);
  }

  disconnect(peerId: string): void {
    this.#peers.delete(peerId);
    this.#initialExtensionUiSent.delete(peerId);
    this.#extensionUi.disconnect(peerId);
    for (const [id, subscription] of this.#subscriptions) {
      if (subscription.peerId !== peerId) continue;
      subscription.pendingLive = [];
      subscription.pendingLiveBytes = 0;
      this.#subscriptions.delete(id);
    }
    for (const [threadId, operation] of this.#running) {
      if (operation.ownerId === peerId) this.#runtime.service.cancel(threadId, "RPC client disconnected");
    }
    for (const operation of this.#extensionCommands.values()) {
      if (operation.peerId === peerId) operation.controller.abort(new Error("RPC client disconnected"));
    }
    for (const controller of this.#inputControllers.get(peerId) ?? []) {
      controller.abort(new Error("RPC client disconnected"));
    }
    this.#inputControllers.delete(peerId);
    for (const [leaseId, lease] of this.#queueLeases) {
      if (lease.ownerId !== peerId) continue;
      try { this.#runtime.service.releaseQueueLease(lease); } catch {}
      this.#queueLeases.delete(leaseId);
    }
  }

  async dispatch(peer: RpcRuntimePeer, request: RpcRequest): Promise<unknown> {
    this.connect(peer);
    const input = params(request.params);
    if (this.#closing && !["health", "run.wait"].includes(request.method)) throw new Error("RPC dispatcher is shutting down");
    if (!isRpcMethod(request.method)) throw methodNotFound(request.method);
    return await this.#invokeMethod(request.method, { peer, input });
  }

  async #invokeMethod<K extends RpcMethod>(method: K, context: RpcMethodHandlerContext): Promise<RpcMethodResult<K>> {
    return await this.#methodHandlers[method](context);
  }

  #createMethodHandlers(): RpcMethodHandlerRegistry {
    return {
      "initialize": ({ peer }) => {
        this.#sendInitialExtensionUi(peer.id);
        return {
          name: "rigyn",
          version: RIGYN_RPC_VERSION,
          capabilities: RIGYN_RPC_CAPABILITIES,
        };
      },
      "health": () => {
        return {
          status: this.#closing ? "draining" : "ok",
          version: RIGYN_RPC_VERSION,
          uptimeSeconds: Math.max(0, Math.floor((Date.now() - this.#startedAt) / 1_000)),
          clients: this.#peers.size,
          activeRuns: this.#running.size,
        };
      },
      "version": () => {
        return { name: "rigyn", version: RIGYN_RPC_VERSION };
      },
      "capabilities": () => {
        return RIGYN_RPC_CAPABILITIES;
      },
      "thread.create": async ({ input }) => {
        return await this.#runtime.service.createSession({
          ...(optionalString(input.name, "name") === undefined ? {} : { name: input.name as string }),
          ...(optionalString(input.parentThreadId, "parentThreadId") === undefined ? {} : { parentThreadId: input.parentThreadId as string }),
          ...(optionalString(input.parentRunId, "parentRunId") === undefined ? {} : { parentRunId: input.parentRunId as string }),
        });
      },
      "thread.list": () => {
        return this.#runtime.store.listThreads({ workspaceRoot: this.#runtime.workspace });
      },
      "thread.get": ({ input }) => {
        const threadId = this.#workspaceThread(requiredString(input.threadId, "threadId"));
        return {
          thread: this.#runtime.store.getThread(threadId),
          runs: this.#runtime.store.listRuns(threadId),
        };
      },
      "thread.events": ({ input }) => {
        const threadId = this.#workspaceThread(requiredString(input.threadId, "threadId"));
        const branch = optionalString(input.branch, "branch");
        const afterSequence = optionalCursor(input.afterSequence);
        const page = boundedEventPage(this.#runtime.store.listEventPage(threadId, branch, {
          afterSequence,
          limit: eventPageLimit(input.limit),
        }), afterSequence);
        return {
          events: page.events,
          nextCursor: page.nextSequence,
          hasMore: page.hasMore,
          ...(page.blocked === undefined ? {} : { blocked: page.blocked }),
        };
      },
      "thread.state": ({ input }) => {
        return this.#threadState(input);
      },
      "thread.stats": async ({ input }) => {
        return await this.#threadStatistics(input);
      },
      "thread.lastAssistantText": ({ input }) => {
        return this.#lastAssistantText(input);
      },
      "thread.fork": async ({ input }) => {
        const threadId = this.#workspaceThread(requiredString(input.threadId, "threadId"));
        const thread = this.#runtime.store.getThread(threadId);
        const fromBranch = optionalString(input.fromBranch, "fromBranch") ?? thread.defaultBranch;
        const source = thread.branches.find((entry) => entry.name === fromBranch);
        if (source === undefined) throw new Error(`Unknown branch: ${fromBranch}`);
        const result = await this.#runtime.service.navigateTree({
          threadId,
          branch: fromBranch,
          targetBranch: fromBranch,
          targetEventId: optionalString(input.atEventId, "atEventId") ?? source.headEventId ?? null,
          newBranch: requiredString(input.newBranch, "newBranch"),
          ...(this.#runtime.generationSignal === undefined ? {} : { signal: this.#runtime.generationSignal }),
        });
        if (result.cancelled) return { cancelled: true };
        if (result.branch === undefined) throw new Error("Branch navigation completed without a branch");
        return result.branch;
      },
      "thread.name": async ({ input }) => {
        return await this.#runtime.service.setSessionName({
          threadId: this.#workspaceThread(requiredString(input.threadId, "threadId")),
          name: requiredString(input.name, "name"),
        });
      },
      "thread.delete": async ({ input }) => {
        const threadId = this.#workspaceThread(requiredString(input.threadId, "threadId"));
        await this.#endExtensionSession(threadId);
        await this.#runtime.service.deleteSession(threadId);
        return { deleted: true };
      },
      "thread.export": ({ input }) => {
        const threadId = this.#workspaceThread(requiredString(input.threadId, "threadId"));
        const format = threadExportFormat(input.format);
        const branch = optionalString(input.branch, "branch");
        if (format === undefined) {
          if (branch !== undefined) throw new Error("branch requires an explicit markdown or html export format");
          return { jsonl: boundedThreadExport(this.#runtime.store.exportThread(threadId)).content };
        }
        if (format === "jsonl" && branch !== undefined) throw new Error("jsonl exports include the complete thread and do not accept branch");
        const exported = boundedThreadExport(format === "jsonl"
          ? this.#runtime.store.exportThread(threadId)
          : format === "markdown"
            ? exportThreadMarkdown(this.#runtime.store, threadId, branch)
            : exportThreadHtml(this.#runtime.store, threadId, branch));
        return { format, ...exported };
      },
      "thread.compact": async ({ peer, input }) => {
        const threadId = this.#workspaceThread(requiredString(input.threadId, "threadId"));
        if (this.#running.has(threadId)) throw new Error(`Thread already has an RPC-owned run: ${threadId}`);
        const branch = optionalString(input.branch, "branch") ?? this.#runtime.store.getThread(threadId).defaultBranch;
        const outboundImages = optionalOutboundImages(input.outboundImages);
        const provider = requiredString(input.provider, "provider");
        const model = requiredString(input.model, "model");
        const reasoningEffort = input.reasoningEffort === undefined
          ? undefined
          : boundedText(input.reasoningEffort, "reasoningEffort", RPC_MAX_REASONING_EFFORT_BYTES, false);
        await this.#ensureExtensionSession(peer, threadId, branch);
        const operation = this.#runtime.service.compact({
          threadId,
          branch,
          provider,
          model,
          ...(outboundImages === undefined ? {} : { outboundImages }),
          ...(optionalNumber(input.maxOutputTokens, "maxOutputTokens") === undefined ? {} : { maxOutputTokens: input.maxOutputTokens as number }),
          ...(optionalNumber(input.contextTokenBudget, "contextTokenBudget") === undefined ? {} : { contextTokenBudget: input.contextTokenBudget as number }),
          ...(optionalNumber(input.summaryTokenBudget, "summaryTokenBudget") === undefined ? {} : { summaryTokenBudget: input.summaryTokenBudget as number }),
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          ...(optionalString(input.instructions, "instructions") === undefined ? {} : { compactionInstructions: input.instructions as string }),
          onEvent: async (event) => {
            this.#publish(peer.id, branch, event);
            await this.#dispatchExtensionEvent(peer, event);
          },
        }).then(
          async (result) => {
            await this.#notify(peer.id, "thread.compacted", { threadId, result });
            return result;
          },
          async (error) => {
            await this.#notify(peer.id, "thread.compactionFailed", {
              threadId,
              message: defaultSecretRedactor.redact(error instanceof Error ? error.message : String(error)),
            });
            throw error;
          },
        ).finally(() => this.#running.delete(threadId));
        this.#running.set(threadId, {
          ownerId: peer.id,
          branch,
          kind: "compaction",
          selection: {
            provider,
            model,
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          },
          promise: operation,
        });
        return await operation;
      },
      "events.subscribe": ({ peer, input }) => {
        return this.#subscribe(peer, input);
      },
      "events.unsubscribe": ({ peer, input }) => {
        const subscriptionId = requiredString(input.subscriptionId, "subscriptionId");
        const subscription = this.#subscriptions.get(subscriptionId);
        if (subscription?.peerId === peer.id) {
          subscription.pendingLive = [];
          subscription.pendingLiveBytes = 0;
          this.#subscriptions.delete(subscriptionId);
        }
        return { unsubscribed: true };
      },
      "run.start": async ({ peer, input }) => {
        return await this.#startRun(peer, input);
      },
      "run.wait": async ({ peer, input }) => {
        const threadId = this.#workspaceThread(requiredString(input.threadId, "threadId"));
        const operation = this.#ownedOperation(peer, threadId);
        return await operation.promise;
      },
      "run.cancel": ({ peer, input }) => {
        const threadId = this.#workspaceThread(requiredString(input.threadId, "threadId"));
        this.#ownedOperation(peer, threadId);
        this.#runtime.service.cancel(
          threadId,
          optionalString(input.reason, "reason"),
        );
        return { accepted: true };
      },
      "run.steer": async ({ peer, input }) => {
        return await this.#queueRunInput(peer, input, "steer");
      },
      "run.followUp": async ({ peer, input }) => {
        return await this.#queueRunInput(peer, input, "follow_up");
      },
      "run.queue": ({ peer, input }) => {
        const threadId = this.#workspaceThread(requiredString(input.threadId, "threadId"));
        const operation = this.#running.get(threadId);
        if (operation !== undefined && operation.ownerId !== peer.id) throw new Error(`No RPC-owned run for ${threadId}`);
        const branch = optionalString(input.branch, "branch") ?? operation?.branch ?? this.#runtime.store.getThread(threadId).defaultBranch;
        const recoverableCount = this.#runtime.service.recoverableMessageCount(threadId, branch);
        const quarantinedCount = this.#runtime.store.quarantinedRunInputCount(threadId, branch);
        const offset = optionalOffset(input.offset);
        const limit = optionalNumber(input.limit, "limit") ?? 100;
        if (limit > 100) throw new Error("limit must not exceed 100");
        const available = this.#runtime.service.queuedMessages(threadId, branch);
        const messages: typeof available = [];
        let wireBytes = 512;
        let blocked: RpcQueueBlockedItem | undefined;
        for (const message of available.slice(offset, offset + limit)) {
          const itemBytes = queuedMessageWireBytes(message);
          if (messages.length === 0 && wireBytes + itemBytes > RPC_MAX_QUEUE_RESPONSE_BYTES) {
            blocked = {
              index: offset,
              reason: "queued item exceeds the RPC content response limit and remains queued",
              item: queuedMessageMetadata(message),
              restoreWith: "interactive CLI Alt+Up or an in-process service consumer",
            };
            break;
          }
          if (wireBytes + itemBytes > RPC_MAX_QUEUE_RESPONSE_BYTES) break;
          messages.push(message);
          wireBytes += itemBytes;
        }
        const consumed = blocked === undefined ? messages.length : 1;
        const nextOffset = offset + consumed < available.length ? offset + consumed : undefined;
        return {
          messages,
          ...(nextOffset === undefined ? {} : { nextOffset }),
          ...(blocked === undefined ? {} : { blocked }),
          ...(recoverableCount === 0
            ? {}
            : { recovery: { branch, count: recoverableCount, automaticReplay: false } }),
          ...(quarantinedCount === 0 ? {} : { quarantinedCount }),
        };
      },
      "run.dequeue": ({ peer, input }) => {
        const threadId = this.#workspaceThread(requiredString(input.threadId, "threadId"));
        const operation = this.#running.get(threadId);
        if (operation !== undefined && operation.ownerId !== peer.id) throw new Error(`No RPC-owned run for ${threadId}`);
        const branch = optionalString(input.branch, "branch") ?? operation?.branch ?? this.#runtime.store.getThread(threadId).defaultBranch;
        const recoverableCount = this.#runtime.service.recoverableMessageCount(threadId, branch);
        const next = this.#runtime.service.queuedMessages(threadId, branch)[0];
        if (next !== undefined && queuedMessageWireBytes(next) > RPC_MAX_QUEUE_RESPONSE_BYTES) {
          return {
            messages: [],
            blocked: {
              reason: "queued item exceeds the RPC content response limit and remains queued",
              item: queuedMessageMetadata(next),
              restoreWith: "interactive CLI Alt+Up or an in-process service consumer",
            },
            ...(recoverableCount === 0
              ? {}
              : { recovery: { branch, count: recoverableCount, automaticReplay: false } }),
          };
        }
        const lease = this.#runtime.service.leaseOne(threadId, branch);
        if (lease !== undefined) this.#queueLeases.set(lease.leaseId, { ownerId: peer.id, ...lease });
        const remainingRecoverable = recoverableCount > 0 && lease !== undefined
          ? recoverableCount - 1
          : recoverableCount;
        return {
          messages: lease === undefined ? [] : [lease.message],
          ...(lease === undefined ? {} : {
            lease: { id: lease.leaseId, branch: lease.branch, acknowledgeMethod: "run.dequeue.ack" },
          }),
          ...(remainingRecoverable === 0
            ? {}
            : { recovery: { branch, count: remainingRecoverable, automaticReplay: false } }),
        };
      },
      "run.dequeue.ack": ({ peer, input }) => this.#settleQueueLease(peer, input, "acknowledge"),
      "run.dequeue.release": ({ peer, input }) => this.#settleQueueLease(peer, input, "release"),
      "run.queueModes.get": ({ peer, input }) => {
        const threadId = this.#workspaceThread(requiredString(input.threadId, "threadId"));
        this.#ownedOperation(peer, threadId);
        const modes = this.#runtime.service.queueModes(threadId);
        if (modes === undefined) throw new Error(`No RPC-owned run for ${threadId}`);
        return modes;
      },
      "run.queueModes.set": ({ peer, input }) => {
        const threadId = this.#workspaceThread(requiredString(input.threadId, "threadId"));
        this.#ownedOperation(peer, threadId);
        const steeringMode = queueMode(input.steeringMode, "steeringMode");
        const followUpMode = queueMode(input.followUpMode, "followUpMode");
        if (steeringMode === undefined && followUpMode === undefined) {
          throw new Error("run.queueModes.set requires steeringMode or followUpMode");
        }
        return this.#runtime.service.setQueueModes(threadId, {
          ...(steeringMode === undefined ? {} : { steeringMode }),
          ...(followUpMode === undefined ? {} : { followUpMode }),
        });
      },
      "models.list": async ({ input }) => {
        const provider = optionalString(input.provider, "provider");
        return await this.#runtime.providers.listModels(
          provider,
          AbortSignal.timeout(30_000),
          { refresh: optionalBoolean(input.refresh, "refresh") ?? true },
        );
      },
      "models.status": async ({ input }) => {
        return await this.#runtime.providers.catalogStatus(optionalString(input.provider, "provider"));
      },
      "models.refresh": async ({ input }) => {
        const provider = optionalString(input.provider, "provider");
        const signal = AbortSignal.timeout(30_000);
        return provider === undefined
          ? await this.#runtime.providers.refreshAllModels(signal)
          : await this.#runtime.providers.refreshModels(provider, signal);
      },
      "models.resolve": async ({ input }) => {
        return await this.#runtime.providers.resolveModelReference(
          requiredString(input.reference, "reference"),
          AbortSignal.timeout(30_000),
          {
            ...(optionalString(input.provider, "provider") === undefined ? {} : { provider: input.provider as string }),
            ...(optionalBoolean(input.refresh, "refresh") === undefined ? {} : { refresh: input.refresh as boolean }),
            ...(input.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: boundedText(input.reasoningEffort, "reasoningEffort", RPC_MAX_REASONING_EFFORT_BYTES, false) }),
          },
        );
      },
      "auth.status": async ({ input }) => {
        const auth = this.#providerAuth();
        const provider = input.provider === undefined
          ? undefined
          : boundedText(input.provider, "provider", 512, false);
        return provider === undefined ? await auth.states() : await auth.state(provider);
      },
      "auth.profiles": async ({ input }) => {
        return await this.#providerAuth().profileState(boundedText(input.provider, "provider", 512, false));
      },
      "auth.select": async ({ input }) => {
        return await this.#providerAuth().selectProfile(
          boundedText(input.provider, "provider", 512, false),
          boundedText(input.profile, "profile", 64, false),
        );
      },
      "auth.fallback": async ({ input }) => {
        return await this.#providerAuth().selectFallback(
          boundedText(input.provider, "provider", 512, false),
        );
      },
      "auth.set": async ({ input }) => {
        const auth = this.#providerAuth();
        const provider = boundedText(input.provider, "provider", 512, false);
        const kind = boundedText(input.kind, "kind", 16, false);
        if (kind !== "api_key" && kind !== "bearer") throw new Error("kind must be api_key or bearer");
        const secret = boundedText(input.secret, "secret", 64 * 1024, false);
        const accountId = input.accountId === undefined
          ? undefined
          : boundedText(input.accountId, "accountId", 512, false);
        const profile = input.profile === undefined
          ? undefined
          : boundedText(input.profile, "profile", 64, false);
        const credentialId = auth.binding(provider).credentialId;
        defaultSecretRedactor.register(secret);
        return await auth.storeCredential(
          provider,
          kind === "api_key"
            ? { kind, provider: credentialId, apiKey: secret, ...(accountId === undefined ? {} : { accountId }) }
            : { kind, provider: credentialId, accessToken: secret, ...(accountId === undefined ? {} : { accountId }) },
          { ...(profile === undefined ? {} : { profile }), select: true },
        );
      },
      "auth.delete": async ({ peer, input }) => {
        const auth = this.#providerAuth();
        const provider = boundedText(input.provider, "provider", 512, false);
        const profile = input.profile === undefined
          ? undefined
          : boundedText(input.profile, "profile", 64, false);
        const revokeRemote = optionalBoolean(input.revokeRemote, "revokeRemote") ?? false;
        if (revokeRemote && this.#runtime.network === undefined) {
          throw new Error("Provider authentication network transport is unavailable");
        }
        return await this.#withPeerSignal(peer.id, async (signal) => {
          const options = {
            revokeRemote,
            signal,
            ...(this.#runtime.network === undefined ? {} : { fetch: this.#runtime.network.fetch }),
          };
          return profile === undefined
            ? await auth.logout(provider, options)
            : await auth.deleteProfile(provider, profile, options);
        });
      },
      "resources.list": async () => {
        return await this.#runtime.service.resourceCatalog(AbortSignal.timeout(5_000));
      },
      "commands.list": async () => {
        const catalog = await this.#runtime.service.resourceCatalog(AbortSignal.timeout(5_000));
        return {
          builtins: catalog.commands.builtins,
          runtimeExtensions: catalog.commands.runtimeExtensions,
          extensionTemplates: catalog.commands.extensionTemplates.map(({ sha256: _sha256, ...command }) => command),
          prompts: catalog.prompts.map(({ sha256: _sha256, ...prompt }) => prompt),
          skills: catalog.skills.map(({ metadataTruncated: _metadataTruncated, ...skill }) => ({
            name: skill.name,
            description: skill.description,
            scope: skill.scope,
            trusted: skill.trusted,
            disableModelInvocation: skill.disableModelInvocation,
          })),
        };
      },
      "extension.command.list": () => {
        return (this.#runtime.runtimeExtensions?.commands() ?? []).map(({ sourcePath: _sourcePath, ...command }) => command);
      },
      "extension.command.run": async ({ peer, input }) => {
        return await this.#runExtensionCommand(peer, input);
      },
      "extension.command.cancel": ({ peer, input }) => {
        const operationId = boundedText(input.operationId, "operationId", 256, false);
        const operation = this.#extensionCommands.get(operationId);
        if (operation === undefined || operation.peerId !== peer.id) throw new Error(`Unknown extension command operation ${operationId}`);
        operation.controller.abort(new Error("Extension command cancelled by RPC client"));
        return { accepted: true };
      },
      "extension.ui.respond": ({ peer, input }) => {
        this.#extensionUi.resolve(peer.id, parseRpcExtensionUiResponse(input));
        return { accepted: true };
      },
      "extension.ui.editorText.update": ({ peer, input }) => {
        this.#extensionUi.updateEditorText(
          peer.id,
          boundedText(input.value, "value", RPC_EXTENSION_UI_LIMITS.maxEditorBytes),
        );
        return { accepted: true };
      },
      "extension.ui.editorText.get": ({ peer }) => {
        return { value: this.#extensionUi.editorText(peer.id) };
      },
      "shutdown": () => {
        this.#closing = true;
        for (const threadId of this.#running.keys()) this.#runtime.service.cancel(threadId, "RPC shutdown");
        for (const operation of this.#extensionCommands.values()) {
          operation.controller.abort(new Error("RPC shutdown"));
        }
        for (const controllers of this.#inputControllers.values()) {
          for (const controller of controllers) controller.abort(new Error("RPC shutdown"));
        }
        setImmediate(() => this.#requestShutdown?.());
        return { shuttingDown: true };
      },
    } satisfies RpcMethodHandlerRegistry;
  }

  #settleQueueLease(
    peer: RpcRuntimePeer,
    input: Record<string, unknown>,
    action: "acknowledge" | "release",
  ): { accepted: true } {
    const leaseId = requiredString(input.leaseId, "leaseId");
    const lease = this.#queueLeases.get(leaseId);
    if (lease === undefined || lease.ownerId !== peer.id) throw new Error(`Unknown RPC queue lease ${leaseId}`);
    if (action === "acknowledge") this.#runtime.service.acknowledgeQueueLease(lease);
    else this.#runtime.service.releaseQueueLease(lease);
    this.#queueLeases.delete(leaseId);
    return { accepted: true };
  }

  async close(reason = "RPC dispatcher closed", graceMs = 5_000): Promise<void> {
    if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw new RangeError("RPC drain timeout must be a non-negative safe integer");
    this.#closing = true;
    this.#extensionSessionUnsubscribe?.();
    for (const threadId of this.#running.keys()) this.#runtime.service.cancel(threadId, reason);
    for (const operation of this.#extensionCommands.values()) operation.controller.abort(new Error(reason));
    for (const controllers of this.#inputControllers.values()) {
      for (const controller of controllers) controller.abort(new Error(reason));
    }
    this.#extensionUi.close(reason);
    const operations = [
      ...[...this.#running.values()].map((entry) => entry.promise),
      ...[...this.#extensionCommands.values()].map((entry) => entry.settled),
      ...this.#inputTails.values(),
    ];
    if (operations.length > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(operations),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, graceMs);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    }
    this.#subscriptions.clear();
    for (const lease of this.#queueLeases.values()) {
      try { this.#runtime.service.releaseQueueLease(lease); } catch {}
    }
    this.#queueLeases.clear();
    this.#inputControllers.clear();
    this.#inputTails.clear();
    this.#peers.clear();
    this.#initialExtensionUiSent.clear();
    for (const threadId of [...this.#extensionSessions.keys()]) await this.#endExtensionSession(threadId);
    try {
      if (typeof this.#runtime.runtimeExtensions?.setUiHandler === "function") {
        this.#runtime.runtimeExtensions.setUiHandler(undefined);
      }
    } catch {
      // The extension host may already be closed by runtime teardown.
    }
  }

  #workspaceThread(threadId: string): string {
    this.#runtime.store.bindThreadWorkspace(threadId, this.#runtime.workspace);
    return threadId;
  }

  #providerAuth(): LoadedRuntime["auth"] {
    if (this.#runtime.auth === undefined) throw new Error("Provider authentication is disabled");
    return this.#runtime.auth;
  }

  async #withPeerSignal<T>(peerId: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let controllers = this.#inputControllers.get(peerId);
    if (controllers === undefined) {
      controllers = new Set();
      this.#inputControllers.set(peerId, controllers);
    }
    controllers.add(controller);
    const signal = this.#runtime.generationSignal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, this.#runtime.generationSignal]);
    try {
      signal.throwIfAborted();
      return await this.#waitForAbort(operation(signal), signal);
    } finally {
      controllers.delete(controller);
      if (controllers.size === 0 && this.#inputControllers.get(peerId) === controllers) {
        this.#inputControllers.delete(peerId);
      }
    }
  }

  async #runExtensionCommand(peer: RpcRuntimePeer, input: Record<string, unknown>): Promise<RpcExtensionCommandResult> {
    const extensions = this.#runtime.runtimeExtensions;
    if (
      extensions === undefined ||
      typeof extensions.commands !== "function" ||
      typeof extensions.runCommand !== "function"
    ) throw new Error("Runtime extension commands are disabled");
    const name = boundedText(input.name, "name", 128, false);
    const command = extensions.commands().find((entry) => entry.name === name);
    if (command === undefined) throw new Error(`Unknown runtime extension command: ${name}`);
    const requestedThreadId = input.threadId === undefined
      ? undefined
      : boundedText(input.threadId, "threadId", 256, false);
    const threadId = requestedThreadId ?? (await this.#runtime.service.createSession()).threadId;
    if (requestedThreadId !== undefined) this.#workspaceThread(threadId);
    const branch = input.branch === undefined
      ? this.#runtime.store.getThread(threadId).defaultBranch
      : boundedText(input.branch, "branch", 256, false);
    await this.#ensureExtensionSession(peer, threadId, branch);
    const timeoutMs = optionalNumber(input.timeoutMs, "timeoutMs") ?? RPC_EXTENSION_UI_LIMITS.defaultTimeoutMs;
    if (timeoutMs > RPC_EXTENSION_UI_LIMITS.maxTimeoutMs) {
      throw new Error(`timeoutMs must not exceed ${RPC_EXTENSION_UI_LIMITS.maxTimeoutMs}`);
    }
    const operationId = input.operationId === undefined
      ? `extension_command_${randomBytes(16).toString("hex")}`
      : boundedText(input.operationId, "operationId", 256, false);
    if (this.#extensionCommands.has(operationId)) throw new Error(`Duplicate extension command operation ${operationId}`);
    const controller = new AbortController();
    const signals = [controller.signal, this.#runtime.generationSignal].filter(
      (value): value is AbortSignal => value !== undefined,
    );
    const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
    signal.throwIfAborted();
    let markSettled: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    this.#extensionCommands.set(operationId, { peerId: peer.id, controller, settled });
    let timer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Extension command cancelled"));
      signal.addEventListener("abort", abortListener, { once: true });
    });
    timer = setTimeout(() => {
      const error = new Error("Extension command timed out");
      error.name = "TimeoutError";
      controller.abort(error);
    }, timeoutMs);
    try {
      const result = await Promise.race([
        extensions.runCommand(name, {
          args: input.args === undefined ? "" : boundedText(input.args, "args", 256 * 1024),
          threadId,
          branch,
          signal,
          ui: this.#extensionUi.context(peer.id, command.extensionId, { signal, timeoutMs }),
        }),
        cancelled,
      ]);
      return { operationId, threadId, branch, ...result };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abortListener !== undefined) signal.removeEventListener("abort", abortListener);
      this.#extensionCommands.delete(operationId);
      if (!controller.signal.aborted) controller.abort(new Error("Extension command finished"));
      markSettled();
    }
  }

  #sendInitialExtensionUi(peerId: string): void {
    if (this.#initialExtensionUiSent.has(peerId)) return;
    this.#initialExtensionUiSent.add(peerId);
    const extensions = this.#runtime.runtimeExtensions;
    const operations = typeof extensions?.initialUi === "function" ? extensions.initialUi() : [];
    for (const operation of operations) {
      try {
        this.#extensionUi.applyInitialOperation(peerId, operation);
      } catch {
        // Invalid initial UI from one extension does not suppress later entries.
      }
    }
  }

  async #emitExtensionUi(peerId: string, request: RpcExtensionUiRequest): Promise<void> {
    const peer = this.#peers.get(peerId);
    if (peer === undefined) throw new Error("RPC client disconnected");
    await peer.notification("extension.ui.request", request);
  }

  #ownedOperation(peer: RpcRuntimePeer, threadId: string): RunningOperation {
    const operation = this.#running.get(threadId);
    if (operation === undefined || operation.ownerId !== peer.id) throw new Error(`No RPC-owned run for ${threadId}`);
    return operation;
  }

  async #serializeThreadInput<T>(
    peerId: string,
    threadId: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let controllers = this.#inputControllers.get(peerId);
    if (controllers === undefined) {
      controllers = new Set();
      this.#inputControllers.set(peerId, controllers);
    }
    controllers.add(controller);
    const signal = this.#runtime.generationSignal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, this.#runtime.generationSignal]);
    const previous = this.#inputTails.get(threadId) ?? Promise.resolve();
    const result = previous.then(async () => {
      signal.throwIfAborted();
      return await operation(signal);
    });
    const tail = result.then(() => undefined, () => undefined);
    this.#inputTails.set(threadId, tail);
    try {
      return await result;
    } finally {
      controllers.delete(controller);
      if (controllers.size === 0 && this.#inputControllers.get(peerId) === controllers) this.#inputControllers.delete(peerId);
      if (this.#inputTails.get(threadId) === tail) this.#inputTails.delete(threadId);
    }
  }

  async #reduceRpcInput(
    event: RuntimeInputEvent,
    signal: AbortSignal,
  ): Promise<RuntimeInputResult> {
    const extensions = this.#runtime.runtimeExtensions;
    if (extensions === undefined || typeof extensions.reduceInput !== "function") return { action: "continue" };
    const result = await this.#waitForAbort(extensions.reduceInput(event, signal), signal);
    if (result.action !== "continue" && result.action !== "handled" && result.action !== "transform") {
      throw new Error("Runtime extension returned an invalid input result");
    }
    if (result.action === "transform") {
      boundedText(result.text, "Runtime transformed input", RPC_MAX_TRANSFORMED_INPUT_BYTES);
    }
    return result;
  }

  async #waitForAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
      const aborted = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error("RPC input cancelled"));
      signal.addEventListener("abort", aborted, { once: true });
      operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    });
  }

  async #queueRunInput(
    peer: RpcRuntimePeer,
    input: Record<string, unknown>,
    delivery: "steer" | "follow_up",
  ): Promise<{ accepted: boolean; handled?: true }> {
    const queued = parseQueuedRunInput(input);
    const threadId = this.#workspaceThread(requiredString(input.threadId, "threadId"));
    this.#ownedOperation(peer, threadId);
    return await this.#serializeThreadInput(peer.id, threadId, async (signal) => {
      this.#ownedOperation(peer, threadId);
      const reduced = await this.#reduceRpcInput({
        text: queued.message,
        ...(queued.images === undefined ? {} : { images: queued.images }),
        source: "rpc",
        delivery,
      }, signal);
      if (reduced.action === "handled") return { accepted: false, handled: true };
      const selected = reduced.action === "transform"
        ? parseQueuedRunInput({
            threadId,
            message: reduced.text,
            ...(reduced.images === undefined ? {} : { images: reduced.images }),
          })
        : queued;
      signal.throwIfAborted();
      this.#ownedOperation(peer, threadId);
      if (delivery === "follow_up") this.#runtime.service.followUp(threadId, selected.message, selected.images);
      else this.#runtime.service.steer(threadId, selected.message, selected.images);
      return { accepted: true };
    });
  }

  #threadState(input: Record<string, unknown>): RpcThreadState {
    const threadId = this.#workspaceThread(requiredString(input.threadId, "threadId"));
    const thread = this.#runtime.store.getThread(threadId);
    const branch = optionalString(input.branch, "branch") ?? thread.defaultBranch;
    const events = this.#runtime.store.listEvents(threadId, branch);
    const pathRunIds = new Set(events.flatMap((event) => event.runId === undefined ? [] : [event.runId]));
    const runs = this.#runtime.store.listRuns(threadId).filter((run) => pathRunIds.has(run.runId));
    const latestRun = runs.at(-1);
    const active = this.#running.get(threadId);
    const activeOnBranch = active?.branch === branch ? active : undefined;
    const durableSelection = this.#runtime.store.getModelSelection(threadId, branch);
    const selection = activeOnBranch?.selection ?? durableSelection ?? latestRun;
    const queueModes = activeOnBranch === undefined ? undefined : this.#runtime.service.queueModes(threadId);
    return {
      threadId,
      branch,
      ...(thread.name === undefined ? {} : { name: thread.name }),
      active: activeOnBranch !== undefined,
      operation: activeOnBranch?.kind ?? null,
      pendingMessageCount: this.#runtime.service.queuedMessages(threadId, branch).length,
      ...(this.#runtime.service.recoverableMessageCount(threadId, branch) === 0
        ? {}
        : { recoverableMessageCount: this.#runtime.service.recoverableMessageCount(threadId, branch) }),
      ...(selection?.provider === undefined ? {} : { provider: selection.provider }),
      ...(selection?.model === undefined ? {} : { model: selection.model }),
      ...(selection !== undefined && "reasoningEffort" in selection && typeof selection.reasoningEffort === "string"
        ? { reasoningEffort: selection.reasoningEffort }
        : {}),
      ...(queueModes === undefined ? {} : { queueModes }),
    };
  }

  async #threadStatistics(input: Record<string, unknown>): Promise<RpcThreadStatistics> {
    const threadId = this.#workspaceThread(requiredString(input.threadId, "threadId"));
    const thread = this.#runtime.store.getThread(threadId);
    const branch = optionalString(input.branch, "branch") ?? thread.defaultBranch;
    const events = this.#runtime.store.listEvents(threadId, branch);
    const pathRunIds = new Set(events.flatMap((event) => event.runId === undefined ? [] : [event.runId]));
    const runs = this.#runtime.store.listRuns(threadId).filter((run) => pathRunIds.has(run.runId));
    const messages = { system: 0, user: 0, assistant: 0, tool: 0, total: 0 };
    let toolCalls = 0;
    let toolResults = 0;
    for (const envelope of events) {
      if (envelope.event.type !== "message_appended") continue;
      const message = envelope.event.message;
      messages[message.role] += 1;
      messages.total += 1;
      for (const block of message.content) {
        if (block.type === "tool_call") toolCalls += 1;
        else if (block.type === "tool_result") toolResults += 1;
      }
    }
    const usages = usageByRun(events);
    const totalUsage = [...usages.values()].reduce<NormalizedUsage>((total, entry) => addUsage(total, entry.usage), {});
    const latestRun = runs.at(-1);
    const latestUsage = latestRun === undefined ? undefined : usages.get(latestRun.runId);
    const lastCompactionSequence = events.findLast((entry) => entry.event.type === "compaction_completed")?.sequence;
    let contextUsage: RpcThreadStatistics["contextUsage"];
    if (
      latestRun?.provider !== undefined &&
      latestRun.model !== undefined &&
      latestUsage !== undefined &&
      (lastCompactionSequence === undefined || latestUsage.sequence > lastCompactionSequence)
    ) {
      try {
        const signal = this.#runtime.generationSignal === undefined
          ? AbortSignal.timeout(5_000)
          : AbortSignal.any([this.#runtime.generationSignal, AbortSignal.timeout(5_000)]);
        const model = (await this.#runtime.providers.listModels(latestRun.provider, signal, { refresh: false }))
          .find((entry) => entry.id === latestRun.model);
        const contextTokens = normalizedContextTokens(latestUsage.usage);
        if (model?.contextTokens !== undefined && contextTokens !== undefined) {
          contextUsage = {
            tokens: contextTokens,
            contextWindow: model.contextTokens,
            percent: Math.round((contextTokens / model.contextTokens) * 1_000) / 10,
          };
        }
      } catch {
        // Statistics remain useful when a stale or removed provider has no local catalog entry.
      }
    }
    return {
      threadId,
      branch,
      branches: thread.branches.length,
      messages,
      tools: { calls: toolCalls, results: toolResults },
      runs: {
        total: runs.length,
        completed: runs.filter((run) => run.state === "completed").length,
        failed: runs.filter((run) => run.state === "failed").length,
        cancelled: runs.filter((run) => run.state === "cancelled").length,
        active: runs.filter((run) => !["completed", "failed", "cancelled"].includes(run.state)).length,
      },
      tokens: usageTokens(totalUsage),
      ...(totalUsage.cost === undefined ? {} : { cost: totalUsage.cost }),
      ...(contextUsage === undefined ? {} : { contextUsage }),
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    };
  }

  #lastAssistantText(input: Record<string, unknown>): { text: string | null } {
    const threadId = this.#workspaceThread(requiredString(input.threadId, "threadId"));
    const thread = this.#runtime.store.getThread(threadId);
    const branch = optionalString(input.branch, "branch") ?? thread.defaultBranch;
    const assistant = this.#runtime.store.listEvents(threadId, branch).findLast((entry) =>
      entry.event.type === "message_appended" && entry.event.message.role === "assistant");
    if (assistant?.event.type !== "message_appended") return { text: null };
    const text = assistant.event.message.content
      .flatMap((block) => block.type === "text" ? [block.text] : [])
      .join("");
    if (Buffer.byteLength(text, "utf8") > RPC_MAX_LAST_ASSISTANT_TEXT_BYTES) {
      throw new Error(`Last assistant text exceeds ${RPC_MAX_LAST_ASSISTANT_TEXT_BYTES} bytes`);
    }
    return { text };
  }

  async #startRun(peer: RpcRuntimePeer, input: Record<string, unknown>): Promise<{ threadId: string; handled?: true }> {
    const {
      threadId: requestedThreadId,
      branch: requestedBranch,
      ...parsedRunOptions
    } = parseRunStartInput(input);
    return await this.#withPeerSignal(peer.id, async (peerSignal) => {
      const retainedSelection = await this.#runtime.service.resolveModelSelection(parsedRunOptions.model, {
        allowUnknownModel: true,
        ...(parsedRunOptions.provider === undefined ? {} : { provider: parsedRunOptions.provider }),
        ...(parsedRunOptions.reasoningEffort === undefined ? {} : { reasoningEffort: parsedRunOptions.reasoningEffort }),
        signal: peerSignal,
        lookupSignal: AbortSignal.timeout(30_000),
        retainGeneration: true,
      });
      const resolvedSelection = retainedSelection.selection;
      try {
        const {
          provider: _provider,
          model: _model,
          reasoningEffort: _reasoningEffort,
          ...remainingRunOptions
        } = parsedRunOptions;
        const runOptions = {
          ...remainingRunOptions,
          provider: resolvedSelection.provider,
          model: resolvedSelection.model,
          ...(resolvedSelection.reasoningEffort === undefined ? {} : { reasoningEffort: resolvedSelection.reasoningEffort }),
        };
        const threadId = requestedThreadId ?? (await this.#runtime.service.createSession({
          signal: retainedSelection.signal,
        })).threadId;
        if (requestedThreadId !== undefined) this.#workspaceThread(threadId);
        const branch = requestedBranch ?? this.#runtime.store.getThread(threadId).defaultBranch;
        await this.#waitForAbort(this.#ensureExtensionSession(peer, threadId, branch), retainedSelection.signal);
        retainedSelection.signal.throwIfAborted();
        return await this.#waitForAbort(this.#serializeThreadInput(peer.id, threadId, async (signal) => {
          const handoffSignal = AbortSignal.any([signal, retainedSelection.signal]);
          if (this.#running.has(threadId)) throw new Error(`Thread already has an RPC-owned run: ${threadId}`);
          let selectedOptions = runOptions;
          if (runOptions.manualCompaction !== true) {
            const reduced = await this.#reduceRpcInput({
              text: runOptions.prompt,
              ...(runOptions.images === undefined ? {} : { images: runOptions.images }),
              source: "rpc",
            }, handoffSignal);
            if (reduced.action === "handled") return { threadId, handled: true };
            if (reduced.action === "transform") {
              const transformed = parseQueuedRunInput({
                threadId,
                message: reduced.text,
                ...(reduced.images === undefined ? {} : { images: reduced.images }),
              });
              const { prompt: _prompt, images: _images, ...rest } = runOptions;
              selectedOptions = {
                ...rest,
                prompt: transformed.message,
                ...(transformed.images === undefined ? {} : { images: transformed.images }),
              };
            }
          }
          handoffSignal.throwIfAborted();
          const operation = this.#runtime.service.run({
            ...selectedOptions,
            threadId,
            branch,
            onEvent: async (event) => {
              this.#publish(peer.id, branch, event);
              await this.#dispatchExtensionEvent(peer, event);
            },
          });
          const trackedOperation = operation.then(
            async (result) => {
              await this.#notify(peer.id, "run.finished", result);
              return result;
            },
            async (error) => {
              await this.#notify(peer.id, "run.failed", {
                threadId,
                message: defaultSecretRedactor.redact(error instanceof Error ? error.message : String(error)),
              });
              throw error;
            },
          ).finally(() => this.#running.delete(threadId));
          void trackedOperation.catch(() => undefined);
          this.#running.set(threadId, {
            ownerId: peer.id,
            branch,
            kind: selectedOptions.manualCompaction === true ? "compaction" : "run",
            selection: {
              provider: selectedOptions.provider,
              model: selectedOptions.model,
              ...(selectedOptions.reasoningEffort === undefined ? {} : { reasoningEffort: selectedOptions.reasoningEffort }),
            },
            promise: trackedOperation,
          });
          retainedSelection.release();
          return { threadId };
        }), retainedSelection.signal);
      } finally {
        retainedSelection.release();
      }
    });
  }

  async #ensureExtensionSession(peer: RpcRuntimePeer, threadId: string, branch: string): Promise<void> {
    if (this.#extensionSessions.has(threadId) || this.#runtime.runtimeExtensions === undefined) return;
    this.#extensionSessions.set(threadId, branch);
    await this.#runtime.runtimeExtensions.dispatch("session_start", {
      threadId,
      branch,
      workspace: this.#runtime.workspace,
    }).catch(async (error) => await this.#notify(peer.id, "extension.warning", {
      phase: "session_start",
      message: defaultSecretRedactor.redact(error instanceof Error ? error.message : String(error)),
    }));
  }

  async #endExtensionSession(threadId: string): Promise<void> {
    const branch = this.#extensionSessions.get(threadId);
    if (branch === undefined || this.#runtime.runtimeExtensions === undefined) return;
    this.#extensionSessions.delete(threadId);
    await this.#runtime.runtimeExtensions.dispatch("session_end", {
      threadId,
      branch,
      workspace: this.#runtime.workspace,
    }).catch(() => undefined);
  }

  async #dispatchExtensionEvent(peer: RpcRuntimePeer, event: EventEnvelope): Promise<void> {
    if (this.#runtime.runtimeExtensions === undefined) return;
    await this.#runtime.runtimeExtensions.dispatch("event", event).catch(async (error) => await this.#notify(peer.id, "extension.warning", {
      phase: "event",
      message: defaultSecretRedactor.redact(error instanceof Error ? error.message : String(error)),
    }));
  }

  #subscribe(peer: RpcRuntimePeer, input: Record<string, unknown>): RpcEventSubscriptionResult {
    if ([...this.#subscriptions.values()].filter((entry) => entry.peerId === peer.id).length >= 100) {
      throw new Error("Too many event subscriptions for this client");
    }
    const threadId = this.#workspaceThread(requiredString(input.threadId, "threadId"));
    const branch = optionalString(input.branch, "branch") ?? this.#runtime.store.getThread(threadId).defaultBranch;
    const cursor = optionalCursor(input.afterSequence);
    const limit = eventPageLimit(input.limit);
    const firstPage = boundedEventPage(this.#runtime.store.listEventPage(threadId, branch, {
      afterSequence: cursor,
      limit,
    }), cursor);
    const subscription: Subscription = {
      id: `subscription_${randomBytes(16).toString("hex")}`,
      peerId: peer.id,
      threadId,
      branch,
      cursor,
      replaying: true,
      pendingLive: [],
      pendingLiveBytes: 0,
      deliveryRunning: false,
    };
    this.#subscriptions.set(subscription.id, subscription);
    setImmediate(() => {
      void this.#replaySubscription(subscription, firstPage, limit).catch((cause) => {
        if (!this.#subscriptions.has(subscription.id)) return;
        this.#subscriptions.delete(subscription.id);
        void this.#notify(subscription.peerId, "events.error", {
          subscriptionId: subscription.id,
          cursor: subscription.cursor,
          reason: defaultSecretRedactor.redact(cause instanceof Error ? cause.message : String(cause)),
        });
      });
    });
    return {
      subscriptionId: subscription.id,
      replayedThrough: Math.max(cursor, firstPage.snapshotSequence),
      nextCursor: firstPage.nextSequence,
      hasMore: firstPage.hasMore,
      ...(firstPage.blocked === undefined ? {} : { blocked: firstPage.blocked }),
    };
  }

  async #replaySubscription(subscription: Subscription, firstPage: EventReplayPage, limit: number): Promise<void> {
    let page = firstPage;
    while (this.#subscriptions.has(subscription.id)) {
      if (subscription.stopReason !== undefined) {
        await this.#finalizeSubscriptionStop(subscription);
        return;
      }
      for (const event of page.events) {
        if (!await this.#deliverReplayNow(subscription, event)) return;
        if (subscription.stopReason !== undefined) {
          await this.#finalizeSubscriptionStop(subscription);
          return;
        }
      }
      if (page.blocked !== undefined) {
        this.#requestSubscriptionStop(subscription, {
          reason: `Event ${page.blocked.sequence} exceeds the serialized event limit; the subscription stopped before that event`,
          blocked: page.blocked,
        });
        await this.#finalizeSubscriptionStop(subscription);
        return;
      }
      if (!page.hasMore) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (!this.#subscriptions.has(subscription.id)) return;
      const previousCursor = page.nextSequence;
      page = boundedEventPage(this.#runtime.store.listEventPage(subscription.threadId, subscription.branch, {
        afterSequence: previousCursor,
        limit,
        throughSequence: firstPage.snapshotSequence,
      }), previousCursor);
      if (page.nextSequence <= previousCursor && page.hasMore) {
        throw new Error("Event replay cursor did not advance");
      }
    }
    if (!this.#subscriptions.has(subscription.id)) return;
    subscription.replaying = false;
    await this.#drainSubscription(subscription);
  }

  async #deliverReplayNow(subscription: Subscription, event: EventEnvelope): Promise<boolean> {
    if (event.sequence <= subscription.cursor || !this.#subscriptions.has(subscription.id)) {
      return this.#subscriptions.has(subscription.id);
    }
    const bytes = serializedEventBytes(event);
    if (bytes > RPC_EVENT_MAX_SERIALIZED_BYTES) {
      const blocked = oversizedEvent(event, bytes);
      this.#requestSubscriptionStop(subscription, {
        reason: `Event ${blocked.sequence} exceeds the serialized event limit; the subscription stopped before that event`,
        blocked,
      });
      await this.#finalizeSubscriptionStop(subscription);
      return false;
    }
    return await this.#sendSubscriptionEvent(subscription, event);
  }

  #publish(ownerId: string, branch: string, event: EventEnvelope): void {
    void this.#notify(ownerId, "run.event", rpcEventEnvelope(event));
    this.#publishSubscriptions(branch, event);
  }

  #publishSubscriptions(branch: string, event: EventEnvelope): void {
    if (this.#closing) return;
    const projected = rpcEventEnvelope(event);
    for (const subscription of this.#subscriptions.values()) {
      if (subscription.threadId === projected.threadId && subscription.branch === branch) this.#deliver(subscription, projected);
    }
  }

  #deliver(subscription: Subscription, event: EventEnvelope): void {
    if (event.sequence <= subscription.cursor || !this.#subscriptions.has(subscription.id)) return;
    if (subscription.stopReason !== undefined) return;
    const bytes = serializedEventBytes(event);
    if (bytes > RPC_EVENT_MAX_SERIALIZED_BYTES) {
      this.#requestSubscriptionStop(subscription, {
        reason: `Event ${event.sequence} exceeds the serialized event limit; the subscription stopped before that event`,
        blocked: oversizedEvent(event, bytes),
      });
      return;
    }
    if (subscription.pendingLive.some((entry) => entry.event.sequence === event.sequence)) return;
    if (
      subscription.pendingLive.length >= RPC_SUBSCRIPTION_PENDING_MAX_EVENTS ||
      subscription.pendingLiveBytes + bytes > RPC_SUBSCRIPTION_PENDING_MAX_BYTES
    ) {
      this.#requestSubscriptionStop(subscription, {
        reason: `Subscription delivery buffer exceeded ${RPC_SUBSCRIPTION_PENDING_MAX_EVENTS} events or ${RPC_SUBSCRIPTION_PENDING_MAX_BYTES} bytes`,
      });
      return;
    }
    const insertion = subscription.pendingLive.findIndex((entry) => entry.event.sequence > event.sequence);
    if (insertion < 0) subscription.pendingLive.push({ event, bytes });
    else subscription.pendingLive.splice(insertion, 0, { event, bytes });
    subscription.pendingLiveBytes += bytes;
    if (!subscription.replaying) void this.#drainSubscription(subscription);
  }

  async #drainSubscription(subscription: Subscription): Promise<void> {
    if (subscription.deliveryRunning || subscription.replaying || !this.#subscriptions.has(subscription.id)) return;
    subscription.deliveryRunning = true;
    try {
      while (subscription.pendingLive.length > 0 && this.#subscriptions.has(subscription.id)) {
        const selected = subscription.pendingLive[0]!;
        if (!await this.#sendSubscriptionEvent(subscription, selected.event)) return;
        if (subscription.pendingLive[0] === selected) subscription.pendingLive.shift();
        subscription.pendingLiveBytes = Math.max(0, subscription.pendingLiveBytes - selected.bytes);
        if (subscription.stopReason !== undefined) break;
      }
    } finally {
      subscription.deliveryRunning = false;
    }
    if (subscription.stopReason !== undefined) await this.#finalizeSubscriptionStop(subscription);
    else if (subscription.pendingLive.length > 0) await this.#drainSubscription(subscription);
  }

  async #sendSubscriptionEvent(subscription: Subscription, event: EventEnvelope): Promise<boolean> {
    if (event.sequence <= subscription.cursor || !this.#subscriptions.has(subscription.id)) {
      return this.#subscriptions.has(subscription.id);
    }
    const peer = this.#peers.get(subscription.peerId);
    if (peer === undefined) {
      this.#subscriptions.delete(subscription.id);
      return false;
    }
    try {
      await peer.notification("events.event", { subscriptionId: subscription.id, event });
    } catch (cause) {
      subscription.pendingLive = [];
      subscription.pendingLiveBytes = 0;
      this.#subscriptions.delete(subscription.id);
      await this.#notify(subscription.peerId, "events.error", {
        subscriptionId: subscription.id,
        cursor: subscription.cursor,
        reason: `Event delivery failed before cursor advancement: ${defaultSecretRedactor.redact(cause instanceof Error ? cause.message : String(cause))}`,
      });
      return false;
    }
    subscription.cursor = event.sequence;
    return this.#subscriptions.has(subscription.id);
  }

  #requestSubscriptionStop(
    subscription: Subscription,
    stop: { reason: string; blocked?: RpcOversizedEvent },
  ): void {
    if (!this.#subscriptions.has(subscription.id) || subscription.stopReason !== undefined) return;
    subscription.stopReason = stop;
    subscription.pendingLive = [];
    subscription.pendingLiveBytes = 0;
    if (!subscription.replaying && !subscription.deliveryRunning) void this.#finalizeSubscriptionStop(subscription);
  }

  async #finalizeSubscriptionStop(subscription: Subscription): Promise<void> {
    const stop = subscription.stopReason;
    if (stop === undefined || !this.#subscriptions.has(subscription.id)) return;
    this.#subscriptions.delete(subscription.id);
    subscription.pendingLive = [];
    subscription.pendingLiveBytes = 0;
    await this.#notify(subscription.peerId, "events.error", {
      subscriptionId: subscription.id,
      cursor: subscription.cursor,
      reason: stop.reason,
      ...(stop.blocked === undefined ? {} : { blocked: stop.blocked }),
    });
  }

  async #notify(peerId: string, method: string, value: unknown): Promise<boolean> {
    const peer = this.#peers.get(peerId);
    if (peer === undefined) return false;
    try {
      await peer.notification(method, value);
      return true;
    } catch {
      return false;
    }
  }
}
