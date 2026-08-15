import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
	applySessionV4CommitOwned,
	createSessionV4State,
	parseSessionV4Bytes,
	type SessionV4Change,
	type SessionV4Changes,
	type SessionV4Commit,
	type SessionV4Header,
	type SessionV4State,
} from "../../src/session-v4/index.js";

const TIME = "2026-07-29T12:00:00.000Z";
const HEADER: SessionV4Header = {
	record: "session",
	version: 4,
	sessionId: "linear-session",
	createdAt: TIME,
	workspace: "/workspace",
	cwd: "/workspace",
};
const SELECTION = {
	provider: "provider",
	model: "model",
	api: null,
	thinkingLevel: "high" as const,
	toolNames: [],
	toolsetFingerprint: "none",
};

function changes(...items: SessionV4Change[]): SessionV4Changes {
	return items as SessionV4Changes;
}

function commit(state: SessionV4State, id: string, items: SessionV4Changes): SessionV4Commit {
	return {
		record: "commit",
		sequence: state.sequence + 1,
		commitId: id,
		committedAt: TIME,
		changes: items,
	};
}

test("a claimed custom queue target materializes only as extension context", () => {
	let state = createSessionV4State(HEADER);
	state = apply(state, "queue", {
		type: "queue_added",
		branchId: "main",
		entryId: "queue-1",
		targetNodeId: "custom-prompt",
		kind: "steering",
		addedAt: TIME,
		message: { customType: "instruction", content: "prefer TypeScript" },
	});
	state = apply(
		state,
		"accept",
		{
			type: "run_accepted",
			branchId: "main",
			operationId: "operation-1",
			promptNodeId: "custom-prompt",
			sourceHeadId: null,
			acceptedAt: TIME,
			request: { queued: true },
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
	state = apply(
		state,
		"materialize",
		{
			type: "conversation_node",
			node: {
				id: "custom-prompt",
				parentId: null,
				nodeType: "extension_context",
				extensionId: "instruction",
				context: { content: "prefer TypeScript" },
				createdAt: TIME,
				operationId: "operation-1",
			},
		},
		{ type: "head", branchId: "main", nodeId: "custom-prompt" },
		{
			type: "queue_finished",
			branchId: "main",
			entryId: "queue-1",
			finishedAt: TIME,
			outcome: "consumed",
		},
		{
			type: "run_finished",
			operationId: "operation-1",
			finishedAt: TIME,
			outcome: "completed",
		},
	);

	assert.equal(state.nodes.get("custom-prompt")?.nodeType, "extension_context");
	assert.equal(state.queue.get("queue-1")?.status, "consumed");
	assert.equal(state.operations.get("operation-1")?.status, "completed");

	const rejected = createQueuedOperation();
	const before = structuredClone(rejected);
	assert.throws(
		() => applySessionV4CommitOwned(rejected, commit(rejected, "arbitrary", changes({
			type: "conversation_node",
			node: {
				id: "custom-prompt",
				parentId: null,
				nodeType: "extension_state",
				extensionId: "instruction",
				state: { content: "prefer TypeScript" },
				createdAt: TIME,
				operationId: "operation-1",
			},
		}))),
		/user message or extension context/u,
	);
	assert.deepEqual(rejected, before);
});

test("owned replay handles 10,000 growing lifecycle commits within the linear gate", () => {
	const state = createSessionV4State(HEADER);
	const rows: SessionV4Commit[] = [];
	let head: string | null = null;
	for (let index = 0; index < 2_500; index += 1) {
		const operationId = `operation-${index}`;
		const promptId = `prompt-${index}`;
		const assistantId = `assistant-${index}`;
		rows.push(commit(state, `accept-${index}`, changes({
			type: "run_accepted",
			branchId: "main",
			operationId,
			promptNodeId: promptId,
			sourceHeadId: head,
			acceptedAt: TIME,
			request: { prompt: index },
			selection: SELECTION,
		})));
		applySessionV4CommitOwned(state, rows.at(-1) as SessionV4Commit);
		rows.push(commit(state, `prompt-${index}`, changes(
			{
				type: "conversation_node",
				node: {
					id: promptId,
					parentId: head,
					nodeType: "message",
					role: "user",
					content: { text: `prompt ${index}` },
					createdAt: TIME,
					operationId,
				},
			},
			{ type: "head", branchId: "main", nodeId: promptId },
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
				attemptId: `attempt-${index}`,
				step: 0,
				attempt: 1,
				task: "assistant",
				startedAt: TIME,
			},
		)));
		applySessionV4CommitOwned(state, rows.at(-1) as SessionV4Commit);
		rows.push(commit(state, `assistant-${index}`, changes(
			{
				type: "conversation_node",
				node: {
					id: assistantId,
					parentId: promptId,
					nodeType: "message",
					role: "assistant",
					content: { text: `answer ${index}` },
					createdAt: TIME,
					operationId,
				},
			},
			{ type: "head", branchId: "main", nodeId: assistantId },
		)));
		applySessionV4CommitOwned(state, rows.at(-1) as SessionV4Commit);
		rows.push(commit(state, `finish-${index}`, changes({
			type: "run_finished",
			operationId,
			finishedAt: TIME,
			outcome: "completed",
		})));
		applySessionV4CommitOwned(state, rows.at(-1) as SessionV4Commit);
		head = assistantId;
	}
	assert.equal(rows.length, 10_000);

	const bytes = Buffer.from(
		`${[HEADER, ...rows].map((value) => JSON.stringify(value)).join("\n")}\n`,
		"utf8",
	);
	parseSessionV4Bytes(Buffer.from(
		`${[HEADER, ...rows.slice(0, 40)].map((value) => JSON.stringify(value)).join("\n")}\n`,
		"utf8",
	));
	const startedAt = performance.now();
	const replayed = parseSessionV4Bytes(bytes);
	const elapsed = performance.now() - startedAt;

	assert.equal(replayed.state.sequence, 10_000);
	assert.equal(replayed.state.operations.size, 2_500);
	assert.equal(replayed.state.nodes.size, 5_000);
	assert.ok(elapsed < 5_000, `10,000-commit replay took ${elapsed.toFixed(1)} ms`);
});

function apply(state: SessionV4State, id: string, ...items: SessionV4Change[]): SessionV4State {
	applySessionV4CommitOwned(state, commit(state, id, changes(...items)));
	return state;
}

function createQueuedOperation(): SessionV4State {
	const state = createSessionV4State(HEADER);
	apply(state, "queue", {
		type: "queue_added",
		branchId: "main",
		entryId: "queue-1",
		targetNodeId: "custom-prompt",
		kind: "steering",
		addedAt: TIME,
		message: { customType: "instruction" },
	});
	apply(
		state,
		"accept",
		{
			type: "run_accepted",
			branchId: "main",
			operationId: "operation-1",
			promptNodeId: "custom-prompt",
			sourceHeadId: null,
			acceptedAt: TIME,
			request: { queued: true },
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
	return state;
}
