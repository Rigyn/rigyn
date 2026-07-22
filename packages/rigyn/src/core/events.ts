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

export const MAX_TOOL_CALL_STREAM_ID_BYTES = 1_024;
export const MAX_TOOL_CALL_STREAM_NAME_BYTES = 256;
export const MAX_TOOL_CALL_STREAM_DELTA_BYTES = 4 * 1024 * 1024;
export const MAX_TOOL_CALL_STREAM_PARSE_ERROR_BYTES = 4 * 1024;

export type RunState =
  | "preparing"
  | "streaming"
  | "tool_planning"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled";

export type AssistantResponseTransformationField =
  | "message"
  | "finishReason"
  | "usage"
  | "rawReason"
  | "explanation";

export interface AssistantResponseTransformationAudit {
  actor: string;
  fields: AssistantResponseTransformationField[];
}

/** Secret-free accounting snapshot recorded around an extension-owned final response transformation. */
export interface AssistantResponseAuditSnapshot {
  finishReason: FinishReason;
  usage?: Omit<NormalizedUsage, "raw">;
}

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
  | { type: "text_started"; part: number }
  | { type: "text_delta"; text: string; part: number }
  | { type: "text_completed"; text: string; part: number; textSignature?: string }
  | { type: "reasoning_started"; part: number; visibility: "summary" | "provider_trace" }
  | { type: "reasoning_delta"; text: string; part: number; visibility: "summary" | "provider_trace" }
  | {
      type: "reasoning_completed";
      text: string;
      part: number;
      visibility: "summary" | "provider_trace";
      thinkingSignature?: string;
      redacted?: boolean;
    }
  | { type: "tool_call_started"; index: number; id?: string; name?: string }
  | { type: "tool_call_delta"; index: number; jsonFragment: string }
  | {
      type: "tool_call_completed";
      index: number;
      name: string;
      rawArguments: string;
      id?: string;
      arguments?: JsonValue;
      parseError?: string;
      thoughtSignature?: string;
    }
  | { type: "assistant_completed"; finishReason: FinishReason; rawReason?: string; explanation?: string }
  | {
      type: "assistant_response_transformed";
      step: number;
      transformations: AssistantResponseTransformationAudit[];
      original: AssistantResponseAuditSnapshot;
      final: AssistantResponseAuditSnapshot;
    }
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
  | {
      type: "retry_scheduled";
      /** One-based provider attempt that will run after the delay. */
      attempt: number;
      delayMs: number;
      category: string;
      errorMessage?: string;
      /** Number of retries after the initial provider attempt. */
      maxAttempts?: number;
      phase?: "model" | "compaction";
    }
  | { type: "retry_attempt_started"; attempt: number; provider: ProviderId; model: string; step: number }
  | {
      type: "summarization_retry_scheduled";
      /** One-based retry number after the initial summarization attempt. */
      attempt: number;
      /** Number of retries allowed after the initial summarization attempt. */
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | { type: "summarization_retry_attempt_start"; source: "branchSummary" }
  | {
      type: "summarization_retry_attempt_start";
      source: "compaction";
      reason: "manual" | "threshold" | "overflow";
    }
  | { type: "summarization_retry_finished" }
  | {
      type: "compaction_started";
      reason?: "manual" | "threshold" | "overflow";
      willRetry?: boolean;
    }
  | {
      type: "compaction_completed";
      summary: CanonicalMessage;
      sourceMessageIds: string[];
      firstKeptMessageId: string;
      tokensBefore: number;
      estimatedTokensAfter?: number;
      reason?: "manual" | "threshold" | "overflow";
      willRetry?: boolean;
      fromExtension: boolean;
      usage?: NormalizedUsage;
      extensionMetadata?: JsonValue;
    }
  | {
      type: "compaction_failed";
      reason: "manual" | "threshold" | "overflow";
      aborted: boolean;
      willRetry: false;
      errorMessage?: string;
    }
  | {
      type: "branch_summary_created";
      summary: CanonicalMessage;
      sourceBranch: string;
      sourceEventIds: EventId[];
      usage?: NormalizedUsage;
      extensionMetadata?: JsonValue;
    }
  | { type: "entry_label_changed"; targetEventId: EventId; label?: string }
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
