import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import type { ProviderAdapter } from "../../src/core/types.js";
import { discoverExtensions } from "../../src/extensions/index.js";
import {
  appendRuntimeExtensions,
  loadRuntimeExtensions,
  type RuntimeExtensionApi,
  type RuntimeExtensionHost,
  type RuntimeExtensionSessionHandler,
  type RuntimeNativeHostHandler,
  type RuntimeNativeSessionPage,
} from "../../src/extensions/runtime.js";
import { sha256 } from "../../src/tools/hash.js";
import type { NativeUiHost } from "../../src/tui/native-ui.js";
import { createTheme } from "../../src/tui/theme.js";

const NATIVE_PERMISSIONS = {
  nativeUi: true,
  providerOverride: true,
  providerWire: true,
  credentialAccess: true,
  sessionRaw: true,
  hostConfiguration: true,
} as const;

const TIMESTAMP = "2026-07-19T00:00:00.000Z";

async function temporaryRoot(context: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  return root;
}

async function captureEntry(
  root: string,
  id: string,
  globalKey: string,
  entry: { trusted: boolean; permissions?: typeof NATIVE_PERMISSIONS },
): Promise<{
  host: RuntimeExtensionHost;
  api: RuntimeExtensionApi;
}> {
  const sourcePath = join(root, `${id}.mjs`);
  const source = `export default (api) => { globalThis[${JSON.stringify(globalKey)}] = api; };\n`;
  await writeFile(sourcePath, source);
  const host = await loadRuntimeExtensions([{
    extensionId: id,
    sourcePath,
    sha256: sha256(source),
    ...entry,
  }], { workspace: root, activationFailure: "throw" });
  const api = (globalThis as Record<string, unknown>)[globalKey] as RuntimeExtensionApi;
  assert.ok(api);
  return { host, api };
}

function nativePage(threadId: string, branch = "main"): RuntimeNativeSessionPage {
  return {
    thread: {
      threadId,
      name: "Native security fixture",
      defaultBranch: branch,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      branches: [{ threadId, name: branch, createdAt: TIMESTAMP, updatedAt: TIMESTAMP }],
    },
    branch,
    events: [],
    runs: [],
    nextSequence: 0,
    snapshotSequence: 0,
    hasMore: false,
  };
}

function configuration(root: string) {
  return {
    workspace: resolve(root),
    projectTrusted: true,
    globalConfigPath: join(root, "config.jsonc"),
    projectConfigPath: join(root, ".rigyn", "config.jsonc"),
    databasePath: join(root, "state.sqlite"),
    effective: {},
  };
}

function nativeUiHost(
  extensionId: string,
  signal: AbortSignal,
  dispose: () => void,
): NativeUiHost {
  const theme = createTheme("mono", { color: false, unicode: true });
  const noRegistration = () => () => undefined;
  let disposed = false;
  return {
    extensionId,
    signal,
    onInput: noRegistration,
    getEditor() { throw new Error("Native security fixture does not exercise the editor"); },
    replaceEditor: noRegistration,
    wrapEditor: noRegistration,
    mountHeader: noRegistration,
    mountFooter: noRegistration,
    mountWidget: noRegistration,
    replaceHeader: noRegistration,
    replaceFooter: noRegistration,
    currentTheme() { return theme; },
    themeCatalog() { return [theme]; },
    applyTheme: noRegistration,
    pasteToEditor() {},
    wrapAutocomplete: noRegistration,
    dispose() {
      if (disposed) return;
      disposed = true;
      dispose();
    },
  };
}

function provider(id = "native-security-provider"): ProviderAdapter {
  return {
    id,
    async *stream() {},
    async listModels() { return []; },
  };
}

