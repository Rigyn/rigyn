import type { Static, TSchema } from "typebox";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  Tool,
  ToolResultMessage,
  Usage,
} from "@rigyn/models";

export type StreamFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export type ToolExecutionMode = "sequential" | "parallel";
export type QueueMode = "all" | "one-at-a-time";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
}

export interface AfterToolCallResult {
  content?: Array<TextContent | ImageContent>;
  details?: unknown;
  isError?: boolean;
  usage?: Usage;
  terminate?: boolean;
}

export interface BeforeToolCallContext {
  assistantMessage: AssistantMessage;
  toolCall: AgentToolCall;
  args: unknown;
  context: AgentContext;
}

export interface AfterToolCallContext {
  assistantMessage: AssistantMessage;
  toolCall: AgentToolCall;
  args: unknown;
  result: AgentToolResult<unknown>;
  isError: boolean;
  context: AgentContext;
}

export interface ShouldStopAfterTurnContext {
  message: AssistantMessage;
  toolResults: ToolResultMessage[];
  context: AgentContext;
  newMessages: AgentMessage[];
}

export interface PrepareNextTurnContext extends ShouldStopAfterTurnContext {}

export interface AgentLoopTurnUpdate {
  context?: AgentContext;
  model?: Model;
  thinkingLevel?: ThinkingLevel;
}

export interface AgentLoopConfig extends SimpleStreamOptions {
  model: Model;
  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
  prepareNextTurn?: (context: PrepareNextTurnContext) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  getFollowUpMessages?: () => Promise<AgentMessage[]>;
  toolExecution?: ToolExecutionMode;
  beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
}

export interface CustomAgentMessages {}
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

export interface AgentState {
  systemPrompt: string;
  model: Model;
  thinkingLevel: ThinkingLevel;
  set tools(tools: AgentTool[]);
  get tools(): AgentTool[];
  set messages(messages: AgentMessage[]);
  get messages(): AgentMessage[];
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly errorMessage?: string;
}

export interface AgentToolResult<TDetails = unknown> {
  content: Array<TextContent | ImageContent>;
  details: TDetails;
  usage?: Usage;
  addedToolNames?: string[];
  terminate?: boolean;
}

export type AgentToolUpdateCallback<TDetails = unknown> = (partialResult: AgentToolResult<TDetails>) => void;

export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = unknown> extends Tool<TParameters> {
  label: string;
  prepareArguments?: (args: unknown) => Static<TParameters>;
  execute(
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ): Promise<AgentToolResult<TDetails>>;
  executionMode?: ToolExecutionMode;
}

export interface AgentContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools?: AgentTool[];
}

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean };
