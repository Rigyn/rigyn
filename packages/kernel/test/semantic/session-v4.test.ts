import assert from "node:assert/strict";
import fs, {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	truncateSync,
	type Stats,
	writeFileSync,
} from "node:fs";
import { open as openFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createSessionV4State,
	parseSessionV4Bytes,
	parseSessionV4Commit,
	parseSessionV4Header,
	readSessionV4File,
	readSessionV4FileSync,
	reduceSessionV4Commit,
	sessionV4ToolInputHash,
	SESSION_V4_MAX_FILE_BYTES,
	SESSION_V4_MAX_RECORD_BYTES,
	SessionV4SyncWriter,
	SessionV4ValidationError,
	SessionV4Writer,
	type SessionV4Change,
	type SessionV4Changes,
	type SessionV4Commit,
	type SessionV4CommitDraft,
	type SessionV4Header,
	type SessionV4RunSelection,
	type SessionV4State,
} from "../../src/session-v4/index.js";

const TIME = "2026-07-29T12:00:00.000Z";
const HEADER: SessionV4Header = {
	record: "session",
	version: 4,
	sessionId: "session-1",
	createdAt: TIME,
	workspace: "/workspace",
	cwd: "/workspace/project",
};
const SELECTION: SessionV4RunSelection = {
	provider: "provider",
	model: "model",
	api: null,
	thinkingLevel: "high",
	toolNames: ["read", "write"],
	toolsetFingerprint: "tools-a",
};

function changes(...items: SessionV4Change[]): SessionV4Changes {
	assert.ok(items.length > 0);
	return items as SessionV4Changes;
}

function row(state: SessionV4State, commitId: string, items: SessionV4Changes): SessionV4Commit {
	return {
		record: "commit",
		sequence: state.sequence + 1,
		commitId,
		committedAt: TIME,
		changes: items,
	};
}

function apply(state: SessionV4State, commitId: string, ...items: SessionV4Change[]): SessionV4State {
	return reduceSessionV4Commit(state, row(state, commitId, changes(...items)));
}

function message(
	id: string,
	parentId: string | null,
	role: "system" | "user" | "assistant" | "tool",
	content: unknown,
	operationId?: string,
): Extract<SessionV4Change, { type: "conversation_node" }> {
	return {
		type: "conversation_node",
		node: {
			id,
			parentId,
			nodeType: "message",
			role,
			content: content as never,
			createdAt: TIME,
			...(operationId === undefined ? {} : { operationId }),
		},
	};
}

function stateWithPrompt(): SessionV4State {
	let state = createSessionV4State(HEADER);
	state = apply(state, "base", message("root", null, "system", "rules"), {
		type: "head",
		branchId: "main",
		nodeId: "root",
	});
	return apply(state, "prompt", message("prompt", "root", "user", "work"), {
		type: "head",
		branchId: "main",
		nodeId: "prompt",
	});
}

function stateWithSource(): SessionV4State {
	return apply(createSessionV4State(HEADER), "base", message("root", null, "system", "rules"), {
		type: "head",
		branchId: "main",
		nodeId: "root",
	});
}

function accepted(state: SessionV4State, operationId = "operation-1"): SessionV4State {
	const reserved = apply(state, `accept-${operationId}`, {
		type: "run_accepted",
		branchId: "main",
		operationId,
		promptNodeId: "prompt",
		sourceHeadId: "root",
		acceptedAt: TIME,
		request: { text: "work" },
		selection: SELECTION,
	});
	return apply(
		reserved,
		`prompt-${operationId}`,
		message("prompt", "root", "user", "work", operationId),
		{ type: "head", branchId: "main", nodeId: "prompt" },
	);
}

function attempted(state: SessionV4State, operationId = "operation-1"): SessionV4State {
	return apply(
		state,
		`attempt-${operationId}`,
		{
			type: "run_step_selected",
			operationId,
			step: 0,
			selectedAt: TIME,
			selection: SELECTION,
		},
		{
			type: "run_attempt",
			operationId,
			attemptId: `attempt-${operationId}-0-1`,
			step: 0,
			attempt: 1,
			task: "model",
			startedAt: TIME,
		},
	);
}

function draft(commitId: string, ...items: SessionV4Change[]): SessionV4CommitDraft {
	return { commitId, committedAt: TIME, changes: changes(...items) };
}

