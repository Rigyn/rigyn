import { filesystemPathIdentity, sameFilesystemPath } from "../utils/paths.js";
import type { SessionInfo } from "./types.js";

/** Maps each child file to its parent file when the catalog can resolve the relationship safely. */
export function resolveSessionParentPaths(sessions: readonly SessionInfo[]): ReadonlyMap<string, string> {
  const pathByIdentity = new Map<string, string>();
  const uniquePathById = new Map<string, string | null>();

  for (const session of sessions) {
    pathByIdentity.set(filesystemPathIdentity(session.path), session.path);
    if (!uniquePathById.has(session.id)) {
      uniquePathById.set(session.id, session.path);
      continue;
    }
    const existing = uniquePathById.get(session.id);
    if (existing !== null && existing !== undefined && !sameFilesystemPath(existing, session.path)) {
      uniquePathById.set(session.id, null);
    }
  }

  const parentPaths = new Map<string, string>();
  for (const session of sessions) {
    if (session.parentSessionPath === undefined) continue;
    const exactPath = pathByIdentity.get(filesystemPathIdentity(session.parentSessionPath));
    const parentPath = exactPath ?? uniquePathById.get(session.parentSessionPath);
    if (parentPath !== null && parentPath !== undefined) parentPaths.set(session.path, parentPath);
  }
  return parentPaths;
}
