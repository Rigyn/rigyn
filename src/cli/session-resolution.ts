import { realpath, stat } from "node:fs/promises";
import { HarnessError } from "../core/errors.js";
import type { SessionStore } from "../storage/store.js";
import type { ThreadRecord } from "../storage/types.js";
import type { IndexedSessionRecord, WorkspaceSessionIndex } from "./session-index.js";

const MAX_SESSION_REFERENCE_BYTES = 16 * 1024;
const MAX_SESSION_CANDIDATES = 10_000;
const MAX_AMBIGUOUS_LABELS = 5;

export interface SessionResolutionOptions {
  workspaceRoot?: string;
}

export interface IndexedSessionResolutionOptions extends SessionResolutionOptions {
  databasePath?: string;
}

export interface SessionWorkspaceTrust {
  isTrusted(workspace: string): Promise<boolean>;
}

export interface SessionWorkspaceTarget {
  thread: ThreadRecord;
  workspaceRoot: string;
  crossWorkspace: boolean;
}

export interface IndexedSessionWorkspaceTarget extends SessionWorkspaceTarget {
  thread: ThreadRecord;
  databasePath: string;
  indexed: IndexedSessionRecord;
}

export interface SessionRuntimeCandidate {
  workspace: string;
  trusted: boolean;
  store: SessionStore;
  close(): Promise<void>;
}

export interface IndexedSessionRuntimeCandidate extends SessionRuntimeCandidate {
  databasePath: string;
}

export interface PreparedSessionRuntimeSwitch<T extends SessionRuntimeCandidate> {
  readonly runtime: T;
  readonly target: SessionWorkspaceTarget;
  commit(): T;
  rollback(): Promise<void>;
}

export class SessionResolutionError extends Error {
  readonly code: "SESSION_REFERENCE" | "SESSION_AMBIGUOUS" | "SESSION_WORKSPACE";
  readonly candidates: readonly string[];

  constructor(
    code: SessionResolutionError["code"],
    message: string,
    candidates: readonly string[] = [],
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SessionResolutionError";
    this.code = code;
    this.candidates = candidates;
  }
}

function normalizedReference(reference: string): string {
  const value = reference.trim();
  if (value === "") throw new SessionResolutionError("SESSION_REFERENCE", "Session reference is empty");
  if (Buffer.byteLength(value) > MAX_SESSION_REFERENCE_BYTES) {
    throw new SessionResolutionError("SESSION_REFERENCE", "Session reference exceeds 16 KiB");
  }
  return value;
}

function exactThread(store: SessionStore, reference: string): ThreadRecord | undefined {
  try {
    return store.getThread(reference);
  } catch (error) {
    if (error instanceof HarnessError && error.code === "STORAGE_NOT_FOUND") return undefined;
    throw error;
  }
}

function candidateLabel(thread: ThreadRecord): string {
  return thread.name === undefined ? thread.threadId : `${thread.name} (${thread.threadId})`;
}

function indexedCandidateLabel(record: IndexedSessionRecord): string {
  return indexedSessionReference(record);
}

function ambiguous(reference: string, matches: readonly ThreadRecord[]): never {
  const labels = matches.slice(0, MAX_AMBIGUOUS_LABELS).map(candidateLabel);
  const omitted = matches.length - labels.length;
  const suffix = omitted === 0 ? "" : `, and ${omitted} more`;
  throw new SessionResolutionError(
    "SESSION_AMBIGUOUS",
    `Session reference ${JSON.stringify(reference)} is ambiguous: ${labels.join(", ")}${suffix}`,
    labels,
  );
}

function ambiguousIndexed(reference: string, matches: readonly IndexedSessionRecord[]): never {
  const labels = matches.slice(0, MAX_AMBIGUOUS_LABELS).map(indexedCandidateLabel);
  const omitted = matches.length - labels.length;
  const suffix = omitted === 0 ? "" : `, and ${omitted} more`;
  throw new SessionResolutionError(
    "SESSION_AMBIGUOUS",
    `Session reference ${JSON.stringify(reference)} is ambiguous: ${labels.join(", ")}${suffix}`,
    labels,
  );
}

