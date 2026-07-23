import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";

import {
  inspectExtensionPackage,
  packExtensionPackage,
  reloadExtensionPackage,
  reportExtensionPackage,
  smokeExtensionPackage,
  validateExtensionPackage,
} from "../../src/cli/extension-author.js";
import { DefaultPackageManager } from "../../src/core/package-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { loadDirectExtensions } from "../../src/extensions/runtime.js";

async function fixture(t: TestContext): Promise<{ root: string; log: string }> {
  const root = await mkdtemp(join(tmpdir(), "rigyn-author-test-"));
  const log = join(root, "lifecycle.log");
  await mkdir(join(root, "extensions"));
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "author-tool-fixture",
    version: "1.2.3",
    description: "Author tooling fixture",
    type: "module",
    files: ["extensions"],
    peerDependencies: { rigyn: ">=0.4.0 <0.7.0" },
    rigyn: { extensions: ["extensions/index.mjs"] },
  }));
  await writeFile(join(root, "extensions", "index.mjs"), `
    import { appendFile } from "node:fs/promises";
    export default function activate(api) {
      api.registerCommand("author-probe", { handler() {} });
      api.registerTool({
        name: "author_probe",
        label: "Author probe",
        description: "Author probe.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute() { return { content: [{ type: "text", text: "probed" }], details: {} }; }
      });
      api.onDispose(async () => appendFile(${JSON.stringify(log)}, "disposed\\n"));
    }
  `);
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return { root, log };
}

test("extension author tooling validates and inspects the exact npm pack file set", async (t) => {
  const { root } = await fixture(t);
  const validation = await validateExtensionPackage(root);
  assert.equal(validation.package.id, "author-tool-fixture");
  assert.equal(validation.package.hostVersionRange, ">=0.4.0 <0.7.0");
  assert.equal(validation.compatibility, "compatible");
  assert.deepEqual(validation.integrity, { status: "not-declared", declaredFiles: 0 });

  const inspected = await inspectExtensionPackage(root);
  assert.equal(inspected.fileSet, "npm-pack");
  assert.deepEqual(inspected.files.map((entry) => entry.path), ["extensions/index.mjs", "package.json"]);
  assert.equal(inspected.packed?.version, "1.2.3");
});

test("extensions author dispatches as a CLI subcommand instead of model input", async (t) => {
  const { root } = await fixture(t);
  const result = spawnSync(process.execPath, [
    "--import",
    "tsx",
    resolve("src/bin/rigyn.ts"),
    "extensions",
    "author",
    "validate",
    root,
    "--json",
  ], { cwd: resolve("."), encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout) as { package: { id: string }; compatibility: string };
  assert.equal(output.package.id, "author-tool-fixture");
  assert.equal(output.compatibility, "compatible");
  assert.equal(result.stderr, "");
});

test("extension author smoke and reload dispose every author generation", async (t) => {
  const { root, log } = await fixture(t);
  assert.deepEqual(await smokeExtensionPackage(root), {
    packageId: "author-tool-fixture",
    runtimeEntries: 1,
    toolCount: 1,
    commandCount: 1,
    providerCount: 0,
    disposed: true,
  });
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
    "disposed",
  ]);
  assert.deepEqual(await reloadExtensionPackage(root), {
    packageId: "author-tool-fixture",
    runtimeEntries: 1,
    toolCount: 1,
    commandCount: 1,
    providerCount: 0,
    disposed: true,
    reloaded: true,
    warnings: [],
  });
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
    "disposed",
    "disposed",
    "disposed",
  ]);
});

test("extension author pack emits one reviewed artifact and report aggregates every check", async (t) => {
  const { root } = await fixture(t);
  const destination = join(root, "artifacts");
  const packed = await packExtensionPackage(root, destination);
  assert.match(packed.artifact, /author-tool-fixture-1\.2\.3\.tgz$/u);
  assert.match(packed.sha256, /^[a-f0-9]{64}$/u);
  await access(packed.artifact);
  assert.deepEqual(packed.packed.files.map((entry) => entry.path), ["extensions/index.mjs", "package.json"]);

  const report = await reportExtensionPackage(root);
  assert.equal(report.status, "success", JSON.stringify(report));
  assert.deepEqual(report.checks.map((entry) => [entry.name, entry.status]), [
    ["validate", "success"],
    ["inspect", "success"],
    ["smoke", "success"],
    ["reload", "success"],
  ]);
});

test("an authored archive with a host-satisfied rigyn peer installs, reloads, and removes", async (t) => {
  const { root } = await fixture(t);
  const packed = await packExtensionPackage(root, join(root, "artifacts"));
  const agentDir = join(root, "agent");
  const settings = SettingsManager.inMemory();
  const manager = new DefaultPackageManager({ cwd: root, agentDir, settingsManager: settings });
  const source = `npm:${pathToFileURL(packed.artifact).href}`;
  await manager.installAndPersist(source);
  const installedPath = manager.getInstalledPath(source, "user");
  assert.ok(installedPath);
  await assert.rejects(access(join(installedPath, "node_modules", "rigyn")), /ENOENT/u);

  const activate = async (): Promise<void> => {
    const resolved = await manager.resolve();
    const selected = resolved.extensions.filter((entry) => entry.enabled);
    const metadata = new Map(selected.map((entry) => [entry.path, {
      scope: entry.metadata.scope,
      trusted: true,
      ...(entry.metadata.baseDir === undefined ? {} : { resourceRoot: entry.metadata.baseDir }),
    }] as const));
    const host = await loadDirectExtensions(selected.map((entry) => entry.path), {
      workspace: root,
      activationFailure: "throw",
      directPathMetadata: metadata,
    });
    assert.deepEqual(host.commands().map((command) => command.name), ["author-probe"]);
    await host.close();
  };
  await activate();
  await activate();
  assert.equal(await manager.removeAndPersist(source), true);
  assert.deepEqual(manager.listConfiguredPackages(), []);
});

test("extension author report retains actionable failures without activating invalid code", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-author-invalid-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "invalid",
    rigyn: { extensions: ["missing.mjs"] },
  }));
  const report = await reportExtensionPackage(root);
  assert.equal(report.status, "error");
  assert.equal(report.checks.every((entry) => entry.status === "error"), true);
  assert.equal(report.nextActions.every((entry) => entry.startsWith("Fix ")), true);
});
