import type { AgentSession } from "../service/agent-session.js";

type RecoverableSession = Pick<AgentSession, "recoverInterruptedRun" | "suspendedRun">;

/** Recover safe interrupted work before a non-interactive host admits a new prompt. */
export async function recoverNonInteractiveSession(
  session: RecoverableSession,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const suspended = session.suspendedRun;
  if (suspended === undefined) return;
  const recovered = await session.recoverInterruptedRun(
    signal === undefined ? undefined : { signal },
  );
  signal?.throwIfAborted();
  if (recovered.recovered) return;
  const details = recovered.blocked
    .map((entry) => `${entry.effectId} (${entry.name}): ${entry.reason}`)
    .join("; ");
  throw new Error(
    `Interrupted operation ${suspended.operationId} requires an explicit recovery decision${
      details === "" ? "" : `: ${details}`
    }. Open an interactive session and use /recover, or use the RPC or SDK recovery API.`,
  );
}
