import { AsyncLocalStorage } from "node:async_hooks";
import { createWriteStream } from "node:fs";

type WriteCallback = (error?: Error | null) => void;

const stdoutWrite = process.stdout.write;
const stderrWrite = process.stderr.write;
const machineStdout = createWriteStream("", { fd: 1, autoClose: false });
const machineStderr = createWriteStream("", { fd: 2, autoClose: false });
const machineOutput = new AsyncLocalStorage<boolean>();
let installed = false;

interface StdoutTakeover {
  rawWrite: (chunk: string, callback?: WriteCallback) => boolean;
  originalWrite: typeof process.stdout.write;
}

let takeover: StdoutTakeover | undefined;
let rawWriteTail: Promise<void> = Promise.resolve();
const RETRYABLE_WRITE_CODES = new Set(["EAGAIN", "ENOBUFS", "EWOULDBLOCK"]);

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

/** Redirect incidental stdout writes to stderr while a machine-readable mode owns fd 1. */
export function takeOverStdout(): void {
  if (takeover !== undefined) return;
  const rawWrite = process.stdout.write.bind(process.stdout) as StdoutTakeover["rawWrite"];
  const stderrWrite = process.stderr.write.bind(process.stderr);
  const originalWrite = process.stdout.write;
  process.stdout.write = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean => {
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    return stderrWrite(String(chunk), done);
  }) as typeof process.stdout.write;
  takeover = { rawWrite, originalWrite };
}

export function restoreStdout(): void {
  if (takeover === undefined) return;
  process.stdout.write = takeover.originalWrite;
  takeover = undefined;
}

export function isStdoutTakenOver(): boolean {
  return takeover !== undefined;
}

function activeRawWrite(): StdoutTakeover["rawWrite"] {
  return takeover?.rawWrite ?? (process.stdout.write.bind(process.stdout) as StdoutTakeover["rawWrite"]);
}

async function writeRawChunk(chunk: string): Promise<void> {
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        try {
          activeRawWrite()(chunk, (error) => error == null ? resolve() : reject(error));
        } catch (error) {
          reject(error);
        }
      });
      return;
    } catch (error) {
      const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
      if (code === undefined || !RETRYABLE_WRITE_CODES.has(code)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
}

/** Queue an ordered write to the stdout channel reserved for structured mode output. */
export function writeRawStdout(text: string): void {
  if (text === "") return;
  rawWriteTail = rawWriteTail.then(() => writeRawChunk(text));
  void rawWriteTail.catch(() => { process.exitCode = 1; });
}

export async function waitForRawStdoutBackpressure(): Promise<void> {
  for (;;) {
    const observed = rawWriteTail;
    await observed;
    if (observed === rawWriteTail) return;
  }
}

export async function flushRawStdout(): Promise<void> {
  await waitForRawStdoutBackpressure();
}
