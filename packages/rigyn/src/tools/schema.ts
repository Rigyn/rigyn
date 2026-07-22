import type { TSchema } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";

import { isJsonValue, type JsonValue } from "../core/json.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

type JsonSchema = Record<string, unknown>;

interface CoercionContext {
  root: JsonSchema;
  ids: Map<string, JsonSchema>;
}

const validatorCache = new WeakMap<object, Validator>();
const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");
const MAX_COERCION_DEPTH = 256;

function schemaObject(value: unknown): value is JsonSchema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function typeBoxSchema(schema: JsonSchema): boolean {
  return Object.getOwnPropertySymbols(schema).includes(TYPEBOX_KIND);
}

function validatorFor(schema: JsonSchema): Validator {
  const cached = validatorCache.get(schema);
  if (cached !== undefined) return cached;
  const validator = Compile(schema as TSchema);
  validatorCache.set(schema, validator);
  return validator;
}

function collectSchemaIds(value: unknown, ids: Map<string, JsonSchema>, visited: Set<object>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectSchemaIds(entry, ids, visited);
    return;
  }
  if (!schemaObject(value) || visited.has(value)) return;
  visited.add(value);
  if (typeof value.$id === "string" && value.$id !== "") ids.set(value.$id, value);
  for (const entry of Object.values(value)) collectSchemaIds(entry, ids, visited);
}

function coercionContext(root: JsonSchema): CoercionContext {
  const ids = new Map<string, JsonSchema>();
  collectSchemaIds(root, ids, new Set());
  return { root, ids };
}

function decodePointerToken(value: string): string {
  return decodeURIComponent(value).replaceAll("~1", "/").replaceAll("~0", "~");
}

function followPointer(root: unknown, pointer: string): JsonSchema | undefined {
  if (pointer === "" || pointer === "#") return schemaObject(root) ? root : undefined;
  const fragment = pointer.startsWith("#") ? pointer.slice(1) : pointer;
  if (!fragment.startsWith("/")) return undefined;
  let value: unknown = root;
  try {
    for (const token of fragment.slice(1).split("/")) {
      if (!schemaObject(value) && !Array.isArray(value)) return undefined;
      value = (value as Record<string, unknown>)[decodePointerToken(token)];
    }
  } catch {
    return undefined;
  }
  return schemaObject(value) ? value : undefined;
}

function resolveReference(reference: string, context: CoercionContext): JsonSchema | undefined {
  if (reference.startsWith("#")) return followPointer(context.root, reference);
  const fragmentAt = reference.indexOf("#");
  const id = fragmentAt === -1 ? reference : reference.slice(0, fragmentAt);
  const base = context.ids.get(id);
  if (base === undefined) return undefined;
  return fragmentAt === -1 ? base : followPointer(base, reference.slice(fragmentAt));
}

function declaredTypes(schema: JsonSchema): string[] {
  if (typeof schema.type === "string") return [schema.type];
  return Array.isArray(schema.type)
    ? schema.type.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "array": return Array.isArray(value);
    case "boolean": return typeof value === "boolean";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "null": return value === null;
    case "number": return typeof value === "number";
    case "object": return schemaObject(value);
    case "string": return typeof value === "string";
    default: return false;
  }
}

function coercePrimitive(value: unknown, type: string): unknown {
  switch (type) {
    case "number": {
      if (value === null) return 0;
      if (typeof value === "boolean") return value ? 1 : 0;
      if (typeof value !== "string" || value.trim() === "") return value;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : value;
    }
    case "integer": {
      if (value === null) return 0;
      if (typeof value === "boolean") return value ? 1 : 0;
      if (typeof value !== "string" || value.trim() === "") return value;
      const parsed = Number(value);
      return Number.isInteger(parsed) ? parsed : value;
    }
    case "boolean":
      if (value === null) return false;
      if (value === "true" || value === 1) return true;
      if (value === "false" || value === 0) return false;
      return value;
    case "string":
      if (value === null) return "";
      return typeof value === "number" || typeof value === "boolean" ? String(value) : value;
    case "null":
      return value === "" || value === 0 || value === false ? null : value;
    default:
      return value;
  }
}

function schemaWithRootDefinitions(schema: JsonSchema, context: CoercionContext): JsonSchema {
  if (schema === context.root || context.root.$defs === undefined || schema.$defs !== undefined) return schema;
  return { ...schema, $defs: context.root.$defs };
}

function schemaAccepts(schema: JsonSchema, value: unknown, context: CoercionContext): boolean {
  try {
    return validatorFor(schemaWithRootDefinitions(schema, context)).Check(value);
  } catch {
    return false;
  }
}

function coerceUnion(value: unknown, schemas: unknown[], context: CoercionContext, depth: number): unknown {
  for (const schema of schemas) {
    if (!schemaObject(schema)) continue;
    const candidate = structuredClone(value);
    const coerced = coercePlainJsonSchema(candidate, schema, context, depth + 1);
    if (schemaAccepts(schema, coerced, context)) return coerced;
  }
  return value;
}

