import assert from "node:assert/strict";
import test from "node:test";

import {
  findLeadingManagementCommand,
  parseManagementArguments,
} from "../../src/cli/management-args.js";

test("management command discovery respects option values and the literal boundary", () => {
  assert.equal(findLeadingManagementCommand(["--offline", "config", "--", "path"]), "config");
  assert.equal(findLeadingManagementCommand(["--workspace", "/tmp/work", "serve"]), "serve");
  assert.equal(findLeadingManagementCommand(["--offline", "--", "config", "path"]), undefined);
  assert.equal(findLeadingManagementCommand(["--model", "config", "prompt"]), undefined);
  assert.equal(findLeadingManagementCommand(["--print=config"]), undefined);
});

test("management commands accept only their documented flags", () => {
  const sessions = parseManagementArguments([
    "sessions", "doctor", "--json", "--all", "--workspace", "/tmp/work", "--session-dir", "/tmp/sessions",
  ]);
  assert.equal(sessions.command, "sessions");
  assert.equal(sessions.flags.get("workspace"), "/tmp/work");

  const serve = parseManagementArguments([
    "serve", "--host", "127.0.0.1", "--port", "4317", "--workspace", "/tmp/work",
    "--session-dir", "/tmp/sessions", "--offline", "--no-extensions",
  ]);
  assert.equal(serve.command, "serve");
  assert.equal(serve.flags.get("port"), "4317");

  const stats = parseManagementArguments(["stats", "--json"]);
  assert.equal(stats.command, "stats");
  assert.equal(stats.flags.get("json"), true);

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
  assert.throws(
    () => parseManagementArguments(["serve", "--json"]),
    /--json is not valid for serve/u,
  );
  assert.throws(
    () => parseManagementArguments(["stats", "--workspace", "/tmp/work"]),
    /--workspace is not valid for stats/u,
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
