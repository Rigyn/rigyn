import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI } from "../../src/extensions/direct.js";
import { loadDirectExtensions } from "../../src/extensions/runtime.js";

test("inline extension metadata uses stable ordinal and explicit names", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-inline-names-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  const noop = (): void => undefined;
  const host = await loadDirectExtensions([], {
    workspace,
    activationFailure: "throw",
    inlineExtensions: [
      noop,
      { name: "named", factory: noop, hidden: true },
      noop,
    ],
  });
  context.after(async () => await host.close());

  assert.deepEqual(host.extensions().map((entry) => entry.sourcePath), [
    "<inline:1>",
    "<inline:named>",
    "<inline:3>",
  ]);
  assert.equal(host.compatibilityProjection("<inline:named>")?.hidden, true);
});

test("inline names that normalize alike retain isolated extension data", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-inline-data-names-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  let first: ExtensionAPI | undefined;
  let second: ExtensionAPI | undefined;
  const host = await loadDirectExtensions([], {
    workspace,
    activationFailure: "throw",
    inlineExtensions: [
      { name: "Alpha", factory(api) { first = api; } },
      { name: "alpha", factory(api) { second = api; } },
    ],
  });
  context.after(async () => await host.close());

  assert.ok(first !== undefined);
  assert.ok(second !== undefined);
  await first.config.replace("user", { owner: "Alpha" }, { expectedRevision: null });
  assert.deepEqual(await second.config.read("user"), { revision: null, value: undefined });
  assert.notDeepEqual(
    host.extensionDataPaths("<inline:Alpha>"),
    host.extensionDataPaths("<inline:alpha>"),
  );
});

test("same declared inline ID retains source-owned initial and advanced UI operations", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-inline-ui-owners-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  const advancedOwners: Array<{ extensionId: string; sourcePath: string; ownerKey: string }> = [];
  const host = await loadDirectExtensions([], {
    workspace,
    activationFailure: "throw",
    inlineExtensions: [
      {
        name: "Alpha",
        factory(api) {
          api.on("session_start", (_event, runtime) => {
            runtime.ui.setStatus("phase", "Alpha");
            runtime.ui.setWorkingIndicator({ frames: ["A"] });
          });
        },
      },
      {
        name: "alpha",
        factory(api) {
          api.on("session_start", (_event, runtime) => {
            runtime.ui.setStatus("phase", "alpha");
            runtime.ui.setWorkingIndicator({ frames: ["a"] });
          });
        },
      },
    ],
  });
  context.after(async () => await host.close());
  host.setAdvancedUiHandler({
    apply(operation) {
      advancedOwners.push({
        extensionId: operation.extensionId,
        sourcePath: operation.sourcePath,
        ownerKey: operation.ownerKey,
      });
    },
    getToolOutputExpanded: () => false,
  });

  await host.dispatch("session_start", {});

  const initial = host.initialUi().filter((operation) => operation.type === "status");
  assert.deepEqual(initial.map((operation) => operation.extensionId), ["inline-alpha", "inline-alpha"]);
  assert.deepEqual(initial.map((operation) => operation.sourcePath), ["<inline:Alpha>", "<inline:alpha>"]);
  assert.equal(new Set(initial.map((operation) => operation.ownerKey)).size, 2);
  assert.equal(initial.every((operation) => operation.signal.aborted === false), true);
  assert.deepEqual(advancedOwners.map((operation) => operation.extensionId), ["inline-alpha", "inline-alpha"]);
  assert.deepEqual(advancedOwners.map((operation) => operation.sourcePath), ["<inline:Alpha>", "<inline:alpha>"]);
  assert.equal(new Set(advancedOwners.map((operation) => operation.ownerKey)).size, 2);
});

test("duplicate explicit inline names fail before activation or data creation", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-inline-duplicate-names-"));
  const dataRoot = join(workspace, "extension-data");
  const sourcePath = join(workspace, "direct.mjs");
  const activationMarker = "__rigynDuplicateInlinePreflightActivation";
  const globals = globalThis as Record<string, unknown>;
  delete globals[activationMarker];
  await writeFile(sourcePath, `
globalThis.${activationMarker} = (globalThis.${activationMarker} ?? 0) + 1;
export default function activate() {}
`);
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  context.after(() => { delete globals[activationMarker]; });
  let activations = 0;
  let host: Awaited<ReturnType<typeof loadDirectExtensions>> | undefined;

  try {
    await assert.rejects(async () => {
      host = await loadDirectExtensions([sourcePath], {
        workspace,
        dataRoot,
        activationFailure: "throw",
        inlineExtensions: [
          { name: "duplicate", factory() { activations += 1; } },
          { name: "duplicate", factory() { activations += 1; } },
        ],
      });
    }, /duplicate inline extension name/iu);
  } finally {
    await host?.close();
  }

  assert.equal(activations, 0);
  assert.equal(globals[activationMarker], undefined);
  await assert.rejects(access(dataRoot), { code: "ENOENT" });
});
