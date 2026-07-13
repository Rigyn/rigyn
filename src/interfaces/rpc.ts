import { writeMachineOutput } from "./output-guard.js";

export type RpcId = string | number | null;

export interface RpcRequest {
  jsonrpc: "2.0";
  id?: RpcId;
  method: string;
  params?: unknown;
}

export const DEFAULT_RPC_MAX_LINE_BYTES = 16 * 1024 * 1024;

export class RpcFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcFramingError";
  }
}

export async function* decodeRpcLines(
  input: AsyncIterable<string | Uint8Array>,
  maxLineBytes = DEFAULT_RPC_MAX_LINE_BYTES,
): AsyncGenerator<string, void, undefined> {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
    throw new RangeError("RPC maximum line size must be a positive safe integer");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = Buffer.alloc(0);
  const decode = (value: Buffer): string => {
    const selected = value.at(-1) === 13 ? value.subarray(0, -1) : value;
    try {
      return decoder.decode(selected);
    } catch {
      throw new RpcFramingError("RPC input contained invalid UTF-8");
    }
  };
  for await (const raw of input) {
    const chunk = typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      if (newline < 0) break;
      const segment = chunk.subarray(start, newline);
      if (pending.length + segment.length > maxLineBytes) {
        throw new RpcFramingError(`RPC request exceeds ${maxLineBytes} bytes`);
      }
      const line = pending.length === 0 ? segment : Buffer.concat([pending, segment]);
      pending = Buffer.alloc(0);
      yield decode(line);
      start = newline + 1;
    }
    if (start < chunk.length) {
      const segment = chunk.subarray(start);
      if (pending.length + segment.length > maxLineBytes) {
        throw new RpcFramingError(`RPC request exceeds ${maxLineBytes} bytes`);
      }
      pending = pending.length === 0 ? Buffer.from(segment) : Buffer.concat([pending, segment]);
    }
  }
  if (pending.length > 0) yield decode(pending);
}

export class RpcWriter {
  readonly #output: NodeJS.WritableStream;
  readonly #machineOutput: boolean;
  readonly #maxQueuedBytes: number;
  #queuedBytes = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(output: NodeJS.WritableStream = process.stdout, maxQueuedBytes = 16 * 1024 * 1024) {
    this.#output = output;
    this.#machineOutput = output === process.stdout;
    this.#maxQueuedBytes = maxQueuedBytes;
  }

  send(value: unknown): Promise<void> {
    const data = `${JSON.stringify(value)}\n`;
    const bytes = Buffer.byteLength(data);
    if (this.#queuedBytes + bytes > this.#maxQueuedBytes) return Promise.reject(new Error("RPC outbound queue exceeded its limit"));
    this.#queuedBytes += bytes;
    const operation = this.#tail.then(() => new Promise<void>((resolve, reject) => {
      const callback = (error?: Error | null): void => error === undefined || error === null ? resolve() : reject(error);
      if (this.#machineOutput) writeMachineOutput(data, callback);
      else this.#output.write(data, callback);
    })).finally(() => {
      this.#queuedBytes -= bytes;
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }

  notification(method: string, params?: unknown): Promise<void> {
    return this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  response(id: RpcId, result: unknown): Promise<void> {
    return this.send({ jsonrpc: "2.0", id, result });
  }

  error(id: RpcId, code: number, message: string, data?: unknown): Promise<void> {
    return this.send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  }
}

export function parseRpcRequest(line: string): RpcRequest {
  if (Buffer.byteLength(line) > DEFAULT_RPC_MAX_LINE_BYTES) throw new Error("RPC request exceeds 16 MiB");
  const value: unknown = JSON.parse(line);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("RPC request must be an object");
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== "2.0" || typeof record.method !== "string" || record.method.length === 0 || Buffer.byteLength(record.method) > 256) {
    throw new Error("Invalid JSON-RPC request");
  }
  if (
    record.id !== undefined &&
    record.id !== null &&
    (typeof record.id !== "string" && (typeof record.id !== "number" || !Number.isSafeInteger(record.id)))
  ) throw new Error("Invalid JSON-RPC ID");
  if (typeof record.id === "string" && Buffer.byteLength(record.id) > 1024) throw new Error("Invalid JSON-RPC ID");
  return {
    jsonrpc: "2.0",
    method: record.method,
    ...(record.id === undefined ? {} : { id: record.id as RpcId }),
    ...(record.params === undefined ? {} : { params: record.params }),
  };
}
