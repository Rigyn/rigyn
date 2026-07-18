import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SkillMetadata } from "../../src/context/skills.js";
import { RuntimeExtensionHost } from "../../src/extensions/runtime.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { HarnessService } from "../../src/service/harness.js";
import { SessionStore } from "../../src/storage/store.js";
import { ScriptedProvider } from "../../src/testing/scripted-provider.js";
import type { HarnessTool } from "../../src/tools/types.js";

async function within<T>(operation: Promise<T>, label: string, timeoutMs = 3_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function recordSessionLifecycle(
  host: RuntimeExtensionHost,
  records: Array<{ event: "session_start" | "session_end"; reason?: string }>,
): void {
  const hasListeners: RuntimeExtensionHost["hasListeners"] = (event) =>
    event === "session_start" || event === "session_end";
  const dispatch: RuntimeExtensionHost["dispatch"] = async (event, value) => {
    if (event !== "session_start" && event !== "session_end") return;
    const reason = (value as { reason?: string }).reason;
    records.push({ event, ...(reason === undefined ? {} : { reason }) });
  };
  host.hasListeners = hasListeners;
  host.dispatch = dispatch;
}

function skill(name: string): SkillMetadata {
  return {
    name,
    description: `${name} description`,
    scope: "user",
    trusted: true,
    rootPath: `/skills/${name}`,
    directory: `/skills/${name}`,
    manifestPath: `/skills/${name}/SKILL.md`,
    metadataTruncated: false,
    metadata: {},
    disableModelInvocation: false,
  };
}

function tool(name: string): HarnessTool {
  return {
    definition: {
      name,
      description: `${name} description`,
      inputSchema: { type: "object", additionalProperties: false },
    },
    validate() {},
    resources() { return []; },
    async execute() { return { content: "ok", isError: false }; },
  } as HarnessTool;
}

test("runtime resources commit as one immutable generation and roll back by pointer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-resource-generation-"));
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const stableProvider = new ScriptedProvider({ id: "stable", models: [{ id: "stable-model" }] });
  const service = new HarnessService({
    store,
    workspace: root,
    providers: new ProviderRegistry([stableProvider]),
    projectTrusted: false,
    managedExtensionLifecycle: false,
  });
  await service.initialize();
  t.after(async () => {
    await service.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const skills = [skill("stable-skill")];
  const extraTools = [tool("stable-tool")];
  const retry = { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100, jitter: 0 };
  const childRuns = { defaultMaxSteps: 3, maxSteps: 4 };
  const packageDiagnostics = ["stable package warning"];
  await service.replaceRuntimeResources({
    providers: new ProviderRegistry([stableProvider]),
    projectTrusted: false,
    skills,
    extraTools,
    outboundImages: "block",
    shellPath: process.platform === "win32" ? "powershell.exe" : "/bin/sh",
    autoCompaction: false,
    compactionRetainRecentTurns: 2,
    compactionToolResultBytes: 4_096,
    retry,
    childRuns,
    resourceCatalog: { packages: [], projectPackages: [], packageDiagnostics },
  }, {
    commit() {
      skills.push(skill("late-skill"));
      extraTools.length = 0;
      packageDiagnostics.push("late package warning");
      retry.maxAttempts = 9;
      childRuns.maxSteps = 99;
    },
  });

  assert.deepEqual(service.skills.map((entry) => entry.name), ["stable-skill"]);
  assert.equal((await service.resourceCatalog()).tools.some((entry) => entry.name === "stable-tool"), true);
  assert.deepEqual(
    (await service.resourceCatalog()).diagnostics.map((entry) => entry.message),
    ["stable package warning"],
  );
  assert.equal((await service.resolveModelSelection("stable-model", { provider: "stable" })).provider, "stable");

  const rejectedProvider = new ScriptedProvider({ id: "rejected", models: [{ id: "rejected-model" }] });
  await assert.rejects(service.replaceRuntimeResources({
    providers: new ProviderRegistry([rejectedProvider]),
    projectTrusted: true,
    skills: [skill("rejected-skill")],
    extraTools: [tool("rejected-tool")],
  }, {
    commit() { throw new Error("reject generation"); },
  }), /reject generation/u);

  assert.deepEqual(service.skills.map((entry) => entry.name), ["stable-skill"]);
  const catalog = await service.resourceCatalog();
  assert.equal(catalog.tools.some((entry) => entry.name === "stable-tool"), true);
  assert.equal(catalog.tools.some((entry) => entry.name === "rejected-tool"), false);
  await assert.rejects(
    service.resolveModelSelection("rejected-model", { provider: "rejected" }),
    /not registered/u,
  );
});

