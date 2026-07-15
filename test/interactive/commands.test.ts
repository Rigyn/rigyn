import assert from "node:assert/strict";
import test from "node:test";

import { builtinSlashCommands } from "../../src/extensions/reserved.js";
import {
  INTERACTIVE_COMMANDS,
  interactiveCommand,
  interactiveCommandNames,
  interactiveCommandPalette,
  parseInteractiveExportRequest,
  renderInteractiveCommandHelp,
} from "../../src/interactive/commands.js";

test("interactive command registry owns names, aliases, visibility, and active policy", () => {
  const names = INTERACTIVE_COMMANDS.map((command) => command.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(builtinSlashCommands(), interactiveCommandNames());
  for (const command of INTERACTIVE_COMMANDS) {
    assert.ok(["cancel", "follow_up", "defer"].includes(command.activePolicy));
    if (command.aliasFor !== undefined) assert.notEqual(interactiveCommand(command.aliasFor), undefined);
    if (command.hidden) assert.equal(command.palette, undefined);
  }
  assert.equal(interactiveCommand("cancel")?.activePolicy, "cancel");
  assert.equal(interactiveCommand("follow")?.activePolicy, "follow_up");
  for (const name of ["model", "settings", "compact", "resume", "fork", "tree", "login", "logout", "quit", "prompt", "skill"]) {
    assert.notEqual(interactiveCommand(name), undefined, name);
  }
});

test("palette and help are generated from visible registry metadata", () => {
  const palette = interactiveCommandPalette();
  assert.equal(palette.some((item) => item.value === "/model"), true);
  assert.equal(palette.some((item) => item.value === "/settings"), true);
  assert.equal(palette.some((item) => item.value === "/follow"), false);
  const help = renderInteractiveCommandHelp();
  assert.match(help, /\/model \[PROVIDER\/MODEL\]/u);
  assert.match(help, /\/compact \[INSTRUCTIONS\]/u);
  assert.match(help, /\/export \[--redact\] \[FILE\]/u);
  assert.match(help, /\/resume/u);
  assert.equal(help.split("\n").every((line) => line.length <= 80), true);
  assert.match(help, /\/quit/u);
  assert.doesNotMatch(help, /\/follow TEXT\s+\/follow/u);
});

test("interactive export recognizes the optional leading redaction flag", () => {
  assert.deepEqual(parseInteractiveExportRequest(""), { redact: false, pathArgument: "" });
  assert.deepEqual(parseInteractiveExportRequest(" transcript.md "), {
    redact: false,
    pathArgument: "transcript.md",
  });
  assert.deepEqual(parseInteractiveExportRequest("--redact"), { redact: true, pathArgument: "" });
  assert.deepEqual(parseInteractiveExportRequest(' --redact   "share copy.md" '), {
    redact: true,
    pathArgument: '"share copy.md"',
  });
});
