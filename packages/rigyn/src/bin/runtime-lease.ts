import { createHash, randomBytes } from "node:crypto";
import { rmdirSync, rmSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const MARKER = ".installation.json";
const LEASE_DIRECTORY = ".runtime-leases";
const MAX_MARKER_BYTES = 16 * 1024;
const STANDALONE_RUNTIME_NAME = /^rigyn-v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?-(?:linux|darwin|win32)-(?:x64|arm64)$/u;

function errno(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errno(error) !== "ESRCH" && errno(error) !== "ERR_OUT_OF_RANGE";
  }
}

async function lifecycleInProgress(path: string, installRoot: string): Promise<boolean> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_MARKER_BYTES) return true;
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const keys = Object.keys(value).sort();
    const expectedKeys = ["schemaVersion", "pid", "token", "createdAt", "installRoot"].sort();
    if (keys.length !== expectedKeys.length || !keys.every((key, index) => key === expectedKeys[index])
      || value.schemaVersion !== 1
      || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1
      || typeof value.token !== "string" || !/^[a-f0-9]{32}$/u.test(value.token)
      || !Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0
      || typeof value.installRoot !== "string" || resolve(value.installRoot) !== installRoot) return true;
    return processExists(Number(value.pid));
  } catch {
    return true;
  }
}

interface InstalledMarker {
  product: "rigyn";
  schemaVersion: 2;
  installationId: string;
  installRoot: string;
  version: string;
  launcherPath: string;
  launcherSha256: string;
  commandLink: string;
  commandSha256: string;
}

export function standaloneRuntimeInstallationId(installRoot: string): string {
  const canonical = resolve(installRoot);
  const identity = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  return createHash("sha256")
    .update("rigyn-standalone-installation-v1\0")
    .update(identity)
    .digest("hex")
    .slice(0, 32);
}

function standaloneInstallRoot(): string | undefined {
  const configured = process.env.RIGYN_INSTALL_DIR;
  if (configured !== undefined && configured !== "") return resolve(configured);
  const runtimeRoot = resolve(dirname(process.execPath), "..");
  if (
    basename(dirname(runtimeRoot)) !== "runtime" ||
    !STANDALONE_RUNTIME_NAME.test(basename(runtimeRoot))
  ) return undefined;
  return resolve(runtimeRoot, "../..");
}

async function installedMarker(installRoot: string): Promise<InstalledMarker | undefined> {
  const path = join(installRoot, MARKER);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_MARKER_BYTES) {
    throw new Error(`Installed rigyn marker is unsafe: ${path}`);
  }
  const value = JSON.parse(await readFile(path, "utf8")) as Partial<InstalledMarker>;
  if (value.product !== "rigyn" || value.schemaVersion !== 2) return undefined;
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "product",
    "schemaVersion",
    "installationId",
    "installRoot",
    "version",
    "launcherPath",
    "launcherSha256",
    "commandLink",
    "commandSha256",
  ].sort();
  if (keys.length !== expectedKeys.length || !keys.every((key, index) => key === expectedKeys[index])
    || !/^[a-f0-9]{32}$/u.test(value.installationId ?? "")
    || resolve(value.installRoot ?? "") !== installRoot
    || typeof value.version !== "string" || value.version === ""
    || typeof value.launcherPath !== "string" || value.launcherPath === ""
    || !/^[a-f0-9]{64}$/u.test(value.launcherSha256 ?? "")
    || typeof value.commandLink !== "string" || value.commandLink === ""
    || !/^[a-f0-9]{64}$/u.test(value.commandSha256 ?? "")) {
    throw new Error(`Installed rigyn marker is invalid: ${path}`);
  }
  return value as InstalledMarker;
}

export interface RuntimeLease {
  release(): Promise<void>;
}

export async function acquireRuntimeLease(): Promise<RuntimeLease | undefined> {
  const standalone = process.env.RIGYN_DISTRIBUTION === "standalone";
  const configuredRoot = process.env.RIGYN_INSTALL_DIR;
  const installRoot = standalone
    ? standaloneInstallRoot()
    : configuredRoot === undefined || configuredRoot === "" ? undefined : resolve(configuredRoot);
  if (installRoot === undefined) return undefined;
  const marker = standalone
    ? { installationId: standaloneRuntimeInstallationId(installRoot) }
    : await installedMarker(installRoot);
  if (marker === undefined) return undefined;
  const lockPath = `${installRoot}.lifecycle.lock`;
  if (await lifecycleInProgress(lockPath, installRoot)) {
    throw new Error("A rigyn install, update, or uninstall operation is in progress");
  }

  const directory = join(installRoot, LEASE_DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryMetadata = await lstat(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new Error(`Runtime lease path is unsafe: ${directory}`);
  }
  if (process.platform !== "win32") await chmod(directory, 0o700);

  const lease = randomBytes(16).toString("hex");
  const path = join(directory, `${lease}.json`);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      lease,
      createdAt: Date.now(),
      installationId: marker.installationId,
    })}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  if (await lifecycleInProgress(lockPath, installRoot)) {
    await rm(path, { force: true });
    if (standalone) await rmdir(directory).catch(() => undefined);
    throw new Error("A rigyn install, update, or uninstall operation is in progress");
  }

  const previousPid = process.env.RIGYN_LIFECYCLE_CALLER_PID;
  const previousLease = process.env.RIGYN_LIFECYCLE_CALLER_LEASE;
  const previousInstallRoot = process.env.RIGYN_INSTALL_DIR;
  if (standalone && (previousInstallRoot === undefined || previousInstallRoot === "")) {
    process.env.RIGYN_INSTALL_DIR = installRoot;
  }
  process.env.RIGYN_LIFECYCLE_CALLER_PID = String(process.pid);
  process.env.RIGYN_LIFECYCLE_CALLER_LEASE = lease;
  let released = false;
  const cleanupSync = (): void => {
    if (released) return;
    released = true;
    rmSync(path, { force: true });
    if (standalone) {
      try {
        rmdirSync(directory);
      } catch {}
    }
  };
  process.once("exit", cleanupSync);

  return {
    async release(): Promise<void> {
      if (!released) {
        released = true;
        process.off("exit", cleanupSync);
        await rm(path, { force: true });
        if (standalone) await rmdir(directory).catch(() => undefined);
      }
      if (previousPid === undefined) delete process.env.RIGYN_LIFECYCLE_CALLER_PID;
      else process.env.RIGYN_LIFECYCLE_CALLER_PID = previousPid;
      if (previousLease === undefined) delete process.env.RIGYN_LIFECYCLE_CALLER_LEASE;
      else process.env.RIGYN_LIFECYCLE_CALLER_LEASE = previousLease;
      if (previousInstallRoot === undefined) delete process.env.RIGYN_INSTALL_DIR;
      else process.env.RIGYN_INSTALL_DIR = previousInstallRoot;
    },
  };
}
