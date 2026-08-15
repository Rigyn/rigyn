import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { getAuthPath } from "../config/paths.js";
import { AuthStorage } from "./auth-storage.js";
import { CrossProcessFileLock, EncryptedFileCredentialStore } from "./file-store.js";
import {
  KeychainCredentialStore,
  PlatformKeychainAdapter,
  probePlatformKeychain,
  type KeychainAdapter,
} from "./keychain.js";
import { retainMacosKeychainHelper } from "./macos-keychain-helper.js";
import { CredentialProfileManager } from "./profiles.js";
import {
  assertCredentialId,
  isCredentialProfileMetadataStore,
  type AuthCredential,
  type CredentialStore,
} from "./types.js";
import {
  protectWindowsCredentialKey,
  unprotectWindowsCredentialKey,
} from "./windows-dpapi.js";

const KEYCHAIN_SERVICE_PREFIX = "rigyn-credentials-v2";
const BACKEND_MARKER_VERSION = 1;
const LINUX_KEYCHAIN_BACKEND = "linux-secret-service-v1";
const MACOS_KEYCHAIN_BACKEND = "macos-keychain-v1";
const WINDOWS_ENCRYPTED_BACKEND = "windows-dpapi-file-v1";
const MIGRATION_LOCK_ID = "credential-store-migration-v1";
const MAX_KEY_ENVELOPE_BYTES = 16 * 1024;
const MAX_BACKEND_MARKER_BYTES = 256;

type CredentialBackend =
  | typeof LINUX_KEYCHAIN_BACKEND
  | typeof MACOS_KEYCHAIN_BACKEND
  | typeof WINDOWS_ENCRYPTED_BACKEND;

interface WindowsKeyProtector {
  protect(key: Uint8Array): Promise<string>;
  unprotect(envelope: string): Promise<Buffer>;
}

export interface DefaultCredentialStoreOptions {
  createLocalKey?: boolean;
  environment?: NodeJS.ProcessEnv;
  allowPlatformKeychain?: boolean;
  /** @internal */
  platform?: NodeJS.Platform;
  /** @internal */
  keychainAdapter?: KeychainAdapter;
  /** @internal */
  windowsKeyProtector?: WindowsKeyProtector;
}

