import type { ImageContent, TextContent } from "@rigyn/models";
import type { Static, TSchema } from "typebox";

import type { ExecutionEnv } from "./process.js";

export interface ExecutionToolContext {
  env: ExecutionEnv;
}

export type AgentToolContent = TextContent | ImageContent;

export interface AgentToolResult<TDetails = unknown> {
  content: AgentToolContent[];
  details: TDetails;
}

export type AgentToolUpdate<TDetails = unknown> = AgentToolResult<TDetails>;

export interface AgentTool<
  TParameters extends TSchema = TSchema,
  TDetails = unknown,
  TContext extends ExecutionToolContext = ExecutionToolContext,
> {
  name: string;
  label: string;
  description: string;
  parameters: TParameters;
  execute(
    toolCallId: string,
    input: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: (update: AgentToolUpdate<TDetails>) => void,
    context?: TContext,
  ): Promise<AgentToolResult<TDetails>>;
}

export type AgentHarnessTool<
  TParameters extends TSchema = TSchema,
  TDetails = unknown,
  TContext extends ExecutionToolContext = ExecutionToolContext,
> = AgentTool<TParameters, TDetails, TContext>;

export interface ToolPreparation {
  command: string;
  cwd?: string;
  env: Record<string, string>;
  timeout?: number;
}

export interface ToolFactoryOptions<TContext extends ExecutionToolContext = ExecutionToolContext> {
  prepare?: (execution: ToolPreparation, context: TContext) => void | Promise<void>;
}

export interface BeforeToolCallResult {
  block?: boolean;
  terminate?: boolean;
  reason?: string;
}
