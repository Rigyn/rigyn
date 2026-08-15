import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import type { AgentMessage } from "@rigyn/kernel";
import { canonicalPublicImages } from "../core/public-image-content.js";
import type { ExtensionRunner } from "../extensions/compat-runtime.js";
import {
  canonicalSessionEntryId,
  extensionMessages,
  extensionSessionManager,
  type SessionEntry as PublicSessionEntry,
  type SessionTreeNode as PublicSessionTreeNode,
} from "../extensions/session-contract.js";
import type { SessionContextMessage } from "../storage/types.js";
import type { AgentSession, AgentSessionPromptOptions } from "../service/agent-session.js";
import type { AgentSessionRuntime } from "../service/agent-session-runtime.js";
import type { ProviderModelThinkingLevel } from "../providers/models.js";
import type { ProviderModel } from "../providers/models.js";
import { extensionModel } from "../extensions/model-boundary.js";
import {
  MAX_TOOL_RESULT_CONTENT_BYTES,
  MAX_TOOL_RESULT_METADATA_BYTES,
} from "../tools/coordinator.js";
import { normalizeShellTerminalState } from "../tools/shell-result.js";
import { WorkspaceBoundary } from "../tools/paths.js";
import { MAX_RPC_LINE_BYTES, type RpcUnknownCommand } from "./rpc.js";
import { boundedRpcErrorMessage } from "./rpc-error.js";
import type {
  RpcBashExecutionUpdate,
  RpcCommand,
  RpcRecoveryResolution,
  RpcResponse,
  RpcSessionState,
  RpcSlashCommand,
} from "./rpc-protocol.js";

const DEFAULT_ENTRY_PAGE_SIZE = 512;
const MAX_ENTRY_PAGE_SIZE = 2_048;
const MAX_HISTORY_CURSOR_LENGTH = 2_048;
const MAX_HISTORY_PAGE_BYTES = MAX_RPC_LINE_BYTES / 2;
const MAX_BASH_UPDATE_CHUNK_BYTES = 64 * 1024;
const MAX_BASH_UPDATE_BYTES = 8 * 1024 * 1024;
const MAX_BASH_UPDATE_EVENTS = 2_048;
const MAX_RECOVERY_RESOLUTIONS = 256;
const MAX_RECOVERY_RESULT_BYTES = 12 * 1024 * 1024;
const MAX_RECOVERY_PAYLOAD_BYTES = 15 * 1024 * 1024;
const MAX_RECOVERY_EFFECT_ID_BYTES = 1_024;

function boundedEntryPageSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_ENTRY_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ENTRY_PAGE_SIZE) {
    throw new RangeError(`get_entries limit must be between 1 and ${MAX_ENTRY_PAGE_SIZE}`);
  }
  return value;
}

type HistoryResource = "tree" | "messages";

interface HistoryCursor {
  version: 1;
  resource: HistoryResource;
  snapshot: string;
  offset: number;
}

function boundedHistoryPageSize(command: "get_tree" | "get_messages", value: number | undefined): number {
  if (value === undefined) return DEFAULT_ENTRY_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ENTRY_PAGE_SIZE) {
    throw new RangeError(`${command} limit must be between 1 and ${MAX_ENTRY_PAGE_SIZE}`);
  }
  return value;
}

function boundedHistoryItems<T>(
  command: "get_entries" | "get_tree" | "get_messages",
  values: readonly T[],
): T[] {
  const page: T[] = [];
  let bytes = 2;
  for (const value of values) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error(`${command} history item is not JSON serializable`);
    const itemBytes = Buffer.byteLength(serialized, "utf8");
    const nextBytes = bytes + itemBytes + (page.length === 0 ? 0 : 1);
    if (nextBytes > MAX_HISTORY_PAGE_BYTES) {
      if (page.length === 0) {
        throw new Error(`${command} history item exceeds the RPC page byte limit`);
      }
      break;
    }
    page.push(value);
    bytes = nextBytes;
  }
  return page;
}

function publicTreePage(
  entries: readonly PublicSessionEntry[],
  labels: ReadonlyMap<string, Pick<PublicSessionTreeNode, "label" | "labelTimestamp">>,
): PublicSessionTreeNode[] {
  const nodes = new Map<string, PublicSessionTreeNode>(entries.map((entry) => [entry.id, {
    entry,
    children: [] as PublicSessionTreeNode[],
    ...(labels.get(entry.id) ?? {}),
  }]));
  const roots: PublicSessionTreeNode[] = [];
  for (const entry of entries) {
    const node = nodes.get(entry.id)!;
    const parent = entry.parentId === null ? undefined : nodes.get(entry.parentId);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }
  return roots;
}

const publicContextCache = new WeakMap<object, {
  entryCount: number;
  leafId: string | null;
  messages: AgentMessage[];
}>();

