import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  InMemorySettingsStorage,
  SETTINGS_KEYS,
  SettingsManager,
  type SettingsScope,
  type SettingsStorage,
} from "../../src/core/settings-manager.js";

const execFileAsync = promisify(execFile);

test("the installed template contains every supported top-level setting", async () => {
  const template = JSON.parse(await readFile(new URL("../../resources/settings.example.json", import.meta.url), "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(template), SETTINGS_KEYS);
  const keys = (name: string): string[] => Object.keys(template[name] as Record<string, unknown>);
  assert.deepEqual(keys("compaction"), ["enabled", "reserveTokens", "keepRecentTokens"]);
  assert.deepEqual(keys("branchSummary"), ["reserveTokens", "skipPrompt"]);
  assert.deepEqual(keys("retry"), ["enabled", "maxRetries", "baseDelayMs", "provider"]);
  assert.deepEqual(Object.keys((template.retry as { provider: Record<string, unknown> }).provider), [
    "timeoutMs", "maxRetries", "maxRetryDelayMs",
  ]);
  assert.deepEqual(keys("tools"), ["enabled", "excluded"]);
  assert.deepEqual(keys("terminal"), ["showImages", "imageWidthCells", "clearOnShrink", "showTerminalProgress"]);
  assert.deepEqual(keys("images"), ["autoResize", "blockImages"]);
  assert.deepEqual(keys("thinkingBudgets"), ["minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(keys("markdown"), ["codeBlockIndent"]);
  assert.deepEqual(keys("warnings"), ["anthropicExtraUsage"]);
});

test("direct settings expose runtime defaults without creating files", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-settings-defaults-"));
  const agentDirectory = join(root, "agent");
  const manager = SettingsManager.create(join(root, "project"), agentDirectory);
  assert.equal(manager.getTransport(), "auto");
  assert.equal(manager.getSteeringMode(), "one-at-a-time");
  assert.equal(manager.getFollowUpMode(), "one-at-a-time");
  assert.deepEqual(manager.getCompactionSettings(), {
    enabled: true,
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
  });
  assert.equal(manager.getShowImages(), true);
  assert.equal(manager.getImageAutoResize(), true);
  assert.equal(manager.getEnableSkillCommands(), true);
  await assert.rejects(access(agentDirectory));
});

test("null settings resolve to defaults without reaching runtime getters", () => {
  const manager = SettingsManager.inMemory({
    defaultModel: null,
    transport: null,
    packages: null,
    terminal: { showImages: null, imageWidthCells: null },
    retry: { enabled: null, provider: { maxRetryDelayMs: null } },
    warnings: { anthropicExtraUsage: null },
  });

  assert.equal(manager.getDefaultModel(), undefined);
  assert.equal(manager.getTransport(), "auto");
  assert.deepEqual(manager.getPackages(), []);
  assert.equal(manager.getShowImages(), true);
  assert.equal(manager.getImageWidthCells(), 60);
  assert.equal(manager.getRetryEnabled(), true);
  assert.equal(manager.getProviderRetrySettings().maxRetryDelayMs, 60_000);
  assert.deepEqual(manager.getWarnings(), {});
  assert.deepEqual(manager.getGlobalSettings(), {
    terminal: {},
    retry: { provider: {} },
    warnings: {},
  });
});

test("null inheritance does not silently remove invalid replacement-array entries", () => {
  const manager = SettingsManager.inMemory({
    tools: { enabled: ["read", null, "bash"] },
  } as never);

  assert.throws(() => manager.getToolSettings(), /tools\.enabled must be an array of non-empty tool names/u);
});

test("nested project nulls inherit recursively from global settings", () => {
  const storage = new InMemorySettingsStorage();
  storage.withLock("global", () => JSON.stringify({
    terminal: { showImages: false, imageWidthCells: 44 },
    retry: { enabled: false, provider: { timeoutMs: 12_000, maxRetries: 7 } },
  }));
  storage.withLock("project", () => JSON.stringify({
    terminal: { showImages: null },
    retry: { provider: { timeoutMs: null } },
  }));

  const manager = SettingsManager.fromStorage(storage);
  assert.equal(manager.getShowImages(), false);
  assert.equal(manager.getImageWidthCells(), 44);
  assert.equal(manager.getRetryEnabled(), false);
  assert.deepEqual(manager.getProviderRetrySettings(), {
    timeoutMs: 12_000,
    maxRetries: 7,
    maxRetryDelayMs: 60_000,
  });
  assert.deepEqual(manager.getProjectSettings(), {
    terminal: {},
    retry: { provider: {} },
  });
});

test("writes and reload preserve untouched null placeholders and unknown fields", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-settings-null-preservation-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const agentDirectory = join(root, "agent");
  const path = join(agentDirectory, "settings.json");
  await mkdir(agentDirectory, { recursive: true });
  const unknown = {
    empty: null,
    nested: { value: null, bytes: "keep \\u0000 exactly" },
    list: [null, { child: null }, "unchanged"],
  };
  await writeFile(path, JSON.stringify({
    theme: null,
    terminal: { showImages: null, imageWidthCells: null, extensionOption: null },
    retry: { enabled: null, provider: { timeoutMs: null, extensionOption: null } },
    extensionSettings: unknown,
  }));

  const manager = SettingsManager.create(join(root, "project"), agentDirectory);
  manager.updateGlobalSettings({ terminal: { showImages: false }, quietStartup: true });
  await manager.flush();
  await manager.reload();
  manager.setTheme("mono");
  await manager.flush();

  assert.equal(manager.getShowImages(), false);
  assert.equal(manager.getImageWidthCells(), 60);
  assert.equal(manager.getRetryEnabled(), true);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    theme: "mono",
    terminal: { showImages: false, imageWidthCells: null, extensionOption: null },
    retry: { enabled: null, provider: { timeoutMs: null, extensionOption: null } },
    extensionSettings: unknown,
    quietStartup: true,
  });
});

