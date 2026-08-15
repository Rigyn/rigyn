import type { EventEnvelope } from "../core/events.js";
import type { CanonicalMessage, NormalizedUsage } from "../core/types.js";
import { addCompleteNormalizedUsage, addNormalizedUsage } from "../core/usage.js";
import { normalizedCacheHitRate } from "../core/cache-usage.js";
import {
  canonicalMessage,
  canonicalUsage,
  extensionSessionEntries,
  type SessionEntry as ExtensionSessionEntry,
} from "../extensions/session-contract.js";
import type { AgentSession, AgentSessionEvent } from "../service/agent-session.js";
import type { ActiveBranchUsage } from "../storage/session-manager.js";
import type { SessionEntry as CanonicalSessionEntry } from "../storage/types.js";
import type { TuiController } from "../tui/controller.js";
import type { TuiLatestCacheUsage, TuiSessionSummary, TuiTranscriptItem } from "../tui/types.js";

export const INTERACTIVE_TRANSCRIPT_ENTRY_LIMIT = 2_000;
export const INTERACTIVE_TRANSCRIPT_SCAN_LIMIT = 20_000;
export const INTERACTIVE_TRANSCRIPT_SCAN_BYTES = 16 * 1024 * 1024;
export const INTERACTIVE_TRANSCRIPT_SCAN_MS = 100;
const DISPLAY_MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool"]);
const PUBLIC_DISPLAY_MESSAGE_ROLES = new Set(["user", "assistant", "toolResult"]);
type PresentationEntry = CanonicalSessionEntry | ExtensionSessionEntry;

interface LinkedEntryReader<T extends PresentationEntry> {
  getEntry(id: string): T | undefined;
  getLeafEntry(): T | undefined;
}

interface BranchEntryReader<T extends PresentationEntry> extends LinkedEntryReader<T> {
  getBranch(): T[];
}

interface BranchUsageReader {
  getActiveBranchUsage(): ActiveBranchUsage;
}

type RecentDisplayEntries =
  | { entries: CanonicalSessionEntry[]; source: "canonical" }
  | { entries: ExtensionSessionEntry[]; source: "public" };

function isDisplayEntry(entry: PresentationEntry): entry is Extract<PresentationEntry, { type: "custom" | "custom_message" }> {
  return entry.type === "custom" || (entry.type === "custom_message" && entry.display === true);
}

function isDisplaySummary(
  entry: PresentationEntry,
): entry is Extract<PresentationEntry, { type: "compaction" | "branch_summary" }> {
  return entry.type === "compaction" || entry.type === "branch_summary";
}

function isSystemEntry(entry: PresentationEntry): entry is Extract<CanonicalSessionEntry, { type: "message" }> {
  return entry.type === "message" && entry.message.role === "system";
}

function isInstructionEntry(entry: PresentationEntry): boolean {
  return isSystemEntry(entry)
    && (entry.message as { purpose?: unknown }).purpose === "instructions";
}

function isPresentableEntry(entry: PresentationEntry): boolean {
  return isDisplayEntry(entry)
    || isDisplaySummary(entry)
    || (entry.type === "message" && (
      DISPLAY_MESSAGE_ROLES.has(entry.message.role)
      || PUBLIC_DISPLAY_MESSAGE_ROLES.has(entry.message.role)
      || entry.message.role === "bashExecution"
      || (entry.message.role === "custom" && entry.message.display)
    ));
}

function boundedValueBytes(
  value: unknown,
  maximum: number,
  deadline: number,
  seen = new Set<object>(),
  depth = 0,
): number {
  if (maximum <= 0) return 0;
  if (performance.now() >= deadline) return maximum;
  if (value === null || value === undefined) return Math.min(maximum, 4);
  if (typeof value === "string") {
    if (value.length >= maximum) return maximum;
    return Math.min(maximum, Buffer.byteLength(value, "utf8") + 2);
  }
  if (typeof value === "number" || typeof value === "boolean") return Math.min(maximum, 16);
  if (typeof value !== "object" || depth >= 32 || seen.has(value)) return Math.min(maximum, 32);
  seen.add(value);
  let bytes = 2;
  try {
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (bytes >= maximum || performance.now() >= deadline) return maximum;
      const remaining = maximum - bytes;
      bytes += key.length >= remaining
        ? remaining
        : Math.min(remaining, Buffer.byteLength(key, "utf8") + 4);
      if (bytes >= maximum) return maximum;
      bytes += boundedValueBytes(
        (value as Record<string, unknown>)[key],
        maximum - bytes,
        deadline,
        seen,
        depth + 1,
      );
    }
  } catch {
    return maximum;
  } finally {
    seen.delete(value);
  }
  return Math.min(maximum, bytes);
}

