import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  KEYBINDING_ACTIONS,
  Keybindings,
  KeybindingsManager,
  loadKeybindings,
  parseKeybindings,
} from "../../src/tui/keybindings.js";
import { PORTABLE_CONFIG_SCAFFOLD } from "../helpers/config-scaffold.js";

test("the portable settings scaffold leaves keybindings on the stable built-in inventory", async () => {
  const template = JSON.parse(await readFile(new URL("../../resources/config.example.json", import.meta.url), "utf8")) as Record<string, unknown>;
  assert.deepEqual(template, PORTABLE_CONFIG_SCAFFOLD);
  assert.deepEqual(template.keybindings, {});
  assert.equal(new Set(KEYBINDING_ACTIONS).size, KEYBINDING_ACTIONS.length);
  const defaults = new Keybindings();
  for (const action of KEYBINDING_ACTIONS) assert.ok(Array.isArray(defaults.keys(action)));
  assert.deepEqual(parseKeybindings(template.keybindings as Record<string, string | string[]>).keys("app.exit"), ["ctrl+d"]);
});

test("keybindings normalize modifier order and replace defaults per action", () => {
  const bindings = parseKeybindings({
    "app.model.select": ["shift+ctrl+k", "ctrl+shift+k"],
    "tui.input.newLine": "ctrl+j",
  });
  assert.deepEqual(bindings.keys("app.model.select"), ["ctrl+shift+k"]);
  assert.equal(bindings.matches("app.model.select", { key: "k", ctrl: true, shift: true }), true);
  assert.equal(bindings.matches("app.model.select", { key: "l", ctrl: true }), false);
  assert.equal(bindings.matches("tui.input.newLine", { key: "newline", ctrl: true }), true);
});

test("tool details use the default expansion key and remain remappable", () => {
  assert.deepEqual(new Keybindings().keys("app.tools.expand"), ["ctrl+o"]);
  const bindings = new Keybindings({ "app.tools.expand": "alt+t" });
  assert.deepEqual(bindings.keys("app.tools.expand"), ["alt+t"]);
});

test("transcript navigation bindings remain independently configurable", () => {
  const bindings = new Keybindings({ "tui.transcript.top": "ctrl+home" });
  assert.deepEqual(bindings.keys("tui.transcript.pageUp"), ["pageup"]);
  assert.deepEqual(bindings.keys("tui.transcript.previousPrompt"), ["ctrl+shift+up"]);
  assert.deepEqual(bindings.keys("tui.transcript.top"), ["ctrl+home"]);
});

test("keybindings reject unknown actions and malformed keys", () => {
  assert.throws(() => parseKeybindings({ "app.unknown": "ctrl+x" }), /Unknown keybinding actions/u);
  assert.throws(() => parseKeybindings({ "app.model.select": "cmd+x" }), /modifiers/u);
  assert.throws(() => parseKeybindings({ "app.model.select": "ctrl+f36" }), /Unsupported/u);
  assert.deepEqual(new Keybindings({ "app.model.select": [] }).keys("app.model.select"), []);
  assert.throws(() => new Keybindings({ "app.model.select": Array.from({ length: 17 }, (_, index) => `ctrl+f${index + 1}`) }), /at most 16/u);
});

test("keybindings report only conflicts that share an input scope", () => {
  assert.deepEqual(new Keybindings().conflicts(), []);
  assert.deepEqual(parseKeybindings({ "app.model.select": "ctrl+k" }).conflicts(), [{
    scope: "editor",
    key: "ctrl+k",
    actions: ["tui.editor.deleteToLineEnd", "app.model.select"],
  }]);
  const scoped = parseKeybindings({ "app.session.togglePath": "ctrl+k" });
  assert.deepEqual(scoped.conflicts(), []);
});

test("keybindings accept enhanced modifiers and function keys", () => {
  const bindings = parseKeybindings({ "app.model.select": ["super+f13", "hyper+meta+k"] });
  assert.equal(bindings.matches("app.model.select", { key: "f13", super: true }), true);
  assert.equal(bindings.matches("app.model.select", { key: "k", hyper: true, meta: true }), true);
});

