export interface CommandPlatformOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
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
