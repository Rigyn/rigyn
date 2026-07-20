import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ProviderManagedAuthInteraction } from "../../src/auth/index.js";
import { loadRuntime } from "../../src/cli/runtime.js";

const providerId = "managed-runtime-provider";
const credentialId = "managed-runtime-account";

function extensionSource(generation: string): string {
  return `const GENERATION = ${JSON.stringify(generation)};
const OBSERVED_AT = "2026-01-01T00:00:00.000Z";

export default function activate(api) {
  globalThis.__managedRuntimeTrace ??= [];
  api.registerProvider({
    id: ${JSON.stringify(providerId)},
    async *stream(_request, signal) {
      signal.throwIfAborted();
      yield { type: "response_start", model: "managed-model" };
      yield { type: "text_delta", part: 0, text: "managed" };
      yield { type: "response_end", reason: "stop", state: {
        kind: "chat_completions",
        assistantMessage: { role: "assistant", content: "managed" }
      } };
    },
    async listModels(signal) {
      signal.throwIfAborted();
      return [{
        id: "managed-model",
        provider: ${JSON.stringify(providerId)},
        capabilities: {
          tools: { value: "unknown", source: "provider", observedAt: OBSERVED_AT },
          reasoning: { value: "unknown", source: "provider", observedAt: OBSERVED_AT },
          images: { value: "unknown", source: "provider", observedAt: OBSERVED_AT }
        }
      }];
    }
  });
  api.registerProviderAuth({
    provider: ${JSON.stringify(providerId)},
    credentialId: ${JSON.stringify(credentialId)},
    displayName: "Managed Runtime Provider",
    methods: [{
      kind: "managed_oauth",
      id: "subscription",
      label: "Managed subscription",
      async login(interaction) {
        await interaction.showProgress("Signing in through " + GENERATION);
        globalThis.__managedRuntimeTrace.push("login:" + GENERATION);
        return {
          accessToken: "login-access-" + GENERATION,
          refreshToken: "login-refresh-" + GENERATION,
          expiresAt: Date.now() + 60000,
          scopes: ["models.read"],
          accountId: "account-7",
          providerData: { generation: GENERATION }
        };
      },
      async refresh(credential, signal) {
        signal.throwIfAborted();
        globalThis.__managedRuntimeTrace.push("refresh:" + GENERATION + ":" + credential.providerData?.generation);
        return {
          accessToken: "refresh-access-" + GENERATION,
          expiresAt: Date.now() + 3600000,
          providerData: { generation: GENERATION }
        };
      },
      getApiKey(credential) {
        globalThis.__managedRuntimeTrace.push("api-key:" + GENERATION);
        return "projected-" + credential.accessToken;
      },
      modifyModels(models, credential, signal) {
        signal.throwIfAborted();
        globalThis.__managedRuntimeTrace.push("models:" + GENERATION + ":" + credential.providerData?.generation);
        return models.map((model) => ({
          ...model,
          displayName: "Managed " + GENERATION,
          metadata: { generation: GENERATION, account: credential.accountId ?? "none" }
        }));
      }
    }],
    request: {
      origins: ["https://managed.example.test"],
      apiKey: { header: "x-api-key" }
    }
  });
}
`;
}

function interaction(progress: string[]): ProviderManagedAuthInteraction {
  return {
    signal: new AbortController().signal,
    showAuthorization() {},
    showDeviceCode() {},
    showProgress(message) { progress.push(message); },
    async prompt() { return "fixture"; },
    async select(input) { return input.options[0]?.id; },
  };
}

test("managed provider callbacks refresh, project models, and follow runtime generations", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-managed-auth-"));
  const workspace = join(root, "workspace");
  const configHome = join(root, "config");
  const stateHome = join(root, "state");
  const extension = join(configHome, "rigyn", "extensions", "managed-runtime-auth");
  const runtimePath = join(extension, "runtime", "index.mjs");
  await mkdir(join(extension, "runtime"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await chmod(join(configHome, "rigyn"), 0o700);
  await writeFile(join(extension, "extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "managed-runtime-auth",
    name: "Managed runtime auth fixture",
    permissions: { credentialAccess: true },
    contributions: { runtime: [{ path: "runtime/index.mjs" }] },
  }));
  await writeFile(runtimePath, extensionSource("generation-one"));

  const previousConfig = process.env.XDG_CONFIG_HOME;
  const previousState = process.env.XDG_STATE_HOME;
  const previousKey = process.env.RIGYN_CREDENTIAL_KEY;
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.XDG_STATE_HOME = stateHome;
  process.env.RIGYN_CREDENTIAL_KEY = Buffer.alloc(32, 29).toString("base64url");
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
    const firstAuth = runtime.auth;
    const firstProviders = runtime.providers;
    const firstSignal = runtime.generationSignal;
    const firstProgress: string[] = [];
    const firstCredential = await runtime.auth.authorizeManaged(
      providerId,
      "subscription",
      interaction(firstProgress),
    );
    await runtime.auth.storeCredential(providerId, firstCredential);
    await runtime.providers.refreshModels(providerId, new AbortController().signal);
    const firstModels = await runtime.providers.listModels(providerId, new AbortController().signal);
    assert.deepEqual(firstProgress, ["Signing in through generation-one"]);
    assert.deepEqual(firstModels.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      metadata: model.metadata,
    })), [{
      id: "managed-model",
      displayName: "Managed generation-one",
      metadata: { generation: "generation-one", account: "account-7" },
    }]);

    await writeFile(runtimePath, extensionSource("generation-two"));
    await runtime.reload();
    assert.equal(firstSignal.aborted, true);
    assert.equal(firstAuth.has(providerId), false);
    assert.equal(firstProviders.has(providerId), false);
    const secondAuth = runtime.auth;
    const secondProviders = runtime.providers;
    const secondSignal = runtime.generationSignal;
    const secondProgress: string[] = [];
    const secondCredential = await runtime.auth.authorizeManaged(
      providerId,
      "subscription",
      interaction(secondProgress),
    );
    await runtime.auth.storeCredential(providerId, secondCredential);
    await runtime.providers.refreshModels(providerId, new AbortController().signal);
    const secondModels = await runtime.providers.listModels(providerId, new AbortController().signal);
    assert.deepEqual(secondProgress, ["Signing in through generation-two"]);
    assert.equal(secondModels[0]?.displayName, "Managed generation-two");
    assert.deepEqual(secondModels[0]?.metadata, { generation: "generation-two", account: "account-7" });

    const trace = (globalThis as Record<string, unknown>).__managedRuntimeTrace as string[];
    assert.ok(trace.includes("login:generation-one"));
    assert.ok(trace.includes("refresh:generation-one:generation-one"));
    assert.ok(trace.includes("models:generation-one:generation-one"));
    assert.ok(trace.includes("login:generation-two"));
    assert.ok(trace.includes("refresh:generation-two:generation-two"));
    assert.ok(trace.includes("models:generation-two:generation-two"));

    await runtime.close();
    assert.equal(secondSignal.aborted, true);
    assert.equal(secondAuth.has(providerId), false);
    assert.equal(secondProviders.has(providerId), false);
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
    await rm(root, { recursive: true, force: true });
  }
});
