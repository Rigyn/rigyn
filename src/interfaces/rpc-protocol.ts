import type {
  CredentialProfileState,
  ProviderAuthState,
  ProviderCredentialSaveResult,
  ProviderLogoutResult,
  ProviderProfileDeleteResult,
} from "../auth/index.js";
import type { AgentRunResult, QueueMode, QueuedRunMessage } from "../core/agent.js";
import type { EventEnvelope } from "../core/events.js";
import type { ImageBlock, ModelInfo } from "../core/types.js";
import type {
  RuntimeCommandDescription,
} from "../extensions/runtime.js";
import type { InteractiveActivePolicy } from "../interactive/commands.js";
import type {
  ModelCatalogRefreshResult,
  ModelCatalogStatus,
  ModelReferenceResolution,
} from "../providers/registry.js";
import type { HarnessRun } from "../service/harness.js";
import type { HarnessResourceCatalog } from "../service/resource-catalog.js";
import type { BranchRecord, RunRecord, ThreadRecord } from "../storage/types.js";
import type { RpcExtensionUiRequest, RpcExtensionUiResponse } from "./rpc-extension-ui.js";
import type { RpcThreadState, RpcThreadStatistics } from "./rpc-runtime.js";

export interface RpcInitializeResult {
  name: "rigyn";
  version: string;
  capabilities: typeof import("./rpc-runtime.js").RIGYN_RPC_CAPABILITIES;
}

export interface RpcHealthResult {
  status: "ok" | "draining";
  version: string;
  uptimeSeconds: number;
  clients: number;
  activeRuns: number;
}

export interface RpcVersionResult {
  name: "rigyn";
  version: string;
}

export interface RpcRunStartParams {
  prompt?: string;
  provider?: string;
  model: string;
  threadId?: string;
  branch?: string;
  images?: ImageBlock[];
  outboundImages?: "allow" | "block";
  maxSteps?: number;
  maxOutputTokens?: number;
  contextTokenBudget?: number;
  summaryTokenBudget?: number;
  reasoningEffort?: string;
  allowedTools?: string[];
  excludedTools?: string[];
  noBuiltinTools?: boolean;
  noContextFiles?: boolean;
  systemPrompt?: string;
  appendSystemPrompt?: string[];
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  manualCompaction?: boolean;
  compactionInstructions?: string;
}

export interface RpcThreadCompactParams {
  threadId: string;
  branch?: string;
  provider: string;
  model: string;
  outboundImages?: "allow" | "block";
  reasoningEffort?: string;
  maxOutputTokens?: number;
  contextTokenBudget?: number;
  summaryTokenBudget?: number;
  instructions?: string;
}

export interface RpcQueuedInputParams {
  threadId: string;
  message: string;
  images?: ImageBlock[];
}

export interface RpcQueueBlockedItem {
  reason: string;
  item: {
    mode: string;
    textBytes: number;
    imageCount: number;
    images: Array<{ mediaType: string; source: "url" | "embedded"; sourceBytes: number }>;
  };
  restoreWith: string;
  index?: number;
}

export interface RpcQueueResult {
  messages: QueuedRunMessage[];
  nextOffset?: number;
  blocked?: RpcQueueBlockedItem;
  recovery?: { branch: string; count: number; automaticReplay: false };
  quarantinedCount?: number;
}

export interface RpcDequeueResult {
  messages: QueuedRunMessage[];
  lease?: { id: string; branch: string; acknowledgeMethod: "run.dequeue.ack" };
  blocked?: RpcQueueBlockedItem;
  recovery?: { branch: string; count: number; automaticReplay: false };
}

export interface RpcCommandCatalog {
  builtins: Array<{
    name: string;
    aliasFor?: string;
    syntax: string;
    activePolicy: InteractiveActivePolicy;
    hidden: boolean;
  }>;
  runtimeExtensions: Array<Omit<RuntimeCommandDescription, "sourcePath">>;
  extensionTemplates: Array<{
    name: string;
    extensionId: string;
    description?: string;
    argumentHint?: string;
  }>;
  prompts: Array<{
    id: string;
    extensionId: string;
    description?: string;
    argumentHint?: string;
  }>;
  skills: Array<{
    name: string;
    description: string;
    scope: "user" | "workspace";
    trusted: boolean;
    disableModelInvocation: boolean;
  }>;
}

