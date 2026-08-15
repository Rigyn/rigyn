import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  builtinModels,
  builtinProviders,
  getBuiltinModel,
  getBuiltinModels,
  getBuiltinProviders,
} from "../../src/providers/all.js";
import { DEFAULT_OAUTH_CLIENT_IDS } from "../../src/auth/oauth-client-registration.js";
import { InMemoryProviderCredentialStore } from "../../src/providers/models.js";

function codexAccessToken(accountId = "fixture-account", subject = "fixture-user"): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    sub: subject,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.signature`;
}

test("built-in provider aggregation is complete and returns defensive lists", () => {
  const providerIds = getBuiltinProviders();
  assert.ok(providerIds.length > 0);
  assert.equal(new Set(providerIds).size, providerIds.length);

  for (const providerId of providerIds) {
    const models = getBuiltinModels(providerId);
    assert.ok(models.length > 0, `${providerId} has no catalog models`);
    assert.ok(models.every((model) => model.provider === providerId));
    assert.equal(getBuiltinModel(providerId, models[0]!.id), models[0]);

    models.length = 0;
    assert.ok(getBuiltinModels(providerId).length > 0);
  }

  assert.equal(getBuiltinModel("missing", "missing"), undefined);
  assert.deepEqual(getBuiltinModels("missing"), []);
});

test("built-in provider and model collections are independently constructed", async () => {
  const environment = { RIGYN_OPENAI_CODEX_OAUTH_CLIENT_ID: "rigyn-openai-test-client" };
  const firstProviders = builtinProviders(environment);
  const secondProviders = builtinProviders(environment);
  assert.deepEqual(firstProviders.map((provider) => provider.id), secondProviders.map((provider) => provider.id));
  assert.notEqual(firstProviders[0], secondProviders[0]);
  const codex = firstProviders.find((provider) => provider.id === "openai-codex");
  assert.notEqual(codex, undefined);
  assert.equal(codex!.auth.apiKey, undefined);
  assert.notEqual(codex!.auth.oauth, undefined);
  assert.ok(firstProviders
    .filter((provider) => provider.id !== "openai-codex")
    .every((provider) => provider.auth.apiKey !== undefined));
  assert.ok(firstProviders.every((provider) =>
    provider.getModels().every((model) => model.provider === provider.id)));

  const firstModels = builtinModels();
  const secondModels = builtinModels();
  const removed = firstModels.getProviders()[0]!.id;
  firstModels.deleteProvider(removed);
  assert.equal(firstModels.getProvider(removed), undefined);
  assert.notEqual(secondModels.getProvider(removed), undefined);
  assert.deepEqual(
    new Set(secondModels.getProviders().map((provider) => provider.id)),
    new Set(builtinProviders().map((provider) => provider.id)),
  );
  await firstModels.close();
  await secondModels[Symbol.asyncDispose]();
});

test("built-in OpenAI account login uses a public default and accepts an explicit override", () => {
  const defaults = builtinProviders({})
    .find((provider) => provider.id === "openai-codex")?.auth.oauth;
  assert.equal(typeof defaults?.login, "function");
  assert.equal(typeof defaults?.refresh, "function");
  assert.equal(typeof defaults?.toAuth, "function");

  const configured = builtinProviders({ RIGYN_OPENAI_CODEX_OAUTH_CLIENT_ID: "rigyn-openai-test-client" })
    .find((provider) => provider.id === "openai-codex")?.auth.oauth;
  assert.equal(typeof configured?.login, "function");
  assert.equal(typeof configured?.refresh, "function");
  assert.equal(typeof configured?.toAuth, "function");
});

test("built-in Anthropic account login uses a public default and accepts an explicit override", () => {
  const defaults = builtinProviders({})
    .find((provider) => provider.id === "anthropic")?.auth.oauth;
  assert.equal(typeof defaults?.login, "function");
  assert.equal(typeof defaults?.refresh, "function");
  assert.equal(typeof defaults?.toAuth, "function");

  const configured = builtinProviders({ RIGYN_ANTHROPIC_OAUTH_CLIENT_ID: "rigyn-anthropic-test-client" })
    .find((provider) => provider.id === "anthropic")?.auth.oauth;
  assert.equal(typeof configured?.login, "function");
  assert.equal(typeof configured?.refresh, "function");
  assert.equal(typeof configured?.toAuth, "function");
});

test("built-in Kimi Code keeps API-key login alongside default and overridden account login", () => {
  const defaults = builtinProviders({})
    .find((provider) => provider.id === "kimi-code")?.auth;
  assert.equal(typeof defaults?.apiKey?.resolve, "function");
  assert.equal(typeof defaults?.oauth?.login, "function");
  assert.equal(typeof defaults?.oauth?.refresh, "function");

  const configured = builtinProviders({ RIGYN_KIMI_CODE_OAUTH_CLIENT_ID: "rigyn-kimi-test-client" })
    .find((provider) => provider.id === "kimi-code")?.auth;
  assert.equal(typeof configured?.apiKey?.resolve, "function");
  assert.equal(typeof configured?.oauth?.login, "function");
  assert.equal(typeof configured?.oauth?.refresh, "function");
});

test("built-in Kimi Code and xAI refresh pin their registered endpoints and clients", async (t) => {
  const requests: Array<{ url: string; body: URLSearchParams }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), body: new URLSearchParams(String(init?.body)) });
    return new Response(JSON.stringify({
      access_token: `refreshed-${requests.length}`,
      refresh_token: `rotated-${requests.length}`,
      token_type: "Bearer",
      expires_in: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const environment = {
    RIGYN_KIMI_CODE_OAUTH_CLIENT_ID: "trusted-kimi-client",
    RIGYN_XAI_OAUTH_CLIENT_ID: "trusted-xai-client",
  };
  const providers = builtinProviders(environment);
  for (const providerId of ["kimi-code", "xai"] as const) {
    const oauth = providers.find((provider) => provider.id === providerId)?.auth.oauth;
    assert.ok(oauth?.refresh);
    const refreshed = await oauth.refresh({
      type: "oauth",
      access: "expired-access",
      refresh: "stored-refresh",
      expires: 1,
      clientId: "attacker-client",
      tokenEndpoint: "https://attacker.invalid/token",
    });
    assert.match(refreshed.access, /^refreshed-/u);
  }
  assert.deepEqual(requests.map(({ url, body }) => ({
    url,
    clientId: body.get("client_id"),
    refreshToken: body.get("refresh_token"),
  })), [
    {
      url: "https://auth.kimi.com/api/oauth/token",
      clientId: "trusted-kimi-client",
      refreshToken: "stored-refresh",
    },
    {
      url: "https://auth.x.ai/oauth2/token",
      clientId: "trusted-xai-client",
      refreshToken: "stored-refresh",
    },
  ]);
});

test("built-in GitHub Copilot refresh pins trusted hosts and replaces stored host metadata", async (t) => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const future = Math.floor(Date.now() / 1_000) + 3_600;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
    });
    return new Response(JSON.stringify({ token: "copilot-service-token", expires_at: future }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const cases = [
    { environment: {}, host: "github.com", endpoint: "https://api.github.com/copilot_internal/v2/token" },
    {
      environment: { COPILOT_GH_HOST: "company.ghe.com" },
      host: "company.ghe.com",
      endpoint: "https://api.company.ghe.com/copilot_internal/v2/token",
    },
  ];
  for (const selected of cases) {
    const oauth = builtinProviders(selected.environment)
      .find((provider) => provider.id === "github-copilot")?.auth.oauth;
    assert.ok(oauth?.refresh);
    const refreshed = await oauth.refresh({
      type: "oauth",
      access: "expired-service-token",
      refresh: "github-source-token",
      expires: 1,
      providerData: { enterpriseHost: "attacker.invalid" },
    });
    assert.deepEqual(refreshed.providerData, { enterpriseHost: selected.host });
  }

  assert.deepEqual(requests, cases.map((selected) => ({
    url: selected.endpoint,
    authorization: "Bearer github-source-token",
  })));
  assert.equal(requests.some((request) => request.url.includes("attacker.invalid")), false);
});

test("stored GitHub Copilot refresh persists canonical trusted host metadata", async (t) => {
  const previousHost = process.env.COPILOT_GH_HOST;
  delete process.env.COPILOT_GH_HOST;
  t.after(() => {
    if (previousHost === undefined) delete process.env.COPILOT_GH_HOST;
    else process.env.COPILOT_GH_HOST = previousHost;
  });
  const requests: string[] = [];
  const future = Math.floor(Date.now() / 1_000) + 3_600;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ token: "canonical-service-token", expires_at: future }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const credentials = new InMemoryProviderCredentialStore();
  await credentials.modify("github-copilot", async () => ({
    type: "oauth",
    access: "expired-service-token",
    refresh: "github-source-token",
    expires: 1,
    providerData: { enterpriseHost: "attacker.invalid" },
  }));
  const models = builtinModels({ credentials });
  t.after(() => models.close());

  const resolved = await models.getAuth("github-copilot");
  const stored = await credentials.read("github-copilot");

  assert.equal(resolved?.auth.apiKey, "canonical-service-token");
  assert.equal(stored?.type, "oauth");
  assert.deepEqual(stored?.type === "oauth" ? stored.providerData : undefined, {
    enterpriseHost: "github.com",
  });
  assert.deepEqual(requests, ["https://api.github.com/copilot_internal/v2/token"]);
});

test("built-in OpenAI accepts request-owned bearer credentials without disabling account login", async (t) => {
  const models = builtinModels();
  t.after(() => models.close());
  const model = getBuiltinModels("openai-codex")[0];
  assert.notEqual(model, undefined);
  const events = [];
  for await (const event of models.stream(model!, {
    messages: [{
      id: "request-owned-user",
      role: "user",
      content: [{ type: "text", text: "hello" }],
      createdAt: "2026-08-12T00:00:00.000Z",
    }],
  }, {
    apiKey: "request-owned-token",
    headers: { "chatgpt-account-id": "request-account" },
    transport: "sse",
    fetch: async () => new Response(`data: ${JSON.stringify({
      type: "response.completed",
      response: { id: "request-owned", output: [], usage: {} },
    })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } }),
  })) events.push(event);
  const terminal = events.at(-1);
  assert.equal(terminal?.type === "error" ? terminal.error.message : terminal?.type, "response_end");
  assert.equal(typeof models.getProvider("openai-codex")?.auth.oauth?.login, "function");
});

