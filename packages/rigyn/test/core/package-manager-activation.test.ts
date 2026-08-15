import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";

import {
  DefaultPackageManager,
  type PackageActivationCandidate,
} from "../../src/core/package-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { loadDirectExtensions, type RuntimeExtensionHost } from "../../src/extensions/runtime.js";

interface Fixture {
  root: string;
  cwd: string;
  agentDir: string;
  settings: SettingsManager;
  settingsPath: string;
  npm: string;
}

async function fixture(context: TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "rigyn-package-candidate-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const settingsPath = join(agentDir, "config.json");
  const npm = join(root, "npm.mjs");
  await mkdir(cwd);
  await mkdir(agentDir);
  await writeFile(npm, [
    'import { mkdirSync, rmSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const args = process.argv.slice(2);',
    'const manager = args[0] === "--" ? args[1] : "npm";',
    'if (args.includes("view")) { process.stdout.write(JSON.stringify(process.env.RIGYN_TEST_LATEST_VERSION)); process.exit(0); }',
    'const install = args.indexOf("install");',
    'const uninstall = args.indexOf("uninstall");',
    'if (install < 0 && uninstall < 0) process.exit(0);',
    'const prefix = args.indexOf("--prefix");',
    'const cwd = args.indexOf("--cwd");',
    'const root = prefix >= 0 ? args[prefix + 1] : args[cwd + 1];',
    'if (uninstall >= 0) { rmSync(join(root, "node_modules", args[uninstall + 1]), { recursive: true, force: true }); process.exit(0); }',
    'const spec = args[install + 1];',
    'const names = JSON.parse(process.env.RIGYN_TEST_PACKAGE_NAMES || "{}");',
    'const name = names[spec] || process.env.RIGYN_TEST_PACKAGE_NAME || "candidate-package";',
    'const hostRange = process.env.RIGYN_TEST_REJECT_SPEC === spec ? ">=999.0.0" : process.env.RIGYN_TEST_HOST_RANGE;',
    'const target = join(root, "node_modules", name);',
    'mkdirSync(join(target, "extensions"), { recursive: true });',
    'writeFileSync(join(target, "package.json"), JSON.stringify({',
    '  name,',
    '  version: process.env.RIGYN_TEST_PACKAGE_VERSION,',
    '  peerDependencies: hostRange ? { rigyn: hostRange } : undefined,',
    '  rigyn: { extensions: ["extensions/index.mjs"] },',
    '}));',
    'writeFileSync(join(target, "extensions", "index.mjs"), process.env.RIGYN_TEST_EXTENSION_SOURCE);',
    'const extra = process.env.RIGYN_TEST_EXTRA_PACKAGE;',
    'if (extra) {',
    '  const extraTarget = join(root, "node_modules", extra);',
    '  mkdirSync(extraTarget, { recursive: true });',
    '  writeFileSync(join(extraTarget, "package.json"), JSON.stringify({ name: extra, version: "1.0.0" }));',
    '}',
    'if (spec?.startsWith("file:")) writeFileSync(join(root, "package.json"), JSON.stringify({',
    '  name: "rigyn-package-stage",',
    '  private: true,',
    '  dependencies: { [name]: spec },',
    '}));',
    'if (manager === "npm" && spec?.startsWith("file:")) writeFileSync(join(root, "package-lock.json"), JSON.stringify({',
    '  packages: {',
    '    "": { dependencies: { [name]: spec } },',
    '    ["node_modules/" + name]: { resolved: spec },',
    '    ...(extra ? { ["node_modules/" + extra]: { resolved: "https://registry.invalid/" + extra } } : {}),',
    '  },',
    '}));',
  ].join("\n"));
  const settings = SettingsManager.create(cwd, agentDir);
  settings.setNpmCommand([process.execPath, npm, "--", "npm"]);
  await settings.flush();
  context.after(async () => {
    delete process.env.RIGYN_TEST_LATEST_VERSION;
    delete process.env.RIGYN_TEST_EXTRA_PACKAGE;
    delete process.env.RIGYN_TEST_PACKAGE_NAME;
    delete process.env.RIGYN_TEST_PACKAGE_NAMES;
    delete process.env.RIGYN_TEST_PACKAGE_VERSION;
    delete process.env.RIGYN_TEST_REJECT_SPEC;
    delete process.env.RIGYN_TEST_HOST_RANGE;
    delete process.env.RIGYN_TEST_EXTENSION_SOURCE;
    delete (globalThis as Record<string, unknown>).__rigynCandidateState;
    delete (globalThis as Record<string, unknown>).__rigynCancelCandidate;
    delete (globalThis as Record<string, unknown>).__rigynExpectedPackagePath;
    await rm(root, { recursive: true, force: true });
  });
  return { root, cwd, agentDir, settings, settingsPath, npm };
}

