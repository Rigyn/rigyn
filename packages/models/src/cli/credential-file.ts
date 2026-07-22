import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential,
} from "../auth/types.js";

const MAX_STORE_BYTES = 1024 * 1024;
const STORE_VERSION = 1;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

interface StoredCredentials {
  version: typeof STORE_VERSION;
  credentials: Record<string, OAuthCredential>;
}

export class OAuthCredentialFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OAuthCredentialFileError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function providerId(value: string): string {
  if (!PROVIDER_ID.test(value)) {
    throw new OAuthCredentialFileError("Credential store contains an invalid provider identifier");
  }
  return value;
}

function oauthCredential(value: unknown): OAuthCredential {
  if (!isObject(value)
    || value.type !== "oauth"
    || typeof value.access !== "string"
    || value.access.length === 0
    || typeof value.refresh !== "string"
    || value.refresh.length === 0
    || typeof value.expires !== "number"
    || !Number.isFinite(value.expires)
    || value.expires < 0) {
    throw new OAuthCredentialFileError("Credential store contains an invalid OAuth credential");
  }
  return structuredClone(value) as OAuthCredential;
}

function envelope(value: unknown): StoredCredentials {
  if (!isObject(value)
    || value.version !== STORE_VERSION
    || !isObject(value.credentials)
    || Object.keys(value).some((key) => key !== "version" && key !== "credentials")) {
    throw new OAuthCredentialFileError("Credential store has an unsupported or malformed format");
  }
  const credentials: Record<string, OAuthCredential> = Object.create(null) as Record<string, OAuthCredential>;
  for (const [id, credential] of Object.entries(value.credentials)) {
    credentials[providerId(id)] = oauthCredential(credential);
  }
  return { version: STORE_VERSION, credentials };
}

function emptyEnvelope(): StoredCredentials {
  return {
    version: STORE_VERSION,
    credentials: Object.create(null) as Record<string, OAuthCredential>,
  };
}

function serializedEnvelope(value: StoredCredentials): string {
  return `${JSON.stringify(envelope(value), null, 2)}\n`;
}

function isMissing(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}

async function assertSafeDirectory(path: string, create: boolean): Promise<void> {
  if (create) {
    try {
      await mkdir(path, { recursive: true, mode: 0o700 });
    } catch (cause) {
      throw new OAuthCredentialFileError("Credential store directory could not be created", { cause });
    }
  }
  let existing = path;
  let information: Awaited<ReturnType<typeof lstat>>;
  while (true) {
    try {
      information = await lstat(existing);
      break;
    } catch (cause) {
      if (!isMissing(cause)) {
        throw new OAuthCredentialFileError("Credential store directory could not be inspected", { cause });
      }
      const parent = dirname(existing);
      if (parent === existing) {
        throw new OAuthCredentialFileError("Credential store directory has no accessible parent");
      }
      existing = parent;
    }
  }
  if (information.isSymbolicLink() || !information.isDirectory()) {
    throw new OAuthCredentialFileError("Credential store directory must be a real directory");
  }
  const canonical = await realpath(existing).catch((cause: unknown) => {
    throw new OAuthCredentialFileError("Credential store directory could not be resolved", { cause });
  });
  const comparable = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
  if (comparable(canonical) !== comparable(resolve(existing))) {
    throw new OAuthCredentialFileError("Credential store directory must not traverse symbolic links");
  }
  if (process.platform !== "win32") {
    if ((information.mode & 0o022) !== 0) {
      throw new OAuthCredentialFileError("Credential store directory must not be writable by other users");
    }
    if (typeof process.getuid === "function" && information.uid !== process.getuid()) {
      throw new OAuthCredentialFileError("Credential store directory is not owned by the current user");
    }
  }
}

