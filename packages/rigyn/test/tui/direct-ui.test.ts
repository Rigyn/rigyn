import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  type AutocompleteItem,
  CURSOR_MARKER,
  Editor,
  Image,
  resetCapabilitiesCache,
  setCapabilities,
  TUI,
  type Component,
  type EditorComponent,
} from "@rigyn/terminal";

import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { Theme } from "../../src/index.js";
import {
  createInteractiveDirectUiContext,
  createInteractiveDirectUiFacade,
  createOwnedInteractiveDirectUiContext,
} from "../../src/tui/direct-ui.js";
import { TuiController } from "../../src/tui/controller.js";
import type { FooterDataSnapshot, ReadonlyFooterDataProvider } from "../../src/tui/footer-data.js";
import { Keybindings } from "../../src/tui/keybindings.js";
import {
  THEME_BACKGROUND_TOKENS,
  THEME_TOKENS,
  type ThemeBg,
  type ThemeColor,
} from "../../src/tui/theme.js";
import { stripAnsi } from "../../src/tui/unicode.js";
import { envelope, FakeInput, FakeOutput, tick } from "./helpers.js";
import { FocusedVirtualTerminal } from "./virtual-terminal.js";

const execute = promisify(execFile);

function fixture() {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    handleSignals: false,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8", TERM_COLOR: "0" },
  });
  controller.start();
  return { input, output, controller };
}

function component(label: string, disposed: () => void): Component & { dispose(): void } {
  return {
    render: () => [label],
    invalidate() {},
    dispose: disposed,
  };
}

test("unused direct UI contexts do not reset the live terminal surface when they end", async () => {
  const { controller } = fixture();
  await tick();
  const redraws = controller.rawFullRedraws();
  const generation = new AbortController();

  createInteractiveDirectUiContext(controller, "unused", process.cwd(), generation.signal);
  generation.abort(new Error("extension refresh"));
  await tick();

  assert.equal(controller.rawFullRedraws(), redraws);
  controller.close();
});

test("direct UI contexts repair the live terminal surface after raw terminal output", async () => {
  const { controller } = fixture();
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(controller, "raw-output", process.cwd(), generation.signal);
  let tui: TUI | undefined;
  ui.setWidget("capture", (value) => {
    tui = value;
    return component("capture", () => undefined);
  });
  await tick();
  assert.ok(tui !== undefined);
  const redraws = controller.rawFullRedraws();

  tui.terminal.hideCursor();
  generation.abort(new Error("extension refresh"));
  await tick();

  assert.ok(controller.rawFullRedraws() > redraws);
  controller.close();
});

test("direct UI components share the host renderer, retain extension ownership, and dispose with their generation", async () => {
  const { input, output, controller } = fixture();
  controller.setContext({
    workspace: "/workspace",
    sessionName: "release audit",
    releaseVersion: "fixture-version",
    active: false,
    status: "idle",
    provider: "openai",
    model: "gpt-test",
    thinking: "max",
    thinkingSupported: true,
    contextWindowTokens: 200,
    autoCompaction: true,
    subscription: false,
    availableProviderCount: 3,
  });
  controller.render(envelope({
    type: "usage",
    semantics: "final",
    usage: {
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 80,
      cacheWriteTokens: 2,
      cacheWrite1hTokens: 1,
      cost: { input: 1, output: 2, cacheRead: 1.18, cacheWrite: 0, total: 4.18 },
    },
  }));
  controller.render(envelope({ type: "assistant_completed", finishReason: "stop" }));
  const firstGeneration = new AbortController();
  const secondGeneration = new AbortController();
  const first = createInteractiveDirectUiContext(controller, "first", process.cwd(), firstGeneration.signal);
  const second = createInteractiveDirectUiContext(controller, "second", process.cwd(), secondGeneration.signal);
  let firstDisposed = 0;
  let secondDisposed = 0;
  let firstInputs = 0;
  let secondInputs = 0;
  let footerStatuses: ReadonlyMap<string, string> | undefined;
  let footerSnapshot: Readonly<FooterDataSnapshot> | undefined;
  let footerDataProvider: ReadonlyFooterDataProvider | undefined;

  first.onTerminalInput(() => { firstInputs += 1; return undefined; });
  second.onTerminalInput(() => { secondInputs += 1; return undefined; });
  first.setStatus("phase", "ready");
  first.setHeader(() => component("FIRST HEADER", () => { firstDisposed += 1; }));
  first.setWidget("shared", () => component("FIRST WIDGET", () => { firstDisposed += 1; }));
  first.setFooter((_tui, _theme, data) => {
    footerDataProvider = data;
    footerStatuses = data.getExtensionStatuses();
    footerSnapshot = data.getSnapshot();
    assert.equal(data.getAvailableProviderCount(), 3);
    return component("FIRST FOOTER", () => { firstDisposed += 1; });
  });
  second.setWidget("shared", () => component("SECOND WIDGET", () => { secondDisposed += 1; }));
  await tick();

  const rendered = stripAnsi(output.text);
  assert.match(rendered, /FIRST HEADER/u);
  assert.match(rendered, /FIRST WIDGET/u);
  assert.match(rendered, /SECOND WIDGET/u);
  assert.match(rendered, /FIRST FOOTER/u);
  assert.equal(footerStatuses?.get("first:phase"), "ready");
  assert.equal(Object.isFrozen(footerSnapshot), true);
  assert.deepEqual(footerSnapshot, {
    workspace: "/workspace",
    sessionName: "release audit",
    releaseVersion: "fixture-version",
    active: false,
    status: "idle",
    provider: "openai",
    model: "gpt-test",
    thinking: "max",
    thinkingSupported: true,
    inputTokens: 20,
    outputTokens: 5,
    promptInputTokens: 102,
    cacheReadTokens: 80,
    cacheWriteTokens: 2,
    cacheWrite1hTokens: 1,
    cacheHitRate: 80 / 102 * 100,
    cost: 4.18,
    contextTokens: 102,
    contextWindowTokens: 200,
    contextSource: "provider",
    autoCompaction: true,
    subscription: false,
  });
  first.setWorkingMessage("Rechecking footer state");
  first.setWorkingVisible(false);
  first.setWorkingIndicator({ frames: ["A", "B"], intervalMs: 250 });
  controller.setContext({
    sessionName: "updated session",
    active: true,
    status: "streaming",
    activity: {
      phase: "Retrying provider",
      startedAt: 100,
      retryAt: 200,
      attempt: 2,
      cancellable: true,
    },
  });
  controller.render(envelope({
    type: "usage",
    semantics: "final",
    usage: {
      inputTokens: 30,
      outputTokens: 7,
      cacheReadTokens: 70,
      cacheWriteTokens: 0,
      cost: { input: 2, output: 3, cacheRead: 1, cacheWrite: 0, total: 6 },
    },
  }, 2));
  controller.render(envelope({ type: "assistant_completed", finishReason: "stop" }, 3));
  const updatedFooter = footerDataProvider?.getSnapshot();
  assert.equal(updatedFooter?.sessionName, "updated session");
  assert.equal(updatedFooter?.active, true);
  assert.equal(updatedFooter?.status, "streaming");
  assert.deepEqual(updatedFooter?.activity, {
    phase: "Retrying provider",
    startedAt: 100,
    retryAt: 200,
    attempt: 2,
    cancellable: true,
  });
  assert.equal(updatedFooter?.workingMessage, "Rechecking footer state");
  assert.equal(updatedFooter?.workingVisible, false);
  assert.deepEqual(updatedFooter?.workingIndicator, { frames: ["A", "B"], intervalMs: 250 });
  assert.equal(updatedFooter?.inputTokens, 30);
  assert.equal(updatedFooter?.outputTokens, 7);
  assert.equal(updatedFooter?.cacheReadTokens, 70);
  assert.equal(updatedFooter?.cacheWriteTokens, 0);
  assert.equal(updatedFooter?.cacheHitRate, 70);
  assert.equal(updatedFooter?.cost, 6);
  assert.equal(updatedFooter?.contextTokens, 100);
  assert.equal(Object.isFrozen(updatedFooter?.activity), true);
  assert.equal(Object.isFrozen(updatedFooter?.workingIndicator), true);
  assert.equal(Object.isFrozen(updatedFooter?.workingIndicator?.frames), true);
  input.write("a");
  assert.equal(firstInputs, 1);
  assert.equal(secondInputs, 1);

  firstGeneration.abort(new Error("extension refresh"));
  await tick();
  assert.equal(firstDisposed, 3);
  assert.equal(controller.extensionStatusSnapshot().has("first:phase"), false);
  assert.equal(controller.footerDataSnapshot().workingMessage, undefined);
  assert.equal(controller.footerDataSnapshot().workingVisible, undefined);
  assert.equal(secondDisposed, 0, "another extension with the same local key remains mounted");
  input.write("b");
  assert.equal(firstInputs, 1, "a removed generation no longer receives terminal input");
  assert.equal(secondInputs, 2);
  secondGeneration.abort(new Error("extension refresh"));
  assert.equal(secondDisposed, 1);
  controller.close();
});

