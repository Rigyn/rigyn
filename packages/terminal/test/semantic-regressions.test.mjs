import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import {
  Container,
  Markdown,
  TUI,
  encodeKitty,
  setCapabilities,
  sliceByColumn,
  visibleWidth,
} from "../dist/index.js";
import { VirtualTerminal } from "./virtual-terminal-shim.mjs";

const identityTheme = {
  heading: (value) => value,
  link: (value) => value,
  linkUrl: (value) => value,
  code: (value) => value,
  codeBlock: (value) => value,
  codeBlockBorder: (value) => value,
  quote: (value) => value,
  quoteBorder: (value) => value,
  hr: (value) => value,
  listBullet: (value) => value,
  bold: (value) => value,
  italic: (value) => value,
  strikethrough: (value) => value,
  underline: (value) => value,
};

class FocusableComponent {
  focused = false;
  inputs = [];
  constructor(lines = [""]) { this.lines = lines; }
  render() { return this.lines; }
  invalidate() {}
  handleInput(value) { this.inputs.push(value); }
}

async function settle(terminal) {
  await terminal.waitForRender();
}

describe("overlay ownership", () => {
  it("returns input to a visible overlay after a temporary mounted replacement closes", async () => {
    const terminal = new VirtualTerminal(40, 8);
    const tui = new TUI(terminal);
    const base = new Container();
    const editor = new FocusableComponent(["editor"]);
    const replacement = new FocusableComponent(["replacement"]);
    const overlay = new FocusableComponent(["overlay"]);
    base.addChild(editor);
    base.addChild(replacement);
    tui.addChild(base);
    tui.setFocus(editor);
    overlay.handleInput = (value) => {
      overlay.inputs.push(value);
      if (value === "b") tui.setFocus(replacement);
    };
    replacement.handleInput = (value) => {
      replacement.inputs.push(value);
      if (value === "\r") {
        base.clear();
        base.addChild(editor);
        tui.setFocus(editor);
      }
    };
    tui.start();
    tui.showOverlay(overlay);
    terminal.sendInput("b");
    terminal.sendInput("\r");
    terminal.sendInput("x");
    await settle(terminal);
    assert.deepEqual(replacement.inputs, ["\r"]);
    assert.deepEqual(overlay.inputs, ["b", "x"]);
    assert.equal(overlay.focused, true);
    tui.stop();
  });
});

describe("differential terminal state", () => {
  it("clears every old row when content becomes empty", async () => {
    const terminal = new VirtualTerminal(20, 5);
    const tui = new TUI(terminal);
    const component = new FocusableComponent(["one", "two", "three"]);
    tui.addChild(component);
    tui.start();
    await settle(terminal);
    component.lines = [];
    tui.requestRender();
    await settle(terminal);
    assert.deepEqual(terminal.getViewport(), ["", "", "", "", ""]);
    tui.stop();
  });

  it("deletes a reserved image placement before redrawing its block", async () => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
    const terminal = new VirtualTerminal(30, 6);
    const tui = new TUI(terminal);
    const image = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 91, moveCursor: false });
    const component = new FocusableComponent(["", image, ""]);
    tui.addChild(component);
    tui.start();
    await settle(terminal);
    terminal.writes.length = 0;
    component.lines = ["changed", image, ""];
    tui.requestRender();
    await settle(terminal);
    const output = terminal.writes.join("");
    assert.ok(output.indexOf("a=d,d=I,i=91") >= 0);
    assert.ok(output.indexOf("a=d,d=I,i=91") < output.indexOf(image));
    tui.stop();
  });
});

describe("cell-accurate composition", () => {
  it("places an overlay at a column that intersects a wide grapheme", () => {
    const tui = new TUI(new VirtualTerminal(20, 5));
    const output = tui.compositeLineAt("abcd让EFGH", "│XX│", 5, 4, 20);
    assert.equal(output.includes("让"), false);
    assert.equal(visibleWidth(output), 20);
    assert.equal(sliceByColumn(output, 5, 4, true).includes("│XX│"), true);
  });
});