function projectContextMessage(message: SessionContextMessage): AgentMessage[] {
  if (message.role === "system") return [];
  if (message.role === "branchSummary" || message.role === "compactionSummary") {
    return [structuredClone(message) as AgentMessage];
  }
  return extensionMessages(message);
}

function publicContextMessages(session: AgentSession): AgentMessage[] {
  const native = nativeSessionManager(session);
  const manager = publicSessionManager(session);
  const entryCount = native?.getEntryCount() ?? manager.getEntries().length;
  const leafId = manager.getLeafId();
  const cached = publicContextCache.get(manager);
  if (cached?.entryCount === entryCount && cached.leafId === leafId) return structuredClone(cached.messages);
  let messages: AgentMessage[];
  if (native !== undefined) {
    messages = structuredClone(manager.buildSessionContext().messages);
  } else {
    const fallback = session.sessionManager as unknown as {
      getContextMessagePage?: (offset: number, limit: number) => {
        messages: SessionContextMessage[];
        totalMessages: number;
      };
    };
    if (fallback.getContextMessagePage === undefined) {
      messages = (session.messages as unknown as SessionContextMessage[]).flatMap(projectContextMessage);
    } else {
      const canonical: SessionContextMessage[] = [];
      let offset = 0;
      while (true) {
        const page = fallback.getContextMessagePage(offset, DEFAULT_ENTRY_PAGE_SIZE);
        canonical.push(...page.messages);
        offset += page.messages.length;
        if (offset >= page.totalMessages || page.messages.length === 0) break;
      }
      messages = canonical.flatMap(projectContextMessage);
    }
  }
  publicContextCache.set(manager, { entryCount, leafId, messages: structuredClone(messages) });
  return messages;
}

function nativeSessionManager(session: AgentSession): AgentSession["nativeSessionManager"] | undefined {
  const manager = Reflect.get(session, "nativeSessionManager") as AgentSession["nativeSessionManager"] | undefined;
  return manager;
}

function publicSessionManager(session: AgentSession): AgentSession["sessionManager"] {
  const native = nativeSessionManager(session);
  return native === undefined
    ? extensionSessionManager(session.sessionManager as unknown as AgentSession["nativeSessionManager"])
    : session.sessionManager;
}

function publicEntryPage(
  manager: AgentSession["sessionManager"],
  offset: number,
  limit: number,
): { entries: PublicSessionEntry[]; totalEntries: number } {
  const getEntriesPage = Reflect.get(manager, "getEntriesPage") as ((
    offset: number,
    limit: number,
  ) => { entries: PublicSessionEntry[]; totalEntries: number }) | undefined;
  if (getEntriesPage !== undefined) return getEntriesPage.call(manager, offset, limit);
  const entries = manager.getEntries();
  return {
    entries: offset < 0 || limit < 1 ? [] : entries.slice(offset, offset + limit),
    totalEntries: entries.length,
  };
}

function canonicalRpcEntryId(session: AgentSession, publicId: string): string | undefined {
  const native = nativeSessionManager(session)
    ?? session.sessionManager as unknown as AgentSession["nativeSessionManager"];
  return canonicalSessionEntryId(native, publicId);
}

function rpcTreeRevision(session: AgentSession): number | undefined {
  const manager = nativeSessionManager(session) ?? session.sessionManager;
  const getTreeRevision = Reflect.get(manager, "getTreeRevision") as (() => number) | undefined;
  return getTreeRevision?.call(manager);
}

function encodeHistoryCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeHistoryCursor(
  command: "get_tree" | "get_messages",
  resource: HistoryResource,
  value: unknown,
): HistoryCursor {
  const invalid = (): never => { throw new Error(`${command} cursor is invalid`); };
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > MAX_HISTORY_CURSOR_LENGTH
    || !/^[A-Za-z0-9_-]+$/u.test(value)
  ) return invalid();
  let parsed: unknown;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) return invalid();
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    return invalid();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return invalid();
  const candidate = parsed as Partial<HistoryCursor>;
  if (
    candidate.version !== 1
    || candidate.resource !== resource
    || typeof candidate.snapshot !== "string"
    || !/^[a-f0-9]{64}$/u.test(candidate.snapshot)
    || !Number.isSafeInteger(candidate.offset)
    || (candidate.offset as number) < 0
  ) return invalid();
  return candidate as HistoryCursor;
}

function historySnapshot(
  sessionId: string,
  leafId: string | null,
  entryCount: number,
  metadataRevision?: number,
): string {
  const digest = createHash("sha256")
    .update(`${Buffer.byteLength(sessionId, "utf8")}:`, "utf8")
    .update(sessionId, "utf8");
  if (leafId === null) digest.update("|null", "utf8");
  else {
    digest
      .update(`|${Buffer.byteLength(leafId, "utf8")}:`, "utf8")
      .update(leafId, "utf8");
  }
  digest.update(`|${entryCount}`, "utf8");
  if (metadataRevision !== undefined) digest.update(`|metadata:${metadataRevision}`, "utf8");
  return digest.digest("hex");
}