test("built-in Anthropic preserves OAuth provenance without classifying arbitrary bearer inputs as OAuth", async (t) => {
  const credentials = new InMemoryProviderCredentialStore();
  await credentials.modify("anthropic", async () => ({
    type: "oauth",
    access: "approved-oauth-access",
    refresh: "approved-oauth-refresh",
    expires: Date.now() + 60 * 60_000,
    clientId: "rigyn-anthropic-test-client",
  }));
  const models = builtinModels({ credentials });
  t.after(() => models.close());
  const model = getBuiltinModels("anthropic")[0];
  assert.notEqual(model, undefined);
  let incoming: Request | undefined;
  let body: { tools?: Array<{ name?: string }> } | undefined;
  const events = [];
  for await (const event of models.stream(model!, {
    messages: [{
      id: "anthropic-oauth-user",
      role: "user",
      content: [{ type: "text", text: "hello" }],
      createdAt: "2026-08-12T00:00:00.000Z",
    }],
    tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }],
  }, {
    fetch: async (input, init) => {
      incoming = input instanceof Request ? input : new Request(input, init);
      body = await incoming.clone().json() as typeof body;
      return new Response([
        `data: ${JSON.stringify({ type: "message_start", message: { id: "message-oauth", model: model!.id, usage: { input_tokens: 1 } } })}\n\n`,
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n`,
        `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    },
  })) events.push(event);

  assert.equal(events.at(-1)?.type, "response_end");
  assert.equal(incoming?.headers.get("authorization"), "Bearer approved-oauth-access");
  assert.equal(incoming?.headers.get("x-app"), "cli");
  assert.match(incoming?.headers.get("anthropic-beta") ?? "", /oauth-2025-04-20/u);
  assert.deepEqual(body?.tools?.map((tool) => tool.name), ["Read"]);
});