function scanRecentDisplayEntries<T extends PresentationEntry>(reader: LinkedEntryReader<T>): T[] {
  const selected: T[] = [];
  const deadline = performance.now() + INTERACTIVE_TRANSCRIPT_SCAN_MS;
  let scanned = 0;
  let bytes = 0;
  let compaction: Extract<PresentationEntry, { type: "compaction" }> | undefined;
  let retainedBoundaryReached = false;
  let selectedInstruction = false;
  let entry = reader.getLeafEntry();
  while (
    entry !== undefined
    && selected.length < INTERACTIVE_TRANSCRIPT_ENTRY_LIMIT
    && scanned < INTERACTIVE_TRANSCRIPT_SCAN_LIMIT
    && bytes < INTERACTIVE_TRANSCRIPT_SCAN_BYTES
    && (selected.length === 0 || performance.now() < deadline)
  ) {
    scanned += 1;
    bytes += boundedValueBytes(
      entry,
      INTERACTIVE_TRANSCRIPT_SCAN_BYTES - bytes,
      selected.length === 0 ? Number.POSITIVE_INFINITY : deadline,
    );
    if (compaction === undefined) {
      if (isPresentableEntry(entry)) selected.push(entry);
      if (entry.type === "compaction") compaction = entry;
    } else {
      const system = isSystemEntry(entry);
      if (system) {
        if (!isInstructionEntry(entry) || !selectedInstruction) selected.push(entry);
        if (isInstructionEntry(entry)) selectedInstruction = true;
      } else if (!retainedBoundaryReached && entry.type !== "compaction" && isPresentableEntry(entry)) {
        selected.push(entry);
      }
      if (entry.id === compaction.firstKeptEntryId) retainedBoundaryReached = true;
    }
    entry = entry.parentId === null ? undefined : reader.getEntry(entry.parentId);
  }
  return selected.reverse();
}

function linkedEntryReader<T extends PresentationEntry>(value: unknown): LinkedEntryReader<T> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as Partial<LinkedEntryReader<T>>;
  return typeof candidate.getLeafEntry === "function" && typeof candidate.getEntry === "function"
    ? candidate as LinkedEntryReader<T>
    : undefined;
}

function branchEntryReader<T extends PresentationEntry>(value: unknown): BranchEntryReader<T> | undefined {
  const reader = linkedEntryReader<T>(value);
  if (reader === undefined || typeof (reader as Partial<BranchEntryReader<T>>).getBranch !== "function") {
    return undefined;
  }
  return reader as BranchEntryReader<T>;
}

function branchUsageReader(value: unknown): BranchUsageReader | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as Partial<BranchUsageReader>;
  return typeof candidate.getActiveBranchUsage === "function"
    ? candidate as BranchUsageReader
    : undefined;
}

function entriesAreCanonical(entries: readonly PresentationEntry[]): entries is readonly CanonicalSessionEntry[] {
  for (const entry of entries) {
    if (entry.type === "message") {
      const message = entry.message as unknown as { createdAt?: unknown; role?: unknown; timestamp?: unknown };
      if (message.createdAt !== undefined || message.role === "system" || message.role === "tool") return true;
      if (message.timestamp !== undefined || message.role === "toolResult") return false;
    }
    if (isDisplaySummary(entry) && entry.usage !== undefined) {
      return "inputTokens" in entry.usage;
    }
  }
  return false;
}

function recentDisplayEntries(session: AgentSession): RecentDisplayEntries {
  const native = linkedEntryReader<CanonicalSessionEntry>(
    Reflect.get(session as unknown as object, "nativeSessionManager"),
  );
  if (native !== undefined) return { entries: scanRecentDisplayEntries(native), source: "canonical" };

  const fallback = linkedEntryReader<PresentationEntry>(
    Reflect.get(session as unknown as object, "sessionManager"),
  );
  if (fallback === undefined) throw new TypeError("Agent session does not expose a readable session manager");
  const entries = scanRecentDisplayEntries(fallback);
  return entriesAreCanonical(entries)
    ? { entries: [...entries], source: "canonical" }
    : { entries: entries as ExtensionSessionEntry[], source: "public" };
}

