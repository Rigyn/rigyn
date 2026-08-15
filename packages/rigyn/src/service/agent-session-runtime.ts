import { randomUUID } from "node:crypto";
import {
  constants,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { link, open } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import type {
  ProjectTrustContext,
  LoadExtensionsResult,
  SessionBeforeForkEvent,
  SessionBeforeSwitchEvent,
  SessionShutdownEvent,
  SessionStartEvent,
} from "../extensions/direct.js";
import type { AgentSession, AgentSessionReplacedContext } from "./agent-session.js";
import { closeAgentSessionForReplacement } from "./agent-session-owner.js";
import { MAX_SESSION_FILE_BYTES, SessionManager } from "../storage/session-manager.js";

const SESSION_IMPORT_NONBLOCK = constants.O_NONBLOCK ?? 0;

export type {
  SessionBeforeForkEvent,
  SessionBeforeSwitchEvent,
  SessionShutdownEvent,
  SessionStartEvent,
} from "../extensions/direct.js";

export interface AgentSessionRuntimeDiagnostic {
  type: "info" | "warning" | "error";
  message: string;
}

export interface AgentSessionRuntimeServices {
  cwd: string;
  agentDir: string;
  close?(): void | Promise<void>;
}

export interface SessionGuardResult {
  cancel?: boolean;
  /** Optional explanation returned to the caller when the operation is cancelled. */
  reason?: string;
}

export interface AgentSessionRuntimeLifecycle {
  beforeSwitch?(event: SessionBeforeSwitchEvent, signal: AbortSignal): Promise<SessionGuardResult | void>;
  beforeFork?(event: SessionBeforeForkEvent, signal: AbortSignal): Promise<SessionGuardResult | void>;
  shutdown?(event: SessionShutdownEvent): Promise<void>;
}

export interface CreateAgentSessionRuntimeResult<S extends AgentSessionRuntimeServices = AgentSessionRuntimeServices> {
  session: AgentSession;
  services: S;
  extensionsResult?: LoadExtensionsResult;
  diagnostics?: AgentSessionRuntimeDiagnostic[];
  modelFallbackMessage?: string;
}

export type CreateAgentSessionRuntimeFactory<S extends AgentSessionRuntimeServices = AgentSessionRuntimeServices> =
  (options: {
    cwd: string;
    agentDir: string;
    sessionManager: SessionManager;
    sessionStartEvent?: SessionStartEvent;
    projectTrustContext?: ProjectTrustContext;
    signal?: AbortSignal;
  }) => Promise<CreateAgentSessionRuntimeResult<S>>;

export class SessionImportFileNotFoundError extends Error {
  constructor(readonly filePath: string) {
    super(`Session import source was not found: ${filePath}`);
    this.name = "SessionImportFileNotFoundError";
  }
}

export interface MissingSessionCwdIssue {
  sessionFile: string;
  sessionCwd: string;
  fallbackCwd: string;
}

export class MissingSessionCwdError extends Error {
  constructor(readonly issue: MissingSessionCwdIssue) {
    super(
      `Saved workspace is unavailable: ${issue.sessionCwd}\n`
      + `Session journal: ${issue.sessionFile}\n`
      + `Fallback workspace: ${issue.fallbackCwd}`,
    );
    this.name = "MissingSessionCwdError";
  }
}

function userMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (typeof part !== "object" || part === null) return [];
    const record = part as { type?: unknown; text?: unknown };
    return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
  }).join("");
}

function nativeSessionManager(session: AgentSession): SessionManager {
  const compatible = session as AgentSession & { nativeSessionManager?: SessionManager };
  return compatible.nativeSessionManager ?? compatible.sessionManager as unknown as SessionManager;
}

function assertWorkspace(path: string, missingError?: () => Error): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw missingError?.() ?? new Error(`Session workspace is unavailable: ${path}`);
  }
}

function importDestination(directory: string, source: string, attempt: number): string {
  const filename = basename(source);
  if (attempt === 0) return join(directory, filename);
  const extension = extname(filename);
  const stem = extension === "" ? filename : filename.slice(0, -extension.length);
  return join(directory, `${stem}-${attempt}${extension}`);
}

function availableImportDestination(directory: string, source: string): string {
  for (let attempt = 0; ; attempt += 1) {
    const candidate = importDestination(directory, source, attempt);
    if (!existsSync(candidate)) return candidate;
  }
}

