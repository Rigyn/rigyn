import type { PickerItem } from "./types.js";

export interface SessionTreePickerOptions {
  query: string;
  activeOnly: boolean;
  folded: ReadonlySet<string>;
  unicode: boolean;
  filter?: SessionTreeFilterMode;
  showLabelTimestamps?: boolean;
}

export type SessionTreeFilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

export const SESSION_TREE_FILTER_MODES: readonly SessionTreeFilterMode[] = [
  "default", "no-tools", "user-only", "labeled-only", "all",
];

function treeText(item: PickerItem): string {
  const tree = item.tree;
  return [
    item.label,
    item.detail,
    ...(item.keywords ?? []),
    tree?.kind,
    ...(tree?.branches ?? []),
    ...(tree?.paths ?? []),
    tree?.label,
  ].filter((value): value is string => typeof value === "string").join(" ").toLowerCase();
}

function displayPrefix(prefix: string, unicode: boolean): string {
  if (unicode) return prefix;
  return prefix.replaceAll("│", "|").replaceAll("├", "|").replaceAll("└", "\\").replaceAll("─", "-");
}

const BOOKKEEPING_KINDS = new Set(["label", "custom", "model", "thinking", "session"]);

function isBookkeepingKind(kind: string): boolean {
  return BOOKKEEPING_KINDS.has(kind);
}

export function buildSessionTreePickerRows<T>(
  source: readonly PickerItem<T>[],
  options: SessionTreePickerOptions,
): PickerItem<T>[] {
  const tokens = options.query.toLowerCase().split(/\s+/u).filter(Boolean);
  const hiddenAtDepth: number[] = [];
  const candidates: Array<{ item: PickerItem<T>; folded: boolean; rawFoldable: boolean }> = [];
  const filter = options.filter ?? "default";
  const sourceById = new Map(source.flatMap((item) => item.tree === undefined
    ? []
    : [[item.tree.eventId, item.tree] as const]));
  const sourceParent = new Map<string, string | undefined>();
  const ancestry: Array<{ eventId: string; depth: number }> = [];
  for (const item of source) {
    const tree = item.tree;
    if (tree === undefined || tree.kind === "navigation") continue;
    while (ancestry.length > 0 && ancestry.at(-1)!.depth >= tree.depth) ancestry.pop();
    sourceParent.set(tree.eventId, tree.parentEventId ?? ancestry.at(-1)?.eventId);
    ancestry.push({ eventId: tree.eventId, depth: tree.depth });
  }
  const activeParents = new Set(source.flatMap((item) => {
    const tree = item.tree;
    const parent = tree === undefined ? undefined : sourceParent.get(tree.eventId);
    return tree?.active === true && parent !== undefined ? [parent] : [];
  }));

  for (const [index, item] of source.entries()) {
    const tree = item.tree;
    if (tree === undefined) continue;
    while (hiddenAtDepth.length > 0 && tree.depth <= hiddenAtDepth[hiddenAtDepth.length - 1]!) hiddenAtDepth.pop();
    const hidden = hiddenAtDepth.length > 0;
    const next = source[index + 1]?.tree;
    const foldable = next !== undefined && next.depth > tree.depth;
    const folded = options.folded.has(tree.eventId) && foldable;
    if (folded) hiddenAtDepth.push(tree.depth);
    const navigation = tree.kind === "navigation";
    if (hidden || (options.activeOnly && !tree.active && !navigation)) continue;
    const activeLeaf = tree.active && !activeParents.has(tree.eventId);
    if (!navigation && tree.kind === "tool_call" && !activeLeaf) continue;
    if (!navigation && filter === "default" && isBookkeepingKind(tree.kind)) continue;
    if (!navigation && filter === "no-tools" && (tree.kind === "tool" || isBookkeepingKind(tree.kind))) continue;
    if (!navigation && filter === "user-only" && tree.kind !== "user") continue;
    if (!navigation && filter === "labeled-only" && tree.label === undefined) continue;
    if (tokens.length > 0) {
      const text = treeText(item);
      if (!tokens.every((token) => text.includes(token))) continue;
    }
    candidates.push({ item, folded, rawFoldable: foldable });
  }

  const topology = candidates.filter(({ item }) => item.tree?.kind !== "navigation");
  const topologyIds = new Set(topology.map(({ item }) => item.tree!.eventId));
  const parentById = new Map<string, string | null>();
  const childrenByParent = new Map<string | null, string[]>([[null, []]]);
  const nearestTopologyParent = (eventId: string): string | null => {
    const visited = new Set<string>();
    let candidate = sourceParent.get(eventId);
    while (candidate !== undefined && !visited.has(candidate)) {
      if (topologyIds.has(candidate)) return candidate;
      visited.add(candidate);
      candidate = sourceParent.get(candidate);
    }
    return null;
  };
  for (const { item } of topology) {
    const tree = item.tree!;
    const parent = nearestTopologyParent(tree.eventId);
    parentById.set(tree.eventId, parent);
    const existingChildren = childrenByParent.get(parent);
    if (existingChildren === undefined) childrenByParent.set(parent, [tree.eventId]);
    else existingChildren.push(tree.eventId);
  }

  const visibleDepth = new Map<string, number>();
  for (const { item } of topology) {
    const tree = item.tree!;
    const parent = parentById.get(tree.eventId) ?? null;
    const directParent = sourceParent.get(tree.eventId);
    const parentOutsidePage = directParent === undefined
      ? tree.depth > 0
      : !sourceById.has(directParent);
    visibleDepth.set(
      tree.eventId,
      parent === null ? (parentOutsidePage ? tree.depth : 0) : (visibleDepth.get(parent) ?? 0) + 1,
    );
  }

  const prefixState = new Map<string, { segments: string[]; omitted: boolean }>();
  const visualPrefixes = new Map<string, string>();
  for (const { item } of topology) {
    const tree = item.tree!;
    const parent = parentById.get(tree.eventId) ?? null;
    let segments: string[];
    let omitted: boolean;
    if (parent === null) {
      const baseDepth = visibleDepth.get(tree.eventId) ?? 0;
      segments = Array.from({ length: Math.min(baseDepth, 12) }, () => "   ");
      omitted = baseDepth > 12;
    } else {
      const inherited = prefixState.get(parent) ?? { segments: [], omitted: false };
      const parentParent = parentById.get(parent) ?? null;
      const parentSiblings = childrenByParent.get(parentParent) ?? [];
      segments = [...inherited.segments, parentSiblings.at(-1) === parent ? "   " : "│  "];
      omitted = inherited.omitted || segments.length > 12;
      if (segments.length > 12) segments = segments.slice(-12);
    }
    prefixState.set(tree.eventId, { segments, omitted });
    const siblings = childrenByParent.get(parent) ?? [];
    const connector = siblings.at(-1) === tree.eventId ? "└─ " : "├─ ";
    visualPrefixes.set(tree.eventId, `${omitted ? "… " : ""}${segments.join("")}${connector}`);
  }

  return candidates.map(({ item, folded, rawFoldable }) => {
    const originalTree = item.tree!;
    const navigation = originalTree.kind === "navigation";
    const children = navigation ? [] : childrenByParent.get(originalTree.eventId) ?? [];
    const tree = navigation ? originalTree : {
      ...originalTree,
      depth: visibleDepth.get(originalTree.eventId) ?? originalTree.depth,
      prefix: visualPrefixes.get(originalTree.eventId) ?? originalTree.prefix,
    };
    const foldable = folded ? rawFoldable : children.length > 0;
    const active = tree.active ? options.unicode ? "● " : "* " : "  ";
    const fold = !foldable
      ? ""
      : folded
        ? options.unicode ? "⊞ " : "[+] "
        : options.unicode ? "⊟ " : "[-] ";
    const label = tree.label === undefined ? "" : `[${tree.label}] `;
    const timestamp = options.showLabelTimestamps === true && tree.labelTimestamp !== undefined
      ? `${tree.labelTimestamp.replace("T", " ").slice(0, 16)} `
      : "";
    return {
      ...item,
      label: `${active}${displayPrefix(tree.prefix, options.unicode)}${fold}${label}${timestamp}${item.label}`,
      tree,
    };
  });
}