test("footer snapshots expose newest cache observations when transcript aggregates are unavailable", () => {
  const { controller } = fixture();
  controller.setUsageBaseline({ inputTokens: 10, outputTokens: 2 });
  controller.render(envelope({
    type: "usage",
    semantics: "final",
    usage: {
      inputTokens: 20,
      outputTokens: 3,
      cacheReadTokens: 80,
      cacheWriteTokens: 4,
      cacheWrite1hTokens: 1,
    },
  }));
  controller.render(envelope({ type: "assistant_completed", finishReason: "stop" }, 2));

  const snapshot = controller.footerDataSnapshot();
  assert.equal(snapshot.cacheReadTokens, undefined);
  assert.equal(snapshot.cacheWriteTokens, undefined);
  assert.equal(snapshot.cacheWrite1hTokens, undefined);
  assert.equal(snapshot.latestCacheReadTokens, 80);
  assert.equal(snapshot.latestCacheWriteTokens, 4);
  assert.equal(snapshot.latestCacheWrite1hTokens, 1);

  controller.render(envelope({ type: "assistant_started", step: 2 }, 3));
  controller.render(envelope({ type: "assistant_completed", finishReason: "stop" }, 4));
  const lowerBound = controller.footerDataSnapshot();
  assert.equal(lowerBound.inputTokens, undefined);
  assert.equal(lowerBound.outputTokens, undefined);
  assert.equal(lowerBound.inputTokensReported, 30);
  assert.equal(lowerBound.outputTokensReported, 5);
  controller.close();
});

test("generation-owned status, working state, and titles survive only their active direct context", async () => {
  const { output, controller } = fixture();
  const older = new AbortController();
  const newer = new AbortController();
  const first = createInteractiveDirectUiContext(controller, "shared", process.cwd(), older.signal);
  const second = createInteractiveDirectUiContext(controller, "shared", process.cwd(), newer.signal);
  first.setStatus("phase", "old");
  first.setWorkingMessage("old work");
  first.setWorkingVisible(false);
  first.setTitle("old title");
  second.setStatus("phase", "new");
  second.setWorkingMessage("new work");
  second.setWorkingVisible(true);
  second.setTitle("new title");
  await tick();

  older.abort(new Error("old generation replaced"));
  await tick();
  assert.equal(controller.extensionStatusSnapshot().get("shared:phase"), "new");
  assert.equal(controller.footerDataSnapshot().workingMessage, "new work");
  assert.equal(controller.footerDataSnapshot().workingVisible, true);
  let titles = [...output.text.matchAll(/\u001b\]0;([^\u0007]*)\u0007/gu)];
  assert.equal(titles.at(-1)?.[1], "new title");

  newer.abort(new Error("new generation ended"));
  await tick();
  assert.equal(controller.extensionStatusSnapshot().has("shared:phase"), false);
  assert.equal(controller.footerDataSnapshot().workingMessage, undefined);
  assert.equal(controller.footerDataSnapshot().workingVisible, undefined);
  titles = [...output.text.matchAll(/\u001b\]0;([^\u0007]*)\u0007/gu)];
  assert.equal(titles.at(-1)?.[1], "rigyn");
  controller.close();
});

