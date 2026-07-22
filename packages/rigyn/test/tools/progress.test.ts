import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DirectProcessRunner } from "../../src/process/index.js";
import {
  MAX_TOOL_BATCH_PROGRESS_BYTES,
  MAX_TOOL_PROGRESS_BYTES,
  MAX_TOOL_PROGRESS_UPDATES,
  ToolCoordinator,
  ToolRegistry,
  WorkspaceBoundary,
} from "../../src/tools/index.js";
import type { HarnessTool, ToolContext, ToolInvocationProgress } from "../../src/tools/types.js";

async function context(t: { after(callback: () => Promise<void>): void }): Promise<ToolContext> {
  const root = await mkdtemp(join(tmpdir(), "harness-tool-progress-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return {
    workspace: await WorkspaceBoundary.create(root),
    runner: new DirectProcessRunner(),
    signal: new AbortController().signal,
    runId: "run",
    threadId: "thread",
  };
}

test("coordinator correlates, redacts, orders, and failure-isolates parallel progress", async (t) => {
  let releaseA!: () => void;
  let releaseB!: () => void;
  const aReady = new Promise<void>((resolve) => { releaseA = resolve; });
  const bReady = new Promise<void>((resolve) => { releaseB = resolve; });
  const tool: HarnessTool = {
    definition: { name: "parallel", description: "parallel progress", inputSchema: { type: "object" } },
    validate() {},
    resources() { return []; },
    async execute(input, selected) {
      const id = input !== null && typeof input === "object" && !Array.isArray(input) ? String(input.id) : "";
      if (id === "a") {
        selected.reportProgress?.({ type: "output", stream: "stdout", delta: "a-SECRET-1", stdoutBytes: 10, stderrBytes: 0 });
        releaseA();
        await bReady;
        selected.reportProgress?.({ type: "output", stream: "stderr", delta: "a-2", stdoutBytes: 10, stderrBytes: 3 });
      } else {
        await aReady;
        selected.reportProgress?.({ type: "output", stream: "stdout", delta: "b-1", stdoutBytes: 3, stderrBytes: 0 });
        releaseB();
        selected.reportProgress?.({ type: "output", stream: "stderr", delta: "b-2", stdoutBytes: 3, stderrBytes: 3 });
      }
      return { content: `result-${id}`, isError: false };
    },
  };
  const observed: ToolInvocationProgress[] = [];
  const coordinator = new ToolCoordinator(
    new ToolRegistry([tool]),
    { progress() { throw new Error("configured observer failed"); } },
    { text: (value) => value.replaceAll("SECRET", "[redacted]"), value: (value) => value },
  );
  const results = await coordinator.execute([
    { callId: "call-a", name: "parallel", input: { id: "a" }, index: 0 },
    { callId: "call-b", name: "parallel", input: { id: "b" }, index: 1 },
  ], await context(t), {
    progress(update) { observed.push(update); },
  });

  assert.deepEqual(observed.map((entry) => [entry.invocation.callId, entry.sequence]), [
    ["call-a", 0],
    ["call-b", 0],
    ["call-b", 1],
    ["call-a", 1],
  ]);
  assert.equal(observed[0]?.progress.type === "output" ? observed[0].progress.delta : undefined, "a-[redacted]-1");
  assert.deepEqual(results.map((entry) => entry.result.content), ["result-a", "result-b"]);
  assert.doesNotMatch(JSON.stringify(results), /a-\[redacted\]-1/u);
});

test("coordinator delivers redacted replaceable result progress without changing the final observation", async (t) => {
  const tool: HarnessTool = {
    definition: { name: "native-progress", description: "structured progress", inputSchema: { type: "object" } },
    validate() {},
    resources() { return []; },
    async execute(_input, selected) {
      selected.reportProgress?.({
        type: "result",
        content: "working SECRET",
        isError: false,
        metadata: { phase: "running", detail: "SECRET" },
      });
      selected.reportProgress?.({
        type: "result",
        content: "almost done",
        isError: false,
        metadata: { phase: "finishing" },
      });
      return { content: "terminal result", isError: false };
    },
  };
  const updates: ToolInvocationProgress[] = [];
  const coordinator = new ToolCoordinator(
    new ToolRegistry([tool]),
    {},
    {
      text: (value) => value.replaceAll("SECRET", "[redacted]"),
      value: (value) => JSON.parse(JSON.stringify(value).replaceAll("SECRET", "[redacted]")),
    },
  );
  const [result] = await coordinator.execute(
    [{ callId: "native", name: "native-progress", input: {}, index: 0 }],
    await context(t),
    { progress(update) { updates.push(update); } },
  );

  assert.deepEqual(updates.map((entry) => entry.sequence), [0, 1]);
  assert.deepEqual(updates.map((entry) => entry.progress), [
    {
      type: "result",
      content: "working [redacted]",
      isError: false,
      metadata: { phase: "running", detail: "[redacted]" },
    },
    {
      type: "result",
      content: "almost done",
      isError: false,
      metadata: { phase: "finishing" },
    },
  ]);
  assert.equal(result?.result.content, "terminal result");
  assert.doesNotMatch(JSON.stringify(result), /working|almost done/u);
});

test("structured progress saturation preserves the last useful native result", async (t) => {
  const updateLimited: HarnessTool = {
    definition: { name: "result-updates", description: "bounded result updates", inputSchema: { type: "object" } },
    validate() {},
    resources() { return []; },
    async execute(_input, selected) {
      for (let index = 0; index < MAX_TOOL_PROGRESS_UPDATES + 20; index += 1) {
        selected.reportProgress?.({
          type: "result",
          content: `state-${index}`,
          isError: false,
          metadata: { index },
        });
      }
      return { content: "terminal", isError: false };
    },
  };
  const updateBounded: ToolInvocationProgress[] = [];
  const [terminal] = await new ToolCoordinator(new ToolRegistry([updateLimited])).execute(
    [{ callId: "result-updates", name: "result-updates", input: {}, index: 0 }],
    await context(t),
    { progress(update) { updateBounded.push(update); } },
  );

  assert.equal(updateBounded.length, MAX_TOOL_PROGRESS_UPDATES);
  assert.deepEqual(updateBounded.at(-1)?.progress, {
    type: "result",
    content: `state-${MAX_TOOL_PROGRESS_UPDATES - 1}`,
    isError: false,
    metadata: { index: MAX_TOOL_PROGRESS_UPDATES - 1 },
    truncated: true,
  });
  assert.equal(terminal?.result.content, "terminal");

  const byteLimited: HarnessTool = {
    ...updateLimited,
    definition: { ...updateLimited.definition, name: "result-bytes" },
    async execute(_input, selected) {
      selected.reportProgress?.({
        type: "result",
        content: "a".repeat(MAX_TOOL_PROGRESS_BYTES),
        isError: false,
      });
      selected.reportProgress?.({
        type: "result",
        content: "must not replace the useful row",
        isError: false,
      });
      return { content: "terminal", isError: false };
    },
  };
  const byteBounded: ToolInvocationProgress[] = [];
  await new ToolCoordinator(new ToolRegistry([byteLimited])).execute(
    [{ callId: "result-bytes", name: "result-bytes", input: {}, index: 0 }],
    await context(t),
    { progress(update) { byteBounded.push(update); } },
  );
  assert.equal(byteBounded.length, 1);
  const preserved = byteBounded[0]?.progress;
  assert.equal(preserved?.type, "result");
  assert.equal(preserved?.type === "result" ? preserved.content.length : 0, MAX_TOOL_PROGRESS_BYTES);
});

test("coordinator enforces per-invocation update and aggregate byte bounds", async (t) => {
  const spam: HarnessTool = {
    definition: { name: "spam", description: "bounded progress", inputSchema: { type: "object" } },
    validate() {},
    resources() { return []; },
    async execute(_input, selected) {
      for (let index = 1; index <= MAX_TOOL_PROGRESS_UPDATES + 20; index += 1) {
        selected.reportProgress?.({
          type: "output",
          stream: "stdout",
          delta: "x",
          stdoutBytes: index,
          stderrBytes: 0,
        });
      }
      return { content: "done", isError: false };
    },
  };
  const updates: ToolInvocationProgress[] = [];
  await new ToolCoordinator(new ToolRegistry([spam])).execute(
    [{ callId: "spam", name: "spam", input: {}, index: 0 }],
    await context(t),
    { progress(update) { updates.push(update); } },
  );
  assert.equal(updates.length, MAX_TOOL_PROGRESS_UPDATES);
  assert.deepEqual(updates.map((entry) => entry.sequence), Array.from({ length: MAX_TOOL_PROGRESS_UPDATES }, (_, index) => index));
  const lastUpdate = updates.at(-1)?.progress;
  assert.equal(lastUpdate?.type === "output" ? lastUpdate.delta : undefined, "");
  assert.equal(lastUpdate?.truncated, true);

  const large: HarnessTool = {
    ...spam,
    definition: { ...spam.definition, name: "large-progress" },
    async execute(_input, selected) {
      selected.reportProgress?.({
        type: "output",
        stream: "stdout",
        delta: "🙂".repeat(100_000),
        stdoutBytes: 400_000,
        stderrBytes: 0,
      });
      return { content: "done", isError: false };
    },
  };
  const bounded: ToolInvocationProgress[] = [];
  await new ToolCoordinator(new ToolRegistry([large])).execute(
    Array.from({ length: 4 }, (_, index) => ({
      callId: `large-${index}`,
      name: "large-progress",
      input: {},
      index,
    })),
    await context(t),
    { progress(update) { bounded.push(update); } },
  );
  const bytesByCall = new Map<string, number>();
  for (const update of bounded) {
    assert.equal(update.progress.type, "output");
    if (update.progress.type !== "output") continue;
    bytesByCall.set(
      update.invocation.callId,
      (bytesByCall.get(update.invocation.callId) ?? 0) + Buffer.byteLength(update.progress.delta, "utf8"),
    );
  }
  assert.ok([...bytesByCall.values()].every((bytes) => bytes <= MAX_TOOL_PROGRESS_BYTES));
  assert.ok([...bytesByCall.values()].reduce((total, bytes) => total + bytes, 0) <= MAX_TOOL_BATCH_PROGRESS_BYTES);
  assert.ok(bounded.every((update) => update.progress.truncated === true));
  assert.ok(bounded.every((update) => update.progress.type === "output" && !update.progress.delta.endsWith("�")));
});
