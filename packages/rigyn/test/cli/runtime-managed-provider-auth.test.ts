import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRuntime } from "../../src/cli/runtime.js";
import type { ProviderAuthInteraction } from "../../src/providers/models.js";

const providerId = "managed-runtime-provider";

function extensionSource(generation: string): string {
  return `const GENERATION = ${JSON.stringify(generation)};
const OBSERVED_AT = "2026-01-01T00:00:00.000Z";

export default function activate(api) {
  globalThis.__managedRuntimeTrace ??= [];
  api.registerProvider(${JSON.stringify(providerId)}, {
    name: "Managed Runtime Provider",
    api: "openai-chat-completions",
    baseUrl: "https://managed.example.test/v1",
    async *streamSimple(_model, _context, options) {
      options?.signal?.throwIfAborted();
      yield { type: "response_start", model: "managed-model" };
      yield { type: "text_delta", part: 0, text: "managed" };
      yield { type: "response_end", reason: "stop", state: {
        kind: "chat_completions",
        assistantMessage: { role: "assistant", content: "managed" }
      } };
    },
    models: [{
        id: "managed-model",
        name: "Managed " + GENERATION,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 2048
      }],
    oauth: {
      name: "Managed subscription",
      async login(interaction) {
        interaction.onProgress("Signing in through " + GENERATION);
        globalThis.__managedRuntimeTrace.push("login:" + GENERATION);
        return {
          access: "login-access-" + GENERATION,
          refresh: "login-refresh-" + GENERATION,
          expires: Date.now() - 1,
          scopes: ["models.read"],
          accountId: "account-7",
          providerData: { generation: GENERATION }
        };
      },
      async refreshToken(credential) {
        globalThis.__managedRuntimeTrace.push("refresh:" + GENERATION + ":" + credential.providerData?.generation);
        return {
          access: "refresh-access-" + GENERATION,
          refresh: credential.refresh,
          expires: Date.now() + 3600000,
          providerData: { generation: GENERATION }
        };
      },
      getApiKey(credential) {
        globalThis.__managedRuntimeTrace.push("api-key:" + GENERATION);
        return "projected-" + credential.access;
      },
      modifyModels(models, credential) {
        globalThis.__managedRuntimeTrace.push("models:" + GENERATION + ":" + credential.providerData?.generation);
        return models.map((model) => ({
          ...model,
          name: "Managed " + GENERATION
        }));
      }
    }
  });
}
`;
}

function interaction(progress: string[]): ProviderAuthInteraction {
  return {
    signal: new AbortController().signal,
    notify(event) { if (event.type === "progress") progress.push(event.message); },
    async prompt() { return "fixture"; },
  };
}

