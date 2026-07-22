export type SessionResourceCleanup = (sessionId?: string) => void;

const cleanups = new Set<SessionResourceCleanup>();

export function registerSessionResourceCleanup(cleanup: SessionResourceCleanup): () => void {
  cleanups.add(cleanup);
  return () => cleanups.delete(cleanup);
}

export function cleanupSessionResources(sessionId?: string): void {
  const errors: unknown[] = [];
  for (const cleanup of cleanups) {
    try { cleanup(sessionId); } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Session resource cleanup failed");
}