function activeBranchEntries(session: AgentSession): RecentDisplayEntries {
  const native = branchEntryReader<CanonicalSessionEntry>(
    Reflect.get(session as unknown as object, "nativeSessionManager"),
  );
  if (native !== undefined) return { entries: native.getBranch(), source: "canonical" };

  const fallback = branchEntryReader<PresentationEntry>(
    Reflect.get(session as unknown as object, "sessionManager"),
  );
  if (fallback === undefined) throw new TypeError("Agent session does not expose a readable session manager");
  const entries = fallback.getBranch();
  return entriesAreCanonical(entries)
    ? { entries: [...entries], source: "canonical" }
    : { entries: entries as ExtensionSessionEntry[], source: "public" };
}

export interface InteractiveTranscriptUsageBaseline {
  usage?: NormalizedUsage;
  reportedUsage?: NormalizedUsage;
  latestCacheHitRate?: number;
  latestCacheUsage?: TuiLatestCacheUsage;
}

function activeBranchUsage(session: AgentSession): ActiveBranchUsage {
  const native = branchUsageReader(Reflect.get(session as unknown as object, "nativeSessionManager"));
  if (native !== undefined) return native.getActiveBranchUsage();

  const publicManager = Reflect.get(session as unknown as object, "sessionManager");
  const projected = branchUsageReader(publicManager);
  if (projected !== undefined) return projected.getActiveBranchUsage();

  // Keep older embedded session readers source-compatible. Public tool-result
  // batches cannot preserve canonical usage ownership, so this conservative
  // fallback counts their assistant and summary requests only.
  const branch = activeBranchEntries(session);
  let aggregate: NormalizedUsage | undefined;
  let reported: NormalizedUsage | undefined;
  let latestAssistantUsage: NormalizedUsage | undefined;
  let hasUsageObservations = false;
  for (const entry of branch.entries) {
    if (isDisplaySummary(entry)) {
      const usage = entry.usage === undefined
        ? {}
        : branch.source === "canonical"
          ? entry.usage as NormalizedUsage
          : canonicalUsage(entry.usage as Parameters<typeof canonicalUsage>[0]);
      if (entry.fromHook !== true || entry.usage !== undefined) {
        hasUsageObservations = true;
        aggregate = addCompleteNormalizedUsage(aggregate, usage);
        reported = addNormalizedUsage(reported, usage);
      }
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: unknown; stopReason?: unknown; usage?: unknown };
    const usage = message.usage === undefined
      ? undefined
      : branch.source === "canonical"
        ? message.usage as NormalizedUsage
        : canonicalUsage(message.usage as Parameters<typeof canonicalUsage>[0]);
    const successfulAssistant = message.role === "assistant"
      && message.stopReason !== "cancelled"
      && message.stopReason !== "aborted"
      && message.stopReason !== "error";
    if (usage !== undefined || successfulAssistant) {
      if (message.role === "assistant" || (branch.source === "canonical" && message.role === "tool")) {
        hasUsageObservations = true;
        aggregate = addCompleteNormalizedUsage(aggregate, usage ?? {});
        reported = addNormalizedUsage(reported, usage ?? {});
      }
    }
    if (
      branch.source === "canonical"
      && message.role === "assistant"
      && successfulAssistant
    ) latestAssistantUsage = usage;
  }
  const usage = aggregate ?? {};
  const reportedUsage = reported ?? {};
  const reportedFields = [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "cacheWrite1hTokens",
    "reasoningTokens",
    "serverToolCalls",
    "durationMs",
  ] as const;
  const hasReportedFallback = reportedFields.some(
    (field) => usage[field] === undefined && reportedUsage[field] !== undefined,
  ) || (usage.cost === undefined && reportedUsage.cost !== undefined);
  return {
    usage,
    ...(hasReportedFallback ? { reportedUsage } : {}),
    hasUsageObservations,
    ...(latestAssistantUsage === undefined ? {} : { latestAssistantUsage }),
  };
}

