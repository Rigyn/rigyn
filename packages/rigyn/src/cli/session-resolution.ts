import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { SessionManager } from "../storage/session-manager.js";
import type { SessionInfo } from "../storage/types.js";
import { sameFilesystemPath } from "../utils/paths.js";

export class SessionResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionResolutionError";
  }
}

export type ResolvedSessionReference =
  | { type: "path"; path: string }
  | { type: "local"; session: SessionInfo }
  | { type: "global"; session: SessionInfo }
  | { type: "not_found"; reference: string };

function looksLikePath(reference: string): boolean {
  return reference.includes("/") || reference.includes("\\") || reference.endsWith(".jsonl");
}

function exact(session: SessionInfo, reference: string): boolean {
  return sameFilesystemPath(session.path, reference) || session.id === reference || session.name === reference;
}

function partial(session: SessionInfo, reference: string): boolean {
  const selected = reference.toLowerCase();
  return session.id.toLowerCase().startsWith(selected)
    || session.path.toLowerCase().includes(selected)
    || session.name?.toLowerCase().includes(selected) === true;
}

function resolutionError(error: unknown): SessionResolutionError {
  return new SessionResolutionError(error instanceof Error ? error.message : String(error));
}

async function inspectExplicitPath(cwd: string, reference: string): Promise<SessionInfo | undefined> {
  const path = resolve(cwd, reference);
  if (!existsSync(path)) return undefined;
  try {
    return await SessionManager.inspectFile(path);
  } catch (error) {
    throw resolutionError(error);
  }
}

export function resolveSessionReference(sessions: readonly SessionInfo[], reference: string): SessionInfo {
  const selected = reference.trim();
  if (selected === "" || selected.includes("\0")) throw new SessionResolutionError("Session reference is invalid");
  const exactMatches = sessions.filter((session) => exact(session, selected));
  if (exactMatches.length === 1) return exactMatches[0]!;
  if (exactMatches.length > 1) throw new SessionResolutionError(`Session reference is ambiguous: ${selected}`);
  const matches = sessions.filter((session) => partial(session, selected));
  if (matches.length === 0) throw new SessionResolutionError(`Session not found: ${selected}`);
  if (matches.length > 1) {
    const labels = matches.slice(0, 8).map((session) => `${session.id} (${session.path})`).join(", ");
    throw new SessionResolutionError(`Session reference is ambiguous: ${selected}; matches ${labels}`);
  }
  return matches[0]!;
}

export async function resolveSessionFile(input: {
  cwd: string;
  reference: string;
  sessionDirectory?: string;
  allWorkspaces?: boolean;
}): Promise<SessionInfo> {
  const reference = input.reference.trim();
  if (reference === "" || reference.includes("\0")) throw new SessionResolutionError("Session reference is invalid");
  if (looksLikePath(reference)) {
    const session = await inspectExplicitPath(input.cwd, reference);
    if (session === undefined) throw new SessionResolutionError(`Session not found: ${reference}`);
    if (input.allWorkspaces !== true && !sameFilesystemPath(session.cwd, input.cwd)) {
      throw new SessionResolutionError(`Session is outside the current workspace: ${reference}`);
    }
    return session;
  }
  const sessions = input.allWorkspaces === true
    ? await SessionManager.listAll(input.sessionDirectory)
    : await SessionManager.list(input.cwd, input.sessionDirectory);
  return resolveSessionReference(sessions, reference);
}

/** Resolve a CLI session argument without silently changing workspace scope. */
export async function resolveSessionTarget(input: {
  cwd: string;
  reference: string;
  sessionDirectory?: string;
}): Promise<ResolvedSessionReference> {
  const reference = input.reference.trim();
  if (reference === "" || reference.includes("\0")) {
    throw new SessionResolutionError("Session reference is invalid");
  }
  if (looksLikePath(reference)) {
    const session = await inspectExplicitPath(input.cwd, reference);
    if (session === undefined) return { type: "not_found", reference };
    return sameFilesystemPath(session.cwd, input.cwd)
      ? { type: "path", path: session.path }
      : { type: "global", session };
  }

  const local = await SessionManager.list(input.cwd, input.sessionDirectory);
  const localExact = local.filter((session) => session.id === reference || session.name === reference);
  if (localExact.length === 1) return { type: "local", session: localExact[0]! };
  if (localExact.length > 1) throw new SessionResolutionError(`Session reference is ambiguous: ${reference}`);
  const localPrefix = local.filter((session) => session.id.startsWith(reference));
  if (localPrefix.length === 1) return { type: "local", session: localPrefix[0]! };
  if (localPrefix.length > 1) {
    throw new SessionResolutionError(`Session reference is ambiguous: ${reference}`);
  }

  const global = await SessionManager.listAll(input.sessionDirectory);
  const outside = global.filter((session) => !sameFilesystemPath(session.cwd, input.cwd));
  const globalExact = outside.filter((session) => session.id === reference || session.name === reference);
  if (globalExact.length === 1) return { type: "global", session: globalExact[0]! };
  if (globalExact.length > 1) throw new SessionResolutionError(`Session reference is ambiguous: ${reference}`);
  const globalPrefix = outside.filter((session) => session.id.startsWith(reference));
  if (globalPrefix.length === 1) return { type: "global", session: globalPrefix[0]! };
  if (globalPrefix.length > 1) {
    throw new SessionResolutionError(`Session reference is ambiguous: ${reference}`);
  }
  return { type: "not_found", reference };
}
