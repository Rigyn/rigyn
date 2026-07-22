import type { ImageContent, Model, Models, RetryPolicy, SimpleStreamOptions, TextContent, Transport, Usage } from "@rigyn/models";
import type { AgentEvent, AgentMessage, AgentTool, QueueMode, ThinkingLevel } from "../types.js";
import type { Session } from "./session/session.js";

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
export const ok = <T, E = never>(value: T): Result<T, E> => ({ ok: true, value });
export const err = <T = never, E = Error>(error: E): Result<T, E> => ({ ok: false, error });
export function getOrThrow<T, E>(result: Result<T, E>): T { if (!result.ok) throw result.error; return result.value; }
export function getOrUndefined<T extends object, E>(result: Result<T, E>): T | undefined { return result.ok ? result.value : undefined; }
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  try { return new Error(JSON.stringify(value)); } catch { return new Error(String(value)); }
}

export interface Skill { name: string; description: string; content: string; filePath: string; disableModelInvocation?: boolean; }
export interface PromptTemplate { name: string; description?: string; content: string; }
export interface AgentHarnessResources<TSkill extends Skill = Skill, TPrompt extends PromptTemplate = PromptTemplate> {
  promptTemplates?: TPrompt[];
  skills?: TSkill[];
}

export interface AgentHarnessStreamOptions {
  transport?: Transport;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  headers?: Record<string, string>;
  metadata?: SimpleStreamOptions["metadata"];
  cacheRetention?: SimpleStreamOptions["cacheRetention"];
}

export interface AgentHarnessStreamOptionsPatch extends Omit<Partial<AgentHarnessStreamOptions>, "headers" | "metadata"> {
  headers?: Record<string, string | undefined>;
  metadata?: Record<string, unknown | undefined>;
}

export type FileKind = "file" | "directory" | "symlink";
export type FileErrorCode = "aborted" | "not_found" | "permission_denied" | "not_directory" | "is_directory" | "invalid" | "not_supported" | "unknown";
export class FileError extends Error {
  constructor(public code: FileErrorCode, message: string, public path?: string, cause?: Error) {
    super(message, cause ? { cause } : undefined); this.name = "FileError";
  }
}
export type ExecutionErrorCode = "aborted" | "timeout" | "shell_unavailable" | "spawn_error" | "callback_error" | "unknown";
export class ExecutionError extends Error {
  constructor(public code: ExecutionErrorCode, message: string, cause?: Error) {
    super(message, cause ? { cause } : undefined); this.name = "ExecutionError";
  }
}
export type CompactionErrorCode = "aborted" | "summarization_failed" | "invalid_session" | "unknown";
export class CompactionError extends Error {
  constructor(public code: CompactionErrorCode, message: string, cause?: Error) {
    super(message, cause ? { cause } : undefined); this.name = "CompactionError";
  }
}
export type BranchSummaryErrorCode = "aborted" | "summarization_failed" | "invalid_session";
export class BranchSummaryError extends Error {
  constructor(public code: BranchSummaryErrorCode, message: string, cause?: Error) {
    super(message, cause ? { cause } : undefined); this.name = "BranchSummaryError";
  }
}
export type SessionErrorCode = "not_found" | "invalid_session" | "invalid_entry" | "invalid_fork_target" | "storage" | "unknown";
export class SessionError extends Error {
  constructor(public code: SessionErrorCode, message: string, cause?: Error) {
    super(message, cause ? { cause } : undefined); this.name = "SessionError";
  }
}
export type AgentHarnessErrorCode = "busy" | "invalid_state" | "invalid_argument" | "session" | "hook" | "auth" | "compaction" | "branch_summary" | "unknown";
export class AgentHarnessError extends Error {
  constructor(public code: AgentHarnessErrorCode, message: string, cause?: Error) {
    super(message, cause ? { cause } : undefined); this.name = "AgentHarnessError";
  }
}

