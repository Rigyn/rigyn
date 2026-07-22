import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { createJiti } from "jiti";
import { minimatch } from "minimatch";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
import type { TSchema } from "typebox";
import type { CustomMessage as DirectCustomMessage } from "@rigyn/kernel";
import type { Api, Model, Provider as ExtensionProvider } from "@rigyn/models";
import type {
  AutocompleteProvider,
  Component,
  EditorComponent,
  EditorTheme,
  KeybindingsManager,
  OverlayHandle,
  OverlayOptions,
  TUI,
} from "@rigyn/terminal";

import type { CompactionReason } from "../context/compaction.js";
import type {
  AssistantResponseTransformationAudit,
  AssistantResponseTransformationField,
  EventEnvelope,
  RuntimeEvent,
  ToolUpdate,
} from "../core/events.js";
import { isJsonValue, type JsonValue } from "../core/json.js";
import type {
  AdapterError,
  CanonicalMessage,
  FinishReason,
  ImageBlock,
  NormalizedUsage,
  PromptCompositionMetadata,
  ProviderId,
  ProviderRequest,
  ToolDefinition,
  ToolResultBlock,
} from "../core/types.js";
import { isNormalizedUsage } from "../core/usage.js";
import type { BuildSystemPromptOptions } from "../core/system-prompt.js";
import type { SourceInfo } from "../core/source-info.js";
import type { SlashCommandInfo } from "../core/slash-commands.js";
import type { EventBus as CoreEventBus } from "../core/event-bus.js";
import { defaultSecretRedactor } from "../auth/redaction.js";
import {
  sanitizeRuntimeUiBlock,
  sanitizeRuntimeUiRenderContext,
  type RuntimeToolRenderer,
  type RuntimeToolRenderBridge,
  type RuntimeToolRendererBinding,
  type RuntimeToolRenderView,
  type RuntimeUiBlock,
  type RuntimeUiComponentFactory,
  type RuntimeUiCustomOptions,
  type RuntimeUiKeyEvent,
  type RuntimeUiOverlayHandle,
  type RuntimeUiRenderContext,
} from "../tui/components.js";
import type { NativeUiHost, UnsafeTerminalHost } from "../tui/native-ui.js";
import type { ReadonlyFooterDataProvider } from "../tui/footer-data.js";
import { createTheme, type Theme } from "../tui/theme.js";
import type {
  ProviderWireLifecycleHost,
  ProviderWireLifecycleScope,
} from "../providers/wire.js";
import type { ModelRegistry as InternalModelRegistry } from "../providers/model-registry.js";
import type { ProviderModel } from "../providers/models.js";
import { MAX_TOOL_TRANSFORMATION_AUDIT_ENTRIES } from "../tools/coordinator.js";
import { sha256 } from "../tools/hash.js";
import { assertSchema, assertSupportedSchema } from "../tools/schema.js";
import { assertCanonicalDirectoryCreationPath } from "../config/canonical-path.js";
import type {
  HarnessTool,
  ResourceClaim,
  ToolArtifact,
  ToolContext,
  ToolExecutionContext,
  ToolExecutionMode,
  ToolInputPreparer,
  ToolInputTransformationAudit,
  ToolInvocation,
  ToolResult,
} from "../tools/types.js";
import type { ExtensionRuntimeEntry, ExtensionScope } from "./types.js";
import {
  extensionModelRegistry,
  type ExtensionModelRegistry,
  type ExtensionProviderConfig,
  type ExtensionProviderModelConfig,
} from "./model-boundary.js";
import type {
  AgentToolResult as DirectAgentToolResult,
  CompactionResult as DirectCompactionResult,
  Extension as DirectExtension,
  ExtensionAPI,
  ExtensionContext as DirectExtensionContext,
  ToolInfo as DirectToolInfo,
  ToolDefinition as DirectToolDefinition,
} from "./direct.js";
import {
  canonicalInputContent,
  canonicalAgentMessages,
  canonicalContent,
  canonicalMessage,
  canonicalUsage,
  extensionAssistantEvent,
  extensionCanonicalMessages,
  extensionContent,
  extensionInputContent,
  extensionMessage,
  extensionMessages,
  extensionSessionEntries,
  extensionSessionEntry,
  extensionToolResultBlock,
  extensionUsage,
  type ExtensionSessionManager,
  type ReadonlyExtensionSessionManager,
} from "./session-contract.js";
import type { CustomEntry, CustomMessage, SessionEntry } from "../storage/types.js";
import { isBuiltinSlashCommand } from "./reserved.js";

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
} from "../tui/components.js";

const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;
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
const MAX_RUNTIME_ACTIVE_TOOLS = 512;
const MAX_RUNTIME_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_RUNTIME_SHARED_EVENT_LISTENERS = 1_024;
const MAX_RUNTIME_SHARED_EVENT_TOPIC_BYTES = 1_024;
const MAX_RUNTIME_TOOL_PROMPT_GUIDELINES = 32;
const MAX_RUNTIME_RESOURCE_PATHS_PER_LISTENER = 64;
const MAX_RUNTIME_DISCOVERED_RESOURCE_PATHS = 256;
const MAX_RUNTIME_RESOURCE_PATH_BYTES = 4_096;
const MAX_RUNTIME_USER_SHELL_COMMAND_BYTES = 128 * 1024;
const MAX_RUNTIME_USER_SHELL_CWD_BYTES = 16 * 1024;
const MAX_RUNTIME_USER_SHELL_RESULT_BYTES = 1024 * 1024;
const MAX_RUNTIME_TREE_SUMMARY_BYTES = 64 * 1024;
const MAX_RUNTIME_TREE_METADATA_BYTES = 64 * 1024;
const MAX_RUNTIME_TREE_INSTRUCTIONS_BYTES = 16 * 1024;
const MAX_RUNTIME_TREE_LABEL_BYTES = 256;
export const DEFAULT_RUNTIME_EXTENSION_ACTIVATION_TIMEOUT_MS = 30_000;
export const DEFAULT_RUNTIME_EXTENSION_LOAD_TIMEOUT_MS = 30_000;
export const DEFAULT_RUNTIME_EXTENSION_SHUTDOWN_TIMEOUT_MS = 5_000;
export const DEFAULT_RUNTIME_RESOURCE_DISCOVERY_TIMEOUT_MS = 30_000;

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
  | "before_provider_headers"
  | "after_provider_response"
  | "before_user_shell"
  | "user_bash"
  | "user_shell"
  | "theme_change"
  | "event";

export type RuntimeDirectExtensionEvent = Exclude<
  RuntimeExtensionEvent,
  "session_end" | "before_user_shell" | "user_shell" | "theme_change" | "event"
>;
const RUNTIME_DIRECT_EXTENSION_EVENTS: ReadonlySet<RuntimeDirectExtensionEvent> = new Set([
  "resources_discover", "project_trust", "session_start", "session_info_changed", "session_shutdown",
  "session_before_switch", "session_before_fork", "session_before_tree", "session_tree",
  "session_before_compact", "session_compact", "before_agent_start", "agent_start", "agent_end",
  "agent_settled", "turn_start", "turn_end", "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end", "tool_call", "tool_result",
  "context", "input", "model_select", "thinking_level_select", "before_provider_request",
  "before_provider_headers", "after_provider_response", "user_bash",
]);
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

export type RuntimeInputSource = "interactive" | "rpc" | "extension";
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
  streamingBehavior?: "steer" | "followUp";
}

export type RuntimeInputResult =
  | { action: "continue" }
  | { action: "handled" }
  | { action: "transform"; text: string; images?: ImageBlock[] };

export interface RuntimeBeforeAgentStartEvent extends Partial<RuntimeRunScope> {
  prompt: string;
  images?: ImageBlock[];
  systemPrompt: string;
  systemPromptOptions: BuildSystemPromptOptions;
}

export interface RuntimeBeforeAgentStartResult {
  message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
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
  textSignature?: string;
}

