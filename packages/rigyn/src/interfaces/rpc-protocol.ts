import type { ImageBlock } from "../core/types.js";
import type { CompactionResult } from "../extensions/direct.js";
import type { SourceInfo } from "../core/source-info.js";
import type { ProviderModel, ProviderModelThinkingLevel } from "../providers/models.js";
import type { AgentSessionBashResult, AgentSessionStats } from "../service/agent-session.js";
import type { SessionContextMessage, SessionEntry, SessionTreeNode } from "../storage/types.js";

/** Commands accepted by the newline-delimited RPC mode. */
export type RpcCommand =
  | { id?: string; type: "prompt"; message: string; images?: ImageBlock[]; streamingBehavior?: "steer" | "followUp" }
  | { id?: string; type: "steer"; message: string; images?: ImageBlock[] }
  | { id?: string; type: "follow_up"; message: string; images?: ImageBlock[] }
  | { id?: string; type: "abort" }
  | { id?: string; type: "new_session"; parentSession?: string }
  | { id?: string; type: "get_state" }
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "cycle_model" }
  | { id?: string; type: "get_available_models" }
  | { id?: string; type: "set_thinking_level"; level: ProviderModelThinkingLevel }
  | { id?: string; type: "cycle_thinking_level" }
  | { id?: string; type: "get_available_thinking_levels" }
  | { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
  | { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
  | { id?: string; type: "compact"; customInstructions?: string }
  | { id?: string; type: "set_auto_compaction"; enabled: boolean }
  | { id?: string; type: "set_auto_retry"; enabled: boolean }
  | { id?: string; type: "abort_retry" }
  | { id?: string; type: "bash"; command: string; excludeFromContext?: boolean }
  | { id?: string; type: "abort_bash" }
  | { id?: string; type: "get_session_stats" }
  | { id?: string; type: "export_html"; outputPath?: string }
  | { id?: string; type: "switch_session"; sessionPath: string }
  | { id?: string; type: "fork"; entryId: string }
  | { id?: string; type: "clone" }
  | { id?: string; type: "get_fork_messages" }
  | { id?: string; type: "get_entries"; since?: string; afterSequence?: number; limit?: number }
  | { id?: string; type: "get_tree" }
  | { id?: string; type: "get_last_assistant_text" }
  | { id?: string; type: "set_session_name"; name: string }
  | { id?: string; type: "get_messages" }
  | { id?: string; type: "get_commands" };

export type RpcCommandType = RpcCommand["type"];

export interface RpcEntryPage {
  entries: SessionEntry[];
  leafId: string | null;
  /** One-based sequence of the first returned entry; equals nextSequence for an empty page. */
  sequenceStart: number;
  /** Append-order sequence to pass back as afterSequence for the next page. */
  nextSequence: number;
  hasMore: boolean;
  totalEntries: number;
}

export interface RpcSlashCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo: SourceInfo;
}

export interface RpcSessionState {
  model?: ProviderModel;
  thinkingLevel: ProviderModelThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

type Success<TCommand extends string, TData = never> = [TData] extends [never]
  ? { id?: string; type: "response"; command: TCommand; success: true }
  : { id?: string; type: "response"; command: TCommand; success: true; data: TData };

export type RpcResponse =
  | Success<"prompt">
  | Success<"steer">
  | Success<"follow_up">
  | Success<"abort">
  | Success<"new_session", { cancelled: boolean }>
  | Success<"get_state", RpcSessionState>
  | Success<"set_model", ProviderModel>
  | Success<"cycle_model", { model: ProviderModel; thinkingLevel: ProviderModelThinkingLevel; isScoped: boolean } | null>
  | Success<"get_available_models", { models: ProviderModel[] }>
  | Success<"set_thinking_level">
  | Success<"cycle_thinking_level", { level: ProviderModelThinkingLevel } | null>
  | Success<"get_available_thinking_levels", { levels: ProviderModelThinkingLevel[] }>
  | Success<"set_steering_mode">
  | Success<"set_follow_up_mode">
  | Success<"compact", CompactionResult>
  | Success<"set_auto_compaction">
  | Success<"set_auto_retry">
  | Success<"abort_retry">
  | Success<"bash", AgentSessionBashResult>
  | Success<"abort_bash">
  | Success<"get_session_stats", AgentSessionStats>
  | Success<"export_html", { path: string }>
  | Success<"switch_session", { cancelled: boolean }>
  | Success<"fork", { text: string; cancelled: boolean }>
  | Success<"clone", { cancelled: boolean }>
  | Success<"get_fork_messages", { messages: Array<{ entryId: string; text: string }> }>
  | Success<"get_entries", RpcEntryPage>
  | Success<"get_tree", { tree: SessionTreeNode[]; leafId: string | null }>
  | Success<"get_last_assistant_text", { text: string | null }>
  | Success<"set_session_name">
  | Success<"get_messages", { messages: SessionContextMessage[] }>
  | Success<"get_commands", { commands: RpcSlashCommand[] }>
  | { id?: string; type: "response"; command: string; success: false; error: string };

export type RpcExtensionUiRequest =
  | { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
  | { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText: string | undefined }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines: string[] | undefined;
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

export type RpcExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

export type RpcInputRecord = RpcCommand | RpcExtensionUiResponse;
