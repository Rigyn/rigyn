import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRuntime } from "../../src/cli/runtime.js";
import type { RuntimeCommandUi } from "../../src/extensions/runtime.js";

function commandUi(): RuntimeCommandUi {
  return {
    notify() {},
    setStatus() {},
    setWidget() {},
    setHeader() {},
    setFooter() {},
    setWorkingMessage() {},
    setWorkingVisible() {},
    setTitle() {},
    async getTheme() { return { name: "dark", available: ["dark"] }; },
    async setTheme(name) { return { name, available: [name] }; },
    async select(_prompt, options) { return options[0]!.value; },
    async confirm() { return true; },
    async input() { return undefined; },
    async editor() { return undefined; },
    setEditorText() {},
    getEditorText() { return ""; },
    async custom<T>(): Promise<T | undefined> { return undefined; },
    showOverlay(): never { throw new Error("overlay not used"); },
  };
}

test("trusted provider overlays retain host ownership and restore on runtime close", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-provider-overlay-"));
  const workspace = join(root, "workspace");
  const configHome = join(root, "config");
  const stateHome = join(root, "state");
  const agentDir = join(root, "agent");
  const extension = join(agentDir, "extensions", "provider-overlay");
  const modelCatalog = join(agentDir, "models.json");
  const observedAt = "2026-07-20T00:00:00.000Z";
  await mkdir(extension, { recursive: true });
  await chmod(agentDir, 0o700);
  await mkdir(workspace, { recursive: true });
  await writeFile(modelCatalog, JSON.stringify({
    version: 1,
    savedAt: observedAt,
    providers: [{
      provider: "ollama",
      provenance: "live",
      fetchedAt: observedAt,
      models: [{
        id: "builtin-model",
        provider: "ollama",
        capabilities: {
          tools: { value: "unknown", source: "provider", observedAt },
          reasoning: { value: "unknown", source: "provider", observedAt },
          images: { value: "unknown", source: "provider", observedAt },
        },
        compatibility: {
          protocolFamily: { value: "ollama-chat", source: "provider", observedAt },
        },
      }],
    }],
  }));
  await writeFile(join(extension, "package.json"), JSON.stringify({
    name: "provider-overlay",
    rigyn: { extensions: ["index.mjs"] },
  }));
  await writeFile(join(extension, "index.mjs"), `
export default function activate(api) {
  const config = {
    name: "Local Overlay",
    api: "openai-chat-completions",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "local-test",
    models: [{
      id: "overlay-model",
      name: "Overlay model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 2048
    }]
  };
  api.registerProvider("ollama", config);
  api.registerCommand("overlay-unregister", {
    handler(_args, context) { context.modelRegistry.unregisterProvider("ollama"); }
  });
  api.registerCommand("overlay-register", {
    handler(_args, context) { context.modelRegistry.registerProvider("ollama", config); }
  });
}
`);

  const previousConfig = process.env.XDG_CONFIG_HOME;
  const previousState = process.env.XDG_STATE_HOME;
  const previousKey = process.env.RIGYN_CREDENTIAL_KEY;
  const previousAgentDir = process.env.RIGYN_CODING_AGENT_DIR;
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.XDG_STATE_HOME = stateHome;
  process.env.RIGYN_CREDENTIAL_KEY = Buffer.alloc(32, 17).toString("base64url");
  process.env.RIGYN_CODING_AGENT_DIR = agentDir;
  try {
    const runtime = await loadRuntime({
      workspace,
      ephemeral: true,
      extensions: true,
      extensionRuntime: true,
      skills: false,
      promptTemplates: false,
      themes: false,
      offline: true,
    });
    const overlayAdapter = runtime.providers.get("ollama");
    try {
      assert.equal(runtime.auth.binding("ollama").displayName, "Local Overlay");
      await runtime.providers.refreshModels("ollama", new AbortController().signal);
      assert.deepEqual(
        (await runtime.providers.listModels("ollama", new AbortController().signal)).map((model) => model.id),
        ["overlay-model"],
      );
      await runtime.session.bindExtensions({ mode: "print" });
      const commandInput = {
        args: "",
        threadId: runtime.session.sessionId,
        branch: runtime.sessionManager.getLeafId() ?? "root",
        signal: new AbortController().signal,
        ui: commandUi(),
      };
      assert.deepEqual(await runtime.runtimeExtensions.runCommand("overlay-unregister", commandInput), { handled: true });
      assert.equal(runtime.auth.binding("ollama").displayName, "Ollama");
      assert.equal(runtime.modelRegistry.find("ollama", "overlay-model"), undefined);
      assert.equal(runtime.modelRegistry.find("ollama", "builtin-model")?.id, "builtin-model");
      await runtime.providers.refreshModels("ollama", new AbortController().signal);
      assert.equal(runtime.providers.getModels("ollama").some((model) => model.id === "overlay-model"), false);
      assert.equal(runtime.providers.getModels("ollama").some((model) => model.id === "builtin-model"), true);
      assert.deepEqual(await runtime.runtimeExtensions.runCommand("overlay-register", commandInput), { handled: true });
      assert.equal(runtime.auth.binding("ollama").displayName, "Local Overlay");
      assert.equal(runtime.modelRegistry.find("ollama", "overlay-model")?.id, "overlay-model");
      await runtime.providers.refreshModels("ollama", new AbortController().signal);
      assert.equal(runtime.providers.getModels("ollama").some((model) => model.id === "overlay-model"), true);
      const activeCatalog = await readFile(modelCatalog, "utf8");
      assert.match(activeCatalog, /overlay-model/u);
      await assert.rejects(
        runtime.reload({
          prepareExtensions() {
            throw new Error("candidate rejected");
          },
        }),
        /candidate rejected/u,
      );
      assert.equal(runtime.auth.binding("ollama").displayName, "Local Overlay");
      assert.equal(await readFile(modelCatalog, "utf8"), activeCatalog);
      assert.deepEqual(
        (await runtime.providers.listModels("ollama", new AbortController().signal)).map((model) => model.id),
        ["overlay-model"],
      );
      await writeFile(join(extension, "index.mjs"), `
export default function activate(api) {
  api.registerProvider("ollama", {
    name: "Reloaded Overlay",
    api: "openai-chat-completions",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "local-test",
    models: [{
      id: "reloaded-model",
      name: "Reloaded model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 2048
    }]
  });
}
`);
      assert.deepEqual((await runtime.reload()).warnings, []);
      assert.equal(runtime.auth.binding("ollama").displayName, "Reloaded Overlay");
      await runtime.providers.refreshModels("ollama", new AbortController().signal);
      assert.deepEqual(
        (await runtime.providers.listModels("ollama", new AbortController().signal)).map((model) => model.id),
        ["reloaded-model"],
      );
      await writeFile(join(extension, "index.mjs"), "export default function activate() {}\n");
      assert.deepEqual((await runtime.reload()).warnings, []);
      assert.equal(runtime.auth.binding("ollama").displayName, "Ollama");
      assert.notEqual(runtime.providers.get("ollama"), overlayAdapter);
      assert.equal(runtime.providers.getModels("ollama").some((model) => model.id === "reloaded-model"), false);
      assert.equal(runtime.providers.getModels("ollama").some((model) => model.id === "builtin-model"), true);
      assert.equal(runtime.modelRegistry.find("ollama", "reloaded-model"), undefined);
      assert.equal(runtime.modelRegistry.find("ollama", "builtin-model")?.id, "builtin-model");
      const restoredCatalog = JSON.parse(await readFile(modelCatalog, "utf8")) as {
        providers: Array<{ provider: string; models: Array<{ id: string }> }>;
      };
      assert.deepEqual(
        restoredCatalog.providers.find((provider) => provider.provider === "ollama")?.models.map((model) => model.id),
        ["builtin-model"],
      );
    } finally {
      await runtime.close();
    }
    assert.equal(runtime.auth.binding("ollama").displayName, "Ollama");
    assert.notEqual(runtime.providers.get("ollama"), overlayAdapter);
  } finally {
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    if (previousKey === undefined) delete process.env.RIGYN_CREDENTIAL_KEY;
    else process.env.RIGYN_CREDENTIAL_KEY = previousKey;
    if (previousAgentDir === undefined) delete process.env.RIGYN_CODING_AGENT_DIR;
    else process.env.RIGYN_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
