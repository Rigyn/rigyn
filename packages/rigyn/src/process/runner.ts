import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

import { trackActiveProcessGroup } from "./active-groups.js";
import { terminateProcessTree } from "./process-tree.js";
import type { CommandResult, CommandSpec, ProcessRunner } from "./types.js";

const OUTPUT_DRAIN_IDLE_MS = 250;
const OUTPUT_DRAIN_MAX_MS = 1_000;
const OUTPUT_OBSERVER_DRAIN_MAX_MS = 1_000;
const TERMINATION_ESCALATION_MS = 2_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function validateTimeout(timeoutMs: number | undefined): void {
  if (
    timeoutMs !== undefined
    && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMER_DELAY_MS)
  ) {
    throw new RangeError(`timeoutMs must be an integer from 0 to ${MAX_TIMER_DELAY_MS}`);
  }
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export async function resolveExecutable(
  name: string,
  options: { excludedRoot?: string; environment?: NodeJS.ProcessEnv } = {},
): Promise<string | undefined> {
  const excluded = options.excludedRoot === undefined ? undefined : await realpath(options.excludedRoot);
  for (const directory of (options.environment ?? process.env).PATH?.split(delimiter) ?? []) {
    if (!isAbsolute(directory)) continue;
    const candidate = resolve(directory, name);
    try {
      await access(candidate, constants.X_OK);
      const resolved = await realpath(candidate);
      if (!(await stat(resolved)).isFile()) continue;
      if (excluded !== undefined && inside(excluded, resolved)) continue;
      return resolved;
    } catch {
      // Continue searching PATH.
    }
  }
  return undefined;
}

function appendBounded(parts: Buffer[], chunk: Buffer, state: { retained: number }, limit: number): void {
  if (state.retained >= limit) return;
  const remaining = limit - state.retained;
  const retained = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  parts.push(retained);
  state.retained += retained.length;
}