export interface RpcExtensionCommandResult {
  operationId: string;
  threadId: string;
  branch: string;
  handled: boolean;
  prompt?: string;
}

export type RpcThreadExportResult =
  | { jsonl: string }
  | { format: "jsonl" | "markdown" | "html"; content: string; bytes: number };

export interface RpcThreadEventsPagedParams {
  threadId: string;
  branch?: string;
  afterSequence?: number;
  limit?: number;
}

export interface RpcOversizedEvent {
  reason: "event_exceeds_serialized_byte_limit";
  sequence: number;
  serializedBytes: number;
  maximumBytes: number;
  resumeAfterSequence: number;
}

export interface RpcEventPage {
  events: EventEnvelope[];
  nextCursor: number;
  hasMore: boolean;
  blocked?: RpcOversizedEvent;
}

export interface RpcEventSubscriptionResult {
  subscriptionId: string;
  replayedThrough: number;
  nextCursor: number;
  hasMore: boolean;
  blocked?: RpcOversizedEvent;
}

export interface RpcMethodMap {
  initialize: { params: undefined; result: RpcInitializeResult };
  health: { params: undefined; result: RpcHealthResult };
  version: { params: undefined; result: RpcVersionResult };
  capabilities: { params: undefined; result: RpcInitializeResult["capabilities"] };
  "thread.create": {
    params: { name?: string; parentThreadId?: string; parentRunId?: string } | undefined;
    result: ThreadRecord;
  };
  "thread.list": { params: undefined; result: ThreadRecord[] };
  "thread.get": { params: { threadId: string }; result: { thread: ThreadRecord; runs: RunRecord[] } };
  "thread.events": {
    params: RpcThreadEventsPagedParams;
    result: RpcEventPage;
  };
  "thread.state": { params: { threadId: string; branch?: string }; result: RpcThreadState };
  "thread.stats": { params: { threadId: string; branch?: string }; result: RpcThreadStatistics };
  "thread.lastAssistantText": { params: { threadId: string; branch?: string }; result: { text: string | null } };
  "thread.fork": {
    params: { threadId: string; fromBranch?: string; atEventId?: string; newBranch: string };
    result: BranchRecord | { cancelled: true };
  };
  "thread.name": { params: { threadId: string; name: string }; result: ThreadRecord };
  "thread.delete": { params: { threadId: string }; result: { deleted: true } };
  "thread.export": {
    params: { threadId: string; format?: "jsonl" | "markdown" | "html"; branch?: string };
    result: RpcThreadExportResult;
  };
  "thread.compact": { params: RpcThreadCompactParams; result: AgentRunResult };
  "events.subscribe": {
    params: { threadId: string; branch?: string; afterSequence?: number; limit?: number };
    result: RpcEventSubscriptionResult;
  };
  "events.unsubscribe": { params: { subscriptionId: string }; result: { unsubscribed: true } };
  "run.start": { params: RpcRunStartParams; result: { threadId: string; handled?: true } };
  "run.wait": { params: { threadId: string }; result: HarnessRun | AgentRunResult };
  "run.cancel": { params: { threadId: string; reason?: string }; result: { accepted: true } };
  "run.steer": { params: RpcQueuedInputParams; result: { accepted: boolean; handled?: true } };
  "run.followUp": { params: RpcQueuedInputParams; result: { accepted: boolean; handled?: true } };
  "run.queue": {
    params: { threadId: string; branch?: string; offset?: number; limit?: number };
    result: RpcQueueResult;
  };
  "run.dequeue": { params: { threadId: string; branch?: string }; result: RpcDequeueResult };
  "run.dequeue.ack": { params: { leaseId: string }; result: { accepted: true } };
  "run.dequeue.release": { params: { leaseId: string }; result: { accepted: true } };
  "run.queueModes.get": {
    params: { threadId: string };
    result: { steeringMode: QueueMode; followUpMode: QueueMode };
  };
  "run.queueModes.set": {
    params: { threadId: string; steeringMode?: QueueMode; followUpMode?: QueueMode };
    result: { steeringMode: QueueMode; followUpMode: QueueMode };
  };
  "models.list": { params: { provider?: string; refresh?: boolean } | undefined; result: ModelInfo[] };
  "models.status": { params: { provider?: string } | undefined; result: ModelCatalogStatus[] };
  "models.refresh": {
    params: { provider?: string } | undefined;
    result: ModelCatalogRefreshResult | ModelCatalogRefreshResult[];
  };
  "models.resolve": {
    params: { reference: string; provider?: string; refresh?: boolean; reasoningEffort?: string };
    result: ModelReferenceResolution;
  };
  "auth.status": { params: { provider?: string } | undefined; result: ProviderAuthState | ProviderAuthState[] };
  "auth.profiles": { params: { provider: string }; result: CredentialProfileState };
  "auth.select": { params: { provider: string; profile: string }; result: ProviderAuthState };
  "auth.fallback": { params: { provider: string }; result: ProviderAuthState };
  "auth.set": {
    params: { provider: string; kind: "api_key" | "bearer"; secret: string; accountId?: string; profile?: string };
    result: ProviderCredentialSaveResult;
  };
  "auth.delete": {
    params: { provider: string; profile?: string; revokeRemote?: boolean };
    result: ProviderLogoutResult | ProviderProfileDeleteResult;
  };
  "resources.list": { params: undefined; result: HarnessResourceCatalog };
  "commands.list": { params: undefined; result: RpcCommandCatalog };
  "extension.command.list": { params: undefined; result: Array<Omit<RuntimeCommandDescription, "sourcePath">> };
  "extension.command.run": {
    params: { name: string; args?: string; threadId?: string; branch?: string; timeoutMs?: number; operationId?: string };
    result: RpcExtensionCommandResult;
  };
  "extension.command.cancel": { params: { operationId: string }; result: { accepted: true } };
  "extension.ui.respond": { params: RpcExtensionUiResponse; result: { accepted: true } };
  "extension.ui.editorText.update": { params: { value: string }; result: { accepted: true } };
  "extension.ui.editorText.get": { params: undefined; result: { value: string } };
  shutdown: { params: undefined; result: { shuttingDown: true } };
}

