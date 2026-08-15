import assert from "node:assert/strict";
import test from "node:test";
import {
	applySessionV4CommitOwned,
	createSessionV4State,
	parseSessionV4CommitDraft,
	reduceSessionV4Commit,
	sessionV4ToolInputHash,
	type SessionV4Change,
	type SessionV4Changes,
	type SessionV4Commit,
	type SessionV4Header,
	type SessionV4RunSelection,
	type SessionV4State,
} from "../../src/session-v4/index.js";

const TIME = "2026-07-29T12:00:00.000Z";
const HEADER: SessionV4Header = {
	record: "session",
	version: 4,
	sessionId: "session-hardening",
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

function items(...changes: SessionV4Change[]): SessionV4Changes {
	assert.ok(changes.length > 0);
	return changes as SessionV4Changes;
}

function commit(state: SessionV4State, commitId: string, ...changes: SessionV4Change[]): SessionV4Commit {
	return {
		record: "commit",
		sequence: state.sequence + 1,
		commitId,
		committedAt: TIME,
		changes: items(...changes),
	};
}

function apply(state: SessionV4State, commitId: string, ...changes: SessionV4Change[]): SessionV4State {
	return reduceSessionV4Commit(state, commit(state, commitId, ...changes));
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

function sourceState(): SessionV4State {
	return apply(
		createSessionV4State(HEADER),
		"source",
		message("root", null, "system", "rules"),
		{ type: "head", branchId: "main", nodeId: "root" },
	);
}

function runningState(): SessionV4State {
	let state = apply(sourceState(), "accepted", {
		type: "run_accepted",
		branchId: "main",
		operationId: "operation",
		promptNodeId: "prompt",
		sourceHeadId: "root",
		acceptedAt: TIME,
		request: { text: "work" },
		selection: SELECTION,
	});
	state = apply(
		state,
		"prompt",
		message("prompt", "root", "user", "work", "operation"),
		{ type: "head", branchId: "main", nodeId: "prompt" },
	);
	return apply(
		state,
		"attempt",
		{
			type: "run_step_selected",
			operationId: "operation",
			step: 0,
			selectedAt: TIME,
			selection: SELECTION,
		},
		{
			type: "run_attempt",
			operationId: "operation",
			attemptId: "attempt-0-1",
			step: 0,
			attempt: 1,
			task: "model",
			startedAt: TIME,
		},
	);
}

function toolPrepared(policy: "repeatable" | "reconcile" | "never_repeat" = "repeatable"): SessionV4State {
	let state = apply(runningState(), "assistant", message(
		"assistant",
		"prompt",
		"assistant",
		"calling a tool",
		"operation",
	));
	const effectiveInput = { path: "README.md" };
	state = apply(state, "prepared", {
		type: "tool_effect_prepared",
		effectId: "effect",
		operationId: "operation",
		invocationId: "invocation",
		callId: "call-read",
		toolName: "read",
		policy,
		effectiveInput,
		inputHash: sessionV4ToolInputHash(effectiveInput),
		resultNodeId: "result",
		step: 0,
		index: 0,
		assistantNodeId: "assistant",
		toolsetFingerprint: "tools-a",
		preparedAt: TIME,
	});
	return state;
}

test("run selections require an explicit bounded API value", () => {
	const accepted = {
		type: "run_accepted" as const,
		branchId: "main" as const,
		operationId: "operation",
		promptNodeId: null,
		sourceHeadId: null,
		acceptedAt: TIME,
		request: { text: "work" },
		selection: SELECTION,
	};
	const parsed = parseSessionV4CommitDraft({
		commitId: "accepted",
		committedAt: TIME,
		changes: [accepted],
	});
	assert.equal(parsed.changes[0]?.type, "run_accepted");
	if (parsed.changes[0]?.type !== "run_accepted") assert.fail("expected accepted run");
	assert.equal(parsed.changes[0].selection.api, null);

	const missingApi = {
		...accepted,
		selection: {
			provider: SELECTION.provider,
			model: SELECTION.model,
			thinkingLevel: SELECTION.thinkingLevel,
			toolNames: SELECTION.toolNames,
			toolsetFingerprint: SELECTION.toolsetFingerprint,
		},
	};
	assert.throws(
		() => parseSessionV4CommitDraft({
			commitId: "missing-api",
			committedAt: TIME,
			changes: [missingApi],
		}),
		/changes\[0\]\.selection\.api is required/u,
	);
	assert.throws(
		() => parseSessionV4CommitDraft({
			commitId: "oversized-api",
			committedAt: TIME,
			changes: [{
				...accepted,
				selection: { ...SELECTION, api: "a".repeat(257) },
			}],
		}),
		/selection\.api must contain at most 256 characters/u,
	);
	const selected = parseSessionV4CommitDraft({
		commitId: "selected",
		committedAt: TIME,
		changes: [{
			type: "run_step_selected",
			operationId: "operation",
			step: 0,
			selectedAt: TIME,
			selection: { ...SELECTION, api: "openai-responses" },
		}],
	});
	assert.equal(
		selected.changes[0]?.type === "run_step_selected"
			? selected.changes[0].selection.api
			: undefined,
		"openai-responses",
	);
	assert.throws(
		() => parseSessionV4CommitDraft({
			commitId: "negative-step",
			committedAt: TIME,
			changes: [{
				type: "run_step_selected",
				operationId: "operation",
				step: -1,
				selectedAt: TIME,
				selection: SELECTION,
			}],
		}),
		/changes\[0\]\.step must be a safe integer greater than or equal to 0/u,
	);
});

test("step selections are explicit, ordered, and transactionally rolled back", () => {
	let state = apply(sourceState(), "accepted", {
		type: "run_accepted",
		branchId: "main",
		operationId: "operation",
		promptNodeId: "prompt",
		sourceHeadId: "root",
		acceptedAt: TIME,
		request: { text: "work" },
		selection: SELECTION,
	});
	state = apply(
		state,
		"prompt",
		message("prompt", "root", "user", "work", "operation"),
		{ type: "head", branchId: "main", nodeId: "prompt" },
	);

	const beforeMismatch = structuredClone(state);
	assert.throws(
		() => apply(state, "mismatched-step-zero", {
			type: "run_step_selected",
			operationId: "operation",
			step: 0,
			selectedAt: TIME,
			selection: { ...SELECTION, model: "other-model" },
		}),
		/must match the accepted run selection/u,
	);
	assert.deepEqual(state, beforeMismatch);
	assert.throws(
		() => apply(state, "attempt-without-selection", {
			type: "run_attempt",
			operationId: "operation",
			attemptId: "attempt-0-1",
			step: 0,
			attempt: 1,
			task: "model",
			startedAt: TIME,
		}),
		/requires its current step selection/u,
	);

	const beforeAtomicFailure = structuredClone(state);
	assert.throws(
		() => apply(
			state,
			"select-and-invalid-attempt",
			{
				type: "run_step_selected",
				operationId: "operation",
				step: 0,
				selectedAt: TIME,
				selection: SELECTION,
			},
			{
				type: "run_attempt",
				operationId: "operation",
				attemptId: "attempt-0-2",
				step: 0,
				attempt: 2,
				task: "model",
				startedAt: TIME,
			},
		),
		/first run attempt must be step 0, attempt 1/u,
	);
	assert.deepEqual(state, beforeAtomicFailure);

	state = apply(state, "select-zero", {
		type: "run_step_selected",
		operationId: "operation",
		step: 0,
		selectedAt: TIME,
		selection: SELECTION,
	});
	assert.deepEqual(state.operations.get("operation")?.stepSelections, [{
		step: 0,
		selectedAt: TIME,
		selection: SELECTION,
	}]);
	assert.throws(
		() => apply(state, "skip-step", {
			type: "run_step_selected",
			operationId: "operation",
			step: 2,
			selectedAt: TIME,
			selection: SELECTION,
		}),
		/next selected run step must be 1/u,
	);
	assert.throws(
		() => apply(state, "select-before-attempt", {
			type: "run_step_selected",
			operationId: "operation",
			step: 1,
			selectedAt: TIME,
			selection: SELECTION,
		}),
		/only after the preceding step was attempted/u,
	);
	state = apply(state, "attempt-zero", {
		type: "run_attempt",
		operationId: "operation",
		attemptId: "attempt-0-1",
		step: 0,
		attempt: 1,
		task: "model",
		startedAt: TIME,
	});
	const nextSelection: SessionV4RunSelection = {
		...SELECTION,
		model: "next-model",
		api: "openai-responses",
		toolNames: ["write"],
		toolsetFingerprint: "tools-b",
	};
	state = apply(state, "select-one", {
		type: "run_step_selected",
		operationId: "operation",
		step: 1,
		selectedAt: TIME,
		selection: nextSelection,
	});
	assert.throws(
		() => apply(state, "late-retry", {
			type: "run_attempt",
			operationId: "operation",
			attemptId: "attempt-0-2",
			step: 0,
			attempt: 2,
			task: "model",
			startedAt: TIME,
		}),
		/requires its current step selection/u,
	);
	state = apply(state, "attempt-one", {
		type: "run_attempt",
		operationId: "operation",
		attemptId: "attempt-1-1",
		step: 1,
		attempt: 1,
		task: "model",
		startedAt: TIME,
	});
	assert.equal(state.operations.get("operation")?.stepSelections[1]?.selection.api, "openai-responses");
});

test("tool effects validate and preserve their exact selected step and batch index", () => {
	let state = runningState();
	const nextSelection: SessionV4RunSelection = {
		...SELECTION,
		model: "next-model",
		toolNames: ["write"],
		toolsetFingerprint: "tools-b",
	};
	state = apply(
		state,
		"next-step",
		{
			type: "run_step_selected",
			operationId: "operation",
			step: 1,
			selectedAt: TIME,
			selection: nextSelection,
		},
		{
			type: "run_attempt",
			operationId: "operation",
			attemptId: "attempt-1-1",
			step: 1,
			attempt: 1,
			task: "model",
			startedAt: TIME,
		},
	);
	state = apply(
		state,
		"assistant",
		message("assistant-step-1", "prompt", "assistant", "calling tools", "operation"),
	);
	const firstInput = { path: "README.md", content: "first" };
	assert.throws(
		() => apply(state, "accepted-selection-is-stale", {
			type: "tool_effect_prepared",
			effectId: "effect-stale",
			operationId: "operation",
			invocationId: "invocation-stale",
			callId: "call-stale",
			toolName: "read",
			policy: "repeatable",
			effectiveInput: firstInput,
			inputHash: sessionV4ToolInputHash(firstInput),
			resultNodeId: "result",
			step: 1,
			index: 0,
			assistantNodeId: "assistant-step-1",
			toolsetFingerprint: "tools-a",
			preparedAt: TIME,
		}),
		/must match its selected run step/u,
	);
	state = apply(state, "first-effect", {
		type: "tool_effect_prepared",
		effectId: "effect-1",
		operationId: "operation",
		invocationId: "invocation-1",
		callId: "call-1",
		toolName: "write",
		policy: "never_repeat",
		effectiveInput: firstInput,
		inputHash: sessionV4ToolInputHash(firstInput),
		resultNodeId: "result",
		step: 1,
		index: 0,
		assistantNodeId: "assistant-step-1",
		toolsetFingerprint: "tools-b",
		preparedAt: TIME,
	});
	assert.equal(state.toolEffects.get("effect-1")?.index, 0);

	const secondInput = { path: "README.md", content: "second" };
	const duplicateIndex = {
		type: "tool_effect_prepared" as const,
		effectId: "effect-2",
		operationId: "operation",
		invocationId: "invocation-2",
		callId: "call-2",
		toolName: "write",
		policy: "never_repeat" as const,
		effectiveInput: secondInput,
		inputHash: sessionV4ToolInputHash(secondInput),
		resultNodeId: "result",
		step: 1,
		index: 0,
		assistantNodeId: "assistant-step-1",
		toolsetFingerprint: "tools-b",
		preparedAt: TIME,
	};
	const beforeDuplicate = structuredClone(state);
	assert.throws(
		() => apply(state, "duplicate-index", duplicateIndex),
		/indexes must be unique within a shared result node and step/u,
	);
	assert.deepEqual(state, beforeDuplicate);
	state = apply(state, "second-effect", { ...duplicateIndex, index: 1 });
	assert.equal(state.toolEffects.get("effect-2")?.index, 1);
});

test("provider call ids are preserved in their own operation-scoped namespace", () => {
	let state = toolPrepared();
	assert.equal(state.toolEffects.get("effect")?.callId, "call-read");

	const secondInput = { path: "README.md", content: "updated" };
	state = apply(state, "second-prepared", {
		type: "tool_effect_prepared",
		effectId: "effect-2",
		operationId: "operation",
		invocationId: "invocation-2",
		callId: "effect-2",
		toolName: "write",
		policy: "never_repeat",
		effectiveInput: secondInput,
		inputHash: sessionV4ToolInputHash(secondInput),
		resultNodeId: "result",
		step: 0,
		index: 1,
		assistantNodeId: "assistant",
		toolsetFingerprint: "tools-a",
		preparedAt: TIME,
	});
	assert.equal(state.toolEffects.get("effect-2")?.callId, "effect-2");

	const before = structuredClone(state);
	assert.throws(
		() => apply(state, "duplicate-call", {
			type: "tool_effect_prepared",
			effectId: "effect-3",
			operationId: "operation",
			invocationId: "invocation-3",
			callId: "call-read",
			toolName: "write",
			policy: "never_repeat",
			effectiveInput: secondInput,
			inputHash: sessionV4ToolInputHash(secondInput),
			resultNodeId: "result",
			step: 0,
			index: 2,
			assistantNodeId: "assistant",
			toolsetFingerprint: "tools-a",
			preparedAt: TIME,
		}),
		/tool call id "call-read" is already prepared for operation "operation"/u,
	);
	assert.deepEqual(state, before);
});

test("canonical tool input hashes are key-order independent and verified by the reducer", () => {
	const first = { z: 1, a: [true, { b: "x", a: null }] };
	const second = { a: [true, { a: null, b: "x" }], z: 1 };
	assert.equal(
		sessionV4ToolInputHash(first),
		"eb3aca96901ff801837e23e9224dfacaac1b6b8dc79fb331e43b29933e639628",
	);
	assert.equal(sessionV4ToolInputHash(first), sessionV4ToolInputHash(second));

	let state = apply(runningState(), "assistant", message(
		"assistant",
		"prompt",
		"assistant",
		"calling a tool",
		"operation",
	));
	assert.throws(
		() => apply(state, "bad-hash", {
			type: "tool_effect_prepared",
			effectId: "effect",
			operationId: "operation",
			invocationId: "invocation",
			callId: "call-read",
			toolName: "read",
			policy: "repeatable",
			effectiveInput: first,
			inputHash: "0".repeat(64),
			resultNodeId: "result",
			step: 0,
			index: 0,
			assistantNodeId: "assistant",
			toolsetFingerprint: "tools-a",
			preparedAt: TIME,
		}),
		/input hash must equal/u,
	);
});

test("cancellation forbids new attempts, tool preparation, and dispatch", () => {
	let state = apply(runningState(), "cancel", {
		type: "run_cancel",
		operationId: "operation",
		cancelId: "cancel",
		requestedAt: TIME,
	});
	assert.throws(
		() => apply(state, "attempt-after-cancel", {
			type: "run_attempt",
			operationId: "operation",
			attemptId: "attempt-0-2",
			step: 0,
			attempt: 2,
			task: "model",
			startedAt: TIME,
		}),
		/cannot start after cancellation/u,
	);
	const effectiveInput = { path: "README.md" };
	assert.throws(
		() => apply(state, "prepare-after-cancel", {
			type: "tool_effect_prepared",
			effectId: "effect",
			operationId: "operation",
			invocationId: "invocation",
			callId: "call-read",
			toolName: "read",
			policy: "repeatable",
			effectiveInput,
			inputHash: sessionV4ToolInputHash(effectiveInput),
			resultNodeId: "result",
			step: 0,
			index: 0,
			assistantNodeId: "prompt",
			toolsetFingerprint: "tools-a",
			preparedAt: TIME,
		}),
		/cannot be prepared after cancellation/u,
	);

	state = toolPrepared();
	state = apply(state, "cancel-prepared", {
		type: "run_cancel",
		operationId: "operation",
		cancelId: "cancel",
		requestedAt: TIME,
	});
	assert.throws(
		() => apply(state, "dispatch-after-cancel", {
			type: "tool_effect_dispatched",
			effectId: "effect",
			dispatchId: "dispatch",
			dispatchedAt: TIME,
		}),
		/cannot be dispatched after cancellation/u,
	);
	const cancelledEffect = state.toolEffects.get("effect");
	assert.equal(cancelledEffect?.status, "not_applied");
	assert.equal(cancelledEffect?.cancelledById, "cancel");
	assert.equal(cancelledEffect?.finishedAt, TIME);
	state = apply(
		state,
		"cancelled-result",
		message("result", "assistant", "tool", { cancelled: true }, "operation"),
		{ type: "run_finished", operationId: "operation", finishedAt: TIME, outcome: "cancelled" },
	);
	assert.equal(state.operations.get("operation")?.status, "cancelled");
});

test("effects dispatched before cancellation can settle or reconcile", () => {
	let state = apply(toolPrepared(), "dispatch", {
		type: "tool_effect_dispatched",
		effectId: "effect",
		dispatchId: "dispatch",
		dispatchedAt: TIME,
	});
	state = apply(state, "cancel", {
		type: "run_cancel",
		operationId: "operation",
		cancelId: "cancel",
		requestedAt: TIME,
	});
	state = apply(state, "settle", {
		type: "tool_effect_finished",
		effectId: "effect",
		finishedAt: TIME,
		outcome: "succeeded",
		result: "contents",
	});
	assert.equal(state.toolEffects.get("effect")?.status, "succeeded");

	state = apply(
		state,
		"result",
		message("result", "assistant", "tool", "contents", "operation"),
		{ type: "run_finished", operationId: "operation", finishedAt: TIME, outcome: "cancelled" },
	);
	assert.equal(state.operations.get("operation")?.status, "cancelled");

	let reconcileState = apply(toolPrepared("reconcile"), "dispatch-reconcile", {
		type: "tool_effect_dispatched",
		effectId: "effect",
		dispatchId: "dispatch",
		dispatchedAt: TIME,
	});
	reconcileState = apply(reconcileState, "cancel-reconcile", {
		type: "run_cancel",
		operationId: "operation",
		cancelId: "cancel",
		requestedAt: TIME,
	});
	reconcileState = apply(
		reconcileState,
		"reconcile",
		{ type: "tool_effect_in_doubt", effectId: "effect", noticedAt: TIME, detail: "lost acknowledgement" },
		{
			type: "tool_effect_recovery_started",
			effectId: "effect",
			recoveryId: "reconciliation",
			startedAt: TIME,
		},
		{
			type: "tool_effect_reconciled",
			effectId: "effect",
			reconciliationId: "reconciliation",
			resolvedAt: TIME,
			outcome: "not_applied",
		},
	);
	const reconciled = reconcileState.toolEffects.get("effect");
	assert.equal(reconciled?.status, "not_applied");
	assert.equal(reconciled?.inDoubtAt, null);
	assert.equal(reconciled?.inDoubtDetail, undefined);

	let repeatableInDoubt = apply(
		toolPrepared(),
		"dispatch-repeatable",
		{ type: "tool_effect_dispatched", effectId: "effect", dispatchId: "dispatch", dispatchedAt: TIME },
		{ type: "tool_effect_in_doubt", effectId: "effect", noticedAt: TIME },
		{ type: "run_cancel", operationId: "operation", cancelId: "cancel", requestedAt: TIME },
	);
	repeatableInDoubt = apply(repeatableInDoubt, "manual-after-cancel", {
		type: "tool_effect_manually_resolved",
		effectId: "effect",
		resolutionId: "resolution",
		resolvedAt: TIME,
		outcome: "abandoned",
	});
	assert.equal(repeatableInDoubt.toolEffects.get("effect")?.status, "abandoned");
	assert.equal(repeatableInDoubt.toolEffects.get("effect")?.cancelledById, "cancel");
});

test("operation completion requires an operation-owned head path containing the prompt", () => {
	let state = runningState();
	state = apply(state, "detached", message("detached", "root", "assistant", "detached", "operation"), {
		type: "head",
		branchId: "main",
		nodeId: "detached",
	});
	assert.throws(
		() => apply(state, "finish-without-prompt", {
			type: "run_finished",
			operationId: "operation",
			finishedAt: TIME,
			outcome: "completed",
		}),
		/must include its prompt node/u,
	);

	state = apply(state, "foreign", message("foreign", "detached", "assistant", "foreign"), {
		type: "head",
		branchId: "main",
		nodeId: "foreign",
	});
	assert.throws(
		() => apply(state, "finish-through-foreign", {
			type: "run_finished",
			operationId: "operation",
			finishedAt: TIME,
			outcome: "completed",
		}),
		/may traverse only nodes from operation/u,
	);

	let valid = apply(runningState(), "assistant", message(
		"assistant",
		"prompt",
		"assistant",
		"done",
		"operation",
	), {
		type: "head",
		branchId: "main",
		nodeId: "assistant",
	});
	valid = apply(valid, "finished", {
		type: "run_finished",
		operationId: "operation",
		finishedAt: TIME,
		outcome: "completed",
	});
	assert.equal(valid.operations.get("operation")?.status, "completed");
});

test("tool aggregate result reservations share one batch and descend from its assistant", () => {
	let state = toolPrepared();
	const secondInput = { path: "README.md", content: "updated" };
	assert.throws(
		() => apply(
			apply(state, "other-assistant", message(
				"other-assistant",
				"assistant",
				"assistant",
				"another batch",
				"operation",
			)),
			"mismatched-reservation",
			{
				type: "tool_effect_prepared",
				effectId: "effect-2",
				operationId: "operation",
				invocationId: "invocation-2",
				callId: "call-write",
				toolName: "write",
				policy: "never_repeat",
				effectiveInput: secondInput,
				inputHash: sessionV4ToolInputHash(secondInput),
				resultNodeId: "result",
				step: 0,
				index: 1,
				assistantNodeId: "other-assistant",
				toolsetFingerprint: "tools-a",
				preparedAt: TIME,
			},
		),
		/shared tool result node must belong to the same operation, step, and assistant message/u,
	);

	state = apply(
		state,
		"settled",
		{ type: "tool_effect_dispatched", effectId: "effect", dispatchId: "dispatch", dispatchedAt: TIME },
		{
			type: "tool_effect_finished",
			effectId: "effect",
			finishedAt: TIME,
			outcome: "succeeded",
			result: "contents",
		},
	);
	assert.throws(
		() => apply(state, "detached-result", message("result", "prompt", "tool", "contents", "operation")),
		/tool result node .* (?:must descend|may traverse only)/u,
	);
	state = apply(state, "result", message("result", "assistant", "tool", "contents", "operation"));
	assert.equal(state.nodes.get("result")?.parentId, "assistant");
});

test("in-doubt diagnostics are separate from final results and clear on redispatch or settlement", () => {
	let state = apply(
		toolPrepared(),
		"in-doubt",
		{ type: "tool_effect_dispatched", effectId: "effect", dispatchId: "dispatch-1", dispatchedAt: TIME },
		{ type: "tool_effect_in_doubt", effectId: "effect", noticedAt: TIME, detail: { reason: "disconnect" } },
	);
	let effect = state.toolEffects.get("effect");
	assert.equal(effect?.inDoubtAt, TIME);
	assert.deepEqual(effect?.inDoubtDetail, { reason: "disconnect" });
	assert.equal(effect?.result, undefined);

	state = apply(state, "redispatch", {
		type: "tool_effect_dispatched",
		effectId: "effect",
		dispatchId: "dispatch-2",
		dispatchedAt: TIME,
	});
	effect = state.toolEffects.get("effect");
	assert.equal(effect?.inDoubtAt, null);
	assert.equal(effect?.inDoubtDetail, undefined);

	state = apply(
		state,
		"settled",
		{
			type: "tool_effect_finished",
			effectId: "effect",
			finishedAt: TIME,
			outcome: "failed",
			result: { error: "failed" },
		},
	);
	effect = state.toolEffects.get("effect");
	assert.equal(effect?.inDoubtAt, null);
	assert.equal(effect?.inDoubtDetail, undefined);
	assert.deepEqual(effect?.result, { error: "failed" });
});

test("repeatable effects permit one recovery redispatch and stay blocked after a second crash", () => {
	let state = apply(
		toolPrepared(),
		"first-dispatch",
		{ type: "tool_effect_dispatched", effectId: "effect", dispatchId: "dispatch-1", dispatchedAt: TIME },
		{ type: "tool_effect_in_doubt", effectId: "effect", noticedAt: TIME },
	);
	state = apply(
		state,
		"recovery-dispatch",
		{ type: "tool_effect_dispatched", effectId: "effect", dispatchId: "dispatch-2", dispatchedAt: TIME },
		{ type: "tool_effect_in_doubt", effectId: "effect", noticedAt: TIME, detail: "recovery interrupted" },
	);
	const before = structuredClone(state);
	const rejected = commit(
		state,
		"third-dispatch",
		{ type: "session_name", name: "must roll back" },
		{ type: "tool_effect_dispatched", effectId: "effect", dispatchId: "dispatch-3", dispatchedAt: TIME },
	);
	assert.throws(
		() => applySessionV4CommitOwned(state, rejected),
		/permits at most one recovery redispatch/u,
	);
	assert.deepEqual(state, before);
	assert.equal(state.name, null);
	assert.equal(state.toolEffects.get("effect")?.status, "in_doubt");
	assert.deepEqual(state.toolEffects.get("effect")?.dispatchIds, ["dispatch-1", "dispatch-2"]);
	assert.deepEqual(state.toolEffects.get("effect")?.inDoubtDetail, "recovery interrupted");
	assert.throws(
		() => apply(state, "another-third-dispatch", {
			type: "tool_effect_dispatched",
			effectId: "effect",
			dispatchId: "dispatch-3",
			dispatchedAt: TIME,
		}),
		/permits at most one recovery redispatch/u,
	);
});

test("reconcile recovery is durably claimed once before settlement", () => {
	let state = apply(
		toolPrepared("reconcile"),
		"in-doubt",
		{ type: "tool_effect_dispatched", effectId: "effect", dispatchId: "dispatch", dispatchedAt: TIME },
		{ type: "tool_effect_in_doubt", effectId: "effect", noticedAt: TIME, detail: "unknown outcome" },
	);
	assert.throws(
		() => apply(state, "settle-without-claim", {
			type: "tool_effect_reconciled",
			effectId: "effect",
			reconciliationId: "recovery",
			resolvedAt: TIME,
			outcome: "not_applied",
		}),
		/recovery-started reconcile tool effect/u,
	);

	const beforeRollback = structuredClone(state);
	assert.throws(
		() => applySessionV4CommitOwned(state, commit(
			state,
			"claim-then-fail",
			{
				type: "tool_effect_recovery_started",
				effectId: "effect",
				recoveryId: "recovery",
				startedAt: TIME,
			},
			{
				type: "tool_effect_reconciled",
				effectId: "effect",
				reconciliationId: "different-recovery",
				resolvedAt: TIME,
				outcome: "not_applied",
			},
		)),
		/must match its durable recovery claim/u,
	);
	assert.deepEqual(state, beforeRollback);

	const claim = commit(state, "claim", {
		type: "tool_effect_recovery_started",
		effectId: "effect",
		recoveryId: "recovery",
		startedAt: TIME,
	});
	assert.equal(applySessionV4CommitOwned(state, claim), true);
	const claimed = structuredClone(state);
	assert.equal(state.toolEffects.get("effect")?.status, "recovery_started");
	assert.equal(state.toolEffects.get("effect")?.recoveryId, "recovery");
	assert.equal(state.toolEffects.get("effect")?.recoveryStartedAt, TIME);
	assert.equal(applySessionV4CommitOwned(state, claim), false);
	assert.deepEqual(state, claimed);
	assert.throws(
		() => apply(state, "claim-again", {
			type: "tool_effect_recovery_started",
			effectId: "effect",
			recoveryId: "another-recovery",
			startedAt: TIME,
		}),
		/only an in-doubt reconcile tool effect may start recovery/u,
	);
	assert.throws(
		() => apply(state, "back-to-in-doubt", {
			type: "tool_effect_in_doubt",
			effectId: "effect",
			noticedAt: TIME,
		}),
		/only a dispatched tool effect may become in doubt/u,
	);

	state = apply(state, "settled", {
		type: "tool_effect_reconciled",
		effectId: "effect",
		reconciliationId: "recovery",
		resolvedAt: TIME,
		outcome: "succeeded",
		result: { content: "recovered" },
	});
	const effect = state.toolEffects.get("effect");
	assert.equal(effect?.status, "succeeded");
	assert.equal(effect?.settlementId, "recovery");
	assert.equal(effect?.recoveryId, "recovery");
	assert.equal(effect?.recoveryStartedAt, TIME);
	assert.deepEqual(effect?.result, { content: "recovered" });

	let manuallyResolved = apply(
		toolPrepared("reconcile"),
		"manual-in-doubt",
		{ type: "tool_effect_dispatched", effectId: "effect", dispatchId: "manual-dispatch", dispatchedAt: TIME },
		{ type: "tool_effect_in_doubt", effectId: "effect", noticedAt: TIME },
		{
			type: "tool_effect_recovery_started",
			effectId: "effect",
			recoveryId: "manual-recovery",
			startedAt: TIME,
		},
	);
	manuallyResolved = apply(manuallyResolved, "manual-resolution", {
		type: "tool_effect_manually_resolved",
		effectId: "effect",
		resolutionId: "manual-resolution",
		resolvedAt: TIME,
		outcome: "abandoned",
	});
	assert.equal(manuallyResolved.toolEffects.get("effect")?.status, "abandoned");
	assert.equal(manuallyResolved.toolEffects.get("effect")?.recoveryId, "manual-recovery");
});

test("tool settlement and run finish enforce cancellation outcomes and persisted results", () => {
	let cancelled = apply(runningState(), "cancel", {
		type: "run_cancel",
		operationId: "operation",
		cancelId: "cancel",
		requestedAt: TIME,
	});
	assert.throws(
		() => apply(cancelled, "completed-after-cancel", {
			type: "run_finished",
			operationId: "operation",
			finishedAt: TIME,
			outcome: "completed",
		}),
		/cancelled operation cannot finish as completed/u,
	);

	const active = runningState();
	assert.throws(
		() => apply(active, "cancelled-without-request", {
			type: "run_finished",
			operationId: "operation",
			finishedAt: TIME,
			outcome: "cancelled",
		}),
		/only after a cancellation request/u,
	);

	const missingResult = apply(
		toolPrepared(),
		"dispatch-without-result",
		{ type: "tool_effect_dispatched", effectId: "effect", dispatchId: "dispatch", dispatchedAt: TIME },
	);
	const before = structuredClone(missingResult);
	assert.throws(
		() => applySessionV4CommitOwned(missingResult, commit(
			missingResult,
			"settle-without-persisted-result",
			{ type: "session_name", name: "must roll back" },
			{ type: "tool_effect_finished", effectId: "effect", finishedAt: TIME, outcome: "failed" },
		)),
		/finished tool effect must persist its result/u,
	);
	assert.deepEqual(missingResult, before);
});

test("compaction retained IDs form an ordered range on the parent ancestry", () => {
	let state = apply(
		createSessionV4State(HEADER),
		"tree",
		message("root", null, "system", "rules"),
		message("a", "root", "user", "a"),
		message("b", "a", "assistant", "b"),
		message("c", "b", "user", "c"),
		message("side", "root", "user", "side"),
	);
	state = apply(state, "valid-compaction", {
		type: "conversation_node",
		node: {
			id: "compaction",
			parentId: "c",
			nodeType: "compaction",
			summary: "summary",
			retainedNodeIds: ["a", "b"],
			createdAt: TIME,
		},
	});
	const compaction = state.nodes.get("compaction");
	assert.deepEqual(compaction?.nodeType === "compaction" ? compaction.retainedNodeIds : undefined, ["a", "b"]);
	assert.throws(
		() => apply(state, "reversed-compaction", {
			type: "conversation_node",
			node: {
				id: "reversed",
				parentId: "c",
				nodeType: "compaction",
				summary: "summary",
				retainedNodeIds: ["b", "a"],
				createdAt: TIME,
			},
		}),
		/compaction retained range must descend/u,
	);
	assert.throws(
		() => apply(state, "off-branch-compaction", {
			type: "conversation_node",
			node: {
				id: "off-branch",
				parentId: "c",
				nodeType: "compaction",
				summary: "summary",
				retainedNodeIds: ["side"],
				createdAt: TIME,
			},
		}),
		/compaction parent must descend/u,
	);
	assert.throws(
		() => apply(state, "root-compaction", {
			type: "conversation_node",
			node: {
				id: "root-compaction",
				parentId: null,
				nodeType: "compaction",
				summary: "summary",
				retainedNodeIds: ["root"],
				createdAt: TIME,
			},
		}),
		/root compaction node cannot retain/u,
	);
});

test("branch-summary endpoints form a range anchored at the summary parent", () => {
	let state = apply(
		createSessionV4State(HEADER),
		"tree",
		message("root", null, "system", "rules"),
		message("a", "root", "user", "a"),
		message("b", "a", "assistant", "b"),
	);
	state = apply(state, "valid-summary", {
		type: "conversation_node",
		node: {
			id: "summary",
			parentId: "a",
			nodeType: "branch_summary",
			fromNodeId: "a",
			toNodeId: "b",
			summary: "summary",
			createdAt: TIME,
		},
	});
	assert.equal(state.nodes.get("summary")?.parentId, "a");
	assert.throws(
		() => apply(state, "reversed-summary", {
			type: "conversation_node",
			node: {
				id: "reversed",
				parentId: "b",
				nodeType: "branch_summary",
				fromNodeId: "b",
				toNodeId: "a",
				summary: "summary",
				createdAt: TIME,
			},
		}),
		/branch summary range end must descend/u,
	);
	assert.throws(
		() => apply(state, "unanchored-summary", {
			type: "conversation_node",
			node: {
				id: "unanchored",
				parentId: "root",
				nodeType: "branch_summary",
				fromNodeId: "a",
				toNodeId: "b",
				summary: "summary",
				createdAt: TIME,
			},
		}),
		/parent must equal its range start/u,
	);
});

test("a late failure in a multi-change commit leaves the public input state unchanged", () => {
	const state = sourceState();
	const before = structuredClone(state);
	assert.throws(
		() => reduceSessionV4Commit(state, commit(
			state,
			"late-failure",
			{ type: "session_name", name: "must not leak" },
			{ type: "head", branchId: "main", nodeId: "missing" },
		)),
		/references unknown node/u,
	);
	assert.deepEqual(state, before);
	assert.equal(state.name, null);
	assert.equal(state.sequence, before.sequence);
});
