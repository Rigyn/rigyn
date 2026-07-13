import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  checkReleaseMetadata,
  extractReleaseNotes,
} from "../../scripts/check-release-metadata.mjs";
import { managedCommand, posixLauncher, windowsLauncher } from "../../scripts/lifecycle-common.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function runNode(args, options = {}) {
  const child = spawn(process.execPath, args, {
    cwd: PROJECT_ROOT,
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

test("release metadata policy matches the published package contract", async () => {
  const result = await checkReleaseMetadata();
  assert.equal(result.version, "0.1.0");
  assert.equal(result.subpathCount, 19);
  assert.equal(result.targetCount, 6);
  assert.ok(result.actionCount >= 6);
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
});

test("release staging refuses a markerless output without deleting it", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-release-output-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const output = join(root, "foreign-output");
  const sentinel = join(output, "keep.txt");
  await mkdir(output, { recursive: true });
  await writeFile(sentinel, "keep\n");

  const result = await runNode([
    join(PROJECT_ROOT, "scripts", "stage-release.mjs"),
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
    "const [root, name, delay] = process.argv.slice(1)",
    "await withLifecycleLock(root, async () => { process.stdout.write(name + '\\n'); await new Promise((resolve) => setTimeout(resolve, Number(delay))) })",
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
