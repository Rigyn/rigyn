import {
  setKeybindings as setPublicKeybindings,
  type Component,
  type EditorComponent,
  type KeybindingsManager,
  type OverlayHandle,
  type OverlayOptions,
} from "@rigyn/terminal";
import type { CustomMessage } from "@rigyn/kernel";

import type { EventEnvelope } from "../core/events.js";
import { defaultSecretRedactor } from "../auth/redaction.js";
import type { ImageBlock } from "../core/types.js";
import { readSecretFrom } from "../interfaces/terminal.js";
import { interactiveCommand, interactiveCommandPalette } from "../interactive/commands.js";
import { detectTerminalCapabilities, terminalSize } from "./capabilities.js";
import {
  RuntimeUiComponentMount,
  runtimeUiKeyEvent,
  sanitizeRuntimeUiBlock,
  type RuntimeEditorRendererBinding,
  type RuntimeEditorRenderView,
  type RuntimeToolRendererBinding,
  type RuntimeSessionRendererBinding,
  type RuntimeToolRenderView,
  type RuntimeUiBlock,
  type RuntimeUiComponentHandle,
  type RuntimeUiCustomOptions,
  type RuntimeUiComponentFactory,
  type RuntimeUiOverlayLength,
  type RuntimeUiOverlayHandle,
  type RuntimeUiOverlayOptions,
  type RuntimeUiOverlayUnfocusOptions,
  type RuntimeUiRenderContext,
} from "./components.js";
import { MultilineEditor, type EditorSnapshot, type TuiEditorImplementation } from "./editor.js";
import { editTextExternally, parseEditorCommand } from "./external-editor.js";
import { rankPickerItems } from "./fuzzy.js";
import { buildSessionPickerRows, type SessionPickerSortMode } from "./session-picker.js";
import {
  buildSessionTreePickerRows,
  SESSION_TREE_FILTER_MODES,
  sessionTreeEndpointIndex,
  type SessionTreeFilterMode,
} from "./session-tree-picker.js";
import { KeyDecoder, type KeyEvent, type TerminalReply } from "./keys.js";
import { Keybindings, keybindingForEvent, normalizeKeybinding, type KeybindingAction } from "./keybindings.js";
import { renderFrame, renderTranscriptFrame, type ToolRenderSlots } from "./layout.js";
import { TuiModel } from "./model.js";
import type {
  NativeUiAutocompleteWrapper,
  NativeUiEditorWrapper,
  NativeUiInputHandler,
  NativeUiInputResult,
  UnsafeTerminalInputHandler,
  UnsafeTerminalInputResult,
} from "./native-ui.js";
import { LiveSurfaceRenderer } from "./surface-renderer.js";
import { RawComponentMount } from "./raw-mount.js";
import {
  composeTerminalImageOutput,
  TerminalImageRegistry,
  terminalImageFallback,
  validateTerminalImage,
} from "./terminal-image.js";
import {
  createTheme,
  normalizeThemeSetting,
  parseAutomaticThemePair,
  resolveThemeSetting,
  THEME_ROLES,
  type Theme,
  type ThemeDefinition,
} from "./theme.js";
import {
  terminalColorSchemeForRgb,
  terminalColorSchemeFromEnvironment,
  type TerminalColorScheme,
} from "./terminal-colors.js";
import type {
  PickerItem,
  PickerKind,
  QueuedMessage,
  ScopedModelOption,
  ScopedModelSelection,
  SessionTreeMetadata,
  TerminalCapabilities,
  TerminalChoice,
  ThemeName,
  TranscriptEntry,
  TuiAction,
  TuiAutocompleteCompletion,
  TuiAutocompleteProvider,
  TuiCommandArgumentCompletion,
  TuiCommandCompletionProvider,
  TuiContext,
  TuiControllerOptions,
  TuiEditorMiddleware,
  TuiEditorMiddlewareResult,
  TuiExtensionShortcut,
  TuiInput,
  TuiInputImageAttachment,
  TuiLimits,
  TuiOutput,
  TuiOperatorPreferences,
  TuiNormalizedKeyObserver,
  TuiSessionEntry,
  TuiTranscriptItem,
  TuiPersistentComponentSlot,
  TuiSignalSource,
  TuiSettingItem,
  TuiThemeChange,
  TuiViewState,
  TuiWorkingIndicatorOptions,
} from "./types.js";
import { byteTruncate, cellWidth, sanitizeTerminalText, splitGraphemes, truncateCells } from "./unicode.js";
import { fileReferenceQuery } from "./workspace-files.js";

const ENTER_SCREEN = "\u001b[?1049h\u001b[?2004h\u001b[?25h\u001b[2J\u001b[H";
const LEAVE_SCREEN = "\u001b[?2004l\u001b[?25h\u001b[?1049l";
const ENTER_INLINE = "\u001b[?2004h\u001b[?25h";
const LEAVE_INLINE = "\u001b[?2004l\u001b[?25h";
const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const QUERY_KEYBOARD_PROTOCOL = "\u001b[?u\u001b[c";
const ENABLE_KITTY_KEYBOARD = "\u001b[>7u";
const DISABLE_KITTY_KEYBOARD = "\u001b[<u";
const ENABLE_MODIFY_OTHER_KEYS = "\u001b[>4;2m";
const DISABLE_MODIFY_OTHER_KEYS = "\u001b[>4m";
const QUERY_TERMINAL_BACKGROUND = "\u001b]11;?\u0007";
const QUERY_TERMINAL_COLOR_SCHEME = "\u001b[?996n";
const ENABLE_TERMINAL_COLOR_SCHEME = "\u001b[?2031h";
const DISABLE_TERMINAL_COLOR_SCHEME = "\u001b[?2031l";
const KEYBOARD_NEGOTIATION_MS = 80;
const ACTIVITY_FRAME_MS = 120;
const MAX_ADVANCED_UI_SLOT_COMPONENTS = 16;
const MAX_ADVANCED_UI_SLOT_LINES = 4;
const MAX_ADVANCED_UI_SLOT_BYTES = 16 * 1024;
const MIN_WORKING_INDICATOR_MS = 50;
const MAX_WORKING_INDICATOR_MS = 2_000;
const CONTROLLER_ADVANCED_UI_KEY = "controller:default";

function displayBinding(value: string, unicode: boolean): string {
  const names: Record<string, string> = {
    ctrl: "Ctrl",
    shift: "Shift",
    alt: "Alt",
    super: "Super",
    hyper: "Hyper",
    meta: "Meta",
    escape: "Esc",
    enter: "Enter",
    left: unicode ? "←" : "Left",
    right: unicode ? "→" : "Right",
    up: unicode ? "↑" : "Up",
    down: unicode ? "↓" : "Down",
  };
  return value.split("+").map((part) => names[part] ?? (part.length === 1 ? part.toUpperCase() : part)).join("+");
}

export class TuiSelectionCancelledError extends Error {
  constructor() {
    super("Selection cancelled");
    this.name = "TuiSelectionCancelledError";
  }
}

export const DEFAULT_TUI_LIMITS: TuiLimits = {
  maxTranscriptBytes: 2 * 1024 * 1024,
  maxTranscriptEntries: 2_000,
  maxToolPreviewBytes: 64 * 1024,
  maxEditorBytes: 256 * 1024,
  maxHistoryEntries: 100,
  maxUndoEntries: 100,
  maxPickerItems: 5_000,
};

const defaultCommands: PickerItem<string>[] = interactiveCommandPalette().map(({ keywords, ...command }) => ({
  ...command,
  label: command.id,
  detail: command.label,
  ...(keywords === undefined ? {} : { keywords: [...keywords] }),
}));

interface PendingQuestion {
  resolve(value: string): void;
  reject(error: Error): void;
  cleanup(): void;
  previousInputLabel: string;
  cancelable: boolean;
}

interface ToolRendererOwner {
  binding: RuntimeToolRendererBinding;
  signal: AbortSignal;
  onAbort(): void;
}

interface SessionRendererOwner {
  binding: RuntimeSessionRendererBinding;
  signal: AbortSignal;
  onAbort(): void;
}

interface EditorRendererOwner {
  binding: RuntimeEditorRendererBinding;
  signal: AbortSignal;
  warned: boolean;
  onAbort(): void;
}

interface RetainedSessionEntry {
  entry: TuiSessionEntry;
  message?: CustomMessage;
  bytes: number;
}

function retainedValueBytes(value: unknown, seen = new Set<object>(), depth = 0): number {
  if (value === null || value === undefined) return 4;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8") + 2;
  if (typeof value === "number" || typeof value === "boolean") return 16;
  if (typeof value !== "object" || depth > 32 || seen.has(value)) return 32;
  seen.add(value);
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
  let bytes = 2;
  for (const [key, child] of entries) {
    bytes += Buffer.byteLength(String(key), "utf8") + retainedValueBytes(child, seen, depth + 1) + 4;
    if (bytes > 2 * 1024 * 1024) break;
  }
  seen.delete(value);
  return bytes;
}

function retainSessionEntry(entry: TuiSessionEntry): RetainedSessionEntry {
  const snapshot = structuredClone(entry);
  const message: CustomMessage | undefined = snapshot.type === "custom_message"
    ? {
        role: "custom",
        customType: snapshot.customType,
        content: structuredClone(snapshot.content),
        display: snapshot.display,
        ...(snapshot.details === undefined ? {} : { details: structuredClone(snapshot.details) }),
        timestamp: Number.isFinite(Date.parse(snapshot.timestamp)) ? Date.parse(snapshot.timestamp) : 0,
      }
    : undefined;
  return {
    entry: snapshot,
    ...(message === undefined ? {} : { message }),
    bytes: retainedValueBytes(snapshot) + 64,
  };
}

interface ExtensionShortcutOwner {
  shortcuts: Map<string, TuiExtensionShortcut>;
  signal: AbortSignal;
  onAbort(): void;
}

interface CommandCompletionOwner {
  provider: TuiCommandCompletionProvider;
  signal: AbortSignal;
  onAbort(): void;
}

interface PendingCommandCompletion {
  controller: AbortController;
  owner: CommandCompletionOwner;
  text: string;
  cursor: number;
}

interface AutocompleteOwner {
  provider: TuiAutocompleteProvider;
  signal: AbortSignal;
  onAbort(): void;
}

interface PendingAutocomplete {
  controller: AbortController;
  owner: ActiveAutocompleteOwner;
  text: string;
  cursor: number;
}

interface ActiveAutocompleteOwner {
  provider: TuiAutocompleteProvider;
  signal: AbortSignal;
  version: number;
}

interface NativeAutocompleteOwner {
  previous: TuiAutocompleteProvider;
  provider: TuiAutocompleteProvider;
  signal: AbortSignal;
  onAbort(): void;
}

interface EditorMiddlewareOwner {
  middleware: TuiEditorMiddleware;
  signal: AbortSignal;
  onAbort(): void;
}

interface NativeInputOwner {
  handler: NativeUiInputHandler;
  signal: AbortSignal;
  onAbort(): void;
}

interface UnsafeTerminalInputOwner {
  handler: UnsafeTerminalInputHandler;
  signal: AbortSignal;
  onAbort(): void;
}

interface NativeEditorOwner {
  editor: TuiEditorImplementation;
  previous: TuiEditorImplementation;
  signal: AbortSignal;
  onAbort(): void;
}

interface NativeThemeOwner {
  theme: Theme;
  previous: Theme;
  signal: AbortSignal;
  onAbort(): void;
}

interface PersistentRuntimeComponentOwner {
  mount: RuntimeUiComponentMount<void>;
}

interface PersistentRawComponentOwner {
  mount: RawComponentMount<void>;
  hidden: boolean;
}

interface WorkingIndicatorOwner {
  value: TuiWorkingIndicatorOptions;
  signal: AbortSignal;
  onAbort(): void;
}

interface HiddenReasoningLabelOwner {
  value: string;
  signal: AbortSignal;
  onAbort(): void;
}

interface ToolOutputExpansionOwner {
  value: boolean;
  signal: AbortSignal;
  onAbort(): void;
}

interface NormalizedKeyObserverOwner {
  key: string;
  observer: TuiNormalizedKeyObserver;
  signal: AbortSignal;
  onAbort(): void;
}

interface RuntimeComponentOwner {
  mount: RuntimeUiComponentMount<unknown>;
  options: NormalizedRuntimeCustomOptions;
  hidden: boolean;
  focused: boolean;
  focusOrder: number;
  preFocus: RuntimeComponentOwner | null;
  restoreWhenVisible: boolean;
  handle?: RuntimeUiComponentHandle;
}

interface RawComponentOwner {
  mount: RawComponentMount<unknown>;
  options: NormalizedRuntimeCustomOptions;
  hidden: boolean;
  focused: boolean;
  focusOrder: number;
  preFocus: RawComponentOwner | null;
  restoreWhenVisible: boolean;
  handle?: RuntimeUiComponentHandle;
}

interface RawEditorOwner {
  component: EditorComponent;
  signal: AbortSignal;
  onAbort(): void;
}

interface NormalizedRuntimeCustomOptions extends Omit<RuntimeUiCustomOptions, "overlayOptions"> {
  overlayOptions?: RuntimeUiOverlayOptions;
}

interface Overlay {
  kind: PickerKind;
  title: string;
  source: PickerItem[];
  items: PickerItem[];
  query: MultilineEditor;
  selected: number;
  resolve?: (value: unknown) => void;
  reject?: (error: Error) => void;
  cleanup(): void;
  maxVisible?: number;
  settings?: {
    onChange(item: TuiSettingItem, value: string): void | Promise<void>;
    busy: boolean;
    status?: string;
  };
  session?: {
    sort: SessionPickerSortMode;
    namedOnly: boolean;
    showPath: boolean;
    mode: "list" | "rename" | "confirm_delete";
    target?: PickerItem;
    listQuery?: EditorSnapshot;
    status?: string;
    scope: "current" | "all";
    hasMore: boolean;
    loadingMore: boolean;
  };
  scopedModels?: {
    source: PickerItem<ScopedModelOption>[];
    selected: Set<string>;
    order: string[];
    all: boolean;
    live?: boolean;
    onChange?: (selection: ScopedModelSelection) => void;
    onSave?: (selection: ScopedModelSelection) => void | Promise<void>;
    status?: string;
  };
  modelPicker?: {
    all: PickerItem[];
    scoped?: PickerItem[];
    mode: "all" | "scoped";
  };
  tree?: {
    folded: Set<string>;
    activeOnly: boolean;
    filter: SessionTreeFilterMode;
    showLabelTimestamps: boolean;
    mode: "list" | "label";
    target?: PickerItem;
    listQuery?: EditorSnapshot;
    onLabelChange?: (eventId: string, label: string | undefined) =>
      { label?: string; labelTimestamp?: string } | Promise<{ label?: string; labelTimestamp?: string }>;
    preferredActiveEventId?: string;
    status?: string;
    busy?: boolean;
  };
}

function settingPickerItem(item: TuiSettingItem): PickerItem<TuiSettingItem> {
  return {
    id: `setting:${item.id}`,
    label: item.label,
    detail: item.value,
    description: item.description,
    keywords: [item.description, ...item.values],
    value: { ...item, values: [...item.values] },
  };
}

const SCOPED_MODEL_SAVE = "scoped-model:save";
const SCOPED_MODEL_ALL = "scoped-model:all";
const SCOPED_MODEL_NONE = "scoped-model:none";

const scopedModelActions: PickerItem<string>[] = [
  { id: SCOPED_MODEL_SAVE, label: "Save selection", detail: "Ctrl+S", keywords: ["save apply"], value: SCOPED_MODEL_SAVE },
  { id: SCOPED_MODEL_ALL, label: "Enable all models", detail: "Ctrl+A", keywords: ["all every"], value: SCOPED_MODEL_ALL },
  { id: SCOPED_MODEL_NONE, label: "Clear all models", detail: "Ctrl+X", keywords: ["none clear disable"], value: SCOPED_MODEL_NONE },
];

function limits(input: Partial<TuiLimits> | undefined): TuiLimits {
  const result = { ...DEFAULT_TUI_LIMITS, ...input };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  }
  return result;
}

function error(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function modelPickerDisplayItem(item: PickerItem, context: TuiContext, unicode: boolean): PickerItem {
  const value = item.value;
  if (value === null || typeof value !== "object"
    || !("provider" in value) || typeof value.provider !== "string" || value.provider === ""
    || !("model" in value) || typeof value.model !== "string" || value.model === "") return item;
  const current = value.provider === context.provider && value.model === context.model;
  return {
    ...item,
    label: `${value.model} [${value.provider}]${current ? unicode ? " ✓" : " [current]" : ""}`,
  };
}

const RUNTIME_OVERLAY_ANCHORS = new Set([
  "top-left", "top-center", "top-right",
  "left-center", "center", "right-center",
  "bottom-left", "bottom-center", "bottom-right",
]);

function runtimeOverlayLength(
  value: RuntimeUiOverlayLength | undefined,
  label: string,
  allowZero = false,
  allowNegativeNumber = false,
): void {
  if (value === undefined) return;
  if (typeof value === "number") {
    const minimum = allowNegativeNumber ? -1_000_000 : allowZero ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum || value > 1_000_000) {
      throw new Error(`${label} must be a ${allowNegativeNumber ? "bounded" : allowZero ? "non-negative" : "positive"} safe integer`);
    }
    return;
  }
  const match = /^(\d{1,3}(?:\.\d+)?)%$/u.exec(value);
  const percentage = Number(match?.[1]);
  if (match === null || !Number.isFinite(percentage) || percentage < (allowZero ? 0 : Number.MIN_VALUE) || percentage > 100) {
    throw new Error(`${label} must be ${allowZero ? "0" : "more than 0"}% to 100%`);
  }
}

function normalizeRuntimeCustomOptions(value: RuntimeUiCustomOptions | undefined): NormalizedRuntimeCustomOptions {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Runtime component options must be an object");
  const unknownOptions = Object.keys(value).filter((key) => !["overlay", "overlayOptions", "onHandle"].includes(key));
  if (unknownOptions.length > 0) throw new Error(`Runtime component options contain unknown keys: ${unknownOptions.join(", ")}`);
  if (value.overlay !== undefined && typeof value.overlay !== "boolean") throw new Error("Runtime component overlay must be boolean");
  if (value.onHandle !== undefined && typeof value.onHandle !== "function") throw new Error("Runtime component onHandle must be a function");
  const source = value.overlayOptions;
  const input = typeof source === "function" ? source() : source;
  if (input === undefined) {
    const { overlayOptions: _overlayOptions, ...rest } = value;
    return rest;
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Runtime overlay options must be an object");
  const unknownOverlayOptions = Object.keys(input).filter((key) => ![
    "anchor", "width", "minWidth", "maxHeight", "row", "col", "margin", "offsetX", "offsetY", "nonCapturing", "visible",
  ].includes(key));
  if (unknownOverlayOptions.length > 0) throw new Error(`Runtime overlay options contain unknown keys: ${unknownOverlayOptions.join(", ")}`);
  if (input.anchor !== undefined && !RUNTIME_OVERLAY_ANCHORS.has(input.anchor)) throw new Error("Runtime overlay anchor is invalid");
  runtimeOverlayLength(input.width, "Runtime overlay width");
  if (input.minWidth !== undefined && (!Number.isSafeInteger(input.minWidth) || input.minWidth < 1 || input.minWidth > 1_000_000)) {
    throw new Error("Runtime overlay minWidth must be a positive safe integer");
  }
  runtimeOverlayLength(input.maxHeight, "Runtime overlay maxHeight");
  runtimeOverlayLength(input.row, "Runtime overlay row", true, true);
  runtimeOverlayLength(input.col, "Runtime overlay col", true, true);
  for (const [label, selected] of [["offsetX", input.offsetX], ["offsetY", input.offsetY]] as const) {
    if (selected !== undefined && (!Number.isSafeInteger(selected) || Math.abs(selected) > 1_000_000)) {
      throw new Error(`Runtime overlay ${label} must be a bounded safe integer`);
    }
  }
  if (input.nonCapturing !== undefined && typeof input.nonCapturing !== "boolean") throw new Error("Runtime overlay nonCapturing must be boolean");
  if (input.visible !== undefined && typeof input.visible !== "function") throw new Error("Runtime overlay visible must be a function");
  const margin = input.margin;
  if (typeof margin === "number") {
    if (!Number.isSafeInteger(margin) || margin < 0 || margin > 1_000_000) throw new Error("Runtime overlay margin is invalid");
  } else if (margin !== undefined) {
    if (margin === null || typeof margin !== "object" || Array.isArray(margin)) throw new Error("Runtime overlay margin is invalid");
    const unknownMargins = Object.keys(margin).filter((key) => !["top", "right", "bottom", "left"].includes(key));
    if (unknownMargins.length > 0) throw new Error(`Runtime overlay margin contains unknown keys: ${unknownMargins.join(", ")}`);
    for (const selected of [margin.top, margin.right, margin.bottom, margin.left]) {
      if (selected !== undefined && (!Number.isSafeInteger(selected) || selected < 0 || selected > 1_000_000)) {
        throw new Error("Runtime overlay margin is invalid");
      }
    }
  }
  return { ...value, overlayOptions: { ...input, ...(typeof margin === "object" ? { margin: { ...margin } } : {}) } };
}

function resolveRuntimeLength(value: RuntimeUiOverlayLength | undefined, total: number, fallback: number): number {
  if (value === undefined) return Math.max(1, Math.min(total, fallback));
  if (typeof value === "number") return Math.max(1, Math.min(total, value));
  return Math.max(1, Math.min(total, Math.floor(total * Number.parseFloat(value) / 100)));
}

function resolveRuntimeWidth(options: RuntimeUiOverlayOptions, total: number, fallback: number): number {
  const margin = options.margin;
  const left = typeof margin === "number" ? margin : margin?.left ?? 0;
  const right = typeof margin === "number" ? margin : margin?.right ?? 0;
  const available = Math.max(1, total - left - right);
  const width = resolveRuntimeLength(options.width, total, Math.min(fallback, available));
  return Math.max(1, Math.min(available, Math.max(width, options.minWidth ?? 1)));
}

function resolveRuntimeHeight(options: RuntimeUiOverlayOptions, total: number, fallback: number): number {
  const margin = options.margin;
  const top = typeof margin === "number" ? margin : margin?.top ?? 0;
  const bottom = typeof margin === "number" ? margin : margin?.bottom ?? 0;
  const available = Math.max(1, total - top - bottom);
  return Math.max(1, Math.min(available, resolveRuntimeLength(options.maxHeight, total, fallback)));
}

function inputLabel(prompt: string): string {
  const normalized = sanitizeTerminalText(prompt).replaceAll("\n", " ").trim();
  return normalized.replace(/[>:]\s*$/u, "") || "you";
}

function commonPrefix(values: readonly string[]): string {
  if (values.length === 0) return "";
  let prefix = values[0] ?? "";
  for (const value of values.slice(1)) {
    while (prefix !== "" && !value.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

function commandCompletionQuery(text: string, cursor: number): { command: string; prefix: string } | undefined {
  if (cursor !== text.length) return undefined;
  const match = /^\/([a-z][a-z0-9-]{0,62})\s(.*)$/su.exec(text);
  return match === null ? undefined : { command: match[1]!, prefix: match[2]! };
}

function validatedCommandCompletions(value: readonly TuiCommandArgumentCompletion[] | null): TuiCommandArgumentCompletion[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 256) throw new Error("Command completion result is invalid");
  return value.map((item) => {
    if (item === null || typeof item !== "object" || typeof item.value !== "string"
      || item.value.includes("\0") || Buffer.byteLength(item.value) > 64 * 1024) {
      throw new Error("Command completion item is invalid");
    }
    if (item.label !== undefined && (typeof item.label !== "string" || item.label.includes("\0") || Buffer.byteLength(item.label) > 4 * 1024)) {
      throw new Error("Command completion label is invalid");
    }
    if (item.detail !== undefined && (typeof item.detail !== "string" || item.detail.includes("\0") || Buffer.byteLength(item.detail) > 16 * 1024)) {
      throw new Error("Command completion detail is invalid");
    }
    return { ...item };
  });
}

function validatedAutocompleteCompletions(
  value: readonly TuiAutocompleteCompletion[] | null,
  text: string,
): TuiAutocompleteCompletion[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 256) throw new Error("Autocomplete result is invalid");
  const length = splitGraphemes(text).length;
  return value.map((item) => {
    if (item === null || typeof item !== "object"
      || !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end)
      || item.start < 0 || item.end < item.start || item.end > length
      || typeof item.value !== "string" || item.value.includes("\0")
      || Buffer.byteLength(item.value) > 64 * 1024) {
      throw new Error("Autocomplete item is invalid");
    }
    if (item.label !== undefined && (typeof item.label !== "string" || item.label.includes("\0") || Buffer.byteLength(item.label) > 4 * 1024)) {
      throw new Error("Autocomplete label is invalid");
    }
    if (item.detail !== undefined && (typeof item.detail !== "string" || item.detail.includes("\0") || Buffer.byteLength(item.detail) > 16 * 1024)) {
      throw new Error("Autocomplete detail is invalid");
    }
    return { ...item };
  });
}

function validatedEditorMiddlewareResult(
  value: TuiEditorMiddlewareResult | void,
  maximumBytes: number,
): TuiEditorMiddlewareResult {
  if (value === undefined) return { action: "pass" };
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Editor middleware result is invalid");
  const keys = Object.keys(value);
  if (value.action === "pass" || value.action === "handled") {
    if (keys.length !== 1) throw new Error("Editor middleware result contains unknown fields");
    return value;
  }
  if (value.action !== "replace" || keys.some((key) => !["action", "text", "cursor"].includes(key))
    || typeof value.text !== "string" || value.text.includes("\0") || Buffer.byteLength(value.text) > maximumBytes) {
    throw new Error("Editor middleware replacement is invalid");
  }
  const length = splitGraphemes(value.text).length;
  if (value.cursor !== undefined && (!Number.isSafeInteger(value.cursor) || value.cursor < 0 || value.cursor > length)) {
    throw new Error("Editor middleware cursor is invalid");
  }
  return { action: "replace", text: value.text, ...(value.cursor === undefined ? {} : { cursor: value.cursor }) };
}

function persistentComponentKey(value: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/u.test(value)) {
    throw new Error("Persistent UI component keys must be 1-128 identifier characters");
  }
  return value;
}

const PERSISTENT_COMPONENT_SLOTS = [
  "header",
  "widget",
  "widget-above",
  "widget-below",
  "footer",
  "header-replacement",
  "footer-replacement",
] as const satisfies readonly TuiPersistentComponentSlot[];

function workingIndicatorOptions(value: TuiWorkingIndicatorOptions): TuiWorkingIndicatorOptions {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Working indicator options must be an object");
  }
  if (!Array.isArray(value.frames) || value.frames.length > 32
    || (value.frames.length === 0 && value.hidden !== true)) {
    throw new RangeError("Working indicator frames must contain 1-32 values");
  }
  if (!Number.isSafeInteger(value.intervalMs)
    || value.intervalMs < MIN_WORKING_INDICATOR_MS
    || value.intervalMs > MAX_WORKING_INDICATOR_MS) {
    throw new RangeError(`Working indicator interval must be ${MIN_WORKING_INDICATOR_MS}-${MAX_WORKING_INDICATOR_MS}ms`);
  }
  let bytes = 0;
  const frames = value.frames.map((frame) => {
    if (typeof frame !== "string") throw new TypeError("Working indicator frames must be strings");
    const safe = truncateCells(sanitizeTerminalText(frame).replaceAll("\n", " "), 16).trim();
    if (safe === "") throw new Error("Working indicator frames cannot be empty");
    bytes += Buffer.byteLength(safe, "utf8");
    if (bytes > 1_024) throw new RangeError("Working indicator frames exceed 1 KiB");
    return safe;
  });
  return Object.freeze({
    frames: Object.freeze(frames),
    intervalMs: value.intervalMs,
    ...(value.hidden === true ? { hidden: true } : {}),
  });
}

function hiddenReasoningLabel(value: string): string {
  if (typeof value !== "string") throw new TypeError("Hidden reasoning label must be a string");
  const safe = truncateCells(byteTruncate(sanitizeTerminalText(value).replaceAll("\n", " ").trim(), 64), 32);
  if (safe === "") throw new Error("Hidden reasoning label cannot be empty");
  return safe;
}

const EDITOR_IMPLEMENTATION_METHODS = [
  "snapshot", "restore", "setText", "clear", "insert", "insertPaste", "backspace", "deleteForward",
  "deleteToLineStart", "deleteToLineEnd", "deleteWordBackward", "deleteWordForward", "moveLeft", "moveRight",
  "moveHome", "moveEnd", "moveUp", "moveDown", "movePage", "hasMultipleVisualRows", "jumpToCharacter",
  "yank", "yankPop", "undo", "redo", "commitHistory", "historyPrevious", "historyNext",
] as const;

function validatedEditorImplementation(value: TuiEditorImplementation): TuiEditorImplementation {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    throw new TypeError("Native editor implementation must be an object");
  }
  const selected = value as unknown as Record<string, unknown>;
  if (typeof selected.text !== "string" || typeof selected.empty !== "boolean"
    || !Number.isSafeInteger(selected.cursor) || (selected.cursor as number) < 0
    || !Number.isSafeInteger(selected.length) || (selected.length as number) < 0) {
    throw new TypeError("Native editor implementation has invalid state accessors");
  }
  for (const method of EDITOR_IMPLEMENTATION_METHODS) {
    if (typeof selected[method] !== "function") {
      throw new TypeError(`Native editor implementation is missing ${method}()`);
    }
  }
  return value;
}

function nativeKeyEvent(value: KeyEvent, maximumTextBytes: number): KeyEvent {
  if (value === null || typeof value !== "object") throw new TypeError("Native input rewrite must contain an event object");
  if (typeof value.key !== "string" || value.key === "" || Buffer.byteLength(value.key, "utf8") > 64
    || sanitizeTerminalText(value.key) !== value.key || value.key.includes("\n")) {
    throw new TypeError("Native input event key is invalid");
  }
  if (value.text !== undefined && (typeof value.text !== "string" || Buffer.byteLength(value.text, "utf8") > maximumTextBytes)) {
    throw new RangeError(`Native input event text exceeds ${maximumTextBytes} bytes`);
  }
  for (const key of ["ctrl", "alt", "shift", "super", "hyper", "meta", "capsLock", "numLock", "keypad"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") throw new TypeError(`Native input event ${key} must be boolean`);
  }
  for (const key of ["alternateKey", "baseLayoutKey"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || Buffer.byteLength(value[key], "utf8") > 64)) {
      throw new TypeError(`Native input event ${key} is invalid`);
    }
  }
  if (value.eventType !== undefined && value.eventType !== "press" && value.eventType !== "repeat") {
    throw new TypeError("Native input event type is invalid");
  }
  return Object.freeze({
    key: value.key,
    ...(value.text === undefined ? {} : { text: sanitizeTerminalText(value.text) }),
    ...(value.ctrl === undefined ? {} : { ctrl: value.ctrl }),
    ...(value.alt === undefined ? {} : { alt: value.alt }),
    ...(value.shift === undefined ? {} : { shift: value.shift }),
    ...(value.super === undefined ? {} : { super: value.super }),
    ...(value.hyper === undefined ? {} : { hyper: value.hyper }),
    ...(value.meta === undefined ? {} : { meta: value.meta }),
    ...(value.capsLock === undefined ? {} : { capsLock: value.capsLock }),
    ...(value.numLock === undefined ? {} : { numLock: value.numLock }),
    ...(value.keypad === undefined ? {} : { keypad: value.keypad }),
    ...(value.alternateKey === undefined ? {} : { alternateKey: sanitizeTerminalText(value.alternateKey) }),
    ...(value.baseLayoutKey === undefined ? {} : { baseLayoutKey: sanitizeTerminalText(value.baseLayoutKey) }),
    ...(value.eventType === undefined ? {} : { eventType: value.eventType }),
  });
}

function frozenTheme(value: Theme): Theme {
  return Object.freeze({
    name: value.name,
    ansi: value.ansi,
    unicode: value.unicode,
    glyphs: Object.freeze({ ...value.glyphs }),
    codes: Object.freeze({ ...value.codes }),
    fg: (color, text) => value.fg(color, text),
    bg: (color, text) => value.bg(color, text),
    bold: (text) => value.bold(text),
    italic: (text) => value.italic(text),
    underline: (text) => value.underline(text),
    inverse: (text) => value.inverse(text),
    strikethrough: (text) => value.strikethrough(text),
    getFgAnsi: (color) => value.getFgAnsi(color),
    getBgAnsi: (color) => value.getBgAnsi(color),
    getColorMode: () => value.getColorMode(),
    getThinkingBorderColor: (level) => value.getThinkingBorderColor(level),
    getBashModeBorderColor: () => value.getBashModeBorderColor(),
  } satisfies Theme);
}

