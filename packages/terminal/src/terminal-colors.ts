export interface RgbColor { r: number; g: number; b: number }
export type TerminalColorScheme = "dark" | "light";

function channel(value: string): number { return Math.round(Number.parseInt(value, 16) / ((16 ** value.length) - 1) * 255); }

export function parseOsc11BackgroundColor(value: string): RgbColor | undefined {
  const matched = /\x1b\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\x07|\x1b\\)/iu.exec(value);
  return matched === null ? undefined : { r: channel(matched[1]!), g: channel(matched[2]!), b: channel(matched[3]!) };
}
export function isOsc11BackgroundColorResponse(value: string): boolean { return parseOsc11BackgroundColor(value) !== undefined; }
export function parseTerminalColorSchemeReport(value: string): TerminalColorScheme | undefined {
  const matched = /\x1b\[\?997;([12])n/u.exec(value);
  return matched?.[1] === "1" ? "dark" : matched?.[1] === "2" ? "light" : undefined;
}
