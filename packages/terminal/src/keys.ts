type Letter = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j" | "k" | "l" | "m" | "n" | "o" | "p" | "q" | "r" | "s" | "t" | "u" | "v" | "w" | "x" | "y" | "z";
type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type SymbolKey = "`" | "-" | "=" | "[" | "]" | "\\" | ";" | "'" | "," | "." | "/" | "!" | "@" | "#" | "$" | "%" | "^" | "&" | "*" | "(" | ")" | "_" | "+" | "|" | "~" | "{" | "}" | ":" | "<" | ">" | "?";
type SpecialKey = "escape" | "esc" | "enter" | "return" | "tab" | "space" | "backspace" | "delete" | "insert" | "clear" | "home" | "end" | "pageUp" | "pageDown" | "up" | "down" | "left" | "right" | "f1" | "f2" | "f3" | "f4" | "f5" | "f6" | "f7" | "f8" | "f9" | "f10" | "f11" | "f12";
type BaseKey = Letter | Digit | SymbolKey | SpecialKey;
type Modifier = "ctrl" | "shift" | "alt" | "super";
type Modified<KeyName extends string, Remaining extends Modifier = Modifier> = {
  [Name in Remaining]: `${Name}+${KeyName}` | `${Name}+${Modified<KeyName, Exclude<Remaining, Name>>}`;
}[Remaining];
export type KeyId = BaseKey | Modified<BaseKey>;
export type KeyEventType = "press" | "repeat" | "release";

const symbols = new Set("`-=[]\\;',./!@#$%^&*()_+|~{}:<>?".split(""));
const modifierBits = { shift: 1, alt: 2, ctrl: 4, super: 8 } as const;
const lockBits = 64 | 128;
let kittyActive = false;

export function setKittyProtocolActive(active: boolean): void { kittyActive = active; }
export function isKittyProtocolActive(): boolean { return kittyActive; }

const names = {
  escape: "escape", esc: "esc", enter: "enter", return: "return", tab: "tab", space: "space",
  backspace: "backspace", delete: "delete", insert: "insert", clear: "clear", home: "home", end: "end",
  pageUp: "pageUp", pageDown: "pageDown", up: "up", down: "down", left: "left", right: "right",
  f1: "f1", f2: "f2", f3: "f3", f4: "f4", f5: "f5", f6: "f6", f7: "f7", f8: "f8", f9: "f9", f10: "f10", f11: "f11", f12: "f12",
  backtick: "`", hyphen: "-", equals: "=", leftbracket: "[", rightbracket: "]", backslash: "\\", semicolon: ";", quote: "'", comma: ",", period: ".", slash: "/", exclamation: "!", at: "@", hash: "#", dollar: "$", percent: "%", caret: "^", ampersand: "&", asterisk: "*", leftparen: "(", rightparen: ")", underscore: "_", plus: "+", pipe: "|", tilde: "~", leftbrace: "{", rightbrace: "}", colon: ":", lessthan: "<", greaterthan: ">", question: "?",
} as const;

function combined<Prefix extends string, Name extends BaseKey>(prefix: Prefix, name: Name): `${Prefix}+${Name}` { return `${prefix}+${name}`; }
export const Key = Object.freeze({
  ...names,
  ctrl: <Name extends BaseKey>(name: Name) => combined("ctrl", name),
  shift: <Name extends BaseKey>(name: Name) => combined("shift", name),
  alt: <Name extends BaseKey>(name: Name) => combined("alt", name),
  super: <Name extends BaseKey>(name: Name) => combined("super", name),
  ctrlShift: <Name extends BaseKey>(name: Name) => combined("ctrl+shift", name),
  shiftCtrl: <Name extends BaseKey>(name: Name) => combined("shift+ctrl", name),
  ctrlAlt: <Name extends BaseKey>(name: Name) => combined("ctrl+alt", name),
  altCtrl: <Name extends BaseKey>(name: Name) => combined("alt+ctrl", name),
  shiftAlt: <Name extends BaseKey>(name: Name) => combined("shift+alt", name),
  altShift: <Name extends BaseKey>(name: Name) => combined("alt+shift", name),
  ctrlSuper: <Name extends BaseKey>(name: Name) => combined("ctrl+super", name),
  superCtrl: <Name extends BaseKey>(name: Name) => combined("super+ctrl", name),
  shiftSuper: <Name extends BaseKey>(name: Name) => combined("shift+super", name),
  superShift: <Name extends BaseKey>(name: Name) => combined("super+shift", name),
  altSuper: <Name extends BaseKey>(name: Name) => combined("alt+super", name),
  superAlt: <Name extends BaseKey>(name: Name) => combined("super+alt", name),
  ctrlShiftAlt: <Name extends BaseKey>(name: Name) => combined("ctrl+shift+alt", name),
  ctrlShiftSuper: <Name extends BaseKey>(name: Name) => combined("ctrl+shift+super", name),
});

