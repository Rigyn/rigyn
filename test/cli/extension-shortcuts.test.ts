import assert from "node:assert/strict";
import test from "node:test";

import { resolveRuntimeShortcuts } from "../../src/cli/extension-shortcuts.js";
import { Keybindings } from "../../src/tui/keybindings.js";

function shortcut(value: string) {
  return { extensionId: "fixture", sourcePath: "/fixture.mjs", shortcut: value, description: "fixture shortcut" };
}

test("reserved application keys cannot be replaced by an extension", () => {
  const resolved = resolveRuntimeShortcuts([shortcut("ctrl+c")], new Keybindings());
  assert.deepEqual(resolved.shortcuts, []);
  assert.match(resolved.diagnostics[0] ?? "", /reserved action .*app\.clear/u);
});

test("non-critical built-in keys may be replaced with an explicit diagnostic", () => {
  const key = process.platform === "win32" ? "alt+v" : "ctrl+v";
  const resolved = resolveRuntimeShortcuts([shortcut(key)], new Keybindings());
  assert.deepEqual(resolved.shortcuts.map((entry) => entry.shortcut), [key]);
  assert.match(resolved.diagnostics[0] ?? "", /replaces app\.clipboard\.pasteImage/u);
});

test("conflict resolution follows the currently loaded keymap", () => {
  const keybindings = new Keybindings({ "app.interrupt": "ctrl+x", "app.model.cycleForward": "ctrl+n" });
  const blocked = resolveRuntimeShortcuts([shortcut("ctrl+x")], keybindings);
  assert.equal(blocked.shortcuts.length, 0);
  const freed = resolveRuntimeShortcuts([shortcut("ctrl+p")], keybindings);
  assert.deepEqual(freed.shortcuts.map((entry) => entry.shortcut), ["ctrl+p"]);
  assert.match(freed.diagnostics[0] ?? "", /replaces app\.session\.togglePath/u);
});
