export interface CommandPlatformOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = environment[name];
  if (direct !== undefined) return direct;
  const normalized = name.toLowerCase();
  return Object.entries(environment).find(([key, value]) => value !== undefined && key.toLowerCase() === normalized)?.[1];
}

function windowsBatchCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return normalized.endsWith(".cmd") || normalized.endsWith(".bat");
}

/**
 * Produces an argv suitable for child_process.spawn without enabling a shell.
 * Windows batch files require cmd.exe, so they are passed to ComSpec as
 * individual arguments instead of interpolating a command string.
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
  const environment = options.environment ?? process.env;
  const comspec = environmentValue(environment, "ComSpec") || "cmd.exe";
  return [comspec, "/d", "/s", "/v:off", "/c", command, ...args];
}