/** Stable, copyable reference that remains unique when thread IDs collide. */
export function indexedSessionReference(record: Pick<IndexedSessionRecord, "databasePath" | "threadId">): string {
  if (!record.databasePath.includes("#") && !record.threadId.includes("#")) {
    return `${record.databasePath}#${record.threadId}`;
  }
  return `session:${Buffer.from(JSON.stringify([record.databasePath, record.threadId]), "utf8").toString("base64url")}`;
}

function parsedIndexedSessionReference(reference: string): { databasePath: string; threadId: string } | undefined {
  if (reference.startsWith("session:")) {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(reference.slice("session:".length), "base64url").toString("utf8"));
      if (
        !Array.isArray(parsed)
        || parsed.length !== 2
        || typeof parsed[0] !== "string"
        || typeof parsed[1] !== "string"
        || parsed[0] === ""
        || parsed[1] === ""
      ) return undefined;
      return { databasePath: parsed[0], threadId: parsed[1] };
    } catch {
      return undefined;
    }
  }
  const separator = reference.lastIndexOf("#");
  if (separator <= 0 || separator === reference.length - 1) return undefined;
  return { databasePath: reference.slice(0, separator), threadId: reference.slice(separator + 1) };
}

/** Resolve a human session reference without changing workspace ownership. */
export function resolveSessionReference(
  store: SessionStore,
  reference: string,
  options: SessionResolutionOptions = {},
): ThreadRecord {
  const value = normalizedReference(reference);
  const direct = exactThread(store, value);
  if (direct !== undefined) {
    if (
      options.workspaceRoot === undefined
      || direct.workspaceRoot === undefined
      || direct.workspaceRoot === options.workspaceRoot
    ) return direct;
    throw new SessionResolutionError(
      "SESSION_WORKSPACE",
      `Session ${direct.threadId} belongs to ${direct.workspaceRoot}, not ${options.workspaceRoot}`,
    );
  }

  const threads = store.listThreads({
    ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
    limit: MAX_SESSION_CANDIDATES,
  });
  if (threads.length === MAX_SESSION_CANDIDATES) {
    throw new SessionResolutionError(
      "SESSION_REFERENCE",
      "More than 10,000 sessions are in scope; use an exact session ID",
    );
  }
  const folded = value.toLowerCase();
  const exactNames = threads.filter((thread) => thread.name?.toLowerCase() === folded);
  if (exactNames.length === 1) return exactNames[0]!;
  if (exactNames.length > 1) return ambiguous(value, exactNames);

  const partial = threads.filter((thread) =>
    thread.threadId.toLowerCase().startsWith(folded)
    || thread.name?.toLowerCase().includes(folded) === true,
  );
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) return ambiguous(value, partial);
  throw new SessionResolutionError(
    "SESSION_REFERENCE",
    options.workspaceRoot === undefined
      ? `No saved session matches ${JSON.stringify(value)}`
      : `No saved session matches ${JSON.stringify(value)} in this workspace`,
  );
}

/** Resolve metadata from the central index without opening session history. */
export function resolveIndexedSessionReference(
  index: WorkspaceSessionIndex,
  reference: string,
  options: IndexedSessionResolutionOptions = {},
): IndexedSessionRecord {
  const value = normalizedReference(reference);
  const qualified = parsedIndexedSessionReference(value);
  if (value.startsWith("session:") && qualified === undefined) {
    throw new SessionResolutionError(
      "SESSION_REFERENCE",
      `Invalid qualified session reference ${JSON.stringify(value)}`,
    );
  }
  const selectedOptions = qualified === undefined
    ? options
    : { ...options, databasePath: qualified.databasePath };
  const selectedReference = qualified?.threadId ?? value;
  let matches;
  try {
    matches = index.lookup(selectedReference, { ...selectedOptions, limit: MAX_SESSION_CANDIDATES });
  } catch (error) {
    if (qualified === undefined) throw error;
    throw new SessionResolutionError(
      "SESSION_REFERENCE",
      `Invalid qualified session reference ${JSON.stringify(value)}`,
      [],
      error,
    );
  }
  if (matches.exactIds.length === 1) return matches.exactIds[0]!;
  if (matches.exactIds.length > 1) return ambiguousIndexed(value, matches.exactIds);
  if (qualified !== undefined) {
    throw new SessionResolutionError(
      "SESSION_REFERENCE",
      `No saved session matches qualified reference ${JSON.stringify(value)}`,
    );
  }
  if (matches.exactNames.length === 1) return matches.exactNames[0]!;
  if (matches.exactNames.length > 1) return ambiguousIndexed(value, matches.exactNames);
  if (matches.truncated) {
    throw new SessionResolutionError(
      "SESSION_REFERENCE",
      "More than 10,000 indexed sessions match; use an exact database-qualified session reference",
    );
  }
  if (matches.partial.length === 1) return matches.partial[0]!;
  if (matches.partial.length > 1) return ambiguousIndexed(value, matches.partial);
  throw new SessionResolutionError(
    "SESSION_REFERENCE",
    options.workspaceRoot === undefined && options.databasePath === undefined
      ? `No saved session matches ${JSON.stringify(value)} across indexed workspaces`
      : `No saved session matches ${JSON.stringify(value)} in the selected session database`,
  );
}

