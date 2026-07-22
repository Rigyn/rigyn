import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { win32 } from "node:path";

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
        timeout: 2_000,
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
  } catch {
    return false;
  }
}
