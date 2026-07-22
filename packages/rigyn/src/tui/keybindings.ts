import { readFileBounded } from "../tools/paths.js";
import type { KeyEvent } from "./keys.js";
import {
  KeybindingsManager,
  type KeyId,
  type KeybindingDefinitions,
  type KeybindingsConfig,
} from "@rigyn/terminal";

/** Coding-agent actions contributed to the shared TUI keybinding registry. */
export interface AppKeybindings {
  "tui.editor.redo": true;
  "app.interrupt": true;
  "app.clear": true;
  "app.exit": true;
  "app.suspend": true;
  "app.editor.external": true;
  "app.model.select": true;
  "app.model.cycleForward": true;
  "app.model.cycleBackward": true;
  "app.thinking.cycle": true;
  "app.thinking.toggle": true;
  "app.tools.expand": true;
  "app.message.followUp": true;
  "app.message.dequeue": true;
  "app.message.copy": true;
  "app.clipboard.pasteImage": true;
  "app.session.resume": true;
  "app.session.new": true;
  "app.session.tree": true;
  "app.session.fork": true;
  "app.session.toggleScope": true;
  "app.session.togglePath": true;
  "app.session.toggleSort": true;
  "app.session.toggleNamedFilter": true;
  "app.session.rename": true;
  "app.session.delete": true;
  "app.session.deleteNoninvasive": true;
  "app.models.reorderUp": true;
  "app.models.reorderDown": true;
  "app.models.save": true;
  "app.models.enableAll": true;
  "app.models.clearAll": true;
  "app.models.toggleProvider": true;
  "app.tree.editLabel": true;
  "app.tree.toggleLabelTimestamp": true;
  "app.tree.filter.default": true;
  "app.tree.filter.noTools": true;
  "app.tree.filter.userOnly": true;
  "app.tree.filter.labeledOnly": true;
  "app.tree.filter.all": true;
  "app.tree.filter.cycleForward": true;
  "app.tree.filter.cycleBackward": true;
  "app.tree.foldOrUp": true;
  "app.tree.unfoldOrDown": true;
  "app.tree.togglePath": true;
}

declare module "@rigyn/terminal" {
  interface Keybindings extends AppKeybindings {}
}

export const KEYBINDING_ACTIONS = [
  "tui.editor.cursorUp",
  "tui.editor.cursorDown",
  "tui.editor.cursorLeft",
  "tui.editor.cursorRight",
  "tui.editor.cursorWordLeft",
  "tui.editor.cursorWordRight",
  "tui.editor.cursorLineStart",
  "tui.editor.cursorLineEnd",
  "tui.editor.jumpForward",
  "tui.editor.jumpBackward",
  "tui.editor.pageUp",
  "tui.editor.pageDown",
  "tui.editor.deleteCharBackward",
  "tui.editor.deleteCharForward",
  "tui.editor.deleteWordBackward",
  "tui.editor.deleteWordForward",
  "tui.editor.deleteToLineStart",
  "tui.editor.deleteToLineEnd",
  "tui.editor.yank",
  "tui.editor.yankPop",
  "tui.editor.undo",
  "tui.editor.redo",
  "tui.input.newLine",
  "tui.input.submit",
  "tui.input.tab",
  "tui.input.copy",
  "tui.select.up",
  "tui.select.down",
  "tui.select.pageUp",
  "tui.select.pageDown",
  "tui.select.confirm",
  "tui.select.cancel",
  "app.interrupt",
  "app.clear",
  "app.exit",
  "app.suspend",
  "app.editor.external",
  "app.model.select",
  "app.model.cycleForward",
  "app.model.cycleBackward",
  "app.thinking.cycle",
  "app.thinking.toggle",
  "app.tools.expand",
  "app.message.followUp",
  "app.message.dequeue",
  "app.message.copy",
  "app.clipboard.pasteImage",
  "app.session.resume",
  "app.session.new",
  "app.session.tree",
  "app.session.fork",
  "app.session.toggleScope",
  "app.session.togglePath",
  "app.session.toggleSort",
  "app.session.toggleNamedFilter",
  "app.session.rename",
  "app.session.delete",
  "app.session.deleteNoninvasive",
  "app.models.reorderUp",
  "app.models.reorderDown",
  "app.models.save",
  "app.models.enableAll",
  "app.models.clearAll",
  "app.models.toggleProvider",
  "app.tree.editLabel",
  "app.tree.toggleLabelTimestamp",
  "app.tree.filter.default",
  "app.tree.filter.noTools",
  "app.tree.filter.userOnly",
  "app.tree.filter.labeledOnly",
  "app.tree.filter.all",
  "app.tree.filter.cycleForward",
  "app.tree.filter.cycleBackward",
  "app.tree.foldOrUp",
  "app.tree.unfoldOrDown",
  "app.tree.togglePath",
] as const;