function historyOffset(
  command: "get_tree" | "get_messages",
  resource: HistoryResource,
  cursor: unknown,
  snapshot: string,
): number {
  if (cursor === undefined) return 0;
  const decoded = decodeHistoryCursor(command, resource, cursor);
  if (decoded.snapshot !== snapshot) throw new Error(`${command} cursor no longer matches the current session history`);
  return decoded.offset;
}

function jsonSnapshot(value: unknown, label: string): { value: unknown; bytes: number } {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError(`${label} must be JSON serializable`);
  }
  if (serialized === undefined) throw new TypeError(`${label} must be JSON serializable`);
  return {
    value: JSON.parse(serialized) as unknown,
    bytes: Buffer.byteLength(serialized, "utf8"),
  };
}

function boundedRecoveryResolutions(value: unknown): RpcRecoveryResolution[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError("Recovery resolutions must be an array");
  if (value.length > MAX_RECOVERY_RESOLUTIONS) {
    throw new RangeError(`Recovery resolutions cannot exceed ${MAX_RECOVERY_RESOLUTIONS} entries`);
  }
  const payload = jsonSnapshot(value, "Recovery resolutions");
  if (payload.bytes > MAX_RECOVERY_PAYLOAD_BYTES) {
    throw new RangeError(`Recovery resolutions exceed ${MAX_RECOVERY_PAYLOAD_BYTES} bytes`);
  }
  const resolutions = payload.value as unknown[];
  return resolutions.map((entry, index): RpcRecoveryResolution => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`Recovery resolution ${index} must be an object`);
    }
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate["effectId"] !== "string" ||
      candidate["effectId"] === "" ||
      candidate["effectId"].includes("\0") ||
      Buffer.byteLength(candidate["effectId"], "utf8") > MAX_RECOVERY_EFFECT_ID_BYTES
    ) {
      throw new TypeError(`Recovery resolution ${index} has an invalid effectId`);
    }
    const outcome = candidate["outcome"];
    if (outcome !== "succeeded" && outcome !== "failed" && outcome !== "abandoned") {
      throw new TypeError(`Recovery resolution ${index} has an invalid outcome`);
    }
    const result = candidate["result"];
    if (outcome !== "abandoned" && result === undefined) {
      throw new TypeError(`Recovery resolution ${index} requires a tool result`);
    }
    if (result === undefined) return { effectId: candidate["effectId"], outcome };
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw new TypeError(`Recovery resolution ${index} tool result must be an object`);
    }
    const resultSnapshot = jsonSnapshot(result, `Recovery resolution ${index} tool result`);
    if (resultSnapshot.bytes > MAX_RECOVERY_RESULT_BYTES) {
      throw new RangeError(`Recovery resolution ${index} tool result exceeds ${MAX_RECOVERY_RESULT_BYTES} bytes`);
    }
    const toolResult = resultSnapshot.value as Record<string, unknown>;
    if (
      typeof toolResult["content"] !== "string" ||
      Buffer.byteLength(toolResult["content"], "utf8") > MAX_TOOL_RESULT_CONTENT_BYTES ||
      typeof toolResult["isError"] !== "boolean"
    ) {
      throw new TypeError(
        `Recovery resolution ${index} requires tool result content within ${MAX_TOOL_RESULT_CONTENT_BYTES} bytes and an isError flag`,
      );
    }
    if (
      (outcome === "succeeded" && toolResult["isError"] !== false) ||
      (outcome === "failed" && toolResult["isError"] !== true)
    ) {
      throw new TypeError(`Recovery resolution ${index} outcome does not match its tool result`);
    }
    if (
      toolResult["status"] !== undefined &&
      toolResult["status"] !== "success" &&
      toolResult["status"] !== "warning" &&
      toolResult["status"] !== "error"
    ) {
      throw new TypeError(`Recovery resolution ${index} tool result status is invalid`);
    }
    if (toolResult["metadata"] !== undefined) {
      const metadata = jsonSnapshot(toolResult["metadata"], `Recovery resolution ${index} tool result metadata`);
      if (metadata.bytes > MAX_TOOL_RESULT_METADATA_BYTES) {
        throw new RangeError(
          `Recovery resolution ${index} tool result metadata exceeds ${MAX_TOOL_RESULT_METADATA_BYTES} bytes`,
        );
      }
    }
    return {
      effectId: candidate["effectId"],
      outcome,
      result: toolResult as unknown as NonNullable<RpcRecoveryResolution["result"]>,
    };
  });
}

export interface RpcSessionRuntime {
  readonly session: AgentSession;
  newSession(options?: Parameters<AgentSessionRuntime["newSession"]>[0]): ReturnType<AgentSessionRuntime["newSession"]>;
  switchSession(path: string, options?: Parameters<AgentSessionRuntime["switchSession"]>[1]): ReturnType<AgentSessionRuntime["switchSession"]>;
  fork(entryId: string, options?: Parameters<AgentSessionRuntime["fork"]>[1]): ReturnType<AgentSessionRuntime["fork"]>;
  setRebindSession(callback?: (session: AgentSession) => Promise<void>): void;
  setBeforeSessionInvalidate(callback?: () => void): void;
}

