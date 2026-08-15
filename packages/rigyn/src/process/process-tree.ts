import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { win32 } from "node:path";

const TASKKILL_TIMEOUT_MS = 2_000;

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ESRCH";
}

export type ProcessTreeTerminationPlan =
  | { kind: "group"; pid: number; signal: NodeJS.Signals }
  | { kind: "taskkill"; command: string; args: ["/PID", string, "/T", "/F"]; fallbackPid: number; fallbackSignal: NodeJS.Signals }
  | { kind: "direct"; pid: number; signal: NodeJS.Signals };

export interface ProcessTreeTerminationOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  spawnSync?: (
    command: string,
    args: readonly string[],
    options: { shell: false; stdio: "ignore"; timeout: number; windowsHide: true },
  ) => Pick<SpawnSyncReturns<Buffer>, "error" | "status">;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

interface AsyncTerminationChild {
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

type AsyncTerminationTimer = number | NodeJS.Timeout;

interface AsyncProcessTreeTerminationOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  spawn?: (
    command: string,
    args: readonly string[],
    options: { shell: false; stdio: "ignore"; windowsHide: true },
  ) => AsyncTerminationChild;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  setTimeout?: (callback: () => void, delay: number) => AsyncTerminationTimer;
  clearTimeout?: (timeout: AsyncTerminationTimer) => void;
}

export function processTreeTerminationPlan(
  pid: number,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): ProcessTreeTerminationPlan {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError("Process-tree PID must be a positive safe integer");
  if (platform !== "win32") return { kind: "group", pid: -pid, signal };
  const root = environment.SystemRoot ?? environment.WINDIR;
  if (root !== undefined && !root.includes("\0") && /^[A-Za-z]:[\\/]/u.test(root)) {
    return {
      kind: "taskkill",
      command: win32.join(win32.resolve(root), "System32", "taskkill.exe"),
      args: ["/PID", String(pid), "/T", "/F"],
      fallbackPid: pid,
      fallbackSignal: signal,
    };
  }
  return { kind: "direct", pid, signal };
}

/** Best-effort whole-tree signal; Windows uses taskkill /T /F and POSIX targets the detached group. */
export function terminateProcessTree(
  pid: number,
  signal: NodeJS.Signals,
  options: ProcessTreeTerminationOptions = {},
): boolean {
  const plan = processTreeTerminationPlan(
    pid,
    signal,
    options.platform,
    options.environment,
  );
  const kill = options.kill ?? ((target, selectedSignal) => process.kill(target, selectedSignal));
  if (plan.kind === "taskkill") {
    try {
      const result = (options.spawnSync ?? spawnSync)(plan.command, plan.args, {
        shell: false,
        stdio: "ignore",
        timeout: TASKKILL_TIMEOUT_MS,
        windowsHide: true,
      });
      if (result.error === undefined && result.status === 0) return true;
    } catch {}
    try {
      kill(plan.fallbackPid, plan.fallbackSignal);
      return true;
    } catch {
      return false;
    }
  }
  try {
    kill(plan.pid, plan.signal);
    return true;
  } catch (error) {
    return plan.kind === "group" && isMissingProcess(error);
  }
}

/** @internal Non-blocking runtime termination; process-exit fallbacks use the synchronous helper above. */
export async function terminateProcessTreeAsync(
  pid: number,
  signal: NodeJS.Signals,
  options: AsyncProcessTreeTerminationOptions = {},
): Promise<boolean> {
  try {
    const plan = processTreeTerminationPlan(
      pid,
      signal,
      options.platform,
      options.environment,
    );
    const kill = options.kill ?? ((target, selectedSignal) => process.kill(target, selectedSignal));
    const direct = (
      target: number,
      selectedSignal: NodeJS.Signals,
      missingIsSuccess = false,
    ): boolean => {
      try {
        kill(target, selectedSignal);
        return true;
      } catch (error) {
        return missingIsSuccess && isMissingProcess(error);
      }
    };
    if (plan.kind !== "taskkill") return direct(plan.pid, plan.signal, plan.kind === "group");

    return await new Promise<boolean>((resolveResult) => {
      let child: AsyncTerminationChild | undefined;
      let helperExpired = false;
      let settled = false;
      let timer: AsyncTerminationTimer | undefined;
      const clearTimer = (): void => {
        if (timer === undefined) return;
        try {
          (options.clearTimeout ?? clearTimeout)(timer);
        } catch {}
        timer = undefined;
      };
      const finish = (result: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimer();
        resolveResult(result);
      };
      const fallback = (): void => {
        if (settled) return;
        finish(direct(plan.fallbackPid, plan.fallbackSignal));
      };
      try {
        child = (options.spawn ?? ((command, args, spawnOptions) =>
          spawn(command, args, spawnOptions)))(plan.command, plan.args, {
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        });
        child.once("error", () => {
          if (!helperExpired) fallback();
        });
        child.once("close", (code) => {
          if (helperExpired) return;
          if (code === 0) finish(true);
          else fallback();
        });
        if (settled) return;
        const scheduled = (options.setTimeout ?? setTimeout)(() => {
          if (settled) return;
          helperExpired = true;
          try {
            child?.kill("SIGKILL");
          } catch {}
          fallback();
        }, TASKKILL_TIMEOUT_MS);
        timer = scheduled;
        if (typeof scheduled === "object") scheduled.unref?.();
      } catch {
        fallback();
      }
    });
  } catch {
    return false;
  }
}
