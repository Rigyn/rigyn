import { terminateTrackedProcessGroups } from "./active-groups.js";

const TERMINATION_EXIT_CODES: Readonly<Record<"SIGINT" | "SIGHUP" | "SIGTERM", number>> = Object.freeze({
  SIGINT: 130,
  SIGHUP: 129,
  SIGTERM: 143,
});
const DEFAULT_FORCE_EXIT_AFTER_MS = 10_000;
const MAX_FORCE_EXIT_AFTER_MS = 60_000;

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

export interface GracefulTerminationOptions {
  forceExitAfterMs?: number;
}

/** Own process termination long enough for command cleanup while preserving conventional exit status. */
export async function withGracefulTermination<T>(
  operation: (context: GracefulTerminationContext) => Promise<T>,
  options: GracefulTerminationOptions = {},
): Promise<T> {
  const forceExitAfterMs = options.forceExitAfterMs ?? DEFAULT_FORCE_EXIT_AFTER_MS;
  if (!Number.isSafeInteger(forceExitAfterMs) || forceExitAfterMs < 1 || forceExitAfterMs > MAX_FORCE_EXIT_AFTER_MS) {
    throw new RangeError(`forceExitAfterMs must be an integer from 1 through ${MAX_FORCE_EXIT_AFTER_MS}`);
  }
  const abort = new AbortController();
  const listeners = new Set<(signal: GracefulTerminationSignal) => void>();
  let receivedSignal: GracefulTerminationSignal | undefined;
  let forceExitTimer: NodeJS.Timeout | undefined;
  const terminate = (signal: GracefulTerminationSignal): void => {
    if (receivedSignal !== undefined) {
      try { terminateTrackedProcessGroups(); } catch {}
      process.exit(TERMINATION_EXIT_CODES[receivedSignal]);
    }
    receivedSignal = signal;
    const error = new ProcessTerminationError(signal);
    process.exitCode = error.exitCode;
    forceExitTimer = setTimeout(() => {
      try { terminateTrackedProcessGroups(); } catch {}
      process.exit(error.exitCode);
    }, forceExitAfterMs);
    forceExitTimer.unref();
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
    if (forceExitTimer !== undefined) clearTimeout(forceExitTimer);
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
