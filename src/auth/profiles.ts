import { createHash } from "node:crypto";

import {
  assertAuthCredential,
  assertCredentialId,
  isCredentialProfileMetadataStore,
  type AuthCredential,
  type CredentialProfileMetadataStore,
  type CredentialStore,
} from "./types.js";

const MAX_PROFILES = 64;
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

interface StoredProfileEntry {
  name: string;
  storage: "legacy" | "profile";
}

interface StoredProfileIndex {
  version: 1;
  credentialId: string;
  activeProfile?: string;
  fallbackSelected?: true;
  profiles: StoredProfileEntry[];
}

export interface CredentialProfileSummary {
  name: string;
  active: boolean;
  present: boolean;
  usable: boolean;
  kind?: AuthCredential["kind"];
  expiresAt?: number;
  accountId?: string;
  subject?: string;
  error?: string;
}

export interface CredentialProfileState {
  credentialId: string;
  activeProfile?: string;
  fallbackSelected: boolean;
  profiles: CredentialProfileSummary[];
}

export interface ActiveCredentialProfile {
  configured: boolean;
  fallbackSelected?: true;
  name?: string;
  storageId?: string;
  credential?: AuthCredential;
}

export function assertCredentialProfileName(name: string): void {
  if (!PROFILE_NAME.test(name)) {
    throw new TypeError("Credential profile name must contain 1-64 letters, numbers, dots, underscores, or hyphens");
  }
}

function profileStorageId(credentialId: string, profile: string): string {
  const digest = createHash("sha256")
    .update("rigyn-credential-profile-v1\0")
    .update(credentialId)
    .update("\0")
    .update(profile)
    .digest("base64url");
  return `credential-profile-v1:${digest}`;
}

function storageId(credentialId: string, entry: StoredProfileEntry): string {
  return entry.storage === "legacy" ? credentialId : profileStorageId(credentialId, entry.name);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Credential profile index is malformed");
  }
  return value as Record<string, unknown>;
}

function parseIndex(value: unknown, credentialId: string): StoredProfileIndex {
  const input = record(value);
  if (
    input.version !== 1 ||
    input.credentialId !== credentialId ||
    !Array.isArray(input.profiles) ||
    input.profiles.length > MAX_PROFILES ||
    (input.activeProfile !== undefined && typeof input.activeProfile !== "string") ||
    (input.fallbackSelected !== undefined && input.fallbackSelected !== true) ||
    !Object.keys(input).every((key) => ["version", "credentialId", "activeProfile", "fallbackSelected", "profiles"].includes(key))
  ) throw new Error("Credential profile index is malformed");

  const names = new Set<string>();
  const profiles = input.profiles.map((value): StoredProfileEntry => {
    const entry = record(value);
    if (
      typeof entry.name !== "string" ||
      !PROFILE_NAME.test(entry.name) ||
      (entry.storage !== "legacy" && entry.storage !== "profile") ||
      !Object.keys(entry).every((key) => key === "name" || key === "storage") ||
      names.has(entry.name)
    ) throw new Error("Credential profile index is malformed");
    if (entry.storage === "legacy" && entry.name !== "default") {
      throw new Error("Credential profile index has an invalid legacy entry");
    }
    names.add(entry.name);
    return { name: entry.name, storage: entry.storage };
  });
  const activeProfile = input.activeProfile as string | undefined;
  if (activeProfile !== undefined && !names.has(activeProfile)) {
    throw new Error("Credential profile index has an unknown active profile");
  }
  if (activeProfile !== undefined && input.fallbackSelected === true) {
    throw new Error("Credential profile index has conflicting source selections");
  }
  if (profiles.length === 0 && input.fallbackSelected === true) {
    throw new Error("Credential profile index selects fallback without stored profiles");
  }
  return {
    version: 1,
    credentialId,
    ...(activeProfile === undefined ? {} : { activeProfile }),
    ...(input.fallbackSelected === true ? { fallbackSelected: true as const } : {}),
    profiles,
  };
}

