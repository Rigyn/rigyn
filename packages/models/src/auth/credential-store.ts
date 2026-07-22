import type { Credential, CredentialInfo, CredentialStore } from "./types.js";

export class InMemoryCredentialStore implements CredentialStore {
  readonly #values = new Map<string, Credential>();
  readonly #tails = new Map<string, Promise<unknown>>();
  #serial<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(providerId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.#tails.set(providerId, next.catch(() => undefined));
    return next;
  }
  async read(providerId: string): Promise<Credential | undefined> { const value = this.#values.get(providerId); return value ? structuredClone(value) : undefined; }
  async list(): Promise<readonly CredentialInfo[]> { return [...this.#values].map(([providerId, value]) => ({ providerId, type: value.type })); }
  modify(providerId: string, operation: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return this.#serial(providerId, async () => {
      const current = this.#values.get(providerId);
      const replacement = await operation(current ? structuredClone(current) : undefined);
      if (replacement) this.#values.set(providerId, structuredClone(replacement));
      const result = replacement ?? current;
      return result ? structuredClone(result) : undefined;
    });
  }
  delete(providerId: string): Promise<void> { return this.#serial(providerId, async () => { this.#values.delete(providerId); }); }
}
