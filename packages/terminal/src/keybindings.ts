import { type KeyId, matchesKey, normalizeKeyIdentifier } from "./keys.js";

type EditorNavigationAction =
  | "cursorUp" | "cursorDown" | "cursorLeft" | "cursorRight"
  | "cursorWordLeft" | "cursorWordRight" | "cursorLineStart" | "cursorLineEnd"
  | "jumpForward" | "jumpBackward" | "pageUp" | "pageDown";
type EditorMutationAction =
  | "deleteCharBackward" | "deleteCharForward" | "deleteWordBackward" | "deleteWordForward"
  | "deleteToLineStart" | "deleteToLineEnd" | "yank" | "yankPop" | "undo" | "redo";
type InputAction = "newLine" | "submit" | "tab" | "copy";
type SelectAction = "up" | "down" | "pageUp" | "pageDown" | "confirm" | "cancel";
type TranscriptAction = "pageUp" | "pageDown" | "previousPrompt" | "nextPrompt" | "top" | "bottom";
type EditorNavigationKeybindings = Record<`tui.editor.${EditorNavigationAction}`, true>;
type EditorMutationKeybindings = Record<`tui.editor.${EditorMutationAction}`, true>;
type InputKeybindings = Record<`tui.input.${InputAction}`, true>;
type SelectKeybindings = Record<`tui.select.${SelectAction}`, true>;
type TranscriptKeybindings = Record<`tui.transcript.${TranscriptAction}`, true>;

export interface Keybindings extends
  TranscriptKeybindings,
  SelectKeybindings,
  InputKeybindings,
  EditorMutationKeybindings,
  EditorNavigationKeybindings {}

export type Keybinding = keyof Keybindings;
export type KeybindingsConfig = Record<string, KeyId | KeyId[] | undefined>;

export interface KeybindingDefinition {
  description?: string;
  defaultKeys: KeyId | KeyId[];
}

export type KeybindingDefinitions = Record<string, KeybindingDefinition>;

type BindingSpec = readonly [keys: KeyId | readonly KeyId[], description: string];

const TUI_BINDING_REGISTRY = {
  "tui.editor.cursorUp": ["up", "Move to the visual row above"],
  "tui.editor.cursorDown": ["down", "Move to the visual row below"],
  "tui.editor.cursorLeft": [["left", "ctrl+b"], "Move one character toward the beginning"],
  "tui.editor.cursorRight": [["right", "ctrl+f"], "Move one character toward the end"],
  "tui.editor.cursorWordLeft": [["alt+left", "ctrl+left", "alt+b"], "Go to the preceding word boundary"],
  "tui.editor.cursorWordRight": [["alt+right", "ctrl+right", "alt+f"], "Go to the following word boundary"],
  "tui.editor.cursorLineStart": [["home", "ctrl+a"], "Place the cursor at the line beginning"],
  "tui.editor.cursorLineEnd": [["end", "ctrl+e"], "Place the cursor at the line ending"],
  "tui.editor.jumpForward": ["ctrl+]", "Find the next matching character"],
  "tui.editor.jumpBackward": ["ctrl+alt+]", "Find the previous matching character"],
  "tui.editor.pageUp": ["pageUp", "Move the editor view upward by one page"],
  "tui.editor.pageDown": ["pageDown", "Move the editor view downward by one page"],
  "tui.editor.deleteCharBackward": ["backspace", "Remove the preceding character"],
  "tui.editor.deleteCharForward": [["delete", "ctrl+d"], "Remove the following character"],
  "tui.editor.deleteWordBackward": [["ctrl+w", "alt+backspace"], "Remove the preceding word"],
  "tui.editor.deleteWordForward": [["alt+d", "alt+delete"], "Remove the following word"],
  "tui.editor.deleteToLineStart": ["ctrl+u", "Remove text before the cursor on this line"],
  "tui.editor.deleteToLineEnd": ["ctrl+k", "Remove text after the cursor on this line"],
  "tui.editor.yank": ["ctrl+y", "Insert the most recently removed text"],
  "tui.editor.yankPop": ["alt+y", "Choose an earlier removed-text entry"],
  "tui.editor.undo": ["ctrl+z", "Reverse the latest editor change"],
  "tui.editor.redo": ["ctrl+shift+z", "Reapply the latest reversed editor change"],
  "tui.input.newLine": [["shift+enter", "ctrl+j"], "Add a line without sending"],
  "tui.input.submit": ["enter", "Send the editor contents"],
  "tui.input.tab": ["tab", "Complete text or insert a tab"],
  "tui.input.copy": ["ctrl+c", "Copy the selected text"],
  "tui.select.up": ["up", "Highlight the preceding item"],
  "tui.select.down": ["down", "Highlight the following item"],
  "tui.select.pageUp": ["pageUp", "Move the picker back one page"],
  "tui.select.pageDown": ["pageDown", "Move the picker forward one page"],
  "tui.select.confirm": ["enter", "Use the highlighted item"],
  "tui.select.cancel": [["escape", "ctrl+c"], "Close the current picker"],
  "tui.transcript.pageUp": ["pageUp", "Scroll the viewport toward earlier content"],
  "tui.transcript.pageDown": ["pageDown", "Scroll the viewport toward later content"],
  "tui.transcript.previousPrompt": ["ctrl+shift+up", "Jump to the preceding marked message"],
  "tui.transcript.nextPrompt": ["ctrl+shift+down", "Jump to the following marked message"],
  "tui.transcript.top": ["ctrl+home", "Go to the beginning of the viewport content"],
  "tui.transcript.bottom": ["ctrl+end", "Go to the end of the viewport content"],
} as const satisfies Record<Keybinding, BindingSpec>;