function details(credential: AuthCredential): Omit<CredentialProfileSummary, "name" | "active" | "present" | "usable"> {
  if (credential.kind === "ambient") return { kind: credential.kind };
  return {
    kind: credential.kind,
    ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }),
    ...((credential.kind === "bearer" || credential.kind === "oauth") && credential.subject !== undefined
      ? { subject: credential.subject }
      : {}),
    ...((credential.kind === "bearer" || credential.kind === "oauth") && credential.expiresAt !== undefined
      ? { expiresAt: credential.expiresAt }
      : {}),
  };
}

function usable(credential: AuthCredential, now: number): boolean {
  if (credential.kind === "api_key" || credential.kind === "ambient") return true;
  if (credential.kind === "bearer") return credential.expiresAt === undefined || credential.expiresAt > now;
  return credential.expiresAt > now || (
    credential.refreshToken !== undefined &&
    credential.tokenEndpoint !== undefined &&
    credential.clientId !== undefined
  );
}

export class CredentialProfileManager {
  readonly #store: CredentialProfileMetadataStore;
  readonly #credentialId: string;
  readonly #now: () => number;

  constructor(store: CredentialStore, credentialId: string, options: { now?: () => number } = {}) {
    assertCredentialId(credentialId);
    if (!isCredentialProfileMetadataStore(store)) {
      throw new Error("Credential store does not support named profiles");
    }
    this.#store = store;
    this.#credentialId = credentialId;
    this.#now = options.now ?? Date.now;
  }

