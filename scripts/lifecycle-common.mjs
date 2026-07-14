import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, relative, resolve, sep, win32 } from "node:path";

export const INSTALLATION_MARKER = ".installation.json";
export const INSTALL_TRANSACTION = ".install-transaction.json";
export const RUNTIME_LEASE_DIRECTORY = ".runtime-leases";
export const UNINSTALL_RECORD_SUFFIX = ".uninstall.json";
export const UNINSTALL_TOMBSTONE_SUFFIX = ".uninstalling";

const PRODUCT = "rigyn";
const LOCK_SCHEMA_VERSION = 1;
const MARKER_SCHEMA_VERSION = 2;
const MAX_CONTROL_FILE_BYTES = 16 * 1024;
const INVALID_LOCK_STALE_MS = 5 * 60_000;
const LOCK_WAIT_MS = 50;
const LOCK_TIMEOUT_MS = 30_000;
const managedCommandMarker = "# rigyn managed command";

function errno(error) {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

export async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    throw error;
  }
}

export async function resolveNpmInvocation(args, options = {}) {
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const environment = options.environment ?? process.env;
  if (platform !== "win32") {
    return environment.npm_execpath
      ? { command: execPath, args: [environment.npm_execpath, ...args] }
      : { command: "npm", args };
  }
  const candidates = [
    environment.npm_execpath,
    join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    resolve(dirname(execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((value) => value !== undefined && value !== "").map((value) => resolve(value));
  for (const candidate of candidates) {
    try {
      if ((await lstat(candidate)).isFile()) {
        return { command: execPath, args: [candidate, ...args] };
      }
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
    }
  }
  throw new Error("npm requires npm-cli.js to be installed beside Node.js on Windows");
}

export function inside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

async function physicalCreationTarget(target) {
  let existing = resolve(target);
  const missing = [];
  while (!(await exists(existing))) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error(`Install path has no existing ancestor: ${target}`);
    missing.unshift(basename(existing));
    existing = parent;
  }
  return resolve(await realpath(existing), ...missing);
}

export async function assertProtectedInstallRoot(installRoot, options = {}) {
  const root = resolve(installRoot);
  const physicalRoot = await physicalCreationTarget(root);
  const filesystemRoot = parse(physicalRoot).root;
  if (physicalRoot === filesystemRoot) throw new Error(`Install directory cannot be the filesystem root: ${root}`);

  const physicalHome = await realpath(homedir());
  if (inside(physicalRoot, physicalHome)) {
    throw new Error(`Install directory cannot be the user home or one of its ancestors: ${root}`);
  }

  if (options.sourceCheckout === true && options.projectRoot !== undefined) {
    const physicalProject = await realpath(options.projectRoot);
    if (inside(physicalProject, physicalRoot) || inside(physicalRoot, physicalProject)) {
      throw new Error(`Install directory must not overlap the source checkout: ${root}`);
    }
  }

  if (options.callerCwd !== undefined) {
    let physicalCwd;
    try {
      physicalCwd = await realpath(options.callerCwd);
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
    }
    if (physicalCwd !== undefined && inside(physicalRoot, physicalCwd)) {
      throw new Error(`Run the lifecycle command from outside the installation directory: ${root}`);
    }
  }
}

export function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

export function installationPaths(installRoot) {
  const root = resolve(installRoot);
  const launcher = join(root, "bin", process.platform === "win32" ? "rigyn.cmd" : "rigyn");
  const command = process.platform === "win32"
    ? launcher
    : join(homedir(), ".local", "bin", "rigyn");
  return { root, launcher, command };
}

export function posixLauncher(installRoot) {
  return `#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export RIGYN_INSTALL_DIR="$ROOT"
export XDG_CONFIG_HOME="$ROOT/config"
export XDG_STATE_HOME="$ROOT/state"
export XDG_CACHE_HOME="$ROOT/cache"
export XDG_DATA_HOME="$ROOT/data"
export TMPDIR="$ROOT/tmp"
export TMP="$ROOT/tmp"
export TEMP="$ROOT/tmp"

exec "$ROOT/app/node_modules/.bin/rigyn" "$@"
`;
}

export function windowsLauncher() {
  return `@echo off\r
set "ROOT=%~dp0.."\r
set "RIGYN_INSTALL_DIR=%ROOT%"\r
set "XDG_CONFIG_HOME=%ROOT%\\config"\r
set "XDG_STATE_HOME=%ROOT%\\state"\r
set "XDG_CACHE_HOME=%ROOT%\\cache"\r
set "XDG_DATA_HOME=%ROOT%\\data"\r
set "TMPDIR=%ROOT%\\tmp"\r
set "TMP=%ROOT%\\tmp"\r
set "TEMP=%ROOT%\\tmp"\r
"%ROOT%\\app\\node_modules\\.bin\\rigyn.cmd" %*\r
`;
}

export function managedCommand(launcher) {
  return `#!/usr/bin/env sh
${managedCommandMarker}
exec '${launcher.replaceAll("'", `'"'"'`)}' "$@"
`;
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function nonempty(value) {
  return typeof value === "string" && value !== "";
}

export function parseInstallationMarker(value, installRoot) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Install marker must be an object");
  }
  const marker = value;
  if (marker.product !== PRODUCT) throw new Error("Install marker product is not recognized");
  if (marker.schemaVersion === 1) {
    if (!exactKeys(marker, ["product", "schemaVersion", "version", "commandLink"]) || !nonempty(marker.version) || !nonempty(marker.commandLink)) {
      throw new Error("Legacy install marker is invalid");
    }
    return {
      product: PRODUCT,
      schemaVersion: 1,
      version: marker.version,
      commandLink: resolve(marker.commandLink),
    };
  }
  if (marker.schemaVersion !== MARKER_SCHEMA_VERSION || !exactKeys(marker, [
    "product",
    "schemaVersion",
    "installationId",
    "installRoot",
    "version",
    "launcherPath",
    "launcherSha256",
    "commandLink",
    "commandSha256",
  ])) throw new Error("Install marker schema is not recognized");
  if (!/^[a-f0-9]{32}$/u.test(marker.installationId)
    || !nonempty(marker.version)
    || !/^[a-f0-9]{64}$/u.test(marker.launcherSha256)
    || !/^[a-f0-9]{64}$/u.test(marker.commandSha256)) {
    throw new Error("Install marker ownership fields are invalid");
  }
  const paths = installationPaths(installRoot);
  if (resolve(marker.installRoot) !== paths.root
    || resolve(marker.launcherPath) !== paths.launcher
    || resolve(marker.commandLink) !== paths.command) {
    throw new Error("Install marker paths do not match this installation");
  }
  return {
    product: PRODUCT,
    schemaVersion: MARKER_SCHEMA_VERSION,
    installationId: marker.installationId,
    installRoot: paths.root,
    version: marker.version,
    launcherPath: paths.launcher,
    launcherSha256: marker.launcherSha256,
    commandLink: paths.command,
    commandSha256: marker.commandSha256,
  };
}

async function readBounded(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_CONTROL_FILE_BYTES) {
    throw new Error(`${label} must be a bounded regular file: ${path}`);
  }
  return await readFile(path, "utf8");
}

async function readBoundedJson(path, label) {
  let contents;
  try {
    contents = await readBounded(path, label);
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
  try {
    return { value: JSON.parse(contents), contents };
  } catch (error) {
    throw new Error(`${label} is invalid: ${path}`, { cause: error });
  }
}

export async function readInstallationMarker(storageRoot, expectedInstallRoot = storageRoot) {
  const path = join(resolve(storageRoot), INSTALLATION_MARKER);
  const record = await readBoundedJson(path, "Install marker");
  return record === undefined
    ? undefined
    : { marker: parseInstallationMarker(record.value, expectedInstallRoot), contents: record.contents };
}

async function fileDigest(path, label, allowMissing) {
  try {
    return sha256(await readBounded(path, label));
  } catch (error) {
    if (allowMissing && errno(error) === "ENOENT") return undefined;
    throw error;
  }
}

export async function assertOwnedLaunchers(installRoot, marker, options = {}) {
  const paths = installationPaths(installRoot);
  if (marker.commandLink !== paths.command) throw new Error("Install marker command path does not match this installation");
  if (marker.schemaVersion === 1) {
    const launcherExpected = process.platform === "win32" ? windowsLauncher() : posixLauncher(paths.root);
    const commandExpected = process.platform === "win32" ? launcherExpected : managedCommand(paths.launcher);
    const launcher = await readBounded(paths.launcher, "Install launcher").catch((error) => {
      if (options.allowMissing === true && errno(error) === "ENOENT") return undefined;
      throw error;
    });
    const command = paths.command === paths.launcher
      ? launcher
      : await readBounded(paths.command, "Managed command").catch((error) => {
        if (options.allowMissing === true && errno(error) === "ENOENT") return undefined;
        throw error;
      });
    if (launcher !== undefined && launcher !== launcherExpected) throw new Error(`Install launcher ownership check failed: ${paths.launcher}`);
    if (command !== undefined && command !== commandExpected) throw new Error(`Managed command ownership check failed: ${paths.command}`);
    return;
  }
  const launcherDigest = await fileDigest(paths.launcher, "Install launcher", options.allowMissing === true);
  const commandDigest = paths.command === paths.launcher
    ? launcherDigest
    : await fileDigest(paths.command, "Managed command", options.allowMissing === true);
  if (launcherDigest !== undefined && launcherDigest !== marker.launcherSha256) {
    throw new Error(`Install launcher ownership check failed: ${paths.launcher}`);
  }
  if (commandDigest !== undefined && commandDigest !== marker.commandSha256) {
    throw new Error(`Managed command ownership check failed: ${paths.command}`);
  }
}

export function createInstallationMarker(installRoot, version, contents, previous) {
  const paths = installationPaths(installRoot);
  const installationId = previous?.schemaVersion === MARKER_SCHEMA_VERSION
    ? previous.installationId
    : randomBytes(16).toString("hex");
  return {
    product: PRODUCT,
    schemaVersion: MARKER_SCHEMA_VERSION,
    installationId,
    installRoot: paths.root,
    version,
    launcherPath: paths.launcher,
    launcherSha256: sha256(contents.launcher),
    commandLink: paths.command,
    commandSha256: sha256(contents.command),
  };
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errno(error) !== "ESRCH" && errno(error) !== "ERR_OUT_OF_RANGE";
  }
}

function lockOwner(value, installRoot) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || !exactKeys(value, ["schemaVersion", "pid", "token", "createdAt", "installRoot"])
    || value.schemaVersion !== LOCK_SCHEMA_VERSION
    || !Number.isSafeInteger(value.pid) || value.pid < 1
    || !/^[a-f0-9]{32}$/u.test(value.token)
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || resolve(value.installRoot) !== resolve(installRoot)) return undefined;
  return value;
}

async function removeLockIfOwned(path, token) {
  let value;
  try {
    value = JSON.parse(await readBounded(path, "Lifecycle lock"));
  } catch (error) {
    if (errno(error) === "ENOENT") return;
    throw error;
  }
  if (value?.token === token) await rm(path, { force: true });
}

async function quarantineStaleLock(path, expectedContents) {
  const quarantine = `${path}.stale-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await rename(path, quarantine);
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    throw error;
  }
  try {
    const actual = await readBounded(quarantine, "Lifecycle lock");
    if (actual === expectedContents) return true;
    if (!(await exists(path))) await rename(quarantine, path);
    return false;
  } finally {
    await rm(quarantine, { force: true });
  }
}

export async function withLifecycleLock(installRoot, operation) {
  const root = resolve(installRoot);
  const path = `${root}.lifecycle.lock`;
  const delegatedToken = process.env.RIGYN_LIFECYCLE_LOCK_LEASE;
  if (/^[a-f0-9]{32}$/u.test(delegatedToken ?? "")) {
    try {
      const existing = lockOwner(JSON.parse(await readBounded(path, "Lifecycle lock")), root);
      if (existing?.token === delegatedToken && existing.pid === process.ppid && processExists(existing.pid)) {
        return await operation();
      }
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
    }
  }

  const owner = {
    schemaVersion: LOCK_SCHEMA_VERSION,
    pid: process.pid,
    token: randomBytes(16).toString("hex"),
    createdAt: Date.now(),
    installRoot: root,
  };
  const startedAt = Date.now();
  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
      let existing;
      let stale = false;
      let contents;
      try {
        contents = await readBounded(path, "Lifecycle lock");
        existing = lockOwner(JSON.parse(contents), root);
        stale = existing === undefined
          ? Date.now() - (await lstat(path)).mtimeMs > INVALID_LOCK_STALE_MS
          : !processExists(existing.pid);
      } catch (readError) {
        if (errno(readError) === "ENOENT") continue;
        try {
          contents = await readBounded(path, "Lifecycle lock");
        } catch (retryError) {
          if (errno(retryError) === "ENOENT") continue;
          contents = undefined;
        }
        stale = Date.now() - (await lstat(path)).mtimeMs > INVALID_LOCK_STALE_MS;
      }
      if (stale && contents !== undefined && await quarantineStaleLock(path, contents)) {
        continue;
      }
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for another Rigyn lifecycle operation at ${root}`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, LOCK_WAIT_MS));
    }
  }

  const previousLease = process.env.RIGYN_LIFECYCLE_LOCK_LEASE;
  process.env.RIGYN_LIFECYCLE_LOCK_LEASE = owner.token;
  try {
    return await operation();
  } finally {
    if (previousLease === undefined) delete process.env.RIGYN_LIFECYCLE_LOCK_LEASE;
    else process.env.RIGYN_LIFECYCLE_LOCK_LEASE = previousLease;
    await removeLockIfOwned(path, owner.token);
  }
}

function uninstallRecord(value, installRoot) {
  const root = resolve(installRoot);
  const paths = installationPaths(root);
  const tombstone = `${root}${UNINSTALL_TOMBSTONE_SUFFIX}`;
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || !exactKeys(value, [
      "product",
      "schemaVersion",
      "installRoot",
      "tombstone",
      "markerSha256",
      "commandLink",
      "commandSha256",
    ])
    || value.product !== PRODUCT
    || value.schemaVersion !== 1
    || resolve(value.installRoot) !== root
    || resolve(value.tombstone) !== tombstone
    || !/^[a-f0-9]{64}$/u.test(value.markerSha256)
    || resolve(value.commandLink) !== paths.command
    || !/^[a-f0-9]{64}$/u.test(value.commandSha256)) {
    throw new Error(`Uninstall transaction is invalid: ${root}${UNINSTALL_RECORD_SUFFIX}`);
  }
  return {
    product: PRODUCT,
    schemaVersion: 1,
    installRoot: root,
    tombstone,
    markerSha256: value.markerSha256,
    commandLink: paths.command,
    commandSha256: value.commandSha256,
  };
}

export function createUninstallRecord(installRoot, markerContents, commandContents) {
  const paths = installationPaths(installRoot);
  return {
    product: PRODUCT,
    schemaVersion: 1,
    installRoot: paths.root,
    tombstone: `${paths.root}${UNINSTALL_TOMBSTONE_SUFFIX}`,
    markerSha256: sha256(markerContents),
    commandLink: paths.command,
    commandSha256: sha256(commandContents),
  };
}

export async function recoverInterruptedUninstall(installRoot) {
  const root = resolve(installRoot);
  const recordPath = `${root}${UNINSTALL_RECORD_SUFFIX}`;
  const recordJson = await readBoundedJson(recordPath, "Uninstall transaction");
  if (recordJson === undefined) return false;
  const record = uninstallRecord(recordJson.value, root);
  const rootExists = await exists(root);
  const tombstoneExists = await exists(record.tombstone);
  if (rootExists && tombstoneExists) {
    throw new Error("Interrupted uninstall has both active and tombstone directories");
  }
  if (rootExists || !tombstoneExists) {
    await rm(recordPath, { force: true });
    return false;
  }

  const tombstoneMetadata = await lstat(record.tombstone);
  if (!tombstoneMetadata.isDirectory() || tombstoneMetadata.isSymbolicLink()) {
    throw new Error(`Interrupted uninstall tombstone is unsafe: ${record.tombstone}`);
  }
  const markerRecord = await readInstallationMarker(record.tombstone, root);
  if (markerRecord === undefined || sha256(markerRecord.contents) !== record.markerSha256) {
    throw new Error(`Interrupted uninstall tombstone is not owned by this installation: ${record.tombstone}`);
  }
  await assertOwnedLaunchers(record.tombstone, {
    ...markerRecord.marker,
    installRoot: record.tombstone,
    launcherPath: installationPaths(record.tombstone).launcher,
    commandLink: process.platform === "win32" ? installationPaths(record.tombstone).command : record.commandLink,
  }, { allowMissing: true });
  await assertNoOtherActiveRuntimes(record.tombstone, markerRecord.marker);
  if (process.platform !== "win32" && await exists(record.commandLink)) {
    const digest = await fileDigest(record.commandLink, "Managed command", false);
    if (digest !== record.commandSha256) {
      throw new Error(`Interrupted uninstall command ownership check failed: ${record.commandLink}`);
    }
    await rm(record.commandLink, { force: true });
  }
  await rm(record.tombstone, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  await rm(recordPath, { force: true });
  return true;
}

function runtimeLease(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || !exactKeys(value, ["schemaVersion", "pid", "lease", "createdAt", "installationId"])
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.pid) || value.pid < 1
    || !/^[a-f0-9]{32}$/u.test(value.lease)
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || !/^[a-f0-9]{32}$/u.test(value.installationId)) return undefined;
  return value;
}

export async function assertNoOtherActiveRuntimes(leaseRoot, marker) {
  if (marker.schemaVersion !== MARKER_SCHEMA_VERSION) return;
  const directory = join(resolve(leaseRoot), RUNTIME_LEASE_DIRECTORY);
  let entries;
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Runtime lease path is unsafe: ${directory}`);
    entries = await readdir(directory);
  } catch (error) {
    if (errno(error) === "ENOENT") return;
    throw error;
  }

  const callerPid = Number(process.env.RIGYN_LIFECYCLE_CALLER_PID);
  const callerLease = process.env.RIGYN_LIFECYCLE_CALLER_LEASE;
  const live = [];
  for (const entry of entries) {
    if (!/^[a-f0-9]{32}\.json$/u.test(entry)) continue;
    const path = join(directory, entry);
    let lease;
    try {
      lease = runtimeLease(JSON.parse(await readBounded(path, "Runtime lease")));
    } catch (error) {
      if (errno(error) === "ENOENT") continue;
    }
    if (lease === undefined) {
      let metadata;
      try {
        metadata = await lstat(path);
      } catch (error) {
        if (errno(error) === "ENOENT") continue;
        throw error;
      }
      if (Date.now() - metadata.mtimeMs > INVALID_LOCK_STALE_MS) await rm(path, { force: true });
      else live.push(`invalid:${entry}`);
      continue;
    }
    if (!processExists(lease.pid)) {
      await rm(path, { force: true });
      continue;
    }
    if (lease.installationId === marker.installationId
      && lease.pid === callerPid
      && lease.lease === callerLease) continue;
    live.push(String(lease.pid));
  }
  if (live.length > 0) {
    throw new Error(`Close the other running Rigyn process${live.length === 1 ? "" : "es"} before continuing (${live.join(", ")})`);
  }
}

