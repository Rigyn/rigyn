import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";

import { RpcExtensionUiBridge } from "../../src/interfaces/rpc-extension-ui.js";
import type { RpcExtensionUiRequest } from "../../src/interfaces/rpc-protocol.js";

function capture() {
  const requests: RpcExtensionUiRequest[] = [];
  const bridge = new RpcExtensionUiBridge({ emit(request) { requests.push(request); } });
  return { bridge, requests };
}

async function within<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation did not settle within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("RPC extension dialogs use exact request and response records", async () => {
  const { bridge, requests } = capture();
  const ui = bridge.context("extension", new AbortController().signal);

  const selected = ui.select("Choose", ["one", "two"], { timeout: 1_000 });
  assert.deepEqual(requests[0], {
    type: "extension_ui_request",
    id: requests[0]!.id,
    method: "select",
    title: "Choose",
    options: ["one", "two"],
    timeout: 1_000,
  });
  assert.equal(bridge.handle({ type: "extension_ui_response", id: requests[0]!.id, value: "two" }), true);
  assert.equal(await selected, "two");

  const confirmed = ui.confirm("Proceed", "Continue?");
  assert.equal(requests[1]?.method, "confirm");
  bridge.handle({ type: "extension_ui_response", id: requests[1]!.id, confirmed: true });
  assert.equal(await confirmed, true);

  const input = ui.input("Name", "optional");
  assert.equal(requests[2]?.method, "input");
  bridge.handle({ type: "extension_ui_response", id: requests[2]!.id, cancelled: true });
  assert.equal(await input, undefined);

  const editor = ui.editor("Draft", "prefill");
  assert.equal(requests[3]?.method, "editor");
  bridge.handle({ type: "extension_ui_response", id: requests[3]!.id, value: "edited" });
  assert.equal(await editor, "edited");
  assert.equal(bridge.handle({ type: "extension_ui_response", id: "missing", cancelled: true }), false);
  bridge.close();
});

test("RPC extension presentation emits only the supported structural UI records", () => {
  const { bridge, requests } = capture();
  const ui = bridge.context("extension", new AbortController().signal);
  ui.notify("Ready", "warning");
  ui.setStatus("build", "Running");
  ui.setWidget("summary", ["one", "two"], { placement: "belowEditor" });
  ui.setTitle("Workspace");
  ui.setEditorText("draft");
  assert.equal(ui.getEditorText(), "draft");
  assert.deepEqual(requests.map((request) => request.method), [
    "notify", "setStatus", "setWidget", "setTitle", "set_editor_text",
  ]);
  assert.deepEqual(requests[2], {
    type: "extension_ui_request",
    id: requests[2]!.id,
    method: "setWidget",
    widgetKey: "extension:summary",
    widgetLines: ["one", "two"],
    widgetPlacement: "belowEditor",
  });
  assert.equal(ui.setTheme("dark").success, false);
  assert.deepEqual(ui.getAllThemes(), []);
  bridge.close();
});

test("RPC no-op callback facades retain no generation listeners and keyed owners stay bounded", () => {
  const { bridge, requests } = capture();
  const generation = new AbortController();
  for (let index = 0; index < 1_000; index += 1) {
    bridge.context("extension", generation.signal);
  }
  assert.equal(getEventListeners(generation.signal, "abort").length, 0);

  const first = bridge.context("extension", generation.signal);
  first.setStatus("phase", "first");
  assert.equal(getEventListeners(generation.signal, "abort").length, 1);
  first.setStatus("phase", "updated");
  assert.equal(getEventListeners(generation.signal, "abort").length, 1);
  const newer = bridge.context("extension", generation.signal);
  newer.setStatus("phase", "newer");
  newer.setWidget("summary", ["visible"]);
  assert.equal(getEventListeners(generation.signal, "abort").length, 2);

  generation.abort(new Error("generation ended"));
  assert.equal(getEventListeners(generation.signal, "abort").length, 0);
  assert.deepEqual(requests.slice(-2).map((request) => request.method === "setStatus"
    ? [request.statusKey, request.statusText]
    : request.method === "setWidget"
      ? [request.widgetKey, request.widgetLines]
      : undefined), [
    ["extension:phase", undefined],
    ["extension:summary", undefined],
  ]);
  bridge.close();
});

