import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@rigyn/models";

import { loadRuntime } from "../../src/cli/runtime.js";
import { AgentSession } from "../../src/service/agent-session.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import { InMemoryCredentialStore } from "../helpers/credential-store.js";

function skillManifest(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# Instructions\n`;
}

test("runtime accepts a SessionManager cwd that resolves to the same workspace", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-session-workspace-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const workspaceAlias = join(root, "workspace-alias");
  const agentDirectory = join(root, "agent");
  await Promise.all([mkdir(workspace), mkdir(agentDirectory)]);
  await symlink(workspace, workspaceAlias, process.platform === "win32" ? "junction" : "dir");

  const previousAgentDirectory = process.env.RIGYN_HOME;
  process.env.RIGYN_HOME = agentDirectory;
  const sessionManager = SessionManager.inMemory(workspaceAlias);
  let runtime: Awaited<ReturnType<typeof loadRuntime>> | undefined;
  try {
    runtime = await loadRuntime({
      workspace,
      credentialStore: new InMemoryCredentialStore(),
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
    if (previousAgentDirectory === undefined) delete process.env.RIGYN_HOME;
    else process.env.RIGYN_HOME = previousAgentDirectory;
  }
});

test("runtime cannot activate project scope when it is the Rigyn home", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-root-collision-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const agentDirectory = join(root, ".rigyn");
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(join(agentDirectory, "config.json"), JSON.stringify({ defaultModel: "global-model" }));
  const runtime = await loadRuntime({
    workspace: root,
    agentDirectory,
    credentialStore: new InMemoryCredentialStore(),
    ephemeral: true,
    projectTrusted: true,
    offline: true,
    extensions: false,
    extensionRuntime: false,
    skills: false,
    promptTemplates: false,
    themes: false,
  });
  try {
    assert.equal(runtime.trusted, false);
    assert.equal(runtime.settings.isProjectTrusted(), false);
    assert.equal(runtime.settings.getDefaultModel(), "global-model");
  } finally {
    await runtime.close();
  }
});

test("runtime startup failure releases the selected persistent session writer", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-startup-cleanup-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  const sessionDirectory = join(root, "sessions");
  await Promise.all([mkdir(workspace), mkdir(agentDirectory)]);
  const create = AgentSession.create;
  AgentSession.create = async () => { throw new Error("session construction fixture"); };
  try {
    await assert.rejects(loadRuntime({
      workspace,
      agentDirectory,
      credentialStore: new InMemoryCredentialStore(),
      sessionDirectory,
      projectTrusted: false,
      offline: true,
      extensions: false,
      extensionRuntime: false,
      skills: false,
      promptTemplates: false,
      themes: false,
    }), /session construction fixture/u);
  } finally {
    AgentSession.create = create;
  }

  const journals = (await readdir(sessionDirectory)).filter((name) => name.endsWith(".jsonl"));
  assert.equal(journals.length, 1);
  const reopened = SessionManager.open(join(sessionDirectory, journals[0]!));
  reopened.closeV4Store();
});

