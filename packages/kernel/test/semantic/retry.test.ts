import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentHarness,
  InMemorySessionRepo,
  type AgentHarnessEvent,
  type AssistantMessage,
  type Model,
  type Models,
} from "../../src/index.js";
import { NodeExecutionEnv } from "../../src/node.js";

const model: Model = {
  id: "retry-model",
  name: "Retry Model",
  api: "retry-test",
  provider: "retry-test",
  baseUrl: "http://localhost.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(text: string, stopReason: AssistantMessage["stopReason"] = "stop", errorMessage?: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp: Date.now(),
    usage,
  };
}

function queuedModels(responses: AssistantMessage[]): { models: Models; calls(): number } {
  let calls = 0;
  const models = {
    async completeSimple() {
      const response = responses[calls];
      calls += 1;
      if (response === undefined) throw new Error("Unexpected summary request");
      return response;
    },
  } as unknown as Models;
  return { models, calls: () => calls };
}

function retryEvents(events: AgentHarnessEvent[]): AgentHarnessEvent[] {
  return events.filter((event) =>
    event.type === "retry_scheduled" ||
    event.type === "retry_attempt_start" ||
    event.type === "retry_finished");
}

async function compactionHarness(responses: AssistantMessage[], maxRetries = 1) {
  const queued = queuedModels(responses);
  const repo = new InMemorySessionRepo();
  const session = await repo.create();
  await session.appendMessage({ role: "user", content: "one", timestamp: 1 });
  await session.appendMessage(assistant("two"));
  const harness = new AgentHarness({
    env: new NodeExecutionEnv({ cwd: process.cwd() }),
    session,
    models: queued.models,
    model,
    retry: { enabled: true, maxRetries, baseDelayMs: 0 },
  });
  const events: AgentHarnessEvent[] = [];
  harness.subscribe((event) => { events.push(event); });
  return { harness, events, calls: queued.calls };
}

test("AgentHarness retries transient compaction failures with one lifecycle", async () => {
  const { harness, events, calls } = await compactionHarness([
    assistant("", "error", "terminated"),
    assistant("Recovered summary"),
  ]);

  const result = await harness.compact();

  assert.match(result.summary, /Recovered summary/u);
  assert.equal(calls(), 2);
  assert.deepEqual(retryEvents(events), [
    {
      type: "retry_scheduled",
      operation: "compaction",
      attempt: 1,
      maxAttempts: 1,
      delayMs: 0,
      errorMessage: "terminated",
    },
    { type: "retry_attempt_start", operation: "compaction" },
    { type: "retry_finished", operation: "compaction" },
  ]);
});

test("AgentHarness applies the compaction retry budget once", async () => {
  const { harness, events, calls } = await compactionHarness([
    assistant("", "error", "terminated"),
    assistant("", "error", "terminated"),
    assistant("unexpected third call"),
  ]);

  await assert.rejects(() => harness.compact(), /terminated/u);

  assert.equal(calls(), 2);
  assert.deepEqual(retryEvents(events).map((event) => event.type), [
    "retry_scheduled",
    "retry_attempt_start",
    "retry_finished",
  ]);
});

test("AgentHarness does not retry permanent compaction failures", async () => {
  const { harness, events, calls } = await compactionHarness([
    assistant("", "error", "insufficient_quota"),
  ]);

  await assert.rejects(() => harness.compact(), /insufficient_quota/u);

  assert.equal(calls(), 1);
  assert.deepEqual(retryEvents(events), []);
});

test("AgentHarness retries transient branch-summary failures", async () => {
  const queued = queuedModels([
    assistant("", "error", "service unavailable"),
    assistant("Recovered branch summary"),
  ]);
  const repo = new InMemorySessionRepo();
  const session = await repo.create();
  const targetId = await session.appendMessage({ role: "user", content: "first branch", timestamp: 1 });
  await session.appendMessage(assistant("first reply"));
  await session.appendMessage({ role: "user", content: "abandoned work", timestamp: 2 });
  await session.appendMessage(assistant("abandoned reply"));
  const harness = new AgentHarness({
    env: new NodeExecutionEnv({ cwd: process.cwd() }),
    session,
    models: queued.models,
    model,
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
  });
  const events: AgentHarnessEvent[] = [];
  harness.subscribe((event) => { events.push(event); });

  const result = await harness.navigateTree(targetId, { summarize: true });

  assert.match(result.summaryEntry?.summary ?? "", /Recovered branch summary/u);
  assert.equal(queued.calls(), 2);
  assert.deepEqual(retryEvents(events), [
    {
      type: "retry_scheduled",
      operation: "branch_summary",
      attempt: 1,
      maxAttempts: 1,
      delayMs: 0,
      errorMessage: "service unavailable",
    },
    { type: "retry_attempt_start", operation: "branch_summary" },
    { type: "retry_finished", operation: "branch_summary" },
  ]);
});
