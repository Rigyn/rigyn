import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import type { AdapterEvent, ProviderRequest } from "../../src/core/types.js";
import {
  discoverExtensions,
  loadRuntimeExtensions,
  type RuntimeCommandUi,
  type RuntimeExtensionStateRecord,
  type RuntimeLiveRegistrationHandler,
} from "../../src/extensions/index.js";
import type { RuntimeExtensionSessionHandler } from "../../src/extensions/runtime.js";
import { reloadExtensionPackage, smokeExtensionPackage } from "../../src/cli/extension-author.js";

const examples = {
  "advanced-ui": "advanced-ui-example",
  "brokered-provider": "brokered-provider-example",
  "child-specialist": "child-specialist-example",
  "paged-memory": "paged-memory-example",
  "prompt-inspector": "prompt-inspector-example",
  "provider-lifecycle": "provider-lifecycle-example",
  "resource-discovery": "resource-discovery-example",
  "review-workflow": "review-workflow-example",
  "session-analytics": "session-analytics-example",
  "session-tools": "session-tools-example",
  "shared-events": "shared-events-example",
  "state-migration": "state-migration-example",
  "reload-safety": "reload-safety-example",
} as const;

test("every protocol example stages, activates, disposes, and repeats activation through author tooling", async () => {
  for (const directory of Object.keys(examples) as Array<keyof typeof examples>) {
    const source = resolve("examples", directory);
    const smoke = await smokeExtensionPackage(source);
    assert.equal(smoke.packageId, examples[directory]);
    assert.equal(smoke.disposed, true);
    const reload = await reloadExtensionPackage(source);
    assert.equal(reload.packageId, examples[directory]);
    assert.equal(reload.reloaded, true);
    assert.equal(reload.disposed, true);
  }
});

async function loadExample(t: TestContext, directory: keyof typeof examples) {
  const workspace = await mkdtemp(join(tmpdir(), `rigyn-${directory}-`));
  const catalog = await discoverExtensions([{ path: resolve("examples"), scope: "user", trusted: true }]);
  const id = examples[directory];
  const entries = catalog.bundle().runtime.filter((entry) => entry.extensionId === id);
  assert.ok(entries.length > 0, JSON.stringify(catalog.doctor()));
  const host = await loadRuntimeExtensions(entries, { workspace });
  t.after(async () => {
    await host.close();
    await rm(workspace, { recursive: true, force: true });
  });
  assert.deepEqual(host.diagnostics(), []);
  return { host, workspace };
}

function commandUi(onStatus?: (key: string, value?: string) => void): RuntimeCommandUi {
  return {
    notify() {},
    setStatus(key, value) { onStatus?.(key, value); },
    setWidget() {},
    setHeader() {},
    setFooter() {},
    setWorkingMessage() {},
    setWorkingVisible() {},
    setTitle() {},
    async getTheme() { return { name: "dark", available: ["dark"] }; },
    async setTheme(name) { return { name, available: [name] }; },
    async select<T>(_prompt: string, options: readonly { value: T }[]) { return options[0]!.value; },
    async confirm() { return true; },
    async input() { return undefined; },
    async editor() { return undefined; },
    setEditorText() {},
    getEditorText() { return ""; },
    async custom<T>(): Promise<T | undefined> { return undefined; },
    showOverlay(): never { throw new Error("not used"); },
  };
}

