import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import type { ProjectTrustContext } from "../extensions/direct.js";
import type { AgentSession, AgentSessionReplacedContext } from "./agent-session.js";
import { SessionManager } from "../storage/session-manager.js";

export interface AgentSessionRuntimeDiagnostic {
  type: "info" | "warning" | "error";
  message: string;
}

export interface AgentSessionRuntimeServices {
  cwd: string;
  agentDir: string;
  close?(): void | Promise<void>;
}

export interface SessionStartEvent {
  type: "session_start";
  reason: "new" | "resume" | "fork";
  previousSessionFile?: string;
}

export interface SessionShutdownEvent {
  type: "session_shutdown";
  reason: "quit" | "reload" | "new" | "resume" | "fork";
  targetSessionFile?: string;
}

export interface SessionBeforeSwitchEvent {
  type: "session_before_switch";
  reason: "new" | "resume";
  targetSessionFile?: string;
}

export interface SessionBeforeForkEvent {
  type: "session_before_fork";
  entryId: string;
  position: "before" | "at";
}

export interface SessionGuardResult {
  cancel?: boolean;
  reason?: string;
}

export interface AgentSessionRuntimeLifecycle {
  beforeSwitch?(event: SessionBeforeSwitchEvent): Promise<SessionGuardResult | void>;
  beforeFork?(event: SessionBeforeForkEvent): Promise<SessionGuardResult | void>;
  shutdown?(event: SessionShutdownEvent): Promise<void>;
}

export interface CreateAgentSessionRuntimeResult<S extends AgentSessionRuntimeServices = AgentSessionRuntimeServices> {
  session: AgentSession;
  services: S;
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
  }) => Promise<CreateAgentSessionRuntimeResult<S>>;

export class SessionImportFileNotFoundError extends Error {
  constructor(readonly filePath: string) {
    super(`File not found: ${filePath}`);
    this.name = "SessionImportFileNotFoundError";
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

function assertWorkspace(path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`Session workspace does not exist: ${path}`);
  }
}

/** Owns the current session and replaces all cwd-bound services as one unit. */
export class AgentSessionRuntime<S extends AgentSessionRuntimeServices = AgentSessionRuntimeServices> {
  #session: AgentSession;
  #services: S;
  #diagnostics: AgentSessionRuntimeDiagnostic[];
  #modelFallbackMessage: string | undefined;
  readonly #factory: CreateAgentSessionRuntimeFactory<S>;
  readonly #lifecycle: AgentSessionRuntimeLifecycle;
  #rebindSession: ((session: AgentSession) => Promise<void>) | undefined;
  #beforeSessionInvalidate: (() => void) | undefined;
  #closed = false;

  constructor(
    session: AgentSession,
    services: S,
    factory: CreateAgentSessionRuntimeFactory<S>,
    diagnostics?: AgentSessionRuntimeDiagnostic[],
    modelFallbackMessage?: string,
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
  ) {
    if (typeof servicesOrFactory === "function") {
      const initial = initialOrSession as CreateAgentSessionRuntimeResult<S>;
      this.#session = initial.session;
      this.#services = initial.services;
      this.#diagnostics = [...(initial.diagnostics ?? [])];
      this.#modelFallbackMessage = initial.modelFallbackMessage;
      this.#factory = servicesOrFactory;
      this.#lifecycle = factoryOrLifecycle as AgentSessionRuntimeLifecycle;
      return;
    }
    this.#session = initialOrSession as AgentSession;
    this.#services = servicesOrFactory;
    this.#diagnostics = [...diagnostics];
    this.#modelFallbackMessage = modelFallbackMessage;
    this.#factory = factoryOrLifecycle as CreateAgentSessionRuntimeFactory<S>;
    this.#lifecycle = {};
  }

