import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { OPENROUTER_KEY_EXCHANGE_ENDPOINT } from "../../src/auth/openrouter.js";
import type { ResourceLoader } from "../../src/core/resource-loader.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { loginInteractively } from "../../src/cli/main.js";
import { loadRuntime } from "../../src/cli/runtime.js";
import { createExtensionRuntime } from "../../src/extensions/compat.js";
import { InteractiveMode } from "../../src/modes/interactive-mode.js";
import { builtinModels, builtinProviders } from "../../src/providers/all.js";
import { ModelRuntime } from "../../src/providers/model-compat.js";
import { ModelRegistry } from "../../src/providers/model-registry.js";
import { createModels, InMemoryProviderCredentialStore } from "../../src/providers/models.js";
import { openRouterBrowserAccount } from "../../src/providers/openrouter-browser-auth.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { AgentSession } from "../../src/service/agent-session.js";
import { AgentSessionRuntime } from "../../src/service/agent-session-runtime.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import { TuiController } from "../../src/tui/controller.js";
import { InMemoryCredentialStore } from "../helpers/credential-store.js";

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function browserLoginProviders(providers: ReadonlyArray<{
  id: string;
  auth: { providerAccount?: { login?: unknown } };
}>): string[] {
  return providers
    .filter((provider) => typeof provider.auth.providerAccount?.login === "function")
    .map((provider) => provider.id)
    .sort();
}

function oauthLoginProviders(providers: ReadonlyArray<{
  id: string;
  auth: { oauth?: { login?: unknown } };
}>): string[] {
  return providers
    .filter((provider) => typeof provider.auth.oauth?.login === "function")
    .map((provider) => provider.id)
    .sort();
}

