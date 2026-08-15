import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { CrossProcessFileLock } from "../auth/file-store.js";
import type { ProviderModel } from "./models.js";
import { parseStoredProviderModels } from "./registry.js";

const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_PROVIDERS = 512;
const MAX_DATA_DEPTH = 32;
const MAX_DATA_NODES = 100_000;
const MAX_DATA_ENTRIES = 4_096;
const MAX_DATA_KEY_BYTES = 512;
const MAX_DATA_STRING_BYTES = 256 * 1024;

export interface ProviderModelsStoreEntry {
  models: readonly ProviderModel[];
  cacheScope?: string;
  checkedAt?: number;
  etag?: string;
}

export interface ProviderModelsStore {
  read(providerId: string, cacheScope?: string): Promise<ProviderModelsStoreEntry | undefined>;
  write(providerId: string, entry: ProviderModelsStoreEntry): Promise<void>;
  delete(providerId: string): Promise<void>;
  /** Point-in-time read view. Mutations still commit through the backing store. */
  snapshot?(): Promise<ProviderModelsStore>;
}

export interface ScopedProviderModelsStore {
  read(): Promise<ProviderModelsStoreEntry | undefined>;
  write(entry: ProviderModelsStoreEntry): Promise<void>;
  delete(): Promise<void>;
}

export class InMemoryProviderModelsStore implements ProviderModelsStore {
  readonly #entries = new Map<string, ProviderModelsStoreEntry>();

  async read(providerId: string, cacheScope?: string): Promise<ProviderModelsStoreEntry | undefined> {
    const entry = this.#entries.get(providerId);
    if (entry !== undefined && cacheScope !== undefined && entry.cacheScope !== cacheScope) {
      this.#entries.delete(providerId);
      return undefined;
    }
    return entry === undefined ? undefined : structuredClone(entry);
  }

  async write(providerId: string, entry: ProviderModelsStoreEntry): Promise<void> {
    this.#entries.set(providerId, structuredClone(entry));
  }

