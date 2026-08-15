import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  assertRootLockIdentity,
  assertWorkspaceLockIdentity,
  checkReleaseMetadata,
  extractReleaseNotes,
} from "../../../../scripts/check-release-metadata.mjs";
import { runBoundedCommand } from "../../../../scripts/bounded-command.mjs";
import {
  assertOwnedLaunchers,
  createInstallationMarker,
  createUninstallRecord,
  lifecycleProcessTreeTerminationPlan,
  inside,
  managedToolOutputDirectory,
  managedCommand,
  parseInstallationMarker,
  prepareManagedCredentialPurge,
  purgeManagedToolOutput,
  posixLauncher,
  recoverInterruptedUninstall,
  RIGYN_PACKAGE_GRAPH,
  RIGYN_PRODUCT_PACKAGE_GRAPH,
  removeOwnedPosixCommand,
  resolveNpmInvocation,
  sameLifecyclePath,
  terminateLifecycleProcessTree,
  withCredentialPurgeDisposal,
  windowsLauncher,
} from "../../scripts/lifecycle-common.mjs";
import {
  ensureAgentScaffold,
  sourceBuildSteps,
} from "../../scripts/install-user.mjs";
import { uninstallPosix, uninstallWindows } from "../../scripts/uninstall-standalone.mjs";
import { commitSourceUninstall, removeCommandAfterIsolation } from "../../scripts/uninstall-user.mjs";
import {
  assertUpdateVersionPolicy,
  downloadLatestGitHubReleaseBundle,
  validateGitHubReleaseManifest,
} from "../../scripts/update-user.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const FIXTURE_VERSION = "9.8.7";

function standaloneRuntimeLease(installRoot, pid, lease = "a".repeat(32)) {
  const canonicalRoot = resolve(installRoot);
  const identity = process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot;
  const installationId = createHash("sha256")
    .update("rigyn-standalone-installation-v1\0")
    .update(identity)
    .digest("hex")
    .slice(0, 32);
  return `${JSON.stringify({
    schemaVersion: 1,
    pid,
    lease,
    createdAt: Date.now(),
    installationId,
  })}\n`;
}