test("global and project settings merge nested values and preserve external edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-settings-scopes-"));
  const cwd = join(root, "project");
  const agentDirectory = join(root, "agent");
  await mkdir(join(cwd, ".rigyn"), { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(join(agentDirectory, "settings.json"), JSON.stringify({
    defaultProvider: "openai",
    terminal: { showImages: false, imageWidthCells: 40 },
  }));
  await writeFile(join(cwd, ".rigyn", "settings.json"), JSON.stringify({
    defaultModel: "project-model",
    terminal: { imageWidthCells: 72 },
  }));

  const manager = SettingsManager.create(cwd, agentDirectory);
  assert.equal(manager.getDefaultProvider(), "openai");
  assert.equal(manager.getDefaultModel(), "project-model");
  assert.equal(manager.getShowImages(), false);
  assert.equal(manager.getImageWidthCells(), 72);

  await writeFile(join(agentDirectory, "settings.json"), JSON.stringify({
    defaultProvider: "openai",
    externallyAdded: true,
    terminal: { showImages: false, imageWidthCells: 40 },
  }));
  manager.setQuietStartup(true);
  await manager.flush();
  const stored = JSON.parse(await readFile(join(agentDirectory, "settings.json"), "utf8")) as Record<string, unknown>;
  assert.equal(stored.externallyAdded, true);
  assert.equal(stored.quietStartup, true);
});

test("settings writes serialize and keep independently modified nested fields", async () => {
  const storage = new InMemorySettingsStorage();
  const first = SettingsManager.fromStorage(storage);
  const second = SettingsManager.fromStorage(storage);
  first.setShowImages(false);
  second.setImageWidthCells(88);
  await Promise.all([first.flush(), second.flush()]);
  const loaded = SettingsManager.fromStorage(storage);
  assert.equal(loaded.getShowImages(), false);
  assert.equal(loaded.getImageWidthCells(), 88);
});

