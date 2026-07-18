import assert from "node:assert/strict";
import test from "node:test";
import { formatCompactStartupReport, formatHotkeys, formatResumeCommand, formatStartupReport, parseInteractivePathArgument } from "../../src/cli/main.js";
import { Keybindings } from "../../src/tui/keybindings.js";

test("startup and hotkey reports derive labels from current bounded keybindings", () => {
  const keybindings = new Keybindings({
    "app.model.select": "ctrl+k",
    "app.model.cycleForward": "alt+n",
    "app.tools.expand": "alt+t",
    "app.interrupt": "ctrl+x",
    "app.session.resume": "alt+r",
  });
  const report = formatStartupReport(keybindings, false, {
    contextInstructions: ["./AGENTS.md\u001b[31m", ...Array.from({ length: 9 }, (_, index) => `./nested/${index}.md`)],
    extensions: ["example-extension"],
    skills: ["review"],
    promptsAndCommands: ["/explain", "/inspect"],
    themes: ["paper"],
  });
  assert.match(report, /^Rigyn v0\.2\.0 · Ready$/mu);
  assert.match(report, /^Model: Ctrl\+K picker · Alt\+N next/mu);
  assert.match(report, /^Control: Ctrl\+X cancel/mu);
  assert.match(report, /^Commands: \/ opens the palette · \/login connects a provider/mu);
  assert.match(report, /^Sessions: \/resume opens saved work · rigyn --continue starts with the latest project session$/mu);
  assert.match(report, /^\[Context\]$/mu);
  assert.match(report, /^  \+2 more$/mu);
  assert.match(report, /^\[Extensions\]\n  example-extension$/mu);
  assert.match(report, /^\[Skills\]\n  review$/mu);
  assert.match(report, /^\[Prompts\]\n  \/explain\n  \/inspect$/mu);
  assert.match(report, /^\[Themes\]\n  paper$/mu);
  assert.doesNotMatch(report, /\u001b/u);

  const compact = formatCompactStartupReport(keybindings, false, {
    contextInstructions: ["./AGENTS.md"],
    extensions: ["example-extension"],
    skills: ["review"],
    promptsAndCommands: ["/explain"],
    themes: ["paper"],
  });
  assert.match(compact, /^Ctrl\+X interrupt · Ctrl\+C clear\/exit twice · Ctrl\+D exit(?: · Ctrl\+Z suspend)? · \/ commands · ! bash$/mu);
  assert.match(compact, /^Loaded: 1 context · 1 extension · 1 skill · 1 prompt · 1 theme$/mu);
  assert.match(compact, /^No model connected · Start: \/login connects a provider · \/model selects an available model$/mu);
  assert.match(compact, /^Saved work: Alt\+R or \/resume · next launch: rigyn --continue$/mu);
  assert.doesNotMatch(compact, /\[Context\]|\[Extensions\]|\[Skills\]|\[Prompts\]|\[Themes\]/u);

  const hotkeys = formatHotkeys(keybindings);
  assert.match(hotkeys, /^Model: Ctrl\+K picker · Alt\+N next/mu);
  assert.match(hotkeys, /^Sessions\/transcript: Alt\+R session picker/mu);
  assert.match(hotkeys, /^Tools\/editor: Alt\+T tool details · /mu);
  assert.match(hotkeys, /^Control: Ctrl\+X cancel/mu);
  assert.equal(hotkeys.match(/!command includes output/gu)?.length, 1);
});

test("startup report remains concise when no optional resources are present", () => {
  const report = formatStartupReport(new Keybindings(), true, {
    contextInstructions: [],
    extensions: [],
    skills: [],
    promptsAndCommands: [],
    themes: [],
  });
  assert.doesNotMatch(report, /\[Context\]|\[Extensions\]|\[Skills\]|\[Prompts\]|\[Themes\]/u);
  const compact = formatCompactStartupReport(new Keybindings(), true, {
    contextInstructions: [], extensions: [], skills: [], promptsAndCommands: [], themes: [],
  });
  assert.doesNotMatch(compact, /^Loaded:/mu);
  assert.match(compact, /^Model ready · \/model switches the available model$/mu);
  assert.match(formatHotkeys(new Keybindings()), /^Tools\/editor: Ctrl\+G external editor$/mu);
});

test("resume command preserves a custom session directory as one shell argument", () => {
  assert.equal(formatResumeCommand("thread-123"), "rigyn --session thread-123");
  assert.equal(
    formatResumeCommand("thread-123", "/tmp/session files/it's here"),
    "rigyn --session-dir '/tmp/session files/it'\\''s here' --session thread-123",
  );
});

test("interactive path arguments preserve spaces and parse complete matching quotes", () => {
  assert.equal(parseInteractivePathArgument(" report with spaces.jsonl ", "/import"), "report with spaces.jsonl");
  assert.equal(parseInteractivePathArgument(" 'report with spaces.jsonl' ", "/import"), "report with spaces.jsonl");
  assert.equal(parseInteractivePathArgument(' "report with spaces.jsonl" ', "/import"), "report with spaces.jsonl");
  assert.equal(parseInteractivePathArgument('"quote\\\" and slash\\\\.jsonl"', "/import"), 'quote" and slash\\.jsonl');
  assert.equal(parseInteractivePathArgument("'literal\\backslash.jsonl'", "/import"), "literal\\backslash.jsonl");
});

test("interactive path arguments reject empty, unterminated, and trailing quoted input", () => {
  assert.throws(() => parseInteractivePathArgument("  ", "/import"), /requires a file path/u);
  assert.throws(() => parseInteractivePathArgument('""', "/import"), /requires a file path/u);
  assert.throws(() => parseInteractivePathArgument('"unterminated', "/import"), /unterminated quote/u);
  assert.throws(() => parseInteractivePathArgument("'unterminated", "/import"), /unterminated quote/u);
  assert.throws(() => parseInteractivePathArgument('"path" trailing', "/import"), /characters after/u);
});
