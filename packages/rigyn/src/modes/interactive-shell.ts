import { stat } from "node:fs/promises";

import { errorMessage } from "../core/errors.js";
import type { EventEnvelope, RuntimeEvent } from "../core/events.js";
import { createId } from "../core/ids.js";
import type { RuntimeExtensionHost } from "../extensions/runtime.js";
import type { AgentSession, AgentSessionBashResult } from "../service/agent-session.js";
import { WorkspaceBoundary } from "../tools/paths.js";
import { normalizeShellTerminalState } from "../tools/shell-result.js";

export interface InteractiveShellOptions {
  command: string;
  hidden: boolean;
  workspace: string;
  host: RuntimeExtensionHost;
  session: AgentSession;
  signal?: AbortSignal;
  onPrepared?(command: string): void;
  onChunk?(chunk: string): void;
}

interface InteractiveShellPresentationTerminal {
  render(event: EventEnvelope): void;
  settleStandaloneTool(callId: string): void;
}

export interface InteractiveShellPresentation {
  onChunk(chunk: string): void;
  complete(result: AgentSessionBashResult): void;
  fail(cause: unknown): void;
}

/** Projects a user shell shortcut through the same retained tool-card renderer as model tools. */
export function beginInteractiveShellPresentation(options: {
  terminal: InteractiveShellPresentationTerminal;
  threadId: string;
  command: string;
  hidden: boolean;
  now?: () => number;
}): InteractiveShellPresentation {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const runId = createId("shell-run");
  const callId = createId("shell");
  let sequence = 0;
  let outputBytes = 0;
  let settled = false;
  const input = {
    command: options.hidden ? `!! ${options.command}` : options.command,
    ...(options.hidden ? { excludeFromContext: true } : {}),
  };
  const emit = (event: RuntimeEvent): void => {
    sequence += 1;
    options.terminal.render({
      eventId: `${runId}:${sequence}`,
      threadId: options.threadId,
      runId,
      sequence,
      timestamp: new Date(now()).toISOString(),
      schemaVersion: 1,
      event,
    });
  };
  emit({ type: "tool_requested", callId, name: "bash", input, index: 0 });
  emit({ type: "tool_started", callId, name: "bash", input, index: 0, recoveryMode: "repeatable" });

  const finish = (result: AgentSessionBashResult, cause?: unknown): void => {
    if (settled) return;
    settled = true;
    const message = cause === undefined ? result.output : errorMessage(cause);
    const isError = cause !== undefined ||
      result.isError === true ||
      result.cancelled ||
      result.timedOut === true ||
      result.signal !== undefined ||
      (result.exitCode !== undefined && result.exitCode !== 0);
    const metadata = {
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(result.cancelled ? { cancelled: true } : {}),
      ...(result.timedOut === undefined ? {} : { timedOut: result.timedOut }),
      ...(result.signal === undefined ? {} : { signal: result.signal }),
      ...(result.truncated ? { truncated: true } : {}),
      ...(result.fullOutputPath === undefined ? {} : { fullOutputPath: result.fullOutputPath }),
      durationMs: Math.max(0, now() - startedAt),
    };
    emit({
      type: "tool_completed",
      callId,
      name: "bash",
      index: 0,
      isError,
      preview: message,
      result: {
        type: "tool_result",
        callId,
        name: "bash",
        content: message,
        isError,
        metadata,
      },
    });
    options.terminal.settleStandaloneTool(callId);
  };

  return {
    onChunk(chunk) {
      if (settled || chunk === "") return;
      outputBytes += Buffer.byteLength(chunk, "utf8");
      emit({
        type: "tool_progress",
        callId,
        name: "bash",
        index: 0,
        sequence,
        progress: {
          type: "output",
          stream: "stdout",
          delta: chunk,
          stdoutBytes: outputBytes,
          stderrBytes: 0,
          elapsedMs: Math.max(0, now() - startedAt),
        },
      });
    },
    complete(result) { finish(result); },
    fail(cause) {
      finish({ output: "", exitCode: undefined, cancelled: false, truncated: false }, cause);
    },
  };
}

/** Runs the shared interactive shell contract, including extension hooks and persistence. */
export async function runInteractiveShell(options: InteractiveShellOptions): Promise<AgentSessionBashResult> {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const reduction = await options.host.reduceBeforeUserShell({
    command: options.command,
    cwd: options.workspace,
    hidden: options.hidden,
  }, signal);
  options.onPrepared?.(reduction.command);
  const boundary = await WorkspaceBoundary.create(options.workspace);
  const cwd = await boundary.readable(reduction.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error(`Shell shortcut cwd is not a directory: ${reduction.cwd}`);
  signal.throwIfAborted();
  let result: AgentSessionBashResult;
  if (reduction.action === "handled") {
    const terminal = normalizeShellTerminalState(reduction.result, {
      legacySignalImpliesCancellation: true,
    });
    result = {
      output: reduction.result.text,
      exitCode: terminal.exitCode,
      ...(terminal.isError === undefined ? {} : { isError: terminal.isError }),
      cancelled: terminal.cancelled,
      ...(terminal.timedOut === undefined ? {} : { timedOut: terminal.timedOut }),
      ...(terminal.signal === undefined ? {} : { signal: terminal.signal }),
      truncated: reduction.result.truncated === true,
      ...(reduction.result.fullOutputPath === undefined
        ? {}
        : { fullOutputPath: reduction.result.fullOutputPath }),
    };
  } else {
    const abort = (): void => options.session.abortBash();
    signal.addEventListener("abort", abort, { once: true });
    try {
      result = await options.session.executeBash(
      reduction.command,
        options.onChunk,
        {
          excludeFromContext: options.hidden,
          timeoutMs: 600_000,
          cwd,
          ...(reduction.operations === undefined ? {} : { operations: reduction.operations }),
        },
      );
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  if (reduction.action === "handled") {
    options.session.recordBashResult(reduction.command, result, { excludeFromContext: options.hidden });
  }
  await options.host.dispatch("event", {
    type: "user_shell",
    command: reduction.command,
    hidden: options.hidden,
    result: {
      text: result.output,
      exitCode: result.exitCode ?? null,
      ...(result.isError === undefined ? {} : { isError: result.isError }),
      cancelled: result.cancelled,
      ...(result.timedOut === undefined ? {} : { timedOut: result.timedOut }),
      ...(result.signal === undefined
        ? result.cancelled ? { signal: "CANCELLED" } : {}
        : { signal: result.signal }),
      truncated: result.truncated,
      ...(result.fullOutputPath === undefined ? {} : { fullOutputPath: result.fullOutputPath }),
    },
  }, signal);
  return result;
}