function githubReleaseFixture(version = FIXTURE_VERSION) {
  const files = new Map(RIGYN_PRODUCT_PACKAGE_GRAPH.map(({ name }) => {
    const file = `${name === "rigyn" ? "rigyn" : name.replace("@rigyn/", "rigyn-")}-${version}.tgz`;
    return [file, Buffer.from(`${name} ${version} release archive\n`)];
  }));
  const archives = RIGYN_PRODUCT_PACKAGE_GRAPH.map(({ name }) => {
    const file = `${name === "rigyn" ? "rigyn" : name.replace("@rigyn/", "rigyn-")}-${version}.tgz`;
    const contents = files.get(file);
    return {
      name,
      version,
      file,
      sha256: createHash("sha256").update(contents).digest("hex"),
      integrity: `sha512-${createHash("sha512").update(contents).digest("base64")}`,
      bytes: contents.byteLength,
    };
  });
  const sbomFile = `rigyn-v${version}.spdx.json`;
  const sbomContents = Buffer.from(`${JSON.stringify({
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    name: `rigyn-workspace@${version}`,
    packages: [{ name: "rigyn-workspace", versionInfo: version }],
    relationships: [{ relationshipType: "DESCRIBES" }],
  })}\n`);
  files.set(sbomFile, sbomContents);
  const manifest = {
    schemaVersion: 4,
    product: "rigyn",
    version,
    tag: `v${version}`,
    packaging: "github-release",
    node: ">=26.7.0",
    nodeRuntime: "26.7.0",
    archive: { ...archives.at(-1) },
    archives,
    source: {},
    standalones: [],
    checksumFile: "SHA256SUMS",
    releaseNotes: "RELEASE_NOTES.md",
    targets: [],
  };
  const release = { tag_name: manifest.tag, draft: false, prerelease: false, assets: [] };
  const refresh = () => {
    files.set("release-manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    release.assets = [...files].map(([name, contents]) => ({ name, size: contents.byteLength }));
  };
  refresh();
  return { archives, files, manifest, refresh, release };
}

function githubReleaseFetch(fixture, calls = []) {
  return async (input, init) => {
    const url = String(input);
    calls.push({ init, url });
    assert.equal(init?.headers?.authorization, undefined);
    assert.equal(init?.headers?.["user-agent"], "rigyn-self-update");
    if (url.endsWith("/releases/latest")) {
      const contents = Buffer.from(JSON.stringify(fixture.release));
      return new Response(contents, { status: 200, headers: { "content-length": String(contents.byteLength) } });
    }
    const name = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
    const contents = fixture.files.get(name);
    if (contents === undefined) return new Response(null, { status: 404 });
    return new Response(contents, { status: 200, headers: { "content-length": String(contents.byteLength) } });
  };
}

function failedFetchResponse(status, options = {}) {
  return {
    body: {
      async cancel() { options.onCancel?.(); },
    },
    headers: new Headers(options.retryAfter === undefined ? {} : { "retry-after": options.retryAfter }),
    ok: false,
    status,
    url: "https://api.github.com/repos/rigyn/rigyn/releases/latest",
  };
}

async function runProcess(command, args, options = {}) {
  const hasInput = options.input !== undefined;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: [hasInput ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
    if (hasInput) {
      child.stdin.once("error", reject);
      child.stdin.end(options.input);
    }
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

async function runPosixBootstrap(root, options = {}) {
  const fixture = githubReleaseFixture();
  const fixtureRoot = join(root, "release-assets");
  const fakeBin = join(root, "fake-bin");
  const temporary = join(root, "temporary files");
  const home = join(root, "home");
  const dataHome = join(root, "data");
  const curlCapture = join(root, "curl.jsonl");
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const archiveRoot = `rigyn-v${fixture.manifest.version}-${platform}-${arch}`;
  const archiveName = `${archiveRoot}.tar.gz`;
  const buildRoot = join(root, "standalone-build");
  const payload = join(buildRoot, archiveRoot);
  const launcherContents = options.brokenLauncher === true
    ? "#!/bin/sh\nexit 19\n"
    : `#!/bin/sh\nprintf '%s\\n' '${fixture.manifest.version}'\n`;
  await Promise.all([
    mkdir(fixtureRoot),
    mkdir(fakeBin),
    mkdir(temporary),
    mkdir(home),
    mkdir(dataHome),
    mkdir(join(payload, "bin"), { recursive: true }),
    mkdir(join(payload, "lib/node_modules/rigyn/resources"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(payload, "bin/rigyn"), launcherContents, { mode: 0o755 }),
    writeFile(join(payload, "BUILD-METADATA.json"), `${JSON.stringify({
      schemaVersion: 1,
      product: "rigyn",
      version: fixture.manifest.version,
      platform,
      arch,
    })}\n`),
    writeFile(join(payload, "lib/node_modules/rigyn/resources/AGENTS.md"), ""),
    writeFile(join(payload, "lib/node_modules/rigyn/resources/config.example.json"), "{}\n"),
    writeFile(join(fakeBin, "curl"), `#!/usr/bin/env node
const { appendFile, copyFile } = require("node:fs/promises");
const { basename } = require("node:path");
(async () => {
  const args = process.argv.slice(2);
  const url = args.at(-1);
  await appendFile(process.env.RIGYN_TEST_CURL_CAPTURE, JSON.stringify({ args, url }) + "\\n");
  if (url.endsWith("/latest")) {
    process.stdout.write("https://github.com/rigyn/rigyn/releases/tag/${fixture.manifest.tag}");
  } else {
    const outputIndex = args.indexOf("--output");
    await copyFile(process.env.RIGYN_TEST_FIXTURE + "/" + basename(new URL(url).pathname), args[outputIndex + 1]);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
`, { mode: 0o755 }),
  ]);
  if (options.archiveLink === true) {
    await symlink("bin/rigyn", join(payload, "linked-launcher"));
  }
  const archived = await runProcess("tar", ["-czf", join(fixtureRoot, archiveName), "-C", buildRoot, archiveRoot]);
  assert.equal(archived.code, 0, archived.stderr);
  const archiveContents = await readFile(join(fixtureRoot, archiveName));
  await writeFile(
    join(fixtureRoot, "SHA256SUMS"),
    `${createHash("sha256").update(archiveContents).digest("hex")}  ${archiveName}\n`,
  );
  if (options.corrupt === true) {
    await writeFile(join(fixtureRoot, archiveName), Buffer.alloc(archiveContents.byteLength, 1));
  }
  const runtime = join(home, ".rigyn/runtime", archiveRoot);
  const installRoot = join(home, ".rigyn");
  const launcherDirectory = join(home, ".rigyn/bin");
  const launcher = join(launcherDirectory, "rigyn");
  const commandDirectory = join(home, ".local/bin");
  const command = join(commandDirectory, "rigyn");
  const agentDirectory = options.linkedAgentDirectory === true
    ? join(root, "configured-agent")
    : join(home, ".rigyn");
  const externalAgentDirectory = join(root, "external-agent");
  if (options.existingRuntime === true) {
    const existingRuntime = runtime;
    await Promise.all([
      mkdir(join(existingRuntime, "bin"), { recursive: true }),
      mkdir(launcherDirectory, { recursive: true }),
      mkdir(commandDirectory, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(existingRuntime, "bin/rigyn"), "#!/bin/sh\nprintf 'stale runtime\\n'\n", { mode: 0o755 }),
      writeFile(join(existingRuntime, "BUILD-METADATA.json"), "{ corrupt same-version metadata\n"),
      writeFile(join(existingRuntime, "stale-only.txt"), "must be removed\n"),
    ]);
    await symlink(
      options.traversalLauncher === true
        ? `${dirname(runtime)}/${archiveRoot}/../../../../outside/bin/rigyn`
        : join(runtime, "bin/rigyn"),
      launcher,
    );
    if (options.managedCommandLauncher === true) {
      await writeFile(command, managedCommand(launcher), { mode: 0o755 });
    } else if (options.unmanagedMarkerLauncher === true) {
      await writeFile(
        command,
        "#!/usr/bin/env sh\n# rigyn managed command\nexec '/tmp/unmanaged' \"$@\"\n",
        { mode: 0o755 },
      );
    } else {
      await symlink(launcher, command);
    }
  }
  if (options.sourceInstallMarker === true) {
    await mkdir(join(home, ".rigyn"), { recursive: true });
    await writeFile(join(home, ".rigyn/.installation.json"), "{}\n");
  }
  if (options.runtimeLeaseState !== undefined) {
    const leaseDirectory = join(home, ".rigyn/.runtime-leases");
    await mkdir(leaseDirectory, { recursive: true });
    if (options.runtimeLeaseState !== "empty") {
      const pid = options.runtimeLeaseState === "active" ? process.pid : 2_147_483_647;
      await writeFile(
        join(leaseDirectory, `${"a".repeat(32)}.json`),
        standaloneRuntimeLease(join(home, ".rigyn"), pid),
      );
    }
  }
  if (options.linkedAgentDirectory === true) {
    await mkdir(externalAgentDirectory);
    await symlink(externalAgentDirectory, agentDirectory);
  }
  let scaffoldTarget;
  if (options.scaffoldDestination !== undefined) {
    await mkdir(agentDirectory, { recursive: true });
    const scaffoldPath = join(agentDirectory, options.scaffoldDestination.name);
    if (options.scaffoldDestination.kind === "directory") {
      await mkdir(scaffoldPath);
    } else {
      scaffoldTarget = join(root, `scaffold-target-${options.scaffoldDestination.name}`);
      await writeFile(scaffoldTarget, "preserve this target\n");
      await symlink(scaffoldTarget, scaffoldPath);
    }
  }
  const failureMarker = join(root, "injected-failure");
  const restoreFailureMarker = join(root, "injected-restore-failure");
  if (
    ["scaffold", "launcher", "command"].includes(options.failAfterRuntime)
    || ["launcher", "command", "runtime"].includes(options.failRestore)
  ) {
    const failureCommand = options.failAfterRuntime === "scaffold" ? "cp" : "mv";
    await writeFile(join(fakeBin, failureCommand), `#!/usr/bin/env node
const { existsSync, rmSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { basename } = require("node:path");
const args = process.argv.slice(2);
const source = args.at(-2);
const destination = args.at(-1);
const restoreKind = process.env.RIGYN_TEST_FAIL_RESTORE_KIND;
const shouldFailRestore = ${JSON.stringify(failureCommand)} === "mv"
  && destination === process.env.RIGYN_TEST_FAIL_RESTORE_DESTINATION
  && (
    (restoreKind === "runtime" && source.includes("/.rigyn-backup."))
    || (restoreKind !== "runtime" && basename(source) === "previous")
  )
  && !existsSync(process.env.RIGYN_TEST_RESTORE_FAILURE_MARKER);
if (shouldFailRestore) {
  writeFileSync(process.env.RIGYN_TEST_RESTORE_FAILURE_MARKER, "failed\\n");
  process.stderr.write("injected mv restore failure\\n");
  process.exit(74);
}
const shouldFail = destination === process.env.RIGYN_TEST_FAIL_DESTINATION
  && !existsSync(process.env.RIGYN_TEST_FAILURE_MARKER);
if (shouldFail) {
  writeFileSync(process.env.RIGYN_TEST_FAILURE_MARKER, "failed\\n");
  if (${JSON.stringify(failureCommand)} === "cp") {
    writeFileSync(destination, "partial scaffold\\n");
  } else {
    rmSync(destination, { force: true });
  }
  process.stderr.write("injected ${failureCommand} failure\\n");
  process.exit(73);
}
const result = spawnSync(${JSON.stringify(failureCommand)}, args, {
  env: { ...process.env, PATH: process.env.RIGYN_TEST_REAL_PATH },
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  }
  if (options.interruptedRuntimePhase !== undefined) {
    assert.equal(options.existingRuntime, true);
    const runtimeRoot = dirname(runtime);
    const stageName = ".rigyn-stage.seed123";
    const backupName = ".rigyn-backup.seed123";
    const stageParent = join(runtimeRoot, stageName);
    const backupParent = join(runtimeRoot, backupName);
    await Promise.all([
      mkdir(join(stageParent, archiveRoot), { recursive: true }),
      mkdir(backupParent),
    ]);
    await writeFile(join(stageParent, archiveRoot, "interrupted-stage.txt"), "staged\n");
    await rename(runtime, join(backupParent, archiveRoot));
    if (["replacement-installed", "committed"].includes(options.interruptedRuntimePhase)) {
      await mkdir(runtime, { recursive: true });
      await writeFile(join(runtime, "interrupted-replacement.txt"), "uncommitted\n");
    }
    await writeFile(
      join(runtimeRoot, ".rigyn-install-transaction.json"),
      `${JSON.stringify({
        product: "rigyn",
        schemaVersion: 1,
        distribution: "standalone",
        phase: options.interruptedRuntimePhase,
        runtime: archiveRoot,
        stage: stageName,
        backup: backupName,
        hadPrevious: true,
      })}\n`,
    );
  }
  if (options.runtimeTransactionRecord !== undefined) {
    const runtimeRoot = join(installRoot, "runtime");
    const record = join(runtimeRoot, ".rigyn-install-transaction.json");
    await mkdir(runtimeRoot, { recursive: true });
    if (options.runtimeTransactionRecord === "symlink") {
      const outside = join(root, "foreign-runtime-transaction");
      await writeFile(outside, "foreign\n");
      await symlink(outside, record);
    } else {
      await writeFile(record, "{malformed\n");
    }
  }
  if (options.interruptedUninstallPhase !== undefined) {
    assert.equal(options.existingRuntime, true);
    await writeFile(join(runtime, "BUILD-METADATA.json"), `${JSON.stringify({
      schemaVersion: 1,
      product: "rigyn",
      version: fixture.manifest.version,
      platform,
      arch,
    })}\n`);
    const recordPath = `${installRoot}.uninstall.json`;
    const tombstone = `${installRoot}.uninstalling`;
    await writeFile(recordPath, `${JSON.stringify({
      product: "rigyn",
      schemaVersion: 1,
      distribution: "standalone",
      phase: options.interruptedUninstallPhase,
      runtime: archiveRoot,
    })}\n`);
    if (options.interruptedUninstallPhase !== "prepared") await rename(installRoot, tombstone);
    if (options.interruptedUninstallPhase === "command-removed") await rm(command);
  }
  if (options.staleLifecycleLock === true) {
    await writeFile(`${join(home, ".rigyn")}.lifecycle.lock`, `${JSON.stringify({
      schemaVersion: 1,
      pid: 2_147_483_647,
      token: "d".repeat(32),
      createdAt: 0,
      installRoot: join(home, ".rigyn"),
    })}\n`);
  }
  if (options.malformedLifecycleLock === true) {
    await writeFile(`${join(home, ".rigyn")}.lifecycle.lock`, "{\n");
  }
  let lifecycleCompleter;
  let lifecycleCompleterExit;
  let lifecycleCompleterError = "";
  if (options.completingLifecycleLock === true) {
    const completerProgram = `
import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
const [path, installRoot] = process.argv.slice(1);
const prefix = '{"schemaVersion":';
const contents = JSON.stringify({
  schemaVersion: 1,
  pid: process.pid,
  token: "c".repeat(32),
  createdAt: Date.now(),
  installRoot,
}) + "\\n";
const handle = openSync(path, "wx", 0o600);
writeSync(handle, prefix);
fsyncSync(handle);
process.stdout.write("partial\\n");
await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
if (readFileSync(path, "utf8") !== prefix) throw new Error("partial lifecycle lock was replaced");
writeSync(handle, contents.slice(prefix.length));
fsyncSync(handle);
closeSync(handle);
await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_250));
if (readFileSync(path, "utf8") !== contents) throw new Error("active lifecycle lock was replaced");
unlinkSync(path);
`;
    lifecycleCompleter = spawn(process.execPath, [
      "--input-type=module",
      "--eval",
      completerProgram,
      `${join(home, ".rigyn")}.lifecycle.lock`,
      join(home, ".rigyn"),
    ], {
      cwd: PROJECT_ROOT,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let completerOutput = "";
    lifecycleCompleter.stdout.on("data", (chunk) => { completerOutput += chunk.toString("utf8"); });
    lifecycleCompleter.stderr.on("data", (chunk) => { lifecycleCompleterError += chunk.toString("utf8"); });
    lifecycleCompleterExit = new Promise((resolveClose, reject) => {
      lifecycleCompleter.once("close", resolveClose);
      lifecycleCompleter.once("error", reject);
    });
    await new Promise((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error("bootstrap lifecycle lock completer did not start")), 5_000);
      lifecycleCompleter.stdout.on("data", () => {
        if (!completerOutput.includes("partial\n")) return;
        clearTimeout(timeout);
        resolveReady();
      });
      lifecycleCompleter.once("error", reject);
    });
  }
  let lifecycleHolder;
  let lifecycleHolderExit;
  let lifecycleHolderError = "";
  if (Number.isFinite(options.lifecycleLockDelayMs) && options.lifecycleLockDelayMs > 0) {
    const commonUrl = pathToFileURL(join(PROJECT_ROOT, "scripts", "lifecycle-common.mjs")).href;
    const holderProgram = [
      `import { acquireLifecycleLock } from ${JSON.stringify(commonUrl)}`,
      "const [root, delay] = process.argv.slice(1)",
      "const lease = await acquireLifecycleLock(root)",
      "process.stdout.write('locked\\n')",
      "await new Promise((resolveDelay) => setTimeout(resolveDelay, Number(delay)))",
      "await lease.release()",
    ].join(";");
    lifecycleHolder = spawn(process.execPath, [
      "--input-type=module",
      "--eval",
      holderProgram,
      join(home, ".rigyn"),
      String(options.lifecycleLockDelayMs),
    ], {
      cwd: PROJECT_ROOT,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let holderOutput = "";
    lifecycleHolder.stdout.on("data", (chunk) => { holderOutput += chunk.toString("utf8"); });
    lifecycleHolder.stderr.on("data", (chunk) => { lifecycleHolderError += chunk.toString("utf8"); });
    lifecycleHolderExit = new Promise((resolveClose, reject) => {
      lifecycleHolder.once("close", resolveClose);
      lifecycleHolder.once("error", reject);
    });
    await new Promise((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error("bootstrap lifecycle lock holder did not start")), 5_000);
      lifecycleHolder.stdout.on("data", () => {
        if (!holderOutput.includes("locked\n")) return;
        clearTimeout(timeout);
        resolveReady();
      });
      lifecycleHolder.once("error", reject);
    });
  }
  const script = await readFile(join(REPOSITORY_ROOT, "install.sh"), "utf8");
  const startedAt = Date.now();
  const result = await runProcess("sh", [], {
    cwd: root,
    input: script,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      RIGYN_TEST_CURL_CAPTURE: curlCapture,
      RIGYN_TEST_FAILURE_MARKER: failureMarker,
      RIGYN_TEST_RESTORE_FAILURE_MARKER: restoreFailureMarker,
      RIGYN_TEST_FAIL_DESTINATION: options.failAfterRuntime === "scaffold"
        ? join(agentDirectory, "AGENTS.md")
        : options.failAfterRuntime === "launcher" ? launcher : command,
      RIGYN_TEST_FAIL_RESTORE_DESTINATION: options.failRestore === "launcher"
        ? launcher
        : options.failRestore === "command" ? command
          : options.failRestore === "runtime" ? runtime : "",
      RIGYN_TEST_FAIL_RESTORE_KIND: options.failRestore ?? "",
      RIGYN_TEST_FIXTURE: fixtureRoot,
      RIGYN_TEST_REAL_PATH: process.env.PATH,
      TMPDIR: temporary,
      HOME: home,
      XDG_DATA_HOME: dataHome,
      RIGYN_HOME: options.linkedAgentDirectory === true ? agentDirectory : "",
    },
  });
  const elapsedMs = Date.now() - startedAt;
  if (lifecycleHolderExit !== undefined) {
    assert.equal(await lifecycleHolderExit, 0, lifecycleHolderError);
  }
  if (lifecycleCompleterExit !== undefined) {
    assert.equal(await lifecycleCompleterExit, 0, lifecycleCompleterError);
  }
  return {
    agentDirectory,
    archiveName,
    command,
    curlCapture,
    externalAgentDirectory,
    fixture,
    home,
    dataHome,
    launcher,
    launcherContents,
    result,
    runtime,
    scaffoldTarget,
    temporary,
    elapsedMs,
  };
}

async function createWindowsBootstrapAssets(root, name, options = {}) {
  const fixture = githubReleaseFixture();
  const fixtureRoot = join(root, name);
  const buildRoot = join(root, `${name}-build`);
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const archiveRoot = `rigyn-v${fixture.manifest.version}-win32-${arch}`;
  const archiveName = `${archiveRoot}.tar.gz`;
  const payload = join(buildRoot, archiveRoot);
  const launcherContents = options.brokenLauncher === true
    ? "@echo off\r\nexit /b 19\r\n"
    : [
      "@echo off",
      'if "%~1"=="--version" (',
      `  echo ${fixture.manifest.version}`,
      "  exit /b 0",
      ")",
      "exit /b 0",
      "",
    ].join("\r\n");

  await Promise.all([
    mkdir(fixtureRoot),
    mkdir(join(payload, "bin"), { recursive: true }),
    mkdir(join(payload, "lib/node_modules/rigyn/resources"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(payload, "bin/rigyn.cmd"), launcherContents),
    writeFile(join(payload, "BUILD-METADATA.json"), `${JSON.stringify({
      schemaVersion: 1,
      product: "rigyn",
      version: fixture.manifest.version,
      platform: "win32",
      arch,
    })}\n`),
    writeFile(
      join(payload, "fixture.txt"),
      options.brokenLauncher === true
        ? "broken replacement\n"
        : options.fixtureContents ?? "healthy installation\n",
    ),
    writeFile(join(payload, "lib/node_modules/rigyn/resources/AGENTS.md"), ""),
    writeFile(join(payload, "lib/node_modules/rigyn/resources/config.example.json"), "{}\r\n"),
  ]);
  const archivePath = join(fixtureRoot, archiveName);
  const archived = await runProcess("tar.exe", ["-czf", archivePath, "-C", buildRoot, archiveRoot]);
  assert.equal(archived.code, 0, archived.stderr);
  const archiveContents = await readFile(archivePath);
  await writeFile(
    join(fixtureRoot, "SHA256SUMS"),
    `${createHash("sha256").update(archiveContents).digest("hex")}  ${archiveName}\n`,
  );
  return {
    arch,
    archiveName,
    archiveRoot,
    fixture,
    fixtureRoot,
    launcherContents,
  };
}

async function runWindowsBootstrap(root, home, assets, options = {}) {
  const temporary = join(root, `temporary-${basename(home)}`);
  await mkdir(temporary, { recursive: true });
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, "AppData/Local"),
    TMP: temporary,
    TEMP: temporary,
  };
  for (const name of Object.keys(environment)) {
    if (["psmodulepath", "rigyn_home"].includes(name.toLowerCase())) delete environment[name];
  }
  const harness = join(PROJECT_ROOT, "test/release/windows-bootstrap-harness.ps1");
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    harness,
    "-Installer",
    options.installer ?? join(REPOSITORY_ROOT, "install.ps1"),
    "-FixtureRoot",
    assets.fixtureRoot,
    "-TestHome",
    home,
    "-Version",
    assets.fixture.manifest.version,
  ];
  if (options.failLauncherRestore === true) args.push("-FailLauncherRestore");
  return await runProcess("powershell.exe", args, {
    cwd: root,
    env: environment,
  });
}

async function runNode(args, options = {}) {
  const child = spawn(process.execPath, args, {
    cwd: options.cwd ?? PROJECT_ROOT,
    env: options.env ?? process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const result = {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
  if (options.reject === true) assert.notEqual(result.code, 0);
  else assert.equal(result.code, 0, result.stderr);
  return result;
}

test("process runner ignores stdin when no input is provided", {
  skip: process.platform === "win32",
}, async () => {
  const result = await runProcess(process.execPath, [
    "-e",
    "const { fstatSync } = require('node:fs'); process.exit(fstatSync(0).isCharacterDevice() ? 0 : 1);",
  ]);
  assert.equal(result.code, 0, result.stderr);
});

test("source installation builds and verifies only matching native helpers", () => {
  const portable = [
    ["@rigyn/terminal", "build", "rigyn terminal source build"],
    ["@rigyn/models", "build:offline", "rigyn model catalog source build"],
    ["@rigyn/kernel", "build", "rigyn kernel source build"],
    ["rigyn", "build", "rigyn application source build"],
  ];
  assert.deepEqual(sourceBuildSteps("linux"), portable);
  for (const [platform, label] of [["darwin", "macOS"], ["win32", "Windows"]]) {
    const kernelNative = platform === "win32" ? [
      ["@rigyn/kernel", "native:build", "Windows kernel process launcher build"],
      ["@rigyn/kernel", "native:verify", "Windows kernel process launcher verification"],
    ] : [];
    assert.deepEqual(sourceBuildSteps(platform), [
      ["@rigyn/terminal", "build", "rigyn terminal source build"],
      ["@rigyn/terminal", "native:build", `${label} native terminal helper build`],
      ["@rigyn/terminal", "native:verify", `${label} native terminal helper verification`],
      ...kernelNative,
      ...portable.slice(1),
    ]);
  }
});

test("kernel and terminal builds remove stale dist output before compiling", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-clean-build-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const inheritedPath = Object.entries(process.env)
    .find(([name]) => name.toLowerCase() === "path")?.[1];
  const pathEntries = [resolve(REPOSITORY_ROOT, "node_modules/.bin"), inheritedPath]
    .filter((entry) => entry !== undefined && entry !== "");
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "path"),
  );
  environment.PATH = pathEntries.join(delimiter);

  for (const workspace of ["kernel", "terminal"]) {
    const directory = join(root, workspace);
    const source = join(directory, "src");
    const dist = join(directory, "dist");
    const manifest = JSON.parse(await readFile(
      resolve(REPOSITORY_ROOT, `packages/${workspace}/package.json`),
      "utf8",
    ));
    await Promise.all([
      mkdir(source, { recursive: true }),
      mkdir(dist, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(directory, "package.json"), `${JSON.stringify({
        name: `rigyn-${workspace}-clean-build-fixture`,
        private: true,
        type: "module",
        scripts: {
          build: manifest.scripts.build,
          clean: manifest.scripts.clean,
        },
      }, null, 2)}\n`),
      writeFile(join(directory, "tsconfig.build.json"), `${JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          rootDir: "src",
          outDir: "dist",
        },
        include: ["src/**/*.ts"],
      }, null, 2)}\n`),
      writeFile(join(source, "index.ts"), "export const current = true;\n"),
      writeFile(join(dist, "stale.js"), "throw new Error('stale output');\n"),
    ]);

    const invocation = await resolveNpmInvocation(["run", "build"]);
    await runBoundedCommand(invocation.command, invocation.args, {
      cwd: directory,
      env: environment,
      timeoutMs: 30_000,
      label: `${workspace} clean build regression`,
    });
    await assert.rejects(access(join(dist, "stale.js")), { code: "ENOENT" });
    await access(join(dist, "index.js"));
  }
});

test("agent scaffold creates private instruction and portable config files idempotently", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-agent-scaffold-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const agentDirectory = join(root, "agent");
  const temporaryDirectory = join(root, "temporary");
  const resourcesDirectory = join(PROJECT_ROOT, "resources");

  await ensureAgentScaffold(agentDirectory, resourcesDirectory, temporaryDirectory);
  await ensureAgentScaffold(agentDirectory, resourcesDirectory, temporaryDirectory);

  assert.deepEqual(
    await readFile(join(agentDirectory, "AGENTS.md")),
    await readFile(join(resourcesDirectory, "AGENTS.md")),
  );
  assert.deepEqual(
    await readFile(join(agentDirectory, "config.json")),
    await readFile(join(resourcesDirectory, "config.example.json")),
  );
  if (process.platform !== "win32") {
    assert.equal((await lstat(agentDirectory)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(agentDirectory, "AGENTS.md"))).mode & 0o777, 0o600);
    assert.equal((await lstat(join(agentDirectory, "config.json"))).mode & 0o777, 0o600);
  }
});

test("agent scaffold preserves existing files and permissions byte-for-byte", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-agent-scaffold-existing-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const agentDirectory = join(root, "agent");
  const temporaryDirectory = join(root, "temporary");
  const instructions = Buffer.from("");
  const settings = Buffer.from('{"theme":"custom-theme","quietStartup":true}\n');
  await mkdir(agentDirectory, { mode: 0o755 });
  await Promise.all([
    writeFile(join(agentDirectory, "AGENTS.md"), instructions, { mode: 0o644 }),
    writeFile(join(agentDirectory, "config.json"), settings, { mode: 0o640 }),
  ]);

  await ensureAgentScaffold(agentDirectory, join(PROJECT_ROOT, "resources"), temporaryDirectory);

  assert.deepEqual(await readFile(join(agentDirectory, "AGENTS.md")), instructions);
  assert.deepEqual(await readFile(join(agentDirectory, "config.json")), settings);
  if (process.platform !== "win32") {
    assert.equal((await lstat(agentDirectory)).mode & 0o777, 0o755);
    assert.equal((await lstat(join(agentDirectory, "AGENTS.md"))).mode & 0o777, 0o644);
    assert.equal((await lstat(join(agentDirectory, "config.json"))).mode & 0o777, 0o640);
  }
});

test("agent scaffold validates every destination before creating a missing file", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-agent-scaffold-failure-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const agentDirectory = join(root, "agent");
  await mkdir(agentDirectory, { mode: 0o755 });
  await mkdir(join(agentDirectory, "config.json"), { mode: 0o755 });

  await assert.rejects(
    ensureAgentScaffold(agentDirectory, join(PROJECT_ROOT, "resources"), join(root, "temporary")),
    /Rigyn configuration must be a regular file/u,
  );

  await assert.rejects(access(join(agentDirectory, "AGENTS.md")), { code: "ENOENT" });
  assert.equal((await lstat(join(agentDirectory, "config.json"))).isDirectory(), true);
});

test("agent scaffold rejects a linked Rigyn home without touching its target", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-agent-scaffold-link-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const target = join(root, "target");
  const agentDirectory = join(root, "agent");
  await mkdir(target, { mode: 0o755 });
  await chmod(target, 0o755);
  await symlink(target, agentDirectory, "dir");

  await assert.rejects(
    ensureAgentScaffold(agentDirectory, join(PROJECT_ROOT, "resources"), join(root, "temporary")),
    /Rigyn home must be a real directory/u,
  );

  assert.equal((await lstat(target)).mode & 0o777, 0o755);
  assert.deepEqual(await readdir(target), []);
});

test("native verification rejects a missing matching helper in a clean source tree", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-clean-source-native-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  for (const source of [
    "native/darwin/src/darwin-modifiers.c",
    "native/win32/src/win32-console-mode.c",
  ]) {
    const path = join(root, source);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "void napi_register_module_v1(void) {}\n");
  }
  const keychainSource = join(root, "native/darwin/src/rigyn-keychain-helper.swift");
  await writeFile(keychainSource, [
    "import Security",
    "let input = FileHandle.standardInput",
    "_ = SecItemCopyMatching",
    "_ = SecItemAdd",
    "_ = SecItemUpdate",
    "_ = SecItemDelete",
    "",
  ].join("\n"));
  const verifier = pathToFileURL(resolve(REPOSITORY_ROOT, "packages/terminal/scripts/verify-native.mjs")).href;
  const result = await runNode([
    "--input-type=module",
    "--eval",
    [
      'Object.defineProperty(process, "platform", { value: "win32" })',
      'Object.defineProperty(process, "arch", { value: "x64" })',
      `await import(${JSON.stringify(verifier)})`,
    ].join(";"),
  ], { cwd: root, reject: true });
  assert.match(
    result.stderr,
    /required native artifact is missing: native\/win32\/prebuilds\/win32-x64\/win32-console-mode\.node/u,
  );
});

async function writeNativeReleaseFixture(root) {
  const manifest = JSON.parse(await readFile(
    resolve(REPOSITORY_ROOT, "packages/terminal/native/targets.json"),
    "utf8",
  ));
  for (const target of manifest.targets) {
    const source = join(root, target.source);
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, "void napi_register_module_v1(void) {}\n");

    const output = join(root, target.output);
    const contents = Buffer.alloc(512);
    if (target.platform === "win32") contents.write("MZ", 0, "ascii");
    else contents.writeUInt32BE(0xfeedfacf, 0);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, contents, { mode: 0o644 });

    if (target.keychain) {
      const keychainSource = join(root, target.keychain.source);
      await mkdir(dirname(keychainSource), { recursive: true });
      await writeFile(keychainSource, [
        "import Security",
        "let input = FileHandle.standardInput",
        "_ = SecItemCopyMatching",
        "_ = SecItemAdd",
        "_ = SecItemUpdate",
        "_ = SecItemDelete",
        "",
      ].join("\n"));
      const keychainOutput = join(root, target.keychain.output);
      const keychainContents = Buffer.alloc(512);
      keychainContents.writeUInt32BE(0xfeedfacf, 0);
      await mkdir(dirname(keychainOutput), { recursive: true });
      await writeFile(keychainOutput, keychainContents, { mode: 0o600 });
    }
  }
}

async function runNativeReleaseVerifier(root, platform, reject = false) {
  const verifier = pathToFileURL(resolve(REPOSITORY_ROOT, "packages/terminal/scripts/verify-native.mjs")).href;
  return await runNode([
    "--input-type=module",
    "--eval",
    [
      `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} })`,
      'Object.defineProperty(process, "arch", { value: "ia32" })',
      'process.argv.push("--release")',
      `await import(${JSON.stringify(verifier)})`,
    ].join(";"),
  ], { cwd: root, reject });
}

test("Windows release verification ignores POSIX mode bits but validates Darwin helpers", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-windows-native-release-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  await writeNativeReleaseFixture(root);

  const result = await runNativeReleaseVerifier(root, "win32");
  assert.match(result.stdout, /all native release artifacts verified/u);
  assert.equal(result.stderr, "");

  const helper = join(root, "native/darwin/prebuilds/darwin-x64/rigyn-keychain-helper");
  await writeFile(helper, Buffer.alloc(512), { mode: 0o600 });
  const invalidHeader = await runNativeReleaseVerifier(root, "win32", true);
  assert.match(invalidHeader.stderr, /native artifact has an unexpected executable header/u);

  await rm(helper);
  const missing = await runNativeReleaseVerifier(root, "win32", true);
  assert.match(missing.stderr, /required native artifact is missing/u);
});

test("POSIX release verification requires Darwin helpers to be executable", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-posix-native-release-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  await writeNativeReleaseFixture(root);

  const result = await runNativeReleaseVerifier(root, "linux", true);

  assert.match(result.stderr, /keychain helper is not executable/u);
});

async function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (!(error instanceof Error) || error.code !== "ENOENT") throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test("POSIX launcher resolves a version-manager Node shim before isolating XDG state", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-launcher-node-shim-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const installRoot = join(root, "install");
  const launcher = join(installRoot, "bin", "rigyn");
  const productBin = join(installRoot, "app", "node_modules", ".bin", "rigyn");
  const shimDirectory = join(root, "shims");
  const nodeShim = join(shimDirectory, "node");
  const managerConfig = join(root, "manager-config");
  const privateConfig = join(installRoot, "config");
  await Promise.all([
    mkdir(dirname(launcher), { recursive: true }),
    mkdir(dirname(productBin), { recursive: true }),
    mkdir(shimDirectory, { recursive: true }),
    mkdir(managerConfig, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(launcher, posixLauncher(installRoot), { mode: 0o755 }),
    writeFile(nodeShim, `#!/bin/sh
if [ "\${XDG_CONFIG_HOME-}" != "\${EXPECTED_MANAGER_CONFIG}" ]; then
  echo "version manager cannot resolve node after XDG isolation" >&2
  exit 73
fi
exec "\${REAL_NODE}" "$@"
`, { mode: 0o755 }),
    writeFile(productBin, `#!/usr/bin/env node
