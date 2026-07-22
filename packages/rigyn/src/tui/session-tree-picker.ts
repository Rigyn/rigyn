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

export function buildSessionTreePickerRows<T>(
  source: readonly PickerItem<T>[],
  options: SessionTreePickerOptions,
): PickerItem<T>[] {
  const tokens = options.query.toLowerCase().split(/\s+/u).filter(Boolean);
  const hiddenAtDepth: number[] = [];
  const candidates: Array<{ item: PickerItem<T>; folded: boolean; rawFoldable: boolean }> = [];
  const filter = options.filter ?? "default";

  for (const [index, item] of source.entries()) {
    const tree = item.tree;
    if (tree === undefined) continue;
    while (hiddenAtDepth.length > 0 && tree.depth <= hiddenAtDepth[hiddenAtDepth.length - 1]!) hiddenAtDepth.pop();
    const hidden = hiddenAtDepth.length > 0;
    const next = source[index + 1]?.tree;
    const foldable = next !== undefined && next.depth > tree.depth;
    const folded = options.folded.has(tree.eventId) && foldable;
    if (folded) hiddenAtDepth.push(tree.depth);
    if (hidden || (options.activeOnly && !tree.active)) continue;
    if (filter === "no-tools" && tree.kind === "tool") continue;
    if (filter === "user-only" && tree.kind !== "user") continue;
    if (filter === "labeled-only" && tree.label === undefined) continue;
    if (tokens.length > 0) {
      const text = treeText(item);
      if (!tokens.every((token) => text.includes(token))) continue;
    }
    candidates.push({ item, folded, rawFoldable: foldable });
  }

  return candidates.map(({ item, folded, rawFoldable }, index) => {
    const tree = item.tree!;
    const next = candidates[index + 1]?.item.tree;
    const foldable = folded ? rawFoldable : next !== undefined && next.depth > tree.depth;
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