test("callback facades cancel transient presentation without rebuilding their generation owner", async () => {
  const { input, output, controller } = fixture();
  const generation = new AbortController();
  const owner = createInteractiveDirectUiContext(controller, "callback-owner", process.cwd(), generation.signal);
  const beforeStartCallback = new AbortController();
  const beforeStart = createInteractiveDirectUiFacade(owner, beforeStartCallback.signal);
  let beforeStartTui: TUI | undefined;
  beforeStart.setWidget("before-start", (tui) => {
    beforeStartTui = tui;
    return component("before-start callback", () => undefined);
  });
  assert.ok(beforeStartTui !== undefined);
  const beforeStartTerminal = beforeStartTui.terminal;
  const beforeStartOutput = output.text.length;
  beforeStartCallback.abort(new Error("cancelled before terminal start"));
  assert.throws(() => beforeStartTerminal.start(() => undefined, () => undefined), /cancelled before terminal start/u);
  assert.throws(() => beforeStartTerminal.columns, /cancelled before terminal start/u);
  assert.equal(output.text.slice(beforeStartOutput).match(/\u001b\]9;4;0;\u0007/gu)?.length ?? 0, 0);
  const firstCallback = new AbortController();
  const first = createInteractiveDirectUiFacade(owner, firstCallback.signal);
  let inputs = 0;
  let rawInputs = 0;
  let terminalInputs = 0;
  let terminalResizes = 0;
  let overlappingTerminalInputs = 0;
  let overlappingTerminalResizes = 0;
  let disposed = 0;
  let overlayDisposed = 0;
  let runtimeTui: TUI | undefined;
  first.setStatus("phase", "working");
  first.setTitle("first callback");
  first.setWidget("summary", (tui) => {
    runtimeTui = tui;
    return component("callback widget", () => { disposed += 1; });
  });
  first.onTerminalInput(() => { inputs += 1; });
  assert.ok(runtimeTui !== undefined);
  runtimeTui.addInputListener(() => { rawInputs += 1; return undefined; });
  const firstTerminal = runtimeTui.terminal;
  firstTerminal.start(() => { terminalInputs += 1; }, () => { terminalResizes += 1; });
  runtimeTui.showOverlay(component("callback overlay", () => { overlayDisposed += 1; }));
  input.write("a");
  output.resize(90, 30);
  assert.equal(inputs, 1);
  assert.equal(rawInputs, 1);
  assert.equal(terminalInputs, 1);
  assert.equal(terminalResizes, 1);
  assert.equal(controller.extensionStatusSnapshot().get("callback-owner:phase"), "working");
  assert.doesNotThrow(() => first.getEditorText());
  assert.doesNotThrow(() => first.getEditorComponent());
  assert.doesNotThrow(() => first.theme);
  assert.doesNotThrow(() => first.getAllThemes());
  assert.doesNotThrow(() => first.getTheme("mono"));
  assert.doesNotThrow(() => first.getToolsExpanded());
  const titleCallback = new AbortController();
  const titleUi = createInteractiveDirectUiFacade(owner, titleCallback.signal);
  let overlappingTui: TUI | undefined;
  titleUi.setTitle("newer callback");
  titleUi.setWidget("overlapping", (tui) => {
    overlappingTui = tui;
    return component("overlapping callback", () => undefined);
  });
  assert.ok(overlappingTui !== undefined);
  overlappingTui.terminal.start(
    () => { overlappingTerminalInputs += 1; },
    () => { overlappingTerminalResizes += 1; },
  );
  input.write("overlap");
  output.resize(91, 31);
  assert.equal(terminalInputs, 1, "the latest callback supersedes older raw terminal input");
  assert.equal(terminalResizes, 1, "the latest callback supersedes older raw terminal resize");
  assert.equal(overlappingTerminalInputs, 1);
  assert.equal(overlappingTerminalResizes, 1);
  const progressStart = output.text.length;
  firstTerminal.setProgress(50);
  overlappingTui.terminal.setProgress(50);

  firstCallback.abort(new Error("callback cancelled"));
  await tick();
  assert.equal(controller.extensionStatusSnapshot().has("callback-owner:phase"), false);
  assert.equal(disposed, 1);
  assert.equal(overlayDisposed, 1);
  input.write("b");
  output.resize(92, 32);
  assert.equal(inputs, 2);
  assert.equal(rawInputs, 2);
  assert.equal(terminalInputs, 1, "callback cancellation releases nested terminal input");
  assert.equal(terminalResizes, 1, "callback cancellation releases nested terminal resize");
  assert.equal(overlappingTerminalInputs, 2, "cancelling an older callback preserves the latest terminal input");
  assert.equal(overlappingTerminalResizes, 2, "cancelling an older callback preserves the latest terminal resize");
  const progressOutput = output.text.slice(progressStart);
  assert.equal(
    progressOutput.match(/\u001b\]9;4;0;\u0007/gu)?.length ?? 0,
    0,
    "cancelling a superseded callback does not clear the latest terminal progress",
  );
  firstTerminal.stop();
  assert.equal(output.text.slice(progressStart).match(/\u001b\]9;4;0;\u0007/gu)?.length ?? 0, 0);
  assert.equal(generation.signal.aborted, false);
  assert.throws(() => first.setStatus("phase", undefined), /callback cancelled/u);
  assert.throws(() => first.setTitle("stale callback"), /callback cancelled/u);
  assert.throws(() => first.getEditorText(), /callback cancelled/u);
  assert.throws(() => first.getEditorComponent(), /callback cancelled/u);
  assert.throws(() => first.theme, /callback cancelled/u);
  assert.throws(() => first.getAllThemes(), /callback cancelled/u);
  assert.throws(() => first.getTheme("mono"), /callback cancelled/u);
  assert.throws(() => first.getToolsExpanded(), /callback cancelled/u);
  assert.throws(() => firstTerminal.columns, /callback cancelled/u);
  assert.throws(() => firstTerminal.rows, /callback cancelled/u);
  assert.throws(() => firstTerminal.kittyProtocolActive, /callback cancelled/u);
  assert.throws(() => firstTerminal.write("stale"), /callback cancelled/u);
  assert.throws(() => firstTerminal.setTitle("stale"), /callback cancelled/u);
  let titles = [...output.text.matchAll(/\u001b\]0;([^\u0007]*)\u0007/gu)];
  assert.equal(titles.at(-1)?.[1], "newer callback");
  titleCallback.abort(new Error("title callback ended"));
  input.write("after-title");
  output.resize(93, 33);
  assert.equal(overlappingTerminalInputs, 2);
  assert.equal(overlappingTerminalResizes, 2);
  assert.equal(
    output.text.slice(progressStart).match(/\u001b\]9;4;0;\u0007/gu)?.length,
    1,
    "the latest callback emits the one final terminal progress clear",
  );
  titles = [...output.text.matchAll(/\u001b\]0;([^\u0007]*)\u0007/gu)];
  assert.equal(titles.at(-1)?.[1], "rigyn");

  const laterCallback = new AbortController();
  const later = createInteractiveDirectUiFacade(owner, laterCallback.signal);
  let laterTui: TUI | undefined;
  later.setWidget("later", (tui) => {
    laterTui = tui;
    return component("later widget", () => undefined);
  });
  assert.ok(laterTui !== undefined);
  laterTui.terminal.start(() => { terminalInputs += 1; }, () => { terminalResizes += 1; });
  input.write("c");
  output.resize(94, 34);
  assert.equal(terminalInputs, 2, "a later callback can start its own terminal lifecycle");
  assert.equal(terminalResizes, 2);
  const explicitStopProgress = output.text.length;
  laterTui.terminal.setProgress(50);
  laterTui.terminal.stop();
  laterTui.terminal.stop();
  assert.equal(
    output.text.slice(explicitStopProgress).match(/\u001b\]9;4;0;\u0007/gu)?.length,
    1,
    "explicit terminal stop clears progress exactly once",
  );
  input.write("d");
  output.resize(95, 35);
  assert.equal(terminalInputs, 2, "nested terminal stop releases only its callback input");
  assert.equal(terminalResizes, 2, "nested terminal stop releases only its callback resize");
  const pending = later.input("Wait for input");
  laterCallback.abort(new Error("later callback cancelled"));
  assert.equal(await pending, undefined);
  assert.equal(output.text.slice(explicitStopProgress).match(/\u001b\]9;4;0;\u0007/gu)?.length, 1);
  assert.equal(generation.signal.aborted, false);

  const successfulCallback = new AbortController();
  const successful = createInteractiveDirectUiFacade(
    owner,
    AbortSignal.any([successfulCallback.signal, generation.signal]),
  );
  let successfulTui: TUI | undefined;
  successful.setWidget("successful", (tui) => {
    successfulTui = tui;
    return component("successful widget", () => undefined);
  });
  assert.ok(successfulTui !== undefined);
  successfulTui.terminal.start(() => { terminalInputs += 1; }, () => { terminalResizes += 1; });
  input.write("e");
  output.resize(96, 36);
  assert.equal(terminalInputs, 3);
  assert.equal(terminalResizes, 3);
  const generationProgress = output.text.length;
  successfulTui.terminal.setProgress(50);
  generation.abort(new Error("generation ended"));
  input.write("f");
  output.resize(97, 37);
  assert.equal(terminalInputs, 3, "generation close releases successful callback terminal input");
  assert.equal(terminalResizes, 3, "generation close releases successful callback terminal resize");
  assert.equal(
    output.text.slice(generationProgress).match(/\u001b\]9;4;0;\u0007/gu)?.length,
    1,
    "generation close clears callback terminal progress exactly once",
  );
  assert.equal(successfulCallback.signal.aborted, false);
  controller.close();
});

test("distinct sources sharing an extension ID retain independent direct UI ownership", async () => {
  const { controller } = fixture();
  const firstGeneration = new AbortController();
  const secondGeneration = new AbortController();
  const first = createOwnedInteractiveDirectUiContext(
    controller,
    "shared:source-a",
    process.cwd(),
    firstGeneration.signal,
  );
  const second = createOwnedInteractiveDirectUiContext(
    controller,
    "shared:source-b",
    process.cwd(),
    secondGeneration.signal,
  );

  first.setStatus("phase", "source-a");
  first.setWorkingMessage("work-a");
  second.setStatus("phase", "source-b");
  second.setWorkingMessage("work-b");
  await tick();

  assert.deepEqual([...controller.extensionStatusSnapshot().values()].sort(), ["source-a", "source-b"]);
  assert.equal(controller.footerDataSnapshot().workingMessage, "work-b");

  secondGeneration.abort(new Error("source-b unloaded"));
  await tick();
  assert.deepEqual([...controller.extensionStatusSnapshot().values()], ["source-a"]);
  assert.equal(controller.footerDataSnapshot().workingMessage, "work-a");
  assert.equal(firstGeneration.signal.aborted, false);

  firstGeneration.abort(new Error("source-a unloaded"));
  await tick();
  assert.equal(controller.extensionStatusSnapshot().size, 0);
  assert.equal(controller.footerDataSnapshot().workingMessage, undefined);
  controller.close();
});

