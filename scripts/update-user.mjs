import { lstat, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  assertNoOtherActiveRuntimes,
  assertOwnedLaunchers,
  assertProtectedInstallRoot,
  readInstallationMarker,
  recoverInterruptedUninstall,
  runLifecycleChild,
  withLifecycleLock,
} from "./lifecycle-common.mjs";

const installRoot = resolve(process.env.RIGYN_INSTALL_DIR ?? join(homedir(), ".rigyn"));
const userHome = homedir();
const updateSpec = process.env.RIGYN_UPDATE_SPEC ?? "rigyn@latest";
const sensitiveEnvironmentName = /(?:^|_)(?:api_?key|auth(?:orization|_?token)?|cookie|credential|id_?token|password|passwd|private_?key|refresh_?token|secret|token)(?:_|$)/iu;
if (updateSpec === "" || updateSpec.includes("\0") || Buffer.byteLength(updateSpec, "utf8") > 8 * 1024) {
  throw new Error("RIGYN_UPDATE_SPEC is invalid");
}

function npmCommand(args) {
  return process.env.npm_execpath
    ? { command: process.execPath, args: [process.env.npm_execpath, ...args] }
    : { command: process.platform === "win32" ? "npm.cmd" : "npm", args };
}

function childEnvironment(root) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !sensitiveEnvironmentName.test(name)));
  return {
    ...environment,
    HOME: join(installRoot, "home"),
    USERPROFILE: join(installRoot, "home"),
    npm_config_cache: process.env.RIGYN_INSTALL_NPM_CACHE ?? join(installRoot, "cache", "npm"),
    npm_config_global: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    RIGYN_INSTALL_DIR: installRoot,
    RIGYN_UPDATE_STAGING: root,
  };
}

async function run(command, args, options) {
  await runLifecycleChild(command, args, options);
}

async function update() {
  const callerCwd = process.cwd();
  await assertProtectedInstallRoot(installRoot, { callerCwd });
  await withLifecycleLock(installRoot, async () => {
    await recoverInterruptedUninstall(installRoot);
    const rootMetadata = await lstat(installRoot);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new Error(`Install path must be a real directory: ${installRoot}`);
    }
    const markerRecord = await readInstallationMarker(installRoot);
    if (markerRecord === undefined) throw new Error(`Refusing to update an unrecognized installation: ${installRoot}`);
    await assertOwnedLaunchers(installRoot, markerRecord.marker);
    await assertNoOtherActiveRuntimes(installRoot, markerRecord.marker);

    const staging = await mkdtemp(join(tmpdir(), "rigyn-update-"));
    try {
      const prefix = join(staging, "package");
      await mkdir(prefix, { recursive: true, mode: 0o700 });
      const environment = childEnvironment(staging);
      const npm = npmCommand([
        "install",
        "--global=false",
        "--omit=dev",
        "--include=optional",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefix",
        prefix,
        "--",
        updateSpec,
      ]);
      await run(npm.command, npm.args, { cwd: staging, env: environment, label: "Rigyn download" });
      const packageRoot = join(prefix, "node_modules", "rigyn");
      const packageMetadata = await lstat(packageRoot);
      if (!packageMetadata.isDirectory() || packageMetadata.isSymbolicLink()) {
        throw new Error("Downloaded package must be an independent directory");
      }
      const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
      if (manifest?.name !== "rigyn" || typeof manifest.version !== "string" || manifest.version === "") {
        throw new Error("Downloaded package identity is invalid");
      }
      const installer = join(packageRoot, "scripts", "install-user.mjs");
      const installerMetadata = await lstat(installer);
      if (!installerMetadata.isFile() || installerMetadata.isSymbolicLink()) {
        throw new Error("Downloaded package installer is invalid");
      }
      await run(process.execPath, [installer], {
        cwd: callerCwd,
        env: { ...environment, HOME: userHome, USERPROFILE: userHome },
        label: "Rigyn update installation",
      });
      const installedMarker = await readInstallationMarker(installRoot);
      if (installedMarker === undefined || installedMarker.marker.version !== manifest.version) {
        throw new Error("Updated installation marker does not match the downloaded package");
      }
      process.stdout.write(`Updated Rigyn from ${markerRecord.marker.version} to ${manifest.version}\n`);
    } finally {
      await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
}

await update();
