import {
  ExecutionError,
  type ExecutionEnv,
  type Result,
  type ShellExecOptions,
  toError,
} from "./harness/types.js";
import { truncateTail, type TruncationResult } from "./text-limits.js";

const CAPTURE_BYTES = 50 * 1024;
const CAPTURE_LINES = 2_000;

export interface ShellCaptureProgress {
  output: string;
  truncated: boolean;
  truncation: TruncationResult;
  fullOutputPath?: string;
  lastLineBytes: number;
}

export interface ShellCapture extends ShellCaptureProgress {
  cancelled: boolean;
  executionError?: ExecutionError;
  exitCode?: number;
}

export interface ShellCaptureOptions extends ShellExecOptions {
  onChunk?: (chunk: string, progress: () => ShellCaptureProgress) => void;
  returnExecutionErrors?: boolean;
}

function countLastLineBytes(value: string): number {
  const newline = value.lastIndexOf("\n");
  return Buffer.byteLength(newline < 0 ? value : value.slice(newline + 1), "utf8");
}

export async function executeShellWithCapture(
  env: ExecutionEnv,
  command: string,
  options: ShellCaptureOptions = {},
): Promise<Result<ShellCapture, ExecutionError>> {
  const chunks: string[] = [];
  let settled = false;
  let fullOutputPath: string | undefined;
  let current = truncateTail("", { maxBytes: CAPTURE_BYTES, maxLines: CAPTURE_LINES });
  const progress = (): ShellCaptureProgress => ({
    output: current.content,
    truncated: current.truncated,
    truncation: current,
    ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
    lastLineBytes: countLastLineBytes(chunks.join("")),
  });
  const receive = (chunk: string): void => {
    if (settled) return;
    chunks.push(chunk);
    current = truncateTail(chunks.join(""), { maxBytes: CAPTURE_BYTES, maxLines: CAPTURE_LINES });
    options.onChunk?.(chunk, progress);
  };
  const executionOptions: ShellExecOptions = {
    onStdout: receive,
    onStderr: receive,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
  };

  let result: Awaited<ReturnType<ExecutionEnv["exec"]>>;
  try {
    result = await env.exec(command, executionOptions);
  } catch (error) {
    settled = true;
    return { ok: false, error: new ExecutionError("unknown", toError(error).message) };
  }
  settled = true;
  const complete = chunks.join("");
  current = truncateTail(complete, { maxBytes: CAPTURE_BYTES, maxLines: CAPTURE_LINES });
  if (current.truncated) {
    const temporary = await env.createTempFile({ prefix: "rigyn-shell-", suffix: ".log" });
    if (!temporary.ok) return { ok: false, error: new ExecutionError("unknown", temporary.error.message) };
    fullOutputPath = temporary.value.path;
    const written = await env.writeFile(fullOutputPath, complete);
    if (!written.ok) return { ok: false, error: new ExecutionError("unknown", written.error.message) };
  }
  if (current.truncated) options.onChunk?.("", progress);

  if (!result.ok && result.error.code !== "aborted" && options.returnExecutionErrors !== true) return result;
  return {
    ok: true,
    value: {
      ...progress(),
      cancelled: !result.ok && result.error.code === "aborted",
      ...(result.ok ? { exitCode: result.value.exitCode } : { executionError: result.error }),
    },
  };
}
