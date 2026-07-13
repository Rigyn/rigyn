import assert from "node:assert/strict";
import test from "node:test";

import {
  RPC_EXTENSION_UI_LIMITS,
  RpcExtensionUiBridge,
  parseRpcExtensionUiResponse,
  type RpcExtensionUiRequest,
} from "../../src/interfaces/rpc-extension-ui.js";

function capture(options: { defaultTimeoutMs?: number; maxPendingPerPeer?: number } = {}) {
  const requests: RpcExtensionUiRequest[] = [];
  const bridge = new RpcExtensionUiBridge({
    async emit(_peerId, request) {
      requests.push(request);
    },
    maxTimeoutMs: 1_000,
    defaultTimeoutMs: options.defaultTimeoutMs ?? 500,
    ...(options.maxPendingPerPeer === undefined ? {} : { maxPendingPerPeer: options.maxPendingPerPeer }),
  });
  return { bridge, requests };
}

test("RPC extension UI maps selections through opaque IDs and scopes responses to the owning peer", async () => {
  const { bridge, requests } = capture();
  const ui = bridge.context("owner", "extension.one");
  const first = { private: "first" };
  const second = { private: "second" };
  const result = ui.select("Choose safely", [
    { label: "First", value: first, detail: "one" },
    { label: "Second", value: second },
  ]);
  const request = requests[0];
  assert.equal(request?.method, "select");
  assert.deepEqual(request?.method === "select" ? request.options : undefined, [
    { id: "0", label: "First", detail: "one" },
    { id: "1", label: "Second" },
  ]);
  assert.equal(JSON.stringify(request).includes("private"), false);
  assert.throws(
    () => bridge.resolve("other", { id: request!.id, value: "1" }),
    /Unknown extension UI request/u,
  );
  assert.throws(
    () => bridge.resolve("owner", { id: request!.id, value: "missing" }),
    /unknown option/u,
  );
  assert.equal(bridge.pendingCount("owner"), 1);
  bridge.resolve("owner", { id: request!.id, value: "1" });
  assert.equal(await result, second);
  assert.equal(bridge.pendingCount(), 0);

  const cancelled = ui.select("Cancel", [{ label: "Only", value: first }]);
  const cancelRequest = requests[1]!;
  bridge.resolve("owner", { id: cancelRequest.id, cancelled: true });
  await assert.rejects(cancelled, (error: unknown) => error instanceof Error && error.name === "AbortError");
  assert.equal(bridge.pendingCount(), 0);
  bridge.close();
});

test("RPC extension UI supports confirm, input, editor, and their cancellation defaults", async () => {
  const { bridge, requests } = capture();
  const ui = bridge.context("peer", "dialogs");

  const confirm = ui.confirm("Proceed", "Continue?");
  assert.equal(requests[0]?.method, "confirm");
  bridge.resolve("peer", { id: requests[0]!.id, confirmed: true });
  assert.equal(await confirm, true);

  const cancelledConfirm = ui.confirm("Proceed", "Continue?");
  bridge.resolve("peer", { id: requests[1]!.id, cancelled: true });
  assert.equal(await cancelledConfirm, false);

  const input = ui.input("Name", "optional");
  assert.equal(requests[2]?.method, "input");
  bridge.resolve("peer", { id: requests[2]!.id, value: "Ada" });
  assert.equal(await input, "Ada");

  const editor = ui.editor("Draft", "prefill");
  assert.equal(requests[3]?.method, "editor");
  bridge.resolve("peer", { id: requests[3]!.id, cancelled: true });
  assert.equal(await editor, undefined);
  bridge.close();
});

test("RPC extension UI forwards bounded presentation state and tracks editor text per peer", () => {
  const { bridge, requests } = capture();
  const first = bridge.context("first", "presentation");
  const second = bridge.context("second", "presentation");
  first.notify("Ready", "warning");
  first.setStatus("build", "Running");
  first.setStatus("build", undefined);
  first.setWidget("summary", "Two files");
  first.setHeader("mode", "Review mode");
  first.setFooter("policy", "Checks enabled");
  first.setWorkingMessage("Indexing");
  first.setWorkingVisible(false);
  first.setTitle("Workspace");
  first.setEditorText("draft");
  assert.deepEqual(requests.map((request) => request.method), [
    "notify", "status", "status", "widget", "header", "footer", "working_message", "working_visible", "title", "editor_text",
  ]);
  assert.deepEqual(requests[2], {
    id: requests[2]!.id,
    extensionId: "presentation",
    method: "status",
    key: "build",
  });
  assert.equal(first.getEditorText(), "draft");
  assert.equal(second.getEditorText(), "");
  bridge.updateEditorText("second", "remote draft");
  assert.equal(second.getEditorText(), "remote draft");
  assert.throws(() => first.notify("bad", "other" as "warning"), /kind is invalid/u);
  assert.throws(() => first.setTitle("x".repeat(RPC_EXTENSION_UI_LIMITS.maxTitleBytes + 1)), /exceeds/u);
  bridge.close();
});

