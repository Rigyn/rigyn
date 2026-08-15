import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
	SessionV4BranchId,
	SessionV4Change,
	SessionV4Commit,
	SessionV4ConversationNode,
	SessionV4Header,
	SessionV4Json,
	SessionV4OperationState,
	SessionV4State,
	SessionV4ToolEffectState,
} from "./types.js";
import {
	parseSessionV4Commit,
	parseSessionV4Header,
	SessionV4ValidationError,
} from "./validate.js";

function invalid(message: string): never {
	throw new SessionV4ValidationError(message);
}

function cloneState(state: SessionV4State): SessionV4State {
	return structuredClone(state);
}

type SessionV4IdOwner =
	| "conversation node"
	| "operation"
	| "checkpoint"
	| "queue entry"
	| "tool effect"
	| "operation prompt node"
	| "run attempt"
	| "cancellation"
	| "queue target node"
	| "tool result node"
	| "tool invocation"
	| "tool dispatch"
	| "tool recovery"
	| "tool settlement";

interface SessionV4DerivedIndexes {
	idOwners: Map<string, Set<SessionV4IdOwner>>;
	queueEntryByTargetNodeId: Map<string, string>;
	operationByPromptNodeId: Map<string, string>;
	toolEffectsByResultNodeId: Map<string, Set<string>>;
	queueEntriesByOperationId: Map<string, Set<string>>;
	toolEffectsByOperationId: Map<string, Set<string>>;
	toolCallIdsByOperationId: Map<string, Set<string>>;
}

const ID_OWNER_PRIORITY: readonly SessionV4IdOwner[] = [
	"conversation node",
	"operation",
	"checkpoint",
	"queue entry",
	"tool effect",
	"operation prompt node",
	"run attempt",
	"cancellation",
	"queue target node",
	"tool result node",
	"tool invocation",
	"tool dispatch",
	"tool recovery",
	"tool settlement",
];

const derivedIndexes = new WeakMap<SessionV4State, SessionV4DerivedIndexes>();

function emptyIndexes(): SessionV4DerivedIndexes {
	return {
		idOwners: new Map(),
		queueEntryByTargetNodeId: new Map(),
		operationByPromptNodeId: new Map(),
		toolEffectsByResultNodeId: new Map(),
		queueEntriesByOperationId: new Map(),
		toolEffectsByOperationId: new Map(),
		toolCallIdsByOperationId: new Map(),
	};
}

function addSetValue<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
	const current = map.get(key);
	if (current === undefined) map.set(key, new Set([value]));
	else current.add(value);
}

function addOwner(indexes: SessionV4DerivedIndexes, id: string, owner: SessionV4IdOwner): void {
	addSetValue(indexes.idOwners, id, owner);
}

function buildIndexes(state: SessionV4State): SessionV4DerivedIndexes {
	const indexes = emptyIndexes();
	for (const node of state.nodes.values()) addOwner(indexes, node.id, "conversation node");
	for (const operation of state.operations.values()) {
		addOwner(indexes, operation.id, "operation");
		if (operation.promptNodeId !== null) {
			addOwner(indexes, operation.promptNodeId, "operation prompt node");
			indexes.operationByPromptNodeId.set(operation.promptNodeId, operation.id);
		}
		for (const attempt of operation.attempts) addOwner(indexes, attempt.id, "run attempt");
		if (operation.cancel !== null) addOwner(indexes, operation.cancel.id, "cancellation");
	}
	for (const checkpoint of state.checkpoints.values()) addOwner(indexes, checkpoint.id, "checkpoint");
	for (const entry of state.queue.values()) {
		addOwner(indexes, entry.id, "queue entry");
		addOwner(indexes, entry.targetNodeId, "queue target node");
		indexes.queueEntryByTargetNodeId.set(entry.targetNodeId, entry.id);
		if (entry.operationId !== null) {
			addSetValue(indexes.queueEntriesByOperationId, entry.operationId, entry.id);
		}
	}
	for (const effect of state.toolEffects.values()) {
		addOwner(indexes, effect.id, "tool effect");
		addOwner(indexes, effect.invocationId, "tool invocation");
		addOwner(indexes, effect.resultNodeId, "tool result node");
		for (const dispatchId of effect.dispatchIds) addOwner(indexes, dispatchId, "tool dispatch");
		if (effect.recoveryId !== null) addOwner(indexes, effect.recoveryId, "tool recovery");
		if (effect.settlementId !== null) addOwner(indexes, effect.settlementId, "tool settlement");
		addSetValue(indexes.toolEffectsByResultNodeId, effect.resultNodeId, effect.id);
		addSetValue(indexes.toolEffectsByOperationId, effect.operationId, effect.id);
		addSetValue(indexes.toolCallIdsByOperationId, effect.operationId, effect.callId);
	}
	return indexes;
}

function indexesFor(state: SessionV4State): SessionV4DerivedIndexes {
	const existing = derivedIndexes.get(state);
	if (existing !== undefined) return existing;
	const indexes = buildIndexes(state);
	derivedIndexes.set(state, indexes);
	return indexes;
}

class SessionV4MutationJournal {
	readonly #undo: Array<() => void> = [];
	readonly #editedObjects = new WeakSet<object>();
	#settled = false;

