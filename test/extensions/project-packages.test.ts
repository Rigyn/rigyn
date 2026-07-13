import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  PROJECT_PACKAGE_DECLARATION,
  PROJECT_PACKAGE_INSTALL_ROOT,
  PROJECT_PACKAGE_LOCK,
  ProjectPackageManager,
  parseProjectPackageDeclaration,
  parseProjectPackageLock,
  projectPackageDeclarationSha256,
} from "../../src/extensions/project-packages.js";

async function fixture(context: TestContext): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "harness-project-packages-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, ".rigyn"), { recursive: true });
  return workspace;
}

async function writePackage(root: string, version: string, text: string): Promise<void> {
  await mkdir(join(root, "runtime"), { recursive: true });
  await writeFile(join(root, "runtime", "index.mjs"), `export default (api) => api.registerCommand({ name: "declared", execute: () => ${JSON.stringify(text)} });\n`);
  await writeFile(join(root, "extension.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: "declared",
    name: "Declared package",
    version,
    compatibility: { hostVersion: ">=0.1.0 <0.2.0" },
    contributions: { runtime: [{ path: "runtime/index.mjs" }] },
  }, null, 2)}\n`);
}

async function writeDeclaration(workspace: string, disabledResources = ["runtime:runtime/index.mjs"]): Promise<void> {
  await writeFile(join(workspace, PROJECT_PACKAGE_DECLARATION), `${JSON.stringify({
    schemaVersion: 1,
    packages: [{
      id: "declared",
      source: { kind: "local", path: "package-source" },
      disabledResources,
    }],
  }, null, 2)}\n`);
}

test("declaration and lock schemas are strict, deterministic, and credential-free", () => {
  const declaration = parseProjectPackageDeclaration({
    schemaVersion: 1,
    packages: [
      { id: "z-git", source: { kind: "git", repository: "https://example.com/tools.git", ref: "main" } },
      { id: "a-npm", source: { kind: "npm", package: "@example/tools", selector: "^1.2.0" }, disabledResources: ["command:review", "prompt:review"] },
      { id: "m-local", source: { kind: "local", path: "packages/local" }, disabledResources: ["theme:ocean", "theme:ocean"] },
    ],
  });
  assert.deepEqual(declaration.packages.map((entry) => entry.id), ["a-npm", "m-local", "z-git"]);
  assert.deepEqual(declaration.packages[1]?.disabledResources, ["theme:ocean"]);
  assert.throws(() => parseProjectPackageDeclaration({
    schemaVersion: 1,
    packages: [{ id: "bad", source: { kind: "git", repository: "https://token@example.com/tools.git" } }],
  }), /credential-free/u);
  assert.throws(() => parseProjectPackageDeclaration({
    schemaVersion: 1,
    packages: [{ id: "bad", source: { kind: "local", path: "../outside" } }],
  }), /workspace-relative/u);
  assert.throws(() => parseProjectPackageDeclaration({
    schemaVersion: 1,
    packages: [{ id: "bad", source: { kind: "npm", package: "tools", selector: "latest" }, unknown: true }],
  }), /unknown keys/u);
  assert.throws(() => parseProjectPackageDeclaration({
    schemaVersion: 1,
    packages: [{ id: "bad", source: { kind: "npm", package: "tools", selector: "latest" }, disabledResources: ["tool:bad"] }],
  }), /resource keys/u);

  const embedded = parseProjectPackageDeclaration({
    schemaVersion: 1,
    packages: [{ id: "a-npm", source: { kind: "npm", package: "@example/tools", selector: "^1.2.0" } }],
  });
  const hash = "a".repeat(64);
  const lock = parseProjectPackageLock({
    schemaVersion: 1,
    declarationSha256: projectPackageDeclarationSha256(embedded),
    packages: [{
      id: "a-npm",
      declaration: embedded.packages[0],
      resolved: {
        kind: "npm",
        source: "npm:@example/tools@1.2.3",
        packageName: "@example/tools",
        resolvedVersion: "1.2.3",
        archiveSha256: hash,
        manifestSha256: hash,
        contentSha256: hash,
      },
    }],
  });
  assert.equal(lock.packages[0]?.resolved.kind, "npm");
  assert.throws(() => parseProjectPackageLock({ ...lock, declarationSha256: "b".repeat(64) }), /digest/u);
});

test("untrusted declarations are ignored without reading malformed project content", async (context) => {
  const workspace = await fixture(context);
  await writeFile(join(workspace, PROJECT_PACKAGE_DECLARATION), "not JSON and must not be read");
  const manager = new ProjectPackageManager({ workspace, projectTrusted: false });
  assert.deepEqual(await manager.check(), {
    status: "ignored",
    trusted: false,
    packageCount: 0,
    packages: [],
    message: "Project package declarations are ignored until the workspace is trusted.",
  });
  assert.deepEqual(await manager.reconcile(), { status: "ignored", changed: false, packages: [], catalog: [] });
  await assert.rejects(manager.update({ all: true }), /require workspace trust/u);
});

test("explicit update locks local content and ordinary startup never follows later source edits", async (context) => {
  const workspace = await fixture(context);
  const source = join(workspace, "package-source");
  await mkdir(source);
  await writePackage(source, "1.0.0", "first");
  await writeDeclaration(workspace);
  const manager = new ProjectPackageManager({ workspace, projectTrusted: true });

  assert.equal((await manager.check()).status, "unlocked");
  const updated = await manager.update({ all: true });
  assert.equal(updated.changed, true);
  assert.equal(updated.packages[0]?.version, "1.0.0");
  assert.deepEqual(updated.catalog[0]?.disabledResources, ["runtime:runtime/index.mjs"]);
  const firstLock = await readFile(join(workspace, PROJECT_PACKAGE_LOCK), "utf8");
  assert.match(firstLock, /"contentSha256"/u);
  assert.doesNotMatch(firstLock, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

  await writePackage(source, "2.0.0", "second");
  const reconciled = await manager.reconcile();
  assert.equal(reconciled.changed, false, "a moving local source must not be read while the locked install is healthy");
  assert.equal(reconciled.packages[0]?.version, "1.0.0");
  assert.equal(await readFile(join(workspace, PROJECT_PACKAGE_LOCK), "utf8"), firstLock);

  const second = await manager.update({ ids: ["declared"] });
  assert.equal(second.packages[0]?.version, "2.0.0");
  assert.notEqual(await readFile(join(workspace, PROJECT_PACKAGE_LOCK), "utf8"), firstLock);
  assert.equal((await manager.check()).status, "ready");
});

test("failed resolution and staging preserve the prior lock and active package", async (context) => {
  const workspace = await fixture(context);
  const source = join(workspace, "package-source");
  await mkdir(source);
  await writePackage(source, "1.0.0", "first");
  await writeDeclaration(workspace, []);
  const manager = new ProjectPackageManager({ workspace, projectTrusted: true });
  await manager.update({ all: true });
  const priorLock = await readFile(join(workspace, PROJECT_PACKAGE_LOCK), "utf8");
  const priorManifest = await readFile(join(workspace, PROJECT_PACKAGE_INSTALL_ROOT, "declared", "extension.json"), "utf8");

  await rm(join(source, "runtime", "index.mjs"));
  await symlink(join(workspace, "outside.mjs"), join(source, "runtime", "index.mjs"));
  await assert.rejects(manager.update({ all: true }), /symbolic link/u);
  assert.equal(await readFile(join(workspace, PROJECT_PACKAGE_LOCK), "utf8"), priorLock);
  assert.equal(await readFile(join(workspace, PROJECT_PACKAGE_INSTALL_ROOT, "declared", "extension.json"), "utf8"), priorManifest);
  assert.equal((await manager.check()).status, "ready");
});

test("concurrent reconcilers serialize and repair only from the immutable lock", async (context) => {
  const workspace = await fixture(context);
  const source = join(workspace, "package-source");
  await mkdir(source);
  await writePackage(source, "1.0.0", "first");
  await writeDeclaration(workspace, []);
  const first = new ProjectPackageManager({ workspace, projectTrusted: true });
  const second = new ProjectPackageManager({ workspace, projectTrusted: true });
  await first.update({ all: true });
  await rm(join(workspace, PROJECT_PACKAGE_INSTALL_ROOT), { recursive: true });

  const results = await Promise.all([first.reconcile(), second.reconcile()]);
  assert.equal(results.filter((entry) => entry.changed).length, 1);
  assert.deepEqual(results.map((entry) => entry.packages[0]?.version), ["1.0.0", "1.0.0"]);
  await access(join(workspace, PROJECT_PACKAGE_INSTALL_ROOT, "declared", "runtime", "index.mjs"));
  assert.equal((await first.check()).status, "ready");
});

test("declaration changes require intentional lock updates and partial updates cannot bless unrelated changes", async (context) => {
  const workspace = await fixture(context);
  const source = join(workspace, "package-source");
  await mkdir(source);
  await writePackage(source, "1.0.0", "first");
  await writeDeclaration(workspace, []);
  const manager = new ProjectPackageManager({ workspace, projectTrusted: true });
  await manager.update({ all: true });

  const declaration = JSON.parse(await readFile(join(workspace, PROJECT_PACKAGE_DECLARATION), "utf8")) as { packages: unknown[] };
  declaration.packages.push({ id: "unresolved", source: { kind: "local", path: "another-source" } });
  await writeFile(join(workspace, PROJECT_PACKAGE_DECLARATION), `${JSON.stringify({ schemaVersion: 1, ...declaration }, null, 2)}\n`);
  assert.equal((await manager.check()).status, "stale-lock");
  await assert.rejects(manager.reconcile(), /does not match its lock/u);
  await assert.rejects(manager.update({ ids: ["declared"] }), /unresolved is not locked/u);
});
