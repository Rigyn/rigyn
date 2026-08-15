import type {
  AgentSession,
  AgentSessionSuspendedToolEffect,
} from "../service/agent-session.js";
import type { ImageBlock } from "../core/types.js";
import type { TuiInputImageAttachment } from "../tui/types.js";

type RecoverableInteractiveSession = Pick<AgentSession, "recoverInterruptedRun" | "suspendedRun" | "waitForIdle">;

export interface InteractiveInterruptionRecovery {
  operationId: string;
  abandonedEffects: Array<{ effectId: string; name: string }>;
}

const unsettledEffectStatuses = new Set<AgentSessionSuspendedToolEffect["status"]>([
  "prepared",
  "dispatched",
  "in_doubt",
  "recovery_started",
]);
const activeRecoveries = new WeakMap<object, Promise<InteractiveInterruptionRecovery | undefined>>();

/** Authorize recovery only for a live operation this host is about to cancel. */
export function localInterruptionMarker(
  session: Pick<AgentSession, "isStreaming" | "suspendedRun">,
): string | undefined {
  const suspended = session.suspendedRun;
  return session.isStreaming && suspended?.cancelled === false
    ? suspended.operationId
    : undefined;
}

export function isInteractiveRecoveryCommand(text: string): boolean {
  return /^\/recover(?:\s|$)/u.test(text.trim());
}

function isRecoverySafeCommand(text: string): boolean {
  return /^\/(?:help|quit|exit)(?:\s|$)/u.test(text.trim());
}

function isConversationalSubmission(
  text: string,
  draft: Parameters<typeof restoreInterruptedSubmission>[1],
): boolean {
  if (draft.mode === "follow_up") return true;
  const trimmed = text.trim();
  return !trimmed.startsWith("/") && !trimmed.startsWith("!");
}

export function formatInteractiveInterruptionRecovery(
  recovery: InteractiveInterruptionRecovery,
): string {
  const count = recovery.abandonedEffects.length;
  return count === 0
    ? `Recovered interrupted operation ${recovery.operationId} after cancellation.`
    : `Recovered interrupted operation ${recovery.operationId} after cancellation; ` +
      `abandoned ${count} unfinished tool call${count === 1 ? "" : "s"} without replay.`;
}

function preservesInterruptedRun(command: string): boolean {
  return /^\/(?:recover|quit|exit)(?:\s|$)/u.test(command.trim());
}

/** Cancel one live operation, settle only that exact operation, then let a lifecycle command continue. */
export async function interruptInteractiveRunForCommand(options: {
  session: RecoverableInteractiveSession & Pick<AgentSession, "isStreaming">;
  command: string;
  terminal: { notify(message: string, kind?: "status" | "warning" | "error"): void };
  interrupt(): Promise<void>;
  signal?: AbortSignal;
}): Promise<InteractiveInterruptionRecovery | undefined> {
  const marker = localInterruptionMarker(options.session);
  await options.interrupt();
  if (preservesInterruptedRun(options.command)) return undefined;
  const recovery = await recoverInterruptedRunBeforeSubmission(
    options.session,
    marker,
    options.signal,
  );
  if (recovery !== undefined) {
    options.terminal.notify(formatInteractiveInterruptionRecovery(recovery), "status");
  }
  return recovery;
}

export function restoreInterruptedSubmission(
  terminal: {
    restoreQueuedMessages(messages: readonly {
      mode: "steer" | "follow_up";
      text: string;
      images?: readonly ImageBlock[];
    }[]): number;
  },
  submission: {
    text: string;
    mode?: "steer" | "follow_up";
    images?: readonly TuiInputImageAttachment[];
    recoveredImages?: readonly ImageBlock[];
  },
): void {
  const images = [
    ...(submission.images ?? []).map((image) => ({ ...image.block })),
    ...(submission.recoveredImages ?? []).map((image) => ({ ...image })),
  ];
  terminal.restoreQueuedMessages([{
    mode: submission.mode ?? "steer",
    text: submission.text,
    ...(images.length === 0 ? {} : { images }),
  }]);
}