test("model scope order survives persistence and a fresh Node process", { timeout: 15_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-settings-model-scope-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDirectory = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  const manager = SettingsManager.create(cwd, agentDirectory);
  manager.setEnabledModels(["scope/alpha", "scope/beta", "scope/gamma"]);
  await manager.flush();
  manager.setEnabledModels(["scope/beta", "scope/alpha", "scope/gamma"]);
  await manager.flush();

  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  const program = `
    import { writeSync } from "node:fs";
    import { SettingsManager } from "./src/core/settings-manager.ts";
    import { resolveModelsForScope } from "./src/providers/model-scope.ts";
    const settings = SettingsManager.create(process.env.RIGYN_TEST_WORKSPACE, process.env.RIGYN_TEST_AGENT_DIR);
    const patterns = settings.getEnabledModels();
    const catalog = ["gamma", "alpha", "beta"].map((model) => ({ provider: "scope", model }));
    const resolved = resolveModelsForScope(catalog, patterns ?? []).models;
    writeSync(1, JSON.stringify({ patterns, resolved: resolved.map((entry) => entry.model) }));
  `;
  const { stdout } = await execFileAsync(process.execPath, [
    "--import", "tsx",
    "--input-type=module",
    "--eval", program,
  ], {
    cwd: packageRoot,
    env: {
      ...process.env,
      RIGYN_TEST_WORKSPACE: cwd,
      RIGYN_TEST_AGENT_DIR: agentDirectory,
    },
    timeout: 10_000,
  });
  assert.deepEqual(JSON.parse(stdout), {
    patterns: ["scope/beta", "scope/alpha", "scope/gamma"],
    resolved: ["beta", "alpha", "gamma"],
  });
});

test("legacy settings migrate in memory while malformed files remain untouched", async () => {
  const migrated = SettingsManager.inMemory({
    queueMode: "all",
    websockets: true,
    skills: { enableSkillCommands: false, customDirectories: ["~/skills"] },
    retry: { maxDelayMs: 1234 },
  } as never);
  assert.equal(migrated.getSteeringMode(), "all");
  assert.equal(migrated.getTransport(), "websocket");
  assert.equal(migrated.getEnableSkillCommands(), false);
  assert.deepEqual(migrated.getSkillPaths(), ["~/skills"]);
  assert.equal(migrated.getProviderRetrySettings().maxRetryDelayMs, 1234);

  const root = await mkdtemp(join(tmpdir(), "rigyn-settings-malformed-"));
  const agentDirectory = join(root, "agent");
  await mkdir(agentDirectory);
  const path = join(agentDirectory, "settings.json");
  await writeFile(path, "{broken");
  const invalid = SettingsManager.create(join(root, "project"), agentDirectory);
  invalid.setTheme("dark");
  await invalid.flush();
  assert.equal(await readFile(path, "utf8"), "{broken");
  assert.equal(invalid.drainErrors().length > 0, true);
});

test("file settings secure existing permissions and reject symbolic-link storage", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-settings-file-safety-"));
  const agentDirectory = join(root, "agent");
  const path = join(agentDirectory, "settings.json");
  await mkdir(agentDirectory);
  await writeFile(path, '{"theme":"first"}\n', { mode: 0o644 });

  const manager = SettingsManager.create(join(root, "project"), agentDirectory);
  manager.setTheme("mono");
  await manager.flush();
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);

  if (process.platform !== "win32") {
    const target = join(root, "auth-sentinel.json");
    await writeFile(target, '{"token":"secret"}\n', { mode: 0o600 });
    await rm(path);
    await symlink(target, path);
    const linked = SettingsManager.create(join(root, "project"), agentDirectory);
    assert.equal(linked.drainErrors().some((entry) => /symbolic link/u.test(entry.error.message)), true);
    linked.setTheme("mono");
    await linked.flush();
    assert.equal(await readFile(target, "utf8"), '{"token":"secret"}\n');
  }
  context.after(async () => await rm(root, { recursive: true, force: true }));
});

