import { fuzzyScore } from "./fuzzy.js";

export type SessionPickerSortMode = "threaded" | "recent" | "relevance";

export type SessionPickerTimestamp = string | number | Date;

/** Display and search metadata for one session. This deliberately does not depend on PickerItem. */
export interface SessionPickerMetadata {
  id: string;
  label: string;
  name?: string;
  detail?: string;
  keywords?: readonly string[];
  parentId?: string;
  updatedAt: SessionPickerTimestamp;
}

export interface SessionPickerOptions {
  query?: string;
  namedOnly?: boolean;
  sort?: SessionPickerSortMode;
}

export interface SessionPickerRow<T extends SessionPickerMetadata = SessionPickerMetadata> {
  session: T;
  depth: number;
  score: number;
}

export interface SessionPickerResult<T extends SessionPickerMetadata = SessionPickerMetadata> {
  rows: SessionPickerRow<T>[];
  error?: string;
}

interface RankedSession<T extends SessionPickerMetadata> {
  session: T;
  index: number;
  activity: number;
  score: number;
}

interface SessionTreeNode<T extends SessionPickerMetadata> extends RankedSession<T> {
  parent: SessionTreeNode<T> | undefined;
  children: SessionTreeNode<T>[];
  subtreeActivity: number;
}

type QueryMatcher =
  | { match(candidate: string): number | undefined }
  | { error: string };

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function searchText(session: SessionPickerMetadata): string {
  return normalizeWhitespace([
    session.name,
    session.label,
    session.detail,
    ...(session.keywords ?? []),
  ].filter((value): value is string => value !== undefined && value !== "").join(" "));
}

function queryTerms(query: string): { phrases: string[]; tokens: string[] } {
  const phrases: string[] = [];
  const tokens: string[] = [];
  let buffer = "";
  let quoted = false;

  const commit = (): void => {
    const value = normalizeWhitespace(buffer).toLowerCase();
    if (value !== "") (quoted ? phrases : tokens).push(value);
    buffer = "";
  };

  for (const character of query) {
    if (character === "\"") {
      commit();
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/u.test(character)) {
      commit();
      continue;
    }
    buffer += character;
  }
  commit();
  return { phrases, tokens };
}

function compileQuery(query: string): QueryMatcher {
  if (query.toLowerCase().startsWith("re:")) {
    let expression: RegExp;
    try {
      expression = new RegExp(query.slice(3), "iu");
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Invalid regular expression" };
    }
    return {
      match(candidate) {
        const match = expression.exec(candidate);
        return match === null ? undefined : 1_000 - Math.min(match.index, 1_000);
      },
    };
  }

  const { phrases, tokens } = queryTerms(query);
  return {
    match(candidate) {
      const normalized = normalizeWhitespace(candidate).toLowerCase();
      let score = 0;
      for (const phrase of phrases) {
        const index = normalized.indexOf(phrase);
        if (index < 0) return undefined;
        score += 200 + phrase.length * 2 - Math.min(index, 100);
      }
      for (const token of tokens) {
        const tokenScore = fuzzyScore(normalized, token);
        if (tokenScore === undefined) return undefined;
        score += tokenScore;
      }
      return score;
    },
  };
}

