import { byteTruncate, sanitizeTerminalText, splitGraphemes } from "./internal-unicode.js";
import { findWordBackward, findWordForward } from "./word-navigation.js";
import { wordWrapLine } from "./word-wrap.js";

export interface EditorPasteSnapshot {
  start: number;
  end: number;
  label: string;
  payload: string;
}

export interface EditorSnapshot {
  text: string;
  cursor: number;
  pastes?: EditorPasteSnapshot[];
}

export interface EditorOptions {
  maxBytes?: number;
  maxHistoryEntries?: number;
  maxUndoEntries?: number;
}

/** Complete editor contract used by the interactive controller. */
export interface TuiEditorImplementation {
  readonly text: string;
  /** Grapheme-indexed cursor. */
  readonly cursor: number;
  readonly length: number;
  readonly empty: boolean;
  snapshot(): EditorSnapshot;
  restore(snapshot: EditorSnapshot): void;
  setText(value: string, cursor?: number): void;
  clear(options?: { recordUndo?: boolean }): void;
  insert(value: string): void;
  insertPaste(value: string): void;
  backspace(): void;
  deleteForward(): void;
  deleteToLineStart(): void;
  deleteToLineEnd(): void;
  deleteWordBackward(): void;
  deleteWordForward(): void;
  moveLeft(word?: boolean): void;
  moveRight(word?: boolean): void;
  moveHome(document?: boolean): void;
  moveEnd(document?: boolean): void;
  moveUp(width?: number): void;
  moveDown(width?: number): void;
  movePage(direction: -1 | 1, width: number, rows: number): boolean;
  hasMultipleVisualRows(width: number): boolean;
  jumpToCharacter(value: string, direction: -1 | 1): boolean;
  yank(): boolean;
  yankPop(): boolean;
  undo(): boolean;
  redo(): boolean;
  commitHistory(): string;
  historyPrevious(): boolean;
  historyNext(): boolean;
}

interface PasteMarker extends EditorPasteSnapshot {
  ordinal: number;
}

interface FragmentMarker {
  start: number;
  end: number;
  payload: string;
}

interface EditorFragment {
  graphemes: string[];
  pastes: FragmentMarker[];
}

interface VisualLineMap {
  start: number;
  end: number;
  logicalStart: number;
  logicalEnd: number;
}

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_HISTORY = 100;
const DEFAULT_MAX_UNDO = 100;
const MAX_PASTE_MARKERS = 100;
const MAX_KILL_RING_ENTRIES = 60;
const LARGE_PASTE_CHARACTERS = 1_000;
const LARGE_PASTE_LINES = 10;
const UNBOUNDED_VISUAL_WIDTH = 1_000_000_000;

function same(left: EditorSnapshot | undefined, right: EditorSnapshot): boolean {
  if (left?.text !== right.text || left.cursor !== right.cursor) return false;
  const leftPastes = left.pastes ?? [];
  const rightPastes = right.pastes ?? [];
  return leftPastes.length === rightPastes.length && leftPastes.every((paste, index) => {
    const candidate = rightPastes[index];
    return candidate !== undefined && paste.start === candidate.start && paste.end === candidate.end
      && paste.label === candidate.label && paste.payload === candidate.payload;
  });
}

function pasteLabel(ordinal: number, payload: string): string {
  const lines = payload.split("\n").length;
  const detail = lines > LARGE_PASTE_LINES ? `+${lines} lines` : `${[...payload].length} chars`;
  return `[paste #${ordinal} ${detail}]`;
}

function wordClass(value: string): "space" | "word" | "punctuation" | "symbol" {
  if (/^\s$/u.test(value)) return "space";
  if (/[\p{Letter}\p{Number}\p{Mark}\p{Connector_Punctuation}]/u.test(value)) return "word";
  if (/\p{Punctuation}/u.test(value)) return "punctuation";
  return "symbol";
}

function findGraphemes(haystack: readonly string[], needle: readonly string[], from: number): number {
  if (needle.length === 0) return -1;
  for (let start = Math.max(0, from); start + needle.length <= haystack.length; start += 1) {
    if (needle.every((value, index) => haystack[start + index] === value)) return start;
  }
  return -1;
}

function concatFragments(left: EditorFragment, right: EditorFragment): EditorFragment {
  return {
    graphemes: [...left.graphemes, ...right.graphemes],
    pastes: [
      ...left.pastes.map((paste) => ({ ...paste })),
      ...right.pastes.map((paste) => ({ ...paste, start: paste.start + left.graphemes.length, end: paste.end + left.graphemes.length })),
    ],
  };
}

