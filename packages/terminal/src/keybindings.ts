import { type KeyId, matchesKey, normalizeKeyIdentifier } from "./keys.js";

export interface Keybindings {
  "tui.editor.cursorUp": true; "tui.editor.cursorDown": true; "tui.editor.cursorLeft": true; "tui.editor.cursorRight": true;
  "tui.editor.cursorWordLeft": true; "tui.editor.cursorWordRight": true; "tui.editor.cursorLineStart": true; "tui.editor.cursorLineEnd": true;
  "tui.editor.jumpForward": true; "tui.editor.jumpBackward": true; "tui.editor.pageUp": true; "tui.editor.pageDown": true;
  "tui.editor.deleteCharBackward": true; "tui.editor.deleteCharForward": true; "tui.editor.deleteWordBackward": true; "tui.editor.deleteWordForward": true;
  "tui.editor.deleteToLineStart": true; "tui.editor.deleteToLineEnd": true; "tui.editor.yank": true; "tui.editor.yankPop": true; "tui.editor.undo": true;
  "tui.input.newLine": true; "tui.input.submit": true; "tui.input.tab": true; "tui.input.copy": true;
  "tui.select.up": true; "tui.select.down": true; "tui.select.pageUp": true; "tui.select.pageDown": true; "tui.select.confirm": true; "tui.select.cancel": true;
}
export type Keybinding = keyof Keybindings;
export interface KeybindingDefinition { defaultKeys: KeyId | KeyId[]; description?: string }
export type KeybindingDefinitions = Record<string, KeybindingDefinition>;
export type KeybindingsConfig = Record<string, KeyId | KeyId[] | undefined>;

export const TUI_KEYBINDINGS = {
  "tui.editor.cursorUp": { defaultKeys: "up", description: "Move cursor up" },
  "tui.editor.cursorDown": { defaultKeys: "down", description: "Move cursor down" },
  "tui.editor.cursorLeft": { defaultKeys: ["left", "ctrl+b"], description: "Move cursor left" },
  "tui.editor.cursorRight": { defaultKeys: ["right", "ctrl+f"], description: "Move cursor right" },
  "tui.editor.cursorWordLeft": { defaultKeys: ["alt+left", "ctrl+left", "alt+b"], description: "Move cursor word left" },
  "tui.editor.cursorWordRight": { defaultKeys: ["alt+right", "ctrl+right", "alt+f"], description: "Move cursor word right" },
  "tui.editor.cursorLineStart": { defaultKeys: ["home", "ctrl+a"], description: "Move to line start" },
  "tui.editor.cursorLineEnd": { defaultKeys: ["end", "ctrl+e"], description: "Move to line end" },
  "tui.editor.jumpForward": { defaultKeys: "ctrl+]", description: "Jump forward to character" },
  "tui.editor.jumpBackward": { defaultKeys: "ctrl+alt+]", description: "Jump backward to character" },
  "tui.editor.pageUp": { defaultKeys: "pageUp", description: "Page up" },
  "tui.editor.pageDown": { defaultKeys: "pageDown", description: "Page down" },
  "tui.editor.deleteCharBackward": { defaultKeys: "backspace", description: "Delete character backward" },
  "tui.editor.deleteCharForward": { defaultKeys: ["delete", "ctrl+d"], description: "Delete character forward" },
  "tui.editor.deleteWordBackward": { defaultKeys: ["ctrl+w", "alt+backspace"], description: "Delete word backward" },
  "tui.editor.deleteWordForward": { defaultKeys: ["alt+d", "alt+delete"], description: "Delete word forward" },
  "tui.editor.deleteToLineStart": { defaultKeys: "ctrl+u", description: "Delete to line start" },
  "tui.editor.deleteToLineEnd": { defaultKeys: "ctrl+k", description: "Delete to line end" },
  "tui.editor.yank": { defaultKeys: "ctrl+y", description: "Yank" },
  "tui.editor.yankPop": { defaultKeys: "alt+y", description: "Yank pop" },
  "tui.editor.undo": { defaultKeys: "ctrl+-", description: "Undo" },
  "tui.input.newLine": { defaultKeys: ["shift+enter", "ctrl+j"], description: "Insert newline" },
  "tui.input.submit": { defaultKeys: "enter", description: "Submit input" },
  "tui.input.tab": { defaultKeys: "tab", description: "Tab or autocomplete" },
  "tui.input.copy": { defaultKeys: "ctrl+c", description: "Copy selection" },
  "tui.select.up": { defaultKeys: "up", description: "Move selection up" },
  "tui.select.down": { defaultKeys: "down", description: "Move selection down" },
  "tui.select.pageUp": { defaultKeys: "pageUp", description: "Selection page up" },
  "tui.select.pageDown": { defaultKeys: "pageDown", description: "Selection page down" },
  "tui.select.confirm": { defaultKeys: "enter", description: "Confirm selection" },
  "tui.select.cancel": { defaultKeys: ["escape", "ctrl+c"], description: "Cancel selection" },
} as const satisfies KeybindingDefinitions;

export interface KeybindingConflict { key: KeyId; keybindings: string[] }
function list(value: KeyId | KeyId[] | undefined): KeyId[] { return value === undefined ? [] : [...new Set(Array.isArray(value) ? value : [value])]; }

export class KeybindingsManager {
  readonly #definitions: KeybindingDefinitions;
  #user: KeybindingsConfig;
  readonly #keys = new Map<string, KeyId[]>();
  #conflicts: KeybindingConflict[] = [];

  constructor(definitions: KeybindingDefinitions, userBindings: KeybindingsConfig = {}) {
    this.#definitions = definitions;
    this.#user = userBindings;
    this.#rebuild();
  }
  matches(data: string, keybinding: Keybinding): boolean { return (this.#keys.get(keybinding) ?? []).some((key) => matchesKey(data, key)); }
  getKeys(keybinding: Keybinding): KeyId[] { return [...(this.#keys.get(keybinding) ?? [])]; }
  getDefinition(keybinding: Keybinding): KeybindingDefinition { return this.#definitions[keybinding]!; }
  getConflicts(): KeybindingConflict[] { return this.#conflicts.map((conflict) => ({ key: conflict.key, keybindings: [...conflict.keybindings] })); }
  setUserBindings(bindings: KeybindingsConfig): void { this.#user = bindings; this.#rebuild(); }
  getUserBindings(): KeybindingsConfig { return { ...this.#user }; }
  getResolvedBindings(): KeybindingsConfig {
    return Object.fromEntries([...this.#keys].map(([name, keys]) => [name, keys.length === 1 ? keys[0] : [...keys]]));
  }
  #rebuild(): void {
    this.#keys.clear();
    const claims = new Map<KeyId, string[]>();
    for (const [name, definition] of Object.entries(this.#definitions)) {
      const keys = list(this.#user[name] === undefined ? definition.defaultKeys : this.#user[name]);
      this.#keys.set(name, keys);
      if (this.#user[name] !== undefined) for (const key of keys) {
        const normalized = normalizeKeyIdentifier(key) as KeyId;
        claims.set(normalized, [...(claims.get(normalized) ?? []), name]);
      }
    }
    this.#conflicts = [...claims].filter(([, names]) => names.length > 1).map(([key, keybindings]) => ({ key, keybindings }));
  }
}

let current: KeybindingsManager | undefined;
export function setKeybindings(value: KeybindingsManager): void { current = value; }
export function getKeybindings(): KeybindingsManager { return current ??= new KeybindingsManager(TUI_KEYBINDINGS); }
