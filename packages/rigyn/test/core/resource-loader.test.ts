import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  DefaultResourceLoader,
  type ResourceExtensionsResult,
} from "../../src/core/resource-loader.js";
import { createEventBus } from "../../src/core/event-bus.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { getExtensionRuntimeHost } from "../../src/extensions/compat.js";
import {
  loadDirectExtensions,
  type RuntimeExtensionHost,
} from "../../src/extensions/runtime.js";

async function fixture(): Promise<{ root: string; cwd: string; agentDir: string; settings: SettingsManager }> {
  const root = await mkdtemp(join(tmpdir(), "rigyn-resource-loader-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  return { root, cwd, agentDir, settings: SettingsManager.inMemory() };
}

function extensionHost(result: ResourceExtensionsResult): RuntimeExtensionHost {
  const host = getExtensionRuntimeHost(result.runtime);
  assert.ok(host, "public extension result must retain its native host generation");
  return host;
}

function registeredCommandNames(result: ResourceExtensionsResult): string[] {
  return result.extensions.flatMap((extension) => [...extension.commands.keys()]);
}

test("resource views are empty before the first reload", async (t) => {
  const value = await fixture();
  const loader = new DefaultResourceLoader({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
  });
  t.after(async () => await extensionHost(loader.getExtensions()).close());

  assert.deepEqual(loader.getExtensions().extensions, []);
  assert.deepEqual(loader.getSkills(), { skills: [], diagnostics: [] });
  assert.deepEqual(loader.getPrompts(), { prompts: [], diagnostics: [] });
  assert.deepEqual(loader.getThemes(), { themes: [], diagnostics: [] });
  assert.deepEqual(loader.getAgentsFiles(), { agentsFiles: [] });
  assert.equal(loader.getSystemPrompt(), undefined);
  assert.deepEqual(loader.getAppendSystemPrompt(), []);
});

test("a supplied event bus reaches direct factories loaded by the resource loader", async (t) => {
  const value = await fixture();
  const eventBus = createEventBus();
  let received = 0;
  const loader = new DefaultResourceLoader({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    eventBus,
    extensionFactories: [{
      name: "event-probe",
      factory(api) {
        api.events.on("resource-loader:probe", () => { received += 1; });
      },
    }],
  });
  t.after(async () => await extensionHost(loader.getExtensions()).close());

  await loader.reload();
  eventBus.emit("resource-loader:probe", null);
  assert.equal(received, 1);
});

test("project-trust extensions can be loaded as an explicit bootstrap generation", async (t) => {
  const value = await fixture();
  const loader = new DefaultResourceLoader({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    extensionFactories: [{
      name: "trust-probe",
      factory(api) { api.registerCommand("trust-probe", { async handler() {} }); },
    }],
  });
  const result = await loader.loadProjectTrustExtensions();
  t.after(async () => await extensionHost(result).close());

  assert.deepEqual(registeredCommandNames(result), ["trust-probe"]);
  assert.equal(value.settings.isProjectTrusted(), false);
});

test("extension overrides receive and return the complete load result", async (t) => {
  const value = await fixture();
  let receivedRuntime: unknown;
  const loader = new DefaultResourceLoader({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    extensionFactories: [{
      name: "override-probe",
      factory(api) {
        api.registerCommand("probe", { async handler() {} });
      },
    }],
    extensionsOverride(base) {
      receivedRuntime = base.runtime;
      return {
        ...base,
        errors: [...base.errors, { path: "<override>", error: "synthetic diagnostic" }],
      };
    },
  });
  t.after(async () => await extensionHost(loader.getExtensions()).close());

  await loader.reload();
  const result = loader.getExtensions();
  assert.equal(result.runtime, receivedRuntime);
  assert.deepEqual(result.extensions.map((entry) => [entry.path, entry.sourceInfo.scope]), [
    ["<inline:override-probe>", "temporary"],
  ]);
  assert.deepEqual(registeredCommandNames(result), ["probe"]);
  assert.deepEqual(result.errors, [{ path: "<override>", error: "synthetic diagnostic" }]);
});

test("failed and finally-aborted reloads leave every published resource view on the prior generation", async (t) => {
  const value = await fixture();
  const extension = join(value.root, "atomic.mjs");
  const skill = join(value.root, "atomic-skill");
  const prompt = join(value.root, "atomic.md");
  const theme = join(value.root, "atomic-theme.json");
  await mkdir(skill);
  const writeGeneration = async (generation: "one" | "two"): Promise<void> => {
    await Promise.all([
      writeFile(extension, `export default (api) => api.registerCommand(${JSON.stringify(generation)}, { handler() {} });`),
      writeFile(join(skill, "SKILL.md"), `---\nname: atomic-skill\ndescription: ${generation}\n---\n${generation}`),
      writeFile(prompt, generation),
      writeFile(theme, JSON.stringify({
        schemaVersion: 1,
        name: `atomic-${generation}`,
        styles: { accent: { foreground: generation === "one" ? 1 : 2 } },
      })),
      writeFile(join(value.cwd, "AGENTS.md"), `${generation} context`),
      writeFile(join(value.agentDir, "SYSTEM.md"), `${generation} system`),
      writeFile(join(value.agentDir, "APPEND_SYSTEM.md"), `${generation} append`),
    ]);
  };
  await writeGeneration("one");

  let mode: "normal" | "throw" | "abort" = "normal";
  let abortController: AbortController | undefined;
  let expectedExtensions: ResourceExtensionsResult | undefined;
  let expectedState: ReturnType<typeof publishedState> | undefined;
  let loader: DefaultResourceLoader;
  function publishedState() {
    return {
      skills: loader.getSkills(),
      prompts: loader.getPrompts(),
      themes: loader.getThemes(),
      agentsFiles: loader.getAgentsFiles(),
      systemPrompt: loader.getSystemPrompt(),
      appendSystemPrompt: loader.getAppendSystemPrompt(),
      projectPackages: loader.getProjectPackageState(),
    };
  }
  loader = new DefaultResourceLoader({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    additionalExtensionPaths: [extension],
    additionalSkillPaths: [skill],
    additionalPromptTemplatePaths: [prompt],
    additionalThemePaths: [theme],
    extensionsOverride(base) {
      if (mode === "normal") return base;
      assert.equal(loader.getExtensions(), expectedExtensions);
      assert.deepEqual(publishedState(), expectedState);
      if (mode === "throw") throw new Error("candidate override failure");
      abortController!.abort(new Error("final reload abort"));
      return base;
    },
  });
  t.after(async () => await extensionHost(loader.getExtensions()).close());

  await loader.reload();
  expectedExtensions = loader.getExtensions();
  expectedState = publishedState();
  const expectedHost = extensionHost(expectedExtensions);
  assert.deepEqual(registeredCommandNames(expectedExtensions), ["one"]);
  await writeGeneration("two");

  mode = "throw";
  await assert.rejects(loader.reload(), /candidate override failure/u);
  assert.equal(loader.getExtensions(), expectedExtensions);
  assert.equal(extensionHost(loader.getExtensions()), expectedHost);
  assert.deepEqual(publishedState(), expectedState);
  assert.deepEqual(registeredCommandNames(loader.getExtensions()), ["one"]);

  mode = "abort";
  abortController = new AbortController();
  await assert.rejects(loader.reload({ signal: abortController.signal }), /final reload abort/u);
  assert.equal(loader.getExtensions(), expectedExtensions);
  assert.equal(extensionHost(loader.getExtensions()), expectedHost);
  assert.deepEqual(publishedState(), expectedState);
  assert.deepEqual(registeredCommandNames(loader.getExtensions()), ["one"]);
});

test("extension load results exclude warnings emitted by active extensions", async (t) => {
  const value = await fixture();
  const loader = new DefaultResourceLoader({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    extensionFactories: [{
      name: "reserved-command",
      factory(api) {
        api.registerCommand("quit", { async handler() {} });
      },
    }],
  });
  t.after(async () => await extensionHost(loader.getExtensions()).close());

  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  assert.equal(extensionHost(result).diagnostics().some((entry) =>
    /command quit conflicts with a built-in command/u.test(entry.message)), true);
});

test("extension resources are discovered only after the selected runtime starts", async (t) => {
  const value = await fixture();
  const prompt = join(value.cwd, "late-resource.md");
  await writeFile(prompt, "Loaded after startup");
  const lifecycle: string[] = [];
  let started = false;
  const loader = new DefaultResourceLoader({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    extensionFactories: [{
      name: "late-resources",
      factory(api) {
        api.on("session_start", () => {
          started = true;
          lifecycle.push("start");
        });
        api.on("resources_discover", () => {
          assert.equal(started, true);
          lifecycle.push("discover");
          return { skillPaths: [], promptPaths: [prompt], themePaths: [] };
        });
      },
    }],
  });
  t.after(async () => await extensionHost(loader.getExtensions()).close());

  await loader.reload();
  assert.deepEqual(lifecycle, []);
  assert.deepEqual(loader.getPrompts().prompts, []);
  const result = loader.getExtensions();
  await extensionHost(result).dispatch("session_start", { reason: "startup" } as never);
  await loader.extendResourcesFromExtensions(result.runtime, "startup");
  assert.deepEqual(lifecycle, ["start", "discover"]);
  assert.deepEqual(loader.getPrompts().prompts.map((entry) => entry.name), ["late-resource"]);
});

test("reload composes direct extensions, inline factories, resources, context, and prompt files", async (t) => {
  const value = await fixture();
  const extension = join(value.root, "extension.ts");
  const skill = join(value.cwd, "review", "SKILL.md");
  const prompt = join(value.cwd, "review.md");
  await mkdir(join(value.cwd, "review"));
  await writeFile(extension, `export default (api) => api.registerCommand("from-file", { handler() {} });`);
  await writeFile(skill, `---\nname: review\ndescription: Review changes\n---\nInstructions`);
  await writeFile(prompt, `---\ndescription: Review a change\n---\nReview $ARGUMENTS`);
  await writeFile(join(value.agentDir, "AGENTS.md"), "global context");
  await writeFile(join(value.cwd, "AGENTS.md"), "project context");
  await writeFile(join(value.agentDir, "SYSTEM.md"), "global system");
  await mkdir(join(value.cwd, ".rigyn"));
  await writeFile(join(value.cwd, ".rigyn", "SYSTEM.md"), "project system");
  await writeFile(join(value.cwd, ".rigyn", "APPEND_SYSTEM.md"), "project append");

  const loader = new DefaultResourceLoader({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    additionalExtensionPaths: [extension],
    extensionFactories: [{
      name: "resources",
      factory(api) {
        api.on("resources_discover", () => ({ skillPaths: [skill], promptPaths: [prompt], themePaths: [] }));
        api.registerCommand("from-inline", { async handler() {} });
      },
    }],
  });
  t.after(async () => await extensionHost(loader.getExtensions()).close());
  await loader.reload();
  await extensionHost(loader.getExtensions()).dispatch("session_start", { reason: "startup" } as never);
  await loader.extendResourcesFromExtensions(loader.getExtensions().runtime, "startup");

  assert.deepEqual(registeredCommandNames(loader.getExtensions()).sort(), ["from-file", "from-inline"]);
  assert.equal(loader.getSkills().skills.some((entry) => entry.name === "review"), true);
  assert.deepEqual(loader.getPrompts().prompts.map((entry) => entry.name), ["review"]);
  assert.deepEqual(loader.getAgentsFiles().agentsFiles.map((entry) => entry.content), ["global context", "project context"]);
  assert.equal(loader.getSystemPrompt(), "project system");
  assert.deepEqual(loader.getAppendSystemPrompt(), ["project append"]);
});

test("reload invalidates the replaced direct API before running its disposer", async (t) => {
  const value = await fixture();
  const generations: Array<{
    api: import("../../src/extensions/direct.js").ExtensionAPI;
    staleDuringDispose?: boolean;
    disposeCount: number;
  }> = [];
  const loader = new DefaultResourceLoader({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    extensionFactories: [{
      name: "disposal-probe",
      factory(api) {
        const generation: (typeof generations)[number] = { api, disposeCount: 0 };
        generations.push(generation);
        api.onDispose(() => {
          generation.disposeCount += 1;
          try {
            api.getCommands();
            generation.staleDuringDispose = false;
          } catch {
            generation.staleDuringDispose = true;
          }
        });
      },
    }],
  });
  t.after(async () => await extensionHost(loader.getExtensions()).close());

  await loader.reload();
  await loader.reload();
  assert.equal(generations.length, 2);
  assert.deepEqual(generations[0], {
    api: generations[0]!.api,
    staleDuringDispose: true,
    disposeCount: 1,
  });
  assert.equal(generations[1]?.disposeCount, 0);
});

test("project trust bootstrap exposes user extensions before project resources", async (t) => {
  const value = await fixture();
  const userExtension = join(value.agentDir, "extensions", "user.ts");
  const projectExtension = join(value.cwd, ".rigyn", "extensions", "project.ts");
  await mkdir(join(value.agentDir, "extensions"), { recursive: true });
  await mkdir(join(value.cwd, ".rigyn", "extensions"), { recursive: true });
  const activationKey = `__rigynTrustActivation${Date.now()}${Math.random().toString(16).slice(2)}`;
  await writeFile(userExtension, `export default (api) => {
    globalThis[${JSON.stringify(activationKey)}] = (globalThis[${JSON.stringify(activationKey)}] ?? 0) + 1;
    api.registerCommand("user", { handler() {} });
  };`);
  await writeFile(projectExtension, `export default (api) => api.registerCommand("project", { handler() {} });`);
  value.settings.setProjectTrusted(true);
  const loader = new DefaultResourceLoader({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
  });
  t.after(async () => await extensionHost(loader.getExtensions()).close());
  let bootstrapCommands: string[] = [];
  await loader.reload({
    async resolveProjectTrust({ extensionsResult }) {
      bootstrapCommands = registeredCommandNames(extensionsResult);
      return true;
    },
  });
  assert.deepEqual(bootstrapCommands, ["user"]);
  assert.deepEqual(registeredCommandNames(loader.getExtensions()).sort(), ["project", "user"]);
  assert.deepEqual(loader.getExtensions().extensions.map((entry) => entry.sourceInfo.scope).sort(), ["project", "user"]);
  assert.equal((globalThis as Record<string, unknown>)[activationKey], 1);
  delete (globalThis as Record<string, unknown>)[activationKey];
});

test("trust bootstrap reapplies project, user, and inline registration precedence without reactivation", async (t) => {
  const value = await fixture();
  const userExtension = join(value.agentDir, "extensions", "user.ts");
  const projectExtension = join(value.cwd, ".rigyn", "extensions", "project.ts");
  await mkdir(join(value.agentDir, "extensions"), { recursive: true });
  await mkdir(join(value.cwd, ".rigyn", "extensions"), { recursive: true });
  const activationKey = `__rigynPrecedenceActivation${Date.now()}${Math.random().toString(16).slice(2)}`;
  const source = (owner: string, count = false): string => `export default (api) => {
    ${count ? `globalThis[${JSON.stringify(activationKey)}] = (globalThis[${JSON.stringify(activationKey)}] ?? 0) + 1;` : ""}
    api.registerTool({
      name: "shared_tool",
      label: "Shared tool",
      description: ${JSON.stringify(owner)},
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute() {
        return Promise.resolve({
          content: [{ type: "text", text: ${JSON.stringify(owner)} }],
          details: {}
        });
      }
    });
    api.registerCommand("shared", { description: ${JSON.stringify(owner)}, handler() {} });
  };`;
  await writeFile(userExtension, source("user", true));
  await writeFile(projectExtension, source("project"));
  let inlineActivations = 0;
  const loader = new DefaultResourceLoader({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    extensionFactories: [{
      name: "inline-precedence",
      factory(api) {
        inlineActivations += 1;
        api.registerTool({
          name: "shared_tool",
          label: "Shared tool",
          description: "inline",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute() {
            return Promise.resolve({
              content: [{ type: "text", text: "inline" }],
              details: {}
            });
          },
        });
        api.registerCommand("shared", { description: "inline", async handler() {} });
      },
    }],
  });
  t.after(async () => {
    await extensionHost(loader.getExtensions()).close();
    delete (globalThis as Record<string, unknown>)[activationKey];
  });

  await loader.reload({ resolveProjectTrust: async () => true });

  const host = extensionHost(loader.getExtensions());
  assert.deepEqual(
    host.extensions().map((entry) => entry.scope),
    ["project", "user", "invocation"],
    JSON.stringify(host.diagnostics()),
  );
  assert.equal(host.tools().find((tool) => tool.definition.name === "shared_tool")?.definition.description, "project");
  assert.deepEqual(host.commands().map((entry) => [entry.name, entry.description, entry.scope]), [
    ["shared:1", "project", "project"],
    ["shared:2", "user", "user"],
    ["shared:3", "inline", "invocation"],
  ]);
  assert.equal((globalThis as Record<string, unknown>)[activationKey], 1);
  assert.equal(inlineActivations, 1);
});

test("a failed trust-bootstrap factory is diagnosed once and not retried in the trusted pass", async (t) => {
  const value = await fixture();
  const extension = join(value.agentDir, "extensions", "failing.ts");
  await mkdir(join(value.agentDir, "extensions"), { recursive: true });
  const activationKey = `__rigynFailedTrustActivation${Date.now()}${Math.random().toString(16).slice(2)}`;
  await writeFile(extension, `export default () => {
    globalThis[${JSON.stringify(activationKey)}] = (globalThis[${JSON.stringify(activationKey)}] ?? 0) + 1;
    throw new Error("expected bootstrap failure");
  };`);
  const loader = new DefaultResourceLoader({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
  });
  t.after(async () => {
    await extensionHost(loader.getExtensions()).close();
    delete (globalThis as Record<string, unknown>)[activationKey];
  });

  await loader.reload({ resolveProjectTrust: async () => true });

  assert.equal((globalThis as Record<string, unknown>)[activationKey], 1);
  assert.equal(extensionHost(loader.getExtensions()).diagnostics().filter((entry) =>
    entry.sourcePath === extension && /expected bootstrap failure/u.test(entry.message)).length, 1);
});

test("reload imports changed TypeScript factories without retaining the module cache", async (t) => {
  const value = await fixture();
  const extension = join(value.root, "fresh.ts");
  await writeFile(extension, `export default (api) => api.registerCommand("first", { handler() {} });`);
  const loader = new DefaultResourceLoader({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    additionalExtensionPaths: [extension],
  });
  t.after(async () => await extensionHost(loader.getExtensions()).close());
  await loader.reload();
  assert.deepEqual(registeredCommandNames(loader.getExtensions()), ["first"]);
  await writeFile(extension, `export default (api) => api.registerCommand("second", { handler() {} });`);
  await loader.reload();
  assert.deepEqual(registeredCommandNames(loader.getExtensions()), ["second"]);
});

test("reload evaluates every changed MJS factory generation from fresh source bytes", async (t) => {
  const value = await fixture();
  const extension = join(value.root, "fresh.mjs");
  const activationKey = `__rigynMjsReload${Date.now()}${Math.random().toString(16).slice(2)}`;
  const source = (generation: string): string => `export default (api) => {
    globalThis[${JSON.stringify(activationKey)}] ??= [];
    globalThis[${JSON.stringify(activationKey)}].push(api);
    api.registerCommand(${JSON.stringify(generation)}, { handler() {} });
  };`;
  await writeFile(extension, source("one"));
  const loader = new DefaultResourceLoader({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    additionalExtensionPaths: [extension],
  });
  t.after(async () => {
    await extensionHost(loader.getExtensions()).close();
    delete (globalThis as Record<string, unknown>)[activationKey];
  });

  await loader.reload();
  const firstApi = ((globalThis as Record<string, unknown>)[activationKey] as Array<{ getAllTools(): unknown }>)[0]!;
  assert.deepEqual(registeredCommandNames(loader.getExtensions()), ["one"]);
  await writeFile(extension, source("two"));
  await loader.reload();
  assert.deepEqual(registeredCommandNames(loader.getExtensions()), ["two"]);
  assert.throws(() => firstApi.getAllTools(), /no longer active|stale/iu);
  await writeFile(extension, source("three"));
  await loader.reload();
  assert.deepEqual(registeredCommandNames(loader.getExtensions()), ["three"]);
  assert.equal(((globalThis as Record<string, unknown>)[activationKey] as unknown[]).length, 3);
});

test("dynamic resources resolve relative to their package and reject boundary escapes", async (t) => {
  const value = await fixture();
  const packageRoot = join(value.root, "dynamic-package");
  const extension = join(packageRoot, "index.mjs");
  await mkdir(join(packageRoot, "prompts"), { recursive: true });
  await writeFile(join(packageRoot, "prompts", "relative.md"), "Relative prompt");
  await writeFile(join(value.root, "outside.md"), "Must not load");
  await writeFile(extension, `export default (api) => {
    api.on("resources_discover", () => ({
      skillPaths: [],
      promptPaths: ["prompts/relative.md", "../outside.md"],
      themePaths: []
    }));
  };`);
  const loader = new DefaultResourceLoader({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    additionalExtensionPaths: [extension],
  });
  t.after(async () => await extensionHost(loader.getExtensions()).close());

  await loader.reload();
  await extensionHost(loader.getExtensions()).dispatch("session_start", { reason: "startup" } as never);
  await loader.extendResourcesFromExtensions(loader.getExtensions().runtime, "startup");

  assert.deepEqual(loader.getPrompts().prompts.map((entry) => entry.name), ["relative"]);
  assert.equal(loader.getPrompts().prompts[0]?.filePath, join(packageRoot, "prompts", "relative.md"));
  assert.equal(extensionHost(loader.getExtensions()).diagnostics().some((entry) =>
    /resource path was ignored/iu.test(entry.message) && /escapes workspace/iu.test(entry.message)), true);
});

test("reload adopts a preloaded trust host without activating its factories twice", async (t) => {
  const value = await fixture();
  const extension = join(value.root, "preloaded.ts");
  const activationKey = `__rigynPreloadedActivation${Date.now()}${Math.random().toString(16).slice(2)}`;
  await writeFile(extension, `export default (api) => {
    globalThis[${JSON.stringify(activationKey)}] = (globalThis[${JSON.stringify(activationKey)}] ?? 0) + 1;
    api.registerCommand("preloaded", { handler() {} });
  };`);
  const host = await loadDirectExtensions([extension], { workspace: value.cwd });
  const loader = new DefaultResourceLoader({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    additionalExtensionPaths: [extension],
    preloadedExtensions: host,
  });
  t.after(async () => {
    await extensionHost(loader.getExtensions()).close();
    delete (globalThis as Record<string, unknown>)[activationKey];
  });

  await loader.reload();

  assert.equal((globalThis as Record<string, unknown>)[activationKey], 1);
  assert.deepEqual(registeredCommandNames(loader.getExtensions()), ["preloaded"]);
});

test("resource name collisions keep the first definition and report the loser", async (t) => {
  const value = await fixture();
  const first = join(value.root, "first", "same.md");
  const second = join(value.root, "second", "same.md");
  await mkdir(join(value.root, "first"));
  await mkdir(join(value.root, "second"));
  await writeFile(first, "First");
  await writeFile(second, "Second");
  const loader = new DefaultResourceLoader({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    additionalPromptTemplatePaths: [first, second],
  });
  t.after(async () => await extensionHost(loader.getExtensions()).close());
  await loader.reload();
  assert.equal(loader.getPrompts().prompts[0]?.content, "First");
  assert.equal(loader.getPrompts().diagnostics[0]?.collision?.loserPath, second);
});

test("configured package filters select the direct factories and companion resources activated by the loader", async (t) => {
  const value = await fixture();
  const packageRoot = join(value.root, "filtered-package");
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await mkdir(join(packageRoot, "prompts"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "filtered-package",
    rigyn: { extensions: ["extensions"], prompts: ["prompts"] },
  }));
  await writeFile(join(packageRoot, "extensions", "one.mjs"),
    `export default (api) => api.registerCommand("one", { handler() {} });`);
  await writeFile(join(packageRoot, "extensions", "two.mjs"),
    `export default (api) => api.registerCommand("two", { handler() {} });`);
  await writeFile(join(packageRoot, "prompts", "kept.md"), "Kept");
  await writeFile(join(packageRoot, "prompts", "hidden.md"), "Hidden");
  value.settings.setPackages([{
    source: packageRoot,
    extensions: ["+extensions/one.mjs", "-extensions/two.mjs"],
    prompts: ["+prompts/kept.md", "-prompts/hidden.md"],
  }]);
  await value.settings.flush();
  const loader = new DefaultResourceLoader({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
  });
  t.after(async () => await extensionHost(loader.getExtensions()).close());

  await loader.reload();

  assert.deepEqual(registeredCommandNames(loader.getExtensions()), ["one"]);
  assert.deepEqual(loader.getPrompts().prompts.map((entry) => entry.name), ["kept"]);
});

test("project resources precede same-named user resources", async (t) => {
  const value = await fixture();
  const userPrompt = join(value.agentDir, "prompts", "same.md");
  const projectPrompt = join(value.cwd, ".rigyn", "prompts", "same.md");
  await mkdir(join(value.agentDir, "prompts"), { recursive: true });
  await mkdir(join(value.cwd, ".rigyn", "prompts"), { recursive: true });
  await writeFile(userPrompt, "User");
  await writeFile(projectPrompt, "Project");
  const loader = new DefaultResourceLoader({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
  });
  t.after(async () => await extensionHost(loader.getExtensions()).close());
  await loader.reload();
  assert.equal(loader.getPrompts().prompts.find((prompt) => prompt.name === "same")?.content, "Project");
  assert.equal(loader.getPrompts().diagnostics[0]?.collision?.loserPath, userPrompt);
});

test("extendResources works before the first reload and expires with that resource generation", async (t) => {
  const value = await fixture();
  const directory = join(value.root, "file url skill");
  const skillFile = join(directory, "SKILL.md");
  await mkdir(directory);
  await writeFile(skillFile, `---\nname: file-url\ndescription: Loaded from URL\n---\nBody`);
  const loader = new DefaultResourceLoader({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
  });
  t.after(async () => await extensionHost(loader.getExtensions()).close());
  loader.extendResources({
    skillPaths: [{
      path: pathToFileURL(directory).href,
      metadata: { source: "extension:file-url", scope: "temporary", origin: "top-level", baseDir: directory },
    }],
  });
  const loaded = loader.getSkills().skills.find((skill) => skill.name === "file-url");
  assert.equal(loaded?.filePath, skillFile);
  assert.equal(loaded?.sourceInfo.source, "extension:file-url");

  await loader.reload();
  assert.equal(loader.getSkills().skills.some((skill) => skill.name === "file-url"), false);
});

test("discovery flags retain explicit skills and suppress context files", async (t) => {
  const value = await fixture();
  const automatic = join(value.agentDir, "skills", "automatic");
  const explicit = join(value.root, "explicit");
  await mkdir(automatic, { recursive: true });
  await mkdir(explicit);
  await writeFile(join(automatic, "SKILL.md"), `---\nname: automatic\ndescription: Automatic\n---\nBody`);
  await writeFile(join(explicit, "SKILL.md"), `---\nname: explicit\ndescription: Explicit\n---\nBody`);
  await writeFile(join(value.agentDir, "AGENTS.md"), "global context");
  await writeFile(join(value.cwd, "AGENTS.md"), "project context");

  const loader = new DefaultResourceLoader({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    noSkills: true,
    noContextFiles: true,
    additionalSkillPaths: [explicit],
  });
  t.after(async () => await extensionHost(loader.getExtensions()).close());
  await loader.reload();

  assert.deepEqual(loader.getSkills().skills.map((skill) => skill.name), ["explicit"]);
  assert.deepEqual(loader.getAgentsFiles(), { agentsFiles: [] });
});

test("untrusted projects cannot activate project resources or project system prompts", async (t) => {
  const value = await fixture();
  const projectRoot = join(value.cwd, ".rigyn");
  const projectSkill = join(projectRoot, "skills", "project-only");
  await mkdir(join(projectRoot, "extensions"), { recursive: true });
  await mkdir(projectSkill, { recursive: true });
  await mkdir(join(projectRoot, "prompts"), { recursive: true });
  await writeFile(join(projectRoot, "extensions", "blocked.ts"), `throw new Error("project extension activated")`);
  await writeFile(join(projectSkill, "SKILL.md"), `---\nname: project-only\ndescription: Project only\n---\nBody`);
  await writeFile(join(projectRoot, "prompts", "project-only.md"), "Project prompt");
  await writeFile(join(projectRoot, "SYSTEM.md"), "project system");
  await writeFile(join(value.agentDir, "SYSTEM.md"), "user system");
  await writeFile(join(value.cwd, "AGENTS.md"), "project context");
  value.settings.setProjectTrusted(false);

  const loader = new DefaultResourceLoader({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
  });
  t.after(async () => await extensionHost(loader.getExtensions()).close());
  await loader.reload();

  assert.deepEqual(loader.getExtensions().extensions, []);
  assert.equal(loader.getSkills().skills.some((skill) => skill.name === "project-only"), false);
  assert.equal(loader.getPrompts().prompts.some((prompt) => prompt.name === "project-only"), false);
  assert.equal(loader.getSystemPrompt(), "user system");
  assert.equal(loader.getAgentsFiles().agentsFiles.some((entry) => entry.content === "project context"), true);
});

test("resource and prompt overrides receive and replace the composed views", async (t) => {
  const value = await fixture();
  const skill = join(value.root, "override-skill");
  await mkdir(skill);
  await writeFile(join(skill, "SKILL.md"), `---\nname: override-skill\ndescription: Override skill\n---\nBody`);
  await writeFile(join(value.agentDir, "SYSTEM.md"), "base system");
  await writeFile(join(value.agentDir, "APPEND_SYSTEM.md"), "base append");
  let skillOverrideCalled = false;

  const loader = new DefaultResourceLoader({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    additionalSkillPaths: [skill],
    skillsOverride(base) {
      skillOverrideCalled = true;
      return { skills: base.skills.filter((entry) => entry.name === "override-skill"), diagnostics: [] };
    },
    agentsFilesOverride: () => ({ agentsFiles: [{ path: "synthetic", content: "synthetic context" }] }),
    systemPromptOverride: (base) => `${base ?? ""} + override`,
    appendSystemPromptOverride: (base) => [...base, "override append"],
  });
  t.after(async () => await extensionHost(loader.getExtensions()).close());
  await loader.reload();

  assert.equal(skillOverrideCalled, true);
  assert.deepEqual(loader.getSkills().skills.map((entry) => entry.name), ["override-skill"]);
  assert.deepEqual(loader.getAgentsFiles().agentsFiles, [{ path: "synthetic", content: "synthetic context" }]);
  assert.equal(loader.getSystemPrompt(), "base system + override");
  assert.deepEqual(loader.getAppendSystemPrompt(), ["base append", "override append"]);
});

test("missing explicit local resources produce typed diagnostics", async (t) => {
  const value = await fixture();
  const missingExtension = join(value.root, "missing-extension.ts");
  const missingSkill = join(value.root, "missing-skill");
  const missingPrompt = join(value.root, "missing-prompt.md");
  const missingTheme = join(value.root, "missing-theme.json");
  const loader = new DefaultResourceLoader({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    additionalExtensionPaths: [missingExtension],
    additionalSkillPaths: [missingSkill],
    additionalPromptTemplatePaths: [missingPrompt],
    additionalThemePaths: [missingTheme],
  });
  t.after(async () => await extensionHost(loader.getExtensions()).close());

  await loader.reload();

  assert.equal(loader.getExtensions().errors.some((entry) =>
    entry.path === missingExtension && /does not exist/iu.test(entry.error)), true);
  assert.deepEqual(loader.getSkills().diagnostics, [{
    type: "error",
    message: "Skill path does not exist",
    path: missingSkill,
  }]);
  assert.deepEqual(loader.getPrompts().diagnostics, [{
    type: "error",
    message: "Prompt template path does not exist",
    path: missingPrompt,
  }]);
  assert.deepEqual(loader.getThemes().diagnostics, [{
    type: "error",
    message: "Theme path does not exist",
    path: missingTheme,
  }]);
});
