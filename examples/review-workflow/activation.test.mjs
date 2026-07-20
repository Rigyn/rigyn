import assert from "node:assert/strict";
import test from "node:test";

import activate from "./runtime/index.mjs";

test("review workflow persists the settled child result before returning", async () => {
  let tool;
  let renderer;
  const childRequests = [];
  const stateWrites = [];
  activate({
    registerTool(value) { tool = value; },
    async runChild(input) {
      childRequests.push(input);
      return {
        status: "success",
        summary: "No blocking issue found.",
        nextActions: [],
        threadId: "child-review",
        branch: "main",
        model: { provider: "fixture", model: "fixture" },
        persisted: false,
        finalText: "The parser rejects unknown fields.",
        usage: { totalTokens: 24 },
        artifacts: [],
        artifactCount: 0,
        artifactsTruncated: false,
        execution: { backend: "local", required: false, routedTools: [], localTools: ["read", "grep", "find", "ls"] },
        truncated: false,
      };
    },
    session: {
      registerRenderers(_schema, value) { renderer = value; },
      async appendState(input) {
        stateWrites.push(input);
        return { ...input, extensionId: "review-workflow-example", eventId: "event-review", timestamp: "2026-01-01T00:00:00.000Z" };
      },
    },
  });
  const result = await tool.execute({ objective: "Review parser validation" }, {
    threadId: "thread-review",
    branch: "main",
    signal: new AbortController().signal,
  });
  assert.deepEqual(childRequests[0].tools, ["read", "grep", "find", "ls"]);
  assert.match(childRequests[0].appendSystemPrompt, /independent reviewer/u);
  assert.equal(childRequests[0].session, "ephemeral");
  assert.equal(stateWrites[0].key, "latest-review");
  assert.equal(stateWrites[0].value.status, "success");
  assert.equal(JSON.parse(result.content).stateEventId, "event-review");
  assert.ok(renderer.renderState({ key: "latest-review", value: stateWrites[0].value }));
});
