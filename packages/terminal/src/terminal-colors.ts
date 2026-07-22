export interface RgbColor { r: number; g: number; b: number }
export type TerminalColorScheme = "dark" | "light";

const osc11 = /^\x1b\]11;([^\x07\x1b]*)(?:\x07|\x1b\\)$/iu;
export function isOsc11BackgroundColorResponse(value: string): boolean { return osc11.test(value); }

function channel(value: string): number | undefined {
  if (!/^[\da-f]+$/iu.test(value)) return undefined;
  const maximum = 16 ** value.length - 1;
  return maximum > 0 ? Math.round(Number.parseInt(value, 16) / maximum * 255) : undefined;
}

export function parseOsc11BackgroundColor(value: string): RgbColor | undefined {
  const raw = osc11.exec(value)?.[1]?.trim();
  if (!raw) return undefined;
  if (/^#[\da-f]{6}$/iu.test(raw)) return { r: Number.parseInt(raw.slice(1, 3), 16), g: Number.parseInt(raw.slice(3, 5), 16), b: Number.parseInt(raw.slice(5, 7), 16) };
  if (/^#[\da-f]{12}$/iu.test(raw)) {
    const values = [channel(raw.slice(1, 5)), channel(raw.slice(5, 9)), channel(raw.slice(9, 13))];
    return values.every((item) => item !== undefined) ? { r: values[0]!, g: values[1]!, b: values[2]! } : undefined;
  }
  const values = raw.replace(/^rgba?:/iu, "").split("/").slice(0, 3).map(channel);
  return values.length === 3 && values.every((item) => item !== undefined) ? { r: values[0]!, g: values[1]!, b: values[2]! } : undefined;
}

export function parseTerminalColorSchemeReport(value: string): TerminalColorScheme | undefined {
  const match = /^\x1b\[\?997;(1|2)n$/u.exec(value);
  return match?.[1] === "1" ? "dark" : match?.[1] === "2" ? "light" : undefined;
}