	edit<T extends object>(value: T): T {
		if (this.#editedObjects.has(value)) return value;
		this.#editedObjects.add(value);
		const before = structuredClone(value);
		this.#undo.push(() => {
			for (const key of Reflect.ownKeys(value)) {
				delete (value as Record<PropertyKey, unknown>)[key];
			}
			Object.assign(value, before);
		});
		return value;
	}

	setProperty<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): void {
		const had = Object.hasOwn(target, key);
		const before = target[key];
		target[key] = value;
		this.#undo.push(() => {
			if (had) target[key] = before;
			else delete target[key];
		});
	}

	mapSet<K, V>(map: Map<K, V>, key: K, value: V): void {
		const had = map.has(key);
		const before = map.get(key);
		map.set(key, value);
		this.#undo.push(() => {
			if (had) map.set(key, before as V);
			else map.delete(key);
		});
	}

	mapDelete<K, V>(map: Map<K, V>, key: K): void {
		const had = map.has(key);
		const before = map.get(key);
		map.delete(key);
		this.#undo.push(() => {
			if (had) map.set(key, before as V);
		});
	}

	addSetValue<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
		const current = map.get(key);
		if (current === undefined) {
			this.mapSet(map, key, new Set([value]));
			return;
		}
		if (current.has(value)) return;
		current.add(value);
		this.#undo.push(() => current.delete(value));
	}

	commit(): void {
		this.#settled = true;
		this.#undo.length = 0;
	}

	rollback(): void {
		if (this.#settled) return;
		this.#settled = true;
		for (const undo of this.#undo.toReversed()) undo();
		this.#undo.length = 0;
	}
}

function journalOwner(
	journal: SessionV4MutationJournal,
	indexes: SessionV4DerivedIndexes,
	id: string,
	owner: SessionV4IdOwner,
): void {
	journal.addSetValue(indexes.idOwners, id, owner);
}

function canonicalJson(value: SessionV4Json): string {
	if (value === null) return "null";
	if (typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as SessionV4Json)}`)
		.join(",")}}`;
}

/**
 * Returns the lowercase hexadecimal SHA-256 digest of canonical JSON.
 * Object keys are sorted recursively; array order is preserved.
 */