export async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Managed install path must be a real directory: ${path}`);
  }
  if (process.platform !== "win32") await chmod(path, 0o700);
}

export async function writeFileAtomically(path, contents, mode) {
  const temporary = `${path}.install-${process.pid}-${randomBytes(6).toString("hex")}`;
  let handle;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== "win32") await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export function lifecycleProcessTreeTerminationPlan(pid, signal, options = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new RangeError("Lifecycle process-tree PID must be a positive safe integer");
  }
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { kind: "group", pid: -pid, signal };
  const environment = options.environment ?? process.env;
  const root = environment.SystemRoot ?? environment.WINDIR;
  if (root !== undefined && !root.includes("\0") && /^[A-Za-z]:[\\/]/u.test(root)) {
    return {
      kind: "taskkill",
      command: win32.join(win32.resolve(root), "System32", "taskkill.exe"),
      args: ["/PID", String(pid), "/T", "/F"],
      fallbackPid: pid,
      fallbackSignal: signal,
    };
  }
  return { kind: "direct", pid, signal };
}

export function terminateLifecycleProcessTree(pid, signal, options = {}) {
  const plan = lifecycleProcessTreeTerminationPlan(pid, signal, options);
  const kill = options.kill ?? ((target, selectedSignal) => process.kill(target, selectedSignal));
  if (plan.kind === "taskkill") {
    try {
      const result = (options.spawnSync ?? spawnSync)(plan.command, plan.args, {
        shell: false,
        stdio: "ignore",
        timeout: 2_000,
        windowsHide: true,
      });
      if (result.error === undefined && result.status === 0) return true;
    } catch {}
    try {
      kill(plan.fallbackPid, plan.fallbackSignal);
      return true;
    } catch {
      return false;
    }
  }
  try {
    kill(plan.pid, plan.signal);
    return true;
  } catch {
    return false;
  }
}

export async function runLifecycleChild(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });
  let receivedSignal;
  let escalation;
  const stop = (signal = "SIGTERM") => {
    if (child.pid === undefined) return;
    receivedSignal ??= signal;
    if (process.platform === "win32") {
      terminateLifecycleProcessTree(child.pid, signal, {
        kill: (_target, selectedSignal) => child.kill(selectedSignal),
      });
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (errno(error) !== "ESRCH") throw error;
    }
    if (escalation === undefined) {
      escalation = setTimeout(() => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (errno(error) !== "ESRCH") throw error;
        }
      }, 5_000);
      escalation.unref();
    }
  };
  const signals = ["SIGINT", "SIGTERM", ...(process.platform === "win32" ? [] : ["SIGHUP"])];
  const handlers = new Map(signals.map((signal) => [signal, () => stop(signal)]));
  for (const [signal, handler] of handlers) process.once(signal, handler);
  try {
    const code = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });
    if (receivedSignal !== undefined) throw new Error(`${options.label} interrupted by ${receivedSignal}`);
    if (code !== 0) throw new Error(`${options.label} failed with exit ${code}`);
  } finally {
    if (escalation !== undefined) clearTimeout(escalation);
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}
