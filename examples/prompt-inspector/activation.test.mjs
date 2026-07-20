import assert from "node:assert/strict";
import test from "node:test";

import activate from "./runtime/index.mjs";

test("prompt inspector never copies snapshot text into its visible output", async () => {
  let command;
  const notices = [];
  const secretMarker = "PROJECT_INSTRUCTION_MUST_NOT_BE_ECHOED";
  activate({
    registerCommand(value) { command = value; },
    async getSystemPromptSnapshot(input) {
      return {
        threadId: input.threadId,
        branch: input.branch,
        text: secretMarker,
        bytes: 38,
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        redacted: true,
        model: { provider: "fixture", model: "fixture" },
      };
    },
  });
  await command.execute({
    args: "",
    threadId: "thread-prompt",
    branch: "main",
    signal: new AbortController().signal,
    ui: { notify(message, kind) { notices.push({ message, kind }); } },
  });
  assert.equal(notices.length, 1);
  assert.equal(notices[0].message.includes(secretMarker), false);
  assert.match(notices[0].message, /38 bytes/u);
  assert.match(notices[0].message, /0123456789abcdef/u);
  assert.match(notices[0].message, /redacted/u);
});

test("prompt inspector explains an absent snapshot", async () => {
  let command;
  const notices = [];
  activate({
    registerCommand(value) { command = value; },
    async getSystemPromptSnapshot() { return undefined; },
  });
  await command.execute({
    args: "",
    threadId: "empty",
    signal: new AbortController().signal,
    ui: { notify(message, kind) { notices.push({ message, kind }); } },
  });
  assert.deepEqual(notices, [{ message: "No durable prompt snapshot is available for this branch.", kind: "warning" }]);
});
