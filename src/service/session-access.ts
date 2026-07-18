import type {
  EventEnvelope,
  RuntimeEvent,
} from "../core/events.js";
import type { ExtensionMessageEvent, ExtensionStateEvent } from "../core/extension-entries.js";
import type { ImageBlock, ProviderId } from "../core/types.js";
import { withRuntimeChildThreadCreation, type SessionStore } from "../storage/store.js";
import type {
  ArtifactRecord,
  BranchRecord,
  RunInputQueueRecord,
  RunInputQueueState,
  RunRecord,
  ThreadMetadataPage,
  ThreadRecord,
} from "../storage/types.js";
import {
  cloneSessionPath,
  type CloneSessionPathInput,
  type CloneSessionPathResult,
} from "./session-clone.js";
import { buildSessionTree, type SessionTreeRow } from "./session-tree.js";

export interface WorkspaceSessionSnapshotInput {
  threadId: string;
  branch?: string;
  include?: {
    events?: boolean;
    branchEvents?: boolean | readonly string[];
    runs?: boolean;
    artifacts?: boolean;
    runInputStates?: readonly RunInputQueueState[];
    modelSelection?: boolean;
  };
}

export interface WorkspaceSessionSnapshot {
  thread: ThreadRecord;
  branch: string;
  events?: EventEnvelope[];
  branchEvents?: ReadonlyMap<string, readonly EventEnvelope[]>;
  runs?: RunRecord[];
  artifacts?: ArtifactRecord[];
  runInputs?: RunInputQueueRecord[];
  modelSelection?: { provider: ProviderId; model: string; reasoningEffort?: string };
}

type CreateSessionCommand = {
  type: "create";
  threadId?: string;
  name?: string;
  defaultBranch?: string;
  parentThreadId?: string;
  parentRunId?: string;
};

type DeleteSessionCommand = { type: "delete"; threadId: string };
type NameSessionCommand = { type: "name"; threadId: string; name?: string };
type LabelSessionEntryCommand = {
  type: "label";
  threadId: string;
  branch: string;
  targetEventId: string;
  label?: string;
};
type ForkSessionBranchCommand = {
  type: "fork";
  input: Parameters<SessionStore["forkBranch"]>[0];
};
type ForkSessionBranchWithSummaryCommand = {
  type: "fork_with_summary";
  input: Parameters<SessionStore["forkBranchWithSummary"]>[0];
};

export type WorkspaceSessionCommand =
  | CreateSessionCommand
  | DeleteSessionCommand
  | NameSessionCommand
  | LabelSessionEntryCommand
  | ForkSessionBranchCommand
  | ForkSessionBranchWithSummaryCommand;

export type WorkspaceRunInputTransition =
  | "begin_delivery"
  | "complete_delivery"
  | "dequeue"
  | "lease"
  | "acknowledge"
  | "release"
  | "recover";

/** A durable queue capability already bound to one workspace session branch. */
export interface WorkspaceRunInputQueue {
  readonly threadId: string;
  readonly branch: string;
  enqueue(input: {
    mode: "steer" | "follow_up";
    text: string;
    images?: ImageBlock[];
  }): RunInputQueueRecord;
  list(states?: readonly RunInputQueueState[]): RunInputQueueRecord[];
  transition(queueId: string, transition: WorkspaceRunInputTransition): void;
  recoverAll(): number;
}

class BoundWorkspaceRunInputQueue implements WorkspaceRunInputQueue {
  readonly threadId: string;
  readonly branch: string;
  readonly #store: SessionStore;

  constructor(store: SessionStore, threadId: string, branch: string) {
    this.#store = store;
    this.threadId = threadId;
    this.branch = branch;
  }

  enqueue(input: {
    mode: "steer" | "follow_up";
    text: string;
    images?: ImageBlock[];
  }): RunInputQueueRecord {
    return this.#store.enqueueRunInput({
      threadId: this.threadId,
      branch: this.branch,
      ...input,
    });
  }

  list(states?: readonly RunInputQueueState[]): RunInputQueueRecord[] {
    return this.#store.listRunInputs(this.threadId, this.branch, states);
  }

  transition(queueId: string, transition: WorkspaceRunInputTransition): void {
    if (transition === "begin_delivery") {
      this.#store.beginRunInputDelivery(queueId, this.threadId, this.branch);
    } else if (transition === "complete_delivery") {
      this.#store.completeRunInputDelivery(queueId, this.threadId, this.branch);
    } else if (transition === "dequeue") {
      this.#store.dequeueRunInput(queueId, this.threadId, this.branch);
    } else if (transition === "lease") {
      this.#store.leaseRunInput(queueId, this.threadId, this.branch);
    } else if (transition === "acknowledge") {
      this.#store.acknowledgeRunInputLease(queueId, this.threadId, this.branch);
    } else if (transition === "release") {
      this.#store.releaseRunInputLease(queueId, this.threadId, this.branch);
    } else {
      this.#store.markRunInputRecoverable(queueId, this.threadId, this.branch);
    }
  }

  recoverAll(): number {
    return this.#store.markRunInputsRecoverable(this.threadId, this.branch);
  }
}

