import { resolve } from "node:path";
import type { Static, TSchema } from "typebox";

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from "../extensions/direct.js";
import { extensionContent, extensionUsage } from "../extensions/session-contract.js";
import { DirectProcessRunner } from "../process/runner.js";
import type { WorkspaceBoundary } from "./paths.js";
import type { HarnessTool, ToolExecutionContext, ToolExecutionMode, ToolResult } from "./types.js";

export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = unknown> {
  name: string;
  label: string;
  description: string;
  parameters: TParameters;
  prepareArguments?: (args: unknown) => Static<TParameters>;
  executionMode?: ToolExecutionMode;
  execute(
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ): Promise<AgentToolResult<TDetails>>;
}

function toolContext(
  cwd: string,
  toolCallId: string,
  signal: AbortSignal,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  extensionContext: ExtensionContext | undefined,
): ToolExecutionContext {
  let streamed = "";
  return {
    workspace: { root: resolve(cwd) } as WorkspaceBoundary,
    runner: new DirectProcessRunner(),
    signal,
    runId: "tool-run",
    threadId: "tool-session",
    toolCallId,
    ...(extensionContext?.model === undefined ? {} : { activeModel: extensionContext.model }),
    ...(onUpdate === undefined ? {} : {
      reportProgress(progress): void {
        if (progress.type === "output") {
          streamed += progress.delta;
          onUpdate({ content: [{ type: "text", text: streamed }], details: undefined });
          return;
        }
        onUpdate({ content: [{ type: "text", text: progress.content }], details: progress.metadata });
      },
    }),
  };
}

function convertResult<TDetails>(result: ToolResult, details: TDetails): AgentToolResult<TDetails> {
  if (result.isError) throw new Error(result.content);
  return {
    content: extensionContent(result.contentBlocks ?? [
      ...(result.content === "" ? [] : [{ type: "text" as const, text: result.content }]),
      ...(result.images ?? []),
    ]),
    details,
    ...(result.usage === undefined ? {} : { usage: extensionUsage(result.usage) }),
    ...(result.addedToolNames === undefined ? {} : { addedToolNames: [...result.addedToolNames] }),
    ...(result.terminate === undefined ? {} : { terminate: result.terminate }),
  };
}

export function createHarnessToolDefinition<TParameters extends TSchema, TDetails>(options: {
  cwd: string;
  tool: HarnessTool;
  label: string;
  parameters: TParameters;
  details(result: ToolResult): TDetails;
  render?: Pick<ToolDefinition<TParameters, TDetails>, "renderCall" | "renderResult" | "renderShell">;
}): ToolDefinition<TParameters, TDetails> {
  const definition = options.tool.definition;
  return {
    name: definition.name,
    label: options.label,
    description: definition.description,
    parameters: options.parameters,
    ...(definition.promptSnippet === undefined ? {} : { promptSnippet: definition.promptSnippet }),
    ...(definition.promptGuidelines === undefined ? {} : { promptGuidelines: [...definition.promptGuidelines] }),
    ...(options.tool.prepareInput === undefined ? {} : {
      prepareArguments: (args) => options.tool.prepareInput!(args as never, {} as never) as Static<TParameters>,
    }),
    ...(options.tool.executionMode === undefined ? {} : { executionMode: options.tool.executionMode }),
    ...options.render,
    async execute(toolCallId, params, signal, onUpdate, extensionContext) {
      const activeSignal = signal ?? new AbortController().signal;
      options.tool.validate(params as never);
      const result = await options.tool.execute(
        params as never,
        toolContext(
          options.cwd,
          toolCallId,
          activeSignal,
          onUpdate as AgentToolUpdateCallback<unknown> | undefined,
          extensionContext,
        ),
      );
      return convertResult(result, options.details(result));
    },
  };
}

export function wrapToolDefinition<TParameters extends TSchema, TDetails>(
  definition: ToolDefinition<TParameters, TDetails>,
  contextFactory?: () => ExtensionContext,
): AgentTool<TParameters, TDetails> {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    ...(definition.prepareArguments === undefined ? {} : { prepareArguments: definition.prepareArguments }),
    ...(definition.executionMode === undefined ? {} : { executionMode: definition.executionMode }),
    execute: (toolCallId, params, signal, onUpdate) => definition.execute(
      toolCallId,
      params,
      signal,
      onUpdate,
      contextFactory?.() as ExtensionContext,
    ),
  };
}

export function wrapToolDefinitions(definitions: ToolDefinition[]): AgentTool[] {
  return definitions.map((definition) => wrapToolDefinition(definition));
}

export const wrapRegisteredTool = wrapToolDefinition;
export const wrapRegisteredTools = wrapToolDefinitions;

export function createToolDefinitionFromAgentTool(tool: AgentTool): ToolDefinition {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.prepareArguments === undefined ? {} : { prepareArguments: tool.prepareArguments }),
    ...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
    execute: (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
  };
}
