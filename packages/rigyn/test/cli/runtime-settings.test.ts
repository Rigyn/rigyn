import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRuntime } from "../../src/cli/runtime.js";
import { SessionManager } from "../../src/storage/session-manager.js";

test("runtime accepts a SessionManager cwd that resolves to the same workspace", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-session-workspace-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const workspaceAlias = join(root, "workspace-alias");
  const agentDirectory = join(root, "agent");
  await Promise.all([mkdir(workspace), mkdir(agentDirectory)]);
  await symlink(workspace, workspaceAlias, process.platform === "win32" ? "junction" : "dir");

  const previousAgentDirectory = process.env.RIGYN_CODING_AGENT_DIR;
  process.env.RIGYN_CODING_AGENT_DIR = agentDirectory;
  const sessionManager = SessionManager.inMemory(workspaceAlias);
  let runtime: Awaited<ReturnType<typeof loadRuntime>> | undefined;
  try {
    runtime = await loadRuntime({
      workspace,
      sessionManager,
      projectTrusted: false,
      offline: true,
      extensions: false,
      extensionRuntime: false,
      skills: false,
      promptTemplates: false,
      themes: false,
    });
    assert.equal(runtime.sessionManager, sessionManager);
  } finally {
    await runtime?.close().catch(() => undefined);
    if (previousAgentDirectory === undefined) delete process.env.RIGYN_CODING_AGENT_DIR;
    else process.env.RIGYN_CODING_AGENT_DIR = previousAgentDirectory;
  }
});

test("runtime startup, reload, and project trust use one SettingsManager authority", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-settings-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  await Promise.all([
    mkdir(join(workspace, ".rigyn"), { recursive: true }),
    mkdir(agentDirectory, { recursive: true }),
  ]);
  await writeFile(join(agentDirectory, "settings.json"), JSON.stringify({
    defaultProvider: "openai",
    defaultModel: "global-model",
    quietStartup: true,
    terminal: { showImages: false, imageWidthCells: 40 },
  }));
  await writeFile(join(workspace, ".rigyn", "settings.json"), JSON.stringify({
    defaultModel: "project-model",
    terminal: { imageWidthCells: 77 },
  }));

  const previousAgentDirectory = process.env.RIGYN_CODING_AGENT_DIR;
  process.env.RIGYN_CODING_AGENT_DIR = agentDirectory;
  const minimal = {
    workspace,
    ephemeral: true,
    offline: true,
    extensions: false,
    extensionRuntime: false,
    skills: false,
    promptTemplates: false,
    themes: false,
  } as const;
  let runtime: Awaited<ReturnType<typeof loadRuntime>> | undefined;
  try {
    runtime = await loadRuntime({ ...minimal, projectTrusted: false });
    assert.equal(runtime.settings, runtime.session.settingsManager);
    assert.equal(runtime.settings.getDefaultProvider(), "openai");
    assert.equal(runtime.settings.getDefaultModel(), "global-model");
    assert.equal(runtime.settings.getShowImages(), false);
    assert.equal(runtime.settings.getImageWidthCells(), 40);

    await writeFile(join(agentDirectory, "settings.json"), JSON.stringify({
      defaultProvider: "anthropic",
      defaultModel: "reloaded-model",
      quietStartup: false,
      terminal: { showImages: true, imageWidthCells: 51 },
    }));
    await runtime.reload();
    assert.equal(runtime.settings, runtime.session.settingsManager);
    assert.equal(runtime.settings.getDefaultProvider(), "anthropic");
    assert.equal(runtime.settings.getDefaultModel(), "reloaded-model");
    assert.equal(runtime.settings.getShowImages(), true);
    assert.equal(runtime.settings.getImageWidthCells(), 51);
    await runtime.close();
    runtime = undefined;

    runtime = await loadRuntime({ ...minimal, projectTrusted: true });
    assert.equal(runtime.settings.getDefaultProvider(), "anthropic");
    assert.equal(runtime.settings.getDefaultModel(), "project-model");
    assert.equal(runtime.settings.getShowImages(), true);
    assert.equal(runtime.settings.getImageWidthCells(), 77);
  } finally {
    await runtime?.close().catch(() => undefined);
    if (previousAgentDirectory === undefined) delete process.env.RIGYN_CODING_AGENT_DIR;
    else process.env.RIGYN_CODING_AGENT_DIR = previousAgentDirectory;
  }
});

