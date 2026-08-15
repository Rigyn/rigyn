import assert from "node:assert/strict";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { basename, posix, resolve } from "node:path";

import { RIGYN_PACKAGE_GRAPH } from "../packages/rigyn/scripts/lifecycle-common.mjs";
import { releaseNpmResolutionArguments } from "./release-npm-resolution.mjs";

export const STANDALONE_PRODUCTION_LOCK = "PRODUCTION-LOCK.json";

const LOCK_NAME = "rigyn-standalone-production";
const MAX_LOCKED_PACKAGES = 512;
const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const ARCHIVE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u;

export function standaloneProductionInstallArguments() {
  return [
    "ci", "--global=false", "--omit=dev", "--omit=peer", "--include=optional", "--legacy-peer-deps",
    "--no-audit", "--no-fund", "--ignore-scripts",
    ...releaseNpmResolutionArguments(),
  ];
}

function packageMap(packageManifests) {
  return packageManifests instanceof Map
    ? packageManifests
    : new Map(Object.entries(packageManifests ?? {}));
}

function dependencyNames(entry) {
  return Object.keys({
    ...(entry.dependencies ?? {}),
    ...(entry.optionalDependencies ?? {}),
  }).sort();
}

function packageNameFromLockPath(path) {
  const components = path.split("/");
  const modules = components.lastIndexOf("node_modules");
  assert.ok(modules >= 0 && modules + 1 < components.length, `Invalid production lock package path: ${path}`);
  const first = components[modules + 1];
  if (first.startsWith("@")) {
    assert.ok(modules + 2 < components.length, `Invalid scoped production lock package path: ${path}`);
    return `${first}/${components[modules + 2]}`;
  }
  return first;
}

function expectedRegistryUrl(name, version) {
  const unscoped = name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
  return `https://registry.npmjs.org/${name}/-/${unscoped}-${version}.tgz`;
}

function assertSha512Integrity(value, label) {
  assert.match(value ?? "", INTEGRITY_PATTERN, `${label} is missing SHA-512 integrity`);
  assert.equal(
    Buffer.from(value.slice("sha512-".length), "base64").byteLength,
    64,
    `${label} SHA-512 integrity must decode to exactly 64 bytes`,
  );
}

function resolveLockedDependency(packages, fromPath, name, internalSources) {
  const internal = internalSources?.get(name);
  if (internal !== undefined) return internal;
  let current = fromPath;
  while (true) {
    const candidate = current === "" ? `node_modules/${name}` : posix.join(current, "node_modules", name);
    if (packages[candidate] !== undefined) return candidate;
    if (current === "") break;
    const parent = posix.dirname(current);
    current = parent === "." ? "" : parent;
  }
  throw new Error(`${fromPath || "production root"} depends on ${name}, which is absent from the committed lock`);
}

function destinationPath(sourcePath, internalSources) {
  for (const [name, directory] of internalSources) {
    if (sourcePath === directory) return `node_modules/${name}`;
    const prefix = `${directory}/node_modules/`;
    if (sourcePath.startsWith(prefix)) {
      return `node_modules/${name}/node_modules/${sourcePath.slice(prefix.length)}`;
    }
  }
  return sourcePath;
}

function assertManifestMatchesWorkspaceLock(name, manifest, workspaceEntry, directory) {
  assert.equal(manifest?.name, name, `${directory}/package.json name does not match the release graph`);
  assert.equal(workspaceEntry?.version, manifest.version, `${directory} version differs from package.json`);
  assert.deepEqual(
    workspaceEntry.dependencies ?? {},
    manifest.dependencies ?? {},
    `${directory} production dependencies differ from package.json`,
  );
  assert.deepEqual(
    workspaceEntry.optionalDependencies ?? {},
    manifest.optionalDependencies ?? {},
    `${directory} optional dependencies differ from package.json`,
  );
}

function lockedArchiveEntry(workspaceEntry, archive) {
  const selected = {
    version: workspaceEntry.version,
    resolved: `file:archives/${archive.file}`,
    integrity: archive.integrity,
  };
  for (const [key, value] of Object.entries(workspaceEntry)) {
    if (["name", "version", "dependencies", "optionalDependencies", "devDependencies"].includes(key)) continue;
    selected[key] = structuredClone(value);
  }
  if (workspaceEntry.dependencies !== undefined) selected.dependencies = structuredClone(workspaceEntry.dependencies);
  if (workspaceEntry.optionalDependencies !== undefined) {
    selected.optionalDependencies = structuredClone(workspaceEntry.optionalDependencies);
  }
  return selected;
}

