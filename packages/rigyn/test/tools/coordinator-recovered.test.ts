import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { DirectProcessRunner } from "../../src/process/index.js";
import {
  MAX_TOOL_RESULT_CONTENT_BYTES,
  ToolCoordinator,
  ToolRegistry,
  WorkspaceBoundary,
  type ToolExecutionBackend,
} from "../../src/tools/index.js";
import type {
  HarnessTool,
  ToolContext,
  ToolInvocation,
} from "../../src/tools/types.js";

async function toolContext(t: TestContext): Promise<ToolContext> {
  const root = await mkdtemp(join(tmpdir(), "rigyn-tool-recovered-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return {
    workspace: await WorkspaceBoundary.create(root),
    runner: new DirectProcessRunner(),
    signal: new AbortController().signal,
    runId: "recovered-run",
    threadId: "recovered-thread",
  };
}

test("recovered execution uses durable input without rerunning transformation hooks", async (t) => {
  const durableInput = { value: "durable" };
  const trace: string[] = [];
  let preparations = 0;
  let interceptions = 0;
  let transformations = 0;
  const observedInputs: unknown[] = [];
  const tool: HarnessTool = {
    definition: {
      name: "recoverable",
      description: "recovery fixture",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "string" } },
      },
    },
    recovery: { mode: "repeatable" },
    prepareInput() {
      preparations += 1;
      return { value: "prepared-again" };
    },
    validate(input) {
      trace.push("validate");
      assert.deepEqual(input, durableInput);
      observedInputs.push(structuredClone(input));
    },
    resources(input) {
      trace.push("resources");
      assert.deepEqual(input, durableInput);
      observedInputs.push(structuredClone(input));
      return [{ kind: "workspace", key: "workspace", mode: "read" }];
    },
    async execute(input, context) {
      trace.push("execute");
      assert.deepEqual(input, durableInput);
      observedInputs.push(structuredClone(input));
      context.reportProgress?.({
        type: "result",
        content: "recovering",
        isError: false,
        metadata: { phase: "recovery" },
      });
      return {
        content: "x".repeat(MAX_TOOL_RESULT_CONTENT_BYTES + 1_024),
        isError: false,
      };
    },
  };
  const coordinator = new ToolCoordinator(
    new ToolRegistry([tool]),
    {},
    undefined,
    {
      beforeCall(invocation) {
        interceptions += 1;
        return {
          invocation: { ...invocation, input: { value: "intercepted-again" } },
          blocked: false,
          transformations: [{ actor: "fixture" }],
        };
      },
      afterResult(invocation, result) {
        trace.push("after");
        assert.deepEqual(invocation.input, durableInput);
        assert.ok(Buffer.byteLength(result.content, "utf8") <= MAX_TOOL_RESULT_CONTENT_BYTES);
        return { ...result, summary: "recovered" };
      },
    },
  );

  const [result] = await coordinator.executeRecovered(
    [{ callId: "durable-call", name: "recoverable", input: durableInput, index: 0 }],
    await toolContext(t),
    {
      transformed() {
        transformations += 1;
      },
      started(invocation) {
        trace.push("started");
        assert.equal(invocation.recoveryMode, "repeatable");
        observedInputs.push(structuredClone(invocation.input));
      },
      received(invocation) {
        trace.push("received");
        observedInputs.push(structuredClone(invocation.input));
      },
      dispatching(invocation, context) {
        trace.push("dispatch");
        assert.equal(context.toolCallId, "durable-call");
        observedInputs.push(structuredClone(invocation.input));
      },
      progress(update) {
        trace.push("progress");
        assert.equal(update.progress.type, "result");
      },
      completed(entry) {
        trace.push("completed");
        assert.equal(entry.result.summary, "recovered");
      },
    },
  );

  assert.equal(preparations, 0);
  assert.equal(interceptions, 0);
  assert.equal(transformations, 0);
  assert.deepEqual(durableInput, { value: "durable" });
  for (const input of observedInputs) assert.deepEqual(input, durableInput);
  assert.deepEqual(trace, [
    "validate",
    "started",
    "received",
    "resources",
    "dispatch",
    "execute",
    "progress",
    "after",
    "completed",
  ]);
  assert.equal(result?.result.isError, false);
  assert.equal(result?.result.summary, "recovered");
  assert.ok(Buffer.byteLength(result?.result.content ?? "", "utf8") <= MAX_TOOL_RESULT_CONTENT_BYTES);
});

