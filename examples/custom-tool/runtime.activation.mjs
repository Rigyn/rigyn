import assert from "node:assert/strict";
import test from "node:test";

import activate from "./runtime/index.mjs";

function activateTool() {
  let registered;
  activate({
    registerTool(tool) {
      registered = tool;
    },
  });
  assert.ok(registered, "the runtime must register its tool");
  return registered;
}

test("text_metrics registers a closed schema and returns deterministic metrics", async () => {
  const tool = activateTool();
  assert.equal(tool.name, "text_metrics");
  assert.deepEqual(tool.inputSchema.required, ["text"]);
  assert.equal(tool.inputSchema.additionalProperties, false);

  const result = await tool.execute({ text: "one two\nthree" });
  assert.equal(result.isError, false);
  assert.equal(result.status, "success");
  assert.equal(result.summary, "Measured 2 lines, 3 words, and 13 UTF-8 bytes.");
  assert.deepEqual(result.nextActions, []);
  assert.deepEqual(JSON.parse(result.content), {
    metrics: { lines: 2, words: 3, bytes: 13 },
  });
});
