import { AsyncLocalStorage } from "node:async_hooks";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  assertCredentialId,
  assertAuthCredential,
  credentialSecrets,
  isAuthCredential,
  type AuthCredential,
  type CredentialProfileMetadataStore,
} from "./types.js";
import { defaultSecretRedactor } from "./redaction.js";

const ALGORITHM = "aes-256-gcm";
const AAD = Buffer.from("rigyn-auth-store-v1", "utf8");
const MAX_PLAINTEXT_STORE_BYTES = 12 * 1024 * 1024 - 4096;
const MAX_ENCRYPTED_STORE_BYTES = 16 * 1024 * 1024;
const MAX_STORED_CREDENTIALS = 4096;

interface EncryptedEnvelope {
  version: 1;
  algorithm: typeof ALGORITHM;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface StoredCredentials {
  version: 1;
  credentials: Record<string, AuthCredential>;
  profileIndexes: Record<string, unknown>;
}

export class CredentialStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CredentialStoreError";
  }
}

function validateKey(key: Uint8Array): Buffer {
  if (key.byteLength !== 32) throw new TypeError("Credential store key must be exactly 32 bytes");
  return Buffer.from(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseEnvelope(text: string): EncryptedEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new CredentialStoreError("Credential store is not a valid encrypted envelope", {
      cause: error,
    });
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.algorithm !== ALGORITHM ||
    typeof value.iv !== "string" ||
    typeof value.tag !== "string" ||
    typeof value.ciphertext !== "string"
  ) {
    throw new CredentialStoreError("Credential store has an unsupported encrypted envelope");
  }
  const iv = canonicalBase64Url(value.iv, "iv");
  const tag = canonicalBase64Url(value.tag, "tag");
  const ciphertext = canonicalBase64Url(value.ciphertext, "ciphertext");
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > MAX_PLAINTEXT_STORE_BYTES) {
    throw new CredentialStoreError("Credential store has invalid encryption parameters");
  }
  return value as unknown as EncryptedEnvelope;
}

function canonicalBase64Url(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new CredentialStoreError(`Credential store ${label} is not base64url`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new CredentialStoreError(`Credential store ${label} is not canonical base64url`);
  return decoded;
}

function decryptStore(envelope: EncryptedEnvelope, key: Buffer): StoredCredentials {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, "base64url"));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]);
    let value: unknown;
    try {
      value = JSON.parse(plaintext.toString("utf8"));
    } finally {
      plaintext.fill(0);
    }
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      !isRecord(value.credentials) ||
      (value.profileIndexes !== undefined && !isRecord(value.profileIndexes))
    ) {
      throw new Error("invalid payload shape");
    }
    if (Object.keys(value.credentials).length > MAX_STORED_CREDENTIALS) {
      throw new Error("credential count exceeded configured limit");
    }
    for (const credential of Object.values(value.credentials)) {
      if (!isAuthCredential(credential)) throw new Error("invalid credential shape");
    }
    for (const id of Object.keys(value.credentials)) assertCredentialId(id);
    const profileIndexes = value.profileIndexes ?? {};
    if (Object.keys(profileIndexes).length > MAX_STORED_CREDENTIALS) {
      throw new Error("credential profile index count exceeded configured limit");
    }
    for (const id of Object.keys(profileIndexes)) assertCredentialId(id);
    return {
      version: 1,
      credentials: value.credentials as Record<string, AuthCredential>,
      profileIndexes,
    };
  } catch (error) {
    throw new CredentialStoreError("Credential store authentication or decryption failed", {
      cause: error,
    });
  }
}

function encryptStore(store: StoredCredentials, key: Buffer): EncryptedEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(AAD);
  const plaintext = Buffer.from(JSON.stringify(store), "utf8");
  let ciphertext: Buffer;
  try {
    if (plaintext.byteLength > MAX_PLAINTEXT_STORE_BYTES) {
      throw new CredentialStoreError("Credential store exceeded configured size limit");
    }
    ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  } finally {
    plaintext.fill(0);
  }
  return {
    version: 1,
    algorithm: ALGORITHM,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readEncryptedStore(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const information = await handle.stat();
    if (!information.isFile()) throw new CredentialStoreError("Credential store is not a regular file");
    if (information.size > MAX_ENCRYPTED_STORE_BYTES) {
      throw new CredentialStoreError("Credential store exceeded configured size limit");
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (bytes <= MAX_ENCRYPTED_STORE_BYTES) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_ENCRYPTED_STORE_BYTES + 1 - bytes));
      const result = await handle.read(buffer, 0, buffer.byteLength, null);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
      if (bytes > MAX_ENCRYPTED_STORE_BYTES) {
        throw new CredentialStoreError("Credential store exceeded configured size limit");
      }
      chunks.push(buffer.subarray(0, result.bytesRead));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}

export interface FileLockOptions {
  retryMs?: number;
  timeoutMs?: number;
  staleMs?: number;
}

async function readLockToken(path: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const information = await handle.stat();
    if (!information.isFile() || information.size > 4096) return undefined;
    const value: unknown = JSON.parse(await handle.readFile("utf8"));
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof (value as Record<string, unknown>).token !== "string"
    ) return undefined;
    return (value as { token: string }).token;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

