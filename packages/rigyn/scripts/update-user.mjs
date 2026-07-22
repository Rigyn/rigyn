import { writeFileSync } from "node:fs";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { lt, valid } from "semver";

import {
  assertNoOtherActiveRuntimes,
  assertOwnedLaunchers,
  assertProtectedInstallRoot,
  RIGYN_PRODUCT_PACKAGE_GRAPH,
  readInstallationMarker,
  recoverInterruptedUninstall,
  resolveNpmInvocation,
  runLifecycleChild,
  withLifecycleLock,
} from "./lifecycle-common.mjs";

const installRoot = resolve(process.env.RIGYN_INSTALL_DIR ?? join(homedir(), ".rigyn"));
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const userHome = homedir();
const explicitUpdateSpec = process.env.RIGYN_UPDATE_SPEC;
const updateSpec = explicitUpdateSpec ?? "rigyn@latest";
const sensitiveEnvironmentName = /(?:^|_)(?:api_?key|auth(?:orization|_?token)?|cookie|credential|id_?token|password|passwd|private_?key|refresh_?token|secret|token)(?:_|$)/iu;
if (updateSpec === "" || updateSpec.includes("\0") || Buffer.byteLength(updateSpec, "utf8") > 8 * 1024) {
  throw new Error("RIGYN_UPDATE_SPEC is invalid");
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

function errno(error) {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

async function updateSpecs(callerCwd) {
  if (explicitUpdateSpec === undefined) return [updateSpec];
  const localArchive = resolve(callerCwd, updateSpec);
  let metadata;
  try {
    metadata = await lstat(localArchive);
  } catch (error) {
    if (errno(error) === "ENOENT") return [updateSpec];
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`Local RIGYN_UPDATE_SPEC must be a regular archive: ${localArchive}`);
  }
  if (!metadata.isFile()) return [updateSpec];
  const version = /^rigyn-(.+)\.tgz$/u.exec(basename(localArchive))?.[1];
  if (version === undefined) return [localArchive];
  const directory = dirname(localArchive);
  const entries = new Set(await readdir(directory));
  const files = RIGYN_PRODUCT_PACKAGE_GRAPH.map(({ name }) => name === "rigyn"
    ? basename(localArchive)
    : `${name.replace("@rigyn/", "rigyn-")}-${version}.tgz`);
  const companions = files.slice(0, -1);
  const present = companions.filter((file) => entries.has(file));
  if (present.length === 0) return [localArchive];
  if (present.length !== companions.length) {
    throw new Error(`Local Rigyn update bundle is incomplete beside ${localArchive}`);
  }
  const paths = files.map((file) => join(directory, file));
  for (const path of paths) {
    const archiveMetadata = await lstat(path);
    if (!archiveMetadata.isFile() || archiveMetadata.isSymbolicLink()) {
      throw new Error(`Local Rigyn update archive is unsafe: ${path}`);
    }
  }
  return paths;
}

async function run(command, args, options) {
  await runLifecycleChild(command, args, options);
}

export function assertUpdateVersionPolicy(currentVersion, nextVersion, explicitRequest) {
  if (typeof nextVersion !== "string" || valid(nextVersion) === null) {
    throw new Error("Downloaded Rigyn package version is invalid");
  }
  if (explicitRequest) return;
  if (typeof currentVersion !== "string" || valid(currentVersion) === null) {
    throw new Error("Installed Rigyn version is invalid; set RIGYN_UPDATE_SPEC to an explicit reviewed package to recover");
  }
  if (lt(nextVersion, currentVersion)) {
    throw new Error(
      `Refusing to replace Rigyn ${currentVersion} with older ${nextVersion}; set RIGYN_UPDATE_SPEC to an explicit reviewed package to downgrade`,
    );
  }
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
    const lifecycleManifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
    const nodeTypesVersion = lifecycleManifest.devDependencies?.["@types/node"];
    if (typeof nodeTypesVersion !== "string" || nodeTypesVersion === "") {
      throw new Error("Installed Rigyn package does not pin @types/node");
    }

    const staging = await mkdtemp(join(tmpdir(), "rigyn-update-"));
    try {
      const prefix = join(staging, "package");
      await mkdir(prefix, { recursive: true, mode: 0o700 });
      await writeFile(join(prefix, "package.json"), `${JSON.stringify({
        name: "rigyn-update-download",
        private: true,
        version: "0.0.0",
        overrides: { "@types/node": nodeTypesVersion },
      }, null, 2)}\n`, { mode: 0o600 });
      const environment = childEnvironment(staging);
      const specs = await updateSpecs(callerCwd);
      const npm = await resolveNpmInvocation([
        "install",
        "--global=false",
        "--omit=dev",
        "--omit=peer",
        "--include=optional",
        "--legacy-peer-deps",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefix",
        prefix,
        "--",
        ...specs,
      ]);
      await run(npm.command, npm.args, { cwd: staging, env: environment, label: "Rigyn download" });
      const packageRoot = join(prefix, "node_modules", "rigyn");
      const manifests = new Map();
      for (const { name } of RIGYN_PRODUCT_PACKAGE_GRAPH) {
        const root = name === "rigyn" ? packageRoot : join(prefix, "node_modules", ...name.split("/"));
        const packageMetadata = await lstat(root);
        if (!packageMetadata.isDirectory() || packageMetadata.isSymbolicLink()) {
          throw new Error(`Downloaded package must be an independent directory: ${name}`);
        }
        const downloadedManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
        if (downloadedManifest?.name !== name || typeof downloadedManifest.version !== "string" || downloadedManifest.version === "") {
          throw new Error(`Downloaded package identity is invalid: ${name}`);
        }
        manifests.set(name, downloadedManifest);
      }
      const manifest = manifests.get("rigyn");
      if (manifest?.name !== "rigyn" || typeof manifest.version !== "string" || manifest.version === "") {
        throw new Error("Downloaded package identity is invalid");
      }
      for (const [name, downloadedManifest] of manifests) {
        if (downloadedManifest.version !== manifest.version) {
          throw new Error(`Downloaded ${name} version does not match rigyn`);
        }
      }
      assertUpdateVersionPolicy(markerRecord.marker.version, manifest.version, explicitUpdateSpec !== undefined);
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
      writeFileSync(1, `Updated Rigyn from ${markerRecord.marker.version} to ${manifest.version}\n`);
    } finally {
      await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) await update();