if (process.env.XDG_CONFIG_HOME !== process.env.EXPECTED_PRIVATE_CONFIG) {
  throw new Error("rigyn private XDG config was not applied");
}
process.stdout.write(JSON.stringify({ execPath: process.execPath, args: process.argv.slice(2) }) + "\\n");
`),
  ]);

  const result = await runBoundedCommand(launcher, ["--probe"], {
    cwd: root,
    env: {
      PATH: `${shimDirectory}:/usr/bin:/bin`,
      XDG_CONFIG_HOME: managerConfig,
      EXPECTED_MANAGER_CONFIG: managerConfig,
      EXPECTED_PRIVATE_CONFIG: privateConfig,
      REAL_NODE: process.execPath,
    },
    timeoutMs: 5_000,
    maxOutputBytes: 64 * 1024,
    label: "XDG-sensitive Node shim launcher fixture",
  });

  assert.deepEqual(JSON.parse(result.stdout), {
    execPath: process.execPath,
    args: ["--probe"],
  });
  assert.equal(result.stderr, "");
});

test("release metadata policy matches the GitHub artifact contract", async () => {
  const result = await checkReleaseMetadata();
  assert.equal(result.version, "0.1.0");
  assert.equal(result.subpathCount, 23);
  assert.equal(result.targetCount, 6);
  assert.equal(result.nativeTargetCount, 6);
  assert.equal(result.nativeArtifactCount, 8);
  assert.equal(result.packageCount, 4);
  assert.ok(result.actionCount >= 6);
  assert.deepEqual(RIGYN_PRODUCT_PACKAGE_GRAPH.map(({ name }) => name), [
    "@rigyn/terminal",
    "@rigyn/models",
    "@rigyn/kernel",
    "rigyn",
  ]);
  assert.deepEqual(RIGYN_PACKAGE_GRAPH.map(({ name }) => name), [
    ...RIGYN_PRODUCT_PACKAGE_GRAPH.map(({ name }) => name),
  ]);
});

test("release documentation matches the native artifact and build contract", async () => {
  const result = await checkReleaseMetadata();
  const [releasing, install, platforms] = await Promise.all([
    readFile(join(PROJECT_ROOT, "docs/releasing.md"), "utf8"),
    readFile(join(PROJECT_ROOT, "docs/install.md"), "utf8"),
    readFile(join(PROJECT_ROOT, "docs/platforms.md"), "utf8"),
  ]);

  assert.match(releasing, new RegExp(`all ${result.nativeArtifactCount} native artifacts`, "u"));
  assert.match(releasing, /native:build --workspace @rigyn\/terminal/u);
  assert.match(releasing, /native:build --workspace @rigyn\/kernel/u);
  assert.match(releasing, /Windows verifier loads its terminal helper and kernel Job Object launcher/u);
  assert.match(install, /Windows\s+archives also include the matching kernel Job Object launcher/u);
  assert.match(platforms, /Windows runners load the\r?\nmatching TUI helper and kernel Job Object launcher/u);
});

test("production TypeScript builds reject unreachable and unused code", async () => {
  for (const path of [
    "packages/kernel/tsconfig.build.json",
    "packages/models/tsconfig.build.json",
    "packages/rigyn/tsconfig.json",
    "packages/terminal/tsconfig.build.json",
  ]) {
    const configuration = JSON.parse(await readFile(join(REPOSITORY_ROOT, path), "utf8"));
    assert.equal(configuration.compilerOptions?.allowUnreachableCode, false, path);
    assert.equal(configuration.compilerOptions?.noUnusedLocals, true, path);
    assert.equal(configuration.compilerOptions?.noUnusedParameters, true, path);
  }
});

test("maintained TypeScript test and public-contract configs do not weaken dead-code checks", async () => {
  for (const [path, expectedBase] of [
    ["packages/kernel/tsconfig.public-types.json", "./tsconfig.build.json"],
    ["packages/kernel/tsconfig.test.json", "./tsconfig.build.json"],
    ["packages/models/tsconfig.public-types.json", "./tsconfig.build.json"],
    ["packages/models/tsconfig.test.json", "./tsconfig.build.json"],
    ["packages/rigyn/tsconfig.test.json", "./tsconfig.json"],
  ]) {
    const configuration = JSON.parse(await readFile(join(REPOSITORY_ROOT, path), "utf8"));
    assert.equal(configuration.extends, expectedBase, path);
    assert.notEqual(configuration.compilerOptions?.allowUnreachableCode, true, path);
    assert.notEqual(configuration.compilerOptions?.noUnusedLocals, false, path);
    assert.notEqual(configuration.compilerOptions?.noUnusedParameters, false, path);
  }
});

test("release artifact uploads replace prior attempt artifacts on rerun", async () => {
  const workflow = parseYaml(await readFile(join(REPOSITORY_ROOT, ".github/workflows/release.yml"), "utf8"));
  for (const [jobName, stepName] of [
    ["native-build", "Upload native helper"],
    ["native-build", "Upload kernel process launcher"],
    ["stage", "Upload staged release"],
    ["standalone-build", "Upload standalone archive"],
    ["finalize", "Upload finalized release"],
  ]) {
    const step = workflow.jobs?.[jobName]?.steps?.find((candidate) => candidate?.name === stepName);
    assert.equal(step?.with?.overwrite, true, `${stepName} must replace the prior attempt artifact`);
  }
});

test("workspace lock identity accepts only npm's canonical unscoped name omission", () => {
  const canonical = {
    packages: {
      "packages/rigyn": { version: "0.3.0" },
      "node_modules/rigyn": { link: true, resolved: "packages/rigyn" },
    },
  };
  assert.doesNotThrow(() => assertWorkspaceLockIdentity(canonical, {
    name: "rigyn",
    directory: "packages/rigyn",
  }));

  assert.throws(
    () => assertWorkspaceLockIdentity(canonical, { name: "rigyn", directory: "packages/product" }),
    /must contain packages\/product/u,
  );
  assert.throws(
    () => assertWorkspaceLockIdentity({
      packages: {
        "packages/product": {},
        "node_modules/rigyn": { link: true, resolved: "packages/product" },
      },
    }, { name: "rigyn", directory: "packages/product" }),
    /name must match package\.json/u,
  );
  assert.throws(
    () => assertWorkspaceLockIdentity({
      packages: {
        "packages/rigyn": { name: "other" },
        "node_modules/rigyn": { link: true, resolved: "packages/rigyn" },
      },
    }, { name: "rigyn", directory: "packages/rigyn" }),
    /name must match package\.json/u,
  );
  assert.throws(
    () => assertWorkspaceLockIdentity({
      packages: {
        "packages/models": {},
        "node_modules/@rigyn/models": { link: true, resolved: "packages/models" },
      },
    }, { name: "@rigyn/models", directory: "packages/models" }),
    /name must match package\.json/u,
  );
});

test("workspace lock identity requires the exact node_modules workspace link", () => {
  const workspace = { "packages/rigyn": {} };
  assert.throws(
    () => assertWorkspaceLockIdentity({ packages: workspace }, {
      name: "rigyn",
      directory: "packages/rigyn",
    }),
    /must be a workspace link/u,
  );
  assert.throws(
    () => assertWorkspaceLockIdentity({
      packages: {
        ...workspace,
        "node_modules/rigyn": { link: false, resolved: "packages/rigyn" },
      },
    }, { name: "rigyn", directory: "packages/rigyn" }),
    /must be a workspace link/u,
  );
  assert.throws(
    () => assertWorkspaceLockIdentity({
      packages: {
        ...workspace,
        "node_modules/rigyn": { link: true, resolved: "packages/other" },
      },
    }, { name: "rigyn", directory: "packages/rigyn" }),
    /must resolve to packages\/rigyn/u,
  );
});

test("release root identity cannot drift from the product or lockfile", () => {
  const lockfile = { packages: { "": { name: "rigyn-workspace", version: "0.3.0" } } };
  assert.doesNotThrow(() => assertRootLockIdentity(
    lockfile,
    { name: "rigyn-workspace", version: "0.3.0" },
    "0.3.0",
  ));
  assert.throws(
    () => assertRootLockIdentity(lockfile, { name: "rigyn-workspace", version: "0.2.0" }, "0.3.0"),
    /Root package version must match rigyn/u,
  );
  assert.throws(
    () => assertRootLockIdentity(
      { packages: { "": { name: "rigyn-workspace", version: "0.2.0" } } },
      { name: "rigyn-workspace", version: "0.3.0" },
      "0.3.0",
    ),
    /package-lock root version must match package\.json/u,
  );
});

test("release note extraction rejects an undated or empty release", () => {
  assert.throws(
    () => extractReleaseNotes("## [0.1.0]\n\n### Added\n\n- Change\n", "0.1.0"),
    /dated \[0\.1\.0\] release heading/u,
  );
  assert.throws(
    () => extractReleaseNotes("## [0.1.0] - 2026-07-12\n", "0.1.0"),
    /must not be empty/u,
  );
  assert.deepEqual(
    extractReleaseNotes("## [0.1.0] - 2026-07-12\r\n\r\n### Fixed\r\n\r\n- Change\r\n", "0.1.0"),
    { date: "2026-07-12", body: "### Fixed\n\n- Change" },
  );
  assert.deepEqual(
    extractReleaseNotes("## [0.1.0] - 2026-07-12\n\nFirst public release.\n\n- Complete product\n", "0.1.0"),
    { date: "2026-07-12", body: "First public release.\n\n- Complete product" },
  );
});

test("implicit self-update is monotonic while an explicit local bundle may downgrade", () => {
  assert.doesNotThrow(() => assertUpdateVersionPolicy("9.8.6", "9.8.6", false));
  assert.doesNotThrow(() => assertUpdateVersionPolicy("9.8.6", "9.8.7", false));
  assert.throws(
    () => assertUpdateVersionPolicy("9.8.6", "9.8.5", false),
    /Refusing to replace rigyn 9\.8\.6 with older 9\.8\.5/u,
  );
  assert.throws(
    () => assertUpdateVersionPolicy("not-semver", "9.8.7", false),
    /Installed rigyn version is invalid/u,
  );
  assert.doesNotThrow(() => assertUpdateVersionPolicy("9.8.6", "9.8.5", true));
  assert.doesNotThrow(() => assertUpdateVersionPolicy("not-semver", "9.8.5", true));
  assert.throws(
    () => assertUpdateVersionPolicy("9.8.6", "not-semver", true),
    /Downloaded rigyn package version is invalid/u,
  );
});

test("GitHub self-update downloads and verifies the complete release package graph", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-github-update-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const fixture = githubReleaseFixture();
  const calls = [];
  const result = await downloadLatestGitHubReleaseBundle(root, {
    fetch: githubReleaseFetch(fixture, calls),
  });

  assert.equal(result.version, fixture.manifest.version);
  assert.deepEqual(result.specs.map((path) => path.slice(root.length + 1)), fixture.archives.map(({ file }) => file));
  for (const [index, path] of result.specs.entries()) {
    assert.deepEqual(await readFile(path), fixture.files.get(fixture.archives[index].file));
  }
  assert.equal(calls.length, 2 + RIGYN_PRODUCT_PACKAGE_GRAPH.length);
  assert.equal(calls[0].url, "https://api.github.com/repos/rigyn/rigyn/releases/latest");
  assert.equal(calls.every(({ init }) => init.redirect === "manual" && init.signal instanceof AbortSignal), true);
});

test("GitHub self-update retries one thrown transport failure and then succeeds", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-github-update-transport-retry-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const fixture = githubReleaseFixture();
  const fixtureFetch = githubReleaseFetch(fixture);
  let latestAttempts = 0;
  const latestSignals = new Set();

  const result = await downloadLatestGitHubReleaseBundle(root, {
    fetch: async (input, init) => {
      if (String(input).endsWith("/releases/latest")) {
        latestSignals.add(init.signal);
        if (latestAttempts++ === 0) throw new TypeError("injected transient transport failure");
      }
      return await fixtureFetch(input, init);
    },
  });

  assert.equal(result.version, fixture.manifest.version);
  assert.equal(latestAttempts, 2);
  assert.equal(latestSignals.size, 1);
});

test("GitHub self-update disposes a retryable HTTP response and then succeeds", async (context) => {
  for (const status of [408, 425, 429, 500, 599]) {
    const root = await mkdtemp(join(tmpdir(), `rigyn-github-update-http-${status}-retry-`));
    context.after(async () => await rm(root, { recursive: true, force: true }));
    const fixture = githubReleaseFixture();
    const fixtureFetch = githubReleaseFetch(fixture);
    let latestAttempts = 0;
    let cancelled = 0;

    const result = await downloadLatestGitHubReleaseBundle(root, {
      fetch: async (input, init) => {
        if (String(input).endsWith("/releases/latest") && latestAttempts++ === 0) {
          return failedFetchResponse(status, { retryAfter: "0", onCancel: () => { cancelled += 1; } });
        }
        return await fixtureFetch(input, init);
      },
    });

    assert.equal(result.version, fixture.manifest.version);
    assert.equal(latestAttempts, 2);
    assert.equal(cancelled, 1);
  }
});

test("GitHub self-update stops after three retryable HTTP attempts", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-github-update-http-exhaustion-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  let attempts = 0;
  let cancelled = 0;

  await assert.rejects(
    downloadLatestGitHubReleaseBundle(root, {
      fetch: async () => {
        attempts += 1;
        return failedFetchResponse(503, { retryAfter: "0", onCancel: () => { cancelled += 1; } });
      },
    }),
    /metadata failed with HTTP 503/u,
  );

  assert.equal(attempts, 3);
  assert.equal(cancelled, 3);
  assert.deepEqual(await readdir(root), []);
});

test("GitHub self-update disposes a permanent HTTP failure without retrying", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-github-update-http-permanent-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  let attempts = 0;
  let cancelled = 0;

  await assert.rejects(
    downloadLatestGitHubReleaseBundle(root, {
      fetch: async () => {
        attempts += 1;
        return failedFetchResponse(404, { onCancel: () => { cancelled += 1; } });
      },
    }),
    /metadata failed with HTTP 404/u,
  );

  assert.equal(attempts, 1);
  assert.equal(cancelled, 1);
  assert.deepEqual(await readdir(root), []);
});

test("GitHub self-update follows only bounded HTTPS redirects", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-github-update-redirect-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const fixture = githubReleaseFixture();
  const calls = [];
  const fixtureFetch = githubReleaseFetch(fixture, calls);
  let redirected = false;
  const result = await downloadLatestGitHubReleaseBundle(root, {
    fetch: async (input, init) => {
      const url = String(input);
      if (!redirected && url.endsWith("/releases/latest")) {
        redirected = true;
        calls.push({ init, url });
        return new Response(null, { status: 302, headers: { location: "./latest-final" } });
      }
      if (url.endsWith("/releases/latest-final")) {
        calls.push({ init, url });
        const contents = Buffer.from(JSON.stringify(fixture.release));
        return new Response(contents, {
          status: 200,
          headers: { "content-length": String(contents.byteLength) },
        });
      }
      return fixtureFetch(input, init);
    },
  });

  assert.equal(result.version, fixture.manifest.version);
  assert.equal(calls[1].url, "https://api.github.com/repos/rigyn/rigyn/releases/latest-final");
  assert.equal(calls.every(({ init }) => init.redirect === "manual"), true);
});

test("GitHub self-update rejects an HTTPS-to-HTTP redirect", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-github-update-downgrade-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  let calls = 0;
  await assert.rejects(
    downloadLatestGitHubReleaseBundle(root, {
      fetch: async () => {
        calls += 1;
        return new Response(null, {
          status: 302,
          headers: { location: "http://downloads.invalid/release.json" },
        });
      },
    }),
    /redirected URL must use HTTPS/u,
  );
  assert.equal(calls, 1);
});

test("GitHub self-update rejects the legacy release packaging label", () => {
  const fixture = githubReleaseFixture();
  assert.throws(
    () => validateGitHubReleaseManifest(
      { ...fixture.manifest, packaging: "npm-and-standalone" },
      fixture.release.tag_name,
    ),
    /supported GitHub release/u,
  );
});

test("GitHub self-update rejects unsupported manifests and bounded metadata overflow", async (context) => {
  const fixture = githubReleaseFixture();
  assert.throws(
    () => validateGitHubReleaseManifest({ ...fixture.manifest, unexpected: true }, fixture.release.tag_name),
    /unsupported schema/u,
  );
  assert.throws(
    () => validateGitHubReleaseManifest({ ...fixture.manifest, schemaVersion: 5 }, fixture.release.tag_name),
    /supported GitHub release/u,
  );
  assert.throws(
    () => validateGitHubReleaseManifest({
      ...fixture.manifest,
      archives: [...fixture.manifest.archives].reverse(),
    }, fixture.release.tag_name),
    /archive metadata is invalid/u,
  );
  const root = await mkdtemp(join(tmpdir(), "rigyn-github-update-bounds-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  await assert.rejects(
    downloadLatestGitHubReleaseBundle(root, {
      fetch: async () => new Response("{}", {
        status: 200,
        headers: { "content-length": String(1024 * 1024 + 1) },
      }),
    }),
    /metadata exceeds the download limit/u,
  );
});

test("GitHub self-update removes every downloaded archive after checksum failure", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-github-update-checksum-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const fixture = githubReleaseFixture();
  const finalArchive = fixture.archives.at(-1);
  fixture.files.set(finalArchive.file, Buffer.alloc(finalArchive.bytes, 1));
  fixture.refresh();
  const calls = [];

  await assert.rejects(
    downloadLatestGitHubReleaseBundle(root, { fetch: githubReleaseFetch(fixture, calls) }),
    /SHA-256 does not match/u,
  );
  assert.equal(calls.filter(({ url }) => url.endsWith(`/${finalArchive.file}`)).length, 1);
  assert.deepEqual(await readdir(root), []);
});

test("GitHub self-update does not retry a failed archive body and removes its partial file", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-github-update-body-failure-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const fixture = githubReleaseFixture();
  const archive = fixture.archives[0];
  const fixtureFetch = githubReleaseFetch(fixture);
  let archiveAttempts = 0;

  await assert.rejects(
    downloadLatestGitHubReleaseBundle(root, {
      fetch: async (input, init) => {
        if (String(input).endsWith(`/${archive.file}`)) {
          archiveAttempts += 1;
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(Uint8Array.of(1));
              controller.error(new Error("injected archive body failure"));
            },
          }), {
            status: 200,
            headers: { "content-length": String(archive.bytes) },
          });
        }
        return await fixtureFetch(input, init);
      },
    }),
    /injected archive body failure/u,
  );

  assert.equal(archiveAttempts, 1);
  assert.deepEqual(await readdir(root), []);
});

test("streamed POSIX bootstrap installs a verified standalone without Node or npm", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bootstrap-posix-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const run = await runPosixBootstrap(root);
  assert.equal(run.result.code, 0, run.result.stderr);
  assert.match(run.result.stdout, /verified GitHub standalone release/u);
  assert.equal(await readlink(run.launcher), join(run.runtime, "bin/rigyn"));
  assert.equal(await readlink(run.command), run.launcher);
  assert.equal(await readFile(join(run.home, ".rigyn/AGENTS.md"), "utf8"), "");
  assert.equal(await readFile(join(run.home, ".rigyn/config.json"), "utf8"), "{}\n");
  const curlCalls = (await readFile(run.curlCapture, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(curlCalls.length, 3);
  assert.equal(curlCalls[0].url, "https://github.com/rigyn/rigyn/releases/latest");
  assert.equal(basename(new URL(curlCalls[2].url).pathname), run.archiveName);
  assert.deepEqual(await readdir(run.temporary), []);
  const script = await readFile(join(REPOSITORY_ROOT, "install.sh"), "utf8");
  assert.match(script, /for rigyn_command in [^\n]*\bcmp\b/u);
  assert.match(script, /for rigyn_command in [^\n]*\bls\b/u);
  assert.doesNotMatch(script, /command -v (?:node|npm)|npm exec|node -e/u);
});

for (const name of ["AGENTS.md", "config.json"]) {
  for (const kind of ["directory", "symlink"]) test(
    `streamed POSIX bootstrap rejects a ${kind} at the ${name} scaffold destination`,
    { skip: process.platform === "win32" },
    async (context) => {
      const root = await mkdtemp(join(tmpdir(), `rigyn-bootstrap-posix-scaffold-${kind}-`));
      context.after(async () => await rm(root, { recursive: true, force: true }));
      const run = await runPosixBootstrap(root, { scaffoldDestination: { kind, name } });

      assert.notEqual(run.result.code, 0);
      assert.match(
        run.result.stderr,
        new RegExp(`${name === "AGENTS.md" ? "Agent instructions" : "Rigyn configuration"} must be a regular file`, "u"),
      );
      await assert.rejects(access(run.runtime), (error) => error?.code === "ENOENT");
      const otherName = name === "AGENTS.md" ? "config.json" : "AGENTS.md";
      await assert.rejects(access(join(run.agentDirectory, otherName)), (error) => error?.code === "ENOENT");
      if (kind === "directory") {
        assert.equal((await lstat(join(run.agentDirectory, name))).isDirectory(), true);
      } else {
        assert.equal((await lstat(join(run.agentDirectory, name))).isSymbolicLink(), true);
        assert.equal(await readFile(run.scaffoldTarget, "utf8"), "preserve this target\n");
      }
    },
  );
}

test("streamed POSIX bootstrap rejects link entries before extraction", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bootstrap-posix-link-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const run = await runPosixBootstrap(root, { archiveLink: true });
  assert.notEqual(run.result.code, 0);
  assert.match(run.result.stderr, /contains an unsupported entry type/u);
  await assert.rejects(access(run.runtime), (error) => error?.code === "ENOENT");
});

for (const existingRuntime of [false, true]) test(
  `streamed POSIX bootstrap ${existingRuntime ? "update" : "install"} waits for an active lifecycle operation`,
  { skip: process.platform === "win32", timeout: 20_000 },
  async (context) => {
    const root = await mkdtemp(join(
      tmpdir(),
      `rigyn-bootstrap-posix-${existingRuntime ? "update" : "install"}-lock-`,
    ));
    context.after(async () => await rm(root, { recursive: true, force: true }));
    const run = await runPosixBootstrap(root, {
      existingRuntime,
      lifecycleLockDelayMs: 1_500,
    });

    assert.equal(run.result.code, 0, run.result.stderr);
    assert.ok(run.elapsedMs >= 1_200, `bootstrap bypassed the active lifecycle lock (${run.elapsedMs} ms)`);
    await assert.rejects(access(`${join(run.home, ".rigyn")}.lifecycle.lock`), { code: "ENOENT" });
  },
);

test("streamed POSIX bootstrap recovers a stale lifecycle lock", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bootstrap-posix-stale-lock-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const run = await runPosixBootstrap(root, { staleLifecycleLock: true });

  assert.equal(run.result.code, 0, run.result.stderr);
  await assert.rejects(access(`${join(run.home, ".rigyn")}.lifecycle.lock`), { code: "ENOENT" });
});

test("streamed POSIX bootstrap recovers a stable malformed lifecycle lock", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bootstrap-posix-malformed-lock-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const run = await runPosixBootstrap(root, { malformedLifecycleLock: true });

  assert.equal(run.result.code, 0, run.result.stderr);
  assert.ok(run.elapsedMs >= 800, `bootstrap skipped the malformed-lock observation window (${run.elapsedMs} ms)`);
  await assert.rejects(access(`${join(run.home, ".rigyn")}.lifecycle.lock`), { code: "ENOENT" });
});

test("streamed POSIX bootstrap does not steal a lifecycle lock while its owner completes the record", {
  skip: process.platform === "win32",
  timeout: 20_000,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bootstrap-posix-completing-lock-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const run = await runPosixBootstrap(root, { completingLifecycleLock: true });

  assert.equal(run.result.code, 0, run.result.stderr);
  assert.ok(run.elapsedMs >= 1_200, `bootstrap bypassed the completing lifecycle lock (${run.elapsedMs} ms)`);
  await assert.rejects(access(`${join(run.home, ".rigyn")}.lifecycle.lock`), { code: "ENOENT" });
});

test("streamed POSIX bootstrap replaces a stale same-version standalone from the verified payload", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bootstrap-posix-repair-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const run = await runPosixBootstrap(root, { existingRuntime: true });

  assert.equal(run.result.code, 0, run.result.stderr);
  assert.equal(await readFile(join(run.runtime, "bin/rigyn"), "utf8"), run.launcherContents);
  assert.equal(JSON.parse(await readFile(join(run.runtime, "BUILD-METADATA.json"), "utf8")).version, run.fixture.manifest.version);
  await assert.rejects(access(join(run.runtime, "stale-only.txt")), (error) => error?.code === "ENOENT");
  assert.equal(await readlink(run.launcher), join(run.runtime, "bin/rigyn"));
  assert.equal(await readlink(run.command), run.launcher);
  assert.deepEqual(
    (await readdir(dirname(run.runtime))).filter((entry) => entry.startsWith(".rigyn-")),
    [],
  );
});

for (const phase of ["prepared", "isolated", "command-removed"]) test(
  `streamed POSIX bootstrap repairs an interrupted standalone uninstall in phase ${phase}`,
  { skip: process.platform === "win32" },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), `rigyn-bootstrap-posix-uninstall-${phase}-`));
    context.after(async () => await rm(root, { recursive: true, force: true }));
    const run = await runPosixBootstrap(root, {
      existingRuntime: true,
      interruptedUninstallPhase: phase,
    });

    assert.equal(run.result.code, 0, run.result.stderr);
    assert.equal(await readlink(run.launcher), join(run.runtime, "bin/rigyn"));
    assert.equal(await readlink(run.command), run.launcher);
    await assert.rejects(access(`${join(run.home, ".rigyn")}.uninstalling`), { code: "ENOENT" });
    await assert.rejects(access(`${join(run.home, ".rigyn")}.uninstall.json`), { code: "ENOENT" });
  },
);

for (const phase of ["prepared", "replacement-installed"]) test(
  `streamed POSIX bootstrap restores an interrupted runtime replacement in phase ${phase}`,
  { skip: process.platform === "win32" },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), `rigyn-bootstrap-posix-runtime-${phase}-`));
    context.after(async () => await rm(root, { recursive: true, force: true }));
    const run = await runPosixBootstrap(root, {
      existingRuntime: true,
      interruptedRuntimePhase: phase,
      linkedAgentDirectory: true,
    });

    assert.notEqual(run.result.code, 0);
    assert.match(run.result.stderr, /rigyn home is not a safe directory/u);
    assert.equal(await readFile(join(run.runtime, "stale-only.txt"), "utf8"), "must be removed\n");
    await assert.rejects(access(join(run.runtime, "interrupted-replacement.txt")), { code: "ENOENT" });
    assert.deepEqual(
      (await readdir(dirname(run.runtime))).filter((entry) => entry.startsWith(".rigyn-")),
      [],
    );
  },
);

test("streamed POSIX bootstrap preserves a committed replacement during recovery", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bootstrap-posix-runtime-committed-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const run = await runPosixBootstrap(root, {
    existingRuntime: true,
    interruptedRuntimePhase: "committed",
    linkedAgentDirectory: true,
  });

  assert.notEqual(run.result.code, 0);
  assert.match(run.result.stderr, /rigyn home is not a safe directory/u);
  assert.equal(await readFile(join(run.runtime, "interrupted-replacement.txt"), "utf8"), "uncommitted\n");
  await assert.rejects(access(join(run.runtime, "stale-only.txt")), { code: "ENOENT" });
  assert.deepEqual(
    (await readdir(dirname(run.runtime))).filter((entry) => entry.startsWith(".rigyn-")),
    [],
  );
});

for (const recordKind of ["malformed", "symlink"]) test(
  `streamed POSIX bootstrap refuses a ${recordKind} runtime transaction record`,
  { skip: process.platform === "win32" },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), `rigyn-bootstrap-posix-runtime-record-${recordKind}-`));
    context.after(async () => await rm(root, { recursive: true, force: true }));
    const run = await runPosixBootstrap(root, { runtimeTransactionRecord: recordKind });

    assert.notEqual(run.result.code, 0);
    assert.match(run.result.stderr, /standalone runtime transaction is (?:invalid|unsafe)/u);
  },
);

for (const runtimeLeaseState of ["empty", "stale", "active"]) test(
  `streamed POSIX bootstrap ${runtimeLeaseState === "active" ? "rejects an active" : `accepts ${runtimeLeaseState === "empty" ? "an" : "a"} ${runtimeLeaseState}`} standalone runtime lease directory`,
  { skip: process.platform === "win32" },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), `rigyn-bootstrap-posix-${runtimeLeaseState}-leases-`));
    context.after(async () => await rm(root, { recursive: true, force: true }));
    const run = await runPosixBootstrap(root, { existingRuntime: true, runtimeLeaseState });

    if (runtimeLeaseState !== "active") {
      assert.equal(run.result.code, 0, run.result.stderr);
      assert.equal(await readFile(join(run.runtime, "bin/rigyn"), "utf8"), run.launcherContents);
      if (runtimeLeaseState === "stale") {
        await assert.rejects(
          access(join(run.home, ".rigyn/.runtime-leases", `${"a".repeat(32)}.json`)),
          (error) => error?.code === "ENOENT",
        );
      }
    } else {
      assert.notEqual(run.result.code, 0);
      assert.match(run.result.stderr, /close every running rigyn process/u);
      assert.equal(await readFile(join(run.runtime, "stale-only.txt"), "utf8"), "must be removed\n");
    }
  },
);

test("streamed POSIX bootstrap replaces only the exact managed command", {
  skip: process.platform === "win32",
}, async (context) => {
  const managedRoot = await mkdtemp(join(tmpdir(), "rigyn-bootstrap-posix-managed-launcher-"));
  context.after(async () => await rm(managedRoot, { recursive: true, force: true }));
  const migrated = await runPosixBootstrap(managedRoot, {
    existingRuntime: true,
    managedCommandLauncher: true,
  });

  assert.equal(migrated.result.code, 0, migrated.result.stderr);
  assert.equal(await readlink(migrated.launcher), join(migrated.runtime, "bin/rigyn"));
  assert.equal(await readlink(migrated.command), migrated.launcher);

  const unmanagedRoot = await mkdtemp(join(tmpdir(), "rigyn-bootstrap-posix-marker-lookalike-"));
  context.after(async () => await rm(unmanagedRoot, { recursive: true, force: true }));
  const rejected = await runPosixBootstrap(unmanagedRoot, {
    existingRuntime: true,
    unmanagedMarkerLauncher: true,
  });

  assert.notEqual(rejected.result.code, 0);
  assert.match(rejected.result.stderr, /refusing to replace an unmanaged command/u);
  assert.equal(
    await readFile(rejected.command, "utf8"),
    "#!/usr/bin/env sh\n# rigyn managed command\nexec '/tmp/unmanaged' \"$@\"\n",
  );
  assert.equal(await readFile(join(rejected.runtime, "stale-only.txt"), "utf8"), "must be removed\n");
});

test("streamed POSIX bootstrap rejects a configured linked Rigyn home before replacement", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bootstrap-posix-linked-agent-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const run = await runPosixBootstrap(root, {
    existingRuntime: true,
    linkedAgentDirectory: true,
  });

  assert.notEqual(run.result.code, 0);
  assert.match(run.result.stderr, /rigyn home is not a safe directory/u);
  assert.equal((await lstat(run.agentDirectory)).isSymbolicLink(), true);
  assert.deepEqual(await readdir(run.externalAgentDirectory), []);
  assert.equal(await readFile(join(run.runtime, "stale-only.txt"), "utf8"), "must be removed\n");
  assert.equal(await readlink(run.launcher), join(run.runtime, "bin/rigyn"));
  assert.equal(await readlink(run.command), run.launcher);
  assert.deepEqual(
    (await readdir(dirname(run.runtime))).filter((entry) => entry.startsWith(".rigyn-")),
    [],
  );
});

test("streamed POSIX bootstrap rejects a marker-owned source installation", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bootstrap-posix-source-owned-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const run = await runPosixBootstrap(root, { sourceInstallMarker: true });

  assert.notEqual(run.result.code, 0);
  assert.match(run.result.stderr, /source-built installation/u);
  assert.match(run.result.stderr, /preserve ~\/\.rigyn and follow the state-preserving transition docs/u);
  assert.doesNotMatch(run.result.stderr, /uninstall it/u);
  assert.equal(await readFile(join(run.home, ".rigyn/.installation.json"), "utf8"), "{}\n");
  await assert.rejects(access(run.runtime), (error) => error?.code === "ENOENT");
  await assert.rejects(access(run.launcher), (error) => error?.code === "ENOENT");
  await assert.rejects(access(run.command), (error) => error?.code === "ENOENT");
});

test("streamed POSIX bootstrap restores the previous installation after post-swap failures", {
  skip: process.platform === "win32",
}, async (context) => {
  for (const failure of ["scaffold", "launcher", "command"]) {
    const root = await mkdtemp(join(tmpdir(), `rigyn-bootstrap-posix-${failure}-rollback-`));
    context.after(async () => await rm(root, { recursive: true, force: true }));
    const run = await runPosixBootstrap(root, {
      existingRuntime: true,
      failAfterRuntime: failure,
    });

    assert.notEqual(run.result.code, 0);
    assert.match(run.result.stderr, new RegExp(`injected ${failure === "scaffold" ? "cp" : "mv"} failure`, "u"));
    assert.equal(
      await readFile(join(run.runtime, "bin/rigyn"), "utf8"),
      "#!/bin/sh\nprintf 'stale runtime\\n'\n",
    );
    assert.equal(await readFile(join(run.runtime, "BUILD-METADATA.json"), "utf8"), "{ corrupt same-version metadata\n");
    assert.equal(await readFile(join(run.runtime, "stale-only.txt"), "utf8"), "must be removed\n");
    assert.equal(await readlink(run.launcher), join(run.runtime, "bin/rigyn"));
    assert.equal(await readlink(run.command), run.launcher);
    await assert.rejects(access(join(run.home, ".rigyn/AGENTS.md")), (error) => error?.code === "ENOENT");
    await assert.rejects(access(join(run.home, ".rigyn/config.json")), (error) => error?.code === "ENOENT");
    assert.deepEqual(
      (await readdir(dirname(run.runtime))).filter((entry) => entry.startsWith(".rigyn-")),
      [],
    );
    assert.deepEqual(
      (await readdir(dirname(run.launcher))).filter((entry) => entry.startsWith(".rigyn-link.")),
      [],
    );
    assert.deepEqual(
      (await readdir(dirname(run.command))).filter((entry) => entry.startsWith(".rigyn-command.")),
      [],
    );
    assert.deepEqual(await readdir(run.temporary), []);
  }
});

test("streamed POSIX bootstrap preserves staged command and launcher backups when rollback restoration fails", {
  skip: process.platform === "win32",
}, async (context) => {
  for (const restoreTarget of ["launcher", "command"]) {
    const root = await mkdtemp(join(tmpdir(), `rigyn-bootstrap-posix-${restoreTarget}-restore-failure-`));
    context.after(async () => await rm(root, { recursive: true, force: true }));
    const run = await runPosixBootstrap(root, {
      existingRuntime: true,
      failAfterRuntime: restoreTarget,
      failRestore: restoreTarget,
    });

    assert.notEqual(run.result.code, 0);
    const stageDirectory = restoreTarget === "launcher" ? dirname(run.launcher) : dirname(run.command);
    const stagePrefix = restoreTarget === "launcher" ? ".rigyn-link." : ".rigyn-command.";
    const stages = (await readdir(stageDirectory)).filter((entry) => entry.startsWith(stagePrefix));
    assert.equal(stages.length, 1);
    const backup = join(stageDirectory, stages[0], "previous");
    assert.equal(
      await readlink(backup),
      restoreTarget === "launcher" ? join(run.runtime, "bin/rigyn") : run.launcher,
    );
    assert.ok(run.result.stderr.includes(`backup preserved at ${backup}`));
    assert.equal(
      await readFile(join(run.runtime, "bin/rigyn"), "utf8"),
      "#!/bin/sh\nprintf 'stale runtime\\n'\n",
    );
    const otherStagePrefix = restoreTarget === "launcher" ? ".rigyn-command." : ".rigyn-link.";
    const otherStageDirectory = restoreTarget === "launcher" ? dirname(run.command) : dirname(run.launcher);
    assert.deepEqual(
      (await readdir(otherStageDirectory)).filter((entry) => entry.startsWith(otherStagePrefix)),
      [],
    );
  }
});

test("streamed POSIX bootstrap reports a failed runtime restore and preserves the exact backup", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bootstrap-posix-runtime-restore-failure-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const run = await runPosixBootstrap(root, {
    existingRuntime: true,
    failAfterRuntime: "command",
    failRestore: "runtime",
  });

  assert.notEqual(run.result.code, 0);
  const backupParents = (await readdir(dirname(run.runtime)))
    .filter((entry) => entry.startsWith(".rigyn-backup."));
  assert.equal(backupParents.length, 1);
  const backup = join(dirname(run.runtime), backupParents[0], basename(run.runtime));
  assert.ok(run.result.stderr.includes(`backup preserved at ${backup}`));
  assert.equal(
    await readFile(join(backup, "bin/rigyn"), "utf8"),
    "#!/bin/sh\nprintf 'stale runtime\\n'\n",
  );
  assert.equal(
    await readFile(join(backup, "BUILD-METADATA.json"), "utf8"),
    "{ corrupt same-version metadata\n",
  );
  assert.equal(await readFile(join(backup, "stale-only.txt"), "utf8"), "must be removed\n");
  await assert.rejects(access(run.runtime), (error) => error?.code === "ENOENT");
  assert.equal(await readlink(run.launcher), join(run.runtime, "bin/rigyn"));
  assert.equal(await readlink(run.command), run.launcher);
  assert.deepEqual(
    (await readdir(dirname(run.launcher))).filter((entry) => entry.startsWith(".rigyn-link.")),
    [],
  );
  assert.deepEqual(
    (await readdir(dirname(run.command))).filter((entry) => entry.startsWith(".rigyn-command.")),
    [],
  );
});

test("streamed POSIX bootstrap rejects a traversal-form managed launcher before replacement", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bootstrap-posix-traversal-launcher-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const run = await runPosixBootstrap(root, {
    existingRuntime: true,
    traversalLauncher: true,
  });

  assert.notEqual(run.result.code, 0);
  assert.match(run.result.stderr, /refusing to replace an unmanaged command/u);
  assert.equal(await readFile(join(run.runtime, "stale-only.txt"), "utf8"), "must be removed\n");
  assert.match(await readlink(run.launcher), /\/\.\.\/\.\.\/\.\.\/\.\.\/outside\/bin\/rigyn$/u);
  assert.deepEqual(
    (await readdir(dirname(run.runtime))).filter((entry) => entry.startsWith(".rigyn-")),
    [],
  );
});

test("streamed POSIX bootstrap rejects a standalone checksum mismatch before installation", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bootstrap-posix-checksum-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const run = await runPosixBootstrap(root, { corrupt: true });
  assert.notEqual(run.result.code, 0);
  assert.match(run.result.stderr, new RegExp(`checksum mismatch for ${run.archiveName.replaceAll(".", "\\.")}`, "u"));
  await assert.rejects(access(join(run.home, ".local/bin/rigyn")), (error) => error?.code === "ENOENT");
  assert.deepEqual(await readdir(run.temporary), []);
});

test("streamed POSIX bootstrap rolls back a standalone that cannot execute", {
  skip: process.platform === "win32",
}, async (context) => {
  for (const existingRuntime of [false, true]) {
    const root = await mkdtemp(join(
      tmpdir(),
      `rigyn-bootstrap-posix-runtime-smoke-${existingRuntime ? "repair" : "fresh"}-`,
    ));
    context.after(async () => await rm(root, { recursive: true, force: true }));
    const run = await runPosixBootstrap(root, { brokenLauncher: true, existingRuntime });

    assert.notEqual(run.result.code, 0);
    assert.match(run.result.stderr, /installed rigyn command failed its version check/u);
    if (existingRuntime) {
      assert.equal(
        await readFile(join(run.runtime, "bin/rigyn"), "utf8"),
        "#!/bin/sh\nprintf 'stale runtime\\n'\n",
      );
      assert.equal(await readlink(run.launcher), join(run.runtime, "bin/rigyn"));
      assert.equal(await readlink(run.command), run.launcher);
    } else {
      await assert.rejects(access(run.runtime), (error) => error?.code === "ENOENT");
      await assert.rejects(access(run.launcher), (error) => error?.code === "ENOENT");
      await assert.rejects(access(run.command), (error) => error?.code === "ENOENT");
    }
    await assert.rejects(access(join(run.agentDirectory, "AGENTS.md")), (error) => error?.code === "ENOENT");
    await assert.rejects(access(join(run.agentDirectory, "config.json")), (error) => error?.code === "ENOENT");
  }
});

test("PowerShell bootstrap verifies and installs the matching standalone archive", async () => {
  const scriptPath = join(REPOSITORY_ROOT, "install.ps1");
  const script = await readFile(scriptPath, "utf8");
  const launcherBlock = script.slice(
    script.indexOf("$launcherTarget ="),
    script.indexOf("$rigynHome ="),
  );
  assert.match(script, /api\.github\.com\/repos\/rigyn\/rigyn\/releases\/latest/u);
  assert.match(script, /function Get-rigynLatestRedirectTag\(\[string\]\$Uri\)/u);
  assert.match(script, /\$tag = Get-rigynLatestRedirectTag "\$releaseRoot\/latest"/u);
  assert.match(script, /\$nextUri\.Host, "github\.com"/u);
  assert.match(script, /\$nextUri\.IsDefaultPort/u);
  assert.match(
    script,
    /Microsoft\.PowerShell\.Utility\\Get-FileHash -LiteralPath \$archivePath -Algorithm SHA256/u,
  );
  assert.match(script, /"rigyn-v\$version-win32-\$arch\.tar\.gz"/u);
  assert.match(script, /\$tarCommands = @\(Get-Command tar\.exe -CommandType Application/u);
  assert.match(script, /\$tarCommand = \$tarCommands\[0\]/u);
  assert.match(script, /\$metadata -notmatch '\^\[-d\]'/u);
  assert.match(script, /\$entry\.Contains\("\\"\)/u);
  assert.match(script, /rem rigyn standalone managed command/u);
  assert.match(script, /\$Item\.Name -cnotmatch/u);
  assert.doesNotMatch(script, /-notcmatch/u);
  assert.ok(script.includes('$launcherRuntimeRoot = "%USERPROFILE%\\.rigyn\\runtime"'));
  assert.match(script, /\$runtimeRoot = Join-Path \$rigynRoot "runtime"/u);
  assert.match(launcherBlock, /\$launcherTarget = "\$launcherRuntimeRoot\\\$archiveRoot\\bin\\rigyn\.cmd"/u);
  assert.match(script, /\[IO\.File\]::WriteAllText\(\$stagedLauncher, \$launcherContents, \[Text\.Encoding\]::ASCII\)/u);
  assert.doesNotMatch(launcherBlock, /\$target/u);
  assert.match(script, /\$existingLauncher -match \$managedLauncherPattern/u);
  assert.match(script, /\$launcherItem\.Attributes -band \[IO\.FileAttributes\]::ReparsePoint/u);
  assert.match(script, /\$managedLauncherPattern = '\\A[\s\S]+\\z'/u);
  assert.doesNotMatch(script, /\\d/u);
  assert.doesNotMatch(script, /\.Contains\("rem rigyn standalone managed command"\)/u);
  assert.match(script, /a source-built installation owns \$rigynRoot/u);
  assert.match(script, /close every running rigyn process before updating the standalone installation/u);
  assert.match(script, /preserve \$rigynRoot and follow the state-preserving distribution-switch steps/u);
  assert.doesNotMatch(script, /uninstall it before installing the standalone runtime/u);
  assert.match(script, /Move-Item -LiteralPath \$payload -Destination \$stagedTarget/u);
  assert.match(script, /Move-Item -LiteralPath \$target -Destination \$backup/u);
  assert.match(script, /Move-Item -LiteralPath \$stagedTarget -Destination \$target/u);
  assert.match(script, /function Repair-rigynInterruptedStandaloneUninstall\(\[string\]\$InstallRoot\)/u);
  assert.match(script, /Repair-rigynInterruptedStandaloneUninstall \$rigynRoot/u);
  assert.match(script, /function Repair-rigynInterruptedInstall\(/u);
  assert.match(script, /Repair-rigynInterruptedInstall \$runtimeRoot \$launcherDirectory/u);
  assert.match(script, /\.rigyn-install-transaction\.json/u);
  for (const phase of ["prepared", "previous-isolated", "replacement-installed", "launcher-installed", "committed"]) {
    assert.match(script, new RegExp(`Write-rigynInstallTransaction \\$transactionPath \\$transactionRecord "${phase}"`, "u"));
  }
  assert.match(script, /\$createdScaffolds \+= \$destination/u);
  assert.match(script, /function Test-rigynScaffoldDestination\(\[string\]\$Path, \[string\]\$Label\)/u);
  assert.match(script, /\$Label must be a regular file: \$Path/u);
  assert.ok(script.indexOf("[void](Test-rigynScaffoldDestination $destination $scaffold.Label)")
    < script.indexOf('Write-rigynInstallTransaction $transactionPath $transactionRecord "prepared"'));
  assert.match(script, /Move-Item -LiteralPath \$launcherBackup -Destination \$launcher/u);
  assert.match(script, /\$launcherRestoreFailed = \$true/u);
  assert.match(script, /if \(-not \$launcherRestoreFailed -and \(Test-Path -LiteralPath \$launcherBackup\)\)/u);
  assert.match(script, /\$preservedBackups \+= \$launcherBackup/u);
  assert.match(script, /Move-Item -LiteralPath \$backup -Destination \$target/u);
  assert.match(script, /standalone installation \$failureKind failed\$\{backupNotice\}/u);
  assert.match(script, /the installed rigyn command failed its version check/u);
  assert.match(script, /\$installedVersion -cne \$version/u);
  assert.doesNotMatch(script, /Invoke-WebRequest/u);
  assert.match(script, /\[Net\.WebRequest\]::Create\(\$currentUri\)/u);
  assert.match(script, /function Test-rigynSecureAssetUri\(\[Uri\]\$Uri\)/u);
  assert.doesNotMatch(script, /Invoke-RestMethod/u);
  assert.match(script, /Get-rigynAsset \$latestReleaseApi \$latestReleasePath 1048576/u);
  assert.match(script, /\$rigynNetworkMaximumAttempts = 3/u);
  assert.match(script, /function Test-rigynTransientHttpStatus\(\[int\]\$StatusCode\)/u);
  assert.match(script, /\$StatusCode -in @\(408, 425, 429\)/u);
  assert.match(script, /\$StatusCode -ge 500 -and \$StatusCode -le 599/u);
  assert.match(script, /function Get-rigynRetryDelayMilliseconds\(\$Response, \[int\]\$Attempt\)/u);
  assert.match(script, /\$Response\.Headers\["Retry-After"\]/u);
  assert.match(script, /\[Math\]::Min\(\s*\$rigynNetworkRetryMaximumMilliseconds/u);
  assert.match(script, /function Get-rigynWebResponse\(\[Uri\]\$currentUri\)/u);
  assert.match(script, /\$timer = \[Diagnostics\.Stopwatch\]::StartNew\(\)/u);
  assert.match(script, /\$remainingMilliseconds = \$rigynNetworkTimeoutMilliseconds - \$timer\.ElapsedMilliseconds/u);
  assert.match(script, /\$request\.Timeout = \$requestTimeout/u);
  assert.doesNotMatch(script, /\$request\.Timeout = 300000/u);
  assert.match(script, /for \(\[int\]\$attempt = 1; \$attempt -le \$rigynNetworkMaximumAttempts; \$attempt \+= 1\)/u);
  assert.match(script, /Start-Sleep -Milliseconds \$delayMilliseconds/u);
  assert.match(script, /\$response\.Dispose\(\)[\s\S]{0,180}Start-Sleep -Milliseconds \$delayMilliseconds/u);
  assert.equal(script.match(/\$response = Get-rigynWebResponse \$currentUri/gu)?.length, 2);
  assert.match(script, /\$request\.AllowAutoRedirect = \$false/u);
  assert.doesNotMatch(script, /\$request\.AllowAutoRedirect = \$true/u);
  assert.match(script, /\$statusCode -in @\(301, 302, 303, 307, 308\)/u);
  assert.match(script, /\$nextUri = New-Object Uri\(\$currentUri, \$location\)/u);
  assert.match(script, /redirected asset URL must use HTTPS/u);
  assert.match(script, /\$declaredLength -eq 0 -or \$declaredLength -gt \$MaximumBytes/u);
  assert.match(script, /\$totalBytes \+ \$read -gt \$MaximumBytes/u);
  assert.match(script, /Remove-Item -LiteralPath \$Destination -Force -ErrorAction SilentlyContinue/u);
  assert.match(script, /\$lifecycleLease = Enter-rigynLifecycle \$rigynRoot/u);
  assert.match(script, /Exit-rigynLifecycle \$lifecycleLease/u);
  assert.ok(script.indexOf("Get-FileHash") < script.indexOf("-xzf $archivePath"));
  assert.ok(script.indexOf("$lifecycleLease = Enter-rigynLifecycle $rigynRoot")
    < script.indexOf("New-Item -ItemType Directory -Force -Path $rigynRoot"));
  assert.ok(script.indexOf("Move-Item -LiteralPath $payload -Destination $stagedTarget")
    < script.indexOf("Move-Item -LiteralPath $target -Destination $backup"));
  assert.ok(script.indexOf("Move-Item -LiteralPath $target -Destination $backup")
    < script.indexOf("Move-Item -LiteralPath $stagedTarget -Destination $target"));
  assert.ok(script.indexOf("Move-Item -LiteralPath $stagedTarget -Destination $target")
    < script.indexOf("Move-Item -LiteralPath $stagedLauncher -Destination $launcher -Force"));
  assert.ok(script.indexOf("Move-Item -LiteralPath $stagedLauncher -Destination $launcher -Force")
    < script.indexOf("$transactionCommitted = $true"));
  assert.doesNotMatch(script, /Get-Command (?:node|npm)|npmArguments|registry\.npmjs/u);
  if (process.platform === "win32") {
    const parsed = await runProcess("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[void][ScriptBlock]::Create([IO.File]::ReadAllText($env:RIGYN_TEST_SCRIPT))",
    ], { env: { ...process.env, RIGYN_TEST_SCRIPT: scriptPath } });
    assert.equal(parsed.code, 0, parsed.stderr);

    const patterns = await runProcess("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$contents = [IO.File]::ReadAllText($env:RIGYN_TEST_SCRIPT)",
        "$currentMatch = [Regex]::Match($contents, '(?m)^\\s*\\$managedLauncherPattern = ''([^'']+)''\\r?$')",
        "if (-not $currentMatch.Success) { throw 'launcher pattern was not found' }",
        "$currentPattern = $currentMatch.Groups[1].Value",
        "$tagMatch = [Regex]::Match($contents, '(?m)^\\s*\\$releaseTagPattern = ''([^'']+)''\\r?$')",
        "if (-not $tagMatch.Success) { throw 'release tag pattern was not found' }",
        "$tagPattern = $tagMatch.Groups[1].Value",
        "$unicodeDigit = [char]0x0661",
        '$current = "@echo off`r`nrem rigyn standalone managed command`r`n`"%USERPROFILE%\\.rigyn\\runtime\\rigyn-v9.8.7-win32-x64\\bin\\rigyn.cmd`" %*`r`n"',
        '$traversal = "@echo off`r`nrem rigyn standalone managed command`r`n`"%USERPROFILE%\\.rigyn\\runtime\\rigyn-v9.8.7-win32-x64\\..\\outside\\bin\\rigyn.cmd`" %*`r`n"',
        '$lookalike = "@echo off`r`nrem rigyn standalone managed command`r`n`"%USERPROFILE%\\.rigyn\\runtime\\rigyn-v09.8.7-win32-x64\\bin\\rigyn.cmd`" %*`r`n"',
        '$unicodeCurrent = "@echo off`r`nrem rigyn standalone managed command`r`n`"%USERPROFILE%\\.rigyn\\runtime\\rigyn-v$unicodeDigit.8.7-win32-x64\\bin\\rigyn.cmd`" %*`r`n"',
        "if ($current -notmatch $currentPattern) { throw 'current launcher did not match' }",
        "if ($traversal -match $currentPattern) { throw 'traversal launcher matched' }",
        "if ($lookalike -match $currentPattern) { throw 'lookalike launcher matched' }",
        "if ($unicodeCurrent -match $currentPattern) { throw 'Unicode digit launcher matched' }",
        'if ("v$unicodeDigit.8.7" -match $tagPattern) { throw "Unicode digit release tag matched" }',
      ].join("; "),
    ], { env: { ...process.env, RIGYN_TEST_SCRIPT: scriptPath } });
    assert.equal(patterns.code, 0, patterns.stderr);
  }
});

