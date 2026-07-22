import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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
  const settingsPath = join(agentDir, "settings.json");
  const npm = join(root, "npm.mjs");
  await mkdir(cwd);
  await mkdir(agentDir);
  await writeFile(npm, [
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const args = process.argv.slice(2);',
    'if (args.includes("view")) { process.stdout.write(JSON.stringify(process.env.RIGYN_TEST_LATEST_VERSION)); process.exit(0); }',
    'const prefix = args.indexOf("--prefix");',
    'const cwd = args.indexOf("--cwd");',
    'const root = prefix >= 0 ? args[prefix + 1] : args[cwd + 1];',
    'const install = args.indexOf("install");',
    'const spec = install >= 0 ? args[install + 1] : undefined;',
    'const target = join(root, "node_modules", "candidate-package");',
    'mkdirSync(join(target, "extensions"), { recursive: true });',
    'writeFileSync(join(target, "package.json"), JSON.stringify({',
    '  name: "candidate-package",',
    '  version: process.env.RIGYN_TEST_PACKAGE_VERSION,',
    '  peerDependencies: process.env.RIGYN_TEST_HOST_RANGE ? { rigyn: process.env.RIGYN_TEST_HOST_RANGE } : undefined,',
    '  rigyn: { extensions: ["extensions/index.mjs"] },',
    '}));',
    'writeFileSync(join(target, "extensions", "index.mjs"), process.env.RIGYN_TEST_EXTENSION_SOURCE);',
    'if (spec?.startsWith("file:")) writeFileSync(join(root, "package-lock.json"), JSON.stringify({',
    '  packages: { "node_modules/candidate-package": { resolved: spec } },',
    '}));',
  ].join("\n"));
  const settings = SettingsManager.create(cwd, agentDir);
  settings.setNpmCommand([process.execPath, npm, "--", "npm"]);
  await settings.flush();
  context.after(async () => {
    delete process.env.RIGYN_TEST_LATEST_VERSION;
    delete process.env.RIGYN_TEST_PACKAGE_VERSION;
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
