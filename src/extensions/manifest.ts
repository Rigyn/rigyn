import { isAbsolute, posix } from "node:path";
import { validRange } from "semver";

import { isBuiltinSlashCommand } from "./reserved.js";

const IDENTIFIER = /^[a-z][a-z0-9._-]{0,62}$/u;
const COMMAND_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u;

export interface ExtensionPathDeclaration {
  path: string;
}

export interface ExtensionTemplateDeclaration extends ExtensionPathDeclaration {
  id: string;
  description?: string;
}

export interface ExtensionCommandDeclaration extends ExtensionPathDeclaration {
  name: string;
  description?: string;
  argumentHint?: string;
}

export interface ExtensionThemeDeclaration extends ExtensionPathDeclaration {
  name: string;
  description?: string;
}

export type ExtensionRuntimeDeclaration = ExtensionPathDeclaration;

export interface ParsedExtensionManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version?: string;
  description?: string;
  hostVersionRange?: string;
  enabled: boolean;
  integrity: Map<string, string>;
  skillRoots: ExtensionPathDeclaration[];
  prompts: ExtensionTemplateDeclaration[];
  commands: ExtensionCommandDeclaration[];
  themes: ExtensionThemeDeclaration[];
  runtime: ExtensionRuntimeDeclaration[];
}

function parseCompatibility(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const input = object(value, "compatibility");
  allowed(input, ["hostVersion"], "compatibility");
  const hostVersion = optionalString(input.hostVersion, "compatibility.hostVersion", 256);
  if (hostVersion !== undefined && validRange(hostVersion, { loose: false }) === null) {
    throw new Error("compatibility.hostVersion must be a valid semantic-version range");
  }
  return hostVersion;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function allowed(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown keys: ${unknown.join(", ")}`);
}

function string(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || Buffer.byteLength(value) > maximum) {
    throw new Error(`${label} must be a non-empty string no larger than ${maximum} bytes`);
  }
  return value;
}

function optionalString(value: unknown, label: string, maximum: number): string | undefined {
  return value === undefined ? undefined : string(value, label, maximum);
}

function array(value: unknown, label: string, maximum: number): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} must be an array with at most ${maximum} entries`);
  return value;
}

function path(value: unknown, label: string): string {
  const selected = string(value, label, 4096);
  if (
    isAbsolute(selected) ||
    selected.includes("\\") ||
    selected === "." ||
    selected === ".." ||
    selected.startsWith("../") ||
    selected.includes("/../") ||
    posix.normalize(selected) !== selected
  ) {
    throw new Error(`${label} must be a normalized relative path`);
  }
  return selected;
}

function unique<T>(values: T[], key: (value: T) => string, label: string): T[] {
  const seen = new Set<string>();
  for (const value of values) {
    const selected = key(value);
    if (seen.has(selected)) throw new Error(`${label} contains duplicate ID: ${selected}`);
    seen.add(selected);
  }
  return values;
}

function parsePaths(value: unknown, label: string, maximum: number): ExtensionPathDeclaration[] {
  return array(value, label, maximum).map((entry, index) => {
    const input = object(entry, `${label}[${index}]`);
    allowed(input, ["path"], `${label}[${index}]`);
    return { path: path(input.path, `${label}[${index}].path`) };
  });
}

function parsePrompts(value: unknown): ExtensionTemplateDeclaration[] {
  return unique(array(value, "contributions.prompts", 64).map((entry, index) => {
    const label = `contributions.prompts[${index}]`;
    const input = object(entry, label);
    allowed(input, ["id", "path", "description"], label);
    const id = string(input.id, `${label}.id`, 63);
    if (!IDENTIFIER.test(id)) throw new Error(`${label}.id is invalid`);
    if (isBuiltinSlashCommand(id)) throw new Error(`${label}.id is reserved by a built-in command`);
    const description = optionalString(input.description, `${label}.description`, 1024);
    return { id, path: path(input.path, `${label}.path`), ...(description === undefined ? {} : { description }) };
  }), (entry) => entry.id, "contributions.prompts");
}