interface CredentialStoreLocation {
  authPath: string;
  markerPath: string;
  selectionLockPath: string;
  keychainLockPath: string;
  keychainService: string;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
  label: string,
): Promise<string | undefined> {
  let pathInformation;
  try {
    pathInformation = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!pathInformation.isFile() || pathInformation.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
  const handle = await open(path, "r");
  try {
    const information = await handle.stat();
    if (
      !information.isFile() ||
      information.size > maximumBytes ||
      information.dev !== pathInformation.dev ||
      information.ino !== pathInformation.ino
    ) {
      throw new Error(`${label} changed while it was being opened`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!new Set(["EINVAL", "ENOTSUP", "EPERM", "EISDIR"]).has((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
  }
}

async function writePrivateFile(path: string, value: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(value, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readKeyEnvelope(path: string): Promise<string | undefined> {
  return (await readBoundedRegularFile(path, MAX_KEY_ENVELOPE_BYTES, "Credential key envelope"))?.trim();
}

async function writeKeyEnvelope(path: string, envelope: string): Promise<void> {
  if (envelope === "" || envelope.includes("\0") || Buffer.byteLength(envelope, "utf8") > MAX_KEY_ENVELOPE_BYTES) {
    throw new Error("Credential key envelope is invalid");
  }
  await writePrivateFile(path, `${envelope}\n`);
}

async function canonicalCredentialStorePath(authPath: string): Promise<string> {
  const selected = resolve(authPath);
  const unresolved = [basename(selected)];
  let ancestor = dirname(selected);
  while (true) {
    try {
      return join(await realpath(ancestor), ...unresolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) return selected;
      unresolved.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

async function credentialStoreLocation(authPath: string): Promise<CredentialStoreLocation> {
  const canonical = await canonicalCredentialStorePath(authPath);
  const identity = createHash("sha256")
    .update("rigyn-credential-store-v2\0")
    .update(canonical)
    .digest("hex")
    .slice(0, 32);
  return {
    authPath: canonical,
    markerPath: `${canonical}.backend`,
    selectionLockPath: `${canonical}.backend.lock`,
    keychainLockPath: `${canonical}.keychain.lock`,
    keychainService: `${KEYCHAIN_SERVICE_PREFIX}:${identity}`,
  };
}

async function readBackendMarker(path: string): Promise<CredentialBackend | undefined> {
  const serialized = await readBoundedRegularFile(path, MAX_BACKEND_MARKER_BYTES, "Credential backend marker");
  if (serialized === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new Error("Credential backend marker is not valid JSON", { cause: error });
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).version !== BACKEND_MARKER_VERSION ||
    ![LINUX_KEYCHAIN_BACKEND, MACOS_KEYCHAIN_BACKEND, WINDOWS_ENCRYPTED_BACKEND].includes(
      String((value as Record<string, unknown>).backend),
    ) ||
    !Object.keys(value).every((name) => name === "version" || name === "backend")
  ) {
    throw new Error("Credential backend marker has an invalid shape");
  }
  return (value as { backend: CredentialBackend }).backend;
}

async function writeBackendMarker(path: string, backend: CredentialBackend): Promise<void> {
  const existing = await readBackendMarker(path);
  if (existing !== undefined) {
    if (existing !== backend) throw new Error(`Credential backend is already pinned to ${existing}`);
    return;
  }
  await writePrivateFile(path, `${JSON.stringify({ version: BACKEND_MARKER_VERSION, backend })}\n`);
}

async function windowsCredentialKey(
  authPath: string,
  create: boolean,
  protector: WindowsKeyProtector,
): Promise<Buffer | undefined> {
  const keyPath = `${authPath}.key`;
  const encryptedPath = `${authPath}.enc`;
  return await new CrossProcessFileLock(`${keyPath}.lock`).run(async () => {
    const existing = await readKeyEnvelope(keyPath);
    if (existing !== undefined) return await protector.unprotect(existing);
    if (await fileExists(encryptedPath)) {
      throw new Error("Encrypted credential store exists without its protected key");
    }
    if (!create) return undefined;
    const key = randomBytes(32);
    try {
      await writeKeyEnvelope(keyPath, await protector.protect(key));
      return Buffer.from(key);
    } finally {
      key.fill(0);
    }
  });
}

async function migratePlaintextStore(authPath: string, target: CredentialStore): Promise<void> {
  if (!(await fileExists(authPath))) return;
  const source = AuthStorage.create(authPath);
  await source.withLock(MIGRATION_LOCK_ID, async () => {
    if (!(await fileExists(authPath))) return;
    const entries: Array<{ id: string; credential: AuthCredential }> = [];
    for (const { providerId } of await source.list()) {
      const credential = await source.read(providerId);
      if (credential !== undefined) entries.push({ id: providerId, credential });
    }
    for (const { id, credential } of entries) {
      const existing = await target.read(id);
      if (existing !== undefined && !isDeepStrictEqual(existing, credential)) {
        throw new Error(`Credential migration conflict for ${id}`);
      }
    }
    for (const { id, credential } of entries) {
      if (await target.read(id) === undefined) await target.write(id, credential);
    }
    for (const { id, credential } of entries) {
      if (!isDeepStrictEqual(await target.read(id), credential)) {
        throw new Error(`Credential migration verification failed for ${id}`);
      }
    }
    await rm(authPath);
    await syncDirectory(dirname(authPath));
  });
}

async function probeWritableKeychain(adapter: KeychainAdapter, service: string): Promise<boolean> {
  const account = `availability-${randomUUID()}`;
  const value = `probe-${randomUUID()}`;
  const signal = AbortSignal.timeout(3_000);
  let stored = false;
  try {
    await adapter.set(`${service}:probe`, account, value, signal, false);
    stored = true;
    if (await adapter.get(`${service}:probe`, account, signal, false) !== value) return false;
    await adapter.delete(`${service}:probe`, account, signal);
    stored = false;
    return true;
  } catch {
    return false;
  } finally {
    if (stored) {
      await adapter.delete(`${service}:probe`, account, AbortSignal.timeout(3_000)).catch(() => undefined);
    }
  }
}

function keychainStore(location: CredentialStoreLocation, adapter: KeychainAdapter): KeychainCredentialStore {
  return new KeychainCredentialStore({
    adapter,
    service: location.keychainService,
    lockPath: location.keychainLockPath,
  });
}

function windowsProtector(
  environment: NodeJS.ProcessEnv,
  selected: WindowsKeyProtector | undefined,
): WindowsKeyProtector {
  return selected ?? {
    protect: async (key) => await protectWindowsCredentialKey(key, { environment }),
    unprotect: async (envelope) => await unprotectWindowsCredentialKey(envelope, { environment }),
  };
}

async function requirePinnedPlatform(
  marker: CredentialBackend,
  platform: NodeJS.Platform,
): Promise<void> {
  if (marker === LINUX_KEYCHAIN_BACKEND && platform !== "linux") {
    throw new Error(`Credential backend ${marker} is unavailable on ${platform}`);
  }
  if (marker === MACOS_KEYCHAIN_BACKEND && platform !== "darwin") {
    throw new Error(`Credential backend ${marker} is unavailable on ${platform}`);
  }
  if (marker === WINDOWS_ENCRYPTED_BACKEND && platform !== "win32") {
    throw new Error(`Credential backend ${marker} is unavailable on ${platform}`);
  }
}

export async function createDefaultCredentialStore(
  authPath: string,
  options: DefaultCredentialStoreOptions = {},
): Promise<CredentialStore> {
  const location = await credentialStoreLocation(authPath);
  const fallback = AuthStorage.create(location.authPath);
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  return await new CrossProcessFileLock(location.selectionLockPath).run(async () => {
    const marker = await readBackendMarker(location.markerPath);
    if (options.allowPlatformKeychain === false) {
      if (marker !== undefined) {
        throw new Error(`Credential backend ${marker} is pinned and cannot be replaced by plaintext fallback`);
      }
      return fallback;
    }
    if (marker !== undefined) await requirePinnedPlatform(marker, platform);

    if (platform === "darwin") {
      const adapter = options.keychainAdapter ?? new PlatformKeychainAdapter({ platform, environment });
      if (marker === MACOS_KEYCHAIN_BACKEND) {
        if (!(await probePlatformKeychain(adapter))) {
          throw new Error("Pinned macOS Keychain credential backend is unavailable");
        }
      } else if (!(await probeWritableKeychain(adapter, location.keychainService))) {
        return fallback;
      }
      const store = keychainStore(location, adapter);
      await writeBackendMarker(location.markerPath, MACOS_KEYCHAIN_BACKEND);
      await migratePlaintextStore(location.authPath, store);
      return store;
    }

    if (platform === "linux") {
      const adapter = options.keychainAdapter ?? new PlatformKeychainAdapter({ platform, environment });
      if (marker === LINUX_KEYCHAIN_BACKEND) {
        if (!(await probePlatformKeychain(adapter))) {
          throw new Error("Pinned Linux Secret Service credential backend is unavailable");
        }
      } else if (!(await probeWritableKeychain(adapter, location.keychainService))) {
        return fallback;
      }
      const store = keychainStore(location, adapter);
      await writeBackendMarker(location.markerPath, LINUX_KEYCHAIN_BACKEND);
      await migratePlaintextStore(location.authPath, store);
      return store;
    }

    if (platform === "win32") {
      const protector = windowsProtector(environment, options.windowsKeyProtector);
      const encryptedPath = `${location.authPath}.enc`;
      const keyPath = `${location.authPath}.key`;
      const encryptedExists = await fileExists(encryptedPath);
      const keyExists = await fileExists(keyPath);
      if (marker === WINDOWS_ENCRYPTED_BACKEND && !keyExists) {
        throw new Error("Pinned Windows credential backend is missing its protected key");
      }
      let key: Buffer | undefined;
      try {
        key = await windowsCredentialKey(
          location.authPath,
          marker === WINDOWS_ENCRYPTED_BACKEND || options.createLocalKey === true,
          protector,
        );
      } catch (error) {
        if (
          marker === undefined &&
          !encryptedExists &&
          !keyExists
        ) {
          return fallback;
        }
        throw error;
      }
      if (key === undefined) return fallback;
      try {
        const store = new EncryptedFileCredentialStore({ path: encryptedPath, key });
        if (encryptedExists) await store.list();
        await writeBackendMarker(location.markerPath, WINDOWS_ENCRYPTED_BACKEND);
        await migratePlaintextStore(location.authPath, store);
        return store;
      } finally {
        key.fill(0);
      }
    }

    if (marker !== undefined) throw new Error(`Credential backend ${marker} is unavailable on ${platform}`);
    return fallback;
  });
}

/** Reads from the backend already selected for this auth path without creating a new backend. */
export async function readStoredCredentialAsync(
  providerId: string,
  authPath = getAuthPath(),
  options: Omit<DefaultCredentialStoreOptions, "createLocalKey"> = {},
): Promise<AuthCredential | undefined> {
  assertCredentialId(providerId);
  const location = await credentialStoreLocation(authPath);
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  return await new CrossProcessFileLock(location.selectionLockPath).run(async () => {
    const marker = await readBackendMarker(location.markerPath);
    const readSelected = async (store: CredentialStore): Promise<AuthCredential | undefined> => {
      if (!isCredentialProfileMetadataStore(store)) return await store.read(providerId);
      const active = await new CredentialProfileManager(store, providerId).active();
      if (!active.configured || active.fallbackSelected === true) return undefined;
      if (active.name === undefined) {
        throw new Error(`No active credential profile is selected for ${providerId}`);
      }
      if (active.credential === undefined) {
        throw new Error(`Active credential profile is missing for ${providerId}`);
      }
      return active.credential;
    };
    if (marker === undefined) return await readSelected(AuthStorage.create(location.authPath));
    await requirePinnedPlatform(marker, platform);
    if (marker === LINUX_KEYCHAIN_BACKEND) {
      const adapter = options.keychainAdapter ?? new PlatformKeychainAdapter({ platform, environment });
      if (!(await probePlatformKeychain(adapter))) {
        throw new Error("Pinned Linux Secret Service credential backend is unavailable");
      }
      return await readSelected(keychainStore(location, adapter));
    }
    if (marker === MACOS_KEYCHAIN_BACKEND) {
      const adapter = options.keychainAdapter ?? new PlatformKeychainAdapter({ platform, environment });
      if (!(await probePlatformKeychain(adapter))) {
        throw new Error("Pinned macOS Keychain credential backend is unavailable");
      }
      return await readSelected(keychainStore(location, adapter));
    }
    const key = await windowsCredentialKey(
      location.authPath,
      false,
      windowsProtector(environment, options.windowsKeyProtector),
    );
    if (key === undefined) throw new Error("Pinned Windows credential backend is missing its protected key");
    try {
      return await readSelected(new EncryptedFileCredentialStore({ path: `${location.authPath}.enc`, key }));
    } finally {
      key.fill(0);
    }
  });
}

type DefaultCredentialStorePurgeOptions = Omit<DefaultCredentialStoreOptions, "createLocalKey"> & {
  /** Auth path that currently owns the backend marker after an installation is relocated. */
  stateAuthPath?: string;
  /** Lock path that remains available when the credential owner is removed before the purge commits. */
  keychainLockPath?: string;
  /** @internal */
  macosHelperPath?: string;
};

interface PreparedCredentialStorePurge {
  (): Promise<void>;
  /** Releases resources when the prepared purge will not be committed. */
  dispose(): Promise<void>;
}

function preparedCredentialStorePurge(
  commit: () => Promise<void>,
  dispose: () => Promise<void> = async () => undefined,
): PreparedCredentialStorePurge {
  let commitPromise: Promise<void> | undefined;
  let disposePromise: Promise<void> | undefined;
  const disposeOnce = (): Promise<void> => {
    if (disposePromise === undefined) {
      const pending = Promise.resolve().then(dispose);
      disposePromise = pending;
      void pending.catch(() => {
        if (disposePromise === pending) disposePromise = undefined;
      });
    }
    return disposePromise;
  };
  const prepared = (): Promise<void> => {
    commitPromise ??= (async () => {
      let commitFailed = false;
      let commitError: unknown;
      try {
        await commit();
      } catch (error) {
        commitFailed = true;
        commitError = error;
      }
      try {
        await disposeOnce();
      } catch (cleanupError) {
        if (commitFailed) {
          throw new AggregateError(
            [commitError, cleanupError],
            "Credential purge failed and cleanup was incomplete",
          );
        }
        throw cleanupError;
      }
      if (commitFailed) throw commitError;
    })();
    return commitPromise;
  };
  prepared.dispose = disposeOnce;
  return prepared;
}

/** Prepares a non-destructive external-store purge that can run after local files are removed. */
export async function prepareDefaultCredentialStorePurge(
  authPath: string,
  options: DefaultCredentialStorePurgeOptions = {},
): Promise<PreparedCredentialStorePurge> {
  const location = await credentialStoreLocation(authPath);
  const stateLocation = options.stateAuthPath === undefined
    ? location
    : await credentialStoreLocation(options.stateAuthPath);
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const marker = await readBackendMarker(stateLocation.markerPath);
  if (marker === undefined) return preparedCredentialStorePurge(async () => undefined);
  await requirePinnedPlatform(marker, platform);
  if (marker === WINDOWS_ENCRYPTED_BACKEND) return preparedCredentialStorePurge(async () => undefined);

  let adapter: KeychainAdapter;
  let releaseRetainedHelper: (() => Promise<void>) | undefined;
  if (marker === MACOS_KEYCHAIN_BACKEND && options.keychainAdapter === undefined) {
    const retained = await retainMacosKeychainHelper(options.macosHelperPath);
    adapter = new PlatformKeychainAdapter({ platform, environment, macosHelperPath: retained.path });
    releaseRetainedHelper = retained.release;
  } else {
    adapter = options.keychainAdapter ?? new PlatformKeychainAdapter({ platform, environment });
  }
  const assertAvailable = async (): Promise<void> => {
    if (!(await probePlatformKeychain(adapter))) {
      throw new Error(marker === MACOS_KEYCHAIN_BACKEND
        ? "Pinned macOS Keychain credential backend is unavailable"
        : "Pinned Linux Secret Service credential backend is unavailable");
    }
  };
  try {
    await assertAvailable();
  } catch (error) {
    try {
      await releaseRetainedHelper?.();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Credential purge preparation failed and cleanup was incomplete");
    }
    throw error;
  }
  return preparedCredentialStorePurge(async () => {
    await assertAvailable();
    await new KeychainCredentialStore({
      adapter,
      service: location.keychainService,
      lockPath: options.keychainLockPath ?? location.keychainLockPath,
    }).purge();
  }, releaseRetainedHelper);
}

/** Purges credentials stored outside the rigyn home immediately. */
export async function purgeDefaultCredentialStore(
  authPath: string,
  options: DefaultCredentialStorePurgeOptions = {},
): Promise<void> {
  await (await prepareDefaultCredentialStorePurge(authPath, options))();
}
