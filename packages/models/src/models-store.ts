import type { Api, Model } from "./types.js";
export interface ModelsStoreEntry { models: readonly Model<Api>[]; checkedAt?: number; }
export interface ModelsStore { read(providerId: string): Promise<ModelsStoreEntry | undefined>; write(providerId: string, entry: ModelsStoreEntry): Promise<void>; delete(providerId: string): Promise<void>; }
export interface ProviderModelsStore { read(): Promise<ModelsStoreEntry | undefined>; write(entry: ModelsStoreEntry): Promise<void>; delete(): Promise<void>; }
export class InMemoryModelsStore implements ModelsStore {
  readonly #entries = new Map<string, ModelsStoreEntry>();
  async read(providerId: string): Promise<ModelsStoreEntry | undefined> { const entry = this.#entries.get(providerId); return entry ? structuredClone(entry) : undefined; }
  async write(providerId: string, entry: ModelsStoreEntry): Promise<void> { this.#entries.set(providerId, structuredClone(entry)); }
  async delete(providerId: string): Promise<void> { this.#entries.delete(providerId); }
}