/** Usage shown beside the active transcript, excluding abandoned sibling branches. */
export function interactiveTranscriptUsageBaseline(session: AgentSession): InteractiveTranscriptUsageBaseline {
  const baseline = activeBranchUsage(session);
  const latestAssistantUsage = baseline.latestAssistantUsage;
  const latestCacheHitRate = latestAssistantUsage === undefined
    ? undefined
    : normalizedCacheHitRate(latestAssistantUsage);
  const latestCacheUsage: TuiLatestCacheUsage | undefined = latestAssistantUsage === undefined || (
    latestAssistantUsage.cacheReadTokens === undefined
    && latestAssistantUsage.cacheWriteTokens === undefined
    && latestAssistantUsage.cacheWrite1hTokens === undefined
  )
    ? undefined
    : {
        ...(latestAssistantUsage.cacheReadTokens === undefined
          ? {}
          : { cacheReadTokens: latestAssistantUsage.cacheReadTokens }),
        ...(latestAssistantUsage.cacheWriteTokens === undefined
          ? {}
          : { cacheWriteTokens: latestAssistantUsage.cacheWriteTokens }),
        ...(latestAssistantUsage.cacheWrite1hTokens === undefined
          ? {}
          : { cacheWrite1hTokens: latestAssistantUsage.cacheWrite1hTokens }),
      };
  return {
    ...(baseline.hasUsageObservations === false ? {} : { usage: baseline.usage }),
    ...(baseline.hasUsageObservations === false || baseline.reportedUsage === undefined
      ? {}
      : { reportedUsage: baseline.reportedUsage }),
    ...(latestCacheHitRate === undefined ? {} : { latestCacheHitRate }),
    ...(latestCacheUsage === undefined ? {} : { latestCacheUsage }),
  };
}

function publicDisplayMessage(entry: Extract<ExtensionSessionEntry, { type: "message" }>): CanonicalMessage | undefined {
  const message = entry.message;
  if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return undefined;
  let safeMessage: Parameters<typeof canonicalMessage>[0] = message;
  if (message.role === "assistant") {
    const {
      diagnostics: _diagnostics,
      providerState: _providerState,
      responseId: _responseId,
      responseModel: _responseModel,
      ...displayMessage
    } = message;
    safeMessage = { ...displayMessage, api: "extension-stream" };
  }
  const canonical = canonicalMessage(safeMessage);
  if (canonical.role === "bashExecution" || canonical.role === "custom") return undefined;
  return { ...canonical, id: entry.id, createdAt: entry.timestamp };
}

function publicCustomMessage(entry: Extract<ExtensionSessionEntry, { type: "message" }>): TuiTranscriptItem | undefined {
  const message = entry.message;
  if (message.role !== "custom" || !message.display) return undefined;
  return {
    type: "custom_message",
    id: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
    customType: message.customType,
    content: structuredClone(message.content),
    display: true,
    ...(message.details === undefined ? {} : { details: structuredClone(message.details) }),
  };
}

function summaryUsage(
  entry: Extract<PresentationEntry, { type: "compaction" | "branch_summary" }>,
  source: RecentDisplayEntries["source"],
): NormalizedUsage | undefined {
  if (entry.usage === undefined) return undefined;
  return source === "canonical"
    ? entry.usage as NormalizedUsage
    : canonicalUsage(entry.usage as Parameters<typeof canonicalUsage>[0]);
}

