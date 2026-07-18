import type { JsonValue } from "./json.js";
import type { EventId, RunId, ThreadId } from "./ids.js";
import type {
  AdapterError,
  CanonicalMessage,
  FinishReason,
  NormalizedUsage,
  PromptCompositionMetadata,
  ProviderId,
  ProviderState,
  ToolResultBlock,
} from "./types.js";
import type { ExtensionMessageEvent, ExtensionStateEvent } from "./extension-entries.js";

export type RunState =
  | "preparing"
  | "streaming"
  | "tool_planning"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled";

/** Bounded process output produced while one tool invocation is running. */
export interface ToolProgress {
  type: "output";
  stream: "stdout" | "stderr";
  delta: string;
  stdoutBytes: number;
  stderrBytes: number;
  /** Wall-clock time since the command started. Empty deltas are quiet-command heartbeats. */
  elapsedMs?: number;
  truncated?: boolean;
}

/** A bounded, replaceable partial tool result for native extension rendering. */
export interface ToolResultProgress {
  type: "result";
  content: string;
  isError: boolean;
  metadata?: JsonValue;
  truncated?: boolean;
}

/** A bounded update produced while one tool invocation is running. */
export type ToolUpdate = ToolProgress | ToolResultProgress;

export type RuntimeEvent =
  | {
      type: "run_started";
      provider: ProviderId;
      model: string;
      reasoningEffort?: string;
      promptComposition?: PromptCompositionMetadata;
    }
  | { type: "model_selected"; provider: ProviderId; model: string; reasoningEffort?: string }
  | { type: "run_state"; state: RunState }
  | {
      type: "message_appended";
      message: CanonicalMessage;
      providerState?: ProviderState;
      providerStateSerialized?: string;
      toolDefinitionFingerprint?: string;
    }
  | { type: "assistant_started"; step: number }
  | {
      type: "provider_response_started";
      step: number;
      model: string;
      responseId?: string;
      requestId?: string;
    }
  | { type: "text_delta"; text: string; part: number }
  | { type: "reasoning_delta"; text: string; part: number; visibility: "summary" | "provider_trace" }
  | { type: "assistant_completed"; finishReason: FinishReason; rawReason?: string }
  | { type: "tool_input_transformed"; callId: string; name: string; index: number; actors: string[] }
  | { type: "tool_requested"; callId: string; name: string; input: JsonValue; index: number }
  | { type: "tool_started"; callId: string; name: string; index: number }
  | {
      type: "tool_progress";
      callId: string;
      name: string;
      index: number;
      sequence: number;
      progress: ToolUpdate;
    }
  | {
      type: "tool_completed";
      callId: string;
      name: string;
      index: number;
      isError: boolean;
      preview: string;
      result?: ToolResultBlock;
    }
  | { type: "tool_in_doubt"; callId: string; name: string; index: number; reason: string }
  | { type: "usage"; usage: NormalizedUsage; semantics: "incremental" | "cumulative" | "final" }
  | { type: "retry_scheduled"; attempt: number; delayMs: number; category: string }
  | { type: "compaction_started" }
  | { type: "compaction_completed"; summary: CanonicalMessage; sourceMessageIds: string[]; extensionMetadata?: JsonValue }
  | {
      type: "branch_summary_created";
      summary: CanonicalMessage;
      sourceBranch: string;
      sourceEventIds: EventId[];
      extensionMetadata?: JsonValue;
    }
  | { type: "entry_label_changed"; targetEventId: EventId; label?: string }
  | ExtensionStateEvent
  | ExtensionMessageEvent
  | { type: "steering_queued" }
  | { type: "run_completed"; finishReason: FinishReason }
  | { type: "run_failed"; error: AdapterError | { category: "internal"; message: string } }
  | { type: "run_cancelled"; reason: string }
  | { type: "warning"; code: string; message: string; details?: JsonValue };

export interface EventEnvelope<T extends RuntimeEvent = RuntimeEvent> {
  eventId: EventId;
  threadId: ThreadId;
  runId?: RunId;
  parentEventId?: EventId;
  sequence: number;
  timestamp: string;
  schemaVersion: 1;
  event: T;
}

export interface EventSink {
  emit(event: RuntimeEvent): Promise<EventEnvelope>;
}
