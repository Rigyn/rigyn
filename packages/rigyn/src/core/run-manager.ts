import type {
  AgentRunRequest,
  AgentRunResult,
  QueuedRunDeliveryReceipt,
  QueuedRunMessage,
  QueueMode,
} from "./agent.js";
import { AgentRunner, cloneQueuedRunMessage, RunControl } from "./agent.js";
import type { ImageBlock } from "./types.js";

interface ActiveRun {
  control: RunControl;
  branch?: string;
  promise?: Promise<AgentRunResult[]>;
}

interface RefreshedRunContext {
  initialMessages: NonNullable<AgentRunRequest["initialMessages"]>;
  systemPrompt: string;
  promptComposition?: AgentRunRequest["promptComposition"];
}

type RunContextRefresher = () => Promise<RefreshedRunContext>;

function cloneQueuedMessage(message: QueuedRunMessage): QueuedRunMessage {
  return cloneQueuedRunMessage(message);
}

function setQueuedResult(result: AgentRunResult, messages: readonly QueuedRunMessage[]): void {
  result.queuedMessages = messages.map(cloneQueuedMessage);
  result.queuedFollowUps = messages.map((message) => message.text);
}

export class ThreadRunManager {
  readonly #runner: AgentRunner;
  readonly #active = new Map<string, ActiveRun>();

  constructor(runner: AgentRunner) {
    this.#runner = runner;
  }

  start(request: AgentRunRequest, refreshContext?: RunContextRefresher): Promise<AgentRunResult[]> {
    this.reserve(request.threadId, {
      ...(request.steeringMode === undefined ? {} : { steeringMode: request.steeringMode }),
      ...(request.followUpMode === undefined ? {} : { followUpMode: request.followUpMode }),
    }, request.branch);
    return this.startReserved(request, refreshContext);
  }

  reserve(
    threadId: string,
    modes: { steeringMode?: QueueMode; followUpMode?: QueueMode } = {},
    branch?: string,
  ): RunControl {
    if (this.#active.has(threadId)) throw new Error(`Thread already has an active run: ${threadId}`);
    const control = new RunControl(modes);
    this.#active.set(threadId, { control, ...(branch === undefined ? {} : { branch }) });
    return control;
  }

  startReserved(request: AgentRunRequest, refreshContext?: RunContextRefresher): Promise<AgentRunResult[]> {
    const active = this.#active.get(request.threadId);
    if (active === undefined) throw new Error(`Thread has no reserved run: ${request.threadId}`);
    if (active.promise !== undefined) throw new Error(`Thread already has an active run: ${request.threadId}`);
    const promise = this.#runQueue(request, active.control, refreshContext).finally(() => {
      if (this.#active.get(request.threadId) === active) this.#active.delete(request.threadId);
    });
    active.promise = promise;
    return promise;
  }

  release(threadId: string): QueuedRunMessage[] {
    const active = this.#active.get(threadId);
    if (active === undefined || active.promise !== undefined) return [];
    this.#active.delete(threadId);
    return active.control.closeQueue();
  }

  steer(
    threadId: string,
    message: string,
    images?: ImageBlock[],
    receipt?: QueuedRunDeliveryReceipt,
  ): void {
    const active = this.#active.get(threadId);
    if (active === undefined) throw new Error(`Thread has no active run: ${threadId}`);
    active.control.steer(message, images, receipt);
  }

  followUp(
    threadId: string,
    message: string,
    images?: ImageBlock[],
    receipt?: QueuedRunDeliveryReceipt,
  ): void {
    const active = this.#active.get(threadId);
    if (active === undefined) throw new Error(`Thread has no active run: ${threadId}`);
    active.control.followUp(message, images, receipt);
  }

  queuedMessages(threadId: string): QueuedRunMessage[] {
    return this.#active.get(threadId)?.control.queuedMessages() ?? [];
  }

  queueModes(threadId: string): { steeringMode: QueueMode; followUpMode: QueueMode } | undefined {
    const control = this.#active.get(threadId)?.control;
    return control === undefined
      ? undefined
      : { steeringMode: control.steeringMode, followUpMode: control.followUpMode };
  }

  activeBranch(threadId: string): string | undefined {
    return this.#active.get(threadId)?.branch;
  }

  setQueueModes(
    threadId: string,
    modes: { steeringMode?: QueueMode; followUpMode?: QueueMode },
  ): { steeringMode: QueueMode; followUpMode: QueueMode } {
    const control = this.#active.get(threadId)?.control;
    if (control === undefined) throw new Error(`Thread has no active run: ${threadId}`);
    control.setQueueModes(modes);
    return { steeringMode: control.steeringMode, followUpMode: control.followUpMode };
  }

