import type { CredentialStore } from "./auth/types.js";
import type { ProviderAuthRegistry } from "./auth/registry.js";
import type { HarnessConfig } from "./config/schema.js";
import type { ProviderRegistry } from "./providers/registry.js";
import type { HarnessRun, RunOptions } from "./service/harness.js";
import type { HarnessService } from "./service/harness.js";
import type { HarnessResourceCatalog } from "./service/resource-catalog.js";
import type { SessionStore } from "./storage/store.js";
import { loadRuntime, type LoadedRuntime, type RuntimeReloadOptions, type RuntimeReloadResult } from "./cli/runtime.js";
import { registerOwnedRuntime } from "./internal/runtime-owner.js";

export interface CreateHarnessRuntimeOptions {
  workspace?: string;
  extensions?: boolean;
  /** Trusted invocation-only runtime extension entry files. */
  extensionPaths?: readonly string[];
  /** Trusted invocation-only local, npm, or Git extension package sources. */
  packagePaths?: readonly string[];
  /** Permit lifecycle scripts for invocation-only packages. Disabled by default. */
  allowPackageScripts?: boolean;
  skills?: boolean;
  skillPaths?: readonly string[];
  promptTemplates?: boolean;
  promptTemplatePaths?: readonly string[];
  themes?: boolean;
  themePaths?: readonly string[];
  /** Explicit trust decision supplied by the embedding host. */
  projectTrusted?: boolean;
  /** Directory containing the runtime-owned session database. */
  sessionDirectory?: string;
  recover?: boolean;
}

export interface HarnessRunHandle {
  threadId: string;
  result: Promise<HarnessRun>;
  cancel(reason?: string): void;
  cancelRetry(): boolean;
}

