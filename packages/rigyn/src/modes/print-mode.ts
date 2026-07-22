import type { ImageBlock } from "../core/types.js";
import { flushRawStdout, writeRawStdout } from "../interfaces/output-guard.js";
import type { AgentSessionRuntime } from "../service/agent-session-runtime.js";
import type { SessionContextMessage } from "../storage/types.js";
import { terminateTrackedProcessGroups } from "../process/active-groups.js";

export interface PrintModeOptions {
  mode: "text" | "json";
  messages?: readonly string[];
  initialMessage?: string;
  initialImages?: ImageBlock[];
  /** Optional output sink for embedded hosts and tests. Defaults to stdout. */
  write?: (text: string) => void;
}

function assistantFailure(message: SessionContextMessage | undefined): string | undefined {
  if (message?.role !== "assistant") return undefined;
  const reason = message.stopReason as string | undefined;
  if (reason !== "error" && reason !== "cancelled" && reason !== "aborted") return undefined;
  return message.errorMessage ?? `Request ${reason}`;
}

function assistantText(message: SessionContextMessage | undefined): string[] {
  if (message?.role !== "assistant") return [];
  return message.content.flatMap((part) => part.type === "text" ? [part.text] : []);
}

/** Run one or more prompts against the live session and then dispose its complete runtime. */
export async function runPrintMode(runtime: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
  const { mode, messages = [], initialMessage, initialImages } = options;
  const write = options.write ?? writeRawStdout;
  let session = runtime.session;
  let unsubscribe: (() => void) | undefined;
  let disposed = false;
  const signalCleanups: Array<() => void> = [];

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    unsubscribe?.();
    await runtime.dispose();
  };

  const bind = async (): Promise<void> => {
    session = runtime.session;
    await session.bindExtensions();
    unsubscribe?.();
    unsubscribe = session.subscribe((event) => {
      if (mode === "json") write(`${JSON.stringify(event)}\n`);
    });
  };

  runtime.setRebindSession(bind);
  for (const signal of process.platform === "win32" ? ["SIGTERM"] as const : ["SIGTERM", "SIGHUP"] as const) {
    const handler = (): void => {
      terminateTrackedProcessGroups();
      void dispose().finally(() => process.exit(signal === "SIGHUP" ? 129 : 143));
    };
    process.on(signal, handler);
    signalCleanups.push(() => process.off(signal, handler));
  }

  try {
    if (mode === "json") {
      const header = session.sessionManager.getHeader();
      if (header !== null) write(`${JSON.stringify(header)}\n`);
    }
    await bind();
    if (initialMessage !== undefined && initialMessage !== "") {
      await session.prompt(initialMessage, initialImages === undefined ? {} : { images: initialImages });
    }
    for (const message of messages) await session.prompt(message);

    if (mode === "text") {
      const last = session.state.messages.at(-1);
      const failure = assistantFailure(last);
      if (failure !== undefined) {
        console.error(failure);
        return 1;
      }
      for (const text of assistantText(last)) write(`${text}\n`);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    for (const cleanup of signalCleanups) cleanup();
    await dispose();
    if (options.write === undefined) await flushRawStdout();
  }
}