interface ParsedSequence { codepoint: number; shifted?: number; base?: number; modifiers: number; event: KeyEventType }
const arrows = { A: -1, B: -2, C: -3, D: -4 } as const;
const functional = { 2: -11, 3: -10, 5: -12, 6: -13, 7: -14, 8: -15 } as const;
const keypad = new Map<number, number>([
  ...Array.from({ length: 10 }, (_, index) => [57399 + index, 48 + index] as const),
  [57409, 46], [57410, 47], [57411, 42], [57412, 45], [57413, 43], [57415, 61], [57416, 44],
  [57417, -4], [57418, -3], [57419, -1], [57420, -2], [57421, -12], [57422, -13], [57423, -14], [57424, -15], [57425, -11], [57426, -10],
]);

function event(value?: string): KeyEventType { return value === "2" ? "repeat" : value === "3" ? "release" : "press"; }
function parseExtended(data: string): ParsedSequence | undefined {
  let match = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/u.exec(data);
  if (match) return {
    codepoint: Number(match[1]),
    ...(match[2] ? { shifted: Number(match[2]) } : {}),
    ...(match[3] ? { base: Number(match[3]) } : {}),
    modifiers: (Number(match[4] ?? 1) - 1) & ~lockBits,
    event: event(match[5]),
  };
  match = /^\x1b\[1;(\d+)(?::(\d+))?([ABCD])$/u.exec(data);
  if (match) return { codepoint: arrows[match[3] as keyof typeof arrows], modifiers: Number(match[1]) - 1, event: event(match[2]) };
  match = /^\x1b\[(\d+)(?:;(\d+))?(?::(\d+))?~$/u.exec(data);
  if (match) {
    const codepoint = functional[Number(match[1]) as keyof typeof functional];
    if (codepoint !== undefined) return { codepoint, modifiers: Number(match[2] ?? 1) - 1, event: event(match[3]) };
  }
  match = /^\x1b\[1;(\d+)(?::(\d+))?([HF])$/u.exec(data);
  if (match) return { codepoint: match[3] === "H" ? -14 : -15, modifiers: Number(match[1]) - 1, event: event(match[2]) };
  match = /^\x1b\[27;(\d+);(\d+)~$/u.exec(data);
  if (match) return { codepoint: Number(match[2]), modifiers: Number(match[1]) - 1, event: "press" };
  return undefined;
}

function normalizedCodepoint(value: number, modifiers: number): number {
  const result = keypad.get(value) ?? value;
  return modifiers & modifierBits.shift && result >= 65 && result <= 90 ? result + 32 : result;
}

function baseName(codepoint: number): string | undefined {
  const special: Record<number, string> = { 27: "escape", 9: "tab", 13: "enter", 57414: "enter", 32: "space", 127: "backspace", [-1]: "up", [-2]: "down", [-3]: "right", [-4]: "left", [-10]: "delete", [-11]: "insert", [-12]: "pageUp", [-13]: "pageDown", [-14]: "home", [-15]: "end" };
  if (special[codepoint]) return special[codepoint];
  if ((codepoint >= 48 && codepoint <= 57) || (codepoint >= 97 && codepoint <= 122) || symbols.has(String.fromCodePoint(codepoint))) return String.fromCodePoint(codepoint);
  return undefined;
}

function decorate(name: string, modifiers: number): string | undefined {
  if (modifiers & ~(modifierBits.shift | modifierBits.ctrl | modifierBits.alt | modifierBits.super)) return undefined;
  return [
    modifiers & modifierBits.shift ? "shift" : undefined,
    modifiers & modifierBits.ctrl ? "ctrl" : undefined,
    modifiers & modifierBits.alt ? "alt" : undefined,
    modifiers & modifierBits.super ? "super" : undefined,
    name,
  ].filter(Boolean).join("+");
}

const legacy = new Map<string, string>([
  ["\x1b", "escape"], ["\t", "tab"], ["\r", "enter"], ["\x1bOM", "enter"], [" ", "space"], ["\x00", "ctrl+space"], ["\x7f", "backspace"],
  ["\x1b[Z", "shift+tab"], ["\x1b\x7f", "alt+backspace"], ["\x1b\b", "alt+backspace"],
  ["\x1b[A", "up"], ["\x1bOA", "up"], ["\x1b[B", "down"], ["\x1bOB", "down"], ["\x1b[C", "right"], ["\x1bOC", "right"], ["\x1b[D", "left"], ["\x1bOD", "left"],
  ["\x1b[H", "home"], ["\x1bOH", "home"], ["\x1b[1~", "home"], ["\x1b[7~", "home"], ["\x1b[F", "end"], ["\x1bOF", "end"], ["\x1b[4~", "end"], ["\x1b[8~", "end"],
  ["\x1b[2~", "insert"], ["\x1b[3~", "delete"], ["\x1b[5~", "pageUp"], ["\x1b[[5~", "pageUp"], ["\x1b[6~", "pageDown"], ["\x1b[[6~", "pageDown"], ["\x1b[E", "clear"], ["\x1bOE", "clear"],
  ["\x1b[1;3D", "alt+left"], ["\x1bb", "alt+left"], ["\x1b[1;3C", "alt+right"], ["\x1bf", "alt+right"], ["\x1bp", "alt+up"], ["\x1bn", "alt+down"], ["\x1b[1;5D", "ctrl+left"], ["\x1b[1;5C", "ctrl+right"],
  ["\x1b[a", "shift+up"], ["\x1b[b", "shift+down"], ["\x1b[c", "shift+right"], ["\x1b[d", "shift+left"], ["\x1bOa", "ctrl+up"], ["\x1bOb", "ctrl+down"], ["\x1bOc", "ctrl+right"], ["\x1bOd", "ctrl+left"],
  ["\x1b[2$", "shift+insert"], ["\x1b[2^", "ctrl+insert"], ["\x1b[3$", "shift+delete"], ["\x1b[3^", "ctrl+delete"],
  ["\x1b[5$", "shift+pageUp"], ["\x1b[5^", "ctrl+pageUp"], ["\x1b[6$", "shift+pageDown"], ["\x1b[6^", "ctrl+pageDown"],
  ["\x1b[7$", "shift+home"], ["\x1b[7^", "ctrl+home"], ["\x1b[8$", "shift+end"], ["\x1b[8^", "ctrl+end"],
  ["\x1bB", "alt+left"], ["\x1bF", "alt+right"],
  ...[["\x1bOP", "f1"], ["\x1bOQ", "f2"], ["\x1bOR", "f3"], ["\x1bOS", "f4"], ["\x1b[15~", "f5"], ["\x1b[17~", "f6"], ["\x1b[18~", "f7"], ["\x1b[19~", "f8"], ["\x1b[20~", "f9"], ["\x1b[21~", "f10"], ["\x1b[23~", "f11"], ["\x1b[24~", "f12"]] as Array<[string, string]>,
]);

function windowsTerminal(): boolean { return Boolean(process.env.WT_SESSION) && !process.env.SSH_CONNECTION && !process.env.SSH_CLIENT && !process.env.SSH_TTY; }

export function normalizeKeyIdentifier(value: string): string {
  const parts = value.toLowerCase().split("+");
  let name = parts.pop() ?? "";
  if (name === "esc") name = "escape";
  if (name === "return") name = "enter";
  if (name === "pageup") name = "pageUp";
  if (name === "pagedown") name = "pageDown";
  return [parts.includes("shift") ? "shift" : undefined, parts.includes("ctrl") ? "ctrl" : undefined, parts.includes("alt") ? "alt" : undefined, parts.includes("super") ? "super" : undefined, name].filter(Boolean).join("+");
}

export function isKeyRelease(data: string): boolean { return !data.includes("\x1b[200~") && /:3(?:u|~|[ABCDHF])$/u.test(data); }
export function isKeyRepeat(data: string): boolean { return !data.includes("\x1b[200~") && /:2(?:u|~|[ABCDHF])$/u.test(data); }

export function parseKey(data: string): string | undefined {
  const parsed = parseExtended(data);
  if (parsed) {
    let codepoint = normalizedCodepoint(parsed.codepoint, parsed.modifiers);
    const isKnown = (codepoint >= 48 && codepoint <= 57) || (codepoint >= 97 && codepoint <= 122) || symbols.has(String.fromCodePoint(Math.max(0, codepoint)));
    if (!isKnown && parsed.base !== undefined) codepoint = parsed.base;
    const name = baseName(codepoint);
    return name ? decorate(name, parsed.modifiers) : undefined;
  }
  if (kittyActive && (data === "\n" || data === "\x1b\r")) return "shift+enter";
  if (!kittyActive && data === "\n") return "enter";
  if (data === "\x08") return windowsTerminal() ? "ctrl+backspace" : "backspace";
  if (!kittyActive && data === "\x1b\r") return "alt+enter";
  if (!kittyActive && data === "\x1b ") return "alt+space";
  const mapped = legacy.get(data);
  if (mapped && !(kittyActive && data.length === 2 && data[0] === "\x1b" && data !== "\x1b\b" && data !== "\x1b\x7f")) return mapped;
  if (data === "\x1c") return "ctrl+\\";
  if (data === "\x1d") return "ctrl+]";
  if (data === "\x1f") return "ctrl+-";
  if (data.length === 2 && data[0] === "\x1b" && !kittyActive) {
    const code = data.charCodeAt(1);
    if (code >= 1 && code <= 26) return `ctrl+alt+${String.fromCharCode(code + 96)}`;
    if (code === 27) return "ctrl+alt+[";
    if (code === 28) return "ctrl+alt+\\";
    if (code === 29) return "ctrl+alt+]";
    if (code === 30) return "ctrl+alt+^";
    if (code === 31) return "ctrl+alt+-";
    if (code >= 32 && code <= 126) return `alt+${data[1]}`;
  }
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code >= 1 && code <= 26) return `ctrl+${String.fromCharCode(code + 96)}`;
    if (code >= 32 && code <= 126) return data;
  }
  return undefined;
}

export function matchesKey(data: string, key: KeyId): boolean {
  const wanted = normalizeKeyIdentifier(key);
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code >= 1 && code <= 26 && wanted === `ctrl+${String.fromCharCode(code + 96)}`) return true;
    const symbol = code === 28 ? "\\" : code === 29 ? "]" : code === 30 ? "^" : code === 31 ? "-" : undefined;
    if (symbol !== undefined && (wanted === `ctrl+${symbol}` || code === 31 && wanted === "ctrl+_")) return true;
  }
  if (!kittyActive && data.length === 2 && data[0] === "\x1b") {
    const code = data.charCodeAt(1);
    const name = code >= 1 && code <= 26 ? String.fromCharCode(code + 96) : code === 27 ? "[" : code === 28 ? "\\" : code === 29 ? "]" : code === 30 ? "^" : code === 31 ? "-" : undefined;
    if (name !== undefined && (wanted === `ctrl+alt+${name}` || code === 31 && wanted === "ctrl+alt+_")) return true;
  }
  const parsed = parseKey(data);
  return parsed !== undefined && normalizeKeyIdentifier(parsed) === wanted;
}

