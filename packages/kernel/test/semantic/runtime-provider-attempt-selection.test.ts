import assert from "node:assert/strict";
import test from "node:test";
import { sessionV4JsonHash, type SessionV4Json } from "../../src/session-v4/index.js";
import {
	RuntimeEngine,
	type AdapterEvent,
	type EventEnvelope,
	type ProviderAdapter,
	type ProviderRequest,
	type ProviderToolDefinition,
	type RuntimeEvent,
	type ToolExecutionPort,
} from "../../src/runtime/index.js";

test("provider attempt events expose the exact request selection and tool snapshot", async () => {
	const definitions: ProviderToolDefinition[] = [
		{
			name: "read",
			description: "Read one file",
			inputSchema: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		},
		{
			name: "write",
			description: "Write one file",
			inputSchema: {
				type: "object",
				properties: {
					path: { type: "string" },
					content: { type: "string" },
				},
				required: ["path", "content"],
			},
		},
	];
	const requests: ProviderRequest[] = [];
	const provider: ProviderAdapter = {
		id: "provider",
		async *stream(request): AsyncIterable<AdapterEvent> {
			requests.push(structuredClone(request));
			yield {
				type: "response_end",
				reason: "stop",
				state: { kind: "openai_responses", outputItems: [] },
				content: [{ type: "text", text: "done" }],
			};
		},
		async listModels() {
			return [];
		},
	};
	const tools: ToolExecutionPort = {
		turnSnapshot() {
			return { definitions: structuredClone(definitions) };
		},
		async execute() {
			throw new Error("tools must not execute in this test");
		},
	};
	const events: RuntimeEvent[] = [];
	let sequence = 0;
	const engine = new RuntimeEngine({
		conversation: {
			async loadContext() {
				return { messages: [] };
			},
		},
		events: (threadId, runId) => ({
			async emit(event): Promise<EventEnvelope> {
				events.push(structuredClone(event));
				sequence += 1;
				return {
					eventId: `event-${sequence}`,
					threadId,
					runId,
					sequence,
					timestamp: "2026-07-29T12:00:00.000Z",
					schemaVersion: 1,
					event,
				};
			},
		}),
	});

	await engine.run({
		threadId: "thread",
		operationId: "operation",
		promptMessageId: "prompt",
		prompt: "work",
		provider,
		model: "model",
		api: "openai-responses",
		reasoningEffort: "high",
		tools,
		maxSteps: 1,
	});

	assert.equal(requests.length, 1);
	const attempt = events.find(
		(event): event is Extract<RuntimeEvent, { type: "provider_attempt_started" }> =>
			event.type === "provider_attempt_started",
	);
	assert.deepEqual(attempt, {
		type: "provider_attempt_started",
		step: 0,
		attempt: 1,
		provider: "provider",
		model: "model",
		api: "openai-responses",
		reasoningEffort: "high",
		toolNames: ["read", "write"],
		toolsetFingerprint: sessionV4JsonHash(
			JSON.parse(JSON.stringify(requests[0]?.tools)) as SessionV4Json,
		),
	});
});
