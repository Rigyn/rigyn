import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

import { defaultSecretRedactor } from "../auth/redaction.js";
import { getAgentDir } from "../config/paths.js";
import type { RuntimeInlineExtension } from "../extensions/runtime.js";
import { RpcExtensionUiBridge } from "../interfaces/rpc-extension-ui.js";
import { RpcRuntimeDispatcher } from "../interfaces/rpc-runtime.js";
import { decodeRpcLines, parseRpcInput, RpcWriter } from "../interfaces/rpc.js";
import type { RpcCommand, RpcExtensionUiResponse, RpcResponse } from "../interfaces/rpc-protocol.js";
import { withGracefulTermination, type GracefulTerminationContext } from "../process/graceful-termination.js";
import {
  createAgentSessionRuntime,
  type AgentSessionRuntime,
  type AgentSessionRuntimeServices,
  type SessionStartEvent as RuntimeSessionStartEvent,
} from "../service/agent-session-runtime.js";
import { SessionManager } from "../storage/session-manager.js";
import type { Args } from "./args.js";
import { applyRuntimeExtensionFlags } from "./extension-flags.js";
import { loadRuntime, type LoadedRuntime } from "./runtime.js";
import type { ProjectTrustResolver } from "./project-trust.js";
import { selectStartupSession } from "./session-picker.js";
import { createStartupSession } from "./session-startup.js";
import { activeToolsForSelection, selectedTools } from "./tool-selection.js";

const RPC_STDIN_RELAY_SOURCE = String.raw`
const { createReadStream, writeFileSync } = require("node:fs");
let completed = false;
process.once("disconnect", () => {
  if (!completed) process.kill(process.pid, "SIGKILL");
});
(async () => {
  try {
    for await (const chunk of createReadStream("", { fd: 0 })) writeFileSync(1, chunk);
  } catch (error) {
    try { writeFileSync(2, error instanceof Error ? error.message : String(error)); } catch {}
    process.exitCode = 1;
  } finally {
    completed = true;
    if (process.connected) process.disconnect();
  }
})();
`;

const NODE_MAJOR = Number(process.versions.node.split(".", 1)[0]);

interface RpcInput {
  readonly stream: AsyncIterable<string | Uint8Array>;
  close(): void;
  failure(): Promise<Error | undefined>;
}

interface RpcLoadedServices extends AgentSessionRuntimeServices {
  runtime: LoadedRuntime;
  sessionStartEvent?: RuntimeSessionStartEvent;
}

