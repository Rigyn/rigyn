import type {
  AssistantMessage,
  AssistantMessageEvent,
  ImageContent,
  Model,
  TextContent,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "@rigyn/models";

import type { AgentMessage, ThinkingLevel } from "../types.js";
import type { AgentTool, AgentToolResult } from "./tools.js";

interface AgentConversationContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools?: AgentTool[];
}

export interface AgentContext extends AgentConversationContext {}

export interface BeforeToolCallContext {
  assistantMessage: AssistantMessage;
  toolCall: ToolCall;
  args: unknown;
  context: AgentContext;
}

export interface AfterToolCallContext extends BeforeToolCallContext {
  result: CompletedToolResult;
  isError: boolean;
}

interface ToolResultControls {
  usage?: Usage;
  terminate?: boolean;
}

interface CompletedToolResult extends AgentToolResult, ToolResultControls {
  addedToolNames?: string[];
}

export interface AfterToolCallResult extends ToolResultControls {
  content?: Array<TextContent | ImageContent>;
  details?: unknown;
  isError?: boolean;
}

export interface PrepareNextTurnContext {
  message: AssistantMessage;
  toolResults: ToolResultMessage[];
  context: AgentContext;
  newMessages: AgentMessage[];
}

export interface AgentLoopTurnUpdate {
  model?: Model;
  thinkingLevel?: ThinkingLevel;
  context?: AgentConversationContext;
}

export type ToolExecutionMode = "parallel" | "sequential";

type AgentRunEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean };

type AgentTurnEvent =
  | { type: "turn_start"; turnIndex: number; timestamp: number }
  | { type: "turn_end"; turnIndex: number; message: AgentMessage; toolResults: ToolResultMessage[] };

type AgentMessageEvent =
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage };

type AgentToolEvent =
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean };

export type AgentEvent = AgentRunEvent | AgentTurnEvent | AgentMessageEvent | AgentToolEvent;