test("footer branch data follows named and detached Git transitions until its generation ends", async (context) => {
  try {
    await execute("git", ["--version"]);
  } catch {
    context.skip("git is unavailable");
    return;
  }
  const repository = await mkdtemp(join(tmpdir(), "rigyn-footer-branch-"));
  context.after(async () => await rm(repository, { recursive: true, force: true }));
  await execute("git", ["init"], { cwd: repository });
  await execute("git", ["config", "user.name", "Fixture User"], { cwd: repository });
  await execute("git", ["config", "user.email", "fixture@example.invalid"], { cwd: repository });
  await writeFile(join(repository, "file.txt"), "initial\n", "utf8");
  await execute("git", ["add", "file.txt"], { cwd: repository });
  await execute("git", ["commit", "-m", "initial"], { cwd: repository });
  const initial = (await execute("git", ["branch", "--show-current"], { cwd: repository })).stdout.trim();
  assert.notEqual(initial, "");

  const { controller } = fixture();
  context.after(() => controller.close());
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(controller, "branch-footer", repository, generation.signal);
  let data: ReadonlyFooterDataProvider | undefined;
  ui.setFooter((_tui, _theme, provider) => {
    data = provider;
    return component("BRANCH FOOTER", () => {});
  });
  await tick();
  assert.ok(data);
  const hydrated = new Promise<void>((resolve) => {
    const dispose = data!.onBranchChange(() => { dispose(); resolve(); });
    data!.getGitBranch();
  });
  await hydrated;
  assert.equal(data.getGitBranch(), initial);

  const secondGeneration = new AbortController();
  const secondUi = createInteractiveDirectUiContext(controller, "second-branch-footer", repository, secondGeneration.signal);
  let secondData: ReadonlyFooterDataProvider | undefined;
  secondUi.setFooter((_tui, _theme, provider) => {
    secondData = provider;
    return component("SECOND BRANCH FOOTER", () => {});
  });
  await tick();
  assert.ok(secondData);
  assert.equal(secondData.getGitBranch(), initial, "a second context reuses the hydrated branch cache");

  const transition = async (args: readonly string[], expected: string | null): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    let dispose = (): void => undefined;
    let disposeSecond = (): void => undefined;
    const changed = new Promise<void>((resolve, reject) => {
      let remaining = 2;
      timer = setTimeout(() => reject(new Error(`Timed out waiting for branch ${String(expected)}`)), 4_000);
      const observed = () => {
        remaining -= 1;
        if (remaining === 0) resolve();
      };
      dispose = data!.onBranchChange(observed);
      disposeSecond = secondData!.onBranchChange(observed);
    });
    try {
      await execute("git", [...args], { cwd: repository });
      await changed;
      assert.equal(data!.getGitBranch(), expected);
      assert.equal(secondData!.getGitBranch(), expected);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      dispose();
      disposeSecond();
    }
  };

  await transition(["switch", "-c", "footer-feature"], "footer-feature");
  await transition(["switch", "--detach", "HEAD"], null);
  await transition(["switch", initial], initial);

  let notifications = 0;
  data.onBranchChange(() => { notifications += 1; });
  generation.abort(new Error("generation ended"));
  await execute("git", ["switch", "footer-feature"], { cwd: repository });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for the surviving shared branch probe")), 4_000);
    const dispose = secondData!.onBranchChange(() => {
      clearTimeout(timeout);
      dispose();
      resolve();
    });
  });
  assert.equal(notifications, 0);
  assert.equal(secondData.getGitBranch(), "footer-feature");
  secondGeneration.abort(new Error("last generation ended"));
});

test("theme changes invalidate only currently mounted direct components", async () => {
  const { controller } = fixture();
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(controller, "theme-owners", process.cwd(), generation.signal);
  let replacedInvalidations = 0;
  let currentInvalidations = 0;
  let customInvalidations = 0;
  let finishCustom: ((value: string) => void) | undefined;

  ui.setHeader(() => ({
    render: () => ["old"],
    invalidate() { replacedInvalidations += 1; },
  }));
  ui.setHeader(() => ({
    render: () => ["current"],
    invalidate() { currentInvalidations += 1; },
  }));
  await tick();
  const redraws = controller.rawFullRedraws();
  controller.setTheme("signal");
  await tick();
  assert.equal(replacedInvalidations, 0);
  assert.equal(currentInvalidations, 1);
  assert.equal(controller.rawFullRedraws(), redraws, "theme changes stay on the differential render path");

  ui.setHeader(undefined);
  controller.setTheme("mono");
  assert.equal(currentInvalidations, 1);

  const customResult = ui.custom<string>((_tui, _theme, _keybindings, done) => {
    finishCustom = done;
    return {
      render: () => ["custom"],
      invalidate() { customInvalidations += 1; },
    };
  });
  await tick();
  controller.setTheme("signal");
  assert.equal(customInvalidations, 1);
  finishCustom?.("done");
  assert.equal(await customResult, "done");
  controller.setTheme("mono");
  assert.equal(customInvalidations, 1);

  generation.abort(new Error("extension refresh"));
  controller.close();
});

test("oversized direct widgets stay mounted and show an explicit bounded overflow row", async () => {
  const { output, controller } = fixture();
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(controller, "overflow", process.cwd(), generation.signal);
  let disposed = 0;

  ui.setWidget("tall", () => ({
    render: () => Array.from({ length: 6 }, (_, index) => `direct row ${index}`),
    invalidate() {},
    dispose() { disposed += 1; },
  }));
  await tick();

  const rendered = stripAnsi(output.text);
  assert.match(rendered, /direct row 0/u);
  assert.match(rendered, /… 3 more rows/u);
  assert.equal(disposed, 0, "valid oversized output is truncated without unmounting its component");
  generation.abort(new Error("extension refresh"));
  assert.equal(disposed, 1);
  controller.close();
});

test("mounted raw images reserve their background rows", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    handleSignals: false,
    environment: {
      TERM: "xterm-kitty",
      KITTY_WINDOW_ID: "1",
      LANG: "en_US.UTF-8",
      TERM_COLOR: "0",
    },
  });
  controller.start();
  const generation = new AbortController();
  try {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(20, 16);
    png.writeUInt32BE(100, 20);
    const ui = createInteractiveDirectUiContext(controller, "raw-image", process.cwd(), generation.signal);
    ui.setWidget("preview", () => new Image(
      png.toString("base64"),
      "image/png",
      { fallbackColor: (value) => value },
      { maxWidthCells: 2, maxHeightCells: 2, imageId: 7 },
    ));
    ui.setBackground(() => ({
      render(_width, height) {
        return Array.from({ length: height }, (_, row) => ({ row, column: 0, text: "B" }));
      },
      invalidate() {},
    }));
    await tick();

    const image = output.text.lastIndexOf("\u001b_G");
    assert.ok(image >= 0, "the mounted public Image reaches the live surface");
    const imageRow = output.text.slice(output.text.lastIndexOf("\u001b[2K", image), image);
    assert.doesNotMatch(stripAnsi(imageRow), /B/u, "background does not shift the image from column zero");
    const terminator = output.text.indexOf("\u001b\\", image) + 2;
    const reservedStart = output.text.indexOf("\u001b[2K", terminator);
    const reservedEnd = output.text.indexOf("\r\n", reservedStart);
    assert.ok(reservedStart >= 0 && reservedEnd > reservedStart, "the image reserves its second terminal row");
    assert.doesNotMatch(
      stripAnsi(output.text.slice(reservedStart, reservedEnd)),
      /B/u,
      "background does not occupy the image's reserved continuation row",
    );
  } finally {
    generation.abort(new Error("extension generation ended"));
    controller.close();
    resetCapabilitiesCache();
  }
});

