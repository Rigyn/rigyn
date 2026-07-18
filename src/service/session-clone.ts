import type { RuntimeEvent } from "../core/events.js";
import { createId } from "../core/ids.js";
import type { ContentBlock, ProviderId } from "../core/types.js";
import { SessionStore } from "../storage/store.js";
import type { ThreadRecord } from "../storage/types.js";

export interface CloneSessionPathInput {
  threadId: string;
  /** Host-reserved destination identity when lifecycle must begin before the clone is committed. */
  targetThreadId?: string;
  branch?: string;
  atEventId?: string | null;
  beforeEventId?: string;
  name?: string;
  workspaceRoot: string;
}

export interface CloneSessionPathResult {
  thread: ThreadRecord;
  sourceBranch: string;
  sourceEventId?: string;
  events: number;
  artifacts: number;
  provider?: ProviderId;
  model?: string;
}

function copiedName(source: ThreadRecord, requested: string | undefined): string | undefined {
  const value = requested?.trim() || (source.name === undefined ? undefined : `${source.name} (copy)`);
  if (value === undefined) return undefined;
  return value.length <= 200 ? value : `${value.slice(0, 199)}…`;
}

function rewriteBlocks(blocks: readonly ContentBlock[], artifactIds: ReadonlyMap<string, string>): ContentBlock[] {
  return blocks.map((block) => {
    if (block.type !== "tool_result" || block.artifactIds === undefined) return block;
    return {
      ...block,
      artifactIds: block.artifactIds.flatMap((id) => {
        const mapped = artifactIds.get(id);
        return mapped === undefined ? [] : [mapped];
      }),
    };
  });
}

function cloneEvent(event: RuntimeEvent, artifactIds: ReadonlyMap<string, string>): RuntimeEvent {
  if (event.type === "message_appended") {
    return {
      ...event,
      message: { ...event.message, content: rewriteBlocks(event.message.content, artifactIds) },
    };
  }
  if (event.type === "branch_summary_created") {
    return { type: "message_appended", message: event.summary };
  }
  if (event.type === "tool_completed" && event.result !== undefined) {
    const [result] = rewriteBlocks([event.result], artifactIds);
    return { ...event, ...(result?.type === "tool_result" ? { result } : {}) };
  }
  return event;
}

function eventArtifactIds(event: RuntimeEvent): string[] {
  if (event.type === "message_appended") {
    return event.message.content.flatMap((block) => block.type === "tool_result" ? block.artifactIds ?? [] : []);
  }
  if (event.type === "tool_completed" && event.result !== undefined) return event.result.artifactIds ?? [];
  return [];
}

function terminalRun(state: string): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

/**
 * Copies one reachable session path into a new durable session. Runtime event,
 * run, event, and artifact identifiers are remapped; canonical message IDs are
 * retained so compaction references and provider continuation state stay valid.
 */