async function assertSafeFile(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  let information: Awaited<ReturnType<typeof lstat>>;
  try {
    information = await lstat(path);
  } catch (cause) {
    if (isMissing(cause)) return undefined;
    throw new OAuthCredentialFileError("Credential store could not be inspected", { cause });
  }
  if (information.isSymbolicLink() || !information.isFile() || information.nlink !== 1) {
    throw new OAuthCredentialFileError("Credential store must be a regular file");
  }
  if (information.size > MAX_STORE_BYTES) {
    throw new OAuthCredentialFileError("Credential store exceeds the size limit");
  }
  if (process.platform !== "win32") {
    if ((information.mode & 0o077) !== 0) {
      throw new OAuthCredentialFileError("Credential store permissions must be 0600");
    }
    if (typeof process.getuid === "function" && information.uid !== process.getuid()) {
      throw new OAuthCredentialFileError("Credential store is not owned by the current user");
    }
  }
  return information;
}

async function readBounded(path: string): Promise<string | undefined> {
  const before = await assertSafeFile(path);
  if (before === undefined) return undefined;
  const handle = await open(path, constants.O_RDONLY | O_NOFOLLOW).catch((cause: unknown) => {
    throw new OAuthCredentialFileError("Credential store could not be opened safely", { cause });
  });
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino) {
      throw new OAuthCredentialFileError("Credential store changed while it was being opened");
    }
    const buffer = Buffer.alloc(MAX_STORE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_STORE_BYTES) {
      throw new OAuthCredentialFileError("Credential store exceeds the size limit");
    }
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function load(path: string): Promise<StoredCredentials> {
  await assertSafeDirectory(dirname(path), false);
  const raw = await readBounded(path);
  if (raw === undefined) return emptyEnvelope();
  try {
    return envelope(JSON.parse(raw) as unknown);
  } catch (cause) {
    if (cause instanceof OAuthCredentialFileError) throw cause;
    throw new OAuthCredentialFileError("Credential store is not valid JSON", { cause });
  }
}

async function writeAtomic(path: string, value: StoredCredentials): Promise<void> {
  await assertSafeDirectory(dirname(path), true);
  await assertSafeFile(path);
  const normalized = envelope(value);
  const payload = `${JSON.stringify(normalized, null, 2)}\n`;
  if (Buffer.byteLength(payload) > MAX_STORE_BYTES) {
    throw new OAuthCredentialFileError("Credential store exceeds the size limit");
  }
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let created = false;
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
    created = true;
    try {
      await handle.writeFile(payload, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    created = false;
    if (process.platform !== "win32") await chmod(path, 0o600);
    await assertSafeFile(path);
  } catch (cause) {
    if (cause instanceof OAuthCredentialFileError) throw cause;
    throw new OAuthCredentialFileError("Credential store could not be written atomically", { cause });
  } finally {
    if (created) await unlink(temporary).catch(() => undefined);
  }
}

export function resolveOAuthCredentialFile(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  const preferred = environment.RIGYN_MODELS_AUTH_FILE;
  const legacy = environment.RIGYN_AI_AUTH_FILE;
  const variable = preferred !== undefined ? "RIGYN_MODELS_AUTH_FILE" : "RIGYN_AI_AUTH_FILE";
  const configured = preferred ?? legacy;
  if (configured !== undefined && configured.length === 0) {
    throw new OAuthCredentialFileError(`${variable} must not be empty`);
  }
  const path = configured ?? join(homeDirectory, ".rigyn-models", "oauth.json");
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new OAuthCredentialFileError(`${variable} must be an absolute path`);
  }
  const resolved = resolve(path);
  const configuredAgentDirectory = environment.RIGYN_CODING_AGENT_DIR;
  const selectedAgentDirectory = configuredAgentDirectory === undefined || configuredAgentDirectory === ""
    ? join(homeDirectory, ".rigyn", "agent")
    : configuredAgentDirectory === "~"
      ? homeDirectory
      : configuredAgentDirectory.startsWith("~/")
          || (process.platform === "win32" && configuredAgentDirectory.startsWith("~\\"))
        ? join(homeDirectory, configuredAgentDirectory.slice(2))
        : configuredAgentDirectory;
  const agentDirectory = selectedAgentDirectory.startsWith("file://")
    ? fileURLToPath(selectedAgentDirectory)
    : selectedAgentDirectory;
  const comparable = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
  if (comparable(resolved) === comparable(resolve(agentDirectory, "auth.json"))) {
    throw new OAuthCredentialFileError("The standalone OAuth store must not replace the Rigyn agent credential store");
  }
  return resolved;
}

