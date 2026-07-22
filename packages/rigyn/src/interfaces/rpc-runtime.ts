import type { ExtensionRunner } from "../extensions/compat-runtime.js";
import type { AgentSession } from "../service/agent-session.js";
import type { AgentSessionRuntime } from "../service/agent-session-runtime.js";
import type { ProviderModelThinkingLevel } from "../providers/models.js";
import type { RpcUnknownCommand } from "./rpc.js";
import type { RpcCommand, RpcResponse, RpcSlashCommand } from "./rpc-protocol.js";

const DEFAULT_ENTRY_PAGE_SIZE = 512;
const MAX_ENTRY_PAGE_SIZE = 2_048;

function boundedEntryPageSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_ENTRY_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ENTRY_PAGE_SIZE) {
    throw new RangeError(`get_entries limit must be between 1 and ${MAX_ENTRY_PAGE_SIZE}`);
  }
  return value;
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
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function extensionCommands(runner: ExtensionRunner): RpcSlashCommand[] {
  return runner.getRegisteredCommands().map((command) => ({
    name: command.invocationName,
    ...(command.description === undefined ? {} : { description: command.description }),
    source: "extension" as const,
    sourceInfo: command.sourceInfo,
  }));
}

/** Executes direct command records and streams raw agent events to the same output. */
export class RpcRuntimeDispatcher {
  readonly #runtime: RpcSessionRuntime;
  readonly #output: RpcRuntimeDispatcherOptions["output"];
  readonly #bindSession: RpcRuntimeDispatcherOptions["bindSession"];
  #unsubscribe: (() => void) | undefined;
  #closed = false;

  constructor(options: RpcRuntimeDispatcherOptions) {
    this.#runtime = options.runtime;
    this.#output = options.output;
    this.#bindSession = options.bindSession;
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error("RPC dispatcher is closed");
    this.#runtime.setBeforeSessionInvalidate(() => this.#unsubscribeSession());
    this.#runtime.setRebindSession(async () => await this.#rebind());
    await this.#rebind();
  }

