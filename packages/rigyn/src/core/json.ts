export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (["string", "number", "boolean"].includes(typeof value)) {
    return typeof value !== "number" || Number.isFinite(value);
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

export function toJsonValue(value: unknown): JsonValue {
  if (!isJsonValue(value)) throw new TypeError("Value is not JSON-serializable");
  return value;
}