export type RpcMethod = keyof RpcMethodMap;
export type RpcMethodParams<K extends RpcMethod> = RpcMethodMap[K]["params"];
export type RpcMethodResult<K extends RpcMethod> = RpcMethodMap[K]["result"];

export interface RpcNotificationMap {
  "run.event": EventEnvelope;
  "run.finished": HarnessRun;
  "run.failed": { threadId: string; message: string };
  "thread.compacted": { threadId: string; result: AgentRunResult };
  "thread.compactionFailed": { threadId: string; message: string };
  "extension.warning": { phase: "session_start" | "event"; message: string };
  "extension.ui.request": RpcExtensionUiRequest;
  "events.event": { subscriptionId: string; event: EventEnvelope };
  "events.error": { subscriptionId: string; cursor: number; reason: string; blocked?: RpcOversizedEvent };
}

export type RpcNotification = keyof RpcNotificationMap;
export type RpcNotificationParams<K extends RpcNotification> = RpcNotificationMap[K];

export const RPC_ERROR_CODES = Object.freeze({
  parse: -32700,
  methodNotFound: -32601,
  invalidParams: -32602,
} as const);

export const RPC_ERROR_REFERENCE = Object.freeze([
  {
    code: RPC_ERROR_CODES.parse,
    name: "parse",
    meaning: "The input line is not valid bounded JSON-RPC input.",
  },
  {
    code: RPC_ERROR_CODES.methodNotFound,
    name: "method_not_found",
    meaning: "The requested method is not advertised or implemented.",
  },
  {
    code: RPC_ERROR_CODES.invalidParams,
    name: "invalid_params_or_state",
    meaning: "Parameters, ownership, workspace scope, capability state, or operation state are invalid.",
  },
] as const);

interface RpcMethodReferenceEntry {
  summary: string;
  params: string;
  result: string;
}

