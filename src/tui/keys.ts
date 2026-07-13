import { TerminalInputBuffer, type TerminalInputToken } from "./input-buffer.js";

export interface KeyEvent {
  key: string;
  text?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  super?: boolean;
  hyper?: boolean;
  meta?: boolean;
  capsLock?: boolean;
  numLock?: boolean;
  keypad?: boolean;
  alternateKey?: string;
  baseLayoutKey?: string;
  eventType?: "press" | "repeat";
}

export type TerminalReply =
  | { type: "kitty_keyboard"; flags: number }
  | { type: "primary_device_attributes" };

interface DecodedKey {
  event: KeyEvent;
  enhanced: boolean;
}

type KeyModifiers = Pick<KeyEvent,
  "ctrl" | "alt" | "shift" | "super" | "hyper" | "meta" | "capsLock" | "numLock" | "eventType"
>;

const DUPLICATE_WINDOW_MS = 30;
const MAX_PENDING_REPLIES = 32;

const LEGACY_TILDE_KEYS = new Map<number, string>([
  [1, "home"], [2, "insert"], [3, "delete"], [4, "end"], [5, "pageup"], [6, "pagedown"], [7, "home"], [8, "end"],
  [11, "f1"], [12, "f2"], [13, "f3"], [14, "f4"], [15, "f5"], [17, "f6"], [18, "f7"], [19, "f8"],
  [20, "f9"], [21, "f10"], [23, "f11"], [24, "f12"], [25, "f13"], [26, "f14"], [28, "f15"],
  [29, "f16"], [31, "f17"], [32, "f18"], [33, "f19"], [34, "f20"],
]);

const KITTY_NAMED_KEYS = new Map<number, string>([
  [57358, "capslock"], [57359, "scrolllock"], [57360, "numlock"], [57361, "printscreen"], [57362, "pause"], [57363, "menu"],
]);

for (let index = 0; index < 23; index += 1) KITTY_NAMED_KEYS.set(57376 + index, `f${13 + index}`);

const KITTY_KEYPAD_KEYS = [
  "kp0", "kp1", "kp2", "kp3", "kp4", "kp5", "kp6", "kp7", "kp8", "kp9",
  "kpdecimal", "kpdivide", "kpmultiply", "kpsubtract", "kpadd", "kpenter", "kpequal", "kpseparator",
  "left", "right", "up", "down", "pageup", "pagedown", "home", "end", "insert", "delete", "begin",
] as const;

const SS3_KEYPAD = new Map<string, { key: string; text?: string }>([
  ["p", { key: "kp0", text: "0" }], ["q", { key: "kp1", text: "1" }], ["r", { key: "kp2", text: "2" }],
  ["s", { key: "kp3", text: "3" }], ["t", { key: "kp4", text: "4" }], ["u", { key: "kp5", text: "5" }],
  ["v", { key: "kp6", text: "6" }], ["w", { key: "kp7", text: "7" }], ["x", { key: "kp8", text: "8" }],
  ["y", { key: "kp9", text: "9" }], ["n", { key: "kpdecimal", text: "." }], ["o", { key: "kpdivide", text: "/" }],
  ["j", { key: "kpmultiply", text: "*" }], ["m", { key: "kpsubtract", text: "-" }], ["k", { key: "kpadd", text: "+" }],
  ["M", { key: "kpenter" }], ["X", { key: "kpequal", text: "=" }], ["l", { key: "kpseparator", text: "," }],
]);

function decimal(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function validCodePoint(value: number | undefined): value is number {
  return value !== undefined && value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff);
}

function modifierFields(group: string | undefined): { modifiers: KeyModifiers; release: boolean } {
  const fields = (group ?? "1").split(":");
  const encoded = Math.max(1, decimal(fields[0]) ?? 1) - 1;
  const event = decimal(fields[1]);
  return {
    modifiers: {
      ...(encoded & 4 ? { ctrl: true } : {}),
      ...(encoded & 2 ? { alt: true } : {}),
      ...(encoded & 1 ? { shift: true } : {}),
      ...(encoded & 8 ? { super: true } : {}),
      ...(encoded & 16 ? { hyper: true } : {}),
      ...(encoded & 32 ? { meta: true } : {}),
      ...(encoded & 64 ? { capsLock: true } : {}),
      ...(encoded & 128 ? { numLock: true } : {}),
      ...(event === 1 ? { eventType: "press" as const } : event === 2 ? { eventType: "repeat" as const } : {}),
    },
    release: event === 3,
  };
}

