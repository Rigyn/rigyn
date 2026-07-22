import type { EventEnvelope } from "../core/events.js";
import type { CanonicalMessage } from "../core/types.js";
import { extensionSessionEntries } from "../extensions/session-contract.js";
import type { AgentSession, AgentSessionEvent } from "../service/agent-session.js";
import type { SessionEntry } from "../storage/types.js";
import type { TuiController } from "../tui/controller.js";
import type { TuiTranscriptItem } from "../tui/types.js";

export const INTERACTIVE_TRANSCRIPT_ENTRY_LIMIT = 2_000;
export const INTERACTIVE_TRANSCRIPT_SCAN_LIMIT = 20_000;
export const INTERACTIVE_TRANSCRIPT_SCAN_BYTES = 16 * 1024 * 1024;
export const INTERACTIVE_TRANSCRIPT_SCAN_MS = 100;
const DISPLAY_MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool"]);

function isDisplayEntry(entry: SessionEntry): entry is Extract<SessionEntry, { type: "custom" | "custom_message" }> {
  return entry.type === "custom" || (entry.type === "custom_message" && entry.display === true);
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

function recentDisplayEntries(session: AgentSession): SessionEntry[] {
  const selected: SessionEntry[] = [];
  const deadline = performance.now() + INTERACTIVE_TRANSCRIPT_SCAN_MS;
  let scanned = 0;
  let bytes = 0;
  let entry = session.sessionManager.getLeafEntry();
  while (
    entry !== undefined
    && selected.length < INTERACTIVE_TRANSCRIPT_ENTRY_LIMIT
    && scanned < INTERACTIVE_TRANSCRIPT_SCAN_LIMIT
    && bytes < INTERACTIVE_TRANSCRIPT_SCAN_BYTES
    && performance.now() < deadline
  ) {
    scanned += 1;
    bytes += boundedValueBytes(entry, INTERACTIVE_TRANSCRIPT_SCAN_BYTES - bytes, deadline);
    if (
      isDisplayEntry(entry)
      || (entry.type === "message" && DISPLAY_MESSAGE_ROLES.has(entry.message.role))
    ) selected.push(entry);
    entry = entry.parentId === null ? undefined : session.sessionManager.getEntry(entry.parentId);
  }
  return selected.reverse();
}

/** Projects the active JSONL branch into one stable, ordered terminal history. */
export function interactiveTranscriptHistory(session: AgentSession): TuiTranscriptItem[] {
  let sequence = 0;
  let parentEventId: string | undefined;
  const entries = recentDisplayEntries(session);
  const projectedDirectEntries = new Map(extensionSessionEntries(entries).flatMap((entry) =>
    entry.type === "custom" || (entry.type === "custom_message" && entry.display === true)
      ? [[entry.id, entry] as const]
      : []));
  return entries.flatMap((entry): TuiTranscriptItem[] => {
    if (isDisplayEntry(entry)) {
      const projected = projectedDirectEntries.get(entry.id);
      if (projected === undefined) throw new Error("Direct session presentation lost a custom entry projection");
      return [projected];
    }
    if (entry.type !== "message") return [];
    const message = entry.message;
    if (!DISPLAY_MESSAGE_ROLES.has(message.role)) return [];
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
    return [envelope];
  });
}

export interface InteractiveSessionPresentationOptions {
  onEnvelope?(event: EventEnvelope): void;
  onSessionEvent?(event: AgentSessionEvent): void;
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
    terminal.replaceTranscript(interactiveTranscriptHistory(session), "main");
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
