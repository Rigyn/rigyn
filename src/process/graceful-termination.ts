import { terminateTrackedProcessGroups } from "./active-groups.js";

const TERMINATION_EXIT_CODES: Readonly<Record<"SIGINT" | "SIGHUP" | "SIGTERM", number>> = Object.freeze({
  SIGINT: 130,
  SIGHUP: 129,
  SIGTERM: 143,
});

export type GracefulTerminationSignal = keyof typeof TERMINATION_EXIT_CODES;

export class ProcessTerminationError extends Error {
  readonly signal: GracefulTerminationSignal;
  readonly exitCode: number;

  constructor(signal: GracefulTerminationSignal) {
    super(`Process interrupted by ${signal}`);
    this.name = "ProcessTerminationError";
    this.signal = signal;
    this.exitCode = TERMINATION_EXIT_CODES[signal];
  }
}

export interface GracefulTerminationContext {
  readonly signal: AbortSignal;
  readonly receivedSignal: GracefulTerminationSignal | undefined;
  onTerminate(listener: (signal: GracefulTerminationSignal) => void): () => void;
  throwIfTerminated(): void;
}

/** Own process termination long enough for command cleanup while preserving conventional exit status. */
export async function withGracefulTermination<T>(
  operation: (context: GracefulTerminationContext) => Promise<T>,
): Promise<T> {
  const abort = new AbortController();
  const listeners = new Set<(signal: GracefulTerminationSignal) => void>();
  let receivedSignal: GracefulTerminationSignal | undefined;
  const terminate = (signal: GracefulTerminationSignal): void => {
    if (receivedSignal !== undefined) {
      try { terminateTrackedProcessGroups(); } catch {}
      process.exit(TERMINATION_EXIT_CODES[receivedSignal]);
    }
    receivedSignal = signal;
    const error = new ProcessTerminationError(signal);
    process.exitCode = error.exitCode;
    abort.abort(error);
    try { terminateTrackedProcessGroups(); } catch {}
    for (const listener of [...listeners]) {
      try { listener(signal); } catch {}
    }
  };
  const onSigint = () => terminate("SIGINT");
  const onSigterm = () => terminate("SIGTERM");
  const onSighup = () => terminate("SIGHUP");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);
  const context: GracefulTerminationContext = {
    signal: abort.signal,
    get receivedSignal() { return receivedSignal; },
    onTerminate(listener) {
      listeners.add(listener);
      if (receivedSignal !== undefined) {
        try { listener(receivedSignal); } catch {}
      }
      return () => listeners.delete(listener);
    },
    throwIfTerminated() {
      if (receivedSignal !== undefined) throw new ProcessTerminationError(receivedSignal);
    },
  };
  let result: T | undefined;
  let failure: unknown;
  try {
    result = await operation(context);
  } catch (error) {
    failure = error;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("SIGHUP", onSighup);
    listeners.clear();
    if (receivedSignal !== undefined) {
      try { terminateTrackedProcessGroups(); } catch {}
    }
  }
  if (receivedSignal !== undefined) process.exit(TERMINATION_EXIT_CODES[receivedSignal]);
  if (failure !== undefined) throw failure;
  return result as T;
}
