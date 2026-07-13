import { AsyncLocalStorage } from "node:async_hooks";

type WriteCallback = (error?: Error | null) => void;

const stdoutWrite = process.stdout.write;
const machineOutput = new AsyncLocalStorage<boolean>();
let installed = false;

function invoke(
  write: typeof process.stdout.write,
  stream: NodeJS.WriteStream,
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
      guarded ? process.stderr.write : stdoutWrite,
      guarded ? process.stderr : process.stdout,
      chunk,
      encodingOrCallback,
      callback,
    );
  }) as typeof process.stdout.write;
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
  return invoke(stdoutWrite, process.stdout, chunk, encodingOrCallback, callback);
}
