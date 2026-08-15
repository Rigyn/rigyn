import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";

import {
  inspectExtensionPackage,
  packExtensionPackage,
  refreshExtensionPackage,
  reportExtensionPackage,
  smokeExtensionPackage,
  validateExtensionPackage,
} from "../../src/cli/extension-author.js";
import { DefaultPackageManager } from "../../src/core/package-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { loadDirectExtensions } from "../../src/extensions/runtime.js";

const AUTHOR_MANIFEST_BYTES = 1024 * 1024;

function paddedManifest(value: unknown, bytes: number): string {
  const source = JSON.stringify(value);
  assert.ok(Buffer.byteLength(source) <= bytes);
  return `${source}${" ".repeat(bytes - Buffer.byteLength(source))}`;
}

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
    peerDependencies: { rigyn: ">=0.1.0 <0.2.0" },
    rigyn: { extensions: ["extensions/index.mjs"] },
  }));
  await writeFile(join(root, "extensions", "index.mjs"), `
    import { appendFile } from "node:fs/promises";
    export default function activate(api) {
      api.registerCommand("author-probe", {
        async handler(args) {
          if (args === "write-config") {
            const current = await api.config.read("workspace");
            await api.config.replace("workspace", { retained: true }, {
              expectedRevision: current.revision,
            });
            return "written";
          }
          if (args === "read-config") {
            const current = await api.config.read("workspace");
            return JSON.stringify(current.value);
          }
        }
      });
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
  assert.equal(validation.package.hostVersionRange, ">=0.1.0 <0.2.0");
  assert.equal(validation.compatibility, "compatible");
  assert.deepEqual(validation.integrity, { status: "not-declared", declaredFiles: 0 });

  const inspected = await inspectExtensionPackage(root);
  assert.equal(inspected.fileSet, "npm-pack");
  assert.deepEqual(inspected.files.map((entry) => entry.path), ["extensions/index.mjs", "package.json"]);
  assert.equal(inspected.packed?.version, "1.2.3");
});

test("extension author package manifests enforce the exact 1 MiB bound", async (t) => {
  const roots = await Promise.all(["exact", "oversized"].map(async (name) => {
    const root = await mkdtemp(join(tmpdir(), `rigyn-author-${name}-`));
    await mkdir(join(root, "extensions"));
    await writeFile(join(root, "extensions", "index.mjs"), "export default function activate() {}\n");
    return root;
  }));
  t.after(async () => await Promise.all(roots.map(async (root) => await rm(root, { recursive: true, force: true }))));
  const manifest = (name: string) => ({
    name,
    version: "1.0.0",
    rigyn: { extensions: ["extensions/index.mjs"] },
  });
  await writeFile(join(roots[0]!, "package.json"), paddedManifest(manifest("bounded-author-exact"), AUTHOR_MANIFEST_BYTES));
  await writeFile(join(roots[1]!, "package.json"), paddedManifest(manifest("bounded-author-oversized"), AUTHOR_MANIFEST_BYTES + 1));

  assert.equal((await validateExtensionPackage(roots[0]!)).package.name, "bounded-author-exact");
  await assert.rejects(
    validateExtensionPackage(roots[1]!),
    /package\.json must be a regular file no larger than 1048576 bytes/u,
  );
});

test("extension author validation counts active declared contributions sharing files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-author-declarations-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(root, "runtime"), { recursive: true }),
    mkdir(join(root, "skills", "one"), { recursive: true }),
    mkdir(join(root, "templates"), { recursive: true }),
    mkdir(join(root, "themes"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "package.json"), JSON.stringify({
      name: "author-declared-fixture",
      version: "1.0.0",
      type: "module",
    })),
    writeFile(join(root, "runtime", "index.mjs"), "export default function activate() {}\n"),
    writeFile(
      join(root, "skills", "one", "SKILL.md"),
      "---\nname: author-declared-skill\ndescription: Declared author skill\n---\nBody\n",
    ),
    writeFile(join(root, "templates", "shared.md"), "Shared template\n"),
    writeFile(join(root, "themes", "one.json"), JSON.stringify({
      schemaVersion: 1,
      name: "author-declared-theme-one",
      base: "dark",
      styles: {},
    })),
    writeFile(join(root, "themes", "two.json"), JSON.stringify({
      schemaVersion: 1,
      name: "author-declared-theme-two",
      base: "dark",
      styles: {},
    })),
    writeFile(join(root, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "author-declared",
      name: "Author declared",
      version: "1.0.0",
      contributions: {
        runtime: [{ path: "runtime/index.mjs" }],
        skillRoots: [{ path: "skills" }],
        prompts: [
          { id: "author-prompt-one", path: "templates/shared.md" },
          { id: "author-prompt-two", path: "templates/shared.md" },
        ],
        commands: [{ name: "author-command", path: "templates/shared.md" }],
        themes: [
          { name: "author-declared-theme-one", path: "themes/one.json" },
          { name: "author-declared-theme-two", path: "themes/two.json" },
        ],
      },
    })),
  ]);

  const expected = { skillRoots: 1, prompts: 2, commands: 1, themes: 2, runtime: 1 };
  assert.deepEqual((await validateExtensionPackage(root)).package.contributions, expected);
  assert.deepEqual((await inspectExtensionPackage(root)).validation.package.contributions, expected);
});

test("extension author tooling ignores an arbitrary npm entry point and a broken PATH shim", async (t) => {
  const { root } = await fixture(t);
  const bin = join(root, "bin");
  const fakeNpm = join(root, "fake-npm");
  const driver = join(fakeNpm, "bin", "npm-cli.js");
  const shim = join(bin, process.platform === "win32" ? "npm.cmd" : "npm");
  await mkdir(bin);
  await mkdir(join(fakeNpm, "bin"), { recursive: true });
  await writeFile(join(fakeNpm, "package.json"), JSON.stringify({
    name: "not-npm",
    bin: { npm: "bin/npm-cli.js" },
  }));
  await writeFile(driver, "process.exit(91);\n");
  await writeFile(shim, process.platform === "win32" ? "@exit /b 91\r\n" : "#!/bin/sh\nexit 91\n");
  if (process.platform !== "win32") await chmod(shim, 0o755);

  const previousPath = process.env.PATH;
  const previousNpmExecPath = process.env.npm_execpath;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  process.env.npm_execpath = driver;
  try {
    const inspected = await inspectExtensionPackage(root);
    assert.equal(inspected.fileSet, "npm-pack");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousNpmExecPath === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previousNpmExecPath;
  }
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

  const pretty = spawnSync(process.execPath, [
    "--import",
    "tsx",
    resolve("src/bin/rigyn.ts"),
    "extensions",
    "author",
    "smoke",
    root,
  ], { cwd: resolve("."), encoding: "utf8", timeout: 10_000 });
  assert.equal(pretty.status, 0, pretty.stderr);
  assert.match(pretty.stdout, /^\{\n  "packageId":/u);
  assert.equal(JSON.parse(pretty.stdout).disposed, true);
  assert.equal(pretty.stderr, "");
});

test("extension author smoke and refresh dispose every author generation", async (t) => {
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
  assert.deepEqual(await refreshExtensionPackage(root), {
    packageId: "author-tool-fixture",
    runtimeEntries: 1,
    toolCount: 1,
    commandCount: 1,
    providerCount: 0,
    disposed: true,
    refreshed: true,
    warnings: [],
  });
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
    "disposed",
    "disposed",
    "disposed",
  ]);
  await assert.rejects(access(join(root, ".rigyn")), /ENOENT/u);
});

test("extension author pack emits one reviewed artifact and report aggregates every check", async (t) => {
  const { root } = await fixture(t);
  const destination = join(root, "artifacts");
  const packed = await packExtensionPackage(root, destination);
  assert.match(packed.artifact, /author-tool-fixture-1\.2\.3\.tgz$/u);
  assert.match(packed.sha256, /^[a-f0-9]{64}$/u);
  await access(packed.artifact);
  assert.deepEqual(packed.packed.files.map((entry) => entry.path), ["extensions/index.mjs", "package.json"]);
  const originalArtifact = await readFile(packed.artifact);
  await assert.rejects(packExtensionPackage(root, destination), /already exists/u);
  assert.deepEqual(await readFile(packed.artifact), originalArtifact);
  assert.deepEqual(await readdir(destination), ["author-tool-fixture-1.2.3.tgz"]);

  const report = await reportExtensionPackage(root);
  assert.equal(report.status, "success", JSON.stringify(report));
  assert.deepEqual(report.checks.map((entry) => [entry.name, entry.status]), [
    ["validate", "success"],
    ["inspect", "success"],
    ["smoke", "success"],
    ["refresh", "success"],
  ]);
});

test("extension author pack refuses a pre-existing artifact symlink without overwriting its target", async (t) => {
  const { root } = await fixture(t);
  const destination = join(root, "artifacts");
  const victim = join(root, "victim.txt");
  const artifact = join(destination, "author-tool-fixture-1.2.3.tgz");
  await mkdir(destination);
  await writeFile(victim, "unchanged", { flag: "wx" });
  try {
    await symlink(victim, artifact, "file");
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("file symlinks are not available on this Windows runner");
      return;
    }
    throw error;
  }

  await assert.rejects(packExtensionPackage(root, destination), /already exists/u);
  assert.equal(await readFile(victim, "utf8"), "unchanged");
  assert.deepEqual(await readdir(destination), ["author-tool-fixture-1.2.3.tgz"]);
});

test("an authored archive installs, refreshes, removes, and retains workspace config", async (t) => {
  const { root } = await fixture(t);
  const packed = await packExtensionPackage(root, join(root, "artifacts"));
  const agentDir = join(root, "agent");
  const dataRoot = join(root, "extension-data");
  const settings = SettingsManager.inMemory();
  const manager = new DefaultPackageManager({ cwd: root, agentDir, settingsManager: settings });
  const source = `npm:${pathToFileURL(packed.artifact).href}`;
  await manager.installAndPersist(source);
  const installedPath = manager.getInstalledPath(source, "user");
  assert.ok(installedPath);
  await assert.rejects(access(join(installedPath, "node_modules", "rigyn")), /ENOENT/u);

  let configPath: string | undefined;
  const activate = async (args: "write-config" | "read-config"): Promise<string | undefined> => {
    const resolved = await manager.resolve();
    const selected = resolved.extensions.filter((entry) => entry.enabled);
    const metadata = new Map(selected.map((entry) => [entry.path, {
      scope: entry.metadata.scope,
      trusted: true,
      ...(entry.metadata.baseDir === undefined ? {} : { resourceRoot: entry.metadata.baseDir }),
    }] as const));
    const host = await loadDirectExtensions(selected.map((entry) => entry.path), {
      workspace: root,
      dataRoot,
      activationFailure: "throw",
      directPathMetadata: metadata,
    });
    try {
      assert.deepEqual(host.commands().map((command) => command.name), ["author-probe"]);
      const paths = host.extensionDataPaths(selected[0]!.path);
      assert.ok(paths);
      const selectedConfigPath = join(paths.workspace, "config.json");
      if (configPath === undefined) configPath = selectedConfigPath;
      else assert.equal(selectedConfigPath, configPath);
      host.setDirectActionsHandler({} as never);
      return (await host.runCommand("author-probe", {
        args,
        threadId: "author-install-test",
        signal: new AbortController().signal,
      })).prompt;
    } finally {
      await host.close();
    }
  };
  assert.equal(await activate("write-config"), "written");
  assert.equal(await activate("read-config"), JSON.stringify({ retained: true }));
  assert.equal(await manager.removeAndPersist(source), true);
  assert.deepEqual(manager.listConfiguredPackages(), []);
  await assert.rejects(access(installedPath), /ENOENT/u);
  assert.ok(configPath);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { retained: true });
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

  const cliReport = spawnSync(process.execPath, [
    "--import",
    "tsx",
    resolve("src/bin/rigyn.ts"),
    "extensions",
    "author",
    "report",
    root,
    "--json",
  ], { cwd: resolve("."), encoding: "utf8", timeout: 10_000 });
  assert.equal(cliReport.status, 1, cliReport.stderr);
  assert.equal(cliReport.stderr, "");
  assert.equal(cliReport.stdout.trim().includes("\n"), false);
  assert.equal(JSON.parse(cliReport.stdout).status, "error");

  const cliValidate = spawnSync(process.execPath, [
    "--import",
    "tsx",
    resolve("src/bin/rigyn.ts"),
    "extensions",
    "author",
    "validate",
    root,
    "--json",
  ], { cwd: resolve("."), encoding: "utf8", timeout: 10_000 });
  assert.equal(cliValidate.status, 1);
  assert.equal(cliValidate.stdout, "");
  assert.match(cliValidate.stderr, /^rigyn:/u);
});
