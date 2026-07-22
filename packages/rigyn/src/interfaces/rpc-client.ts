import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { RuntimeEvent } from "../core/events.js";
import type { ImageBlock } from "../core/types.js";
import type { ProviderModelThinkingLevel } from "../providers/models.js";
import type { CompactionResult } from "../extensions/direct.js";
import type { AgentSessionBashResult, AgentSessionStats } from "../service/agent-session.js";
import type { SessionContextMessage, SessionTreeNode } from "../storage/types.js";
import { attachJsonlLineReader, serializeJsonLine } from "./rpc.js";
import type {
  RpcCommand,
  RpcEntryPage,
  RpcExtensionUiRequest,
  RpcResponse,
  RpcSessionState,
  RpcSlashCommand,
} from "./rpc-protocol.js";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

export interface RpcClientOptions {
  /** Path to the compiled CLI entry point. */
  cliPath?: string;
  cwd?: string;
  env?: Record<string, string>;
  provider?: string;
  model?: string;
  args?: string[];
}

export type RpcStreamEvent =
  | RuntimeEvent
  | RpcExtensionUiRequest
  | { type: "agent_end" | "agent_settled"; [key: string]: unknown }
  | Record<string, unknown>;
export type RpcEventListener = (event: RpcStreamEvent) => void;

interface PendingRequest {
  resolve(response: RpcResponse): void;
  reject(error: Error): void;
}

export class RpcClient {
  #process: ChildProcess | undefined;
  #stopReading: (() => void) | undefined;
  readonly #listeners: RpcEventListener[] = [];
  readonly #pending = new Map<string, PendingRequest>();
  #requestId = 0;
  #stderr = "";
  #exitError: Error | undefined;
  readonly #options: RpcClientOptions;

  constructor(options: RpcClientOptions = {}) {
    this.#options = options;
  }

