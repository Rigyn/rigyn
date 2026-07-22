import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  lifecycleProcessTreeTerminationPlan,
  inside,
  managedCommand,
  parseInstallationMarker,
  posixLauncher,
  RIGYN_PACKAGE_GRAPH,
  RIGYN_PRODUCT_PACKAGE_GRAPH,
  resolveNpmInvocation,
  sameLifecyclePath,
  terminateLifecycleProcessTree,
  windowsLauncher,
} from "../../scripts/lifecycle-common.mjs";
import { sourceBuildSteps } from "../../scripts/install-user.mjs";
import {
  assertUpdateVersionPolicy,
  downloadLatestGitHubReleaseBundle,
  validateGitHubReleaseManifest,
} from "../../scripts/update-user.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function githubReleaseFixture(version = "0.5.0") {
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
  const manifest = {
    schemaVersion: 4,
    product: "rigyn",
    version,
    tag: `v${version}`,
    packaging: "npm-and-standalone",
    node: "^24.15.0 || >=26.0.0",
    nodeRuntime: "24.15.0",
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

async function runProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(options.input ?? "");
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
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
  const curlCapture = join(root, "curl.jsonl");
  const npmCapture = join(root, "npm.json");
  await Promise.all([mkdir(fixtureRoot), mkdir(fakeBin), mkdir(temporary)]);
  const checksums = fixture.archives.map(({ file, sha256 }) => `${sha256}  ${file}\n`).join("");
  await Promise.all([
    writeFile(join(fixtureRoot, "SHA256SUMS"), checksums),
    ...fixture.archives.map(async ({ file }) => {
      const contents = options.corrupt === file ? Buffer.alloc(fixture.files.get(file).byteLength, 1) : fixture.files.get(file);
      await writeFile(join(fixtureRoot, file), contents);
    }),
    writeFile(join(fakeBin, "curl"), `#!/usr/bin/env node
const { appendFile, copyFile } = require("node:fs/promises");
const { basename } = require("node:path");
(async () => {
  const args = process.argv.slice(2);
  const url = args.at(-1);
  await appendFile(process.env.RIGYN_TEST_CURL_CAPTURE, JSON.stringify({ args, url }) + "\\n");
  if (url.endsWith("/latest")) {
    process.stdout.write("https://github.com/Rigyn/rigyn/releases/tag/v0.5.0");
  } else {
    const outputIndex = args.indexOf("--output");
    await copyFile(process.env.RIGYN_TEST_FIXTURE + "/" + basename(new URL(url).pathname), args[outputIndex + 1]);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
`, { mode: 0o755 }),
    writeFile(join(fakeBin, "npm"), `#!/usr/bin/env node
const { readFile, writeFile } = require("node:fs/promises");
(async () => {
  await writeFile(process.env.RIGYN_TEST_NPM_CAPTURE, JSON.stringify({
    args: process.argv.slice(2),
    cache: process.env.npm_config_cache,
    global: await readFile(process.env.npm_config_globalconfig, "utf8"),
    user: await readFile(process.env.npm_config_userconfig, "utf8"),
  }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
`, { mode: 0o755 }),
  ]);
  const script = await readFile(join(REPOSITORY_ROOT, "install.sh"), "utf8");
  const result = await runProcess("sh", [], {
    cwd: root,
    input: script,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      RIGYN_TEST_CURL_CAPTURE: curlCapture,
      RIGYN_TEST_FIXTURE: fixtureRoot,
      RIGYN_TEST_NPM_CAPTURE: npmCapture,
      TMPDIR: temporary,
    },
  });
  return { curlCapture, fixture, npmCapture, result, temporary };
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

test("source installation builds and verifies only the matching desktop native helper", () => {
  const portable = [
    ["@rigyn/terminal", "build", "Rigyn terminal source build"],
    ["@rigyn/models", "build:offline", "Rigyn model catalog source build"],
    ["@rigyn/kernel", "build", "Rigyn kernel source build"],
    ["rigyn", "build", "Rigyn application source build"],
  ];
  assert.deepEqual(sourceBuildSteps("linux"), portable);
  for (const [platform, label] of [["darwin", "macOS"], ["win32", "Windows"]]) {
    assert.deepEqual(sourceBuildSteps(platform), [
      ["@rigyn/terminal", "build", "Rigyn terminal source build"],
      ["@rigyn/terminal", "native:build", `${label} native terminal helper build`],
      ["@rigyn/terminal", "native:verify", `${label} native terminal helper verification`],
      ...portable.slice(1),
    ]);
  }
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
  throw new Error("Rigyn private XDG config was not applied");
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
  assert.equal(result.version, "0.5.0");
  assert.equal(result.subpathCount, 22);
  assert.equal(result.targetCount, 6);
  assert.equal(result.nativeTargetCount, 4);
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
});

