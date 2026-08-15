import type { CustomMessage } from "@rigyn/kernel";

import type { BuildSystemPromptOptions } from "../../core/system-prompt.js";
import type { ExtensionSessionManager } from "../session-contract.js";
import type {
  CustomMessageDeliveryOptions,
  ExtensionContext,
  UserMessageDeliveryOptions,
} from "./host.js";

export interface ReplacementOptions {
  parentSession?: string;
  setup?(sessionManager: ExtensionSessionManager): void | Promise<void>;
  withSession?(context: ReplacedSessionContext): void | Promise<void>;
}

export interface ForkOptions {
  position?: "before" | "at";
  withSession?(context: ReplacedSessionContext): void | Promise<void>;
}

export interface NavigateTreeOptions {
  summarize?: boolean;
  customInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
}

export interface SwitchSessionOptions {
  withSession?(context: ReplacedSessionContext): void | Promise<void>;
}

interface ReplacedSessionMessaging {
  sendMessage<T = unknown>(
    message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
    options?: CustomMessageDeliveryOptions,
  ): Promise<void>;
  sendUserMessage(content: CustomMessage["content"], options?: UserMessageDeliveryOptions): Promise<void>;
}

/** Session-changing operations available only to command callbacks. */
export interface ExtensionCommandContext extends ExtensionContext {
  getSystemPromptOptions(): BuildSystemPromptOptions;
  waitForIdle(): Promise<void>;
  newSession(options?: ReplacementOptions): Promise<{ cancelled: boolean }>;
  fork(entryId: string, options?: ForkOptions): Promise<{ cancelled: boolean }>;
  navigateTree(targetId: string, options?: NavigateTreeOptions): Promise<{ cancelled: boolean }>;
  switchSession(sessionPath: string, options?: SwitchSessionOptions): Promise<{ cancelled: boolean }>;
  refresh(): Promise<void>;
}

export interface ReplacedSessionContext extends ExtensionCommandContext, ReplacedSessionMessaging {}

export interface ExtensionCommandContextActions {
  waitForIdle(signal?: AbortSignal): Promise<void>;
  newSession(options?: ReplacementOptions, signal?: AbortSignal): Promise<{ cancelled: boolean }>;
  fork(entryId: string, options?: ForkOptions, signal?: AbortSignal): Promise<{ cancelled: boolean }>;
  navigateTree(targetId: string, options?: NavigateTreeOptions, signal?: AbortSignal): Promise<{ cancelled: boolean }>;
  switchSession(sessionPath: string, options?: SwitchSessionOptions, signal?: AbortSignal): Promise<{ cancelled: boolean }>;
  refresh(signal?: AbortSignal): Promise<void>;
}

export type { BuildSystemPromptOptions } from "../../core/system-prompt.js";
export type {
  BranchSummaryEntry,
  CompactionEntry,
  CustomEntry,
  CustomMessageEntry,
  ExtensionSessionManager,
  FileEntry,
  ModelChangeEntry,
  PersistedSessionMessage,
  ReadonlyExtensionSessionManager,
  SessionBranchQuery,
  SessionContext,
  SessionEntry,
  SessionEntryBase,
  SessionHeader,
  SessionInfoEntry,
  SessionMessageEntry,
  SessionTreeNode,
  ThinkingLevelChangeEntry,
} from "../session-contract.js";
