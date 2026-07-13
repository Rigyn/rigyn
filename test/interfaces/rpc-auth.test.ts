import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EncryptedFileCredentialStore, ProviderAuthRegistry } from "../../src/auth/index.js";
import { RpcRuntimeDispatcher } from "../../src/interfaces/rpc-runtime.js";
import type { RpcRequest } from "../../src/interfaces/rpc.js";
import { CapturePeer, QueueProvider, createTestRuntime } from "./rpc-helpers.js";

function request(method: string, params?: unknown): RpcRequest {
  return { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) };
}

async function fixture(root: string, transportFetch: typeof fetch) {
  const base = await createTestRuntime(root, join(root, "sessions.sqlite"), new QueueProvider([]));
  const credentials = new EncryptedFileCredentialStore({
    path: join(root, "credentials.enc"),
    key: randomBytes(32),
  });
  const auth = new ProviderAuthRegistry({
    bindings: [{
      providerId: "openai",
      credentialId: "openai",
      displayName: "OpenAI",
      secret: "api_key",
    }],
    store: credentials,
    environment: { OPENAI_API_KEY: "environment-secret" },
  });
  const runtime = {
    ...base,
    auth,
    network: {
      fetch: transportFetch,
      info: { proxied: false, noProxyConfigured: false },
      async close(): Promise<void> {},
    },
  };
  return { base, credentials, auth, runtime };
}

test("RPC provider auth exposes secret-free profile CRUD and explicit fallback selection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-rpc-auth-"));
  const setup = await fixture(root, (async () => new Response(null, { status: 200 })) as typeof fetch);
  const dispatcher = new RpcRuntimeDispatcher({ runtime: setup.runtime });
  const peer = new CapturePeer("rpc-auth");
  t.after(async () => {
    await dispatcher.close("test complete");
    await setup.base.close();
  });
  t.after(async () => await rm(root, { recursive: true, force: true }));

  const workSecret = "rpc-work-secret";
  const personalSecret = "rpc-personal-secret";
  const work = await dispatcher.dispatch(peer, request("auth.set", {
    provider: "openai",
    profile: "work",
    kind: "api_key",
    secret: workSecret,
    accountId: "work-account",
  }));
  const personal = await dispatcher.dispatch(peer, request("auth.set", {
    provider: "openai",
    profile: "personal",
    kind: "bearer",
    secret: personalSecret,
    accountId: "personal-account",
  }));
  assert.doesNotMatch(JSON.stringify([work, personal]), /rpc-(?:work|personal)-secret/u);

  const profiles = await dispatcher.dispatch(peer, request("auth.profiles", { provider: "openai" })) as {
    activeProfile?: string;
    fallbackSelected: boolean;
    profiles: Array<{ name: string; accountId?: string; active: boolean }>;
  };
  assert.equal(profiles.activeProfile, "personal");
  assert.equal(profiles.fallbackSelected, false);
  assert.deepEqual(profiles.profiles.map(({ name, accountId, active }) => ({ name, accountId, active })), [
    { name: "work", accountId: "work-account", active: false },
    { name: "personal", accountId: "personal-account", active: true },
  ]);

  const fallback = await dispatcher.dispatch(peer, request("auth.fallback", { provider: "openai" })) as {
    source?: string;
    fallbackSelected?: boolean;
  };
  assert.equal(fallback.source, "environment");
  assert.equal(fallback.fallbackSelected, true);

  await dispatcher.dispatch(peer, request("auth.select", { provider: "openai", profile: "work" }));
  const removed = await dispatcher.dispatch(peer, request("auth.delete", {
    provider: "openai",
    profile: "work",
  })) as { removed: boolean; state: { status: string; activeProfile?: string; environment: { shadowed: boolean } } };
  assert.equal(removed.removed, true);
  assert.equal(removed.state.status, "unavailable");
  assert.equal(removed.state.activeProfile, undefined);
  assert.equal(removed.state.environment.shadowed, true);

  await dispatcher.dispatch(peer, request("auth.select", { provider: "openai", profile: "personal" }));
  const status = await dispatcher.dispatch(peer, request("auth.status", { provider: "openai" })) as {
    source?: string;
    activeProfile?: string;
    accountId?: string;
  };
  assert.deepEqual(
    { source: status.source, activeProfile: status.activeProfile, accountId: status.accountId },
    { source: "stored", activeProfile: "personal", accountId: "personal-account" },
  );

  await assert.rejects(
    dispatcher.dispatch(peer, request("auth.set", {
      provider: "openai",
      kind: "api_key",
      secret: "x".repeat(64 * 1024 + 1),
    })),
    /secret is invalid or exceeds 65536 bytes/u,
  );
});

test("RPC disconnect cancels remote revocation and retains the local credential", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-rpc-auth-cancel-"));
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const transportFetch = (async (_input, init) => {
    markStarted();
    const signal = init?.signal;
    return await new Promise<Response>((_resolve, reject) => {
      const abort = (): void => reject(signal?.reason ?? new Error("revocation cancelled"));
      if (signal?.aborted === true) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }) as typeof fetch;
  const setup = await fixture(root, transportFetch);
  await setup.auth.storeCredential("openai", {
    kind: "oauth",
    provider: "openai",
    accessToken: "rpc-access-secret",
    refreshToken: "rpc-refresh-secret",
    expiresAt: Date.now() + 60_000,
    tokenType: "Bearer",
    scopes: ["models.read"],
    tokenEndpoint: "https://issuer.example/token",
    revocationEndpoint: "https://issuer.example/revoke",
    clientId: "public-client",
  }, { profile: "work" });
  const dispatcher = new RpcRuntimeDispatcher({ runtime: setup.runtime });
  const peer = new CapturePeer("rpc-auth-cancel");
  t.after(async () => {
    await dispatcher.close("test complete");
    await setup.base.close();
  });
  t.after(async () => await rm(root, { recursive: true, force: true }));

  const deletion = dispatcher.dispatch(peer, request("auth.delete", {
    provider: "openai",
    profile: "work",
    revokeRemote: true,
  }));
  await started;
  dispatcher.disconnect(peer.id);
  await assert.rejects(deletion, /RPC client disconnected/u);
  assert.equal((await setup.auth.profileState("openai")).profiles[0]?.present, true);
});
