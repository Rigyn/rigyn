import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import { errorMessage } from "../core/errors.js";
import { writeMachineOutput } from "./output-guard.js";
import type { RpcCommand, RpcExtensionUiResponse } from "./rpc-protocol.js";

export const MAX_RPC_LINE_BYTES = 16 * 1024 * 1024;

class RpcLineDecoder {
  readonly #decoder = new StringDecoder("utf8");
  readonly #parts: string[] = [];
  #bytes = 0;
  #hasContent = false;
  #endsWithCarriageReturn = false;

  *push(raw: string | Uint8Array): Generator<string, void, undefined> {
    const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
    yield* this.#consume(this.#decoder.write(bytes));
  }

  *end(): Generator<string, void, undefined> {
    yield* this.#consume(this.#decoder.end());
    if (this.#hasContent) yield this.#takeLine();
  }

  *#consume(value: string): Generator<string, void, undefined> {
    let start = 0;
    while (true) {
      const newline = value.indexOf("\n", start);
      if (newline < 0) break;
      this.#append(value.slice(start, newline), true);
      yield this.#takeLine();
      start = newline + 1;
    }
    this.#append(value.slice(start), false);
  }

  #append(value: string, newlineFollows: boolean): void {
    if (value === "") {
      if (
        !newlineFollows
        && this.#bytes > MAX_RPC_LINE_BYTES
        && !(this.#bytes === MAX_RPC_LINE_BYTES + 1 && this.#endsWithCarriageReturn)
      ) this.#tooLarge();
      return;
    }
    const bytes = this.#bytes + Buffer.byteLength(value, "utf8");
    const endsWithCarriageReturn = value.endsWith("\r");
    const payloadBytes = bytes - (endsWithCarriageReturn ? 1 : 0);
    if (
      (newlineFollows && payloadBytes > MAX_RPC_LINE_BYTES)
      || (!newlineFollows && bytes > MAX_RPC_LINE_BYTES
        && !(bytes === MAX_RPC_LINE_BYTES + 1 && endsWithCarriageReturn))
    ) this.#tooLarge();
    this.#parts.push(value);
    this.#bytes = bytes;
    this.#hasContent = true;
    this.#endsWithCarriageReturn = endsWithCarriageReturn;
  }

  #takeLine(): string {
    const line = this.#parts.join("");
    this.#parts.length = 0;
    this.#bytes = 0;
    this.#hasContent = false;
    this.#endsWithCarriageReturn = false;
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  }

  #tooLarge(): never {
    throw new Error(`RPC line exceeded ${MAX_RPC_LINE_BYTES} bytes`);
  }
}

/** Serialize one strict LF-delimited JSON record. */
export function serializeJsonLine(value: unknown): string {
  const record = JSON.stringify(value);
  if (record === undefined) throw new Error("RPC record is not JSON serializable");
  const bytes = Buffer.byteLength(record, "utf8");
  if (bytes > MAX_RPC_LINE_BYTES) throw new Error(`RPC line exceeded ${MAX_RPC_LINE_BYTES} bytes`);
  return `${record}\n`;
}

/**
 * Decode strict LF-delimited JSON records from an async byte stream.
 * U+2028 and U+2029 remain ordinary payload characters and CRLF is accepted.
 */
export async function* decodeRpcLines(
  input: AsyncIterable<string | Uint8Array>,
): AsyncGenerator<string, void, undefined> {
  const decoder = new RpcLineDecoder();
  for await (const raw of input) {
    yield* decoder.push(raw);
  }
  yield* decoder.end();
}

/** Attach a strict LF-only JSONL reader to a Node readable stream. */
export function attachJsonlLineReader(
  stream: Readable,
  onLine: (line: string) => void,
  onError?: (error: Error) => void,
): () => void {
  const decoder = new RpcLineDecoder();
  let failed = false;
  const fail = (error: unknown): void => {
    if (failed) return;
    failed = true;
    detach();
    const isError = (Error as ErrorConstructor & { isError?: (candidate: unknown) => boolean }).isError;
    const failure = isError?.(error) === true ? error as Error : new Error(errorMessage(error));
    if (onError === undefined) stream.destroy(failure);
    else {
      onError(failure);
      stream.destroy();
    }
  };
  const onData = (chunk: string | Buffer): void => {
    try {
      for (const line of decoder.push(chunk)) onLine(line);
    } catch (error) {
      fail(error);
    }
  };
  const onEnd = (): void => {
    try {
      for (const line of decoder.end()) onLine(line);
    } catch (error) {
      fail(error);
    }
  };
  const detach = (): void => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
  stream.on("data", onData);
  stream.on("end", onEnd);
  return detach;
}

export class RpcWriter {
  readonly #output: NodeJS.WritableStream;
  readonly #machineOutput: boolean;
  #tail: Promise<void> = Promise.resolve();

  constructor(output: NodeJS.WritableStream = process.stdout) {
    this.#output = output;
    this.#machineOutput = output === process.stdout;
  }

  send(value: unknown): Promise<void> {
    const operation = this.#tail.then(() => {
      const data = serializeJsonLine(value);
      return new Promise<void>((resolve, reject) => {
        const callback = (error?: Error | null): void => error === undefined || error === null ? resolve() : reject(error);
        if (this.#machineOutput) writeMachineOutput(data, callback);
        else this.#output.write(data, callback);
      });
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }
}

export interface RpcUnknownCommand {
  id?: string;
  type: string;
  [key: string]: unknown;
}

export type ParsedRpcInput = RpcCommand | RpcExtensionUiResponse | RpcUnknownCommand;

/** Parse one command record while preserving unknown command names and their IDs. */
export function parseRpcInput(line: string): ParsedRpcInput {
  const parsed = JSON.parse(line) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("RPC command must be an object");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.type !== "string" || record.type === "") {
    throw new Error("RPC command type must be a non-empty string");
  }
  if (record.id !== undefined && typeof record.id !== "string") {
    throw new Error("RPC command ID must be a string");
  }
  return record as ParsedRpcInput;
}