export function sessionTreeEndpointIndex(
  rows: readonly PickerItem[],
  selected: number,
  direction: "previous" | "next",
): number {
  const endpoints = rows.flatMap((item, index) => {
    const tree = item.tree;
    const next = rows[index + 1]?.tree;
    return tree !== undefined && (tree.branches.length > 0 || next === undefined || next.depth <= tree.depth) ? [index] : [];
  });
  if (endpoints.length === 0) return Math.max(0, Math.min(selected, rows.length - 1));
  if (direction === "next") return endpoints.find((index) => index > selected) ?? endpoints[0]!;
  return endpoints.findLast((index) => index < selected) ?? endpoints[endpoints.length - 1]!;
}

export function sessionTreeSelectionIndex(
  source: readonly PickerItem[],
  rows: readonly PickerItem[],
  eventId: string | undefined,
): number {
  if (eventId === undefined || rows.length === 0) return -1;
  const visible = new Map(rows.flatMap((item, index) => item.tree === undefined
    ? []
    : [[item.tree.eventId, index] as const]));
  const byId = new Map(source.flatMap((item) => item.tree === undefined
    ? []
    : [[item.tree.eventId, item.tree] as const]));
  const visited = new Set<string>();
  let candidate: string | undefined = eventId;
  while (candidate !== undefined && !visited.has(candidate)) {
    const index = visible.get(candidate);
    if (index !== undefined) return index;
    visited.add(candidate);
    candidate = byId.get(candidate)?.parentEventId;
  }
  return -1;
}
