import { terminateProcessTree } from "./process-tree.js";

const activeProcessGroups = new Set<number>();

/** Track a detached child process group until its owner settles. */
export function trackActiveProcessGroup(pid: number | undefined): () => void {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return () => undefined;
  activeProcessGroups.add(pid);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    activeProcessGroups.delete(pid);
  };
}

/** Synchronously terminate every child process group still owned by this process. */
export function terminateTrackedProcessGroups(): void {
  const pids = [...activeProcessGroups];
  activeProcessGroups.clear();
  for (const pid of pids) terminateProcessTree(pid, "SIGKILL");
}