export async function dispatchInteractiveSubmissionAfterInterruption(options: {
  session: RecoverableInteractiveSession & Pick<AgentSession, "isIdle" | "isStreaming">;
  locallyInterruptedOperationId: string | undefined;
  clearLocalInterruptionMarker(): void;
  signal?: AbortSignal;
  text: string;
  draft: Parameters<typeof restoreInterruptedSubmission>[1];
  terminal: Parameters<typeof restoreInterruptedSubmission>[0] & {
    notify(message: string, kind?: "status" | "warning" | "error"): void;
  };
  canDispatchIdle(): boolean;
  dispatchIdle(): Promise<void>;
  dispatchActive(): Promise<void>;
  updateContext(): void;
}): Promise<void> {
  const recoveryCommand = isInteractiveRecoveryCommand(options.text);
  const safeCommand = isRecoverySafeCommand(options.text);
  let markerCleared = false;
  const clearMarker = (): void => {
    if (markerCleared) return;
    markerCleared = true;
    options.clearLocalInterruptionMarker();
  };
  const suspended = options.session.suspendedRun;
  const interruptionPending = suspended !== undefined && (
    !options.session.isStreaming || options.locallyInterruptedOperationId === suspended.operationId
  );
  if (interruptionPending) {
    try {
      if (recoveryCommand) {
        await waitForInterruptedRunSettlement(options.session, options.signal);
      } else if (isConversationalSubmission(options.text, options.draft)) {
        const recovered = await recoverInterruptedRunBeforeSubmission(
          options.session,
          options.locallyInterruptedOperationId,
          options.signal,
        );
        if (recovered !== undefined) {
          clearMarker();
          options.terminal.notify(formatInteractiveInterruptionRecovery(recovered), "status");
        } else if (options.session.suspendedRun === undefined) {
          clearMarker();
        }
        options.updateContext();
      } else if (!safeCommand) {
        const operationId = suspended.operationId;
        throw new Error(
          `Interrupted operation ${operationId} must be recovered before this command; ` +
          "the submission was not sent. Use /recover, then retry.",
        );
      }
    } catch (error) {
      restoreInterruptedSubmission(options.terminal, options.draft);
      options.updateContext();
      throw error;
    }
  }
  if (recoveryCommand || safeCommand || options.canDispatchIdle()) {
    const markerWasAlreadySettled = suspended === undefined;
    if (markerWasAlreadySettled) clearMarker();
    await options.dispatchIdle();
    if (recoveryCommand && !markerWasAlreadySettled && options.session.suspendedRun === undefined) clearMarker();
    options.updateContext();
    return;
  }
  await options.dispatchActive();
}

/** Settle one same-process cancellation before accepting the next interactive submission. */
export async function recoverInterruptedRunBeforeSubmission(
  session: RecoverableInteractiveSession,
  locallyInterruptedOperationId: string | undefined,
  signal?: AbortSignal,
): Promise<InteractiveInterruptionRecovery | undefined> {
  const active = activeRecoveries.get(session);
  if (active !== undefined) {
    await active;
    return undefined;
  }

  const operation = recover(session, locallyInterruptedOperationId, signal);
  activeRecoveries.set(session, operation);
  try {
    return await operation;
  } finally {
    if (activeRecoveries.get(session) === operation) activeRecoveries.delete(session);
  }
}

/** Let Esc cancellation finish before an explicit same-process /recover command runs. */
export async function waitForInterruptedRunSettlement(
  session: RecoverableInteractiveSession,
  signal?: AbortSignal,
): Promise<void> {
  if (session.suspendedRun !== undefined) await waitForIdle(session, signal);
}

async function recover(
  session: RecoverableInteractiveSession,
  locallyInterruptedOperationId: string | undefined,
  signal?: AbortSignal,
): Promise<InteractiveInterruptionRecovery | undefined> {
  if (session.suspendedRun === undefined) return undefined;
  await waitForIdle(session, signal);
  signal?.throwIfAborted();
  const suspended = session.suspendedRun;
  if (suspended === undefined) return undefined;
  if (locallyInterruptedOperationId !== suspended.operationId) {
    throw new Error(
      `Interrupted operation ${suspended.operationId} requires explicit recovery; ` +
      "the submission was not sent. Use /recover, then retry.",
    );
  }
  if (!suspended.cancelled) {
    throw new Error(
      `Interrupted operation ${suspended.operationId} has not finished cancelling; ` +
      "the submission was not sent. Wait and retry, or use /recover.",
    );
  }

  const abandonedEffects = suspended.effects
    .filter((effect) => unsettledEffectStatuses.has(effect.status))
    .map((effect) => ({ effectId: effect.effectId, name: effect.name }));
  const result = await session.recoverInterruptedRun({
    resolutions: abandonedEffects.map((effect) => ({
      effectId: effect.effectId,
      outcome: "abandoned" as const,
    })),
  });
  if (result.recovered) return { operationId: result.operationId, abandonedEffects };
  if (result.operationId === undefined && session.suspendedRun === undefined) return undefined;

  const operationId = result.operationId ?? suspended.operationId;
  const detail = result.blocked.length === 0
    ? "recovery did not settle the cancelled operation"
    : result.blocked.map((entry) => `${entry.name}: ${entry.reason}`).join("; ");
  throw new Error(
    `Interrupted operation ${operationId} still needs recovery (${detail}); ` +
    "the submission was not sent. Use /recover, then retry.",
  );
}

async function waitForIdle(session: RecoverableInteractiveSession, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    await session.waitForIdle();
    return;
  }
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(signal.reason));
    session.waitForIdle().then(
      () => finish(resolve),
      (error: unknown) => finish(() => reject(error)),
    );
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
