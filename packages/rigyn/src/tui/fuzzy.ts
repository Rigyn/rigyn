import type { PickerItem } from "./types.js";

function boundary(value: string, index: number): boolean {
  if (index === 0) return true;
  const previous = value[index - 1] ?? "";
  const current = value[index] ?? "";
  return /[\s/_.:-]/u.test(previous) || (previous === previous.toLowerCase() && current !== current.toLowerCase());
}

export function fuzzyScore(candidate: string, query: string): number | undefined {
  const needle = query.trim().toLowerCase();
  if (needle === "") return 0;
  const source = candidate.toLowerCase();
  let score = 0;
  let cursor = 0;
  let previous = -2;
  for (const character of needle) {
    const found = source.indexOf(character, cursor);
    if (found < 0) return undefined;
    score += found === previous + 1 ? 12 : 2;
    if (boundary(candidate, found)) score += 8;
    score -= Math.min(8, found - cursor);
    previous = found;
    cursor = found + 1;
  }
  if (source.startsWith(needle)) score += 30;
  if (source === needle) score += 100;
  return score - Math.max(0, candidate.length - query.length) / 100;
}

export function rankPickerItems<T>(items: readonly PickerItem<T>[], query: string, limit = 100): PickerItem<T>[] {
  return items
    .map((item, index) => {
      const candidate = [item.label, item.detail, ...(item.keywords ?? [])].filter(Boolean).join(" ");
      return { item, index, score: fuzzyScore(candidate, query) };
    })
    .filter((entry): entry is typeof entry & { score: number } => entry.score !== undefined)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.item);
}