function parseCommands(value: unknown): ExtensionCommandDeclaration[] {
  return unique(array(value, "contributions.commands", 64).map((entry, index) => {
    const label = `contributions.commands[${index}]`;
    const input = object(entry, label);
    allowed(input, ["name", "path", "description", "argumentHint"], label);
    const name = string(input.name, `${label}.name`, 63);
    if (!COMMAND_NAME.test(name)) throw new Error(`${label}.name is invalid`);
    if (isBuiltinSlashCommand(name)) throw new Error(`${label}.name is reserved by a built-in command`);
    const description = optionalString(input.description, `${label}.description`, 1024);
    const argumentHint = optionalString(input.argumentHint, `${label}.argumentHint`, 256);
    return {
      name,
      path: path(input.path, `${label}.path`),
      ...(description === undefined ? {} : { description }),
      ...(argumentHint === undefined ? {} : { argumentHint }),
    };
  }), (entry) => entry.name, "contributions.commands");
}

function parseThemes(value: unknown): ExtensionThemeDeclaration[] {
  return unique(array(value, "contributions.themes", 32).map((entry, index) => {
    const label = `contributions.themes[${index}]`;
    const input = object(entry, label);
    allowed(input, ["name", "path", "description"], label);
    const name = string(input.name, `${label}.name`, 63);
    if (!IDENTIFIER.test(name) || name === "dark" || name === "light" || name === "mono") {
      throw new Error(`${label}.name is invalid or reserved`);
    }
    const description = optionalString(input.description, `${label}.description`, 1024);
    return { name, path: path(input.path, `${label}.path`), ...(description === undefined ? {} : { description }) };
  }), (entry) => entry.name, "contributions.themes");
}

function parseRuntime(value: unknown): ExtensionRuntimeDeclaration[] {
  return unique(parsePaths(value, "contributions.runtime", 8).map((entry, index) => {
    if (/\.d\.(?:ts|mts)$/u.test(entry.path)) {
      throw new Error(`contributions.runtime[${index}].path must not be a TypeScript declaration file`);
    }
    if (!/\.(?:ts|mts|js|mjs)$/u.test(entry.path)) {
      throw new Error(`contributions.runtime[${index}].path must end in .ts, .mts, .js, or .mjs`);
    }
    return entry;
  }), (entry) => entry.path, "contributions.runtime");
}

function parseIntegrity(value: unknown): Map<string, string> {
  if (value === undefined) return new Map();
  const input = object(value, "integrity");
  if (Object.keys(input).length > 128) throw new Error("integrity cannot contain more than 128 files");
  const result = new Map<string, string>();
  for (const [file, digest] of Object.entries(input).sort(([left], [right]) => left.localeCompare(right))) {
    path(file, "integrity path");
    if (typeof digest !== "string" || !HASH.test(digest)) throw new Error(`integrity digest is invalid for ${file}`);
    result.set(file, digest);
  }
  return result;
}

export function parseExtensionManifest(value: unknown): ParsedExtensionManifest {
  const input = object(value, "extension manifest");
  allowed(input, ["schemaVersion", "id", "name", "version", "description", "compatibility", "enabled", "integrity", "contributions"], "extension manifest");
  if (input.schemaVersion !== 1) throw new Error("extension manifest schemaVersion must be 1");
  const id = string(input.id, "extension manifest id", 63);
  if (!IDENTIFIER.test(id)) throw new Error("extension manifest id is invalid");
  const name = optionalString(input.name, "extension manifest name", 128) ?? id;
  const version = optionalString(input.version, "extension manifest version", 64);
  if (version !== undefined && !VERSION.test(version)) throw new Error("extension manifest version is invalid");
  const description = optionalString(input.description, "extension manifest description", 2048);
  const hostVersionRange = parseCompatibility(input.compatibility);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("extension manifest enabled must be a boolean");
  const contributions = object(input.contributions ?? {}, "contributions");
  allowed(contributions, ["skillRoots", "prompts", "commands", "themes", "runtime"], "contributions");
  const skillRoots = parsePaths(contributions.skillRoots, "contributions.skillRoots", 128);
  const prompts = parsePrompts(contributions.prompts);
  const commands = parseCommands(contributions.commands);
  const themes = parseThemes(contributions.themes);
  const runtime = parseRuntime(contributions.runtime);
  if (skillRoots.length + prompts.length + commands.length + themes.length + runtime.length > 256) {
    throw new Error("extension manifest contributes more than 256 entries");
  }
  return {
    schemaVersion: 1,
    id,
    name,
    ...(version === undefined ? {} : { version }),
    ...(description === undefined ? {} : { description }),
    ...(hostVersionRange === undefined ? {} : { hostVersionRange }),
    enabled: input.enabled !== false,
    integrity: parseIntegrity(input.integrity),
    skillRoots,
    prompts,
    commands,
    themes,
    runtime,
  };
}
