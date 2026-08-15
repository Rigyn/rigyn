import type { ExtensionContext } from "./host.js";
import type {
  ConversationEventMap,
  ConversationEventResultMap,
} from "./internal/events/conversation.js";
import type {
  InteractionEventMap,
  InteractionEventResultMap,
} from "./internal/events/interaction.js";
import type {
  ProviderEventMap,
  ProviderEventResultMap,
} from "./internal/events/provider.js";
import type {
  SessionEventMap,
  SessionEventResultMap,
} from "./internal/events/session.js";
import type {
  ToolEventMap,
  ToolEventResultMap,
} from "./internal/events/tools.js";
import type {
  ProjectTrustContext,
  ProjectTrustEvent,
  ProjectTrustEventResult,
  TrustResourceEventMap,
  TrustResourceEventResultMap,
} from "./internal/events/trust-resources.js";

export type {
  AgentEndEvent,
  AgentSettledEvent,
  AgentStartEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ContextEvent,
  ContextEventResult,
  MessageEndEvent,
  MessageEndEventResult,
  MessageStartEvent,
  MessageUpdateEvent,
  TurnEndEvent,
  TurnStartEvent,
} from "./internal/events/conversation.js";
export type {
  InputEvent,
  InputEventResult,
  ModelSelectEvent,
  ThinkingLevelSelectEvent,
  UserBashEvent,
  UserBashEventResult,
} from "./internal/events/interaction.js";
export type {
  AfterProviderResponseEvent,
  BeforeProviderHeadersEvent,
  BeforeProviderRequestEvent,
  BeforeProviderRequestEventResult,
} from "./internal/events/provider.js";
export type {
  CompactionFileOperations,
  CompactionPreparation,
  CompactionSettings,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
  SessionBeforeForkEvent,
  SessionBeforeForkResult,
  SessionBeforeSwitchEvent,
  SessionBeforeSwitchResult,
  SessionBeforeTreeEvent,
  SessionBeforeTreeResult,
  SessionCompactEvent,
  SessionInfoChangedEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
  TreePreparation,
} from "./internal/events/session.js";
export type {
  BashToolCallEvent,
  BashToolResultEvent,
  CustomToolCallEvent,
  CustomToolResultEvent,
  EditToolCallEvent,
  EditToolResultEvent,
  FindToolCallEvent,
  FindToolResultEvent,
  GrepToolCallEvent,
  GrepToolResultEvent,
  LsToolCallEvent,
  LsToolResultEvent,
  ReadToolCallEvent,
  ReadToolResultEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionUpdateEvent,
  ToolResultEvent,
  ToolResultEventResult,
  WriteToolCallEvent,
  WriteToolResultEvent,
} from "./internal/events/tools.js";
export {
  isBashToolResult,
  isEditToolResult,
  isFindToolResult,
  isGrepToolResult,
  isLsToolResult,
  isReadToolResult,
  isToolCallEventType,
  isWriteToolResult,
} from "./internal/events/tools.js";
export type {
  ProjectTrustContext,
  ProjectTrustEvent,
  ProjectTrustEventDecision,
  ProjectTrustEventResult,
  ResourcesDiscoverEvent,
  ResourcesDiscoverResult,
} from "./internal/events/trust-resources.js";

/** Public direct-extension events composed from independent event domains. */
export interface ExtensionEventMap extends
  TrustResourceEventMap,
  SessionEventMap,
  ConversationEventMap,
  ProviderEventMap,
  InteractionEventMap,
  ToolEventMap {}

/** Handler result contracts keyed by the same public event names. */
export interface ExtensionEventResultMap extends
  TrustResourceEventResultMap,
  SessionEventResultMap,
  ConversationEventResultMap,
  ProviderEventResultMap,
  InteractionEventResultMap,
  ToolEventResultMap {}

export type ExtensionEvent = ExtensionEventMap[keyof ExtensionEventMap];

export type ProjectTrustHandler = (
  event: ProjectTrustEvent,
  context: ProjectTrustContext,
) => ProjectTrustEventResult | void | Promise<ProjectTrustEventResult | void>;

export type ExtensionHandler<K extends keyof ExtensionEventMap = keyof ExtensionEventMap> = (
  event: ExtensionEventMap[K],
  context: K extends "project_trust" ? ProjectTrustContext : ExtensionContext,
) => ExtensionEventResultMap[K] | Promise<ExtensionEventResultMap[K]>;
