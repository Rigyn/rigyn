import type { ImageContent, TextContent, Usage } from "@rigyn/kernel";
import type { Component } from "@rigyn/terminal";
import type { Static, TSchema } from "typebox";

import type { JsonValue } from "../../core/json.js";
import type { SourceInfo } from "../../core/source-info.js";
import type { ProviderToolDefinition } from "../../core/types.js";
import type {
  ResourceClaim,
  ToolContext,
  ToolExecutionMode,
  ToolRecoveryContract,
} from "../../tools/types.js";
import type { RuntimeUiBlock } from "../../tui/components.js";
import type { Theme } from "../../tui/theme.js";
import type { ExtensionContext } from "./host.js";

export interface ToolRenderContext<TState = Record<string, unknown>> {
  readonly args: unknown;
  readonly toolCallId: string;
  readonly invalidate: () => void;
  readonly lastComponent: Component | undefined;
  readonly state: TState;
  readonly cwd: string;
  readonly executionStarted: boolean;
  readonly argsComplete: boolean;
  readonly isPartial: boolean;
  readonly expanded: boolean;
  readonly showImages: boolean;
  readonly isError: boolean;
}

export interface ToolRenderResultOptions {
  expanded: boolean;
  isPartial: boolean;
}

export type ToolRenderOutput = Component | RuntimeUiBlock;

export interface AgentToolResult<TDetails = unknown> {
  content: Array<TextContent | ImageContent>;
  details: TDetails;
  usage?: Usage;
  addedToolNames?: string[];
  terminate?: boolean;
}

export type AgentToolUpdateCallback<TDetails = unknown> = (update: AgentToolResult<TDetails>) => void;

export interface ToolDefinition<
  TParameters extends TSchema = TSchema,
  TDetails = unknown,
  TState = Record<string, unknown>,
> {
  name: string;
  label?: string;
  description: string;
  parameters: TParameters;
  constrainedSampling?: ProviderToolDefinition["constrainedSampling"];
  loading?: ProviderToolDefinition["loading"];
  promptSnippet?: string;
  promptGuidelines?: string[];
  prepareArguments?(input: JsonValue): Static<TParameters> | Promise<Static<TParameters>>;
  executionMode?: ToolExecutionMode;
  recovery?: ToolRecoveryContract;
  resources?(input: Static<TParameters>, context: ToolContext): ResourceClaim[] | Promise<ResourceClaim[]>;
  execute(
    toolCallId: string,
    input: Static<TParameters>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    context: ExtensionContext,
  ): AgentToolResult<TDetails> | Promise<AgentToolResult<TDetails>>;
  renderShell?: "default" | "self";
  renderCall?(input: Static<TParameters>, theme: Theme, context: ToolRenderContext<TState>): ToolRenderOutput;
  renderResult?(
    result: AgentToolResult<TDetails>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: ToolRenderContext<TState>,
  ): ToolRenderOutput;
}

export function defineTool<
  const TParameters extends TSchema,
  TDetails = unknown,
  TState = Record<string, unknown>,
>(definition: ToolDefinition<TParameters, TDetails, TState>): ToolDefinition<TParameters, TDetails, TState> {
  return definition;
}

export interface ToolInfo {
  name: string;
  label?: string;
  description: string;
  parameters: TSchema;
  constrainedSampling?: ProviderToolDefinition["constrainedSampling"];
  loading?: ProviderToolDefinition["loading"];
  promptGuidelines?: string[];
  sourceInfo: SourceInfo;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  sourceInfo: SourceInfo;
}

export type {
  DurableToolEffect,
  ResourceClaim,
  ToolContext,
  ToolExecutionMode,
  ToolRecoveryContext,
  ToolRecoveryContract,
  ToolRecoveryMode,
  ToolRecoveryResult,
} from "../../tools/types.js";