function installDeniedHandlers(host: RuntimeExtensionHost, reached: string[]): void {
  host.setNativeUiHandler((extensionId, signal) => {
    reached.push("nativeUi");
    return nativeUiHost(extensionId, signal, () => undefined);
  });
  host.setSessionHandler({
    async readNativeSession(input) {
      reached.push("sessionRaw");
      return nativePage(input.threadId, input.branch);
    },
  } as RuntimeExtensionSessionHandler);
  host.setNativeHostHandler({
    async resolveCredential(providerValue) {
      reached.push("credentialAccess");
      return {
        provider: providerValue,
        source: "native-security",
        credential: { kind: "api_key", apiKey: "must-not-be-returned" },
        headers: { authorization: "must-not-be-returned" },
      };
    },
    async getConfiguration() {
      reached.push("hostConfiguration");
      return configuration(host.workspace);
    },
    async updateConfiguration() {
      reached.push("hostConfiguration");
      return configuration(host.workspace);
    },
  });
  host.setLiveRegistrationHandler({
    registerTool() {},
    registerProvider() {},
    overrideProvider() { reached.push("providerOverride"); },
    overlayProvider() { reached.push("providerOverride"); },
    registerProviderWire() { reached.push("providerWire"); },
    unregisterProvider() {},
    registerProviderAuth() {},
    async fetchProvider() { return new Response(); },
  });
}

function nativeCalls(api: RuntimeExtensionApi): Record<string, Array<() => unknown>> {
  const adapter = provider();
  return {
    nativeUi: [() => api.native.ui.currentTheme()],
    providerOverride: [
      () => api.native.providers.override(adapter),
      () => api.native.providers.overlay({ id: adapter.id, displayName: "Overlay" }),
    ],
    providerWire: [() => api.native.providers.intercept(adapter.id, { observeResponse() {} })],
    credentialAccess: [() => api.native.credentials.resolve(adapter.id)],
    sessionRaw: [
      () => api.native.session.read({ threadId: "native-security-thread", branch: "main" }),
      () => api.native.session.getSystemPrompt({ threadId: "native-security-thread", branch: "main" }),
    ],
    hostConfiguration: [
      () => api.native.host.getConfiguration(),
      () => api.native.host.updateConfiguration({ scope: "user", patch: {} }),
    ],
  };
}

async function assertNativeDenied(api: RuntimeExtensionApi, permission: string): Promise<void> {
  for (const call of nativeCalls(api)[permission] ?? []) {
    await assert.rejects(async () => await call(), new RegExp(`permissions\\.${permission} enabled`, "u"));
  }
}

test("native manifest permissions do not make an untrusted extension executable", async (context) => {
  const root = await temporaryRoot(context, "rigyn-native-security-manifest-");
  const extension = join(root, "native-security");
  await mkdir(join(extension, "runtime"), { recursive: true });
  await writeFile(join(extension, "runtime", "index.mjs"), "export default function activate() {}\n");
  await writeFile(join(extension, "extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "native-security",
    permissions: NATIVE_PERMISSIONS,
    contributions: { runtime: [{ path: "runtime/index.mjs" }] },
  }));

  const trusted = await discoverExtensions([{ path: root, scope: "user", trusted: true }]);
  assert.deepEqual(trusted.bundle().runtime[0]?.permissions, NATIVE_PERMISSIONS);
  assert.equal(trusted.bundle().runtime[0]?.trusted, true);

  const untrusted = await discoverExtensions([{ path: root, scope: "project", trusted: false }]);
  assert.equal(untrusted.list()[0]?.status, "blocked");
  assert.deepEqual(untrusted.bundle().runtime, []);
  assert.ok(untrusted.doctor().diagnostics.some((entry) => entry.code === "EXTENSION_UNTRUSTED"));
});

test("every native surface rejects an undeclared permission before reaching the host", async (context) => {
  const root = await temporaryRoot(context, "rigyn-native-security-undeclared-");
  const globalKey = "__rigynNativeSecurityUndeclaredApi";
  context.after(() => { delete (globalThis as Record<string, unknown>)[globalKey]; });
  const { host, api } = await captureEntry(root, "native-undeclared", globalKey, { trusted: true });
  const reached: string[] = [];
  installDeniedHandlers(host, reached);

  for (const permission of Object.keys(NATIVE_PERMISSIONS)) await assertNativeDenied(api, permission);
  assert.deepEqual(reached, []);
  await host.close();
});