function encoded(...records: unknown[]): Buffer {
	return Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function temporaryDirectory(): string {
	return mkdtempSync(join(tmpdir(), "rigyn-session-v4-"));
}

test("header requires the exact v4 shape and linked child provenance", () => {
	assert.deepEqual(
		parseSessionV4Header({
			...HEADER,
			parent: {
				sessionId: "parent-session",
				originOperationId: "parent-operation",
				originToolEffectId: "parent-effect",
				purpose: "delegated review",
			},
		}),
		{
			...HEADER,
			parent: {
				sessionId: "parent-session",
				originOperationId: "parent-operation",
				originToolEffectId: "parent-effect",
				purpose: "delegated review",
			},
		},
	);
	assert.throws(() => parseSessionV4Header({ ...HEADER, version: 5 }), SessionV4ValidationError);
	assert.throws(() => parseSessionV4Header({ ...HEADER, extra: true }), /header\.extra is not allowed/u);
	assert.throws(
		() => parseSessionV4Header({ ...HEADER, parent: { sessionId: HEADER.sessionId } }),
		/different session/u,
	);
});

test("runtime state exposes only the primary main branch seam", () => {
	const state = createSessionV4State(HEADER);
	assert.equal(state.primaryBranchId, "main");
	assert.deepEqual([...state.branches.keys()], ["main"]);
	assert.deepEqual(state.branches.get("main"), {
		id: "main",
		headNodeId: null,
		openOperationId: null,
		pendingQueueEntryIds: {
			steering: [],
			follow_up: [],
			next_run: [],
		},
	});
	assert.throws(
		() =>
			parseSessionV4Commit({
				record: "commit",
				sequence: 1,
				commitId: "branch",
				committedAt: TIME,
				changes: [{ type: "head", branchId: "other", nodeId: null }],
			}),
		/branchId must equal "main"/u,
	);
});

test("commit validation rejects empty changes, unknown fields, values, and node discriminants", () => {
	assert.throws(
		() => parseSessionV4Commit({ record: "commit", sequence: 1, commitId: "c", committedAt: TIME, changes: [] }),
		/must not be empty/u,
	);
	assert.throws(
		() =>
			parseSessionV4Commit({
				record: "commit",
				sequence: 1,
				commitId: "c",
				committedAt: TIME,
				changes: [{ type: "session_name", name: "name", extra: true }],
			}),
		/extra is not allowed/u,
	);
	assert.throws(
		() =>
			parseSessionV4Commit({
				record: "commit",
				sequence: 1,
				commitId: "c",
				committedAt: TIME,
				changes: [
					{
						type: "conversation_node",
						node: { id: "n", parentId: null, nodeType: "mystery", createdAt: TIME },
					},
				],
			}),
		/nodeType is not recognized/u,
	);
	assert.throws(
		() =>
			parseSessionV4Commit({
				record: "commit",
				sequence: 1,
				commitId: "c",
				committedAt: TIME,
				changes: [{ type: "session_name", name: Number.NaN }],
			}),
		SessionV4ValidationError,
	);
});

test("JSON data has one replay-stable representation", () => {
	const request = Object.create(null) as Record<string, unknown>;
	Object.defineProperty(request, "__proto__", {
		enumerable: true,
		value: { safe: true },
	});
	request.minusZero = -0;
	const initial = createSessionV4State(HEADER);
	const commit = parseSessionV4Commit(row(initial, "stable-json", changes({
		type: "run_accepted",
		branchId: "main",
		operationId: "operation-json",
		promptNodeId: null,
		sourceHeadId: null,
		acceptedAt: TIME,
		request: request as never,
		selection: SELECTION,
	})));
	const acceptedRequest = commit.changes[0]?.type === "run_accepted"
		? commit.changes[0].request as Record<string, unknown>
		: undefined;
	assert.ok(acceptedRequest !== undefined);
	assert.equal(Object.getPrototypeOf(acceptedRequest), Object.prototype);
	assert.equal(Object.hasOwn(acceptedRequest, "__proto__"), true);
	assert.deepEqual(acceptedRequest.__proto__, { safe: true });
	assert.equal(Object.is(acceptedRequest.minusZero, -0), false);
	assert.equal(acceptedRequest.minusZero, 0);

	const reopened = parseSessionV4Bytes(encoded(HEADER, commit));
	assert.doesNotThrow(() => reduceSessionV4Commit(reopened.state, commit));

	const sparseJson = Array.from({ length: 1 }) as unknown[];
	delete sparseJson[0];
	assert.throws(
		() => parseSessionV4Commit(row(initial, "sparse-json", changes({
			type: "run_accepted",
			branchId: "main",
			operationId: "operation-sparse",
			promptNodeId: null,
			sourceHeadId: null,
			acceptedAt: TIME,
			request: sparseJson as never,
			selection: SELECTION,
		}))),
		/must be JSON data/u,
	);
	const sparseChanges = Array.from({ length: 1 }) as unknown[];
	delete sparseChanges[0];
	assert.throws(
		() => parseSessionV4Commit({
			record: "commit",
			sequence: 1,
			commitId: "sparse-changes",
			committedAt: TIME,
			changes: sparseChanges,
		}),
		/must be an object/u,
	);
});

test("all conversation node kinds have strict public representations", () => {
	const nodes = [
		{
			id: "message",
			parentId: null,
			nodeType: "message",
			role: "user",
			content: "hello",
			createdAt: TIME,
		},
		{
			id: "model",
			parentId: null,
			nodeType: "model_change",
			provider: "provider",
			model: "model",
			createdAt: TIME,
		},
		{ id: "thinking", parentId: null, nodeType: "thinking_change", level: "xhigh", createdAt: TIME },
		{
			id: "tools",
			parentId: null,
			nodeType: "tools_change",
			tools: ["read"],
			toolsetFingerprint: "set",
			createdAt: TIME,
		},
		{
			id: "compact",
			parentId: null,
			nodeType: "compaction",
			summary: "summary",
			retainedNodeIds: [],
			createdAt: TIME,
		},
		{
			id: "branch",
			parentId: null,
			nodeType: "branch_summary",
			fromNodeId: "a",
			toNodeId: "b",
			summary: "summary",
			createdAt: TIME,
		},
		{
			id: "context",
			parentId: null,
			nodeType: "extension_context",
			extensionId: "extension",
			context: { enabled: true },
			createdAt: TIME,
		},
		{
			id: "state",
			parentId: null,
			nodeType: "extension_state",
			extensionId: "extension",
			state: { count: 1 },
			createdAt: TIME,
		},
		{
			id: "shell",
			parentId: null,
			nodeType: "shell",
			command: "pwd",
			cwd: "/workspace",
			result: { exitCode: 0 },
			createdAt: TIME,
		},
	] as const;
	for (const [index, node] of nodes.entries()) {
		const parsed = parseSessionV4Commit({
			record: "commit",
			sequence: index + 1,
			commitId: `commit-${index}`,
			committedAt: TIME,
			changes: [{ type: "conversation_node", node }],
		});
		assert.equal(parsed.changes[0].type, "conversation_node");
	}
});

test("removed reasoning selections are rejected by durable session validation", () => {
	const initial = createSessionV4State(HEADER);
	assert.throws(() => parseSessionV4Commit(row(initial, "removed-selection", changes({
		type: "run_accepted",
		branchId: "main",
		operationId: "operation-removed",
		promptNodeId: null,
		sourceHeadId: null,
		acceptedAt: TIME,
		request: {},
		selection: { ...SELECTION, thinkingLevel: "ultra" as never },
	}))), /thinkingLevel must be one of off, minimal, low, medium, high, xhigh, max/u);
});

test("changes apply in order and maintain one head", () => {
	const initial = createSessionV4State(HEADER);
	assert.throws(
		() =>
			apply(
				initial,
				"wrong-order",
				{ type: "head", branchId: "main", nodeId: "node" },
				message("node", null, "user", "hello"),
			),
		/unknown node/u,
	);
	const state = apply(
		initial,
		"ordered",
		message("node", null, "user", "hello"),
		{ type: "head", branchId: "main", nodeId: "node" },
		{ type: "node_label", nodeId: "node", label: "important" },
	);
	assert.equal(state.branches.get("main")?.headNodeId, "node");
	assert.equal(state.labels.get("node"), "important");
	const cleared = apply(
		state,
		"clear",
		{ type: "node_label", nodeId: "node", label: null },
		{ type: "head", branchId: "main", nodeId: null },
	);
	assert.equal(cleared.branches.get("main")?.headNodeId, null);
	assert.equal(cleared.labels.has("node"), false);
});

test("node relationships, labels, and globally created ids are validated", () => {
	const initial = createSessionV4State(HEADER);
	assert.throws(() => apply(initial, "parent", message("child", "missing", "user", "hello")), /unknown node/u);
	const state = apply(initial, "node", message("node", null, "user", "hello"));
	assert.throws(() => apply(state, "duplicate", message("node", null, "user", "again")), /already used/u);
	assert.throws(
		() => apply(state, "label", { type: "node_label", nodeId: "missing", label: "label" }),
		/unknown node/u,
	);
});

test("commit sequence and id reuse are strict while an identical retry is idempotent", () => {
	const initial = createSessionV4State(HEADER);
	const first = row(initial, "commit-1", changes({ type: "session_name", name: "name" }));
	const state = reduceSessionV4Commit(initial, first);
	const retried = reduceSessionV4Commit(state, first);
	assert.deepEqual(retried, state);
	assert.throws(
		() => reduceSessionV4Commit(state, { ...first, changes: changes({ type: "session_name", name: "other" }) }),
		/different content/u,
	);
	assert.throws(
		() =>
			reduceSessionV4Commit(initial, {
				...first,
				sequence: 2,
			}),
		/sequence must be 1/u,
	);
});

test("only one operation may be open and run attempt order is durable", () => {
	let state = accepted(stateWithSource());
	assert.throws(
		() =>
			apply(state, "second", {
				type: "run_accepted",
				branchId: "main",
				operationId: "operation-2",
				promptNodeId: "prompt",
				sourceHeadId: "root",
				acceptedAt: TIME,
				request: "work",
				selection: SELECTION,
			}),
		/already open/u,
	);
	assert.throws(
		() =>
			apply(state, "bad-attempt", {
				type: "run_attempt",
				operationId: "operation-1",
				attemptId: "bad-attempt",
				step: 0,
				attempt: 1,
				task: "model",
				startedAt: TIME,
			}),
		/requires its current step selection/u,
	);
	state = attempted(state);
	state = apply(state, "retry", {
		type: "run_attempt",
		operationId: "operation-1",
		attemptId: "retry-attempt",
		step: 0,
		attempt: 2,
		task: "model",
		startedAt: TIME,
	});
	state = apply(
		state,
		"next-step",
		{
			type: "run_step_selected",
			operationId: "operation-1",
			step: 1,
			selectedAt: TIME,
			selection: { ...SELECTION, model: "next-model" },
		},
		{
			type: "run_attempt",
			operationId: "operation-1",
			attemptId: "next-attempt",
			step: 1,
			attempt: 1,
			task: "model",
			startedAt: TIME,
		},
	);
	assert.equal(state.operations.get("operation-1")?.attempts.length, 3);
	assert.equal(state.operations.get("operation-1")?.stepSelections[1]?.selection.model, "next-model");
	assert.equal(state.operations.get("operation-1")?.branchId, "main");
});

test("run acceptance durably reserves a prompt before materialization", () => {
	let state = stateWithSource();
	state = apply(state, "reserve", {
		type: "run_accepted",
		branchId: "main",
		operationId: "reserved-operation",
		promptNodeId: "reserved-prompt",
		sourceHeadId: "root",
		acceptedAt: TIME,
		request: { text: "later" },
		selection: SELECTION,
	});
	assert.equal(state.operations.get("reserved-operation")?.promptNodeId, "reserved-prompt");
	assert.equal(state.nodes.has("reserved-prompt"), false);
	assert.throws(
		() =>
			apply(state, "collision", {
				type: "queue_added",
				branchId: "main",
				entryId: "queue",
				targetNodeId: "reserved-prompt",
				kind: "steering",
				addedAt: TIME,
				message: "collision",
			}),
		/already used/u,
	);
	assert.throws(
		() =>
			apply(
				state,
				"wrong-owner",
				message("reserved-prompt", "root", "user", "later", "other-operation"),
			),
		/(?:does not exist|not the open operation)/u,
	);
	assert.throws(
		() =>
			apply(state, "finish-before-prompt", {
				type: "run_finished",
				operationId: "reserved-operation",
				finishedAt: TIME,
				outcome: "failed",
			}),
		/missing its prompt node/u,
	);
	state = apply(
		state,
		"materialize",
		message("reserved-prompt", "root", "user", "later", "reserved-operation"),
		{ type: "head", branchId: "main", nodeId: "reserved-prompt" },
	);
	state = apply(state, "finish", {
		type: "run_finished",
		operationId: "reserved-operation",
		finishedAt: TIME,
		outcome: "completed",
	});
	assert.equal(state.branches.get("main")?.openOperationId, null);
});

test("a reserved prompt may follow only same-operation nodes from its source head", () => {
	let state = stateWithSource();
	state = apply(state, "detached", message("foreign", "root", "system", "foreign"));
	state = apply(state, "reserve", {
		type: "run_accepted",
		branchId: "main",
		operationId: "reserved-operation",
		promptNodeId: "reserved-prompt",
		sourceHeadId: "root",
		acceptedAt: TIME,
		request: { text: "later" },
		selection: SELECTION,
	});
	assert.throws(
		() =>
			apply(
				state,
				"foreign-ancestor",
				message("reserved-prompt", "foreign", "user", "later", "reserved-operation"),
			),
		/may traverse only nodes from its operation/u,
	);
	state = apply(
		state,
		"operation-context",
		message("operation-context", "root", "system", "runtime context", "reserved-operation"),
	);
	state = apply(
		state,
		"materialize",
		message("reserved-prompt", "operation-context", "user", "later", "reserved-operation"),
	);
	assert.equal(state.nodes.get("reserved-prompt")?.parentId, "operation-context");
});

test("continue and structural operations do not invent a prompt node", () => {
	let state = stateWithSource();
	state = apply(state, "continue", {
		type: "run_accepted",
		branchId: "main",
		operationId: "continue-operation",
		promptNodeId: null,
		sourceHeadId: "root",
		acceptedAt: TIME,
		request: { action: "continue" },
		selection: SELECTION,
	});
	state = apply(state, "continue-finished", {
		type: "run_finished",
		operationId: "continue-operation",
		finishedAt: TIME,
		outcome: "completed",
	});
	assert.equal(state.nodes.size, 1);
	assert.equal(state.branches.get("main")?.openOperationId, null);
});

test("run cancellation, checkpoints, and finish lifecycle reject reused ids", () => {
	let state = attempted(accepted(stateWithSource()));
	state = apply(
		state,
		"control",
		{
			type: "run_cancel",
			operationId: "operation-1",
			cancelId: "cancel-1",
			requestedAt: TIME,
			reason: "user",
		},
		{
			type: "run_checkpoint",
			operationId: "operation-1",
			checkpointId: "checkpoint-1",
			createdAt: TIME,
			data: { cursor: "prompt" },
		},
	);
	assert.throws(
		() =>
			apply(state, "cancel-again", {
				type: "run_cancel",
				operationId: "operation-1",
				cancelId: "cancel-2",
				requestedAt: TIME,
			}),
		/only one cancellation/u,
	);
	assert.throws(
		() =>
			apply(state, "checkpoint-again", {
				type: "run_checkpoint",
				operationId: "operation-1",
				checkpointId: "checkpoint-1",
				createdAt: TIME,
				data: null,
			}),
		/already used/u,
	);
	state = apply(state, "finished", {
		type: "run_finished",
		operationId: "operation-1",
		finishedAt: TIME,
		outcome: "cancelled",
	});
	assert.equal(state.branches.get("main")?.openOperationId, null);
	assert.throws(
		() =>
			apply(state, "finish-again", {
				type: "run_finished",
				operationId: "operation-1",
				finishedAt: TIME,
				outcome: "cancelled",
			}),
		/not the open operation/u,
	);
});

test("durable queue entries retain accepted input while allowing reduced target content", () => {
	let state = stateWithPrompt();
	state = apply(state, "queue", {
		type: "queue_added",
		branchId: "main",
		entryId: "queue-1",
		targetNodeId: "queued-prompt",
		kind: "next_run",
		addedAt: TIME,
		message: "queued work",
	});
	assert.deepEqual(state.branches.get("main")?.pendingQueueEntryIds.next_run, ["queue-1"]);
	assert.throws(
		() => apply(state, "wrong-role", message("queued-prompt", "prompt", "assistant", "changed")),
		/must be a user message/u,
	);
	state = apply(
		state,
		"queue-run",
		{
			type: "run_accepted",
			branchId: "main",
			operationId: "queued-operation",
			promptNodeId: "queued-prompt",
			sourceHeadId: "prompt",
			acceptedAt: TIME,
			request: "queued work",
			selection: SELECTION,
		},
		{
			type: "queue_claimed",
			branchId: "main",
			entryId: "queue-1",
			operationId: "queued-operation",
			claimedAt: TIME,
		},
		message("queued-prompt", "prompt", "user", "extension-reduced work", "queued-operation"),
		{ type: "head", branchId: "main", nodeId: "queued-prompt" },
		{ type: "queue_finished", branchId: "main", entryId: "queue-1", finishedAt: TIME, outcome: "consumed" },
		{
			type: "run_finished",
			operationId: "queued-operation",
			finishedAt: TIME,
			outcome: "completed",
		},
	);
	assert.equal(state.queue.get("queue-1")?.message, "queued work");
	const queuedPrompt = state.nodes.get("queued-prompt");
	assert.equal(
		queuedPrompt?.nodeType === "message"
			? queuedPrompt.content
			: undefined,
		"extension-reduced work",
	);
	assert.equal(state.queue.get("queue-1")?.status, "consumed");
	assert.equal(state.queue.get("queue-1")?.branchId, "main");
	assert.deepEqual(state.branches.get("main")?.pendingQueueEntryIds.next_run, []);
	assert.equal(state.branches.get("main")?.openOperationId, null);
});

test("queued prompt ownership is accepted and claimed atomically", () => {
	let state = stateWithPrompt();
	state = apply(state, "queue", {
		type: "queue_added",
		branchId: "main",
		entryId: "queue-1",
		targetNodeId: "queued-prompt",
		kind: "next_run",
		addedAt: TIME,
		message: "queued work",
	});
	assert.throws(
		() =>
			apply(state, "unclaimed-accept", {
				type: "run_accepted",
				branchId: "main",
				operationId: "operation-1",
				promptNodeId: "queued-prompt",
				sourceHeadId: "prompt",
				acceptedAt: TIME,
				request: "queued work",
				selection: SELECTION,
			}),
		/accepted and claimed.+one commit/u,
	);
	state = apply(
		state,
		"accept-and-claim",
		{
			type: "run_accepted",
			branchId: "main",
			operationId: "operation-1",
			promptNodeId: "queued-prompt",
			sourceHeadId: "prompt",
			acceptedAt: TIME,
			request: "queued work",
			selection: SELECTION,
		},
		{
			type: "queue_claimed",
			branchId: "main",
			entryId: "queue-1",
			operationId: "operation-1",
			claimedAt: TIME,
		},
	);
	assert.throws(
		() => apply(state, "wrong-owner", message("queued-prompt", "prompt", "user", "work", "operation-2")),
		/(?:does not exist|not the open operation|claiming operation)/u,
	);
	state = apply(state, "materialize", message("queued-prompt", "prompt", "user", "work", "operation-1"));
	assert.equal(state.queue.get("queue-1")?.operationId, "operation-1");
	assert.equal(state.nodes.get("queued-prompt")?.operationId, "operation-1");
});

test("claimed queue work must finish before its operation", () => {
	let state = accepted(stateWithSource());
	state = apply(state, "queue", {
		type: "queue_added",
		branchId: "main",
		entryId: "queue-1",
		targetNodeId: "steering-node",
		kind: "steering",
		addedAt: TIME,
		message: "steer",
	});
	state = apply(
		state,
		"claim",
		{
			type: "queue_claimed",
			branchId: "main",
			entryId: "queue-1",
			operationId: "operation-1",
			claimedAt: TIME,
		},
		message("steering-node", "prompt", "user", "steer", "operation-1"),
	);
	assert.throws(
		() =>
			apply(state, "finish", {
				type: "run_finished",
				operationId: "operation-1",
				finishedAt: TIME,
				outcome: "completed",
			}),
		/must finish before/u,
	);
});

function toolReady(policy: "repeatable" | "reconcile" | "never_repeat"): SessionV4State {
	let state = attempted(accepted(stateWithSource()));
	state = apply(state, "assistant", message("assistant", "prompt", "assistant", "calling", "operation-1"));
	return apply(state, `prepare-${policy}`, {
		type: "tool_effect_prepared",
		effectId: `effect-${policy}`,
		operationId: "operation-1",
		invocationId: `invocation-${policy}`,
		callId: `call-${policy}`,
		toolName: "read",
		policy,
		effectiveInput: { path: "README.md" },
		inputHash: sessionV4ToolInputHash({ path: "README.md" }),
		resultNodeId: `result-${policy}`,
		step: 0,
		index: 0,
		assistantNodeId: "assistant",
		toolsetFingerprint: "tools-a",
		preparedAt: TIME,
	});
}

test("one assistant tool batch may reserve one shared aggregate result node", () => {
	let state = toolReady("repeatable");
	assert.equal(state.toolEffects.get("effect-repeatable")?.callId, "call-repeatable");
	assert.throws(
		() =>
			apply(state, "effect-id-collision", {
				type: "tool_effect_prepared",
				effectId: "result-repeatable",
				operationId: "operation-1",
				invocationId: "invocation-collision",
				callId: "call-collision",
				toolName: "write",
				policy: "never_repeat",
				effectiveInput: { path: "README.md", content: "updated" },
				inputHash: sessionV4ToolInputHash({ path: "README.md", content: "updated" }),
				resultNodeId: "other-result",
				step: 0,
				index: 0,
				assistantNodeId: "assistant",
				toolsetFingerprint: "tools-a",
				preparedAt: TIME,
			}),
		/already used/u,
	);
	const withOtherAssistant = apply(
		state,
		"other-assistant",
		message("other-assistant", "assistant", "assistant", "more calls", "operation-1"),
	);
	assert.throws(
		() =>
			apply(withOtherAssistant, "wrong-batch", {
				type: "tool_effect_prepared",
				effectId: "effect-wrong-batch",
				operationId: "operation-1",
				invocationId: "invocation-wrong-batch",
				callId: "call-wrong-batch",
				toolName: "write",
				policy: "never_repeat",
				effectiveInput: { path: "README.md", content: "updated" },
				inputHash: sessionV4ToolInputHash({ path: "README.md", content: "updated" }),
				resultNodeId: "result-repeatable",
				step: 0,
				index: 1,
				assistantNodeId: "other-assistant",
				toolsetFingerprint: "tools-a",
				preparedAt: TIME,
			}),
		/same operation, step, and assistant message/u,
	);
	state = apply(state, "second-effect", {
		type: "tool_effect_prepared",
		effectId: "effect-write",
		operationId: "operation-1",
		invocationId: "invocation-write",
		callId: "call-write",
		toolName: "write",
		policy: "never_repeat",
		effectiveInput: { path: "README.md", content: "updated" },
		inputHash: sessionV4ToolInputHash({ path: "README.md", content: "updated" }),
		resultNodeId: "result-repeatable",
		step: 0,
		index: 1,
		assistantNodeId: "assistant",
		toolsetFingerprint: "tools-a",
		preparedAt: TIME,
	});
	state = apply(
		state,
		"finish-batch",
		{ type: "tool_effect_dispatched", effectId: "effect-repeatable", dispatchId: "dispatch-read", dispatchedAt: TIME },
		{
			type: "tool_effect_finished",
			effectId: "effect-repeatable",
			finishedAt: TIME,
			outcome: "succeeded",
			result: "read",
		},
		{ type: "tool_effect_dispatched", effectId: "effect-write", dispatchId: "dispatch-write", dispatchedAt: TIME },
		{
			type: "tool_effect_finished",
			effectId: "effect-write",
			finishedAt: TIME,
			outcome: "succeeded",
			result: "write",
		},
		message("result-repeatable", "assistant", "tool", ["read", "write"], "operation-1"),
		{ type: "run_finished", operationId: "operation-1", finishedAt: TIME, outcome: "completed" },
	);
	assert.equal(state.toolEffects.get("effect-repeatable")?.resultNodeId, "result-repeatable");
	assert.equal(state.toolEffects.get("effect-write")?.resultNodeId, "result-repeatable");
	assert.equal(state.nodes.get("result-repeatable")?.nodeType, "message");
});

test("repeatable tool effects may redispatch only after becoming in doubt", () => {
	let state = toolReady("repeatable");
	state = apply(
		state,
		"dispatch",
		{ type: "tool_effect_dispatched", effectId: "effect-repeatable", dispatchId: "dispatch-1", dispatchedAt: TIME },
		{ type: "tool_effect_in_doubt", effectId: "effect-repeatable", noticedAt: TIME },
		{ type: "tool_effect_dispatched", effectId: "effect-repeatable", dispatchId: "dispatch-2", dispatchedAt: TIME },
		{
			type: "tool_effect_finished",
			effectId: "effect-repeatable",
			finishedAt: TIME,
			outcome: "succeeded",
			result: "contents",
		},
		message("result-repeatable", "assistant", "tool", "contents", "operation-1"),
		{
			type: "run_finished",
			operationId: "operation-1",
			finishedAt: TIME,
			outcome: "completed",
		},
	);
	assert.deepEqual(state.toolEffects.get("effect-repeatable")?.dispatchIds, ["dispatch-1", "dispatch-2"]);
	assert.equal(state.branches.get("main")?.openOperationId, null);
});

test("reconcile tool effects use reconciliation and cannot redispatch", () => {
	let state = toolReady("reconcile");
	state = apply(
		state,
		"in-doubt",
		{ type: "tool_effect_dispatched", effectId: "effect-reconcile", dispatchId: "dispatch-1", dispatchedAt: TIME },
		{ type: "tool_effect_in_doubt", effectId: "effect-reconcile", noticedAt: TIME },
	);
	assert.throws(
		() =>
			apply(state, "retry", {
				type: "tool_effect_dispatched",
				effectId: "effect-reconcile",
				dispatchId: "dispatch-2",
				dispatchedAt: TIME,
			}),
		/may dispatch only/u,
	);
	state = apply(
		state,
		"reconcile",
		{
			type: "tool_effect_recovery_started",
			effectId: "effect-reconcile",
			recoveryId: "reconcile-1",
			startedAt: TIME,
		},
		{
			type: "tool_effect_reconciled",
			effectId: "effect-reconcile",
			reconciliationId: "reconcile-1",
			resolvedAt: TIME,
			outcome: "not_applied",
		},
	);
	assert.equal(state.toolEffects.get("effect-reconcile")?.status, "not_applied");
});

test("never-repeat tool effects require an explicit manual resolution", () => {
	let state = toolReady("never_repeat");
	state = apply(
		state,
		"in-doubt",
		{
			type: "tool_effect_dispatched",
			effectId: "effect-never_repeat",
			dispatchId: "dispatch-1",
			dispatchedAt: TIME,
		},
		{ type: "tool_effect_in_doubt", effectId: "effect-never_repeat", noticedAt: TIME },
	);
	assert.throws(
		() =>
			apply(state, "wrong-resolution", {
				type: "tool_effect_reconciled",
				effectId: "effect-never_repeat",
				reconciliationId: "reconcile-1",
				resolvedAt: TIME,
				outcome: "failed",
			}),
		/reconcile tool effect/u,
	);
	state = apply(state, "manual", {
		type: "tool_effect_manually_resolved",
		effectId: "effect-never_repeat",
		resolutionId: "resolution-1",
		resolvedAt: TIME,
		outcome: "abandoned",
	});
	assert.equal(state.toolEffects.get("effect-never_repeat")?.status, "abandoned");
});

test("operation finish rejects unfinished effects and missing result nodes", () => {
	let state = toolReady("repeatable");
	assert.throws(
		() =>
			apply(state, "too-soon", {
				type: "run_finished",
				operationId: "operation-1",
				finishedAt: TIME,
				outcome: "failed",
			}),
		/tool effect/u,
	);
	state = apply(
		state,
		"tool-finished",
		{ type: "tool_effect_dispatched", effectId: "effect-repeatable", dispatchId: "dispatch", dispatchedAt: TIME },
		{
			type: "tool_effect_finished",
			effectId: "effect-repeatable",
			finishedAt: TIME,
			outcome: "failed",
			result: { error: "failed" },
		},
	);
	assert.throws(
		() =>
			apply(state, "no-node", {
				type: "run_finished",
				operationId: "operation-1",
				finishedAt: TIME,
				outcome: "failed",
			}),
		/missing its result node/u,
	);
});

test("reader ignores either form of non-LF tail", () => {
	const commit = row(createSessionV4State(HEADER), "name", changes({ type: "session_name", name: "name" }));
	for (const tail of ['{"record":"commit"}', '{"record":']) {
		const complete = encoded(HEADER, commit);
		const bytes = Buffer.concat([complete, Buffer.from(tail)]);
		const parsed = parseSessionV4Bytes(bytes);
		assert.equal(parsed.state.name, "name");
		assert.equal(parsed.committedBytes, complete.length);
		assert.equal(parsed.trailingBytes, Buffer.byteLength(tail));
	}
});

test("reader rejects malformed committed records, gaps, CRLF, and invalid UTF-8", () => {
	assert.throws(() => parseSessionV4Bytes(Buffer.from(JSON.stringify(HEADER))), /header must be LF-terminated/u);
	assert.throws(() => parseSessionV4Bytes(Buffer.from(`${JSON.stringify(HEADER)}\n{\n`)), /not valid JSON/u);
	assert.throws(() => parseSessionV4Bytes(Buffer.from(`${JSON.stringify(HEADER)}\r\n`)), /LF terminator/u);
	const gap = {
		record: "commit",
		sequence: 2,
		commitId: "gap",
		committedAt: TIME,
		changes: [{ type: "session_name", name: "gap" }],
	};
	assert.throws(() => parseSessionV4Bytes(encoded(HEADER, gap)), /sequence must be 1/u);
	assert.throws(
		() => parseSessionV4Bytes(Buffer.concat([Buffer.from(`${JSON.stringify(HEADER)}\n`), Buffer.from([0xff, 0x0a])])),
		/valid UTF-8/u,
	);
});

test("reader rejects oversized records and files before parsing them", () => {
	const oversizedRecord = Buffer.from(
		`${JSON.stringify(HEADER)}\n${"x".repeat(SESSION_V4_MAX_RECORD_BYTES + 1)}\n`,
		"utf8",
	);
	assert.throws(
		() => parseSessionV4Bytes(oversizedRecord),
		new RegExp(`line 2 exceeds ${SESSION_V4_MAX_RECORD_BYTES} bytes`, "u"),
	);

	const root = temporaryDirectory();
	const path = join(root, "oversized.jsonl");
	try {
		writeFileSync(path, `${JSON.stringify(HEADER)}\n`);
		truncateSync(path, SESSION_V4_MAX_FILE_BYTES + 1);
		assert.throws(
			() => readSessionV4FileSync(path),
			new RegExp(`exceeds ${SESSION_V4_MAX_FILE_BYTES} bytes`, "u"),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("synchronous session readers and writer opens reject descriptor growth after stat", () => {
	const root = temporaryDirectory();
	const originalFstatSync = fs.fstatSync;
	let armedPath: string | undefined;
	fs.fstatSync = ((fd: number) => {
		const details = originalFstatSync(fd);
		if (armedPath !== undefined) {
			const target = statSync(armedPath);
			if (details.dev === target.dev && details.ino === target.ino) {
				truncateSync(armedPath, details.size + 1);
				armedPath = undefined;
			}
		}
		return details;
	}) as typeof fs.fstatSync;
	syncBuiltinESMExports();
	try {
		const readerPath = join(root, "reader.jsonl");
		writeFileSync(readerPath, encoded(HEADER));
		armedPath = readerPath;
		assert.throws(() => readSessionV4FileSync(readerPath), /changed while being read/u);
		assert.equal(armedPath, undefined);

		const writerPath = join(root, "writer.jsonl");
		writeFileSync(writerPath, encoded(HEADER));
		armedPath = writerPath;
		assert.throws(() => {
			const writer = SessionV4SyncWriter.open(writerPath);
			writer.close();
		}, /changed while being read/u);
		assert.equal(armedPath, undefined);
	} finally {
		fs.fstatSync = originalFstatSync;
		syncBuiltinESMExports();
		rmSync(root, { recursive: true, force: true });
	}
});

test("asynchronous session readers and writer opens reject descriptor growth after stat", async () => {
	const root = temporaryDirectory();
	const probePath = join(root, "probe.jsonl");
	writeFileSync(probePath, encoded(HEADER));
	const probe = await openFile(probePath, "r");
	const prototype = Object.getPrototypeOf(probe) as {
		stat(): Promise<Stats>;
	};
	const originalStat = prototype.stat;
	await probe.close();
	let armedPath: string | undefined;
	prototype.stat = async function () {
		const details = await originalStat.call(this);
		if (armedPath !== undefined) {
			const target = statSync(armedPath);
			if (details.dev === target.dev && details.ino === target.ino) {
				truncateSync(armedPath, details.size + 1);
				armedPath = undefined;
			}
		}
		return details;
	};
	try {
		const readerPath = join(root, "reader.jsonl");
		writeFileSync(readerPath, encoded(HEADER));
		armedPath = readerPath;
		await assert.rejects(readSessionV4File(readerPath), /changed while being read/u);
		assert.equal(armedPath, undefined);

		const writerPath = join(root, "writer.jsonl");
		writeFileSync(writerPath, encoded(HEADER));
		armedPath = writerPath;
		await assert.rejects(async () => {
			const writer = await SessionV4Writer.open(writerPath);
			await writer.close();
		}, /changed while being read/u);
		assert.equal(armedPath, undefined);
	} finally {
		prototype.stat = originalStat;
		rmSync(root, { recursive: true, force: true });
	}
});

test("reader accepts a repeated identical commit but rejects changed content under the same id", () => {
	const first = row(createSessionV4State(HEADER), "same", changes({ type: "session_name", name: "name" }));
	const parsed = parseSessionV4Bytes(encoded(HEADER, first, first));
	assert.equal(parsed.commits.length, 1);
	assert.equal(parsed.state.sequence, 1);
	assert.throws(
		() =>
			parseSessionV4Bytes(
				encoded(HEADER, first, {
					...first,
					changes: [{ type: "session_name", name: "changed" }],
				}),
			),
		/different content/u,
	);
});

test("synchronous writer validates transactionally, fsyncs before publication, and retries by commit id", () => {
	const directory = temporaryDirectory();
	const path = join(directory, "session.jsonl");
	try {
		const writer = SessionV4SyncWriter.create(path, HEADER);
		let notifications = 0;
		writer.subscribe((commit, state) => {
			notifications += 1;
			assert.equal(readSessionV4FileSync(path).state.sequence, commit.sequence);
			assert.equal(state.sequence, commit.sequence);
		});
		const input = draft("name", { type: "session_name", name: "durable" });
		const first = writer.append(input);
		const size = statSync(path).size;
		const retried = writer.append(input);
		assert.deepEqual(retried, first);
		assert.equal(statSync(path).size, size);
		assert.equal(notifications, 1);
		assert.throws(
			() => writer.append(draft("name", { type: "session_name", name: "different" })),
			/different content/u,
		);
		assert.equal(writer.state.name, "durable");
		const snapshot = writer.state;
		snapshot.name = "mutated";
		assert.equal(writer.state.name, "durable");
		writer.close();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("failed validation writes and publishes nothing", () => {
	const directory = temporaryDirectory();
	const path = join(directory, "session.jsonl");
	try {
		const writer = SessionV4SyncWriter.create(path, HEADER);
		let notifications = 0;
		writer.subscribe(() => {
			notifications += 1;
		});
		const size = statSync(path).size;
		assert.throws(
			() => writer.append(draft("invalid", { type: "head", branchId: "main", nodeId: "missing" })),
			/unknown node/u,
		);
		assert.equal(writer.state.sequence, 0);
		assert.equal(statSync(path).size, size);
		assert.equal(notifications, 0);
		writer.close();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("opening either writer truncates an uncommitted tail before appending", async () => {
	const directory = temporaryDirectory();
	const syncPath = join(directory, "sync.jsonl");
	const asyncPath = join(directory, "async.jsonl");
	try {
		const base = encoded(HEADER);
		const tail = Buffer.from('{"record":"commit"');
		writeFileSync(syncPath, Buffer.concat([base, tail]));
		const syncWriter = SessionV4SyncWriter.open(syncPath);
		assert.equal(statSync(syncPath).size, base.length);
		syncWriter.append(draft("sync", { type: "session_name", name: "sync" }));
		syncWriter.close();
		assert.equal(readSessionV4FileSync(syncPath).state.name, "sync");

		writeFileSync(asyncPath, Buffer.concat([base, tail]));
		const asyncWriter = await SessionV4Writer.open(asyncPath);
		assert.equal(statSync(asyncPath).size, base.length);
		await asyncWriter.append(draft("async", { type: "session_name", name: "async" }));
		await asyncWriter.close();
		assert.equal(readSessionV4FileSync(asyncPath).state.name, "async");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("asynchronous writer serializes concurrent commits and publishes only after persistence", async () => {
	const directory = temporaryDirectory();
	const path = join(directory, "session.jsonl");
	try {
		const writer = await SessionV4Writer.create(path, HEADER);
		const observed: number[] = [];
		writer.subscribe((commit) => {
			observed.push(commit.sequence);
			assert.equal(readSessionV4FileSync(path).state.sequence, commit.sequence);
		});
		const [first, second] = await Promise.all([
			writer.append(draft("first", { type: "session_name", name: "first" })),
			writer.append(draft("second", { type: "session_name", name: "second" })),
		]);
		assert.deepEqual([first.sequence, second.sequence], [1, 2]);
		assert.deepEqual(observed, [1, 2]);
		await writer.close();
		assert.equal(readSessionV4FileSync(path).state.name, "second");
		assert.equal(readFileSync(path, "utf8").endsWith("\n"), true);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("journal reduction remains usable across a modest append sequence", () => {
	let state = createSessionV4State(HEADER);
	const started = performance.now();
	for (let index = 0; index < 500; index += 1) {
		state = apply(state, `commit-${index}`, {
			type: "session_name",
			name: `name-${index}`,
		});
	}
	const elapsed = performance.now() - started;
	assert.equal(state.sequence, 500);
	assert.ok(elapsed < 5_000, `500 commits took ${elapsed.toFixed(1)}ms`);
});
