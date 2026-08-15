import type {
  AuthCredential,
  CredentialSummary,
  MutableCredentialStore,
} from "../../src/auth/types.js";

export class InMemoryCredentialStore implements MutableCredentialStore {
  readonly #values = new Map<string, AuthCredential>();

  constructor(entries: ReadonlyArray<readonly [string, AuthCredential]> = []) {
    for (const [id, credential] of entries) this.#values.set(id, structuredClone(credential));
  }

  async read(id: string): Promise<AuthCredential | undefined> {
    return structuredClone(this.#values.get(id));
  }

  async write(id: string, credential: AuthCredential): Promise<void> {
    this.#values.set(id, structuredClone(credential));
  }

  async delete(id: string): Promise<void> {
    this.#values.delete(id);
  }

  async withLock<T>(_id: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    return await operation();
  }

  async list(): Promise<readonly CredentialSummary[]> {
    return [...this.#values.entries()].map(([providerId, credential]) => ({
      providerId,
      type: credential.kind,
    }));
  }

  async modify(
    id: string,
    operation: (current: AuthCredential | undefined) => Promise<AuthCredential | undefined>,
    signal?: AbortSignal,
  ): Promise<AuthCredential | undefined> {
    signal?.throwIfAborted();
    const current = await this.read(id);
    const replacement = await operation(current);
    if (replacement === undefined) return current;
    this.#values.set(id, structuredClone(replacement));
    return structuredClone(replacement);
  }
}
