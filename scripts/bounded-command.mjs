import { spawn } from "node:child_process";
import { fstatSync } from "node:fs";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { terminateLifecycleProcessTree } from "../packages/rigyn/scripts/lifecycle-common.mjs";

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_OUTPUT_POLL_MS = 25;
const STDERR_TAIL_BYTES = 8 * 1024;
const COMMAND_CLEANUP_GRACE_MS = 2_000;
const MAX_LINUX_DESCENDANTS = 4_096;

function errno(error) {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

async function fileTail(file, size, limit = STDERR_TAIL_BYTES) {
  const length = Math.min(size, limit);
  if (length === 0) return "";
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await file.read(buffer, 0, length, size - length);
  return buffer.subarray(0, bytesRead).toString("utf8");
}

async function filePrefix(file, size) {
  if (size === 0) return "";
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await file.read(buffer, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset).toString("utf8");
}

function killPid(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    return errno(error) === "ESRCH";
  }
}

function processGroupExists(pid) {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return errno(error) !== "ESRCH";
  }
}

async function stopLinuxDescendants(rootPid, descendants, deadline) {
  if (process.platform !== "linux") return;
  try {
    process.kill(-rootPid, "SIGSTOP");
  } catch (error) {
    if (errno(error) === "ESRCH") return;
    throw error;
  }
  const visited = new Set([rootPid]);
  const pending = [rootPid];
  while (pending.length > 0) {
    if (Date.now() >= deadline) throw new Error("Linux descendant snapshot exceeded the cleanup grace");
    const parent = pending.shift();
    let contents;
    try {
      contents = await readFile(`/proc/${parent}/task/${parent}/children`, "utf8");
    } catch (error) {
      if (errno(error) === "ENOENT") continue;
      throw error;
    }
    for (const value of contents.trim().split(/\s+/u)) {
      if (value === "") continue;
      const pid = Number(value);
      if (!Number.isSafeInteger(pid) || pid < 1 || visited.has(pid)) continue;
      visited.add(pid);
      if (descendants.length >= MAX_LINUX_DESCENDANTS) {
        throw new Error(`Release command exceeded ${MAX_LINUX_DESCENDANTS} descendants`);
      }
      if (!killPid(pid, "SIGSTOP")) throw new Error(`Unable to stop release-command descendant ${pid}`);
      descendants.push(pid);
      pending.push(pid);
    }
  }
}

