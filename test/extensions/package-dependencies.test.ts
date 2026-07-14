import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";

import {
  discoverExtensions,
  loadRuntimeExtensions,
  LocalExtensionPackageManager,
} from "../../src/extensions/index.js";
import { packageCommandArgv, packageProcessTerminationPlan } from "../../src/extensions/packages.js";

async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-package-dependencies-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return root;
}

async function waitForStartedProcess(path: string, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const pid = Number(await readFile(path, "utf8"));
      assert.ok(Number.isSafeInteger(pid) && pid > 0, "started process PID must be a positive safe integer");
      return pid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Process ${pid} did not exit`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

interface PackageFixture {
  id?: string;
  version: string;
  dependency: string;
  spec: string;
}

async function writePackageFixture(root: string, fixture: PackageFixture): Promise<{ manifest: string; packageJson: string }> {
  await mkdir(join(root, "runtime"), { recursive: true });
  const packageId = fixture.id ?? "dependency-reference";
  const manifest = `${JSON.stringify({
    schemaVersion: 1,
    id: packageId,
    name: "Dependency reference",
    version: fixture.version,
    contributions: { runtime: [{ path: "runtime/index.mjs" }] },
  }, null, 2)}\n`;
  const packageJson = `${JSON.stringify({
    name: `rigyn-${packageId}`,
    version: fixture.version,
    type: "module",
    scripts: {
      preinstall: "should-not-run",
      install: "should-not-run",
      postinstall: "should-not-run",
    },
    dependencies: { [fixture.dependency]: fixture.spec },
  }, null, 4)}\n`;
  await writeFile(join(root, "extension.json"), manifest);
  await writeFile(join(root, "package.json"), packageJson);
  await writeFile(join(root, "runtime", "index.mjs"), [
    `import { value } from ${JSON.stringify(fixture.dependency)};`,
    "export { value };",
    "export default () => { globalThis.__packageDependencyActivation = value; };",
    "",
  ].join("\n"));
  return { manifest, packageJson };
}

async function writeFakeNpm(root: string): Promise<string> {
  const script = join(root, "fake-npm.mjs");
  await writeFile(script, `
import { access, appendFile, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
const [capturePath, markerPath, ...args] = process.argv.slice(2);
const waitForPath = async (target) => {
  for (;;) {
    try { await access(target); return; } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const gatedSurvivor = ${JSON.stringify("const fs = process.getBuiltinModule('node:fs'); fs.writeFileSync(process.argv[1], String(process.pid)); const timer = setInterval(() => { if (!fs.existsSync(process.argv[2])) return; clearInterval(timer); fs.writeFileSync(process.argv[3], 'survived'); }, 10)")};
const manifest = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(join(process.cwd(), "package.json"), "utf8")));
await appendFile(capturePath, JSON.stringify({
  args,
  cwd: process.cwd(),
  environment: {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    npm_config_ignore_scripts: process.env.npm_config_ignore_scripts,
    npm_config_omit: process.env.npm_config_omit,
    npm_config_audit: process.env.npm_config_audit,
    npm_config_fund: process.env.npm_config_fund,
    npm_config_package_lock: process.env.npm_config_package_lock,
    npm_config_bin_links: process.env.npm_config_bin_links,
    npm_config_userconfig: process.env.npm_config_userconfig,
    npm_config_globalconfig: process.env.npm_config_globalconfig,
    npm_config_cache: process.env.npm_config_cache,
    NPM_TOKEN: process.env.NPM_TOKEN,
    NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN,
  },
}) + "\\n");
const secure = args.includes("--ignore-scripts=true") && args.includes("--omit=dev") &&
  args.includes("--no-audit") && args.includes("--no-fund") && args.includes("--package-lock=false") &&
  args.includes("--bin-links=false") && process.env.npm_config_ignore_scripts === "true";
const lifecycleEnabled = args.includes("--ignore-scripts=false") && args.includes("--bin-links=true") &&
  process.env.npm_config_ignore_scripts === "false" && process.env.npm_config_bin_links === "true";
if (!secure) await writeFile(markerPath, "lifecycle-ran");
const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
if (lifecycleEnabled) {
  await mkdir(join(process.cwd(), "node_modules", ".bin"), { recursive: true });
  await writeFile(join(process.cwd(), "node_modules", ".bin", "fixture-bin"), "staging only");
}
for (const [name, spec] of Object.entries(dependencies)) {
  if (name === "fake-fail") {
    process.stderr.write("requested dependency failure");
    process.exit(17);
  }
  if (name === "lifecycle-fail" && lifecycleEnabled) {
    process.stderr.write("requested lifecycle failure");
    process.exit(19);
  }
  if (name === "slow-dependency") await new Promise((resolve) => setTimeout(resolve, 2_000));
  if (name === "noisy-dependency") process.stdout.write("x".repeat(4096));
  if (name === "noisy-tree-dependency") {
    const startedPath = markerPath + ".noisy-tree-started";
    const releasePath = markerPath + ".noisy-tree-release";
    process.getBuiltinModule("node:child_process").spawn(process.execPath, ["-e", gatedSurvivor, startedPath, releasePath, markerPath], { stdio: "ignore" });
    await waitForPath(startedPath);
    process.stdout.write("x".repeat(4096));
    await new Promise(() => {});
  }
  if (name === "tree-dependency") {
    const startedPath = markerPath + ".tree-started";
    const releasePath = markerPath + ".tree-release";
    process.getBuiltinModule("node:child_process").spawn(process.execPath, ["-e", gatedSurvivor, startedPath, releasePath, markerPath], { stdio: "ignore" });
    await waitForPath(startedPath);
    await new Promise(() => {});
  }
  if (name === "manifest-mutator") {
    await writeFile(join(process.cwd(), "..", "..", ".work", "package", "extension.json"), "{}\\n");
  }
  const destination = join(process.cwd(), "node_modules", name);
  await mkdir(join(process.cwd(), "node_modules"), { recursive: true });
  if (name === "symlink-dependency") {
    const outside = join(process.cwd(), "outside-dependency");
    await mkdir(outside);
    await symlink(outside, destination, "dir");
    continue;
  }
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, "package.json"), JSON.stringify({ name, type: "module", exports: "./index.mjs" }));
  if (name === "large-dependency") {
    await writeFile(join(destination, "index.mjs"), "x".repeat(2048));
  } else {
    await writeFile(join(destination, "index.mjs"), "export const value = " + JSON.stringify(name + "@" + spec) + ";\\n");
  }
}
`);
  return script;
}

function fakeManager(
  root: string,
  fakeNpm: string,
  capture: string,
  marker: string,
  limits: { maxFileBytes?: number; sourceTimeoutMs?: number; maxCommandOutputBytes?: number } = {},
): LocalExtensionPackageManager {
  return new LocalExtensionPackageManager(
    { user: join(root, "installed") },
    limits,
    { npm: { command: process.execPath, prefix: [fakeNpm, capture, marker] } },
  );
}

test("production dependencies install with a sanitized npm invocation and resolve from the activated runtime", async (t) => {
  const root = await temporary(t);
  const source = join(root, "source");
  const capture = join(root, "npm-calls.jsonl");
  const marker = join(root, "lifecycle-ran");
  await mkdir(source);
  const original = await writePackageFixture(source, {
    version: "1.0.0",
    dependency: "fixture-dependency",
    spec: "^1.2.3",
  });
  const fakeNpm = await writeFakeNpm(root);
  const previousNpmToken = process.env.NPM_TOKEN;
  const previousNodeToken = process.env.NODE_AUTH_TOKEN;
  process.env.NPM_TOKEN = "not-forwarded";
  process.env.NODE_AUTH_TOKEN = "not-forwarded";
  const manager = fakeManager(root, fakeNpm, capture, marker);
  let installed;
  try {
    installed = await manager.install(source);
  } finally {
    if (previousNpmToken === undefined) delete process.env.NPM_TOKEN;
    else process.env.NPM_TOKEN = previousNpmToken;
    if (previousNodeToken === undefined) delete process.env.NODE_AUTH_TOKEN;
    else process.env.NODE_AUTH_TOKEN = previousNodeToken;
  }

  assert.equal(await readFile(join(installed.packageRoot, "extension.json"), "utf8"), original.manifest);
  assert.equal(await readFile(join(installed.packageRoot, "package.json"), "utf8"), original.packageJson);
  const catalog = await discoverExtensions(manager.sources(true));
  assert.deepEqual(catalog.doctor().diagnostics, []);
  const entries = catalog.bundle().runtime;
  assert.equal(entries.length, 1);
  const host = await loadRuntimeExtensions(entries, { workspace: root });
  assert.equal((globalThis as Record<string, unknown>).__packageDependencyActivation, "fixture-dependency@^1.2.3");
  assert.deepEqual(host.diagnostics(), []);
  await host.close();
  delete (globalThis as Record<string, unknown>).__packageDependencyActivation;
  await assert.rejects(access(marker), /ENOENT/u);

  const calls = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
    args: string[];
    cwd: string;
    environment: Record<string, string | undefined>;
  });
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.deepEqual(call.args, [
    "install",
    "--ignore-scripts=true",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    "--bin-links=false",
    "--no-save",
  ]);
  assert.ok(call.cwd.startsWith(join(root, "installed")));
  assert.notEqual(call.environment.HOME, process.env.HOME);
  assert.equal(call.environment.USERPROFILE, call.environment.HOME);
  assert.equal(call.environment.npm_config_ignore_scripts, "true");
  assert.equal(call.environment.npm_config_omit, "dev");
  assert.equal(call.environment.npm_config_audit, "false");
  assert.equal(call.environment.npm_config_fund, "false");
  assert.equal(call.environment.npm_config_package_lock, "false");
  assert.equal(call.environment.npm_config_bin_links, "false");
  assert.equal(call.environment.npm_config_userconfig, join(call.environment.HOME!, "npmrc"));
  assert.equal(call.environment.npm_config_globalconfig, join(call.environment.HOME!, "npmrc-global"));
  assert.equal(call.environment.npm_config_cache, join(call.environment.HOME!, "npm-cache"));
  assert.equal(call.environment.NPM_TOKEN, undefined);
  assert.equal(call.environment.NODE_AUTH_TOKEN, undefined);
  assert.deepEqual((await readdir(join(root, "installed"))).filter((name) => name.startsWith(".rigyn-package-")), []);
});

test("reviewed dependency lifecycle scripts require a per-install opt-in and keep bin links in staging", async (t) => {
  const root = await temporary(t);
  const source = join(root, "source");
  const capture = join(root, "npm-calls.jsonl");
  const marker = join(root, "lifecycle-ran");
  await mkdir(source);
  await writePackageFixture(source, {
    version: "1.0.0",
    dependency: "fixture-dependency",
    spec: "1.0.0",
  });
  const fakeNpm = await writeFakeNpm(root);
  const previousNpmToken = process.env.NPM_TOKEN;
  process.env.NPM_TOKEN = "not-forwarded-to-lifecycle";
  let installed;
  try {
    installed = await fakeManager(root, fakeNpm, capture, marker).install(source, "user", { allowScripts: true });
  } finally {
    if (previousNpmToken === undefined) delete process.env.NPM_TOKEN;
    else process.env.NPM_TOKEN = previousNpmToken;
  }

  assert.equal(await readFile(marker, "utf8"), "lifecycle-ran");
  await assert.rejects(access(join(installed.packageRoot, "node_modules", ".bin")), /ENOENT/u);
  const call = JSON.parse((await readFile(capture, "utf8")).trim()) as {
    args: string[];
    cwd: string;
    environment: Record<string, string | undefined>;
  };
  assert.deepEqual(call.args, [
    "install",
    "--ignore-scripts=false",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    "--bin-links=true",
    "--no-save",
  ]);
  assert.match(call.cwd, /\.rigyn-package-stage-/u);
  assert.equal(call.environment.npm_config_ignore_scripts, "false");
  assert.equal(call.environment.npm_config_bin_links, "true");
  assert.equal(call.environment.NPM_TOKEN, undefined);
});

test("dependency lifecycle opt-in applies independently to updates", async (t) => {
  const root = await temporary(t);
  const source = join(root, "source");
  const capture = join(root, "npm-calls.jsonl");
  const marker = join(root, "lifecycle-ran");
  await mkdir(source);
  await writePackageFixture(source, {
    version: "1.0.0",
    dependency: "fixture-dependency",
    spec: "1.0.0",
  });
  const fakeNpm = await writeFakeNpm(root);
  const manager = fakeManager(root, fakeNpm, capture, marker);
  await manager.install(source);
  await assert.rejects(access(marker), /ENOENT/u);

  await writePackageFixture(source, {
    version: "2.0.0",
    dependency: "fixture-dependency",
    spec: "2.0.0",
  });
  const updated = await manager.update("dependency-reference", "user", undefined, { allowScripts: true });
  assert.equal(updated.version, "2.0.0");
  assert.equal(await readFile(marker, "utf8"), "lifecycle-ran");
  const calls = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { args: string[] });
  assert.equal(calls[0]?.args.includes("--ignore-scripts=true"), true);
  assert.equal(calls[1]?.args.includes("--ignore-scripts=false"), true);
});

test("a failing opted-in dependency lifecycle leaves the previous package active", async (t) => {
  const root = await temporary(t);
  const source = join(root, "source");
  const capture = join(root, "npm-calls.jsonl");
  const marker = join(root, "lifecycle-ran");
  await mkdir(source);
  const first = await writePackageFixture(source, {
    version: "1.0.0",
    dependency: "fixture-dependency",
    spec: "1.0.0",
  });
  const fakeNpm = await writeFakeNpm(root);
  const manager = fakeManager(root, fakeNpm, capture, marker);
  await manager.install(source);

  await writePackageFixture(source, {
    version: "2.0.0",
    dependency: "lifecycle-fail",
    spec: "2.0.0",
  });
  await assert.rejects(
    manager.update("dependency-reference", "user", undefined, { allowScripts: true }),
    /failed with exit 19.*requested lifecycle failure/u,
  );
  const current = (await manager.list())[0]!;
  assert.equal(current.version, "1.0.0");
  assert.equal(await readFile(join(current.packageRoot, "package.json"), "utf8"), first.packageJson);
  assert.deepEqual((await readdir(join(root, "installed"))).filter((name) => name.startsWith(".rigyn-package-")), []);
});

test("non-registry dependency sources are rejected before npm starts", async (t) => {
  const root = await temporary(t);
  const fakeNpm = await writeFakeNpm(root);
  const capture = join(root, "npm-calls.jsonl");
  const marker = join(root, "lifecycle-ran");
  const specifications = [
    "file:../dependency",
    "git+https://example.invalid/dependency.git",
    "https://example.invalid/dependency.tgz",
    "workspace:*",
    "npm:other-package@1.0.0",
  ];
  for (const [index, spec] of specifications.entries()) {
    const source = join(root, `source-${index}`);
    await mkdir(source);
    await writePackageFixture(source, {
      id: `unsafe-${index}`,
      version: "1.0.0",
      dependency: "fixture-dependency",
      spec,
    });
    await assert.rejects(fakeManager(root, fakeNpm, capture, marker).install(source), /registry version, tag, or range/u);
  }
  await assert.rejects(access(capture), /ENOENT/u);
  await assert.rejects(access(marker), /ENOENT/u);
});

test("dependency symlinks and oversized files fail safe-tree validation", { skip: process.platform === "win32" }, async (t) => {
  const root = await temporary(t);
  const fakeNpm = await writeFakeNpm(root);
  const capture = join(root, "npm-calls.jsonl");
  const marker = join(root, "lifecycle-ran");
  const symlinkSource = join(root, "symlink-source");
  await mkdir(symlinkSource);
  await writePackageFixture(symlinkSource, {
    id: "symlink-package",
    version: "1.0.0",
    dependency: "symlink-dependency",
    spec: "1.0.0",
  });
  const manager = fakeManager(root, fakeNpm, capture, marker);
  await assert.rejects(manager.install(symlinkSource), /symbolic link/u);
  assert.deepEqual(await manager.list(), []);

  const largeSource = join(root, "large-source");
  await mkdir(largeSource);
  await writePackageFixture(largeSource, {
    id: "large-package",
    version: "1.0.0",
    dependency: "large-dependency",
    spec: "1.0.0",
  });
  const bounded = fakeManager(root, fakeNpm, capture, marker, { maxFileBytes: 1024 });
  await assert.rejects(bounded.install(largeSource), /exceeds 1024 bytes/u);
  assert.deepEqual(await bounded.list(), []);
});

test("dependency commands are bounded and cannot alter the package manifest", async (t) => {
  const root = await temporary(t);
  const fakeNpm = await writeFakeNpm(root);
  const capture = join(root, "npm-calls.jsonl");
  const marker = join(root, "lifecycle-ran");

  const slowSource = join(root, "slow-source");
  await mkdir(slowSource);
  await writePackageFixture(slowSource, {
    id: "slow-package",
    version: "1.0.0",
    dependency: "slow-dependency",
    spec: "1.0.0",
  });
  const timed = fakeManager(root, fakeNpm, capture, marker, { sourceTimeoutMs: 50 });
  await assert.rejects(timed.install(slowSource), /timed out after 50ms/u);

  const treeSource = join(root, "tree-source");
  await mkdir(treeSource);
  await writePackageFixture(treeSource, {
    id: "tree-package",
    version: "1.0.0",
    dependency: "tree-dependency",
    spec: "1.0.0",
  });
  const treeManager = fakeManager(root, fakeNpm, capture, marker);
  const controller = new AbortController();
  const treeInstall = treeManager.install(treeSource, "user", { signal: controller.signal });
  const treePid = await waitForStartedProcess(`${marker}.tree-started`);
  controller.abort(new Error("cancel dependency process tree"));
  await assert.rejects(treeInstall, /cancel dependency process tree/u);
  await writeFile(`${marker}.tree-release`, "release");
  await waitForProcessExit(treePid);
  await assert.rejects(access(marker), /ENOENT/u);

  const noisySource = join(root, "noisy-source");
  await mkdir(noisySource);
  await writePackageFixture(noisySource, {
    id: "noisy-package",
    version: "1.0.0",
    dependency: "noisy-dependency",
    spec: "1.0.0",
  });
  const bounded = fakeManager(root, fakeNpm, capture, marker, { maxCommandOutputBytes: 128 });
  await assert.rejects(bounded.install(noisySource), /output exceeded 128 bytes/u);

  const noisyTreeSource = join(root, "noisy-tree-source");
  await mkdir(noisyTreeSource);
  await writePackageFixture(noisyTreeSource, {
    id: "noisy-tree-package",
    version: "1.0.0",
    dependency: "noisy-tree-dependency",
    spec: "1.0.0",
  });
  await assert.rejects(bounded.install(noisyTreeSource), /output exceeded 128 bytes/u);
  const noisyTreePid = await waitForStartedProcess(`${marker}.noisy-tree-started`);
  await writeFile(`${marker}.noisy-tree-release`, "release");
  await waitForProcessExit(noisyTreePid);
  await assert.rejects(access(marker), /ENOENT/u);

  const mutationSource = join(root, "mutation-source");
  await mkdir(mutationSource);
  await writePackageFixture(mutationSource, {
    id: "mutation-package",
    version: "1.0.0",
    dependency: "manifest-mutator",
    spec: "1.0.0",
  });
  await assert.rejects(fakeManager(root, fakeNpm, capture, marker).install(mutationSource), /manifest changed/u);
  assert.deepEqual(await timed.list(), []);
});

test("package command termination plans target process groups and Windows trees without a shell", () => {
  assert.deepEqual(packageProcessTerminationPlan(1234, "SIGTERM", "linux", {}), {
    kind: "signal",
    pid: -1234,
    signal: "SIGTERM",
  });
  assert.deepEqual(packageProcessTerminationPlan(1234, "SIGKILL", "win32", { SystemRoot: "C:\\Windows" }), {
    kind: "taskkill",
    command: "C:\\Windows\\System32\\taskkill.exe",
    args: ["/PID", "1234", "/T", "/F"],
    fallback: { kind: "signal", pid: 1234, signal: "SIGKILL" },
  });
  assert.deepEqual(packageProcessTerminationPlan(1234, "SIGTERM", "win32", { WINDIR: "D:\\Windows" }), {
    kind: "taskkill",
    command: "D:\\Windows\\System32\\taskkill.exe",
    args: ["/PID", "1234", "/T", "/F"],
    fallback: { kind: "signal", pid: 1234, signal: "SIGTERM" },
  });
  assert.deepEqual(packageProcessTerminationPlan(1234, "SIGKILL", "win32", {}), {
    kind: "signal",
    pid: 1234,
    signal: "SIGKILL",
  });
});

test("configured Windows package commands reject batch wrappers and metacharacter injection", () => {
  for (const command of [String.raw`C:\Program Files\nodejs\npm.CMD`, String.raw`C:\Tools\git.BAT`]) {
    assert.throws(
      () => packageCommandArgv(command, ["literal&whoami"], "win32", {}),
      /batch command wrappers are unsupported/u,
    );
  }
});

test("configured package commands remain direct argv outside Windows", () => {
  assert.deepEqual(packageCommandArgv(
    "/opt/tools/npm.cmd",
    ["install", "--ignore-scripts=true"],
    "linux",
    { ComSpec: "/should/not/run" },
  ), ["/opt/tools/npm.cmd", "install", "--ignore-scripts=true"]);
});

test("a failed dependency update leaves the installed version active", async (t) => {
  const root = await temporary(t);
  const source = join(root, "source");
  const capture = join(root, "npm-calls.jsonl");
  const marker = join(root, "lifecycle-ran");
  await mkdir(source);
  const first = await writePackageFixture(source, {
    version: "1.0.0",
    dependency: "fixture-dependency",
    spec: "1.0.0",
  });
  const fakeNpm = await writeFakeNpm(root);
  const manager = fakeManager(root, fakeNpm, capture, marker);
  const installed = await manager.install(source);
  assert.equal(installed.version, "1.0.0");

  await writePackageFixture(source, {
    version: "2.0.0",
    dependency: "fake-fail",
    spec: "2.0.0",
  });
  await assert.rejects(manager.update("dependency-reference"), /failed with exit 17/u);
  const current = (await manager.list())[0]!;
  assert.equal(current.version, "1.0.0");
  assert.equal(await readFile(join(current.packageRoot, "package.json"), "utf8"), first.packageJson);
  const runtime = await import(`${pathToFileURL(join(current.packageRoot, "runtime", "index.mjs")).href}?rollback-test=1`);
  assert.equal(runtime.value, "fixture-dependency@1.0.0");
});

test("an interrupted same-root backup is recovered before the next operation", async (t) => {
  const root = await temporary(t);
  const source = join(root, "source");
  const installedRoot = join(root, "installed");
  await mkdir(source);
  await writePackageFixture(source, {
    version: "1.0.0",
    dependency: "fixture-dependency",
    spec: "1.0.0",
  });
  const fakeNpm = await writeFakeNpm(root);
  const manager = fakeManager(root, fakeNpm, join(root, "npm-calls.jsonl"), join(root, "lifecycle-ran"));
  const installed = await manager.install(source);
  const backupContainer = join(installedRoot, ".rigyn-package-backup-interrupted");
  await mkdir(backupContainer);
  await writeFile(join(backupContainer, "transaction.json"), `${JSON.stringify({ schemaVersion: 1, id: installed.id })}\n`);
  await rename(installed.packageRoot, join(backupContainer, installed.id));

  const listed = await manager.list();
  assert.equal(listed[0]?.version, "1.0.0");
  await assert.rejects(access(backupContainer), /ENOENT/u);

  const partialContainer = join(installedRoot, ".rigyn-package-backup-partial");
  await mkdir(partialContainer);
  await writeFile(join(partialContainer, "transaction.json"), "{");
  assert.equal((await manager.list())[0]?.version, "1.0.0");
  await assert.rejects(access(partialContainer), /ENOENT/u);

  const inferredContainer = join(installedRoot, ".rigyn-package-backup-inferred");
  await mkdir(inferredContainer);
  await writeFile(join(inferredContainer, "transaction.json"), "{");
  await rename(listed[0]!.packageRoot, join(inferredContainer, installed.id));
  assert.equal((await manager.list())[0]?.version, "1.0.0");
  await assert.rejects(access(inferredContainer), /ENOENT/u);
});