test("expired built-in OpenAI credentials refresh with the public default registration", async (t) => {
  let refreshBody: URLSearchParams | undefined;
  t.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    refreshBody = new URLSearchParams(String(init?.body));
    return new Response(JSON.stringify({
      access_token: codexAccessToken(),
      refresh_token: "rotated-refresh",
      token_type: "Bearer",
      expires_in: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const credentials = new InMemoryProviderCredentialStore();
  await credentials.modify("openai-codex", async () => ({
    type: "oauth",
    access: "expired-access",
    refresh: "expired-refresh",
    expires: Date.now() - 1,
  }));
  const models = builtinModels({ credentials });
  t.after(() => models.close());
  const resolved = await models.getAuth("openai-codex");
  assert.equal(resolved?.source, "OAuth");
  assert.equal(resolved?.auth.apiKey, codexAccessToken());
  assert.equal(resolved?.auth.headers?.["chatgpt-account-id"], "fixture-account");
  assert.equal(refreshBody?.get("client_id"), DEFAULT_OAUTH_CLIENT_IDS["openai-codex"]);
  assert.equal(refreshBody?.get("refresh_token"), "expired-refresh");
  assert.deepEqual(await models.checkAuth("openai-codex"), { type: "oauth", source: "OAuth" });
});

test("a rejected built-in construction does not install process listeners", () => {
  const before = new Map(["SIGINT", "SIGHUP", "SIGTERM"].map((signal) => [signal, process.listenerCount(signal)]));
  assert.throws(
    () => builtinProviders({ RIGYN_OPENAI_CODEX_OAUTH_CLIENT_ID: "unsafe client id" }),
    /OAUTH_CLIENT_ID/u,
  );
  assert.deepEqual(
    new Map([...before].map(([signal]) => [signal, process.listenerCount(signal)])),
    before,
  );
});

test("built-in streams surface missing credentials as provider events", async () => {
  const provider = builtinProviders().find((entry) => entry.id === "openai");
  const model = getBuiltinModels("openai")[0];
  assert.notEqual(provider, undefined);
  assert.notEqual(model, undefined);

  const events = [];
  for await (const event of provider!.stream(model!, { messages: [] })) events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
  assert.match(events[0]?.type === "error" ? events[0].error.message : "", /No credential is configured for openai/u);
});

test("built-in streams honor request-scoped HTTP transport hooks", async () => {
  const models = builtinModels();
  const model = getBuiltinModels("openai")[0];
  assert.notEqual(model, undefined);

  let observedBody: unknown;
  let observedHeaders: Headers | undefined;
  let responseStatus: number | undefined;
  const fetchImplementation: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    observedHeaders = request.headers;
    observedBody = await request.json();
    return new Response(JSON.stringify({ error: { message: "fixture rejection" } }), {
      status: 400,
      headers: { "content-type": "application/json", "x-fixture-response": "yes" },
    });
  };

  const events = [];
  for await (const event of models.stream(model!, {
    messages: [{ id: "fixture-user", role: "user", content: [{ type: "text", text: "hello" }], createdAt: "2026-08-01T00:00:00.000Z" }],
  }, {
    apiKey: "fixture-key",
    fetch: fetchImplementation,
    headers: { "x-request-scoped": "yes" },
    onPayload(payload, selected) {
      assert.equal(selected.id, model!.id);
      return { ...(payload as Record<string, unknown>), request_scoped_hook: true };
    },
    onResponse(response, selected) {
      assert.equal(selected.id, model!.id);
      responseStatus = response.status;
    },
  })) events.push(event);

  assert.equal(observedHeaders?.get("x-request-scoped"), "yes");
  assert.equal((observedBody as Record<string, unknown>).request_scoped_hook, true);
  assert.equal(responseStatus, 400);
  assert.equal(events.at(-1)?.type, "error");
});

test("built-in Codex streams apply request-scoped WebSocket transport settings", async () => {
  const provider = builtinProviders().find((entry) => entry.id === "openai-codex");
  const model = getBuiltinModels("openai-codex")[0];
  assert.notEqual(provider, undefined);
  assert.notEqual(model, undefined);

  const events = [];
  for await (const event of provider!.stream(model!, { messages: [] }, {
    apiKey: "fixture-token",
    headers: { "chatgpt-account-id": "fixture-account" },
    transport: "websocket",
    websocketConnectTimeoutMs: -1,
  })) events.push(event);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
  assert.match(
    events[0]?.type === "error" ? events[0].error.message : "",
    /webSocketConnectTimeoutMs/u,
  );

  const idleEvents = [];
  for await (const event of provider!.stream(model!, { messages: [] }, {
    apiKey: "fixture-token",
    headers: { "chatgpt-account-id": "fixture-account" },
    transport: "websocket",
    websocketIdleTimeoutMs: -1,
  })) idleEvents.push(event);

  assert.equal(idleEvents.length, 1);
  assert.equal(idleEvents[0]?.type, "error");
  assert.match(
    idleEvents[0]?.type === "error" ? idleEvents[0].error.message : "",
    /webSocketIdleTimeoutMs/u,
  );
});

test("built-in Codex streams preserve strict HTTPS/SSE when explicitly selected", async () => {
  const provider = builtinProviders().find((entry) => entry.id === "openai-codex");
  const model = getBuiltinModels("openai-codex")[0];
  assert.notEqual(provider, undefined);
  assert.notEqual(model, undefined);
  let fetchCalls = 0;

  const events = [];
  for await (const event of provider!.stream(model!, {
    messages: [{
      id: "fixture-user",
      role: "user",
      content: [{ type: "text", text: "hello" }],
      createdAt: "2026-08-01T00:00:00.000Z",
    }],
  }, {
    apiKey: "fixture-token",
    headers: { "chatgpt-account-id": "fixture-account" },
    transport: "sse",
    websocketConnectTimeoutMs: -1,
    fetch: async () => {
      fetchCalls += 1;
      return new Response(`data: ${JSON.stringify({
        type: "response.completed",
        response: { id: "default-sse", output: [], usage: {} },
      })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  })) events.push(event);

  assert.equal(fetchCalls, 1);
  assert.equal(events.at(-1)?.type, "response_end");
});

test("built-in model collections default to and reuse automatic Codex transport state", async (t) => {
  let proxyConnections = 0;
  const proxy = createServer();
  proxy.on("connect", (_request, socket) => {
    proxyConnections += 1;
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", () => {
      proxy.off("error", reject);
      resolve();
    });
  });
  const address = proxy.address();
  if (address === null || typeof address === "string") throw new Error("Fixture proxy did not bind a TCP address");
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  const credentials = new InMemoryProviderCredentialStore();
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const access = `${encode({ alg: "none" })}.${encode({
    sub: "fixture-user",
    "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
  })}.signature`;
  await credentials.modify("openai-codex", async () => ({
    type: "oauth",
    access,
    refresh: "fixture-refresh",
    expires: Date.now() + 60 * 60_000,
    accountId: "fixture-account",
  }));
  const models = builtinModels({ credentials });
  t.after(async () => {
    await models.close();
    await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
  });
  const model = getBuiltinModels("openai-codex")[0];
  assert.notEqual(model, undefined);
  let sseCalls = 0;
  const fetchImplementation: typeof fetch = async () => {
    sseCalls += 1;
    return new Response([
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: `fallback-${sseCalls}` })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: `sse-${sseCalls}`, usage: {} } })}\n\n`,
    ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const options = {
    sessionId: "retained-auto-session",
    fetch: fetchImplementation,
    env: {
      all_proxy: proxyUrl,
      ALL_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      HTTP_PROXY: proxyUrl,
      https_proxy: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      no_proxy: "",
      NO_PROXY: "",
    },
  };
  const context = {
    messages: [{
      id: "fixture-user",
      role: "user" as const,
      content: [{ type: "text" as const, text: "hello" }],
      createdAt: "2026-08-01T00:00:00.000Z",
    }],
  };

  for await (const _event of models.stream(model!, context, options)) { /* consume */ }
  const firstConnections = proxyConnections;
  assert.ok(firstConnections > 0);
  for await (const _event of models.stream(model!, context, options)) { /* consume */ }

  assert.equal(proxyConnections, firstConnections);
  assert.equal(sseCalls, 2);
});
