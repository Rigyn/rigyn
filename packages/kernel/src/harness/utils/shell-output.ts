import type { ExecutionEnv, Result, ShellExecOptions } from "../types.js";
import { err, ExecutionError, ok, toError } from "../types.js";
import { DEFAULT_MAX_BYTES, truncateTail } from "./truncate.js";
export interface ShellCaptureOptions extends Omit<ShellExecOptions, "onStdout" | "onStderr"> { onChunk?: (chunk: string) => void; }
export interface ShellCaptureResult { output: string; exitCode: number | undefined; cancelled: boolean; truncated: boolean; fullOutputPath?: string; }
export function sanitizeBinaryOutput(text: string): string { return Array.from(text).filter((character) => { const code = character.codePointAt(0); return code !== undefined && (code === 9 || code === 10 || code === 13 || code > 31) && !(code >= 0xfff9 && code <= 0xfffb); }).join(""); }
const executionError = (value: unknown): ExecutionError => value instanceof ExecutionError ? value : new ExecutionError("unknown", toError(value).message, toError(value));
export async function executeShellWithCapture(env: ExecutionEnv, command: string, options: ShellCaptureOptions = {}): Promise<Result<ShellCaptureResult, ExecutionError>> {
  const chunks: string[] = []; let retained = 0; let total = 0; let path: string | undefined; let captureError: ExecutionError | undefined; let acceptingOutput = true; let chain: Promise<Result<void, ExecutionError>> = Promise.resolve(ok(undefined));
  const append = (text: string) => { if (!path || captureError) return; chain = chain.then(async (prior) => { if (!prior.ok) return prior; const written = await env.appendFile(path!, text, options.abortSignal); return written.ok ? ok(undefined) : err(executionError(written.error)); }); };
  const create = (initial: string) => { if (path || captureError) return; chain = chain.then(async (prior) => { if (!prior.ok) return prior; const temp = await env.createTempFile({ prefix: "bash-", suffix: ".log", ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }) }); if (!temp.ok) return err(executionError(temp.error)); path = temp.value; const written = await env.appendFile(path, initial, options.abortSignal); return written.ok ? ok(undefined) : err(executionError(written.error)); }); };
  const onChunk = (raw: string) => { if (!acceptingOutput) return; try { total += new TextEncoder().encode(raw).byteLength; const text = sanitizeBinaryOutput(raw).replace(/\r/g, ""); if (total > DEFAULT_MAX_BYTES && !path) create(chunks.join("") + text); else append(text); chunks.push(text); retained += text.length; while (retained > DEFAULT_MAX_BYTES * 2 && chunks.length > 1) retained -= chunks.shift()!.length; options.onChunk?.(text); } catch (error) { captureError = executionError(error); } };
  try {
    let executed: Awaited<ReturnType<ExecutionEnv["exec"]>>;
    try { executed = await env.exec(command, { ...options, onStdout: onChunk, onStderr: onChunk }); } finally { acceptingOutput = false; }
    const tail = chunks.join(""); const truncated = truncateTail(tail); if (truncated.truncated && !path) create(tail); const written = await chain; if (!written.ok) return written; if (captureError) return err(captureError);
    if (!executed.ok) { if (executed.error.code === "aborted" || options.abortSignal?.aborted) return ok({ output: truncated.truncated ? truncated.content : tail, exitCode: undefined, cancelled: true, truncated: truncated.truncated, ...(path ? { fullOutputPath: path } : {}) }); return executed; }
    const cancelled = options.abortSignal?.aborted ?? false; return ok({ output: truncated.truncated ? truncated.content : tail, exitCode: cancelled ? undefined : executed.value.exitCode, cancelled, truncated: truncated.truncated, ...(path ? { fullOutputPath: path } : {}) });
  } catch (error) { return err(executionError(error)); }
}
