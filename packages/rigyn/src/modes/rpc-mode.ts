import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

import { defaultSecretRedactor } from "../auth/redaction.js";
import type { RuntimeDirectUiContext } from "../extensions/runtime.js";
import { RpcExtensionUiBridge } from "../interfaces/rpc-extension-ui.js";
import { boundedRpcErrorMessage } from "../interfaces/rpc-error.js";
import { takeOverStdout, flushRawStdout, restoreStdout } from "../interfaces/output-guard.js";
import { RpcRuntimeDispatcher } from "../interfaces/rpc-runtime.js";
import {
  attachJsonlLineReader,
  parseRpcInput,
  RpcWriter,
  type ParsedRpcInput,
} from "../interfaces/rpc.js";
import type { RpcCommand, RpcExtensionUiResponse, RpcResponse } from "../interfaces/rpc-protocol.js";
import {
  type AgentSessionRuntime,
} from "../service/agent-session-runtime.js";
import { createAgentSessionRuntimeCommandActions } from "../service/runtime-command-actions.js";

const SHUTDOWN_SETTLE_TIMEOUT_MS = 5_000;
const MAX_CONCURRENT_RPC_HANDLERS = 64;
const MAX_PENDING_RPC_COMMANDS = 1_024;
const MAX_RELAY_STDERR_BYTES = 4_096;
const PRIORITY_RPC_COMMANDS = new Set(["abort", "abort_bash", "abort_retry"]);
const STDIN_RELAY = String.raw`
const { createReadStream, writeFileSync } = require("node:fs");
let done = false;
process.once("disconnect", () => { if (!done) process.kill(process.pid, "SIGKILL"); });
(async () => {
  try { for await (const chunk of createReadStream("", { fd: 0 })) writeFileSync(1, chunk); }
  catch (error) {
    try { writeFileSync(2, error instanceof Error ? error.message : String(error)); } catch {}
    process.exitCode = 1;
  }
  finally { done = true; if (process.connected) process.disconnect(); }
})();
`;

interface RpcModeInput {
  readonly stream: Readable;
  close(): void;
  failure(): Promise<Error | undefined>;
}

