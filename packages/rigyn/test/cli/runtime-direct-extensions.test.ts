import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRuntime } from "../../src/cli/runtime.js";

test("interactive startup can hydrate model state without waiting for live discovery", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-deferred-model-refresh-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  const previousAgentDir = process.env.RIGYN_CODING_AGENT_DIR;
  process.env.RIGYN_CODING_AGENT_DIR = agentDir;
  const networkModes: boolean[] = [];
  context.after(async () => {
    if (previousAgentDir === undefined) delete process.env.RIGYN_CODING_AGENT_DIR;
    else process.env.RIGYN_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await loadRuntime({
    workspace,
    projectTrusted: true,
    ephemeral: true,
    extensions: false,
    extensionRuntime: true,
    extensionFactories: [{
      name: "deferred-model-refresh-probe",
      factory(api) {
        api.registerProvider("deferred-model-refresh-probe", {
          api: "openai-completions",
          apiKey: "local-test",
          baseUrl: "http://127.0.0.1:1/v1",
          models: [{
            id: "probe-model",
            name: "Cached probe model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8_192,
            maxTokens: 2_048,
          }],
          async refreshModels(refresh) {
            networkModes.push(refresh.allowNetwork);
            return [{
              id: "probe-model",
              name: "Probe model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8_192,
              maxTokens: 2_048,
            }];
          },
        });
      },
    }],
    skills: false,
    promptTemplates: false,
    themes: false,
    deferModelNetworkRefresh: true,
  });
  context.after(async () => await runtime.close().catch(() => undefined));

  assert.equal(networkModes.includes(true), false);
  assert.equal(runtime.modelRegistry.find("deferred-model-refresh-probe", "probe-model")?.id, "probe-model");
  await runtime.modelRegistry.refresh({ force: true, signal: runtime.generationSignal });
  assert.equal(networkModes.includes(true), true);
});

test("empty direct runtime starts and reloads before provider lifecycle bindings become live", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-empty-direct-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  const previousAgentDir = process.env.RIGYN_CODING_AGENT_DIR;
  process.env.RIGYN_CODING_AGENT_DIR = agentDir;
  context.after(async () => {
    if (previousAgentDir === undefined) delete process.env.RIGYN_CODING_AGENT_DIR;
    else process.env.RIGYN_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await loadRuntime({
    workspace,
    projectTrusted: true,
    ephemeral: true,
    extensions: false,
    extensionRuntime: true,
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
  });
  context.after(async () => await runtime.close().catch(() => undefined));

  assert.deepEqual(runtime.runtimeExtensions.extensions(), []);
  const maintained = await runtime.session.resolveModel("gpt-5.6-sol", { provider: "openai" });
  assert.equal(maintained.api, "openai-responses");
  assert.equal(maintained.info?.contextTokens, 1_050_000);
  assert.deepEqual(maintained.info?.compatibility?.reasoningEfforts?.value, [
    "off", "low", "medium", "high", "xhigh", "max",
  ]);
  assert.deepEqual((await runtime.reload()).warnings, []);
  assert.deepEqual(runtime.runtimeExtensions.extensions(), []);
});

test("inline extension factories are reactivated for each committed runtime generation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-inline-extension-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  const previousAgentDir = process.env.RIGYN_CODING_AGENT_DIR;
  process.env.RIGYN_CODING_AGENT_DIR = agentDir;
  let activations = 0;
  context.after(async () => {
    if (previousAgentDir === undefined) delete process.env.RIGYN_CODING_AGENT_DIR;
    else process.env.RIGYN_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await loadRuntime({
    workspace,
    projectTrusted: true,
    ephemeral: true,
    extensions: false,
    extensionRuntime: true,
    extensionFactories: [{
      name: "inline-generation-probe",
      factory(api) {
        activations += 1;
        api.registerCommand(`inline-generation-${activations}`, { async handler() {} });
      },
    }],
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
  });
  context.after(async () => await runtime.close().catch(() => undefined));

  assert.equal(activations, 1);
  assert.deepEqual(runtime.runtimeExtensions.commands().map((entry) => entry.name), ["inline-generation-1"]);
  await runtime.reload();
  assert.equal(activations, 2);
  assert.deepEqual(runtime.runtimeExtensions.commands().map((entry) => entry.name), ["inline-generation-2"]);
});

test("runtime reload announces shutdown before activating the replacement extension generation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-reload-order-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  const previousAgentDir = process.env.RIGYN_CODING_AGENT_DIR;
  process.env.RIGYN_CODING_AGENT_DIR = agentDir;
  const lifecycle: string[] = [];
  let generation = 0;
  context.after(async () => {
    if (previousAgentDir === undefined) delete process.env.RIGYN_CODING_AGENT_DIR;
    else process.env.RIGYN_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await loadRuntime({
    workspace,
    projectTrusted: true,
    ephemeral: true,
    extensions: false,
    extensionRuntime: true,
    extensionFactories: [{
      name: "reload-order-probe",
      factory(api) {
        const current = ++generation;
        lifecycle.push(`${current}:activate`);
        api.on("session_shutdown", (event) => { lifecycle.push(`${current}:shutdown:${event.reason}`); });
      },
    }],
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
  });
  context.after(async () => await runtime.close().catch(() => undefined));

  await runtime.reload();

  assert.deepEqual(lifecycle, [
    "1:activate",
    "1:shutdown:reload",
    "2:activate",
  ]);
});

test("runtime reload completes its UI commit when old-session cleanup fails", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-session-cleanup-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  const previousAgentDir = process.env.RIGYN_CODING_AGENT_DIR;
  process.env.RIGYN_CODING_AGENT_DIR = agentDir;
  context.after(async () => {
    if (previousAgentDir === undefined) delete process.env.RIGYN_CODING_AGENT_DIR;
    else process.env.RIGYN_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await loadRuntime({
    workspace,
    projectTrusted: true,
    ephemeral: true,
    extensions: false,
    extensionRuntime: true,
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
  });
  context.after(async () => await runtime.close().catch(() => undefined));
  const previousSession = runtime.session;
  const closePreviousSession = previousSession.close.bind(previousSession);
  previousSession.close = async () => { throw new Error("old session cleanup fixture"); };
  let uiCommitted = false;

  const result = await runtime.reload({ onCommit() { uiCommitted = true; } });

  assert.equal(uiCommitted, true);
  assert.notEqual(runtime.session, previousSession);
  assert.deepEqual(result.warnings, ["Old session cleanup failed: old session cleanup fixture"]);
  await closePreviousSession();
});

test("a failed runtime reload disposes its candidate and restarts the previous generation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-reload-recovery-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  const previousAgentDir = process.env.RIGYN_CODING_AGENT_DIR;
  process.env.RIGYN_CODING_AGENT_DIR = agentDir;
  const lifecycle: string[] = [];
  let generation = 0;
  context.after(async () => {
    if (previousAgentDir === undefined) delete process.env.RIGYN_CODING_AGENT_DIR;
    else process.env.RIGYN_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await loadRuntime({
    workspace,
    projectTrusted: true,
    ephemeral: true,
    extensions: false,
    extensionRuntime: true,
    extensionFactories: [{
      name: "reload-recovery-probe",
      factory(api) {
        const current = ++generation;
        lifecycle.push(`${current}:activate`);
        api.on("session_shutdown", (event) => { lifecycle.push(`${current}:shutdown:${event.reason}`); });
        api.on("session_start", (event) => { lifecycle.push(`${current}:start:${event.reason}`); });
        api.onDispose(() => { lifecycle.push(`${current}:dispose`); });
        api.registerCommand(`reload-recovery-${current}`, { async handler() {} });
      },
    }],
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
  });
  context.after(async () => await runtime.close().catch(() => undefined));

  await assert.rejects(runtime.reload({
    prepareExtensions() { throw new Error("candidate rejected"); },
  }), /candidate rejected/u);

  assert.deepEqual(lifecycle, [
    "1:activate",
    "1:shutdown:reload",
    "2:activate",
    "2:dispose",
    "1:start:reload",
  ]);
  assert.deepEqual(runtime.runtimeExtensions.commands().map((entry) => entry.name), ["reload-recovery-1"]);
});

test("runtime startup and reload use direct package factories as one resource generation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-direct-extension-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const packageRoot = join(agentDir, "extensions", "direct-package");
  const extensionPath = join(packageRoot, "index.ts");
  const promptPath = join(packageRoot, "prompts", "inspect.md");
  await mkdir(join(packageRoot, "prompts"), { recursive: true });
  await mkdir(workspace);
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "direct-package",
    rigyn: { extensions: ["index.ts"], prompts: ["prompts"] },
  }));
  await writeFile(promptPath, "Inspect $ARGUMENTS\n");
  await writeFile(extensionPath, `export default (api) => {
    globalThis.__rigynDirectApis ??= [];
    globalThis.__rigynDirectApis.push(api);
    api.registerCommand("generation-one", { handler() {} });
  };\n`);
  const previousAgentDir = process.env.RIGYN_CODING_AGENT_DIR;
  process.env.RIGYN_CODING_AGENT_DIR = agentDir;
  context.after(async () => {
    if (previousAgentDir === undefined) delete process.env.RIGYN_CODING_AGENT_DIR;
    else process.env.RIGYN_CODING_AGENT_DIR = previousAgentDir;
    delete (globalThis as Record<string, unknown>).__rigynDirectApis;
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await loadRuntime({
    workspace,
    projectTrusted: true,
    ephemeral: true,
    extensions: true,
    extensionRuntime: true,
    offline: true,
  });
  context.after(async () => await runtime.close().catch(() => undefined));
  assert.deepEqual(runtime.runtimeExtensions.commands().map((entry) => entry.name), ["generation-one"]);
  assert.equal(runtime.resourceLoader.getPrompts().prompts.some((entry) => entry.name === "inspect"), true);
  assert.equal(runtime.extensions.prompt("inspect")?.template, "Inspect $ARGUMENTS\n");

  const firstApi = ((globalThis as Record<string, unknown>).__rigynDirectApis as Array<{ getAllTools(): unknown }>)[0]!;
  await writeFile(extensionPath, `export default (api) => {
    globalThis.__rigynDirectApis.push(api);
    api.registerCommand("generation-two", { handler() {} });
  };\n`);
  await runtime.reload();

  assert.deepEqual(runtime.runtimeExtensions.commands().map((entry) => entry.name), ["generation-two"]);
  assert.throws(() => firstApi.getAllTools(), /no longer active|stale/iu);
  assert.equal(((globalThis as Record<string, unknown>).__rigynDirectApis as unknown[]).length, 2);
  assert.equal(runtime.extensions.list().length, 1);
  assert.equal(runtime.extensions.list()[0]?.status, "active");
});

test("invocation-only package sources activate direct factories and companion resources without persistence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-invocation-package-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const packageRoot = join(root, "invocation-package");
  await mkdir(join(packageRoot, "prompts"), { recursive: true });
  await mkdir(workspace);
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "invocation-package",
    rigyn: { extensions: ["index.mjs"], prompts: ["prompts"] },
  }));
  await writeFile(join(packageRoot, "index.mjs"), `export default (api) => {
    api.registerCommand("invocation-command", { handler() {} });
  };\n`);
  await writeFile(join(packageRoot, "prompts", "invocation-prompt.md"), "Invocation $ARGUMENTS\n");
  const previousAgentDir = process.env.RIGYN_CODING_AGENT_DIR;
  process.env.RIGYN_CODING_AGENT_DIR = agentDir;
  context.after(async () => {
    if (previousAgentDir === undefined) delete process.env.RIGYN_CODING_AGENT_DIR;
    else process.env.RIGYN_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await loadRuntime({
    workspace,
    projectTrusted: true,
    ephemeral: true,
    extensions: false,
    extensionRuntime: true,
    extensionPaths: [packageRoot],
    offline: true,
  });
  context.after(async () => await runtime.close().catch(() => undefined));

  assert.deepEqual(runtime.runtimeExtensions.commands().map((entry) => entry.name), ["invocation-command"]);
  assert.equal(runtime.runtimeExtensions.extensions()[0]?.scope, "invocation");
  assert.equal(runtime.extensions.prompt("invocation-prompt")?.template, "Invocation $ARGUMENTS\n");
});
