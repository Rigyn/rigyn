import { resolve } from "node:path";
import {
  AgentRunner,
  attachQueuedRunDelivery,
  cloneQueuedRunMessage,
  queuedRunDeliveryId,
  queuedRunDeliveryMessageId,
  normalizedContextTokens,
  ThreadRunManager,
  type AgentExtensionReducers,
  type AgentRunRequest,
  type AgentRunResult,
  type QueuedRunDeliveryReceipt,
  type QueuedRunMessage,
  type QueueMode,
  type RetryPolicy,
} from "../core/index.js";
import type { EventEnvelope } from "../core/events.js";
import type {
  AdapterError,
  CanonicalMessage,
  ImageBlock,
  NormalizedUsage,
  OutboundImagePolicy,
  PromptCompositionMetadata,
  PromptCompositionSource,
  ProviderId,
} from "../core/types.js";
import {
  discoverInstructions,
  discoverSkills,
  discoverWorkspacePromptFiles,
  estimateTextTokens,
  resolveEffectiveContextBudget,
  renderCompactionFileActivity,
  stripCompactionFileActivity,
  type CompactionFileActivity,
  type DiscoveredInstructions,
  type SkillMetadata,
  type SkillRoot,
} from "../context/index.js";
import {
  ProviderRegistry,
  type ModelReferenceOptions,
  type ResolvedModelSelection,
} from "../providers/registry.js";
import { DirectProcessRunner } from "../process/index.js";
import { SessionStore } from "../storage/store.js";
import {
  EditTool,
  FindTool,
  GrepTool,
  LsTool,
  ReadTool,
  ShellTool,
  ToolCoordinator,
  ToolRegistry,
  WriteTool,
  WorkspaceBoundary,
  type HarnessTool,
  type ToolExecutionBackend,
  type ToolInvocation,
} from "../tools/index.js";
import { sha256 } from "../tools/hash.js";
import { buildSystemPrompt, instructionMessage } from "../prompts/index.js";
import { StoreArtifactWriter, StoredConversation } from "./session-runtime.js";
import { defaultSecretRedactor } from "../auth/redaction.js";
import type { RuntimeEvent } from "../core/events.js";
import { createId } from "../core/ids.js";
import { HarnessError } from "../core/errors.js";
import {
  normalizeChildRunPolicy,
  type ChildRunPolicy,
} from "../core/child-runs.js";
import type { BranchRecord, RunInputQueueRecord } from "../storage/types.js";
import {
  BRANCH_SUMMARY_LIMITS,
  generateBranchSummary,
  prepareAbandonedBranch,
} from "./branch-summary.js";
import {
  cloneSessionPath as cloneStoredSessionPath,
  type CloneSessionPathInput,
  type CloneSessionPathResult,
} from "./session-clone.js";
import { buildSessionTree } from "./session-tree.js";
import type {
  RuntimeAgentOutcome,
  RuntimeExtensionEvent,
  RuntimeExtensionEventMap,
  RuntimeExtensionHost,
  RuntimeExtensionMessageRecord,
  RuntimeChildEvent,
  RuntimeChildRunInput,
  RuntimeChildRunResult,
  RuntimeChildSession,
  RuntimeChildUsage,
  RuntimeChildVisibleEvent,
  RuntimeModelSelection,
  RuntimeSessionSnapshot,
  RuntimeExtensionStateRecord,
  RuntimeExtensionStateCompareAndAppendResult,
  RuntimeTurnEndEvent,
} from "../extensions/runtime.js";
import type { ExtensionMessageEvent, ExtensionStateEvent } from "../core/extension-entries.js";
import {
  buildHarnessResourceCatalog,
  type HarnessResourceCatalog,
  type HarnessResourceCatalogSources,
  type HarnessResourceOwner,
} from "./resource-catalog.js";
import { projectHarnessTranscriptPage } from "./transcript-projection.js";
import {
  parseHarnessTranscriptPage,
  type HarnessTranscriptPage,
  type HarnessTranscriptRequest,
} from "./transcript.js";
import {
  harnessSessionPage,
  normalizeHarnessSessionListRequest,
  type HarnessSessionListRequest,
  type HarnessSessionPage,
} from "./session-catalog.js";

const CANCELLED_EXTENSION_OBSERVER_SETTLEMENT_TIMEOUT_MS = 1_000;
const RUNTIME_CHILD_INSTRUCTION_SOURCE = "runtime child run";
const MAX_PROMPT_COMPOSITION_SOURCES = 128;
const MAX_PROMPT_COMPOSITION_TOOLS = 128;
const MAX_PROMPT_COMPOSITION_SKILLS = 256;
const MAX_PROMPT_COMPOSITION_BYTES = 256 * 1024;
const MAX_PROMPT_COMPOSITION_IDENTITY_BYTES = 4 * 1024;
const MAX_RUNTIME_CHILD_ARTIFACTS = 64;
const RUNTIME_CHILD_USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "serverToolCalls",
  "durationMs",
] as const satisfies readonly (keyof RuntimeChildUsage)[];

function cappedExplicitMaxOutputTokens(
  requested: number | undefined,
  catalogLimit: number | undefined,
): number | undefined {
  if (requested !== undefined && (!Number.isSafeInteger(requested) || requested < 1)) {
    throw new RangeError("maxOutputTokens must be a positive safe integer");
  }
  if (requested === undefined || catalogLimit === undefined) return requested;
  return Math.min(requested, catalogLimit);
}

function addRuntimeChildUsage(
  left: RuntimeChildUsage | undefined,
  right: NormalizedUsage | RuntimeChildUsage,
): RuntimeChildUsage {
  const result: RuntimeChildUsage = {};
  for (const field of RUNTIME_CHILD_USAGE_FIELDS) {
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

function runtimeChildUsage(events: readonly EventEnvelope[], runId: string): RuntimeChildUsage | undefined {
  let total: RuntimeChildUsage | undefined;
  let response: RuntimeChildUsage | undefined;
  for (const envelope of events) {
    if (envelope.runId !== runId) continue;
    if (envelope.event.type === "provider_response_started") {
      if (response !== undefined) total = addRuntimeChildUsage(total, response);
      response = undefined;
      continue;
    }
    if (envelope.event.type !== "usage") continue;
    response = envelope.event.semantics === "incremental"
      ? addRuntimeChildUsage(response, envelope.event.usage)
      : addRuntimeChildUsage(undefined, envelope.event.usage);
  }
  return response === undefined ? total : addRuntimeChildUsage(total, response);
}

const RUNTIME_CHILD_VISIBLE_EVENT_TYPES = new Set<RuntimeChildVisibleEvent["type"]>([
  "run_started", "model_selected", "run_state", "assistant_started", "provider_response_started", "text_delta",
  "reasoning_delta", "assistant_completed", "tool_requested", "tool_started", "tool_progress", "tool_completed",
  "tool_in_doubt", "usage", "retry_scheduled", "compaction_started", "compaction_completed", "steering_queued",
  "run_completed", "run_failed", "run_cancelled", "warning",
]);

function runtimeChildEvent(envelope: EventEnvelope, branch: string): RuntimeChildEvent | undefined {
  if (!RUNTIME_CHILD_VISIBLE_EVENT_TYPES.has(envelope.event.type as RuntimeChildVisibleEvent["type"])) return undefined;
  if (envelope.event.type === "reasoning_delta" && envelope.event.visibility !== "summary") return undefined;
  return {
    threadId: envelope.threadId,
    branch,
    ...(envelope.runId === undefined ? {} : { runId: envelope.runId }),
    sequence: envelope.sequence,
    timestamp: envelope.timestamp,
    event: structuredClone(envelope.event) as RuntimeChildVisibleEvent,
  };
}

function promptCompositionSource(
  kind: PromptCompositionSource["kind"],
  source: string,
  text: string,
  truncated = false,
): PromptCompositionSource {
  const safeSource = defaultSecretRedactor.redact(source).replace(/[\u0000-\u001f\u007f]/gu, "?") || "unspecified";
  const boundedSource = boundedChildText(safeSource, MAX_PROMPT_COMPOSITION_IDENTITY_BYTES);
  return {
    kind,
    source: boundedSource.text,
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: sha256(text),
    ...(truncated || boundedSource.truncated ? { truncated: true } : {}),
  };
}

function promptComposition(input: {
  systemPrompt: string;
  instructions: DiscoveredInstructions;
  selectedTools: readonly string[];
  skills: readonly SkillMetadata[];
  customPrompt?: { text: string; source: string };
  appendSystemPrompt: readonly { text: string; source: string }[];
  additionalInstructions?: { text: string; source: string };
}): PromptCompositionMetadata {
  const allSources: PromptCompositionSource[] = [
    ...(input.customPrompt === undefined
      ? []
      : [promptCompositionSource("system_prompt", input.customPrompt.source, input.customPrompt.text)]),
    ...input.appendSystemPrompt.map((entry) =>
      promptCompositionSource("append_system_prompt", entry.source, entry.text)),
    ...input.instructions.entries.map((entry) =>
      promptCompositionSource("instruction", entry.source, entry.text, entry.truncated)),
    ...(input.additionalInstructions === undefined
      ? []
      : [promptCompositionSource(
          "additional_instructions",
          input.additionalInstructions.source,
          input.additionalInstructions.text,
        )]),
  ];
  const allTools = [...new Set(input.selectedTools)];
  const allSkills = input.selectedTools.includes("read")
    ? input.skills.filter((skill) => !skill.disableModelInvocation)
    : [];
  const sources = allSources.slice(0, MAX_PROMPT_COMPOSITION_SOURCES);
  const tools = allTools.slice(0, MAX_PROMPT_COMPOSITION_TOOLS);
  const skills = allSkills.slice(0, MAX_PROMPT_COMPOSITION_SKILLS).map((skill) => ({
    name: boundedChildText(defaultSecretRedactor.redact(skill.name), 256).text || "unnamed",
    manifestPath: boundedChildText(
      defaultSecretRedactor.redact(skill.manifestPath).replace(/[\u0000-\u001f\u007f]/gu, "?"),
      MAX_PROMPT_COMPOSITION_IDENTITY_BYTES,
    ).text,
  }));
  const metadata: PromptCompositionMetadata = {
    bytes: Buffer.byteLength(input.systemPrompt, "utf8"),
    sha256: sha256(input.systemPrompt),
    sources,
    tools,
    skills,
    truncated: input.instructions.truncated || allSources.some((entry) => entry.truncated === true) ||
      allSources.length > MAX_PROMPT_COMPOSITION_SOURCES ||
      allTools.length > MAX_PROMPT_COMPOSITION_TOOLS ||
      allSkills.length > MAX_PROMPT_COMPOSITION_SKILLS,
  };
  while (Buffer.byteLength(JSON.stringify(metadata), "utf8") > MAX_PROMPT_COMPOSITION_BYTES) {
    metadata.truncated = true;
    if (metadata.skills.length > 0) metadata.skills.pop();
    else if (metadata.sources.length > 0) metadata.sources.pop();
    else if (metadata.tools.length > 0) metadata.tools.pop();
    else break;
  }
  return metadata;
}

function extensionObserverSignal(signal: AbortSignal | undefined): AbortSignal | undefined {
  return signal?.aborted === true
    ? AbortSignal.timeout(CANCELLED_EXTENSION_OBSERVER_SETTLEMENT_TIMEOUT_MS)
    : signal;
}

function observerAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function settleObserverWithSignal(
  observer: () => void | Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    try {
      void Promise.resolve(observer()).catch(() => undefined);
    } catch {
      // Cancellation events remain best effort after the run has already stopped.
    }
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(observerAbortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(observer)
      .then(
        () => finish(resolve),
        (error: unknown) => finish(() => reject(error)),
      );
  });
}

export interface HarnessOptions {
  store: SessionStore;
  workspace: string;
  providers: ProviderRegistry;
  projectTrusted?: boolean;
  userInstructions?: { text: string; source?: string };
  userInstructionFile?: string;
  skillRoots?: SkillRoot[];
  extraTools?: HarnessTool[];
  /** Routes explicitly claimed model tools through a fail-closed host boundary. */
  toolBackend?: ToolExecutionBackend;
  outboundImages?: OutboundImagePolicy;
  runtimeExtensions?: RuntimeExtensionHost;
  shellPath?: string;
  autoCompaction?: boolean;
  compactionRetainRecentTurns?: number;
  compactionToolResultBytes?: number;
  retry?: RetryPolicy;
  childRuns?: Partial<ChildRunPolicy>;
  /** Own session and generic-event dispatch unless a CLI or RPC host already does so. */
  managedExtensionLifecycle?: boolean;
  /** Callback-free discovery metadata supplied by the owning runtime. */
  resourceCatalog?: Pick<HarnessResourceCatalogSources, "extensions" | "packages" | "projectPackages" | "packageDiagnostics">;
}

export interface HarnessRuntimeResources {
  providers: ProviderRegistry;
  projectTrusted: boolean;
  skills: SkillMetadata[];
  extraTools: HarnessTool[];
  toolBackend?: ToolExecutionBackend;
  outboundImages?: OutboundImagePolicy;
  runtimeExtensions?: RuntimeExtensionHost;
  shellPath?: string;
  autoCompaction?: boolean;
  compactionRetainRecentTurns?: number;
  compactionToolResultBytes?: number;
  retry?: RetryPolicy;
  childRuns?: Partial<ChildRunPolicy>;
  resourceCatalog?: Pick<HarnessResourceCatalogSources, "extensions" | "packages" | "projectPackages" | "packageDiagnostics">;
}

export interface RunOptions {
  prompt: string;
  signal?: AbortSignal;
  displayPrompt?: string;
  images?: ImageBlock[];
  outboundImages?: OutboundImagePolicy;
  autoCompaction?: boolean;
  provider: ProviderId;
  model: string;
  threadId?: string;
  branch?: string;
  cwd?: string;
  maxSteps?: number;
  maxOutputTokens?: number;
  contextTokenBudget?: number;
  summaryTokenBudget?: number;
  reasoningEffort?: string;
  allowedTools?: string[];
  excludedTools?: string[];
  noBuiltinTools?: boolean;
  noContextFiles?: boolean;
  /** Trusted host override. `null` explicitly disables the configured backend for this run. */
  toolBackend?: ToolExecutionBackend | null;
  onEvent?: (event: EventEnvelope) => Promise<void> | void;
  manualCompaction?: boolean;
  compactionInstructions?: string;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  additionalInstructions?: { text: string; source: string };
  systemPrompt?: { text: string; source: string };
  appendSystemPrompt?: Array<{ text: string; source: string }>;
  /** Durable queue lease promoted to this explicit user turn. */
  queueLease?: RunInputQueueLease;
}

export interface ResolveModelSelectionOptions extends ModelReferenceOptions {
  signal?: AbortSignal;
}

export interface HarnessRun {
  threadId: string;
  results: AgentRunResult[];
}

export interface RunInputQueueLease {
  leaseId: string;
  messageId: string;
  threadId: string;
  branch: string;
  message: QueuedRunMessage;
}

export interface ExtensionSessionPublication {
  branch: string;
  envelope: EventEnvelope<ExtensionStateEvent | ExtensionMessageEvent>;
}

export type ExtensionSessionPublicationListener = (
  publication: ExtensionSessionPublication,
) => Promise<void> | void;

export interface NavigateTreeOptions {
  threadId: string;
  branch?: string;
  targetBranch: string;
  targetEventId: string | null;
  newBranch: string;
  summarize?: boolean;
  provider?: ProviderId;
  model?: string;
  summaryTokenBudget?: number;
  summaryInstructions?: string;
  label?: string;
  signal?: AbortSignal;
}

export interface NavigateTreeResult {
  cancelled: boolean;
  branch?: BranchRecord;
  summaryEvent?: EventEnvelope<Extract<RuntimeEvent, { type: "branch_summary_created" }>>;
}

interface RuntimeLifecycleProjection {
  step: number;
  tools: Map<string, ToolInvocation>;
}

function instructionMatches(message: CanonicalMessage, prompt: string): boolean {
  return message.role === "system" &&
    message.purpose === "instructions" &&
    message.content.length === 1 &&
    message.content[0]?.type === "text" &&
    message.content[0].text === prompt;
}

function boundedLifecycleText(value: string, maximum = 16 * 1024): string {
  const redacted = defaultSecretRedactor.redact(value).replaceAll("\0", "�");
  const bytes = Buffer.from(redacted, "utf8");
  if (bytes.byteLength <= maximum) return redacted;
  return `${bytes.subarray(0, maximum - 3).toString("utf8")}...`;
}

function boundedChildText(value: string, maximumBytes: number): { text: string; truncated: boolean } {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maximumBytes) return { text: value, truncated: false };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let length = maximumBytes; length >= Math.max(0, maximumBytes - 3); length -= 1) {
    try {
      return { text: decoder.decode(encoded.subarray(0, length)), truncated: true };
    } catch {
      // Only the last three bytes can belong to a partial UTF-8 scalar.
    }
  }
  return { text: "", truncated: true };
}