/**
 * Validate recorded cross-workspace metadata before any runtime resources are
 * loaded. The recorded path must still be canonical and explicitly trusted.
 */
export async function resolveSessionWorkspaceTarget(
  thread: ThreadRecord,
  currentWorkspace: string,
  trust: SessionWorkspaceTrust,
): Promise<SessionWorkspaceTarget> {
  const recorded = thread.workspaceRoot;
  if (recorded === undefined) {
    throw new SessionResolutionError(
      "SESSION_WORKSPACE",
      `Session ${thread.threadId} has no recorded workspace and cannot be opened across workspaces`,
    );
  }
  let canonical: string;
  try {
    canonical = await realpath(recorded);
  } catch (error) {
    throw new SessionResolutionError(
      "SESSION_WORKSPACE",
      `Recorded workspace is missing or inaccessible: ${recorded}`,
      [],
      error,
    );
  }
  if (canonical !== recorded) {
    throw new SessionResolutionError(
      "SESSION_WORKSPACE",
      `Recorded workspace moved or now resolves elsewhere: ${recorded}`,
    );
  }
  let details;
  try {
    details = await stat(canonical);
  } catch (error) {
    throw new SessionResolutionError(
      "SESSION_WORKSPACE",
      `Recorded workspace is missing or inaccessible: ${canonical}`,
      [],
      error,
    );
  }
  if (!details.isDirectory()) {
    throw new SessionResolutionError(
      "SESSION_WORKSPACE",
      `Recorded workspace is not a directory: ${canonical}`,
    );
  }
  const crossWorkspace = canonical !== currentWorkspace;
  if (crossWorkspace && !await trust.isTrusted(canonical)) {
    throw new SessionResolutionError(
      "SESSION_WORKSPACE",
      `Recorded workspace is not currently trusted: ${canonical}`,
    );
  }
  return { thread, workspaceRoot: canonical, crossWorkspace };
}

/**
 * Stage a complete runtime before the caller mutates its active chat state.
 * Failed validation always closes the candidate; commit transfers ownership.
 */
