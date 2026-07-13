import type { JsonValue } from "../core/json.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

const SUPPORTED_SCHEMA_KEYS = new Set([
  "$schema",
  "$id",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "type",
  "const",
  "enum",
  "anyOf",
  "oneOf",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "items",
  "required",
  "properties",
  "additionalProperties",
]);
const JSON_TYPES = new Set(["null", "boolean", "object", "array", "number", "string", "integer"]);

function schemaRecord(value: JsonValue | undefined, path: string): { [key: string]: JsonValue } {
  if (!object(value ?? null)) throw new Error(`${path}: schema must be an object`);
  return value as { [key: string]: JsonValue };
}

function nonnegativeInteger(value: JsonValue | undefined, path: string): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${path}: value must be a non-negative integer`);
  }
}

function checkSupportedSchema(
  schema: { [key: string]: JsonValue },
  path: string,
  state: { nodes: number },
  depth: number,
): void {
  if (depth > 64) throw new Error(`${path}: schema nesting exceeds 64 levels`);
  state.nodes += 1;
  if (state.nodes > 10_000) throw new Error("Tool schema exceeds 10,000 schema nodes");
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) throw new Error(`${path}: unsupported schema keyword ${JSON.stringify(key)}`);
  }

  const declared = schema.type;
  const types = typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared : declared === undefined ? [] : [declared];
  if (types.some((entry) => typeof entry !== "string" || !JSON_TYPES.has(entry)) || new Set(types).size !== types.length) {
    throw new Error(`${path}.type: invalid or duplicate JSON type`);
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length > 10_000)) {
    throw new Error(`${path}.enum: value must be an array of at most 10,000 values`);
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (branches === undefined) continue;
    if (!Array.isArray(branches) || branches.length === 0 || branches.length > 256) {
      throw new Error(`${path}.${keyword}: value must contain from 1 to 256 schemas`);
    }
    branches.forEach((branch, index) => checkSupportedSchema(
      schemaRecord(branch, `${path}.${keyword}[${index}]`),
      `${path}.${keyword}[${index}]`,
      state,
      depth + 1,
    ));
  }

  nonnegativeInteger(schema.minLength, `${path}.minLength`);
  nonnegativeInteger(schema.maxLength, `${path}.maxLength`);
  nonnegativeInteger(schema.minItems, `${path}.minItems`);
  nonnegativeInteger(schema.maxItems, `${path}.maxItems`);
  if (typeof schema.minLength === "number" && typeof schema.maxLength === "number" && schema.minLength > schema.maxLength) {
    throw new Error(`${path}: minLength exceeds maxLength`);
  }
  if (typeof schema.minItems === "number" && typeof schema.maxItems === "number" && schema.minItems > schema.maxItems) {
    throw new Error(`${path}: minItems exceeds maxItems`);
  }
  for (const keyword of ["minimum", "maximum"] as const) {
    const value = schema[keyword];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(`${path}.${keyword}: value must be a finite number`);
    }
  }
  if (typeof schema.minimum === "number" && typeof schema.maximum === "number" && schema.minimum > schema.maximum) {
    throw new Error(`${path}: minimum exceeds maximum`);
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string" || Buffer.byteLength(schema.pattern) > 4_096) {
      throw new Error(`${path}.pattern: value must be a string of at most 4096 bytes`);
    }
    try {
      new RegExp(schema.pattern, "u");
    } catch {
      throw new Error(`${path}.pattern: value is not a valid regular expression`);
    }
  }

  if (schema.items !== undefined) {
    checkSupportedSchema(schemaRecord(schema.items, `${path}.items`), `${path}.items`, state, depth + 1);
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((entry) => typeof entry !== "string") ||
      new Set(schema.required).size !== schema.required.length) {
      throw new Error(`${path}.required: value must be an array of unique strings`);
    }
  }
  if (schema.properties !== undefined) {
    const properties = schemaRecord(schema.properties, `${path}.properties`);
    if (Object.keys(properties).length > 10_000) throw new Error(`${path}.properties: too many properties`);
    for (const [name, child] of Object.entries(properties)) {
      checkSupportedSchema(schemaRecord(child, `${path}.properties.${name}`), `${path}.properties.${name}`, state, depth + 1);
    }
  }
  if (schema.additionalProperties !== undefined) {
    if (typeof schema.additionalProperties !== "boolean") {
      checkSupportedSchema(
        schemaRecord(schema.additionalProperties, `${path}.additionalProperties`),
        `${path}.additionalProperties`,
        state,
        depth + 1,
      );
    }
  }
}

export function assertSupportedSchema(schema: Record<string, JsonValue>): void {
  checkSupportedSchema(schema, "$", { nodes: 0 }, 0);
}

function object(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function typeMatches(type: string, value: JsonValue): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return object(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    default:
      return typeof value === type;
  }
}

function deepEqual(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateInto(
  schema: { [key: string]: JsonValue },
  value: JsonValue,
  path: string,
  issues: ValidationIssue[],
  depth: number,
): void {
  if (depth > 64) {
    issues.push({ path, message: "Schema nesting exceeds 64 levels" });
    return;
  }
  if ("const" in schema && !deepEqual(schema.const ?? null, value)) {
    issues.push({ path, message: "Value does not equal the required constant" });
  }
  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && !enumValues.some((entry) => deepEqual(entry, value))) {
    issues.push({ path, message: "Value is not in the allowed enum" });
  }
  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf)) {
    const matches = anyOf.filter((entry) => {
      if (!object(entry)) return false;
      const nested: ValidationIssue[] = [];
      validateInto(entry, value, path, nested, depth + 1);
      return nested.length === 0;
    });
    if (matches.length === 0) issues.push({ path, message: "Value does not match any allowed schema" });
  }
  const oneOf = schema.oneOf;
  if (Array.isArray(oneOf)) {
    const count = oneOf.filter((entry) => {
      if (!object(entry)) return false;
      const nested: ValidationIssue[] = [];
      validateInto(entry, value, path, nested, depth + 1);
      return nested.length === 0;
    }).length;
    if (count !== 1) issues.push({ path, message: `Value matches ${count} schemas; exactly one is required` });
  }

  const declared = schema.type;
  const types = typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared : [];
  if (types.length > 0 && !types.some((entry) => typeof entry === "string" && typeMatches(entry, value))) {
    issues.push({ path, message: `Expected ${types.join(" or ")}` });
    return;
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      issues.push({ path, message: `String is shorter than ${schema.minLength}` });
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      issues.push({ path, message: `String is longer than ${schema.maxLength}` });
    }
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern, "u").test(value)) issues.push({ path, message: "String does not match pattern" });
      } catch {
        issues.push({ path, message: "Tool schema contains an invalid pattern" });
      }
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) issues.push({ path, message: "Number is too small" });
    if (typeof schema.maximum === "number" && value > schema.maximum) issues.push({ path, message: "Number is too large" });
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) issues.push({ path, message: "Array is too short" });
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) issues.push({ path, message: "Array is too long" });
    if (object(schema.items ?? null)) {
      value.forEach((entry, index) => validateInto(schema.items as { [key: string]: JsonValue }, entry, `${path}[${index}]`, issues, depth + 1));
    }
  }

  if (object(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === "string" && !(key in value)) issues.push({ path: `${path}.${key}`, message: "Required property is missing" });
    }
    const rawProperties = schema.properties;
    const properties: { [key: string]: JsonValue } = object(rawProperties ?? null)
      ? rawProperties as { [key: string]: JsonValue }
      : {};
    for (const [key, entry] of Object.entries(value)) {
      const childSchema = properties[key];
      if (object(childSchema ?? null)) {
        validateInto(childSchema as { [key: string]: JsonValue }, entry, `${path}.${key}`, issues, depth + 1);
      } else if (schema.additionalProperties === false) {
        issues.push({ path: `${path}.${key}`, message: "Additional property is not allowed" });
      } else if (object(schema.additionalProperties ?? null)) {
        validateInto(schema.additionalProperties as { [key: string]: JsonValue }, entry, `${path}.${key}`, issues, depth + 1);
      }
    }
  }
}

export function validateSchema(schema: Record<string, JsonValue>, value: JsonValue): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateInto(schema, value, "$", issues, 0);
  return issues;
}

export function assertSchema(schema: Record<string, JsonValue>, value: JsonValue): void {
  const issues = validateSchema(schema, value);
  if (issues.length > 0) {
    throw new Error(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  }
}