test("runtime startup and candidate reload apply persistent tool policy", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-tool-settings-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  await Promise.all([mkdir(workspace), mkdir(agentDirectory)]);
  await writeFile(join(agentDirectory, "settings.json"), JSON.stringify({
    tools: {
      enabled: ["read", "runtime_extension"],
      excluded: ["read"],
    },
  }));

  const previousAgentDirectory = process.env.RIGYN_CODING_AGENT_DIR;
  process.env.RIGYN_CODING_AGENT_DIR = agentDirectory;
  let runtime: Awaited<ReturnType<typeof loadRuntime>> | undefined;
  try {
    runtime = await loadRuntime({
      workspace,
      ephemeral: true,
      projectTrusted: true,
      extensions: false,
      extensionRuntime: true,
      extensionFactories: [{
        name: "runtime-tool-policy",
        factory(api) {
          api.registerTool({
            name: "runtime_extension",
            label: "Runtime extension",
            description: "Runtime tool-policy fixture",
            parameters: { type: "object", additionalProperties: false, properties: {} },
            async execute() { return { content: [{ type: "text", text: "ready" }], details: {} }; },
          });
          api.on("session_start", () => {
            api.registerTool({
              name: "runtime_late_extension",
              label: "Late runtime extension",
              description: "Late runtime tool-policy fixture",
              parameters: { type: "object", additionalProperties: false, properties: {} },
              async execute() { return { content: [{ type: "text", text: "ready" }], details: {} }; },
            });
          });
        },
      }],
      skills: false,
      promptTemplates: false,
      themes: false,
      offline: true,
    });
    assert.deepEqual(runtime.session.getActiveTools(), ["runtime_extension"]);

    await writeFile(join(agentDirectory, "settings.json"), JSON.stringify({
      tools: { excluded: ["bash", "runtime_late_extension"] },
    }));
    await runtime.reload();
    assert.deepEqual(runtime.session.getActiveTools(), [
      "read",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      "runtime_extension",
    ]);
    assert.equal(runtime.session.getAllTools().some((tool) => tool.definition.name === "runtime_late_extension"), true);
  } finally {
    await runtime?.close().catch(() => undefined);
    if (previousAgentDirectory === undefined) delete process.env.RIGYN_CODING_AGENT_DIR;
    else process.env.RIGYN_CODING_AGENT_DIR = previousAgentDirectory;
  }
});

test("runtime reload rejects invalid candidate settings without replacing the active generation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-invalid-settings-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  const settingsPath = join(agentDirectory, "settings.json");
  await Promise.all([mkdir(workspace), mkdir(agentDirectory)]);
  await writeFile(settingsPath, JSON.stringify({ theme: "mono" }));

  const previousAgentDirectory = process.env.RIGYN_CODING_AGENT_DIR;
  process.env.RIGYN_CODING_AGENT_DIR = agentDirectory;
  let runtime: Awaited<ReturnType<typeof loadRuntime>> | undefined;
  try {
    runtime = await loadRuntime({
      workspace,
      ephemeral: true,
      projectTrusted: false,
      extensions: false,
      extensionRuntime: false,
      skills: false,
      promptTemplates: false,
      themes: false,
      offline: true,
    });
    const activeSession = runtime.session;
    const activeSettings = runtime.settings;

    await writeFile(settingsPath, "{not-json");
    await assert.rejects(runtime.reload(), /Settings could not be loaded.*global/iu);
    assert.equal(runtime.session, activeSession);
    assert.equal(runtime.settings, activeSettings);
    assert.equal(runtime.settings.getTheme(), "mono");

    await writeFile(settingsPath, JSON.stringify({
      theme: "mono",
      keybindings: { "app.not-a-real-action": "alt+x" },
    }));
    await assert.rejects(runtime.reload(), /Unknown keybinding action/iu);
    assert.equal(runtime.session, activeSession);
    assert.equal(runtime.settings, activeSettings);

    await writeFile(settingsPath, JSON.stringify({ theme: "mono", tools: "none" }));
    await assert.rejects(runtime.reload(), /tools must be an object or null/iu);
    assert.equal(runtime.session, activeSession);
    assert.equal(runtime.settings, activeSettings);

    await writeFile(settingsPath, JSON.stringify({
      theme: "mono",
      retry: { maxRetries: "3", provider: { timeoutMs: "100" } },
    }));
    await assert.rejects(runtime.reload(), /Invalid retry\.maxRetries setting/iu);
    assert.equal(runtime.session, activeSession);
    assert.equal(runtime.settings, activeSettings);
  } finally {
    await runtime?.close().catch(() => undefined);
    if (previousAgentDirectory === undefined) delete process.env.RIGYN_CODING_AGENT_DIR;
    else process.env.RIGYN_CODING_AGENT_DIR = previousAgentDirectory;
  }
});