test("recovered execution retains schema and custom validation", async (t) => {
  let executions = 0;
  let preparations = 0;
  let interceptions = 0;
  const tool: HarnessTool = {
    definition: {
      name: "validated",
      description: "validation fixture",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "string" } },
      },
    },
    recovery: { mode: "repeatable" },
    prepareInput(input) {
      preparations += 1;
      return input;
    },
    validate(input) {
      if (
        input === null ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        input.value !== "accepted"
      ) {
        throw new Error("custom validation rejected input");
      }
    },
    resources() {
      return [];
    },
    async execute() {
      executions += 1;
      return { content: "unsafe", isError: false };
    },
  };
  const coordinator = new ToolCoordinator(
    new ToolRegistry([tool]),
    {},
    undefined,
    {
      beforeCall(invocation) {
        interceptions += 1;
        return { invocation, blocked: false };
      },
    },
  );

  const results = await coordinator.executeRecovered([
    { callId: "schema-invalid", name: "validated", input: { value: {} }, index: 0 },
    { callId: "custom-invalid", name: "validated", input: { value: "rejected" }, index: 1 },
  ], await toolContext(t));

  assert.equal(preparations, 0);
  assert.equal(interceptions, 0);
  assert.equal(executions, 0);
  assert.equal(results[0]?.result.isError, true);
  assert.match(results[0]?.result.content ?? "", /must be string/u);
  assert.equal(results[1]?.result.isError, true);
  assert.match(results[1]?.result.content ?? "", /custom validation rejected input/u);
});

test("recovered dispatch is durable before effects and retains backend routing and scheduling", async (t) => {
  const trace: string[] = [];
  let localExecutions = 0;
  const fixture = (name: string, executionMode?: "sequential"): HarnessTool => ({
    definition: {
      name,
      description: `${name} fixture`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "string" } },
      },
    },
    recovery: { mode: "repeatable" },
    ...(executionMode === undefined ? {} : { executionMode }),
    validate() {},
    resources() {
      trace.push(`local-resources:${name}`);
      return [];
    },
    async execute(input) {
      localExecutions += 1;
      trace.push(`local-execute:${name}:${String((input as { value: string }).value)}`);
      return { content: name, isError: false };
    },
  });
  const backend: ToolExecutionBackend = {
    id: "recovery-backend",
    handles(name) {
      return name === "remote";
    },
    resources(request) {
      trace.push(`backend-resources:${String((request.invocation.input as { value: string }).value)}`);
      return [{ kind: "workspace", key: "workspace", mode: "read" }];
    },
    async execute(request) {
      trace.push(`backend-execute:${String((request.invocation.input as { value: string }).value)}`);
      return { content: "remote", isError: false };
    },
  };
  const coordinator = new ToolCoordinator(new ToolRegistry([
    fixture("remote"),
    fixture("sequential", "sequential"),
  ]));
  const invocations: ToolInvocation[] = [
    { callId: "remote-call", name: "remote", input: { value: "durable-remote" }, index: 0 },
    { callId: "local-call", name: "sequential", input: { value: "durable-local" }, index: 1 },
  ];

  const results = await coordinator.executeRecovered(
    invocations,
    { ...await toolContext(t), backend },
    {
      dispatching(invocation) {
        trace.push(`dispatch:${invocation.name}`);
      },
    },
  );

  assert.deepEqual(trace, [
    "backend-resources:durable-remote",
    "dispatch:remote",
    "backend-execute:durable-remote",
    "local-resources:sequential",
    "dispatch:sequential",
    "local-execute:sequential:durable-local",
  ]);
  assert.equal(localExecutions, 1);
  assert.deepEqual(results.map((entry) => entry.result.content), ["remote", "sequential"]);

  let blockedExecutions = 0;
  const blockedTool: HarnessTool = {
    ...fixture("blocked"),
    async execute() {
      blockedExecutions += 1;
      return { content: "unsafe", isError: false };
    },
  };
  const [blocked] = await new ToolCoordinator(new ToolRegistry([blockedTool])).executeRecovered(
    [{ callId: "blocked-call", name: "blocked", input: { value: "durable" }, index: 0 }],
    await toolContext(t),
    {
      dispatching() {
        throw new Error("journal unavailable");
      },
    },
  );
  assert.equal(blockedExecutions, 0);
  assert.equal(blocked?.result.isError, true);
  assert.match(blocked?.result.content ?? "", /journal unavailable/u);
});
