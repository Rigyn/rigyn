import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

import { defaultSecretRedactor } from "../auth/redaction.js";
import type { RuntimeDirectUiContext } from "../extensions/runtime.js";
import { RpcExtensionUiBridge } from "../interfaces/rpc-extension-ui.js";
import { takeOverStdout, flushRawStdout, restoreStdout } from "../interfaces/output-guard.js";
import { RpcRuntimeDispatcher } from "../interfaces/rpc-runtime.js";
import { attachJsonlLineReader, parseRpcInput, RpcWriter } from "../interfaces/rpc.js";
import type { RpcCommand, RpcExtensionUiResponse, RpcResponse } from "../interfaces/rpc-protocol.js";
import type { AgentSessionRuntime } from "../service/agent-session-runtime.js";

const SHUTDOWN_SETTLE_TIMEOUT_MS = 5_000;
const NODE_MAJOR = Number(process.versions.node.split(".", 1)[0]);
const STDIN_RELAY = String.raw`
const { createReadStream, writeFileSync } = require("node:fs");
let done = false;
process.once("disconnect", () => { if (!done) process.kill(process.pid, "SIGKILL"); });
(async () => {
  try { for await (const chunk of createReadStream("", { fd: 0 })) writeFileSync(1, chunk); }
  finally { done = true; if (process.connected) process.disconnect(); }
})();
`;

interface RpcModeInput {
  readonly stream: Readable;
  close(): void;
}

function createModeInput(): RpcModeInput {
  if (NODE_MAJOR < 26) {
    return {
      stream: process.stdin,
      close() { process.stdin.pause(); },
    };
  }
  // Node 26 can report EOF on process.stdin before a delayed ESM entry point
  // consumes already-buffered pipe data. A tiny relay owns fd 0 immediately in
  // a fresh process and exposes an ordinary pipe to the mode.
  const relay = spawn(process.execPath, ["--input-type=commonjs", "--eval", STDIN_RELAY], {
    stdio: [0, "pipe", "ignore", "ipc"],
    windowsHide: true,
  });
  if (relay.stdout === null) throw new Error("RPC stdin relay pipe is unavailable");
  let closing = false;
  relay.stdout.on("error", () => undefined);
  return {
    stream: relay.stdout,
    close() {
      if (closing) return;
      closing = true;
      if (relay.exitCode === null && relay.signalCode === null) relay.kill("SIGKILL");
      relay.stdout?.destroy();
    },
  };
}

function message(error: unknown): string {
  return defaultSecretRedactor.redact(error instanceof Error ? error.message : String(error));
}

function errorResponse(id: string | undefined, command: string, error: unknown): RpcResponse {
  return {
    ...(id === undefined ? {} : { id }),
    type: "response",
    command,
    success: false,
    error: message(error),
  };
}

async function settleBounded(promises: readonly Promise<unknown>[]): Promise<void> {
  if (promises.length === 0) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.allSettled(promises),
      new Promise<void>((done) => { timer = setTimeout(done, SHUTDOWN_SETTLE_TIMEOUT_MS); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Run an already-created session runtime over newline-delimited JSON on the
 * process streams. The mode owns the runtime until stdin closes, a termination
 * signal arrives, or an extension asks the host to shut down.
 */
export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
  takeOverStdout();
  const writer = new RpcWriter();
  const lifecycle = new AbortController();
  const bridge = new RpcExtensionUiBridge({ async emit(request) { await writer.send(request); } });
  let shutdownRequested = false;
  let shuttingDown = false;
  let detachInput = (): void => undefined;
  let unsubscribeSettled = (): void => undefined;
  const handlers = new Set<Promise<void>>();
  const input = createModeInput();

  const dispatcher = new RpcRuntimeDispatcher({
    runtime: runtimeHost,
    async output(value) { await writer.send(value); },
    async bindSession(session) {
      unsubscribeSettled();
      const ui = bridge.context("runtime", lifecycle.signal) as RuntimeDirectUiContext;
      await session.bindExtensions({
        mode: "rpc",
        uiContext: ui,
        abortHandler: () => { void session.abort("Cancelled by extension"); },
        shutdownHandler: () => {
          shutdownRequested = true;
          if (session.isIdle) void shutdown();
        },
        onError(error) {
          void writer.send({
            type: "extension_error",
            extensionPath: error.extensionPath,
            event: error.event,
            error: error.error,
          });
        },
      });
      unsubscribeSettled = session.subscribe((event) => {
        if (event.type === "agent_settled" && shutdownRequested) void shutdown();
      });
    },
  });

  const cleanupSignals: Array<() => void> = [];
  const shutdown = async (exitCode = 0): Promise<never> => {
    if (shuttingDown) {
      process.exit(exitCode);
    }
    shuttingDown = true;
    lifecycle.abort(new Error("RPC mode stopped"));
    detachInput();
    input.close();
    for (const cleanup of cleanupSignals) cleanup();
    unsubscribeSettled();
    await settleBounded([...handlers]);
    bridge.close();
    await dispatcher.close();
    try {
      await runtimeHost.dispose();
      await flushRawStdout();
    } finally {
      restoreStdout();
    }
    process.exit(exitCode);
  };

  const handle = async (line: string): Promise<void> => {
    if (line.trim() === "") return;
    let record;
    try {
      record = parseRpcInput(line);
    } catch (error) {
      await writer.send(errorResponse(undefined, "parse", `Failed to parse command: ${message(error)}`));
      return;
    }
    if (record.type === "extension_ui_response") {
      bridge.handle(record as RpcExtensionUiResponse);
      return;
    }
    const response = await dispatcher.dispatch(record as RpcCommand);
    if (response !== undefined) await writer.send(response);
    if (shutdownRequested && runtimeHost.session.isIdle) await shutdown();
  };

  const submit = (line: string): void => {
    if (shuttingDown) return;
    const operation = handle(line)
      .catch(async (error: unknown) => {
        await writer.send(errorResponse(undefined, "parse", error)).catch(() => undefined);
      })
      .finally(() => handlers.delete(operation));
    handlers.add(operation);
  };

  try {
    await dispatcher.start();
    const onEnd = (): void => { void shutdown(); };
    const detachLines = attachJsonlLineReader(input.stream, submit);
    // Register shutdown after the decoder so a final unterminated record is
    // submitted before the handler set is snapshotted for cleanup.
    input.stream.once("end", onEnd);
    detachInput = () => {
      detachLines();
      input.stream.off("end", onEnd);
    };
    const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
    for (const signal of signals) {
      const handler = (): void => { void shutdown(signal === "SIGHUP" ? 129 : 143); };
      process.on(signal, handler);
      cleanupSignals.push(() => process.off(signal, handler));
    }
  } catch (error) {
    await writer.send(errorResponse(undefined, "startup", error)).catch(() => undefined);
    await shutdown(1);
  }

  return await new Promise<never>(() => undefined);
}