function validatedNativeTheme(value: Theme, capabilities: TerminalCapabilities): Theme {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Native theme must be an object");
  }
  if (!/^[a-z][a-z0-9._-]{0,62}$/u.test(value.name) || typeof value.ansi !== "boolean" || typeof value.unicode !== "boolean") {
    throw new TypeError("Native theme name or ANSI flag is invalid");
  }
  for (const method of [
    "fg", "bg", "bold", "italic", "underline", "inverse", "strikethrough",
    "getFgAnsi", "getBgAnsi", "getColorMode", "getThinkingBorderColor", "getBashModeBorderColor",
  ] as const) {
    if (typeof value[method] !== "function") throw new TypeError(`Native theme method ${method} is invalid`);
  }
  if (value.glyphs === null || typeof value.glyphs !== "object" || Array.isArray(value.glyphs)) {
    throw new TypeError("Native theme glyphs are invalid");
  }
  const glyphKeys = ["assistant", "user", "tool", "success", "failure", "pending", "scroll", "horizontal"] as const;
  if (Object.keys(value.glyphs).some((key) => !glyphKeys.includes(key as typeof glyphKeys[number]))) {
    throw new TypeError("Native theme glyphs contain unknown fields");
  }
  const glyphs = Object.fromEntries(glyphKeys.map((key) => {
    const glyph = value.glyphs[key];
    if (
      typeof glyph !== "string" || glyph === "" || sanitizeTerminalText(glyph) !== glyph ||
      cellWidth(glyph) < 1 || cellWidth(glyph) > 4 || Buffer.byteLength(glyph, "utf8") > 32 ||
      (key === "horizontal" && cellWidth(glyph) !== 1)
    ) throw new TypeError(`Native theme glyph ${key} is invalid`);
    return [key, glyph];
  })) as unknown as Theme["glyphs"];
  if (value.codes === null || typeof value.codes !== "object" || Array.isArray(value.codes)) {
    throw new TypeError("Native theme codes are invalid");
  }
  if (Object.keys(value.codes).some((key) => !THEME_ROLES.includes(key as typeof THEME_ROLES[number]))) {
    throw new TypeError("Native theme codes contain unknown fields");
  }
  const codes = Object.fromEntries(THEME_ROLES.map((role) => {
    const code = value.codes[role];
    if (typeof code !== "string" || Buffer.byteLength(code, "utf8") > 128 || !/^(?:\x1b\[[0-9;]{0,48}m)*$/u.test(code)) {
      throw new TypeError(`Native theme code ${role} is invalid`);
    }
    return [role, capabilities.color && value.ansi ? code : ""];
  })) as Record<typeof THEME_ROLES[number], string>;
  const methods = capabilities.color
    ? value
    : createTheme("mono", { color: false, unicode: capabilities.unicode && value.unicode });
  return frozenTheme({
    name: value.name,
    ansi: capabilities.color && value.ansi,
    unicode: capabilities.unicode && value.unicode,
    glyphs,
    codes,
    fg: methods.fg,
    bg: methods.bg,
    bold: methods.bold,
    italic: methods.italic,
    underline: methods.underline,
    inverse: methods.inverse,
    strikethrough: methods.strikethrough,
    getFgAnsi: methods.getFgAnsi,
    getBgAnsi: methods.getBgAnsi,
    getColorMode: methods.getColorMode,
    getThinkingBorderColor: methods.getThinkingBorderColor,
    getBashModeBorderColor: methods.getBashModeBorderColor,
  });
}

const EMPTY_AUTOCOMPLETE_PROVIDER: TuiAutocompleteProvider = () => null;

/**
 * Owns an interactive terminal session and combines the legacy terminal-input
 * and event-renderer surfaces. Construct it with process streams for production,
 * or PassThrough/fake streams for deterministic tests. Call `start()` once,
 * then use `question`, `choose`, `setSteering`, and `render`; always call `close`.
 */