export interface RuntimeAssistantStreamReasoningPart extends RuntimeAssistantStreamTextPart {
  visibility: "summary" | "provider_trace";
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface RuntimeAssistantStreamToolCall {
  index: number;
  id?: string;
  name?: string;
  rawArguments: string;
  arguments?: JsonValue;
  parseError?: string;
  thoughtSignature?: string;
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

export interface RuntimeAfterProviderResponseEvent {
  type: "after_provider_response";
  /** HTTP status observed for this transport attempt. */
  status: number;
  /** Complete normalized response headers for trusted in-process direct extensions. */
  headers: Record<string, string>;
}

export interface RuntimeBeforeProviderHeadersEvent {
  /** Mutable request headers. Assign null to delete a header. */
  headers: Record<string, string | null>;
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
  | { action: "execute"; command: string; cwd: string; operations?: RuntimeUserBashOperations }
  | { action: "handled"; command: string; cwd: string; result: RuntimeUserShellResult };

export interface RuntimeUserBashOperations {
  exec(
    command: string,
    cwd: string,
    options: {
      onData(data: Buffer): void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<{ exitCode: number | null }>;
}

export interface RuntimeUserBashEvent {
  command: string;
  excludeFromContext: boolean;
  cwd: string;
}

export interface RuntimeUserBashResult {
  operations?: RuntimeUserBashOperations;
  result?: {
    output: string;
    exitCode: number | undefined;
    cancelled: boolean;
    truncated: boolean;
    fullOutputPath?: string;
  };
}

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
  /** Usage attributed to the tool result presented to extension listeners. */
  usage?: NormalizedUsage;
}

export interface RuntimeToolResultPatch {
  content?: string;
  isError?: boolean;
  usage?: NormalizedUsage;
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

export interface RuntimeCompactionResult extends DirectCompactionResult {
  threadId: string;
  branch: string;
}

/** Provider-neutral usage totals used by session history. */
export type RuntimeUsageSummary = Omit<NormalizedUsage, "raw">;

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

function runtimeResourcePatternMatch(pathValue: string, packageRoot: string, pattern: string): boolean {
  const target = isAbsolute(pathValue) ? resolve(pathValue) : resolve(packageRoot, pathValue);
  const name = basename(target);
  const portable = (value: string): string => value.split(sep).join("/");
  const candidates = [portable(relative(packageRoot, target)), portable(target), name];
  if (name === "SKILL.md") {
    const directory = dirname(target);
    candidates.push(portable(relative(packageRoot, directory)), portable(directory), basename(directory));
  }
  const normalized = portable(pattern.replace(/^\.\//u, ""));
  return candidates.some((candidate) => minimatch(candidate, normalized, { nonegate: true, nocomment: true }));
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
  reason: "quit" | "reload" | "new" | "resume" | "fork";
  targetSessionFile?: string;
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
  targetId: string;
  oldLeafId: string | null;
  commonAncestorId: string | null;
  entriesToSummarize: SessionEntry[];
  userWantsSummary: boolean;
  customInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
}

export interface RuntimeSessionBeforeTreeEvent {
  preparation: RuntimeTreePreparation;
  signal: AbortSignal;
}

export interface RuntimeSessionGuardResult {
  cancel?: boolean;
  reason?: string;
}

export interface RuntimeTreeResult {
  cancel?: boolean;
  summary?: { summary: string; details?: unknown; usage?: NormalizedUsage };
  customInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
}

export interface RuntimeSessionBeforeCompactEvent {
  preparation: {
    firstKeptEntryId: string;
    messagesToSummarize: CanonicalMessage[];
    turnPrefixMessages: CanonicalMessage[];
    isSplitTurn: boolean;
    tokensBefore: number;
    previousSummary?: string;
    fileOps: {
      read: Set<string>;
      written: Set<string>;
      edited: Set<string>;
    };
    settings: {
      enabled: boolean;
      reserveTokens: number;
      keepRecentTokens: number;
    };
  };
  branchEntries: SessionEntry[];
  customInstructions?: string;
  reason: CompactionReason;
  willRetry: boolean;
  signal: AbortSignal;
}

export interface RuntimeCompactionOverride {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter?: number;
  usage?: NormalizedUsage;
  details?: unknown;
}

export interface RuntimeSessionBeforeCompactResult {
  cancel?: boolean;
  compaction?: RuntimeCompactionOverride;
}

export interface RuntimeBeforeAgentStartReduction {
  messages: CustomMessage[];
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
  before_provider_headers: RuntimeBeforeProviderHeadersEvent;
  after_provider_response: RuntimeAfterProviderResponseEvent;
  before_user_shell: RuntimeBeforeUserShellEvent;
  user_bash: RuntimeUserBashEvent;
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
  before_provider_headers: void;
  after_provider_response: void;
  before_user_shell: RuntimeBeforeUserShellResult | void;
  user_bash: RuntimeUserBashResult | void;
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
  "before_provider_headers",
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

function freezeRuntimeRunEvent<T>(_event: RuntimeExtensionEvent, value: T): T {
  if (value !== null && typeof value === "object") return Object.freeze(value);
  return value;
}

function directEventRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function directDispatchEvents(event: RuntimeExtensionEvent, value: unknown): unknown[] {
  const selected = directEventRecord(value);
  if (selected === undefined) return [value];
  if (event === "agent_end" && Array.isArray(selected.messages)) {
    return [{ ...selected, messages: extensionCanonicalMessages(selected.messages as CanonicalMessage[]) }];
  }
  if (event === "turn_end" && directEventRecord(selected.message) !== undefined) {
    const timestamp = typeof selected.timestamp === "number" ? selected.timestamp : Date.now();
    const toolResults = Array.isArray(selected.toolResults)
      ? selected.toolResults.map((block) => extensionToolResultBlock(block as ToolResultBlock, { timestamp }))
      : [];
    return [{ ...selected, message: extensionMessage(selected.message as CanonicalMessage), toolResults }];
  }
  if ((event === "message_start" || event === "message_end") && directEventRecord(selected.message) !== undefined) {
    return extensionMessages(selected.message as CanonicalMessage).map((message) => ({ ...selected, message }));
  }
  if (event === "message_update" && directEventRecord(selected.message) !== undefined) {
    const message = selected.message as CanonicalMessage;
    return [{
      ...selected,
      message: extensionMessage(message),
      assistantMessageEvent: extensionAssistantEvent(selected.assistantMessageEvent, message),
    }];
  }
  if (event === "before_agent_start" && Array.isArray(selected.images)) {
    return [{ ...selected, images: extensionContent(selected.images as ImageBlock[]) }];
  }
  if (event === "session_tree" && directEventRecord(selected.summaryEntry) !== undefined) {
    return [{ ...selected, summaryEntry: extensionSessionEntry(selected.summaryEntry as SessionEntry) }];
  }
  if (event === "session_compact" && directEventRecord(selected.compactionEntry) !== undefined) {
    return [{ ...selected, compactionEntry: extensionSessionEntry(selected.compactionEntry as SessionEntry) }];
  }
  return [value];
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

export interface RuntimeDirectUiDialogOptions {
  signal?: AbortSignal;
  timeout?: number;
}

export interface RuntimeDirectWorkingIndicatorOptions {
  frames?: string[];
  intervalMs?: number;
}

export interface RuntimeDirectWidgetOptions {
  placement?: "aboveEditor" | "belowEditor";
}

export type RuntimeDirectTerminalInputHandler = (
  data: string,
) => { consume?: boolean; data?: string } | undefined;
export type RuntimeDirectAutocompleteProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider;
export type RuntimeDirectEditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;
export type RuntimeDirectPersistentComponentFactory = (
  tui: TUI,
  theme: Theme,
  data?: unknown,
) => Component & { dispose?(): void };
export type RuntimeDirectFooterFactory = (
  tui: TUI,
  theme: Theme,
  data: ReadonlyFooterDataProvider,
) => Component & { dispose?(): void };

/** Unrestricted UI contract available to explicitly trusted direct extensions. */
export interface RuntimeDirectUiContext {
  select(title: string, options: string[], opts?: RuntimeDirectUiDialogOptions): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: RuntimeDirectUiDialogOptions): Promise<boolean>;
  input(title: string, placeholder?: string, opts?: RuntimeDirectUiDialogOptions): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  onTerminalInput(handler: RuntimeDirectTerminalInputHandler): () => void;
  setStatus(key: string, text: string | undefined): void;
  setWorkingMessage(message?: string): void;
  setWorkingVisible(visible: boolean): void;
  setWorkingIndicator(options?: RuntimeDirectWorkingIndicatorOptions): void;
  setHiddenThinkingLabel(label?: string): void;
  setWidget(key: string, content: string[] | RuntimeDirectPersistentComponentFactory | undefined, options?: RuntimeDirectWidgetOptions): void;
  setFooter(factory: RuntimeDirectFooterFactory | undefined): void;
  setHeader(factory: RuntimeDirectPersistentComponentFactory | undefined): void;
  setTitle(title: string): void;
  custom<T>(
    factory: (
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      done: (result: T) => void,
    ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
    options?: {
      overlay?: boolean;
      overlayOptions?: OverlayOptions | (() => OverlayOptions);
      onHandle?: (handle: OverlayHandle) => void;
    },
  ): Promise<T>;
  pasteToEditor(text: string): void;
  setEditorText(text: string): void;
  getEditorText(): string;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  addAutocompleteProvider(factory: RuntimeDirectAutocompleteProviderFactory): void;
  setEditorComponent(factory: RuntimeDirectEditorFactory | undefined): void;
  getEditorComponent(): RuntimeDirectEditorFactory | undefined;
  readonly theme: Theme;
  getAllThemes(): { name: string; path: string | undefined }[];
  getTheme(name: string): Theme | undefined;
  setTheme(theme: string | Theme): { success: boolean; error?: string };
  getToolsExpanded(): boolean;
  setToolsExpanded(expanded: boolean): void;
}

export interface RuntimeExtensionListenerContext {
  /** Current working directory. Trusted direct factories receive the host value unchanged. */
  readonly cwd: string;
  readonly signal: AbortSignal | undefined;
  /** Active host mode for this callback. */
  readonly mode: RuntimeExtensionMode;
  /** True when dialog-capable host UI is available for this callback. */
  readonly hasUI: boolean;
  /** Reads the current workspace trust decision without capturing stale state. */
  readonly isProjectTrusted: () => boolean;
  /** Interactive in TUI/RPC hosts; presentation-only methods remain usable headlessly. */
  readonly ui: RuntimeDirectUiContext;
  /** Raw read-only session tree for the active JSONL session. */
  readonly sessionManager: ReadonlyExtensionSessionManager;
  /** Active model directory, including credential resolution for trusted extensions. */
  readonly modelRegistry: RuntimeExtensionModelRegistry;
  /** Currently selected model, when one is selected. */
  readonly model: Model<Api> | undefined;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  abort(): void;
  shutdown(): void;
  getContextUsage(): RuntimeContextUsage | undefined;
  compact(options?: RuntimeDirectCompactOptions): void;
  getSystemPrompt(): string;
}

export interface RuntimeContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface RuntimeDirectCompactOptions {
  customInstructions?: string;
  onComplete?(result: RuntimeCompactionResult): void;
  onError?(error: Error): void;
}

export type RuntimeExtensionModelRegistry = ExtensionModelRegistry;

export interface RuntimeDirectContextSnapshot {
  sessionManager: ReadonlyExtensionSessionManager;
  modelRegistry: InternalModelRegistry;
  model?: ProviderModel;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  abort(): void;
  shutdown(): void;
  getContextUsage(): RuntimeContextUsage | undefined;
  compact(options?: RuntimeDirectCompactOptions): void;
  getSystemPrompt(): string;
}

export type RuntimeDirectContextHandler = (
  target: RuntimeExtensionSessionTarget | undefined,
  signal: AbortSignal,
) => RuntimeDirectContextSnapshot;

export type RuntimeDirectUiHandler = (
  extensionId: string,
  signal: AbortSignal,
) => RuntimeDirectUiContext;

export interface RuntimeDirectExecOptions {
  signal?: AbortSignal;
  timeout?: number;
  cwd?: string;
}

export interface RuntimeDirectExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export type RuntimeDirectProviderModelConfig = ExtensionProviderModelConfig;
export type RuntimeDirectProviderConfig = ExtensionProviderConfig;

export interface RuntimeDirectActionsHandler {
  sendMessage<T = unknown>(
    message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
  sendUserMessage(
    content: CustomMessage["content"],
    options?: { deliverAs?: "steer" | "followUp" },
  ): void;
  appendEntry<T = unknown>(customType: string, data?: T): void;
  setSessionName(name: string): void;
  getSessionName(): string | undefined;
  setLabel(entryId: string, label: string | undefined): void;
  exec(command: string, args: string[], options?: RuntimeDirectExecOptions): Promise<RuntimeDirectExecResult>;
  getActiveTools(): string[];
  getAllTools(): RuntimeToolCatalogEntry[];
  setActiveTools(toolNames: string[]): void;
  /** Unified extension-command, prompt-template, and skill-command catalog. */
  getCommands?(): readonly SlashCommandInfo[];
  setModel(model: Model<Api>): Promise<boolean>;
  getThinkingLevel(): string;
  setThinkingLevel(level: string): void;
  registerProvider(provider: ExtensionProvider): void;
  registerProvider(name: string, config: RuntimeDirectProviderConfig): void;
  unregisterProvider(name: string): void;
  getSystemPromptOptions(): BuildSystemPromptOptions;
  waitForIdle(): Promise<void>;
  newSession(options?: RuntimeDirectNewSessionOptions): Promise<{ cancelled: boolean }>;
  fork(entryId: string, options?: RuntimeDirectForkOptions): Promise<{ cancelled: boolean }>;
  navigateTree(targetId: string, options?: RuntimeDirectNavigateTreeOptions): Promise<{ cancelled: boolean }>;
  switchSession(sessionPath: string, options?: RuntimeDirectSwitchSessionOptions): Promise<{ cancelled: boolean }>;
  reload(): Promise<void>;
}

export interface RuntimeProjectTrustUi {
  readonly hasUI: boolean;
  confirm(title: string, message: string, signal?: AbortSignal): Promise<boolean>;
}

export interface RuntimeProjectTrustListenerContext {
  readonly cwd: string;
  readonly mode: RuntimeExtensionMode;
  readonly hasUI: boolean;
  readonly ui: Pick<RuntimeDirectUiContext, "select" | "confirm" | "input" | "notify">;
}

export type RuntimeExtensionListenerContextFor<K extends RuntimeExtensionEvent> =
  K extends "project_trust" ? RuntimeProjectTrustListenerContext : RuntimeExtensionListenerContext;

export type RuntimeExtensionListenerEvent<K extends RuntimeExtensionEvent> =
  K extends "event" ? RuntimeObservedEvent : RuntimeExtensionEventMap[K] & { readonly type: K };

export type RuntimeExtensionListener<K extends RuntimeExtensionEvent> = (
  value: RuntimeExtensionListenerEvent<K>,
  context: RuntimeExtensionListenerContextFor<K>,
) => RuntimeExtensionEventResultMap[K] | Promise<RuntimeExtensionEventResultMap[K]>;

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

export interface RuntimeToolContext extends ToolExecutionContext, Omit<RuntimeExtensionListenerContext, "signal"> {
  readonly extensionId: string;
  readonly sourcePath: string;
  readonly hasUI: boolean;
  readonly mode: RuntimeExtensionMode;
  readonly isProjectTrusted: () => boolean;
  readonly ui: RuntimeDirectUiContext;
}

export interface RuntimeRendererDescription {
  extensionId: string;
  sourcePath: string;
  kind: "tool" | "message" | "entry";
  key: string;
}

export interface RuntimeExtensionSessionTarget {
  threadId: string;
  branch?: string;
  signal?: AbortSignal;
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

/** Unredacted process-local prompt state that is never written back to durable history by this API. */
export interface RuntimeNativeSystemPromptSnapshot extends RuntimeRunScope {
  prompt: string;
  systemPrompt: string;
  images?: ImageBlock[];
  composition?: PromptCompositionMetadata;
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

export type RuntimeDirectDiscoveryHandler = (
  signal?: AbortSignal,
) => RuntimeDiscoveryView | Promise<RuntimeDiscoveryView>;

export interface RuntimeDirectRenderOptions {
  expanded: boolean;
}

export type RuntimeDirectMessageRenderer<T = unknown> = (
  message: DirectCustomMessage<T>,
  options: RuntimeDirectRenderOptions,
  theme: Theme,
) => Component | undefined;

export type RuntimeDirectEntryRenderer<T = unknown> = (
  entry: CustomEntry<T>,
  options: RuntimeDirectRenderOptions,
  theme: Theme,
) => Component | undefined;

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

export interface RuntimeDirectCommandContext extends RuntimeExtensionListenerContext {
  getSystemPromptOptions(): BuildSystemPromptOptions;
  waitForIdle(): Promise<void>;
  newSession(options?: RuntimeDirectNewSessionOptions): Promise<{ cancelled: boolean }>;
  fork(entryId: string, options?: RuntimeDirectForkOptions): Promise<{ cancelled: boolean }>;
  navigateTree(targetId: string, options?: RuntimeDirectNavigateTreeOptions): Promise<{ cancelled: boolean }>;
  switchSession(sessionPath: string, options?: RuntimeDirectSwitchSessionOptions): Promise<{ cancelled: boolean }>;
  reload(): Promise<void>;
}

export interface RuntimeDirectReplacementContext extends RuntimeDirectCommandContext {
  sendMessage<T = unknown>(
    message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): Promise<void>;
  sendUserMessage(
    content: CustomMessage["content"],
    options?: { deliverAs?: "steer" | "followUp" },
  ): Promise<void>;
}

export interface RuntimeDirectNewSessionOptions {
  parentSession?: string;
  setup?(sessionManager: ExtensionSessionManager): Promise<void>;
  withSession?(context: RuntimeDirectReplacementContext): Promise<void>;
}

export interface RuntimeDirectForkOptions {
  position?: "before" | "at";
  withSession?(context: RuntimeDirectReplacementContext): Promise<void>;
}

export interface RuntimeDirectNavigateTreeOptions {
  summarize?: boolean;
  customInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
}

export interface RuntimeDirectSwitchSessionOptions {
  withSession?(context: RuntimeDirectReplacementContext): Promise<void>;
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
  execute(context: RuntimeDirectCommandContext & { args: string }): RuntimeCommandResult | Promise<RuntimeCommandResult>;
}

/** Direct-factory command shape used by trusted runtime extensions. */
export interface RuntimeDirectCommandRegistration {
  description?: string;
  argumentHint?: string;
  getArgumentCompletions?(
    argumentPrefix: string,
    signal?: AbortSignal,
  ): readonly RuntimeCommandCompletion[] | null | Promise<readonly RuntimeCommandCompletion[] | null>;
  handler(args: string, context: RuntimeDirectCommandContext): RuntimeCommandResult | Promise<RuntimeCommandResult>;
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
export type RuntimeDirectShortcutContext = Omit<RuntimeDirectCommandContext, "args">;

export interface RuntimeShortcutRegistration {
  shortcut: string;
  description?: string;
  execute(context: RuntimeDirectShortcutContext): void | Promise<void>;
}

/** Direct-factory shortcut shape used by trusted runtime extensions. */
export interface RuntimeDirectShortcutRegistration {
  description?: string;
  handler(context: RuntimeDirectShortcutContext): void | Promise<void>;
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
  replaceTool(previous: HarnessTool, tool: HarnessTool): void | (() => void | Promise<void>);
}

interface RuntimeExtensionGeneration {
  active: boolean;
  abortController: AbortController;
  entry: ExtensionRuntimeEntry;
  dataPaths: RuntimeExtensionDataPaths;
  compatibilityProjection: DirectExtension;
  committedTools: Array<{ registration: RuntimeToolRegistration; tool: HarnessTool }>;
  committedShortcuts: RuntimeShortcutRegistration[];
  committedFlags: RuntimeFlagRegistration[];
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
  directProviders: Array<
    | { name: string; config: RuntimeDirectProviderConfig }
    | { name: string; provider: ExtensionProvider }
  >;
  toolRenderers: Array<{ name: string; renderer: RuntimeToolRenderer }>;
  messageRenderers: Array<{ customType: string; renderer: RuntimeDirectMessageRenderer }>;
  entryRenderers: Array<{ customType: string; renderer: RuntimeDirectEntryRenderer }>;
  listeners: Array<{ event: RuntimeExtensionEvent; listener: RuntimeExtensionListener<RuntimeExtensionEvent> }>;
  sharedListeners: Array<{ topic: string; listener: RuntimeSharedEventListener }>;
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

interface OwnedDirectRenderer<T> extends OwnedRenderer<T> {
  customType: string;
}

function unavailableDirectObject<T extends object>(label: string): T {
  return new Proxy(Object.create(null) as T, {
    get() {
      throw new Error(`${label} is unavailable before the direct extension host is bound`);
    },
  });
}

function unavailableDirectContext(): RuntimeDirectContextSnapshot {
  return {
    sessionManager: unavailableDirectObject<ReadonlyExtensionSessionManager>("Session manager"),
    modelRegistry: unavailableDirectObject<InternalModelRegistry>("Model registry"),
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort() {},
    shutdown() {},
    getContextUsage: () => undefined,
    compact(options) {
      options?.onError?.(new Error("Compaction is unavailable before the direct extension host is bound"));
    },
    getSystemPrompt: () => "",
  };
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

function sharedEventTopic(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Shared event topic must be a non-empty string");
  }
  return bounded(value, "Shared event topic", MAX_RUNTIME_SHARED_EVENT_TOPIC_BYTES);
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
const runtimeRequire = createRequire(import.meta.url);
const typeboxEntry = runtimeRequire.resolve("typebox");
const typeboxCompileEntry = runtimeRequire.resolve("typebox/compile");
const typeboxValueEntry = runtimeRequire.resolve("typebox/value");
const RUNTIME_HOST_IMPORTS = new Map<string, string>([
  ["rigyn", new URL(`../index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/auth", new URL(`../auth/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/config", new URL(`../config/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/context", new URL(`../context/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/core", new URL(`../core/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/embedding", new URL(`../embedding/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/extensions", new URL(`./index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/images", new URL(`../images/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/interfaces", new URL(`../interfaces/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/modes", new URL(`../modes/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/net", new URL(`../net/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/process", new URL(`../process/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/prompts", new URL(`../prompts/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/providers", new URL(`../providers/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/service", new URL(`../service/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/sdk", new URL(`../sdk/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/storage", new URL(`../storage/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/testing", new URL(`../testing/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/tools", new URL(`../tools/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["rigyn/tui", new URL(`../tui/index${runtimeHostModuleExtension}`, import.meta.url).href],
  ["typebox", typeboxEntry],
  ["typebox/compile", typeboxCompileEntry],
  ["typebox/value", typeboxValueEntry],
  ["@sinclair/typebox", typeboxEntry],
  ["@sinclair/typebox/compile", typeboxCompileEntry],
  ["@sinclair/typebox/value", typeboxValueEntry],
]);
const RUNTIME_HOST_VIRTUAL_MODULES: Record<string, unknown> = {
  typebox: bundledTypebox,
  "typebox/compile": bundledTypeboxCompile,
  "typebox/value": bundledTypeboxValue,
  "@sinclair/typebox": bundledTypebox,
  "@sinclair/typebox/compile": bundledTypeboxCompile,
  "@sinclair/typebox/value": bundledTypeboxValue,
};

function extensionDataPaths(
  dataRoot: string,
  workspace: string,
  entry: ExtensionRuntimeEntry,
): RuntimeExtensionDataPaths {
  const extensionId = entry.extensionId;
  if (!/^[a-z][a-z0-9._-]{0,62}$/u.test(extensionId)) throw new Error("Extension ID is invalid");
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
  const record = runtimeSessionRecord(value, ["decision", "trusted", "remember"], "Runtime project_trust result");
  if (record.decision !== undefined && record.trusted !== undefined && record.decision !== record.trusted) {
    throw new Error("Runtime project_trust result cannot disagree between decision and trusted");
  }
  const decision = record.decision ?? record.trusted;
  if (decision !== "yes" && decision !== "no" && decision !== "undecided") {
    throw new Error("Runtime project_trust decision must be yes, no, or undecided");
  }
  if (record.remember !== undefined && typeof record.remember !== "boolean") {
    throw new Error("Runtime project_trust remember must be boolean");
  }
  if (decision === "undecided" && record.remember !== undefined) {
    throw new Error("Runtime project_trust cannot remember an undecided result");
  }
  return {
    decision,
    ...(record.remember === undefined ? {} : { remember: record.remember }),
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

const RUNTIME_FINISH_REASONS = new Set<FinishReason>([
  "stop", "tool_calls", "length", "context_limit", "content_filter", "refusal",
  "pause", "cancelled", "error", "incomplete", "unknown",
]);
function runtimeFinishReason(value: unknown, label: string): FinishReason {
  if (typeof value !== "string" || !RUNTIME_FINISH_REASONS.has(value as FinishReason)) {
    throw new Error(`${label} is invalid`);
  }
  return value as FinishReason;
}

function runtimeFinalizedResponse(
  value: unknown,
  label: string,
): RuntimeMessageEndReduction["finalized"] {
  const record = runtimeSessionRecord(value, ["finishReason", "usage", "rawReason", "explanation"], label);
  const usage = record.usage === undefined
    ? undefined
    : cloneBounded(record.usage, `${label} usage`) as NormalizedUsage;
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

function observedDurableEvent(event: RuntimeEvent): RuntimeEvent {
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
    default:
      return event;
  }
}

function observedEventForListener(
  event: RuntimeObservedEvent,
): RuntimeObservedEvent {
  if (isRuntimeUserShellEvent(event)) return event;
  return { ...event, event: observedDurableEvent(event.event) };
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
  const deadline = Date.now() + timeoutMs;
  const failures: Error[] = [];
  let pendingCount = 0;
  for (const cleanup of cleanups) {
    let settled = false;
    let failure: unknown;
    let returned: void | Promise<void>;
    try {
      returned = cleanup();
    } catch (cause) {
      settled = true;
      failure = cause;
      returned = undefined;
    }
    const completion = Promise.resolve(returned).then(
      () => { settled = true; },
      (cause: unknown) => { settled = true; failure = cause; },
    );
    const remaining = deadline - Date.now();
    if (!settled && remaining > 0) {
      await Promise.race([
        completion,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remaining);
          timer.unref();
        }),
      ]);
    }
    if (!settled) pendingCount += 1;
    else if (failure !== undefined) {
      failures.push(new Error(
        `${label} failed: ${defaultSecretRedactor.redact(error(failure).message).slice(0, 4096)}`,
        { cause: failure },
      ));
    }
  }
  if (pendingCount > 0) {
    failures.push(new Error(
      `${label} timed out after ${timeoutMs}ms with ${pendingCount} cleanup callback(s) still pending`,
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
  if (result.usage !== undefined && !isNormalizedUsage(result.usage)) {
    throw new Error("Runtime tool usage is invalid");
  }
  if (result.addedToolNames !== undefined && (
    !Array.isArray(result.addedToolNames) ||
    result.addedToolNames.length > 256 ||
    result.addedToolNames.some((name) =>
      typeof name !== "string" || name.trim() === "" || name.includes("\0") || Buffer.byteLength(name, "utf8") > 1_024
    )
  )) throw new Error("Runtime tool addedToolNames must contain at most 256 non-empty tool names");
  if (result.metadata !== undefined && !isJsonValue(result.metadata)) throw new Error("Runtime tool metadata is not JSON-safe");
  return result;
}

class RuntimeHarnessTool implements HarnessTool {
  readonly definition;
  readonly executionMode;
  readonly #registration: RuntimeToolRegistration;
  readonly #context: (context: ToolExecutionContext) => RuntimeToolContext;
  readonly #execute: (
    context: ToolContext,
    operation: () => ToolResult | Promise<ToolResult>,
  ) => Promise<ToolResult>;
  readonly #activeToolNames: (() => readonly string[] | undefined) | undefined;

  constructor(
    registration: RuntimeToolRegistration,
    context: (context: ToolExecutionContext) => RuntimeToolContext,
    execute: (
      context: ToolContext,
      operation: () => ToolResult | Promise<ToolResult>,
    ) => Promise<ToolResult>,
    activeToolNames?: () => readonly string[] | undefined,
  ) {
    this.#registration = registration;
    this.#context = context;
    this.#execute = execute;
    this.#activeToolNames = activeToolNames;
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

  async execute(input: JsonValue, context: ToolExecutionContext): Promise<ToolResult> {
    const before = this.#activeToolNames?.();
    const result = validateResult(await this.#execute(
      context,
      () => this.#registration.execute(input, this.#context(context)),
    ));
    const after = this.#activeToolNames?.();
    if (before === undefined || after === undefined || !before.every((name) => after.includes(name))) return result;
    const previous = new Set(before);
    const added = after.filter((name) => !previous.has(name));
    if (added.length === 0) return result;
    return validateResult({
      ...result,
      addedToolNames: [...new Set([...(result.addedToolNames ?? []), ...added])],
    });
  }
}

function directToolText(result: DirectAgentToolResult): string {
  return result.content
    .filter((block): block is Extract<(typeof result.content)[number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function directToolResult(result: DirectAgentToolResult): ToolResult {
  const content = canonicalInputContent(result.content);
  if (typeof content === "string") throw new TypeError("Extension tool content must be an array");
  const images = content.filter((block): block is ImageBlock => block.type === "image");
  return {
    content: directToolText(result),
    contentBlocks: content,
    isError: false,
    ...(result.usage === undefined ? {} : { usage: canonicalUsage(result.usage) }),
    ...(result.terminate === undefined ? {} : { terminate: result.terminate }),
    ...(images.length === 0 ? {} : { images }),
    ...(isJsonValue(result.details) ? { metadata: result.details } : {}),
    ...(result.addedToolNames === undefined ? {} : { addedToolNames: [...result.addedToolNames] }),
  };
}

function directToolRegistration<TParams extends TSchema, TDetails, TState>(
  tool: DirectToolDefinition<TParams, TDetails, TState>,
): RuntimeToolRegistration {
  if (tool === null || typeof tool !== "object") throw new TypeError("Extension tool must be an object");
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as unknown as Record<string, JsonValue>,
    ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
    ...(tool.promptGuidelines === undefined ? {} : { promptGuidelines: [...tool.promptGuidelines] }),
    ...(tool.prepareArguments === undefined
      ? {}
      : { prepareInput: (input) => tool.prepareArguments!(input) as JsonValue }),
    ...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
    async execute(input, context) {
      const onUpdate = context.reportProgress === undefined
        ? undefined
        : (partial: DirectAgentToolResult): void => {
            const converted = directToolResult(partial);
            context.reportProgress?.({
              type: "result",
              content: converted.content,
              isError: false,
              ...(converted.metadata === undefined ? {} : { metadata: converted.metadata }),
            });
          };
      const result = await tool.execute(
        context.toolCallId,
        input as never,
        context.signal,
        onUpdate,
        context as unknown as DirectExtensionContext,
      );
      return directToolResult(result);
    },
  };
}

interface DirectToolRendererState {
  state: Record<string, unknown>;
  callComponent?: Component;
  resultComponent?: Component;
}

function directRendererTheme(
  context: RuntimeUiRenderContext,
  bridge: RuntimeToolRenderBridge | undefined,
): Theme {
  if (bridge !== undefined) return bridge.theme;
  try {
    return createTheme(context.theme.name, {
      color: context.theme.color,
      unicode: context.theme.unicode,
    });
  } catch {
    return createTheme("mono", { color: false, unicode: context.theme.unicode });
  }
}

function directComponentBlock(component: Component, width: number): RuntimeUiBlock {
  if (component === null || typeof component !== "object" || typeof component.render !== "function") {
    throw new Error("Direct tool renderer must return a terminal component");
  }
  return {
    lines: component.render(width).map((line) => ({ spans: [{ text: line }] })),
  };
}

function directToolRenderer<TParams extends TSchema, TDetails, TState>(
  tool: DirectToolDefinition<TParams, TDetails, TState>,
  workspace: string,
): RuntimeToolRenderer | undefined {
  if (tool.renderShell === undefined && tool.renderCall === undefined && tool.renderResult === undefined) return undefined;
  const states = new Map<string, DirectToolRendererState>();
  const selectedState = (callId: string): DirectToolRendererState => {
    let state = states.get(callId);
    if (state === undefined) {
      state = { state: {} };
      states.set(callId, state);
    }
    return state;
  };
  const renderContext = (
    view: Readonly<RuntimeToolRenderView>,
    bridge: RuntimeToolRenderBridge | undefined,
    state: DirectToolRendererState,
    lastComponent: Component | undefined,
  ) => ({
    args: view.input as never,
    toolCallId: view.callId,
    invalidate() { bridge?.invalidate(); },
    lastComponent,
    state: state.state,
    cwd: workspace,
    executionStarted: view.status !== "pending",
    argsComplete: view.status !== "pending",
    isPartial: view.isPartial === true,
    expanded: view.expanded,
    showImages: bridge?.showImages ?? true,
    isError: view.result?.isError ?? false,
  });
  return {
    ...(tool.renderShell === undefined ? {} : { renderShell: tool.renderShell }),
    ...(tool.renderCall === undefined ? {} : {
      renderCall(view: Readonly<RuntimeToolRenderView>, context: RuntimeUiRenderContext, bridge?: RuntimeToolRenderBridge) {
        const state = selectedState(view.callId);
        const component = tool.renderCall!(
          view.input as never,
          directRendererTheme(context, bridge),
          renderContext(view, bridge, state, state.callComponent) as unknown as Parameters<
            NonNullable<typeof tool.renderCall>
          >[2],
        );
        state.callComponent = component;
        return directComponentBlock(component, context.width);
      },
    }),
    ...(tool.renderResult === undefined ? {} : {
      renderResult(view: Readonly<RuntimeToolRenderView>, context: RuntimeUiRenderContext, bridge?: RuntimeToolRenderBridge) {
        if (view.result === undefined) return undefined;
        const state = selectedState(view.callId);
        const canonicalContent = view.result.contentBlocks ?? [
          ...(view.result.content === "" ? [] : [{ type: "text" as const, text: view.result.content }]),
          ...(view.images ?? []),
        ];
        const publicContent = extensionInputContent(canonicalContent);
        const content = typeof publicContent === "string" ? [{ type: "text" as const, text: publicContent }] : publicContent;
        const component = tool.renderResult!(
          {
            content,
            details: view.result.metadata as TDetails,
            ...(view.result.usage === undefined ? {} : { usage: extensionUsage(view.result.usage) }),
            ...(view.result.addedToolNames === undefined ? {} : { addedToolNames: [...view.result.addedToolNames] }),
          },
          { expanded: view.expanded, isPartial: view.isPartial === true },
          directRendererTheme(context, bridge),
          renderContext(view, bridge, state, state.resultComponent) as unknown as Parameters<
            NonNullable<typeof tool.renderResult>
          >[3],
        );
        state.resultComponent = component;
        return directComponentBlock(component, context.width);
      },
    }),
  };
}

function directSourceInfo(path: string, scope: ExtensionScope): SourceInfo {
  return {
    path,
    source: path,
    scope: scope === "user" ? "user" : scope === "project" ? "project" : "temporary",
    origin: "top-level",
    ...(path.startsWith("<") ? {} : { baseDir: dirname(path) }),
  };
}

function directToolInfo(tool: RuntimeToolCatalogEntry): DirectToolInfo {
  const sourcePath = tool.owner.kind === "extension"
    ? tool.owner.sourcePath
    : `<${tool.owner.kind}:${tool.name}>`;
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as DirectToolInfo["parameters"],
    ...(tool.promptGuidelines === undefined ? {} : { promptGuidelines: [...tool.promptGuidelines] }),
    sourceInfo: directSourceInfo(sourcePath, tool.owner.kind === "extension" ? "project" : "builtin"),
  };
}

function activation(
  entry: ExtensionRuntimeEntry,
  workspace: string,
  dataPaths: RuntimeExtensionDataPaths,
  host: RuntimeExtensionHost,
  eventBus?: CoreEventBus,
  hidden?: boolean,
): { staged: StagedActivation; api: ExtensionAPI } {
  const compatibilitySourceInfo = directSourceInfo(entry.sourcePath, entry.scope ?? "invocation");
  const compatibilityProjection: DirectExtension = {
    path: entry.sourcePath,
    resolvedPath: entry.sourcePath,
    sourceInfo: compatibilitySourceInfo,
    ...(hidden === undefined ? {} : { hidden }),
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    entryRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
  const generation: RuntimeExtensionGeneration = {
    active: true,
    abortController: new AbortController(),
    entry,
    dataPaths,
    compatibilityProjection,
    committedTools: [],
    committedShortcuts: [],
    committedFlags: [],
  };
  const staged: StagedActivation = {
    entry,
    generation,
    committed: false,
    tools: [],
    commands: [],
    shortcuts: [],
    flags: [],
    flagDefaults: new Map(),
    directProviders: [],
    toolRenderers: [],
    messageRenderers: [],
    entryRenderers: [],
    listeners: [],
    sharedListeners: [],
    disposers: [],
    moduleDisposers: [],
    ui: [],
    advancedUi: [],
  };
  const assertActive = (): void => {
    if (!generation.active) throw new Error(`Runtime extension context is no longer active: ${entry.extensionId}`);
  };
  const events: ExtensionAPI["events"] = {
    on(topicValue, handler) {
      assertActive();
      const topic = sharedEventTopic(topicValue);
      if (typeof handler !== "function") throw new Error("Shared event listener must be a function");
      if (eventBus !== undefined) {
        const unsubscribe = onceRuntimeCleanup(eventBus.on(topic, async (payload) => {
          if (!generation.active) return;
          await handler(payload);
        }));
        if (staged.committed) host.registerLiveDisposer(staged.entry, staged.generation, unsubscribe);
        else staged.disposers.push(unsubscribe);
        return unsubscribe;
      }
      const listener: RuntimeSharedEventListener = (payload) => handler(payload);
      if (staged.committed) host.registerLiveSharedListener(staged.entry, staged.generation, topic, listener);
      else staged.sharedListeners.push({ topic, listener });
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        if (!staged.committed) {
          const index = staged.sharedListeners.findIndex((candidate) =>
            candidate.topic === topic && candidate.listener === listener);
          if (index >= 0) staged.sharedListeners.splice(index, 1);
          return;
        }
        host.unregisterLiveSharedListener(staged.entry, staged.generation, topic, listener);
      };
    },
    emit(topicValue, payload) {
      assertActive();
      const topic = sharedEventTopic(topicValue);
      if (eventBus !== undefined) {
        eventBus.emit(topic, payload);
        return;
      }
      host.emitShared(staged.entry, staged.generation, topic, payload);
    },
  };
  const registerRuntimeTool = (tool: RuntimeToolRegistration): void => {
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
    if (tool.inputSchema === null || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)
      || !isJsonValue(tool.inputSchema)) {
      throw new Error("Runtime tool inputSchema must be a JSON object");
    }
    assertSupportedSchema(tool.inputSchema);
    if (tool.prepareInput !== undefined && typeof tool.prepareInput !== "function") {
      throw new Error("Runtime tool prepareInput must be a function");
    }
    if (tool.executionMode !== undefined && !["parallel", "sequential"].includes(tool.executionMode)) {
      throw new Error("Runtime tool executionMode is invalid");
    }
    if (tool.validate !== undefined && typeof tool.validate !== "function") {
      throw new Error("Runtime tool validate must be a function");
    }
    if (tool.resources !== undefined && typeof tool.resources !== "function") {
      throw new Error("Runtime tool resources must be a function");
    }
    if (typeof tool.execute !== "function") throw new Error("Runtime tool execute must be a function");
    const registration = {
      ...tool,
      ...(promptGuidelines === undefined ? {} : { promptGuidelines }),
    };
    if (staged.committed) host.registerLiveTool(staged.entry, staged.generation, registration);
    else staged.tools.push(registration);
  };
  const registerRuntimeToolRenderer = (name: string, renderer: RuntimeToolRenderer): void => {
    assertActive();
    key(name, "Tool renderer name");
    if (renderer === null || typeof renderer !== "object") throw new Error("Runtime tool renderer must be an object");
    if (renderer.renderShell !== undefined && renderer.renderShell !== "default" && renderer.renderShell !== "self") {
      throw new Error("Runtime tool renderShell must be default or self");
    }
    if (renderer.renderCall !== undefined && typeof renderer.renderCall !== "function") {
      throw new Error("Runtime tool renderCall must be a function");
    }
    if (renderer.renderResult !== undefined && typeof renderer.renderResult !== "function") {
      throw new Error("Runtime tool renderResult must be a function");
    }
    if (renderer.renderShell === undefined && renderer.renderCall === undefined && renderer.renderResult === undefined) {
      throw new Error("Runtime tool renderer must define renderShell, renderCall, or renderResult");
    }
    if (staged.committed) host.registerLiveToolRenderer(staged.entry, staged.generation, name, renderer);
    else staged.toolRenderers.push({ name, renderer });
  };
  const registerRuntimeCommand = (name: string, command: RuntimeDirectCommandRegistration): void => {
    assertActive();
    const registration: RuntimeCommandRegistration = {
      name,
      ...(command.description === undefined ? {} : { description: command.description }),
      ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
      ...(command.getArgumentCompletions === undefined
        ? {}
        : { getArgumentCompletions: command.getArgumentCompletions }),
      execute(context) {
        if (typeof command.handler !== "function") throw new Error("Runtime command handler must be a function");
        const { args, ...directContext } = context;
        return command.handler(args, Object.freeze(directContext));
      },
    };
    if (!COMMAND.test(registration.name)) throw new Error("Runtime command name is invalid");
    if (registration.getArgumentCompletions !== undefined && typeof registration.getArgumentCompletions !== "function") {
      throw new Error("Runtime command getArgumentCompletions must be a function");
    }
    if (registration.description !== undefined) bounded(registration.description, "Command description", 4 * 1024);
    if (registration.argumentHint !== undefined) bounded(registration.argumentHint, "Command argument hint", 512);
    if (staged.committed) host.registerLiveCommand(staged.entry, staged.generation, registration);
    else staged.commands.push(registration);
  };
  const registerRuntimeShortcut = (
    shortcut: string,
    selected: RuntimeDirectShortcutRegistration,
  ): void => {
    assertActive();
    if (typeof selected.handler !== "function") throw new Error("Runtime shortcut handler must be a function");
    const normalized = normalizeShortcut(shortcut);
    if (selected.description !== undefined) bounded(selected.description, "Runtime shortcut description", 4 * 1024);
    const registration: RuntimeShortcutRegistration = {
      shortcut: normalized,
      ...(selected.description === undefined ? {} : { description: selected.description }),
      execute(context) { return selected.handler(context as RuntimeDirectShortcutContext); },
    };
    if (staged.committed) host.registerLiveShortcut(staged.entry, staged.generation, registration);
    else staged.shortcuts.push(registration);
  };
  const registerRuntimeFlag = (name: string, selected: Omit<RuntimeFlagRegistration, "name">): void => {
    assertActive();
    const registration = validateFlag({ name, ...selected });
    if (staged.committed) host.registerLiveFlag(staged.entry, staged.generation, registration);
    else {
      staged.flags.push(registration);
      if (
        registration.default !== undefined &&
        host.flagValueForActivation(registration.name) === undefined &&
        !staged.flagDefaults.has(registration.name)
      ) staged.flagDefaults.set(registration.name, registration.default);
    }
  };
  const registerRuntimeListener = (event: RuntimeDirectExtensionEvent, listener: unknown): void => {
    assertActive();
    if (!RUNTIME_DIRECT_EXTENSION_EVENTS.has(event)) throw new Error(`Unknown runtime event: ${event}`);
    if (typeof listener !== "function") throw new Error("Runtime listener must be a function");
    const registered = listener as RuntimeExtensionListener<RuntimeExtensionEvent>;
    if (staged.committed) host.registerLiveListener(staged.entry, staged.generation, event, registered);
    else staged.listeners.push({ event, listener: registered });
  };

  const directApi: ExtensionAPI = {
    onDispose(dispose) {
      assertActive();
      if (typeof dispose !== "function") throw new Error("Runtime extension disposer must be a function");
      const cleanup = onceRuntimeCleanup(dispose);
      if (staged.committed) host.registerLiveDisposer(staged.entry, staged.generation, cleanup);
      else staged.disposers.push(cleanup);
    },
    on(event, listener) {
      registerRuntimeListener(event, listener);
      const handlers = compatibilityProjection.handlers.get(event) ?? [];
      handlers.push(listener as never);
      compatibilityProjection.handlers.set(event, handlers);
    },
    registerTool(tool) {
      registerRuntimeTool(directToolRegistration(tool));
      compatibilityProjection.tools.set(tool.name, {
        definition: tool as never,
        sourceInfo: compatibilitySourceInfo,
      });
      const renderer = directToolRenderer(tool, workspace);
      if (!staged.committed) {
        for (let index = staged.toolRenderers.length - 1; index >= 0; index -= 1) {
          if (staged.toolRenderers[index]?.name === tool.name) staged.toolRenderers.splice(index, 1);
        }
      }
      if (renderer !== undefined) {
        registerRuntimeToolRenderer(tool.name, renderer);
      }
    },
    registerCommand(name, registration) {
      registerRuntimeCommand(name, registration as unknown as RuntimeDirectCommandRegistration);
      compatibilityProjection.commands.set(name, {
        name,
        sourceInfo: compatibilitySourceInfo,
        ...registration,
      });
    },
    registerShortcut(shortcut, registration) {
      registerRuntimeShortcut(shortcut, registration as RuntimeDirectShortcutRegistration);
      compatibilityProjection.shortcuts.set(shortcut, {
        shortcut,
        extensionPath: entry.sourcePath,
        ...registration,
      });
    },
    registerFlag(name, registration) {
      registerRuntimeFlag(name, registration);
      compatibilityProjection.flags.set(name, {
        name,
        extensionPath: entry.sourcePath,
        ...registration,
      });
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
    registerMessageRenderer(customType, renderer) {
      assertActive();
      const selected = bounded(customType, "Message renderer type", 1_024);
      if (selected === "" || typeof renderer !== "function") throw new Error("Runtime message renderer is invalid");
      if (staged.committed) host.registerLiveMessageRenderer(
        staged.entry,
        staged.generation,
        selected,
        renderer as RuntimeDirectMessageRenderer,
      );
      else staged.messageRenderers.push({ customType: selected, renderer: renderer as RuntimeDirectMessageRenderer });
      compatibilityProjection.messageRenderers.set(selected, renderer as never);
    },
    registerEntryRenderer(customType, renderer) {
      assertActive();
      const selected = bounded(customType, "Entry renderer type", 1_024);
      if (selected === "" || typeof renderer !== "function") throw new Error("Runtime entry renderer is invalid");
      if (staged.committed) host.registerLiveEntryRenderer(
        staged.entry,
        staged.generation,
        selected,
        renderer as RuntimeDirectEntryRenderer,
      );
      else staged.entryRenderers.push({ customType: selected, renderer: renderer as RuntimeDirectEntryRenderer });
      compatibilityProjection.entryRenderers?.set(selected, renderer as never);
    },
    sendMessage(message, options) {
      assertActive();
      host.directActions(staged.entry, staged.generation).sendMessage({
        ...message,
        content: canonicalInputContent(message.content),
      }, options);
    },
    sendUserMessage(content, options) {
      assertActive();
      host.directActions(staged.entry, staged.generation).sendUserMessage(canonicalInputContent(content), options);
    },
    appendEntry(customType, data) {
      assertActive();
      host.directActions(staged.entry, staged.generation).appendEntry(customType, data);
    },
    setSessionName(name) {
      assertActive();
      host.directActions(staged.entry, staged.generation).setSessionName(name);
    },
    getSessionName() {
      assertActive();
      return host.directActions(staged.entry, staged.generation).getSessionName();
    },
    setLabel(entryId, label) {
      assertActive();
      host.directActions(staged.entry, staged.generation).setLabel(entryId, label);
    },
    async exec(command, args, options) {
      assertActive();
      return await host.directActions(staged.entry, staged.generation).exec(command, args, options);
    },
    getActiveTools() {
      assertActive();
      return host.directActions(staged.entry, staged.generation).getActiveTools();
    },
    getAllTools() {
      assertActive();
      return host.directActions(staged.entry, staged.generation).getAllTools().map(directToolInfo);
    },
    setActiveTools(toolNames) {
      assertActive();
      host.directActions(staged.entry, staged.generation).setActiveTools(toolNames);
    },
    getCommands() {
      assertActive();
      return host.getUnifiedCommands(staged.entry, staged.generation);
    },
    async getDiscoveryView(signal) {
      assertActive();
      return await host.getDiscoveryView(staged.entry, staged.generation, signal);
    },
    async setModel(model) {
      assertActive();
      return await host.directActions(staged.entry, staged.generation).setModel(model);
    },
    getThinkingLevel() {
      assertActive();
      return host.directActions(staged.entry, staged.generation).getThinkingLevel() as ReturnType<
        ExtensionAPI["getThinkingLevel"]
      >;
    },
    setThinkingLevel(level) {
      assertActive();
      host.directActions(staged.entry, staged.generation).setThinkingLevel(level);
    },
    registerProvider(providerOrName: ExtensionProvider | string, config?: RuntimeDirectProviderConfig) {
      assertActive();
      const name = typeof providerOrName === "string" ? providerOrName : providerOrName.id;
      key(name, "Provider ID");
      if (!staged.committed) {
        for (let index = staged.directProviders.length - 1; index >= 0; index -= 1) {
          if (staged.directProviders[index]?.name === name) staged.directProviders.splice(index, 1);
        }
        if (typeof providerOrName === "string") {
          if (config === undefined) throw new Error("Provider config is required when registering by name");
          staged.directProviders.push({ name, config });
        } else staged.directProviders.push({ name, provider: providerOrName });
        return;
      }
      if (typeof providerOrName === "string") {
        if (config === undefined) throw new Error("Provider config is required when registering by name");
        host.directActions(staged.entry, staged.generation).registerProvider(providerOrName, config);
        return;
      }
      host.directActions(staged.entry, staged.generation).registerProvider(providerOrName);
    },
    unregisterProvider(name) {
      assertActive();
      key(name, "Provider ID");
      if (!staged.committed) {
        for (let index = staged.directProviders.length - 1; index >= 0; index -= 1) {
          if (staged.directProviders[index]?.name === name) staged.directProviders.splice(index, 1);
        }
        return;
      }
      host.directActions(staged.entry, staged.generation).unregisterProvider(name);
    },
    events: Object.freeze(events),
  };
  return {
    staged,
    api: Object.freeze(directApi),
  };
}

export interface RuntimeExtensionHostOptions {
  /** Per cleanup phase. Host close uses separate disposer, live-registration, and module phases. */
  shutdownTimeoutMs?: number;
  /** Aggregate bound for resources_discover when the caller does not supply a signal. */
  resourceDiscoveryTimeoutMs?: number;
  /** Root for extension-owned durable data; callers embedding the loader may override it. */
  dataRoot?: string;
  /** Initial callback mode; embedded/headless loaders use print semantics by default. */
  mode?: RuntimeExtensionMode;
  projectTrusted?: boolean;
  directActionsHandler?: RuntimeDirectActionsHandler;
  directContextHandler?: RuntimeDirectContextHandler;
  directUiHandler?: RuntimeDirectUiHandler;
}

export class RuntimeExtensionHost {
  readonly #workspace: string;
  readonly #dataRoot: string;
  readonly #shutdownTimeoutMs: number;
  readonly #resourceDiscoveryTimeoutMs: number;
  readonly #tools = new Map<string, HarnessTool>();
  readonly #toolOwners = new WeakMap<HarnessTool, Extract<RuntimeCatalogOwner, { kind: "extension" }>>();
  readonly #commands: OwnedCommand[] = [];
  readonly #shortcuts = new Map<string, OwnedShortcut>();
  readonly #flags = new Map<string, OwnedFlag>();
  readonly #flagValues = new Map<string, boolean | string>();
  readonly #directProviders: Array<{
    entry: ExtensionRuntimeEntry;
    generation: RuntimeExtensionGeneration;
    registration:
      | { name: string; config: RuntimeDirectProviderConfig }
      | { name: string; provider: ExtensionProvider };
  }> = [];
  readonly #toolRenderers = new Map<string, OwnedRenderer<RuntimeToolRenderer>>();
  readonly #messageRenderers: OwnedDirectRenderer<RuntimeDirectMessageRenderer>[] = [];
  readonly #entryRenderers: OwnedDirectRenderer<RuntimeDirectEntryRenderer>[] = [];
  readonly #listeners = new Map<RuntimeExtensionEvent, OwnedListener[]>();
  readonly #sharedListeners = new Map<string, OwnedSharedListener[]>();
  readonly #disposers: Array<() => void | Promise<void>> = [];
  readonly #moduleDisposers: Array<() => void | Promise<void>> = [];
  readonly #initialUi: RuntimeInitialUiOperation[] = [];
  readonly #initialAdvancedUi: RuntimeAdvancedUiOperation[] = [];
  readonly #diagnostics: RuntimeExtensionDiagnostic[] = [];
  readonly #errorListeners = new Set<(diagnostic: RuntimeExtensionDiagnostic) => void>();
  #diagnosticsTruncated = false;
  readonly #rendererFailureKeys = new Set<string>();
  readonly #lifecycle = new AbortController();
  readonly #generations: RuntimeExtensionGeneration[] = [];
  readonly #disabledCommands = new WeakMap<RuntimeExtensionGeneration, ReadonlySet<string>>();
  readonly #disabledResources = new WeakMap<
    RuntimeExtensionGeneration,
    Readonly<Partial<Record<"skill" | "prompt" | "theme", readonly string[]>>>
  >();
  readonly #activeLifecycleListeners = new Map<RuntimeExtensionGeneration, number>();
  readonly #registrationCleanups: Array<() => void | Promise<void>> = [];
  readonly #changeListeners = new Set<(change: RuntimeExtensionChange) => void>();
  readonly #requesterThread = new AsyncLocalStorage<{ threadId: string }>();
  readonly #currentSystemPrompt = new AsyncLocalStorage<RuntimeNativeSystemPromptSnapshot>();
  readonly #systemPrompts = new Map<string, RuntimeNativeSystemPromptSnapshot>();
  readonly #nativeUiHosts = new Map<RuntimeExtensionGeneration, NativeUiHost>();
  readonly #unsafeTerminalHosts = new Map<RuntimeExtensionGeneration, UnsafeTerminalHost>();
  #liveRegistrationHandler: RuntimeLiveRegistrationHandler | undefined;
  #nativeUiHandler: ((extensionId: string, signal: AbortSignal) => NativeUiHost) | undefined;
  #unsafeTerminalHandler: ((extensionId: string, signal: AbortSignal) => UnsafeTerminalHost) | undefined;
  #uiHandler: ((operation: RuntimeInitialUiOperation) => void) | undefined;
  #advancedUiHandler: RuntimeAdvancedUiHostHandler | undefined;
  #interactiveUiHandler: RuntimeInteractiveUiHandler | undefined;
  #directContextHandler: RuntimeDirectContextHandler | undefined;
  #directActionsHandler: RuntimeDirectActionsHandler | undefined;
  #directUiHandler: RuntimeDirectUiHandler | undefined;
  #directDiscoveryHandler: RuntimeDirectDiscoveryHandler | undefined;
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
    this.#directActionsHandler = options.directActionsHandler;
    this.#directContextHandler = options.directContextHandler;
    this.#directUiHandler = options.directUiHandler;
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

  /** Aborts exactly once when this loaded extension generation is replaced or closed. */
  lifecycleSignal(): AbortSignal {
    return this.#lifecycle.signal;
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

  hostContext(): { mode: RuntimeExtensionMode; projectTrusted: boolean } {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    return { mode: this.#mode, projectTrusted: this.#projectTrusted };
  }

  tools(): HarnessTool[] {
    return [...this.#tools.values()];
  }

  directProviderRegistrations(): Array<
    | { name: string; config: RuntimeDirectProviderConfig }
    | { name: string; provider: ExtensionProvider }
  > {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    return this.#directProviders
      .filter((entry) => entry.generation.active)
      .map((entry) => ({ ...entry.registration }));
  }

  extensions(): ExtensionRuntimeEntry[] {
    return this.#generations
      .filter((generation) => generation.active)
      .map((generation) => ({ ...generation.entry }));
  }

  /** Read-only compatibility metadata for a loaded direct factory; execution remains host-owned. */
  compatibilityProjection(sourcePath: string): DirectExtension | undefined {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    return this.#generations.find((generation) =>
      generation.active && generation.entry.sourcePath === sourcePath)?.compatibilityProjection;
  }

  /**
   * Reapply final package precedence after the project-trust bootstrap has
   * appended project factories to an already-active host. Factories are not
   * evaluated again. This operation is intentionally limited to the pre-bind
   * loading phase because an external live tool registry cannot be reordered
   * transactionally after it has started serving runs.
   */
  reorderCommittedExtensions(sourcePaths: readonly string[]): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    if (this.#liveRegistrationHandler !== undefined) {
      throw new Error("Runtime extensions cannot be reordered after live registration is bound");
    }
    const pathOrder = new Map<string, number>();
    for (const sourcePath of sourcePaths) {
      const path = resolve(sourcePath);
      if (!pathOrder.has(path)) pathOrder.set(path, pathOrder.size);
    }
    const priorOrder = new Map(this.#generations.map((generation, index) => [generation, index] as const));
    const rank = (generation: RuntimeExtensionGeneration): number => {
      const sourcePath = generation.entry.sourcePath;
      const configured = sourcePath.startsWith("<") ? undefined : pathOrder.get(resolve(sourcePath));
      if (configured !== undefined) return configured;
      return pathOrder.size + (sourcePath.startsWith("<inline:") ? 1 : 0);
    };
    const compare = (left: RuntimeExtensionGeneration, right: RuntimeExtensionGeneration): number =>
      rank(left) - rank(right) || (priorOrder.get(left) ?? 0) - (priorOrder.get(right) ?? 0);
    this.#generations.sort(compare);
    const generationOrder = new Map(this.#generations.map((generation, index) => [generation, index] as const));
    const compareOwned = (
      left: { generation: RuntimeExtensionGeneration },
      right: { generation: RuntimeExtensionGeneration },
    ): number => (generationOrder.get(left.generation) ?? Number.MAX_SAFE_INTEGER)
      - (generationOrder.get(right.generation) ?? Number.MAX_SAFE_INTEGER);
    this.#commands.sort(compareOwned);
    this.#directProviders.sort(compareOwned);
    this.#messageRenderers.sort(compareOwned);
    this.#entryRenderers.sort(compareOwned);
    for (const listeners of this.#listeners.values()) listeners.sort(compareOwned);
    for (const listeners of this.#sharedListeners.values()) listeners.sort(compareOwned);

    const collision = /Runtime (?:tool .* was ignored because|shortcut .* replaced the registration from)/u;
    const diagnostics = this.#diagnostics.filter((entry) => !collision.test(entry.message));
    this.#diagnostics.splice(0, this.#diagnostics.length, ...diagnostics);

    this.#tools.clear();
    for (const generation of this.#generations) {
      if (!generation.active) continue;
      for (const { registration, tool } of generation.committedTools) {
        const prior = this.#tools.get(registration.name);
        if (prior === undefined) this.#tools.set(registration.name, tool);
        else this.#diagnoseCrossExtensionToolCollision(generation.entry, registration.name, prior);
      }
    }

    this.#shortcuts.clear();
    for (const generation of this.#generations) {
      if (!generation.active) continue;
      for (const shortcut of generation.committedShortcuts) {
        const prior = this.#shortcuts.get(shortcut.shortcut);
        this.#shortcuts.set(shortcut.shortcut, { entry: generation.entry, generation, registration: shortcut });
        if (prior !== undefined && prior.entry.extensionId !== generation.entry.extensionId) {
          this.addDiagnostic({
            extensionId: generation.entry.extensionId,
            sourcePath: generation.entry.sourcePath,
            message: `Runtime shortcut ${shortcut.shortcut} replaced the registration from ${prior.entry.extensionId}`,
          });
        }
      }
    }

    this.#flags.clear();
    for (const generation of this.#generations) {
      if (!generation.active) continue;
      for (const flag of generation.committedFlags) {
        const prior = this.#flags.get(flag.name);
        if (prior === undefined) {
          this.#flags.set(flag.name, {
            entry: generation.entry,
            generation,
            registration: flag,
            owners: new Set([ownerKey(generation.entry)]),
          });
        } else prior.owners.add(ownerKey(generation.entry));
      }
    }
  }

  renderers(): RuntimeRendererDescription[] {
    return [
      ...[...this.#toolRenderers].map(([key, value]): RuntimeRendererDescription => ({
        extensionId: value.entry.extensionId,
        sourcePath: value.entry.sourcePath,
        kind: "tool",
        key,
      })),
      ...this.#messageRenderers.filter((value) => value.generation.active).map((value): RuntimeRendererDescription => ({
        extensionId: value.entry.extensionId,
        sourcePath: value.entry.sourcePath,
        kind: "message",
        key: value.customType,
      })),
      ...this.#entryRenderers.filter((value) => value.generation.active).map((value): RuntimeRendererDescription => ({
        extensionId: value.entry.extensionId,
        sourcePath: value.entry.sourcePath,
        kind: "entry",
        key: value.customType,
      })),
    ];
  }

  messageRenderer(customType: string): RuntimeDirectMessageRenderer | undefined {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    return this.#messageRenderers.find((entry) => entry.generation.active && entry.customType === customType)?.renderer;
  }

  entryRenderer(customType: string): RuntimeDirectEntryRenderer | undefined {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    return this.#entryRenderers.find((entry) => entry.generation.active && entry.customType === customType)?.renderer;
  }

  renderShell(name: string): "default" | "self" | undefined {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    const selected = this.#toolRenderers.get(name);
    return selected?.generation.active === true ? selected.renderer.renderShell : undefined;
  }

  /** Generation-bound adapter consumed directly by the interactive TUI. */
  toolRendererBinding(): RuntimeToolRendererBinding {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    return {
      has: (name) => this.#toolRenderers.get(name)?.generation.active === true,
      renderShell: (name) => this.renderShell(name),
      renderCall: (name, view, context, bridge) => this.renderToolCall(name, view, context, bridge),
      renderResult: (name, view, context, bridge) => this.renderToolResult(name, view, context, bridge),
    };
  }

  renderToolCall(
    name: string,
    view: RuntimeToolRenderView,
    context: RuntimeUiRenderContext,
    bridge?: RuntimeToolRenderBridge,
  ): RuntimeUiBlock | undefined {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    const selected = this.#toolRenderers.get(name);
    if (selected?.renderer.renderCall === undefined) return undefined;
    return this.#renderBlock(selected, `tool call ${name}`, context, (safeContext) => selected.renderer.renderCall?.(
      Object.freeze(structuredClone(view)),
      safeContext,
      bridge,
    ));
  }

  renderToolResult(
    name: string,
    view: RuntimeToolRenderView,
    context: RuntimeUiRenderContext,
    bridge?: RuntimeToolRenderBridge,
  ): RuntimeUiBlock | undefined {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    const selected = this.#toolRenderers.get(name);
    if (selected?.renderer.renderResult === undefined) return undefined;
    return this.#renderBlock(selected, `tool result ${name}`, context, (safeContext) => selected.renderer.renderResult?.(
      Object.freeze(structuredClone(view)),
      safeContext,
      bridge,
    ));
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

  /** Observes sanitized runtime diagnostics as they are recorded. */
  onError(listener: (diagnostic: RuntimeExtensionDiagnostic) => void): () => void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    this.#errorListeners.add(listener);
    return () => { this.#errorListeners.delete(listener); };
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
          cwd,
          mode: this.#mode,
          hasUI: selectedUi.hasUI,
          ui: Object.freeze({
            async select(): Promise<string | undefined> {
              return undefined;
            },
            async confirm(titleValue: string, messageValue: string, options?: RuntimeDirectUiDialogOptions): Promise<boolean> {
              const title = bounded(titleValue, "Runtime project trust confirmation title", 4 * 1024);
              const message = bounded(messageValue, "Runtime project trust confirmation message", 16 * 1024);
              const combined = combinedGenerationSignal(
                owned.generation,
                options?.signal === undefined ? listenerSignal : AbortSignal.any([listenerSignal, options.signal]),
                "Runtime project trust confirmation",
              );
              return await selectedUi.confirm(title, message, combined);
            },
            async input(): Promise<string | undefined> {
              return undefined;
            },
            notify: (message: string, kind: "info" | "warning" | "error" = "info") => this.applyUi({
              extensionId: owned.entry.extensionId,
              type: "notify",
              value: bounded(message, "Notification"),
              kind: kind === "warning" || kind === "error" ? kind : "status",
            }),
          }),
        });
        const listener = owned.listener as unknown as RuntimeExtensionListener<"project_trust">;
        const result = await this.#withLifecycleListener(owned, async () => await withAbort(
          Promise.resolve(listener(
            Object.freeze({ type: "project_trust", cwd: workspace }) as RuntimeExtensionListenerEvent<"project_trust">,
            context,
          )),
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
        const value = runtimeResourcesDiscoverResult(await withAbort(Promise.resolve(listener(Object.freeze({
          type: "resources_discover",
          cwd: this.#workspace,
          reason,
        }) as unknown as RuntimeExtensionListenerEvent<"resources_discover">, context)), listenerSignal));
        const packageRoot = resolve(owned.entry.resourceRoot ?? dirname(owned.entry.sourcePath));
        const disabled = this.#disabledResources.get(owned.generation);
        const enabledPaths = (kind: "skill" | "prompt" | "theme", paths: readonly string[]): string[] => {
          const patterns = disabled?.[kind] ?? [];
          return patterns.length === 0
            ? [...paths]
            : paths.filter((path) => !patterns.some((pattern) => runtimeResourcePatternMatch(path, packageRoot, pattern)));
        };
        const skillPaths = enabledPaths("skill", value.skillPaths);
        const promptPaths = enabledPaths("prompt", value.promptPaths);
        const themePaths = enabledPaths("theme", value.themePaths);
        const added = skillPaths.length + promptPaths.length + themePaths.length;
        if (total + added > MAX_RUNTIME_DISCOVERED_RESOURCE_PATHS) {
          throw new Error(`Runtime resource discovery exceeds ${MAX_RUNTIME_DISCOVERED_RESOURCE_PATHS} total paths`);
        }
        const ownedPath = (path: string): RuntimeDiscoveredResourcePath => {
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
        discovered.skillPaths.push(...skillPaths.map(ownedPath));
        discovered.promptPaths.push(...promptPaths.map(ownedPath));
        discovered.themePaths.push(...themePaths.map(ownedPath));
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
      const diagnostic = {
        extensionId: utf8Prefix(entry.extensionId.replaceAll("\0", ""), 1_024),
        sourcePath: utf8Prefix(entry.sourcePath.replaceAll("\0", ""), 16 * 1_024),
        message: utf8Prefix(entry.message.replaceAll("\0", ""), 4 * 1_024),
      };
      this.#diagnostics.push(diagnostic);
      for (const listener of this.#errorListeners) {
        try { listener({ ...diagnostic }); }
        catch { /* Diagnostic observers must not destabilize the extension host. */ }
      }
      return;
    }
    this.#diagnosticsTruncated = true;
    const diagnostic = {
      extensionId: "runtime",
      sourcePath: "",
      message: `Runtime extension diagnostics exceeded ${MAX_RUNTIME_DIAGNOSTICS} entries`,
    };
    this.#diagnostics[MAX_RUNTIME_DIAGNOSTICS - 1] = diagnostic;
    for (const listener of this.#errorListeners) {
      try { listener({ ...diagnostic }); }
      catch { /* Diagnostic observers must not destabilize the extension host. */ }
    }
  }

  setLiveRegistrationHandler(handler: RuntimeLiveRegistrationHandler): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    if (this.#liveRegistrationHandler !== undefined) throw new Error("Runtime live registration handler is already set");
    this.#liveRegistrationHandler = handler;
  }

  setDirectDiscoveryHandler(handler: RuntimeDirectDiscoveryHandler | undefined): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    this.#directDiscoveryHandler = handler;
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
    this.#assertLive(entry, generation);
    const existing = this.#nativeUiHosts.get(generation);
    if (existing !== undefined) return existing;
    const handler = this.#nativeUiHandler;
    if (handler === undefined) throw new Error("Native UI is unavailable without an interactive TUI");
    const selected = handler(entry.extensionId, generation.abortController.signal);
    this.#nativeUiHosts.set(generation, selected);
    return selected;
  }

  rollbackNativeUi(generation: RuntimeExtensionGeneration): void {
    const selected = this.#nativeUiHosts.get(generation);
    if (selected === undefined) return;
    this.#nativeUiHosts.delete(generation);
    selected.dispose();
  }

  unsafeTerminal(entry: ExtensionRuntimeEntry, generation: RuntimeExtensionGeneration): UnsafeTerminalHost {
    this.#assertLive(entry, generation);
    const existing = this.#unsafeTerminalHosts.get(generation);
    if (existing !== undefined) return existing;
    const handler = this.#unsafeTerminalHandler;
    if (handler === undefined) throw new Error("Unsafe terminal access is unavailable without an interactive TUI");
    const selected = handler(entry.extensionId, generation.abortController.signal);
    this.#unsafeTerminalHosts.set(generation, selected);
    return selected;
  }

  rollbackUnsafeTerminal(generation: RuntimeExtensionGeneration): void {
    const selected = this.#unsafeTerminalHosts.get(generation);
    if (selected === undefined) return;
    this.#unsafeTerminalHosts.delete(generation);
    selected.dispose();
  }

  /** Binds the raw, synchronous context exposed to trusted direct factories. */
  setDirectContextHandler(handler: RuntimeDirectContextHandler | undefined): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    this.#directContextHandler = handler;
  }

  /** Binds implicit-current actions used by the trusted direct factory API. */
  setDirectActionsHandler(handler: RuntimeDirectActionsHandler | undefined): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    this.#directActionsHandler = handler;
  }

  setDirectUiHandler(handler: RuntimeDirectUiHandler | undefined): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    this.#directUiHandler = handler;
  }

  directActions(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
  ): RuntimeDirectActionsHandler {
    this.#assertLive(entry, generation);
    const handler = this.#directActionsHandler;
    if (handler === undefined) throw new Error("Direct extension actions are unavailable before the session host is bound");
    return handler;
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
    }
    const tool = new RuntimeHarnessTool(
      registration,
      (context) => this.#runtimeToolContext(entry, generation, context),
      async (context, execute) => await this.#requesterThread.run({ threadId: context.threadId }, execute),
      () => this.#directActionsHandler?.getActiveTools(),
    );
    const cleanup = prior === undefined
      ? this.#liveRegistrationHandler?.registerTool(tool)
      : this.#liveRegistrationHandler?.replaceTool(prior, tool);
    if (prior !== undefined) {
      for (const active of this.#generations) {
        const index = active.committedTools.findIndex((owned) => owned.tool === prior);
        if (index >= 0) active.committedTools.splice(index, 1);
      }
    }
    generation.committedTools.push({ registration, tool });
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
    if (this.#disabledCommands.get(generation)?.has(command.name) === true) return;
    const prior = this.#commands.findIndex((owned) =>
      ownerKey(owned.entry) === ownerKey(entry) && owned.registration.name === command.name);
    const owned = { entry, generation, registration: command };
    if (prior < 0) this.#commands.push(owned);
    else this.#commands.splice(prior, 1, owned);
    if (isBuiltinSlashCommand(command.name)) {
      const occurrence = this.#commands.filter((owned) => owned.registration.name === command.name).length;
      this.addDiagnostic({
        extensionId: entry.extensionId,
        sourcePath: entry.sourcePath,
        message: `Runtime extension command ${command.name} conflicts with a built-in command and is available as ${command.name}:${occurrence}`,
      });
    }
    this.#changed("command", entry);
  }

  suppressCommands(staged: StagedActivation, names: readonly string[]): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    if (staged.committed) throw new Error("Runtime extension activation is already committed");
    const disabled = new Set(names);
    this.#disabledCommands.set(staged.generation, disabled);
    staged.commands.splice(0, staged.commands.length, ...staged.commands.filter((command) => !disabled.has(command.name)));
  }

  suppressResources(
    staged: StagedActivation,
    filters: Readonly<Partial<Record<"skill" | "prompt" | "theme", readonly string[]>>>,
  ): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    if (staged.committed) throw new Error("Runtime extension activation is already committed");
    this.#disabledResources.set(staged.generation, filters);
  }

  registerLiveShortcut(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    shortcut: RuntimeShortcutRegistration,
  ): void {
    this.#assertLive(entry, generation);
    generation.committedShortcuts.push(shortcut);
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
    generation.committedFlags.push(flag);
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

  getCommands(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
  ): RuntimeCommandDescription[] {
    this.#assertLive(entry, generation);
    const commands = this.commands();
    if (commands.length > MAX_RUNTIME_ACTIVE_TOOLS) {
      throw new Error(`Runtime command catalog exceeds ${MAX_RUNTIME_ACTIVE_TOOLS} commands`);
    }
    return cloneBounded([...commands], "Runtime command catalog", MAX_RUNTIME_CATALOG_BYTES);
  }

  getUnifiedCommands(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
  ): SlashCommandInfo[] {
    this.#assertLive(entry, generation);
    const commands = this.#directActionsHandler?.getCommands?.() ?? this.getCommands(entry, generation).map((command) => ({
      name: command.name,
      ...(command.description === undefined ? {} : { description: command.description }),
      source: "extension" as const,
      sourceInfo: directSourceInfo(command.sourcePath, command.scope),
    }));
    if (commands.length > MAX_RUNTIME_ACTIVE_TOOLS) {
      throw new Error(`Runtime command catalog exceeds ${MAX_RUNTIME_ACTIVE_TOOLS} commands`);
    }
    return cloneBounded([...commands], "Runtime command catalog", MAX_RUNTIME_CATALOG_BYTES);
  }

  async getDiscoveryView(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    signal?: AbortSignal,
  ): Promise<RuntimeDiscoveryView> {
    this.#assertLive(entry, generation);
    signal?.throwIfAborted();
    const handler = this.#directDiscoveryHandler;
    if (handler === undefined) throw new Error("Runtime resource discovery is not available");
    const result = await handler(signal);
    this.#assertLive(entry, generation);
    signal?.throwIfAborted();
    return cloneBounded(result, "Runtime discovery view", MAX_RUNTIME_CATALOG_BYTES);
  }

  registerLiveToolRenderer(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    name: string,
    renderer: RuntimeToolRenderer,
  ): void {
    this.#assertLive(entry, generation);
    const prior = this.#toolRenderers.get(name);
    if (prior !== undefined && ownerKey(prior.entry) !== ownerKey(entry)) {
      throw new Error("Runtime extension registered a duplicate tool renderer");
    }
    this.#toolRenderers.set(name, { entry, generation, renderer });
    this.#changed("tool_renderer", entry);
  }

  registerLiveMessageRenderer(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    customType: string,
    renderer: RuntimeDirectMessageRenderer,
  ): void {
    this.#assertLive(entry, generation);
    const existing = this.#messageRenderers.findIndex((owned) =>
      owned.generation === generation && owned.customType === customType);
    const owned = { entry, generation, customType, renderer };
    if (existing < 0) this.#messageRenderers.push(owned);
    else this.#messageRenderers[existing] = owned;
    this.#changed("session_renderer", entry);
  }

  registerLiveEntryRenderer(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    customType: string,
    renderer: RuntimeDirectEntryRenderer,
  ): void {
    this.#assertLive(entry, generation);
    const existing = this.#entryRenderers.findIndex((owned) =>
      owned.generation === generation && owned.customType === customType);
    const owned = { entry, generation, customType, renderer };
    if (existing < 0) this.#entryRenderers.push(owned);
    else this.#entryRenderers[existing] = owned;
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

  unregisterLiveSharedListener(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    topic: string,
    listener: RuntimeSharedEventListener,
  ): void {
    if (!generation.active) return;
    const listeners = this.#sharedListeners.get(topic);
    if (listeners === undefined) return;
    const index = listeners.findIndex((owned) =>
      owned.entry === entry && owned.generation === generation && owned.listener === listener);
    if (index >= 0) listeners.splice(index, 1);
    if (listeners.length === 0) this.#sharedListeners.delete(topic);
  }

  emitShared(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    topicValue: string,
    payload: unknown,
  ): void {
    this.#assertLive(entry, generation);
    const topic = sharedEventTopic(topicValue);
    for (const owned of [...(this.#sharedListeners.get(topic) ?? [])]) {
      if (!owned.generation.active) continue;
      try {
        void Promise.resolve(owned.listener(
          payload as JsonValue,
          this.#listenerContext(owned, owned.generation.abortController.signal),
        )).catch((cause: unknown) => {
          if (owned.generation.active) this.#recordOwnedFailure(owned.entry, `shared event ${topic}`, cause);
        });
      } catch (cause) {
        this.#recordOwnedFailure(owned.entry, `shared event ${topic}`, cause);
      }
    }
  }

  registerLiveDisposer(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    dispose: () => void | Promise<void>,
  ): void {
    this.#assertLive(entry, generation);
    this.#disposers.push(dispose);
  }

  #assertLive(entry: ExtensionRuntimeEntry, generation: RuntimeExtensionGeneration): void {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    if (!generation.active) throw new Error(`Runtime extension context is no longer active: ${entry.extensionId}`);
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
        invocationName: isBuiltinSlashCommand(base) || (counts.get(base) ?? 0) > 1 ? `${base}:${occurrence}` : base,
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
    const listenerContext = this.#listenerContext(selected, signal, {
      threadId: context.threadId,
      ...(context.branch === undefined ? {} : { branch: context.branch }),
    });
    const ui = context.ui === undefined
      ? listenerContext.ui
      : this.#directUiContext(selected, signal, context.ui);
    const actions = this.directActions(selected.entry, selected.generation);
    const commandContext: RuntimeDirectCommandContext & { args: string } = Object.freeze({
      ...listenerContext,
      ui,
      args: context.args,
      getSystemPromptOptions: actions.getSystemPromptOptions,
      waitForIdle: actions.waitForIdle,
      newSession: actions.newSession,
      fork: actions.fork,
      navigateTree: actions.navigateTree,
      switchSession: actions.switchSession,
      reload: actions.reload,
    });
    try {
      const result = await withAbort(
        Promise.resolve().then(async () => await selected.registration.execute(commandContext)),
        signal,
      );
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
      const listenerContext = this.#listenerContext(selected, signal, {
        threadId: context.threadId,
        ...(context.branch === undefined ? {} : { branch: context.branch }),
      });
      const actions = this.directActions(selected.entry, selected.generation);
      const shortcutContext: RuntimeDirectShortcutContext = Object.freeze({
        ...listenerContext,
        getSystemPromptOptions: actions.getSystemPromptOptions,
        waitForIdle: actions.waitForIdle,
        newSession: actions.newSession,
        fork: actions.fork,
        navigateTree: actions.navigateTree,
        switchSession: actions.switchSession,
        reload: actions.reload,
      });
      await withAbort(
        Promise.resolve().then(async () => await selected.registration.execute(shortcutContext)),
        signal,
      );
    } catch (cause) {
      if (signal.aborted) throw abortError(signal);
      this.#recordOwnedFailure(selected.entry, "shortcut", cause);
    }
    return { handled: true };
  }

  #directUiContext(
    owned: Pick<OwnedListener, "entry" | "generation">,
    signal: AbortSignal,
    legacy: RuntimeCommandUi,
  ): RuntimeDirectUiContext {
    const bound = this.#directUiHandler?.(owned.entry.extensionId, signal);
    if (bound !== undefined) return bound;
    const native = (): NativeUiHost => this.nativeUi(owned.entry, owned.generation);
    const terminal = (): UnsafeTerminalHost => this.unsafeTerminal(owned.entry, owned.generation);
    let editorFactory: RuntimeDirectEditorFactory | undefined;
    return Object.freeze<RuntimeDirectUiContext>({
      async select(title, options, opts) {
        const selected = await legacy.select(
          title,
          options.map((value) => ({ label: value, value })),
          opts?.signal,
        );
        return selected;
      },
      async confirm(title, message, opts) {
        return await legacy.confirm(title, message, opts?.signal);
      },
      async input(title, placeholder, opts) {
        return await legacy.input(title, placeholder, opts?.signal);
      },
      notify(message, type = "info") {
        legacy.notify(message, type === "info" ? "status" : type);
      },
      onTerminalInput(handler) {
        if (typeof handler !== "function") throw new TypeError("Terminal input handler must be a function");
        try {
          return terminal().onInput((data) => handler(data));
        } catch {
          return () => undefined;
        }
      },
      setStatus: legacy.setStatus,
      setWorkingMessage: legacy.setWorkingMessage,
      setWorkingVisible(visible) { legacy.setWorkingVisible(visible); },
      setWorkingIndicator: (options) => {
        this.applyAdvancedUi({
          extensionId: owned.entry.extensionId,
          signal,
          type: "working_indicator",
          ...(options === undefined
            ? {}
            : { value: { frames: [...(options.frames ?? [])], intervalMs: options.intervalMs ?? 80 } }),
        });
      },
      setHiddenThinkingLabel: (label) => {
        this.applyAdvancedUi({
          extensionId: owned.entry.extensionId,
          signal,
          type: "hidden_reasoning_label",
          ...(label === undefined ? {} : { value: label }),
        });
      },
      setWidget(keyValue, content) {
        if (content === undefined || Array.isArray(content)) {
          legacy.setWidget(keyValue, content?.join("\n"));
          return;
        }
        throw new Error("Raw persistent component factories require an interactive direct UI host");
      },
      setFooter(factory) {
        if (factory !== undefined) throw new Error("Raw footer factories require an interactive direct UI host");
        legacy.setFooter("direct", undefined);
      },
      setHeader(factory) {
        if (factory !== undefined) throw new Error("Raw header factories require an interactive direct UI host");
        legacy.setHeader("direct", undefined);
      },
      setTitle: legacy.setTitle,
      async custom() {
        throw new Error("Raw custom components require an interactive direct UI host");
      },
      pasteToEditor(text) {
        try { native().pasteToEditor(text); }
        catch { legacy.setEditorText(`${legacy.getEditorText()}${text}`); }
      },
      setEditorText: legacy.setEditorText,
      getEditorText: legacy.getEditorText,
      async editor(title, prefill) { return await legacy.editor(title, prefill, signal); },
      addAutocompleteProvider() {
        throw new Error("Raw autocomplete providers require an interactive direct UI host");
      },
      setEditorComponent(factory) {
        editorFactory = factory;
        if (factory !== undefined) {
          throw new Error("Raw editor factories require an interactive direct UI host");
        }
      },
      getEditorComponent() { return editorFactory; },
      get theme() { return native().currentTheme(); },
      getAllThemes() { return native().themeCatalog().map((theme) => ({ name: theme.name, path: undefined })); },
      getTheme(name) { return native().themeCatalog().find((theme) => theme.name === name); },
      setTheme(value) {
        const selected = typeof value === "string"
          ? native().themeCatalog().find((theme) => theme.name === value)
          : value;
        if (selected === undefined) return { success: false, error: `Unknown theme: ${value}` };
        native().applyTheme(selected);
        return { success: true };
      },
      getToolsExpanded: () => this.getAdvancedUiToolOutputExpanded(owned.entry, owned.generation),
      setToolsExpanded: (expanded) => this.applyAdvancedUi({
        extensionId: owned.entry.extensionId,
        signal,
        type: "tool_output_expanded",
        expanded,
      }),
    });
  }

  #directModelRegistry(
    owned: Pick<OwnedListener, "entry" | "generation">,
    internal: InternalModelRegistry,
  ): ExtensionModelRegistry {
    const registry = extensionModelRegistry(internal);
    const registerProvider = (
      providerOrName: ExtensionProvider | string,
      config?: ExtensionProviderConfig,
    ): void => {
      this.#assertLive(owned.entry, owned.generation);
      const actions = this.directActions(owned.entry, owned.generation);
      if (typeof providerOrName === "string") {
        if (config === undefined) throw new Error("Provider config is required when registering by name");
        actions.registerProvider(providerOrName, config);
      } else actions.registerProvider(providerOrName);
    };
    const unregisterProvider = (name: string): void => {
      this.#assertLive(owned.entry, owned.generation);
      this.directActions(owned.entry, owned.generation).unregisterProvider(name);
    };
    const methods = new Map<PropertyKey, unknown>();
    return new Proxy(registry, {
      get(target, property) {
        if (property === "registerProvider") return registerProvider;
        if (property === "unregisterProvider") return unregisterProvider;
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        const existing = methods.get(property);
        if (existing !== undefined) return existing;
        const bound = (...args: unknown[]) => Reflect.apply(value, target, args);
        methods.set(property, bound);
        return bound;
      },
    });
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
    const directTarget = selectedSession === undefined
      ? undefined
      : {
          threadId: selectedSession.threadId,
          ...(selectedSession.branch === undefined ? {} : { branch: selectedSession.branch }),
          signal,
        };
    const direct = this.#directContextHandler?.(directTarget, signal) ?? unavailableDirectContext();
    const modelRegistry = this.#directModelRegistry(owned, direct.modelRegistry);
    return Object.freeze({
      cwd: this.#workspace,
      signal,
      mode: this.#mode,
      hasUI,
      isProjectTrusted: () => this.#projectTrusted,
      ui: this.#directUiContext(owned, signal, ui),
      sessionManager: direct.sessionManager,
      modelRegistry,
      model: direct.model === undefined ? undefined : modelRegistry.present(direct.model),
      isIdle: direct.isIdle,
      hasPendingMessages: direct.hasPendingMessages,
      abort: direct.abort,
      shutdown: direct.shutdown,
      getContextUsage: direct.getContextUsage,
      compact: direct.compact,
      getSystemPrompt: direct.getSystemPrompt,
    });
  }

  #runtimeToolContext(
    entry: ExtensionRuntimeEntry,
    generation: RuntimeExtensionGeneration,
    context: ToolExecutionContext,
  ): RuntimeToolContext {
    this.#assertLive(entry, generation);
    const signal = combinedGenerationSignal(generation, context.signal, "Runtime tool");
    const listener = this.#listenerContext({ entry, generation }, signal);
    return Object.freeze({
      ...context,
      ...listener,
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
    const lifecycleSignal = event === "session_start" || event === "session_end" || event === "session_shutdown"
      ? AbortSignal.timeout(this.#shutdownTimeoutMs)
      : undefined;
    const dispatchSignal = lifecycleSignal === undefined
      ? signal
      : signal === undefined
        ? lifecycleSignal
        : AbortSignal.any([signal, lifecycleSignal]);
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
          ? observedEventForListener(snapshot as RuntimeObservedEvent)
          : snapshot;
        const eventValues = event === "event"
          ? [cloneBounded(listenerSnapshot, `Runtime ${event} listener event`)]
          : directDispatchEvents(event, cloneBounded(listenerSnapshot, `Runtime ${event} listener event`));
        for (const eventValue of eventValues) {
          const listenerEvent = freezeRuntimeRunEvent(
            event,
            event === "event" ? eventValue : { ...directEventRecord(eventValue), type: event },
          );
          const context = this.#listenerContext(owned, listenerSignal, runtimeRequesterSession(event, listenerEvent));
          await this.#withLifecycleListener(owned, async () => await this.#withRequesterThread(
            event,
            listenerEvent,
            async () => await withAbort(Promise.resolve(owned.listener(
              listenerEvent as RuntimeExtensionListenerEvent<RuntimeExtensionEvent>,
              context,
            )), listenerSignal),
          ));
        }
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

  /** Dispatches an already public-shaped event through the active direct listeners. */
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
              freezeRuntimeRunEvent(event, { ...value, type: event }) as RuntimeExtensionListenerEvent<K>,
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
      const listenerEvent = cloneBounded(current.event, "Runtime input event");
      const result = await (listener as (value: unknown) => Promise<unknown>)({
        ...listenerEvent,
        ...(listenerEvent.images === undefined ? {} : { images: extensionContent(listenerEvent.images) }),
      });
      const selected = directEventRecord(result);
      if (selected === undefined || selected.action === "continue") return { value: current };
      if (selected.action === "handled") return { value: { ...current, handled: true }, stop: true };
      if (selected.action !== "transform" || typeof selected.text !== "string") {
        throw new Error("Runtime input listener returned an invalid result");
      }
      bounded(selected.text, "Runtime transformed input", 1024 * 1024);
      if (
        selected.images !== undefined && !Array.isArray(selected.images)
      ) throw new Error("Runtime input listener returned invalid transformed images");
      const images = selected.images === undefined
        ? undefined
        : canonicalInputContent(selected.images as import("@rigyn/models").ImageContent[]);
      if (
        typeof images === "string" ||
        (images !== undefined && !images.every((image): image is ImageBlock => image.type === "image"))
      ) {
        throw new Error("Runtime input listener returned invalid transformed images");
      }
      const nextImages: ImageBlock[] | undefined = images;
      const resolvedImages = selected.images === undefined ? current.event.images : nextImages;
      const next: RuntimeInputEvent = {
        threadId: current.event.threadId,
        ...(current.event.branch === undefined ? {} : { branch: current.event.branch }),
        text: selected.text,
        source: current.event.source,
        ...(current.event.streamingBehavior === undefined ? {} : { streamingBehavior: current.event.streamingBehavior }),
        ...(resolvedImages === undefined ? {} : { images: cloneBounded(resolvedImages, "Runtime transformed input images") }),
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
    for (const owned of this.#listeners.get("user_bash") ?? []) {
      const listenerSignal = signal === undefined
        ? owned.generation.abortController.signal
        : AbortSignal.any([signal, owned.generation.abortController.signal]);
      try {
        this.#assertLive(owned.entry, owned.generation);
        listenerSignal.throwIfAborted();
        const listener = owned.listener as RuntimeExtensionListener<"user_bash">;
        const result = await this.#withLifecycleListener(owned, async () => await withAbort(Promise.resolve(listener(
          Object.freeze({ type: "user_bash", command, cwd, excludeFromContext: hidden }),
          this.#listenerContext(owned, listenerSignal),
        )), listenerSignal));
        if (result === undefined) continue;
        if (result.operations !== undefined && typeof result.operations.exec !== "function") {
          throw new Error("Runtime user_bash operations must define exec");
        }
        if (result.result !== undefined) {
          if (typeof result.result.output !== "string" || typeof result.result.cancelled !== "boolean"
            || typeof result.result.truncated !== "boolean"
            || (result.result.exitCode !== undefined && !Number.isInteger(result.result.exitCode))) {
            throw new Error("Runtime user_bash result is invalid");
          }
          return {
            action: "handled",
            command,
            cwd,
            result: {
              text: result.result.output,
              exitCode: result.result.exitCode ?? null,
              ...(result.result.cancelled ? { signal: "CANCELLED" } : {}),
            },
          };
        }
        if (result.operations !== undefined) return { action: "execute", command, cwd, operations: result.operations };
      } catch (cause) {
        if (signal?.aborted === true) throw abortError(signal);
        this.#recordListenerFailure(owned, cause);
      }
    }
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
      threadId: initial.threadId ?? "active",
      runId: initial.runId ?? "active",
      branch: initial.branch ?? "active",
      ...(initial.step === undefined ? {} : { step: initial.step }),
      prompt: initial.prompt,
      systemPrompt,
      ...(initial.images === undefined ? {} : { images: cloneBounded(initial.images, "Runtime native prompt images") }),
    });
    const reduced = await this.#reduce("before_agent_start", {
      messages: [] as CustomMessage[],
      systemPrompt: initial.systemPrompt,
    }, async (current, listener) => {
      const currentSnapshot = snapshot(current.systemPrompt);
      const result = await this.#currentSystemPrompt.run(
        currentSnapshot,
        async () => await (listener as (value: unknown) => Promise<unknown>)({
          prompt: initial.prompt,
          ...(initial.images === undefined ? {} : { images: extensionContent(initial.images) }),
          systemPrompt: current.systemPrompt,
          systemPromptOptions: initial.systemPromptOptions,
        }),
      );
      const selected = directEventRecord(result);
      if (selected === undefined) return { value: current };
      const message = directEventRecord(selected.message);
      const customType = message?.customType;
      if (message !== undefined && typeof customType !== "string") {
        throw new TypeError("Runtime injected message type must be a string");
      }
      const messages = message === undefined
        ? current.messages
        : [...current.messages, {
            role: "custom" as const,
            customType: bounded(customType as string, "Runtime injected message type", 1_024),
            content: canonicalInputContent(message.content as import("@rigyn/kernel").CustomMessage["content"]),
            display: message.display === true,
            ...(message.details === undefined ? {} : { details: cloneBounded(message.details, "Runtime injected message details") }),
            timestamp: Date.now(),
          }];
      const systemPrompt = selected.systemPrompt === undefined ? current.systemPrompt : selected.systemPrompt;
      if (typeof systemPrompt !== "string") throw new TypeError("Runtime system prompt must be a string");
      bounded(systemPrompt, "Runtime system prompt", 4 * 1024 * 1024);
      return { value: { messages, systemPrompt } };
    }, signal === undefined ? {} : { signal });
    if (initial.threadId !== undefined && initial.branch !== undefined) {
      this.#systemPrompts.set(`${initial.threadId}\0${initial.branch}`, snapshot(reduced.systemPrompt));
    }
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

  /** Applies trusted direct-factory hooks to one provider-native JSON payload. */
  async applyBeforeProviderRequestPayload(
    payload: JsonValue,
    requester?: RuntimeRequesterSession,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    let current = cloneBounded(payload, "Direct provider request payload");
    for (const owned of this.#listeners.get("before_provider_request") ?? []) {
      const listenerSignal = signal === undefined
        ? owned.generation.abortController.signal
        : AbortSignal.any([signal, owned.generation.abortController.signal]);
      try {
        this.#assertLive(owned.entry, owned.generation);
        listenerSignal.throwIfAborted();
        const listener = owned.listener as RuntimeExtensionListener<"before_provider_request">;
        const exposed = cloneBounded(current, "Direct provider request payload");
        const event = Object.freeze({ type: "before_provider_request", payload: exposed });
        const context = this.#listenerContext(owned, listenerSignal, requester);
        const invoke = async () => await withAbort(Promise.resolve(listener(event as never, context)), listenerSignal);
        const result = await this.#withLifecycleListener(owned, async () => requester === undefined
          ? await invoke()
          : await this.#requesterThread.run(requester, invoke));
        const selected = result === undefined ? exposed : result;
        if (!isJsonValue(selected)) throw new Error("Direct provider request replacement must be JSON-safe");
        current = cloneBounded(selected, "Direct provider request replacement");
      } catch (cause) {
        if (signal?.aborted === true) throw abortError(signal);
        this.#recordListenerFailure(owned, cause);
      }
    }
    signal?.throwIfAborted();
    return current;
  }

  /** Runs trusted header hooks against the exact mutable header object in load order. */
  async applyBeforeProviderHeaders(
    headers: Record<string, string | null>,
    signal?: AbortSignal,
    requester?: RuntimeRequesterSession,
  ): Promise<Record<string, string | null>> {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
      throw new Error("Provider headers must be an object");
    }
    for (const owned of this.#listeners.get("before_provider_headers") ?? []) {
      const listenerSignal = signal === undefined
        ? owned.generation.abortController.signal
        : AbortSignal.any([signal, owned.generation.abortController.signal]);
      try {
        this.#assertLive(owned.entry, owned.generation);
        listenerSignal.throwIfAborted();
        const listener = owned.listener as RuntimeExtensionListener<"before_provider_headers">;
        const invoke = async () => await withAbort(Promise.resolve(listener(
          Object.freeze({ type: "before_provider_headers", headers }),
          this.#listenerContext(owned, listenerSignal, requester),
        )), listenerSignal);
        await this.#withLifecycleListener(owned, async () => requester === undefined
          ? await invoke()
          : await this.#requesterThread.run(requester, invoke));
      } catch (cause) {
        if (signal?.aborted === true) throw abortError(signal);
        this.#recordListenerFailure(owned, cause);
      }
    }
    signal?.throwIfAborted();
    return headers;
  }

  /** Delivers one trusted direct response observation without allowing observers to fail the provider call. */
  async observeAfterProviderResponse(
    status: number,
    headers: Readonly<Record<string, string>>,
    requester?: RuntimeRequesterSession,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    if (!Number.isSafeInteger(status) || status < 100 || status > 999) {
      throw new Error("Provider response status is invalid");
    }
    const snapshot = Object.freeze({
      type: "after_provider_response" as const,
      status,
      headers: Object.freeze({ ...headers }),
    });
    for (const owned of this.#listeners.get("after_provider_response") ?? []) {
      const listenerSignal = signal === undefined
        ? owned.generation.abortController.signal
        : AbortSignal.any([signal, owned.generation.abortController.signal]);
      try {
        this.#assertLive(owned.entry, owned.generation);
        listenerSignal.throwIfAborted();
        const listener = owned.listener as RuntimeExtensionListener<"after_provider_response">;
        const invoke = async () => await withAbort(Promise.resolve(listener(
          snapshot as never,
          this.#listenerContext(owned, listenerSignal, requester),
        )), listenerSignal);
        await this.#withLifecycleListener(owned, async () => requester === undefined
          ? await invoke()
          : await this.#requesterThread.run(requester, invoke));
      } catch (cause) {
        if (signal?.aborted === true) throw abortError(signal);
        this.#recordListenerFailure(owned, cause);
      }
    }
    signal?.throwIfAborted();
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
      const result = await (listener as (value: unknown) => Promise<unknown>)({
        ...identity,
        messages: extensionCanonicalMessages(current),
      });
      const selected = directEventRecord(result);
      if (selected?.messages === undefined) return { value: current };
      if (!Array.isArray(selected.messages)) throw new TypeError("Runtime context messages must be an array");
      return { value: canonicalAgentMessages(selected.messages as import("@rigyn/kernel").AgentMessage[], current) };
    }, signal === undefined ? {} : { signal });
  }

  async reduceMessageEnd(event: RuntimeMessageEvent, signal?: AbortSignal): Promise<CanonicalMessage> {
    return (await this.reduceFinalizedMessageEnd(event, signal)).message;
  }

  async reduceFinalizedMessageEnd(event: RuntimeMessageEvent, signal?: AbortSignal): Promise<RuntimeMessageEndReduction> {
    const initial = cloneBounded(event, "Runtime message event");
    const initialMessage = canonicalMessages([initial.message], "Runtime message")[0]!;
    const initialFinalized = initial.finalized === undefined
      ? undefined
      : runtimeFinalizedResponse(initial.finalized, "Runtime finalized assistant response");
    return await this.#reduce("message_end", {
      message: initialMessage,
      ...(initialFinalized === undefined ? {} : { finalized: initialFinalized }),
    } as RuntimeMessageEndReduction, async (current, listener, entry) => {
      const result = await (listener as (value: unknown) => Promise<unknown>)({ message: extensionMessage(current.message) });
      if (result === undefined) return { value: current };
      const selected = runtimeSessionRecord(result, ["message"], "Runtime message_end result");
      let replacement = current.message;
      if (selected.message !== undefined) {
        const converted = canonicalMessage(
          selected.message as import("@rigyn/kernel").AgentMessage,
          current.message,
        );
        if (converted.role === "bashExecution" || converted.role === "custom") {
          throw new TypeError("Runtime message replacement must remain a model conversation message");
        }
        replacement = canonicalMessages([converted], "Runtime message replacement")[0]!;
        if (replacement.role !== current.message.role) throw new Error("Runtime message replacement cannot change the message role");
      }
      const fields: AssistantResponseTransformationField[] = [];
      if (!isDeepStrictEqual(replacement, current.message)) fields.push("message");
      const transformations = fields.length === 0
        ? current.transformations
        : [...(current.transformations ?? []), { actor: entry.extensionId, fields }];
      return {
        value: {
          message: replacement,
          ...(current.finalized === undefined ? {} : { finalized: current.finalized }),
          ...(transformations === undefined ? {} : { transformations }),
        },
      };
    }, signal === undefined ? {} : { signal });
  }

  async reduceToolCall(event: RuntimeToolCallEvent, signal?: AbortSignal): Promise<RuntimeToolCallReduction> {
    if (this.#closed) throw new Error("Runtime extension host is closed");
    let invocation = cloneBounded(event, "Runtime tool call");
    let transformations: ToolInputTransformationAudit[] | undefined;
    for (const owned of this.#listeners.get("tool_call") ?? []) {
      const listenerSignal = signal === undefined
        ? owned.generation.abortController.signal
        : AbortSignal.any([signal, owned.generation.abortController.signal]);
      this.#assertLive(owned.entry, owned.generation);
      listenerSignal.throwIfAborted();
      if (invocation.input === null || typeof invocation.input !== "object" || Array.isArray(invocation.input)) {
        throw new Error("Runtime tool call input must be an object");
      }
      const before = cloneBounded(invocation.input, "Runtime tool call input");
      const directEvent = {
        type: "tool_call",
        toolCallId: invocation.callId,
        toolName: invocation.name,
        input: invocation.input as Record<string, unknown>,
      };
      const context = this.#listenerContext(owned, listenerSignal, {
        threadId: invocation.threadId,
        branch: invocation.branch,
        runId: invocation.runId,
        ...(invocation.step === undefined ? {} : { step: invocation.step }),
      });
      const result = await this.#withLifecycleListener(owned, async () => await withAbort(
        Promise.resolve(owned.listener(directEvent as never, context)),
        listenerSignal,
      ));
      if (!isJsonValue(directEvent.input)) throw new Error("Runtime tool call input is not JSON-safe");
      if (!isDeepStrictEqual(before, directEvent.input)) {
        transformations = [...(transformations ?? []), { actor: owned.entry.extensionId }];
        invocation = { ...invocation, input: cloneBounded(directEvent.input, "Runtime transformed tool input") };
      }
      if (result === undefined) continue;
      const selected = runtimeSessionRecord(result, ["block", "reason"], "Runtime tool_call result");
      if (selected.block !== undefined && typeof selected.block !== "boolean") {
        throw new Error("Runtime tool_call block must be boolean");
      }
      if (selected.reason !== undefined && typeof selected.reason !== "string") {
        throw new Error("Runtime tool_call reason must be a string");
      }
      if (selected.block === true) {
        const reason = selected.reason === undefined
          ? undefined
          : bounded(selected.reason, "Runtime tool block reason", 16 * 1024);
        return {
          invocation,
          blocked: true,
          ...(transformations === undefined ? {} : { transformations }),
          ...(reason === undefined ? {} : { reason }),
        };
      }
    }
    return {
      invocation,
      blocked: false,
      ...(transformations === undefined ? {} : { transformations }),
    };
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
      const content = extensionContent(current.result.contentBlocks ?? [
        ...(current.result.content === "" ? [] : [{ type: "text" as const, text: current.result.content }]),
        ...(current.result.images ?? []),
      ]);
      const patch = await (listener as (value: unknown) => Promise<unknown>)({
        toolCallId: current.invocation.callId,
        toolName: current.invocation.name,
        input: current.invocation.input as Record<string, unknown>,
        content,
        details: current.result.metadata,
        isError: current.result.isError,
        ...(current.result.usage === undefined ? {} : { usage: extensionUsage(current.result.usage) }),
      });
      if (patch === undefined) return { value: current };
      const selected = runtimeSessionRecord(patch, ["content", "details", "isError", "usage"], "Runtime tool_result result");
      let nextContent = current.result.content;
      let nextContentBlocks = current.result.contentBlocks;
      let nextImages = current.result.images;
      if (selected.content !== undefined) {
        if (!Array.isArray(selected.content) || selected.content.some((block) => (
          block === null || typeof block !== "object" || Array.isArray(block) ||
          ((block as { type?: unknown }).type !== "text" && (block as { type?: unknown }).type !== "image")
        ))) throw new Error("Runtime tool result content must contain only text and image blocks");
        const blocks = canonicalContent(selected.content as import("@rigyn/kernel").AgentToolResult["content"]);
        nextContentBlocks = blocks;
        nextContent = blocks.filter((block): block is import("../core/types.js").TextBlock => block.type === "text")
          .map((block) => block.text).join("");
        const images = blocks.filter((block): block is ImageBlock => block.type === "image");
        nextImages = images.length === 0 ? undefined : images;
      }
      if (selected.details !== undefined && !isJsonValue(selected.details)) {
        throw new Error("Runtime tool result details must be JSON-safe");
      }
      if (selected.isError !== undefined && typeof selected.isError !== "boolean") {
        throw new Error("Runtime tool result isError must be boolean");
      }
      const nextUsage = selected.usage === undefined
        ? current.result.usage
        : canonicalUsage(selected.usage as import("@rigyn/kernel").Usage);
      const { contentBlocks: _contentBlocks, images: _images, usage: _usage, ...base } = current.result;
      const result: ToolResult = validateResult({
        ...base,
        content: nextContent,
        ...(nextContentBlocks === undefined ? {} : { contentBlocks: cloneBounded(nextContentBlocks, "Runtime tool content") }),
        ...(selected.isError === undefined ? {} : { isError: selected.isError }),
        ...(nextUsage === undefined ? {} : { usage: structuredClone(nextUsage) }),
        ...(selected.details === undefined ? {} : { metadata: selected.details }),
        ...(nextImages === undefined ? {} : { images: cloneBounded(nextImages, "Runtime tool images") }),
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
    const listenerEvent = {
      preparation: {
        ...structuredClone(event.preparation),
        entriesToSummarize: extensionSessionEntries(event.preparation.entriesToSummarize),
      },
      signal: event.signal,
    };
    return await this.#reduce("session_before_tree", {} as RuntimeTreeResult, async (current, listener) => {
      const result = await listener(listenerEvent as never);
      if (result === undefined) return { value: current };
      if (result === null || typeof result !== "object" || Array.isArray(result)) {
        throw new Error("Runtime tree result must be an object");
      }
      if (result.cancel !== undefined && typeof result.cancel !== "boolean") {
        throw new Error("Runtime tree cancellation must be a boolean");
      }
      if (result.summary !== undefined) {
        if (result.summary === null || typeof result.summary !== "object" || Array.isArray(result.summary)) {
          throw new Error("Runtime tree summary must be an object");
        }
        if (typeof result.summary.summary !== "string" || result.summary.summary.trim() === "") {
          throw new Error("Runtime tree summary must be a non-empty string");
        }
        bounded(result.summary.summary, "Runtime tree summary", MAX_RUNTIME_TREE_SUMMARY_BYTES);
        if (result.summary.details !== undefined && !isJsonValue(result.summary.details)) {
          throw new Error("Runtime tree summary metadata is not JSON-safe");
        }
        if (
          result.summary.details !== undefined &&
          Buffer.byteLength(JSON.stringify(result.summary.details), "utf8") > MAX_RUNTIME_TREE_METADATA_BYTES
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
      const value: RuntimeTreeResult = cloneBounded({
        ...result,
        ...(result.summary === undefined ? {} : {
          summary: {
            ...result.summary,
            ...(result.summary.usage === undefined
              ? {}
              : { usage: canonicalUsage(result.summary.usage as import("@rigyn/kernel").Usage) }),
          },
        }),
      }, "Runtime tree result");
      return { value, stop: value.cancel === true };
    }, signal === undefined ? {} : { signal });
  }

  async reduceSessionBeforeCompact(event: RuntimeSessionBeforeCompactEvent): Promise<RuntimeSessionBeforeCompactResult> {
    const listenerEvent = {
      preparation: {
        ...structuredClone(event.preparation),
        messagesToSummarize: extensionCanonicalMessages(event.preparation.messagesToSummarize),
        turnPrefixMessages: extensionCanonicalMessages(event.preparation.turnPrefixMessages),
      },
      branchEntries: extensionSessionEntries(event.branchEntries),
      ...(event.customInstructions === undefined ? {} : { customInstructions: event.customInstructions }),
      reason: event.reason,
      willRetry: event.willRetry,
      signal: event.signal,
    };
    return await this.#reduce("session_before_compact", {} as RuntimeSessionBeforeCompactResult, async (current, listener) => {
      const result = await listener(listenerEvent as never);
      if (result === undefined) return { value: current };
      if (result.cancel !== undefined && typeof result.cancel !== "boolean") {
        throw new Error("Runtime compaction cancellation must be a boolean");
      }
      if (result.compaction !== undefined) {
        bounded(result.compaction.summary, "Runtime compaction summary", 4 * 1024 * 1024);
        bounded(result.compaction.firstKeptEntryId, "Runtime compaction first kept entry", 1_024);
        if (!Number.isSafeInteger(result.compaction.tokensBefore) || result.compaction.tokensBefore < 0) {
          throw new Error("Runtime compaction tokensBefore must be a non-negative safe integer");
        }
        if (
          result.compaction.estimatedTokensAfter !== undefined &&
          (!Number.isSafeInteger(result.compaction.estimatedTokensAfter) || result.compaction.estimatedTokensAfter < 0)
        ) throw new Error("Runtime compaction estimatedTokensAfter must be a non-negative safe integer");
        if (result.compaction.details !== undefined && !isJsonValue(result.compaction.details)) {
          throw new Error("Runtime compaction metadata is not JSON-safe");
        }
      }
      const value: RuntimeSessionBeforeCompactResult = cloneBounded({
        ...result,
        ...(result.compaction === undefined ? {} : {
          compaction: {
            ...result.compaction,
            ...(result.compaction.usage === undefined
              ? {}
              : { usage: canonicalUsage(result.compaction.usage as import("@rigyn/kernel").Usage) }),
          },
        }),
      }, "Runtime compaction result");
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
    staged.generation.committedShortcuts.push(...shortcuts);
    staged.generation.committedFlags.push(...flags);
    const messageRenderers = lastRegistrations(staged.messageRenderers, (entry) => entry.customType);
    const entryRenderers = lastRegistrations(staged.entryRenderers, (entry) => entry.customType);
    const toolRendererNames = new Set(staged.toolRenderers.map((entry) => entry.name));
    const sharedListenerCount = [...this.#sharedListeners.values()].reduce((count, listeners) => count + listeners.length, 0);
    if (sharedListenerCount + staged.sharedListeners.length > MAX_RUNTIME_SHARED_EVENT_LISTENERS) {
      throw new Error(`Runtime shared event listeners exceed ${MAX_RUNTIME_SHARED_EVENT_LISTENERS}`);
    }
    const toolCallListenerCount = staged.listeners.filter((listener) => listener.event === "tool_call").length;
    if ((this.#listeners.get("tool_call")?.length ?? 0) + toolCallListenerCount > MAX_TOOL_TRANSFORMATION_AUDIT_ENTRIES) {
      throw new Error(`Runtime tool_call listeners exceed ${MAX_TOOL_TRANSFORMATION_AUDIT_ENTRIES}`);
    }
    if (toolRendererNames.size !== staged.toolRenderers.length || staged.toolRenderers.some((entry) => this.#toolRenderers.has(entry.name))) throw new Error("Runtime extension registered a duplicate tool renderer");
    // Extension tools use first-owner wins across packages. Re-registering within
    // one activation keeps the last definition, matching ordinary map semantics.
    for (const tool of tools) {
      const runtimeTool = new RuntimeHarnessTool(
        tool,
        (context) => this.#runtimeToolContext(staged.entry, staged.generation, context),
        async (context, execute) => await this.#requesterThread.run({ threadId: context.threadId }, execute),
        () => this.#directActionsHandler?.getActiveTools(),
      );
      staged.generation.committedTools.push({ registration: tool, tool: runtimeTool });
      this.#toolOwners.set(runtimeTool, {
        kind: "extension",
        extensionId: staged.entry.extensionId,
        sourcePath: staged.entry.sourcePath,
      });
      const prior = this.#tools.get(tool.name);
      if (prior === undefined) {
        this.#tools.set(tool.name, runtimeTool);
      } else this.#diagnoseCrossExtensionToolCollision(staged.entry, tool.name, prior);
    }
    for (const command of commands) {
      this.#commands.push({
        entry: staged.entry,
        generation: staged.generation,
        registration: command,
      });
      if (isBuiltinSlashCommand(command.name)) {
        const occurrence = this.#commands.filter((owned) => owned.registration.name === command.name).length;
        this.addDiagnostic({
          extensionId: staged.entry.extensionId,
          sourcePath: staged.entry.sourcePath,
          message: `Runtime extension command ${command.name} conflicts with a built-in command and is available as ${command.name}:${occurrence}`,
        });
      }
    }
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
    for (const registration of staged.directProviders) this.#directProviders.push({
      entry: staged.entry,
      generation: staged.generation,
      registration,
    });
    for (const entry of staged.toolRenderers) this.#toolRenderers.set(entry.name, {
      entry: staged.entry,
      generation: staged.generation,
      renderer: entry.renderer,
    });
    for (const entry of messageRenderers) this.#messageRenderers.push({
      entry: staged.entry,
      generation: staged.generation,
      customType: entry.customType,
      renderer: entry.renderer,
    });
    for (const entry of entryRenderers) this.#entryRenderers.push({
      entry: staged.entry,
      generation: staged.generation,
      customType: entry.customType,
      renderer: entry.renderer,
    });
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
    // Each category gets one fresh phase budget. This keeps a hung disposer
    // from starving live-registration cleanup, or a hung live-registration
    // cleanup from preventing module-loader cleanup. The asynchronous upper
    // bound is three sequential shutdownTimeoutMs phases, independent of
    // callback count.
    this.#closed = true;
    this.#lifecycle.abort(new Error("Runtime extension host closed"));
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
      this.#registrationCleanups.splice(0).reverse(),
      this.#shutdownTimeoutMs,
      "Runtime live registration cleanup",
    ));
    const moduleDisposers = this.#moduleDisposers.splice(0).reverse();
    failures.push(...await runRuntimeCleanupPhase(
      moduleDisposers,
      this.#shutdownTimeoutMs,
      "Runtime module loader cleanup",
    ));
    this.#tools.clear();
    this.#commands.length = 0;
    this.#shortcuts.clear();
    this.#flags.clear();
    this.#flagValues.clear();
    this.#directProviders.length = 0;
    this.#toolRenderers.clear();
    this.#messageRenderers.length = 0;
    this.#entryRenderers.length = 0;
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
    this.#nativeUiHandler = undefined;
    this.#unsafeTerminalHandler = undefined;
    this.#uiHandler = undefined;
    this.#advancedUiHandler = undefined;
    this.#interactiveUiHandler = undefined;
    this.#directContextHandler = undefined;
    this.#directActionsHandler = undefined;
    this.#directUiHandler = undefined;
    this.#directDiscoveryHandler = undefined;
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Runtime extension disposers failed");
  }
}

/** Connects direct provider events to the transport lifecycle for one runtime generation. */
export function bindDirectProviderWireLifecycle(
  host: RuntimeExtensionHost,
  wire: ProviderWireLifecycleHost,
): () => void {
  const requester = (scope: ProviderWireLifecycleScope): RuntimeRequesterSession => ({
    threadId: scope.threadId,
    runId: scope.runId,
    ...(scope.branch === undefined ? {} : { branch: scope.branch }),
    step: scope.step,
  });
  return wire.registerLifecycle({
    async beforeHeaders(request, signal) {
      if (!host.hasListeners("before_provider_headers")) return;
      const headers: Record<string, string | null> = { ...request.headers };
      await host.applyBeforeProviderHeaders(headers, signal, requester(request));
      return { headers };
    },
    async beforeRequest(request, signal) {
      if (!host.hasListeners("before_provider_request")) return;
      return {
        body: await host.applyBeforeProviderRequestPayload(request.body, requester(request), signal),
      };
    },
    async afterResponse(response, signal) {
      if (!host.hasListeners("after_provider_response")) return;
      await host.observeAfterProviderResponse(
        response.status,
        response.headers,
        requester(response),
        signal,
      );
    },
  });
}

export interface RuntimeExtensionLoadOptions {
  workspace: string;
  dataRoot?: string;
  /** Optional shared compatibility bus used by direct-factory `events` registrations. */
  eventBus?: CoreEventBus;
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
  /** Core action/context bindings are installed before any factory runs. */
  directActionsHandler?: RuntimeDirectActionsHandler;
  directContextHandler?: RuntimeDirectContextHandler;
  directUiHandler?: RuntimeDirectUiHandler;
  /** Trusted in-process factories loaded after path-based modules. */
  inlineExtensions?: readonly RuntimeInlineExtension[];
  /** Host-owned provenance for direct paths discovered by the resource loader. */
  directPathMetadata?: ReadonlyMap<string, RuntimeDirectPathMetadata>;
}

export interface RuntimeDirectPathMetadata {
  scope: "user" | "project" | "temporary";
  trusted: boolean;
  resourceRoot?: string;
  /** Optional package/test identity. Ordinary invocation paths use a path-derived ID. */
  extensionId?: string;
  /** Optional resolver snapshot used to detect a source change before activation. */
  expectedSha256?: string;
  /** Command registrations suppressed by a trusted package declaration. */
  disabledCommands?: readonly string[];
  /** Dynamically discovered resources suppressed by a trusted package declaration. */
  disabledResources?: Readonly<Partial<Record<"skill" | "prompt" | "theme", readonly string[]>>>;
}

export type RuntimeInlineExtension =
  | ((rigyn: ExtensionAPI) => void | Promise<void>)
  | {
      name: string;
      factory(rigyn: ExtensionAPI): void | Promise<void>;
      hidden?: boolean;
    };

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
  options.signal?.throwIfAborted();
  const workspace = await realpath(resolve(options.workspace));
  if (host.workspace !== workspace) throw new Error("Runtime extension host belongs to a different workspace");
  const existing = new Set(host.extensions().map((entry) => entry.sourcePath));
  const duplicate = entries.find((entry) => existing.has(entry.sourcePath));
  if (duplicate !== undefined) throw new Error(`Runtime extension is already active: ${duplicate.sourcePath}`);
  const dataRoot = resolve(options.dataRoot ?? host.dataRoot);
  const loadTimeoutSignal = AbortSignal.timeout(loadTimeoutMs);
  const loadSignal = options.signal === undefined
    ? loadTimeoutSignal
    : AbortSignal.any([options.signal, loadTimeoutSignal]);
  for (const entry of entries) {
    options.signal?.throwIfAborted();
    let staged: StagedActivation | undefined;
    let activationTimeoutSignal: AbortSignal | undefined;
    try {
      loadSignal.throwIfAborted();
      if (entry.trusted === false) {
        throw new Error(`Runtime extension is not trusted and was not imported: ${entry.extensionId}`);
      }
      const bytes = await withAbort(readFile(entry.sourcePath), loadSignal);
      if (sha256(bytes) !== entry.sha256) throw new Error("Runtime entry changed after extension discovery");
      const dataPathPreparation = prepareExtensionDataPaths(
        extensionDataPaths(dataRoot, workspace, entry),
        loadSignal,
      );
      let dataPaths: RuntimeExtensionDataPaths;
      try {
        dataPaths = await withAbort(dataPathPreparation, loadSignal);
      } catch (cause) {
        // Filesystem directory preparation cannot be cancelled. Drain it so a
        // timed-out load cannot recreate extension state after the host returns.
        await dataPathPreparation.catch(() => undefined);
        throw cause;
      }
      const activationResult = activation(entry, workspace, dataPaths, host, options.eventBus);
      staged = activationResult.staged;
      const generationSignal = AbortSignal.any([staged.generation.abortController.signal, loadSignal]);
      const loader = createJiti(import.meta.url, {
        moduleCache: false,
        fsCache: false,
        alias: Object.fromEntries(RUNTIME_HOST_IMPORTS),
        virtualModules: RUNTIME_HOST_VIRTUAL_MODULES,
      });
      // Force source evaluation for every generation. Native ESM imports are
      // process-cached even when Jiti's CommonJS module cache is disabled,
      // which otherwise leaves edited .mjs extensions stale after /reload.
      const loaded = await withAbort(Promise.resolve(loader.evalModule(bytes.toString("utf8"), {
        filename: entry.sourcePath,
        ext: extname(entry.sourcePath),
        async: true,
        forceTranspile: true,
      })), generationSignal);
      const activate = loaded !== null && (typeof loaded === "object" || typeof loaded === "function")
        && "default" in loaded
        ? (loaded as { default: unknown }).default
        : loaded;
      if (typeof activate !== "function") throw new Error("Direct extension must export a default factory function");
      activationTimeoutSignal = AbortSignal.timeout(activationTimeoutMs);
      const activationSignal = AbortSignal.any([generationSignal, activationTimeoutSignal]);
      await withAbort(Promise.resolve(activate(activationResult.api)), activationSignal);
      const directMetadata = options.directPathMetadata?.get(entry.sourcePath);
      const disabledCommands = directMetadata?.disabledCommands;
      if (disabledCommands !== undefined && disabledCommands.length > 0) {
        host.suppressCommands(staged, disabledCommands);
      }
      if (directMetadata?.disabledResources !== undefined) {
        host.suppressResources(staged, directMetadata.disabledResources);
      }
      host.commit(activationResult.staged);
    } catch (cause) {
      const externalAbort = options.signal?.aborted === true ? abortError(options.signal) : undefined;
      const activationError = loadTimeoutSignal.aborted
        ? new Error(`Runtime extension load timed out after ${loadTimeoutMs}ms`)
        : activationTimeoutSignal?.aborted === true
          ? new Error(`Runtime extension activation timed out after ${activationTimeoutMs}ms`)
          : error(cause);
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
      if (externalAbort !== undefined) throw externalAbort;
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

async function activateInlineExtensions(
  host: RuntimeExtensionHost,
  inlineExtensions: readonly RuntimeInlineExtension[],
  options: RuntimeExtensionLoadOptions,
): Promise<void> {
  if (inlineExtensions.length > 128) throw new Error("At most 128 inline extensions may be loaded");
  options.signal?.throwIfAborted();
  const activationTimeoutMs = options.activationTimeoutMs ?? DEFAULT_RUNTIME_EXTENSION_ACTIVATION_TIMEOUT_MS;
  const loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_RUNTIME_EXTENSION_LOAD_TIMEOUT_MS;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_RUNTIME_EXTENSION_SHUTDOWN_TIMEOUT_MS;
  const activationFailure = options.activationFailure ?? "diagnostic";
  const loadTimeoutSignal = AbortSignal.timeout(loadTimeoutMs);
  const loadSignal = options.signal === undefined
    ? loadTimeoutSignal
    : AbortSignal.any([options.signal, loadTimeoutSignal]);
  for (const [index, selected] of inlineExtensions.entries()) {
    options.signal?.throwIfAborted();
    const factory = typeof selected === "function" ? selected : selected.factory;
    const label = typeof selected === "function" ? String(index + 1) : selected.name;
    if (typeof factory !== "function") throw new Error(`Inline extension ${index + 1} factory is invalid`);
    if (typeof label !== "string" || label.trim() === "" || label.includes("\0")) {
      throw new Error(`Inline extension ${index + 1} name is invalid`);
    }
    const slug = label.normalize("NFKD").toLowerCase().replace(/[^a-z0-9._-]+/gu, "-")
      .replace(/^[^a-z]+/u, "").replace(/-+$/u, "").slice(0, 80) || `extension-${index + 1}`;
    const entry: ExtensionRuntimeEntry = {
      extensionId: `inline-${slug}`,
      sourcePath: `<inline:${label}>`,
      sha256: sha256(label),
      resourceRoot: host.workspace,
      scope: "invocation",
      trusted: true,
    };
    let candidate: ReturnType<typeof activation> | undefined;
    let activationTimeoutSignal: AbortSignal | undefined;
    try {
      loadSignal.throwIfAborted();
      const dataPathPreparation = prepareExtensionDataPaths(
        extensionDataPaths(resolve(options.dataRoot ?? host.dataRoot), host.workspace, entry),
        loadSignal,
      );
      let dataPaths: RuntimeExtensionDataPaths;
      try {
        dataPaths = await withAbort(dataPathPreparation, loadSignal);
      } catch (cause) {
        // Filesystem directory preparation cannot be cancelled. Drain it so a
        // timed-out load cannot recreate extension state after the host returns.
        await dataPathPreparation.catch(() => undefined);
        throw cause;
      }
      candidate = activation(
        entry,
        host.workspace,
        dataPaths,
        host,
        options.eventBus,
        typeof selected === "function" ? undefined : selected.hidden,
      );
      activationTimeoutSignal = AbortSignal.timeout(activationTimeoutMs);
      const activationSignal = AbortSignal.any([
        candidate.staged.generation.abortController.signal,
        loadSignal,
        activationTimeoutSignal,
      ]);
      await withAbort(Promise.resolve(factory(candidate.api)), activationSignal);
      host.commit(candidate.staged);
    } catch (cause) {
      const externalAbort = options.signal?.aborted === true ? abortError(options.signal) : undefined;
      const activationError = externalAbort !== undefined
        ? error(externalAbort)
        : loadTimeoutSignal.aborted
          ? new Error(`Runtime extension load timed out after ${loadTimeoutMs}ms`)
          : activationTimeoutSignal?.aborted === true
            ? new Error(`Runtime extension activation timed out after ${activationTimeoutMs}ms`)
            : error(cause);
      let cleanupFailures: Error[] = [];
      if (candidate !== undefined) {
        candidate.staged.generation.active = false;
        candidate.staged.generation.abortController.abort(new Error("Inline extension activation failed"));
        host.rollbackNativeUi(candidate.staged.generation);
        host.rollbackUnsafeTerminal(candidate.staged.generation);
        cleanupFailures = [
          ...await runRuntimeCleanupPhase(
            candidate.staged.disposers.splice(0).reverse(),
            shutdownTimeoutMs,
            "Inline extension activation disposer cleanup",
          ),
          ...await runRuntimeCleanupPhase(
            candidate.staged.moduleDisposers.splice(0).reverse(),
            shutdownTimeoutMs,
            "Inline extension activation module cleanup",
          ),
        ];
      }
      if (activationFailure === "throw" || externalAbort !== undefined) {
        if (cleanupFailures.length > 0) {
          throw new AggregateError([activationError, ...cleanupFailures], "Inline extension activation and cleanup failed");
        }
        throw externalAbort ?? activationError;
      }
      host.addDiagnostic({ extensionId: entry.extensionId, sourcePath: entry.sourcePath, message: activationError.message });
      for (const cleanupFailure of cleanupFailures) {
        host.addDiagnostic({ extensionId: entry.extensionId, sourcePath: entry.sourcePath, message: cleanupFailure.message });
      }
      if (loadTimeoutSignal.aborted) break;
    }
  }
}

const DIRECT_EXTENSION_ENTRY_FILES = [
  "index.ts",
  "index.tsx",
  "index.js",
  "index.mjs",
  "index.cjs",
  "index.mts",
  "index.cts",
] as const;

const DIRECT_EXTENSION_FILE_SUFFIXES = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".cts"]);

async function directExtensionEntry(
  pathValue: string,
  index: number,
  metadata?: RuntimeDirectPathMetadata,
): Promise<ExtensionRuntimeEntry> {
  if (typeof pathValue !== "string" || pathValue.trim() === "" || pathValue.includes("\0")) {
    throw new TypeError(`Direct extension path ${index + 1} is invalid`);
  }
  let sourcePath = await realpath(resolve(pathValue));
  const information = await lstat(sourcePath);
  if (information.isDirectory()) {
    let selected: string | undefined;
    for (const name of DIRECT_EXTENSION_ENTRY_FILES) {
      const candidate = join(sourcePath, name);
      try {
        const candidateInfo = await lstat(candidate);
        if (candidateInfo.isFile()) {
          selected = await realpath(candidate);
          break;
        }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
    }
    if (selected === undefined) {
      throw new Error(`Direct extension directory has no supported index file: ${sourcePath}`);
    }
    sourcePath = selected;
  } else if (!information.isFile()) {
    throw new Error(`Direct extension path is not a regular file or directory: ${sourcePath}`);
  }
  if (!DIRECT_EXTENSION_FILE_SUFFIXES.has(extname(sourcePath).toLowerCase())) {
    throw new Error(`Direct extension entry has an unsupported file type: ${sourcePath}`);
  }
  const bytes = await readFile(sourcePath);
  const contentSha256 = sha256(bytes);
  if (metadata?.expectedSha256 !== undefined && metadata.expectedSha256 !== contentSha256) {
    throw new Error(`Direct extension changed after resolution: ${sourcePath}`);
  }
  const identity = sha256(sourcePath);
  const label = basename(sourcePath, extname(sourcePath)).replace(/[^A-Za-z0-9_.-]+/gu, "-").slice(0, 40) || "extension";
  const extensionId = metadata?.extensionId ?? `direct-${label}-${identity.slice(0, 16)}`;
  key(extensionId, "Extension ID");
  return {
    extensionId,
    sourcePath,
    sha256: contentSha256,
    resourceRoot: metadata?.resourceRoot ?? dirname(sourcePath),
    scope: metadata?.scope === "temporary" ? "invocation" : metadata?.scope ?? "invocation",
    trusted: metadata?.trusted ?? true,
  };
}

/** Loads trusted direct factory files without requiring a manifest. */
async function resolveDirectExtensionEntries(
  paths: readonly string[],
  options: RuntimeExtensionLoadOptions,
): Promise<{ entries: ExtensionRuntimeEntry[]; pathFailures: Array<{ path: string; error: Error }> }> {
  if (!Array.isArray(paths)) throw new TypeError("Direct extension paths must be an array");
  if (paths.length > 4_096) throw new RangeError("Direct extension paths exceed 4096 entries");
  options.signal?.throwIfAborted();
  const entries: ExtensionRuntimeEntry[] = [];
  const pathFailures: Array<{ path: string; error: Error }> = [];
  for (const [index, path] of paths.entries()) {
    options.signal?.throwIfAborted();
    try {
      const resolvedPath = resolve(path);
      entries.push(await directExtensionEntry(
        path,
        index,
        options.directPathMetadata?.get(path) ?? options.directPathMetadata?.get(resolvedPath),
      ));
    } catch (cause) {
      const failure = error(cause);
      if (options.activationFailure === "throw" || options.signal?.aborted === true) throw failure;
      pathFailures.push({ path, error: failure });
    }
  }
  const duplicate = entries.find((entry, index) => entries.some((candidate, candidateIndex) =>
    candidateIndex < index && candidate.sourcePath === entry.sourcePath));
  if (duplicate !== undefined) throw new Error(`Direct extension path is duplicated: ${duplicate.sourcePath}`);
  return { entries, pathFailures };
}

function addDirectPathDiagnostics(
  host: RuntimeExtensionHost,
  failures: readonly { path: string; error: Error }[],
): void {
  for (const failure of failures) {
    host.addDiagnostic({
      extensionId: "extension-loader",
      sourcePath: failure.path,
      message: failure.error.message,
    });
  }
}

/** Loads trusted direct factory files without requiring a manifest. */
export async function loadDirectExtensions(
  paths: readonly string[],
  options: RuntimeExtensionLoadOptions,
): Promise<RuntimeExtensionHost> {
  const { entries, pathFailures } = await resolveDirectExtensionEntries(paths, options);
  const host = await loadResolvedDirectExtensions(entries, options);
  addDirectPathDiagnostics(host, pathFailures);
  return host;
}

/** Adds direct factory files to an existing host without reactivating its current generation. */
export async function appendDirectExtensions(
  host: RuntimeExtensionHost,
  paths: readonly string[],
  options: RuntimeExtensionLoadOptions,
): Promise<void> {
  const { entries, pathFailures } = await resolveDirectExtensionEntries(paths, options);
  const active = new Set(host.extensions().map((entry) => entry.sourcePath));
  const duplicate = entries.find((entry) => active.has(entry.sourcePath));
  if (duplicate !== undefined) throw new Error(`Direct extension is already active: ${duplicate.sourcePath}`);
  await activateRuntimeExtensionEntries(host, entries, options);
  addDirectPathDiagnostics(host, pathFailures);
}

async function loadResolvedDirectExtensions(
  entries: readonly ExtensionRuntimeEntry[],
  options: RuntimeExtensionLoadOptions,
): Promise<RuntimeExtensionHost> {
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_RUNTIME_EXTENSION_SHUTDOWN_TIMEOUT_MS;
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1 || shutdownTimeoutMs > 300_000) {
    throw new RangeError("Runtime extension shutdownTimeoutMs must be from 1 through 300000");
  }
  options.signal?.throwIfAborted();
  const workspace = await realpath(resolve(options.workspace));
  const dataRoot = resolve(options.dataRoot ?? join(workspace, ".rigyn", "state", "extension-data"));
  const host = new RuntimeExtensionHost(workspace, {
    shutdownTimeoutMs,
    dataRoot,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.projectTrusted === undefined ? {} : { projectTrusted: options.projectTrusted }),
    ...(options.directActionsHandler === undefined ? {} : { directActionsHandler: options.directActionsHandler }),
    ...(options.directContextHandler === undefined ? {} : { directContextHandler: options.directContextHandler }),
    ...(options.directUiHandler === undefined ? {} : { directUiHandler: options.directUiHandler }),
    ...(options.resourceDiscoveryTimeoutMs === undefined
      ? {}
      : { resourceDiscoveryTimeoutMs: options.resourceDiscoveryTimeoutMs }),
  });
  try {
    await activateRuntimeExtensionEntries(host, entries, { ...options, workspace, dataRoot });
    await activateInlineExtensions(host, options.inlineExtensions ?? [], { ...options, workspace, dataRoot });
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
