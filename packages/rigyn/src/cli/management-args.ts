const BOOLEAN_FLAGS = new Set([
  "json", "yes", "all", "local", "no-extensions",
  "approve", "no-approve", "allow-scripts", "offline",
]);

const KNOWN_FLAGS = new Set([
  ...BOOLEAN_FLAGS,
  "scope", "workspace", "extension", "session-dir",
]);

const COMMANDS = new Set([
  "config", "diagnostics", "extensions", "packages", "sessions", "install", "remove", "uninstall", "update", "list",
  "self-install", "self-update", "self-uninstall",
]);

const COMMAND_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  config: new Set(["json", "local", "scope", "workspace", "approve", "no-approve", "offline", "no-extensions", "extension"]),
  diagnostics: new Set(["workspace"]),
  extensions: new Set(["json", "local", "scope", "allow-scripts", "all", "workspace", "approve", "no-approve", "offline", "no-extensions", "extension"]),
  packages: new Set(["json", "all", "allow-scripts", "workspace", "approve", "no-approve", "offline", "no-extensions", "extension"]),
  sessions: new Set(["json", "all", "workspace", "session-dir"]),
  install: new Set(["json", "local", "scope", "allow-scripts", "workspace", "approve", "no-approve", "offline", "no-extensions", "extension"]),
  remove: new Set(["json", "local", "scope", "workspace", "approve", "no-approve", "offline", "no-extensions", "extension"]),
  update: new Set(["json", "local", "scope", "allow-scripts", "all", "workspace", "approve", "no-approve", "offline", "no-extensions", "extension"]),
  list: new Set(["json", "local", "scope", "workspace", "approve", "no-approve", "offline", "no-extensions", "extension"]),
  uninstall: new Set(["yes"]),
  "self-install": new Set<string>(),
  "self-update": new Set<string>(),
  "self-uninstall": new Set(["yes"]),
});

const SHORT_FLAGS: Record<string, string> = {
  y: "yes",
  l: "local",
  a: "approve",
  na: "no-approve",
  e: "extension",
  ne: "no-extensions",
};

/** Internal parser for Rigyn's package and maintenance subcommands. */
export interface ManagementArguments {
  command: string;
  positionals: string[];
  flags: Map<string, string | boolean | string[]>;
  source: string[];
}

export function parseManagementArguments(argv: string[]): ManagementArguments {
  const flags = new Map<string, string | boolean | string[]>();
  const positionals: string[] = [];
  const setFlag = (name: string, value: string | boolean): void => {
    if (!KNOWN_FLAGS.has(name)) throw new Error(`Unknown flag --${name}`);
    if (name === "extension" && typeof value === "string") {
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
      if (!KNOWN_FLAGS.has(name)) throw new Error(`Unknown flag --${name}`);
      if (equals >= 0) {
        const value = argument.slice(equals + 1);
        setFlag(name, value);
      }
      else if (BOOLEAN_FLAGS.has(name)) setFlag(name, true);
      else {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) throw new Error(`--${name} requires a value`);
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
        if (value === undefined || value.startsWith("-")) throw new Error(`${argument} requires a value`);
        setFlag(name, value);
        index += 1;
      }
      continue;
    }
    positionals.push(argument);
  }
  const first = positionals[0];
  if (first !== undefined && COMMANDS.has(first)) {
    const allowed = COMMAND_FLAGS[first];
    if (allowed !== undefined) {
      for (const name of flags.keys()) {
        if (KNOWN_FLAGS.has(name) && !allowed.has(name)) throw new Error(`--${name} is not valid for ${first}`);
      }
    }
    return { command: first, positionals: positionals.slice(1), flags, source: [...argv] };
  }
  return {
    command: process.stdin.isTTY && !flags.has("print") && !flags.has("json") ? "chat" : "run",
    positionals,
    flags,
    source: [...argv],
  };
}

export function flagString(argumentsValue: ManagementArguments, name: string): string | undefined {
  const value = argumentsValue.flags.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`--${name} requires a value`);
  return value;
}

export function flagStrings(argumentsValue: ManagementArguments, name: string): string[] {
  const value = argumentsValue.flags.get(name);
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`--${name} must be provided as a repeatable value`);
  return [...value];
}

export function flagPositiveSafeInteger(argumentsValue: ManagementArguments, name: string): number | undefined {
  const value = flagString(argumentsValue, name);
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`--${name} must be a positive safe integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`--${name} must be a positive safe integer`);
  return parsed;
}

export function flagBoolean(argumentsValue: ManagementArguments, name: string): boolean {
  return argumentsValue.flags.get(name) === true;
}
