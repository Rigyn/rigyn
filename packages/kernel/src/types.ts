import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@rigyn/models";
import type { AgentTool } from "./harness/types.js";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

type TimestampedKernelMessage<Role extends string> = {
  role: Role;
  timestamp: number;
};

export type BashExecutionMessage = TimestampedKernelMessage<"bashExecution"> & {
  command: string;
  output: string;
  isError?: boolean;
  cancelled: boolean;
  timedOut?: boolean;
  signal?: string;
  truncated: boolean;
  exitCode: number | undefined;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
};

export type CustomMessage<T = unknown> = TimestampedKernelMessage<"custom"> & {
  customType: string;
  content: string | Array<TextContent | ImageContent>;
  display: boolean;
  details?: T;
};

export interface CompactionSummaryMessage<T = unknown> {
  role: "compactionSummary";
  summary: string;
  details?: T;
  timestamp: number;
  tokensBefore: number;
  usage?: Usage | {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
  };
}

export interface BranchSummaryMessage<T = unknown> {
  role: "branchSummary";
  summary: string;
  fromId: string;
  details?: T;
  timestamp: number;
  usage?: Usage;
}

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | CompactionSummaryMessage
  | BranchSummaryMessage;

export interface AgentState {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  model?: unknown;
}

export interface AgentOptions {
  systemPrompt?: string;
  messages?: AgentMessage[];
  tools?: AgentTool[];
}

export type StreamContext = { systemPrompt?: string; messages: Message[] };
export type StreamOptions = Readonly<Record<string, unknown>>;
export type StreamFn = (
  model: import("@rigyn/models").Model,
  context: import("@rigyn/models").Context,
  options?: import("@rigyn/models").SimpleStreamOptions,
) => import("@rigyn/models").AssistantMessageEventStream;

export type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdate,
  BeforeToolCallResult,
  ExecutionEnv,
  ExecutionToolContext,
  FileInfo,
  Result,
  ShellExecOptions,
  ShellExecResult,
} from "./harness/types.js";
export { ExecutionError, FileError } from "./harness/types.js";