export async function runProcess(spec: CommandSpec, signal: AbortSignal): Promise<CommandResult> {
  validateTimeout(spec.timeoutMs);
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  const started = performance.now();
  const [command, ...args] = spec.argv;
  const child = spawn(command, args, {
    cwd: spec.cwd,
    env: spec.inheritEnv === false ? { ...spec.env } : { ...process.env, ...spec.env },
    detached: process.platform !== "win32",
    shell: false,
    windowsHide: true,
    stdio: "pipe",
  });
  const childStdout = child.stdout!;
  const childStderr = child.stderr!;
  const releaseProcessGroup = trackActiveProcessGroup(child.pid);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const stdoutState = { retained: 0 };
  const stderrState = { retained: 0 };
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  let cancelled = false;
  let settled = false;
  let finishing = false;
  let parentOutcome: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let escalation: NodeJS.Timeout | undefined;
  let drainIdle: NodeJS.Timeout | undefined;
  let drainMaximum: NodeJS.Timeout | undefined;
  let observerMaximum: NodeJS.Timeout | undefined;
  let killEscalated = false;
  let pendingObservers = 0;
  let observerTail = Promise.resolve();

  return await new Promise<CommandResult>((resolveOutcome, rejectOutcome) => {
    const cleanup = (): void => {
      releaseProcessGroup();
      if (timeout !== undefined) clearTimeout(timeout);
      if (escalation !== undefined) clearTimeout(escalation);
      if (drainIdle !== undefined) clearTimeout(drainIdle);
      if (drainMaximum !== undefined) clearTimeout(drainMaximum);
      if (observerMaximum !== undefined) clearTimeout(observerMaximum);
      signal.removeEventListener("abort", onAbort);
    };

    const complete = (
      outcome: { exitCode: number | null; signal: NodeJS.Signals | null },
      terminateRemainder: boolean,
    ): void => {
      if (settled) return;
      settled = true;
      if (terminateRemainder && child.pid !== undefined) {
        terminateProcessTree(child.pid, "SIGTERM");
        terminateProcessTree(child.pid, "SIGKILL");
      }
      cleanup();
      resolveOutcome({
        ...outcome,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        stdoutBytes,
        stderrBytes,
        timedOut,
        cancelled,
        durationMs: Math.round(performance.now() - started),
      });
    };

    const finish = (
      outcome: { exitCode: number | null; signal: NodeJS.Signals | null },
      destroyPipes = false,
    ): void => {
      if (settled || finishing) return;
      finishing = true;
      if (destroyPipes) {
        childStdout.destroy();
        childStderr.destroy();
      }
      const terminateRemainder = process.platform !== "win32" || destroyPipes || timedOut || cancelled;
      if (pendingObservers === 0) {
        complete(outcome, terminateRemainder);
        return;
      }
      observerMaximum = setTimeout(
        () => complete(outcome, terminateRemainder),
        OUTPUT_OBSERVER_DRAIN_MAX_MS,
      );
      observerMaximum.unref();
      void observerTail.finally(() => {
        if (observerMaximum !== undefined) clearTimeout(observerMaximum);
        observerMaximum = undefined;
        complete(outcome, terminateRemainder);
      });
    };

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectOutcome(error);
    };

    const observe = (stream: "stdout" | "stderr", value: Buffer): void => {
      if (spec.onOutput === undefined) return;
      pendingObservers += 1;
      childStdout.pause();
      childStderr.pause();
      const chunk = Buffer.from(value);
      observerTail = observerTail
        .then(async () => {
          try {
            await spec.onOutput!(stream, chunk);
          } catch {
            // Output observation is best effort and must not interrupt pipe drainage.
          }
        })
        .finally(() => {
          pendingObservers -= 1;
          if (pendingObservers === 0 && !settled && !finishing) {
            childStdout.resume();
            childStderr.resume();
          }
        });
    };

    const rearmDrainIdle = (): void => {
      if (settled || parentOutcome === undefined || drainMaximum === undefined) return;
      if (drainIdle !== undefined) clearTimeout(drainIdle);
      drainIdle = setTimeout(() => finish(parentOutcome!, true), OUTPUT_DRAIN_IDLE_MS);
    };

    const beginDrain = (): void => {
      if (settled || parentOutcome === undefined || drainMaximum !== undefined) return;
      drainMaximum = setTimeout(() => finish(parentOutcome!, true), OUTPUT_DRAIN_MAX_MS);
      rearmDrainIdle();
    };

    const terminate = (reason: "timeout" | "cancel"): void => {
      if (settled || parentOutcome !== undefined || timedOut || cancelled || child.pid === undefined) return;
      if (reason === "timeout") timedOut = true;
      else cancelled = true;
      terminateProcessTree(child.pid, "SIGTERM");
      escalation = setTimeout(() => {
        if (settled || child.pid === undefined) return;
        killEscalated = true;
        terminateProcessTree(child.pid, "SIGKILL");
        beginDrain();
      }, TERMINATION_ESCALATION_MS);
      escalation.unref();
    };

    const onAbort = (): void => terminate("cancel");
    if (spec.timeoutMs !== undefined) {
      timeout = setTimeout(() => terminate("timeout"), spec.timeoutMs);
      timeout.unref();
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    childStdout.on("data", (value: Buffer) => {
      if (settled || finishing) return;
      stdoutBytes += value.length;
      appendBounded(stdout, value, stdoutState, spec.outputLimitBytes);
      observe("stdout", value);
      rearmDrainIdle();
    });
    childStderr.on("data", (value: Buffer) => {
      if (settled || finishing) return;
      stderrBytes += value.length;
      appendBounded(stderr, value, stderrState, spec.outputLimitBytes);
      observe("stderr", value);
      rearmDrainIdle();
    });
    child.once("error", fail);
    child.once("exit", (exitCode, exitSignal) => {
      parentOutcome = { exitCode, signal: exitSignal };
      if (timeout !== undefined) clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      if ((!timedOut && !cancelled) || killEscalated) beginDrain();
    });
    child.once("close", (exitCode, exitSignal) => {
      // Keep the bounded post-exit drain authoritative until both pipes reach readable EOF.
      if (drainMaximum !== undefined && (!childStdout.readableEnded || !childStderr.readableEnded)) return;
      finish(parentOutcome ?? { exitCode, signal: exitSignal });
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // libuv reports a child closing stdin as EPIPE on POSIX and EOF on Windows.
      if (error.code !== "EPIPE" && error.code !== "EOF") fail(error);
    });

    if (spec.stdin === undefined) child.stdin.end();
    else child.stdin.end(spec.stdin);
  });
}

export class DirectProcessRunner implements ProcessRunner {
  async run(spec: CommandSpec, signal: AbortSignal): Promise<CommandResult> {
    return await runProcess(spec, signal);
  }
}
