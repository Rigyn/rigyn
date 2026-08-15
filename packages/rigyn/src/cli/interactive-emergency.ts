import type { EventEmitter } from "node:events";

import { terminateTrackedProcessGroups } from "../process/active-groups.js";

type ExceptionMonitorTarget = Pick<EventEmitter, "prependListener" | "off">;

export interface InteractiveEmergencyRecoveryOptions {
  restoreTerminal: () => void;
  target?: ExceptionMonitorTarget;
  terminateChildren?: () => void;
}

/** Install observation-only recovery for an uncaught error in interactive mode. */
export function installInteractiveEmergencyRecovery(
  options: InteractiveEmergencyRecoveryOptions,
): () => void {
  const target = options.target ?? process;
  const terminateChildren = options.terminateChildren ?? terminateTrackedProcessGroups;
  const recover = (): void => {
    try {
      terminateChildren();
    } catch {
      // Continue with terminal restoration without replacing the original error.
    }
    try {
      options.restoreTerminal();
    } catch {
      // uncaughtExceptionMonitor leaves reporting and termination to Node.
    }
  };

  target.prependListener("uncaughtExceptionMonitor", recover);
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    target.off("uncaughtExceptionMonitor", recover);
  };
}
