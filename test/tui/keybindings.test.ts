import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Keybindings, loadKeybindings, parseKeybindings } from "../../src/tui/keybindings.js";

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

test("tool details need no default expansion key but remain remappable", () => {
  assert.deepEqual(new Keybindings().keys("app.tools.expand"), []);
  const bindings = new Keybindings({ "app.tools.expand": "alt+t" });
  assert.deepEqual(bindings.keys("app.tools.expand"), ["alt+t"]);
});

test("keybindings reject unknown actions and malformed keys", () => {
  assert.throws(() => parseKeybindings({ "app.unknown": "ctrl+x" }), /Unknown keybinding actions/u);
  assert.throws(() => parseKeybindings({ "app.model.select": "cmd+x" }), /modifiers/u);
  assert.throws(() => parseKeybindings({ "app.model.select": "ctrl+f36" }), /Unsupported/u);
  assert.deepEqual(new Keybindings({ "app.model.select": [] }).keys("app.model.select"), []);
  assert.throws(() => new Keybindings({ "app.model.select": Array.from({ length: 17 }, (_, index) => `ctrl+f${index + 1}`) }), /at most 16/u);
});

test("keybindings report only conflicts that share an input scope", () => {
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

test("editor actions expose jump, yank, yank-pop, and non-conflicting redo defaults", () => {
  const bindings = new Keybindings();
  assert.equal(bindings.matches("tui.editor.jumpForward", { key: "]", ctrl: true }), true);
  assert.equal(bindings.matches("tui.editor.jumpBackward", { key: "]", ctrl: true, alt: true }), true);
  assert.equal(bindings.matches("tui.editor.yank", { key: "y", ctrl: true }), true);
  assert.equal(bindings.matches("tui.editor.yankPop", { key: "y", alt: true }), true);
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

test("application and scoped-model actions are complete and can be unbound", () => {
  const defaults = new Keybindings();
  assert.deepEqual(defaults.keys("app.suspend"), process.platform === "win32" ? [] : ["ctrl+z"]);
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
  const path = join(root, "keybindings.json");
  const defaults = await loadKeybindings(path);
  assert.equal(defaults.matches("app.model.select", { key: "l", ctrl: true }), true);
  await writeFile(path, JSON.stringify({ "app.model.select": "ctrl+q" }));
  const custom = await loadKeybindings(path);
  assert.equal(custom.matches("app.model.select", { key: "q", ctrl: true }), true);
  await writeFile(path, "x".repeat(64 * 1024 + 1));
  await assert.rejects(loadKeybindings(path), /exceeds 65536 bytes/u);
});