test("resource catalogs finish from the generation captured before model lookup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-resource-catalog-generation-"));
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const stableProvider = new ScriptedProvider({ id: "stable", models: [{ id: "stable-model" }] });
  const stableProviders = new ProviderRegistry([stableProvider]);
  const service = new HarnessService({
    store,
    workspace: root,
    providers: stableProviders,
    projectTrusted: false,
    extraTools: [tool("stable-tool")],
    managedExtensionLifecycle: false,
  });
  await service.initialize({ skills: [skill("stable-skill")] });
  t.after(async () => {
    await service.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  let announceLookup!: () => void;
  const lookupStarted = new Promise<void>((resolve) => { announceLookup = resolve; });
  let releaseLookup!: () => void;
  const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
  const listModels = stableProviders.listModels.bind(stableProviders);
  stableProviders.listModels = async (provider, signal, options = {}) => {
    announceLookup();
    await lookupGate;
    return await listModels(provider, signal, options);
  };

  const pendingCatalog = service.resourceCatalog();
  await lookupStarted;
  const replacementProvider = new ScriptedProvider({ id: "replacement", models: [{ id: "replacement-model" }] });
  const replacement = service.replaceRuntimeResources({
    providers: new ProviderRegistry([replacementProvider]),
    projectTrusted: false,
    skills: [skill("replacement-skill")],
    extraTools: [tool("replacement-tool")],
  });
  releaseLookup();

  const catalog = await pendingCatalog;
  await replacement;
  assert.deepEqual(catalog.providers.map((entry) => entry.id), ["stable"]);
  assert.deepEqual(catalog.skills.map((entry) => entry.name), ["stable-skill"]);
  assert.equal(catalog.tools.some((entry) => entry.name === "stable-tool"), true);
  assert.equal(catalog.tools.some((entry) => entry.name === "replacement-tool"), false);
});

