import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AdapterEvent, ModelInfo, ProviderAdapter, ProviderRequest } from "../../src/core/types.js";
import { ExtensionCatalog } from "../../src/extensions/loader.js";
import { loadRuntimeExtensions } from "../../src/extensions/runtime.js";
import type { ExtensionBundle, ExtensionRuntimeEntry } from "../../src/extensions/types.js";
import { RpcRuntimeDispatcher } from "../../src/interfaces/rpc-runtime.js";
import type { RpcRequest } from "../../src/interfaces/rpc.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { HarnessService } from "../../src/service/harness.js";
import type { HarnessResourceCatalog } from "../../src/service/resource-catalog.js";
import { SessionStore } from "../../src/storage/store.js";
import { sha256 } from "../../src/tools/hash.js";
import { CapturePeer } from "../interfaces/rpc-helpers.js";

const HASH = "b".repeat(64);
const OBSERVED_AT = "2026-07-12T00:00:00.000Z";

class CatalogProvider implements ProviderAdapter {
  readonly id = "catalog-provider";

  async *stream(_request: ProviderRequest, _signal: AbortSignal): AsyncIterable<AdapterEvent> {
    throw new Error("not used");
  }

  async listModels(): Promise<ModelInfo[]> {
    const capability = { value: "supported" as const, source: "provider" as const, observedAt: OBSERVED_AT };
    return [{
      id: "catalog-model",
      provider: this.id,
      capabilities: { tools: capability, reasoning: capability, images: capability },
    }];
  }
}

function request(method: string): RpcRequest {
  return { jsonrpc: "2.0", id: 1, method };
}

function commandUi() {
  return {
    notify() {}, setStatus() {}, setWidget() {}, setHeader() {}, setFooter() {}, setWorkingMessage() {}, setWorkingVisible() {}, setTitle() {},
    async getTheme() { return { name: "dark", available: ["dark"] }; },
    async setTheme(name: string) { return { name, available: [name] }; },
    async select() { throw new Error("not used"); },
    async confirm() { return false; },
    async input() { return undefined; },
    async editor() { return undefined; },
    setEditorText() {}, getEditorText() { return ""; },
    async custom() { return undefined; },
    showOverlay() { throw new Error("not used"); },
  };
}

test("embedding, typed RPC, and runtime extensions receive the same canonical catalog", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-resource-conformance-"));
  const entryPath = join(root, "catalog-extension.mjs");
  const entrySource = `export default function activate(api) {
    api.registerCommand({
      name: "catalog-projection",
      async execute(context) {
        const catalog = await api.getResourceCatalog(context.signal);
        return { prompt: JSON.stringify(catalog) };
      }
    });
  }\n`;
  await writeFile(entryPath, entrySource);
  const entry: ExtensionRuntimeEntry = { extensionId: "catalog-fixture", sourcePath: entryPath, sha256: sha256(entrySource) };
  const runtimeExtensions = await loadRuntimeExtensions([entry], { workspace: root });
  const bundle: ExtensionBundle = {
    skillRoots: [],
    prompts: [{
      id: "catalog-prompt",
      extensionId: "catalog-fixture",
      sourcePath: join(root, "private-prompt.md"),
      sha256: HASH,
      template: "private prompt contents",
    }],
    commands: [],
    themes: [],
    runtime: [entry],
  };
  const extensions = new ExtensionCatalog([{
    id: "catalog-fixture",
    name: "Catalog fixture",
    scope: "user",
    trusted: true,
    status: "active",
    sourceRoot: root,
    extensionRoot: root,
    manifestPath: join(root, "extension.json"),
    precedence: 0,
    contributions: { skillRoots: 0, prompts: 1, commands: 0, themes: 0, runtime: 1 },
  }], [], bundle);
  const provider = new CatalogProvider();
  const providers = new ProviderRegistry([provider]);
  await providers.refreshModels(provider.id, AbortSignal.timeout(2_000));
  const store = new SessionStore(":memory:");
  const service = new HarnessService({
    store,
    workspace: root,
    providers,
    runtimeExtensions,
    extraTools: runtimeExtensions.tools(),
    resourceCatalog: { extensions },
  });
  await service.initialize();
  const runtime = {
    workspace: root,
    store,
    providers,
    service,
    extensions,
    runtimeExtensions,
  };
  const dispatcher = new RpcRuntimeDispatcher({ runtime: runtime as never });
  context.after(async () => {
    await dispatcher.close("test complete");
    await service.close();
    await runtimeExtensions.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const embedded = await service.resourceCatalog();
  const rpc = await dispatcher.dispatch(new CapturePeer("catalog"), request("resources.list")) as HarnessResourceCatalog;
  const extension = await runtimeExtensions.runCommand("catalog-projection", {
    args: "",
    threadId: "thread-catalog",
    signal: new AbortController().signal,
    ui: commandUi(),
  });
  assert.equal(extension.handled, true);
  const extensionCatalog = JSON.parse(extension.prompt ?? "null") as HarnessResourceCatalog;
  assert.deepEqual(rpc, embedded);
  assert.deepEqual(extensionCatalog, embedded);
  assert.equal(embedded.providers[0]?.models[0]?.id, "catalog-model");
  assert.equal(embedded.commands.runtimeExtensions[0]?.name, "catalog-projection");
  assert.equal(embedded.prompts[0]?.id, "catalog-prompt");
  assert.doesNotMatch(JSON.stringify(embedded), /private prompt contents|private-prompt\.md|catalog-extension\.mjs/u);
});

test("runtime extension catalog boundary rejects a malformed host result", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-resource-malformed-"));
  const entryPath = join(root, "catalog-extension.mjs");
  const entrySource = `export default function activate(api) {
    api.registerCommand({ name: "bad-catalog", async execute(context) {
      await api.getResourceCatalog(context.signal);
    }});
  }\n`;
  await writeFile(entryPath, entrySource);
  const host = await loadRuntimeExtensions([{ extensionId: "bad", sourcePath: entryPath, sha256: sha256(entrySource) }], { workspace: root });
  host.setSessionHandler({
    async getResourceCatalog() {
      return {
        schemaVersion: 1,
        tools: [], commands: { builtins: [], runtimeExtensions: [], extensionTemplates: [] },
        prompts: [],
        skills: [{ name: "bad", description: "bad", scope: "user", trusted: "yes", disableModelInvocation: false, metadataTruncated: false }],
        themes: [], providers: [], packages: [], extensions: [], diagnostics: [],
        bounds: { truncated: false, omitted: { tools: 0, commands: 0, prompts: 0, skills: 0, themes: 0, providers: 0, models: 0, packages: 0, extensions: 0, diagnostics: 0 } },
      } as never;
    },
  } as never);
  context.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  const result = await host.runCommand("bad-catalog", {
    args: "",
    threadId: "thread-bad",
    signal: new AbortController().signal,
    ui: commandUi(),
  });
  assert.deepEqual(result, { handled: true });
  assert.match(host.diagnostics().at(-1)?.message ?? "", /trusted must be a boolean/u);
});
