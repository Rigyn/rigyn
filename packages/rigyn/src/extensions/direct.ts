/**
 * Public direct-extension facade.
 *
 * Contracts are organized by capability so hosts can reason about tools,
 * commands, session control, lifecycle events, and provider/UI services
 * independently while retaining one stable import path.
 */
export * from "./capabilities/api.js";
export * from "./capabilities/commands.js";
export * from "./capabilities/events.js";
export * from "./capabilities/host.js";
export * from "./capabilities/provider.js";
export * from "./capabilities/rendering.js";
export * from "./capabilities/session.js";
export * from "./capabilities/tools.js";

export type {
  AgentMessage,
  AssistantMessageEvent,
  CustomMessage,
  ImageContent,
  TextContent,
  ToolResultMessage,
  Usage,
} from "@rigyn/kernel";
export type { SourceInfo } from "../core/source-info.js";
export type { SlashCommandInfo, SlashCommandSource } from "../core/slash-commands.js";
