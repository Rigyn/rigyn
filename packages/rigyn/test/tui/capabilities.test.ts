import assert from "node:assert/strict";
import test from "node:test";
import { detectTerminalCapabilities } from "../../src/tui/capabilities.js";
import { FakeInput, FakeOutput } from "./helpers.js";

test("capability detection selects the rich viewport only for an ANSI TTY with raw input", () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 120;
  output.rows = 40;
  const capabilities = detectTerminalCapabilities(input, output, { environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8" } });
  assert.deepEqual(capabilities, {
    mode: "full",
    ansi: true,
    color: true,
    unicode: true,
    alternateScreen: true,
    bracketedPaste: true,
    rawInput: true,
    imageProtocol: null,
    hyperlinks: false,
    columns: 120,
    rows: 40,
  });
});

test("terminal protocol detection is conservative across emulators and multiplexers", () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const detect = (environment: NodeJS.ProcessEnv, tmuxHyperlinks?: () => boolean) => detectTerminalCapabilities(
    input,
    output,
    { environment: { TERM: "xterm-256color", ...environment }, ...(tmuxHyperlinks === undefined ? {} : { tmuxHyperlinks }) },
  );
  assert.deepEqual(
    [
      detect({ KITTY_WINDOW_ID: "1" }),
      detect({ TERM_PROGRAM: "ghostty" }),
      detect({ WEZTERM_PANE: "1" }),
      detect({ TERM_PROGRAM: "WarpTerminal" }),
    ].map(({ imageProtocol, hyperlinks }) => ({ imageProtocol, hyperlinks })),
    Array.from({ length: 4 }, () => ({ imageProtocol: "kitty", hyperlinks: true })),
  );
  assert.deepEqual(
    (({ imageProtocol, hyperlinks }) => ({ imageProtocol, hyperlinks }))(detect({ ITERM_SESSION_ID: "session" })),
    { imageProtocol: "iterm2", hyperlinks: true },
  );
  assert.deepEqual(
    (({ imageProtocol, hyperlinks }) => ({ imageProtocol, hyperlinks }))(
      detect({ TERM_PROGRAM: "vscode", KITTY_WINDOW_ID: "inherited-parent-value" }),
    ),
    { imageProtocol: null, hyperlinks: true },
  );
  assert.deepEqual(
    (({ imageProtocol, hyperlinks }) => ({ imageProtocol, hyperlinks }))(detect({ TERMINAL_EMULATOR: "JetBrains-JediTerm" })),
    { imageProtocol: null, hyperlinks: false },
  );
  assert.deepEqual(
    (({ imageProtocol, hyperlinks }) => ({ imageProtocol, hyperlinks }))(
      detect({ TMUX: "/tmp/tmux,1,0", TERM_PROGRAM: "ghostty" }, () => true),
    ),
    { imageProtocol: null, hyperlinks: true },
  );
  assert.deepEqual(
    (({ imageProtocol, hyperlinks }) => ({ imageProtocol, hyperlinks }))(
      detect({ TERM: "screen-256color", ITERM_SESSION_ID: "session" }),
    ),
    { imageProtocol: null, hyperlinks: false },
  );
});

test("the rich TUI always owns one alternate-screen viewport", () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const detected = detectTerminalCapabilities(input, output, {
    environment: { TERM: "xterm-256color" },
  });
  assert.equal(detected.mode, "full");
  assert.equal(detected.alternateScreen, true);
});

test("capability detection has automatic line and accessibility fallbacks", () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  input.isTTY = false;
  assert.equal(detectTerminalCapabilities(input, output, { environment: { TERM: "xterm" } }).mode, "classic");
  input.isTTY = true;
  const accessible = detectTerminalCapabilities(input, output, {
    environment: { TERM: "xterm", RIGYN_ACCESSIBLE: "1", NO_COLOR: "1", RIGYN_ASCII: "1" },
  });
  assert.equal(accessible.mode, "accessible");
  assert.equal(accessible.color, false);
  assert.equal(accessible.unicode, false);
  assert.equal(accessible.alternateScreen, false);
});

test("a programmatic rich-viewport request degrades safely when raw mode is unavailable", () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  Object.defineProperty(input, "setRawMode", { value: undefined });
  const capabilities = detectTerminalCapabilities(input, output, { mode: "full", environment: { TERM: "xterm" } });
  assert.equal(capabilities.mode, "classic");
  assert.match(capabilities.reason ?? "", /raw input/u);
});

test("terminal dimensions are bounded before frame allocation", () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 100_000;
  output.rows = 100_000;
  const capabilities = detectTerminalCapabilities(input, output, { environment: { TERM: "xterm", LANG: "C.UTF-8" } });
  assert.equal(capabilities.columns, 500);
  assert.equal(capabilities.rows, 200);
});

test("small real terminal dimensions are preserved instead of expanded to fallback geometry", () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 12;
  output.rows = 4;
  const capabilities = detectTerminalCapabilities(input, output, { environment: { TERM: "xterm" } });
  assert.equal(capabilities.columns, 12);
  assert.equal(capabilities.rows, 4);
});
