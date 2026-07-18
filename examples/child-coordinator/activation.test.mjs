import assert from "node:assert/strict";
import test from "node:test";

import activate from "./runtime/index.mjs";

test("child coordinator waits for all children and reports native progress", async () => {
  let tool;
  const started = [];
  activate({
    registerTool(value) { tool = value; },
    async runChild(input) {
      const index = started.length;
      started.push(input);
      input.onStart({
        threadId: `child-${index}`,
        branch: "main",
        model: { provider: "fixture", model: "fixture" },
        persisted: false,
      });
      input.onEvent({
        threadId: `child-${index}`,
        branch: "main",
        sequence: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        event: { type: "text_delta", text: `result ${index}`, part: 0 },
      });
      return {
        status: "success",
        summary: `review ${index} complete`,
        nextActions: [],
        finalText: `result ${index}`,
        truncated: false,
        threadId: `child-${index}`,
        branch: "main",
        model: { provider: "fixture", model: "fixture" },
        persisted: false,
        usage: { totalTokens: index + 1 },
        execution: { backend: "local", required: false, routedTools: [], localTools: [] },
        artifacts: [],
        artifactCount: 0,
        artifactsTruncated: false,
      };
    },
  });
  const progress = [];
  const controller = new AbortController();
  const result = await tool.execute({ tasks: ["review auth", "review storage"] }, {
    threadId: "parent",
    branch: "main",
    signal: controller.signal,
    reportProgress(update) { progress.push(update); },
  });

  assert.equal(started.length, 2);
  assert.deepEqual(started.map((input) => input.tools), [
    ["read", "grep", "find", "ls"],
    ["read", "grep", "find", "ls"],
  ]);
  assert.equal(started.every((input) => input.context === "fork" && input.session === "ephemeral"), true);
  assert.equal(result.status, "success");
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.content).results.map((entry) => entry.finalText), ["result 0", "result 1"]);
  assert.ok(progress.length >= 3);
  assert.equal(JSON.parse(progress.at(-1).content).children.every((row) => row.state === "success"), true);
});

test("child coordinator propagates parent cancellation to each child", async () => {
  let tool;
  const childSignals = [];
  activate({
    registerTool(value) { tool = value; },
    runChild(input) {
      childSignals.push(input.signal);
      return new Promise((resolve) => input.signal.addEventListener("abort", () => resolve({
        status: "cancelled",
        summary: "cancelled",
        nextActions: [],
        finalText: "",
        truncated: false,
        threadId: `child-${childSignals.length}`,
        branch: "main",
        model: { provider: "fixture", model: "fixture" },
        persisted: false,
        usage: {},
        execution: { backend: "local", required: false, routedTools: [], localTools: [] },
        artifacts: [],
        artifactCount: 0,
        artifactsTruncated: false,
      }), { once: true }));
    },
  });
  const controller = new AbortController();
  const running = tool.execute({ tasks: ["one", "two"] }, {
    threadId: "parent",
    branch: "main",
    signal: controller.signal,
  });
  controller.abort(new Error("stop batch"));
  const result = await running;
  assert.equal(childSignals.every((signal) => signal.aborted), true);
  assert.equal(result.status, "error");
  assert.equal(result.isError, true);
});
