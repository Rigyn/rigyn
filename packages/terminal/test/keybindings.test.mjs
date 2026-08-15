import assert from "node:assert/strict";
import test from "node:test";

import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
} from "../dist/index.js";

const DEFAULT_KEYS = {
  "tui.editor.cursorUp": "up",
  "tui.editor.cursorDown": "down",
  "tui.editor.cursorLeft": ["left", "ctrl+b"],
  "tui.editor.cursorRight": ["right", "ctrl+f"],
  "tui.editor.cursorWordLeft": ["alt+left", "ctrl+left", "alt+b"],
  "tui.editor.cursorWordRight": ["alt+right", "ctrl+right", "alt+f"],
  "tui.editor.cursorLineStart": ["home", "ctrl+a"],
  "tui.editor.cursorLineEnd": ["end", "ctrl+e"],
  "tui.editor.jumpForward": "ctrl+]",
  "tui.editor.jumpBackward": "ctrl+alt+]",
  "tui.editor.pageUp": "pageUp",
  "tui.editor.pageDown": "pageDown",
  "tui.editor.deleteCharBackward": "backspace",
  "tui.editor.deleteCharForward": ["delete", "ctrl+d"],
  "tui.editor.deleteWordBackward": ["ctrl+w", "alt+backspace"],
  "tui.editor.deleteWordForward": ["alt+d", "alt+delete"],
  "tui.editor.deleteToLineStart": "ctrl+u",
  "tui.editor.deleteToLineEnd": "ctrl+k",
  "tui.editor.yank": "ctrl+y",
  "tui.editor.yankPop": "alt+y",
  "tui.editor.undo": "ctrl+z",
  "tui.editor.redo": "ctrl+shift+z",
  "tui.input.newLine": ["shift+enter", "ctrl+j"],
  "tui.input.submit": "enter",
  "tui.input.tab": "tab",
  "tui.input.copy": "ctrl+c",
  "tui.select.up": "up",
  "tui.select.down": "down",
  "tui.select.pageUp": "pageUp",
  "tui.select.pageDown": "pageDown",
  "tui.select.confirm": "enter",
  "tui.select.cancel": ["escape", "ctrl+c"],
  "tui.transcript.pageUp": "pageUp",
  "tui.transcript.pageDown": "pageDown",
  "tui.transcript.previousPrompt": "ctrl+shift+up",
  "tui.transcript.nextPrompt": "ctrl+shift+down",
  "tui.transcript.top": "ctrl+home",
  "tui.transcript.bottom": "ctrl+end",
};

function asArray(value) {
  return Array.isArray(value) ? value : [value];
}

test("the public TUI registry declares every action and default binding", () => {
  assert.deepEqual(Object.keys(TUI_KEYBINDINGS), Object.keys(DEFAULT_KEYS));

  const manager = new KeybindingsManager(TUI_KEYBINDINGS);
  for (const [action, expected] of Object.entries(DEFAULT_KEYS)) {
    assert.deepEqual(TUI_KEYBINDINGS[action].defaultKeys, expected, action);
    assert.ok(TUI_KEYBINDINGS[action].description.length > 0, action);
    assert.deepEqual(manager.getKeys(action), asArray(expected), action);
    assert.deepEqual(manager.getDefinition(action), TUI_KEYBINDINGS[action], action);
  }
  assert.deepEqual(manager.getResolvedBindings(), DEFAULT_KEYS);
});

test("overrides replace defaults, deduplicate literals, and allow explicit unbinding", () => {
  const definitions = {
    first: { defaultKeys: ["a", "b"] },
    second: { defaultKeys: "c" },
    third: { defaultKeys: "d" },
  };
  const manager = new KeybindingsManager(definitions, {
    first: ["ctrl+x", "ctrl+x", "alt+x"],
    second: [],
    third: undefined,
  });

  assert.deepEqual(manager.getKeys("first"), ["ctrl+x", "alt+x"]);
  assert.deepEqual(manager.getKeys("second"), []);
  assert.deepEqual(manager.getKeys("third"), ["d"]);
  assert.deepEqual(manager.getUserBindings(), {
    first: ["ctrl+x", "ctrl+x", "alt+x"],
    second: [],
    third: undefined,
  });
  assert.deepEqual(manager.getResolvedBindings(), {
    first: ["ctrl+x", "alt+x"],
    second: [],
    third: "d",
  });
});

