import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../../src/cli/args.js";

test("agent arguments preserve repeated resource paths, messages, and file arguments", () => {
  const parsed = parseArgs([
    "--extension", "./one.ts", "-e", "./two.ts",
    "--skill", "./skills", "--prompt-template", "./prompts", "--theme", "./theme.json",
    "@context.md", "inspect", "this workspace",
  ]);
  assert.deepEqual(parsed.extensions, ["./one.ts", "./two.ts"]);
  assert.deepEqual(parsed.skills, ["./skills"]);
  assert.deepEqual(parsed.promptTemplates, ["./prompts"]);
  assert.deepEqual(parsed.themes, ["./theme.json"]);
  assert.deepEqual(parsed.fileArgs, ["context.md"]);
  assert.deepEqual(parsed.messages, ["inspect", "this workspace"]);
});

test("print consumes only its immediate positional prompt", () => {
  const prompt = parseArgs(["-p", "summarize", "@notes.md", "then verify"]);
  assert.equal(prompt.print, true);
  assert.deepEqual(prompt.messages, ["summarize", "then verify"]);
  assert.deepEqual(prompt.fileArgs, ["notes.md"]);

  const flag = parseArgs(["--print", "--offline", "summarize"]);
  assert.equal(flag.print, true);
  assert.equal(flag.offline, true);
  assert.deepEqual(flag.messages, ["summarize"]);
});

test("list-models has an optional search and does not consume flags or files", () => {
  assert.deepEqual(parseArgs(["--list-models", "codex", "--offline"]).listModels, "codex");
  const all = parseArgs(["--list-models", "@catalog.txt", "--offline"]);
  assert.equal(all.listModels, true);
  assert.deepEqual(all.fileArgs, ["catalog.txt"]);
  assert.equal(all.offline, true);
});

test("unknown long options are deferred to extensions while unknown short options are errors", () => {
  const parsed = parseArgs(["--plan", "strict", "--dry-run=true", "-z"]);
  assert.deepEqual([...parsed.unknownFlags], [["plan", "strict"], ["dry-run", "true"]]);
  assert.deepEqual(parsed.diagnostics, [{ type: "error", message: "Unknown option: -z" }]);
});

test("invalid thinking and missing name values produce diagnostics", () => {
  const parsed = parseArgs(["--thinking", "extreme", "--name"]);
  assert.equal(parsed.thinking, undefined);
  assert.deepEqual(parsed.diagnostics.map((entry) => entry.type), ["warning", "error"]);
  assert.match(parsed.diagnostics[0]!.message, /Invalid thinking level/u);
  assert.equal(parsed.diagnostics[1]!.message, "--name requires a value");
});

test("value options do not consume following flags and invalid modes are errors", () => {
  const missingProvider = parseArgs(["--provider", "--offline", "inspect"]);
  assert.equal(missingProvider.provider, undefined);
  assert.equal(missingProvider.offline, true);
  assert.deepEqual(missingProvider.messages, ["inspect"]);
  assert.deepEqual(missingProvider.diagnostics, [{ type: "error", message: "--provider requires a value" }]);

  const invalidMode = parseArgs(["--mode", "banana", "inspect"]);
  assert.equal(invalidMode.mode, undefined);
  assert.deepEqual(invalidMode.messages, ["inspect"]);
  assert.deepEqual(invalidMode.diagnostics, [{
    type: "error",
    message: 'Invalid mode "banana". Valid values: text, json, rpc',
  }]);
});

test("maximum thinking is a valid command-line level", () => {
  const parsed = parseArgs(["--thinking", "max"]);
  assert.equal(parsed.thinking, "max");
  assert.deepEqual(parsed.diagnostics, []);
});

test("session, model, mode, tools, and trust selections use direct fields", () => {
  const parsed = parseArgs([
    "--mode", "json", "--provider", "fixture", "--model", "fixture/one",
    "--thinking", "high", "--session-id", "work", "--session-dir", "/tmp/sessions",
    "--models", "fixture/one:high, fixture/two", "--tools", "read,bash", "--exclude-tools", "write",
    "--approve", "--no-context-files", "--workspace", "/tmp/project", "--all",
    "--max-steps", "42", "--max-output-tokens", "8192", "--redact",
  ]);
  assert.equal(parsed.mode, "json");
  assert.equal(parsed.provider, "fixture");
  assert.equal(parsed.model, "fixture/one");
  assert.equal(parsed.thinking, "high");
  assert.equal(parsed.sessionId, "work");
  assert.equal(parsed.sessionDir, "/tmp/sessions");
  assert.deepEqual(parsed.models, ["fixture/one:high", "fixture/two"]);
  assert.deepEqual(parsed.tools, ["read", "bash"]);
  assert.deepEqual(parsed.excludeTools, ["write"]);
  assert.equal(parsed.projectTrustOverride, true);
  assert.equal(parsed.noContextFiles, true);
  assert.equal(parsed.workspace, "/tmp/project");
  assert.equal(parsed.all, true);
  assert.equal(parsed.maxSteps, 42);
  assert.equal(parsed.maxOutputTokens, 8192);
  assert.equal(parsed.redact, true);
  assert.deepEqual([...parsed.unknownFlags], []);
});

test("run limits reject missing, non-integer, and non-positive values", () => {
  const parsed = parseArgs([
    "--max-steps", "0",
    "--max-output-tokens", "2.5",
    "--workspace",
  ]);
  assert.deepEqual(parsed.diagnostics, [
    { type: "error", message: "--max-steps must be a positive integer" },
    { type: "error", message: "--max-output-tokens must be a positive integer" },
    { type: "error", message: "--workspace requires a value" },
  ]);
});

test("export requires a source path and redaction remains an explicit parsed option", () => {
  const missing = parseArgs(["--export", "--redact"]);
  assert.equal(missing.export, undefined);
  assert.equal(missing.redact, true);
  assert.deepEqual(missing.diagnostics, [{ type: "error", message: "--export requires a session path" }]);

  const selected = parseArgs(["--export", "session.jsonl", "output.html", "--redact"]);
  assert.equal(selected.export, "session.jsonl");
  assert.deepEqual(selected.messages, ["output.html"]);
  assert.equal(selected.redact, true);
});