  async dispatch(command: RpcCommand | RpcUnknownCommand): Promise<RpcResponse | undefined> {
    if (this.#closed) return failure(command.id, command.type, "RPC dispatcher is closed");
    const id = command.id;
    try {
      switch (command.type) {
        case "prompt": {
          const selected = command as Extract<RpcCommand, { type: "prompt" }>;
          let acknowledged = false;
          void this.#runtime.session.prompt(selected.message, {
            ...(selected.images === undefined ? {} : { images: selected.images }),
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
          this.#runtime.session.steer(selected.message, selected.images);
          return success(id, "steer");
        }
        case "follow_up": {
          const selected = command as Extract<RpcCommand, { type: "follow_up" }>;
          this.#runtime.session.followUp(selected.message, selected.images);
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
        case "get_state": {
          const session = this.#runtime.session;
          const selected = session.model;
          const model = selected === undefined
            ? undefined
            : session.modelRegistry.find(selected.provider, selected.id);
          return success(id, "get_state", {
            ...(model === undefined ? {} : { model }),
            thinkingLevel: session.thinkingLevel,
            isStreaming: session.isStreaming,
            isCompacting: session.isCompacting,
            steeringMode: session.steeringMode,
            followUpMode: session.followUpMode,
            ...(session.sessionFile === undefined ? {} : { sessionFile: session.sessionFile }),
            sessionId: session.sessionId,
            ...(session.sessionName === undefined ? {} : { sessionName: session.sessionName }),
            autoCompactionEnabled: session.autoCompactionEnabled,
            messageCount: session.messages.length,
            pendingMessageCount: session.pendingMessageCount,
          });
        }
        case "set_model": {
          const selected = command as Extract<RpcCommand, { type: "set_model" }>;
          const models = await this.#runtime.session.modelRegistry.getAvailable();
          const model = models.find((candidate) => candidate.provider === selected.provider && candidate.id === selected.modelId);
          if (model === undefined) return failure(id, "set_model", `Model not found: ${selected.provider}/${selected.modelId}`);
          await this.#runtime.session.setModel(model);
          return success(id, "set_model", model);
        }
        case "cycle_model": {
          const result = await this.#runtime.session.cycleModel();
          return success(id, "cycle_model", result ?? null);
        }
        case "get_available_models":
          return success(id, "get_available_models", { models: await this.#runtime.session.modelRegistry.getAvailable() });
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
          const result = await this.#runtime.session.executeBash(selected.command, undefined, {
            ...(selected.excludeFromContext === undefined ? {} : { excludeFromContext: selected.excludeFromContext }),
          });
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
          const result = await this.#runtime.fork(selected.entryId);
          return success(id, "fork", { text: result.selectedText ?? "", cancelled: result.cancelled });
        }
        case "clone": {
          const leafId = this.#runtime.session.sessionManager.getLeafId();
          if (leafId === null) return failure(id, "clone", "Cannot clone session: no current entry selected");
          const result = await this.#runtime.fork(leafId, { position: "at" });
          return success(id, "clone", { cancelled: result.cancelled });
        }
        case "get_fork_messages":
          return success(id, "get_fork_messages", { messages: this.#runtime.session.getUserMessagesForForking() });
        case "get_entries": {
          const selected = command as Extract<RpcCommand, { type: "get_entries" }>;
          const manager = this.#runtime.session.sessionManager;
          const allEntries = manager.getEntries();
          if (selected.since !== undefined && selected.afterSequence !== undefined) {
            return failure(id, "get_entries", "Use either since or afterSequence, not both");
          }
          let start = 0;
          if (selected.since !== undefined) {
            const index = allEntries.findIndex((entry) => entry.id === selected.since);
            if (index < 0) return failure(id, "get_entries", `Entry not found: ${selected.since}`);
            start = index + 1;
          } else if (selected.afterSequence !== undefined) {
            if (
              !Number.isSafeInteger(selected.afterSequence)
              || selected.afterSequence < 0
              || selected.afterSequence > allEntries.length
            ) return failure(id, "get_entries", "afterSequence is outside the session history");
            start = selected.afterSequence;
          }
          const limit = boundedEntryPageSize(selected.limit);
          const entries = allEntries.slice(start, start + limit);
          const nextSequence = start + entries.length;
          return success(id, "get_entries", {
            entries,
            leafId: manager.getLeafId(),
            sequenceStart: entries.length === 0 ? nextSequence : start + 1,
            nextSequence,
            hasMore: nextSequence < allEntries.length,
            totalEntries: allEntries.length,
          });
        }
        case "get_tree": {
          const manager = this.#runtime.session.sessionManager;
          return success(id, "get_tree", { tree: manager.getTree(), leafId: manager.getLeafId() });
        }
        case "get_last_assistant_text":
          return success(id, "get_last_assistant_text", { text: this.#runtime.session.getLastAssistantText() ?? null });
        case "set_session_name": {
          const selected = command as Extract<RpcCommand, { type: "set_session_name" }>;
          const name = selected.name.trim();
          if (name === "") return failure(id, "set_session_name", "Session name cannot be empty");
          this.#runtime.session.setSessionName(name);
          return success(id, "set_session_name");
        }
        case "get_messages":
          return success(id, "get_messages", { messages: this.#runtime.session.messages });
        case "get_commands": {
          const session = this.#runtime.session;
          const commands: RpcSlashCommand[] = [
            ...extensionCommands(session.extensionRunner),
            ...session.promptTemplates.map((template) => ({
              name: template.name,
              description: template.description,
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

  async #rebind(): Promise<void> {
    this.#unsubscribeSession();
    await this.#bindSession?.(this.#runtime.session);
    this.#unsubscribe = this.#runtime.session.subscribe((event) => this.#output(event));
  }

  #unsubscribeSession(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }
}