test("Windows PowerShell bootstrap rejects unsafe scaffold destinations before installing", {
  skip: process.platform !== "win32",
  timeout: 120_000,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bootstrap-windows-scaffold-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const assets = await createWindowsBootstrapAssets(root, "scaffold-assets");

  for (const name of ["AGENTS.md", "config.json"]) {
    for (const kind of ["directory", "junction"]) {
      const home = join(root, `${name.replace(".", "-")}-${kind}-home`);
      const agentDirectory = join(home, ".rigyn");
      const destination = join(agentDirectory, name);
      await mkdir(agentDirectory, { recursive: true });
      if (kind === "directory") {
        await mkdir(destination);
      } else {
        const target = join(root, `${name.replace(".", "-")}-junction-target`);
        await mkdir(target);
        await symlink(target, destination, "junction");
      }

      const result = await runWindowsBootstrap(root, home, assets);
      assert.notEqual(result.code, 0);
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        new RegExp(`${name === "AGENTS.md" ? "Agent instructions" : "Rigyn configuration"} must be a regular file`, "u"),
      );
      await assert.rejects(
        access(join(home, ".rigyn/runtime", assets.archiveRoot)),
        (error) => error?.code === "ENOENT",
      );
      const otherName = name === "AGENTS.md" ? "config.json" : "AGENTS.md";
      await assert.rejects(access(join(agentDirectory, otherName)), (error) => error?.code === "ENOENT");
    }
  }
});

