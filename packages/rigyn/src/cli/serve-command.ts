import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { defaultSecretRedactor } from "../auth/redaction.js";
import type { ExtensionCommandContextActions } from "../extensions/direct.js";
import type { RuntimeInlineExtension } from "../extensions/runtime.js";
import {
  withGracefulTermination,
  type GracefulTerminationContext,
} from "../process/graceful-termination.js";
import {
  assertValidServeToken,
  startServeServer,
  type ServeSessionFactory,
  type ServeSessionRuntime,
} from "../serve/server.js";
import { SessionManager } from "../storage/session-manager.js";
import type { ExtensionBindings } from "../service/agent-session.js";
import type { ToolAuthorizationHandler } from "../tools/approval.js";
import { writeMachineOutput } from "../interfaces/output-guard.js";
import {
  flagBoolean,
  flagPositiveSafeInteger,
  flagString,
  flagStrings,
  type ManagementArguments,
} from "./management-args.js";
import type { ProjectTrustResolver } from "./project-trust.js";
import { loadRuntime } from "./runtime.js";
import { resolveStartupSessionDirectory } from "./session-startup.js";

const DEFAULT_SERVE_HOST = "127.0.0.1";
const DEFAULT_SERVE_PORT = 4_317;
const LOOPBACK_SERVE_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export interface ServeCommandOptions {
  extensionFactories?: readonly RuntimeInlineExtension[];
  projectTrustResolver?: ProjectTrustResolver;
  environment?: NodeJS.ProcessEnv;
  /** Optional caller-owned gate for model-requested tool effects in every served session. */
  toolAuthorizationHandler?: ToolAuthorizationHandler;
}

interface ProductServeFactoryOptions {
  baseWorkspace: string;
  environment: NodeJS.ProcessEnv;
  extensionFactories: readonly RuntimeInlineExtension[];
  extensionPaths: readonly string[];
  extensions: boolean;
  offline: boolean;
  toolAuthorizationHandler?: ToolAuthorizationHandler;
  projectTrustResolver?: ProjectTrustResolver;
  sessionDirectory?: string;
  requestShutdown(): void;
}

type ProductServeRuntime = Awaited<ReturnType<typeof loadRuntime>>;

function serveExtensionBindings(
  runtime: ProductServeRuntime,
  requestShutdown: () => void,
): ExtensionBindings {
  const commandContextActions: ExtensionCommandContextActions = {
    async waitForIdle(signal) {
      signal?.throwIfAborted();
      await runtime.session.waitForIdle();
      signal?.throwIfAborted();
    },
    async newSession(_options, signal) {
      signal?.throwIfAborted();
      return { cancelled: true };
    },
    async fork(_entryId, _options, signal) {
      signal?.throwIfAborted();
      return { cancelled: true };
    },
    async navigateTree(targetId, options, signal) {
      signal?.throwIfAborted();
      if (!runtime.session.isIdle) return { cancelled: true };
      const result = await runtime.session.navigateTree(targetId, options);
      signal?.throwIfAborted();
      return { cancelled: result.cancelled };
    },
    async switchSession(_sessionPath, _options, signal) {
      signal?.throwIfAborted();
      return { cancelled: true };
    },
    async refresh(signal) {
      signal?.throwIfAborted();
      await runtime.refresh({
        ...(signal === undefined ? {} : { signal }),
        beforeSessionStart(session) {
          session.updateExtensionBindings(serveExtensionBindings(runtime, requestShutdown));
        },
      });
      signal?.throwIfAborted();
    },
  };
  return {
    mode: "serve",
    commandContextActions,
    shutdownHandler: requestShutdown,
    onError(error) {
      process.stderr.write(
        `${defaultSecretRedactor.redact(`Extension error (${error.extensionPath}): ${error.error}`)}\n`,
      );
    },
  };
}

