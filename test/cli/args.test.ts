import assert from "node:assert/strict";
import test from "node:test";
import { flagBoolean, flagString, parseArguments } from "../../src/cli/args.js";

test("list-models accepts an optional search without consuming the next flag", () => {
  const all = parseArguments(["--list-models", "--offline"]);
  assert.equal(all.flags.get("list-models"), true);
  assert.equal(flagBoolean(all, "offline"), true);

  const filtered = parseArguments(["--list-models", "codex", "--offline"]);
  assert.equal(flagString(filtered, "list-models"), "codex");
  assert.equal(flagBoolean(filtered, "offline"), true);
});

test("mode and export retain their required values", () => {
  const parsed = parseArguments(["--mode", "json", "--export", "session.html", "--redact"]);
  assert.equal(flagString(parsed, "mode"), "json");
  assert.equal(flagString(parsed, "export"), "session.html");
  assert.equal(flagBoolean(parsed, "redact"), true);
  assert.throws(() => parseArguments(["--mode"]), /--mode requires a value/u);
  assert.throws(() => parseArguments(["--export", "--offline"]), /--export requires a value/u);
});

test("tool short flags map to include and exclude lists", () => {
  const parsed = parseArguments(["-t", "read,bash", "-xt", "write"]);
  assert.equal(flagString(parsed, "tools"), "read,bash");
  assert.equal(flagString(parsed, "exclude-tools"), "write");
});

test("extension diagnostics are parsed as a command instead of an agent prompt", () => {
  const parsed = parseArguments(["extensions", "doctor"]);
  assert.equal(parsed.command, "extensions");
  assert.deepEqual(parsed.positionals, ["doctor"]);
});

test("redacted diagnostics are parsed as a command with an optional output file", () => {
  const parsed = parseArguments(["diagnostics", "support.json"]);
  assert.equal(parsed.command, "diagnostics");
  assert.deepEqual(parsed.positionals, ["support.json"]);
});

test("session maintenance requires an explicit command and repair flags", () => {
  const parsed = parseArguments(["sessions", "repair", "--reindex", "--yes"]);
  assert.equal(parsed.command, "sessions");
  assert.deepEqual(parsed.positionals, ["repair"]);
  assert.equal(flagBoolean(parsed, "reindex"), true);
  assert.equal(flagBoolean(parsed, "yes"), true);
});

test("dependency lifecycle opt-in parses as an explicit boolean for package commands and invocations", () => {
  const install = parseArguments(["install", "npm:reviewed-tools", "--allow-scripts"]);
  assert.equal(install.command, "install");
  assert.equal(flagBoolean(install, "allow-scripts"), true);

  const invocation = parseArguments(["--package", "npm:reviewed-tools", "--allow-scripts", "inspect this project"]);
  assert.equal(flagBoolean(invocation, "allow-scripts"), true);
  assert.deepEqual(invocation.flags.get("package"), ["npm:reviewed-tools"]);
});
