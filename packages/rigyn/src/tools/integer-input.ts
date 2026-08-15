import type { JsonValue } from "../core/json.js";
import { numberInput } from "./input.js";

export function safeIntegerInput(
  object: { [key: string]: JsonValue },
  key: string,
  fallback: number,
  minimum: number,
): number {
  const value = numberInput(object, key, fallback);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${key} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}
