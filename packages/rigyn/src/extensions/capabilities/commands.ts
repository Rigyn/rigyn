import type { SourceInfo } from "../../core/source-info.js";
import type { ExtensionContext } from "./host.js";
import type { ExtensionCommandContext } from "./session.js";

export interface CommandCompletion {
  value: string;
  label?: string;
  detail?: string;
}

export type CommandResult = void | string | { prompt?: string };

export interface RegisteredCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  sourceInfo: SourceInfo;
  getArgumentCompletions?(
    argumentPrefix: string,
    signal?: AbortSignal,
  ): readonly CommandCompletion[] | null | Promise<readonly CommandCompletion[] | null>;
  handler(args: string, context: ExtensionCommandContext): CommandResult | Promise<CommandResult>;
}

export interface ResolvedCommand extends RegisteredCommand {
  invocationName: string;
  handler(args: string): CommandResult | Promise<CommandResult>;
}

export interface CommandOptions {
  description?: string;
  argumentHint?: string;
  getArgumentCompletions?(
    argumentPrefix: string,
    signal?: AbortSignal,
  ): readonly CommandCompletion[] | null | Promise<readonly CommandCompletion[] | null>;
  handler(args: string, context: ExtensionCommandContext): CommandResult | Promise<CommandResult>;
}

export interface ShortcutOptions {
  description?: string;
  handler(context: ExtensionContext): void | Promise<void>;
}

export interface FlagOptions {
  description?: string;
  type: "boolean" | "string";
  default?: boolean | string;
}

export interface ExtensionShortcut {
  shortcut: string;
  extensionPath: string;
  description?: string;
  handler(context?: ExtensionContext): void | Promise<void>;
}

export interface ExtensionFlag {
  name: string;
  extensionPath: string;
  description?: string;
  type: "boolean" | "string";
  default?: boolean | string;
}