interface InstalledMigration {
  created: boolean;
  identity: Awaited<ReturnType<typeof lstat>>;
  raw: string;
}

async function identicalInstalledStore(path: string, value: StoredCredentials, raw: string): Promise<InstalledMigration | undefined> {
  const identity = await assertSafeFile(path);
  if (identity === undefined) return undefined;
  const installed = await load(path);
  if (JSON.stringify(installed) !== JSON.stringify(value)) return undefined;
  return { created: false, identity, raw };
}

async function settledIdenticalInstalledStore(
  path: string,
  value: StoredCredentials,
  raw: string,
): Promise<InstalledMigration | undefined> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const installed = await identicalInstalledStore(path, value, raw).catch(() => undefined);
    if (installed !== undefined) return installed;
    if (attempt < 7) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return undefined;
}

async function removeInstalledMigration(
  path: string,
  identity: Awaited<ReturnType<typeof lstat>>,
  raw: string,
): Promise<void> {
  const current = await assertSafeFile(path).catch(() => undefined);
  if (current === undefined || current.dev !== identity.dev || current.ino !== identity.ino) return;
  if (await readBounded(path).catch(() => undefined) !== raw) return;
  const beforeUnlink = await assertSafeFile(path).catch(() => undefined);
  if (beforeUnlink === undefined || beforeUnlink.dev !== identity.dev || beforeUnlink.ino !== identity.ino) return;
  await unlink(path).catch(() => undefined);
}

