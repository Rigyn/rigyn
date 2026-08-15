import type { SessionInfo } from "../storage/types.js";
import { resolveSessionParentPaths } from "../storage/session-lineage.js";
import { fuzzyMatch, TuiController, type PickerItem, type TuiAction } from "../tui/index.js";
import { sameFilesystemPath } from "../utils/paths.js";
import { SessionLoadGate } from "./session-load-gate.js";

type SessionLoader = () => Promise<readonly SessionInfo[]>;

export type StartupSessionTerminal = Pick<
  TuiController,
  "close" | "openPicker" | "setPickerItems" | "setSessionPickerScope" | "start"
>;

export interface StartupSessionSelectorOptions {
  /** Internal deterministic test seam; production callers use the default terminal. */
  createTerminal?(onAction: (action: TuiAction) => void): StartupSessionTerminal;
}

export type SessionSortMode = "threaded" | "recent" | "relevance";
export type SessionNameFilter = "all" | "named";

export interface ParsedSessionSearch {
  mode: "tokens" | "regex";
  tokens: Array<{ kind: "fuzzy" | "phrase"; value: string }>;
  regex: RegExp | null;
  error?: string;
}

function normalizedSearchText(value: string): string {
  return value.trim().split(/\s+/u).join(" ").toLocaleLowerCase();
}

function sessionSearchText(session: SessionInfo): string {
  return [session.id, session.name ?? "", session.allMessagesText, session.cwd].join(" ");
}

function unquotedTerms(value: string): ParsedSessionSearch["tokens"] {
  return value.split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .map((term) => ({ kind: "fuzzy" as const, value: term }));
}

function lexSearchTerms(value: string): ParsedSessionSearch["tokens"] {
  let quoteCount = 0;
  for (const character of value) if (character === "\"") quoteCount += 1;
  if (quoteCount % 2 !== 0) return unquotedTerms(value);

  const terms: ParsedSessionSearch["tokens"] = [];
  let cursor = 0;
  while (cursor < value.length) {
    while (cursor < value.length && /\s/u.test(value[cursor]!)) cursor += 1;
    if (cursor >= value.length) break;

    if (value[cursor] === "\"") {
      const end = value.indexOf("\"", cursor + 1);
      const phrase = value.slice(cursor + 1, end).trim();
      if (phrase !== "") terms.push({ kind: "phrase", value: phrase });
      cursor = end + 1;
      continue;
    }

    let end = cursor + 1;
    while (end < value.length && value[end] !== "\"" && !/\s/u.test(value[end]!)) end += 1;
    terms.push({ kind: "fuzzy", value: value.slice(cursor, end) });
    cursor = end;
  }
  return terms;
}

export function hasSessionName(session: SessionInfo): boolean {
  return session.name !== undefined && session.name.trim() !== "";
}

function regexSearch(source: string): ParsedSessionSearch {
  const expression = source.trim();
  const result: ParsedSessionSearch = { mode: "regex", tokens: [], regex: null };
  if (expression.length === 0) {
    result.error = "Empty regex";
    return result;
  }
  try {
    result.regex = new RegExp(expression, "iu");
  } catch (cause) {
    result.error = cause instanceof Error ? cause.message : String(cause);
  }
  return result;
}

export function parseSessionSearch(query: string): ParsedSessionSearch {
  const selected = query.trim();
  if (selected === "") return { mode: "tokens", tokens: [], regex: null };
  return selected.startsWith("re:")
    ? regexSearch(selected.slice(3))
    : { mode: "tokens", tokens: lexSearchTerms(selected), regex: null };
}

interface RankedSession {
  session: SessionInfo;
  penalty: number;
}