export interface FileInfo { name: string; path: string; kind: FileKind; size: number; mtimeMs: number; }
export interface FileSystem {
  cwd: string;
  absolutePath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
  joinPath(parts: string[], abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
  readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
  readTextLines(path: string, options?: { maxLines?: number; abortSignal?: AbortSignal }): Promise<Result<string[], FileError>>;
  readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>>;
  writeFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>>;
  appendFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>>;
  fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>>;
  listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>>;
  canonicalPath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
  exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>>;
  createDir(path: string, options?: { recursive?: boolean; abortSignal?: AbortSignal }): Promise<Result<void, FileError>>;
  remove(path: string, options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal }): Promise<Result<void, FileError>>;
  createTempDir(prefix?: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
  createTempFile(options?: { prefix?: string; suffix?: string; abortSignal?: AbortSignal }): Promise<Result<string, FileError>>;
  cleanup(): Promise<void>;
}
export interface ShellExecOptions {
  cwd?: string; env?: Record<string, string>; timeout?: number; abortSignal?: AbortSignal;
  onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void;
}
export interface Shell {
  exec(command: string, options?: ShellExecOptions): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>>;
  cleanup(): Promise<void>;
}
export interface ExecutionEnv extends FileSystem, Shell {}

export interface SessionTreeEntryBase { type: string; id: string; parentId: string | null; timestamp: string; }
export interface MessageEntry extends SessionTreeEntryBase { type: "message"; message: AgentMessage; }
export interface ThinkingLevelChangeEntry extends SessionTreeEntryBase { type: "thinking_level_change"; thinkingLevel: string; }
export interface ModelChangeEntry extends SessionTreeEntryBase { type: "model_change"; provider: string; modelId: string; }
export interface ActiveToolsChangeEntry extends SessionTreeEntryBase { type: "active_tools_change"; activeToolNames: string[]; }
export interface CompactionEntry<T = unknown> extends SessionTreeEntryBase { type: "compaction"; summary: string; firstKeptEntryId?: string; tokensBefore: number; retainedTail?: AgentMessage[]; details?: T; usage?: Usage; fromHook?: boolean; }
export interface BranchSummaryEntry<T = unknown> extends SessionTreeEntryBase { type: "branch_summary"; fromId: string; summary: string; details?: T; usage?: Usage; fromHook?: boolean; }
export interface CustomEntry<T = unknown> extends SessionTreeEntryBase { type: "custom"; customType: string; data?: T; }
export interface CustomMessageEntry<T = unknown> extends SessionTreeEntryBase { type: "custom_message"; customType: string; content: string | Array<TextContent | ImageContent>; details?: T; display: boolean; }
export interface LabelEntry extends SessionTreeEntryBase { type: "label"; targetId: string; label: string | undefined; }
export interface SessionInfoEntry extends SessionTreeEntryBase { type: "session_info"; name?: string; }
export interface LeafEntry extends SessionTreeEntryBase { type: "leaf"; targetId: string | null; }
export type SessionTreeEntry = MessageEntry | ThinkingLevelChangeEntry | ModelChangeEntry | ActiveToolsChangeEntry | CompactionEntry | BranchSummaryEntry | CustomEntry | CustomMessageEntry | LabelEntry | SessionInfoEntry | LeafEntry;

export interface SessionContext { messages: AgentMessage[]; thinkingLevel: string; model: { provider: string; modelId: string } | null; activeToolNames: string[] | null; }
export interface SessionMetadata { id: string; createdAt: string; }
export interface JsonlSessionMetadata extends SessionMetadata { cwd: string; path: string; parentSessionPath?: string; metadata?: Record<string, unknown>; }
export interface SessionStorage<TMetadata extends SessionMetadata = SessionMetadata> {
  getMetadata(): Promise<TMetadata>;
  getLeafId(): Promise<string | null>;
  setLeafId(leafId: string | null): Promise<void>;
  createEntryId(): Promise<string>;
  appendEntry(entry: SessionTreeEntry): Promise<void>;
  getEntry(id: string): Promise<SessionTreeEntry | undefined>;
  findEntries<T extends SessionTreeEntry["type"]>(type: T): Promise<Array<Extract<SessionTreeEntry, { type: T }>>>;
  getLabel(id: string): Promise<string | undefined>;
  getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]>;
  getPathToRootOrCompaction(leafId: string | null): Promise<SessionTreeEntry[]>;
  getEntries(): Promise<SessionTreeEntry[]>;
}
export type { Session } from "./session/session.js";
export interface SessionCreateOptions { id?: string; }
export interface SessionForkOptions { entryId?: string; position?: "before" | "at"; id?: string; }
export interface SessionRepo<TMetadata extends SessionMetadata = SessionMetadata, TCreate extends SessionCreateOptions = SessionCreateOptions, TList = void> {
  create(options: TCreate): Promise<Session<TMetadata>>;
  open(metadata: TMetadata): Promise<Session<TMetadata>>;
  list(options?: TList): Promise<TMetadata[]>;
  delete(metadata: TMetadata): Promise<void>;
  fork(source: TMetadata, options: SessionForkOptions & TCreate): Promise<Session<TMetadata>>;
}
export interface JsonlSessionCreateOptions extends SessionCreateOptions { cwd: string; parentSessionPath?: string; metadata?: Record<string, unknown>; }
export interface JsonlSessionListOptions { cwd?: string; }
export interface JsonlSessionRepoApi extends SessionRepo<JsonlSessionMetadata, JsonlSessionCreateOptions, JsonlSessionListOptions> {}

