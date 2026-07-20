import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  loadRuntimeExtensions,
  type RuntimeAdvancedUiOperation,
  type RuntimeExtensionApi,
} from "../../src/extensions/runtime.js";
import { sha256 } from "../../src/tools/hash.js";

async function sourceFile(context: TestContext, source: string): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "rigyn-advanced-ui-runtime-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "extension.mjs");
  await writeFile(path, source);
  return { root, path };
}

test("trusted advanced UI declarations replay bounded structural operations and remain generation-owned", async (context) => {
  const source = `export default (api) => {
    globalThis.__rigynAdvancedUiApi = api;
    api.ui.advanced.setComponent("header", "health", () => ({
      render() { return { lines: [{ spans: [{ text: "healthy", role: "success" }] }] }; }
    }));
    api.ui.advanced.setWorkingIndicator({ frames: [".", "o", "O"], intervalMs: 80 });
    api.ui.advanced.setHiddenReasoningLabel("analysis");
    api.ui.advanced.setToolOutputExpanded(false);
    globalThis.__rigynAdvancedUiDisposeKeys = api.ui.advanced.observeKeys(() => {});
  };\n`;
  const fixture = await sourceFile(context, source);
  context.after(() => {
    delete (globalThis as Record<string, unknown>).__rigynAdvancedUiApi;
    delete (globalThis as Record<string, unknown>).__rigynAdvancedUiDisposeKeys;
  });
  const host = await loadRuntimeExtensions([{
    extensionId: "advanced-ui",
    sourcePath: fixture.path,
    sha256: sha256(source),
    trusted: true,
    permissions: { advancedUi: true },
  }], { workspace: fixture.root, activationFailure: "throw" });
  const operations: RuntimeAdvancedUiOperation[] = [];
  host.setAdvancedUiHandler({
    apply(operation) { operations.push(operation); },
    getToolOutputExpanded() { return false; },
  });

  assert.deepEqual(operations.map((operation) => operation.type), [
    "component",
    "working_indicator",
    "hidden_reasoning_label",
    "tool_output_expanded",
    "key_observer",
  ]);
  assert.ok(operations.every((operation) => operation.extensionId === "advanced-ui"));
  assert.equal(operations[0]?.type === "component" && operations[0].slot, "header");
  assert.equal(operations[0]?.type === "component" && operations[0].key, "health");
  assert.equal(operations[0]?.type === "component" && typeof operations[0].factory, "function");
  assert.deepEqual(operations[1]?.type === "working_indicator" && operations[1].value, {
    frames: [".", "o", "O"],
    intervalMs: 80,
  });

  const api = (globalThis as Record<string, unknown>).__rigynAdvancedUiApi as RuntimeExtensionApi;
  assert.equal(api.ui.advanced.getToolOutputExpanded(), false);
  api.ui.advanced.setComponent("footer", "branch", undefined);
  assert.equal(operations.at(-1)?.type, "component");
  const disposeKeys = (globalThis as Record<string, unknown>).__rigynAdvancedUiDisposeKeys as () => void;
  disposeKeys();
  disposeKeys();
  assert.equal(operations.filter((operation) => operation.type === "key_observer").length, 2);
  const removedObserver = operations.at(-1);
  assert.equal(removedObserver?.type === "key_observer" ? removedObserver.observer : "unexpected operation", undefined);

  const generationSignal = operations[0]!.signal;
  assert.equal(generationSignal.aborted, false);
  await host.close();
  assert.equal(generationSignal.aborted, true);
});

test("advanced UI rejects missing trust, missing permission, and malformed operations before presentation", async (context) => {
  const source = `export default (api) => {
    api.ui.advanced.setComponent("header", "probe", () => ({ render() { return { lines: [] }; } }));
  };\n`;
  const fixture = await sourceFile(context, source);
  for (const entry of [
    { trusted: false, permissions: { advancedUi: true } },
    { trusted: true },
  ] as const) {
    await assert.rejects(loadRuntimeExtensions([{
      extensionId: "advanced-ui-denied",
      sourcePath: fixture.path,
      sha256: sha256(source),
      ...entry,
    }], { workspace: fixture.root, activationFailure: "throw" }), /trusted manifest with permissions\.advancedUi enabled/u);
  }

  const malformed = `export default (api) => {
    api.ui.advanced.setWorkingIndicator({ frames: [], intervalMs: 1 });
  };\n`;
  const invalid = await sourceFile(context, malformed);
  await assert.rejects(loadRuntimeExtensions([{
    extensionId: "advanced-ui-invalid",
    sourcePath: invalid.path,
    sha256: sha256(malformed),
    trusted: true,
    permissions: { advancedUi: true },
  }], { workspace: invalid.root, activationFailure: "throw" }), /frames must contain 1-32/u);
});
