import { resolve } from "node:path";

import { SessionManager } from "../storage/session-manager.js";
import type { SessionInfo, SessionListProgress } from "../storage/types.js";

export interface SessionCatalogQuery {
  cwd: string;
  sessionDirectory?: string;
  allWorkspaces?: boolean;
  search?: string;
  limit?: number;
  afterPath?: string;
  progress?: SessionListProgress;
}

export interface SessionCatalogPage {
  sessions: SessionInfo[];
  nextPath?: string;
  hasMore: boolean;
}

function searchable(session: SessionInfo): string {
  return [session.id, session.name, session.cwd, session.path, session.firstMessage, session.allMessagesText]
    .filter((value): value is string => value !== undefined)
    .join("\n")
    .toLowerCase();
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Scans the canonical JSONL session files. There is intentionally no secondary database or index. */
export async function listSessionCatalog(query: SessionCatalogQuery): Promise<SessionCatalogPage> {
  const limit = query.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) throw new RangeError("Session catalog limit is invalid");
  const cwd = resolve(query.cwd);
  const sessions = query.allWorkspaces === true
    ? await SessionManager.listAll(query.sessionDirectory, query.progress)
    : await SessionManager.list(cwd, query.sessionDirectory, query.progress);
  const needle = query.search?.trim().toLowerCase();
  const filtered = sessions
    .filter((session) => needle === undefined || needle === "" || searchable(session).includes(needle))
    .sort((left, right) => right.modified.getTime() - left.modified.getTime() || comparePath(left.path, right.path));
  let start = 0;
  if (query.afterPath !== undefined) {
    const cursor = filtered.findIndex((session) => session.path === query.afterPath);
    if (cursor < 0) throw new RangeError("Session catalog cursor was not found");
    start = cursor + 1;
  }
  const page = filtered.slice(start, start + limit);
  const hasMore = start + page.length < filtered.length;
  return {
    sessions: page,
    hasMore,
    ...(hasMore && page.at(-1) !== undefined ? { nextPath: page.at(-1)!.path } : {}),
  };
}
