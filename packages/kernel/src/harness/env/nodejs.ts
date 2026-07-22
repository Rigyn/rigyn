import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, appendFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ExecutionEnv, FileInfo, FileKind, Result, ShellExecOptions } from "../types.js";
import { err, ExecutionError, FileError, ok, toError } from "../types.js";

const MAX_TIMEOUT_MS = 2_147_483_647;
const addressed = (cwd: string, path: string): string => isAbsolute(path) ? path : resolve(cwd, path);
const aborted = <T>(signal: AbortSignal | undefined, path?: string): Result<T, FileError> | undefined => signal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;

function fileError(value: unknown, path?: string): FileError {
  if (value instanceof FileError) return value;
  const cause = toError(value); const code = value instanceof Error && "code" in value ? String(value.code) : "";
  const mapped = code === "ABORT_ERR" ? "aborted" : code === "ENOENT" ? "not_found" : code === "EACCES" || code === "EPERM" ? "permission_denied" : code === "ENOTDIR" ? "not_directory" : code === "EISDIR" ? "is_directory" : code === "EINVAL" ? "invalid" : "unknown";
  return new FileError(mapped, cause.message, path, cause);
}
function kind(stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileKind | undefined { return stats.isFile() ? "file" : stats.isDirectory() ? "directory" : stats.isSymbolicLink() ? "symlink" : undefined; }
function info(path: string, stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number }): Result<FileInfo, FileError> {
  const fileKind = kind(stats); return fileKind ? ok({ name: basename(path), path, kind: fileKind, size: stats.size, mtimeMs: stats.mtimeMs }) : err(new FileError("invalid", "Unsupported file type", path));
}
async function existsOnDisk(path: string): Promise<boolean> { try { await access(path, constants.F_OK); return true; } catch { return false; } }
async function commandPath(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolvePath) => {
    let output = "";
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const finish = (value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePath(value);
    };
    try { child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true }); }
    catch { resolvePath(undefined); return; }
    const timer = setTimeout(() => { if (child.pid) killTree(child.pid); finish(); }, 5_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { output += chunk; });
    child.on("error", () => finish());
    child.on("close", async (code) => {
      const path = code === 0 ? output.trim().split(/\r?\n/u)[0] : undefined;
      finish(path && await existsOnDisk(path) ? path : undefined);
    });
  });
}
function killTree(pid: number): void {
  if (process.platform === "win32") { try { spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", detached: true, windowsHide: true }); } catch {} return; }
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
}
interface ShellConfig { shell: string; args: string[]; stdin?: boolean; }
async function shellConfig(custom?: string): Promise<Result<ShellConfig, ExecutionError>> {
  if (custom) return await existsOnDisk(custom) ? ok({ shell: custom, args: [/^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/i.test(custom.replace(/\//g, "\\")) ? "-s" : "-c"], stdin: /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/i.test(custom.replace(/\//g, "\\")) }) : err(new ExecutionError("shell_unavailable", `Custom shell path not found: ${custom}`));
  if (process.platform === "win32") {
    for (const path of [process.env.ProgramFiles && `${process.env.ProgramFiles}\\Git\\bin\\bash.exe`, process.env["ProgramFiles(x86)"] && `${process.env["ProgramFiles(x86)"]}\\Git\\bin\\bash.exe`].filter((x): x is string => Boolean(x))) if (await existsOnDisk(path)) return ok({ shell: path, args: ["-c"] });
    const pathShell = await commandPath("where", ["bash.exe"]);
    if (pathShell) return ok({ shell: pathShell, args: ["-c"] });
    return err(new ExecutionError("shell_unavailable", "No bash shell found"));
  }
  if (await existsOnDisk("/bin/bash")) return ok({ shell: "/bin/bash", args: ["-c"] });
  const pathShell = await commandPath("which", ["bash"]);
  return pathShell ? ok({ shell: pathShell, args: ["-c"] }) : ok({ shell: "sh", args: ["-c"] });
}

export class NodeExecutionEnv implements ExecutionEnv {
  cwd: string; readonly #shellPath: string | undefined; readonly #shellEnv: NodeJS.ProcessEnv | undefined;
  constructor(options: { cwd: string; shellPath?: string; shellEnv?: NodeJS.ProcessEnv }) { this.cwd = options.cwd; this.#shellPath = options.shellPath; this.#shellEnv = options.shellEnv; }
  async absolutePath(path: string, signal?: AbortSignal): Promise<Result<string, FileError>> { return aborted(signal, path) ?? ok(addressed(this.cwd, path)); }
  async joinPath(parts: string[], signal?: AbortSignal): Promise<Result<string, FileError>> { return aborted(signal) ?? ok(join(...parts)); }
  async exec(command: string, options: ShellExecOptions = {}): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    if (options.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
    if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout * 1000 > MAX_TIMEOUT_MS)) return err(new ExecutionError("timeout", options.timeout * 1000 > MAX_TIMEOUT_MS ? `Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds` : "Invalid timeout: must be a finite number of seconds"));
    const shell = await shellConfig(this.#shellPath); if (!shell.ok) return shell;
    return new Promise((settle) => {
      let stdout = ""; let stderr = ""; let done = false; let timedOut = false; let callbackFailure: ExecutionError | undefined; let timer: NodeJS.Timeout | undefined;
      const finish = (result: Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>) => { if (done) return; done = true; if (timer) clearTimeout(timer); options.abortSignal?.removeEventListener("abort", stop); settle(result); };
      let child: ReturnType<typeof spawn>;
      const stop = () => { if (child?.pid) killTree(child.pid); };
      try {
        child = spawn(shell.value.shell, shell.value.stdin ? shell.value.args : [...shell.value.args, command], { cwd: options.cwd ? addressed(this.cwd, options.cwd) : this.cwd, detached: process.platform !== "win32", env: { ...process.env, ...this.#shellEnv, ...options.env }, stdio: [shell.value.stdin ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true });
        if (shell.value.stdin) { child.stdin?.on("error", () => {}); child.stdin?.end(command); }
      } catch (error) { const cause = toError(error); finish(err(new ExecutionError("spawn_error", cause.message, cause))); return; }
      if (options.timeout !== undefined) timer = setTimeout(() => { timedOut = true; stop(); }, options.timeout * 1000);
      if (options.abortSignal) { if (options.abortSignal.aborted) stop(); else options.abortSignal.addEventListener("abort", stop, { once: true }); }
      child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => { stdout += chunk; try { options.onStdout?.(chunk); } catch (error) { const cause = toError(error); callbackFailure = new ExecutionError("callback_error", cause.message, cause); stop(); } });
      child.stderr?.on("data", (chunk: string) => { stderr += chunk; try { options.onStderr?.(chunk); } catch (error) { const cause = toError(error); callbackFailure = new ExecutionError("callback_error", cause.message, cause); stop(); } });
      child.on("error", (error) => finish(err(new ExecutionError("spawn_error", error.message, error))));
      child.on("close", (code) => finish(callbackFailure ? err(callbackFailure) : timedOut ? err(new ExecutionError("timeout", `timeout:${options.timeout}`)) : options.abortSignal?.aborted ? err(new ExecutionError("aborted", "aborted")) : ok({ stdout, stderr, exitCode: code ?? 0 })));
    });
  }
  async readTextFile(path: string, signal?: AbortSignal): Promise<Result<string, FileError>> { const full = addressed(this.cwd, path); const early = aborted<string>(signal, full); if (early) return early; try { return ok(await readFile(full, { encoding: "utf8", signal })); } catch (error) { return err(fileError(error, full)); } }
  async readTextLines(path: string, options: { maxLines?: number; abortSignal?: AbortSignal } = {}): Promise<Result<string[], FileError>> {
    const full = addressed(this.cwd, path); const early = aborted<string[]>(options.abortSignal, full); if (early) return early; if (options.maxLines !== undefined && options.maxLines <= 0) return ok([]); let stream: ReturnType<typeof createReadStream> | undefined; let reader: ReturnType<typeof createInterface> | undefined;
    try { stream = createReadStream(full, { encoding: "utf8", signal: options.abortSignal }); reader = createInterface({ input: stream, crlfDelay: Infinity }); const lines: string[] = []; for await (const line of reader) { const stopped = aborted<string[]>(options.abortSignal, full); if (stopped) return stopped; lines.push(line); if (options.maxLines !== undefined && lines.length >= options.maxLines) break; } return aborted<string[]>(options.abortSignal, full) ?? ok(lines); } catch (error) { return err(fileError(error, full)); } finally { reader?.close(); stream?.destroy(); }
  }
  async readBinaryFile(path: string, signal?: AbortSignal): Promise<Result<Uint8Array, FileError>> { const full = addressed(this.cwd, path); const early = aborted<Uint8Array>(signal, full); if (early) return early; try { return ok(await readFile(full, { signal })); } catch (error) { return err(fileError(error, full)); } }
  async writeFile(path: string, content: string | Uint8Array, signal?: AbortSignal): Promise<Result<void, FileError>> { const full = addressed(this.cwd, path); const early = aborted<void>(signal, full); if (early) return early; try { await mkdir(resolve(full, ".."), { recursive: true }); const second = aborted<void>(signal, full); if (second) return second; await writeFile(full, content, { signal }); return ok(undefined); } catch (error) { return err(fileError(error, full)); } }
  async appendFile(path: string, content: string | Uint8Array, signal?: AbortSignal): Promise<Result<void, FileError>> { const full = addressed(this.cwd, path); const early = aborted<void>(signal, full); if (early) return early; try { await mkdir(resolve(full, ".."), { recursive: true }); const second = aborted<void>(signal, full); if (second) return second; await appendFile(full, content); return ok(undefined); } catch (error) { return err(fileError(error, full)); } }
  async fileInfo(path: string, signal?: AbortSignal): Promise<Result<FileInfo, FileError>> { const full = addressed(this.cwd, path); const early = aborted<FileInfo>(signal, full); if (early) return early; try { return info(full, await lstat(full)); } catch (error) { return err(fileError(error, full)); } }
  async listDir(path: string, signal?: AbortSignal): Promise<Result<FileInfo[], FileError>> { const full = addressed(this.cwd, path); const early = aborted<FileInfo[]>(signal, full); if (early) return early; try { const result: FileInfo[] = []; for (const entry of await readdir(full, { withFileTypes: true })) { const stopped = aborted<FileInfo[]>(signal, full); if (stopped) return stopped; const entryPath = resolve(full, entry.name); const item = info(entryPath, await lstat(entryPath)); if (item.ok) result.push(item.value); } return ok(result); } catch (error) { return err(fileError(error, full)); } }
  async canonicalPath(path: string, signal?: AbortSignal): Promise<Result<string, FileError>> { const full = addressed(this.cwd, path); const early = aborted<string>(signal, full); if (early) return early; try { return ok(await realpath(full)); } catch (error) { return err(fileError(error, full)); } }
  async exists(path: string, signal?: AbortSignal): Promise<Result<boolean, FileError>> { const result = await this.fileInfo(path, signal); return result.ok ? ok(true) : result.error.code === "not_found" ? ok(false) : result; }
  async createDir(path: string, options: { recursive?: boolean; abortSignal?: AbortSignal } = {}): Promise<Result<void, FileError>> { const full = addressed(this.cwd, path); const early = aborted<void>(options.abortSignal, full); if (early) return early; try { await mkdir(full, { recursive: options.recursive ?? true }); return ok(undefined); } catch (error) { return err(fileError(error, full)); } }
  async remove(path: string, options: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal } = {}): Promise<Result<void, FileError>> { const full = addressed(this.cwd, path); const early = aborted<void>(options.abortSignal, full); if (early) return early; try { await rm(full, { recursive: options.recursive ?? false, force: options.force ?? false }); return ok(undefined); } catch (error) { return err(fileError(error, full)); } }
  async createTempDir(prefix = "tmp-", signal?: AbortSignal): Promise<Result<string, FileError>> { const early = aborted<string>(signal); if (early) return early; try { return ok(await mkdtemp(join(tmpdir(), prefix))); } catch (error) { return err(fileError(error)); } }
  async createTempFile(options: { prefix?: string; suffix?: string; abortSignal?: AbortSignal } = {}): Promise<Result<string, FileError>> { const dir = await this.createTempDir("tmp-", options.abortSignal); if (!dir.ok) return dir; const path = join(dir.value, `${options.prefix ?? ""}${randomUUID()}${options.suffix ?? ""}`); try { await writeFile(path, "", { signal: options.abortSignal }); return ok(path); } catch (error) { return err(fileError(error, path)); } }
  async cleanup(): Promise<void> {}
}
