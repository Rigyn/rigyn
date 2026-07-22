import type { PickerItem, SessionTreeMetadata } from "../tui/types.js";
import type { PersistedSessionMessage, SessionEntry, SessionTreeNode } from "../storage/types.js";

const MAX_PREVIEW_CHARACTERS = 500;

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    if (block === null || typeof block !== "object") return [];
    const value = block as { type?: unknown; text?: unknown; name?: unknown };
    if (value.type === "text" && typeof value.text === "string") return [value.text];
    if ((value.type === "tool_call" || value.type === "toolCall") && typeof value.name === "string") {
      return [`[tool: ${value.name}]`];
    }
    return [];
  }).join(" ");
}

function compactPreview(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= MAX_PREVIEW_CHARACTERS) return normalized;
  return `${normalized.slice(0, MAX_PREVIEW_CHARACTERS - 1)}…`;
}

function messagePreview(message: PersistedSessionMessage): { kind: string; text: string } {
  if (message.role === "bashExecution") {
    return { kind: "bash", text: compactPreview(message.command) || "Shell command" };
  }
  if (message.role === "custom") {
    return { kind: "custom", text: compactPreview(contentText(message.content)) || message.customType };
  }
  const role = typeof (message as { role?: unknown }).role === "string"
    ? String((message as { role: string }).role)
    : "message";
  const text = compactPreview(contentText((message as { content?: unknown }).content));
  return { kind: role === "toolResult" ? "tool" : role, text: text || `${role} message` };
}

export function sessionEntryPreview(entry: SessionEntry): { kind: string; text: string } {
  if (entry.type === "message") return messagePreview(entry.message);
  if (entry.type === "custom_message") {
    return { kind: "custom", text: compactPreview(contentText(entry.content)) || entry.customType };
  }
  if (entry.type === "compaction") {
    return { kind: "compaction", text: compactPreview(entry.summary) || "Context compaction" };
  }
  if (entry.type === "branch_summary") {
    return { kind: "branch_summary", text: compactPreview(entry.summary) || "Branch summary" };
  }
  if (entry.type === "model_change") return { kind: "model", text: `${entry.provider}/${entry.modelId}` };
  if (entry.type === "thinking_level_change") return { kind: "thinking", text: `Thinking: ${entry.thinkingLevel}` };
  if (entry.type === "label") return { kind: "label", text: entry.label ? `Label: ${entry.label}` : "Label cleared" };
  if (entry.type === "session_info") return { kind: "session", text: entry.name ? `Session: ${entry.name}` : "Session metadata" };
  return { kind: entry.type, text: entry.type };
}

interface TreeFrame {
  node: SessionTreeNode;
  depth: number;
  isLast: boolean;
  ancestorLast: boolean[];
}

/** Build bounded, display-only rows without recursing through deep session trees. */
export function sessionTreePickerItems(
  roots: readonly SessionTreeNode[],
  activeEntryIds: ReadonlySet<string>,
): Array<PickerItem<string> & { tree: SessionTreeMetadata }> {
  const rows: Array<PickerItem<string> & { tree: SessionTreeMetadata }> = [];
  const stack: TreeFrame[] = [];
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    stack.push({ node: roots[index]!, depth: 0, isLast: index === roots.length - 1, ancestorLast: [] });
  }

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { entry, children } = frame.node;
    const preview = sessionEntryPreview(entry);
    const prefix = `${frame.ancestorLast.map((last) => last ? "   " : "│  ").join("")}${frame.isLast ? "└─ " : "├─ "}`;
    rows.push({
      id: entry.id,
      label: preview.text,
      detail: `${preview.kind} · ${entry.timestamp}`,
      keywords: [entry.id, entry.type, preview.kind],
      value: entry.id,
      tree: {
        eventId: entry.id,
        ...(entry.parentId === null ? {} : { parentEventId: entry.parentId }),
        kind: preview.kind,
        depth: frame.depth,
        prefix,
        branches: children.length > 1 ? children.map((child) => child.entry.id) : [],
        paths: [activeEntryIds.has(entry.id) ? "active" : "alternate"],
        active: activeEntryIds.has(entry.id),
        ...(frame.node.label === undefined ? {} : { label: frame.node.label }),
        ...(frame.node.labelTimestamp === undefined ? {} : { labelTimestamp: frame.node.labelTimestamp }),
      },
    });

    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({
        node: children[index]!,
        depth: frame.depth + 1,
        isLast: index === children.length - 1,
        ancestorLast: [...frame.ancestorLast, frame.isLast],
      });
    }
  }
  return rows;
}
