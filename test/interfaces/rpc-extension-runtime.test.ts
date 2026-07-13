import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRuntimeExtensions } from "../../src/extensions/runtime.js";
import type { RpcExtensionUiRequest } from "../../src/interfaces/rpc-extension-ui.js";
import { RpcRuntimeDispatcher, type RpcRuntimePeer } from "../../src/interfaces/rpc-runtime.js";
import type { RpcRequest } from "../../src/interfaces/rpc.js";
import { sha256 } from "../../src/tools/hash.js";
import { QueueProvider, createTestRuntime } from "./rpc-helpers.js";

function request(method: string, params?: unknown): RpcRequest {
  return { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) };
}

class UiPeer implements RpcRuntimePeer {
  readonly id: string;
  readonly notifications: Array<{ method: string; params?: unknown }> = [];

  constructor(id: string) {
    this.id = id;
  }

  async notification(method: string, params?: unknown): Promise<void> {
    this.notifications.push({ method, ...(params === undefined ? {} : { params }) });
  }

  async nextUi(method?: RpcExtensionUiRequest["method"]): Promise<RpcExtensionUiRequest> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const index = this.notifications.findIndex((entry) => {
        if (entry.method !== "extension.ui.request") return false;
        return method === undefined || (entry.params as RpcExtensionUiRequest).method === method;
      });
      if (index >= 0) return this.notifications.splice(index, 1)[0]!.params as RpcExtensionUiRequest;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(`Timed out waiting for extension UI ${method ?? "request"}`);
  }
}

async function fixture(
  context: { after(callback: () => void | Promise<void>): void },
  requestShutdown?: () => void,
) {
  const root = await mkdtemp(join(tmpdir(), "harness-rpc-extension-ui-"));
  const source = `export default (api) => {
    api.ui.setStatus("ready", "loaded");
    api.ui.setWidget("intro", "extension ready");
    api.ui.setTitle("Extension workspace");
    api.ui.notify("Extension loaded");
    api.registerCommand({
      name: "rpc-dialogs",
      description: "Exercise the RPC UI bridge",
      async execute(ctx) {
        const selected = await ctx.ui.select("Choose", [
          { label: "Alpha", value: "alpha", detail: "first" },
          { label: "Beta", value: "beta" },
        ], ctx.signal);
        const confirmed = await ctx.ui.confirm("Confirm", "Continue?", ctx.signal);
        const input = await ctx.ui.input("Input", "placeholder", ctx.signal);
        const edited = await ctx.ui.editor("Editor", "prefill", ctx.signal);
        ctx.ui.notify("dialogs complete", "warning");
        ctx.ui.setStatus("run", "done");
        ctx.ui.setWidget("result", selected + ":" + input);
        ctx.ui.setTitle("Complete");
        ctx.ui.setEditorText(edited ?? "");
        return { prompt: JSON.stringify({ selected, confirmed, input, edited, editorText: ctx.ui.getEditorText() }) };
      },
    });
    api.registerCommand({
      name: "rpc-wait",
      async execute(ctx) {
        await ctx.ui.input("Waiting", undefined, ctx.signal);
      },
    });
    api.registerCommand({
      name: "rpc-shutdown",
      async execute() {
        return { prompt: JSON.stringify(await api.requestShutdown({ reason: "rpc extension complete" })) };
      },
    });
  };\n`;
  const path = join(root, "extension.mjs");
  await writeFile(path, source);
  const runtimeExtensions = await loadRuntimeExtensions([{
    extensionId: "rpc-fixture",
    sourcePath: path,
    sha256: sha256(source),
  }], { workspace: root });
  const base = await createTestRuntime(root, join(root, "sessions.sqlite"), new QueueProvider([]));
  const runtime = { ...base, runtimeExtensions };
  const dispatcher = new RpcRuntimeDispatcher({
    runtime,
    ...(requestShutdown === undefined ? {} : { requestShutdown }),
  });
  context.after(async () => {
    await dispatcher.close("test complete");
    await runtimeExtensions.close();
    await base.close();
  });
  context.after(async () => await rm(root, { recursive: true, force: true }));
  return { dispatcher, runtimeExtensions };
}

test("RPC dispatcher runs extension commands through every supported UI interaction", async (context) => {
  const { dispatcher } = await fixture(context);
  const peer = new UiPeer("owner");
  const commands = await dispatcher.dispatch(peer, request("extension.command.list")) as Array<Record<string, unknown>>;
  assert.deepEqual(commands.map((entry) => entry.name), ["rpc-dialogs", "rpc-wait", "rpc-shutdown"]);
  assert.equal(commands.some((entry) => "sourcePath" in entry), false);

  const running = dispatcher.dispatch(peer, request("extension.command.run", {
    name: "rpc-dialogs",
    args: "",
    operationId: "dialog-operation",
    timeoutMs: 1_000,
  }));
  const select = await peer.nextUi("select");
  assert.equal(select.method, "select");
  assert.deepEqual(select.method === "select" ? select.options : [], [
    { id: "0", label: "Alpha", detail: "first" },
    { id: "1", label: "Beta" },
  ]);
  await dispatcher.dispatch(peer, request("extension.ui.respond", { id: select.id, value: "1" }));

  const confirm = await peer.nextUi("confirm");
  await dispatcher.dispatch(peer, request("extension.ui.respond", { id: confirm.id, confirmed: true }));
  const input = await peer.nextUi("input");
  await dispatcher.dispatch(peer, request("extension.ui.respond", { id: input.id, value: "typed" }));
  const editor = await peer.nextUi("editor");
  await dispatcher.dispatch(peer, request("extension.ui.respond", { id: editor.id, value: "edited" }));

  const result = await running as {
    operationId: string;
    threadId: string;
    branch: string;
    handled: boolean;
    prompt: string;
  };
  assert.equal(result.operationId, "dialog-operation");
  assert.equal(result.handled, true);
  assert.deepEqual(JSON.parse(result.prompt), {
    selected: "beta",
    confirmed: true,
    input: "typed",
    edited: "edited",
    editorText: "edited",
  });
  const presentation = peer.notifications
    .filter((entry) => entry.method === "extension.ui.request")
    .map((entry) => (entry.params as RpcExtensionUiRequest).method);
  assert.deepEqual(presentation, ["notify", "status", "widget", "title", "editor_text"]);
  assert.equal((await dispatcher.dispatch(peer, request("extension.ui.editorText.get")) as { value: string }).value, "edited");
  await dispatcher.dispatch(peer, request("extension.ui.editorText.update", { value: "remote" }));
  assert.equal((await dispatcher.dispatch(peer, request("extension.ui.editorText.get")) as { value: string }).value, "remote");
});

