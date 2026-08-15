import { RuntimeExtensionHost } from "../runtime.js";
import type {
  ImageBlock,
  TextBlock,
} from "../../core/types.js";
import type { JsonValue } from "../../core/json.js";
import { runProcess } from "../../process/runner.js";
import { resolve } from "node:path";
import type { ImageContent, Provider, TextContent } from "@rigyn/models";
import type {
  Extension,
  ExtensionRuntime,
  ProviderConfig,
} from "../direct.js";
import type {
  RuntimeDirectActionsHandler,
  RuntimeDirectProviderConfig,
} from "../runtime.js";

interface CompatibilityRuntimeRecord {
  host?: RuntimeExtensionHost;
}

const compatibilityRuntimes = new WeakMap<ExtensionRuntime, CompatibilityRuntimeRecord>();
const extensionRuntimeOwners = new WeakMap<Extension, RuntimeExtensionHost>();

function runtimeRecord(runtime: ExtensionRuntime): CompatibilityRuntimeRecord {
  let selected = compatibilityRuntimes.get(runtime);
  if (selected === undefined) {
    selected = {};
    compatibilityRuntimes.set(runtime, selected);
  }
  return selected;
}

export function attachExtensionRuntimeHost(runtime: ExtensionRuntime, host: RuntimeExtensionHost): void {
  const record = runtimeRecord(runtime);
  if (record.host !== undefined && record.host !== host) {
    throw new Error("Extension runtime is already attached to another host generation");
  }
  record.host = host;
}

export function getExtensionRuntimeHost(runtime: ExtensionRuntime): RuntimeExtensionHost | undefined {
  return runtimeRecord(runtime).host;
}

export function ensureExtensionRuntimeHost(runtime: ExtensionRuntime, cwd: string): RuntimeExtensionHost {
  const existing = getExtensionRuntimeHost(runtime);
  if (existing !== undefined) return existing;
  const host = new RuntimeExtensionHost(cwd);
  attachExtensionRuntimeHost(runtime, host);
  return host;
}

export function attachExtensionProjection(
  extension: Extension,
  runtime: ExtensionRuntime,
): void {
  const host = getExtensionRuntimeHost(runtime);
  if (host === undefined) throw new Error("Extension runtime has no attached host generation");
  const owner = extensionRuntimeOwners.get(extension);
  if (owner !== undefined && owner !== host) throw new Error("Extension projection belongs to another host generation");
  extensionRuntimeOwners.set(extension, host);
}

export function extensionProjectionHost(extension: Extension): RuntimeExtensionHost | undefined {
  return extensionRuntimeOwners.get(extension);
}

export function createExtensionRuntime(): ExtensionRuntime {
  let staleMessage: string | undefined;
  let runtime!: ExtensionRuntime;
  const assertActive = (): void => {
    if (staleMessage !== undefined) throw new Error(staleMessage);
  };
  const unavailable = (): never => {
    assertActive();
    throw new Error("Extension runtime actions are unavailable before the session host is bound");
  };

  runtime = {
    sendMessage: unavailable,
    sendUserMessage: unavailable,
    appendEntry: unavailable,
    setSessionName: unavailable,
    getSessionName: unavailable,
    setLabel: unavailable,
    getActiveTools: unavailable,
    getAllTools: unavailable,
    setActiveTools: unavailable,
    refreshTools: () => {},
    getCommands: unavailable,
    setModel: async () => {
      assertActive();
      throw new Error("Extension runtime actions are unavailable before the session host is bound");
    },
    getThinkingLevel: unavailable,
    setThinkingLevel: unavailable,
    flagValues: new Map(),
    pendingProviderRegistrations: [],
    pendingNativeProviderRegistrations: [],
    assertActive,
    invalidate(message) {
      staleMessage ??= message ?? "Extension runtime context is stale after session replacement or refresh";
    },
    registerProvider(name, config, extensionPath = "<unknown>") {
      assertActive();
      runtime.pendingProviderRegistrations.push({ name, config, extensionPath });
    },
    registerNativeProvider(provider, extensionPath = "<unknown>") {
      assertActive();
      runtime.pendingNativeProviderRegistrations.push({ provider, extensionPath });
    },
    unregisterProvider(name) {
      assertActive();
      runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((entry) => entry.name !== name);
      runtime.pendingNativeProviderRegistrations = runtime.pendingNativeProviderRegistrations.filter(
        (entry) => entry.provider.id !== name,
      );
    },
  };
  compatibilityRuntimes.set(runtime, {});
  return runtime;
}

