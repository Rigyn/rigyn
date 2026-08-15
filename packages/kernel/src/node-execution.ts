import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ExecutionError,
  FileError,
  type ExecutionEnv,
  type FileInfo,
  type FileWriteContent,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  toError,
} from "./harness/types.js";
import { windowsJobLauncherPath } from "./windows-job-launcher.js";

const BUFFERED_OUTPUT_LIMIT = 8 * 1024 * 1024;
const RESULT_TAIL_LIMIT = 64 * 1024;
const PROCESS_TERMINATION_GRACE_MS = 250;

export interface NodeExecutionEnvOptions {
  cwd?: string;
  shellPath?: string;
}

interface ActiveShell {
  child: ChildProcess;
  promise: Promise<Result<ShellExecResult, ExecutionError>>;
  cleanupRequested: boolean;
}

function aborted(path?: string): FileError {
  return new FileError("aborted", "Operation was cancelled", path);
}

function nodeErrorMessage(error: unknown): string {
  return toError(error).message;
}

function fileFailure(error: unknown, path: string): FileError {
  let code: string | undefined;
  try {
    const descriptor = typeof error === "object" && error !== null
      ? Object.getOwnPropertyDescriptor(error, "code")
      : undefined;
    if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string") code = descriptor.value;
  } catch {
    // The safe fallback below intentionally does not inspect hostile objects.
  }
  const mapped = code === "ENOENT" ? "not_found"
    : code === "ENOTDIR" ? "not_directory"
      : code === "EACCES" || code === "EPERM" ? "permission_denied"
        : "unknown";
  return new FileError(mapped, nodeErrorMessage(error), path);
}

function tailUtf8(previous: string, next: string, limit = RESULT_TAIL_LIMIT): string {
  const combined = Buffer.from(previous + next, "utf8");
  if (combined.byteLength <= limit) return combined.toString("utf8");
  let start = combined.byteLength - limit;
  while (start < combined.byteLength && (combined[start]! & 0xc0) === 0x80) start += 1;
  return combined.subarray(start).toString("utf8");
}

function classify(path: string, value: Awaited<ReturnType<typeof lstat>>): FileInfo {
  return {
    name: basename(path),
    path,
    kind: value.isSymbolicLink() ? "symlink"
      : value.isFile() ? "file"
        : value.isDirectory() ? "directory"
          : "other",
    size: Number(value.size),
    mtimeMs: Number(value.mtimeMs),
  };
}

async function writeContent(path: string, content: FileWriteContent): Promise<void> {
  if (typeof content === "string" || content instanceof Uint8Array) {
    await writeFile(path, content);
    return;
  }
  await writeFile(path, content, { mode: 0o600 });
}

function processFinished(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function signalPosixProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try { process.kill(-child.pid, signal); } catch { /* the process group may not exist yet */ }
  }
  if (processFinished(child)) return;
  try { child.kill(signal); } catch { /* the wrapper may already be gone */ }
}

function stopWindowsProcessTree(child: ChildProcess): void {
  try { child.kill("SIGKILL"); } catch { /* closing the launcher job may already have completed */ }
}

function stopProcess(child: ChildProcess): void {
  if (process.platform === "win32") {
    stopWindowsProcessTree(child);
    return;
  }
  if (child.pid === undefined) return;
  signalPosixProcessTree(child, "SIGTERM");
  const timer = setTimeout(
    () => signalPosixProcessTree(child, "SIGKILL"),
    PROCESS_TERMINATION_GRACE_MS,
  );
  timer.unref();
  child.once("close", () => clearTimeout(timer));
}

export class NodeExecutionEnv implements ExecutionEnv {
  readonly cwd: string;
  readonly #shellPath: string;
  readonly #shellWasExplicit: boolean;
  readonly #active = new Set<ActiveShell>();

