import assert from "node:assert/strict";
import test from "node:test";

import type { ToolResultBlock } from "../../src/core/types.js";
import { toolResultText } from "../../src/providers/tool-results.js";

function result(overrides: Partial<ToolResultBlock> = {}): ToolResultBlock {
  return {
    type: "tool_result",
    callId: "call-1",
    name: "read",
    content: "File could not be read.",
    isError: true,
    ...overrides,
  };
}

test("legacy tool results retain their exact provider-visible text", () => {
  assert.equal(toolResultText(result()), "File could not be read.");
});

test("structured tool results expose status, summary, details, and recovery actions to the model", () => {
  assert.equal(toolResultText(result({
    status: "error",
    summary: "Read failed",
    nextActions: ["Correct the path and retry once.", "Stop if the file does not exist."],
  })), [
    "Status: error",
    "Summary: Read failed",
    "Details:",
    "File could not be read.",
    "Next actions:",
    "- Correct the path and retry once.",
    "- Stop if the file does not exist.",
  ].join("\n"));
});
