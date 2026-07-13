import { HarnessError } from "../core/errors.js";
import { isJsonValue, type JsonValue } from "../core/json.js";

export type JsonObject = { [key: string]: JsonValue };

function positionOf(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function parseError(sourceName: string, source: string, offset: number, detail: string): HarnessError {
  const location = positionOf(source, offset);
  return new HarnessError(
    "CONFIG_PARSE",
    `${sourceName}:${location.line}:${location.column}: ${detail}`,
  );
}

function stripComments(source: string, sourceName: string): string {
  const output = [...source];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < output.length; index += 1) {
    const current = output[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      continue;
    }
    if (current !== "/") continue;
    const next = output[index + 1];
    if (next === "/") {
      output[index] = " ";
      output[index + 1] = " ";
      index += 2;
      while (index < output.length && output[index] !== "\n" && output[index] !== "\r") {
        output[index] = " ";
        index += 1;
      }
      index -= 1;
      continue;
    }
    if (next === "*") {
      const start = index;
      output[index] = " ";
      output[index + 1] = " ";
      index += 2;
      let closed = false;
      while (index < output.length) {
        if (output[index] === "*" && output[index + 1] === "/") {
          output[index] = " ";
          output[index + 1] = " ";
          index += 1;
          closed = true;
          break;
        }
        if (output[index] !== "\n" && output[index] !== "\r") output[index] = " ";
        index += 1;
      }
      if (!closed) throw parseError(sourceName, source, start, "Unterminated block comment");
    }
  }
  return output.join("");
}

function stripTrailingCommas(source: string): string {
  const output = [...source];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < output.length; index += 1) {
    const current = output[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      continue;
    }
    if (current !== ",") continue;
    let lookahead = index + 1;
    while (lookahead < output.length && /\s/.test(output[lookahead]!)) lookahead += 1;
    if (output[lookahead] === "}" || output[lookahead] === "]") output[index] = " ";
  }
  return output.join("");
}

function assertSafeKeys(value: JsonValue, sourceName: string, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeKeys(item, sourceName, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new HarnessError("CONFIG_KEY", `${sourceName}: unsafe key at ${path}.${key}`);
    }
    assertSafeKeys(child, sourceName, `${path}.${key}`);
  }
}

export function parseJsonc(source: string, sourceName = "<config>"): JsonValue {
  const normalized = stripTrailingCommas(stripComments(source, sourceName));
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const offsetMatch = /position\s+(\d+)/i.exec(message);
    const offset = offsetMatch?.[1] === undefined ? 0 : Number.parseInt(offsetMatch[1], 10);
    throw parseError(sourceName, source, offset, message);
  }
  if (!isJsonValue(parsed)) {
    throw new HarnessError("CONFIG_PARSE", `${sourceName}: configuration is not valid JSON data`);
  }
  assertSafeKeys(parsed, sourceName);
  return parsed;
}

export function parseJsoncObject(source: string, sourceName = "<config>"): JsonObject {
  const parsed = parseJsonc(source, sourceName);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HarnessError("CONFIG_ROOT", `${sourceName}: configuration root must be an object`);
  }
  return parsed;
}
