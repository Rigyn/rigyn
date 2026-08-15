import type { ExtensionCommandContextActions } from "../extensions/direct.js";
import { extensionSessionManager } from "../extensions/session-contract.js";
import type { AgentSession } from "./agent-session.js";
import type { AgentSessionRuntime } from "./agent-session-runtime.js";

/** Bind one extension generation to the runtime owner that replaces its session. */
export function createAgentSessionRuntimeCommandActions(
  runtime: AgentSessionRuntime,
  session: AgentSession,
  options: {
    refresh?: (signal: AbortSignal) => Promise<AgentSession | void>;
    afterRefresh?: (session: AgentSession) => Promise<void>;
  } = {},
): ExtensionCommandContextActions {
  const assertOrigin = (signal?: AbortSignal): void => {
    signal?.throwIfAborted();
    if (runtime.session !== session) {
      throw new Error("Extension command context is stale after session replacement");
    }
  };
  return {
    waitForIdle: async (signal) => {
      assertOrigin(signal);
      await session.waitForIdle();
      assertOrigin(signal);
    },
    newSession: async (commandOptions = {}, signal) => {
      assertOrigin(signal);
      return await runtime.newSession({
        ...(commandOptions.parentSession === undefined ? {} : { parentSession: commandOptions.parentSession }),
        ...(commandOptions.setup === undefined ? {} : {
          setup: async (manager) => await commandOptions.setup?.(extensionSessionManager(manager)),
        }),
        ...(commandOptions.withSession === undefined ? {} : {
          withSession: async (context) => await commandOptions.withSession?.(context),
        }),
        ...(signal === undefined ? {} : { signal }),
      }, session);
    },
    fork: async (entryId, commandOptions = {}, signal) => {
      assertOrigin(signal);
      const result = await runtime.fork(entryId, {
        ...(commandOptions.position === undefined ? {} : { position: commandOptions.position }),
        ...(commandOptions.withSession === undefined ? {} : {
          withSession: async (context) => await commandOptions.withSession?.(context),
        }),
        ...(signal === undefined ? {} : { signal }),
      }, session);
      return { cancelled: result.cancelled };
    },
    navigateTree: async (targetId, commandOptions = {}, signal) => {
      assertOrigin(signal);
      const result = await session.navigateTree(targetId, commandOptions);
      assertOrigin(signal);
      return { cancelled: result.cancelled };
    },
    switchSession: async (sessionPath, commandOptions = {}, signal) => {
      assertOrigin(signal);
      return await runtime.switchSession(sessionPath, {
        ...(commandOptions.withSession === undefined ? {} : {
          withSession: async (context) => await commandOptions.withSession?.(context),
        }),
        ...(signal === undefined ? {} : { signal }),
      }, session);
    },
    refresh: async (signal) => {
      assertOrigin(signal);
      await runtime.refreshSession(
        session,
        async (operationSignal) => {
          if (options.refresh === undefined) {
            await session.refresh({ signal: operationSignal });
            return;
          }
          return await options.refresh(operationSignal);
        },
        {
          ...(signal === undefined ? {} : { signal }),
          ...(options.afterRefresh === undefined ? {} : { withSession: options.afterRefresh }),
        },
      );
    },
  };
}
