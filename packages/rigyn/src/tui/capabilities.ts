import { spawnSync } from "node:child_process";
import type { TerminalImageProtocol } from "./terminal-image.js";
import type { TerminalCapabilities, TuiInput, TuiMode, TuiOutput } from "./types.js";

const MAX_COLUMNS = 500;
const MAX_ROWS = 200;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

function dimension(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? Math.min(value!, maximum) : fallback;
}

function requestedMode(explicit: TuiMode | "auto" | undefined, environment: NodeJS.ProcessEnv): TuiMode | "auto" {
  if (explicit !== undefined) return explicit;
  const configured = environment.RIGYN_TUI_MODE?.toLowerCase();
  if (configured === "full" || configured === "classic" || configured === "accessible") return configured;
  if (environment.RIGYN_ACCESSIBLE === "1") return "accessible";
  return "auto";
}

function unicodeSupported(environment: NodeJS.ProcessEnv): boolean {
  if (environment.RIGYN_ASCII === "1") return false;
  const locale = `${environment.LC_ALL ?? ""} ${environment.LC_CTYPE ?? ""} ${environment.LANG ?? ""}`.toLowerCase();
  return locale === "  " || locale.includes("utf-8") || locale.includes("utf8");
}

function probeTmuxHyperlinks(): boolean {
  try {
    const result = spawnSync("tmux", ["display-message", "-p", "#{client_termfeatures}"], {
      encoding: "utf8",
      timeout: 250,
      maxBuffer: 4 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0 || result.error !== undefined) return false;
    return result.stdout.split(",").some((feature) => feature.trim() === "hyperlinks");
  } catch {
    return false;
  }
}

export function detectTerminalProtocols(
  environment: NodeJS.ProcessEnv,
  tmuxHyperlinks: () => boolean = probeTmuxHyperlinks,
): { imageProtocol: TerminalImageProtocol | null; hyperlinks: boolean } {
  const term = environment.TERM?.toLowerCase() ?? "";
  const termProgram = environment.TERM_PROGRAM?.toLowerCase() ?? "";
  const emulator = environment.TERMINAL_EMULATOR?.toLowerCase() ?? "";
  if (environment.TMUX !== undefined || term.startsWith("tmux")) {
    return { imageProtocol: null, hyperlinks: tmuxHyperlinks() };
  }
  if (term.startsWith("screen")) return { imageProtocol: null, hyperlinks: false };
  if (emulator === "jetbrains-jediterm" || environment.JETBRAINS_IDE !== undefined) {
    return { imageProtocol: null, hyperlinks: false };
  }
  if (environment.WT_SESSION !== undefined || termProgram === "vscode" || termProgram === "alacritty") {
    return { imageProtocol: null, hyperlinks: true };
  }
  if (
    environment.KITTY_WINDOW_ID !== undefined
    || environment.GHOSTTY_RESOURCES_DIR !== undefined
    || environment.WEZTERM_PANE !== undefined
    || environment.WARP_SESSION_ID !== undefined
    || environment.WARP_TERMINAL_SESSION_UUID !== undefined
    || ["kitty", "ghostty", "wezterm", "warpterminal"].includes(termProgram)
    || term.includes("ghostty")
  ) return { imageProtocol: "kitty", hyperlinks: true };
  if (environment.ITERM_SESSION_ID !== undefined || termProgram === "iterm.app") {
    return { imageProtocol: "iterm2", hyperlinks: true };
  }
  return { imageProtocol: null, hyperlinks: false };
}

export function detectTerminalCapabilities(input: TuiInput, output: TuiOutput, options: {
  environment?: NodeJS.ProcessEnv;
  mode?: TuiMode | "auto";
  tmuxHyperlinks?: () => boolean;
} = {}): TerminalCapabilities {
  const environment = options.environment ?? process.env;
  const requested = requestedMode(options.mode, environment);
  const tty = input.isTTY === true && output.isTTY === true;
  // A real raw PTY can render the interface even when a parent process left
  // TERM=dumb behind (common in editor and agent-launched terminals).
  const ansi = tty;
  const rawInput = tty && typeof input.setRawMode === "function";
  const fullAvailable = ansi && rawInput;
  const columns = dimension(output.columns, DEFAULT_COLUMNS, MAX_COLUMNS);
  const rows = dimension(output.rows, DEFAULT_ROWS, MAX_ROWS);

  let mode: TuiMode;
  let reason: string | undefined;
  if (requested === "accessible") {
    mode = "accessible";
    reason = "accessibility mode requested";
  } else if (requested === "classic") {
    mode = "classic";
    reason = "classic mode requested";
  } else if (requested === "full" && fullAvailable) {
    mode = "full";
  } else if (requested === "full") {
    mode = "classic";
    reason = "full TUI mode requires an ANSI TTY with raw input";
  } else if (fullAvailable) {
    mode = "full";
  } else {
    mode = "classic";
    reason = tty ? "terminal lacks full TUI capabilities" : "input or output is not a TTY";
  }

  const color = mode === "full" && ansi && environment.TERM_COLOR !== "0";
  const alternateScreen = mode === "full" && environment.RIGYN_ALT_SCREEN === "1";
  const protocols = mode === "full"
    ? detectTerminalProtocols(environment, options.tmuxHyperlinks)
    : { imageProtocol: null, hyperlinks: false };
  return {
    mode,
    ansi: mode === "full" && ansi,
    color,
    unicode: unicodeSupported(environment),
    alternateScreen,
    bracketedPaste: mode === "full",
    rawInput: mode === "full" && rawInput,
    ...protocols,
    columns,
    rows,
    ...(reason === undefined ? {} : { reason }),
  };
}

export function terminalSize(output: TuiOutput, fallback: Pick<TerminalCapabilities, "columns" | "rows">) {
  return {
    columns: dimension(output.columns, fallback.columns, MAX_COLUMNS),
    rows: dimension(output.rows, fallback.rows, MAX_ROWS),
  };
}