test("Windows PowerShell bootstrap transaction executes success, rejection, and rollback paths", {
  skip: process.platform !== "win32",
  timeout: 120_000,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bootstrap-windows-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const healthy = await createWindowsBootstrapAssets(root, "healthy-assets");
  const broken = await createWindowsBootstrapAssets(root, "broken-assets", { brokenLauncher: true });

  const home = join(root, "fresh-home");
  await mkdir(home);
  const installed = await runWindowsBootstrap(root, home, healthy);
  assert.equal(installed.code, 0, installed.stderr);
  assert.match(installed.stdout, /verified GitHub standalone release/u);
  const runtimeRoot = join(home, ".rigyn/runtime");
  const runtime = join(runtimeRoot, healthy.archiveRoot);
  const launcherDirectory = join(home, ".rigyn/bin");
  const launcher = join(launcherDirectory, "rigyn.cmd");
  const expectedLauncher = [
    "@echo off",
    "rem rigyn standalone managed command",
    `"%USERPROFILE%\\.rigyn\\runtime\\${healthy.archiveRoot}\\bin\\rigyn.cmd" %*`,
    "",
  ].join("\r\n");
  assert.equal(await readFile(launcher, "utf8"), expectedLauncher);
  assert.equal(await readFile(join(runtime, "fixture.txt"), "utf8"), "healthy installation\n");
  assert.equal(
    await readFile(join(home, ".rigyn/AGENTS.md"), "utf8"),
    "",
  );
  assert.equal(await readFile(join(home, ".rigyn/config.json"), "utf8"), "{}\r\n");

  const runtimeLeases = join(home, ".rigyn/.runtime-leases");
  await mkdir(runtimeLeases);
  const acceptedEmptyLeases = await runWindowsBootstrap(root, home, healthy);
  assert.equal(acceptedEmptyLeases.code, 0, acceptedEmptyLeases.stderr);
  const activeLease = join(runtimeLeases, `${"a".repeat(32)}.json`);
  await writeFile(activeLease, standaloneRuntimeLease(join(home, ".rigyn"), process.pid));
  const rejectedActiveLeases = await runWindowsBootstrap(root, home, healthy);
  assert.notEqual(rejectedActiveLeases.code, 0);
  assert.match(
    `${rejectedActiveLeases.stdout}\n${rejectedActiveLeases.stderr}`,
    /close every running rigyn process/u,
  );
  await rm(activeLease);
  await writeFile(activeLease, standaloneRuntimeLease(join(home, ".rigyn"), 2_147_483_647));
  const acceptedStaleLease = await runWindowsBootstrap(root, home, healthy);
  assert.equal(acceptedStaleLease.code, 0, acceptedStaleLease.stderr);
  await assert.rejects(access(activeLease), (error) => error?.code === "ENOENT");

  const previousLauncher = await readFile(launcher);
  const previousRuntimeLauncher = await readFile(join(runtime, "bin/rigyn.cmd"));
  const previousMetadata = await readFile(join(runtime, "BUILD-METADATA.json"));
  const failedSmoke = await runWindowsBootstrap(root, home, broken);
  assert.notEqual(failedSmoke.code, 0);
  assert.match(
    `${failedSmoke.stdout}\n${failedSmoke.stderr}`,
    /installed rigyn command failed its version check/u,
  );
  assert.deepEqual(await readFile(launcher), previousLauncher);
  assert.deepEqual(await readFile(join(runtime, "bin/rigyn.cmd")), previousRuntimeLauncher);
  assert.deepEqual(await readFile(join(runtime, "BUILD-METADATA.json")), previousMetadata);
  assert.equal(await readFile(join(runtime, "fixture.txt"), "utf8"), "healthy installation\n");
  assert.deepEqual(
    (await readdir(runtimeRoot)).filter((entry) => entry.startsWith(".rigyn-")),
    [],
  );
  assert.deepEqual(
    (await readdir(launcherDirectory)).filter((entry) => entry.startsWith(".rigyn-")),
    [],
  );

  const sourceHome = join(root, "source-home");
  const sourceMarker = join(sourceHome, ".rigyn/.installation.json");
  await mkdir(dirname(sourceMarker), { recursive: true });
  await writeFile(sourceMarker, '{"owner":"source"}\r\n');
  const rejectedSource = await runWindowsBootstrap(root, sourceHome, healthy);
  assert.notEqual(rejectedSource.code, 0);
  assert.match(`${rejectedSource.stdout}\n${rejectedSource.stderr}`, /source-built installation owns/u);
  assert.equal(await readFile(sourceMarker, "utf8"), '{"owner":"source"}\r\n');
  await assert.rejects(access(join(sourceHome, ".rigyn/runtime")), (error) => error?.code === "ENOENT");
  await assert.rejects(access(join(sourceHome, ".rigyn/bin")), (error) => error?.code === "ENOENT");

  const restoreHome = join(root, "restore-home");
  await mkdir(restoreHome);
  const restoreInstalled = await runWindowsBootstrap(root, restoreHome, healthy);
  assert.equal(restoreInstalled.code, 0, restoreInstalled.stderr);
  const restoreLauncherDirectory = join(restoreHome, ".rigyn/bin");
  const restoreLauncher = join(restoreLauncherDirectory, "rigyn.cmd");
  const restoreLauncherContents = await readFile(restoreLauncher);
  const failedRestore = await runWindowsBootstrap(root, restoreHome, broken, {
    failLauncherRestore: true,
  });
  assert.notEqual(failedRestore.code, 0);
  assert.match(`${failedRestore.stdout}\n${failedRestore.stderr}`, /injected launcher restore failure/u);
  const launcherBackups = (await readdir(restoreLauncherDirectory))
    .filter((entry) => /^\.rigyn-[0-9a-f]+\.cmd\.previous$/iu);
  assert.equal(launcherBackups.length, 1);
  const launcherBackup = join(restoreLauncherDirectory, launcherBackups[0]);
  assert.deepEqual(await readFile(launcherBackup), restoreLauncherContents);
  const failedRestoreOutput = `${failedRestore.stdout}\n${failedRestore.stderr}`;
  assert.match(failedRestoreOutput, /backup preserved at/u);
  assert.ok(failedRestoreOutput.includes(basename(launcherBackup)));
  await assert.rejects(access(restoreLauncher), (error) => error?.code === "ENOENT");
  assert.equal(
    await readFile(join(restoreHome, ".rigyn/runtime", healthy.archiveRoot, "fixture.txt"), "utf8"),
    "healthy installation\n",
  );

});