test("RPC keyed presentation isolates owners and clears only the ending owner", () => {
  const { bridge, requests } = capture();
  const firstGeneration = new AbortController();
  const secondGeneration = new AbortController();
  const first = bridge.context("owner-a", firstGeneration.signal);
  const second = bridge.context("owner-b", secondGeneration.signal);

  first.setStatus("phase", "first");
  first.setWidget("summary", ["first"]);
  second.setStatus("phase", "second");
  second.setWidget("summary", ["second"]);
  assert.deepEqual(requests.slice(-4).map((request) =>
    request.method === "setStatus" ? request.statusKey : request.method === "setWidget" ? request.widgetKey : undefined), [
    "owner-a:phase",
    "owner-a:summary",
    "owner-b:phase",
    "owner-b:summary",
  ]);

  secondGeneration.abort(new Error("owner-b ended"));
  assert.deepEqual(requests.slice(-2).map((request) => {
    if (request.method === "setStatus") return [request.statusKey, request.statusText];
    if (request.method === "setWidget") return [request.widgetKey, request.widgetLines];
    return undefined;
  }), [
    ["owner-b:phase", undefined],
    ["owner-b:summary", undefined],
  ]);
  assert.equal(requests.some((request) =>
    request.method === "setStatus" && request.statusKey === "owner-a:phase" && request.statusText === undefined), false);
  assert.equal(requests.some((request) =>
    request.method === "setWidget" && request.widgetKey === "owner-a:summary" && request.widgetLines === undefined), false);

  firstGeneration.abort(new Error("owner-a ended"));
  bridge.close();
});

test("RPC cleanup cannot erase a newer context for the same owner", () => {
  const { bridge, requests } = capture();
  const olderGeneration = new AbortController();
  const newerGeneration = new AbortController();
  const older = bridge.context("owner", olderGeneration.signal);
  const newer = bridge.context("owner", newerGeneration.signal);

  older.setStatus("phase", "old");
  older.setWidget("summary", ["old"]);
  newer.setStatus("phase", "new");
  newer.setWidget("summary", ["new"]);
  assert.equal(getEventListeners(olderGeneration.signal, "abort").length, 0);
  assert.equal(getEventListeners(newerGeneration.signal, "abort").length, 2);
  const beforeOlderAbort = requests.length;
  olderGeneration.abort(new Error("older context ended"));
  assert.equal(requests.length, beforeOlderAbort);
  assert.throws(() => older.setStatus("phase", undefined), /older context ended/u);
  assert.equal(requests.length, beforeOlderAbort);

  newerGeneration.abort(new Error("newer context ended"));
  assert.deepEqual(requests.slice(-2).map((request) => request.method === "setStatus"
    ? [request.statusKey, request.statusText]
    : request.method === "setWidget"
      ? [request.widgetKey, request.widgetLines]
      : undefined), [
    ["owner:phase", undefined],
    ["owner:summary", undefined],
  ]);
  bridge.close();
});

test("RPC extension dialogs resolve to their cancellation defaults on abort and close", async () => {
  const { bridge } = capture();
  const controller = new AbortController();
  const ui = bridge.context("extension", controller.signal);
  const input = ui.input("Wait");
  controller.abort();
  assert.equal(await input, undefined);
  assert.equal(bridge.pendingCount, 0);

  const active = new AbortController();
  const confirm = bridge.context("extension", active.signal).confirm("Wait", "Still waiting?");
  bridge.close();
  assert.equal(await confirm, false);
  assert.equal(bridge.pendingCount, 0);
});

test("RPC extension dialogs cancel when the async output writer rejects", async () => {
  const bridge = new RpcExtensionUiBridge({
    async emit() { throw new Error("writer failed"); },
  });
  const ui = bridge.context("extension", new AbortController().signal);

  assert.equal(await within(ui.input("Wait")), undefined);
  assert.equal(bridge.pendingCount, 0);
  bridge.close();
});

test("RPC extension dialog timeouts accept exact bounds and reject invalid values", async () => {
  const { bridge, requests } = capture();
  const ui = bridge.context("extension", new AbortController().signal);

  for (const timeout of [1, 3_600_000]) {
    const pending = ui.input("Bounded", undefined, { timeout });
    const request = requests.at(-1)!;
    assert.equal(request.method, "input");
    assert.equal("timeout" in request ? request.timeout : undefined, timeout);
    bridge.handle({ type: "extension_ui_response", id: request.id, value: "done" });
    assert.equal(await pending, "done");
  }

  const emitted = requests.length;
  for (const timeout of [0, 3_600_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      ui.input("Invalid", undefined, { timeout }),
      /Extension UI timeout must be from 1 through 3600000 milliseconds/u,
    );
  }
  assert.equal(requests.length, emitted);
  assert.equal(bridge.pendingCount, 0);
  bridge.close();
});