export const RPC_METHOD_REFERENCE = Object.freeze({
  initialize: { params: "none", result: "RpcInitializeResult", summary: "Negotiate version and capabilities." },
  health: { params: "none", result: "RpcHealthResult", summary: "Inspect server health and active client/run counts." },
  version: { params: "none", result: "RpcVersionResult", summary: "Read the server package version." },
  capabilities: { params: "none", result: "RPC capability object", summary: "Read capability negotiation data without initialization." },
  "thread.create": { params: "name?, parentThreadId?, parentRunId?", result: "ThreadRecord", summary: "Create a workspace-bound thread." },
  "thread.list": { params: "none", result: "ThreadRecord[]", summary: "List workspace threads." },
  "thread.get": { params: "threadId", result: "{ thread, runs }", summary: "Read a thread and its runs." },
  "thread.events": { params: "threadId, branch?, afterSequence?, limit?", result: "RpcEventPage", summary: "Read a bounded cursor page of durable events on a branch." },
  "thread.state": { params: "threadId, branch?", result: "RpcThreadState", summary: "Read active state, selection, and pending counts." },
  "thread.stats": { params: "threadId, branch?", result: "RpcThreadStatistics", summary: "Read message, run, usage, and context statistics." },
  "thread.lastAssistantText": { params: "threadId, branch?", result: "{ text }", summary: "Read bounded text from the latest assistant message." },
  "thread.fork": { params: "threadId, newBranch, fromBranch?, atEventId?", result: "BranchRecord or cancelled", summary: "Fork a branch at a durable event." },
  "thread.name": { params: "threadId, name", result: "ThreadRecord", summary: "Set a thread name." },
  "thread.delete": { params: "threadId", result: "{ deleted }", summary: "Delete a workspace thread." },
  "thread.export": { params: "threadId, format?, branch?", result: "RpcThreadExportResult", summary: "Export bounded JSONL, Markdown, or HTML." },
  "thread.compact": { params: "threadId, provider, model, branch?, budgets?", result: "AgentRunResult", summary: "Run manual context compaction." },
  "events.subscribe": { params: "threadId, branch?, afterSequence?, limit?", result: "RpcEventSubscriptionResult", summary: "Start bounded-batch replayable durable-event delivery." },
  "events.unsubscribe": { params: "subscriptionId", result: "{ unsubscribed }", summary: "Stop an event subscription." },
  "run.start": { params: "RpcRunStartParams", result: "{ threadId, handled? }", summary: "Start a caller-owned agent run." },
  "run.wait": { params: "threadId", result: "HarnessRun or AgentRunResult", summary: "Wait for a caller-owned run or compaction." },
  "run.cancel": { params: "threadId, reason?", result: "{ accepted }", summary: "Cancel a caller-owned run." },
  "run.steer": { params: "threadId, message, images?", result: "{ accepted, handled? }", summary: "Queue steering input for an active run." },
  "run.followUp": { params: "threadId, message, images?", result: "{ accepted, handled? }", summary: "Queue follow-up input for an active run." },
  "run.queue": { params: "threadId, branch?, offset?, limit?", result: "RpcQueueResult", summary: "Inspect bounded durable queued input." },
  "run.dequeue": { params: "threadId, branch?", result: "RpcDequeueResult", summary: "Lease one durable queued input item." },
  "run.dequeue.ack": { params: "leaseId", result: "{ accepted }", summary: "Acknowledge and remove a queue lease." },
  "run.dequeue.release": { params: "leaseId", result: "{ accepted }", summary: "Release a queue lease without removing it." },
  "run.queueModes.get": { params: "threadId", result: "queue modes", summary: "Read active run queue modes." },
  "run.queueModes.set": { params: "threadId, steeringMode?, followUpMode?", result: "queue modes", summary: "Change active run queue modes." },
  "models.list": { params: "provider?, refresh?", result: "ModelInfo[]", summary: "List configured or discovered models." },
  "models.status": { params: "provider?", result: "ModelCatalogStatus[]", summary: "Inspect durable model-catalog status." },
  "models.refresh": { params: "provider?", result: "ModelCatalogRefreshResult or []", summary: "Refresh one or all model catalogs." },
  "models.resolve": { params: "reference, provider?, refresh?, reasoningEffort?", result: "ModelReferenceResolution", summary: "Resolve an exact or unambiguous model reference." },
  "auth.status": { params: "provider?", result: "ProviderAuthState or []", summary: "Inspect secret-free provider auth state." },
  "auth.profiles": { params: "provider", result: "CredentialProfileState", summary: "List secret-free credential profiles." },
  "auth.select": { params: "provider, profile", result: "ProviderAuthState", summary: "Select a stored credential profile." },
  "auth.fallback": { params: "provider", result: "ProviderAuthState", summary: "Select environment or ambient fallback auth." },
  "auth.set": { params: "provider, kind, secret, accountId?, profile?", result: "ProviderCredentialSaveResult", summary: "Store and select an API-key or bearer credential." },
  "auth.delete": { params: "provider, profile?, revokeRemote?", result: "logout/delete result", summary: "Delete local auth, optionally revoking remotely." },
  "resources.list": { params: "none", result: "HarnessResourceCatalog", summary: "Read the bounded callback-free harness resource catalog." },
  "commands.list": { params: "none", result: "RpcCommandCatalog", summary: "Discover built-in, extension, prompt, and skill commands." },
  "extension.command.list": { params: "none", result: "RuntimeCommandDescription[]", summary: "List executable runtime-extension commands." },
  "extension.command.run": { params: "name, args?, threadId?, branch?, timeoutMs?, operationId?", result: "RpcExtensionCommandResult", summary: "Run a runtime-extension command with RPC UI." },
  "extension.command.cancel": { params: "operationId", result: "{ accepted }", summary: "Cancel a caller-owned extension command." },
  "extension.ui.respond": { params: "RpcExtensionUiResponse", result: "{ accepted }", summary: "Answer a correlated extension UI request." },
  "extension.ui.editorText.update": { params: "value", result: "{ accepted }", summary: "Update RPC client editor text." },
  "extension.ui.editorText.get": { params: "none", result: "{ value }", summary: "Read RPC client editor text." },
  shutdown: { params: "none", result: "{ shuttingDown }", summary: "Drain operations and stop the stdio server." },
} satisfies { [K in RpcMethod]: RpcMethodReferenceEntry });

