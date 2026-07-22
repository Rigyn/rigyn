import assert from "node:assert/strict";
import test from "node:test";

import { BUILTIN_SLASH_COMMANDS } from "../../src/core/slash-commands.js";
import { INTERACTIVE_COMMANDS } from "../../src/interactive/commands.js";

test("built-in discovery follows every visible canonical interactive command", () => {
  assert.deepEqual(
    BUILTIN_SLASH_COMMANDS.map((command) => command.name),
    INTERACTIVE_COMMANDS.filter((command) => !command.hidden && command.palette !== undefined)
      .map((command) => command.name),
  );
  assert.equal(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "share")?.description, "Create redacted share copy");
  assert.equal(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "thinking")?.argumentHint, "[LEVEL]");
});
