import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { lstat, mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
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
const sensitiveEnvironmentName = /(?:^|_)(?:api_?key|auth(?:orization|_?token)?|cookie|credential|id_?token|password|passwd|private_?key|refresh_?token|secret|token)(?:_|$)/iu;
const latestReleaseApi = "https://api.github.com/repos/Rigyn/rigyn/releases/latest";
const releaseDownloadRoot = "https://github.com/Rigyn/rigyn/releases/download";
const releaseManifestKeys = [
  "schemaVersion", "product", "version", "tag", "packaging", "node", "nodeRuntime", "archive", "archives",
  "source", "standalones", "checksumFile", "releaseNotes", "targets",
];
const archiveKeys = ["name", "version", "file", "sha256", "integrity", "bytes"];
const maxReleaseMetadataBytes = 1024 * 1024;
const maxReleaseManifestBytes = 256 * 1024;
const maxReleaseArchiveBytes = 256 * 1024 * 1024;
const releaseFetchTimeoutMs = 5 * 60_000;
if (explicitUpdateSpec !== undefined && (
  explicitUpdateSpec === ""
  || explicitUpdateSpec.includes("\0")
  || Buffer.byteLength(explicitUpdateSpec, "utf8") > 8 * 1024
)) {
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

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || !actual.every((key, index) => key === expected[index])) {
    throw new Error(`${label} has an unsupported schema`);
  }
  return value;
}

function parseJson(contents, label) {
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`${label} is invalid JSON`, { cause: error });
  }
}

function responseContentLength(response, maximum, label) {
  const value = response.headers?.get?.("content-length");
  if (value === null || value === undefined) return;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new Error(`${label} has an invalid Content-Length`);
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes > maximum) throw new Error(`${label} exceeds the download limit`);
}