test("managed provider callbacks refresh, project models, and follow runtime generations", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-managed-auth-"));
  const workspace = join(root, "workspace");
  const configHome = join(root, "config");
  const stateHome = join(root, "state");
  const agentDir = join(root, "agent");
  const extension = join(agentDir, "extensions", "managed-runtime-auth");
  const runtimePath = join(extension, "index.mjs");
  await mkdir(extension, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await chmod(agentDir, 0o700);
  await writeFile(join(extension, "package.json"), JSON.stringify({
    name: "managed-runtime-auth",
    rigyn: { extensions: ["index.mjs"] },
  }));
  await writeFile(runtimePath, extensionSource("generation-one"));

  const previousConfig = process.env.XDG_CONFIG_HOME;
  const previousState = process.env.XDG_STATE_HOME;
  const previousKey = process.env.RIGYN_CREDENTIAL_KEY;
  const previousAgentDir = process.env.RIGYN_CODING_AGENT_DIR;
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.XDG_STATE_HOME = stateHome;
  process.env.RIGYN_CREDENTIAL_KEY = Buffer.alloc(32, 29).toString("base64url");
  process.env.RIGYN_CODING_AGENT_DIR = agentDir;
  (globalThis as Record<string, unknown>).__managedRuntimeTrace = [];
  let runtime: Awaited<ReturnType<typeof loadRuntime>> | undefined;
  try {
    runtime = await loadRuntime({
      workspace,
      ephemeral: true,
      extensions: true,
      extensionRuntime: true,
      skills: false,
      promptTemplates: false,
      themes: false,
    });
    assert.deepEqual(runtime.runtimeExtensions.diagnostics(), []);
    const firstModelRegistry = runtime.modelRegistry;
    const firstProviders = runtime.providers;
    const firstSignal = runtime.generationSignal;
    const firstProgress: string[] = [];
    await runtime.modelRegistry.models().login(
      providerId,
      "oauth",
      interaction(firstProgress),
    );
    assert.equal((await runtime.modelRegistry.getProviderAuth(providerId))?.auth.apiKey, "projected-refresh-access-generation-one");
    await runtime.providers.refreshModels(providerId, new AbortController().signal);
    const firstCatalog = await runtime.providers.listModels(providerId, new AbortController().signal);
    assert.deepEqual(firstProgress, ["Signing in through generation-one"]);
    assert.deepEqual(firstCatalog.map((model) => ({
      id: model.id,
      displayName: model.displayName,
    })), [{
      id: "managed-model",
      displayName: "Managed generation-one",
    }]);

    await writeFile(runtimePath, extensionSource("generation-two"));
    await runtime.reload();
    assert.equal(firstSignal.aborted, true);
    assert.equal(firstModelRegistry.getProvider(providerId), undefined);
    assert.equal(firstProviders.has(providerId), false);
    const secondModelRegistry = runtime.modelRegistry;
    const secondProviders = runtime.providers;
    const secondSignal = runtime.generationSignal;
    const secondProgress: string[] = [];
    assert.equal(runtime.modelRegistry.getProvider(providerId)?.getModels()[0]?.name, "Managed generation-two");
    await runtime.modelRegistry.models().login(
      providerId,
      "oauth",
      interaction(secondProgress),
    );
    assert.equal((await runtime.modelRegistry.getProviderAuth(providerId))?.auth.apiKey, "projected-refresh-access-generation-two");
    await runtime.providers.refreshModels(providerId, new AbortController().signal);
    const secondCatalog = await runtime.providers.listModels(providerId, new AbortController().signal);
    assert.deepEqual(secondProgress, ["Signing in through generation-two"]);
    assert.equal(secondCatalog[0]?.displayName, "Managed generation-two");

    const trace = (globalThis as Record<string, unknown>).__managedRuntimeTrace as string[];
    assert.ok(trace.includes("login:generation-one"));
    assert.ok(trace.includes("refresh:generation-one:generation-one"));
    assert.ok(trace.includes("models:generation-one:generation-one"));
    assert.ok(trace.includes("login:generation-two"));
    assert.ok(trace.includes("refresh:generation-two:generation-two"));
    assert.ok(trace.includes("models:generation-two:generation-two"));

    await writeFile(runtimePath, extensionSource("generation-three"));
    await runtime.reload();
    assert.equal(secondSignal.aborted, true);
    assert.equal(secondModelRegistry.getProvider(providerId), undefined);
    assert.equal(secondProviders.has(providerId), false);
    assert.equal(runtime.modelRegistry.getProvider(providerId)?.getModels()[0]?.name, "Managed generation-three");
    assert.equal(runtime.providers.has(providerId), true);
    assert.deepEqual(runtime.runtimeExtensions.diagnostics(), []);

    await runtime.close();
    assert.equal(runtime.modelRegistry.getProvider(providerId), undefined);
    assert.equal(runtime.providers.has(providerId), false);
    runtime = undefined;
  } finally {
    await runtime?.close().catch(() => undefined);
    delete (globalThis as Record<string, unknown>).__managedRuntimeTrace;
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
