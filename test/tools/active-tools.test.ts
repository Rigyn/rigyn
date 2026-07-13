import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DirectProcessRunner } from "../../src/process/index.js";
import { ToolCoordinator, ToolRegistry, WorkspaceBoundary } from "../../src/tools/index.js";
import type { HarnessTool, ToolContext } from "../../src/tools/types.js";

function tool(name: string, execute: HarnessTool["execute"] = async () => ({ content: name, isError: false })): HarnessTool {
  return {
    definition: { name, description: name, inputSchema: { type: "object", additionalProperties: false } },
    validate() {},
    resources() { return []; },
    execute,
  };
}

test("active tool selections validate atomically and preserve required tools", () => {
  const coordinator = new ToolCoordinator(
    new ToolRegistry([tool("core"), tool("one"), tool("two")]),
    {},
    undefined,
    {},
    { activeTools: ["core", "one"], requiredTools: ["core"] },
  );
  assert.deepEqual(coordinator.activeToolNames(), ["core", "one"]);
  assert.throws(() => coordinator.queueActiveTools(["one"]), /Required tool cannot be deactivated/u);
  assert.throws(() => coordinator.queueActiveTools(["core", "missing"]), /Unknown registered tool/u);
  assert.throws(() => coordinator.queueActiveTools(["core", "core"]), /Duplicate active tool/u);
  assert.deepEqual(coordinator.activeToolNames(), ["core", "one"]);

  coordinator.queueActiveTools(["two", "core"]);
  assert.deepEqual(coordinator.activeToolNames(), ["two", "core"]);
  assert.deepEqual(coordinator.appliedToolNames(), ["core", "one"]);
  const snapshot = coordinator.turnSnapshot();
  assert.equal(snapshot.changed, true);
  assert.equal(snapshot.revision, 1);
  assert.deepEqual(snapshot.names, ["two", "core"]);
  assert.deepEqual(snapshot.definitions.map((entry) => entry.name), ["two", "core"]);
  assert.equal(coordinator.turnSnapshot().changed, false);
  coordinator.queueActiveTools(["core", "two"]);
  const reordered = coordinator.turnSnapshot();
  assert.equal(reordered.changed, true);
  assert.equal(reordered.revision, 2);
  assert.deepEqual(reordered.names, ["core", "two"]);
});

test("a selection queued during execution cannot alter or interrupt the active batch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-active-tools-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = await WorkspaceBoundary.create(root);
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const coordinator = new ToolCoordinator(
    new ToolRegistry([tool("slow", async () => {
      started();
      await wait;
      return { content: "finished", isError: false };
    })]),
  );
  const context: ToolContext = {
    workspace,
    runner: new DirectProcessRunner(),
    eventSink: { async emit() { throw new Error("not used"); } },
    signal: new AbortController().signal,
    runId: "run",
    threadId: "thread",
  };
  const execution = coordinator.execute([{ callId: "call", name: "slow", input: {}, index: 0 }], context);
  await running;
  coordinator.queueActiveTools([]);
  assert.deepEqual(coordinator.appliedToolNames(), ["slow"]);
  assert.throws(() => coordinator.turnSnapshot(), /while a tool batch is executing/u);
  release();
  const [result] = await execution;
  assert.equal(result?.result.content, "finished");
  assert.equal(coordinator.turnSnapshot().changed, true);
  assert.deepEqual(coordinator.definitions(), []);
});