function assertRegistryEntry(path, entry) {
  const name = packageNameFromLockPath(path);
  assert.match(entry.version ?? "", VERSION_PATTERN, `${path} has an invalid locked version`);
  assert.equal(
    entry.resolved,
    expectedRegistryUrl(name, entry.version),
    `Locked registry URL does not match ${name}@${entry.version}`,
  );
  assertSha512Integrity(entry.integrity, `${name}@${entry.version}`);
  assert.notEqual(entry.dev, true, `${name}@${entry.version} is development-only`);
  assert.notEqual(entry.peer, true, `${name}@${entry.version} is peer-only`);
  assert.notEqual(entry.link, true, `${name}@${entry.version} is a workspace link`);
}

export function createStandaloneProductionLock({ workspaceLock, packageManifests, archives }) {
  assert.equal(workspaceLock?.lockfileVersion, 3, "Standalone production locking requires package-lock v3");
  assert.ok(workspaceLock.packages !== null && typeof workspaceLock.packages === "object",
    "Committed package-lock is missing packages");
  const manifests = packageMap(packageManifests);
  const internalSources = new Map(RIGYN_PACKAGE_GRAPH.map(({ name, directory }) => [name, directory]));
  const archiveList = archives ?? [];
  assert.equal(archiveList.length, RIGYN_PACKAGE_GRAPH.length,
    "Release manifest must contain exactly one archive per package");
  const archiveMap = new Map(archiveList.map((archive) => [archive.name, archive]));
  assert.equal(archiveMap.size, RIGYN_PACKAGE_GRAPH.length, "Release manifest must contain one archive per package");
  assert.equal(new Set(archiveList.map(({ file }) => file)).size, RIGYN_PACKAGE_GRAPH.length,
    "Release manifest package archive filenames must be unique");

  const product = manifests.get("rigyn");
  assert.ok(product, "Missing rigyn package manifest");
  const rootDependencies = {};
  for (const { name, directory } of RIGYN_PACKAGE_GRAPH) {
    const manifest = manifests.get(name);
    const workspaceEntry = workspaceLock.packages[directory];
    const archive = archiveMap.get(name);
    assert.ok(manifest, `Missing package manifest for ${name}`);
    assert.ok(workspaceEntry, `Committed package-lock is missing ${directory}`);
    assert.ok(archive, `Release manifest is missing the ${name} archive`);
    assertManifestMatchesWorkspaceLock(name, manifest, workspaceEntry, directory);
    assert.equal(archive.version, manifest.version, `${name} archive version differs from package.json`);
    assert.match(archive.file ?? "", ARCHIVE_PATTERN, `${name} archive filename must be portable`);
    assert.equal(basename(archive.file), archive.file, `${name} archive filename must be a basename`);
    assertSha512Integrity(archive.integrity, `${name} archive`);
    rootDependencies[name] = `file:archives/${archive.file}`;
  }

  const selected = new Set();
  const pending = RIGYN_PACKAGE_GRAPH.map(({ directory }) => directory);
  while (pending.length > 0) {
    const path = pending.shift();
    if (selected.has(path)) continue;
    const entry = workspaceLock.packages[path];
    assert.ok(entry, `Committed package-lock is missing ${path}`);
    selected.add(path);
    for (const dependency of dependencyNames(entry)) {
      pending.push(resolveLockedDependency(workspaceLock.packages, path, dependency, internalSources));
    }
  }

  const projected = new Map();
  for (const sourcePath of selected) {
    const destination = destinationPath(sourcePath, internalSources);
    assert.equal(projected.has(destination), false, `Production lock path collision at ${destination}`);
    const internalName = [...internalSources].find(([, directory]) => directory === sourcePath)?.[0];
    if (internalName !== undefined) {
      projected.set(destination, lockedArchiveEntry(
        workspaceLock.packages[sourcePath],
        archiveMap.get(internalName),
      ));
      continue;
    }
    const entry = structuredClone(workspaceLock.packages[sourcePath]);
    assertRegistryEntry(destination, entry);
    projected.set(destination, entry);
  }

  const packages = {
    "": {
      name: LOCK_NAME,
      version: product.version,
      dependencies: rootDependencies,
      engines: structuredClone(product.engines),
    },
  };
  for (const path of [...projected.keys()].sort()) packages[path] = projected.get(path);
  const lock = {
    name: LOCK_NAME,
    version: product.version,
    lockfileVersion: 3,
    requires: true,
    packages,
  };
  assertStandaloneProductionLock(lock);
  return lock;
}

