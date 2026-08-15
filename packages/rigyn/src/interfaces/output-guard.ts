type Write = NodeJS.WriteStream["write"];
let depth = 0;
let protocolWrite: Write | undefined;
let interceptedWrite: Write | undefined;

function diagnosticWrite(chunk: unknown, encoding?: unknown, callback?: unknown): boolean {
  const complete = typeof encoding === "function" ? encoding : typeof callback === "function" ? callback : undefined;
  const selectedEncoding = typeof encoding === "string" ? encoding as BufferEncoding : undefined;
  const result = process.stderr.write(chunk as Uint8Array, selectedEncoding, complete as (() => void) | undefined);
  return result;
}

export function takeOverStdout(): void {
  depth += 1;
  if (depth !== 1) return;
  protocolWrite = process.stdout.write.bind(process.stdout) as Write;
  interceptedWrite = diagnosticWrite as Write;
  process.stdout.write = interceptedWrite;
}

export function restoreStdout(): void {
  if (depth === 0) return;
  depth -= 1;
  if (depth !== 0) return;
  if (protocolWrite !== undefined) process.stdout.write = protocolWrite;
  protocolWrite = undefined;
  interceptedWrite = undefined;
}

export function writeMachineOutput(
  chunk: string | Uint8Array,
  callback?: (error?: Error | null) => void,
): boolean {
  const write = protocolWrite ?? process.stdout.write.bind(process.stdout);
  return write(chunk, callback as ((error?: Error | null) => void) | undefined);
}

export async function flushRawStdout(): Promise<void> {
  const write = protocolWrite ?? process.stdout.write.bind(process.stdout);
  await new Promise<void>((resolve, reject) => {
    write("", (error?: Error | null) => { if (error === undefined || error === null) resolve(); else reject(error); });
  });
}
