import type { Args } from "./args.js";

export const DEFAULT_BUILTIN_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

export interface ToolSelection {
  allowedTools?: string[];
  excludedTools?: string[];
}

type ToolSelectionArguments = Partial<Pick<Args,
  "tools" | "excludeTools" | "noTools" | "noBuiltinTools">>;

export function defaultTools(): string[] {
  return [...DEFAULT_BUILTIN_TOOL_NAMES];
}

export function selectedTools(
  argumentsValue: ToolSelectionArguments,
  extensionToolNames: readonly string[] = [],
): ToolSelection {
  const noTools = argumentsValue.noTools === true;
  const noBuiltins = argumentsValue.noBuiltinTools === true;
  const configured = argumentsValue.tools;
  if ([noTools, noBuiltins, configured !== undefined].filter(Boolean).length > 1) {
    throw new Error("--tools, --no-tools, and --no-builtin-tools are mutually exclusive");
  }
  const excludedTools = argumentsValue.excludeTools;
  if (noTools) return { allowedTools: [], ...(excludedTools === undefined ? {} : { excludedTools }) };
  if (noBuiltins) {
    return {
      allowedTools: [...new Set(extensionToolNames)],
      ...(excludedTools === undefined ? {} : { excludedTools }),
    };
  }
  return {
    allowedTools: configured ?? [...new Set([...DEFAULT_BUILTIN_TOOL_NAMES, ...extensionToolNames])],
    ...(excludedTools === undefined ? {} : { excludedTools }),
  };
}

export function activeToolsForSelection(
  availableTools: readonly string[],
  selection: ToolSelection,
): string[] {
  const allowed = selection.allowedTools === undefined ? undefined : new Set(selection.allowedTools);
  const excluded = new Set(selection.excludedTools ?? []);
  return availableTools.filter((name) => (allowed === undefined || allowed.has(name)) && !excluded.has(name));
}