export function decodeKittyPrintable(data: string): string | undefined {
  const parsed = parseExtended(data);
  if (!parsed) return undefined;
  if (parsed.modifiers & (modifierBits.ctrl | modifierBits.alt | modifierBits.super)) return undefined;
  let codepoint = parsed.modifiers & modifierBits.shift && parsed.shifted !== undefined ? parsed.shifted : parsed.codepoint;
  codepoint = keypad.get(codepoint) ?? codepoint;
  if (codepoint < 32) return undefined;
  try { return String.fromCodePoint(codepoint); } catch { return undefined; }
}

export function decodePrintableKey(data: string): string | undefined {
  const decoded = decodeKittyPrintable(data);
  if (decoded !== undefined) return decoded;
  const modified = /^\x1b\[27;(\d+);(\d+)~$/u.exec(data);
  if (modified && ((Number(modified[1]) - 1) & ~(modifierBits.shift | lockBits)) === 0) {
    const codepoint = Number(modified[2]);
    if (codepoint < 32 || codepoint === 127 || codepoint > 0x10ffff) return undefined;
    try { return String.fromCodePoint(codepoint); } catch { return undefined; }
  }
  if ([...data].some((character) => { const code = character.codePointAt(0)!; return code < 32 || code === 127 || (code >= 128 && code <= 159); })) return undefined;
  return data.length > 0 ? data : undefined;
}
