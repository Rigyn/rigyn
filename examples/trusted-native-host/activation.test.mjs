import assert from "node:assert/strict";
import test from "node:test";

import activate from "./runtime/index.mjs";

test("trusted native example keeps privileged effects explicit, redacted, and disposable", async () => {
  const commands = new Map();
  const notices = [];
  const disposed = [];
  const wires = [];
  const overrides = [];
  let disposeAll;
  activate({
    native: {
      ui: {
        mountWidget(factory) {
          const mount = factory()({ requestRender() {} });
          assert.equal(mount.render({ theme: { name: "mono" } }).lines.length, 1);
          return () => disposed.push("widget");
        },
        onInput(handler) {
          assert.deepEqual(handler({ key: "a" }), { action: "pass" });
          return () => disposed.push("input");
        },
        currentTheme() { return { name: "mono" }; },
      },
      host: {
        async getConfiguration() {
          return { workspace: "/workspace", projectTrusted: true, effective: { theme: "mono" } };
        },
        async updateConfiguration(input) {
          return { workspace: "/workspace", projectTrusted: true, effective: input.patch };
        },
      },
      session: {
        async read(input) {
          return {
            thread: { threadId: input.threadId },
            branch: input.branch ?? "main",
            events: [],
            runs: [],
            nextSequence: 1,
            snapshotSequence: 1,
            hasMore: false,
          };
        },
        async getSystemPrompt() { return { systemPrompt: "secret prompt", composition: { layers: [] } }; },
      },
      credentials: {
        async resolve(provider) {
          return {
            provider,
            source: "test",
            credential: { kind: "api_key", apiKey: "must-not-render" },
            headers: { authorization: "must-not-render" },
          };
        },
      },
      providers: {
        intercept(provider, interceptor) {
          wires.push(provider);
          interceptor.observeResponse({ provider, status: 200, requestId: "request-1" });
          return async () => disposed.push(`wire:${provider}`);
        },
        override(provider) {
          overrides.push(provider.id);
          return async () => disposed.push(`override:${provider.id}`);
        },
      },
    },
    registerCommand(command) { commands.set(command.name, command); },
    onDispose(handler) { disposeAll = handler; },
  });

  const context = {
    args: "sample-provider",
    workspace: "/workspace",
    threadId: "thread-1",
    branch: "main",
    signal: new AbortController().signal,
    ui: { notify(message) { notices.push(message); } },
  };
  const report = await commands.get("native-inspect").execute(context);
  assert.match(report, /"kind": "api_key"/u);
  assert.doesNotMatch(report, /must-not-render/u);
  await commands.get("native-wire").execute(context);
  assert.deepEqual(wires, ["sample-provider"]);
  await commands.get("native-override").execute(context);
  assert.deepEqual(overrides, ["sample-provider"]);
  await commands.get("native-theme-config").execute({ ...context, args: "dark" });
  assert.equal(notices.some((value) => value.includes("dark")), true);

  await disposeAll();
  assert.deepEqual(disposed.sort(), ["input", "override:sample-provider", "widget", "wire:sample-provider"].sort());
});