export interface HarnessRuntime {
  readonly workspace: string;
  readonly trusted: boolean;
  readonly config: HarnessConfig;
  readonly credentials: CredentialStore;
  readonly auth: ProviderAuthRegistry;
  readonly providers: ProviderRegistry;
  readonly store: SessionStore;
  readonly service: HarnessService;
  readonly generationSignal: AbortSignal;
  start(options: RunOptions): Promise<HarnessRunHandle>;
  run(options: RunOptions): Promise<HarnessRun>;
  waitForIdle(signal?: AbortSignal): Promise<void>;
  resourceCatalog(signal?: AbortSignal): Promise<HarnessResourceCatalog>;
  reload(options?: RuntimeReloadOptions): Promise<RuntimeReloadResult>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function settleWithSignal(operation: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    await operation;
    return;
  }
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(() => resolve(), reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

class OwnedHarnessRuntime implements HarnessRuntime {
  readonly #runtime: LoadedRuntime;
  readonly #runs = new Map<string, Promise<HarnessRun>>();
  #lifecycleTail: Promise<void> = Promise.resolve();
  #closing: Promise<void> | undefined;

  constructor(runtime: LoadedRuntime) {
    this.#runtime = runtime;
    const defaultShutdownHandler = async () => {
      setImmediate(() => { void this.close().catch(() => undefined); });
      return {
        accepted: true,
        message: "The embedding host acknowledged graceful shutdown.",
      };
    };
    runtime.setExtensionShutdownHandler(defaultShutdownHandler);
    registerOwnedRuntime(this, runtime, () => {
      try { runtime.setExtensionShutdownHandler(defaultShutdownHandler); } catch {}
    });
  }

  get workspace(): string { return this.#runtime.workspace; }
  get trusted(): boolean { return this.#runtime.trusted; }
  get config(): HarnessConfig { return this.#runtime.config; }
  get credentials(): CredentialStore { return this.#runtime.credentials; }
  get auth(): ProviderAuthRegistry { return this.#runtime.auth; }
  get providers(): ProviderRegistry { return this.#runtime.providers; }
  get store(): SessionStore { return this.#runtime.store; }
  get service(): HarnessService { return this.#runtime.service; }
  get generationSignal(): AbortSignal { return this.#runtime.generationSignal; }

  async start(options: RunOptions): Promise<HarnessRunHandle> {
    if (this.#closing !== undefined) throw new Error("Runtime is closing");
    return await this.#enqueueLifecycle(async () => {
      let selectedOptions = options;
      let threadId = options.threadId;
      if (threadId === undefined) {
        const [catalog] = await this.#runtime.providers.catalogStatus(options.provider);
        const selected = await this.#runtime.service.resolveModelSelection(options.model, {
          provider: options.provider,
          refresh: catalog === undefined || catalog.provenance === "none" || catalog.stale,
          allowUnknownModel: true,
          ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
        });
        const {
          provider: _provider,
          model: _model,
          reasoningEffort: _reasoningEffort,
          ...remainingOptions
        } = options;
        selectedOptions = {
          ...remainingOptions,
          provider: selected.provider,
          model: selected.model,
          ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
        };
        threadId = (await this.#runtime.service.createSession({
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.branch === undefined ? {} : { defaultBranch: options.branch }),
        })).threadId;
      }
      if (this.#runs.has(threadId)) throw new Error(`Thread already has an active runtime operation: ${threadId}`);
      const result = this.#runtime.service.run({ ...selectedOptions, threadId }).finally(() => {
        if (this.#runs.get(threadId) === result) this.#runs.delete(threadId);
      });
      this.#runs.set(threadId, result);
      return {
        threadId,
        result,
        cancel: (reason?: string) => this.#runtime.service.cancel(threadId, reason),
        cancelRetry: () => this.#runtime.service.cancelRetry(threadId),
      };
    });
  }

  async run(options: RunOptions): Promise<HarnessRun> {
    return await (await this.start(options)).result;
  }

  async waitForIdle(signal?: AbortSignal): Promise<void> {
    while (true) {
      const lifecycle = this.#lifecycleTail;
      await settleWithSignal(lifecycle, signal);
      const runs = [...this.#runs.values()];
      if (runs.length > 0) {
        await settleWithSignal(Promise.allSettled(runs).then(() => undefined), signal);
      }
      if (lifecycle === this.#lifecycleTail && this.#runs.size === 0) return;
    }
  }

  async resourceCatalog(signal?: AbortSignal): Promise<HarnessResourceCatalog> {
    if (this.#closing !== undefined) throw new Error("Runtime is closing");
    const selectedSignal = signal === undefined
      ? this.#runtime.generationSignal
      : AbortSignal.any([signal, this.#runtime.generationSignal]);
    return await this.#runtime.service.resourceCatalog(selectedSignal);
  }

  async reload(options: RuntimeReloadOptions = {}): Promise<RuntimeReloadResult> {
    if (this.#closing !== undefined) throw new Error("Runtime is closing");
    return await this.#enqueueLifecycle(async () => await this.#runtime.reload(options));
  }

  close(): Promise<void> {
    this.#closing ??= this.#enqueueLifecycle(async () => await this.#close());
    return this.#closing;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  async #close(): Promise<void> {
    for (const threadId of this.#runs.keys()) this.#runtime.service.cancel(threadId, "Runtime closed");
    await Promise.allSettled([...this.#runs.values()]);
    await this.#runtime.close();
  }

  #enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#lifecycleTail.then(operation);
    this.#lifecycleTail = pending.then(() => undefined, () => undefined);
    return pending;
  }
}

/** Loads configuration, credentials, providers, extensions, persistence, and cleanup as one owned runtime. */
export async function createHarnessRuntime(options: CreateHarnessRuntimeOptions = {}): Promise<HarnessRuntime> {
  const extensions = options.extensions ?? true;
  const runtime = await loadRuntime({
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    ...(options.extensionPaths === undefined ? {} : { extensionPaths: [...options.extensionPaths] }),
    ...(options.packagePaths === undefined ? {} : { packagePaths: [...options.packagePaths] }),
    ...(options.allowPackageScripts === undefined ? {} : { allowPackageScripts: options.allowPackageScripts }),
    ...(options.skills === undefined ? {} : { skills: options.skills }),
    ...(options.skillPaths === undefined ? {} : { skillPaths: [...options.skillPaths] }),
    ...(options.promptTemplates === undefined ? {} : { promptTemplates: options.promptTemplates }),
    ...(options.promptTemplatePaths === undefined ? {} : { promptTemplatePaths: [...options.promptTemplatePaths] }),
    ...(options.themes === undefined ? {} : { themes: options.themes }),
    ...(options.themePaths === undefined ? {} : { themePaths: [...options.themePaths] }),
    ...(options.projectTrusted === undefined ? {} : { projectTrusted: options.projectTrusted }),
    ...(options.sessionDirectory === undefined ? {} : { sessionDirectory: options.sessionDirectory }),
    extensions,
    extensionRuntime: extensions,
    managedExtensionLifecycle: true,
    recover: options.recover ?? true,
  });
  return new OwnedHarnessRuntime(runtime);
}
