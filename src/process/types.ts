export interface CommandSpec {
  argv: [string, ...string[]];
  cwd: string;
  env?: Record<string, string>;
  /** Keep the parent environment unless an authority boundary explicitly opts out. */
  inheritEnv?: boolean;
  stdin?: string;
  timeoutMs: number;
  outputLimitBytes: number;
  onOutput?: (stream: "stdout" | "stderr", chunk: Uint8Array) => Promise<void> | void;
}

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  stdoutBytes: number;
  stderrBytes: number;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

export interface ProcessRunner {
  run(spec: CommandSpec, signal: AbortSignal): Promise<CommandResult>;
}
