import type { ImageContent, TextContent, Usage } from "@rigyn/kernel";

import type { ToolUpdate } from "../../../../core/events.js";
import type { ToolResult } from "../../../../tools/types.js";

export interface ToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolExecutionUpdateEvent extends Omit<ToolExecutionStartEvent, "type"> {
  type: "tool_execution_update";
  partialResult: ToolUpdate;
}

export interface ToolExecutionEndEvent extends Omit<ToolExecutionStartEvent, "type"> {
  type: "tool_execution_end";
  result: ToolResult;
  isError: boolean;
}

export interface ToolCallEvent<TInput extends Record<string, unknown> = Record<string, unknown>> {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: TInput;
}

export interface ToolCallEventResult {
  block?: boolean;
  reason?: string;
  terminate?: boolean;
}

export interface ToolResultEvent<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TDetails = unknown,
> {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  input: TInput;
  content: Array<TextContent | ImageContent>;
  details?: TDetails;
  isError: boolean;
  usage?: Usage;
}

export interface ToolResultEventResult<TDetails = unknown> {
  content?: Array<TextContent | ImageContent>;
  details?: TDetails;
  isError?: boolean;
  usage?: Usage;
}

export type BashToolCallEvent = ToolCallEvent<{ command: string; timeout?: number }>;
export type ReadToolCallEvent = ToolCallEvent<{ path: string; offset?: number; limit?: number }>;
export type EditToolCallEvent = ToolCallEvent<{
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
}>;
export type WriteToolCallEvent = ToolCallEvent<{ path: string; content: string }>;
export type GrepToolCallEvent = ToolCallEvent;
export type FindToolCallEvent = ToolCallEvent;
export type LsToolCallEvent = ToolCallEvent;
export type CustomToolCallEvent = ToolCallEvent;
export type BashToolResultEvent = ToolResultEvent<BashToolCallEvent["input"]>;
export type ReadToolResultEvent = ToolResultEvent<ReadToolCallEvent["input"]>;
export type EditToolResultEvent = ToolResultEvent<EditToolCallEvent["input"]>;
export type WriteToolResultEvent = ToolResultEvent<WriteToolCallEvent["input"]>;
export type GrepToolResultEvent = ToolResultEvent<GrepToolCallEvent["input"]>;
export type FindToolResultEvent = ToolResultEvent<FindToolCallEvent["input"]>;
export type LsToolResultEvent = ToolResultEvent<LsToolCallEvent["input"]>;
export type CustomToolResultEvent = ToolResultEvent;

export function isToolCallEventType<TName extends string>(
  event: ToolCallEvent | ToolResultEvent,
  name: TName,
): event is (ToolCallEvent | ToolResultEvent) & { toolName: TName } {
  return event.toolName === name;
}

export const isBashToolResult = (event: ToolResultEvent): event is BashToolResultEvent => event.toolName === "bash";
export const isReadToolResult = (event: ToolResultEvent): event is ReadToolResultEvent => event.toolName === "read";
export const isEditToolResult = (event: ToolResultEvent): event is EditToolResultEvent => event.toolName === "edit";
export const isWriteToolResult = (event: ToolResultEvent): event is WriteToolResultEvent => event.toolName === "write";
export const isGrepToolResult = (event: ToolResultEvent): event is GrepToolResultEvent => event.toolName === "grep";
export const isFindToolResult = (event: ToolResultEvent): event is FindToolResultEvent => event.toolName === "find";
export const isLsToolResult = (event: ToolResultEvent): event is LsToolResultEvent => event.toolName === "ls";

export interface ToolEventMap {
  tool_execution_start: ToolExecutionStartEvent;
  tool_execution_update: ToolExecutionUpdateEvent;
  tool_execution_end: ToolExecutionEndEvent;
  tool_call: ToolCallEvent;
  tool_result: ToolResultEvent;
}

export interface ToolEventResultMap {
  tool_execution_start: void;
  tool_execution_update: void;
  tool_execution_end: void;
  tool_call: ToolCallEventResult | void;
  tool_result: ToolResultEventResult | void;
}
