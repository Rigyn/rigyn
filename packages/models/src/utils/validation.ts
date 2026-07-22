import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import type { Tool, ToolCall } from "../types.js";

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  allOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
}

function hasType(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === type;
}

function primitive(value: unknown, type: string): unknown {
  if (type === "number" || type === "integer") {
    if (value === null) return 0;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "string" && value.trim() !== "") {
      const number = Number(value);
      if (Number.isFinite(number) && (type !== "integer" || Number.isInteger(number))) return number;
    }
  }
  if (type === "boolean") {
    if (value === null) return false;
    if (value === "true" || value === 1) return true;
    if (value === "false" || value === 0) return false;
  }
  if (type === "string" && (value === null || typeof value === "number" || typeof value === "boolean")) return value === null ? "" : String(value);
  if (type === "null" && (value === "" || value === 0 || value === false)) return null;
  return value;
}

function check(schema: JsonSchema, value: unknown): boolean {
  try { return Value.Check(schema as TSchema, value); } catch { return false; }
}

function convert(schema: JsonSchema, value: unknown): unknown {
  let result = value;
  for (const nested of schema.allOf ?? []) result = convert(nested, result);
  for (const options of [schema.anyOf, schema.oneOf]) {
    if (!options) continue;
    for (const option of options) {
      const candidate = convert(option, structuredClone(result));
      if (check(option, candidate)) { result = candidate; break; }
    }
  }
  const types = typeof schema.type === "string" ? [schema.type] : schema.type ?? [];
  if (!types.some((type) => hasType(result, type))) {
    for (const type of types) {
      const candidate = primitive(result, type);
      if (candidate !== result) { result = candidate; break; }
    }
  }
  if (result !== null && typeof result === "object" && !Array.isArray(result) && types.includes("object")) {
    const record = result as Record<string, unknown>;
    for (const [name, property] of Object.entries(schema.properties ?? {})) if (name in record) record[name] = convert(property, record[name]);
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") for (const name of Object.keys(record)) if (!(name in (schema.properties ?? {}))) record[name] = convert(schema.additionalProperties, record[name]);
  }
  if (Array.isArray(result) && types.includes("array")) {
    if (Array.isArray(schema.items)) {
      for (const [index, item] of schema.items.entries()) if (index < result.length) result[index] = convert(item, result[index]);
    } else if (schema.items) {
      for (let index = 0; index < result.length; index += 1) result[index] = convert(schema.items, result[index]);
    }
  }
  return result;
}

function path(value: unknown): string {
  if (typeof value !== "object" || value === null) return "root";
  const record = value as Record<string, unknown>;
  const instance = typeof record.instancePath === "string" ? record.instancePath.slice(1).replaceAll("/", ".") : "";
  if (record.keyword === "required" && typeof record.params === "object" && record.params !== null) {
    const required = (record.params as { requiredProperties?: unknown }).requiredProperties;
    if (Array.isArray(required) && typeof required[0] === "string") return instance ? `${instance}.${required[0]}` : required[0];
  }
  return instance || "root";
}

export function validateToolCall(tools: Tool[], toolCall: ToolCall): unknown {
  const tool = tools.find((candidate) => candidate.name === toolCall.name);
  if (tool === undefined) throw new Error(`Tool "${toolCall.name}" not found`);
  return validateToolArguments(tool, toolCall);
}

export function validateToolArguments(tool: Tool, toolCall: ToolCall): unknown {
  const schema = tool.parameters as JsonSchema;
  let arguments_: unknown = structuredClone(toolCall.arguments);
  try { arguments_ = Value.Convert(tool.parameters, arguments_); } catch { arguments_ = convert(schema, arguments_); }
  arguments_ = convert(schema, arguments_);
  if (Value.Check(tool.parameters, arguments_)) return arguments_;
  const details = [...Value.Errors(tool.parameters, arguments_)].map((error) => `  - ${path(error)}: ${error.message}`).join("\n") || "  - root: unknown validation failure";
  throw new Error(`Validation failed for tool "${toolCall.name}":\n${details}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`);
}