test("keybindings accept the plus key with and without modifiers", () => {
  const bindings = parseKeybindings({ "app.model.select": ["+", "shift+ctrl++"] });
  assert.deepEqual(bindings.keys("app.model.select"), ["+", "ctrl+shift++"]);
  assert.equal(bindings.matches("app.model.select", { key: "text", text: "+" }), true);
  assert.equal(bindings.matches("app.model.select", { key: "text", text: "+", ctrl: true, shift: true }), true);
  assert.throws(() => parseKeybindings({ "app.model.select": "ctrl+++" }), /Invalid keybinding/u);
});

test("editor actions expose common undo and redo chords plus remappable advanced actions", () => {
  const bindings = new Keybindings();
  assert.equal(bindings.matches("tui.editor.cursorLineStart", { key: "home" }), true);
  assert.equal(bindings.matches("tui.editor.cursorLineEnd", { key: "end" }), true);
  assert.equal(bindings.matches("tui.editor.cursorWordLeft", { key: "left", ctrl: true }), true);
  assert.equal(bindings.matches("tui.editor.cursorWordRight", { key: "right", ctrl: true }), true);
  assert.equal(bindings.matches("tui.editor.deleteWordBackward", { key: "w", ctrl: true }), true);
  assert.equal(bindings.matches("tui.editor.deleteToLineStart", { key: "u", ctrl: true }), true);
  assert.equal(bindings.matches("tui.editor.deleteToLineEnd", { key: "k", ctrl: true }), true);
  assert.equal(bindings.matches("tui.editor.jumpForward", { key: "]", ctrl: true }), true);
  assert.equal(bindings.matches("tui.editor.jumpBackward", { key: "]", ctrl: true, alt: true }), true);
  assert.equal(bindings.matches("tui.editor.yank", { key: "y", ctrl: true }), true);
  assert.equal(bindings.matches("tui.editor.yankPop", { key: "y", alt: true }), true);
  assert.equal(bindings.matches("tui.editor.undo", { key: "z", ctrl: true }), true);
  assert.equal(bindings.matches("tui.editor.redo", { key: "z", ctrl: true, shift: true }), true);
  assert.equal(bindings.matches("tui.editor.redo", { key: "y", ctrl: true }), false);
});

test("kill-ring action IDs replace defaults when remapped", () => {
  const bindings = parseKeybindings({
    "tui.editor.deleteWordBackward": "alt+h",
    "tui.editor.deleteWordForward": "alt+l",
    "tui.editor.deleteToLineStart": "alt+u",
    "tui.editor.deleteToLineEnd": "alt+k",
    "tui.editor.yank": "alt+p",
    "tui.editor.yankPop": "alt+n",
  });
  assert.equal(bindings.matches("tui.editor.deleteWordBackward", { key: "h", alt: true }), true);
  assert.equal(bindings.matches("tui.editor.deleteWordBackward", { key: "w", ctrl: true }), false);
  assert.equal(bindings.matches("tui.editor.deleteWordForward", { key: "l", alt: true }), true);
  assert.equal(bindings.matches("tui.editor.deleteToLineStart", { key: "u", alt: true }), true);
  assert.equal(bindings.matches("tui.editor.deleteToLineEnd", { key: "k", alt: true }), true);
  assert.equal(bindings.matches("tui.editor.deleteToLineEnd", { key: "k", ctrl: true }), false);
  assert.equal(bindings.matches("tui.editor.yank", { key: "p", alt: true }), true);
  assert.equal(bindings.matches("tui.editor.yankPop", { key: "n", alt: true }), true);
});

test("clipboard image paste uses the platform-safe default and remains remappable", () => {
  const defaults = new Keybindings();
  assert.deepEqual(defaults.keys("app.clipboard.pasteImage"), [process.platform === "win32" ? "alt+v" : "ctrl+v"]);
  const custom = parseKeybindings({ "app.clipboard.pasteImage": "alt+i" });
  assert.equal(custom.matches("app.clipboard.pasteImage", { key: "i", alt: true }), true);
  assert.equal(custom.matches("app.clipboard.pasteImage", { key: "v", ctrl: true }), false);
});