function controlEvent(code: number, alt = false): KeyEvent | undefined {
  const modifier = alt ? { alt: true as const } : {};
  if (code === 0x00) return { key: "space", ctrl: true, ...modifier };
  if (code >= 0x01 && code <= 0x1a) return { key: String.fromCharCode(96 + code), ctrl: true, ...modifier };
  if (code === 0x1c) return { key: "\\", ctrl: true, ...modifier };
  if (code === 0x1d) return { key: "]", ctrl: true, ...modifier };
  if (code === 0x1e) return { key: "^", ctrl: true, ...modifier };
  if (code === 0x1f) return { key: "_", ctrl: true, ...modifier };
  return undefined;
}

function printableCodePoint(value: number): boolean {
  return value >= 0x20 && value !== 0x7f && !(value >= 0x80 && value <= 0x9f);
}

function shortcutKey(code: number): string {
  if (code === 0x20) return "space";
  return String.fromCodePoint(code).toLowerCase();
}

function unicodeKeyEvent(
  code: number,
  shifted: number | undefined,
  baseLayout: number | undefined,
  associatedText: string | undefined,
  modifiers: KeyModifiers,
): KeyEvent | undefined {
  if (code === 13) return { key: "enter", ...modifiers };
  if (code === 9) return { key: "tab", ...modifiers };
  if (code === 27) return { key: "escape", ...modifiers };
  if (code === 8 || code === 127) return { key: "backspace", ...modifiers };

  const shortcutCode = validCodePoint(baseLayout) && printableCodePoint(baseLayout) ? baseLayout : code;
  const textCode = modifiers.shift && validCodePoint(shifted) ? shifted : code;
  const shortcutModifiers = modifiers.ctrl || modifiers.alt || modifiers.super || modifiers.hyper || modifiers.meta;
  const metadata = {
    ...(validCodePoint(shifted) ? { alternateKey: String.fromCodePoint(shifted) } : {}),
    ...(validCodePoint(baseLayout) ? { baseLayoutKey: String.fromCodePoint(baseLayout).toLowerCase() } : {}),
  };
  if (!shortcutModifiers) {
    const text = associatedText ?? (validCodePoint(textCode) && printableCodePoint(textCode) ? String.fromCodePoint(textCode) : undefined);
    if (text !== undefined) return { key: "text", text, ...modifiers, ...metadata };
  }
  if (!validCodePoint(shortcutCode) || !printableCodePoint(shortcutCode)) return undefined;
  return { key: shortcutKey(shortcutCode), ...modifiers, ...metadata };
}

function keypadEvent(index: number, modifiers: KeyModifiers): KeyEvent | undefined {
  const key = KITTY_KEYPAD_KEYS[index];
  if (key === undefined) return undefined;
  const text = index <= 9 ? String(index) : [".", "/", "*", "-", "+", undefined, "=", ","][index - 10];
  if (key === "kpenter") return { key: "enter", keypad: true, ...modifiers };
  if (text !== undefined && !modifiers.ctrl && !modifiers.alt && !modifiers.super && !modifiers.hyper && !modifiers.meta) {
    return { key: "text", text, keypad: true, ...modifiers };
  }
  return { key, keypad: true, ...modifiers };
}

function kittyEvent(parameters: string): KeyEvent | undefined {
  const groups = parameters.split(";");
  const codes = (groups[0] ?? "").split(":");
  const code = decimal(codes[0]);
  if (code === undefined) return undefined;
  const { modifiers, release } = modifierFields(groups[1]);
  if (release) return undefined;
  const associatedCodes = groups[2]?.split(":").map(decimal);
  const associatedText = associatedCodes !== undefined && associatedCodes.length > 0 && associatedCodes.every(validCodePoint)
    && associatedCodes.every((value) => printableCodePoint(value))
    ? String.fromCodePoint(...associatedCodes)
    : undefined;
  const named = KITTY_NAMED_KEYS.get(code);
  if (named !== undefined) return { key: named, ...modifiers };
  if (code >= 57399 && code <= 57427) return keypadEvent(code - 57399, modifiers);
  return unicodeKeyEvent(code, decimal(codes[1]), decimal(codes[2]), associatedText, modifiers);
}

function legacyNamedEvent(key: string | undefined, modifiers: KeyModifiers): KeyEvent | undefined {
  return key === undefined ? undefined : { key, ...modifiers };
}