test("RPC extension UI brokers theme query/selection and rejects terminal-only components", async () => {
  const { bridge, requests } = capture();
  const ui = bridge.context("peer", "themes");
  const current = ui.getTheme();
  assert.equal(requests[0]?.method, "theme_get");
  bridge.resolve("peer", {
    id: requests[0]!.id,
    value: JSON.stringify({ name: "dark", available: ["dark", "ocean"] }),
  });
  assert.deepEqual(await current, { name: "dark", available: ["dark", "ocean"] });

  const selected = ui.setTheme("ocean");
  assert.equal(requests[1]?.method, "theme_set");
  assert.equal(requests[1]?.method === "theme_set" ? requests[1].name : undefined, "ocean");
  bridge.resolve("peer", {
    id: requests[1]!.id,
    value: JSON.stringify({ name: "ocean", available: ["dark", "ocean"] }),
  });
  assert.deepEqual(await selected, { name: "ocean", available: ["dark", "ocean"] });
  await assert.rejects(ui.custom(() => ({ render: () => ({ lines: [] }) })), /unavailable over RPC/u);
  bridge.close();
});

test("RPC extension UI deterministically cleans pending requests on abort, timeout, disconnect, close, and send failure", async () => {
  const { bridge, requests } = capture({ defaultTimeoutMs: 20, maxPendingPerPeer: 1 });
  const controller = new AbortController();
  const ui = bridge.context("peer", "cleanup", { signal: controller.signal });
  const aborted = ui.input("Wait");
  controller.abort(new Error("generation replaced"));
  await assert.rejects(aborted, /generation replaced/u);
  assert.equal(bridge.pendingCount(), 0);

  const timed = bridge.context("peer", "cleanup").editor("Wait");
  await assert.rejects(timed, (error: unknown) => error instanceof Error && error.name === "TimeoutError");
  assert.equal(bridge.pendingCount(), 0);

  const pending = bridge.context("peer", "cleanup").input("Disconnect");
  assert.equal(bridge.pendingCount("peer"), 1);
  bridge.disconnect("peer");
  await assert.rejects(pending, /disconnected/u);
  assert.equal(bridge.pendingCount(), 0);

  const closing = bridge.context("peer", "cleanup").input("Close");
  bridge.close("test shutdown");
  await assert.rejects(closing, /test shutdown/u);
  assert.equal(bridge.pendingCount(), 0);
  assert.ok(requests.length >= 4);

  const failed = new RpcExtensionUiBridge({
    async emit() {
      throw new Error("writer failed");
    },
    defaultTimeoutMs: 100,
    maxTimeoutMs: 100,
  });
  await assert.rejects(failed.context("peer", "cleanup").input("Send"), /writer failed/u);
  assert.equal(failed.pendingCount(), 0);
  failed.close();

  const synchronouslyFailed = new RpcExtensionUiBridge({
    emit() {
      throw new Error("synchronous writer failure");
    },
    defaultTimeoutMs: 100,
    maxTimeoutMs: 100,
  });
  await assert.rejects(
    synchronouslyFailed.context("peer", "cleanup").input("Send"),
    /synchronous writer failure/u,
  );
  assert.equal(synchronouslyFailed.pendingCount(), 0);
  synchronouslyFailed.close();
});

test("RPC extension UI validates responses and enforces pending limits", async () => {
  assert.deepEqual(parseRpcExtensionUiResponse({ id: "request", cancelled: true }), {
    id: "request",
    cancelled: true,
  });
  assert.deepEqual(parseRpcExtensionUiResponse({ id: "request", confirmed: false }), {
    id: "request",
    confirmed: false,
  });
  assert.throws(
    () => parseRpcExtensionUiResponse({ id: "request", value: "x", confirmed: true }),
    /exactly one result/u,
  );
  assert.throws(() => parseRpcExtensionUiResponse({ id: "", value: "x" }), /request ID/u);

  const { bridge } = capture({ maxPendingPerPeer: 1 });
  const ui = bridge.context("peer", "limits");
  const first = ui.input("First");
  await assert.rejects(ui.input("Second"), /Too many pending/u);
  bridge.disconnect("peer");
  await assert.rejects(first, /disconnected/u);
  bridge.close();
});
