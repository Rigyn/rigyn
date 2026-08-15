import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SettingsManager } from "../../src/core/settings-manager.js";
import type {
  ExtensionCommandContextActions,
  ExtensionMode,
} from "../../src/extensions/direct.js";
import { loadDirectExtensions } from "../../src/extensions/runtime.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { AgentSession } from "../../src/service/agent-session.js";
import { SessionManager } from "../../src/storage/session-manager.js";

const surfaces: readonly {
  name: string;
  mode: ExtensionMode;
  ownerManaged: boolean;
}[] = [
  { name: "interactive TUI", mode: "tui", ownerManaged: true },
  { name: "serve", mode: "serve", ownerManaged: true },
  { name: "SDK and configured embedding", mode: "sdk", ownerManaged: false },
  { name: "print text", mode: "print", ownerManaged: true },
  { name: "print JSON", mode: "json", ownerManaged: true },
  { name: "RPC", mode: "rpc", ownerManaged: true },
];

async function within<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 1_000);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

for (const surface of surfaces) {
  test(`prompt-dispatched extension commands can use idle session actions in ${surface.name}`, async (context) => {
    const workspace = await mkdtemp(join(tmpdir(), "rigyn-command-lifecycle-"));
    context.after(async () => await rm(workspace, { recursive: true, force: true }));
    let entered!: () => void;
    let release!: () => void;
    const commandEntered = new Promise<void>((resolve) => { entered = resolve; });
    const commandGate = new Promise<void>((resolve) => { release = resolve; });
    let queuedInputEntered!: () => void;
    let releaseQueuedInput!: () => void;
    const queuedInput = new Promise<void>((resolve) => { queuedInputEntered = resolve; });
    const queuedInputGate = new Promise<void>((resolve) => { releaseQueuedInput = resolve; });
    let queuedInputWasIdle: boolean | undefined;
    let callbackMode: ExtensionMode | undefined;
    let waited = false;
    let transition: { cancelled: boolean } | undefined;
    const host = await loadDirectExtensions([], {
      workspace,
      activationFailure: "throw",
      inlineExtensions: [{
        name: `command-lifecycle-${surface.mode}-${surface.ownerManaged}`,
        factory(api) {
          api.registerCommand("lifecycle", {
            async handler(_args, commandContext) {
              callbackMode = commandContext.mode;
              entered();
              await commandGate;
              await commandContext.waitForIdle();
              waited = true;
              transition = await commandContext.newSession();
            },
          });
          api.on("input", async (event, extensionContext) => {
            if (event.text !== "queued-after-command") return { action: "continue" };
            queuedInputWasIdle = extensionContext.isIdle();
            queuedInputEntered();
            await queuedInputGate;
            return { action: "handled" };
          });
        },
      }],
    });
    context.after(async () => await host.close());
    const session = await AgentSession.create({
      sessionManager: SessionManager.inMemory(workspace),
      providers: new ProviderRegistry([]),
      settingsManager: SettingsManager.inMemory(),
      workspace,
      extensionRunner: host,
    });
    context.after(async () => await session.close());

    let actions: ExtensionCommandContextActions | undefined;
    if (surface.ownerManaged) {
      actions = {
        waitForIdle: async () => await session.waitForIdle(),
        newSession: async () => {
          if (surface.mode === "serve") return { cancelled: true };
          if (!session.isIdle) return { cancelled: true };
          session.newSession();
          return { cancelled: false };
        },
        fork: async () => ({ cancelled: true }),
        navigateTree: async () => ({ cancelled: true }),
        switchSession: async () => ({ cancelled: true }),
        refresh: async () => {},
      };
    }
    await session.bindExtensions({
      mode: surface.mode,
      ...(actions === undefined ? {} : { commandContextActions: actions }),
    });

    const prompt = session.prompt("/lifecycle");
    await commandEntered;
    assert.equal(session.isIdle, false);
    const queuedPrompt = session.prompt("queued-after-command");
    let outsideIdleSettled = false;
    const outsideIdle = session.waitForIdle().then(() => { outsideIdleSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(outsideIdleSettled, false);

    release();
    try {
      await within(prompt, `${surface.name} extension command`);
    } catch (error) {
      await session.abort("command lifecycle test cleanup");
      throw error;
    }
    await within(queuedInput, `${surface.name} queued input admission`);
    assert.equal(queuedInputWasIdle, false);
    assert.equal(session.isIdle, false);
    assert.equal(outsideIdleSettled, false);
    releaseQueuedInput();
    await within(queuedPrompt, `${surface.name} queued input`);
    await within(outsideIdle, `${surface.name} external idle observer`);
    assert.equal(waited, true);
    assert.equal(callbackMode, surface.mode);
    assert.deepEqual(transition, { cancelled: surface.mode === "serve" });
    assert.equal(outsideIdleSettled, true);
    assert.equal(session.isIdle, true);
  });
}

test("AgentSession classifies direct and explicit input origins without coupling them to the host mode", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-input-source-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  const observed: string[] = [];
  const host = await loadDirectExtensions([], {
    workspace,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "input-source-contract",
      factory(api) {
        api.on("input", (event) => {
          observed.push(event.source);
          return { action: "handled" };
        });
      },
    }],
  });
  context.after(async () => await host.close());
  const session = await AgentSession.create({
    sessionManager: SessionManager.inMemory(workspace),
    providers: new ProviderRegistry([]),
    settingsManager: SettingsManager.inMemory(),
    workspace,
    extensionRunner: host,
  });
  context.after(async () => await session.close());
  await session.bindExtensions({ mode: "print" });

  await session.prompt("direct");
  await session.prompt("rpc", { source: "rpc" });
  await session.prompt("serve", { source: "serve" });
  await session.prompt("extension", { source: "extension" });

  assert.deepEqual(observed, ["interactive", "rpc", "serve", "extension"]);
});

