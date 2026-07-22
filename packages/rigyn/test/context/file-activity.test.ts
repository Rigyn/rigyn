import assert from "node:assert/strict";
import test from "node:test";

import {
  collectCompactionFileActivity,
  parseCompactionFileActivity,
  renderCompactionFileActivity,
  stripCompactionFileActivity,
} from "../../src/context/file-activity.js";
import type { CanonicalMessage, ContentBlock } from "../../src/core/types.js";

function message(id: string, role: CanonicalMessage["role"], content: ContentBlock[], purpose?: CanonicalMessage["purpose"]): CanonicalMessage {
  return { id, role, content, createdAt: new Date(0).toISOString(), ...(purpose === undefined ? {} : { purpose }) };
}

test("file activity retains prior summaries and successful built-in file operations", () => {
  const previous = renderCompactionFileActivity({
    readFiles: ["src/old.ts"],
    modifiedFiles: ["src/earlier.ts"],
  }, 1_000);
  const messages: CanonicalMessage[] = [
    message("summary", "user", [{ type: "text", text: `prior${previous.text}` }], "compaction"),
    message("calls", "assistant", [
      { type: "tool_call", callId: "read", name: "read", arguments: { path: "src/current.ts" } },
      { type: "tool_call", callId: "grep", name: "grep", arguments: { pattern: "current", path: "src/grep" } },
      { type: "tool_call", callId: "find", name: "find", arguments: { pattern: "**/*.ts", path: "src/find" } },
      { type: "tool_call", callId: "ls", name: "ls", arguments: { path: "src/ls" } },
      { type: "tool_call", callId: "write", name: "write", arguments: { path: "src/new.ts", content: "value" } },
      { type: "tool_call", callId: "failed", name: "edit", arguments: { path: "src/failed.ts", oldText: "a", newText: "b" } },
      {
        type: "tool_call",
        callId: "patch",
        name: "apply_patch",
        arguments: { patch: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: src/b.ts\n+new\n*** End Patch" },
      },
    ]),
    message("results", "tool", [
      { type: "tool_result", callId: "read", name: "read", content: "ok", isError: false },
      { type: "tool_result", callId: "grep", name: "grep", content: "ok", isError: false },
      { type: "tool_result", callId: "find", name: "find", content: "ok", isError: false },
      { type: "tool_result", callId: "ls", name: "ls", content: "ok", isError: false },
      { type: "tool_result", callId: "write", name: "write", content: "ok", isError: false },
      { type: "tool_result", callId: "failed", name: "edit", content: "failed", isError: true },
      { type: "tool_result", callId: "patch", name: "apply_patch", content: "ok", isError: false },
    ]),
  ];

  assert.deepEqual(collectCompactionFileActivity(messages), {
    readFiles: ["src/old.ts", "src/current.ts", "src/grep", "src/find", "src/ls"],
    modifiedFiles: ["src/earlier.ts", "src/new.ts", "src/a.ts", "src/b.ts"],
  });
});

test("file activity notes are machine-readable, removable, and token-bounded", () => {
  const activity = {
    readFiles: Array.from({ length: 100 }, (_, index) => `src/read-${index}.ts`),
    modifiedFiles: Array.from({ length: 100 }, (_, index) => `src/write-${index}.ts`),
  };
  const rendered = renderCompactionFileActivity(activity, 80);
  assert.ok(rendered.estimatedTokens <= 80);
  assert.ok(rendered.activity.readFiles.length + rendered.activity.modifiedFiles.length < 200);
  assert.deepEqual(parseCompactionFileActivity(`summary${rendered.text}`), rendered.activity);
  assert.equal(stripCompactionFileActivity(`summary${rendered.text}`), "summary");
  assert.equal(stripCompactionFileActivity("ordinary text [rigyn-file-activity-v1]"), "ordinary text [rigyn-file-activity-v1]");
});

test("file activity ignores malformed, control-bearing, oversized, and unsuccessful paths", () => {
  const messages = [
    message("calls", "assistant", [
      { type: "tool_call", callId: "control", name: "read", arguments: { path: "src/unsafe\nname" } },
      { type: "tool_call", callId: "oversized", name: "write", arguments: { path: "x".repeat(5_000), content: "" } },
      { type: "tool_call", callId: "unknown", name: "shell", arguments: { command: "touch hidden" } },
    ]),
    message("results", "tool", [
      { type: "tool_result", callId: "control", name: "read", content: "ok", isError: false },
      { type: "tool_result", callId: "oversized", name: "write", content: "ok", isError: false },
      { type: "tool_result", callId: "unknown", name: "shell", content: "ok", isError: false },
    ]),
  ];
  assert.deepEqual(collectCompactionFileActivity(messages), { readFiles: [], modifiedFiles: [] });
});
