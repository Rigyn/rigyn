import { decodeLines } from "./lines.js";
import { ProtocolError } from "./transport.js";

export interface ServerSentEvent {
  data: string;
  event?: string;
  id?: string;
  retry?: number;
  raw: string[];
}

export async function* decodeSSE(
  stream: ReadableStream<Uint8Array>,
  options: { maxEventBytes?: number; maxStreamBytes?: number } = {},
): AsyncGenerator<ServerSentEvent, void, undefined> {
  const maxEventBytes = options.maxEventBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes < 1) throw new RangeError("maxEventBytes must be positive");
  const maxStreamBytes = options.maxStreamBytes;
  if (maxStreamBytes !== undefined && (!Number.isSafeInteger(maxStreamBytes) || maxStreamBytes < 1)) {
    throw new RangeError("maxStreamBytes must be positive");
  }
  let data: string[] = [];
  let event: string | undefined;
  let lastEventId: string | undefined;
  let retry: number | undefined;
  let raw: string[] = [];
  let eventBytes = 0;
  let streamBytes = 0;

  const dispatch = (): ServerSentEvent | undefined => {
    if (data.length === 0) {
      event = undefined;
      retry = undefined;
      raw = [];
      eventBytes = 0;
      return undefined;
    }
    const message: ServerSentEvent = { data: data.join("\n"), raw };
    if (event !== undefined) message.event = event;
    if (lastEventId !== undefined) message.id = lastEventId;
    if (retry !== undefined) message.retry = retry;
    data = [];
    event = undefined;
    retry = undefined;
    raw = [];
    eventBytes = 0;
    return message;
  };

  for await (const line of decodeLines(stream)) {
    streamBytes += Buffer.byteLength(line, "utf8") + 2;
    if (maxStreamBytes !== undefined && streamBytes > maxStreamBytes) {
      throw new ProtocolError(`SSE stream exceeded ${maxStreamBytes} bytes`);
    }
    if (line === "") {
      const message = dispatch();
      if (message !== undefined) yield message;
      continue;
    }

    if (line.startsWith(":")) continue;
    raw.push(line);
    eventBytes += Buffer.byteLength(line, "utf8") + 1;
    if (eventBytes > maxEventBytes) throw new ProtocolError(`SSE event exceeded ${maxEventBytes} bytes`);

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id" && !value.includes("\0")) lastEventId = value;
    else if (field === "retry" && /^\d+$/.test(value)) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed)) retry = parsed;
    }
  }

  const message = dispatch();
  if (message !== undefined) yield message;
}
