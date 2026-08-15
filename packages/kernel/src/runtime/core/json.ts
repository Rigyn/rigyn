import { isProxy } from "node:util/types";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type JsonValidationFrame =
  | { kind: "value"; value: unknown }
  | { kind: "exit"; value: object };

function arrayIndex(key: string, length: number): number | undefined {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key
    ? index
    : undefined;
}

export function isJsonValue(value: unknown): value is JsonValue {
  const active = new WeakSet<object>();
  const pending: JsonValidationFrame[] = [{ kind: "value", value }];
  try {
    while (pending.length > 0) {
      const frame = pending.pop();
      if (frame === undefined) break;
      if (frame.kind === "exit") {
        active.delete(frame.value);
        continue;
      }
      const current = frame.value;
      if (current === null || typeof current === "string" || typeof current === "boolean") continue;
      if (typeof current === "number") {
        if (!Number.isFinite(current)) return false;
        continue;
      }
      if (typeof current !== "object" || active.has(current)) return false;
      if (isProxy(current)) return false;
      const array = Array.isArray(current);
      const prototype = Object.getPrototypeOf(current) as object | null;
      if ((array && prototype !== Array.prototype)
        || (!array && prototype !== Object.prototype && prototype !== null)) return false;
      active.add(current);
      pending.push({ kind: "exit", value: current });

      const keys = Reflect.ownKeys(current);
      if (array) {
        const lengthDescriptor = Reflect.getOwnPropertyDescriptor(current, "length");
        if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) return false;
        const length = lengthDescriptor.value;
        if (typeof length !== "number") return false;
        let elements = 0;
        for (const key of keys) {
          if (key === "length") continue;
          if (typeof key !== "string" || arrayIndex(key, length) === undefined) return false;
          const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
          if (descriptor?.enumerable !== true || !("value" in descriptor)) return false;
          elements += 1;
          pending.push({ kind: "value", value: descriptor.value });
        }
        if (elements !== length || keys.length !== length + 1) return false;
        continue;
      }

      for (const key of keys) {
        if (typeof key !== "string") return false;
        const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
        if (descriptor?.enumerable !== true || !("value" in descriptor)) return false;
        pending.push({ kind: "value", value: descriptor.value });
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function toJsonValue(value: unknown): JsonValue {
  if (!isJsonValue(value)) throw new TypeError("Value is not JSON-serializable");
  return value;
}