  dequeue(threadId: string): QueuedRunMessage[] {
    return this.#active.get(threadId)?.control.dequeueAndAcknowledge() ?? [];
  }

  dequeueOne(threadId: string): QueuedRunMessage | undefined {
    return this.#active.get(threadId)?.control.dequeueOneAndAcknowledge();
  }

  leaseOne(threadId: string): QueuedRunMessage | undefined {
    return this.#active.get(threadId)?.control.dequeueOneAndLease();
  }

  cancel(threadId: string, reason?: string): void {
    const active = this.#active.get(threadId);
    if (active === undefined) return;
    active.control.cancel(reason);
  }

  cancelRetry(threadId: string): boolean {
    return this.#active.get(threadId)?.control.cancelRetry() ?? false;
  }

  setAutoRetryEnabled(enabled: boolean): void {
    for (const active of this.#active.values()) active.control.setAutoRetryEnabled(enabled);
  }

  active(threadId: string): boolean {
    return this.#active.has(threadId);
  }

  activeCount(): number {
    return this.#active.size;
  }

  async waitForIdle(threadId: string, signal?: AbortSignal): Promise<void> {
    while (true) {
      signal?.throwIfAborted();
      const active = this.#active.get(threadId);
      if (active === undefined) return;
      if (active.promise === undefined) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        continue;
      }
      await Promise.race([
        active.promise.then(() => undefined, () => undefined),
        signal === undefined
          ? new Promise<void>(() => {})
          : new Promise<void>((_resolve, reject) => {
              const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Idle wait cancelled"));
              signal.addEventListener("abort", abort, { once: true });
              void active.promise?.finally(() => signal.removeEventListener("abort", abort)).catch(() => undefined);
            }),
      ]);
    }
  }

  async #runQueue(
    request: AgentRunRequest,
    control: RunControl,
    refreshContext?: RunContextRefresher,
  ): Promise<AgentRunResult[]> {
    const results: AgentRunResult[] = [];
    const {
      prompt: initialPrompt,
      images: initialImages,
      queuedPrompts: initialQueuedPrompts,
      queuedPromptMessages: initialQueuedPromptMessages,
      promptQueueMessage: initialPromptQueueMessage,
      ...initialBaseRequest
    } = request;
    let baseRequest = initialBaseRequest;
    let prompt = initialPrompt;
    let images = initialImages;
    let promptQueueMessage = initialPromptQueueMessage;
    let queuedPromptMessages: QueuedRunMessage[] = [
      ...(initialQueuedPrompts ?? []).map((text): QueuedRunMessage => ({ mode: "follow_up", text })),
      ...(initialQueuedPromptMessages ?? []).map(cloneQueuedMessage),
    ];
    let refreshBeforeTurn = false;
    while (true) {
      if (refreshBeforeTurn && refreshContext !== undefined) {
        const refreshed = await refreshContext();
        const { promptComposition: _previousPromptComposition, ...baseWithoutPromptComposition } = baseRequest;
        baseRequest = {
          ...baseWithoutPromptComposition,
          initialMessages: refreshed.initialMessages,
          systemPrompt: refreshed.systemPrompt,
          ...(refreshed.promptComposition === undefined ? {} : { promptComposition: refreshed.promptComposition }),
        };
      }
      const result = await this.#runner.run({
        ...baseRequest,
        prompt,
        ...(images === undefined ? {} : { images }),
        ...(promptQueueMessage === undefined ? {} : { promptQueueMessage }),
        ...(queuedPromptMessages.length === 0 ? {} : { queuedPromptMessages }),
      }, control, results.length > 0);
      results.push(result);
      const pending = [
        ...result.queuedMessages.map((message): QueuedRunMessage => {
          const cloned = cloneQueuedMessage(message);
          cloned.mode = "follow_up";
          return cloned;
        }),
        ...control.dequeue(),
      ];
      setQueuedResult(result, pending);
      if (result.finishReason === "cancelled") {
        pending.push(...control.closeQueue());
        setQueuedResult(result, pending);
        return results;
      }
      const next = control.followUpMode === "all" ? pending.splice(0) : pending.splice(0, 1);
      if (next.length === 0) {
        pending.push(...control.closeQueue());
        setQueuedResult(result, pending);
        return results;
      }
      setQueuedResult(result, pending);
      for (const remaining of pending) control.enqueue(remaining);
      prompt = next[0]!.text;
      images = next[0]!.images;
      promptQueueMessage = next[0];
      queuedPromptMessages = next.slice(1).map(cloneQueuedMessage);
      refreshBeforeTurn = true;
    }
  }
}