function csiEvent(sequence: string, replies: TerminalReply[]): DecodedKey | undefined {
  const normalized = sequence.startsWith("\u009b") ? `\u001b[${sequence.slice(1)}` : sequence;
  const body = normalized.slice(2);
  if (/^\[[A-E]$/u.test(body)) {
    return { event: { key: `f${body.charCodeAt(1) - 64}` }, enhanced: false };
  }
  if (/^\?\d+u$/u.test(body)) {
    replies.push({ type: "kitty_keyboard", flags: decimal(body.slice(1, -1)) ?? 0 });
    return undefined;
  }
  if (/^[?>]?[0-9;:]*c$/u.test(body)) {
    replies.push({ type: "primary_device_attributes" });
    return undefined;
  }

  const rxvtDollar = /^([0-9;:]*)\$$/u.exec(body);
  const standard = /^([0-?]*)([ -/]*)([@-~])$/u.exec(body);
  if (standard === null && rxvtDollar === null) return undefined;
  const parameterText = standard?.[1] ?? rxvtDollar?.[1] ?? "";
  const intermediate = standard?.[2] ?? "";
  const final = standard?.[3] ?? "$";
  if (parameterText.startsWith("?") || parameterText.startsWith(">") || parameterText.startsWith("<") || parameterText.startsWith("=")) {
    return undefined;
  }
  const groups = parameterText === "" ? [] : parameterText.split(";");
  if (final === "u" && intermediate === "") {
    const event = kittyEvent(parameterText);
    return event === undefined ? undefined : { event, enhanced: true };
  }
  if (final === "~" && groups[0] === "27" && groups.length >= 3) {
    const code = decimal(groups[2]);
    const { modifiers, release } = modifierFields(groups[1]);
    if (release || !validCodePoint(code)) return undefined;
    const event = unicodeKeyEvent(code, undefined, undefined, undefined, modifiers);
    return event === undefined ? undefined : { event, enhanced: false };
  }

  const modifierGroup = groups.length > 1 ? groups.at(-1) : undefined;
  const { modifiers, release } = modifierFields(modifierGroup);
  if (release) return undefined;
  const arrows: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
  if (arrows[final] !== undefined) return { event: { key: arrows[final]!, ...modifiers }, enhanced: false };
  const rxvtArrows: Record<string, string> = { a: "up", b: "down", c: "right", d: "left" };
  if (rxvtArrows[final] !== undefined) return { event: { key: rxvtArrows[final]!, shift: true, ...modifiers }, enhanced: false };
  if (final === "Z") return { event: { key: "tab", shift: true, ...modifiers }, enhanced: false };
  if (final === "E") return { event: { key: "begin", keypad: true, ...modifiers }, enhanced: false };
  if (final === "P" || final === "Q" || final === "S") {
    return { event: { key: final === "P" ? "f1" : final === "Q" ? "f2" : "f4", ...modifiers }, enhanced: false };
  }
  if (final === "~") {
    const event = legacyNamedEvent(LEGACY_TILDE_KEYS.get(decimal(groups[0]) ?? -1), modifiers);
    return event === undefined ? undefined : { event, enhanced: false };
  }
  if (final === "$" || final === "^" || final === "@") {
    const key = LEGACY_TILDE_KEYS.get(decimal(groups[0]) ?? -1);
    if (key === undefined) return undefined;
    return {
      event: {
        key,
        ...(final === "$" || final === "@" ? { shift: true } : {}),
        ...(final === "^" || final === "@" ? { ctrl: true } : {}),
      },
      enhanced: false,
    };
  }
  return undefined;
}

function ss3Event(sequence: string): DecodedKey | undefined {
  const body = sequence.slice(2);
  const match = /^([0-?]*)([ -/]*)([@-~])$/u.exec(body);
  if (match === null) return undefined;
  const parameterText = match[1]!;
  const parameters = parameterText === "" ? [] : parameterText.split(";");
  const final = match[3]!;
  const { modifiers, release } = modifierFields(parameters.length > 1 ? parameters.at(-1) : undefined);
  if (release) return undefined;
  const named: Record<string, string> = {
    A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", E: "begin",
    P: "f1", Q: "f2", R: "f3", S: "f4",
  };
  if (named[final] !== undefined) return { event: { key: named[final]!, ...(final === "E" ? { keypad: true } : {}), ...modifiers }, enhanced: false };
  const rxvt: Record<string, string> = { a: "up", b: "down", c: "right", d: "left" };
  if (rxvt[final] !== undefined) return { event: { key: rxvt[final]!, ctrl: true, ...modifiers }, enhanced: false };
  const keypad = SS3_KEYPAD.get(final);
  if (keypad === undefined) return undefined;
  if (keypad.key === "kpenter") return { event: { key: "enter", keypad: true, ...modifiers }, enhanced: false };
  if (keypad.text !== undefined && !modifiers.ctrl && !modifiers.alt && !modifiers.super && !modifiers.hyper && !modifiers.meta) {
    return { event: { key: "text", text: keypad.text, keypad: true, ...modifiers }, enhanced: false };
  }
  return { event: { key: keypad.key, keypad: true, ...modifiers }, enhanced: false };
}

function textEvent(value: string): KeyEvent | undefined {
  const first = value.codePointAt(0) ?? 0;
  if (value === "\r") return { key: "enter" };
  if (value === "\n") return { key: "newline", ctrl: true };
  if (value === "\t") return { key: "tab" };
  if (first === 0x08 || first === 0x7f) return { key: "backspace" };
  const control = controlEvent(first);
  if (control !== undefined) return control;
  return first >= 0x20 && first !== 0x7f ? { key: "text", text: value } : undefined;
}

function sequenceEvent(token: Extract<TerminalInputToken, { type: "sequence" }>, replies: TerminalReply[]): DecodedKey | undefined {
  if (!token.complete) return undefined;
  const sequence = token.value;
  if (sequence === "\u001b") return { event: { key: "escape" }, enhanced: false };
  if (sequence.startsWith("\u001b[") || sequence.startsWith("\u009b")) return csiEvent(sequence, replies);
  if (sequence.startsWith("\u001bO")) return ss3Event(sequence);
  if (!sequence.startsWith("\u001b")) return undefined;
  const introducer = sequence.charCodeAt(1);
  if ("]P_^X".includes(sequence[1] ?? "") || (introducer >= 0x20 && introducer <= 0x2f)) return undefined;
  const value = sequence.slice(1);
  if (value === "\r") return { event: { key: "enter", alt: true }, enhanced: false };
  if (value === "\t") return { event: { key: "tab", alt: true }, enhanced: false };
  if (value.codePointAt(0) === 0x08 || value.codePointAt(0) === 0x7f) {
    return { event: { key: "backspace", alt: true }, enhanced: false };
  }
  const control = controlEvent(value.codePointAt(0) ?? -1, true);
  if (control !== undefined) return { event: control, enhanced: false };
  return value === "" ? undefined : { event: { key: value.toLowerCase(), text: value, alt: true }, enhanced: false };
}

function signature(event: KeyEvent): string {
  return JSON.stringify([
    event.key, event.text ?? "", event.ctrl === true, event.alt === true, event.shift === true,
    event.super === true, event.hyper === true, event.meta === true, event.keypad === true,
  ]);
}

export class KeyDecoder {
  readonly #input = new TerminalInputBuffer();
  readonly #replies: TerminalReply[] = [];
  #duplicates: Array<{ signature: string; expiresAt: number }> = [];

  push(chunk: Uint8Array | string): KeyEvent[] {
    return this.#decode(this.#input.push(chunk));
  }

  flush(): KeyEvent[] {
    return this.#decode(this.#input.flush());
  }

  flushPending(): KeyEvent[] {
    return this.#decode(this.#input.flushPending());
  }

  flushEscape(): KeyEvent[] {
    return this.#input.pendingEscape ? this.flushPending() : [];
  }

  takeReplies(): TerminalReply[] {
    return this.#replies.splice(0);
  }

  get pendingEscape(): boolean {
    return this.#input.pendingEscape;
  }

  get pendingSequence(): boolean {
    return this.#input.pendingSequence;
  }

  #decode(tokens: readonly TerminalInputToken[]): KeyEvent[] {
    const events: KeyEvent[] = [];
    for (const token of tokens) {
      if (token.type === "paste") {
        this.#duplicates = [];
        events.push({ key: "paste", text: token.value });
        continue;
      }
      const decoded = token.type === "text"
        ? { event: textEvent(token.value), enhanced: false }
        : sequenceEvent(token, this.#replies);
      if (decoded === undefined || decoded.event === undefined) continue;
      const event = decoded.event;
      const now = Date.now();
      this.#duplicates = this.#duplicates.filter((candidate) => candidate.expiresAt >= now);
      const eventSignature = signature(event);
      if (decoded.enhanced) {
        this.#duplicates.push({ signature: eventSignature, expiresAt: now + DUPLICATE_WINDOW_MS });
        if (this.#duplicates.length > 8) this.#duplicates.shift();
        events.push(event);
        continue;
      }
      const duplicate = this.#duplicates.findIndex((candidate) => candidate.signature === eventSignature);
      if (duplicate >= 0) {
        this.#duplicates.splice(duplicate, 1);
        continue;
      }
      this.#duplicates = [];
      events.push(event);
    }
    if (this.#replies.length > MAX_PENDING_REPLIES) this.#replies.splice(0, this.#replies.length - MAX_PENDING_REPLIES);
    return events;
  }
}