export async function prepareSessionRuntimeSwitch<T extends SessionRuntimeCandidate>(
  thread: ThreadRecord,
  currentWorkspace: string,
  trust: SessionWorkspaceTrust,
  load: (workspaceRoot: string) => Promise<T>,
): Promise<PreparedSessionRuntimeSwitch<T>> {
  const target = await resolveSessionWorkspaceTarget(thread, currentWorkspace, trust);
  const candidate = await load(target.workspaceRoot);
  try {
    if (candidate.workspace !== target.workspaceRoot) {
      throw new SessionResolutionError(
        "SESSION_WORKSPACE",
        `Candidate runtime opened the wrong workspace: ${candidate.workspace}`,
      );
    }
    if (target.crossWorkspace && !candidate.trusted) {
      throw new SessionResolutionError(
        "SESSION_WORKSPACE",
        `Recorded workspace became untrusted while loading: ${target.workspaceRoot}`,
      );
    }
    if (target.crossWorkspace && !await trust.isTrusted(target.workspaceRoot)) {
      throw new SessionResolutionError(
        "SESSION_WORKSPACE",
        `Recorded workspace became untrusted while loading: ${target.workspaceRoot}`,
      );
    }
    const reopened = candidate.store.getThread(thread.threadId);
    if (reopened.workspaceRoot !== target.workspaceRoot) {
      throw new SessionResolutionError(
        "SESSION_WORKSPACE",
        `Session ${thread.threadId} is not recorded in the candidate workspace database`,
      );
    }
  } catch (error) {
    try {
      await candidate.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Candidate runtime validation and cleanup failed");
    }
    throw error;
  }

  let state: "open" | "committed" | "rolled_back" = "open";
  return {
    runtime: candidate,
    target,
    commit() {
      if (state !== "open") throw new Error(`Session runtime switch is already ${state}`);
      state = "committed";
      return candidate;
    },
    async rollback() {
      if (state === "rolled_back") return;
      if (state === "committed") throw new Error("Committed session runtime switch cannot be rolled back");
      state = "rolled_back";
      await candidate.close();
    },
  };
}

/**
 * Verify indexed metadata, stage an isolated runtime, then verify trust and
 * source metadata again before ownership can transfer to the caller.
 */
export async function prepareIndexedSessionRuntimeSwitch<T extends IndexedSessionRuntimeCandidate>(
  record: IndexedSessionRecord,
  currentWorkspace: string,
  index: WorkspaceSessionIndex,
  trust: SessionWorkspaceTrust,
  load: (workspaceRoot: string, databasePath: string) => Promise<T>,
): Promise<PreparedSessionRuntimeSwitch<T> & { readonly target: IndexedSessionWorkspaceTarget }> {
  const verified = await index.verify(record, {
    isTrusted: async (workspace) => workspace === currentWorkspace || await trust.isTrusted(workspace),
  });
  const crossWorkspace = verified.workspaceRoot !== currentWorkspace;
  const candidate = await load(verified.workspaceRoot, verified.databasePath);
  let thread: ThreadRecord;
  try {
    if (candidate.workspace !== verified.workspaceRoot) {
      throw new SessionResolutionError(
        "SESSION_WORKSPACE",
        `Candidate runtime opened the wrong workspace: ${candidate.workspace}`,
      );
    }
    if (candidate.databasePath !== verified.databasePath) {
      throw new SessionResolutionError(
        "SESSION_WORKSPACE",
        `Candidate runtime opened the wrong session database: ${candidate.databasePath}`,
      );
    }
    if (crossWorkspace && (!candidate.trusted || !await trust.isTrusted(verified.workspaceRoot))) {
      throw new SessionResolutionError(
        "SESSION_WORKSPACE",
        `Indexed workspace became untrusted while loading: ${verified.workspaceRoot}`,
      );
    }
    thread = candidate.store.getThread(verified.threadId);
    if (
      thread.workspaceRoot !== verified.workspaceRoot
      || thread.name !== verified.name
      || thread.createdAt !== verified.createdAt
      || thread.updatedAt !== verified.updatedAt
    ) {
      throw new SessionResolutionError(
        "SESSION_WORKSPACE",
        `Session ${verified.threadId} changed while its runtime was loading; refresh the session index`,
      );
    }
  } catch (error) {
    try {
      await candidate.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Candidate runtime validation and cleanup failed");
    }
    throw error;
  }

  const target: IndexedSessionWorkspaceTarget = {
    thread,
    workspaceRoot: verified.workspaceRoot,
    databasePath: verified.databasePath,
    crossWorkspace,
    indexed: verified,
  };
  let state: "open" | "committed" | "rolled_back" = "open";
  return {
    runtime: candidate,
    target,
    commit() {
      if (state !== "open") throw new Error(`Session runtime switch is already ${state}`);
      state = "committed";
      return candidate;
    },
    async rollback() {
      if (state === "rolled_back") return;
      if (state === "committed") throw new Error("Committed session runtime switch cannot be rolled back");
      state = "rolled_back";
      await candidate.close();
    },
  };
}
