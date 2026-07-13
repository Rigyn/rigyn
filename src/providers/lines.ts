import { ProtocolError } from "./transport.js";

export async function* decodeLines(
  stream: ReadableStream<Uint8Array>,
  options: { maxLineBytes?: number } = {},
): AsyncGenerator<string, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const maxLineBytes = options.maxLineBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw new RangeError("maxLineBytes must be positive");
  let buffer = "";
  let finished = false;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        finished = true;
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(result.value, { stream: true });

      while (true) {
        const boundary = findLineBoundary(buffer, false);
        if (boundary === undefined) break;
        const line = buffer.slice(0, boundary.index);
        if (Buffer.byteLength(line, "utf8") > maxLineBytes) throw new ProtocolError(`Stream line exceeded ${maxLineBytes} bytes`);
        yield line;
        buffer = buffer.slice(boundary.index + boundary.length);
      }
      if (Buffer.byteLength(buffer, "utf8") > maxLineBytes) throw new ProtocolError(`Stream line exceeded ${maxLineBytes} bytes`);
    }

    while (true) {
      const boundary = findLineBoundary(buffer, true);
      if (boundary === undefined) break;
      const line = buffer.slice(0, boundary.index);
      if (Buffer.byteLength(line, "utf8") > maxLineBytes) throw new ProtocolError(`Stream line exceeded ${maxLineBytes} bytes`);
      yield line;
      buffer = buffer.slice(boundary.index + boundary.length);
    }
    if (buffer !== "") {
      if (Buffer.byteLength(buffer, "utf8") > maxLineBytes) throw new ProtocolError(`Stream line exceeded ${maxLineBytes} bytes`);
      yield buffer;
    }
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("Stream contained invalid UTF-8");
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function findLineBoundary(
  value: string,
  eof: boolean,
): { index: number; length: number } | undefined {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\n") return { index, length: 1 };
    if (character !== "\r") continue;
    if (index + 1 < value.length) {
      return { index, length: value[index + 1] === "\n" ? 2 : 1 };
    }
    if (eof) return { index, length: 1 };
    return undefined;
  }
  return undefined;
}

export function requireBody(response: Response): ReadableStream<Uint8Array> {
  if (response.body === null) throw new ProtocolError("Response did not contain a body");
  return response.body;
}
