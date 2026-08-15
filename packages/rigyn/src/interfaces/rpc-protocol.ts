import type { AgentMessage } from "@rigyn/kernel";
import type { Api, ImageContent, Model } from "@rigyn/models";

import type { SourceInfo } from "../core/source-info.js";
import type { CompactionResult } from "../extensions/direct.js";
import type { SessionEntry, SessionTreeNode } from "../extensions/session-contract.js";
import type { ProviderModelThinkingLevel } from "../providers/models.js";
import type {
	AgentSessionBashResult,
	AgentSessionRecoveryResult,
	AgentSessionStats,
	AgentSessionSuspendedRun,
	AgentSessionToolEffectResolution,
} from "../service/agent-session.js";

export type RpcRecoveryStatus = AgentSessionSuspendedRun;
export type RpcRecoveryResolution = AgentSessionToolEffectResolution;
export type RpcRecoveryResult = AgentSessionRecoveryResult;
export type RpcModel = Model<Api>;

type RpcCommandPayloads = {
	prompt: {
		message: string;
		images?: ImageContent[];
		streamingBehavior?: "steer" | "followUp";
	};
	steer: { message: string; images?: ImageContent[] };
	follow_up: { message: string; images?: ImageContent[] };
	abort: object;
	new_session: { parentSession?: string };
	get_state: object;
	get_recovery_status: object;
	recover_interrupted_run: { resolutions?: RpcRecoveryResolution[] };
	set_model: { provider: string; modelId: string };
	cycle_model: object;
	get_available_models: object;
	get_session_stats: object;
	export_html: { outputPath?: string };
	switch_session: { sessionPath: string };
	fork: { entryId: string };
	clone: object;
	get_fork_messages: object;
	abort_bash: object;
	bash: { command: string; excludeFromContext?: boolean };
	abort_retry: object;
	set_auto_retry: { enabled: boolean };
	set_auto_compaction: { enabled: boolean };
	compact: { customInstructions?: string };
	set_follow_up_mode: { mode: "all" | "one-at-a-time" };
	set_steering_mode: { mode: "all" | "one-at-a-time" };
	get_available_thinking_levels: object;
	cycle_thinking_level: object;
	set_thinking_level: { level: ProviderModelThinkingLevel };
	get_entries: { since?: string; afterSequence?: number; limit?: number };
	get_tree: { cursor?: string; limit?: number };
	get_last_assistant_text: object;
	set_session_name: { name: string };
	get_messages: { cursor?: string; limit?: number };
	get_commands: object;
};

type RpcCommandOf<K extends keyof RpcCommandPayloads> = {
	type: K;
	id?: string;
} & RpcCommandPayloads[K];

/** Commands accepted by the newline-delimited RPC mode. */
export type RpcCommand = {
	[K in keyof RpcCommandPayloads]: RpcCommandOf<K>;
}[keyof RpcCommandPayloads];

export type RpcCommandType = RpcCommand["type"];

/** Bounded incremental output for one correlated `bash` command. */
export interface RpcBashExecutionUpdate {
	type: "bash_execution_update";
	id?: string;
	delta: string;
	truncated?: true;
}

export interface RpcEntryPage {
	entries: SessionEntry[];
	leafId: string | null;
	sequenceStart: number;
	nextSequence: number;
	hasMore: boolean;
	totalEntries: number;
}

export interface RpcTreePage {
	tree: SessionTreeNode[];
	leafId: string | null;
	nextCursor: string | null;
	hasMore: boolean;
	totalEntries: number;
}

export interface RpcMessagePage {
	messages: AgentMessage[];
	nextCursor: string | null;
	hasMore: boolean;
	totalMessages: number;
}

export interface RpcSlashCommand {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
	sourceInfo: SourceInfo;
}

export interface RpcSessionState {
	isStreaming: boolean;
	isCompacting: boolean;
	pendingMessageCount: number;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionId: string;
	thinkingLevel: ProviderModelThinkingLevel;
	suspendedRun?: RpcRecoveryStatus;
	model?: RpcModel;
	sessionFile?: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
}

type RpcResponseData = {
	new_session: { cancelled: boolean };
	get_state: RpcSessionState;
	get_recovery_status: RpcRecoveryStatus | null;
	recover_interrupted_run: RpcRecoveryResult;
	set_model: RpcModel;
	cycle_model: {
		model: RpcModel;
		thinkingLevel: ProviderModelThinkingLevel;
		isScoped: boolean;
	} | null;
	get_available_models: { models: RpcModel[] };
	cycle_thinking_level: { level: ProviderModelThinkingLevel } | null;
	get_available_thinking_levels: { levels: ProviderModelThinkingLevel[] };
	compact: CompactionResult;
	bash: AgentSessionBashResult;
	get_session_stats: AgentSessionStats;
	export_html: { path: string };
	switch_session: { cancelled: boolean };
	fork: { text: string; cancelled: boolean };
	clone: { cancelled: boolean };
	get_fork_messages: { messages: Array<{ entryId: string; text: string }> };
	get_entries: RpcEntryPage;
	get_tree: RpcTreePage;
	get_last_assistant_text: { text: string | null };
	get_messages: RpcMessagePage;
	get_commands: { commands: RpcSlashCommand[] };
};

type RpcResponseWithoutData = Exclude<RpcCommandType, keyof RpcResponseData>;

type RpcSuccessWithData<K extends keyof RpcResponseData> = {
	type: "response";
	id?: string;
	command: K;
	success: true;
	data: RpcResponseData[K];
};

type RpcSuccessWithoutData<K extends RpcResponseWithoutData> = {
	type: "response";
	id?: string;
	command: K;
	success: true;
};

export type RpcResponse =
	| {
			[K in keyof RpcResponseData]: RpcSuccessWithData<K>;
	  }[keyof RpcResponseData]
	| {
			[K in RpcResponseWithoutData]: RpcSuccessWithoutData<K>;
	  }[RpcResponseWithoutData]
	| {
			id?: string;
			type: "response";
			command: string;
			success: false;
			error: string;
	  };

type ExtensionUiPayloads = {
	confirm: { title: string; message: string; timeout?: number };
	select: { title: string; options: string[]; timeout?: number };
	input: { title: string; placeholder?: string; timeout?: number };
	editor: { title: string; prefill?: string };
	notify: { message: string; notifyType?: "info" | "warning" | "error" };
	setStatus: { statusKey: string; statusText: string | undefined };
	setWidget: {
		widgetLines: string[] | undefined;
		widgetKey: string;
		widgetPlacement?: "aboveEditor" | "belowEditor";
	};
	setTitle: { title: string };
	set_editor_text: { text: string };
};

export type RpcExtensionUiRequest = {
	[K in keyof ExtensionUiPayloads]: {
		type: "extension_ui_request";
		id: string;
		method: K;
	} & ExtensionUiPayloads[K];
}[keyof ExtensionUiPayloads];

export interface RpcExtensionErrorEvent {
	type: "extension_error";
	extensionPath: string;
	event: string;
	error: string;
}

type RpcExtensionUiReply<TPayload extends object> = {
	type: "extension_ui_response";
	id: string;
} & TPayload;

export type RpcExtensionUiResponse =
	| RpcExtensionUiReply<{ value: string }>
	| RpcExtensionUiReply<{ confirmed: boolean }>
	| RpcExtensionUiReply<{ cancelled: true }>;

export type RpcInputRecord = RpcCommand | RpcExtensionUiResponse;
