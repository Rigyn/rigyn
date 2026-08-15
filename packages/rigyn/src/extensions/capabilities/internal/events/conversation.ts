import type {
  AgentMessage,
  AssistantMessageEvent,
  CustomMessage,
  ImageContent,
  ToolResultMessage,
} from "@rigyn/kernel";

import type { BuildSystemPromptOptions } from "../../../../core/system-prompt.js";
import type { PromptCompositionMetadata } from "../../../../core/types.js";

interface ConversationEvent<Type extends string> {
  type: Type;
}

interface ConversationMessageEvent<Type extends string> extends ConversationEvent<Type> {
  message: AgentMessage;
}

interface ConversationTurnEvent<Type extends string> extends ConversationEvent<Type> {
  turnIndex: number;
}

export interface ContextEvent extends ConversationEvent<"context"> {
  messages: AgentMessage[];
}

export interface ContextEventResult {
  messages?: AgentMessage[];
}

export interface BeforeAgentStartEvent extends ConversationEvent<"before_agent_start"> {
  prompt: string;
  images?: ImageContent[];
  systemPrompt: string;
  systemPromptOptions: BuildSystemPromptOptions;
  promptComposition?: PromptCompositionMetadata;
}

export interface BeforeAgentStartEventResult {
  message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
  systemPrompt?: string;
}

export interface AgentStartEvent extends ConversationEvent<"agent_start"> {}

export interface AgentEndEvent extends ConversationEvent<"agent_end"> {
  messages: AgentMessage[];
}

export interface AgentSettledEvent extends ConversationEvent<"agent_settled"> {}

export interface TurnStartEvent extends ConversationTurnEvent<"turn_start"> {
  timestamp: number;
}

export interface TurnEndEvent extends ConversationTurnEvent<"turn_end"> {
  message: AgentMessage;
  toolResults: ToolResultMessage[];
}

export interface MessageStartEvent extends ConversationMessageEvent<"message_start"> {}

export interface MessageUpdateEvent extends ConversationMessageEvent<"message_update"> {
  assistantMessageEvent: AssistantMessageEvent;
}

export interface MessageEndEvent extends ConversationMessageEvent<"message_end"> {}

export interface MessageEndEventResult {
  message?: AgentMessage;
}

export interface ConversationEventMap {
  agent_end: AgentEndEvent;
  agent_start: AgentStartEvent;
  agent_settled: AgentSettledEvent;
  before_agent_start: BeforeAgentStartEvent;
  context: ContextEvent;
  message_end: MessageEndEvent;
  message_start: MessageStartEvent;
  message_update: MessageUpdateEvent;
  turn_end: TurnEndEvent;
  turn_start: TurnStartEvent;
}

type ConversationVoidResultEvent =
  | "agent_end"
  | "agent_settled"
  | "agent_start"
  | "message_start"
  | "message_update"
  | "turn_end"
  | "turn_start";

export interface ConversationEventResultMap extends Record<ConversationVoidResultEvent, void> {
  before_agent_start: BeforeAgentStartEventResult | void;
  context: ContextEventResult | void;
  message_end: MessageEndEventResult | void;
}
