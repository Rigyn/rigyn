import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { ResourceLoader } from "../../src/core/resource-loader.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { createExtensionRuntime, ensureExtensionRuntimeHost } from "../../src/extensions/compat.js";
import { InteractiveMode } from "../../src/modes/interactive-mode.js";
import { ModelRegistry } from "../../src/providers/model-registry.js";
import { createModels } from "../../src/providers/models.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { AgentSession } from "../../src/service/agent-session.js";
import { AgentSessionRuntime } from "../../src/service/agent-session-runtime.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import { TuiController } from "../../src/tui/controller.js";
import { RIGYN_VERSION } from "../../src/version.js";

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test("interactive mode initializes once, binds extensions, accepts native input, and stops cleanly", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rigyn-interactive-mode-"));
  try {
    const extensionRuntime = createExtensionRuntime();
    const extensionHost = ensureExtensionRuntimeHost(extensionRuntime, cwd);
    const themeChanges: unknown[] = [];
    Object.defineProperty(extensionHost, "dispatch", {
      configurable: true,
      value: async (event: string, value: unknown) => {
        if (event === "theme_change") themeChanges.push(value);
      },
    });
    const extensionsResult = { extensions: [], errors: [], runtime: extensionRuntime };
    const theme = {
      name: "ocean",
      extensionId: "theme",
      sourcePath: join(cwd, "ocean.json"),
      sha256: "0".repeat(64),
      definition: {
        schemaVersion: 1 as const,
        name: "ocean",
        base: "dark" as const,
        styles: { accent: { foreground: "#00aaff" as const } },
      },
    };
    const loader: ResourceLoader = {
      getExtensions: () => extensionsResult,
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [theme], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => undefined,
      getAppendSystemPrompt: () => [],
      extendResources() {},
      async reload() {},
    };
    const models = new ModelRegistry(createModels());
    await models.refresh({ allowNetwork: false });
    const settings = SettingsManager.inMemory({ theme: "ocean" });
    const session = await AgentSession.create({
      sessionManager: SessionManager.inMemory(cwd),
      providers: new ProviderRegistry(),
      modelRegistry: models,
      resourceLoader: loader,
      extensionsResult,
      workspace: cwd,
      agentDirectory: join(cwd, ".agent"),
      settingsManager: settings,
      initialToolSelection: { names: [] },
    });
    let starts = 0;
    const bindExtensions = session.bindExtensions.bind(session);
    Object.defineProperty(session, "bindExtensions", {
      configurable: true,
      value: async (...args: Parameters<AgentSession["bindExtensions"]>) => {
        starts += 1;
        await bindExtensions(...args);
      },
    });
    const runtime = new AgentSessionRuntime(
      session,
      { cwd, agentDir: join(cwd, ".agent") },
      async () => { throw new Error("fixture does not replace sessions"); },
    );
    const input = new PassThrough();
    const output = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
    output.columns = 100;
    output.rows = 30;
    output.isTTY = false;
    const terminal = new TuiController({ input, output, mode: "accessible", handleSignals: false });
    const mode = new InteractiveMode(runtime, { terminal });

    await mode.init();
    await mode.init();
    assert.equal(starts, 1);
    assert.equal(terminal.selectedThemeName(), "ocean");
    assert.deepEqual(terminal.themeNames(), ["mono", "ocean"]);
    terminal.setTheme("mono");
    await waitFor(() => themeChanges.length === 1, "embedded theme change was not forwarded to extensions");
    assert.deepEqual(themeChanges[0], {
      previous: "ocean",
      current: "mono",
      available: ["mono", "ocean"],
      reason: "selection",
    });
    assert.equal(settings.getLastChangelogVersion(), RIGYN_VERSION);
    const running = mode.run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const exportPath = join(cwd, "interactive-export.jsonl");
    input.write("/name direct-mode\r");
    input.write(`/export ${exportPath}\r`);
    input.write("/resources\r");
    input.write("/hotkeys\r");
    await waitFor(() => existsSync(exportPath), "public interactive export did not complete");
    assert.equal(runtime.session.sessionName, "direct-mode");
    input.write("/exit\r");
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        running,
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("interactive mode did not stop")), 2_000); }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    assert.equal(input.listenerCount("data"), 0);
    await runtime.dispose();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("interactive mode loads persisted keybindings and refreshes them on reload", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rigyn-interactive-keybindings-"));
  const agentDir = join(cwd, ".agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "keybindings.json"), JSON.stringify({ "app.model.select": "alt+k" }));
  try {
    let holdResourceReload = false;
    let releaseResourceReload: (() => void) | undefined;
    const extensionRuntime = createExtensionRuntime();
    ensureExtensionRuntimeHost(extensionRuntime, cwd);
    const extensionsResult = { extensions: [], errors: [], runtime: extensionRuntime };
    const loader: ResourceLoader = {
      getExtensions: () => extensionsResult,
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => undefined,
      getAppendSystemPrompt: () => [],
      extendResources() {},
      async reload() {
        if (!holdResourceReload) return;
        await new Promise<void>((resolve) => { releaseResourceReload = resolve; });
      },
    };
    const models = new ModelRegistry(createModels());
    await models.refresh({ allowNetwork: false });
    const modelRefreshes: Array<{ allowNetwork?: boolean; force?: boolean }> = [];
    const refreshModels = models.refresh.bind(models);
    Object.defineProperty(models, "refresh", {
      configurable: true,
      value: async (options?: { allowNetwork?: boolean; force?: boolean; signal?: AbortSignal }) => {
        modelRefreshes.push(options ?? {});
        return await refreshModels(options);
      },
    });
    const settings = SettingsManager.inMemory();
    const session = await AgentSession.create({
      sessionManager: SessionManager.inMemory(cwd),
      providers: new ProviderRegistry(),
      modelRegistry: models,
      resourceLoader: loader,
      extensionsResult,
      workspace: cwd,
      agentDirectory: agentDir,
      settingsManager: settings,
      initialToolSelection: { names: [] },
    });
    const runtime = new AgentSessionRuntime(
      session,
      { cwd, agentDir },
      async () => { throw new Error("fixture does not replace sessions"); },
    );
    const input = new PassThrough();
    const output = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
    output.columns = 100;
    output.rows = 30;
    output.isTTY = false;
    const terminal = new TuiController({ input, output, mode: "accessible", handleSignals: false });
    let activeThemeListeners = 0;
    const onThemeChange = terminal.onThemeChange.bind(terminal);
    terminal.onThemeChange = (listener, signal) => {
      activeThemeListeners += 1;
      const unsubscribe = onThemeChange(listener, signal);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        activeThemeListeners -= 1;
        unsubscribe();
      };
    };
    const reloadPresentation: Array<[string | undefined, string | undefined]> = [];
    const setInputBlocked = terminal.setInputBlocked.bind(terminal);
    terminal.setInputBlocked = (message?: string, label?: string): void => {
      reloadPresentation.push([message, label]);
      setInputBlocked(message, label);
    };
    const mode = new InteractiveMode(runtime, { terminal });

    await mode.init();
    assert.equal(activeThemeListeners, 1);
    assert.deepEqual(terminal.keybindingsManager().getKeys("app.model.select"), ["alt+k"]);
    await writeFile(join(agentDir, "keybindings.json"), JSON.stringify({ "app.model.select": "alt+j" }));
    const running = mode.run();
    holdResourceReload = true;
    input.write("/reload\r");
    await waitFor(() => reloadPresentation.some((entry) => entry[1] === "reload"), "interactive reload did not block terminal input");
    await waitFor(() => releaseResourceReload !== undefined, "interactive reload did not reach resource hydration");
    terminal.setEditorText("preserved reload draft");
    releaseResourceReload!();
    await waitFor(
      () => terminal.keybindingsManager().getKeys("app.model.select")[0] === "alt+j",
      "interactive reload did not refresh persisted keybindings",
    );
    await waitFor(() => reloadPresentation.at(-1)?.[0] === undefined, "interactive reload did not restore terminal input");
    assert.equal(activeThemeListeners, 1);
    assert.match(reloadPresentation[0]?.[0] ?? "", /keybindings, extensions, skills, prompts, themes, and context files/u);
    assert.equal(reloadPresentation[0]?.[1], "reload");
    assert.deepEqual(reloadPresentation.at(-1), [undefined, undefined]);
    assert.deepEqual(modelRefreshes.at(-1), { force: false, allowNetwork: false });
    assert.equal(terminal.getEditorText(), "preserved reload draft");
    input.write(" remains editable");
    await waitFor(() => terminal.getEditorText().endsWith(" remains editable"), "terminal input stayed blocked after reload");
    input.write("\u001b");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(terminal.getEditorText(), "preserved reload draft remains editable");
    terminal.setEditorText("");

    const beforeFailedReload = reloadPresentation.length;
    holdResourceReload = false;
    await writeFile(join(agentDir, "keybindings.json"), "{");
    input.write("/reload\r");
    await waitFor(
      () => reloadPresentation.length >= beforeFailedReload + 2,
      "failed interactive reload did not restore terminal input",
    );
    assert.deepEqual(reloadPresentation.at(-1), [undefined, undefined]);
    input.write("/exit\r");
    await running;
    await runtime.dispose();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
