import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { getAuthPath } from "../config/paths.js";
import { CrossProcessFileLock } from "./file-store.js";
import { defaultSecretRedactor } from "./redaction.js";
import {
  assertAuthCredential,
  assertCredentialId,
  credentialSecrets,
  isAuthCredential,
  type AuthCredential,
  type CredentialSummary,
  type MutableCredentialStore,
} from "./types.js";

const MAX_AUTH_FILE_BYTES = 12 * 1024 * 1024;
const MAX_CREDENTIALS = 4096;

type AuthStorageData = Record<string, AuthCredential>;

/** One-off synchronous credential read for startup code that cannot own a store. */
export function readStoredCredential(
  providerId: string,
  authPath = getAuthPath(),
): AuthCredential | undefined {
  try {
    if (statSync(authPath).size > MAX_AUTH_FILE_BYTES) return undefined;
    const value: unknown = JSON.parse(readFileSync(authPath, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const credential = (value as Record<string, unknown>)[providerId];
    if (!isAuthCredential(credential)) return undefined;
    defaultSecretRedactor.registerAll(credentialSecrets(credential));
    return structuredClone(credential);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseAuthStorage(text: string): AuthStorageData {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || Object.keys(value).length > MAX_CREDENTIALS) {
    throw new Error("Authentication storage has an invalid shape");
  }
  const result: AuthStorageData = {};
  for (const [id, credential] of Object.entries(value)) {
    assertCredentialId(id);
    if (!isAuthCredential(credential)) {
      throw new Error(`Authentication storage contains an invalid credential: ${id}`);
    }
    result[id] = credential;
  }
  return result;
}

/** Direct provider-keyed credential storage backed by auth.json. */
export class AuthStorage implements MutableCredentialStore {
  readonly #path: string | undefined;
  readonly #lock: CrossProcessFileLock | undefined;
  readonly #lockContext = new AsyncLocalStorage<boolean>();
  #memory: AuthStorageData;

  private constructor(path: string | undefined, initial: AuthStorageData = {}) {
    this.#path = path;
    this.#lock = path === undefined ? undefined : new CrossProcessFileLock(`${path}.lock`);
    this.#memory = structuredClone(initial);
  }

  static create(path = getAuthPath()): AuthStorage {
    return new AuthStorage(path);
  }

  static inMemory(initial: AuthStorageData = {}): AuthStorage {
    for (const [id, credential] of Object.entries(initial)) {
      assertCredentialId(id);
      assertAuthCredential(credential);
    }
    return new AuthStorage(undefined, initial);
  }

  async read(id: string): Promise<AuthCredential | undefined> {
    assertCredentialId(id);
    const value = (await this.#readAll())[id];
    if (value !== undefined) defaultSecretRedactor.registerAll(credentialSecrets(value));
    return value === undefined ? undefined : structuredClone(value);
  }

  async list(): Promise<readonly CredentialSummary[]> {
    return Object.entries(await this.#readAll()).map(([providerId, credential]) => ({
      providerId,
      type: credential.kind,
    }));
  }

  async modify(
    id: string,
    operation: (current: AuthCredential | undefined) => Promise<AuthCredential | undefined>,
    signal?: AbortSignal,
  ): Promise<AuthCredential | undefined> {
    assertCredentialId(id);
    return await this.withLock(id, async () => {
      signal?.throwIfAborted();
      const data = await this.#readAll();
      const current = data[id];
      const replacement = await operation(current === undefined ? undefined : structuredClone(current));
      signal?.throwIfAborted();
      if (replacement === undefined) return current === undefined ? undefined : structuredClone(current);
      assertAuthCredential(replacement);
      const stored = structuredClone(replacement);
      defaultSecretRedactor.registerAll(credentialSecrets(stored));
      data[id] = stored;
      await this.#writeAll(data);
      return structuredClone(stored);
    }, signal);
  }

  async write(id: string, credential: AuthCredential): Promise<void> {
    assertCredentialId(id);
    assertAuthCredential(credential);
    const value = structuredClone(credential);
    defaultSecretRedactor.registerAll(credentialSecrets(value));
    await this.withLock(id, async () => {
      const data = await this.#readAll();
      data[id] = value;
      await this.#writeAll(data);
    });
  }

  async delete(id: string): Promise<void> {
    assertCredentialId(id);
    await this.withLock(id, async () => {
      const data = await this.#readAll();
      delete data[id];
      await this.#writeAll(data);
    });
  }

  async withLock<T>(id: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    assertCredentialId(id);
    signal?.throwIfAborted();
    if (this.#lock === undefined || this.#lockContext.getStore() === true) return await operation();
    return await this.#lock.run(() => this.#lockContext.run(true, operation), signal);
  }

  async #readAll(): Promise<AuthStorageData> {
    if (this.#path === undefined) return structuredClone(this.#memory);
    let handle;
    try {
      handle = await open(this.#path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    try {
      const information = await handle.stat();
      if (!information.isFile()) throw new Error("Authentication storage is not a regular file");
      if (information.size > MAX_AUTH_FILE_BYTES) throw new Error("Authentication storage exceeded its size limit");
      return parseAuthStorage(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  }

  async #writeAll(data: AuthStorageData): Promise<void> {
    for (const [id, credential] of Object.entries(data)) {
      assertCredentialId(id);
      assertAuthCredential(credential);
    }
    if (this.#path === undefined) {
      this.#memory = structuredClone(data);
      return;
    }
    const serialized = `${JSON.stringify(data, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_AUTH_FILE_BYTES) {
      throw new Error("Authentication storage exceeded its size limit");
    }
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.#path);
      await chmod(this.#path, 0o600);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
