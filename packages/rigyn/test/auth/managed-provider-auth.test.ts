import assert from "node:assert/strict";
import test from "node:test";

import {
  ManagedProviderAuthDirectory,
  normalizeManagedOAuthCredential,
  ProviderAuthRegistry,
  type AuthCredential,
  type CredentialStore,
  type ProviderManagedAuthInteraction,
  type ProviderManagedOAuthAuthMethod,
} from "../../src/auth/index.js";
import type { ModelInfo } from "../../src/core/types.js";

class MemoryCredentialStore implements CredentialStore {
  readonly values = new Map<string, AuthCredential>();

  async read(id: string): Promise<AuthCredential | undefined> { return this.values.get(id); }
  async write(id: string, credential: AuthCredential): Promise<void> { this.values.set(id, credential); }
  async delete(id: string): Promise<void> { this.values.delete(id); }
  async withLock<T>(_id: string, operation: () => Promise<T>): Promise<T> { return await operation(); }
}

const observedAt = "2026-01-01T00:00:00.000Z";

function model(id: string): ModelInfo {
  return {
    id,
    provider: "managed-provider",
    capabilities: {
      tools: { value: "unknown", source: "provider", observedAt },
      reasoning: { value: "unknown", source: "provider", observedAt },
      images: { value: "unknown", source: "provider", observedAt },
    },
  };
}

function interaction(signal = new AbortController().signal): ProviderManagedAuthInteraction {
  return {
    signal,
    showAuthorization() {},
    showDeviceCode() {},
    showProgress() {},
    async prompt() { return "fixture"; },
    async select(input) { return input.options[0]?.id; },
  };
}

test("managed provider login is discoverable and normalized behind the registry", async () => {
  const store = new MemoryCredentialStore();
  const registry = new ProviderAuthRegistry({
    bindings: [{
      providerId: "managed-provider",
      credentialId: "managed-account",
      displayName: "Managed Provider",
      externallyManaged: true,
    }],
    store,
    environment: {},
  });
  const selectedInteraction = interaction();
  let receivedInteraction: ProviderManagedAuthInteraction | undefined;
  const cleanup = registry.registerDescriptor("managed-extension", {
    provider: "managed-provider",
    credentialId: "managed-account",
    methods: [{
      kind: "managed_oauth",
      id: "subscription",
      label: "Managed subscription",
      detail: "Provider-owned sign-in",
      async login(received) {
        receivedInteraction = received;
        return {
          accessToken: "managed-login-access",
          refreshToken: "managed-login-refresh",
          expiresAt: Date.now() + 60_000,
          scopes: ["models.read"],
          accountId: "account-7",
          subject: "person@example.test",
          providerData: { tenant: "west" },
        };
      },
      async refresh(credential) { return credential; },
    }],
  });

  assert.deepEqual(await registry.loginMethods("managed-provider"), [{
    id: "managed:subscription",
    kind: "managed_oauth",
    label: "Managed subscription",
    detail: "Provider-owned sign-in",
    methodId: "subscription",
  }]);
  const credential = await registry.authorizeManaged("managed-provider", "subscription", selectedInteraction);
  assert.equal(receivedInteraction, selectedInteraction);
  assert.deepEqual(credential, {
    kind: "oauth",
    provider: "managed-account",
    accessToken: "managed-login-access",
    refreshToken: "managed-login-refresh",
    expiresAt: credential.expiresAt,
    tokenType: "Bearer",
    scopes: ["models.read"],
    accountId: "account-7",
    subject: "person@example.test",
    providerData: { tenant: "west", managedFlow: "subscription" },
  });

  cleanup();
  await assert.rejects(
    registry.authorizeManaged("managed-provider", "subscription", selectedInteraction),
    /not registered/u,
  );
});

test("managed credential normalization preserves refresh identity and rejects unsafe results", () => {
  const previous = normalizeManagedOAuthCredential("managed-account", "subscription", {
    accessToken: "first-access",
    refreshToken: "first-refresh",
    expiresAt: Date.now() + 60_000,
    scopes: ["models.read"],
    accountId: "account-7",
    subject: "person@example.test",
  });
  const next = normalizeManagedOAuthCredential("managed-account", "subscription", {
    accessToken: "second-access",
    expiresAt: Date.now() + 120_000,
  }, previous);
  assert.equal(next.refreshToken, "first-refresh");
  assert.deepEqual(next.scopes, ["models.read"]);
  assert.equal(next.accountId, "account-7");
  assert.equal(next.subject, "person@example.test");
  assert.deepEqual(next.providerData, { managedFlow: "subscription" });

  assert.throws(() => normalizeManagedOAuthCredential("managed-account", "subscription", {
    accessToken: "missing-refresh",
    expiresAt: Date.now() + 60_000,
  }), /must return a refresh token/u);
  assert.throws(() => normalizeManagedOAuthCredential("managed-account", "subscription", {
    accessToken: "expired-access",
    refreshToken: "expired-refresh",
    expiresAt: Date.now() - 1,
  }), /expired credential/u);
  assert.throws(() => normalizeManagedOAuthCredential("managed-account", "subscription", {
    accessToken: "bad provider data",
    refreshToken: "invalid-refresh",
    expiresAt: Date.now() + 60_000,
    providerData: { accessToken: "must-not-survive" },
  }), /invalid or unsupported shape/u);
});

