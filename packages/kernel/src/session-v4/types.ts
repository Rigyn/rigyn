export const SESSION_V4_VERSION = 4 as const;
export const SESSION_V4_PRIMARY_BRANCH_ID = "main" as const;
export type SessionV4BranchId = typeof SESSION_V4_PRIMARY_BRANCH_ID;

export type SessionV4Json =
	| null
	| boolean
	| number
	| string
	| SessionV4Json[]
	| { [key: string]: SessionV4Json };

export interface SessionV4Parent {
	sessionId: string;
	originOperationId?: string;
	originToolEffectId?: string;
	purpose?: string;
}

export interface SessionV4Header {
	record: "session";
	version: typeof SESSION_V4_VERSION;
	sessionId: string;
	createdAt: string;
	workspace: string;
	cwd: string;
	parent?: SessionV4Parent;
}

export type SessionV4ConversationRole = "system" | "user" | "assistant" | "tool";

interface SessionV4ConversationNodeBase {
	id: string;
	parentId: string | null;
	createdAt: string;
	operationId?: string;
}

export interface SessionV4MessageNode extends SessionV4ConversationNodeBase {
	nodeType: "message";
	role: SessionV4ConversationRole;
	content: SessionV4Json;
}

export interface SessionV4ModelChangeNode extends SessionV4ConversationNodeBase {
	nodeType: "model_change";
	provider: string;
	model: string;
}

export type SessionV4ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface SessionV4ThinkingChangeNode extends SessionV4ConversationNodeBase {
	nodeType: "thinking_change";
	level: SessionV4ThinkingLevel;
}

export interface SessionV4ToolsChangeNode extends SessionV4ConversationNodeBase {
	nodeType: "tools_change";
	tools: string[];
	toolsetFingerprint: string;
}

export interface SessionV4CompactionNode extends SessionV4ConversationNodeBase {
	nodeType: "compaction";
	summary: SessionV4Json;
	retainedNodeIds: string[];
}

export interface SessionV4BranchSummaryNode extends SessionV4ConversationNodeBase {
	nodeType: "branch_summary";
	fromNodeId: string;
	toNodeId: string;
	summary: SessionV4Json;
}

export interface SessionV4ExtensionContextNode extends SessionV4ConversationNodeBase {
	nodeType: "extension_context";
	extensionId: string;
	context: SessionV4Json;
}

export interface SessionV4ExtensionStateNode extends SessionV4ConversationNodeBase {
	nodeType: "extension_state";
	extensionId: string;
	state: SessionV4Json;
}

export interface SessionV4ShellNode extends SessionV4ConversationNodeBase {
	nodeType: "shell";
	command: string;
	cwd: string;
	result: SessionV4Json;
}

export type SessionV4ConversationNode =
	| SessionV4MessageNode
	| SessionV4ModelChangeNode
	| SessionV4ThinkingChangeNode
	| SessionV4ToolsChangeNode
	| SessionV4CompactionNode
	| SessionV4BranchSummaryNode
	| SessionV4ExtensionContextNode
	| SessionV4ExtensionStateNode
	| SessionV4ShellNode;

export interface SessionV4ConversationNodeChange {
	type: "conversation_node";
	node: SessionV4ConversationNode;
}

export interface SessionV4HeadChange {
	type: "head";
	branchId: SessionV4BranchId;
	nodeId: string | null;
}

export interface SessionV4SessionNameChange {
	type: "session_name";
	name: string | null;
}

export interface SessionV4NodeLabelChange {
	type: "node_label";
	nodeId: string;
	label: string | null;
}

export interface SessionV4RunSelection {
	provider: string;
	model: string;
	api: string | null;
	thinkingLevel: SessionV4ThinkingLevel;
	toolNames: string[];
	toolsetFingerprint: string;
}

export interface SessionV4RunAcceptedChange {
	type: "run_accepted";
	branchId: SessionV4BranchId;
	operationId: string;
	promptNodeId: string | null;
	sourceHeadId: string | null;
	acceptedAt: string;
	request: SessionV4Json;
	selection: SessionV4RunSelection;
}

export interface SessionV4RunAttemptChange {
	type: "run_attempt";
	operationId: string;
	attemptId: string;
	step: number;
	attempt: number;
	task: string;
	startedAt: string;
}

