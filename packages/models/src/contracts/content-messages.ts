import type { Api, Tool, Usage } from "./models-sampling-streaming.js";

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";

export interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}

export type AssistantContent = TextContent | ThinkingContent | ToolCall;

export interface UserMessage {
  role: "user";
  content: string | Array<TextContent | ImageContent>;
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];
  api: Api;
  provider: string;
  model: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string | undefined;
  timestamp: number;
  responseModel?: string;
  responseId?: string;
  diagnostics?: readonly AssistantMessageDiagnostic[];
  providerState?: ProviderState;
}

export interface AssistantMessageDiagnosticError {
  name?: string;
  message: string;
  stack?: string;
  code?: string | number;
  status?: number;
}

export interface AssistantMessageDiagnostic {
  type: string;
  timestamp: number;
  message?: string;
  error?: AssistantMessageDiagnosticError;
  details?: unknown;
}

export interface ProviderStateSource {
  api: Api;
  provider: string;
  model: string;
}

export interface ProviderState {
  source: ProviderStateSource;
  value: unknown;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<TextContent | ImageContent>;
  isError: boolean;
  details?: unknown;
  addedToolNames?: string[];
  usage?: Usage;
  timestamp: number;
}

export interface CustomMessage<T = unknown> {
  role: "custom";
  customType: string;
  content: string | Array<TextContent | ImageContent>;
  display?: boolean;
  details?: T;
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;
export type AgentMessage = Message | CustomMessage;

export interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}