test("direct backgrounds resize, clear stale cells, and restore the previous generation", async () => {
  const { output, controller } = fixture();
  controller.setEditorText("draft");
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  flush();
  const firstGeneration = new AbortController();
  const secondGeneration = new AbortController();
  const first = createInteractiveDirectUiContext(controller, "background-first", process.cwd(), firstGeneration.signal);
  const second = createInteractiveDirectUiContext(controller, "background-second", process.cwd(), secondGeneration.signal);
  const dimensions: Array<[number, number]> = [];
  let invalidations = 0;
  let firstDisposed = 0;
  let secondDisposed = 0;

  first.setBackground(() => ({
    render(width, height) {
      dimensions.push([width, height]);
      return [
        { row: height - 3, column: 1, text: "X" },
        { row: height - 3, column: width - 1, text: "░" },
      ];
    },
    invalidate() { invalidations += 1; },
    dispose() { firstDisposed += 1; },
  }));
  await tick();
  flush();
  assert.match(terminal.viewport().join("\n"), /░/u);
  assert.doesNotMatch(terminal.viewport().join("\n"), /X/u, "editor content wins over a colliding background cell");
  assert.deepEqual(dimensions.at(-1), [80, 24]);

  terminal.resize(18, 8);
  output.resize(18, 8);
  await tick();
  flush();
  assert.deepEqual(dimensions.at(-1), [18, 8]);
  assert.equal(invalidations, 1);
  assert.match(stripAnsi(output.text), /░/u);

  second.setBackground(() => ({
    render: () => [{ row: 2, column: 17, text: "B" }],
    invalidate() {},
    dispose() { secondDisposed += 1; },
  }));
  await tick();
  flush();
  assert.match(terminal.viewport().join("\n"), /B/u);
  secondGeneration.abort(new Error("extension refresh"));
  await tick();
  flush();
  assert.equal(secondDisposed, 1);
  assert.match(terminal.viewport().join("\n"), /░/u, "removing the newest owner restores the previous background");

  const outputBeforeClear = output.text.length;
  first.setBackground(undefined);
  await tick();
  flush();
  assert.equal(firstDisposed, 1);
  assert.doesNotMatch(terminal.viewport().join("\n"), /░/u);
  const clearOutput = output.text.slice(outputBeforeClear);
  assert.match(clearOutput, /\u001b\[2K/u, "clearing repaints the row that held the background glyph");
  assert.doesNotMatch(clearOutput, /\u001b\[(?:2J|3J)/u, "the viewport scrollback is not cleared with the background");

  firstGeneration.abort(new Error("extension refresh"));
  assert.equal(firstDisposed, 1, "a cleared background is disposed exactly once");
  controller.close();
});

test("invalid background controls fail closed and non-full hosts do not invoke factories", async () => {
  const { output, controller } = fixture();
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(controller, "background-invalid", process.cwd(), generation.signal);
  let disposed = 0;
  output.chunks.length = 0;
  ui.setBackground(() => ({
    render: () => [{ row: 0, column: 0, text: "\u001b[31mX" }],
    invalidate() {},
    dispose() { disposed += 1; },
  }));
  await tick();
  assert.equal(disposed, 1);
  assert.match(stripAnsi(output.text), /Raw background failed: [\s\S]*printable, single-column grapheme/u);
  assert.doesNotMatch(output.text, /\u001b\[31mX/u);
  generation.abort(new Error("extension refresh"));
  controller.close();

  const classicInput = new FakeInput();
  const classicOutput = new FakeOutput();
  const classic = new TuiController({
    input: classicInput,
    output: classicOutput,
    mode: "classic",
    handleSignals: false,
  });
  const classicGeneration = new AbortController();
  const classicUi = createInteractiveDirectUiContext(classic, "background-classic", process.cwd(), classicGeneration.signal);
  let invoked = false;
  classicUi.setBackground(() => {
    invoked = true;
    return { render: () => [], invalidate() {} };
  });
  assert.equal(invoked, false);
  classicGeneration.abort(new Error("extension refresh"));
  classic.close();
});

test("direct custom components receive raw input and clean up exactly once on completion or abort", async () => {
  const { input, output, controller } = fixture();
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(controller, "custom", process.cwd(), generation.signal);
  let disposed = 0;
  let focused = false;
  const result = ui.custom<string>((tui, theme, _keybindings, done) => {
    tui.terminal.hideCursor();
    return {
      render: () => [`${theme.fg("accent", "RAW PANEL")}${CURSOR_MARKER}`],
      handleInput: (data) => done(data),
      invalidate() {},
      dispose: () => { disposed += 1; },
    };
  }, { onHandle: (handle) => { focused = handle.isFocused(); } });
  await tick();
  assert.match(stripAnsi(output.text), /RAW PANEL/u);
  assert.equal(focused, true);
  input.write("z");
  assert.equal(await result, "z");
  assert.equal(disposed, 1);

  const expired = ui.custom<void>(() => component("TEMPORARY PANEL", () => { disposed += 1; }));
  generation.abort(new Error("extension refresh"));
  assert.equal(await expired, undefined);
  assert.equal(disposed, 2);
  controller.close();
  assert.deepEqual(input.rawChanges, [true, false]);
  assert.match(output.text, /\u001b\[\?25h/u);
});

test("direct custom and editor factories receive the controller's live complete keybinding manager", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const bindings = new Keybindings({ "app.model.select": "alt+k" });
  const controller = new TuiController({
    input,
    output,
    keybindings: bindings,
    handleSignals: false,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8", TERM_COLOR: "0" },
  });
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(controller, "bindings", process.cwd(), generation.signal);
  let customManager: unknown;
  let editorManager: unknown;

  const completed = ui.custom<void>((_tui, _theme, manager, done) => {
    customManager = manager;
    done();
    return component("bindings", () => undefined);
  });
  await completed;
  ui.setEditorComponent((_tui, _theme, manager) => {
    editorManager = manager;
    return {
      render: () => [CURSOR_MARKER],
      handleInput() {},
      getText: () => "",
      getExpandedText: () => "",
      setText() {},
      invalidate() {},
    };
  });

  assert.equal(customManager, bindings.manager());
  assert.equal(editorManager, bindings.manager());
  assert.deepEqual(bindings.manager().getKeys("app.model.select"), ["alt+k"]);
  generation.abort(new Error("done"));
  controller.close();
});

test("direct editor factories replace, submit through, wrap, and restore the host editor", async () => {
  const { input, output, controller } = fixture();
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(controller, "editor", process.cwd(), generation.signal);
  controller.setEditorText("draft");
  let disposed = 0;
  const factory = (): EditorComponent & { dispose(): void } => {
    let text = "";
    const editor: EditorComponent & { dispose(): void } = {
      render: () => [`CUSTOM ${text}${CURSOR_MARKER}`],
      handleInput(data) {
        if (data === "\r") editor.onSubmit?.(text);
        else {
          text += data;
          editor.onChange?.(text);
        }
      },
      getText: () => text,
      getExpandedText: () => text,
      setText(value) { text = value; editor.onChange?.(text); },
      invalidate() {},
      dispose: () => { disposed += 1; },
    };
    return editor;
  };

  ui.setEditorComponent(factory);
  assert.equal(ui.getEditorComponent(), factory);
  await tick();
  assert.match(stripAnsi(output.text), /CUSTOM draft/u);
  input.write("x");
  assert.equal(ui.getEditorText(), "draftx");
  const submitted = controller.question("you> ");
  input.write("\r");
  assert.equal(await submitted, "draftx");

  controller.setEditorText("preserved");
  generation.abort(new Error("extension refresh"));
  assert.equal(disposed, 1);
  const restored = controller.question("you> ");
  input.write("y\r");
  assert.equal(await restored, "preservedy");
  controller.close();
});

test("raw editors retain host actions, shortcuts, autocomplete, focus, and appearance", async () => {
  const { input, controller } = fixture();
  const actions: import("../../src/tui/types.js").TuiAction[] = [];
  const generation = new AbortController();
  controller.setActionHandler((action) => actions.push(action));
  controller.setOperatorPreferences({ editorPaddingX: 2, autocompleteMaxVisible: 7 });
  let completions = 0;
  controller.setAutocompleteProvider(Object.assign(
    async () => {
      completions += 1;
      return [{ start: 0, end: 0, value: "done" }];
    },
    { triggerCharacters: ["#"] as const },
  ), generation.signal);
  controller.setExtensionShortcuts([{ shortcut: "ctrl+k", description: "custom action" }], generation.signal);
  const ui = createInteractiveDirectUiContext(controller, "host-editor", process.cwd(), generation.signal);
  let editor: Editor | undefined;
  ui.setEditorComponent((tui, theme) => {
    editor = new Editor(tui, theme);
    return editor;
  });

  assert.equal(editor?.focused, true);
  assert.equal(editor?.getPaddingX(), 2);
  assert.equal(editor?.getAutocompleteMaxVisible(), 7);
  input.write("\t");
  await tick();
  assert.equal(completions, 1);

  controller.setKeybindings(new Keybindings({ "app.message.followUp": "f1" }));
  controller.setEditorText("ab");
  input.write("\u001b[D");
  input.write("\u001bOP");
  assert.equal(controller.getEditorText(), "a\nb");

  input.write("\u000b");
  input.write(Buffer.from(process.platform === "win32" ? [27, 118] : [22]));
  assert.deepEqual(actions.slice(-2).map((action) => action.type), ["extension_shortcut", "paste_image"]);

  controller.setEditorText("ab");
  input.write("\u001b");
  input.write("[D");
  input.write("\u0004");
  assert.equal(controller.getEditorText(), "a");
  assert.notEqual(actions.at(-1)?.type, "exit");
  controller.setEditorText("");
  input.write("\u0004");
  assert.equal(actions.at(-1)?.type, "exit");

  controller.setContext({ active: true });
  input.write("\u001b");
  await new Promise<void>((resolve) => setTimeout(resolve, 75));
  assert.equal(actions.at(-1)?.type, "cancel");
  generation.abort(new Error("done"));
  assert.equal(editor?.focused, false);
  controller.close();
});

test("direct UI contexts report the globally active editor factory across extension generations", () => {
  const { controller } = fixture();
  const firstGeneration = new AbortController();
  const secondGeneration = new AbortController();
  const first = createInteractiveDirectUiContext(controller, "first-editor", process.cwd(), firstGeneration.signal);
  const second = createInteractiveDirectUiContext(controller, "second-editor", process.cwd(), secondGeneration.signal);
  const editor = (): EditorComponent => ({
    render: () => [CURSOR_MARKER],
    handleInput() {},
    getText: () => "",
    getExpandedText: () => "",
    setText() {},
    invalidate() {},
  });
  const firstFactory = () => editor();
  const secondFactory = () => editor();

  first.setEditorComponent(firstFactory);
  assert.equal(first.getEditorComponent(), firstFactory);
  assert.equal(second.getEditorComponent(), firstFactory);
  second.setEditorComponent(secondFactory);
  assert.equal(first.getEditorComponent(), secondFactory);
  assert.equal(second.getEditorComponent(), secondFactory);

  secondGeneration.abort(new Error("second generation replaced"));
  assert.equal(first.getEditorComponent(), firstFactory);
  assert.throws(() => second.getEditorComponent(), /second generation replaced/u);
  firstGeneration.abort(new Error("first generation replaced"));
  assert.throws(() => first.getEditorComponent(), /first generation replaced/u);
  controller.close();
});

test("removing a covered raw editor does not overwrite the active editor draft", () => {
  const { controller } = fixture();
  const firstGeneration = new AbortController();
  const secondGeneration = new AbortController();
  const first = createInteractiveDirectUiContext(controller, "covered-editor", process.cwd(), firstGeneration.signal);
  const second = createInteractiveDirectUiContext(controller, "active-editor", process.cwd(), secondGeneration.signal);
  const factory = (tui: import("@rigyn/terminal").TUI, theme: import("@rigyn/terminal").EditorTheme): EditorComponent =>
    new Editor(tui, theme);

  first.setEditorComponent(factory);
  first.setEditorText("covered draft");
  second.setEditorComponent(factory);
  second.setEditorText("active draft");

  firstGeneration.abort(new Error("covered editor unloaded"));
  assert.equal(second.getEditorText(), "active draft");
  secondGeneration.abort(new Error("active editor unloaded"));
  assert.equal(controller.getEditorText(), "active draft");
  controller.close();
});

test("raw editors restore the active session draft when its scope changes", () => {
  const { controller } = fixture();
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(controller, "scoped-editor", process.cwd(), generation.signal);
  ui.setEditorComponent((tui, theme) => new Editor(tui, theme));

  controller.setDraftScope("first");
  ui.setEditorText("first draft");
  controller.setDraftScope("second");
  assert.equal(ui.getEditorText(), "");
  ui.setEditorText("second draft");
  controller.setDraftScope("first");
  assert.equal(ui.getEditorText(), "first draft");

  generation.abort(new Error("done"));
  controller.close();
});

test("direct autocomplete preserves triggers, predicates, and grapheme cursor offsets", async () => {
  const { input, controller } = fixture();
  const baseGeneration = new AbortController();
  const extensionGeneration = new AbortController();
  const nativeRequests: Array<{ text: string; cursor: number; force: boolean | undefined }> = [];
  const rawRequests: Array<{ cursorLine: number; cursorCol: number; force: boolean | undefined }> = [];
  const predicates: Array<{ cursorLine: number; cursorCol: number }> = [];
  const base = Object.assign(
    async (text: string, cursor: number, _signal: AbortSignal, options?: { force?: boolean }) => {
      nativeRequests.push({ text, cursor, force: options?.force });
      return null;
    },
    { triggerCharacters: ["#"] as const },
  );
  controller.setAutocompleteProvider(base, baseGeneration.signal);
  const ui = createInteractiveDirectUiContext(
    controller,
    "autocomplete",
    process.cwd(),
    extensionGeneration.signal,
  );
  ui.addAutocompleteProvider((current) => ({
    triggerCharacters: ["$"],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      rawRequests.push({ cursorLine, cursorCol, force: options.force });
      return await current.getSuggestions(lines, cursorLine, cursorCol, options);
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(_lines, cursorLine, cursorCol) {
      predicates.push({ cursorLine, cursorCol });
      return false;
    },
  }));

  controller.setEditorText("🙂 ");
  input.write("$");
  await tick();
  assert.deepEqual(rawRequests, [{ cursorLine: 0, cursorCol: 4, force: false }]);
  assert.deepEqual(nativeRequests, [{ text: "🙂 $", cursor: 3, force: false }]);

  controller.setEditorText("🙂");
  input.write("\t");
  await tick();
  assert.deepEqual(predicates, [{ cursorLine: 0, cursorCol: 2 }]);
  assert.equal(nativeRequests.length, 1, "a rejected forced completion does not invoke the provider");
  assert.equal(controller.getEditorText(), "🙂  ", "the normal Tab fallback remains available");

  extensionGeneration.abort(new Error("extension generation ended"));
  baseGeneration.abort(new Error("base autocomplete ended"));
  controller.close();
});

test("direct autocomplete pass-through preserves the native replacement range and item", async () => {
  const { input, controller } = fixture();
  const baseGeneration = new AbortController();
  const extensionGeneration = new AbortController();
  controller.setAutocompleteProvider(async (text, cursor) => {
    assert.equal(text, "abc");
    assert.equal(cursor, 3);
    return [{ start: 0, end: 3, value: "xyz", cursor: 1, label: "replacement", detail: "native range" }];
  }, baseGeneration.signal);
  const ui = createInteractiveDirectUiContext(
    controller,
    "autocomplete-range",
    process.cwd(),
    extensionGeneration.signal,
  );
  let suggestedItem: AutocompleteItem | undefined;
  ui.addAutocompleteProvider((current) => ({
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      suggestedItem = suggestions?.items[0];
      assert.deepEqual(suggestedItem, {
        value: "xyz",
        label: "replacement",
        description: "native range",
      });
      return suggestions;
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      assert.equal(item, suggestedItem);
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
  }));

  controller.setEditorText("abc");
  input.write("\t");
  await tick();
  input.write("!");
  await tick();
  assert.equal(controller.getEditorText(), "x!yz");

  extensionGeneration.abort(new Error("extension generation ended"));
  baseGeneration.abort(new Error("base autocomplete ended"));
  controller.close();
});

test("direct autocomplete preserves a multiline cursor at an emoji boundary", async () => {
  const { input, controller } = fixture();
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(
    controller,
    "autocomplete-cursor",
    process.cwd(),
    generation.signal,
  );
  ui.addAutocompleteProvider(() => ({
    async getSuggestions() {
      return { prefix: "", items: [{ value: "replacement", label: "replacement" }] };
    },
    applyCompletion() {
      return {
        lines: ["heading", "🙂tail"],
        cursorLine: 1,
        cursorCol: 1,
      };
    },
  }));

  controller.setEditorText("replace");
  input.write("\t");
  await tick();
  input.write("!");
  await tick();
  assert.equal(controller.getEditorText(), "heading\n🙂!tail");

  generation.abort(new Error("extension generation ended"));
  controller.close();
});

test("direct autocomplete derives long completion ranges without repeated grapheme segmentation", async () => {
  const { input, controller } = fixture();
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(
    controller,
    "autocomplete-linear",
    process.cwd(),
    generation.signal,
  );
  const prefix = "a".repeat(2_000);
  ui.addAutocompleteProvider(() => ({
    async getSuggestions() {
      return {
        prefix: "",
        items: Array.from({ length: 24 }, (_, index) => ({ value: `choice-${index}`, label: `choice-${index}` })),
      };
    },
    applyCompletion(_lines, _cursorLine, _cursorCol, item) {
      return { lines: [`${prefix}${item.value}`], cursorLine: 0, cursorCol: prefix.length + item.value.length };
    },
  }));

  controller.setEditorText(prefix);
  const started = performance.now();
  input.write("\t");
  await tick();
  assert.ok(performance.now() - started < 2_000, "completion range derivation remains linear in each candidate");

  generation.abort(new Error("done"));
  controller.close();
});

test("a failing direct renderer is removed, reported, and never disposed twice", async () => {
  const { output, controller } = fixture();
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(controller, "failure", process.cwd(), generation.signal);
  let disposed = 0;
  ui.setWidget("broken", () => ({
    render: () => { throw new Error("renderer exploded"); },
    invalidate() {},
    dispose: () => { disposed += 1; },
  }));
  await tick();
  assert.match(stripAnsi(output.text), /Raw UI component failed: renderer exploded/u);
  assert.equal(disposed, 1);
  generation.abort(new Error("extension refresh"));
  assert.equal(disposed, 1);
  controller.close();
});

test("trusted terminal state, protocol queries, input draining, and ownership controls use the live host", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    theme: "mono",
    handleSignals: false,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8", KITTY_WINDOW_ID: "1" },
  });
  controller.start();
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(controller, "terminal", process.cwd(), generation.signal);
  let tui: TUI | undefined;
  ui.setWidget("capture", (value) => {
    tui = value;
    return component("terminal capture", () => undefined);
  });
  assert.ok(tui !== undefined);
  assert.ok(tui instanceof TUI, "trusted contexts retain the public TUI runtime identity");

  assert.equal(tui.terminal.columns, 80);
  assert.equal(tui.terminal.rows, 24);
  output.resize(132, 41);
  assert.equal(tui.terminal.columns, 132);
  assert.equal(tui.terminal.rows, 41);

  input.write("\u001b[?5u");
  assert.equal(tui.terminal.kittyProtocolActive, true);

  const schemes: string[] = [];
  const removeScheme = tui.onTerminalColorSchemeChange((scheme) => schemes.push(scheme));
  const outputBeforeNotifications = output.text.length;
  tui.setTerminalColorSchemeNotifications(true);
  assert.match(output.text.slice(outputBeforeNotifications), /\u001b\[\?2031h/u);

  const scheme = tui.queryTerminalColorScheme({ timeoutMs: 100 });
  assert.match(output.text, /\u001b\[\?996n/u);
  input.write("\u001b[?997;2n");
  assert.equal(await scheme, "light");
  assert.deepEqual(schemes, ["light"]);

  const background = tui.queryTerminalBackgroundColor({ timeoutMs: 100 });
  assert.match(output.text, /\u001b\]11;\?\u0007/u);
  input.write("\u001b]11;rgb:ffff/0000/0000\u0007");
  assert.deepEqual(await background, { r: 255, g: 0, b: 0 });
  assert.deepEqual(schemes, ["light", "dark"]);
  removeScheme();
  const outputBeforeDisable = output.text.length;
  tui.setTerminalColorSchemeNotifications(false);
  assert.match(output.text.slice(outputBeforeDisable), /\u001b\[\?2031l/u);

  controller.setEditorText("");
  input.write("\u001b");
  const drained = tui.terminal.drainInput(100, 10);
  input.write("discarded while draining");
  await drained;
  assert.equal(controller.getEditorText(), "");
  input.write("k");
  assert.equal(controller.getEditorText(), "k");

  generation.abort(new Error("extension generation ended"));
  controller.close();
});

test("trusted TUI start and stop pause only generation-owned rendering and input", async () => {
  const { input, output, controller } = fixture();
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(controller, "lifecycle", process.cwd(), generation.signal);
  let tui: TUI | undefined;
  ui.setWidget("capture", (value) => {
    tui = value;
    return component("capture", () => undefined);
  });
  assert.ok(tui !== undefined);

  let renders = 0;
  let childDisposed = 0;
  const ownedChild: Component & { dispose(): void } = {
    render: () => { renders += 1; return ["owned child"]; },
    invalidate() {},
    dispose: () => { childDisposed += 1; },
  };
  tui.addChild(ownedChild);
  await tick();
  assert.ok(renders > 0);

  let inputs = 0;
  const removeInput = tui.addInputListener(() => { inputs += 1; return { consume: true }; });
  tui.showOverlay(component("owned overlay", () => undefined), { nonCapturing: true });
  assert.equal(tui.hasOverlay(), true);
  tui.stop();
  await tick();
  const stoppedRenders = renders;
  tui.requestRender();
  input.write("a");
  await tick();
  assert.equal(renders, stoppedRenders);
  assert.equal(inputs, 0);
  assert.equal(tui.hasOverlay(), false);
  assert.equal(childDisposed, 0, "pausing the trusted TUI preserves component state");

  tui.start();
  await tick();
  assert.ok(renders > stoppedRenders);
  const redraws = tui.fullRedraws;
  tui.requestRender(true);
  await tick();
  assert.ok(tui.fullRedraws > redraws, "forced requests perform a real host redraw");
  assert.equal(tui.hasOverlay(), true);
  input.write("b");
  assert.equal(inputs, 1);
  removeInput();

  const rewritten: string[] = [];
  const removeRewrite = tui.addInputListener(() => ({ data: "rewritten" }));
  const removeObserve = tui.addInputListener((data) => { rewritten.push(data); return { consume: true }; });
  input.write("source");
  assert.deepEqual(rewritten, ["rewritten"]);
  removeRewrite();
  removeObserve();
  let debug = 0;
  tui.onDebug = () => { debug += 1; };
  input.write("\u001b[100;6u");
  assert.equal(debug, 1);

  let terminalInputs = 0;
  let resizes = 0;
  tui.terminal.start(() => { terminalInputs += 1; }, () => { resizes += 1; });
  tui.terminal.start(() => { terminalInputs += 100; }, () => { resizes += 100; });
  input.write("c");
  output.resize(90, 30);
  assert.equal(terminalInputs, 1, "starting the shared terminal twice remains idempotent");
  assert.equal(resizes, 1);
  tui.terminal.stop();
  input.write("d");
  assert.equal(terminalInputs, 1);
  tui.hideOverlay();

  generation.abort(new Error("extension generation ended"));
  assert.equal(childDisposed, 1);
  controller.close();
});

test("trusted overlay handles remove their stack record when permanently hidden", async () => {
  const { controller } = fixture();
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(controller, "overlay-stack", process.cwd(), generation.signal);
  let tui: TUI | undefined;
  ui.setWidget("capture", (value) => {
    tui = value;
    return component("capture", () => undefined);
  });
  assert.ok(tui !== undefined);

  tui.showOverlay(component("first", () => undefined));
  const second = tui.showOverlay(component("second", () => undefined));
  second.hide();
  assert.equal(tui.hasOverlay(), true);
  tui.hideOverlay();
  assert.equal(tui.hasOverlay(), false);

  generation.abort(new Error("done"));
  controller.close();
});

test("trusted theme discovery reports source paths and successful selections persist", async () => {
  const { controller } = fixture();
  controller.setCustomThemes([{ schemaVersion: 1, name: "ocean", base: "dark", styles: {} }]);
  const settings = SettingsManager.inMemory();
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(
    controller,
    "themes",
    process.cwd(),
    generation.signal,
    {
      settings,
      themePath: (name) => name === "ocean" ? "/themes/ocean.json" : undefined,
    },
  );

  assert.deepEqual(
    ui.getAllThemes().find((theme) => theme.name === "ocean"),
    { name: "ocean", path: "/themes/ocean.json" },
  );
  assert.deepEqual(ui.setTheme("ocean"), { success: true });
  assert.equal(controller.selectedThemeName(), "ocean");
  assert.equal(settings.getTheme(), "ocean");
  let tui: TUI | undefined;
  ui.setWidget("settings", (value) => {
    tui = value;
    return component("settings", () => undefined);
  });
  assert.ok(tui !== undefined);
  tui.setShowHardwareCursor(false);
  tui.setClearOnShrink(true);
  assert.equal(tui.getShowHardwareCursor(), false);
  assert.equal(tui.getClearOnShrink(), true);
  assert.equal(settings.getShowHardwareCursor(), false);
  assert.equal(settings.getClearOnShrink(), true);
  await settings.flush();
  assert.equal(ui.setTheme("missing").success, false);
  assert.equal(settings.getTheme(), "ocean", "a rejected theme never changes persistent settings");

  let traps = 0;
  const hostile = new Proxy(Object.create(null) as object, {
    getPrototypeOf() {
      traps += 1;
      throw new Error("prototype trap ran");
    },
    get() {
      traps += 1;
      throw new Error("property trap ran");
    },
  });
  Object.defineProperty(controller, "setTheme", {
    configurable: true,
    value() { throw hostile; },
  });
  assert.deepEqual(ui.setTheme("signal"), { success: false, error: "[Thrown object]" });
  assert.equal(traps, 0);

  const secretPrefix = "registered-direct-ui-secret:";
  const secret = `${secretPrefix}${"s".repeat(64 * 1_024 - Buffer.byteLength(secretPrefix, "utf8"))}`;
  defaultSecretRedactor.register(secret);
  Object.defineProperty(controller, "setTheme", {
    configurable: true,
    value() { throw new Error(`${"a".repeat(4_080)}${secret}-visible-tail`); },
  });
  const bounded = ui.setTheme("signal");
  assert.equal(bounded.success, false);
  if (typeof bounded.error === "string") {
    assert.equal(Buffer.byteLength(bounded.error, "utf8"), 4_096);
    assert.equal(bounded.error, `${"a".repeat(4_080)}[REDACTED]-visib`);
    assert.doesNotMatch(bounded.error, /registered-direct-ui-secret/u);
  } else assert.fail("theme failure omitted its diagnostic");

  generation.abort(new Error("extension generation ended"));
  controller.close();
});

test("trusted theme objects may be runtime-only and mounted components observe later theme changes", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    handleSignals: false,
    environment: { TERM: "xterm-256color", COLORTERM: "truecolor", LANG: "en_US.UTF-8" },
  });
  controller.start();
  const settings = SettingsManager.inMemory({ theme: "mono" });
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(
    controller,
    "runtime-theme",
    process.cwd(),
    generation.signal,
    { settings },
  );
  let receivedTheme: import("../../src/tui/theme.js").Theme | undefined;
  let invalidations = 0;
  ui.setWidget("live", (_tui, theme) => {
    receivedTheme = theme;
    return {
      render: () => [`LIVE THEME ${theme.name}`],
      invalidate: () => { invalidations += 1; },
    };
  });
  const base = controller.currentThemeObject();
  const runtimeOnly = { ...base, name: "runtime-only" } as import("../../src/tui/theme.js").Theme;
  assert.equal(ui.getTheme("runtime-only"), undefined);
  assert.deepEqual(ui.setTheme(runtimeOnly), { success: true });
  await tick();
  assert.equal(receivedTheme?.name, "runtime-only");
  assert.match(stripAnsi(output.text), /LIVE THEME runtime-only/u);
  assert.ok(invalidations > 0);
  assert.equal(settings.getTheme(), "mono", "ephemeral theme objects are not persisted as catalog names");

  const before = invalidations;
  assert.deepEqual(ui.setTheme("signal"), { success: true });
  await tick();
  assert.equal(receivedTheme?.name, "signal");
  assert.ok(invalidations > before);
  assert.equal(settings.getTheme(), "signal");

  generation.abort(new Error("extension generation ended"));
  controller.close();
});

