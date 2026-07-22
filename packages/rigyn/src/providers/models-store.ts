import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { CrossProcessFileLock } from "../auth/file-store.js";
import type { ProviderModel } from "./models.js";

const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_PROVIDERS = 512;

export interface ProviderModelsStoreEntry {
  models: readonly ProviderModel[];
  checkedAt?: number;
}

export interface ProviderModelsStore {
  read(providerId: string): Promise<ProviderModelsStoreEntry | undefined>;
  write(providerId: string, entry: ProviderModelsStoreEntry): Promise<void>;
  delete(providerId: string): Promise<void>;
}

export interface ScopedProviderModelsStore {
  read(): Promise<ProviderModelsStoreEntry | undefined>;
  write(entry: ProviderModelsStoreEntry): Promise<void>;
  delete(): Promise<void>;
}

export class InMemoryProviderModelsStore implements ProviderModelsStore {
  readonly #entries = new Map<string, ProviderModelsStoreEntry>();

  async read(providerId: string): Promise<ProviderModelsStoreEntry | undefined> {
    const entry = this.#entries.get(providerId);
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

function storedEntries(content: string | undefined): Record<string, ProviderModelsStoreEntry> {
  if (content === undefined || content.trim() === "") return {};
  const value: unknown = JSON.parse(content);
  if (!record(value) || Object.keys(value).length > MAX_PROVIDERS) {
    throw new Error("Persisted model store has an invalid shape");
  }
  const entries: Record<string, ProviderModelsStoreEntry> = {};
  for (const [provider, entry] of Object.entries(value)) {
    if (!record(entry) || !Array.isArray(entry.models)) {
      throw new Error(`Persisted model store entry is invalid: ${provider}`);
    }
    entries[provider] = structuredClone(entry) as unknown as ProviderModelsStoreEntry;
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

  async read(providerId: string): Promise<ProviderModelsStoreEntry | undefined> {
    return await this.#lock.run(async () => structuredClone((await this.#read())[providerId]));
  }

  async write(providerId: string, entry: ProviderModelsStoreEntry): Promise<void> {
    await this.#lock.run(async () => {
      const entries = await this.#read();
      entries[providerId] = structuredClone(entry);
      await this.#write(entries);
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.#lock.run(async () => {
      const entries = await this.#read();
      if (!(providerId in entries)) return;
      delete entries[providerId];
      await this.#write(entries);
    });
  }
}
