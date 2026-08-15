import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DirectProcessRunner } from "../../src/process/index.js";
import { ToolCoordinator, ToolRegistry, WorkspaceBoundary } from "../../src/tools/index.js";
import type { ToolExecutionBackend } from "../../src/tools/index.js";
import type {
  HarnessTool,
  ResourceClaim,
  ToolContext,
} from "../../src/tools/types.js";

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 1_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function toolContext(
  t: { after(callback: () => Promise<void>): void },
  signal = new AbortController().signal,
): Promise<ToolContext> {
  const root = await mkdtemp(join(tmpdir(), "harness-tool-scheduling-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return {
    workspace: await WorkspaceBoundary.create(root),
    runner: new DirectProcessRunner(),
    signal,
    runId: "run",
    threadId: "thread",
  };
}

test("conflicting parallel tools execute in separate source-ordered waves", async (t) => {
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstStarted!: () => void;
  const firstEntered = new Promise<void>((resolve) => { firstStarted = resolve; });
  const trace: string[] = [];
  const tool: HarnessTool = {
    definition: { name: "parallel", description: "parallel fixture", inputSchema: { type: "object" } },
    validate() {},
    resources(input) {
      const id = input !== null && typeof input === "object" && !Array.isArray(input) ? String(input.id) : "";
      return [{ kind: "file", key: id === "c" ? "/workspace/other" : "/workspace/shared", mode: "write" }];
    },
    async execute(input) {
      const id = input !== null && typeof input === "object" && !Array.isArray(input) ? String(input.id) : "";
      trace.push(`start:${id}`);
      if (id === "a") {
        firstStarted();
        await firstReleased;
      }
      trace.push(`end:${id}`);
      return { content: id, isError: false };
    },
  };
  const coordinator = new ToolCoordinator(new ToolRegistry([tool]));
  const running = coordinator.execute([
    { callId: "call-a", name: "parallel", input: { id: "a" }, index: 0 },
    { callId: "call-b", name: "parallel", input: { id: "b" }, index: 1 },
    { callId: "call-c", name: "parallel", input: { id: "c" }, index: 2 },
  ], await toolContext(t));

  await within(firstEntered, "the first resource wave");
  await new Promise<void>((resolve) => setImmediate(resolve));
  let schedulingError: unknown;
  try {
    assert.deepEqual(trace, ["start:a"]);
  } catch (error) {
    schedulingError = error;
  } finally {
    releaseFirst();
  }
  const results = await running;
  if (schedulingError !== undefined) throw schedulingError;
  assert.ok(trace.indexOf("start:c") > trace.indexOf("end:a"));
  assert.deepEqual(results.map((entry) => entry.result.content), ["a", "b", "c"]);
});

test("cancellation in one resource wave prevents later waves from dispatching", async (t) => {
  const controller = new AbortController();
  let firstStarted!: () => void;
  const firstEntered = new Promise<void>((resolve) => { firstStarted = resolve; });
  let secondStarted = false;
  const tool: HarnessTool = {
    definition: { name: "parallel", description: "parallel fixture", inputSchema: { type: "object" } },
    validate() {},
    resources() { return [{ kind: "workspace", key: "workspace", mode: "write" }]; },
    async execute(input, context) {
      const id = input !== null && typeof input === "object" && !Array.isArray(input) ? String(input.id) : "";
      if (id === "b") {
        secondStarted = true;
        return { content: id, isError: false };
      }
      firstStarted();
      return await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(context.signal.reason);
        if (context.signal.aborted) abort();
        else context.signal.addEventListener("abort", abort, { once: true });
      });
    },
  };
  const running = new ToolCoordinator(new ToolRegistry([tool])).execute([
    { callId: "call-a", name: "parallel", input: { id: "a" }, index: 0 },
    { callId: "call-b", name: "parallel", input: { id: "b" }, index: 1 },
  ], await toolContext(t, controller.signal));

  await within(firstEntered, "the cancellable resource wave");
  const reason = new Error("cancel resource wave");
  controller.abort(reason);
  await assert.rejects(running, (error) => error === reason);
  assert.equal(secondStarted, false);
});