test("the public Theme constructor round-trips through direct extension theme selection", async () => {
  const controller = new TuiController({
    input: new FakeInput(),
    output: new FakeOutput(),
    handleSignals: false,
    environment: { TERM: "xterm-256color", COLORTERM: "truecolor", LANG: "en_US.UTF-8" },
  });
  controller.start();
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(
    controller,
    "public-runtime-theme",
    process.cwd(),
    generation.signal,
  );
  const foreground = Object.fromEntries(
    THEME_TOKENS
      .filter((token) => !THEME_BACKGROUND_TOKENS.includes(token as ThemeBg))
      .map((token) => [token, token === "accent" ? "#00aaff" : ""]),
  ) as Record<ThemeColor, string | number>;
  const background = Object.fromEntries(
    THEME_BACKGROUND_TOKENS.map((token) => [token, ""]),
  ) as Record<ThemeBg, string | number>;
  const selected = new Theme(foreground, background, "truecolor", { name: "extension-blue" });

  assert.deepEqual(ui.setTheme(selected), { success: true });
  assert.equal(controller.currentThemeObject().name, "extension-blue");
  assert.equal(controller.currentThemeObject().getFgAnsi("accent"), "\x1b[38;2;0;170;255m");

  generation.abort(new Error("extension generation ended"));
  controller.close();
});

test("interval-only working indicators receive animated default frames", async () => {
  const { output, controller } = fixture();
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(controller, "indicator", process.cwd(), generation.signal);
  ui.setWorkingIndicator({ intervalMs: 50 });
  controller.setContext({ active: true, status: "streaming" });
  await new Promise<void>((resolve) => setTimeout(resolve, 170));
  const rendered = stripAnsi(output.text);
  const frames = ["◐", "◓", "◑", "◒", ".", "o", "O"].filter((frame) => rendered.includes(frame));
  assert.ok(new Set(frames).size >= 2);
  generation.abort(new Error("extension generation ended"));
  controller.close();
});