test("Windows PowerShell bootstrap recovers hard termination at every replacement boundary", {
  skip: process.platform !== "win32",
  timeout: 240_000,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bootstrap-windows-crash-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const baseline = await createWindowsBootstrapAssets(root, "crash-baseline-assets");
  const replacement = await createWindowsBootstrapAssets(root, "crash-replacement-assets", {
    fixtureContents: "replacement installation\n",
  });
  const installerSource = (await readFile(join(REPOSITORY_ROOT, "install.ps1"), "utf8"))
    .replace(/\r\n?/gu, "\n");
  const boundaries = [
    "                Move-Item -LiteralPath $target -Destination $backup\n                Write-rigynInstallTransaction $transactionPath $transactionRecord \"previous-isolated\"",
    "            Move-Item -LiteralPath $stagedTarget -Destination $target\n            Write-rigynInstallTransaction $transactionPath $transactionRecord \"replacement-installed\"",
    "            Move-Item -LiteralPath $stagedLauncher -Destination $launcher -Force\n            Write-rigynInstallTransaction $transactionPath $transactionRecord \"launcher-installed\"",
  ];

  for (const [index, boundary] of boundaries.entries()) {
    const home = join(root, `crash-${index}-home`);
    await mkdir(home);
    const installed = await runWindowsBootstrap(root, home, baseline);
    assert.equal(installed.code, 0, installed.stderr);
    const injected = boundary.replace("\n", "\n            Stop-Process -Id $PID -Force\n");
    assert.equal(installerSource.split(boundary).length, 2, `crash boundary ${index} must be unique`);
    const crashInstaller = join(root, `install-crash-${index}.ps1`);
    await writeFile(crashInstaller, installerSource.replace(boundary, injected));
    const sentinel = join(root, `outside-${index}.txt`);
    await writeFile(sentinel, "outside\n");

    const crashed = await runWindowsBootstrap(root, home, replacement, { installer: crashInstaller });
    assert.notEqual(crashed.code, 0);
    const recovered = await runWindowsBootstrap(root, home, replacement);
    assert.equal(recovered.code, 0, recovered.stderr);

    const runtimeRoot = join(home, ".rigyn/runtime");
    const launcherDirectory = join(home, ".rigyn/bin");
    const runtime = join(runtimeRoot, replacement.archiveRoot);
    assert.equal(await readFile(join(runtime, "fixture.txt"), "utf8"), "replacement installation\n");
    assert.equal(await readFile(sentinel, "utf8"), "outside\n");
    assert.deepEqual(
      (await readdir(runtimeRoot)).filter((entry) => entry.startsWith(".rigyn-")),
      [],
    );
    assert.deepEqual(
      (await readdir(launcherDirectory)).filter((entry) => entry.startsWith(".rigyn-")),
      [],
    );
  }
});

test("Windows PowerShell bootstrap fails closed on unsafe durable transaction records", {
  skip: process.platform !== "win32",
  timeout: 240_000,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bootstrap-windows-unsafe-transaction-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const assets = await createWindowsBootstrapAssets(root, "unsafe-transaction-assets");
  const transactionId = "a".repeat(32);
  const invalidRecords = [
    "{malformed\n",
    "x".repeat(20_000),
    `${JSON.stringify({
      product: "rigyn",
      schemaVersion: 1,
      distribution: "standalone",
      phase: "prepared",
      runtime: assets.archiveRoot,
      stage: "..\\outside",
      backup: `.rigyn-backup-${transactionId}`,
      hadPrevious: true,
      launcherStage: `.rigyn-${transactionId}.cmd`,
      launcherBackup: `.rigyn-${transactionId}.cmd.previous`,
      launcherHadPrevious: true,
    })}\n`,
  ];

  for (const [index, contents] of invalidRecords.entries()) {
    const home = join(root, `unsafe-${index}-home`);
    await mkdir(home);
    const installed = await runWindowsBootstrap(root, home, assets);
    assert.equal(installed.code, 0, installed.stderr);
    const runtime = join(home, ".rigyn/runtime", assets.archiveRoot);
    const launcher = join(home, ".rigyn/bin/rigyn.cmd");
    const runtimeBefore = await readFile(join(runtime, "fixture.txt"));
    const launcherBefore = await readFile(launcher);
    const record = join(home, ".rigyn/runtime/.rigyn-install-transaction.json");
    const sentinel = join(root, `unsafe-outside-${index}.txt`);
    await Promise.all([writeFile(record, contents), writeFile(sentinel, "outside\n")]);

    const rejected = await runWindowsBootstrap(root, home, assets);
    assert.notEqual(rejected.code, 0);
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /transaction is (?:invalid|unsafe)/u);
    assert.deepEqual(await readFile(join(runtime, "fixture.txt")), runtimeBefore);
    assert.deepEqual(await readFile(launcher), launcherBefore);
    assert.equal(await readFile(sentinel, "utf8"), "outside\n");
    await access(record);
  }
});

test("Windows PowerShell bootstrap repairs durable deferred-uninstall states", {
  skip: process.platform !== "win32",
  timeout: 240_000,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bootstrap-windows-uninstall-recovery-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const assets = await createWindowsBootstrapAssets(root, "uninstall-recovery-assets");

  for (const phase of ["prepared", "isolated", "removed"]) {
    const home = join(root, `${phase}-home`);
    await mkdir(home);
    const installRoot = join(home, ".rigyn");
    if (phase !== "removed") {
      const installed = await runWindowsBootstrap(root, home, assets);
      assert.equal(installed.code, 0, installed.stderr);
    }
    const token = phase.repeat(64).slice(0, 64).replace(/[^a-f0-9]/gu, "a");
    const tokenFile = `.standalone-uninstall-${token}`;
    const tombstone = `${installRoot}.uninstalling-4321-${token}`;
    if (phase !== "removed") await writeFile(join(installRoot, tokenFile), token);
    const recordPath = `${installRoot}.uninstall.json`;
    await writeFile(recordPath, `${JSON.stringify({
      product: "rigyn",
      schemaVersion: 1,
      distribution: "standalone",
      phase,
      installRoot: resolve(installRoot),
      tombstone: resolve(tombstone),
      tokenFile,
      tokenSha256: createHash("sha256").update(token).digest("hex"),
    })}\n`);
    if (phase === "isolated") await rename(installRoot, tombstone);

    const recovered = await runWindowsBootstrap(root, home, assets);
    assert.equal(recovered.code, 0, recovered.stderr);
    await assert.rejects(access(recordPath), { code: "ENOENT" });
    await assert.rejects(access(tombstone), { code: "ENOENT" });
    await assert.rejects(access(join(installRoot, tokenFile)), { code: "ENOENT" });
    assert.equal(
      await readFile(join(installRoot, "runtime", assets.archiveRoot, "fixture.txt"), "utf8"),
      "healthy installation\n",
    );
  }
});

test("Windows npm invocation resolves npm-cli beside Node without a command shell", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-windows-npm-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const execPath = join(root, "node.exe");
  const npmCli = join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
  await mkdir(dirname(npmCli), { recursive: true });
  await writeFile(npmCli, "");

  assert.deepEqual(
    await resolveNpmInvocation(["install", "archive.tgz"], {
      platform: "win32",
      execPath,
      environment: {},
    }),
    {
      command: execPath,
      args: [resolve(npmCli), "install", "archive.tgz"],
    },
  );
});

test("path containment rejects Windows cross-drive candidates deterministically", () => {
  assert.equal(inside("C:\\Users\\alice\\.rigyn", "C:\\Users\\alice\\.rigyn\\current"), true);
  assert.equal(inside("C:\\Users\\alice\\.rigyn", "C:\\Users\\alice\\source"), false);
  assert.equal(inside("C:\\Users\\alice\\.rigyn", "D:\\rigyn"), false);
});

test("lifecycle path identity folds Windows casing and preserves POSIX casing", () => {
  assert.equal(
    sameLifecyclePath("C:\\Users\\Alice\\.rigyn", "c:\\users\\ALICE\\.rigyn", "win32"),
    true,
  );
  assert.equal(sameLifecyclePath("/home/Alice/.rigyn", "/home/alice/.rigyn", "linux"), false);
});

test("install marker and launcher ownership use platform path identity", async () => {
  const installRoot = resolve(join(tmpdir(), "rigyn-lifecycle-path-identity"));
  const marker = createInstallationMarker(installRoot, "0.1.0", {
    launcher: "launcher",
    command: "command",
  });
  const swapCase = (value) => value.replace(/[A-Za-z]/gu, (character) => (
    character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase()
  ));
  const caseVariant = {
    ...marker,
    installRoot: swapCase(marker.installRoot),
    launcherPath: swapCase(marker.launcherPath),
    commandLink: swapCase(marker.commandLink),
  };

  if (process.platform === "win32") {
    assert.doesNotThrow(() => parseInstallationMarker(caseVariant, installRoot));
    await assert.doesNotReject(assertOwnedLaunchers(installRoot, caseVariant, { allowMissing: true }));
  } else {
    assert.throws(
      () => parseInstallationMarker(caseVariant, installRoot),
      /Install marker paths do not match this installation/u,
    );
    await assert.rejects(
      assertOwnedLaunchers(installRoot, caseVariant, { allowMissing: true }),
      /Install marker command path does not match this installation/u,
    );
  }
});

test("Windows lifecycle termination uses a bounded absolute taskkill tree command", () => {
  assert.deepEqual(
    lifecycleProcessTreeTerminationPlan(4321, "SIGTERM", {
      platform: "win32",
      environment: { SystemRoot: "C:\\Windows" },
    }),
    {
      kind: "taskkill",
      command: "C:\\Windows\\System32\\taskkill.exe",
      args: ["/PID", "4321", "/T", "/F"],
      fallbackPid: 4321,
      fallbackSignal: "SIGTERM",
    },
  );

  const calls = [];
  assert.equal(terminateLifecycleProcessTree(4321, "SIGTERM", {
    platform: "win32",
    environment: { WINDIR: "D:\\Windows" },
    spawnSync(command, args, options) {
      calls.push([command, [...args], options]);
      return { status: 0 };
    },
    kill() { assert.fail("direct fallback must not run after taskkill succeeds"); },
  }), true);
  assert.deepEqual(calls, [[
    "D:\\Windows\\System32\\taskkill.exe",
    ["/PID", "4321", "/T", "/F"],
    { shell: false, stdio: "ignore", timeout: 2_000, windowsHide: true },
  ]]);
});

test("Windows lifecycle termination falls back to the direct child after taskkill fails", () => {
  const killed = [];
  assert.equal(terminateLifecycleProcessTree(7654, "SIGINT", {
    platform: "win32",
    environment: { SystemRoot: "C:\\Windows" },
    spawnSync() { return { status: 1 }; },
    kill(pid, signal) { killed.push([pid, signal]); },
  }), true);
  assert.deepEqual(killed, [[7654, "SIGINT"]]);
});

test("Windows lifecycle termination kills a spawned parent and grandchild", {
  skip: process.platform !== "win32",
  timeout: 10_000,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-lifecycle-tree-"));
  const survived = join(root, "grandchild-survived");
  const grandchildProgram = [
    `const { writeFileSync } = require("node:fs")`,
    `setTimeout(() => writeFileSync(${JSON.stringify(survived)}, "survived"), 1_500)`,
    `setInterval(() => {}, 1_000)`,
  ].join(";");
  const parentProgram = [
    `const { spawn } = require("node:child_process")`,
    `const { writeFileSync } = require("node:fs")`,
    `const child = spawn(process.execPath, ["--eval", ${JSON.stringify(grandchildProgram)}], { stdio: "ignore", windowsHide: true })`,
    `child.once("spawn", () => writeFileSync(1, "ready\\n"))`,
    `setInterval(() => {}, 1_000)`,
  ].join(";");
  const parent = spawn(process.execPath, ["--eval", parentProgram], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  context.after(async () => {
    if (parent.pid !== undefined && parent.exitCode === null) {
      terminateLifecycleProcessTree(parent.pid, "SIGKILL");
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  let stdout = "";
  let stderr = "";
  parent.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  parent.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error(`lifecycle fixture did not become ready: ${stderr}`)), 5_000);
    parent.stdout.on("data", () => {
      if (!stdout.includes("ready\n")) return;
      clearTimeout(timeout);
      resolveReady();
    });
    parent.once("error", reject);
    parent.once("close", (code) => reject(new Error(`lifecycle fixture exited before termination with ${code}: ${stderr}`)));
  });
  const closed = new Promise((resolveClose, reject) => {
    const timeout = setTimeout(() => reject(new Error("lifecycle fixture did not terminate")), 5_000);
    parent.once("close", (code) => {
      clearTimeout(timeout);
      resolveClose(code);
    });
  });
  assert.equal(terminateLifecycleProcessTree(parent.pid, "SIGTERM"), true);
  await closed;
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_750));
  await assert.rejects(access(survived), { code: "ENOENT" });
});

test("bounded release commands stop noisy subprocess trees at the output limit", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bounded-output-"));
  const survived = join(root, "grandchild-survived");
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const grandchildProgram = [
    `const { writeFileSync } = require("node:fs")`,
    `setTimeout(() => writeFileSync(${JSON.stringify(survived)}, "survived"), 1_200)`,
    `setInterval(() => {}, 1_000)`,
  ].join(";");
  const parentProgram = [
    `const { spawn } = require("node:child_process")`,
    `const { writeFileSync } = require("node:fs")`,
    `spawn(process.execPath, ["--eval", ${JSON.stringify(grandchildProgram)}], { stdio: "ignore", windowsHide: true })`,
    `const chunk = Buffer.alloc(16 * 1024, 120)`,
    `setInterval(() => writeFileSync(1, chunk), 1)`,
  ].join(";");

  await assert.rejects(
    runBoundedCommand(process.execPath, ["--eval", parentProgram], {
      cwd: PROJECT_ROOT,
      env: process.env,
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
      outputPollMs: 5,
      label: "noisy release fixture",
    }),
    /noisy release fixture output exceeded 65536 bytes/u,
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_400));
  await assert.rejects(access(survived), { code: "ENOENT" });
});

test("bounded release commands clean up same-group children after a successful parent exit", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bounded-success-child-"));
  const survived = join(root, "grandchild-survived");
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const grandchildProgram = [
    `const { writeFileSync } = require("node:fs")`,
    `setTimeout(() => writeFileSync(${JSON.stringify(survived)}, "survived"), 1_200)`,
    `setInterval(() => {}, 1_000)`,
  ].join(";");
  const parentProgram = [
    `const { spawn } = require("node:child_process")`,
    `const child = spawn(process.execPath, ["--eval", ${JSON.stringify(grandchildProgram)}], { stdio: "ignore", windowsHide: true })`,
    `child.unref()`,
  ].join(";");

  await runBoundedCommand(process.execPath, ["--eval", parentProgram], {
    cwd: PROJECT_ROOT,
    env: process.env,
    timeoutMs: 5_000,
    maxOutputBytes: 64 * 1024,
    outputPollMs: 5,
    label: "successful release fixture",
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_400));
  await assert.rejects(access(survived), { code: "ENOENT" });
});

test("bounded release command timeouts stop the entire subprocess tree", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bounded-timeout-"));
  const survived = join(root, "grandchild-survived");
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const grandchildProgram = [
    `const { writeFileSync } = require("node:fs")`,
    `setTimeout(() => writeFileSync(${JSON.stringify(survived)}, "survived"), 1_200)`,
    `setInterval(() => {}, 1_000)`,
  ].join(";");
  const parentProgram = [
    `const { spawn } = require("node:child_process")`,
    `spawn(process.execPath, ["--eval", ${JSON.stringify(grandchildProgram)}], { stdio: "ignore", windowsHide: true })`,
    `setInterval(() => {}, 1_000)`,
  ].join(";");

  await assert.rejects(
    runBoundedCommand(process.execPath, ["--eval", parentProgram], {
      cwd: PROJECT_ROOT,
      env: process.env,
      timeoutMs: 300,
      maxOutputBytes: 64 * 1024,
      outputPollMs: 5,
      label: "timed release fixture",
    }),
    /timed release fixture timed out after 300 ms/u,
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_400));
  await assert.rejects(access(survived), { code: "ENOENT" });
});