export class MultilineEditor implements TuiEditorImplementation {
  readonly #maxBytes: number;
  readonly #maxHistory: number;
  readonly #maxUndo: number;
  #graphemes: string[] = [];
  #pastes: PasteMarker[] = [];
  #cursor = 0;
  #preferredColumn: number | undefined;
  #undo: EditorSnapshot[] = [];
  #redo: EditorSnapshot[] = [];
  #history: EditorSnapshot[] = [];
  #historyIndex = -1;
  #historyDraft: EditorSnapshot | undefined;
  #killRing: EditorFragment[] = [];
  #lastAction: "insert-word" | "insert-boundary" | "insert-newline" | "kill-forward" | "kill-backward" | "yank" | "yank-pop" | undefined;
  #lastYank: { start: number; end: number; ringIndex: number } | undefined;
  #killHead = 0;
  #snappedFromCursor: number | undefined;

  constructor(options: EditorOptions = {}) {
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#maxHistory = options.maxHistoryEntries ?? DEFAULT_MAX_HISTORY;
    this.#maxUndo = options.maxUndoEntries ?? DEFAULT_MAX_UNDO;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1) throw new RangeError("maxBytes must be positive");
    if (!Number.isSafeInteger(this.#maxHistory) || this.#maxHistory < 1) throw new RangeError("maxHistoryEntries must be positive");
    if (!Number.isSafeInteger(this.#maxUndo) || this.#maxUndo < 1) throw new RangeError("maxUndoEntries must be positive");
  }

  get text(): string {
    return this.#graphemes.join("");
  }

  get cursor(): number {
    return this.#cursor;
  }

  get length(): number {
    return this.#graphemes.length;
  }

  get empty(): boolean {
    return this.#graphemes.length === 0;
  }

  snapshot(): EditorSnapshot {
    return {
      text: this.text,
      cursor: this.#cursor,
      ...(this.#pastes.length === 0
        ? {}
        : { pastes: this.#pastes.map(({ start, end, label, payload }) => ({ start, end, label, payload })) }),
    };
  }

  restore(snapshot: EditorSnapshot): void {
    const text = byteTruncate(sanitizeTerminalText(snapshot.text), this.#maxBytes);
    this.#graphemes = splitGraphemes(text);
    this.#pastes = [];
    let expandedBytes = Buffer.byteLength(text, "utf8");
    let displayBytes = expandedBytes;
    let previousEnd = 0;
    const candidates = [...(snapshot.pastes ?? [])].sort((left, right) => left.start - right.start).slice(0, MAX_PASTE_MARKERS);
    for (const candidate of candidates) {
      if (!Number.isSafeInteger(candidate.start) || !Number.isSafeInteger(candidate.end)
        || candidate.start < previousEnd || candidate.start < 0 || candidate.end <= candidate.start
        || candidate.end > this.#graphemes.length) continue;
      const label = sanitizeTerminalText(candidate.label);
      const payload = byteTruncate(sanitizeTerminalText(candidate.payload), this.#maxBytes);
      if (!/^\[paste #\d+ (?:\+\d+ lines|\d+ chars)\]$/u.test(label)
        || this.#graphemes.slice(candidate.start, candidate.end).join("") !== label
        || (/\+(\d+) lines/u.test(label) && Number(/\+(\d+) lines/u.exec(label)?.[1]) !== payload.split("\n").length)
        || (/(\d+) chars/u.test(label) && Number(/(\d+) chars/u.exec(label)?.[1]) !== [...payload].length)) continue;
      const selectedBytes = expandedBytes - Buffer.byteLength(label, "utf8") + Buffer.byteLength(payload, "utf8");
      const canonicalLabel = pasteLabel(this.#pastes.length + 1, payload);
      const selectedDisplayBytes = displayBytes - Buffer.byteLength(label, "utf8") + Buffer.byteLength(canonicalLabel, "utf8");
      if (selectedBytes > this.#maxBytes || selectedDisplayBytes > this.#maxBytes) continue;
      expandedBytes = selectedBytes;
      displayBytes = selectedDisplayBytes;
      this.#pastes.push({ ...candidate, label, payload, ordinal: this.#pastes.length + 1 });
      previousEnd = candidate.end;
    }
    const requestedCursor = Number.isSafeInteger(snapshot.cursor) ? snapshot.cursor : this.#graphemes.length;
    this.#cursor = Math.max(0, Math.min(requestedCursor, this.#graphemes.length));
    this.#cursor = this.#cursorBoundary(this.#cursor);
    this.#renumberPastes();
    this.#preferredColumn = undefined;
    this.#snappedFromCursor = undefined;
    this.#historyIndex = -1;
    this.#historyDraft = undefined;
    this.#breakAction();
  }

  setText(value: string, cursor?: number): void {
    this.#recordUndo();
    const safe = byteTruncate(sanitizeTerminalText(value), this.#maxBytes);
    const graphemes = splitGraphemes(safe);
    const pastes: EditorPasteSnapshot[] = [];
    let from = 0;
    for (const paste of this.#pastes) {
      const label = splitGraphemes(paste.label);
      const start = findGraphemes(graphemes, label, from);
      if (start < 0) continue;
      pastes.push({ start, end: start + label.length, label: paste.label, payload: paste.payload });
      from = start + label.length;
    }
    this.restore({ text: safe, cursor: cursor ?? graphemes.length, ...(pastes.length === 0 ? {} : { pastes }) });
    this.#redo = [];
  }

  clear(options: { recordUndo?: boolean } = {}): void {
    if (this.empty) return;
    if (options.recordUndo !== false) this.#recordUndo();
    this.#graphemes = [];
    this.#pastes = [];
    this.#cursor = 0;
    this.#preferredColumn = undefined;
    this.#snappedFromCursor = undefined;
    this.#redo = [];
    this.#historyIndex = -1;
    this.#historyDraft = undefined;
    this.#breakAction();
  }

  insert(value: string): void {
    this.#insertPlain(value);
  }

  insertPaste(value: string): void {
    const safe = sanitizeTerminalText(value);
    if (safe === "") return;
    const lineCount = safe.split("\n").length;
    const large = lineCount > LARGE_PASTE_LINES || [...safe].length > LARGE_PASTE_CHARACTERS;
    if (!large) {
      this.#insertPlain(safe);
      return;
    }
    if (this.#pastes.length >= MAX_PASTE_MARKERS) return;
    const available = Math.max(0, this.#maxBytes - this.#expandedByteLength());
    const payload = byteTruncate(safe, available);
    if (payload === "") return;
    const label = pasteLabel(this.#pastes.length + 1, payload);
    if (Buffer.byteLength(this.text, "utf8") + Buffer.byteLength(label, "utf8") > this.#maxBytes) return;
    this.#recordUndo();
    this.#breakAction();
    const start = this.#cursor;
    const markerGraphemes = splitGraphemes(label);
    this.#shiftPastes(start, markerGraphemes.length);
    this.#graphemes.splice(start, 0, ...markerGraphemes);
    this.#pastes.push({ start, end: start + markerGraphemes.length, label, payload, ordinal: this.#pastes.length + 1 });
    this.#cursor = start + markerGraphemes.length;
    this.#renumberPastes();
    this.#finishMutation();
  }

  backspace(): void {
    if (this.#cursor === 0) return;
    this.#breakAction();
    const previous = this.#unitBefore(this.#cursor);
    if (previous !== undefined) this.#deleteRange(previous.start, this.#cursor);
  }

  deleteForward(): void {
    if (this.#cursor >= this.#graphemes.length) return;
    this.#breakAction();
    const next = this.#unitAt(this.#cursor);
    if (next !== undefined) this.#deleteRange(this.#cursor, next.end);
  }

  deleteToLineStart(): void {
    const { start } = this.#lineBounds(this.#cursor);
    const selectedStart = start === this.#cursor && this.#cursor > 0 && this.#graphemes[this.#cursor - 1] === "\n"
      ? this.#cursor - 1
      : start;
    if (selectedStart === this.#cursor) return;
    const removed = this.#deleteRange(selectedStart, this.#cursor);
    if (removed !== undefined) this.#recordKill(removed, "backward");
  }

  deleteToLineEnd(): void {
    const bounds = this.#lineBounds(this.#cursor);
    const end = bounds.end === this.#cursor && this.#graphemes[bounds.end] === "\n" ? bounds.end + 1 : bounds.end;
    if (end === this.#cursor) return;
    const removed = this.#deleteRange(this.#cursor, end);
    if (removed !== undefined) this.#recordKill(removed, "forward");
  }

  deleteWordBackward(): void {
    if (this.#cursor === 0) return;
    let probe = this.#cursor;
    if (this.#graphemes[probe - 1] === "\n") probe -= 1;
    else {
      while (probe > 0 && this.#unitBefore(probe)?.classification === "space") probe = this.#unitBefore(probe)!.start;
      const paste = this.#pasteAt(probe - 1);
      if (paste !== undefined) probe = paste.start;
      else probe = this.#graphemeIndex(findWordBackward(this.text, this.#codeUnitOffset(this.#cursor)));
    }
    const start = probe;
    const removed = this.#deleteRange(start, this.#cursor);
    if (removed !== undefined) this.#recordKill(removed, "backward");
  }

  deleteWordForward(): void {
    if (this.#cursor >= this.#graphemes.length) return;
    let probe = this.#cursor;
    if (this.#graphemes[probe] === "\n") probe += 1;
    else {
      while (probe < this.#graphemes.length && this.#unitAt(probe)?.classification === "space") probe = this.#unitAt(probe)!.end;
      const paste = this.#pasteAt(probe);
      if (paste !== undefined) probe = paste.end;
      else probe = this.#graphemeIndex(findWordForward(this.text, this.#codeUnitOffset(this.#cursor)));
    }
    const end = probe;
    const removed = this.#deleteRange(this.#cursor, end);
    if (removed !== undefined) this.#recordKill(removed, "forward");
  }

  moveLeft(word = false): void {
    this.#breakAction();
    if (!word) this.#cursor = this.#unitBefore(this.#cursor)?.start ?? 0;
    else {
      let probe = this.#cursor;
      if (this.#graphemes[probe - 1] === "\n") probe -= 1;
      else {
        while (probe > 0 && this.#unitBefore(probe)?.classification === "space") probe = this.#unitBefore(probe)!.start;
        const paste = this.#pasteAt(probe - 1);
        probe = paste?.start ?? this.#graphemeIndex(findWordBackward(this.text, this.#codeUnitOffset(this.#cursor)));
      }
      this.#cursor = probe;
    }
    this.#preferredColumn = undefined;
    this.#snappedFromCursor = undefined;
  }

  moveRight(word = false): void {
    this.#breakAction();
    if (!word) this.#cursor = this.#unitAt(this.#cursor)?.end ?? this.#graphemes.length;
    else {
      let probe = this.#cursor;
      if (this.#graphemes[probe] === "\n") probe += 1;
      else {
        while (probe < this.#graphemes.length && this.#unitAt(probe)?.classification === "space") probe = this.#unitAt(probe)!.end;
        const paste = this.#pasteAt(probe);
        probe = paste?.end ?? this.#graphemeIndex(findWordForward(this.text, this.#codeUnitOffset(this.#cursor)));
      }
      this.#cursor = probe;
    }
    this.#preferredColumn = undefined;
    this.#snappedFromCursor = undefined;
  }

  moveHome(document = false): void {
    this.#breakAction();
    this.#cursor = document ? 0 : this.#lineBounds(this.#cursor).start;
    this.#preferredColumn = undefined;
    this.#snappedFromCursor = undefined;
  }

  moveEnd(document = false): void {
    this.#breakAction();
    this.#cursor = document ? this.#graphemes.length : this.#lineBounds(this.#cursor).end;
    this.#preferredColumn = undefined;
    this.#snappedFromCursor = undefined;
  }

  moveUp(width = UNBOUNDED_VISUAL_WIDTH): void {
    this.#moveVertical(-1, width, 1);
  }

  moveDown(width = UNBOUNDED_VISUAL_WIDTH): void {
    this.#moveVertical(1, width, 1);
  }

  movePage(direction: -1 | 1, width: number, rows: number): boolean {
    return this.#moveVertical(direction, width, Math.max(1, Math.floor(rows) - 1));
  }

  hasMultipleVisualRows(width: number): boolean {
    return this.#visualLines(width).length > this.text.split("\n").length;
  }

  jumpToCharacter(value: string, direction: -1 | 1): boolean {
    this.#breakAction();
    const target = splitGraphemes(sanitizeTerminalText(value))[0];
    if (target === undefined || target === "\n") return false;
    if (direction > 0) {
      for (let index = this.#cursor + 1; index < this.#graphemes.length; index += 1) {
        const paste = this.#pasteAt(index);
        if (paste !== undefined) {
          index = paste.end - 1;
          continue;
        }
        if (this.#graphemes[index] === target) {
          this.#cursor = index;
          this.#preferredColumn = undefined;
          this.#snappedFromCursor = undefined;
          return true;
        }
      }
      return false;
    }
    for (let index = this.#cursor - 1; index >= 0; index -= 1) {
      const paste = this.#pasteAt(index);
      if (paste !== undefined) {
        index = paste.start;
        continue;
      }
      if (this.#graphemes[index] === target) {
        this.#cursor = index;
        this.#preferredColumn = undefined;
        this.#snappedFromCursor = undefined;
        return true;
      }
    }
    return false;
  }

  yank(): boolean {
    const fragment = this.#killRing[this.#killHead];
    if (fragment === undefined || this.#pastes.length + fragment.pastes.length > MAX_PASTE_MARKERS
      || this.#expandedByteLength() + this.#fragmentByteLength(fragment) > this.#maxBytes) return false;
    const material = this.#materializeFragment(fragment);
    if (Buffer.byteLength(this.text, "utf8") + Buffer.byteLength(material.graphemes.join(""), "utf8") > this.#maxBytes) return false;
    this.#recordUndo();
    this.#breakAction();
    const inserted = this.#insertFragment(fragment);
    if (inserted === undefined) return false;
    this.#lastAction = "yank";
    this.#lastYank = { ...inserted, ringIndex: this.#killHead };
    this.#finishMutation();
    return true;
  }

  yankPop(): boolean {
    const previous = this.#lastYank;
    if ((this.#lastAction !== "yank" && this.#lastAction !== "yank-pop") || previous === undefined || this.#killRing.length < 2) return false;
    const ringIndex = (previous.ringIndex + 1) % this.#killRing.length;
    const replacement = this.#killRing[ringIndex]!;
    const current = this.#fragment(previous.start, previous.end);
    if (this.#pastes.length - current.pastes.length + replacement.pastes.length > MAX_PASTE_MARKERS) return false;
    const projected = this.#expandedByteLength() - this.#fragmentByteLength(current) + this.#fragmentByteLength(replacement);
    if (projected > this.#maxBytes) return false;
    const material = this.#materializeFragment(replacement);
    const projectedDisplay = Buffer.byteLength(this.text, "utf8")
      - Buffer.byteLength(current.graphemes.join(""), "utf8")
      + Buffer.byteLength(material.graphemes.join(""), "utf8");
    if (projectedDisplay > this.#maxBytes) return false;
    this.#recordUndo();
    this.#lastAction = undefined;
    this.#lastYank = undefined;
    this.#deleteRange(previous.start, previous.end, false);
    const inserted = this.#insertFragment(replacement);
    if (inserted === undefined) return false;
    this.#lastAction = "yank-pop";
    this.#lastYank = { ...inserted, ringIndex };
    this.#killHead = ringIndex;
    this.#finishMutation();
    return true;
  }

  undo(): boolean {
    const previous = this.#undo.pop();
    if (previous === undefined) return false;
    this.#pushBounded(this.#redo, this.snapshot());
    this.restore(previous);
    return true;
  }

  redo(): boolean {
    const next = this.#redo.pop();
    if (next === undefined) return false;
    this.#pushBounded(this.#undo, this.snapshot());
    this.restore(next);
    return true;
  }

  commitHistory(): string {
    const value = this.#expandedText();
    if (value.trim() !== "" && this.#expandedSnapshot(this.#history.at(-1)) !== value) {
      this.#history.push(this.snapshot());
      if (this.#history.length > this.#maxHistory) this.#history.splice(0, this.#history.length - this.#maxHistory);
    }
    this.#historyIndex = -1;
    this.#historyDraft = undefined;
    return value;
  }

  historyPrevious(): boolean {
    if (this.#history.length === 0) return false;
    let draft = this.#historyDraft;
    let index = this.#historyIndex;
    if (this.#historyIndex < 0) {
      draft = this.snapshot();
      index = this.#history.length - 1;
    } else if (this.#historyIndex > 0) index -= 1;
    const selected = this.#history[index];
    if (selected === undefined) return false;
    this.restore({ ...selected, cursor: Number.MAX_SAFE_INTEGER });
    this.#historyIndex = Math.max(0, index);
    this.#historyDraft = draft;
    return true;
  }

  historyNext(): boolean {
    if (this.#historyIndex < 0) return false;
    const draft = this.#historyDraft;
    if (this.#historyIndex < this.#history.length - 1) {
      const index = this.#historyIndex + 1;
      const selected = this.#history[index];
      if (selected === undefined) return false;
      this.restore({ ...selected, cursor: Number.MAX_SAFE_INTEGER });
      this.#historyIndex = Math.min(this.#history.length - 1, index);
      this.#historyDraft = draft;
      return true;
    }
    this.restore(draft ?? { text: "", cursor: 0 });
    this.#historyIndex = -1;
    this.#historyDraft = undefined;
    return true;
  }

  #insertPlain(value: string): void {
    const safe = sanitizeTerminalText(value);
    if (safe === "") return;
    const available = Math.max(0, Math.min(
      this.#maxBytes - this.#expandedByteLength(),
      this.#maxBytes - Buffer.byteLength(this.text, "utf8"),
    ));
    const selected = byteTruncate(safe, available);
    if (selected === "") return;
    const inserted = splitGraphemes(selected);
    const single = inserted.length === 1;
    const insertionAction = single && inserted[0] === "\n"
      ? "insert-newline"
      : single && /^\s$/u.test(inserted[0] ?? "") ? "insert-boundary" : "insert-word";
    const coalesces = single && insertionAction === "insert-word"
      && (this.#lastAction === "insert-word" || this.#lastAction === "insert-boundary");
    if (!coalesces) this.#recordUndo();
    if (this.#lastAction !== "insert-word" && this.#lastAction !== "insert-boundary" && this.#lastAction !== "insert-newline") this.#breakAction();
    this.#lastYank = undefined;
    this.#shiftPastes(this.#cursor, inserted.length);
    this.#graphemes.splice(this.#cursor, 0, ...inserted);
    this.#cursor += inserted.length;
    this.#finishMutation();
    this.#lastAction = single ? insertionAction : undefined;
  }

  #deleteRange(startValue: number, endValue: number, recordUndo = true): EditorFragment | undefined {
    let start = Math.max(0, Math.min(startValue, this.#graphemes.length));
    let end = Math.max(start, Math.min(endValue, this.#graphemes.length));
    for (const paste of this.#pastes) {
      if (start < paste.end && end > paste.start) {
        start = Math.min(start, paste.start);
        end = Math.max(end, paste.end);
      }
    }
    if (start === end) return undefined;
    const fragment = this.#fragment(start, end);
    if (recordUndo) this.#recordUndo();
    this.#graphemes.splice(start, end - start);
    const removed = end - start;
    this.#pastes = this.#pastes.flatMap((paste) => {
      if (paste.start < end && paste.end > start) return [];
      return [{ ...paste, start: paste.start >= end ? paste.start - removed : paste.start, end: paste.end >= end ? paste.end - removed : paste.end }];
    });
    this.#cursor = start;
    this.#renumberPastes();
    this.#finishMutation();
    return fragment;
  }

  #fragment(start: number, end: number): EditorFragment {
    return {
      graphemes: this.#graphemes.slice(start, end),
      pastes: this.#pastes.filter((paste) => paste.start >= start && paste.end <= end)
        .map((paste) => ({ start: paste.start - start, end: paste.end - start, payload: paste.payload })),
    };
  }

  #insertFragment(fragment: EditorFragment): { start: number; end: number } | undefined {
    if (this.#pastes.length + fragment.pastes.length > MAX_PASTE_MARKERS) return undefined;
    const material = this.#materializeFragment(fragment);
    if (material.graphemes.length === 0) return undefined;
    if (Buffer.byteLength(this.text, "utf8") + Buffer.byteLength(material.graphemes.join(""), "utf8") > this.#maxBytes) return undefined;
    const start = this.#cursor;
    this.#shiftPastes(start, material.graphemes.length);
    this.#graphemes.splice(start, 0, ...material.graphemes);
    this.#pastes.push(...material.pastes.map((paste, index): PasteMarker => ({
      start: start + paste.start,
      end: start + paste.end,
      payload: paste.payload,
      ordinal: this.#pastes.length + index + 1,
      label: this.#graphemes.slice(start + paste.start, start + paste.end).join(""),
    })));
    this.#cursor = start + material.graphemes.length;
    const [adjustedStart] = this.#renumberPastes([start]);
    return { start: adjustedStart ?? start, end: this.#cursor };
  }

  #materializeFragment(fragment: EditorFragment): EditorFragment {
    const graphemes: string[] = [];
    const pastes: FragmentMarker[] = [];
    let offset = 0;
    for (const paste of [...fragment.pastes].sort((left, right) => left.start - right.start)) {
      graphemes.push(...fragment.graphemes.slice(offset, paste.start));
      const label = splitGraphemes(pasteLabel(this.#pastes.length + pastes.length + 1, paste.payload));
      const start = graphemes.length;
      graphemes.push(...label);
      pastes.push({ start, end: graphemes.length, payload: paste.payload });
      offset = paste.end;
    }
    graphemes.push(...fragment.graphemes.slice(offset));
    return { graphemes, pastes };
  }

  #recordKill(fragment: EditorFragment, direction: "forward" | "backward"): void {
    const consecutive = this.#lastAction === "kill-forward" || this.#lastAction === "kill-backward";
    if (consecutive && this.#killRing[0] !== undefined) {
      this.#killRing[0] = direction === "backward"
        ? concatFragments(fragment, this.#killRing[0])
        : concatFragments(this.#killRing[0], fragment);
    } else {
      this.#killRing.unshift(fragment);
      this.#killHead = 0;
    }
    while (this.#killRing.length > MAX_KILL_RING_ENTRIES
      || this.#killRing.reduce((total, entry) => total + this.#fragmentByteLength(entry), 0) > this.#maxBytes) this.#killRing.pop();
    this.#lastAction = direction === "forward" ? "kill-forward" : "kill-backward";
    this.#lastYank = undefined;
  }

  #moveVertical(direction: -1 | 1, width: number, distance: number): boolean {
    this.#breakAction();
    const lines = this.#visualLines(width);
    const current = this.#findVisualLine(lines, this.#cursor);
    const target = Math.max(0, Math.min(lines.length - 1, current + direction * distance));
    if (target === current) {
      const next = direction < 0 ? this.#lineBounds(this.#cursor).start : this.#lineBounds(this.#cursor).end;
      const changed = next !== this.#cursor;
      this.#cursor = next;
      this.#preferredColumn = undefined;
      this.#snappedFromCursor = undefined;
      return changed;
    }
    return this.#moveToVisualLine(lines, current, target);
  }

  #visualLines(widthValue: number): VisualLineMap[] {
    const width = Number.isSafeInteger(widthValue) ? Math.max(1, widthValue) : UNBOUNDED_VISUAL_WIDTH;
    const result: VisualLineMap[] = [];
    let logicalStart = 0;
    while (logicalStart <= this.#graphemes.length) {
      let logicalEnd = logicalStart;
      while (logicalEnd < this.#graphemes.length && this.#graphemes[logicalEnd] !== "\n") logicalEnd += 1;
      const local = this.#graphemes.slice(logicalStart, logicalEnd);
      const line = local.join("");
      if (local.length === 0) result.push({ start: logicalStart, end: logicalStart, logicalStart, logicalEnd });
      else {
        const offsets = [0];
        for (const grapheme of local) offsets.push(offsets.at(-1)! + grapheme.length);
        const segments: Intl.SegmentData[] = [];
        let index = 0;
        while (index < local.length) {
          const paste = this.#pastes.find((candidate) => candidate.start === logicalStart + index && candidate.end <= logicalEnd);
          if (paste !== undefined) {
            const end = paste.end - logicalStart;
            segments.push({ segment: local.slice(index, end).join(""), index: offsets[index]!, input: line });
            index = end;
          } else {
            segments.push({ segment: local[index]!, index: offsets[index]!, input: line });
            index += 1;
          }
        }
        for (const chunk of wordWrapLine(line, width, segments)) {
          const start = offsets.findIndex((offset) => offset >= chunk.startIndex);
          const end = offsets.findIndex((offset) => offset >= chunk.endIndex);
          result.push({
            start: logicalStart + Math.max(0, start),
            end: logicalStart + Math.max(0, end),
            logicalStart,
            logicalEnd,
          });
        }
      }
      if (logicalEnd >= this.#graphemes.length) break;
      logicalStart = logicalEnd + 1;
    }
    return result.length > 0 ? result : [{ start: 0, end: 0, logicalStart: 0, logicalEnd: 0 }];
  }

  #findVisualLine(lines: readonly VisualLineMap[], position: number): number {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const last = lines[index + 1]?.logicalStart !== line.logicalStart;
      if (position >= line.start && (position < line.end || last && position === line.end)) return index;
    }
    return Math.max(0, lines.length - 1);
  }

  #moveToVisualLine(lines: readonly VisualLineMap[], currentIndex: number, targetIndex: number): boolean {
    const current = lines[currentIndex];
    const target = lines[targetIndex];
    if (current === undefined || target === undefined) return false;
    let currentColumn: number;
    if (this.#snappedFromCursor !== undefined) {
      const resolved = lines[this.#findVisualLine(lines, this.#snappedFromCursor)] ?? current;
      currentColumn = this.#snappedFromCursor - resolved.start;
    } else currentColumn = this.#cursor - current.start;

    const sourceLast = lines[currentIndex + 1]?.logicalStart !== current.logicalStart;
    const targetLast = lines[targetIndex + 1]?.logicalStart !== target.logicalStart;
    const sourceMaximum = sourceLast ? current.end - current.start : Math.max(0, current.end - current.start - 1);
    const targetMaximum = targetLast ? target.end - target.start : Math.max(0, target.end - target.start - 1);
    const hasPreferred = this.#preferredColumn !== undefined;
    const cursorInMiddle = currentColumn < sourceMaximum;
    const targetTooShort = targetMaximum < currentColumn;
    let selectedColumn: number;
    if (!hasPreferred || cursorInMiddle) {
      if (targetTooShort) {
        this.#preferredColumn = currentColumn;
        selectedColumn = targetMaximum;
      } else {
        this.#preferredColumn = undefined;
        selectedColumn = currentColumn;
      }
    } else if (targetTooShort || targetMaximum < this.#preferredColumn!) selectedColumn = targetMaximum;
    else {
      selectedColumn = this.#preferredColumn!;
      this.#preferredColumn = undefined;
    }

    const selected = Math.min(target.end, target.start + selectedColumn);
    const paste = this.#pasteAt(selected);
    if (paste !== undefined && selected > paste.start) {
      const continuation = paste.start < target.start;
      const movingDown = targetIndex > currentIndex;
      if (continuation && movingDown) {
        let next = targetIndex + 1;
        while (next < lines.length && lines[next]!.logicalStart === target.logicalStart && lines[next]!.start < paste.end) next += 1;
        if (next < lines.length) return this.#moveToVisualLine(lines, currentIndex, next);
      }
      const changed = this.#cursor !== paste.start;
      this.#snappedFromCursor = selected;
      this.#cursor = paste.start;
      return changed;
    }
    const changed = selected !== this.#cursor;
    this.#cursor = selected;
    this.#snappedFromCursor = undefined;
    return changed;
  }

  #unitBefore(position: number): { start: number; end: number; classification: string } | undefined {
    if (position <= 0) return undefined;
    const paste = this.#pasteAt(position - 1);
    if (paste !== undefined) return { start: paste.start, end: paste.end, classification: `paste:${paste.ordinal}` };
    const start = position - 1;
    return { start, end: position, classification: wordClass(this.#graphemes[start] ?? "") };
  }

  #unitAt(position: number): { start: number; end: number; classification: string } | undefined {
    if (position >= this.#graphemes.length) return undefined;
    const paste = this.#pasteAt(position);
    if (paste !== undefined) return { start: paste.start, end: paste.end, classification: `paste:${paste.ordinal}` };
    return { start: position, end: position + 1, classification: wordClass(this.#graphemes[position] ?? "") };
  }

  #pasteAt(position: number): PasteMarker | undefined {
    return this.#pastes.find((paste) => position >= paste.start && position < paste.end);
  }

  #cursorBoundary(position: number): number {
    const paste = this.#pasteAt(position);
    if (paste === undefined || position === paste.start) return position;
    return position - paste.start < paste.end - position ? paste.start : paste.end;
  }

  #lineBounds(position: number): { start: number; end: number } {
    let start = Math.max(0, Math.min(position, this.#graphemes.length));
    while (start > 0 && this.#graphemes[start - 1] !== "\n") start -= 1;
    let end = Math.max(0, Math.min(position, this.#graphemes.length));
    while (end < this.#graphemes.length && this.#graphemes[end] !== "\n") end += 1;
    return { start, end };
  }

  #codeUnitOffset(graphemeIndex: number): number {
    return this.#graphemes.slice(0, Math.max(0, Math.min(graphemeIndex, this.#graphemes.length))).join("").length;
  }

  #graphemeIndex(codeUnitOffset: number): number {
    return splitGraphemes(this.text.slice(0, Math.max(0, Math.min(codeUnitOffset, this.text.length)))).length;
  }

  #shiftPastes(position: number, amount: number): void {
    this.#pastes = this.#pastes.map((paste) => paste.start >= position
      ? { ...paste, start: paste.start + amount, end: paste.end + amount }
      : paste);
  }

  #renumberPastes(tracked: number[] = []): number[] {
    const positions = [...tracked];
    this.#pastes.sort((left, right) => left.start - right.start);
    for (let index = 0; index < this.#pastes.length; index += 1) {
      const paste = this.#pastes[index]!;
      const label = pasteLabel(index + 1, paste.payload);
      const replacement = splitGraphemes(label);
      const oldStart = paste.start;
      const oldEnd = paste.end;
      const oldLength = oldEnd - oldStart;
      const delta = replacement.length - oldLength;
      if (this.#graphemes.slice(oldStart, oldEnd).join("") !== label) {
        this.#graphemes.splice(oldStart, oldLength, ...replacement);
        paste.end = oldStart + replacement.length;
        for (const later of this.#pastes.slice(index + 1)) {
          later.start += delta;
          later.end += delta;
        }
        const adjust = (position: number): number => position <= oldStart
          ? position
          : position >= oldEnd ? position + delta : paste.end;
        this.#cursor = adjust(this.#cursor);
        for (let trackedIndex = 0; trackedIndex < positions.length; trackedIndex += 1) {
          positions[trackedIndex] = adjust(positions[trackedIndex] ?? 0);
        }
      }
      paste.ordinal = index + 1;
      paste.label = label;
    }
    return positions;
  }

  #expandedText(): string {
    let result = "";
    let offset = 0;
    for (const paste of this.#pastes) {
      result += this.#graphemes.slice(offset, paste.start).join("");
      result += paste.payload;
      offset = paste.end;
    }
    return result + this.#graphemes.slice(offset).join("");
  }

  #expandedSnapshot(snapshot: EditorSnapshot | undefined): string | undefined {
    if (snapshot === undefined) return undefined;
    const graphemes = splitGraphemes(snapshot.text);
    let result = "";
    let offset = 0;
    for (const paste of snapshot.pastes ?? []) {
      result += graphemes.slice(offset, paste.start).join("");
      result += paste.payload;
      offset = paste.end;
    }
    return result + graphemes.slice(offset).join("");
  }

  #expandedByteLength(): number {
    return Buffer.byteLength(this.#expandedText(), "utf8");
  }

  #fragmentByteLength(fragment: EditorFragment): number {
    let bytes = Buffer.byteLength(fragment.graphemes.join(""), "utf8");
    for (const paste of fragment.pastes) {
      bytes += Buffer.byteLength(paste.payload, "utf8")
        - Buffer.byteLength(fragment.graphemes.slice(paste.start, paste.end).join(""), "utf8");
    }
    return bytes;
  }

  #recordUndo(): void {
    const current = this.snapshot();
    if (!same(this.#undo.at(-1), current)) this.#pushBounded(this.#undo, current);
  }

  #pushBounded(target: EditorSnapshot[], value: EditorSnapshot): void {
    target.push(value);
    if (target.length > this.#maxUndo) target.splice(0, target.length - this.#maxUndo);
  }

  #finishMutation(): void {
    this.#preferredColumn = undefined;
    this.#snappedFromCursor = undefined;
    this.#redo = [];
    this.#leaveHistory();
  }

  #breakAction(): void {
    this.#lastAction = undefined;
    this.#lastYank = undefined;
  }

  #leaveHistory(): void {
    this.#historyIndex = -1;
    this.#historyDraft = undefined;
  }
}
