import type { SourceInfo } from "./source-info.js";
import { INTERACTIVE_COMMANDS } from "../interactive/commands.js";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: SlashCommandSource;
  sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

export const BUILTIN_SLASH_COMMANDS: readonly BuiltinSlashCommand[] = Object.freeze(
  INTERACTIVE_COMMANDS.filter((command) => !command.hidden && command.palette !== undefined).map((command) => {
    const argumentHint = command.syntax.slice(command.name.length).trim();
    return {
      name: command.name,
      description: command.palette!.label,
      ...(argumentHint === "" ? {} : { argumentHint }),
    };
  }),
);