test("runtime reload defers old host cleanup until captured resource catalogs finish", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-resource-catalog-host-"));
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const stableProvider = new ScriptedProvider({ id: "stable", models: [{ id: "stable-model" }] });
  const stableProviders = new ProviderRegistry([stableProvider]);
  const stableHost = new RuntimeExtensionHost(root);
  const replacementHost = new RuntimeExtensionHost(root);
  const service = new HarnessService({
    store,
    workspace: root,
    providers: stableProviders,
    runtimeExtensions: stableHost,
    managedExtensionLifecycle: false,
  });
  await service.initialize();
  t.after(async () => {
    await service.close();
    await stableHost.close();
    await replacementHost.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  let announceLookups!: () => void;
  const lookupsStarted = new Promise<void>((resolve) => { announceLookups = resolve; });
  const releaseLookups: Array<() => void> = [];
  const lookupGates = Array.from({ length: 2 }, () => new Promise<void>((resolve) => releaseLookups.push(resolve)));
  let lookupCount = 0;
  const listModels = stableProviders.listModels.bind(stableProviders);
  stableProviders.listModels = async (provider, signal, options = {}) => {
    const lookup = lookupCount;
    lookupCount += 1;
    if (lookupCount === 2) announceLookups();
    await lookupGates[lookup];
    return await listModels(provider, signal, options);
  };

  const firstCatalog = service.resourceCatalog();
  const secondCatalog = service.resourceCatalog();
  await lookupsStarted;
  let oldHostClosed = false;
  const replacementProvider = new ScriptedProvider({ id: "replacement", models: [{ id: "replacement-model" }] });
  const replacement = service.replaceRuntimeResources({
    providers: new ProviderRegistry([replacementProvider]),
    projectTrusted: false,
    skills: [],
    extraTools: [],
    runtimeExtensions: replacementHost,
  }, {
    async commit() {
      await stableHost.close();
      oldHostClosed = true;
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(oldHostClosed, false);

  releaseLookups[0]!();
  const first = await firstCatalog;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(oldHostClosed, false);
  releaseLookups[1]!();
  const second = await secondCatalog;
  await replacement;
  assert.deepEqual(first.providers.map((entry) => entry.id), ["stable"]);
  assert.deepEqual(second.providers.map((entry) => entry.id), ["stable"]);
  assert.equal(oldHostClosed, true);
  assert.deepEqual((await service.resourceCatalog()).providers.map((entry) => entry.id), ["replacement"]);
});

test("failed resource catalogs release their generation before reload cleanup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-resource-catalog-error-"));
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const stableProvider = new ScriptedProvider({ id: "stable", models: [{ id: "stable-model" }] });
  const stableProviders = new ProviderRegistry([stableProvider]);
  const stableHost = new RuntimeExtensionHost(root);
  const replacementHost = new RuntimeExtensionHost(root);
  const service = new HarnessService({
    store,
    workspace: root,
    providers: stableProviders,
    runtimeExtensions: stableHost,
    managedExtensionLifecycle: false,
  });
  await service.initialize();
  t.after(async () => {
    await service.close();
    await stableHost.close();
    await replacementHost.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  let announceLookup!: () => void;
  const lookupStarted = new Promise<void>((resolve) => { announceLookup = resolve; });
  let releaseLookup!: () => void;
  const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
  stableProviders.listModels = async () => {
    announceLookup();
    await lookupGate;
    throw new Error("catalog lookup failed");
  };

  const pendingCatalog = service.resourceCatalog();
  await lookupStarted;
  let oldHostClosed = false;
  const replacementProvider = new ScriptedProvider({ id: "replacement", models: [{ id: "replacement-model" }] });
  const replacement = service.replaceRuntimeResources({
    providers: new ProviderRegistry([replacementProvider]),
    projectTrusted: false,
    skills: [],
    extraTools: [],
    runtimeExtensions: replacementHost,
  }, {
    async commit() {
      await stableHost.close();
      oldHostClosed = true;
    },
  });
  releaseLookup();

  await assert.rejects(pendingCatalog, /catalog lookup failed/u);
  await replacement;
  assert.equal(oldHostClosed, true);
  assert.deepEqual((await service.resourceCatalog()).providers.map((entry) => entry.id), ["replacement"]);
});

test("resource catalog abort releases its lease when model lookup ignores the signal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-resource-catalog-abort-"));
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const provider = new ScriptedProvider({ id: "stable", models: [{ id: "stable-model" }] });
  const providers = new ProviderRegistry([provider]);
  const service = new HarnessService({
    store,
    workspace: root,
    providers,
    managedExtensionLifecycle: false,
  });
  await service.initialize();
  t.after(async () => {
    await service.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  let announceLookup!: () => void;
  const lookupStarted = new Promise<void>((resolve) => { announceLookup = resolve; });
  let releaseLookup!: () => void;
  const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
  let announceSettled!: () => void;
  const lookupSettled = new Promise<void>((resolve) => { announceSettled = resolve; });
  providers.listModels = async () => {
    announceLookup();
    await lookupGate;
    announceSettled();
    return [];
  };

  const pendingCatalog = service.resourceCatalog(AbortSignal.timeout(100));
  await lookupStarted;
  await assert.rejects(within(pendingCatalog, "catalog signal cancellation"), /abort|timeout/iu);
  await within(service.close(), "close after catalog signal cancellation");
  releaseLookup();
  await lookupSettled;
});

test("model lookup cancellation does not expire a retained run handoff", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-model-selection-lifetime-"));
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const provider = new ScriptedProvider({ id: "stable", models: [{ id: "stable-model" }] });
  const service = new HarnessService({
    store,
    workspace: root,
    providers: new ProviderRegistry([provider]),
    managedExtensionLifecycle: false,
  });
  await service.initialize();
  t.after(async () => {
    await service.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const lifetime = new AbortController();
  const lookup = new AbortController();
  const retained = await service.resolveModelSelection("stable-model", {
    provider: "stable",
    signal: lifetime.signal,
    lookupSignal: lookup.signal,
    retainGeneration: true,
  });
  lookup.abort(new Error("lookup deadline elapsed after resolution"));
  assert.equal(retained.signal.aborted, false);
  try {
    await assert.rejects(service.replaceRuntimeResources({
      providers: new ProviderRegistry([]),
      projectTrusted: false,
      skills: [],
      extraTools: [],
    }), /run is starting/u);
  } finally {
    retained.release();
  }
});

test("an aborted retained model selection releases itself before service close", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-model-selection-abandoned-"));
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const provider = new ScriptedProvider({ id: "stable", models: [{ id: "stable-model" }] });
  const service = new HarnessService({
    store,
    workspace: root,
    providers: new ProviderRegistry([provider]),
    managedExtensionLifecycle: false,
  });
  await service.initialize();
  t.after(async () => {
    await service.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const lifetime = new AbortController();
  const retained = await service.resolveModelSelection("stable-model", {
    provider: "stable",
    signal: lifetime.signal,
    lookupSignal: AbortSignal.timeout(30_000),
    retainGeneration: true,
  });
  lifetime.abort(new Error("caller abandoned the retained selection"));
  assert.equal(retained.signal.aborted, true);
  await within(service.close(), "close after abandoned retained selection");
});

test("reload aborts a non-settling catalog reader before old-generation cleanup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-resource-catalog-hung-reload-"));
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const stableProvider = new ScriptedProvider({ id: "stable", models: [{ id: "stable-model" }] });
  const stableProviders = new ProviderRegistry([stableProvider]);
  const stableHost = new RuntimeExtensionHost(root);
  const replacementHost = new RuntimeExtensionHost(root);
  const service = new HarnessService({
    store,
    workspace: root,
    providers: stableProviders,
    runtimeExtensions: stableHost,
    managedExtensionLifecycle: false,
  });
  await service.initialize();
  t.after(async () => {
    await service.close();
    await stableHost.close();
    await replacementHost.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  let announceLookup!: () => void;
  const lookupStarted = new Promise<void>((resolve) => { announceLookup = resolve; });
  let releaseLookup!: () => void;
  const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
  let announceSettled!: () => void;
  const lookupSettled = new Promise<void>((resolve) => { announceSettled = resolve; });
  const listModels = stableProviders.listModels.bind(stableProviders);
  stableProviders.listModels = async (provider, signal, options = {}) => {
    announceLookup();
    await lookupGate;
    announceSettled();
    return await listModels(provider, signal, options);
  };

  const pendingCatalog = service.resourceCatalog(new AbortController().signal);
  await lookupStarted;
  let oldHostClosed = false;
  const replacementProvider = new ScriptedProvider({ id: "replacement", models: [{ id: "replacement-model" }] });
  const replacement = service.replaceRuntimeResources({
    providers: new ProviderRegistry([replacementProvider]),
    projectTrusted: false,
    skills: [],
    extraTools: [],
    runtimeExtensions: replacementHost,
  }, {
    async commit() {
      await stableHost.close();
      oldHostClosed = true;
    },
  });

  await assert.rejects(within(pendingCatalog, "hung catalog cancellation"), /resources are reloading/u);
  await within(replacement, "reload after hung catalog");
  assert.equal(oldHostClosed, true);
  releaseLookup();
  await lookupSettled;
});

test("close aborts a non-settling catalog reader and remains bounded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-resource-catalog-hung-close-"));
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const provider = new ScriptedProvider({ id: "stable", models: [{ id: "stable-model" }] });
  const providers = new ProviderRegistry([provider]);
  const host = new RuntimeExtensionHost(root);
  const service = new HarnessService({
    store,
    workspace: root,
    providers,
    runtimeExtensions: host,
    managedExtensionLifecycle: false,
  });
  await service.initialize();
  t.after(async () => {
    await service.close();
    await host.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  let announceLookup!: () => void;
  const lookupStarted = new Promise<void>((resolve) => { announceLookup = resolve; });
  let releaseLookup!: () => void;
  const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
  let announceSettled!: () => void;
  const lookupSettled = new Promise<void>((resolve) => { announceSettled = resolve; });
  providers.listModels = async () => {
    announceLookup();
    await lookupGate;
    announceSettled();
    return [];
  };

  const pendingCatalog = service.resourceCatalog(new AbortController().signal);
  await lookupStarted;
  const closing = service.close();
  await assert.rejects(within(pendingCatalog, "hung catalog close cancellation"), /service is closing/u);
  await within(closing, "close after hung catalog");
  releaseLookup();
  await lookupSettled;
});

test("pre-aborted and busy reloads keep extension session lifecycle balanced", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-resource-lifecycle-balance-"));
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const provider = new ScriptedProvider({
    id: "stable",
    models: [{ id: "stable-model" }],
    scripts: [{
      kind: "turn",
      content: [{ type: "text", text: "completed" }],
      eventDelayMs: 50,
    }],
  });
  const host = new RuntimeExtensionHost(root);
  const replacementHost = new RuntimeExtensionHost(root);
  const lifecycle: Array<{ event: "session_start" | "session_end"; reason?: string }> = [];
  recordSessionLifecycle(host, lifecycle);
  const service = new HarnessService({
    store,
    workspace: root,
    providers: new ProviderRegistry([provider]),
    runtimeExtensions: host,
  });
  await service.initialize();
  const thread = await service.createSession({ threadId: "lifecycle-session" });
  lifecycle.length = 0;
  t.after(async () => {
    await service.close();
    await host.close();
    await replacementHost.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const resources = {
    providers: new ProviderRegistry([new ScriptedProvider({ id: "replacement", models: [{ id: "replacement-model" }] })]),
    projectTrusted: false,
    skills: [],
    extraTools: [],
    runtimeExtensions: replacementHost,
  };
  const aborted = new AbortController();
  aborted.abort(new Error("reload already cancelled"));
  await assert.rejects(service.replaceRuntimeResources(resources, { signal: aborted.signal }), /already cancelled/u);
  assert.deepEqual(lifecycle, []);

  const running = service.run({
    threadId: thread.threadId,
    prompt: "keep reload busy",
    provider: provider.id,
    model: "stable-model",
  });
  await assert.rejects(service.replaceRuntimeResources(resources), /run is active/u);
  assert.deepEqual(lifecycle, []);
  await running;
});

test("service close waits for resource catalog readers and remains awaitably idempotent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-resource-catalog-close-"));
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const provider = new ScriptedProvider({ id: "stable", models: [{ id: "stable-model" }] });
  const providers = new ProviderRegistry([provider]);
  const host = new RuntimeExtensionHost(root);
  const service = new HarnessService({
    store,
    workspace: root,
    providers,
    runtimeExtensions: host,
    managedExtensionLifecycle: false,
  });
  await service.initialize();
  t.after(async () => {
    await service.close();
    await host.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  let announceLookup!: () => void;
  const lookupStarted = new Promise<void>((resolve) => { announceLookup = resolve; });
  let releaseLookup!: () => void;
  const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
  const listModels = providers.listModels.bind(providers);
  providers.listModels = async (selected, signal, options = {}) => {
    announceLookup();
    await lookupGate;
    return await listModels(selected, signal, options);
  };

  const pendingCatalog = service.resourceCatalog();
  await lookupStarted;
  let closed = false;
  const firstClose = service.close().then(() => { closed = true; });
  const secondClose = service.close();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);

  releaseLookup();
  assert.deepEqual((await pendingCatalog).providers.map((entry) => entry.id), ["stable"]);
  await Promise.all([firstClose, secondClose]);
  assert.equal(closed, true);
});

test("twenty-five resource swaps expose only the active generation and dispose every retired host", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-resource-generation-soak-"));
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const records: Array<{ host: RuntimeExtensionHost; id: string; closeCount: number; closed: boolean }> = [];
  const trackedHost = (id: string) => {
    const host = new RuntimeExtensionHost(root);
    const record = { host, id, closeCount: 0, closed: false };
    const close = host.close.bind(host);
    host.close = async () => {
      if (!record.closed) {
        record.closed = true;
        record.closeCount += 1;
      }
      await close();
    };
    records.push(record);
    return record;
  };

  let active = trackedHost("generation-0");
  const initialProvider = new ScriptedProvider({ id: "generation-0", models: [{ id: "model-0" }] });
  const service = new HarnessService({
    store,
    workspace: root,
    providers: new ProviderRegistry([initialProvider]),
    runtimeExtensions: active.host,
    projectTrusted: false,
    managedExtensionLifecycle: false,
  });
  await service.initialize({ skills: [skill("skill-0")] });
  t.after(async () => {
    await service.close();
    await Promise.all(records.map(async (record) => await record.host.close()));
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  for (let generation = 1; generation <= 25; generation += 1) {
    const previous = active;
    const next = trackedHost(`generation-${generation}`);
    const provider = new ScriptedProvider({
      id: `generation-${generation}`,
      models: [{ id: `model-${generation}` }],
    });
    await within(service.replaceRuntimeResources({
      providers: new ProviderRegistry([provider]),
      projectTrusted: false,
      skills: [skill(`skill-${generation}`)],
      extraTools: [tool(`tool-${generation}`)],
      runtimeExtensions: next.host,
    }, {
      async commit() {
        await previous.host.close();
      },
    }), `resource swap ${generation}`);
    active = next;

    const catalog = await within(service.resourceCatalog(), `resource catalog ${generation}`);
    assert.deepEqual(catalog.providers.map((entry) => entry.id), [`generation-${generation}`]);
    assert.deepEqual(catalog.skills.map((entry) => entry.name), [`skill-${generation}`]);
    assert.equal(catalog.tools.some((entry) => entry.name === `tool-${generation}`), true);
    if (generation > 1) {
      assert.equal(catalog.tools.some((entry) => entry.name === `tool-${generation - 1}`), false);
    }
    assert.equal(previous.closeCount, 1);
  }

  assert.deepEqual(records.slice(0, -1).map((record) => record.closeCount), Array(25).fill(1));
  assert.equal(active.closeCount, 0);
  await within(service.close(), "service close after generation soak");
  await within(active.host.close(), "active host close after generation soak");
  assert.equal(active.closeCount, 1);
});