test("runtime validates and forwards process-wide cache retention", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-cache-retention-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  await Promise.all([mkdir(workspace), mkdir(agentDirectory)]);

  const previousAgentDirectory = process.env.RIGYN_HOME;
  const previousCacheRetention = process.env.RIGYN_CACHE_RETENTION;
  process.env.RIGYN_HOME = agentDirectory;
  const observed: unknown[] = [];
  let runtime: Awaited<ReturnType<typeof loadRuntime>> | undefined;
  try {
    process.env.RIGYN_CACHE_RETENTION = "long";
    runtime = await loadRuntime({
      workspace,
      credentialStore: new InMemoryCredentialStore(),
      ephemeral: true,
      projectTrusted: true,
      extensions: false,
      extensionRuntime: true,
      extensionFactories: [{
        name: "cache-retention-probe",
        factory(api) {
          api.registerProvider("cache-retention-probe", {
            api: "openai-chat-completions",
            apiKey: "local-test",
            baseUrl: "https://example.test/v1",
            models: [{
              id: "probe-model",
              name: "Probe model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8_192,
              maxTokens: 2_048,
            }],
            streamSimple(_model, _context, options) {
              observed.push(options?.cacheRetention);
              const stream = createAssistantMessageEventStream();
              queueMicrotask(() => {
                const message: AssistantMessage = {
                  role: "assistant",
                  content: [{ type: "text", text: "ready" }],
                  api: "openai-chat-completions",
                  provider: "cache-retention-probe",
                  model: "probe-model",
                  stopReason: "stop",
                  timestamp: Date.now(),
                  usage: {
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 2,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                  },
                };
                stream.push({ type: "start", partial: { ...message, content: [] } });
                stream.push({ type: "done", reason: "stop", message });
              });
              return stream;
            },
          });
        },
      }],
      skills: false,
      promptTemplates: false,
      themes: false,
      offline: true,
    });
    await runtime.session.setModel(await runtime.session.resolveModel(
      "probe-model",
      { provider: "cache-retention-probe" },
    ));
    await runtime.session.prompt("probe", { allowedTools: [] });
    assert.deepEqual(observed, ["long"]);
    await runtime.close();
    runtime = undefined;

    process.env.RIGYN_CACHE_RETENTION = "forever";
    await assert.rejects(
      loadRuntime({
        workspace,
        credentialStore: new InMemoryCredentialStore(),
        ephemeral: true,
        projectTrusted: false,
        extensions: false,
        extensionRuntime: false,
        skills: false,
        promptTemplates: false,
        themes: false,
        offline: true,
      }),
      /RIGYN_CACHE_RETENTION must be none, short, or long/u,
    );
  } finally {
    await runtime?.close().catch(() => undefined);
    if (previousAgentDirectory === undefined) delete process.env.RIGYN_HOME;
    else process.env.RIGYN_HOME = previousAgentDirectory;
    if (previousCacheRetention === undefined) delete process.env.RIGYN_CACHE_RETENTION;
    else process.env.RIGYN_CACHE_RETENTION = previousCacheRetention;
  }
});

test("runtime startup, refresh, and project trust use one SettingsManager authority", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-settings-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  await Promise.all([
    mkdir(join(workspace, ".rigyn"), { recursive: true }),
    mkdir(agentDirectory, { recursive: true }),
  ]);
  await writeFile(join(agentDirectory, "config.json"), JSON.stringify({
    defaultProvider: "openai",
    defaultModel: "global-model",
    quietStartup: true,
    terminal: { showImages: false, imageWidthCells: 40 },
  }));
  await writeFile(join(workspace, ".rigyn", "config.json"), JSON.stringify({
    defaultModel: "project-model",
    terminal: { imageWidthCells: 77 },
  }));

  const previousAgentDirectory = process.env.RIGYN_HOME;
  process.env.RIGYN_HOME = agentDirectory;
  const minimal = {
    workspace,
    credentialStore: new InMemoryCredentialStore(),
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

    await writeFile(join(agentDirectory, "config.json"), JSON.stringify({
      defaultProvider: "anthropic",
      defaultModel: "refreshed-model",
      quietStartup: false,
      terminal: { showImages: true, imageWidthCells: 51 },
    }));
    await runtime.refresh();
    assert.equal(runtime.settings, runtime.session.settingsManager);
    assert.equal(runtime.settings.getDefaultProvider(), "anthropic");
    assert.equal(runtime.settings.getDefaultModel(), "refreshed-model");
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
    if (previousAgentDirectory === undefined) delete process.env.RIGYN_HOME;
    else process.env.RIGYN_HOME = previousAgentDirectory;
  }
});