function sessionPenalty(session: SessionInfo, query: ParsedSessionSearch): number | null {
  const text = sessionSearchText(session);
  if (query.mode === "regex") {
    if (query.regex === null) return null;
    const index = text.search(query.regex);
    return index < 0 ? null : index / 10;
  }

  const normalized = query.tokens.some((term) => term.kind === "phrase")
    ? normalizedSearchText(text)
    : "";
  const contributions = query.tokens.map((token): number | null => {
    if (token.kind === "phrase") {
      const index = normalized.indexOf(normalizedSearchText(token.value));
      return index < 0 ? null : index / 10;
    }
    const result = fuzzyMatch(token.value, text);
    return result.matches ? result.score : null;
  });
  if (contributions.some((value) => value === null)) return null;
  return contributions.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function compareRankedSessions(left: RankedSession, right: RankedSession): number {
  if (left.penalty !== right.penalty) return left.penalty - right.penalty;
  return right.session.modified.getTime() - left.session.modified.getTime();
}

export function filterAndSortSessions(
  sessions: readonly SessionInfo[],
  query: string,
  sortMode: SessionSortMode,
  nameFilter: SessionNameFilter = "all",
): SessionInfo[] {
  const candidates = nameFilter === "named" ? sessions.filter(hasSessionName) : [...sessions];
  if (query.trim() === "") return candidates;
  const parsed = parseSessionSearch(query);
  if (parsed.error !== undefined) return [];
  const matched: RankedSession[] = [];
  for (const session of candidates) {
    const penalty = sessionPenalty(session, parsed);
    if (penalty !== null) matched.push({ session, penalty });
  }
  if (sortMode === "recent") return matched.map((entry) => entry.session);
  matched.sort(compareRankedSessions);
  return matched.map((entry) => entry.session);
}

export function sessionPickerItems(sessions: readonly SessionInfo[], current?: string): PickerItem<string>[] {
  const parentPaths = resolveSessionParentPaths(sessions);
  return sessions.map((session) => ({
    id: session.path,
    label: session.name ?? (session.firstMessage.split("\n", 1)[0]?.slice(0, 100) || session.id),
    detail: `${session.modified.toLocaleString()} · ${session.messageCount} messages · ${session.cwd}`,
    keywords: [session.id, session.name ?? "", session.firstMessage, session.allMessagesText],
    session: {
      path: session.path,
      workspace: session.cwd,
      updatedAt: session.modified.toISOString(),
      createdAt: session.created.toISOString(),
      ...(session.name === undefined ? {} : { name: session.name }),
      ...(parentPaths.get(session.path) === undefined ? {} : { parentId: parentPaths.get(session.path)! }),
      current: current !== undefined && sameFilesystemPath(session.path, current),
      messageCount: session.messageCount,
    },
    value: session.path,
  }));
}

/** Show the session selector used by the startup `--resume` flow. */
export async function selectStartupSession(
  currentSessions: SessionLoader,
  allSessions: SessionLoader,
  options: StartupSessionSelectorOptions = {},
): Promise<string | undefined> {
  let actionHandler: (action: TuiAction) => void = () => undefined;
  const terminal = options.createTerminal?.((action) => actionHandler(action))
    ?? new TuiController({ onAction: (action) => actionHandler(action) });
  let settled = false;
  let opened = false;
  let scope: "current" | "all" = "current";
  let query = "";
  let sessions: readonly SessionInfo[] = [];
  const loads = new SessionLoadGate<readonly SessionInfo[]>();

  return await new Promise<string | undefined>((resolve, reject) => {
    const finish = (value?: string, error?: unknown): void => {
      if (settled) return;
      settled = true;
      terminal.close();
      if (error !== undefined) reject(error);
      else resolve(value);
    };
    const refresh = async (): Promise<void> => {
      const requestedScope = scope;
      const requestedQuery = query;
      const result = await loads.request(requestedScope, requestedScope === "all" ? allSessions : currentSessions);
      if (!result.current || settled) return;
      sessions = result.value;
      terminal.setPickerItems("session", sessionPickerItems(filterAndSortSessions(sessions, requestedQuery, "recent")));
      terminal.setSessionPickerScope(requestedScope);
      if (!opened) {
        opened = true;
        terminal.openPicker("session", "Resume session");
      }
    };
    const handle = async (action: TuiAction): Promise<void> => {
      if (action.type === "select" && action.picker === "session") {
        finish(String(action.item.value));
        return;
      }
      if (action.type === "session_scope") {
        scope = action.scope;
        await refresh();
        return;
      }
      if (action.type === "session_search") {
        scope = action.scope;
        query = action.query;
        await refresh();
        return;
      }
      if (action.type === "exit" || action.type === "signal" || action.type === "cancel") finish();
    };
    actionHandler = (action) => { void handle(action).catch((error: unknown) => finish(undefined, error)); };
    try {
      terminal.start();
      void refresh().catch((error: unknown) => finish(undefined, error));
    } catch (error) {
      finish(undefined, error);
    }
  });
}