test("read claims and unrelated resources share a parallel wave", async (t) => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let allStarted!: () => void;
  const entered = new Promise<void>((resolve) => { allStarted = resolve; });
  const active = new Set<string>();
  const claims = new Map<string, ResourceClaim[]>([
    ["a", [{ kind: "file", key: "/workspace/shared", mode: "read" }]],
    ["b", [{ kind: "file", key: "/workspace/shared/child", mode: "read" }]],
    ["c", [{ kind: "network", key: "api", mode: "write" }]],
  ]);
  const tool: HarnessTool = {
    definition: { name: "parallel", description: "parallel fixture", inputSchema: { type: "object" } },
    validate() {},
    resources(input) {
      const id = input !== null && typeof input === "object" && !Array.isArray(input) ? String(input.id) : "";
      return claims.get(id) ?? [];
    },
    async execute(input) {
      const id = input !== null && typeof input === "object" && !Array.isArray(input) ? String(input.id) : "";
      active.add(id);
      if (active.size === 3) allStarted();
      await released;
      active.delete(id);
      return { content: id, isError: false };
    },
  };
  const coordinator = new ToolCoordinator(new ToolRegistry([tool]));
  const running = coordinator.execute([
    { callId: "call-a", name: "parallel", input: { id: "a" }, index: 0 },
    { callId: "call-b", name: "parallel", input: { id: "b" }, index: 1 },
    { callId: "call-c", name: "parallel", input: { id: "c" }, index: 2 },
  ], await toolContext(t));

  await within(entered, "the parallel resource wave");
  let schedulingError: unknown;
  try {
    assert.deepEqual([...active], ["a", "b", "c"]);
  } catch (error) {
    schedulingError = error;
  } finally {
    release();
  }
  const results = await running;
  if (schedulingError !== undefined) throw schedulingError;
  assert.deepEqual(results.map((entry) => entry.result.content), ["a", "b", "c"]);
});

test("backend resource claims participate in conflict scheduling", async (t) => {
  let releaseRemote!: () => void;
  const remoteReleased = new Promise<void>((resolve) => { releaseRemote = resolve; });
  let remoteStarted!: () => void;
  const remoteEntered = new Promise<void>((resolve) => { remoteStarted = resolve; });
  let localStarted = false;
  const remote: HarnessTool = {
    definition: { name: "remote", description: "remote fixture", inputSchema: { type: "object" } },
    validate() {},
    resources() {
      throw new Error("local resource claims must not be used");
    },
    async execute() {
      throw new Error("local execution must not be used");
    },
  };
  const local: HarnessTool = {
    definition: { name: "local", description: "local fixture", inputSchema: { type: "object" } },
    validate() {},
    resources() { return [{ kind: "file", key: "/workspace/file", mode: "read" }]; },
    async execute() {
      localStarted = true;
      return { content: "local", isError: false };
    },
  };
  const backend: ToolExecutionBackend = {
    id: "fixture",
    handles(name) { return name === "remote"; },
    resources() { return [{ kind: "workspace", key: "workspace", mode: "write" }]; },
    async execute() {
      remoteStarted();
      await remoteReleased;
      return { content: "remote", isError: false };
    },
  };
  const running = new ToolCoordinator(new ToolRegistry([remote, local])).execute([
    { callId: "remote-call", name: "remote", input: {}, index: 0 },
    { callId: "local-call", name: "local", input: {}, index: 1 },
  ], { ...await toolContext(t), backend });

  await within(remoteEntered, "the backend resource wave");
  await new Promise<void>((resolve) => setImmediate(resolve));
  let schedulingError: unknown;
  try {
    assert.equal(localStarted, false);
  } catch (error) {
    schedulingError = error;
  } finally {
    releaseRemote();
  }
  const results = await running;
  if (schedulingError !== undefined) throw schedulingError;
  assert.deepEqual(results.map((entry) => entry.result.content), ["remote", "local"]);
});