test("bounded release command timeouts stop Linux descendants that escape the command process group", {
  skip: process.platform !== "linux",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bounded-detached-timeout-"));
  const survived = join(root, "grandchild-survived");
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const grandchildProgram = [
    `const { writeFileSync } = require("node:fs")`,
    `setTimeout(() => writeFileSync(${JSON.stringify(survived)}, "survived"), 1_200)`,
    `setInterval(() => {}, 1_000)`,
  ].join(";");
  const parentProgram = [
    `const { spawn } = require("node:child_process")`,
    `const child = spawn(process.execPath, ["--eval", ${JSON.stringify(grandchildProgram)}], { detached: true, stdio: "ignore", windowsHide: true })`,
    `child.unref()`,
    `setInterval(() => {}, 1_000)`,
  ].join(";");

  await assert.rejects(
    runBoundedCommand(process.execPath, ["--eval", parentProgram], {
      cwd: PROJECT_ROOT,
      env: process.env,
      timeoutMs: 300,
      maxOutputBytes: 64 * 1024,
      outputPollMs: 5,
      label: "detached release fixture",
    }),
    /detached release fixture timed out after 300 ms/u,
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_400));
  await assert.rejects(access(survived), { code: "ENOENT" });
});

test("bounded release commands forward parent termination and clean up their process group", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bounded-parent-signal-"));
  const ready = join(root, "ready");
  const survived = join(root, "grandchild-survived");
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const grandchildProgram = [
    `const { writeFileSync } = require("node:fs")`,
    `setTimeout(() => writeFileSync(${JSON.stringify(survived)}, "survived"), 1_200)`,
    `setInterval(() => {}, 1_000)`,
  ].join(";");
  const commandProgram = [
    `const { spawn } = require("node:child_process")`,
    `const { writeFileSync } = require("node:fs")`,
    `spawn(process.execPath, ["--eval", ${JSON.stringify(grandchildProgram)}], { stdio: "ignore", windowsHide: true })`,
    `writeFileSync(${JSON.stringify(ready)}, "ready")`,
    `setInterval(() => {}, 1_000)`,
  ].join(";");
  const helperUrl = pathToFileURL(join(REPOSITORY_ROOT, "scripts", "bounded-command.mjs")).href;
  const wrapperProgram = [
    `import { runBoundedCommand } from ${JSON.stringify(helperUrl)}`,
    `import { writeFileSync } from "node:fs"`,
    `try { await runBoundedCommand(process.execPath, ["--eval", ${JSON.stringify(commandProgram)}], { cwd: ${JSON.stringify(PROJECT_ROOT)}, env: process.env, timeoutMs: 10_000, maxOutputBytes: 65_536, outputPollMs: 5, label: "signalled release fixture" }) } catch (error) { writeFileSync(2, (error instanceof Error ? error.message : String(error)) + "\\n"); process.exitCode = 1 }`,
  ].join(";");
  const wrapper = spawn(process.execPath, ["--input-type=module", "--eval", wrapperProgram], {
    cwd: PROJECT_ROOT,
    shell: false,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let diagnostic = "";
  wrapper.stderr.on("data", (chunk) => { diagnostic += chunk.toString("utf8"); });
  await waitForFile(ready).catch((error) => {
    throw new Error(`${error instanceof Error ? error.message : String(error)}${diagnostic === "" ? "" : `: ${diagnostic}`}`);
  });
  assert.equal(wrapper.kill("SIGTERM"), true);
  const result = await new Promise((resolveClose, reject) => {
    const timeout = setTimeout(() => reject(new Error("signalled release wrapper did not exit")), 5_000);
    wrapper.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveClose({ code, signal });
    });
    wrapper.once("error", reject);
  });
  assert.deepEqual(result, { code: 1, signal: null });
  assert.match(diagnostic, /interrupted by SIGTERM/u);
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_400));
  await assert.rejects(access(survived), { code: "ENOENT" });
});

test("a timed-out Windows standalone uninstall reaps its broker tree and removes handoff artifacts", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-windows-uninstall-timeout-"));
  const installRoot = join(root, "install");
  const helperRoot = join(root, "helpers");
  const powershell = join(root, "powershell.exe");
  context.after(async () => await rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(installRoot, { recursive: true }),
    mkdir(helperRoot, { recursive: true }),
    writeFile(powershell, "fixture\n"),
  ]);

  const child = new EventEmitter();
  child.pid = 4_321;
  child.kill = () => true;
  const calls = [];
  const spawnProcess = () => {
    setImmediate(() => child.emit("spawn"));
    return child;
  };
  const terminateProcessTree = (pid, signal) => {
    calls.push({ pid, signal });
    setImmediate(() => child.emit("close", null, signal));
    return true;
  };

  await assert.rejects(
    uninstallWindows({
      environment: { SystemRoot: root },
      installRoot,
      powershell,
      temporaryDirectory: helperRoot,
      spawnProcess,
      terminateProcessTree,
      startupTimeoutMs: 20,
      reaperTimeoutMs: 1_000,
    }),
    /did not start within 20 ms/u,
  );
  assert.deepEqual(calls, [{ pid: child.pid, signal: "SIGKILL" }]);
  assert.deepEqual(await readdir(installRoot), []);
  assert.deepEqual(await readdir(helperRoot), []);
});

test("a failed Windows standalone uninstall reports bounded sanitized broker diagnostics", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-windows-uninstall-diagnostic-"));
  const installRoot = join(root, "install");
  const helperRoot = join(root, "helpers");
  const powershell = join(root, "powershell.exe");
  context.after(async () => await rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(installRoot, { recursive: true }),
    mkdir(helperRoot, { recursive: true }),
    writeFile(powershell, "fixture\n"),
  ]);

  const child = new EventEmitter();
  child.pid = 4_323;
  child.kill = () => true;
  child.stderr = new EventEmitter();
  const lifecycleToken = "f".repeat(32);
  const spawnProcess = (_command, _argumentsValue, options) => {
    assert.deepEqual(options.stdio, ["ignore", "ignore", "pipe"]);
    setImmediate(() => {
      child.emit("spawn");
      child.stderr.emit("data", Buffer.from(
        `${"discarded ".repeat(2_000)}broker failed for ${lifecycleToken}\u001b[31m`,
      ));
      child.emit("close", 1, null);
    });
    return child;
  };

  await assert.rejects(
    uninstallWindows({
      environment: { SystemRoot: root },
      installRoot,
      powershell,
      temporaryDirectory: helperRoot,
      spawnProcess,
      lifecycleLock: { path: `${installRoot}.lifecycle.lock`, token: lifecycleToken },
      startupTimeoutMs: 1_000,
    }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /exited before startup with code 1: .*broker failed for \[redacted\]/u);
      assert.doesNotMatch(error.message, new RegExp(lifecycleToken, "u"));
      assert.doesNotMatch(error.message, /\u001b/u);
      assert.ok(Buffer.byteLength(error.message, "utf8") < 9_000);
      return true;
    },
  );
  assert.deepEqual(await readdir(installRoot), []);
  assert.deepEqual(await readdir(helperRoot), []);
});

test("a Windows standalone uninstall accepts scheduling only after durable recovery state exists", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-windows-uninstall-handoff-"));
  const installRoot = join(root, "install");
  const helperRoot = join(root, "helpers");
  const powershell = join(root, "powershell.exe");
  context.after(async () => await rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(installRoot, { recursive: true }),
    mkdir(helperRoot, { recursive: true }),
    writeFile(powershell, "fixture\n"),
  ]);

  const child = new EventEmitter();
  child.pid = 4_322;
  let readyPath;
  let recordPath;
  let tokenPath;
  let brokerBootstrap;
  let workerStartupTimeout;
  const spawnProcess = (_command, argumentsValue, options) => {
    readyPath = options.env.RIGYN_UNINSTALL_READY;
    recordPath = options.env.RIGYN_UNINSTALL_RECORD;
    tokenPath = options.env.RIGYN_UNINSTALL_TOKEN_PATH;
    workerStartupTimeout = options.env.RIGYN_UNINSTALL_WORKER_STARTUP_TIMEOUT_MS;
    brokerBootstrap = Buffer.from(argumentsValue.at(-1), "base64").toString("utf16le");
    setImmediate(() => {
      child.emit("spawn");
      void writeFile(readyPath, "ready").then(
        () => child.emit("close", 1, null),
        (error) => child.emit("error", error),
      );
    });
    return child;
  };

  await uninstallWindows({
    environment: { SystemRoot: root },
    installRoot,
    powershell,
    temporaryDirectory: helperRoot,
    spawnProcess,
    startupTimeoutMs: 1_000,
  });
  assert.equal(workerStartupTimeout, "30000");
  assert.match(brokerBootstrap, /RIGYN_UNINSTALL_WORKER_STARTUP_TIMEOUT_MS/u);
  await assert.rejects(access(readyPath), { code: "ENOENT" });
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  assert.equal(record.phase, "prepared");
  assert.equal(record.installRoot, resolve(installRoot));
  assert.equal(record.tombstone.startsWith(`${resolve(installRoot)}.uninstalling-`), true);
  assert.equal(record.tokenFile, basename(tokenPath));
  assert.match(record.tokenSha256, /^[a-f0-9]{64}$/u);
  await access(tokenPath);
});

test("release staging refuses a markerless output without deleting it", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-release-output-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const output = join(root, "foreign-output");
  const sentinel = join(output, "keep.txt");
  await mkdir(output, { recursive: true });
  await writeFile(sentinel, "keep\n");

  const result = await runNode([
    join(REPOSITORY_ROOT, "scripts", "stage-release.mjs"),
    "--output",
    output,
  ], { reject: true });

  assert.match(result.stderr, /Refusing to replace an unowned release output/u);
  assert.equal(await readFile(sentinel, "utf8"), "keep\n");
  await assert.rejects(access(`${output}.lifecycle.lock`), { code: "ENOENT" });
});

test("lifecycle operations serialize across processes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-lifecycle-lock-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const installRoot = join(root, "install");
  const common = pathToFileURL(join(PROJECT_ROOT, "scripts", "lifecycle-common.mjs")).href;
  const program = [
    `import { withLifecycleLock } from ${JSON.stringify(common)}`,
    `import { writeFileSync } from "node:fs"`,
    "const [root, name, delay] = process.argv.slice(1)",
    "await withLifecycleLock(root, async () => { writeFileSync(1, name + '\\n'); await new Promise((resolve) => setTimeout(resolve, Number(delay))) })",
  ].join(";");
  const first = spawn(process.execPath, ["--input-type=module", "--eval", program, installRoot, "first", "400"], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let firstOutput = "";
  first.stdout.on("data", (chunk) => { firstOutput += chunk.toString("utf8"); });
  await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error("first lifecycle process did not acquire the lock")), 5_000);
    first.stdout.on("data", () => {
      if (!firstOutput.includes("first\n")) return;
      clearTimeout(timeout);
      resolveReady();
    });
    first.once("error", reject);
  });

  const second = spawn(process.execPath, ["--input-type=module", "--eval", program, installRoot, "second", "0"], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let secondOutput = "";
  second.stdout.on("data", (chunk) => { secondOutput += chunk.toString("utf8"); });
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.equal(secondOutput, "", "the second operation must wait for the first lock holder");
  const [firstCode, secondCode] = await Promise.all([
    new Promise((resolve) => first.once("close", resolve)),
    new Promise((resolve) => second.once("close", resolve)),
  ]);
  assert.equal(firstCode, 0);
  assert.equal(secondCode, 0);
  assert.equal(secondOutput, "second\n");
  await assert.rejects(access(`${installRoot}.lifecycle.lock`), { code: "ENOENT" });
});

test("managed credential purge preparation separates service identity from relocated state", async () => {
  const installRoot = resolve("fixture-install-root");
  const stateInstallRoot = `${installRoot}.uninstalling`;
  const calls = [];
  const purge = await prepareManagedCredentialPurge(installRoot, {
    stateInstallRoot,
    prepare: async (authPath, options) => {
      calls.push(["prepare", authPath, options.stateAuthPath, options.keychainLockPath]);
      const prepared = async () => { calls.push(["purge"]); };
      prepared.dispose = async () => { calls.push(["dispose"]); };
      return prepared;
    },
  });
  assert.deepEqual(calls, [[
    "prepare",
    join(installRoot, "auth.json"),
    join(stateInstallRoot, "auth.json"),
    `${installRoot}.credential-purge.lock`,
  ]]);
  await purge();
  assert.deepEqual(calls.at(-1), ["purge"]);
  await purge.dispose();
  await purge.dispose();
  assert.deepEqual(calls.at(-1), ["dispose"]);
  assert.equal(calls.filter(([operation]) => operation === "dispose").length, 1);

  await assert.rejects(
    prepareManagedCredentialPurge(installRoot, {
      prepare: async () => { throw new Error("credential backend unavailable"); },
    }),
    /credential backend unavailable/u,
  );
});

test("uninstall preserves both transaction and credential-purge cleanup failures", async () => {
  const transactionError = new Error("transaction failed");
  const cleanupError = new Error("cleanup failed");
  const purge = async () => undefined;
  purge.dispose = async () => { throw cleanupError; };

  await assert.rejects(
    withCredentialPurgeDisposal(purge, async () => { throw transactionError; }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /Uninstall failed and credential purge cleanup was incomplete/u);
      assert.deepEqual(error.errors, [transactionError, cleanupError]);
      return true;
    },
  );
});

test("managed tool output purge enforces POSIX ownership and private mode", {
  skip: process.platform === "win32" || typeof process.getuid !== "function",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-tool-output-purge-posix-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const uid = process.getuid();
  const directory = managedToolOutputDirectory({ temporaryDirectory: root, uid });
  const output = join(directory, "rigyn-bash-0123456789abcdef.log");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(output, "private output\n", { mode: 0o600 });
  await chmod(directory, 0o755);

  await assert.rejects(
    purgeManagedToolOutput({ platform: "linux", temporaryDirectory: root, uid }),
    /directory is not private/u,
  );
  assert.equal(await readFile(output, "utf8"), "private output\n");
  await chmod(directory, 0o700);
  await chmod(output, 0o644);
  await assert.rejects(
    purgeManagedToolOutput({ platform: "linux", temporaryDirectory: root, uid }),
    /entry is not private/u,
  );
  assert.equal(await readFile(output, "utf8"), "private output\n");
  await chmod(output, 0o600);

  const foreignUid = uid + 1;
  const foreignDirectory = managedToolOutputDirectory({ temporaryDirectory: root, uid: foreignUid });
  await mkdir(foreignDirectory, { mode: 0o700 });
  await writeFile(join(foreignDirectory, "rigyn-bash-fedcba9876543210.log"), "foreign output\n", { mode: 0o600 });
  await assert.rejects(
    purgeManagedToolOutput({ platform: "linux", temporaryDirectory: root, uid: foreignUid }),
    /directory is not owned by the current user/u,
  );

  assert.deepEqual(
    await purgeManagedToolOutput({ platform: "linux", temporaryDirectory: root, uid }),
    { directory, removedFiles: 1 },
  );
  await assert.rejects(access(directory), { code: "ENOENT" });
  assert.equal(
    await readFile(join(foreignDirectory, "rigyn-bash-fedcba9876543210.log"), "utf8"),
    "foreign output\n",
  );
});

test("installed tool output cleanup is rooted in the exact installation tmp directory", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-tool-output-install-scope-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const firstInstall = join(root, "first");
  const secondInstall = join(root, "second");
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const first = managedToolOutputDirectory({ installRoot: firstInstall, uid });
  const second = managedToolOutputDirectory({ installRoot: secondInstall, uid });
  await mkdir(first, { recursive: true, mode: 0o700 });
  await mkdir(second, { recursive: true, mode: 0o700 });
  await writeFile(join(first, "rigyn-bash-0123456789abcdef.log"), "first\n", { mode: 0o600 });
  await writeFile(join(second, "rigyn-bash-fedcba9876543210.log"), "second\n", { mode: 0o600 });

  await purgeManagedToolOutput({ installRoot: firstInstall, uid });

  await assert.rejects(access(first), { code: "ENOENT" });
  assert.equal(await readFile(join(second, "rigyn-bash-fedcba9876543210.log"), "utf8"), "second\n");
  assert.equal(first.startsWith(join(firstInstall, "tmp")), true);
  assert.equal(second.startsWith(join(secondInstall, "tmp")), true);
});

test("installed tool output cleanup rejects a linked tmp ancestor without touching its target", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-tool-output-linked-tmp-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const firstInstall = join(root, "first");
  const secondInstall = join(root, "second");
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  await mkdir(firstInstall, { mode: 0o700 });
  await mkdir(join(secondInstall, "tmp"), { recursive: true, mode: 0o700 });
  const secondDirectory = managedToolOutputDirectory({ installRoot: secondInstall, uid });
  const sentinel = join(secondDirectory, "rigyn-bash-0123456789abcdef.log");
  await mkdir(secondDirectory, { mode: 0o700 });
  await writeFile(sentinel, "keep\n", { mode: 0o600 });
  await symlink(join(secondInstall, "tmp"), join(firstInstall, "tmp"), process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    purgeManagedToolOutput({ installRoot: firstInstall, uid }),
    /installation tmp path must be a real directory/u,
  );
  assert.equal(await readFile(sentinel, "utf8"), "keep\n");
});

test("installed tool output cleanup is a no-op when the validated installation has no tmp directory", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-tool-output-no-tmp-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const installRoot = join(root, "install");
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  await mkdir(installRoot, { mode: 0o700 });

  assert.deepEqual(await purgeManagedToolOutput({ installRoot, uid }), {
    directory: managedToolOutputDirectory({ installRoot, uid }),
    removedFiles: 0,
  });
});

test("managed tool output purge refuses a live active file from another process", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-tool-output-live-active-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const directory = managedToolOutputDirectory({ temporaryDirectory: root, uid });
  const child = spawn(process.execPath, ["--eval", "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"]);
  context.after(() => child.kill());
  await new Promise((resolveReady, reject) => {
    child.stdout.once("data", resolveReady);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`active spill owner exited early: ${code}`)));
  });
  assert.equal(typeof child.pid, "number");
  const active = join(
    directory,
    `.rigyn-active-${child.pid}-67108864-${"c".repeat(32)}-rigyn-bash-${"3".repeat(16)}.log.part`,
  );
  await mkdir(directory, { mode: 0o700 });
  await writeFile(active, "active\n", { mode: 0o600 });

  await assert.rejects(
    purgeManagedToolOutput({ temporaryDirectory: root, uid }),
    /active output owner is live or indeterminate/u,
  );
  assert.equal(await readFile(active, "utf8"), "active\n");
  child.kill();
  await new Promise((resolveExit) => child.once("exit", resolveExit));
  assert.deepEqual(await purgeManagedToolOutput({ temporaryDirectory: root, uid }), {
    directory,
    removedFiles: 1,
  });
});

test("managed tool output purge reaps only definitely dead exact retention locks", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-tool-output-lock-purge-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const options = { platform: "win32", temporaryDirectory: root, uid: undefined };
  const directory = managedToolOutputDirectory(options);
  const lock = join(directory, ".rigyn-retention.lock");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(lock, `${JSON.stringify({ pid: process.pid, token: "a".repeat(32) })}\n`, { mode: 0o600 });

  await assert.rejects(purgeManagedToolOutput(options), /owner is live or indeterminate/u);
  await writeFile(lock, `${JSON.stringify({ pid: 2147483647, token: "b".repeat(32) })}\n`, { mode: 0o600 });

  assert.deepEqual(await purgeManagedToolOutput(options), { directory, removedFiles: 0 });
  await assert.rejects(access(directory), { code: "ENOENT" });

  await mkdir(directory, { mode: 0o700 });
  const staged = join(directory, `.rigyn-retention-owner-2147483647-${"c".repeat(32)}.tmp`);
  await writeFile(staged, "{", { mode: 0o600 });
  assert.deepEqual(await purgeManagedToolOutput(options), { directory, removedFiles: 0 });
  await assert.rejects(access(directory), { code: "ENOENT" });
});

