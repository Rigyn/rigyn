export interface FuzzyMatch {
  matches: boolean;
  score: number;
}

export function fuzzyMatch(query: string, candidate: string): FuzzyMatch {
  const needle = query.toLocaleLowerCase();
  const haystack = candidate.toLocaleLowerCase();
  const score = (value: string): FuzzyMatch => {
    if (value.length === 0) return { matches: true, score: 0 };
    let cursor = 0;
    let previous = -1;
    let streak = 0;
    let total = 0;
    for (let index = 0; index < haystack.length && cursor < value.length; index += 1) {
      if (haystack[index] !== value[cursor]) continue;
      if (index === previous + 1) total -= ++streak * 5;
      else {
        total += previous < 0 ? 0 : (index - previous - 1) * 2;
        streak = 0;
      }
      if (index === 0 || /[\s\-_./:]/u.test(haystack[index - 1]!)) total -= 10;
      total += index / 10;
      previous = index;
      cursor += 1;
    }
    if (cursor !== value.length) return { matches: false, score: 0 };
    if (value === haystack) total -= 100;
    return { matches: true, score: total };
  };
  const direct = score(needle);
  if (direct.matches) return direct;
  const pair = /^(?<letters>[a-z]+)(?<digits>\d+)$|^(?<digitsFirst>\d+)(?<lettersSecond>[a-z]+)$/u.exec(needle)?.groups;
  const swapped = pair?.letters ? `${pair.digits}${pair.letters}` : pair?.digitsFirst ? `${pair.lettersSecond}${pair.digitsFirst}` : undefined;
  if (!swapped) return direct;
  const alternate = score(swapped);
  return alternate.matches ? { matches: true, score: alternate.score + 5 } : direct;
}

export function fuzzyFilter<T>(items: T[], query: string, text: (item: T) => string): T[] {
  const tokens = query.trim().split(/[\s/]+/u).filter(Boolean);
  if (tokens.length === 0) return items;
  return items
    .map((item, order) => ({
      item,
      order,
      matches: tokens.map((token) => fuzzyMatch(token, text(item))),
    }))
    .filter((entry) => entry.matches.every((match) => match.matches))
    .sort((left, right) => {
      const a = left.matches.reduce((sum, match) => sum + match.score, 0);
      const b = right.matches.reduce((sum, match) => sum + match.score, 0);
      return a - b || left.order - right.order;
    })
    .map((entry) => entry.item);
}