export function sessionV4JsonHash(value: SessionV4Json): string {
	return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function sessionV4ToolInputHash(input: SessionV4Json): string {
	return sessionV4JsonHash(input);
}

export function createSessionV4State(header: SessionV4Header): SessionV4State {
	const state: SessionV4State = {
		header: parseSessionV4Header(header),
		sequence: 0,
		name: null,
		labels: new Map(),
		primaryBranchId: "main",
		branches: new Map([
			[
				"main",
				{
					id: "main",
					headNodeId: null,
					openOperationId: null,
					pendingQueueEntryIds: {
						steering: [],
						follow_up: [],
						next_run: [],
					},
				},
			],
		]),
		nodes: new Map(),
		operations: new Map(),
		checkpoints: new Map(),
		queue: new Map(),
		toolEffects: new Map(),
		commits: new Map(),
	};
	derivedIndexes.set(state, emptyIndexes());
	return state;
}

export function cloneSessionV4State(state: SessionV4State): SessionV4State {
	return cloneState(state);
}

function createdIdOwner(
	state: SessionV4State,
	candidate: string,
	ignoreToolResultReservations = false,
): string | null {
	const owners = indexesFor(state).idOwners.get(candidate);
	if (owners === undefined) return null;
	for (const owner of ID_OWNER_PRIORITY) {
		if (ignoreToolResultReservations && owner === "tool result node") continue;
		if (owners.has(owner)) return owner;
	}
	return null;
}

function assertFreshId(state: SessionV4State, candidate: string, description: string): void {
	const owner = createdIdOwner(state, candidate);
	if (owner !== null) invalid(`${description} id ${JSON.stringify(candidate)} is already used by a ${owner}`);
}

function requireNode(state: SessionV4State, nodeId: string, description: string): SessionV4ConversationNode {
	const node = state.nodes.get(nodeId);
	if (node === undefined) invalid(`${description} references unknown node ${JSON.stringify(nodeId)}`);
	return node;
}

function requireBranch(state: SessionV4State, branchId: SessionV4BranchId) {
	const branch = state.branches.get(branchId);
	if (branch === undefined) invalid(`branch ${JSON.stringify(branchId)} does not exist`);
	return branch;
}

function ancestryToAncestor(
	state: SessionV4State,
	startNodeId: string | null,
	ancestorNodeId: string | null,
	description: string,
	operationId?: string,
): string[] {
	const path: string[] = [];
	const visited = new Set<string>();
	let nodeId = startNodeId;
	while (nodeId !== ancestorNodeId) {
		if (nodeId === null) invalid(`${description} must descend from ${JSON.stringify(ancestorNodeId)}`);
		if (visited.has(nodeId)) invalid(`${description} contains an ancestry cycle`);
		visited.add(nodeId);
		const node = requireNode(state, nodeId, description);
		if (operationId !== undefined && node.operationId !== operationId) {
			const actualOwner = node.operationId === undefined
				? "no operation"
				: `operation ${JSON.stringify(node.operationId)}`;
			invalid(
				`${description} may traverse only nodes from operation ${JSON.stringify(operationId)}; `
				+ `encountered node ${JSON.stringify(node.id)} (${node.nodeType}) owned by ${actualOwner}`,
			);
		}
		path.push(nodeId);
		nodeId = node.parentId;
	}
	return path;
}

function assertDescendantOrEqual(
	state: SessionV4State,
	descendantNodeId: string,
	ancestorNodeId: string,
	description: string,
): void {
	if (descendantNodeId === ancestorNodeId) return;
	ancestryToAncestor(state, descendantNodeId, ancestorNodeId, description);
}

function clearInDoubtDiagnostic(effect: SessionV4ToolEffectState): void {
	effect.inDoubtAt = null;
	delete effect.inDoubtDetail;
}

function requireOpenOperation(state: SessionV4State, operationId: string): SessionV4OperationState {
	const operation = state.operations.get(operationId);
	if (operation === undefined) invalid(`operation ${JSON.stringify(operationId)} does not exist`);
	const branch = requireBranch(state, operation.branchId);
	if (branch.openOperationId !== operationId) {
		invalid(`operation ${JSON.stringify(operationId)} is not the open operation`);
	}
	return operation;
}

function isToolEffectTerminal(status: SessionV4ToolEffectState["status"]): boolean {
	return status === "succeeded" || status === "failed" || status === "not_applied" || status === "abandoned";
}

function addConversationNode(
	state: SessionV4State,
	node: SessionV4ConversationNode,
	journal: SessionV4MutationJournal,
	indexes: SessionV4DerivedIndexes,
): void {
	const queueEntryId = indexes.queueEntryByTargetNodeId.get(node.id);
	const queueReservation = queueEntryId === undefined ? undefined : state.queue.get(queueEntryId);
	const toolReservations = [...(indexes.toolEffectsByResultNodeId.get(node.id) ?? [])]
		.flatMap((effectId) => {
			const effect = state.toolEffects.get(effectId);
			return effect === undefined ? [] : [effect];
		});
	const promptOperationId = indexes.operationByPromptNodeId.get(node.id);
	const promptReservation = promptOperationId === undefined ? undefined : state.operations.get(promptOperationId);
	if (queueReservation === undefined && toolReservations.length === 0 && promptReservation === undefined) {
		assertFreshId(state, node.id, "conversation node");
	} else if (state.nodes.has(node.id)) {
		invalid(`conversation node id ${JSON.stringify(node.id)} is already used`);
	}
	if (node.parentId !== null) requireNode(state, node.parentId, "conversation node parent");
	if (node.operationId !== undefined) requireOpenOperation(state, node.operationId);

	switch (node.nodeType) {
		case "compaction": {
			for (const retainedNodeId of node.retainedNodeIds) {
				requireNode(state, retainedNodeId, "compaction retained node");
			}
			if (node.retainedNodeIds.length > 0) {
				if (node.parentId === null) invalid("a root compaction node cannot retain conversation nodes");
				let previousRetainedNodeId = node.retainedNodeIds[0] as string;
				assertDescendantOrEqual(
					state,
					node.parentId,
					previousRetainedNodeId,
					"compaction parent",
				);
				for (const retainedNodeId of node.retainedNodeIds.slice(1)) {
					assertDescendantOrEqual(
						state,
						retainedNodeId,
						previousRetainedNodeId,
						"compaction retained range",
					);
					assertDescendantOrEqual(state, node.parentId, retainedNodeId, "compaction parent");
					previousRetainedNodeId = retainedNodeId;
				}
			}
			break;
		}
		case "branch_summary":
			requireNode(state, node.fromNodeId, "branch summary start");
			requireNode(state, node.toNodeId, "branch summary end");
			if (node.parentId !== node.fromNodeId) {
				invalid("branch summary parent must equal its range start");
			}
			assertDescendantOrEqual(
				state,
				node.toNodeId,
				node.fromNodeId,
				"branch summary range end",
			);
			break;
		case "message":
		case "model_change":
		case "thinking_change":
		case "tools_change":
		case "extension_context":
		case "extension_state":
		case "shell":
			break;
	}

	if (queueReservation !== undefined) {
		if (
			(node.nodeType !== "message" || node.role !== "user")
			&& node.nodeType !== "extension_context"
		) {
			invalid(`queue target node ${JSON.stringify(node.id)} must be a user message or extension context`);
		}
		if (queueReservation.status !== "claimed" || queueReservation.operationId === null) {
			invalid(`queue target node ${JSON.stringify(node.id)} must be claimed before materialization`);
		}
		if (node.operationId !== queueReservation.operationId) {
			invalid(`queue target node ${JSON.stringify(node.id)} must belong to its claiming operation`);
		}
	}
	for (const toolReservation of toolReservations) {
		if (node.nodeType !== "message" || node.role !== "tool") {
			invalid(`tool result node ${JSON.stringify(node.id)} must be a tool message`);
		}
		if (node.operationId !== toolReservation.operationId) {
			invalid(`tool result node ${JSON.stringify(node.id)} must belong to its operation`);
		}
	}
	if (toolReservations.length > 0) {
		const [firstReservation] = toolReservations;
		if (
			firstReservation === undefined ||
			toolReservations.some((reservation) =>
				reservation.operationId !== firstReservation.operationId ||
				reservation.step !== firstReservation.step ||
				reservation.assistantNodeId !== firstReservation.assistantNodeId ||
				reservation.toolsetFingerprint !== firstReservation.toolsetFingerprint
			)
		) {
			invalid("shared tool result reservations must agree on their operation, step, assistant, and toolset");
		}
		ancestryToAncestor(
			state,
			node.parentId,
			firstReservation.assistantNodeId,
			`tool result node ${JSON.stringify(node.id)}`,
			firstReservation.operationId,
		);
	}
	if (promptReservation !== undefined) {
		if (
			(node.nodeType !== "message" || node.role !== "user")
			&& !(queueReservation !== undefined && node.nodeType === "extension_context")
		) {
			invalid(`operation prompt node ${JSON.stringify(node.id)} must be a user message or queued extension context`);
		}
		let ancestorId = node.parentId;
		while (ancestorId !== promptReservation.sourceHeadId) {
			if (ancestorId === null) {
				invalid(`operation prompt node ${JSON.stringify(node.id)} must descend from its source head`);
			}
			const ancestor = requireNode(state, ancestorId, "operation prompt ancestor");
			if (ancestor.operationId !== promptReservation.id) {
				invalid(`operation prompt node ${JSON.stringify(node.id)} may traverse only nodes from its operation`);
			}
			ancestorId = ancestor.parentId;
		}
		if (node.operationId !== promptReservation.id) {
			invalid(`operation prompt node ${JSON.stringify(node.id)} must belong to its operation`);
		}
	}
	journal.mapSet(state.nodes, node.id, node);
	journalOwner(journal, indexes, node.id, "conversation node");
}

function applyRunAccepted(
	state: SessionV4State,
	change: Extract<SessionV4Change, { type: "run_accepted" }>,
	journal: SessionV4MutationJournal,
	indexes: SessionV4DerivedIndexes,
): void {
	const branch = requireBranch(state, change.branchId);
	const openOperationId = [...state.branches.values()].find((candidate) => candidate.openOperationId !== null)
		?.openOperationId;
	if (openOperationId !== undefined && openOperationId !== null) {
		invalid(`operation ${JSON.stringify(openOperationId)} is already open`);
	}
	assertFreshId(state, change.operationId, "operation");
	if (change.operationId === change.promptNodeId) invalid("operation and prompt node ids must differ");
	if (branch.headNodeId !== change.sourceHeadId) invalid("run source head must equal the current branch head");
	if (change.sourceHeadId !== null) requireNode(state, change.sourceHeadId, "run source head");
	if (change.promptNodeId !== null) {
		const queueEntryId = indexes.queueEntryByTargetNodeId.get(change.promptNodeId);
		const queueReservation = queueEntryId === undefined ? undefined : state.queue.get(queueEntryId);
		if (queueReservation === undefined) {
			assertFreshId(state, change.promptNodeId, "operation prompt node");
		} else if (queueReservation.status !== "queued" || queueReservation.branchId !== change.branchId) {
			invalid("a queued operation prompt must be pending on the operation branch");
		}
		if (state.nodes.has(change.promptNodeId)) invalid("operation prompt node must not exist before run acceptance");
	}
	journal.mapSet(state.operations, change.operationId, {
		id: change.operationId,
		branchId: change.branchId,
		promptNodeId: change.promptNodeId,
		sourceHeadId: change.sourceHeadId,
		acceptedAt: change.acceptedAt,
		request: change.request,
		selection: change.selection,
		stepSelections: [],
		attempts: [],
		cancel: null,
		checkpointIds: [],
		status: "accepted",
		finishedAt: null,
	});
	journalOwner(journal, indexes, change.operationId, "operation");
	if (change.promptNodeId !== null) {
		journalOwner(journal, indexes, change.promptNodeId, "operation prompt node");
		journal.mapSet(indexes.operationByPromptNodeId, change.promptNodeId, change.operationId);
	}
	journal.edit(branch);
	branch.openOperationId = change.operationId;
}

function applyRunStepSelected(
	state: SessionV4State,
	change: Extract<SessionV4Change, { type: "run_step_selected" }>,
	journal: SessionV4MutationJournal,
): void {
	const operation = requireOpenOperation(state, change.operationId);
	if (operation.cancel !== null) invalid("a run step cannot be selected after cancellation");
	const expectedStep = operation.stepSelections.length;
	if (change.step !== expectedStep) {
		invalid(`the next selected run step must be ${expectedStep}`);
	}
	if (change.step === 0) {
		if (!isDeepStrictEqual(change.selection, operation.selection)) {
			invalid("the first run step selection must match the accepted run selection");
		}
	} else {
		const latestAttempt = operation.attempts.at(-1);
		if (latestAttempt === undefined || latestAttempt.step !== change.step - 1) {
			invalid("a later run step may be selected only after the preceding step was attempted");
		}
	}
	journal.edit(operation);
	operation.stepSelections.push({
		step: change.step,
		selectedAt: change.selectedAt,
		selection: change.selection,
	});
}

function applyRunAttempt(
	state: SessionV4State,
	change: Extract<SessionV4Change, { type: "run_attempt" }>,
	journal: SessionV4MutationJournal,
	indexes: SessionV4DerivedIndexes,
): void {
	const operation = requireOpenOperation(state, change.operationId);
	if (operation.cancel !== null) invalid("a run attempt cannot start after cancellation");
	assertFreshId(state, change.attemptId, "run attempt");
	const selectedStep = operation.stepSelections.at(-1);
	if (selectedStep === undefined || selectedStep.step !== change.step) {
		invalid("a run attempt requires its current step selection");
	}
	const previous = operation.attempts.at(-1);
	if (previous === undefined) {
		if (change.step !== 0 || change.attempt !== 1) invalid("the first run attempt must be step 0, attempt 1");
	} else if (change.step === previous.step) {
		if (change.attempt !== previous.attempt + 1) invalid("a retry must increment the attempt number");
	} else if (change.step === previous.step + 1) {
		if (change.attempt !== 1) invalid("a new step must start at attempt 1");
	} else {
		invalid("run steps must be contiguous");
	}
	journal.edit(operation);
	operation.attempts.push({
		id: change.attemptId,
		step: change.step,
		attempt: change.attempt,
		task: change.task,
		startedAt: change.startedAt,
	});
	operation.status = "running";
	journalOwner(journal, indexes, change.attemptId, "run attempt");
}

function applyRunCancel(
	state: SessionV4State,
	change: Extract<SessionV4Change, { type: "run_cancel" }>,
	journal: SessionV4MutationJournal,
	indexes: SessionV4DerivedIndexes,
): void {
	const operation = requireOpenOperation(state, change.operationId);
	if (operation.cancel !== null) invalid("an operation may record only one cancellation request");
	assertFreshId(state, change.cancelId, "cancellation");
	journal.edit(operation);
	operation.cancel = {
		id: change.cancelId,
		requestedAt: change.requestedAt,
		...(change.reason === undefined ? {} : { reason: change.reason }),
	};
	journalOwner(journal, indexes, change.cancelId, "cancellation");
	for (const effectId of indexes.toolEffectsByOperationId.get(operation.id) ?? []) {
		const effect = state.toolEffects.get(effectId);
		if (effect === undefined || effect.status !== "prepared") continue;
		journal.edit(effect);
		effect.status = "not_applied";
		effect.cancelledById = change.cancelId;
		effect.finishedAt = change.requestedAt;
		clearInDoubtDiagnostic(effect);
		delete effect.result;
	}
}

function applyRunCheckpoint(
	state: SessionV4State,
	change: Extract<SessionV4Change, { type: "run_checkpoint" }>,
	journal: SessionV4MutationJournal,
	indexes: SessionV4DerivedIndexes,
): void {
	const operation = requireOpenOperation(state, change.operationId);
	assertFreshId(state, change.checkpointId, "checkpoint");
	journal.mapSet(state.checkpoints, change.checkpointId, {
		id: change.checkpointId,
		operationId: change.operationId,
		createdAt: change.createdAt,
		data: change.data,
	});
	journal.edit(operation);
	operation.checkpointIds.push(change.checkpointId);
	journalOwner(journal, indexes, change.checkpointId, "checkpoint");
}

function applyRunFinished(
	state: SessionV4State,
	change: Extract<SessionV4Change, { type: "run_finished" }>,
	journal: SessionV4MutationJournal,
	indexes: SessionV4DerivedIndexes,
): void {
	const operation = requireOpenOperation(state, change.operationId);
	const branch = requireBranch(state, operation.branchId);
	if (change.outcome === "completed" && operation.cancel !== null) {
		invalid("a cancelled operation cannot finish as completed");
	}
	if (change.outcome === "cancelled" && operation.cancel === null) {
		invalid("an operation may finish as cancelled only after a cancellation request");
	}
	if (operation.promptNodeId !== null && !state.nodes.has(operation.promptNodeId)) {
		invalid(`operation ${JSON.stringify(operation.id)} is missing its prompt node`);
	}
	const operationPath = ancestryToAncestor(
		state,
		branch.headNodeId,
		operation.sourceHeadId,
		`operation ${JSON.stringify(operation.id)} branch head`,
		operation.id,
	);
	if (operation.promptNodeId !== null && !operationPath.includes(operation.promptNodeId)) {
		invalid(`operation ${JSON.stringify(operation.id)} branch head must include its prompt node`);
	}
	for (const entryId of indexes.queueEntriesByOperationId.get(operation.id) ?? []) {
		const entry = state.queue.get(entryId);
		if (entry?.status === "claimed") {
			invalid(`queue entry ${JSON.stringify(entry.id)} must finish before its operation`);
		}
	}
	for (const effectId of indexes.toolEffectsByOperationId.get(operation.id) ?? []) {
		const effect = state.toolEffects.get(effectId);
		if (effect === undefined) continue;
		if (!isToolEffectTerminal(effect.status)) {
			invalid(`tool effect ${JSON.stringify(effect.id)} must finish before its operation`);
		}
		if (
			(effect.status === "succeeded" || effect.status === "failed")
			&& !Object.hasOwn(effect, "result")
		) {
			invalid(`tool effect ${JSON.stringify(effect.id)} must persist its result before its operation finishes`);
		}
		if (!state.nodes.has(effect.resultNodeId)) {
			invalid(`tool effect ${JSON.stringify(effect.id)} is missing its result node`);
		}
	}
	journal.edit(operation);
	operation.status = change.outcome;
	operation.finishedAt = change.finishedAt;
	if (change.detail === undefined) delete operation.detail;
	else operation.detail = change.detail;
	journal.edit(branch);
	branch.openOperationId = null;
}

function applyQueueAdded(
	state: SessionV4State,
	change: Extract<SessionV4Change, { type: "queue_added" }>,
	journal: SessionV4MutationJournal,
	indexes: SessionV4DerivedIndexes,
): void {
	const branch = requireBranch(state, change.branchId);
	assertFreshId(state, change.entryId, "queue entry");
	assertFreshId(state, change.targetNodeId, "queue target node");
	if (change.entryId === change.targetNodeId) invalid("queue entry and target node ids must differ");
	journal.mapSet(state.queue, change.entryId, {
		id: change.entryId,
		branchId: change.branchId,
		targetNodeId: change.targetNodeId,
		kind: change.kind,
		addedAt: change.addedAt,
		message: change.message,
		status: "queued",
		operationId: null,
		claimedAt: null,
		finishedAt: null,
	});
	journalOwner(journal, indexes, change.entryId, "queue entry");
	journalOwner(journal, indexes, change.targetNodeId, "queue target node");
	journal.mapSet(indexes.queueEntryByTargetNodeId, change.targetNodeId, change.entryId);
	journal.edit(branch);
	branch.pendingQueueEntryIds[change.kind].push(change.entryId);
}

function applyQueueClaimed(
	state: SessionV4State,
	change: Extract<SessionV4Change, { type: "queue_claimed" }>,
	journal: SessionV4MutationJournal,
	indexes: SessionV4DerivedIndexes,
): void {
	const operation = requireOpenOperation(state, change.operationId);
	if (operation.branchId !== change.branchId) invalid("queue claim branch must match its operation");
	const entry = state.queue.get(change.entryId);
	if (entry === undefined) invalid(`queue entry ${JSON.stringify(change.entryId)} does not exist`);
	if (entry.branchId !== change.branchId) invalid("queue claim branch must match its entry");
	if (entry.status !== "queued") invalid(`queue entry ${JSON.stringify(change.entryId)} is not queued`);
	const promptOwnerId = indexes.operationByPromptNodeId.get(entry.targetNodeId);
	const promptOwner = promptOwnerId === undefined ? undefined : state.operations.get(promptOwnerId);
	if (promptOwner !== undefined && promptOwner.id !== change.operationId) {
		invalid(`queue entry ${JSON.stringify(entry.id)} is reserved by a different operation`);
	}
	const branch = requireBranch(state, change.branchId);
	if (branch.pendingQueueEntryIds[entry.kind][0] !== entry.id) {
		invalid(`queue entry ${JSON.stringify(entry.id)} is not first in its branch queue`);
	}
	journal.edit(entry);
	entry.status = "claimed";
	entry.operationId = change.operationId;
	entry.claimedAt = change.claimedAt;
	journal.addSetValue(indexes.queueEntriesByOperationId, change.operationId, entry.id);
}

function applyQueueFinished(
	state: SessionV4State,
	change: Extract<SessionV4Change, { type: "queue_finished" }>,
	journal: SessionV4MutationJournal,
): void {
	const branch = requireBranch(state, change.branchId);
	const entry = state.queue.get(change.entryId);
	if (entry === undefined) invalid(`queue entry ${JSON.stringify(change.entryId)} does not exist`);
	if (entry.branchId !== change.branchId) invalid("queue finish branch must match its entry");
	if (change.outcome === "consumed" && entry.status !== "claimed") {
		invalid("only a claimed queue entry may be consumed");
	}
	if (change.outcome === "cancelled" && entry.status !== "queued" && entry.status !== "claimed") {
		invalid("only a queued or claimed queue entry may be cancelled");
	}
	if (change.outcome === "consumed" && !state.nodes.has(entry.targetNodeId)) {
		invalid(`queue entry ${JSON.stringify(entry.id)} is missing its target node`);
	}
	if (change.outcome === "consumed") {
		if (entry.operationId === null) invalid("a consumed queue entry must belong to an operation");
		const target = requireNode(state, entry.targetNodeId, "queue target node");
		if (target.operationId !== entry.operationId) {
			invalid(`queue entry ${JSON.stringify(entry.id)} target belongs to a different operation`);
		}
	}
	journal.edit(entry);
	entry.status = change.outcome;
	entry.finishedAt = change.finishedAt;
	journal.edit(branch);
	const pending = branch.pendingQueueEntryIds[entry.kind];
	const pendingIndex = pending.indexOf(entry.id);
	if (pendingIndex < 0) invalid(`queue entry ${JSON.stringify(entry.id)} is not pending`);
	pending.splice(pendingIndex, 1);
}

function applyToolPrepared(
	state: SessionV4State,
	change: Extract<SessionV4Change, { type: "tool_effect_prepared" }>,
	journal: SessionV4MutationJournal,
	indexes: SessionV4DerivedIndexes,
): void {
	const operation = requireOpenOperation(state, change.operationId);
	if (operation.cancel !== null) invalid("a tool effect cannot be prepared after cancellation");
	if (indexes.toolCallIdsByOperationId.get(change.operationId)?.has(change.callId) === true) {
		invalid(
			`tool call id ${JSON.stringify(change.callId)} is already prepared for operation `
			+ JSON.stringify(change.operationId),
		);
	}
	assertFreshId(state, change.effectId, "tool effect");
	assertFreshId(state, change.invocationId, "tool invocation");
	const sharedResultReservations = [...(indexes.toolEffectsByResultNodeId.get(change.resultNodeId) ?? [])]
		.flatMap((effectId) => {
			const effect = state.toolEffects.get(effectId);
			return effect === undefined ? [] : [effect];
		});
	if (sharedResultReservations.length === 0) {
		assertFreshId(state, change.resultNodeId, "tool result node");
	} else {
		const otherOwner = createdIdOwner(state, change.resultNodeId, true);
		if (otherOwner !== null) {
			invalid(`tool result node id ${JSON.stringify(change.resultNodeId)} is already used by a ${otherOwner}`);
		}
		if (sharedResultReservations.some((effect) =>
			effect.operationId !== change.operationId ||
			effect.step !== change.step ||
			effect.assistantNodeId !== change.assistantNodeId
		)) {
			invalid("a shared tool result node must belong to the same operation, step, and assistant message");
		}
		if (sharedResultReservations.some((effect) => effect.index === change.index)) {
			invalid("tool effect indexes must be unique within a shared result node and step");
		}
	}
	if (
		change.effectId === change.invocationId ||
		change.effectId === change.resultNodeId ||
		change.invocationId === change.resultNodeId
	) {
		invalid("tool effect, invocation, and result node ids must differ");
	}
	const latestAttempt = operation.attempts.at(-1);
	if (latestAttempt === undefined || latestAttempt.step !== change.step) {
		invalid("tool effect step must equal the current run step");
	}
	const stepSelection = operation.stepSelections[change.step];
	if (stepSelection === undefined) {
		invalid("tool effect step must have an exact run selection");
	}
	const assistantNode = requireNode(state, change.assistantNodeId, "tool effect assistant node");
	if (
		assistantNode.nodeType !== "message" ||
		assistantNode.role !== "assistant" ||
		assistantNode.operationId !== change.operationId
	) {
		invalid("tool effect assistant node must be an assistant message from the open operation");
	}
	if (change.toolsetFingerprint !== stepSelection.selection.toolsetFingerprint) {
		invalid("tool effect toolset fingerprint must match its selected run step");
	}
	if (!stepSelection.selection.toolNames.includes(change.toolName)) {
		invalid("tool effect name must be present in its selected run step");
	}
	const expectedInputHash = sessionV4ToolInputHash(change.effectiveInput);
	if (change.inputHash !== expectedInputHash) {
		invalid(`tool effect input hash must equal ${expectedInputHash}`);
	}
	journal.mapSet(state.toolEffects, change.effectId, {
		id: change.effectId,
		operationId: change.operationId,
		invocationId: change.invocationId,
		callId: change.callId,
		toolName: change.toolName,
		policy: change.policy,
		effectiveInput: change.effectiveInput,
		inputHash: change.inputHash,
		resultNodeId: change.resultNodeId,
		step: change.step,
		index: change.index,
		assistantNodeId: change.assistantNodeId,
		toolsetFingerprint: change.toolsetFingerprint,
		preparedAt: change.preparedAt,
		status: "prepared",
		dispatchIds: [],
		recoveryId: null,
		recoveryStartedAt: null,
		settlementId: null,
		cancelledById: null,
		lastDispatchedAt: null,
		inDoubtAt: null,
		finishedAt: null,
	});
	journalOwner(journal, indexes, change.effectId, "tool effect");
	journalOwner(journal, indexes, change.invocationId, "tool invocation");
	journalOwner(journal, indexes, change.resultNodeId, "tool result node");
	journal.addSetValue(indexes.toolEffectsByResultNodeId, change.resultNodeId, change.effectId);
	journal.addSetValue(indexes.toolEffectsByOperationId, change.operationId, change.effectId);
	journal.addSetValue(indexes.toolCallIdsByOperationId, change.operationId, change.callId);
}

function requireToolEffect(state: SessionV4State, effectId: string): SessionV4ToolEffectState {
	const effect = state.toolEffects.get(effectId);
	if (effect === undefined) invalid(`tool effect ${JSON.stringify(effectId)} does not exist`);
	requireOpenOperation(state, effect.operationId);
	return effect;
}

function applyToolDispatched(
	state: SessionV4State,
	change: Extract<SessionV4Change, { type: "tool_effect_dispatched" }>,
	journal: SessionV4MutationJournal,
	indexes: SessionV4DerivedIndexes,
): void {
	const effect = requireToolEffect(state, change.effectId);
	const operation = state.operations.get(effect.operationId) as SessionV4OperationState;
	if (operation.cancel !== null) invalid("a tool effect cannot be dispatched after cancellation");
	const initialDispatch = effect.status === "prepared" && effect.dispatchIds.length === 0;
	const recoveryDispatch =
		effect.status === "in_doubt"
		&& effect.policy === "repeatable"
		&& effect.dispatchIds.length === 1;
	if (!initialDispatch && !recoveryDispatch) {
		if (effect.status === "in_doubt" && effect.policy === "repeatable" && effect.dispatchIds.length >= 2) {
			invalid("a repeatable tool effect permits at most one recovery redispatch");
		}
		invalid("a tool effect may dispatch only when prepared, or retry when repeatable and in doubt");
	}
	assertFreshId(state, change.dispatchId, "tool dispatch");
	journal.edit(effect);
	effect.dispatchIds.push(change.dispatchId);
	effect.lastDispatchedAt = change.dispatchedAt;
	effect.status = "dispatched";
	clearInDoubtDiagnostic(effect);
	journalOwner(journal, indexes, change.dispatchId, "tool dispatch");
}

function applyToolInDoubt(
	state: SessionV4State,
	change: Extract<SessionV4Change, { type: "tool_effect_in_doubt" }>,
	journal: SessionV4MutationJournal,
): void {
	const effect = requireToolEffect(state, change.effectId);
	if (effect.status !== "dispatched") invalid("only a dispatched tool effect may become in doubt");
	journal.edit(effect);
	effect.status = "in_doubt";
	effect.inDoubtAt = change.noticedAt;
	if (change.detail === undefined) delete effect.inDoubtDetail;
	else effect.inDoubtDetail = change.detail;
}

function applyToolRecoveryStarted(
	state: SessionV4State,
	change: Extract<SessionV4Change, { type: "tool_effect_recovery_started" }>,
	journal: SessionV4MutationJournal,
	indexes: SessionV4DerivedIndexes,
): void {
	const effect = requireToolEffect(state, change.effectId);
	if (effect.status !== "in_doubt" || effect.policy !== "reconcile") {
		invalid("only an in-doubt reconcile tool effect may start recovery");
	}
	if (effect.recoveryId !== null) invalid("tool effect recovery may start only once");
	assertFreshId(state, change.recoveryId, "tool recovery");
	journal.edit(effect);
	effect.status = "recovery_started";
	effect.recoveryId = change.recoveryId;
	effect.recoveryStartedAt = change.startedAt;
	journalOwner(journal, indexes, change.recoveryId, "tool recovery");
}

function applyToolFinished(
	state: SessionV4State,
	change: Extract<SessionV4Change, { type: "tool_effect_finished" }>,
	journal: SessionV4MutationJournal,
): void {
	const effect = requireToolEffect(state, change.effectId);
	if (effect.status !== "dispatched") invalid("only a dispatched tool effect may finish");
	if (change.result === undefined) {
		invalid("a finished tool effect must persist its result");
	}
	journal.edit(effect);
	effect.status = change.outcome;
	effect.finishedAt = change.finishedAt;
	clearInDoubtDiagnostic(effect);
	effect.result = change.result;
}

function applyToolReconciled(
	state: SessionV4State,
	change: Extract<SessionV4Change, { type: "tool_effect_reconciled" }>,
	journal: SessionV4MutationJournal,
	indexes: SessionV4DerivedIndexes,
): void {
	const effect = requireToolEffect(state, change.effectId);
	if (effect.status !== "recovery_started" || effect.policy !== "reconcile") {
		invalid("only a recovery-started reconcile tool effect may be reconciled");
	}
	if (change.reconciliationId !== effect.recoveryId) {
		invalid("tool reconciliation id must match its durable recovery claim");
	}
	if (
		(change.outcome === "not_applied" && change.result !== undefined)
		|| (change.outcome !== "not_applied" && change.result === undefined)
	) {
		invalid("tool reconciliation result must match its outcome");
	}
	journal.edit(effect);
	effect.settlementId = change.reconciliationId;
	effect.status = change.outcome;
	effect.finishedAt = change.resolvedAt;
	clearInDoubtDiagnostic(effect);
	if (change.result === undefined) delete effect.result;
	else effect.result = change.result;
	journalOwner(journal, indexes, change.reconciliationId, "tool settlement");
}

function applyToolManuallyResolved(
	state: SessionV4State,
	change: Extract<SessionV4Change, { type: "tool_effect_manually_resolved" }>,
	journal: SessionV4MutationJournal,
	indexes: SessionV4DerivedIndexes,
): void {
	const effect = requireToolEffect(state, change.effectId);
	const operation = state.operations.get(effect.operationId) as SessionV4OperationState;
	const uncertainAndResolvable =
		effect.status === "in_doubt"
		&& (effect.policy === "never_repeat" || operation.cancel !== null);
	const claimedReconciliation =
		effect.status === "recovery_started"
		&& effect.policy === "reconcile";
	if (!uncertainAndResolvable && !claimedReconciliation) {
		invalid(
			"only an in-doubt never-repeat, cancelled uncertain, or recovery-started reconcile "
			+ "tool effect may be manually resolved",
		);
	}
	if (
		(change.outcome === "abandoned" && change.result !== undefined)
		|| (change.outcome !== "abandoned" && change.result === undefined)
	) {
		invalid("manual tool resolution result must match its outcome");
	}
	assertFreshId(state, change.resolutionId, "tool resolution");
	journal.edit(effect);
	effect.settlementId = change.resolutionId;
	if (effect.policy !== "never_repeat" && operation.cancel !== null) {
		effect.cancelledById = operation.cancel.id;
	}
	effect.status = change.outcome;
	effect.finishedAt = change.resolvedAt;
	clearInDoubtDiagnostic(effect);
	if (change.result === undefined) delete effect.result;
	else effect.result = change.result;
	journalOwner(journal, indexes, change.resolutionId, "tool settlement");
}

function applyChange(
	state: SessionV4State,
	change: SessionV4Change,
	journal: SessionV4MutationJournal,
	indexes: SessionV4DerivedIndexes,
): void {
	switch (change.type) {
		case "conversation_node":
			addConversationNode(state, change.node, journal, indexes);
			return;
		case "head":
			if (change.nodeId !== null) requireNode(state, change.nodeId, "session head");
			journal.edit(requireBranch(state, change.branchId)).headNodeId = change.nodeId;
			return;
		case "session_name":
			journal.setProperty(state, "name", change.name);
			return;
		case "node_label":
			requireNode(state, change.nodeId, "node label");
			if (change.label === null) journal.mapDelete(state.labels, change.nodeId);
			else journal.mapSet(state.labels, change.nodeId, change.label);
			return;
		case "run_accepted":
			applyRunAccepted(state, change, journal, indexes);
			return;
		case "run_step_selected":
			applyRunStepSelected(state, change, journal);
			return;
		case "run_attempt":
			applyRunAttempt(state, change, journal, indexes);
			return;
		case "run_cancel":
			applyRunCancel(state, change, journal, indexes);
			return;
		case "run_checkpoint":
			applyRunCheckpoint(state, change, journal, indexes);
			return;
		case "run_finished":
			applyRunFinished(state, change, journal, indexes);
			return;
		case "queue_added":
			applyQueueAdded(state, change, journal, indexes);
			return;
		case "queue_claimed":
			applyQueueClaimed(state, change, journal, indexes);
			return;
		case "queue_finished":
			applyQueueFinished(state, change, journal);
			return;
		case "tool_effect_prepared":
			applyToolPrepared(state, change, journal, indexes);
			return;
		case "tool_effect_dispatched":
			applyToolDispatched(state, change, journal, indexes);
			return;
		case "tool_effect_in_doubt":
			applyToolInDoubt(state, change, journal);
			return;
		case "tool_effect_recovery_started":
			applyToolRecoveryStarted(state, change, journal, indexes);
			return;
		case "tool_effect_finished":
			applyToolFinished(state, change, journal);
			return;
		case "tool_effect_reconciled":
			applyToolReconciled(state, change, journal, indexes);
			return;
		case "tool_effect_manually_resolved":
			applyToolManuallyResolved(state, change, journal, indexes);
			return;
	}
}

function transitionSessionV4Commit(
	state: SessionV4State,
	input: SessionV4Commit,
	retain: boolean,
): boolean {
	const commit = parseSessionV4Commit(input);
	const existing = state.commits.get(commit.commitId);
	if (existing !== undefined) {
		if (isDeepStrictEqual(existing, commit)) return false;
		invalid(`commit id ${JSON.stringify(commit.commitId)} is already used with different content`);
	}
	if (commit.sequence !== state.sequence + 1) {
		invalid(`commit sequence must be ${state.sequence + 1}, received ${commit.sequence}`);
	}
	const indexes = indexesFor(state);
	const journal = new SessionV4MutationJournal();
	try {
		for (const change of commit.changes) applyChange(state, change, journal, indexes);
		for (const change of commit.changes) {
			if (change.type !== "run_accepted" || change.promptNodeId === null) continue;
			const queueEntryId = indexes.queueEntryByTargetNodeId.get(change.promptNodeId);
			const queuedPrompt = queueEntryId === undefined ? undefined : state.queue.get(queueEntryId);
			if (queuedPrompt === undefined) continue;
			const claimedHere = commit.changes.some((candidate) =>
				candidate.type === "queue_claimed" &&
				candidate.entryId === queuedPrompt.id &&
				candidate.operationId === change.operationId &&
				candidate.branchId === change.branchId);
			if (!claimedHere || queuedPrompt.operationId !== change.operationId) {
				invalid("a queued operation prompt must be accepted and claimed by the same operation in one commit");
			}
		}
		journal.setProperty(state, "sequence", commit.sequence);
		journal.mapSet(state.commits, commit.commitId, commit);
		if (retain) journal.commit();
		else journal.rollback();
		return true;
	} catch (error) {
		journal.rollback();
		throw error;
	}
}

/** Applies one validated commit to a state owned by the caller. */
export function applySessionV4CommitOwned(state: SessionV4State, input: SessionV4Commit): boolean {
	return transitionSessionV4Commit(state, input, true);
}

/** Validates one commit against owned state without retaining any mutation. */
export function validateSessionV4CommitTransition(state: SessionV4State, input: SessionV4Commit): void {
	transitionSessionV4Commit(state, input, false);
}

export function reduceSessionV4Commit(current: SessionV4State, input: SessionV4Commit): SessionV4State {
	const next = cloneState(current);
	applySessionV4CommitOwned(next, input);
	return next;
}
