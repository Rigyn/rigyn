import assert from "node:assert/strict";
import test from "node:test";

import type { Model } from "@rigyn/models";
import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import {
  Container,
  getCapabilities,
  getKeybindings,
  Image,
  Input,
  isImageLine,
  KeybindingsManager,
  renderViewport,
  setCapabilities,
  setKeybindings,
  Text,
  TUI_KEYBINDINGS,
  visibleWidth,
  type Component,
  type TUI,
} from "@rigyn/terminal";

import {
  AssistantMessageComponent,
  BashExecutionComponent,
  BorderedLoader,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  CustomEditor,
  DynamicBorder,
  ExtensionEditorComponent,
  ExtensionInputComponent,
  ExtensionSelectorComponent,
  FooterComponent,
  LoginDialogComponent,
  ModelSelectorComponent,
  OAuthSelectorComponent,
  SessionSelectorComponent,
  ShowImagesSelectorComponent,
  type SettingsConfig,
  SettingsSelectorComponent,
  SkillInvocationMessageComponent,
  ThemeSelectorComponent,
  ThinkingSelectorComponent,
  ToolExecutionComponent,
  TreeSelectorComponent,
  UserMessageComponent,
  UserMessageSelectorComponent,
} from "../../src/tui/public-components.js";
import { currentTheme } from "../../src/tui/public-theme.js";
import { THEME_BACKGROUND_TOKENS, THEME_TOKENS, Theme, type ThemeBg, type ThemeColor } from "../../src/tui/theme.js";
import type { ToolDefinition, ToolRenderContext, ToolRenderResultOptions } from "../../src/extensions/direct.js";
import type { SessionInfo } from "../../src/storage/types.js";

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

