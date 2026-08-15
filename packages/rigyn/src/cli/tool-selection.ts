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
  configured: ToolSelection = {},
): ToolSelection {
  const noTools = argumentsValue.noTools === true;
  const noBuiltins = argumentsValue.noBuiltinTools === true;
  const explicit = argumentsValue.tools;
  if ([noTools, noBuiltins, explicit !== undefined].filter(Boolean).length > 1) {
    throw new Error("--tools, --no-tools, and --no-builtin-tools are mutually exclusive");
  }
  const excludedTools = [...new Set([
    ...(configured.excludedTools ?? []),
    ...(argumentsValue.excludeTools ?? []),
  ])];
  const withExcluded = excludedTools.length === 0 ? {} : { excludedTools };
  if (noTools) return { allowedTools: [], ...withExcluded };
  if (noBuiltins) {
    return {
      allowedTools: [...new Set(extensionToolNames)],
      ...withExcluded,
    };
  }
  return {
    allowedTools: explicit
      ?? configured.allowedTools
      ?? [...new Set([...DEFAULT_BUILTIN_TOOL_NAMES, ...extensionToolNames])],
    ...withExcluded,
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
