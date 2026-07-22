import type { EventEnvelope, RunState } from "../core/events.js";
import type { JsonValue } from "../core/json.js";
import type { ImageBlock, ModelInfo, NormalizedUsage } from "../core/types.js";
import type { ImageCoordinateMetadata } from "../images/preprocess.js";
import type { CustomEntry, CustomMessageEntry } from "../extensions/session-contract.js";
import type { RuntimeUiBlock, RuntimeUiKeyEvent, RuntimeUiOverlayOptions } from "./components.js";
import type { Keybindings } from "./keybindings.js";
import type { TerminalImagePlacement, TerminalImageProtocol, TranscriptImage } from "./terminal-image.js";

export type TuiMode = "full" | "classic" | "accessible";
export type BuiltinThemeName = "dark" | "light" | "mono";
export type ThemeName = BuiltinThemeName | (string & {});
export type PickerKind = "command" | "model" | "provider" | "session" | "file" | "generic";
export type TuiPersistentComponentSlot =
  | "header"
  | "footer"
  | "widget"
  | "widget-above"
  | "widget-below"
  | "header-replacement"
  | "footer-replacement";

export interface TuiInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(enabled: boolean): this;
}

export interface TuiOutput extends NodeJS.WritableStream {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
}

export interface TuiSignalSource {
  on(event: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  off(event: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
}

export interface TerminalCapabilities {
  mode: TuiMode;
  ansi: boolean;
  color: boolean;
  unicode: boolean;
  alternateScreen: boolean;
  bracketedPaste: boolean;
  rawInput: boolean;
  imageProtocol: TerminalImageProtocol | null;
  hyperlinks: boolean;
  columns: number;
  rows: number;
  reason?: string;
}

export interface TerminalChoice<T> {
  label: string;
  detail?: string;
  value: T;
}

export interface PickerItem<T = unknown> {
  id: string;
  label: string;
  detail?: string;
  description?: string;
  keywords?: string[];
  session?: SessionPickerMetadata;
  tree?: SessionTreeMetadata;
  value: T;
}

export interface TuiSettingItem {
  id: string;
  label: string;
  description: string;
  value: string;
  values: readonly string[];
}

export interface ScopedModelOption {
  provider: string;
  model: string;
}

export type ScopedModelSelection =
  | { mode: "all" }
  | { mode: "none" }
  | { mode: "models"; patterns: string[] };

export interface SessionPickerMetadata {
  name?: string;
  path: string;
  workspace?: string;
  updatedAt: string;
  createdAt: string;
  parentId?: string;
  current?: boolean;
  messageCount?: number;
}

export interface SessionTreeMetadata {
  eventId: string;
  parentEventId?: string;
  kind: string;
  depth: number;
  prefix: string;
  branches: readonly string[];
  paths: readonly string[];
  active: boolean;
  label?: string;
  labelTimestamp?: string;
}

export interface QueuedMessage {
  mode: "steer" | "follow_up";
  text: string;
  images?: readonly ImageBlock[];
  imageCount?: number;
}

export interface TuiInputImageAttachment {
  block: ImageBlock;
  label: string;
  coordinates: ImageCoordinateMetadata;
}

export interface TuiInputImageSummary {
  label: string;
  mediaType: string;
  width?: number;
  height?: number;
}

export interface TuiContext {
  threadId?: string;
  sessionName?: string;
  workspace?: string;
  provider?: string;
  model?: string;
  contextTokens?: number;
  contextWindowTokens?: number;
  active?: boolean;
  status?: RunState | "idle";
  extensionStatus?: string;
  workingMessage?: string;
  workingVisible?: boolean;
  widgets?: string[];
  extensionHeaders?: string[];
  extensionFooters?: string[];
  thinking?: string;
  thinkingSupported?: boolean;
  autoCompaction?: boolean;
  subscription?: boolean;
  availableProviderCount?: number;
  activity?: {
    phase: string;
    startedAt: number;
    retryAt?: number;
    attempt?: number;
    cancellable?: boolean;
  };
  activityFrame?: number;
}

export interface TuiUsageSummary {
  total: NormalizedUsage;
  latestCacheHitRate?: number;
}

export interface TuiLimits {
  maxTranscriptBytes: number;
  maxTranscriptEntries: number;
  maxToolPreviewBytes: number;
  maxEditorBytes: number;
  maxHistoryEntries: number;
  maxUndoEntries: number;
  maxPickerItems: number;
}

export type TuiAction =
  | { type: "submit"; text: string; images?: readonly TuiInputImageAttachment[]; recoveredImages?: readonly ImageBlock[]; recoveredQueueDraft?: true }
  | { type: "steer"; text: string; images?: readonly TuiInputImageAttachment[]; recoveredImages?: readonly ImageBlock[]; recoveredQueueDraft?: true }
  | { type: "follow_up"; text: string; images?: readonly TuiInputImageAttachment[]; recoveredImages?: readonly ImageBlock[]; recoveredQueueDraft?: true }
  | { type: "queue_restore_discard" }
  | { type: "paste_image" }
  | { type: "cancel" }
  | { type: "exit" }
  | { type: "dequeue" }
  | { type: "copy" }
  | { type: "copy_text"; text: string; label: string }
  | { type: "suspend" }
  | { type: "session_open" }
  | { type: "session_scope"; scope: "current" | "all" }
  | { type: "session_search"; scope: "current" | "all"; query: string }
  | { type: "session_more"; scope: "current" | "all"; query: string }
  | { type: "session_rename"; item: PickerItem; name: string; scope: "current" | "all"; query: string }
  | { type: "session_delete"; item: PickerItem; scope: "current" | "all"; query: string }
  | { type: "cycle_thinking" }
  | { type: "extension_shortcut"; shortcut: string; generation: AbortSignal }
  | { type: "command"; item: PickerItem }
  | { type: "select"; picker: Exclude<PickerKind, "command" | "generic">; item: PickerItem }
  | { type: "signal"; signal: NodeJS.Signals }
  | { type: "error"; error: Error };

export interface TuiExtensionShortcut {
  shortcut: string;
  description?: string;
}

export interface TuiCommandArgumentCompletion {
  value: string;
  label?: string;
  detail?: string;
}

export interface TuiAutocompleteCompletion {
  /** Grapheme-indexed replacement range in the unchanged editor snapshot. */
  start: number;
  end: number;
  value: string;
  label?: string;
  detail?: string;
}

export type TuiAutocompleteProvider = (
  text: string,
  cursor: number,
  signal: AbortSignal,
) => readonly TuiAutocompleteCompletion[] | null | Promise<readonly TuiAutocompleteCompletion[] | null>;

export interface TuiEditorMiddlewareEvent {
  key: string;
  text?: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export interface TuiEditorMiddlewareSnapshot {
  text: string;
  /** Grapheme index. */
  cursor: number;
}

export type TuiEditorMiddlewareResult =
  | { action: "pass" }
  | { action: "handled" }
  | { action: "replace"; text: string; cursor?: number };

export type TuiEditorMiddleware = (
  event: Readonly<TuiEditorMiddlewareEvent>,
  snapshot: Readonly<TuiEditorMiddlewareSnapshot>,
  signal: AbortSignal,
) => TuiEditorMiddlewareResult | void;

/** Receives sanitized, decoded key events without taking ownership of input. */
export type TuiNormalizedKeyObserver = (event: Readonly<RuntimeUiKeyEvent>) => void;

export interface TuiWorkingIndicatorOptions {
  readonly frames: readonly string[];
  readonly intervalMs: number;
  /** @internal Distinguishes a deliberately hidden direct-extension indicator from the default spinner. */
  readonly hidden?: boolean;
}

export interface TuiThemeChange {
  previous: ThemeName;
  current: ThemeName;
  available: readonly string[];
  reason: "selection" | "catalog" | "extension" | "terminal";
}

export type TuiCommandCompletionProvider = (
  command: string,
  prefix: string,
  signal: AbortSignal,
) => readonly TuiCommandArgumentCompletion[] | null | Promise<readonly TuiCommandArgumentCompletion[] | null>;

export interface TuiControllerOptions {
  input?: TuiInput;
  output?: TuiOutput;
  environment?: NodeJS.ProcessEnv;
  mode?: TuiMode | "auto";
  theme?: ThemeName;
  limits?: Partial<TuiLimits>;
  keybindings?: Keybindings;
  signalSource?: TuiSignalSource;
  handleSignals?: boolean;
  onAction?: (action: TuiAction) => void;
  doubleEscapeAction?: "tree" | "fork" | "none";
  operatorPreferences?: Partial<TuiOperatorPreferences>;
}

export interface TuiOperatorPreferences {
  hideThinkingBlock: boolean;
  showCacheMissNotices: boolean;
  externalEditor: string | undefined;
  treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
  editorPaddingX: number;
  outputPad: 0 | 1;
  autocompleteMaxVisible: number | undefined;
  showHardwareCursor: boolean;
  showImages: boolean;
  imageWidthCells: number;
  clearOnShrink: boolean;
  codeBlockIndent: string;
}

export interface TranscriptEntry {
  id: string;
  kind: "startup" | "user" | "assistant" | "reasoning" | "tool" | "status" | "warning" | "error";
  text: string;
  compactText?: string;
  title?: string;
  summary?: string;
  inputPreview?: string;
  status?: "pending" | "running" | "completed" | "failed" | "in_doubt";
  expanded?: boolean;
  callId?: string;
  hasToolCalls?: boolean;
  images?: readonly TranscriptImage[];
  extension?: {
    type: "entry" | "message";
    customType: string;
  };
  toolData?: {
    input?: JsonValue;
    progress?: {
      stdout: string;
      stderr: string;
      stdoutBytes: number;
      stderrBytes: number;
      elapsedMs?: number;
      truncated: boolean;
    };
    partialResult?: {
      content: string;
      isError: boolean;
      metadata?: JsonValue;
      truncated?: boolean;
    };
    result?: {
      content: string;
      isError: boolean;
      metadata?: JsonValue;
    };
  };
}

/** Durable direct-extension entries that may participate in the transcript. */
export type TuiSessionEntry = CustomEntry | CustomMessageEntry;

/** One ordered history item, either a core runtime event or a direct session entry. */
export type TuiTranscriptItem = EventEnvelope | TuiSessionEntry;

export interface TuiViewState {
  context: TuiContext;
  transcript: readonly TranscriptEntry[];
  transcriptOffset: number;
  editorText: string;
  editorCursor: number;
  editorBlock?: RuntimeUiBlock;
  rawEditorBlock?: TuiRawBlock;
  inputLabel: string;
  inputMode: "normal" | "follow_up";
  usage?: TuiUsageSummary;
  notice?: string;
  queuedMessages?: readonly QueuedMessage[];
  inputImages?: readonly TuiInputImageSummary[];
  runtimeComponent?: RuntimeUiBlock;
  rawRuntimeComponent?: TuiRawBlock;
  runtimeHeaderComponents?: readonly RuntimeUiBlock[];
  runtimeFooterComponents?: readonly RuntimeUiBlock[];
  runtimeWidgetComponents?: readonly RuntimeUiBlock[];
  runtimeWidgetBelowComponents?: readonly RuntimeUiBlock[];
  runtimeHeaderReplacement?: RuntimeUiBlock;
  runtimeFooterReplacement?: RuntimeUiBlock;
  rawHeaderComponents?: readonly TuiRawBlock[];
  rawFooterComponents?: readonly TuiRawBlock[];
  rawWidgetComponents?: readonly TuiRawBlock[];
  rawWidgetBelowComponents?: readonly TuiRawBlock[];
  rawHeaderReplacement?: TuiRawBlock;
  rawFooterReplacement?: TuiRawBlock;
  workingIndicator?: TuiWorkingIndicatorOptions;
  hiddenReasoningLabel?: string;
  runtimeOverlay?: {
    block: RuntimeUiBlock;
    options: RuntimeUiOverlayOptions;
    focused: boolean;
    width: number;
  };
  runtimeOverlays?: readonly {
    block: RuntimeUiBlock;
    options: RuntimeUiOverlayOptions;
    focused: boolean;
    width: number;
  }[];
  rawRuntimeOverlays?: readonly {
    block: TuiRawBlock;
    options: RuntimeUiOverlayOptions;
    focused: boolean;
    width: number;
  }[];
  overlay?: {
    title: string;
    pickerKind?: PickerKind;
    inline?: boolean;
    settings?: boolean;
    selectedDescription?: string;
    states?: readonly string[];
    queryLabel?: string;
    query: string;
    selected: number;
    items: readonly PickerItem[];
    hints?: readonly string[];
    status?: string;
    emptyMessage?: string;
    maxVisible?: number;
  };
}

/** Trusted component output. Control sequences are preserved for direct extensions. */
export interface TuiRawBlock {
  lines: readonly string[];
  cursor?: { row: number; column: number };
}

export interface Frame {
  text: string;
  cursor?: { row: number; column: number };
  images?: readonly TerminalImagePlacement[];
}

export interface PickerCatalog {
  command?: PickerItem[];
  model?: PickerItem<ModelInfo | string>[];
  provider?: PickerItem<string>[];
  session?: PickerItem<string>[];
}

export type EventRenderer = (event: EventEnvelope) => void;
