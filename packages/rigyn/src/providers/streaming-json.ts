import { parse as parsePartialJson } from "partial-json";

const SIMPLE_ESCAPES = new Set(["\"", "\\", "/", "b", "f", "n", "r", "t"]);

function escapedControl(character: string): string {
  switch (character) {
    case "\b": return "\\b";
    case "\f": return "\\f";
    case "\n": return "\\n";
    case "\r": return "\\r";
    case "\t": return "\\t";
    default: return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  }
}

/** Repairs malformed characters only while scanning a JSON string literal. */
export function repairJsonStrings(value: string): string {
  let result = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (!quoted) {
      result += character;
      if (character === "\"") quoted = true;
      continue;
    }
    if (character === "\"") {
      result += character;
      quoted = false;
      continue;
    }
    if (character === "\\") {
      const next = value[index + 1];
      if (next === "u" && /^[0-9A-Fa-f]{4}$/u.test(value.slice(index + 2, index + 6))) {
        result += value.slice(index, index + 6);
        index += 5;
      } else if (next !== undefined && SIMPLE_ESCAPES.has(next)) {
        result += `\\${next}`;
        index += 1;
      } else {
        result += "\\\\";
      }
      continue;
    }
    result += character.charCodeAt(0) <= 0x1f ? escapedControl(character) : character;
  }
  return result;
}

export function parseJsonWithRepair<T = unknown>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (original) {
    const repaired = repairJsonStrings(value);
    if (repaired === value) throw original;
    return JSON.parse(repaired) as T;
  }
}

/** Produces the best available value for an incomplete streamed JSON document. */
export function parseStreamingJson<T = Record<string, unknown>>(value: string | undefined): T {
  if (value === undefined || value.trim() === "") return {} as T;
  try {
    return parseJsonWithRepair<T>(value);
  } catch {
    try {
      return (parsePartialJson(value) ?? {}) as T;
    } catch {
      try {
        return (parsePartialJson(repairJsonStrings(value)) ?? {}) as T;
      } catch {
        return {} as T;
      }
    }
  }
}