function createRpcInput(): RpcInput {
  if (NODE_MAJOR < 26) {
    return {
      stream: process.stdin,
      close() { process.stdin.pause(); process.stdin.destroy(); },
      async failure() { return undefined; },
    };
  }
  const relay = spawn(process.execPath, ["--input-type=commonjs", "--eval", RPC_STDIN_RELAY_SOURCE], {
    stdio: [0, "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  if (relay.stdout === null || relay.stderr === null) throw new Error("RPC stdin relay pipes are unavailable");
  let closing = false;
  let diagnostic = Buffer.alloc(0);
  relay.stderr.on("data", (value: Buffer) => {
    if (diagnostic.length >= 4_096) return;
    const chunk = Buffer.from(value);
    diagnostic = Buffer.concat([diagnostic, chunk.subarray(0, 4_096 - diagnostic.length)]);
  });
  const settled = new Promise<Error | undefined>((finish) => {
    let done = false;
    const settle = (error?: Error): void => {
      if (done) return;
      done = true;
      finish(error);
    };
    relay.once("error", settle);
    relay.once("close", (code, signal) => {
      if (closing || code === 0) settle();
      else {
        const detail = diagnostic.toString("utf8").trim();
        settle(new Error(
          `RPC stdin relay failed${code === null ? ` with signal ${signal ?? "unknown"}` : ` with exit ${code}`}${detail === "" ? "" : `: ${detail}`}`,
        ));
      }
    });
  });
  relay.stdout.on("error", () => undefined);
  return {
    stream: relay.stdout,
    close() {
      if (closing) return;
      closing = true;
      if (relay.exitCode === null && relay.signalCode === null) relay.kill("SIGKILL");
      relay.stdout?.destroy();
      relay.stderr?.destroy();
    },
    async failure() { return await settled; },
  };
}

function message(error: unknown): string {
  return defaultSecretRedactor.redact(error instanceof Error ? error.message : String(error));
}

function errorResponse(id: string | undefined, command: string, error: unknown): RpcResponse {
  return { ...(id === undefined ? {} : { id }), type: "response", command, success: false, error: message(error) };
}

async function settleBounded(promises: readonly Promise<unknown>[], timeoutMs: number): Promise<void> {
  if (promises.length === 0) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.allSettled(promises),
      new Promise<void>((done) => { timer = setTimeout(done, timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function selectModel(runtime: LoadedRuntime, args: Args): Promise<void> {
  const reference = args.model ?? runtime.session.model?.id ?? runtime.settings.getDefaultModel();
  const provider = args.provider ?? runtime.session.model?.provider ?? runtime.settings.getDefaultProvider();
  const thinking = args.thinking ?? runtime.session.thinkingLevel ?? runtime.settings.getDefaultThinkingLevel();
  if (reference !== undefined) {
    const model = await runtime.session.resolveModel(reference, {
      ...(provider === undefined ? {} : { provider }),
      ...(thinking === undefined ? {} : { reasoningEffort: thinking }),
    });
    await runtime.session.setModel(model);
  }
  if (args.thinking !== undefined) runtime.session.setThinkingLevel(args.thinking);
}

async function createRuntimeOwner(
  args: Args,
  manager: SessionManager,
  extensionFactories: readonly RuntimeInlineExtension[] = [],
  projectTrustResolver?: ProjectTrustResolver,
): Promise<AgentSessionRuntime<RpcLoadedServices>> {
  const create = async ({ cwd, agentDir, sessionManager, sessionStartEvent }: {
    cwd: string;
    agentDir: string;
    sessionManager: SessionManager;
    sessionStartEvent?: RuntimeSessionStartEvent;
  }) => {
    const runtime = await loadRuntime({
      workspace: cwd,
      sessionManager,
      ...(args.sessionDir === undefined ? {} : { sessionDirectory: args.sessionDir }),
      extensions: args.noExtensions !== true,
      extensionPaths: args.extensions ?? [],
      extensionFactories,
      ...(projectTrustResolver === undefined ? {} : { projectTrustResolver }),
      skills: args.noSkills !== true,
      skillPaths: args.skills ?? [],
      promptTemplates: args.noPromptTemplates !== true,
      promptTemplatePaths: args.promptTemplates ?? [],
      themes: args.noThemes !== true,
      themePaths: args.themes ?? [],
      ...(args.apiKey === undefined ? {} : { apiKey: args.apiKey, apiKeyProvider: args.provider ?? "openai" }),
      ...(projectTrustResolver === undefined && args.projectTrustOverride !== undefined
        ? { projectTrusted: args.projectTrustOverride }
        : {}),
      ...(args.systemPrompt === undefined ? {} : { systemPrompt: args.systemPrompt }),
      ...(args.appendSystemPrompt === undefined ? {} : { appendSystemPrompt: args.appendSystemPrompt }),
      extensionRuntime: true,
      offline: args.offline === true || /^(?:1|true|yes)$/iu.test(process.env.RIGYN_OFFLINE ?? ""),
    });
    try {
      applyRuntimeExtensionFlags(args, runtime.runtimeExtensions);
      const argumentErrors = args.diagnostics.filter((entry) => entry.type === "error");
      if (argumentErrors.length > 0) throw new Error(argumentErrors.map((entry) => entry.message).join("\n"));
      await selectModel(runtime, args);
      return {
        session: runtime.session,
        services: {
          cwd,
          agentDir,
          runtime,
          ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
          async close() { await runtime.close(); },
        },
      };
    } catch (error) {
      await runtime.close().catch(() => undefined);
      throw error;
    }
  };
  let owner: AgentSessionRuntime<RpcLoadedServices>;
  owner = await createAgentSessionRuntime(create, {
    cwd: manager.getCwd(),
    agentDir: getAgentDir(),
    sessionManager: manager,
  }, {
    async beforeSwitch(event) {
      const host = owner.services.runtime.runtimeExtensions;
      return await host.reduceSessionBeforeSwitch({
        reason: event.reason,
        ...(event.targetSessionFile === undefined ? {} : { targetSessionFile: event.targetSessionFile }),
      } as never);
    },
    async beforeFork(event) {
      return await owner.services.runtime.runtimeExtensions.reduceSessionBeforeFork({
        entryId: event.entryId,
        position: event.position,
      } as never);
    },
    async shutdown(event) {
      const runtime = owner.services.runtime;
      await runtime.runtimeExtensions.dispatch("session_shutdown", {
        reason: event.reason,
        ...(event.targetSessionFile === undefined ? {} : { targetSessionFile: event.targetSessionFile }),
      } as never);
    },
  });
  return owner;
}

export interface RpcServerOptions {
  extensionFactories?: readonly RuntimeInlineExtension[];
  projectTrustResolver?: ProjectTrustResolver;
}

export async function runRpcServer(argumentsValue: Args, options: RpcServerOptions = {}): Promise<void> {
  await withGracefulTermination(async (termination) => {
    await runRpcServerOperation(argumentsValue, termination, options);
  });
}

async function runRpcServerOperation(
  args: Args,
  termination: GracefulTerminationContext,
  options: RpcServerOptions,
): Promise<void> {
  selectedTools(args);
  const workspace = resolve(args.workspace ?? process.cwd());
  const selected = await createStartupSession(args, workspace, args.sessionDir, {
    async selectSession(current, all) { return await selectStartupSession(current, all); },
    async confirmForkFromWorkspace(targetWorkspace) {
      return await new Promise<boolean>((answer) => {
        const input = createInterface({ input: process.stdin, output: process.stderr });
        input.question(`Session found in different workspace: ${targetWorkspace}\nFork it into the current workspace? [y/N] `, (value) => {
          input.close();
          answer(/^(?:y|yes)$/iu.test(value.trim()));
        });
      });
    },
  });
  if (selected.cancelled || selected.sessionManager === undefined) return;
  if (args.name !== undefined) {
    const name = args.name.trim();
    if (name === "") throw new Error("--name requires a non-empty value");
    selected.sessionManager.appendSessionInfo(name);
  }

  const writer = new RpcWriter();
  const owner = await createRuntimeOwner(
    args,
    selected.sessionManager,
    options.extensionFactories,
    options.projectTrustResolver,
  );
  const input = createRpcInput();
  let closing = false;
  const bridge = new RpcExtensionUiBridge({ async emit(request) { await writer.send(request); } });
  const dispatcher = new RpcRuntimeDispatcher({
    runtime: owner,
    async output(value) { await writer.send(value); },
    promptOptions() {
      const configuredTools = owner.services.runtime.settings.getToolSettings();
      const selection = selectedTools(
        args,
        owner.services.runtime.runtimeExtensions.tools().map((tool) => tool.definition.name),
        {
          ...(configuredTools.enabled === undefined ? {} : { allowedTools: configuredTools.enabled }),
          ...(configuredTools.excluded === undefined ? {} : { excludedTools: configuredTools.excluded }),
        },
      );
      return {
        ...(selection.allowedTools === undefined ? {} : { allowedTools: selection.allowedTools }),
        ...(selection.excludedTools === undefined ? {} : { excludedTools: selection.excludedTools }),
      };
    },
    async bindSession(session) {
      owner.services.runtime.runtimeExtensions.setDirectUiHandler((extensionId, signal) => bridge.context(extensionId, signal));
      owner.services.runtime.setExtensionShutdownHandler(async () => {
        closing = true;
        input.close();
        return { accepted: true };
      });
      await session.bindExtensions({
        mode: "rpc",
        uiContext: bridge.context("runtime", owner.services.runtime.runtimeExtensions.lifecycleSignal()),
      });
      const configuredTools = owner.services.runtime.settings.getToolSettings();
      const selection = selectedTools(
        args,
        owner.services.runtime.runtimeExtensions.tools().map((tool) => tool.definition.name),
        {
          ...(configuredTools.enabled === undefined ? {} : { allowedTools: configuredTools.enabled }),
          ...(configuredTools.excluded === undefined ? {} : { excludedTools: configuredTools.excluded }),
        },
      );
      session.setActiveTools(activeToolsForSelection(
        session.getAllTools().map((tool) => tool.definition.name),
        selection,
      ));
    },
  });
  const handlers = new Set<Promise<void>>();
  const closeInput = (): void => {
    if (closing) return;
    closing = true;
    input.close();
  };
  const uninstallTermination = termination.onTerminate(() => closeInput());
  const handle = async (line: string): Promise<void> => {
    let record;
    try {
      record = parseRpcInput(line);
    } catch (error) {
      await writer.send(errorResponse(undefined, "parse", `Failed to parse command: ${message(error)}`));
      return;
    }
    if (record.type === "extension_ui_response") {
      bridge.handle(record as RpcExtensionUiResponse);
      return;
    }
    const response = await dispatcher.dispatch(record as RpcCommand);
    if (response !== undefined) await writer.send(response);
  };

  let started = false;
  try {
    termination.throwIfTerminated();
    await dispatcher.start();
    started = true;
    termination.throwIfTerminated();
    for await (const line of decodeRpcLines(input.stream)) {
      if (closing) break;
      if (line.trim() === "") continue;
      if (handlers.size >= 64) await Promise.race(handlers);
      const task = handle(line).catch(() => closeInput()).finally(() => handlers.delete(task));
      handlers.add(task);
    }
    const failure = await input.failure();
    if (failure !== undefined) throw failure;
  } catch (error) {
    if (!started) throw error;
    if (!closing) await writer.send(errorResponse(undefined, "parse", error)).catch(() => undefined);
  } finally {
    closeInput();
    try {
      await settleBounded([...handlers], 5_000);
      bridge.close();
      await dispatcher.close();
    } finally {
      try { await owner.dispose(); }
      finally { uninstallTermination(); }
    }
  }
}
