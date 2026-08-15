import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CrossProcessFileLock, type FileLockOptions } from "./file-store.js";
import { assertMacosKeychainHelperPath, macosKeychainHelperPath } from "./macos-keychain-helper.js";
import { defaultSecretRedactor, type SecretRedactor } from "./redaction.js";
import {
  minimalProcessEnvironment,
  runSafeProcess,
  type SafeProcessOptions,
  type SafeProcessResult,
} from "./process.js";
import {
  assertCredentialId,
  assertAuthCredential,
  credentialSecrets,
  isAuthCredential,
  type AuthCredential,
  type CredentialSummary,
  type CredentialProfileMetadataStore,
  type MutableCredentialStore,
} from "./types.js";

const CREDENTIAL_INDEX_ACCOUNT = "credential-index-v2";
const CREDENTIAL_METADATA_SERVICE_SUFFIX = ":metadata-v2";
const MAX_CREDENTIAL_INDEX_BYTES = 64 * 1024;
const MAX_CREDENTIAL_INDEX_ENTRIES = 4096;
const MACOS_HELPER_PROTOCOL_VERSION = 1;
const MACOS_HELPER_MAX_MESSAGE_BYTES = 1024 * 1024;

interface CredentialIndexValue {
  providerId: string;
  type: AuthCredential["kind"];
}

type CredentialIndexEntry =
  | (CredentialIndexValue & { state: "committed" })
  | (CredentialIndexValue & { state: "deleting" })
  | (CredentialIndexValue & { state: "pending"; previous?: CredentialIndexValue });

interface CredentialIndex {
  version: 2;
  entries: Record<string, CredentialIndexEntry>;
  profileIds: string[];
}

interface StoredCredentialRecord {
  credential: AuthCredential;
  legacy: boolean;
}

export interface KeychainAdapter {
  get(service: string, account: string, signal?: AbortSignal, sensitive?: boolean): Promise<string | undefined>;
  set(service: string, account: string, secret: string, signal?: AbortSignal, sensitive?: boolean): Promise<void>;
  delete(service: string, account: string, signal?: AbortSignal): Promise<void>;
}

export type KeychainCommandRunner = (options: SafeProcessOptions) => Promise<SafeProcessResult>;

function validateName(value: string, label: string): void {
  if (value.length === 0 || value.includes("\0")) throw new TypeError(`${label} is invalid`);
}

export class PlatformKeychainAdapter implements KeychainAdapter {
  readonly #platform: NodeJS.Platform;
  readonly #run: KeychainCommandRunner;
  readonly #redactor: SecretRedactor;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #macosHelperPath: string | undefined;