function candidateActivator(activationTimeoutMs = 30_000, loadTimeoutMs = 30_000) {
  return async (candidate: PackageActivationCandidate): Promise<void> => {
    const selected = candidate.resources.extensions.filter((entry) => entry.enabled);
    const metadata = new Map(selected.map((entry) => [entry.path, {
      scope: entry.metadata.scope,
      trusted: entry.metadata.scope !== "project" || candidate.projectTrusted,
      ...(entry.metadata.baseDir === undefined ? {} : { resourceRoot: entry.metadata.baseDir }),
    }]));
    let host: RuntimeExtensionHost | undefined;
    try {
      host = await loadDirectExtensions(selected.map((entry) => entry.path), {
        workspace: candidate.workspace,
        dataRoot: candidate.dataRoot,
        projectTrusted: candidate.projectTrusted,
        directPathMetadata: metadata,
        activationFailure: "throw",
        activationTimeoutMs,
        loadTimeoutMs,
        ...(candidate.signal === undefined ? {} : { signal: candidate.signal }),
      });
    } finally {
      await host?.close();
    }
  };
}

function packageManager(value: Fixture, activationTimeoutMs = 30_000): DefaultPackageManager {
  return new DefaultPackageManager({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    activateCandidate: candidateActivator(activationTimeoutMs),
  });
}

async function writeLocalPackage(root: string, factory: string): Promise<string> {
  const packageRoot = join(root, "local-package");
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "local-package",
    rigyn: { extensions: ["extensions/index.mjs"] },
  }));
  await writeFile(join(packageRoot, "extensions", "index.mjs"), factory);
  return packageRoot;
}

async function tree(root: string): Promise<Array<[string, Buffer]>> {
  const entries: Array<[string, Buffer]> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else entries.push([relative(root, path), await readFile(path)]);
    }
  };
  await visit(root);
  return entries.sort(([left], [right]) => left.localeCompare(right));
}

async function assertNoResidue(value: Fixture): Promise<void> {
  const roots = [value.agentDir, join(value.cwd, ".rigyn")];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    assert.deepEqual(
      (await readdir(root)).filter((entry) => entry.startsWith(".rigyn-package-stage-")),
      [],
    );
  }
  const activationRoot = join(value.agentDir, "tmp", "extensions");
  if (existsSync(activationRoot)) {
    assert.deepEqual(
      (await readdir(activationRoot)).filter((entry) => entry.startsWith("package-activation-")),
      [],
    );
  }
}

async function onlySourceReceipt(value: Fixture): Promise<string> {
  const root = join(value.agentDir, "npm", ".rigyn-sources");
  const receipts = (await readdir(root)).filter((entry) => entry.endsWith(".json"));
  assert.equal(receipts.length, 1);
  return join(root, receipts[0]!);
}

test("install activates a staged package.json direct factory before committing package code or settings", async (context) => {
  const value = await fixture(context);
  const finalPath = join(value.agentDir, "npm", "node_modules", "candidate-package");
  (globalThis as Record<string, unknown>).__rigynExpectedPackagePath = finalPath;
  process.env.RIGYN_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.RIGYN_TEST_EXTENSION_SOURCE = `
    import { existsSync } from "node:fs";
    export default (api) => {
      globalThis.__rigynCandidateState = { api, committedDuringActivation: existsSync(globalThis.__rigynExpectedPackagePath) };
      api.registerCommand("candidate", { handler() {} });
    };
  `;
  const manager = packageManager(value);

  await manager.installAndPersist("npm:candidate-package");
  await value.settings.flush();

  const state = (globalThis as Record<string, any>).__rigynCandidateState;
  assert.equal(state.committedDuringActivation, false);
  assert.throws(() => state.api.getCommands(), /no longer active|stale|closed/iu);
  assert.equal(JSON.parse(await readFile(join(finalPath, "package.json"), "utf8")).version, "1.0.0");
  assert.deepEqual(value.settings.getGlobalSettings().packages, ["npm:candidate-package"]);
  await assertNoResidue(value);
});

test("project archive installs activate and resolve by the package name inside the archive", async (context) => {
  const value = await fixture(context);
  value.settings.setProjectTrusted(true);
  const archive = join(value.root, "renamed-archive.tgz");
  await writeFile(archive, "fixture archive contents");
  const source = `npm:${pathToFileURL(archive).href}`;
  const finalPath = join(value.cwd, ".rigyn", "npm", "node_modules", "candidate-package");
  (globalThis as Record<string, unknown>).__rigynExpectedPackagePath = finalPath;
  process.env.RIGYN_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.RIGYN_TEST_EXTENSION_SOURCE = `
    import { existsSync } from "node:fs";
    export default () => {
      globalThis.__rigynCandidateState = { committedDuringActivation: existsSync(globalThis.__rigynExpectedPackagePath) };
    };
  `;

  await packageManager(value).installAndPersist(source, { local: true });
  await value.settings.flush();

  assert.equal((globalThis as Record<string, any>).__rigynCandidateState.committedDuringActivation, false);
  assert.equal(packageManager(value).getInstalledPath(source, "project"), finalPath);
  assert.deepEqual(value.settings.getProjectSettings().packages, [source]);
  await rm(join(value.cwd, ".rigyn", "npm", ".rigyn-sources"), { recursive: true, force: true });
  assert.equal(packageManager(value).getInstalledPath(source, "project"), finalPath);
  await assertNoResidue(value);
});

