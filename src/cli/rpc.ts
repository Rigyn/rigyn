import { defaultSecretRedactor } from "../auth/redaction.js";
import { RpcRuntimeDispatcher, type RpcRuntimePeer } from "../interfaces/rpc-runtime.js";
import { decodeRpcLines, RpcWriter, parseRpcRequest, type RpcId, type RpcRequest } from "../interfaces/rpc.js";
import { RPC_ERROR_CODES } from "../interfaces/rpc-protocol.js";
import { withGracefulTermination, type GracefulTerminationContext } from "../process/graceful-termination.js";
import type { ParsedArguments } from "./args.js";
import { flagBoolean, flagString, flagStrings } from "./args.js";
import { loadRuntime } from "./runtime.js";

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
  let closing = false;
  const handlers = new Set<Promise<void>>();
  const closeInput = (): void => {
    if (closing) return;
    closing = true;
    process.stdin.pause();
    process.stdin.destroy();
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
    for await (const line of decodeRpcLines(process.stdin)) {
      if (closing) break;
      if (line.trim() === "") continue;
      if (handlers.size >= 64) await Promise.race(handlers);
      const task = handle(line).catch(() => closeInput()).finally(() => handlers.delete(task));
      handlers.add(task);
    }
  } catch (error) {
    await writer.error(null, RPC_ERROR_CODES.parse, errorText(error)).catch(() => undefined);
  } finally {
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