export function standaloneProductionPackageJson(lock) {
  assertStandaloneProductionLock(lock);
  const root = lock.packages[""];
  return {
    name: root.name,
    version: root.version,
    private: true,
    dependencies: structuredClone(root.dependencies),
    engines: structuredClone(root.engines),
  };
}

export function assertStandaloneProductionLock(lock) {
  assert.equal(lock?.name, LOCK_NAME, "Standalone production lock has an unexpected name");
  assert.match(lock?.version ?? "", VERSION_PATTERN, "Standalone production lock has an invalid version");
  assert.equal(lock?.lockfileVersion, 3, "Standalone production lock must use package-lock v3");
  assert.equal(lock?.requires, true, "Standalone production lock must require dependency resolution");
  assert.ok(lock.packages !== null && typeof lock.packages === "object" && !Array.isArray(lock.packages),
    "Standalone production lock is missing packages");
  const paths = Object.keys(lock.packages);
  assert.ok(paths.length > RIGYN_PACKAGE_GRAPH.length && paths.length <= MAX_LOCKED_PACKAGES,
    "Standalone production lock package count is invalid");
  const root = lock.packages[""];
  assert.equal(root?.name, lock.name, "Standalone production lock root name is invalid");
  assert.equal(root?.version, lock.version, "Standalone production lock root version is invalid");
  assert.deepEqual(
    Object.keys(root?.dependencies ?? {}),
    RIGYN_PACKAGE_GRAPH.map(({ name }) => name),
    "Standalone production lock root must contain the complete release graph",
  );

  for (const path of paths) {
    if (path === "") continue;
    assert.ok(path.startsWith("node_modules/") && !path.includes("\\")
      && path.split("/").every((component) => component !== "" && component !== "." && component !== ".."),
    `Standalone production lock contains an unsafe package path: ${path}`);
    const entry = lock.packages[path];
    const name = packageNameFromLockPath(path);
    assert.match(entry?.version ?? "", VERSION_PATTERN, `${path} has an invalid version`);
    assertSha512Integrity(entry?.integrity, `${name}@${entry?.version ?? "unknown"}`);
    assert.notEqual(entry.dev, true, `${path} is development-only`);
    assert.notEqual(entry.peer, true, `${path} is peer-only`);
    if (entry.resolved?.startsWith("file:archives/")) {
      assert.ok(RIGYN_PACKAGE_GRAPH.some(({ name: candidate }) => candidate === name),
        `Unexpected local archive in production lock: ${name}`);
      const archive = entry.resolved.slice("file:archives/".length);
      assert.match(archive, ARCHIVE_PATTERN, `Invalid local archive filename for ${name}`);
      assert.equal(basename(archive), archive,
        `Unsafe local archive path for ${name}`);
    } else {
      assertRegistryEntry(path, entry);
    }
  }

  const reached = new Set([""]);
  const pending = [""];
  while (pending.length > 0) {
    const path = pending.shift();
    for (const dependency of dependencyNames(lock.packages[path])) {
      const selected = resolveLockedDependency(lock.packages, path, dependency);
      if (reached.has(selected)) continue;
      reached.add(selected);
      pending.push(selected);
    }
  }
  assert.deepEqual([...reached].sort(), paths.sort(), "Standalone production lock contains unreachable packages");
}

function selectorAllows(selector, actual) {
  if (selector === undefined) return true;
  assert.ok(Array.isArray(selector) && selector.every((value) => typeof value === "string" && value !== ""),
    "Standalone production lock contains an invalid platform selector");
  const denied = selector.filter((value) => value.startsWith("!")).map((value) => value.slice(1));
  if (denied.includes(actual)) return false;
  const allowed = selector.filter((value) => !value.startsWith("!"));
  return allowed.length === 0 || allowed.includes(actual);
}