async function fetchReleaseResponse(fetcher, url, label, accept) {
  let response;
  try {
    response = await fetcher(url, {
      headers: {
        accept,
        "user-agent": "rigyn-self-update",
        "x-github-api-version": "2022-11-28",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(releaseFetchTimeoutMs),
    });
  } catch (error) {
    throw new Error(`${label} request failed`, { cause: error });
  }
  if (response === null || typeof response !== "object" || typeof response.ok !== "boolean") {
    throw new Error(`${label} returned an invalid response`);
  }
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
  return response;
}

async function readBoundedResponse(response, maximum, label) {
  responseContentLength(response, maximum, label);
  if (response.body === null || response.body === undefined) throw new Error(`${label} returned an empty body`);
  const chunks = [];
  let bytes = 0;
  for await (const value of response.body) {
    const chunk = Buffer.from(value);
    bytes += chunk.byteLength;
    if (bytes > maximum) throw new Error(`${label} exceeds the download limit`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

function releaseAssetMap(release) {
  if (release === null || typeof release !== "object" || Array.isArray(release)
    || typeof release.tag_name !== "string"
    || !release.tag_name.startsWith("v")
    || valid(release.tag_name.slice(1)) === null
    || release.draft !== false
    || release.prerelease !== false
    || !Array.isArray(release.assets)) {
    throw new Error("Latest Rigyn GitHub release metadata is invalid");
  }
  const assets = new Map();
  for (const asset of release.assets) {
    if (asset === null || typeof asset !== "object" || Array.isArray(asset)
      || typeof asset.name !== "string" || asset.name === ""
      || !Number.isSafeInteger(asset.size) || asset.size < 1) {
      throw new Error("Latest Rigyn GitHub release contains invalid asset metadata");
    }
    if (assets.has(asset.name)) throw new Error(`Latest Rigyn GitHub release repeats asset ${asset.name}`);
    assets.set(asset.name, asset);
  }
  return assets;
}

function expectedArchiveFile(name, version) {
  return `${name === "rigyn" ? "rigyn" : name.replace("@rigyn/", "rigyn-")}-${version}.tgz`;
}

export function validateGitHubReleaseManifest(value, tagName) {
  const manifest = exactKeys(value, releaseManifestKeys, "Rigyn release manifest");
  if (manifest.schemaVersion !== 4
    || manifest.product !== "rigyn"
    || typeof manifest.version !== "string"
    || valid(manifest.version) === null
    || manifest.tag !== `v${manifest.version}`
    || manifest.tag !== tagName
    || manifest.packaging !== "npm-and-standalone"
    || typeof manifest.node !== "string" || manifest.node === ""
    || typeof manifest.nodeRuntime !== "string" || valid(manifest.nodeRuntime) === null
    || manifest.checksumFile !== "SHA256SUMS"
    || manifest.releaseNotes !== "RELEASE_NOTES.md"
    || manifest.source === null || typeof manifest.source !== "object" || Array.isArray(manifest.source)
    || !Array.isArray(manifest.standalones)
    || !Array.isArray(manifest.targets)
    || !Array.isArray(manifest.archives)
    || manifest.archives.length !== RIGYN_PRODUCT_PACKAGE_GRAPH.length) {
    throw new Error("Rigyn release manifest does not describe a supported GitHub release");
  }

  const archives = manifest.archives.map((value, index) => {
    const archive = exactKeys(value, archiveKeys, `Rigyn release archive ${index + 1}`);
    const expectedName = RIGYN_PRODUCT_PACKAGE_GRAPH[index]?.name;
    if (archive.name !== expectedName
      || archive.version !== manifest.version
      || archive.file !== expectedArchiveFile(expectedName, manifest.version)
      || !/^[a-f0-9]{64}$/u.test(archive.sha256)
      || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(archive.integrity)
      || !Number.isSafeInteger(archive.bytes)
      || archive.bytes < 1
      || archive.bytes > maxReleaseArchiveBytes) {
      throw new Error(`Rigyn release archive metadata is invalid for ${expectedName}`);
    }
    return archive;
  });
  const productArchive = archives.at(-1);
  const primaryArchive = exactKeys(manifest.archive, archiveKeys, "Rigyn primary release archive");
  if (!archiveKeys.every((key) => primaryArchive[key] === productArchive[key])) {
    throw new Error("Rigyn primary release archive does not match the product archive");
  }
  return { manifest, archives };
}

async function writeResponseToVerifiedFile(response, path, metadata) {
  responseContentLength(response, metadata.bytes, metadata.file);
  if (response.body === null || response.body === undefined) throw new Error(`${metadata.file} returned an empty body`);
  const hash = createHash("sha256");
  const handle = await open(path, "wx", 0o600);
  let bytes = 0;
  try {
    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      bytes += chunk.byteLength;
      if (bytes > metadata.bytes) throw new Error(`${metadata.file} exceeds its declared size`);
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const result = await handle.write(chunk, offset, chunk.byteLength - offset, null);
        if (result.bytesWritten < 1) throw new Error(`Could not write ${metadata.file}`);
        offset += result.bytesWritten;
      }
    }
  } catch (error) {
    await handle.close();
    await rm(path, { force: true });
    throw error;
  }
  await handle.close();
  if (bytes !== metadata.bytes) {
    await rm(path, { force: true });
    throw new Error(`${metadata.file} size does not match the release manifest`);
  }
  if (hash.digest("hex") !== metadata.sha256) {
    await rm(path, { force: true });
    throw new Error(`${metadata.file} SHA-256 does not match the release manifest`);
  }
}

export async function downloadLatestGitHubReleaseBundle(directory, options = {}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new Error("GitHub release updates require fetch");
  const releaseResponse = await fetchReleaseResponse(
    fetcher,
    latestReleaseApi,
    "Latest Rigyn GitHub release metadata",
    "application/vnd.github+json",
  );
  const release = parseJson(
    await readBoundedResponse(releaseResponse, maxReleaseMetadataBytes, "Latest Rigyn GitHub release metadata"),
    "Latest Rigyn GitHub release metadata",
  );
  const assets = releaseAssetMap(release);
  const manifestAsset = assets.get("release-manifest.json");
  if (manifestAsset === undefined || manifestAsset.size > maxReleaseManifestBytes) {
    throw new Error("Latest Rigyn GitHub release has no bounded release-manifest.json asset");
  }
  const manifestResponse = await fetchReleaseResponse(
    fetcher,
    `${releaseDownloadRoot}/${encodeURIComponent(release.tag_name)}/release-manifest.json`,
    "Rigyn release manifest",
    "application/octet-stream",
  );
  const manifestContents = await readBoundedResponse(manifestResponse, manifestAsset.size, "Rigyn release manifest");
  if (manifestContents.byteLength !== manifestAsset.size) {
    throw new Error("Rigyn release manifest size does not match GitHub asset metadata");
  }
  const { manifest, archives } = validateGitHubReleaseManifest(
    parseJson(manifestContents, "Rigyn release manifest"),
    release.tag_name,
  );

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const paths = archives.map((archive) => resolve(directory, archive.file));
  try {
    for (let index = 0; index < archives.length; index += 1) {
      const archive = archives[index];
      const asset = assets.get(archive.file);
      if (asset === undefined || asset.size !== archive.bytes) {
        throw new Error(`Latest Rigyn GitHub release asset metadata does not match ${archive.file}`);
      }
      const response = await fetchReleaseResponse(
        fetcher,
        `${releaseDownloadRoot}/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(archive.file)}`,
        archive.file,
        "application/octet-stream",
      );
      await writeResponseToVerifiedFile(response, paths[index], archive);
    }
  } catch (error) {
    await Promise.all(paths.map(async (path) => await rm(path, { force: true })));
    throw error;
  }
  return { version: manifest.version, specs: paths };
}

async function explicitUpdateSpecs(callerCwd) {
  const updateSpec = explicitUpdateSpec;
  if (updateSpec === undefined) throw new Error("Explicit update spec is missing");
  const localArchive = resolve(callerCwd, updateSpec);
  let metadata;
  try {
    metadata = await lstat(localArchive);
  } catch (error) {
    if (errno(error) === "ENOENT") {
      throw new Error(`RIGYN_UPDATE_SPEC must name an existing local Rigyn product archive: ${localArchive}`);
    }
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`Local RIGYN_UPDATE_SPEC must be a regular archive: ${localArchive}`);
  }
  if (!metadata.isFile()) throw new Error(`Local RIGYN_UPDATE_SPEC must be a regular archive: ${localArchive}`);
  const version = /^rigyn-(.+)\.tgz$/u.exec(basename(localArchive))?.[1];
  if (version === undefined || valid(version) === null) {
    throw new Error(`RIGYN_UPDATE_SPEC must name rigyn-<version>.tgz: ${localArchive}`);
  }
  const directory = dirname(localArchive);
  const files = RIGYN_PRODUCT_PACKAGE_GRAPH.map(({ name }) => name === "rigyn"
    ? basename(localArchive)
    : `${name.replace("@rigyn/", "rigyn-")}-${version}.tgz`);
  const paths = files.map((file) => join(directory, file));
  for (const path of paths) {
    let archiveMetadata;
    try {
      archiveMetadata = await lstat(path);
    } catch (error) {
      if (errno(error) === "ENOENT") throw new Error(`Local Rigyn update bundle is incomplete beside ${localArchive}`);
      throw error;
    }
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
    throw new Error("Installed Rigyn version is invalid; set RIGYN_UPDATE_SPEC to a reviewed local release bundle to recover");
  }
  if (lt(nextVersion, currentVersion)) {
    throw new Error(
      `Refusing to replace Rigyn ${currentVersion} with older ${nextVersion}; set RIGYN_UPDATE_SPEC to a reviewed local release bundle to downgrade`,
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
      const updateSource = explicitUpdateSpec === undefined
        ? await downloadLatestGitHubReleaseBundle(join(staging, "release"))
        : { specs: await explicitUpdateSpecs(callerCwd), version: undefined };
      const specs = updateSource.specs;
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
      if (updateSource.version !== undefined && manifest.version !== updateSource.version) {
        throw new Error("Downloaded Rigyn package does not match the GitHub release manifest");
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
