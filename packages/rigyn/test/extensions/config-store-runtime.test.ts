import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI } from "../../src/extensions/direct.js";
import { loadDirectExtensions } from "../../src/extensions/runtime.js";

async function workspace(context: test.TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rigyn-extension-config-runtime-"));
  context.after(async () => await rm(path, { recursive: true, force: true }));
  return path;
}

test("the direct API exposes committed generation-owned extension configuration", async (context) => {
  const root = await workspace(context);
  let api: ExtensionAPI | undefined;
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    inlineExtensions: [(value) => { api = value; }],
  });
  assert.ok(api !== undefined);

  const created = await api.config.replace("workspace", { enabled: true }, { expectedRevision: null });
  assert.deepEqual((await api.config.read("workspace")).value, { enabled: true });
  assert.match(created.revision ?? "", /^[a-f0-9]{64}$/u);

  await host.close();
  await assert.rejects(api.config.read("workspace"), /host closed/u);
});

test("extension configuration cannot mutate during a failed precommit activation", async (context) => {
  const root = await workspace(context);
  await assert.rejects(
    loadDirectExtensions([], {
      workspace: root,
      activationFailure: "throw",
      inlineExtensions: [async (api) => {
        await api.config.replace("user", { escaped: true }, { expectedRevision: null });
      }],
    }),
    /not writable/u,
  );
});

test("project extension configuration survives package and workspace root moves", async (context) => {
  const root = await workspace(context);
  const dataRoot = join(root, "data");
  const firstWorkspace = join(root, "workspace-one");
  const secondWorkspace = join(root, "workspace-two");
  const firstPackage = join(root, "install-one");
  const secondPackage = join(root, "install-two");
  const firstPath = join(firstPackage, "runtime", "entry.mjs");
  const secondPath = join(secondPackage, "runtime", "entry.mjs");
  const source = "export default (api) => { globalThis.__configRootMoveApi = api; };\n";
  await Promise.all([
    mkdir(firstWorkspace, { recursive: true }),
    mkdir(secondWorkspace, { recursive: true }),
    mkdir(join(firstPackage, "runtime"), { recursive: true }),
    mkdir(join(secondPackage, "runtime"), { recursive: true }),
  ]);
  await Promise.all([writeFile(firstPath, source), writeFile(secondPath, source)]);
  context.after(() => { delete (globalThis as Record<string, unknown>).__configRootMoveApi; });
  const metadata = (path: string, resourceRoot: string) => new Map([[path, {
    scope: "project" as const,
    trusted: true,
    extensionId: "stable.package",
    resourceRoot,
  }]]);

  const firstHost = await loadDirectExtensions([firstPath], {
    workspace: firstWorkspace,
    dataRoot,
    activationFailure: "throw",
    directPathMetadata: metadata(firstPath, firstPackage),
  });
  const firstApi = (globalThis as Record<string, unknown>).__configRootMoveApi as ExtensionAPI;
  await firstApi.config.replace("user", { retained: true }, { expectedRevision: null });
  const firstPaths = firstHost.extensionDataPaths(firstPath);
  await firstHost.close();

  const secondHost = await loadDirectExtensions([secondPath], {
    workspace: secondWorkspace,
    dataRoot,
    activationFailure: "throw",
    directPathMetadata: metadata(secondPath, secondPackage),
  });
  context.after(async () => await secondHost.close());
  const secondApi = (globalThis as Record<string, unknown>).__configRootMoveApi as ExtensionAPI;
  assert.deepEqual((await secondApi.config.read("user")).value, { retained: true });
  const secondPaths = secondHost.extensionDataPaths(secondPath);
  assert.equal(firstPaths?.user, secondPaths?.user);
  assert.notEqual(firstPaths?.workspace, secondPaths?.workspace);
});
