import { spawn } from "node:child_process";

import { defaultSecretRedactor } from "../auth/redaction.js";
import { RpcRuntimeDispatcher, type RpcRuntimePeer } from "../interfaces/rpc-runtime.js";
import { decodeRpcLines, RpcWriter, parseRpcRequest, type RpcId, type RpcRequest } from "../interfaces/rpc.js";
import { RPC_ERROR_CODES } from "../interfaces/rpc-protocol.js";
import { withGracefulTermination, type GracefulTerminationContext } from "../process/graceful-termination.js";
import type { ParsedArguments } from "./args.js";
import { flagBoolean, flagString, flagStrings } from "./args.js";
import { loadRuntime } from "./runtime.js";

const RPC_STDIN_RELAY_SOURCE = String.raw`
const { createReadStream, writeFileSync } = require("node:fs");
let completed = false;
process.once("disconnect", () => {
  if (!completed) process.kill(process.pid, "SIGKILL");
});
(async () => {
  try {
    for await (const chunk of createReadStream("", { fd: 0 })) writeFileSync(1, chunk);
  } catch (error) {
    try { writeFileSync(2, error instanceof Error ? error.message : String(error)); } catch {}
    process.exitCode = 1;
  } finally {
    completed = true;
    if (process.connected) process.disconnect();
  }
})();
`;
const NODE_MAJOR = Number(process.versions.node.split(".", 1)[0]);

interface RpcInput {
  readonly stream: AsyncIterable<string | Uint8Array>;
  close(): void;
  failure(): Promise<Error | undefined>;
}

function createRpcInput(): RpcInput {
  if (NODE_MAJOR < 26) {
    return {
      stream: process.stdin,
      close() {
        process.stdin.pause();
        process.stdin.destroy();
      },
      async failure() { return undefined; },
    };
  }

  const relay = spawn(process.execPath, ["--input-type=commonjs", "--eval", RPC_STDIN_RELAY_SOURCE], {
    stdio: [0, "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  if (relay.stdout === null || relay.stderr === null) throw new Error("RPC stdin relay pipes are unavailable");
  const relayStdout = relay.stdout;
  const relayStderr = relay.stderr;
  let closing = false;
  let diagnostic = Buffer.alloc(0);
  relayStderr.on("data", (value: Buffer) => {
    if (diagnostic.length >= 4_096) return;
    const chunk = Buffer.from(value);
    diagnostic = Buffer.concat([diagnostic, chunk.subarray(0, 4_096 - diagnostic.length)]);
  });
  const settled = new Promise<Error | undefined>((resolve) => {
    let finished = false;
    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      resolve(error);
    };
    relay.once("error", (error) => finish(error));
    relay.once("close", (code, signal) => {
      if (closing || code === 0) finish();
      else {
        const detail = diagnostic.toString("utf8").trim();
        finish(new Error(
          `RPC stdin relay failed${code === null ? ` with signal ${signal ?? "unknown"}` : ` with exit ${code}`}${detail === "" ? "" : `: ${detail}`}`,
        ));
      }
    });
  });
  relayStdout.on("error", () => undefined);
  return {
    stream: relayStdout,
    close() {
      if (closing) return;
      closing = true;
      if (relay.exitCode === null && relay.signalCode === null) relay.kill("SIGKILL");
      relayStdout.destroy();
      relayStderr.destroy();
    },
    async failure() { return await settled; },
  };
}

function errorText(error: unknown): string {
  return defaultSecretRedactor.redact(error instanceof Error ? error.message : String(error));
}

function errorCode(error: unknown): number {
  return error instanceof Error && "rpcCode" in error && typeof error.rpcCode === "number"
    ? error.rpcCode
    : RPC_ERROR_CODES.invalidParams;
}

async function settleBounded(promises: readonly Promise<unknown>[], timeoutMs: number): Promise<void> {
  if (promises.length === 0) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.allSettled(promises),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function runRpcServer(argumentsValue: ParsedArguments): Promise<void> {
  await withGracefulTermination(async (termination) => await runRpcServerOperation(argumentsValue, termination));
}

async function runRpcServerOperation(
  argumentsValue: ParsedArguments,
  termination: GracefulTerminationContext,
): Promise<void> {
  const writer = new RpcWriter();
  const workspace = flagString(argumentsValue, "workspace");
  const runtime = await loadRuntime({
    ...(workspace === undefined ? {} : { workspace }),
    extensions: !flagBoolean(argumentsValue, "no-extensions"),
    extensionPaths: flagStrings(argumentsValue, "extension"),
    packagePaths: flagStrings(argumentsValue, "package"),
    allowPackageScripts: flagBoolean(argumentsValue, "allow-scripts"),
    extensionRuntime: true,
    recover: true,
  });
  let input: RpcInput;
  try {
    input = createRpcInput();
  } catch (error) {
    await runtime.close().catch(() => undefined);
    throw error;
  }
  let closing = false;
  const handlers = new Set<Promise<void>>();
  const closeInput = (): void => {
    if (closing) return;
    closing = true;
    input.close();
  };
  const peer: RpcRuntimePeer = {
    id: "stdio",
    async notification(method, params) {
      try {
        await writer.notification(method, params);
      } catch (error) {
        closeInput();
        throw error;
      }
    },
  };
  const dispatcher = new RpcRuntimeDispatcher({
    runtime,
    requestShutdown: () => closeInput(),
  });
  dispatcher.connect(peer);
  let dispatcherClose: Promise<void> | undefined;
  const closeDispatcher = (reason: string): Promise<void> => {
    dispatcher.disconnect(peer.id);
    dispatcherClose ??= dispatcher.close(reason);
    return dispatcherClose;
  };
  const uninstallTermination = termination.onTerminate((signal) => {
    closeInput();
    void closeDispatcher(`RPC interrupted by ${signal}`).catch(() => undefined);
  });

  const handle = async (line: string): Promise<void> => {
    let request: RpcRequest;
    try {
      request = parseRpcRequest(line);
    } catch (error) {
      await writer.error(null, RPC_ERROR_CODES.parse, errorText(error));
      return;
    }
    const id: RpcId | undefined = request.id;
    try {
      const result = await dispatcher.dispatch(peer, request);
      if (id !== undefined) await writer.response(id, result);
    } catch (error) {
      if (id !== undefined) await writer.error(id, errorCode(error), errorText(error));
    }
  };

  try {
    termination.throwIfTerminated();
    for await (const line of decodeRpcLines(input.stream)) {
      if (closing) break;
      if (line.trim() === "") continue;
      if (handlers.size >= 64) await Promise.race(handlers);
      const task = handle(line).catch(() => closeInput()).finally(() => handlers.delete(task));
      handlers.add(task);
    }
    const inputFailure = await input.failure();
    if (inputFailure !== undefined) throw inputFailure;
  } catch (error) {
    if (!closing) await writer.error(null, RPC_ERROR_CODES.parse, errorText(error)).catch(() => undefined);
  } finally {
    closeInput();
    try {
      await Promise.allSettled([
        closeDispatcher("RPC connection closed"),
        settleBounded([...handlers], 5_000),
      ]);
    } finally {
      try {
        await runtime.close();
      } finally {
        uninstallTermination();
      }
    }
  }
}