test("runtime startup and candidate refresh apply persistent tool policy", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-tool-settings-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  await Promise.all([mkdir(workspace), mkdir(agentDirectory)]);
  await writeFile(join(agentDirectory, "config.json"), JSON.stringify({
    tools: {
      enabled: ["read", "runtime_extension"],
      excluded: ["read"],
    },
  }));

  const previousAgentDirectory = process.env.RIGYN_HOME;
  process.env.RIGYN_HOME = agentDirectory;
  let runtime: Awaited<ReturnType<typeof loadRuntime>> | undefined;
  try {
    runtime = await loadRuntime({
      workspace,
      credentialStore: new InMemoryCredentialStore(),
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

    await writeFile(join(agentDirectory, "config.json"), JSON.stringify({
      tools: { excluded: ["bash", "runtime_late_extension"] },
    }));
    await runtime.refresh();
    assert.deepEqual(runtime.session.getActiveTools(), [
      "read",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      "runtime_extension",
    ]);
    assert.equal(runtime.session.getAllTools().some((tool) => tool.name === "runtime_late_extension"), true);
  } finally {
    await runtime?.close().catch(() => undefined);
    if (previousAgentDirectory === undefined) delete process.env.RIGYN_HOME;
    else process.env.RIGYN_HOME = previousAgentDirectory;
  }
});

test("runtime compatibility skill roots exclude direct Markdown and load nested manifests", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-shared-skills-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const repository = join(root, "repository");
  const workspace = join(repository, "packages", "app");
  const agentDirectory = join(root, "agent");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(join(repository, ".git"), { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(agentDirectory, { recursive: true }),
  ]);

  const sharedRoots = [
    { path: join(home, ".agents", "skills"), name: "user-agent" },
    { path: join(home, ".claude", "skills"), name: "user-claude" },
    { path: join(repository, ".agents", "skills"), name: "repository-agent" },
    { path: join(workspace, ".codex", "skills"), name: "workspace-codex" },
  ] as const;
  for (const entry of sharedRoots) {
    await mkdir(join(entry.path, "nested"), { recursive: true });
    await writeFile(
      join(entry.path, `${entry.name}-root.md`),
      skillManifest(`${entry.name}-root`, "A direct compatibility-root Markdown file."),
    );
    await writeFile(
      join(entry.path, "nested", "SKILL.md"),
      skillManifest(`${entry.name}-nested`, "A nested compatibility-root skill."),
    );
  }

  const previousAgentDirectory = process.env.RIGYN_HOME;
  const previousHome = process.env.HOME;
  process.env.RIGYN_HOME = agentDirectory;
  process.env.HOME = home;
  let runtime: Awaited<ReturnType<typeof loadRuntime>> | undefined;
  try {
    runtime = await loadRuntime({
      workspace,
      credentialStore: new InMemoryCredentialStore(),
      ephemeral: true,
      projectTrusted: true,
      extensions: false,
      extensionRuntime: false,
      skills: true,
      promptTemplates: false,
      themes: false,
      offline: true,
    });
    const names = new Set(runtime.resourceLoader.getSkills().skills.map((skill) => skill.name));
    for (const entry of sharedRoots) {
      assert.equal(names.has(`${entry.name}-nested`), true);
      assert.equal(names.has(`${entry.name}-root`), false);
    }
  } finally {
    await runtime?.close().catch(() => undefined);
    if (previousAgentDirectory === undefined) delete process.env.RIGYN_HOME;
    else process.env.RIGYN_HOME = previousAgentDirectory;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("runtime refresh rejects invalid candidate settings without replacing the active generation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-invalid-settings-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  const settingsPath = join(agentDirectory, "config.json");
  await Promise.all([mkdir(workspace), mkdir(agentDirectory)]);
  await writeFile(settingsPath, JSON.stringify({ theme: "mono" }));

  const previousAgentDirectory = process.env.RIGYN_HOME;
  process.env.RIGYN_HOME = agentDirectory;
  let runtime: Awaited<ReturnType<typeof loadRuntime>> | undefined;
  try {
    runtime = await loadRuntime({
      workspace,
      credentialStore: new InMemoryCredentialStore(),
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
    await assert.rejects(runtime.refresh(), /Settings could not be loaded.*global/iu);
    assert.equal(runtime.session, activeSession);
    assert.equal(runtime.settings, activeSettings);
    assert.equal(runtime.settings.getTheme(), "mono");

    await writeFile(settingsPath, JSON.stringify({
      theme: "mono",
      keybindings: { "app.not-a-real-action": "alt+x" },
    }));
    await assert.rejects(runtime.refresh(), /Unknown keybinding action/iu);
    assert.equal(runtime.session, activeSession);
    assert.equal(runtime.settings, activeSettings);

    await writeFile(settingsPath, JSON.stringify({ theme: "mono", tools: "none" }));
    await assert.rejects(runtime.refresh(), /settings\.tools must be an object/iu);
    assert.equal(runtime.session, activeSession);
    assert.equal(runtime.settings, activeSettings);

    await writeFile(settingsPath, JSON.stringify({
      theme: "mono",
      retry: { maxRetries: "3", provider: { timeoutMs: "100" } },
    }));
    await assert.rejects(runtime.refresh(), /Invalid retry\.maxRetries setting/iu);
    assert.equal(runtime.session, activeSession);
    assert.equal(runtime.settings, activeSettings);
  } finally {
    await runtime?.close().catch(() => undefined);
    if (previousAgentDirectory === undefined) delete process.env.RIGYN_HOME;
    else process.env.RIGYN_HOME = previousAgentDirectory;
  }
});
