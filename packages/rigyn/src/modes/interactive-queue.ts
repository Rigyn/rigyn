import type { QueuedRunMessage } from "../core/agent.js";
import type { AgentSession } from "../service/agent-session.js";
import type { TuiController } from "../tui/controller.js";

type QueueSession = Pick<AgentSession, "abort" | "dequeueMessage" | "getQueuedMessages">;
type QueueTerminal = Pick<TuiController, "assertQueuedMessagesRestorable" | "restoreQueuedMessages">;

/** Atomically validates, removes, and restores every queued user message in delivery order. */
export function restoreAllQueuedMessages(session: QueueSession, terminal: QueueTerminal): number {
  const queued = session.getQueuedMessages();
  if (queued.length === 0) return 0;
  terminal.assertQueuedMessagesRestorable(queued);

  const restored: QueuedRunMessage[] = [];
  for (let index = 0; index < queued.length; index += 1) {
    const message = session.dequeueMessage();
    if (message === undefined) throw new Error("Queued messages changed while they were being restored");
    restored.push(message);
  }
  return terminal.restoreQueuedMessages(restored);
}

/** Restores queued input before cancellation can recover or deliver it elsewhere. */
export async function restoreQueuedMessagesThenAbort(
  session: QueueSession,
  terminal: QueueTerminal,
  reason: string,
): Promise<number> {
  let restored = 0;
  try {
    restored = restoreAllQueuedMessages(session, terminal);
  } finally {
    await session.abort(reason);
  }
  return restored;
}