test("file settings reject a symbolic-link project settings directory", async (context) => {
  if (process.platform === "win32") {
    context.skip("directory symlink creation is not guaranteed on Windows runners");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "rigyn-settings-directory-symlink-"));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(join(outside, "settings.json"), '{"token":"secret"}\n', { mode: 0o600 });
  await symlink(outside, join(workspace, ".rigyn"));

  const manager = SettingsManager.create(workspace, agentDirectory);
  assert.equal(manager.drainErrors().some((entry) => /Settings directory.*symbolic link/u.test(entry.error.message)), true);
  manager.updateProjectSettings({ theme: "mono" });
  await manager.flush();
  assert.equal(await readFile(join(outside, "settings.json"), "utf8"), '{"token":"secret"}\n');
  context.after(async () => await rm(root, { recursive: true, force: true }));
});

test("untrusted projects are ignored and cannot be written", async () => {
  const storage = new InMemorySettingsStorage();
  storage.withLock("global", () => JSON.stringify({ defaultModel: "global" }));
  storage.withLock("project", () => JSON.stringify({ defaultModel: "project" }));
  const manager = SettingsManager.fromStorage(storage, { projectTrusted: false });
  assert.equal(manager.getDefaultModel(), "global");
  assert.throws(() => manager.setProjectPackages(["npm:example"]), /not trusted/iu);
  manager.setProjectTrusted(true);
  assert.equal(manager.getDefaultModel(), "project");
});

test("reload keeps the last valid scope when its file becomes malformed", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-settings-reload-invalid-"));
  const cwd = join(root, "project");
  const agentDirectory = join(root, "agent");
  await mkdir(agentDirectory, { recursive: true });
  const path = join(agentDirectory, "settings.json");
  await writeFile(path, JSON.stringify({ theme: "dark", enabledModels: ["one"] }));

  const manager = SettingsManager.create(cwd, agentDirectory);
  await writeFile(path, "{not-json");
  await manager.reload();

  assert.equal(manager.getTheme(), "dark");
  assert.deepEqual(manager.getEnabledModels(), ["one"]);
  assert.equal(manager.drainErrors().some((entry) => entry.scope === "global"), true);
});

test("reload validation rejects a candidate without changing the active settings", async () => {
  const storage = new InMemorySettingsStorage();
  storage.withLock("global", () => JSON.stringify({ theme: "mono" }));
  const manager = SettingsManager.fromStorage(storage);
  storage.withLock("global", () => JSON.stringify({ theme: "candidate" }));

  await assert.rejects(
    manager.reload({ validate: () => { throw new Error("candidate rejected"); } }),
    /candidate rejected/u,
  );

  assert.equal(manager.getThemeSetting(), "mono");
});

test("reload rejects a stale candidate when settings change during async validation", async () => {
  const storage = new InMemorySettingsStorage();
  storage.withLock("global", () => JSON.stringify({ theme: "mono" }));
  const manager = SettingsManager.fromStorage(storage);
  storage.withLock("global", () => JSON.stringify({ theme: "candidate" }));

  await assert.rejects(manager.reload({
    async validate() {
      manager.setTheme("concurrent");
      await manager.flush();
    },
  }), /changed while reload validation was in progress/u);

  assert.equal(manager.getThemeSetting(), "concurrent");
  let stored: Record<string, unknown> = {};
  storage.withLock("global", (contents) => {
    stored = JSON.parse(contents ?? "{}") as Record<string, unknown>;
    return undefined;
  });
  assert.equal(stored.theme, "concurrent");
});

test("overlapping reloads cannot commit an older validated candidate", async () => {
  const storage = new InMemorySettingsStorage();
  storage.withLock("global", () => JSON.stringify({ theme: "initial" }));
  const manager = SettingsManager.fromStorage(storage);
  storage.withLock("global", () => JSON.stringify({ theme: "older-candidate" }));
  let releaseValidation!: () => void;
  let validationStarted!: () => void;
  const started = new Promise<void>((resolve) => { validationStarted = resolve; });
  const validation = new Promise<void>((resolve) => { releaseValidation = resolve; });
  const olderReload = manager.reload({
    async validate() {
      validationStarted();
      await validation;
    },
  });
  await started;
  storage.withLock("global", () => JSON.stringify({ theme: "newer-candidate" }));
  await manager.reload();
  releaseValidation();

  await assert.rejects(olderReload, /changed while reload validation was in progress/u);
  assert.equal(manager.getThemeSetting(), "newer-candidate");
});

