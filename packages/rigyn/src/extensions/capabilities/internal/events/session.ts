import type { AgentMessage, Usage } from "@rigyn/kernel";

import type { CompactionReason } from "../../../../context/compaction.js";
import type {
  BranchSummaryEntry,
  CompactionEntry,
  SessionEntry,
} from "../../../session-contract.js";
import type { CompactionResult } from "../../host.js";

interface SessionEvent<Type extends string> {
  type: Type;
}

interface SessionCancellationResult {
  cancel?: boolean;
  reason?: string;
}

interface CompactionLifecycleEvent {
  reason: CompactionReason;
  willRetry: boolean;
}

interface TreeSummaryOptions {
  customInstructions?: string;
  label?: string;
  replaceInstructions?: boolean;
}

export interface SessionStartEvent extends SessionEvent<"session_start"> {
  reason: "startup" | "refresh" | "new" | "resume" | "fork";
  previousSessionFile?: string;
}

export interface SessionInfoChangedEvent extends SessionEvent<"session_info_changed"> {
  name: string | undefined;
}

export interface SessionBeforeSwitchEvent extends SessionEvent<"session_before_switch"> {
  reason: "new" | "resume";
  targetSessionFile?: string;
}

export interface SessionBeforeSwitchResult extends SessionCancellationResult {}

export interface SessionBeforeForkEvent extends SessionEvent<"session_before_fork"> {
  entryId: string;
  position: "before" | "at";
}

export interface SessionBeforeForkResult extends SessionCancellationResult {}

export interface CompactionFileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  recentTokens: number;
  maxInputTokens: number;
}

interface CompactionSelection {
  firstKeptEntryId: string;
  isSplitTurn: boolean;
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
}

export interface CompactionPreparation extends CompactionSelection {
  fileOps: CompactionFileOperations;
  previousSummary?: string;
  settings: CompactionSettings;
  tokensBefore: number;
}

export interface SessionBeforeCompactEvent
  extends SessionEvent<"session_before_compact">, CompactionLifecycleEvent {
  preparation: CompactionPreparation;
  branchEntries: SessionEntry[];
  customInstructions?: string;
  signal: AbortSignal;
}

export interface SessionBeforeCompactResult {
  cancel?: boolean;
  compaction?: Omit<CompactionResult, "estimatedTokensAfter">;
}

export interface SessionCompactEvent extends SessionEvent<"session_compact">, CompactionLifecycleEvent {
  compactionEntry: CompactionEntry;
  fromExtension: boolean;
}

export interface SessionShutdownEvent extends SessionEvent<"session_shutdown"> {
  reason: "quit" | "refresh" | "new" | "resume" | "fork";
  targetSessionFile?: string;
}

export interface TreePreparation extends TreeSummaryOptions {
  targetId: string;
  oldLeafId: string | null;
  commonAncestorId: string | null;
  entriesToSummarize: SessionEntry[];
  userWantsSummary: boolean;
}

export interface SessionBeforeTreeEvent extends SessionEvent<"session_before_tree"> {
  preparation: TreePreparation;
  signal: AbortSignal;
}

export interface SessionBeforeTreeResult extends TreeSummaryOptions {
  cancel?: boolean;
  summary?: { summary: string; details?: unknown; usage?: Usage };
}

export interface SessionTreeEvent extends SessionEvent<"session_tree"> {
  newLeafId: string;
  oldLeafId: string | null;
  summaryEntry?: BranchSummaryEntry;
  fromExtension?: boolean;
}

export interface SessionEventMap {
  session_before_compact: SessionBeforeCompactEvent;
  session_before_fork: SessionBeforeForkEvent;
  session_before_switch: SessionBeforeSwitchEvent;
  session_before_tree: SessionBeforeTreeEvent;
  session_compact: SessionCompactEvent;
  session_info_changed: SessionInfoChangedEvent;
  session_shutdown: SessionShutdownEvent;
  session_start: SessionStartEvent;
  session_tree: SessionTreeEvent;
}

type SessionVoidResultEvent =
  | "session_compact"
  | "session_info_changed"
  | "session_shutdown"
  | "session_start"
  | "session_tree";

export interface SessionEventResultMap extends Record<SessionVoidResultEvent, void> {
  session_before_compact: SessionBeforeCompactResult | void;
  session_before_fork: SessionBeforeForkResult | void;
  session_before_switch: SessionBeforeSwitchResult | void;
  session_before_tree: SessionBeforeTreeResult | void;
}
