import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ExecutionError,
  FileError,
  convertToLlm,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  createCustomMessage,
  type AfterToolCallResult,
  type AgentContext,
  type AgentEvent,
  type AgentLoopTurnUpdate,
  type BeforeToolCallResult,
  type ToolExecutionMode,
} from "../../src/index.js";

test("root capability errors preserve their public runtime metadata", () => {
  const file = new FileError("permission_denied", "cannot read", "/workspace/private", { operation: "read" });
  const execution = new ExecutionError("timeout", "command timed out", { timeout: 5 });

  assert.equal(file instanceof Error, true);
  assert.deepEqual(
    { name: file.name, message: file.message, code: file.code, path: file.path, details: file.details },
    {
      name: "FileError",
      message: "cannot read",
      code: "permission_denied",
      path: "/workspace/private",
      details: { operation: "read" },
    },
  );
  assert.equal(execution instanceof Error, true);
  assert.deepEqual(
    { name: execution.name, message: execution.message, code: execution.code, details: execution.details },
    {
      name: "ExecutionError",
      message: "command timed out",
      code: "timeout",
      details: { timeout: 5 },
    },
  );
});

test("package exports keep capability implementation modules private", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
    exports: Record<string, unknown>;
  };

  assert.deepEqual(Object.keys(manifest.exports), [
    ".",
    "./node",
    "./runtime",
    "./runtime/*",
    "./session-v4",
    "./package.json",
  ]);
  for (const subpath of [
    "./capabilities/agent-lifecycle",
    "./capabilities/filesystem",
    "./capabilities/process",
  ]) assert.equal(Object.hasOwn(manifest.exports, subpath), false);
});

test("root entrypoint publishes conversation constructors with stable wire timestamps", () => {
  const when = "2026-08-11T12:34:56.000Z";
  const custom = createCustomMessage("notice", "ready", true, { source: "test" }, when);
  const branch = createBranchSummaryMessage("Earlier work", "entry-12", when);
  const compacted = createCompactionSummaryMessage("Condensed work", 4_200, when);

  assert.deepEqual(custom, {
    role: "custom",
    customType: "notice",
    content: "ready",
    display: true,
    details: { source: "test" },
    timestamp: Date.parse(when),
  });
  assert.equal(branch.fromId, "entry-12");
  assert.equal(compacted.tokensBefore, 4_200);
  assert.deepEqual(convertToLlm([branch, compacted, custom]).map((message) => message.content), [
    "Earlier work",
    "Condensed work",
    "ready",
  ]);
});

test("root lifecycle contracts describe hook decisions, turn updates, and event delivery", () => {
  const context: AgentContext = { systemPrompt: "system", messages: [] };
  const before: BeforeToolCallResult = { block: true, reason: "policy", terminate: false };
  const after: AfterToolCallResult = {
    content: [{ type: "text", text: "changed" }],
    details: { reviewed: true },
  };
  const update: AgentLoopTurnUpdate = {
    thinkingLevel: "high",
    context: { ...context, messages: [] },
  };
  const mode: ToolExecutionMode = "sequential";
  const event: AgentEvent = { type: "turn_start", turnIndex: 2, timestamp: 3 };

  assert.deepEqual({ before, after, update, mode, event }, {
    before: { block: true, reason: "policy", terminate: false },
    after: { content: [{ type: "text", text: "changed" }], details: { reviewed: true } },
    update: { thinkingLevel: "high", context: { systemPrompt: "system", messages: [] } },
    mode: "sequential",
    event: { type: "turn_start", turnIndex: 2, timestamp: 3 },
  });
});
