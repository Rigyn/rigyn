import { isAbsolute, posix } from "node:path";

import { validRange } from "semver";

import { isBuiltinSlashCommand } from "./reserved.js";

const IDENTIFIER = /^[a-z][a-z0-9._-]{0,62}$/u;
const COMMAND_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u;
const PERMISSIONS = [
  "advancedUi",
  "nativeUi",
  "unsafeTerminal",
  "providerOverride",
  "providerWire",
  "credentialAccess",
  "sessionRaw",
  "hostConfiguration",
] as const;

export interface LegacyExtensionManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version?: string;
  description?: string;
  hostVersionRange?: string;
  enabled: boolean;
  permissions: Record<(typeof PERMISSIONS)[number], boolean>;
  integrity: Map<string, string>;
  skillRoots: Array<{ path: string }>;
  prompts: Array<{ id: string; path: string; description?: string }>;
  commands: Array<{ name: string; path: string; description?: string; argumentHint?: string }>;
  themes: Array<{ name: string; path: string; description?: string }>;
  runtime: Array<{ path: string }>;
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
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} must contain at most ${maximum} entries`);
  return value;
}

function path(value: unknown, label: string): string {
  const selected = string(value, label, 4096);
  if (
    isAbsolute(selected)
    || /^[A-Za-z]:/u.test(selected)
    || selected.includes("\\")
    || selected === "."
    || selected === ".."
    || selected.startsWith("../")
    || selected.includes("/../")
    || posix.normalize(selected) !== selected
  ) throw new Error(`${label} must be a normalized relative path`);
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

function pathEntries(value: unknown, label: string, maximum: number): Array<{ path: string }> {
  return array(value, label, maximum).map((entry, index) => {
    const input = object(entry, `${label}[${index}]`);
    allowed(input, ["path"], `${label}[${index}]`);
    return { path: path(input.path, `${label}[${index}].path`) };
  });
}

function parsePermissions(value: unknown): Record<(typeof PERMISSIONS)[number], boolean> {
  const result = Object.fromEntries(PERMISSIONS.map((permission) => [permission, false])) as Record<(typeof PERMISSIONS)[number], boolean>;
  if (value === undefined) return result;
  const input = object(value, "permissions");
  allowed(input, PERMISSIONS, "permissions");
  for (const permission of PERMISSIONS) {
    if (input[permission] !== undefined && typeof input[permission] !== "boolean") {
      throw new Error(`permissions.${permission} must be a boolean`);
    }
    result[permission] = input[permission] === true;
  }
  return result;
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

function parsePrompts(value: unknown): LegacyExtensionManifest["prompts"] {
  return unique(array(value, "contributions.prompts", 64).map((entry, index) => {
    const label = `contributions.prompts[${index}]`;
    const input = object(entry, label);
    allowed(input, ["id", "path", "description"], label);
    const id = string(input.id, `${label}.id`, 63);
    if (!IDENTIFIER.test(id) || isBuiltinSlashCommand(id)) throw new Error(`${label}.id is invalid or reserved`);
    const description = optionalString(input.description, `${label}.description`, 1024);
    return { id, path: path(input.path, `${label}.path`), ...(description === undefined ? {} : { description }) };
  }), (entry) => entry.id, "contributions.prompts");
}

function parseCommands(value: unknown): LegacyExtensionManifest["commands"] {
  return unique(array(value, "contributions.commands", 64).map((entry, index) => {
    const label = `contributions.commands[${index}]`;
    const input = object(entry, label);
    allowed(input, ["name", "path", "description", "argumentHint"], label);
    const name = string(input.name, `${label}.name`, 63);
    if (!COMMAND_NAME.test(name) || isBuiltinSlashCommand(name)) throw new Error(`${label}.name is invalid or reserved`);
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

function parseThemes(value: unknown): LegacyExtensionManifest["themes"] {
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

export function parseLegacyExtensionManifest(value: unknown): LegacyExtensionManifest {
  const input = object(value, "extension manifest");
  allowed(input, [
    "schemaVersion", "id", "name", "version", "description", "compatibility", "enabled", "permissions", "integrity", "contributions",
  ], "extension manifest");
  if (input.schemaVersion !== 1) throw new Error("extension manifest schemaVersion must be 1");
  const id = string(input.id, "extension manifest id", 63);
  if (!IDENTIFIER.test(id)) throw new Error("extension manifest id is invalid");
  const name = optionalString(input.name, "extension manifest name", 128) ?? id;
  const version = optionalString(input.version, "extension manifest version", 64);
  if (version !== undefined && !VERSION.test(version)) throw new Error("extension manifest version is invalid");
  const description = optionalString(input.description, "extension manifest description", 2048);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("extension manifest enabled must be a boolean");

  let hostVersionRange: string | undefined;
  if (input.compatibility !== undefined) {
    const compatibility = object(input.compatibility, "compatibility");
    allowed(compatibility, ["hostVersion"], "compatibility");
    hostVersionRange = optionalString(compatibility.hostVersion, "compatibility.hostVersion", 256);
    if (hostVersionRange !== undefined && validRange(hostVersionRange, { loose: false }) === null) {
      throw new Error("compatibility.hostVersion must be a valid semantic-version range");
    }
  }

  const contributions = object(input.contributions ?? {}, "contributions");
  allowed(contributions, ["skillRoots", "prompts", "commands", "themes", "runtime"], "contributions");
  const skillRoots = pathEntries(contributions.skillRoots, "contributions.skillRoots", 128);
  const prompts = parsePrompts(contributions.prompts);
  const commands = parseCommands(contributions.commands);
  const themes = parseThemes(contributions.themes);
  const runtime = unique(pathEntries(contributions.runtime, "contributions.runtime", 8).map((entry, index) => {
    if (!/\.(?:ts|mts|js|mjs)$/u.test(entry.path) || /\.d\.(?:ts|mts)$/u.test(entry.path)) {
      throw new Error(`contributions.runtime[${index}].path has an invalid runtime suffix`);
    }
    return entry;
  }), (entry) => entry.path, "contributions.runtime");
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
    permissions: parsePermissions(input.permissions),
    integrity: parseIntegrity(input.integrity),
    skillRoots,
    prompts,
    commands,
    themes,
    runtime,
  };
}

export function legacyManifestResources(value: LegacyExtensionManifest): {
  extensions: string[];
  skills: string[];
  prompts: string[];
  themes: string[];
} {
  return {
    extensions: value.runtime.map((entry) => entry.path),
    skills: value.skillRoots.map((entry) => entry.path),
    prompts: [...new Set([...value.prompts, ...value.commands].map((entry) => entry.path))],
    themes: value.themes.map((entry) => entry.path),
  };
}
