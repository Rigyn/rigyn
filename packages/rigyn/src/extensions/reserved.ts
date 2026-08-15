import { interactiveCommandNames } from "../interactive/commands.js";

const BUILTIN_SLASH_COMMANDS = new Set(interactiveCommandNames());

export function isBuiltinSlashCommand(name: string): boolean {
  return BUILTIN_SLASH_COMMANDS.has(name);
}

export function builtinSlashCommands(): string[] {
  return [...BUILTIN_SLASH_COMMANDS].sort((left, right) => left.localeCompare(right));
}
