import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DirectProcessRunner } from "../../src/process/index.js";
import { ToolCoordinator, ToolRegistry, WorkspaceBoundary } from "../../src/tools/index.js";
import type { HarnessTool, ToolContext } from "../../src/tools/types.js";

async function toolContext(t: { after(callback: () => Promise<void>): void }): Promise<ToolContext> {
  const root = await mkdtemp(join(tmpdir(), "harness-tool-scheduling-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return {
    workspace: await WorkspaceBoundary.create(root),
    runner: new DirectProcessRunner(),
    signal: new AbortController().signal,
    runId: "run",
    threadId: "thread",
  };
}

test("parallel tools execute together even when their resource claims conflict", async (t) => {
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const trace: string[] = [];
  const tool: HarnessTool = {
    definition: { name: "parallel", description: "parallel fixture", inputSchema: { type: "object" } },
    validate() {},
    resources() { return [{ kind: "workspace", key: "workspace", mode: "write" }]; },
    async execute(input) {
      const id = input !== null && typeof input === "object" && !Array.isArray(input) ? String(input.id) : "";
      trace.push(`start:${id}`);
      if (id === "a") await firstReleased;
      trace.push(`end:${id}`);
      return { content: id, isError: false };
    },
  };
  const coordinator = new ToolCoordinator(new ToolRegistry([tool]));
  const running = coordinator.execute([
    { callId: "call-a", name: "parallel", input: { id: "a" }, index: 0 },
    { callId: "call-b", name: "parallel", input: { id: "b" }, index: 1 },
  ], await toolContext(t));

  await new Promise<void>((resolve) => setImmediate(resolve));
  let schedulingError: unknown;
  try {
    assert.deepEqual(trace, ["start:a", "start:b", "end:b"]);
  } catch (error) {
    schedulingError = error;
  } finally {
    releaseFirst();
  }
  const results = await running;
  if (schedulingError !== undefined) throw schedulingError;
  assert.deepEqual(results.map((entry) => entry.result.content), ["a", "b"]);
});

test("one sequential tool makes the entire provider-ordered batch sequential", async (t) => {
  const trace: string[] = [];
  let active = 0;
  let overlapped = false;
  const fixture = (name: string, executionMode?: "sequential"): HarnessTool => ({
    definition: { name, description: `${name} fixture`, inputSchema: { type: "object" } },
    ...(executionMode === undefined ? {} : { executionMode }),
    validate() {},
    resources() { return []; },
    async execute() {
      trace.push(`start:${name}`);
      active += 1;
      if (active > 1) overlapped = true;
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      trace.push(`end:${name}`);
      return { content: name, isError: false };
    },
  });
  const tools = [fixture("a"), fixture("b"), fixture("sequential", "sequential")];
  const coordinator = new ToolCoordinator(new ToolRegistry(tools));
  const results = await coordinator.execute([
    { callId: "call-a", name: "a", input: {}, index: 0 },
    { callId: "call-b", name: "b", input: {}, index: 1 },
    { callId: "call-sequential", name: "sequential", input: {}, index: 2 },
  ], await toolContext(t));

  assert.equal(overlapped, false);
  assert.deepEqual(trace, [
    "start:a", "end:a",
    "start:b", "end:b",
    "start:sequential", "end:sequential",
  ]);
  assert.deepEqual(results.map((entry) => entry.result.content), ["a", "b", "sequential"]);
});

test("tool execution receives the provider tool-call id unchanged", async (t) => {
  const received: string[] = [];
  const tool: HarnessTool = {
    definition: { name: "capture", description: "capture call id", inputSchema: { type: "object" } },
    validate() {},
    resources() { return []; },
    async execute(_input, context) {
      received.push(context.toolCallId);
      return { content: context.toolCallId, isError: false };
    },
  };
  const coordinator = new ToolCoordinator(new ToolRegistry([tool]));

  const results = await coordinator.execute([
    { callId: "provider-call-42", name: "capture", input: {}, index: 0 },
  ], await toolContext(t));

  assert.deepEqual(received, ["provider-call-42"]);
  assert.equal(results[0]?.result.content, "provider-call-42");
});

test("queued registry replacement preserves the in-flight batch and applies at the next turn snapshot", async (t) => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const executing = new Promise<void>((resolve) => { started = resolve; });
  const oldTool: HarnessTool = {
    definition: { name: "old_tool", description: "old fixture", inputSchema: { type: "object" } },
    validate() {},
    resources: () => [],
    async execute() {
      started();
      await released;
      return { content: "old", isError: false };
    },
  };
  const nextTool: HarnessTool = {
    definition: { name: "next_tool", description: "next fixture", inputSchema: { type: "object" } },
    validate() {},
    resources: () => [],
    async execute() { return { content: "next", isError: false }; },
  };
  const coordinator = new ToolCoordinator(new ToolRegistry([oldTool]));
  const running = coordinator.execute([
    { callId: "old-call", name: "old_tool", input: {}, index: 0 },
  ], await toolContext(t));
  await executing;

  coordinator.queueTools([nextTool]);
  assert.throws(() => coordinator.turnSnapshot(), /batch is executing/u);
  release();
  assert.equal((await running)[0]?.result.content, "old");

  assert.deepEqual(coordinator.turnSnapshot().names, ["next_tool"]);
  const next = await coordinator.execute([
    { callId: "next-call", name: "next_tool", input: {}, index: 0 },
  ], await toolContext(t));
  assert.equal(next[0]?.result.content, "next");
});
