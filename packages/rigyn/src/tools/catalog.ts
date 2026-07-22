import type { ToolDefinition } from "../extensions/direct.js";
import {
  createBashTool,
  createBashToolDefinition,
  type BashToolOptions,
} from "./builtins/shell.js";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./builtins/edit.js";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./builtins/find.js";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./builtins/grep.js";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./builtins/ls.js";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./builtins/read.js";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./builtins/write.js";
import type { AgentTool } from "./direct-tool.js";

export type Tool = AgentTool<any, any>;
export type ToolDef = ToolDefinition<any, any, any>;
export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

export const allToolNames: Set<ToolName> = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export interface ToolsOptions {
  read?: ReadToolOptions;
  bash?: BashToolOptions;
  write?: WriteToolOptions;
  edit?: EditToolOptions;
  grep?: GrepToolOptions;
  find?: FindToolOptions;
  ls?: LsToolOptions;
}

export function createToolDefinition(name: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
  switch (name) {
    case "read": return createReadToolDefinition(cwd, options?.read);
    case "bash": return createBashToolDefinition(cwd, options?.bash);
    case "edit": return createEditToolDefinition(cwd, options?.edit);
    case "write": return createWriteToolDefinition(cwd, options?.write);
    case "grep": return createGrepToolDefinition(cwd, options?.grep);
    case "find": return createFindToolDefinition(cwd, options?.find);
    case "ls": return createLsToolDefinition(cwd, options?.ls);
  }
}

export function createTool(name: ToolName, cwd: string, options?: ToolsOptions): Tool {
  switch (name) {
    case "read": return createReadTool(cwd, options?.read);
    case "bash": return createBashTool(cwd, options?.bash);
    case "edit": return createEditTool(cwd, options?.edit);
    case "write": return createWriteTool(cwd, options?.write);
    case "grep": return createGrepTool(cwd, options?.grep);
    case "find": return createFindTool(cwd, options?.find);
    case "ls": return createLsTool(cwd, options?.ls);
  }
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
  return ["read", "bash", "edit", "write"].map((name) => createToolDefinition(name as ToolName, cwd, options));
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
  return ["read", "grep", "find", "ls"].map((name) => createToolDefinition(name as ToolName, cwd, options));
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
  return Object.fromEntries([...allToolNames].map((name) => [name, createToolDefinition(name, cwd, options)])) as Record<ToolName, ToolDef>;
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
  return ["read", "bash", "edit", "write"].map((name) => createTool(name as ToolName, cwd, options));
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
  return ["read", "grep", "find", "ls"].map((name) => createTool(name as ToolName, cwd, options));
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
  return Object.fromEntries([...allToolNames].map((name) => [name, createTool(name, cwd, options)])) as Record<ToolName, Tool>;
}
