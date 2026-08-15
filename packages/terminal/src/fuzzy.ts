export interface FuzzyMatch { matches: boolean; score: number; positions: number[] }
export function fuzzyMatch(query: string, candidate: string): FuzzyMatch {
  const needle = query.toLocaleLowerCase();
  const haystack = candidate.toLocaleLowerCase();
  const positions: number[] = [];
  let from = 0;
  let score = 0;
  for (const character of needle) {
    const index = haystack.indexOf(character, from);
    if (index < 0) {
      const pieces = needle.match(/[\p{Letter}\p{Mark}]+|\p{Number}+/gu) ?? [];
      if (pieces.length < 2) return { matches: false, score: Number.NEGATIVE_INFINITY, positions: [] };
      const grouped = pieces.flatMap((piece) => {
        const found: number[] = [];
        let cursor = 0;
        for (const part of piece) {
          const selected = haystack.indexOf(part, cursor);
          if (selected < 0) return [];
          found.push(selected);
          cursor = selected + 1;
        }
        return found;
      });
      if (grouped.length !== pieces.reduce((total, piece) => total + piece.length, 0)) {
        return { matches: false, score: Number.NEGATIVE_INFINITY, positions: [] };
      }
      const selected = [...new Set(grouped)].sort((left, right) => left - right);
      return { matches: true, score: selected.length * 4 - (selected.at(-1)! - selected[0]!), positions: selected };
    }
    positions.push(index);
    score += index === 0 || /[/_\-\s]/u.test(haystack[index - 1] ?? "") ? 8 : index === from ? 4 : 1;
    score -= index - from;
    from = index + 1;
  }
  return { matches: true, score, positions };
}
export function fuzzyFilter<T>(values: readonly T[], query: string, select: (value: T) => string): T[] {
  return values.map((value, index) => ({ value, index, match: fuzzyMatch(query, select(value)) }))
    .filter(({ match }) => match.matches)
    .sort((left, right) => right.match.score - left.match.score || left.index - right.index)
    .map(({ value }) => value);
}
