import type { JsonValue } from "../core/json.js";
import type {
  CanonicalMessage,
  FinishReason,
  ImageBlock,
  ModelProtocolFamily,
  NormalizedUsage,
  ProviderState,
  TextBlock,
} from "../core/types.js";

export const CURRENT_SESSION_VERSION = 4 as const;

export interface SessionHeader {
  cwd: string;
  id: string;
  parentSession?: string;
  timestamp: string;
  type: "session";
  version: typeof CURRENT_SESSION_VERSION;
}

export interface NewSessionOptions {
  id?: string;
  parentSession?: string;
}

export interface SessionEntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
  type: string;
}

/** A terminal command recorded as conversation history. */
export interface BashExecutionMessage {
  cancelled: boolean;
  command: string;
  excludeFromContext?: boolean;
  exitCode: number | undefined;
  fullOutputPath?: string;
  isError?: boolean;
  output: string;
  role: "bashExecution";
  signal?: string;
  timestamp: number;
  timedOut?: boolean;
  truncated: boolean;
}

/** An extension-authored conversational message. */
export interface CustomMessage<T = unknown> {
  content: string | (TextBlock | ImageBlock)[];
  customType: string;
  details?: T;
  display: boolean;
  role: "custom";
  timestamp: number;
}

export interface BranchSummaryMessage {
  fromId: string;
  role: "branchSummary";
  summary: string;
  timestamp: number;
}

export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  timestamp: number;
  tokensBefore: number;
  usage?: NormalizedUsage;
}

/** Messages that may be stored directly inside a message entry. */
export type PersistedSessionMessage =
  | (CanonicalMessage & {
      api?: ModelProtocolFamily;
      errorMessage?: string;
      model?: string;
      providerState?: ProviderState;
      stopReason?: FinishReason;
      timestamp?: number;
      toolDefinitionFingerprint?: string;
      usage?: NormalizedUsage;
    })
  | BashExecutionMessage
  | CustomMessage;

/** Messages produced by context reconstruction. */
export type SessionContextMessage = PersistedSessionMessage | BranchSummaryMessage | CompactionSummaryMessage;

export interface SessionMessageEntry extends SessionEntryBase {
  message: PersistedSessionMessage;
  type: "message";
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  thinkingLevel: string;
  type: "thinking_level_change";
}

export interface ModelChangeEntry extends SessionEntryBase {
  modelId: string;
  provider: string;
  type: "model_change";
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
  details?: T;
  firstKeptEntryId: string;
  fromHook?: boolean;
  summary: string;
  tokensBefore: number;
  type: "compaction";
  usage?: NormalizedUsage;
}

export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
  details?: T;
  fromId: string;
  fromHook?: boolean;
  summary: string;
  type: "branch_summary";
  usage?: NormalizedUsage;
}

/** Durable extension state. It is deliberately omitted from model context. */
export interface CustomEntry<T = unknown> extends SessionEntryBase {
  customType: string;
  data?: T;
  type: "custom";
}

/** Extension content that is reconstructed into model context. */
export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
  content: string | (TextBlock | ImageBlock)[];
  customType: string;
  details?: T;
  display: boolean;
  type: "custom_message";
}

export interface LabelEntry extends SessionEntryBase {
  label: string | undefined;
  targetId: string;
  type: "label";
}

export interface SessionInfoEntry extends SessionEntryBase {
  name?: string;
  type: "session_info";
}

export type SessionEntry =
  | BranchSummaryEntry
  | CompactionEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | ModelChangeEntry
  | SessionMessageEntry
  | ThinkingLevelChangeEntry
  | SessionInfoEntry;

/** Bounds and filters a query over one session lineage. */
export interface SessionBranchQuery {
  /** Entry where traversal starts. Omit it to use the active leaf; null selects the empty root. */
  start?: string | null;
  /** Stop after this entry is encountered, including the entry. */
  stopAtId?: string;
  /** Stop after the first entry of this type is encountered, including the entry. */
  stopAtType?: SessionEntry["type"];
  /** Return only entries of this type after traversal bounds are resolved. */
  type?: SessionEntry["type"];
  /** Return only durable custom entries with this custom type. */
  customType?: string;
  /** Traverse from the leaf by default, or from the root when set to oldestFirst. */
  order?: "newestFirst" | "oldestFirst";
  /** Maximum filtered entries to return. Must be a positive integer. */
  limit?: number;
}

export type FileEntry = SessionHeader | SessionEntry;

export interface SessionTreeNode {
  children: SessionTreeNode[];
  entry: SessionEntry;
  /** Absolute depth in the complete session tree, including paged ancestors. */
  depth?: number;
  label?: string;
  labelTimestamp?: string;
}

export interface SessionContext {
  messages: SessionContextMessage[];
  model: { provider: string; modelId: string } | null;
  thinkingLevel: string;
}

interface SessionInfoLocation {
  path: string;
  id: string;
  cwd: string;
  parentSessionPath?: string;
}

interface SessionInfoDisplay {
  name?: string;
  firstMessage: string;
  allMessagesText: string;
}

interface SessionInfoStatistics {
  created: Date;
  modified: Date;
  messageCount: number;
}

export interface SessionInfo extends SessionInfoLocation, SessionInfoDisplay, SessionInfoStatistics {}

export interface SessionFileIssue {
  path: string;
  error: string;
}

export interface SessionScanResult {
  sessions: SessionInfo[];
  invalid: SessionFileIssue[];
}

export type SessionListProgress = (loaded: number, total: number) => void;

/** JSON-safe extension payload convenience type for callers. */
export type SessionCustomData = JsonValue;
