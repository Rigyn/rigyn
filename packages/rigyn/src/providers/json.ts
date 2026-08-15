/**
 * Provider APIs commonly reject lone UTF-16 surrogate code units even though
 * JavaScript's JSON encoder can escape them. Preserve valid pairs and remove
 * unpaired code units before an outbound JSON serialization boundary.
 */
export function sanitizeUnicode(value: string): string {
  let output = "";
  let changed = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += value.slice(index, index + 2);
        index += 1;
      } else {
        changed = true;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      changed = true;
    } else {
      output += value.charAt(index);
    }
  }
  return changed ? output : value;
}

export function stringifyProviderJson(value: unknown): string {
  const sanitized = sanitizeJsonValue(value, new WeakSet<object>());
  const serialized = JSON.stringify(sanitized);
  if (serialized === undefined) throw new TypeError("Provider request body is not JSON serializable");
  return serialized;
}

function sanitizeJsonValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof value === "string") return sanitizeUnicode(value);
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) throw new TypeError("Provider request body contains a circular value");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => sanitizeJsonValue(entry, ancestors));
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [rawKey, entry] of Object.entries(value)) {
      const key = sanitizeUnicode(rawKey);
      if (Object.hasOwn(output, key)) {
        throw new TypeError("Provider request contains property names that collide after Unicode sanitization");
      }
      output[key] = sanitizeJsonValue(entry, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}