test("multiple bare archive sources retain their installed package identities", async (context) => {
  const value = await fixture(context);
  const firstArchive = join(value.root, "first-archive.tgz");
  const secondArchive = join(value.root, "second-archive.tgz");
  await writeFile(firstArchive, "first fixture archive contents");
  await writeFile(secondArchive, "second fixture archive contents");
  const firstSource = `npm:${pathToFileURL(firstArchive).href}`;
  const secondSource = `npm:${pathToFileURL(secondArchive).href}`;
  process.env.RIGYN_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.RIGYN_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  process.env.RIGYN_TEST_EXTRA_PACKAGE = "transitive-package";
  const manager = packageManager(value);

  process.env.RIGYN_TEST_PACKAGE_NAME = "first-package";
  await manager.installAndPersist(firstSource);
  process.env.RIGYN_TEST_PACKAGE_NAME = "second-package";
  await manager.installAndPersist(secondSource);
  await value.settings.flush();

  const restarted = packageManager(value);
  const firstPath = join(value.agentDir, "npm", "node_modules", "first-package");
  const secondPath = join(value.agentDir, "npm", "node_modules", "second-package");
  assert.equal(restarted.getInstalledPath(firstSource, "user"), firstPath);
  assert.equal(restarted.getInstalledPath(secondSource, "user"), secondPath);
  assert.deepEqual(
    restarted.listConfiguredPackages().map((entry) => entry.installedPath),
    [firstPath, secondPath],
  );
  const resolved = await restarted.resolve(async () => "skip");
  assert.deepEqual(resolved.extensions.map((entry) => entry.path).sort(), [
    join(firstPath, "extensions", "index.mjs"),
    join(secondPath, "extensions", "index.mjs"),
  ]);
  await rm(firstPath, { recursive: true, force: true });
  assert.equal(restarted.getInstalledPath(firstSource, "user"), undefined);
  assert.equal(restarted.getInstalledPath(secondSource, "user"), secondPath);
  await restarted.removeAndPersist(firstSource);
  await value.settings.flush();
  assert.deepEqual(value.settings.getGlobalSettings().packages, [secondSource]);
  assert.equal((await readdir(join(value.agentDir, "npm", ".rigyn-sources"))).length, 1);
  await assertNoResidue(value);
});

test("legacy multiple bare archive installs recover their receipts deterministically after restart", async (context) => {
  const value = await fixture(context);
  const firstArchive = join(value.root, "legacy-first-archive.tgz");
  const secondArchive = join(value.root, "legacy-second-archive.tgz");
  await writeFile(firstArchive, "legacy first fixture archive contents");
  await writeFile(secondArchive, "legacy second fixture archive contents");
  const firstSource = `npm:${pathToFileURL(firstArchive).href}`;
  const secondSource = `npm:${pathToFileURL(secondArchive).href}`;
  const firstName = "legacy-first-package";
  const secondName = "legacy-second-package";
  process.env.RIGYN_TEST_PACKAGE_NAMES = JSON.stringify({
    [firstSource.slice(4)]: firstName,
    [secondSource.slice(4)]: secondName,
  });
  process.env.RIGYN_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.RIGYN_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  process.env.RIGYN_TEST_EXTRA_PACKAGE = "legacy-transitive-package";
  const manager = packageManager(value);
  await manager.installAndPersist(firstSource);
  await manager.installAndPersist(secondSource);
  await value.settings.flush();
  const receiptRoot = join(value.agentDir, "npm", ".rigyn-sources");
  await rm(receiptRoot, { recursive: true, force: true });

  const restarted = packageManager(value);
  assert.equal(restarted.getInstalledPath(firstSource, "user"), undefined);
  assert.equal(restarted.getInstalledPath(secondSource, "user"), undefined);
  const resolved = await restarted.resolve();

  const firstPath = join(value.agentDir, "npm", "node_modules", firstName);
  const secondPath = join(value.agentDir, "npm", "node_modules", secondName);
  assert.deepEqual(resolved.extensions.map((entry) => entry.path).sort(), [
    join(firstPath, "extensions", "index.mjs"),
    join(secondPath, "extensions", "index.mjs"),
  ]);
  assert.deepEqual(
    (await Promise.all((await readdir(receiptRoot)).map(async (entry) => JSON.parse(await readFile(join(receiptRoot, entry), "utf8")).name))).sort(),
    [firstName, secondName],
  );
  assert.equal(packageManager(value).getInstalledPath(firstSource, "user"), firstPath);
  assert.equal(packageManager(value).getInstalledPath(secondSource, "user"), secondPath);
  await rm(receiptRoot, { recursive: true, force: true });
  const removalRestart = packageManager(value);
  await removalRestart.removeAndPersist(firstSource);
  await value.settings.flush();
  assert.equal(existsSync(firstPath), false);
  assert.equal(removalRestart.getInstalledPath(secondSource, "user"), secondPath);
  assert.deepEqual(value.settings.getGlobalSettings().packages, [secondSource]);
  assert.deepEqual(
    await Promise.all((await readdir(receiptRoot)).map(async (entry) => JSON.parse(await readFile(join(receiptRoot, entry), "utf8")).name)),
    [secondName],
  );
  await assertNoResidue(value);
});

