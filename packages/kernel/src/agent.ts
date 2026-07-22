import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.js";
import { getDefaultStreamFn } from "./stream-fn.js";
import type { ImageContent, Message, Model, SimpleStreamOptions, TextContent, ThinkingBudgets, Transport } from "@rigyn/models";
import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentLoopTurnUpdate,
  AgentMessage,
  AgentState,
  BeforeToolCallContext,
  BeforeToolCallResult,
  PrepareNextTurnContext,
  QueueMode,
  StreamFn,
  ToolExecutionMode,
} from "./types.js";

export type { QueueMode } from "./types.js";

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const DEFAULT_MODEL: Model = {
  id: "unknown",
  name: "unknown",
  api: "unknown",
  provider: "unknown",
  baseUrl: "",
  reasoning: false,
  input: [],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 0,
  maxTokens: 0,
};

function defaultConvert(messages: AgentMessage[]): Message[] {
  return messages.filter((message): message is Message => message.role === "user" || message.role === "assistant" || message.role === "toolResult");
}

type MutableState = Omit<AgentState, "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"> & {
  isStreaming: boolean;
  streamingMessage?: AgentMessage;
  pendingToolCalls: Set<string>;
  errorMessage?: string;
};

function makeState(initial?: AgentOptions["initialState"]): MutableState {
  let tools = initial?.tools?.slice() ?? [];
  let messages = initial?.messages?.slice() ?? [];
  return {
    systemPrompt: initial?.systemPrompt ?? "",
    model: initial?.model ?? DEFAULT_MODEL,
    thinkingLevel: initial?.thinkingLevel ?? "off",
    get tools() { return tools; },
    set tools(value) { tools = value.slice(); },
    get messages() { return messages; },
    set messages(value) { messages = value.slice(); },
    isStreaming: false,
    pendingToolCalls: new Set(),
  };
}

interface AgentOptionsBase {
  initialState?: Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>;
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  onPayload?: SimpleStreamOptions["onPayload"];
  onResponse?: SimpleStreamOptions["onResponse"];
  beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
  prepareNextTurn?: (signal?: AbortSignal) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
  prepareNextTurnWithContext?: (context: PrepareNextTurnContext, signal?: AbortSignal) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  sessionId?: string;
  thinkingBudgets?: ThinkingBudgets;
  transport?: Transport;
  maxRetryDelayMs?: number;
  toolExecution?: ToolExecutionMode;
}

/** Options for constructing an Agent. `streamFn` is canonical; `streamFunction` remains source-compatible. */
export type AgentOptions = AgentOptionsBase & (
  | { streamFn: StreamFn; streamFunction?: StreamFn }
  | { streamFn?: StreamFn; streamFunction: StreamFn }
);