function observeRuntimeChildCallback(callback: () => unknown): void {
  try {
    void Promise.resolve(callback()).catch(() => undefined);
  } catch {
    // Child progress callbacks are observational and cannot fail child execution.
  }
}

function boundedLifecycleAdapterError(error: AdapterError): AdapterError {
  return {
    category: error.category,
    message: boundedLifecycleText(error.message),
    retryable: error.retryable,
    partial: error.partial,
    ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    ...(error.providerCode === undefined ? {} : { providerCode: boundedLifecycleText(error.providerCode, 4 * 1024) }),
    ...(error.requestId === undefined ? {} : { requestId: boundedLifecycleText(error.requestId, 4 * 1024) }),
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    ...(error.bodyStarted === undefined ? {} : { bodyStarted: error.bodyStarted }),
  };
}

function boundedLifecycleError(
  error: Extract<RuntimeAgentOutcome, { status: "failed" }>["error"],
): Extract<RuntimeAgentOutcome, { status: "failed" }>["error"] {
  return error.category === "internal"
    ? { category: "internal", message: boundedLifecycleText(error.message) }
    : boundedLifecycleAdapterError(error);
}

function boundedAgentOutcome(outcome: RuntimeAgentOutcome): RuntimeAgentOutcome {
  if (outcome.status === "completed") return { ...outcome };
  if (outcome.status === "cancelled") return { status: "cancelled", reason: boundedLifecycleText(outcome.reason) };
  return { status: "failed", error: boundedLifecycleError(outcome.error) };
}