test("offline legacy receipt reconciliation does not run the package manager or mutate state", async (context) => {
  const value = await fixture(context);
  const firstArchive = join(value.root, "offline-first-archive.tgz");
  const secondArchive = join(value.root, "offline-second-archive.tgz");
  await writeFile(firstArchive, "offline first fixture archive contents");
  await writeFile(secondArchive, "offline second fixture archive contents");
  const firstSource = `npm:${pathToFileURL(firstArchive).href}`;
  const secondSource = `npm:${pathToFileURL(secondArchive).href}`;
  process.env.RIGYN_TEST_PACKAGE_NAMES = JSON.stringify({
    [firstSource.slice(4)]: "offline-first-package",
    [secondSource.slice(4)]: "offline-second-package",
  });
  process.env.RIGYN_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.RIGYN_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  const manager = packageManager(value);
  await manager.installAndPersist(firstSource);
  await manager.installAndPersist(secondSource);
  await rm(join(value.agentDir, "npm", ".rigyn-sources"), { recursive: true, force: true });
  value.settings.setNpmCommand(["/rigyn-test-package-command-must-not-run"]);
  await value.settings.flush();
  const npmBefore = await tree(join(value.agentDir, "npm"));
  const settingsBefore = await readFile(value.settingsPath);
  const skipping = packageManager(value);
  assert.equal(skipping.listConfiguredPackages().every((entry) => entry.installedPath === undefined), true);
  assert.deepEqual((await skipping.resolve(async () => "skip")).extensions, []);
  const offline = new DefaultPackageManager({
    cwd: value.cwd,
    agentDir: value.agentDir,
    settingsManager: value.settings,
    activateCandidate: candidateActivator(),
    offline: true,
  });

  assert.deepEqual((await offline.resolve()).extensions, []);
  await assert.rejects(offline.removeAndPersist(firstSource), /while offline/iu);

  assert.deepEqual(await tree(join(value.agentDir, "npm")), npmBefore);
  assert.deepEqual(await readFile(value.settingsPath), settingsBefore);
  assert.deepEqual(value.settings.getGlobalSettings().packages, [firstSource, secondSource]);
  await assertNoResidue(value);
});

test("a bare archive cannot overwrite a destination owned by another source", async (context) => {
  const value = await fixture(context);
  const firstArchive = join(value.root, "collision-first.tgz");
  const secondArchive = join(value.root, "collision-second.tgz");
  await writeFile(firstArchive, "first collision fixture archive contents");
  await writeFile(secondArchive, "second collision fixture archive contents");
  const firstSource = `npm:${pathToFileURL(firstArchive).href}`;
  const secondSource = `npm:${pathToFileURL(secondArchive).href}`;
  process.env.RIGYN_TEST_PACKAGE_NAME = "shared-archive-package";
  process.env.RIGYN_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.RIGYN_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  const manager = packageManager(value);

  await manager.installAndPersist(firstSource);
  await assert.rejects(manager.installAndPersist(secondSource), /already owned by another package source/u);
  await value.settings.flush();

  assert.equal(
    manager.getInstalledPath(firstSource, "user"),
    join(value.agentDir, "npm", "node_modules", "shared-archive-package"),
  );
  assert.equal(manager.getInstalledPath(secondSource, "user"), undefined);
  assert.deepEqual(value.settings.getGlobalSettings().packages, [firstSource]);
  assert.equal((await readdir(join(value.agentDir, "npm", ".rigyn-sources"))).length, 1);
  await assertNoResidue(value);
});