export class TuiController {
  readonly input: TuiInput;
  readonly output: TuiOutput;
  readonly capabilities: TerminalCapabilities;
  readonly mode: TerminalCapabilities["mode"];
  readonly #limits: TuiLimits;
  readonly #model: TuiModel;
  readonly #baseEditor: MultilineEditor;
  #editor: TuiEditorImplementation;
  readonly #decoder = new KeyDecoder();
  readonly #signalSource: TuiSignalSource;
  readonly #handleSignals: boolean;
  #onAction: ((action: TuiAction) => void) | undefined;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #semanticZones: boolean;
  readonly #surface: LiveSurfaceRenderer;
  readonly #terminalImages = new TerminalImageRegistry();
  readonly #lifecycleAbort = new AbortController();
  #keybindings: Keybindings;
  readonly #pickerSources = new Map<PickerKind, PickerItem[]>();
  #sessionPickerPagination: { hasMore: boolean; status?: string } = { hasMore: false };
  #modelCycleItems: PickerItem[] | undefined;
  #modelPickerViews: { all: PickerItem[]; scoped?: PickerItem[] } | undefined;
  readonly #drafts = new Map<string, EditorSnapshot>();
  readonly #draftImages = new Map<string, TuiInputImageAttachment[]>();
  readonly #draftRecoveredImages = new Map<string, ImageBlock[]>();
  readonly #draftRecoveredQueue = new Map<string, boolean>();
  readonly #customThemes = new Map<string, ThemeDefinition>();
  readonly #extensionStatuses = new Map<string, string>();
  readonly #extensionWidgets = new Map<string, string>();
  readonly #extensionHeaders = new Map<string, string>();
  readonly #extensionFooters = new Map<string, string>();
  readonly #inlineCommittedIds = new Set<string>();
  readonly #inlineRevealedIds = new Set<string>();
  #toolRenderers: ToolRendererOwner | undefined;
  #sessionRenderers: SessionRendererOwner | undefined;
  #editorRenderer: EditorRendererOwner | undefined;
  readonly #sessionEntries = new Map<string, RetainedSessionEntry>();
  #sessionEntryBytes = 0;
  #extensionShortcuts: ExtensionShortcutOwner | undefined;
  #commandCompletion: CommandCompletionOwner | undefined;
  #pendingCommandCompletion: PendingCommandCompletion | undefined;
  #autocomplete: AutocompleteOwner | undefined;
  #pendingAutocomplete: PendingAutocomplete | undefined;
  readonly #nativeAutocomplete = new Array<NativeAutocompleteOwner>();
  #autocompleteVersion = 0;
  #editorMiddleware: EditorMiddlewareOwner | undefined;
  readonly #nativeInputHandlers = new Array<NativeInputOwner>();
  readonly #unsafeTerminalInputHandlers = new Array<UnsafeTerminalInputOwner>();
  readonly #nativeEditors = new Array<NativeEditorOwner>();
  readonly #nativeThemes = new Array<NativeThemeOwner>();
  readonly #persistentRuntimeComponents: Record<TuiPersistentComponentSlot, Map<string, PersistentRuntimeComponentOwner>> = {
    header: new Map(),
    footer: new Map(),
    widget: new Map(),
    "widget-above": new Map(),
    "widget-below": new Map(),
    "header-replacement": new Map(),
    "footer-replacement": new Map(),
  };
  readonly #persistentRawComponents: Record<TuiPersistentComponentSlot, Map<string, PersistentRawComponentOwner>> = {
    header: new Map(),
    footer: new Map(),
    widget: new Map(),
    "widget-above": new Map(),
    "widget-below": new Map(),
    "header-replacement": new Map(),
    "footer-replacement": new Map(),
  };
  readonly #workingIndicators = new Map<string, WorkingIndicatorOwner>();
  readonly #hiddenReasoningLabels = new Map<string, HiddenReasoningLabelOwner>();
  readonly #toolOutputExpansions = new Map<string, ToolOutputExpansionOwner>();
  #toolOutputExpansionBaseline: boolean | undefined;
  readonly #normalizedKeyObservers = new Map<string, NormalizedKeyObserverOwner>();
  #runtimeComponent: RuntimeComponentOwner | undefined;
  readonly #runtimeOverlays: RuntimeComponentOwner[] = [];
  #runtimeFocusOrder = 0;
  #rawRuntimeComponent: RawComponentOwner | undefined;
  readonly #rawRuntimeOverlays: RawComponentOwner[] = [];
  #rawRuntimeFocusOrder = 0;
  readonly #rawComponentOwners = new WeakMap<Component, RawComponentOwner>();
  readonly #rawEditors: RawEditorOwner[] = [];
  #draftScope = "default";
  #theme: Theme;
  #themeName: ThemeName;
  #themeSetting: string;
  #terminalColorScheme: TerminalColorScheme;
  #automaticTheme: boolean;
  readonly #themeChangeListeners = new Set<(change: TuiThemeChange) => void>();
  readonly #terminalColorSchemeListeners = new Set<(scheme: TerminalColorScheme) => void>();
  readonly #terminalBackgroundListeners = new Set<(color: Readonly<{ r: number; g: number; b: number }>) => void>();
  readonly #terminalColorSchemeNotificationOwners = new Set<object>();
  readonly #terminalColorSchemeNotificationCleanup = new Map<object, {
    signal: AbortSignal;
    remove(): void;
  }>();
  readonly #extensionWorkingMessages = new Map<string, string>();
  readonly #extensionWorkingVisibility = new Map<string, boolean>();
  #started = false;
  #closed = false;
  #closing = false;
  #previousRaw = false;
  #pendingQuestion: PendingQuestion | undefined;
  #overlay: Overlay | undefined;
  #steering: ((
    line: string,
    images?: readonly TuiInputImageAttachment[],
    recoveredImages?: readonly ImageBlock[],
    recoveredQueueDraft?: boolean,
  ) => void) | undefined;
  #interruptHandler: (() => boolean | void) | undefined;
  #inputImages: TuiInputImageAttachment[] = [];
  #submittedImages: TuiInputImageAttachment[] = [];
  #recoveredInputImages: ImageBlock[] = [];
  #submittedRecoveredImages: ImageBlock[] = [];
  #recoveredQueueDraft = false;
  #submittedRecoveredQueueDraft = false;
  #inputMode: "normal" | "follow_up" = "normal";
  #queuedMessages: QueuedMessage[] = [];
  #inputLabel = "you";
  #inputBlocked: string | undefined;
  #inputBlockedLabel = "busy";
  #modelPickerLoading = false;
  #modelPickerEmptyMessage: string | undefined;
  #jumpDirection: -1 | 1 | undefined;
  #transcriptOffset = 0;
  #renderScheduled = false;
  #escapeTimer: NodeJS.Timeout | undefined;
  #keyboardProtocol: "none" | "pending" | "kitty" | "modify-other-keys" = "none";
  #keyboardNegotiationTimer: NodeJS.Timeout | undefined;
  #externalEditing = false;
  #secretAbort: AbortController | undefined;
  #transientStatusColumns = 0;
  #activityTimer: NodeJS.Timeout | undefined;
  #activityTimerInterval = ACTIVITY_FRAME_MS;
  #doubleEscapeAction: "tree" | "fork" | "none";
  #hideThinkingBlock = false;
  #externalEditorCommand: string | undefined;
  #treeFilterMode: SessionTreeFilterMode = "default";
  #editorPaddingX = 0;
  #outputPad: 0 | 1 = 0;
  #autocompleteMaxVisible: number | undefined;
  #showHardwareCursor = true;
  #clearOnShrink = false;
  #showImages = true;
  #imageWidthCells = 80;
  #codeBlockIndent = "";
  #lastEscapeAt = 0;
  #lastClearAt = 0;
  #suspended = false;
  #suspendKeepAlive: NodeJS.Timeout | undefined;

  readonly #onData = (chunk: Buffer | string) => {
    try {
      const selected = this.#applyUnsafeTerminalInputHandlers(chunk);
      if (selected === undefined) return;
      const direct = this.#applyRawComponentInput(selected);
      if (direct === undefined) return;
      const events = this.#decoder.push(typeof direct === "string" ? direct : new Uint8Array(direct));
      this.#handleTerminalReplies(this.#decoder.takeReplies());
      this.#handleKeys(events);
      this.#scheduleEscape();
    } catch (cause) {
      this.#fail(error(cause));
    }
  };

  readonly #onResize = () => this.#scheduleRender();
  readonly #onStreamError = (cause: unknown) => this.#fail(error(cause));
  readonly #onInputEnd = () => {
    this.close();
    this.#emit({ type: "exit" });
  };
  readonly #onSignal = (signal: NodeJS.Signals) => {
    this.close();
    this.#emit({ type: "signal", signal });
  };
  readonly #onContinue = () => this.#resumeFromSuspend();

  constructor(options: TuiControllerOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.#environment = options.environment ?? process.env;
    this.#limits = limits(options.limits);
    this.#keybindings = options.keybindings ?? new Keybindings();
    setPublicKeybindings(this.#keybindings.manager());
    this.capabilities = detectTerminalCapabilities(this.input, this.output, {
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    this.mode = this.capabilities.mode;
    this.#semanticZones = this.mode === "full" && this.#environment.RIGYN_OSC133 !== "0";
    this.#surface = new LiveSurfaceRenderer({
      alternateScreen: this.capabilities.alternateScreen,
      synchronizedOutput: this.#environment.RIGYN_SYNC_UPDATE !== "0",
      imageProtocol: this.capabilities.imageProtocol,
    });
    this.#themeSetting = normalizeThemeSetting(options.theme ?? "mono");
    this.#terminalColorScheme = terminalColorSchemeFromEnvironment(this.#environment);
    this.#automaticTheme = parseAutomaticThemePair(this.#themeSetting) !== undefined;
    const configuredTheme = resolveThemeSetting(this.#themeSetting, this.#terminalColorScheme);
    this.#themeName = configuredTheme === "mono" ? configuredTheme : "mono";
    this.#theme = createTheme(this.#themeName, {
      color: this.capabilities.color,
      unicode: this.capabilities.unicode,
    });
    this.#model = new TuiModel(this.#limits);
    this.#baseEditor = new MultilineEditor({
      maxBytes: this.#limits.maxEditorBytes,
      maxHistoryEntries: this.#limits.maxHistoryEntries,
      maxUndoEntries: this.#limits.maxUndoEntries,
    });
    this.#editor = this.#baseEditor;
    this.#signalSource = options.signalSource ?? process;
    this.#handleSignals = options.handleSignals ?? true;
    this.#onAction = options.onAction;
    this.#doubleEscapeAction = options.doubleEscapeAction ?? "tree";
    this.#pickerSources.set("command", defaultCommands);
    if (options.operatorPreferences !== undefined) this.setOperatorPreferences(options.operatorPreferences);
  }

  setOperatorPreferences(preferences: Partial<TuiOperatorPreferences>): void {
    if (preferences === null || typeof preferences !== "object" || Array.isArray(preferences)) {
      throw new TypeError("TUI operator preferences must be an object");
    }
    if (preferences.hideThinkingBlock !== undefined) {
      if (typeof preferences.hideThinkingBlock !== "boolean") throw new TypeError("hideThinkingBlock must be boolean");
      this.#hideThinkingBlock = preferences.hideThinkingBlock;
    }
    if (preferences.showCacheMissNotices !== undefined) {
      this.#model.setShowCacheMissNotices(preferences.showCacheMissNotices);
    }
    if ("externalEditor" in preferences) {
      if (preferences.externalEditor !== undefined) {
        if (typeof preferences.externalEditor !== "string") throw new TypeError("externalEditor must be a string");
        parseEditorCommand(preferences.externalEditor);
      }
      this.#externalEditorCommand = preferences.externalEditor;
    }
    if (preferences.treeFilterMode !== undefined) {
      if (!SESSION_TREE_FILTER_MODES.includes(preferences.treeFilterMode)) throw new Error("treeFilterMode is invalid");
      this.#treeFilterMode = preferences.treeFilterMode;
    }
    if (preferences.editorPaddingX !== undefined) {
      if (!Number.isSafeInteger(preferences.editorPaddingX) || preferences.editorPaddingX < 0 || preferences.editorPaddingX > 3) {
        throw new RangeError("editorPaddingX must be an integer from 0 through 3");
      }
      this.#editorPaddingX = preferences.editorPaddingX;
    }
    if (preferences.outputPad !== undefined) {
      if (preferences.outputPad !== 0 && preferences.outputPad !== 1) throw new RangeError("outputPad must be 0 or 1");
      this.#outputPad = preferences.outputPad;
    }
    if ("autocompleteMaxVisible" in preferences) {
      const value = preferences.autocompleteMaxVisible;
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 3 || value > 20)) {
        throw new RangeError("autocompleteMaxVisible must be an integer from 3 through 20");
      }
      this.#autocompleteMaxVisible = value;
    }
    if (preferences.showHardwareCursor !== undefined) {
      if (typeof preferences.showHardwareCursor !== "boolean") throw new TypeError("showHardwareCursor must be boolean");
      this.#showHardwareCursor = preferences.showHardwareCursor;
    }
    if (preferences.showImages !== undefined) {
      if (typeof preferences.showImages !== "boolean") throw new TypeError("showImages must be boolean");
      this.#showImages = preferences.showImages;
    }
    if (preferences.imageWidthCells !== undefined) {
      if (!Number.isSafeInteger(preferences.imageWidthCells) || preferences.imageWidthCells < 1 || preferences.imageWidthCells > 500) {
        throw new RangeError("imageWidthCells must be an integer from 1 through 500");
      }
      this.#imageWidthCells = preferences.imageWidthCells;
    }
    if (preferences.clearOnShrink !== undefined) {
      if (typeof preferences.clearOnShrink !== "boolean") throw new TypeError("clearOnShrink must be boolean");
      this.#clearOnShrink = preferences.clearOnShrink;
      this.#surface.setClearOnShrink(preferences.clearOnShrink);
    }
    if (preferences.codeBlockIndent !== undefined) {
      if (!/^ {0,8}$/u.test(preferences.codeBlockIndent)) throw new Error("codeBlockIndent must contain zero through eight spaces");
      this.#codeBlockIndent = preferences.codeBlockIndent;
    }
    if (this.#started && this.mode === "full") {
      this.#write(this.#showHardwareCursor ? SHOW_CURSOR : HIDE_CURSOR);
      this.#scheduleRender();
    }
  }

  setKeybindings(keybindings: Keybindings): void {
    this.#keybindings = keybindings;
    setPublicKeybindings(keybindings.manager());
  }

  /** Active complete keymap shared with direct TUI and editor factories. */
  keybindingsManager(): KeybindingsManager {
    return this.#keybindings.manager();
  }

  actionsForKey(value: string): KeybindingAction[] {
    return this.#keybindings.actionsForKey(value);
  }

  /** Replace the application action sink without recreating the terminal. */
  setActionHandler(handler: ((action: TuiAction) => void) | undefined): void {
    if (this.#closed) throw new Error("TUI is closed");
    this.#onAction = handler;
  }

  setDoubleEscapeAction(action: "tree" | "fork" | "none"): void {
    this.#doubleEscapeAction = action;
    this.#lastEscapeAt = 0;
  }

  setExtensionShortcuts(shortcuts?: readonly TuiExtensionShortcut[], signal?: AbortSignal): void {
    const previous = this.#extensionShortcuts;
    if (previous !== undefined) previous.signal.removeEventListener("abort", previous.onAbort);
    this.#extensionShortcuts = undefined;
    if (shortcuts === undefined) return;
    if (signal === undefined) throw new Error("Extension shortcuts require a generation signal");
    signal.throwIfAborted();
    const selected = new Map<string, TuiExtensionShortcut>();
    for (const shortcut of shortcuts) selected.set(normalizeKeybinding(shortcut.shortcut), { ...shortcut });
    const owner: ExtensionShortcutOwner = {
      shortcuts: selected,
      signal,
      onAbort: () => {
        if (this.#extensionShortcuts === owner) this.#extensionShortcuts = undefined;
      },
    };
    this.#extensionShortcuts = owner;
    signal.addEventListener("abort", owner.onAbort, { once: true });
    if (signal.aborted) owner.onAbort();
  }

  setCommandCompletionProvider(provider?: TuiCommandCompletionProvider, signal?: AbortSignal): void {
    const previous = this.#commandCompletion;
    if (previous !== undefined) previous.signal.removeEventListener("abort", previous.onAbort);
    this.#cancelCommandCompletion(new Error("Command completion provider replaced"));
    this.#commandCompletion = undefined;
    if (provider === undefined) return;
    if (signal === undefined) throw new Error("Command completion providers require a generation signal");
    signal.throwIfAborted();
    const owner: CommandCompletionOwner = {
      provider,
      signal,
      onAbort: () => {
        if (this.#commandCompletion !== owner) return;
        this.#commandCompletion = undefined;
        this.#cancelCommandCompletion(signal.reason instanceof Error ? signal.reason : new Error("Command completion provider expired"));
      },
    };
    this.#commandCompletion = owner;
    signal.addEventListener("abort", owner.onAbort, { once: true });
    if (signal.aborted) owner.onAbort();
  }

  setAutocompleteProvider(provider?: TuiAutocompleteProvider, signal?: AbortSignal): void {
    const previous = this.#autocomplete;
    if (previous !== undefined) previous.signal.removeEventListener("abort", previous.onAbort);
    this.#autocomplete = undefined;
    if (provider !== undefined) {
      if (signal === undefined) throw new Error("Autocomplete providers require a generation signal");
      signal.throwIfAborted();
      const owner: AutocompleteOwner = {
        provider,
        signal,
        onAbort: () => {
          if (this.#autocomplete !== owner) return;
          this.#autocomplete = undefined;
          this.#rebaseNativeAutocomplete();
          this.#autocompleteChanged(signal.reason instanceof Error ? signal.reason : new Error("Autocomplete provider expired"));
        },
      };
      this.#autocomplete = owner;
      signal.addEventListener("abort", owner.onAbort, { once: true });
      if (signal.aborted) owner.onAbort();
    }
    this.#rebaseNativeAutocomplete();
    this.#autocompleteChanged(new Error("Autocomplete provider replaced"));
  }

  setEditorMiddleware(middleware?: TuiEditorMiddleware, signal?: AbortSignal): void {
    const previous = this.#editorMiddleware;
    if (previous !== undefined) previous.signal.removeEventListener("abort", previous.onAbort);
    this.#editorMiddleware = undefined;
    if (middleware === undefined) return;
    if (signal === undefined) throw new Error("Editor middleware requires a generation signal");
    signal.throwIfAborted();
    const owner: EditorMiddlewareOwner = {
      middleware,
      signal,
      onAbort: () => {
        if (this.#editorMiddleware === owner) this.#editorMiddleware = undefined;
      },
    };
    this.#editorMiddleware = owner;
    signal.addEventListener("abort", owner.onAbort, { once: true });
    if (signal.aborted) owner.onAbort();
  }

  /** @internal Rejects use of a retained NativeUiHost after terminal teardown. */
  assertNativeUiAvailable(): void {
    if (this.#closed || this.#closing) throw new Error("Native UI is unavailable after terminal teardown");
  }

  /** @internal Privileged decoded-input registration used by NativeUiHost. */
  registerNativeInputHandler(handler: NativeUiInputHandler, signal: AbortSignal): () => void {
    if (typeof handler !== "function") throw new TypeError("Native input handler must be a function");
    signal.throwIfAborted();
    let disposed = false;
    const owner: NativeInputOwner = {
      handler,
      signal,
      onAbort: () => dispose(),
    };
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      signal.removeEventListener("abort", owner.onAbort);
      const index = this.#nativeInputHandlers.indexOf(owner);
      if (index >= 0) this.#nativeInputHandlers.splice(index, 1);
    };
    this.#nativeInputHandlers.push(owner);
    signal.addEventListener("abort", owner.onAbort, { once: true });
    if (signal.aborted) owner.onAbort();
    return dispose;
  }

  /** @internal Raw input registration reserved for the unsafe terminal host. */
  registerUnsafeTerminalInputHandler(handler: UnsafeTerminalInputHandler, signal: AbortSignal): () => void {
    if (typeof handler !== "function") throw new TypeError("Unsafe terminal input handler must be a function");
    signal.throwIfAborted();
    let disposed = false;
    const owner: UnsafeTerminalInputOwner = {
      handler,
      signal,
      onAbort: () => dispose(),
    };
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      signal.removeEventListener("abort", owner.onAbort);
      const index = this.#unsafeTerminalInputHandlers.indexOf(owner);
      if (index >= 0) this.#unsafeTerminalInputHandlers.splice(index, 1);
    };
    this.#unsafeTerminalInputHandlers.push(owner);
    signal.addEventListener("abort", owner.onAbort, { once: true });
    if (signal.aborted) owner.onAbort();
    return dispose;
  }

  /** @internal Direct output reserved for the explicitly unsafe terminal host. */
  writeUnsafeTerminal(data: string): void {
    this.assertNativeUiAvailable();
    if (typeof data !== "string" || Buffer.byteLength(data, "utf8") > 1024 * 1024) {
      throw new TypeError("Unsafe terminal output must be a string no larger than 1 MiB");
    }
    this.#ensureStarted();
    if (data === "") return;
    this.#write(data);
    this.#surface.resetAnchor();
  }

  /** @internal Schedules host repair after an unsafe out-of-band write. */
  requestUnsafeTerminalRender(): void {
    this.assertNativeUiAvailable();
    this.#surface.resetAnchor();
    this.#scheduleRender();
  }

  unsafeTerminalSize(): Readonly<{ columns: number; rows: number }> {
    this.assertNativeUiAvailable();
    return Object.freeze({ ...terminalSize(this.output, this.capabilities) });
  }

  unsafeTerminalCapabilities(): Readonly<TerminalCapabilities> {
    this.assertNativeUiAvailable();
    return Object.freeze({ ...this.capabilities });
  }

  unsafeTerminalKittyProtocolActive(): boolean {
    this.assertNativeUiAvailable();
    return this.#keyboardProtocol === "kitty";
  }

  unsafeTerminalColorScheme(): TerminalColorScheme {
    this.assertNativeUiAvailable();
    return this.#terminalColorScheme;
  }

  onUnsafeTerminalColorSchemeChange(
    listener: (scheme: TerminalColorScheme) => void,
    signal: AbortSignal,
  ): () => void {
    this.assertNativeUiAvailable();
    if (typeof listener !== "function") throw new TypeError("Terminal color-scheme listener must be a function");
    signal.throwIfAborted();
    const selectedSignal = AbortSignal.any([signal, this.#lifecycleAbort.signal]);
    this.#terminalColorSchemeListeners.add(listener);
    const remove = () => this.#terminalColorSchemeListeners.delete(listener);
    selectedSignal.addEventListener("abort", remove, { once: true });
    return () => {
      selectedSignal.removeEventListener("abort", remove);
      remove();
    };
  }

  setUnsafeTerminalColorSchemeNotifications(owner: object, enabled: boolean, signal: AbortSignal): void {
    this.assertNativeUiAvailable();
    signal.throwIfAborted();
    const selectedSignal = AbortSignal.any([signal, this.#lifecycleAbort.signal]);
    if (enabled) {
      if (this.#terminalColorSchemeNotificationOwners.has(owner)) return;
      this.#terminalColorSchemeNotificationOwners.add(owner);
      const remove = () => {
        selectedSignal.removeEventListener("abort", remove);
        this.#terminalColorSchemeNotificationCleanup.delete(owner);
        if (!this.#terminalColorSchemeNotificationOwners.delete(owner)) return;
        this.#syncTerminalColorSchemeProtocol(false);
      };
      this.#terminalColorSchemeNotificationCleanup.set(owner, { signal: selectedSignal, remove });
      selectedSignal.addEventListener("abort", remove, { once: true });
    } else {
      const registration = this.#terminalColorSchemeNotificationCleanup.get(owner);
      if (registration !== undefined) {
        registration.signal.removeEventListener("abort", registration.remove);
        this.#terminalColorSchemeNotificationCleanup.delete(owner);
      }
      this.#terminalColorSchemeNotificationOwners.delete(owner);
    }
    this.#syncTerminalColorSchemeProtocol(enabled);
  }

  async queryUnsafeTerminalBackgroundColor(
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Readonly<{ r: number; g: number; b: number }> | undefined> {
    this.assertNativeUiAvailable();
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) {
      throw new RangeError("Terminal background query timeout must be 1 to 5000 ms");
    }
    signal.throwIfAborted();
    const selectedSignal = AbortSignal.any([signal, this.#lifecycleAbort.signal]);
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (value: Readonly<{ r: number; g: number; b: number }> | undefined): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        selectedSignal.removeEventListener("abort", aborted);
        this.#terminalBackgroundListeners.delete(receive);
        resolve(value);
      };
      const receive = (value: Readonly<{ r: number; g: number; b: number }>) => finish(value);
      const aborted = () => finish(undefined);
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      timer.unref();
      this.#terminalBackgroundListeners.add(receive);
      selectedSignal.addEventListener("abort", aborted, { once: true });
      this.writeUnsafeTerminal(QUERY_TERMINAL_BACKGROUND);
    });
  }

  async queryUnsafeTerminalColorScheme(
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<TerminalColorScheme | undefined> {
    this.assertNativeUiAvailable();
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) {
      throw new RangeError("Terminal color-scheme query timeout must be 1 to 5000 ms");
    }
    signal.throwIfAborted();
    const selectedSignal = AbortSignal.any([signal, this.#lifecycleAbort.signal]);
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (value: TerminalColorScheme | undefined): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        selectedSignal.removeEventListener("abort", aborted);
        this.#terminalColorSchemeListeners.delete(receive);
        resolve(value);
      };
      const receive = (value: TerminalColorScheme) => finish(value);
      const aborted = () => finish(undefined);
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      timer.unref();
      this.#terminalColorSchemeListeners.add(receive);
      selectedSignal.addEventListener("abort", aborted, { once: true });
      this.writeUnsafeTerminal(QUERY_TERMINAL_COLOR_SCHEME);
    });
  }

  unsafeTerminalKeybindings(): Keybindings {
    this.assertNativeUiAvailable();
    return this.#keybindings;
  }

  /** @internal Returns the active editor to a trusted NativeUiHost. */
  getEditorImplementation(): TuiEditorImplementation {
    return this.#editor;
  }

  /** @internal Pushes a generation-owned editor replacement. */
  replaceNativeEditor(editor: TuiEditorImplementation, signal: AbortSignal): () => void {
    return this.#pushNativeEditor(validatedEditorImplementation(editor), signal);
  }

  /** @internal Wraps the active editor through a retargetable predecessor. */
  wrapNativeEditor(wrapper: NativeUiEditorWrapper, signal: AbortSignal): () => void {
    if (typeof wrapper !== "function") throw new TypeError("Native editor wrapper must be a function");
    signal.throwIfAborted();
    const owner: NativeEditorOwner = {
      editor: this.#editor,
      previous: this.#editor,
      signal,
      onAbort: () => undefined,
    };
    const previous = new Proxy({} as TuiEditorImplementation, {
      get: (_target, property) => {
        const selected = owner.previous;
        const value = Reflect.get(selected, property, selected) as unknown;
        return typeof value === "function" ? value.bind(selected) : value;
      },
    });
    owner.editor = validatedEditorImplementation(wrapper(previous));
    return this.#installNativeEditor(owner);
  }

  /** @internal Installs a generation-owned autocomplete layer. */
  wrapNativeAutocompleteProvider(wrapper: NativeUiAutocompleteWrapper, signal: AbortSignal): () => void {
    if (typeof wrapper !== "function") throw new TypeError("Native autocomplete wrapper must be a function");
    signal.throwIfAborted();
    const owner: NativeAutocompleteOwner = {
      previous: this.#nativeAutocomplete.at(-1)?.provider ?? this.#autocomplete?.provider ?? EMPTY_AUTOCOMPLETE_PROVIDER,
      provider: EMPTY_AUTOCOMPLETE_PROVIDER,
      signal,
      onAbort: () => undefined,
    };
    const previous: TuiAutocompleteProvider = (text, cursor, requestSignal) =>
      owner.previous(text, cursor, requestSignal);
    const provider = wrapper(previous);
    if (typeof provider !== "function") throw new TypeError("Native autocomplete wrapper must return a provider");
    let disposed = false;
    owner.provider = provider;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      signal.removeEventListener("abort", owner.onAbort);
      const index = this.#nativeAutocomplete.indexOf(owner);
      if (index < 0) return;
      const successor = this.#nativeAutocomplete[index + 1];
      if (successor !== undefined) successor.previous = owner.previous;
      this.#nativeAutocomplete.splice(index, 1);
      this.#autocompleteChanged(signal.reason instanceof Error ? signal.reason : new Error("Native autocomplete wrapper removed"));
    };
    this.#nativeAutocomplete.push(owner);
    this.#autocompleteChanged(new Error("Native autocomplete wrapper installed"));
    owner.onAbort = dispose;
    signal.addEventListener("abort", owner.onAbort, { once: true });
    if (signal.aborted) owner.onAbort();
    return dispose;
  }

  #pushNativeEditor(editor: TuiEditorImplementation, signal: AbortSignal): () => void {
    signal.throwIfAborted();
    const owner: NativeEditorOwner = {
      editor,
      previous: this.#editor,
      signal,
      onAbort: () => undefined,
    };
    return this.#installNativeEditor(owner);
  }

  #installNativeEditor(owner: NativeEditorOwner): () => void {
    owner.signal.throwIfAborted();
    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      owner.signal.removeEventListener("abort", owner.onAbort);
      const index = this.#nativeEditors.indexOf(owner);
      if (index < 0) return;
      const successor = this.#nativeEditors[index + 1];
      if (successor !== undefined) successor.previous = owner.previous;
      else this.#editor = owner.previous;
      this.#nativeEditors.splice(index, 1);
      this.#cancelAutocomplete(new Error("Native editor changed"));
      this.#scheduleRender();
    };
    owner.onAbort = dispose;
    this.#nativeEditors.push(owner);
    this.#editor = owner.editor;
    this.#cancelAutocomplete(new Error("Native editor changed"));
    this.#scheduleRender();
    owner.signal.addEventListener("abort", owner.onAbort, { once: true });
    if (owner.signal.aborted) owner.onAbort();
    return dispose;
  }

  #rebaseNativeAutocomplete(): void {
    const first = this.#nativeAutocomplete[0];
    if (first !== undefined) first.previous = this.#autocomplete?.provider ?? EMPTY_AUTOCOMPLETE_PROVIDER;
  }

  #autocompleteChanged(reason: Error): void {
    this.#autocompleteVersion += 1;
    this.#cancelAutocomplete(reason);
  }

  #activeAutocompleteOwner(): ActiveAutocompleteOwner | undefined {
    const native = this.#nativeAutocomplete.at(-1);
    const provider = native?.provider ?? this.#autocomplete?.provider;
    if (provider === undefined) return undefined;
    const signals = [
      ...(this.#autocomplete === undefined ? [] : [this.#autocomplete.signal]),
      ...this.#nativeAutocomplete.map((owner) => owner.signal),
    ];
    return {
      provider,
      signal: signals.length === 1 ? signals[0]! : AbortSignal.any(signals),
      version: this.#autocompleteVersion,
    };
  }

  setPersistentComponent(
    slot: TuiPersistentComponentSlot,
    key: string,
    factory?: RuntimeUiComponentFactory<void>,
    signal?: AbortSignal,
  ): void {
    if (!PERSISTENT_COMPONENT_SLOTS.includes(slot)) {
      throw new Error("Persistent UI component slot is invalid");
    }
    const selectedKey = persistentComponentKey(key);
    const components = this.#persistentRuntimeComponents[slot];
    const previous = components.get(selectedKey);
    if (factory === undefined) {
      previous?.mount.close();
      return;
    }
    if (this.mode !== "full") throw new Error("Persistent UI components require the full TUI");
    if (signal === undefined) throw new Error("Persistent UI components require a generation signal");
    signal.throwIfAborted();
    if (previous === undefined && components.size >= MAX_ADVANCED_UI_SLOT_COMPONENTS) {
      throw new Error(`Persistent UI ${slot} slot is limited to ${MAX_ADVANCED_UI_SLOT_COMPONENTS} components`);
    }
    let owner: PersistentRuntimeComponentOwner | undefined;
    const mount = RuntimeUiComponentMount.create(factory, {
      signal,
      requestRender: () => this.#scheduleRender(),
      onClose: () => {
        if (owner !== undefined && components.get(selectedKey) === owner) components.delete(selectedKey);
        this.#scheduleRender();
      },
      onError: (cause) => {
        try {
          this.notify(`Persistent UI component failed: ${defaultSecretRedactor.redact(cause.message).slice(0, 4_096)}`, "warning");
        } catch {}
      },
    });
    owner = { mount };
    if (mount.closed) return;
    components.set(selectedKey, owner);
    previous?.mount.close();
    this.#scheduleRender();
  }

  /** @internal Pauses a trusted persistent component without disposing its state. */
  setRawPersistentComponentVisible(slot: TuiPersistentComponentSlot, key: string, visible: boolean): void {
    if (!PERSISTENT_COMPONENT_SLOTS.includes(slot)) throw new Error("Persistent raw UI component slot is invalid");
    if (typeof visible !== "boolean") throw new TypeError("Persistent raw UI visibility must be boolean");
    const owner = this.#persistentRawComponents[slot].get(persistentComponentKey(key));
    if (owner === undefined || owner.hidden === !visible) return;
    owner.hidden = !visible;
    this.#scheduleRender();
  }

  /** @internal Mounts a trusted raw component inside the existing terminal frame. */
  setRawPersistentComponent(
    slot: TuiPersistentComponentSlot,
    key: string,
    component?: (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
    signal?: AbortSignal,
  ): void {
    if (!PERSISTENT_COMPONENT_SLOTS.includes(slot)) throw new Error("Persistent raw UI component slot is invalid");
    const selectedKey = persistentComponentKey(key);
    const components = this.#persistentRawComponents[slot];
    const previous = components.get(selectedKey);
    if (component === undefined) {
      previous?.mount.close();
      components.delete(selectedKey);
      this.#scheduleRender();
      return;
    }
    if (this.mode !== "full") throw new Error("Persistent raw UI components require the full TUI");
    if (signal === undefined) throw new Error("Persistent raw UI components require a generation signal");
    signal.throwIfAborted();
    if (previous === undefined && components.size >= MAX_ADVANCED_UI_SLOT_COMPONENTS) {
      throw new Error(`Persistent raw UI ${slot} slot is limited to ${MAX_ADVANCED_UI_SLOT_COMPONENTS} components`);
    }
    let owner: PersistentRawComponentOwner | undefined;
    const mount = new RawComponentMount(component, {
      signal,
      requestRender: () => this.#scheduleRender(),
      onClose: () => {
        if (owner !== undefined && components.get(selectedKey) === owner) components.delete(selectedKey);
        this.#scheduleRender();
      },
      onError: (cause) => {
        try { this.notify(`Raw UI component failed: ${defaultSecretRedactor.redact(cause.message).slice(0, 4_096)}`, "warning"); } catch {}
      },
    });
    owner = { mount, hidden: false };
    if (mount.closed) return;
    components.set(selectedKey, owner);
    previous?.mount.close();
    this.#scheduleRender();
  }

  /** @internal Shows one trusted raw component, optionally as an overlay. */
  customRaw<T>(
    factory: (done: (value: T) => void) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
    options?: RuntimeUiCustomOptions,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    this.#ensureStarted();
    if (this.mode !== "full") return Promise.reject(new Error("Raw components require the full TUI"));
    if (this.#overlay !== undefined || this.#runtimeComponent !== undefined || this.#rawRuntimeComponent !== undefined || this.#pendingQuestion !== undefined) {
      return Promise.reject(new Error("Another terminal interaction is active"));
    }
    let selectedOptions: NormalizedRuntimeCustomOptions;
    try { selectedOptions = normalizeRuntimeCustomOptions(options); }
    catch (cause) { return Promise.reject(error(cause)); }
    const ownerSignal = signal ?? new AbortController().signal;
    return new Promise<T | undefined>((resolve, reject) => {
      let owner: RawComponentOwner | undefined;
      let earlyValue: T | undefined;
      let earlyClose = false;
      const done = (value: T): void => {
        if (owner === undefined) { earlyValue = value; earlyClose = true; }
        else owner.mount.close(value);
      };
      try {
        const component = factory(done);
        const mount = new RawComponentMount<T>(component, {
          signal: ownerSignal,
          requestRender: () => this.#scheduleRender(),
          onClose: (value) => {
            if (owner !== undefined) this.#removeRawOwner(owner);
            this.#scheduleRender();
            resolve(value);
          },
          onError: (cause) => {
            try { this.notify(`Raw component failed: ${defaultSecretRedactor.redact(cause.message).slice(0, 4_096)}`, "warning"); } catch {}
          },
        });
        owner = {
          mount: mount as RawComponentMount<unknown>,
          options: selectedOptions,
          hidden: false,
          focused: false,
          focusOrder: ++this.#rawRuntimeFocusOrder,
          preFocus: this.#focusedRawOwner(),
          restoreWhenVisible: false,
        };
        if (mount.component !== undefined) this.#rawComponentOwners.set(mount.component, owner);
        if (!mount.closed) {
          if (selectedOptions.overlay === true) this.#rawRuntimeOverlays.push(owner);
          else this.#rawRuntimeComponent = owner;
          if (this.#rawOwnerCaptures(owner)) this.#setRawFocus(owner, false);
          const handle = this.#createRawHandle(owner);
          owner.handle = handle;
          try { selectedOptions.onHandle?.(handle); }
          catch (cause) {
            this.notify(`Raw component handle failed: ${error(cause).message}`, "warning");
            mount.close();
          }
          if (earlyClose) mount.close(earlyValue);
          this.#scheduleRender();
        }
      } catch (cause) { reject(error(cause)); }
    });
  }

  /** @internal Mounts a raw overlay and returns its controller-owned handle. */
  showRawOverlay<T>(
    component: (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
    options?: OverlayOptions,
    signal?: AbortSignal,
  ): { handle: OverlayHandle; result: Promise<T | undefined>; close(value?: T): void } {
    this.#ensureStarted();
    if (this.mode !== "full") throw new Error("Raw overlays require the full TUI");
    const selectedOptions = normalizeRuntimeCustomOptions({ overlay: true, ...(options === undefined ? {} : { overlayOptions: options }) });
    const ownerSignal = signal ?? new AbortController().signal;
    let owner: RawComponentOwner | undefined;
    let resolveResult!: (value: T | undefined) => void;
    const result = new Promise<T | undefined>((resolve) => { resolveResult = resolve; });
    const mount = new RawComponentMount<T>(component, {
      signal: ownerSignal,
      requestRender: () => this.#scheduleRender(),
      onClose: (value) => {
        if (owner !== undefined) this.#removeRawOwner(owner);
        this.#scheduleRender();
        resolveResult(value);
      },
      onError: (cause) => {
        try { this.notify(`Raw overlay failed: ${defaultSecretRedactor.redact(cause.message).slice(0, 4_096)}`, "warning"); } catch {}
      },
    });
    owner = {
      mount: mount as RawComponentMount<unknown>,
      options: selectedOptions,
      hidden: false,
      focused: false,
      focusOrder: ++this.#rawRuntimeFocusOrder,
      preFocus: this.#focusedRawOwner(),
      restoreWhenVisible: false,
    };
    if (mount.component !== undefined) this.#rawComponentOwners.set(mount.component, owner);
    this.#rawRuntimeOverlays.push(owner);
    if (this.#rawOwnerCaptures(owner)) this.#setRawFocus(owner, false);
    const runtimeHandle = this.#createRawHandle(owner);
    owner.handle = runtimeHandle;
    const handle: OverlayHandle = {
      hide: runtimeHandle.close,
      setHidden: runtimeHandle.setHidden,
      isHidden: runtimeHandle.isHidden,
      focus: runtimeHandle.focus,
      unfocus: () => runtimeHandle.unfocus(),
      isFocused: runtimeHandle.isFocused,
    };
    this.#scheduleRender();
    return { handle, result, close: (value) => mount.close(value) };
  }

  /** @internal Gives a raw component focus without handing over terminal ownership. */
  focusRawComponent(component: Component | null): void {
    if (component === null) this.#setRawFocus(null, false);
    else {
      const owner = this.#rawComponentOwners.get(component);
      if (owner !== undefined) this.#setRawFocus(owner, true);
    }
    this.#scheduleRender();
  }

  /** @internal Installs a raw editor component and restores its predecessor on generation end. */
  installRawEditor(component: EditorComponent, signal: AbortSignal): () => void {
    if (component === null || typeof component !== "object" || typeof component.render !== "function"
      || typeof component.handleInput !== "function" || typeof component.getText !== "function"
      || typeof component.setText !== "function" || typeof component.invalidate !== "function") {
      throw new TypeError("Raw editor factory must return an EditorComponent");
    }
    signal.throwIfAborted();
    const previousText = this.getEditorText();
    component.setText(previousText);
    const owner: RawEditorOwner = { component, signal, onAbort: () => undefined };
    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      signal.removeEventListener("abort", owner.onAbort);
      const index = this.#rawEditors.indexOf(owner);
      if (index < 0) return;
      const text = component.getText();
      this.#rawEditors.splice(index, 1);
      const successor = this.#rawEditors.at(-1)?.component;
      if (successor === undefined) this.#editor.setText(text);
      else successor.setText(text);
      try { (component as EditorComponent & { dispose?(): void }).dispose?.(); } catch {}
      this.#scheduleRender();
    };
    owner.onAbort = dispose;
    component.onChange = (text) => {
      if (this.#rawEditors.at(-1) !== owner) return;
      this.#editor.setText(text);
      this.#scheduleRender();
    };
    component.onSubmit = (text) => {
      if (this.#rawEditors.at(-1) !== owner) return;
      this.#editor.setText(text);
      this.#submit();
      component.setText(this.#editor.text);
    };
    this.#rawEditors.push(owner);
    signal.addEventListener("abort", owner.onAbort, { once: true });
    if (signal.aborted) owner.onAbort();
    this.#scheduleRender();
    return dispose;
  }

  /** @internal Current raw editor for a trusted direct extension. */
  currentRawEditor(): EditorComponent | undefined { return this.#rawEditors.at(-1)?.component; }

  /** @internal Lets a trusted raw component invalidate the host frame. */
  requestRawRender(force = false): void {
    if (force) {
      const output = this.#surface.clear(terminalSize(this.output, this.capabilities));
      if (output !== "") this.#write(`${HIDE_CURSOR}${output}`);
    }
    this.#scheduleRender();
  }

  rawFullRedraws(): number { return this.#surface.fullRedraws; }
  rawShowHardwareCursor(): boolean { return this.#showHardwareCursor; }
  setRawShowHardwareCursor(value: boolean): void { this.setOperatorPreferences({ showHardwareCursor: value }); }
  rawClearOnShrink(): boolean { return this.#clearOnShrink; }
  setRawClearOnShrink(value: boolean): void { this.setOperatorPreferences({ clearOnShrink: value }); }

  setWorkingIndicator(value?: TuiWorkingIndicatorOptions, signal?: AbortSignal): void {
    this.setKeyedWorkingIndicator(CONTROLLER_ADVANCED_UI_KEY, value, signal);
  }

  setKeyedWorkingIndicator(
    key: string,
    value?: TuiWorkingIndicatorOptions,
    signal?: AbortSignal,
  ): void {
    const selectedKey = persistentComponentKey(key);
    const selected = value === undefined ? undefined : workingIndicatorOptions(value);
    if (selected !== undefined) {
      if (signal === undefined) throw new Error("Working indicators require a generation signal");
      signal.throwIfAborted();
    }
    const previous = this.#workingIndicators.get(selectedKey);
    if (previous !== undefined) previous.signal.removeEventListener("abort", previous.onAbort);
    this.#workingIndicators.delete(selectedKey);
    if (selected !== undefined && signal !== undefined) {
      const owner: WorkingIndicatorOwner = {
        value: selected,
        signal,
        onAbort: () => {
          if (this.#workingIndicators.get(selectedKey) !== owner) return;
          this.#workingIndicators.delete(selectedKey);
          this.#restartActivityTimer();
          this.#scheduleRender();
        },
      };
      this.#workingIndicators.set(selectedKey, owner);
      signal.addEventListener("abort", owner.onAbort, { once: true });
      if (signal.aborted) owner.onAbort();
    }
    this.#restartActivityTimer();
    this.#scheduleRender();
  }

  setHiddenReasoningLabel(value?: string, signal?: AbortSignal): void {
    this.setKeyedHiddenReasoningLabel(CONTROLLER_ADVANCED_UI_KEY, value, signal);
  }

  setKeyedHiddenReasoningLabel(key: string, value?: string, signal?: AbortSignal): void {
    const selectedKey = persistentComponentKey(key);
    const selected = value === undefined ? undefined : hiddenReasoningLabel(value);
    if (selected !== undefined) {
      if (signal === undefined) throw new Error("Hidden reasoning labels require a generation signal");
      signal.throwIfAborted();
    }
    const previous = this.#hiddenReasoningLabels.get(selectedKey);
    if (previous !== undefined) previous.signal.removeEventListener("abort", previous.onAbort);
    this.#hiddenReasoningLabels.delete(selectedKey);
    if (selected !== undefined && signal !== undefined) {
      const owner: HiddenReasoningLabelOwner = {
        value: selected,
        signal,
        onAbort: () => {
          if (this.#hiddenReasoningLabels.get(selectedKey) !== owner) return;
          this.#hiddenReasoningLabels.delete(selectedKey);
          this.#scheduleRender();
        },
      };
      this.#hiddenReasoningLabels.set(selectedKey, owner);
      signal.addEventListener("abort", owner.onAbort, { once: true });
      if (signal.aborted) owner.onAbort();
    }
    this.#scheduleRender();
  }

  getToolOutputExpanded(): boolean {
    return this.#model.toolOutputExpanded;
  }

  setToolOutputExpanded(expanded?: boolean, signal?: AbortSignal): void {
    this.setKeyedToolOutputExpanded(CONTROLLER_ADVANCED_UI_KEY, expanded, signal);
  }

  setKeyedToolOutputExpanded(key: string, expanded?: boolean, signal?: AbortSignal): void {
    const selectedKey = persistentComponentKey(key);
    if (expanded !== undefined) {
      if (typeof expanded !== "boolean") throw new TypeError("Tool output expansion must be boolean");
      if (signal === undefined) throw new Error("Tool output expansion requires a generation signal");
      signal.throwIfAborted();
    }
    const previous = this.#toolOutputExpansions.get(selectedKey);
    if (previous !== undefined) previous.signal.removeEventListener("abort", previous.onAbort);
    this.#toolOutputExpansions.delete(selectedKey);
    if (expanded === undefined || signal === undefined) {
      this.#applyToolOutputExpansion();
      this.#scheduleRender();
      return;
    }
    if (this.#toolOutputExpansions.size === 0 && this.#toolOutputExpansionBaseline === undefined) {
      this.#toolOutputExpansionBaseline = this.#model.toolOutputExpanded;
    }
    const owner: ToolOutputExpansionOwner = {
      value: expanded,
      signal,
      onAbort: () => {
        if (this.#toolOutputExpansions.get(selectedKey) !== owner) return;
        this.#toolOutputExpansions.delete(selectedKey);
        this.#applyToolOutputExpansion();
        this.#scheduleRender();
      },
    };
    this.#toolOutputExpansions.set(selectedKey, owner);
    this.#applyToolOutputExpansion();
    signal.addEventListener("abort", owner.onAbort, { once: true });
    if (signal.aborted) owner.onAbort();
    this.#scheduleRender();
  }

  #applyToolOutputExpansion(): void {
    const active = [...this.#toolOutputExpansions.values()].at(-1);
    if (active !== undefined) {
      this.#model.setToolOutputExpanded(active.value);
      return;
    }
    if (this.#toolOutputExpansionBaseline === undefined) return;
    const restore = this.#toolOutputExpansionBaseline;
    this.#toolOutputExpansionBaseline = undefined;
    this.#model.setToolOutputExpanded(restore);
  }

  setNormalizedKeyObserver(
    key: string,
    observer?: TuiNormalizedKeyObserver,
    signal?: AbortSignal,
  ): void {
    const selectedKey = persistentComponentKey(key);
    const previous = this.#normalizedKeyObservers.get(selectedKey);
    if (observer === undefined) {
      if (previous !== undefined) previous.signal.removeEventListener("abort", previous.onAbort);
      this.#normalizedKeyObservers.delete(selectedKey);
      return;
    }
    if (this.mode !== "full") throw new Error("Normalized key observers require the full TUI");
    if (typeof observer !== "function") throw new TypeError("Normalized key observer must be a function");
    if (signal === undefined) throw new Error("Normalized key observers require a generation signal");
    signal.throwIfAborted();
    const owner: NormalizedKeyObserverOwner = {
      key: selectedKey,
      observer,
      signal,
      onAbort: () => {
        if (this.#normalizedKeyObservers.get(selectedKey) === owner) this.#normalizedKeyObservers.delete(selectedKey);
      },
    };
    if (previous !== undefined) previous.signal.removeEventListener("abort", previous.onAbort);
    this.#normalizedKeyObservers.set(selectedKey, owner);
    signal.addEventListener("abort", owner.onAbort, { once: true });
    if (signal.aborted) owner.onAbort();
  }

  setEditorRenderer(binding?: RuntimeEditorRendererBinding, signal?: AbortSignal): void {
    const previous = this.#editorRenderer;
    if (previous !== undefined) previous.signal.removeEventListener("abort", previous.onAbort);
    this.#editorRenderer = undefined;
    if (binding !== undefined) {
      if (signal === undefined) throw new Error("Editor renderer requires a generation signal");
      signal.throwIfAborted();
      const owner: EditorRendererOwner = {
        binding,
        signal,
        warned: false,
        onAbort: () => {
          if (this.#editorRenderer !== owner) return;
          this.#editorRenderer = undefined;
          this.#scheduleRender();
        },
      };
      this.#editorRenderer = owner;
      signal.addEventListener("abort", owner.onAbort, { once: true });
      if (signal.aborted) owner.onAbort();
    }
    this.#scheduleRender();
  }

  start(): void {
    if (this.#closed) throw new Error("TUI is closed");
    if (this.#started) return;
    this.#started = true;
    this.#previousRaw = this.input.isRaw === true;
    this.input.on("data", this.#onData);
    this.input.on("error", this.#onStreamError);
    this.input.on("end", this.#onInputEnd);
    this.output.on("error", this.#onStreamError);
    this.output.on("resize", this.#onResize);
    if (this.#handleSignals) {
      this.#signalSource.on("SIGINT", this.#onSignal);
      this.#signalSource.on("SIGTERM", this.#onSignal);
      this.#signalSource.on("SIGHUP", this.#onSignal);
    }
    try {
      if (this.capabilities.rawInput) this.input.setRawMode?.(true);
      this.input.resume();
      this.#enterTerminalSurface();
      this.renderNow();
    } catch (cause) {
      this.close();
      throw cause;
    }
  }

  render(envelope: EventEnvelope): void {
    this.#ensureStarted();
    this.#model.apply(envelope);
    this.#syncActivityTimer();
    this.#pruneSessionEntries();
    this.#transcriptOffset = 0;
    if (this.mode === "full") this.#scheduleRender();
    else this.#renderClassic(envelope);
  }

  renderSessionEntry(entry: TuiSessionEntry): void {
    this.#ensureStarted();
    if (entry.type !== "custom" && entry.type !== "custom_message") {
      throw new Error("Session rendering requires a direct custom entry");
    }
    if (entry.type === "custom" || entry.display === true) {
      const retained = retainSessionEntry(entry);
      const prior = this.#sessionEntries.get(entry.id);
      if (prior !== undefined) this.#sessionEntryBytes -= prior.bytes;
      this.#sessionEntries.set(entry.id, retained);
      this.#sessionEntryBytes += retained.bytes;
    }
    this.#model.applySessionEntry(entry);
    this.#pruneSessionEntries();
    this.#transcriptOffset = 0;
    if (this.mode === "full") this.#scheduleRender();
    else this.#renderClassicSessionEntry(entry.id);
  }

  replaceTranscript(items: readonly TuiTranscriptItem[], branch?: string): void {
    this.#ensureStarted();
    if (branch !== undefined && (
      typeof branch !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(branch)
      || branch.includes("..")
    )) {
      throw new Error("Transcript replacement requires a branch");
    }
    this.#resetTranscript();
    this.#model.applyAll(items);
    const liveExtensionEntries = new Set(this.#model.entries.flatMap((entry) =>
      entry.extension === undefined ? [] : [entry.id]));
    for (const item of items) {
      if ("event" in item || !liveExtensionEntries.has(item.id)) continue;
      if (item.type === "custom_message" && item.display !== true) continue;
      const retained = retainSessionEntry(item);
      this.#sessionEntries.set(item.id, retained);
      this.#sessionEntryBytes += retained.bytes;
    }
    this.#pruneSessionEntries();
    this.#syncActivityTimer();
    this.#transcriptOffset = 0;
    if (this.mode === "full") this.#scheduleRender();
    else {
      const entries = this.#model.entries.filter((entry) => entry.kind !== "startup");
      const rendered = renderTranscriptFrame(entries, terminalSize(this.output, this.capabilities).columns, this.#theme, {
        sessionRenderBlocks: this.#renderSessionBlocks(
          entries,
          terminalSize(this.output, this.capabilities).columns,
          terminalSize(this.output, this.capabilities).rows,
        ),
        resolveImage: (image, imageLimits) => this.#terminalImages.resolve(image, {
          protocol: this.#showImages ? this.capabilities.imageProtocol : null,
          ...imageLimits,
        }),
        hideReasoningBlock: this.#hideThinkingBlock,
        outputPad: this.#outputPad,
        codeBlockIndent: this.#codeBlockIndent,
        imageWidthCells: this.#imageWidthCells,
      });
      if (rendered.text !== "") this.#write(`${rendered.text}\n`);
    }
  }

  notify(message: string, kind: "status" | "warning" | "error" = "status"): void {
    this.#ensureStarted();
    this.#model.addLocal(kind, message);
    this.#transcriptOffset = 0;
    if (this.mode === "full") this.#scheduleRender();
    else this.#write(`\n[${kind}] ${sanitizeTerminalText(message)}\n`);
  }

  setStartup(compactText: string, expandedText: string): void {
    if (this.#closed) throw new Error("TUI is closed");
    this.#model.setStartup(compactText, expandedText);
    this.#transcriptOffset = 0;
    this.#ensureStarted();
    if (this.mode === "full") this.#scheduleRender();
    else this.#write(`\n${sanitizeTerminalText(compactText)}\n`);
  }

  clearStartup(): void {
    this.#model.clearStartup();
    this.#transcriptOffset = 0;
    if (this.#started && this.mode === "full") this.#scheduleRender();
  }

  copyToClipboard(value: string): void {
    this.#ensureStarted();
    if (!this.capabilities.ansi) throw new Error("Terminal clipboard is unavailable in accessibility mode");
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length === 0) throw new Error("There is no assistant text to copy");
    if (bytes.length > 100 * 1024) throw new Error("Assistant text exceeds the 100 KiB terminal clipboard limit");
    this.#write(`\u001b]52;c;${bytes.toString("base64")}\u0007`);
  }

  clearTranscript(): void {
    this.#resetTranscript();
    this.#scheduleRender();
  }

  #resetTranscript(): void {
    this.#model.clearTranscript();
    this.#sessionEntries.clear();
    this.#sessionEntryBytes = 0;
    this.#terminalImages.clear();
    this.#inlineCommittedIds.clear();
    this.#inlineRevealedIds.clear();
    this.#transcriptOffset = 0;
  }

  question(prompt: string, signal?: AbortSignal, options: { cancelable?: boolean } = {}): Promise<string> {
    this.#ensureStarted();
    if (this.#pendingQuestion !== undefined) return Promise.reject(new Error("Another terminal question is active"));
    if (this.#overlay?.resolve !== undefined) return Promise.reject(new Error("A terminal picker is active"));
    signal?.throwIfAborted();
    const previousInputLabel = this.#inputLabel;
    this.#inputLabel = inputLabel(prompt);
    if (this.mode !== "full") this.#write(prompt);
    this.#scheduleRender();
    return new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        if (this.#pendingQuestion?.resolve !== resolve) return;
        const pending = this.#pendingQuestion;
        pending.cleanup();
        this.#pendingQuestion = undefined;
        this.#inputLabel = pending.previousInputLabel;
        reject(signal?.reason instanceof Error ? signal.reason : new Error("Terminal question cancelled"));
        this.#scheduleRender();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pendingQuestion = {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
        previousInputLabel,
        cancelable: options.cancelable !== false,
      };
    });
  }

  async readSecret(prompt: string, signal?: AbortSignal): Promise<string> {
    this.#ensureStarted();
    if (this.#pendingQuestion !== undefined || this.#overlay !== undefined || this.#secretAbort !== undefined || this.#externalEditing) {
      throw new Error("Another terminal question is active");
    }
    const cancellation = new AbortController();
    const combinedSignal = signal === undefined
      ? cancellation.signal
      : AbortSignal.any([signal, cancellation.signal]);
    const wasRaw = this.input.isRaw === true;
    this.#secretAbort = cancellation;
    this.input.off("data", this.#onData);
    if (this.mode === "full") {
      this.#leaveTerminalSurface();
    }
    try {
      return await readSecretFrom(this.input, this.output, sanitizeTerminalText(prompt), combinedSignal);
    } finally {
      if (this.#secretAbort === cancellation) this.#secretAbort = undefined;
      if (!this.#closed) {
        if (this.capabilities.rawInput) this.input.setRawMode?.(wasRaw);
        this.input.on("data", this.#onData);
        this.input.resume();
        this.#enterTerminalSurface();
        this.#renderScheduled = false;
        this.#scheduleRender();
      }
    }
  }

  choose<T>(prompt: string, choices: TerminalChoice<T>[], signal?: AbortSignal): Promise<T> {
    this.#ensureStarted();
    if (choices.length === 0) return Promise.reject(new Error("No choices are available"));
    if (this.#overlay !== undefined) return Promise.reject(new Error("Another terminal picker is active"));
    signal?.throwIfAborted();
    if (this.mode !== "full") return this.#chooseByLine(prompt, choices, signal);
    const source = choices.slice(0, this.#limits.maxPickerItems).map((choice, index): PickerItem<T> => ({
      id: String(index),
      label: choice.label,
      value: choice.value,
      ...(choice.detail === undefined ? {} : { detail: choice.detail }),
    }));
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => this.#closeOverlay(signal?.reason instanceof Error ? signal.reason : new Error("Selection cancelled"));
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#openOverlay("generic", prompt, source as PickerItem[], {
        resolve: (value) => resolve(value as T),
        reject,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      });
    });
  }

  async #chooseByLine<T>(prompt: string, choices: TerminalChoice<T>[], signal?: AbortSignal): Promise<T> {
    let query = "";
    while (true) {
      signal?.throwIfAborted();
      const normalized = query.toLocaleLowerCase();
      const filtered = normalized === ""
        ? choices
        : choices.filter((choice) => `${choice.label} ${choice.detail ?? ""}`.toLocaleLowerCase().includes(normalized));
      this.#write(`\n${sanitizeTerminalText(prompt).replaceAll("\n", " ")}\n`);
      if (filtered.length === 0) this.#write("  No matches.\n");
      for (const [index, choice] of filtered.slice(0, 20).entries()) {
        const detail = choice.detail === undefined ? "" : ` — ${sanitizeTerminalText(choice.detail).replaceAll("\n", " ")}`;
        this.#write(`  ${index + 1}. ${sanitizeTerminalText(choice.label).replaceAll("\n", " ")}${detail}\n`);
      }
      if (filtered.length > 20) this.#write(`  … ${filtered.length - 20} more; type a narrower search.\n`);
      const answer = (await this.question("Select a number, type to search, Enter for 1, or /cancel: ", signal)).trim();
      if (answer === "/cancel") throw new TuiSelectionCancelledError();
      if (answer === "" && filtered.length > 0) return filtered[0]!.value;
      if (/^\d+$/u.test(answer)) {
        const index = Number(answer) - 1;
        if (index >= 0 && index < Math.min(filtered.length, 20)) return filtered[index]!.value;
        this.#write("Selection is outside the displayed range.\n");
        continue;
      }
      const exact = filtered.find((choice) => choice.label === answer);
      if (exact !== undefined) return exact.value;
      const nextQuery = answer.toLocaleLowerCase();
      const matches = choices.filter((choice) =>
        `${choice.label} ${choice.detail ?? ""}`.toLocaleLowerCase().includes(nextQuery));
      if (matches.length === 1) return matches[0]!.value;
      query = answer;
    }
  }

  chooseSettings(
    items: readonly TuiSettingItem[],
    onChange: (item: TuiSettingItem, value: string) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    this.#ensureStarted();
    if (this.mode !== "full") return Promise.reject(new Error("The settings menu requires the full TUI"));
    if (items.length === 0) return Promise.reject(new Error("No settings are available"));
    if (this.#overlay !== undefined) return Promise.reject(new Error("Another terminal picker is active"));
    signal?.throwIfAborted();
    const source = items.slice(0, this.#limits.maxPickerItems).map((item) => {
      if (!/^[a-z][a-z0-9-]{0,62}$/u.test(item.id) || item.values.length === 0 || !item.values.includes(item.value)) {
        throw new Error(`Invalid setting definition: ${item.id}`);
      }
      return settingPickerItem(item);
    });
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => this.#closeOverlay(signal?.reason instanceof Error ? signal.reason : new Error("Settings cancelled"));
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#openOverlay("generic", "Settings", source, {
        resolve: () => resolve(),
        reject: (cause) => cause instanceof TuiSelectionCancelledError ? resolve() : reject(cause),
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      });
      if (this.#overlay !== undefined) this.#overlay.settings = { onChange, busy: false };
    });
  }

  custom<T>(
    factory: RuntimeUiComponentFactory<T>,
    options?: RuntimeUiCustomOptions,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    this.#ensureStarted();
    if (this.mode !== "full") return Promise.reject(new Error("Runtime components require the full TUI"));
    if (this.#overlay !== undefined || this.#runtimeComponent !== undefined || this.#pendingQuestion !== undefined) {
      return Promise.reject(new Error("Another terminal interaction is active"));
    }
    let selectedOptions: NormalizedRuntimeCustomOptions;
    try {
      selectedOptions = normalizeRuntimeCustomOptions(options);
    } catch (cause) {
      return Promise.reject(error(cause));
    }
    const ownerSignal = signal ?? new AbortController().signal;
    return new Promise<T | undefined>((resolve, reject) => {
      let owner: RuntimeComponentOwner | undefined;
      try {
        const mount = RuntimeUiComponentMount.create<T>(factory, {
          signal: ownerSignal,
          requestRender: () => this.#scheduleRender(),
          onClose: (value) => {
            if (owner !== undefined) this.#removeRuntimeOwner(owner);
            this.#scheduleRender();
            resolve(value);
          },
          onError: (cause) => {
            try {
              this.notify(`Runtime component failed: ${cause.message}`, "warning");
            } catch {}
          },
        });
        owner = {
          mount: mount as RuntimeUiComponentMount<unknown>,
          options: selectedOptions,
          hidden: false,
          focused: false,
          focusOrder: ++this.#runtimeFocusOrder,
          preFocus: this.#focusedRuntimeOwner(),
          restoreWhenVisible: false,
        };
        if (!mount.closed) {
          this.#runtimeComponent = owner;
          if (this.#runtimeOwnerCaptures(owner)) {
            if (this.#runtimeOwnerVisible(owner)) this.#setRuntimeFocus(owner, false);
            else owner.restoreWhenVisible = !owner.mount.closed;
          }
          const handle = this.#createRuntimeHandle(owner);
          owner.handle = handle;
          try {
            selectedOptions.onHandle?.(handle);
          } catch (cause) {
            this.notify(`Runtime component handle failed: ${error(cause).message}`, "warning");
            mount.close();
          }
          this.#scheduleRender();
        }
      } catch (cause) {
        reject(error(cause));
      }
    });
  }

  showOverlay<T>(
    factory: RuntimeUiComponentFactory<T>,
    options?: Omit<RuntimeUiCustomOptions, "overlay">,
    signal?: AbortSignal,
  ): RuntimeUiOverlayHandle<T> {
    this.#ensureStarted();
    if (this.mode !== "full") throw new Error("Runtime overlays require the full TUI");
    const selectedOptions = normalizeRuntimeCustomOptions({ ...options, overlay: true });
    const ownerSignal = signal ?? new AbortController().signal;
    let resolveResult!: (value: T | undefined) => void;
    const result = new Promise<T | undefined>((resolve) => { resolveResult = resolve; });
    let owner: RuntimeComponentOwner | undefined;
    const mount = RuntimeUiComponentMount.create<T>(factory, {
      signal: ownerSignal,
      requestRender: () => this.#scheduleRender(),
      onClose: (value) => {
        if (owner !== undefined) this.#removeRuntimeOwner(owner);
        this.#scheduleRender();
        resolveResult(value);
      },
      onError: (cause) => {
        try {
          this.notify(`Runtime overlay failed: ${cause.message}`, "warning");
        } catch {}
      },
    });
    owner = {
      mount: mount as RuntimeUiComponentMount<unknown>,
      options: selectedOptions,
      hidden: false,
      focused: false,
      focusOrder: ++this.#runtimeFocusOrder,
      preFocus: this.#focusedRuntimeOwner(),
      restoreWhenVisible: false,
    };
    const baseHandle = this.#createRuntimeHandle(owner);
    const handle: RuntimeUiOverlayHandle<T> = Object.freeze({ ...baseHandle, result });
    owner.handle = handle;
    if (!mount.closed) {
      this.#runtimeOverlays.push(owner);
      if (this.#runtimeOwnerCaptures(owner)) {
        if (this.#runtimeOwnerVisible(owner)) this.#setRuntimeFocus(owner, false);
        else owner.restoreWhenVisible = !owner.mount.closed;
      }
      try {
        selectedOptions.onHandle?.(handle);
      } catch (cause) {
        this.notify(`Runtime overlay handle failed: ${error(cause).message}`, "warning");
        mount.close();
      }
      this.#scheduleRender();
    }
    return handle;
  }

  #createRuntimeHandle(owner: RuntimeComponentOwner): RuntimeUiComponentHandle {
    const close = () => owner.mount.close();
    return Object.freeze({
      close,
      hide: close,
      setHidden: (hidden: boolean) => this.#setRuntimeHidden(owner, hidden),
      isHidden: () => owner.hidden || owner.mount.closed,
      focus: () => {
        if (!this.#runtimeOwnerVisible(owner)) return;
        this.#setRuntimeFocus(owner, true);
        this.#scheduleRender();
      },
      unfocus: (options?: RuntimeUiOverlayUnfocusOptions) => this.#unfocusRuntimeOwner(owner, options),
      isFocused: () => owner.focused && !owner.mount.closed,
    });
  }

  #runtimeOwners(): RuntimeComponentOwner[] {
    return [
      ...(this.#runtimeComponent === undefined ? [] : [this.#runtimeComponent]),
      ...this.#runtimeOverlays,
    ];
  }

  #focusedRuntimeOwner(): RuntimeComponentOwner | null {
    return this.#runtimeOwners().find((owner) => owner.focused && !owner.mount.closed) ?? null;
  }

  #runtimeOwnerCaptures(owner: RuntimeComponentOwner): boolean {
    return owner.options.overlay !== true || owner.options.overlayOptions?.nonCapturing !== true;
  }

  #runtimeOwnerVisible(owner: RuntimeComponentOwner): boolean {
    if (owner.mount.closed || owner.hidden) return false;
    const visible = owner.options.overlayOptions?.visible;
    if (visible === undefined) return true;
    const size = terminalSize(this.output, this.capabilities);
    try {
      return visible(size.columns, size.rows) === true;
    } catch (cause) {
      try {
        this.notify(`Runtime component visibility failed: ${error(cause).message}`, "warning");
      } catch {}
      owner.mount.close();
      return false;
    }
  }

  #setRuntimeFocus(owner: RuntimeComponentOwner | null, bumpOrder: boolean): void {
    for (const candidate of this.#runtimeOwners()) candidate.focused = false;
    if (owner === null || !this.#runtimeOwnerVisible(owner)) return;
    if (bumpOrder) owner.focusOrder = ++this.#runtimeFocusOrder;
    owner.restoreWhenVisible = false;
    owner.focused = true;
  }

  #topRuntimeOwner(excluded?: RuntimeComponentOwner): RuntimeComponentOwner | null {
    let selected: RuntimeComponentOwner | null = null;
    for (const candidate of this.#runtimeOwners()) {
      if (candidate === excluded || !this.#runtimeOwnerCaptures(candidate) || !this.#runtimeOwnerVisible(candidate)) continue;
      if (selected === null || candidate.focusOrder > selected.focusOrder) selected = candidate;
    }
    return selected;
  }

  #fallbackRuntimeOwner(owner: RuntimeComponentOwner): RuntimeComponentOwner | null {
    const top = this.#topRuntimeOwner(owner);
    if (top !== null) return top;
    const seen = new Set<RuntimeComponentOwner>([owner]);
    let previous = owner.preFocus;
    while (previous !== null && !seen.has(previous)) {
      seen.add(previous);
      if (this.#runtimeOwners().includes(previous) && this.#runtimeOwnerVisible(previous)) return previous;
      previous = previous.preFocus;
    }
    return null;
  }

  #setRuntimeHidden(owner: RuntimeComponentOwner, hidden: boolean): void {
    if (typeof hidden !== "boolean") throw new Error("Runtime component hidden state must be boolean");
    if (owner.mount.closed || owner.hidden === hidden) return;
    owner.hidden = hidden;
    if (hidden) {
      owner.restoreWhenVisible = false;
      if (owner.focused) this.#setRuntimeFocus(this.#fallbackRuntimeOwner(owner), false);
    }
    else if (!hidden && this.#runtimeOwnerCaptures(owner) && this.#runtimeOwnerVisible(owner)) {
      this.#setRuntimeFocus(owner, true);
    }
    this.#scheduleRender();
  }

  #unfocusRuntimeOwner(owner: RuntimeComponentOwner, options?: RuntimeUiOverlayUnfocusOptions): void {
    if (owner.mount.closed || !owner.focused) return;
    owner.restoreWhenVisible = false;
    let target: RuntimeComponentOwner | null;
    if (options === undefined) target = this.#fallbackRuntimeOwner(owner);
    else {
      if (options === null || typeof options !== "object" || !("target" in options)) {
        throw new Error("Runtime overlay unfocus options must provide a target");
      }
      target = options.target === null
        ? null
        : this.#runtimeOwners().find((candidate) => candidate.handle === options.target) ?? null;
      if (options.target !== null && target === null) throw new Error("Runtime overlay unfocus target is not active");
    }
    this.#setRuntimeFocus(target, false);
    this.#scheduleRender();
  }

  #removeRuntimeOwner(owner: RuntimeComponentOwner): void {
    const wasFocused = owner.focused;
    if (this.#runtimeComponent === owner) this.#runtimeComponent = undefined;
    const index = this.#runtimeOverlays.indexOf(owner);
    if (index >= 0) this.#runtimeOverlays.splice(index, 1);
    for (const candidate of this.#runtimeOwners()) {
      if (candidate.preFocus === owner) candidate.preFocus = owner.preFocus;
    }
    owner.focused = false;
    owner.restoreWhenVisible = false;
    if (wasFocused) this.#setRuntimeFocus(this.#fallbackRuntimeOwner(owner), false);
  }

  #createRawHandle(owner: RawComponentOwner): RuntimeUiComponentHandle {
    const close = () => owner.mount.close();
    return Object.freeze({
      close,
      hide: close,
      setHidden: (hidden: boolean) => {
        if (typeof hidden !== "boolean") throw new TypeError("Raw overlay hidden state must be boolean");
        if (owner.mount.closed || owner.hidden === hidden) return;
        owner.hidden = hidden;
        if (hidden && owner.focused) this.#setRawFocus(this.#fallbackRawOwner(owner), false);
        else if (!hidden && this.#rawOwnerCaptures(owner) && this.#rawOwnerVisible(owner)) this.#setRawFocus(owner, true);
        this.#scheduleRender();
      },
      isHidden: () => owner.hidden || owner.mount.closed,
      focus: () => {
        if (this.#rawOwnerVisible(owner)) this.#setRawFocus(owner, true);
        this.#scheduleRender();
      },
      unfocus: () => {
        if (owner.focused) this.#setRawFocus(this.#fallbackRawOwner(owner), false);
        this.#scheduleRender();
      },
      isFocused: () => owner.focused && !owner.mount.closed,
    });
  }

  #rawOwners(): RawComponentOwner[] {
    return [
      ...(this.#rawRuntimeComponent === undefined ? [] : [this.#rawRuntimeComponent]),
      ...this.#rawRuntimeOverlays,
    ];
  }

  #focusedRawOwner(): RawComponentOwner | null {
    return this.#rawOwners().find((owner) => owner.focused && !owner.mount.closed) ?? null;
  }

  #rawOwnerCaptures(owner: RawComponentOwner): boolean {
    return owner.options.overlay !== true || owner.options.overlayOptions?.nonCapturing !== true;
  }

  #rawOwnerVisible(owner: RawComponentOwner): boolean {
    if (owner.mount.closed || owner.hidden) return false;
    const visible = owner.options.overlayOptions?.visible;
    if (visible === undefined) return true;
    const size = terminalSize(this.output, this.capabilities);
    try { return visible(size.columns, size.rows) === true; }
    catch (cause) {
      try { this.notify(`Raw component visibility failed: ${error(cause).message}`, "warning"); } catch {}
      owner.mount.close();
      return false;
    }
  }

  #setRawFocus(owner: RawComponentOwner | null, bumpOrder: boolean): void {
    for (const candidate of this.#rawOwners()) candidate.focused = false;
    if (owner === null || !this.#rawOwnerVisible(owner)) return;
    if (bumpOrder) owner.focusOrder = ++this.#rawRuntimeFocusOrder;
    owner.restoreWhenVisible = false;
    owner.focused = true;
  }

  #fallbackRawOwner(owner: RawComponentOwner): RawComponentOwner | null {
    const selected = this.#rawOwners()
      .filter((candidate) => candidate !== owner && this.#rawOwnerCaptures(candidate) && this.#rawOwnerVisible(candidate))
      .sort((left, right) => right.focusOrder - left.focusOrder)[0];
    if (selected !== undefined) return selected;
    const seen = new Set<RawComponentOwner>([owner]);
    let previous = owner.preFocus;
    while (previous !== null && !seen.has(previous)) {
      seen.add(previous);
      if (this.#rawOwners().includes(previous) && this.#rawOwnerVisible(previous)) return previous;
      previous = previous.preFocus;
    }
    return null;
  }

  #removeRawOwner(owner: RawComponentOwner): void {
    const wasFocused = owner.focused;
    if (this.#rawRuntimeComponent === owner) this.#rawRuntimeComponent = undefined;
    const index = this.#rawRuntimeOverlays.indexOf(owner);
    if (index >= 0) this.#rawRuntimeOverlays.splice(index, 1);
    for (const candidate of this.#rawOwners()) if (candidate.preFocus === owner) candidate.preFocus = owner.preFocus;
    owner.focused = false;
    owner.restoreWhenVisible = false;
    if (wasFocused) this.#setRawFocus(this.#fallbackRawOwner(owner), false);
  }

  choosePicker<T>(
    kind: Exclude<PickerKind, "command" | "generic">,
    prompt: string,
    items: readonly PickerItem<T>[],
    signal?: AbortSignal,
  ): Promise<T> {
    this.#ensureStarted();
    if (items.length === 0 && kind !== "session") return Promise.reject(new Error("No choices are available"));
    if (this.#overlay !== undefined) return Promise.reject(new Error("Another terminal picker is active"));
    signal?.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => this.#closeOverlay(signal?.reason instanceof Error ? signal.reason : new Error("Selection cancelled"));
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#openOverlay(kind, prompt, items as readonly PickerItem[], {
        resolve: (value) => resolve(value as T),
        reject,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      });
    });
  }

  chooseScopedModels(
    items: readonly PickerItem<ScopedModelOption>[],
    options: {
      all: boolean;
      selected: readonly string[];
      live?: boolean;
      onChange?: (selection: ScopedModelSelection) => void;
      onSave?: (selection: ScopedModelSelection) => void | Promise<void>;
    },
    signal?: AbortSignal,
  ): Promise<ScopedModelSelection> {
    this.#ensureStarted();
    if (this.mode !== "full") return Promise.reject(new Error("Scoped model selector requires the full TUI"));
    if (this.#overlay !== undefined) return Promise.reject(new Error("Another terminal picker is active"));
    signal?.throwIfAborted();
    const maximumModels = Math.max(0, this.#limits.maxPickerItems - scopedModelActions.length);
    const seen = new Set<string>();
    const models = items.slice(0, maximumModels).filter((item) => {
      const value = item.value;
      if (value.provider.trim() === "" || value.model.trim() === "") return false;
      const pattern = `${value.provider}/${value.model}`;
      if (seen.has(pattern)) return false;
      seen.add(pattern);
      return true;
    }).map((item) => ({ ...item, value: { ...item.value } }));
    const source: PickerItem[] = [
      ...scopedModelActions.slice(0, this.#limits.maxPickerItems),
      ...models,
    ].slice(0, this.#limits.maxPickerItems);
    return new Promise<ScopedModelSelection>((resolve, reject) => {
      const onAbort = () => this.#closeOverlay(signal?.reason instanceof Error ? signal.reason : new Error("Selection cancelled"));
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#openOverlay("generic", "Scoped Models", source, {
        resolve: (value) => resolve(value as ScopedModelSelection),
        reject,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      });
      if (this.#overlay === undefined) return;
      this.#overlay.scopedModels = {
        source: models,
        selected: new Set(options.selected.filter((pattern) => seen.has(pattern))),
        order: [...new Set(options.selected.filter((pattern) => seen.has(pattern)))],
        all: options.all,
        ...(options.live === true ? { live: true } : {}),
        ...(options.onChange === undefined ? {} : { onChange: options.onChange }),
        ...(options.onSave === undefined ? {} : { onSave: options.onSave }),
      };
      this.#refreshOverlay();
      this.#scheduleRender();
    });
  }

  chooseSessionTree<T>(
    prompt: string,
    items: readonly (PickerItem<T> & { tree: SessionTreeMetadata })[],
    options: {
      onLabelChange?: (eventId: string, label: string | undefined) =>
        { label?: string; labelTimestamp?: string } | Promise<{ label?: string; labelTimestamp?: string }>;
      filter?: SessionTreeFilterMode;
    } = {},
    signal?: AbortSignal,
  ): Promise<T> {
    this.#ensureStarted();
    if (this.mode !== "full") return Promise.reject(new Error("Session tree selector requires the full TUI"));
    if (items.length === 0) return Promise.reject(new Error("No choices are available"));
    if (this.#overlay !== undefined) return Promise.reject(new Error("Another terminal picker is active"));
    signal?.throwIfAborted();
    const seen = new Set<string>();
    const boundedStrings = (values: readonly string[]): string[] => values.slice(0, 128)
      .map((value) => sanitizeTerminalText(value).replaceAll("\n", " ").slice(0, 256));
    const source = items.slice(0, this.#limits.maxPickerItems).flatMap((item): PickerItem<T>[] => {
      const eventId = sanitizeTerminalText(item.tree.eventId).replaceAll("\n", " ").slice(0, 512);
      if (eventId === "" || seen.has(eventId)) return [];
      seen.add(eventId);
      const tree: SessionTreeMetadata = {
        eventId,
        ...(item.tree.parentEventId === undefined
          ? {}
          : { parentEventId: sanitizeTerminalText(item.tree.parentEventId).replaceAll("\n", " ").slice(0, 512) }),
        kind: sanitizeTerminalText(item.tree.kind).replaceAll("\n", " ").slice(0, 128),
        depth: Number.isSafeInteger(item.tree.depth) ? Math.max(0, Math.min(this.#limits.maxPickerItems, item.tree.depth)) : 0,
        prefix: sanitizeTerminalText(item.tree.prefix).replaceAll("\n", " ").slice(0, 4096),
        branches: boundedStrings(item.tree.branches),
        paths: boundedStrings(item.tree.paths),
        active: item.tree.active === true,
        ...(item.tree.label === undefined ? {} : { label: sanitizeTerminalText(item.tree.label).replaceAll("\n", " ").slice(0, 256) }),
        ...(item.tree.labelTimestamp === undefined ? {} : { labelTimestamp: sanitizeTerminalText(item.tree.labelTimestamp).replaceAll("\n", " ").slice(0, 64) }),
      };
      return [{
        id: sanitizeTerminalText(item.id).replaceAll("\n", " ").slice(0, 512) || eventId,
        label: sanitizeTerminalText(item.label).replaceAll("\n", " ").slice(0, 4096),
        ...(item.detail === undefined ? {} : { detail: sanitizeTerminalText(item.detail).replaceAll("\n", " ").slice(0, 4096) }),
        ...(item.keywords === undefined ? {} : { keywords: boundedStrings(item.keywords.slice(0, 32)) }),
        tree,
        value: item.value,
      }];
    });
    if (source.length === 0) return Promise.reject(new Error("No choices are available"));
    const preferred = source.findLast((item) => item.tree?.active === true && item.tree.branches.length > 0)
      ?? source.findLast((item) => item.tree?.active === true);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => this.#closeOverlay(signal?.reason instanceof Error ? signal.reason : new Error("Selection cancelled"));
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#openOverlay("generic", prompt, source, {
        resolve: (value) => resolve(value as T),
        reject,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      });
      const overlay = this.#overlay;
      if (overlay === undefined) return;
      overlay.tree = {
        folded: new Set(),
        activeOnly: false,
        filter: options.filter ?? this.#treeFilterMode,
        showLabelTimestamps: false,
        mode: "list",
        ...(options.onLabelChange === undefined ? {} : { onLabelChange: options.onLabelChange }),
        ...(preferred?.tree === undefined ? {} : { preferredActiveEventId: preferred.tree.eventId }),
      };
      this.#refreshOverlay();
      const preferredIndex = overlay.items.findIndex((item) => item.tree?.eventId === preferred?.tree?.eventId);
      overlay.selected = preferredIndex < 0 ? 0 : preferredIndex;
      this.#scheduleRender();
    });
  }

  setPickerStatus(kind: Exclude<PickerKind, "command" | "generic">, status?: string): void {
    if (this.#overlay?.kind !== kind || this.#overlay.session === undefined) return;
    if (status === undefined) delete this.#overlay.session.status;
    else this.#overlay.session.status = sanitizeTerminalText(status).replaceAll("\n", " ");
    this.#scheduleRender();
  }

  setSessionPickerScope(scope: "current" | "all", status?: string): void {
    const session = this.#overlay?.kind === "session" ? this.#overlay.session : undefined;
    if (session === undefined) return;
    session.scope = scope;
    if (status === undefined) delete session.status;
    else session.status = sanitizeTerminalText(status).replaceAll("\n", " ");
    this.#refreshOverlay();
    this.#scheduleRender();
  }

  setSessionPickerPagination(hasMore: boolean, status?: string): void {
    this.#sessionPickerPagination = {
      hasMore,
      ...(status === undefined ? {} : { status: sanitizeTerminalText(status).replaceAll("\n", " ") }),
    };
    const session = this.#overlay?.kind === "session" ? this.#overlay.session : undefined;
    if (session === undefined) return;
    session.hasMore = hasMore;
    session.loadingMore = false;
    if (this.#sessionPickerPagination.status === undefined) delete session.status;
    else session.status = this.#sessionPickerPagination.status;
    this.#scheduleRender();
  }

  setSteering(handler: ((
    line: string,
    images?: readonly TuiInputImageAttachment[],
    recoveredImages?: readonly ImageBlock[],
    recoveredQueueDraft?: boolean,
  ) => void) | undefined): void {
    this.#steering = handler;
    this.#scheduleRender();
  }

  setInterruptHandler(handler: (() => boolean | void) | undefined): void {
    this.#interruptHandler = handler;
  }

  setContext(context: TuiContext): void {
    if (context.threadId !== undefined && context.threadId !== this.#model.context.threadId) this.setDraftScope(context.threadId);
    this.#model.setContext(context);
    this.#syncActivityTimer();
    this.#scheduleRender();
  }

  setQueuedMessages(messages: readonly QueuedMessage[]): void {
    this.#queuedMessages = messages.slice(-100).map((message) => {
      const imageCount = message.imageCount ?? message.images?.length ?? 0;
      return {
        mode: message.mode,
        text: sanitizeTerminalText(message.text),
        ...(imageCount === 0 ? {} : { imageCount }),
      };
    });
    this.#scheduleRender();
  }

  restoreQueuedMessages(messages: readonly QueuedMessage[]): number {
    this.assertQueuedMessagesRestorable(messages);
    const restored = messages.map((message) => sanitizeTerminalText(message.text)).filter((text) => text.trim() !== "");
    const combined = [...restored, this.#editor.text].filter((text) => text.trim() !== "").join("\n\n");
    this.#editor.setText(combined);
    this.#recoveredInputImages.push(...messages.flatMap((message) =>
      (message.images ?? []).map((image) => ({ ...image }))));
    this.#recoveredQueueDraft = true;
    this.#inputMode = "normal";
    this.setQueuedMessages([]);
    return messages.length;
  }

  assertQueuedMessagesRestorable(messages: readonly QueuedMessage[]): void {
    const images = messages.flatMap((message) => message.images ?? []);
    if (messages.some((message) => message.imageCount !== undefined && message.imageCount !== (message.images?.length ?? 0))) {
      throw new Error("Queued image payload is unavailable and must remain queued");
    }
    if (this.#inputImages.length + this.#recoveredInputImages.length + images.length > 20) {
      throw new Error("Restoring this queue would exceed 20 images in one input");
    }
    const imageBytes = [
      ...this.#inputImages.map((image) => image.block),
      ...this.#recoveredInputImages,
      ...images,
    ]
      .reduce((total, image) => total + Buffer.byteLength(image.data ?? image.url ?? "", "utf8"), 0);
    if (imageBytes > 64 * 1024 * 1024) throw new Error("Restoring this queue would exceed 64 MiB of image data");
    const restored = messages.map((message) => sanitizeTerminalText(message.text)).filter((text) => text.trim() !== "");
    const combined = [...restored, this.#editor.text].filter((text) => text.trim() !== "").join("\n\n");
    if (Buffer.byteLength(combined, "utf8") > this.#limits.maxEditorBytes) {
      throw new Error("Restoring this queue would exceed the editor limit");
    }
  }

  setEditorText(value: string): void {
    this.#editor.setText(value);
    this.#rawEditors.at(-1)?.component.setText(value);
    this.#jumpDirection = undefined;
    this.#inputMode = "normal";
    this.#scheduleRender();
  }

  insertClipboardText(value: string): void {
    this.#ensureStarted();
    const raw = this.#rawEditors.at(-1)?.component;
    if (raw?.handleInput !== undefined) {
      raw.handleInput(`\u001b[200~${value}\u001b[201~`);
      this.#editor.setText(raw.getText());
    } else this.#editor.insertPaste(value);
    this.#jumpDirection = undefined;
    this.#inputMode = "normal";
    this.#scheduleRender();
  }

  getEditorText(): string {
    return this.#rawEditors.at(-1)?.component.getText() ?? this.#editor.text;
  }

  async requestInput(title: string, placeholder?: string, signal?: AbortSignal): Promise<string> {
    const cleanTitle = sanitizeTerminalText(title).replaceAll("\n", " ");
    const hint = placeholder === undefined || placeholder === ""
      ? ""
      : ` (${sanitizeTerminalText(placeholder).replaceAll("\n", " ")})`;
    return await this.question(`${cleanTitle}${hint}: `, signal);
  }

  async editor(title: string, prefill = "", signal?: AbortSignal): Promise<string> {
    this.#ensureStarted();
    if (this.#pendingQuestion !== undefined || this.#overlay !== undefined) throw new Error("Another terminal interaction is active");
    const previous = this.#editor.snapshot();
    this.#editor.setText(prefill);
    try {
      return await this.question(`${sanitizeTerminalText(title).replaceAll("\n", " ")}: `, signal);
    } finally {
      if (!this.#closed) {
        this.#editor.restore(previous);
        this.#scheduleRender();
      }
    }
  }

  attachInputImage(attachment: TuiInputImageAttachment): number {
    this.#ensureStarted();
    if (this.#inputImages.length >= 8) throw new Error("At most 8 input images may be attached to one message");
    const label = sanitizeTerminalText(attachment.label).replaceAll("\n", " ").trim();
    if (label === "" || Buffer.byteLength(label, "utf8") > 256) throw new Error("Input image label must contain 1 to 256 printable bytes");
    const key = `input-${this.#inputImages.length}-${label}`;
    const validated = validateTerminalImage({ key, block: attachment.block }, this.#inputImages.length + 1);
    const coordinates = attachment.coordinates;
    if (
      coordinates.width !== validated.widthPx
      || coordinates.height !== validated.heightPx
      || coordinates.originalWidth < coordinates.width
      || coordinates.originalHeight < coordinates.height
      || !Number.isFinite(coordinates.scaleX)
      || !Number.isFinite(coordinates.scaleY)
      || Math.abs(coordinates.scaleX - coordinates.originalWidth / coordinates.width) > 0.000_001
      || Math.abs(coordinates.scaleY - coordinates.originalHeight / coordinates.height) > 0.000_001
    ) throw new Error("Input image coordinate metadata does not match its content");
    const bytes = this.#inputImages.reduce((total, image) => total + Buffer.byteLength(image.block.data ?? "", "base64"), 0)
      + validated.bytes;
    if (bytes > 16 * 1024 * 1024) throw new Error("Input images exceed the 16 MiB attachment limit");
    this.#inputImages.push({
      block: { type: "image", mediaType: validated.mediaType, data: validated.data },
      label,
      coordinates: { ...coordinates },
    });
    this.#scheduleRender();
    return this.#inputImages.length;
  }

  clearInputImages(): void {
    if (this.#inputImages.length === 0 && this.#recoveredInputImages.length === 0) return;
    this.#inputImages = [];
    this.#recoveredInputImages = [];
    this.#recoveredQueueDraft = false;
    this.#scheduleRender();
  }

  takeSubmittedImages(): TuiInputImageAttachment[] {
    const images = this.#submittedImages.map((image) => ({
      block: { ...image.block },
      label: image.label,
      coordinates: { ...image.coordinates },
    }));
    this.#submittedImages = [];
    return images;
  }

  takeSubmittedRecoveredImages(): ImageBlock[] {
    const images = this.#submittedRecoveredImages.map((image) => ({ ...image }));
    this.#submittedRecoveredImages = [];
    return images;
  }

  takeSubmittedRecoveredQueueDraft(): boolean {
    const value = this.#submittedRecoveredQueueDraft;
    this.#submittedRecoveredQueueDraft = false;
    return value;
  }

  takePendingInputImages(): TuiInputImageAttachment[] {
    const images = this.#inputImages.map((image) => ({
      block: { ...image.block },
      label: image.label,
      coordinates: { ...image.coordinates },
    }));
    this.#inputImages = [];
    this.#scheduleRender();
    return images;
  }

  takePendingRecoveredImages(): ImageBlock[] {
    const images = this.#recoveredInputImages.map((image) => ({ ...image }));
    this.#recoveredInputImages = [];
    this.#scheduleRender();
    return images;
  }

  clearModelContext(): void {
    this.#model.clearModelContext();
    this.#scheduleRender();
  }

  setDraftScope(scope: string): void {
    if (scope === "") throw new Error("Draft scope cannot be empty");
    this.#saveDraft(this.#draftScope);
    this.#draftScope = scope;
    this.#editor.restore(this.#drafts.get(scope) ?? { text: "", cursor: 0 });
    this.#inputImages = (this.#draftImages.get(scope) ?? []).map((image) => ({
      block: { ...image.block },
      label: image.label,
      coordinates: { ...image.coordinates },
    }));
    this.#recoveredInputImages = (this.#draftRecoveredImages.get(scope) ?? []).map((image) => ({ ...image }));
    this.#recoveredQueueDraft = this.#draftRecoveredQueue.get(scope) ?? false;
    this.#jumpDirection = undefined;
    this.#scheduleRender();
  }

  setPickerItems<T>(kind: Exclude<PickerKind, "generic">, items: readonly PickerItem<T>[]): void {
    if (kind === "model") this.#modelPickerViews = undefined;
    this.#pickerSources.set(kind, items.slice(0, this.#limits.maxPickerItems) as PickerItem[]);
    if (this.#overlay?.kind === kind) {
      if (kind === "model") delete this.#overlay.modelPicker;
      this.#overlay.source = this.#pickerSources.get(kind) ?? [];
      this.#refreshOverlay();
      this.#scheduleRender();
    }
  }

  setModelPickerItems<T>(all: readonly PickerItem<T>[], scoped?: readonly PickerItem<T>[]): void {
    const views = {
      all: all.slice(0, this.#limits.maxPickerItems) as PickerItem[],
      ...(scoped === undefined ? {} : { scoped: scoped.slice(0, this.#limits.maxPickerItems) as PickerItem[] }),
    };
    this.#modelPickerViews = views;
    const source = views.scoped ?? views.all;
    this.#pickerSources.set("model", source);
    if (this.#overlay?.kind === "model") {
      const mode = views.scoped === undefined ? "all" : this.#overlay.modelPicker?.mode ?? "scoped";
      this.#overlay.modelPicker = { ...views, mode };
      this.#overlay.source = mode === "scoped" ? views.scoped ?? views.all : views.all;
      this.#refreshOverlay();
      this.#scheduleRender();
    }
  }

  addModelPickerItems<T>(all: readonly PickerItem<T>[], scoped?: readonly PickerItem<T>[]): void {
    const merge = (current: readonly PickerItem[], additions: readonly PickerItem<T>[]): PickerItem[] => {
      const items = new Map(current.map((item) => [item.id, item]));
      for (const item of additions.slice(0, this.#limits.maxPickerItems)) items.set(item.id, item as PickerItem);
      return [...items.values()]
        .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
        .slice(0, this.#limits.maxPickerItems);
    };
    const current = this.#modelPickerViews ?? { all: this.#pickerSources.get("model") ?? [] };
    const allItems = merge(current.all, all);
    const scopedItems = scoped === undefined
      ? undefined
      : merge(current.scoped ?? [], scoped);
    this.setModelPickerItems(allItems, scopedItems);
  }

  setModelPickerLoading(loading: boolean): void {
    this.#modelPickerLoading = loading;
    this.#scheduleRender();
  }

  setModelPickerEmptyMessage(message?: string): void {
    this.#modelPickerEmptyMessage = message === undefined || message.trim() === ""
      ? undefined
      : sanitizeTerminalText(message).slice(0, 1_024);
    this.#scheduleRender();
  }

  setModelCycleItems<T>(items?: readonly PickerItem<T>[]): void {
    if (items === undefined) {
      this.#modelCycleItems = undefined;
      return;
    }
    const seen = new Set<string>();
    this.#modelCycleItems = items.slice(0, this.#limits.maxPickerItems).filter((item) => {
      const value = item.value;
      if (value === null || typeof value !== "object"
        || !("provider" in value) || typeof value.provider !== "string"
        || !("model" in value) || typeof value.model !== "string") return false;
      const id = `${value.provider}\u0000${value.model}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }) as PickerItem[];
  }

  setCommandItems(items: readonly PickerItem<string>[]): void {
    this.setPickerItems("command", [...defaultCommands, ...items]);
  }

  addPickerItems<T>(kind: Exclude<PickerKind, "generic">, items: readonly PickerItem<T>[]): void {
    const merged = new Map((this.#pickerSources.get(kind) ?? []).map((item) => [item.id, item]));
    for (const item of items.slice(0, this.#limits.maxPickerItems)) merged.set(item.id, item as PickerItem);
    const values = [...merged.values()];
    if (kind === "model") values.sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
    this.setPickerItems(kind, values.slice(0, this.#limits.maxPickerItems));
  }

  openPicker(kind: Exclude<PickerKind, "generic">, title?: string, initialQuery = ""): void {
    this.#ensureStarted();
    const modelViews = kind === "model" ? this.#modelPickerViews : undefined;
    const source = modelViews?.scoped ?? modelViews?.all ?? this.#pickerSources.get(kind) ?? [];
    this.#openOverlay(kind, title ?? `${kind[0]?.toUpperCase() ?? ""}${kind.slice(1)} picker`, source);
    if (kind === "model" && modelViews !== undefined && this.#overlay?.kind === "model") {
      this.#overlay.modelPicker = { ...modelViews, mode: modelViews.scoped === undefined ? "all" : "scoped" };
    }
    if (initialQuery !== "" && this.#overlay?.kind === kind) {
      this.#overlay.query.setText(initialQuery);
      this.#refreshOverlay();
      this.#scheduleRender();
    }
  }

  toggleTool(callId?: string): boolean {
    const entries = callId === undefined
      ? this.#model.entries.filter((item) => item.kind === "tool" || item.kind === "startup")
      : this.#model.entries.filter((item) => item.callId === callId);
    const changed = this.#model.toggleTool(callId);
    if (changed) for (const entry of entries) {
      if (!this.#inlineCommittedIds.has(entry.id)) continue;
      if (entry.expanded === true) this.#inlineRevealedIds.add(entry.id);
      else this.#inlineRevealedIds.delete(entry.id);
    }
    if (changed) this.#scheduleRender();
    return changed;
  }

  toggleReasoning(): boolean {
    const entries = this.#model.entries.filter((entry) => entry.kind === "reasoning");
    const changed = this.#model.toggleReasoning();
    if (changed) for (const entry of entries) {
      if (!this.#inlineCommittedIds.has(entry.id)) continue;
      if (entry.expanded === true) this.#inlineRevealedIds.add(entry.id);
      else this.#inlineRevealedIds.delete(entry.id);
    }
    if (changed) this.#scheduleRender();
    return changed;
  }

  setTheme(name: ThemeName): void {
    const setting = normalizeThemeSetting(String(name));
    const pair = parseAutomaticThemePair(setting);
    const names = pair === undefined ? [setting] : [pair.light, pair.dark];
    for (const selected of names) {
      createTheme(
        selected,
        { color: this.capabilities.color, unicode: this.capabilities.unicode },
        this.#customThemes.get(selected),
      );
    }
    this.#themeSetting = setting;
    this.#automaticTheme = pair !== undefined;
    this.#syncTerminalColorSchemeProtocol(true);
    this.#applyTheme(resolveThemeSetting(setting, this.#terminalColorScheme), "selection");
  }

  selectedThemeSetting(): string {
    return this.#themeSetting;
  }

  #applyTheme(name: ThemeName, reason: TuiThemeChange["reason"]): void {
    const previous = this.#themeName;
    this.#themeName = name;
    const selected = createTheme(
      name,
      { color: this.capabilities.color, unicode: this.capabilities.unicode },
      this.#customThemes.get(name),
    );
    if (this.#nativeThemes.length === 0) this.#theme = selected;
    else this.#nativeThemes[0]!.previous = selected;
    this.#scheduleRender();
    this.#notifyThemeChange(previous, this.#themeName, reason);
  }

  #notifyThemeChange(previous: ThemeName, current: ThemeName, reason: TuiThemeChange["reason"]): void {
    const change: TuiThemeChange = Object.freeze({
      previous,
      current,
      available: Object.freeze(this.themeNames()),
      reason,
    });
    for (const listener of this.#themeChangeListeners) {
      try { listener(change); } catch {}
    }
  }

  setCustomThemes(themes: readonly ThemeDefinition[]): void {
    const selected = new Map<string, ThemeDefinition>();
    for (const theme of themes) selected.set(theme.name, theme);
    this.#customThemes.clear();
    for (const [name, theme] of selected) this.#customThemes.set(name, theme);
    const configured = resolveThemeSetting(this.#themeSetting, this.#terminalColorScheme);
    if (this.#themeName !== "mono") {
      this.#applyTheme(this.#customThemes.has(this.#themeName) ? this.#themeName : "mono", "catalog");
    } else if (configured !== "mono" && this.#customThemes.has(configured)) {
      this.#applyTheme(configured, "catalog");
    }
  }

  updateCustomTheme(theme: ThemeDefinition): void {
    if (!this.#customThemes.has(theme.name)) throw new Error(`Custom theme ${theme.name} is not loaded`);
    this.#customThemes.set(theme.name, theme);
    if (this.#themeName === theme.name) this.#applyTheme(theme.name, "catalog");
  }

  themeNames(): string[] {
    return ["mono", ...this.#customThemes.keys()].sort((left, right) => left.localeCompare(right));
  }

  async editExternally(operation: (text: string, signal: AbortSignal) => Promise<string> = async (text, signal) => await editTextExternally(text, {
    environment: this.#environment,
    signal,
    ...(this.#externalEditorCommand === undefined ? {} : { command: this.#externalEditorCommand }),
  })): Promise<void> {
    this.#ensureStarted();
    if (this.#externalEditing || this.#secretAbort !== undefined || this.#overlay !== undefined) return;
    this.#externalEditing = true;
    this.input.off("data", this.#onData);
    this.input.pause();
    if (this.mode === "full") {
      this.#leaveTerminalSurface();
    }
    if (this.capabilities.rawInput) this.input.setRawMode?.(false);
    try {
      const updated = await operation(this.#editor.text, this.#lifecycleAbort.signal);
      if (!this.#closed) this.#editor.setText(updated);
    } finally {
      this.#externalEditing = false;
      if (!this.#closed) {
        if (this.capabilities.rawInput) this.input.setRawMode?.(true);
        this.input.on("data", this.#onData);
        this.input.resume();
        this.#enterTerminalSurface();
        this.#renderScheduled = false;
        this.#scheduleRender();
      }
    }
  }

  /** Discards late enhanced-keyboard releases before terminal teardown or suspension. */
  async drainInput(maxMs = 1_000, idleMs = 50): Promise<void> {
    if (!Number.isSafeInteger(maxMs) || maxMs < 1 || maxMs > 5_000) throw new RangeError("Input drain maximum must be 1 to 5000 ms");
    if (!Number.isSafeInteger(idleMs) || idleMs < 1 || idleMs > maxMs) throw new RangeError("Input drain idle window is invalid");
    if (this.#closed || !this.#started) return;
    this.#stopKeyboardNegotiation();
    if (this.#escapeTimer !== undefined) clearTimeout(this.#escapeTimer);
    this.#escapeTimer = undefined;
    this.#decoder.flushPending();
    this.#decoder.takeReplies();
    this.input.off("data", this.#onData);
    let lastDataAt = Date.now();
    const discard = () => { lastDataAt = Date.now(); };
    this.input.on("data", discard);
    const deadline = Date.now() + maxMs;
    try {
      while (Date.now() < deadline && Date.now() - lastDataAt < idleMs) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(idleMs, Math.max(1, deadline - Date.now())));
          timer.unref();
        });
      }
    } finally {
      this.input.off("data", discard);
      if (this.#escapeTimer !== undefined) clearTimeout(this.#escapeTimer);
      this.#escapeTimer = undefined;
      this.#decoder.flushPending();
      this.#decoder.takeReplies();
      if (!this.#closed && !this.#suspended) this.input.on("data", this.#onData);
    }
  }

  /** Restores cooked terminal state, suspends the process group, and redraws after SIGCONT. */
  suspend(stopProcess: () => void = () => { process.kill(0, "SIGTSTP"); }): void {
    this.#ensureStarted();
    if (process.platform === "win32") throw new Error("Suspend to background is not supported on Windows");
    if (this.#suspended) return;
    this.#suspended = true;
    this.input.off("data", this.#onData);
    this.input.pause();
    this.output.off("resize", this.#onResize);
    if (this.mode === "full") this.#leaveTerminalSurface();
    if (this.capabilities.rawInput) this.input.setRawMode?.(false);
    this.#signalSource.on("SIGCONT", this.#onContinue);
    this.#suspendKeepAlive = setInterval(() => undefined, 2 ** 30);
    try {
      stopProcess();
    } catch (cause) {
      this.#resumeFromSuspend();
      throw cause;
    }
  }

  selectedThemeName(): string {
    return this.#themeName;
  }

  /** @internal Live read-only status data for trusted raw footer factories. */
  extensionStatusSnapshot(): ReadonlyMap<string, string> {
    return new Map(this.#extensionStatuses);
  }

  /** @internal Live provider count for trusted raw footer factories. */
  availableProviderCount(): number {
    return this.#model.context.availableProviderCount ?? 0;
  }

  /** @internal Immutable current theme for a trusted NativeUiHost. */
  currentThemeObject(): Theme {
    return frozenTheme(this.#theme);
  }

  /** @internal Immutable resolved theme catalog for a trusted NativeUiHost. */
  themeCatalogObjects(): readonly Theme[] {
    return Object.freeze(this.themeNames().map((name) => frozenTheme({
      ...createTheme(
        name,
        { color: this.capabilities.color, unicode: this.capabilities.unicode },
        this.#customThemes.get(name),
      ),
      name,
    })));
  }

  /** @internal Pushes a validated generation-owned resolved theme. */
  applyNativeTheme(value: Theme, signal: AbortSignal): () => void {
    signal.throwIfAborted();
    const theme = validatedNativeTheme(value, this.capabilities);
    const owner: NativeThemeOwner = {
      theme,
      previous: this.#theme,
      signal,
      onAbort: () => undefined,
    };
    const previousName = this.#theme.name;
    this.#nativeThemes.push(owner);
    this.#theme = theme;
    this.#scheduleRender();
    this.#notifyThemeChange(previousName, theme.name, "extension");
    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      signal.removeEventListener("abort", owner.onAbort);
      const index = this.#nativeThemes.indexOf(owner);
      if (index < 0) return;
      const successor = this.#nativeThemes[index + 1];
      if (successor !== undefined) successor.previous = owner.previous;
      const wasActive = index === this.#nativeThemes.length - 1;
      this.#nativeThemes.splice(index, 1);
      if (!wasActive) return;
      const previous = this.#theme.name;
      this.#theme = owner.previous;
      this.#scheduleRender();
      this.#notifyThemeChange(previous, this.#theme.name, "extension");
    };
    owner.onAbort = dispose;
    signal.addEventListener("abort", owner.onAbort, { once: true });
    if (signal.aborted) owner.onAbort();
    return dispose;
  }

  onThemeChange(listener: (change: TuiThemeChange) => void, signal?: AbortSignal): () => void {
    if (typeof listener !== "function") throw new TypeError("Theme change listener must be a function");
    signal?.throwIfAborted();
    this.#themeChangeListeners.add(listener);
    const remove = () => this.#themeChangeListeners.delete(listener);
    signal?.addEventListener("abort", remove, { once: true });
    return () => {
      signal?.removeEventListener("abort", remove);
      remove();
    };
  }

  setExtensionWorkingMessage(key: string, value?: string): void {
    if (value === undefined || value === "") this.#extensionWorkingMessages.delete(key);
    else {
      this.#extensionWorkingMessages.delete(key);
      this.#extensionWorkingMessages.set(key, sanitizeTerminalText(value).replaceAll("\n", " ").slice(0, 4_096));
    }
    this.#scheduleRender();
  }

  setExtensionWorkingVisible(key: string, visible?: boolean): void {
    if (visible === undefined) this.#extensionWorkingVisibility.delete(key);
    else {
      this.#extensionWorkingVisibility.delete(key);
      this.#extensionWorkingVisibility.set(key, visible);
    }
    this.#scheduleRender();
  }

  setExtensionStatus(key: string, value?: string): void {
    if (value === undefined || value === "") this.#extensionStatuses.delete(key);
    else this.#extensionStatuses.set(key, sanitizeTerminalText(value).replaceAll("\n", " "));
    this.#model.setContext({ extensionStatus: [...this.#extensionStatuses.values()].join(" · ") });
    this.#scheduleRender();
  }

  /** Shows one replace-in-place host status without adding a transcript row. */
  setTransientStatus(value?: string): void {
    this.#ensureStarted();
    if (this.mode === "full") {
      this.setExtensionStatus("core:transient", value);
      return;
    }
    if (value === undefined || value === "") {
      if (this.#transientStatusColumns > 0) {
        this.#write(this.capabilities.ansi
          ? "\r\u001b[2K"
          : `\r${" ".repeat(this.#transientStatusColumns)}\r`);
      }
      this.#transientStatusColumns = 0;
      return;
    }
    const width = terminalSize(this.output, this.capabilities).columns;
    const line = truncateCells(`[status] ${sanitizeTerminalText(value).replaceAll("\n", " ")}`, width - 1);
    const columns = cellWidth(line);
    const padding = Math.max(0, this.#transientStatusColumns - columns);
    this.#write(`\r${line}${" ".repeat(padding)}`);
    this.#transientStatusColumns = columns;
  }

  setExtensionWidget(key: string, value?: string): void {
    if (value === undefined || value === "") this.#extensionWidgets.delete(key);
    else this.#extensionWidgets.set(key, sanitizeTerminalText(value));
    this.#model.setContext({ widgets: [...this.#extensionWidgets.values()] });
    this.#scheduleRender();
  }

  setExtensionHeader(key: string, value?: string): void {
    if (value === undefined || value === "") this.#extensionHeaders.delete(key);
    else this.#extensionHeaders.set(key, sanitizeTerminalText(value));
    this.#model.setContext({ extensionHeaders: [...this.#extensionHeaders.values()] });
    this.#scheduleRender();
  }

  setExtensionFooter(key: string, value?: string): void {
    if (value === undefined || value === "") this.#extensionFooters.delete(key);
    else this.#extensionFooters.set(key, sanitizeTerminalText(value));
    this.#model.setContext({ extensionFooters: [...this.#extensionFooters.values()] });
    this.#scheduleRender();
  }

  setToolRenderers(binding?: RuntimeToolRendererBinding, signal?: AbortSignal): void {
    const previous = this.#toolRenderers;
    if (previous !== undefined) previous.signal.removeEventListener("abort", previous.onAbort);
    this.#toolRenderers = undefined;
    if (binding !== undefined) {
      if (signal === undefined) throw new Error("Runtime tool renderers require a generation signal");
      signal.throwIfAborted();
      const owner: ToolRendererOwner = {
        binding,
        signal,
        onAbort: () => {
          if (this.#toolRenderers !== owner) return;
          this.#toolRenderers = undefined;
          this.#scheduleRender();
        },
      };
      this.#toolRenderers = owner;
      signal.addEventListener("abort", owner.onAbort, { once: true });
      if (signal.aborted) owner.onAbort();
    }
    this.#scheduleRender();
  }

  setSessionRenderers(binding?: RuntimeSessionRendererBinding, signal?: AbortSignal): void {
    const previous = this.#sessionRenderers;
    if (previous !== undefined) previous.signal.removeEventListener("abort", previous.onAbort);
    this.#sessionRenderers = undefined;
    if (binding !== undefined) {
      if (signal === undefined) throw new Error("Runtime session renderers require a generation signal");
      signal.throwIfAborted();
      const owner: SessionRendererOwner = {
        binding,
        signal,
        onAbort: () => {
          if (this.#sessionRenderers !== owner) return;
          this.#sessionRenderers = undefined;
          this.#scheduleRender();
        },
      };
      this.#sessionRenderers = owner;
      signal.addEventListener("abort", owner.onAbort, { once: true });
      if (signal.aborted) owner.onAbort();
    }
    this.#scheduleRender();
  }

  clearExtensionUi(): void {
    this.setToolRenderers();
    this.setSessionRenderers();
    this.setEditorRenderer();
    this.setExtensionShortcuts();
    this.setCommandCompletionProvider();
    this.setAutocompleteProvider();
    this.setEditorMiddleware();
    for (const slot of PERSISTENT_COMPONENT_SLOTS) {
      for (const owner of [...this.#persistentRuntimeComponents[slot].values()]) owner.mount.close();
      this.#persistentRuntimeComponents[slot].clear();
      for (const owner of [...this.#persistentRawComponents[slot].values()]) owner.mount.close();
      this.#persistentRawComponents[slot].clear();
    }
    this.#rawRuntimeComponent?.mount.close();
    this.#rawRuntimeComponent = undefined;
    for (const owner of [...this.#rawRuntimeOverlays].reverse()) owner.mount.close();
    this.#rawRuntimeOverlays.length = 0;
    for (const owner of [...this.#rawEditors].reverse()) owner.onAbort();
    this.#clearAdvancedUiOverrides();
    for (const owner of this.#normalizedKeyObservers.values()) owner.signal.removeEventListener("abort", owner.onAbort);
    this.#normalizedKeyObservers.clear();
    this.#extensionStatuses.clear();
    this.#extensionWidgets.clear();
    this.#extensionHeaders.clear();
    this.#extensionFooters.clear();
    this.#extensionWorkingMessages.clear();
    this.#extensionWorkingVisibility.clear();
    this.#model.setContext({ extensionStatus: "", widgets: [], extensionHeaders: [], extensionFooters: [] });
    this.setTitle("Rigyn");
    this.#scheduleRender();
  }

  #clearAdvancedUiOverrides(): void {
    for (const owner of this.#workingIndicators.values()) owner.signal.removeEventListener("abort", owner.onAbort);
    this.#workingIndicators.clear();
    for (const owner of this.#hiddenReasoningLabels.values()) owner.signal.removeEventListener("abort", owner.onAbort);
    this.#hiddenReasoningLabels.clear();
    for (const owner of this.#toolOutputExpansions.values()) owner.signal.removeEventListener("abort", owner.onAbort);
    this.#toolOutputExpansions.clear();
    this.#applyToolOutputExpansion();
    this.#restartActivityTimer();
  }

  #pruneSessionEntries(): void {
    const live = new Set(this.#model.entries.flatMap((entry) => entry.extension === undefined ? [] : [entry.id]));
    for (const [entryId, retained] of this.#sessionEntries) {
      if (live.has(entryId)) continue;
      this.#sessionEntries.delete(entryId);
      this.#sessionEntryBytes -= retained.bytes;
    }
    while (
      this.#sessionEntries.size > Math.min(2_000, this.#limits.maxTranscriptEntries) ||
      this.#sessionEntryBytes > Math.min(2 * 1024 * 1024, this.#limits.maxTranscriptBytes)
    ) {
      const oldest = this.#sessionEntries.entries().next().value as [string, RetainedSessionEntry] | undefined;
      if (oldest === undefined) break;
      this.#sessionEntries.delete(oldest[0]);
      this.#sessionEntryBytes -= oldest[1].bytes;
    }
  }

  setInputBlocked(message?: string, label = "busy"): void {
    this.#inputBlocked = message === undefined ? undefined : sanitizeTerminalText(message).replaceAll("\n", " ").slice(0, 4096);
    this.#inputBlockedLabel = message === undefined
      ? "busy"
      : sanitizeTerminalText(label).replaceAll("\n", " ").trim().slice(0, 64) || "busy";
    this.#scheduleRender();
  }

  setTitle(value: string): void {
    if (!this.capabilities.ansi) return;
    const title = sanitizeTerminalText(value).replaceAll("\n", " ").slice(0, 512);
    this.#write(`\u001b]0;${title}\u0007`);
  }

  #renderToolBlocks(entries: readonly TranscriptEntry[], width: number, height: number): Map<string, ToolRenderSlots> {
    const owner = this.#toolRenderers;
    const blocks = new Map<string, ToolRenderSlots>();
    if (owner === undefined || owner.signal.aborted) return blocks;
    const context: RuntimeUiRenderContext = {
      width,
      height,
      focused: false,
      expanded: false,
      theme: {
        name: this.#theme.name,
        color: this.#theme.ansi,
        unicode: this.capabilities.unicode,
      },
    };
    for (const entry of entries) {
      if (entry.kind !== "tool" || entry.callId === undefined || entry.title === undefined) continue;
      const name = entry.title;
      if (owner.signal.aborted || this.#toolRenderers !== owner) break;
      let registered = false;
      try {
        registered = owner.binding.has(name);
      } catch {
        continue;
      }
      if (!registered) continue;
      const renderedResult = entry.toolData?.result ?? entry.toolData?.partialResult;
      const view: RuntimeToolRenderView = {
        callId: entry.callId,
        name,
        ...(entry.toolData?.input === undefined ? {} : { input: entry.toolData.input }),
        ...(renderedResult === undefined ? {} : { result: renderedResult }),
        ...(entry.images === undefined || entry.images.length === 0
          ? {}
          : { images: entry.images.map((image) => image.block) }),
        ...(entry.toolData?.result === undefined && entry.toolData?.partialResult !== undefined
          ? { isPartial: true }
          : {}),
        status: entry.status ?? "pending",
        expanded: entry.expanded === true,
      };
      const selectedContext = { ...context, expanded: view.expanded };
      const bridge = {
        theme: this.#theme,
        showImages: this.#showImages,
        invalidate: () => this.#scheduleRender(),
      };
      const invoke = (render: () => RuntimeUiBlock | undefined) => {
        if (owner.signal.aborted || this.#toolRenderers !== owner) return undefined;
        try {
          const value = render();
          if (value === undefined || owner.signal.aborted || this.#toolRenderers !== owner) return undefined;
          return sanitizeRuntimeUiBlock(value, { width });
        } catch {
          return undefined;
        }
      };
      let shell: "default" | "self" | undefined;
      try {
        shell = owner.binding.renderShell?.(name);
      } catch {}
      const call = invoke(() => owner.binding.renderCall(name, view, selectedContext, bridge));
      const result = renderedResult === undefined
        ? undefined
        : invoke(() => owner.binding.renderResult(name, view, selectedContext, bridge));
      if (shell !== undefined || call !== undefined || result !== undefined) blocks.set(entry.callId, {
        ...(shell === undefined ? {} : { shell }),
        ...(call === undefined ? {} : { call }),
        ...(result === undefined ? {} : { result }),
      });
    }
    return blocks;
  }

  #renderSessionBlocks(entries: readonly TranscriptEntry[], width: number, _height: number): Map<string, RuntimeUiBlock> {
    const owner = this.#sessionRenderers;
    const blocks = new Map<string, RuntimeUiBlock>();
    if (owner === undefined || owner.signal.aborted) return blocks;
    const theme = this.currentThemeObject();
    for (const entry of entries) {
      if (entry.extension === undefined) continue;
      const retained = this.#sessionEntries.get(entry.id);
      if (retained === undefined || owner.signal.aborted || this.#sessionRenderers !== owner) continue;
      try {
        const options = { expanded: entry.expanded === true };
        const component = retained.entry.type === "custom"
          ? owner.binding.renderEntry(retained.entry, options, theme)
          : retained.message === undefined
            ? undefined
            : owner.binding.renderMessage(retained.message, options, theme);
        if (component === undefined || owner.signal.aborted || this.#sessionRenderers !== owner) continue;
        const value: RuntimeUiBlock = {
          lines: component.render(width).map((line) => ({ spans: [{ text: line }] })),
        };
        blocks.set(entry.id, sanitizeRuntimeUiBlock(value, {
          width,
          maxLines: 2_000,
          maxBytes: 2 * 1024 * 1024,
        }));
      } catch {
        // The layout renders the data-only fallback for a failed extension renderer.
      }
    }
    return blocks;
  }

  #bindingHint(action: KeybindingAction, maximum = 2): string {
    const keys = this.#keybindings.keys(action).slice(0, maximum).map((key) => displayBinding(key, this.capabilities.unicode));
    return keys.length === 0 ? "Unbound" : keys.join(this.capabilities.unicode ? " / " : "/");
  }

  #editorViewport(): { width: number; rows: number } {
    const size = terminalSize(this.output, this.capabilities);
    const frameWidth = size.columns;
    const editorWidth = Math.max(1, frameWidth - 1 - (this.#editorPaddingX * 2));
    const label = this.#inputMode === "follow_up" ? "follow" : this.#inputLabel;
    const prefix = label === "you" ? " " : ` ${label}> `;
    return {
      width: Math.max(1, editorWidth - cellWidth(prefix)),
      rows: Math.min(6, Math.max(2, Math.floor(Math.max(8, size.rows) / 3))),
    };
  }

  #renderEditorBlock(view: RuntimeEditorRenderView, size: { columns: number; rows: number }): RuntimeUiBlock | undefined {
    const owner = this.#editorRenderer;
    if (owner === undefined || owner.signal.aborted) return undefined;
    try {
      const width = Math.max(1, size.columns - 1);
      const height = Math.min(6, Math.max(2, Math.floor(Math.max(8, size.rows) / 3)));
      const rendered = owner.binding.render(Object.freeze({ ...view }), {
        width,
        height,
        focused: true,
        expanded: false,
        theme: {
          name: this.#theme.name,
          color: this.#theme.ansi,
          unicode: this.capabilities.unicode,
        },
      });
      if (rendered === undefined) return undefined;
      const sanitized = sanitizeRuntimeUiBlock(rendered, { width, maxLines: height, maxBytes: this.#limits.maxEditorBytes });
      if (sanitized.cursor === undefined) throw new Error("Editor renderer output requires a cursor");
      return sanitized;
    } catch (cause) {
      if (!owner.warned && !owner.signal.aborted && !this.#closed) {
        owner.warned = true;
        try {
          this.notify(`Editor renderer failed: ${defaultSecretRedactor.redact(error(cause).message).slice(0, 4096)}`, "warning");
        } catch {}
      }
      return undefined;
    }
  }

  #renderPersistentComponents(size: { columns: number; rows: number }): Record<TuiPersistentComponentSlot, RuntimeUiBlock[]> {
    const blocks: Record<TuiPersistentComponentSlot, RuntimeUiBlock[]> = {
      header: [],
      footer: [],
      widget: [],
      "widget-above": [],
      "widget-below": [],
      "header-replacement": [],
      "footer-replacement": [],
    };
    const width = Math.max(1, Math.min(500, size.columns));
    const height = Math.max(1, Math.min(MAX_ADVANCED_UI_SLOT_LINES, size.rows));
    for (const slot of PERSISTENT_COMPONENT_SLOTS) {
      for (const owner of this.#persistentRuntimeComponents[slot].values()) {
        const rendered = owner.mount.render({
          width,
          height,
          focused: false,
          expanded: this.#model.toolOutputExpanded,
          theme: {
            name: this.#theme.name,
            color: this.#theme.ansi,
            unicode: this.capabilities.unicode,
          },
        }, { maxLines: height, maxBytes: MAX_ADVANCED_UI_SLOT_BYTES });
        if (rendered.ok) blocks[slot].push(rendered.block);
        else owner.mount.close();
      }
    }
    return blocks;
  }

  #renderRawPersistentComponents(size: { columns: number; rows: number }): Record<TuiPersistentComponentSlot, import("./types.js").TuiRawBlock[]> {
    const blocks: Record<TuiPersistentComponentSlot, import("./types.js").TuiRawBlock[]> = {
      header: [],
      footer: [],
      widget: [],
      "widget-above": [],
      "widget-below": [],
      "header-replacement": [],
      "footer-replacement": [],
    };
    const width = Math.max(1, Math.min(500, size.columns));
    const height = Math.max(1, Math.min(MAX_ADVANCED_UI_SLOT_LINES, size.rows));
    for (const slot of PERSISTENT_COMPONENT_SLOTS) {
      for (const owner of this.#persistentRawComponents[slot].values()) {
        if (owner.hidden) continue;
        const rendered = owner.mount.render(width, height, MAX_ADVANCED_UI_SLOT_BYTES);
        if (rendered.ok) blocks[slot].push(rendered.block);
        else owner.mount.close();
      }
    }
    return blocks;
  }

  #activeWorkingIndicator(): WorkingIndicatorOwner | undefined {
    return [...this.#workingIndicators.values()].at(-1);
  }

  #activeHiddenReasoningLabel(): HiddenReasoningLabelOwner | undefined {
    return [...this.#hiddenReasoningLabels.values()].at(-1);
  }

  renderNow(): void {
    if (!this.#started || this.#closed || this.#suspended || this.#secretAbort !== undefined || this.#externalEditing || this.mode !== "full") return;
    this.#renderScheduled = false;
    this.#terminalImages.prune(new Set(this.#model.entries.flatMap((entry) => (entry.images ?? []).map((image) => image.key))));
    const size = terminalSize(this.output, this.capabilities);
    if (!this.capabilities.alternateScreen) this.#commitInlineTranscript(size.columns, size.rows);
    const overlay = this.#overlay;
    const transcript = !this.capabilities.alternateScreen && this.#transcriptOffset === 0
      ? this.#model.entries.filter((entry) => !this.#inlineCommittedIds.has(entry.id) || this.#inlineRevealedIds.has(entry.id))
      : this.#model.entries;
    const toolRenderBlocks = this.#renderToolBlocks(transcript, size.columns, size.rows);
    const sessionRenderBlocks = this.#renderSessionBlocks(transcript, size.columns, size.rows);
    const persistentComponents = this.#renderPersistentComponents(size);
    const rawPersistentComponents = this.#renderRawPersistentComponents(size);
    const workingIndicator = this.#activeWorkingIndicator();
    const hiddenReasoning = this.#activeHiddenReasoningLabel();
    let runtimeComponent: RuntimeUiBlock | undefined;
    let rawRuntimeComponent: import("./types.js").TuiRawBlock | undefined;
    const runtimeOverlays: NonNullable<TuiViewState["runtimeOverlays"]>[number][] = [];
    const rawRuntimeOverlays: NonNullable<TuiViewState["rawRuntimeOverlays"]>[number][] = [];
    const componentOwner = this.#runtimeComponent;
    if (componentOwner !== undefined && componentOwner.options.overlay !== true && this.#runtimeOwnerVisible(componentOwner)) {
      const rendered = componentOwner.mount.render({
        width: size.columns,
        height: size.rows,
        focused: componentOwner.focused,
        expanded: false,
        theme: {
          name: this.#theme.name,
          color: this.#theme.ansi,
          unicode: this.capabilities.unicode,
        },
      }, { maxLines: size.rows });
      if (rendered.ok) runtimeComponent = rendered.block;
      else componentOwner.mount.close();
    }
    const rawComponentOwner = this.#rawRuntimeComponent;
    if (rawComponentOwner !== undefined && rawComponentOwner.options.overlay !== true && this.#rawOwnerVisible(rawComponentOwner)) {
      const rendered = rawComponentOwner.mount.render(size.columns, size.rows);
      if (rendered.ok) rawRuntimeComponent = rendered.block;
      else rawComponentOwner.mount.close();
    }
    const overlayOwners = [
      ...this.#runtimeOverlays,
      ...(componentOwner?.options.overlay === true ? [componentOwner] : []),
    ].sort((left, right) => left.focusOrder - right.focusOrder);
    for (const overlayOwner of overlayOwners) {
      const visible = this.#runtimeOwnerVisible(overlayOwner);
      if (!visible) {
        if (overlayOwner.focused && !overlayOwner.mount.closed) {
          overlayOwner.restoreWhenVisible = true;
          this.#setRuntimeFocus(this.#fallbackRuntimeOwner(overlayOwner), false);
        }
        continue;
      }
      if (overlayOwner.restoreWhenVisible && this.#runtimeOwnerCaptures(overlayOwner)) {
        this.#setRuntimeFocus(overlayOwner, false);
      }
      const overlayOptions = overlayOwner.options.overlayOptions ?? {};
      const componentWidth = resolveRuntimeWidth(
        overlayOptions,
        Math.max(1, size.columns),
        Math.min(80, Math.max(1, size.columns)),
      );
      const componentHeight = resolveRuntimeHeight(
        overlayOptions,
        Math.max(1, size.rows),
        Math.max(1, size.rows),
      );
      const rendered = overlayOwner.mount.render({
        width: componentWidth,
        height: componentHeight,
        focused: overlayOwner.focused,
        expanded: false,
        theme: {
          name: this.#theme.name,
          color: this.#theme.ansi,
          unicode: this.capabilities.unicode,
        },
      }, { maxLines: componentHeight });
      if (rendered.ok) runtimeOverlays.push({
        block: rendered.block,
        options: overlayOptions,
        focused: overlayOwner.focused,
        width: componentWidth,
      });
      else overlayOwner.mount.close();
    }
    const rawOverlayOwners = [
      ...this.#rawRuntimeOverlays,
      ...(rawComponentOwner?.options.overlay === true ? [rawComponentOwner] : []),
    ].sort((left, right) => left.focusOrder - right.focusOrder);
    for (const rawOverlayOwner of rawOverlayOwners) {
      if (!this.#rawOwnerVisible(rawOverlayOwner)) continue;
      const overlayOptions = rawOverlayOwner.options.overlayOptions ?? {};
      const componentWidth = resolveRuntimeWidth(
        overlayOptions,
        Math.max(1, size.columns),
        Math.min(80, Math.max(1, size.columns)),
      );
      const componentHeight = resolveRuntimeHeight(
        overlayOptions,
        Math.max(1, size.rows),
        Math.max(1, size.rows),
      );
      const rendered = rawOverlayOwner.mount.render(componentWidth, componentHeight);
      if (rendered.ok) rawRuntimeOverlays.push({
        block: rendered.block,
        options: overlayOptions,
        focused: rawOverlayOwner.focused,
        width: componentWidth,
      });
      else rawOverlayOwner.mount.close();
    }
    const selectionNavigation = `${this.#bindingHint("tui.select.up", 1)}/${this.#bindingHint("tui.select.down", 1)} navigate`;
    const selectionConfirm = this.#bindingHint("tui.select.confirm", 1);
    const selectionCancel = this.#bindingHint("tui.select.cancel", 1);
    const overlayView = overlay === undefined
      ? undefined
      : overlay.settings !== undefined
        ? {
            title: "Settings",
            settings: true,
            queryLabel: "> ",
            query: overlay.query.text,
            selected: overlay.selected,
            items: overlay.items,
            ...(overlay.items[overlay.selected]?.description === undefined
              ? {}
              : { selectedDescription: overlay.items[overlay.selected]!.description }),
            hints: [`${selectionNavigation} · ${selectionConfirm} next · Left previous · ${selectionCancel} close`],
            ...(overlay.settings.status === undefined ? {} : { status: overlay.settings.status }),
          }
      : overlay.tree !== undefined
        ? overlay.tree.mode === "label"
          ? {
              title: overlay.tree.target?.tree?.label === undefined ? "Add entry label" : "Edit entry label",
              queryLabel: "label> ",
              query: overlay.query.text,
              selected: 0,
              items: [],
              hints: [
                `${this.#bindingHint("tui.select.confirm", 1)} save · empty removes · ${this.#bindingHint("tui.select.cancel", 1)} cancel`,
              ],
              ...(overlay.tree.status === undefined ? {} : { status: overlay.tree.status }),
            }
          : {
              title: overlay.title,
              states: [overlay.tree.filter, overlay.tree.activeOnly ? "active path" : "all paths"],
              query: overlay.query.text,
              selected: overlay.selected,
              items: overlay.items,
              hints: [
                `${selectionConfirm} open · ${this.#bindingHint("app.tree.foldOrUp", 1)} fold · ${this.#bindingHint("app.tree.unfoldOrDown", 1)} unfold · ${selectionCancel} close`,
                `${this.#bindingHint("app.tree.togglePath", 1)} path · ${this.#bindingHint("app.message.copy", 1)} copy · ${this.#bindingHint("app.tree.editLabel", 1)} label · ${this.#bindingHint("app.tree.filter.cycleForward", 1)} filter`,
              ],
              emptyMessage: overlay.tree.activeOnly ? "No matching entries on the active path" : "No matching tree entries",
              ...(overlay.tree.status === undefined ? {} : { status: overlay.tree.status }),
            }
      : overlay.scopedModels !== undefined
        ? {
            title: "Scoped Models",
            states: [overlay.scopedModels.all ? "all enabled" : `${overlay.scopedModels.selected.size} selected`],
            query: overlay.query.text,
            selected: overlay.selected,
            items: overlay.items,
            hints: [
              `${selectionConfirm} toggle · ${this.#bindingHint("app.models.reorderUp", 1)}/${this.#bindingHint("app.models.reorderDown", 1)} order · ${this.#bindingHint("app.models.toggleProvider", 1)} provider`,
              `${this.#bindingHint("app.models.enableAll", 1)} all · ${this.#bindingHint("app.models.clearAll", 1)} none · ${this.#bindingHint("app.models.save", 1)} save · ${this.#bindingHint("tui.select.cancel", 1)} cancel`,
            ],
            emptyMessage: "No matching models",
            ...(overlay.scopedModels.status === undefined ? {} : { status: overlay.scopedModels.status }),
          }
      : overlay.kind === "model"
        ? {
            title: overlay.title,
            ...(overlay.modelPicker?.scoped === undefined ? {} : { states: [overlay.modelPicker.mode] }),
            query: overlay.query.text,
            selected: overlay.selected,
            items: overlay.items.map((item) => modelPickerDisplayItem(item, this.#model.context, this.capabilities.unicode)),
            hints: [`${selectionNavigation} · ${selectionConfirm} select · ${selectionCancel} cancel${overlay.modelPicker?.scoped === undefined ? "" : " · Tab scope"}`],
            ...(this.#modelPickerLoading ? { status: "Refreshing live available models…" } : {}),
            emptyMessage: overlay.source.length === 0
              ? this.#modelPickerLoading
                ? "Loading live available models…"
                : this.#modelPickerEmptyMessage ?? "No available models. Use /login to connect a provider."
              : "No matching models",
          }
      : overlay.session === undefined
        ? {
            title: overlay.title,
            ...(overlay.kind === "command" ? { inline: true } : {}),
            query: overlay.query.text,
            selected: overlay.selected,
            items: overlay.items,
            ...(overlay.maxVisible === undefined ? {} : { maxVisible: overlay.maxVisible }),
            ...(overlay.kind === "command" ? {} : { hints: [`${selectionNavigation} · ${selectionConfirm} select · ${selectionCancel} cancel`] }),
          }
        : overlay.session.mode === "rename"
          ? {
              title: "Rename session",
              queryLabel: "name> ",
              query: overlay.query.text,
              selected: 0,
              items: [],
              hints: [`${selectionConfirm} save · ${selectionCancel} cancel`],
              ...(overlay.session.status === undefined ? {} : { status: overlay.session.status }),
            }
          : overlay.session.mode === "confirm_delete"
            ? {
                title: "Delete session permanently",
                queryLabel: "confirm> ",
                query: "",
                selected: 0,
                items: [],
                hints: [`${selectionConfirm} delete · ${selectionCancel} cancel`],
                ...(overlay.session.status === undefined ? {} : { status: overlay.session.status }),
              }
            : {
                title: "Resume Session",
                states: [
                  overlay.session.scope === "all" ? "all workspaces" : "workspace",
                  overlay.session.namedOnly ? "named" : "all",
                  overlay.session.sort,
                  overlay.session.showPath ? "path on" : "path off",
                ],
                query: overlay.query.text,
                selected: overlay.selected,
                items: overlay.items,
                hints: [
                  `${selectionConfirm} open · ${this.#bindingHint("app.session.rename", 1)} rename · ${this.#bindingHint("app.session.delete", 1)} delete · ${selectionCancel} close`,
                  `${this.#bindingHint("app.session.toggleScope", 1)} scope · ${this.#bindingHint("app.session.toggleSort", 1)} sort · ${this.#bindingHint("app.session.toggleNamedFilter", 1)} named · ${this.#bindingHint("app.session.togglePath", 1)} paths${overlay.session.hasMore ? " · Right more" : ""}`,
                ],
                emptyMessage: overlay.query.empty
                  ? overlay.session.namedOnly
                    ? `No named sessions found. Press ${this.#bindingHint("app.session.toggleNamedFilter", 1)} to show all.`
                    : "No sessions in this workspace. Use /resume --all to search every indexed workspace."
                  : "No matching sessions",
                ...(overlay.session.status === undefined ? {} : { status: overlay.session.status }),
              };
    const workingMessage = [...this.#extensionWorkingMessages.values()].at(-1);
    const workingVisible = [...this.#extensionWorkingVisibility.values()].at(-1);
    const editorText = this.#inputBlocked ?? (overlay?.kind === "command" ? this.#commandEditorText(overlay) : this.#editor.text);
    const editorCursor = this.#inputBlocked !== undefined
      ? splitGraphemes(this.#inputBlocked).length
      : overlay?.kind === "command"
        ? splitGraphemes(this.#commandEditorText(overlay)).length
        : this.#editor.cursor;
    const editorBlock = overlay === undefined ? this.#renderEditorBlock({
      text: editorText,
      cursor: editorCursor,
      label: this.#inputBlocked === undefined ? this.#inputLabel : this.#inputBlockedLabel,
      mode: this.#inputMode,
      blocked: this.#inputBlocked !== undefined,
    }, size) : undefined;
    let rawEditorBlock: import("./types.js").TuiRawBlock | undefined;
    const rawEditorOwner = this.#rawEditors.at(-1);
    if (overlay === undefined && rawEditorOwner !== undefined && !rawEditorOwner.signal.aborted) {
      try {
        const rendered = rawEditorOwner.component.render(Math.max(1, size.columns - 1));
        if (!Array.isArray(rendered) || rendered.some((line) => typeof line !== "string")) {
          throw new TypeError("Raw editor render() must return an array of strings");
        }
        if (rendered.length > 8 || Buffer.byteLength(rendered.join("\n"), "utf8") > this.#limits.maxEditorBytes) {
          throw new RangeError("Raw editor render exceeds the editor viewport limit");
        }
        const marker = "\u001b_rigyn:c\u0007";
        let cursor: { row: number; column: number } | undefined;
        const lines = rendered.map((line, row) => {
          const index = line.indexOf(marker);
          if (index >= 0 && cursor === undefined) cursor = { row, column: cellWidth(line.slice(0, index)) };
          return line.replaceAll(marker, "");
        });
        rawEditorBlock = { lines, ...(cursor === undefined ? {} : { cursor }) };
      } catch (cause) {
        rawEditorOwner.onAbort();
        try { this.notify(`Raw editor failed: ${defaultSecretRedactor.redact(error(cause).message).slice(0, 4_096)}`, "warning"); } catch {}
      }
    }
    const view: TuiViewState = {
      context: {
        ...this.#model.context,
        ...(workingMessage === undefined ? {} : { workingMessage }),
        ...(workingVisible === undefined ? {} : { workingVisible }),
        ...(this.#model.context.activity === undefined
          ? {}
          : { activityFrame: Math.floor(Date.now() / (workingIndicator?.value.intervalMs ?? ACTIVITY_FRAME_MS)) }),
      },
      transcript,
      transcriptOffset: this.#transcriptOffset,
      editorText,
      editorCursor,
      ...(editorBlock === undefined ? {} : { editorBlock }),
      ...(rawEditorBlock === undefined ? {} : { rawEditorBlock }),
      inputLabel: this.#inputBlocked === undefined ? this.#inputLabel : this.#inputBlockedLabel,
      inputMode: this.#inputMode,
      ...(this.#queuedMessages.length === 0 ? {} : { queuedMessages: this.#queuedMessages }),
      ...(this.#inputImages.length === 0 && this.#recoveredInputImages.length === 0
        ? {}
        : {
            inputImages: [
              ...this.#inputImages.map((image) => ({
                label: image.label,
                mediaType: image.block.mediaType,
                width: image.coordinates.width,
                height: image.coordinates.height,
              })),
              ...this.#recoveredInputImages.map((image, index) => ({
                label: `recovered ${index + 1} (${image.url === undefined ? "embedded" : "URL"})`,
                mediaType: image.mediaType,
              })),
            ],
          }),
      ...(this.#model.usage === undefined ? {} : { usage: this.#model.usage }),
      ...(this.#model.notice === undefined ? {} : { notice: this.#model.notice }),
      ...(persistentComponents.header.length === 0 ? {} : { runtimeHeaderComponents: persistentComponents.header }),
      ...(persistentComponents.footer.length === 0 ? {} : { runtimeFooterComponents: persistentComponents.footer }),
      ...(persistentComponents.widget.length === 0 && persistentComponents["widget-above"].length === 0
        ? {}
        : { runtimeWidgetComponents: [...persistentComponents.widget, ...persistentComponents["widget-above"]] }),
      ...(persistentComponents["widget-below"].length === 0
        ? {}
        : { runtimeWidgetBelowComponents: persistentComponents["widget-below"] }),
      ...(persistentComponents["header-replacement"].at(-1) === undefined
        ? {}
        : { runtimeHeaderReplacement: persistentComponents["header-replacement"].at(-1)! }),
      ...(persistentComponents["footer-replacement"].at(-1) === undefined
        ? {}
        : { runtimeFooterReplacement: persistentComponents["footer-replacement"].at(-1)! }),
      ...(rawPersistentComponents.header.length === 0 ? {} : { rawHeaderComponents: rawPersistentComponents.header }),
      ...(rawPersistentComponents.footer.length === 0 ? {} : { rawFooterComponents: rawPersistentComponents.footer }),
      ...(rawPersistentComponents.widget.length === 0 && rawPersistentComponents["widget-above"].length === 0
        ? {}
        : { rawWidgetComponents: [...rawPersistentComponents.widget, ...rawPersistentComponents["widget-above"]] }),
      ...(rawPersistentComponents["widget-below"].length === 0
        ? {}
        : { rawWidgetBelowComponents: rawPersistentComponents["widget-below"] }),
      ...(rawPersistentComponents["header-replacement"].at(-1) === undefined
        ? {}
        : { rawHeaderReplacement: rawPersistentComponents["header-replacement"].at(-1)! }),
      ...(rawPersistentComponents["footer-replacement"].at(-1) === undefined
        ? {}
        : { rawFooterReplacement: rawPersistentComponents["footer-replacement"].at(-1)! }),
      ...(workingIndicator === undefined ? {} : { workingIndicator: workingIndicator.value }),
      ...(hiddenReasoning === undefined ? {} : { hiddenReasoningLabel: hiddenReasoning.value }),
      ...(overlayView === undefined ? {} : { overlay: { ...overlayView, pickerKind: overlay!.kind } }),
      ...(runtimeComponent === undefined ? {} : { runtimeComponent }),
      ...(rawRuntimeComponent === undefined ? {} : { rawRuntimeComponent }),
      ...(runtimeOverlays.length === 0 ? {} : { runtimeOverlays }),
      ...(rawRuntimeOverlays.length === 0 ? {} : { rawRuntimeOverlays }),
    };
    const frame = renderFrame(view, size, this.#theme, {
      compact: !this.capabilities.alternateScreen,
      ...(toolRenderBlocks.size === 0 ? {} : { toolRenderBlocks }),
      ...(sessionRenderBlocks.size === 0 ? {} : { sessionRenderBlocks }),
      hyperlinks: this.capabilities.hyperlinks,
      resolveImage: (image, imageLimits) => this.#terminalImages.resolve(image, {
        protocol: this.#showImages ? this.capabilities.imageProtocol : null,
        ...imageLimits,
      }),
      maxImageRows: Math.max(1, Math.min(12, Math.floor(Math.max(8, size.rows) / 2))),
      imageWidthCells: this.#imageWidthCells,
      editorPaddingX: this.#editorPaddingX,
      hideReasoningBlock: this.#hideThinkingBlock,
      outputPad: this.#outputPad,
      codeBlockIndent: this.#codeBlockIndent,
      reserveActivityRow: this.#clearOnShrink,
    });
    const update = this.#surface.render(frame, size);
    if (update.output !== "") this.#write(`${HIDE_CURSOR}${update.output}${this.#showHardwareCursor ? SHOW_CURSOR : HIDE_CURSOR}`);
  }

  close(): void {
    if (this.#closed || this.#closing) return;
    this.#closing = true;
    this.#closed = true;
    this.#lifecycleAbort.abort(new Error("Terminal closed"));
    if (this.#toolRenderers !== undefined) this.#toolRenderers.signal.removeEventListener("abort", this.#toolRenderers.onAbort);
    this.#toolRenderers = undefined;
    if (this.#sessionRenderers !== undefined) this.#sessionRenderers.signal.removeEventListener("abort", this.#sessionRenderers.onAbort);
    this.#sessionRenderers = undefined;
    if (this.#editorRenderer !== undefined) this.#editorRenderer.signal.removeEventListener("abort", this.#editorRenderer.onAbort);
    this.#editorRenderer = undefined;
    this.#sessionEntries.clear();
    this.#sessionEntryBytes = 0;
    if (this.#extensionShortcuts !== undefined) this.#extensionShortcuts.signal.removeEventListener("abort", this.#extensionShortcuts.onAbort);
    this.#extensionShortcuts = undefined;
    if (this.#commandCompletion !== undefined) this.#commandCompletion.signal.removeEventListener("abort", this.#commandCompletion.onAbort);
    this.#commandCompletion = undefined;
    this.#cancelCommandCompletion(new Error("Terminal closed"));
    if (this.#autocomplete !== undefined) this.#autocomplete.signal.removeEventListener("abort", this.#autocomplete.onAbort);
    this.#autocomplete = undefined;
    for (const owner of this.#nativeAutocomplete) owner.signal.removeEventListener("abort", owner.onAbort);
    this.#nativeAutocomplete.length = 0;
    this.#autocompleteVersion += 1;
    this.#cancelAutocomplete(new Error("Terminal closed"));
    if (this.#editorMiddleware !== undefined) this.#editorMiddleware.signal.removeEventListener("abort", this.#editorMiddleware.onAbort);
    this.#editorMiddleware = undefined;
    for (const slot of PERSISTENT_COMPONENT_SLOTS) {
      for (const owner of [...this.#persistentRuntimeComponents[slot].values()]) owner.mount.close();
      this.#persistentRuntimeComponents[slot].clear();
      for (const owner of [...this.#persistentRawComponents[slot].values()]) owner.mount.close();
      this.#persistentRawComponents[slot].clear();
    }
    for (const owner of this.#workingIndicators.values()) owner.signal.removeEventListener("abort", owner.onAbort);
    this.#workingIndicators.clear();
    for (const owner of this.#hiddenReasoningLabels.values()) owner.signal.removeEventListener("abort", owner.onAbort);
    this.#hiddenReasoningLabels.clear();
    for (const owner of this.#toolOutputExpansions.values()) owner.signal.removeEventListener("abort", owner.onAbort);
    this.#toolOutputExpansions.clear();
    this.#toolOutputExpansionBaseline = undefined;
    for (const owner of this.#normalizedKeyObservers.values()) owner.signal.removeEventListener("abort", owner.onAbort);
    this.#normalizedKeyObservers.clear();
    for (const owner of this.#nativeInputHandlers) owner.signal.removeEventListener("abort", owner.onAbort);
    this.#nativeInputHandlers.length = 0;
    for (const owner of this.#nativeThemes) owner.signal.removeEventListener("abort", owner.onAbort);
    this.#nativeThemes.length = 0;
    this.#themeChangeListeners.clear();
    this.#terminalColorSchemeListeners.clear();
    this.#terminalBackgroundListeners.clear();
    this.#terminalColorSchemeNotificationOwners.clear();
    this.#terminalColorSchemeNotificationCleanup.clear();
    this.#runtimeComponent?.mount.close();
    this.#runtimeComponent = undefined;
    for (const overlay of [...this.#runtimeOverlays].reverse()) overlay.mount.close();
    this.#runtimeOverlays.length = 0;
    this.#rawRuntimeComponent?.mount.close();
    this.#rawRuntimeComponent = undefined;
    for (const overlay of [...this.#rawRuntimeOverlays].reverse()) overlay.mount.close();
    this.#rawRuntimeOverlays.length = 0;
    this.#terminalImages.clear();
    this.#secretAbort?.abort(new Error("Terminal closed"));
    this.#saveDraft(this.#draftScope);
    for (const owner of this.#nativeEditors) owner.signal.removeEventListener("abort", owner.onAbort);
    this.#nativeEditors.length = 0;
    for (const owner of [...this.#rawEditors].reverse()) owner.onAbort();
    this.#editor = this.#baseEditor;
    if (this.#activityTimer !== undefined) clearInterval(this.#activityTimer);
    this.#activityTimer = undefined;
    if (this.#suspendKeepAlive !== undefined) clearInterval(this.#suspendKeepAlive);
    this.#suspendKeepAlive = undefined;
    this.#signalSource.off("SIGCONT", this.#onContinue);
    if (this.#escapeTimer !== undefined) clearTimeout(this.#escapeTimer);
    this.#escapeTimer = undefined;
    this.input.off("data", this.#onData);
    this.input.off("error", this.#onStreamError);
    this.input.off("end", this.#onInputEnd);
    this.input.pause();
    this.output.off("resize", this.#onResize);
    if (this.#handleSignals) {
      this.#signalSource.off("SIGINT", this.#onSignal);
      this.#signalSource.off("SIGTERM", this.#onSignal);
      this.#signalSource.off("SIGHUP", this.#onSignal);
    }
    if (this.mode === "full" && !this.#suspended) {
      try {
        this.#leaveTerminalSurface();
      } catch {}
    }
    if (this.capabilities.rawInput) {
      try {
        this.input.setRawMode?.(this.#previousRaw);
      } catch {}
    }
    this.output.off("error", this.#onStreamError);
    const closing = new Error("Terminal closed");
    this.#pendingQuestion?.cleanup();
    this.#pendingQuestion?.reject(closing);
    this.#pendingQuestion = undefined;
    this.#closeOverlay(closing);
    this.#closing = false;
  }

  #leaveInlineSurface(): void {
    this.#write(`${this.#surface.leaveInlineSurface(terminalSize(this.output, this.capabilities))}${LEAVE_INLINE}`);
  }

  #enterTerminalSurface(): void {
    if (this.mode !== "full") return;
    this.#write(this.capabilities.alternateScreen ? ENTER_SCREEN : ENTER_INLINE);
    if (!this.#showHardwareCursor) this.#write(HIDE_CURSOR);
    this.#beginKeyboardNegotiation();
    this.#syncTerminalColorSchemeProtocol(true);
  }

  #leaveTerminalSurface(): void {
    if (this.mode !== "full") return;
    this.#write(DISABLE_TERMINAL_COLOR_SCHEME);
    if (this.#escapeTimer !== undefined) clearTimeout(this.#escapeTimer);
    this.#escapeTimer = undefined;
    this.#decoder.flushPending();
    this.#decoder.takeReplies();
    this.#stopKeyboardNegotiation();
    if (this.capabilities.alternateScreen) {
      this.#surface.resetAnchor();
      this.#write(LEAVE_SCREEN);
    } else this.#leaveInlineSurface();
  }

  #beginKeyboardNegotiation(): void {
    this.#stopKeyboardNegotiation();
    this.#keyboardProtocol = "pending";
    this.#write(QUERY_KEYBOARD_PROTOCOL);
    this.#keyboardNegotiationTimer = setTimeout(() => {
      this.#keyboardNegotiationTimer = undefined;
      if (this.#keyboardProtocol !== "pending" || this.#closed) return;
      this.#keyboardProtocol = "modify-other-keys";
      this.#write(ENABLE_MODIFY_OTHER_KEYS);
    }, KEYBOARD_NEGOTIATION_MS);
    this.#keyboardNegotiationTimer.unref();
  }

  #stopKeyboardNegotiation(): void {
    if (this.#keyboardNegotiationTimer !== undefined) clearTimeout(this.#keyboardNegotiationTimer);
    this.#keyboardNegotiationTimer = undefined;
    if (this.#keyboardProtocol === "kitty") this.#write(DISABLE_KITTY_KEYBOARD);
    else if (this.#keyboardProtocol === "modify-other-keys") this.#write(DISABLE_MODIFY_OTHER_KEYS);
    this.#keyboardProtocol = "none";
  }

  #handleTerminalReplies(replies: readonly TerminalReply[]): void {
    for (const reply of replies) {
      if (reply.type === "kitty_keyboard") {
        if (this.#keyboardProtocol === "kitty" || this.#keyboardProtocol === "none") continue;
        if (this.#keyboardNegotiationTimer !== undefined) clearTimeout(this.#keyboardNegotiationTimer);
        this.#keyboardNegotiationTimer = undefined;
        if (this.#keyboardProtocol === "modify-other-keys") this.#write(DISABLE_MODIFY_OTHER_KEYS);
        this.#keyboardProtocol = "kitty";
        this.#write(ENABLE_KITTY_KEYBOARD);
      } else if (reply.type === "primary_device_attributes" && this.#keyboardProtocol === "pending") {
        if (this.#keyboardNegotiationTimer !== undefined) clearTimeout(this.#keyboardNegotiationTimer);
        this.#keyboardNegotiationTimer = undefined;
        this.#keyboardProtocol = "modify-other-keys";
        this.#write(ENABLE_MODIFY_OTHER_KEYS);
      } else if (reply.type === "color_scheme") {
        this.#applyTerminalColorScheme(reply.scheme);
      } else if (reply.type === "background_color") {
        const color = Object.freeze({ r: reply.color.red, g: reply.color.green, b: reply.color.blue });
        const listener = this.#terminalBackgroundListeners.values().next().value;
        if (listener !== undefined) try { listener(color); } catch {}
        this.#applyTerminalColorScheme(terminalColorSchemeForRgb(reply.color));
      }
    }
  }

  #applyTerminalColorScheme(scheme: TerminalColorScheme): void {
    this.#terminalColorScheme = scheme;
    for (const listener of this.#terminalColorSchemeListeners) {
      try { listener(scheme); } catch {}
    }
    if (this.#automaticTheme) {
      const selected = resolveThemeSetting(this.#themeSetting, scheme);
      if (selected !== this.#themeName) this.#applyTheme(selected, "terminal");
    }
  }

  #syncTerminalColorSchemeProtocol(query: boolean): void {
    if (!this.#started || this.#closed || this.mode !== "full") return;
    const enabled = this.#automaticTheme || this.#terminalColorSchemeNotificationOwners.size > 0;
    this.#write(enabled ? ENABLE_TERMINAL_COLOR_SCHEME : DISABLE_TERMINAL_COLOR_SCHEME);
    if (enabled && query) this.#write(`${QUERY_TERMINAL_COLOR_SCHEME}${QUERY_TERMINAL_BACKGROUND}`);
  }

  #clearInlineSurface(size: { columns: number; rows: number }): void {
    const output = this.#surface.clear(size);
    if (output !== "") this.#write(`${HIDE_CURSOR}${output}`);
  }

  #commitInlineTranscript(columns: number, rows: number): void {
    const liveIds = new Set(this.#model.entries.map((entry) => entry.id));
    for (const id of this.#inlineCommittedIds) {
      if (!liveIds.has(id)) this.#inlineCommittedIds.delete(id);
    }
    for (const id of this.#inlineRevealedIds) {
      if (!liveIds.has(id)) this.#inlineRevealedIds.delete(id);
    }
    const entries = this.#model.committableEntries().filter((entry) => !this.#inlineCommittedIds.has(entry.id));
    if (entries.length === 0) return;
    const toolRenderBlocks = this.#renderToolBlocks(entries, columns, rows);
    const sessionRenderBlocks = this.#renderSessionBlocks(entries, columns, rows);
    const hiddenReasoning = this.#activeHiddenReasoningLabel();
    const rendered = renderTranscriptFrame(entries, columns, this.#theme, {
      ...(toolRenderBlocks.size === 0 ? {} : { toolRenderBlocks }),
      ...(sessionRenderBlocks.size === 0 ? {} : { sessionRenderBlocks }),
      semanticZones: this.#semanticZones,
      hyperlinks: this.capabilities.hyperlinks,
      resolveImage: (image, imageLimits) => this.#terminalImages.resolve(image, {
        protocol: this.#showImages ? this.capabilities.imageProtocol : null,
        ...imageLimits,
      }),
      maxImageRows: Math.max(1, Math.min(12, Math.floor(Math.max(8, rows) / 2))),
      ...(hiddenReasoning === undefined ? {} : { hiddenReasoningLabel: hiddenReasoning.value }),
      hideReasoningBlock: this.#hideThinkingBlock,
      outputPad: this.#outputPad,
      codeBlockIndent: this.#codeBlockIndent,
      imageWidthCells: this.#imageWidthCells,
    });
    if (rendered.text === "") return;
    this.#clearInlineSurface({ columns, rows });
    this.#write(`${composeTerminalImageOutput(rendered.text, rendered.images, this.capabilities.imageProtocol)}\n`);
    for (const entry of entries) this.#inlineCommittedIds.add(entry.id);
  }

  #ensureStarted(): void {
    if (!this.#started) this.start();
    if (this.#closed) throw new Error("TUI is closed");
  }

  #resumeFromSuspend(): void {
    if (!this.#suspended || this.#closed) return;
    this.#signalSource.off("SIGCONT", this.#onContinue);
    if (this.#suspendKeepAlive !== undefined) clearInterval(this.#suspendKeepAlive);
    this.#suspendKeepAlive = undefined;
    this.#suspended = false;
    if (this.capabilities.rawInput) this.input.setRawMode?.(true);
    this.input.on("data", this.#onData);
    this.output.on("resize", this.#onResize);
    this.input.resume();
    this.#surface.resetAnchor();
    this.#enterTerminalSurface();
    this.#renderScheduled = false;
    this.#syncActivityTimer();
    this.#scheduleRender();
  }

  #scheduleRender(): void {
    if (this.mode !== "full" || !this.#started || this.#closed || this.#suspended || this.#secretAbort !== undefined || this.#externalEditing || this.#renderScheduled) return;
    this.#renderScheduled = true;
    queueMicrotask(() => {
      try {
        this.renderNow();
      } catch (cause) {
        this.#fail(error(cause));
      }
    });
  }

  #syncActivityTimer(): void {
    const active = this.mode === "full" && this.#model.context.active === true && this.#model.context.activity !== undefined;
    if (!active) {
      if (this.#activityTimer !== undefined) clearInterval(this.#activityTimer);
      this.#activityTimer = undefined;
      return;
    }
    const interval = this.#activeWorkingIndicator()?.value.intervalMs ?? ACTIVITY_FRAME_MS;
    if (this.#activityTimer !== undefined && this.#activityTimerInterval === interval) return;
    if (this.#activityTimer !== undefined) clearInterval(this.#activityTimer);
    this.#activityTimerInterval = interval;
    this.#activityTimer = setInterval(() => this.#scheduleRender(), interval);
    this.#activityTimer.unref();
  }

  #restartActivityTimer(): void {
    if (this.#activityTimer !== undefined) clearInterval(this.#activityTimer);
    this.#activityTimer = undefined;
    this.#activityTimerInterval = this.#activeWorkingIndicator()?.value.intervalMs ?? ACTIVITY_FRAME_MS;
    this.#syncActivityTimer();
  }

  #scheduleEscape(): void {
    if (!this.#decoder.pendingEscape && !this.#decoder.pendingSequence) {
      if (this.#escapeTimer !== undefined) clearTimeout(this.#escapeTimer);
      this.#escapeTimer = undefined;
      return;
    }
    if (this.#escapeTimer !== undefined) clearTimeout(this.#escapeTimer);
    this.#escapeTimer = setTimeout(() => {
      this.#escapeTimer = undefined;
      this.#handleKeys(this.#decoder.flushPending());
    }, this.#decoder.pendingEscape ? 25 : KEYBOARD_NEGOTIATION_MS);
    this.#escapeTimer.unref();
  }

  #notifyNormalizedKeyObservers(event: KeyEvent): void {
    if (this.#normalizedKeyObservers.size === 0) return;
    const selected = runtimeUiKeyEvent(event);
    for (const owner of [...this.#normalizedKeyObservers.values()]) {
      if (owner.signal.aborted) {
        owner.onAbort();
        continue;
      }
      try {
        owner.observer(selected);
      } catch (cause) {
        owner.signal.removeEventListener("abort", owner.onAbort);
        if (this.#normalizedKeyObservers.get(owner.key) === owner) this.#normalizedKeyObservers.delete(owner.key);
        try {
          this.notify(`Normalized key observer failed: ${defaultSecretRedactor.redact(error(cause).message).slice(0, 4_096)}`, "warning");
        } catch {}
      }
    }
  }

  #applyUnsafeTerminalInputHandlers(chunk: Buffer | string): Buffer | string | undefined {
    if (this.#unsafeTerminalInputHandlers.length === 0) return chunk;
    let selected = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let rewritten = false;
    for (const owner of [...this.#unsafeTerminalInputHandlers]) {
      if (owner.signal.aborted) {
        owner.onAbort();
        continue;
      }
      try {
        const decision: UnsafeTerminalInputResult | void = owner.handler(selected, owner.signal);
        if (owner.signal.aborted || !this.#unsafeTerminalInputHandlers.includes(owner)) continue;
        if (decision === undefined) continue;
        if (decision === null || typeof decision !== "object" || Array.isArray(decision)) {
          throw new TypeError("Unsafe terminal input handler returned an invalid result");
        }
        if (decision.consume !== undefined && typeof decision.consume !== "boolean") {
          throw new TypeError("Unsafe terminal input consume must be boolean");
        }
        if (decision.data !== undefined) {
          if (typeof decision.data !== "string" || Buffer.byteLength(decision.data, "utf8") > 1024 * 1024) {
            throw new TypeError("Unsafe terminal input rewrite must be a string no larger than 1 MiB");
          }
          selected = decision.data;
          rewritten = true;
        }
        if (decision.consume === true) return undefined;
      } catch (cause) {
        owner.onAbort();
        try {
          this.notify(`Unsafe terminal input handler failed: ${defaultSecretRedactor.redact(error(cause).message).slice(0, 4_096)}`, "warning");
        } catch {}
      }
    }
    return rewritten ? selected : chunk;
  }

  #applyRawComponentInput(chunk: Buffer | string): Buffer | string | undefined {
    const data = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let owner = this.#focusedRawOwner();
    if (owner !== null && !this.#rawOwnerVisible(owner)) {
      if (!owner.mount.closed) owner.restoreWhenVisible = true;
      this.#setRawFocus(this.#fallbackRawOwner(owner), false);
      owner = this.#focusedRawOwner();
    }
    if (owner !== null && owner.mount.handleInput(data)) {
      this.#scheduleRender();
      return undefined;
    }
    const editor = this.#rawEditors.at(-1);
    if (editor === undefined || editor.signal.aborted || this.#overlay !== undefined
      || this.#runtimeComponent !== undefined || this.#rawRuntimeComponent !== undefined
      || this.#inputBlocked !== undefined || editor.component.handleInput === undefined) return chunk;
    try {
      editor.component.handleInput(data);
      this.#editor.setText(editor.component.getText());
      this.#scheduleRender();
      return undefined;
    } catch (cause) {
      editor.onAbort();
      try { this.notify(`Raw editor failed: ${defaultSecretRedactor.redact(error(cause).message).slice(0, 4_096)}`, "warning"); } catch {}
      return chunk;
    }
  }

  #applyNativeInputHandlers(event: KeyEvent): KeyEvent | undefined {
    let selected = nativeKeyEvent(event, this.#limits.maxEditorBytes);
    for (const owner of [...this.#nativeInputHandlers]) {
      if (owner.signal.aborted) {
        owner.onAbort();
        continue;
      }
      try {
        const decision: NativeUiInputResult | void = owner.handler(selected, owner.signal);
        if (owner.signal.aborted || !this.#nativeInputHandlers.includes(owner)) continue;
        if (decision === undefined || decision.action === "pass") continue;
        if (decision.action === "consume") return undefined;
        if (decision.action !== "rewrite") throw new TypeError("Native input handler returned an invalid action");
        selected = nativeKeyEvent(decision.event, this.#limits.maxEditorBytes);
      } catch (cause) {
        owner.onAbort();
        try {
          this.notify(`Native input handler failed: ${defaultSecretRedactor.redact(error(cause).message).slice(0, 4_096)}`, "warning");
        } catch {}
      }
    }
    return selected;
  }

  #handleKeys(events: readonly KeyEvent[]): void {
    for (const decoded of events) {
      const event = this.#applyNativeInputHandlers(decoded);
      if (event === undefined) continue;
      this.#notifyNormalizedKeyObservers(event);
      this.#cancelCommandCompletion(new Error("Terminal input changed"));
      this.#cancelAutocomplete(new Error("Terminal input changed"));
      let owner = this.#focusedRuntimeOwner();
      if (owner !== null && !this.#runtimeOwnerVisible(owner)) {
        if (!owner.mount.closed) owner.restoreWhenVisible = true;
        this.#setRuntimeFocus(this.#fallbackRuntimeOwner(owner), false);
        owner = this.#focusedRuntimeOwner();
      }
      const restorable = this.#runtimeOwners()
        .filter((candidate) => candidate.restoreWhenVisible && this.#runtimeOwnerCaptures(candidate) && this.#runtimeOwnerVisible(candidate))
        .sort((left, right) => right.focusOrder - left.focusOrder)[0];
      if (restorable !== undefined) {
        this.#setRuntimeFocus(restorable, false);
        owner = restorable;
      }
      if (owner !== null) {
        const handled = owner.mount.handleKey(event);
        if (!handled && (event.key === "escape" || (event.ctrl && event.key === "c"))) owner.mount.close();
        continue;
      }
      if (
        this.#inputBlocked === undefined
        && this.#pendingQuestion?.cancelable === true
        && this.#overlay === undefined
        && this.#keybindings.matches("tui.select.cancel", event)
      ) {
        const pending = this.#pendingQuestion;
        pending.cleanup();
        this.#pendingQuestion = undefined;
        this.#inputLabel = pending.previousInputLabel;
        this.#editor.clear({ recordUndo: false });
        this.#saveDraft(this.#draftScope);
        pending.reject(new TuiSelectionCancelledError());
        continue;
      }
      if (this.#overlay !== undefined && this.#keybindings.matches("tui.select.cancel", event)) {
        this.#handleOverlayKey(event);
        continue;
      }
      if (this.#interruptHandler !== undefined && this.#keybindings.matches("app.interrupt", event)) {
        if (this.#interruptHandler() !== false) continue;
      }
      if (this.#overlay !== undefined) this.#handleOverlayKey(event);
      else {
        const shortcutOwner = this.#extensionShortcuts;
        const selected = shortcutOwner?.shortcuts.get(keybindingForEvent(event));
        if (shortcutOwner !== undefined && selected !== undefined && !shortcutOwner.signal.aborted) {
          this.#emit({ type: "extension_shortcut", shortcut: selected.shortcut, generation: shortcutOwner.signal });
        } else if (!this.#applyEditorMiddleware(event)) this.#handleEditorKey(event);
      }
    }
    this.#scheduleRender();
  }

  #handleOverlayKey(event: KeyEvent): void {
    const overlay = this.#overlay;
    if (overlay === undefined) return;
    const sessionQuery = overlay.session?.mode === "list" ? overlay.query.text : undefined;
    if (overlay.settings !== undefined && this.#handleSettingsOverlayKey(overlay, event)) return;
    if (overlay.tree !== undefined && this.#handleTreeOverlayKey(overlay, event)) return;
    if (overlay.scopedModels !== undefined && this.#handleScopedModelOverlayKey(overlay, event)) return;
    if (overlay.session !== undefined && this.#handleSessionOverlayKey(overlay, event)) return;
    if (overlay.modelPicker?.scoped !== undefined && !event.ctrl && !event.alt && !event.shift && event.key === "tab") {
      overlay.modelPicker.mode = overlay.modelPicker.mode === "scoped" ? "all" : "scoped";
      overlay.source = overlay.modelPicker.mode === "scoped" ? overlay.modelPicker.scoped : overlay.modelPicker.all;
      overlay.selected = 0;
      this.#refreshOverlay();
      return;
    }
    if (this.#keybindings.matches("tui.select.cancel", event)) {
      this.#closeOverlay(new TuiSelectionCancelledError());
      return;
    }
    if (event.key === "text" || event.key === "paste") {
      overlay.query.insert(event.text ?? "");
      if (this.#promoteCommandWithArguments()) return;
    }
    else if (event.key === "backspace") {
      if (overlay.kind === "command" && overlay.query.empty) {
        this.#closeOverlay(new TuiSelectionCancelledError());
        return;
      }
      overlay.query.backspace();
    }
    else if (event.key === "delete") overlay.query.deleteForward();
    else if (event.ctrl && event.key === "u") overlay.query.deleteToLineStart();
    else if (this.#keybindings.matches("tui.select.up", event)) {
      overlay.selected = overlay.kind === "model" && overlay.items.length > 0
        ? (overlay.selected - 1 + overlay.items.length) % overlay.items.length
        : Math.max(0, overlay.selected - 1);
      return;
    } else if (this.#keybindings.matches("tui.select.down", event)) {
      overlay.selected = overlay.kind === "model" && overlay.items.length > 0
        ? (overlay.selected + 1) % overlay.items.length
        : Math.min(Math.max(0, overlay.items.length - 1), overlay.selected + 1);
      return;
    } else if (this.#keybindings.matches("tui.select.pageUp", event)) {
      overlay.selected = Math.max(0, overlay.selected - 10);
      return;
    } else if (this.#keybindings.matches("tui.select.pageDown", event)) {
      overlay.selected = Math.min(Math.max(0, overlay.items.length - 1), overlay.selected + 10);
      return;
    } else if (this.#keybindings.matches("tui.select.confirm", event) || (event.key === "newline" && this.mode !== "full")) {
      if (overlay.kind === "command" && overlay.query.text.trim() !== "") {
        const query = overlay.query.text.trim();
        const selected = overlay.items[overlay.selected];
        const exact = typeof selected?.value === "string" && selected.value === `/${query}`;
        const builtin = interactiveCommand(query.split(/\s/u, 1)[0] ?? "") !== undefined;
        if (overlay.items.length === 0 || exact || builtin) this.#submitCommandQuery();
        else this.#selectOverlay();
      } else this.#selectOverlay();
      return;
    } else return;
    this.#refreshOverlay();
    if (sessionQuery !== undefined && sessionQuery !== overlay.query.text && overlay.session !== undefined) {
      overlay.session.loadingMore = false;
      overlay.session.status = overlay.query.empty ? "Loading recent sessions…" : "Searching the full session catalog…";
      this.#emit({ type: "session_search", scope: overlay.session.scope, query: overlay.query.text });
    }
  }

  #handleSettingsOverlayKey(overlay: Overlay, event: KeyEvent): boolean {
    const settings = overlay.settings;
    if (settings === undefined) return false;
    if (this.#keybindings.matches("tui.select.cancel", event)) {
      this.#closeOverlay(new TuiSelectionCancelledError());
      return true;
    }
    if (this.#keybindings.matches("tui.select.up", event)) {
      overlay.selected = Math.max(0, overlay.selected - 1);
      return true;
    }
    if (this.#keybindings.matches("tui.select.down", event)) {
      overlay.selected = Math.min(Math.max(0, overlay.items.length - 1), overlay.selected + 1);
      return true;
    }
    if (this.#keybindings.matches("tui.select.pageUp", event)) {
      overlay.selected = Math.max(0, overlay.selected - 10);
      return true;
    }
    if (this.#keybindings.matches("tui.select.pageDown", event)) {
      overlay.selected = Math.min(Math.max(0, overlay.items.length - 1), overlay.selected + 10);
      return true;
    }
    const backwards = !event.ctrl && !event.alt && !event.shift && event.key === "left";
    const forwards = this.#keybindings.matches("tui.select.confirm", event)
      || (!event.ctrl && !event.alt && !event.shift && (event.key === "right" || (event.key === "text" && event.text === " ")));
    if (backwards || forwards) {
      if (settings.busy) return true;
      const selected = overlay.items[overlay.selected] as PickerItem<TuiSettingItem> | undefined;
      const item = selected?.value;
      if (selected === undefined || item === undefined || typeof item !== "object" || !Array.isArray(item.values)) return true;
      const index = item.values.indexOf(item.value);
      const nextIndex = (Math.max(0, index) + (backwards ? item.values.length - 1 : 1)) % item.values.length;
      const next = item.values[nextIndex]!;
      const updated: TuiSettingItem = { ...item, value: next, values: [...item.values] };
      const replace = (source: PickerItem[]): void => {
        const at = source.findIndex((candidate) => candidate.id === selected.id);
        if (at >= 0) source[at] = settingPickerItem(updated);
      };
      replace(overlay.source);
      replace(overlay.items);
      try {
        const pending = settings.onChange({ ...item, values: [...item.values] }, next);
        if (pending !== undefined && typeof (pending as PromiseLike<void>).then === "function") {
          settings.busy = true;
          settings.status = `Saving ${item.label}...`;
          void Promise.resolve(pending).then(() => {
            if (this.#overlay !== overlay || overlay.settings !== settings) return;
            settings.busy = false;
            delete settings.status;
            this.#scheduleRender();
          }, (cause: unknown) => {
            if (this.#overlay !== overlay || overlay.settings !== settings) return;
            settings.busy = false;
            settings.status = `Could not save ${item.label}: ${cause instanceof Error ? cause.message : String(cause)}`;
            const restore = (source: PickerItem[]): void => {
              const at = source.findIndex((candidate) => candidate.id === selected.id);
              if (at >= 0) source[at] = settingPickerItem(item);
            };
            restore(overlay.source);
            restore(overlay.items);
            this.#scheduleRender();
          });
        }
      } catch (cause) {
        settings.status = `Could not save ${item.label}: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
      this.#refreshOverlay();
      return true;
    }
    if (event.key === "text" || event.key === "paste") overlay.query.insert(event.text ?? "");
    else if (event.key === "backspace") overlay.query.backspace();
    else if (event.key === "delete") overlay.query.deleteForward();
    else if (event.ctrl && event.key === "u") overlay.query.deleteToLineStart();
    else return true;
    this.#refreshOverlay();
    return true;
  }

  #handleTreeOverlayKey(overlay: Overlay, event: KeyEvent): boolean {
    const tree = overlay.tree;
    if (tree === undefined) return false;

    const restoreList = (status?: string): void => {
      tree.mode = "list";
      overlay.query.restore(tree.listQuery ?? { text: "", cursor: 0 });
      delete tree.listQuery;
      delete tree.target;
      if (status === undefined) delete tree.status;
      else tree.status = status;
      this.#refreshOverlay();
    };

    if (tree.mode === "label") {
      if (tree.busy === true) return true;
      if (this.#keybindings.matches("tui.select.cancel", event)) {
        restoreList();
        return true;
      }
      if (this.#keybindings.matches("tui.select.confirm", event)) {
        const target = tree.target?.tree;
        if (target === undefined || tree.onLabelChange === undefined) {
          tree.status = "Label editing is unavailable";
          return true;
        }
        const label = overlay.query.text.trim() || undefined;
        try {
          const applyChanged = (changed: { label?: string; labelTimestamp?: string }): void => {
            const source = overlay.source.find((item) => item.tree?.eventId === target.eventId);
            if (source?.tree !== undefined) {
              const metadata: SessionTreeMetadata = { ...source.tree };
              if (changed.label === undefined) {
                delete metadata.label;
                delete metadata.labelTimestamp;
              } else {
                metadata.label = changed.label;
                if (changed.labelTimestamp === undefined) delete metadata.labelTimestamp;
                else metadata.labelTimestamp = changed.labelTimestamp;
              }
              source.tree = metadata;
            }
            restoreList(changed.label === undefined ? `Removed label from ${target.eventId}` : `Labeled ${target.eventId}: ${changed.label}`);
          };
          const pending = tree.onLabelChange(target.eventId, label);
          if (pending !== null && typeof pending === "object" && typeof (pending as PromiseLike<unknown>).then === "function") {
            tree.busy = true;
            tree.status = "Saving label…";
            void Promise.resolve(pending).then((changed) => {
              if (this.#overlay !== overlay || overlay.tree !== tree) return;
              tree.busy = false;
              applyChanged(changed);
              this.#scheduleRender();
            }, (cause: unknown) => {
              if (this.#overlay !== overlay || overlay.tree !== tree) return;
              tree.busy = false;
              tree.status = error(cause).message;
              this.#scheduleRender();
            });
          } else applyChanged(pending as { label?: string; labelTimestamp?: string });
        } catch (cause) {
          tree.status = error(cause).message;
        }
        return true;
      }
      if (event.key === "text" || event.key === "paste") overlay.query.insert(event.text ?? "");
      else if (event.key === "backspace") overlay.query.backspace();
      else if (event.key === "delete") overlay.query.deleteForward();
      else if (event.ctrl && event.key === "u") overlay.query.deleteToLineStart();
      return true;
    }

    if (this.#keybindings.matches("app.message.copy", event)) {
      const selected = overlay.items[overlay.selected];
      if (selected === undefined) tree.status = "No tree entry is selected";
      else {
        const value = selected.value;
        const text = value !== null && typeof value === "object" && "text" in value && typeof value.text === "string"
          ? value.text
          : selected.label;
        this.#emit({ type: "copy_text", text, label: "selected tree entry" });
        tree.status = "Copying selected tree entry…";
      }
      return true;
    }

    if (this.#keybindings.matches("tui.select.cancel", event)) {
      this.#closeOverlay(new TuiSelectionCancelledError());
      return true;
    }
    if (this.#keybindings.matches("app.tree.editLabel", event)) {
      const selected = overlay.items[overlay.selected];
      const source = selected?.tree === undefined
        ? undefined
        : overlay.source.find((item) => item.tree?.eventId === selected.tree?.eventId);
      if (source?.tree === undefined || tree.onLabelChange === undefined) {
        tree.status = "No editable entry is selected";
        return true;
      }
      tree.mode = "label";
      tree.target = source;
      tree.listQuery = overlay.query.snapshot();
      delete tree.status;
      overlay.query.setText(source.tree.label ?? "");
      return true;
    }
    if (this.#keybindings.matches("app.tree.toggleLabelTimestamp", event)) {
      tree.showLabelTimestamps = !tree.showLabelTimestamps;
      tree.status = tree.showLabelTimestamps ? "Label timestamps shown" : "Label timestamps hidden";
      this.#refreshOverlay();
      return true;
    }
    const directFilters: ReadonlyArray<readonly [KeybindingAction, SessionTreeFilterMode]> = [
      ["app.tree.filter.default", "default"],
      ["app.tree.filter.noTools", "no-tools"],
      ["app.tree.filter.userOnly", "user-only"],
      ["app.tree.filter.labeledOnly", "labeled-only"],
      ["app.tree.filter.all", "all"],
    ];
    const directFilter = directFilters.find(([action]) => this.#keybindings.matches(action, event));
    const cycleForward = this.#keybindings.matches("app.tree.filter.cycleForward", event);
    const cycleBackward = this.#keybindings.matches("app.tree.filter.cycleBackward", event);
    if (directFilter !== undefined || cycleForward || cycleBackward) {
      if (directFilter !== undefined) tree.filter = directFilter[1];
      else {
        const index = SESSION_TREE_FILTER_MODES.indexOf(tree.filter);
        const direction = cycleBackward ? -1 : 1;
        tree.filter = SESSION_TREE_FILTER_MODES[(index + direction + SESSION_TREE_FILTER_MODES.length) % SESSION_TREE_FILTER_MODES.length]!;
      }
      tree.folded.clear();
      tree.status = `Filter: ${tree.filter}`;
      this.#refreshOverlay();
      return true;
    }
    if (this.#keybindings.matches("app.tree.togglePath", event)) {
      tree.activeOnly = !tree.activeOnly;
      tree.status = tree.activeOnly ? "Showing the active path" : "Showing every branch";
      this.#refreshOverlay();
      return true;
    }
    if (this.#keybindings.matches("app.tree.foldOrUp", event)) {
      const selected = overlay.items[overlay.selected];
      const next = overlay.items[overlay.selected + 1];
      if (selected?.tree !== undefined && next?.tree !== undefined && next.tree.depth > selected.tree.depth) {
        tree.folded.add(selected.tree.eventId);
        tree.status = `Folded ${selected.tree.eventId}`;
        this.#refreshOverlay();
      } else {
        overlay.selected = sessionTreeEndpointIndex(overlay.items, overlay.selected, "previous");
        const endpoint = overlay.items[overlay.selected]?.tree;
        tree.status = endpoint === undefined ? "No branch endpoint is visible" : `Endpoint: ${endpoint.branches.join(", ")}`;
      }
      return true;
    }
    if (this.#keybindings.matches("app.tree.unfoldOrDown", event)) {
      const selected = overlay.items[overlay.selected];
      if (selected?.tree !== undefined && tree.folded.delete(selected.tree.eventId)) {
        tree.status = `Unfolded ${selected.tree.eventId}`;
        this.#refreshOverlay();
      } else {
        overlay.selected = sessionTreeEndpointIndex(overlay.items, overlay.selected, "next");
        const endpoint = overlay.items[overlay.selected]?.tree;
        tree.status = endpoint === undefined ? "No branch endpoint is visible" : `Endpoint: ${endpoint.branches.join(", ")}`;
      }
      return true;
    }
    if (this.#keybindings.matches("tui.select.up", event)) {
      overlay.selected = overlay.items.length === 0 ? 0 : (overlay.selected - 1 + overlay.items.length) % overlay.items.length;
      return true;
    }
    if (this.#keybindings.matches("tui.select.down", event)) {
      overlay.selected = overlay.items.length === 0 ? 0 : (overlay.selected + 1) % overlay.items.length;
      return true;
    }
    if ((!event.ctrl && !event.alt && event.key === "left") || this.#keybindings.matches("tui.select.pageUp", event)) {
      overlay.selected = Math.max(0, overlay.selected - 10);
      return true;
    }
    if ((!event.ctrl && !event.alt && event.key === "right") || this.#keybindings.matches("tui.select.pageDown", event)) {
      overlay.selected = Math.min(Math.max(0, overlay.items.length - 1), overlay.selected + 10);
      return true;
    }
    if (this.#keybindings.matches("tui.select.confirm", event)) {
      this.#selectOverlay();
      return true;
    }
    if (event.key === "text" || event.key === "paste") overlay.query.insert(event.text ?? "");
    else if (event.key === "backspace") overlay.query.backspace();
    else if (event.key === "delete") overlay.query.deleteForward();
    else if (event.ctrl && event.key === "u") overlay.query.deleteToLineStart();
    else return true;
    tree.folded.clear();
    delete tree.status;
    this.#refreshOverlay();
    return true;
  }

  #handleScopedModelOverlayKey(overlay: Overlay, event: KeyEvent): boolean {
    const scoped = overlay.scopedModels;
    if (scoped === undefined) return false;
    const reorderUp = this.#keybindings.matches("app.models.reorderUp", event);
    const reorderDown = this.#keybindings.matches("app.models.reorderDown", event);
    if (reorderUp || reorderDown) {
      const item = overlay.items[overlay.selected];
      const pattern = item === undefined ? undefined : this.#scopedModelPattern(item);
      if (scoped.all) scoped.status = "Choose an explicit model set before reordering";
      else if (pattern === undefined || !scoped.selected.has(pattern)) scoped.status = "Enable a model before reordering it";
      else {
        const index = scoped.order.indexOf(pattern);
        const target = index + (reorderUp ? -1 : 1);
        if (index < 0) scoped.status = "The selected model has no cycle position";
        else if (target < 0 || target >= scoped.order.length) scoped.status = `${pattern} is already ${reorderUp ? "first" : "last"}`;
        else {
          [scoped.order[index], scoped.order[target]] = [scoped.order[target]!, scoped.order[index]!];
          scoped.status = `Moved ${pattern} ${reorderUp ? "up" : "down"}`;
          this.#scopedModelsChanged(scoped);
          this.#refreshOverlay();
        }
      }
      return true;
    }
    if (this.#keybindings.matches("app.models.save", event)) {
      this.#saveScopedModels(overlay);
      return true;
    }
    if (this.#keybindings.matches("app.models.enableAll", event)) {
      scoped.all = true;
      scoped.selected.clear();
      scoped.order = [];
      scoped.status = "All available and future models enabled";
      this.#scopedModelsChanged(scoped);
      this.#refreshOverlay();
      return true;
    }
    if (this.#keybindings.matches("app.models.clearAll", event)) {
      scoped.all = false;
      scoped.selected.clear();
      scoped.order = [];
      scoped.status = "All models cleared";
      this.#scopedModelsChanged(scoped);
      this.#refreshOverlay();
      return true;
    }
    if (this.#keybindings.matches("app.models.toggleProvider", event)) {
      const item = overlay.items[overlay.selected];
      const value = item === undefined ? undefined : this.#scopedModelPattern(item);
      if (item === undefined || value === undefined) {
        scoped.status = "Select a model row before toggling its provider";
        return true;
      }
      if (scoped.all) this.#materializeScopedModels(scoped);
      const provider = (item.value as ScopedModelOption).provider;
      const patterns = scoped.source
        .filter((candidate) => candidate.value.provider === provider)
        .map((candidate) => `${candidate.value.provider}/${candidate.value.model}`);
      const selected = patterns.every((pattern) => scoped.selected.has(pattern));
      for (const pattern of patterns) {
        if (selected) scoped.selected.delete(pattern);
        else if (!scoped.selected.has(pattern)) {
          scoped.selected.add(pattern);
          scoped.order.push(pattern);
        }
      }
      if (selected) scoped.order = scoped.order.filter((pattern) => scoped.selected.has(pattern));
      scoped.status = `${provider}: ${selected ? "cleared" : "enabled"}`;
      this.#scopedModelsChanged(scoped);
      this.#refreshOverlay();
      return true;
    }
    const confirm = this.#keybindings.matches("tui.select.confirm", event) || (event.key === "newline" && this.mode !== "full");
    const space = event.key === "text" && event.text === " ";
    if (!confirm && !space) return false;
    const item = overlay.items[overlay.selected];
    if (item === undefined) return true;
    if (item.id === SCOPED_MODEL_SAVE) {
      this.#saveScopedModels(overlay);
      return true;
    }
    if (item.id === SCOPED_MODEL_ALL) {
      scoped.all = true;
      scoped.selected.clear();
      scoped.order = [];
      scoped.status = "All available and future models enabled";
    } else if (item.id === SCOPED_MODEL_NONE) {
      scoped.all = false;
      scoped.selected.clear();
      scoped.order = [];
      scoped.status = "All models cleared";
    } else {
      const pattern = this.#scopedModelPattern(item);
      if (pattern === undefined) return true;
      if (scoped.all) this.#materializeScopedModels(scoped);
      if (scoped.selected.has(pattern)) {
        scoped.selected.delete(pattern);
        scoped.order = scoped.order.filter((entry) => entry !== pattern);
      } else {
        scoped.selected.add(pattern);
        scoped.order.push(pattern);
      }
      scoped.status = `${pattern}: ${scoped.selected.has(pattern) ? "enabled" : "cleared"}`;
    }
    this.#scopedModelsChanged(scoped);
    this.#refreshOverlay();
    return true;
  }

  #materializeScopedModels(scoped: NonNullable<Overlay["scopedModels"]>): void {
    scoped.all = false;
    scoped.order = scoped.source.map((item) => `${item.value.provider}/${item.value.model}`);
    scoped.selected = new Set(scoped.order);
  }

  #scopedModelPattern(item: PickerItem): string | undefined {
    const value = item.value;
    if (value === null || typeof value !== "object" || !("provider" in value) || !("model" in value)
      || typeof value.provider !== "string" || typeof value.model !== "string") return undefined;
    return `${value.provider}/${value.model}`;
  }

  #saveScopedModels(overlay: Overlay): void {
    const scoped = overlay.scopedModels;
    if (scoped === undefined) return;
    const selection = this.#scopedModelSelection(scoped);
    if (scoped.live === true) {
      try {
        const pending = scoped.onSave?.(selection);
        if (pending !== undefined && typeof (pending as PromiseLike<void>).then === "function") {
          scoped.status = "Saving model cycling defaults...";
          void Promise.resolve(pending).then(() => {
            scoped.status = "Saved model cycling defaults";
            if (this.#overlay === overlay) {
              this.#refreshOverlay();
              this.#scheduleRender();
            }
          }, (cause: unknown) => {
            scoped.status = `Could not save model cycling defaults: ${cause instanceof Error ? cause.message : String(cause)}`;
            if (this.#overlay === overlay) {
              this.#refreshOverlay();
              this.#scheduleRender();
            }
          });
        } else scoped.status = "Saved model cycling defaults";
      } catch (cause) {
        scoped.status = `Could not save model cycling defaults: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
      this.#refreshOverlay();
      this.#scheduleRender();
      return;
    }
    this.#overlay = undefined;
    overlay.cleanup();
    overlay.resolve?.(selection);
    this.#scheduleRender();
  }

  #scopedModelSelection(scoped: NonNullable<Overlay["scopedModels"]>): ScopedModelSelection {
    return scoped.all
      ? { mode: "all" }
      : scoped.selected.size === 0
        ? { mode: "none" }
        : { mode: "models", patterns: scoped.order.filter((pattern) => scoped.selected.has(pattern)) };
  }

  #scopedModelsChanged(scoped: NonNullable<Overlay["scopedModels"]>): void {
    try {
      scoped.onChange?.(this.#scopedModelSelection(scoped));
    } catch (cause) {
      scoped.status = cause instanceof Error ? cause.message : String(cause);
    }
  }

  #handleSessionOverlayKey(overlay: Overlay, event: KeyEvent): boolean {
    const session = overlay.session;
    if (session === undefined) return false;

    const restoreList = (): void => {
      session.mode = "list";
      overlay.query.restore(session.listQuery ?? { text: "", cursor: 0 });
      delete session.listQuery;
      delete session.target;
      delete session.status;
      this.#refreshOverlay();
    };

    if (session.mode === "rename") {
      if (this.#keybindings.matches("tui.select.cancel", event)) {
        restoreList();
        return true;
      }
      if (this.#keybindings.matches("tui.select.confirm", event) || (event.key === "newline" && this.mode !== "full")) {
        const name = overlay.query.text.trim();
        if (name === "") {
          session.status = "Session name cannot be empty";
          return true;
        }
        const target = session.target;
        if (target !== undefined) this.#emit({
          type: "session_rename",
          item: target,
          name,
          scope: session.scope,
          query: session.listQuery?.text ?? "",
        });
        restoreList();
        session.status = "Renaming session…";
        return true;
      }
      if (event.key === "text" || event.key === "paste") overlay.query.insert(event.text ?? "");
      else if (event.key === "backspace") overlay.query.backspace();
      else if (event.key === "delete") overlay.query.deleteForward();
      else if (event.ctrl && event.key === "u") overlay.query.deleteToLineStart();
      return true;
    }

    if (session.mode === "confirm_delete") {
      if (this.#keybindings.matches("tui.select.cancel", event)) {
        restoreList();
        return true;
      }
      if (this.#keybindings.matches("tui.select.confirm", event) || (event.key === "newline" && this.mode !== "full")) {
        const target = session.target;
        if (target !== undefined) this.#emit({
          type: "session_delete",
          item: target,
          scope: session.scope,
          query: session.listQuery?.text ?? "",
        });
        restoreList();
        session.status = "Deleting session…";
        return true;
      }
      return true;
    }

    if (this.#keybindings.matches("app.session.toggleScope", event)) {
      session.scope = session.scope === "current" ? "all" : "current";
      session.status = session.scope === "all" ? "Loading all workspaces…" : "Loading current workspace…";
      session.hasMore = false;
      session.loadingMore = false;
      overlay.query.clear({ recordUndo: false });
      overlay.selected = 0;
      this.#emit({ type: "session_scope", scope: session.scope });
      return true;
    }

    if (this.#keybindings.matches("app.session.toggleSort", event)) {
      session.sort = session.sort === "threaded" ? "recent" : session.sort === "recent" ? "relevance" : "threaded";
      session.status = `Sort: ${session.sort}`;
      overlay.selected = 0;
      this.#refreshOverlay();
      return true;
    }
    if (this.#keybindings.matches("app.session.toggleNamedFilter", event)) {
      session.namedOnly = !session.namedOnly;
      session.status = session.namedOnly ? "Showing named sessions only" : "Showing all sessions";
      overlay.selected = 0;
      this.#refreshOverlay();
      return true;
    }
    if (this.#keybindings.matches("app.session.togglePath", event)) {
      session.showPath = !session.showPath;
      session.status = session.showPath ? "Session paths shown" : "Session paths hidden";
      this.#refreshOverlay();
      return true;
    }
    if (this.#keybindings.matches("app.session.rename", event)) {
      const target = overlay.items[overlay.selected];
      if (target === undefined) {
        session.status = "No session selected";
        return true;
      }
      session.mode = "rename";
      session.target = target;
      session.listQuery = overlay.query.snapshot();
      session.status = "Enter a session name";
      const source = overlay.source.find((item) => item.id === target.id);
      overlay.query.setText(target.session?.name ?? source?.label ?? target.label);
      return true;
    }

    const deleteSelected = (): void => {
      const target = overlay.items[overlay.selected];
      if (target === undefined) {
        session.status = "No session selected";
        return;
      }
      if (target.session?.current === true) {
        session.status = "The active session cannot be deleted";
        return;
      }
      session.mode = "confirm_delete";
      session.target = target;
      session.listQuery = overlay.query.snapshot();
      session.status = `Delete “${target.session?.name ?? target.label}”?`;
      overlay.query.clear({ recordUndo: false });
    };

    if (this.#keybindings.matches("app.session.delete", event)) {
      deleteSelected();
      return true;
    }
    if (this.#keybindings.matches("app.session.deleteNoninvasive", event)) {
      if (overlay.query.empty) deleteSelected();
      else {
        overlay.query.deleteWordBackward();
        this.#refreshOverlay();
        session.loadingMore = false;
        session.status = overlay.query.empty ? "Loading recent sessions…" : "Searching the full session catalog…";
        this.#emit({ type: "session_search", scope: session.scope, query: overlay.query.text });
      }
      return true;
    }
    const right = !event.ctrl && !event.alt && !event.shift && event.key === "right";
    const pageDownAtBoundary = this.#keybindings.matches("tui.select.pageDown", event)
      && overlay.selected + 10 >= overlay.items.length - 1;
    if ((right || pageDownAtBoundary) && session.hasMore) {
      if (!session.loadingMore) {
        session.loadingMore = true;
        session.status = "Loading more sessions…";
        this.#emit({ type: "session_more", scope: session.scope, query: overlay.query.text });
      }
      if (pageDownAtBoundary) {
        overlay.selected = Math.min(Math.max(0, overlay.items.length - 1), overlay.selected + 10);
      }
      return true;
    }
    return false;
  }

  #handleEditorKey(event: KeyEvent): void {
    if (this.#inputBlocked !== undefined) {
      if (this.#keybindings.matches("app.interrupt", event)) this.#emit({ type: "cancel" });
      return;
    }
    const jumpForward = this.#keybindings.matches("tui.editor.jumpForward", event);
    const jumpBackward = this.#keybindings.matches("tui.editor.jumpBackward", event);
    if (this.#jumpDirection !== undefined) {
      if (jumpForward || jumpBackward) {
        this.#jumpDirection = undefined;
        return;
      }
      if (event.key === "text" && event.text !== undefined) {
        const direction = this.#jumpDirection;
        this.#jumpDirection = undefined;
        this.#editor.jumpToCharacter(event.text, direction);
        return;
      }
      this.#jumpDirection = undefined;
    }
    if (this.#keybindings.matches("app.suspend", event)) {
      this.#emit({ type: "suspend" });
      return;
    }
    if (this.#keybindings.matches("app.interrupt", event)) {
      if (this.#steering !== undefined || this.#model.context.active === true) {
        if (this.#steering !== undefined) this.#steering("/cancel");
        else this.#emit({ type: "cancel" });
        this.#lastEscapeAt = 0;
        return;
      }
      const empty = this.#editor.empty && this.#inputImages.length === 0 && this.#recoveredInputImages.length === 0;
      if (empty && this.#doubleEscapeAction !== "none") {
        const now = Date.now();
        if (now - this.#lastEscapeAt < 500) {
          const command = this.#doubleEscapeAction === "tree" ? "/tree" : "/fork";
          this.#lastEscapeAt = 0;
          this.#emit({ type: "submit", text: command });
        } else this.#lastEscapeAt = now;
      }
      return;
    }
    if (this.#keybindings.matches("app.clear", event)) {
      const now = Date.now();
      if (now - this.#lastClearAt < 500 && this.#editor.empty && this.#inputImages.length === 0 && this.#recoveredInputImages.length === 0) {
        this.#lastClearAt = 0;
        this.#emit({ type: "exit" });
        return;
      }
      if (this.#recoveredQueueDraft) this.#emit({ type: "queue_restore_discard" });
      this.#editor.clear();
      this.clearInputImages();
      this.#recoveredQueueDraft = false;
      this.#jumpDirection = undefined;
      this.#inputMode = "normal";
      this.#lastClearAt = now;
      return;
    }
    if (this.#keybindings.matches("app.exit", event)) {
      if (!this.#editor.empty && event.ctrl && event.key === "d") this.#editor.deleteForward();
      else this.#emit({ type: "exit" });
      return;
    }
    const cycleForward = this.#keybindings.matches("app.model.cycleForward", event);
    const cycleBackward = this.#keybindings.matches("app.model.cycleBackward", event);
    if (cycleForward || cycleBackward) {
      const models = this.#modelCycleItems ?? this.#pickerSources.get("model") ?? [];
      if (models.length === 0) return;
      if (models.length === 1) {
        this.notify(this.#modelCycleItems === undefined ? "Only one model available" : "Only one model in scope");
        return;
      }
      const current = this.#model.context;
      const index = models.findIndex((item) => {
        const value = item.value;
        return value !== null && typeof value === "object"
          && "provider" in value && value.provider === current.provider
          && "model" in value && value.model === current.model;
      });
      const direction = cycleBackward ? -1 : 1;
      const item = index < 0
        ? cycleBackward ? models.at(-1) : models[0]
        : models[(index + direction + models.length) % models.length];
      if (item !== undefined) this.#emit({ type: "select", picker: "model", item });
      return;
    }
    if (this.#keybindings.matches("app.thinking.cycle", event)) {
      this.#emit({ type: "cycle_thinking" });
      return;
    }
    if (this.#keybindings.matches("app.thinking.toggle", event)) {
      this.toggleReasoning();
      return;
    }
    if (this.#keybindings.matches("app.model.select", event)) {
      this.openPicker("model", "Models");
      return;
    }
    if (this.#keybindings.matches("app.session.resume", event)) {
      this.openPicker("session", "Sessions");
      this.#emit({ type: "session_open" });
      return;
    }
    if (this.#keybindings.matches("app.session.new", event)) {
      this.#emit({ type: "submit", text: "/new" });
      return;
    }
    if (this.#keybindings.matches("app.session.tree", event)) {
      this.#emit({ type: "submit", text: "/tree" });
      return;
    }
    if (this.#keybindings.matches("app.session.fork", event)) {
      this.#emit({ type: "submit", text: "/fork" });
      return;
    }
    if (this.#keybindings.matches("app.tools.expand", event)) {
      this.toggleTool();
      return;
    }
    if (this.#keybindings.matches("app.editor.external", event)) {
      void this.editExternally().catch((cause) => this.#fail(error(cause)));
      return;
    }
    if (this.#keybindings.matches("app.clipboard.pasteImage", event)) {
      this.#emit({ type: "paste_image" });
      return;
    }
    if (this.#keybindings.matches("app.message.copy", event)) {
      this.#emit({ type: "copy" });
      return;
    }
    if (jumpForward || jumpBackward) {
      this.#jumpDirection = jumpBackward ? -1 : 1;
      return;
    }
    if (this.#keybindings.matches("tui.editor.pageUp", event)) {
      const viewport = this.#editorViewport();
      if (this.#transcriptOffset === 0 && this.#editor.hasMultipleVisualRows(viewport.width)
        && this.#editor.movePage(-1, viewport.width, viewport.rows)) return;
      const rows = terminalSize(this.output, this.capabilities).rows;
      this.#transcriptOffset = Math.min(1_000_000, this.#transcriptOffset + Math.max(1, rows - 6));
      return;
    }
    if (this.#keybindings.matches("tui.editor.pageDown", event)) {
      const viewport = this.#editorViewport();
      if (this.#transcriptOffset === 0 && this.#editor.hasMultipleVisualRows(viewport.width)
        && this.#editor.movePage(1, viewport.width, viewport.rows)) return;
      const rows = terminalSize(this.output, this.capabilities).rows;
      this.#transcriptOffset = Math.max(0, this.#transcriptOffset - Math.max(1, rows - 6));
      return;
    }
    if (this.#keybindings.matches("app.message.dequeue", event)) {
      this.#emit({ type: "dequeue" });
      return;
    }
    if (this.#keybindings.matches("app.message.followUp", event)) {
      if (this.#steering !== undefined) {
        this.#inputMode = "follow_up";
        this.#submit();
      } else this.#editor.insert("\n");
      return;
    }
    if (this.#keybindings.matches("tui.editor.undo", event)) this.#editor.undo();
    else if (this.#keybindings.matches("tui.editor.redo", event)) this.#editor.redo();
    else if (this.#keybindings.matches("tui.editor.yank", event)) this.#editor.yank();
    else if (this.#keybindings.matches("tui.editor.yankPop", event)) this.#editor.yankPop();
    else if (this.#keybindings.matches("tui.editor.cursorLineStart", event)) this.#editor.moveHome();
    else if (this.#keybindings.matches("tui.editor.cursorLineEnd", event)) this.#editor.moveEnd();
    else if (this.#keybindings.matches("tui.editor.cursorWordLeft", event)) this.#editor.moveLeft(true);
    else if (this.#keybindings.matches("tui.editor.cursorWordRight", event)) this.#editor.moveRight(true);
    else if (this.#keybindings.matches("tui.editor.cursorLeft", event)) this.#editor.moveLeft();
    else if (this.#keybindings.matches("tui.editor.cursorRight", event)) this.#editor.moveRight();
    else if (this.#keybindings.matches("tui.editor.deleteToLineStart", event)) this.#editor.deleteToLineStart();
    else if (this.#keybindings.matches("tui.editor.deleteToLineEnd", event)) this.#editor.deleteToLineEnd();
    else if (this.#keybindings.matches("tui.editor.deleteWordBackward", event)) this.#editor.deleteWordBackward();
    else if (this.#keybindings.matches("tui.editor.deleteWordForward", event)) this.#editor.deleteWordForward();
    else if (this.#keybindings.matches("tui.editor.cursorUp", event)) {
      const viewport = this.#editorViewport();
      if (this.#editor.hasMultipleVisualRows(viewport.width)) this.#editor.moveUp(viewport.width);
      else this.#editor.historyPrevious();
    } else if (this.#keybindings.matches("tui.editor.cursorDown", event)) {
      const viewport = this.#editorViewport();
      if (this.#editor.hasMultipleVisualRows(viewport.width)) this.#editor.moveDown(viewport.width);
      else this.#editor.historyNext();
    } else if (this.#keybindings.matches("tui.editor.deleteCharBackward", event)) this.#editor.backspace();
    else if (this.#keybindings.matches("tui.editor.deleteCharForward", event)) this.#editor.deleteForward();
    else if (this.#keybindings.matches("tui.input.tab", event)) {
      if (!this.#requestAutocomplete() && !this.#requestCommandCompletion()) this.#completeFileReference();
    }
    else if (event.key === "text" && event.text === "/" && this.#editor.text === "" && this.mode === "full") {
      this.openPicker("command", "Commands");
    }
    else if (event.key === "text" && event.text === "@" && (this.#editor.text === "" || /\s$/u.test(this.#editor.text))) {
      const files = this.#pickerSources.get("file") ?? [];
      if (files.length === 0) this.#editor.insert("@");
      else this.openPicker("file", "Files");
    }
    else if (event.key === "paste") this.#editor.insertPaste(event.text ?? "");
    else if (event.key === "text") this.#editor.insert(event.text ?? "");
    else if (this.#keybindings.matches("tui.input.newLine", event) && this.mode === "full") this.#editor.insert("\n");
    else if (this.#keybindings.matches("tui.input.submit", event) || (event.key === "newline" && this.mode !== "full")) this.#submit();
  }

  #completeFileReference(): void {
    const query = fileReferenceQuery(this.#editor.text);
    if (query === undefined) {
      this.#editor.insert("  ");
      return;
    }
    const source = this.#pickerSources.get("file") ?? [];
    const matches = source.filter((item) => typeof item.value === "string" && item.value.startsWith(query));
    if (matches.length === 0) return;
    const values = matches.map((item) => String(item.value));
    const completion = matches.length === 1 ? values[0]! : commonPrefix(values);
    if (completion.length > query.length) {
      const text = this.#editor.text;
      this.#editor.setText(`${text.slice(0, text.length - query.length)}${completion}`);
      return;
    }
    this.#openOverlay("file", "Files", source);
    this.#overlay?.query.insert(query);
    this.#refreshOverlay();
  }

  #applyEditorMiddleware(event: KeyEvent): boolean {
    const owner = this.#editorMiddleware;
    if (owner === undefined || owner.signal.aborted || this.#inputBlocked !== undefined) return false;
    if (event.ctrl || event.alt || ![
      "text", "paste", "backspace", "delete", "left", "right", "up", "down", "home", "end", "tab", "newline",
    ].includes(event.key)) return false;
    try {
      const value = validatedEditorMiddlewareResult(owner.middleware(Object.freeze({
        key: event.key,
        ...(event.text === undefined ? {} : { text: sanitizeTerminalText(event.text) }),
        ctrl: Boolean(event.ctrl),
        alt: Boolean(event.alt),
        shift: Boolean(event.shift),
      }), Object.freeze({ text: this.#editor.text, cursor: this.#editor.cursor }), owner.signal), this.#limits.maxEditorBytes);
      if (owner.signal.aborted || this.#editorMiddleware !== owner || value.action === "pass") return false;
      if (value.action === "replace") this.#editor.setText(value.text, value.cursor);
      return true;
    } catch (cause) {
      if (!owner.signal.aborted && !this.#closed) {
        try { this.notify(`Editor middleware failed: ${error(cause).message}`, "warning"); } catch {}
      }
      return false;
    }
  }

  #cancelAutocomplete(reason: Error): void {
    const pending = this.#pendingAutocomplete;
    if (pending === undefined) return;
    this.#pendingAutocomplete = undefined;
    pending.controller.abort(reason);
  }

  #requestAutocomplete(): boolean {
    const owner = this.#activeAutocompleteOwner();
    if (owner === undefined || owner.signal.aborted) return false;
    const controller = new AbortController();
    const pending: PendingAutocomplete = {
      controller,
      owner,
      text: this.#editor.text,
      cursor: this.#editor.cursor,
    };
    this.#pendingAutocomplete = pending;
    const signal = AbortSignal.any([owner.signal, controller.signal]);
    const apply = (completion: TuiAutocompleteCompletion): void => {
      if (this.#editor.text !== pending.text || this.#editor.cursor !== pending.cursor) return;
      const graphemes = splitGraphemes(pending.text);
      const replacement = splitGraphemes(completion.value);
      const text = [...graphemes.slice(0, completion.start), ...replacement, ...graphemes.slice(completion.end)].join("");
      this.#editor.setText(text, completion.start + replacement.length);
      this.#scheduleRender();
    };
    void Promise.resolve().then(async () => await owner.provider(pending.text, pending.cursor, signal)).then((raw) => {
      signal.throwIfAborted();
      if (this.#pendingAutocomplete !== pending || this.#autocompleteVersion !== owner.version
        || this.#editor.text !== pending.text || this.#editor.cursor !== pending.cursor) return;
      this.#pendingAutocomplete = undefined;
      const completions = validatedAutocompleteCompletions(raw, pending.text);
      if (completions === null || completions.length === 0) return;
      if (completions.length === 1) {
        apply(completions[0]!);
        return;
      }
      const items = completions.map((completion, index): PickerItem<TuiAutocompleteCompletion> => ({
        id: `autocomplete:${index}`,
        label: completion.label ?? completion.value,
        value: completion,
        ...(completion.detail === undefined ? {} : { detail: completion.detail }),
      }));
      let opened: Overlay | undefined;
      const abort = () => {
        if (this.#overlay === opened) this.#closeOverlay(signal.reason instanceof Error ? signal.reason : new Error("Autocomplete expired"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.#openOverlay("generic", "Completions", items, {
        resolve: (value) => apply(value as TuiAutocompleteCompletion),
        cleanup: () => signal.removeEventListener("abort", abort),
      });
      opened = this.#overlay;
      if (opened !== undefined) {
        if (this.#autocompleteMaxVisible === undefined) delete opened.maxVisible;
        else opened.maxVisible = this.#autocompleteMaxVisible;
      }
      if (signal.aborted) abort();
    }).catch((cause) => {
      if (this.#pendingAutocomplete === pending) this.#pendingAutocomplete = undefined;
      if (signal.aborted || this.#closed) return;
      try { this.notify(`Autocomplete failed: ${error(cause).message}`, "warning"); } catch {}
    });
    return true;
  }

  #cancelCommandCompletion(reason: Error): void {
    const pending = this.#pendingCommandCompletion;
    if (pending === undefined) return;
    this.#pendingCommandCompletion = undefined;
    pending.controller.abort(reason);
  }

  #requestCommandCompletion(): boolean {
    const owner = this.#commandCompletion;
    const query = commandCompletionQuery(this.#editor.text, this.#editor.cursor);
    if (owner === undefined || owner.signal.aborted || query === undefined) return false;
    const controller = new AbortController();
    const pending: PendingCommandCompletion = {
      controller,
      owner,
      text: this.#editor.text,
      cursor: this.#editor.cursor,
    };
    this.#pendingCommandCompletion = pending;
    const signal = AbortSignal.any([owner.signal, controller.signal]);
    const apply = (value: string): void => {
      if (this.#editor.text !== pending.text || this.#editor.cursor !== pending.cursor) return;
      this.#editor.setText(`/${query.command} ${value}`);
      this.#scheduleRender();
    };
    void Promise.resolve().then(async () => await owner.provider(query.command, query.prefix, signal)).then((raw) => {
      signal.throwIfAborted();
      if (this.#pendingCommandCompletion !== pending || this.#commandCompletion !== owner
        || this.#editor.text !== pending.text || this.#editor.cursor !== pending.cursor) return;
      this.#pendingCommandCompletion = undefined;
      const completions = validatedCommandCompletions(raw);
      if (completions === null || completions.length === 0) return;
      if (completions.length === 1) {
        apply(completions[0]!.value);
        return;
      }
      const items = completions.map((completion, index): PickerItem<string> => ({
        id: `command-argument:${index}`,
        label: completion.label ?? completion.value,
        value: completion.value,
        ...(completion.detail === undefined ? {} : { detail: completion.detail }),
      }));
      let opened: Overlay | undefined;
      const abort = () => {
        if (this.#overlay === opened) this.#closeOverlay(signal.reason instanceof Error ? signal.reason : new Error("Command completion expired"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.#openOverlay("generic", `/${query.command} arguments`, items, {
        resolve: (value) => apply(String(value)),
        cleanup: () => signal.removeEventListener("abort", abort),
      });
      opened = this.#overlay;
      if (opened !== undefined) {
        if (this.#autocompleteMaxVisible === undefined) delete opened.maxVisible;
        else opened.maxVisible = this.#autocompleteMaxVisible;
      }
      if (signal.aborted) abort();
    }).catch((cause) => {
      if (this.#pendingCommandCompletion === pending) this.#pendingCommandCompletion = undefined;
      if (signal.aborted || this.#closed) return;
      try {
        this.notify(`Command completion failed: ${error(cause).message}`, "warning");
      } catch {}
    });
    return true;
  }

  #submit(): void {
    const text = this.#editor.commitHistory();
    if (
      text.trim() === "" &&
      this.#inputImages.length === 0 &&
      this.#recoveredInputImages.length === 0 &&
      this.#pendingQuestion === undefined
    ) return;
    const images = this.#inputImages;
    const recoveredImages = this.#recoveredInputImages;
    const recoveredQueueDraft = this.#recoveredQueueDraft;
    this.#inputImages = [];
    this.#recoveredInputImages = [];
    this.#recoveredQueueDraft = false;
    this.#jumpDirection = undefined;
    this.#editor.clear({ recordUndo: false });
    this.#saveDraft(this.#draftScope);
    if (this.mode !== "full") this.#write("\n");
    if (this.#pendingQuestion !== undefined) {
      const pending = this.#pendingQuestion;
      pending.cleanup();
      this.#pendingQuestion = undefined;
      this.#inputLabel = pending.previousInputLabel;
      this.#scheduleRender();
      this.#submittedImages = images;
      this.#submittedRecoveredImages = recoveredImages;
      this.#submittedRecoveredQueueDraft = recoveredQueueDraft;
      pending.resolve(text);
      return;
    }
    if (this.#inputMode === "follow_up") {
      this.#inputMode = "normal";
      if (this.#steering !== undefined) this.#steering(`/follow ${text}`, images, recoveredImages, recoveredQueueDraft);
      else this.#emit({
        type: "follow_up",
        text,
        ...(images.length === 0 ? {} : { images }),
        ...(recoveredImages.length === 0 ? {} : { recoveredImages }),
        ...(recoveredQueueDraft ? { recoveredQueueDraft: true as const } : {}),
      });
      return;
    }
    if (this.#steering !== undefined) this.#steering(text, images, recoveredImages, recoveredQueueDraft);
    else this.#emit({
      type: "submit",
      text,
      ...(images.length === 0 ? {} : { images }),
      ...(recoveredImages.length === 0 ? {} : { recoveredImages }),
      ...(recoveredQueueDraft ? { recoveredQueueDraft: true as const } : {}),
    });
  }

  #openOverlay(
    kind: PickerKind,
    title: string,
    source: readonly PickerItem[],
    callbacks: { resolve?: (value: unknown) => void; reject?: (error: Error) => void; cleanup?: () => void } = {},
  ): void {
    if (this.#overlay !== undefined) this.#closeOverlay(new Error("Selection superseded"));
    const query = new MultilineEditor({ maxBytes: 8 * 1024, maxHistoryEntries: 10, maxUndoEntries: 20 });
    this.#overlay = {
      kind,
      title: sanitizeTerminalText(title),
      source: source.slice(0, this.#limits.maxPickerItems),
      items: source.slice(0, this.#limits.maxPickerItems),
      query,
      selected: 0,
      ...(callbacks.resolve === undefined ? {} : { resolve: callbacks.resolve }),
      ...(callbacks.reject === undefined ? {} : { reject: callbacks.reject }),
      cleanup: callbacks.cleanup ?? (() => undefined),
      ...(kind === "session"
        ? {
            session: {
              sort: "threaded",
              namedOnly: false,
              showPath: false,
              mode: "list",
              scope: "current",
              hasMore: this.#sessionPickerPagination.hasMore,
              loadingMore: false,
              ...(this.#sessionPickerPagination.status === undefined
                ? {}
                : { status: this.#sessionPickerPagination.status }),
            },
          }
        : {}),
    };
    this.#refreshOverlay();
    if (this.mode !== "full") {
      this.#write(`\n${sanitizeTerminalText(title)} (type to filter, Enter to select, Esc to cancel)\n`);
      for (const [index, item] of this.#overlay.items.slice(0, 20).entries()) {
        const separator = this.capabilities.unicode ? " — " : " - ";
        this.#write(`  ${index + 1}. ${sanitizeTerminalText(item.label)}${item.detail === undefined ? "" : `${separator}${sanitizeTerminalText(item.detail)}`}\n`);
      }
      if (this.#overlay.items.length > 20) this.#write(`  … ${this.#overlay.items.length - 20} more\n`);
      this.#write("search> ");
    }
    this.#scheduleRender();
  }

  #refreshOverlay(): void {
    const overlay = this.#overlay;
    if (overlay === undefined) return;
    if (overlay.tree !== undefined) {
      const selectedId = overlay.items[overlay.selected]?.tree?.eventId;
      overlay.items = buildSessionTreePickerRows(overlay.source, {
        query: overlay.query.text,
        activeOnly: overlay.tree.activeOnly,
        folded: overlay.tree.folded,
        unicode: this.capabilities.unicode,
        filter: overlay.tree.filter,
        showLabelTimestamps: overlay.tree.showLabelTimestamps,
      });
      let selected = selectedId === undefined ? -1 : overlay.items.findIndex((item) => item.tree?.eventId === selectedId);
      if (selected < 0 && overlay.tree.activeOnly && overlay.tree.preferredActiveEventId !== undefined) {
        selected = overlay.items.findIndex((item) => item.tree?.eventId === overlay.tree?.preferredActiveEventId);
      }
      overlay.selected = selected < 0 ? 0 : selected;
      return;
    }
    if (overlay.scopedModels !== undefined) {
      const selectedId = overlay.items[overlay.selected]?.id;
      const byPattern = new Map(overlay.scopedModels.source.map((item) => [`${item.value.provider}/${item.value.model}`, item]));
      const orderedModels = overlay.scopedModels.order.flatMap((pattern) => {
        const item = byPattern.get(pattern);
        if (item === undefined) return [];
        byPattern.delete(pattern);
        return [item];
      });
      orderedModels.push(...overlay.scopedModels.source.filter((item) => byPattern.has(`${item.value.provider}/${item.value.model}`)));
      const actions = overlay.source.filter((item) => this.#scopedModelPattern(item) === undefined);
      const ranked = rankPickerItems([...actions, ...orderedModels], overlay.query.text, this.#limits.maxPickerItems);
      const checked = this.capabilities.unicode ? "☑" : "[x]";
      const unchecked = this.capabilities.unicode ? "☐" : "[ ]";
      overlay.items = ranked.map((item) => {
        const pattern = this.#scopedModelPattern(item);
        if (pattern === undefined) return item;
        const enabled = overlay.scopedModels?.all === true || overlay.scopedModels?.selected.has(pattern) === true;
        return { ...item, label: `${enabled ? checked : unchecked} ${item.label}` };
      });
      const selected = selectedId === undefined ? -1 : overlay.items.findIndex((item) => item.id === selectedId);
      overlay.selected = selected < 0 ? Math.max(0, Math.min(overlay.selected, overlay.items.length - 1)) : selected;
      return;
    }
    if (overlay.session !== undefined) {
      const result = buildSessionPickerRows(overlay.source.map((item, index) => ({
        id: item.id,
        label: item.label,
        ...(item.session?.name === undefined ? {} : { name: item.session.name }),
        ...(item.detail === undefined ? {} : { detail: item.detail }),
        ...(item.keywords === undefined ? {} : { keywords: item.keywords }),
        ...(item.session?.parentId === undefined ? {} : { parentId: item.session.parentId }),
        updatedAt: item.session?.updatedAt ?? index,
        item,
      })), {
        query: overlay.query.text,
        namedOnly: overlay.session.namedOnly,
        sort: overlay.session.sort,
      });
      overlay.items = result.rows.map((row) => {
        const item = row.session.item;
        const { detail: _detail, ...itemWithoutDetail } = item;
        const threaded = overlay.session?.sort === "threaded" && overlay.query.empty;
        const branch = row.depth === 0 ? "" : `${"  ".repeat(Math.max(0, row.depth - 1))}${this.capabilities.unicode ? "└─ " : "\\- "}`;
        const path = overlay.session?.showPath === true ? item.session?.path : undefined;
        const detail = [path, item.detail].filter((value): value is string => value !== undefined && value !== "").join(" · ");
        return {
          ...itemWithoutDetail,
          label: `${threaded ? branch : ""}${item.label}`,
          ...(detail === "" ? {} : { detail }),
        };
      });
      if (result.error === undefined) {
        if (overlay.session.status?.startsWith("Invalid regular expression") === true) delete overlay.session.status;
      } else overlay.session.status = result.error;
      overlay.selected = Math.max(0, Math.min(overlay.selected, overlay.items.length - 1));
      return;
    }
    const query = overlay.kind === "command" ? overlay.query.text.trimStart().split(/\s/u, 1)[0] ?? "" : overlay.query.text;
    overlay.items = rankPickerItems(overlay.source, query, this.#limits.maxPickerItems);
    if (overlay.kind === "command" && query !== "") {
      const exact = overlay.items.findIndex((item) => item.value === `/${query}`);
      if (exact > 0) overlay.items.unshift(...overlay.items.splice(exact, 1));
    }
    overlay.selected = Math.max(0, Math.min(overlay.selected, overlay.items.length - 1));
  }

  #commandEditorText(overlay: Overlay, command?: string): string {
    const query = overlay.query.text.trimStart();
    const whitespace = query.search(/\s/u);
    const suffix = whitespace === -1 ? "" : query.slice(whitespace);
    const selected = command ?? `/${query.slice(0, whitespace === -1 ? undefined : whitespace)}`;
    return `${selected.startsWith("/") ? selected : `/${selected}`}${suffix}`;
  }

  #promoteCommandWithArguments(): boolean {
    const overlay = this.#overlay;
    if (overlay?.kind !== "command") return false;
    const query = overlay.query.text.trimStart();
    const whitespace = query.search(/\s/u);
    if (whitespace === -1) return false;
    const name = `/${query.slice(0, whitespace)}`;
    const item = overlay.source.find((candidate) => candidate.value === name);
    if (item === undefined || typeof item.value !== "string") return false;
    this.#overlay = undefined;
    overlay.cleanup();
    this.#editor.setText(this.#commandEditorText(overlay, item.value));
    return true;
  }

  #submitCommandQuery(): void {
    const overlay = this.#overlay;
    if (overlay?.kind !== "command") return;
    this.#overlay = undefined;
    overlay.cleanup();
    this.#editor.setText(this.#commandEditorText(overlay));
    this.#submit();
  }

  #selectOverlay(): void {
    const overlay = this.#overlay;
    const item = overlay?.items[overlay.selected];
    if (overlay === undefined || item === undefined) return;
    this.#overlay = undefined;
    overlay.cleanup();
    if (overlay.resolve !== undefined) {
      overlay.resolve(item.value);
      this.#scheduleRender();
      return;
    }
    if (overlay.kind === "file") {
      if (typeof item.value === "string") {
        const path = /\s/u.test(item.value) ? `@"${item.value.replaceAll('"', '\\"')}"` : `@${item.value}`;
        this.#editor.insert(path);
      }
    } else if (overlay.kind === "command") {
      const command = item.value;
      if (typeof command === "string") {
        this.#editor.setText(this.#commandEditorText(overlay, command));
        this.#submit();
        return;
      }
    } else if (overlay.kind !== "generic") this.#emit({ type: "select", picker: overlay.kind, item });
    this.#scheduleRender();
  }

  #closeOverlay(cause: Error): void {
    const overlay = this.#overlay;
    if (overlay === undefined) return;
    this.#overlay = undefined;
    overlay.cleanup();
    overlay.reject?.(cause);
    this.#scheduleRender();
  }

  #saveDraft(scope: string): void {
    this.#drafts.delete(scope);
    this.#drafts.set(scope, this.#editor.snapshot());
    this.#draftImages.delete(scope);
    this.#draftImages.set(scope, this.#inputImages.map((image) => ({
      block: { ...image.block },
      label: image.label,
      coordinates: { ...image.coordinates },
    })));
    this.#draftRecoveredImages.delete(scope);
    this.#draftRecoveredImages.set(scope, this.#recoveredInputImages.map((image) => ({ ...image })));
    this.#draftRecoveredQueue.set(scope, this.#recoveredQueueDraft);
    while (this.#drafts.size > 100) {
      const oldest = this.#drafts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#drafts.delete(oldest);
      this.#draftImages.delete(oldest);
      this.#draftRecoveredImages.delete(oldest);
      this.#draftRecoveredQueue.delete(oldest);
    }
    let imageBytes = [...this.#draftImages.values()].reduce((total, images) =>
      total + images.reduce((subtotal, image) => subtotal + Buffer.byteLength(image.block.data ?? "", "base64"), 0), 0);
    for (const [draftScope, images] of this.#draftImages) {
      if (imageBytes <= 32 * 1024 * 1024) break;
      if (draftScope === scope) continue;
      this.#draftImages.delete(draftScope);
      imageBytes -= images.reduce((total, image) => total + Buffer.byteLength(image.block.data ?? "", "base64"), 0);
    }
    let recoveredBytes = [...this.#draftRecoveredImages.values()].reduce((total, images) =>
      total + images.reduce((subtotal, image) => subtotal + Buffer.byteLength(image.data ?? image.url ?? "", "utf8"), 0), 0);
    for (const [draftScope, images] of this.#draftRecoveredImages) {
      if (recoveredBytes <= 64 * 1024 * 1024) break;
      if (draftScope === scope) continue;
      this.#draftRecoveredImages.delete(draftScope);
      recoveredBytes -= images.reduce((total, image) => total + Buffer.byteLength(image.data ?? image.url ?? "", "utf8"), 0);
    }
  }

  #renderClassic(envelope: EventEnvelope): void {
    const event = envelope.event;
    if (event.type === "run_started") this.#write(`\n[status] Preparing ${sanitizeTerminalText(event.provider)}/${sanitizeTerminalText(event.model)} (Esc or Ctrl+C to cancel)\n`);
    else if (event.type === "text_delta") this.#write(sanitizeTerminalText(event.text));
    else if (event.type === "message_appended") {
      const images = event.message.content.flatMap((block) => block.type === "image"
        ? [block]
        : block.type === "tool_result" ? block.images ?? [] : []);
      for (const image of images) this.#write(`\n${terminalImageFallback(image.mediaType)}\n`);
    }
    else if (event.type === "tool_started") this.#write(`\n[tool started] ${sanitizeTerminalText(event.name)}\n`);
    else if (event.type === "tool_completed") {
      this.#write(`[tool ${event.isError ? "failed" : "completed"}] ${sanitizeTerminalText(event.name)}\n`);
    } else if (event.type === "tool_in_doubt") {
      this.#write(`[tool in doubt] ${sanitizeTerminalText(event.name)}: ${sanitizeTerminalText(event.reason)}\n`);
    } else if (event.type === "retry_scheduled" && event.phase !== "compaction") {
      this.#write(`\n[retry] ${sanitizeTerminalText(event.category)} in ${event.delayMs} ms\n`);
    } else if (event.type === "summarization_retry_scheduled") {
      this.#write(`\n[retry] Summary in ${event.delayMs} ms: ${sanitizeTerminalText(event.errorMessage)}\n`);
    } else if (event.type === "summarization_retry_attempt_start") {
      this.#write(event.source === "branchSummary"
        ? "\n[status] Retrying branch summary\n"
        : "\n[status] Retrying compaction\n");
    } else if (event.type === "compaction_started") this.#write("\n[status] Compacting older context\n");
    else if (event.type === "warning") this.#write(`\n[warning] ${sanitizeTerminalText(event.message)}\n`);
    else if (event.type === "run_failed") this.#write(`\n[failed] ${sanitizeTerminalText(event.error.message)}\n`);
    else if (event.type === "run_cancelled") this.#write(`\n[cancelled] ${sanitizeTerminalText(event.reason)}\n`);
    else if (event.type === "run_completed") this.#write("\n");
  }

  #renderClassicSessionEntry(entryId: string): void {
    const entry = this.#model.entries.find((candidate) => candidate.id === entryId);
    if (entry === undefined) return;
    const size = terminalSize(this.output, this.capabilities);
    const sessionRenderBlocks = this.#renderSessionBlocks([entry], size.columns, size.rows);
    const rendered = renderTranscriptFrame([entry], size.columns, this.#theme, {
      ...(sessionRenderBlocks.size === 0 ? {} : { sessionRenderBlocks }),
      resolveImage: (image, imageLimits) => this.#terminalImages.resolve(image, {
        protocol: this.#showImages ? this.capabilities.imageProtocol : null,
        ...imageLimits,
      }),
      hideReasoningBlock: this.#hideThinkingBlock,
      outputPad: this.#outputPad,
      codeBlockIndent: this.#codeBlockIndent,
      imageWidthCells: this.#imageWidthCells,
    });
    if (rendered.text !== "") this.#write(`${rendered.text}\n`);
  }

  #emit(action: TuiAction): void {
    try {
      this.#onAction?.(action);
    } catch (cause) {
      this.#fail(error(cause));
    }
  }

  #write(value: string): void {
    this.output.write(value);
  }

  #fail(cause: Error): void {
    if (this.#closed) return;
    this.close();
    this.#emit({ type: "error", error: cause });
  }
}
