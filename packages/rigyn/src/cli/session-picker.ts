import type { SessionInfo } from "../storage/types.js";
import { fuzzyMatch, TuiController, type PickerItem, type TuiAction } from "../tui/index.js";

type SessionLoader = () => Promise<readonly SessionInfo[]>;

export type SessionSortMode = "threaded" | "recent" | "relevance";
export type SessionNameFilter = "all" | "named";

export interface ParsedSessionSearch {
  mode: "tokens" | "regex";
  tokens: Array<{ kind: "fuzzy" | "phrase"; value: string }>;
  regex: RegExp | null;
  error?: string;
}

function normalizedSearchText(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function sessionSearchText(session: SessionInfo): string {
  return `${session.id} ${session.name ?? ""} ${session.allMessagesText} ${session.cwd}`;
}

export function hasSessionName(session: SessionInfo): boolean {
  return Boolean(session.name?.trim());
}

export function parseSessionSearch(query: string): ParsedSessionSearch {
  const selected = query.trim();
  if (selected === "") return { mode: "tokens", tokens: [], regex: null };
  if (selected.startsWith("re:")) {
    const pattern = selected.slice(3).trim();
    if (pattern === "") return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
    try {
      return { mode: "regex", tokens: [], regex: new RegExp(pattern, "iu") };
    } catch (error) {
      return { mode: "regex", tokens: [], regex: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const tokens: ParsedSessionSearch["tokens"] = [];
  let value = "";
  let quoted = false;
  const flush = (kind: "fuzzy" | "phrase"): void => {
    const token = value.trim();
    value = "";
    if (token !== "") tokens.push({ kind, value: token });
  };
  for (const character of selected) {
    if (character === "\"") {
      if (quoted) flush("phrase");
      else flush("fuzzy");
      quoted = !quoted;
    } else if (!quoted && /\s/u.test(character)) flush("fuzzy");
    else value += character;
  }
  if (quoted) {
    return {
      mode: "tokens",
      tokens: selected.split(/\s+/u).map((token) => token.trim()).filter(Boolean)
        .map((token) => ({ kind: "fuzzy" as const, value: token })),
      regex: null,
    };
  }
  flush("fuzzy");
  return { mode: "tokens", tokens, regex: null };
}

function matchSession(session: SessionInfo, query: ParsedSessionSearch): { matches: boolean; score: number } {
  const text = sessionSearchText(session);
  if (query.mode === "regex") {
    if (query.regex === null) return { matches: false, score: 0 };
    const index = text.search(query.regex);
    return index < 0 ? { matches: false, score: 0 } : { matches: true, score: index * 0.1 };
  }
  let score = 0;
  let normalized: string | undefined;
  for (const token of query.tokens) {
    if (token.kind === "phrase") {
      normalized ??= normalizedSearchText(text);
      const index = normalized.indexOf(normalizedSearchText(token.value));
      if (index < 0) return { matches: false, score: 0 };
      score += index * 0.1;
      continue;
    }
    const result = fuzzyMatch(token.value, text);
    if (!result.matches) return { matches: false, score: 0 };
    score += result.score;
  }
  return { matches: true, score };
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
  const matched = candidates.flatMap((session) => {
    const result = matchSession(session, parsed);
    return result.matches ? [{ session, score: result.score }] : [];
  });
  if (sortMode === "recent") return matched.map((entry) => entry.session);
  return matched.sort((left, right) => left.score - right.score || right.session.modified.getTime() - left.session.modified.getTime())
    .map((entry) => entry.session);
}

export function sessionPickerItems(sessions: readonly SessionInfo[], current?: string): PickerItem<string>[] {
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
      ...(session.parentSessionPath === undefined ? {} : { parentId: session.parentSessionPath }),
      current: session.path === current,
      messageCount: session.messageCount,
    },
    value: session.path,
  }));
}

/** Show the session selector used by the startup `--resume` flow. */
export async function selectStartupSession(
  currentSessions: SessionLoader,
  allSessions: SessionLoader,
): Promise<string | undefined> {
  let actionHandler: (action: TuiAction) => void = () => undefined;
  const terminal = new TuiController({ onAction: (action) => actionHandler(action) });
  let settled = false;
  let scope: "current" | "all" = "current";
  let query = "";
  let sessions: readonly SessionInfo[] = [];

  return await new Promise<string | undefined>((resolve, reject) => {
    const finish = (value?: string, error?: unknown): void => {
      if (settled) return;
      settled = true;
      terminal.close();
      if (error !== undefined) reject(error);
      else resolve(value);
    };
    const refresh = async (): Promise<void> => {
      sessions = scope === "all" ? await allSessions() : await currentSessions();
      terminal.setPickerItems("session", sessionPickerItems(filterAndSortSessions(sessions, query, "recent")));
      terminal.setSessionPickerScope(scope);
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
      void refresh().then(() => terminal.openPicker("session", "Resume session"), (error: unknown) => finish(undefined, error));
    } catch (error) {
      finish(undefined, error);
    }
  });
}