test("a bare archive cannot overwrite a configured named npm package", async (context) => {
  const value = await fixture(context);
  const archive = join(value.root, "named-first-collision.tgz");
  await writeFile(archive, "named-first collision fixture archive contents");
  const archiveSource = `npm:${pathToFileURL(archive).href}`;
  const namedSource = "npm:cross-kind-package";
  process.env.RIGYN_TEST_PACKAGE_NAME = "cross-kind-package";
  process.env.RIGYN_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.RIGYN_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  const manager = packageManager(value);

  await manager.installAndPersist(namedSource);
  await assert.rejects(manager.installAndPersist(archiveSource), /already owned by another package source/u);
  await value.settings.flush();

  assert.equal(
    manager.getInstalledPath(namedSource, "user"),
    join(value.agentDir, "npm", "node_modules", "cross-kind-package"),
  );
  assert.equal(manager.getInstalledPath(archiveSource, "user"), undefined);
  assert.deepEqual(value.settings.getGlobalSettings().packages, [namedSource]);
  await assertNoResidue(value);
});

test("a named npm package cannot overwrite a destination owned by a bare archive", async (context) => {
  const value = await fixture(context);
  const archive = join(value.root, "archive-first-collision.tgz");
  await writeFile(archive, "archive-first collision fixture archive contents");
  const archiveSource = `npm:${pathToFileURL(archive).href}`;
  const namedSource = "npm:cross-kind-package";
  process.env.RIGYN_TEST_PACKAGE_NAME = "cross-kind-package";
  process.env.RIGYN_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.RIGYN_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  const manager = packageManager(value);

  await manager.installAndPersist(archiveSource);
  await assert.rejects(manager.installAndPersist(namedSource), /already owned by another package source/u);
  await value.settings.flush();

  assert.equal(
    manager.getInstalledPath(archiveSource, "user"),
    join(value.agentDir, "npm", "node_modules", "cross-kind-package"),
  );
  assert.deepEqual(value.settings.getGlobalSettings().packages, [archiveSource]);
  await assertNoResidue(value);
});

test("a missing bare receipt never falls back to a configured named package destination", async (context) => {
  const value = await fixture(context);
  const archive = join(value.root, "missing-receipt-cross-kind.tgz");
  await writeFile(archive, "missing receipt cross-kind fixture archive contents");
  const archiveSource = `npm:${pathToFileURL(archive).href}`;
  const namedSource = "npm:fallback-named-package";
  process.env.RIGYN_TEST_PACKAGE_NAMES = JSON.stringify({
    [archiveSource.slice(4)]: "fallback-bare-package",
    "fallback-named-package": "fallback-named-package",
  });
  process.env.RIGYN_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.RIGYN_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  const manager = packageManager(value);
  await manager.installAndPersist(archiveSource);
  await manager.installAndPersist(namedSource);
  await value.settings.flush();
  await rm(join(value.agentDir, "npm", ".rigyn-sources"), { recursive: true, force: true });
  await rm(join(value.agentDir, "npm", "node_modules", "fallback-bare-package"), { recursive: true, force: true });

  const restarted = packageManager(value);
  assert.equal(restarted.getInstalledPath(archiveSource, "user"), undefined);
  assert.equal(
    restarted.getInstalledPath(namedSource, "user"),
    join(value.agentDir, "npm", "node_modules", "fallback-named-package"),
  );
  await assertNoResidue(value);
});

test("removeAndPersist validates the exact configured npm source before uninstall", async (context) => {
  {
    const value = await fixture(context);
    const archive = join(value.root, "remove-bare-source.tgz");
    await writeFile(archive, "remove bare source fixture archive contents");
    const archiveSource = `npm:${pathToFileURL(archive).href}`;
    process.env.RIGYN_TEST_PACKAGE_NAME = "remove-exact-package";
    process.env.RIGYN_TEST_PACKAGE_VERSION = "1.0.0";
    process.env.RIGYN_TEST_EXTENSION_SOURCE = "export default () => {};\n";
    const manager = packageManager(value);
    await manager.installAndPersist(archiveSource);
    await value.settings.flush();
    const installed = join(value.agentDir, "npm", "node_modules", "remove-exact-package");

    await assert.rejects(manager.removeAndPersist("npm:remove-exact-package"), /package source is not configured/iu);

    assert.equal(existsSync(installed), true);
    assert.equal(manager.getInstalledPath(archiveSource, "user"), installed);
    assert.deepEqual(value.settings.getGlobalSettings().packages, [archiveSource]);
    await assertNoResidue(value);
  }

  {
    const value = await fixture(context);
    const configuredSource = "npm:remove-versioned-package@1.0.0";
    process.env.RIGYN_TEST_PACKAGE_NAME = "remove-versioned-package";
    process.env.RIGYN_TEST_PACKAGE_VERSION = "1.0.0";
    process.env.RIGYN_TEST_EXTENSION_SOURCE = "export default () => {};\n";
    const manager = packageManager(value);
    await manager.installAndPersist(configuredSource);
    await value.settings.flush();
    const installed = join(value.agentDir, "npm", "node_modules", "remove-versioned-package");

    await assert.rejects(manager.removeAndPersist("npm:remove-versioned-package@2.0.0"), /package source is not configured/iu);

    assert.equal(existsSync(installed), true);
    assert.deepEqual(value.settings.getGlobalSettings().packages, [configuredSource]);
    await assertNoResidue(value);
  }
});