  get session(): AgentSession { return this.#session; }
  get services(): S { return this.#services; }
  get cwd(): string { return this.#services.cwd; }
  get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] { return this.#diagnostics; }
  get modelFallbackMessage(): string | undefined { return this.#modelFallbackMessage; }

  setRebindSession(rebind?: (session: AgentSession) => Promise<void>): void {
    this.#rebindSession = rebind;
  }

  setBeforeSessionInvalidate(callback?: () => void): void {
    this.#beforeSessionInvalidate = callback;
  }

  /** Rebind after an owner-managed resource reload replaces the session in place. */
  async adoptSession(session: AgentSession, options: { rebind?: boolean } = {}): Promise<void> {
    this.#assertOpen();
    if (session === this.#session) return;
    this.#beforeSessionInvalidate?.();
    this.#session = session;
    if (options.rebind !== false) await this.#finish();
  }

  async #guardSwitch(reason: "new" | "resume", targetSessionFile?: string): Promise<boolean> {
    const event: SessionBeforeSwitchEvent = {
      type: "session_before_switch",
      reason,
      ...(targetSessionFile === undefined ? {} : { targetSessionFile }),
    };
    const result = this.#lifecycle.beforeSwitch === undefined
      ? await this.#session.extensionRunner?.emit(event)
      : await this.#lifecycle.beforeSwitch(event);
    return result?.cancel === true;
  }

  async #guardFork(entryId: string, position: "before" | "at"): Promise<boolean> {
    const event: SessionBeforeForkEvent = { type: "session_before_fork", entryId, position };
    const result = this.#lifecycle.beforeFork === undefined
      ? await this.#session.extensionRunner?.emit(event)
      : await this.#lifecycle.beforeFork(event);
    return result?.cancel === true;
  }

  async #teardown(reason: SessionShutdownEvent["reason"], targetSessionFile?: string): Promise<void> {
    const event: SessionShutdownEvent = {
      type: "session_shutdown",
      reason,
      ...(targetSessionFile === undefined ? {} : { targetSessionFile }),
    };
    if (this.#lifecycle.shutdown === undefined) await this.#session.extensionRunner?.emit(event);
    else await this.#lifecycle.shutdown(event);
    this.#beforeSessionInvalidate?.();
    await this.#session.close();
    await this.#services.close?.();
  }

  #apply(result: CreateAgentSessionRuntimeResult<S>): void {
    this.#session = result.session;
    this.#services = result.services;
    this.#diagnostics = [...(result.diagnostics ?? [])];
    this.#modelFallbackMessage = result.modelFallbackMessage;
  }

  async #finish(withSession?: (context: AgentSessionReplacedContext) => Promise<void>): Promise<void> {
    await this.#rebindSession?.(this.#session);
    if (withSession !== undefined) await withSession(this.#session.createReplacedSessionContext());
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("AgentSessionRuntime is closed");
  }

  async switchSession(
    sessionPath: string,
    options: {
      cwdOverride?: string;
      withSession?: (context: AgentSessionReplacedContext) => Promise<void>;
      projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
    } = {},
  ): Promise<{ cancelled: boolean }> {
    this.#assertOpen();
    const path = resolve(sessionPath);
    if (await this.#guardSwitch("resume", path)) return { cancelled: true };
    const previousSessionFile = this.#session.sessionFile;
    const manager = SessionManager.open(path, undefined, options.cwdOverride);
    assertWorkspace(manager.getCwd());
    await this.#teardown("resume", manager.getSessionFile());
    this.#apply(await this.#factory({
      cwd: manager.getCwd(),
      agentDir: this.#services.agentDir,
      sessionManager: manager,
      sessionStartEvent: {
        type: "session_start",
        reason: "resume",
        ...(previousSessionFile === undefined ? {} : { previousSessionFile }),
      },
      ...(options.projectTrustContextFactory === undefined
        ? {}
        : { projectTrustContext: options.projectTrustContextFactory(manager.getCwd()) }),
    }));
    await this.#finish(options.withSession);
    return { cancelled: false };
  }

