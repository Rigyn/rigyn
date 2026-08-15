import type { FileError } from "./filesystem.js";
import type { ExecutionError } from "./process.js";

export type Result<T, E = FileError | ExecutionError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function toError(value: unknown): Error {
  if (typeof value === "string") return new Error(value);
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean" || value === undefined || value === null) {
    return new Error(String(value));
  }
  if (typeof value === "symbol") return new Error(value.description === undefined ? "Symbol()" : `Symbol(${value.description})`);
  if (typeof value === "function") return new Error("[Thrown function]");
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "message");
    if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string") return value as Error;
  } catch {
    // Some thrown values reject reflective access.
  }
  return new Error("[Thrown object]");
}

export function getOrThrow<T, E extends Error>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw result.error;
}
