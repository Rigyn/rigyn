import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CrossProcessFileLock, type FileLockOptions } from "./file-store.js";
import { defaultSecretRedactor, type SecretRedactor } from "./redaction.js";
import { runSafeProcess, type SafeProcessOptions, type SafeProcessResult } from "./process.js";
import {
  assertCredentialId,
  assertAuthCredential,
  credentialSecrets,
  isAuthCredential,
  type AuthCredential,
  type CredentialProfileMetadataStore,
} from "./types.js";

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

  constructor(options?: {
    platform?: NodeJS.Platform;
    runner?: KeychainCommandRunner;
    redactor?: SecretRedactor;
  }) {
    this.#platform = options?.platform ?? process.platform;
    this.#run = options?.runner ?? runSafeProcess;
    this.#redactor = options?.redactor ?? defaultSecretRedactor;
    if (this.#platform !== "darwin" && this.#platform !== "linux") {
      throw new Error(`No command-backed keychain adapter is available on ${this.#platform}`);
    }
  }

  async get(service: string, account: string, signal?: AbortSignal, sensitive = true): Promise<string | undefined> {
    this.#validate(service, account);
    const result =
      this.#platform === "darwin"
        ? await this.#run({
            command: "/usr/bin/security",
            args: ["find-generic-password", "-s", service, "-a", account, "-w"],
            ...(signal === undefined ? {} : { signal }),
            redactor: this.#redactor,
          })
        : await this.#run({
            command: "/usr/bin/secret-tool",
            args: ["lookup", "service", service, "account", account],
            ...(signal === undefined ? {} : { signal }),
            redactor: this.#redactor,
          });
    if (result.exitCode !== 0) {
      if (this.#platform === "darwin" && result.exitCode === 44) return undefined;
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
    if (sensitive) this.#redactor.register(secret);
    const result =
      this.#platform === "darwin"
        ? await this.#run({
            command: "/usr/bin/security",
            args: ["add-generic-password", "-U", "-s", service, "-a", account, "-w"],
            input: `${secret}\n`,
            ...(signal === undefined ? {} : { signal }),
            redactor: this.#redactor,
          })
        : await this.#run({
            command: "/usr/bin/secret-tool",
            args: ["store", `--label=Rigyn: ${service}`, "service", service, "account", account],
            input: secret,
            ...(signal === undefined ? {} : { signal }),
            redactor: this.#redactor,
          });
    this.#requireSuccess(result, "store keychain credential");
  }

  async delete(service: string, account: string, signal?: AbortSignal): Promise<void> {
    this.#validate(service, account);
    const result =
      this.#platform === "darwin"
        ? await this.#run({
            command: "/usr/bin/security",
            args: ["delete-generic-password", "-s", service, "-a", account],
            ...(signal === undefined ? {} : { signal }),
            redactor: this.#redactor,
          })
        : await this.#run({
            command: "/usr/bin/secret-tool",
            args: ["clear", "service", service, "account", account],
            ...(signal === undefined ? {} : { signal }),
            redactor: this.#redactor,
          });
    if (result.exitCode !== 0 && !(this.#platform === "darwin" && result.exitCode === 44)) {
      this.#requireSuccess(result, "delete keychain credential");
    }
  }

  #validate(service: string, account: string): void {
    validateName(service, "Service");
    validateName(account, "Account");
  }

  #requireSuccess(result: SafeProcessResult, action: string): void {
    if (result.exitCode === 0) return;
    const detail = result.stderr.trim();
    throw new Error(detail.length === 0 ? `Unable to ${action}` : `Unable to ${action}: ${detail}`);
  }
}

export class KeychainCredentialStore implements CredentialProfileMetadataStore {
  readonly #adapter: KeychainAdapter;
  readonly #service: string;
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
    const suffix = createHash("sha256").update(options.service).digest("hex").slice(0, 24);
    this.#lock = new CrossProcessFileLock(
      options.lockPath ?? join(tmpdir(), `rigyn-keychain-${suffix}.lock`),
      options.lock,
    );
  }

  async read(id: string): Promise<AuthCredential | undefined> {
    assertCredentialId(id);
    const serialized = await this.#adapter.get(this.#service, id);
    if (serialized === undefined) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch (error) {
      throw new Error("Keychain credential is not valid JSON", { cause: error });
    }
    if (!isAuthCredential(value)) throw new Error("Keychain credential has an invalid shape");
    defaultSecretRedactor.registerAll(credentialSecrets(value));
    return value;
  }

  async write(id: string, credential: AuthCredential): Promise<void> {
    assertCredentialId(id);
    assertAuthCredential(credential);
    const snapshot = structuredClone(credential);
    assertAuthCredential(snapshot);
    defaultSecretRedactor.registerAll(credentialSecrets(snapshot));
    await this.#whileLocked(id, () =>
      this.#adapter.set(this.#service, id, JSON.stringify(snapshot)),
    );
  }

  async delete(id: string): Promise<void> {
    assertCredentialId(id);
    await this.#whileLocked(id, () => this.#adapter.delete(this.#service, id));
  }

  async readCredentialProfileIndex(id: string): Promise<unknown | undefined> {
    assertCredentialId(id);
    const value = await this.#adapter.get(this.#service, profileIndexAccount(id), undefined, false);
    if (value === undefined) return undefined;
    if (Buffer.byteLength(value, "utf8") > 64 * 1024) throw new Error("Keychain credential profile index exceeded 64 KiB");
    try {
      return JSON.parse(value) as unknown;
    } catch (error) {
      throw new Error("Keychain credential profile index is not valid JSON", { cause: error });
    }
  }

  async writeCredentialProfileIndex(id: string, value: unknown): Promise<void> {
    assertCredentialId(id);
    const serialized = JSON.stringify(structuredClone(value));
    if (serialized === undefined) throw new TypeError("Keychain credential profile index must be JSON-serializable");
    if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) {
      throw new Error("Keychain credential profile index exceeded 64 KiB");
    }
    await this.#whileLocked(id, () => this.#adapter.set(
      this.#service,
      profileIndexAccount(id),
      serialized,
      undefined,
      false,
    ));
  }

  async deleteCredentialProfileIndex(id: string): Promise<void> {
    assertCredentialId(id);
    await this.#whileLocked(id, () => this.#adapter.delete(this.#service, profileIndexAccount(id)));
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
}

function profileIndexAccount(id: string): string {
  return `profile-index-v1:${createHash("sha256").update(id).digest("base64url")}`;
}
