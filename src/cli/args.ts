const BOOLEAN_FLAGS = new Set([
  "help", "version", "json", "print", "yes", "all", "no-browser", "reindex",
  "continue", "resume", "all-tools", "no-tools", "no-builtin-tools", "no-session", "local",
  "no-extensions", "no-context-files",
  "approve", "no-approve", "allow-scripts", "offline", "verbose", "no-skills", "no-prompt-templates", "no-themes",
]);

const OPTIONAL_STRING_FLAGS = new Set(["list-models"]);

const KNOWN_FLAGS = new Set([
  ...BOOLEAN_FLAGS,
  "branch", "exclude-tools", "fork", "model", "models", "name", "provider", "scope",
  "session", "thinking", "thread", "tools", "outbound-images",
  "workspace", "system-prompt", "append-system-prompt", "extension", "package",
  "api-key", "session-id", "session-dir", "skill", "prompt-template", "theme",
  "mode", "export", "list-models",
]);

const COMMANDS = new Set([
  "config", "diagnostics", "extensions", "packages", "sessions", "install", "remove", "uninstall", "update", "list", "rpc", "help",
  "self-install", "self-update", "self-uninstall",
]);

const SHORT_FLAGS: Record<string, string> = {
  h: "help",
  v: "version",
  p: "print",
  m: "model",
  t: "tools",
  y: "yes",
  c: "continue",
  r: "resume",
  l: "local",
  n: "name",
  a: "approve",
  na: "no-approve",
  e: "extension",
  nt: "no-tools",
  nbt: "no-builtin-tools",
  ne: "no-extensions",
  ns: "no-skills",
  np: "no-prompt-templates",
  nc: "no-context-files",
  xt: "exclude-tools",
};

export interface ParsedArguments {
  command: string;
  positionals: string[];
  flags: Map<string, string | boolean | string[]>;
  source: string[];
  deferredFlags: string[];
}

export interface AdditionalCliFlag {
  name: string;
  type: "boolean" | "string";
}

export interface ParseArgumentOptions {
  additionalFlags?: readonly AdditionalCliFlag[];
  deferUnknown?: boolean;
}

function explicitCommand(argv: readonly string[]): string | undefined {
  let literal = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (literal) continue;
    if (argument === "--") {
      literal = true;
      continue;
    }
    if (argument.startsWith("--")) {
      const equals = argument.indexOf("=");
      const name = argument.slice(2, equals < 0 ? undefined : equals);
      if (equals < 0 && KNOWN_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name) && !OPTIONAL_STRING_FLAGS.has(name)) index += 1;
      continue;
    }
    if (argument.startsWith("-") && !argument.startsWith("--")) {
      const name = SHORT_FLAGS[argument.slice(1)];
      if (name !== undefined && !BOOLEAN_FLAGS.has(name)) index += 1;
      continue;
    }
    if (COMMANDS.has(argument)) return argument;
  }
  return undefined;
}

export function parseArguments(argv: string[], options: ParseArgumentOptions = {}): ParsedArguments {
  const additional = new Map<string, AdditionalCliFlag>();
  for (const flag of options.additionalFlags ?? []) {
    if (!/^[a-z][a-z0-9-]{0,62}$/u.test(flag.name) || (flag.type !== "boolean" && flag.type !== "string")) {
      throw new Error("Additional CLI flag definition is invalid");
    }
    if (KNOWN_FLAGS.has(flag.name)) throw new Error(`Extension flag --${flag.name} conflicts with a built-in flag`);
    if (!additional.has(flag.name)) additional.set(flag.name, flag);
  }
  const flags = new Map<string, string | boolean | string[]>();
  const deferredFlags: string[] = [];
  const positionals: string[] = [];
  const setFlag = (name: string, value: string | boolean): void => {
    if (!KNOWN_FLAGS.has(name) && !additional.has(name)) throw new Error(`Unknown flag --${name}`);
    if (["append-system-prompt", "reference", "extension", "package", "skill", "prompt-template", "theme"].includes(name) && typeof value === "string") {
      const existing = flags.get(name);
      if (existing === undefined) flags.set(name, [value]);
      else if (Array.isArray(existing)) existing.push(value);
      else throw new Error(`Flag --${name} has an invalid value`);
      return;
    }
    if (flags.has(name)) throw new Error(`Flag --${name} was provided more than once`);
    flags.set(name, value);
  };
  let literal = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (literal) {
      positionals.push(argument);
      continue;
    }
    if (argument === "--") {
      literal = true;
      continue;
    }
    if (argument.startsWith("--")) {
      const equals = argument.indexOf("=");
      const name = argument.slice(2, equals < 0 ? undefined : equals);
      if (name === "") throw new Error("Empty flag name");
      const additionalFlag = additional.get(name);
      if (!KNOWN_FLAGS.has(name) && additionalFlag === undefined) {
        if (options.deferUnknown === true) {
          deferredFlags.push(name);
          continue;
        }
        throw new Error(`Unknown flag --${name}`);
      }
      if (equals >= 0) {
        const value = argument.slice(equals + 1);
        if (additionalFlag?.type === "boolean") {
          if (value !== "true" && value !== "false") throw new Error(`--${name} requires true or false when assigned a value`);
          setFlag(name, value === "true");
        } else setFlag(name, value);
      }
      else if (BOOLEAN_FLAGS.has(name) || additionalFlag?.type === "boolean") setFlag(name, true);
      else if (OPTIONAL_STRING_FLAGS.has(name)) {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) setFlag(name, true);
        else {
          setFlag(name, value);
          index += 1;
        }
      }
      else {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`);
        setFlag(name, value);
        index += 1;
      }
      continue;
    }
    if (argument.startsWith("-") && !argument.startsWith("--")) {
      const name = SHORT_FLAGS[argument.slice(1)];
      if (name === undefined) throw new Error(`Unknown flag ${argument}`);
      if (BOOLEAN_FLAGS.has(name)) setFlag(name, true);
      else {
        const value = argv[index + 1];
        if (value === undefined) throw new Error(`${argument} requires a value`);
        setFlag(name, value);
        index += 1;
      }
      continue;
    }
    positionals.push(argument);
  }
  const first = positionals[0];
  const deferredCommand = options.deferUnknown === true ? explicitCommand(argv) : undefined;
  if (deferredCommand !== undefined) {
    const index = positionals.indexOf(deferredCommand);
    return {
      command: deferredCommand,
      positionals: index < 0 ? positionals : [...positionals.slice(0, index), ...positionals.slice(index + 1)],
      flags,
      source: [...argv],
      deferredFlags,
    };
  }
  if (first !== undefined && COMMANDS.has(first)) {
    return { command: first, positionals: positionals.slice(1), flags, source: [...argv], deferredFlags };
  }
  return {
    command: process.stdin.isTTY && !flags.has("print") && !flags.has("json") ? "chat" : "run",
    positionals,
    flags,
    source: [...argv],
    deferredFlags,
  };
}

export function flagString(argumentsValue: ParsedArguments, name: string): string | undefined {
  const value = argumentsValue.flags.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`--${name} requires a value`);
  return value;
}

export function flagStrings(argumentsValue: ParsedArguments, name: string): string[] {
  const value = argumentsValue.flags.get(name);
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`--${name} must be provided as a repeatable value`);
  return [...value];
}

export function flagBoolean(argumentsValue: ParsedArguments, name: string): boolean {
  return argumentsValue.flags.get(name) === true;
}
