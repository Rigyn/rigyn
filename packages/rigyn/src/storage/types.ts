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

export const CURRENT_SESSION_VERSION = 3 as const;

export interface SessionHeader {
  type: "session";
  /** Missing on legacy version-one files. New files always contain version 3. */
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface NewSessionOptions {
  id?: string;
  parentSession?: string;
}

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

/** A terminal command recorded as conversation history. */
export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  timestamp: number;
  excludeFromContext?: boolean;
}

/** An extension-authored conversational message. */
export interface CustomMessage<T = unknown> {
  role: "custom";
  customType: string;
  content: string | (TextBlock | ImageBlock)[];
  display: boolean;
  details?: T;
  timestamp: number;
}

export interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;
  timestamp: number;
}

export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

/** Messages that may be stored directly inside a message entry. */
export type PersistedSessionMessage =
  | (CanonicalMessage & {
      api?: ModelProtocolFamily;
      model?: string;
      usage?: NormalizedUsage;
      stopReason?: FinishReason;
      errorMessage?: string;
      providerState?: ProviderState;
      toolDefinitionFingerprint?: string;
      timestamp?: number;
    })
  | BashExecutionMessage
  | CustomMessage;

/** Messages produced by context reconstruction. */
export type SessionContextMessage = PersistedSessionMessage | BranchSummaryMessage | CompactionSummaryMessage;

export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: PersistedSessionMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  usage?: NormalizedUsage;
  details?: T;
  fromHook?: boolean;
}

export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  usage?: NormalizedUsage;
  details?: T;
  fromHook?: boolean;
}

/** Durable extension state. It is deliberately omitted from model context. */
export interface CustomEntry<T = unknown> extends SessionEntryBase {
  type: "custom";
  customType: string;
  data?: T;
}

/** Extension content that is reconstructed into model context. */
export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
  type: "custom_message";
  customType: string;
  content: string | (TextBlock | ImageBlock)[];
  details?: T;
  display: boolean;
}

export interface LabelEntry extends SessionEntryBase {
  type: "label";
  targetId: string;
  label: string | undefined;
}

export interface SessionInfoEntry extends SessionEntryBase {
  type: "session_info";
  name?: string;
}

export type SessionEntry =
  | SessionMessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry;

export type FileEntry = SessionHeader | SessionEntry;

export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
  label?: string;
  labelTimestamp?: string;
}

export interface SessionContext {
  messages: SessionContextMessage[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  allMessagesText: string;
}

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
