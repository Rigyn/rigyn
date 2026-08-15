import assert from "node:assert/strict";
import test from "node:test";

import { recoverNonInteractiveSession } from "../../src/modes/noninteractive-recovery.js";
import type { AgentSession } from "../../src/service/agent-session.js";

function sessionFixture(
  suspended: boolean,
  result: Awaited<ReturnType<AgentSession["recoverInterruptedRun"]>>,
): {
  session: Pick<AgentSession, "recoverInterruptedRun" | "suspendedRun">;
  calls(): number;
  options(): Parameters<AgentSession["recoverInterruptedRun"]>[0] | undefined;
} {
  let recoveries = 0;
  let recoveryOptions: Parameters<AgentSession["recoverInterruptedRun"]>[0] | undefined;
  return {
    session: {
      get suspendedRun() {
        return suspended
          ? {
              operationId: "interrupted-operation",
              acceptedAt: "2026-07-29T12:00:00.000Z",
              cancelled: false,
              attempts: 0,
              claimedQueueIds: [],
              effects: [],
            }
          : undefined;
      },
      async recoverInterruptedRun(options) {
        recoveries += 1;
        recoveryOptions = options;
        return result;
      },
    },
    calls: () => recoveries,
    options: () => recoveryOptions,
  };
}

test("non-interactive recovery does nothing without suspended work", async () => {
  const fixture = sessionFixture(false, { recovered: false, blocked: [] });
  await recoverNonInteractiveSession(fixture.session);
  assert.equal(fixture.calls(), 0);
});

test("non-interactive recovery admits a new prompt after safe recovery", async () => {
  const fixture = sessionFixture(true, {
    recovered: true,
    operationId: "interrupted-operation",
    blocked: [],
  });
  await recoverNonInteractiveSession(fixture.session);
  assert.equal(fixture.calls(), 1);
});

test("non-interactive recovery forwards host cancellation", async () => {
  const fixture = sessionFixture(true, {
    recovered: true,
    operationId: "interrupted-operation",
    blocked: [],
  });
  const controller = new AbortController();
  await recoverNonInteractiveSession(fixture.session, controller.signal);
  assert.equal(fixture.options()?.signal, controller.signal);

  controller.abort(new Error("host stopped"));
  await assert.rejects(
    recoverNonInteractiveSession(fixture.session, controller.signal),
    /host stopped/u,
  );
  assert.equal(fixture.calls(), 1);
});

test("non-interactive recovery reports effects that require a manual decision", async () => {
  const fixture = sessionFixture(true, {
    recovered: false,
    operationId: "interrupted-operation",
    blocked: [{
      effectId: "effect-1",
      name: "write",
      reason: "the prior outcome is unknown",
    }],
  });
  await assert.rejects(
    recoverNonInteractiveSession(fixture.session),
    /Interrupted operation interrupted-operation requires an explicit recovery decision: effect-1 \(write\): the prior outcome is unknown/u,
  );
  assert.equal(fixture.calls(), 1);
});