export type KeybindingAction = typeof KEYBINDING_ACTIONS[number];
export type KeybindingOverrides = Partial<Record<KeybindingAction, string | readonly string[]>>;

const ACTIONS = new Set<string>(KEYBINDING_ACTIONS);
const SPECIAL_KEYS = new Set([
  "backspace", "begin", "capslock", "delete", "down", "end", "enter", "escape", "home", "insert", "left", "menu",
  "numlock", "pagedown", "pageup", "pause", "printscreen", "right", "scrolllock", "space", "tab", "up",
  ...Array.from({ length: 35 }, (_, index) => `f${index + 1}`),
  ...Array.from({ length: 10 }, (_, index) => `kp${index}`),
  "kpadd", "kpbegin", "kpdecimal", "kpdelete", "kpdivide", "kpend", "kpenter", "kpequal", "kphome", "kpinsert",
  "kpleft", "kpmultiply", "kppagedown", "kppageup", "kpright", "kpseparator", "kpsubtract", "kpup", "kpdown",
]);
const SYMBOL_KEYS = new Set("`-=[]\\;',./!@#$%^&*()_+|~{}:<>?".split(""));
const MAX_KEYBINDINGS_BYTES = 64 * 1024;

export const DEFAULT_KEYBINDINGS: Readonly<Record<KeybindingAction, readonly string[]>> = Object.freeze({
  "tui.editor.cursorUp": ["up"],
  "tui.editor.cursorDown": ["down"],
  "tui.editor.cursorLeft": ["left", "ctrl+b"],
  "tui.editor.cursorRight": ["right", "ctrl+f"],
  "tui.editor.cursorWordLeft": ["alt+left", "ctrl+left", "alt+b"],
  "tui.editor.cursorWordRight": ["alt+right", "ctrl+right", "alt+f"],
  "tui.editor.cursorLineStart": ["home", "ctrl+a"],
  "tui.editor.cursorLineEnd": ["end", "ctrl+e"],
  "tui.editor.jumpForward": ["ctrl+]"],
  "tui.editor.jumpBackward": ["ctrl+alt+]"],
  "tui.editor.pageUp": ["pageup"],
  "tui.editor.pageDown": ["pagedown"],
  "tui.editor.deleteCharBackward": ["backspace"],
  "tui.editor.deleteCharForward": ["delete"],
  "tui.editor.deleteWordBackward": ["ctrl+w", "alt+backspace"],
  "tui.editor.deleteWordForward": ["alt+d", "alt+delete"],
  "tui.editor.deleteToLineStart": ["ctrl+u"],
  "tui.editor.deleteToLineEnd": ["ctrl+k"],
  "tui.editor.yank": ["ctrl+y"],
  "tui.editor.yankPop": ["alt+y"],
  "tui.editor.undo": ["ctrl+-"],
  "tui.editor.redo": ["ctrl+shift+z"],
  "tui.input.newLine": ["shift+enter", "ctrl+j"],
  "tui.input.submit": ["enter"],
  "tui.input.tab": ["tab"],
  "tui.input.copy": ["ctrl+c"],
  "tui.select.up": ["up", "shift+tab"],
  "tui.select.down": ["down", "tab"],
  "tui.select.pageUp": ["pageup"],
  "tui.select.pageDown": ["pagedown"],
  "tui.select.confirm": ["enter"],
  "tui.select.cancel": ["escape", "ctrl+c"],
  "app.interrupt": ["escape"],
  "app.clear": ["ctrl+c"],
  "app.exit": ["ctrl+d"],
  "app.suspend": process.platform === "win32" ? [] : ["ctrl+z"],
  "app.editor.external": ["ctrl+g"],
  "app.model.select": ["ctrl+l", "alt+m"],
  "app.model.cycleForward": ["ctrl+p"],
  "app.model.cycleBackward": ["ctrl+shift+p"],
  "app.thinking.cycle": ["shift+tab"],
  "app.thinking.toggle": ["ctrl+t"],
  "app.tools.expand": ["ctrl+o"],
  "app.message.followUp": ["alt+enter"],
  "app.message.dequeue": ["alt+up"],
  "app.message.copy": ["ctrl+x"],
  "app.clipboard.pasteImage": process.platform === "win32" ? ["alt+v"] : ["ctrl+v"],
  "app.session.resume": ["alt+s"],
  "app.session.new": [],
  "app.session.tree": [],
  "app.session.fork": [],
  "app.session.toggleScope": ["ctrl+a"],
  "app.session.togglePath": ["ctrl+p"],
  "app.session.toggleSort": ["ctrl+s"],
  "app.session.toggleNamedFilter": ["ctrl+n"],
  "app.session.rename": ["ctrl+r"],
  "app.session.delete": ["ctrl+d"],
  "app.session.deleteNoninvasive": ["ctrl+backspace"],
  "app.models.reorderUp": ["alt+up"],
  "app.models.reorderDown": ["alt+down"],
  "app.models.save": ["ctrl+s"],
  "app.models.enableAll": ["ctrl+a"],
  "app.models.clearAll": ["ctrl+x"],
  "app.models.toggleProvider": ["ctrl+p"],
  "app.tree.editLabel": ["shift+l"],
  "app.tree.toggleLabelTimestamp": ["shift+t"],
  "app.tree.filter.default": ["ctrl+d"],
  "app.tree.filter.noTools": ["ctrl+t"],
  "app.tree.filter.userOnly": ["ctrl+u"],
  "app.tree.filter.labeledOnly": ["ctrl+l"],
  "app.tree.filter.all": ["ctrl+a"],
  "app.tree.filter.cycleForward": ["ctrl+o"],
  "app.tree.filter.cycleBackward": ["ctrl+shift+o"],
  "app.tree.foldOrUp": ["ctrl+left", "alt+left"],
  "app.tree.unfoldOrDown": ["ctrl+right", "alt+right"],
  "app.tree.togglePath": ["ctrl+p"],
});