describe("Markdown stability", () => {
  it("normalizes partial fences and preserves loose ordered-list state", () => {
    const fenced = new Markdown("```ts\nconst x = 1;\n``", 0, 0, identityTheme).render(40).map((line) => line.trimEnd());
    assert.deepEqual(fenced, ["```ts", "  const x = 1;", "```"]);
    const loose = new Markdown("1. one\n\n   continuation\n\n2. two", 0, 0, identityTheme).render(40).map((line) => line.trimEnd());
    assert.deepEqual(loose, ["1. one", "", "   continuation", "", "2. two"]);
  });

  it("hard-wraps oversized table tokens without dropping borders", () => {
    const lines = new Markdown("| Value |\n| --- |\n| prefix https://example.com/a/very/long/path |", 0, 0, identityTheme).render(24);
    for (const line of lines.filter((value) => value.startsWith("│"))) {
      assert.equal(line.split("│").length - 1, 2);
      assert.ok(visibleWidth(line) <= 24);
    }
  });

  it("restores nested inline formatting without leaking internal placeholders", () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    const lines = new Markdown("_italic and **bold** with [a `label`](https://example.com)_", 0, 0, identityTheme).render(80);
    const rendered = lines.join("\n");
    assert.equal(rendered.includes("\u0001"), false);
    assert.equal(rendered.includes("\u0002"), false);
    assert.match(rendered, /italic and bold with a label \(https:\/\/example\.com\)/u);
  });
});

