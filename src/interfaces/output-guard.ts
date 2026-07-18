import { AsyncLocalStorage } from "node:async_hooks";
import { createWriteStream } from "node:fs";

type WriteCallback = (error?: Error | null) => void;

const stdoutWrite = process.stdout.write;
const stderrWrite = process.stderr.write;
const machineStdout = createWriteStream("", { fd: 1, autoClose: false });
const machineStderr = createWriteStream("", { fd: 2, autoClose: false });
const machineOutput = new AsyncLocalStorage<boolean>();
let installed = false;

for (const stream of [machineStdout, machineStderr]) stream.on("error", () => undefined);

function invoke(
  write: typeof process.stdout.write,
  stream: object,
  chunk: Uint8Array | string,
  encodingOrCallback?: BufferEncoding | WriteCallback,
  callback?: WriteCallback,
): boolean {
  const argumentsValue = callback === undefined
    ? encodingOrCallback === undefined ? [chunk] : [chunk, encodingOrCallback]
    : [chunk, encodingOrCallback, callback];
  return Reflect.apply(write, stream, argumentsValue) as boolean;
}

function installMachineOutputGuard(): void {
  if (installed) return;
  installed = true;
  process.stdout.write = ((
    chunk: Uint8Array | string,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ) => {
    const guarded = machineOutput.getStore() === true;
    return invoke(
      guarded ? machineStderr.write : stdoutWrite,
      guarded ? machineStderr : process.stdout,
      chunk,
      encodingOrCallback,
      callback,
    );
  }) as typeof process.stdout.write;
  process.stderr.write = ((
    chunk: Uint8Array | string,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ) => machineOutput.getStore() === true
    ? invoke(machineStderr.write, machineStderr, chunk, encodingOrCallback, callback)
    : invoke(stderrWrite, process.stderr, chunk, encodingOrCallback, callback)) as typeof process.stderr.write;
}

export function withMachineOutputGuard<T>(operation: () => T): T {
  installMachineOutputGuard();
  return machineOutput.run(true, operation);
}

export function writeMachineOutput(
  chunk: Uint8Array | string,
  callback?: WriteCallback,
): boolean;
export function writeMachineOutput(
  chunk: Uint8Array | string,
  encoding: BufferEncoding,
  callback?: WriteCallback,
): boolean;
export function writeMachineOutput(
  chunk: Uint8Array | string,
  encodingOrCallback?: BufferEncoding | WriteCallback,
  callback?: WriteCallback,
): boolean {
  return invoke(machineStdout.write, machineStdout, chunk, encodingOrCallback, callback);
}