test("tool settings reject non-object policies instead of enabling every tool", () => {
  for (const tools of ["none", 42, false, []]) {
    assert.throws(
      () => SettingsManager.inMemory({ tools } as never).getToolSettings(),
      /tools must be an object or null/u,
    );
  }
});

test("retry settings reject malformed values before request execution", () => {
  const invalid = [
    { retry: "enabled" },
    { retry: { enabled: "true" } },
    { retry: { maxRetries: "2" } },
    { retry: { maxRetries: -1 } },
    { retry: { maxRetries: 1.5 } },
    { retry: { baseDelayMs: "100" } },
    { retry: { provider: "default" } },
    { retry: { provider: { timeoutMs: "100" } } },
    { retry: { provider: { timeoutMs: 2_147_483_648 } } },
    { retry: { provider: { maxRetries: "2" } } },
    { retry: { provider: { maxRetryDelayMs: -1 } } },
  ];
  for (const settings of invalid) {
    assert.throws(
      () => SettingsManager.inMemory(settings as never).getProviderRetrySettings(),
      /retry/u,
    );
  }
  const valid = SettingsManager.inMemory({
    retry: {
      enabled: false,
      maxRetries: 0,
      baseDelayMs: 0,
      provider: { timeoutMs: 0, maxRetries: 0, maxRetryDelayMs: 0 },
    },
  });
  assert.deepEqual(valid.getRetrySettings(), { enabled: false, maxRetries: 0, baseDelayMs: 0 });
  assert.deepEqual(valid.getProviderRetrySettings(), { timeoutMs: 0, maxRetries: 0, maxRetryDelayMs: 0 });
});

test("unrelated writes retain arrays, extension paths, and nested values changed on disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-settings-external-"));
  const cwd = join(root, "project");
  const agentDirectory = join(root, "agent");
  await mkdir(agentDirectory, { recursive: true });
  const path = join(agentDirectory, "settings.json");
  await writeFile(path, JSON.stringify({
    enabledModels: ["first"],
    extensions: ["./initial.ts"],
    terminal: { showImages: true },
  }));

  const manager = SettingsManager.create(cwd, agentDirectory);
  await writeFile(path, JSON.stringify({
    enabledModels: ["external"],
    extensions: ["./external.ts"],
    terminal: { showImages: false },
    shellCommandPrefix: "set -eu",
  }));
  manager.setDefaultThinkingLevel("high");
  await manager.flush();

  const stored = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assert.deepEqual(stored.enabledModels, ["external"]);
  assert.deepEqual(stored.extensions, ["./external.ts"]);
  assert.deepEqual(stored.terminal, { showImages: false });
  assert.equal(stored.shellCommandPrefix, "set -eu");
  assert.equal(stored.defaultThinkingLevel, "high");
});

test("a local modification wins over a concurrent disk change to the same field", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-settings-same-field-"));
  const agentDirectory = join(root, "agent");
  await mkdir(agentDirectory, { recursive: true });
  const path = join(agentDirectory, "settings.json");
  await writeFile(path, JSON.stringify({ theme: "first", enabledModels: ["one"] }));
  const manager = SettingsManager.create(join(root, "project"), agentDirectory);

  await writeFile(path, JSON.stringify({ theme: "external", enabledModels: ["two"] }));
  manager.setTheme("local");
  await manager.flush();

  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    theme: "local",
    enabledModels: ["two"],
  });
});

test("project trust controls reads, writes, defaults, and directory creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-settings-trust-"));
  const cwd = join(root, "project");
  const agentDirectory = join(root, "agent");
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(join(agentDirectory, "settings.json"), JSON.stringify({
    defaultProjectTrust: "always",
    defaultModel: "global",
  }));

  const manager = SettingsManager.create(cwd, agentDirectory, { projectTrusted: false });
  assert.equal(manager.getDefaultProjectTrust(), "always");
  assert.equal(manager.getDefaultModel(), "global");
  await assert.rejects(access(join(cwd, ".rigyn")));
  assert.throws(() => manager.setProjectThemePaths(["./theme.json"]), /not trusted/iu);

  manager.setProjectTrusted(true);
  manager.setProjectThemePaths(["./theme.json"]);
  await manager.flush();
  assert.deepEqual(
    JSON.parse(await readFile(join(cwd, ".rigyn", "settings.json"), "utf8")),
    { themes: ["./theme.json"] },
  );
  assert.equal(SettingsManager.inMemory({ defaultProjectTrust: "invalid" as never }).getDefaultProjectTrust(), "ask");
});

