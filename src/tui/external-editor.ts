import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { trackActiveProcessGroup } from "../process/active-groups.js";
import { normalizeCommandArgv, parseCommandLine } from "../process/command.js";
import { terminateProcessTree } from "../process/process-tree.js";

const MAX_EDITOR_BYTES = 256 * 1024;
const EDITOR_TERMINATION_GRACE_MS = 1_000;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("External editor cancelled");
}

export function parseEditorCommand(value: string): string[] {
  return parseCommandLine(value, "VISUAL/EDITOR");
}

export async function editTextExternally(
  initial: string,
  options: { environment?: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal; command?: string } = {},
): Promise<string> {
  const environment = options.environment ?? process.env;
  const command = parseEditorCommand(
    options.command ?? environment.VISUAL ?? environment.EDITOR ?? (process.platform === "win32" ? "notepad" : "nano"),
  );
  const directory = await mkdtemp(join(tmpdir(), "rigyn-editor-"));
  const path = join(directory, "prompt.md");
  try {
    await writeFile(path, initial, { encoding: "utf8", mode: 0o600, flag: "wx" });
    options.signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const [executable, ...args] = normalizeCommandArgv([...command, path], { environment });
      const child = spawn(executable, args, {
        cwd: options.cwd,
        env: environment,
        detached: process.platform !== "win32",
        stdio: "inherit",
        windowsHide: true,
      });
      const releaseProcessGroup = trackActiveProcessGroup(child.pid);
      let settled = false;
      let aborting = false;
      let escalation: NodeJS.Timeout | undefined;
      const cleanup = (): void => {
        releaseProcessGroup();
        if (escalation !== undefined) clearTimeout(escalation);
        options.signal?.removeEventListener("abort", abort);
      };
      const finish = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        operation();
      };
      const terminate = (signal: NodeJS.Signals): void => {
        if (child.pid !== undefined) terminateProcessTree(child.pid, signal);
      };
      const abort = (): void => {
        if (settled || aborting) return;
        aborting = true;
        terminate("SIGTERM");
        escalation = setTimeout(() => terminate("SIGKILL"), EDITOR_TERMINATION_GRACE_MS);
        escalation.unref();
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      child.once("error", (error) => {
        if (aborting) terminate("SIGKILL");
        finish(() => reject(aborting && options.signal !== undefined ? abortReason(options.signal) : error));
      });
      child.once("exit", (code, signal) => {
        if (aborting && options.signal !== undefined) {
          // The editor leader may exit on SIGTERM while a descendant ignores it.
          // A final group kill before releasing ownership prevents that orphan.
          terminate("SIGKILL");
          finish(() => reject(abortReason(options.signal!)));
        } else if (code === 0) finish(resolve);
        else finish(() => reject(new Error(`External editor exited ${signal === null ? `with code ${code ?? "unknown"}` : `from ${signal}`}`)));
      });
      if (options.signal?.aborted === true) abort();
    });
    const contents = await readFile(path);
    if (contents.byteLength > MAX_EDITOR_BYTES) throw new Error(`External editor content exceeds ${MAX_EDITOR_BYTES} bytes`);
    return contents.toString("utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
