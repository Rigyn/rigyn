import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AuthCredential, MutableCredentialStore } from "../../src/auth/index.js";
import { loadRuntime } from "../../src/cli/runtime.js";

class MemoryCredentialStore implements MutableCredentialStore {
  readonly #values = new Map<string, AuthCredential>();

  constructor(entries: ReadonlyArray<readonly [string, AuthCredential]>) {
    for (const [id, credential] of entries) this.#values.set(id, structuredClone(credential));
  }

  async read(id: string): Promise<AuthCredential | undefined> { return structuredClone(this.#values.get(id)); }
  async write(id: string, credential: AuthCredential): Promise<void> { this.#values.set(id, structuredClone(credential)); }
  async delete(id: string): Promise<void> { this.#values.delete(id); }
  async withLock<T>(_id: string, operation: () => Promise<T>): Promise<T> { return await operation(); }
  async list() {
    return [...this.#values.entries()].map(([providerId, credential]) => ({ providerId, type: credential.kind }));
  }
  async modify(
    id: string,
    operation: (current: AuthCredential | undefined) => Promise<AuthCredential | undefined>,
  ): Promise<AuthCredential | undefined> {
    const replacement = await operation(await this.read(id));
    if (replacement === undefined) this.#values.delete(id);
    else this.#values.set(id, structuredClone(replacement));
    return structuredClone(replacement);
  }
}

test("the product model bridge honors request-scoped transport options", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-request-fetch-"));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  await Promise.all([mkdir(workspace), mkdir(agentDirectory)]);

  const previousAgentDirectory = process.env.RIGYN_HOME;
  process.env.RIGYN_HOME = agentDirectory;
  let runtime: Awaited<ReturnType<typeof loadRuntime>> | undefined;
  context.after(async () => {
    await runtime?.close().catch(() => undefined);
    if (previousAgentDirectory === undefined) delete process.env.RIGYN_HOME;
    else process.env.RIGYN_HOME = previousAgentDirectory;
    await rm(root, { recursive: true, force: true });
  });

  const credentials = new MemoryCredentialStore([["openai-codex", {
    kind: "oauth",
    provider: "openai-codex",
    accessToken: "fixture-access",
    refreshToken: "fixture-refresh",
    expiresAt: Date.now() + 60 * 60_000,
    tokenType: "Bearer",
    scopes: [],
    accountId: "fixture-account",
  }]]);
  runtime = await loadRuntime({
    workspace,
    credentialStore: credentials,
    ephemeral: true,
    offline: true,
    projectTrusted: false,
    extensions: false,
    extensionRuntime: false,
    skills: false,
    promptTemplates: false,
    themes: false,
  });
  const model = runtime.modelRegistry.getAll().find((entry) => entry.provider === "openai");
  assert.notEqual(model, undefined);

  let calls = 0;
  const events = [];
  for await (const event of runtime.modelRegistry.models().stream(model!, {
    messages: [{ id: "fixture-user", role: "user", content: [{ type: "text", text: "hello" }], createdAt: "2026-08-01T00:00:00.000Z" }],
  }, {
    apiKey: "fixture-key",
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "fixture rejection" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    },
  })) events.push(event);

  assert.equal(calls, 1);
  assert.equal(events.at(-1)?.type, "error");

  const codexModel = runtime.modelRegistry.getAll().find((entry) => entry.provider === "openai-codex");
  assert.notEqual(codexModel, undefined);
  const codexEvents = [];
  for await (const event of runtime.modelRegistry.models().stream(codexModel!, { messages: [] }, {
    transport: "websocket",
    websocketConnectTimeoutMs: -1,
  })) codexEvents.push(event);
  assert.equal(codexEvents.length, 1);
  assert.equal(codexEvents[0]?.type, "error");
  assert.match(
    codexEvents[0]?.type === "error" ? codexEvents[0].error.message : "",
    /webSocketConnectTimeoutMs/u,
  );

  const idleEvents = [];
  for await (const event of runtime.modelRegistry.models().stream(codexModel!, { messages: [] }, {
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
