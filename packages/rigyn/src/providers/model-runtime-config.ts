import { open } from "node:fs/promises";

import type { Api, Model } from "@rigyn/models";

import { errorMessage } from "../core/errors.js";

const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const MAX_PROVIDERS = 256;
const MAX_MODELS = 4_096;

type JsonObject = Record<string, unknown>;

function errorCode(error: unknown): string | undefined {
  const isError = (Error as ErrorConstructor & { isError?: (candidate: unknown) => boolean }).isError;
  if (isError?.(error) !== true) return undefined;
  const code = Object.getOwnPropertyDescriptor(error, "code");
  return code !== undefined && "value" in code && typeof code.value === "string"
    ? code.value
    : undefined;
}

async function readConfigurationFile(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("model configuration is not a regular file");
    if (before.size > MAX_CONFIG_BYTES) throw new Error("model configuration exceeds 8 MiB");

    const chunks: Buffer[] = [];
    let bytes = 0;
    while (bytes <= MAX_CONFIG_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_CONFIG_BYTES + 1 - bytes));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      bytes += bytesRead;
    }
    if (bytes > MAX_CONFIG_BYTES) throw new Error("model configuration exceeds 8 MiB");

    const after = await handle.stat();
    if (
      after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("model configuration changed while being read");
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  } finally {
    await handle.close();
  }
}

export interface RuntimeModelDefinition {
  id: string;
  name?: string;
  api?: Api;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  input?: Array<"text" | "image">;
  cost?: Model<Api>["cost"];
  contextWindow?: number;
  maxInputTokens?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: Model<Api>["compat"];
}

export interface RuntimeProviderDefinition {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: Api;
  headers?: Record<string, string>;
  authHeader?: boolean;
  compat?: Model<Api>["compat"];
  models?: RuntimeModelDefinition[];
}

export interface RuntimeModelConfiguration {
  providers: ReadonlyMap<string, RuntimeProviderDefinition>;
  error?: string;
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as JsonObject;
}

function text(value: unknown, label: string, optional = true): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0") || Buffer.byteLength(value, "utf8") > 64 * 1024) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function positive(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive number`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function headers(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const selected = object(value, label);
  if (Object.keys(selected).length > 256) throw new TypeError(`${label} has too many entries`);
  const result: Record<string, string> = {};
  for (const [name, entry] of Object.entries(selected)) {
    const header = text(entry, `${label}.${name}`, false);
    if (header !== undefined) result[name] = header;
  }
  return result;
}

function thinkingLevelMap(value: unknown, label: string): Model<Api>["thinkingLevelMap"] {
  if (value === undefined) return undefined;
  const selected = object(value, label);
  const allowed = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  const result: Record<string, string | null> = {};
  for (const [level, mapping] of Object.entries(selected)) {
    if (!allowed.has(level) || (mapping !== null && typeof mapping !== "string")) {
      throw new TypeError(`${label}.${level} is invalid`);
    }
    if (mapping?.toLocaleLowerCase("en-US") === "ultra") {
      throw new TypeError(`${label}.${level} maps to an unsupported reasoning effort`);
    }
    result[level] = mapping;
  }
  return result;
}

function cost(value: unknown, label: string): Model<Api>["cost"] | undefined {
  if (value === undefined) return undefined;
  const selected = object(value, label);
  const rate = (name: string): number => {
    const entry = selected[name];
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0) {
      throw new TypeError(`${label}.${name} must be a non-negative number`);
    }
    return entry;
  };
  return {
    input: rate("input"),
    output: rate("output"),
    cacheRead: rate("cacheRead"),
    cacheWrite: rate("cacheWrite"),
  };
}

function compatibility(value: unknown, label: string): Model<Api>["compat"] {
  if (value === undefined) return undefined;
  return structuredClone(object(value, label)) as Model<Api>["compat"];
}

