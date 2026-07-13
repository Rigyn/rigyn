import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { discoverSkills, loadSkill } from "../../src/context/index.js";
import type { EventEnvelope } from "../../src/core/events.js";
import {
  discoverExtensions,
  loadRuntimeExtensions,
  renderExtensionPrompt,
} from "../../src/extensions/index.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { DirectProcessRunner } from "../../src/process/index.js";
import { HarnessService } from "../../src/service/harness.js";
import { SessionStore } from "../../src/storage/store.js";
import { WorkspaceBoundary } from "../../src/tools/index.js";

test("the public reference package activates and completes an offline tool round trip", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "harness-reference-package-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  const extensionFixtures = join(workspace, "extensions");
  await mkdir(extensionFixtures, { recursive: true });
  await cp(resolve("examples/reference-package"), join(extensionFixtures, "reference-package"), { recursive: true });
  const catalog = await discoverExtensions([{
    path: extensionFixtures,
    scope: "user",
    trusted: true,
  }]);
  assert.deepEqual(catalog.list().map((entry) => entry.id), ["reference-package"]);
  const extension = catalog.list().find((entry) => entry.id === "reference-package");
  assert.equal(extension?.status, "active");
  assert.deepEqual(extension?.contributions, {
    skillRoots: 1,
    prompts: 1,
    commands: 0,
    themes: 1,
    runtime: 1,
  });

  const bundle = catalog.bundle();
  assert.match(renderExtensionPrompt(catalog.prompt("reference-review")!, "runtime API"), /runtime API/u);
  assert.equal(catalog.theme("reference-ocean")?.definition.name, "reference-ocean");
  const skill = (await discoverSkills(bundle.skillRoots)).find((entry) => entry.name === "reference-package-guide");
  assert.ok(skill);
  assert.match((await loadSkill(skill)).instructions, /reference_echo/u);

  const host = await loadRuntimeExtensions(bundle.runtime, { workspace });
  context.after(async () => await host.close());
  assert.deepEqual(host.diagnostics(), []);
  assert.deepEqual(host.tools().map((tool) => tool.definition.name), ["reference_echo"]);
  const referenceTool = host.tools()[0]!;
  const toolInput = { text: "package check" };
  referenceTool.validate(toolInput);
  const directResult = await referenceTool.execute(toolInput, {
    workspace: await WorkspaceBoundary.create(workspace),
    runner: new DirectProcessRunner(),
    signal: new AbortController().signal,
    runId: "run-reference-direct",
    threadId: "thread-reference-direct",
  });
  assert.equal(directResult.isError, false);
  assert.equal(directResult.status, "success");
  assert.equal(directResult.summary, "Echoed 13 characters with prefix reference.");
  assert.deepEqual(directResult.nextActions, []);
  assert.equal(directResult.content, "reference:package check");
  assert.deepEqual(host.providers().map((provider) => provider.id), ["reference-offline"]);
  assert.deepEqual(host.commands().map((command) => command.name), ["reference-demo"]);
  assert.deepEqual(host.shortcuts().map((shortcut) => shortcut.shortcut), ["alt+r"]);
  assert.deepEqual(host.flags().map((flag) => ({ name: flag.name, type: flag.type, default: flag.default })), [
    { name: "reference-prefix", type: "string", default: "reference" },
  ]);
  assert.deepEqual(host.renderers().map((renderer) => ({ kind: renderer.kind, key: renderer.key })), [
    { kind: "tool", key: "reference_echo" },
    { kind: "session", key: "1" },
  ]);
  const renderedCall = host.renderToolCall("reference_echo", {
    callId: "reference-call",
    name: "reference_echo",
    input: { text: "package check" },
    status: "running",
    expanded: false,
  }, {
    width: 80,
    height: 24,
    focused: false,
    expanded: false,
    theme: { name: "dark", color: true, unicode: true },
  });
  assert.equal(renderedCall?.lines[0]?.spans.map((span) => span.text).join(""), "◆ reference_echo · package check");
  const renderedResult = host.renderToolResult("reference_echo", {
    callId: "reference-call",
    name: "reference_echo",
    result: { content: "reference:package check", isError: false },
    status: "completed",
    expanded: false,
  }, {
    width: 80,
    height: 24,
    focused: false,
    expanded: false,
    theme: { name: "dark", color: true, unicode: true },
  });
  assert.equal(renderedResult?.lines[0]?.spans.map((span) => span.text).join(""), "✓ reference:package check");
  assert.deepEqual(host.initialUi().map((operation) => operation.type), ["status", "widget", "title", "notify"]);
  assert.deepEqual(await host.completeCommandArguments("reference-demo", "session"), [{
    value: "session check",
    label: "session check",
    detail: "Offline reference prompt",
  }]);

  const store = new SessionStore(":memory:");
  const service = new HarnessService({
    store,
    workspace,
    providers: new ProviderRegistry(host.providers()),
    runtimeExtensions: host,
    extraTools: host.tools(),
    projectTrusted: false,
  });
  await service.initialize({ skills: [] });
  const thread = await service.createSession({ name: "reference package test" });
  const sessionEvents = store.listEvents(thread.threadId);
  const state = sessionEvents.find((entry) => entry.event.type === "extension_state");
  const message = sessionEvents.find((entry) => entry.event.type === "extension_message");
  assert.ok(state?.event.type === "extension_state");
  assert.ok(message?.event.type === "extension_message");
  assert.equal(host.renderExtensionState({
    ...state.event,
    threadId: state.threadId,
    branch: "main",
    eventId: state.eventId,
    timestamp: state.timestamp,
  }, {
    width: 80,
    height: 24,
    focused: false,
    expanded: false,
    theme: { name: "dark", color: true, unicode: true },
  })?.lines[0]?.spans.map((span) => span.text).join(""), "Reference lifecycle · 1 session started");
  assert.equal(host.renderExtensionMessage({
    ...message.event,
    threadId: message.threadId,
    branch: "main",
    eventId: message.eventId,
    timestamp: message.timestamp,
  }, {
    width: 80,
    height: 24,
    focused: false,
    expanded: false,
    theme: { name: "dark", color: true, unicode: true },
  })?.lines[0]?.spans.map((span) => span.text).join(""), "Reference · session 1 ready");

  const ui: string[] = [];
  const command = await host.runCommand("reference-demo", {
    args: "command check",
    threadId: thread.threadId,
    signal: new AbortController().signal,
    ui: {
      notify: (message) => ui.push(`notify:${message}`),
      setStatus: (key, value) => ui.push(`status:${key}:${value ?? ""}`),
      setWidget: (key, value) => ui.push(`widget:${key}:${value ?? ""}`),
      setHeader: (key, value) => ui.push(`header:${key}:${value ?? ""}`),
      setFooter: (key, value) => ui.push(`footer:${key}:${value ?? ""}`),
      setWorkingMessage() {},
      setWorkingVisible() {},
      setTitle: (value) => ui.push(`title:${value}`),
      async getTheme() { return { name: "dark", available: ["dark"] }; },
      async setTheme(name) { return { name, available: [name] }; },
      async select(_prompt, options) { return options[0]!.value; },
      async confirm() { return true; },
      async input() { return undefined; },
      async editor() { return undefined; },
      setEditorText: (value) => { ui.push(`editor:${value}`); },
      getEditorText() { return ""; },
      async custom<T>(): Promise<T | undefined> { return undefined; },
      showOverlay(): never { throw new Error("not used"); },
    },
  });
  assert.deepEqual(command, { handled: true, prompt: "command check" });
  assert.deepEqual(ui, [
    "status:reference:demo queued",
    "widget:reference:Reference demo: command check",
    "title:Rigyn · Reference demo",
    "notify:Reference package prepared an offline tool round trip.",
  ]);
  assert.deepEqual(await host.runShortcut("alt+r", {
    threadId: thread.threadId,
    signal: new AbortController().signal,
    ui: {
      notify: (message) => ui.push(`notify:${message}`),
      setStatus: (key, value) => ui.push(`status:${key}:${value ?? ""}`),
      setWidget: (key, value) => ui.push(`widget:${key}:${value ?? ""}`),
      setHeader: (key, value) => ui.push(`header:${key}:${value ?? ""}`),
      setFooter: (key, value) => ui.push(`footer:${key}:${value ?? ""}`),
      setWorkingMessage() {},
      setWorkingVisible() {},
      setTitle: (value) => ui.push(`title:${value}`),
      async getTheme() { return { name: "dark", available: ["dark"] }; },
      async setTheme(name) { return { name, available: [name] }; },
      async select(_prompt, options) { return options[0]!.value; },
      async confirm() { return true; },
      async input() { return undefined; },
      async editor() { return undefined; },
      setEditorText: (value) => { ui.push(`editor:${value}`); },
      getEditorText() { return ""; },
      async custom<T>(): Promise<T | undefined> { return undefined; },
      showOverlay(): never { throw new Error("not used"); },
    },
  }), { handled: true });
  assert.deepEqual(ui.slice(-2), [
    "editor:reference shortcut check",
    "notify:Reference prompt inserted.",
  ]);

  const events: EventEnvelope[] = [];
  try {
    host.setFlagValue("reference-prefix", "fixture");
    const run = await service.run({
      threadId: thread.threadId,
      prompt: "package check",
      provider: "reference-offline",
      model: "reference-offline-v1",
      onEvent: async (event) => {
        events.push(event);
      },
    });
    assert.equal(
      run.results.at(-1)?.finalText,
      "Reference offline model completed the tool round trip: fixture:package check",
    );
    const completed = events.find((entry) => entry.event.type === "tool_completed");
    assert.equal(completed?.event.type === "tool_completed" ? completed.event.name : undefined, "reference_echo");
    const completedResult = completed?.event.type === "tool_completed" ? completed.event.result : undefined;
    assert.equal(completedResult?.status, "success");
    assert.equal(completedResult?.summary, "Echoed 13 characters with prefix fixture.");
    assert.deepEqual(completedResult?.nextActions ?? [], []);
    const metadata = completed?.event.type === "tool_completed" ? completed.event.result?.metadata : undefined;
    assert.equal(metadata !== null && typeof metadata === "object" && !Array.isArray(metadata) ? metadata.sessionsStarted : undefined, 1);
    assert.ok(
      metadata !== null && typeof metadata === "object" && !Array.isArray(metadata) &&
      typeof metadata.eventsSeen === "number" && metadata.eventsSeen > 0,
    );
  } finally {
    await service.close();
    await host.close();
    store.close();
  }
});