test("sequential tools are exclusive barriers between parallel waves", async (t) => {
  let releaseBefore!: () => void;
  const beforeReleased = new Promise<void>((resolve) => { releaseBefore = resolve; });
  let releaseSequential!: () => void;
  const sequentialReleased = new Promise<void>((resolve) => { releaseSequential = resolve; });
  let releaseAfter!: () => void;
  const afterReleased = new Promise<void>((resolve) => { releaseAfter = resolve; });
  let beforeStarted!: () => void;
  const beforeEntered = new Promise<void>((resolve) => { beforeStarted = resolve; });
  let sequentialStarted!: () => void;
  const sequentialEntered = new Promise<void>((resolve) => { sequentialStarted = resolve; });
  let afterStarted!: () => void;
  const afterEntered = new Promise<void>((resolve) => { afterStarted = resolve; });
  const active = new Set<string>();
  let beforeCount = 0;
  let afterCount = 0;
  const fixture = (name: string, executionMode?: "sequential"): HarnessTool => ({
    definition: { name, description: `${name} fixture`, inputSchema: { type: "object" } },
    ...(executionMode === undefined ? {} : { executionMode }),
    validate() {},
    resources() { return [{ kind: "file", key: `/workspace/${name}`, mode: "write" }]; },
    async execute() {
      active.add(name);
      if (name === "a" || name === "b") {
        beforeCount += 1;
        if (beforeCount === 2) beforeStarted();
        await beforeReleased;
      } else if (name === "sequential") {
        sequentialStarted();
        await sequentialReleased;
      } else {
        afterCount += 1;
        if (afterCount === 2) afterStarted();
        await afterReleased;
      }
      active.delete(name);
      return { content: name, isError: false };
    },
  });
  const tools = [
    fixture("a"),
    fixture("b"),
    fixture("sequential", "sequential"),
    fixture("c"),
    fixture("d"),
  ];
  const coordinator = new ToolCoordinator(new ToolRegistry(tools));
  const running = coordinator.execute([
    { callId: "call-a", name: "a", input: {}, index: 0 },
    { callId: "call-b", name: "b", input: {}, index: 1 },
    { callId: "call-sequential", name: "sequential", input: {}, index: 2 },
    { callId: "call-c", name: "c", input: {}, index: 3 },
    { callId: "call-d", name: "d", input: {}, index: 4 },
  ], await toolContext(t));

  let schedulingError: unknown;
  try {
    await within(beforeEntered, "the parallel calls before the sequential barrier");
    assert.deepEqual([...active], ["a", "b"]);
    releaseBefore();

    await within(sequentialEntered, "the sequential barrier");
    assert.deepEqual([...active], ["sequential"]);
    releaseSequential();

    await within(afterEntered, "the parallel calls after the sequential barrier");
    assert.deepEqual([...active], ["c", "d"]);
  } catch (error) {
    schedulingError = error;
  } finally {
    releaseBefore();
    releaseSequential();
    releaseAfter();
  }
  const results = await running;
  if (schedulingError !== undefined) throw schedulingError;
  assert.deepEqual(results.map((entry) => entry.result.content), ["a", "b", "sequential", "c", "d"]);
});

