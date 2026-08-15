import type { SessionBranchQuery, SessionEntryBase } from "./types.js";

type QueryableSessionEntry = SessionEntryBase & { customType?: string };

export function validateSessionBranchQuery(query: SessionBranchQuery): void {
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit <= 0)) {
    throw new RangeError("Session branch query limit must be a positive integer");
  }
}

/** Applies query bounds to a root-to-leaf path without changing its entries. */
export function selectSessionBranchEntries<T extends QueryableSessionEntry>(
  oldestFirstPath: readonly T[],
  query: SessionBranchQuery,
): T[] {
  validateSessionBranchQuery(query);
  const ordered = query.order === "oldestFirst"
    ? [...oldestFirstPath]
    : [...oldestFirstPath].reverse();
  const stop = ordered.findIndex((entry) => (
    entry.id === query.stopAtId || entry.type === query.stopAtType
  ));
  const bounded = stop < 0 ? ordered : ordered.slice(0, stop + 1);
  const filtered = bounded.filter((entry) => (
    (query.type === undefined || entry.type === query.type)
    && (
      query.customType === undefined
      || (entry.type === "custom" && entry.customType === query.customType)
    )
  ));
  return query.limit === undefined ? filtered : filtered.slice(0, query.limit);
}