export type AgentHarnessPhase = "idle" | "turn" | "compaction" | "branch_summary" | "retry";
export type PendingSessionWrite = SessionTreeEntry extends infer E ? E extends SessionTreeEntry ? Omit<E, "id" | "parentId" | "timestamp"> : never : never;
export interface FileOperations { read: Set<string>; written: Set<string>; edited: Set<string>; }
export interface CompactionSettings { enabled: boolean; reserveTokens: number; keepRecentTokens: number; }
export interface CompactionPreparation { firstKeptEntryId: string; messagesToSummarize: AgentMessage[]; turnPrefixMessages: AgentMessage[]; retainedTail: AgentMessage[]; isSplitTurn: boolean; tokensBefore: number; previousSummary?: string; fileOps: FileOperations; settings: CompactionSettings; }
export interface TreePreparation { targetId: string; oldLeafId: string | null; commonAncestorId: string | null; entriesToSummarize: SessionTreeEntry[]; userWantsSummary: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string; }

export interface QueueUpdateEvent { type: "queue_update"; steer: AgentMessage[]; followUp: AgentMessage[]; nextTurn: AgentMessage[]; }
export interface SavePointEvent { type: "save_point"; hadPendingMutations: boolean; }
export interface AbortEvent { type: "abort"; clearedSteer: AgentMessage[]; clearedFollowUp: AgentMessage[]; }
export interface SettledEvent { type: "settled"; nextTurnCount: number; }
export interface BeforeAgentStartEvent<TSkill extends Skill = Skill, TPrompt extends PromptTemplate = PromptTemplate> {
  type: "before_agent_start";
  prompt: string;
  images?: ImageContent[];
  systemPrompt: string;
  resources: AgentHarnessResources<TSkill, TPrompt>;
}
export interface ContextEvent { type: "context"; messages: AgentMessage[]; }
export interface BeforeProviderRequestEvent { type: "before_provider_request"; model: Model; sessionId: string; streamOptions: AgentHarnessStreamOptions; }
export interface BeforeProviderPayloadEvent { type: "before_provider_payload"; model: Model; payload: unknown; }
export interface AfterProviderResponseEvent { type: "after_provider_response"; status: number; headers: Record<string, string>; }
export interface ToolCallEvent { type: "tool_call"; toolCallId: string; toolName: string; input: Record<string, unknown>; }
export interface ToolResultEvent { type: "tool_result"; toolCallId: string; toolName: string; input: Record<string, unknown>; content: Array<TextContent | ImageContent>; details: unknown; isError: boolean; usage?: Usage; }
export interface SessionBeforeCompactEvent { type: "session_before_compact"; preparation: CompactionPreparation; branchEntries: SessionTreeEntry[]; customInstructions?: string; signal: AbortSignal; }
export interface SessionCompactEvent { type: "session_compact"; compactionEntry: CompactionEntry; fromHook: boolean; }
export interface SessionBeforeTreeEvent { type: "session_before_tree"; preparation: TreePreparation; signal: AbortSignal; }
export interface SessionTreeEvent { type: "session_tree"; newLeafId: string | null; oldLeafId: string | null; summaryEntry?: BranchSummaryEntry; fromHook?: boolean; }
export interface RetryScheduledEvent { type: "retry_scheduled"; operation: "compaction" | "branch_summary"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string; }
export interface RetryAttemptStartEvent { type: "retry_attempt_start"; operation: "compaction" | "branch_summary"; }
export interface RetryFinishedEvent { type: "retry_finished"; operation: "compaction" | "branch_summary"; }
export interface ModelUpdateEvent { type: "model_update"; model: Model; previousModel: Model | undefined; source: "set" | "restore"; }
export interface ThinkingLevelUpdateEvent { type: "thinking_level_update"; level: ThinkingLevel; previousLevel: ThinkingLevel; }
export interface ToolsUpdateEvent { type: "tools_update"; toolNames: string[]; previousToolNames: string[]; activeToolNames: string[]; previousActiveToolNames: string[]; source: "set" | "restore"; }
export interface ResourcesUpdateEvent<TSkill extends Skill = Skill, TPrompt extends PromptTemplate = PromptTemplate> {
  type: "resources_update";
  resources: AgentHarnessResources<TSkill, TPrompt>;
  previousResources: AgentHarnessResources<TSkill, TPrompt>;
}
export type AgentHarnessOwnEvent<TSkill extends Skill = Skill, TPrompt extends PromptTemplate = PromptTemplate> =
  | QueueUpdateEvent
  | SavePointEvent
  | AbortEvent
  | SettledEvent
  | BeforeAgentStartEvent<TSkill, TPrompt>
  | ContextEvent
  | BeforeProviderRequestEvent
  | BeforeProviderPayloadEvent
  | AfterProviderResponseEvent
  | ToolCallEvent
  | ToolResultEvent
  | SessionBeforeCompactEvent
  | SessionCompactEvent
  | SessionBeforeTreeEvent
  | SessionTreeEvent
  | RetryScheduledEvent
  | RetryAttemptStartEvent
  | RetryFinishedEvent
  | ModelUpdateEvent
  | ThinkingLevelUpdateEvent
  | ResourcesUpdateEvent<TSkill, TPrompt>
  | ToolsUpdateEvent;
