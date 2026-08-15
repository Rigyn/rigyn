import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { RIGYN_VERSION } from "../../src/version.js";
import { standaloneRuntimeInstallationId } from "../../src/bin/runtime-lease.js";

for (const command of ["uninstall", "self-uninstall"]) test(`${command} without --yes reports one actionable CLI error`, (context) => {
  const home = mkdtempSync(join(tmpdir(), "rigyn-uninstall-confirmation-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    RIGYN_INSTALL_DIR: join(home, ".rigyn"),
  };
  delete environment.RIGYN_RECURSION_DEPTH;

  const result = spawnSync(process.execPath, [
    "--import",
    "tsx",
    resolve("src/bin/rigyn.ts"),
    command,
  ], {
    cwd: resolve("."),
    env: environment,
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "rigyn: Uninstall requires confirmation; run `rigyn uninstall --yes`\n");
});

test("standalone self-update reports the exact verified installer command", (context) => {
  const home = mkdtempSync(join(tmpdir(), "rigyn-standalone-update-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    RIGYN_DISTRIBUTION: "standalone",
  };
  delete environment.RIGYN_RECURSION_DEPTH;

  const result = spawnSync(process.execPath, [
    "--import",
    "tsx",
    resolve("src/bin/rigyn.ts"),
    "self-update",
  ], {
    cwd: resolve("."),
    env: environment,
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    process.platform === "win32"
      ? new RegExp(`irm https://raw\\.githubusercontent\\.com/rigyn/rigyn/v${RIGYN_VERSION}/install\\.ps1 \\| iex`, "u")
      : new RegExp(`curl -fsSL https://raw\\.githubusercontent\\.com/rigyn/rigyn/v${RIGYN_VERSION}/install\\.sh \\| sh`, "u"),
  );
});

for (const lockState of ["contended", "stale"] as const) test(
  `standalone uninstall recovers a ${lockState} lifecycle lease and fully removes its managed home`,
  {
  timeout: process.platform === "win32" ? 180_000 : 20_000,
  },
  async (context) => {
  const root = mkdtempSync(join(tmpdir(), `rigyn-standalone-uninstall-${lockState}-`));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const installRoot = join(home, ".rigyn");
  const fixtureVersion = "9.8.7";
  const runtimeName = `rigyn-v${fixtureVersion}-${process.platform}-${process.arch}`;
  const runtime = join(installRoot, "runtime", runtimeName);
  const packageRoot = join(runtime, "lib", "node_modules", "rigyn");
  const script = join(packageRoot, "scripts", "uninstall-standalone.mjs");
  const launcher = join(installRoot, "bin", process.platform === "win32" ? "rigyn.cmd" : "rigyn");
  const command = process.platform === "win32" ? launcher : join(home, ".local", "bin", "rigyn");
  const runtimeLauncher = join(runtime, "bin", process.platform === "win32" ? "rigyn.cmd" : "rigyn");
  const runtimeNode = process.platform === "win32" ? join(runtime, "node.exe") : process.execPath;
  const externalAgent = join(root, "external-agent");
  const helperTemp = join(root, "helper-temp");
  const workspace = join(root, "workspace");
  for (const path of [
    join(packageRoot, "scripts"),
    join(runtime, "bin"),
    join(installRoot, "bin"),
    join(home, ".local", "bin"),
    join(installRoot, "sessions"),
    externalAgent,
    helperTemp,
    workspace,
  ]) mkdirSync(path, { recursive: true });
  copyFileSync(resolve("scripts/uninstall-standalone.mjs"), script);
  copyFileSync(resolve("scripts/lifecycle-common.mjs"), join(packageRoot, "scripts", "lifecycle-common.mjs"));
  if (process.platform !== "win32") chmodSync(installRoot, 0o700);
  if (process.platform === "win32") copyFileSync(process.execPath, runtimeNode);
  writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({
    name: "rigyn",
    version: fixtureVersion,
  })}\n`);
  writeFileSync(join(runtime, "BUILD-METADATA.json"), `${JSON.stringify({
    schemaVersion: 1,
    product: "rigyn",
    version: fixtureVersion,
    platform: process.platform,
    arch: process.arch,
    node: process.version.slice(1),
    entrypoint: process.platform === "win32" ? "bin/rigyn.cmd" : "bin/rigyn",
  })}\n`);
  writeFileSync(runtimeLauncher, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
  if (process.platform === "win32") {
    writeFileSync(launcher, [
      "@echo off",
      "rem rigyn standalone managed command",
      `"%USERPROFILE%\\.rigyn\\runtime\\${runtimeName}\\bin\\rigyn.cmd" %*`,
      "",
    ].join("\r\n"));
  } else {
    symlinkSync(runtimeLauncher, launcher);
    symlinkSync(launcher, command);
  }
  writeFileSync(join(installRoot, "sessions", "session.jsonl"), "private state\n");
  writeFileSync(join(externalAgent, "keep.txt"), "external state\n");
  symlinkSync(externalAgent, join(installRoot, "external-agent-link"), process.platform === "win32" ? "junction" : "dir");

  const lifecycleCommon = join(packageRoot, "scripts", "lifecycle-common.mjs");
  const uninstallEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    RIGYN_HOME: externalAgent,
    RIGYN_DISTRIBUTION: "standalone",
    RIGYN_INSTALL_DIR: installRoot,
    TEMP: helperTemp,
    TMP: helperTemp,
    TMPDIR: helperTemp,
  };
  const peer = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    "process.stdout.write('ready\\n'); setInterval(() => undefined, 60_000)",
  ], {
    cwd: workspace,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  context.after(() => {
    if (peer.exitCode === null) peer.kill("SIGKILL");
  });
  let peerOutput = "";
  let peerError = "";
  peer.stdout.on("data", (chunk) => { peerOutput += chunk.toString("utf8"); });
  peer.stderr.on("data", (chunk) => { peerError += chunk.toString("utf8"); });
  const peerExit = new Promise<number | null>((resolveClose, reject) => {
    peer.once("close", resolveClose);
    peer.once("error", reject);
  });
  await new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error("standalone runtime peer did not start")), 5_000);
    peer.stdout.on("data", () => {
      if (!peerOutput.includes("ready\n")) return;
      clearTimeout(timeout);
      resolveReady();
    });
    peer.once("error", reject);
    peer.once("close", (code) => {
      if (!peerOutput.includes("ready\n")) {
        clearTimeout(timeout);
        reject(new Error(`standalone runtime peer exited with ${code}: ${peerError}`));
      }
    });
  });
  assert.equal(peer.exitCode, null, `standalone runtime peer exited early: ${peerError}`);
  const lifecycle = await import(pathToFileURL(lifecycleCommon).href) as {
    managedToolOutputDirectory(options: { installRoot: string }): string;
    standaloneInstallationId(path: string): string;
  };
  assert.equal(
    lifecycle.standaloneInstallationId(installRoot),
    standaloneRuntimeInstallationId(installRoot),
  );
  assert.ok(peer.pid);
  const peerLease = "d".repeat(32);
  const leaseDirectory = join(installRoot, ".runtime-leases");
  mkdirSync(leaseDirectory, { recursive: true });
  writeFileSync(join(leaseDirectory, `${peerLease}.json`), `${JSON.stringify({
    schemaVersion: 1,
    pid: peer.pid,
    lease: peerLease,
    createdAt: Date.now(),
    installationId: lifecycle.standaloneInstallationId(installRoot),
  })}\n`);

  const blocked = spawnSync(runtimeNode, [script, "--yes"], {
    cwd: workspace,
    env: uninstallEnvironment,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(blocked.status, 1, blocked.stdout);
  assert.match(blocked.stderr, /Close the other running rigyn process/u);
  assert.equal(existsSync(installRoot), true);
  assert.equal(existsSync(command), true);
  peer.kill("SIGTERM");
  await peerExit;

  let holderExit: Promise<number | null> | undefined;
  let holderError = "";
  if (lockState === "stale") {
    writeFileSync(`${installRoot}.lifecycle.lock`, `${JSON.stringify({
      schemaVersion: 1,
      pid: 2_147_483_647,
      token: "e".repeat(32),
      createdAt: 0,
      installRoot,
    })}\n`);
  } else {
    const holderProgram = [
      `import { acquireLifecycleLock } from ${JSON.stringify(pathToFileURL(lifecycleCommon).href)}`,
      "const lease = await acquireLifecycleLock(process.argv[1])",
      "process.stdout.write('locked\\n')",
      "await new Promise((resolveDelay) => setTimeout(resolveDelay, 700))",
      "await lease.release()",
    ].join(";");
    const holder = spawn(process.execPath, [
      "--input-type=module",
      "--eval",
      holderProgram,
      installRoot,
    ], {
      cwd: workspace,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let holderOutput = "";
    holder.stdout.on("data", (chunk) => { holderOutput += chunk.toString("utf8"); });
    holder.stderr.on("data", (chunk) => { holderError += chunk.toString("utf8"); });
    holderExit = new Promise((resolveClose, reject) => {
      holder.once("close", resolveClose);
      holder.once("error", reject);
    });
    await new Promise<void>((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error("lifecycle lock holder did not start")), 5_000);
      holder.stdout.on("data", () => {
        if (!holderOutput.includes("locked\n")) return;
        clearTimeout(timeout);
        resolveReady();
      });
      holder.once("error", reject);
      holder.once("close", (code) => {
        if (!holderOutput.includes("locked\n")) {
          clearTimeout(timeout);
          reject(new Error(`lifecycle lock holder exited with ${code}: ${holderError}`));
        }
      });
    });
  }

  const managedOutputRoot = lifecycle.managedToolOutputDirectory({ installRoot });
  mkdirSync(managedOutputRoot, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(managedOutputRoot, "rigyn-bash-0123456789abcdef.log"),
    "managed full command output\n",
    { mode: 0o600 },
  );

  const uninstallStartedAt = Date.now();
  const result = spawnSync(runtimeNode, [script, "--yes"], {
    cwd: workspace,
    env: uninstallEnvironment,
    encoding: "utf8",
    timeout: process.platform === "win32" ? 60_000 : 20_000,
  });
  const uninstallElapsedMs = Date.now() - uninstallStartedAt;
  if (holderExit !== undefined) {
    assert.equal(await holderExit, 0, holderError);
    assert.ok(uninstallElapsedMs >= 500, `uninstall bypassed the active lifecycle lock (${uninstallElapsedMs} ms)`);
  }
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    process.platform === "win32"
      ? /Scheduled full removal of the standalone rigyn installation/u
      : /Fully removed the standalone rigyn installation/u,
  );

  const pendingTombstones = () => readdirSync(home).filter((entry) => entry.startsWith(".rigyn.uninstalling-"));
  const pendingHelperArtifacts = () => readdirSync(helperTemp);
  const deadline = Date.now() + (process.platform === "win32" ? 125_000 : 10_000);
  while (
    (existsSync(installRoot) || pendingTombstones().length > 0 || pendingHelperArtifacts().length > 0)
    && Date.now() < deadline
  ) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  const remainingTombstones = pendingTombstones();
  const remainingHelperArtifacts = pendingHelperArtifacts();
  assert.equal(
    existsSync(installRoot),
    false,
    `Standalone cleanup did not remove ${installRoot}; tombstones=${JSON.stringify(remainingTombstones)} helperArtifacts=${JSON.stringify(remainingHelperArtifacts)} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
  );
  assert.equal(existsSync(command), false);
  assert.equal(existsSync(managedOutputRoot), false);
  assert.equal(existsSync(join(externalAgent, "keep.txt")), true);
  assert.deepEqual(
    remainingTombstones,
    [],
    `Standalone cleanup left tombstones; helperArtifacts=${JSON.stringify(remainingHelperArtifacts)} stderr=${JSON.stringify(result.stderr)}`,
  );
  assert.deepEqual(remainingHelperArtifacts, []);
  assert.equal(existsSync(`${installRoot}.lifecycle.lock`), false);
});
