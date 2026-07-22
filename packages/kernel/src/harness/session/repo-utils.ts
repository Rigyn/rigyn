import { uuidv7 } from "@rigyn/models";
import type { FileError, Result, SessionMetadata, SessionStorage, SessionTreeEntry } from "../types.js";
import { SessionError } from "../types.js";
import { Session } from "./session.js";

export const createSessionId = (): string => uuidv7();
export const createTimestamp = (): string => new Date().toISOString();
export const toSession = <T extends SessionMetadata>(storage: SessionStorage<T>): Session<T> => new Session(storage);
export function getFileSystemResultOrThrow<T>(result: Result<T, FileError>, message: string): T {
  if (!result.ok) throw new SessionError(result.error.code === "not_found" ? "not_found" : "storage", `${message}: ${result.error.message}`, result.error);
  return result.value;
}
export async function getEntriesToFork(storage: SessionStorage, options: { entryId?: string; position?: "before" | "at" }): Promise<SessionTreeEntry[]> {
  if (!options.entryId) return storage.getEntries();
  const target = await storage.getEntry(options.entryId);
  if (!target) throw new SessionError("invalid_fork_target", `Entry ${options.entryId} not found`);
  if ((options.position ?? "before") === "at") return storage.getPathToRoot(target.id);
  if (target.type !== "message" || target.message.role !== "user") throw new SessionError("invalid_fork_target", `Entry ${options.entryId} is not a user message`);
  return storage.getPathToRoot(target.parentId);
}
