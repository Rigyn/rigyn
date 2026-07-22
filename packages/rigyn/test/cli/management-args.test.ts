import assert from "node:assert/strict";
import test from "node:test";

import { parseManagementArguments } from "../../src/cli/management-args.js";

test("management commands accept only their documented flags", () => {
  const sessions = parseManagementArguments([
    "sessions", "doctor", "--json", "--all", "--workspace", "/tmp/work", "--session-dir", "/tmp/sessions",
  ]);
  assert.equal(sessions.command, "sessions");
  assert.equal(sessions.flags.get("workspace"), "/tmp/work");

  assert.throws(
    () => parseManagementArguments(["sessions", "doctor", "--scope", "project"]),
    /--scope is not valid for sessions/u,
  );
  assert.throws(
    () => parseManagementArguments(["sessions", "doctor", "--model", "gpt"]),
    /Unknown flag --model/u,
  );
  assert.throws(
    () => parseManagementArguments(["self-update", "--yes"]),
    /--yes is not valid for self-update/u,
  );
});

test("management value flags do not consume a following option", () => {
  assert.throws(
    () => parseManagementArguments(["sessions", "doctor", "--workspace", "--json"]),
    /--workspace requires a value/u,
  );
  assert.throws(
    () => parseManagementArguments(["install", "package", "--scope", "-l"]),
    /--scope requires a value/u,
  );
});