function model(value: unknown, label: string): RuntimeModelDefinition {
  const selected = object(value, label);
  const id = text(selected.id, `${label}.id`, false)!;
  const input = selected.input === undefined
    ? undefined
    : (() => {
        if (!Array.isArray(selected.input) || selected.input.some((entry) => entry !== "text" && entry !== "image")) {
          throw new TypeError(`${label}.input must contain only text or image`);
        }
        return [...selected.input] as Array<"text" | "image">;
      })();
  if (selected.reasoning !== undefined && typeof selected.reasoning !== "boolean") {
    throw new TypeError(`${label}.reasoning must be a boolean`);
  }
  return {
    id,
    ...(() => { const value = text(selected.name, `${label}.name`); return value === undefined ? {} : { name: value }; })(),
    ...(() => { const value = text(selected.api, `${label}.api`); return value === undefined ? {} : { api: value }; })(),
    ...(() => { const value = text(selected.baseUrl, `${label}.baseUrl`); return value === undefined ? {} : { baseUrl: value }; })(),
    ...(selected.reasoning === undefined ? {} : { reasoning: selected.reasoning }),
    ...(() => { const value = thinkingLevelMap(selected.thinkingLevelMap, `${label}.thinkingLevelMap`); return value === undefined ? {} : { thinkingLevelMap: value }; })(),
    ...(input === undefined ? {} : { input }),
    ...(() => { const value = cost(selected.cost, `${label}.cost`); return value === undefined ? {} : { cost: value }; })(),
    ...(() => { const value = positive(selected.contextWindow, `${label}.contextWindow`); return value === undefined ? {} : { contextWindow: value }; })(),
    ...(() => { const value = positiveInteger(selected.maxInputTokens, `${label}.maxInputTokens`); return value === undefined ? {} : { maxInputTokens: value }; })(),
    ...(() => { const value = positive(selected.maxTokens, `${label}.maxTokens`); return value === undefined ? {} : { maxTokens: value }; })(),
    ...(() => { const value = headers(selected.headers, `${label}.headers`); return value === undefined ? {} : { headers: value }; })(),
    ...(() => { const value = compatibility(selected.compat, `${label}.compat`); return value === undefined ? {} : { compat: value }; })(),
  };
}

function provider(value: unknown, label: string): RuntimeProviderDefinition {
  const selected = object(value, label);
  if (selected.authHeader !== undefined && typeof selected.authHeader !== "boolean") {
    throw new TypeError(`${label}.authHeader must be a boolean`);
  }
  let models: RuntimeModelDefinition[] | undefined;
  if (selected.models !== undefined) {
    if (!Array.isArray(selected.models) || selected.models.length > MAX_MODELS) {
      throw new TypeError(`${label}.models must be a bounded array`);
    }
    models = selected.models.map((entry, index) => model(entry, `${label}.models[${index}]`));
  }
  return {
    ...(() => { const value = text(selected.name, `${label}.name`); return value === undefined ? {} : { name: value }; })(),
    ...(() => { const value = text(selected.baseUrl, `${label}.baseUrl`); return value === undefined ? {} : { baseUrl: value }; })(),
    ...(() => { const value = text(selected.apiKey, `${label}.apiKey`); return value === undefined ? {} : { apiKey: value }; })(),
    ...(() => { const value = text(selected.api, `${label}.api`); return value === undefined ? {} : { api: value }; })(),
    ...(() => { const value = headers(selected.headers, `${label}.headers`); return value === undefined ? {} : { headers: value }; })(),
    ...(selected.authHeader === undefined ? {} : { authHeader: selected.authHeader }),
    ...(() => { const value = compatibility(selected.compat, `${label}.compat`); return value === undefined ? {} : { compat: value }; })(),
    ...(models === undefined ? {} : { models }),
  };
}

function stripComments(input: string): string {
  let result = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index]!;
    const next = input[index + 1];
    if (quoted) {
      result += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') quoted = false;
      continue;
    }
    if (current === '"') {
      quoted = true;
      result += current;
      continue;
    }
    if (current === "/" && next === "/") {
      while (index < input.length && input[index] !== "\n") index += 1;
      result += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    result += current;
  }
  return result;
}

export async function loadRuntimeModelConfiguration(path: string | undefined): Promise<RuntimeModelConfiguration> {
  if (path === undefined) return { providers: new Map() };
  try {
    const content = await readConfigurationFile(path);
    const root = object(JSON.parse(stripComments(content)), "Model configuration");
    const entries = Object.entries(object(root.providers, "Model configuration.providers"));
    if (entries.length > MAX_PROVIDERS) throw new Error("model configuration has too many providers");
    const providers = new Map<string, RuntimeProviderDefinition>();
    for (const [id, value] of entries) {
      text(id, "Provider id", false);
      if (id === "__proto__" || id === "prototype" || id === "constructor") throw new TypeError("Provider id is invalid");
      providers.set(id, provider(value, `Provider ${id}`));
    }
    return { providers };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { providers: new Map() };
    return {
      providers: new Map(),
      error: `Failed to load model configuration: ${errorMessage(error)}\n\nFile: ${path}`,
    };
  }
}
