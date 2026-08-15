import { resolve } from "node:path";

import type { Args } from "./args.js";
import { resolveSessionTarget } from "./session-resolution.js";
import { ENV_SESSION_DIR, getAgentDir } from "../config/paths.js";
import { SettingsManager } from "../core/settings-manager.js";
import { SessionManager, assertValidSessionId } from "../storage/session-manager.js";
import type { SessionInfo } from "../storage/types.js";
import { normalizePath, resolvePath } from "../utils/paths.js";

export interface SessionStartupInteraction {
  selectSession(
    current: () => Promise<readonly SessionInfo[]>,
    all: () => Promise<readonly SessionInfo[]>,
  ): Promise<string | undefined>;
  confirmForkFromWorkspace(workspace: string): Promise<boolean>;
}

export interface SessionStartupResult {
  sessionManager?: SessionManager;
  cancelled: boolean;
}

export interface StartupSessionDirectoryOptions {
  agentDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  projectTrusted?: boolean;
}

/** Resolves startup storage before session lookup using invocation, environment, then settings precedence. */
export async function resolveStartupSessionDirectory(
  value: Pick<Args, "sessionDir">,
  cwd: string,
  options: StartupSessionDirectoryOptions = {},
): Promise<string | undefined> {
  if (value.sessionDir !== undefined) return normalizePath(value.sessionDir);
  const environment = options.environment ?? process.env;
  const fromEnvironment = environment[ENV_SESSION_DIR];
  if (fromEnvironment !== undefined && fromEnvironment !== "") return normalizePath(fromEnvironment);

  const manager = SettingsManager.create(
    cwd,
    options.agentDirectory ?? getAgentDir(environment),
    { projectTrusted: options.projectTrusted === true },
  );
  manager.drainErrors();
  await manager.refresh();
  const failures = manager.drainErrors();
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `Settings could not be loaded for session lookup: ${failures.map((failure) =>
        `${failure.scope}: ${failure.error.message}`).join("; ")}`,
    );
  }
  const configured = manager.getSessionDir();
  return configured === undefined ? undefined : resolvePath(configured, cwd);
}

function flags(value: Args): string[] {
  return [
    value.session === undefined ? undefined : "--session",
    value.continue === true ? "--continue" : undefined,
    value.resume === true ? "--resume" : undefined,
    value.noSession === true ? "--no-session" : undefined,
  ].filter((entry): entry is string => entry !== undefined);
}

/** Reject startup flags that describe more than one session source. */
export function validateSessionFlags(value: Args): void {
  if (value.fork !== undefined) {
    const conflicts = flags(value);
    if (conflicts.length > 0) throw new Error(`--fork conflicts with ${conflicts.join(", ")}`);
  }
  if (value.sessionId !== undefined) {
    assertValidSessionId(value.sessionId);
    const conflicts = [
      value.session === undefined ? undefined : "--session",
      value.continue === true ? "--continue" : undefined,
      value.resume === true ? "--resume" : undefined,
    ].filter((entry): entry is string => entry !== undefined);
    if (conflicts.length > 0) throw new Error(`--session-id conflicts with ${conflicts.join(", ")}`);
  }
}

async function exactLocalId(id: string, cwd: string, sessionDirectory?: string) {
  return (await SessionManager.list(cwd, sessionDirectory)).find((session) => session.id === id);
}

export async function createStartupSession(
  value: Args,
  cwd: string,
  sessionDirectory: string | undefined,
  interaction: SessionStartupInteraction,
): Promise<SessionStartupResult> {
  validateSessionFlags(value);
  const workspace = resolve(cwd);

  if (value.noSession === true || value.help === true || value.listModels !== undefined) {
    return {
      sessionManager: SessionManager.inMemory(workspace, value.sessionId === undefined ? undefined : { id: value.sessionId }),
      cancelled: false,
    };
  }

  if (value.fork !== undefined) {
    if (value.sessionId !== undefined && await exactLocalId(value.sessionId, workspace, sessionDirectory) !== undefined) {
      throw new Error(`A session with id '${value.sessionId}' already exists`);
    }
    const source = await resolveSessionTarget({
      cwd: workspace,
      reference: value.fork,
      ...(sessionDirectory === undefined ? {} : { sessionDirectory }),
    });
    if (source.type === "not_found") throw new Error(`Could not resolve session '${source.reference}'`);
    const path = source.type === "path" ? source.path : source.session.path;
    return {
      sessionManager: SessionManager.forkFrom(
        path,
        workspace,
        sessionDirectory,
        value.sessionId === undefined ? undefined : { id: value.sessionId },
      ),
      cancelled: false,
    };
  }

  if (value.session !== undefined) {
    const target = await resolveSessionTarget({
      cwd: workspace,
      reference: value.session,
      ...(sessionDirectory === undefined ? {} : { sessionDirectory }),
    });
    if (target.type === "not_found") throw new Error(`Could not resolve session '${target.reference}'`);
    if (target.type === "global") {
      if (!await interaction.confirmForkFromWorkspace(target.session.cwd)) return { cancelled: true };
      return {
        sessionManager: SessionManager.forkFrom(target.session.path, workspace, sessionDirectory),
        cancelled: false,
      };
    }
    return {
      sessionManager: SessionManager.open(target.type === "path" ? target.path : target.session.path, sessionDirectory),
      cancelled: false,
    };
  }

  if (value.resume === true) {
    const current = async () => await SessionManager.list(workspace, sessionDirectory);
    const all = async () => await SessionManager.listAll(sessionDirectory);
    const selected = await interaction.selectSession(
      value.all === true ? all : current,
      all,
    );
    if (selected === undefined) return { cancelled: true };
    return { sessionManager: SessionManager.open(selected, sessionDirectory), cancelled: false };
  }

  if (value.continue === true) {
    if (value.all === true) {
      const recent = (await SessionManager.listAll(sessionDirectory))[0];
      return {
        sessionManager: recent === undefined
          ? SessionManager.create(workspace, sessionDirectory)
          : SessionManager.open(recent.path, sessionDirectory),
        cancelled: false,
      };
    }
    return { sessionManager: SessionManager.continueRecent(workspace, sessionDirectory), cancelled: false };
  }

  if (value.sessionId !== undefined) {
    const existing = await exactLocalId(value.sessionId, workspace, sessionDirectory);
    if (existing !== undefined) {
      return { sessionManager: SessionManager.open(existing.path, sessionDirectory), cancelled: false };
    }
  }

  return {
    sessionManager: SessionManager.create(
      workspace,
      sessionDirectory,
      value.sessionId === undefined ? undefined : { id: value.sessionId },
    ),
    cancelled: false,
  };
}