test("default embedded session actions forward replacement options and contexts", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-command-replacement-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  const manager = SessionManager.create(workspace, join(workspace, "sessions"));
  const originalPath = manager.getSessionFile();
  assert.ok(originalPath);
  const forkEntry = manager.appendMessage({
    id: "embedded-fork-user",
    role: "user",
    content: [{ type: "text", text: "fork here" }],
    createdAt: "2026-08-09T00:00:00.000Z",
  });
  const calls = { new: 0, fork: 0, switch: 0, failure: 0 };
  const replacementPaths: string[] = [];
  let newParent: string | undefined;
  let failure: unknown;
  const host = await loadDirectExtensions([], {
    workspace,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "embedded-replacement-contract",
      factory(api) {
        api.registerCommand("embedded-transition", {
          async handler(args, commandContext) {
            if (args === "fork") {
              await commandContext.fork(forkEntry, {
                async withSession(replacement) {
                  calls.fork += 1;
                  replacementPaths.push(replacement.sessionManager.getSessionFile() ?? "");
                },
              });
            } else if (args === "switch") {
              await commandContext.switchSession(originalPath, {
                async withSession(replacement) {
                  calls.switch += 1;
                  replacementPaths.push(replacement.sessionManager.getSessionFile() ?? "");
                },
              });
            } else if (args === "new") {
              await commandContext.newSession({
                parentSession: "embedded-parent",
                async withSession(replacement) {
                  calls.new += 1;
                  newParent = replacement.sessionManager.getHeader()?.parentSession;
                },
              });
            } else if (args === "failure") {
              try {
                await commandContext.switchSession(join(workspace, "missing.jsonl"), {
                  async withSession() { calls.failure += 1; },
                });
              } catch (error) {
                failure = error;
              }
            }
          },
        });
      },
    }],
  });
  context.after(async () => await host.close());
  const session = await AgentSession.create({
    sessionManager: manager,
    providers: new ProviderRegistry([]),
    settingsManager: SettingsManager.inMemory(),
    workspace,
    extensionRunner: host,
  });
  context.after(async () => await session.close());
  await session.bindExtensions({ mode: "print" });

  await session.prompt("/embedded-transition fork");
  assert.deepEqual(calls, { new: 0, fork: 1, switch: 0, failure: 0 });
  assert.notEqual(replacementPaths[0], originalPath);
  await session.prompt("/embedded-transition switch");
  assert.deepEqual(calls, { new: 0, fork: 1, switch: 1, failure: 0 });
  assert.equal(replacementPaths[1], originalPath);
  await session.prompt("/embedded-transition new");
  assert.deepEqual(calls, { new: 1, fork: 1, switch: 1, failure: 0 });
  assert.equal(newParent, "embedded-parent");
  await session.prompt("/embedded-transition failure");
  assert.ok(failure instanceof Error);
  assert.deepEqual(calls, { new: 1, fork: 1, switch: 1, failure: 0 });
});

test("default embedded session actions do not expose cancelled replacements", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-command-cancelled-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  const manager = SessionManager.inMemory(workspace);
  const forkEntry = manager.appendMessage({
    id: "embedded-cancelled-user",
    role: "user",
    content: [{ type: "text", text: "cannot persist this fork" }],
    createdAt: "2026-08-09T00:00:00.000Z",
  });
  let callbackCalls = 0;
  let result: { cancelled: boolean } | undefined;
  const host = await loadDirectExtensions([], {
    workspace,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "embedded-cancelled-contract",
      factory(api) {
        api.registerCommand("embedded-cancelled-fork", {
          async handler(_args, commandContext) {
            result = await commandContext.fork(forkEntry, {
              async withSession() { callbackCalls += 1; },
            });
          },
        });
      },
    }],
  });
  context.after(async () => await host.close());
  const session = await AgentSession.create({
    sessionManager: manager,
    providers: new ProviderRegistry([]),
    settingsManager: SettingsManager.inMemory(),
    workspace,
    extensionRunner: host,
  });
  context.after(async () => await session.close());
  await session.bindExtensions({ mode: "print" });

  await session.prompt("/embedded-cancelled-fork");
  assert.deepEqual(result, { cancelled: true });
  assert.equal(callbackCalls, 0);
});