function countComponents(root: Component, predicate: (component: Component) => boolean): number {
  return (predicate(root) ? 1 : 0)
    + (root instanceof Container ? root.children.reduce((total, child) => total + countComponents(child, predicate), 0) : 0);
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

const settingsConfigHasNoInstallTelemetry: "enableInstallTelemetry" extends keyof SettingsConfig ? false : true = true;
void settingsConfigHasNoInstallTelemetry;

function plainTheme(): Theme {
  const foreground = Object.fromEntries(
    THEME_TOKENS.filter((token) => !THEME_BACKGROUND_TOKENS.includes(token as ThemeBg)).map((token) => [token, ""]),
  ) as Record<ThemeColor, string | number>;
  const background = Object.fromEntries(THEME_BACKGROUND_TOKENS.map((token) => [token, ""])) as Record<ThemeBg, string | number>;
  return new Theme(foreground, background, "256color", { name: "test" });
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

test("public borders and cancellable loader preserve width and cancellation semantics", () => {
  const border = new DynamicBorder((value) => `<${value}>`);
  assert.equal(border.render(4)[0], "<────>");
  assert.equal(border.render(-1)[0], "<>");

  let renders = 0;
  let aborts = 0;
  const tui = {
    terminal: { rows: 24, columns: 100 },
    requestRender() { renders += 1; },
    stop() {},
    start() {},
  } as unknown as TUI;
  const loader = new BorderedLoader(tui, plainTheme(), "Working");
  loader.onAbort = () => { aborts += 1; };
  loader.handleInput("\u001b");
  loader.handleInput("\u001b");
  assert.equal(loader.signal.aborted, true);
  assert.equal(aborts, 1);
  assert.ok(renders > 0);
  loader.dispose();
});

test("custom editor and public value selectors route application actions exactly once", () => {
  const matched: Record<string, string> = {
    P: "app.clipboard.pasteImage",
    X: "app.tools.expand",
    "\u001b": "app.interrupt",
    "\u0004": "app.exit",
  };
  const editor = new CustomEditor(fakeTui(), {
    borderColor: (value) => value,
    selectList: {
      selectedPrefix: (value) => value,
      selectedText: (value) => value,
      description: (value) => value,
      scrollInfo: (value) => value,
      noMatch: (value) => value,
    },
  }, {
    matches(data, action) { return matched[data] === action; },
  });
  const actions: string[] = [];
  editor.onPasteImage = () => actions.push("paste");
  editor.onEscape = () => actions.push("escape");
  editor.onCtrlD = () => actions.push("exit");
  editor.onAction("app.tools.expand", () => actions.push("tools"));
  editor.handleInput("P");
  editor.handleInput("X");
  editor.handleInput("\u001b");
  editor.handleInput("\u0004");
  assert.deepEqual(actions, ["paste", "tools", "escape", "exit"]);

  let thinking: string | undefined;
  const thinkingSelector = new ThinkingSelectorComponent("high", ["low", "high"], (value) => { thinking = value; }, () => {});
  thinkingSelector.handleInput("\n");
  thinkingSelector.handleInput("\n");
  assert.equal(thinking, "high");

  let images: boolean | undefined;
  const imageSelector = new ShowImagesSelectorComponent(false, (value) => { images = value; }, () => {});
  imageSelector.handleInput("\n");
  imageSelector.handleInput("\n");
  assert.equal(images, false);
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
  assert.match(text(selector), /Beta \[OAuth\]/u);
  assert.doesNotMatch(text(selector), /subscription/u);

  const labels = new OAuthSelectorComponent("login", [
    { id: "alpha", name: "Alpha", authType: "api_key" },
    { id: "beta", name: "Beta", authType: "oauth" },
  ], () => {}, () => {});
  assert.match(text(labels), /Alpha \[API key\]/u);
  assert.match(text(labels), /Beta \[OAuth\]/u);
});

test("auth selector keeps long-list navigation and search selections visible", () => {
  const providers = Array.from({ length: 12 }, (_, index) => ({
    id: `provider-${index}`,
    name: `Provider ${index}`,
    authType: index % 2 === 0 ? "api_key" as const : "oauth" as const,
  }));
  let selected: string | undefined;
  const selector = new OAuthSelectorComponent(
    "login",
    providers,
    (id) => { selected = id; },
    () => {},
  );
  for (let index = 0; index < 9; index += 1) selector.handleInput("\u001b[B");
  assert.match(text(selector), /→ Provider 9/u);
  assert.doesNotMatch(text(selector), /Provider 0/u);
  selector.handleInput("\n");
  assert.equal(selected, "provider-9");

  const searched = new OAuthSelectorComponent("login", providers, () => {}, () => {}, "provider 11");
  assert.match(text(searched), /→ Provider 11/u);
});

test("theme and user-message selectors expose custom names and readable history", async () => {
  let theme: string | undefined;
  const themes = new ThemeSelectorComponent(
    "workspace-theme",
    (value) => { theme = value; },
    () => {},
    () => {},
    ["workspace-theme"],
  );
  assert.match(text(themes), /workspace-theme/u);
  themes.handleInput("\n");
  assert.equal(theme, "workspace-theme");

  let selected: string | undefined;
  const messages = new UserMessageSelectorComponent([
    { id: "first-id", text: "Inspect the workspace" },
    { id: "second-id", text: "Fix the failing test" },
  ], (id) => { selected = id; }, () => {});
  assert.match(text(messages), /Inspect the workspace/u);
  assert.match(text(messages), /Fix the failing test/u);
  assert.doesNotMatch(text(messages), /first-id/u);
  messages.handleInput("\n");
  assert.equal(selected, "second-id");

  let cancelled = 0;
  const empty = new UserMessageSelectorComponent([], () => {}, () => { cancelled += 1; });
  empty.handleInput("\x1b");
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(cancelled, 1);
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

test("session selector contains hostile loader failures without inspecting them", async () => {
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
  const selector = new SessionSelectorComponent(
    async () => { throw hostile; },
    async () => [],
    () => {},
    () => {},
    () => {},
    () => {},
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(text(selector), /Failed to load sessions: \[Thrown object\]/u);
  assert.equal(traps, 0);

  const secret = "registered-public-session-selector-secret";
  defaultSecretRedactor.register(secret);
  const unsafeText = new SessionSelectorComponent(
    async () => { throw new Error(`${secret}\u001b]2;owned\u0007`); },
    async () => [],
    () => {},
    () => {},
    () => {},
    () => {},
  );
  await new Promise((resolve) => setImmediate(resolve));
  const rendered = text(unsafeText);
  assert.match(rendered, /\[REDACTED\]/u);
  assert.doesNotMatch(rendered, /registered-public-session-selector-secret|owned|\u001b/u);
});

test("session selector contains hostile delete failures without inspecting them", async () => {
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
  const bindings = {
    matches(data: string, action: string) {
      return (action === "app.session.delete" && data === "D")
        || (action === "tui.select.confirm" && data === "\n");
    },
  } as unknown as KeybindingsManager;
  const source: SessionInfo = {
    path: "/tmp/hostile.jsonl",
    id: "hostile",
    cwd: "/tmp",
    name: "Hostile",
    created: new Date(),
    modified: new Date(),
    messageCount: 1,
    firstMessage: "Hostile",
    allMessagesText: "Hostile",
  };
  const makeSelector = (options: {
    deleteSession?: (path: string) => Promise<void>;
  }) => new SessionSelectorComponent(
    async () => [source],
    async () => [source],
    () => {},
    () => {},
    () => {},
    () => {},
    { keybindings: bindings, ...options },
  );

  const remove = makeSelector({ async deleteSession() { throw hostile; } });
  await new Promise((resolve) => setImmediate(resolve));
  remove.handleInput("D");
  remove.handleInput("\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(text(remove), /Delete failed: \[Thrown object\]/u);
  assert.equal(traps, 0);
});

test("session selector truncates CJK and joined emoji by terminal cells", async () => {
  const now = new Date();
  const selector = new SessionSelectorComponent(
    async () => [
      { path: "/tmp/cjk.jsonl", id: "cjk", cwd: "/tmp", name: "漢漢漢漢漢漢", created: now, modified: now, messageCount: 1, firstMessage: "cjk", allMessagesText: "cjk" },
      { path: "/tmp/emoji.jsonl", id: "emoji", cwd: "/tmp", name: "👨‍👩‍👧‍👦 family", created: now, modified: now, messageCount: 1, firstMessage: "emoji", allMessagesText: "emoji" },
    ],
    async () => [],
    () => {},
    () => {},
    () => {},
    () => {},
  );
  await new Promise((resolve) => setImmediate(resolve));
  const rows = selector.getSessionList().render(10).slice(1);
  assert.equal(rows.every((row) => visibleWidth(row) <= 10), true);
  const emojiRow = rows.find((row) => row.includes("👨"));
  assert.equal(emojiRow === undefined || emojiRow.includes("👨‍👩‍👧‍👦"), true);
});

test("session selector ignores stale loads when a scope is selected again", async () => {
  type Resolver = (sessions: SessionInfo[]) => void;
  const currentResolvers: Resolver[] = [];
  const allResolvers: Resolver[] = [];
  const bindings = {
    matches(data: string, action: string) {
      return action === "app.session.toggleScope" && data === "T";
    },
  } as unknown as KeybindingsManager;
  const load = (resolvers: Resolver[]) => async (): Promise<SessionInfo[]> => await new Promise((resolve) => {
    resolvers.push(resolve);
  });
  const session = (id: string): SessionInfo => ({
    path: `/tmp/${id}.jsonl`,
    id,
    cwd: "/tmp",
    created: new Date(),
    modified: new Date(),
    messageCount: 1,
    firstMessage: id,
    allMessagesText: id,
  });
  const selector = new SessionSelectorComponent(
    load(currentResolvers),
    load(allResolvers),
    () => {},
    () => {},
    () => {},
    () => {},
    { keybindings: bindings },
  );
  selector.handleInput("T");
  selector.handleInput("T");
  assert.equal(currentResolvers.length, 2);
  assert.equal(allResolvers.length, 1);

  currentResolvers[1]!([session("NEWEST")]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(text(selector), /NEWEST/u);
  currentResolvers[0]!([session("STALE")]);
  allResolvers[0]!([session("ALL-STALE")]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(text(selector), /NEWEST/u);
  assert.doesNotMatch(text(selector), /STALE/u);
});

test("session selector marks the current file and ignores the former rename key", async () => {
  const selector = new SessionSelectorComponent(
    async () => [{
      path: "/tmp/current.jsonl",
      id: "current",
      cwd: "/tmp",
      name: "Old",
      created: new Date(),
      modified: new Date(),
      messageCount: 1,
      firstMessage: "One",
      allMessagesText: "One",
    }],
    async () => [],
    () => {},
    () => {},
    () => {},
    () => {},
    undefined,
    "/tmp/current.jsonl",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(text(selector), /● Old/u);
  selector.handleInput("\u0012");
  assert.doesNotMatch(text(selector), /Rename session/u);
});

test("session selector supports threaded order, filtering, sorting, and confirmed deletion", async () => {
  const now = Date.now();
  let sessions = [
    {
      path: "/tmp/root.jsonl",
      id: "root",
      cwd: "/tmp",
      created: new Date(now - 2_000),
      modified: new Date(now - 2_000),
      messageCount: 1,
      firstMessage: "Root session",
      allMessagesText: "Root session",
    },
    {
      path: "/tmp/child.jsonl",
      id: "child",
      cwd: "/tmp",
      name: "Named child",
      parentSessionPath: "/tmp/root.jsonl",
      created: new Date(now - 1_000),
      modified: new Date(now - 1_000),
      messageCount: 1,
      firstMessage: "Child session",
      allMessagesText: "Child session",
    },
  ];
  const deleted: string[] = [];
  let finishDelete!: () => void;
  const deletion = new Promise<void>((resolve) => { finishDelete = resolve; });
  const bindings = {
    matches(data: string, action: string) {
      return (action === "app.session.toggleSort" && data === "S")
        || (action === "app.session.toggleNamedFilter" && data === "N")
        || (action === "app.session.delete" && data === "D")
        || (action === "tui.select.confirm" && data === "\n")
        || (action === "tui.select.cancel" && data === "\u001b");
    },
  } as unknown as KeybindingsManager;
  const selector = new SessionSelectorComponent(
    async () => sessions,
    async () => sessions,
    () => {},
    () => {},
    () => {},
    () => {},
    {
      keybindings: bindings,
      async deleteSession(path) {
        deleted.push(path);
        await deletion;
        sessions = sessions.filter((session) => session.path !== path);
      },
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const threaded = text(selector);
  assert.ok(threaded.indexOf("Root session") < threaded.indexOf("Named child"));
  selector.handleInput("S");
  assert.match(text(selector), /recent/u);
  assert.ok(text(selector).indexOf("Named child") < text(selector).indexOf("Root session"));
  selector.handleInput("N");
  assert.match(text(selector), /named only/u);
  assert.doesNotMatch(text(selector), /Root session/u);
  selector.handleInput("D");
  assert.match(text(selector), /Delete Named child/u);
  selector.handleInput("\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deleted, ["/tmp/child.jsonl"]);
  selector.handleInput("\n");
  assert.deepEqual(deleted, ["/tmp/child.jsonl"]);
  finishDelete();
  await new Promise((resolve) => setImmediate(resolve));
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

test("tree and session selectors complete at most once and ignore disposed loads", async () => {
  let treeSelections = 0;
  const tree = new TreeSelectorComponent([
    { entry: { id: "root", type: "message", parentId: null }, children: [] },
  ], "root", 20, () => { treeSelections += 1; }, () => {});
  tree.handleInput("\n");
  tree.handleInput("\n");
  assert.equal(treeSelections, 1);

  let resolveSessions!: (sessions: SessionInfo[]) => void;
  let renders = 0;
  const session = new SessionSelectorComponent(
    async () => await new Promise((resolve) => { resolveSessions = resolve; }),
    async () => [],
    () => {},
    () => {},
    () => {},
    () => { renders += 1; },
  );
  const beforeDispose = renders;
  session.dispose();
  resolveSessions([{
    path: "/tmp/disposed.jsonl",
    id: "disposed",
    cwd: "/tmp",
    created: new Date(),
    modified: new Date(),
    messageCount: 1,
    firstMessage: "Disposed",
    allMessagesText: "Disposed",
  }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renders, beforeDispose);
  assert.doesNotMatch(text(session), /Disposed/u);
});

test("tree selector bounds malformed parent cycles", () => {
  const selector = new TreeSelectorComponent([
    {
      entry: { id: "root", type: "message", parentId: "child" },
      children: [{ entry: { id: "child", type: "message", parentId: "root" }, children: [] }],
    },
  ], "child", 20, () => {}, () => {});
  assert.match(text(selector), /2\/2/u);
});

test("tree selector bounds cyclic child objects", () => {
  type CyclicNode = { entry: { id: string; type: "message" }; children: CyclicNode[] };
  const root: CyclicNode = { entry: { id: "root", type: "message" }, children: [] };
  root.children.push(root);
  const selector = new TreeSelectorComponent([root], "root", 20, () => {}, () => {});
  assert.match(text(selector), /1\/1/u);
});

test("tree selector rejects an unbounded public node set", () => {
  const nodes = Array.from({ length: 50_001 }, (_, index) => ({
    entry: { id: `node-${index}`, type: "message" },
    children: [],
  }));
  assert.throws(
    () => new TreeSelectorComponent(nodes, null, 20, () => {}, () => {}),
    /at most 50000 nodes/u,
  );
});

test("empty tree selector cancels at most once", async () => {
  let cancellations = 0;
  const selector = new TreeSelectorComponent([], null, 20, () => {}, () => { cancellations += 1; });
  selector.handleInput("\u001b");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(cancellations, 1);
});

test("tree selector handles a deeply nested public tree without recursive overflow", () => {
  type DeepNode = {
    entry: { id: string; type: "message"; parentId: string | null };
    children: DeepNode[];
  };
  let root: DeepNode | undefined;
  for (let depth = 9_999; depth >= 0; depth -= 1) {
    const id = `node-${depth}`;
    root = {
      entry: { id, type: "message", parentId: depth === 0 ? null : `node-${depth - 1}` },
      children: root === undefined ? [] : [root],
    };
  }
  assert.ok(root);
  const selector = new TreeSelectorComponent([root], "node-9999", 20, () => {}, () => {}, undefined, "node-9999");
  assert.match(text(selector), /10000\/10000/u);
  assert.equal(selector.getTreeList().getSelectedItem()?.value, "node-9999");
});

test("tree selector copies, labels, filters, and folds the selected hierarchy", () => {
  const labels: Array<[string, string | undefined]> = [];
  let copied: string | undefined;
  const selector = new TreeSelectorComponent([
    {
      entry: {
        id: "root",
        type: "message",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "Root request" }] },
      },
      children: [{
        entry: {
          id: "tool",
          type: "message",
          parentId: "root",
          message: { role: "tool", content: [{ type: "text", text: "Tool output" }] },
        },
        children: [],
      }],
    },
  ], "root", 20, () => {}, () => {}, (id, label) => labels.push([id, label]), "root", "all");
  selector.onCopy = (value) => { copied = value; };
  selector.handleInput("\u0018");
  assert.match(copied ?? "", /Root request/u);
  selector.handleInput("\u001b[76;2u");
  selector.handleInput("important");
  selector.handleInput("\n");
  assert.deepEqual(labels, [["root", "important"]]);
  assert.match(text(selector), /important/u);
  selector.handleInput("\u0014");
  assert.doesNotMatch(text(selector), /Tool output/u);
  selector.handleInput("\u001b[1;5D");
  assert.match(text(selector), /more|important|root/u);
});

test("public settings selector cycles values and dispatches typed callbacks", () => {
  const changes: string[] = [];
  const config = {
    autoCompact: true,
    showImages: true,
    imageWidthCells: 80,
    autoResizeImages: true,
    blockImages: false,
    enableSkillCommands: true,
    steeringMode: "one-at-a-time",
    followUpMode: "all",
    transport: "auto",
    httpIdleTimeoutMs: 300_000,
    thinkingLevel: "high",
    availableThinkingLevels: ["off", "high", "max"],
    currentTheme: "mono",
    terminalTheme: "dark",
    availableThemes: ["mono", "signal"],
    hideThinkingBlock: false,
    showCacheMissNotices: false,
    collapseChangelog: true,
    doubleEscapeAction: "tree",
    treeFilterMode: "default",
    showHardwareCursor: true,
    editorPaddingX: 1,
    outputPad: 1,
    autocompleteMaxVisible: 8,
    quietStartup: false,
    defaultProjectTrust: "ask",
    clearOnShrink: false,
    showTerminalProgress: true,
    warnings: {},
  } as const;
  const callbacks = new Proxy({ onCancel() {} }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return (value: unknown) => changes.push(`${String(property)}:${String(value)}`);
    },
  });
  const selector = new SettingsSelectorComponent(config as never, callbacks as never);
  selector.getSettingsList().handleInput("\n");
  assert.deepEqual(changes, ["onAutoCompactChange:false"]);
  assert.match(text(selector), /Automatic compaction/u);
});

test("public footer reports session context and keeps compaction policy out of chrome", () => {
  const footer = new FooterComponent({
    sessionManager: {
      getCwd: () => "/workspace",
      getSessionName: () => "audit",
      getActiveBranchUsage: () => ({
        usage: { inputTokens: 1_250, outputTokens: 400, cacheReadTokens: 900, cacheWriteTokens: 120 },
        hasUsageObservations: true,
        latestAssistantUsage: { totalTokens: 100, outputTokens: 0, cacheReadTokens: 25 },
      }),
    },
    getSessionStats: () => ({
      tokens: { input: 1_250, output: 400, cacheRead: 900, cacheWrite: 120 },
      cost: 0.125,
      contextUsage: { tokens: 8_000, contextWindow: 16_000, percent: 50 },
    }),
    state: {
      model: { id: "reasoner", provider: "local", reasoning: true },
      thinkingLevel: "high",
    },
  }, {
    getGitBranch: () => "main",
    getAvailableProviderCount: () => 2,
    getExtensionStatuses: () => new Map([["memory", "memory: ready"]]),
  });

  assert.match(text(footer), /workspace · main · audit/u);
  assert.match(text(footer), /cache 25\.0%/u);
  assert.doesNotMatch(text(footer), /cache\+/u);
  assert.match(text(footer), /ctx 50\.0%\/16k/u);
  assert.doesNotMatch(text(footer), /auto/u);
  assert.match(text(footer), /\(local\) reasoner · high/u);
  assert.match(text(footer), /memory: ready/u);
});

test("public footer preserves latest cache percentage truth across session states", () => {
  const renderCache = (
    getActiveBranchUsage: (() => {
      usage: Record<string, number>;
      hasUsageObservations?: boolean;
      latestAssistantUsage?: Record<string, number>;
    }) | undefined,
    includeStats = true,
  ): string => text(new FooterComponent({
    sessionManager: {
      getCwd: () => "/workspace",
      ...(getActiveBranchUsage === undefined ? {} : { getActiveBranchUsage }),
    },
    ...(includeStats
      ? { getSessionStats: () => ({ tokens: { input: 100, cacheRead: 80, cacheWrite: 20 } }) }
      : {}),
  }, { getGitBranch: () => null }));

  assert.match(renderCache(() => ({
    usage: { totalTokens: 100, outputTokens: 0, cacheReadTokens: 80 },
    hasUsageObservations: true,
    latestAssistantUsage: { totalTokens: 100, outputTokens: 0, cacheReadTokens: 80 },
  })), /cache 80\.0%/u);
  assert.match(renderCache(() => ({
    usage: { totalTokens: 100, outputTokens: 0, cacheReadTokens: 0 },
    hasUsageObservations: true,
    latestAssistantUsage: { totalTokens: 100, outputTokens: 0, cacheReadTokens: 0 },
  })), /cache 0\.0%/u);
  assert.match(renderCache(() => ({
    usage: {},
    hasUsageObservations: true,
    latestAssistantUsage: { totalTokens: 100, outputTokens: 0 },
  })), /last cache n\/a/u);
  assert.match(renderCache(undefined), /last cache n\/a/u);
  assert.doesNotMatch(renderCache(() => ({ usage: {}, hasUsageObservations: false })), /cache/u);
  assert.doesNotMatch(renderCache(undefined, false), /cache/u);
});

test("public footer presents reported token totals plainly and hides compaction policy", () => {
  const footer = new FooterComponent({
    sessionManager: {
      getCwd: () => "/workspace",
      getActiveBranchUsage: () => ({
        usage: {},
        reportedUsage: { inputTokens: 1_250, outputTokens: 400 },
        hasUsageObservations: true,
        latestAssistantUsage: { totalTokens: 100, outputTokens: 0, cacheReadTokens: 0 },
      }),
    },
    getSessionStats: () => ({
      tokens: { inputReported: 1_250, outputReported: 400 },
      contextUsage: {
        tokens: 8_000,
        contextWindow: 16_000,
        percent: 50,
        source: "estimated",
        autoCompactionThresholdPercent: 85,
      },
    }),
  }, { getGitBranch: () => null });

  assert.match(text(footer), /in 1\.3k · out 400 · last cache 0\.0%/u);
  assert.match(text(footer), /ctx 50\.0%\/16k/u);
  assert.doesNotMatch(text(footer), /ctx .*~/u);
  assert.doesNotMatch(text(footer), /auto(?:@85%)?|[≥>]=?/u);
});

test("public footer preserves explicit zero input and output counters", () => {
  const footer = new FooterComponent({
    sessionManager: {
      getCwd: () => "/workspace",
      getActiveBranchUsage: () => ({
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        hasUsageObservations: true,
      }),
    },
  }, { getGitBranch: () => null });

  assert.match(text(footer), /in 0 · out 0 · last cache n\/a/u);
});

test("public footer keeps input, output, cost, and cache on the active branch scope", () => {
  const footer = new FooterComponent({
    sessionManager: {
      getCwd: () => "/workspace",
      getActiveBranchUsage: () => ({
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 50,
          cacheWriteTokens: 0,
          totalTokens: 160,
          cost: { input: 0.1, output: 0.1, cacheRead: 0.05, cacheWrite: 0, total: 0.25 },
        },
        hasUsageObservations: true,
        latestAssistantUsage: { totalTokens: 160, outputTokens: 10, cacheReadTokens: 50 },
      }),
    },
    getSessionStats: () => ({
      usage: {
        inputTokens: 1_000,
        outputTokens: 100,
        cacheReadTokens: 500,
        cacheWriteTokens: 0,
        totalTokens: 1_600,
      },
      cost: 9,
    }),
  }, { getGitBranch: () => null });

  assert.match(text(footer), /in 150 · out 10 · last cache 33\.3% · \$0\.250/u);
  assert.doesNotMatch(text(footer), /1\.5k|out 100|\$9\.000/u);
});

test("public footer clamps corrupted context percentages", () => {
  const footer = new FooterComponent({
    getSessionStats: () => ({
      contextUsage: { tokens: 200_000, contextWindow: 10_000, percent: 2_000 },
    }),
  }, { getGitBranch: () => null });

  assert.match(text(footer), /ctx 999\.0%\/10k/u);
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

test("login dialog cancellation completes only once", () => {
  let completions = 0;
  const dialog = new LoginDialogComponent(fakeTui(), "provider", () => { completions += 1; });
  dialog.handleInput("\u001b");
  dialog.handleInput("\u001b");
  assert.equal(completions, 1);
  assert.equal(dialog.signal.aborted, true);
});

test("login dialog replaces an active prompt without duplicating or stranding its input", async () => {
  const dialog = new LoginDialogComponent(fakeTui(), "provider", () => {});
  const first = dialog.showPrompt("First");
  const second = dialog.showPrompt("Second");
  await assert.rejects(first, /replaced/u);
  assert.equal(countComponents(dialog, (component) => component instanceof Input), 1);
  dialog.handleInput("answer");
  dialog.handleInput("\n");
  assert.equal(await second, "answer");

  const pending = dialog.showPrompt("Third");
  dialog.showDetails(["Waiting in browser"]);
  await assert.rejects(pending, /replaced/u);
  assert.equal(countComponents(dialog, (component) => component instanceof Input), 0);
  dialog.handleInput("invisible");
  dialog.handleInput("\n");
  assert.match(text(dialog), /Waiting in browser/u);
});

test("public summary cards hide private summary text until expanded", () => {
  for (const [component, label] of [
    [new BranchSummaryMessageComponent({ summary: "private branch details" }), "Branch summary"],
    [new CompactionSummaryMessageComponent({ summary: "private compacted details" }), "Context compacted"],
    [new SkillInvocationMessageComponent({ skillName: "review", summary: "private skill details" }), "Skill: review"],
  ] as const) {
    for (const width of [12, 42]) {
      const lines = component.render(width);
      assert.ok(lines.every((line) => line.includes(currentTheme().getBgAnsi("customMessageBg"))));
      assert.ok(lines.every((line) => visibleWidth(line) === width));
    }
    assert.match(text(component), new RegExp(label, "u"));
    assert.doesNotMatch(text(component), /private/u);
    assert.match(text(component), /Ctrl\+O to expand/u);
    component.setExpanded(true);
    assert.match(text(component), /private/u);
  }
});

test("compaction and custom cards retain bounded provenance and full-width surfaces", () => {
  const compaction = new CompactionSummaryMessageComponent({ summary: "details", tokensBefore: 12_345 });
  assert.match(text(compaction), /12,345 tokens before/u);

  const custom = new CustomMessageComponent({
    role: "custom",
    customType: "status\nunsafe",
    content: "payload",
    display: true,
    timestamp: Date.now(),
  });
  for (const width of [12, 42]) {
    const lines = custom.render(width);
    assert.equal(lines[0], "");
    assert.ok(lines.slice(1).every((line) => line.includes(currentTheme().getBgAnsi("customMessageBg"))));
    assert.ok(lines.slice(1).every((line) => visibleWidth(line) === width));
  }
  assert.match(text(custom), /\[status unsafe\][\s\S]*payload/u);
});

test("extension input, editor, and selector honor public options and focus", () => {
  let inputValue: string | undefined;
  const input = new ExtensionInputComponent("Input", "placeholder", (value) => { inputValue = value; }, () => {}, { tui: fakeTui() });
  input.focused = true;
  assert.match(text(input), /\(placeholder\)/u);
  assert.match(text(input), /Enter submit.*Escape cancel/u);
  input.handleInput("value");
  input.handleInput("\n");
  assert.equal(inputValue, "value");

  let editorValue: string | undefined;
  const editor = new ExtensionEditorComponent(fakeTui(), { matches: () => false } as unknown as KeybindingsManager, "Editor", "draft", (value) => { editorValue = value; }, () => {}, { paddingX: 2 }, "false");
  editor.focused = true;
  editor.handleInput("\r");
  assert.equal(editorValue, "draft");

  let selected: string | undefined;
  let toggles = 0;
  const selector = new ExtensionSelectorComponent("Choose", ["one", "two"], (value) => { selected = value; }, () => {}, { onToggleToolsExpanded: () => { toggles += 1; } });
  assert.match(text(selector), /Choose[\s\S]*navigate.*Enter select.*Escape cancel/u);
  selector.handleInput("k");
  selector.handleInput("\u000f");
  selector.handleInput("\n");
  assert.equal(selected, "one");
  assert.equal(toggles, 1);

  let finalSelection: string | undefined;
  const lowerBound = new ExtensionSelectorComponent("Choose", ["one", "two"], (value) => { finalSelection = value; }, () => {});
  lowerBound.handleInput("j");
  lowerBound.handleInput("j");
  lowerBound.handleInput("\n");
  assert.equal(finalSelection, "two");
});

test("extension selector clamps the active host navigation bindings", () => {
  const previous = getKeybindings();
  try {
    setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.up": "p",
      "tui.select.down": "n",
    }));

    let unchanged: string | undefined;
    const defaultArrow = new ExtensionSelectorComponent(
      "Choose",
      ["one", "two"],
      (value) => { unchanged = value; },
      () => {},
    );
    defaultArrow.handleInput("\u001b[B");
    defaultArrow.handleInput("\n");
    assert.equal(unchanged, "one");

    let selected: string | undefined;
    const remapped = new ExtensionSelectorComponent(
      "Choose",
      ["one", "two"],
      (value) => { selected = value; },
      () => {},
    );
    assert.match(text(remapped), /P\/N\/J\/K navigate/u);
    remapped.handleInput("n");
    remapped.handleInput("n");
    remapped.handleInput("k");
    remapped.handleInput("p");
    remapped.handleInput("\n");
    assert.equal(selected, "one");
  } finally {
    setKeybindings(previous);
  }
});

test("public modal components complete at most once", async () => {
  let inputSubmits = 0;
  let inputCancels = 0;
  const input = new ExtensionInputComponent("Input", undefined, () => { inputSubmits += 1; }, () => { inputCancels += 1; });
  input.handleInput("\n");
  input.handleInput("\n");
  input.handleInput("\u001b");
  assert.deepEqual([inputSubmits, inputCancels], [1, 0]);

  let editorSubmits = 0;
  const editor = new ExtensionEditorComponent(fakeTui(), { matches: () => false } as unknown as KeybindingsManager, "Editor", "draft", () => { editorSubmits += 1; }, () => {});
  editor.handleInput("\r");
  editor.handleInput("\r");
  assert.equal(editorSubmits, 1);

  let selectorSubmits = 0;
  const selector = new ExtensionSelectorComponent("Choose", ["one"], () => { selectorSubmits += 1; }, () => {});
  selector.handleInput("\n");
  selector.handleInput("\n");
  assert.equal(selectorSubmits, 1);

  let themeSubmits = 0;
  const theme = new ThemeSelectorComponent("mono", () => { themeSubmits += 1; }, () => {}, () => {}, ["mono"]);
  theme.handleInput("\n");
  theme.handleInput("\n");
  assert.equal(themeSubmits, 1);

  let oauthSubmits = 0;
  const oauth = new OAuthSelectorComponent("login", [{ id: "one", name: "One", authType: "oauth" }], () => { oauthSubmits += 1; }, () => {});
  oauth.handleInput("\n");
  oauth.handleInput("\n");
  assert.equal(oauthSubmits, 1);

  const available = [model("provider", "model")];
  let modelSubmits = 0;
  const modelSelector = new ModelSelectorComponent(fakeTui(), undefined, {}, {
    getAvailableSnapshot: () => available,
    getModel: () => available[0],
    async refresh() { return { aborted: false, errors: new Map() }; },
  }, [], () => { modelSubmits += 1; }, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  modelSelector.handleInput("\n");
  modelSelector.handleInput("\n");
  assert.equal(modelSubmits, 1);
});

test("disposing an active extension editor does not restart its stopped TUI", async () => {
  let stops = 0;
  let starts = 0;
  let renders = 0;
  const tui = {
    terminal: { rows: 24, columns: 100 },
    stop() { stops += 1; },
    start() { starts += 1; },
    requestRender() { renders += 1; },
  } as unknown as TUI;
  const keybindings = {
    matches: (_data: string, action: string) => action === "app.editor.external",
  } as unknown as KeybindingsManager;
  const editor = new ExtensionEditorComponent(
    tui,
    keybindings,
    "Editor",
    "draft",
    () => {},
    () => {},
    undefined,
    `"${process.execPath}" -e "process.exit(0)"`,
  );
  const rendersBeforeOpen = renders;

  editor.handleInput("open");
  assert.equal(stops, 1);
  editor.dispose();
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  assert.equal(starts, 0);
  assert.equal(renders, rendersBeforeOpen);
});

test("bash and tool result expansion changes rendered output", () => {
  const output = Array.from({ length: 30 }, (_, index) => `line-${index}`).join("\n");
  const bash = new BashExecutionComponent("run", fakeTui());
  bash.appendOutput(output);
  bash.setComplete(0, false);
  const bashLines = bash.render(42);
  assert.equal(bashLines[0], "");
  assert.ok(bashLines.slice(1).every((line) => line.includes(currentTheme().getBgAnsi("toolSuccessBg"))));
  assert.ok(bashLines.slice(1).every((line) => visibleWidth(line) === 42));
  assert.doesNotMatch(text(bash), /line-0/u);
  bash.setExpanded(true);
  assert.match(text(bash), /line-0/u);

  const tool = new ToolExecutionComponent("inspect", "call", {}, { showImages: false }, undefined, fakeTui(), "/tmp");
  tool.updateResult({ content: [{ type: "text", text: output }], isError: false });
  assert.doesNotMatch(text(tool), /line-0/u);
  tool.setExpanded(true);
  assert.match(text(tool), /line-0/u);

  const arbitrary = new ToolExecutionComponent(
    "custom",
    "call-arbitrary",
    { foo: "bar", nested: { count: 2 } },
    {},
    undefined,
    fakeTui(),
    "/tmp",
  );
  assert.match(text(arbitrary), /custom \{"foo":"bar","nested":\{"count":2\}\}/u);
  assert.doesNotMatch(text(arbitrary), /\(no arguments\)/u);

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

  const callHistory: Array<Component | undefined> = [];
  const resultHistory: Array<Component | undefined> = [];
  const continuity = new ToolExecutionComponent("continuity", "call-continuity", { value: 1 }, {}, {
    renderCall(_args: unknown, _theme: unknown, context: ToolRenderContext) {
      callHistory.push(context.lastComponent);
      return new Text(`call-${callHistory.length}`, 0, 0);
    },
    renderResult(_result: unknown, _options: ToolRenderResultOptions, _theme: unknown, context: ToolRenderContext) {
      resultHistory.push(context.lastComponent);
      return new Text(`result-${resultHistory.length}`, 0, 0);
    },
  } as unknown as ToolDefinition, fakeTui(), "/tmp");
  continuity.updateArgs({ value: 2 });
  continuity.updateResult({ content: [{ type: "text", text: "one" }], isError: false }, true);
  continuity.updateResult({ content: [{ type: "text", text: "two" }], isError: false }, false);
  assert.equal(callHistory[0], undefined);
  assert.ok(callHistory[1] instanceof Text);
  assert.equal(resultHistory[0], undefined);
  assert.ok(resultHistory[1] instanceof Text);

  const renderer = (renderShell: "default" | "self") => ({
    renderShell,
    renderCall() { return new Text("custom call", 0, 0); },
    renderResult() { return new Text("custom result", 0, 0); },
  }) as unknown as ToolDefinition;
  const defaultShell = new ToolExecutionComponent(
    "custom",
    "call-default-shell",
    {},
    {},
    renderer("default"),
    fakeTui(),
    "/tmp",
  );
  defaultShell.updateResult({ content: [{ type: "text", text: "fallback" }], isError: false });
  const defaultLines = defaultShell.render(24);
  assert.equal(defaultLines[0], "");
  assert.ok(defaultLines.slice(1).every((line) => line.includes(currentTheme().getBgAnsi("toolSuccessBg"))));
  assert.ok(defaultLines.slice(1).every((line) => visibleWidth(line) === 24));
  assert.match(text(defaultShell, 24), /custom call[\s\S]*custom result/u);

  const implicitShell = new ToolExecutionComponent(
    "custom",
    "call-implicit-shell",
    {},
    {},
    {
      renderCall() { return new Text("implicit call", 0, 0); },
    } as unknown as ToolDefinition,
    fakeTui(),
    "/tmp",
  );
  const implicitLines = implicitShell.render(24);
  assert.equal(implicitLines[0], "");
  assert.ok(implicitLines.slice(1).every((line) => line.includes(currentTheme().getBgAnsi("toolPendingBg"))));

  const selfShell = new ToolExecutionComponent(
    "custom",
    "call-self-shell",
    {},
    {},
    renderer("self"),
    fakeTui(),
    "/tmp",
  );
  selfShell.updateResult({ content: [{ type: "text", text: "fallback" }], isError: false });
  const selfLines = text(selfShell, 24).split("\n");
  assert.equal(selfLines.some((line) => line === "─".repeat(24)), false);
  assert.match(selfLines.join("\n"), /custom call[\s\S]*custom result/u);

  const image = new ToolExecutionComponent("read", "call-image", { path: "/tmp/image.png" }, {}, undefined, fakeTui(), "/tmp");
  image.updateResult({
    content: [{
      type: "image",
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    }],
    isError: false,
  });
  assert.match(text(image), /read \/tmp\/image\.png/u);
  assert.match(text(image), /Image:.*image\/png/u);
  assert.doesNotMatch(text(image), /\[image image\/png/u);
});

test("direct tool renderer images stay outside host-colored cards", () => {
  const previous = getCapabilities();
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  try {
    const tool = new ToolExecutionComponent("preview", "call-direct-image", {}, {}, {
      renderCall() { return new Text("custom call", 0, 0); },
      renderResult() {
        return new Image(data, "image/png", { fallbackColor: (value) => value }, { maxWidthCells: 10 });
      },
    } as unknown as ToolDefinition, fakeTui(), "/tmp");
    tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false });

    const lines = tool.render(42);
    const imageIndex = lines.findIndex(isImageLine);
    assert.ok(imageIndex > 0);
    assert.ok(lines.slice(1, imageIndex).some((line) => visibleWidth(line) === 42));
    assert.equal(visibleWidth(lines[imageIndex]!), 0);
    assert.doesNotThrow(() => renderViewport(tool, 42, 30));
  } finally {
    setCapabilities(previous);
  }
});

test("bash preview keeps bounded tail output across noisy chunk streams", () => {
  const bash = new BashExecutionComponent("noisy", fakeTui());
  for (let index = 0; index < 200; index += 1) bash.appendOutput(`${index}:${"x".repeat(1024)}\r`);
  assert.ok(Buffer.byteLength(bash.getOutput()) <= BashExecutionComponent.MAX_RETAINED_OUTPUT_BYTES);
  assert.match(bash.getOutput(), /199:/u);
  assert.match(text(bash), /earlier output bytes omitted/u);
  bash.dispose();
});

test("message presentation setters rebuild rendered content", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "redacted-private", redacted: true },
      { type: "thinking", thinking: "private" },
      { type: "text", text: "answer" },
    ],
    stopReason: "stop",
  };
  const assistant = new AssistantMessageComponent(message as unknown as import("@rigyn/models").AssistantMessage, false, undefined, "Working", 1);
  assert.doesNotMatch(text(assistant), /redacted-private/u);
  assert.doesNotMatch(text(assistant), /private/u);
  assert.match(text(assistant), /Thought/u);
  assistant.setHideThinkingBlock(true);
  assistant.setHiddenThinkingLabel("Hidden");
  assert.doesNotMatch(text(assistant), /private/u);
  assert.match(text(assistant), /Hidden/u);
  assistant.setOutputPad(0);
  assert.ok(text(assistant, 50).split("\n").some((line) => line.startsWith("answer")));

  const user = new UserMessageComponent("hello", undefined, 1);
  assert.ok(text(user, 50).split("\n").some((line) => line.startsWith(" hello")));
  user.setOutputPad(0);
  assert.ok(text(user, 50).split("\n").some((line) => line.startsWith("hello")));

  const custom = new CustomMessageComponent({
    role: "custom",
    customType: "status",
    content: "payload",
    display: true,
    timestamp: Date.now(),
  }, (_value, options) => new Text(`${options.expanded ? "expanded" : "collapsed"}:${options.outputPad}`, 0, 0), undefined, 0);
  assert.match(text(custom), /collapsed:0/u);
  custom.setExpanded(true);
  custom.setOutputPad(1);
  assert.match(text(custom), /expanded:1/u);
});

test("public message components preserve shipping card geometry and width-aware transforms", () => {
  const transformContexts: Array<{ messageType: string; isStreaming: boolean; availableWidth: number }> = [];
  const transform = (markdown: string, context: { messageType: "user" | "assistant" | "assistant-thinking"; isStreaming: boolean; availableWidth: number }): string => {
    transformContexts.push(context);
    return markdown.replace("source", "transformed");
  };
  const user = new UserMessageComponent("source user", undefined, 1, [transform]);
  const background = currentTheme().getBgAnsi("userMessageBg");
  for (const width of [42, 12]) {
    const lines = user.render(width);
    assert.ok(lines.length >= 3);
    assert.ok(lines.every((line) => line.includes(background)));
    assert.ok(lines.every((line) => visibleWidth(line) === width));
    assert.match(text(user, width).replace(/\s+/gu, ""), /transformeduser/u);
  }
  assert.ok(transformContexts.some((context) =>
    context.messageType === "user" && context.isStreaming === false && context.availableWidth === 40));

  transformContexts.length = 0;
  const assistant = new AssistantMessageComponent(undefined, false, undefined, "Thinking...", 1, [transform]);
  assistant.updateContent({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "source reasoning" },
      { type: "text", text: "source answer" },
    ],
    stopReason: "stop",
  } as unknown as import("@rigyn/models").AssistantMessage, true);
  const assistantText = text(assistant, 42);
  assert.ok(assistantText.startsWith("\n"));
  assert.match(assistantText, /Thinking…/u);
  assert.match(assistantText, /│ transformed reasoning\s+│/u);
  assert.match(assistantText, /transformed answer/u);
  assert.ok(transformContexts.some((context) =>
    context.messageType === "assistant-thinking" && context.isStreaming && context.availableWidth === 36));
  assert.ok(transformContexts.some((context) =>
    context.messageType === "assistant" && context.isStreaming && context.availableWidth === 40));
});

test("redacted-only reasoning stays absent from public assistant components", () => {
  const assistant = new AssistantMessageComponent({
    role: "assistant",
    content: [{ type: "thinking", thinking: "never-render-this", redacted: true }],
    stopReason: "stop",
  } as unknown as import("@rigyn/models").AssistantMessage, true, undefined, "Thinking...", 1);

  assert.doesNotMatch(text(assistant), /never-render-this|Thinking\.\.\./u);
});
