import { byteTruncate, graphemeWidth, sanitizeTerminalText, splitGraphemes } from "./unicode.js";

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

interface VisualPosition {
  row: number;
  column: number;
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
  return `[paste #${ordinal} +${payload.split("\n").length} lines]`;
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
  #lastAction: "kill-forward" | "kill-backward" | "yank" | "yank-pop" | undefined;
  #lastYank: { start: number; end: number; ringIndex: number } | undefined;

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
      if (!/^\[paste #\d+ \+\d+ lines\]$/u.test(label)
        || this.#graphemes.slice(candidate.start, candidate.end).join("") !== label
        || Number(/\+(\d+) lines/u.exec(label)?.[1]) !== payload.split("\n").length) continue;
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
    if (start === this.#cursor) return;
    const removed = this.#deleteRange(start, this.#cursor);
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
    let start = this.#cursor;
    while (start > 0 && this.#unitBefore(start)?.classification === "space") start = this.#unitBefore(start)!.start;
    const classification = this.#unitBefore(start)?.classification;
    while (start > 0 && this.#unitBefore(start)?.classification === classification) start = this.#unitBefore(start)!.start;
    const removed = this.#deleteRange(start, this.#cursor);
    if (removed !== undefined) this.#recordKill(removed, "backward");
  }

  deleteWordForward(): void {
    if (this.#cursor >= this.#graphemes.length) return;
    let end = this.#cursor;
    while (end < this.#graphemes.length && this.#unitAt(end)?.classification === "space") end = this.#unitAt(end)!.end;
    const classification = this.#unitAt(end)?.classification;
    while (end < this.#graphemes.length && this.#unitAt(end)?.classification === classification) end = this.#unitAt(end)!.end;
    const removed = this.#deleteRange(this.#cursor, end);
    if (removed !== undefined) this.#recordKill(removed, "forward");
  }

  moveLeft(word = false): void {
    this.#breakAction();
    if (!word) this.#cursor = this.#unitBefore(this.#cursor)?.start ?? 0;
    else {
      while (this.#cursor > 0 && this.#unitBefore(this.#cursor)?.classification === "space") this.#cursor = this.#unitBefore(this.#cursor)!.start;
      const classification = this.#unitBefore(this.#cursor)?.classification;
      while (this.#cursor > 0 && this.#unitBefore(this.#cursor)?.classification === classification) this.#cursor = this.#unitBefore(this.#cursor)!.start;
    }
    this.#preferredColumn = undefined;
  }

  moveRight(word = false): void {
    this.#breakAction();
    if (!word) this.#cursor = this.#unitAt(this.#cursor)?.end ?? this.#graphemes.length;
    else {
      const classification = this.#unitAt(this.#cursor)?.classification;
      if (classification !== "space") {
        while (this.#cursor < this.#graphemes.length && this.#unitAt(this.#cursor)?.classification === classification) {
          this.#cursor = this.#unitAt(this.#cursor)!.end;
        }
      }
      while (this.#cursor < this.#graphemes.length && this.#unitAt(this.#cursor)?.classification === "space") {
        this.#cursor = this.#unitAt(this.#cursor)!.end;
      }
    }
    this.#preferredColumn = undefined;
  }

  moveHome(document = false): void {
    this.#breakAction();
    this.#cursor = document ? 0 : this.#lineBounds(this.#cursor).start;
    this.#preferredColumn = undefined;
  }

  moveEnd(document = false): void {
    this.#breakAction();
    this.#cursor = document ? this.#graphemes.length : this.#lineBounds(this.#cursor).end;
    this.#preferredColumn = undefined;
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
    return (this.#visualPositions(width).at(-1)?.row ?? 0) > 0;
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
        return true;
      }
    }
    return false;
  }

  yank(): boolean {
    const fragment = this.#killRing[0];
    if (fragment === undefined || this.#pastes.length + fragment.pastes.length > MAX_PASTE_MARKERS
      || this.#expandedByteLength() + this.#fragmentByteLength(fragment) > this.#maxBytes) return false;
    const material = this.#materializeFragment(fragment);
    if (Buffer.byteLength(this.text, "utf8") + Buffer.byteLength(material.graphemes.join(""), "utf8") > this.#maxBytes) return false;
    this.#recordUndo();
    this.#breakAction();
    const inserted = this.#insertFragment(fragment);
    if (inserted === undefined) return false;
    this.#lastAction = "yank";
    this.#lastYank = { ...inserted, ringIndex: 0 };
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
    this.#recordUndo();
    this.#breakAction();
    const inserted = splitGraphemes(selected);
    this.#shiftPastes(this.#cursor, inserted.length);
    this.#graphemes.splice(this.#cursor, 0, ...inserted);
    this.#cursor += inserted.length;
    this.#finishMutation();
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
    } else this.#killRing.unshift(fragment);
    while (this.#killRing.length > MAX_KILL_RING_ENTRIES
      || this.#killRing.reduce((total, entry) => total + this.#fragmentByteLength(entry), 0) > this.#maxBytes) this.#killRing.pop();
    this.#lastAction = direction === "forward" ? "kill-forward" : "kill-backward";
    this.#lastYank = undefined;
  }

  #moveVertical(direction: -1 | 1, width: number, distance: number): boolean {
    this.#breakAction();
    const positions = this.#visualPositions(width);
    const current = positions[this.#cursor] ?? { row: 0, column: 0 };
    const lastRow = positions.at(-1)?.row ?? 0;
    const targetRow = Math.max(0, Math.min(lastRow, current.row + direction * distance));
    if (targetRow === current.row) {
      const next = direction < 0 ? this.#lineBounds(this.#cursor).start : this.#lineBounds(this.#cursor).end;
      const changed = next !== this.#cursor;
      this.#cursor = next;
      this.#preferredColumn = undefined;
      return changed;
    }
    const column = this.#preferredColumn ?? current.column;
    const boundaries = positions.map((position, index) => ({ ...position, index })).filter(({ index }) => this.#isCursorBoundary(index));
    let candidates = boundaries.filter((position) => position.row === targetRow);
    if (candidates.length === 0) {
      const directional = boundaries.filter((position) => direction > 0 ? position.row >= targetRow : position.row <= targetRow);
      const pool = directional.length === 0 ? boundaries : directional;
      const closest = Math.min(...pool.map((position) => Math.abs(position.row - targetRow)));
      candidates = pool.filter((position) => Math.abs(position.row - targetRow) === closest);
    }
    const before = candidates.filter((position) => position.column <= column);
    const selected = (before.length === 0 ? candidates : before).reduce((best, candidate) => {
      if (best === undefined) return candidate;
      if (before.length > 0) return candidate.column > best.column ? candidate : best;
      return candidate.column < best.column ? candidate : best;
    }, undefined as (VisualPosition & { index: number }) | undefined);
    if (selected === undefined) return false;
    const changed = selected.index !== this.#cursor;
    this.#cursor = selected.index;
    this.#preferredColumn = column;
    return changed;
  }

  #visualPositions(widthValue: number): VisualPosition[] {
    const width = Number.isSafeInteger(widthValue) ? Math.max(1, widthValue) : UNBOUNDED_VISUAL_WIDTH;
    const positions: VisualPosition[] = [];
    let row = 0;
    let column = 0;
    for (let index = 0; index <= this.#graphemes.length; index += 1) {
      if (column >= width) {
        row += 1;
        column = 0;
      }
      positions.push({ row, column });
      const grapheme = this.#graphemes[index];
      if (grapheme === undefined) break;
      if (grapheme === "\n") {
        row += 1;
        column = 0;
        continue;
      }
      const next = graphemeWidth(grapheme);
      if (column > 0 && column + next > width) {
        row += 1;
        column = 0;
      }
      column += next;
    }
    return positions;
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

  #isCursorBoundary(position: number): boolean {
    const paste = this.#pasteAt(position);
    return paste === undefined || position === paste.start;
  }

  #lineBounds(position: number): { start: number; end: number } {
    let start = Math.max(0, Math.min(position, this.#graphemes.length));
    while (start > 0 && this.#graphemes[start - 1] !== "\n") start -= 1;
    let end = Math.max(0, Math.min(position, this.#graphemes.length));
    while (end < this.#graphemes.length && this.#graphemes[end] !== "\n") end += 1;
    return { start, end };
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