export interface RpcRuntimeDispatcherOptions {
  runtime: RpcSessionRuntime;
  output(value: object): void | Promise<void>;
  bindSession?(session: AgentSession): void | Promise<void>;
  promptOptions?(session: AgentSession): Pick<AgentSessionPromptOptions, "allowedTools" | "excludedTools">;
}

function errorMessage(error: unknown): string {
  return boundedRpcErrorMessage(error);
}

function success<T extends RpcCommand["type"]>(id: string | undefined, command: T, data?: object | null): RpcResponse {
  return data === undefined
    ? { id, type: "response", command, success: true } as RpcResponse
    : { id, type: "response", command, success: true, data } as RpcResponse;
}

function failure(id: string | undefined, command: string, error: unknown): RpcResponse {
  return {
    ...(id === undefined ? {} : { id }),
    type: "response",
    command,
    success: false,
    error: errorMessage(error),
  };
}

function publicModel(session: AgentSession, model: ProviderModel): ReturnType<typeof extensionModel> {
  try {
    return session.modelRuntime.getModel(model.provider, model.id) ?? extensionModel(model);
  } catch {
    return extensionModel(model);
  }
}

async function availablePublicModels(session: AgentSession): Promise<ReturnType<typeof extensionModel>[]> {
  try {
    return [...await session.modelRuntime.getAvailable()];
  } catch {
    return (await session.modelRegistry.getAvailable()).map((model) => extensionModel(model));
  }
}

function extensionCommands(runner: ExtensionRunner): RpcSlashCommand[] {
  return runner.getRegisteredCommands().map((command) => ({
    name: command.invocationName,
    ...(command.description === undefined ? {} : { description: command.description }),
    source: "extension" as const,
    sourceInfo: command.sourceInfo,
  }));
}

function describeSession(session: AgentSession): RpcSessionState {
  const reference = session.model;
  const suspendedRun = session.suspendedRun;
  const selectedModel = reference === undefined
    ? undefined
    : session.modelRegistry.find(reference.provider, reference.id);
  const presentedModel = selectedModel === undefined ? undefined : publicModel(session, selectedModel);
  const activity = {
    pendingMessageCount: session.pendingMessageCount,
    isCompacting: session.isCompacting,
    isStreaming: session.isStreaming,
  };
  return {
    sessionId: session.sessionId,
    thinkingLevel: session.thinkingLevel as ProviderModelThinkingLevel,
    ...(suspendedRun === undefined ? {} : { suspendedRun }),
    messageCount: session.messages.length,
    autoCompactionEnabled: session.autoCompactionEnabled,
    steeringMode: session.steeringMode,
    followUpMode: session.followUpMode,
    ...activity,
    ...(presentedModel === undefined ? {} : { model: presentedModel }),
    ...(session.sessionFile === undefined ? {} : { sessionFile: session.sessionFile }),
    ...(session.sessionName === undefined ? {} : { sessionName: session.sessionName }),
  };
}

function utf8Prefix(value: string, byteLimit: number): { prefix: string; bytes: number; complete: boolean } {
  if (value === "" || byteLimit < 1) return { prefix: "", bytes: 0, complete: value === "" };
  let prefix = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > byteLimit) return { prefix, bytes, complete: false };
    prefix += character;
    bytes += characterBytes;
  }
  return { prefix, bytes, complete: true };
}

