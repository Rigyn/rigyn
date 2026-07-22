import type { FileSystem, JsonlSessionCreateOptions, JsonlSessionListOptions, JsonlSessionMetadata, JsonlSessionRepoApi } from "../types.js";
import { SessionError, toError } from "../types.js";
import { JsonlSessionStorage, loadJsonlSessionMetadata } from "./jsonl-storage.js";
import { createSessionId, createTimestamp, getEntriesToFork, getFileSystemResultOrThrow, toSession } from "./repo-utils.js";
import type { Session } from "./session.js";

type RepoFs = Pick<FileSystem, "cwd" | "absolutePath" | "joinPath" | "readTextFile" | "readTextLines" | "writeFile" | "appendFile" | "listDir" | "exists" | "createDir" | "remove">;
const encodeCwd = (cwd: string): string => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

export class JsonlSessionRepo implements JsonlSessionRepoApi {
  readonly #fs: RepoFs; readonly #rootInput: string; #root?: string;
  constructor(options: { fs: RepoFs; sessionsRoot: string }) { this.#fs = options.fs; this.#rootInput = options.sessionsRoot; }
  async #sessionsRoot(): Promise<string> { this.#root ??= getFileSystemResultOrThrow(await this.#fs.absolutePath(this.#rootInput), `Failed to resolve sessions root ${this.#rootInput}`); return this.#root; }
  async #sessionDir(cwd: string): Promise<string> { return getFileSystemResultOrThrow(await this.#fs.joinPath([await this.#sessionsRoot(), encodeCwd(cwd)]), `Failed to resolve session directory for ${cwd}`); }
  async #sessionPath(cwd: string, id: string, timestamp: string): Promise<string> { return getFileSystemResultOrThrow(await this.#fs.joinPath([await this.#sessionDir(cwd), `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`]), `Failed to resolve session file path for ${id}`); }
  async create(options: JsonlSessionCreateOptions): Promise<Session<JsonlSessionMetadata>> {
    const id = options.id ?? createSessionId(); const createdAt = createTimestamp(); const dir = await this.#sessionDir(options.cwd);
    getFileSystemResultOrThrow(await this.#fs.createDir(dir, { recursive: true }), `Failed to create session directory ${dir}`);
    return toSession(await JsonlSessionStorage.create(this.#fs, await this.#sessionPath(options.cwd, id, createdAt), { cwd: options.cwd, sessionId: id, ...(options.parentSessionPath === undefined ? {} : { parentSessionPath: options.parentSessionPath }), ...(options.metadata === undefined ? {} : { metadata: options.metadata }) }));
  }
  async open(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
    if (!getFileSystemResultOrThrow(await this.#fs.exists(metadata.path), `Failed to check session ${metadata.path}`)) throw new SessionError("not_found", `Session not found: ${metadata.path}`);
    return toSession(await JsonlSessionStorage.open(this.#fs, metadata.path));
  }
  async list(options: JsonlSessionListOptions = {}): Promise<JsonlSessionMetadata[]> {
    const dirs = options.cwd ? [await this.#sessionDir(options.cwd)] : await this.#listDirs(); const sessions: JsonlSessionMetadata[] = [];
    for (const dir of dirs) {
      if (!getFileSystemResultOrThrow(await this.#fs.exists(dir), `Failed to check session directory ${dir}`)) continue;
      const files = getFileSystemResultOrThrow(await this.#fs.listDir(dir), `Failed to list sessions in ${dir}`).filter((entry) => entry.kind !== "directory" && entry.name.endsWith(".jsonl"));
      for (const file of files) { try { sessions.push(await loadJsonlSessionMetadata(this.#fs, file.path)); } catch (error) { const cause = toError(error); if (!(cause instanceof SessionError) || cause.code !== "invalid_session") throw cause; } }
    }
    return sessions.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  }
  async delete(metadata: JsonlSessionMetadata): Promise<void> { getFileSystemResultOrThrow(await this.#fs.remove(metadata.path, { force: true }), `Failed to delete session ${metadata.path}`); }
  async fork(sourceMetadata: JsonlSessionMetadata, options: JsonlSessionCreateOptions & { entryId?: string; position?: "before" | "at"; id?: string }): Promise<Session<JsonlSessionMetadata>> {
    const source = await this.open(sourceMetadata); const entries = await getEntriesToFork(source.getStorage(), options); const id = options.id ?? createSessionId(); const createdAt = createTimestamp(); const dir = await this.#sessionDir(options.cwd);
    getFileSystemResultOrThrow(await this.#fs.createDir(dir, { recursive: true }), `Failed to create session directory ${dir}`);
    const storage = await JsonlSessionStorage.create(this.#fs, await this.#sessionPath(options.cwd, id, createdAt), { cwd: options.cwd, sessionId: id, parentSessionPath: options.parentSessionPath ?? sourceMetadata.path, ...(options.metadata ?? sourceMetadata.metadata ? { metadata: options.metadata ?? sourceMetadata.metadata } : {}) });
    for (const entry of entries) await storage.appendEntry(entry);
    return toSession(storage);
  }
  async #listDirs(): Promise<string[]> {
    const root = await this.#sessionsRoot(); if (!getFileSystemResultOrThrow(await this.#fs.exists(root), `Failed to check sessions root ${root}`)) return [];
    return getFileSystemResultOrThrow(await this.#fs.listDir(root), `Failed to list sessions root ${root}`).filter((entry) => entry.kind === "directory").map((entry) => entry.path);
  }
}