function timestamp(value: SessionPickerTimestamp): number {
  const parsed = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareActivity(left: RankedSession<SessionPickerMetadata>, right: RankedSession<SessionPickerMetadata>): number {
  if (left.activity !== right.activity) return left.activity > right.activity ? -1 : 1;
  return compareText(left.session.id, right.session.id) || left.index - right.index;
}

function compareRelevance(left: RankedSession<SessionPickerMetadata>, right: RankedSession<SessionPickerMetadata>): number {
  if (left.score !== right.score) return left.score > right.score ? -1 : 1;
  return compareActivity(left, right);
}

function compareStableNode(
  left: SessionTreeNode<SessionPickerMetadata>,
  right: SessionTreeNode<SessionPickerMetadata>,
): number {
  return compareText(left.session.id, right.session.id) || left.index - right.index;
}

function compareTreeActivity(
  left: SessionTreeNode<SessionPickerMetadata>,
  right: SessionTreeNode<SessionPickerMetadata>,
): number {
  if (left.subtreeActivity !== right.subtreeActivity) return left.subtreeActivity > right.subtreeActivity ? -1 : 1;
  return compareActivity(left, right);
}

function threadedRows<T extends SessionPickerMetadata>(sessions: readonly RankedSession<T>[]): SessionPickerRow<T>[] {
  const nodes: SessionTreeNode<T>[] = sessions.map((entry) => ({
    ...entry,
    parent: undefined,
    children: [],
    subtreeActivity: entry.activity,
  }));
  const firstById = new Map<string, SessionTreeNode<T>>();
  for (const node of nodes) {
    if (!firstById.has(node.session.id)) firstById.set(node.session.id, node);
  }
  for (const node of nodes) {
    const parent = node.session.parentId === undefined ? undefined : firstById.get(node.session.parentId);
    if (parent !== undefined && parent !== node) node.parent = parent;
  }

  // Break each parent cycle at its stable, lexicographically first node.
  const resolved = new Set<SessionTreeNode<T>>();
  const stable = [...nodes].sort(compareStableNode);
  for (const start of stable) {
    if (resolved.has(start)) continue;
    const path: SessionTreeNode<T>[] = [];
    const pathIndex = new Map<SessionTreeNode<T>, number>();
    let current: SessionTreeNode<T> | undefined = start;
    while (current !== undefined && !resolved.has(current)) {
      const cycleStart = pathIndex.get(current);
      if (cycleStart !== undefined) {
        const cycle = path.slice(cycleStart).sort(compareStableNode);
        cycle[0]!.parent = undefined;
        break;
      }
      pathIndex.set(current, path.length);
      path.push(current);
      current = current.parent;
    }
    for (const node of path) resolved.add(node);
  }

  for (const node of nodes) node.parent?.children.push(node);
  const roots = nodes.filter((node) => node.parent === undefined);
  const calculateSubtreeActivity = (node: SessionTreeNode<T>): number => {
    let newest = node.activity;
    for (const child of node.children) newest = Math.max(newest, calculateSubtreeActivity(child));
    node.subtreeActivity = newest;
    return newest;
  };
  for (const root of roots) calculateSubtreeActivity(root);

  const rows: SessionPickerRow<T>[] = [];
  const walk = (node: SessionTreeNode<T>, depth: number): void => {
    rows.push({ session: node.session, depth, score: node.score });
    node.children.sort(compareTreeActivity);
    for (const child of node.children) walk(child, depth + 1);
  };
  roots.sort(compareTreeActivity);
  for (const root of roots) walk(root, 0);
  return rows;
}

/** Filters, ranks, and optionally threads session metadata for the picker. */
export function buildSessionPickerRows<T extends SessionPickerMetadata>(
  sessions: readonly T[],
  options: SessionPickerOptions = {},
): SessionPickerResult<T> {
  const query = options.query?.trim() ?? "";
  const matcher = compileQuery(query);
  if ("error" in matcher) return { rows: [], error: matcher.error };

  const ranked: RankedSession<T>[] = [];
  for (const [index, session] of sessions.entries()) {
    if (options.namedOnly === true && (session.name === undefined || session.name.trim() === "")) continue;
    const score = matcher.match(searchText(session));
    if (score === undefined) continue;
    ranked.push({ session, index, activity: timestamp(session.updatedAt), score });
  }

  const sort = options.sort ?? "threaded";
  if (query === "" && sort === "threaded") return { rows: threadedRows(ranked) };
  ranked.sort(query !== "" && sort !== "recent" ? compareRelevance : compareActivity);
  return { rows: ranked.map((entry) => ({ session: entry.session, depth: 0, score: entry.score })) };
}

/** Formats the elapsed time using the picker's compact age vocabulary. */
export function formatSessionAge(updatedAt: SessionPickerTimestamp, now: SessionPickerTimestamp = Date.now()): string {
  const updated = timestamp(updatedAt);
  const current = timestamp(now);
  if (!Number.isFinite(updated) || !Number.isFinite(current)) return "now";
  const elapsed = Math.max(0, current - updated);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;
  if (elapsed < minute) return "now";
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h`;
  if (elapsed < week) return `${Math.floor(elapsed / day)}d`;
  if (elapsed < month) return `${Math.floor(elapsed / week)}w`;
  if (elapsed < year) return `${Math.floor(elapsed / month)}mo`;
  return `${Math.floor(elapsed / year)}y`;
}
