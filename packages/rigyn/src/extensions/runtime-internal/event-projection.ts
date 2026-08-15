import type { CanonicalMessage, ImageBlock, ToolResultBlock } from "../../core/types.js";
import type { SessionEntry } from "../../storage/types.js";
import {
  extensionAssistantEvent,
  extensionCanonicalMessages,
  extensionContent,
  extensionMessage,
  extensionMessages,
  extensionSessionEntry,
  extensionToolResultBlock,
} from "../session-contract.js";
import type { RuntimeExtensionEvent } from "../runtime.js";

const RUN_SCOPED_EVENTS: ReadonlySet<RuntimeExtensionEvent> = new Set([
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

const REQUESTER_THREAD_EVENTS: ReadonlySet<RuntimeExtensionEvent> = new Set([
  ...RUN_SCOPED_EVENTS,
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

export function directEventRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function freezeRuntimeRunEvent<T>(_event: RuntimeExtensionEvent, value: T): T {
  if (value !== null && typeof value === "object") return Object.freeze(value);
  return value;
}

type DirectEventProjector = (selected: Record<string, unknown>) => unknown[];

const EVENT_PROJECTORS = {
  agent_end(selected) {
    if (!Array.isArray(selected.messages)) return [selected];
    return [{ ...selected, messages: extensionCanonicalMessages(selected.messages as CanonicalMessage[]) }];
  },
  turn_end(selected) {
    if (directEventRecord(selected.message) === undefined) return [selected];
    const timestamp = typeof selected.timestamp === "number" ? selected.timestamp : Date.now();
    const toolResults = Array.isArray(selected.toolResults)
      ? selected.toolResults.map((block) => extensionToolResultBlock(block as ToolResultBlock, { timestamp }))
      : [];
    return [{ ...selected, message: extensionMessage(selected.message as CanonicalMessage), toolResults }];
  },
  message_start(selected) {
    if (directEventRecord(selected.message) === undefined) return [selected];
    return extensionMessages(selected.message as CanonicalMessage).map((message) => ({ ...selected, message }));
  },
  message_end(selected) {
    if (directEventRecord(selected.message) === undefined) return [selected];
    return extensionMessages(selected.message as CanonicalMessage).map((message) => ({ ...selected, message }));
  },
  message_update(selected) {
    if (directEventRecord(selected.message) === undefined) return [selected];
    const assistantEvent = directEventRecord(selected.assistantMessageEvent);
    if (
      assistantEvent?.visibility === "provider_trace"
      && (
        assistantEvent.type === "reasoning_started"
        || assistantEvent.type === "reasoning_delta"
        || assistantEvent.type === "reasoning_completed"
      )
    ) return [];
    const message = selected.message as CanonicalMessage;
    return [{
      ...selected,
      message: extensionMessage(message),
      assistantMessageEvent: extensionAssistantEvent(selected.assistantMessageEvent, message),
    }];
  },
  before_agent_start(selected) {
    if (!Array.isArray(selected.images)) return [selected];
    return [{ ...selected, images: extensionContent(selected.images as ImageBlock[]) }];
  },
  session_tree(selected) {
    if (directEventRecord(selected.summaryEntry) === undefined) return [selected];
    return [{ ...selected, summaryEntry: extensionSessionEntry(selected.summaryEntry as SessionEntry) }];
  },
  session_compact(selected) {
    if (directEventRecord(selected.compactionEntry) === undefined) return [selected];
    return [{ ...selected, compactionEntry: extensionSessionEntry(selected.compactionEntry as SessionEntry) }];
  },
} satisfies Partial<Record<RuntimeExtensionEvent, DirectEventProjector>>;

export function directDispatchEvents(event: RuntimeExtensionEvent, value: unknown): unknown[] {
  const selected = directEventRecord(value);
  if (selected === undefined) return [value];
  const projector = (EVENT_PROJECTORS as Partial<Record<RuntimeExtensionEvent, DirectEventProjector>>)[event];
  return projector?.(selected) ?? [value];
}

export interface RuntimeRequesterSession {
  threadId: string;
  branch?: string;
  runId?: string;
  step?: number;
}

export function runtimeRequesterSession(
  event: RuntimeExtensionEvent,
  value: unknown,
): RuntimeRequesterSession | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const selected = value as {
    threadId?: unknown;
    sourceThreadId?: unknown;
    targetThreadId?: unknown;
    branch?: unknown;
    targetBranch?: unknown;
    runId?: unknown;
    step?: unknown;
  };
  const threadId = event === "session_before_fork"
    ? selected.targetThreadId ?? selected.sourceThreadId
    : REQUESTER_THREAD_EVENTS.has(event) ? selected.threadId : undefined;
  if (typeof threadId !== "string") return undefined;
  const branch = event === "session_before_fork" ? selected.targetBranch : selected.branch;
  return {
    threadId,
    ...(typeof branch === "string" ? { branch } : {}),
    ...(typeof selected.runId === "string" ? { runId: selected.runId } : {}),
    ...(Number.isSafeInteger(selected.step) && (selected.step as number) > 0 ? { step: selected.step as number } : {}),
  };
}
