import { uuidv7 } from "@rigyn/models";
import type { FileSystem, JsonlSessionMetadata, LeafEntry, SessionStorage, SessionTreeEntry } from "../types.js";
import { SessionError, toError } from "../types.js";
import { getFileSystemResultOrThrow } from "./repo-utils.js";

type JsonlFs = Pick<FileSystem, "readTextFile" | "readTextLines" | "writeFile" | "appendFile">;
interface SessionHeader { type: "session"; version: 3; id: string; timestamp: string; cwd: string; parentSession?: string; metadata?: Record<string, unknown>; }

function nextId(entries: Map<string, SessionTreeEntry>): string {
  for (let attempt = 0; attempt < 100; attempt++) { const id = uuidv7().slice(-8); if (!entries.has(id)) return id; }
  return uuidv7();
}
function invalidSession(path: string, message: string, cause?: Error): SessionError { return new SessionError("invalid_session", `Invalid JSONL session file ${path}: ${message}`, cause); }
function invalidEntry(path: string, line: number, message: string, cause?: Error): SessionError { return new SessionError("invalid_entry", `Invalid JSONL session file ${path}: line ${line} ${message}`, cause); }
function parseHeader(line: string, path: string): SessionHeader {
  let value: unknown;
  try { value = JSON.parse(line); } catch (error) { throw invalidSession(path, "first line is not a valid session header", toError(error)); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidSession(path, "first line is not a valid session header");
  const header = value as Partial<SessionHeader>;
  if (header.type !== "session") throw invalidSession(path, "first line is not a valid session header");
  if (header.version !== 3) throw invalidSession(path, "unsupported session version");
  if (!header.id || typeof header.id !== "string") throw invalidSession(path, "session header is missing id");
  if (!header.timestamp || typeof header.timestamp !== "string") throw invalidSession(path, "session header is missing timestamp");
  if (!header.cwd || typeof header.cwd !== "string") throw invalidSession(path, "session header is missing cwd");
  if (header.parentSession !== undefined && typeof header.parentSession !== "string") throw invalidSession(path, "session header parentSession must be a string");
  if (header.metadata !== undefined && (!header.metadata || typeof header.metadata !== "object" || Array.isArray(header.metadata))) throw invalidSession(path, "session header metadata must be an object");
  return { type: "session", version: 3, id: header.id, timestamp: header.timestamp, cwd: header.cwd, ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }), ...(header.metadata === undefined ? {} : { metadata: header.metadata }) };
}
function parseEntry(line: string, path: string, lineNumber: number): SessionTreeEntry {
  let value: unknown;
  try { value = JSON.parse(line); } catch (error) { throw invalidEntry(path, lineNumber, "is not valid JSON", toError(error)); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidEntry(path, lineNumber, "is not a valid session entry");
  const entry = value as { type?: unknown; id?: unknown; parentId?: unknown; timestamp?: unknown; targetId?: unknown };
  if (typeof entry.type !== "string") throw invalidEntry(path, lineNumber, "is missing entry type");
  if (typeof entry.id !== "string" || !entry.id) throw invalidEntry(path, lineNumber, "is missing entry id");
  if (entry.parentId !== null && typeof entry.parentId !== "string") throw invalidEntry(path, lineNumber, "has invalid parentId");
  if (typeof entry.timestamp !== "string" || !entry.timestamp) throw invalidEntry(path, lineNumber, "is missing timestamp");
  if (entry.type === "leaf" && entry.targetId !== null && typeof entry.targetId !== "string") throw invalidEntry(path, lineNumber, "has invalid targetId");
  return value as SessionTreeEntry;
}
const leafAfter = (entry: SessionTreeEntry): string | null => entry.type === "leaf" ? entry.targetId : entry.id;
const metadataFrom = (header: SessionHeader, path: string): JsonlSessionMetadata => ({ id: header.id, createdAt: header.timestamp, cwd: header.cwd, path, ...(header.parentSession === undefined ? {} : { parentSessionPath: header.parentSession }), ...(header.metadata === undefined ? {} : { metadata: header.metadata }) });

export async function loadJsonlSessionMetadata(fs: JsonlFs, path: string): Promise<JsonlSessionMetadata> {
  const line = getFileSystemResultOrThrow(await fs.readTextLines(path, { maxLines: 1 }), `Failed to read session header ${path}`)[0];
  if (!line?.trim()) throw invalidSession(path, "missing session header");
  return metadataFrom(parseHeader(line, path), path);
}

export class JsonlSessionStorage implements SessionStorage<JsonlSessionMetadata> {
  readonly #fs: JsonlFs; readonly #path: string; readonly #metadata: JsonlSessionMetadata;
  #entries: SessionTreeEntry[]; #byId: Map<string, SessionTreeEntry>; #labels = new Map<string, string>(); #leaf: string | null;
  private constructor(fs: JsonlFs, path: string, header: SessionHeader, entries: SessionTreeEntry[], leaf: string | null) {
    this.#fs = fs; this.#path = path; this.#metadata = metadataFrom(header, path); this.#entries = entries; this.#byId = new Map(entries.map((entry) => [entry.id, entry])); this.#leaf = leaf;
    for (const entry of entries) this.#updateLabel(entry);
  }
  #updateLabel(entry: SessionTreeEntry): void { if (entry.type === "label") { const label = entry.label?.trim(); if (label) this.#labels.set(entry.targetId, label); else this.#labels.delete(entry.targetId); } }
  static async open(fs: JsonlFs, path: string): Promise<JsonlSessionStorage> {
    const content = getFileSystemResultOrThrow(await fs.readTextFile(path), `Failed to read session ${path}`);
    const lines = content.split("\n").filter((line) => line.trim());
    if (lines.length === 0) throw invalidSession(path, "missing session header");
    const header = parseHeader(lines[0]!, path); const entries: SessionTreeEntry[] = []; let leaf: string | null = null;
    for (let index = 1; index < lines.length; index++) { const entry = parseEntry(lines[index]!, path, index + 1); entries.push(entry); leaf = leafAfter(entry); }
    return new JsonlSessionStorage(fs, path, header, entries, leaf);
  }
  static async create(fs: JsonlFs, path: string, options: { cwd: string; sessionId: string; parentSessionPath?: string; metadata?: Record<string, unknown> }): Promise<JsonlSessionStorage> {
    const header: SessionHeader = { type: "session", version: 3, id: options.sessionId, timestamp: new Date().toISOString(), cwd: options.cwd, ...(options.parentSessionPath === undefined ? {} : { parentSession: options.parentSessionPath }), ...(options.metadata === undefined ? {} : { metadata: options.metadata }) };
    getFileSystemResultOrThrow(await fs.writeFile(path, `${JSON.stringify(header)}\n`), `Failed to create session ${path}`);
    return new JsonlSessionStorage(fs, path, header, [], null);
  }
  async getMetadata(): Promise<JsonlSessionMetadata> { return this.#metadata; }
  async getLeafId(): Promise<string | null> { if (this.#leaf !== null && !this.#byId.has(this.#leaf)) throw new SessionError("invalid_session", `Entry ${this.#leaf} not found`); return this.#leaf; }
  async setLeafId(leafId: string | null): Promise<void> {
    if (leafId !== null && !this.#byId.has(leafId)) throw new SessionError("not_found", `Entry ${leafId} not found`);
    const entry: LeafEntry = { type: "leaf", id: nextId(this.#byId), parentId: this.#leaf, timestamp: new Date().toISOString(), targetId: leafId };
    getFileSystemResultOrThrow(await this.#fs.appendFile(this.#path, `${JSON.stringify(entry)}\n`), `Failed to append session leaf ${entry.id}`);
    this.#entries.push(entry); this.#byId.set(entry.id, entry); this.#leaf = leafId;
  }
  async createEntryId(): Promise<string> { return nextId(this.#byId); }
  async appendEntry(entry: SessionTreeEntry): Promise<void> {
    getFileSystemResultOrThrow(await this.#fs.appendFile(this.#path, `${JSON.stringify(entry)}\n`), `Failed to append session entry ${entry.id}`);
    this.#entries.push(entry); this.#byId.set(entry.id, entry); this.#updateLabel(entry); this.#leaf = leafAfter(entry);
  }
  async getEntry(id: string): Promise<SessionTreeEntry | undefined> { return this.#byId.get(id); }
  async findEntries<T extends SessionTreeEntry["type"]>(type: T): Promise<Array<Extract<SessionTreeEntry, { type: T }>>> { return this.#entries.filter((entry): entry is Extract<SessionTreeEntry, { type: T }> => entry.type === type); }
  async getLabel(id: string): Promise<string | undefined> { return this.#labels.get(id); }
  async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
    if (leafId === null) return []; const path: SessionTreeEntry[] = []; let cursor = this.#byId.get(leafId);
    if (!cursor) throw new SessionError("not_found", `Entry ${leafId} not found`);
    while (cursor) { path.unshift(cursor); if (cursor.parentId === null) break; const parent = this.#byId.get(cursor.parentId); if (!parent) throw new SessionError("invalid_session", `Entry ${cursor.parentId} not found`); cursor = parent; }
    return path;
  }
  async getPathToRootOrCompaction(leafId: string | null): Promise<SessionTreeEntry[]> {
    if (leafId === null) return []; const path: SessionTreeEntry[] = []; let stopAtEntryId: string | null = null; let cursor = this.#byId.get(leafId);
    if (!cursor) throw new SessionError("not_found", `Entry ${leafId} not found`);
    while (cursor) { path.unshift(cursor); if (stopAtEntryId !== null && cursor.id === stopAtEntryId) break; if (cursor.type === "compaction") { if (cursor.retainedTail) break; stopAtEntryId = cursor.firstKeptEntryId ?? null; } if (cursor.parentId === null) break; const parent = this.#byId.get(cursor.parentId); if (!parent) throw new SessionError("invalid_session", `Entry ${cursor.parentId} not found`); cursor = parent; }
    return path;
  }
  async getEntries(): Promise<SessionTreeEntry[]> { return this.#entries.slice(); }
}
