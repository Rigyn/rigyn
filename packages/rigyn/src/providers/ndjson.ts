import type { JsonValue } from "../core/json.js";
import { decodeLines } from "./lines.js";
import { jsonValueOrString, ProtocolError } from "./transport.js";

export async function* decodeNDJSON(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<JsonValue, void, undefined> {
  for await (const line of decodeLines(stream)) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      const json = jsonValueOrString(value);
      if (typeof json === "string" && typeof value !== "string") {
        throw new ProtocolError("NDJSON value is not JSON-serializable", line);
      }
      yield json;
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError("Malformed NDJSON line", line);
    }
  }
}