test("configured bare archives reject ambiguous receipt-loss renames and recover unchanged identity", async (context) => {
  for (const receiptState of ["missing", "corrupt"] as const) {
    const value = await fixture(context);
    const archive = join(value.root, `${receiptState}-rename-source.tgz`);
    await writeFile(archive, `${receiptState} rename fixture archive contents`);
    const source = `npm:${pathToFileURL(archive).href}`;
    const originalName = `${receiptState}-original-package`;
    const renamedName = `${receiptState}-renamed-package`;
    process.env.RIGYN_TEST_PACKAGE_NAME = originalName;
    process.env.RIGYN_TEST_PACKAGE_VERSION = "1.0.0";
    process.env.RIGYN_TEST_EXTENSION_SOURCE = "export default () => {};\n";
    const manager = packageManager(value);
    await manager.installAndPersist(source);
    await value.settings.flush();
    const receipt = await onlySourceReceipt(value);
    if (receiptState === "missing") await rm(receipt, { force: true });
    else await writeFile(receipt, "{");

    process.env.RIGYN_TEST_PACKAGE_NAME = renamedName;
    await assert.rejects(manager.update(source), /cannot recover installed npm package identity/iu);

    const originalPath = join(value.agentDir, "npm", "node_modules", originalName);
    assert.equal(existsSync(originalPath), true);
    assert.equal(existsSync(join(value.agentDir, "npm", "node_modules", renamedName)), false);
    assert.deepEqual(value.settings.getGlobalSettings().packages, [source]);

    process.env.RIGYN_TEST_PACKAGE_NAME = originalName;
    await manager.update(source);
    const repaired = await onlySourceReceipt(value);
    assert.deepEqual(JSON.parse(await readFile(repaired, "utf8")), { name: originalName });
    assert.deepEqual(await readdir(dirname(repaired)), [basename(repaired)]);
    assert.equal(manager.getInstalledPath(source, "user"), originalPath);
    await assertNoResidue(value);
  }
});

test("a bare source cannot claim a configured bare package whose receipt is missing or corrupt", async (context) => {
  for (const receiptState of ["missing", "corrupt"] as const) {
    const value = await fixture(context);
    const firstArchive = join(value.root, `${receiptState}-owner-first.tgz`);
    const secondArchive = join(value.root, `${receiptState}-owner-second.tgz`);
    await writeFile(firstArchive, `${receiptState} owner first fixture archive contents`);
    await writeFile(secondArchive, `${receiptState} owner second fixture archive contents`);
    const firstSource = `npm:${pathToFileURL(firstArchive).href}`;
    const secondSource = `npm:${pathToFileURL(secondArchive).href}`;
    const name = `${receiptState}-unreceipted-package`;
    process.env.RIGYN_TEST_PACKAGE_NAME = name;
    process.env.RIGYN_TEST_PACKAGE_VERSION = "1.0.0";
    process.env.RIGYN_TEST_EXTENSION_SOURCE = "export default () => {};\n";
    const manager = packageManager(value);
    await manager.installAndPersist(firstSource);
    await value.settings.flush();
    const receipt = await onlySourceReceipt(value);
    if (receiptState === "missing") await rm(receipt, { force: true });
    else await writeFile(receipt, "{");

    await assert.rejects(manager.installAndPersist(secondSource), /already owned by another package source|package ownership is ambiguous/iu);

    assert.equal(existsSync(join(value.agentDir, "npm", "node_modules", name)), true);
    assert.deepEqual(value.settings.getGlobalSettings().packages, [firstSource]);
    if (receiptState === "missing") assert.equal(existsSync(receipt), false);
    else assert.equal(await readFile(receipt, "utf8"), "{");
    await assertNoResidue(value);
  }
});

test("configured pnpm and Bun identify bare archives from staged root metadata", async (context) => {
  for (const managerName of ["pnpm", "bun"] as const) {
    const value = await fixture(context);
    value.settings.setNpmCommand([process.execPath, value.npm, "--", managerName]);
    const archive = join(value.root, `${managerName}-archive.tgz`);
    await writeFile(archive, `${managerName} fixture archive contents`);
    const source = `npm:${pathToFileURL(archive).href}`;
    const name = `${managerName}-package`;
    process.env.RIGYN_TEST_PACKAGE_NAME = name;
    process.env.RIGYN_TEST_PACKAGE_VERSION = "1.0.0";
    process.env.RIGYN_TEST_EXTENSION_SOURCE = "export default () => {};\n";
    process.env.RIGYN_TEST_EXTRA_PACKAGE = `${managerName}-transitive-package`;

    await packageManager(value).installAndPersist(source);
    await value.settings.flush();

    assert.equal(
      packageManager(value).getInstalledPath(source, "user"),
      join(value.agentDir, "npm", "node_modules", name),
    );
    await assertNoResidue(value);
  }
});