test("implicit self-update is monotonic while an explicit local bundle may downgrade", () => {
  assert.doesNotThrow(() => assertUpdateVersionPolicy("0.2.0", "0.2.0", false));
  assert.doesNotThrow(() => assertUpdateVersionPolicy("0.2.0", "0.3.0", false));
  assert.throws(
    () => assertUpdateVersionPolicy("0.2.0", "0.1.7", false),
    /Refusing to replace Rigyn 0\.2\.0 with older 0\.1\.7/u,
  );
  assert.throws(
    () => assertUpdateVersionPolicy("not-semver", "0.3.0", false),
    /Installed Rigyn version is invalid/u,
  );
  assert.doesNotThrow(() => assertUpdateVersionPolicy("0.2.0", "0.1.7", true));
  assert.doesNotThrow(() => assertUpdateVersionPolicy("not-semver", "0.1.7", true));
  assert.throws(
    () => assertUpdateVersionPolicy("0.2.0", "not-semver", true),
    /Downloaded Rigyn package version is invalid/u,
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
  assert.equal(calls[0].url, "https://api.github.com/repos/Rigyn/rigyn/releases/latest");
  assert.equal(calls.every(({ init }) => init.redirect === "follow" && init.signal instanceof AbortSignal), true);
});

test("GitHub self-update rejects unsupported manifests and bounded metadata overflow", async (context) => {
  const fixture = githubReleaseFixture();
  assert.throws(
    () => validateGitHubReleaseManifest({ ...fixture.manifest, unexpected: true }, fixture.release.tag_name),
    /unsupported schema/u,
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

  await assert.rejects(
    downloadLatestGitHubReleaseBundle(root, { fetch: githubReleaseFetch(fixture) }),
    /SHA-256 does not match/u,
  );
  assert.deepEqual(await readdir(root), []);
});

test("streamed POSIX bootstrap verifies four GitHub archives before self-install", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bootstrap-posix-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const run = await runPosixBootstrap(root);
  assert.equal(run.result.code, 0, run.result.stderr);
  assert.match(run.result.stdout, /verified GitHub release/u);
  const npm = JSON.parse(await readFile(run.npmCapture, "utf8"));
  assert.deepEqual(npm.args.slice(0, 2), ["exec", "--yes"]);
  assert.deepEqual(
    npm.args.filter((value) => value.startsWith("--package=")).map((value) => basename(value.slice("--package=".length))),
    run.fixture.archives.map(({ file }) => file),
  );
  assert.deepEqual(npm.args.slice(-3), ["--", "rigyn", "self-install"]);
  assert.equal(npm.global, "");
  assert.equal(npm.user, "");
  assert.match(npm.cache, /temporary files/u);
  const curlCalls = (await readFile(run.curlCapture, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(curlCalls.length, 2 + RIGYN_PRODUCT_PACKAGE_GRAPH.length);
  assert.equal(curlCalls[0].url, "https://github.com/Rigyn/rigyn/releases/latest");
  assert.deepEqual(await readdir(run.temporary), []);
});

test("streamed POSIX bootstrap rejects a checksum mismatch before npm", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bootstrap-posix-checksum-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const run = await runPosixBootstrap(root, { corrupt: "rigyn-0.5.0.tgz" });
  assert.notEqual(run.result.code, 0);
  assert.match(run.result.stderr, /checksum mismatch for rigyn-0\.5\.0\.tgz/u);
  await assert.rejects(access(run.npmCapture), (error) => error?.code === "ENOENT");
  assert.deepEqual(await readdir(run.temporary), []);
});

test("PowerShell bootstrap verifies GitHub archives and splats quoted npm arguments", async () => {
  const scriptPath = join(REPOSITORY_ROOT, "install.ps1");
  const script = await readFile(scriptPath, "utf8");
  assert.match(script, /api\.github\.com\/repos\/Rigyn\/rigyn\/releases\/latest/u);
  assert.match(script, /Get-FileHash -LiteralPath \$archivePath -Algorithm SHA256/u);
  for (const name of ["terminal", "models", "kernel"]) {
    assert.match(script, new RegExp(`"rigyn-${name}-\\$version\\.tgz"`, "u"));
  }
  assert.match(script, /"rigyn-\$version\.tgz"/u);
  assert.match(script, /\$npmArguments \+= "--package=\$archivePath"/u);
  assert.match(script, /& \$npmCommand\.Source @npmArguments/u);
  assert.match(script, /Get-Command npm\.cmd -CommandType Application/u);
  assert.match(script, /Invoke-WebRequest .* -UseBasicParsing/u);
  assert.ok(script.indexOf("Get-FileHash") < script.indexOf("& $npmCommand.Source @npmArguments"));
  assert.doesNotMatch(script, /rigyn@latest|registry\.npmjs/u);
  if (process.platform === "win32") {
    const parsed = await runProcess("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[void][ScriptBlock]::Create([IO.File]::ReadAllText($env:RIGYN_TEST_SCRIPT))",
    ], { env: { ...process.env, RIGYN_TEST_SCRIPT: scriptPath } });
    assert.equal(parsed.code, 0, parsed.stderr);
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
  assert.equal(inside("C:\\Users\\alice\\.rigyn", "D:\\Rigyn"), false);
});

test("lifecycle path identity folds Windows casing and preserves POSIX casing", () => {
  assert.equal(
    sameLifecyclePath("C:\\Users\\Alice\\.rigyn", "c:\\users\\ALICE\\.RIGYN", "win32"),
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

  assert.match(result.stdout, /Removed the self-contained Rigyn installation/u);
  for (const path of [installRoot, tombstone, `${installRoot}.uninstall.json`, command]) {
    await assert.rejects(access(path), { code: "ENOENT" });
  }
});