const COMPLETE_KEYBINDING_DEFINITIONS: KeybindingDefinitions = Object.freeze(Object.fromEntries(
  KEYBINDING_ACTIONS.map((action) => [action, { defaultKeys: [...DEFAULT_KEYBINDINGS[action]] as KeyId[] }]),
));

export function normalizeKeybinding(value: string): string {
  const input = value.trim().toLowerCase();
  const parts = input === "+"
    ? ["+"]
    : input.endsWith("++")
      ? [...input.slice(0, -2).split("+"), "+"].map((part) => part.trim())
      : input.split("+").map((part) => part.trim());
  if (parts.some((part) => part === "")) throw new Error(`Invalid keybinding: ${value}`);
  const baseInput = parts.pop();
  if (baseInput === undefined) throw new Error(`Invalid keybinding: ${value}`);
  const modifiers = new Set(parts);
  if ([...modifiers].some((part) => !["ctrl", "shift", "alt", "super", "hyper", "meta"].includes(part)) || modifiers.size !== parts.length) {
    throw new Error(`Invalid keybinding modifiers: ${value}`);
  }
  const base = baseInput === "esc" ? "escape" : baseInput === "return" ? "enter" : baseInput;
  if (!SPECIAL_KEYS.has(base) && !/^[a-z0-9]$/u.test(base) && !SYMBOL_KEYS.has(base)) {
    throw new Error(`Unsupported keybinding key: ${value}`);
  }
  return [
    modifiers.has("ctrl") ? "ctrl" : undefined,
    modifiers.has("shift") ? "shift" : undefined,
    modifiers.has("alt") ? "alt" : undefined,
    modifiers.has("super") ? "super" : undefined,
    modifiers.has("hyper") ? "hyper" : undefined,
    modifiers.has("meta") ? "meta" : undefined,
    base,
  ]
    .filter(Boolean)
    .join("+");
}

export function keybindingForEvent(event: KeyEvent): string {
  const shiftedText = event.key === "text" && event.text !== undefined && /^[A-Z]$/u.test(event.text);
  const base = event.key === "newline" && event.ctrl
    ? "j"
    : event.key === "text" && event.text !== undefined && [...event.text].length === 1
      ? event.text.toLowerCase()
      : event.key.toLowerCase();
  return [
    event.ctrl ? "ctrl" : undefined,
    event.shift || shiftedText ? "shift" : undefined,
    event.alt ? "alt" : undefined,
    event.super ? "super" : undefined,
    event.hyper ? "hyper" : undefined,
    event.meta ? "meta" : undefined,
    base,
  ]
    .filter(Boolean)
    .join("+");
}

function bindingArray(value: string | readonly string[], action: string): string[] {
  const input = typeof value === "string" ? [value] : value;
  if (input.length > 16 || input.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(`Keybinding ${action} must contain at most 16 non-empty keys`);
  }
  return [...new Set(input.map(normalizeKeybinding))];
}

export interface KeybindingConflict {
  scope: "editor" | "selection" | "session" | "models" | "tree";
  key: string;
  actions: KeybindingAction[];
}