function createModeInput(): RpcModeInput {
  // Node can report EOF on process.stdin before a delayed ESM entry point
  // consumes already-buffered pipe data. A tiny relay owns fd 0 immediately in
  // a fresh process and exposes an ordinary pipe to the mode.
  const relay = spawn(process.execPath, ["--input-type=commonjs", "--eval", STDIN_RELAY], {
    stdio: [0, "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  if (relay.stdout === null || relay.stderr === null) throw new Error("RPC stdin relay pipes are unavailable");
  let closing = false;
  let diagnostic = Buffer.alloc(0);
  relay.stderr.on("data", (value: Buffer) => {
    if (diagnostic.length >= MAX_RELAY_STDERR_BYTES) return;
    const chunk = Buffer.from(value);
    diagnostic = Buffer.concat([
      diagnostic,
      chunk.subarray(0, MAX_RELAY_STDERR_BYTES - diagnostic.length),
    ]);
  });
  const settled = new Promise<Error | undefined>((finish) => {
    let done = false;
    const settle = (error?: Error): void => {
      if (done) return;
      done = true;
      finish(error);
    };
    relay.once("error", settle);
    relay.once("close", (code, signal) => {
      if (closing || code === 0) {
        settle();
        return;
      }
      const detail = diagnostic.toString("utf8").trim();
      settle(new Error(
        `RPC stdin relay failed${code === null ? ` with signal ${signal ?? "unknown"}` : ` with exit ${code}`}${detail === "" ? "" : `: ${detail}`}`,
      ));
    });
  });
  relay.stdout.on("error", () => undefined);
  return {
    stream: relay.stdout,
    close() {
      if (closing) return;
      closing = true;
      if (relay.exitCode === null && relay.signalCode === null) relay.kill("SIGKILL");
      relay.stdout?.destroy();
      relay.stderr?.destroy();
    },
    async failure() { return await settled; },
  };
}

function message(error: unknown): string {
  return boundedRpcErrorMessage(error);
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
  let shutdownFlight: Promise<never> | undefined;
  let detachInput = (): void => undefined;
  let unsubscribeSettled = (): void => undefined;
  const handlers = new Set<Promise<void>>();
  const pendingInputs: Array<{ record?: ParsedRpcInput; error?: unknown }> = [];
  let pendingOffset = 0;
  let inputEnded = false;
  let inputOverloaded = false;
  let finishingInput = false;
  let priorityPending = 0;
  let priorityTail: Promise<void> = Promise.resolve();
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
        commandContextActions: createAgentSessionRuntimeCommandActions(runtimeHost, session),
        abortHandler: () => { void session.abort("Cancelled by extension"); },
        shutdownHandler: () => {
          shutdownRequested = true;
          if (session.isIdle) void shutdown();
        },
        onError(error) {
          void writer.send({
            type: "extension_error",
            extensionPath: defaultSecretRedactor.redact(error.extensionPath),
            event: error.event,
            error: defaultSecretRedactor.redact(error.error),
          }).catch(() => undefined);
        },
      });
      unsubscribeSettled = session.subscribe((event) => {
        if (event.type === "agent_settled" && shutdownRequested) void shutdown();
      });
    },
  });

  const cleanupSignals: Array<() => void> = [];
  const performShutdown = async (exitCode: number): Promise<never> => {
    lifecycle.abort(new Error("RPC mode stopped"));
    detachInput();
    input.close();
    for (const cleanup of cleanupSignals) cleanup();
    unsubscribeSettled();
    await settleBounded([
      ...handlers,
      ...(priorityPending === 0 ? [] : [priorityTail]),
    ]);
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

  const shutdown = (exitCode = 0): Promise<never> => {
    if (shutdownFlight !== undefined) return shutdownFlight;
    shuttingDown = true;
    let rejectFlight!: (error: unknown) => void;
    const flight = new Promise<never>((_resolve, reject) => { rejectFlight = reject; });
    shutdownFlight = flight;
    void performShutdown(exitCode).then(
      () => rejectFlight(new Error("RPC shutdown returned without exiting")),
      rejectFlight,
    );
    return flight;
  };

  const hasPendingInputs = (): boolean => pendingOffset < pendingInputs.length;
  const finishInput = async (): Promise<void> => {
    if (
      finishingInput
      || shuttingDown
      || !inputEnded
      || hasPendingInputs()
      || handlers.size > 0
      || priorityPending > 0
    ) return;
    finishingInput = true;
    const failure = await input.failure();
    if (failure !== undefined) {
      await writer.send(errorResponse(undefined, "parse", failure)).catch(() => undefined);
    }
    await shutdown(failure === undefined ? 0 : 1);
  };

  const handle = async (inputRecord: { record?: ParsedRpcInput; error?: unknown }): Promise<void> => {
    if (inputRecord.error !== undefined) {
      await writer.send(errorResponse(undefined, "parse", `Failed to parse command: ${message(inputRecord.error)}`));
      return;
    }
    const record = inputRecord.record!;
    if (record.type === "extension_ui_response") {
      bridge.handle(record as RpcExtensionUiResponse);
      return;
    }
    const response = await dispatcher.dispatch(record as RpcCommand);
    if (response !== undefined) {
      try {
        await writer.send(response);
      } catch (error) {
        await writer.send(errorResponse(record.id, record.type, `Failed to send response: ${message(error)}`));
      }
    }
    if (shutdownRequested && runtimeHost.session.isIdle) void shutdown();
  };

  const reportFailure = async (
    inputRecord: { record?: ParsedRpcInput; error?: unknown },
    error: unknown,
  ): Promise<void> => {
    const record = inputRecord.record;
    await writer.send(errorResponse(record?.id, record?.type ?? "parse", error)).catch(() => undefined);
  };

  const startHandler = (inputRecord: { record?: ParsedRpcInput; error?: unknown }): void => {
    const operation = handle(inputRecord)
      .catch(async (error: unknown) => await reportFailure(inputRecord, error))
      .finally(() => {
        handlers.delete(operation);
        drainPendingInputs();
      });
    handlers.add(operation);
  };

  function drainPendingInputs(): void {
    if (shuttingDown) return;
    while (handlers.size < MAX_CONCURRENT_RPC_HANDLERS && hasPendingInputs()) {
      startHandler(pendingInputs[pendingOffset++]!);
    }
    if (!hasPendingInputs()) {
      pendingInputs.length = 0;
      pendingOffset = 0;
      if (inputEnded) {
        void finishInput();
      }
    }
  }

  const startPriority = (inputRecord: { record?: ParsedRpcInput; error?: unknown }): void => {
    priorityPending += 1;
    const operation = priorityTail
      .then(async () => await handle(inputRecord))
      .catch(async (error: unknown) => await reportFailure(inputRecord, error))
      .finally(() => {
        priorityPending -= 1;
        drainPendingInputs();
      });
    priorityTail = operation;
  };

  const submit = (line: string): void => {
    if (shuttingDown || inputOverloaded || line.trim() === "") return;
    let record: ParsedRpcInput;
    try {
      record = parseRpcInput(line);
    } catch (error) {
      const backlog = pendingInputs.length - pendingOffset;
      if (backlog >= MAX_PENDING_RPC_COMMANDS) {
        inputOverloaded = true;
        input.stream.pause();
        void writer.send(errorResponse(undefined, "parse", `RPC command backlog exceeded ${MAX_PENDING_RPC_COMMANDS}`))
          .catch(() => undefined)
          .finally(() => { void shutdown(1); });
        return;
      }
      pendingInputs.push({ error });
      drainPendingInputs();
      return;
    }
    if (record.type === "extension_ui_response") {
      try { bridge.handle(record as RpcExtensionUiResponse); }
      catch (error) { startPriority({ error }); }
      return;
    }
    if (PRIORITY_RPC_COMMANDS.has(record.type)) {
      if (priorityPending >= MAX_PENDING_RPC_COMMANDS) {
        inputOverloaded = true;
        input.stream.pause();
        void writer.send(errorResponse(record.id, record.type, `RPC priority command backlog exceeded ${MAX_PENDING_RPC_COMMANDS}`))
          .catch(() => undefined)
          .finally(() => { void shutdown(1); });
        return;
      }
      startPriority({ record });
      return;
    }
    const backlog = pendingInputs.length - pendingOffset;
    if (backlog >= MAX_PENDING_RPC_COMMANDS) {
      inputOverloaded = true;
      input.stream.pause();
      void writer.send(errorResponse(record.id, record.type, `RPC command backlog exceeded ${MAX_PENDING_RPC_COMMANDS}`))
        .catch(() => undefined)
        .finally(() => { void shutdown(1); });
      return;
    }
    pendingInputs.push({ record });
    drainPendingInputs();
  };

  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  if (process.platform !== "win32") signals.push("SIGHUP");
  for (const signal of signals) {
    const handler = (): void => {
      const exitCode = signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
      if (shuttingDown) process.exit(exitCode);
      void shutdown(exitCode);
    };
    process.on(signal, handler);
    cleanupSignals.push(() => process.off(signal, handler));
  }

  try {
    await dispatcher.start();
    const onEnd = (): void => {
      inputEnded = true;
      void finishInput();
    };
    const detachLines = attachJsonlLineReader(input.stream, submit, (error) => {
      void writer
        .send(errorResponse(undefined, "parse", `Failed to read command: ${message(error)}`))
        .catch(() => undefined)
        .finally(() => { void shutdown(1); });
    });
    // Register shutdown after the decoder so a final unterminated record is
    // submitted before the handler set is snapshotted for cleanup.
    input.stream.once("end", onEnd);
    void input.failure().then((failure) => {
      if (failure === undefined || shuttingDown) return;
      inputEnded = true;
      void finishInput();
    });
    detachInput = () => {
      detachLines();
      input.stream.off("end", onEnd);
    };
  } catch (error) {
    await writer.send(errorResponse(undefined, "startup", error)).catch(() => undefined);
    await shutdown(1);
  }

  return await new Promise<never>(() => undefined);
}
