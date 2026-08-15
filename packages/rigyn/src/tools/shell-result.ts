export interface ShellTerminalState {
  exitCode?: number | null;
  isError?: boolean;
  cancelled?: boolean;
  timedOut?: boolean;
  signal?: string | null;
}

export interface NormalizedShellTerminalState {
  exitCode: number | undefined;
  isError?: true;
  cancelled: boolean;
  timedOut?: true;
  signal?: string;
}

/** Normalize terminal shell state shared by direct, interactive, and RPC adapters. */
export function normalizeShellTerminalState(
  value: ShellTerminalState,
  options: { legacySignalImpliesCancellation?: boolean } = {},
): NormalizedShellTerminalState {
  const cancellationSignal = value.signal === "CANCELLED";
  const signal = typeof value.signal === "string" && !cancellationSignal
    ? value.signal
    : undefined;
  const cancelled = value.cancelled === true || cancellationSignal || (
    options.legacySignalImpliesCancellation === true
    && value.cancelled === undefined
    && signal !== undefined
  );
  const timedOut = value.timedOut === true;
  const exitCode = typeof value.exitCode === "number" ? value.exitCode : undefined;
  const isError = value.isError === true || cancelled || timedOut || signal !== undefined || (
    exitCode !== undefined && exitCode !== 0
  );
  return {
    exitCode,
    ...(isError ? { isError: true as const } : {}),
    cancelled,
    ...(timedOut ? { timedOut: true as const } : {}),
    ...(signal === undefined ? {} : { signal }),
  };
}