  constructor(options?: {
    platform?: NodeJS.Platform;
    runner?: KeychainCommandRunner;
    redactor?: SecretRedactor;
    environment?: NodeJS.ProcessEnv;
    macosHelperPath?: string;
  }) {
    this.#platform = options?.platform ?? process.platform;
    this.#run = options?.runner ?? runSafeProcess;
    this.#redactor = options?.redactor ?? defaultSecretRedactor;
    this.#environment = platformKeychainEnvironment(options?.environment ?? process.env);
    if (this.#platform !== "darwin" && this.#platform !== "linux") {
      throw new Error(`No command-backed keychain adapter is available on ${this.#platform}`);
    }
    this.#macosHelperPath = this.#platform === "darwin"
      ? options?.macosHelperPath ?? macosKeychainHelperPath()
      : undefined;
    if (this.#macosHelperPath !== undefined) assertMacosKeychainHelperPath(this.#macosHelperPath);
  }

  async get(service: string, account: string, signal?: AbortSignal, sensitive = true): Promise<string | undefined> {
    this.#validate(service, account);
    if (this.#platform === "darwin") {
      const secret = await this.#runMacos("get", service, account, undefined, signal);
      if (secret !== undefined && sensitive) this.#redactor.register(secret);
      return secret;
    }
    const result =
      await this.#run({
        command: "/usr/bin/secret-tool",
        args: ["lookup", "service", service, "account", account],
        environment: this.#environment,
        ...(signal === undefined ? {} : { signal }),
        redactor: this.#redactor,
      });
    if (result.exitCode !== 0) {
      if (
        result.exitCode === 1
        && result.stdout === ""
        && result.stderr.trim() === ""
      ) return undefined;
      this.#requireSuccess(result, "read keychain credential");
    }
    const secret = result.stdout.replace(/\r?\n$/, "");
    if (secret.length === 0) return undefined;
    if (sensitive) this.#redactor.register(secret);
    return secret;
  }

  async set(
    service: string,
    account: string,
    secret: string,
    signal?: AbortSignal,
    sensitive = true,
  ): Promise<void> {
    this.#validate(service, account);
    if (secret.length === 0 || secret.includes("\0")) throw new TypeError("Secret is invalid");
    if (this.#platform === "darwin") {
      if (sensitive) this.#redactor.register(secret);
      await this.#runMacos("set", service, account, secret, signal);
      return;
    }
    if (sensitive) this.#redactor.register(secret);
    const result = await this.#run({
      command: "/usr/bin/secret-tool",
      args: ["store", `--label=rigyn: ${service}`, "service", service, "account", account],
      environment: this.#environment,
      input: secret,
      ...(signal === undefined ? {} : { signal }),
      redactor: this.#redactor,
    });
    this.#requireSuccess(result, "store keychain credential");
  }

  async delete(service: string, account: string, signal?: AbortSignal): Promise<void> {
    this.#validate(service, account);
    if (this.#platform === "darwin") {
      await this.#runMacos("delete", service, account, undefined, signal);
      return;
    }
    const result = await this.#run({
      command: "/usr/bin/secret-tool",
      args: ["clear", "service", service, "account", account],
      environment: this.#environment,
      ...(signal === undefined ? {} : { signal }),
      redactor: this.#redactor,
    });
    if (
      result.exitCode !== 0
      && !(result.exitCode === 1 && result.stderr.trim() === "")
    ) {
      this.#requireSuccess(result, "delete keychain credential");
    }
  }

  #validate(service: string, account: string): void {
    validateName(service, "Service");
    validateName(account, "Account");
  }

  async #runMacos(
    operation: "get" | "set" | "delete",
    service: string,
    account: string,
    secret: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    const request = {
      version: MACOS_HELPER_PROTOCOL_VERSION,
      operation,
      service,
      account,
      ...(secret === undefined ? {} : { secret }),
    };
    const input = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(input, "utf8") > MACOS_HELPER_MAX_MESSAGE_BYTES) {
      throw new Error("macOS Keychain helper request exceeded 1 MiB");
    }
    const result = await this.#run({
      command: this.#macosHelperPath!,
      args: [],
      input,
      environment: this.#environment,
      maxOutputBytes: MACOS_HELPER_MAX_MESSAGE_BYTES,
      ...(signal === undefined ? {} : { signal }),
      redactor: this.#redactor,
    });
    this.#requireSuccess(result, `${operation} macOS Keychain credential`);
    if (result.stderr !== "") throw new Error("macOS Keychain helper returned an invalid response");
    const line = result.stdout.endsWith("\r\n")
      ? result.stdout.slice(0, -2)
      : result.stdout.endsWith("\n")
        ? result.stdout.slice(0, -1)
        : undefined;
    if (line === undefined || line.includes("\n") || line.includes("\r")) {
      throw new Error("macOS Keychain helper returned an invalid response");
    }
    let response: unknown;
    try {
      response = JSON.parse(line) as unknown;
    } catch {
      throw new Error("macOS Keychain helper returned an invalid response");
    }
    if (
      !isRecord(response)
      || response.version !== MACOS_HELPER_PROTOCOL_VERSION
      || (response.status !== "ok" && response.status !== "not_found")
    ) {
      throw new Error("macOS Keychain helper returned an invalid response");
    }
    if (operation === "get") {
      if (response.status === "not_found" && exactKeys(response, ["version", "status"])) return undefined;
      if (
        response.status === "ok"
        && exactKeys(response, ["version", "status", "secret"])
        && typeof response.secret === "string"
        && response.secret.length > 0
        && !response.secret.includes("\0")
      ) return response.secret;
      throw new Error("macOS Keychain helper returned an invalid response");
    }
    if (
      exactKeys(response, ["version", "status"])
      && (response.status === "ok" || (operation === "delete" && response.status === "not_found"))
    ) return undefined;
    throw new Error("macOS Keychain helper returned an invalid response");
  }

  #requireSuccess(result: SafeProcessResult, action: string): void {
    if (result.exitCode === 0) return;
    const detail = result.stderr.trim();
    throw new Error(detail.length === 0 ? `Unable to ${action}` : `Unable to ${action}: ${detail}`);
  }
}

function platformKeychainEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = minimalProcessEnvironment({}, source);
  for (const name of ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY"]) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

export async function probePlatformKeychain(
  adapter: KeychainAdapter,
  signal: AbortSignal = AbortSignal.timeout(3_000),
): Promise<boolean> {
  try {
    await adapter.get("rigyn-keychain-probe-v1", "availability", signal, false);
    return true;
  } catch {
    return false;
  }
}

export class KeychainCredentialStore implements CredentialProfileMetadataStore, MutableCredentialStore {
  readonly #adapter: KeychainAdapter;
  readonly #service: string;
  readonly #metadataService: string;
  readonly #lock: CrossProcessFileLock;
  readonly #lockContext = new AsyncLocalStorage<boolean>();

  constructor(options: {
    adapter: KeychainAdapter;
    service: string;
    lockPath?: string;
    lock?: FileLockOptions;
  }) {
    validateName(options.service, "Service");
    this.#adapter = options.adapter;
    this.#service = options.service;
    this.#metadataService = `${options.service}${CREDENTIAL_METADATA_SERVICE_SUFFIX}`;
    const suffix = createHash("sha256").update(options.service).digest("hex").slice(0, 24);
    this.#lock = new CrossProcessFileLock(
      options.lockPath ?? join(tmpdir(), `rigyn-keychain-${suffix}.lock`),
      options.lock,
    );
  }

  async read(id: string): Promise<AuthCredential | undefined> {
    assertCredentialId(id);
    return (await this.#readCredentialRecord(id))?.credential;
  }

  async list(): Promise<readonly CredentialSummary[]> {
    return await this.withLock(CREDENTIAL_INDEX_ACCOUNT, async () => {
      const index = await this.#recoverCredentialIndex(await this.#readCredentialIndex());
      const summaries = new Map<string, AuthCredential["kind"]>();
      for (const entry of Object.values(index.entries)) {
        if (entry.state === "committed") summaries.set(entry.providerId, entry.type);
      }
      return [...summaries].map(([providerId, type]) => ({ providerId, type }));
    });
  }

  async modify(
    id: string,
    operation: (current: AuthCredential | undefined) => Promise<AuthCredential | undefined>,
    signal?: AbortSignal,
  ): Promise<AuthCredential | undefined> {
    assertCredentialId(id);
    return this.withLock(id, async () => {
      signal?.throwIfAborted();
      const current = await this.read(id);
      const replacement = await operation(current === undefined ? undefined : structuredClone(current));
      signal?.throwIfAborted();
      if (replacement === undefined) return current === undefined ? undefined : structuredClone(current);
      await this.write(id, replacement);
      return structuredClone(replacement);
    }, signal);
  }

  async write(id: string, credential: AuthCredential): Promise<void> {
    assertCredentialId(id);
    assertAuthCredential(credential);
    const snapshot = structuredClone(credential);
    assertAuthCredential(snapshot);
    defaultSecretRedactor.registerAll(credentialSecrets(snapshot));
    await this.#whileLocked(id, async () => {
      const index = await this.#recoverCredentialIndex(await this.#readCredentialIndex());
      const previous = index.entries[id];
      const unindexedCredential = previous === undefined
        ? (await this.#readCredentialRecord(id))?.credential
        : undefined;
      const previousValue = previous?.state === "committed"
        ? { providerId: previous.providerId, type: previous.type }
        : unindexedCredential === undefined
          ? undefined
          : { providerId: unindexedCredential.provider, type: unindexedCredential.kind };
      index.entries[id] = {
        state: "pending",
        providerId: snapshot.provider,
        type: snapshot.kind,
        ...(previousValue === undefined ? {} : { previous: previousValue }),
      };
      await this.#writeCredentialIndex(index);
      await this.#adapter.set(this.#service, credentialAccount(id), JSON.stringify(snapshot));
      await this.#deleteLegacyCredentialIfPresent(id);
      index.entries[id] = {
        state: "committed",
        providerId: snapshot.provider,
        type: snapshot.kind,
      };
      await this.#writeCredentialIndex(index);
    });
  }

  async delete(id: string): Promise<void> {
    assertCredentialId(id);
    await this.#whileLocked(id, async () => {
      const index = await this.#recoverCredentialIndex(await this.#readCredentialIndex());
      const previous = index.entries[id];
      if (previous !== undefined) {
        index.entries[id] = {
          state: "deleting",
          providerId: previous.providerId,
          type: previous.type,
        };
        await this.#writeCredentialIndex(index);
      }
      await this.#adapter.delete(this.#service, credentialAccount(id));
      if (previous === undefined) await this.#adapter.delete(this.#service, id);
      else await this.#deleteLegacyCredentialIfPresent(id);
      if (previous === undefined) return;
      delete index.entries[id];
      await this.#writeCredentialIndex(index);
    });
  }

  /** Deletes every credential and profile record owned by this store. */
  async purge(): Promise<void> {
    await this.withLock(CREDENTIAL_INDEX_ACCOUNT, async () => {
      const index = await this.#readCredentialIndex();
      for (const id of Object.keys(index.entries)) {
        await this.#adapter.delete(this.#service, credentialAccount(id));
        await this.#adapter.delete(this.#service, id);
      }
      for (const id of index.profileIds) {
        const account = profileIndexAccount(id);
        await this.#deleteMetadataValue(this.#metadataService, account);
        await this.#deleteMetadataValue(this.#service, account);
      }
      await this.#deleteMetadataValue(this.#metadataService, CREDENTIAL_INDEX_ACCOUNT);
    });
  }

  async readCredentialProfileIndex(id: string): Promise<unknown | undefined> {
    assertCredentialId(id);
    const account = profileIndexAccount(id);
    const value = await this.#adapter.get(this.#metadataService, account, undefined, false)
      ?? await this.#adapter.get(this.#service, account, undefined, false);
    if (value === undefined) return undefined;
    if (Buffer.byteLength(value, "utf8") > 64 * 1024) throw new Error("Keychain credential profile index exceeded 64 KiB");
    try {
      return JSON.parse(value) as unknown;
    } catch (error) {
      throw new Error("Keychain credential profile index is not valid JSON", { cause: error });
    }
  }

  async listCredentialProfileIds(): Promise<readonly string[]> {
    return await this.withLock(CREDENTIAL_INDEX_ACCOUNT, async () => {
      const index = await this.#recoverCredentialIndex(await this.#readCredentialIndex());
      return [...index.profileIds];
    });
  }

  async writeCredentialProfileIndex(id: string, value: unknown): Promise<void> {
    assertCredentialId(id);
    const serialized = JSON.stringify(structuredClone(value));
    if (serialized === undefined) throw new TypeError("Keychain credential profile index must be JSON-serializable");
    if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) {
      throw new Error("Keychain credential profile index exceeded 64 KiB");
    }
    await this.#whileLocked(id, async () => {
      const index = await this.#recoverCredentialIndex(await this.#readCredentialIndex());
      const registered = index.profileIds.includes(id);
      if (!registered) {
        index.profileIds = [...index.profileIds, id].sort();
        await this.#writeCredentialProfileRegistry(index, id, true);
      }
      try {
        await this.#setMetadataValue(this.#metadataService, profileIndexAccount(id), serialized);
      } catch (error) {
        if (!registered) {
          index.profileIds = index.profileIds.filter((candidate) => candidate !== id);
          try {
            await this.#writeCredentialProfileRegistry(index, id, false);
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], "Unable to store keychain credential profile index");
          }
        }
        throw error;
      }
    });
  }

  async deleteCredentialProfileIndex(id: string): Promise<void> {
    assertCredentialId(id);
    await this.#whileLocked(id, async () => {
      const account = profileIndexAccount(id);
      const metadataValue = await this.#adapter.get(this.#metadataService, account, undefined, false);
      const legacyValue = await this.#adapter.get(this.#service, account, undefined, false);
      const index = await this.#recoverCredentialIndex(await this.#readCredentialIndex());
      const registered = index.profileIds.includes(id);
      try {
        await this.#deleteMetadataValue(this.#metadataService, account);
        await this.#deleteMetadataValue(this.#service, account);
        if (registered) {
          index.profileIds = index.profileIds.filter((candidate) => candidate !== id);
          await this.#writeCredentialProfileRegistry(index, id, false);
        }
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        if (metadataValue !== undefined) {
          try { await this.#setMetadataValue(this.#metadataService, account, metadataValue); }
          catch (rollbackError) { rollbackErrors.push(rollbackError); }
        }
        if (legacyValue !== undefined) {
          try { await this.#setMetadataValue(this.#service, account, legacyValue); }
          catch (rollbackError) { rollbackErrors.push(rollbackError); }
        }
        if (registered) {
          try {
            const rollbackIndex = await this.#recoverCredentialIndex(await this.#readCredentialIndex());
            if (!rollbackIndex.profileIds.includes(id)) {
              rollbackIndex.profileIds = [...rollbackIndex.profileIds, id].sort();
              await this.#writeCredentialProfileRegistry(rollbackIndex, id, true);
            }
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError(
            [error, ...rollbackErrors],
            "Unable to delete keychain credential profile index and restore its prior state",
          );
        }
        throw error;
      }
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

  async #readCredentialRecord(id: string): Promise<StoredCredentialRecord | undefined> {
    let serialized = await this.#adapter.get(this.#service, credentialAccount(id));
    const legacy = serialized === undefined;
    if (legacy) serialized = await this.#adapter.get(this.#service, id);
    if (serialized === undefined) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch (error) {
      throw new Error("Keychain credential is not valid JSON", { cause: error });
    }
    if (!isAuthCredential(value)) throw new Error("Keychain credential has an invalid shape");
    defaultSecretRedactor.registerAll(credentialSecrets(value));
    return { credential: value, legacy };
  }

  async #deleteLegacyCredentialIfPresent(id: string): Promise<void> {
    const serialized = await this.#adapter.get(this.#service, id);
    if (serialized === undefined) return;
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch {
      return;
    }
    if (isAuthCredential(value)) await this.#adapter.delete(this.#service, id);
  }

  async #readCredentialIndex(): Promise<CredentialIndex> {
    const serialized = await this.#adapter.get(
      this.#metadataService,
      CREDENTIAL_INDEX_ACCOUNT,
      undefined,
      false,
    );
    if (serialized === undefined) return { version: 2, entries: {}, profileIds: [] };
    if (Buffer.byteLength(serialized, "utf8") > MAX_CREDENTIAL_INDEX_BYTES) {
      throw new Error("Keychain credential index exceeded 64 KiB");
    }
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch (error) {
      throw new Error("Keychain credential index is not valid JSON", { cause: error });
    }
    if (
      !isRecord(value) ||
      value.version !== 2 ||
      !isRecord(value.entries) ||
      (value.profileIds !== undefined && !Array.isArray(value.profileIds)) ||
      !Object.keys(value).every((name) => name === "version" || name === "entries" || name === "profileIds")
    ) {
      throw new Error("Keychain credential index has an invalid shape");
    }
    const entries = Object.entries(value.entries);
    if (entries.length > MAX_CREDENTIAL_INDEX_ENTRIES) {
      throw new Error("Keychain credential index exceeded its entry limit");
    }
    const rawProfileIds = value.profileIds ?? [];
    if (rawProfileIds.length > MAX_CREDENTIAL_INDEX_ENTRIES) {
      throw new Error("Keychain credential profile index registry exceeded its entry limit");
    }
    const profileIds = new Set<string>();
    for (const id of rawProfileIds) {
      if (typeof id !== "string") throw new Error("Keychain credential profile index registry has an invalid entry");
      assertCredentialId(id);
      if (profileIds.has(id)) throw new Error("Keychain credential profile index registry has a duplicate entry");
      profileIds.add(id);
    }
    const index: CredentialIndex = { version: 2, entries: {}, profileIds: [...profileIds].sort() };
    for (const [id, rawEntry] of entries) {
      assertCredentialId(id);
      if (!isRecord(rawEntry)) throw new Error("Keychain credential index has an invalid entry");
      const entry = credentialIndexValue(rawEntry);
      if (
        !["committed", "pending", "deleting"].includes(String(rawEntry.state)) ||
        !Object.keys(rawEntry).every((name) =>
          name === "providerId" || name === "type" || name === "state" || name === "previous")
      ) {
        throw new Error("Keychain credential index has an invalid entry");
      }
      if (rawEntry.state === "pending") {
        if (
          rawEntry.previous !== undefined
          && (
            !isRecord(rawEntry.previous)
            || !Object.keys(rawEntry.previous).every((name) => name === "providerId" || name === "type")
          )
        ) {
          throw new Error("Keychain credential index has an invalid entry");
        }
        const previous = rawEntry.previous === undefined ? undefined : credentialIndexValue(rawEntry.previous);
        index.entries[id] = {
          state: "pending",
          ...entry,
          ...(previous === undefined ? {} : { previous }),
        };
      } else {
        if (rawEntry.previous !== undefined) throw new Error("Keychain credential index has an invalid entry");
        index.entries[id] = { state: rawEntry.state as "committed" | "deleting", ...entry };
      }
    }
    return index;
  }

  async #writeCredentialIndex(index: CredentialIndex): Promise<void> {
    const serialized = JSON.stringify(index);
    if (Buffer.byteLength(serialized, "utf8") > MAX_CREDENTIAL_INDEX_BYTES) {
      throw new Error("Keychain credential index exceeded 64 KiB");
    }
    await this.#adapter.set(
      this.#metadataService,
      CREDENTIAL_INDEX_ACCOUNT,
      serialized,
      undefined,
      false,
    );
  }

  async #writeCredentialProfileRegistry(
    index: CredentialIndex,
    id: string,
    registered: boolean,
  ): Promise<void> {
    try {
      await this.#writeCredentialIndex(index);
    } catch (error) {
      try {
        const observed = await this.#readCredentialIndex();
        if (observed.profileIds.includes(id) === registered) return;
      } catch (verificationError) {
        throw new AggregateError(
          [error, verificationError],
          "Keychain credential profile registry update failed and its result could not be verified",
        );
      }
      throw error;
    }
  }

  async #setMetadataValue(service: string, account: string, value: string): Promise<void> {
    try {
      await this.#adapter.set(service, account, value, undefined, false);
    } catch (error) {
      try {
        if (await this.#adapter.get(service, account, undefined, false) === value) return;
      } catch (verificationError) {
        throw new AggregateError(
          [error, verificationError],
          "Keychain credential profile metadata write failed and its result could not be verified",
        );
      }
      throw error;
    }
  }

  async #deleteMetadataValue(service: string, account: string): Promise<void> {
    try {
      await this.#adapter.delete(service, account);
    } catch (error) {
      try {
        if (await this.#adapter.get(service, account, undefined, false) === undefined) return;
      } catch (verificationError) {
        throw new AggregateError(
          [error, verificationError],
          "Keychain credential profile metadata deletion failed and its result could not be verified",
        );
      }
      throw error;
    }
  }

  async #recoverCredentialIndex(index: CredentialIndex): Promise<CredentialIndex> {
    let changed = false;
    for (const [id, entry] of Object.entries(index.entries)) {
      if (entry.state === "committed") continue;
      if (entry.state === "deleting") {
        await this.#adapter.delete(this.#service, credentialAccount(id));
        await this.#deleteLegacyCredentialIfPresent(id);
        delete index.entries[id];
        changed = true;
        continue;
      }
      const stored = await this.#readCredentialRecord(id);
      if (stored === undefined) {
        delete index.entries[id];
        changed = true;
        continue;
      }
      const { credential } = stored;
      if (
        stored.legacy &&
        entry.previous !== undefined &&
        credential.provider === entry.previous.providerId &&
        credential.kind === entry.previous.type
      ) {
        index.entries[id] = { state: "committed", ...entry.previous };
        changed = true;
        continue;
      }
      if (credential.provider === entry.providerId && credential.kind === entry.type) {
        if (!stored.legacy) await this.#deleteLegacyCredentialIfPresent(id);
        index.entries[id] = {
          state: "committed",
          providerId: entry.providerId,
          type: entry.type,
        };
        changed = true;
        continue;
      }
      if (
        entry.previous !== undefined &&
        credential.provider === entry.previous.providerId &&
        credential.kind === entry.previous.type
      ) {
        index.entries[id] = { state: "committed", ...entry.previous };
        changed = true;
        continue;
      }
      throw new Error("Keychain credential index does not match its pending credential");
    }
    if (changed) await this.#writeCredentialIndex(index);
    return index;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && [...expected].sort().every((name, index) => keys[index] === name);
}

function credentialIndexValue(value: unknown): CredentialIndexValue {
  if (
    !isRecord(value) ||
    typeof value.providerId !== "string" ||
    !["api_key", "bearer", "oauth", "ambient"].includes(String(value.type))
  ) {
    throw new Error("Keychain credential index has an invalid entry");
  }
  assertCredentialId(value.providerId);
  return {
    providerId: value.providerId,
    type: value.type as AuthCredential["kind"],
  };
}

function credentialAccount(id: string): string {
  return `credential-v2:${createHash("sha256").update(id).digest("base64url")}`;
}

function profileIndexAccount(id: string): string {
  return `profile-index-v1:${createHash("sha256").update(id).digest("base64url")}`;
}