function serveToken(environment: NodeJS.ProcessEnv): string {
  const token = environment.RIGYN_SERVE_TOKEN;
  if (token === undefined) throw new Error("RIGYN_SERVE_TOKEN is required");
  try {
    assertValidServeToken(token);
  } catch (error) {
    throw new Error(
      `RIGYN_SERVE_TOKEN is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  defaultSecretRedactor.register(token);
  return token;
}

export function assertLoopbackServeHost(host: string): void {
  if (!LOOPBACK_SERVE_HOSTS.has(host)) {
    throw new Error("--host must be 127.0.0.1, localhost, or ::1; rigyn serve does not provide TLS");
  }
}

function servePort(argumentsValue: ManagementArguments): number {
  const port = flagPositiveSafeInteger(argumentsValue, "port") ?? DEFAULT_SERVE_PORT;
  if (port > 65_535) throw new Error("--port must be an integer from 1 through 65535");
  return port;
}

async function existingWorkspace(path: string): Promise<string> {
  const candidate = resolve(path);
  const details = await stat(candidate);
  if (!details.isDirectory()) throw new Error(`Serve workspace is not a directory: ${candidate}`);
  return await realpath(candidate);
}

async function selectConfiguredServeModel(
  runtime: Awaited<ReturnType<typeof loadRuntime>>,
  signal: AbortSignal,
): Promise<void> {
  const reference = runtime.session.model?.id ?? runtime.settings.getDefaultModel();
  if (reference === undefined) return;
  const provider = runtime.session.model?.provider ?? runtime.settings.getDefaultProvider();
  const model = await runtime.session.resolveModel(reference, {
    ...(provider === undefined ? {} : { provider }),
    signal,
  });
  signal.throwIfAborted();
  await runtime.session.setModel(model);
}

function waitForShutdown(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolveWait) => {
    signal.addEventListener("abort", () => resolveWait(), { once: true });
  });
}

async function createProductServeSessionFactory(
  options: ProductServeFactoryOptions,
): Promise<ServeSessionFactory> {
  const baseWorkspace = await existingWorkspace(options.baseWorkspace);

  const resolveWorkspace = async (requested: string | undefined): Promise<string> =>
    requested === undefined ? baseWorkspace : await existingWorkspace(requested);

  const sessionDirectoryFor = async (workspace: string): Promise<string | undefined> => {
    const projectTrusted = options.projectTrustResolver === undefined
      ? undefined
      : await options.projectTrustResolver.isTrusted(workspace);
    return await resolveStartupSessionDirectory(
      options.sessionDirectory === undefined ? {} : { sessionDir: options.sessionDirectory },
      workspace,
      {
        environment: options.environment,
        ...(projectTrusted === undefined ? {} : { projectTrusted }),
      },
    );
  };

  const load = async (
    manager: SessionManager,
    sessionDirectory: string | undefined,
    signal: AbortSignal,
  ): Promise<ServeSessionRuntime> => {
    let runtime: Awaited<ReturnType<typeof loadRuntime>>;
    try {
      runtime = await loadRuntime({
        localObservabilityMode: "serve",
        signal,
        workspace: manager.getCwd(),
        sessionManager: manager,
        ...(sessionDirectory === undefined ? {} : { sessionDirectory }),
        extensions: options.extensions,
        extensionPaths: options.extensionPaths,
        extensionFactories: options.extensionFactories,
        ...(options.projectTrustResolver === undefined
          ? {}
          : { projectTrustResolver: options.projectTrustResolver }),
        skills: true,
        promptTemplates: true,
        themes: true,
        extensionRuntime: true,
        offline: options.offline,
        ...(options.toolAuthorizationHandler === undefined
          ? {}
          : { toolAuthorizationHandler: options.toolAuthorizationHandler }),
      });
    } catch (error) {
      try {
        manager.closeV4Store();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Serve runtime loading and session cleanup failed",
        );
      }
      throw error;
    }
    try {
      runtime.setExtensionShutdownHandler(options.requestShutdown);
      let modelReady = false;
      let modelSelection: Promise<void> | undefined;
      let closeFlight: Promise<void> | undefined;
      const ensureModel = async (signal: AbortSignal): Promise<void> => {
        if (modelReady) return;
        modelSelection ??= selectConfiguredServeModel(runtime, signal);
        try {
          await modelSelection;
          modelReady = true;
        } finally {
          if (!modelReady) modelSelection = undefined;
        }
      };
      const close = (): Promise<void> => {
        closeFlight ??= (async () => {
          const failures: unknown[] = [];
          try {
            await runtime.runtimeExtensions.dispatch("session_shutdown", { reason: "quit" } as never);
          } catch (error) {
            failures.push(error);
          }
          try {
            await runtime.close();
          } catch (error) {
            failures.push(error);
          }
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1) {
            throw new AggregateError(failures, "Serve runtime shutdown failed");
          }
        })();
        return closeFlight;
      };
      return {
        get sessionId() {
          return runtime.session.sessionId;
        },
        get suspendedRun() {
          return runtime.session.suspendedRun;
        },
        get summary() {
          const state = runtime.session.state;
          return {
            ...(state.model === undefined
              ? {}
              : {
                  model: {
                    provider: state.model.provider,
                    api: state.model.api,
                    id: state.model.id,
                  },
                }),
            thinkingLevel: state.thinkingLevel,
            isStreaming: state.isStreaming,
            isCompacting: runtime.session.isCompacting,
            isRetrying: runtime.session.isRetrying,
            pendingMessageCount: runtime.session.pendingMessageCount,
            hasSuspendedRun: state.suspendedRun !== undefined,
            messageCount: state.messages.length,
            toolCount: state.tools.length,
          };
        },
        onEvent(listener) {
          return runtime.session.onEvent(listener);
        },
        async start(startSignal) {
          startSignal.throwIfAborted();
          await runtime.session.bindExtensions(
            serveExtensionBindings(runtime, options.requestShutdown),
            startSignal,
          );
          startSignal.throwIfAborted();
          if (runtime.session.suspendedRun !== undefined) {
            const recovery = await runtime.session.recoverInterruptedRun({ signal: startSignal });
            startSignal.throwIfAborted();
            if (!recovery.recovered) return;
          }
          startSignal.throwIfAborted();
          await ensureModel(startSignal);
        },
        async prompt(text, promptOptions) {
          return await runtime.session.prompt(text, promptOptions);
        },
        async recoverInterruptedRun(recoveryOptions = {}) {
          const recovery = await runtime.session.recoverInterruptedRun(recoveryOptions);
          if (runtime.session.suspendedRun === undefined) {
            await ensureModel(recoveryOptions.signal ?? new AbortController().signal);
          }
          return recovery;
        },
        async abort(reason) {
          await runtime.session.abort(reason);
        },
        async close() {
          await close();
        },
      };
    } catch (error) {
      await runtime.close().catch(() => undefined);
      throw error;
    }
  };

  return {
    async resolveWorkspace(workspace, signal) {
      signal.throwIfAborted();
      const resolved = await resolveWorkspace(workspace);
      signal.throwIfAborted();
      return resolved;
    },
    async create(request, signal) {
      signal.throwIfAborted();
      const workspace = request.workspace ?? baseWorkspace;
      const sessionDirectory = await sessionDirectoryFor(workspace);
      signal.throwIfAborted();
      return await load(
        SessionManager.create(workspace, sessionDirectory),
        sessionDirectory,
        signal,
      );
    },
    async open(request, signal) {
      signal.throwIfAborted();
      const workspace = request.workspace ?? baseWorkspace;
      const sessionDirectory = await sessionDirectoryFor(workspace);
      signal.throwIfAborted();
      const session = (await SessionManager.list(workspace, sessionDirectory))
        .find((candidate) => candidate.id === request.sessionId);
      signal.throwIfAborted();
      if (session === undefined) return undefined;
      return await load(
        SessionManager.open(session.path, sessionDirectory, workspace),
        sessionDirectory,
        signal,
      );
    },
  };
}

async function runServeOperation(
  argumentsValue: ManagementArguments,
  termination: GracefulTerminationContext,
  options: ServeCommandOptions,
): Promise<void> {
  if (argumentsValue.positionals.length > 0) {
    throw new Error("serve does not accept positional arguments");
  }
  const environment = options.environment ?? process.env;
  const token = serveToken(environment);
  const requestedHost = flagString(argumentsValue, "host") ?? DEFAULT_SERVE_HOST;
  assertLoopbackServeHost(requestedHost);
  const host = requestedHost === "localhost" ? DEFAULT_SERVE_HOST : requestedHost;
  const port = servePort(argumentsValue);
  const sessionDirectory = flagString(argumentsValue, "session-dir");
  const requestedShutdown = new AbortController();
  const sessionFactory = await createProductServeSessionFactory({
    baseWorkspace: flagString(argumentsValue, "workspace") ?? process.cwd(),
    environment,
    extensionFactories: options.extensionFactories ?? [],
    extensionPaths: flagStrings(argumentsValue, "extension"),
    extensions: !flagBoolean(argumentsValue, "no-extensions"),
    offline: flagBoolean(argumentsValue, "offline")
      || /^(?:1|true|yes)$/iu.test(environment.RIGYN_OFFLINE ?? ""),
    ...(options.toolAuthorizationHandler === undefined
      ? {}
      : { toolAuthorizationHandler: options.toolAuthorizationHandler }),
    ...(options.projectTrustResolver === undefined
      ? {}
      : { projectTrustResolver: options.projectTrustResolver }),
    ...(sessionDirectory === undefined ? {} : { sessionDirectory }),
    requestShutdown() {
      requestedShutdown.abort(new Error("Serve shutdown requested by an extension"));
    },
  });
  termination.throwIfTerminated();
  const server = await startServeServer({ host, port, token, sessionFactory });
  const uninstallTermination = termination.onTerminate(() => {
    void server.close().catch(() => undefined);
  });
  try {
    writeMachineOutput(`rigyn serve listening at ${server.origin}\n`);
    await waitForShutdown(AbortSignal.any([termination.signal, requestedShutdown.signal]));
  } finally {
    uninstallTermination();
    await server.close();
  }
}

export async function runServeCommand(
  argumentsValue: ManagementArguments,
  options: ServeCommandOptions = {},
): Promise<void> {
  await withGracefulTermination(async (termination) => {
    await runServeOperation(argumentsValue, termination, options);
  });
}
