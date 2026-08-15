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
import { INTERACTIVE_BUILTIN_COMMANDS } from "../../src/modes/interactive-command-coordinator.js";

test("interactive command registry owns names, aliases, visibility, and active policy", () => {
  const removedCommand = ["/re", "load"].join("");
  const names = INTERACTIVE_COMMANDS.map((command) => command.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(builtinSlashCommands(), interactiveCommandNames());
  for (const command of INTERACTIVE_COMMANDS) {
    assert.ok(["cancel", "follow_up", "dispatch", "interrupt", "defer", "reject"].includes(command.activePolicy));
    if (command.aliasFor !== undefined) assert.notEqual(interactiveCommand(command.aliasFor), undefined);
    if (command.hidden) assert.equal(command.palette, undefined);
  }
  assert.equal(interactiveCommand("cancel")?.activePolicy, "cancel");
  assert.equal(interactiveCommand("follow")?.activePolicy, "follow_up");
  assert.equal(interactiveCommand("settings")?.activePolicy, "dispatch");
  assert.equal(interactiveCommand("model")?.activePolicy, "dispatch");
  assert.equal(interactiveCommand("tree")?.activePolicy, "dispatch");
  assert.equal(interactiveCommand("refresh")?.activePolicy, "interrupt");
  assert.equal(interactiveCommand("new")?.activePolicy, "interrupt");
  assert.equal(interactiveCommand("models")?.activePolicy, interactiveCommand("model")?.activePolicy);
  assert.equal(interactiveCommand("clear")?.activePolicy, interactiveCommand("new")?.activePolicy);
  for (const name of [
    "settings", "model", "thinking", "scoped-models", "export", "share", "changelog", "copy",
    "name", "session", "context", "resources", "hotkeys", "tree", "trust", "login", "help",
  ]) assert.equal(interactiveCommand(name)?.activePolicy, "dispatch", name);
  for (const name of [
    "logout", "import", "fork", "clone", "new", "compact", "resume", "recover", "refresh", "quit",
  ]) assert.equal(interactiveCommand(name)?.activePolicy, "interrupt", name);
  const builtins = new Set<string>(INTERACTIVE_BUILTIN_COMMANDS);
  assert.deepEqual(
    INTERACTIVE_COMMANDS
      .filter((command) => builtins.has(command.aliasFor ?? command.name))
      .filter((command) => command.activePolicy === "defer" || command.activePolicy === "reject")
      .map((command) => command.name),
    [],
  );
  assert.equal(interactiveCommand(removedCommand.slice(1)), undefined);
  assert.equal(interactiveCommand("models")?.aliasFor, "model");
  for (const name of ["model", "thinking", "settings", "compact", "resume", "fork", "tree", "login", "logout", "quit", "prompt", "skill"]) {
    assert.notEqual(interactiveCommand(name), undefined, name);
  }
});

test("palette and help are generated from visible registry metadata", () => {
  const removedCommand = ["/re", "load"].join("");
  const palette = interactiveCommandPalette();
  assert.equal(palette.some((item) => item.value === "/model"), true);
  assert.equal(palette.some((item) => item.value === "/thinking"), true);
  assert.equal(palette.some((item) => item.value === "/settings"), true);
  assert.equal(palette.some((item) => item.value === "/follow"), false);
  assert.match(
    palette.find((item) => item.value === "/refresh")?.label ?? "",
    /keyboard mappings, extensions, skills, prompt templates, themes, and instruction files/u,
  );
  const help = renderInteractiveCommandHelp();
  assert.match(help, /\/refresh/u);
  assert.equal(help.includes(removedCommand), false);
  assert.match(help, /\/model \[PROVIDER\/MODEL\]/u);
  assert.doesNotMatch(help, /\/models/u);
  assert.match(help, /\/thinking \[LEVEL\]/u);
  assert.match(help, /\/compact \[INSTRUCTIONS\]/u);
  assert.match(help, /\/export \[--redact\] \[FILE\]/u);
  assert.match(help, /\/resume \[--all\|SESSION\]/u);
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