export const RPC_METHOD_NAMES = Object.freeze(Object.keys(RPC_METHOD_REFERENCE) as RpcMethod[]);
export const RPC_NOTIFICATION_REFERENCE = Object.freeze({
  "run.event": { payload: "EventEnvelope", summary: "Live durable or streaming event for a caller-owned run." },
  "run.finished": { payload: "HarnessRun", summary: "Caller-owned run completed and its wait result is available." },
  "run.failed": { payload: "{ threadId, message }", summary: "Caller-owned run rejected before producing a normal result." },
  "thread.compacted": { payload: "{ threadId, result }", summary: "Manual compaction completed." },
  "thread.compactionFailed": { payload: "{ threadId, message }", summary: "Manual compaction failed." },
  "extension.warning": { payload: "{ phase, message }", summary: "A bounded extension lifecycle observer failed." },
  "extension.ui.request": { payload: "RpcExtensionUiRequest", summary: "Correlated UI request owned by this RPC peer." },
  "events.event": { payload: "{ subscriptionId, event }", summary: "Replay or live event for a durable subscription." },
  "events.error": { payload: "{ subscriptionId, cursor, reason, blocked? }", summary: "A durable event subscription stopped at a cursor." },
} satisfies { [K in RpcNotification]: { payload: string; summary: string } });

export const RPC_NOTIFICATION_NAMES = Object.freeze(Object.keys(RPC_NOTIFICATION_REFERENCE) as RpcNotification[]);

export function renderRpcMethodReference(): string {
  const rows = RPC_METHOD_NAMES.map((name) => {
    const entry = RPC_METHOD_REFERENCE[name];
    return `| \`${name}\` | ${entry.params} | ${entry.result} | ${entry.summary} |`;
  });
  return [
    "| Method | Parameters | Result | Purpose |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

export function renderRpcNotificationReference(): string {
  return [
    "| Notification | Payload | When |",
    "| --- | --- | --- |",
    ...RPC_NOTIFICATION_NAMES.map((name) => {
      const entry = RPC_NOTIFICATION_REFERENCE[name];
      return `| \`${name}\` | ${entry.payload} | ${entry.summary} |`;
    }),
  ].join("\n");
}

export function renderRpcErrorReference(): string {
  return [
    "| Code | Name | Meaning |",
    "| ---: | --- | --- |",
    ...RPC_ERROR_REFERENCE.map((entry) => `| \`${entry.code}\` | \`${entry.name}\` | ${entry.meaning} |`),
  ].join("\n");
}