  async newSession(options: {
    parentSession?: string;
    setup?: (sessionManager: SessionManager) => Promise<void>;
    withSession?: (context: AgentSessionReplacedContext) => Promise<void>;
  } = {}): Promise<{ cancelled: boolean }> {
    this.#assertOpen();
    if (await this.#guardSwitch("new")) return { cancelled: true };
    const previousSessionFile = this.#session.sessionFile;
    const current = this.#session.sessionManager;
    const manager = current.isPersisted()
      ? SessionManager.create(this.cwd, current.getSessionDir())
      : SessionManager.inMemory(this.cwd);
    if (options.parentSession !== undefined) manager.newSession({ parentSession: options.parentSession });
    await this.#teardown("new", manager.getSessionFile());
    this.#apply(await this.#factory({
      cwd: this.cwd,
      agentDir: this.#services.agentDir,
      sessionManager: manager,
      sessionStartEvent: {
        type: "session_start",
        reason: "new",
        ...(previousSessionFile === undefined ? {} : { previousSessionFile }),
      },
    }));
    await options.setup?.(this.#session.sessionManager as SessionManager);
    await this.#finish(options.withSession);
    return { cancelled: false };
  }

  async fork(
    entryId: string,
    options: {
      position?: "before" | "at";
      withSession?: (context: AgentSessionReplacedContext) => Promise<void>;
    } = {},
  ): Promise<{ cancelled: boolean; selectedText?: string }> {
    this.#assertOpen();
    const position = options.position ?? "before";
    if (await this.#guardFork(entryId, position)) return { cancelled: true };
    const selected = this.#session.sessionManager.getEntry(entryId);
    if (selected === undefined) throw new Error("Invalid entry ID for forking");

    let target: string | null;
    let selectedText: string | undefined;
    if (position === "at") target = selected.id;
    else {
      if (selected.type !== "message" || selected.message.role !== "user") {
        throw new Error("Invalid entry ID for forking");
      }
      target = selected.parentId;
      selectedText = userMessageText(selected.message.content);
    }

    const previousSessionFile = this.#session.sessionFile;
    let manager: SessionManager;
    if (this.#session.sessionManager.isPersisted()) {
      const source = this.#session.sessionFile;
      if (source === undefined) throw new Error("Persisted session is missing a session file");
      if (!existsSync(source)) throw new Error("Cannot fork: session has not been saved yet");
      const sessionDirectory = this.#session.sessionManager.getSessionDir();
      if (target === null) {
        manager = SessionManager.create(this.cwd, sessionDirectory);
        manager.newSession({ parentSession: source });
      } else {
        manager = SessionManager.open(source, sessionDirectory);
        if (manager.createBranchedSession(target) === undefined) {
          throw new Error("Failed to create forked session");
        }
      }
    } else {
      manager = this.#session.sessionManager as SessionManager;
      if (target === null) {
        manager.newSession(previousSessionFile === undefined ? undefined : { parentSession: previousSessionFile });
      }
      else manager.createBranchedSession(target);
    }

    await this.#teardown("fork", manager.getSessionFile());
    this.#apply(await this.#factory({
      cwd: manager.getCwd(),
      agentDir: this.#services.agentDir,
      sessionManager: manager,
      sessionStartEvent: {
        type: "session_start",
        reason: "fork",
        ...(previousSessionFile === undefined ? {} : { previousSessionFile }),
      },
    }));
    await this.#finish(options.withSession);
    return {
      cancelled: false,
      ...(selectedText === undefined ? {} : { selectedText }),
    };
  }

  async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
    this.#assertOpen();
    const source = resolve(inputPath);
    if (!existsSync(source)) throw new SessionImportFileNotFoundError(source);
    const directory = this.#session.sessionManager.getSessionDir();
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
    const destination = join(directory, basename(source));
    if (await this.#guardSwitch("resume", destination)) return { cancelled: true };
    const previousSessionFile = this.#session.sessionFile;
    if (destination !== source) copyFileSync(source, destination);
    const manager = SessionManager.open(destination, directory, cwdOverride);
    assertWorkspace(manager.getCwd());
    await this.#teardown("resume", manager.getSessionFile());
    this.#apply(await this.#factory({
      cwd: manager.getCwd(),
      agentDir: this.#services.agentDir,
      sessionManager: manager,
      sessionStartEvent: {
        type: "session_start",
        reason: "resume",
        ...(previousSessionFile === undefined ? {} : { previousSessionFile }),
      },
    }));
    await this.#finish();
    return { cancelled: false };
  }

  async dispose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#teardown("quit");
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
