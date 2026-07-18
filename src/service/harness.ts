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
import { WorkspaceSessionFacade } from "./session-access.js";
import { defaultSecretRedactor } from "../auth/redaction.js";
import type { RuntimeEvent } from "../core/events.js";
import { createId } from "../core/ids.js";
import { HarnessError } from "../core/errors.js";
import {
  normalizeChildRunPolicy,
  type ChildRunPolicy,
} from "../core/child-runs.js";
import type { BranchRecord, RunInputQueueRecord, RunRecord } from "../storage/types.js";
import {
  BRANCH_SUMMARY_LIMITS,
  generateBranchSummary,
  prepareAbandonedBranch,
} from "./branch-summary.js";
import type { CloneSessionPathInput, CloneSessionPathResult } from "./session-clone.js";
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
  RuntimeRunScope,
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
  HARNESS_TRANSCRIPT_LIMITS,
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
const RESOURCE_GENERATION_READER_DRAIN_TIMEOUT_MS = 1_000;
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
  let event = envelope.event;
  if (event.type === "run_failed" && "retryable" in event.error) {
    const { diagnostics: _diagnostics, ...error } = event.error;
    event = { ...event, error };
  }
  return {
    threadId: envelope.threadId,
    branch,
    ...(envelope.runId === undefined ? {} : { runId: envelope.runId }),
    sequence: envelope.sequence,
    timestamp: envelope.timestamp,
    event: structuredClone(event) as RuntimeChildVisibleEvent,
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

async function settlePromiseWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(observerAbortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
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
  extraTools?: readonly HarnessTool[];
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
  skills: readonly SkillMetadata[];
  extraTools: readonly HarnessTool[];
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

interface HarnessResourceGeneration {
  readonly providers: ProviderRegistry;
  readonly projectTrusted: boolean;
  readonly skills: readonly SkillMetadata[];
  readonly extraTools: readonly HarnessTool[];
  readonly toolBackend?: ToolExecutionBackend;
  readonly outboundImages: OutboundImagePolicy;
  readonly runtimeExtensions?: RuntimeExtensionHost;
  readonly shellPath?: string;
  readonly autoCompaction?: boolean;
  readonly compactionRetainRecentTurns?: number;
  readonly compactionToolResultBytes?: number;
  readonly retry?: Readonly<RetryPolicy>;
  readonly childRunPolicy: Readonly<ChildRunPolicy>;
  readonly resourceCatalog?: Pick<HarnessResourceCatalogSources, "extensions" | "packages" | "projectPackages" | "packageDiagnostics">;
}

interface HarnessResourceGenerationReaders {
  count: number;
  runHandoffs: number;
  readonly idle: Promise<void>;
  readonly resolveIdle: () => void;
  readonly controllers: Set<AbortController>;
}

function immutableResourceGeneration(resources: HarnessRuntimeResources): HarnessResourceGeneration {
  const resourceCatalog = resources.resourceCatalog === undefined
    ? undefined
    : Object.freeze({
        ...resources.resourceCatalog,
        ...(resources.resourceCatalog.packages === undefined
          ? {}
          : { packages: Object.freeze([...resources.resourceCatalog.packages]) }),
        ...(resources.resourceCatalog.projectPackages === undefined
          ? {}
          : { projectPackages: Object.freeze([...resources.resourceCatalog.projectPackages]) }),
        ...(resources.resourceCatalog.packageDiagnostics === undefined
          ? {}
          : { packageDiagnostics: Object.freeze([...resources.resourceCatalog.packageDiagnostics]) }),
      });
  return Object.freeze({
    providers: resources.providers,
    projectTrusted: resources.projectTrusted,
    skills: Object.freeze([...resources.skills]),
    extraTools: Object.freeze([...resources.extraTools]),
    ...(resources.toolBackend === undefined ? {} : { toolBackend: resources.toolBackend }),
    outboundImages: resources.outboundImages ?? "allow",
    ...(resources.runtimeExtensions === undefined ? {} : { runtimeExtensions: resources.runtimeExtensions }),
    ...(resources.shellPath === undefined ? {} : { shellPath: resources.shellPath }),
    ...(resources.autoCompaction === undefined ? {} : { autoCompaction: resources.autoCompaction }),
    ...(resources.compactionRetainRecentTurns === undefined
      ? {}
      : { compactionRetainRecentTurns: resources.compactionRetainRecentTurns }),
    ...(resources.compactionToolResultBytes === undefined
      ? {}
      : { compactionToolResultBytes: resources.compactionToolResultBytes }),
    ...(resources.retry === undefined ? {} : { retry: Object.freeze({ ...resources.retry }) }),
    childRunPolicy: Object.freeze(normalizeChildRunPolicy(resources.childRuns)),
    ...(resourceCatalog === undefined ? {} : { resourceCatalog }),
  });
}

function initialResourceGeneration(options: HarnessOptions): HarnessResourceGeneration {
  return immutableResourceGeneration({
    providers: options.providers,
    projectTrusted: options.projectTrusted ?? false,
    skills: [],
    extraTools: options.extraTools ?? [],
    ...(options.toolBackend === undefined ? {} : { toolBackend: options.toolBackend }),
    ...(options.outboundImages === undefined ? {} : { outboundImages: options.outboundImages }),
    ...(options.runtimeExtensions === undefined ? {} : { runtimeExtensions: options.runtimeExtensions }),
    ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }),
    ...(options.autoCompaction === undefined ? {} : { autoCompaction: options.autoCompaction }),
    ...(options.compactionRetainRecentTurns === undefined
      ? {}
      : { compactionRetainRecentTurns: options.compactionRetainRecentTurns }),
    ...(options.compactionToolResultBytes === undefined
      ? {}
      : { compactionToolResultBytes: options.compactionToolResultBytes }),
    ...(options.retry === undefined ? {} : { retry: options.retry }),
    ...(options.childRuns === undefined ? {} : { childRuns: options.childRuns }),
    ...(options.resourceCatalog === undefined ? {} : { resourceCatalog: options.resourceCatalog }),
  });
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

export interface RetainedModelSelection {
  readonly selection: ResolvedModelSelection;
  readonly signal: AbortSignal;
  release(): void;
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

interface CreateSessionInput {
  threadId?: string;
  name?: string;
  defaultBranch?: string;
  parentThreadId?: string;
  parentRunId?: string;
  sourceEventId?: string;
  cwd?: string;
  signal?: AbortSignal;
}

interface RuntimeLifecycleProjection {
  branch: string;
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
  #resources: HarnessResourceGeneration;
  readonly #runner: AgentRunner;
  readonly #manager: ThreadRunManager;
  readonly #workspaceRoot: string;
  readonly #sessionAccess: WorkspaceSessionFacade;
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
  readonly #resourceGenerationReaders = new Map<HarnessResourceGeneration, HarnessResourceGenerationReaders>();
  #activeChildRuns = 0;
  #workspaceBoundary: WorkspaceBoundary | undefined;
  #closed = false;
  #reloading = false;
  #workspaceRecovered = false;
  #workspaceRecovery: Promise<void> | undefined;
  #workspaceActivation: Promise<void> | undefined;
  #extensionSessionCleanup: (() => void) | undefined;
  #runtimeOwnerHeartbeat: NodeJS.Timeout | undefined;
  #runtimeOwnerStarted = false;
  #runtimeOwnerFailure: HarnessError | undefined;
  #initializing = false;
  #closeFlight: Promise<void> | undefined;

  constructor(options: HarnessOptions) {
    this.#options = options;
    this.#resources = initialResourceGeneration(options);
    this.#workspaceRoot = resolve(options.workspace);
    this.#sessionAccess = new WorkspaceSessionFacade(options.store, this.#workspaceRoot);
    const conversation = new StoredConversation(options.store);
    this.#runner = new AgentRunner({
      conversation,
      events: (threadId, runId, branch, signal) => {
        const resolvedBranch = this.#extensionBranch(threadId, branch);
        const persistent = options.store.createEventSink({
          threadId,
          runId,
          branch: resolvedBranch,
        });
        const projection: RuntimeLifecycleProjection = { branch: resolvedBranch, step: 0, tools: new Map() };
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
          await this.#observeRuntime("agent_start", {
            ...event,
            ...this.#runtimeRunScope(event),
          }, signal);
        },
        afterRun: async (event, signal) => {
          const extensionEvent = {
            ...this.#runtimeRunScope(event),
            outcome: boundedAgentOutcome(event.outcome),
          };
          await this.#flushPendingExtensionTurns(event.runId, signal);
          await this.#observeRuntime("agent_end", extensionEvent, signal);
          await this.#observeRuntime("agent_settled", extensionEvent, signal);
        },
        beforeModel: async (event, signal) => {
          const runScope = this.#runtimeRunScope(event);
          await this.#observeRuntime("turn_start", { ...event, ...runScope }, signal);
          await this.#observeRuntime("message_start", {
            ...runScope,
            step: event.step,
            role: "assistant",
          }, signal);
        },
        afterModel: async (event, signal) => {
          const runScope = this.#runtimeRunScope(event);
          const extensionEvent: RuntimeTurnEndEvent = event.outcome.status === "failed"
            ? {
                ...event,
                ...runScope,
                outcome: { status: "failed", error: boundedLifecycleAdapterError(event.outcome.error) },
              }
            : { ...event, ...runScope };
          if (extensionEvent.outcome.status === "completed") {
            const turns = this.#pendingExtensionTurns.get(event.runId) ?? new Map<number, RuntimeTurnEndEvent>();
            turns.set(event.step, extensionEvent);
            this.#pendingExtensionTurns.set(event.runId, turns);
          } else {
            await this.#observeRuntime("turn_end", extensionEvent, signal);
          }
        },
        afterProviderResponse: async (event, signal) => {
          await this.#observeRuntime(
            "after_provider_response",
            {
              ...(defaultSecretRedactor.redactValue(event) as typeof event),
              ...this.#runtimeRunScope(event),
            },
            signal,
          );
        },
        beforeCompaction: async (event, signal) => {
          const extensions = this.#resources.runtimeExtensions;
          if (extensions === undefined || !extensions.hasListeners("session_before_compact")) return undefined;
          const result = await extensions.reduceSessionBeforeCompact({
            ...this.#runtimeRunScope(event),
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
            ...this.#runtimeRunScope(event),
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
    this.#bindExtensionSessionHost(this.#resources.runtimeExtensions);
  }

  async initialize(options: { recover?: boolean; skills?: readonly SkillMetadata[] } = {}): Promise<void> {
    if (this.#closed) {
      if (this.#runtimeOwnerFailure !== undefined) {
        throw new HarnessError(
          "SERVICE_CLOSED",
          "Harness service lost runtime storage ownership",
          { cause: this.#runtimeOwnerFailure },
        );
      }
      throw new HarnessError("SERVICE_CLOSED", "Harness service is closed");
    }
    if (this.#initializing) throw new HarnessError("SERVICE_INITIALIZING", "Harness service is already initializing");
    this.#initializing = true;
    let ownerStarted = false;
    try {
      ownerStarted = this.#startRuntimeOwner();
      this.#workspaceBoundary = await WorkspaceBoundary.create(this.#options.workspace);
      const skills = options.skills === undefined
        ? await discoverSkills(this.#options.skillRoots ?? [])
        : [...options.skills];
      this.#resources = Object.freeze({
        ...this.#resources,
        skills: Object.freeze([...skills]),
      });
      if (options.recover === true) await this.recoverWorkspaceRuntime();
    } catch (error) {
      if (ownerStarted) this.#stopRuntimeOwner();
      throw error;
    } finally {
      this.#initializing = false;
    }
  }

  #startRuntimeOwner(): boolean {
    if (this.#runtimeOwnerStarted) return false;
    this.#options.store.acquireRuntimeOwner();
    this.#runtimeOwnerStarted = true;
    const heartbeatMs = Math.max(1, Math.floor(this.#options.store.runtimeOwnerLeaseMs / 3));
    this.#runtimeOwnerHeartbeat = setInterval(() => {
      try {
        this.#options.store.heartbeatRuntimeOwner();
      } catch (error) {
        if (
          !(error instanceof HarnessError)
          || !["STORAGE_OWNER", "STORAGE_OWNER_FENCED", "STORAGE_CLOSED"].includes(error.code)
        ) return;
        if (this.#runtimeOwnerHeartbeat !== undefined) clearInterval(this.#runtimeOwnerHeartbeat);
        this.#runtimeOwnerHeartbeat = undefined;
        this.#runtimeOwnerFailure = error;
        this.#closed = true;
        for (const threadId of this.#sessions.keys()) {
          this.#manager.cancel(threadId, "Runtime storage ownership was lost");
        }
      }
    }, heartbeatMs);
    this.#runtimeOwnerHeartbeat.unref();
    return true;
  }

  #stopRuntimeOwner(): void {
    if (this.#runtimeOwnerHeartbeat !== undefined) clearInterval(this.#runtimeOwnerHeartbeat);
    this.#runtimeOwnerHeartbeat = undefined;
    if (!this.#runtimeOwnerStarted) return;
    this.#runtimeOwnerStarted = false;
    this.#options.store.releaseRuntimeOwner();
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
    const session = this.#sessions.get(threadId);
    this.#sessionAccess.mutate({ type: "delete", threadId });
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
    const thread = this.#sessionAccess.mutate({
      type: "name",
      threadId: input.threadId,
      ...(input.name === undefined ? {} : { name: input.name }),
    });
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
    const changed = this.#sessionAccess.mutate({
      type: "label",
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
    const events = this.#sessionAccess.pagedEvents({
      threadId: input.threadId,
      branch,
      ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
      pageSize: HARNESS_TRANSCRIPT_LIMITS.maxEntries,
    });
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
    const page = this.#sessionAccess.metadataPage({
      ...(request.search === undefined ? {} : { search: request.search }),
      limit: request.limit,
      ...(request.after === undefined ? {} : { after: request.after }),
    });
    request.signal?.throwIfAborted();
    return harnessSessionPage(page.threads, page.hasMore, page.next, this.#workspaceRoot, request.search);
  }

  get skills(): readonly SkillMetadata[] {
    return this.#resources.skills;
  }

  /** Returns one deterministic, bounded metadata snapshot for every front end. */
  async resourceCatalog(signal: AbortSignal = AbortSignal.timeout(5_000)): Promise<HarnessResourceCatalog> {
    if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service is closed");
    if (this.#reloading) throw new HarnessError("SERVICE_RELOADING", "Harness resources are reloading");
    signal.throwIfAborted();
    const resources = this.#resources;
    const retained = this.#retainResourceGeneration(resources, signal);
    try {
      const models = await settlePromiseWithSignal(
        Promise.resolve().then(async () =>
          await resources.providers.listModels(undefined, retained.signal, { refresh: false })),
        retained.signal,
      );
      retained.signal.throwIfAborted();
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
      }, 0, resources);
      const extraTools = new Set(resources.extraTools);
      const toolOwner = (tool: HarnessTool): HarnessResourceOwner => {
        const owner = resources.runtimeExtensions?.toolOwner(tool);
        if (owner?.kind === "extension") return { kind: "extension", extensionId: owner.extensionId };
        return extraTools.has(tool) ? { kind: "host" } : { kind: "builtin" };
      };
      return buildHarnessResourceCatalog({
        tools,
        toolOwner,
        skills: resources.skills,
        providers: resources.providers.list().map((provider) => ({
          id: provider.id,
          models: groupedModels.get(provider.id) ?? [],
        })),
        ...(resources.runtimeExtensions === undefined ? {} : {
          runtimeCommands: resources.runtimeExtensions.commands(),
          runtimeDiagnostics: resources.runtimeExtensions.diagnostics(),
        }),
        ...resources.resourceCatalog,
      });
    } finally {
      retained.release();
    }
  }

  #retainResourceGeneration(
    resources: HarnessResourceGeneration,
    signal: AbortSignal,
    runHandoff = false,
  ): { signal: AbortSignal; release: () => void } {
    let readers = this.#resourceGenerationReaders.get(resources);
    if (readers === undefined) {
      let resolveIdle!: () => void;
      const idle = new Promise<void>((resolve) => { resolveIdle = resolve; });
      readers = { count: 0, runHandoffs: 0, idle, resolveIdle, controllers: new Set() };
      this.#resourceGenerationReaders.set(resources, readers);
    }
    const controller = new AbortController();
    readers.controllers.add(controller);
    readers.count += 1;
    if (runHandoff) readers.runHandoffs += 1;
    const retainedSignal = AbortSignal.any([signal, controller.signal]);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      retainedSignal.removeEventListener("abort", release);
      readers!.controllers.delete(controller);
      readers!.count -= 1;
      if (runHandoff) readers!.runHandoffs -= 1;
      if (readers!.count !== 0) return;
      this.#resourceGenerationReaders.delete(resources);
      readers!.resolveIdle();
    };
    if (runHandoff) {
      if (retainedSignal.aborted) release();
      else retainedSignal.addEventListener("abort", release, { once: true });
    }
    return { signal: retainedSignal, release };
  }

  async #waitForResourceGeneration(
    resources: HarnessResourceGeneration,
    signal?: AbortSignal,
  ): Promise<void> {
    const idle = this.#resourceGenerationReaders.get(resources)?.idle;
    if (idle === undefined) return;
    if (signal === undefined) {
      await idle;
      return;
    }
    signal.throwIfAborted();
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
      idle.then(
        () => finish(resolve),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }

  async #drainResourceGeneration(
    resources: HarnessResourceGeneration,
    reason: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.#resourceGenerationReaders.has(resources)) return;
    const timeout = AbortSignal.timeout(RESOURCE_GENERATION_READER_DRAIN_TIMEOUT_MS);
    try {
      await this.#waitForResourceGeneration(
        resources,
        signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      );
      return;
    } catch (error) {
      if (signal?.aborted === true) throw observerAbortReason(signal);
      if (!timeout.aborted) throw error;
    }
    // Resource lookups are raced against these controllers. Aborting first makes
    // every HarnessService reader release before its generation can be torn down;
    // a provider promise that settles later has no generation-dependent continuation.
    for (const controller of this.#resourceGenerationReaders.get(resources)?.controllers ?? []) {
      controller.abort(reason);
    }
    await this.#waitForResourceGeneration(resources);
  }

  async #drainAllResourceGenerations(): Promise<void> {
    const resources = [...this.#resourceGenerationReaders.keys()];
    await Promise.all(resources.map(async (generation) => await this.#drainResourceGeneration(
      generation,
      new HarnessError("SERVICE_CLOSED", "Resource lookup cancelled because the harness service is closing"),
    )));
  }

  #hasPendingRunHandoff(): boolean {
    return [...this.#resourceGenerationReaders.values()].some((readers) => readers.runHandoffs !== 0);
  }

  onExtensionSessionEvent(listener: ExtensionSessionPublicationListener): () => void {
    if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service is closed");
    this.#extensionSessionListeners.add(listener);
    return () => this.#extensionSessionListeners.delete(listener);
  }

  async resolveModelSelection(
    reference: string,
    options: ResolveModelSelectionOptions & { retainGeneration: true; lookupSignal?: AbortSignal },
  ): Promise<RetainedModelSelection>;
  async resolveModelSelection(
    reference: string,
    options?: ResolveModelSelectionOptions,
  ): Promise<ResolvedModelSelection>;
  async resolveModelSelection(
    reference: string,
    options: ResolveModelSelectionOptions & { retainGeneration?: true; lookupSignal?: AbortSignal } = {},
  ): Promise<ResolvedModelSelection | RetainedModelSelection> {
    if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service is closed");
    if (this.#reloading) throw new HarnessError("SERVICE_RELOADING", "Harness resources are reloading");
    const {
      signal = AbortSignal.timeout(30_000),
      lookupSignal,
      retainGeneration = false,
      ...resolutionOptions
    } = options;
    const resources = this.#resources;
    const retained = this.#retainResourceGeneration(resources, signal, retainGeneration);
    const resolutionSignal = lookupSignal === undefined
      ? retained.signal
      : AbortSignal.any([retained.signal, lookupSignal]);
    let handedOff = false;
    try {
      const selection = await settlePromiseWithSignal(
        resources.providers.requireModelReference(reference, resolutionSignal, resolutionOptions),
        resolutionSignal,
      );
      retained.signal.throwIfAborted();
      if (retainGeneration) {
        handedOff = true;
        return { selection, signal: retained.signal, release: retained.release };
      }
      return selection;
    } finally {
      if (!handedOff) retained.release();
    }
  }

  async run(options: RunOptions): Promise<HarnessRun> {
    if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service is closed");
    if (this.#reloading) throw new HarnessError("SERVICE_RELOADING", "Harness resources are reloading");
    options.signal?.throwIfAborted();
    const resumed = options.threadId !== undefined;
    const threadId = options.threadId ?? createId("thread");
    let thread = resumed ? this.#sessionAccess.thread(threadId) : undefined;
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
            thread = this.#sessionAccess.mutate({ type: "create", threadId });
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
      if (thread !== undefined) this.#sessionAccess.queue(threadId, queueBranch).recoverAll();
    }
  }

  async createSession(input: CreateSessionInput = {}) {
    return await this.#createSession(input, false);
  }

  async #createSession(input: CreateSessionInput, runtimeChild: boolean) {
    if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service is closed");
    if (this.#reloading) throw new HarnessError("SERVICE_RELOADING", "Harness resources are reloading");
    const threadId = input.threadId ?? createId("thread");
    if (threadId.length === 0 || threadId.includes("\0") || Buffer.byteLength(threadId, "utf8") > 256) {
      throw new HarnessError("SERVICE_SESSION_ID", "Session ID must contain 1 to 256 UTF-8 bytes and no NUL");
    }
    const branch = input.defaultBranch ?? "main";
    if (input.parentThreadId !== undefined && this.#resources.runtimeExtensions?.hasListeners("session_before_fork") === true) {
      const result = await this.#resources.runtimeExtensions.reduceSessionBeforeFork({
        sourceThreadId: input.parentThreadId,
        targetThreadId: threadId,
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
        const command = {
          type: "create",
          threadId,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.defaultBranch === undefined ? {} : { defaultBranch: input.defaultBranch }),
          ...(input.parentThreadId === undefined ? {} : { parentThreadId: input.parentThreadId }),
          ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
        } as const;
        created = runtimeChild
          ? this.#sessionAccess.createRuntimeChild(command)
          : this.#sessionAccess.mutate(command);
      },
    );
    if (created === undefined) throw new HarnessError("STORAGE_WRITE", "Session creation did not produce a thread");
    return created;
  }

  async cloneSessionPath(
    input: Omit<CloneSessionPathInput, "workspaceRoot" | "targetThreadId"> & { signal?: AbortSignal },
  ): Promise<CloneSessionPathResult> {
    return await this.#cloneSessionPath(input, createId("thread"), false);
  }

  async #cloneSessionPath(
    input: Omit<CloneSessionPathInput, "workspaceRoot" | "targetThreadId"> & { signal?: AbortSignal },
    targetThreadId: string,
    runtimeChild: boolean,
  ): Promise<CloneSessionPathResult> {
    if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service is closed");
    if (this.#reloading) throw new HarnessError("SERVICE_RELOADING", "Harness resources are reloading");
    input.signal?.throwIfAborted();
    const source = this.#sessionAccess.thread(input.threadId);
    const sourceBranch = input.branch ?? source.defaultBranch;
    const branch = source.branches.find((entry) => entry.name === sourceBranch);
    if (branch === undefined) throw new Error(`Unknown branch: ${sourceBranch}`);
    const sourceEventId = typeof input.atEventId === "string"
      ? input.atEventId
      : input.beforeEventId ?? branch.headEventId;
    const extensions = this.#resources.runtimeExtensions;
    if (extensions?.hasListeners("session_before_fork") === true) {
      const directive = await extensions.reduceSessionBeforeFork({
        sourceThreadId: input.threadId,
        targetThreadId,
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
    const cloneInput = {
      threadId: input.threadId,
      ...(input.branch === undefined ? {} : { branch: input.branch }),
      ...(input.atEventId === undefined ? {} : { atEventId: input.atEventId }),
      ...(input.beforeEventId === undefined ? {} : { beforeEventId: input.beforeEventId }),
      ...(input.name === undefined ? {} : { name: input.name }),
      targetThreadId,
    };
    return runtimeChild
      ? this.#sessionAccess.cloneRuntimeChild(cloneInput)
      : this.#sessionAccess.clone(cloneInput);
  }

  async navigateTree(options: NavigateTreeOptions): Promise<NavigateTreeResult> {
    if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service is closed");
    if (this.#reloading) throw new HarnessError("SERVICE_RELOADING", "Harness resources are reloading");
    const thread = this.#sessionAccess.thread(options.threadId);
    const sourceBranch = options.branch ?? thread.defaultBranch;
    this.#sessionAccess.branch(options.threadId, options.targetBranch);
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
      const branchEvents = this.#sessionAccess.snapshot({
        threadId: options.threadId,
        branch: sourceBranch,
        include: { branchEvents: [sourceBranch, options.targetBranch] },
      }).branchEvents;
      const preparation = prepareAbandonedBranch(
        branchEvents?.get(sourceBranch) ?? [],
        branchEvents?.get(options.targetBranch) ?? [],
        options.targetEventId,
      );
      if (options.label !== undefined && preparation.messages.length === 0) {
        throw new Error("A branch summary label requires abandoned conversational content");
      }
      const priorEventId = thread.branches
        .find((entry) => entry.name === sourceBranch)?.headEventId;
      const extensions = this.#resources.runtimeExtensions;
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
            modelMaxOutputTokens = (await this.#resources.providers.resolveModel(
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
            provider: this.#resources.providers.get(options.provider!),
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
        const committed = this.#sessionAccess.mutate({
          type: "fork_with_summary",
          input: {
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
          },
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
      const branch = this.#sessionAccess.mutate({
        type: "fork",
        input: {
          threadId: options.threadId,
          fromBranch: options.targetBranch,
          newBranch: options.newBranch,
          atEventId: options.targetEventId,
        },
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
    const thread = this.#sessionAccess.thread(options.threadId);
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
      this.#sessionAccess.queue(options.threadId, branch).recoverAll();
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
    const thread = this.#sessionAccess.thread(threadId);
    return branch ?? this.#sessions.get(threadId)?.branch ?? thread.defaultBranch;
  }

  #enqueueRunInput(
    threadId: string,
    mode: QueuedRunMessage["mode"],
    message: string,
    images?: ImageBlock[],
  ): void {
    this.#sessionAccess.thread(threadId);
    if (this.#childRunDepth.has(threadId)) {
      throw new HarnessError(
        "RUNTIME_CHILD_QUEUE",
        "Active runtime child runs do not accept steering or follow-up messages",
      );
    }
    const branch = this.#manager.activeBranch(threadId);
    if (branch === undefined) throw new Error(`Thread has no active run: ${threadId}`);
    const queue = this.#sessionAccess.queue(threadId, branch);
    const record = queue.enqueue({
      mode,
      text: message,
      ...(images === undefined ? {} : { images }),
    });
    let leased = false;
    const receipt: QueuedRunDeliveryReceipt = {
      queueId: record.queueId,
      messageId: record.messageId,
      begin: (): void => {
        if (!leased) queue.transition(record.queueId, "begin_delivery");
      },
      delivered: (): void => leased
        ? queue.transition(record.queueId, "acknowledge")
        : queue.transition(record.queueId, "complete_delivery"),
      dequeued: (): void => queue.transition(record.queueId, "dequeue"),
      leased: (): void => {
        queue.transition(record.queueId, "lease");
        leased = true;
      },
    };
    try {
      if (mode === "follow_up") this.#manager.followUp(threadId, message, images, receipt);
      else this.#manager.steer(threadId, message, images, receipt);
    } catch (error) {
      queue.transition(record.queueId, "recover");
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
    const selectedBranch = this.#queueBranch(threadId, branch);
    const recovered = this.#sessionAccess.queue(threadId, selectedBranch).list(["recoverable"])
      .map((record) => this.#runInputMessage(record));
    return [...recovered, ...this.#manager.queuedMessages(threadId)];
  }

  recoverableMessageCount(threadId: string, branch?: string): number {
    const selectedBranch = this.#queueBranch(threadId, branch);
    return this.#sessionAccess.queue(threadId, selectedBranch).list(["recoverable"]).length;
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
    const selectedBranch = this.#queueBranch(threadId, branch);
    const queue = this.#sessionAccess.queue(threadId, selectedBranch);
    const recovered = queue.list(["recoverable"])[0];
    if (recovered !== undefined) {
      queue.transition(recovered.queueId, "lease");
      const message = this.#runInputMessage(recovered);
      attachQueuedRunDelivery(message, {
        queueId: recovered.queueId,
        messageId: recovered.messageId,
        begin: () => {},
        delivered: () => queue.transition(recovered.queueId, "acknowledge"),
        dequeued: () => queue.transition(recovered.queueId, "acknowledge"),
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
    this.#sessionAccess.queue(lease.threadId, lease.branch).transition(lease.leaseId, "acknowledge");
  }

  releaseQueueLease(lease: Pick<RunInputQueueLease, "leaseId" | "threadId" | "branch">): void {
    this.#sessionAccess.queue(lease.threadId, lease.branch).transition(lease.leaseId, "release");
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
    if (this.#hasPendingRunHandoff()) throw new HarnessError("SERVICE_BUSY", "Cannot reload resources while a run is starting");
    const candidate = immutableResourceGeneration(resources);
    const previous = this.#resources;
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
      if (this.#hasPendingRunHandoff()) throw new HarnessError("SERVICE_BUSY", "Cannot reload resources while a run is starting");
      if (this.#options.managedExtensionLifecycle !== false) {
        await Promise.allSettled(sessions.map(async ([threadId, session]) => await this.#observeRuntime("session_end", {
          reason: "reload",
          threadId,
          ...(session.branch === undefined ? {} : { branch: session.branch }),
          workspace: this.#workspaceRoot,
        })));
      }
      sessionsEnded = true;
      this.#resources = candidate;
      this.#bindExtensionSessionHost(candidate.runtimeExtensions);
      await this.#drainResourceGeneration(
        previous,
        new HarnessError("SERVICE_RELOADING", "Resource lookup cancelled because resources are reloading"),
        options.signal,
      );
      if (this.#closed) throw new HarnessError("SERVICE_CLOSED", "Harness service closed while resources were reloading");
      options.signal?.throwIfAborted();
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
      if (this.#resources !== previous) {
        this.#resources = previous;
        this.#bindExtensionSessionHost(previous.runtimeExtensions);
      }
      if (sessionsEnded && this.#options.managedExtensionLifecycle !== false) {
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

  close(reason = "runtime_close"): Promise<void> {
    this.#closeFlight ??= this.#close(reason);
    return this.#closeFlight;
  }

  async #close(reason: string): Promise<void> {
    this.#closed = true;
    this.#reloading = false;
    try {
      await this.#drainAllResourceGenerations();
      const sessionEndReason = this.#runtimeOwnerFailure === undefined ? reason : "runtime_owner_lost";
      const sessions = [...this.#sessions.entries()];
      this.#sessions.clear();
      await Promise.allSettled(sessions.map(async ([threadId, session]) => {
        if (this.#options.managedExtensionLifecycle !== false) {
          await this.#observeRuntime("session_end", {
            reason: sessionEndReason,
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
    } finally {
      this.#stopRuntimeOwner();
    }
  }

  async #canonicalRunOptions<T extends Pick<RunOptions, "provider" | "model" | "reasoningEffort" | "signal">>(
    options: T,
    refreshStale: boolean,
  ): Promise<T> {
    const status = refreshStale ? (await this.#resources.providers.catalogStatus(options.provider))[0] : undefined;
    const refresh = status !== undefined && (status.provenance === "none" || status.stale);
    const resolutionSignal = options.signal === undefined
      ? AbortSignal.timeout(30_000)
      : AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]);
    const selected = await this.#resources.providers.requireModelReference(
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
    const outboundImages = options.outboundImages ?? this.#resources.outboundImages;
    if (outboundImages !== "allow" && outboundImages !== "block") {
      throw new Error("outboundImages must be allow or block");
    }
    if (options.autoCompaction !== undefined && typeof options.autoCompaction !== "boolean") {
      throw new Error("autoCompaction must be a boolean");
    }
    const autoCompaction = options.autoCompaction ?? this.#resources.autoCompaction;
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
    const provider = this.#resources.providers.runtimeAdapter(options.provider);
    let automaticContextBudget: ReturnType<typeof resolveEffectiveContextBudget> | undefined;
    let resolvedModel: Awaited<ReturnType<ProviderRegistry["resolveModel"]>>;
    try {
      resolvedModel = await this.#resources.providers.resolveModel(
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
    const toolBackend = options.toolBackend === undefined ? this.#resources.toolBackend : options.toolBackend ?? undefined;
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
        trusted: this.#resources.projectTrusted,
        ...(this.#options.userInstructions === undefined ? {} : { userInstructions: this.#options.userInstructions }),
        ...(this.#options.userInstructionFile === undefined ? {} : { userInstructionFile: this.#options.userInstructionFile }),
        ...(options.noContextFiles === true ? { includeFiles: false } : {}),
      });
      const automaticPromptFiles = options.noContextFiles === true
        ? {}
        : await discoverWorkspacePromptFiles(
            this.#options.workspace,
            this.#resources.projectTrusted,
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
        skills: this.#resources.skills,
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
          skills: this.#resources.skills,
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
        ...(this.#resources.runtimeExtensions?.hasListeners("tool_call") === true
          ? {
              beforeCall: async (invocation, context) =>
                await this.#resources.runtimeExtensions!.reduceToolCall({
                  ...invocation,
                  threadId: context.threadId,
                  runId: context.runId,
                  branch: activeToolBranch,
                  ...(context.step === undefined ? {} : { step: context.step }),
                }, context.signal),
            }
          : {}),
        ...(this.#resources.runtimeExtensions?.hasListeners("tool_result") === true
          ? {
              afterResult: async (
                invocation: Parameters<RuntimeExtensionHost["reduceToolCall"]>[0],
                result: Parameters<RuntimeExtensionHost["reduceToolResult"]>[0]["result"],
                context: { signal: AbortSignal; threadId: string; runId: string; branch?: string; step?: number },
              ) => await this.#resources.runtimeExtensions!.reduceToolResult({
                threadId: context.threadId,
                runId: context.runId,
                branch: context.branch ?? activeToolBranch,
                ...(context.step === undefined ? {} : { step: context.step }),
                invocation,
                result,
              }, context.signal),
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
      const selectedBranch = options.branch ?? this.#sessionAccess.thread(threadId).defaultBranch;
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
        branch: activeToolBranch,
        prompt: options.prompt,
        ...(options.displayPrompt === undefined ? {} : { displayPrompt: options.displayPrompt }),
        ...(options.images === undefined ? {} : { images: options.images }),
        ...(promptQueueMessage === undefined ? {} : { promptQueueMessage }),
        outboundImages,
        ...(supportsImages === undefined ? {} : { supportsImages }),
        provider,
        model: options.model,
        ...(this.#resources.runtimeExtensions === undefined || this.#resources.runtimeExtensions.extensions().length === 0
          ? {}
          : {
              refreshTurnSelection: async (
                current: Parameters<NonNullable<AgentRunRequest["refreshTurnSelection"]>>[0],
                signal: AbortSignal,
              ) => {
                const stored = this.#sessionAccess.modelSelection(threadId, activeToolBranch);
                if (
                  stored === undefined ||
                  (
                    stored.provider === current.provider &&
                    stored.model === current.model &&
                    stored.reasoningEffort === current.reasoningEffort
                  )
                ) return undefined;
                const selected = await this.#resources.providers.requireModelReference(stored.model, signal, {
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
                  provider: this.#resources.providers.runtimeAdapter(selected.provider),
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
        ...(this.#resources.compactionRetainRecentTurns === undefined ? {} : { compactionRetainRecentTurns: this.#resources.compactionRetainRecentTurns }),
        ...(this.#resources.compactionToolResultBytes === undefined ? {} : { compactionToolResultBytes: this.#resources.compactionToolResultBytes }),
        ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
        ...(options.manualCompaction === true ? { manualCompaction: true } : {}),
        ...(options.compactionInstructions === undefined ? {} : { compactionInstructions: options.compactionInstructions }),
        ...(options.steeringMode === undefined ? {} : { steeringMode: options.steeringMode }),
        ...(options.followUpMode === undefined ? {} : { followUpMode: options.followUpMode }),
        ...(this.#resources.retry === undefined ? {} : { retry: { ...this.#resources.retry } }),
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
    const extensions = this.#resources.runtimeExtensions;
    if (extensions === undefined) return undefined;
    const beforeAgentStart = extensions.hasListeners("before_agent_start");
    const context = extensions.hasListeners("context");
    const messageEnd = extensions.hasListeners("message_end");
    const beforeProviderRequest = extensions.hasListeners("before_provider_request");
    if (!beforeAgentStart && !context && !messageEnd && !beforeProviderRequest) return undefined;
    return {
      ...(beforeAgentStart
        ? {
            beforeAgentStart: async (event, signal) => await extensions.reduceBeforeAgentStart({
              ...event,
              ...this.#runtimeRunScope(event),
            }, signal),
          }
        : {}),
      ...(context
        ? {
            context: async (messages, signal, scope) => await extensions.reduceContext({
              ...this.#runtimeRunScope(scope),
              messages: [...messages],
            }, signal),
          }
        : {}),
      ...(messageEnd
        ? {
            messageEnd: async (message, signal, scope) => await extensions.reduceMessageEnd({
              ...this.#runtimeRunScope(scope),
              message,
            }, signal),
          }
        : {}),
      ...(beforeProviderRequest
        ? {
            beforeProviderRequest: async (event, signal) => await extensions.reduceBeforeProviderRequest({
              ...event,
              ...this.#runtimeRunScope(event),
            }, signal),
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
    const events = this.#sessionAccess.snapshot({
      threadId,
      ...(branch === undefined ? {} : { branch }),
      include: { events: true },
    }).events ?? [];
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

  #buildTools(
    _threadId: string,
    options: RunOptions,
    _depth: number,
    resources: HarnessResourceGeneration = this.#resources,
  ): HarnessTool[] {
    const builtins: HarnessTool[] = [
      new ReadTool(),
      new GrepTool(),
      new FindTool(),
      new LsTool(),
      new WriteTool(),
      new EditTool(),
      new ShellTool("bash", resources.shellPath === undefined ? {} : { shellPath: resources.shellPath }),
    ];
    const tools = new Map<string, HarnessTool>();
    if (options.noBuiltinTools !== true) {
      for (const tool of builtins) tools.set(tool.definition.name, tool);
    }
    for (const tool of resources.extraTools) tools.set(tool.definition.name, tool);
    for (const tool of resources.runtimeExtensions?.tools() ?? []) tools.set(tool.definition.name, tool);
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
    const extensions = this.#resources.runtimeExtensions;
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
        branch: projection.branch,
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
        branch: projection.branch,
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
        branch: projection.branch,
        ...(projection.step > 0 ? { step: projection.step } : {}),
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
          branch: projection.branch,
          ...(projection.step > 0 ? { step: projection.step } : {}),
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
          branch: projection.branch,
          ...(projection.step > 0 ? { step: projection.step } : {}),
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
          branch: projection.branch,
          ...(projection.step > 0 ? { step: projection.step } : {}),
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
          branch: projection.branch,
          ...(projection.step > 0 ? { step: projection.step } : {}),
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
          branch: projection.branch,
          ...(projection.step > 0 ? { step: projection.step } : {}),
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

  #runtimeRunScope(event: {
    threadId: string;
    runId: string;
    branch?: string;
    step?: number;
  }): RuntimeRunScope {
    return Object.freeze({
      threadId: event.threadId,
      runId: event.runId,
      branch: this.#extensionBranch(event.threadId, event.branch),
      ...(event.step === undefined ? {} : { step: event.step }),
    });
  }

  #extensionBranch(threadId: string, branch: string | undefined): string {
    return this.#sessionAccess.branch(threadId, branch);
  }

  #activeToolKey(threadId: string, branch: string): string {
    return `${threadId}\0${branch}`;
  }

  #runtimeModelSelection(threadId: string, branch: string): RuntimeModelSelection | undefined {
    return this.#runtimeModelSelections.get(this.#activeToolKey(threadId, branch))
      ?? this.#sessionAccess.modelSelection(threadId, branch);
  }

  #configuredToolNames(threadId: string): string[] {
    return this.#buildTools(threadId, {
      prompt: "",
      provider: "runtime",
      model: "runtime",
    }, 0).map((tool) => tool.definition.name).sort((left, right) => left.localeCompare(right));
  }

  async #extensionContextUsage(
    events: readonly EventEnvelope[],
    runs: readonly RunRecord[],
    signal?: AbortSignal,
  ): Promise<RuntimeSessionSnapshot["contextUsage"]> {
    const pathRunIds = new Set(events.flatMap((event) => event.runId === undefined ? [] : [event.runId]));
    const latestRun = runs.filter((run) => pathRunIds.has(run.runId)).at(-1);
    if (latestRun?.provider === undefined || latestRun.model === undefined) return undefined;
    const latestUsage = latestRunContextUsage(events, latestRun.runId);
    if (latestUsage === undefined) return undefined;
    const lastCompaction = events.findLast((entry) => entry.event.type === "compaction_completed")?.sequence;
    if (lastCompaction !== undefined && latestUsage.sequence <= lastCompaction) return undefined;
    try {
      const modelSignal = signal === undefined
        ? AbortSignal.timeout(5_000)
        : AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
      const model = (await this.#resources.providers.listModels(latestRun.provider, modelSignal, { refresh: false }))
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
    const snapshot = this.#sessionAccess.snapshot({
      threadId,
      branch,
      include: {
        events: true,
        runs: true,
        runInputStates: ["recoverable"],
      },
    });
    const { thread } = snapshot;
    const events = snapshot.events ?? [];
    const runs = snapshot.runs ?? [];
    const activeBranch = this.#manager.activeBranch(threadId);
    const active = this.#manager.active(threadId) && (activeBranch === undefined || activeBranch === branch);
    const activeRun = active
      ? runs.findLast((run) =>
          run.branch === branch && !["completed", "failed", "cancelled"].includes(run.state))
      : undefined;
    const operation = active ? runtimeSessionPhase(events, activeRun?.runId) : undefined;
    const recoverableMessageCount = snapshot.runInputs?.length ?? 0;
    const pendingMessageCount = recoverableMessageCount + (active ? this.#manager.queuedMessages(threadId).length : 0);
    const contextUsage = await this.#extensionContextUsage(events, runs, signal);
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
    const durableChild = this.#hasRuntimeChildThread([input.threadId, input.requesterThreadId]);
    if (parentDepth >= 1 || durableChild) throw new Error("Nested runtime child runs are disabled");
    const childRunPolicy = this.#resources.childRunPolicy;
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
    const configuredBackend = this.#resources.toolBackend;
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
    const pendingChildThreadId = createId("thread");
    this.#childRunDepth.set(pendingChildThreadId, parentDepth + 1);
    try {
      const cwd = input.cwd === undefined
        ? this.#sessions.get(input.threadId)?.cwd ?? this.#workspaceRoot
        : await (this.#workspaceBoundary ?? await WorkspaceBoundary.create(this.#workspaceRoot)).readable(input.cwd);
      const parentSnapshot = this.#sessionAccess.snapshot({
        threadId: input.threadId,
        branch: parentBranch,
        include: { events: true, runs: true },
      });
      const activeRun = this.#manager.active(input.threadId)
        ? parentSnapshot.runs?.findLast((run) =>
            run.branch === parentBranch && !["completed", "failed", "cancelled"].includes(run.state))
        : undefined;
      const activeEvents = activeRun === undefined
        ? []
        : (parentSnapshot.events ?? []).filter((event) => event.runId === activeRun.runId);
      const currentToolRequest = activeEvents.findLast((event) =>
        event.event.type === "message_appended" &&
        event.event.message.role === "assistant" &&
        event.event.message.content.some((block) => block.type === "tool_call"));
      const child = input.context === "fork"
        ? (await this.#cloneSessionPath({
            threadId: input.threadId,
            branch: parentBranch,
            ...(currentToolRequest === undefined ? {} : { beforeEventId: currentToolRequest.eventId }),
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          }, pendingChildThreadId, true)).thread
        : await this.#createSession({
            threadId: pendingChildThreadId,
            parentThreadId: input.threadId,
            cwd,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          }, true);
      const childBranch = child.defaultBranch;
      const childSession: RuntimeChildSession = {
        threadId: child.threadId,
        branch: childBranch,
        model: childModel,
        persisted,
      };
      const artifactIdsBeforeRun = new Set(
        (this.#sessionAccess.snapshot({
          threadId: child.threadId,
          branch: childBranch,
          include: { artifacts: true },
        }).artifacts ?? []).map((artifact) => artifact.artifactId),
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
      const childSnapshot = this.#sessionAccess.snapshot({
        threadId: child.threadId,
        branch: childBranch,
        include: { events: true, runs: true, artifacts: true },
      });
      const runRecord = childSnapshot.runs?.at(-1);
      const selectedRunId = outcome.runId ?? runRecord?.runId;
      if (selectedRunId !== undefined) {
        const events = childSnapshot.events ?? [];
        const usage = runtimeChildUsage(events, selectedRunId);
        const allArtifacts = (childSnapshot.artifacts ?? [])
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
      this.#childRunDepth.delete(pendingChildThreadId);
      this.#activeChildRuns -= 1;
    }
  }

  #hasRuntimeChildThread(threadIds: readonly (string | undefined)[]): boolean {
    const uniqueThreadIds = new Set(threadIds.filter((threadId): threadId is string => threadId !== undefined));
    for (const threadId of uniqueThreadIds) {
      if (this.#childRunDepth.has(threadId)) return true;
      if (this.#sessionAccess.hasRuntimeChildThread(threadId)) return true;
    }
    return false;
  }

  async #publishExtensionSessionEvent(publication: ExtensionSessionPublication): Promise<void> {
    const listeners = [...this.#extensionSessionListeners];
    if (listeners.length === 0) return;
    const results = await Promise.allSettled(listeners.map(async (listener) => await listener(structuredClone(publication))));
    for (const result of results) {
      if (result.status !== "rejected") continue;
      this.#resources.runtimeExtensions?.addDiagnostic({
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
        const envelope = this.#sessionAccess.appendEvent(input.threadId, branch, event);
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
        const result = this.#sessionAccess.compareAndAppendExtensionState({
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
        const envelope = this.#sessionAccess.extensionState(
          input.threadId,
          branch,
          input.extensionId,
          input.schemaVersion,
          input.key,
        );
        return envelope === undefined ? undefined : extensionStateRecord(envelope, branch);
      },
      appendMessage: async (input) => {
        input.signal?.throwIfAborted();
        const branch = this.#extensionBranch(input.threadId, input.branch);
        const event = defaultSecretRedactor.redactValue(input.event) as ExtensionMessageEvent;
        const envelope = this.#sessionAccess.appendEvent(input.threadId, branch, event);
        await this.#publishExtensionSessionEvent({
          branch,
          envelope: envelope as EventEnvelope<ExtensionMessageEvent>,
        });
        return extensionMessageRecord(envelope as EventEnvelope<ExtensionMessageEvent>, branch);
      },
      readMessages: async (input) => {
        input.signal?.throwIfAborted();
        const branch = this.#extensionBranch(input.threadId, input.branch);
        return this.#sessionAccess.extensionMessages(
          input.threadId,
          branch,
          input.extensionId,
          input.schemaVersion,
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
        const extraTools = new Set(this.#resources.extraTools);
        return tools
          .map((tool) => ({
            name: tool.definition.name,
            description: tool.definition.description,
            inputSchema: structuredClone(tool.definition.inputSchema),
            active: active.has(tool.definition.name),
            executionMode: tool.executionMode ?? "parallel",
            owner: this.#resources.runtimeExtensions?.toolOwner(tool)
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
        this.#sessionAccess.thread(input.threadId);
        if (!this.#manager.active(input.threadId)) return false;
        if (input.branch !== undefined && this.#manager.activeBranch(input.threadId) !== input.branch) {
          throw new HarnessError("SERVICE_QUEUE_BRANCH", `Active run is not on branch ${input.branch}`);
        }
        this.cancel(input.threadId, input.reason);
        return true;
      },
      compact: async (input) => {
        input.signal?.throwIfAborted();
        const thread = this.#sessionAccess.thread(input.threadId);
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
        return this.#sessionAccess.tree(input.threadId, branch);
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
        this.#sessionAccess.appendEvent(input.threadId, branch, {
          type: "model_selected",
          provider: selected.provider,
          model: selected.model,
          ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
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
        this.#sessionAccess.appendEvent(input.threadId, branch, {
          type: "model_selected",
          provider: selected.provider,
          model: selected.model,
          ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
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
    const extensions = this.#resources.runtimeExtensions;
    if (extensions === undefined || !extensions.hasListeners(event)) return;
    try {
      await extensions.dispatch(event, value, extensionObserverSignal(signal));
    } catch {
      // RuntimeExtensionHost records each listener failure. An after-event
      // observer cannot roll back work that is already durable.
    }
  }

}