test("latest assistant copy has a dedicated remappable shortcut", () => {
  const defaults = new Keybindings();
  assert.deepEqual(defaults.keys("app.message.copy"), ["ctrl+x"]);
  const custom = parseKeybindings({ "app.message.copy": "alt+c" });
  assert.equal(custom.matches("app.message.copy", { key: "c", alt: true }), true);
  assert.equal(custom.matches("app.message.copy", { key: "x", ctrl: true }), false);
});

test("terminal input copy remains available and remappable through the shared manager", () => {
  const defaults = new Keybindings();
  assert.deepEqual(defaults.keys("tui.input.copy"), ["ctrl+c"]);
  const custom = parseKeybindings({ "tui.input.copy": "alt+c" });
  assert.deepEqual(custom.manager().getKeys("tui.input.copy"), ["alt+c"]);
});

test("application and scoped-model actions are complete and can be unbound", () => {
  const defaults = new Keybindings();
  assert.deepEqual(defaults.keys("app.suspend"), []);
  assert.deepEqual(defaults.keys("app.model.select"), ["ctrl+l"]);
  assert.deepEqual(defaults.keys("app.session.resume"), []);
  assert.deepEqual(defaults.keys("app.session.tree"), []);
  assert.equal(defaults.matches("app.models.save", { key: "s", ctrl: true }), true);
  assert.equal(defaults.matches("app.models.enableAll", { key: "a", ctrl: true }), true);
  assert.equal(defaults.matches("app.models.clearAll", { key: "x", ctrl: true }), true);
  assert.equal(defaults.matches("app.models.toggleProvider", { key: "p", ctrl: true }), true);
  const unbound = parseKeybindings({ "app.clipboard.pasteImage": [] });
  assert.deepEqual(unbound.keys("app.clipboard.pasteImage"), []);
});

test("keybindings load from a bounded file and fall back when absent", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-keybindings-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "bindings.json");
  const defaults = await loadKeybindings(path);
  assert.equal(defaults.matches("app.model.select", { key: "l", ctrl: true }), true);
  await writeFile(path, JSON.stringify({ "app.model.select": "ctrl+q" }));
  const custom = await loadKeybindings(path);
  assert.equal(custom.matches("app.model.select", { key: "q", ctrl: true }), true);
  const settingsOverride = await loadKeybindings(path, { "app.model.select": "alt+k" });
  assert.equal(settingsOverride.matches("app.model.select", { key: "k", alt: true }), true);
  assert.equal(settingsOverride.matches("app.model.select", { key: "q", ctrl: true }), false);
  await writeFile(path, "x".repeat(64 * 1024 + 1));
  await assert.rejects(loadKeybindings(path), /exceeds 65536 bytes/u);
});

test("loaded application bindings expose the same complete public manager", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-keybindings-manager-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "bindings.json");
  await writeFile(path, JSON.stringify({
    "app.model.select": "alt+k",
    "tui.editor.cursorLineEnd": "ctrl+q",
  }));

  const bindings = await loadKeybindings(path);
  const manager = bindings.manager();
  assert.deepEqual(manager.getKeys("app.model.select"), ["alt+k"]);
  assert.deepEqual(manager.getKeys("tui.editor.cursorLineEnd"), ["ctrl+q"]);
  assert.equal(bindings.keys("app.model.select")[0], manager.getKeys("app.model.select")[0]);
});

test("the public application manager reports effective bindings", () => {
  const manager = new KeybindingsManager({ "app.model.select": "alt+k" });
  assert.deepEqual(manager.getKeys("app.model.select"), ["alt+k"]);
  assert.equal(manager.getEffectiveConfig()["app.model.select"], "alt+k");
  assert.deepEqual(manager.getKeys("app.tools.expand"), ["ctrl+o"]);
});

test("the public application manager retains the terminal-style constructor", () => {
  const manager = new KeybindingsManager({
    "custom.submit": { defaultKeys: "enter" },
  }, {
    "custom.submit": "ctrl+enter",
  });

  assert.deepEqual(manager.getKeys("custom.submit" as never), ["ctrl+enter"]);
  assert.equal(manager.getEffectiveConfig()["custom.submit"], "ctrl+enter");

  const empty = new KeybindingsManager({});
  assert.deepEqual(empty.getKeys("tui.input.submit"), []);
});