test("bare archive receipts roll back with updates and are removed on uninstall", async (context) => {
  const value = await fixture(context);
  const firstArchive = join(value.root, "rollback-first.tgz");
  const secondArchive = join(value.root, "rollback-second.tgz");
  await writeFile(firstArchive, "first rollback fixture archive contents");
  await writeFile(secondArchive, "second rollback fixture archive contents");
  const firstSource = `npm:${pathToFileURL(firstArchive).href}`;
  const secondSource = `npm:${pathToFileURL(secondArchive).href}`;
  const firstSpec = firstSource.slice(4);
  const secondSpec = secondSource.slice(4);
  const manager = packageManager(value);
  process.env.RIGYN_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.RIGYN_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  process.env.RIGYN_TEST_PACKAGE_NAMES = JSON.stringify({
    [firstSpec]: "rollback-first-package",
    [secondSpec]: "rollback-second-package",
  });
  await manager.installAndPersist(firstSource);
  await manager.installAndPersist(secondSource);
  await value.settings.flush();
  const firstPath = join(value.agentDir, "npm", "node_modules", "rollback-first-package");
  const secondPath = join(value.agentDir, "npm", "node_modules", "rollback-second-package");

  process.env.RIGYN_TEST_PACKAGE_NAMES = JSON.stringify({
    [firstSpec]: "rollback-renamed-package",
    [secondSpec]: "rollback-second-package",
  });
  await assert.rejects(manager.update(firstSource), /package identity changed/u);
  assert.equal(manager.getInstalledPath(firstSource, "user"), firstPath);
  assert.equal(existsSync(join(value.agentDir, "npm", "node_modules", "rollback-renamed-package")), false);

  process.env.RIGYN_TEST_PACKAGE_NAMES = JSON.stringify({
    [firstSpec]: "rollback-first-package",
    [secondSpec]: "rollback-second-package",
  });
  process.env.RIGYN_TEST_REJECT_SPEC = secondSpec;
  await assert.rejects(manager.update(), /requires rigyn >=999\.0\.0/u);

  assert.equal(manager.getInstalledPath(firstSource, "user"), firstPath);
  assert.equal(manager.getInstalledPath(secondSource, "user"), secondPath);
  assert.equal(existsSync(join(value.agentDir, "npm", "node_modules", "rollback-renamed-package")), false);
  delete process.env.RIGYN_TEST_REJECT_SPEC;
  await manager.removeAndPersist(firstSource);
  await value.settings.flush();
  assert.equal(manager.getInstalledPath(firstSource, "user"), undefined);
  assert.equal(manager.getInstalledPath(secondSource, "user"), secondPath);
  assert.deepEqual(value.settings.getGlobalSettings().packages, [secondSource]);
  assert.equal((await readdir(join(value.agentDir, "npm", ".rigyn-sources"))).length, 1);
  await assertNoResidue(value);
});

test("failed bare archive update preserves legacy packages and missing receipts byte-for-byte", async (context) => {
  const value = await fixture(context);
  const firstArchive = join(value.root, "legacy-rollback-first.tgz");
  const secondArchive = join(value.root, "legacy-rollback-second.tgz");
  await writeFile(firstArchive, "legacy rollback first fixture archive contents");
  await writeFile(secondArchive, "legacy rollback second fixture archive contents");
  const firstSource = `npm:${pathToFileURL(firstArchive).href}`;
  const secondSource = `npm:${pathToFileURL(secondArchive).href}`;
  process.env.RIGYN_TEST_PACKAGE_NAMES = JSON.stringify({
    [firstSource.slice(4)]: "legacy-rollback-first-package",
    [secondSource.slice(4)]: "legacy-rollback-second-package",
  });
  process.env.RIGYN_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.RIGYN_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  const manager = packageManager(value);
  await manager.installAndPersist(firstSource);
  await manager.installAndPersist(secondSource);
  await value.settings.flush();
  const npmRoot = join(value.agentDir, "npm");
  await rm(join(npmRoot, ".rigyn-sources"), { recursive: true, force: true });
  const installedBefore = await tree(npmRoot);
  const settingsBefore = await readFile(value.settingsPath);
  process.env.RIGYN_TEST_EXTENSION_SOURCE = 'export default () => { throw new Error("legacy update rejected"); };\n';

  await assert.rejects(manager.update(firstSource), /legacy update rejected/u);

  assert.deepEqual(await tree(npmRoot), installedBefore);
  assert.deepEqual(await readFile(value.settingsPath), settingsBefore);
  await assertNoResidue(value);
});