  async delete(providerId: string): Promise<void> {
    this.#entries.delete(providerId);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validatedProviderId(value: string): string {
  parseStoredProviderModels(value, []);
  return value;
}

function assertPlainData(value: unknown, label: string): void {
  const pending: Array<{ value: unknown; label: string; depth: number }> = [{ value, label, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_DATA_NODES) throw new Error(`${label} contains too much data`);
    if (current.depth > MAX_DATA_DEPTH) throw new Error(`${current.label} is nested too deeply`);
    if (typeof current.value === "string") {
      if (Buffer.byteLength(current.value, "utf8") > MAX_DATA_STRING_BYTES) {
        throw new Error(`${current.label} is too large`);
      }
      continue;
    }
    if (
      current.value === null || current.value === undefined ||
      typeof current.value === "boolean" || typeof current.value === "number"
    ) {
      if (typeof current.value === "number" && !Number.isFinite(current.value)) {
        throw new Error(`${current.label} must be finite`);
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      const array = current.value;
      if (Object.getPrototypeOf(array) !== Array.prototype || array.length > MAX_DATA_ENTRIES) {
        throw new Error(`${current.label} must be a plain array with at most ${MAX_DATA_ENTRIES} entries`);
      }
      const keys = Reflect.ownKeys(array).filter((key) => key !== "length");
      if (
        keys.length !== array.length ||
        keys.some((key) => typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= array.length)
      ) {
        throw new Error(`${current.label} must not contain sparse, symbolic, or named entries`);
      }
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(array, key)!;
        if (!("value" in descriptor) || descriptor.enumerable !== true) {
          throw new Error(`${current.label} must contain data properties only`);
        }
        pending.push({ value: descriptor.value, label: `${current.label}[${String(key)}]`, depth: current.depth + 1 });
      }
      continue;
    }
    if (typeof current.value !== "object") throw new Error(`${current.label} must contain plain data`);
    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${current.label} must be a plain object`);
    }
    const keys = Reflect.ownKeys(current.value);
    if (keys.length > MAX_DATA_ENTRIES) throw new Error(`${current.label} contains too many fields`);
    for (const key of keys) {
      if (typeof key !== "string") throw new Error(`${current.label} must not contain symbol fields`);
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw new Error(`${current.label}.${key} is reserved`);
      }
      if (Buffer.byteLength(key, "utf8") > MAX_DATA_KEY_BYTES) throw new Error(`${current.label} contains an oversized key`);
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key)!;
      if (!("value" in descriptor) || descriptor.enumerable !== true) {
        throw new Error(`${current.label}.${key} must be an enumerable data property`);
      }
      pending.push({ value: descriptor.value, label: `${current.label}.${key}`, depth: current.depth + 1 });
    }
  }
}

function storedEntry(provider: string, value: unknown): ProviderModelsStoreEntry {
  const label = `Persisted model store entry ${provider}`;
  assertPlainData(value, label);
  if (!record(value)) throw new Error(`${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !["models", "cacheScope", "checkedAt", "etag"].includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown fields: ${unknown.join(", ")}`);
  const models = parseStoredProviderModels(provider, value.models, `${label}.models`);
  let cacheScope: string | undefined;
  if (value.cacheScope !== undefined) {
    if (typeof value.cacheScope !== "string" || !/^credential-v1:[0-9a-f]{64}$/u.test(value.cacheScope)) {
      throw new Error(`${label}.cacheScope is invalid`);
    }
    cacheScope = value.cacheScope;
  }
  let checkedAt: number | undefined;
  if (value.checkedAt !== undefined) {
    if (!Number.isSafeInteger(value.checkedAt) || (value.checkedAt as number) < 0) {
      throw new Error(`${label}.checkedAt must be a non-negative safe integer`);
    }
    checkedAt = value.checkedAt as number;
  }
  let etag: string | undefined;
  if (value.etag !== undefined) {
    if (typeof value.etag !== "string" || value.etag.length > 1_024 || !/^(?:W\/)?"[\x21\x23-\x7e]*"$/u.test(value.etag)) {
      throw new Error(`${label}.etag is invalid`);
    }
    etag = value.etag;
  }
  return {
    models,
    ...(cacheScope === undefined ? {} : { cacheScope }),
    ...(checkedAt === undefined ? {} : { checkedAt }),
    ...(etag === undefined ? {} : { etag }),
  };
}

function storedEntries(content: string | undefined): Record<string, ProviderModelsStoreEntry> {
  if (content === undefined || content.trim() === "") return Object.create(null) as Record<string, ProviderModelsStoreEntry>;
  const value: unknown = JSON.parse(content);
  assertPlainData(value, "Persisted model store");
  if (!record(value) || Object.keys(value).length > MAX_PROVIDERS) {
    throw new Error("Persisted model store has an invalid shape");
  }
  const entries = Object.create(null) as Record<string, ProviderModelsStoreEntry>;
  for (const [rawProvider, entry] of Object.entries(value)) {
    const provider = validatedProviderId(rawProvider);
    entries[provider] = storedEntry(provider, entry);
  }
  return entries;
}

/** Locked JSON storage for provider-owned dynamic model catalogs. */
export class FileProviderModelsStore implements ProviderModelsStore {
  readonly #path: string;
  readonly #lock: CrossProcessFileLock;

  constructor(path: string) {
    if (path.trim() === "" || path.includes("\0")) throw new TypeError("Model store path is invalid");
    this.#path = path;
    this.#lock = new CrossProcessFileLock(`${path}.lock`);
  }

  async #read(): Promise<Record<string, ProviderModelsStoreEntry>> {
    let handle;
    try {
      handle = await open(this.#path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    try {
      const information = await handle.stat();
      if (!information.isFile()) throw new Error("Persisted model store is not a regular file");
      if (information.size > MAX_STORE_BYTES) throw new Error("Persisted model store exceeds 64 MiB");
      return storedEntries(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  }

  async #write(entries: Record<string, ProviderModelsStoreEntry>): Promise<void> {
    const content = `${JSON.stringify(entries, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_STORE_BYTES) {
      throw new Error("Persisted model store exceeds 64 MiB");
    }
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(content, "utf8");
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

  async #deleteIfUnchanged(providerId: string, expected: ProviderModelsStoreEntry): Promise<void> {
    await this.#lock.run(async () => {
      const entries = await this.#read();
      if (!isDeepStrictEqual(entries[providerId], expected)) return;
      delete entries[providerId];
      await this.#write(entries);
    });
  }

  async snapshot(): Promise<ProviderModelsStore> {
    const entries = await this.#lock.run(async () => await this.#read());
    return {
      read: async (providerId, cacheScope) => {
        const id = validatedProviderId(providerId);
        const entry = entries[id];
        if (entry !== undefined && cacheScope !== undefined && entry.cacheScope !== cacheScope) {
          delete entries[id];
          await this.#deleteIfUnchanged(id, entry);
          return undefined;
        }
        return structuredClone(entry);
      },
      write: async (providerId, entry) => {
        const id = validatedProviderId(providerId);
        const validated = storedEntry(id, entry);
        await this.write(id, validated);
        entries[id] = structuredClone(validated);
      },
      delete: async (providerId) => {
        const id = validatedProviderId(providerId);
        await this.delete(id);
        delete entries[id];
      },
    };
  }

  async read(providerId: string, cacheScope?: string): Promise<ProviderModelsStoreEntry | undefined> {
    const id = validatedProviderId(providerId);
    return await this.#lock.run(async () => {
      const entries = await this.#read();
      const entry = entries[id];
      if (entry !== undefined && cacheScope !== undefined && entry.cacheScope !== cacheScope) {
        delete entries[id];
        await this.#write(entries);
        return undefined;
      }
      return structuredClone(entry);
    });
  }

  async write(providerId: string, entry: ProviderModelsStoreEntry): Promise<void> {
    const id = validatedProviderId(providerId);
    const validated = storedEntry(id, entry);
    await this.#lock.run(async () => {
      const entries = await this.#read();
      entries[id] = validated;
      await this.#write(entries);
    });
  }

  async delete(providerId: string): Promise<void> {
    const id = validatedProviderId(providerId);
    await this.#lock.run(async () => {
      const entries = await this.#read();
      if (!Object.hasOwn(entries, id)) return;
      delete entries[id];
      await this.#write(entries);
    });
  }
}
