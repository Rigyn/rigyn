import { defaultSecretRedactor, type SecretRedactor } from "./redaction.js";
import type { CredentialStore, OAuthCredential } from "./types.js";

export interface OAuthRefreshResult {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
  tokenType?: string;
  scopes?: string[];
  accountId?: string;
  subject?: string;
  providerData?: Record<string, string>;
}

export type OAuthRefresher = (
  credential: OAuthCredential,
  signal?: AbortSignal,
) => Promise<OAuthRefreshResult>;

export interface RefreshOptions {
  force?: boolean;
  minimumValidityMs?: number;
  signal?: AbortSignal;
}

export class OAuthRefreshCoordinator {
  readonly #store: CredentialStore;
  readonly #refresh: OAuthRefresher;
  readonly #redactor: SecretRedactor;
  readonly #now: () => number;
  readonly #inFlight = new Map<string, Promise<OAuthCredential>>();

  constructor(options: {
    store: CredentialStore;
    refresh: OAuthRefresher;
    redactor?: SecretRedactor;
    now?: () => number;
  }) {
    this.#store = options.store;
    this.#refresh = options.refresh;
    this.#redactor = options.redactor ?? defaultSecretRedactor;
    this.#now = options.now ?? Date.now;
  }

  async getValid(id: string, options: RefreshOptions = {}): Promise<OAuthCredential> {
    options.signal?.throwIfAborted();
    const current = await this.#readOAuth(id);
    const minimumValidityMs = options.minimumValidityMs ?? 5 * 60_000;
    if (!Number.isFinite(minimumValidityMs) || minimumValidityMs < 0) {
      throw new TypeError("minimumValidityMs must be a non-negative number");
    }
    if (!options.force && current.expiresAt - this.#now() > minimumValidityMs) return current;

    const existing = this.#inFlight.get(id);
    if (existing !== undefined) return existing;
    const operation = this.#refreshLocked(id, current.accessToken, minimumValidityMs, options);
    this.#inFlight.set(id, operation);
    try {
      return await operation;
    } finally {
      if (this.#inFlight.get(id) === operation) this.#inFlight.delete(id);
    }
  }

  async #refreshLocked(
    id: string,
    previousAccessToken: string,
    minimumValidityMs: number,
    options: RefreshOptions,
  ): Promise<OAuthCredential> {
    return this.#store.withLock(
      id,
      async () => {
        options.signal?.throwIfAborted();
        const current = await this.#readOAuth(id);
        const anotherProcessRefreshed = current.accessToken !== previousAccessToken;
        if (
          anotherProcessRefreshed ||
          (!options.force && current.expiresAt - this.#now() > minimumValidityMs)
        ) {
          return current;
        }
        if (current.refreshToken === undefined || current.refreshToken.length === 0) {
          throw new Error("OAuth credential cannot be refreshed; reauthentication is required");
        }
        this.#redactor.register(current.accessToken);
        this.#redactor.register(current.refreshToken);
        const refreshed = await this.#refresh(current, options.signal);
        if (
          refreshed.accessToken.length === 0 ||
          !Number.isFinite(refreshed.expiresAt) ||
          refreshed.expiresAt <= this.#now()
        ) {
          throw new Error("OAuth refresh returned an invalid access token or expiry");
        }
        this.#guardIdentity("account", current.accountId, refreshed.accountId);
        this.#guardIdentity("subject", current.subject, refreshed.subject);

        const next: OAuthCredential = {
          kind: "oauth",
          provider: current.provider,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? current.refreshToken,
          expiresAt: refreshed.expiresAt,
          tokenType: refreshed.tokenType ?? current.tokenType,
          scopes: [...(refreshed.scopes ?? current.scopes)],
          ...(current.tokenEndpoint === undefined ? {} : { tokenEndpoint: current.tokenEndpoint }),
          ...(current.revocationEndpoint === undefined ? {} : { revocationEndpoint: current.revocationEndpoint }),
          ...(current.clientId === undefined ? {} : { clientId: current.clientId }),
          ...(current.accountId === undefined && refreshed.accountId === undefined
            ? {}
            : { accountId: refreshed.accountId ?? current.accountId }),
          ...(current.subject === undefined && refreshed.subject === undefined
            ? {}
            : { subject: refreshed.subject ?? current.subject }),
          ...((current.providerData === undefined && refreshed.providerData === undefined)
            ? {}
            : { providerData: { ...(current.providerData ?? {}), ...(refreshed.providerData ?? {}) } }),
        };
        this.#redactor.register(next.accessToken);
        this.#redactor.register(next.refreshToken);
        await this.#store.write(id, next);
        return next;
      },
      options.signal,
    );
  }

  async #readOAuth(id: string): Promise<OAuthCredential> {
    const credential = await this.#store.read(id);
    if (credential?.kind !== "oauth") throw new Error(`OAuth credential not found: ${id}`);
    return credential;
  }

  #guardIdentity(label: string, current: string | undefined, refreshed: string | undefined): void {
    if (current !== undefined && refreshed !== undefined && current !== refreshed) {
      throw new Error(`OAuth refresh changed ${label} identity; reauthentication is required`);
    }
  }
}
