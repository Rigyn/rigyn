import type { AgentSession } from "./agent-session.js";

const owners = new WeakMap<AgentSession, () => void | Promise<void>>();

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
  const dispose = owners.get(session);
  if (dispose === undefined) return;
  owners.delete(session);
  await dispose();
}