test("matching and conflicts normalize modifier aliases without self-conflicts", () => {
  const manager = new KeybindingsManager({
    first: { defaultKeys: "a" },
    second: { defaultKeys: "b" },
    meta: { defaultKeys: "c" },
  }, {
    first: ["ctrl+shift+a", "shift+control+a"],
    second: "shift+ctrl+a",
    meta: "meta+x",
  });

  assert.equal(manager.matches("\x1b[97;6u", "first"), true);
  assert.equal(manager.matches("\x1b[97;6u", "second"), true);
  assert.equal(manager.matches("\x1bx", "meta"), true);
  assert.equal(manager.matches("x", "meta"), false);
  assert.deepEqual(manager.getConflicts(), [{
    key: "shift+ctrl+a",
    keybindings: ["first", "second"],
  }]);

  const aliasesOnOneAction = new KeybindingsManager({
    first: { defaultKeys: "a" },
  }, {
    first: ["ctrl+shift+a", "shift+control+a"],
  });
  assert.deepEqual(aliasesOnOneAction.getConflicts(), []);
});

test("conflicts report explicit competing claims without treating defaults as user claims", () => {
  const definitions = {
    first: { defaultKeys: "ctrl+p" },
    second: { defaultKeys: "ctrl+p" },
  };
  assert.deepEqual(new KeybindingsManager(definitions).getConflicts(), []);
  assert.deepEqual(new KeybindingsManager(definitions, { second: "ctrl+p" }).getConflicts(), []);
  assert.deepEqual(new KeybindingsManager(definitions, {
    first: "ctrl+p",
    second: "control+p",
  }).getConflicts(), [{ key: "ctrl+p", keybindings: ["first", "second"] }]);
});

test("registry membership is validated before construction or replacement", () => {
  const definitions = { first: { defaultKeys: "a" } };
  assert.throws(
    () => new KeybindingsManager(definitions, { missing: "b" }),
    /Unknown keybindings: missing/u,
  );

  const manager = new KeybindingsManager(definitions, { first: "c" });
  assert.throws(
    () => manager.setUserBindings({ missing: "d" }),
    /Unknown keybindings: missing/u,
  );
  assert.deepEqual(manager.getKeys("first"), ["c"]);
  assert.deepEqual(manager.getUserBindings(), { first: "c" });
});

test("definitions, configs, and query results are independent snapshots", () => {
  const defaultKeys = ["a", "b"];
  const definitions = { first: { defaultKeys, description: "First action" } };
  const overrideKeys = ["ctrl+x", "alt+x"];
  const userBindings = { first: overrideKeys };
  const manager = new KeybindingsManager(definitions, userBindings);

  defaultKeys.push("c");
  definitions.first.description = "Changed";
  overrideKeys.push("shift+x");
  assert.deepEqual(manager.getDefinition("first"), {
    defaultKeys: ["a", "b"],
    description: "First action",
  });
  assert.deepEqual(manager.getKeys("first"), ["ctrl+x", "alt+x"]);

  const definition = manager.getDefinition("first");
  definition.defaultKeys.push("d");
  definition.description = "Mutated";
  const keys = manager.getKeys("first");
  keys.push("meta+x");
  const config = manager.getUserBindings();
  config.first.push("super+x");
  const resolved = manager.getResolvedBindings();
  resolved.first.push("hyper+x");

  assert.deepEqual(manager.getDefinition("first"), {
    defaultKeys: ["a", "b"],
    description: "First action",
  });
  assert.deepEqual(manager.getKeys("first"), ["ctrl+x", "alt+x"]);
  assert.deepEqual(manager.getUserBindings(), { first: ["ctrl+x", "alt+x"] });
  assert.deepEqual(manager.getResolvedBindings(), { first: ["ctrl+x", "alt+x"] });
  assert.equal(manager.getDefinition("missing"), undefined);

  const replacement = ["z"];
  manager.setUserBindings({ first: replacement });
  replacement.push("y");
  assert.deepEqual(manager.getKeys("first"), ["z"]);
});

test("conflict query results are independent snapshots", () => {
  const manager = new KeybindingsManager({
    first: { defaultKeys: "a" },
    second: { defaultKeys: "b" },
  }, {
    first: "ctrl+p",
    second: "control+p",
  });
  const conflicts = manager.getConflicts();
  conflicts[0].key = "changed";
  conflicts[0].keybindings.push("third");
  assert.deepEqual(manager.getConflicts(), [{
    key: "ctrl+p",
    keybindings: ["first", "second"],
  }]);
});

test("the global registry is lazy, stable, replaceable, and restorable", () => {
  const original = getKeybindings();
  assert.equal(getKeybindings(), original);

  const replacement = new KeybindingsManager({ custom: { defaultKeys: "z" } });
  try {
    setKeybindings(replacement);
    assert.equal(getKeybindings(), replacement);
    assert.deepEqual(getKeybindings().getKeys("custom"), ["z"]);
  } finally {
    setKeybindings(original);
  }
  assert.equal(getKeybindings(), original);
});
