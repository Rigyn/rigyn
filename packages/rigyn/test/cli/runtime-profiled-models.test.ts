import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AuthCredential, CredentialProfileMetadataStore, MutableCredentialStore } from "../../src/auth/index.js";
import { loadRuntime } from "../../src/cli/runtime.js";

class MemoryProfileStore implements CredentialProfileMetadataStore, MutableCredentialStore {
  readonly credentials = new Map<string, AuthCredential>();
  readonly indexes = new Map<string, unknown>();

  async read(id: string): Promise<AuthCredential | undefined> { return structuredClone(this.credentials.get(id)); }
  async write(id: string, credential: AuthCredential): Promise<void> { this.credentials.set(id, structuredClone(credential)); }
  async delete(id: string): Promise<void> { this.credentials.delete(id); }
  async withLock<T>(_id: string, operation: () => Promise<T>): Promise<T> { return await operation(); }
  async list() {
    const summaries = new Map<string, AuthCredential["kind"]>();
    for (const credential of this.credentials.values()) summaries.set(credential.provider, credential.kind);
    return [...summaries].map(([providerId, type]) => ({ providerId, type }));
  }
  async modify(id: string, operation: (current: AuthCredential | undefined) => Promise<AuthCredential | undefined>) {
    const current = await this.read(id);
    const replacement = await operation(current);
    if (replacement !== undefined) this.credentials.set(id, structuredClone(replacement));
    return structuredClone(replacement ?? current);
  }
  async readCredentialProfileIndex(id: string): Promise<unknown | undefined> { return structuredClone(this.indexes.get(id)); }
  async writeCredentialProfileIndex(id: string, value: unknown): Promise<void> { this.indexes.set(id, structuredClone(value)); }
  async deleteCredentialProfileIndex(id: string): Promise<void> { this.indexes.delete(id); }
}

test("profile-backed login immediately exposes subscription models to the interactive runtime", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-profiled-model-runtime-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const previousAgentDirectory = process.env.RIGYN_HOME;
  process.env.RIGYN_HOME = join(root, "agent");
  context.after(() => {
    if (previousAgentDirectory === undefined) delete process.env.RIGYN_HOME;
    else process.env.RIGYN_HOME = previousAgentDirectory;
  });
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const runtime = await loadRuntime({
    workspace,
    credentialStore: new MemoryProfileStore(),
    deferModelNetworkRefresh: true,
    projectTrusted: false,
    extensions: false,
    skills: false,
    promptTemplates: false,
    themes: false,
  });
  context.after(() => runtime.close());

  await runtime.auth.storeCredential("openai-codex", {
    kind: "oauth",
    provider: "openai-codex",
    accessToken: "fixture-access",
    refreshToken: "fixture-refresh",
    expiresAt: Date.now() + 60 * 60_000,
    tokenType: "Bearer",
    scopes: [],
    accountId: "fixture-account",
  });
  const state = await runtime.auth.state("openai-codex");
  assert.equal(state.status, "connected");
  assert.equal(state.activeProfile, "default");

  const refresh = await runtime.modelRegistry.refresh({
    force: true,
    allowNetwork: true,
    signal: runtime.generationSignal,
  });
  assert.equal(refresh.errors.has("openai-codex"), false);
  assert.equal(runtime.modelRegistry.getAvailable().some((model) =>
    model.provider === "openai-codex" && model.id === "gpt-5.6-sol"), true);
  assert.equal((await runtime.modelRegistry.getProviderAuth("openai-codex"))?.source, "OAuth");
  const brokerCredential = await runtime.broker.resolve({ provider: "openai-codex" });
  assert.equal(brokerCredential?.source, "stored");
  assert.equal(brokerCredential?.credential.kind, "oauth");

  await runtime.refresh();
  assert.equal(runtime.modelRegistry.getAvailable().some((model) =>
    model.provider === "openai-codex" && model.id === "gpt-5.6-sol"), true);
});