test("brokered-provider example requests exact-origin authentication without receiving a secret", async (t) => {
  const { host } = await loadExample(t, "brokered-provider");
  const descriptor = host.providerAuth()[0]?.descriptor;
  assert.equal(descriptor?.provider, "brokered-gallery");
  assert.deepEqual(descriptor?.request, {
    origins: ["https://api.example.invalid"],
    apiKey: { header: "x-api-key" },
  });
  const calls: Array<{ provider: string; input: string; init?: RequestInit }> = [];
  host.setLiveRegistrationHandler({
    registerTool() {},
    registerProvider() {},
    registerProviderAuth() {},
    async fetchProvider(provider, input, init, signal) {
      signal?.throwIfAborted();
      calls.push({ provider, input: String(input), ...(init === undefined ? {} : { init }) });
      const headers = new Headers(init?.headers);
      assert.equal(headers.has("authorization"), false);
      assert.equal(headers.has("x-api-key"), false);
      return new Response(JSON.stringify({ text: "brokered response" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  } satisfies RuntimeLiveRegistrationHandler);
  const provider = host.providers().find((entry) => entry.id === "brokered-gallery");
  assert.ok(provider);
  const request = {
    provider: provider.id,
    model: "brokered-v1",
    messages: [{
      id: "message-brokered",
      role: "user",
      content: [{ type: "text", text: "hello" }],
      createdAt: "2026-07-13T00:00:00.000Z",
    }],
    tools: [],
  } as ProviderRequest;
  const events: AdapterEvent[] = [];
  for await (const event of provider.stream(request, new AbortController().signal)) events.push(event);
  assert.equal(events.find((event) => event.type === "text_delta")?.text, "brokered response");
  assert.equal(calls[0]?.provider, "brokered-gallery");
  assert.equal(calls[0]?.input, "https://api.example.invalid/v1/generate");
});

test("shared-events example coordinates two runtime entries inside one host", async (t) => {
  const { host } = await loadExample(t, "shared-events");
  assert.equal(host.extensions().length, 2);
  const result = await host.runCommand("event-pulse", {
    args: "index refreshed",
    threadId: "thread-events",
    branch: "main",
    signal: new AbortController().signal,
    ui: commandUi(),
  });
  assert.deepEqual(result, {
    handled: true,
    prompt: "Acknowledge that the in-process event receiver observed: index refreshed",
  });
  assert.deepEqual(host.initialUi().filter((entry) => entry.type === "status").map((entry) => entry.value), ["received: index refreshed"]);
});

test("state-migration example append-only migrates schema 1 to schema 2 and keeps both renderers", async (t) => {
  const { host } = await loadExample(t, "state-migration");
  let current: RuntimeExtensionStateRecord = {
    type: "extension_state",
    extensionId: "state-migration-example",
    schemaVersion: 1,
    key: "profile",
    value: { label: "Legacy Ada" },
    threadId: "thread-state",
    branch: "main",
    eventId: "event-v1",
    timestamp: "2026-07-13T00:00:00.000Z",
  };
  host.setSessionHandler({
    async readState(input) { return input.schemaVersion === current.schemaVersion ? current : undefined; },
    async compareAndAppendState(input) {
      assert.equal(input.expectedEventId, null);
      current = {
        ...input.event,
        threadId: input.threadId,
        branch: input.branch ?? "main",
        eventId: "event-v2",
        timestamp: "2026-07-13T00:01:00.000Z",
      };
      return { status: "committed", record: current };
    },
  } as RuntimeExtensionSessionHandler);
  const result = await host.runCommand("migrate-profile", {
    args: "ignored for legacy",
    threadId: "thread-state",
    branch: "main",
    signal: new AbortController().signal,
    ui: commandUi(),
  });
  assert.deepEqual(result, { handled: true });
  assert.equal(current.schemaVersion, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(current.value)), { name: "Legacy Ada", tags: [] });
  for (const schemaVersion of [1, 2]) {
    const rendered = host.renderExtensionState({
      ...current,
      schemaVersion,
      value: schemaVersion === 1 ? { label: "old" } : { name: "new", tags: [] },
    }, {
      width: 80,
      height: 24,
      focused: false,
      expanded: false,
      theme: { name: "dark", color: true, unicode: true },
    });
    assert.ok(rendered.lines.length > 0);
  }
});

test("reload-safety example passes repeated activation and a malformed candidate leaves the active host usable", async (t) => {
  const source = resolve("examples/reload-safety");
  assert.equal((await smokeExtensionPackage(source)).disposed, true);
  assert.equal((await reloadExtensionPackage(source)).reloaded, true);

  const copy = await mkdtemp(join(tmpdir(), "rigyn-reload-example-"));
  const packageRoot = join(copy, "reload-safety");
  t.after(async () => await rm(copy, { recursive: true, force: true }));
  await cp(source, packageRoot, { recursive: true });
  const catalog = await discoverExtensions([{ path: copy, scope: "user", trusted: true }]);
  const entries = catalog.bundle().runtime;
  const active = await loadRuntimeExtensions(entries, { workspace: packageRoot });
  t.after(async () => await active.close());
  assert.deepEqual(await active.runCommand("reload-probe", {
    args: "",
    threadId: "thread-reload",
    signal: new AbortController().signal,
    ui: commandUi(),
  }), { handled: true, prompt: "Report that the active extension generation handled this reload probe." });

  await writeFile(join(packageRoot, "runtime", "index.mjs"), "export default function broken( {\n");
  const brokenCatalog = await discoverExtensions([{ path: copy, scope: "user", trusted: true }]);
  const candidate = await loadRuntimeExtensions(brokenCatalog.bundle().runtime, { workspace: packageRoot });
  t.after(async () => await candidate.close());
  assert.match(candidate.diagnostics().map((entry) => entry.message).join("\n"), /failed to import|unexpected|syntax/iu);
  assert.deepEqual(await active.runCommand("reload-probe", {
    args: "",
    threadId: "thread-reload",
    signal: new AbortController().signal,
    ui: commandUi(),
  }), { handled: true, prompt: "Report that the active extension generation handled this reload probe." });
});