export function compatibilityPublicContent(
  blocks: readonly (TextBlock | ImageBlock)[],
): Array<TextContent | ImageContent> {
  return blocks.map((block) => block.type === "text"
    ? { type: "text", text: block.text }
    : { type: "image", data: block.data ?? "", mimeType: block.mediaType });
}

type CompatibilitySessionActions = Pick<
  RuntimeDirectActionsHandler,
  | "getSystemPromptOptions"
  | "waitForIdle"
  | "newSession"
  | "fork"
  | "navigateTree"
  | "switchSession"
  | "refresh"
>;

export function createCompatibilityDirectActions(
  runtime: ExtensionRuntime,
  cwd: string,
  assertActive: () => void,
  session: CompatibilitySessionActions,
): RuntimeDirectActionsHandler {
  const active = <TArgs extends unknown[], TResult>(
    operation: (...args: TArgs) => TResult,
  ): ((...args: TArgs) => TResult) => (...args) => {
    assertActive();
    return operation(...args);
  };
  function registerProvider(provider: Provider, config?: undefined): void;
  function registerProvider(name: string, config: RuntimeDirectProviderConfig): void;
  function registerProvider(providerOrName: Provider | string, config?: RuntimeDirectProviderConfig): void {
    assertActive();
    if (typeof providerOrName === "string") {
      if (config === undefined || config === null || typeof config !== "object") {
        throw new Error("A provider object is required when registration uses a string name");
      }
      runtime.registerProvider(providerOrName, config as ProviderConfig);
      return;
    }
    runtime.registerNativeProvider(providerOrName);
  }
  return {
    sendMessage: active((message, options) => runtime.sendMessage({
      customType: message.customType,
      content: typeof message.content === "string" ? message.content : compatibilityPublicContent(message.content),
      display: message.display,
      ...(message.details === undefined ? {} : { details: message.details }),
    }, options)),
    sendUserMessage: active((content, options) => runtime.sendUserMessage(
      typeof content === "string" ? content : compatibilityPublicContent(content),
      options,
    )),
    appendEntry: active((customType, data) => runtime.appendEntry(customType, data)),
    setSessionName: active((name) => runtime.setSessionName(name)),
    getSessionName: active(() => runtime.getSessionName()),
    setLabel: active((entryId, label) => runtime.setLabel(entryId, label)),
    exec: active(async (command, args, options = {}) => {
      if (command.trim() === "" || command.includes("\0") || args.some((argument) => argument.includes("\0"))) {
        throw new Error("Direct extension command is invalid");
      }
      const timeoutMs = options.timeout ?? 600_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
        throw new Error("Direct extension timeout must be between 1 and 3600000 milliseconds");
      }
      const result = await runProcess({
        argv: [command, ...args],
        cwd: resolve(cwd, options.cwd ?? cwd),
        timeoutMs,
        outputLimitBytes: 8 * 1024 * 1024,
      }, options.signal ?? new AbortController().signal);
      return {
        stdout: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8"),
        code: result.exitCode ?? (result.cancelled || result.timedOut ? 1 : 0),
        killed: result.cancelled || result.timedOut || result.signal !== null,
      };
    }),
    getActiveTools: active(() => [...runtime.getActiveTools()]),
    getAllTools: active(() => {
      const activeTools = new Set(runtime.getActiveTools());
      return runtime.getAllTools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters as unknown as Record<string, JsonValue>,
        active: activeTools.has(tool.name),
        executionMode: "parallel",
        owner: { kind: "host" },
        sourceInfo: { ...tool.sourceInfo },
        ...(tool.promptGuidelines === undefined ? {} : { promptGuidelines: [...tool.promptGuidelines] }),
      }));
    }),
    setActiveTools: active((toolNames) => runtime.setActiveTools(toolNames)),
    setModel: active(async (model) => await runtime.setModel(model)),
    getThinkingLevel: active(() => runtime.getThinkingLevel()),
    setThinkingLevel: active((level) => runtime.setThinkingLevel(
      level as Parameters<ExtensionRuntime["setThinkingLevel"]>[0],
    )),
    registerProvider,
    unregisterProvider: active((name) => runtime.unregisterProvider(name)),
    getSystemPromptOptions: active(session.getSystemPromptOptions),
    waitForIdle: active(session.waitForIdle),
    newSession: active(session.newSession),
    fork: active(session.fork),
    navigateTree: active(session.navigateTree),
    switchSession: active(session.switchSession),
    refresh: active(session.refresh),
  };
}