test("managed tool output purge rejects unsafe targets and supports Windows identity semantics", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-tool-output-purge-windows-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const options = { platform: "win32", temporaryDirectory: root, uid: undefined };
  const directory = managedToolOutputDirectory(options);
  const outside = join(root, "outside");
  const sentinel = join(outside, "keep.txt");
  await mkdir(outside);
  await writeFile(sentinel, "keep\n");
  await symlink(outside, directory, process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(purgeManagedToolOutput(options), /must be a real directory/u);
  assert.equal(await readFile(sentinel, "utf8"), "keep\n");
  await rm(directory, { force: true });
  await mkdir(directory, { mode: 0o700 });
  const valid = join(directory, "rigyn-bash-0123456789abcdef.log");
  const unexpected = join(directory, "foreign.log");
  await Promise.all([
    writeFile(valid, "private output\n", { mode: 0o600 }),
    writeFile(unexpected, "foreign output\n", { mode: 0o600 }),
  ]);

  await assert.rejects(purgeManagedToolOutput(options), /contains an unrecognized entry/u);
  assert.equal(await readFile(valid, "utf8"), "private output\n");
  assert.equal(await readFile(unexpected, "utf8"), "foreign output\n");
  await rm(unexpected);
  await rm(valid);
  await mkdir(valid);
  await assert.rejects(purgeManagedToolOutput(options), /entry must be a real file/u);
  await rm(valid, { recursive: true });
  await writeFile(valid, "private output\n", { mode: 0o600 });

  assert.deepEqual(await purgeManagedToolOutput(options), { directory, removedFiles: 1 });
  await assert.rejects(access(directory), { code: "ENOENT" });
  assert.equal(await readFile(sentinel, "utf8"), "keep\n");
});

test("source uninstall commits prepared credential purge only after local removal", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-source-uninstall-purge-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const installRoot = join(root, ".rigyn");
  const command = join(root, "bin", "rigyn");
  const recordPath = `${installRoot}.uninstall.json`;
  const tombstone = `${installRoot}.uninstalling`;
  const commandContents = "managed command\n";
  await Promise.all([
    mkdir(installRoot, { recursive: true }),
    mkdir(dirname(command), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(installRoot, "sentinel"), "installed\n"),
    writeFile(command, commandContents),
  ]);
  let purgeCalls = 0;
  let disposeCalls = 0;
  const purgeCredentials = async () => {
    purgeCalls += 1;
    for (const path of [installRoot, command]) {
      await assert.rejects(access(path), { code: "ENOENT" });
    }
    await access(tombstone);
    await access(recordPath);
  };
  purgeCredentials.dispose = async () => { disposeCalls += 1; };
  await commitSourceUninstall({
    installRoot,
    platform: "linux",
    purgeCredentials,
    record: {
      commandLink: command,
      commandSha256: createHash("sha256").update(commandContents).digest("hex"),
      tombstone,
    },
    recordPath,
  });
  assert.equal(purgeCalls, 1);
  assert.equal(disposeCalls, 1);
});

test("source uninstall keeps durable recovery state when credential purge fails", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-source-uninstall-purge-failure-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const installRoot = join(root, ".rigyn");
  const command = join(root, "bin", "rigyn");
  const recordPath = `${installRoot}.uninstall.json`;
  const tombstone = `${installRoot}.uninstalling`;
  const commandContents = "managed command\n";
  await Promise.all([
    mkdir(installRoot, { recursive: true }),
    mkdir(dirname(command), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(installRoot, "sentinel"), "installed\n"),
    writeFile(command, commandContents),
  ]);
  let disposeCalls = 0;
  const purgeCredentials = async () => { throw new Error("injected credential purge failure"); };
  purgeCredentials.dispose = async () => { disposeCalls += 1; };

  await assert.rejects(commitSourceUninstall({
    installRoot,
    platform: "linux",
    purgeCredentials,
    record: {
      commandLink: command,
      commandSha256: createHash("sha256").update(commandContents).digest("hex"),
      tombstone,
    },
    recordPath,
  }), /injected credential purge failure/u);

  assert.equal(disposeCalls, 1);
  await assert.rejects(access(installRoot), { code: "ENOENT" });
  await assert.rejects(access(command), { code: "ENOENT" });
  assert.equal(await readFile(join(tombstone, "sentinel"), "utf8"), "installed\n");
  await access(recordPath);
});

test("source uninstall never commits prepared credential purge when command removal rolls back", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-source-uninstall-purge-rollback-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const installRoot = join(root, ".rigyn");
  const command = join(root, "bin", "rigyn");
  const recordPath = `${installRoot}.uninstall.json`;
  const tombstone = `${installRoot}.uninstalling`;
  await Promise.all([
    mkdir(installRoot, { recursive: true }),
    mkdir(dirname(command), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(installRoot, "sentinel"), "installed\n"),
    writeFile(command, "foreign command\n"),
  ]);
  let purgeCalls = 0;
  let disposeCalls = 0;
  const purgeCredentials = async () => { purgeCalls += 1; };
  purgeCredentials.dispose = async () => { disposeCalls += 1; };
  await assert.rejects(
    commitSourceUninstall({
      installRoot,
      platform: "linux",
      purgeCredentials,
      record: {
        commandLink: command,
        commandSha256: createHash("sha256").update("managed command\n").digest("hex"),
        tombstone,
      },
      recordPath,
    }),
    /ownership check failed/u,
  );
  assert.equal(purgeCalls, 0);
  assert.equal(disposeCalls, 1);
  assert.equal(await readFile(join(installRoot, "sentinel"), "utf8"), "installed\n");
  assert.equal(await readFile(command, "utf8"), "foreign command\n");
  await assert.rejects(access(tombstone), { code: "ENOENT" });
  await assert.rejects(access(recordPath), { code: "ENOENT" });
});

test("standalone POSIX uninstall commits prepared credential purge after local removal only", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-standalone-uninstall-purge-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const installRoot = join(root, ".rigyn");
  const launcher = join(installRoot, "bin", "rigyn");
  const command = join(root, "bin", "rigyn");
  await Promise.all([
    mkdir(dirname(launcher), { recursive: true }),
    mkdir(dirname(command), { recursive: true }),
  ]);
  await writeFile(launcher, "launcher\n");
  await symlink(launcher, command);
  let purgeCalls = 0;
  let disposeCalls = 0;
  const purgeCredentials = async () => {
    purgeCalls += 1;
    await assert.rejects(access(installRoot), { code: "ENOENT" });
    await assert.rejects(access(command), { code: "ENOENT" });
    await access(`${installRoot}.uninstalling`);
    await access(`${installRoot}.uninstall.json`);
  };
  purgeCredentials.dispose = async () => { disposeCalls += 1; };
  await uninstallPosix({
    command,
    installRoot,
    launcher,
    runtimeName: `rigyn-v9.8.7-${process.platform}-${process.arch}`,
    purgeCredentials,
    quiet: true,
  });
  assert.equal(purgeCalls, 1);
  assert.equal(disposeCalls, 1);
  await assert.rejects(access(`${installRoot}.uninstalling`), { code: "ENOENT" });
  await assert.rejects(access(`${installRoot}.uninstall.json`), { code: "ENOENT" });
});

test("standalone POSIX uninstall restores its command when the final record write fails", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-standalone-uninstall-record-failure-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const installRoot = join(root, ".rigyn");
  const launcher = join(installRoot, "bin", "rigyn");
  const command = join(root, "bin", "rigyn");
  await Promise.all([
    mkdir(dirname(launcher), { recursive: true }),
    mkdir(dirname(command), { recursive: true }),
  ]);
  await writeFile(launcher, "launcher\n");
  await symlink(launcher, command);
  let writes = 0;

  await assert.rejects(uninstallPosix({
    command,
    installRoot,
    launcher,
    persistRecord: async (path, contents, mode) => {
      writes += 1;
      if (writes === 3) throw new Error("injected command-removed record failure");
      await writeFile(path, contents, { mode });
    },
    runtimeName: `rigyn-v9.8.7-${process.platform}-${process.arch}`,
    quiet: true,
  }), /injected command-removed record failure/u);

  assert.equal(writes, 3);
  assert.equal(await readFile(launcher, "utf8"), "launcher\n");
  assert.equal(await readlink(command), launcher);
  await assert.rejects(access(`${installRoot}.uninstalling`), { code: "ENOENT" });
  await assert.rejects(access(`${installRoot}.uninstall.json`), { code: "ENOENT" });
});

test("standalone POSIX uninstall retains a retryable transaction when credential purge fails", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-standalone-uninstall-purge-failure-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const installRoot = join(root, ".rigyn");
  const tombstone = `${installRoot}.uninstalling`;
  const recordPath = `${installRoot}.uninstall.json`;
  const launcher = join(installRoot, "bin", "rigyn");
  const command = join(root, "bin", "rigyn");
  await Promise.all([
    mkdir(dirname(launcher), { recursive: true }),
    mkdir(dirname(command), { recursive: true }),
  ]);
  await writeFile(launcher, "launcher\n");
  await symlink(launcher, command);
  const purgeCredentials = async () => { throw new Error("injected credential purge failure"); };
  purgeCredentials.dispose = async () => undefined;

  await assert.rejects(uninstallPosix({
    command,
    installRoot,
    launcher,
    purgeCredentials,
    runtimeName: `rigyn-v9.8.7-${process.platform}-${process.arch}`,
    quiet: true,
  }), /injected credential purge failure/u);

  await assert.rejects(access(installRoot), { code: "ENOENT" });
  await assert.rejects(access(command), { code: "ENOENT" });
  assert.equal(await readFile(join(tombstone, "bin", "rigyn"), "utf8"), "launcher\n");
  await access(recordPath);
});

test("standalone POSIX uninstall never commits prepared credential purge after rollback", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-standalone-uninstall-purge-rollback-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const installRoot = join(root, ".rigyn");
  const launcher = join(installRoot, "bin", "rigyn");
  const command = join(root, "bin", "rigyn");
  const foreignLauncher = join(root, "foreign-rigyn");
  await Promise.all([
    mkdir(dirname(launcher), { recursive: true }),
    mkdir(dirname(command), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(launcher, "launcher\n"),
    writeFile(foreignLauncher, "foreign\n"),
  ]);
  await symlink(foreignLauncher, command);
  let purgeCalls = 0;
  let disposeCalls = 0;
  const purgeCredentials = async () => { purgeCalls += 1; };
  purgeCredentials.dispose = async () => { disposeCalls += 1; };
  await assert.rejects(
    uninstallPosix({
      command,
      installRoot,
      launcher,
      runtimeName: `rigyn-v9.8.7-${process.platform}-${process.arch}`,
      purgeCredentials,
      quiet: true,
    }),
    /points outside this installation/u,
  );
  assert.equal(purgeCalls, 0);
  assert.equal(disposeCalls, 1);
  assert.equal(await readFile(launcher, "utf8"), "launcher\n");
  assert.equal(await readlink(command), foreignLauncher);
  await assert.rejects(access(`${installRoot}.uninstalling`), { code: "ENOENT" });
  await assert.rejects(access(`${installRoot}.uninstall.json`), { code: "ENOENT" });
});

test("POSIX uninstall removes only the exact command it owns", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-uninstall-command-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const command = join(root, "rigyn");
  const expected = "managed command\n";
  const expectedSha256 = createHash("sha256").update(expected).digest("hex");
  await writeFile(command, "foreign command\n");

  await assert.rejects(
    removeOwnedPosixCommand(command, expectedSha256),
    /ownership check failed/u,
  );
  assert.equal(await readFile(command, "utf8"), "foreign command\n");

  await writeFile(command, expected);
  await removeOwnedPosixCommand(command, expectedSha256);
  await assert.rejects(access(command), { code: "ENOENT" });
});

test("POSIX uninstall restores the installation when command ownership changes after isolation", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-uninstall-command-race-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const installRoot = join(root, ".rigyn");
  const tombstone = `${installRoot}.uninstalling`;
  const recordPath = `${installRoot}.uninstall.json`;
  const command = join(root, ".local/bin/rigyn");
  const managedContents = "managed command\n";
  const commandSha256 = createHash("sha256").update(managedContents).digest("hex");
  await Promise.all([
    mkdir(installRoot, { recursive: true }),
    mkdir(dirname(command), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(installRoot, "sentinel"), "installed\n"),
    writeFile(command, managedContents),
    writeFile(recordPath, "transaction\n"),
  ]);
  await rename(installRoot, tombstone);
  await writeFile(command, "foreign command\n");

  await assert.rejects(
    removeCommandAfterIsolation({
      command,
      commandSha256,
      installRoot,
      recordPath,
      tombstone,
    }),
    /ownership check failed/u,
  );

  assert.equal(await readFile(join(installRoot, "sentinel"), "utf8"), "installed\n");
  assert.equal(await readFile(command, "utf8"), "foreign command\n");
  await assert.rejects(access(tombstone), { code: "ENOENT" });
  await assert.rejects(access(recordPath), { code: "ENOENT" });
});

async function stageInterruptedSourceUninstall(home) {
  const installRoot = join(home, ".rigyn");
  const tombstone = `${installRoot}.uninstalling`;
  const recordPath = `${installRoot}.uninstall.json`;
  const launcher = join(installRoot, "bin", "rigyn");
  const command = join(home, ".local", "bin", "rigyn");
  const launcherContents = posixLauncher(installRoot);
  const commandContents = managedCommand(launcher);
  await Promise.all([
    mkdir(dirname(launcher), { recursive: true }),
    mkdir(dirname(command), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(launcher, launcherContents, { mode: 0o755 }),
    writeFile(command, commandContents, { mode: 0o755 }),
  ]);
  const markerContents = `${JSON.stringify(createInstallationMarker(installRoot, "0.1.0", {
    launcher: launcherContents,
    command: commandContents,
  }), null, 2)}\n`;
  await writeFile(join(installRoot, ".installation.json"), markerContents, { mode: 0o600 });
  const record = createUninstallRecord(installRoot, markerContents, commandContents);
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(installRoot, tombstone);
  return { command, installRoot, recordPath, tombstone };
}

test("interrupted source uninstall reads purge state from the tombstone and commits it last", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-uninstall-purge-recovery-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const fixture = await stageInterruptedSourceUninstall(root);
    const calls = [];
    assert.equal(await recoverInterruptedUninstall(fixture.installRoot, {
      prepareCredentialPurge: async (authPath, options) => {
        calls.push(["prepare", authPath, options.stateAuthPath]);
        const prepared = async () => {
          calls.push(["purge"]);
          for (const path of [fixture.command, fixture.installRoot]) {
            await assert.rejects(access(path), { code: "ENOENT" });
          }
          await access(fixture.recordPath);
          await access(fixture.tombstone);
        };
        prepared.dispose = async () => { calls.push(["dispose"]); };
        return prepared;
      },
    }), true);
    assert.deepEqual(calls, [
      [
        "prepare",
        join(fixture.installRoot, "auth.json"),
        join(fixture.tombstone, "auth.json"),
      ],
      ["purge"],
      ["dispose"],
    ]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("interrupted source uninstall retries credential purge before clearing recovery state", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-uninstall-purge-retry-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const fixture = await stageInterruptedSourceUninstall(root);
    let purgeCalls = 0;
    const prepareCredentialPurge = async () => {
      const prepared = async () => {
        purgeCalls += 1;
        if (purgeCalls === 1) throw new Error("injected credential purge failure");
      };
      prepared.dispose = async () => undefined;
      return prepared;
    };

    await assert.rejects(
      recoverInterruptedUninstall(fixture.installRoot, { prepareCredentialPurge }),
      /injected credential purge failure/u,
    );
    await access(fixture.recordPath);
    await access(fixture.tombstone);
    await assert.rejects(access(fixture.command), { code: "ENOENT" });

    assert.equal(await recoverInterruptedUninstall(fixture.installRoot, { prepareCredentialPurge }), true);
    assert.equal(purgeCalls, 2);
    await assert.rejects(access(fixture.recordPath), { code: "ENOENT" });
    await assert.rejects(access(fixture.tombstone), { code: "ENOENT" });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("interrupted source uninstall never commits prepared purge after a later local failure", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-uninstall-purge-recovery-failure-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const fixture = await stageInterruptedSourceUninstall(root);
    const calls = [];
    await assert.rejects(
      recoverInterruptedUninstall(fixture.installRoot, {
        prepareCredentialPurge: async () => {
          calls.push("prepare");
          await writeFile(fixture.command, "foreign command\n");
          const prepared = async () => { calls.push("purge"); };
          prepared.dispose = async () => { calls.push("dispose"); };
          return prepared;
        },
      }),
      /ownership check failed/u,
    );
    assert.deepEqual(calls, ["prepare", "dispose"]);
    assert.equal(await readFile(fixture.command, "utf8"), "foreign command\n");
    await assert.rejects(access(fixture.installRoot), { code: "ENOENT" });
    await access(fixture.recordPath);
    await access(fixture.tombstone);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("uninstall resumes an interrupted tombstone transaction", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-uninstall-recovery-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const installRoot = join(root, "install");
  const tombstone = `${installRoot}.uninstalling`;
  const launcher = process.platform === "win32"
    ? join(installRoot, "bin", "rigyn.cmd")
    : join(installRoot, "bin", "rigyn");
  const command = process.platform === "win32"
    ? launcher
    : join(root, ".local", "bin", "rigyn");
  const launcherContents = process.platform === "win32" ? windowsLauncher() : posixLauncher(installRoot);
  const commandContents = process.platform === "win32" ? launcherContents : managedCommand(launcher);
  await Promise.all([
    mkdir(join(installRoot, "bin"), { recursive: true, mode: 0o700 }),
    mkdir(join(root, ".local", "bin"), { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(launcher, launcherContents, { mode: 0o755 });
  if (command !== launcher) await writeFile(command, commandContents, { mode: 0o755 });
  const markerContents = `${JSON.stringify({
    product: "rigyn",
    schemaVersion: 2,
    installationId: "c".repeat(32),
    installRoot,
    version: "0.1.0",
    launcherPath: launcher,
    launcherSha256: createHash("sha256").update(launcherContents).digest("hex"),
    commandLink: command,
    commandSha256: createHash("sha256").update(commandContents).digest("hex"),
  }, null, 2)}\n`;
  await writeFile(join(installRoot, ".installation.json"), markerContents, { mode: 0o600 });
  await writeFile(`${installRoot}.uninstall.json`, `${JSON.stringify({
    product: "rigyn",
    schemaVersion: 1,
    installRoot,
    tombstone,
    markerSha256: createHash("sha256").update(markerContents).digest("hex"),
    commandLink: command,
    commandSha256: createHash("sha256").update(commandContents).digest("hex"),
  }, null, 2)}\n`, { mode: 0o600 });
  await rename(installRoot, tombstone);

  const result = await runNode([
    join(PROJECT_ROOT, "scripts", "uninstall-user.mjs"),
    "--yes",
  ], {
    env: {
      ...process.env,
      RIGYN_INSTALL_DIR: installRoot,
      HOME: root,
      USERPROFILE: root,
    },
  });

  assert.match(result.stdout, /Removed the self-contained rigyn installation/u);
  for (const path of [installRoot, tombstone, `${installRoot}.uninstall.json`, command]) {
    await assert.rejects(access(path), { code: "ENOENT" });
  }
});
