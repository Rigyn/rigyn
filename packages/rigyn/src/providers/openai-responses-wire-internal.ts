const resetAttemptWireEvents = new WeakSet<object>();

export function markResponsesAttemptReset<TWire extends object>(wire: TWire): TWire {
  resetAttemptWireEvents.add(wire);
  return wire;
}

export function consumeResponsesAttemptReset(wire: object): boolean {
  if (!resetAttemptWireEvents.has(wire)) return false;
  resetAttemptWireEvents.delete(wire);
  return true;
}
