import { stat } from "node:fs/promises";

import type { SettingsManager } from "../core/settings-manager.js";
import type { RuntimeExtensionHost } from "../extensions/runtime.js";
import { runShellShortcut, shellShortcutEnvironment } from "../process/user-shell.js";
import type { AgentSession, AgentSessionBashResult } from "../service/agent-session.js";
import { WorkspaceBoundary } from "../tools/paths.js";

export interface InteractiveShellOptions {
  command: string;
  hidden: boolean;
  workspace: string;
  host: RuntimeExtensionHost;
  session: AgentSession;
  settings: SettingsManager;
  environment?: NodeJS.ProcessEnv;
}

/** Runs the shared interactive shell contract, including extension hooks and persistence. */
export async function runInteractiveShell(options: InteractiveShellOptions): Promise<AgentSessionBashResult> {
  const signal = new AbortController().signal;
  const reduction = await options.host.reduceBeforeUserShell({
    command: options.command,
    cwd: options.workspace,
    hidden: options.hidden,
  }, signal);
  const boundary = await WorkspaceBoundary.create(options.workspace);
  const cwd = await boundary.readable(reduction.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error(`Shell shortcut cwd is not a directory: ${reduction.cwd}`);
  let result: AgentSessionBashResult;
  if (reduction.action === "handled") {
    result = {
      output: reduction.result.text,
      exitCode: reduction.result.exitCode ?? undefined,
      cancelled: reduction.result.signal !== undefined,
      truncated: false,
    };
  } else if (reduction.operations !== undefined) {
    const chunks: Buffer[] = [];
    const execution = await reduction.operations.exec(reduction.command, cwd, {
      onData(data) { chunks.push(Buffer.from(data)); },
      signal,
      timeout: 600,
      env: shellShortcutEnvironment(options.environment ?? process.env),
    });
    const output = chunks.length === 0 ? "" : Buffer.concat(chunks).toString("utf8").replace(/\s+$/u, "");
    result = {
      output: [`$ ${reduction.command}`, output || undefined, `exit ${execution.exitCode ?? "unknown"}`].filter(Boolean).join("\n"),
      exitCode: execution.exitCode ?? undefined,
      cancelled: false,
      truncated: false,
    };
  } else {
    const execution = await runShellShortcut(
      reduction.command,
      cwd,
      signal,
      600_000,
      options.environment ?? process.env,
      undefined,
      options.settings.getShellPath(),
      options.settings.getShellCommandPrefix(),
    );
    result = {
      output: execution.text,
      exitCode: execution.exitCode ?? undefined,
      cancelled: execution.signal !== undefined,
      truncated: false,
    };
  }
  options.session.recordBashResult(reduction.command, result, { excludeFromContext: options.hidden });
  await options.host.dispatch("event", {
    type: "user_shell",
    command: reduction.command,
    hidden: options.hidden,
    result: {
      text: result.output,
      exitCode: result.exitCode ?? null,
      ...(result.cancelled ? { signal: "CANCELLED" } : {}),
    },
  }, signal);
  return result;
}
