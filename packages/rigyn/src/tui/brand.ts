const TERMINAL_MARK = Object.freeze([
  "╷ ╷ ╷ ╷",
  "└─┴─┴─┘",
  "╶┐ ┌┬┐ ┌╴",
  "╶┘─┤│├─└╴",
  "╶┐─┤│├─┌╴",
  "╶┘ └┴┘ └╴",
  "    ◆",
] as const);

const TERMINAL_MARK_ASCII = Object.freeze([
  "| | | |",
  "+-+-+-+",
  "-[ +++ ]-",
  "-]--|--[-",
  "-[--+--]-",
  "-]  |  [-",
  "    *",
] as const);

export function rigynCompactSignature(version: string, unicode = true): string {
  return unicode ? `rigyn ${version} · ready  ◇─┬─◆` : `rigyn ${version} - ready  o-+-*`;
}

export function rigynTerminalLockup(version: string, unicode = true): string {
  const labels = new Map<number, string>([
    [2, `rigyn ${version}`],
    [3, "programmable agent harness"],
  ]);
  return (unicode ? TERMINAL_MARK : TERMINAL_MARK_ASCII).map((line, index) => {
    const label = labels.get(index);
    return label === undefined ? line : `${line}  ${label}`;
  }).join("\n");
}

export const RIGYN_TERMINAL_MARK: readonly string[] = TERMINAL_MARK;
export const RIGYN_TERMINAL_MARK_ASCII: readonly string[] = TERMINAL_MARK_ASCII;
