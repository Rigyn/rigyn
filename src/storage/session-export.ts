import type { EventEnvelope, RuntimeEvent } from "../core/events.js";
import type { CanonicalMessage } from "../core/types.js";
import type { ArtifactRecord, RunRecord, ThreadRecord } from "./types.js";

export const SESSION_EXPORT_FORMAT = "rigyn/session-jsonl";
export const SESSION_EXPORT_SCHEMA_VERSION = 2;

export interface SessionExportFormatRecord {
  type: "format";
  value: {
    format: typeof SESSION_EXPORT_FORMAT;
    schemaVersion: typeof SESSION_EXPORT_SCHEMA_VERSION;
  };
}

export interface SessionExportThreadRecord {
  type: "thread";
  value: ThreadRecord;
}

export interface SessionExportRunRecord {
  type: "run";
  value: RunRecord;
}

export interface SessionExportEventRecord {
  type: "event";
  branch: string;
  branchIncarnation: number;
  value: EventEnvelope;
}

export interface SessionExportArtifactRecord {
  type: "artifact";
  value: Omit<ArtifactRecord, "content"> & { content: string };
}

export type SessionExportRecord =
  | SessionExportFormatRecord
  | SessionExportThreadRecord
  | SessionExportRunRecord
  | SessionExportEventRecord
  | SessionExportArtifactRecord;

export function sessionExportFormatRecord(): SessionExportFormatRecord {
  return {
    type: "format",
    value: {
      format: SESSION_EXPORT_FORMAT,
      schemaVersion: SESSION_EXPORT_SCHEMA_VERSION,
    },
  };
}

/** Removes provider-private execution material while preserving event ancestry. */
export function sessionExportEvent(event: RuntimeEvent): RuntimeEvent {
  if (event.type === "message_appended") {
    return { type: "message_appended", message: sessionExportMessage(event.message) };
  }
  if (event.type === "compaction_completed") {
    return { ...event, summary: sessionExportMessage(event.summary) };
  }
  if (event.type === "branch_summary_created") {
    return { ...event, summary: sessionExportMessage(event.summary) };
  }
  if (event.type === "reasoning_delta" && event.visibility === "provider_trace") {
    return {
      type: "warning",
      code: "session_export_private_event_omitted",
      message: "Provider-private reasoning trace omitted from session export",
    };
  }
  if (event.type === "provider_response_started") {
    return { type: "provider_response_started", step: event.step, model: event.model };
  }
  if (event.type === "usage" && event.usage.raw !== undefined) {
    const { raw: _raw, ...usage } = event.usage;
    return { ...event, usage };
  }
  if (event.type === "run_failed" && "retryable" in event.error) {
    const { raw: _raw, requestId: _requestId, diagnostics: _diagnostics, ...error } = event.error;
    return { ...event, error };
  }
  if (event.type === "warning" && event.details !== undefined) {
    return { type: "warning", code: event.code, message: event.message };
  }
  return event;
}

/** Removes opaque provider-owned content while retaining portable visible blocks. */
export function sessionExportMessage(message: CanonicalMessage): CanonicalMessage {
  return {
    ...message,
    content: message.content.filter((block) => block.type !== "provider_opaque"),
  };
}

export function sessionExportEnvelope(envelope: EventEnvelope): EventEnvelope {
  return { ...envelope, event: sessionExportEvent(envelope.event) };
}
