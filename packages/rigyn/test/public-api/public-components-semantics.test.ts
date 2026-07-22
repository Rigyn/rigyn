import assert from "node:assert/strict";
import test from "node:test";

import type { Model } from "@rigyn/models";
import { Container, Text, type Component, type KeybindingsManager, type TUI } from "@rigyn/terminal";

import {
  AssistantMessageComponent,
  BashExecutionComponent,
  CustomMessageComponent,
  ExtensionEditorComponent,
  ExtensionInputComponent,
  ExtensionSelectorComponent,
  LoginDialogComponent,
  ModelSelectorComponent,
  OAuthSelectorComponent,
  SessionSelectorComponent,
  ToolExecutionComponent,
  TreeSelectorComponent,
  UserMessageComponent,
} from "../../src/tui/public-components.js";
import { THEME_BACKGROUND_TOKENS, THEME_TOKENS, Theme, type ThemeBg, type ThemeColor } from "../../src/tui/theme.js";
import type { ToolDefinition, ToolRenderContext, ToolRenderResultOptions } from "../../src/extensions/direct.js";

function fakeTui(): TUI {
  return {
    terminal: { rows: 24, columns: 100 },
    requestRender() {},
    stop() {},
    start() {},
  } as unknown as TUI;
}

function text(component: Component, width = 100): string {
  return component.render(width).join("\n").replace(/\x1b\[[0-9;]*m|\x1b\]133;[ABC]\x07/gu, "");
}

function contains(root: Component, target: Component): boolean {
  if (root === target) return true;
  return root instanceof Container && root.children.some((child) => contains(child, target));
}

