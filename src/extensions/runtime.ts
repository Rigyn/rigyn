import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { registerHooks } from "node:module";
import { dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { register as registerTsxCommonJsLoader } from "tsx/cjs/api";
import { register as registerTsxModuleLoader } from "tsx/esm/api";

import {
  cloneProviderAuthDescriptor,
  normalizeProviderAuthDescriptor,
  type ProviderAuthDescriptor,
} from "../auth/provider-descriptor.js";
import type { CompactionPlan, CompactionReason } from "../context/compaction.js";
import type {
  AssistantResponseTransformationAudit,
  AssistantResponseTransformationField,
  EventEnvelope,
  RuntimeEvent,
  ToolUpdate,
} from "../core/events.js";
import {
  canonicalExtensionMessageEvent,
  canonicalExtensionStateEvent,
  validateExtensionEntryKey,
  validateExtensionId,
  validateExtensionSchemaVersion,
  type ExtensionMessageModelContext,
  type ExtensionMessageTranscript,
  type ExtensionMessageEvent,
  type ExtensionStateEvent,
} from "../core/extension-entries.js";
import { createId } from "../core/ids.js";
import { ABSOLUTE_CHILD_RUN_LIMITS } from "../core/child-runs.js";
import { isJsonValue, type JsonValue } from "../core/json.js";
import type {
  AdapterError,
  CanonicalMessage,
  FinishReason,
  ImageBlock,
  ModelInfo,
  NormalizedUsage,
  PromptCompositionMetadata,
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  ProviderResponseDiagnostics,
  ProviderResponseFailureMetadata,
  ToolDefinition,
  ToolResultBlock,
} from "../core/types.js";
import { isNormalizedUsage } from "../core/usage.js";
import { defaultSecretRedactor } from "../auth/redaction.js";
import {
  sanitizeRuntimeUiBlock,
  sanitizeRuntimeUiRenderContext,
  type RuntimeEditorRenderer,
  type RuntimeEditorRenderView,
  type RuntimeToolRenderer,
  type RuntimeToolRenderView,
  type RuntimeUiBlock,
  type RuntimeUiComponentFactory,
  type RuntimeUiCustomOptions,
  type RuntimeUiKeyEvent,
  type RuntimeUiOverlayHandle,
  type RuntimeUiRenderContext,
} from "../tui/components.js";
import { sanitizeTerminalText, splitGraphemes } from "../tui/unicode.js";
import type { NativeUiHost, UnsafeTerminalHost } from "../tui/native-ui.js";
import type { ProviderWireInterceptor } from "../providers/wire.js";
import { MAX_TOOL_TRANSFORMATION_AUDIT_ENTRIES } from "../tools/coordinator.js";
import { sha256 } from "../tools/hash.js";
import { assertSchema } from "../tools/schema.js";
import { assertCanonicalDirectoryCreationPath } from "../config/canonical-path.js";
import type { JsonObject } from "../config/jsonc.js";
import type {
  HarnessTool,
  ResourceClaim,
  ToolArtifact,
  ToolContext,
  ToolExecutionMode,
  ToolInputPreparer,
  ToolInputTransformationAudit,
  ToolInvocation,
  ToolResult,
} from "../tools/types.js";
import type { ExtensionRuntimeEntry, ExtensionScope } from "./types.js";
import type { RunRecord, ThreadRecord } from "../storage/types.js";
import { isBuiltinSlashCommand } from "./reserved.js";
import {
  parseHarnessResourceCatalog,
  type HarnessResourceCatalog,
} from "../service/resource-catalog.js";
import {
  HARNESS_TRANSCRIPT_LIMITS,
  parseHarnessTranscriptPage,
  type HarnessTranscriptPage,
} from "../service/transcript.js";
import {
  HARNESS_SESSION_CATALOG_LIMITS,
  parseHarnessSessionPage,
  type HarnessSessionPage,
} from "../service/session-catalog.js";

export type {
  RuntimeToolRenderer,
  RuntimeToolRenderView,
  RuntimeUiBlock,
  RuntimeUiComponent,
  RuntimeUiComponentFactory,
  RuntimeUiComponentHandle,
  RuntimeUiComponentHost,
  RuntimeUiCustomOptions,
  RuntimeUiKeyEvent,
  RuntimeUiLine,
  RuntimeUiOverlayAnchor,
  RuntimeUiOverlayHandle,
  RuntimeUiOverlayLength,
  RuntimeUiOverlayMargin,
  RuntimeUiOverlayOptions,
  RuntimeUiOverlayUnfocusOptions,
  RuntimeUiRenderContext,
  RuntimeUiSpan,
  RuntimeEditorRenderer,
  RuntimeEditorRenderView,
} from "../tui/components.js";

const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;
const AUTH_PROVIDER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const COMMAND = /^[a-z][a-z0-9-]{0,62}$/u;
const FLAG = /^[a-z][a-z0-9-]{0,62}$/u;
const SHORTCUT_MODIFIERS = new Set(["ctrl", "shift", "alt", "super", "hyper", "meta"]);
const SHORTCUT_NAMED_KEYS = new Set([
  "backspace", "begin", "capslock", "delete", "down", "end", "enter", "escape", "home", "insert", "left",
  "menu", "numlock", "pagedown", "pageup", "pause", "printscreen", "right", "scrolllock", "space", "tab", "up",
  ...Array.from({ length: 35 }, (_, index) => `f${index + 1}`),
  ...Array.from({ length: 10 }, (_, index) => `kp${index}`),
  "kpadd", "kpbegin", "kpdecimal", "kpdelete", "kpdivide", "kpend", "kpenter", "kpequal", "kphome", "kpinsert",
  "kpleft", "kpmultiply", "kppagedown", "kppageup", "kpright", "kpseparator", "kpsubtract", "kpup", "kpdown",
]);
const MAX_RENDERER_FAILURE_DIAGNOSTICS = 128;
const MAX_RUNTIME_DIAGNOSTICS = 512;
const MAX_RUNTIME_INITIAL_UI_OPERATIONS = 512;
const MAX_RUNTIME_SESSION_MESSAGE_READ = 1_000;
const MAX_RUNTIME_ACTIVE_TOOLS = 512;
const MAX_RUNTIME_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_RUNTIME_SHARED_EVENT_LISTENERS = 1_024;
const MAX_RUNTIME_TOOL_PROMPT_GUIDELINES = 32;
const MAX_RUNTIME_RESOURCE_PATHS_PER_LISTENER = 64;
const MAX_RUNTIME_DISCOVERED_RESOURCE_PATHS = 256;
const MAX_RUNTIME_RESOURCE_PATH_BYTES = 4_096;
const MAX_RUNTIME_CHILD_TOOLS = 64;
const MAX_RUNTIME_CHILD_PROMPT_BYTES = 256 * 1024;
const MAX_RUNTIME_CHILD_SYSTEM_PROMPT_BYTES = 256 * 1024;
const MAX_RUNTIME_CHILD_APPENDED_INSTRUCTIONS_BYTES = 64 * 1024;
const MAX_RUNTIME_CHILD_OUTPUT_BYTES = ABSOLUTE_CHILD_RUN_LIMITS.maxOutputLimitBytes;
const MAX_RUNTIME_AUTOCOMPLETE_PROVIDERS = 128;
const MAX_RUNTIME_EDITOR_MIDDLEWARE = 128;
const MAX_RUNTIME_EDITOR_RENDERERS = 16;
const MAX_RUNTIME_USER_SHELL_COMMAND_BYTES = 128 * 1024;
const MAX_RUNTIME_USER_SHELL_CWD_BYTES = 16 * 1024;
const MAX_RUNTIME_USER_SHELL_RESULT_BYTES = 1024 * 1024;
const MAX_RUNTIME_NATIVE_SESSION_PAGE = 2_000;
const MAX_RUNTIME_NATIVE_SESSION_BYTES = 16 * 1024 * 1024;
const MAX_RUNTIME_TREE_SUMMARY_BYTES = 64 * 1024;
const MAX_RUNTIME_TREE_METADATA_BYTES = 64 * 1024;
const MAX_RUNTIME_TREE_INSTRUCTIONS_BYTES = 16 * 1024;
const MAX_RUNTIME_TREE_LABEL_BYTES = 256;
export const DEFAULT_RUNTIME_EXTENSION_ACTIVATION_TIMEOUT_MS = 30_000;
export const DEFAULT_RUNTIME_EXTENSION_LOAD_TIMEOUT_MS = 30_000;
export const DEFAULT_RUNTIME_EXTENSION_SHUTDOWN_TIMEOUT_MS = 5_000;
export const DEFAULT_RUNTIME_RESOURCE_DISCOVERY_TIMEOUT_MS = 30_000;
const MAX_RUNTIME_HOST_IMPORT_ROOTS = 4_096;
let runtimeImportGeneration = 0;

export type RuntimeExtensionEvent =
  | "resources_discover"
  | "project_trust"
  | "session_start"
  | "session_info_changed"
  | "session_end"
  | "session_shutdown"
  | "session_before_switch"
  | "session_before_fork"
  | "session_before_tree"
  | "session_tree"
  | "session_before_compact"
  | "session_compact"
  | "before_agent_start"
  | "agent_start"
  | "agent_end"
  | "agent_settled"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "tool_call"
  | "tool_result"
  | "context"
  | "input"
  | "model_select"
  | "thinking_level_select"
  | "before_provider_request"
  | "after_provider_response"
  | "before_user_shell"
  | "user_shell"
  | "theme_change"
  | "event";
export type RuntimeUiNoticeKind = "status" | "warning" | "error";
export type RuntimeExtensionChange =
  | "tool"
  | "command"
  | "shortcut"
  | "flag"
  | "provider"
  | "provider_auth"
  | "autocomplete"
  | "editor_middleware"
  | "editor_renderer"
  | "session_renderer"
  | "tool_renderer";

export type RuntimeInputSource = "tui" | "rpc" | "extension";
export type RuntimeInputDelivery = "steer" | "follow_up";
export type RuntimeUserMessageDelivery = RuntimeInputDelivery | "next_turn";
export type RuntimeExtensionMode = "tui" | "rpc" | "json" | "print";

/** Immutable host-owned identity for one exact run and resolved session branch. */
export interface RuntimeRunScope {
  readonly threadId: string;
  readonly runId: string;
  readonly branch: string;
  readonly step?: number;
}

export interface RuntimeInputEvent {
  readonly threadId: string;
  readonly branch?: string;
  text: string;
  images?: ImageBlock[];
  source: RuntimeInputSource;
  delivery?: RuntimeInputDelivery;
}

export type RuntimeInputResult =
  | { action: "continue" }
  | { action: "handled" }
  | { action: "transform"; text: string; images?: ImageBlock[] };

export interface RuntimeBeforeAgentStartEvent extends RuntimeRunScope {
  prompt: string;
  images?: ImageBlock[];
  systemPrompt: string;
  /** Content-free provenance for the exact prompt composed by the host. */
  promptComposition?: PromptCompositionMetadata;
}

export interface RuntimeBeforeAgentStartResult {
  messages?: CanonicalMessage[];
  systemPrompt?: string;
}

export interface RuntimeContextEvent extends RuntimeRunScope {
  messages: CanonicalMessage[];
}

export interface RuntimeContextResult {
  messages?: CanonicalMessage[];
}

export type RuntimeFinalizedAssistantUsage = Omit<NormalizedUsage, "raw">;

export interface RuntimeFinalizedAssistantResponse {
  finishReason: FinishReason;
  usage?: RuntimeFinalizedAssistantUsage;
  rawReason?: string;
  explanation?: string;
}

export interface RuntimeFinalizedAssistantResponsePatch {
  finishReason?: FinishReason;
  usage?: RuntimeFinalizedAssistantUsage;
  rawReason?: string | null;
  explanation?: string | null;
}

export interface RuntimeMessageEvent extends RuntimeRunScope {
  message: CanonicalMessage;
  /** Present only for the provider-finalized assistant message of a model step. */
  finalized?: RuntimeFinalizedAssistantResponse;
}

export interface RuntimeAgentStartEvent extends RuntimeRunScope {
  provider: ProviderId;
  model: string;
}

export type RuntimeAgentOutcome =
  | { status: "completed"; finishReason: FinishReason }
  | { status: "cancelled"; reason: string }
  | { status: "failed"; error: AdapterError | { category: "internal"; message: string } };

export interface RuntimeAgentEndEvent extends RuntimeRunScope {
  outcome: RuntimeAgentOutcome;
  /** Bounded chronological suffix of canonical messages committed by this run. */
  messages: CanonicalMessage[];
  /** True when older run messages were omitted to keep the observer payload bounded. */
  messagesTruncated: boolean;
}

export interface RuntimeAgentSettledEvent extends RuntimeAgentEndEvent {}

export interface RuntimeTurnStartEvent extends RuntimeRunScope {
  provider: ProviderId;
  model: string;
  readonly step: number;
  messageCount: number;
  toolCount: number;
}

export interface RuntimeTurnEndEvent extends RuntimeRunScope {
  provider: ProviderId;
  model: string;
  readonly step: number;
  outcome:
    | { status: "completed"; finishReason: FinishReason; usage?: NormalizedUsage }
    | { status: "failed"; error: AdapterError };
  /** Final assistant message for a completed provider step, when one was committed. */
  message?: CanonicalMessage;
  /** Final model-visible tool results produced for this step. */
  toolResults: ToolResultBlock[];
}

export interface RuntimeAssistantStreamTextPart {
  part: number;
  text: string;
}

export interface RuntimeAssistantStreamReasoningPart extends RuntimeAssistantStreamTextPart {
  visibility: "summary" | "provider_trace";
}

export interface RuntimeAssistantStreamToolCall {
  index: number;
  id?: string;
  name?: string;
  rawArguments: string;
  arguments?: JsonValue;
  parseError?: string;
  complete: boolean;
}

/** Bounded, provider-neutral state accumulated for the active assistant stream. */
export interface RuntimeAssistantStreamSnapshot {
  role: "assistant";
  provider: ProviderId;
  model: string;
  text: RuntimeAssistantStreamTextPart[];
  reasoning: RuntimeAssistantStreamReasoningPart[];
  toolCalls: RuntimeAssistantStreamToolCall[];
}

export interface RuntimeMessageStartEvent extends RuntimeRunScope {
  readonly step: number;
  role: "assistant";
  provider: ProviderId;
  model: string;
  message: RuntimeAssistantStreamSnapshot;
}

export type RuntimeMessageUpdateEvent = RuntimeRunScope & { message: RuntimeAssistantStreamSnapshot } & (
  | {
      readonly step: number;
      kind: "text";
      part: number;
      delta: string;
    }
  | {
      readonly step: number;
      kind: "reasoning";
      part: number;
      delta: string;
      visibility: "summary" | "provider_trace";
    }
  | {
      readonly step: number;
      kind: "tool_call_start";
      index: number;
      id?: string;
      name?: string;
    }
  | {
      readonly step: number;
      kind: "tool_call_delta";
      index: number;
      jsonFragment: string;
    }
  | {
      readonly step: number;
      kind: "tool_call_end";
      index: number;
      name: string;
      rawArguments: string;
      id?: string;
      arguments?: JsonValue;
      parseError?: string;
    }
);

export interface RuntimeToolExecutionStartEvent extends RuntimeRunScope {
  invocation: ToolInvocation;
}

export type RuntimeToolExecutionUpdateEvent =
  | (RuntimeToolExecutionStartEvent & { phase: "running" })
  | (RuntimeToolExecutionStartEvent & {
      phase: "progress";
      sequence: number;
      progress: ToolUpdate;
    });

export interface RuntimeToolExecutionEndEvent extends RuntimeToolExecutionStartEvent {
  outcome:
    | { status: "completed" | "failed"; isError: boolean; preview: string; result?: ToolResultBlock }
    | { status: "in_doubt" | "interrupted"; reason: string };
}

export type RuntimeModelSelectSource = "set" | "cycle" | "restore" | "run";

export interface RuntimeModelSelectEvent {
  threadId: string;
  branch?: string;
  provider: ProviderId;
  model: string;
  previousModel?: RuntimeModelSelection;
  source: RuntimeModelSelectSource;
}

export interface RuntimeThinkingLevelSelectEvent {
  threadId: string;
  branch?: string;
  level: string;
  previousLevel: string;
  source: RuntimeModelSelectSource;
}

export type RuntimeProviderRequestFields = Pick<
  ProviderRequest,
  "messages" | "tools" | "maxOutputTokens" | "reasoningEffort" | "metadata"
>;

export interface RuntimeBeforeProviderRequestEvent extends RuntimeRunScope {
  readonly step: number;
  provider: ProviderId;
  model: string;
  request: RuntimeProviderRequestFields;
}

export interface RuntimeBeforeProviderRequestPatch {
  messages?: CanonicalMessage[];
  tools?: ToolDefinition[];
  maxOutputTokens?: number | null;
  reasoningEffort?: string | null;
  metadata?: Record<string, string> | null;
}

export interface RuntimeAfterProviderResponseEvent extends RuntimeRunScope {
  readonly step: number;
  provider: ProviderId;
  model: string;
  finishReason: FinishReason;
  /** One-based transport attempt within this model step. */
  attempt?: number;
  /** Present on observed failed attempts; true when the core will retry safely. */
  willRetry?: boolean;
  /** Bounded failure metadata. Raw provider response bodies are never exposed. */
  error?: ProviderResponseFailureMetadata;
  responseId?: string;
  requestId?: string;
  rawReason?: string;
  /** Bounded provider-authored finish explanation; arbitrary raw metadata is never exposed. */
  explanation?: string;
  usage?: NormalizedUsage;
  /** Redacted transport telemetry containing only an allowlisted header projection. */
  diagnostics?: ProviderResponseDiagnostics;
}

export interface RuntimeUserShellResult {
  text: string;
  exitCode: number | null;
  signal?: string;
}

export interface RuntimeBeforeUserShellEvent {
  command: string;
  cwd: string;
  hidden: boolean;
}

export type RuntimeBeforeUserShellResult =
  | { action: "continue" }
  | { action: "transform"; command?: string; cwd?: string }
  | { action: "handled"; result: RuntimeUserShellResult };

export type RuntimeBeforeUserShellReduction =
  | { action: "execute"; command: string; cwd: string }
  | { action: "handled"; command: string; cwd: string; result: RuntimeUserShellResult };

export interface RuntimeUserShellEvent {
  type: "user_shell";
  command: string;
  hidden: boolean;
  result: RuntimeUserShellResult;
}

export type RuntimeObservedEvent = EventEnvelope | RuntimeUserShellEvent;

export interface RuntimeMessageEndResult {
  message?: CanonicalMessage;
  /** Bounded final response fields; usage is a complete normalized replacement and cannot contain provider-raw data. */
  finalized?: RuntimeFinalizedAssistantResponsePatch;
}

export interface RuntimeMessageEndReduction {
  message: CanonicalMessage;
  finalized?: RuntimeFinalizedAssistantResponse & { usage?: NormalizedUsage };
  transformations?: AssistantResponseTransformationAudit[];
}

export interface RuntimeToolCallEvent extends ToolInvocation, RuntimeRunScope {}

export interface RuntimeToolCallResult {
  /** Replaces only the JSON input. Call identity is immutable and the selected tool revalidates this value. */
  input?: JsonValue;
  block?: boolean;
  reason?: string;
}

export interface RuntimeToolCallReduction {
  invocation: RuntimeToolCallEvent;
  blocked: boolean;
  reason?: string;
  transformations?: ToolInputTransformationAudit[];
}

export interface RuntimeToolResultEvent extends RuntimeRunScope {
  invocation: ToolInvocation;
  result: ToolResult;
}

export interface RuntimeToolResultPatch {
  content?: string;
  isError?: boolean;
  terminate?: boolean;
  metadata?: JsonValue;
  artifacts?: ToolArtifact[];
  images?: ImageBlock[];
}

export interface RuntimeUserMessageInput extends RuntimeExtensionSessionTarget {
  text: string;
  images?: ImageBlock[];
  /** Defaults to steer while active; idle user messages always start a turn. */
  delivery?: RuntimeInputDelivery;
}

export interface RuntimeUserMessageResult {
  threadId: string;
  branch: string;
  delivery: RuntimeInputDelivery;
  queued: boolean;
  /** True when an idle session started a new main-agent run. */
  started?: true;
  /** True when an input listener consumed the message without a run or queue entry. */
  handled?: true;
}

export interface RuntimeSessionCreateInput {
  name?: string;
  defaultBranch?: string;
  cwd?: string;
  /** Optional lineage without copying parent events. */
  parentThreadId?: string;
  signal?: AbortSignal;
}

export interface RuntimeSessionForkInput extends RuntimeExtensionSessionTarget {
  atEventId?: string | null;
  beforeEventId?: string;
  name?: string;
}

export interface RuntimeSessionNavigateInput extends RuntimeExtensionSessionTarget {
  targetBranch: string;
  targetEventId: string | null;
  newBranch: string;
  summarize?: boolean;
  provider?: ProviderId;
  model?: string;
  summaryTokenBudget?: number;
  summaryInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
}

export interface RuntimeSessionTreeRow {
  eventId: string;
  sourceBranch: string;
  kind: "user" | "assistant" | "tool" | "extension" | "compaction" | "branch_summary" | "warning" | "failed" | "cancelled";
  text: string;
  timestamp: string;
  depth: number;
  branches: string[];
  paths: string[];
  active: boolean;
  prefix: string;
  parentEventId?: string;
  restoreText?: string;
  rewindEventId?: string | null;
  label?: string;
  labelTimestamp?: string;
}

export interface RuntimeSessionSnapshot {
  threadId: string;
  branch: string;
  name?: string;
  branches: string[];
  active: boolean;
  operation?: "run" | "compaction" | null;
  phase?: "idle" | "preparing" | "streaming" | "tool_planning" | "executing" | "retrying" | "compacting";
  pendingMessageCount?: number;
  recoverableMessageCount?: number;
  contextUsage?: {
    tokens: number;
    contextWindow: number;
    percent: number;
    source: "provider_usage";
  };
  model?: RuntimeModelSelection;
  /** Content-free metadata for the latest exact system prompt composed on this branch. */
  promptComposition?: PromptCompositionMetadata;
}

export interface RuntimeSessionNavigateResult {
  cancelled: boolean;
  branch?: string;
  summaryEventId?: string;
}

export interface RuntimeCompactionInput extends RuntimeExtensionSessionTarget {
  provider?: ProviderId;
  model?: string;
  reasoningEffort?: string;
  instructions?: string;
  contextTokenBudget?: number;
  summaryTokenBudget?: number;
}

export interface RuntimeCompactionResult {
  threadId: string;
  branch: string;
  summary: string;
}

export interface RuntimeChildRunInput extends RuntimeExtensionSessionTarget {
  prompt: string;
  context: "fresh" | "fork";
  tools: string[];
  /** Replaces the child's ordinary host prompt for this child only. */
  systemPrompt?: string;
  /** Appends child-specific instructions while retaining host safety invariants. */
  appendSystemPrompt?: string;
  provider?: ProviderId;
  model?: string;
  reasoningEffort?: string;
  cwd?: string;
  maxSteps?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  outputLimitBytes?: number;
  session?: "ephemeral" | "persisted";
  execution?: RuntimeChildExecutionSelection;
  /** Called synchronously after the child session exists and before provider work begins. */
  onStart?(session: RuntimeChildSession): void;
  /** Receives ordered, safe child lifecycle events while the run remains active. */
  onEvent?(event: RuntimeChildEvent): void;
}

export type RuntimeChildExecutionSelection =
  | { backend: "inherit"; backendId?: string; requireAllTools?: boolean }
  | { backend: "local" };

export interface RuntimeChildExecutionResult {
  backend: "local" | "host";
  backendId?: string;
  required: boolean;
  routedTools: string[];
  localTools: string[];
}

export interface RuntimeChildUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  serverToolCalls?: number;
  cost?: string;
  durationMs?: number;
}

export interface RuntimeChildArtifactMetadata {
  id: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  retained: boolean;
}

export interface RuntimeChildSession {
  threadId: string;
  branch: string;
  model: RuntimeModelSelection;
  persisted: boolean;
}

export type RuntimeChildVisibleEvent = Extract<RuntimeEvent, { type:
  | "run_started"
  | "model_selected"
  | "run_state"
  | "assistant_started"
  | "provider_response_started"
  | "text_delta"
  | "reasoning_delta"
  | "tool_call_started"
  | "tool_call_delta"
  | "assistant_completed"
  | "tool_requested"
  | "tool_started"
  | "tool_progress"
  | "tool_completed"
  | "tool_in_doubt"
  | "usage"
  | "retry_scheduled"
  | "compaction_started"
  | "compaction_completed"
  | "steering_queued"
  | "run_completed"
  | "run_failed"
  | "run_cancelled"
  | "warning"
}>;

export interface RuntimeChildEvent {
  threadId: string;
  branch: string;
  runId?: string;
  sequence: number;
  timestamp: string;
  event: RuntimeChildVisibleEvent;
}

export interface RuntimeChildRunResult {
  status: "success" | "cancelled" | "error";
  summary: string;
  nextActions: string[];
  threadId: string;
  branch: string;
  model: RuntimeModelSelection;
  persisted: boolean;
  runId?: string;
  finishReason?: string;
  finalText: string;
  steps?: number;
  usage?: RuntimeChildUsage;
  artifacts: RuntimeChildArtifactMetadata[];
  artifactCount: number;
  artifactsTruncated: boolean;
  execution: RuntimeChildExecutionResult;
  truncated: boolean;
  error?: string;
}

export interface RuntimeShutdownRequestInput {
  reason?: string;
  signal?: AbortSignal;
}

export interface RuntimeShutdownRequestResult {
  requestId: string;
  acknowledged: true;
  accepted: boolean;
  message?: string;
}

export interface RuntimeModelSelection {
  provider: ProviderId;
  model: string;
  reasoningEffort?: string;
}

export interface RuntimeModelSelectionInput extends RuntimeExtensionSessionTarget {
  provider: ProviderId;
  model: string;
  reasoningEffort?: string;
}

export interface RuntimeThinkingSelectionInput extends RuntimeExtensionSessionTarget {
  reasoningEffort: string;
}

export interface RuntimeExecInput {
  command: string;
  args?: string[];
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
  outputLimitBytes?: number;
  signal?: AbortSignal;
}

export interface RuntimeExecResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

export type RuntimeSharedEventListener = (
  payload: JsonValue,
  context: RuntimeExtensionListenerContext,
) => void | Promise<void>;

export interface RuntimeResourcesDiscoverEvent {
  workspace: string;
  reason: "startup" | "reload";
}

export interface RuntimeResourcesDiscoverResult {
  skillPaths?: string[];
  promptPaths?: string[];
  themePaths?: string[];
}

export interface RuntimeProjectTrustEvent {
  /** Canonical workspace whose protected resources are awaiting a decision. */
  workspace: string;
  /** Canonical directory from which the host invocation started. */
  cwd: string;
}

export interface RuntimeProjectTrustResult {
  decision: "yes" | "no" | "undecided";
  /** Persist an exact-workspace decision. Valid only for yes or no. */
  remember?: boolean;
}

export interface RuntimeExtensionDataPaths {
  /** Durable data shared by this extension across workspaces. Never contains host credentials. */
  user: string;
  /** Durable data isolated to this extension and the current canonical workspace. */
  workspace: string;
}

export interface RuntimeDiscoveredResourcePath {
  path: string;
  extensionId: string;
  sourcePath: string;
  resourceRoot: string;
  scope: ExtensionScope;
  trusted: boolean;
}

export interface RuntimeDiscoveredResources {
  skillPaths: RuntimeDiscoveredResourcePath[];
  promptPaths: RuntimeDiscoveredResourcePath[];
  themePaths: RuntimeDiscoveredResourcePath[];
}

export interface RuntimeSessionBeforeSwitchEvent {
  reason: "new" | "resume";
  targetThreadId?: string;
}

export interface RuntimeSessionStartEvent {
  reason?: "startup" | "reload" | "reload_rollback" | "new" | "resume" | "fork" | undefined;
  threadId?: string | undefined;
  branch?: string | undefined;
  workspace?: string | undefined;
  previousThreadId?: string | undefined;
}

export interface RuntimeSessionInfoChangedEvent {
  threadId: string;
  branch: string;
  /** Current normalized display name. Absent when the name was cleared. */
  name?: string;
}

export interface RuntimeSessionEndEvent {
  reason?: "quit" | "reload" | "new" | "resume" | "fork" | "done" | "deleted" | "runtime_close" | "runtime_reload" | "create_failed" | (string & {}) | undefined;
  threadId?: string | undefined;
  branch?: string | undefined;
  workspace?: string | undefined;
  targetThreadId?: string | undefined;
}

export interface RuntimeSessionShutdownEvent {
  reason: "host_close";
  workspace: string;
}

export interface RuntimeSessionTreeEvent {
  threadId: string;
  previousEventId?: string;
  currentEventId?: string;
  summary?: CanonicalMessage;
  metadata?: JsonValue;
  fromExtension?: boolean;
}

export interface RuntimeSessionBeforeForkEvent {
  sourceThreadId: string;
  /** Host-selected identity for the prospective copied session. */
  targetThreadId?: string;
  sourceEventId?: string;
  targetBranch?: string;
  /** Whether sourceEventId is included in (`at`) or excluded from (`before`) the copied path. */
  position: "at" | "before";
}

export interface RuntimeTreePreparation {
  /** Selected destination event, or the root when null. */
  targetId: string | null;
  /** Current source-branch head before navigation. */
  oldLeafId: string | null;
  /** Deepest event shared by the source and selected target paths. */
  commonAncestorId: string | null;
  /** Bounded, redacted event projections used as branch-summary input. */
  entriesToSummarize: EventEnvelope[];
  userWantsSummary: boolean;
  customInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
}

export interface RuntimeSessionBeforeTreeEvent {
  threadId: string;
  preparation: RuntimeTreePreparation;
  signal: AbortSignal;
  /** @deprecated Use `preparation.targetId`. */
  targetEventId: string | null;
  /** @deprecated Use `preparation.userWantsSummary`. */
  summarize: boolean;
  /** @deprecated Read IDs from `preparation.entriesToSummarize`. */
  sourceEventIds: string[];
}

export interface RuntimeSessionGuardResult {
  cancel?: boolean;
  reason?: string;
}

export interface RuntimeTreeResult extends RuntimeSessionGuardResult {
  summary?: { text: string; metadata?: JsonValue };
  customInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
}

export interface RuntimeSessionBeforeCompactEvent extends RuntimeRunScope {
  plan: CompactionPlan;
  customInstructions?: string;
  signal: AbortSignal;
}

export interface RuntimeCompactionOverride {
  text: string;
  metadata?: JsonValue;
}

export interface RuntimeSessionBeforeCompactResult extends RuntimeSessionGuardResult {
  compaction?: RuntimeCompactionOverride;
}

export interface RuntimeBeforeAgentStartReduction {
  messages: CanonicalMessage[];
  systemPrompt: string;
}

export interface RuntimeSessionCompactEvent extends RuntimeRunScope {
  reason: CompactionReason;
  summary: CanonicalMessage;
  sourceMessageIds: string[];
  metadata?: JsonValue;
  fromExtension: boolean;
  willRetry: boolean;
}

export interface RuntimeThemeChangeEvent {
  previous: string;
  current: string;
  available: string[];
  reason: "selection" | "catalog" | "extension" | "terminal";
}

export interface RuntimeExtensionEventMap {
  resources_discover: RuntimeResourcesDiscoverEvent;
  project_trust: RuntimeProjectTrustEvent;
  session_start: RuntimeSessionStartEvent;
  session_info_changed: RuntimeSessionInfoChangedEvent;
  session_end: RuntimeSessionEndEvent;
  session_shutdown: RuntimeSessionShutdownEvent;
  session_before_switch: RuntimeSessionBeforeSwitchEvent;
  session_before_fork: RuntimeSessionBeforeForkEvent;
  session_before_tree: RuntimeSessionBeforeTreeEvent;
  session_tree: RuntimeSessionTreeEvent;
  session_before_compact: RuntimeSessionBeforeCompactEvent;
  session_compact: RuntimeSessionCompactEvent;
  before_agent_start: RuntimeBeforeAgentStartEvent;
  agent_start: RuntimeAgentStartEvent;
  agent_end: RuntimeAgentEndEvent;
  agent_settled: RuntimeAgentSettledEvent;
  turn_start: RuntimeTurnStartEvent;
  turn_end: RuntimeTurnEndEvent;
  message_start: RuntimeMessageStartEvent;
  message_update: RuntimeMessageUpdateEvent;
  message_end: RuntimeMessageEvent;
  tool_execution_start: RuntimeToolExecutionStartEvent;
  tool_execution_update: RuntimeToolExecutionUpdateEvent;
  tool_execution_end: RuntimeToolExecutionEndEvent;
  tool_call: RuntimeToolCallEvent;
  tool_result: RuntimeToolResultEvent;
  context: RuntimeContextEvent;
  input: RuntimeInputEvent;
  model_select: RuntimeModelSelectEvent;
  thinking_level_select: RuntimeThinkingLevelSelectEvent;
  before_provider_request: RuntimeBeforeProviderRequestEvent;
  after_provider_response: RuntimeAfterProviderResponseEvent;
  before_user_shell: RuntimeBeforeUserShellEvent;
  user_shell: RuntimeUserShellEvent;
  theme_change: RuntimeThemeChangeEvent;
  event: RuntimeObservedEvent;
}

export interface RuntimeExtensionEventResultMap {
  resources_discover: RuntimeResourcesDiscoverResult | void;
  project_trust: RuntimeProjectTrustResult | void;
  session_start: void;
  session_info_changed: void;
  session_end: void;
  session_shutdown: void;
  session_before_switch: RuntimeSessionGuardResult | void;
  session_before_fork: RuntimeSessionGuardResult | void;
  session_before_tree: RuntimeTreeResult | void;
  session_tree: void;
  session_before_compact: RuntimeSessionBeforeCompactResult | void;
  session_compact: void;
  before_agent_start: RuntimeBeforeAgentStartResult | void;
  agent_start: void;
  agent_end: void;
  agent_settled: void;
  turn_start: void;
  turn_end: void;
  message_start: void;
  message_update: void;
  message_end: RuntimeMessageEndResult | void;
  tool_execution_start: void;
  tool_execution_update: void;
  tool_execution_end: void;
  tool_call: RuntimeToolCallResult | void;
  tool_result: RuntimeToolResultPatch | void;
  context: RuntimeContextResult | void;
  input: RuntimeInputResult | void;
  model_select: void;
  thinking_level_select: void;
  before_provider_request: RuntimeBeforeProviderRequestPatch | void;
  after_provider_response: void;
  before_user_shell: RuntimeBeforeUserShellResult | void;
  user_shell: void;
  theme_change: void;
  event: void;
}

const RUNTIME_RUN_SCOPED_EVENTS: ReadonlySet<RuntimeExtensionEvent> = new Set([
  "session_before_compact",
  "session_compact",
  "before_agent_start",
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "tool_call",
  "tool_result",
  "context",
  "before_provider_request",
  "after_provider_response",
]);

const RUNTIME_REQUESTER_THREAD_EVENTS: ReadonlySet<RuntimeExtensionEvent> = new Set([
  ...RUNTIME_RUN_SCOPED_EVENTS,
  "session_start",
  "session_info_changed",
  "session_end",
  "session_before_tree",
  "session_tree",
  "model_select",
  "thinking_level_select",
  "input",
  "event",
]);

function freezeRuntimeRunEvent<T>(event: RuntimeExtensionEvent, value: T): T {
  return RUNTIME_RUN_SCOPED_EVENTS.has(event) ? Object.freeze(value) : value;
}

interface RuntimeRequesterSession {
  threadId: string;
  branch?: string;
  runId?: string;
  step?: number;
}

function runtimeRequesterSession(event: RuntimeExtensionEvent, value: unknown): RuntimeRequesterSession | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as {
    threadId?: unknown;
    sourceThreadId?: unknown;
    targetThreadId?: unknown;
    branch?: unknown;
    targetBranch?: unknown;
    runId?: unknown;
    step?: unknown;
  };
  const threadId = event === "session_before_fork"
    ? record.targetThreadId ?? record.sourceThreadId
    : RUNTIME_REQUESTER_THREAD_EVENTS.has(event) ? record.threadId : undefined;
  if (typeof threadId !== "string") return undefined;
  const branch = event === "session_before_fork" ? record.targetBranch : record.branch;
  return {
    threadId,
    ...(typeof branch === "string" ? { branch } : {}),
    ...(typeof record.runId === "string" ? { runId: record.runId } : {}),
    ...(Number.isSafeInteger(record.step) && (record.step as number) > 0 ? { step: record.step as number } : {}),
  };
}

export interface RuntimeExtensionListenerContext {
  readonly extensionId: string;
  readonly sourcePath: string;
  readonly workspace: string;
  readonly signal: AbortSignal;
  /** Active host mode for this callback. */
  readonly mode: RuntimeExtensionMode;
  /** True when dialog-capable host UI is available for this callback. */
  readonly hasUI: boolean;
  /** Reads the current workspace trust decision without capturing stale state. */
  readonly isProjectTrusted: () => boolean;
  /** Interactive in TUI/RPC hosts; presentation-only methods remain usable headlessly. */
  readonly ui: RuntimeCommandUi;
  /** Callback-bound session actions when the event has a host-owned session identity. */
  readonly session?: RuntimeListenerSessionContext;
}

export interface RuntimeListenerSessionContext {
  readonly threadId: string;
  readonly branch?: string;
  readonly runId?: string;
  readonly step?: number;
  get(): Promise<RuntimeSessionSnapshot>;
  getModel(): Promise<RuntimeModelSelection | undefined>;
  getUsage(): Promise<RuntimeSessionUsageSnapshot>;
  getSystemPrompt(): Promise<RuntimeSystemPromptSnapshot | undefined>;
  isIdle(): Promise<boolean>;
  hasPendingMessages(): Promise<boolean>;
  abort(reason?: string): Promise<boolean>;
  compact(input?: {
    provider?: ProviderId;
    model?: string;
    reasoningEffort?: string;
    instructions?: string;
    contextTokenBudget?: number;
    summaryTokenBudget?: number;
  }): Promise<RuntimeCompactionResult>;
}

export interface RuntimeProjectTrustUi {
  readonly hasUI: boolean;
  confirm(title: string, message: string, signal?: AbortSignal): Promise<boolean>;
}

export interface RuntimeProjectTrustListenerContext {
  readonly extensionId: string;
  readonly sourcePath: string;
  readonly workspace: string;
  readonly signal: AbortSignal;
  /** Deliberately limited: trust listeners cannot mutate the editor or terminal layout. */
  readonly ui: RuntimeProjectTrustUi;
}

export type RuntimeExtensionListenerContextFor<K extends RuntimeExtensionEvent> =
  K extends "project_trust" ? RuntimeProjectTrustListenerContext : RuntimeExtensionListenerContext;

export type RuntimeExtensionListener<K extends RuntimeExtensionEvent> = (
  value: RuntimeExtensionEventMap[K],
  context: RuntimeExtensionListenerContextFor<K>,
) => RuntimeExtensionEventResultMap[K] | Promise<RuntimeExtensionEventResultMap[K]>;

export interface RuntimeProviderAuthDescription {
  extensionId: string;
  sourcePath: string;
  descriptor: ProviderAuthDescriptor;
}

export interface RuntimeToolRegistration {
  name: string;
  description: string;
  inputSchema: Record<string, JsonValue>;
  /** Provider-neutral hint to load this executable definition on demand when supported. */
  loading?: ToolDefinition["loading"];
  /** Concise one-line entry shown in the active-tool section of the system prompt. */
  promptSnippet?: string;
  /** Usage guidance included only while this tool is selected for a run. */
  promptGuidelines?: string[];
  /** Normalizes compatibility input before both schema and custom validation. */
  prepareInput?: ToolInputPreparer;
  /** Sequential tools run alone as source-order barriers within a batch. */
  executionMode?: ToolExecutionMode;
  validate?(input: JsonValue): void;
  resources?(input: JsonValue, context: ToolContext): ResourceClaim[] | Promise<ResourceClaim[]>;
  execute(input: JsonValue, context: RuntimeToolContext): ToolResult | Promise<ToolResult>;
}

export interface RuntimeToolContext extends ToolContext {
  readonly extensionId: string;
  readonly sourcePath: string;
  readonly hasUI: boolean;
  readonly mode: RuntimeExtensionMode;
  readonly isProjectTrusted: () => boolean;
  readonly ui: RuntimeCommandUi;
}

export interface RuntimeRendererDescription {
  extensionId: string;
  sourcePath: string;
  kind: "tool" | "session" | "editor";
  key: string;
}

export interface RuntimeExtensionSessionTarget {
  threadId: string;
  branch?: string;
  signal?: AbortSignal;
}

export interface RuntimeExtensionStateAppendInput extends RuntimeExtensionSessionTarget {
  schemaVersion: number;
  key: string;
  value: JsonValue;
}

export interface RuntimeExtensionStateCompareAndAppendInput extends RuntimeExtensionStateAppendInput {
  /** The last state event ID read by the caller, or null when the key must not exist. */
  expectedEventId: string | null;
}

export interface RuntimeExtensionStateReadInput extends RuntimeExtensionSessionTarget {
  schemaVersion: number;
  key: string;
}

export interface RuntimeExtensionMessagesReadInput extends RuntimeExtensionSessionTarget {
  schemaVersion: number;
  kind?: string;
  limit?: number;
  /** Opaque exclusive cursor: return messages older than this previously returned event ID. */
  beforeEventId?: string;
}

export interface RuntimeTranscriptInput extends RuntimeExtensionSessionTarget {
  /** Exclusive durable event-sequence cursor returned by the previous page. */
  afterSequence?: number;
  limit?: number;
}

export interface RuntimeSessionListInput {
  search?: string;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}

export type RuntimeSessionPage = HarnessSessionPage;

export interface RuntimeExtensionMessageAppendInput extends RuntimeExtensionSessionTarget {
  schemaVersion: number;
  kind: string;
  payload: JsonValue;
  modelContext: ExtensionMessageModelContext;
  transcript: ExtensionMessageTranscript;
  /** Start an idle turn; active user-context messages are delivered automatically. */
  triggerTurn?: boolean;
  /** Queue during an active run, or defer model context until the next user-initiated turn. */
  delivery?: RuntimeUserMessageDelivery;
}

export interface RuntimeActiveToolsSetInput extends RuntimeExtensionSessionTarget {
  names: string[];
}

export interface RuntimeSessionNameInput extends RuntimeExtensionSessionTarget {
  /** Omit to clear the saved display name. */
  name?: string;
}

export interface RuntimeSessionNameRecord {
  threadId: string;
  branch: string;
  name?: string;
}

export interface RuntimeEntryLabelInput extends RuntimeExtensionSessionTarget {
  targetEventId: string;
  /** Omit to clear the saved entry label. */
  label?: string;
}

export interface RuntimeEntryLabelRecord {
  threadId: string;
  branch: string;
  targetEventId: string;
  eventId: string;
  timestamp: string;
  label?: string;
}

export type RuntimeCatalogOwner =
  | { kind: "builtin" }
  | { kind: "extension"; extensionId: string; sourcePath: string }
  | { kind: "host" };

export interface RuntimeToolCatalogEntry {
  name: string;
  description: string;
  inputSchema: Record<string, JsonValue>;
  active: boolean;
  executionMode: ToolExecutionMode;
  owner: RuntimeCatalogOwner;
  loading?: ToolDefinition["loading"];
  promptSnippet?: string;
  promptGuidelines?: string[];
}

export interface RuntimeExtensionStateRecord extends ExtensionStateEvent {
  threadId: string;
  branch: string;
  eventId: string;
  timestamp: string;
}

export type RuntimeExtensionStateCompareAndAppendResult =
  | { status: "committed"; record: RuntimeExtensionStateRecord }
  | {
      status: "conflict";
      threadId: string;
      branch: string;
      expectedEventId: string | null;
      current?: RuntimeExtensionStateRecord;
    };

export interface RuntimeExtensionMessageRecord extends ExtensionMessageEvent {
  threadId: string;
  branch: string;
  eventId: string;
  timestamp: string;
}

export interface RuntimeSessionUsageSnapshot {
  threadId: string;
  branch: string;
  runCount: number;
  responseCount: number;
  usageEventCount: number;
  usage: RuntimeChildUsage;
  cache: {
    status: "unavailable" | "cold" | "effective" | "mixed" | "low_reuse" | "write_churn";
    samples: number;
    observedInputTokens: number;
    uncachedInputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reuseRatio?: number;
  };
}

export interface RuntimeSystemPromptSnapshot {
  threadId: string;
  branch: string;
  /** Secret-pattern-redacted text from the latest durably recorded host prompt. */
  text: string;
  bytes: number;
  sha256: string;
  redacted: boolean;
  model?: RuntimeModelSelection;
  composition?: PromptCompositionMetadata;
}

/**
 * Unredacted prompt state available only to a trusted extension that declares
 * `permissions.sessionRaw`. It is process-local and is never written back to
 * durable history by this API.
 */
export interface RuntimeNativeSystemPromptSnapshot extends RuntimeRunScope {
  prompt: string;
  systemPrompt: string;
  images?: ImageBlock[];
  composition?: PromptCompositionMetadata;
}

export interface RuntimeNativeSessionReadInput extends RuntimeExtensionSessionTarget {
  /** Exclusive sequence cursor. Defaults to zero. */
  afterSequence?: number;
  /** Pins subsequent pages to the same branch-head snapshot. */
  throughSequence?: number;
  /** Defaults to 256 and is capped by the host. */
  limit?: number;
  /** Build the exact compacted canonical context for the selected model. */
  includeContext?: boolean;
  provider?: ProviderId;
  model?: string;
}

export interface RuntimeNativeSessionPage {
  thread: ThreadRecord;
  branch: string;
  events: EventEnvelope[];
  runs: RunRecord[];
  nextSequence: number;
  snapshotSequence: number;
  hasMore: boolean;
  model?: RuntimeModelSelection;
  context?: CanonicalMessage[];
}

export interface RuntimeNativeCredentialSnapshot {
  provider: string;
  source: string;
  credential:
    | { kind: "api_key"; apiKey: string; accountId?: string }
    | { kind: "bearer"; accessToken: string; expiresAt?: number; accountId?: string; subject?: string }
    | {
        kind: "oauth";
        accessToken: string;
        expiresAt: number;
        tokenType: string;
        scopes: string[];
        accountId?: string;
        subject?: string;
        providerData?: Record<string, string>;
      }
    | { kind: "ambient"; mechanism: string; hints: Readonly<Record<string, string | boolean>> };
  /** Request headers derived from the active provider authentication policy. */
  headers: Record<string, string>;
}

export interface RuntimeHostConfigurationSnapshot {
  workspace: string;
  projectTrusted: boolean;
  globalConfigPath: string;
  projectConfigPath: string;
  databasePath: string;
  effective: JsonObject;
}

export interface RuntimeHostConfigurationUpdateInput {
  scope: "user" | "project";
  patch: JsonObject;
  signal?: AbortSignal;
}

export interface RuntimeNativeHostHandler {
  resolveCredential(provider: string, signal?: AbortSignal): Promise<RuntimeNativeCredentialSnapshot | undefined>;
  getConfiguration(signal?: AbortSignal): Promise<RuntimeHostConfigurationSnapshot>;
  updateConfiguration(input: RuntimeHostConfigurationUpdateInput): Promise<RuntimeHostConfigurationSnapshot>;
}

export type RuntimeDiscoverableResource =
  | {
      kind: "command";
      source: "builtin" | "runtime_extension" | "extension_template";
      name: string;
      extensionId?: string;
      description?: string;
      argumentHint?: string;
      syntax?: string;
    }
  | {
      kind: "prompt";
      name: string;
      extensionId: string;
      description?: string;
      argumentHint?: string;
    }
  | {
      kind: "skill";
      name: string;
      description: string;
      scope: "user" | "workspace";
      trusted: boolean;
      disableModelInvocation: boolean;
    };

export interface RuntimeDiscoveryView {
  resources: RuntimeDiscoverableResource[];
  truncated: boolean;
  omitted: {
    commands: number;
    prompts: number;
    skills: number;
  };
}

export interface RuntimeExtensionSessionRenderer {
  renderState?(
    entry: Readonly<RuntimeExtensionStateRecord>,
    context: RuntimeUiRenderContext,
  ): RuntimeUiBlock | undefined;
  renderMessage?(
    entry: Readonly<RuntimeExtensionMessageRecord>,
    context: RuntimeUiRenderContext,
  ): RuntimeUiBlock | undefined;
}

export interface RuntimeExtensionSessionHandler {
  getResourceCatalog(input: { signal?: AbortSignal }): Promise<HarnessResourceCatalog>;
  listSessions(input: RuntimeSessionListInput): Promise<RuntimeSessionPage>;
  getTranscript(input: RuntimeTranscriptInput): Promise<HarnessTranscriptPage>;
  appendState(input: RuntimeExtensionSessionTarget & { event: ExtensionStateEvent }): Promise<RuntimeExtensionStateRecord>;
  compareAndAppendState(input: RuntimeExtensionSessionTarget & {
    event: ExtensionStateEvent;
    expectedEventId: string | null;
  }): Promise<RuntimeExtensionStateCompareAndAppendResult>;
  readState(input: RuntimeExtensionSessionTarget & {
    extensionId: string;
    schemaVersion: number;
    key: string;
  }): Promise<RuntimeExtensionStateRecord | undefined>;
  appendMessage(input: RuntimeExtensionSessionTarget & {
    event: ExtensionMessageEvent;
    triggerTurn?: boolean;
    delivery?: RuntimeUserMessageDelivery;
  }): Promise<RuntimeExtensionMessageRecord>;
  readMessages(input: RuntimeExtensionSessionTarget & {
    extensionId: string;
    schemaVersion: number;
    kind?: string;
    limit: number;
    beforeEventId?: string;
  }): Promise<RuntimeExtensionMessageRecord[]>;
  getUsage(input: RuntimeExtensionSessionTarget): Promise<RuntimeSessionUsageSnapshot>;
  getSystemPrompt(input: RuntimeExtensionSessionTarget): Promise<RuntimeSystemPromptSnapshot | undefined>;
  readNativeSession(input: RuntimeNativeSessionReadInput & { limit: number }): Promise<RuntimeNativeSessionPage>;
  getActiveTools(input: RuntimeExtensionSessionTarget & {
    requesterExtensionId: string;
    requesterSourcePath: string;
  }): Promise<string[]>;
  getAllTools(input: RuntimeExtensionSessionTarget & {
    requesterExtensionId: string;
    requesterSourcePath: string;
  }): Promise<RuntimeToolCatalogEntry[]>;
  setActiveTools(input: RuntimeExtensionSessionTarget & {
    requesterExtensionId: string;
    requesterSourcePath: string;
    names: string[];
  }): Promise<string[]>;
  setSessionName(input: RuntimeSessionNameInput): Promise<RuntimeSessionNameRecord>;
  setEntryLabel(input: RuntimeEntryLabelInput): Promise<RuntimeEntryLabelRecord>;
  sendUserMessage(input: RuntimeUserMessageInput & {
    requesterExtensionId: string;
    requesterSourcePath: string;
  }): Promise<RuntimeUserMessageResult>;
  cancel(input: RuntimeExtensionSessionTarget & { reason?: string }): Promise<boolean>;
  compact(input: RuntimeCompactionInput): Promise<RuntimeCompactionResult>;
  runChild(input: RuntimeChildRunInput & { requesterThreadId?: string }): Promise<RuntimeChildRunResult>;
  createSession(input: RuntimeSessionCreateInput): Promise<RuntimeSessionSnapshot>;
  forkSession(input: RuntimeSessionForkInput): Promise<RuntimeSessionSnapshot>;
  inspectSession(input: RuntimeExtensionSessionTarget): Promise<RuntimeSessionSnapshot>;
  waitForIdle(input: RuntimeExtensionSessionTarget): Promise<void>;
  sessionTree(input: RuntimeExtensionSessionTarget): Promise<RuntimeSessionTreeRow[]>;
  navigateSession(input: RuntimeSessionNavigateInput): Promise<RuntimeSessionNavigateResult>;
  getModel(input: RuntimeExtensionSessionTarget): Promise<RuntimeModelSelection | undefined>;
  setModel(input: RuntimeModelSelectionInput): Promise<RuntimeModelSelection>;
  setThinking(input: RuntimeThinkingSelectionInput): Promise<RuntimeModelSelection>;
  exec(input: RuntimeExecInput): Promise<RuntimeExecResult>;
}

export type RuntimeExtensionReloadHandler = (input: {
  session?: { threadId: string; branch?: string };
  signal?: AbortSignal;
}) => Promise<{ warnings: string[] }>;

export type RuntimeExtensionShutdownHandler = (input: {
  requestId: string;
  extensionId: string;
  reason?: string;
  signal: AbortSignal;
}) => Promise<{ accepted: boolean; message?: string }>;

export type RuntimeExtensionSessionFocusHandler = (
  session: RuntimeSessionSnapshot,
  signal: AbortSignal,
) => void | Promise<void>;

export type RuntimeExtensionModelFocusHandler = (
  target: RuntimeExtensionSessionTarget,
  selection: RuntimeModelSelection,
  signal: AbortSignal,
) => void | Promise<void>;

export type RuntimeInteractiveUiHandler = (
  extensionId: string,
  signal: AbortSignal,
) => RuntimeCommandUi;

export interface RuntimeCommandUi {
  notify(message: string, kind?: RuntimeUiNoticeKind): void;
  setStatus(key: string, value?: string): void;
  setWidget(key: string, value?: string): void;
  setHeader(key: string, value?: string): void;
  setFooter(key: string, value?: string): void;
  setWorkingMessage(value?: string): void;
  setWorkingVisible(visible?: boolean): void;
  setTitle(value: string): void;
  getTheme(signal?: AbortSignal): Promise<RuntimeUiThemeSnapshot>;
  setTheme(name: string, signal?: AbortSignal): Promise<RuntimeUiThemeSnapshot>;
  select<T>(prompt: string, options: readonly { label: string; value: T; detail?: string }[], signal?: AbortSignal): Promise<T>;
  confirm(title: string, message: string, signal?: AbortSignal): Promise<boolean>;
  input(title: string, placeholder?: string, signal?: AbortSignal): Promise<string | undefined>;
  editor(title: string, prefill?: string, signal?: AbortSignal): Promise<string | undefined>;
  setEditorText(value: string): void;
  getEditorText(): string;
  custom<T>(factory: RuntimeUiComponentFactory<T>, options?: RuntimeUiCustomOptions, signal?: AbortSignal): Promise<T | undefined>;
  showOverlay<T>(
    factory: RuntimeUiComponentFactory<T>,
    options?: Omit<RuntimeUiCustomOptions, "overlay">,
    signal?: AbortSignal,
  ): RuntimeUiOverlayHandle<T>;
}

export type RuntimeAdvancedUiSlot =
  | "header"
  | "footer"
  | "widget"
  | "widget-above"
  | "widget-below"
  | "header-replacement"
  | "footer-replacement";

export interface RuntimeAdvancedUiWorkingIndicator {
  readonly frames: readonly string[];
  readonly intervalMs: number;
}

export type RuntimeAdvancedUiKeyObserver = (event: Readonly<RuntimeUiKeyEvent>) => void;

export interface RuntimeAdvancedUiApi {
  /** Installs a bounded structural component in a persistent TUI slot. */
  setComponent(
    slot: RuntimeAdvancedUiSlot,
    key: string,
    factory?: RuntimeUiComponentFactory<void>,
  ): void;
  /** Replaces the activity animation for this generation, or clears it when omitted. */
  setWorkingIndicator(value?: RuntimeAdvancedUiWorkingIndicator): void;
  /** Replaces the visible label for summarized reasoning, or clears it when omitted. */
  setHiddenReasoningLabel(value?: string): void;
  /** Reads the current global tool-output expansion state from an interactive TUI. */
  getToolOutputExpanded(): boolean;
  /** Sets the global tool-output expansion state for this generation, or restores the prior state when omitted. */
  setToolOutputExpanded(expanded?: boolean): void;
  /** Observes sanitized decoded keys without consuming input; the returned disposer is idempotent. */
  observeKeys(observer: RuntimeAdvancedUiKeyObserver): () => void;
}

export interface RuntimeCommandContext {
  args: string;
  workspace: string;
  threadId: string;
  branch?: string;
  signal: AbortSignal;
  mode: RuntimeExtensionMode;
  hasUI: boolean;
  isProjectTrusted: () => boolean;
  ui: RuntimeCommandUi;
}

export type RuntimeCommandResult = void | string | { prompt?: string };

export interface RuntimeCommandRegistration {
  name: string;
  description?: string;
  argumentHint?: string;
  getArgumentCompletions?(
    argumentPrefix: string,
    signal?: AbortSignal,
  ): readonly RuntimeCommandCompletion[] | null | Promise<readonly RuntimeCommandCompletion[] | null>;
  execute(context: RuntimeCommandContext): RuntimeCommandResult | Promise<RuntimeCommandResult>;
}

export interface RuntimeCommandCompletion {
  value: string;
  label?: string;
  detail?: string;
}

export interface RuntimeAutocompleteContext {
  text: string;
  /** Grapheme-indexed cursor in text. */
  cursor: number;
}

export interface RuntimeAutocompleteCompletion {
  /** Grapheme-indexed replacement range in the unchanged input snapshot. */
  start: number;
  end: number;
  value: string;
  label?: string;
  detail?: string;
}

export type RuntimeAutocompleteProvider = (
  context: Readonly<RuntimeAutocompleteContext>,
  signal: AbortSignal,
) => readonly RuntimeAutocompleteCompletion[] | null | Promise<readonly RuntimeAutocompleteCompletion[] | null>;

export interface RuntimeEditorMiddlewareEvent {
  key: string;
  text?: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export interface RuntimeEditorSnapshot {
  text: string;
  /** Grapheme-indexed cursor in text. */
  cursor: number;
}

export type RuntimeEditorMiddlewareResult =
  | { action: "pass" }
  | { action: "handled" }
  | { action: "replace"; text: string; cursor?: number };

export type RuntimeEditorMiddleware = (
  event: Readonly<RuntimeEditorMiddlewareEvent>,
  snapshot: Readonly<RuntimeEditorSnapshot>,
  signal: AbortSignal,
) => RuntimeEditorMiddlewareResult | void;

export interface RuntimeUiThemeSnapshot {
  name: string;
  available: string[];
}

export interface RuntimeInitialUiOperation {
  extensionId: string;
  type: "status" | "widget" | "header" | "footer" | "title" | "notify" | "working_message" | "working_visible";
  key?: string;
  value: string;
  kind?: RuntimeUiNoticeKind;
  visible?: boolean;
}

export type RuntimeAdvancedUiOperation =
  | {
      extensionId: string;
      signal: AbortSignal;
      type: "component";
      slot: RuntimeAdvancedUiSlot;
      key: string;
      factory?: RuntimeUiComponentFactory<void>;
    }
  | {
      extensionId: string;
      signal: AbortSignal;
      type: "working_indicator";
      value?: RuntimeAdvancedUiWorkingIndicator;
    }
  | {
      extensionId: string;
      signal: AbortSignal;
      type: "hidden_reasoning_label";
      value?: string;
    }
  | {
      extensionId: string;
      signal: AbortSignal;
      type: "tool_output_expanded";
      expanded?: boolean;
    }
  | {
      extensionId: string;
      signal: AbortSignal;
      type: "key_observer";
      key: string;
      observer?: RuntimeAdvancedUiKeyObserver;
    };

export interface RuntimeAdvancedUiHostHandler {
  apply(operation: RuntimeAdvancedUiOperation): void;
  getToolOutputExpanded(): boolean;
}

export interface RuntimeCommandDescription {
  extensionId: string;
  sourcePath: string;
  scope: ExtensionScope;
  trusted: boolean;
  /** Name accepted by the command dispatcher. Duplicate base names receive :N suffixes. */
  name: string;
  /** Name originally registered by the extension. */
  baseName: string;
  description?: string;
  argumentHint?: string;
}

export type RuntimeShortcutContext = Omit<RuntimeCommandContext, "args">;

export interface RuntimeShortcutRegistration {
  shortcut: string;
  description?: string;
  execute(context: RuntimeShortcutContext): void | Promise<void>;
}

export interface RuntimeShortcutDescription {
  extensionId: string;
  sourcePath: string;
  shortcut: string;
  description?: string;
}

export type RuntimeFlagType = "boolean" | "string";

export interface RuntimeFlagRegistration {
  name: string;
  description?: string;
  type: RuntimeFlagType;
  default?: boolean | string;
}

export interface RuntimeFlagDescription {
  extensionId: string;
  sourcePath: string;
  name: string;
  description?: string;
  type: RuntimeFlagType;
  default?: boolean | string;
}

export interface RuntimeExtensionDiagnostic {
  extensionId: string;
  sourcePath: string;
  message: string;
}

export interface RuntimeLiveRegistrationHandler {
  registerTool(tool: HarnessTool): void | (() => void | Promise<void>);
  registerProvider(provider: ProviderAdapter): void | (() => void | Promise<void>);
  overrideProvider?(provider: ProviderAdapter): void | (() => void | Promise<void>);
  overlayProvider?(overlay: RuntimeProviderOverlay): void | (() => void | Promise<void>);
  registerProviderWire?(provider: ProviderId, interceptor: ProviderWireInterceptor): void | (() => void | Promise<void>);
  unregisterProvider?(provider: ProviderAdapter): void | Promise<void>;
  registerProviderAuth(auth: RuntimeProviderAuthDescription): void | (() => void | Promise<void>);
  fetchProvider(
    provider: string,
    input: string | URL | Request,
    init?: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response>;
}

export interface RuntimeProviderOverlay {
  readonly id: ProviderId;
  /** Presentation-only label; authentication methods and credential ownership remain unchanged. */
  displayName?: string;
  /** Secure origin/path prefix prepended to the provider's original request path. */
  baseUrl?: string;
  /** Static request-header additions or removals. */
  headers?: Readonly<Record<string, string | null>>;
  /** Static model catalog replacement. Mutually exclusive with listModels. */
  models?: readonly ModelInfo[];
  /** Dynamic model catalog replacement. Mutually exclusive with models. */
  listModels?: ProviderAdapter["listModels"];
  /** Protocol/transport implementation replacement while preserving the active catalog. */
  stream?: ProviderAdapter["stream"];
}

export interface RuntimeNativeExtensionApi {
  /** Complete editor/input/component ownership for trusted interactive extensions. */
  readonly ui: NativeUiHost;
  /** Unrestricted terminal bytes and raw input for explicitly reviewed local packages. */
  readonly terminal: UnsafeTerminalHost;
  readonly session: {
    read(input: RuntimeNativeSessionReadInput): Promise<RuntimeNativeSessionPage>;
    /** Returns the live unredacted prompt for the current callback or selected session. */
    getSystemPrompt(target?: RuntimeExtensionSessionTarget): Promise<RuntimeNativeSystemPromptSnapshot | undefined>;
  };
  readonly credentials: {
    resolve(provider: string, signal?: AbortSignal): Promise<RuntimeNativeCredentialSnapshot | undefined>;
  };
  readonly providers: {
    /** Temporarily replaces an existing provider ID and restores it on disposal. */
    override(provider: ProviderAdapter): () => Promise<void>;
    /** Replaces selected provider metadata or behavior while retaining every unspecified field. */
    overlay(overlay: RuntimeProviderOverlay): () => Promise<void>;
    /** Intercepts provider-specific HTTP JSON payloads and response metadata. */
    intercept(provider: ProviderId, interceptor: ProviderWireInterceptor): () => Promise<void>;
  };
  readonly host: {
    getConfiguration(signal?: AbortSignal): Promise<RuntimeHostConfigurationSnapshot>;
    updateConfiguration(input: RuntimeHostConfigurationUpdateInput): Promise<RuntimeHostConfigurationSnapshot>;
  };
}

export interface RuntimeExtensionApi {
  readonly extensionId: string;
  readonly workspace: string;
  readonly dataPaths: RuntimeExtensionDataPaths;
  /** Aborts when activation fails, reload replaces this generation, or the host closes. */
  readonly signal: AbortSignal;
  registerTool(tool: RuntimeToolRegistration): void;
  registerCommand(command: RuntimeCommandRegistration): void;
  registerShortcut(shortcut: RuntimeShortcutRegistration): void;
  registerFlag(flag: RuntimeFlagRegistration): void;
  getFlag(name: string): boolean | string | undefined;
  /** Registers a provider and returns an ownership-checked, idempotent disposer. */
  registerProvider(provider: ProviderAdapter): () => Promise<void>;
  registerProviderAuth(descriptor: ProviderAuthDescriptor): void;
  registerToolRenderer(name: string, renderer: RuntimeToolRenderer): void;
  registerEditorRenderer(renderer: RuntimeEditorRenderer): void;
  getActiveTools(target: RuntimeExtensionSessionTarget): Promise<string[]>;
  getAllTools(target: RuntimeExtensionSessionTarget): Promise<RuntimeToolCatalogEntry[]>;
  /** Runtime extension commands only; prompt, skill, and built-in commands remain host resources. */
  getCommands(): RuntimeCommandDescription[];
  /** Callback-free, bounded metadata from the same catalog used by embedding and RPC. */
  getResourceCatalog(signal?: AbortSignal): Promise<HarnessResourceCatalog>;
  /** One bounded command, prompt, and skill discovery view. */
  getDiscoveryView(signal?: AbortSignal): Promise<RuntimeDiscoveryView>;
  /** Bounded metadata for sessions belonging to the current workspace. */
  listSessions(input?: RuntimeSessionListInput): Promise<RuntimeSessionPage>;
  /** Bounded transcript-visible replay for one explicitly selected session branch. */
  getTranscript(input: RuntimeTranscriptInput): Promise<HarnessTranscriptPage>;
  /** Durable aggregate reconstructed from usage events on the selected branch. */
  getSessionUsage(input: RuntimeExtensionSessionTarget): Promise<RuntimeSessionUsageSnapshot>;
  /** Redacted latest host prompt snapshot for the selected branch, when one exists. */
  getSystemPromptSnapshot(input: RuntimeExtensionSessionTarget): Promise<RuntimeSystemPromptSnapshot | undefined>;
  setActiveTools(input: RuntimeActiveToolsSetInput): Promise<string[]>;
  setSessionName(input: RuntimeSessionNameInput): Promise<RuntimeSessionNameRecord>;
  setEntryLabel(input: RuntimeEntryLabelInput): Promise<RuntimeEntryLabelRecord>;
  sendUserMessage(input: RuntimeUserMessageInput): Promise<RuntimeUserMessageResult>;
  sendMessage(input: RuntimeExtensionMessageAppendInput): Promise<RuntimeExtensionMessageRecord>;
  abort(input: RuntimeExtensionSessionTarget & { reason?: string }): Promise<boolean>;
  compact(input: RuntimeCompactionInput): Promise<RuntimeCompactionResult>;
  runChild(input: RuntimeChildRunInput): Promise<RuntimeChildRunResult>;
  reload(input?: RuntimeExtensionSessionTarget): Promise<{ warnings: string[] }>;
  requestShutdown(input?: RuntimeShutdownRequestInput): Promise<RuntimeShutdownRequestResult>;
  newSession(input?: RuntimeSessionCreateInput): Promise<RuntimeSessionSnapshot>;
  forkSession(input: RuntimeSessionForkInput): Promise<RuntimeSessionSnapshot>;
  switchSession(input: RuntimeExtensionSessionTarget): Promise<RuntimeSessionSnapshot>;
  getSession(input: RuntimeExtensionSessionTarget): Promise<RuntimeSessionSnapshot>;
  waitForIdle(input: RuntimeExtensionSessionTarget): Promise<void>;
  getSessionTree(input: RuntimeExtensionSessionTarget): Promise<RuntimeSessionTreeRow[]>;
  navigateSessionTree(input: RuntimeSessionNavigateInput): Promise<RuntimeSessionNavigateResult>;
  getModel(input: RuntimeExtensionSessionTarget): Promise<RuntimeModelSelection | undefined>;
  setModel(input: RuntimeModelSelectionInput): Promise<RuntimeModelSelection>;
  setThinkingLevel(input: RuntimeThinkingSelectionInput): Promise<RuntimeModelSelection>;
  exec(input: RuntimeExecInput): Promise<RuntimeExecResult>;
  on<K extends RuntimeExtensionEvent>(event: K, listener: RuntimeExtensionListener<K>): void;
  onDispose(dispose: () => void | Promise<void>): void;
  readonly ui: {
    setStatus(key: string, value?: string): void;
    setWidget(key: string, value?: string): void;
    setHeader(key: string, value?: string): void;
    setFooter(key: string, value?: string): void;
    setWorkingMessage(value?: string): void;
    setWorkingVisible(visible?: boolean): void;
    setTitle(value: string): void;
    notify(message: string, kind?: RuntimeUiNoticeKind): void;
    registerAutocompleteProvider(provider: RuntimeAutocompleteProvider): void;
    registerEditorMiddleware(middleware: RuntimeEditorMiddleware): void;
    /** Requires a trusted manifest with `permissions.advancedUi: true`. */
    readonly advanced: RuntimeAdvancedUiApi;
  };
  readonly auth: {
    /** Exact-origin authenticated request; credential material never enters extension memory. */
    fetch(
      provider: string,
      input: string | URL | Request,
      init?: RequestInit,
      signal?: AbortSignal,
    ): Promise<Response>;
  };
  readonly events: {
    on(topic: string, listener: RuntimeSharedEventListener): void;
    emit(topic: string, payload: JsonValue, signal?: AbortSignal): Promise<void>;
  };
  readonly session: {
    appendState(input: RuntimeExtensionStateAppendInput): Promise<RuntimeExtensionStateRecord>;
    compareAndAppendState(input: RuntimeExtensionStateCompareAndAppendInput): Promise<RuntimeExtensionStateCompareAndAppendResult>;
    readState(input: RuntimeExtensionStateReadInput): Promise<RuntimeExtensionStateRecord | undefined>;
    appendMessage(input: RuntimeExtensionMessageAppendInput): Promise<RuntimeExtensionMessageRecord>;
    readMessages(input: RuntimeExtensionMessagesReadInput): Promise<RuntimeExtensionMessageRecord[]>;
    registerRenderers(schemaVersion: number, renderer: RuntimeExtensionSessionRenderer): void;
  };
  /** Explicitly trusted host capabilities. Every member is separately permission-gated. */
  readonly native: RuntimeNativeExtensionApi;
}

interface RuntimeExtensionGeneration {
  active: boolean;
  abortController: AbortController;
  entry: ExtensionRuntimeEntry;
  dataPaths: RuntimeExtensionDataPaths;
}

interface StagedActivation {
  entry: ExtensionRuntimeEntry;
  generation: RuntimeExtensionGeneration;
  committed: boolean;
  tools: RuntimeToolRegistration[];
  commands: RuntimeCommandRegistration[];
  shortcuts: RuntimeShortcutRegistration[];
  flags: RuntimeFlagRegistration[];
  flagDefaults: Map<string, boolean | string>;
  providers: ProviderAdapter[];
  providerOverrides: Array<{ token: symbol; provider: ProviderAdapter }>;
  providerOverlays: Array<{ token: symbol; overlay: RuntimeProviderOverlay }>;
  providerWires: Array<{ token: symbol; provider: ProviderId; interceptor: ProviderWireInterceptor }>;
  providerAuth: ProviderAuthDescriptor[];
  toolRenderers: Array<{ name: string; renderer: RuntimeToolRenderer }>;
  sessionRenderers: Array<{ schemaVersion: number; renderer: RuntimeExtensionSessionRenderer }>;
  listeners: Array<{ event: RuntimeExtensionEvent; listener: RuntimeExtensionListener<RuntimeExtensionEvent> }>;
  sharedListeners: Array<{ topic: string; listener: RuntimeSharedEventListener }>;
  autocompleteProviders: RuntimeAutocompleteProvider[];
  editorMiddleware: RuntimeEditorMiddleware[];
  editorRenderers: RuntimeEditorRenderer[];
  disposers: Array<() => void | Promise<void>>;
  moduleDisposers: Array<() => void | Promise<void>>;
  ui: RuntimeInitialUiOperation[];
  advancedUi: RuntimeAdvancedUiOperation[];
}

interface OwnedRenderer<T> {
  entry: ExtensionRuntimeEntry;
  generation: RuntimeExtensionGeneration;
  renderer: T;
}

interface OwnedProviderOverride {
  token: symbol;
  entry: ExtensionRuntimeEntry;
  generation: RuntimeExtensionGeneration;
  provider: ProviderAdapter;
  cleanup?: () => void | Promise<void>;
}

interface OwnedProviderOverlay {
  token: symbol;
  entry: ExtensionRuntimeEntry;
  generation: RuntimeExtensionGeneration;
  overlay: RuntimeProviderOverlay;
  cleanup?: () => void | Promise<void>;
}

interface OwnedProviderWire {
  token: symbol;
  entry: ExtensionRuntimeEntry;
  generation: RuntimeExtensionGeneration;
  provider: ProviderId;
  interceptor: ProviderWireInterceptor;
  cleanup?: () => void | Promise<void>;
}

interface OwnedListener {
  entry: ExtensionRuntimeEntry;
  generation: RuntimeExtensionGeneration;
  event: RuntimeExtensionEvent;
  listener: RuntimeExtensionListener<RuntimeExtensionEvent>;
}

interface OwnedSharedListener {
  entry: ExtensionRuntimeEntry;
  generation: RuntimeExtensionGeneration;
  topic: string;
  listener: RuntimeSharedEventListener;
}

interface OwnedCommand {
  entry: ExtensionRuntimeEntry;
  generation: RuntimeExtensionGeneration;
  registration: RuntimeCommandRegistration;
}

interface OwnedAutocompleteProvider {
  entry: ExtensionRuntimeEntry;
  generation: RuntimeExtensionGeneration;
  provider: RuntimeAutocompleteProvider;
}

interface OwnedEditorMiddleware {
  entry: ExtensionRuntimeEntry;
  generation: RuntimeExtensionGeneration;
  middleware: RuntimeEditorMiddleware;
}

interface OwnedShortcut {
  entry: ExtensionRuntimeEntry;
  generation: RuntimeExtensionGeneration;
  registration: RuntimeShortcutRegistration;
}

interface OwnedFlag {
  entry: ExtensionRuntimeEntry;
  generation: RuntimeExtensionGeneration;
  registration: RuntimeFlagRegistration;
  owners: Set<string>;
}

function bounded(value: string, label: string, maximum = 8 * 1024): string {
  if (value.includes("\0") || Buffer.byteLength(value) > maximum) throw new Error(`${label} exceeds ${maximum} bytes or contains NUL`);
  return value;
}

function utf8Prefix(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maximumBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function key(value: string, label: string): string {
  if (!NAME.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function advancedUiSlot(value: unknown): RuntimeAdvancedUiSlot {
  if (
    value !== "header" && value !== "footer" && value !== "widget" &&
    value !== "widget-above" && value !== "widget-below" &&
    value !== "header-replacement" && value !== "footer-replacement"
  ) {
    throw new Error("Advanced UI component slot is invalid");
  }
  return value;
}

function advancedUiWorkingIndicator(value: RuntimeAdvancedUiWorkingIndicator): RuntimeAdvancedUiWorkingIndicator {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Advanced UI working indicator must be an object");
  }
  if (!Array.isArray(value.frames) || value.frames.length < 1 || value.frames.length > 32) {
    throw new RangeError("Advanced UI working indicator frames must contain 1-32 strings");
  }
  if (!Number.isSafeInteger(value.intervalMs) || value.intervalMs < 50 || value.intervalMs > 2_000) {
    throw new RangeError("Advanced UI working indicator intervalMs must be from 50 through 2000");
  }
  let bytes = 0;
  const frames = value.frames.map((frame, index) => {
    if (typeof frame !== "string" || frame.trim() === "") {
      throw new TypeError(`Advanced UI working indicator frame ${index} must be a non-empty string`);
    }
    const selected = bounded(frame, `Advanced UI working indicator frame ${index}`, 256);
    bytes += Buffer.byteLength(selected, "utf8");
    if (bytes > 1_024) throw new RangeError("Advanced UI working indicator frames exceed 1024 bytes");
    return selected;
  });
  return Object.freeze({ frames: Object.freeze(frames), intervalMs: value.intervalMs });
}

function runtimePromptGuidelines(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_RUNTIME_TOOL_PROMPT_GUIDELINES) {
    throw new Error(`Runtime tool promptGuidelines must contain at most ${MAX_RUNTIME_TOOL_PROMPT_GUIDELINES} strings`);
  }
  return value.map((guideline, index) => {
    if (typeof guideline !== "string" || guideline.trim() === "") {
      throw new Error(`Runtime tool promptGuidelines[${index}] must be a non-empty string`);
    }
    return bounded(guideline, `Runtime tool promptGuidelines[${index}]`, 4 * 1024);
  });
}

function error(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function ownerKey(entry: ExtensionRuntimeEntry): string {
  return `${entry.extensionId}\0${entry.sourcePath}`;
}

function pathInside(root: string, target: string): boolean {
  const local = relative(root, target);
  return local === "" || (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local));
}

const runtimeHostModuleExtension = extname(fileURLToPath(import.meta.url));
const RUNTIME_HOST_IMPORTS = new Map<string, string>([
  ["rigyn/context", new URL(`../context/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/core", new URL(`../core/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/extensions", new URL(`./index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/images", new URL(`../images/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/net", new URL(`../net/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/process", new URL(`../process/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/prompts", new URL(`../prompts/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/providers", new URL(`../providers/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/testing", new URL(`../testing/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/tools", new URL(`../tools/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/tui", new URL(`../tui/index${runtimeHostModuleExtension}`, import.meta.url).href],
]);

function runtimeImportParentPath(parentURL: string | undefined): string | undefined {
  if (parentURL === undefined || !parentURL.startsWith("file:")) return undefined;
  try {
    return fileURLToPath(parentURL);
  } catch {
    return undefined;
  }
}

function unsupportedRuntimeHostImport(specifier: string): Error & { code: string } {
  return Object.assign(
    new Error(`Runtime extensions may import only documented host modules: ${[...RUNTIME_HOST_IMPORTS.keys()].join(", ")}; ${specifier} is not exposed`),
    { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" },
  );
}

class RuntimeHostImportController {
  readonly #roots: string[];
  #hook: ReturnType<typeof registerHooks> | undefined;

  constructor(entries: readonly ExtensionRuntimeEntry[]) {
    this.#roots = [...new Set(entries.map((entry) => resolve(entry.resourceRoot ?? dirname(entry.sourcePath))))];
    if (this.#roots.length > MAX_RUNTIME_HOST_IMPORT_ROOTS) {
      throw new RangeError(`Runtime extension host imports exceed ${MAX_RUNTIME_HOST_IMPORT_ROOTS} package roots`);
    }
  }

  add(entries: readonly ExtensionRuntimeEntry[]): void {
    const roots = new Set(this.#roots);
    for (const entry of entries) roots.add(resolve(entry.resourceRoot ?? dirname(entry.sourcePath)));
    if (roots.size > MAX_RUNTIME_HOST_IMPORT_ROOTS) {
      throw new RangeError(`Runtime extension host imports exceed ${MAX_RUNTIME_HOST_IMPORT_ROOTS} package roots`);
    }
    this.#roots.splice(0, this.#roots.length, ...roots);
  }

  refresh(): void {
    this.#hook?.deregister();
    const roots = this.#roots;
    this.#hook = registerHooks({
      resolve(specifier, context, nextResolve) {
        const parentPath = runtimeImportParentPath(context.parentURL);
        if (parentPath === undefined || !roots.some((root) => pathInside(root, parentPath))) {
          return nextResolve(specifier, context);
        }
        const target = RUNTIME_HOST_IMPORTS.get(specifier);
        if (target !== undefined) return { url: target, shortCircuit: true };
        if (specifier === "rigyn" || specifier.startsWith("rigyn/")) {
          throw unsupportedRuntimeHostImport(specifier);
        }
        return nextResolve(specifier, context);
      },
    });
  }

  close(): void {
    this.#hook?.deregister();
    this.#hook = undefined;
  }
}

const runtimeHostImportControllers = new WeakMap<RuntimeExtensionHost, RuntimeHostImportController>();

function extensionDataPaths(
  dataRoot: string,
  workspace: string,
  entry: ExtensionRuntimeEntry,
): RuntimeExtensionDataPaths {
  const extensionId = validateExtensionId(entry.extensionId);
  const workspaceNamespace = sha256(workspace);
  return {
    user: join(dataRoot, "user", extensionId),
    workspace: join(dataRoot, "workspaces", workspaceNamespace, extensionId),
  };
}

async function secureExtensionDataDirectory(path: string): Promise<string> {
  const selected = resolve(path);
  await assertCanonicalDirectoryCreationPath(selected);
  await mkdir(selected, { recursive: true, mode: 0o700 });
  const information = await lstat(selected);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error(`Runtime extension data path is not a canonical directory: ${selected}`);
  }
  const canonical = await realpath(selected);
  if (canonical !== selected) throw new Error(`Runtime extension data path is not canonical: ${selected}`);
  if (process.platform !== "win32") await chmod(selected, 0o700);
  return canonical;
}

async function prepareExtensionDataPaths(
  paths: RuntimeExtensionDataPaths,
  signal: AbortSignal,
): Promise<RuntimeExtensionDataPaths> {
  signal.throwIfAborted();
  const user = await secureExtensionDataDirectory(paths.user);
  signal.throwIfAborted();
  const workspace = await secureExtensionDataDirectory(paths.workspace);
  signal.throwIfAborted();
  return Object.freeze({ user, workspace });
}

function normalizeShortcut(value: string): string {
  bounded(value, "Runtime shortcut", 128);
  const parts = value.trim().toLowerCase().split("+").map((part) => part.trim());
  if (parts.length < 1 || parts.some((part) => part === "")) throw new Error("Runtime shortcut is invalid");
  const rawBase = parts.pop();
  if (rawBase === undefined) throw new Error("Runtime shortcut is invalid");
  const base = rawBase === "esc" ? "escape" : rawBase === "return" ? "enter" : rawBase;
  const modifiers = new Set(parts);
  if (modifiers.size !== parts.length || [...modifiers].some((part) => !SHORTCUT_MODIFIERS.has(part))) {
    throw new Error("Runtime shortcut has invalid modifiers");
  }
  if (!SHORTCUT_NAMED_KEYS.has(base) && !/^[a-z0-9]$/u.test(base) && !/^[-=`\[\]\\;',./!@#$%^&*()_+|~{}:<>?]$/u.test(base)) {
    throw new Error("Runtime shortcut has an unsupported key");
  }
  return ["ctrl", "shift", "alt", "super", "hyper", "meta"]
    .filter((modifier) => modifiers.has(modifier))
    .concat(base)
    .join("+");
}

function validateFlag(registration: RuntimeFlagRegistration): RuntimeFlagRegistration {
  if (!FLAG.test(registration.name)) throw new Error("Runtime flag name is invalid");
  if (registration.description !== undefined) bounded(registration.description, "Runtime flag description", 4 * 1024);
  if (registration.type !== "boolean" && registration.type !== "string") throw new Error("Runtime flag type is invalid");
  if (registration.default !== undefined && typeof registration.default !== registration.type) {
    throw new Error(`Runtime flag ${registration.name} default must be ${registration.type}`);
  }
  if (typeof registration.default === "string") bounded(registration.default, "Runtime flag default", 64 * 1024);
  return { ...registration };
}

function lastRegistrations<T>(values: readonly T[], name: (value: T) => string): T[] {
  const unique = new Map<string, T>();
  for (const value of values) unique.set(name(value), value);
  return [...unique.values()];
}

function cloneBounded<T>(value: T, label: string, maximum = 16 * 1024 * 1024): T {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON-safe`);
  }
  if (serialized === undefined || Buffer.byteLength(serialized) > maximum) throw new Error(`${label} exceeds ${maximum} bytes`);
  return structuredClone(value);
}

function runtimeSessionRecord(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const selected of Reflect.ownKeys(value)) {
    if (typeof selected !== "string" || !allowed.includes(selected)) {
      throw new Error(`${label} contains an unknown or owner-controlled field`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, selected);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${label} must contain only enumerable data properties`);
    }
    record[selected] = descriptor.value;
  }
  return record;
}

function runtimeProviderOverlay(value: RuntimeProviderOverlay): RuntimeProviderOverlay {
  const record = runtimeSessionRecord(
    value,
    ["id", "displayName", "baseUrl", "headers", "models", "listModels", "stream"],
    "Runtime provider overlay",
  );
  if (typeof record.id !== "string" || !AUTH_PROVIDER.test(record.id)) {
    throw new TypeError("Runtime provider overlay ID is invalid");
  }
  if (record.displayName !== undefined && (
    typeof record.displayName !== "string" ||
    record.displayName.trim() !== record.displayName ||
    record.displayName === "" ||
    /[\x00-\x1f\x7f]/u.test(record.displayName) ||
    Buffer.byteLength(record.displayName, "utf8") > 1_024
  )) throw new TypeError("Runtime provider overlay displayName is invalid");
  if (record.baseUrl !== undefined) {
    if (typeof record.baseUrl !== "string" || Buffer.byteLength(record.baseUrl, "utf8") > 8_192) {
      throw new TypeError("Runtime provider overlay baseUrl is invalid");
    }
    let endpoint: URL;
    try {
      endpoint = new URL(record.baseUrl);
    } catch {
      throw new TypeError("Runtime provider overlay baseUrl is invalid");
    }
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname);
    if (
      (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) ||
      endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== ""
    ) throw new TypeError("Runtime provider overlay baseUrl must be HTTPS or loopback HTTP without credentials, query, or fragment");
  }
  let headers: Readonly<Record<string, string | null>> | undefined;
  if (record.headers !== undefined) {
    if (record.headers === null || typeof record.headers !== "object" || Array.isArray(record.headers)) {
      throw new TypeError("Runtime provider overlay headers must be an object");
    }
    const prototype = Object.getPrototypeOf(record.headers);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Runtime provider overlay headers must be a plain object");
    }
    const entries = Object.entries(record.headers);
    if (entries.length > 128) throw new RangeError("Runtime provider overlay headers exceed 128 entries");
    const normalized: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
    for (const [name, headerValue] of entries) {
      if (headerValue !== null && (typeof headerValue !== "string" || Buffer.byteLength(headerValue, "utf8") > 16 * 1_024)) {
        throw new TypeError(`Runtime provider overlay header ${name} is invalid`);
      }
      const checked = new Headers();
      checked.set(name, headerValue ?? "removed");
      normalized[name.toLocaleLowerCase("en-US")] = headerValue;
    }
    headers = Object.freeze(normalized);
  }
  if (record.models !== undefined && record.listModels !== undefined) {
    throw new TypeError("Runtime provider overlay cannot set both models and listModels");
  }
  let models: readonly ModelInfo[] | undefined;
  if (record.models !== undefined) {
    if (!Array.isArray(record.models) || record.models.length > 20_000) {
      throw new TypeError("Runtime provider overlay models must be an array of at most 20000 entries");
    }
    models = Object.freeze(cloneBounded(record.models, "Runtime provider overlay models", 8 * 1024 * 1024));
  }
  if (record.listModels !== undefined && typeof record.listModels !== "function") {
    throw new TypeError("Runtime provider overlay listModels must be a function");
  }
  if (record.stream !== undefined && typeof record.stream !== "function") {
    throw new TypeError("Runtime provider overlay stream must be a function");
  }
  if (
    record.displayName === undefined && record.baseUrl === undefined && headers === undefined &&
    models === undefined && record.listModels === undefined && record.stream === undefined
  ) throw new TypeError("Runtime provider overlay must replace at least one field");
  return Object.freeze({
    id: record.id,
    ...(record.displayName === undefined ? {} : { displayName: record.displayName }),
    ...(record.baseUrl === undefined ? {} : { baseUrl: new URL(record.baseUrl).toString().replace(/\/$/u, "") }),
    ...(headers === undefined ? {} : { headers }),
    ...(models === undefined ? {} : { models }),
    ...(record.listModels === undefined ? {} : { listModels: record.listModels as ProviderAdapter["listModels"] }),
    ...(record.stream === undefined ? {} : { stream: record.stream as ProviderAdapter["stream"] }),
  });
}

function runtimeResourcePaths(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_RUNTIME_RESOURCE_PATHS_PER_LISTENER) {
    throw new Error(`${label} must be an array of at most ${MAX_RUNTIME_RESOURCE_PATHS_PER_LISTENER} paths`);
  }
  const paths: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${label} must contain only enumerable data entries`);
    }
    const path = descriptor.value;
    if (
      typeof path !== "string" || path === "" || path.includes("\0") ||
      Buffer.byteLength(path, "utf8") > MAX_RUNTIME_RESOURCE_PATH_BYTES
    ) throw new Error(`${label}[${index}] must be a non-empty path no larger than ${MAX_RUNTIME_RESOURCE_PATH_BYTES} bytes`);
    paths.push(path);
  }
  return paths;
}

function runtimeResourcesDiscoverResult(value: unknown): Required<RuntimeResourcesDiscoverResult> {
  if (value === undefined) return { skillPaths: [], promptPaths: [], themePaths: [] };
  const record = runtimeSessionRecord(
    value,
    ["skillPaths", "promptPaths", "themePaths"],
    "Runtime resources_discover result",
  );
  const result = {
    skillPaths: runtimeResourcePaths(record.skillPaths, "Runtime resources_discover skillPaths"),
    promptPaths: runtimeResourcePaths(record.promptPaths, "Runtime resources_discover promptPaths"),
    themePaths: runtimeResourcePaths(record.themePaths, "Runtime resources_discover themePaths"),
  };
  if (result.skillPaths.length + result.promptPaths.length + result.themePaths.length > MAX_RUNTIME_RESOURCE_PATHS_PER_LISTENER) {
    throw new Error(`Runtime resources_discover result exceeds ${MAX_RUNTIME_RESOURCE_PATHS_PER_LISTENER} total paths`);
  }
  return result;
}

function runtimeProjectTrustResult(value: unknown): RuntimeProjectTrustResult {
  if (value === undefined) return { decision: "undecided" };
  const record = runtimeSessionRecord(value, ["decision", "remember"], "Runtime project_trust result");
  if (record.decision !== "yes" && record.decision !== "no" && record.decision !== "undecided") {
    throw new Error("Runtime project_trust decision must be yes, no, or undecided");
  }
  if (record.remember !== undefined && typeof record.remember !== "boolean") {
    throw new Error("Runtime project_trust remember must be boolean");
  }
  if (record.decision === "undecided" && record.remember !== undefined) {
    throw new Error("Runtime project_trust cannot remember an undecided result");
  }
  return {
    decision: record.decision,
    ...(record.remember === undefined ? {} : { remember: record.remember }),
  };
}

function runtimeSessionTarget(record: Record<string, unknown>, label: string): RuntimeExtensionSessionTarget {
  const threadId = record.threadId;
  if (typeof threadId !== "string" || threadId === "" || threadId.includes("\0") || Buffer.byteLength(threadId, "utf8") > 200) {
    throw new Error(`${label} threadId is invalid`);
  }
  const branch = record.branch;
  if (
    branch !== undefined &&
    (typeof branch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(branch) || branch.includes(".."))
  ) throw new Error(`${label} branch is invalid`);
  const signal = record.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error(`${label} signal is invalid`);
  return {
    threadId,
    ...(branch === undefined ? {} : { branch }),
    ...(signal === undefined ? {} : { signal }),
  };
}

function combinedGenerationSignal(
  generation: RuntimeExtensionGeneration,
  signal: unknown,
  label: string,
): AbortSignal {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error(`${label} signal is invalid`);
  return signal === undefined
    ? generation.abortController.signal
    : AbortSignal.any([generation.abortController.signal, signal]);
}

function runtimeModelSelection(value: unknown, label: string): RuntimeModelSelection {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  const record = value as Record<string, unknown>;
  if (typeof record.provider !== "string" || !AUTH_PROVIDER.test(record.provider)) throw new Error(`${label} provider is invalid`);
  if (typeof record.model !== "string") throw new Error(`${label} model is invalid`);
  bounded(record.model, `${label} model`, 1_024);
  if (record.model === "") throw new Error(`${label} model is invalid`);
  if (record.reasoningEffort !== undefined && typeof record.reasoningEffort !== "string") {
    throw new Error(`${label} reasoningEffort is invalid`);
  }
  if (typeof record.reasoningEffort === "string") bounded(record.reasoningEffort, `${label} reasoningEffort`, 128);
  return {
    provider: record.provider,
    model: record.model,
    ...(record.reasoningEffort === undefined ? {} : { reasoningEffort: record.reasoningEffort as string }),
  };
}

function runtimePromptComposition(value: unknown, label: string): PromptCompositionMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0) throw new Error(`${label} bytes are invalid`);
  if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.sha256)) throw new Error(`${label} sha256 is invalid`);
  if (typeof record.truncated !== "boolean") throw new Error(`${label} truncated is invalid`);
  if (!Array.isArray(record.sources) || record.sources.length > 128) throw new Error(`${label} sources are invalid`);
  const sources = record.sources.map((value, index) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} source ${index} is invalid`);
    const source = value as Record<string, unknown>;
    if (![
      "instruction", "system_prompt", "append_system_prompt", "additional_instructions",
    ].includes(String(source.kind))) throw new Error(`${label} source ${index} kind is invalid`);
    if (typeof source.source !== "string" || source.source === "") throw new Error(`${label} source ${index} path is invalid`);
    bounded(source.source, `${label} source ${index} path`, 4_096);
    if (!Number.isSafeInteger(source.bytes) || (source.bytes as number) < 0) throw new Error(`${label} source ${index} bytes are invalid`);
    if (typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(source.sha256)) throw new Error(`${label} source ${index} sha256 is invalid`);
    if (source.truncated !== undefined && typeof source.truncated !== "boolean") throw new Error(`${label} source ${index} truncated is invalid`);
    return {
      kind: source.kind as PromptCompositionMetadata["sources"][number]["kind"],
      source: source.source,
      bytes: source.bytes as number,
      sha256: source.sha256,
      ...(source.truncated === undefined ? {} : { truncated: source.truncated }),
    };
  });
  if (!Array.isArray(record.tools) || record.tools.length > 128) throw new Error(`${label} tools are invalid`);
  const tools = record.tools.map((tool, index) => {
    if (typeof tool !== "string" || !NAME.test(tool)) throw new Error(`${label} tool ${index} is invalid`);
    return tool;
  });
  if (!Array.isArray(record.skills) || record.skills.length > 256) throw new Error(`${label} skills are invalid`);
  const skills = record.skills.map((value, index) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} skill ${index} is invalid`);
    const skill = value as Record<string, unknown>;
    if (typeof skill.name !== "string" || skill.name === "") throw new Error(`${label} skill ${index} name is invalid`);
    if (typeof skill.manifestPath !== "string") throw new Error(`${label} skill ${index} path is invalid`);
    return {
      name: bounded(skill.name, `${label} skill ${index} name`, 256),
      manifestPath: bounded(skill.manifestPath, `${label} skill ${index} path`, 4_096),
    };
  });
  return {
    bytes: record.bytes as number,
    sha256: record.sha256,
    sources,
    tools,
    skills,
    truncated: record.truncated,
  };
}

function runtimeSessionSnapshot(value: unknown, label: string): RuntimeSessionSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  const record = value as Record<string, unknown>;
  const target = runtimeSessionTarget(record, label);
  if (target.branch === undefined) throw new Error(`${label} branch is required`);
  if (!Array.isArray(record.branches) || record.branches.some((branch) => typeof branch !== "string")) {
    throw new Error(`${label} branches are invalid`);
  }
  if (typeof record.active !== "boolean") throw new Error(`${label} active is invalid`);
  if (record.name !== undefined && typeof record.name !== "string") throw new Error(`${label} name is invalid`);
  if (record.operation !== undefined && record.operation !== null && record.operation !== "run" && record.operation !== "compaction") {
    throw new Error(`${label} operation is invalid`);
  }
  const phases = ["idle", "preparing", "streaming", "tool_planning", "executing", "retrying", "compacting"];
  if (record.phase !== undefined && (typeof record.phase !== "string" || !phases.includes(record.phase))) {
    throw new Error(`${label} phase is invalid`);
  }
  for (const field of ["pendingMessageCount", "recoverableMessageCount"] as const) {
    if (record[field] !== undefined && (!Number.isSafeInteger(record[field]) || (record[field] as number) < 0)) {
      throw new Error(`${label} ${field} is invalid`);
    }
  }
  let contextUsage: RuntimeSessionSnapshot["contextUsage"];
  if (record.contextUsage !== undefined) {
    if (record.contextUsage === null || typeof record.contextUsage !== "object" || Array.isArray(record.contextUsage)) {
      throw new Error(`${label} contextUsage is invalid`);
    }
    const usage = record.contextUsage as Record<string, unknown>;
    if (
      !Number.isSafeInteger(usage.tokens) || (usage.tokens as number) < 0 ||
      !Number.isSafeInteger(usage.contextWindow) || (usage.contextWindow as number) < 1 ||
      typeof usage.percent !== "number" || !Number.isFinite(usage.percent) || usage.percent < 0 ||
      usage.source !== "provider_usage"
    ) throw new Error(`${label} contextUsage is invalid`);
    contextUsage = {
      tokens: usage.tokens as number,
      contextWindow: usage.contextWindow as number,
      percent: usage.percent,
      source: "provider_usage",
    };
  }
  const model = record.model === undefined ? undefined : runtimeModelSelection(record.model, `${label} model`);
  const promptComposition = record.promptComposition === undefined
    ? undefined
    : runtimePromptComposition(record.promptComposition, `${label} promptComposition`);
  return {
    threadId: target.threadId,
    branch: target.branch,
    ...(record.name === undefined ? {} : { name: bounded(record.name as string, `${label} name`, 1_024) }),
    branches: [...new Set(record.branches as string[])],
    active: record.active,
    ...(record.operation === undefined ? {} : { operation: record.operation as "run" | "compaction" | null }),
    ...(record.phase === undefined ? {} : { phase: record.phase as NonNullable<RuntimeSessionSnapshot["phase"]> }),
    ...(record.pendingMessageCount === undefined ? {} : { pendingMessageCount: record.pendingMessageCount as number }),
    ...(record.recoverableMessageCount === undefined ? {} : { recoverableMessageCount: record.recoverableMessageCount as number }),
    ...(contextUsage === undefined ? {} : { contextUsage }),
    ...(model === undefined ? {} : { model }),
    ...(promptComposition === undefined ? {} : { promptComposition }),
  };
}

function runtimeChildUsage(value: unknown, label: string): RuntimeChildUsage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  const record = value as Record<string, unknown>;
  const result: RuntimeChildUsage = {};
  for (const field of [
    "inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens",
    "serverToolCalls", "durationMs",
  ] as const) {
    if (record[field] === undefined) continue;
    if (!Number.isSafeInteger(record[field]) || (record[field] as number) < 0) throw new Error(`${label} ${field} is invalid`);
    result[field] = record[field] as number;
  }
  if (record.cost !== undefined) {
    if (typeof record.cost !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(record.cost)) {
      throw new Error(`${label} cost is invalid`);
    }
    result.cost = bounded(record.cost, `${label} cost`, 128);
  }
  return result;
}

const RUNTIME_FINISH_REASONS = new Set<FinishReason>([
  "stop", "tool_calls", "length", "context_limit", "content_filter", "refusal",
  "pause", "cancelled", "error", "incomplete", "unknown",
]);
const RUNTIME_SAFE_EXTENSION_FINISH_REASONS = new Set<FinishReason>([
  "stop", "length", "content_filter", "refusal", "pause", "unknown",
]);

function runtimeFinishReason(value: unknown, label: string): FinishReason {
  if (typeof value !== "string" || !RUNTIME_FINISH_REASONS.has(value as FinishReason)) {
    throw new Error(`${label} is invalid`);
  }
  return value as FinishReason;
}

function runtimeFinalizedUsage(value: unknown, label: string): NormalizedUsage {
  const record = runtimeSessionRecord(value, [
    "inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens",
    "reasoningTokens", "serverToolCalls", "cost", "durationMs",
  ], label);
  if (!isNormalizedUsage(record)) throw new Error(`${label} is not valid normalized usage`);
  return cloneBounded(record as NormalizedUsage, label);
}

function runtimeFinalizedResponse(
  value: unknown,
  label: string,
  allowRawUsage: boolean,
): RuntimeMessageEndReduction["finalized"] {
  const record = runtimeSessionRecord(value, ["finishReason", "usage", "rawReason", "explanation"], label);
  const usage = record.usage === undefined
    ? undefined
    : allowRawUsage
      ? cloneBounded(record.usage, `${label} usage`) as NormalizedUsage
      : runtimeFinalizedUsage(record.usage, `${label} usage`);
  if (usage !== undefined && !isNormalizedUsage(usage)) throw new Error(`${label} usage is invalid`);
  for (const field of ["rawReason", "explanation"] as const) {
    if (record[field] !== undefined && typeof record[field] !== "string") throw new Error(`${label} ${field} is invalid`);
  }
  const rawReason = record.rawReason === undefined
    ? undefined
    : bounded(record.rawReason as string, `${label} rawReason`, 16 * 1024);
  const explanation = record.explanation === undefined
    ? undefined
    : bounded(record.explanation as string, `${label} explanation`, 16 * 1024);
  return {
    finishReason: runtimeFinishReason(record.finishReason, `${label} finishReason`),
    ...(usage === undefined ? {} : { usage }),
    ...(rawReason === undefined ? {} : { rawReason }),
    ...(explanation === undefined ? {} : { explanation }),
  };
}

function runtimeFinalizedResponseView(
  value: NonNullable<RuntimeMessageEndReduction["finalized"]>,
): RuntimeFinalizedAssistantResponse {
  const usage = value.usage === undefined
    ? undefined
    : (({ raw: _raw, ...safe }) => safe)(value.usage);
  return {
    finishReason: value.finishReason,
    ...(usage === undefined ? {} : { usage }),
    ...(value.rawReason === undefined ? {} : { rawReason: value.rawReason }),
    ...(value.explanation === undefined ? {} : { explanation: value.explanation }),
  };
}

function runtimeSessionUsageSnapshot(value: unknown, label: string): RuntimeSessionUsageSnapshot {
  const record = runtimeSessionRecord(
    value,
    ["threadId", "branch", "runCount", "responseCount", "usageEventCount", "usage", "cache"],
    label,
  );
  const target = runtimeSessionTarget(record, label);
  if (target.branch === undefined) throw new Error(`${label} branch is required`);
  for (const field of ["runCount", "responseCount", "usageEventCount"] as const) {
    if (!Number.isSafeInteger(record[field]) || (record[field] as number) < 0) {
      throw new Error(`${label} ${field} is invalid`);
    }
  }
  const cache = runtimeSessionRecord(record.cache, [
    "status", "samples", "observedInputTokens", "uncachedInputTokens", "cacheReadTokens", "cacheWriteTokens", "reuseRatio",
  ], `${label} cache`);
  if (!["unavailable", "cold", "effective", "mixed", "low_reuse", "write_churn"].includes(String(cache.status))) {
    throw new Error(`${label} cache status is invalid`);
  }
  for (const field of ["samples", "observedInputTokens", "uncachedInputTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
    if (!Number.isSafeInteger(cache[field]) || (cache[field] as number) < 0) {
      throw new Error(`${label} cache ${field} is invalid`);
    }
  }
  if (cache.reuseRatio !== undefined && (
    typeof cache.reuseRatio !== "number" || !Number.isFinite(cache.reuseRatio) || cache.reuseRatio < 0 || cache.reuseRatio > 1
  )) throw new Error(`${label} cache reuseRatio is invalid`);
  return {
    threadId: target.threadId,
    branch: target.branch,
    runCount: record.runCount as number,
    responseCount: record.responseCount as number,
    usageEventCount: record.usageEventCount as number,
    usage: runtimeChildUsage(record.usage, `${label} usage`),
    cache: {
      status: cache.status as RuntimeSessionUsageSnapshot["cache"]["status"],
      samples: cache.samples as number,
      observedInputTokens: cache.observedInputTokens as number,
      uncachedInputTokens: cache.uncachedInputTokens as number,
      cacheReadTokens: cache.cacheReadTokens as number,
      cacheWriteTokens: cache.cacheWriteTokens as number,
      ...(cache.reuseRatio === undefined ? {} : { reuseRatio: cache.reuseRatio as number }),
    },
  };
}

function runtimeSystemPromptSnapshot(value: unknown, label: string): RuntimeSystemPromptSnapshot {
  const record = runtimeSessionRecord(
    value,
    ["threadId", "branch", "text", "bytes", "sha256", "redacted", "model", "composition"],
    label,
  );
  const target = runtimeSessionTarget(record, label);
  if (target.branch === undefined) throw new Error(`${label} branch is required`);
  if (typeof record.text !== "string") throw new Error(`${label} text is invalid`);
  bounded(record.text, `${label} text`, 4 * 1024 * 1024);
  if (!Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0) throw new Error(`${label} bytes are invalid`);
  if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.sha256)) throw new Error(`${label} sha256 is invalid`);
  if (typeof record.redacted !== "boolean") throw new Error(`${label} redacted is invalid`);
  const model = record.model === undefined ? undefined : runtimeModelSelection(record.model, `${label} model`);
  const composition = record.composition === undefined
    ? undefined
    : runtimePromptComposition(record.composition, `${label} composition`);
  return {
    threadId: target.threadId,
    branch: target.branch,
    text: record.text,
    bytes: record.bytes as number,
    sha256: record.sha256,
    redacted: record.redacted,
    ...(model === undefined ? {} : { model }),
    ...(composition === undefined ? {} : { composition }),
  };
}

function runtimeChildSession(value: unknown, label: string): RuntimeChildSession {
  const record = runtimeSessionRecord(value, ["threadId", "branch", "model", "persisted"], label);
  const target = runtimeSessionTarget(record, label);
  if (target.branch === undefined) throw new Error(`${label} branch is required`);
  if (typeof record.persisted !== "boolean") throw new Error(`${label} persisted is invalid`);
  return {
    threadId: target.threadId,
    branch: target.branch,
    model: runtimeModelSelection(record.model, `${label} model`),
    persisted: record.persisted,
  };
}

const RUNTIME_CHILD_VISIBLE_EVENTS = new Set<RuntimeChildVisibleEvent["type"]>([
  "run_started", "model_selected", "run_state", "assistant_started", "provider_response_started", "text_delta",
  "reasoning_delta", "tool_call_started", "tool_call_delta", "assistant_completed", "tool_requested", "tool_started", "tool_progress", "tool_completed",
  "tool_in_doubt", "usage", "retry_scheduled", "compaction_started", "compaction_completed", "steering_queued",
  "run_completed", "run_failed", "run_cancelled", "warning",
]);

function runtimeChildEvent(value: unknown, label: string): RuntimeChildEvent {
  const record = runtimeSessionRecord(
    value,
    ["threadId", "branch", "runId", "sequence", "timestamp", "event"],
    label,
  );
  const target = runtimeSessionTarget(record, label);
  if (target.branch === undefined) throw new Error(`${label} branch is required`);
  if (record.runId !== undefined && typeof record.runId !== "string") throw new Error(`${label} runId is invalid`);
  if (!Number.isSafeInteger(record.sequence) || (record.sequence as number) < 0) throw new Error(`${label} sequence is invalid`);
  if (typeof record.timestamp !== "string" || record.timestamp === "") throw new Error(`${label} timestamp is invalid`);
  if (record.event === null || typeof record.event !== "object" || Array.isArray(record.event) || !isJsonValue(record.event)) {
    throw new Error(`${label} event is invalid`);
  }
  const event = record.event as RuntimeEvent;
  if (!RUNTIME_CHILD_VISIBLE_EVENTS.has(event.type as RuntimeChildVisibleEvent["type"])) {
    throw new Error(`${label} event type is unavailable`);
  }
  if (event.type === "reasoning_delta" && event.visibility !== "summary") {
    throw new Error(`${label} cannot expose provider-trace reasoning`);
  }
  return cloneBounded({
    threadId: target.threadId,
    branch: target.branch,
    ...(record.runId === undefined ? {} : { runId: record.runId as string }),
    sequence: record.sequence as number,
    timestamp: record.timestamp,
    event: event as RuntimeChildVisibleEvent,
  }, label, 2 * 1024 * 1024);
}

function runtimeChildRunResult(value: unknown, label: string): RuntimeChildRunResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  const record = value as Record<string, unknown>;
  if (record.status !== "success" && record.status !== "cancelled" && record.status !== "error") {
    throw new Error(`${label} status is invalid`);
  }
  const target = runtimeSessionTarget(record, label);
  if (target.branch === undefined) throw new Error(`${label} branch is required`);
  if (typeof record.persisted !== "boolean" || typeof record.truncated !== "boolean") {
    throw new Error(`${label} flags are invalid`);
  }
  if (typeof record.summary !== "string" || typeof record.finalText !== "string") throw new Error(`${label} text is invalid`);
  bounded(record.summary, `${label} summary`, 16 * 1024);
  bounded(record.finalText, `${label} finalText`, MAX_RUNTIME_CHILD_OUTPUT_BYTES);
  if (!Array.isArray(record.nextActions) || record.nextActions.length > 16 || record.nextActions.some((item) => typeof item !== "string")) {
    throw new Error(`${label} nextActions are invalid`);
  }
  const nextActions = (record.nextActions as string[]).map((item) => bounded(item, `${label} nextAction`, 4 * 1024));
  for (const field of ["runId", "finishReason", "error"] as const) {
    if (record[field] !== undefined && typeof record[field] !== "string") throw new Error(`${label} ${field} is invalid`);
    if (typeof record[field] === "string") bounded(record[field] as string, `${label} ${field}`, 16 * 1024);
  }
  if (record.steps !== undefined && (!Number.isSafeInteger(record.steps) || (record.steps as number) < 0)) {
    throw new Error(`${label} steps are invalid`);
  }
  const usage = record.usage === undefined ? undefined : runtimeChildUsage(record.usage, `${label} usage`);
  const model = runtimeModelSelection(record.model, `${label} model`);
  if (!Array.isArray(record.artifacts) || record.artifacts.length > 64) throw new Error(`${label} artifacts are invalid`);
  const artifacts = record.artifacts.map((value, index): RuntimeChildArtifactMetadata => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} artifact ${index} is invalid`);
    const artifact = value as Record<string, unknown>;
    if (typeof artifact.id !== "string" || artifact.id === "") throw new Error(`${label} artifact ${index} id is invalid`);
    if (typeof artifact.mediaType !== "string" || artifact.mediaType === "") throw new Error(`${label} artifact ${index} mediaType is invalid`);
    if (!Number.isSafeInteger(artifact.bytes) || (artifact.bytes as number) < 0) throw new Error(`${label} artifact ${index} bytes are invalid`);
    if (typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) throw new Error(`${label} artifact ${index} sha256 is invalid`);
    if (typeof artifact.retained !== "boolean") throw new Error(`${label} artifact ${index} retained is invalid`);
    return {
      id: bounded(artifact.id, `${label} artifact ${index} id`, 256),
      mediaType: bounded(artifact.mediaType, `${label} artifact ${index} mediaType`, 256),
      bytes: artifact.bytes as number,
      sha256: artifact.sha256,
      retained: artifact.retained,
    };
  });
  if (!Number.isSafeInteger(record.artifactCount) || (record.artifactCount as number) < artifacts.length) {
    throw new Error(`${label} artifactCount is invalid`);
  }
  if (typeof record.artifactsTruncated !== "boolean") throw new Error(`${label} artifactsTruncated is invalid`);
  if (record.artifactsTruncated !== ((record.artifactCount as number) > artifacts.length)) {
    throw new Error(`${label} artifact truncation metadata is inconsistent`);
  }
  if (record.execution === null || typeof record.execution !== "object" || Array.isArray(record.execution)) {
    throw new Error(`${label} execution is invalid`);
  }
  const executionRecord = record.execution as Record<string, unknown>;
  if (executionRecord.backend !== "local" && executionRecord.backend !== "host") throw new Error(`${label} execution backend is invalid`);
  if (executionRecord.backendId !== undefined && typeof executionRecord.backendId !== "string") throw new Error(`${label} execution backendId is invalid`);
  if (typeof executionRecord.required !== "boolean") throw new Error(`${label} execution required is invalid`);
  const routedTools = runtimeActiveToolNames(executionRecord.routedTools, `${label} execution routedTools`);
  const localTools = runtimeActiveToolNames(executionRecord.localTools, `${label} execution localTools`);
  if (routedTools.some((tool) => localTools.includes(tool))) throw new Error(`${label} execution tool sets overlap`);
  if (
    (executionRecord.backend === "host") !== (executionRecord.backendId !== undefined) ||
    (executionRecord.required === true && (executionRecord.backend !== "host" || localTools.length > 0))
  ) throw new Error(`${label} execution metadata is inconsistent`);
  const execution: RuntimeChildExecutionResult = {
    backend: executionRecord.backend,
    ...(executionRecord.backendId === undefined
      ? {}
      : { backendId: bounded(executionRecord.backendId as string, `${label} execution backendId`, 64) }),
    required: executionRecord.required,
    routedTools,
    localTools,
  };
  return {
    status: record.status,
    summary: record.summary,
    nextActions,
    threadId: target.threadId,
    branch: target.branch,
    model,
    persisted: record.persisted,
    ...(record.runId === undefined ? {} : { runId: record.runId as string }),
    ...(record.finishReason === undefined ? {} : { finishReason: record.finishReason as string }),
    finalText: record.finalText,
    ...(record.steps === undefined ? {} : { steps: record.steps as number }),
    ...(usage === undefined ? {} : { usage }),
    artifacts,
    artifactCount: record.artifactCount as number,
    artifactsTruncated: record.artifactsTruncated,
    execution,
    truncated: record.truncated,
    ...(record.error === undefined ? {} : { error: record.error as string }),
  };
}

function runtimeActiveToolNames(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must contain at most ${MAX_RUNTIME_ACTIVE_TOOLS} names`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > MAX_RUNTIME_ACTIVE_TOOLS
  ) throw new Error(`${label} must contain at most ${MAX_RUNTIME_ACTIVE_TOOLS} names`);
  const length = lengthDescriptor.value as number;
  const names: string[] = [];
  const seen = new Set<string>();
  for (const selected of Reflect.ownKeys(descriptors)) {
    if (typeof selected !== "string") throw new Error(`${label} must not contain symbol keys`);
    if (selected === "length") continue;
    if (!/^(0|[1-9][0-9]*)$/u.test(selected) || Number(selected) >= length) {
      throw new Error(`${label} contains a non-index property`);
    }
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${label} must be a dense data-property array`);
    }
    const name = descriptor.value;
    if (typeof name !== "string" || !NAME.test(name)) throw new Error(`${label} contains an invalid tool name`);
    if (seen.has(name)) throw new Error(`${label} contains a duplicate tool name: ${name}`);
    seen.add(name);
    names.push(name);
  }
  return names;
}

function runtimeCatalogOwner(value: unknown, label: string): RuntimeCatalogOwner {
  const record = runtimeSessionRecord(value, ["kind", "extensionId", "sourcePath"], label);
  if (record.kind === "builtin" || record.kind === "host") {
    if (record.extensionId !== undefined || record.sourcePath !== undefined) {
      throw new Error(`${label} contains invalid ownership fields`);
    }
    return { kind: record.kind };
  }
  if (record.kind !== "extension" || typeof record.extensionId !== "string" || typeof record.sourcePath !== "string") {
    throw new Error(`${label} is invalid`);
  }
  bounded(record.extensionId, `${label} extensionId`, 1_024);
  bounded(record.sourcePath, `${label} sourcePath`, 16 * 1_024);
  return {
    kind: "extension",
    extensionId: record.extensionId,
    sourcePath: record.sourcePath,
  };
}

function runtimeToolCatalog(value: unknown, label: string): RuntimeToolCatalogEntry[] {
  const cloned = cloneBounded(value, label, MAX_RUNTIME_CATALOG_BYTES);
  if (!Array.isArray(cloned) || cloned.length > MAX_RUNTIME_ACTIVE_TOOLS) {
    throw new Error(`${label} must contain at most ${MAX_RUNTIME_ACTIVE_TOOLS} tools`);
  }
  const tools: RuntimeToolCatalogEntry[] = [];
  const names = new Set<string>();
  for (let index = 0; index < cloned.length; index += 1) {
    const record = runtimeSessionRecord(
      cloned[index],
      ["name", "description", "inputSchema", "active", "executionMode", "owner", "loading", "promptSnippet", "promptGuidelines"],
      `${label}[${index}]`,
    );
    if (typeof record.name !== "string" || !NAME.test(record.name) || names.has(record.name)) {
      throw new Error(`${label}[${index}] name is invalid or duplicated`);
    }
    if (typeof record.description !== "string") throw new Error(`${label}[${index}] description is invalid`);
    if (record.inputSchema === null || typeof record.inputSchema !== "object" || Array.isArray(record.inputSchema) || !isJsonValue(record.inputSchema)) {
      throw new Error(`${label}[${index}] inputSchema is invalid`);
    }
    if (typeof record.active !== "boolean") throw new Error(`${label}[${index}] active is invalid`);
    if (record.executionMode !== "parallel" && record.executionMode !== "sequential") {
      throw new Error(`${label}[${index}] executionMode is invalid`);
    }
    if (record.loading !== undefined && record.loading !== "eager" && record.loading !== "deferred") {
      throw new Error(`${label}[${index}] loading is invalid`);
    }
    if (record.promptSnippet !== undefined && typeof record.promptSnippet !== "string") {
      throw new Error(`${label}[${index}] promptSnippet is invalid`);
    }
    const promptGuidelines = runtimePromptGuidelines(record.promptGuidelines as string[] | undefined);
    names.add(record.name);
    tools.push({
      name: record.name,
      description: bounded(record.description, `${label}[${index}] description`, 16 * 1024),
      inputSchema: record.inputSchema as Record<string, JsonValue>,
      active: record.active,
      executionMode: record.executionMode,
      owner: runtimeCatalogOwner(record.owner, `${label}[${index}] owner`),
      ...(record.loading === undefined
        ? {}
        : { loading: record.loading as NonNullable<ToolDefinition["loading"]> }),
      ...(record.promptSnippet === undefined
        ? {}
        : { promptSnippet: bounded(record.promptSnippet as string, `${label}[${index}] promptSnippet`, 4 * 1024) }),
      ...(promptGuidelines === undefined ? {} : { promptGuidelines }),
    });
  }
  return tools;
}

function runtimeSessionNameRecord(value: unknown, label: string): RuntimeSessionNameRecord {
  const record = runtimeSessionRecord(value, ["threadId", "branch", "name"], label);
  const target = runtimeSessionTarget(record, label);
  if (target.branch === undefined) throw new Error(`${label} branch is required`);
  if (record.name !== undefined && typeof record.name !== "string") throw new Error(`${label} name is invalid`);
  return {
    threadId: target.threadId,
    branch: target.branch,
    ...(record.name === undefined ? {} : { name: bounded(record.name as string, `${label} name`, 1_024) }),
  };
}

function runtimeEntryLabelRecord(value: unknown, label: string): RuntimeEntryLabelRecord {
  const record = runtimeSessionRecord(
    value,
    ["threadId", "branch", "targetEventId", "eventId", "timestamp", "label"],
    label,
  );
  const target = runtimeSessionTarget(record, label);
  if (target.branch === undefined) throw new Error(`${label} branch is required`);
  for (const field of ["targetEventId", "eventId", "timestamp"] as const) {
    if (typeof record[field] !== "string" || record[field] === "") throw new Error(`${label} ${field} is invalid`);
    bounded(record[field] as string, `${label} ${field}`, 1_024);
  }
  if (record.label !== undefined && typeof record.label !== "string") throw new Error(`${label} label is invalid`);
  return {
    threadId: target.threadId,
    branch: target.branch,
    targetEventId: record.targetEventId as string,
    eventId: record.eventId as string,
    timestamp: record.timestamp as string,
    ...(record.label === undefined ? {} : { label: bounded(record.label as string, `${label} label`, 1_024) }),
  };
}

function sessionRendererKey(extensionId: string, schemaVersion: number): string {
  return `${validateExtensionId(extensionId)}\0${validateExtensionSchemaVersion(schemaVersion)}`;
}

function runtimeRecordText(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "" || value.includes("\0") || Buffer.byteLength(value, "utf8") > 256) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function canonicalRuntimeStateRecord(value: unknown): RuntimeExtensionStateRecord {
  const record = runtimeSessionRecord(
    value,
    ["type", "extensionId", "schemaVersion", "key", "value", "threadId", "branch", "eventId", "timestamp"],
    "Runtime extension state record",
  );
  const target = runtimeSessionTarget(record, "Runtime extension state record");
  if (target.branch === undefined) throw new Error("Runtime extension state record branch is required");
  const event = structuredClone(canonicalExtensionStateEvent({
    type: record.type,
    extensionId: record.extensionId,
    schemaVersion: record.schemaVersion,
    key: record.key,
    value: record.value,
  }));
  return {
    ...event,
    threadId: target.threadId,
    branch: target.branch,
    eventId: runtimeRecordText(record.eventId, "Runtime extension state eventId"),
    timestamp: runtimeRecordText(record.timestamp, "Runtime extension state timestamp"),
  };
}

function canonicalRuntimeMessageRecord(value: unknown): RuntimeExtensionMessageRecord {
  const record = runtimeSessionRecord(
    value,
    [
      "type", "extensionId", "schemaVersion", "kind", "messageId", "payload", "modelContext", "transcript",
      "threadId", "branch", "eventId", "timestamp",
    ],
    "Runtime extension message record",
  );
  const target = runtimeSessionTarget(record, "Runtime extension message record");
  if (target.branch === undefined) throw new Error("Runtime extension message record branch is required");
  const event = structuredClone(canonicalExtensionMessageEvent({
    type: record.type,
    extensionId: record.extensionId,
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    messageId: record.messageId,
    payload: record.payload,
    modelContext: record.modelContext,
    transcript: record.transcript,
  }));
  return {
    ...event,
    threadId: target.threadId,
    branch: target.branch,
    eventId: runtimeRecordText(record.eventId, "Runtime extension message eventId"),
    timestamp: runtimeRecordText(record.timestamp, "Runtime extension message timestamp"),
  };
}

function runtimeUserShellCommand(value: unknown, label = "Runtime user-shell command"): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return bounded(value, label, MAX_RUNTIME_USER_SHELL_COMMAND_BYTES);
}

function runtimeUserShellCwd(value: unknown, label = "Runtime user-shell cwd"): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return bounded(value, label, MAX_RUNTIME_USER_SHELL_CWD_BYTES);
}

function canonicalRuntimeUserShellResult(value: unknown, label = "Runtime user-shell result"): RuntimeUserShellResult {
  const result = runtimeSessionRecord(value, ["text", "exitCode", "signal"], label);
  if (typeof result.text !== "string") throw new Error(`${label} text must be a string`);
  const text = bounded(result.text, `${label} text`, MAX_RUNTIME_USER_SHELL_RESULT_BYTES);
  const exitCode = result.exitCode;
  if (exitCode !== null && (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode))) {
    throw new Error(`${label} exitCode must be a safe integer or null`);
  }
  const selectedSignal = result.signal;
  if (selectedSignal !== undefined && typeof selectedSignal !== "string") {
    throw new Error(`${label} signal must be a string when provided`);
  }
  const signal = selectedSignal === undefined
    ? undefined
    : bounded(selectedSignal, `${label} signal`, 128);
  return {
    text: defaultSecretRedactor.redact(text),
    exitCode,
    ...(signal === undefined ? {} : { signal }),
  };
}

function isRuntimeUserShellEvent(value: unknown): value is RuntimeUserShellEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (event.type !== "user_shell" || typeof event.command !== "string" || typeof event.hidden !== "boolean") return false;
  if (event.result === null || typeof event.result !== "object" || Array.isArray(event.result)) return false;
  const result = event.result as Record<string, unknown>;
  return typeof result.text === "string" &&
    (result.exitCode === null || (typeof result.exitCode === "number" && Number.isSafeInteger(result.exitCode))) &&
    (result.signal === undefined || typeof result.signal === "string");
}

function observedMessage(message: CanonicalMessage): CanonicalMessage {
  return {
    ...message,
    content: message.content.filter((block) => block.type !== "provider_opaque"),
  };
}

function observedDurableEvent(event: RuntimeEvent, listenerExtensionId: string): RuntimeEvent {
  switch (event.type) {
    case "message_appended": {
      return {
        type: "message_appended",
        message: observedMessage(event.message),
        ...(event.toolDefinitionFingerprint === undefined ? {} : { toolDefinitionFingerprint: event.toolDefinitionFingerprint }),
      };
    }
    case "reasoning_delta":
      return event.visibility === "provider_trace" ? { ...event, text: "" } : event;
    case "usage": {
      const { raw: _raw, ...usage } = event.usage;
      return { ...event, usage };
    }
    case "run_failed": {
      if (!("retryable" in event.error)) return event;
      const { raw: _raw, diagnostics: _diagnostics, ...error } = event.error;
      return { ...event, error };
    }
    case "compaction_completed":
      return { ...event, summary: observedMessage(event.summary) };
    case "branch_summary_created":
      return { ...event, summary: observedMessage(event.summary) };
    case "extension_state":
      return event.extensionId === listenerExtensionId ? event : { ...event, value: null };
    case "extension_message":
      return event.extensionId === listenerExtensionId
        ? event
        : { ...event, payload: null, modelContext: false };
    default:
      return event;
  }
}

function observedEventForListener(
  event: RuntimeObservedEvent,
  listenerExtensionId: string,
): RuntimeObservedEvent {
  if (isRuntimeUserShellEvent(event)) return event;
  return { ...event, event: observedDurableEvent(event.event, listenerExtensionId) };
}

function validContentBlock(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const block = value as Record<string, unknown>;
  switch (block.type) {
    case "text":
      return typeof block.text === "string";
    case "image":
      return typeof block.mediaType === "string" &&
        (block.data === undefined || typeof block.data === "string") &&
        (block.url === undefined || typeof block.url === "string");
    case "tool_call":
      return typeof block.callId === "string" &&
        typeof block.name === "string" &&
        isJsonValue(block.arguments) &&
        (block.rawArguments === undefined || typeof block.rawArguments === "string");
    case "tool_result":
      return typeof block.callId === "string" &&
        typeof block.name === "string" &&
        typeof block.content === "string" &&
        typeof block.isError === "boolean" &&
        (block.status === undefined || ["success", "warning", "error"].includes(String(block.status))) &&
        (block.summary === undefined || typeof block.summary === "string") &&
        (block.nextActions === undefined || (
          Array.isArray(block.nextActions) && block.nextActions.every((entry) => typeof entry === "string")
        )) &&
        (block.images === undefined || (
          Array.isArray(block.images) &&
          block.images.every((entry) => validContentBlock(entry) && (entry as { type?: unknown }).type === "image")
        )) &&
        (block.artifactIds === undefined || (
          Array.isArray(block.artifactIds) && block.artifactIds.every((entry) => typeof entry === "string")
        )) &&
        (block.metadata === undefined || isJsonValue(block.metadata));
    case "provider_opaque":
      return typeof block.provider === "string" &&
        typeof block.mediaType === "string" &&
        isJsonValue(block.value) &&
        (block.serialized === undefined || typeof block.serialized === "string");
    default:
      return false;
  }
}

function canonicalMessages(value: unknown, label: string): CanonicalMessage[] {
  if (!Array.isArray(value) || value.length > 100_000) throw new Error(`${label} must be a bounded message array`);
  for (const message of value) {
    if (
      message === null ||
      typeof message !== "object" ||
      !isJsonValue(message) ||
      typeof (message as { id?: unknown }).id !== "string" ||
      typeof (message as { createdAt?: unknown }).createdAt !== "string" ||
      !["system", "user", "assistant", "tool"].includes(String((message as { role?: unknown }).role)) ||
      !Array.isArray((message as { content?: unknown }).content) ||
      !(message as { content: unknown[] }).content.every(validContentBlock) ||
      ((message as { displayText?: unknown }).displayText !== undefined && typeof (message as { displayText?: unknown }).displayText !== "string") ||
      ((message as { provider?: unknown }).provider !== undefined && typeof (message as { provider?: unknown }).provider !== "string") ||
      ((message as { purpose?: unknown }).purpose !== undefined &&
        !["instructions", "compaction"].includes(String((message as { purpose?: unknown }).purpose)))
    ) {
      throw new Error(`${label} contains an invalid canonical message`);
    }
  }
  return cloneBounded(value as CanonicalMessage[], label);
}

function runtimeProviderTools(value: unknown, label: string): ToolDefinition[] {
  if (!Array.isArray(value) || value.length > 4_096) throw new Error(`${label} must be a bounded tool array`);
  const names = new Set<string>();
  const tools = value.map((item, index) => {
    const record = runtimeSessionRecord(
      item,
      ["name", "description", "inputSchema", "loading", "promptSnippet", "promptGuidelines"],
      `${label}[${index}]`,
    );
    if (typeof record.name !== "string") throw new Error(`${label}[${index}] name is invalid`);
    const name = key(record.name, `${label}[${index}] name`);
    if (names.has(name)) throw new Error(`${label} contains duplicate tool ${name}`);
    names.add(name);
    if (typeof record.description !== "string") throw new Error(`${label}[${index}] description is invalid`);
    const description = bounded(record.description, `${label}[${index}] description`, 16 * 1024);
    if (record.inputSchema === null || typeof record.inputSchema !== "object" || Array.isArray(record.inputSchema) || !isJsonValue(record.inputSchema)) {
      throw new Error(`${label}[${index}] inputSchema is invalid`);
    }
    const promptSnippet = record.promptSnippet;
    if (record.loading !== undefined && record.loading !== "eager" && record.loading !== "deferred") {
      throw new Error(`${label}[${index}] loading is invalid`);
    }
    if (promptSnippet !== undefined && (typeof promptSnippet !== "string" || promptSnippet.trim() === "")) {
      throw new Error(`${label}[${index}] promptSnippet is invalid`);
    }
    const promptGuidelines = runtimePromptGuidelines(record.promptGuidelines);
    return {
      name,
      description,
      inputSchema: cloneBounded(record.inputSchema as Record<string, JsonValue>, `${label}[${index}] inputSchema`, 1024 * 1024),
      ...(record.loading === undefined
        ? {}
        : { loading: record.loading as NonNullable<ToolDefinition["loading"]> }),
      ...(promptSnippet === undefined ? {} : { promptSnippet: bounded(promptSnippet as string, `${label}[${index}] promptSnippet`, 4 * 1024) }),
      ...(promptGuidelines === undefined ? {} : { promptGuidelines }),
    };
  });
  return cloneBounded(tools, label);
}

function runtimeProviderMetadata(value: unknown, label: string): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  const entries = Reflect.ownKeys(value);
  if (entries.length > 128) throw new Error(`${label} contains too many entries`);
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const selected of entries) {
    if (typeof selected !== "string" || selected === "" || selected.includes("\0") || Buffer.byteLength(selected, "utf8") > 256) {
      throw new Error(`${label} contains an invalid key`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, selected);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true || typeof descriptor.value !== "string") {
      throw new Error(`${label}.${selected} must be an enumerable string data property`);
    }
    result[selected] = bounded(descriptor.value, `${label}.${selected}`, 4 * 1024);
  }
  return result;
}

function runtimeProviderRequestFields(value: unknown, label: string): RuntimeProviderRequestFields {
  const record = runtimeSessionRecord(
    value,
    ["messages", "tools", "maxOutputTokens", "reasoningEffort", "metadata"],
    label,
  );
  const messages = canonicalMessages(record.messages, `${label}.messages`);
  const tools = runtimeProviderTools(record.tools, `${label}.tools`);
  if (
    record.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(record.maxOutputTokens) || (record.maxOutputTokens as number) < 1)
  ) throw new Error(`${label}.maxOutputTokens is invalid`);
  if (record.reasoningEffort !== undefined && typeof record.reasoningEffort !== "string") {
    throw new Error(`${label}.reasoningEffort is invalid`);
  }
  return {
    messages,
    tools,
    ...(record.maxOutputTokens === undefined ? {} : { maxOutputTokens: record.maxOutputTokens as number }),
    ...(record.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: bounded(record.reasoningEffort as string, `${label}.reasoningEffort`, 128) }),
    ...(record.metadata === undefined ? {} : { metadata: runtimeProviderMetadata(record.metadata, `${label}.metadata`) }),
  };
}

function applyRuntimeProviderRequestPatch(
  current: RuntimeProviderRequestFields,
  value: unknown,
): RuntimeProviderRequestFields {
  const patch = runtimeSessionRecord(
    value,
    ["messages", "tools", "maxOutputTokens", "reasoningEffort", "metadata"],
    "Runtime before_provider_request result",
  );
  const tools = patch.tools === undefined
    ? current.tools
    : runtimeProviderTools(patch.tools, "Runtime before_provider_request tools");
  const availableTools = new Set(current.tools.map((tool) => tool.name));
  const unknownTools = tools.filter((tool) => !availableTools.has(tool.name)).map((tool) => tool.name);
  if (unknownTools.length > 0) {
    throw new Error(`Runtime before_provider_request tools contain unavailable names: ${unknownTools.join(", ")}`);
  }
  const next: RuntimeProviderRequestFields = {
    messages: patch.messages === undefined
      ? current.messages
      : canonicalMessages(patch.messages, "Runtime before_provider_request messages"),
    tools,
    ...(patch.maxOutputTokens === null
      ? {}
      : patch.maxOutputTokens === undefined
        ? current.maxOutputTokens === undefined ? {} : { maxOutputTokens: current.maxOutputTokens }
        : { maxOutputTokens: patch.maxOutputTokens as number }),
    ...(patch.reasoningEffort === null
      ? {}
      : patch.reasoningEffort === undefined
        ? current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort }
        : { reasoningEffort: patch.reasoningEffort as string }),
    ...(patch.metadata === null
      ? {}
      : patch.metadata === undefined
        ? current.metadata === undefined ? {} : { metadata: current.metadata }
        : { metadata: patch.metadata as Record<string, string> }),
  };
  return runtimeProviderRequestFields(next, "Runtime before_provider_request request");
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

async function withAbort<T>(value: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return await value;
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(abortError(signal));
    signal.addEventListener("abort", aborted, { once: true });
    value.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

async function runRuntimeCleanupPhase(
  cleanups: readonly (() => void | Promise<void>)[],
  timeoutMs: number,
  label: string,
): Promise<Error[]> {
  if (cleanups.length === 0) return [];
  const signal = AbortSignal.timeout(timeoutMs);
  const outcomes: Array<{ cause?: unknown } | undefined> = Array.from({ length: cleanups.length });
  const pending = cleanups.map(async (cleanup, index) => {
    try {
      await Promise.resolve().then(cleanup);
      outcomes[index] = {};
    } catch (cause) {
      outcomes[index] = { cause };
    }
  });
  let timedOut = false;
  try {
    await withAbort(Promise.all(pending), signal);
  } catch (cause) {
    if (!signal.aborted) throw cause;
    timedOut = true;
  }
  const failures = outcomes.flatMap((outcome) => outcome?.cause === undefined
    ? []
    : [new Error(
        `${label} failed: ${defaultSecretRedactor.redact(error(outcome.cause).message).slice(0, 4096)}`,
        { cause: outcome.cause },
      )]);
  if (timedOut) {
    const remaining = outcomes.filter((outcome) => outcome === undefined).length;
    failures.push(new Error(
      `${label} timed out after ${timeoutMs}ms${remaining === 0 ? "" : ` with ${remaining} cleanup callback(s) still pending`}`,
      { cause: abortError(signal) },
    ));
  }
  return failures;
}

function onceRuntimeCleanup(cleanup: () => void | Promise<void>): () => Promise<void> {
  let flight: Promise<void> | undefined;
  return async () => {
    flight ??= Promise.resolve().then(cleanup);
    await flight;
  };
}

function validateResult(result: ToolResult): ToolResult {
  if (result === null || typeof result !== "object" || typeof result.content !== "string" || typeof result.isError !== "boolean") {
    throw new Error("Runtime tool returned an invalid result");
  }
  bounded(result.content, "Runtime tool output", 16 * 1024 * 1024);
  if (result.status !== undefined && !["success", "warning", "error"].includes(result.status)) {
    throw new Error("Runtime tool status must be success, warning, or error");
  }
  if (result.summary !== undefined) {
    if (typeof result.summary !== "string" || result.summary.trim() === "") {
      throw new Error("Runtime tool summary must be a non-empty string");
    }
    bounded(result.summary, "Runtime tool summary", 1024);
  }
  if (result.nextActions !== undefined) {
    if (!Array.isArray(result.nextActions) || result.nextActions.length > 8) {
      throw new Error("Runtime tool nextActions must contain at most 8 strings");
    }
    for (const [index, action] of result.nextActions.entries()) {
      if (typeof action !== "string" || action.trim() === "") {
        throw new Error(`Runtime tool nextActions[${index}] must be a non-empty string`);
      }
      bounded(action, `Runtime tool nextActions[${index}]`, 1024);
    }
  }
  if (result.terminate !== undefined && typeof result.terminate !== "boolean") {
    throw new Error("Runtime tool terminate hint must be boolean");
  }
  if (result.metadata !== undefined && !isJsonValue(result.metadata)) throw new Error("Runtime tool metadata is not JSON-safe");
  return result;
}

class RuntimeHarnessTool implements HarnessTool {
  readonly definition;
  readonly executionMode;
  readonly #registration: RuntimeToolRegistration;
  readonly #context: (context: ToolContext) => RuntimeToolContext;
  readonly #execute: (
    context: ToolContext,
    operation: () => ToolResult | Promise<ToolResult>,
  ) => Promise<ToolResult>;

  constructor(
    registration: RuntimeToolRegistration,
    context: (context: ToolContext) => RuntimeToolContext,
    execute: (
      context: ToolContext,
      operation: () => ToolResult | Promise<ToolResult>,
    ) => Promise<ToolResult>,
  ) {
    this.#registration = registration;
    this.#context = context;
    this.#execute = execute;
    this.definition = {
      name: registration.name,
      description: registration.description,
      inputSchema: registration.inputSchema,
      ...(registration.loading === undefined ? {} : { loading: registration.loading }),
      ...(registration.promptSnippet === undefined ? {} : { promptSnippet: registration.promptSnippet }),
      ...(registration.promptGuidelines === undefined ? {} : {
        promptGuidelines: [...registration.promptGuidelines],
      }),
    };
    this.executionMode = registration.executionMode ?? "parallel";
  }

  prepareInput(input: JsonValue, context: ToolContext): JsonValue | Promise<JsonValue> {
    return this.#registration.prepareInput === undefined
      ? input
      : this.#registration.prepareInput(input, context);
  }

  validate(input: JsonValue): void {
    assertSchema(this.#registration.inputSchema, input);
    this.#registration.validate?.(input);
  }

  resources(input: JsonValue, context: ToolContext): ResourceClaim[] | Promise<ResourceClaim[]> {
    return this.#registration.resources?.(input, context) ?? [];
  }

  async execute(input: JsonValue, context: ToolContext): Promise<ToolResult> {
    return validateResult(await this.#execute(
      context,
      () => this.#registration.execute(input, this.#context(context)),
    ));
  }
}

function activation(
  entry: ExtensionRuntimeEntry,
  workspace: string,
  dataPaths: RuntimeExtensionDataPaths,
  host: RuntimeExtensionHost,
): { staged: StagedActivation; api: RuntimeExtensionApi } {
  const generation = { active: true, abortController: new AbortController(), entry, dataPaths };
  const staged: StagedActivation = {
    entry,
    generation,
    committed: false,
    tools: [],
    commands: [],
    shortcuts: [],
    flags: [],
    flagDefaults: new Map(),
    providers: [],
    providerOverrides: [],
    providerOverlays: [],
    providerWires: [],
    providerAuth: [],
    toolRenderers: [],
    sessionRenderers: [],
    listeners: [],
    sharedListeners: [],
    autocompleteProviders: [],
    editorMiddleware: [],
    editorRenderers: [],
    disposers: [],
    moduleDisposers: [],
    ui: [],
    advancedUi: [],
  };
  const assertActive = (): void => {
    if (!generation.active) throw new Error(`Runtime extension context is no longer active: ${entry.extensionId}`);
  };
  const applyUi = (operation: RuntimeInitialUiOperation): void => {
    if (staged.committed) host.applyUi(operation);
    else {
      if (staged.ui.length >= MAX_RUNTIME_INITIAL_UI_OPERATIONS) {
        throw new Error(`Runtime extension initial UI exceeds ${MAX_RUNTIME_INITIAL_UI_OPERATIONS} operations`);
      }
      staged.ui.push(operation);
    }
  };
  const assertAdvancedUi = (): void => {
    assertActive();
    if (entry.trusted !== true || entry.permissions?.advancedUi !== true) {
      throw new Error(
        `Advanced UI requires a trusted manifest with permissions.advancedUi enabled: ${entry.extensionId}`,
      );
    }
  };
  const applyAdvancedUi = (operation: RuntimeAdvancedUiOperation): void => {
    if (staged.committed) host.applyAdvancedUi(operation);
    else {
      if (staged.advancedUi.length >= MAX_RUNTIME_INITIAL_UI_OPERATIONS) {
        throw new Error(`Runtime extension initial advanced UI exceeds ${MAX_RUNTIME_INITIAL_UI_OPERATIONS} operations`);
      }
      staged.advancedUi.push(operation);
    }
  };
  let advancedObserverSequence = 0;
  const advanced: RuntimeAdvancedUiApi = {
    setComponent(slotValue, componentKey, factory) {
      assertAdvancedUi();
      const slot = advancedUiSlot(slotValue);
      const selectedKey = key(componentKey, "Advanced UI component key");
      if (factory !== undefined && typeof factory !== "function") {
        throw new TypeError("Advanced UI component factory must be a function or undefined");
      }
      applyAdvancedUi({
        extensionId: entry.extensionId,
        signal: generation.abortController.signal,
        type: "component",
        slot,
        key: selectedKey,
        ...(factory === undefined ? {} : { factory }),
      });
    },
    setWorkingIndicator(value) {
      assertAdvancedUi();
      applyAdvancedUi({
        extensionId: entry.extensionId,
        signal: generation.abortController.signal,
        type: "working_indicator",
        ...(value === undefined ? {} : { value: advancedUiWorkingIndicator(value) }),
      });
    },
    setHiddenReasoningLabel(value) {
      assertAdvancedUi();
      let selected: string | undefined;
      if (value !== undefined) {
        if (typeof value !== "string" || value.trim() === "") {
          throw new TypeError("Advanced UI hidden reasoning label must be a non-empty string");
        }
        selected = bounded(value, "Advanced UI hidden reasoning label", 64);
      }
      applyAdvancedUi({
        extensionId: entry.extensionId,
        signal: generation.abortController.signal,
        type: "hidden_reasoning_label",
        ...(selected === undefined ? {} : { value: selected }),
      });
    },
    getToolOutputExpanded() {
      assertAdvancedUi();
      return host.getAdvancedUiToolOutputExpanded(staged.entry, staged.generation);
    },
    setToolOutputExpanded(expanded) {
      assertAdvancedUi();
      if (expanded !== undefined && typeof expanded !== "boolean") {
        throw new TypeError("Advanced UI tool output expansion must be boolean or undefined");
      }
      applyAdvancedUi({
        extensionId: entry.extensionId,
        signal: generation.abortController.signal,
        type: "tool_output_expanded",
        ...(expanded === undefined ? {} : { expanded }),
      });
    },
    observeKeys(observer) {
      assertAdvancedUi();
      if (typeof observer !== "function") throw new TypeError("Advanced UI key observer must be a function");
      const observerKey = `observer.${++advancedObserverSequence}`;
      const registration: RuntimeAdvancedUiOperation = {
        extensionId: entry.extensionId,
        signal: generation.abortController.signal,
        type: "key_observer",
        key: observerKey,
        observer,
      };
      applyAdvancedUi(registration);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        if (!generation.active) return;
        if (!staged.committed) {
          const index = staged.advancedUi.indexOf(registration);
          if (index >= 0) staged.advancedUi.splice(index, 1);
          return;
        }
        applyAdvancedUi({
          extensionId: entry.extensionId,
          signal: generation.abortController.signal,
          type: "key_observer",
          key: observerKey,
        });
      };
    },
  };
  const ui = {
    setStatus(statusKey: string, value?: string) {
      assertActive();
      applyUi({ extensionId: entry.extensionId, type: "status", key: key(statusKey, "Status key"), value: bounded(value ?? "", "Status") });
    },
    setWidget(widgetKey: string, value?: string) {
      assertActive();
      applyUi({ extensionId: entry.extensionId, type: "widget", key: key(widgetKey, "Widget key"), value: bounded(value ?? "", "Widget") });
    },
    setHeader(headerKey: string, value?: string) {
      assertActive();
      applyUi({ extensionId: entry.extensionId, type: "header", key: key(headerKey, "Header key"), value: bounded(value ?? "", "Header") });
    },
    setFooter(footerKey: string, value?: string) {
      assertActive();
      applyUi({ extensionId: entry.extensionId, type: "footer", key: key(footerKey, "Footer key"), value: bounded(value ?? "", "Footer") });
    },
    setWorkingMessage(value?: string) {
      assertActive();
      applyUi({ extensionId: entry.extensionId, type: "working_message", value: bounded(value ?? "", "Working message", 4 * 1024) });
    },
    setWorkingVisible(visible?: boolean) {
      assertActive();
      if (visible !== undefined && typeof visible !== "boolean") throw new Error("Working visibility must be boolean or undefined");
      applyUi({ extensionId: entry.extensionId, type: "working_visible", value: "", ...(visible === undefined ? {} : { visible }) });
    },
    setTitle(value: string) {
      assertActive();
      applyUi({ extensionId: entry.extensionId, type: "title", value: bounded(value, "Title", 1024) });
    },
    notify(message: string, kind: RuntimeUiNoticeKind = "status") {
      assertActive();
      applyUi({ extensionId: entry.extensionId, type: "notify", value: bounded(message, "Notification"), kind });
    },
    registerAutocompleteProvider(provider: RuntimeAutocompleteProvider) {
      assertActive();
      if (typeof provider !== "function") throw new Error("Runtime autocomplete provider must be a function");
      if (staged.committed) host.registerLiveAutocompleteProvider(staged.entry, staged.generation, provider);
      else {
        if (staged.autocompleteProviders.length >= MAX_RUNTIME_AUTOCOMPLETE_PROVIDERS) throw new Error("Runtime autocomplete provider limit exceeded");
        staged.autocompleteProviders.push(provider);
      }
    },
    registerEditorMiddleware(middleware: RuntimeEditorMiddleware) {
      assertActive();
      if (typeof middleware !== "function") throw new Error("Runtime editor middleware must be a function");
      if (staged.committed) host.registerLiveEditorMiddleware(staged.entry, staged.generation, middleware);
      else {
        if (staged.editorMiddleware.length >= MAX_RUNTIME_EDITOR_MIDDLEWARE) throw new Error("Runtime editor middleware limit exceeded");
        staged.editorMiddleware.push(middleware);
      }
    },
    advanced,
  };
  const auth = {
    async fetch(
      provider: string,
      input: string | URL | Request,
      init?: RequestInit,
      signal?: AbortSignal,
    ): Promise<Response> {
      assertActive();
      if (!AUTH_PROVIDER.test(provider)) throw new Error("Provider ID is invalid");
      signal?.throwIfAborted();
      return host.fetchProvider(staged.entry, staged.generation, provider, input, init, signal);
    },
  };
  const events = {
    on(topicValue: string, listener: RuntimeSharedEventListener): void {
      assertActive();
      const topic = key(topicValue, "Shared event topic");
      if (typeof listener !== "function") throw new Error("Shared event listener must be a function");
      if (staged.committed) host.registerLiveSharedListener(staged.entry, staged.generation, topic, listener);
      else staged.sharedListeners.push({ topic, listener });
    },
    async emit(topicValue: string, payload: JsonValue, signal?: AbortSignal): Promise<void> {
      assertActive();
      const topic = key(topicValue, "Shared event topic");
      if (!isJsonValue(payload)) throw new Error("Shared event payload must be JSON-safe");
      await host.dispatchShared(staged.entry, staged.generation, topic, payload, signal);
    },
  };
  const session = {
    async appendState(input: RuntimeExtensionStateAppendInput): Promise<RuntimeExtensionStateRecord> {
      assertActive();
      return await host.appendExtensionState(staged.entry, staged.generation, input);
    },
    async compareAndAppendState(input: RuntimeExtensionStateCompareAndAppendInput): Promise<RuntimeExtensionStateCompareAndAppendResult> {
      assertActive();
      return await host.compareAndAppendExtensionState(staged.entry, staged.generation, input);
    },
    async readState(input: RuntimeExtensionStateReadInput): Promise<RuntimeExtensionStateRecord | undefined> {
      assertActive();
      return await host.readExtensionState(staged.entry, staged.generation, input);
    },
    async appendMessage(input: RuntimeExtensionMessageAppendInput): Promise<RuntimeExtensionMessageRecord> {
      assertActive();
      return await host.appendExtensionMessage(staged.entry, staged.generation, input);
    },
    async readMessages(input: RuntimeExtensionMessagesReadInput): Promise<RuntimeExtensionMessageRecord[]> {
      assertActive();
      return await host.readExtensionMessages(staged.entry, staged.generation, input);
    },
    registerRenderers(schema: number, renderer: RuntimeExtensionSessionRenderer): void {
      assertActive();
      const version = validateExtensionSchemaVersion(schema);
      if (renderer === null || typeof renderer !== "object") throw new Error("Runtime session renderer must be an object");
      if (renderer.renderState !== undefined && typeof renderer.renderState !== "function") {
        throw new Error("Runtime session renderState must be a function");
      }
      if (renderer.renderMessage !== undefined && typeof renderer.renderMessage !== "function") {
        throw new Error("Runtime session renderMessage must be a function");
      }
      if (renderer.renderState === undefined && renderer.renderMessage === undefined) {
        throw new Error("Runtime session renderer must define renderState or renderMessage");
      }
      if (staged.committed) host.registerLiveSessionRenderer(staged.entry, staged.generation, version, renderer);
      else staged.sessionRenderers.push({ schemaVersion: version, renderer });
    },
  };
  const nativeUi: NativeUiHost = {
    extensionId: entry.extensionId,
    signal: generation.abortController.signal,
    onInput(handler) {
      assertActive();
      return host.nativeUi(staged.entry, staged.generation).onInput(handler);
    },
    getEditor() {
      assertActive();
      return host.nativeUi(staged.entry, staged.generation).getEditor();
    },
    replaceEditor(editor) {
      assertActive();
      return host.nativeUi(staged.entry, staged.generation).replaceEditor(editor);
    },
    wrapEditor(wrapper) {
      assertActive();
      return host.nativeUi(staged.entry, staged.generation).wrapEditor(wrapper);
    },
    mountHeader(factory) {
      assertActive();
      return host.nativeUi(staged.entry, staged.generation).mountHeader(factory);
    },
    mountFooter(factory) {
      assertActive();
      return host.nativeUi(staged.entry, staged.generation).mountFooter(factory);
    },
    mountWidget(factory, placement) {
      assertActive();
      return host.nativeUi(staged.entry, staged.generation).mountWidget(factory, placement);
    },
    replaceHeader(factory) {
      assertActive();
      return host.nativeUi(staged.entry, staged.generation).replaceHeader(factory);
    },
    replaceFooter(factory) {
      assertActive();
      return host.nativeUi(staged.entry, staged.generation).replaceFooter(factory);
    },
    currentTheme() {
      assertActive();
      return host.nativeUi(staged.entry, staged.generation).currentTheme();
    },
    themeCatalog() {
      assertActive();
      return host.nativeUi(staged.entry, staged.generation).themeCatalog();
    },
    applyTheme(theme) {
      assertActive();
      return host.nativeUi(staged.entry, staged.generation).applyTheme(theme);
    },
    pasteToEditor(value) {
      assertActive();
      host.nativeUi(staged.entry, staged.generation).pasteToEditor(value);
    },
    wrapAutocomplete(wrapper) {
      assertActive();
      return host.nativeUi(staged.entry, staged.generation).wrapAutocomplete(wrapper);
    },
    dispose() {
      assertActive();
      host.disposeNativeUi(staged.entry, staged.generation);
    },
  };
  const unsafeTerminal: UnsafeTerminalHost = {
    extensionId: entry.extensionId,
    signal: generation.abortController.signal,
    onInput(handler) {
      assertActive();
      return host.unsafeTerminal(staged.entry, staged.generation).onInput(handler);
    },
    write(data) {
      assertActive();
      host.unsafeTerminal(staged.entry, staged.generation).write(data);
    },
    requestRender() {
      assertActive();
      host.unsafeTerminal(staged.entry, staged.generation).requestRender();
    },
    size() {
      assertActive();
      return host.unsafeTerminal(staged.entry, staged.generation).size();
    },
    capabilities() {
      assertActive();
      return host.unsafeTerminal(staged.entry, staged.generation).capabilities();
    },
    keybindings() {
      assertActive();
      return host.unsafeTerminal(staged.entry, staged.generation).keybindings();
    },
    dispose() {
      assertActive();
      host.disposeUnsafeTerminal(staged.entry, staged.generation);
    },
  };
  const native: RuntimeNativeExtensionApi = {
    ui: nativeUi,
    terminal: unsafeTerminal,
    session: {
      async read(input) {
        assertActive();
        return await host.readNativeSession(staged.entry, staged.generation, input);
      },
      async getSystemPrompt(target) {
        assertActive();
        return await host.getNativeSystemPrompt(staged.entry, staged.generation, target);
      },
    },
    credentials: {
      async resolve(provider, signal) {
        assertActive();
        return await host.resolveNativeCredential(staged.entry, staged.generation, provider, signal);
      },
    },
    providers: {
      override(provider) {
        assertActive();
        if (entry.trusted !== true || entry.permissions?.providerOverride !== true) {
          throw new Error(`Provider override requires a trusted manifest with permissions.providerOverride enabled: ${entry.extensionId}`);
        }
        key(provider.id, "Provider ID");
        if (typeof provider.stream !== "function" || typeof provider.listModels !== "function") {
          throw new Error("Runtime provider override is invalid");
        }
        const token = Symbol(provider.id);
        if (staged.committed) return host.registerLiveProviderOverride(staged.entry, staged.generation, provider, token);
        staged.providerOverrides.push({ token, provider });
        let disposed = false;
        return async () => {
          if (disposed) return;
          disposed = true;
          if (!staged.committed) {
            const index = staged.providerOverrides.findIndex((candidate) => candidate.token === token);
            if (index >= 0) staged.providerOverrides.splice(index, 1);
            return;
          }
          await host.unregisterLiveProviderOverride(staged.entry, staged.generation, token);
        };
      },
      overlay(value) {
        assertActive();
        if (entry.trusted !== true || entry.permissions?.providerOverride !== true) {
          throw new Error(`Provider overlay requires a trusted manifest with permissions.providerOverride enabled: ${entry.extensionId}`);
        }
        const overlay = runtimeProviderOverlay(value);
        const token = Symbol(overlay.id);
        if (staged.committed) return host.registerLiveProviderOverlay(staged.entry, staged.generation, overlay, token);
        staged.providerOverlays.push({ token, overlay });
        let disposed = false;
        return async () => {
          if (disposed) return;
          disposed = true;
          if (!staged.committed) {
            const index = staged.providerOverlays.findIndex((candidate) => candidate.token === token);
            if (index >= 0) staged.providerOverlays.splice(index, 1);
            return;
          }
          await host.unregisterLiveProviderOverlay(staged.entry, staged.generation, token);
        };
      },
      intercept(providerValue, interceptor) {
        assertActive();
        if (entry.trusted !== true || entry.permissions?.providerWire !== true) {
          throw new Error(`Provider wire interception requires a trusted manifest with permissions.providerWire enabled: ${entry.extensionId}`);
        }
        if (typeof providerValue !== "string" || !AUTH_PROVIDER.test(providerValue)) {
          throw new Error("Runtime provider wire target is invalid");
        }
        if (
          interceptor === null || typeof interceptor !== "object" || Array.isArray(interceptor) ||
          (interceptor.interceptRequest !== undefined && typeof interceptor.interceptRequest !== "function") ||
          (interceptor.observeResponse !== undefined && typeof interceptor.observeResponse !== "function") ||
          (interceptor.interceptRequest === undefined && interceptor.observeResponse === undefined)
        ) throw new Error("Runtime provider wire interceptor is invalid");
        const token = Symbol(providerValue);
        if (staged.committed) {
          return host.registerLiveProviderWire(staged.entry, staged.generation, providerValue, interceptor, token);
        }
        staged.providerWires.push({ token, provider: providerValue, interceptor });
        let disposed = false;
        return async () => {
          if (disposed) return;
          disposed = true;
          if (!staged.committed) {
            const index = staged.providerWires.findIndex((candidate) => candidate.token === token);
            if (index >= 0) staged.providerWires.splice(index, 1);
            return;
          }
          await host.unregisterLiveProviderWire(staged.entry, staged.generation, token);
        };
      },
    },
    host: {
      async getConfiguration(signal) {
        assertActive();
        return await host.getNativeHostConfiguration(staged.entry, staged.generation, signal);
      },
      async updateConfiguration(input) {
        assertActive();
        return await host.updateNativeHostConfiguration(staged.entry, staged.generation, input);
      },
    },
  };
  const api: RuntimeExtensionApi = {
    extensionId: entry.extensionId,
    workspace,
    dataPaths,
    signal: generation.abortController.signal,
    registerTool(tool) {
      assertActive();
      key(tool.name, "Tool name");
      bounded(tool.description, "Tool description", 16 * 1024);
      if (tool.promptSnippet !== undefined) {
        if (typeof tool.promptSnippet !== "string" || tool.promptSnippet.trim() === "") {
          throw new Error("Runtime tool promptSnippet must be a non-empty string");
        }
        bounded(tool.promptSnippet, "Runtime tool promptSnippet", 4 * 1024);
      }
      if (tool.loading !== undefined && tool.loading !== "eager" && tool.loading !== "deferred") {
        throw new Error("Runtime tool loading mode is invalid");
      }
      const promptGuidelines = runtimePromptGuidelines(tool.promptGuidelines);
      if (tool.inputSchema === null || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema) || !isJsonValue(tool.inputSchema)) {
        throw new Error("Runtime tool inputSchema must be a JSON object");
      }
      if (tool.prepareInput !== undefined && typeof tool.prepareInput !== "function") {
        throw new Error("Runtime tool prepareInput must be a function");
      }
      if (tool.executionMode !== undefined && !["parallel", "sequential"].includes(tool.executionMode)) {
        throw new Error("Runtime tool executionMode is invalid");
      }
      if (tool.validate !== undefined && typeof tool.validate !== "function") throw new Error("Runtime tool validate must be a function");
      if (tool.resources !== undefined && typeof tool.resources !== "function") throw new Error("Runtime tool resources must be a function");
      if (typeof tool.execute !== "function") throw new Error("Runtime tool execute must be a function");
      const registration = {
        ...tool,
        ...(promptGuidelines === undefined ? {} : { promptGuidelines }),
      };
      if (staged.committed) host.registerLiveTool(staged.entry, staged.generation, registration);
      else staged.tools.push(registration);
    },
    registerCommand(command) {
      assertActive();
      if (!COMMAND.test(command.name)) throw new Error("Runtime command name is invalid");
      if (typeof command.execute !== "function") throw new Error("Runtime command execute must be a function");
      if (command.getArgumentCompletions !== undefined && typeof command.getArgumentCompletions !== "function") {
        throw new Error("Runtime command getArgumentCompletions must be a function");
      }
      if (command.description !== undefined) bounded(command.description, "Command description", 4 * 1024);
      if (command.argumentHint !== undefined) bounded(command.argumentHint, "Command argument hint", 512);
      if (staged.committed) host.registerLiveCommand(staged.entry, staged.generation, command);
      else staged.commands.push(command);
    },
    registerShortcut(shortcut) {
      assertActive();
      if (typeof shortcut.execute !== "function") throw new Error("Runtime shortcut execute must be a function");
      const normalized = normalizeShortcut(shortcut.shortcut);
      if (shortcut.description !== undefined) bounded(shortcut.description, "Runtime shortcut description", 4 * 1024);
      const registration = { ...shortcut, shortcut: normalized };
      if (staged.committed) host.registerLiveShortcut(staged.entry, staged.generation, registration);
      else staged.shortcuts.push(registration);
    },
    registerFlag(flag) {
      assertActive();
      const registration = validateFlag(flag);
      if (staged.committed) host.registerLiveFlag(staged.entry, staged.generation, registration);
      else {
        staged.flags.push(registration);
        if (
          registration.default !== undefined &&
          host.flagValueForActivation(registration.name) === undefined &&
          !staged.flagDefaults.has(registration.name)
        ) {
          staged.flagDefaults.set(registration.name, registration.default);
        }
      }
    },
    getFlag(name) {
      assertActive();
      if (!FLAG.test(name)) return undefined;
      const stagedFlag = staged.flags.findLast((flag) => flag.name === name);
      if (!staged.committed) {
        if (stagedFlag === undefined) return undefined;
        return host.flagValueForActivation(name) ?? staged.flagDefaults.get(name);
      }
      return host.flagValue(staged.entry, staged.generation, name);
    },
    async getActiveTools(target) {
      assertActive();
      return await host.getActiveTools(staged.entry, staged.generation, target);
    },
    async getAllTools(target) {
      assertActive();
      return await host.getAllTools(staged.entry, staged.generation, target);
    },
    getCommands() {
      assertActive();
      return host.getCommands(staged.entry, staged.generation);
    },
    async getResourceCatalog(signal) {
      assertActive();
      return await host.getResourceCatalog(staged.entry, staged.generation, signal);
    },
    async getDiscoveryView(signal) {
      assertActive();
      return await host.getDiscoveryView(staged.entry, staged.generation, signal);
    },
    async listSessions(input = {}) {
      assertActive();
      return await host.listSessions(staged.entry, staged.generation, input);
    },
    async getTranscript(input) {
      assertActive();
      return await host.getTranscript(staged.entry, staged.generation, input);
    },
    async getSessionUsage(input) {
      assertActive();
      return await host.getSessionUsage(staged.entry, staged.generation, input);
    },
    async getSystemPromptSnapshot(input) {
      assertActive();
      return await host.getSystemPromptSnapshot(staged.entry, staged.generation, input);
    },
    async setActiveTools(input) {
      assertActive();
      return await host.setActiveTools(staged.entry, staged.generation, input);
    },
    async setSessionName(input) {
      assertActive();
      return await host.setSessionName(staged.entry, staged.generation, input);
    },
    async setEntryLabel(input) {
      assertActive();
      return await host.setEntryLabel(staged.entry, staged.generation, input);
    },
    async sendUserMessage(input) {
      assertActive();
      return await host.sendUserMessage(staged.entry, staged.generation, input);
    },
    async sendMessage(input) {
      assertActive();
      return await host.appendExtensionMessage(staged.entry, staged.generation, input);
    },
    async abort(input) {
      assertActive();
      return await host.cancelSession(staged.entry, staged.generation, input);
    },
    async compact(input) {
      assertActive();
      return await host.compactSession(staged.entry, staged.generation, input);
    },
    async runChild(input) {
      assertActive();
      return await host.runChild(staged.entry, staged.generation, input);
    },
    async reload(input = undefined) {
      assertActive();
      return await host.reload(staged.entry, staged.generation, input);
    },
    async requestShutdown(input = {}) {
      assertActive();
      return await host.requestShutdown(staged.entry, staged.generation, input);
    },
    async newSession(input = {}) {
      assertActive();
      return await host.createSession(staged.entry, staged.generation, input);
    },
    async forkSession(input) {
      assertActive();
      return await host.forkSession(staged.entry, staged.generation, input);
    },
    async switchSession(input) {
      assertActive();
      return await host.switchSession(staged.entry, staged.generation, input);
    },
    async getSession(input) {
      assertActive();
      return await host.inspectSession(staged.entry, staged.generation, input);
    },
    async waitForIdle(input) {
      assertActive();
      await host.waitForIdle(staged.entry, staged.generation, input);
    },
    async getSessionTree(input) {
      assertActive();
      return await host.sessionTree(staged.entry, staged.generation, input);
    },
    async navigateSessionTree(input) {
      assertActive();
      return await host.navigateSession(staged.entry, staged.generation, input);
    },
    async getModel(input) {
      assertActive();
      return await host.getModel(staged.entry, staged.generation, input);
    },
    async setModel(input) {
      assertActive();
      return await host.setModel(staged.entry, staged.generation, input);
    },
    async setThinkingLevel(input) {
      assertActive();
      return await host.setThinking(staged.entry, staged.generation, input);
    },
    async exec(input) {
      assertActive();
      return await host.exec(staged.entry, staged.generation, input);
    },
    registerProvider(provider) {
      assertActive();
      key(provider.id, "Provider ID");
      if (typeof provider.stream !== "function" || typeof provider.listModels !== "function") throw new Error("Runtime provider is invalid");
      let dispose: () => Promise<void>;
      if (staged.committed) dispose = host.registerLiveProvider(staged.entry, staged.generation, provider);
      else {
        staged.providers.push(provider);
        let disposed = false;
        dispose = async () => {
          if (disposed) return;
          disposed = true;
          if (!staged.committed) {
            const index = staged.providers.indexOf(provider);
            if (index >= 0) staged.providers.splice(index, 1);
            for (let authIndex = staged.providerAuth.length - 1; authIndex >= 0; authIndex -= 1) {
              if (staged.providerAuth[authIndex]?.provider === provider.id) staged.providerAuth.splice(authIndex, 1);
            }
            return;
          }
          await host.unregisterLiveProvider(staged.entry, staged.generation, provider);
        };
      }
      let settled = false;
      return async () => {
        if (settled) return;
        await dispose();
        settled = true;
      };
    },
    registerProviderAuth(descriptor) {
      assertActive();
      const normalized = normalizeProviderAuthDescriptor(descriptor);
      host.assertProviderAuthRegistration(staged.entry, staged.generation, normalized);
      if (staged.committed) host.registerLiveProviderAuth(staged.entry, staged.generation, normalized);
      else staged.providerAuth.push(normalized);
    },
    registerToolRenderer(name, renderer) {
      assertActive();
      key(name, "Tool renderer name");
      if (renderer === null || typeof renderer !== "object") throw new Error("Runtime tool renderer must be an object");
      if (renderer.renderCall !== undefined && typeof renderer.renderCall !== "function") throw new Error("Runtime tool renderCall must be a function");
      if (renderer.renderResult !== undefined && typeof renderer.renderResult !== "function") throw new Error("Runtime tool renderResult must be a function");
      if (renderer.renderCall === undefined && renderer.renderResult === undefined) throw new Error("Runtime tool renderer must define renderCall or renderResult");
      if (staged.committed) host.registerLiveToolRenderer(staged.entry, staged.generation, name, renderer);
      else staged.toolRenderers.push({ name, renderer });
    },
    registerEditorRenderer(renderer) {
      assertActive();
      if (renderer === null || typeof renderer !== "object" || typeof renderer.render !== "function") {
        throw new Error("Runtime editor renderer must define render");
      }
      if (staged.committed) host.registerLiveEditorRenderer(staged.entry, staged.generation, renderer);
      else {
        if (staged.editorRenderers.length > 0) throw new Error("Runtime extension registered a duplicate editor renderer");
        staged.editorRenderers.push(renderer);
      }
    },
    on(event, listener) {
      assertActive();
      if (![
        "resources_discover", "project_trust", "session_start", "session_info_changed", "session_end", "session_shutdown", "session_before_switch", "session_before_fork", "session_before_tree",
        "session_tree", "session_before_compact", "session_compact", "before_agent_start", "agent_start", "agent_end",
        "agent_settled", "turn_start", "turn_end", "message_start", "message_update", "message_end",
        "tool_execution_start", "tool_execution_update", "tool_execution_end", "tool_call", "tool_result", "context",
        "input", "model_select", "thinking_level_select", "before_provider_request", "after_provider_response",
        "before_user_shell", "user_shell", "theme_change", "event",
      ].includes(event)) throw new Error(`Unknown runtime event: ${event}`);
      if (typeof listener !== "function") throw new Error("Runtime listener must be a function");
      const registered = listener as unknown as RuntimeExtensionListener<RuntimeExtensionEvent>;
      if (staged.committed) host.registerLiveListener(staged.entry, staged.generation, event, registered);
      else staged.listeners.push({ event, listener: registered });
    },
    onDispose(dispose) {
      assertActive();
      if (typeof dispose !== "function") throw new Error("Runtime disposer must be a function");
      if (staged.committed) host.registerLiveDisposer(dispose);
      else staged.disposers.push(dispose);
    },
    ui,
    auth,
    events,
    session,
    native,
  };
  return {
    staged,
    api: Object.freeze({
      ...api,
      ui: Object.freeze({ ...ui, advanced: Object.freeze(advanced) }),
      auth: Object.freeze(auth),
      events: Object.freeze(events),
      session: Object.freeze(session),
      native: Object.freeze({
        ui: Object.freeze(native.ui),
        terminal: Object.freeze(native.terminal),
        session: Object.freeze(native.session),
        credentials: Object.freeze(native.credentials),
        providers: Object.freeze(native.providers),
        host: Object.freeze(native.host),
      }),
    }),
  };
}

export interface RuntimeExtensionHostOptions {
  /** Per cleanup phase. Host close uses separate notification, disposer, registration, and module phases. */
  shutdownTimeoutMs?: number;
  /** Aggregate bound for resources_discover when the caller does not supply a signal. */
  resourceDiscoveryTimeoutMs?: number;
  /** Root for extension-owned durable data; callers embedding the loader may override it. */
  dataRoot?: string;
  /** Initial callback mode; embedded/headless loaders use print semantics by default. */
  mode?: RuntimeExtensionMode;
  projectTrusted?: boolean;
}

export class RuntimeExtensionHost {
  readonly #workspace: string;
  readonly #dataRoot: string;
  readonly #shutdownTimeoutMs: number;
  readonly #resourceDiscoveryTimeoutMs: number;
  readonly #tools = new Map<string, HarnessTool>();
  readonly #toolOwners = new WeakMap<HarnessTool, Extract<RuntimeCatalogOwner, { kind: "extension" }>>();
  readonly #commands: OwnedCommand[] = [];
  readonly #autocompleteProviders: OwnedAutocompleteProvider[] = [];
  readonly #editorMiddleware: OwnedEditorMiddleware[] = [];
  readonly #editorRenderers: Array<OwnedRenderer<RuntimeEditorRenderer>> = [];
  readonly #shortcuts = new Map<string, OwnedShortcut>();
  readonly #flags = new Map<string, OwnedFlag>();
  readonly #flagValues = new Map<string, boolean | string>();
  readonly #providers = new Map<string, ProviderAdapter>();
  readonly #providerOverrides: OwnedProviderOverride[] = [];
  readonly #providerOverlays: OwnedProviderOverlay[] = [];
  readonly #providerWires: OwnedProviderWire[] = [];
  readonly #providerOwners = new Map<string, { entry: ExtensionRuntimeEntry; generation: RuntimeExtensionGeneration }>();
  readonly #providerCleanups = new Map<string, () => void | Promise<void>>();
  readonly #providerAuth = new Map<string, RuntimeProviderAuthDescription>();
  readonly #providerAuthCleanups = new Map<string, () => void | Promise<void>>();
  readonly #toolRenderers = new Map<string, OwnedRenderer<RuntimeToolRenderer>>();
  readonly #sessionRenderers = new Map<string, OwnedRenderer<RuntimeExtensionSessionRenderer>>();
  readonly #listeners = new Map<RuntimeExtensionEvent, OwnedListener[]>();
  readonly #sharedListeners = new Map<string, OwnedSharedListener[]>();
  readonly #disposers: Array<() => void | Promise<void>> = [];
  readonly #moduleDisposers: Array<() => void | Promise<void>> = [];
  readonly #initialUi: RuntimeInitialUiOperation[] = [];
  readonly #initialAdvancedUi: RuntimeAdvancedUiOperation[] = [];
  readonly #diagnostics: RuntimeExtensionDiagnostic[] = [];
  #diagnosticsTruncated = false;
  readonly #rendererFailureKeys = new Set<string>();
  readonly #generations: RuntimeExtensionGeneration[] = [];
  readonly #activeLifecycleListeners = new Map<RuntimeExtensionGeneration, number>();
  readonly #registrationCleanups: Array<() => void | Promise<void>> = [];
  readonly #changeListeners = new Set<(change: RuntimeExtensionChange) => void>();
  readonly #requesterThread = new AsyncLocalStorage<{ threadId: string }>();
  readonly #currentSystemPrompt = new AsyncLocalStorage<RuntimeNativeSystemPromptSnapshot>();
  readonly #systemPrompts = new Map<string, RuntimeNativeSystemPromptSnapshot>();
  readonly #nativeUiHosts = new Map<RuntimeExtensionGeneration, NativeUiHost>();
  readonly #unsafeTerminalHosts = new Map<RuntimeExtensionGeneration, UnsafeTerminalHost>();
  #liveRegistrationHandler: RuntimeLiveRegistrationHandler | undefined;
  #sessionHandler: RuntimeExtensionSessionHandler | undefined;
  #nativeHostHandler: RuntimeNativeHostHandler | undefined;
  #nativeUiHandler: ((extensionId: string, signal: AbortSignal) => NativeUiHost) | undefined;
  #unsafeTerminalHandler: ((extensionId: string, signal: AbortSignal) => UnsafeTerminalHost) | undefined;
  #uiHandler: ((operation: RuntimeInitialUiOperation) => void) | undefined;
  #advancedUiHandler: RuntimeAdvancedUiHostHandler | undefined;
  #interactiveUiHandler: RuntimeInteractiveUiHandler | undefined;
  #reloadHandler: RuntimeExtensionReloadHandler | undefined;
  #shutdownHandler: RuntimeExtensionShutdownHandler | undefined;
  #sessionFocusHandler: RuntimeExtensionSessionFocusHandler | undefined;
  #modelFocusHandler: RuntimeExtensionModelFocusHandler | undefined;
  #mode: RuntimeExtensionMode;
  #projectTrusted: boolean;
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(
    workspace: string,
    options: RuntimeExtensionHostOptions = {},
  ) {
    this.#workspace = resolve(workspace);
    this.#dataRoot = resolve(options.dataRoot ?? join(this.#workspace, ".rigyn", "state", "extension-data"));
    this.#mode = options.mode ?? "print";
    this.#projectTrusted = options.projectTrusted ?? false;
    const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_RUNTIME_EXTENSION_SHUTDOWN_TIMEOUT_MS;
    if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1 || shutdownTimeoutMs > 300_000) {
      throw new RangeError("Runtime extension shutdownTimeoutMs must be from 1 through 300000");
    }
    this.#shutdownTimeoutMs = shutdownTimeoutMs;
    const resourceDiscoveryTimeoutMs = options.resourceDiscoveryTimeoutMs ?? DEFAULT_RUNTIME_RESOURCE_DISCOVERY_TIMEOUT_MS;
    if (!Number.isSafeInteger(resourceDiscoveryTimeoutMs) || resourceDiscoveryTimeoutMs < 1 || resourceDiscoveryTimeoutMs > 300_000) {
      throw new RangeError("Runtime resourceDiscoveryTimeoutMs must be from 1 through 300000");
    }
    this.#resourceDiscoveryTimeoutMs = resourceDiscoveryTimeoutMs;
  }

  get workspace(): string {
    return this.#workspace;
  }

  get dataRoot(): string {
    return this.#dataRoot;
  }

  setHostContext(input: { mode?: RuntimeExtensionMode; projectTrusted?: boolean }): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    if (input.mode !== undefined) {
      if (!["tui", "rpc", "json", "print"].includes(input.mode)) throw new Error("Runtime extension host mode is invalid");
      this.#mode = input.mode;
    }
    if (input.projectTrusted !== undefined) {
      if (typeof input.projectTrusted !== "boolean") throw new Error("Runtime extension project trust must be a boolean");
      this.#projectTrusted = input.projectTrusted;
    }
  }

  tools(): HarnessTool[] {
    return [...this.#tools.values()];
  }

  toolOwner(tool: HarnessTool): Extract<RuntimeCatalogOwner, { kind: "extension" }> | undefined {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    const owner = this.#toolOwners.get(tool);
    return owner === undefined ? undefined : { ...owner };
  }

  providers(): ProviderAdapter[] {
    return [...this.#providers.values()];
  }

  extensions(): ExtensionRuntimeEntry[] {
    return this.#generations
      .filter((generation) => generation.active)
      .map((generation) => ({ ...generation.entry }));
  }

  providerAuth(): RuntimeProviderAuthDescription[] {
    return [...this.#providerAuth.values()].map((entry) => ({
      ...entry,
      descriptor: cloneProviderAuthDescriptor(entry.descriptor),
    }));
  }

  renderers(): RuntimeRendererDescription[] {
    return [
      ...[...this.#toolRenderers].map(([key, value]): RuntimeRendererDescription => ({
        extensionId: value.entry.extensionId,
        sourcePath: value.entry.sourcePath,
        kind: "tool",
        key,
      })),
      ...[...this.#sessionRenderers].map(([key, value]): RuntimeRendererDescription => ({
        extensionId: value.entry.extensionId,
        sourcePath: value.entry.sourcePath,
        kind: "session",
        key: key.slice(key.lastIndexOf("\0") + 1),
      })),
      ...this.#editorRenderers.filter((value) => value.generation.active).map((value): RuntimeRendererDescription => ({
        extensionId: value.entry.extensionId,
        sourcePath: value.entry.sourcePath,
        kind: "editor",
        key: "editor",
      })),
    ];
  }

  renderEditor(view: RuntimeEditorRenderView, context: RuntimeUiRenderContext): RuntimeUiBlock | undefined {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    if (view === null || typeof view !== "object" || typeof view.text !== "string" || typeof view.label !== "string") {
      throw new Error("Runtime editor render view is invalid");
    }
    bounded(view.text, "Runtime editor render text", 256 * 1024);
    bounded(view.label, "Runtime editor render label", 4 * 1024);
    const length = splitGraphemes(view.text).length;
    if (!Number.isSafeInteger(view.cursor) || view.cursor < 0 || view.cursor > length) {
      throw new Error("Runtime editor render cursor is invalid");
    }
    if ((view.mode !== "normal" && view.mode !== "follow_up") || typeof view.blocked !== "boolean") {
      throw new Error("Runtime editor render state is invalid");
    }
    const safeView = Object.freeze({
      text: view.text,
      cursor: view.cursor,
      label: sanitizeTerminalText(view.label).replaceAll("\n", " "),
      mode: view.mode,
      blocked: view.blocked,
    });
    const safeContext = sanitizeRuntimeUiRenderContext(context);
    for (const selected of [...this.#editorRenderers].reverse()) {
      if (!selected.generation.active) continue;
      const rendered = this.#renderBlock(selected, "editor", safeContext, (selectedContext) => {
        const value = selected.renderer.render(safeView, selectedContext);
        if (value !== undefined && value.cursor === undefined) {
          throw new Error("Runtime editor renderer must return a cursor");
        }
        return value;
      });
      if (rendered !== undefined) {
        return sanitizeRuntimeUiBlock(rendered, { width: safeContext.width, maxLines: safeContext.height });
      }
    }
    return undefined;
  }

  renderToolCall(name: string, view: RuntimeToolRenderView, context: RuntimeUiRenderContext): RuntimeUiBlock | undefined {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    const selected = this.#toolRenderers.get(name);
    if (selected?.renderer.renderCall === undefined) return undefined;
    return this.#renderBlock(selected, `tool call ${name}`, context, (safeContext) => selected.renderer.renderCall?.(
      Object.freeze(structuredClone(view)),
      safeContext,
    ));
  }

  renderToolResult(name: string, view: RuntimeToolRenderView, context: RuntimeUiRenderContext): RuntimeUiBlock | undefined {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    const selected = this.#toolRenderers.get(name);
    if (selected?.renderer.renderResult === undefined) return undefined;
    return this.#renderBlock(selected, `tool result ${name}`, context, (safeContext) => selected.renderer.renderResult?.(
      Object.freeze(structuredClone(view)),
      safeContext,
    ));
  }

  renderExtensionState(
    entry: RuntimeExtensionStateRecord,
    context: RuntimeUiRenderContext,
  ): RuntimeUiBlock {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    const safeEntry = canonicalRuntimeStateRecord(entry);
    const selected = this.#sessionRenderers.get(sessionRendererKey(safeEntry.extensionId, safeEntry.schemaVersion));
    const rendered = selected?.renderer.renderState === undefined
      ? undefined
      : this.#renderBlock(selected, `session state ${safeEntry.extensionId}@${safeEntry.schemaVersion}`, context, (safeContext) =>
        selected.renderer.renderState?.(Object.freeze(structuredClone(safeEntry)), safeContext));
    if (rendered !== undefined) return rendered;
    const safeContext = sanitizeRuntimeUiRenderContext(context);
    return sanitizeRuntimeUiBlock({
      lines: [{ spans: [{ text: `${safeEntry.extensionId}@${safeEntry.schemaVersion}/${safeEntry.key}`, role: "muted" }] }],
    }, { width: safeContext.width });
  }

  renderExtensionMessage(
    entry: RuntimeExtensionMessageRecord,
    context: RuntimeUiRenderContext,
  ): RuntimeUiBlock | undefined {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    const safeEntry = canonicalRuntimeMessageRecord(entry);
    if (safeEntry.transcript === false) return undefined;
    const selected = this.#sessionRenderers.get(sessionRendererKey(safeEntry.extensionId, safeEntry.schemaVersion));
    const rendered = selected?.renderer.renderMessage === undefined
      ? undefined
      : this.#renderBlock(selected, `session message ${safeEntry.extensionId}@${safeEntry.schemaVersion}`, context, (safeContext) =>
        selected.renderer.renderMessage?.(Object.freeze(structuredClone(safeEntry)), safeContext));
    if (rendered !== undefined) return rendered;
    const safeContext = sanitizeRuntimeUiRenderContext(context);
    return sanitizeRuntimeUiBlock({
      lines: [
        { spans: [{ text: `${safeEntry.extensionId}/${safeEntry.kind}`, role: "accent" }] },
        { spans: [{ text: safeEntry.transcript.text, role: "muted" }] },
      ],
    }, { width: safeContext.width });
  }

  commands(): RuntimeCommandDescription[] {
    return this.#resolvedCommands().map(({ command, invocationName }) => ({
      extensionId: command.entry.extensionId,
      sourcePath: command.entry.sourcePath,
      scope: command.entry.scope ?? "project",
      trusted: command.entry.trusted ?? true,
      name: invocationName,
      baseName: command.registration.name,
      ...(command.registration.description === undefined ? {} : { description: command.registration.description }),
      ...(command.registration.argumentHint === undefined ? {} : { argumentHint: command.registration.argumentHint }),
    }));
  }

  shortcuts(): RuntimeShortcutDescription[] {
    return [...this.#shortcuts.values()].map(({ entry, registration }) => ({
      extensionId: entry.extensionId,
      sourcePath: entry.sourcePath,
      shortcut: registration.shortcut,
      ...(registration.description === undefined ? {} : { description: registration.description }),
    }));
  }

  flags(): RuntimeFlagDescription[] {
    return [...this.#flags.values()].map(({ entry, registration }) => ({
      extensionId: entry.extensionId,
      sourcePath: entry.sourcePath,
      name: registration.name,
      type: registration.type,
      ...(registration.description === undefined ? {} : { description: registration.description }),
      ...(registration.default === undefined ? {} : { default: registration.default }),
    }));
  }

  flagValues(): Map<string, boolean | string> {
    return new Map(this.#flagValues);
  }

  setFlagValue(name: string, value: boolean | string): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    const flag = this.#flags.get(name);
    if (flag === undefined) throw new Error(`Unknown runtime extension flag: ${name}`);
    if (typeof value !== flag.registration.type) throw new Error(`Runtime flag ${name} requires a ${flag.registration.type} value`);
    if (typeof value === "string") bounded(value, "Runtime flag value", 64 * 1024);
    this.#flagValues.set(name, value);
  }

  setFlagValues(values: ReadonlyMap<string, boolean | string>): void {
    for (const [name, value] of values) this.setFlagValue(name, value);
  }

  flagValueForActivation(name: string): boolean | string | undefined {
    return this.#flagValues.get(name);
  }

  flagValue(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    name: string,
  ): boolean | string | undefined {
    this.#assertLive(entry, generation);
    if (!this.#flags.get(name)?.owners.has(ownerKey(entry))) return undefined;
    return this.#flagValues.get(name);
  }

  initialUi(): RuntimeInitialUiOperation[] {
    return this.#initialUi.map((entry) => ({ ...entry }));
  }

  diagnostics(): RuntimeExtensionDiagnostic[] {
    return this.#diagnostics.map((entry) => ({ ...entry }));
  }

  hasListeners(event: RuntimeExtensionEvent): boolean {
    return (this.#listeners.get(event)?.length ?? 0) > 0;
  }

  /**
   * Asks only already-active extensions for a project-resource decision.
   * Listener failures are diagnostic and do not prevent a later listener or
   * the host policy from deciding. The first affirmative or negative result
   * wins; undecided listeners are advisory only.
   */
  async resolveProjectTrust(
    event: RuntimeProjectTrustEvent,
    ui?: RuntimeProjectTrustUi,
    signal?: AbortSignal,
  ): Promise<RuntimeProjectTrustResult> {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    const workspace = resolve(bounded(event.workspace, "Runtime project trust workspace", 16 * 1024));
    if (workspace !== this.#workspace) throw new Error("Runtime project trust workspace does not match the extension host");
    const cwd = resolve(bounded(event.cwd, "Runtime project trust cwd", 16 * 1024));
    const selectedUi: RuntimeProjectTrustUi = ui ?? Object.freeze({
      hasUI: false,
      async confirm(): Promise<boolean> {
        throw new Error("Interactive project trust UI is unavailable in this host");
      },
    });
    if (typeof selectedUi.hasUI !== "boolean" || typeof selectedUi.confirm !== "function") {
      throw new Error("Runtime project trust UI is invalid");
    }
    for (const owned of this.#listeners.get("project_trust") ?? []) {
      const scope = owned.entry.scope ?? "project";
      if (owned.entry.trusted !== true || (scope !== "user" && scope !== "invocation")) continue;
      signal?.throwIfAborted();
      const listenerSignal = AbortSignal.any([
        owned.generation.abortController.signal,
        AbortSignal.timeout(this.#resourceDiscoveryTimeoutMs),
        ...(signal === undefined ? [] : [signal]),
      ]);
      try {
        this.#assertLive(owned.entry, owned.generation);
        listenerSignal.throwIfAborted();
        const context: RuntimeProjectTrustListenerContext = Object.freeze({
          extensionId: owned.entry.extensionId,
          sourcePath: owned.entry.sourcePath,
          workspace: this.#workspace,
          signal: listenerSignal,
          ui: Object.freeze({
            hasUI: selectedUi.hasUI,
            async confirm(titleValue: string, messageValue: string, confirmSignal?: AbortSignal): Promise<boolean> {
              const title = bounded(titleValue, "Runtime project trust confirmation title", 4 * 1024);
              const message = bounded(messageValue, "Runtime project trust confirmation message", 16 * 1024);
              const combined = combinedGenerationSignal(
                owned.generation,
                confirmSignal === undefined ? listenerSignal : AbortSignal.any([listenerSignal, confirmSignal]),
                "Runtime project trust confirmation",
              );
              return await selectedUi.confirm(title, message, combined);
            },
          }),
        });
        const listener = owned.listener as unknown as RuntimeExtensionListener<"project_trust">;
        const result = await this.#withLifecycleListener(owned, async () => await withAbort(
          Promise.resolve(listener(Object.freeze({ workspace, cwd }), context)),
          listenerSignal,
        ));
        const decision = runtimeProjectTrustResult(result);
        if (decision.decision !== "undecided") return decision;
      } catch (cause) {
        if (signal?.aborted === true) throw abortError(signal);
        this.#recordListenerFailure(owned, cause);
      }
    }
    signal?.throwIfAborted();
    return { decision: "undecided" };
  }

  async discoverResources(
    reason: RuntimeResourcesDiscoverEvent["reason"],
    signal?: AbortSignal,
  ): Promise<RuntimeDiscoveredResources> {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    if (reason !== "startup" && reason !== "reload") throw new Error("Runtime resource discovery reason is invalid");
    const discoverySignal = signal ?? AbortSignal.timeout(this.#resourceDiscoveryTimeoutMs);
    const discovered: RuntimeDiscoveredResources = { skillPaths: [], promptPaths: [], themePaths: [] };
    let total = 0;
    for (const owned of this.#listeners.get("resources_discover") ?? []) {
      discoverySignal.throwIfAborted();
      const scope = owned.entry.scope ?? "project";
      const trusted = owned.entry.trusted ?? true;
      if (!trusted) {
        this.addDiagnostic({
          extensionId: owned.entry.extensionId,
          sourcePath: owned.entry.sourcePath,
          message: `Runtime resources_discover ignored resources from an untrusted ${scope} extension`,
        });
        continue;
      }
      const listenerSignal = AbortSignal.any([discoverySignal, owned.generation.abortController.signal]);
      try {
        this.#assertLive(owned.entry, owned.generation);
        listenerSignal.throwIfAborted();
        const context = this.#listenerContext(owned, listenerSignal);
        const listener = owned.listener as unknown as RuntimeExtensionListener<"resources_discover">;
        const value = runtimeResourcesDiscoverResult(await withAbort(Promise.resolve(listener({
          workspace: this.#workspace,
          reason,
        }, context)), listenerSignal));
        const added = value.skillPaths.length + value.promptPaths.length + value.themePaths.length;
        if (total + added > MAX_RUNTIME_DISCOVERED_RESOURCE_PATHS) {
          throw new Error(`Runtime resource discovery exceeds ${MAX_RUNTIME_DISCOVERED_RESOURCE_PATHS} total paths`);
        }
        const ownedPath = (path: string): RuntimeDiscoveredResourcePath => {
          const packageRoot = resolve(owned.entry.resourceRoot ?? dirname(owned.entry.sourcePath));
          const target = isAbsolute(path) ? resolve(path) : undefined;
          const resourceRoot = target !== undefined && pathInside(owned.generation.dataPaths.user, target)
            ? owned.generation.dataPaths.user
            : target !== undefined && pathInside(owned.generation.dataPaths.workspace, target)
              ? owned.generation.dataPaths.workspace
              : packageRoot;
          return {
            path,
            extensionId: owned.entry.extensionId,
            sourcePath: owned.entry.sourcePath,
            resourceRoot,
            scope,
            trusted,
          };
        };
        discovered.skillPaths.push(...value.skillPaths.map(ownedPath));
        discovered.promptPaths.push(...value.promptPaths.map(ownedPath));
        discovered.themePaths.push(...value.themePaths.map(ownedPath));
        total += added;
      } catch (cause) {
        if (listenerSignal.aborted) throw abortError(listenerSignal);
        this.#recordListenerFailure(owned, cause);
      }
    }
    discoverySignal.throwIfAborted();
    return discovered;
  }

  addDiagnostic(entry: RuntimeExtensionDiagnostic): void {
    if (this.#diagnosticsTruncated) return;
    if (this.#diagnostics.length < MAX_RUNTIME_DIAGNOSTICS) {
      this.#diagnostics.push({
        extensionId: utf8Prefix(entry.extensionId.replaceAll("\0", ""), 1_024),
        sourcePath: utf8Prefix(entry.sourcePath.replaceAll("\0", ""), 16 * 1_024),
        message: utf8Prefix(entry.message.replaceAll("\0", ""), 4 * 1_024),
      });
      return;
    }
    this.#diagnosticsTruncated = true;
    this.#diagnostics[MAX_RUNTIME_DIAGNOSTICS - 1] = {
      extensionId: "runtime",
      sourcePath: "",
      message: `Runtime extension diagnostics exceeded ${MAX_RUNTIME_DIAGNOSTICS} entries`,
    };
  }

  setLiveRegistrationHandler(handler: RuntimeLiveRegistrationHandler): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    if (this.#liveRegistrationHandler !== undefined) throw new Error("Runtime live registration handler is already set");
    if (this.#providerOverrides.length > 0 && handler.overrideProvider === undefined) {
      throw new Error("Provider override registrations are unavailable in this host");
    }
    if (this.#providerOverlays.length > 0 && handler.overlayProvider === undefined) {
      throw new Error("Provider overlay registrations are unavailable in this host");
    }
    if (this.#providerWires.length > 0 && handler.registerProviderWire === undefined) {
      throw new Error("Provider wire registrations are unavailable in this host");
    }
    this.#liveRegistrationHandler = handler;
    for (const owned of this.#providerOverrides) {
      if (owned.cleanup !== undefined) continue;
      const cleanup = handler.overrideProvider?.(owned.provider);
      if (cleanup !== undefined) {
        const selected = onceRuntimeCleanup(cleanup);
        owned.cleanup = selected;
        this.#registrationCleanups.push(selected);
      }
    }
    for (const owned of this.#providerOverlays) {
      if (owned.cleanup !== undefined) continue;
      const cleanup = handler.overlayProvider?.(owned.overlay);
      if (cleanup !== undefined) {
        const selected = onceRuntimeCleanup(cleanup);
        owned.cleanup = selected;
        this.#registrationCleanups.push(selected);
      }
    }
    for (const owned of this.#providerWires) {
      if (owned.cleanup !== undefined) continue;
      const cleanup = handler.registerProviderWire?.(owned.provider, owned.interceptor);
      if (cleanup !== undefined) {
        const selected = onceRuntimeCleanup(cleanup);
        owned.cleanup = selected;
        this.#registrationCleanups.push(selected);
      }
    }
  }

  setSessionHandler(handler: RuntimeExtensionSessionHandler): () => void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    if (this.#sessionHandler !== undefined) throw new Error("Runtime extension session handler is already set");
    this.#sessionHandler = handler;
    return () => {
      if (this.#sessionHandler === handler) this.#sessionHandler = undefined;
    };
  }

  setNativeHostHandler(handler: RuntimeNativeHostHandler | undefined): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    this.#nativeHostHandler = handler;
  }

  setNativeUiHandler(handler: ((extensionId: string, signal: AbortSignal) => NativeUiHost) | undefined): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    if (handler === this.#nativeUiHandler) return;
    for (const host of this.#nativeUiHosts.values()) host.dispose();
    this.#nativeUiHosts.clear();
    for (const host of this.#unsafeTerminalHosts.values()) host.dispose();
    this.#unsafeTerminalHosts.clear();
    this.#nativeUiHandler = handler;
  }

  setUnsafeTerminalHandler(handler: ((extensionId: string, signal: AbortSignal) => UnsafeTerminalHost) | undefined): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    if (handler === this.#unsafeTerminalHandler) return;
    for (const host of this.#unsafeTerminalHosts.values()) host.dispose();
    this.#unsafeTerminalHosts.clear();
    this.#unsafeTerminalHandler = handler;
  }

  nativeUi(entry: ExtensionRuntimeEntry, generation: RuntimeExtensionGeneration): NativeUiHost {
    this.#assertPermission(entry, generation, "nativeUi", "Native UI access");
    const existing = this.#nativeUiHosts.get(generation);
    if (existing !== undefined) return existing;
    const handler = this.#nativeUiHandler;
    if (handler === undefined) throw new Error("Native UI is unavailable without an interactive TUI");
    const selected = handler(entry.extensionId, generation.abortController.signal);
    this.#nativeUiHosts.set(generation, selected);
    return selected;
  }

  disposeNativeUi(entry: ExtensionRuntimeEntry, generation: RuntimeExtensionGeneration): void {
    this.#assertPermission(entry, generation, "nativeUi", "Native UI access");
    const selected = this.#nativeUiHosts.get(generation);
    if (selected === undefined) return;
    this.#nativeUiHosts.delete(generation);
    selected.dispose();
  }

  rollbackNativeUi(generation: RuntimeExtensionGeneration): void {
    const selected = this.#nativeUiHosts.get(generation);
    if (selected === undefined) return;
    this.#nativeUiHosts.delete(generation);
    selected.dispose();
  }

  unsafeTerminal(entry: ExtensionRuntimeEntry, generation: RuntimeExtensionGeneration): UnsafeTerminalHost {
    this.#assertPermission(entry, generation, "unsafeTerminal", "Unsafe terminal access");
    const existing = this.#unsafeTerminalHosts.get(generation);
    if (existing !== undefined) return existing;
    const handler = this.#unsafeTerminalHandler;
    if (handler === undefined) throw new Error("Unsafe terminal access is unavailable without an interactive TUI");
    const selected = handler(entry.extensionId, generation.abortController.signal);
    this.#unsafeTerminalHosts.set(generation, selected);
    return selected;
  }

  disposeUnsafeTerminal(entry: ExtensionRuntimeEntry, generation: RuntimeExtensionGeneration): void {
    this.#assertPermission(entry, generation, "unsafeTerminal", "Unsafe terminal access");
    const selected = this.#unsafeTerminalHosts.get(generation);
    if (selected === undefined) return;
    this.#unsafeTerminalHosts.delete(generation);
    selected.dispose();
  }

  rollbackUnsafeTerminal(generation: RuntimeExtensionGeneration): void {
    const selected = this.#unsafeTerminalHosts.get(generation);
    if (selected === undefined) return;
    this.#unsafeTerminalHosts.delete(generation);
    selected.dispose();
  }

  setReloadHandler(handler: RuntimeExtensionReloadHandler | undefined): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    this.#reloadHandler = handler;
  }

  setShutdownHandler(handler: RuntimeExtensionShutdownHandler | undefined): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    this.#shutdownHandler = handler;
  }

  setSessionFocusHandler(handler: RuntimeExtensionSessionFocusHandler | undefined): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    this.#sessionFocusHandler = handler;
  }

  setModelFocusHandler(handler: RuntimeExtensionModelFocusHandler | undefined): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    this.#modelFocusHandler = handler;
  }

  setInteractiveUiHandler(handler: RuntimeInteractiveUiHandler | undefined): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    this.#interactiveUiHandler = handler;
  }

  addRegistrationCleanup(cleanup: () => void | Promise<void>): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    this.#registrationCleanups.push(cleanup);
  }

  setUiHandler(handler: ((operation: RuntimeInitialUiOperation) => void) | undefined): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    this.#uiHandler = handler;
  }

  setAdvancedUiHandler(handler: RuntimeAdvancedUiHostHandler | undefined): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    this.#advancedUiHandler = handler;
    if (handler === undefined) return;
    for (const operation of this.#initialAdvancedUi.splice(0)) {
      try {
        operation.signal.throwIfAborted();
        handler.apply(operation);
      } catch (cause) {
        this.addDiagnostic({
          extensionId: operation.extensionId,
          sourcePath: "",
          message: `Advanced UI operation was ignored: ${error(cause).message}`,
        });
      }
    }
  }

  onChange(listener: (change: RuntimeExtensionChange) => void): () => void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  applyUi(operation: RuntimeInitialUiOperation): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    if (this.#uiHandler === undefined) {
      if (this.#initialUi.length >= MAX_RUNTIME_INITIAL_UI_OPERATIONS) {
        throw new Error(`Runtime extension initial UI exceeds ${MAX_RUNTIME_INITIAL_UI_OPERATIONS} operations`);
      }
      this.#initialUi.push({ ...operation });
    }
    else this.#uiHandler({ ...operation });
  }

  applyAdvancedUi(operation: RuntimeAdvancedUiOperation): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    operation.signal.throwIfAborted();
    if (this.#advancedUiHandler === undefined) {
      if (this.#initialAdvancedUi.length >= MAX_RUNTIME_INITIAL_UI_OPERATIONS) {
        throw new Error(`Runtime extension initial advanced UI exceeds ${MAX_RUNTIME_INITIAL_UI_OPERATIONS} operations`);
      }
      this.#initialAdvancedUi.push(operation);
      return;
    }
    this.#advancedUiHandler.apply(operation);
  }

  getAdvancedUiToolOutputExpanded(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
  ): boolean {
    this.#assertLive(entry, generation);
    const handler = this.#advancedUiHandler;
    if (handler === undefined) throw new Error("Advanced UI state is unavailable without an interactive TUI");
    const value = handler.getToolOutputExpanded();
    if (typeof value !== "boolean") throw new Error("Advanced UI host returned an invalid tool output expansion state");
    return value;
  }

  registerLiveTool(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    registration: RuntimeToolRegistration,
  ): void {
    this.#assertLive(entry, generation);
    const prior = this.#tools.get(registration.name);
    if (prior !== undefined) {
      if (this.#diagnoseCrossExtensionToolCollision(entry, registration.name, prior)) return;
      throw new Error("Runtime extension registered a duplicate tool");
    }
    const tool = new RuntimeHarnessTool(
      registration,
      (context) => this.#runtimeToolContext(entry, generation, context),
      async (context, execute) => await this.#requesterThread.run({ threadId: context.threadId }, execute),
    );
    const cleanup = this.#liveRegistrationHandler?.registerTool(tool);
    if (cleanup !== undefined) this.#registrationCleanups.push(cleanup);
    this.#tools.set(registration.name, tool);
    this.#toolOwners.set(tool, {
      kind: "extension",
      extensionId: entry.extensionId,
      sourcePath: entry.sourcePath,
    });
    this.#changed("tool", entry);
  }

  registerLiveCommand(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    command: RuntimeCommandRegistration,
  ): void {
    this.#assertLive(entry, generation);
    if (isBuiltinSlashCommand(command.name)) throw new Error(`Runtime extension command name is reserved: ${command.name}`);
    if (this.#commands.some((owned) => ownerKey(owned.entry) === ownerKey(entry) && owned.registration.name === command.name)) {
      throw new Error("Runtime extension registered a duplicate command");
    }
    this.#commands.push({ entry, generation, registration: command });
    this.#changed("command", entry);
  }

  registerLiveAutocompleteProvider(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    provider: RuntimeAutocompleteProvider,
  ): void {
    this.#assertLive(entry, generation);
    if (typeof provider !== "function") throw new Error("Runtime autocomplete provider must be a function");
    if (this.#autocompleteProviders.length >= MAX_RUNTIME_AUTOCOMPLETE_PROVIDERS) throw new Error("Runtime autocomplete provider limit exceeded");
    this.#autocompleteProviders.push({ entry, generation, provider });
    this.#changed("autocomplete", entry);
  }

  registerLiveEditorMiddleware(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    middleware: RuntimeEditorMiddleware,
  ): void {
    this.#assertLive(entry, generation);
    if (typeof middleware !== "function") throw new Error("Runtime editor middleware must be a function");
    if (this.#editorMiddleware.length >= MAX_RUNTIME_EDITOR_MIDDLEWARE) throw new Error("Runtime editor middleware limit exceeded");
    this.#editorMiddleware.push({ entry, generation, middleware });
    this.#changed("editor_middleware", entry);
  }

  registerLiveShortcut(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    shortcut: RuntimeShortcutRegistration,
  ): void {
    this.#assertLive(entry, generation);
    const prior = this.#shortcuts.get(shortcut.shortcut);
    this.#shortcuts.set(shortcut.shortcut, { entry, generation, registration: shortcut });
    if (prior !== undefined && prior.entry.extensionId !== entry.extensionId) {
      this.addDiagnostic({
        extensionId: entry.extensionId,
        sourcePath: entry.sourcePath,
        message: `Runtime shortcut ${shortcut.shortcut} replaced the registration from ${prior.entry.extensionId}`,
      });
    }
    this.#changed("shortcut", entry);
  }

  registerLiveFlag(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    flag: RuntimeFlagRegistration,
  ): void {
    this.#assertLive(entry, generation);
    const prior = this.#flags.get(flag.name);
    if (prior === undefined) {
      this.#flags.set(flag.name, { entry, generation, registration: flag, owners: new Set([ownerKey(entry)]) });
      if (flag.default !== undefined && !this.#flagValues.has(flag.name)) this.#flagValues.set(flag.name, flag.default);
    } else {
      prior.owners.add(ownerKey(entry));
      if (ownerKey(prior.entry) === ownerKey(entry)) {
        prior.registration = flag;
      }
    }
    this.#changed("flag", entry);
  }

  registerLiveProvider(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    provider: ProviderAdapter,
  ): () => Promise<void> {
    this.#assertLive(entry, generation);
    if (this.#providers.has(provider.id)) throw new Error("Runtime extension registered a duplicate provider");
    const cleanup = this.#liveRegistrationHandler?.registerProvider(provider);
    if (cleanup !== undefined) this.#providerCleanups.set(provider.id, cleanup);
    this.#providers.set(provider.id, provider);
    this.#providerOwners.set(provider.id, { entry, generation });
    this.#changed("provider", entry);
    return async () => await this.unregisterLiveProvider(entry, generation, provider);
  }

  registerLiveProviderOverride(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    provider: ProviderAdapter,
    token = Symbol(provider.id),
  ): () => Promise<void> {
    this.#assertPermission(entry, generation, "providerOverride", "Provider override");
    const handler = this.#liveRegistrationHandler?.overrideProvider;
    if (handler === undefined) throw new Error("Provider override is unavailable in this host");
    const owned: OwnedProviderOverride = { token, entry, generation, provider };
    const cleanup = handler(provider);
    if (cleanup !== undefined) {
      const selected = onceRuntimeCleanup(cleanup);
      owned.cleanup = selected;
      this.#registrationCleanups.push(selected);
    }
    this.#providerOverrides.push(owned);
    this.#changed("provider", entry);
    return async () => await this.unregisterLiveProviderOverride(entry, generation, token);
  }

  async unregisterLiveProviderOverride(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    token: symbol,
  ): Promise<void> {
    this.#assertLive(entry, generation);
    const index = this.#providerOverrides.findIndex((candidate) =>
      candidate.token === token && candidate.generation === generation && ownerKey(candidate.entry) === ownerKey(entry));
    if (index < 0) return;
    const [selected] = this.#providerOverrides.splice(index, 1);
    await selected?.cleanup?.();
    this.#changed("provider", entry);
  }

  registerLiveProviderOverlay(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    overlay: RuntimeProviderOverlay,
    token = Symbol(overlay.id),
  ): () => Promise<void> {
    this.#assertPermission(entry, generation, "providerOverride", "Provider overlay");
    const handler = this.#liveRegistrationHandler?.overlayProvider;
    if (handler === undefined) throw new Error("Provider overlay is unavailable in this host");
    const owned: OwnedProviderOverlay = { token, entry, generation, overlay };
    const cleanup = handler(overlay);
    if (cleanup !== undefined) {
      const selected = onceRuntimeCleanup(cleanup);
      owned.cleanup = selected;
      this.#registrationCleanups.push(selected);
    }
    this.#providerOverlays.push(owned);
    this.#changed("provider", entry);
    return async () => await this.unregisterLiveProviderOverlay(entry, generation, token);
  }

  async unregisterLiveProviderOverlay(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    token: symbol,
  ): Promise<void> {
    this.#assertLive(entry, generation);
    const index = this.#providerOverlays.findIndex((candidate) =>
      candidate.token === token && candidate.generation === generation && ownerKey(candidate.entry) === ownerKey(entry));
    if (index < 0) return;
    const [selected] = this.#providerOverlays.splice(index, 1);
    await selected?.cleanup?.();
    this.#changed("provider", entry);
  }

  registerLiveProviderWire(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    provider: ProviderId,
    interceptor: ProviderWireInterceptor,
    token = Symbol(provider),
  ): () => Promise<void> {
    this.#assertPermission(entry, generation, "providerWire", "Provider wire interception");
    const handler = this.#liveRegistrationHandler?.registerProviderWire;
    if (handler === undefined) throw new Error("Provider wire interception is unavailable in this host");
    const owned: OwnedProviderWire = { token, entry, generation, provider, interceptor };
    const cleanup = handler(provider, interceptor);
    if (cleanup !== undefined) {
      const selected = onceRuntimeCleanup(cleanup);
      owned.cleanup = selected;
      this.#registrationCleanups.push(selected);
    }
    this.#providerWires.push(owned);
    return async () => await this.unregisterLiveProviderWire(entry, generation, token);
  }

  async unregisterLiveProviderWire(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    token: symbol,
  ): Promise<void> {
    this.#assertLive(entry, generation);
    const index = this.#providerWires.findIndex((candidate) =>
      candidate.token === token && candidate.generation === generation && ownerKey(candidate.entry) === ownerKey(entry));
    if (index < 0) return;
    const [selected] = this.#providerWires.splice(index, 1);
    await selected?.cleanup?.();
  }

  async unregisterLiveProvider(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    provider: ProviderAdapter,
  ): Promise<void> {
    const current = this.#providers.get(provider.id);
    if (current === undefined) return;
    this.#assertLive(entry, generation);
    const owner = this.#providerOwners.get(provider.id);
    if (current !== provider || owner === undefined || ownerKey(owner.entry) !== ownerKey(entry) || owner.generation !== generation) {
      throw new Error("Runtime extension cannot unregister a provider it does not own");
    }
    const authCleanup = this.#providerAuthCleanups.get(provider.id);
    if (authCleanup !== undefined) await authCleanup();
    this.#providerAuthCleanups.delete(provider.id);
    const cleanup = this.#providerCleanups.get(provider.id);
    if (cleanup !== undefined) await cleanup();
    else if (this.#liveRegistrationHandler?.unregisterProvider !== undefined) {
      await this.#liveRegistrationHandler.unregisterProvider(provider);
    } else {
      throw new Error("Runtime provider unregistration is not available in this host");
    }
    this.#providerCleanups.delete(provider.id);
    this.#providers.delete(provider.id);
    this.#providerOwners.delete(provider.id);
    const auth = this.#providerAuth.get(provider.id);
    if (auth?.extensionId === entry.extensionId && auth.sourcePath === entry.sourcePath) this.#providerAuth.delete(provider.id);
    this.#changed("provider", entry);
  }

  registerLiveProviderAuth(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    descriptor: ProviderAuthDescriptor,
  ): void {
    this.#assertLive(entry, generation);
    this.assertProviderAuthRegistration(entry, generation, descriptor);
    if (this.#providerAuth.has(descriptor.provider)) {
      throw new Error("Runtime extension registered a duplicate provider auth descriptor");
    }
    const handler = this.#liveRegistrationHandler;
    if (handler === undefined) throw new Error("Runtime provider auth registration is not initialized");
    const description: RuntimeProviderAuthDescription = {
      extensionId: entry.extensionId,
      sourcePath: entry.sourcePath,
      descriptor,
    };
    const cleanup = handler.registerProviderAuth(description);
    if (cleanup !== undefined) this.#providerAuthCleanups.set(descriptor.provider, cleanup);
    this.#providerAuth.set(descriptor.provider, description);
    this.#changed("provider_auth", entry);
  }

  assertProviderAuthRegistration(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    descriptor: ProviderAuthDescriptor,
  ): void {
    this.#assertLive(entry, generation);
    if (descriptor.methods.some((method) => method.kind === "managed_oauth")) {
      this.#assertPermission(entry, generation, "credentialAccess", "Managed provider authentication");
    }
  }

  async fetchProvider(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    provider: string,
    input: string | URL | Request,
    init?: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    this.#assertLive(entry, generation);
    const selectedSignal = combinedGenerationSignal(generation, signal, "Runtime provider authenticated request");
    const owner = this.#providerAuth.get(provider);
    if (owner?.extensionId !== entry.extensionId) {
      throw new Error(`Runtime extension does not own provider authentication: ${provider}`);
    }
    const fetchProvider = this.#liveRegistrationHandler?.fetchProvider;
    if (fetchProvider === undefined) throw new Error("Provider authenticated requests are not available during extension activation");
    const response = await withAbort(fetchProvider(provider, input, init, selectedSignal), selectedSignal);
    this.#assertLive(entry, generation);
    selectedSignal.throwIfAborted();
    return response;
  }

  async getActiveTools(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeExtensionSessionTarget,
  ): Promise<string[]> {
    this.#assertLive(entry, generation);
    const record = runtimeSessionRecord(input, ["threadId", "branch", "signal"], "Runtime active tool query");
    const target = runtimeSessionTarget(record, "Runtime active tool query");
    target.signal?.throwIfAborted();
    const handler = this.#sessionHandler;
    if (handler === undefined) throw new Error("Runtime extension active tool storage is not available");
    try {
      const names = runtimeActiveToolNames(await handler.getActiveTools({
        ...target,
        requesterExtensionId: entry.extensionId,
        requesterSourcePath: entry.sourcePath,
      }), "Runtime active tool query result");
      this.#assertLive(entry, generation);
      target.signal?.throwIfAborted();
      return names;
    } catch (cause) {
      this.addDiagnostic({
        extensionId: entry.extensionId,
        sourcePath: entry.sourcePath,
        message: `Active tool query failed: ${error(cause).message}`,
      });
      throw cause;
    }
  }

  async getAllTools(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeExtensionSessionTarget,
  ): Promise<RuntimeToolCatalogEntry[]> {
    const record = runtimeSessionRecord(input, ["threadId", "branch", "signal"], "Runtime tool catalog query");
    const target = runtimeSessionTarget(record, "Runtime tool catalog query");
    return await this.#runSessionOperation(entry, generation, target.signal, "Runtime tool catalog query", async (handler, signal) =>
      runtimeToolCatalog(await handler.getAllTools({
        threadId: target.threadId,
        ...(target.branch === undefined ? {} : { branch: target.branch }),
        signal,
        requesterExtensionId: entry.extensionId,
        requesterSourcePath: entry.sourcePath,
      }), "Runtime tool catalog query result"));
  }

  getCommands(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
  ): RuntimeCommandDescription[] {
    this.#assertLive(entry, generation);
    const commands = this.commands();
    if (commands.length > MAX_RUNTIME_ACTIVE_TOOLS) {
      throw new Error(`Runtime command catalog exceeds ${MAX_RUNTIME_ACTIVE_TOOLS} commands`);
    }
    return cloneBounded(commands, "Runtime command catalog", MAX_RUNTIME_CATALOG_BYTES);
  }

  async getResourceCatalog(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    signal?: AbortSignal,
  ): Promise<HarnessResourceCatalog> {
    return await this.#runSessionOperation(entry, generation, signal, "Runtime resource catalog query", async (handler, selectedSignal) =>
      parseHarnessResourceCatalog(await handler.getResourceCatalog({ signal: selectedSignal })));
  }

  async getDiscoveryView(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    signal?: AbortSignal,
  ): Promise<RuntimeDiscoveryView> {
    const catalog = await this.getResourceCatalog(entry, generation, signal);
    const resources: RuntimeDiscoverableResource[] = [
      ...catalog.commands.builtins.map((command): RuntimeDiscoverableResource => ({
        kind: "command",
        source: "builtin",
        name: command.name,
        syntax: command.syntax,
      })),
      ...catalog.commands.runtimeExtensions.map((command): RuntimeDiscoverableResource => ({
        kind: "command",
        source: "runtime_extension",
        name: command.name,
        extensionId: command.extensionId,
        ...(command.description === undefined ? {} : { description: command.description }),
        ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
      })),
      ...catalog.commands.extensionTemplates.map((command): RuntimeDiscoverableResource => ({
        kind: "command",
        source: "extension_template",
        name: command.name,
        extensionId: command.extensionId,
        ...(command.description === undefined ? {} : { description: command.description }),
        ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
      })),
      ...catalog.prompts.map((prompt): RuntimeDiscoverableResource => ({
        kind: "prompt",
        name: prompt.id,
        extensionId: prompt.extensionId,
        ...(prompt.description === undefined ? {} : { description: prompt.description }),
        ...(prompt.argumentHint === undefined ? {} : { argumentHint: prompt.argumentHint }),
      })),
      ...catalog.skills.map((skill): RuntimeDiscoverableResource => ({
        kind: "skill",
        name: skill.name,
        description: skill.description,
        scope: skill.scope,
        trusted: skill.trusted,
        disableModelInvocation: skill.disableModelInvocation,
      })),
    ];
    return cloneBounded({
      resources,
      truncated: catalog.bounds.truncated,
      omitted: {
        commands: catalog.bounds.omitted.commands,
        prompts: catalog.bounds.omitted.prompts,
        skills: catalog.bounds.omitted.skills,
      },
    }, "Runtime discovery view", MAX_RUNTIME_CATALOG_BYTES);
  }

  async listSessions(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeSessionListInput = {},
  ): Promise<RuntimeSessionPage> {
    const record = runtimeSessionRecord(input, ["search", "cursor", "limit", "signal"], "Runtime session list query");
    if (
      record.search !== undefined && (
        typeof record.search !== "string" || record.search.includes("\0") ||
        Buffer.byteLength(record.search, "utf8") > HARNESS_SESSION_CATALOG_LIMITS.maxSearchBytes
      )
    ) throw new Error("Runtime session search is invalid");
    if (
      record.cursor !== undefined && (
        typeof record.cursor !== "string" || record.cursor === "" || record.cursor.includes("\0") ||
        Buffer.byteLength(record.cursor, "utf8") > HARNESS_SESSION_CATALOG_LIMITS.maxCursorBytes
      )
    ) throw new Error("Runtime session cursor is invalid");
    if (record.limit !== undefined && (
      !Number.isSafeInteger(record.limit) || (record.limit as number) < 1 ||
      (record.limit as number) > HARNESS_SESSION_CATALOG_LIMITS.maxEntries
    )) throw new Error(`Runtime session list limit must be from 1 through ${HARNESS_SESSION_CATALOG_LIMITS.maxEntries}`);
    if (record.signal !== undefined && !(record.signal instanceof AbortSignal)) throw new Error("Runtime session list signal is invalid");
    return await this.#runSessionOperation(
      entry,
      generation,
      record.signal as AbortSignal | undefined,
      "Runtime session list query",
      async (handler, signal) => parseHarnessSessionPage(await handler.listSessions({
        ...(record.search === undefined ? {} : { search: record.search as string }),
        ...(record.cursor === undefined ? {} : { cursor: record.cursor as string }),
        ...(record.limit === undefined ? {} : { limit: record.limit as number }),
        signal,
      })),
    );
  }

  async getTranscript(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeTranscriptInput,
  ): Promise<HarnessTranscriptPage> {
    const record = runtimeSessionRecord(
      input,
      ["threadId", "branch", "signal", "afterSequence", "limit"],
      "Runtime transcript query",
    );
    const target = runtimeSessionTarget(record, "Runtime transcript query");
    if (record.afterSequence !== undefined && (!Number.isSafeInteger(record.afterSequence) || (record.afterSequence as number) < 0)) {
      throw new Error("Runtime transcript afterSequence is invalid");
    }
    if (record.limit !== undefined && (
      !Number.isSafeInteger(record.limit)
      || (record.limit as number) < 1
      || (record.limit as number) > HARNESS_TRANSCRIPT_LIMITS.maxEntries
    )) throw new Error(`Runtime transcript limit must be from 1 through ${HARNESS_TRANSCRIPT_LIMITS.maxEntries}`);
    return await this.#runSessionOperation(entry, generation, target.signal, "Runtime transcript query", async (handler, signal) => {
      const result = parseHarnessTranscriptPage(await handler.getTranscript({
        threadId: target.threadId,
        ...(target.branch === undefined ? {} : { branch: target.branch }),
        signal,
        ...(record.afterSequence === undefined ? {} : { afterSequence: record.afterSequence as number }),
        ...(record.limit === undefined ? {} : { limit: record.limit as number }),
      }));
      if (result.threadId !== target.threadId || (target.branch !== undefined && result.branch !== target.branch)) {
        throw new Error("Runtime transcript result changed its target");
      }
      return result;
    });
  }

  async getSessionUsage(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeExtensionSessionTarget,
  ): Promise<RuntimeSessionUsageSnapshot> {
    const record = runtimeSessionRecord(input, ["threadId", "branch", "signal"], "Runtime session usage query");
    const target = runtimeSessionTarget(record, "Runtime session usage query");
    return await this.#runSessionOperation(entry, generation, target.signal, "Runtime session usage query", async (handler, signal) => {
      const result = runtimeSessionUsageSnapshot(await handler.getUsage({
        threadId: target.threadId,
        ...(target.branch === undefined ? {} : { branch: target.branch }),
        signal,
      }), "Runtime session usage query result");
      if (result.threadId !== target.threadId || (target.branch !== undefined && result.branch !== target.branch)) {
        throw new Error("Runtime session usage result changed its target");
      }
      return result;
    });
  }

  async getSystemPromptSnapshot(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeExtensionSessionTarget,
  ): Promise<RuntimeSystemPromptSnapshot | undefined> {
    const record = runtimeSessionRecord(input, ["threadId", "branch", "signal"], "Runtime system prompt query");
    const target = runtimeSessionTarget(record, "Runtime system prompt query");
    return await this.#runSessionOperation(entry, generation, target.signal, "Runtime system prompt query", async (handler, signal) => {
      const value = await handler.getSystemPrompt({
        threadId: target.threadId,
        ...(target.branch === undefined ? {} : { branch: target.branch }),
        signal,
      });
      if (value === undefined) return undefined;
      const result = runtimeSystemPromptSnapshot(value, "Runtime system prompt query result");
      if (result.threadId !== target.threadId || (target.branch !== undefined && result.branch !== target.branch)) {
        throw new Error("Runtime system prompt result changed its target");
      }
      return result;
    });
  }

  async readNativeSession(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeNativeSessionReadInput,
  ): Promise<RuntimeNativeSessionPage> {
    this.#assertPermission(entry, generation, "sessionRaw", "Native session access");
    const record = runtimeSessionRecord(
      input,
      ["threadId", "branch", "signal", "afterSequence", "throughSequence", "limit", "includeContext", "provider", "model"],
      "Runtime native session query",
    );
    const target = runtimeSessionTarget(record, "Runtime native session query");
    for (const field of ["afterSequence", "throughSequence"] as const) {
      if (record[field] !== undefined && (!Number.isSafeInteger(record[field]) || (record[field] as number) < 0)) {
        throw new Error(`Runtime native session ${field} is invalid`);
      }
    }
    const limit = record.limit ?? 256;
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_RUNTIME_NATIVE_SESSION_PAGE) {
      throw new Error(`Runtime native session limit must be from 1 through ${MAX_RUNTIME_NATIVE_SESSION_PAGE}`);
    }
    if (record.includeContext !== undefined && typeof record.includeContext !== "boolean") {
      throw new Error("Runtime native session includeContext must be boolean");
    }
    if (record.provider !== undefined && (typeof record.provider !== "string" || !AUTH_PROVIDER.test(record.provider))) {
      throw new Error("Runtime native session provider is invalid");
    }
    if (record.model !== undefined && (typeof record.model !== "string" || record.model === "")) {
      throw new Error("Runtime native session model is invalid");
    }
    if (typeof record.model === "string") bounded(record.model, "Runtime native session model", 4 * 1024);
    return await this.#runSessionOperation(entry, generation, target.signal, "Runtime native session query", async (handler, signal) => {
      const result = cloneBounded(await handler.readNativeSession({
        threadId: target.threadId,
        ...(target.branch === undefined ? {} : { branch: target.branch }),
        signal,
        ...(record.afterSequence === undefined ? {} : { afterSequence: record.afterSequence as number }),
        ...(record.throughSequence === undefined ? {} : { throughSequence: record.throughSequence as number }),
        limit: limit as number,
        ...(record.includeContext === true ? { includeContext: true } : {}),
        ...(record.provider === undefined ? {} : { provider: record.provider as ProviderId }),
        ...(record.model === undefined ? {} : { model: record.model as string }),
      }), "Runtime native session query result", MAX_RUNTIME_NATIVE_SESSION_BYTES);
      if (result.thread.threadId !== target.threadId || (target.branch !== undefined && result.branch !== target.branch)) {
        throw new Error("Runtime native session result changed its target");
      }
      if (!Number.isSafeInteger(result.nextSequence) || !Number.isSafeInteger(result.snapshotSequence)) {
        throw new Error("Runtime native session result contains invalid sequence cursors");
      }
      if (!Array.isArray(result.events) || result.events.length > (limit as number) || !Array.isArray(result.runs)) {
        throw new Error("Runtime native session result exceeds its requested bounds");
      }
      return result;
    });
  }

  async getNativeSystemPrompt(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    target?: RuntimeExtensionSessionTarget,
  ): Promise<RuntimeNativeSystemPromptSnapshot | undefined> {
    this.#assertPermission(entry, generation, "sessionRaw", "Native system-prompt access");
    if (target === undefined) {
      const current = this.#currentSystemPrompt.getStore();
      return current === undefined
        ? undefined
        : cloneBounded(current, "Runtime native system prompt", MAX_RUNTIME_NATIVE_SESSION_BYTES);
    }
    const record = runtimeSessionRecord(target, ["threadId", "branch", "signal"], "Runtime native system prompt query");
    const selected = runtimeSessionTarget(record, "Runtime native system prompt query");
    const signal = combinedGenerationSignal(generation, selected.signal, "Runtime native system prompt query");
    signal.throwIfAborted();
    let value: RuntimeNativeSystemPromptSnapshot | undefined;
    if (selected.branch !== undefined) value = this.#systemPrompts.get(`${selected.threadId}\0${selected.branch}`);
    else {
      value = [...this.#systemPrompts.values()].findLast((snapshot) => snapshot.threadId === selected.threadId);
    }
    this.#assertLive(entry, generation);
    signal.throwIfAborted();
    return value === undefined
      ? undefined
      : cloneBounded(value, "Runtime native system prompt", MAX_RUNTIME_NATIVE_SESSION_BYTES);
  }

  async resolveNativeCredential(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    providerValue: string,
    signal?: AbortSignal,
  ): Promise<RuntimeNativeCredentialSnapshot | undefined> {
    this.#assertPermission(entry, generation, "credentialAccess", "Native credential access");
    if (typeof providerValue !== "string" || !AUTH_PROVIDER.test(providerValue)) {
      throw new Error("Runtime native credential provider is invalid");
    }
    const selectedSignal = combinedGenerationSignal(generation, signal, "Runtime native credential query");
    const handler = this.#nativeHostHandler;
    if (handler === undefined) throw new Error("Runtime native host controls are unavailable");
    const result = await withAbort(handler.resolveCredential(providerValue, selectedSignal), selectedSignal);
    this.#assertLive(entry, generation);
    selectedSignal.throwIfAborted();
    if (result === undefined) return undefined;
    if (result.provider !== providerValue) throw new Error("Runtime native credential result changed its provider");
    return cloneBounded(result, "Runtime native credential result", 256 * 1024);
  }

  async getNativeHostConfiguration(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    signal?: AbortSignal,
  ): Promise<RuntimeHostConfigurationSnapshot> {
    this.#assertPermission(entry, generation, "hostConfiguration", "Native host configuration access");
    const selectedSignal = combinedGenerationSignal(generation, signal, "Runtime native host configuration query");
    const handler = this.#nativeHostHandler;
    if (handler === undefined) throw new Error("Runtime native host controls are unavailable");
    const result = await withAbort(handler.getConfiguration(selectedSignal), selectedSignal);
    this.#assertLive(entry, generation);
    selectedSignal.throwIfAborted();
    return cloneBounded(result, "Runtime native host configuration result", 4 * 1024 * 1024);
  }

  async updateNativeHostConfiguration(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeHostConfigurationUpdateInput,
  ): Promise<RuntimeHostConfigurationSnapshot> {
    this.#assertPermission(entry, generation, "hostConfiguration", "Native host configuration access");
    const record = runtimeSessionRecord(input, ["scope", "patch", "signal"], "Runtime native host configuration update");
    if (record.scope !== "user" && record.scope !== "project") {
      throw new Error("Runtime native host configuration scope must be user or project");
    }
    if (record.patch === null || typeof record.patch !== "object" || Array.isArray(record.patch) || !isJsonValue(record.patch)) {
      throw new Error("Runtime native host configuration patch must be a JSON object");
    }
    const selectedSignal = combinedGenerationSignal(generation, record.signal, "Runtime native host configuration update");
    const handler = this.#nativeHostHandler;
    if (handler === undefined) throw new Error("Runtime native host controls are unavailable");
    const result = await withAbort(handler.updateConfiguration({
      scope: record.scope,
      patch: cloneBounded(record.patch as JsonObject, "Runtime native host configuration patch", 4 * 1024 * 1024),
      signal: selectedSignal,
    }), selectedSignal);
    this.#assertLive(entry, generation);
    selectedSignal.throwIfAborted();
    return cloneBounded(result, "Runtime native host configuration result", 4 * 1024 * 1024);
  }

  async setActiveTools(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeActiveToolsSetInput,
  ): Promise<string[]> {
    this.#assertLive(entry, generation);
    const record = runtimeSessionRecord(input, ["threadId", "branch", "signal", "names"], "Runtime active tool update");
    const target = runtimeSessionTarget(record, "Runtime active tool update");
    const names = runtimeActiveToolNames(record.names, "Runtime active tool update");
    target.signal?.throwIfAborted();
    const handler = this.#sessionHandler;
    if (handler === undefined) throw new Error("Runtime extension active tool storage is not available");
    try {
      const selected = runtimeActiveToolNames(await handler.setActiveTools({
        ...target,
        requesterExtensionId: entry.extensionId,
        requesterSourcePath: entry.sourcePath,
        names,
      }), "Runtime active tool update result");
      this.#assertLive(entry, generation);
      target.signal?.throwIfAborted();
      return selected;
    } catch (cause) {
      this.addDiagnostic({
        extensionId: entry.extensionId,
        sourcePath: entry.sourcePath,
        message: `Active tool update failed: ${error(cause).message}`,
      });
      throw cause;
    }
  }

  async setSessionName(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeSessionNameInput,
  ): Promise<RuntimeSessionNameRecord> {
    const record = runtimeSessionRecord(input, ["threadId", "branch", "signal", "name"], "Runtime session name update");
    const target = runtimeSessionTarget(record, "Runtime session name update");
    if (record.name !== undefined && typeof record.name !== "string") throw new Error("Runtime session name is invalid");
    if (typeof record.name === "string") bounded(record.name, "Runtime session name", 1_024);
    return await this.#runSessionOperation(entry, generation, target.signal, "Runtime session name update", async (handler, signal) => {
      const result = runtimeSessionNameRecord(await handler.setSessionName({
        threadId: target.threadId,
        ...(target.branch === undefined ? {} : { branch: target.branch }),
        signal,
        ...(record.name === undefined ? {} : { name: record.name as string }),
      }), "Runtime session name update result");
      if (result.threadId !== target.threadId || (target.branch !== undefined && result.branch !== target.branch)) {
        throw new Error("Runtime session name update result changed its target");
      }
      return result;
    });
  }

  async setEntryLabel(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeEntryLabelInput,
  ): Promise<RuntimeEntryLabelRecord> {
    const record = runtimeSessionRecord(
      input,
      ["threadId", "branch", "signal", "targetEventId", "label"],
      "Runtime entry label update",
    );
    const target = runtimeSessionTarget(record, "Runtime entry label update");
    if (
      typeof record.targetEventId !== "string" || record.targetEventId === "" || record.targetEventId.includes("\0")
    ) throw new Error("Runtime entry label targetEventId is invalid");
    bounded(record.targetEventId, "Runtime entry label targetEventId", 1_024);
    if (record.label !== undefined && typeof record.label !== "string") throw new Error("Runtime entry label is invalid");
    if (typeof record.label === "string") bounded(record.label, "Runtime entry label", 1_024);
    return await this.#runSessionOperation(entry, generation, target.signal, "Runtime entry label update", async (handler, signal) => {
      const result = runtimeEntryLabelRecord(await handler.setEntryLabel({
        threadId: target.threadId,
        ...(target.branch === undefined ? {} : { branch: target.branch }),
        signal,
        targetEventId: record.targetEventId as string,
        ...(record.label === undefined ? {} : { label: record.label as string }),
      }), "Runtime entry label update result");
      if (
        result.threadId !== target.threadId ||
        result.targetEventId !== record.targetEventId ||
        (target.branch !== undefined && result.branch !== target.branch)
      ) throw new Error("Runtime entry label update result changed its target");
      return result;
    });
  }

  async #runSessionOperation<T>(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    signal: unknown,
    label: string,
    operation: (handler: RuntimeExtensionSessionHandler, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.#assertLive(entry, generation);
    const selectedSignal = combinedGenerationSignal(generation, signal, label);
    selectedSignal.throwIfAborted();
    const handler = this.#sessionHandler;
    if (handler === undefined) throw new Error("Runtime extension session controls are not available");
    const result = await withAbort(operation(handler, selectedSignal), selectedSignal);
    this.#assertLive(entry, generation);
    selectedSignal.throwIfAborted();
    return result;
  }

  async sendUserMessage(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeUserMessageInput,
  ): Promise<RuntimeUserMessageResult> {
    const record = runtimeSessionRecord(
      input,
      ["threadId", "branch", "signal", "text", "images", "delivery"],
      "Runtime user message",
    );
    const target = runtimeSessionTarget(record, "Runtime user message");
    if (typeof record.text !== "string") throw new Error("Runtime user message text is invalid");
    bounded(record.text, "Runtime user message text", 1024 * 1024);
    if (record.delivery !== undefined && record.delivery !== "steer" && record.delivery !== "follow_up") {
      throw new Error("Runtime user message delivery must be steer or follow_up");
    }
    const delivery = (record.delivery ?? "steer") as RuntimeInputDelivery;
    const images = record.images === undefined
      ? undefined
      : cloneBounded(record.images, "Runtime user message images");
    if (images !== undefined && (!Array.isArray(images) || !images.every((image) => validContentBlock(image) && (image as { type?: unknown }).type === "image"))) {
      throw new Error("Runtime user message images are invalid");
    }
    return await this.#runSessionOperation(entry, generation, target.signal, "Runtime user message", async (handler, signal) => {
      const result = await handler.sendUserMessage({
        threadId: target.threadId,
        ...(target.branch === undefined ? {} : { branch: target.branch }),
        signal,
        text: record.text as string,
        ...(images === undefined ? {} : { images: images as ImageBlock[] }),
        delivery,
        requesterExtensionId: entry.extensionId,
        requesterSourcePath: entry.sourcePath,
      });
      if (typeof result.queued !== "boolean" || result.delivery !== delivery || (result.started === true && result.queued !== true) || (result.handled === true && result.queued !== false)) {
        throw new Error("Runtime user message handler returned an invalid result");
      }
      return cloneBounded(result, "Runtime user message result");
    });
  }

  async cancelSession(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeExtensionSessionTarget & { reason?: string },
  ): Promise<boolean> {
    const record = runtimeSessionRecord(input, ["threadId", "branch", "signal", "reason"], "Runtime session abort");
    const target = runtimeSessionTarget(record, "Runtime session abort");
    if (record.reason !== undefined && typeof record.reason !== "string") throw new Error("Runtime session abort reason is invalid");
    if (typeof record.reason === "string") bounded(record.reason, "Runtime session abort reason", 4 * 1024);
    return await this.#runSessionOperation(entry, generation, target.signal, "Runtime session abort", async (handler, signal) =>
      await handler.cancel({
        threadId: target.threadId,
        ...(target.branch === undefined ? {} : { branch: target.branch }),
        signal,
        ...(record.reason === undefined ? {} : { reason: record.reason as string }),
      }));
  }

  async compactSession(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeCompactionInput,
  ): Promise<RuntimeCompactionResult> {
    const record = runtimeSessionRecord(
      input,
      ["threadId", "branch", "signal", "provider", "model", "reasoningEffort", "instructions", "contextTokenBudget", "summaryTokenBudget"],
      "Runtime session compaction",
    );
    const target = runtimeSessionTarget(record, "Runtime session compaction");
    for (const field of ["provider", "model", "reasoningEffort", "instructions"] as const) {
      if (record[field] !== undefined && typeof record[field] !== "string") throw new Error(`Runtime session compaction ${field} is invalid`);
    }
    if (typeof record.instructions === "string") bounded(record.instructions, "Runtime compaction instructions", 16 * 1024);
    for (const field of ["contextTokenBudget", "summaryTokenBudget"] as const) {
      if (record[field] !== undefined && (!Number.isSafeInteger(record[field]) || (record[field] as number) < 1)) {
        throw new Error(`Runtime session compaction ${field} is invalid`);
      }
    }
    return await this.#runSessionOperation(entry, generation, target.signal, "Runtime session compaction", async (handler, signal) =>
      await handler.compact({
        threadId: target.threadId,
        ...(target.branch === undefined ? {} : { branch: target.branch }),
        signal,
        ...(record.provider === undefined ? {} : { provider: record.provider as ProviderId }),
        ...(record.model === undefined ? {} : { model: record.model as string }),
        ...(record.reasoningEffort === undefined ? {} : { reasoningEffort: record.reasoningEffort as string }),
        ...(record.instructions === undefined ? {} : { instructions: record.instructions as string }),
        ...(record.contextTokenBudget === undefined ? {} : { contextTokenBudget: record.contextTokenBudget as number }),
        ...(record.summaryTokenBudget === undefined ? {} : { summaryTokenBudget: record.summaryTokenBudget as number }),
      }));
  }

  async runChild(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeChildRunInput,
  ): Promise<RuntimeChildRunResult> {
    const record = runtimeSessionRecord(input, [
      "threadId", "branch", "signal", "prompt", "context", "tools", "provider", "model", "reasoningEffort",
      "systemPrompt", "appendSystemPrompt", "cwd", "maxSteps", "maxOutputTokens", "timeoutMs", "outputLimitBytes",
      "session", "execution", "onStart", "onEvent",
    ], "Runtime child run");
    const target = runtimeSessionTarget(record, "Runtime child run");
    if (typeof record.prompt !== "string" || record.prompt.trim() === "") throw new Error("Runtime child run prompt is invalid");
    bounded(record.prompt, "Runtime child run prompt", MAX_RUNTIME_CHILD_PROMPT_BYTES);
    if (record.context !== "fresh" && record.context !== "fork") throw new Error("Runtime child run context must be fresh or fork");
    for (const [field, maximum] of [
      ["systemPrompt", MAX_RUNTIME_CHILD_SYSTEM_PROMPT_BYTES],
      ["appendSystemPrompt", MAX_RUNTIME_CHILD_APPENDED_INSTRUCTIONS_BYTES],
    ] as const) {
      const selected = record[field];
      if (selected === undefined) continue;
      if (typeof selected !== "string" || selected.trim() === "" || selected.includes("\0")) {
        throw new Error(`Runtime child run ${field} is invalid`);
      }
      bounded(selected, `Runtime child run ${field}`, maximum);
    }
    const tools = runtimeActiveToolNames(record.tools, "Runtime child run tools");
    if (tools.length > MAX_RUNTIME_CHILD_TOOLS) {
      throw new Error(`Runtime child run tools must contain at most ${MAX_RUNTIME_CHILD_TOOLS} names`);
    }
    for (const field of ["provider", "model", "reasoningEffort", "cwd"] as const) {
      if (record[field] !== undefined && typeof record[field] !== "string") throw new Error(`Runtime child run ${field} is invalid`);
    }
    if (typeof record.provider === "string" && !AUTH_PROVIDER.test(record.provider)) throw new Error("Runtime child run provider is invalid");
    if (typeof record.model === "string") bounded(record.model, "Runtime child run model", 1_024);
    if (typeof record.reasoningEffort === "string") bounded(record.reasoningEffort, "Runtime child run reasoningEffort", 128);
    if (typeof record.cwd === "string") bounded(record.cwd, "Runtime child run cwd", 16 * 1024);
    const numericBounds = {
      maxSteps: ABSOLUTE_CHILD_RUN_LIMITS.maxSteps,
      maxOutputTokens: 1_000_000,
      timeoutMs: ABSOLUTE_CHILD_RUN_LIMITS.maxTimeoutMs,
      outputLimitBytes: MAX_RUNTIME_CHILD_OUTPUT_BYTES,
    } as const;
    for (const [field, maximum] of Object.entries(numericBounds)) {
      const selected = record[field];
      if (selected !== undefined && (!Number.isSafeInteger(selected) || (selected as number) < 1 || (selected as number) > maximum)) {
        throw new Error(`Runtime child run ${field} must be from 1 through ${maximum}`);
      }
    }
    if (record.session !== undefined && record.session !== "ephemeral" && record.session !== "persisted") {
      throw new Error("Runtime child run session must be ephemeral or persisted");
    }
    if (record.onStart !== undefined && typeof record.onStart !== "function") {
      throw new Error("Runtime child run onStart must be a function");
    }
    if (record.onEvent !== undefined && typeof record.onEvent !== "function") {
      throw new Error("Runtime child run onEvent must be a function");
    }
    let execution: RuntimeChildExecutionSelection | undefined;
    if (record.execution !== undefined) {
      const selected = runtimeSessionRecord(
        record.execution,
        ["backend", "backendId", "requireAllTools"],
        "Runtime child run execution",
      );
      if (selected.backend !== "inherit" && selected.backend !== "local") {
        throw new Error("Runtime child run execution backend must be inherit or local");
      }
      if (selected.backendId !== undefined && (typeof selected.backendId !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/u.test(selected.backendId))) {
        throw new Error("Runtime child run execution backendId is invalid");
      }
      if (selected.requireAllTools !== undefined && typeof selected.requireAllTools !== "boolean") {
        throw new Error("Runtime child run execution requireAllTools is invalid");
      }
      if (selected.backend === "local" && (selected.backendId !== undefined || selected.requireAllTools !== undefined)) {
        throw new Error("Runtime child run local execution cannot select or require a backend");
      }
      execution = selected.backend === "local"
        ? { backend: "local" }
        : {
            backend: "inherit",
            ...(selected.backendId === undefined ? {} : { backendId: selected.backendId as string }),
            ...(selected.requireAllTools === undefined ? {} : { requireAllTools: selected.requireAllTools as boolean }),
          };
    }
    const requesterThreadId = this.#requesterThread.getStore()?.threadId;
    return await this.#runSessionOperation(entry, generation, target.signal, "Runtime child run", async (handler, signal) =>
      runtimeChildRunResult(await handler.runChild({
        threadId: target.threadId,
        ...(requesterThreadId === undefined ? {} : { requesterThreadId }),
        ...(target.branch === undefined ? {} : { branch: target.branch }),
        signal,
        prompt: record.prompt as string,
        context: record.context as "fresh" | "fork",
        tools,
        ...(record.systemPrompt === undefined ? {} : { systemPrompt: record.systemPrompt as string }),
        ...(record.appendSystemPrompt === undefined ? {} : { appendSystemPrompt: record.appendSystemPrompt as string }),
        ...(record.provider === undefined ? {} : { provider: record.provider as ProviderId }),
        ...(record.model === undefined ? {} : { model: record.model as string }),
        ...(record.reasoningEffort === undefined ? {} : { reasoningEffort: record.reasoningEffort as string }),
        ...(record.cwd === undefined ? {} : { cwd: record.cwd as string }),
        ...(record.maxSteps === undefined ? {} : { maxSteps: record.maxSteps as number }),
        ...(record.maxOutputTokens === undefined ? {} : { maxOutputTokens: record.maxOutputTokens as number }),
        ...(record.timeoutMs === undefined ? {} : { timeoutMs: record.timeoutMs as number }),
        ...(record.outputLimitBytes === undefined ? {} : { outputLimitBytes: record.outputLimitBytes as number }),
        ...(record.session === undefined ? {} : { session: record.session as "ephemeral" | "persisted" }),
        ...(execution === undefined ? {} : { execution }),
        ...(record.onStart === undefined ? {} : {
          onStart: (value: RuntimeChildSession) => {
            if (!generation.active) return;
            try {
              const session = runtimeChildSession(value, "Runtime child start");
              return this.#requesterThread.run(
                { threadId: session.threadId },
                () => (record.onStart as (session: RuntimeChildSession) => unknown)(session),
              );
            } catch (cause) {
              this.addDiagnostic({
                extensionId: entry.extensionId,
                sourcePath: entry.sourcePath,
                message: `Runtime child onStart callback failed: ${defaultSecretRedactor.redact(error(cause).message)}`,
              });
            }
          },
        }),
        ...(record.onEvent === undefined ? {} : {
          onEvent: (value: RuntimeChildEvent) => {
            if (!generation.active) return;
            try {
              const event = runtimeChildEvent(value, "Runtime child event");
              return this.#requesterThread.run(
                { threadId: event.threadId },
                () => (record.onEvent as (event: RuntimeChildEvent) => unknown)(event),
              );
            } catch (cause) {
              this.addDiagnostic({
                extensionId: entry.extensionId,
                sourcePath: entry.sourcePath,
                message: `Runtime child onEvent callback failed: ${defaultSecretRedactor.redact(error(cause).message)}`,
              });
            }
          },
        }),
      }), "Runtime child run result"));
  }

  async reload(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeExtensionSessionTarget | undefined,
  ): Promise<{ warnings: string[] }> {
    this.#assertLive(entry, generation);
    const target = input === undefined
      ? undefined
      : runtimeSessionTarget(
          runtimeSessionRecord(input, ["threadId", "branch", "signal"], "Runtime reload"),
          "Runtime reload",
        );
    const handler = this.#reloadHandler;
    if (handler === undefined) throw new Error("Runtime reload is not available in this host");
    // A successful reload invalidates the calling generation by design. Do not
    // feed that generation signal back into the reload operation itself.
    target?.signal?.throwIfAborted();
    const result = await handler({
      ...(target === undefined ? {} : {
        session: { threadId: target.threadId, ...(target.branch === undefined ? {} : { branch: target.branch }) },
      }),
      ...(target?.signal === undefined ? {} : { signal: target.signal }),
    });
    if (!Array.isArray(result.warnings) || result.warnings.some((warning) => typeof warning !== "string")) {
      throw new Error("Runtime reload handler returned an invalid result");
    }
    return { warnings: result.warnings.map((warning) => bounded(warning, "Runtime reload warning", 16 * 1024)) };
  }

  async requestShutdown(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeShutdownRequestInput = {},
  ): Promise<RuntimeShutdownRequestResult> {
    this.#assertLive(entry, generation);
    const record = runtimeSessionRecord(input, ["reason", "signal"], "Runtime shutdown request");
    if (record.reason !== undefined && typeof record.reason !== "string") {
      throw new Error("Runtime shutdown request reason is invalid");
    }
    const reason = record.reason === undefined
      ? undefined
      : bounded(record.reason as string, "Runtime shutdown request reason", 4 * 1024);
    const signal = combinedGenerationSignal(generation, record.signal, "Runtime shutdown request");
    signal.throwIfAborted();
    const requestId = createId("shutdown");
    const handler = this.#shutdownHandler;
    if (handler === undefined) {
      return {
        requestId,
        acknowledged: true,
        accepted: false,
        message: "Graceful shutdown is not available in this host.",
      };
    }
    const result = await withAbort(handler({
      requestId,
      extensionId: entry.extensionId,
      ...(reason === undefined ? {} : { reason }),
      signal,
    }), signal);
    if (result === null || typeof result !== "object" || Array.isArray(result) || typeof result.accepted !== "boolean") {
      throw new Error("Runtime shutdown handler returned an invalid acknowledgement");
    }
    if (result.message !== undefined && typeof result.message !== "string") {
      throw new Error("Runtime shutdown handler returned an invalid acknowledgement message");
    }
    return {
      requestId,
      acknowledged: true,
      accepted: result.accepted,
      ...(result.message === undefined
        ? {}
        : { message: bounded(result.message, "Runtime shutdown acknowledgement", 4 * 1024) }),
    };
  }

  async createSession(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeSessionCreateInput,
  ): Promise<RuntimeSessionSnapshot> {
    const record = runtimeSessionRecord(input, ["name", "defaultBranch", "cwd", "parentThreadId", "signal"], "Runtime new session");
    for (const field of ["name", "defaultBranch", "cwd", "parentThreadId"] as const) {
      if (record[field] !== undefined && typeof record[field] !== "string") throw new Error(`Runtime new session ${field} is invalid`);
    }
    const signal = combinedGenerationSignal(generation, record.signal, "Runtime new session");
    const result = await this.#runSessionOperation(entry, generation, signal, "Runtime new session", async (handler, selectedSignal) =>
      runtimeSessionSnapshot(await handler.createSession({
        ...(record.name === undefined ? {} : { name: bounded(record.name as string, "Runtime new session name", 1_024) }),
        ...(record.defaultBranch === undefined ? {} : { defaultBranch: bounded(record.defaultBranch as string, "Runtime new session branch", 128) }),
        ...(record.cwd === undefined ? {} : { cwd: bounded(record.cwd as string, "Runtime new session cwd", 16 * 1024) }),
        ...(record.parentThreadId === undefined
          ? {}
          : { parentThreadId: bounded(record.parentThreadId as string, "Runtime new session parentThreadId", 256) }),
        signal: selectedSignal,
      }), "Runtime new session result"));
    await withAbort(Promise.resolve(this.#sessionFocusHandler?.(result, signal)), signal);
    return result;
  }

  async forkSession(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeSessionForkInput,
  ): Promise<RuntimeSessionSnapshot> {
    const record = runtimeSessionRecord(
      input,
      ["threadId", "branch", "signal", "atEventId", "beforeEventId", "name"],
      "Runtime fork session",
    );
    const target = runtimeSessionTarget(record, "Runtime fork session");
    for (const field of ["atEventId", "beforeEventId", "name"] as const) {
      if (record[field] !== undefined && record[field] !== null && typeof record[field] !== "string") {
        throw new Error(`Runtime fork session ${field} is invalid`);
      }
    }
    const signal = combinedGenerationSignal(generation, target.signal, "Runtime fork session");
    const result = await this.#runSessionOperation(entry, generation, signal, "Runtime fork session", async (handler, selectedSignal) =>
      runtimeSessionSnapshot(await handler.forkSession({
        threadId: target.threadId,
        ...(target.branch === undefined ? {} : { branch: target.branch }),
        signal: selectedSignal,
        ...(record.atEventId === undefined ? {} : { atEventId: record.atEventId as string | null }),
        ...(record.beforeEventId === undefined ? {} : { beforeEventId: record.beforeEventId as string }),
        ...(record.name === undefined ? {} : { name: record.name as string }),
      }), "Runtime fork session result"));
    await withAbort(Promise.resolve(this.#sessionFocusHandler?.(result, signal)), signal);
    return result;
  }

  async inspectSession(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeExtensionSessionTarget,
  ): Promise<RuntimeSessionSnapshot> {
    const target = runtimeSessionTarget(
      runtimeSessionRecord(input, ["threadId", "branch", "signal"], "Runtime session query"),
      "Runtime session query",
    );
    return await this.#runSessionOperation(entry, generation, target.signal, "Runtime session query", async (handler, signal) =>
      runtimeSessionSnapshot(await handler.inspectSession({
        threadId: target.threadId,
        ...(target.branch === undefined ? {} : { branch: target.branch }),
        signal,
      }), "Runtime session query result"));
  }

  async waitForIdle(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeExtensionSessionTarget,
  ): Promise<void> {
    if ((this.#activeLifecycleListeners.get(generation) ?? 0) > 0) {
      throw new Error("Runtime waitForIdle cannot be called from a lifecycle listener because that listener may own the active run");
    }
    const target = runtimeSessionTarget(
      runtimeSessionRecord(input, ["threadId", "branch", "signal"], "Runtime idle wait"),
      "Runtime idle wait",
    );
    await this.#runSessionOperation(entry, generation, target.signal, "Runtime idle wait", async (handler, signal) => {
      await handler.waitForIdle({
        threadId: target.threadId,
        ...(target.branch === undefined ? {} : { branch: target.branch }),
        signal,
      });
    });
  }

  async switchSession(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeExtensionSessionTarget,
  ): Promise<RuntimeSessionSnapshot> {
    const target = runtimeSessionTarget(
      runtimeSessionRecord(input, ["threadId", "branch", "signal"], "Runtime session switch"),
      "Runtime session switch",
    );
    const signal = combinedGenerationSignal(generation, target.signal, "Runtime session switch");
    if (this.hasListeners("session_before_switch")) {
      const directive = await this.reduceSessionBeforeSwitch({
        reason: "resume",
        targetThreadId: target.threadId,
      }, signal);
      if (directive.cancel === true) {
        throw new Error(directive.reason ?? "Session switch cancelled by a runtime extension");
      }
    }
    const result = await this.inspectSession(entry, generation, { ...target, signal });
    const focus = this.#sessionFocusHandler;
    if (focus === undefined) throw new Error("Session switching is unavailable in this host");
    await withAbort(Promise.resolve(focus(result, signal)), signal);
    this.#assertLive(entry, generation);
    return result;
  }

  async sessionTree(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeExtensionSessionTarget,
  ): Promise<RuntimeSessionTreeRow[]> {
    const target = runtimeSessionTarget(
      runtimeSessionRecord(input, ["threadId", "branch", "signal"], "Runtime session tree"),
      "Runtime session tree",
    );
    return await this.#runSessionOperation(entry, generation, target.signal, "Runtime session tree", async (handler, signal) => {
      const rows = await handler.sessionTree({
        threadId: target.threadId,
        ...(target.branch === undefined ? {} : { branch: target.branch }),
        signal,
      });
      if (!Array.isArray(rows) || rows.length > 100_000) throw new Error("Runtime session tree result is invalid");
      return cloneBounded(rows, "Runtime session tree result");
    });
  }

  async navigateSession(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeSessionNavigateInput,
  ): Promise<RuntimeSessionNavigateResult> {
    const record = runtimeSessionRecord(input, [
      "threadId", "branch", "signal", "targetBranch", "targetEventId", "newBranch", "summarize",
      "provider", "model", "summaryTokenBudget", "summaryInstructions", "replaceInstructions", "label",
    ], "Runtime session tree navigation");
    const target = runtimeSessionTarget(record, "Runtime session tree navigation");
    for (const field of ["targetBranch", "newBranch"] as const) {
      if (typeof record[field] !== "string") throw new Error(`Runtime session tree ${field} is invalid`);
    }
    if (record.targetEventId !== null && typeof record.targetEventId !== "string") throw new Error("Runtime session tree targetEventId is invalid");
    if (record.summarize !== undefined && typeof record.summarize !== "boolean") throw new Error("Runtime session tree summarize is invalid");
    if (record.replaceInstructions !== undefined && typeof record.replaceInstructions !== "boolean") {
      throw new Error("Runtime session tree replaceInstructions is invalid");
    }
    for (const field of ["provider", "model", "summaryInstructions", "label"] as const) {
      if (record[field] !== undefined && typeof record[field] !== "string") {
        throw new Error(`Runtime session tree ${field} is invalid`);
      }
    }
    if (record.summaryTokenBudget !== undefined && (!Number.isSafeInteger(record.summaryTokenBudget) || (record.summaryTokenBudget as number) < 1)) {
      throw new Error("Runtime session tree summaryTokenBudget is invalid");
    }
    const signal = combinedGenerationSignal(generation, target.signal, "Runtime session tree navigation");
    const result = await this.#runSessionOperation(entry, generation, signal, "Runtime session tree navigation", async (handler, operationSignal) => {
      const result = await handler.navigateSession({
        threadId: target.threadId,
        ...(target.branch === undefined ? {} : { branch: target.branch }),
        signal: operationSignal,
        targetBranch: record.targetBranch as string,
        targetEventId: record.targetEventId as string | null,
        newBranch: record.newBranch as string,
        ...(record.summarize === undefined ? {} : { summarize: record.summarize as boolean }),
        ...(record.provider === undefined ? {} : { provider: record.provider as ProviderId }),
        ...(record.model === undefined ? {} : { model: record.model as string }),
        ...(record.summaryTokenBudget === undefined ? {} : { summaryTokenBudget: record.summaryTokenBudget as number }),
        ...(record.summaryInstructions === undefined ? {} : { summaryInstructions: record.summaryInstructions as string }),
        ...(record.replaceInstructions === undefined ? {} : { replaceInstructions: record.replaceInstructions as boolean }),
        ...(record.label === undefined ? {} : { label: record.label as string }),
      });
      if (typeof result.cancelled !== "boolean") throw new Error("Runtime session tree navigation result is invalid");
      return cloneBounded(result, "Runtime session tree navigation result");
    });
    if (!result.cancelled && result.branch !== undefined && this.#sessionFocusHandler !== undefined) {
      const session = await this.inspectSession(entry, generation, {
        threadId: target.threadId,
        branch: result.branch,
        signal,
      });
      await withAbort(Promise.resolve(this.#sessionFocusHandler(session, signal)), signal);
    }
    return result;
  }

  async getModel(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeExtensionSessionTarget,
  ): Promise<RuntimeModelSelection | undefined> {
    const target = runtimeSessionTarget(
      runtimeSessionRecord(input, ["threadId", "branch", "signal"], "Runtime model query"),
      "Runtime model query",
    );
    return await this.#runSessionOperation(entry, generation, target.signal, "Runtime model query", async (handler, signal) => {
      const selected = await handler.getModel({
        threadId: target.threadId,
        ...(target.branch === undefined ? {} : { branch: target.branch }),
        signal,
      });
      return selected === undefined ? undefined : runtimeModelSelection(selected, "Runtime model query result");
    });
  }

  async setModel(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeModelSelectionInput,
  ): Promise<RuntimeModelSelection> {
    const record = runtimeSessionRecord(
      input,
      ["threadId", "branch", "signal", "provider", "model", "reasoningEffort"],
      "Runtime model selection",
    );
    const target = runtimeSessionTarget(record, "Runtime model selection");
    const requested = runtimeModelSelection(record, "Runtime model selection");
    const signal = combinedGenerationSignal(generation, target.signal, "Runtime model selection");
    const selected = await this.#runSessionOperation(entry, generation, signal, "Runtime model selection", async (handler, selectedSignal) =>
      runtimeModelSelection(await handler.setModel({ ...target, ...requested, signal: selectedSignal }), "Runtime model selection result"));
    await withAbort(Promise.resolve(this.#modelFocusHandler?.(target, selected, signal)), signal);
    return selected;
  }

  async setThinking(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeThinkingSelectionInput,
  ): Promise<RuntimeModelSelection> {
    const record = runtimeSessionRecord(
      input,
      ["threadId", "branch", "signal", "reasoningEffort"],
      "Runtime thinking selection",
    );
    const target = runtimeSessionTarget(record, "Runtime thinking selection");
    if (typeof record.reasoningEffort !== "string") throw new Error("Runtime thinking level is invalid");
    bounded(record.reasoningEffort, "Runtime thinking level", 128);
    const signal = combinedGenerationSignal(generation, target.signal, "Runtime thinking selection");
    const selected = await this.#runSessionOperation(entry, generation, signal, "Runtime thinking selection", async (handler, selectedSignal) =>
      runtimeModelSelection(await handler.setThinking({
        ...target,
        reasoningEffort: record.reasoningEffort as string,
        signal: selectedSignal,
      }), "Runtime thinking selection result"));
    await withAbort(Promise.resolve(this.#modelFocusHandler?.(target, selected, signal)), signal);
    return selected;
  }

  async exec(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeExecInput,
  ): Promise<RuntimeExecResult> {
    const record = runtimeSessionRecord(
      input,
      ["command", "args", "cwd", "stdin", "timeoutMs", "outputLimitBytes", "signal"],
      "Runtime host command",
    );
    if (typeof record.command !== "string" || record.command === "") throw new Error("Runtime host command is invalid");
    bounded(record.command, "Runtime host command", 16 * 1024);
    if (record.args !== undefined && (!Array.isArray(record.args) || record.args.length > 4_096 || record.args.some((arg) => typeof arg !== "string"))) {
      throw new Error("Runtime host command arguments are invalid");
    }
    const args = (record.args as string[] | undefined)?.map((arg) => bounded(arg, "Runtime host command argument", 1024 * 1024));
    if (record.cwd !== undefined && typeof record.cwd !== "string") throw new Error("Runtime host command cwd is invalid");
    if (record.stdin !== undefined && typeof record.stdin !== "string") throw new Error("Runtime host command stdin is invalid");
    for (const field of ["timeoutMs", "outputLimitBytes"] as const) {
      if (record[field] !== undefined && (!Number.isSafeInteger(record[field]) || (record[field] as number) < 1)) {
        throw new Error(`Runtime host command ${field} is invalid`);
      }
    }
    return await this.#runSessionOperation(entry, generation, record.signal, "Runtime host command", async (handler, signal) =>
      await handler.exec({
        command: record.command as string,
        ...(args === undefined ? {} : { args }),
        ...(record.cwd === undefined ? {} : { cwd: bounded(record.cwd as string, "Runtime host command cwd", 16 * 1024) }),
        ...(record.stdin === undefined ? {} : { stdin: bounded(record.stdin as string, "Runtime host command stdin", 4 * 1024 * 1024) }),
        ...(record.timeoutMs === undefined ? {} : { timeoutMs: record.timeoutMs as number }),
        ...(record.outputLimitBytes === undefined ? {} : { outputLimitBytes: record.outputLimitBytes as number }),
        signal,
      }));
  }

  async appendExtensionState(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeExtensionStateAppendInput,
  ): Promise<RuntimeExtensionStateRecord> {
    this.#assertLive(entry, generation);
    const record = runtimeSessionRecord(
      input,
      ["threadId", "branch", "signal", "schemaVersion", "key", "value"],
      "Runtime extension state append",
    );
    const target = runtimeSessionTarget(record, "Runtime extension state append");
    target.signal?.throwIfAborted();
    const event = canonicalExtensionStateEvent({
      type: "extension_state",
      extensionId: entry.extensionId,
      schemaVersion: record.schemaVersion,
      key: record.key,
      value: record.value,
    });
    const handler = this.#sessionHandler;
    if (handler === undefined) throw new Error("Runtime extension session storage is not available");
    const result = canonicalRuntimeStateRecord(await handler.appendState({ ...target, event }));
    if (
      result.extensionId !== event.extensionId ||
      result.schemaVersion !== event.schemaVersion ||
      result.key !== event.key
    ) throw new Error("Runtime extension state storage changed entry identity");
    return result;
  }

  async compareAndAppendExtensionState(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeExtensionStateCompareAndAppendInput,
  ): Promise<RuntimeExtensionStateCompareAndAppendResult> {
    this.#assertLive(entry, generation);
    const record = runtimeSessionRecord(
      input,
      ["threadId", "branch", "signal", "schemaVersion", "key", "value", "expectedEventId"],
      "Runtime extension state compare-and-append",
    );
    const target = runtimeSessionTarget(record, "Runtime extension state compare-and-append");
    const signal = combinedGenerationSignal(generation, target.signal, "Runtime extension state compare-and-append");
    signal.throwIfAborted();
    const expectedEventId = record.expectedEventId === null
      ? null
      : runtimeRecordText(record.expectedEventId, "Runtime extension state expectedEventId");
    const event = canonicalExtensionStateEvent({
      type: "extension_state",
      extensionId: entry.extensionId,
      schemaVersion: record.schemaVersion,
      key: record.key,
      value: record.value,
    });
    const handler = this.#sessionHandler;
    if (handler === undefined) throw new Error("Runtime extension session storage is not available");
    const result = await handler.compareAndAppendState({
      ...target,
      signal,
      event,
      expectedEventId,
    });
    if (result.status === "committed") {
      const committed = canonicalRuntimeStateRecord(result.record);
      if (
        committed.threadId !== target.threadId ||
        (target.branch !== undefined && committed.branch !== target.branch) ||
        committed.extensionId !== event.extensionId ||
        committed.schemaVersion !== event.schemaVersion ||
        committed.key !== event.key
      ) throw new Error("Runtime extension state storage changed entry identity");
      return { status: "committed", record: committed };
    }
    if (result.status !== "conflict") throw new Error("Runtime extension state storage returned an invalid outcome");
    const conflict = runtimeSessionRecord(
      result,
      ["status", "threadId", "branch", "expectedEventId", "current"],
      "Runtime extension state conflict",
    );
    const conflictTarget = runtimeSessionTarget(conflict, "Runtime extension state conflict");
    if (conflictTarget.branch === undefined) throw new Error("Runtime extension state conflict branch is required");
    if (conflict.expectedEventId !== expectedEventId) {
      throw new Error("Runtime extension state conflict changed expectedEventId");
    }
    const current = conflict.current === undefined ? undefined : canonicalRuntimeStateRecord(conflict.current);
    if (
      conflictTarget.threadId !== target.threadId ||
      (target.branch !== undefined && conflictTarget.branch !== target.branch) ||
      (current !== undefined && (
        current.threadId !== conflictTarget.threadId ||
        current.branch !== conflictTarget.branch ||
        current.extensionId !== event.extensionId ||
        current.schemaVersion !== event.schemaVersion ||
        current.key !== event.key
      ))
    ) throw new Error("Runtime extension state conflict changed entry identity");
    return {
      status: "conflict",
      threadId: conflictTarget.threadId,
      branch: conflictTarget.branch,
      expectedEventId,
      ...(current === undefined ? {} : { current }),
    };
  }

  async readExtensionState(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeExtensionStateReadInput,
  ): Promise<RuntimeExtensionStateRecord | undefined> {
    this.#assertLive(entry, generation);
    const record = runtimeSessionRecord(
      input,
      ["threadId", "branch", "signal", "schemaVersion", "key"],
      "Runtime extension state read",
    );
    const target = runtimeSessionTarget(record, "Runtime extension state read");
    target.signal?.throwIfAborted();
    const schema = validateExtensionSchemaVersion(record.schemaVersion);
    const selectedKey = validateExtensionEntryKey(record.key, "Extension state key");
    const handler = this.#sessionHandler;
    if (handler === undefined) throw new Error("Runtime extension session storage is not available");
    const result = await handler.readState({
      ...target,
      extensionId: entry.extensionId,
      schemaVersion: schema,
      key: selectedKey,
    });
    if (result === undefined) return undefined;
    const selected = canonicalRuntimeStateRecord(result);
    if (
      selected.extensionId !== entry.extensionId ||
      selected.schemaVersion !== schema ||
      selected.key !== selectedKey
    ) throw new Error("Runtime extension state storage returned another namespace");
    return selected;
  }

  async appendExtensionMessage(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeExtensionMessageAppendInput,
  ): Promise<RuntimeExtensionMessageRecord> {
    this.#assertLive(entry, generation);
    const record = runtimeSessionRecord(
      input,
      [
        "threadId", "branch", "signal", "schemaVersion", "kind", "payload", "modelContext", "transcript",
        "triggerTurn", "delivery",
      ],
      "Runtime extension message append",
    );
    const target = runtimeSessionTarget(record, "Runtime extension message append");
    const signal = combinedGenerationSignal(generation, target.signal, "Runtime extension message append");
    signal.throwIfAborted();
    if (record.triggerTurn !== undefined && typeof record.triggerTurn !== "boolean") {
      throw new Error("Runtime extension message triggerTurn must be a boolean");
    }
    if (
      record.delivery !== undefined &&
      record.delivery !== "steer" && record.delivery !== "follow_up" && record.delivery !== "next_turn"
    ) throw new Error("Runtime extension message delivery is invalid");
    const event = canonicalExtensionMessageEvent({
      type: "extension_message",
      extensionId: entry.extensionId,
      schemaVersion: record.schemaVersion,
      kind: record.kind,
      messageId: createId("msg"),
      payload: record.payload,
      modelContext: record.modelContext,
      transcript: record.transcript,
    });
    const handler = this.#sessionHandler;
    if (handler === undefined) throw new Error("Runtime extension session storage is not available");
    const result = canonicalRuntimeMessageRecord(await withAbort(handler.appendMessage({
      threadId: target.threadId,
      ...(target.branch === undefined ? {} : { branch: target.branch }),
      signal,
      event,
      ...(record.triggerTurn === undefined ? {} : { triggerTurn: record.triggerTurn as boolean }),
      ...(record.delivery === undefined ? {} : { delivery: record.delivery as RuntimeUserMessageDelivery }),
    }), signal));
    this.#assertLive(entry, generation);
    signal.throwIfAborted();
    if (
      result.extensionId !== event.extensionId ||
      result.schemaVersion !== event.schemaVersion ||
      result.kind !== event.kind ||
      result.messageId !== event.messageId
    ) throw new Error("Runtime extension message storage changed entry identity");
    return result;
  }

  async readExtensionMessages(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    input: RuntimeExtensionMessagesReadInput,
  ): Promise<RuntimeExtensionMessageRecord[]> {
    this.#assertLive(entry, generation);
    const record = runtimeSessionRecord(
      input,
      ["threadId", "branch", "signal", "schemaVersion", "kind", "limit", "beforeEventId"],
      "Runtime extension messages read",
    );
    const target = runtimeSessionTarget(record, "Runtime extension messages read");
    target.signal?.throwIfAborted();
    const schema = validateExtensionSchemaVersion(record.schemaVersion);
    const kind = record.kind === undefined ? undefined : validateExtensionEntryKey(record.kind, "Extension message kind");
    const limit = record.limit ?? 100;
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_RUNTIME_SESSION_MESSAGE_READ) {
      throw new Error(`Runtime extension message limit must be from 1 through ${MAX_RUNTIME_SESSION_MESSAGE_READ}`);
    }
    const beforeEventId = record.beforeEventId === undefined
      ? undefined
      : runtimeRecordText(record.beforeEventId, "Runtime extension message beforeEventId");
    const handler = this.#sessionHandler;
    if (handler === undefined) throw new Error("Runtime extension session storage is not available");
    const results = await handler.readMessages({
      ...target,
      extensionId: entry.extensionId,
      schemaVersion: schema,
      ...(kind === undefined ? {} : { kind }),
      limit: limit as number,
      ...(beforeEventId === undefined ? {} : { beforeEventId }),
    });
    if (!Array.isArray(results) || results.length > (limit as number)) {
      throw new Error("Runtime extension message storage returned an invalid result count");
    }
    return results.map((result) => {
      const selected = canonicalRuntimeMessageRecord(result);
      if (
        selected.extensionId !== entry.extensionId ||
        selected.schemaVersion !== schema ||
        (kind !== undefined && selected.kind !== kind)
      ) throw new Error("Runtime extension message storage returned another namespace");
      return selected;
    });
  }

  registerLiveToolRenderer(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    name: string,
    renderer: RuntimeToolRenderer,
  ): void {
    this.#assertLive(entry, generation);
    if (this.#toolRenderers.has(name)) throw new Error("Runtime extension registered a duplicate tool renderer");
    this.#toolRenderers.set(name, { entry, generation, renderer });
    this.#changed("tool_renderer", entry);
  }

  registerLiveEditorRenderer(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    renderer: RuntimeEditorRenderer,
  ): void {
    this.#assertLive(entry, generation);
    if (this.#editorRenderers.some((owned) => ownerKey(owned.entry) === ownerKey(entry))) {
      throw new Error("Runtime extension registered a duplicate editor renderer");
    }
    if (this.#editorRenderers.length >= MAX_RUNTIME_EDITOR_RENDERERS) {
      throw new Error("Runtime editor renderer limit exceeded");
    }
    this.#editorRenderers.push({ entry, generation, renderer });
    this.#changed("editor_renderer", entry);
  }

  registerLiveSessionRenderer(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    schemaVersion: number,
    renderer: RuntimeExtensionSessionRenderer,
  ): void {
    this.#assertLive(entry, generation);
    const key = sessionRendererKey(entry.extensionId, validateExtensionSchemaVersion(schemaVersion));
    if (this.#sessionRenderers.has(key)) throw new Error("Runtime extension registered a duplicate session renderer");
    this.#sessionRenderers.set(key, { entry, generation, renderer });
    this.#changed("session_renderer", entry);
  }

  registerLiveListener(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    event: RuntimeExtensionEvent,
    listener: RuntimeExtensionListener<RuntimeExtensionEvent>,
  ): void {
    this.#assertLive(entry, generation);
    const listeners = this.#listeners.get(event) ?? [];
    if (event === "tool_call" && listeners.length >= MAX_TOOL_TRANSFORMATION_AUDIT_ENTRIES) {
      throw new Error(`Runtime tool_call listeners exceed ${MAX_TOOL_TRANSFORMATION_AUDIT_ENTRIES}`);
    }
    listeners.push({ entry, generation, event, listener });
    this.#listeners.set(event, listeners);
  }

  registerLiveSharedListener(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    topic: string,
    listener: RuntimeSharedEventListener,
  ): void {
    this.#assertLive(entry, generation);
    const total = [...this.#sharedListeners.values()].reduce((count, listeners) => count + listeners.length, 0);
    if (total >= MAX_RUNTIME_SHARED_EVENT_LISTENERS) {
      throw new Error(`Runtime shared event listeners exceed ${MAX_RUNTIME_SHARED_EVENT_LISTENERS}`);
    }
    const listeners = this.#sharedListeners.get(topic) ?? [];
    listeners.push({ entry, generation, topic, listener });
    this.#sharedListeners.set(topic, listeners);
  }

  async dispatchShared(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    topicValue: string,
    payload: JsonValue,
    signal?: AbortSignal,
  ): Promise<void> {
    this.#assertLive(entry, generation);
    const topic = key(topicValue, "Shared event topic");
    const emitterSignal = combinedGenerationSignal(generation, signal, "Runtime shared event");
    const snapshot = cloneBounded(payload, "Runtime shared event payload", 1024 * 1024);
    const failures: unknown[] = [];
    for (const owned of [...(this.#sharedListeners.get(topic) ?? [])]) {
      const listenerSignal = AbortSignal.any([emitterSignal, owned.generation.abortController.signal]);
      try {
        this.#assertLive(owned.entry, owned.generation);
        listenerSignal.throwIfAborted();
        await withAbort(
          Promise.resolve(owned.listener(
            cloneBounded(snapshot, "Runtime shared event payload", 1024 * 1024),
            this.#listenerContext(owned, listenerSignal),
          )),
          listenerSignal,
        );
      } catch (cause) {
        if (listenerSignal.aborted) throw abortError(listenerSignal);
        failures.push(cause);
        this.#recordOwnedFailure(owned.entry, `shared event ${topic}`, cause);
      }
    }
    emitterSignal.throwIfAborted();
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `Runtime shared event ${topic} listeners failed`);
  }

  registerLiveDisposer(dispose: () => void | Promise<void>): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    this.#disposers.push(dispose);
  }

  #assertLive(entry: ExtensionRuntimeEntry, generation: RuntimeExtensionGeneration): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    if (!generation.active) throw new Error(`Runtime extension context is no longer active: ${entry.extensionId}`);
  }

  #assertPermission(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    permission: keyof NonNullable<ExtensionRuntimeEntry["permissions"]>,
    label: string,
  ): void {
    this.#assertLive(entry, generation);
    if (entry.trusted !== true || entry.permissions?.[permission] !== true) {
      throw new Error(`${label} requires a trusted manifest with permissions.${permission} enabled: ${entry.extensionId}`);
    }
  }

  async #withLifecycleListener<T>(owned: Pick<OwnedListener, "generation">, operation: () => Promise<T>): Promise<T> {
    this.#activeLifecycleListeners.set(
      owned.generation,
      (this.#activeLifecycleListeners.get(owned.generation) ?? 0) + 1,
    );
    try {
      return await operation();
    } finally {
      const remaining = (this.#activeLifecycleListeners.get(owned.generation) ?? 1) - 1;
      if (remaining === 0) this.#activeLifecycleListeners.delete(owned.generation);
      else this.#activeLifecycleListeners.set(owned.generation, remaining);
    }
  }

  #withRequesterThread<T>(event: RuntimeExtensionEvent, value: unknown, operation: () => T): T {
    const session = runtimeRequesterSession(event, value);
    return session === undefined ? operation() : this.#requesterThread.run({ threadId: session.threadId }, operation);
  }

  #changed(change: RuntimeExtensionChange, entry: ExtensionRuntimeEntry): void {
    for (const listener of this.#changeListeners) {
      try {
        listener(change);
      } catch (cause) {
        this.addDiagnostic({
          extensionId: entry.extensionId,
          sourcePath: entry.sourcePath,
          message: `Runtime ${change} presentation refresh failed: ${error(cause).message.slice(0, 4096)}`,
        });
      }
    }
  }

  #resolvedCommands(): Array<{ command: OwnedCommand; invocationName: string }> {
    const counts = new Map<string, number>();
    for (const command of this.#commands) {
      counts.set(command.registration.name, (counts.get(command.registration.name) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    return this.#commands.map((command) => {
      const base = command.registration.name;
      const occurrence = (seen.get(base) ?? 0) + 1;
      seen.set(base, occurrence);
      return {
        command,
        invocationName: (counts.get(base) ?? 0) > 1 ? `${base}:${occurrence}` : base,
      };
    });
  }

  hasCommand(name: string): boolean {
    return this.#resolvedCommands().some((entry) => entry.invocationName === name);
  }

  async runCommand(
    name: string,
    context: Omit<RuntimeCommandContext, "workspace" | "ui" | "mode" | "hasUI" | "isProjectTrusted"> & { ui?: RuntimeCommandUi },
  ): Promise<{ handled: boolean; prompt?: string }> {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    const selected = this.#resolvedCommands().find((entry) => entry.invocationName === name)?.command;
    if (selected === undefined) return { handled: false };
    this.#assertLive(selected.entry, selected.generation);
    const signal = combinedGenerationSignal(selected.generation, context.signal, "Runtime command");
    const listenerContext = this.#listenerContext(selected, signal);
    const ui = context.ui ?? listenerContext.ui;
    try {
      const result = await withAbort(Promise.resolve().then(async () => await selected.registration.execute({
        ...context,
        ui,
        workspace: this.#workspace,
        signal,
        mode: listenerContext.mode,
        hasUI: listenerContext.hasUI,
        isProjectTrusted: listenerContext.isProjectTrusted,
      })), signal);
      if (result === undefined) return { handled: true };
      let prompt: string | undefined;
      if (typeof result === "string") {
        prompt = result;
      } else if (result !== null && typeof result === "object") {
        if (result.prompt !== undefined && typeof result.prompt !== "string") {
          throw new Error("Runtime command returned an invalid result");
        }
        prompt = result.prompt;
      } else {
        throw new Error("Runtime command returned an invalid result");
      }
      if (prompt === undefined) return { handled: true };
      return { handled: true, prompt: bounded(prompt, "Runtime command prompt", 1024 * 1024) };
    } catch (cause) {
      if (signal.aborted) throw abortError(signal);
      this.#recordOwnedFailure(selected.entry, "command", cause);
      return { handled: true };
    }
  }

  async completeCommandArguments(name: string, prefix: string, signal?: AbortSignal): Promise<RuntimeCommandCompletion[] | null> {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    bounded(prefix, "Runtime command completion prefix", 64 * 1024);
    const selected = this.#resolvedCommands().find((entry) => entry.invocationName === name)?.command;
    if (selected === undefined || selected.registration.getArgumentCompletions === undefined) return null;
    this.#assertLive(selected.entry, selected.generation);
    try {
      signal?.throwIfAborted();
      const pending = Promise.resolve().then(async () => await selected.registration.getArgumentCompletions!(prefix, signal));
      const result = signal === undefined
        ? await pending
        : await new Promise<readonly RuntimeCommandCompletion[] | null>((resolve, reject) => {
            const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Command completion cancelled"));
            signal.addEventListener("abort", abort, { once: true });
            void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
          });
      signal?.throwIfAborted();
      this.#assertLive(selected.entry, selected.generation);
      if (result === null) return null;
      if (!Array.isArray(result) || result.length > 256) throw new Error("Runtime command completion result is invalid");
      return result.map((item) => {
        if (item === null || typeof item !== "object" || typeof item.value !== "string") {
          throw new Error("Runtime command completion item is invalid");
        }
        bounded(item.value, "Runtime command completion value", 64 * 1024);
        if (item.label !== undefined) bounded(item.label, "Runtime command completion label", 4 * 1024);
        if (item.detail !== undefined) bounded(item.detail, "Runtime command completion detail", 16 * 1024);
        return { ...item };
      });
    } catch (cause) {
      if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error("Command completion cancelled");
      this.#recordOwnedFailure(selected.entry, "command completion", cause);
      return null;
    }
  }

  hasAutocompleteProviders(): boolean {
    if (this.#closed) return false;
    return this.#autocompleteProviders.some((owned) => owned.generation.active);
  }

  hasEditorMiddleware(): boolean {
    if (this.#closed) return false;
    return this.#editorMiddleware.some((owned) => owned.generation.active);
  }

  async completeInput(
    context: RuntimeAutocompleteContext,
    signal?: AbortSignal,
  ): Promise<RuntimeAutocompleteCompletion[] | null> {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    if (context === null || typeof context !== "object" || typeof context.text !== "string") {
      throw new Error("Runtime autocomplete context is invalid");
    }
    bounded(context.text, "Runtime autocomplete text", 256 * 1024);
    const length = splitGraphemes(context.text).length;
    if (!Number.isSafeInteger(context.cursor) || context.cursor < 0 || context.cursor > length) {
      throw new Error("Runtime autocomplete cursor is invalid");
    }
    signal?.throwIfAborted();
    const completions: RuntimeAutocompleteCompletion[] = [];
    const seen = new Set<string>();
    for (const owned of [...this.#autocompleteProviders]) {
      if (!owned.generation.active) continue;
      const providerSignal = signal === undefined
        ? owned.generation.abortController.signal
        : AbortSignal.any([signal, owned.generation.abortController.signal]);
      try {
        providerSignal.throwIfAborted();
        const result = await withAbort(Promise.resolve(owned.provider(
          Object.freeze({ text: context.text, cursor: context.cursor }),
          providerSignal,
        )), providerSignal);
        if (result === null) continue;
        if (!Array.isArray(result) || result.length > 256) throw new Error("Runtime autocomplete result is invalid");
        for (const item of result) {
          if (item === null || typeof item !== "object"
            || !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end)
            || item.start < 0 || item.end < item.start || item.end > length
            || typeof item.value !== "string") throw new Error("Runtime autocomplete item is invalid");
          const value = bounded(item.value, "Runtime autocomplete value", 64 * 1024);
          const label = item.label === undefined ? undefined : bounded(item.label, "Runtime autocomplete label", 4 * 1024);
          const detail = item.detail === undefined ? undefined : bounded(item.detail, "Runtime autocomplete detail", 16 * 1024);
          const key = `${item.start}\0${item.end}\0${value}`;
          if (seen.has(key)) continue;
          seen.add(key);
          completions.push({
            start: item.start,
            end: item.end,
            value,
            ...(label === undefined ? {} : { label }),
            ...(detail === undefined ? {} : { detail }),
          });
          if (completions.length >= 256) break;
        }
      } catch (cause) {
        if (signal?.aborted === true) throw abortError(signal);
        if (!owned.generation.active) continue;
        this.#recordOwnedFailure(owned.entry, "autocomplete", cause);
      }
      if (completions.length >= 256) break;
    }
    signal?.throwIfAborted();
    return completions.length === 0 ? null : completions;
  }

  handleEditorInput(
    event: RuntimeEditorMiddlewareEvent,
    snapshot: RuntimeEditorSnapshot,
  ): RuntimeEditorMiddlewareResult {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    if (event === null || typeof event !== "object" || typeof event.key !== "string"
      || typeof event.ctrl !== "boolean" || typeof event.alt !== "boolean" || typeof event.shift !== "boolean") {
      throw new Error("Runtime editor middleware event is invalid");
    }
    bounded(event.key, "Runtime editor middleware key", 128);
    if (event.text !== undefined) bounded(event.text, "Runtime editor middleware event text", 256 * 1024);
    if (snapshot === null || typeof snapshot !== "object" || typeof snapshot.text !== "string") {
      throw new Error("Runtime editor snapshot is invalid");
    }
    bounded(snapshot.text, "Runtime editor snapshot text", 256 * 1024);
    let current: RuntimeEditorSnapshot = {
      text: snapshot.text,
      cursor: snapshot.cursor,
    };
    if (!Number.isSafeInteger(current.cursor) || current.cursor < 0 || current.cursor > splitGraphemes(current.text).length) {
      throw new Error("Runtime editor snapshot cursor is invalid");
    }
    let changed = false;
    for (const owned of [...this.#editorMiddleware]) {
      if (!owned.generation.active) continue;
      try {
        const result = owned.middleware(Object.freeze({
          key: event.key,
          ...(event.text === undefined ? {} : { text: sanitizeTerminalText(event.text) }),
          ctrl: event.ctrl,
          alt: event.alt,
          shift: event.shift,
        }), Object.freeze({ ...current }), owned.generation.abortController.signal);
        if (result === undefined || result.action === "pass") continue;
        if (result.action === "handled") return { action: "handled" };
        if (result.action !== "replace" || typeof result.text !== "string") throw new Error("Runtime editor middleware result is invalid");
        const text = bounded(result.text, "Runtime editor middleware replacement", 256 * 1024);
        const length = splitGraphemes(text).length;
        const cursor = result.cursor ?? length;
        if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > length) throw new Error("Runtime editor middleware cursor is invalid");
        current = { text, cursor };
        changed = true;
      } catch (cause) {
        if (!owned.generation.active) continue;
        this.#recordOwnedFailure(owned.entry, "editor middleware", cause);
      }
    }
    return changed ? { action: "replace", ...current } : { action: "pass" };
  }

  hasShortcut(shortcut: string): boolean {
    return this.#shortcuts.has(normalizeShortcut(shortcut));
  }

  async runShortcut(
    shortcut: string,
    context: Omit<RuntimeShortcutContext, "workspace" | "mode" | "hasUI" | "isProjectTrusted">,
  ): Promise<{ handled: boolean }> {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    const selected = this.#shortcuts.get(normalizeShortcut(shortcut));
    if (selected === undefined) return { handled: false };
    this.#assertLive(selected.entry, selected.generation);
    const signal = combinedGenerationSignal(selected.generation, context.signal, "Runtime shortcut");
    try {
      const listenerContext = this.#listenerContext(selected, signal);
      await withAbort(Promise.resolve().then(async () => await selected.registration.execute({
        ...context,
        workspace: this.#workspace,
        signal,
        mode: listenerContext.mode,
        hasUI: listenerContext.hasUI,
        isProjectTrusted: listenerContext.isProjectTrusted,
      })), signal);
    } catch (cause) {
      if (signal.aborted) throw abortError(signal);
      this.#recordOwnedFailure(selected.entry, "shortcut", cause);
    }
    return { handled: true };
  }

  #listenerContext(
    owned: Pick<OwnedListener, "entry" | "generation">,
    signal: AbortSignal,
    selectedSession?: RuntimeRequesterSession,
  ): RuntimeExtensionListenerContext {
    const interactive = this.#interactiveUiHandler?.(owned.entry.extensionId, signal);
    const unavailable = async (): Promise<never> => {
      throw new Error("Interactive extension UI is unavailable in this host");
    };
    const ui: RuntimeCommandUi = interactive ?? {
      notify: (message, kind = "status") => this.applyUi({
        extensionId: owned.entry.extensionId,
        type: "notify",
        value: bounded(message, "Notification"),
        kind,
      }),
      setStatus: (statusKey, value) => this.applyUi({
        extensionId: owned.entry.extensionId,
        type: "status",
        key: key(statusKey, "Status key"),
        value: bounded(value ?? "", "Status"),
      }),
      setWidget: (widgetKey, value) => this.applyUi({
        extensionId: owned.entry.extensionId,
        type: "widget",
        key: key(widgetKey, "Widget key"),
        value: bounded(value ?? "", "Widget"),
      }),
      setHeader: (headerKey, value) => this.applyUi({
        extensionId: owned.entry.extensionId,
        type: "header",
        key: key(headerKey, "Header key"),
        value: bounded(value ?? "", "Header"),
      }),
      setFooter: (footerKey, value) => this.applyUi({
        extensionId: owned.entry.extensionId,
        type: "footer",
        key: key(footerKey, "Footer key"),
        value: bounded(value ?? "", "Footer"),
      }),
      setWorkingMessage: (value) => this.applyUi({
        extensionId: owned.entry.extensionId,
        type: "working_message",
        value: bounded(value ?? "", "Working message", 4 * 1024),
      }),
      setWorkingVisible: (visible) => {
        if (visible !== undefined && typeof visible !== "boolean") throw new Error("Working visibility must be boolean or undefined");
        this.applyUi({
          extensionId: owned.entry.extensionId,
          type: "working_visible",
          value: "",
          ...(visible === undefined ? {} : { visible }),
        });
      },
      setTitle: (value) => this.applyUi({
        extensionId: owned.entry.extensionId,
        type: "title",
        value: bounded(value, "Title", 1_024),
      }),
      getTheme: unavailable,
      setTheme: unavailable,
      select: unavailable,
      confirm: unavailable,
      input: unavailable,
      editor: unavailable,
      setEditorText: () => { throw new Error("Interactive extension UI is unavailable in this host"); },
      getEditorText: () => { throw new Error("Interactive extension UI is unavailable in this host"); },
      custom: unavailable,
      showOverlay: () => { throw new Error("Interactive extension UI is unavailable in this host"); },
    };
    const hasUI = this.#mode === "tui" || this.#mode === "rpc";
    const session = selectedSession === undefined
      ? undefined
      : Object.freeze({
          threadId: selectedSession.threadId,
          ...(selectedSession.branch === undefined ? {} : { branch: selectedSession.branch }),
          ...(selectedSession.runId === undefined ? {} : { runId: selectedSession.runId }),
          ...(selectedSession.step === undefined ? {} : { step: selectedSession.step }),
          get: async () => await this.inspectSession(owned.entry, owned.generation, {
            threadId: selectedSession.threadId,
            ...(selectedSession.branch === undefined ? {} : { branch: selectedSession.branch }),
            signal,
          }),
          getModel: async () => await this.getModel(owned.entry, owned.generation, {
            threadId: selectedSession.threadId,
            ...(selectedSession.branch === undefined ? {} : { branch: selectedSession.branch }),
            signal,
          }),
          getUsage: async () => await this.getSessionUsage(owned.entry, owned.generation, {
            threadId: selectedSession.threadId,
            ...(selectedSession.branch === undefined ? {} : { branch: selectedSession.branch }),
            signal,
          }),
          getSystemPrompt: async () => await this.getSystemPromptSnapshot(owned.entry, owned.generation, {
            threadId: selectedSession.threadId,
            ...(selectedSession.branch === undefined ? {} : { branch: selectedSession.branch }),
            signal,
          }),
          isIdle: async () => !(await this.inspectSession(owned.entry, owned.generation, {
            threadId: selectedSession.threadId,
            ...(selectedSession.branch === undefined ? {} : { branch: selectedSession.branch }),
            signal,
          })).active,
          hasPendingMessages: async () => {
            const snapshot = await this.inspectSession(owned.entry, owned.generation, {
              threadId: selectedSession.threadId,
              ...(selectedSession.branch === undefined ? {} : { branch: selectedSession.branch }),
              signal,
            });
            return (snapshot.pendingMessageCount ?? 0) > 0 || (snapshot.recoverableMessageCount ?? 0) > 0;
          },
          abort: async (reason?: string) => await this.cancelSession(owned.entry, owned.generation, {
            threadId: selectedSession.threadId,
            ...(selectedSession.branch === undefined ? {} : { branch: selectedSession.branch }),
            signal,
            ...(reason === undefined ? {} : { reason }),
          }),
          compact: async (input: Parameters<RuntimeListenerSessionContext["compact"]>[0] = {}) =>
            await this.compactSession(owned.entry, owned.generation, {
              threadId: selectedSession.threadId,
              ...(selectedSession.branch === undefined ? {} : { branch: selectedSession.branch }),
              signal,
              ...input,
            }),
        } satisfies RuntimeListenerSessionContext);
    return Object.freeze({
      extensionId: owned.entry.extensionId,
      sourcePath: owned.entry.sourcePath,
      workspace: this.#workspace,
      signal,
      mode: this.#mode,
      hasUI,
      isProjectTrusted: () => this.#projectTrusted,
      ui: Object.freeze(ui),
      ...(session === undefined ? {} : { session }),
    });
  }

  #runtimeToolContext(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    context: ToolContext,
  ): RuntimeToolContext {
    this.#assertLive(entry, generation);
    const signal = combinedGenerationSignal(generation, context.signal, "Runtime tool");
    const listener = this.#listenerContext({ entry, generation }, signal);
    return Object.freeze({
      ...context,
      signal,
      extensionId: entry.extensionId,
      sourcePath: entry.sourcePath,
      hasUI: listener.hasUI,
      mode: listener.mode,
      isProjectTrusted: listener.isProjectTrusted,
      ui: listener.ui,
    });
  }

  async dispatch<K extends RuntimeExtensionEvent>(
    event: K,
    value: RuntimeExtensionEventMap[K],
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    if (event === "project_trust") throw new Error("Use resolveProjectTrust for the project_trust decision lifecycle");
    const dispatchSignal = signal ?? (
      event === "session_start" || event === "session_end" || event === "session_shutdown"
        ? AbortSignal.timeout(this.#shutdownTimeoutMs)
        : undefined
    );
    const failures: unknown[] = [];
    const snapshot = cloneBounded(value, `Runtime ${event} event`);
    const listeners = event === "event" && isRuntimeUserShellEvent(snapshot)
      ? [...(this.#listeners.get("event") ?? []), ...(this.#listeners.get("user_shell") ?? [])]
      : this.#listeners.get(event) ?? [];
    const invoke = async (owned: OwnedListener): Promise<void> => {
      try {
        this.#assertLive(owned.entry, owned.generation);
        const listenerSignal = dispatchSignal === undefined
          ? owned.generation.abortController.signal
          : AbortSignal.any([dispatchSignal, owned.generation.abortController.signal]);
        listenerSignal.throwIfAborted();
        const listenerSnapshot = event === "event"
          ? observedEventForListener(snapshot as RuntimeObservedEvent, owned.entry.extensionId)
          : snapshot;
        const listenerEvent = freezeRuntimeRunEvent(
          event,
          cloneBounded(listenerSnapshot, `Runtime ${event} listener event`),
        );
        const context = this.#listenerContext(owned, listenerSignal, runtimeRequesterSession(event, listenerEvent));
        await this.#withLifecycleListener(owned, async () => await this.#withRequesterThread(
          event,
          listenerEvent,
          async () => await withAbort(Promise.resolve(owned.listener(listenerEvent, context)), listenerSignal),
        ));
      } catch (cause) {
        failures.push(cause);
        this.#recordListenerFailure(owned, cause);
      }
    };
    if (event === "session_shutdown") await Promise.all(listeners.map(invoke));
    else for (const owned of listeners) await invoke(owned);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `Runtime extension ${event} listeners failed`);
  }

  #recordListenerFailure(owned: OwnedListener, cause: unknown): void {
    this.#recordOwnedFailure(owned.entry, owned.event, cause);
  }

  #recordOwnedFailure(entry: ExtensionRuntimeEntry, operation: string, cause: unknown): void {
    this.addDiagnostic({
      extensionId: entry.extensionId,
      sourcePath: entry.sourcePath,
      message: `Runtime ${operation} handler failed: ${defaultSecretRedactor.redact(error(cause).message).slice(0, 4096)}`,
    });
  }

  async #reduce<K extends RuntimeExtensionEvent, T>(
    event: K,
    initial: T,
    step: (
      current: T,
      listener: (value: RuntimeExtensionEventMap[K]) => RuntimeExtensionEventResultMap[K] | Promise<RuntimeExtensionEventResultMap[K]>,
      entry: ExtensionRuntimeEntry,
    ) => Promise<{ value: T; stop?: boolean }>,
    options: { failClosed?: (cause: unknown, current: T) => T; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    let current = initial;
    for (const owned of this.#listeners.get(event) ?? []) {
      options.signal?.throwIfAborted();
      const listenerSignal = options.signal === undefined
        ? owned.generation.abortController.signal
        : AbortSignal.any([options.signal, owned.generation.abortController.signal]);
      try {
        this.#assertLive(owned.entry, owned.generation);
        listenerSignal.throwIfAborted();
        const ownedListener = owned.listener as unknown as RuntimeExtensionListener<K>;
        const listener = (value: RuntimeExtensionEventMap[K]) => {
          const context = this.#listenerContext(owned, listenerSignal, runtimeRequesterSession(event, value));
          return this.#withRequesterThread(
            event,
            value,
            () => ownedListener(
              freezeRuntimeRunEvent(event, value),
              context as RuntimeExtensionListenerContextFor<K>,
            ),
          );
        };
        const next = await this.#withLifecycleListener(owned, async () => await withAbort(
          step(current, listener, owned.entry),
          listenerSignal,
        ));
        current = next.value;
        if (next.stop === true) break;
      } catch (cause) {
        if (listenerSignal.aborted) throw abortError(listenerSignal);
        this.#recordListenerFailure(owned, cause);
        if (options.failClosed !== undefined) {
          current = options.failClosed(cause, current);
          break;
        }
      }
    }
    options.signal?.throwIfAborted();
    return current;
  }

  async reduceInput(event: RuntimeInputEvent, signal?: AbortSignal): Promise<RuntimeInputResult> {
    const original = cloneBounded(event, "Runtime input event");
    const state = await this.#reduce("input", {
      event: original,
      transformed: false,
      handled: false,
    }, async (current, listener) => {
      const result = await listener(cloneBounded(current.event, "Runtime input event"));
      if (result === undefined || result.action === "continue") return { value: current };
      if (result.action === "handled") return { value: { ...current, handled: true }, stop: true };
      if (result.action !== "transform" || typeof result.text !== "string") {
        throw new Error("Runtime input listener returned an invalid result");
      }
      bounded(result.text, "Runtime transformed input", 1024 * 1024);
      if (
        result.images !== undefined &&
        (!Array.isArray(result.images) || !result.images.every((image) => validContentBlock(image) && image.type === "image"))
      ) throw new Error("Runtime input listener returned invalid transformed images");
      const next: RuntimeInputEvent = {
        ...current.event,
        text: result.text,
        ...(result.images === undefined
          ? (current.event.images === undefined ? {} : { images: current.event.images })
          : { images: cloneBounded(result.images, "Runtime transformed input images") }),
      };
      return { value: { event: next, transformed: true, handled: false } };
    }, signal === undefined ? {} : { signal });
    if (state.handled) return { action: "handled" };
    if (!state.transformed) return { action: "continue" };
    return {
      action: "transform",
      text: state.event.text,
      ...(state.event.images === undefined ? {} : { images: state.event.images }),
    };
  }

  async reduceBeforeUserShell(
    event: RuntimeBeforeUserShellEvent,
    signal?: AbortSignal,
  ): Promise<RuntimeBeforeUserShellReduction> {
    const initial = runtimeSessionRecord(event, ["command", "cwd", "hidden"], "Runtime before-user-shell event");
    const command = runtimeUserShellCommand(initial.command);
    const cwd = runtimeUserShellCwd(initial.cwd);
    if (typeof initial.hidden !== "boolean") throw new Error("Runtime before-user-shell hidden must be a boolean");
    const hidden = initial.hidden;
    const state = await this.#reduce("before_user_shell", {
      command,
      cwd,
      result: undefined as RuntimeUserShellResult | undefined,
    }, async (current, listener) => {
      const result = await listener(Object.freeze({
        command: current.command,
        cwd: current.cwd,
        hidden,
      }));
      if (result === undefined) return { value: current };
      const candidate = runtimeSessionRecord(
        result,
        ["action", "command", "cwd", "result"],
        "Runtime before_user_shell result",
      );
      const selected = candidate.action === "continue"
        ? runtimeSessionRecord(result, ["action"], "Runtime before_user_shell result")
        : candidate.action === "transform"
          ? runtimeSessionRecord(result, ["action", "command", "cwd"], "Runtime before_user_shell result")
          : candidate.action === "handled"
            ? runtimeSessionRecord(result, ["action", "result"], "Runtime before_user_shell result")
            : candidate;
      if (selected.action === "continue") return { value: current };
      if (selected.action === "handled") {
        return {
          value: {
            ...current,
            result: canonicalRuntimeUserShellResult(selected.result),
          },
          stop: true,
        };
      }
      if (selected.action !== "transform" || (selected.command === undefined && selected.cwd === undefined)) {
        throw new Error("Runtime before_user_shell listener returned an invalid result");
      }
      return {
        value: {
          ...current,
          command: selected.command === undefined
            ? current.command
            : runtimeUserShellCommand(selected.command, "Runtime transformed user-shell command"),
          cwd: selected.cwd === undefined
            ? current.cwd
            : runtimeUserShellCwd(selected.cwd, "Runtime transformed user-shell cwd"),
        },
      };
    }, signal === undefined ? {} : { signal });
    if (state.result === undefined) return { action: "execute", command: state.command, cwd: state.cwd };
    return {
      action: "handled",
      command: state.command,
      cwd: state.cwd,
      result: state.result,
    };
  }

  async reduceBeforeAgentStart(event: RuntimeBeforeAgentStartEvent, signal?: AbortSignal): Promise<RuntimeBeforeAgentStartReduction> {
    const initial = cloneBounded(event, "Runtime before-agent event");
    const snapshot = (systemPrompt: string): RuntimeNativeSystemPromptSnapshot => Object.freeze({
      threadId: initial.threadId,
      runId: initial.runId,
      branch: initial.branch,
      ...(initial.step === undefined ? {} : { step: initial.step }),
      prompt: initial.prompt,
      systemPrompt,
      ...(initial.images === undefined ? {} : { images: cloneBounded(initial.images, "Runtime native prompt images") }),
      ...(initial.promptComposition === undefined ? {} : { composition: structuredClone(initial.promptComposition) }),
    });
    const reduced = await this.#reduce("before_agent_start", {
      messages: [] as CanonicalMessage[],
      systemPrompt: initial.systemPrompt,
    }, async (current, listener) => {
      const currentSnapshot = snapshot(current.systemPrompt);
      const result = await this.#currentSystemPrompt.run(
        currentSnapshot,
        async () => await listener({ ...initial, systemPrompt: current.systemPrompt }),
      );
      if (result === undefined) return { value: current };
      const messages = result.messages === undefined
        ? current.messages
        : [...current.messages, ...canonicalMessages(result.messages, "Runtime injected messages")];
      const systemPrompt = result.systemPrompt === undefined ? current.systemPrompt : result.systemPrompt;
      bounded(systemPrompt, "Runtime system prompt", 4 * 1024 * 1024);
      return { value: { messages, systemPrompt } };
    }, signal === undefined ? {} : { signal });
    this.#systemPrompts.set(`${initial.threadId}\0${initial.branch}`, snapshot(reduced.systemPrompt));
    return reduced;
  }

  async reduceBeforeProviderRequest(
    event: RuntimeBeforeProviderRequestEvent,
    signal?: AbortSignal,
  ): Promise<RuntimeProviderRequestFields> {
    const identity = cloneBounded({
      threadId: event.threadId,
      runId: event.runId,
      branch: event.branch,
      step: event.step,
      provider: event.provider,
      model: event.model,
    }, "Runtime before_provider_request identity");
    const initial = runtimeProviderRequestFields(event.request, "Runtime before_provider_request request");
    return await this.#reduce("before_provider_request", initial, async (current, listener) => {
      const result = await listener({
        ...identity,
        request: cloneBounded(current, "Runtime before_provider_request listener request"),
      });
      if (result === undefined) return { value: current };
      return { value: applyRuntimeProviderRequestPatch(current, result) };
    }, signal === undefined ? {} : { signal });
  }

  async reduceContext(event: RuntimeContextEvent, signal?: AbortSignal): Promise<CanonicalMessage[]> {
    const initial = cloneBounded(event, "Runtime context event");
    const identity = {
      threadId: initial.threadId,
      runId: initial.runId,
      branch: initial.branch,
      ...(initial.step === undefined ? {} : { step: initial.step }),
    };
    return await this.#reduce("context", canonicalMessages(initial.messages, "Runtime context messages"), async (current, listener) => {
      const result = await listener({ ...identity, messages: current });
      if (result?.messages === undefined) return { value: current };
      return { value: canonicalMessages(result.messages, "Runtime context messages") };
    }, signal === undefined ? {} : { signal });
  }

  async reduceMessageEnd(event: RuntimeMessageEvent, signal?: AbortSignal): Promise<CanonicalMessage> {
    return (await this.reduceFinalizedMessageEnd(event, signal)).message;
  }

  async reduceFinalizedMessageEnd(event: RuntimeMessageEvent, signal?: AbortSignal): Promise<RuntimeMessageEndReduction> {
    const initial = cloneBounded(event, "Runtime message event");
    const identity = {
      threadId: initial.threadId,
      runId: initial.runId,
      branch: initial.branch,
      ...(initial.step === undefined ? {} : { step: initial.step }),
    };
    const initialMessage = canonicalMessages([initial.message], "Runtime message")[0]!;
    const initialFinalized = initial.finalized === undefined
      ? undefined
      : runtimeFinalizedResponse(initial.finalized, "Runtime finalized assistant response", true);
    return await this.#reduce("message_end", {
      message: initialMessage,
      ...(initialFinalized === undefined ? {} : { finalized: initialFinalized }),
    } as RuntimeMessageEndReduction, async (current, listener, entry) => {
      const result = await listener({
        ...identity,
        message: current.message,
        ...(current.finalized === undefined ? {} : { finalized: runtimeFinalizedResponseView(current.finalized) }),
      });
      if (result === undefined) return { value: current };
      const selected = runtimeSessionRecord(result, ["message", "finalized"], "Runtime message_end result");
      let replacement = current.message;
      if (selected.message !== undefined) {
        replacement = canonicalMessages([selected.message], "Runtime message replacement")[0]!;
        if (replacement.role !== current.message.role) throw new Error("Runtime message replacement cannot change the message role");
        if (replacement.id !== current.message.id) throw new Error("Runtime message replacement cannot change the message ID");
        if (replacement.createdAt !== current.message.createdAt) throw new Error("Runtime message replacement cannot change the creation time");
      }
      let finalized = current.finalized;
      if (selected.finalized !== undefined) {
        if (finalized === undefined) {
          throw new Error("Runtime message_end finalized fields are available only for a finalized assistant response");
        }
        const patch = runtimeSessionRecord(
          selected.finalized,
          ["finishReason", "usage", "rawReason", "explanation"],
          "Runtime finalized assistant response patch",
        );
        const finishReason = patch.finishReason === undefined
          ? finalized.finishReason
          : runtimeFinishReason(patch.finishReason, "Runtime finalized assistant response finishReason");
        if (finishReason !== finalized.finishReason && (
          replacement.content.some((block) => block.type === "tool_call") ||
          !RUNTIME_SAFE_EXTENSION_FINISH_REASONS.has(finishReason)
        )) {
          throw new Error("Runtime message_end cannot change tool-control or internal terminal finish semantics");
        }
        const usage = patch.usage === undefined
          ? finalized.usage
          : (() => {
              const replacement = runtimeFinalizedUsage(
                patch.usage,
                "Runtime finalized assistant response usage",
              );
              return isDeepStrictEqual(replacement, runtimeFinalizedResponseView(finalized).usage)
                ? finalized.usage
                : replacement;
            })();
        const patchText = (field: "rawReason" | "explanation"): string | undefined => {
          const value = patch[field];
          if (value === undefined) return finalized?.[field];
          if (value === null) return undefined;
          if (typeof value !== "string") throw new Error(`Runtime finalized assistant response ${field} is invalid`);
          return bounded(value, `Runtime finalized assistant response ${field}`, 16 * 1024);
        };
        const rawReason = patchText("rawReason");
        const explanation = patchText("explanation");
        finalized = {
          finishReason,
          ...(usage === undefined ? {} : { usage }),
          ...(rawReason === undefined ? {} : { rawReason }),
          ...(explanation === undefined ? {} : { explanation }),
        };
      }
      const fields: AssistantResponseTransformationField[] = [];
      if (!isDeepStrictEqual(replacement, current.message)) fields.push("message");
      if (finalized?.finishReason !== current.finalized?.finishReason) fields.push("finishReason");
      if (!isDeepStrictEqual(finalized?.usage, current.finalized?.usage)) fields.push("usage");
      if (finalized?.rawReason !== current.finalized?.rawReason) fields.push("rawReason");
      if (finalized?.explanation !== current.finalized?.explanation) fields.push("explanation");
      const transformations = fields.length === 0
        ? current.transformations
        : [...(current.transformations ?? []), { actor: entry.extensionId, fields }];
      return {
        value: {
          message: replacement,
          ...(finalized === undefined ? {} : { finalized }),
          ...(transformations === undefined ? {} : { transformations }),
        },
      };
    }, signal === undefined ? {} : { signal });
  }

  async reduceToolCall(event: RuntimeToolCallEvent, signal?: AbortSignal): Promise<RuntimeToolCallReduction> {
    const initial: RuntimeToolCallReduction = {
      invocation: Object.freeze(cloneBounded(event, "Runtime tool call")),
      blocked: false,
    };
    return await this.#reduce("tool_call", initial, async (current, listener, entry) => {
      const offered = cloneBounded(current.invocation, "Runtime tool call listener input");
      const result = await listener(Object.freeze(offered));
      const selected = result === undefined
        ? undefined
        : runtimeSessionRecord(result, ["input", "block", "reason"], "Runtime tool_call result");
      if (selected?.block !== undefined && typeof selected.block !== "boolean") {
        throw new Error("Runtime tool_call block must be boolean");
      }
      if (selected?.reason !== undefined && typeof selected.reason !== "string") {
        throw new Error("Runtime tool_call reason must be a string");
      }
      const candidate = selected?.input === undefined ? offered.input : selected.input;
      if (!isJsonValue(candidate)) throw new Error("Runtime tool call input is not JSON-safe");
      const transformed = !isDeepStrictEqual(candidate, current.invocation.input);
      const invocation: RuntimeToolCallEvent = transformed
        ? Object.freeze({
            ...current.invocation,
            input: cloneBounded(candidate, "Runtime transformed tool input"),
          })
        : current.invocation;
      const transformations = transformed
        ? [...(current.transformations ?? []), { actor: entry.extensionId }]
        : current.transformations;
      if (selected?.block !== true) return {
        value: {
          ...current,
          invocation,
          ...(transformations === undefined ? {} : { transformations }),
        },
      };
      const reason = selected.reason === undefined ? undefined : bounded(selected.reason, "Runtime tool block reason", 16 * 1024);
      return {
        value: {
          invocation,
          blocked: true,
          ...(transformations === undefined ? {} : { transformations }),
          ...(reason === undefined ? {} : { reason }),
        },
        stop: true,
      };
    }, {
      failClosed: (cause, current) => ({
        invocation: current.invocation,
        blocked: true,
        ...(current.transformations === undefined ? {} : { transformations: current.transformations }),
        reason: `Runtime extension failed before tool execution: ${error(cause).message.slice(0, 1024)}`,
      }),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async reduceToolResult(event: RuntimeToolResultEvent, signal?: AbortSignal): Promise<ToolResult> {
    const initial = {
      threadId: event.threadId,
      runId: event.runId,
      branch: event.branch,
      ...(event.step === undefined ? {} : { step: event.step }),
      invocation: cloneBounded(event.invocation, "Runtime tool invocation"),
      result: validateResult(cloneBounded(event.result, "Runtime tool result")),
    };
    const reduced = await this.#reduce("tool_result", initial, async (current, listener) => {
      const patch = await listener(current);
      if (patch === undefined) return { value: current };
      if (patch.metadata !== undefined && !isJsonValue(patch.metadata)) throw new Error("Runtime tool result metadata is not JSON-safe");
      const result: ToolResult = validateResult({
        ...current.result,
        ...(patch.content === undefined ? {} : { content: patch.content }),
        ...(patch.isError === undefined ? {} : { isError: patch.isError }),
        ...(patch.terminate === undefined ? {} : { terminate: patch.terminate }),
        ...(patch.metadata === undefined ? {} : { metadata: patch.metadata }),
        ...(patch.artifacts === undefined ? {} : { artifacts: cloneBounded(patch.artifacts, "Runtime tool artifacts") }),
        ...(patch.images === undefined ? {} : { images: cloneBounded(patch.images, "Runtime tool images") }),
      });
      return {
        value: {
          threadId: current.threadId,
          runId: current.runId,
          branch: current.branch,
          ...(current.step === undefined ? {} : { step: current.step }),
          invocation: current.invocation,
          result,
        },
      };
    }, signal === undefined ? {} : { signal });
    return validateResult(cloneBounded(reduced.result, "Runtime tool result"));
  }

  async reduceSessionBeforeSwitch(event: RuntimeSessionBeforeSwitchEvent, signal?: AbortSignal): Promise<RuntimeSessionGuardResult> {
    return await this.#reduceGuard("session_before_switch", event, signal);
  }

  async reduceSessionBeforeFork(event: RuntimeSessionBeforeForkEvent, signal?: AbortSignal): Promise<RuntimeSessionGuardResult> {
    return await this.#reduceGuard("session_before_fork", event, signal);
  }

  async reduceSessionBeforeTree(event: RuntimeSessionBeforeTreeEvent, signal?: AbortSignal): Promise<RuntimeTreeResult> {
    return await this.#reduce("session_before_tree", {} as RuntimeTreeResult, async (current, listener) => {
      const result = await listener({
        ...cloneBounded({
          threadId: event.threadId,
          preparation: event.preparation,
          targetEventId: event.targetEventId,
          summarize: event.summarize,
          sourceEventIds: event.sourceEventIds,
        }, "Runtime tree event"),
        signal: event.signal,
      });
      if (result === undefined) return { value: current };
      if (result === null || typeof result !== "object" || Array.isArray(result)) {
        throw new Error("Runtime tree result must be an object");
      }
      if (result.cancel !== undefined && typeof result.cancel !== "boolean") {
        throw new Error("Runtime tree cancellation must be a boolean");
      }
      if (result.reason !== undefined) {
        if (typeof result.reason !== "string") throw new Error("Runtime tree cancellation reason must be a string");
        bounded(result.reason, "Runtime tree cancellation reason", 16 * 1024);
      }
      if (result.summary !== undefined) {
        if (result.summary === null || typeof result.summary !== "object" || Array.isArray(result.summary)) {
          throw new Error("Runtime tree summary must be an object");
        }
        if (typeof result.summary.text !== "string" || result.summary.text.trim() === "") {
          throw new Error("Runtime tree summary must be a non-empty string");
        }
        bounded(result.summary.text, "Runtime tree summary", MAX_RUNTIME_TREE_SUMMARY_BYTES);
        if (result.summary.metadata !== undefined && !isJsonValue(result.summary.metadata)) {
          throw new Error("Runtime tree summary metadata is not JSON-safe");
        }
        if (
          result.summary.metadata !== undefined &&
          Buffer.byteLength(JSON.stringify(result.summary.metadata), "utf8") > MAX_RUNTIME_TREE_METADATA_BYTES
        ) throw new Error(`Runtime tree summary metadata exceeds ${MAX_RUNTIME_TREE_METADATA_BYTES} bytes`);
      }
      if (result.customInstructions !== undefined) {
        if (typeof result.customInstructions !== "string") throw new Error("Runtime tree instructions must be a string");
        bounded(result.customInstructions, "Runtime tree instructions", MAX_RUNTIME_TREE_INSTRUCTIONS_BYTES);
      }
      if (result.replaceInstructions !== undefined && typeof result.replaceInstructions !== "boolean") {
        throw new Error("Runtime tree replaceInstructions must be a boolean");
      }
      if (result.label !== undefined) {
        if (
          typeof result.label !== "string" ||
          Buffer.byteLength(result.label, "utf8") > MAX_RUNTIME_TREE_LABEL_BYTES ||
          /[\u0000-\u001f\u007f-\u009f]/u.test(result.label)
        ) throw new Error(`Runtime tree label must fit ${MAX_RUNTIME_TREE_LABEL_BYTES} bytes without control characters`);
      }
      const value = cloneBounded(result, "Runtime tree result");
      return { value, stop: value.cancel === true };
    }, signal === undefined ? {} : { signal });
  }

  async reduceSessionBeforeCompact(event: RuntimeSessionBeforeCompactEvent): Promise<RuntimeSessionBeforeCompactResult> {
    return await this.#reduce("session_before_compact", {} as RuntimeSessionBeforeCompactResult, async (current, listener) => {
      const result = await listener({
        threadId: event.threadId,
        runId: event.runId,
        branch: event.branch,
        ...(event.step === undefined ? {} : { step: event.step }),
        plan: cloneBounded(event.plan, "Runtime compaction plan"),
        ...(event.customInstructions === undefined ? {} : { customInstructions: event.customInstructions }),
        signal: event.signal,
      });
      if (result === undefined) return { value: current };
      if (result.reason !== undefined) bounded(result.reason, "Runtime compaction cancellation reason", 16 * 1024);
      if (result.compaction !== undefined) {
        bounded(result.compaction.text, "Runtime compaction summary", 4 * 1024 * 1024);
        if (result.compaction.metadata !== undefined && !isJsonValue(result.compaction.metadata)) {
          throw new Error("Runtime compaction metadata is not JSON-safe");
        }
      }
      const value = cloneBounded(result, "Runtime compaction result");
      return { value, stop: value.cancel === true };
    }, { signal: event.signal });
  }

  async #reduceGuard<K extends "session_before_switch" | "session_before_fork">(
    eventName: K,
    event: RuntimeExtensionEventMap[K],
    signal?: AbortSignal,
  ): Promise<RuntimeSessionGuardResult> {
    return await this.#reduce(eventName, {} as RuntimeSessionGuardResult, async (current, listener) => {
      const result = await listener(cloneBounded(event, "Runtime session event"));
      if (result === undefined) return { value: current };
      if (result.reason !== undefined) bounded(result.reason, "Runtime session cancellation reason", 16 * 1024);
      const value = cloneBounded(result, "Runtime session result") as RuntimeSessionGuardResult;
      return { value, stop: value.cancel === true };
    }, signal === undefined ? {} : { signal });
  }

  #renderBlock(
    selected: OwnedRenderer<unknown>,
    slot: string,
    context: RuntimeUiRenderContext,
    render: (context: RuntimeUiRenderContext) => RuntimeUiBlock | undefined,
  ): RuntimeUiBlock | undefined {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    if (!selected.generation.active) throw new Error(`Runtime extension context is no longer active: ${selected.entry.extensionId}`);
    try {
      const safeContext = sanitizeRuntimeUiRenderContext(context);
      const value = render(safeContext);
      if (value === undefined) return undefined;
      return sanitizeRuntimeUiBlock(value, { width: safeContext.width });
    } catch (cause) {
      const detail = defaultSecretRedactor.redact(error(cause).message).slice(0, 4096);
      const failureKey = `${selected.entry.extensionId}\u0000${selected.entry.sourcePath}\u0000${slot}\u0000${detail}`;
      if (!this.#rendererFailureKeys.has(failureKey) && this.#rendererFailureKeys.size < MAX_RENDERER_FAILURE_DIAGNOSTICS) {
        this.#rendererFailureKeys.add(failureKey);
        this.addDiagnostic({
          extensionId: selected.entry.extensionId,
          sourcePath: selected.entry.sourcePath,
          message: `Runtime ${slot} renderer failed: ${detail}`,
        });
      }
      return undefined;
    }
  }

  #diagnoseCrossExtensionToolCollision(
    entry: ExtensionRuntimeEntry,
    name: string,
    prior: HarnessTool,
  ): boolean {
    const owner = this.#toolOwners.get(prior);
    if (
      owner === undefined ||
      (owner.extensionId === entry.extensionId && owner.sourcePath === entry.sourcePath)
    ) return false;
    this.addDiagnostic({
      extensionId: entry.extensionId,
      sourcePath: entry.sourcePath,
      message: `Runtime tool ${name} from ${entry.extensionId} (${entry.sourcePath}) was ignored because ${owner.extensionId} (${owner.sourcePath}) registered it first`,
    });
    return true;
  }

  commit(staged: StagedActivation): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    if (staged.committed) throw new Error("Runtime extension activation is already committed");
    if (this.#initialUi.length + staged.ui.length > MAX_RUNTIME_INITIAL_UI_OPERATIONS) {
      throw new Error(`Runtime extension initial UI exceeds ${MAX_RUNTIME_INITIAL_UI_OPERATIONS} operations`);
    }
    const tools = lastRegistrations(staged.tools, (tool) => tool.name);
    const commands = lastRegistrations(staged.commands, (command) => command.name);
    const shortcuts = lastRegistrations(staged.shortcuts, (shortcut) => shortcut.shortcut);
    const flags = lastRegistrations(staged.flags, (flag) => flag.name);
    const sessionRenderers = lastRegistrations(staged.sessionRenderers, (entry) => String(entry.schemaVersion));
    const providerIds = new Set(staged.providers.map((provider) => provider.id));
    const providerAuthIds = new Set(staged.providerAuth.map((descriptor) => descriptor.provider));
    const toolRendererNames = new Set(staged.toolRenderers.map((entry) => entry.name));
    const sharedListenerCount = [...this.#sharedListeners.values()].reduce((count, listeners) => count + listeners.length, 0);
    if (sharedListenerCount + staged.sharedListeners.length > MAX_RUNTIME_SHARED_EVENT_LISTENERS) {
      throw new Error(`Runtime shared event listeners exceed ${MAX_RUNTIME_SHARED_EVENT_LISTENERS}`);
    }
    const toolCallListenerCount = staged.listeners.filter((listener) => listener.event === "tool_call").length;
    if ((this.#listeners.get("tool_call")?.length ?? 0) + toolCallListenerCount > MAX_TOOL_TRANSFORMATION_AUDIT_ENTRIES) {
      throw new Error(`Runtime tool_call listeners exceed ${MAX_TOOL_TRANSFORMATION_AUDIT_ENTRIES}`);
    }
    const reservedCommand = commands.find((command) => isBuiltinSlashCommand(command.name));
    if (reservedCommand !== undefined) throw new Error(`Runtime extension command name is reserved: ${reservedCommand.name}`);
    if (providerIds.size !== staged.providers.length || staged.providers.some((provider) => this.#providers.has(provider.id))) throw new Error("Runtime extension registered a duplicate provider");
    if (providerAuthIds.size !== staged.providerAuth.length || staged.providerAuth.some((descriptor) => this.#providerAuth.has(descriptor.provider))) {
      throw new Error("Runtime extension registered a duplicate provider auth descriptor");
    }
    if (toolRendererNames.size !== staged.toolRenderers.length || staged.toolRenderers.some((entry) => this.#toolRenderers.has(entry.name))) throw new Error("Runtime extension registered a duplicate tool renderer");
    if (staged.editorRenderers.length > 1 || this.#editorRenderers.length + staged.editorRenderers.length > MAX_RUNTIME_EDITOR_RENDERERS) {
      throw new Error("Runtime editor renderer limit exceeded");
    }
    // Extension tools use first-owner wins across packages. Re-registering within
    // one activation keeps the last definition, matching ordinary map semantics.
    for (const tool of tools) {
      const prior = this.#tools.get(tool.name);
      if (prior === undefined) {
        const runtimeTool = new RuntimeHarnessTool(
          tool,
          (context) => this.#runtimeToolContext(staged.entry, staged.generation, context),
          async (context, execute) => await this.#requesterThread.run({ threadId: context.threadId }, execute),
        );
        this.#tools.set(tool.name, runtimeTool);
        this.#toolOwners.set(runtimeTool, {
          kind: "extension",
          extensionId: staged.entry.extensionId,
          sourcePath: staged.entry.sourcePath,
        });
      } else this.#diagnoseCrossExtensionToolCollision(staged.entry, tool.name, prior);
    }
    for (const command of commands) this.#commands.push({
      entry: staged.entry,
      generation: staged.generation,
      registration: command,
    });
    for (const provider of staged.autocompleteProviders) this.#autocompleteProviders.push({
      entry: staged.entry,
      generation: staged.generation,
      provider,
    });
    for (const middleware of staged.editorMiddleware) this.#editorMiddleware.push({
      entry: staged.entry,
      generation: staged.generation,
      middleware,
    });
    for (const shortcut of shortcuts) {
      const prior = this.#shortcuts.get(shortcut.shortcut);
      this.#shortcuts.set(shortcut.shortcut, {
        entry: staged.entry,
        generation: staged.generation,
        registration: shortcut,
      });
      if (prior !== undefined && prior.entry.extensionId !== staged.entry.extensionId) {
        this.addDiagnostic({
          extensionId: staged.entry.extensionId,
          sourcePath: staged.entry.sourcePath,
          message: `Runtime shortcut ${shortcut.shortcut} replaced the registration from ${prior.entry.extensionId}`,
        });
      }
    }
    for (const flag of flags) {
      const prior = this.#flags.get(flag.name);
      if (prior === undefined) {
        this.#flags.set(flag.name, {
          entry: staged.entry,
          generation: staged.generation,
          registration: flag,
          owners: new Set([ownerKey(staged.entry)]),
        });
        const initialValue = staged.flagDefaults.get(flag.name);
        if (initialValue !== undefined && !this.#flagValues.has(flag.name)) this.#flagValues.set(flag.name, initialValue);
      } else {
        prior.owners.add(ownerKey(staged.entry));
      }
    }
    for (const provider of staged.providers) {
      this.#providers.set(provider.id, provider);
      this.#providerOwners.set(provider.id, { entry: staged.entry, generation: staged.generation });
    }
    for (const override of staged.providerOverrides) this.#providerOverrides.push({
      ...override,
      entry: staged.entry,
      generation: staged.generation,
    });
    for (const overlay of staged.providerOverlays) this.#providerOverlays.push({
      ...overlay,
      entry: staged.entry,
      generation: staged.generation,
    });
    for (const wire of staged.providerWires) this.#providerWires.push({
      ...wire,
      entry: staged.entry,
      generation: staged.generation,
    });
    for (const descriptor of staged.providerAuth) this.#providerAuth.set(descriptor.provider, {
      extensionId: staged.entry.extensionId,
      sourcePath: staged.entry.sourcePath,
      descriptor,
    });
    for (const entry of staged.toolRenderers) this.#toolRenderers.set(entry.name, {
      entry: staged.entry,
      generation: staged.generation,
      renderer: entry.renderer,
    });
    for (const renderer of staged.editorRenderers) this.#editorRenderers.push({
      entry: staged.entry,
      generation: staged.generation,
      renderer,
    });
    for (const entry of sessionRenderers) this.#sessionRenderers.set(
      sessionRendererKey(staged.entry.extensionId, entry.schemaVersion),
      {
        entry: staged.entry,
        generation: staged.generation,
        renderer: entry.renderer,
      },
    );
    for (const listener of staged.listeners) {
      const listeners = this.#listeners.get(listener.event) ?? [];
      listeners.push({
        entry: staged.entry,
        generation: staged.generation,
        event: listener.event,
        listener: listener.listener,
      });
      this.#listeners.set(listener.event, listeners);
    }
    for (const listener of staged.sharedListeners) {
      const listeners = this.#sharedListeners.get(listener.topic) ?? [];
      listeners.push({
        entry: staged.entry,
        generation: staged.generation,
        topic: listener.topic,
        listener: listener.listener,
      });
      this.#sharedListeners.set(listener.topic, listeners);
    }
    this.#disposers.push(...staged.disposers);
    this.#moduleDisposers.push(...staged.moduleDisposers);
    this.#initialUi.push(...staged.ui);
    this.#initialAdvancedUi.push(...staged.advancedUi);
    this.#generations.push(staged.generation);
    staged.committed = true;
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    if (this.#closed) return Promise.resolve();
    this.#closing = this.#close().finally(() => { this.#closing = undefined; });
    return this.#closing;
  }

  async #close(): Promise<void> {
    if (this.#closed) return;
    // Each category gets one fresh phase budget. This keeps a hung shutdown
    // listener from starving disposers, or a hung live-registration cleanup
    // from preventing module-loader cleanup. The asynchronous upper bound is
    // four sequential shutdownTimeoutMs phases, independent of callback count.
    const shutdownSignal = AbortSignal.timeout(this.#shutdownTimeoutMs);
    await this.dispatch(
      "session_shutdown",
      { reason: "host_close", workspace: this.#workspace },
      shutdownSignal,
    ).catch(() => undefined);
    this.#closed = true;
    for (const generation of this.#generations) {
      generation.active = false;
      generation.abortController.abort(new Error("Runtime extension host closed"));
    }
    this.#generations.length = 0;
    const failures: unknown[] = [];
    failures.push(...await runRuntimeCleanupPhase(
      this.#disposers.splice(0).reverse(),
      this.#shutdownTimeoutMs,
      "Runtime extension disposer cleanup",
    ));
    failures.push(...await runRuntimeCleanupPhase(
      [
        ...[...this.#providerAuthCleanups.values()].reverse(),
        ...[...this.#providerCleanups.values()].reverse(),
        ...this.#registrationCleanups.splice(0).reverse(),
      ],
      this.#shutdownTimeoutMs,
      "Runtime live registration cleanup",
    ));
    this.#providerCleanups.clear();
    this.#providerAuthCleanups.clear();
    const hostImports = runtimeHostImportControllers.get(this);
    runtimeHostImportControllers.delete(this);
    const moduleDisposers = this.#moduleDisposers.splice(0).reverse();
    if (hostImports !== undefined) moduleDisposers.unshift(() => hostImports.close());
    failures.push(...await runRuntimeCleanupPhase(
      moduleDisposers,
      this.#shutdownTimeoutMs,
      "Runtime module loader cleanup",
    ));
    this.#tools.clear();
    this.#commands.length = 0;
    this.#autocompleteProviders.length = 0;
    this.#editorMiddleware.length = 0;
    this.#editorRenderers.length = 0;
    this.#shortcuts.clear();
    this.#flags.clear();
    this.#flagValues.clear();
    this.#providers.clear();
    this.#providerOwners.clear();
    this.#providerOverrides.length = 0;
    this.#providerOverlays.length = 0;
    this.#providerWires.length = 0;
    this.#providerAuth.clear();
    this.#toolRenderers.clear();
    this.#sessionRenderers.clear();
    this.#listeners.clear();
    this.#sharedListeners.clear();
    this.#systemPrompts.clear();
    for (const host of this.#nativeUiHosts.values()) host.dispose();
    this.#nativeUiHosts.clear();
    for (const host of this.#unsafeTerminalHosts.values()) host.dispose();
    this.#unsafeTerminalHosts.clear();
    this.#initialUi.length = 0;
    this.#initialAdvancedUi.length = 0;
    this.#changeListeners.clear();
    this.#liveRegistrationHandler = undefined;
    this.#sessionHandler = undefined;
    this.#nativeHostHandler = undefined;
    this.#nativeUiHandler = undefined;
    this.#unsafeTerminalHandler = undefined;
    this.#uiHandler = undefined;
    this.#advancedUiHandler = undefined;
    this.#interactiveUiHandler = undefined;
    this.#reloadHandler = undefined;
    this.#shutdownHandler = undefined;
    this.#sessionFocusHandler = undefined;
    this.#modelFocusHandler = undefined;
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Runtime extension disposers failed");
  }
}

async function runtimeEntryUsesCommonJs(sourcePath: string): Promise<boolean> {
  const extension = extname(sourcePath).toLowerCase();
  if (extension === ".mjs" || extension === ".mts") return false;
  let directory = dirname(sourcePath);
  const root = parse(directory).root;
  while (true) {
    const packagePath = join(directory, "package.json");
    try {
      const bytes = await readFile(packagePath);
      if (bytes.byteLength > 1024 * 1024) throw new Error(`Nearest package.json exceeds 1048576 bytes: ${packagePath}`);
      const manifest = JSON.parse(bytes.toString("utf8")) as unknown;
      return !(manifest !== null && typeof manifest === "object" && !Array.isArray(manifest)
        && (manifest as Record<string, unknown>)["type"] === "module");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (directory === root) return true;
    directory = dirname(directory);
  }
}

export interface RuntimeExtensionLoadOptions {
  workspace: string;
  dataRoot?: string;
  mode?: RuntimeExtensionMode;
  projectTrusted?: boolean;
  signal?: AbortSignal;
  /** Per-entry activation bound. */
  activationTimeoutMs?: number;
  /** Aggregate bound for loading and activating the complete entry list. */
  loadTimeoutMs?: number;
  /** Default resource discovery bound when discoverResources receives no signal. */
  resourceDiscoveryTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  activationFailure?: "diagnostic" | "throw";
}

async function activateRuntimeExtensionEntries(
  host: RuntimeExtensionHost,
  entries: readonly ExtensionRuntimeEntry[],
  options: RuntimeExtensionLoadOptions,
): Promise<void> {
  const activationTimeoutMs = options.activationTimeoutMs ?? DEFAULT_RUNTIME_EXTENSION_ACTIVATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(activationTimeoutMs) || activationTimeoutMs < 1 || activationTimeoutMs > 300_000) {
    throw new RangeError("Runtime extension activationTimeoutMs must be from 1 through 300000");
  }
  const loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_RUNTIME_EXTENSION_LOAD_TIMEOUT_MS;
  if (!Number.isSafeInteger(loadTimeoutMs) || loadTimeoutMs < 1 || loadTimeoutMs > 300_000) {
    throw new RangeError("Runtime extension loadTimeoutMs must be from 1 through 300000");
  }
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_RUNTIME_EXTENSION_SHUTDOWN_TIMEOUT_MS;
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1 || shutdownTimeoutMs > 300_000) {
    throw new RangeError("Runtime extension shutdownTimeoutMs must be from 1 through 300000");
  }
  const activationFailure = options.activationFailure ?? "diagnostic";
  if (activationFailure !== "diagnostic" && activationFailure !== "throw") {
    throw new TypeError("Runtime extension activationFailure must be diagnostic or throw");
  }
  const workspace = await realpath(resolve(options.workspace));
  if (host.workspace !== workspace) throw new Error("Runtime extension host belongs to a different workspace");
  const existing = new Set(host.extensions().map((entry) => entry.sourcePath));
  const duplicate = entries.find((entry) => existing.has(entry.sourcePath));
  if (duplicate !== undefined) throw new Error(`Runtime extension is already active: ${duplicate.sourcePath}`);
  const dataRoot = resolve(options.dataRoot ?? host.dataRoot);
  const hostImports = runtimeHostImportControllers.get(host);
  if (hostImports === undefined) throw new Error("Runtime extension host does not support incremental activation");
  hostImports.add(entries);
  const loadTimeoutSignal = AbortSignal.timeout(loadTimeoutMs);
  for (const entry of entries) {
    options.signal?.throwIfAborted();
    let staged: StagedActivation | undefined;
    const activationTimeoutSignal = AbortSignal.timeout(activationTimeoutMs);
    const entrySignal = options.signal === undefined
      ? AbortSignal.any([loadTimeoutSignal, activationTimeoutSignal])
      : AbortSignal.any([options.signal, loadTimeoutSignal, activationTimeoutSignal]);
    try {
      entrySignal.throwIfAborted();
      const bytes = await withAbort(readFile(entry.sourcePath), entrySignal);
      if (sha256(bytes) !== entry.sha256) throw new Error("Runtime entry changed after extension discovery");
      const dataPathPreparation = prepareExtensionDataPaths(
        extensionDataPaths(dataRoot, workspace, entry),
        entrySignal,
      );
      let dataPaths: RuntimeExtensionDataPaths;
      try {
        dataPaths = await withAbort(dataPathPreparation, entrySignal);
      } catch (cause) {
        // Filesystem directory preparation cannot be cancelled. Drain it so a
        // timed-out load cannot recreate extension state after the host returns.
        await dataPathPreparation.catch(() => undefined);
        throw cause;
      }
      const activationResult = activation(entry, workspace, dataPaths, host);
      staged = activationResult.staged;
      const signal = AbortSignal.any([staged.generation.abortController.signal, entrySignal]);
      const importGeneration = String(++runtimeImportGeneration);
      const namespace = `rigyn-runtime-${importGeneration}`;
      let importPromise: Promise<unknown>;
      if (await withAbort(runtimeEntryUsesCommonJs(entry.sourcePath), signal)) {
        const loader = registerTsxCommonJsLoader({ namespace });
        staged.moduleDisposers.push(async () => loader.unregister());
        hostImports.refresh();
        importPromise = Promise.resolve().then(() => loader.require(entry.sourcePath, import.meta.url));
      } else {
        const url = pathToFileURL(entry.sourcePath);
        url.searchParams.set("sha256", entry.sha256);
        url.searchParams.set("generation", importGeneration);
        const loader = registerTsxModuleLoader({ namespace });
        staged.moduleDisposers.push(async () => await loader.unregister());
        hostImports.refresh();
        importPromise = loader.import(url.href, import.meta.url);
      }
      const module = await withAbort(
        importPromise,
        signal,
      );
      const moduleRecord = module !== null && (typeof module === "object" || typeof module === "function")
        ? module as { default?: unknown; activate?: unknown }
        : undefined;
      const commonJsDefault = moduleRecord?.default !== null && typeof moduleRecord?.default === "object"
        ? moduleRecord.default as { default?: unknown; activate?: unknown }
        : undefined;
      const activate = typeof module === "function"
        ? module
        : typeof moduleRecord?.default === "function"
          ? moduleRecord.default
          : typeof moduleRecord?.activate === "function"
            ? moduleRecord.activate
          : typeof commonJsDefault?.default === "function"
            ? commonJsDefault.default
            : commonJsDefault?.activate;
      if (typeof activate !== "function") throw new Error("Runtime entry must export a default or named activate function");
      await withAbort(Promise.resolve(activate(activationResult.api)), signal);
      host.commit(activationResult.staged);
    } catch (cause) {
      const cleanupFailures: Error[] = [];
      if (staged !== undefined) {
        staged.generation.active = false;
        staged.generation.abortController.abort(new Error("Runtime extension activation failed"));
        host.rollbackNativeUi(staged.generation);
        host.rollbackUnsafeTerminal(staged.generation);
        cleanupFailures.push(...await runRuntimeCleanupPhase(
          staged.disposers.splice(0).reverse(),
          shutdownTimeoutMs,
          "Runtime extension activation disposer cleanup",
        ));
        cleanupFailures.push(...await runRuntimeCleanupPhase(
          staged.moduleDisposers.splice(0).reverse(),
          shutdownTimeoutMs,
          "Runtime extension activation module cleanup",
        ));
      }
      if (options.signal?.aborted === true) {
        throw abortError(options.signal);
      }
      const activationError = loadTimeoutSignal.aborted
        ? new Error(`Runtime extension load timed out after ${loadTimeoutMs}ms`)
        : activationTimeoutSignal.aborted
          ? new Error(`Runtime extension activation timed out after ${activationTimeoutMs}ms`)
          : error(cause);
      if (activationFailure === "throw") {
        const failures: unknown[] = [activationError, ...cleanupFailures];
        if (failures.length > 1) {
          throw new AggregateError(failures, "Runtime extension activation and cleanup failed");
        }
        throw activationError;
      }
      host.addDiagnostic({
        extensionId: entry.extensionId,
        sourcePath: entry.sourcePath,
        message: activationError.message,
      });
      for (const cleanupFailure of cleanupFailures) {
        host.addDiagnostic({
          extensionId: entry.extensionId,
          sourcePath: entry.sourcePath,
          message: cleanupFailure.message,
        });
      }
      if (loadTimeoutSignal.aborted) break;
    }
  }
}

/** Appends new entries to an existing generation without reactivating prior entries. */
export async function appendRuntimeExtensions(
  host: RuntimeExtensionHost,
  entries: readonly ExtensionRuntimeEntry[],
  options: RuntimeExtensionLoadOptions,
): Promise<void> {
  await activateRuntimeExtensionEntries(host, entries, options);
}

export async function loadRuntimeExtensions(
  entries: readonly ExtensionRuntimeEntry[],
  options: RuntimeExtensionLoadOptions,
): Promise<RuntimeExtensionHost> {
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_RUNTIME_EXTENSION_SHUTDOWN_TIMEOUT_MS;
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1 || shutdownTimeoutMs > 300_000) {
    throw new RangeError("Runtime extension shutdownTimeoutMs must be from 1 through 300000");
  }
  const workspace = await realpath(resolve(options.workspace));
  const dataRoot = resolve(options.dataRoot ?? join(workspace, ".rigyn", "state", "extension-data"));
  const host = new RuntimeExtensionHost(workspace, {
    shutdownTimeoutMs,
    dataRoot,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.projectTrusted === undefined ? {} : { projectTrusted: options.projectTrusted }),
    ...(options.resourceDiscoveryTimeoutMs === undefined
      ? {}
      : { resourceDiscoveryTimeoutMs: options.resourceDiscoveryTimeoutMs }),
  });
  runtimeHostImportControllers.set(host, new RuntimeHostImportController(entries));
  try {
    await activateRuntimeExtensionEntries(host, entries, { ...options, workspace, dataRoot });
  } catch (error) {
    try {
      await host.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Runtime extension activation and cleanup failed");
    }
    throw error;
  }
  return host;
}