test("invalid resource claims fail before dispatch", async (t) => {
  let executions = 0;
  const excessiveClaims = Array.from(
    { length: 257 },
    (_, index): ResourceClaim => ({ kind: "file", key: `/workspace/${index}`, mode: "read" }),
  );
  const invalidClaims = new Map<string, unknown>([
    ["not-array", null],
    ["invalid-entry", [null]],
    ["invalid-kind", [{ kind: "invalid", key: "/workspace/file", mode: "write" }]],
    ["invalid-key", [{ kind: "file", key: "", mode: "write" }]],
    ["oversized-key", [{ kind: "file", key: "x".repeat(4_097), mode: "write" }]],
    ["invalid-mode", [{ kind: "file", key: "/workspace/file", mode: "invalid" }]],
    ["too-many", excessiveClaims],
  ]);
  const tool: HarnessTool = {
    definition: { name: "invalid_claim", description: "invalid resource fixture", inputSchema: { type: "object" } },
    validate() {},
    resources(input) {
      const id = input !== null && typeof input === "object" && !Array.isArray(input) ? String(input.id) : "";
      return invalidClaims.get(id) as ResourceClaim[];
    },
    async execute() {
      executions += 1;
      return { content: "unsafe", isError: false };
    },
  };
  const ids = [...invalidClaims.keys()];
  const results = await new ToolCoordinator(new ToolRegistry([tool])).execute(
    ids.map((id, index) => ({
      callId: `invalid-claim-${index}`,
      name: "invalid_claim",
      input: { id },
      index,
    })),
    await toolContext(t),
  );

  assert.equal(executions, 0);
  assert.equal(results.every((entry) => entry.result.isError), true);
  assert.match(results[0]?.result.content ?? "", /resource claims must be an array/u);
  assert.match(results[1]?.result.content ?? "", /resource claim is invalid/u);
  assert.match(results[2]?.result.content ?? "", /resource claim kind is invalid/u);
  assert.match(results[3]?.result.content ?? "", /resource claim key is invalid/u);
  assert.match(results[4]?.result.content ?? "", /resource claim key is invalid/u);
  assert.match(results[5]?.result.content ?? "", /resource claim mode is invalid/u);
  assert.match(results[6]?.result.content ?? "", /resource claims must be an array/u);
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

test("tool invocation indexes are distinct nonnegative safe integers before lifecycle work", async (t) => {
  const context = await toolContext(t);
  const cases = [
    {
      name: "duplicate",
      invocations: [
        { callId: "duplicate-a", name: "capture", input: { value: "a" }, index: 0 },
        { callId: "duplicate-b", name: "capture", input: { value: "b" }, index: 0 },
      ],
    },
    { name: "negative", invocations: [{ callId: "negative", name: "capture", input: {}, index: -1 }] },
    { name: "fractional", invocations: [{ callId: "fractional", name: "capture", input: {}, index: 0.5 }] },
    {
      name: "unsafe",
      invocations: [{ callId: "unsafe", name: "capture", input: {}, index: Number.MAX_SAFE_INTEGER + 1 }],
    },
  ];
  const traces = cases.map(() => [] as string[]);
  const outcomes = await Promise.allSettled(cases.map(async (value, caseIndex) => {
    const trace = traces[caseIndex]!;
    const tool: HarnessTool = {
      definition: { name: "capture", description: "capture fixture", inputSchema: { type: "object" } },
      validate() { trace.push("validate"); },
      resources() { trace.push("resources"); return []; },
      async execute() { trace.push("execute"); return { content: "ok", isError: false }; },
    };
    return await new ToolCoordinator(new ToolRegistry([tool]), {
      received() { trace.push("received"); },
      started() { trace.push("started"); },
      completed() { trace.push("completed"); },
    }).execute(value.invocations, context);
  }));

  for (const [caseIndex, outcome] of outcomes.entries()) {
    assert.equal(outcome.status, "rejected", cases[caseIndex]?.name ?? `case ${caseIndex}`);
    if (outcome.status === "rejected") assert.match(String(outcome.reason), /Tool invocation index/u);
    assert.deepEqual(traces[caseIndex], [], cases[caseIndex]?.name ?? `case ${caseIndex}`);
  }

  const sourceOrdered = await new ToolCoordinator(new ToolRegistry([{
    definition: { name: "capture", description: "capture fixture", inputSchema: { type: "object" } },
    validate() {},
    resources() { return []; },
    async execute(input) {
      return {
        content: input !== null && typeof input === "object" && !Array.isArray(input)
          ? String(input.value)
          : "",
        isError: false,
      };
    },
  }])).execute([
    { callId: "sparse-a", name: "capture", input: { value: "a" }, index: 12 },
    { callId: "sparse-b", name: "capture", input: { value: "b" }, index: 2 },
    { callId: "sparse-c", name: "capture", input: { value: "c" }, index: 99 },
  ], context);
  assert.deepEqual(sourceOrdered.map((entry) => [entry.invocation.index, entry.result.content]), [
    [12, "a"],
    [2, "b"],
    [99, "c"],
  ]);
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
