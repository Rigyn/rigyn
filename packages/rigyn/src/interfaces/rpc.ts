import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import { writeMachineOutput } from "./output-guard.js";
import type { RpcCommand, RpcExtensionUiResponse } from "./rpc-protocol.js";

/** Serialize one strict LF-delimited JSON record. */
export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * Decode strict LF-delimited JSON records from an async byte stream.
 * U+2028 and U+2029 remain ordinary payload characters and CRLF is accepted.
 */
export async function* decodeRpcLines(
  input: AsyncIterable<string | Uint8Array>,
): AsyncGenerator<string, void, undefined> {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const emit = (line: string): string => line.endsWith("\r") ? line.slice(0, -1) : line;
  for await (const raw of input) {
    buffer += typeof raw === "string" ? raw : decoder.write(Buffer.from(raw));
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      yield emit(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  }
  buffer += decoder.end();
  if (buffer !== "") yield emit(buffer);
}

/** Attach a strict LF-only JSONL reader to a Node readable stream. */
export function attachJsonlLineReader(stream: Readable, onLine: (line: string) => void): () => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const emit = (line: string): void => onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  const onData = (chunk: string | Buffer): void => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      emit(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  };
  const onEnd = (): void => {
    buffer += decoder.end();
    if (buffer !== "") emit(buffer);
    buffer = "";
  };
  stream.on("data", onData);
  stream.on("end", onEnd);
  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
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
    const data = serializeJsonLine(value);
    const operation = this.#tail.then(() => new Promise<void>((resolve, reject) => {
      const callback = (error?: Error | null): void => error === undefined || error === null ? resolve() : reject(error);
      if (this.#machineOutput) writeMachineOutput(data, callback);
      else this.#output.write(data, callback);
    }));
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