export interface SessionV4RunStepSelectedChange {
	type: "run_step_selected";
	operationId: string;
	step: number;
	selectedAt: string;
	selection: SessionV4RunSelection;
}

export interface SessionV4RunCancelChange {
	type: "run_cancel";
	operationId: string;
	cancelId: string;
	requestedAt: string;
	reason?: string;
}

export interface SessionV4RunCheckpointChange {
	type: "run_checkpoint";
	operationId: string;
	checkpointId: string;
	createdAt: string;
	data: SessionV4Json;
}

export type SessionV4RunOutcome = "completed" | "failed" | "cancelled";

export interface SessionV4RunFinishedChange {
	type: "run_finished";
	operationId: string;
	finishedAt: string;
	outcome: SessionV4RunOutcome;
	detail?: SessionV4Json;
}

export type SessionV4QueueKind = "steering" | "follow_up" | "next_run";

export interface SessionV4QueueAddedChange {
	type: "queue_added";
	branchId: SessionV4BranchId;
	entryId: string;
	targetNodeId: string;
	kind: SessionV4QueueKind;
	addedAt: string;
	message: SessionV4Json;
}

export interface SessionV4QueueClaimedChange {
	type: "queue_claimed";
	branchId: SessionV4BranchId;
	entryId: string;
	operationId: string;
	claimedAt: string;
}

export type SessionV4QueueOutcome = "consumed" | "cancelled";

export interface SessionV4QueueFinishedChange {
	type: "queue_finished";
	branchId: SessionV4BranchId;
	entryId: string;
	finishedAt: string;
	outcome: SessionV4QueueOutcome;
}

export type SessionV4ToolEffectPolicy = "repeatable" | "reconcile" | "never_repeat";

export interface SessionV4ToolEffectPreparedChange {
	type: "tool_effect_prepared";
	effectId: string;
	operationId: string;
	invocationId: string;
	callId: string;
	toolName: string;
	policy: SessionV4ToolEffectPolicy;
	effectiveInput: SessionV4Json;
	inputHash: string;
	resultNodeId: string;
	step: number;
	index: number;
	assistantNodeId: string;
	toolsetFingerprint: string;
	preparedAt: string;
}

export interface SessionV4ToolEffectDispatchedChange {
	type: "tool_effect_dispatched";
	effectId: string;
	dispatchId: string;
	dispatchedAt: string;
}

export interface SessionV4ToolEffectInDoubtChange {
	type: "tool_effect_in_doubt";
	effectId: string;
	noticedAt: string;
	detail?: SessionV4Json;
}

export interface SessionV4ToolEffectRecoveryStartedChange {
	type: "tool_effect_recovery_started";
	effectId: string;
	recoveryId: string;
	startedAt: string;
}

export type SessionV4ToolEffectOutcome = "succeeded" | "failed";

export interface SessionV4ToolEffectFinishedChange {
	type: "tool_effect_finished";
	effectId: string;
	finishedAt: string;
	outcome: SessionV4ToolEffectOutcome;
	result?: SessionV4Json;
}

export type SessionV4ToolReconciliationOutcome = "succeeded" | "failed" | "not_applied";

export interface SessionV4ToolEffectReconciledChange {
	type: "tool_effect_reconciled";
	effectId: string;
	reconciliationId: string;
	resolvedAt: string;
	outcome: SessionV4ToolReconciliationOutcome;
	result?: SessionV4Json;
}

export type SessionV4ToolManualOutcome = "succeeded" | "failed" | "abandoned";

export interface SessionV4ToolEffectManuallyResolvedChange {
	type: "tool_effect_manually_resolved";
	effectId: string;
	resolutionId: string;
	resolvedAt: string;
	outcome: SessionV4ToolManualOutcome;
	result?: SessionV4Json;
}