test("an incompatible rigyn peer is rejected before package code or settings commit", async (context) => {
  const value = await fixture(context);
  process.env.RIGYN_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.RIGYN_TEST_HOST_RANGE = ">=999.0.0";
  process.env.RIGYN_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  const manager = packageManager(value);

  await assert.rejects(manager.installAndPersist("npm:candidate-package"), /requires rigyn >=999\.0\.0/u);

  assert.equal(existsSync(join(value.agentDir, "npm")), false);
  assert.deepEqual(value.settings.getGlobalSettings().packages, undefined);
  await assertNoResidue(value);
});

test("failed update activation preserves installed code and settings byte-for-byte", async (context) => {
  const value = await fixture(context);
  const manager = packageManager(value);
  process.env.RIGYN_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.RIGYN_TEST_EXTENSION_SOURCE = "export default () => {};\n";
  await manager.installAndPersist("npm:candidate-package");
  await value.settings.flush();
  const finalPath = join(value.agentDir, "npm");
  const installedBefore = await tree(finalPath);
  const settingsBefore = await readFile(value.settingsPath);

  process.env.RIGYN_TEST_LATEST_VERSION = "2.0.0";
  process.env.RIGYN_TEST_PACKAGE_VERSION = "2.0.0";
  process.env.RIGYN_TEST_EXTENSION_SOURCE = `
    export default (api) => {
      globalThis.__rigynCandidateState = { api };
      throw new Error("candidate update rejected");
    };
  `;

  await assert.rejects(manager.update("npm:candidate-package"), /candidate update rejected/u);

  assert.deepEqual(await tree(finalPath), installedBefore);
  assert.deepEqual(await readFile(value.settingsPath), settingsBefore);
  assert.throws(
    () => (globalThis as Record<string, any>).__rigynCandidateState.api.getCommands(),
    /no longer active|stale|closed/iu,
  );
  await assertNoResidue(value);
});

test("missing configured packages activate from staging before reconciliation commits code", async (context) => {
  const value = await fixture(context);
  value.settings.setPackages(["npm:candidate-package"]);
  await value.settings.flush();
  const settingsBefore = await readFile(value.settingsPath);
  process.env.RIGYN_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.RIGYN_TEST_EXTENSION_SOURCE = `
    export default (api) => {
      globalThis.__rigynCandidateState = { api };
      throw new Error("configured candidate rejected");
    };
  `;

  await assert.rejects(packageManager(value).resolve(), /configured candidate rejected/u);

  assert.equal(existsSync(join(value.agentDir, "npm")), false);
  assert.deepEqual(await readFile(value.settingsPath), settingsBefore);
  assert.throws(
    () => (globalThis as Record<string, any>).__rigynCandidateState.api.getCommands(),
    /no longer active|stale|closed/iu,
  );
  await assertNoResidue(value);
});

test("activation timeout and cancellation clean staged code without persisting package settings", async (context) => {
  const value = await fixture(context);
  process.env.RIGYN_TEST_PACKAGE_VERSION = "1.0.0";
  process.env.RIGYN_TEST_EXTENSION_SOURCE = `
    export default async (api) => {
      globalThis.__rigynCandidateState = { api };
      globalThis.__rigynCancelCandidate?.();
      await new Promise(() => {});
    };
  `;
  const settingsBefore = await readFile(value.settingsPath);

  await assert.rejects(
    packageManager(value, 25).installAndPersist("npm:candidate-package"),
    /timed out after 25ms/u,
  );
  assert.deepEqual(await readFile(value.settingsPath), settingsBefore);
  assert.equal(existsSync(join(value.agentDir, "npm")), false);
  assert.throws(
    () => (globalThis as Record<string, any>).__rigynCandidateState.api.getCommands(),
    /no longer active|stale|closed/iu,
  );
  await assertNoResidue(value);

  const controller = new AbortController();
  (globalThis as Record<string, unknown>).__rigynCancelCandidate = () => {
    controller.abort(new Error("candidate cancelled"));
  };
  const cancellation = packageManager(value).installAndPersist("npm:candidate-package", { signal: controller.signal });
  await assert.rejects(cancellation, /candidate cancelled/u);
  assert.deepEqual(await readFile(value.settingsPath), settingsBefore);
  assert.equal(existsSync(join(value.agentDir, "npm")), false);
  assert.throws(
    () => (globalThis as Record<string, any>).__rigynCandidateState.api.getCommands(),
    /no longer active|stale|closed/iu,
  );
  await assertNoResidue(value);
});

test("candidate activation cannot use live session authority", async (context) => {
  const value = await fixture(context);
  const packageRoot = await writeLocalPackage(value.root, `
    export default (api) => {
      api.sendUserMessage("must not reach a session", { deliverAs: "followUp" });
    };
  `);
  const settingsBefore = await readFile(value.settingsPath);

  await assert.rejects(
    packageManager(value).installAndPersist(packageRoot),
    /actions are unavailable before the session host is bound/u,
  );

  assert.deepEqual(await readFile(value.settingsPath), settingsBefore);
  assert.deepEqual(value.settings.getGlobalSettings().packages, undefined);
  await assertNoResidue(value);
});
