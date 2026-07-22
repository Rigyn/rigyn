export interface TerminalRgbColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

export type TerminalColorScheme = "dark" | "light";

const oscBackground = /^(?:\u001b\]|\u009d)11;([^\u0007\u001b\u009c]*)(?:\u0007|\u001b\\|\u009c)$/iu;
const colorSchemeReport = /^(?:\u001b\[|\u009b)\?997;(1|2)n$/u;

function channel(value: string): number | undefined {
  if (!/^[0-9a-f]{1,4}$/iu.test(value)) return undefined;
  const maximum = (16 ** value.length) - 1;
  return Math.round((Number.parseInt(value, 16) / maximum) * 255);
}

/** Parses a complete OSC 11 default-background reply without accepting surrounding input. */
export function parseTerminalBackgroundReply(value: string): TerminalRgbColor | undefined {
  const match = oscBackground.exec(value);
  if (match === null) return undefined;
  const payload = match[1]!.trim();
  const hex = /^#([0-9a-f]{6}|[0-9a-f]{12})$/iu.exec(payload);
  if (hex !== null) {
    const digits = hex[1]!;
    const width = digits.length / 3;
    const red = channel(digits.slice(0, width));
    const green = channel(digits.slice(width, width * 2));
    const blue = channel(digits.slice(width * 2));
    return red === undefined || green === undefined || blue === undefined
      ? undefined
      : { red, green, blue };
  }
  const components = payload.replace(/^rgba?:/iu, "").split("/");
  if (components.length !== 3) return undefined;
  const red = channel(components[0]!);
  const green = channel(components[1]!);
  const blue = channel(components[2]!);
  return red === undefined || green === undefined || blue === undefined
    ? undefined
    : { red, green, blue };
}

/** Parses the standard dark/light terminal preference report. */
export function parseTerminalColorSchemeReply(value: string): TerminalColorScheme | undefined {
  const match = colorSchemeReport.exec(value);
  return match?.[1] === "1" ? "dark" : match?.[1] === "2" ? "light" : undefined;
}

function linear(channelValue: number): number {
  const normalized = channelValue / 255;
  return normalized <= 0.03928
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function terminalColorSchemeForRgb(value: TerminalRgbColor): TerminalColorScheme {
  const luminance = (0.2126 * linear(value.red)) + (0.7152 * linear(value.green)) + (0.0722 * linear(value.blue));
  return luminance >= 0.5 ? "light" : "dark";
}

function ansiRgb(index: number): TerminalRgbColor {
  const basic: readonly TerminalRgbColor[] = [
    { red: 0, green: 0, blue: 0 },
    { red: 128, green: 0, blue: 0 },
    { red: 0, green: 128, blue: 0 },
    { red: 128, green: 128, blue: 0 },
    { red: 0, green: 0, blue: 128 },
    { red: 128, green: 0, blue: 128 },
    { red: 0, green: 128, blue: 128 },
    { red: 192, green: 192, blue: 192 },
    { red: 128, green: 128, blue: 128 },
    { red: 255, green: 0, blue: 0 },
    { red: 0, green: 255, blue: 0 },
    { red: 255, green: 255, blue: 0 },
    { red: 0, green: 0, blue: 255 },
    { red: 255, green: 0, blue: 255 },
    { red: 0, green: 255, blue: 255 },
    { red: 255, green: 255, blue: 255 },
  ];
  if (index < 16) return basic[index]!;
  if (index >= 232) {
    const gray = 8 + ((index - 232) * 10);
    return { red: gray, green: gray, blue: gray };
  }
  const selected = index - 16;
  const component = (value: number): number => value === 0 ? 0 : 55 + (value * 40);
  return {
    red: component(Math.floor(selected / 36)),
    green: component(Math.floor((selected % 36) / 6)),
    blue: component(selected % 6),
  };
}

/** Uses the last valid COLORFGBG field as a conservative pre-query fallback. */
export function terminalColorSchemeFromEnvironment(environment: NodeJS.ProcessEnv): TerminalColorScheme {
  const fields = (environment.COLORFGBG ?? "").split(";").map((value) => value.trim());
  for (let index = fields.length - 1; index >= 0; index -= 1) {
    const field = fields[index]!;
    if (!/^\d{1,3}$/u.test(field)) continue;
    const colorIndex = Number(field);
    if (colorIndex >= 0 && colorIndex <= 255) return terminalColorSchemeForRgb(ansiRgb(colorIndex));
  }
  return "dark";
}
