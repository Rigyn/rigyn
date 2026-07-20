import assert from "node:assert/strict";
import test from "node:test";

import activate from "./runtime/index.mjs";

test("session tools preserve workspace-scoped cursors and explicit transcript targets", async () => {
  let tool;
  let command;
  const calls = [];
  activate({
    registerTool(value) { tool = value; },
    registerCommand(value) { command = value; },
    async listSessions(input) {
      calls.push({ method: "list", input });
      return {
        schemaVersion: 1,
        sessions: [{
          threadId: "thread-one",
          name: "Parser work",
          defaultBranch: "main",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T01:00:00.000Z",
        }],
        nextCursor: "cursor-two",
        hasMore: true,
      };
    },
    async getTranscript(input) {
      calls.push({ method: "transcript", input });
      return {
        schemaVersion: 1,
        threadId: input.threadId,
        branch: input.branch,
        entries: [{
          kind: "message",
          role: "user",
          messageId: "message-6",
          eventId: "event-6",
          sequence: 6,
          timestamp: "2026-01-01T01:00:00.000Z",
          text: "Continue the parser work.",
        }],
        nextSequence: 6,
        hasMore: true,
        truncated: false,
      };
    },
    async setSessionName(input) {
      calls.push({ method: "name", input });
      return { threadId: input.threadId, branch: input.branch, name: input.name };
    },
  });
  const signal = new AbortController().signal;
  const listed = await tool.execute({ action: "list", search: "parser", limit: 5 }, { signal });
  const transcript = await tool.execute({ action: "transcript", threadId: "thread-one", branch: "main", afterSequence: 5, limit: 5 }, { signal });
  const notices = [];
  await command.execute({
    args: "Parser work",
    threadId: "thread-one",
    branch: "main",
    signal,
    ui: { notify(message, kind) { notices.push({ message, kind }); } },
  });

  assert.equal(JSON.parse(listed.content).nextCursor, "cursor-two");
  assert.equal(JSON.parse(transcript.content).nextSequence, 6);
  assert.equal(calls[0].input.search, "parser");
  assert.equal(calls[1].input.afterSequence, 5);
  assert.equal(calls[2].input.name, "Parser work");
  assert.deepEqual(notices, [{ message: "Session named Parser work.", kind: undefined }]);
});