test("declared native permissions remain unavailable to an untrusted runtime entry", async (context) => {
  const root = await temporaryRoot(context, "rigyn-native-security-untrusted-");
  const globalKey = "__rigynNativeSecurityUntrustedApi";
  context.after(() => { delete (globalThis as Record<string, unknown>)[globalKey]; });
  const { host, api } = await captureEntry(root, "native-untrusted", globalKey, {
    trusted: false,
    permissions: NATIVE_PERMISSIONS,
  });
  const reached: string[] = [];
  installDeniedHandlers(host, reached);

  for (const permission of Object.keys(NATIVE_PERMISSIONS)) await assertNativeDenied(api, permission);
  assert.deepEqual(reached, []);
  await host.close();
});

test("failed native activation aborts the candidate and rolls back privileged registrations", async (context) => {
  const root = await temporaryRoot(context, "rigyn-native-security-rollback-");
  const host = await loadRuntimeExtensions([], { workspace: root });
  context.after(async () => {
    await host.close();
    delete (globalThis as Record<string, unknown>).__rigynNativeFailedSignal;
    delete (globalThis as Record<string, unknown>).__rigynNativeFailedDisposed;
    delete (globalThis as Record<string, unknown>).__rigynNativeFailedPending;
  });
  const lifecycle: string[] = [];
  const operationSignals: AbortSignal[] = [];
  let nativeUiSignal: AbortSignal | undefined;

  host.setNativeUiHandler((extensionId, signal) => {
    nativeUiSignal = signal;
    lifecycle.push("native-ui:create");
    return nativeUiHost(extensionId, signal, () => { lifecycle.push("native-ui:dispose"); });
  });
  host.setSessionHandler({
    async readNativeSession(input) {
      assert.ok(input.signal);
      operationSignals.push(input.signal);
      return await new Promise<RuntimeNativeSessionPage>(() => {});
    },
  } as RuntimeExtensionSessionHandler);
  const pendingNativeHost = async (signal?: AbortSignal): Promise<never> => {
    assert.ok(signal);
    operationSignals.push(signal);
    return await new Promise<never>(() => {});
  };
  host.setNativeHostHandler({
    async resolveCredential(_providerValue, signal) { return await pendingNativeHost(signal); },
    async getConfiguration(signal) { return await pendingNativeHost(signal); },
    async updateConfiguration(input) { return await pendingNativeHost(input.signal); },
  });
  host.setLiveRegistrationHandler({
    registerTool() {},
    registerProvider() {},
    overrideProvider() { lifecycle.push("provider-override:live"); },
    registerProviderWire() { lifecycle.push("provider-wire:live"); },
    unregisterProvider() {},
    registerProviderAuth() {},
    async fetchProvider() { return new Response(); },
  });

  const sourcePath = join(root, "failed-native.mjs");
  const source = `export default (api) => {
    globalThis.__rigynNativeFailedSignal = api.signal;
    api.onDispose(() => { globalThis.__rigynNativeFailedDisposed = true; });
    api.native.ui.currentTheme();
    api.native.providers.override({ id: "native-security-provider", async *stream() {}, async listModels() { return []; } });
    api.native.providers.intercept("native-security-provider", { observeResponse() {} });
    globalThis.__rigynNativeFailedPending = Promise.allSettled([
      api.native.credentials.resolve("native-security-provider"),
      api.native.session.read({ threadId: "native-security-thread", branch: "main" }),
      api.native.host.getConfiguration(),
      api.native.host.updateConfiguration({ scope: "user", patch: {} })
    ]);
    throw new Error("native activation failed");
  };\n`;
  await writeFile(sourcePath, source);

  await assert.rejects(appendRuntimeExtensions(host, [{
    extensionId: "failed-native",
    sourcePath,
    sha256: sha256(source),
    trusted: true,
    permissions: NATIVE_PERMISSIONS,
  }], { workspace: root, activationFailure: "throw" }), /native activation failed/u);
  const pending = (globalThis as Record<string, unknown>).__rigynNativeFailedPending as
    Promise<PromiseSettledResult<unknown>[]> | undefined;
  assert.ok(pending);
  const settled = await pending;
  assert.ok(settled.every((result) => result.status === "rejected"));
  assert.equal(((globalThis as Record<string, unknown>).__rigynNativeFailedSignal as AbortSignal).aborted, true);
  assert.equal((globalThis as Record<string, unknown>).__rigynNativeFailedDisposed, true);
  assert.equal(nativeUiSignal?.aborted, true);
  assert.equal(operationSignals.length, 4);
  assert.ok(operationSignals.every((signal) => signal.aborted));
  assert.deepEqual(lifecycle, ["native-ui:create", "native-ui:dispose"]);
  assert.deepEqual(host.extensions(), []);

  delete (globalThis as Record<string, unknown>).__rigynNativeFailedSignal;
  delete (globalThis as Record<string, unknown>).__rigynNativeFailedDisposed;
  delete (globalThis as Record<string, unknown>).__rigynNativeFailedPending;
});

