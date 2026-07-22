import { parse as parsePartialJson } from "partial-json";

const escapes = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

/** Repairs only malformed JSON string contents; JSON structure is never invented. */
export function repairJson(source: string): string {
  let output = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (!quoted) {
      output += character;
      if (character === '"') quoted = true;
      continue;
    }
    if (character === '"') {
      output += character;
      quoted = false;
      continue;
    }
    if (character === "\\") {
      const next = source[index + 1];
      if (next === "u" && /^[0-9a-f]{4}$/iu.test(source.slice(index + 2, index + 6))) {
        output += source.slice(index, index + 6);
        index += 5;
      } else if (next !== undefined && escapes.has(next)) {
        output += character + next;
        index += 1;
      } else {
        output += "\\\\";
      }
      continue;
    }
    const unit = character.charCodeAt(0);
    if (unit <= 0x1f) {
      const named: Record<number, string> = { 8: "\\b", 9: "\\t", 10: "\\n", 12: "\\f", 13: "\\r" };
      output += named[unit] ?? `\\u${unit.toString(16).padStart(4, "0")}`;
    } else {
      output += character;
    }
  }
  return output;
}

export function parseJsonWithRepair<T>(source: string): T {
  try {
    return JSON.parse(source) as T;
  } catch (original) {
    const repaired = repairJson(source);
    if (repaired === source) throw original;
    return JSON.parse(repaired) as T;
  }
}

export function parseStreamingJson<T = Record<string, unknown>>(source: string | undefined): T {
  if (source === undefined || source.trim() === "") return {} as T;
  try {
    return parseJsonWithRepair<T>(source);
  } catch {
    for (const candidate of [source, repairJson(source)]) {
      try {
        return (parsePartialJson(candidate) ?? {}) as T;
      } catch {
        // Try the next bounded repair strategy.
      }
    }
    return {} as T;
  }
}
