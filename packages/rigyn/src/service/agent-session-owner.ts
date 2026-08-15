import type { AgentSession } from "./agent-session.js";

const owners = new WeakMap<AgentSession, () => void | Promise<void>>();
const recoveryFinalizers = new WeakMap<AgentSession, {
  pending: Array<() => void | Promise<void>>;
  running?: Promise<void>;
}>();
const replacementCloses = new WeakSet<AgentSession>();
const preservedSessionStores = new WeakSet<AgentSession>();
const sharedStoreReplacementOptions = new WeakSet<object>();

/** Marks internal replacement options whose session store remains owned by the active runtime. */
export function markAgentSessionSharedStoreReplacement<T extends object>(options: T): T {
  sharedStoreReplacementOptions.add(options);
  return options;
}

/** Internal construction-failure policy for a replacement that shares the active session store. */
export function isAgentSessionSharedStoreReplacement(options: object): boolean {
  return sharedStoreReplacementOptions.has(options);
}

/** Internal ownership hook used by factories that allocate resources around a session. */
export function attachAgentSessionOwner(
  session: AgentSession,
  dispose: () => void | Promise<void>,
): void {
  if (owners.has(session)) throw new Error("AgentSession already has an owner");
  owners.set(session, dispose);
}

/** Runs an attached owner disposer at most once. */
export async function disposeAgentSessionOwner(session: AgentSession): Promise<void> {
  recoveryFinalizers.delete(session);
  const dispose = owners.get(session);
  if (dispose === undefined) return;
  owners.delete(session);
  await dispose();
}

/** Queues internal work that must settle before post-recovery prompts are admitted. */
export function enqueueAgentSessionRecoveryFinalizer(
  session: AgentSession,
  finalize: () => void | Promise<void>,
): void {
  const state = recoveryFinalizers.get(session);
  if (state === undefined) recoveryFinalizers.set(session, { pending: [finalize] });
  else state.pending.push(finalize);
}

/** Runs queued recovery finalizers until they succeed, then removes them. */
export function runAgentSessionRecoveryFinalizer(session: AgentSession): Promise<void> | undefined {
  const state = recoveryFinalizers.get(session);
  if (state === undefined) return undefined;
  if (state.running !== undefined) return state.running;
  state.running = Promise.resolve().then(async () => {
    try {
      while (state.pending.length > 0) {
        await state.pending[0]!();
        state.pending.shift();
      }
      if (recoveryFinalizers.get(session) === state) recoveryFinalizers.delete(session);
    } finally {
      delete state.running;
    }
  });
  return state.running;
}

/** Defers requested selection until an interrupted run is explicitly recovered. */
export function deferAgentSessionSelection(
  session: AgentSession,
  selection: {
    model?: Parameters<AgentSession["setModel"]>[0];
    thinkingLevel?: string;
  },
): void {
  let pendingModel = selection.model === undefined ? undefined : structuredClone(selection.model);
  let pendingThinking = selection.thinkingLevel;
  if (pendingModel === undefined && pendingThinking === undefined) return;
  enqueueAgentSessionRecoveryFinalizer(session, async () => {
    try {
      if (pendingModel !== undefined) {
        const requestedModel = pendingModel;
        const entryCount = session.nativeSessionManager.getEntries().length;
        try {
          await session.setModel(requestedModel);
          pendingModel = undefined;
        } catch (error) {
          if (session.nativeSessionManager.getEntries().slice(entryCount).some((entry) =>
            entry.type === "model_change" &&
            entry.provider === requestedModel.provider &&
            entry.modelId === requestedModel.id)) pendingModel = undefined;
          throw error;
        }
      }
      if (pendingThinking !== undefined) {
        session.setThinkingLevel(pendingThinking);
        pendingThinking = undefined;
      }
    } catch (error) {
      throw new Error(
        "Interrupted run is recovered, but the requested model or thinking selection could not be applied",
        { cause: error },
      );
    }
  });
}

/** Closes a session without waiting on the command that requested replacement. */
export async function closeAgentSessionForReplacement(
  session: AgentSession,
  options: { preserveSessionStore?: boolean } = {},
): Promise<void> {
  replacementCloses.add(session);
  if (options.preserveSessionStore === true) preservedSessionStores.add(session);
  try {
    await session.close();
  } finally {
    replacementCloses.delete(session);
    preservedSessionStores.delete(session);
  }
}

/** Internal state read by AgentSession.close without changing its public signature. */
export function isAgentSessionReplacementClose(session: AgentSession): boolean {
  return replacementCloses.has(session);
}

/** Internal state read by AgentSession.close when a replacement shares its store. */
export function isAgentSessionStorePreserved(session: AgentSession): boolean {
  return preservedSessionStores.has(session);
}