test("RPC host acknowledges or rejects extension-requested graceful shutdown by policy", async (context) => {
  const denied = await fixture(context);
  const deniedResult = await denied.dispatcher.dispatch(new UiPeer("denied"), request("extension.command.run", {
    name: "rpc-shutdown",
    operationId: "shutdown-denied",
  })) as { prompt: string };
  assert.deepEqual(JSON.parse(deniedResult.prompt), {
    requestId: JSON.parse(deniedResult.prompt).requestId,
    acknowledged: true,
    accepted: false,
    message: "The RPC host does not permit extension-requested shutdown.",
  });

  let requested = 0;
  const accepted = await fixture(context, () => { requested += 1; });
  const acceptedResult = await accepted.dispatcher.dispatch(new UiPeer("accepted"), request("extension.command.run", {
    name: "rpc-shutdown",
    operationId: "shutdown-accepted",
  })) as { prompt: string };
  const acknowledgement = JSON.parse(acceptedResult.prompt) as Record<string, unknown>;
  assert.equal(acknowledgement.acknowledged, true);
  assert.equal(acknowledgement.accepted, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(requested, 1);
});

test("RPC dispatcher replays initial UI once, forwards live UI, and advertises the bridge", async (context) => {
  const { dispatcher, runtimeExtensions } = await fixture(context);
  const peer = new UiPeer("initialized");
  const initialized = await dispatcher.dispatch(peer, request("initialize")) as {
    capabilities: { extensionUi: { interactive: string[]; presentation: string[] } };
  };
  assert.deepEqual(initialized.capabilities.extensionUi.interactive, [
    "select", "confirm", "input", "editor", "theme_get", "theme_set",
  ]);
  assert.deepEqual(initialized.capabilities.extensionUi.presentation, [
    "notify", "status", "widget", "header", "footer", "working_message", "working_visible", "title", "editor_text",
  ]);
  assert.deepEqual([
    (await peer.nextUi()).method,
    (await peer.nextUi()).method,
    (await peer.nextUi()).method,
    (await peer.nextUi()).method,
  ], ["status", "widget", "title", "notify"]);
  await dispatcher.dispatch(peer, request("initialize"));
  assert.equal(peer.notifications.filter((entry) => entry.method === "extension.ui.request").length, 0);
  runtimeExtensions.applyUi({ extensionId: "rpc-fixture", type: "status", key: "live", value: "now" });
  const live = await peer.nextUi("status");
  assert.equal(live.method === "status" ? live.value : undefined, "now");
});

test("RPC extension command cancellation is owner-scoped and rejects pending UI", async (context) => {
  const { dispatcher } = await fixture(context);
  const owner = new UiPeer("owner");
  const other = new UiPeer("other");
  const running = dispatcher.dispatch(owner, request("extension.command.run", {
    name: "rpc-wait",
    operationId: "wait-operation",
    timeoutMs: 1_000,
  }));
  const pending = await owner.nextUi("input");
  await assert.rejects(
    dispatcher.dispatch(other, request("extension.ui.respond", { id: pending.id, value: "stolen" })),
    /Unknown extension UI request/u,
  );
  await assert.rejects(
    dispatcher.dispatch(other, request("extension.command.cancel", { operationId: "wait-operation" })),
    /Unknown extension command operation/u,
  );
  assert.deepEqual(await dispatcher.dispatch(owner, request("extension.command.cancel", {
    operationId: "wait-operation",
  })), { accepted: true });
  await assert.rejects(running, /cancelled by RPC client/u);
  await assert.rejects(
    dispatcher.dispatch(owner, request("extension.ui.respond", { id: pending.id, value: "late" })),
    /Unknown extension UI request/u,
  );
});

test("RPC dispatcher shutdown drains extension commands and clears their pending UI", async (context) => {
  const { dispatcher } = await fixture(context);
  const peer = new UiPeer("drain-owner");
  const running = dispatcher.dispatch(peer, request("extension.command.run", {
    name: "rpc-wait",
    operationId: "drain-operation",
    timeoutMs: 1_000,
  }));
  const pending = await peer.nextUi("input");
  await dispatcher.close("dispatcher draining", 1_000);
  await assert.rejects(running, /dispatcher draining/u);
  await assert.rejects(
    dispatcher.dispatch(peer, request("extension.ui.respond", { id: pending.id, value: "late" })),
    /shutting down/u,
  );
});