test("native unload cleans registrations before a replacement generation and leaves retained handles stale", async (context) => {
  const root = await temporaryRoot(context, "rigyn-native-security-unload-");
  const globalKey = "__rigynNativeSecurityUnloadApi";
  context.after(() => { delete (globalThis as Record<string, unknown>)[globalKey]; });
  const { host, api } = await captureEntry(root, "native-unload", globalKey, {
    trusted: true,
    permissions: NATIVE_PERMISSIONS,
  });
  const cleanup: string[] = [];
  let uiSignal: AbortSignal | undefined;
  host.setNativeUiHandler((extensionId, signal) => {
    uiSignal = signal;
    return nativeUiHost(extensionId, signal, () => { cleanup.push("native-ui"); });
  });
  host.setLiveRegistrationHandler({
    registerTool() {},
    registerProvider() {},
    overrideProvider() { return () => { cleanup.push("provider-override"); }; },
    registerProviderWire() { return () => { cleanup.push("provider-wire"); }; },
    unregisterProvider() {},
    registerProviderAuth() {},
    async fetchProvider() { return new Response(); },
  });
  host.setSessionHandler({
    async readNativeSession(input) { return nativePage(input.threadId, input.branch); },
  } as RuntimeExtensionSessionHandler);
  host.setNativeHostHandler({
    async resolveCredential(providerValue) {
      return {
        provider: providerValue,
        source: "native-security",
        credential: { kind: "api_key", apiKey: "native-security-secret" },
        headers: { authorization: "Bearer native-security-secret" },
      };
    },
    async getConfiguration() { return configuration(root); },
    async updateConfiguration() { return configuration(root); },
  });

  api.native.ui.currentTheme();
  api.native.providers.override(provider());
  api.native.providers.intercept("native-security-provider", { observeResponse() {} });
  await api.native.credentials.resolve("native-security-provider");
  await api.native.session.read({ threadId: "native-security-thread", branch: "main" });
  await api.native.host.getConfiguration();
  assert.equal(api.signal.aborted, false);
  await host.close();
  await host.close();

  assert.equal(api.signal.aborted, true);
  assert.equal(uiSignal?.aborted, true);
  assert.deepEqual(cleanup.sort(), ["native-ui", "provider-override", "provider-wire"]);
  for (const permission of Object.keys(NATIVE_PERMISSIONS)) {
    for (const call of nativeCalls(api)[permission] ?? []) {
      await assert.rejects(async () => await call(), /no longer active/u);
    }
  }

  const replacementKey = "__rigynNativeSecurityReplacementApi";
  context.after(() => { delete (globalThis as Record<string, unknown>)[replacementKey]; });
  const replacement = await captureEntry(root, "native-unload", replacementKey, {
    trusted: true,
    permissions: NATIVE_PERMISSIONS,
  });
  replacement.host.setNativeHostHandler({
    async resolveCredential() { return undefined; },
    async getConfiguration() { return configuration(root); },
    async updateConfiguration() { return configuration(root); },
  });
  assert.equal((await replacement.api.native.host.getConfiguration()).workspace, resolve(root));
  await replacement.host.close();
});

