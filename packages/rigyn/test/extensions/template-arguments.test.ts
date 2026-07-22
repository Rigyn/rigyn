import assert from "node:assert/strict";
import test from "node:test";

import {
  renderExtensionCommand,
  renderExtensionPrompt,
  type ExtensionPromptTemplate,
  type ExtensionSlashCommand,
} from "../../src/extensions/index.js";

function prompt(template: string): ExtensionPromptTemplate {
  return {
    id: "arguments",
    extensionId: "fixture",
    sourcePath: "/fixture/arguments.md",
    sha256: "0".repeat(64),
    template,
  };
}

function command(template: string): ExtensionSlashCommand {
  return {
    name: "arguments",
    extensionId: "fixture",
    sourcePath: "/fixture/arguments.md",
    sha256: "0".repeat(64),
    template,
  };
}

test("prompt templates support zero-index compatibility and aggregate defaults", () => {
  assert.equal(renderExtensionPrompt(prompt("$0"), "one two"), "");
  assert.equal(renderExtensionPrompt(prompt("${0:-fallback}"), "one two"), "fallback");
  assert.equal(renderExtensionPrompt(prompt("${@:0}"), "one two three"), "one two three");
  assert.equal(renderExtensionPrompt(prompt("${@:0:2}"), "one two three"), "one two");
  assert.equal(renderExtensionPrompt(prompt("${@:-fallback}"), "one two"), "one two");
  assert.equal(renderExtensionPrompt(prompt("${ARGUMENTS:-fallback}"), ""), "fallback");
  assert.equal(renderExtensionCommand(command("${ARGUMENTS:-fallback}"), "one two"), "one two");
});

test("prompt template replacements remain single-pass", () => {
  assert.equal(renderExtensionPrompt(prompt("${@:0}"), "'$1' '${@:-fallback}'"), "$1 ${@:-fallback}");
});
