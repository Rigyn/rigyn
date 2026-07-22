import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatCompactStartupReport, formatHotkeys, formatResumeCommand, formatStartupReport, parseInteractivePathArgument } from "../../src/cli/main.js";
import type { SessionManager } from "../../src/storage/session-manager.js";
import { Keybindings } from "../../src/tui/keybindings.js";
import { RIGYN_VERSION } from "../../src/version.js";

test("startup and hotkey reports derive labels from current bounded keybindings", () => {
  const keybindings = new Keybindings({
    "app.model.select": "ctrl+k",
    "app.model.cycleForward": "alt+n",
    "app.tools.expand": "alt+t",
    "app.interrupt": "ctrl+x",
    "app.session.resume": "alt+r",
  });
  const inventory = {
    extensions: ["example-extension"],
    skills: ["review"],
    prompts: ["/explain", "/inspect"],
  };
  const report = formatStartupReport(inventory, "/workspace", keybindings);
  assert.match(report, new RegExp(`rigyn ${RIGYN_VERSION.replaceAll(".", "\\.")}`, "u"));
  assert.match(report, /programmable agent harness/u);
  assert.match(report, /^ctrl\+X interrupt · ctrl\+C clear\/exit · ctrl\+D exit · \/ commands$/mu);
  assert.match(report, /^Workspace: \/workspace$/mu);
  assert.match(report, /^Loaded: 1 extensions · 1 skills · 2 prompts$/mu);

  const compact = formatCompactStartupReport(inventory, "/workspace", keybindings);
  assert.equal(compact.split("\n", 1)[0], `rigyn ${RIGYN_VERSION} · ready  ◇─┬─◆`);
  assert.notEqual(compact, report);

  const hotkeys = formatHotkeys(keybindings);
  assert.equal(hotkeys, "ctrl+X interrupt · ctrl+C clear/exit · ctrl+D exit · / commands");
});

test("startup report remains concise when no optional resources are present", () => {
  const inventory = { extensions: [], skills: [], prompts: [] };
  const report = formatStartupReport(inventory, "/workspace");
  assert.doesNotMatch(report, /^Loaded:/mu);
  const compact = formatCompactStartupReport(inventory, "/workspace");
  assert.doesNotMatch(compact, /^Loaded:/mu);
  assert.match(compact, /^rigyn .* · ready/u);
  assert.notEqual(compact, report);
  assert.equal(formatHotkeys(new Keybindings()), "Esc interrupt · ctrl+C clear/exit · ctrl+D exit · / commands");
});

test("resume command is emitted only for a durable TTY session and quotes a custom directory", () => {
  const root = mkdtempSync(join(tmpdir(), "rigyn-resume-command-"));
  const file = join(root, "session.jsonl");
  writeFileSync(file, "\n");
  const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const manager = (overrides: Partial<{
    persisted: boolean;
    sessionFile: string;
    sessionDir: string;
    defaultDirectory: boolean;
  }> = {}) => ({
    isPersisted: () => overrides.persisted ?? true,
    getSessionFile: () => overrides.sessionFile ?? file,
    getSessionId: () => "thread-123",
    getSessionDir: () => overrides.sessionDir ?? root,
    usesDefaultSessionDir: () => overrides.defaultDirectory ?? true,
  }) as unknown as SessionManager;

  try {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    assert.equal(formatResumeCommand(manager()), "rigyn --session thread-123");
    assert.equal(
      formatResumeCommand(manager({ sessionDir: "/tmp/session files/it's here", defaultDirectory: false })),
      "rigyn --session-dir '/tmp/session files/it'\\''s here' --session thread-123",
    );
    assert.equal(formatResumeCommand(manager({ persisted: false })), undefined);
    assert.equal(formatResumeCommand(manager({ sessionFile: join(root, "missing.jsonl") })), undefined);
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    assert.equal(formatResumeCommand(manager()), undefined);
  } finally {
    if (original === undefined) Reflect.deleteProperty(process.stdout, "isTTY");
    else Object.defineProperty(process.stdout, "isTTY", original);
    rmSync(root, { recursive: true, force: true });
  }
});

test("interactive path arguments preserve spaces and parse complete matching quotes", () => {
  assert.equal(parseInteractivePathArgument(" report with spaces.jsonl ", "/import"), "report with spaces.jsonl");
  assert.equal(parseInteractivePathArgument(" 'report with spaces.jsonl' ", "/import"), "report with spaces.jsonl");
  assert.equal(parseInteractivePathArgument(' "report with spaces.jsonl" ', "/import"), "report with spaces.jsonl");
  assert.equal(parseInteractivePathArgument('"quote\\\" and slash\\\\.jsonl"', "/import"), 'quote\\\" and slash\\\\.jsonl');
  assert.equal(parseInteractivePathArgument("'literal\\backslash.jsonl'", "/import"), "literal\\backslash.jsonl");
});

test("interactive path arguments preserve empty values and reject unterminated quotes", () => {
  assert.equal(parseInteractivePathArgument("  ", "/import"), "");
  assert.equal(parseInteractivePathArgument('""', "/import"), "");
  assert.throws(() => parseInteractivePathArgument('"unterminated', "/import"), /unterminated quote/u);
  assert.throws(() => parseInteractivePathArgument("'unterminated", "/import"), /unterminated quote/u);
  assert.throws(() => parseInteractivePathArgument('"path" trailing', "/import"), /unterminated quote/u);
});