function packageApplies(entry, target) {
  return selectorAllows(entry.os, target.platform)
    && selectorAllows(entry.cpu, target.arch)
    && selectorAllows(entry.libc, target.libc ?? (target.platform === "linux" ? "glibc" : ""));
}

function targetProductionPaths(lock, target) {
  const reached = new Set([""]);
  const pending = [""];
  while (pending.length > 0) {
    const path = pending.shift();
    for (const dependency of dependencyNames(lock.packages[path])) {
      const selected = resolveLockedDependency(lock.packages, path, dependency);
      const entry = lock.packages[selected];
      if (!packageApplies(entry, target)) {
        assert.equal(entry.optional, true,
          `${packageNameFromLockPath(selected)} is required but incompatible with ${target.platform}/${target.arch}`);
        continue;
      }
      if (reached.has(selected)) continue;
      reached.add(selected);
      pending.push(selected);
    }
  }
  return reached;
}

async function readInstalledManifest(packageRoot, path) {
  const manifestPath = resolve(packageRoot, "package.json");
  const metadata = await stat(manifestPath);
  assert.ok(metadata.isFile() && metadata.size > 0 && metadata.size <= MAX_PACKAGE_MANIFEST_BYTES,
    `Installed package ${path} has an invalid package.json`);
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

async function installedProductionGraph(modulesRoot) {
  const root = resolve(modulesRoot);
  const installed = new Map();
  const scanModules = async (directory, prefix) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".bin" || entry.name === ".package-lock.json") continue;
      const entryPath = resolve(directory, entry.name);
      const metadata = await lstat(entryPath);
      assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink(),
        `Installed production graph contains a non-directory package entry: ${entryPath}`);
      if (entry.name.startsWith("@")) {
        const scoped = await readdir(entryPath, { withFileTypes: true });
        for (const child of scoped.sort((left, right) => left.name.localeCompare(right.name))) {
          const childRoot = resolve(entryPath, child.name);
          const childMetadata = await lstat(childRoot);
          assert.ok(childMetadata.isDirectory() && !childMetadata.isSymbolicLink(),
            `Installed production graph contains an invalid scoped package: ${childRoot}`);
          const path = `${prefix}/${entry.name}/${child.name}`;
          const manifest = await readInstalledManifest(childRoot, path);
          installed.set(path, manifest);
          const nested = resolve(childRoot, "node_modules");
          try {
            if ((await stat(nested)).isDirectory()) await scanModules(nested, `${path}/node_modules`);
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
          }
        }
        continue;
      }
      const path = `${prefix}/${entry.name}`;
      const manifest = await readInstalledManifest(entryPath, path);
      installed.set(path, manifest);
      const nested = resolve(entryPath, "node_modules");
      try {
        if ((await stat(nested)).isDirectory()) await scanModules(nested, `${path}/node_modules`);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  };
  await scanModules(root, "node_modules");
  return installed;
}

export async function assertStandaloneProductionGraph(modulesRoot, lock, target = {
  platform: process.platform,
  arch: process.arch,
  }) {
  assertStandaloneProductionLock(lock);
  const installed = await installedProductionGraph(modulesRoot);
  const expected = targetProductionPaths(lock, target);
  for (const [path, manifest] of installed) {
    const locked = lock.packages[path];
    assert.ok(locked, `Installed package ${manifest.name ?? path} is not present in the production lock`);
    assert.ok(expected.has(path), `Installed package ${manifest.name ?? path} is not present in the target production graph`);
    const expectedName = packageNameFromLockPath(path);
    assert.equal(manifest.name, expectedName, `${path} package name differs from the production lock`);
    assert.equal(manifest.version, locked.version, `${expectedName} installed version differs from the production lock`);
    assert.equal(packageApplies(locked, target), true, `${expectedName} is not valid for ${target.platform}/${target.arch}`);
  }
  for (const path of expected) {
    if (path === "") continue;
    assert.ok(installed.has(path), `Standalone production graph is missing locked package ${packageNameFromLockPath(path)}`);
  }
  return installed;
}