function model(provider: string, id: string, name = id): Model {
  return {
    provider,
    id,
    name,
    api: "openai-responses",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
}

test("runtime Theme honors color mode, resets, fallbacks, and validation", async () => {
  const foreground = Object.fromEntries(
    THEME_TOKENS.filter((token) => !THEME_BACKGROUND_TOKENS.includes(token as ThemeBg))
      .map((token) => [token, token === "accent" ? "#ff0000" : ""]),
  ) as Record<ThemeColor, string | number>;
  delete (foreground as Partial<Record<ThemeColor, string | number>>).thinkingMax;
  foreground.thinkingXhigh = 33;
  const background = Object.fromEntries(THEME_BACKGROUND_TOKENS.map((token) => [token, ""])) as Record<ThemeBg, string | number>;

  const theme = new Theme(foreground, background, "256color", { name: "test" });
  assert.equal(theme.name, "test");
  assert.equal(theme.getFgAnsi("accent"), "\x1b[38;5;196m");
  assert.equal(theme.getFgAnsi("text"), "\x1b[39m");
  assert.equal(theme.getBgAnsi("selectedBg"), "\x1b[49m");
  assert.equal(theme.getFgAnsi("thinkingMax"), "\x1b[38;5;33m");
  assert.throws(() => new Theme({ ...foreground, accent: "31" }, background, "truecolor"), /Invalid color value/u);
  assert.equal((await import("../../src/index.js")).Theme, Theme);
});

test("model selector mounts its search input and keeps provider/id identity across refresh", async () => {
  let models = [model("first", "shared"), model("second", "shared")];
  const settings: string[] = [];
  let selected: Model | undefined;
  const runtime = {
    getAvailableSnapshot: () => models,
    getModel: (provider: string, id: string) => models.find((entry) => entry.provider === provider && entry.id === id),
    getError: () => undefined,
    async refresh() {
      models = [model("first", "shared"), model("second", "shared", "refreshed")];
      return { aborted: false, errors: new Map() };
    },
  };
  const selector = new ModelSelectorComponent(
    fakeTui(),
    models[1],
    { setDefaultModelAndProvider: (provider: string, id: string) => settings.push(`${provider}/${id}`) },
    runtime,
    [],
    (value) => { selected = value; },
    () => {},
    "second shared",
  );
  assert.equal(selector.getSearchInput().getValue(), "second shared");
  assert.equal(contains(selector, selector.getSearchInput()), true);
  selector.focused = true;
  assert.equal(selector.getSearchInput().focused, true);
  await new Promise((resolve) => setImmediate(resolve));
  selector.handleInput("\n");
  assert.equal(selected?.provider, "second");
  assert.equal(selected?.name, "refreshed");
  assert.deepEqual(settings, ["second/shared"]);
});

test("auth selector uses the public argument order and searchable initial input", () => {
  let selected: string | undefined;
  const selector = new OAuthSelectorComponent(
    "login",
    [
      { id: "alpha", name: "Alpha", authType: "api_key" },
      { id: "beta", name: "Beta", authType: "oauth" },
    ],
    (id, type) => { selected = `${id}:${type}`; },
    () => {},
    "beta",
  );
  selector.handleInput("\n");
  assert.equal(selected, "beta:oauth");
  selector.focused = true;
  assert.match(text(selector), /Beta/u);
});

test("session selector loads current sessions asynchronously and exposes a usable list", async () => {
  let selected: string | undefined;
  let renders = 0;
  const selector = new SessionSelectorComponent(
    async () => [{ path: "/tmp/one.jsonl", id: "one", cwd: "/tmp", created: new Date(), modified: new Date(), messageCount: 1, firstMessage: "One", allMessagesText: "One" }],
    async () => [],
    (path) => { selected = path; },
    () => {},
    () => {},
    () => { renders += 1; },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(text(selector), /One/u);
  selector.handleInput("\n");
  assert.equal(selected, "/tmp/one.jsonl");
  assert.ok(renders > 0);
  assert.ok(selector.getSessionList());
});

test("tree selector recursively flattens nodes and preserves initial focus", () => {
  let selected: string | undefined;
  const selector = new TreeSelectorComponent([
    {
      entry: { id: "root", type: "message", parentId: null },
      children: [{ entry: { id: "child", type: "message", parentId: "root" }, children: [] }],
    },
  ], "child", 20, (id) => { selected = id; }, () => {}, undefined, "child");
  assert.match(text(selector), /root/u);
  assert.match(text(selector), /child/u);
  selector.handleInput("\n");
  assert.equal(selected, "child");
  selector.focused = true;
  assert.equal(selector.focused, true);
});

test("login dialog prompts wait for input and keep prior submitted values", async () => {
  const dialog = new LoginDialogComponent(fakeTui(), "provider", () => {}, "Provider", "Connect Provider");
  const first = dialog.showPrompt("First", "example");
  dialog.handleInput("secret-one");
  dialog.handleInput("\n");
  assert.equal(await first, "secret-one");
  const second = dialog.showManualInput("Second");
  dialog.handleInput("secret-two");
  assert.match(text(dialog), /secret-one/u);
  dialog.handleInput("\n");
  assert.equal(await second, "secret-two");
  dialog.focused = true;
  assert.equal(dialog.focused, true);
});

test("extension input, editor, and selector honor public options and focus", () => {
  let inputValue: string | undefined;
  const input = new ExtensionInputComponent("Input", "placeholder", (value) => { inputValue = value; }, () => {}, { tui: fakeTui() });
  input.focused = true;
  input.handleInput("value");
  input.handleInput("\n");
  assert.equal(inputValue, "value");

  let editorValue: string | undefined;
  const editor = new ExtensionEditorComponent(fakeTui(), { matches: () => false } as unknown as KeybindingsManager, "Editor", "draft", (value) => { editorValue = value; }, () => {}, { paddingX: 2 }, "false");
  editor.focused = true;
  editor.handleInput("\r");
  assert.equal(editorValue, "draft");

  const selector = new ExtensionSelectorComponent("Choose", ["one", "two"], () => {}, () => {}, { onToggleToolsExpanded: () => {} });
  assert.match(text(selector), /Choose/u);
});

test("bash and tool result expansion changes rendered output", () => {
  const output = Array.from({ length: 30 }, (_, index) => `line-${index}`).join("\n");
  const bash = new BashExecutionComponent("run", fakeTui());
  bash.appendOutput(output);
  bash.setComplete(0, false);
  assert.doesNotMatch(text(bash), /line-0/u);
  bash.setExpanded(true);
  assert.match(text(bash), /line-0/u);

  const tool = new ToolExecutionComponent("inspect", "call", {}, { showImages: false }, undefined, fakeTui(), "/tmp");
  tool.updateResult({ content: [{ type: "text", text: output }], isError: false });
  assert.doesNotMatch(text(tool), /line-0/u);
  tool.setExpanded(true);
  assert.match(text(tool), /line-0/u);

  const rendered = new ToolExecutionComponent("custom", "call-2", { value: 1 }, {}, {
    renderCall(_args: unknown, _theme: unknown, context: ToolRenderContext) { return new Text(`started:${context.executionStarted}`, 0, 0); },
    renderResult(_result: unknown, options: ToolRenderResultOptions) { return new Text(`expanded:${options.expanded}`, 0, 0); },
  } as unknown as ToolDefinition, fakeTui(), "/tmp");
  rendered.markExecutionStarted();
  rendered.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
  assert.match(text(rendered), /started:true/u);
  assert.match(text(rendered), /expanded:false/u);
  rendered.setExpanded(true);
  assert.match(text(rendered), /expanded:true/u);
});

test("message presentation setters rebuild rendered content", () => {
  const message = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "answer" }],
    stopReason: "stop",
  };
  const assistant = new AssistantMessageComponent(message as unknown as import("@rigyn/models").AssistantMessage, false, undefined, "Working", 1);
  assert.match(text(assistant), /private/u);
  assistant.setHideThinkingBlock(true);
  assistant.setHiddenThinkingLabel("Hidden");
  assert.doesNotMatch(text(assistant), /private/u);
  assert.match(text(assistant), /Hidden/u);
  assistant.setOutputPad(0);
  assert.ok(text(assistant, 50).split("\n").some((line) => line.startsWith("answer")));

  const user = new UserMessageComponent("hello", undefined, 1);
  assert.ok(user.render(50).some((line) => line.startsWith(" hello")));
  user.setOutputPad(0);
  assert.ok(user.render(50).some((line) => line.startsWith("hello")));

  const custom = new CustomMessageComponent({
    role: "custom",
    customType: "status",
    content: "payload",
    display: true,
    timestamp: Date.now(),
  }, (_value, options) => new Text(options.expanded ? "expanded" : "collapsed", 0, 0));
  assert.match(text(custom), /collapsed/u);
  custom.setExpanded(true);
  assert.match(text(custom), /expanded/u);
});
