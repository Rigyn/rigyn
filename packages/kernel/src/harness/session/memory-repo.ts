import type { SessionMetadata, SessionRepo } from "../types.js";
import { SessionError } from "../types.js";
import { InMemorySessionStorage } from "./memory-storage.js";
import { createSessionId, createTimestamp, getEntriesToFork, toSession } from "./repo-utils.js";
import type { Session } from "./session.js";

export class InMemorySessionRepo implements SessionRepo<SessionMetadata, { id?: string }, void> {
  readonly #sessions = new Map<string, Session<SessionMetadata>>();
  async create(options: { id?: string } = {}): Promise<Session<SessionMetadata>> {
    const metadata = { id: options.id ?? createSessionId(), createdAt: createTimestamp() };
    const session = toSession(new InMemorySessionStorage({ metadata }));
    this.#sessions.set(metadata.id, session); return session;
  }
  async open(metadata: SessionMetadata): Promise<Session<SessionMetadata>> {
    const session = this.#sessions.get(metadata.id);
    if (!session) throw new SessionError("not_found", `Session not found: ${metadata.id}`);
    return session;
  }
  async list(): Promise<SessionMetadata[]> { return Promise.all([...this.#sessions.values()].map((session) => session.getMetadata())); }
  async delete(metadata: SessionMetadata): Promise<void> { this.#sessions.delete(metadata.id); }
  async fork(sourceMetadata: SessionMetadata, options: { entryId?: string; position?: "before" | "at"; id?: string }): Promise<Session<SessionMetadata>> {
    const source = await this.open(sourceMetadata);
    const entries = await getEntriesToFork(source.getStorage(), options);
    const metadata = { id: options.id ?? createSessionId(), createdAt: createTimestamp() };
    const session = toSession(new InMemorySessionStorage({ metadata, entries }));
    this.#sessions.set(metadata.id, session); return session;
  }
}
