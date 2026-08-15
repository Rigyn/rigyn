import type { FileAccess } from "./filesystem.js";
import type { Result } from "./outcomes.js";

export type ExecutionErrorCode =
  | "aborted"
  | "timeout"
  | "callback_error"
  | "shell_unavailable"
  | "spawn_error"
  | "output_limit"
  | "unknown";

export class ExecutionError extends Error {
  readonly code: ExecutionErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: ExecutionErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "ExecutionError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

interface ShellLocationOptions {
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

interface ShellLifetimeOptions {
  timeout?: number;
  abortSignal?: AbortSignal;
}

interface ShellOutputObservers {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface ShellExecOptions extends ShellLocationOptions, ShellLifetimeOptions, ShellOutputObservers {}

export interface ShellExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ShellRunner {
  exec(command: string, options?: ShellExecOptions): Promise<Result<ShellExecResult, ExecutionError>>;
}

interface ExecutionCleanup {
  cleanup?(): Promise<void>;
}

export interface ExecutionEnv extends FileAccess, ShellRunner, ExecutionCleanup {}