describe("render diagnostics", () => {
  it("uses an explicit directory as a redraw opt-in without transcript text", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rigyn-redraw-"));
    const previous = process.env.RIGYN_DEBUG_REDRAW;
    delete process.env.RIGYN_DEBUG_REDRAW;
    try {
      const terminal = new VirtualTerminal(30, 6);
      const tui = new TUI(terminal, false, directory);
      tui.addChild(new FocusableComponent(["private transcript marker"]));
      tui.start();
      await settle(terminal);
      tui.stop();
      const path = join(directory, "rigyn-debug.log");
      const log = readFileSync(path, "utf8");
      assert.match(log, /full-redraw reason=initial/u);
      assert.doesNotMatch(log, /private transcript marker/u);
      assert.ok(Buffer.byteLength(log, "utf8") < 2_048);
      if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
    } finally {
      if (previous === undefined) delete process.env.RIGYN_DEBUG_REDRAW;
      else process.env.RIGYN_DEBUG_REDRAW = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses the redraw environment flag with the configured Rigyn home", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rigyn-redraw-env-"));
    const previousDebug = process.env.RIGYN_DEBUG_REDRAW;
    const previousAgentDirectory = process.env.RIGYN_HOME;
    process.env.RIGYN_DEBUG_REDRAW = "1";
    process.env.RIGYN_HOME = directory;
    try {
      const terminal = new VirtualTerminal(30, 6);
      const tui = new TUI(terminal);
      tui.addChild(new FocusableComponent(["environment opt-in"]));
      tui.start();
      await settle(terminal);
      tui.stop();
      assert.match(readFileSync(join(directory, "logs", "rigyn-debug.log"), "utf8"), /full-redraw reason=initial/u);
    } finally {
      if (previousDebug === undefined) delete process.env.RIGYN_DEBUG_REDRAW;
      else process.env.RIGYN_DEBUG_REDRAW = previousDebug;
      if (previousAgentDirectory === undefined) delete process.env.RIGYN_HOME;
      else process.env.RIGYN_HOME = previousAgentDirectory;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not create redraw or crash logs without an opt-in", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rigyn-no-redraw-"));
    const agentDirectory = join(directory, "agent");
    const previousDebug = process.env.RIGYN_DEBUG_REDRAW;
    const previousAgentDirectory = process.env.RIGYN_HOME;
    delete process.env.RIGYN_DEBUG_REDRAW;
    process.env.RIGYN_HOME = agentDirectory;
    try {
      const terminal = new VirtualTerminal(30, 6);
      const tui = new TUI(terminal);
      tui.addChild(new FocusableComponent(["ordinary render"]));
      tui.start();
      await settle(terminal);
      tui.stop();
      assert.equal(existsSync(agentDirectory), false);

      const entry = pathToFileURL(resolve("dist/index.js")).href;
      const script = `
        const { TUI } = await import(process.argv[1]);
        const terminal = {
          columns: 5, rows: 4, kittyProtocolActive: false,
          start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {},
          hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
          clearScreen() {}, setTitle() {}, setProgress() {},
        };
        const tui = new TUI(terminal);
        tui.addChild({ render: () => ["row wider than five cells"], invalidate() {} });
        tui.start();
        await new Promise((resolve) => setTimeout(resolve, 50));
      `;
      const { RIGYN_DEBUG_REDRAW: _ignored, ...environment } = process.env;
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, entry], {
        encoding: "utf8",
        env: { ...environment, RIGYN_HOME: agentDirectory },
        timeout: 5_000,
      });
      assert.notEqual(child.status, 0);
      assert.equal(existsSync(join(agentDirectory, "logs", "rigyn-crash.log")), false);
    } finally {
      if (previousDebug === undefined) delete process.env.RIGYN_DEBUG_REDRAW;
      else process.env.RIGYN_DEBUG_REDRAW = previousDebug;
      if (previousAgentDirectory === undefined) delete process.env.RIGYN_HOME;
      else process.env.RIGYN_HOME = previousAgentDirectory;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps rendering when the diagnostic destination cannot contain files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rigyn-redraw-blocked-"));
    const blocked = join(directory, "ordinary-file");
    const previous = process.env.RIGYN_DEBUG_REDRAW;
    process.env.RIGYN_DEBUG_REDRAW = "1";
    writeFileSync(blocked, "not a directory");
    try {
      const terminal = new VirtualTerminal(30, 6);
      const tui = new TUI(terminal, false, blocked);
      tui.addChild(new FocusableComponent(["still rendered"]));
      tui.start();
      await settle(terminal);
      assert.ok(terminal.getViewport().includes("still rendered"));
      tui.stop();
    } finally {
      if (previous === undefined) delete process.env.RIGYN_DEBUG_REDRAW;
      else process.env.RIGYN_DEBUG_REDRAW = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("canonicalizes an existing directory below an aliased parent", { skip: process.platform === "win32" }, async () => {
    const root = mkdtempSync(join(tmpdir(), "rigyn-redraw-parent-link-"));
    const previous = process.env.RIGYN_DEBUG_REDRAW;
    delete process.env.RIGYN_DEBUG_REDRAW;
    try {
      const targetRoot = join(root, "target");
      const targetDirectory = join(targetRoot, "diagnostics");
      const parentLink = join(root, "parent-link");
      mkdirSync(targetDirectory, { recursive: true });
      symlinkSync(targetRoot, parentLink, "dir");

      const terminal = new VirtualTerminal(30, 6);
      const tui = new TUI(terminal, false, join(parentLink, "diagnostics"));
      tui.addChild(new FocusableComponent(["aliased parent render"]));
      tui.start();
      await settle(terminal);
      tui.stop();

      assert.match(readFileSync(join(targetDirectory, "rigyn-debug.log"), "utf8"), /full-redraw reason=initial/u);
    } finally {
      if (previous === undefined) delete process.env.RIGYN_DEBUG_REDRAW;
      else process.env.RIGYN_DEBUG_REDRAW = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a configured Rigyn home below an aliased parent before logs exist", { skip: process.platform === "win32" }, async () => {
    const root = mkdtempSync(join(tmpdir(), "rigyn-redraw-missing-parent-link-"));
    const previousDebug = process.env.RIGYN_DEBUG_REDRAW;
    const previousAgentDirectory = process.env.RIGYN_HOME;
    try {
      const targetRoot = join(root, "target");
      const parentLink = join(root, "parent-link");
      mkdirSync(targetRoot);
      symlinkSync(targetRoot, parentLink, "dir");
      process.env.RIGYN_DEBUG_REDRAW = "1";
      process.env.RIGYN_HOME = parentLink;

      const terminal = new VirtualTerminal(30, 6);
      const tui = new TUI(terminal);
      tui.addChild(new FocusableComponent(["missing aliased parent render"]));
      tui.start();
      await settle(terminal);
      tui.stop();

      assert.match(readFileSync(join(targetRoot, "logs", "rigyn-debug.log"), "utf8"), /full-redraw reason=initial/u);
    } finally {
      if (previousDebug === undefined) delete process.env.RIGYN_DEBUG_REDRAW;
      else process.env.RIGYN_DEBUG_REDRAW = previousDebug;
      if (previousAgentDirectory === undefined) delete process.env.RIGYN_HOME;
      else process.env.RIGYN_HOME = previousAgentDirectory;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked diagnostic directories and files", { skip: process.platform === "win32" }, async () => {
    const directory = mkdtempSync(join(tmpdir(), "rigyn-redraw-link-"));
    const previous = process.env.RIGYN_DEBUG_REDRAW;
    delete process.env.RIGYN_DEBUG_REDRAW;
    try {
      const targetDirectory = join(directory, "target");
      const directoryLink = join(directory, "directory-link");
      mkdirSync(targetDirectory);
      symlinkSync(targetDirectory, directoryLink, "dir");

      const linkedDirectoryTerminal = new VirtualTerminal(30, 6);
      const linkedDirectoryTui = new TUI(linkedDirectoryTerminal, false, directoryLink);
      linkedDirectoryTui.addChild(new FocusableComponent(["directory link render"]));
      linkedDirectoryTui.start();
      await settle(linkedDirectoryTerminal);
      linkedDirectoryTui.stop();
      assert.equal(existsSync(join(targetDirectory, "rigyn-debug.log")), false);

      const fileDirectory = join(directory, "files");
      const outsideFile = join(directory, "outside.log");
      mkdirSync(fileDirectory);
      writeFileSync(outsideFile, "unchanged");
      symlinkSync(outsideFile, join(fileDirectory, "rigyn-debug.log"), "file");

      const linkedFileTerminal = new VirtualTerminal(30, 6);
      const linkedFileTui = new TUI(linkedFileTerminal, false, fileDirectory);
      linkedFileTui.addChild(new FocusableComponent(["file link render"]));
      linkedFileTui.start();
      await settle(linkedFileTerminal);
      linkedFileTui.stop();
      assert.equal(readFileSync(outsideFile, "utf8"), "unchanged");
    } finally {
      if (previous === undefined) delete process.env.RIGYN_DEBUG_REDRAW;
      else process.env.RIGYN_DEBUG_REDRAW = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records only geometry when an invalid component row stops rendering", () => {
    const directory = mkdtempSync(join(tmpdir(), "rigyn-render-failure-"));
    try {
      writeFileSync(join(directory, "rigyn-crash.log"), "stale diagnostic\n");
      const entry = pathToFileURL(resolve("dist/index.js")).href;
      const script = `
        const { TUI } = await import(process.argv[1]);
        const terminal = {
          columns: 5, rows: 4, kittyProtocolActive: false,
          start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {},
          hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
          clearScreen() {}, setTitle() {}, setProgress() {},
        };
        const tui = new TUI(terminal, false, process.argv[2]);
        tui.addChild({ render: () => ["credential-shaped-private-value"], invalidate() {} });
        tui.start();
        await new Promise((resolve) => setTimeout(resolve, 50));
      `;
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, entry, directory], {
        encoding: "utf8",
        timeout: 5_000,
      });
      assert.notEqual(child.status, 0);
      const log = readFileSync(join(directory, "rigyn-crash.log"), "utf8");
      assert.match(log, /render-width row=0 width=31 terminal=5 rows=1/u);
      assert.doesNotMatch(log, /credential-shaped-private-value/u);
      assert.doesNotMatch(log, /stale diagnostic/u);
      assert.ok(Buffer.byteLength(log, "utf8") < 2_048);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
