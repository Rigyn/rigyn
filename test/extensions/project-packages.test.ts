import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
import { EXTENSION_PACKAGE_LOCK } from "../../src/extensions/packages.js";
import { keyedSqliteLeasePath } from "../../src/process/sqlite-lease.js";

async function fixture(context: TestContext): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "harness-project-packages-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, ".rigyn"), { recursive: true });
  return workspace;
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function writePackage(root: string, version: string, text: string): Promise<void> {
  await mkdir(join(root, "runtime"), { recursive: true });
  await writeFile(join(root, "runtime", "index.mjs"), `export default (api) => api.registerCommand({ name: "declared", execute: () => ${JSON.stringify(text)} });\n`);
  await writeFile(join(root, "extension.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: "declared",
    name: "Declared package",
    version,
    compatibility: { hostVersion: ">=0.1.0 <0.4.0" },
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
  assert.equal(parseProjectPackageDeclaration({
    schemaVersion: 1,
    packages: [{ id: "range", source: { kind: "npm", package: "tools", selector: ">=1.2.0 <2.0.0" } }],
  }).packages[0]?.source.kind, "npm");
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
  const leaseRoot = `${workspace}-leases`;
  context.after(async () => await rm(leaseRoot, { recursive: true, force: true }));
  const source = join(workspace, "package-source");
  await mkdir(source);
  await writePackage(source, "1.0.0", "first");
  await writeDeclaration(workspace);
  const manager = new ProjectPackageManager({ workspace, projectTrusted: true, operationLeaseRoot: leaseRoot });

  assert.equal((await manager.check()).status, "unlocked");
  const updated = await manager.update({ all: true });
  assert.equal(updated.changed, true);
  assert.equal(updated.packages[0]?.version, "1.0.0");
  assert.deepEqual(updated.catalog[0]?.disabledResources, ["runtime:runtime/index.mjs"]);
  const firstLock = await readFile(join(workspace, PROJECT_PACKAGE_LOCK), "utf8");
  assert.match(firstLock, /"contentSha256"/u);
  assert.doesNotMatch(firstLock, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

  assert.equal(EXTENSION_PACKAGE_LOCK, ".rigyn-packages.lock");
  await writeFile(join(workspace, PROJECT_PACKAGE_INSTALL_ROOT, ".rigyn-packages.lock"), "legacy crash residue\n");
  await writePackage(source, "2.0.0", "second");
  const reconciled = await manager.reconcile();
  assert.equal(reconciled.changed, false, "a moving local source must not be read while the locked install is healthy");
  assert.equal(reconciled.packages[0]?.version, "1.0.0");
  assert.equal(await readFile(join(workspace, PROJECT_PACKAGE_LOCK), "utf8"), firstLock);

  const second = await manager.update({ ids: ["declared"] });
  assert.equal(second.packages[0]?.version, "2.0.0");
  assert.notEqual(await readFile(join(workspace, PROJECT_PACKAGE_LOCK), "utf8"), firstLock);
  assert.equal((await manager.check()).status, "ready");
  const repositoryState = await readdir(join(workspace, ".rigyn"), { recursive: true });
  assert.equal(repositoryState.some((entry) => /\.sqlite3(?:-|$)|-journal$|-wal$|-shm$/u.test(entry)), false);
  assert.ok((await readdir(leaseRoot)).some((entry) => entry.endsWith(".sqlite3")));
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

test("failed candidate activation preserves the project declaration, lock, and active package", async (context) => {
  const workspace = await fixture(context);
  const source = join(workspace, "package-source");
  await mkdir(source);
  await writePackage(source, "1.0.0", "first");
  await writeDeclaration(workspace, []);
  const manager = new ProjectPackageManager({ workspace, projectTrusted: true });
  await manager.update({ all: true });
  const before = await Promise.all([
    readFile(join(workspace, PROJECT_PACKAGE_DECLARATION)),
    readFile(join(workspace, PROJECT_PACKAGE_LOCK)),
    readFile(join(workspace, PROJECT_PACKAGE_INSTALL_ROOT, "declared", "extension.json")),
    readFile(join(workspace, PROJECT_PACKAGE_INSTALL_ROOT, "declared", "runtime", "index.mjs")),
  ]);

  await writePackage(source, "2.0.0", "second");
  await writeFile(join(source, "runtime", "index.mjs"), `export default () => { throw new Error("project candidate activation failed"); };\n`);
  await assert.rejects(manager.update({ all: true }), /project candidate activation failed/u);

  assert.deepEqual(await Promise.all([
    readFile(join(workspace, PROJECT_PACKAGE_DECLARATION)),
    readFile(join(workspace, PROJECT_PACKAGE_LOCK)),
    readFile(join(workspace, PROJECT_PACKAGE_INSTALL_ROOT, "declared", "extension.json")),
    readFile(join(workspace, PROJECT_PACKAGE_INSTALL_ROOT, "declared", "runtime", "index.mjs")),
  ]), before);
  assert.equal((await manager.check()).status, "ready");
  await assert.rejects(access(join(workspace, ".rigyn", ".packages-stage")), /ENOENT/u);
  await assert.rejects(access(join(workspace, ".rigyn", ".packages-resolution")), /ENOENT/u);
});

test("disabled runtime resources are not executed during project candidate activation", async (context) => {
  const workspace = await fixture(context);
  const source = join(workspace, "package-source");
  await mkdir(source);
  await writePackage(source, "1.0.0", "unused");
  await writeFile(join(source, "runtime", "index.mjs"), `throw new Error("disabled runtime must not execute");\n`);
  await writeDeclaration(workspace, ["runtime:runtime/index.mjs"]);

  const manager = new ProjectPackageManager({ workspace, projectTrusted: true });
  const result = await manager.update({ all: true });
  assert.equal(result.status, "ready");
  assert.equal(result.packages[0]?.version, "1.0.0");
  assert.equal((await manager.check()).status, "ready");
});

test("the complete project package generation is activation-tested before commit", async (context) => {
  const workspace = await fixture(context);
  for (const id of ["collision-a", "collision-b"]) {
    const source = join(workspace, id);
    await mkdir(join(source, "runtime"), { recursive: true });
    await writeFile(join(source, "runtime", "index.mjs"), `
export default (api) => api.registerTool({
  name: "project_collision",
  description: "Collision fixture",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  execute: () => ({ content: "ok", isError: false, status: "success", summary: "ok", nextActions: [] }),
});
`);
    await writeFile(join(source, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id,
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
  }
  await writeFile(join(workspace, PROJECT_PACKAGE_DECLARATION), JSON.stringify({
    schemaVersion: 1,
    packages: ["collision-a", "collision-b"].map((id) => ({
      id,
      source: { kind: "local", path: id },
    })),
  }));

  const manager = new ProjectPackageManager({ workspace, projectTrusted: true });
  await assert.rejects(manager.update({ all: true }), /project_collision.*ignored|activation reported/u);
  await assert.rejects(access(join(workspace, PROJECT_PACKAGE_LOCK)), /ENOENT/u);
  await assert.rejects(access(join(workspace, PROJECT_PACKAGE_INSTALL_ROOT)), /ENOENT/u);
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

test("a crashed project-package lease owner recovers without leaving repository sidecars", {
  skip: process.platform === "win32" ? "SIGKILL fixture requires POSIX signal delivery" : false,
}, async (context) => {
  const workspace = await fixture(context);
  const leaseRoot = `${workspace}-leases`;
  context.after(async () => await rm(leaseRoot, { recursive: true, force: true }));
  const leasePath = await keyedSqliteLeasePath(leaseRoot, "project-packages", workspace);
  const ready = join(workspace, "lease-ready");
  const moduleUrl = pathToFileURL(new URL("../../src/process/sqlite-lease.ts", import.meta.url).pathname).href;
  const source = `
    import { writeFile } from "node:fs/promises";
    import { withSqliteProcessLease } from ${JSON.stringify(moduleUrl)};
    await withSqliteProcessLease(${JSON.stringify(leasePath)}, async () => {
      await writeFile(${JSON.stringify(ready)}, "locked\\n");
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }, { timeoutMs: 2000, retryMs: 5, label: "project crash fixture" });
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  await waitForFile(ready, 10_000);

  const manager = new ProjectPackageManager({ workspace, projectTrusted: true, operationLeaseRoot: leaseRoot });
  let completed = false;
  const check = manager.check().finally(() => { completed = true; });
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 40));
  assert.equal(completed, false, "project manager must coordinate through the private state lease");
  child.kill("SIGKILL");
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  assert.equal((await check).status, "absent");
  assert.deepEqual(await readdir(join(workspace, ".rigyn")), []);
});

test("aborting reconciliation terminates dependency commands and preserves active packages", { timeout: 10_000 }, async (context) => {
  const workspace = await fixture(context);
  const source = join(workspace, "package-source");
  const block = join(workspace, "block-npm");
  const started = join(workspace, "npm-started");
  const release = join(workspace, "release-child");
  const survivor = join(workspace, "child-survived");
  const fakeNpm = join(workspace, "fake-npm.mjs");
  await mkdir(source);
  await writePackage(source, "1.0.0", "first");
  await writeFile(join(source, "package.json"), `${JSON.stringify({
    name: "declared-package",
    version: "1.0.0",
    type: "module",
    dependencies: { "fixture-dependency": "1.0.0" },
  }, null, 2)}\n`);
  await writeDeclaration(workspace, []);
  await writeFile(fakeNpm, `
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
const [block, started, release, survivor] = process.argv.slice(2);
let blocked = false;
try { await access(block); blocked = true; } catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
if (blocked) {
  spawn(process.execPath, ["-e", ${JSON.stringify("const fs = process.getBuiltinModule('node:fs'); fs.writeFileSync(process.argv[1], 'started'); const timer = setInterval(() => { if (!fs.existsSync(process.argv[2])) return; clearInterval(timer); fs.writeFileSync(process.argv[3], 'survived'); }, 10)")}, started, release, survivor], { stdio: "ignore" });
  await new Promise(() => {});
}
const manifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
  const root = join(process.cwd(), "node_modules", name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name, version, type: "module", exports: "./index.mjs" }));
  await writeFile(join(root, "index.mjs"), "export const value = " + JSON.stringify(name + "@" + version) + ";\\n");
}
`);
  const manager = new ProjectPackageManager({
    workspace,
    projectTrusted: true,
    commands: { npm: { command: process.execPath, prefix: [fakeNpm, block, started, release, survivor] } },
  });
  await manager.update({ all: true });

  const packageRoot = join(workspace, PROJECT_PACKAGE_INSTALL_ROOT, "declared");
  const before = await Promise.all([
    readFile(join(workspace, PROJECT_PACKAGE_LOCK)),
    readFile(join(packageRoot, ".rigyn-package.json")),
    readFile(join(packageRoot, "extension.json")),
    readFile(join(packageRoot, "package.json")),
    readFile(join(packageRoot, "runtime", "index.mjs")),
    readFile(join(packageRoot, "node_modules", "fixture-dependency", "package.json")),
    readFile(join(packageRoot, "node_modules", "fixture-dependency", "index.mjs")),
  ]);
  await mkdir(join(workspace, PROJECT_PACKAGE_INSTALL_ROOT, "unexpected"));
  await writeFile(block, "block");

  const controller = new AbortController();
  const reconciliation = manager.reconcile(controller.signal);
  await waitForFile(started);
  const abortedAt = Date.now();
  controller.abort(new Error("cancel project package reconciliation"));
  await assert.rejects(reconciliation, /cancel project package reconciliation/u);
  assert.ok(Date.now() - abortedAt < 2_000, "reconciliation should reject promptly after cancellation");

  const after = await Promise.all([
    readFile(join(workspace, PROJECT_PACKAGE_LOCK)),
    readFile(join(packageRoot, ".rigyn-package.json")),
    readFile(join(packageRoot, "extension.json")),
    readFile(join(packageRoot, "package.json")),
    readFile(join(packageRoot, "runtime", "index.mjs")),
    readFile(join(packageRoot, "node_modules", "fixture-dependency", "package.json")),
    readFile(join(packageRoot, "node_modules", "fixture-dependency", "index.mjs")),
  ]);
  assert.deepEqual(after, before);
  await assert.rejects(access(join(workspace, ".rigyn", ".packages-stage")), /ENOENT/u);
  await writeFile(release, "release");
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 250));
  await assert.rejects(access(survivor), /ENOENT/u);
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