test("native provider disposers are idempotent and unload does not replay their cleanup", async (context) => {
  const root = await temporaryRoot(context, "rigyn-native-security-disposers-");
  const globalKey = "__rigynNativeSecurityDisposerApi";
  context.after(() => { delete (globalThis as Record<string, unknown>)[globalKey]; });
  const { host, api } = await captureEntry(root, "native-disposers", globalKey, {
    trusted: true,
    permissions: NATIVE_PERMISSIONS,
  });
  const cleanup = { override: 0, wire: 0 };
  host.setLiveRegistrationHandler({
    registerTool() {},
    registerProvider() {},
    overrideProvider() { return () => { cleanup.override += 1; }; },
    registerProviderWire() { return () => { cleanup.wire += 1; }; },
    unregisterProvider() {},
    registerProviderAuth() {},
    async fetchProvider() { return new Response(); },
  });

  const disposeOverride = api.native.providers.override(provider());
  const disposeWire = api.native.providers.intercept("native-security-provider", { observeResponse() {} });
  await disposeOverride();
  await disposeOverride();
  await disposeWire();
  await disposeWire();
  assert.deepEqual(cleanup, { override: 1, wire: 1 });

  await host.close();
  assert.deepEqual(cleanup, { override: 1, wire: 1 });
});

test("caller and generation aborts settle pending native session, credential, and configuration work", async (context) => {
  const root = await temporaryRoot(context, "rigyn-native-security-abort-");
  const globalKey = "__rigynNativeSecurityAbortApi";
  context.after(() => { delete (globalThis as Record<string, unknown>)[globalKey]; });
  const { host, api } = await captureEntry(root, "native-abort", globalKey, {
    trusted: true,
    permissions: NATIVE_PERMISSIONS,
  });
  const seen = new Map<string, AbortSignal>();
  host.setSessionHandler({
    async readNativeSession(input) {
      assert.ok(input.signal);
      seen.set("session", input.signal);
      return await new Promise<RuntimeNativeSessionPage>(() => {});
    },
  } as RuntimeExtensionSessionHandler);
  host.setNativeHostHandler({
    async resolveCredential(_providerValue, signal) {
      assert.ok(signal);
      seen.set("credential", signal);
      return await new Promise(() => {});
    },
    async getConfiguration(signal) {
      assert.ok(signal);
      seen.set("configuration-get", signal);
      return await new Promise(() => {});
    },
    async updateConfiguration(input) {
      assert.ok(input.signal);
      seen.set("configuration-update", input.signal);
      return await new Promise(() => {});
    },
  } as RuntimeNativeHostHandler);

  const callerCases = [
    ["session", (signal: AbortSignal) => api.native.session.read({ threadId: "native-security-thread", signal })],
    ["credential", (signal: AbortSignal) => api.native.credentials.resolve("native-security-provider", signal)],
    ["configuration-get", (signal: AbortSignal) => api.native.host.getConfiguration(signal)],
    ["configuration-update", (signal: AbortSignal) => api.native.host.updateConfiguration({ scope: "user", patch: {}, signal })],
  ] as const;
  for (const [name, start] of callerCases) {
    const controller = new AbortController();
    const pending = start(controller.signal);
    while (!seen.has(name)) await Promise.resolve();
    controller.abort(new Error(`cancel native ${name}`));
    await assert.rejects(pending, new RegExp(`cancel native ${name}`, "u"));
    assert.equal(seen.get(name)?.aborted, true);
  }

  const pendingOnUnload = api.native.credentials.resolve("native-security-provider");
  while (seen.get("credential")?.aborted === true) await Promise.resolve();
  const generationSignal = seen.get("credential");
  const closing = host.close();
  await assert.rejects(pendingOnUnload, /host closed/u);
  await closing;
  assert.equal(generationSignal?.aborted, true);
});
