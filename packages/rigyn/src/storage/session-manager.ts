import { randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { getAgentDir, getSessionsDir } from "../config/paths.js";
import type { CanonicalMessage, ImageBlock, NormalizedUsage, TextBlock } from "../core/types.js";
import { filesystemPathIdentity, sameFilesystemPath } from "../utils/paths.js";
import {
  CURRENT_SESSION_VERSION,
  type BranchSummaryEntry,
  type BranchSummaryMessage,
  type CompactionEntry,
  type CompactionSummaryMessage,
  type CustomEntry,
  type CustomMessage,
  type CustomMessageEntry,
  type FileEntry,
  type LabelEntry,
  type ModelChangeEntry,
  type NewSessionOptions,
  type PersistedSessionMessage,
  type SessionContext,
  type SessionContextMessage,
  type SessionEntry,
  type SessionFileIssue,
  type SessionHeader,
  type SessionInfo,
  type SessionInfoEntry,
  type SessionListProgress,
  type SessionMessageEntry,
  type SessionScanResult,
  type SessionTreeNode,
  type ThinkingLevelChangeEntry,
} from "./types.js";

const READ_BUFFER_BYTES = 1024 * 1024;
const HEADER_BUFFER_BYTES = 4096;
const MAX_HEADER_SCAN_BYTES = 1024 * 1024;
const INFO_READ_CONCURRENCY = 10;

class HeaderScanLimitError extends Error {
  constructor(path: string) {
    super(`Session header exceeds ${MAX_HEADER_SCAN_BYTES} bytes: ${path}`);
    this.name = "HeaderScanLimitError";
  }
}

function expandedPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

function absolutePath(path: string): string {
  return resolve(expandedPath(path));
}

function agentDirectory(): string {
  return getAgentDir();
}

function sessionsDirectory(): string {
  return getSessionsDir();
}

function uuidV7(): string {
  const time = BigInt(Date.now()).toString(16).padStart(12, "0").slice(-12);
  const random = randomBytes(10).toString("hex");
  const variant = (8 | (Number.parseInt(random[3] ?? "0", 16) & 3)).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-${variant}${random.slice(4, 7)}-${random.slice(7, 19)}`;
}

function newSessionId(): string {
  return uuidV7();
}

export function assertValidSessionId(id: string): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(id)) {
    throw new Error(
      "Session id must use only letters, numbers, dots, underscores, and hyphens, with a letter or number at each end",
    );
  }
}

function shortEntryId(index: { has(id: string): boolean }): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = randomUUID().slice(0, 8);
    if (!index.has(candidate)) return candidate;
  }
  return randomUUID();
}

class SessionFileCorruptionError extends Error {
  constructor(path: string, line: number) {
    super(`Session file contains malformed JSON at line ${line}: ${path}`);
    this.name = "SessionFileCorruptionError";
  }
}

function parseCompleteLine(line: string, path: string, lineNumber: number): FileEntry | null {
  if (line.trim() === "") return null;
  try {
    return JSON.parse(line) as FileEntry;
  } catch {
    throw new SessionFileCorruptionError(path, lineNumber);
  }
}

function parseTailLine(line: string): FileEntry | null {
  if (line.trim() === "") return null;
  try {
    return JSON.parse(line) as FileEntry;
  } catch {
    return null;
  }
}

export function parseSessionEntries(content: string): FileEntry[] {
  const entries: FileEntry[] = [];
  const lines = content.split("\n");
  const finalIsComplete = content.endsWith("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const finalTail = index === lines.length - 1 && !finalIsComplete;
    const entry = finalTail ? parseTailLine(line) : parseCompleteLine(line, "session content", index + 1);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

function migrateVersionOne(entries: FileEntry[]): void {
  const ids = new Set<string>();
  let parentId: string | null = null;

  for (const fileEntry of entries) {
    if (fileEntry.type === "session") {
      fileEntry.version = 2;
      continue;
    }
    const entry = fileEntry as SessionEntry & { firstKeptEntryIndex?: number };
    entry.id = shortEntryId(ids);
    ids.add(entry.id);
    entry.parentId = parentId;
    parentId = entry.id;

    if (entry.type === "compaction" && typeof entry.firstKeptEntryIndex === "number") {
      const kept = entries[entry.firstKeptEntryIndex];
      if (kept !== undefined && kept.type !== "session") entry.firstKeptEntryId = kept.id;
      delete entry.firstKeptEntryIndex;
    }
  }
}

function migrateVersionTwo(entries: FileEntry[]): void {
  for (const entry of entries) {
    if (entry.type === "session") {
      entry.version = 3;
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message as unknown as { role?: string };
    if (message.role === "hookMessage") message.role = "custom";
  }
}

function applyMigrations(entries: FileEntry[]): boolean {
  const header = entries.find((entry) => entry.type === "session") as SessionHeader | undefined;
  const version = header?.version ?? 1;
  if (version >= CURRENT_SESSION_VERSION) return false;
  if (version < 2) migrateVersionOne(entries);
  if (version < 3) migrateVersionTwo(entries);
  return true;
}

export function migrateSessionEntries(entries: FileEntry[]): void {
  applyMigrations(entries);
}

interface SessionAppendRecovery {
  truncateTo?: number;
  addSeparator?: boolean;
}

interface LoadedSessionFile {
  entries: FileEntry[];
  recovery?: SessionAppendRecovery;
}

function loadSessionFile(path: string): LoadedSessionFile {
  const file = absolutePath(path);
  if (!existsSync(file)) return { entries: [] };

  const entries: FileEntry[] = [];
  const descriptor = openSync(file, "r");
  let recovery: SessionAppendRecovery | undefined;
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let pending = "";
    let lineNumber = 0;
    let bytesReadTotal = 0;
    let lastCompleteByte = 0;
    for (;;) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      for (let index = 0; index < bytes; index += 1) {
        if (buffer[index] === 0x0a) lastCompleteByte = bytesReadTotal + index + 1;
      }
      bytesReadTotal += bytes;
      pending += decoder.write(buffer.subarray(0, bytes));
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        lineNumber += 1;
        const entry = parseCompleteLine(pending.slice(0, newline), file, lineNumber);
        if (entry !== null) entries.push(entry);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    }
    pending += decoder.end();
    const tail = parseTailLine(pending);
    if (tail !== null) {
      entries.push(tail);
      recovery = { addSeparator: true };
    } else if (pending.length > 0) {
      recovery = { truncateTo: lastCompleteByte };
    }
  } finally {
    closeSync(descriptor);
  }

  if (entries.length === 0) return { entries: [], ...(recovery === undefined ? {} : { recovery }) };
  const first = entries[0] as FileEntry;
  if (first.type !== "session" || typeof (first as { id?: unknown }).id !== "string") {
    return { entries: [], ...(recovery === undefined ? {} : { recovery }) };
  }
  return { entries, ...(recovery === undefined ? {} : { recovery }) };
}

export function loadEntriesFromFile(path: string): FileEntry[] {
  return loadSessionFile(path).entries;
}

function headerCandidate(
  line: string,
  path: string,
  lineNumber: number,
  complete: boolean,
): SessionHeader | null | undefined {
  if (line.trim() === "") return undefined;
  const parsed = complete ? parseCompleteLine(line, path, lineNumber) : parseTailLine(line);
  if (parsed === null) return undefined;
  if (parsed.type !== "session" || typeof (parsed as { id?: unknown }).id !== "string") return null;
  return parsed;
}

function readHeader(path: string): SessionHeader | null {
  const descriptor = openSync(path, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(HEADER_BUFFER_BYTES);
    let line = "";
    let lineNumber = 0;
    let scanned = 0;

    while (scanned < MAX_HEADER_SCAN_BYTES) {
      const capacity = Math.min(buffer.length, MAX_HEADER_SCAN_BYTES - scanned);
      const bytes = readSync(descriptor, buffer, 0, capacity, null);
      if (bytes === 0) {
        line += decoder.end();
        return headerCandidate(line, path, lineNumber + 1, false) ?? null;
      }
      scanned += bytes;
      const chunk = decoder.write(buffer.subarray(0, bytes));
      let start = 0;
      let newline = chunk.indexOf("\n", start);
      while (newline >= 0) {
        line += chunk.slice(start, newline);
        lineNumber += 1;
        const candidate = headerCandidate(line, path, lineNumber, true);
        if (candidate !== undefined) return candidate;
        line = "";
        start = newline + 1;
        newline = chunk.indexOf("\n", start);
      }
      line += chunk.slice(start);
    }

    const probe = Buffer.allocUnsafe(1);
    if (readSync(descriptor, probe, 0, 1, null) === 0) {
      line += decoder.end();
      return headerCandidate(line, path, lineNumber + 1, false) ?? null;
    }
    throw new HeaderScanLimitError(path);
  } finally {
    closeSync(descriptor);
  }
}

function discoverHeader(path: string): SessionHeader | null {
  try {
    return readHeader(path);
  } catch {
    return null;
  }
}

function headerCwd(header: SessionHeader): string | undefined {
  return typeof (header as { cwd?: unknown }).cwd === "string" ? header.cwd : undefined;
}

function sameCwd(candidate: string | undefined, cwd: string): boolean {
  return candidate !== undefined && candidate !== "" && sameFilesystemPath(candidate, cwd);
}

export function findMostRecentSession(sessionDir: string, cwd?: string): string | null {
  const directory = absolutePath(sessionDir);
  const wantedCwd = cwd;
  try {
    const candidates = readdirSync(directory)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(directory, name))
      .map((path) => ({ path, header: discoverHeader(path) }))
      .filter((candidate): candidate is { path: string; header: SessionHeader } =>
        candidate.header !== null && (wantedCwd === undefined || sameCwd(headerCwd(candidate.header), wantedCwd)))
      .map((candidate) => ({ path: candidate.path, modified: statSync(candidate.path).mtimeMs }))
      .sort((left, right) => right.modified - left.modified || comparePath(left.path, right.path));
    return candidates[0]?.path ?? null;
  } catch {
    return null;
  }
}

function messageRole(message: PersistedSessionMessage): string {
  return (message as { role?: unknown }).role as string;
}

function pathToLeaf(entries: SessionEntry[], leafId?: string | null, suppliedIndex?: Map<string, SessionEntry>): SessionEntry[] {
  if (leafId === null) return [];
  const index = suppliedIndex ?? new Map(entries.map((entry) => [entry.id, entry]));
  let current = leafId === undefined ? entries.at(-1) : index.get(leafId);
  if (current === undefined) current = entries.at(-1);
  if (current === undefined) return [];

  const reversed: SessionEntry[] = [];
  const visited = new Set<string>();
  while (current !== undefined && !visited.has(current.id)) {
    visited.add(current.id);
    reversed.push(current);
    current = current.parentId === null ? undefined : index.get(current.parentId);
  }
  return reversed.reverse();
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "compaction") return entry;
  }
  return null;
}

export function buildContextEntries(
  entries: SessionEntry[],
  leafId?: string | null,
  suppliedIndex?: Map<string, SessionEntry>,
): SessionEntry[] {
  const path = pathToLeaf(entries, leafId, suppliedIndex);
  const compaction = getLatestCompactionEntry(path);
  if (compaction === null) return path;
  const compactionIndex = path.findIndex((entry) => entry.id === compaction.id);
  if (compactionIndex < 0) return path;

  const result: SessionEntry[] = [compaction];
  let keep = false;
  for (let index = 0; index < compactionIndex; index += 1) {
    const entry = path[index] as SessionEntry;
    if (entry.id === compaction.firstKeptEntryId) keep = true;
    if (keep) result.push(entry);
  }
  result.push(...path.slice(compactionIndex + 1));
  return result;
}

function customContextMessage(entry: CustomMessageEntry): CustomMessage {
  const base: CustomMessage = {
    role: "custom",
    customType: entry.customType,
    content: entry.content ?? [],
    display: entry.display,
    timestamp: new Date(entry.timestamp).getTime(),
  };
  return entry.details === undefined ? base : { ...base, details: entry.details };
}

export function sessionEntryToContextMessages(entry: SessionEntry): SessionContextMessage[] {
  if (entry.type === "message") {
    const message = entry.message as PersistedSessionMessage & { content?: unknown };
    const role = messageRole(message);
    if (["user", "assistant", "tool", "toolResult"].includes(role) && message.content == null) {
      return [{ ...message, content: [] } as PersistedSessionMessage];
    }
    return [message];
  }
  if (entry.type === "custom_message") return [customContextMessage(entry)];
  if (entry.type === "branch_summary" && entry.summary !== "") {
    const message: BranchSummaryMessage = {
      role: "branchSummary",
      summary: entry.summary,
      fromId: entry.fromId,
      timestamp: new Date(entry.timestamp).getTime(),
    };
    return [message];
  }
  if (entry.type === "compaction") {
    const message: CompactionSummaryMessage = {
      role: "compactionSummary",
      summary: entry.summary,
      tokensBefore: entry.tokensBefore,
      timestamp: new Date(entry.timestamp).getTime(),
    };
    return [message];
  }
  return [];
}

function contextSettings(path: SessionEntry[]): Pick<SessionContext, "thinkingLevel" | "model"> {
  let thinkingLevel = "off";
  let model: SessionContext["model"] = null;
  for (const entry of path) {
    if (entry.type === "thinking_level_change") thinkingLevel = entry.thinkingLevel;
    else if (entry.type === "model_change") model = { provider: entry.provider, modelId: entry.modelId };
  }
  return { thinkingLevel, model };
}

export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  suppliedIndex?: Map<string, SessionEntry>,
): SessionContext {
  const settings = contextSettings(pathToLeaf(entries, leafId, suppliedIndex));
  return {
    messages: buildContextEntries(entries, leafId, suppliedIndex).flatMap(sessionEntryToContextMessages),
    thinkingLevel: settings.thinkingLevel,
    model: settings.model,
  };
}

function defaultSessionDirPath(cwd: string, agentDir = agentDirectory()): string {
  const normalized = filesystemPathIdentity(cwd);
  const safe = `--${normalized.replace(/^[/\\]/u, "").replaceAll(/[/\\:]/gu, "-")}--`;
  return join(absolutePath(agentDir), "sessions", safe);
}

export function getDefaultSessionDir(cwd: string, agentDir = agentDirectory()): string {
  const path = defaultSessionDirPath(cwd, agentDir);
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
  return path;
}

function isConversationalMessage(message: PersistedSessionMessage): message is CanonicalMessage & { timestamp?: number } {
  const role = messageRole(message);
  return role === "user" || role === "assistant";
}

function textFromMessage(message: PersistedSessionMessage): string {
  if (!("content" in message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => block !== null && typeof block === "object" && block.type === "text" ? [block.text] : [])
    .join(" ");
}

function messageActivity(entry: SessionMessageEntry): number | undefined {
  if (!isConversationalMessage(entry.message)) return undefined;
  const numeric = (entry.message as { timestamp?: unknown }).timestamp;
  if (typeof numeric === "number") return numeric;
  const parsed = new Date(entry.timestamp).getTime();
  return Number.isNaN(parsed) ? undefined : parsed;
}

function invalidSessionFile(path: string): Error {
  return new Error(`Session file is not a valid Rigyn session: ${path}`);
}

async function readSessionInfo(path: string): Promise<SessionInfo> {
  const details = await stat(path);
  let header: SessionHeader | null = null;
  let count = 0;
  let first = "";
  let name: string | undefined;
  let lastActivity: number | undefined;
  const searchable: string[] = [];
  const input = createReadStream(path, { encoding: "utf8" });
  let endedWithNewline = false;
  input.on("data", (chunk) => { endedWithNewline = String(chunk).endsWith("\n"); });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let pendingLine: string | undefined;
  let pendingLineNumber = 0;
  let lineNumber = 0;

  const consume = (entry: FileEntry | null): void => {
    if (entry === null) return;
    if (header === null) {
      if (entry.type !== "session" || typeof (entry as { id?: unknown }).id !== "string") {
        throw invalidSessionFile(path);
      }
      header = entry;
      return;
    }
    if (entry.type === "session") throw invalidSessionFile(path);
    if (entry.type === "session_info") name = entry.name?.trim() || undefined;
    if (entry.type !== "message") return;
    count += 1;
    const activity = messageActivity(entry);
    if (activity !== undefined) lastActivity = Math.max(lastActivity ?? 0, activity);
    if (!isConversationalMessage(entry.message)) return;
    const text = textFromMessage(entry.message);
    if (text === "") return;
    searchable.push(text);
    if (first === "" && messageRole(entry.message) === "user") first = text;
  };

  for await (const line of lines) {
    lineNumber += 1;
    if (pendingLine !== undefined) consume(parseCompleteLine(pendingLine, path, pendingLineNumber));
    pendingLine = line;
    pendingLineNumber = lineNumber;
  }
  if (pendingLine !== undefined) {
    consume(endedWithNewline
      ? parseCompleteLine(pendingLine, path, pendingLineNumber)
      : parseTailLine(pendingLine));
  }
  const sessionHeader = header as SessionHeader | null;
  if (sessionHeader === null) throw invalidSessionFile(path);

  const headerTime = new Date(sessionHeader.timestamp).getTime();
  const modified = lastActivity !== undefined && lastActivity > 0
    ? new Date(lastActivity)
    : Number.isNaN(headerTime) ? details.mtime : new Date(headerTime);
  const result: SessionInfo = {
    path,
    id: sessionHeader.id,
    cwd: typeof sessionHeader.cwd === "string" ? sessionHeader.cwd : "",
    created: new Date(sessionHeader.timestamp),
    modified,
    messageCount: count,
    firstMessage: first || "(no messages)",
    allMessagesText: searchable.join(" "),
  };
  if (name !== undefined) result.name = name;
  if (sessionHeader.parentSession !== undefined) result.parentSessionPath = sessionHeader.parentSession;
  return result;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadSessionInfos(files: string[], onLoaded: () => void): Promise<SessionScanResult> {
  const results: Array<SessionInfo | SessionFileIssue | undefined> = Array.from({ length: files.length });
  let cursor = 0;
  const workers = Array.from({ length: Math.min(INFO_READ_CONCURRENCY, files.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const file = files[index];
      if (file === undefined) return;
      try {
        results[index] = await readSessionInfo(file);
      } catch (error) {
        results[index] = { path: file, error: errorText(error) };
      } finally {
        onLoaded();
      }
    }
  });
  await Promise.all(workers);
  return {
    sessions: results.filter((result): result is SessionInfo => result !== undefined && !("error" in result)),
    invalid: results.filter((result): result is SessionFileIssue => result !== undefined && "error" in result),
  };
}

async function scanDirectory(directory: string, progress?: SessionListProgress): Promise<SessionScanResult> {
  if (!existsSync(directory)) return { sessions: [], invalid: [] };
  try {
    const files = (await readdir(directory))
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .map((name) => join(directory, name));
    let loaded = 0;
    return await loadSessionInfos(files, () => {
      loaded += 1;
      progress?.(loaded, files.length);
    });
  } catch (error) {
    return { sessions: [], invalid: [{ path: directory, error: errorText(error) }] };
  }
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortSessions(sessions: SessionInfo[]): SessionInfo[] {
  return sessions.sort((left, right) =>
    right.modified.getTime() - left.modified.getTime() || comparePath(left.path, right.path));
}

async function scanAllSessions(
  customDirectory: string | undefined,
  progress?: SessionListProgress,
): Promise<SessionScanResult> {
  if (customDirectory !== undefined) return await scanDirectory(customDirectory, progress);
  const root = sessionsDirectory();
  if (!existsSync(root)) return { sessions: [], invalid: [] };

  let directories: string[];
  try {
    directories = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
      .sort(comparePath);
  } catch (error) {
    return { sessions: [], invalid: [{ path: root, error: errorText(error) }] };
  }

  const files: string[] = [];
  const invalid: SessionFileIssue[] = [];
  for (const directory of directories) {
    try {
      files.push(...(await readdir(directory))
        .filter((name) => name.endsWith(".jsonl"))
        .sort()
        .map((name) => join(directory, name)));
    } catch (error) {
      invalid.push({ path: directory, error: errorText(error) });
    }
  }

  let loaded = 0;
  const scanned = await loadSessionInfos(files, () => {
    loaded += 1;
    progress?.(loaded, files.length);
  });
  return { sessions: scanned.sessions, invalid: [...invalid, ...scanned.invalid] };
}

function assistantExists(entries: FileEntry[]): boolean {
  return entries.some((entry) => entry.type === "message" && messageRole(entry.message) === "assistant");
}

export class SessionManager {
  private sessionId = "";
  private sessionFile: string | undefined;
  private readonly sessionDir: string;
  private readonly cwd: string;
  private readonly persist: boolean;
  private flushed = false;
  private appendRecovery: SessionAppendRecovery | undefined;
  private fileEntries: FileEntry[] = [];
  private readonly byId = new Map<string, SessionEntry>();
  private readonly labelsById = new Map<string, string>();
  private readonly labelTimestampsById = new Map<string, string>();
  private readonly appendListeners = new Set<(entry: Readonly<SessionEntry>) => void>();
  private leafId: string | null = null;

  private constructor(
    cwd: string,
    sessionDir: string,
    sessionFile: string | undefined,
    persist: boolean,
    newSessionOptions?: NewSessionOptions,
    preloadedFile?: LoadedSessionFile,
  ) {
    this.cwd = absolutePath(cwd);
    this.sessionDir = sessionDir === "" ? "" : absolutePath(sessionDir);
    this.persist = persist;
    if (persist && !existsSync(this.sessionDir)) mkdirSync(this.sessionDir, { recursive: true });
    if (sessionFile === undefined) this.newSession(newSessionOptions);
    else this.setFile(sessionFile, preloadedFile);
  }

  setSessionFile(path: string): void {
    this.setFile(path);
  }

  private setFile(path: string, preloadedFile?: LoadedSessionFile): void {
    this.sessionFile = absolutePath(path);
    if (!existsSync(this.sessionFile)) {
      const explicit = this.sessionFile;
      this.newSession();
      this.sessionFile = explicit;
      return;
    }

    const loaded = preloadedFile ?? loadSessionFile(this.sessionFile);
    this.fileEntries = loaded.entries;
    this.appendRecovery = loaded.recovery;
    if (this.fileEntries.length === 0) {
      if (statSync(this.sessionFile).size > 0) {
        throw new Error(`Session file is not a valid Rigyn session: ${this.sessionFile}`);
      }
      const explicit = this.sessionFile;
      this.newSession();
      this.sessionFile = explicit;
      this.rewriteFile();
      this.flushed = true;
      return;
    }

    const header = this.fileEntries.find((entry) => entry.type === "session") as SessionHeader | undefined;
    this.sessionId = header?.id ?? newSessionId();
    if (applyMigrations(this.fileEntries)) this.rewriteFile();
    this.rebuildIndex();
    this.flushed = true;
  }

  newSession(options?: NewSessionOptions): string | undefined {
    if (options?.id !== undefined) assertValidSessionId(options.id);
    this.sessionId = options?.id ?? newSessionId();
    const timestamp = new Date().toISOString();
    const header: SessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: this.sessionId,
      timestamp,
      cwd: this.cwd,
    };
    if (options?.parentSession !== undefined) header.parentSession = options.parentSession;
    this.fileEntries = [header];
    this.byId.clear();
    this.labelsById.clear();
    this.labelTimestampsById.clear();
    this.leafId = null;
    this.flushed = false;
    this.appendRecovery = undefined;
    if (this.persist) {
      const fileTime = timestamp.replace(/[:.]/gu, "-");
      this.sessionFile = join(this.sessionDir, `${fileTime}_${this.sessionId}.jsonl`);
    }
    return this.sessionFile;
  }

  private rebuildIndex(): void {
    this.byId.clear();
    this.labelsById.clear();
    this.labelTimestampsById.clear();
    this.leafId = null;
    for (const entry of this.fileEntries) {
      if (entry.type === "session") continue;
      this.byId.set(entry.id, entry);
      this.leafId = entry.id;
      if (entry.type !== "label") continue;
      if (entry.label) {
        this.labelsById.set(entry.targetId, entry.label);
        this.labelTimestampsById.set(entry.targetId, entry.timestamp);
      } else {
        this.labelsById.delete(entry.targetId);
        this.labelTimestampsById.delete(entry.targetId);
      }
    }
  }

  private rewriteFile(): void {
    if (!this.persist || this.sessionFile === undefined) return;
    const descriptor = openSync(this.sessionFile, "w");
    try {
      for (const entry of this.fileEntries) writeFileSync(descriptor, `${JSON.stringify(entry)}\n`);
    } finally {
      closeSync(descriptor);
    }
    this.appendRecovery = undefined;
  }

  private prepareAppend(): void {
    if (this.sessionFile === undefined || this.appendRecovery === undefined) return;
    if (this.appendRecovery.truncateTo !== undefined) {
      truncateSync(this.sessionFile, this.appendRecovery.truncateTo);
    } else if (this.appendRecovery.addSeparator === true) {
      appendFileSync(this.sessionFile, "\n");
    }
    this.appendRecovery = undefined;
  }

  private persistEntry(entry: SessionEntry): void {
    if (!this.persist || this.sessionFile === undefined) return;
    if (!assistantExists(this.fileEntries)) {
      if (this.flushed) {
        this.prepareAppend();
        appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
      }
      else this.flushed = false;
      return;
    }
    if (!this.flushed) {
      const descriptor = openSync(this.sessionFile, "wx");
      try {
        for (const fileEntry of this.fileEntries) writeFileSync(descriptor, `${JSON.stringify(fileEntry)}\n`);
      } finally {
        closeSync(descriptor);
      }
      this.flushed = true;
      return;
    }
    this.prepareAppend();
    appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
  }

  private append(entry: SessionEntry): string {
    this.fileEntries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
    this.persistEntry(entry);
    for (const listener of this.appendListeners) listener(structuredClone(entry));
    return entry.id;
  }

  /** Observes successfully committed entries without exposing mutable storage state. */
  onAppend(listener: (entry: Readonly<SessionEntry>) => void): () => void {
    this.appendListeners.add(listener);
    return () => this.appendListeners.delete(listener);
  }

  private entryBase<T extends SessionEntry["type"]>(type: T): { type: T; id: string; parentId: string | null; timestamp: string } {
    return { type, id: shortEntryId(this.byId), parentId: this.leafId, timestamp: new Date().toISOString() };
  }

  isPersisted(): boolean {
    return this.persist;
  }

  getCwd(): string {
    return this.cwd;
  }

  getSessionDir(): string {
    return this.sessionDir;
  }

  usesDefaultSessionDir(): boolean {
    return sameFilesystemPath(this.sessionDir, defaultSessionDirPath(this.cwd));
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionFile(): string | undefined {
    return this.sessionFile;
  }

  appendMessage(message: PersistedSessionMessage): string {
    return this.append({ ...this.entryBase("message"), message });
  }

  appendThinkingLevelChange(thinkingLevel: string): string {
    const entry: ThinkingLevelChangeEntry = { ...this.entryBase("thinking_level_change"), thinkingLevel };
    return this.append(entry);
  }

  appendModelChange(provider: string, modelId: string): string {
    const entry: ModelChangeEntry = { ...this.entryBase("model_change"), provider, modelId };
    return this.append(entry);
  }

  appendCompaction<T = unknown>(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: T,
    fromHook?: boolean,
    usage?: NormalizedUsage,
  ): string {
    const entry: CompactionEntry<T> = {
      ...this.entryBase("compaction"),
      summary,
      firstKeptEntryId,
      tokensBefore,
      ...(usage === undefined ? {} : { usage: structuredClone(usage) }),
      ...(details === undefined ? {} : { details }),
      ...(fromHook === undefined ? {} : { fromHook }),
    };
    return this.append(entry);
  }

  appendCustomEntry<T = unknown>(customType: string, data?: T): string {
    const entry: CustomEntry<T> = {
      ...this.entryBase("custom"),
      customType,
      ...(data === undefined ? {} : { data }),
    };
    return this.append(entry);
  }

  appendSessionInfo(name: string): string {
    const entry: SessionInfoEntry = {
      ...this.entryBase("session_info"),
      name: name.replace(/[\r\n]+/gu, " ").trim(),
    };
    return this.append(entry);
  }

  getSessionName(): string | undefined {
    const entries = this.getEntries();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.type === "session_info") return entry.name?.trim() || undefined;
    }
    return undefined;
  }

  appendCustomMessageEntry<T = unknown>(
    customType: string,
    content: string | (TextBlock | ImageBlock)[],
    display: boolean,
    details?: T,
  ): string {
    const entry: CustomMessageEntry<T> = {
      ...this.entryBase("custom_message"),
      customType,
      content,
      display,
      ...(details === undefined ? {} : { details }),
    };
    return this.append(entry);
  }

  getLeafId(): string | null {
    return this.leafId;
  }

  getLeafEntry(): SessionEntry | undefined {
    return this.leafId === null ? undefined : this.byId.get(this.leafId);
  }

  getEntry(id: string): SessionEntry | undefined {
    return this.byId.get(id);
  }

  getChildren(parentId: string): SessionEntry[] {
    return [...this.byId.values()].filter((entry) => entry.parentId === parentId);
  }

  getLabel(id: string): string | undefined {
    return this.labelsById.get(id);
  }

  appendLabelChange(targetId: string, label: string | undefined): string {
    if (!this.byId.has(targetId)) throw new Error(`Entry ${targetId} not found`);
    const entry: LabelEntry = { ...this.entryBase("label"), targetId, label };
    this.append(entry);
    if (label) {
      this.labelsById.set(targetId, label);
      this.labelTimestampsById.set(targetId, entry.timestamp);
    } else {
      this.labelsById.delete(targetId);
      this.labelTimestampsById.delete(targetId);
    }
    return entry.id;
  }

  getBranch(fromId?: string): SessionEntry[] {
    const start = fromId ?? this.leafId;
    const reversed: SessionEntry[] = [];
    const visited = new Set<string>();
    let current = start === null ? undefined : this.byId.get(start);
    while (current !== undefined && !visited.has(current.id)) {
      visited.add(current.id);
      reversed.push(current);
      current = current.parentId === null ? undefined : this.byId.get(current.parentId);
    }
    return reversed.reverse();
  }

  buildContextEntries(): SessionEntry[] {
    return buildContextEntries(this.getEntries(), this.leafId, this.byId);
  }

  buildSessionContext(): SessionContext {
    return buildSessionContext(this.getEntries(), this.leafId, this.byId);
  }

  getHeader(): SessionHeader | null {
    return (this.fileEntries.find((entry) => entry.type === "session") as SessionHeader | undefined) ?? null;
  }

  getEntries(): SessionEntry[] {
    return this.fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
  }

  getTree(): SessionTreeNode[] {
    const nodes = new Map<string, SessionTreeNode>();
    const roots: SessionTreeNode[] = [];
    for (const entry of this.getEntries()) {
      const node: SessionTreeNode = { entry, children: [] };
      const label = this.labelsById.get(entry.id);
      const labelTimestamp = this.labelTimestampsById.get(entry.id);
      if (label !== undefined) node.label = label;
      if (labelTimestamp !== undefined) node.labelTimestamp = labelTimestamp;
      nodes.set(entry.id, node);
    }
    for (const entry of this.getEntries()) {
      const node = nodes.get(entry.id) as SessionTreeNode;
      if (entry.parentId === null || entry.parentId === entry.id) roots.push(node);
      else {
        const parent = nodes.get(entry.parentId);
        if (parent === undefined) roots.push(node);
        else parent.children.push(node);
      }
    }
    const pending = [...roots];
    while (pending.length > 0) {
      const node = pending.pop() as SessionTreeNode;
      node.children.sort((left, right) =>
        new Date(left.entry.timestamp).getTime() - new Date(right.entry.timestamp).getTime());
      pending.push(...node.children);
    }
    return roots;
  }

  branch(branchFromId: string): void {
    if (!this.byId.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);
    this.leafId = branchFromId;
  }

  resetLeaf(): void {
    this.leafId = null;
  }

  branchWithSummary(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
    usage?: NormalizedUsage,
  ): string {
    if (branchFromId !== null && !this.byId.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);
    this.leafId = branchFromId;
    const entry: BranchSummaryEntry = {
      ...this.entryBase("branch_summary"),
      parentId: branchFromId,
      fromId: branchFromId ?? "root",
      summary,
      ...(usage === undefined ? {} : { usage: structuredClone(usage) }),
      ...(details === undefined ? {} : { details }),
      ...(fromHook === undefined ? {} : { fromHook }),
    };
    return this.append(entry);
  }

  createBranchedSession(leafId: string): string | undefined {
    const sourceFile = this.sessionFile;
    const path = this.getBranch(leafId);
    if (path.length === 0) throw new Error(`Entry ${leafId} not found`);

    const retained: SessionEntry[] = [];
    let parentId: string | null = null;
    for (const entry of path) {
      if (entry.type === "label") continue;
      retained.push({ ...entry, parentId });
      parentId = entry.id;
    }

    const sessionId = newSessionId();
    const timestamp = new Date().toISOString();
    const fileTime = timestamp.replace(/[:.]/gu, "-");
    const targetFile = join(this.sessionDir, `${fileTime}_${sessionId}.jsonl`);
    const header: SessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: sessionId,
      timestamp,
      cwd: this.cwd,
    };
    if (this.persist && sourceFile !== undefined) header.parentSession = sourceFile;

    const retainedIds = new Set(retained.map((entry) => entry.id));
    const labelValues = [...this.labelsById.entries()]
      .filter(([targetId]) => retainedIds.has(targetId))
      .map(([targetId, label]) => ({ targetId, label, timestamp: this.labelTimestampsById.get(targetId) as string }));
    const labels: LabelEntry[] = [];
    let labelParent = retained.at(-1)?.id ?? null;
    for (const label of labelValues) {
      const id = shortEntryId(retainedIds);
      retainedIds.add(id);
      labels.push({
        type: "label",
        id,
        parentId: labelParent,
        timestamp: label.timestamp,
        targetId: label.targetId,
        label: label.label,
      });
      labelParent = id;
    }

    this.fileEntries = [header, ...retained, ...labels];
    this.sessionId = sessionId;
    this.rebuildIndex();
    if (!this.persist) {
      this.flushed = false;
      return undefined;
    }

    this.sessionFile = targetFile;
    this.appendRecovery = undefined;
    if (assistantExists(this.fileEntries)) {
      this.rewriteFile();
      this.flushed = true;
    } else {
      this.flushed = false;
    }
    return targetFile;
  }

  static create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager {
    const directory = sessionDir === undefined ? getDefaultSessionDir(cwd) : absolutePath(sessionDir);
    return new SessionManager(cwd, directory, undefined, true, options);
  }

  static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager {
    const file = absolutePath(path);
    let header: SessionHeader | null = null;
    let preloaded: LoadedSessionFile | undefined;
    if (cwdOverride === undefined && existsSync(file)) {
      try {
        header = readHeader(file);
      } catch (error) {
        if (!(error instanceof HeaderScanLimitError)) throw error;
        preloaded = loadSessionFile(file);
        const first = preloaded.entries[0];
        header = first?.type === "session" ? first : null;
      }
    }
    const cwd = cwdOverride ?? (header === null ? undefined : headerCwd(header)) ?? process.cwd();
    const directory = sessionDir === undefined ? dirname(file) : absolutePath(sessionDir);
    return new SessionManager(cwd, directory, file, true, undefined, preloaded);
  }

  static continueRecent(cwd: string, sessionDir?: string): SessionManager {
    const directory = sessionDir === undefined ? getDefaultSessionDir(cwd) : absolutePath(sessionDir);
    const filterByCwd = sessionDir !== undefined && !sameFilesystemPath(directory, defaultSessionDirPath(cwd));
    const recent = findMostRecentSession(directory, filterByCwd ? cwd : undefined);
    return recent === null
      ? new SessionManager(cwd, directory, undefined, true)
      : new SessionManager(cwd, directory, recent, true);
  }

  static inMemory(cwd = process.cwd(), options?: NewSessionOptions): SessionManager {
    return new SessionManager(cwd, "", undefined, false, options);
  }

  static forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager {
    const source = absolutePath(sourcePath);
    const cwd = absolutePath(targetCwd);
    const sourceEntries = loadEntriesFromFile(source);
    if (sourceEntries.length === 0) throw new Error(`Cannot fork an empty or invalid session: ${source}`);
    const sourceHeader = sourceEntries.find((entry) => entry.type === "session");
    if (sourceHeader === undefined) throw new Error(`Cannot fork a session without a header: ${source}`);
    if (options?.id !== undefined) assertValidSessionId(options.id);

    const directory = sessionDir === undefined ? getDefaultSessionDir(cwd) : absolutePath(sessionDir);
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
    const id = options?.id ?? newSessionId();
    const timestamp = new Date().toISOString();
    const target = join(directory, `${timestamp.replace(/[:.]/gu, "-")}_${id}.jsonl`);
    const header: SessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id,
      timestamp,
      cwd,
      parentSession: source,
    };
    writeFileSync(target, `${JSON.stringify(header)}\n`, { flag: "wx" });
    for (const entry of sourceEntries) {
      if (entry.type !== "session") appendFileSync(target, `${JSON.stringify(entry)}\n`);
    }
    return new SessionManager(cwd, directory, target, true);
  }

  static async list(cwd: string, sessionDir?: string, progress?: SessionListProgress): Promise<SessionInfo[]> {
    return (await SessionManager.inspect(cwd, sessionDir, false, progress)).sessions;
  }

  static async inspectFile(path: string): Promise<SessionInfo> {
    return await readSessionInfo(absolutePath(path));
  }

  static async inspect(
    cwd: string,
    sessionDir?: string,
    allWorkspaces = false,
    progress?: SessionListProgress,
  ): Promise<SessionScanResult> {
    if (allWorkspaces) {
      const customDirectory = sessionDir === undefined ? undefined : absolutePath(sessionDir);
      const scanned = await scanAllSessions(customDirectory, progress);
      sortSessions(scanned.sessions);
      scanned.invalid.sort((left, right) => comparePath(left.path, right.path));
      return scanned;
    }

    const directory = sessionDir === undefined ? getDefaultSessionDir(cwd) : absolutePath(sessionDir);
    const filterByCwd = sessionDir !== undefined && !sameFilesystemPath(directory, defaultSessionDirPath(cwd));
    const wantedCwd = cwd;
    const scanned = await scanDirectory(directory, progress);
    scanned.sessions = sortSessions(scanned.sessions
      .filter((session) => !filterByCwd || sameCwd(session.cwd, wantedCwd)));
    scanned.invalid.sort((left, right) => comparePath(left.path, right.path));
    return scanned;
  }

  static async listAll(progress?: SessionListProgress): Promise<SessionInfo[]>;
  static async listAll(sessionDir?: string, progress?: SessionListProgress): Promise<SessionInfo[]>;
  static async listAll(
    sessionDirOrProgress?: string | SessionListProgress,
    progressArgument?: SessionListProgress,
  ): Promise<SessionInfo[]> {
    const customDirectory = typeof sessionDirOrProgress === "string" ? absolutePath(sessionDirOrProgress) : undefined;
    const progress = typeof sessionDirOrProgress === "function" ? sessionDirOrProgress : progressArgument;
    const scanned = await scanAllSessions(customDirectory, progress);
    return sortSessions(scanned.sessions);
  }
}

export type ReadonlySessionManager = Pick<
  SessionManager,
  | "isPersisted"
  | "getCwd"
  | "getSessionDir"
  | "getSessionId"
  | "getSessionFile"
  | "getLeafId"
  | "getLeafEntry"
  | "getEntry"
  | "getLabel"
  | "getBranch"
  | "buildContextEntries"
  | "getHeader"
  | "getEntries"
  | "getTree"
  | "getSessionName"
>;
