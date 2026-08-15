import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DirectProcessRunner } from "../../src/process/index.js";
import { ToolCoordinator, ToolRegistry, WorkspaceBoundary } from "../../src/tools/index.js";
import type { ToolExecutionBackend } from "../../src/tools/backend.js";
import type { HarnessTool, ToolContext } from "../../src/tools/types.js";

async function toolContext(t: { after(callback: () => Promise<void>): void }): Promise<ToolContext> {
  const root = await mkdtemp(join(tmpdir(), "rigyn-tool-approval-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return {
    workspace: await WorkspaceBoundary.create(root),
    runner: new DirectProcessRunner(),
    signal: new AbortController().signal,
    runId: "approval-run",
    threadId: "approval-thread",
  };
}

function approvalTool(trace: string[]): HarnessTool {
  return {
    definition: {
      name: "sensitive_write",
      description: "write a selected target",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: { path: { type: "string" } },
      },
    },
    validate(input) {
      if (input === null || typeof input !== "object" || Array.isArray(input) || typeof input.path !== "string") {
        throw new Error("path must be a string");
      }
    },
    resources(input) {
      const path = (input as { path: string }).path;
      trace.push(`resources:${path}`);
      return [{ kind: "file", key: path, mode: "write" }];
    },
    async execute(input) {
      trace.push(`execute:${(input as { path: string }).path}`);
      return { content: "written", isError: false };
    },
  };
}

test("host approval sees final transformed input and resources and denial precedes durable dispatch", async (t) => {
  const trace: string[] = [];
  const coordinator = new ToolCoordinator(
    new ToolRegistry([approvalTool(trace)]),
    {},
    undefined,
    {
      beforeCall(invocation) {
        trace.push("transform");
        return {
          invocation: { ...invocation, input: { path: "final.txt" } },
          blocked: false,
          transformations: [{ actor: "fixture" }],
        };
      },
      authorize(request) {
        trace.push(`approve:${(request.invocation.input as { path: string }).path}`);
        assert.deepEqual(request.resources, [{ kind: "file", key: "final.txt", mode: "write" }]);
        assert.equal(request.backendId, "local");
        assert.equal(request.recovered, false);
        return { decision: "deny", reason: "user denied" };
      },
      afterResult() {
        trace.push("after");
        return { content: "extension claimed success", isError: false };
      },
    },
  );

  const [result] = await coordinator.execute(
    [{ callId: "approval-call", name: "sensitive_write", input: { path: "original.txt" }, index: 0 }],
    await toolContext(t),
    { dispatching() { trace.push("dispatch"); } },
  );

  assert.deepEqual(trace, ["transform", "resources:final.txt", "approve:final.txt"]);
  assert.equal(result?.result.isError, true);
  assert.match(result?.result.content ?? "", /user denied/u);
});

test("approved calls keep the immutable approval snapshot through dispatch", async (t) => {
  const trace: string[] = [];
  const coordinator = new ToolCoordinator(
    new ToolRegistry([approvalTool(trace)]),
    {},
    undefined,
    {
      authorize(request) {
        assert.equal(Object.isFrozen(request), true);
        assert.equal(Object.isFrozen(request.invocation), true);
        assert.equal(Object.isFrozen(request.invocation.input), true);
        assert.equal(Object.isFrozen(request.resources), true);
        assert.equal(Object.isFrozen(request.resources[0]), true);
        trace.push("approve");
        return { decision: "allow_once" };
      },
    },
  );

  const [result] = await coordinator.execute(
    [{ callId: "approval-call", name: "sensitive_write", input: { path: "target.txt" }, index: 0 }],
    await toolContext(t),
    { dispatching() { trace.push("dispatch"); } },
  );

  assert.deepEqual(trace, ["resources:target.txt", "approve", "dispatch", "execute:target.txt"]);
  assert.equal(result?.result.isError, false);
});

test("malformed or failed host authorization fails closed before dispatch", async (t) => {
  for (const authorize of [
    () => ({ decision: "allow_once", extra: true }) as never,
    () => { throw new Error("approval backend unavailable"); },
  ]) {
    const trace: string[] = [];
    const coordinator = new ToolCoordinator(
      new ToolRegistry([approvalTool(trace)]),
      {},
      undefined,
      {
        authorize,
        afterResult() {
          trace.push("after");
          return { content: "extension claimed success", isError: false };
        },
      },
    );

    const [result] = await coordinator.execute(
      [{ callId: "approval-call", name: "sensitive_write", input: { path: "target.txt" }, index: 0 }],
      await toolContext(t),
      { dispatching() { trace.push("dispatch"); } },
    );

    assert.deepEqual(trace, ["resources:target.txt"]);
    assert.equal(result?.result.isError, true);
    assert.equal(result?.result.content, "Tool authorization failed");
    assert.doesNotMatch(result?.result.content ?? "", /approval backend unavailable/u);
  }
});

test("recovered backend calls are authorized against their final route", async (t) => {
  const trace: string[] = [];
  const backend: ToolExecutionBackend = {
    id: "remote-worker",
    handles(name) { return name === "sensitive_write"; },
    resources() { return [{ kind: "process", key: "remote-worker", mode: "write" }]; },
    async execute() {
      trace.push("backend-execute");
      return { content: "done", isError: false };
    },
  };
  const coordinator = new ToolCoordinator(
    new ToolRegistry([approvalTool(trace)]),
    {},
    undefined,
    {
      authorize(request) {
        assert.equal(request.backendId, "remote-worker");
        assert.equal(request.recovered, true);
        assert.deepEqual(request.resources, [{ kind: "process", key: "remote-worker", mode: "write" }]);
        trace.push("approve");
        return { decision: "allow_once" };
      },
    },
  );

  const [result] = await coordinator.executeRecovered(
    [{ callId: "approval-call", name: "sensitive_write", input: { path: "target.txt" }, index: 0 }],
    { ...await toolContext(t), backend },
    { dispatching() { trace.push("dispatch"); } },
  );

  assert.deepEqual(trace, ["approve", "dispatch", "backend-execute"]);
  assert.equal(result?.result.isError, false);
});