test("managed refresh, API-key projection, and credential-conditioned models are detached", async () => {
  const directory = new ManagedProviderAuthDirectory();
  const original = normalizeManagedOAuthCredential("managed-account", "subscription", {
    accessToken: "first-access",
    refreshToken: "first-refresh",
    expiresAt: Date.now() + 60_000,
    scopes: ["models.read"],
    accountId: "account-7",
    providerData: { tenant: "west" },
  });
  let refreshInput: unknown;
  let projectedInput: unknown;
  let modelInput: readonly ModelInfo[] | undefined;
  const method: ProviderManagedOAuthAuthMethod = {
    kind: "managed_oauth",
    id: "subscription",
    async login() { throw new Error("not used"); },
    async refresh(credential) {
      refreshInput = credential;
      return {
        accessToken: "second-access",
        expiresAt: Date.now() + 120_000,
        providerData: { cycle: "two" },
      };
    },
    getApiKey(credential) {
      projectedInput = credential;
      return `projected:${credential.accessToken}`;
    },
    modifyModels(models, credential) {
      modelInput = models;
      return credential.accountId === "account-7"
        ? [...models, model("account-model")]
        : models;
    },
  };
  directory.register("managed-provider", "managed-account", method);

  const refreshed = await directory.refresh(original);
  assert.equal(refreshed?.accessToken, "second-access");
  assert.equal(refreshed?.refreshToken, "first-refresh");
  assert.deepEqual(refreshed?.providerData, { cycle: "two", managedFlow: "subscription" });
  assert.deepEqual(refreshInput, {
    accessToken: "first-access",
    refreshToken: "first-refresh",
    expiresAt: original.expiresAt,
    tokenType: "Bearer",
    scopes: ["models.read"],
    accountId: "account-7",
    providerData: { tenant: "west" },
  });

  assert.equal(directory.apiKey("managed-provider", original), "projected:first-access");
  assert.deepEqual(projectedInput, refreshInput);
  const baseModels = [model("base-model")];
  const projectedModels = await directory.modifyModels(
    "managed-provider",
    baseModels,
    original,
    new AbortController().signal,
  );
  assert.deepEqual(projectedModels.map((entry) => entry.id), ["base-model", "account-model"]);
  assert.notEqual(modelInput, baseModels);
  assert.deepEqual(baseModels.map((entry) => entry.id), ["base-model"]);

  const otherFlow = normalizeManagedOAuthCredential("managed-account", "other-flow", {
    accessToken: "other-access",
    refreshToken: "other-refresh",
    expiresAt: Date.now() + 60_000,
  });
  assert.equal(directory.apiKey("managed-provider", otherFlow), undefined);
  assert.deepEqual(
    await directory.modifyModels("managed-provider", baseModels, otherFlow, new AbortController().signal),
    baseModels,
  );
});

test("managed callbacks are generation-stacked and invalid callback outputs fail closed", async () => {
  const credential = normalizeManagedOAuthCredential("managed-account", "subscription", {
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Date.now() + 60_000,
  });
  const directory = new ManagedProviderAuthDirectory();
  const first = directory.register("managed-provider", "managed-account", {
    kind: "managed_oauth",
    id: "subscription",
    async login() { throw new Error("not used"); },
    async refresh(value) { return value; },
    getApiKey() { return "first"; },
  });
  const second = directory.register("managed-provider", "managed-account", {
    kind: "managed_oauth",
    id: "subscription",
    async login() { throw new Error("not used"); },
    async refresh(value) { return value; },
    getApiKey() { return "second"; },
  });
  assert.equal(directory.apiKey("managed-provider", credential), "second");
  first();
  assert.equal(directory.apiKey("managed-provider", credential), "second");
  second();
  second();
  assert.equal(directory.apiKey("managed-provider", credential), undefined);

  const invalidKeyDirectory = new ManagedProviderAuthDirectory();
  invalidKeyDirectory.register("managed-provider", "managed-account", {
    kind: "managed_oauth",
    id: "subscription",
    async login() { throw new Error("not used"); },
    async refresh(value) { return value; },
    getApiKey() { return "bad\nkey"; },
  });
  assert.throws(() => invalidKeyDirectory.apiKey("managed-provider", credential), /invalid API key projection/u);

  const invalidModelsDirectory = new ManagedProviderAuthDirectory();
  invalidModelsDirectory.register("managed-provider", "managed-account", {
    kind: "managed_oauth",
    id: "subscription",
    async login() { throw new Error("not used"); },
    async refresh(value) { return value; },
    modifyModels() { return {} as unknown as ModelInfo[]; },
  });
  await assert.rejects(
    invalidModelsDirectory.modifyModels(
      "managed-provider",
      [model("base-model")],
      credential,
      new AbortController().signal,
    ),
    /must return an array/u,
  );
});

test("managed login observes cancellation after a provider callback settles", async () => {
  const registry = new ProviderAuthRegistry({
    bindings: [{
      providerId: "managed-provider",
      credentialId: "managed-account",
      displayName: "Managed Provider",
      externallyManaged: true,
    }],
    store: new MemoryCredentialStore(),
    environment: {},
  });
  const controller = new AbortController();
  registry.registerDescriptor("managed-extension", {
    provider: "managed-provider",
    methods: [{
      kind: "managed_oauth",
      id: "subscription",
      async login() {
        controller.abort(new Error("managed login cancelled"));
        return {
          accessToken: "unused-access",
          refreshToken: "unused-refresh",
          expiresAt: Date.now() + 60_000,
        };
      },
      async refresh(credential) { return credential; },
    }],
  });
  await assert.rejects(
    registry.authorizeManaged("managed-provider", "subscription", interaction(controller.signal)),
    /managed login cancelled/u,
  );
});