  get started(): boolean { return this.#process !== undefined; }
  get pendingRequestCount(): number { return this.#pending.size; }

  async start(): Promise<void> {
    if (this.#process !== undefined) throw new Error("Client already started");
    this.#exitError = undefined;
    this.#stderr = "";
    const cliPath = this.#options.cliPath ?? fileURLToPath(new URL("../bin/rigyn.js", import.meta.url));
    const args = [cliPath, "--mode", "rpc"];
    if (this.#options.provider !== undefined) args.push("--provider", this.#options.provider);
    if (this.#options.model !== undefined) args.push("--model", this.#options.model);
    if (this.#options.args !== undefined) args.push(...this.#options.args);
    const child = spawn(process.execPath, args, {
      cwd: this.#options.cwd,
      env: { ...process.env, ...this.#options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#process = child;
    child.stderr?.on("data", (data: Buffer | string) => {
      this.#stderr += data.toString();
    });
    child.once("exit", (code, signal) => {
      if (this.#process !== child) return;
      const error = this.#createProcessExitError(code, signal);
      this.#exitError = error;
      this.#rejectPending(error);
    });
    child.once("error", (source) => {
      if (this.#process !== child) return;
      const error = new Error(`Agent process error: ${source.message}. Stderr: ${this.#stderr}`);
      this.#exitError = error;
      this.#rejectPending(error);
    });
    child.stdin?.on("error", (source) => {
      if (this.#process !== child) return;
      const error = this.#exitError ?? new Error(`Agent process stdin error: ${source.message}. Stderr: ${this.#stderr}`);
      this.#exitError = error;
      this.#rejectPending(error);
    });
    if (child.stdout === null) throw new Error("Agent process stdout is unavailable");
    this.#stopReading = attachJsonlLineReader(child.stdout, (line) => this.#handleLine(line));
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    if (child.exitCode !== null) {
      const error = this.#exitError ?? this.#createProcessExitError(child.exitCode, child.signalCode);
      this.#exitError = error;
      throw error;
    }
  }

  async stop(): Promise<void> {
    const child = this.#process;
    if (child === undefined) return;
    this.#stopReading?.();
    this.#stopReading = undefined;
    const exited = child.exitCode !== null || child.signalCode !== null;
    if (!exited) child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 1_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (this.#process === child) this.#process = undefined;
    this.#rejectPending(new Error("RPC client stopped"));
  }

  onEvent(listener: RpcEventListener): () => void {
    this.#listeners.push(listener);
    return () => {
      const index = this.#listeners.indexOf(listener);
      if (index >= 0) this.#listeners.splice(index, 1);
    };
  }

  getStderr(): string { return this.#stderr; }

  async prompt(message: string, images?: ImageBlock[], streamingBehavior?: "steer" | "followUp"): Promise<void> {
    await this.#send({
      type: "prompt",
      message,
      ...(images === undefined ? {} : { images }),
      ...(streamingBehavior === undefined ? {} : { streamingBehavior }),
    });
  }

  async steer(message: string, images?: ImageBlock[]): Promise<void> {
    await this.#send({ type: "steer", message, ...(images === undefined ? {} : { images }) });
  }

  async followUp(message: string, images?: ImageBlock[]): Promise<void> {
    await this.#send({ type: "follow_up", message, ...(images === undefined ? {} : { images }) });
  }

  async abort(): Promise<void> { await this.#send({ type: "abort" }); }

  async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
    return this.#data(await this.#send({ type: "new_session", ...(parentSession === undefined ? {} : { parentSession }) }));
  }

  async getState(): Promise<RpcSessionState> { return this.#data(await this.#send({ type: "get_state" })); }

  async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
    return this.#data(await this.#send({ type: "set_model", provider, modelId }));
  }

  async cycleModel(): Promise<{
    model: { provider: string; id: string };
    thinkingLevel: ProviderModelThinkingLevel;
    isScoped: boolean;
  } | null> {
    return this.#data(await this.#send({ type: "cycle_model" }));
  }

  async getAvailableModels(): Promise<Array<{ provider: string; id: string; contextWindow: number; reasoning: boolean }>> {
    return this.#data<{ models: Array<{ provider: string; id: string; contextWindow: number; reasoning: boolean }> }>(
      await this.#send({ type: "get_available_models" }),
    ).models;
  }

  async setThinkingLevel(level: ProviderModelThinkingLevel): Promise<void> {
    await this.#send({ type: "set_thinking_level", level });
  }

  async cycleThinkingLevel(): Promise<{ level: ProviderModelThinkingLevel } | null> {
    return this.#data(await this.#send({ type: "cycle_thinking_level" }));
  }

  async getAvailableThinkingLevels(): Promise<ProviderModelThinkingLevel[]> {
    return this.#data<{ levels: ProviderModelThinkingLevel[] }>(
      await this.#send({ type: "get_available_thinking_levels" }),
    ).levels;
  }

  async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
    await this.#send({ type: "set_steering_mode", mode });
  }

  async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
    await this.#send({ type: "set_follow_up_mode", mode });
  }

  async compact(customInstructions?: string): Promise<CompactionResult> {
    return this.#data(await this.#send({ type: "compact", ...(customInstructions === undefined ? {} : { customInstructions }) }));
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.#send({ type: "set_auto_compaction", enabled });
  }

  async setAutoRetry(enabled: boolean): Promise<void> { await this.#send({ type: "set_auto_retry", enabled }); }
  async abortRetry(): Promise<void> { await this.#send({ type: "abort_retry" }); }

  async bash(command: string, excludeFromContext?: boolean): Promise<AgentSessionBashResult> {
    return this.#data(await this.#send({ type: "bash", command, ...(excludeFromContext === undefined ? {} : { excludeFromContext }) }));
  }

  async abortBash(): Promise<void> { await this.#send({ type: "abort_bash" }); }
  async getSessionStats(): Promise<AgentSessionStats> { return this.#data(await this.#send({ type: "get_session_stats" })); }

  async exportHtml(outputPath?: string): Promise<{ path: string }> {
    return this.#data(await this.#send({ type: "export_html", ...(outputPath === undefined ? {} : { outputPath }) }));
  }

  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    return this.#data(await this.#send({ type: "switch_session", sessionPath }));
  }

  async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
    return this.#data(await this.#send({ type: "fork", entryId }));
  }

  async clone(): Promise<{ cancelled: boolean }> { return this.#data(await this.#send({ type: "clone" })); }

  async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
    return this.#data<{ messages: Array<{ entryId: string; text: string }> }>(
      await this.#send({ type: "get_fork_messages" }),
    ).messages;
  }

  async getEntries(
    cursor?: string | { since?: string; afterSequence?: number; limit?: number },
  ): Promise<RpcEntryPage> {
    const options = typeof cursor === "string" ? { since: cursor } : cursor;
    return this.#data(await this.#send({ type: "get_entries", ...options }));
  }

  async getTree(): Promise<{ tree: SessionTreeNode[]; leafId: string | null }> {
    return this.#data(await this.#send({ type: "get_tree" }));
  }

  async getLastAssistantText(): Promise<string | null> {
    return this.#data<{ text: string | null }>(await this.#send({ type: "get_last_assistant_text" })).text;
  }

  async setSessionName(name: string): Promise<void> { await this.#send({ type: "set_session_name", name }); }

  async getMessages(): Promise<SessionContextMessage[]> {
    return this.#data<{ messages: SessionContextMessage[] }>(await this.#send({ type: "get_messages" })).messages;
  }

  async getCommands(): Promise<RpcSlashCommand[]> {
    return this.#data<{ commands: RpcSlashCommand[] }>(await this.#send({ type: "get_commands" })).commands;
  }

  waitForIdle(timeout = 60_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.#stderr}`));
      }, timeout);
      const unsubscribe = this.onEvent((event) => {
        if (event.type !== "agent_settled") return;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      });
    });
  }

  collectEvents(timeout = 60_000): Promise<RpcStreamEvent[]> {
    return new Promise((resolve, reject) => {
      const events: RpcStreamEvent[] = [];
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timeout collecting events. Stderr: ${this.#stderr}`));
      }, timeout);
      const unsubscribe = this.onEvent((event) => {
        events.push(event);
        if (event.type !== "agent_settled") return;
        clearTimeout(timer);
        unsubscribe();
        resolve(events);
      });
    });
  }

  async promptAndWait(message: string, images?: ImageBlock[], timeout = 60_000): Promise<RpcStreamEvent[]> {
    const events = this.collectEvents(timeout);
    await this.prompt(message, images);
    return await events;
  }

  #handleLine(line: string): void {
    try {
      const data = JSON.parse(line) as Record<string, unknown>;
      if (data.type === "response" && typeof data.id === "string" && this.#pending.has(data.id)) {
        const pending = this.#pending.get(data.id)!;
        this.#pending.delete(data.id);
        pending.resolve(data as unknown as RpcResponse);
        return;
      }
      for (const listener of this.#listeners) listener(data as RpcStreamEvent);
    } catch {
      // Non-JSON output is not part of the machine protocol.
    }
  }

  #createProcessExitError(code: number | null, signal: NodeJS.Signals | null): Error {
    return new Error(`Agent process exited (code=${code} signal=${signal}). Stderr: ${this.#stderr}`);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  async #send(command: RpcCommandBody): Promise<RpcResponse> {
    const child = this.#process;
    const input = child?.stdin;
    if (child === undefined || input === null || input === undefined) throw new Error("Client not started");
    if (this.#exitError !== undefined) throw this.#exitError;
    if (child.exitCode !== null) {
      const error = this.#createProcessExitError(child.exitCode, child.signalCode);
      this.#exitError = error;
      throw error;
    }
    if (input.destroyed || !input.writable) {
      const error = new Error(`Agent process stdin is not writable. Stderr: ${this.#stderr}`);
      this.#exitError = error;
      throw error;
    }
    const id = `req_${++this.#requestId}`;
    const full = { ...command, id } as RpcCommand;
    return await new Promise<RpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.#stderr}`));
      }, 30_000);
      this.#pending.set(id, {
        resolve(response) { clearTimeout(timeout); resolve(response); },
        reject(error) { clearTimeout(timeout); reject(error); },
      });
      try {
        input.write(serializeJsonLine(full));
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #data<T>(response: RpcResponse): T {
    if (!response.success) throw new Error(response.error);
    return (response as Extract<RpcResponse, { success: true; data: unknown }>).data as T;
  }
}
