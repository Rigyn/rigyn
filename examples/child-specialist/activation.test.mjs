import assert from "node:assert/strict";
import test from "node:test";

import activate from "./runtime/index.mjs";

function childResult() {
  return {
    status: "success",
    summary: "Focused review complete.",
    nextActions: [],
    threadId: "child-specialist",
    branch: "main",
    model: { provider: "fixture", model: "fixture" },
    persisted: false,
    finalText: "One evidence-backed finding.",
    usage: { totalTokens: 18 },
    artifacts: [],
    artifactCount: 0,
    artifactsTruncated: false,
    execution: { backend: "local", required: false, routedTools: [], localTools: ["read", "grep", "find", "ls"] },
    truncated: false,
  };
}

test("child specialist selects replacement or appended instructions without widening tools", async () => {
  let tool;
  const requests = [];
  activate({
    registerTool(value) { tool = value; },
    async runChild(input) {
      requests.push(input);
      return childResult();
    },
  });
  const context = {
    threadId: "parent",
    branch: "review",
    signal: new AbortController().signal,
  };
  await tool.execute({ objective: "Check the parser", promptMode: "append" }, context);
  await tool.execute({ objective: "Check the store", promptMode: "replace" }, context);

  assert.deepEqual(requests.map((request) => request.tools), [
    ["read", "grep", "find", "ls"],
    ["read", "grep", "find", "ls"],
  ]);
  assert.match(requests[0].appendSystemPrompt, /stay read-only/u);
  assert.equal(requests[0].systemPrompt, undefined);
  assert.match(requests[1].systemPrompt, /code-review specialist/u);
  assert.equal(requests[1].appendSystemPrompt, undefined);
  assert.equal(requests.every((request) => request.context === "fork" && request.session === "ephemeral"), true);
});