/** Executes direct command records and streams raw agent events to the same output. */
export class RpcRuntimeDispatcher {
  readonly #runtime: RpcSessionRuntime;
  readonly #output: RpcRuntimeDispatcherOptions["output"];
  readonly #bindSession: RpcRuntimeDispatcherOptions["bindSession"];
  readonly #promptOptions: RpcRuntimeDispatcherOptions["promptOptions"];
  #unsubscribe: (() => void) | undefined;
  #bindingGeneration = 0;
  #modelControlTail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: RpcRuntimeDispatcherOptions) {
    this.#runtime = options.runtime;
    this.#output = options.output;
    this.#bindSession = options.bindSession;
    this.#promptOptions = options.promptOptions;
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error("RPC dispatcher is closed");
    this.#runtime.setBeforeSessionInvalidate(() => this.#unsubscribeSession());
    this.#runtime.setRebindSession(async (session) => await this.#rebind(session));
    await this.#rebind();
  }

  async dispatch(command: RpcCommand | RpcUnknownCommand): Promise<RpcResponse | undefined> {
    if (this.#closed) return failure(command.id, command.type, "RPC dispatcher is closed");
    const id = command.id;
    try {
      switch (command.type) {
        case "prompt": {
          const selected = command as Extract<RpcCommand, { type: "prompt" }>;
          const promptOptions = this.#promptOptions?.(this.#runtime.session) ?? {};
          let acknowledged = false;
          void this.#runtime.session.prompt(selected.message, {
            ...promptOptions,
            ...(selected.images === undefined ? {} : { images: canonicalPublicImages(selected.images, "prompt.images") }),
            ...(selected.streamingBehavior === undefined ? {} : { streamingBehavior: selected.streamingBehavior }),
            source: "rpc",
            preflightResult: (succeeded) => {
              if (!succeeded || acknowledged) return;
              acknowledged = true;
              void this.#output(success(id, "prompt"));
            },
          }).catch((error: unknown) => {
            if (!acknowledged) void this.#output(failure(id, "prompt", error));
          });
          return undefined;
        }
        case "steer": {
          const selected = command as Extract<RpcCommand, { type: "steer" }>;
          await this.#runtime.session.steer(
            selected.message,
            selected.images === undefined ? undefined : canonicalPublicImages(selected.images, "steer.images"),
          );
          return success(id, "steer");
        }
        case "follow_up": {
          const selected = command as Extract<RpcCommand, { type: "follow_up" }>;
          await this.#runtime.session.followUp(
            selected.message,
            selected.images === undefined ? undefined : canonicalPublicImages(selected.images, "follow_up.images"),
          );
          return success(id, "follow_up");
        }
        case "abort":
          await this.#runtime.session.abort();
          return success(id, "abort");
        case "new_session": {
          const selected = command as Extract<RpcCommand, { type: "new_session" }>;
          const result = await this.#runtime.newSession(selected.parentSession === undefined
            ? undefined
            : { parentSession: selected.parentSession });
          return success(id, "new_session", result);
        }
        case "get_state":
          return success(id, "get_state", describeSession(this.#runtime.session));
        case "get_recovery_status":
          return success(id, "get_recovery_status", this.#runtime.session.suspendedRun ?? null);
        case "recover_interrupted_run": {
          const selected = command as Extract<RpcCommand, { type: "recover_interrupted_run" }>;
          const resolutions = boundedRecoveryResolutions(selected.resolutions);
          return success(
            id,
            "recover_interrupted_run",
            await this.#runtime.session.recoverInterruptedRun(
              resolutions === undefined ? undefined : { resolutions },
            ),
          );
        }
        case "set_model": {
          const selected = command as Extract<RpcCommand, { type: "set_model" }>;
          return await this.#runModelControl(async () => {
            if (this.#closed) return failure(id, "set_model", "RPC dispatcher is closed");
            const models = await this.#runtime.session.modelRegistry.getAvailable();
            const model = models.find((candidate) => candidate.provider === selected.provider && candidate.id === selected.modelId);
            if (model === undefined) return failure(id, "set_model", `Model not found: ${selected.provider}/${selected.modelId}`);
            await this.#runtime.session.setModel(model);
            return success(
              id,
              "set_model",
              publicModel(this.#runtime.session, model),
            );
          });
        }
        case "cycle_model": {
          return await this.#runModelControl(async () => {
            if (this.#closed) return failure(id, "cycle_model", "RPC dispatcher is closed");
            const result = await this.#runtime.session.cycleModel();
            if (result === undefined) return success(id, "cycle_model", null);
            return success(id, "cycle_model", result);
          });
        }
        case "get_available_models":
          return success(id, "get_available_models", {
            models: await availablePublicModels(this.#runtime.session),
          });
        case "set_thinking_level": {
          const selected = command as Extract<RpcCommand, { type: "set_thinking_level" }>;
          this.#runtime.session.setThinkingLevel(selected.level);
          return success(id, "set_thinking_level");
        }
        case "cycle_thinking_level": {
          const level = this.#runtime.session.cycleThinkingLevel() as ProviderModelThinkingLevel | undefined;
          return success(id, "cycle_thinking_level", level === undefined ? null : { level });
        }
        case "get_available_thinking_levels":
          return success(id, "get_available_thinking_levels", {
            levels: this.#runtime.session.getAvailableThinkingLevels() as ProviderModelThinkingLevel[],
          });
        case "set_steering_mode": {
          const selected = command as Extract<RpcCommand, { type: "set_steering_mode" }>;
          this.#runtime.session.setSteeringMode(selected.mode);
          return success(id, "set_steering_mode");
        }
        case "set_follow_up_mode": {
          const selected = command as Extract<RpcCommand, { type: "set_follow_up_mode" }>;
          this.#runtime.session.setFollowUpMode(selected.mode);
          return success(id, "set_follow_up_mode");
        }
        case "compact": {
          const selected = command as Extract<RpcCommand, { type: "compact" }>;
          return success(id, "compact", await this.#runtime.session.compact(selected.customInstructions));
        }
        case "set_auto_compaction": {
          const selected = command as Extract<RpcCommand, { type: "set_auto_compaction" }>;
          this.#runtime.session.setAutoCompactionEnabled(selected.enabled);
          return success(id, "set_auto_compaction");
        }
        case "set_auto_retry": {
          const selected = command as Extract<RpcCommand, { type: "set_auto_retry" }>;
          this.#runtime.session.setAutoRetryEnabled(selected.enabled);
          return success(id, "set_auto_retry");
        }
        case "abort_retry":
          this.#runtime.session.abortRetry();
          return success(id, "abort_retry");
        case "bash": {
          const selected = command as Extract<RpcCommand, { type: "bash" }>;
          let outputTail = Promise.resolve();
          let outputFailure: unknown;
          let emittedBytes = 0;
          let emittedEvents = 0;
          let truncated = false;
          const queue = (event: RpcBashExecutionUpdate): void => {
            emittedEvents += 1;
            outputTail = outputTail.then(async () => await this.#output(event)).catch((error: unknown) => {
              outputFailure ??= error;
            });
          };
          const markTruncated = (delta = ""): void => {
            if (truncated) return;
            truncated = true;
            queue({
              type: "bash_execution_update",
              ...(id === undefined ? {} : { id }),
              delta,
              truncated: true,
            });
          };
          const onChunk = (delta: string): void => {
            if (delta === "" || truncated) return;
            let remaining = delta;
            while (remaining !== "") {
              if (emittedEvents >= MAX_BASH_UPDATE_EVENTS - 1 || emittedBytes >= MAX_BASH_UPDATE_BYTES) {
                markTruncated();
                return;
              }
              const budget = Math.min(
                MAX_BASH_UPDATE_CHUNK_BYTES,
                MAX_BASH_UPDATE_BYTES - emittedBytes,
              );
              const selectedPrefix = utf8Prefix(remaining, budget);
              if (selectedPrefix.prefix === "") {
                markTruncated();
                return;
              }
              const next = remaining.slice(selectedPrefix.prefix.length);
              emittedBytes += selectedPrefix.bytes;
              if (!selectedPrefix.complete && emittedBytes >= MAX_BASH_UPDATE_BYTES) {
                markTruncated(selectedPrefix.prefix);
                return;
              }
              queue({
                type: "bash_execution_update",
                ...(id === undefined ? {} : { id }),
                delta: selectedPrefix.prefix,
              });
              remaining = next;
            }
          };
          let result: Awaited<ReturnType<AgentSession["executeBash"]>> | undefined;
          let executionFailure: unknown;
          let executionFailed = false;
          try {
            const session = this.#runtime.session;
            const excludeFromContext = selected.excludeFromContext === true;
            const interceptsUserShell = typeof session.hasExtensionHandlers === "function" && (
              session.hasExtensionHandlers("user_bash") || session.hasExtensionHandlers("before_user_shell")
            );
            const intercepted = interceptsUserShell
              ? await session.extensionRunner.emitUserBash({
                  type: "user_bash",
                  command: selected.command,
                  excludeFromContext,
                  cwd: session.cwd,
                })
              : undefined;
            const effectiveCommand = intercepted?.command ?? selected.command;
            const effectiveCwd = intercepted?.cwd ?? session.cwd;
            const executionCwd = intercepted === undefined
              ? session.cwd
              : await (async () => {
                  const boundary = await WorkspaceBoundary.create(session.cwd);
                  const cwd = await boundary.readable(effectiveCwd);
                  if (!(await stat(cwd)).isDirectory()) {
                    throw new Error(`Shell shortcut cwd is not a directory: ${effectiveCwd}`);
                  }
                  return cwd;
                })();
            if (intercepted?.result !== undefined) {
              const handled = intercepted.result;
              const terminal = normalizeShellTerminalState(handled);
              result = {
                output: handled.output,
                exitCode: terminal.exitCode,
                ...(terminal.isError === undefined ? {} : { isError: terminal.isError }),
                cancelled: terminal.cancelled,
                ...(terminal.timedOut === undefined ? {} : { timedOut: terminal.timedOut }),
                ...(terminal.signal === undefined ? {} : { signal: terminal.signal }),
                truncated: handled.truncated,
                ...(handled.fullOutputPath === undefined ? {} : { fullOutputPath: handled.fullOutputPath }),
              };
              if (handled.output !== "") onChunk(handled.output);
              session.recordBashResult(effectiveCommand, result, { excludeFromContext });
            } else {
              result = await session.executeBash(effectiveCommand, onChunk, {
                excludeFromContext,
                ...(id === undefined ? {} : { id }),
                ...(intercepted?.operations === undefined ? {} : { operations: intercepted.operations }),
                ...(executionCwd === session.cwd ? {} : { cwd: executionCwd }),
              });
            }
            const runtimeHost = typeof session.hasExtensionHandlers === "function"
              && (session.hasExtensionHandlers("user_shell") || session.hasExtensionHandlers("event"))
              ? session.extensionRunner.getRuntimeHost()
              : undefined;
            if (runtimeHost !== undefined) {
              await runtimeHost.dispatch("event", {
                type: "user_shell",
                command: effectiveCommand,
                hidden: excludeFromContext,
                result: {
                  text: result.output,
                  exitCode: result.exitCode ?? null,
                  ...(result.isError === undefined ? {} : { isError: result.isError }),
                  cancelled: result.cancelled,
                  ...(result.timedOut === undefined ? {} : { timedOut: result.timedOut }),
                  ...(result.signal === undefined
                    ? result.cancelled ? { signal: "CANCELLED" } : {}
                    : { signal: result.signal }),
                  truncated: result.truncated,
                  ...(result.fullOutputPath === undefined ? {} : { fullOutputPath: result.fullOutputPath }),
                },
              });
            }
          } catch (error) {
            executionFailed = true;
            executionFailure = error;
          }
          await outputTail;
          if (executionFailed) throw executionFailure;
          if (outputFailure !== undefined) throw outputFailure;
          if (result === undefined) throw new Error("Bash execution did not return a result");
          return success(id, "bash", result);
        }
        case "abort_bash":
          this.#runtime.session.abortBash();
          return success(id, "abort_bash");
        case "get_session_stats":
          return success(id, "get_session_stats", this.#runtime.session.getSessionStats());
        case "export_html": {
          const selected = command as Extract<RpcCommand, { type: "export_html" }>;
          return success(id, "export_html", { path: await this.#runtime.session.exportToHtml(selected.outputPath) });
        }
        case "switch_session": {
          const selected = command as Extract<RpcCommand, { type: "switch_session" }>;
          return success(id, "switch_session", await this.#runtime.switchSession(selected.sessionPath));
        }
        case "fork": {
          const selected = command as Extract<RpcCommand, { type: "fork" }>;
          const canonicalId = canonicalRpcEntryId(this.#runtime.session, selected.entryId);
          if (canonicalId === undefined) return failure(id, "fork", `Entry not found: ${selected.entryId}`);
          const result = await this.#runtime.fork(canonicalId);
          return success(id, "fork", { text: result.selectedText ?? "", cancelled: result.cancelled });
        }
        case "clone": {
          const publicLeafId = publicSessionManager(this.#runtime.session).getLeafId();
          const leafId = publicLeafId === null
            ? null
            : canonicalRpcEntryId(this.#runtime.session, publicLeafId);
          if (leafId === null) return failure(id, "clone", "Cloning requires a selected session entry");
          if (leafId === undefined) return failure(id, "clone", `Entry not found: ${publicLeafId}`);
          const result = await this.#runtime.fork(leafId, { position: "at" });
          return success(id, "clone", { cancelled: result.cancelled });
        }
        case "get_fork_messages":
          return success(id, "get_fork_messages", { messages: this.#runtime.session.getUserMessagesForForking() });
        case "get_entries": {
          const selected = command as Extract<RpcCommand, { type: "get_entries" }>;
          const publicManager = publicSessionManager(this.#runtime.session);
          if (selected.since !== undefined && selected.afterSequence !== undefined) {
            return failure(id, "get_entries", "Use either since or afterSequence, not both");
          }
          const completeResponse = selected.since === undefined
            && selected.afterSequence === undefined
            && selected.limit === undefined;
          const limit = boundedEntryPageSize(selected.limit);
          let start = 0;
          let totalEntries: number;
          let candidates: PublicSessionEntry[];
          if (selected.since !== undefined) {
            const allEntries = publicManager.getEntries();
            const index = allEntries.findIndex((entry) => entry.id === selected.since);
            if (index < 0) return failure(id, "get_entries", `Entry not found: ${selected.since}`);
            start = index + 1;
            totalEntries = allEntries.length;
            candidates = allEntries.slice(start, start + limit);
          } else if (completeResponse) {
            candidates = publicManager.getEntries();
            totalEntries = candidates.length;
          } else {
            start = selected.afterSequence ?? 0;
            if (
              !Number.isSafeInteger(start)
              || start < 0
            ) return failure(id, "get_entries", "afterSequence is outside the session history");
            const page = publicEntryPage(publicManager, start, limit);
            totalEntries = page.totalEntries;
            if (start > totalEntries) {
              return failure(id, "get_entries", "afterSequence is outside the session history");
            }
            candidates = page.entries;
          }
          const entries = boundedHistoryItems("get_entries", candidates);
          if (completeResponse && entries.length !== candidates.length) {
            throw new Error("get_entries history is too large for one response; request bounded pages");
          }
          const nextSequence = start + entries.length;
          return success(id, "get_entries", {
            entries,
            leafId: publicManager.getLeafId(),
            sequenceStart: entries.length === 0 ? nextSequence : start + 1,
            nextSequence,
            hasMore: nextSequence < totalEntries,
            totalEntries,
          });
        }
        case "get_tree": {
          const selected = command as Extract<RpcCommand, { type: "get_tree" }>;
          const limit = boundedHistoryPageSize("get_tree", selected.limit);
          const completeResponse = selected.cursor === undefined && selected.limit === undefined;
          const publicManager = publicSessionManager(this.#runtime.session);
          const allEntries = completeResponse ? publicManager.getEntries() : undefined;
          const leafId = publicManager.getLeafId();
          const entryCount = allEntries?.length ?? publicEntryPage(publicManager, 0, 1).totalEntries;
          const snapshot = historySnapshot(
            this.#runtime.session.sessionId,
            leafId,
            entryCount,
            rpcTreeRevision(this.#runtime.session),
          );
          const offset = historyOffset("get_tree", "tree", selected.cursor, snapshot);
          if (offset > entryCount) throw new Error("get_tree cursor is outside the session history");
          const candidates = allEntries?.slice(offset) ?? publicEntryPage(publicManager, offset, limit).entries;
          const fragments = boundedHistoryItems("get_tree", candidates);
          if (completeResponse && fragments.length !== candidates.length) {
            throw new Error("get_tree history is too large for one response; request bounded pages");
          }
          const labels = new Map<string, Pick<PublicSessionTreeNode, "label">>();
          for (const entry of fragments) {
            const label = publicManager.getLabel(entry.id);
            if (label !== undefined) labels.set(entry.id, { label });
          }
          const tree = publicTreePage(fragments, labels);
          const nextOffset = offset + fragments.length;
          const hasMore = nextOffset < entryCount;
          return success(id, "get_tree", {
            tree,
            leafId,
            nextCursor: hasMore
              ? encodeHistoryCursor({ version: 1, resource: "tree", snapshot, offset: nextOffset })
              : null,
            hasMore,
            totalEntries: entryCount,
          });
        }
        case "get_last_assistant_text":
          return success(id, "get_last_assistant_text", { text: this.#runtime.session.getLastAssistantText() ?? null });
        case "set_session_name": {
          const selected = command as Extract<RpcCommand, { type: "set_session_name" }>;
          const name = selected.name.trim();
          if (name === "") return failure(id, "set_session_name", "A session name must contain text");
          this.#runtime.session.setSessionName(name);
          return success(id, "set_session_name");
        }
        case "get_messages": {
          const selected = command as Extract<RpcCommand, { type: "get_messages" }>;
          const limit = boundedHistoryPageSize("get_messages", selected.limit);
          const completeResponse = selected.cursor === undefined && selected.limit === undefined;
          const session = this.#runtime.session;
          const manager = publicSessionManager(session);
          const leafId = manager.getLeafId();
          const allMessages = publicContextMessages(session);
          const snapshot = historySnapshot(session.sessionId, leafId, allMessages.length);
          const offset = historyOffset("get_messages", "messages", selected.cursor, snapshot);
          if (offset > allMessages.length) throw new Error("get_messages cursor is outside the session history");
          const candidates = allMessages.slice(offset, completeResponse ? undefined : offset + limit);
          const messages = boundedHistoryItems("get_messages", candidates);
          if (completeResponse && messages.length !== candidates.length) {
            throw new Error("get_messages history is too large for one response; request bounded pages");
          }
          const nextOffset = offset + messages.length;
          const hasMore = nextOffset < allMessages.length;
          return success(id, "get_messages", {
            messages,
            nextCursor: hasMore
              ? encodeHistoryCursor({ version: 1, resource: "messages", snapshot, offset: nextOffset })
              : null,
            hasMore,
            totalMessages: allMessages.length,
          });
        }
        case "get_commands": {
          const session = this.#runtime.session;
          const commands: RpcSlashCommand[] = [
            ...extensionCommands(session.extensionRunner),
            ...session.promptTemplates.map((template) => ({
              name: template.name,
              ...(template.description === undefined ? {} : { description: template.description }),
              source: "prompt" as const,
              sourceInfo: template.sourceInfo,
            })),
            ...session.resourceLoader.getSkills().skills.map((skill) => ({
              name: `skill:${skill.name}`,
              description: skill.description,
              source: "skill" as const,
              sourceInfo: skill.sourceInfo,
            })),
          ];
          return success(id, "get_commands", { commands });
        }
        default:
          return failure(id, command.type, `Unknown command: ${command.type}`);
      }
    } catch (error) {
      return failure(id, command.type, error);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribeSession();
    this.#runtime.setBeforeSessionInvalidate(undefined);
    this.#runtime.setRebindSession(undefined);
  }

  async #runModelControl<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.#modelControlTail;
    let release!: () => void;
    this.#modelControlTail = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #rebind(session: AgentSession = this.#runtime.session): Promise<void> {
    const generation = ++this.#bindingGeneration;
    this.#unsubscribeSession();
    await this.#bindSession?.(session);
    if (generation !== this.#bindingGeneration || this.#closed) return;
    this.#unsubscribe = session.subscribe((event) => {
      // RPC owns a separately bounded and command-correlated bash stream.
      if (event.type === "bash_execution_update") return;
      return this.#output(event);
    });
  }

  #unsubscribeSession(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }
}