test("timeout, editor, padding, path, and theme getters preserve their public edge semantics", async () => {
  assert.equal(SettingsManager.inMemory().getHttpIdleTimeoutMs(), 300_000);
  assert.equal(SettingsManager.inMemory({ httpIdleTimeoutMs: 0 }).getHttpIdleTimeoutMs(), 0);
  assert.throws(
    () => SettingsManager.inMemory({ httpIdleTimeoutMs: -1 }).getHttpIdleTimeoutMs(),
    /httpIdleTimeoutMs/iu,
  );
  assert.throws(
    () => SettingsManager.inMemory({ websocketConnectTimeoutMs: Number.NaN }).getWebSocketConnectTimeoutMs(),
    /websocketConnectTimeoutMs/iu,
  );

  const originalVisual = process.env.VISUAL;
  const originalEditor = process.env.EDITOR;
  try {
    process.env.VISUAL = "vim";
    process.env.EDITOR = "emacs";
    assert.equal(SettingsManager.inMemory({ externalEditor: "code --wait" }).getExternalEditorCommand(), "code --wait");
    assert.equal(SettingsManager.inMemory().getExternalEditorCommand(), "vim");
    delete process.env.VISUAL;
    assert.equal(SettingsManager.inMemory().getExternalEditorCommand(), "emacs");
  } finally {
    if (originalVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = originalVisual;
    if (originalEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = originalEditor;
  }

  assert.equal(SettingsManager.inMemory({ outputPad: 2 as never }).getOutputPad(), 1);
  assert.equal(SettingsManager.inMemory({ outputPad: 0 }).getOutputPad(), 0);
  assert.equal(SettingsManager.inMemory({ theme: "package/dark" }).getTheme(), undefined);
  assert.equal(SettingsManager.inMemory({ theme: "dark" }).getTheme(), "dark");
  assert.equal(SettingsManager.inMemory({ sessionDir: "~/sessions" }).getSessionDir(), join(homedir(), "sessions"));
  assert.equal(SettingsManager.inMemory({ shellPath: "~" }).getShellPath(), homedir());
});

test("bounded terminal preferences and project overrides follow the direct settings contract", async () => {
  const manager = SettingsManager.inMemory({
    editorPaddingX: 99,
    autocompleteMaxVisible: 1,
    terminal: { imageWidthCells: 0 },
    treeFilterMode: "invalid" as never,
  });
  assert.equal(manager.getEditorPaddingX(), 3);
  assert.equal(manager.getAutocompleteMaxVisible(), 3);
  assert.equal(manager.getImageWidthCells(), 1);
  assert.equal(manager.getTreeFilterMode(), "default");

  manager.setEditorPaddingX(-4);
  manager.setAutocompleteMaxVisible(100);
  manager.setImageWidthCells(72);
  manager.setOutputPad(0);
  await manager.flush();
  assert.equal(manager.getEditorPaddingX(), 0);
  assert.equal(manager.getAutocompleteMaxVisible(), 20);
  assert.equal(manager.getImageWidthCells(), 72);
  assert.equal(manager.getOutputPad(), 0);
});

test("settings precedence matrix keeps files sparse and invocation overrides transient", async () => {
  const storage = new InMemorySettingsStorage();
  storage.withLock("global", () => JSON.stringify({
    defaultModel: "global-model",
    steeringMode: "all",
    terminal: { showImages: false, imageWidthCells: 40 },
    retry: { enabled: false, provider: { timeoutMs: 12_000 } },
  }));
  storage.withLock("project", () => JSON.stringify({
    defaultModel: "project-model",
    terminal: { imageWidthCells: 72 },
    retry: { maxRetries: 7 },
  }));
  const manager = SettingsManager.fromStorage(storage);

  const mergedCases: Array<[string, unknown, unknown]> = [
    ["project scalar", manager.getDefaultModel(), "project-model"],
    ["global scalar", manager.getSteeringMode(), "all"],
    ["global nested key", manager.getShowImages(), false],
    ["project nested key", manager.getImageWidthCells(), 72],
    ["global retry key", manager.getRetryEnabled(), false],
    ["project retry key", manager.getRetrySettings().maxRetries, 7],
    ["global retry child", manager.getProviderRetrySettings().timeoutMs, 12_000],
  ];
  for (const [label, actual, expected] of mergedCases) assert.deepEqual(actual, expected, label);

  manager.applyOverrides({
    defaultModel: "invocation-model",
    terminal: { clearOnShrink: true },
  });
  assert.equal(manager.getDefaultModel(), "invocation-model");
  assert.equal(manager.getShowImages(), false);
  assert.equal(manager.getImageWidthCells(), 72);
  assert.equal(manager.getClearOnShrink(), true);
  assert.equal(manager.getGlobalSettings().defaultModel, "global-model");
  assert.equal(manager.getProjectSettings().defaultModel, "project-model");

  await manager.reload();
  assert.equal(manager.getDefaultModel(), "project-model");
  assert.equal(manager.getClearOnShrink(), false);
});

test("setters update memory synchronously, persist asynchronously, and surface write errors", async () => {
  class ControlledStorage implements SettingsStorage {
    values: Partial<Record<SettingsScope, string>> = {};
    writes = 0;
    failWrites = false;

    withLock(scope: SettingsScope, operation: (current: string | undefined) => string | undefined): void {
      const next = operation(this.values[scope]);
      if (next === undefined) return;
      if (this.failWrites) throw new Error("storage unavailable");
      this.values[scope] = next;
      this.writes += 1;
    }
  }

  const storage = new ControlledStorage();
  const manager = SettingsManager.fromStorage(storage);
  manager.setTheme("dark");
  assert.equal(manager.getTheme(), "dark");
  assert.equal(storage.writes, 0);
  await manager.flush();
  assert.equal(storage.writes, 1);

  storage.failWrites = true;
  manager.setDefaultModel("first-model");
  await manager.flush();
  assert.deepEqual(manager.drainErrors().map((entry) => entry.scope), ["global"]);
  assert.deepEqual(manager.drainErrors(), []);

  storage.failWrites = false;
  manager.setDefaultProvider("provider-a");
  await manager.flush();
  assert.equal(storage.writes, 2);
  const persisted = JSON.parse(storage.values.global!) as Record<string, unknown>;
  assert.equal(persisted.defaultModel, "first-model");
  assert.equal(persisted.defaultProvider, "provider-a");
});

test("timeout settings accept persisted aliases and reject malformed values", () => {
  assert.equal(SettingsManager.inMemory({ httpIdleTimeoutMs: "disabled" }).getHttpIdleTimeoutMs(), 0);
  assert.equal(SettingsManager.inMemory({ httpIdleTimeoutMs: " 1250.9 " }).getHttpIdleTimeoutMs(), 1250);
  assert.equal(SettingsManager.inMemory({ httpIdleTimeoutMs: "" }).getHttpIdleTimeoutMs(), 300_000);
  assert.equal(
    SettingsManager.inMemory({ websocketConnectTimeoutMs: "disabled" }).getWebSocketConnectTimeoutMs(),
    0,
  );
  assert.equal(
    SettingsManager.inMemory({ websocketConnectTimeoutMs: "800.8" }).getWebSocketConnectTimeoutMs(),
    800,
  );
  assert.throws(
    () => SettingsManager.inMemory({ httpIdleTimeoutMs: "later" }).getHttpIdleTimeoutMs(),
    /Invalid httpIdleTimeoutMs setting/u,
  );
});

test("migration removes obsolete shapes without overriding explicit modern settings", () => {
  const manager = SettingsManager.inMemory({
    queueMode: "all",
    steeringMode: "one-at-a-time",
    websockets: true,
    transport: "sse",
    skills: { enableSkillCommands: false, customDirectories: [] },
    retry: { maxDelayMs: 4321, provider: { maxRetryDelayMs: null } },
  } as never);

  assert.equal(manager.getSteeringMode(), "one-at-a-time");
  assert.equal(manager.getTransport(), "sse");
  assert.equal(manager.getEnableSkillCommands(), false);
  assert.deepEqual(manager.getSkillPaths(), []);
  assert.equal(manager.getProviderRetrySettings().maxRetryDelayMs, 4321);
  const global = manager.getGlobalSettings() as Record<string, unknown>;
  assert.equal("skills" in global, false);
  assert.equal("maxDelayMs" in (global.retry as Record<string, unknown>), false);
});

test("whitespace-only files are invalid, remain untouched, and can recover after reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-settings-whitespace-"));
  const agentDirectory = join(root, "agent");
  const path = join(agentDirectory, "settings.json");
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(path, "  \n\t");

  const manager = SettingsManager.create(join(root, "project"), agentDirectory);
  assert.deepEqual(manager.drainErrors().map((entry) => entry.scope), ["global"]);
  manager.setTheme("dark");
  await manager.flush();
  assert.equal(await readFile(path, "utf8"), "  \n\t");

  await writeFile(path, JSON.stringify({ externallyFixed: true }));
  await manager.reload();
  manager.setTheme("light");
  await manager.flush();
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    externallyFixed: true,
    theme: "light",
  });
});