const EDITOR_ACTIONS = KEYBINDING_ACTIONS.filter((action) =>
  action.startsWith("tui.editor.")
  || action.startsWith("tui.input.")
  || (action.startsWith("app.")
    && !action.startsWith("app.session.toggle")
    && !action.startsWith("app.session.rename")
    && !action.startsWith("app.session.delete")
    && !action.startsWith("app.models.")
    && !action.startsWith("app.tree."))) as KeybindingAction[];
const SELECT_ACTIONS = KEYBINDING_ACTIONS.filter((action) => action.startsWith("tui.select.")) as KeybindingAction[];
const CONFLICT_SCOPES: ReadonlyArray<readonly [KeybindingConflict["scope"], readonly KeybindingAction[]]> = [
  ["editor", EDITOR_ACTIONS],
  ["selection", SELECT_ACTIONS],
  ["session", [...SELECT_ACTIONS, ...KEYBINDING_ACTIONS.filter((action) => action.startsWith("app.session.toggle") || action.startsWith("app.session.rename") || action.startsWith("app.session.delete"))]],
  ["models", [...SELECT_ACTIONS, ...KEYBINDING_ACTIONS.filter((action) => action.startsWith("app.models."))]],
  ["tree", [...SELECT_ACTIONS, "app.message.copy", ...KEYBINDING_ACTIONS.filter((action) => action.startsWith("app.tree."))]],
];

export class Keybindings {
  readonly #manager: KeybindingsManager;

  constructor(overrides: KeybindingOverrides = {}) {
    const userBindings: KeybindingsConfig = {};
    for (const action of KEYBINDING_ACTIONS) {
      const selected = overrides[action];
      if (selected !== undefined) userBindings[action] = bindingArray(selected, action) as KeybindingsConfig[typeof action];
    }
    this.#manager = new KeybindingsManager(COMPLETE_KEYBINDING_DEFINITIONS, userBindings);
  }

  /** Complete live manager shared with public TUI components and direct extensions. */
  manager(): KeybindingsManager {
    return this.#manager;
  }

  matches(action: KeybindingAction, event: KeyEvent): boolean {
    return this.keys(action).includes(keybindingForEvent(event));
  }

  keys(action: KeybindingAction): string[] {
    return [...this.#manager.getKeys(action)];
  }

  actionsForKey(value: string): KeybindingAction[] {
    const normalized = normalizeKeybinding(value);
    return KEYBINDING_ACTIONS.filter((action) => this.keys(action).includes(normalized));
  }

  conflicts(): KeybindingConflict[] {
    const conflicts: KeybindingConflict[] = [];
    for (const [scope, actions] of CONFLICT_SCOPES) {
      const owners = new Map<string, KeybindingAction[]>();
      for (const action of actions) for (const key of this.keys(action)) {
        const selected = owners.get(key) ?? [];
        selected.push(action);
        owners.set(key, selected);
      }
      for (const [key, selected] of owners) {
        if (key === "ctrl+c" && selected.length === 2 && selected.includes("tui.input.copy") && selected.includes("app.clear")) continue;
        if (selected.length > 1) conflicts.push({ scope, key, actions: selected });
      }
    }
    return conflicts;
  }
}

export function parseKeybindingOverrides(value: unknown): KeybindingOverrides {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Keybindings must be a JSON object");
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).filter((action) => !ACTIONS.has(action));
  if (unknown.length > 0) throw new Error(`Unknown keybinding actions: ${unknown.join(", ")}`);
  const overrides: KeybindingOverrides = {};
  for (const action of KEYBINDING_ACTIONS) {
    const selected = input[action];
    if (selected === undefined) continue;
    if (typeof selected !== "string" && (!Array.isArray(selected) || selected.some((entry) => typeof entry !== "string"))) {
      throw new Error(`Keybinding ${action} must be a string or string array`);
    }
    overrides[action] = selected as string | string[];
  }
  return overrides;
}

export function parseKeybindings(value: unknown): Keybindings {
  return new Keybindings(parseKeybindingOverrides(value));
}

export async function loadKeybindings(
  path: string,
  settingsOverrides: KeybindingOverrides = {},
): Promise<Keybindings> {
  let fileOverrides: KeybindingOverrides = {};
  try {
    const loaded = await readFileBounded(path, MAX_KEYBINDINGS_BYTES);
    if (loaded.truncated) throw new Error(`Keybindings file exceeds ${MAX_KEYBINDINGS_BYTES} bytes`);
    fileOverrides = parseKeybindingOverrides(JSON.parse(loaded.data.toString("utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const configured = parseKeybindingOverrides(settingsOverrides);
  return new Keybindings({ ...fileOverrides, ...configured });
}