test("OpenRouter direct browser auth reuses the bounded PKCE loopback exchange", async () => {
  let exchangeBody: Record<string, unknown> | undefined;
  const account = openRouterBrowserAccount({
    fetch: async (input, init) => {
      assert.equal(String(input), OPENROUTER_KEY_EXCHANGE_ENDPOINT);
      exchangeBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ key: "openrouter-browser-test-key" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const credential = await account.login({
    async prompt() { throw new Error("OpenRouter browser login must not prompt for a client secret"); },
    async notify(event) {
      assert.equal(event.type, "auth_url");
      if (event.type !== "auth_url") return;
      const authorization = new URL(event.url);
      assert.equal(authorization.origin, "https://openrouter.ai");
      assert.equal(authorization.searchParams.has("client_id"), false);
      assert.equal(authorization.searchParams.has("client_secret"), false);
      const callbackValue = authorization.searchParams.get("callback_url");
      assert.notEqual(callbackValue, null);
      const callback = new URL(callbackValue!);
      callback.searchParams.set("code", "openrouter-browser-code");
      const response = await globalThis.fetch(callback);
      assert.equal(response.status, 200);
    },
  });

  assert.equal(exchangeBody?.code, "openrouter-browser-code");
  assert.equal(exchangeBody?.code_challenge_method, "S256");
  assert.equal(typeof exchangeBody?.code_verifier, "string");
  assert.deepEqual(credential, {
    type: "api_key",
    key: "openrouter-browser-test-key",
  });
});

test("OpenRouter direct browser auth is owned by the runtime lifecycle signal", async () => {
  const lifecycle = new AbortController();
  const account = openRouterBrowserAccount({ signal: lifecycle.signal });
  await assert.rejects(account.login({
    async prompt() { throw new Error("unexpected prompt"); },
    notify() { lifecycle.abort(new Error("runtime generation closed")); },
  }), /runtime generation closed/u);
});

test("empty-environment built-ins expose native account login and clientless OpenRouter login", () => {
  const providers = builtinProviders({});
  assert.deepEqual(browserLoginProviders(providers), ["openrouter"]);
  assert.deepEqual(oauthLoginProviders(providers), ["anthropic", "github-copilot", "kimi-code", "openai-codex", "xai"]);
  assert.equal(providers.find((provider) => provider.id === "openrouter")?.auth.providerAccount?.loginLabel, "Sign in with OpenRouter");
});

test("ModelRuntime discovery exposes the OpenRouter provider-account login", async (t) => {
  const models = createModels({ credentials: new InMemoryProviderCredentialStore() });
  for (const provider of builtinProviders({})) models.setProvider(provider);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    models,
    modelsPath: null,
  });
  t.after(() => runtime.close());

  assert.deepEqual(browserLoginProviders(runtime.getProviders()), ["openrouter"]);
  assert.deepEqual(browserLoginProviders(runtime.models().getProviders()), ["openrouter"]);
  assert.deepEqual(oauthLoginProviders(runtime.getProviders()), ["anthropic", "github-copilot", "kimi-code", "openai-codex", "xai"]);
  assert.deepEqual(oauthLoginProviders(runtime.models().getProviders()), ["anthropic", "github-copilot", "kimi-code", "openai-codex", "xai"]);
  assert.equal(typeof runtime.getProvider("openrouter")?.auth.providerAccount?.login, "function");
});

test("closing owned built-in models cancels a pending OpenRouter browser login", async () => {
  const models = builtinModels({ credentials: new InMemoryProviderCredentialStore() });
  const login = models.getProvider("openrouter")!.auth.providerAccount!.login({
    async prompt() { throw new Error("unexpected prompt"); },
    notify() { void models.close(); },
  });
  await assert.rejects(login, /Built-in model resources are closed/u);
  await models.close();
});

test("public InteractiveMode bare /login reaches OpenRouter in an empty auth environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-openrouter-interactive-"));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  await mkdir(workspace);
  await mkdir(agentDirectory);

  const credentials = new InMemoryProviderCredentialStore();
  const directModels = createModels({ credentials });
  for (const provider of builtinProviders({})) directModels.setProvider(provider);
  const openRouter = directModels.getProvider("openrouter");
  assert.notEqual(openRouter?.auth.providerAccount?.login, undefined);
  let loginCalls = 0;
  openRouter!.auth.providerAccount!.login = async () => {
    loginCalls += 1;
    return {
      type: "api_key",
      key: "openrouter-interactive-test-key",
    };
  };

  const modelRegistry = new ModelRegistry(directModels);
  await modelRegistry.refresh({ allowNetwork: false });
  const extensionRuntime = createExtensionRuntime();
  const extensionsResult = { extensions: [], errors: [], runtime: extensionRuntime };
  const loader: ResourceLoader = {
    async refresh() {},
    extendResources() {},
    getAppendSystemPrompt: () => [],
    getSystemPrompt: () => undefined,
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getExtensions: () => extensionsResult,
  };
  const session = await AgentSession.create({
    sessionManager: SessionManager.inMemory(workspace),
    providers: new ProviderRegistry(),
    modelRegistry,
    resourceLoader: loader,
    extensionsResult,
    workspace,
    agentDirectory,
    settingsManager: SettingsManager.inMemory(),
    initialToolSelection: { names: [] },
  });
  const runtime = new AgentSessionRuntime(
    session,
    { cwd: workspace, agentDir: agentDirectory },
    async () => { throw new Error("fixture does not replace sessions"); },
  );
  const input = new PassThrough();
  const output = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
  output.columns = 100;
  output.rows = 30;
  output.isTTY = false;
  const terminal = new TuiController({ input, output, mode: "accessible", handleSignals: false });
  const prompts: Array<{ message: string; values: unknown[] }> = [];
  terminal.choose = async (message, choices) => {
    prompts.push({ message, values: choices.map((choice) => choice.value) });
    if (message === "Select authentication method") {
      return choices.find((choice) => choice.value === "subscription")!.value;
    }
    if (message === "Select provider") {
      return choices.find((choice) =>
        typeof choice.value === "object" && choice.value !== null && "id" in choice.value
        && choice.value.id === "openrouter")!.value;
    }
    throw new Error(`Unexpected prompt: ${message}`);
  };
  const notifications: string[] = [];
  const notify = terminal.notify.bind(terminal);
  terminal.notify = (message, kind = "status") => {
    notifications.push(message);
    notify(message, kind);
  };
  const mode = new InteractiveMode(runtime, { terminal });

  try {
    const running = mode.run();
    input.write("/login\r");
    await waitFor(
      () => notifications.some((message) => message === "Connected OpenRouter. Use /model to choose a model."),
      "bare /login did not connect the empty-environment OpenRouter browser provider",
    );
    assert.equal(loginCalls, 1);
    assert.deepEqual(prompts.map(({ message }) => message), [
      "Select authentication method",
      "Select provider",
    ]);
    assert.deepEqual(await credentials.read("openrouter"), {
      type: "api_key",
      key: "openrouter-interactive-test-key",
    });
    mode.stop();
    await running;
  } finally {
    mode.stop();
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI runtime direct providers preserve OpenRouter login for embedded and refreshed sessions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-openrouter-runtime-"));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  await mkdir(workspace);
  await mkdir(agentDirectory);
  t.after(() => rm(root, { recursive: true, force: true }));

  const credentialStore = new InMemoryCredentialStore();
  const runtime = await loadRuntime({
    workspace,
    agentDirectory,
    credentialStore,
    projectTrusted: false,
    ephemeral: true,
    offline: true,
    deferModelNetworkRefresh: true,
    extensions: false,
    extensionRuntime: false,
    skills: false,
    promptTemplates: false,
    themes: false,
  });
  t.after(() => runtime.close());

  assert.equal(browserLoginProviders(runtime.modelRegistry.models().getProviders()).includes("openrouter"), true);
  assert.equal(typeof runtime.modelRegistry.getProvider("openrouter")?.auth.providerAccount?.login, "function");

  let exchanged = false;
  (runtime.network as { fetch: typeof globalThis.fetch }).fetch = async (input) => {
    assert.equal(String(input), OPENROUTER_KEY_EXCHANGE_ENDPOINT);
    exchanged = true;
    return new Response(JSON.stringify({ key: "openrouter-cli-test-key" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const input = new PassThrough();
  const output = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
  output.columns = 100;
  output.rows = 30;
  output.isTTY = false;
  const terminal = new TuiController({ input, output, mode: "accessible", handleSignals: false });
  terminal.choose = async (message, choices) => {
    if (message === "Select authentication method") {
      return choices.find((choice) => choice.value === "subscription")!.value;
    }
    if (message === "Select provider") {
      return choices.find((choice) => choice.value === "openrouter")!.value;
    }
    throw new Error(`Unexpected prompt: ${message}`);
  };
  const notify = terminal.notify.bind(terminal);
  terminal.notify = (message, kind = "status") => {
    notify(message, kind);
    const value = message.split("\n").at(-1);
    if (value === undefined || !value.startsWith("https://openrouter.ai/")) return;
    const authorization = new URL(value);
    const callback = new URL(authorization.searchParams.get("callback_url")!);
    callback.searchParams.set("code", "openrouter-cli-code");
    void globalThis.fetch(callback);
  };

  assert.equal(await loginInteractively(runtime, terminal, undefined, undefined, true), "openrouter");
  assert.equal(exchanged, true);
  assert.deepEqual(await credentialStore.read("openrouter"), {
    kind: "api_key",
    provider: "openrouter",
    apiKey: "openrouter-cli-test-key",
  });
  terminal.close();
  await runtime.refresh();
  assert.equal(browserLoginProviders(runtime.modelRegistry.models().getProviders()).includes("openrouter"), true);
});
