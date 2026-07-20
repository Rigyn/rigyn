import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { LocalExtensionPackageManager } from "../../src/extensions/packages.js";

async function fixture(context: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rigyn-package-activation-test-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  return root;
}

async function writeRuntimePackage(root: string, version: string, runtime: string): Promise<void> {
  await mkdir(join(root, "runtime"), { recursive: true });
  await writeFile(join(root, "runtime", "index.mjs"), runtime);
  await writeFile(join(root, "extension.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: "activation-reference",
    name: "Activation reference",
    version,
    contributions: { runtime: [{ path: "runtime/index.mjs" }] },
  }, null, 2)}\n`);
}

async function assertNoTransactionResidue(root: string): Promise<void> {
  const entries = await readdir(root);
  assert.deepEqual(entries.filter((entry) => entry.startsWith(".rigyn-package-")), []);
}

test("install activates and disposes a staged package inside disposable data and workspace roots", async (context) => {
  const root = await fixture(context);
  const source = join(root, "source");
  const managed = join(root, "managed");
  await mkdir(source);
  await writeRuntimePackage(source, "1.0.0", `
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export default async (api) => {
  const state = globalThis.__rigynPackageActivation = {
    activated: 1,
    disposed: 0,
    workspace: api.workspace,
    data: api.dataPaths.user,
  };
  await writeFile(join(api.workspace, "activation-marker"), "workspace");
  await writeFile(join(api.dataPaths.user, "activation-data"), "data");
  api.onDispose(() => { state.disposed += 1; });
  api.registerCommand({ name: "activation-reference", execute: () => "ok" });
};
`);
  context.after(() => { delete (globalThis as Record<string, unknown>).__rigynPackageActivation; });

  const installed = await new LocalExtensionPackageManager({ user: managed }).install(source);
  const state = (globalThis as Record<string, any>).__rigynPackageActivation;
  assert.deepEqual({ activated: state.activated, disposed: state.disposed }, { activated: 1, disposed: 1 });
  await assert.rejects(access(state.workspace), /ENOENT/u);
  await assert.rejects(access(state.data), /ENOENT/u);
  await assert.rejects(access(join(source, "activation-marker")), /ENOENT/u);
  await assert.rejects(access(join(source, "activation-data")), /ENOENT/u);
  assert.equal(installed.version, "1.0.0");
  await assertNoTransactionResidue(managed);
});

test("activation failure cleans staged resources and leaves an installed version byte-for-byte intact", async (context) => {
  const root = await fixture(context);
  const source = join(root, "source");
  const managed = join(root, "managed");
  await mkdir(source);
  await writeRuntimePackage(source, "1.0.0", "export default () => {};\n");
  const manager = new LocalExtensionPackageManager({ user: managed });
  const installed = await manager.install(source);
  const before = await Promise.all([
    readFile(join(installed.packageRoot, "extension.json")),
    readFile(join(installed.packageRoot, "runtime", "index.mjs")),
    readFile(join(installed.packageRoot, ".rigyn-package.json")),
  ]);

  await writeRuntimePackage(source, "2.0.0", `
export default (api) => {
  api.onDispose(() => { globalThis.__rigynFailedActivationDisposed = true; });
  throw new Error("candidate activation failed");
};
`);
  context.after(() => { delete (globalThis as Record<string, unknown>).__rigynFailedActivationDisposed; });
  await assert.rejects(manager.update("activation-reference"), /candidate activation failed/u);

  assert.equal((globalThis as Record<string, unknown>).__rigynFailedActivationDisposed, true);
  const current = (await manager.list("user"))[0];
  assert.equal(current?.version, "1.0.0");
  assert.deepEqual(await Promise.all([
    readFile(join(installed.packageRoot, "extension.json")),
    readFile(join(installed.packageRoot, "runtime", "index.mjs")),
    readFile(join(installed.packageRoot, ".rigyn-package.json")),
  ]), before);
  await assertNoTransactionResidue(managed);
});

test("activation timeout runs registered cleanup and commits no package", async (context) => {
  const root = await fixture(context);
  const source = join(root, "source");
  const managed = join(root, "managed");
  await mkdir(source);
  await writeRuntimePackage(source, "1.0.0", `
export default async (api) => {
  api.onDispose(() => { globalThis.__rigynTimedOutActivationDisposed = true; });
  await new Promise(() => {});
};
`);
  context.after(() => { delete (globalThis as Record<string, unknown>).__rigynTimedOutActivationDisposed; });
  const manager = new LocalExtensionPackageManager(
    { user: managed },
    {},
    {},
    { activationTimeoutMs: 25 },
  );

  await assert.rejects(manager.install(source), /timed out after 25ms/u);
  assert.equal((globalThis as Record<string, unknown>).__rigynTimedOutActivationDisposed, true);
  assert.deepEqual(await manager.list(), []);
  await assertNoTransactionResidue(managed);
});

test("candidate activation has no live session handler", async (context) => {
  const root = await fixture(context);
  const source = join(root, "source");
  const managed = join(root, "managed");
  await mkdir(source);
  await writeRuntimePackage(source, "1.0.0", `
export default async (api) => {
  await api.sendUserMessage({
    threadId: "candidate-thread",
    delivery: "follow_up",
    text: "must not reach a live session",
  });
};
`);

  const manager = new LocalExtensionPackageManager({ user: managed });
  await assert.rejects(manager.install(source), /session controls are not available/u);
  assert.deepEqual(await manager.list(), []);
  await assertNoTransactionResidue(managed);
});