async function installMigratedStore(path: string, value: StoredCredentials): Promise<InstalledMigration> {
  await assertSafeDirectory(dirname(path), true);
  const payload = serializedEnvelope(value);
  const existing = await identicalInstalledStore(path, value, payload);
  if (existing !== undefined) return existing;
  if (await assertSafeFile(path) !== undefined) {
    throw new OAuthCredentialFileError("The new credential store appeared during migration");
  }
  if (Buffer.byteLength(payload) > MAX_STORE_BYTES) {
    throw new OAuthCredentialFileError("Credential store exceeds the size limit");
  }
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.migrate`);
  let temporaryCreated = false;
  let destinationCreated = false;
  let identity: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
    temporaryCreated = true;
    try {
      await handle.writeFile(payload, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
      identity = await handle.stat();
    } finally {
      await handle.close();
    }
    await link(temporary, path);
    destinationCreated = true;
    await unlink(temporary);
    temporaryCreated = false;
    const installed = await assertSafeFile(path);
    if (installed === undefined
      || identity === undefined
      || installed.dev !== identity.dev
      || installed.ino !== identity.ino) {
      throw new OAuthCredentialFileError("The migrated credential store could not be verified");
    }
    return { created: true, identity: installed, raw: payload };
  } catch (cause) {
    if (isObject(cause) && cause.code === "EEXIST") {
      // A concurrent winner briefly has two links until it removes its temporary name.
      const winner = await settledIdenticalInstalledStore(path, value, payload);
      if (winner !== undefined) return winner;
    }
    if (destinationCreated && identity !== undefined) {
      await removeInstalledMigration(path, identity, payload);
    }
    if (cause instanceof OAuthCredentialFileError) throw cause;
    throw new OAuthCredentialFileError("Credential store migration failed", { cause });
  } finally {
    if (temporaryCreated) await unlink(temporary).catch(() => undefined);
  }
}

async function removeMigratedSource(
  source: string,
  destination: string,
  sourceRaw: string,
  sourceIdentity: Awaited<ReturnType<typeof lstat>>,
  destinationIdentity: Awaited<ReturnType<typeof lstat>>,
  destinationRaw: string,
): Promise<void> {
  try {
    const currentIdentity = await assertSafeFile(source);
    if (currentIdentity === undefined
      || currentIdentity.dev !== sourceIdentity.dev
      || currentIdentity.ino !== sourceIdentity.ino) {
      throw new OAuthCredentialFileError("The legacy credential store changed during migration");
    }
    if (await readBounded(source) !== sourceRaw) {
      throw new OAuthCredentialFileError("The legacy credential store changed during migration");
    }
    const beforeUnlink = await assertSafeFile(source);
    if (beforeUnlink === undefined
      || beforeUnlink.dev !== sourceIdentity.dev
      || beforeUnlink.ino !== sourceIdentity.ino) {
      throw new OAuthCredentialFileError("The legacy credential store changed during migration");
    }
    await unlink(source);
  } catch (cause) {
    await removeInstalledMigration(destination, destinationIdentity, destinationRaw);
    if (cause instanceof OAuthCredentialFileError) throw cause;
    throw new OAuthCredentialFileError("The legacy credential store could not be removed after migration", { cause });
  }
}

export async function prepareOAuthCredentialFile(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): Promise<string> {
  const path = resolveOAuthCredentialFile(environment, homeDirectory);
  if (environment.RIGYN_MODELS_AUTH_FILE !== undefined || environment.RIGYN_AI_AUTH_FILE !== undefined) {
    return path;
  }
  await assertSafeDirectory(dirname(path), false);
  if (await assertSafeFile(path) !== undefined) return path;

  const legacyPath = resolve(homeDirectory, ".rigyn-ai", "oauth.json");
  await assertSafeDirectory(dirname(legacyPath), false);
  const sourceIdentity = await assertSafeFile(legacyPath);
  if (sourceIdentity === undefined) return path;
  const sourceRaw = await readBounded(legacyPath);
  const sourceAfterRead = await assertSafeFile(legacyPath);
  if (sourceRaw === undefined
    || sourceAfterRead === undefined
    || sourceAfterRead.dev !== sourceIdentity.dev
    || sourceAfterRead.ino !== sourceIdentity.ino) {
    throw new OAuthCredentialFileError("The legacy credential store changed during migration");
  }
  let source: StoredCredentials;
  try {
    source = envelope(JSON.parse(sourceRaw) as unknown);
  } catch (cause) {
    if (cause instanceof OAuthCredentialFileError) throw cause;
    throw new OAuthCredentialFileError("Legacy credential store is not valid JSON", { cause });
  }
  const migration = await installMigratedStore(path, source);
  if (!migration.created) return path;
  const installed = await load(path);
  if (JSON.stringify(installed) !== JSON.stringify(source)) {
    await removeInstalledMigration(path, migration.identity, migration.raw);
    throw new OAuthCredentialFileError("The migrated credential store contents could not be verified");
  }
  await removeMigratedSource(legacyPath, path, sourceRaw, sourceIdentity, migration.identity, migration.raw);
  return path;
}

export class OAuthFileCredentialStore implements CredentialStore {
  readonly #path: string;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    if (!isAbsolute(path)) throw new OAuthCredentialFileError("Credential store path must be absolute");
    this.#path = resolve(path);
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.catch(() => undefined).then(operation);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  async read(provider: string): Promise<Credential | undefined> {
    const value = (await load(this.#path)).credentials[providerId(provider)];
    return value === undefined ? undefined : structuredClone(value);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const values = (await load(this.#path)).credentials;
    return Object.keys(values).sort().map((provider) => ({ providerId: provider, type: "oauth" }));
  }

  modify(
    provider: string,
    operation: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const id = providerId(provider);
    return this.#serial(async () => {
      const current = await load(this.#path);
      const previous = current.credentials[id];
      const replacement = await operation(previous === undefined ? undefined : structuredClone(previous));
      if (replacement === undefined) return previous === undefined ? undefined : structuredClone(previous);
      current.credentials[id] = oauthCredential(replacement);
      await writeAtomic(this.#path, current);
      return structuredClone(current.credentials[id]);
    });
  }

  delete(provider: string): Promise<void> {
    const id = providerId(provider);
    return this.#serial(async () => {
      const current = await load(this.#path);
      if (!Object.hasOwn(current.credentials, id)) return;
      delete current.credentials[id];
      await writeAtomic(this.#path, current);
    });
  }
}
