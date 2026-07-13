import type { SessionStore } from "../storage/store.js";
import type { EventEnvelope, RuntimeEvent } from "../core/events.js";

export interface SessionTreeRow {
  eventId: string;
  parentEventId?: string;
  sourceBranch: string;
  kind: "user" | "assistant" | "tool" | "extension" | "compaction" | "branch_summary" | "warning" | "failed" | "cancelled";
  restoreText?: string;
  rewindEventId?: string | null;
  text: string;
  timestamp: string;
  depth: number;
  branches: string[];
  paths: string[];
  active: boolean;
  label?: string;
  labelTimestamp?: string;
  prefix: string;
}

interface Node {
  eventId: string;
  text: string;
  timestamp: string;
  sequence: number;
  parents: Set<string>;
  children: Set<string>;
  branches: Set<string>;
  paths: Set<string>;
  parentEventId?: string;
  kind: SessionTreeRow["kind"];
  restoreText?: string;
  rewindEventId?: string | null;
}

function preview(value: string, fallback: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized === "") return fallback;
  return normalized.length > 100 ? `${normalized.slice(0, 99)}…` : normalized;
}

function messageText(event: Extract<RuntimeEvent, { type: "message_appended" }>): string {
  if (event.message.displayText !== undefined) return event.message.displayText;
  return event.message.content.flatMap((block) => {
    if (block.type === "text") return [block.text];
    if (block.type === "tool_result") return [block.content];
    return [];
  }).join(" ");
}

function treeEntry(envelope: EventEnvelope): Pick<Node, "kind" | "text" | "restoreText"> | undefined {
  const event = envelope.event;
  if (event.type === "message_appended") {
    const text = messageText(event);
    if (event.message.role === "user") return { kind: "user", text: preview(text, "User message"), restoreText: text };
    if (event.message.role === "assistant") {
      if (text.trim() === "") return undefined;
      return { kind: "assistant", text: preview(`assistant: ${text}`, "Assistant message") };
    }
    if (event.message.role === "tool") return { kind: "tool", text: preview(`tool: ${text}`, "Tool result") };
    return undefined;
  }
  if (event.type === "compaction_completed") {
    const text = event.summary.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(" ");
    return { kind: "compaction", text: preview(`compaction: ${text}`, "Compaction summary") };
  }
  if (event.type === "branch_summary_created") {
    const text = event.summary.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(" ");
    return { kind: "branch_summary", text: preview(`branch summary: ${text}`, "Branch summary") };
  }
  if (event.type === "extension_message" && event.transcript !== false) {
    return {
      kind: "extension",
      text: preview(`${event.extensionId}/${event.kind}: ${event.transcript.text}`, "Extension message"),
    };
  }
  if (event.type === "warning") return { kind: "warning", text: preview(`warning: ${event.message}`, "Warning") };
  if (event.type === "run_failed") return { kind: "failed", text: preview(`failed: ${event.error.message}`, "Run failed") };
  if (event.type === "run_cancelled") return { kind: "cancelled", text: preview(`cancelled: ${event.reason}`, "Run cancelled") };
  return undefined;
}

/** Builds a deterministic visual tree of meaningful conversation entries across every branch. */
export function buildSessionTree(
  store: SessionStore,
  threadId: string,
  activeBranch?: string,
): SessionTreeRow[] {
  const thread = store.getThread(threadId);
  const selectedBranch = activeBranch ?? thread.defaultBranch;
  const labels = new Map(store.listEntryLabels(threadId).map((record) => [record.targetEventId, record]));
  const nodes = new Map<string, Node>();
  const roots = new Set<string>();

  for (const branch of thread.branches) {
    let parent: string | undefined;
    const events = store.listEvents(threadId, branch.name);
    for (const [index, envelope] of events.entries()) {
      const entry = treeEntry(envelope);
      if (entry === undefined) continue;
      let node = nodes.get(envelope.eventId);
      if (node === undefined) {
        node = {
          eventId: envelope.eventId,
          text: entry.text,
          timestamp: envelope.timestamp,
          sequence: envelope.sequence,
          parents: new Set(),
          children: new Set(),
          branches: new Set(),
          paths: new Set(),
          ...(envelope.parentEventId === undefined ? {} : { parentEventId: envelope.parentEventId }),
          kind: entry.kind,
          ...(entry.restoreText === undefined ? {} : { restoreText: entry.restoreText }),
          ...(entry.kind !== "user"
            ? {}
            : {
                rewindEventId: (() => {
                  if (envelope.runId === undefined) return envelope.parentEventId ?? null;
                  let first = index;
                  while (first > 0 && events[first - 1]?.runId === envelope.runId) first -= 1;
                  return events[first]?.parentEventId ?? null;
                })(),
              }),
        };
        nodes.set(envelope.eventId, node);
      }
      node.paths.add(branch.name);
      if (parent === undefined) roots.add(node.eventId);
      else {
        node.parents.add(parent);
        nodes.get(parent)?.children.add(node.eventId);
      }
      parent = node.eventId;
    }
    if (parent !== undefined) nodes.get(parent)?.branches.add(branch.name);
  }

  const ordered = (values: Iterable<string>): Node[] => [...values]
    .flatMap((id) => {
      const node = nodes.get(id);
      return node === undefined ? [] : [node];
    })
    .sort((left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId));
  const rows: SessionTreeRow[] = [];
  const visited = new Set<string>();
  const walk = (node: Node, ancestorsLast: boolean[], last: boolean): void => {
    if (visited.has(node.eventId)) return;
    visited.add(node.eventId);
    const prefix = ancestorsLast.map((isLast) => isLast ? "   " : "│  ").join("") + (last ? "└─ " : "├─ ");
    const branches = [...node.branches].sort();
    const paths = [...node.paths].sort();
    const sourceBranch = paths.includes(selectedBranch) ? selectedBranch : paths[0]!;
    const label = labels.get(node.eventId);
    rows.push({
      eventId: node.eventId,
      ...(node.parentEventId === undefined ? {} : { parentEventId: node.parentEventId }),
      sourceBranch,
      kind: node.kind,
      ...(node.restoreText === undefined ? {} : { restoreText: node.restoreText }),
      ...(node.rewindEventId === undefined ? {} : { rewindEventId: node.rewindEventId }),
      text: node.text,
      timestamp: node.timestamp,
      depth: ancestorsLast.length,
      branches,
      paths,
      active: paths.includes(selectedBranch),
      ...(label === undefined ? {} : { label: label.label, labelTimestamp: label.changedAt }),
      prefix,
    });
    const children = ordered(node.children);
    children.forEach((child, index) => walk(child, [...ancestorsLast, last], index === children.length - 1));
  };
  const rootNodes = ordered(roots);
  rootNodes.forEach((root, index) => walk(root, [], index === rootNodes.length - 1));
  for (const orphan of ordered([...nodes.keys()].filter((id) => !visited.has(id)))) walk(orphan, [], true);
  return rows;
}
