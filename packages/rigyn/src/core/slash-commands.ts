import { INTERACTIVE_COMMANDS } from "../interactive/commands.js";
import type { SourceInfo } from "./source-info.js";

export type SlashCommandSource = "builtin" | "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
  source: SlashCommandSource;
  sourceInfo: SourceInfo;
}

export const BUILTIN_SLASH_COMMANDS: readonly SlashCommandInfo[] = INTERACTIVE_COMMANDS
  .filter((command) => !command.hidden && command.palette !== undefined)
  .map((command) => {
    const argumentHint = command.syntax.slice(command.name.length).trim();
    return {
      name: command.name,
      description: command.palette!.label,
      ...(argumentHint === "" ? {} : { argumentHint }),
      source: "builtin",
      sourceInfo: {
        path: `<builtin:${command.name}>`,
        source: "builtin",
        scope: "temporary",
        origin: "top-level",
      },
    };
  });