export type AgentHarnessEvent<TSkill extends Skill = Skill, TPrompt extends PromptTemplate = PromptTemplate> = AgentEvent | AgentHarnessOwnEvent<TSkill, TPrompt>;

export interface CompactResult { summary: string; firstKeptEntryId?: string; tokensBefore: number; usage?: Usage; retainedTail?: AgentMessage[]; details?: unknown; }
export interface AbortResult { clearedSteer: AgentMessage[]; clearedFollowUp: AgentMessage[]; }
export interface NavigateTreeResult { cancelled: boolean; editorText?: string; summaryEntry?: BranchSummaryEntry; }
export interface BeforeAgentStartResult { messages?: AgentMessage[]; systemPrompt?: string; }
export interface ContextResult { messages: AgentMessage[]; }
export interface BeforeProviderRequestResult { streamOptions?: AgentHarnessStreamOptionsPatch; }
export interface BeforeProviderPayloadResult { payload: unknown; }
export interface ToolCallResult { block?: boolean; reason?: string; }
export interface ToolResultPatch { content?: Array<TextContent | ImageContent>; details?: unknown; isError?: boolean; usage?: Usage; terminate?: boolean; }
export interface SessionBeforeCompactResult { cancel?: boolean; compaction?: CompactResult; }
export interface SessionBeforeTreeResult { cancel?: boolean; summary?: { summary: string; details?: unknown; usage?: Usage }; customInstructions?: string; replaceInstructions?: boolean; label?: string; }
export interface AgentHarnessEventResultMap {
  before_agent_start: BeforeAgentStartResult | undefined;
  context: ContextResult | undefined;
  before_provider_request: BeforeProviderRequestResult | undefined;
  before_provider_payload: BeforeProviderPayloadResult | undefined;
  after_provider_response: undefined;
  tool_call: ToolCallResult | undefined;
  tool_result: ToolResultPatch | undefined;
  session_before_compact: SessionBeforeCompactResult | undefined;
  session_compact: undefined;
  session_before_tree: SessionBeforeTreeResult | undefined;
  session_tree: undefined; retry_scheduled: undefined; retry_attempt_start: undefined; retry_finished: undefined;
  model_update: undefined; thinking_level_update: undefined; resources_update: undefined; tools_update: undefined;
  queue_update: undefined; save_point: undefined; abort: undefined; settled: undefined;
}

export interface AgentHarnessPromptOptions { images?: ImageContent[]; }
export interface GenerateBranchSummaryOptions { model: Model; apiKey: string; headers?: Record<string, string>; signal: AbortSignal; customInstructions?: string; replaceInstructions?: boolean; reserveTokens?: number; }
export interface BranchSummaryResult { summary: string; usage?: Usage; readFiles: string[]; modifiedFiles: string[]; }

export interface AgentHarnessOptions<TSkill extends Skill = Skill, TPrompt extends PromptTemplate = PromptTemplate, TTool extends AgentTool = AgentTool> {
  env: ExecutionEnv;
  session: Session;
  models: Models;
  tools?: TTool[];
  resources?: AgentHarnessResources<TSkill, TPrompt>;
  systemPrompt?: string | ((context: { env: ExecutionEnv; session: Session; model: Model; thinkingLevel: ThinkingLevel; activeTools: TTool[]; resources: AgentHarnessResources<TSkill, TPrompt> }) => string | Promise<string>);
  streamOptions?: AgentHarnessStreamOptions;
  retry?: RetryPolicy;
  model: Model;
  thinkingLevel?: ThinkingLevel;
  activeToolNames?: string[];
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
}

export type { AgentHarness } from "./agent-harness.js";