async function commitStagedImport(
  stagingPath: string,
  directory: string,
  source: string,
  signal: AbortSignal,
): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted();
    const candidate = importDestination(directory, source, attempt);
    try {
      await link(stagingPath, candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
}

function removeImportFile(path: string | undefined): void {
  if (path === undefined) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function removeCommittedImport(stagingPath: string, destination: string | undefined): void {
  if (destination === undefined) return;
  try {
    const staging = lstatSync(stagingPath);
    const committed = lstatSync(destination);
    if (staging.dev === committed.dev && staging.ino === committed.ino) unlinkSync(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

interface CreatedSessionFile {
  path: string;
  device: number;
  inode: number;
}

function recordCreatedSessionFile(path: string | undefined): CreatedSessionFile | undefined {
  if (path === undefined) return undefined;
  const details = lstatSync(path);
  return { path, device: details.dev, inode: details.ino };
}

function removeCreatedSessionFile(file: CreatedSessionFile | undefined): void {
  if (file === undefined) return;
  try {
    const details = lstatSync(file.path);
    if (details.dev !== file.device || details.ino !== file.inode) return;
    unlinkSync(file.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function rollbackCreatedSession(
  manager: SessionManager,
  file: CreatedSessionFile | undefined,
  cause: unknown,
): never {
  const failures = [cause];
  try {
    manager.closeV4Store();
  } catch (error) {
    failures.push(error);
  }
  try {
    removeCreatedSessionFile(file);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw cause;
  throw new AggregateError(failures, "Session replacement failed and its candidate could not be removed cleanly");
}

function waitForCallback<T>(
  callback: () => T | Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const operation = Promise.resolve().then(callback);
  return new Promise<T>((resolveOperation, rejectOperation) => {
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => settle(() => rejectOperation(signal.reason));
    operation.then(
      (value) => settle(() => resolveOperation(value)),
      (error: unknown) => settle(() => rejectOperation(error)),
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function createManagerCandidate<S extends AgentSessionRuntimeServices>(
  manager: SessionManager,
  signal: AbortSignal,
  create: (manager: SessionManager) => Promise<CreateAgentSessionRuntimeResult<S>>,
): Promise<CreateAgentSessionRuntimeResult<S>> {
  const release = (): void => manager.closeV4Store();
  if (signal.aborted) {
    release();
    signal.throwIfAborted();
  }
  signal.addEventListener("abort", release, { once: true });
  try {
    return await create(manager);
  } catch (error) {
    release();
    throw error;
  } finally {
    signal.removeEventListener("abort", release);
  }
}

/** Owns the current session and replaces all cwd-bound services as one unit. */
export class AgentSessionRuntime<S extends AgentSessionRuntimeServices = AgentSessionRuntimeServices> {
  #session: AgentSession;
  #services: S;
  #extensionsResult: LoadExtensionsResult | undefined;
  #diagnostics: AgentSessionRuntimeDiagnostic[];
  #modelFallbackMessage: string | undefined;
  readonly #factory: CreateAgentSessionRuntimeFactory<S>;
  readonly #lifecycle: AgentSessionRuntimeLifecycle;
  #rebindSession: ((session: AgentSession) => Promise<void>) | undefined;
  #beforeSessionInvalidate: (() => void) | undefined;
  #mutationTail: Promise<void> = Promise.resolve();
  #activeMutationAbort: AbortController | undefined;
  readonly #disposeAbort = new AbortController();
  #disposeFlight: Promise<void> | undefined;
  #currentDisposed = false;
  #closing = false;
  #closed = false;

  constructor(
    session: AgentSession,
    services: S,
    factory: CreateAgentSessionRuntimeFactory<S>,
    diagnostics?: AgentSessionRuntimeDiagnostic[],
    modelFallbackMessage?: string,
    extensionsResult?: LoadExtensionsResult,
  );
  constructor(
    initial: CreateAgentSessionRuntimeResult<S>,
    factory: CreateAgentSessionRuntimeFactory<S>,
    lifecycle?: AgentSessionRuntimeLifecycle,
  );
  constructor(
    initialOrSession: CreateAgentSessionRuntimeResult<S> | AgentSession,
    servicesOrFactory: S | CreateAgentSessionRuntimeFactory<S>,
    factoryOrLifecycle: CreateAgentSessionRuntimeFactory<S> | AgentSessionRuntimeLifecycle = {},
    diagnostics: AgentSessionRuntimeDiagnostic[] = [],
    modelFallbackMessage?: string,
    extensionsResult?: LoadExtensionsResult,
  ) {
    if (typeof servicesOrFactory === "function") {
      const initial = initialOrSession as CreateAgentSessionRuntimeResult<S>;
      this.#session = initial.session;
      this.#services = initial.services;
      this.#extensionsResult = initial.extensionsResult;
      this.#diagnostics = [...(initial.diagnostics ?? [])];
      this.#modelFallbackMessage = initial.modelFallbackMessage;
      this.#factory = servicesOrFactory;
      this.#lifecycle = factoryOrLifecycle as AgentSessionRuntimeLifecycle;
      return;
    }
    this.#session = initialOrSession as AgentSession;
    this.#services = servicesOrFactory;
    this.#extensionsResult = extensionsResult;
    this.#diagnostics = [...diagnostics];
    this.#modelFallbackMessage = modelFallbackMessage;
    this.#factory = factoryOrLifecycle as CreateAgentSessionRuntimeFactory<S>;
    this.#lifecycle = {};
  }

  get session(): AgentSession { return this.#session; }
  get services(): S { return this.#services; }
  get cwd(): string { return this.#services.cwd; }
  get extensionsResult(): LoadExtensionsResult | undefined { return this.#extensionsResult; }
  get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] { return this.#diagnostics; }
  get modelFallbackMessage(): string | undefined { return this.#modelFallbackMessage; }

  setRebindSession(rebind?: (session: AgentSession) => Promise<void>): void {
    this.#rebindSession = rebind;
  }

  setBeforeSessionInvalidate(callback?: () => void): void {
    this.#beforeSessionInvalidate = callback;
  }

  /** Rebind after an owner-managed resource refresh replaces the session in place. */
  async adoptSession(
    session: AgentSession,
    options: { rebind?: boolean; signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.#mutate(options.signal, async (signal) => {
      if (session === this.#session) return;
      signal.throwIfAborted();
      this.#beforeSessionInvalidate?.();
      signal.throwIfAborted();
      if (options.rebind !== false) {
        await waitForCallback(async () => await this.#rebindSession?.(session), signal);
      }
      signal.throwIfAborted();
      this.#session = session;
      this.#currentDisposed = false;
    });
  }

  async refreshSession(
    expectedSession: AgentSession,
    refresh: (signal: AbortSignal) => Promise<AgentSession | void>,
    options: {
      signal?: AbortSignal;
      withSession?: (session: AgentSession) => Promise<void>;
    } = {},
  ): Promise<void> {
    await this.#mutate(options.signal, async (signal) => {
      // The refresh callback owns the commit boundary. Before it returns, it must
      // honor the signal; after it returns, owner adoption must finish even if a
      // late terminal interrupt arrives.
      const replacement = await refresh(signal);
      if (replacement === undefined || replacement === this.#session) {
        if (options.withSession !== undefined) {
          await options.withSession(this.#session);
        }
        return;
      }

      const failures: unknown[] = [];
      try {
        this.#beforeSessionInvalidate?.();
      } catch (error) {
        failures.push(error);
      }
      this.#session = replacement;
      this.#currentDisposed = false;
      try {
        if (options.withSession === undefined) {
          await this.#rebindSession?.(replacement);
        } else {
          await options.withSession(replacement);
        }
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Refreshed session owner refresh failed");
    }, expectedSession);
  }

  async #guardSwitch(
    reason: "new" | "resume",
    signal: AbortSignal,
    targetSessionFile?: string,
  ): Promise<SessionGuardResult> {
    const event: SessionBeforeSwitchEvent = {
      type: "session_before_switch",
      reason,
      ...(targetSessionFile === undefined ? {} : { targetSessionFile }),
    };
    const result = await waitForCallback(
      async () => this.#lifecycle.beforeSwitch === undefined
        ? await this.#session.extensionRunner?.emit(event)
        : await this.#lifecycle.beforeSwitch(event, signal),
      signal,
    );
    const guard = result as SessionGuardResult | undefined;
    return {
      ...(guard?.cancel === true ? { cancel: true } : {}),
      ...(typeof guard?.reason === "string" ? { reason: guard.reason } : {}),
    };
  }

  async #guardFork(
    entryId: string,
    position: "before" | "at",
    signal: AbortSignal,
  ): Promise<SessionGuardResult> {
    const event: SessionBeforeForkEvent = { type: "session_before_fork", entryId, position };
    const result = await waitForCallback(
      async () => this.#lifecycle.beforeFork === undefined
        ? await this.#session.extensionRunner?.emit(event)
        : await this.#lifecycle.beforeFork(event, signal),
      signal,
    );
    const guard = result as SessionGuardResult | undefined;
    return {
      ...(guard?.cancel === true ? { cancel: true } : {}),
      ...(typeof guard?.reason === "string" ? { reason: guard.reason } : {}),
    };
  }

  async #teardown(
    reason: SessionShutdownEvent["reason"],
    targetSessionFile?: string,
  ): Promise<void> {
    if (this.#currentDisposed) return;
    this.#currentDisposed = true;
    const event: SessionShutdownEvent = {
      type: "session_shutdown",
      reason,
      ...(targetSessionFile === undefined ? {} : { targetSessionFile }),
    };
    const failures: unknown[] = [];
    try {
      const shutdown = async (): Promise<void> => {
        if (this.#lifecycle.shutdown === undefined) await this.#session.extensionRunner?.emit(event);
        else await this.#lifecycle.shutdown(event);
      };
      await shutdown();
    } catch (error) {
      failures.push(error);
    }
    try {
      this.#beforeSessionInvalidate?.();
    } catch (error) {
      failures.push(error);
    }
    try {
      const close = async (): Promise<void> => {
        if (reason === "quit") await this.#session.close();
        else await closeAgentSessionForReplacement(this.#session);
      };
      await close();
    } catch (error) {
      failures.push(error);
    }
    try {
      const close = async (): Promise<void> => await this.#services.close?.();
      await close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "AgentSessionRuntime teardown failed");
  }

  #apply(result: CreateAgentSessionRuntimeResult<S>, disposed = false): void {
    this.#session = result.session;
    this.#services = result.services;
    this.#extensionsResult = result.extensionsResult;
    this.#diagnostics = [...(result.diagnostics ?? [])];
    this.#modelFallbackMessage = result.modelFallbackMessage;
    this.#currentDisposed = disposed;
  }

  #snapshot(): CreateAgentSessionRuntimeResult<S> {
    return {
      session: this.#session,
      services: this.#services,
      diagnostics: [...this.#diagnostics],
      ...(this.#extensionsResult === undefined ? {} : { extensionsResult: this.#extensionsResult }),
      ...(this.#modelFallbackMessage === undefined ? {} : { modelFallbackMessage: this.#modelFallbackMessage }),
    };
  }

  async #closeUnbound(
    result: CreateAgentSessionRuntimeResult<S>,
  ): Promise<void> {
    const failures: unknown[] = [];
    try {
      const close = async (): Promise<void> => await result.session.close();
      await close();
    } catch (error) {
      failures.push(error);
    }
    try {
      const close = async (): Promise<void> => await result.services.close?.();
      await close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Replacement candidate cleanup failed");
  }

  async #createWithSignal(
    create: (signal: AbortSignal) => Promise<CreateAgentSessionRuntimeResult<S>>,
    signal: AbortSignal,
  ): Promise<CreateAgentSessionRuntimeResult<S>> {
    signal.throwIfAborted();
    const pending = Promise.resolve().then(async () => await create(signal));
    let delivered = false;
    try {
      const candidate = await waitForCallback(async () => await pending, signal);
      delivered = true;
      return candidate;
    } catch (error) {
      if (signal.aborted && !delivered) {
        void pending.then(
          async (candidate) => await this.#closeUnbound(candidate),
          () => undefined,
        ).catch(() => undefined);
      }
      throw error;
    }
  }

  async #recover(previous: CreateAgentSessionRuntimeResult<S>, signal: AbortSignal): Promise<void> {
    let recovered: CreateAgentSessionRuntimeResult<S> | undefined;
    let recoveredApplied = false;
    try {
      recovered = await this.#createWithSignal(async (recoverySignal) => {
        const previousManager = nativeSessionManager(previous.session);
        const previousFile = previousManager.getSessionFile();
        if (previousManager.isPersisted() && previousFile === undefined) {
          throw new Error("The persistent session has no backing file");
        }
        const recoveryManager = previousFile === undefined
          ? previousManager
          : SessionManager.open(previousFile, previousManager.getSessionDir(), previousManager.getCwd());
        return await createManagerCandidate(recoveryManager, recoverySignal, async (sessionManager) =>
          await this.#factory({
            cwd: previous.services.cwd,
            agentDir: previous.services.agentDir,
            sessionManager,
            sessionStartEvent: { type: "session_start", reason: "refresh" },
            signal: recoverySignal,
          }));
      }, signal);
      if (this.#closing) {
        const closingRecovery = recovered;
        recovered = undefined;
        await this.#closeUnbound(closingRecovery);
        throw new Error("AgentSessionRuntime closed during replacement recovery");
      }
      this.#apply(recovered);
      recoveredApplied = true;
      await waitForCallback(async () => await this.#rebindSession?.(recovered!.session), signal);
      signal.throwIfAborted();
    } catch (error) {
      const failures: unknown[] = [error];
      if (recovered !== undefined) {
        try {
          if (recoveredApplied) await this.#teardown("quit");
          else await this.#closeUnbound(recovered);
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      this.#apply(previous, true);
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(failures, "Session replacement recovery cleanup failed");
    }
  }

  async #replace(
    reason: Exclude<SessionShutdownEvent["reason"], "quit" | "refresh">,
    targetSessionFile: string | undefined,
    create: (signal: AbortSignal) => Promise<CreateAgentSessionRuntimeResult<S>>,
    signal: AbortSignal,
  ): Promise<AgentSessionReplacedContext> {
    const previous = this.#snapshot();
    let candidate: CreateAgentSessionRuntimeResult<S> | undefined;
    let applied = false;
    try {
      // Once teardown begins, cleanup owns the current generation. Caller
      // cancellation is observed immediately after this boundary so recovery
      // cannot race an abandoned session or service close.
      await this.#teardown(reason, targetSessionFile);
      signal.throwIfAborted();
      candidate = await this.#createWithSignal(create, signal);
      signal.throwIfAborted();
      if (this.#closing) throw new Error("AgentSessionRuntime closed during session replacement");
      this.#apply(candidate);
      applied = true;
      await waitForCallback(async () => await this.#rebindSession?.(candidate!.session), signal);
      signal.throwIfAborted();
      return candidate.session.createReplacedSessionContext();
    } catch (error) {
      const failures: unknown[] = [error];
      if (candidate !== undefined) {
        try {
          if (applied) await this.#teardown("quit");
          else await this.#closeUnbound(candidate);
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      const recoverySignal = this.#activeMutationAbort?.signal;
      if (
        !this.#closing
        && recoverySignal !== undefined
        && !recoverySignal.aborted
      ) {
        try {
          await this.#recover(previous, recoverySignal);
        } catch (recoveryError) {
          failures.push(recoveryError);
          this.#closing = true;
          this.#closed = true;
        }
      } else {
        this.#apply(previous, true);
        if (!this.#closing) {
          this.#closing = true;
          this.#closed = true;
        }
      }
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(failures, "Session replacement and recovery failed");
    }
  }

  async #mutate<T>(
    externalSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
    expectedSession?: AgentSession,
  ): Promise<T> {
    this.#assertOpen();
    const admissionSignal = externalSignal === undefined
      ? this.#disposeAbort.signal
      : AbortSignal.any([this.#disposeAbort.signal, externalSignal]);
    const previous = this.#mutationTail;
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    this.#mutationTail = previous.then(() => gate);
    let controller: AbortController | undefined;
    try {
      await waitForCallback(async () => await previous, admissionSignal);
      this.#assertOpen();
      if (expectedSession !== undefined && this.#session !== expectedSession) {
        throw new Error("Extension command context is stale after session replacement");
      }
      controller = new AbortController();
      this.#activeMutationAbort = controller;
      const signal = AbortSignal.any([controller.signal, admissionSignal]);
      signal.throwIfAborted();
      return await operation(signal);
    } finally {
      if (controller !== undefined && this.#activeMutationAbort === controller) {
        this.#activeMutationAbort = undefined;
      }
      release();
    }
  }

  #assertOpen(): void {
    if (this.#closing || this.#closed) throw new Error("AgentSessionRuntime is closed");
  }

  async switchSession(
    sessionPath: string,
    options: {
      cwdOverride?: string;
      withSession?: (context: AgentSessionReplacedContext) => Promise<void>;
      projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
      signal?: AbortSignal;
    } = {},
    expectedSession?: AgentSession,
  ): Promise<{ cancelled: boolean; reason?: string }> {
    const result = await this.#mutate(options.signal, async (signal) => {
      const path = resolve(sessionPath);
      const guard = await this.#guardSwitch("resume", signal, path);
      signal.throwIfAborted();
      if (guard.cancel === true) {
        return { cancelled: true as const, ...(guard.reason === undefined ? {} : { reason: guard.reason }) };
      }
      const previousSessionFile = this.#session.sessionFile;
      const reopenAfterTeardown = previousSessionFile !== undefined && resolve(previousSessionFile) === path;
      const manager = reopenAfterTeardown ? undefined : SessionManager.open(path, undefined, options.cwdOverride);
      let handedOff = false;
      const agentDir = this.#services.agentDir;
      const cwd = manager?.getCwd()
        ?? (options.cwdOverride === undefined ? nativeSessionManager(this.#session).getCwd() : resolve(options.cwdOverride));
      let context: AgentSessionReplacedContext;
      try {
        assertWorkspace(
          cwd,
          () => new MissingSessionCwdError({
            sessionFile: path,
            sessionCwd: cwd,
            fallbackCwd: this.cwd,
          }),
        );
        const projectTrustContext = options.projectTrustContextFactory?.(cwd);
        context = await this.#replace("resume", path, async (replacementSignal) => {
          const selectedManager = manager ?? SessionManager.open(path, undefined, options.cwdOverride);
          const candidate = await createManagerCandidate(selectedManager, replacementSignal, async (sessionManager) =>
            await this.#factory({
              cwd,
              agentDir,
              sessionManager,
              sessionStartEvent: {
                type: "session_start",
                reason: "resume",
                ...(previousSessionFile === undefined ? {} : { previousSessionFile }),
              },
              ...(projectTrustContext === undefined ? {} : { projectTrustContext }),
              signal: replacementSignal,
            }));
          handedOff = true;
          return candidate;
        }, signal);
      } finally {
        if (!handedOff) manager?.closeV4Store();
      }
      if (options.withSession !== undefined) {
        await waitForCallback(async () => await options.withSession!(context), signal);
      }
      return { cancelled: false as const, context };
    }, expectedSession);
    if (result.cancelled) return result;
    return { cancelled: false };
  }

  async newSession(options: {
    parentSession?: string;
    setup?: (sessionManager: SessionManager) => Promise<void>;
    withSession?: (context: AgentSessionReplacedContext) => Promise<void>;
    signal?: AbortSignal;
  } = {}, expectedSession?: AgentSession): Promise<{ cancelled: boolean; reason?: string }> {
    const result = await this.#mutate(options.signal, async (signal) => {
      const guard = await this.#guardSwitch("new", signal);
      signal.throwIfAborted();
      if (guard.cancel === true) {
        return { cancelled: true as const, ...(guard.reason === undefined ? {} : { reason: guard.reason }) };
      }
      const previousSessionFile = this.#session.sessionFile;
      const current = nativeSessionManager(this.#session);
      const cwd = this.cwd;
      const agentDir = this.#services.agentDir;
      const manager = current.isPersisted()
        ? SessionManager.create(
            cwd,
            current.getSessionDir(),
            options.parentSession === undefined ? undefined : { parentSession: options.parentSession },
          )
        : SessionManager.inMemory(
            cwd,
            options.parentSession === undefined ? undefined : { parentSession: options.parentSession },
          );
      const createdFile = recordCreatedSessionFile(manager.getSessionFile());
      let context: AgentSessionReplacedContext;
      try {
        if (options.setup !== undefined) {
          await waitForCallback(async () => await options.setup!(manager), signal);
        }
        signal.throwIfAborted();
        context = await this.#replace("new", manager.getSessionFile(), async (replacementSignal) => {
          const candidate = await createManagerCandidate(manager, replacementSignal, async (sessionManager) =>
            await this.#factory({
              cwd,
              agentDir,
              sessionManager,
              sessionStartEvent: {
                type: "session_start",
                reason: "new",
                ...(previousSessionFile === undefined ? {} : { previousSessionFile }),
              },
              signal: replacementSignal,
            }));
          return candidate;
        }, signal);
      } catch (error) {
        rollbackCreatedSession(manager, createdFile, error);
      }
      if (options.withSession !== undefined) {
        await waitForCallback(async () => await options.withSession!(context), signal);
      }
      return { cancelled: false as const, context };
    }, expectedSession);
    if (result.cancelled) return result;
    return { cancelled: false };
  }

  async fork(
    entryId: string,
    options: {
      position?: "before" | "at";
      withSession?: (context: AgentSessionReplacedContext) => Promise<void>;
      signal?: AbortSignal;
    } = {},
    expectedSession?: AgentSession,
  ): Promise<{ cancelled: boolean; reason?: string; selectedText?: string }> {
    const result = await this.#mutate(options.signal, async (signal) => {
      const position = options.position ?? "before";
      const guard = await this.#guardFork(entryId, position, signal);
      signal.throwIfAborted();
      if (guard.cancel === true) {
        return { cancelled: true as const, ...(guard.reason === undefined ? {} : { reason: guard.reason }) };
      }
      const selected = nativeSessionManager(this.#session).getEntry(entryId);
      if (selected === undefined) throw new Error("The requested fork entry is invalid");

      let target: string | null;
      let selectedText: string | undefined;
      if (position === "at") target = selected.id;
      else {
        if (selected.type !== "message" || selected.message.role !== "user") {
          throw new Error("The requested fork entry is invalid");
        }
        target = selected.parentId;
        selectedText = userMessageText(selected.message.content);
      }

      const previousSessionFile = this.#session.sessionFile;
      const cwd = this.cwd;
      const agentDir = this.#services.agentDir;
      const currentManager = nativeSessionManager(this.#session);
      const persisted = currentManager.isPersisted();
      const source = this.#session.sessionFile;
      if (persisted && source === undefined) throw new Error("The persistent session has no backing file");
      if (persisted && !existsSync(source!)) throw new Error("Forking requires the saved session file, but it is unavailable");
      const sessionDirectory = currentManager.getSessionDir();
      let candidateManager: SessionManager | undefined;
      let createdFile: CreatedSessionFile | undefined;
      let context: AgentSessionReplacedContext;
      try {
        context = await this.#replace("fork", undefined, async (replacementSignal) => {
          const manager = persisted
            ? target === null
              ? SessionManager.create(cwd, sessionDirectory, { parentSession: source! })
              : SessionManager.open(source!, sessionDirectory)
            : currentManager.cloneInMemory();
          candidateManager = manager;
          if (persisted && target === null) createdFile = recordCreatedSessionFile(manager.getSessionFile());
          return await createManagerCandidate(manager, replacementSignal, async (sessionManager) => {
            if (target === null) {
              if (!persisted) {
                sessionManager.newSession(
                  previousSessionFile === undefined ? undefined : { parentSession: previousSessionFile },
                );
              }
            } else {
              const branch = sessionManager.createBranchedSession(target);
              if (persisted && branch === undefined) throw new Error("The forked session could not be created");
              createdFile = recordCreatedSessionFile(branch);
            }
            return await this.#factory({
              cwd: sessionManager.getCwd(),
              agentDir,
              sessionManager,
              sessionStartEvent: {
                type: "session_start",
                reason: "fork",
                ...(previousSessionFile === undefined ? {} : { previousSessionFile }),
              },
              signal: replacementSignal,
            });
          });
        }, signal);
      } catch (error) {
        if (candidateManager !== undefined) rollbackCreatedSession(candidateManager, createdFile, error);
        throw error;
      }
      if (options.withSession !== undefined) {
        await waitForCallback(async () => await options.withSession!(context), signal);
      }
      return {
        cancelled: false as const,
        context,
        ...(selectedText === undefined ? {} : { selectedText }),
      };
    }, expectedSession);
    if (result.cancelled) return result;
    return {
      cancelled: false,
      ...(result.selectedText === undefined ? {} : { selectedText: result.selectedText }),
    };
  }

  async importFromJsonl(
    inputPath: string,
    cwdOverride?: string,
    signal?: AbortSignal,
  ): Promise<{ cancelled: boolean; reason?: string }> {
    return await this.#mutate(signal, async (operationSignal) => {
      const source = resolve(inputPath);
      if (!existsSync(source)) throw new SessionImportFileNotFoundError(source);
      const directory = nativeSessionManager(this.#session).getSessionDir();
      if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
      const stagingPath = join(directory, `.rigyn-import-${randomUUID()}.tmp`);
      let destination: string | undefined;
      let committed = false;
      let sourceHandle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        sourceHandle = await open(source, constants.O_RDONLY | SESSION_IMPORT_NONBLOCK);
        const sourceDetails = await sourceHandle.stat();
        if (!sourceDetails.isFile()) throw new Error(`Session import source is not a regular file: ${source}`);
        if (sourceDetails.size > MAX_SESSION_FILE_BYTES) {
          throw new Error(`Session import source exceeds ${MAX_SESSION_FILE_BYTES} bytes: ${source}`);
        }
        await pipeline(
          sourceHandle.createReadStream({ autoClose: false, end: MAX_SESSION_FILE_BYTES }),
          createWriteStream(stagingPath, { flags: "wx", mode: 0o600 }),
          { signal: operationSignal },
        );
        operationSignal.throwIfAborted();

        const staged = SessionManager.open(stagingPath, directory, cwdOverride);
        try {
          const reportedDestination = availableImportDestination(directory, source);
          assertWorkspace(
            staged.getCwd(),
            () => new MissingSessionCwdError({
              sessionFile: reportedDestination,
              sessionCwd: staged.getCwd(),
              fallbackCwd: this.cwd,
            }),
          );
        } finally {
          staged.closeV4Store();
        }
        operationSignal.throwIfAborted();

        destination = await commitStagedImport(stagingPath, directory, source, operationSignal);
        const guard = await this.#guardSwitch("resume", operationSignal, destination);
        operationSignal.throwIfAborted();
        if (guard.cancel === true) {
          return { cancelled: true, ...(guard.reason === undefined ? {} : { reason: guard.reason }) };
        }

        const previousSessionFile = this.#session.sessionFile;
        const agentDir = this.#services.agentDir;
        await this.#replace("resume", destination, async (replacementSignal) => {
          const manager = SessionManager.open(destination!, directory, cwdOverride);
          return await createManagerCandidate(manager, replacementSignal, async (sessionManager) =>
            await this.#factory({
              cwd: sessionManager.getCwd(),
              agentDir,
              sessionManager,
              sessionStartEvent: {
                type: "session_start",
                reason: "resume",
                ...(previousSessionFile === undefined ? {} : { previousSessionFile }),
              },
              signal: replacementSignal,
            }));
        }, operationSignal);
        committed = true;
        return { cancelled: false };
      } finally {
        await sourceHandle?.close().catch(() => undefined);
        if (!committed) removeCommittedImport(stagingPath, destination);
        removeImportFile(stagingPath);
      }
    });
  }

  async dispose(): Promise<void> {
    if (this.#disposeFlight !== undefined) return await this.#disposeFlight;
    if (this.#closed) return;
    this.#closing = true;
    const reason = new Error("AgentSessionRuntime disposed during session replacement");
    this.#disposeAbort.abort(reason);
    this.#activeMutationAbort?.abort(reason);
    const operation = (async () => {
      await this.#mutationTail;
      this.#closed = true;
      await this.#teardown("quit");
    })();
    this.#disposeFlight = operation;
    try {
      await operation;
    } finally {
      if (this.#disposeFlight === operation) this.#disposeFlight = undefined;
    }
  }
}

export async function createAgentSessionRuntime<S extends AgentSessionRuntimeServices>(
  factory: CreateAgentSessionRuntimeFactory<S>,
  options: { cwd: string; agentDir: string; sessionManager: SessionManager; sessionStartEvent?: SessionStartEvent },
  lifecycle: AgentSessionRuntimeLifecycle = {},
): Promise<AgentSessionRuntime<S>> {
  assertWorkspace(options.sessionManager.getCwd());
  const initial = await factory(options);
  return new AgentSessionRuntime(initial, factory, lifecycle);
}