async function terminateCommandTree(child, captureDetachedDescendants, deadline) {
  if (child.pid === undefined) return undefined;
  const descendants = [];
  let failure;
  if (captureDetachedDescendants) {
    try {
      await stopLinuxDescendants(child.pid, descendants, deadline);
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
  }
  for (const pid of descendants.reverse()) {
    if (!killPid(pid, "SIGKILL") && failure === undefined) {
      failure = new Error(`Unable to terminate release-command descendant ${pid}`);
    }
  }
  const signalled = terminateLifecycleProcessTree(child.pid, "SIGKILL");
  if (!signalled && processGroupExists(child.pid) && failure === undefined) {
    failure = new Error(`Unable to terminate release-command process group ${child.pid}`);
  }
  return failure;
}

async function settleWithin(promise, timeoutMs) {
  const timeout = Symbol("timeout");
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(timeout), Math.max(0, timeoutMs)); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Run a release subprocess with file-backed Node 26-safe capture and bounded tree cleanup.
 * The portable ownership boundary is the spawned process group. Linux timeout cleanup also
 * snapshots current descendants through /proc before killing the group. No portable API can
 * rediscover a fully detached descendant after its original parent has already exited.
 */
export async function runBoundedCommand(command, args, options) {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const outputPollMs = options.outputPollMs ?? DEFAULT_OUTPUT_POLL_MS;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new RangeError("maxOutputBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(outputPollMs) || outputPollMs < 1 || outputPollMs > 1_000) {
    throw new RangeError("outputPollMs must be an integer from 1 through 1000");
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new RangeError("timeoutMs must be a positive safe integer");
  }

  const outputRoot = await mkdtemp(join(tmpdir(), "rigyn-release-command-"));
  const stdoutPath = join(outputRoot, "stdout");
  const stderrPath = join(outputRoot, "stderr");
  let stdoutFile;
  let stderrFile;
  let outputMonitor;
  const signalHandlers = new Map();
  try {
    stdoutFile = await open(stdoutPath, "wx+", 0o600);
    stderrFile = await open(stderrPath, "wx+", 0o600);
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", stdoutFile.fd, stderrFile.fd],
      windowsHide: true,
    });
    let settled = false;
    let outputFailure;
    let requestFailure;
    const failureRequested = new Promise((resolve) => { requestFailure = resolve; });
    const failOutput = (error) => {
      if (settled || outputFailure !== undefined) return;
      outputFailure = error;
      requestFailure();
    };
    const interrupt = (signal) => {
      if (outputFailure !== undefined) return;
      outputFailure = new Error(`${options.label} interrupted by ${signal}`);
      requestFailure();
    };
    for (const signal of ["SIGINT", "SIGTERM", ...(process.platform === "win32" ? [] : ["SIGHUP"])]) {
      const handler = () => interrupt(signal);
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
    const inspectOutput = () => {
      if (settled || outputFailure !== undefined) return;
      try {
        if (fstatSync(stdoutFile.fd).size + fstatSync(stderrFile.fd).size > maxOutputBytes) {
          failOutput(new Error(`${options.label} output exceeded ${maxOutputBytes} bytes`));
        }
      } catch (error) {
        failOutput(error instanceof Error ? error : new Error(String(error)));
      }
    };
    outputMonitor = setInterval(inspectOutput, outputPollMs);
    outputMonitor.unref();

    const childSettlement = new Promise((resolveResult) => {
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        resolveResult({ kind: "error", error });
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        resolveResult({ kind: "close", code, signal });
      });
    });
    const timeout = setTimeout(() => {
      failOutput(new Error(`${options.label} timed out after ${options.timeoutMs} ms`));
    }, options.timeoutMs);
    timeout.unref();
    const first = await Promise.race([
      childSettlement,
      failureRequested.then(() => ({ kind: "failure" })),
    ]);
    clearTimeout(timeout);
    if (outputMonitor !== undefined) clearInterval(outputMonitor);

    let result = first.kind === "failure" ? undefined : first;
    let cleanupFailure;
    if (outputFailure !== undefined) {
      const deadline = Date.now() + COMMAND_CLEANUP_GRACE_MS;
      cleanupFailure = await terminateCommandTree(child, true, deadline);
      if (result === undefined) {
        const remaining = await settleWithin(childSettlement, deadline - Date.now());
        if (typeof remaining === "symbol") {
          throw new Error(`${outputFailure.message}; command cleanup did not settle within ${COMMAND_CLEANUP_GRACE_MS} ms`);
        }
        result = remaining;
      }
    }
    cleanupFailure ??= await terminateCommandTree(
      child,
      false,
      Date.now() + COMMAND_CLEANUP_GRACE_MS,
    );
    if (cleanupFailure !== undefined && outputFailure === undefined) outputFailure = cleanupFailure;

    if (result?.kind === "error" && outputFailure === undefined) throw result.error;

    const stdoutSize = fstatSync(stdoutFile.fd).size;
    const stderrSize = fstatSync(stderrFile.fd).size;
    if (stdoutSize + stderrSize > maxOutputBytes && outputFailure === undefined) {
      outputFailure = new Error(`${options.label} output exceeded ${maxOutputBytes} bytes`);
    }
    if (outputFailure !== undefined) {
      const tail = await fileTail(stderrFile, stderrSize);
      throw new Error(`${outputFailure.message}${tail === "" ? "" : `\n${tail}`}`);
    }
    const output = {
      stdout: await filePrefix(stdoutFile, stdoutSize),
      stderr: await filePrefix(stderrFile, stderrSize),
    };
    if (result?.kind !== "close") throw new Error(`${options.label} did not report a process exit`);
    if (result.code !== 0) {
      throw new Error(
        `${options.label} failed${result.code === null ? ` with signal ${result.signal ?? "unknown"}` : ` with exit ${result.code}`}\n${output.stderr.slice(-STDERR_TAIL_BYTES)}`,
      );
    }
    return output;
  } finally {
    if (outputMonitor !== undefined) clearInterval(outputMonitor);
    await Promise.allSettled([stdoutFile?.close(), stderrFile?.close()].filter(Boolean));
    await rm(outputRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  }
}
