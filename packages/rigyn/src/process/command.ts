export interface CommandPlatformOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
}

export function parseCommandLine(value: string, label = "Command"): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let started = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (character === "\\" && value[index + 1] !== undefined && /[\s'"]/u.test(value[index + 1]!)) {
      current += value[index + 1]!;
      started = true;
      index += 1;
    } else if (/\s/u.test(character)) {
      if (started) {
        parts.push(current);
        current = "";
        started = false;
      }
    } else {
      current += character;
      started = true;
    }
  }
  if (quote !== undefined) throw new Error(`${label} contains an unfinished quote`);
  if (started) parts.push(current);
  if (parts.length === 0) throw new Error(`${label} is empty`);
  return parts;
}

function windowsBatchCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return normalized.endsWith(".cmd") || normalized.endsWith(".bat");
}

/**
 * Produces an argv suitable for child_process.spawn without enabling a shell.
 * Windows batch files are rejected because cmd.exe interprets metacharacters
 * even when Node itself is spawned with shell:false.
 */
export function normalizeCommandArgv(
  argv: readonly string[],
  options: CommandPlatformOptions = {},
): [string, ...string[]] {
  const [command, ...args] = argv;
  if (command === undefined || command.length === 0 || command.includes("\0")) {
    throw new Error("Command argv must begin with a non-empty command without NUL");
  }
  if ((options.platform ?? process.platform) !== "win32" || !windowsBatchCommand(command)) {
    return [command, ...args];
  }
  throw new Error("Windows batch command wrappers are unsupported; configure a native executable or invoke a script through its interpreter");
}