  constructor(options: NodeExecutionEnvOptions = {}) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.#shellWasExplicit = options.shellPath !== undefined;
    this.#shellPath = options.shellPath ?? (process.platform === "win32"
      ? process.env.ComSpec || "cmd.exe"
      : process.env.SHELL ?? "/bin/sh");
  }

  async absolutePath(path: string): Promise<Result<string, FileError>> {
    try {
      if (path === "~") return { ok: true, value: homedir() };
      if (path.startsWith("~/") || path.startsWith("~\\")) return { ok: true, value: join(homedir(), path.slice(2)) };
      if (path.startsWith("file:")) {
        try { return { ok: true, value: fileURLToPath(path) }; } catch { /* treat malformed URLs as paths */ }
      }
      return { ok: true, value: isAbsolute(path) ? resolve(path) : resolve(this.cwd, path) };
    } catch (error) {
      return { ok: false, error: fileFailure(error, path) };
    }
  }

  async canonicalPath(path: string): Promise<Result<string, FileError>> {
    const absolute = await this.absolutePath(path);
    if (!absolute.ok) return absolute;
    try {
      return { ok: true, value: await realpath(absolute.value) };
    } catch (error) {
      return { ok: false, error: fileFailure(error, path) };
    }
  }

  async fileInfo(path: string, signal?: AbortSignal): Promise<Result<FileInfo, FileError>> {
    if (signal?.aborted) return { ok: false, error: aborted(path) };
    const absolute = await this.absolutePath(path);
    if (!absolute.ok) return absolute;
    try {
      return { ok: true, value: classify(absolute.value, await lstat(absolute.value)) };
    } catch (error) {
      return { ok: false, error: fileFailure(error, path) };
    }
  }

  async listDir(path: string, signal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
    if (signal?.aborted) return { ok: false, error: aborted(path) };
    const absolute = await this.absolutePath(path);
    if (!absolute.ok) return absolute;
    try {
      const names = await readdir(absolute.value);
      const entries: FileInfo[] = [];
      for (const name of names.sort((left, right) => left.localeCompare(right))) {
        if (signal?.aborted) return { ok: false, error: aborted(path) };
        const entryPath = join(absolute.value, name);
        entries.push(classify(entryPath, await lstat(entryPath)));
      }
      return { ok: true, value: entries };
    } catch (error) {
      return { ok: false, error: fileFailure(error, path) };
    }
  }

  async exists(path: string, signal?: AbortSignal): Promise<Result<boolean, FileError>> {
    if (signal?.aborted) return { ok: false, error: aborted(path) };
    const info = await this.fileInfo(path, signal);
    if (info.ok) return { ok: true, value: true };
    if (info.error.code === "not_found") return { ok: true, value: false };
    return info;
  }

  async readBinaryFile(path: string, signal?: AbortSignal, maxBytes?: number): Promise<Result<Uint8Array, FileError>> {
    if (signal?.aborted) return { ok: false, error: aborted(path) };
    const absolute = await this.absolutePath(path);
    if (!absolute.ok) return absolute;
    try {
      if (maxBytes !== undefined) {
        const details = await stat(absolute.value);
        if (details.size > maxBytes) {
          return { ok: false, error: new FileError("limit_exceeded", `${path} exceeds the ${maxBytes}-byte read limit`, path) };
        }
      }
      const value = await readFile(absolute.value, { signal });
      if (maxBytes !== undefined && value.byteLength > maxBytes) {
        return { ok: false, error: new FileError("limit_exceeded", `${path} exceeds the ${maxBytes}-byte read limit`, path) };
      }
      return { ok: true, value };
    } catch (error) {
      if (signal?.aborted) return { ok: false, error: aborted(path) };
      return { ok: false, error: fileFailure(error, path) };
    }
  }

  async readTextFile(path: string, signal?: AbortSignal, maxBytes?: number): Promise<Result<string, FileError>> {
    const bytes = await this.readBinaryFile(path, signal, maxBytes);
    if (!bytes.ok) return bytes;
    return { ok: true, value: new TextDecoder().decode(bytes.value) };
  }

  async readTextLines(
    path: string,
    options: { maxLines?: number; maxBytes?: number; signal?: AbortSignal } = {},
  ): Promise<Result<string[], FileError>> {
    const text = await this.readTextFile(path, options.signal, options.maxBytes);
    if (!text.ok) return text;
    const lines = text.value.split(/\r?\n/u);
    if (text.value.endsWith("\n")) lines.pop();
    return { ok: true, value: options.maxLines === undefined ? lines : lines.slice(0, options.maxLines) };
  }

  async writeFile(path: string, content: FileWriteContent, signal?: AbortSignal): Promise<Result<void, FileError>> {
    if (signal?.aborted) return { ok: false, error: aborted(path) };
    const absolute = await this.absolutePath(path);
    if (!absolute.ok) return absolute;
    try {
      await mkdir(dirname(absolute.value), { recursive: true });
      if (signal?.aborted) return { ok: false, error: aborted(path) };
      await writeContent(absolute.value, content);
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: fileFailure(error, path) };
    }
  }

  async replaceFile(path: string, content: FileWriteContent, signal?: AbortSignal): Promise<Result<void, FileError>> {
    if (signal?.aborted) return { ok: false, error: aborted(path) };
    const absolute = await this.absolutePath(path);
    if (!absolute.ok) return absolute;
    const parent = dirname(absolute.value);
    const temporary = join(parent, `.${basename(absolute.value)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    try {
      await mkdir(parent, { recursive: true });
      await writeContent(temporary, content);
      if (signal?.aborted) {
        await rm(temporary, { force: true });
        return { ok: false, error: aborted(path) };
      }
      await rename(temporary, absolute.value);
      return { ok: true, value: undefined };
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      return { ok: false, error: fileFailure(error, path) };
    }
  }

  async appendFile(path: string, content: string | Uint8Array, signal?: AbortSignal): Promise<Result<void, FileError>> {
    if (signal?.aborted) return { ok: false, error: aborted(path) };
    const absolute = await this.absolutePath(path);
    if (!absolute.ok) return absolute;
    try {
      await mkdir(dirname(absolute.value), { recursive: true });
      await appendFile(absolute.value, content);
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: fileFailure(error, path) };
    }
  }

  async createDir(path: string, options: { recursive?: boolean } = {}, signal?: AbortSignal): Promise<Result<void, FileError>> {
    if (signal?.aborted) return { ok: false, error: aborted(path) };
    const absolute = await this.absolutePath(path);
    if (!absolute.ok) return absolute;
    try {
      await mkdir(absolute.value, { recursive: options.recursive ?? false });
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: fileFailure(error, path) };
    }
  }

  async createTempFile(
    options: { prefix?: string; suffix?: string; directory?: string } = {},
  ): Promise<Result<{ path: string }, FileError>> {
    const root = options.directory ?? tmpdir();
    try {
      const directory = await mkdtemp(join(root, options.prefix ?? "rigyn-output-"));
      const path = join(directory, `capture${options.suffix ?? ".log"}`);
      const handle = await open(path, "wx", 0o600);
      await handle.close();
      return { ok: true, value: { path } };
    } catch (error) {
      return { ok: false, error: fileFailure(error, root) };
    }
  }

  async exec(command: string, options: ShellExecOptions = {}): Promise<Result<ShellExecResult, ExecutionError>> {
    if (options.abortSignal?.aborted) {
      return { ok: false, error: new ExecutionError("aborted", "Shell command was cancelled") };
    }
    const runCwd = options.cwd === undefined ? this.cwd : resolve(this.cwd, options.cwd);
    try {
      const cwdInfo = await stat(runCwd);
      if (!cwdInfo.isDirectory()) throw new Error("not a directory");
    } catch {
      return {
        ok: false,
        error: new ExecutionError(
          "spawn_error",
          `Shell working directory is unavailable: ${runCwd}`,
          { phase: "cwd", cwd: runCwd },
        ),
      };
    }
    if (isAbsolute(this.#shellPath)) {
      try {
        await access(this.#shellPath, fsConstants.F_OK);
      } catch {
        return { ok: false, error: new ExecutionError("shell_unavailable", `Shell is unavailable: ${this.#shellPath}`) };
      }
      try {
        await access(this.#shellPath, fsConstants.X_OK);
      } catch {
        const code = this.#shellWasExplicit ? "spawn_error" : "shell_unavailable";
        return { ok: false, error: new ExecutionError(code, `Shell cannot be executed: ${this.#shellPath}`) };
      }
    }

    const environment: NodeJS.ProcessEnv = { ...process.env };
    for (const [name, value] of Object.entries(options.env ?? {})) {
      if (value === undefined) delete environment[name];
      else environment[name] = value;
    }
    if (options.abortSignal?.aborted) {
      return { ok: false, error: new ExecutionError("aborted", "Shell command was cancelled") };
    }

    const windows = process.platform === "win32";
    const executable = windows ? windowsJobLauncherPath() : this.#shellPath;
    if (windows) {
      try {
        await access(executable, fsConstants.F_OK);
      } catch {
        return {
          ok: false,
          error: new ExecutionError("spawn_error", "The Windows process launcher is unavailable"),
        };
      }
    }

    let child: ChildProcess;
    try {
      child = spawn(executable, windows ? [this.#shellPath, command] : ["-c", command], {
        cwd: runCwd,
        env: environment,
        detached: !windows,
        stdio: windows ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
        windowsHide: windows,
      });
    } catch (error) {
      return { ok: false, error: new ExecutionError("spawn_error", nodeErrorMessage(error)) };
    }

    const active: ActiveShell = {
      child,
      promise: Promise.resolve(undefined as never),
      cleanupRequested: false,
    };
    const promise = new Promise<Result<ShellExecResult, ExecutionError>>((accept) => {
      let stdout = "";
      let stderr = "";
      let bytes = 0;
      let settled = false;
      let failure: ExecutionError | undefined;
      let timer: NodeJS.Timeout | undefined;
      let launcherStatus: "" | "O" | "invalid" = "";

      const finish = (result: Result<ShellExecResult, ExecutionError>): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        options.abortSignal?.removeEventListener("abort", cancel);
        accept(result);
      };
      const fail = (error: ExecutionError): void => {
        if (failure !== undefined) return;
        failure = error;
        stopProcess(child);
      };
      const cancel = (): void => fail(new ExecutionError("aborted", "Shell command was cancelled"));
      const capture = (kind: "stdout" | "stderr", raw: Buffer): void => {
        const text = raw.toString("utf8");
        bytes += raw.byteLength;
        if (kind === "stdout") stdout = tailUtf8(stdout, text);
        else stderr = tailUtf8(stderr, text);
        try {
          if (kind === "stdout") options.onStdout?.(text);
          else options.onStderr?.(text);
        } catch (error) {
          fail(new ExecutionError("callback_error", nodeErrorMessage(error)));
          return;
        }
        if (options.onStdout === undefined && options.onStderr === undefined && bytes > BUFFERED_OUTPUT_LIMIT) {
          fail(new ExecutionError("output_limit", `Shell command exceeded the ${BUFFERED_OUTPUT_LIMIT}-byte buffered limit`));
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk));
      if (windows) {
        child.stdio[3]?.on("data", (chunk: Buffer) => {
          if (launcherStatus === "" && chunk.byteLength === 1 && chunk[0] === 0x4f) launcherStatus = "O";
          else launcherStatus = "invalid";
        });
      }
      child.once("error", (error) => finish({
        ok: false,
        error: new ExecutionError(
          windows || this.#shellWasExplicit ? "spawn_error" : "shell_unavailable",
          nodeErrorMessage(error),
        ),
      }));
      child.once("close", (code, signal) => {
        if (failure !== undefined) finish({ ok: false, error: failure });
        else if (windows && launcherStatus !== "O" && !(active.cleanupRequested && launcherStatus === "")) {
          finish({ ok: false, error: new ExecutionError("spawn_error", "The Windows process launcher failed") });
        }
        else finish({ ok: true, value: { stdout, stderr, exitCode: code ?? (signal === null ? 0 : 128) } });
      });
      options.abortSignal?.addEventListener("abort", cancel, { once: true });
      if (options.timeout !== undefined && Number.isFinite(options.timeout) && options.timeout >= 0) {
        timer = setTimeout(() => fail(new ExecutionError("timeout", `Shell command exceeded its time limit of ${options.timeout} seconds`)), options.timeout * 1000);
      }
      if (options.abortSignal?.aborted) cancel();
    });
    active.promise = promise;
    this.#active.add(active);
    return promise.finally(() => this.#active.delete(active));
  }

  async cleanup(): Promise<void> {
    const active = [...this.#active];
    for (const item of active) {
      item.cleanupRequested = true;
      stopProcess(item.child);
    }
    await Promise.allSettled(active.map((item) => item.promise));
    await Promise.resolve();
    await Promise.resolve();
  }
}