async function removeOwnedLock(path: string, token: string): Promise<boolean> {
  if (await readLockToken(path) !== token) return false;
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export class CrossProcessFileLock {
  readonly #path: string;
  readonly #retryMs: number;
  readonly #timeoutMs: number;
  readonly #staleMs: number;

  constructor(path: string, options: FileLockOptions = {}) {
    this.#path = path;
    this.#retryMs = options.retryMs ?? 25;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#staleMs = options.staleMs ?? 5 * 60_000;
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const startedAt = Date.now();
    const ownerToken = randomUUID();
    let handle;
    while (handle === undefined) {
      signal?.throwIfAborted();
      try {
        const candidate = await open(this.#path, "wx", 0o600);
        try {
          await candidate.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: ownerToken }));
          handle = candidate;
        } catch (error) {
          await candidate.close();
          await removeOwnedLock(this.#path, ownerToken).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const metadata = await stat(this.#path);
          if (Date.now() - metadata.mtimeMs > this.#staleMs) {
            const staleToken = await readLockToken(this.#path);
            if (staleToken !== undefined && await removeOwnedLock(this.#path, staleToken)) continue;
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw statError;
        }
        if (Date.now() - startedAt >= this.#timeoutMs) {
          throw new CredentialStoreError("Timed out waiting for credential store lock");
        }
        await delay(this.#retryMs, undefined, { signal });
      }
    }

    try {
      return await operation();
    } finally {
      await handle.close();
      await removeOwnedLock(this.#path, ownerToken);
    }
  }
}

export class EncryptedFileCredentialStore implements CredentialProfileMetadataStore {
  readonly #path: string;
  readonly #key: Buffer;
  readonly #lock: CrossProcessFileLock;
  readonly #lockContext: AsyncLocalStorage<boolean>;

  constructor(options: {
    path: string;
    key: Uint8Array;
    lock?: FileLockOptions | CrossProcessFileLock;
    lockContext?: AsyncLocalStorage<boolean>;
  }) {
    this.#path = options.path;
    this.#key = validateKey(options.key);
    this.#lock = options.lock instanceof CrossProcessFileLock
      ? options.lock
      : new CrossProcessFileLock(`${options.path}.lock`, options.lock);
    this.#lockContext = options.lockContext ?? new AsyncLocalStorage<boolean>();
  }

  async read(id: string): Promise<AuthCredential | undefined> {
    assertCredentialId(id);
    const credential = (await this.#readAll()).credentials[id];
    if (credential !== undefined) defaultSecretRedactor.registerAll(credentialSecrets(credential));
    return credential;
  }

  async write(id: string, credential: AuthCredential): Promise<void> {
    assertCredentialId(id);
    assertAuthCredential(credential);
    const snapshot = structuredClone(credential);
    assertAuthCredential(snapshot);
    defaultSecretRedactor.registerAll(credentialSecrets(snapshot));
    await this.#whileLocked(id, async () => {
      const store = await this.#readAll();
      store.credentials[id] = snapshot;
      await this.#writeAll(store);
    });
  }

  async delete(id: string): Promise<void> {
    assertCredentialId(id);
    await this.#whileLocked(id, async () => {
      const store = await this.#readAll();
      delete store.credentials[id];
      await this.#writeAll(store);
    });
  }

  async readCredentialProfileIndex(id: string): Promise<unknown | undefined> {
    assertCredentialId(id);
    return structuredClone((await this.#readAll()).profileIndexes[id]);
  }

  async writeCredentialProfileIndex(id: string, value: unknown): Promise<void> {
    assertCredentialId(id);
    const snapshot = structuredClone(value);
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(snapshot);
    } catch (error) {
      throw new TypeError("Credential profile index must be JSON-serializable", { cause: error });
    }
    if (serialized === undefined) throw new TypeError("Credential profile index must be JSON-serializable");
    if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) {
      throw new Error("Credential profile index exceeded 64 KiB");
    }
    const canonical = JSON.parse(serialized) as unknown;
    await this.#whileLocked(id, async () => {
      const store = await this.#readAll();
      store.profileIndexes[id] = canonical;
      await this.#writeAll(store);
    });
  }

  async deleteCredentialProfileIndex(id: string): Promise<void> {
    assertCredentialId(id);
    await this.#whileLocked(id, async () => {
      const store = await this.#readAll();
      delete store.profileIndexes[id];
      await this.#writeAll(store);
    });
  }

  async withLock<T>(
    _id: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    assertCredentialId(_id);
    if (this.#lockContext.getStore() === true) return operation();
    return this.#lock.run(() => this.#lockContext.run(true, operation), signal);
  }

  async #whileLocked<T>(id: string, operation: () => Promise<T>): Promise<T> {
    return this.#lockContext.getStore() === true ? operation() : this.withLock(id, operation);
  }

  async #readAll(): Promise<StoredCredentials> {
    if (!(await exists(this.#path))) return { version: 1, credentials: {}, profileIndexes: {} };
    const envelope = parseEnvelope(await readEncryptedStore(this.#path));
    return decryptStore(envelope, this.#key);
  }

  async #writeAll(store: StoredCredentials): Promise<void> {
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        const envelope = encryptStore(store, this.#key);
        await handle.writeFile(`${JSON.stringify(envelope)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.#path);
      await chmod(this.#path, 0o600);
      try {
        const directoryHandle = await open(directory, "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      } catch (error) {
        if (!new Set(["EINVAL", "ENOTSUP", "EPERM", "EISDIR"]).has((error as NodeJS.ErrnoException).code ?? "")) {
          throw error;
        }
      }
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}
