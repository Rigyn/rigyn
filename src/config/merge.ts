import type { JsonValue } from "../core/json.js";
import type { JsonObject } from "./jsonc.js";

function isObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(clone);
  if (!isObject(value)) return value;
  const result: JsonObject = {};
  for (const key of Object.keys(value).sort()) result[key] = clone(value[key]!);
  return result;
}

export function mergeConfig(base: JsonObject, overlay: JsonObject): JsonObject {
  const result: JsonObject = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(overlay)]);
  for (const key of [...keys].sort()) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new TypeError(`Unsafe configuration key: ${key}`);
    }
    const baseValue = base[key];
    const overlayValue = overlay[key];
    if (overlayValue === undefined) {
      if (baseValue !== undefined) result[key] = clone(baseValue);
    } else if (baseValue !== undefined && isObject(baseValue) && isObject(overlayValue)) {
      result[key] = mergeConfig(baseValue, overlayValue);
    } else {
      result[key] = clone(overlayValue);
    }
  }
  return result;
}

export function mergeConfigLayers(layers: readonly JsonObject[]): JsonObject {
  return layers.reduce<JsonObject>((merged, layer) => mergeConfig(merged, layer), {});
}