function latestRunContextUsage(
  events: readonly EventEnvelope[],
  runId: string,
): { usage: NormalizedUsage; sequence: number } | undefined {
  let current: { usage: NormalizedUsage; sequence: number } | undefined;
  for (const envelope of events) {
    if (envelope.runId !== runId || envelope.event.type !== "usage") continue;
    const usage = envelope.event.usage;
    current = {
      usage: envelope.event.semantics === "incremental"
        ? {
            inputTokens: (current?.usage.inputTokens ?? 0) + (usage.inputTokens ?? 0),
            cacheReadTokens: (current?.usage.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
            cacheWriteTokens: (current?.usage.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
          }
        : { ...usage },
      sequence: envelope.sequence,
    };
  }
  return current;
}

function runtimeSessionPhase(
  events: readonly EventEnvelope[],
  runId: string | undefined,
): { operation: "run" | "compaction"; phase: NonNullable<RuntimeSessionSnapshot["phase"]> } {
  if (runId === undefined) return { operation: "run", phase: "preparing" };
  const selected = events.filter((envelope) => envelope.runId === runId);
  const lastRetry = selected.findLast((envelope) => envelope.event.type === "retry_scheduled")?.sequence ?? -1;
  const lastCompactionStart = selected.findLast((envelope) => envelope.event.type === "compaction_started")?.sequence ?? -1;
  const lastCompactionEnd = selected.findLast((envelope) => envelope.event.type === "compaction_completed")?.sequence ?? -1;
  const lastRunState = selected.findLast((envelope) => envelope.event.type === "run_state");
  if (lastCompactionStart > lastCompactionEnd) return { operation: "compaction", phase: "compacting" };
  if (lastRetry > (lastRunState?.sequence ?? -1)) return { operation: "run", phase: "retrying" };
  const state = lastRunState?.event.type === "run_state" ? lastRunState.event.state : "preparing";
  if (state === "completed" || state === "failed" || state === "cancelled") {
    return { operation: "run", phase: "preparing" };
  }
  return { operation: "run", phase: state };
}

function extensionStateRecord(
  envelope: EventEnvelope<ExtensionStateEvent>,
  branch: string,
): RuntimeExtensionStateRecord {
  return {
    ...envelope.event,
    threadId: envelope.threadId,
    branch,
    eventId: envelope.eventId,
    timestamp: envelope.timestamp,
  };
}

function extensionMessageRecord(
  envelope: EventEnvelope<ExtensionMessageEvent>,
  branch: string,
): RuntimeExtensionMessageRecord {
  return {
    ...envelope.event,
    threadId: envelope.threadId,
    branch,
    eventId: envelope.eventId,
    timestamp: envelope.timestamp,
  };
}

export class HarnessService {
  readonly #options: HarnessOptions;
  readonly #runner: AgentRunner;
  readonly #manager: ThreadRunManager;
  readonly #workspaceRoot: string;
  readonly #listeners = new Map<string, (event: EventEnvelope) => Promise<void> | void>();
  readonly #extensionSessionListeners = new Set<ExtensionSessionPublicationListener>();
  readonly #activeToolSelections = new Map<string, {
    names: string[];
    requesterExtensionId: string;
    requesterSourcePath: string;
  }>();
  readonly #activeToolRuns = new Map<string, { coordinator: ToolCoordinator; tools: HarnessTool[] }>();
  readonly #runtimeModelSelections = new Map<string, RuntimeModelSelection>();
  readonly #sessions = new Map<string, { branch?: string; cwd: string }>();
  readonly #pendingExtensionTurns = new Map<string, Map<number, RuntimeTurnEndEvent>>();
  readonly #childRunDepth = new Map<string, number>();
  #childRunPolicy: ChildRunPolicy;
  #activeChildRuns = 0;
  #skills: SkillMetadata[] = [];
  #workspaceBoundary: WorkspaceBoundary | undefined;
  #closed = false;
  #reloading = false;
  #workspaceRecovered = false;
  #workspaceRecovery: Promise<void> | undefined;
  #workspaceActivation: Promise<void> | undefined;
  #extensionSessionCleanup: (() => void) | undefined;

  constructor(options: HarnessOptions) {
    this.#options = options;
    this.#childRunPolicy = normalizeChildRunPolicy(options.childRuns);
    this.#workspaceRoot = resolve(options.workspace);
    const conversation = new StoredConversation(options.store);
    this.#runner = new AgentRunner({
      conversation,
      events: (threadId, runId, branch, signal) => {
        const persistent = options.store.createEventSink({
          threadId,
          runId,
          ...(branch === undefined ? {} : { branch }),
        });
        const projection: RuntimeLifecycleProjection = { step: 0, tools: new Map() };
        return {
          emit: async (event) => {
            const sanitized = defaultSecretRedactor.redactValue(event) as RuntimeEvent;
            if (
              sanitized.type === "message_appended" &&
              sanitized.providerState !== undefined &&
              sanitized.providerStateSerialized !== undefined
            ) {
              sanitized.providerStateSerialized = JSON.stringify(sanitized.providerState);
            }
            const envelope = await persistent.emit(sanitized);
            await this.#observeRuntimeEnvelope(envelope, projection, signal);
            if (this.#options.managedExtensionLifecycle !== false) {
              await this.#observeRuntime("event", envelope, signal);
            }
            const listener = this.#listeners.get(threadId);
            if (listener !== undefined) {
              await settleObserverWithSignal(() => listener(envelope), signal);
            }
            return envelope;
          },
        };
      },
      lifecycle: {
        beforeRun: async (event, signal) => {
          await this.#observeRuntime("agent_start", event, signal);
        },
        afterRun: async (event, signal) => {
          const extensionEvent = { ...event, outcome: boundedAgentOutcome(event.outcome) };
          await this.#flushPendingExtensionTurns(event.runId, signal);
          await this.#observeRuntime("agent_end", extensionEvent, signal);
          await this.#observeRuntime("agent_settled", extensionEvent, signal);
        },
        beforeModel: async (event, signal) => {
          await this.#observeRuntime("turn_start", event, signal);
          await this.#observeRuntime("message_start", {
            threadId: event.threadId,
            runId: event.runId,
            step: event.step,
            role: "assistant",
          }, signal);
        },
        afterModel: async (event, signal) => {
          const extensionEvent: RuntimeTurnEndEvent = event.outcome.status === "failed"
            ? { ...event, outcome: { status: "failed", error: boundedLifecycleAdapterError(event.outcome.error) } }
            : event;
          if (extensionEvent.outcome.status === "completed") {
            const turns = this.#pendingExtensionTurns.get(event.runId) ?? new Map<number, RuntimeTurnEndEvent>();
            turns.set(event.step, extensionEvent);
            this.#pendingExtensionTurns.set(event.runId, turns);
          } else {
            await this.#observeRuntime("turn_end", extensionEvent, signal);
          }
        },
        afterProviderResponse: async (event, signal) => {
          await this.#observeRuntime("after_provider_response", event, signal);
        },
        beforeCompaction: async (event, signal) => {
          const extensions = this.#options.runtimeExtensions;
          if (extensions === undefined || !extensions.hasListeners("session_before_compact")) return undefined;
          const result = await extensions.reduceSessionBeforeCompact({
            plan: event.plan,
            ...(event.customInstructions === undefined ? {} : { customInstructions: event.customInstructions }),
            signal,
          });
          return {
            ...(result.cancel === undefined ? {} : { cancel: result.cancel }),
            ...(result.reason === undefined ? {} : { reason: defaultSecretRedactor.redact(result.reason) }),
            ...(result.compaction === undefined ? {} : { summaryText: result.compaction.text }),
            ...(result.compaction?.metadata === undefined ? {} : { metadata: result.compaction.metadata }),
          };
        },
        afterCompaction: async (event, signal) => {
          await this.#observeRuntime("session_compact", {
            reason: event.reason,
            summary: event.summary,
            sourceMessageIds: event.sourceMessageIds,
            ...(event.extensionMetadata === undefined ? {} : { metadata: event.extensionMetadata }),
            fromExtension: event.fromExtension,
            willRetry: event.willRetry,
          }, signal);
        },
      },
    });
    this.#manager = new ThreadRunManager(this.#runner);
    this.#bindExtensionSessionHost(options.runtimeExtensions);
  }

  async initialize(options: { recover?: boolean; skills?: readonly SkillMetadata[] } = {}): Promise<void> {
    this.#workspaceBoundary = await WorkspaceBoundary.create(this.#options.workspace);
    this.#skills = options.skills === undefined
      ? await discoverSkills(this.#options.skillRoots ?? [])
      : [...options.skills];
    if (options.recover === true) await this.recoverWorkspaceRuntime();
  }

  /** Recovers durable run and input-queue state for this workspace. */
  async recoverWorkspaceRuntime(): Promise<void> {
    if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service is closed");
    if (this.#reloading) throw new HarnessError("SERVICE_RELOADING", "Harness resources are reloading");
    if (this.#workspaceRecovered) return;
    if (this.#workspaceRecovery !== undefined) return await this.#workspaceRecovery;
    const recovery = this.#recoverWorkspaceState();
    this.#workspaceRecovery = recovery;
    try {
      await recovery;
    } catch (error) {
      if (this.#workspaceRecovery === recovery) this.#workspaceRecovery = undefined;
      throw error;
    }
  }

  /**
   * Activates a fully committed workspace runtime. Recovery mutates durable
   * workspace state, so callers must transfer ownership before invoking this.
   */
  async activateWorkspaceRuntime(): Promise<void> {
    if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service is closed");
    if (this.#reloading) throw new HarnessError("SERVICE_RELOADING", "Harness resources are reloading");
    if (this.#workspaceActivation !== undefined) return await this.#workspaceActivation;
    const activation = (async () => {
      await this.recoverWorkspaceRuntime();
      if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service closed during workspace activation");
    })();
    this.#workspaceActivation = activation;
    try {
      await activation;
    } catch (error) {
      if (this.#workspaceActivation === activation) this.#workspaceActivation = undefined;
      throw error;
    }
  }

  async #recoverWorkspaceState(): Promise<void> {
    if (this.#workspaceRecovered) return;
    this.#options.store.recoverAbandonedRuns(this.#workspaceRoot);
    this.#options.store.recoverRunInputs(this.#workspaceRoot);
    this.#workspaceRecovered = true;
  }

  /** Deletes a saved session and its durable events. */
  async deleteSession(threadId: string): Promise<void> {
    if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service is closed");
    if (this.#reloading) throw new HarnessError("SERVICE_RELOADING", "Harness resources are reloading");
    this.#options.store.bindThreadWorkspace(threadId, this.#workspaceRoot);
    const session = this.#sessions.get(threadId);
    this.#options.store.deleteThread(threadId);
    this.#sessions.delete(threadId);
    for (const key of this.#activeToolSelections.keys()) {
      if (key.startsWith(`${threadId}\0`)) this.#activeToolSelections.delete(key);
    }
    for (const key of this.#runtimeModelSelections.keys()) {
      if (key.startsWith(`${threadId}\0`)) this.#runtimeModelSelections.delete(key);
    }
    if (session !== undefined && this.#options.managedExtensionLifecycle !== false) {
      await this.#observeRuntime("session_end", {
        reason: "delete",
        threadId,
        ...(session.branch === undefined ? {} : { branch: session.branch }),
        workspace: this.#workspaceRoot,
      });
    }
  }

  /** Publishes a front-end selection to runtime extensions without creating a durable session event. */
  setRuntimeModelSelection(input: {
    threadId: string;
    branch?: string;
    selection?: RuntimeModelSelection;
  }): void {
    if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service is closed");
    const branch = this.#extensionBranch(input.threadId, input.branch);
    const key = this.#activeToolKey(input.threadId, branch);
    if (input.selection === undefined) {
      this.#runtimeModelSelections.delete(key);
      return;
    }
    const { provider, model, reasoningEffort } = input.selection;
    if (provider === "" || model === "" || Buffer.byteLength(provider, "utf8") > 128 || Buffer.byteLength(model, "utf8") > 512) {
      throw new HarnessError("SERVICE_MODEL_SELECTION", "Runtime model selection is invalid");
    }
    if (reasoningEffort !== undefined && (reasoningEffort === "" || Buffer.byteLength(reasoningEffort, "utf8") > 128)) {
      throw new HarnessError("SERVICE_MODEL_SELECTION", "Runtime reasoning selection is invalid");
    }
    if (!this.#runtimeModelSelections.has(key) && this.#runtimeModelSelections.size >= 1_024) {
      const oldest = this.#runtimeModelSelections.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#runtimeModelSelections.delete(oldest);
    }
    this.#runtimeModelSelections.delete(key);
    this.#runtimeModelSelections.set(key, {
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    });
  }

  async setSessionName(input: {
    threadId: string;
    branch?: string;
    name?: string;
    signal?: AbortSignal;
  }): Promise<ReturnType<SessionStore["nameThread"]>> {
    if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service is closed");
    if (this.#reloading) throw new HarnessError("SERVICE_RELOADING", "Harness resources are reloading");
    input.signal?.throwIfAborted();
    const branch = this.#extensionBranch(input.threadId, input.branch);
    const thread = this.#options.store.nameThread(input.threadId, input.name);
    await this.#observeRuntime("session_info_changed", {
      threadId: input.threadId,
      branch,
      ...(thread.name === undefined ? {} : { name: thread.name }),
    }, input.signal);
    input.signal?.throwIfAborted();
    return thread;
  }

  async setSessionEntryLabel(input: {
    threadId: string;
    branch?: string;
    targetEventId: string;
    label?: string;
    signal?: AbortSignal;
  }): Promise<ReturnType<SessionStore["setEntryLabel"]>> {
    if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service is closed");
    if (this.#reloading) throw new HarnessError("SERVICE_RELOADING", "Harness resources are reloading");
    input.signal?.throwIfAborted();
    const branch = this.#extensionBranch(input.threadId, input.branch);
    const changed = this.#options.store.setEntryLabel({
      threadId: input.threadId,
      branch,
      targetEventId: input.targetEventId,
      ...(input.label === undefined ? {} : { label: input.label }),
    });
    await this.#observeRuntime("event", changed, input.signal);
    input.signal?.throwIfAborted();
    return changed;
  }

  /** Returns a bounded, transcript-visible projection of one workspace-bound branch. */
  async getTranscript(input: HarnessTranscriptRequest): Promise<HarnessTranscriptPage> {
    if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service is closed");
    if (this.#reloading) throw new HarnessError("SERVICE_RELOADING", "Harness resources are reloading");
    input.signal?.throwIfAborted();
    const branch = this.#extensionBranch(input.threadId, input.branch);
    const events = this.#options.store.listEvents(input.threadId, branch);
    return parseHarnessTranscriptPage(await projectHarnessTranscriptPage({
      threadId: input.threadId,
      branch,
      events,
      ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }));
  }

  /** Lists bounded metadata for sessions owned by this service's current workspace. */
  async listSessions(input: HarnessSessionListRequest = {}): Promise<HarnessSessionPage> {
    if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service is closed");
    if (this.#reloading) throw new HarnessError("SERVICE_RELOADING", "Harness resources are reloading");
    const request = normalizeHarnessSessionListRequest(input, this.#workspaceRoot);
    request.signal?.throwIfAborted();
    const page = this.#options.store.listThreadMetadataPage({
      workspaceRoot: this.#workspaceRoot,
      ...(request.search === undefined ? {} : { search: request.search }),
      limit: request.limit,
      ...(request.after === undefined ? {} : { after: request.after }),
    });
    request.signal?.throwIfAborted();
    return harnessSessionPage(page.threads, page.hasMore, page.next, this.#workspaceRoot, request.search);
  }

  get skills(): readonly SkillMetadata[] {
    return this.#skills;
  }

  /** Returns one deterministic, bounded metadata snapshot for every front end. */
  async resourceCatalog(signal: AbortSignal = AbortSignal.timeout(5_000)): Promise<HarnessResourceCatalog> {
    if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service is closed");
    if (this.#reloading) throw new HarnessError("SERVICE_RELOADING", "Harness resources are reloading");
    signal.throwIfAborted();
    const models = await this.#options.providers.listModels(undefined, signal, { refresh: false });
    signal.throwIfAborted();
    const groupedModels = new Map<string, typeof models>();
    for (const model of models) {
      const grouped = groupedModels.get(model.provider) ?? [];
      grouped.push(model);
      groupedModels.set(model.provider, grouped);
    }
    const tools = this.#buildTools("resource-catalog", {
      prompt: "",
      provider: "resource-catalog",
      model: "resource-catalog",
    }, 0);
    const extraTools = new Set(this.#options.extraTools ?? []);
    const toolOwner = (tool: HarnessTool): HarnessResourceOwner => {
      const owner = this.#options.runtimeExtensions?.toolOwner(tool);
      if (owner?.kind === "extension") return { kind: "extension", extensionId: owner.extensionId };
      return extraTools.has(tool) ? { kind: "host" } : { kind: "builtin" };
    };
    return buildHarnessResourceCatalog({
      tools,
      toolOwner,
      skills: this.#skills,
      providers: this.#options.providers.list().map((provider) => ({
        id: provider.id,
        models: groupedModels.get(provider.id) ?? [],
      })),
      ...(this.#options.runtimeExtensions === undefined ? {} : {
        runtimeCommands: this.#options.runtimeExtensions.commands(),
        runtimeDiagnostics: this.#options.runtimeExtensions.diagnostics(),
      }),
      ...this.#options.resourceCatalog,
    });
  }

  onExtensionSessionEvent(listener: ExtensionSessionPublicationListener): () => void {
    if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service is closed");
    this.#extensionSessionListeners.add(listener);
    return () => this.#extensionSessionListeners.delete(listener);
  }

  async resolveModelSelection(
    reference: string,
    options: ResolveModelSelectionOptions = {},
  ): Promise<ResolvedModelSelection> {
    if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service is closed");
    if (this.#reloading) throw new HarnessError("SERVICE_RELOADING", "Harness resources are reloading");
    const { signal = AbortSignal.timeout(30_000), ...resolutionOptions } = options;
    return await this.#options.providers.requireModelReference(reference, signal, resolutionOptions);
  }

  async run(options: RunOptions): Promise<HarnessRun> {
    if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service is closed");
    if (this.#reloading) throw new HarnessError("SERVICE_RELOADING", "Harness resources are reloading");
    options.signal?.throwIfAborted();
    const resumed = options.threadId !== undefined;
    const threadId = options.threadId ?? createId("thread");
    let thread = resumed ? this.#options.store.bindThreadWorkspace(threadId, this.#options.workspace) : undefined;
    const queueBranch = options.branch ?? thread?.defaultBranch ?? "main";
    this.#manager.reserve(threadId, {
      ...(options.steeringMode === undefined ? {} : { steeringMode: options.steeringMode }),
      ...(options.followUpMode === undefined ? {} : { followUpMode: options.followUpMode }),
    }, queueBranch);
    try {
      options = await this.#canonicalRunOptions(options, true);
      const cwd = this.#contextCwd(threadId, options.cwd);
      if (thread !== undefined) {
        await this.#openSession(threadId, true, cwd, options.branch ?? thread.defaultBranch, options.signal);
      } else {
        await this.#openSession(
          threadId,
          false,
          cwd,
          options.branch ?? "main",
          options.signal,
          "switch",
          () => {
            thread = this.#options.store.createThread({ threadId, workspaceRoot: this.#options.workspace });
          },
        );
      }
      if (thread === undefined) throw new HarnessError("STORAGE_WRITE", "Session creation did not produce a thread");
      const activeThread = thread;
      if (activeThread.name === undefined) {
        const normalized = (options.displayPrompt ?? options.prompt).replace(/\s+/gu, " ").trim();
        if (normalized !== "") await this.setSessionName({
          threadId,
          branch: queueBranch,
          name: normalized.length > 80 ? `${normalized.slice(0, 77)}…` : normalized,
        });
      }
      if (options.onEvent !== undefined) this.#listeners.set(threadId, options.onEvent);
      const results = await this.#run(threadId, options, 0, true);
      return { threadId, results };
    } finally {
      this.#listeners.delete(threadId);
      this.#manager.release(threadId);
      if (thread !== undefined) this.#options.store.markRunInputsRecoverable(threadId, queueBranch);
    }
  }

  async createSession(input: {
    threadId?: string;
    name?: string;
    defaultBranch?: string;
    parentThreadId?: string;
    parentRunId?: string;
    sourceEventId?: string;
    cwd?: string;
    signal?: AbortSignal;
  } = {}) {
    if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service is closed");
    if (this.#reloading) throw new HarnessError("SERVICE_RELOADING", "Harness resources are reloading");
    const threadId = input.threadId ?? createId("thread");
    if (threadId.length === 0 || threadId.includes("\0") || Buffer.byteLength(threadId, "utf8") > 256) {
      throw new HarnessError("SERVICE_SESSION_ID", "Session ID must contain 1 to 256 UTF-8 bytes and no NUL");
    }
    const branch = input.defaultBranch ?? "main";
    if (input.parentThreadId !== undefined && this.#options.runtimeExtensions?.hasListeners("session_before_fork") === true) {
      const result = await this.#options.runtimeExtensions.reduceSessionBeforeFork({
        sourceThreadId: input.parentThreadId,
        ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
        targetBranch: branch,
      }, input.signal);
      if (result.cancel === true) {
        const reason = result.reason === undefined
          ? "Session fork cancelled by a runtime extension"
          : defaultSecretRedactor.redact(result.reason);
        throw new HarnessError("EXTENSION_SESSION_CANCELLED", reason);
      }
    }
    let created: ReturnType<SessionStore["createThread"]> | undefined;
    await this.#openSession(
      threadId,
      false,
      input.cwd ?? this.#options.workspace,
      branch,
      input.signal,
      input.parentThreadId === undefined ? "switch" : "none",
      () => {
        created = this.#options.store.createThread({
          threadId,
          workspaceRoot: this.#options.workspace,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.defaultBranch === undefined ? {} : { defaultBranch: input.defaultBranch }),
          ...(input.parentThreadId === undefined ? {} : { parentThreadId: input.parentThreadId }),
          ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
        });
      },
    );
    if (created === undefined) throw new HarnessError("STORAGE_WRITE", "Session creation did not produce a thread");
    return created;
  }

  async cloneSessionPath(
    input: Omit<CloneSessionPathInput, "workspaceRoot"> & { signal?: AbortSignal },
  ): Promise<CloneSessionPathResult> {
    if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service is closed");
    if (this.#reloading) throw new HarnessError("SERVICE_RELOADING", "Harness resources are reloading");
    input.signal?.throwIfAborted();
    const source = this.#options.store.bindThreadWorkspace(input.threadId, this.#options.workspace);
    const sourceBranch = input.branch ?? source.defaultBranch;
    const branch = source.branches.find((entry) => entry.name === sourceBranch);
    if (branch === undefined) throw new Error(`Unknown branch: ${sourceBranch}`);
    const sourceEventId = typeof input.atEventId === "string"
      ? input.atEventId
      : input.beforeEventId ?? branch.headEventId;
    const extensions = this.#options.runtimeExtensions;
    if (extensions?.hasListeners("session_before_fork") === true) {
      const directive = await extensions.reduceSessionBeforeFork({
        sourceThreadId: input.threadId,
        ...(sourceEventId === undefined ? {} : { sourceEventId }),
        targetBranch: sourceBranch,
      }, input.signal);
      if (directive.cancel === true) {
        throw new HarnessError(
          "EXTENSION_SESSION_CANCELLED",
          directive.reason === undefined
            ? "Session copy cancelled by a runtime extension"
            : defaultSecretRedactor.redact(directive.reason),
        );
      }
    }
    input.signal?.throwIfAborted();
    return cloneStoredSessionPath(this.#options.store, {
      threadId: input.threadId,
      ...(input.branch === undefined ? {} : { branch: input.branch }),
      ...(input.atEventId === undefined ? {} : { atEventId: input.atEventId }),
      ...(input.beforeEventId === undefined ? {} : { beforeEventId: input.beforeEventId }),
      ...(input.name === undefined ? {} : { name: input.name }),
      workspaceRoot: this.#options.workspace,
    });
  }

  async navigateTree(options: NavigateTreeOptions): Promise<NavigateTreeResult> {
    if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service is closed");
    if (this.#reloading) throw new HarnessError("SERVICE_RELOADING", "Harness resources are reloading");
    const thread = this.#options.store.bindThreadWorkspace(options.threadId, this.#options.workspace);
    const sourceBranch = options.branch ?? thread.defaultBranch;
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(options.newBranch) || options.newBranch.includes("..")) {
      throw new Error(`Invalid branch name: ${options.newBranch}`);
    }
    if (thread.branches.some((entry) => entry.name === options.newBranch)) {
      throw new Error(`Branch already exists: ${options.newBranch}`);
    }
    if (options.summarize === true && (options.provider === undefined || options.model === undefined)) {
      throw new Error("Branch summarization requires an exact provider and model");
    }
    if (
      options.summaryTokenBudget !== undefined &&
      (!Number.isSafeInteger(options.summaryTokenBudget) || options.summaryTokenBudget < 1 || options.summaryTokenBudget > BRANCH_SUMMARY_LIMITS.maxOutputTokens)
    ) throw new Error(`Branch summary output tokens must be from 1 to ${BRANCH_SUMMARY_LIMITS.maxOutputTokens}`);
    if (
      options.summaryInstructions !== undefined &&
      (options.summaryInstructions.trim() === "" || options.summaryInstructions.includes("\0") || Buffer.byteLength(options.summaryInstructions, "utf8") > BRANCH_SUMMARY_LIMITS.maxInstructionsBytes)
    ) throw new Error(`Branch summary instructions must contain 1 to ${BRANCH_SUMMARY_LIMITS.maxInstructionsBytes} bytes without NUL`);
    if (options.label !== undefined && options.summarize !== true) {
      throw new Error("A branch summary label requires summarization");
    }
    const control = this.#manager.reserve(options.threadId);
    const signal = options.signal === undefined
      ? control.abortController.signal
      : AbortSignal.any([control.abortController.signal, options.signal]);
    try {
      signal.throwIfAborted();
      const preparation = prepareAbandonedBranch(
        this.#options.store.listEvents(options.threadId, sourceBranch),
        this.#options.store.listEvents(options.threadId, options.targetBranch),
        options.targetEventId,
      );
      if (options.label !== undefined && preparation.messages.length === 0) {
        throw new Error("A branch summary label requires abandoned conversational content");
      }
      const priorEventId = this.#options.store.listBranches(options.threadId)
        .find((entry) => entry.name === sourceBranch)?.headEventId;
      const extensions = this.#options.runtimeExtensions;
      const treeDirective = extensions?.hasListeners("session_before_tree") === true
        ? await extensions.reduceSessionBeforeTree({
            threadId: options.threadId,
            targetEventId: options.targetEventId,
            summarize: options.summarize === true,
            sourceEventIds: preparation.messages.map((entry) => entry.eventId),
          }, signal)
        : undefined;
      signal.throwIfAborted();
      if (treeDirective?.cancel === true) return { cancelled: true };
      let generated: Awaited<ReturnType<typeof generateBranchSummary>> | undefined;
      if (options.summarize === true && preparation.messages.length > 0) {
        if (treeDirective?.summary === undefined) {
          let modelMaxOutputTokens: number | undefined;
          try {
            modelMaxOutputTokens = (await this.#options.providers.resolveModel(
              options.provider!,
              options.model!,
              signal,
            ))?.maxOutputTokens;
          } catch {
            signal.throwIfAborted();
          }
          const summaryMaxOutputTokens = cappedExplicitMaxOutputTokens(
            options.summaryTokenBudget ?? BRANCH_SUMMARY_LIMITS.defaultOutputTokens,
            modelMaxOutputTokens,
          );
          generated = await generateBranchSummary(preparation, {
            provider: this.#options.providers.get(options.provider!),
            model: options.model!,
            signal,
            ...(summaryMaxOutputTokens === undefined ? {} : { maxOutputTokens: summaryMaxOutputTokens }),
            ...(options.summaryInstructions === undefined ? {} : { instructions: options.summaryInstructions }),
          });
        } else {
          generated = this.#extensionBranchSummary(
            treeDirective.summary.text,
            preparation.messages.map((entry) => entry.eventId),
            options.summaryTokenBudget,
            preparation.fileActivity,
          );
        }
        if (generated.cancelled) return { cancelled: true };
      }
      signal.throwIfAborted();
      if (generated !== undefined && !generated.cancelled) {
        const durableSummary = defaultSecretRedactor.redactValue(generated.summary) as CanonicalMessage;
        const treeMetadata = treeDirective?.summary?.metadata;
        const committed = this.#options.store.forkBranchWithSummary({
          threadId: options.threadId,
          fromBranch: options.targetBranch,
          newBranch: options.newBranch,
          atEventId: options.targetEventId,
          summary: durableSummary,
          sourceBranch,
          sourceEventIds: generated.sourceEventIds,
          ...(treeMetadata === undefined
            ? {}
            : { extensionMetadata: defaultSecretRedactor.redactValue(treeMetadata) as typeof treeMetadata }),
          ...(options.label === undefined ? {} : { label: options.label }),
        });
        await this.#observeRuntime("session_tree", {
          threadId: options.threadId,
          ...(priorEventId === undefined ? {} : { previousEventId: priorEventId }),
          currentEventId: committed.summaryEvent.eventId,
          summary: committed.summaryEvent.event.summary,
          ...(committed.summaryEvent.event.extensionMetadata === undefined
            ? {}
            : { metadata: committed.summaryEvent.event.extensionMetadata }),
          fromExtension: treeDirective?.summary !== undefined,
        });
        this.#rememberSessionBranch(options.threadId, committed.branch.name);
        return { cancelled: false, branch: committed.branch, summaryEvent: committed.summaryEvent };
      }
      const branch = this.#options.store.forkBranch({
        threadId: options.threadId,
        fromBranch: options.targetBranch,
        newBranch: options.newBranch,
        atEventId: options.targetEventId,
      });
      await this.#observeRuntime("session_tree", {
        threadId: options.threadId,
        ...(priorEventId === undefined ? {} : { previousEventId: priorEventId }),
        ...(branch.headEventId === undefined ? {} : { currentEventId: branch.headEventId }),
        fromExtension: false,
      });
      this.#rememberSessionBranch(options.threadId, branch.name);
      return { cancelled: false, branch };
    } catch (error) {
      if (signal.aborted) return { cancelled: true };
      throw error;
    } finally {
      this.#manager.release(options.threadId);
    }
  }

  async compact(options: Omit<RunOptions, "prompt" | "manualCompaction"> & { threadId: string }): Promise<AgentRunResult> {
    if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service is closed");
    if (this.#reloading) throw new HarnessError("SERVICE_RELOADING", "Harness resources are reloading");
    options = await this.#canonicalRunOptions(options, true);
    const thread = this.#options.store.bindThreadWorkspace(options.threadId, this.#options.workspace);
    const branch = options.branch ?? thread.defaultBranch;
    if (options.compactionInstructions !== undefined && (options.compactionInstructions.trim() === "" || Buffer.byteLength(options.compactionInstructions) > 16 * 1024)) {
      throw new Error("Compaction instructions must contain 1 to 16384 bytes");
    }
    await this.#openSession(options.threadId, true, this.#contextCwd(options.threadId, options.cwd), branch, options.signal);
    if (options.onEvent !== undefined) this.#listeners.set(options.threadId, options.onEvent);
    try {
      const [result] = await this.#run(options.threadId, {
        ...options,
        branch,
        prompt: "",
        manualCompaction: true,
      }, 0);
      if (result === undefined) throw new HarnessError("SERVICE_COMPACTION", "Manual compaction returned no result");
      return result;
    } finally {
      this.#listeners.delete(options.threadId);
      this.#options.store.markRunInputsRecoverable(options.threadId, branch);
    }
  }

  #runInputMessage(record: RunInputQueueRecord): QueuedRunMessage {
    return {
      mode: record.mode,
      text: record.text,
      ...(record.images === undefined ? {} : { images: record.images.map((image) => ({ ...image })) }),
    };
  }

  #queueBranch(threadId: string, branch?: string): string {
    const activeBranch = this.#manager.activeBranch(threadId);
    if (activeBranch !== undefined) {
      if (branch !== undefined && branch !== activeBranch) {
        throw new HarnessError("SERVICE_QUEUE_BRANCH", `Active run is on branch ${activeBranch}, not ${branch}`);
      }
      return activeBranch;
    }
    const thread = this.#options.store.bindThreadWorkspace(threadId, this.#options.workspace);
    return branch ?? this.#sessions.get(threadId)?.branch ?? thread.defaultBranch;
  }

  #enqueueRunInput(
    threadId: string,
    mode: QueuedRunMessage["mode"],
    message: string,
    images?: ImageBlock[],
  ): void {
    this.#options.store.bindThreadWorkspace(threadId, this.#options.workspace);
    if (this.#childRunDepth.has(threadId)) {
      throw new HarnessError(
        "RUNTIME_CHILD_QUEUE",
        "Active runtime child runs do not accept steering or follow-up messages",
      );
    }
    const branch = this.#manager.activeBranch(threadId);
    if (branch === undefined) throw new Error(`Thread has no active run: ${threadId}`);
    const record = this.#options.store.enqueueRunInput({
      threadId,
      branch,
      mode,
      text: message,
      ...(images === undefined ? {} : { images }),
    });
    let leased = false;
    const receipt: QueuedRunDeliveryReceipt = {
      queueId: record.queueId,
      messageId: record.messageId,
      begin: (): void => {
        if (!leased) this.#options.store.beginRunInputDelivery(record.queueId, threadId, branch);
      },
      delivered: (): void => leased
        ? this.#options.store.acknowledgeRunInputLease(record.queueId, threadId, branch)
        : this.#options.store.completeRunInputDelivery(record.queueId, threadId, branch),
      dequeued: (): void => this.#options.store.dequeueRunInput(record.queueId, threadId, branch),
      leased: (): void => {
        this.#options.store.leaseRunInput(record.queueId, threadId, branch);
        leased = true;
      },
    };
    try {
      if (mode === "follow_up") this.#manager.followUp(threadId, message, images, receipt);
      else this.#manager.steer(threadId, message, images, receipt);
    } catch (error) {
      this.#options.store.markRunInputRecoverable(record.queueId, threadId, branch);
      throw error;
    }
  }

  steer(threadId: string, message: string, images?: ImageBlock[]): void {
    this.#enqueueRunInput(threadId, "steer", message, images);
  }

  followUp(threadId: string, message: string, images?: ImageBlock[]): void {
    this.#enqueueRunInput(threadId, "follow_up", message, images);
  }

  queuedMessages(threadId: string, branch?: string): QueuedRunMessage[] {
    this.#options.store.bindThreadWorkspace(threadId, this.#options.workspace);
    const selectedBranch = this.#queueBranch(threadId, branch);
    const recovered = this.#options.store.listRunInputs(threadId, selectedBranch, ["recoverable"])
      .map((record) => this.#runInputMessage(record));
    return [...recovered, ...this.#manager.queuedMessages(threadId)];
  }

  recoverableMessageCount(threadId: string, branch?: string): number {
    this.#options.store.bindThreadWorkspace(threadId, this.#options.workspace);
    const selectedBranch = this.#queueBranch(threadId, branch);
    return this.#options.store.listRunInputs(threadId, selectedBranch, ["recoverable"]).length;
  }

  queueModes(threadId: string): { steeringMode: QueueMode; followUpMode: QueueMode } | undefined {
    return this.#manager.queueModes(threadId);
  }

  setQueueModes(
    threadId: string,
    modes: { steeringMode?: QueueMode; followUpMode?: QueueMode },
  ): { steeringMode: QueueMode; followUpMode: QueueMode } {
    return this.#manager.setQueueModes(threadId, modes);
  }

  dequeue(threadId: string, branch?: string): QueuedRunMessage[] {
    const messages: QueuedRunMessage[] = [];
    while (true) {
      const lease = this.leaseOne(threadId, branch);
      if (lease === undefined) return messages;
      this.acknowledgeQueueLease(lease);
      messages.push(lease.message);
    }
  }

  dequeueOne(threadId: string, branch?: string): QueuedRunMessage | undefined {
    const lease = this.leaseOne(threadId, branch);
    if (lease === undefined) return undefined;
    this.acknowledgeQueueLease(lease);
    return lease.message;
  }

  leaseOne(threadId: string, branch?: string): RunInputQueueLease | undefined {
    this.#options.store.bindThreadWorkspace(threadId, this.#options.workspace);
    const selectedBranch = this.#queueBranch(threadId, branch);
    const recovered = this.#options.store.listRunInputs(threadId, selectedBranch, ["recoverable"])[0];
    if (recovered !== undefined) {
      this.#options.store.leaseRunInput(recovered.queueId, threadId, selectedBranch);
      const message = this.#runInputMessage(recovered);
      attachQueuedRunDelivery(message, {
        queueId: recovered.queueId,
        messageId: recovered.messageId,
        begin: () => {},
        delivered: () => this.#options.store.acknowledgeRunInputLease(recovered.queueId, threadId, selectedBranch),
        dequeued: () => this.#options.store.acknowledgeRunInputLease(recovered.queueId, threadId, selectedBranch),
        leased: () => {},
      });
      return {
        leaseId: recovered.queueId,
        messageId: recovered.messageId,
        threadId,
        branch: selectedBranch,
        message,
      };
    }
    const message = this.#manager.leaseOne(threadId);
    if (message === undefined) return undefined;
    const leaseId = queuedRunDeliveryId(message);
    const messageId = queuedRunDeliveryMessageId(message);
    if (leaseId === undefined || messageId === undefined) throw new HarnessError("SERVICE_QUEUE_LEASE", "Active queue item has no durable lease id");
    return { leaseId, messageId, threadId, branch: selectedBranch, message };
  }

  acknowledgeQueueLease(lease: Pick<RunInputQueueLease, "leaseId" | "threadId" | "branch">): void {
    this.#options.store.bindThreadWorkspace(lease.threadId, this.#options.workspace);
    this.#options.store.acknowledgeRunInputLease(lease.leaseId, lease.threadId, lease.branch);
  }

  releaseQueueLease(lease: Pick<RunInputQueueLease, "leaseId" | "threadId" | "branch">): void {
    this.#options.store.bindThreadWorkspace(lease.threadId, this.#options.workspace);
    this.#options.store.releaseRunInputLease(lease.leaseId, lease.threadId, lease.branch);
  }

  cancel(threadId: string, reason?: string): void {
    this.#manager.cancel(threadId, reason);
  }

  async replaceRuntimeResources(
    resources: HarnessRuntimeResources,
    options: { signal?: AbortSignal; commit?: () => void | Promise<void> } = {},
  ): Promise<void> {
    if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service is closed");
    if (this.#reloading) throw new HarnessError("SERVICE_RELOADING", "Harness resources are already reloading");
    if (this.#manager.activeCount() !== 0 || this.#activeChildRuns !== 0) {
      throw new HarnessError("SERVICE_BUSY", "Cannot reload resources while a run is active");
    }
    const childRunPolicy = normalizeChildRunPolicy(resources.childRuns);
    const previous = {
      providers: this.#options.providers,
      projectTrusted: this.#options.projectTrusted,
      extraTools: this.#options.extraTools,
      toolBackend: this.#options.toolBackend,
      outboundImages: this.#options.outboundImages,
      runtimeExtensions: this.#options.runtimeExtensions,
      shellPath: this.#options.shellPath,
      autoCompaction: this.#options.autoCompaction,
      compactionRetainRecentTurns: this.#options.compactionRetainRecentTurns,
      compactionToolResultBytes: this.#options.compactionToolResultBytes,
      retry: this.#options.retry,
      childRunPolicy: this.#childRunPolicy,
      resourceCatalog: this.#options.resourceCatalog,
      skills: this.#skills,
    };
    const sessions = [...this.#sessions.entries()];
    this.#reloading = true;
    let applied = false;
    let sessionsEnded = false;
    try {
      if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service closed while resources were reloading");
      options.signal?.throwIfAborted();
      if (this.#manager.activeCount() !== 0 || this.#activeChildRuns !== 0) {
        throw new HarnessError("SERVICE_BUSY", "Cannot reload resources while a run is active");
      }
      if (this.#options.managedExtensionLifecycle !== false) {
        await Promise.allSettled(sessions.map(async ([threadId, session]) => await this.#observeRuntime("session_end", {
          reason: "reload",
          threadId,
          ...(session.branch === undefined ? {} : { branch: session.branch }),
          workspace: this.#workspaceRoot,
        })));
      }
      sessionsEnded = true;
      this.#options.providers = resources.providers;
      this.#options.projectTrusted = resources.projectTrusted;
      this.#options.extraTools = resources.extraTools;
      if (resources.toolBackend === undefined) delete this.#options.toolBackend;
      else this.#options.toolBackend = resources.toolBackend;
      this.#options.outboundImages = resources.outboundImages ?? "allow";
      if (resources.runtimeExtensions === undefined) delete this.#options.runtimeExtensions;
      else this.#options.runtimeExtensions = resources.runtimeExtensions;
      if (resources.shellPath === undefined) delete this.#options.shellPath;
      else this.#options.shellPath = resources.shellPath;
      if (resources.autoCompaction === undefined) delete this.#options.autoCompaction;
      else this.#options.autoCompaction = resources.autoCompaction;
      if (resources.compactionRetainRecentTurns === undefined) delete this.#options.compactionRetainRecentTurns;
      else this.#options.compactionRetainRecentTurns = resources.compactionRetainRecentTurns;
      if (resources.compactionToolResultBytes === undefined) delete this.#options.compactionToolResultBytes;
      else this.#options.compactionToolResultBytes = resources.compactionToolResultBytes;
      if (resources.retry === undefined) delete this.#options.retry;
      else this.#options.retry = { ...resources.retry };
      this.#childRunPolicy = childRunPolicy;
      if (resources.resourceCatalog === undefined) delete this.#options.resourceCatalog;
      else this.#options.resourceCatalog = resources.resourceCatalog;
      this.#bindExtensionSessionHost(this.#options.runtimeExtensions);
      this.#skills = [...resources.skills];
      await options.commit?.();
      applied = true;
      if (sessionsEnded) {
        if (this.#options.managedExtensionLifecycle !== false) {
          await Promise.allSettled(sessions.map(async ([threadId, session]) => await this.#observeRuntime("session_start", {
            reason: "reload",
            threadId,
            ...(session.branch === undefined ? {} : { branch: session.branch }),
            workspace: this.#workspaceRoot,
          })));
        }
      }
    } catch (error) {
      if (applied) throw error;
      this.#options.providers = previous.providers;
      if (previous.projectTrusted === undefined) delete this.#options.projectTrusted;
      else this.#options.projectTrusted = previous.projectTrusted;
      if (previous.extraTools === undefined) delete this.#options.extraTools;
      else this.#options.extraTools = previous.extraTools;
      if (previous.toolBackend === undefined) delete this.#options.toolBackend;
      else this.#options.toolBackend = previous.toolBackend;
      if (previous.outboundImages === undefined) delete this.#options.outboundImages;
      else this.#options.outboundImages = previous.outboundImages;
      if (previous.runtimeExtensions === undefined) delete this.#options.runtimeExtensions;
      else this.#options.runtimeExtensions = previous.runtimeExtensions;
      if (previous.shellPath === undefined) delete this.#options.shellPath;
      else this.#options.shellPath = previous.shellPath;
      if (previous.autoCompaction === undefined) delete this.#options.autoCompaction;
      else this.#options.autoCompaction = previous.autoCompaction;
      if (previous.compactionRetainRecentTurns === undefined) delete this.#options.compactionRetainRecentTurns;
      else this.#options.compactionRetainRecentTurns = previous.compactionRetainRecentTurns;
      if (previous.compactionToolResultBytes === undefined) delete this.#options.compactionToolResultBytes;
      else this.#options.compactionToolResultBytes = previous.compactionToolResultBytes;
      if (previous.retry === undefined) delete this.#options.retry;
      else this.#options.retry = { ...previous.retry };
      this.#childRunPolicy = previous.childRunPolicy;
      if (previous.resourceCatalog === undefined) delete this.#options.resourceCatalog;
      else this.#options.resourceCatalog = previous.resourceCatalog;
      this.#bindExtensionSessionHost(this.#options.runtimeExtensions);
      this.#skills = previous.skills;
      if (this.#options.managedExtensionLifecycle !== false) {
        await Promise.allSettled(sessions.map(async ([threadId, session]) => await this.#observeRuntime("session_start", {
          reason: "reload_rollback",
          threadId,
          ...(session.branch === undefined ? {} : { branch: session.branch }),
          workspace: this.#workspaceRoot,
        })));
      }
      throw error;
    } finally {
      this.#reloading = false;
    }
  }

  async close(reason = "runtime_close"): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#reloading = false;
    const sessions = [...this.#sessions.entries()];
    this.#sessions.clear();
    await Promise.allSettled(sessions.map(async ([threadId, session]) => {
      if (this.#options.managedExtensionLifecycle !== false) {
        await this.#observeRuntime("session_end", {
          reason,
          threadId,
          ...(session.branch === undefined ? {} : { branch: session.branch }),
          workspace: this.#workspaceRoot,
        });
      }
    }));
    this.#pendingExtensionTurns.clear();
    this.#extensionSessionCleanup?.();
    this.#extensionSessionCleanup = undefined;
    this.#extensionSessionListeners.clear();
    this.#activeToolSelections.clear();
    this.#activeToolRuns.clear();
    this.#runtimeModelSelections.clear();
  }

  async #canonicalRunOptions<T extends Pick<RunOptions, "provider" | "model" | "reasoningEffort" | "signal">>(
    options: T,
    refreshStale: boolean,
  ): Promise<T> {
    const status = refreshStale ? (await this.#options.providers.catalogStatus(options.provider))[0] : undefined;
    const refresh = status !== undefined && (status.provenance === "none" || status.stale);
    const resolutionSignal = options.signal === undefined
      ? AbortSignal.timeout(30_000)
      : AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]);
    const selected = await this.#options.providers.requireModelReference(
      options.model,
      resolutionSignal,
      {
        provider: options.provider,
        refresh,
        allowUnknownModel: true,
        ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
      },
    );
    const { provider: _provider, model: _model, reasoningEffort: _reasoningEffort, ...rest } = options;
    return {
      ...rest,
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    } as T;
  }

  async #run(threadId: string, options: RunOptions, depth: number, reserved = false): Promise<AgentRunResult[]> {
    options = await this.#canonicalRunOptions(options, false);
    const outboundImages = options.outboundImages ?? this.#options.outboundImages ?? "allow";
    if (outboundImages !== "allow" && outboundImages !== "block") {
      throw new Error("outboundImages must be allow or block");
    }
    if (options.autoCompaction !== undefined && typeof options.autoCompaction !== "boolean") {
      throw new Error("autoCompaction must be a boolean");
    }
    const autoCompaction = options.autoCompaction ?? this.#options.autoCompaction;
    if (
      options.additionalInstructions !== undefined &&
      (
        options.additionalInstructions.text.trim() === "" ||
        Buffer.byteLength(options.additionalInstructions.text, "utf8") > 32 * 1024 ||
        options.additionalInstructions.source.trim() === "" ||
        options.additionalInstructions.source.includes("\0") ||
        Buffer.byteLength(options.additionalInstructions.source, "utf8") > 256
      )
    ) throw new Error("Additional instructions must contain bounded text and a bounded source label");
    const provider = this.#options.providers.runtimeAdapter(options.provider);
    let automaticContextBudget: ReturnType<typeof resolveEffectiveContextBudget> | undefined;
    let resolvedModel: Awaited<ReturnType<ProviderRegistry["resolveModel"]>>;
    try {
      resolvedModel = await this.#options.providers.resolveModel(
        options.provider,
        options.model,
        AbortSignal.timeout(10_000),
      );
    } catch {
      resolvedModel = undefined;
    }
    const supportsImages = resolvedModel?.capabilities.images.value === "unsupported"
      ? false
      : resolvedModel?.capabilities.images.value === "supported"
        ? true
        : undefined;
    const maxOutputTokens = cappedExplicitMaxOutputTokens(options.maxOutputTokens, resolvedModel?.maxOutputTokens);
    if (options.contextTokenBudget === undefined) {
      automaticContextBudget = resolveEffectiveContextBudget(
        resolvedModel,
        options.maxOutputTokens === undefined ? {} : { requestedMaxOutputTokens: options.maxOutputTokens },
      );
    }
    const contextCwd = this.#contextCwd(threadId, options.cwd);
    const toolBackend = options.toolBackend === undefined ? this.#options.toolBackend : options.toolBackend ?? undefined;
    const processRunner = new DirectProcessRunner();
    const tools = this.#buildTools(threadId, { ...options, outboundImages, cwd: contextCwd }, depth);
    const allowed = options.allowedTools === undefined
      ? tools
      : tools.filter((tool) => options.allowedTools?.includes(tool.definition.name));
    const excluded = new Set(options.excludedTools ?? []);
    const initiallyActive = allowed.filter((tool) => !excluded.has(tool.definition.name));
    const activeToolBranch = this.#extensionBranch(threadId, options.branch);
    const activeToolKey = this.#activeToolKey(threadId, activeToolBranch);
    this.setRuntimeModelSelection({
      threadId,
      branch: activeToolBranch,
      selection: {
        provider: options.provider,
        model: options.model,
        ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
      },
    });
    const desiredTools = this.#activeToolSelections.get(activeToolKey);
    const availableToolNames = new Set(initiallyActive.map((tool) => tool.definition.name));
    const unavailableDesiredTools = desiredTools?.names.filter((name) => !availableToolNames.has(name)) ?? [];
    if (desiredTools !== undefined && unavailableDesiredTools.length > 0) {
      throw new HarnessError(
        "EXTENSION_ACTIVE_TOOLS",
        `Active tool selection from ${desiredTools.requesterExtensionId} conflicts with this run's allowed/excluded tool options; unavailable: ${unavailableDesiredTools.join(", ")}`,
      );
    }
    const promptTools = desiredTools === undefined
      ? initiallyActive
      : desiredTools.names.flatMap((name) => initiallyActive.filter((tool) => tool.definition.name === name));
    const loadRunContext = async () => {
      const instructions = await discoverInstructions({
        workspaceRoot: this.#options.workspace,
        cwd: contextCwd,
        trusted: this.#options.projectTrusted ?? false,
        ...(this.#options.userInstructions === undefined ? {} : { userInstructions: this.#options.userInstructions }),
        ...(this.#options.userInstructionFile === undefined ? {} : { userInstructionFile: this.#options.userInstructionFile }),
        ...(options.noContextFiles === true ? { includeFiles: false } : {}),
      });
      const automaticPromptFiles = options.noContextFiles === true
        ? {}
        : await discoverWorkspacePromptFiles(
            this.#options.workspace,
            this.#options.projectTrusted ?? false,
            { includeSystemPrompt: options.systemPrompt === undefined },
          );
      const customPrompt = options.systemPrompt ?? automaticPromptFiles.systemPrompt;
      const appendedPrompts = [
        ...(automaticPromptFiles.appendSystemPrompt ?? []),
        ...(options.appendSystemPrompt ?? []),
      ];
      const systemPrompt = buildSystemPrompt({
        workspace: this.#options.workspace,
        instructions,
        skills: this.#skills,
        selectedTools: promptTools.map((tool) => tool.definition.name),
        toolMetadata: promptTools.map((tool) => tool.definition),
        ...(options.additionalInstructions === undefined ? {} : { additionalInstructions: options.additionalInstructions }),
        ...(customPrompt === undefined ? {} : { customPrompt }),
        ...(appendedPrompts.length === 0 ? {} : { appendSystemPrompt: appendedPrompts }),
      });
      return {
        systemPrompt,
        promptComposition: promptComposition({
          systemPrompt,
          instructions,
          selectedTools: promptTools.map((tool) => tool.definition.name),
          skills: this.#skills,
          ...(customPrompt === undefined ? {} : { customPrompt }),
          appendSystemPrompt: appendedPrompts,
          ...(options.additionalInstructions === undefined
            ? {}
            : { additionalInstructions: options.additionalInstructions }),
        }),
        initialMessages: options.manualCompaction === true
          ? []
          : this.#instructionMessages(threadId, options.branch, systemPrompt),
      };
    };
    const initialContext = await loadRunContext();
    const registry = new ToolRegistry(initiallyActive);
    const coordinator = new ToolCoordinator(
      registry,
      {},
      {
        text: (value) => defaultSecretRedactor.redact(value),
        value: (value) => defaultSecretRedactor.redactValue(value) as typeof value,
      },
      {
        ...(this.#options.runtimeExtensions?.hasListeners("tool_call") === true
          ? {
              beforeCall: async (invocation, context) =>
                await this.#options.runtimeExtensions!.reduceToolCall({
                  ...invocation,
                  threadId: context.threadId,
                  runId: context.runId,
                  branch: activeToolBranch,
                }, context.signal),
            }
          : {}),
        ...(this.#options.runtimeExtensions?.hasListeners("tool_result") === true
          ? {
              afterResult: async (
                invocation: Parameters<RuntimeExtensionHost["reduceToolCall"]>[0],
                result: Parameters<RuntimeExtensionHost["reduceToolResult"]>[0]["result"],
                context: { signal: AbortSignal },
              ) => await this.#options.runtimeExtensions!.reduceToolResult({ invocation, result }, context.signal),
            }
          : {}),
      },
      { activeTools: initiallyActive.map((tool) => tool.definition.name).sort((left, right) => left.localeCompare(right)) },
    );
    const extensionReducers = this.#agentExtensionReducers();
    await this.#observeRuntime("model_select", {
      threadId,
      ...(options.branch === undefined ? {} : { branch: options.branch }),
      provider: options.provider,
      model: options.model,
      source: "run",
    });
    await this.#observeRuntime("thinking_level_select", {
      threadId,
      ...(options.branch === undefined ? {} : { branch: options.branch }),
      level: options.reasoningEffort ?? "off",
      source: "run",
    });
    let promptQueueMessage: QueuedRunMessage | undefined;
    if (options.queueLease !== undefined) {
      const selectedBranch = options.branch ?? this.#options.store.getThread(threadId).defaultBranch;
      if (options.queueLease.threadId !== threadId || options.queueLease.branch !== selectedBranch) {
        throw new HarnessError("SERVICE_QUEUE_BRANCH", "Queue lease does not belong to this thread and branch");
      }
      promptQueueMessage = cloneQueuedRunMessage(options.queueLease.message);
      promptQueueMessage.text = options.prompt;
      if (options.images === undefined) delete promptQueueMessage.images;
      else promptQueueMessage.images = options.images.map((image) => ({ ...image }));
    }
    if (desiredTools !== undefined) {
      coordinator.queueActiveTools(desiredTools.names);
    }
    const activeToolRun = { coordinator, tools: [...initiallyActive] };
    this.#activeToolRuns.set(activeToolKey, activeToolRun);
    try {
      const request = {
        threadId,
        ...(options.branch === undefined ? {} : { branch: options.branch }),
        prompt: options.prompt,
        ...(options.displayPrompt === undefined ? {} : { displayPrompt: options.displayPrompt }),
        ...(options.images === undefined ? {} : { images: options.images }),
        ...(promptQueueMessage === undefined ? {} : { promptQueueMessage }),
        outboundImages,
        ...(supportsImages === undefined ? {} : { supportsImages }),
        provider,
        model: options.model,
        ...(this.#options.runtimeExtensions === undefined || this.#options.runtimeExtensions.extensions().length === 0
          ? {}
          : {
              refreshTurnSelection: async (
                current: Parameters<NonNullable<AgentRunRequest["refreshTurnSelection"]>>[0],
                signal: AbortSignal,
              ) => {
                const stored = this.#options.store.getModelSelection(threadId, activeToolBranch);
                if (
                  stored === undefined ||
                  (
                    stored.provider === current.provider &&
                    stored.model === current.model &&
                    stored.reasoningEffort === current.reasoningEffort
                  )
                ) return undefined;
                const selected = await this.#options.providers.requireModelReference(stored.model, signal, {
                  provider: stored.provider,
                  refresh: false,
                  allowUnknownModel: true,
                  ...(stored.reasoningEffort === undefined ? {} : { reasoningEffort: stored.reasoningEffort }),
                });
                const selectedSupportsImages = selected.info?.capabilities.images.value === "unsupported"
                  ? false
                  : selected.info?.capabilities.images.value === "supported"
                    ? true
                    : undefined;
                const selectedContextBudget = options.contextTokenBudget === undefined
                  ? resolveEffectiveContextBudget(
                      selected.info,
                      options.maxOutputTokens === undefined ? {} : { requestedMaxOutputTokens: options.maxOutputTokens },
                    )
                  : undefined;
                const selectedMaxOutputTokens = cappedExplicitMaxOutputTokens(
                  options.maxOutputTokens,
                  selected.info?.maxOutputTokens,
                );
                return {
                  provider: this.#options.providers.runtimeAdapter(selected.provider),
                  model: selected.model,
                  ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
                  ...(selectedSupportsImages === undefined ? {} : { supportsImages: selectedSupportsImages }),
                  ...(options.contextTokenBudget !== undefined
                    ? { contextTokenBudget: options.contextTokenBudget }
                    : selectedContextBudget === undefined
                      ? {}
                      : {
                          contextTokenBudget: selectedContextBudget.maxInputTokens,
                          contextTriggerTokens: selectedContextBudget.compactAtTokens,
                        }),
                  ...(selectedMaxOutputTokens === undefined ? {} : { maxOutputTokens: selectedMaxOutputTokens }),
                  maxOutputTokenLimit: selected.info?.maxOutputTokens ?? null,
                };
              },
            }),
        tools: coordinator,
        toolContext: {
          workspace: this.#workspaceBoundary ?? await WorkspaceBoundary.create(this.#options.workspace),
          runner: processRunner,
          ...(toolBackend === undefined ? {} : { backend: toolBackend }),
          artifacts: new StoreArtifactWriter(this.#options.store, threadId),
          branch: activeToolBranch,
        },
        initialMessages: initialContext.initialMessages,
        systemPrompt: initialContext.systemPrompt,
        promptComposition: initialContext.promptComposition,
        ...(extensionReducers === undefined ? {} : { extensions: extensionReducers }),
        ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        ...(resolvedModel?.maxOutputTokens === undefined ? {} : { maxOutputTokenLimit: resolvedModel.maxOutputTokens }),
        ...(options.contextTokenBudget !== undefined
          ? { contextTokenBudget: options.contextTokenBudget }
          : automaticContextBudget === undefined
            ? {}
            : {
                contextTokenBudget: automaticContextBudget.maxInputTokens,
                contextTriggerTokens: automaticContextBudget.compactAtTokens,
              }),
        ...(options.summaryTokenBudget === undefined ? {} : { summaryTokenBudget: options.summaryTokenBudget }),
        ...(autoCompaction === undefined ? {} : { autoCompaction }),
        ...(this.#options.compactionRetainRecentTurns === undefined ? {} : { compactionRetainRecentTurns: this.#options.compactionRetainRecentTurns }),
        ...(this.#options.compactionToolResultBytes === undefined ? {} : { compactionToolResultBytes: this.#options.compactionToolResultBytes }),
        ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
        ...(options.manualCompaction === true ? { manualCompaction: true } : {}),
        ...(options.compactionInstructions === undefined ? {} : { compactionInstructions: options.compactionInstructions }),
        ...(options.steeringMode === undefined ? {} : { steeringMode: options.steeringMode }),
        ...(options.followUpMode === undefined ? {} : { followUpMode: options.followUpMode }),
        ...(this.#options.retry === undefined ? {} : { retry: { ...this.#options.retry } }),
      } satisfies AgentRunRequest;
      const running = reserved
        ? this.#manager.startReserved(request, options.manualCompaction === true ? undefined : loadRunContext)
        : this.#manager.start(request, options.manualCompaction === true ? undefined : loadRunContext);
      if (options.signal === undefined) return await running;
      const cancel = (): void => this.#manager.cancel(threadId, "Run cancelled by caller");
      options.signal.addEventListener("abort", cancel, { once: true });
      if (options.signal.aborted) cancel();
      try {
        return await running;
      } finally {
        options.signal.removeEventListener("abort", cancel);
      }
    } finally {
      if (this.#activeToolRuns.get(activeToolKey) === activeToolRun) this.#activeToolRuns.delete(activeToolKey);
    }
  }

  #agentExtensionReducers(): AgentExtensionReducers | undefined {
    const extensions = this.#options.runtimeExtensions;
    if (extensions === undefined) return undefined;
    const beforeAgentStart = extensions.hasListeners("before_agent_start");
    const context = extensions.hasListeners("context");
    const messageEnd = extensions.hasListeners("message_end");
    const beforeProviderRequest = extensions.hasListeners("before_provider_request");
    if (!beforeAgentStart && !context && !messageEnd && !beforeProviderRequest) return undefined;
    return {
      ...(beforeAgentStart
        ? { beforeAgentStart: async (event, signal) => await extensions.reduceBeforeAgentStart(event, signal) }
        : {}),
      ...(context
        ? { context: async (messages, signal) => await extensions.reduceContext(messages, signal) }
        : {}),
      ...(messageEnd
        ? { messageEnd: async (message, signal) => await extensions.reduceMessageEnd(message, signal) }
        : {}),
      ...(beforeProviderRequest
        ? {
            beforeProviderRequest: async (event, signal) => await extensions.reduceBeforeProviderRequest(event, signal),
          }
        : {}),
    };
  }

  #extensionBranchSummary(
    text: string,
    sourceEventIds: string[],
    requestedTokens: number | undefined,
    fileActivity: CompactionFileActivity,
  ) {
    const maximumTokens = requestedTokens ?? BRANCH_SUMMARY_LIMITS.defaultOutputTokens;
    const activity = renderCompactionFileActivity(fileActivity, Math.min(512, Math.floor(maximumTokens / 2)));
    const normalized = stripCompactionFileActivity(defaultSecretRedactor.redact(text)).trim();
    const summaryText = `[Abandoned branch summary]\n${normalized}${activity.text}`;
    if (
      normalized === "" ||
      normalized.includes("\0") ||
      Buffer.byteLength(summaryText, "utf8") > BRANCH_SUMMARY_LIMITS.maxOutputBytes ||
      estimateTextTokens(summaryText) > maximumTokens
    ) {
      throw new HarnessError(
        "EXTENSION_BRANCH_SUMMARY",
        `Runtime branch summary must be non-empty and fit ${maximumTokens} tokens / ${BRANCH_SUMMARY_LIMITS.maxOutputBytes} bytes`,
      );
    }
    return {
      cancelled: false as const,
      summary: {
        id: createId("msg"),
        role: "user" as const,
        content: [{ type: "text" as const, text: summaryText }],
        createdAt: new Date().toISOString(),
        purpose: "compaction" as const,
      },
      sourceEventIds: [...sourceEventIds],
    };
  }

  #instructionMessages(threadId: string, branch: string | undefined, prompt: string): CanonicalMessage[] {
    const events = this.#options.store.listEvents(threadId, branch);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]?.event;
      if (event?.type !== "message_appended" || event.message.purpose !== "instructions") continue;
      return instructionMatches(event.message, prompt) ? [] : [instructionMessage(prompt)];
    }
    return [instructionMessage(prompt)];
  }

  #contextCwd(threadId: string, requested: string | undefined): string {
    return requested ?? this.#sessions.get(threadId)?.cwd ?? this.#options.workspace;
  }

  #rememberSessionBranch(threadId: string, branch: string): void {
    const session = this.#sessions.get(threadId);
    if (session !== undefined) this.#sessions.set(threadId, { ...session, branch });
  }

  #buildTools(_threadId: string, options: RunOptions, _depth: number): HarnessTool[] {
    const builtins: HarnessTool[] = [
      new ReadTool(),
      new GrepTool(),
      new FindTool(),
      new LsTool(),
      new WriteTool(),
      new EditTool(),
      new ShellTool("bash", this.#options.shellPath === undefined ? {} : { shellPath: this.#options.shellPath }),
    ];
    const tools = new Map<string, HarnessTool>();
    if (options.noBuiltinTools !== true) {
      for (const tool of builtins) tools.set(tool.definition.name, tool);
    }
    for (const tool of this.#options.extraTools ?? []) tools.set(tool.definition.name, tool);
    return [...tools.values()];
  }

  async #openSession(
    threadId: string,
    resumed: boolean,
    cwd: string,
    branch: string | undefined,
    signal?: AbortSignal,
    runtimeGuard: "switch" | "none" = "switch",
    prepare?: () => void,
  ): Promise<void> {
    // A service may run several threads concurrently. This map represents open
    // sessions, not one global UI focus: A -> B -> A keeps both A and B open and
    // must not replay switch guards or start events for A. CLI/RPC focus changes
    // are owned by those hosts with managedExtensionLifecycle disabled.
    const current = this.#sessions.get(threadId);
    if (current !== undefined) {
      this.#sessions.set(threadId, {
        cwd,
        ...(branch === undefined
          ? current.branch === undefined ? {} : { branch: current.branch }
          : { branch }),
      });
      return;
    }
    const extensions = this.#options.runtimeExtensions;
    if (runtimeGuard === "switch" && extensions?.hasListeners("session_before_switch") === true) {
      const result = await extensions.reduceSessionBeforeSwitch({
        reason: resumed ? "resume" : "new",
        ...(resumed ? { targetThreadId: threadId } : {}),
      }, signal);
      if (result.cancel === true) {
        const reason = result.reason === undefined
          ? "Session transition cancelled by a runtime extension"
          : defaultSecretRedactor.redact(result.reason);
        throw new HarnessError("EXTENSION_SESSION_CANCELLED", reason);
      }
    }
    prepare?.();
    this.#sessions.set(threadId, { cwd, ...(branch === undefined ? {} : { branch }) });
    if (this.#options.managedExtensionLifecycle !== false) {
      await this.#observeRuntime("session_start", {
        reason: resumed ? "resume" : "new",
        threadId,
        ...(branch === undefined ? {} : { branch }),
        workspace: this.#workspaceRoot,
      });
    }
  }

  async #observeRuntimeEnvelope(
    envelope: EventEnvelope,
    projection: RuntimeLifecycleProjection,
    signal: AbortSignal,
  ): Promise<void> {
    const runId = envelope.runId;
    if (runId === undefined) return;
    const event = envelope.event;
    if (event.type === "assistant_started") {
      projection.step = event.step;
      return;
    }
    if (event.type === "text_delta" && projection.step > 0) {
      await this.#observeRuntime("message_update", {
        threadId: envelope.threadId,
        runId,
        step: projection.step,
        kind: "text",
        part: event.part,
        delta: event.text,
      }, signal);
      return;
    }
    if (event.type === "reasoning_delta" && projection.step > 0) {
      await this.#observeRuntime("message_update", {
        threadId: envelope.threadId,
        runId,
        step: projection.step,
        kind: "reasoning",
        part: event.part,
        delta: event.visibility === "provider_trace" ? "" : event.text,
        visibility: event.visibility,
      }, signal);
      return;
    }
    if (event.type === "assistant_completed") {
      const turns = this.#pendingExtensionTurns.get(runId);
      const turn = turns?.get(projection.step);
      if (turn !== undefined) {
        turns!.delete(projection.step);
        if (turns!.size === 0) this.#pendingExtensionTurns.delete(runId);
        await this.#observeRuntime("turn_end", turn, signal);
      }
      return;
    }
    if (event.type === "tool_requested") {
      const invocation: ToolInvocation = {
        callId: event.callId,
        name: event.name,
        input: event.input,
        index: event.index,
      };
      projection.tools.set(event.callId, invocation);
      await this.#observeRuntime("tool_execution_start", {
        threadId: envelope.threadId,
        runId,
        invocation,
      }, signal);
      return;
    }
    if (event.type === "tool_started") {
      const invocation = projection.tools.get(event.callId);
      if (invocation !== undefined) {
        await this.#observeRuntime("tool_execution_update", {
          threadId: envelope.threadId,
          runId,
          invocation,
          phase: "running",
        }, signal);
      }
      return;
    }
    if (event.type === "tool_progress") {
      const invocation = projection.tools.get(event.callId);
      if (invocation !== undefined) {
        await this.#observeRuntime("tool_execution_update", {
          threadId: envelope.threadId,
          runId,
          invocation,
          phase: "progress",
          sequence: event.sequence,
          progress: event.progress,
        }, signal);
      }
      return;
    }
    if (event.type === "tool_completed") {
      const invocation = projection.tools.get(event.callId);
      if (invocation !== undefined) {
        projection.tools.delete(event.callId);
        await this.#observeRuntime("tool_execution_end", {
          threadId: envelope.threadId,
          runId,
          invocation,
          outcome: {
            status: event.isError ? "failed" : "completed",
            isError: event.isError,
            preview: event.preview,
            ...(event.result === undefined ? {} : { result: event.result }),
          },
        }, signal);
      }
      return;
    }
    if (event.type === "tool_in_doubt") {
      const invocation = projection.tools.get(event.callId);
      if (invocation !== undefined) {
        projection.tools.delete(event.callId);
        await this.#observeRuntime("tool_execution_end", {
          threadId: envelope.threadId,
          runId,
          invocation,
          outcome: { status: "in_doubt", reason: event.reason },
        }, signal);
      }
      return;
    }
    if (event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled") {
      const reason = event.type === "run_failed"
        ? event.error.message
        : event.type === "run_cancelled"
          ? event.reason
          : `Run completed with ${event.finishReason} before the tool returned`;
      for (const invocation of projection.tools.values()) {
        await this.#observeRuntime("tool_execution_end", {
          threadId: envelope.threadId,
          runId,
          invocation,
          outcome: { status: "interrupted", reason },
        }, signal);
      }
      projection.tools.clear();
      await this.#flushPendingExtensionTurns(runId, signal);
    }
  }

  async #flushPendingExtensionTurns(runId: string, signal?: AbortSignal): Promise<void> {
    const turns = this.#pendingExtensionTurns.get(runId);
    if (turns === undefined) return;
    this.#pendingExtensionTurns.delete(runId);
    for (const [, turn] of [...turns].sort(([left], [right]) => left - right)) {
      await this.#observeRuntime("turn_end", turn, signal);
    }
  }

  #extensionBranch(threadId: string, branch: string | undefined): string {
    const thread = this.#options.store.bindThreadWorkspace(threadId, this.#workspaceRoot);
    const selected = branch ?? thread.defaultBranch;
    if (!thread.branches.some((entry) => entry.name === selected)) throw new Error(`Unknown branch: ${selected}`);
    return selected;
  }

  #activeToolKey(threadId: string, branch: string): string {
    return `${threadId}\0${branch}`;
  }

  #runtimeModelSelection(threadId: string, branch: string): RuntimeModelSelection | undefined {
    return this.#runtimeModelSelections.get(this.#activeToolKey(threadId, branch))
      ?? this.#options.store.getModelSelection(threadId, branch);
  }

  #configuredToolNames(threadId: string): string[] {
    return this.#buildTools(threadId, {
      prompt: "",
      provider: "runtime",
      model: "runtime",
    }, 0).map((tool) => tool.definition.name).sort((left, right) => left.localeCompare(right));
  }

  async #extensionContextUsage(
    threadId: string,
    events: readonly EventEnvelope[],
    signal?: AbortSignal,
  ): Promise<RuntimeSessionSnapshot["contextUsage"]> {
    const pathRunIds = new Set(events.flatMap((event) => event.runId === undefined ? [] : [event.runId]));
    const latestRun = this.#options.store.listRuns(threadId).filter((run) => pathRunIds.has(run.runId)).at(-1);
    if (latestRun?.provider === undefined || latestRun.model === undefined) return undefined;
    const latestUsage = latestRunContextUsage(events, latestRun.runId);
    if (latestUsage === undefined) return undefined;
    const lastCompaction = events.findLast((entry) => entry.event.type === "compaction_completed")?.sequence;
    if (lastCompaction !== undefined && latestUsage.sequence <= lastCompaction) return undefined;
    try {
      const modelSignal = signal === undefined
        ? AbortSignal.timeout(5_000)
        : AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
      const model = (await this.#options.providers.listModels(latestRun.provider, modelSignal, { refresh: false }))
        .find((entry) => entry.id === latestRun.model);
      const tokens = normalizedContextTokens(latestUsage.usage);
      if (tokens === undefined || model?.contextTokens === undefined) return undefined;
      return {
        tokens,
        contextWindow: model.contextTokens,
        percent: Math.round((tokens / model.contextTokens) * 1_000) / 10,
        source: "provider_usage",
      };
    } catch {
      return undefined;
    }
  }

  async #runtimeSessionSnapshot(
    threadId: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<RuntimeSessionSnapshot> {
    signal?.throwIfAborted();
    const thread = this.#options.store.bindThreadWorkspace(threadId, this.#workspaceRoot);
    const events = this.#options.store.listEvents(threadId, branch);
    const activeBranch = this.#manager.activeBranch(threadId);
    const active = this.#manager.active(threadId) && (activeBranch === undefined || activeBranch === branch);
    const activeRun = active
      ? this.#options.store.listRuns(threadId).findLast((run) =>
          run.branch === branch && !["completed", "failed", "cancelled"].includes(run.state))
      : undefined;
    const operation = active ? runtimeSessionPhase(events, activeRun?.runId) : undefined;
    const recoverableMessageCount = this.#options.store.listRunInputs(threadId, branch, ["recoverable"]).length;
    const pendingMessageCount = recoverableMessageCount + (active ? this.#manager.queuedMessages(threadId).length : 0);
    const contextUsage = await this.#extensionContextUsage(threadId, events, signal);
    const model = this.#runtimeModelSelection(threadId, branch);
    const promptCompositionEvent = events.findLast((entry) =>
      entry.event.type === "run_started" && entry.event.promptComposition !== undefined);
    const promptComposition = promptCompositionEvent?.event.type === "run_started"
      ? promptCompositionEvent.event.promptComposition
      : undefined;
    signal?.throwIfAborted();
    return {
      threadId: thread.threadId,
      branch,
      ...(thread.name === undefined ? {} : { name: thread.name }),
      branches: thread.branches.map((entry) => entry.name),
      active,
      operation: operation?.operation ?? null,
      phase: operation?.phase ?? "idle",
      pendingMessageCount,
      recoverableMessageCount,
      ...(contextUsage === undefined ? {} : { contextUsage }),
      ...(model === undefined ? {} : { model }),
      ...(promptComposition === undefined ? {} : { promptComposition: structuredClone(promptComposition) }),
    };
  }

  async #runRuntimeChild(
    input: RuntimeChildRunInput & { requesterThreadId?: string },
  ): Promise<RuntimeChildRunResult> {
    input.signal?.throwIfAborted();
    const parentBranch = this.#extensionBranch(input.threadId, input.branch);
    const targetDepth = this.#childRunDepth.get(input.threadId) ?? 0;
    const requesterDepth = input.requesterThreadId === undefined
      ? 0
      : this.#childRunDepth.get(input.requesterThreadId) ?? 0;
    const parentDepth = Math.max(targetDepth, requesterDepth);
    const durableChild = this.#isRuntimeChildThread(input.threadId) || (
      input.requesterThreadId !== undefined && this.#isRuntimeChildThread(input.requesterThreadId)
    );
    if (parentDepth >= 1 || durableChild) throw new Error("Nested runtime child runs are disabled");
    const childRunPolicy = this.#childRunPolicy;
    const requestedLimits = [
      ["maxSteps", input.maxSteps, childRunPolicy.maxSteps],
      ["timeoutMs", input.timeoutMs, childRunPolicy.maxTimeoutMs],
      ["outputLimitBytes", input.outputLimitBytes, childRunPolicy.maxOutputLimitBytes],
    ] as const;
    for (const [field, selected, maximum] of requestedLimits) {
      if (selected !== undefined && (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum)) {
        throw new Error(`Runtime child run ${field} must be from 1 through the configured maximum of ${maximum}`);
      }
    }
    if (this.#activeChildRuns >= childRunPolicy.maxConcurrent) {
      throw new Error(`At most ${childRunPolicy.maxConcurrent} runtime child runs may execute concurrently`);
    }
    const parentSelection = this.#runtimeModelSelection(input.threadId, parentBranch);
    const provider = input.provider ?? parentSelection?.provider;
    const model = input.model ?? (provider === parentSelection?.provider ? parentSelection?.model : undefined);
    if (provider === undefined || model === undefined) {
      throw new Error("Runtime child run requires an exact provider and model or an existing parent selection");
    }
    const reasoningEffort = input.reasoningEffort ?? (
      provider === parentSelection?.provider && model === parentSelection.model
        ? parentSelection.reasoningEffort
        : undefined
    );
    const availableTools = new Set(this.#configuredToolNames(input.threadId));
    const unavailableTools = input.tools.filter((name) => !availableTools.has(name));
    if (unavailableTools.length > 0) {
      throw new Error(`Runtime child run requested unavailable tools: ${unavailableTools.join(", ")}`);
    }
    const executionSelection = input.execution ?? { backend: "inherit" as const };
    const configuredBackend = this.#options.toolBackend;
    if (
      executionSelection.backend === "inherit" &&
      executionSelection.backendId !== undefined &&
      configuredBackend?.id !== executionSelection.backendId
    ) {
      throw new Error(`Runtime child run requires unavailable execution backend: ${executionSelection.backendId}`);
    }
    const childBackend = executionSelection.backend === "local" ? undefined : configuredBackend;
    const routedTools = childBackend === undefined
      ? []
      : input.tools.filter((name) => childBackend.handles(name));
    const localTools = input.tools.filter((name) => !routedTools.includes(name));
    const backendRequired = executionSelection.backend === "inherit" && executionSelection.requireAllTools === true;
    if (backendRequired && childBackend === undefined) {
      throw new Error("Runtime child run requires an execution backend, but the host has none configured");
    }
    if (backendRequired && localTools.length > 0) {
      throw new Error(`Runtime child run requires backend routing for every tool; not routed: ${localTools.join(", ")}`);
    }
    const execution: RuntimeChildRunResult["execution"] = {
      backend: childBackend === undefined ? "local" : "host",
      ...(childBackend === undefined ? {} : { backendId: childBackend.id }),
      required: backendRequired,
      routedTools,
      localTools,
    };
    const childModel: RuntimeChildRunResult["model"] = {
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    };
    const persisted = input.session === "persisted";
    this.#activeChildRuns += 1;
    try {
      const cwd = input.cwd === undefined
        ? this.#sessions.get(input.threadId)?.cwd ?? this.#workspaceRoot
        : await (this.#workspaceBoundary ?? await WorkspaceBoundary.create(this.#workspaceRoot)).readable(input.cwd);
      const activeRun = this.#manager.active(input.threadId)
        ? this.#options.store.listRuns(input.threadId).findLast((run) =>
            run.branch === parentBranch && !["completed", "failed", "cancelled"].includes(run.state))
        : undefined;
      const activeEvents = activeRun === undefined
        ? []
        : this.#options.store.listEvents(input.threadId, parentBranch).filter((event) => event.runId === activeRun.runId);
      const currentToolRequest = activeEvents.findLast((event) =>
        event.event.type === "message_appended" &&
        event.event.message.role === "assistant" &&
        event.event.message.content.some((block) => block.type === "tool_call"));
      const child = input.context === "fork"
        ? (await this.cloneSessionPath({
            threadId: input.threadId,
            branch: parentBranch,
            ...(currentToolRequest === undefined ? {} : { beforeEventId: currentToolRequest.eventId }),
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          })).thread
        : await this.createSession({
            parentThreadId: input.threadId,
            cwd,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
      const childBranch = child.defaultBranch;
      const childSession: RuntimeChildSession = {
        threadId: child.threadId,
        branch: childBranch,
        model: childModel,
        persisted,
      };
      const artifactIdsBeforeRun = new Set(
        this.#options.store.listArtifacts(child.threadId).map((artifact) => artifact.artifactId),
      );
      const timeout = AbortSignal.timeout(input.timeoutMs ?? childRunPolicy.defaultTimeoutMs);
      const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
      const outputLimitBytes = input.outputLimitBytes ?? childRunPolicy.defaultOutputLimitBytes;
      let outcome: RuntimeChildRunResult;
      this.#childRunDepth.set(child.threadId, parentDepth + 1);
      try {
        const running = this.run({
          threadId: child.threadId,
          branch: childBranch,
          prompt: input.prompt,
          provider,
          model,
          signal,
          cwd,
          allowedTools: [...input.tools],
          maxSteps: input.maxSteps ?? childRunPolicy.defaultMaxSteps,
          toolBackend: childBackend ?? null,
          ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          additionalInstructions: {
            source: RUNTIME_CHILD_INSTRUCTION_SOURCE,
            text: "This is a bounded in-process child session. Complete only the delegated task. Do not start or delegate another child run.",
          },
          ...(input.onEvent === undefined ? {} : {
            onEvent: (envelope: EventEnvelope) => {
              const event = runtimeChildEvent(envelope, childBranch);
              if (event === undefined) return;
              observeRuntimeChildCallback(() => input.onEvent?.(event));
            },
          }),
        });
        observeRuntimeChildCallback(() => input.onStart?.(structuredClone(childSession)));
        const run = await running;
        const result = run.results.at(-1);
        const visible = boundedChildText(result?.finalText ?? "", outputLimitBytes);
        const cancelled = result?.finishReason === "cancelled" || signal.aborted;
        const failed = result?.finishReason === "error";
        outcome = {
          status: cancelled ? "cancelled" : failed ? "error" : "success",
          summary: cancelled
            ? "Child run was cancelled."
            : failed
              ? "Child run ended with a provider error."
            : `Child run completed in ${result?.steps ?? 0} model step${result?.steps === 1 ? "" : "s"}${visible.truncated ? "; visible output was truncated" : ""}.`,
          nextActions: cancelled
            ? ["Retry only if the parent task is still active and the cancellation cause has been addressed."]
            : failed
              ? ["Inspect the child session events and retry after correcting the provider or request."]
              : [],
          threadId: child.threadId,
          branch: childBranch,
          model: childModel,
          persisted,
          ...(result === undefined ? {} : {
            runId: result.runId,
            finishReason: result.finishReason,
            steps: result.steps,
          }),
          finalText: visible.text,
          artifacts: [],
          artifactCount: 0,
          artifactsTruncated: false,
          execution,
          truncated: visible.truncated,
          ...(failed ? { error: "Provider ended the child run with finish reason error." } : {}),
        };
      } catch (cause) {
        const message = defaultSecretRedactor.redact(cause instanceof Error ? cause.message : String(cause)).slice(0, 16 * 1024);
        const cancelled = signal.aborted;
        outcome = {
          status: cancelled ? "cancelled" : "error",
          summary: cancelled ? "Child run was cancelled." : `Child run failed: ${message.slice(0, 512)}`,
          nextActions: cancelled
            ? ["Retry only if the parent task is still active and the cancellation cause has been addressed."]
            : ["Inspect the reported cause and retry with a narrower task or corrected provider, model, and tools."],
          threadId: child.threadId,
          branch: childBranch,
          model: childModel,
          persisted,
          finalText: "",
          artifacts: [],
          artifactCount: 0,
          artifactsTruncated: false,
          execution,
          truncated: false,
          ...(cancelled ? {} : { error: message }),
        };
      } finally {
        this.#childRunDepth.delete(child.threadId);
      }
      const runRecord = this.#options.store.listRuns(child.threadId).at(-1);
      const selectedRunId = outcome.runId ?? runRecord?.runId;
      if (selectedRunId !== undefined) {
        const events = this.#options.store.listEvents(child.threadId, childBranch);
        const usage = runtimeChildUsage(events, selectedRunId);
        const allArtifacts = this.#options.store.listArtifacts(child.threadId)
          .filter((artifact) => !artifactIdsBeforeRun.has(artifact.artifactId));
        outcome = {
          ...outcome,
          ...(outcome.runId === undefined ? { runId: selectedRunId } : {}),
          ...(usage === undefined ? {} : { usage }),
          artifacts: allArtifacts.slice(0, MAX_RUNTIME_CHILD_ARTIFACTS).map((artifact) => ({
            id: artifact.artifactId,
            mediaType: artifact.mediaType,
            bytes: artifact.byteLength,
            sha256: artifact.sha256,
            retained: persisted,
          })),
          artifactCount: allArtifacts.length,
          artifactsTruncated: allArtifacts.length > MAX_RUNTIME_CHILD_ARTIFACTS,
        };
      }
      if (!persisted) {
        try {
          await this.deleteSession(child.threadId);
        } catch (cause) {
          const message = defaultSecretRedactor.redact(cause instanceof Error ? cause.message : String(cause)).slice(0, 4 * 1024);
          return {
            ...outcome,
            status: "error",
            persisted: true,
            summary: `Child run cleanup failed: ${message.slice(0, 512)}`,
            nextActions: ["Remove the retained child session manually before retrying."],
            artifacts: outcome.artifacts.map((artifact) => ({ ...artifact, retained: true })),
            error: message,
          };
        }
      }
      return outcome;
    } finally {
      this.#activeChildRuns -= 1;
    }
  }

  #isRuntimeChildThread(threadId: string): boolean {
    if (this.#childRunDepth.has(threadId)) return true;
    const thread = this.#options.store.bindThreadWorkspace(threadId, this.#workspaceRoot);
    if (thread.parentThreadId === undefined) return false;
    return thread.branches.some((branch) => this.#options.store.listEvents(threadId, branch.name).some((entry) =>
      entry.event.type === "run_started" && entry.event.promptComposition?.sources.some((source) =>
        source.kind === "additional_instructions" && source.source === RUNTIME_CHILD_INSTRUCTION_SOURCE) === true));
  }

  async #publishExtensionSessionEvent(publication: ExtensionSessionPublication): Promise<void> {
    const listeners = [...this.#extensionSessionListeners];
    if (listeners.length === 0) return;
    const results = await Promise.allSettled(listeners.map(async (listener) => await listener(structuredClone(publication))));
    for (const result of results) {
      if (result.status !== "rejected") continue;
      this.#options.runtimeExtensions?.addDiagnostic({
        extensionId: "runtime",
        sourcePath: "",
        message: `Extension session event observer failed after durable commit: ${defaultSecretRedactor.redact(
          result.reason instanceof Error ? result.reason.message : String(result.reason),
        )}`,
      });
    }
  }

  #bindExtensionSessionHost(host: RuntimeExtensionHost | undefined): void {
    this.#extensionSessionCleanup?.();
    this.#extensionSessionCleanup = undefined;
    this.#activeToolSelections.clear();
    if (host === undefined) return;
    this.#extensionSessionCleanup = host.setSessionHandler({
      getResourceCatalog: async (input) => await this.resourceCatalog(input.signal),
      listSessions: async (input) => await this.listSessions(input),
      getTranscript: async (input) => await this.getTranscript(input),
      appendState: async (input) => {
        input.signal?.throwIfAborted();
        const branch = this.#extensionBranch(input.threadId, input.branch);
        const event = defaultSecretRedactor.redactValue(input.event) as ExtensionStateEvent;
        const envelope = this.#options.store.appendEvent({ threadId: input.threadId, branch, event });
        await this.#publishExtensionSessionEvent({
          branch,
          envelope: envelope as EventEnvelope<ExtensionStateEvent>,
        });
        return extensionStateRecord(envelope as EventEnvelope<ExtensionStateEvent>, branch);
      },
      compareAndAppendState: async (input): Promise<RuntimeExtensionStateCompareAndAppendResult> => {
        input.signal?.throwIfAborted();
        const branch = this.#extensionBranch(input.threadId, input.branch);
        const event = defaultSecretRedactor.redactValue(input.event) as ExtensionStateEvent;
        const result = this.#options.store.compareAndAppendExtensionState({
          threadId: input.threadId,
          branch,
          event,
          expectedEventId: input.expectedEventId,
        });
        if (result.status === "conflict") {
          return {
            status: "conflict",
            threadId: input.threadId,
            branch,
            expectedEventId: input.expectedEventId,
            ...(result.current === undefined ? {} : { current: extensionStateRecord(result.current, branch) }),
          };
        }
        await this.#publishExtensionSessionEvent({ branch, envelope: result.envelope });
        return { status: "committed", record: extensionStateRecord(result.envelope, branch) };
      },
      readState: async (input) => {
        input.signal?.throwIfAborted();
        const branch = this.#extensionBranch(input.threadId, input.branch);
        const envelope = this.#options.store.getExtensionState(
          input.threadId,
          input.extensionId,
          input.schemaVersion,
          input.key,
          branch,
        );
        return envelope === undefined ? undefined : extensionStateRecord(envelope, branch);
      },
      appendMessage: async (input) => {
        input.signal?.throwIfAborted();
        const branch = this.#extensionBranch(input.threadId, input.branch);
        const event = defaultSecretRedactor.redactValue(input.event) as ExtensionMessageEvent;
        const envelope = this.#options.store.appendEvent({ threadId: input.threadId, branch, event });
        await this.#publishExtensionSessionEvent({
          branch,
          envelope: envelope as EventEnvelope<ExtensionMessageEvent>,
        });
        return extensionMessageRecord(envelope as EventEnvelope<ExtensionMessageEvent>, branch);
      },
      readMessages: async (input) => {
        input.signal?.throwIfAborted();
        const branch = this.#extensionBranch(input.threadId, input.branch);
        return this.#options.store.listExtensionMessages(
          input.threadId,
          input.extensionId,
          input.schemaVersion,
          branch,
          input.kind,
        ).slice(-input.limit).map((entry) => extensionMessageRecord(entry, branch));
      },
      getActiveTools: async (input) => {
        input.signal?.throwIfAborted();
        const branch = this.#extensionBranch(input.threadId, input.branch);
        const key = this.#activeToolKey(input.threadId, branch);
        const activeRun = this.#activeToolRuns.get(key);
        if (activeRun !== undefined) return activeRun.coordinator.activeToolNames();
        return [...(this.#activeToolSelections.get(key)?.names ?? this.#configuredToolNames(input.threadId))];
      },
      getAllTools: async (input) => {
        input.signal?.throwIfAborted();
        const branch = this.#extensionBranch(input.threadId, input.branch);
        const key = this.#activeToolKey(input.threadId, branch);
        const activeRun = this.#activeToolRuns.get(key);
        const tools = activeRun?.tools ?? this.#buildTools(input.threadId, {
          prompt: "",
          provider: "runtime",
          model: "runtime",
        }, 0);
        const active = new Set(
          activeRun?.coordinator.activeToolNames()
          ?? this.#activeToolSelections.get(key)?.names
          ?? this.#configuredToolNames(input.threadId),
        );
        const extraTools = new Set(this.#options.extraTools ?? []);
        return tools
          .map((tool) => ({
            name: tool.definition.name,
            description: tool.definition.description,
            inputSchema: structuredClone(tool.definition.inputSchema),
            active: active.has(tool.definition.name),
            executionMode: tool.executionMode ?? "parallel",
            owner: this.#options.runtimeExtensions?.toolOwner(tool)
              ?? (extraTools.has(tool) ? { kind: "host" as const } : { kind: "builtin" as const }),
            ...(tool.definition.loading === undefined ? {} : { loading: tool.definition.loading }),
            ...(tool.definition.promptSnippet === undefined ? {} : { promptSnippet: tool.definition.promptSnippet }),
            ...(tool.definition.promptGuidelines === undefined
              ? {}
              : { promptGuidelines: [...tool.definition.promptGuidelines] }),
          }))
          .sort((left, right) => left.name.localeCompare(right.name));
      },
      setActiveTools: async (input) => {
        input.signal?.throwIfAborted();
        const branch = this.#extensionBranch(input.threadId, input.branch);
        const key = this.#activeToolKey(input.threadId, branch);
        const activeRun = this.#activeToolRuns.get(key);
        const available = new Set(activeRun?.coordinator.allToolNames() ?? this.#configuredToolNames(input.threadId));
        const unknown = input.names.filter((name) => !available.has(name));
        if (unknown.length > 0) {
          throw new HarnessError(
            "EXTENSION_ACTIVE_TOOLS",
            `Active tool selection contains unavailable tools: ${unknown.join(", ")}`,
          );
        }
        const selected = activeRun === undefined
          ? [...input.names]
          : activeRun.coordinator.queueActiveTools(input.names);
        this.#activeToolSelections.set(key, {
          names: [...selected],
          requesterExtensionId: input.requesterExtensionId,
          requesterSourcePath: input.requesterSourcePath,
        });
        return [...selected];
      },
      setSessionName: async (input) => {
        input.signal?.throwIfAborted();
        const branch = this.#extensionBranch(input.threadId, input.branch);
        const thread = await this.setSessionName({
          threadId: input.threadId,
          branch,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        return {
          threadId: input.threadId,
          branch,
          ...(thread.name === undefined ? {} : { name: thread.name }),
        };
      },
      setEntryLabel: async (input) => {
        input.signal?.throwIfAborted();
        const branch = this.#extensionBranch(input.threadId, input.branch);
        const changed = await this.setSessionEntryLabel({
          threadId: input.threadId,
          branch,
          targetEventId: input.targetEventId,
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        return {
          threadId: input.threadId,
          branch,
          targetEventId: changed.event.targetEventId,
          eventId: changed.eventId,
          timestamp: changed.timestamp,
          ...(changed.event.label === undefined ? {} : { label: changed.event.label }),
        };
      },
      sendUserMessage: async (input) => {
        input.signal?.throwIfAborted();
        const branch = this.#queueBranch(input.threadId, input.branch);
        if (input.delivery === "follow_up") this.followUp(input.threadId, input.text, input.images);
        else this.steer(input.threadId, input.text, input.images);
        return {
          threadId: input.threadId,
          branch,
          delivery: input.delivery,
          queued: true,
        };
      },
      cancel: async (input) => {
        input.signal?.throwIfAborted();
        this.#options.store.bindThreadWorkspace(input.threadId, this.#workspaceRoot);
        if (!this.#manager.active(input.threadId)) return false;
        if (input.branch !== undefined && this.#manager.activeBranch(input.threadId) !== input.branch) {
          throw new HarnessError("SERVICE_QUEUE_BRANCH", `Active run is not on branch ${input.branch}`);
        }
        this.cancel(input.threadId, input.reason);
        return true;
      },
      compact: async (input) => {
        input.signal?.throwIfAborted();
        const thread = this.#options.store.bindThreadWorkspace(input.threadId, this.#workspaceRoot);
        const branch = input.branch ?? thread.defaultBranch;
        const stored = this.#runtimeModelSelection(input.threadId, branch);
        const provider = input.provider ?? stored?.provider;
        const model = input.model ?? stored?.model;
        if (provider === undefined || model === undefined) {
          throw new Error("Session compaction requires a selected provider and model");
        }
        const onAbort = (): void => this.cancel(input.threadId, "Extension compaction cancelled");
        input.signal?.addEventListener("abort", onAbort, { once: true });
        try {
          const reasoningEffort = input.reasoningEffort ?? stored?.reasoningEffort;
          const result = await this.compact({
            threadId: input.threadId,
            branch,
            provider,
            model,
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
            ...(input.instructions === undefined ? {} : { compactionInstructions: input.instructions }),
            ...(input.contextTokenBudget === undefined ? {} : { contextTokenBudget: input.contextTokenBudget }),
            ...(input.summaryTokenBudget === undefined ? {} : { summaryTokenBudget: input.summaryTokenBudget }),
          });
          return { threadId: input.threadId, branch, summary: result.finalText };
        } finally {
          input.signal?.removeEventListener("abort", onAbort);
        }
      },
      runChild: async (input) => await this.#runRuntimeChild(input),
      createSession: async (input) => {
        input.signal?.throwIfAborted();
        const cwd = input.cwd === undefined
          ? undefined
          : await (this.#workspaceBoundary ?? await WorkspaceBoundary.create(this.#workspaceRoot)).readable(input.cwd);
        const thread = await this.createSession({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.defaultBranch === undefined ? {} : { defaultBranch: input.defaultBranch }),
          ...(cwd === undefined ? {} : { cwd }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        return await this.#runtimeSessionSnapshot(thread.threadId, thread.defaultBranch, input.signal);
      },
      forkSession: async (input) => {
        input.signal?.throwIfAborted();
        const result = await this.cloneSessionPath({
          threadId: input.threadId,
          ...(input.branch === undefined ? {} : { branch: input.branch }),
          ...(input.atEventId === undefined ? {} : { atEventId: input.atEventId }),
          ...(input.beforeEventId === undefined ? {} : { beforeEventId: input.beforeEventId }),
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        return await this.#runtimeSessionSnapshot(
          result.thread.threadId,
          result.thread.defaultBranch,
          input.signal,
        );
      },
      inspectSession: async (input) => {
        input.signal?.throwIfAborted();
        const branch = this.#extensionBranch(input.threadId, input.branch);
        return await this.#runtimeSessionSnapshot(input.threadId, branch, input.signal);
      },
      waitForIdle: async (input) => {
        input.signal?.throwIfAborted();
        const branch = this.#extensionBranch(input.threadId, input.branch);
        const activeBranch = this.#manager.activeBranch(input.threadId);
        if (activeBranch !== undefined && activeBranch !== branch) return;
        await this.#manager.waitForIdle(input.threadId, input.signal);
      },
      sessionTree: async (input) => {
        input.signal?.throwIfAborted();
        const branch = this.#extensionBranch(input.threadId, input.branch);
        return buildSessionTree(this.#options.store, input.threadId, branch);
      },
      navigateSession: async (input) => {
        input.signal?.throwIfAborted();
        const result = await this.navigateTree({
          threadId: input.threadId,
          ...(input.branch === undefined ? {} : { branch: input.branch }),
          targetBranch: input.targetBranch,
          targetEventId: input.targetEventId,
          newBranch: input.newBranch,
          ...(input.summarize === undefined ? {} : { summarize: input.summarize }),
          ...(input.provider === undefined ? {} : { provider: input.provider }),
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.summaryTokenBudget === undefined ? {} : { summaryTokenBudget: input.summaryTokenBudget }),
          ...(input.summaryInstructions === undefined ? {} : { summaryInstructions: input.summaryInstructions }),
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        return {
          cancelled: result.cancelled,
          ...(result.branch === undefined ? {} : { branch: result.branch.name }),
          ...(result.summaryEvent === undefined ? {} : { summaryEventId: result.summaryEvent.eventId }),
        };
      },
      getModel: async (input) => {
        input.signal?.throwIfAborted();
        const branch = this.#extensionBranch(input.threadId, input.branch);
        return this.#runtimeModelSelection(input.threadId, branch);
      },
      setModel: async (input) => {
        input.signal?.throwIfAborted();
        const branch = this.#extensionBranch(input.threadId, input.branch);
        const selected = await this.resolveModelSelection(input.model, {
          provider: input.provider,
          refresh: true,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
        });
        this.#options.store.appendEvent({
          threadId: input.threadId,
          branch,
          event: {
            type: "model_selected",
            provider: selected.provider,
            model: selected.model,
            ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
          },
        });
        this.setRuntimeModelSelection({ threadId: input.threadId, branch, selection: selected });
        return selected;
      },
      setThinking: async (input) => {
        input.signal?.throwIfAborted();
        const branch = this.#extensionBranch(input.threadId, input.branch);
        const current = this.#runtimeModelSelection(input.threadId, branch);
        if (current === undefined) throw new Error("Session has no selected model");
        const selected = await this.resolveModelSelection(current.model, {
          provider: current.provider,
          refresh: true,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          reasoningEffort: input.reasoningEffort,
        });
        this.#options.store.appendEvent({
          threadId: input.threadId,
          branch,
          event: {
            type: "model_selected",
            provider: selected.provider,
            model: selected.model,
            ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
          },
        });
        this.setRuntimeModelSelection({ threadId: input.threadId, branch, selection: selected });
        return selected;
      },
      exec: async (input) => {
        input.signal?.throwIfAborted();
        if (input.timeoutMs !== undefined && input.timeoutMs > 10 * 60_000) throw new Error("Runtime command timeout exceeds 600000ms");
        if (input.outputLimitBytes !== undefined && input.outputLimitBytes > 16 * 1024 * 1024) {
          throw new Error("Runtime command output limit exceeds 16777216 bytes");
        }
        const boundary = this.#workspaceBoundary ?? await WorkspaceBoundary.create(this.#workspaceRoot);
        const cwd = await boundary.readable(input.cwd ?? ".");
        const result = await new DirectProcessRunner().run({
          argv: [input.command, ...(input.args ?? [])],
          cwd,
          ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
          timeoutMs: input.timeoutMs ?? 30_000,
          outputLimitBytes: input.outputLimitBytes ?? 1024 * 1024,
        }, input.signal ?? new AbortController().signal);
        return {
          exitCode: result.exitCode,
          signal: result.signal,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
          timedOut: result.timedOut,
          cancelled: result.cancelled,
          durationMs: result.durationMs,
        };
      },
    });
  }

  async #observeRuntime<K extends RuntimeExtensionEvent>(
    event: K,
    value: RuntimeExtensionEventMap[K],
    signal?: AbortSignal,
  ): Promise<void> {
    const extensions = this.#options.runtimeExtensions;
    if (extensions === undefined || !extensions.hasListeners(event)) return;
    try {
      await extensions.dispatch(event, value, extensionObserverSignal(signal));
    } catch {
      // RuntimeExtensionHost records each listener failure. An after-event
      // observer cannot roll back work that is already durable.
    }
  }

}
