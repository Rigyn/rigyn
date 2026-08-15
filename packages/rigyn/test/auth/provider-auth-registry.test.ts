import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  authorizeOAuthRegistration,
  defaultSecretRedactor,
  ProviderAuthRegistry,
  RefreshingStoredCredentialSource,
  type AuthCredential,
  type CredentialStore,
  type MutableCredentialStore,
  type ProviderAuthDescriptor,
} from "../../src/auth/index.js";
import { runtimeProviderAuthBinding } from "../../src/cli/runtime.js";
import { XAI_OAUTH_REGISTRATION_ID, xaiOAuthRegistration } from "../../src/auth/xai.js";

class MemoryCredentialStore implements CredentialStore {
  readonly values = new Map<string, AuthCredential>();

  async read(id: string): Promise<AuthCredential | undefined> {
    return this.values.get(id);
  }

  async write(id: string, credential: AuthCredential): Promise<void> {
    this.values.set(id, credential);
  }

  async delete(id: string): Promise<void> {
    this.values.delete(id);
  }

  async withLock<T>(_id: string, operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}

test("provider auth registry carries cancellation through the credential commit", async () => {
  const controller = new AbortController();
  const cancellation = new Error("cancel registry credential before commit");
  let stored: AuthCredential | undefined;
  const store = {
    async read() { return stored; },
    async write(_id: string, credential: AuthCredential) { stored = credential; },
    async delete() { stored = undefined; },
    async withLock<T>(_id: string, operation: () => Promise<T>) { return await operation(); },
    async list() { return []; },
    async modify(
      _id: string,
      operation: (current: AuthCredential | undefined) => Promise<AuthCredential | undefined>,
      signal?: AbortSignal,
    ) {
      const replacement = await operation(stored);
      controller.abort(cancellation);
      signal?.throwIfAborted();
      stored = replacement;
      return replacement;
    },
  } satisfies MutableCredentialStore;
  const registry = new ProviderAuthRegistry({
    bindings: [{ providerId: "fixture", credentialId: "fixture", displayName: "Fixture", secret: "api_key" }],
    store,
    environment: {},
  });

  await assert.rejects(
    registry.storeCredential("fixture", {
      kind: "api_key",
      provider: "fixture",
      apiKey: "late-registry-key",
    }, { signal: controller.signal }),
    (error: unknown) => error === cancellation,
  );
  assert.equal(stored, undefined);
});

test("a caller-owned xAI registration is a device method alongside API keys", () => {
  const configured = xaiOAuthRegistration("rigyn-xai-test-client");
  const registry = new ProviderAuthRegistry({
    bindings: [{ providerId: "xai", credentialId: "xai", displayName: "xAI", secret: "api_key" }],
    registrations: { [XAI_OAUTH_REGISTRATION_ID]: configured },
    store: new MemoryCredentialStore(),
    environment: {},
  });
  const methods = registry.methods("xai");
  assert.equal(methods.find((method) => method.kind === "oauth")?.label, "Sign in with xAI");
  const registration = registry.registration(XAI_OAUTH_REGISTRATION_ID);
  assert.equal(registration.clientId, "rigyn-xai-test-client");
  assert.equal(registration.flow === "device" ? registration.deviceParameters : undefined, undefined);
  assert.ok(methods.some((method) => method.kind === "environment"));
  assert.ok(methods.some((method) => method.kind === "api_key"));
});

test("provider auth state is secret-free and stored credentials intentionally shadow environment credentials", async () => {
  const store = new MemoryCredentialStore();
  store.values.set("openai", {
    kind: "oauth",
    provider: "openai",
    accessToken: "stored-access-secret",
    refreshToken: "stored-refresh-secret",
    expiresAt: Date.now() + 3_600_000,
    tokenType: "Bearer",
    scopes: ["models.read"],
    tokenEndpoint: "https://issuer.example/token",
    clientId: "public-client",
    accountId: "account-7",
    subject: "person@example.test",
  });
  const registry = new ProviderAuthRegistry({
    bindings: [{ providerId: "openai", credentialId: "openai", displayName: "OpenAI", secret: "api_key" }],
    store,
    environment: { OPENAI_API_KEY: "environment-secret" },
  });

  const state = await registry.state("openai");
  assert.equal(state.status, "connected");
  assert.equal(state.source, "stored");
  assert.equal(state.accountId, "account-7");
  assert.equal(state.subject, "person@example.test");
  assert.deepEqual(state.environment, {
    present: true,
    active: false,
    shadowed: true,
    variable: "OPENAI_API_KEY",
  });
  assert.equal(state.stored.active, true);
  assert.equal(state.stored.shadowed, false);
  const serialized = JSON.stringify(state);
  assert.doesNotMatch(serialized, /stored-access-secret|stored-refresh-secret|environment-secret/u);

  const logout = await registry.logout("openai");
  assert.equal(logout.removedStored, true);
  assert.equal(logout.state.status, "connected");
  assert.equal(logout.state.source, "environment");
  assert.equal(logout.state.environment.active, true);
});

test("provider auth state contains hostile custom credential-store failures without reflection", async () => {
  let traps = 0;
  const failure = new Proxy(Object.create(null) as object, {
    get() { traps += 1; throw new Error("get trap executed"); },
    getPrototypeOf() { traps += 1; throw new Error("prototype trap executed"); },
  });
  const store: CredentialStore = {
    async read() { throw failure; },
    async write() {},
    async delete() {},
    async withLock<T>(_id: string, operation: () => Promise<T>) { return await operation(); },
  };
  const registry = new ProviderAuthRegistry({
    bindings: [{ providerId: "hostile", credentialId: "hostile", displayName: "Hostile", secret: "api_key" }],
    store,
    environment: {},
  });

  const state = await registry.state("hostile");
  assert.equal(state.status, "unavailable");
  assert.equal(state.error, "[Thrown object]");
  assert.equal(traps, 0);
});

test("provider auth state redacts registered secrets from credential-store failures", async () => {
  const secret = "provider-state-secret-7f3b19354d";
  defaultSecretRedactor.register(secret);
  const store: CredentialStore = {
    async read() { throw new Error(`credential backend failed for ${secret}`); },
    async write() {},
    async delete() {},
    async withLock<T>(_id: string, operation: () => Promise<T>) { return await operation(); },
  };
  const registry = new ProviderAuthRegistry({
    bindings: [{ providerId: "redacted", credentialId: "redacted", displayName: "Redacted" }],
    store,
    environment: {},
  });

  const state = await registry.state("redacted");
  assert.equal(state.status, "unavailable");
  assert.equal(state.error, "credential backend failed for [REDACTED]");
  assert.doesNotMatch(JSON.stringify(state), new RegExp(secret, "u"));
});

test("an unusable stored credential remains the selected source instead of silently changing accounts", async () => {
  const store = new MemoryCredentialStore();
  store.values.set("openai", {
    kind: "bearer",
    provider: "openai",
    accessToken: "expired-secret",
    expiresAt: 1,
    accountId: "expired-account",
  });
  const registry = new ProviderAuthRegistry({
    bindings: [{ providerId: "openai", credentialId: "openai", displayName: "OpenAI", secret: "api_key" }],
    store,
    environment: { OPENAI_API_KEY: "fallback-secret" },
    now: () => 2,
  });
  const state = await registry.state("openai");
  assert.equal(state.status, "unavailable");
  assert.equal(state.source, "stored");
  assert.equal(state.accountId, "expired-account");
  assert.equal(state.environment.shadowed, true);
  assert.match(state.error ?? "", /expired/u);
});

test("runtime auth bindings cover aliases, cloud bearer sources, and local or remote model servers", () => {
  assert.deepEqual(runtimeProviderAuthBinding("openai-codex", { kind: "openai-codex" }, "openai-codex", {
    RIGYN_OPENAI_CODEX_OAUTH_CLIENT_ID: "rigyn-openai-test-client",
  }), {
    providerId: "openai-codex",
    credentialId: "openai-codex",
    displayName: "OpenAI Codex",
    openAICodex: true,
  });
  assert.deepEqual(runtimeProviderAuthBinding("corp", {
    kind: "openai-compatible",
    id: "corp",
    baseUrl: "https://models.example.test/v1",
    credentialProvider: "shared-account",
  }, "corp", {}), {
    providerId: "corp",
    credentialId: "shared-account",
    displayName: "corp",
    secret: "api_key",
  });
  assert.deepEqual(runtimeProviderAuthBinding("company-router", {
    kind: "routed",
    id: "company-router",
    credentialProvider: "shared-router-account",
    adapters: {
      chat: { kind: "openai-compatible", baseUrl: "https://models.example.test/v1" },
    },
    routes: [{ model: "code", adapter: "chat", protocolFamily: "openai-chat-completions" }],
  }, "company-router", {}), {
    providerId: "company-router",
    credentialId: "shared-router-account",
    displayName: "company-router",
    secret: "api_key",
  });
  assert.deepEqual(runtimeProviderAuthBinding("bedrock", { kind: "bedrock", region: "us-east-1" }, "bedrock", {}), {
    providerId: "bedrock",
    credentialId: "bedrock",
    displayName: "bedrock",
    secret: "bearer",
    ambient: "aws",
  });
  assert.deepEqual(runtimeProviderAuthBinding("vertex", { kind: "vertex", project: "project" }, "vertex", {}), {
    providerId: "vertex",
    credentialId: "vertex",
    displayName: "vertex",
    secret: "api_key",
    ambient: "google",
  });
  assert.deepEqual(runtimeProviderAuthBinding("anthropic", { kind: "anthropic" }, "anthropic", {
    RIGYN_ANTHROPIC_OAUTH_CLIENT_ID: "rigyn-anthropic-test-client",
  }), {
    providerId: "anthropic",
    credentialId: "anthropic",
    displayName: "Anthropic",
    secret: "api_key",
    anthropicOAuth: true,
  });
  assert.deepEqual(runtimeProviderAuthBinding("github-copilot", { kind: "github-copilot" }, "github-copilot", {
    RIGYN_GITHUB_COPILOT_OAUTH_CLIENT_ID: "rigyn-github-test-client",
  }), {
    providerId: "github-copilot",
    credentialId: "github-copilot",
    displayName: "GitHub Copilot",
    secret: "api_key",
    githubCopilotOAuth: true,
  });
  assert.equal(runtimeProviderAuthBinding("ollama", { kind: "ollama" }, "ollama", {}).local, true);
  assert.deepEqual(runtimeProviderAuthBinding("ollama", { kind: "ollama", host: "https://ollama.example.test" }, "ollama", {}), {
    providerId: "ollama",
    credentialId: "ollama",
    displayName: "Ollama",
    secret: "bearer",
  });
});

test("explicit OpenAI OAuth configuration is isolated from OpenAI API keys", async () => {
  const environment = {
    OPENAI_API_KEY: "platform-key",
    RIGYN_OPENAI_CODEX_OAUTH_CLIENT_ID: "rigyn-openai-test-client",
  };
  const registry = new ProviderAuthRegistry({
    bindings: [
      runtimeProviderAuthBinding("openai", { kind: "openai" }, "openai", environment),
      runtimeProviderAuthBinding("openai-codex", { kind: "openai-codex" }, "openai-codex", environment),
    ],
    store: new MemoryCredentialStore(),
    environment,
  });
  const platform = await registry.state("openai");
  const subscription = await registry.state("openai-codex");
  assert.equal(platform.status, "connected");
  assert.equal(platform.source, "environment");
  assert.equal(subscription.status, "available");
  assert.equal(subscription.source, undefined);
  assert.equal(subscription.environment.present, false);
  assert.deepEqual(subscription.methods.map((method) => method.kind), [
    "openai_codex_browser",
    "openai_codex_device",
  ]);
});

test("Anthropic OAuth uses its public default registration and accepts an explicit override", async () => {
  const environment = { RIGYN_ANTHROPIC_OAUTH_CLIENT_ID: "rigyn-anthropic-test-client" };
  const registry = new ProviderAuthRegistry({
    bindings: [
      runtimeProviderAuthBinding("anthropic", { kind: "anthropic" }, "anthropic", environment),
    ],
    store: new MemoryCredentialStore(),
    environment: {},
  });

  assert.deepEqual((await registry.loginMethods("anthropic")).map((method) => method.kind), [
    "anthropic_browser",
    "api_key",
  ]);

  const defaults = new ProviderAuthRegistry({
    bindings: [runtimeProviderAuthBinding("anthropic", { kind: "anthropic" }, "anthropic", {})],
    store: new MemoryCredentialStore(),
    environment: {},
  });
  assert.deepEqual((await defaults.loginMethods("anthropic")).map((method) => method.kind), [
    "anthropic_browser",
    "api_key",
  ]);
});

test("GitHub Copilot OAuth uses its public default registration and accepts an explicit override", async () => {
  const defaults = new ProviderAuthRegistry({
    bindings: [runtimeProviderAuthBinding("github-copilot", { kind: "github-copilot" }, "github-copilot", {})],
    store: new MemoryCredentialStore(),
    environment: {},
  });
  assert.deepEqual((await defaults.loginMethods("github-copilot")).map((method) => method.kind), [
    "github_copilot_device",
    "api_key",
  ]);

  const environment = { RIGYN_GITHUB_COPILOT_OAUTH_CLIENT_ID: "rigyn-github-test-client" };
  const configured = new ProviderAuthRegistry({
    bindings: [runtimeProviderAuthBinding("github-copilot", { kind: "github-copilot" }, "github-copilot", environment)],
    store: new MemoryCredentialStore(),
    environment: {},
  });
  assert.deepEqual((await configured.loginMethods("github-copilot")).map((method) => method.kind), [
    "github_copilot_device",
    "api_key",
  ]);
});

test("native OAuth bindings use public defaults while rejecting invalid overrides", () => {
  assert.deepEqual(
    runtimeProviderAuthBinding("openai-codex", { kind: "openai-codex" }, "openai-codex", {}),
    {
      providerId: "openai-codex",
      credentialId: "openai-codex",
      displayName: "OpenAI Codex",
      openAICodex: true,
    },
  );
  assert.deepEqual(runtimeProviderAuthBinding(
    "anthropic",
    { kind: "anthropic" },
    "anthropic",
    {},
  ), {
    providerId: "anthropic",
    credentialId: "anthropic",
    displayName: "Anthropic",
    secret: "api_key",
    anthropicOAuth: true,
  });
  assert.deepEqual(runtimeProviderAuthBinding(
    "github-copilot",
    { kind: "github-copilot" },
    "github-copilot",
    {},
  ), {
    providerId: "github-copilot",
    credentialId: "github-copilot",
    displayName: "GitHub Copilot",
    secret: "api_key",
    githubCopilotOAuth: true,
  });
  assert.throws(() => runtimeProviderAuthBinding(
    "anthropic",
    { kind: "anthropic" },
    "anthropic",
    { RIGYN_ANTHROPIC_OAUTH_CLIENT_ID: " unsafe " },
  ), /RIGYN_ANTHROPIC_OAUTH_CLIENT_ID/u);
});

test("shared credential bindings expose every affected provider and configured OAuth issuer provenance", async () => {
  const registry = new ProviderAuthRegistry({
    bindings: [
      { providerId: "corp-chat", credentialId: "corp-account", displayName: "Corp Chat", secret: "api_key" },
      { providerId: "corp-code", credentialId: "corp-account", displayName: "Corp Code", secret: "api_key" },
    ],
    registrations: {
      workforce: {
        provider: "corp-chat",
        flow: "pkce",
        label: "Company account",
        clientId: "public-client",
        authorizationEndpoint: "https://identity.example.test/authorize",
        tokenEndpoint: "https://identity.example.test/token",
        scopes: [],
      },
    },
    store: new MemoryCredentialStore(),
    environment: {},
  });
  assert.deepEqual(registry.affectedProviders("corp-chat"), ["corp-chat", "corp-code"]);
  const oauth = registry.methods("corp-chat").find((method) => method.kind === "oauth");
  assert.ok(oauth);
  assert.match(oauth.detail, /identity\.example\.test/u);
  assert.match(oauth.detail, /configured registration workforce/u);
  const serialized = JSON.stringify(await registry.state("corp-chat"));
  assert.doesNotMatch(serialized, /public-client|\/authorize|\/token/u);
});

test("configured device authorization produces a refreshable credential and refreshes under the stored source", async (t) => {
  let deviceTokenRequests = 0;
  let refreshRequests = 0;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/device") {
      response.end(JSON.stringify({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: `http://127.0.0.1:${(server.address() as { port: number }).port}/verify`,
        expires_in: 60,
        interval: 1,
      }));
      return;
    }
    if (request.url !== "/token") {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      if (body.get("grant_type") === "refresh_token") {
        refreshRequests += 1;
        response.end(JSON.stringify({ access_token: "refreshed-secret", token_type: "Bearer", expires_in: 3600 }));
      } else {
        deviceTokenRequests += 1;
        response.end(JSON.stringify({
          access_token: "initial-secret",
          refresh_token: "refresh-secret",
          token_type: "Bearer",
          expires_in: 1,
          scope: "models.read",
        }));
      }
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const store = new MemoryCredentialStore();
  const registry = new ProviderAuthRegistry({
    bindings: [{ providerId: "corp", credentialId: "corp", displayName: "Corp", externallyManaged: true }],
    store,
    environment: {},
  });
  registry.registerDescriptor("fixture", {
    provider: "corp",
    credentialId: "shared-account",
    methods: [{
      kind: "oauth_device",
      id: "workforce",
      clientId: "public-client",
      deviceEndpoint: `http://127.0.0.1:${port}/device`,
      tokenEndpoint: `http://127.0.0.1:${port}/token`,
      scopes: ["models.read"],
    }],
  });
  const method = registry.methods("corp").find((entry) => entry.kind === "oauth");
  assert.ok(method);
  const registration = registry.registration(method.registrationId);
  const notices: Array<{ url: string; userCode?: string }> = [];
  const credential = await authorizeOAuthRegistration(registration, "shared-account", {
    showAuthorization: ({ url, userCode }) => {
      notices.push({ url: url.toString(), ...(userCode === undefined ? {} : { userCode }) });
    },
  });
  assert.equal(credential.provider, "shared-account");
  assert.equal(credential.refreshToken, "refresh-secret");
  assert.deepEqual(notices, [{ url: `http://127.0.0.1:${port}/verify`, userCode: "ABCD-EFGH" }]);
  assert.equal(deviceTokenRequests, 1);

  await store.write("shared-account", credential);
  const refreshed = await new RefreshingStoredCredentialSource(store).resolve({ provider: "shared-account" });
  assert.equal(refreshed?.kind, "oauth");
  if (refreshed?.kind !== "oauth") assert.fail("Expected refreshed OAuth credential");
  assert.equal(refreshed.accessToken, "refreshed-secret");
  assert.equal(refreshed.refreshToken, "refresh-secret");
  assert.equal(refreshRequests, 1);
});

test("generation-owned provider auth descriptors are detached, annotated, collision-safe, and reversible", async () => {
  const registry = new ProviderAuthRegistry({
    bindings: [{ providerId: "corp", credentialId: "corp", displayName: "corp", externallyManaged: true }],
    store: new MemoryCredentialStore(),
    environment: {},
  });
  const descriptor: ProviderAuthDescriptor = {
    provider: "corp",
    credentialId: "corp-account",
    displayName: "Corporate Models",
    methods: [
      { kind: "api_key", label: "Company token", detail: "Stored only in the credential vault" },
      {
        kind: "oauth_pkce",
        id: "workforce",
        label: "Company SSO",
        detail: "Browser sign-in · company identity",
        clientId: "public-client",
        authorizationEndpoint: "https://identity.example.test/authorize",
        tokenEndpoint: "https://identity.example.test/token",
        scopes: ["models.read"],
      },
      { kind: "ambient", provider: "google", label: "Workstation identity", detail: "Google application default credentials" },
    ],
  };
  const cleanup = registry.registerDescriptor("fixture-extension", descriptor);
  (descriptor.methods[0] as { label?: string }).label = "mutated after registration";

  assert.deepEqual(registry.binding("corp"), {
    providerId: "corp",
    credentialId: "corp-account",
    displayName: "Corporate Models",
    externallyManaged: false,
    secret: "api_key",
    ambient: "google",
  });
  const methods = registry.methods("corp");
  assert.equal(methods.find((method) => method.kind === "api_key")?.label, "Company token");
  assert.equal(methods.find((method) => method.kind === "oauth")?.detail, "Browser sign-in · company identity");
  assert.equal(methods.find((method) => method.kind === "ambient")?.label, "Workstation identity");
  assert.equal(methods.some((method) => method.kind === "external"), false);
  const state = await registry.state("corp");
  assert.equal(state.status, "available");
  assert.equal(state.source, "ambient");
  assert.equal(state.displayName, "Corporate Models");
  assert.doesNotMatch(JSON.stringify(state), /public-client|\/authorize|\/token/u);
  assert.throws(() => registry.registerDescriptor("other", {
    provider: "corp",
    methods: [{ kind: "api_key" }],
  }), /duplicate provider auth descriptor/iu);

  const oauth = methods.find((method) => method.kind === "oauth");
  assert.ok(oauth);
  assert.equal(registry.registration(oauth.registrationId).clientId, "public-client");
  cleanup();
  cleanup();
  assert.deepEqual(registry.binding("corp"), {
    providerId: "corp",
    credentialId: "corp",
    displayName: "corp",
    externallyManaged: true,
  });
  assert.deepEqual(registry.methods("corp").map((method) => method.kind), ["external"]);
  assert.throws(() => registry.registration(oauth.registrationId), /not configured/u);
});

test("provider display-name overlays compose without changing credential metadata", () => {
  const registry = new ProviderAuthRegistry({
    bindings: [{ providerId: "corp", credentialId: "corp-account", displayName: "Corp", secret: "api_key" }],
    store: new MemoryCredentialStore(),
    environment: {},
  });
  const first = registry.overrideDisplayName("corp", "First Label");
  const second = registry.overrideDisplayName("corp", "Second Label");
  assert.deepEqual(registry.binding("corp"), {
    providerId: "corp",
    credentialId: "corp-account",
    displayName: "Second Label",
    secret: "api_key",
  });
  first();
  assert.equal(registry.binding("corp").displayName, "Second Label");
  second();
  assert.equal(registry.binding("corp").displayName, "Corp");
  assert.throws(() => registry.overrideDisplayName("missing", "Missing"), /not registered/u);
});

test("provider auth descriptors reject secret-bearing or unsafe OAuth configuration before registration", () => {
  const registry = new ProviderAuthRegistry({ bindings: [], store: new MemoryCredentialStore(), environment: {} });
  assert.throws(() => registry.registerDescriptor("fixture", {
    provider: "unsafe",
    methods: [{
      kind: "oauth_pkce",
      id: "login",
      clientId: "public-client",
      authorizationEndpoint: "http://identity.example.test/authorize",
      tokenEndpoint: "https://identity.example.test/token",
    }],
  }), /HTTPS or loopback HTTP/u);
  assert.throws(() => registry.registerDescriptor("fixture", {
    provider: "unsafe",
    methods: [{
      kind: "oauth_pkce",
      id: "login",
      clientId: "public-client",
      authorizationEndpoint: "https://identity.example.test/authorize",
      tokenEndpoint: "https://identity.example.test/token",
      authorizationParameters: { client_secret: "must-not-be-accepted" },
    }],
  }), /invalid or reserved/u);
  assert.throws(() => registry.registerDescriptor("fixture", {
    provider: "unsafe",
    methods: [{ kind: "api_key" }, { kind: "api_key" }],
  }), /duplicate API-key methods/u);
  assert.equal(registry.has("unsafe"), false);
});

test("dynamic device authorization propagates denial and caller cancellation without storing credentials", async (t) => {
  let denied = true;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/device") {
      response.end(JSON.stringify({
        device_code: "dynamic-device-secret",
        user_code: "DYNAMIC-CODE",
        verification_uri: `http://127.0.0.1:${(server.address() as { port: number }).port}/verify`,
        expires_in: 60,
        interval: 1,
      }));
      return;
    }
    response.statusCode = 400;
    response.end(JSON.stringify({ error: denied ? "access_denied" : "authorization_pending" }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const store = new MemoryCredentialStore();
  const registry = new ProviderAuthRegistry({
    bindings: [{ providerId: "dynamic", credentialId: "dynamic", displayName: "Dynamic", externallyManaged: true }],
    store,
    environment: {},
  });
  registry.registerDescriptor("fixture", {
    provider: "dynamic",
    methods: [{
      kind: "oauth_device",
      id: "device",
      clientId: "public-client",
      deviceEndpoint: `http://127.0.0.1:${port}/device`,
      tokenEndpoint: `http://127.0.0.1:${port}/token`,
    }],
  });
  const method = registry.methods("dynamic").find((entry) => entry.kind === "oauth");
  assert.ok(method);
  await assert.rejects(authorizeOAuthRegistration(registry.registration(method.registrationId), "dynamic", {
    showAuthorization() {},
  }), /denied/u);
  assert.equal(await store.read("dynamic"), undefined);

  denied = false;
  const controller = new AbortController();
  await assert.rejects(authorizeOAuthRegistration(registry.registration(method.registrationId), "dynamic", {
    showAuthorization() { controller.abort(new Error("fixture cancelled")); },
    signal: controller.signal,
  }), /fixture cancelled|cancelled/u);
  assert.equal(await store.read("dynamic"), undefined);
});

test("dynamic PKCE descriptors complete an offline state-checked loopback exchange", async (t) => {
  let exchange: URLSearchParams | undefined;
  const server = createServer((request, response) => {
    if (request.url !== "/token" || request.method !== "POST") {
      response.statusCode = 404;
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      exchange = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        access_token: "pkce-access-secret",
        refresh_token: "pkce-refresh-secret",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "models.read",
      }));
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const registry = new ProviderAuthRegistry({
    bindings: [{ providerId: "pkce", credentialId: "pkce-account", displayName: "PKCE", externallyManaged: true }],
    store: new MemoryCredentialStore(),
    environment: {},
  });
  registry.registerDescriptor("fixture", {
    provider: "pkce",
    methods: [{
      kind: "oauth_pkce",
      id: "browser",
      clientId: "public-client",
      authorizationEndpoint: `http://127.0.0.1:${port}/authorize`,
      tokenEndpoint: `http://127.0.0.1:${port}/token`,
      scopes: ["models.read"],
      authorizationParameters: { audience: "models" },
    }],
  });
  const method = registry.methods("pkce").find((entry) => entry.kind === "oauth");
  assert.ok(method);
  const credential = await authorizeOAuthRegistration(registry.registration(method.registrationId), "pkce-account", {
    async showAuthorization({ url }) {
      assert.equal(url.searchParams.get("client_id"), "public-client");
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.equal(url.searchParams.get("audience"), "models");
      const redirect = new URL(url.searchParams.get("redirect_uri")!);
      const invalid = new URL(redirect);
      invalid.searchParams.set("state", "wrong-state");
      invalid.searchParams.set("code", "attacker-code");
      assert.equal((await fetch(invalid)).status, 400);
      redirect.searchParams.set("state", url.searchParams.get("state")!);
      redirect.searchParams.set("code", "valid-code");
      assert.equal((await fetch(redirect)).status, 200);
    },
  });

  assert.equal(credential.provider, "pkce-account");
  assert.equal(credential.accessToken, "pkce-access-secret");
  assert.equal(credential.refreshToken, "pkce-refresh-secret");
  assert.equal(exchange?.get("grant_type"), "authorization_code");
  assert.equal(exchange?.get("client_id"), "public-client");
  assert.equal(exchange?.get("code"), "valid-code");
  assert.match(exchange?.get("code_verifier") ?? "", /^[A-Za-z0-9_-]{43}$/u);
  assert.match(exchange?.get("redirect_uri") ?? "", /^http:\/\/127\.0\.0\.1:/u);
});

test("dynamic PKCE cancellation does not inspect a hostile abort reason", async () => {
  const controller = new AbortController();
  let traps = 0;
  const reason = new Proxy(Object.create(null) as object, {
    get() { traps += 1; return undefined; },
    getPrototypeOf() { traps += 1; return Object.prototype; },
  });
  const registration = {
    provider: "pkce-hostile-abort",
    flow: "pkce" as const,
    clientId: "public-client",
    authorizationEndpoint: "https://identity.example.test/authorize",
    tokenEndpoint: "https://identity.example.test/token",
    scopes: ["models.read"],
  };

  await assert.rejects(authorizeOAuthRegistration(registration, "pkce-hostile-abort", {
    signal: controller.signal,
    showAuthorization() { controller.abort(reason); },
  }), /aborted|cancelled/iu);
  assert.equal(traps, 0);
});

test("dynamic PKCE login does not inspect a hostile manual callback rejection", async () => {
  let traps = 0;
  const failure = new Proxy(Object.create(null) as object, {
    get() { traps += 1; throw new Error("get trap executed"); },
    getPrototypeOf() { traps += 1; throw new Error("prototype trap executed"); },
  });
  const registration = {
    provider: "pkce-hostile-manual",
    flow: "pkce" as const,
    clientId: "public-client",
    authorizationEndpoint: "https://identity.example.test/authorize",
    tokenEndpoint: "https://identity.example.test/token",
    scopes: ["models.read"],
  };
  let caught: unknown;
  try {
    await authorizeOAuthRegistration(registration, "pkce-hostile-manual", {
      showAuthorization() {},
      async requestManualAuthorization() { throw failure; },
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(caught, failure);
  assert.equal(traps, 0);
});