  async state(): Promise<CredentialProfileState> {
    return this.#store.withLock(this.#credentialId, async () => {
      const index = await this.#loadOrMigrateLocked();
      const profiles: CredentialProfileSummary[] = [];
      for (const entry of index.profiles) {
        const credential = await this.#store.read(storageId(this.#credentialId, entry));
        if (credential === undefined) {
          profiles.push({
            name: entry.name,
            active: index.activeProfile === entry.name,
            present: false,
            usable: false,
            error: "Stored credential is missing",
          });
          continue;
        }
        if (credential.provider !== this.#credentialId) {
          profiles.push({
            name: entry.name,
            active: index.activeProfile === entry.name,
            present: true,
            usable: false,
            error: "Stored credential provider does not match this registration",
          });
          continue;
        }
        profiles.push({
          name: entry.name,
          active: index.activeProfile === entry.name,
          present: true,
          usable: usable(credential, this.#now()),
          ...details(credential),
        });
      }
      return {
        credentialId: this.#credentialId,
        ...(index.activeProfile === undefined ? {} : { activeProfile: index.activeProfile }),
        fallbackSelected: index.fallbackSelected === true,
        profiles,
      };
    });
  }

  async active(): Promise<ActiveCredentialProfile> {
    return this.#store.withLock(this.#credentialId, async () => {
      const index = await this.#loadOrMigrateLocked();
      if (index.profiles.length === 0) return { configured: false };
      if (index.fallbackSelected === true) return { configured: true, fallbackSelected: true };
      if (index.activeProfile === undefined) return { configured: true };
      const entry = index.profiles.find((candidate) => candidate.name === index.activeProfile);
      if (entry === undefined) throw new Error("Credential profile index has an unknown active profile");
      const id = storageId(this.#credentialId, entry);
      const credential = await this.#store.read(id);
      if (credential === undefined) {
        return { configured: true, name: entry.name, storageId: id };
      }
      if (credential.provider !== this.#credentialId) {
        throw new Error("Active credential profile belongs to a different provider registration");
      }
      return { configured: true, name: entry.name, storageId: id, credential };
    });
  }

  async read(name: string): Promise<AuthCredential | undefined> {
    assertCredentialProfileName(name);
    return this.#store.withLock(this.#credentialId, async () => {
      const index = await this.#loadOrMigrateLocked();
      const entry = index.profiles.find((candidate) => candidate.name === name);
      if (entry === undefined) return undefined;
      const credential = await this.#store.read(storageId(this.#credentialId, entry));
      if (credential !== undefined && credential.provider !== this.#credentialId) {
        throw new Error("Credential profile belongs to a different provider registration");
      }
      return credential;
    });
  }

  async create(name: string, credential: AuthCredential, options: { select?: boolean } = {}): Promise<void> {
    assertCredentialProfileName(name);
    assertAuthCredential(credential);
    if (credential.provider !== this.#credentialId) {
      throw new TypeError("Credential provider must match the profile registration");
    }
    const snapshot = structuredClone(credential);
    return this.#store.withLock(this.#credentialId, async () => {
      const index = await this.#loadOrMigrateLocked();
      if (index.profiles.some((entry) => entry.name === name)) {
        throw new Error(`Credential profile already exists: ${name}`);
      }
      if (index.profiles.length >= MAX_PROFILES) throw new Error("Credential profile limit reached");
      const entry: StoredProfileEntry = { name, storage: "profile" };
      const id = storageId(this.#credentialId, entry);
      await this.#store.write(id, snapshot);
      const next: StoredProfileIndex = {
        ...index,
        profiles: [...index.profiles, entry],
        ...((index.profiles.length === 0 || options.select === true) ? { activeProfile: name } : {}),
      };
      if (next.activeProfile !== undefined) delete next.fallbackSelected;
      try {
        await this.#store.writeCredentialProfileIndex(this.#credentialId, next);
      } catch (error) {
        return await this.#rollbackCredential(id, undefined, error);
      }
    });
  }

  async update(name: string, credential: AuthCredential): Promise<void> {
    assertCredentialProfileName(name);
    assertAuthCredential(credential);
    if (credential.provider !== this.#credentialId) {
      throw new TypeError("Credential provider must match the profile registration");
    }
    const snapshot = structuredClone(credential);
    return this.#store.withLock(this.#credentialId, async () => {
      const index = await this.#loadOrMigrateLocked();
      const entry = index.profiles.find((candidate) => candidate.name === name);
      if (entry === undefined) throw new Error(`Credential profile not found: ${name}`);
      await this.#store.write(storageId(this.#credentialId, entry), snapshot);
    });
  }

  async put(name: string, credential: AuthCredential, options: { select?: boolean } = {}): Promise<"created" | "updated"> {
    assertCredentialProfileName(name);
    assertAuthCredential(credential);
    if (credential.provider !== this.#credentialId) {
      throw new TypeError("Credential provider must match the profile registration");
    }
    const snapshot = structuredClone(credential);
    return this.#store.withLock(this.#credentialId, async () => {
      const index = await this.#loadOrMigrateLocked();
      return this.#putLocked(index, name, snapshot, options.select === true);
    });
  }

  async putSelected(
    credential: AuthCredential,
    options: { profile?: string; select?: boolean } = {},
  ): Promise<{ profile: string; action: "created" | "updated" }> {
    assertAuthCredential(credential);
    if (credential.provider !== this.#credentialId) {
      throw new TypeError("Credential provider must match the profile registration");
    }
    if (options.profile !== undefined) assertCredentialProfileName(options.profile);
    const snapshot = structuredClone(credential);
    return this.#store.withLock(this.#credentialId, async () => {
      const index = await this.#loadOrMigrateLocked();
      if (
        options.profile === undefined &&
        index.profiles.length > 0 &&
        index.activeProfile === undefined &&
        index.fallbackSelected !== true
      ) {
        throw new Error("Stored credential profiles exist but none is selected; specify a profile explicitly");
      }
      const profile = options.profile ?? index.activeProfile ?? "default";
      return {
        profile,
        action: await this.#putLocked(index, profile, snapshot, options.select ?? true),
      };
    });
  }

  async select(name: string): Promise<void> {
    assertCredentialProfileName(name);
    return this.#store.withLock(this.#credentialId, async () => {
      const index = await this.#loadOrMigrateLocked();
      if (!index.profiles.some((entry) => entry.name === name)) {
        throw new Error(`Credential profile not found: ${name}`);
      }
      const { fallbackSelected: _fallbackSelected, ...selected } = index;
      await this.#store.writeCredentialProfileIndex(this.#credentialId, { ...selected, activeProfile: name });
    });
  }

  async selectFallback(): Promise<void> {
    return this.#store.withLock(this.#credentialId, async () => {
      const index = await this.#loadOrMigrateLocked();
      if (index.profiles.length === 0) return;
      const { activeProfile: _activeProfile, ...fallback } = index;
      await this.#store.writeCredentialProfileIndex(this.#credentialId, { ...fallback, fallbackSelected: true });
    });
  }

  async deactivate(): Promise<void> {
    return this.#store.withLock(this.#credentialId, async () => {
      const index = await this.#loadOrMigrateLocked();
      if (index.activeProfile === undefined && index.fallbackSelected !== true) return;
      const { activeProfile: _activeProfile, fallbackSelected: _fallbackSelected, ...next } = index;
      await this.#store.writeCredentialProfileIndex(this.#credentialId, next);
    });
  }

  async delete(name: string): Promise<boolean> {
    assertCredentialProfileName(name);
    return this.#store.withLock(this.#credentialId, async () => {
      const index = await this.#loadOrMigrateLocked();
      const entry = index.profiles.find((candidate) => candidate.name === name);
      if (entry === undefined) return false;
      const id = storageId(this.#credentialId, entry);
      const previous = await this.#store.read(id);
      await this.#store.delete(id);
      const profiles = index.profiles.filter((candidate) => candidate !== entry);
      try {
        if (profiles.length === 0) {
          await this.#store.deleteCredentialProfileIndex(this.#credentialId);
        } else {
          const next: StoredProfileIndex = {
            version: 1,
            credentialId: this.#credentialId,
            profiles,
            ...(index.activeProfile === name || index.activeProfile === undefined ? {} : { activeProfile: index.activeProfile }),
            ...(index.activeProfile === name || index.fallbackSelected !== true ? {} : { fallbackSelected: true }),
          };
          await this.#store.writeCredentialProfileIndex(this.#credentialId, next);
        }
      } catch (error) {
        return await this.#rollbackCredential(id, previous, error);
      }
      return true;
    });
  }

  async #putLocked(
    index: StoredProfileIndex,
    name: string,
    credential: AuthCredential,
    select: boolean,
  ): Promise<"created" | "updated"> {
    const existing = index.profiles.find((candidate) => candidate.name === name);
    if (existing !== undefined) {
      const id = storageId(this.#credentialId, existing);
      const previous = await this.#store.read(id);
      await this.#store.write(id, credential);
      if (select && (index.activeProfile !== name || index.fallbackSelected === true)) {
        const { fallbackSelected: _fallbackSelected, ...selected } = index;
        try {
          await this.#store.writeCredentialProfileIndex(this.#credentialId, { ...selected, activeProfile: name });
        } catch (error) {
          return await this.#rollbackCredential(id, previous, error);
        }
      }
      return "updated";
    }
    if (index.profiles.length >= MAX_PROFILES) throw new Error("Credential profile limit reached");
    const entry: StoredProfileEntry = { name, storage: "profile" };
    const id = storageId(this.#credentialId, entry);
    await this.#store.write(id, credential);
    const next: StoredProfileIndex = {
      ...index,
      profiles: [...index.profiles, entry],
      ...((index.profiles.length === 0 || select) ? { activeProfile: name } : {}),
    };
    if (next.activeProfile !== undefined) delete next.fallbackSelected;
    try {
      await this.#store.writeCredentialProfileIndex(this.#credentialId, next);
    } catch (error) {
      return await this.#rollbackCredential(id, undefined, error);
    }
    return "created";
  }

  async #rollbackCredential(
    id: string,
    previous: AuthCredential | undefined,
    cause: unknown,
  ): Promise<never> {
    try {
      if (previous === undefined) await this.#store.delete(id);
      else await this.#store.write(id, previous);
    } catch (rollbackError) {
      throw new AggregateError(
        [cause, rollbackError],
        "Credential profile update failed and credential rollback also failed",
      );
    }
    throw cause;
  }

  async #loadOrMigrateLocked(): Promise<StoredProfileIndex> {
    const stored = await this.#store.readCredentialProfileIndex(this.#credentialId);
    if (stored !== undefined) return parseIndex(stored, this.#credentialId);
    const legacy = await this.#store.read(this.#credentialId);
    if (legacy === undefined) return { version: 1, credentialId: this.#credentialId, profiles: [] };
    if (legacy.provider !== this.#credentialId) {
      throw new Error("Legacy credential belongs to a different provider registration");
    }
    const migrated: StoredProfileIndex = {
      version: 1,
      credentialId: this.#credentialId,
      activeProfile: "default",
      profiles: [{ name: "default", storage: "legacy" }],
    };
    await this.#store.writeCredentialProfileIndex(this.#credentialId, migrated);
    return migrated;
  }
}