function coerceObject(value: JsonSchema, schema: JsonSchema, context: CoercionContext, depth: number): void {
  const properties = schemaObject(schema.properties) ? schema.properties : undefined;
  const known = new Set(properties === undefined ? [] : Object.keys(properties));
  if (properties !== undefined) {
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (name in value && schemaObject(propertySchema)) {
        value[name] = coercePlainJsonSchema(value[name], propertySchema, context, depth + 1);
      }
    }
  }
  if (schemaObject(schema.additionalProperties)) {
    for (const [name, entry] of Object.entries(value)) {
      if (!known.has(name)) {
        value[name] = coercePlainJsonSchema(entry, schema.additionalProperties, context, depth + 1);
      }
    }
  }
}

function coerceArray(value: unknown[], schema: JsonSchema, context: CoercionContext, depth: number): void {
  if (Array.isArray(schema.items)) {
    const count = Math.min(value.length, schema.items.length);
    for (let index = 0; index < count; index += 1) {
      const itemSchema = schema.items[index];
      if (schemaObject(itemSchema)) {
        value[index] = coercePlainJsonSchema(value[index], itemSchema, context, depth + 1);
      }
    }
    return;
  }
  if (schemaObject(schema.items)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = coercePlainJsonSchema(value[index], schema.items, context, depth + 1);
    }
  }
}

function coercePlainJsonSchema(
  value: unknown,
  schema: JsonSchema,
  context: CoercionContext,
  depth = 0,
): unknown {
  if (depth > MAX_COERCION_DEPTH) return value;
  let result = value;

  if (typeof schema.$ref === "string") {
    const referenced = resolveReference(schema.$ref, context);
    if (referenced !== undefined && referenced !== schema) {
      result = coercePlainJsonSchema(result, referenced, context, depth + 1);
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const entry of schema.allOf) {
      if (schemaObject(entry)) result = coercePlainJsonSchema(result, entry, context, depth + 1);
    }
  }
  if (Array.isArray(schema.anyOf)) result = coerceUnion(result, schema.anyOf, context, depth);
  if (Array.isArray(schema.oneOf)) result = coerceUnion(result, schema.oneOf, context, depth);

  const types = declaredTypes(schema);
  const alreadyMatchesUnion = types.length > 1 && types.some((type) => matchesType(result, type));
  if (types.length > 0 && !alreadyMatchesUnion) {
    for (const type of types) {
      const candidate = coercePrimitive(result, type);
      if (candidate !== result) {
        result = candidate;
        break;
      }
    }
  }

  if (types.includes("object") && schemaObject(result)) coerceObject(result, schema, context, depth);
  if (types.includes("array") && Array.isArray(result)) coerceArray(result, schema, context, depth);
  return result;
}

function formatPath(error: TLocalizedValidationError): string {
  if (error.keyword === "required") {
    const properties = (error.params as { requiredProperties?: unknown }).requiredProperties;
    if (Array.isArray(properties) && typeof properties[0] === "string") {
      return `${pointerPath(error.instancePath)}.${properties[0]}`.replace(/^\$\./u, "$.");
    }
  }
  return pointerPath(error.instancePath);
}

function pointerPath(pointer: string): string {
  if (pointer === "") return "$";
  try {
    const parts = pointer.replace(/^\//u, "").split("/").map(decodePointerToken);
    return `$${parts.map((part) => /^\d+$/u.test(part) ? `[${part}]` : `.${part}`).join("")}`;
  } catch {
    return "$";
  }
}

function issuesFor(validator: Validator, value: unknown): ValidationIssue[] {
  return validator.Errors(value).map((error) => ({ path: formatPath(error), message: error.message }));
}

/** Ensures a schema can be consumed by the TypeBox compiler. */
export function assertSupportedSchema(schema: Record<string, JsonValue>): void {
  try {
    validatorFor(schema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid tool schema: ${message}`);
  }
}

/**
 * Returns a detached, coerced input using TypeBox conversion rules followed by
 * JSON-Schema coercion for schemas that crossed a serialization boundary.
 */
export function coerceSchemaValue(schema: Record<string, JsonValue>, value: JsonValue): JsonValue {
  const input = structuredClone(value);
  let coerced: unknown = Value.Convert(schema as TSchema, input);
  if (!typeBoxSchema(schema)) {
    coerced = coercePlainJsonSchema(coerced, schema, coercionContext(schema));
  }
  if (!isJsonValue(coerced)) throw new Error("Tool schema conversion produced a non-JSON value");
  return coerced;
}

export function validateSchema(schema: Record<string, JsonValue>, value: JsonValue): ValidationIssue[] {
  const validator = validatorFor(schema);
  const coerced = coerceSchemaValue(schema, value);
  return validator.Check(coerced) ? [] : issuesFor(validator, coerced);
}

/** Returns the detached, coerced input or throws with all schema errors. */
export function assertSchema(schema: Record<string, JsonValue>, value: JsonValue): JsonValue {
  const validator = validatorFor(schema);
  const coerced = coerceSchemaValue(schema, value);
  if (validator.Check(coerced)) return coerced;
  const issues = issuesFor(validator, coerced);
  throw new Error(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ") || "Tool input is invalid");
}
