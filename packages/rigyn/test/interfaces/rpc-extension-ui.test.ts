import assert from "node:assert/strict";
import test from "node:test";

import { RpcExtensionUiBridge } from "../../src/interfaces/rpc-extension-ui.js";
import type { RpcExtensionUiRequest } from "../../src/interfaces/rpc-protocol.js";

function capture() {
  const requests: RpcExtensionUiRequest[] = [];
  const bridge = new RpcExtensionUiBridge({ emit(request) { requests.push(request); } });
  return { bridge, requests };
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
    widgetKey: "summary",
    widgetLines: ["one", "two"],
    widgetPlacement: "belowEditor",
  });
  assert.equal(ui.setTheme("dark").success, false);
  assert.deepEqual(ui.getAllThemes(), []);
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