export function cloneSessionPath(store: SessionStore, input: CloneSessionPathInput): CloneSessionPathResult {
  if (input.atEventId !== undefined && input.beforeEventId !== undefined) {
    throw new Error("Choose either atEventId or beforeEventId, not both");
  }
  const source = store.getThread(input.threadId);
  const sourceBranch = input.branch ?? source.defaultBranch;
  const sourceEvents = store.listEvents(input.threadId, sourceBranch);
  let selected = sourceEvents;
  if (input.atEventId === null) {
    selected = [];
  } else if (input.atEventId !== undefined) {
    const index = sourceEvents.findIndex((entry) => entry.eventId === input.atEventId);
    if (index < 0) throw new Error(`Event ${input.atEventId} is not on session path ${input.threadId}:${sourceBranch}`);
    selected = sourceEvents.slice(0, index + 1);
  } else if (input.beforeEventId !== undefined) {
    const index = sourceEvents.findIndex((entry) => entry.eventId === input.beforeEventId);
    if (index < 0) throw new Error(`Event ${input.beforeEventId} is not on session path ${input.threadId}:${sourceBranch}`);
    selected = sourceEvents.slice(0, index);
  }

  selected = selected.filter((entry) => entry.event.type !== "entry_label_changed");
  const selectedEventIds = new Set(selected.map((entry) => entry.eventId));
  const selectedRunIds = new Set(selected.flatMap((entry) => entry.runId === undefined ? [] : [entry.runId]));
  const referencedArtifactIds = new Set(selected.flatMap((entry) => eventArtifactIds(entry.event)));
  const sourceArtifacts = store.listArtifacts(input.threadId).filter((artifact) =>
    (referencedArtifactIds.has(artifact.artifactId) || (artifact.eventId !== undefined && selectedEventIds.has(artifact.eventId))) &&
    (artifact.runId === undefined || selectedRunIds.has(artifact.runId)));
  const artifactIds = new Map(sourceArtifacts.map((artifact) => [artifact.artifactId, createId("artifact")]));
  const runIds = new Map<string, string>();
  const eventIds = new Map<string, string>();
  const lastSource = selected.at(-1);
  const name = copiedName(source, input.name);
  const thread = store.createThread({
    ...(input.targetThreadId === undefined ? {} : { threadId: input.targetThreadId }),
    workspaceRoot: input.workspaceRoot,
    parentThreadId: input.threadId,
    ...(lastSource?.runId === undefined ? {} : { parentRunId: lastSource.runId }),
    ...(name === undefined ? {} : { name }),
  });

  let currentHead: string | null = null;
  let latestModel: { provider: ProviderId; model: string } | undefined;
  try {
    for (const envelope of selected) {
      let runId: string | undefined;
      if (envelope.event.type === "model_selected") {
        latestModel = { provider: envelope.event.provider, model: envelope.event.model };
      }
      if (envelope.runId !== undefined) {
        runId = runIds.get(envelope.runId);
        if (envelope.event.type === "run_started") {
          if (runId !== undefined) throw new Error(`Run ${envelope.runId} starts more than once on the source path`);
          runId = createId("run");
          runIds.set(envelope.runId, runId);
          store.startRun({
            threadId: thread.threadId,
            runId,
            provider: envelope.event.provider,
            model: envelope.event.model,
          });
          latestModel = { provider: envelope.event.provider, model: envelope.event.model };
        } else if (runId === undefined) {
          throw new Error(`Run ${envelope.runId} is referenced before it starts on the source path`);
        }
      }
      const eventId = createId("event");
      store.appendEvent({
        threadId: thread.threadId,
        ...(runId === undefined ? {} : { runId }),
        eventId,
        timestamp: envelope.timestamp,
        expectedHead: currentHead,
        event: cloneEvent(envelope.event, artifactIds),
      });
      eventIds.set(envelope.eventId, eventId);
      currentHead = eventId;
    }

    const lastRunId = lastSource?.runId === undefined ? undefined : runIds.get(lastSource.runId);
    if (lastRunId !== undefined) {
      const run = store.getRun(lastRunId);
      if (!terminalRun(run.state)) {
        const event = store.appendEvent({
          threadId: thread.threadId,
          runId: lastRunId,
          expectedHead: currentHead,
          event: { type: "run_cancelled", reason: "Session copied from this point" },
        });
        currentHead = event.eventId;
      }
    }

    let copiedLabels = 0;
    for (const label of store.listEntryLabels(input.threadId)) {
      const targetEventId = eventIds.get(label.targetEventId);
      if (targetEventId === undefined) continue;
      const changed = store.setEntryLabel({
        threadId: thread.threadId,
        targetEventId,
        label: label.label,
      });
      currentHead = changed.eventId;
      copiedLabels += 1;
    }

    for (const artifact of sourceArtifacts) {
      const artifactId = artifactIds.get(artifact.artifactId);
      if (artifactId === undefined) continue;
      const runId = artifact.runId === undefined ? undefined : runIds.get(artifact.runId);
      const eventId = artifact.eventId === undefined ? undefined : eventIds.get(artifact.eventId);
      store.putArtifact({
        threadId: thread.threadId,
        artifactId,
        content: artifact.content,
        mediaType: artifact.mediaType,
        ...(runId === undefined ? {} : { runId }),
        ...(eventId === undefined ? {} : { eventId }),
      });
    }

    return {
      thread: store.getThread(thread.threadId),
      sourceBranch,
      ...(lastSource === undefined ? {} : { sourceEventId: lastSource.eventId }),
      events: selected.length + copiedLabels,
      artifacts: sourceArtifacts.length,
      ...(latestModel === undefined ? {} : latestModel),
    };
  } catch (error) {
    for (const runId of runIds.values()) {
      try {
        const run = store.getRun(runId);
        if (!terminalRun(run.state)) {
          store.appendEvent({
            threadId: thread.threadId,
            runId,
            event: { type: "run_cancelled", reason: "Session copy failed" },
          });
        }
      } catch {}
    }
    try {
      store.deleteThread(thread.threadId);
    } catch {}
    throw error;
  }
}