export type SessionV4Change =
	| SessionV4ConversationNodeChange
	| SessionV4HeadChange
	| SessionV4SessionNameChange
	| SessionV4NodeLabelChange
	| SessionV4RunAcceptedChange
	| SessionV4RunStepSelectedChange
	| SessionV4RunAttemptChange
	| SessionV4RunCancelChange
	| SessionV4RunCheckpointChange
	| SessionV4RunFinishedChange
	| SessionV4QueueAddedChange
	| SessionV4QueueClaimedChange
	| SessionV4QueueFinishedChange
	| SessionV4ToolEffectPreparedChange
	| SessionV4ToolEffectDispatchedChange
	| SessionV4ToolEffectInDoubtChange
	| SessionV4ToolEffectRecoveryStartedChange
	| SessionV4ToolEffectFinishedChange
	| SessionV4ToolEffectReconciledChange
	| SessionV4ToolEffectManuallyResolvedChange;

export type SessionV4Changes = [SessionV4Change, ...SessionV4Change[]];

export interface SessionV4Commit {
	record: "commit";
	sequence: number;
	commitId: string;
	committedAt: string;
	changes: SessionV4Changes;
}

export interface SessionV4CommitDraft {
	commitId: string;
	committedAt: string;
	changes: SessionV4Changes;
}

export interface SessionV4OperationState {
	id: string;
	branchId: SessionV4BranchId;
	promptNodeId: string | null;
	sourceHeadId: string | null;
	acceptedAt: string;
	request: SessionV4Json;
	selection: SessionV4RunSelection;
	stepSelections: Array<{
		step: number;
		selectedAt: string;
		selection: SessionV4RunSelection;
	}>;
	attempts: Array<{
		id: string;
		step: number;
		attempt: number;
		task: string;
		startedAt: string;
	}>;
	cancel: { id: string; requestedAt: string; reason?: string } | null;
	checkpointIds: string[];
	status: "accepted" | "running" | "completed" | "failed" | "cancelled";
	finishedAt: string | null;
	detail?: SessionV4Json;
}

export interface SessionV4CheckpointState {
	id: string;
	operationId: string;
	createdAt: string;
	data: SessionV4Json;
}

export interface SessionV4QueueEntryState {
	id: string;
	branchId: SessionV4BranchId;
	targetNodeId: string;
	kind: SessionV4QueueKind;
	addedAt: string;
	message: SessionV4Json;
	status: "queued" | "claimed" | "consumed" | "cancelled";
	operationId: string | null;
	claimedAt: string | null;
	finishedAt: string | null;
}

export interface SessionV4ToolEffectState {
	id: string;
	operationId: string;
	invocationId: string;
	callId: string;
	toolName: string;
	policy: SessionV4ToolEffectPolicy;
	effectiveInput: SessionV4Json;
	inputHash: string;
	resultNodeId: string;
	step: number;
	index: number;
	assistantNodeId: string;
	toolsetFingerprint: string;
	preparedAt: string;
	status:
		| "prepared"
		| "dispatched"
		| "in_doubt"
		| "recovery_started"
		| "succeeded"
		| "failed"
		| "not_applied"
		| "abandoned";
	dispatchIds: string[];
	recoveryId: string | null;
	recoveryStartedAt: string | null;
	settlementId: string | null;
	cancelledById: string | null;
	lastDispatchedAt: string | null;
	inDoubtAt: string | null;
	inDoubtDetail?: SessionV4Json;
	finishedAt: string | null;
	result?: SessionV4Json;
}

export interface SessionV4BranchRuntimeState {
	id: SessionV4BranchId;
	headNodeId: string | null;
	openOperationId: string | null;
	pendingQueueEntryIds: Record<SessionV4QueueKind, string[]>;
}

export interface SessionV4State {
	header: SessionV4Header;
	sequence: number;
	name: string | null;
	labels: Map<string, string>;
	primaryBranchId: SessionV4BranchId;
	branches: Map<SessionV4BranchId, SessionV4BranchRuntimeState>;
	nodes: Map<string, SessionV4ConversationNode>;
	operations: Map<string, SessionV4OperationState>;
	checkpoints: Map<string, SessionV4CheckpointState>;
	queue: Map<string, SessionV4QueueEntryState>;
	toolEffects: Map<string, SessionV4ToolEffectState>;
	commits: Map<string, SessionV4Commit>;
}

export interface SessionV4ReadResult {
	state: SessionV4State;
	commits: SessionV4Commit[];
	commitRows: number;
	committedBytes: number;
	trailingBytes: number;
}

export type SessionV4CommitListener = (commit: SessionV4Commit, state: SessionV4State) => void;