test("nested local edits win their key while retaining sibling fields changed externally", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-settings-nested-external-"));
  const agentDirectory = join(root, "agent");
  const path = join(agentDirectory, "settings.json");
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(path, JSON.stringify({ terminal: { showImages: true, imageWidthCells: 40 } }));

  const manager = SettingsManager.create(join(root, "project"), agentDirectory);
  await writeFile(path, JSON.stringify({
    terminal: { showImages: true, imageWidthCells: 96, showTerminalProgress: true },
  }));
  manager.setShowImages(false);
  await manager.flush();

  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    terminal: { showImages: false, imageWidthCells: 96, showTerminalProgress: true },
  });
});

test("generic scoped updates retain unrelated external fields and enforce project trust", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-settings-generic-update-"));
  const cwd = join(root, "project");
  const agentDirectory = join(root, "agent");
  await mkdir(agentDirectory, { recursive: true });
  const path = join(agentDirectory, "settings.json");
  await writeFile(path, JSON.stringify({ terminal: { showImages: true, imageWidthCells: 40 } }));

  const manager = SettingsManager.create(cwd, agentDirectory, { projectTrusted: false });
  await writeFile(path, JSON.stringify({
    terminal: { showImages: true, imageWidthCells: 99 },
    quietStartup: true,
  }));
  manager.updateGlobalSettings({ terminal: { showImages: false }, theme: "dark" });
  await manager.flush();
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    terminal: { showImages: false, imageWidthCells: 99 },
    quietStartup: true,
    theme: "dark",
  });
  assert.throws(() => manager.updateProjectSettings({ theme: "light" }), /not trusted/iu);
});

test("generic updates preserve concurrent siblings at every nested depth", async () => {
  const storage = new InMemorySettingsStorage();
  storage.withLock("global", () => JSON.stringify({
    retry: { provider: { timeoutMs: 100, maxRetries: 1, extensionOption: "initial" } },
  }));
  const manager = SettingsManager.fromStorage(storage);
  storage.withLock("global", () => JSON.stringify({
    retry: { provider: { timeoutMs: 100, maxRetries: 7, extensionOption: "external" } },
  }));

  manager.updateGlobalSettings({ retry: { provider: { timeoutMs: 250 } } });
  await manager.flush();

  let stored: Record<string, unknown> = {};
  storage.withLock("global", (contents) => {
    stored = JSON.parse(contents ?? "{}") as Record<string, unknown>;
    return undefined;
  });
  assert.deepEqual(stored, {
    retry: { provider: { timeoutMs: 250, maxRetries: 7, extensionOption: "external" } },
  });
});