/**
 * The workspace-scoped storage boundary used by HarnessService. It groups
 * session queries and commands by behavior while keeping runtime ownership,
 * recovery, event-sink, and artifact-writer infrastructure in the storage
 * layer that owns those protocols.
 */
export class WorkspaceSessionFacade {
  readonly #store: SessionStore;
  readonly #workspaceRoot: string;

  constructor(store: SessionStore, workspaceRoot: string) {
    this.#store = store;
    this.#workspaceRoot = workspaceRoot;
  }

  thread(threadId: string): ThreadRecord {
    return this.#store.bindThreadWorkspace(threadId, this.#workspaceRoot);
  }

  branch(threadId: string, branch?: string): string {
    return this.#selectBranch(this.thread(threadId), branch);
  }

  snapshot(input: WorkspaceSessionSnapshotInput): WorkspaceSessionSnapshot {
    const thread = this.thread(input.threadId);
    const branch = this.#selectBranch(thread, input.branch);
    const include = input.include ?? {};
    const branchEventNames = include.branchEvents === true
      ? thread.branches.map((entry) => entry.name)
      : Array.isArray(include.branchEvents)
        ? [...new Set(include.branchEvents.map((entry) => this.#selectBranch(thread, entry)))]
        : undefined;
    const modelSelection = include.modelSelection === true
      ? this.#store.getModelSelection(input.threadId, branch)
      : undefined;
    return {
      thread,
      branch,
      ...(include.events === true ? { events: this.#store.listEvents(input.threadId, branch) } : {}),
      ...(branchEventNames === undefined
        ? {}
        : {
            branchEvents: new Map(branchEventNames.map((entry) => [
              entry,
              this.#store.listEvents(input.threadId, entry),
            ])),
          }),
      ...(include.runs === true ? { runs: this.#store.listRuns(input.threadId) } : {}),
      ...(include.artifacts === true ? { artifacts: this.#store.listArtifacts(input.threadId) } : {}),
      ...(include.runInputStates === undefined
        ? {}
        : { runInputs: this.#store.listRunInputs(input.threadId, branch, include.runInputStates) }),
      ...(modelSelection === undefined ? {} : { modelSelection }),
    };
  }

  *pagedEvents(input: {
    threadId: string;
    branch?: string;
    afterSequence?: number;
    pageSize: number;
  }): Generator<EventEnvelope, void, undefined> {
    const branch = this.branch(input.threadId, input.branch);
    let cursor = input.afterSequence ?? 0;
    let snapshotSequence: number | undefined;
    while (true) {
      const page = this.#store.listEventPage(input.threadId, branch, {
        afterSequence: cursor,
        limit: input.pageSize,
        ...(snapshotSequence === undefined ? {} : { throughSequence: snapshotSequence }),
      });
      snapshotSequence = page.snapshotSequence;
      yield* page.events;
      if (!page.hasMore) return;
      cursor = page.nextSequence;
    }
  }

  metadataPage(
    input: Omit<Parameters<SessionStore["listThreadMetadataPage"]>[0], "workspaceRoot">,
  ): ThreadMetadataPage {
    return this.#store.listThreadMetadataPage({ ...input, workspaceRoot: this.#workspaceRoot });
  }

  queue(threadId: string, branch?: string): WorkspaceRunInputQueue {
    return new BoundWorkspaceRunInputQueue(this.#store, threadId, this.branch(threadId, branch));
  }

  mutate(command: CreateSessionCommand): ThreadRecord;
  mutate(command: DeleteSessionCommand): void;
  mutate(command: NameSessionCommand): ThreadRecord;
  mutate(command: LabelSessionEntryCommand): ReturnType<SessionStore["setEntryLabel"]>;
  mutate(command: ForkSessionBranchCommand): BranchRecord;
  mutate(command: ForkSessionBranchWithSummaryCommand): ReturnType<SessionStore["forkBranchWithSummary"]>;
  mutate(command: WorkspaceSessionCommand):
    | ThreadRecord
    | void
    | ReturnType<SessionStore["setEntryLabel"]>
    | BranchRecord
    | ReturnType<SessionStore["forkBranchWithSummary"]> {
    if (command.type === "create") {
      if (command.parentThreadId !== undefined) this.thread(command.parentThreadId);
      if (command.parentRunId !== undefined) {
        if (command.parentThreadId === undefined) {
          throw new Error("A parentRunId requires parentThreadId");
        }
        const parentRun = this.#store.getRun(command.parentRunId);
        if (parentRun.threadId !== command.parentThreadId) {
          throw new Error(`Parent run ${command.parentRunId} does not belong to session ${command.parentThreadId}`);
        }
      }
      return this.#store.createThread({
        workspaceRoot: this.#workspaceRoot,
        ...(command.threadId === undefined ? {} : { threadId: command.threadId }),
        ...(command.name === undefined ? {} : { name: command.name }),
        ...(command.defaultBranch === undefined ? {} : { defaultBranch: command.defaultBranch }),
        ...(command.parentThreadId === undefined ? {} : { parentThreadId: command.parentThreadId }),
        ...(command.parentRunId === undefined ? {} : { parentRunId: command.parentRunId }),
      });
    }
    if (command.type === "delete") {
      this.thread(command.threadId);
      this.#store.deleteThread(command.threadId);
      return;
    }
    if (command.type === "name") {
      this.thread(command.threadId);
      return this.#store.nameThread(command.threadId, command.name);
    }
    if (command.type === "label") {
      this.branch(command.threadId, command.branch);
      return this.#store.setEntryLabel({
        threadId: command.threadId,
        branch: command.branch,
        targetEventId: command.targetEventId,
        ...(command.label === undefined ? {} : { label: command.label }),
      });
    }
    if (command.type === "fork") {
      this.thread(command.input.threadId);
      if (command.input.fromBranch !== undefined) this.branch(command.input.threadId, command.input.fromBranch);
      return this.#store.forkBranch(command.input);
    }
    this.thread(command.input.threadId);
    if (command.input.fromBranch !== undefined) this.branch(command.input.threadId, command.input.fromBranch);
    this.branch(command.input.threadId, command.input.sourceBranch);
    return this.#store.forkBranchWithSummary(command.input);
  }

  createRuntimeChild(command: CreateSessionCommand & { threadId: string }): ThreadRecord {
    return withRuntimeChildThreadCreation(this.#store, command.threadId, () => this.mutate(command));
  }

  clone(input: Omit<CloneSessionPathInput, "workspaceRoot">): CloneSessionPathResult {
    this.branch(input.threadId, input.branch);
    return cloneSessionPath(this.#store, { ...input, workspaceRoot: this.#workspaceRoot });
  }

  cloneRuntimeChild(
    input: Omit<CloneSessionPathInput, "workspaceRoot"> & { targetThreadId: string },
  ): CloneSessionPathResult {
    return withRuntimeChildThreadCreation(this.#store, input.targetThreadId, () => this.clone(input));
  }

  hasRuntimeChildThread(threadId: string): boolean {
    this.thread(threadId);
    return this.#store.hasRuntimeChildThread(threadId);
  }

  tree(threadId: string, branch?: string): SessionTreeRow[] {
    const selected = this.branch(threadId, branch);
    return buildSessionTree(this.#store, threadId, selected);
  }

  appendEvent<T extends RuntimeEvent>(threadId: string, branch: string, event: T): EventEnvelope<T> {
    const selected = this.branch(threadId, branch);
    return this.#store.appendEvent({ threadId, branch: selected, event });
  }

  compareAndAppendExtensionState(input: {
    threadId: string;
    branch: string;
    event: ExtensionStateEvent;
    expectedEventId: string | null;
  }): ReturnType<SessionStore["compareAndAppendExtensionState"]> {
    const branch = this.branch(input.threadId, input.branch);
    return this.#store.compareAndAppendExtensionState({ ...input, branch });
  }

  extensionState(
    threadId: string,
    branch: string,
    extensionId: string,
    schemaVersion: number,
    key: string,
  ): EventEnvelope<ExtensionStateEvent> | undefined {
    const selected = this.branch(threadId, branch);
    return this.#store.getExtensionState(threadId, extensionId, schemaVersion, key, selected);
  }

  extensionMessages(
    threadId: string,
    branch: string,
    extensionId: string,
    schemaVersion: number,
    kind?: string,
  ): EventEnvelope<ExtensionMessageEvent>[] {
    const selected = this.branch(threadId, branch);
    return this.#store.listExtensionMessages(threadId, extensionId, schemaVersion, selected, kind);
  }

  modelSelection(
    threadId: string,
    branch: string,
  ): { provider: ProviderId; model: string; reasoningEffort?: string } | undefined {
    return this.snapshot({ threadId, branch, include: { modelSelection: true } }).modelSelection;
  }

  #selectBranch(thread: ThreadRecord, branch?: string): string {
    const selected = branch ?? thread.defaultBranch;
    if (!thread.branches.some((entry) => entry.name === selected)) throw new Error(`Unknown branch: ${selected}`);
    return selected;
  }
}
