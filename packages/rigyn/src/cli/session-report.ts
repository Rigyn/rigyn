import type { EventEnvelope } from "../core/events.js";
import type { SessionContext, SessionInfo } from "../storage/types.js";

export function formatPromptContextReport(events: readonly EventEnvelope[]): string {
  const messages = events.filter((entry) => entry.event.type === "message_appended").length;
  const compactions = events.filter((entry) => entry.event.type === "compaction_completed").length;
  return [`Context events: ${events.length}`, `Messages: ${messages}`, `Compactions: ${compactions}`].join("\n");
}

export function formatSessionReport(input: { session: SessionInfo; context?: SessionContext }): string {
  const { session } = input;
  return [
    `Session: ${session.name ?? session.id}`,
    `File: ${session.path}`,
    `Workspace: ${session.cwd}`,
    `Messages: ${session.messageCount}`,
    `Created: ${session.created.toISOString()}`,
    `Updated: ${session.modified.toISOString()}`,
    ...(input.context?.model === null || input.context?.model === undefined
      ? []
      : [`Model: ${input.context.model.provider}/${input.context.model.modelId}`]),
  ].join("\n");
}
