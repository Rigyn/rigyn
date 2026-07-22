import { uuidv7 } from "@rigyn/models";
import type { LeafEntry, SessionMetadata, SessionStorage, SessionTreeEntry } from "../types.js";
import { SessionError } from "../types.js";

function nextId(entries: Map<string, SessionTreeEntry>): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = uuidv7().slice(-8);
    if (!entries.has(id)) return id;
  }
  return uuidv7();
}
function leafAfter(entry: SessionTreeEntry): string | null { return entry.type === "leaf" ? entry.targetId : entry.id; }

export class InMemorySessionStorage<TMetadata extends SessionMetadata = SessionMetadata> implements SessionStorage<TMetadata> {
  readonly #metadata: TMetadata;
  #entries: SessionTreeEntry[];
  #byId: Map<string, SessionTreeEntry>;
  #labels = new Map<string, string>();
  #leaf: string | null = null;

  constructor(options?: { entries?: SessionTreeEntry[]; metadata?: TMetadata }) {
    this.#entries = options?.entries?.slice() ?? [];
    this.#byId = new Map(this.#entries.map((entry) => [entry.id, entry]));
    for (const entry of this.#entries) { this.#updateLabel(entry); this.#leaf = leafAfter(entry); }
    if (this.#leaf !== null && !this.#byId.has(this.#leaf)) throw new SessionError("invalid_session", `Entry ${this.#leaf} not found`);
    this.#metadata = options?.metadata ?? { id: uuidv7(), createdAt: new Date().toISOString() } as TMetadata;
  }
  #updateLabel(entry: SessionTreeEntry): void {
    if (entry.type !== "label") return;
    const label = entry.label?.trim();
    if (label) this.#labels.set(entry.targetId, label); else this.#labels.delete(entry.targetId);
  }
  async getMetadata(): Promise<TMetadata> { return this.#metadata; }
  async getLeafId(): Promise<string | null> {
    if (this.#leaf !== null && !this.#byId.has(this.#leaf)) throw new SessionError("invalid_session", `Entry ${this.#leaf} not found`);
    return this.#leaf;
  }
  async setLeafId(leafId: string | null): Promise<void> {
    if (leafId !== null && !this.#byId.has(leafId)) throw new SessionError("not_found", `Entry ${leafId} not found`);
    const entry: LeafEntry = { type: "leaf", id: nextId(this.#byId), parentId: this.#leaf, timestamp: new Date().toISOString(), targetId: leafId };
    this.#entries.push(entry); this.#byId.set(entry.id, entry); this.#leaf = leafId;
  }
  async createEntryId(): Promise<string> { return nextId(this.#byId); }
  async appendEntry(entry: SessionTreeEntry): Promise<void> {
    this.#entries.push(entry); this.#byId.set(entry.id, entry); this.#updateLabel(entry); this.#leaf = leafAfter(entry);
  }
  async getEntry(id: string): Promise<SessionTreeEntry | undefined> { return this.#byId.get(id); }
  async findEntries<T extends SessionTreeEntry["type"]>(type: T): Promise<Array<Extract<SessionTreeEntry, { type: T }>>> {
    return this.#entries.filter((entry): entry is Extract<SessionTreeEntry, { type: T }> => entry.type === type);
  }
  async getLabel(id: string): Promise<string | undefined> { return this.#labels.get(id); }
  async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
    if (leafId === null) return [];
    const result: SessionTreeEntry[] = [];
    let cursor = this.#byId.get(leafId);
    if (!cursor) throw new SessionError("not_found", `Entry ${leafId} not found`);
    while (cursor) {
      result.unshift(cursor);
      if (cursor.parentId === null) break;
      const parent = this.#byId.get(cursor.parentId);
      if (!parent) throw new SessionError("invalid_session", `Entry ${cursor.parentId} not found`);
      cursor = parent;
    }
    return result;
  }
  async getPathToRootOrCompaction(leafId: string | null): Promise<SessionTreeEntry[]> {
    if (leafId === null) return [];
    const result: SessionTreeEntry[] = [];
    let stopAtEntryId: string | null = null;
    let cursor = this.#byId.get(leafId);
    if (!cursor) throw new SessionError("not_found", `Entry ${leafId} not found`);
    while (cursor) {
      result.unshift(cursor);
      if (stopAtEntryId !== null && cursor.id === stopAtEntryId) break;
      if (cursor.type === "compaction") {
        if (cursor.retainedTail) break;
        stopAtEntryId = cursor.firstKeptEntryId ?? null;
      }
      if (cursor.parentId === null) break;
      const parent = this.#byId.get(cursor.parentId);
      if (!parent) throw new SessionError("invalid_session", `Entry ${cursor.parentId} not found`);
      cursor = parent;
    }
    return result;
  }
  async getEntries(): Promise<SessionTreeEntry[]> { return this.#entries.slice(); }
}