/** Projects the active JSONL branch into one stable, ordered terminal history. */
export function interactiveTranscriptHistory(session: AgentSession): TuiTranscriptItem[] {
  let sequence = 0;
  let parentEventId: string | undefined;
  const recent = recentDisplayEntries(session);
  const entries: PresentationEntry[] = recent.entries;
  const directEntries = recent.source === "canonical"
    ? extensionSessionEntries(recent.entries)
    : recent.entries;
  const projectedDirectEntries = new Map(directEntries.flatMap((entry) =>
    entry.type === "custom" || (entry.type === "custom_message" && entry.display === true)
      ? [[entry.id, entry] as const]
      : []));
  return entries.flatMap((entry): TuiTranscriptItem[] => {
    if (isDisplaySummary(entry)) {
      const normalizedUsage = summaryUsage(entry, recent.source);
      const safeUsage = normalizedUsage === undefined
        ? undefined
        : (({ raw: _raw, ...usage }) => usage)(normalizedUsage);
      const summary: TuiSessionSummary = {
        type: "session_summary",
        id: entry.id,
        summaryType: entry.type,
        text: entry.summary,
        ...(entry.type === "compaction" ? { tokensBefore: entry.tokensBefore } : {}),
        ...(safeUsage === undefined ? {} : { usage: structuredClone(safeUsage) }),
      };
      return [summary];
    }
    if (isDisplayEntry(entry)) {
      const projected = projectedDirectEntries.get(entry.id);
      if (projected === undefined) throw new Error("Direct session presentation lost a custom entry projection");
      return [projected];
    }
    if (entry.type !== "message") return [];
    if (entry.message.role === "bashExecution") {
      return [{
        type: "shell_execution",
        id: entry.id,
        command: entry.message.command,
        output: entry.message.output,
        ...(entry.message.exitCode === undefined ? {} : { exitCode: entry.message.exitCode }),
        ...(entry.message.isError === undefined ? {} : { isError: entry.message.isError }),
        cancelled: entry.message.cancelled,
        ...(entry.message.timedOut === undefined ? {} : { timedOut: entry.message.timedOut }),
        ...(entry.message.signal === undefined ? {} : { signal: entry.message.signal }),
        truncated: entry.message.truncated,
        ...(entry.message.fullOutputPath === undefined ? {} : { fullOutputPath: entry.message.fullOutputPath }),
        ...(entry.message.excludeFromContext === undefined
          ? {}
          : { excludeFromContext: entry.message.excludeFromContext }),
      }];
    }
    if (recent.source === "public") {
      const custom = publicCustomMessage(entry as Extract<ExtensionSessionEntry, { type: "message" }>);
      if (custom !== undefined) return [custom];
    }
    const message = recent.source === "canonical"
      ? entry.message as CanonicalMessage
      : publicDisplayMessage(entry as Extract<ExtensionSessionEntry, { type: "message" }>);
    if (message === undefined || !DISPLAY_MESSAGE_ROLES.has(message.role)) return [];
    const envelope: EventEnvelope = {
      eventId: entry.id,
      threadId: session.sessionId,
      ...(parentEventId === undefined ? {} : { parentEventId }),
      sequence: ++sequence,
      timestamp: entry.timestamp,
      schemaVersion: 1,
      event: { type: "message_appended", message: message as CanonicalMessage },
    };
    parentEventId = entry.id;
    if (message.role !== "assistant") return [envelope];
    return [envelope, {
      eventId: `${entry.id}~assistant-completed`,
      threadId: session.sessionId,
      parentEventId: entry.id,
      sequence: ++sequence,
      timestamp: entry.timestamp,
      schemaVersion: 1,
      event: {
        type: "assistant_completed",
        finishReason: message.stopReason
          ?? (message.content.some((block) => block.type === "tool_call") ? "tool_calls" : "stop"),
      },
    }];
  });
}

export interface InteractiveSessionPresentationOptions {
  onEnvelope?(event: EventEnvelope): void;
  onSessionEvent?(event: AgentSessionEvent): void;
  preserveTranscript?: boolean;
}

/**
 * Owns history replay plus both live event streams. Subscription begins before
 * the snapshot, so entries appended during resume cannot fall between them.
 */
export function bindInteractiveSessionPresentation(
  session: AgentSession,
  terminal: TuiController,
  options: InteractiveSessionPresentationOptions = {},
): () => void {
  let replaying = true;
  const pending: Array<() => void> = [];
  const deliver = (action: () => void): void => {
    if (replaying) pending.push(action);
    else action();
  };
  const unsubscribeEnvelope = session.onEvent((event) => deliver(() => {
    terminal.render(event);
    options.onEnvelope?.(event);
  }));
  const unsubscribeSession = session.subscribe((event) => deliver(() => {
    if (
      event.type === "entry_appended"
      && (event.entry.type === "custom" || (event.entry.type === "custom_message" && event.entry.display === true))
    ) {
      terminal.renderSessionEntry(event.entry);
    }
    options.onSessionEvent?.(event);
  }));
  try {
    terminal.replaceTranscript(interactiveTranscriptHistory(session), "main", {
      preserveExisting: options.preserveTranscript === true,
    });
    const usage = interactiveTranscriptUsageBaseline(session);
    terminal.setUsageBaseline(
      usage.usage,
      usage.latestCacheHitRate,
      usage.latestCacheUsage,
      usage.reportedUsage,
    );
    replaying = false;
    for (const action of pending) action();
    pending.length = 0;
  } catch (error) {
    unsubscribeSession();
    unsubscribeEnvelope();
    throw error;
  }
  return () => {
    replaying = false;
    pending.length = 0;
    unsubscribeSession();
    unsubscribeEnvelope();
  };
}