class PendingQueue {
  #messages: AgentMessage[] = [];
  mode: QueueMode;
  constructor(mode: QueueMode) { this.mode = mode; }
  enqueue(message: AgentMessage): void { this.#messages.push(message); }
  hasItems(): boolean { return this.#messages.length > 0; }
  clear(): void { this.#messages = []; }
  drain(): AgentMessage[] {
    if (this.mode === "all") return this.#messages.splice(0);
    return this.#messages.length > 0 ? this.#messages.splice(0, 1) : [];
  }
}

interface ActiveRun {
  promise: Promise<void>;
  resolve(): void;
  abortController: AbortController;
}

export class Agent {
  readonly #state: MutableState;
  readonly #listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
  readonly #steering: PendingQueue;
  readonly #followUps: PendingQueue;
  #active: ActiveRun | undefined;

  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext: ((messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>) | undefined;
  streamFunction: StreamFn;
  getApiKey: ((provider: string) => Promise<string | undefined> | string | undefined) | undefined;
  onPayload: SimpleStreamOptions["onPayload"] | undefined;
  onResponse: SimpleStreamOptions["onResponse"] | undefined;
  beforeToolCall: AgentOptions["beforeToolCall"] | undefined;
  afterToolCall: AgentOptions["afterToolCall"] | undefined;
  prepareNextTurn: AgentOptions["prepareNextTurn"] | undefined;
  prepareNextTurnWithContext: AgentOptions["prepareNextTurnWithContext"] | undefined;
  sessionId: string | undefined;
  thinkingBudgets: ThinkingBudgets | undefined;
  transport: Transport;
  maxRetryDelayMs: number | undefined;
  toolExecution: ToolExecutionMode;

  constructor(options: AgentOptions) {
    // Compiled consumers using the legacy option can omit the renamed option. Hosts may install
    // the provider-neutral fallback without coupling this package to a catalog.
    const runtimeOptions = (options ?? {}) as Partial<AgentOptionsBase> & {
      streamFn?: StreamFn;
      streamFunction?: StreamFn;
    };
    this.#state = makeState(runtimeOptions.initialState);
    this.convertToLlm = runtimeOptions.convertToLlm ?? defaultConvert;
    this.transformContext = runtimeOptions.transformContext;
    this.streamFunction = runtimeOptions.streamFn ?? runtimeOptions.streamFunction ?? getDefaultStreamFn();
    this.getApiKey = runtimeOptions.getApiKey;
    this.onPayload = runtimeOptions.onPayload;
    this.onResponse = runtimeOptions.onResponse;
    this.beforeToolCall = runtimeOptions.beforeToolCall;
    this.afterToolCall = runtimeOptions.afterToolCall;
    this.prepareNextTurn = runtimeOptions.prepareNextTurn;
    this.prepareNextTurnWithContext = runtimeOptions.prepareNextTurnWithContext;
    this.#steering = new PendingQueue(runtimeOptions.steeringMode ?? "one-at-a-time");
    this.#followUps = new PendingQueue(runtimeOptions.followUpMode ?? "one-at-a-time");
    this.sessionId = runtimeOptions.sessionId;
    this.thinkingBudgets = runtimeOptions.thinkingBudgets;
    this.transport = runtimeOptions.transport ?? "auto";
    this.maxRetryDelayMs = runtimeOptions.maxRetryDelayMs;
    this.toolExecution = runtimeOptions.toolExecution ?? "parallel";
  }

  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get state(): AgentState { return this.#state; }
  set steeringMode(mode: QueueMode) { this.#steering.mode = mode; }
  get steeringMode(): QueueMode { return this.#steering.mode; }
  set followUpMode(mode: QueueMode) { this.#followUps.mode = mode; }
  get followUpMode(): QueueMode { return this.#followUps.mode; }
  steer(message: AgentMessage): void { this.#steering.enqueue(message); }
  followUp(message: AgentMessage): void { this.#followUps.enqueue(message); }
  clearSteeringQueue(): void { this.#steering.clear(); }
  clearFollowUpQueue(): void { this.#followUps.clear(); }
  clearAllQueues(): void { this.clearSteeringQueue(); this.clearFollowUpQueue(); }
  hasQueuedMessages(): boolean { return this.#steering.hasItems() || this.#followUps.hasItems(); }
  get signal(): AbortSignal | undefined { return this.#active?.abortController.signal; }
  abort(): void { this.#active?.abortController.abort(); }
  waitForIdle(): Promise<void> { return this.#active?.promise ?? Promise.resolve(); }

  reset(): void {
    this.#state.messages = [];
    this.#state.isStreaming = false;
    delete this.#state.streamingMessage;
    this.#state.pendingToolCalls = new Set();
    delete this.#state.errorMessage;
    this.clearAllQueues();
  }

  async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
  async prompt(input: string, images?: ImageContent[]): Promise<void>;
  async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
    if (this.#active) throw new Error("Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.");
    const messages = this.#normalize(input, images);
    await this.#run((signal) => runAgentLoop(messages, this.#snapshot(), this.#config(), (event) => this.#process(event), signal, this.streamFunction).then(() => undefined));
  }

  async continue(): Promise<void> {
    if (this.#active) throw new Error("Agent is already processing. Wait for completion before continuing.");
    const last = this.#state.messages.at(-1);
    if (!last) throw new Error("No messages to continue from");
    if (last.role === "assistant") {
      const steering = this.#steering.drain();
      if (steering.length > 0) {
        await this.#runPromptMessages(steering, true);
        return;
      }
      const followUps = this.#followUps.drain();
      if (followUps.length > 0) {
        await this.#runPromptMessages(followUps, false);
        return;
      }
      throw new Error("Cannot continue from message role: assistant");
    }
    await this.#run((signal) => runAgentLoopContinue(this.#snapshot(), this.#config(), (event) => this.#process(event), signal, this.streamFunction).then(() => undefined));
  }

  #normalize(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): AgentMessage[] {
    if (Array.isArray(input)) return input;
    if (typeof input !== "string") return [input];
    const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }, ...(images ?? [])];
    return [{ role: "user", content, timestamp: Date.now() }];
  }

  async #runPromptMessages(messages: AgentMessage[], skipFirstSteering: boolean): Promise<void> {
    await this.#run((signal) => runAgentLoop(messages, this.#snapshot(), this.#config(skipFirstSteering), (event) => this.#process(event), signal, this.streamFunction).then(() => undefined));
  }

  #snapshot(): AgentContext {
    return { systemPrompt: this.#state.systemPrompt, messages: this.#state.messages.slice(), tools: this.#state.tools.slice() };
  }

  #config(skipFirstSteering = false): AgentLoopConfig {
    let skip = skipFirstSteering;
    const config: AgentLoopConfig = {
      model: this.#state.model,
      transport: this.transport,
      toolExecution: this.toolExecution,
      ...(this.#state.thinkingLevel === "off" ? {} : { reasoning: this.#state.thinkingLevel }),
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
      ...(this.onPayload === undefined ? {} : { onPayload: this.onPayload }),
      ...(this.onResponse === undefined ? {} : { onResponse: this.onResponse }),
      ...(this.thinkingBudgets === undefined ? {} : { thinkingBudgets: this.thinkingBudgets }),
      ...(this.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: this.maxRetryDelayMs }),
      ...(this.beforeToolCall === undefined ? {} : { beforeToolCall: this.beforeToolCall }),
      ...(this.afterToolCall === undefined ? {} : { afterToolCall: this.afterToolCall }),
      ...(this.prepareNextTurnWithContext || this.prepareNextTurn ? { prepareNextTurn:
        async (context: PrepareNextTurnContext) => this.prepareNextTurnWithContext
          ? this.prepareNextTurnWithContext(context, this.signal)
          : this.prepareNextTurn?.(this.signal)
        } : {}),
      convertToLlm: this.convertToLlm,
      ...(this.transformContext === undefined ? {} : { transformContext: this.transformContext }),
      ...(this.getApiKey === undefined ? {} : { getApiKey: this.getApiKey }),
      getSteeringMessages: async () => {
        if (skip) { skip = false; return []; }
        return this.#steering.drain();
      },
      getFollowUpMessages: async () => this.#followUps.drain(),
    };
    return config;
  }

  async #run(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.#active) throw new Error("Agent is already processing.");
    const abortController = new AbortController();
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    this.#active = { promise, resolve, abortController };
    this.#state.isStreaming = true;
    delete this.#state.streamingMessage;
    delete this.#state.errorMessage;
    try {
      await executor(abortController.signal);
    } catch (error) {
      await this.#failure(error, abortController.signal.aborted);
    } finally {
      this.#state.isStreaming = false;
      delete this.#state.streamingMessage;
      this.#state.pendingToolCalls = new Set();
      this.#active.resolve();
      this.#active = undefined;
    }
  }

  async #failure(error: unknown, aborted: boolean): Promise<void> {
    const message: AgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: this.#state.model.api,
      provider: this.#state.model.provider,
      model: this.#state.model.id,
      usage: EMPTY_USAGE,
      stopReason: aborted ? "aborted" : "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    };
    await this.#process({ type: "message_start", message });
    await this.#process({ type: "message_end", message });
    await this.#process({ type: "turn_end", message, toolResults: [] });
    await this.#process({ type: "agent_end", messages: [message] });
  }

  async #process(event: AgentEvent): Promise<void> {
    if (event.type === "message_start" || event.type === "message_update") this.#state.streamingMessage = event.message;
    else if (event.type === "message_end") {
      delete this.#state.streamingMessage;
      this.#state.messages.push(event.message);
    } else if (event.type === "tool_execution_start") {
      this.#state.pendingToolCalls = new Set(this.#state.pendingToolCalls).add(event.toolCallId);
    } else if (event.type === "tool_execution_end") {
      const pending = new Set(this.#state.pendingToolCalls);
      pending.delete(event.toolCallId);
      this.#state.pendingToolCalls = pending;
    } else if (event.type === "turn_end" && event.message.role === "assistant" && event.message.errorMessage) {
      this.#state.errorMessage = event.message.errorMessage;
    } else if (event.type === "agent_end") delete this.#state.streamingMessage;
    const signal = this.#active?.abortController.signal;
    if (!signal) throw new Error("Agent listener invoked outside active run");
    for (const listener of this.#listeners) await listener(event, signal);
  }
}