function copyKeys(value: KeyId | readonly KeyId[]): KeyId | KeyId[] {
  return Array.isArray(value) ? [...value] : value as KeyId;
}

function createTuiDefinitions(): KeybindingDefinitions {
  return Object.fromEntries(Object.entries(TUI_BINDING_REGISTRY).map(([name, [keys, description]]) => [
    name,
    { defaultKeys: copyKeys(keys), description },
  ]));
}

export const TUI_KEYBINDINGS: KeybindingDefinitions = createTuiDefinitions();

export interface KeybindingConflict {
  key: KeyId;
  keybindings: string[];
}

function uniqueKeys(value: KeyId | readonly KeyId[] | undefined): KeyId[] {
  return value === undefined ? [] : [...new Set(Array.isArray(value) ? value : [value as KeyId])];
}

function copyDefinition(definition: KeybindingDefinition): KeybindingDefinition {
  return definition.description === undefined
    ? { defaultKeys: copyKeys(definition.defaultKeys) }
    : { defaultKeys: copyKeys(definition.defaultKeys), description: definition.description };
}

function copyDefinitions(definitions: KeybindingDefinitions): KeybindingDefinitions {
  return Object.fromEntries(Object.entries(definitions).map(([name, definition]) => [name, copyDefinition(definition)]));
}

function copyConfig(config: KeybindingsConfig): KeybindingsConfig {
  return Object.fromEntries(Object.entries(config).map(([name, keys]) => [
    name,
    keys === undefined ? undefined : copyKeys(keys),
  ]));
}

function assertKnownBindings(definitions: KeybindingDefinitions, bindings: KeybindingsConfig): void {
  const unknown = Object.keys(bindings).filter((name) => !Object.hasOwn(definitions, name));
  if (unknown.length > 0) throw new Error(`Unknown keybindings: ${unknown.join(", ")}`);
}

export class KeybindingsManager {
  readonly #definitions: KeybindingDefinitions;
  #user: KeybindingsConfig;
  readonly #keys = new Map<string, KeyId[]>();
  #conflicts: KeybindingConflict[] = [];

  constructor(definitions: KeybindingDefinitions, userBindings: KeybindingsConfig = {}) {
    this.#definitions = copyDefinitions(definitions);
    assertKnownBindings(this.#definitions, userBindings);
    this.#user = copyConfig(userBindings);
    this.#rebuild();
  }

  matches(data: string, keybinding: Keybinding): boolean {
    return (this.#keys.get(keybinding) ?? []).some((key) => matchesKey(data, key));
  }

  getKeys(keybinding: Keybinding): KeyId[] {
    return [...(this.#keys.get(keybinding) ?? [])];
  }

  getDefinition(keybinding: Keybinding): KeybindingDefinition | undefined {
    const definition = this.#definitions[keybinding];
    return definition === undefined ? undefined : copyDefinition(definition);
  }

  getConflicts(): KeybindingConflict[] {
    return this.#conflicts.map(({ key, keybindings }) => ({ key, keybindings: [...keybindings] }));
  }

  setUserBindings(bindings: KeybindingsConfig): void {
    assertKnownBindings(this.#definitions, bindings);
    this.#user = copyConfig(bindings);
    this.#rebuild();
  }

  getUserBindings(): KeybindingsConfig {
    return copyConfig(this.#user);
  }

  getResolvedBindings(): KeybindingsConfig {
    return Object.fromEntries([...this.#keys].map(([name, keys]) => [name, keys.length === 1 ? keys[0] : [...keys]]));
  }

  #rebuild(): void {
    this.#keys.clear();
    const claims = new Map<KeyId, Set<string>>();
    for (const [name, definition] of Object.entries(this.#definitions)) {
      const configured = this.#user[name];
      const keys = uniqueKeys(configured === undefined ? definition.defaultKeys : configured);
      this.#keys.set(name, keys);
      if (configured === undefined) continue;
      for (const key of keys) {
        const normalized = normalizeKeyIdentifier(key);
        const owners = claims.get(normalized) ?? new Set<string>();
        owners.add(name);
        claims.set(normalized, owners);
      }
    }
    this.#conflicts = [...claims]
      .filter(([, owners]) => owners.size > 1)
      .map(([key, owners]) => ({ key, keybindings: [...owners] }));
  }
}

let current: KeybindingsManager | undefined;

export function setKeybindings(value: KeybindingsManager): void {
  current = value;
}

export function getKeybindings(): KeybindingsManager {
  return current ??= new KeybindingsManager(TUI_KEYBINDINGS);
}
