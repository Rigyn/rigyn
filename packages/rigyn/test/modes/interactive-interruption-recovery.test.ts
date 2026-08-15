import assert from "node:assert/strict";
import test from "node:test";

import {
  dispatchInteractiveSubmissionAfterInterruption,
  formatInteractiveInterruptionRecovery,
  interruptInteractiveRunForCommand,
  isInteractiveRecoveryCommand,
  localInterruptionMarker,
  recoverInterruptedRunBeforeSubmission,
  restoreInterruptedSubmission,
  waitForInterruptedRunSettlement,
} from "../../src/modes/interactive-interruption-recovery.js";
import type {
  AgentSessionRecoveryOptions,
  AgentSessionRecoveryResult,
  AgentSessionSuspendedRun,
} from "../../src/service/agent-session.js";

function interruptedRun(overrides: Partial<AgentSessionSuspendedRun> = {}): AgentSessionSuspendedRun {
  return {
    operationId: "run-interrupted",
    acceptedAt: "2026-08-08T12:00:00.000Z",
    cancelled: true,
    attempts: 1,
    claimedQueueIds: [],
    effects: [
      {
        effectId: "effect-write",
        callId: "call-write",
        name: "write",
        policy: "never_repeat",
        status: "in_doubt",
        step: 1,
        index: 0,
        inputHash: "write-hash",
      },
      {
        effectId: "effect-read",
        callId: "call-read",
        name: "read",
        policy: "repeatable",
        status: "succeeded",
        step: 0,
        index: 0,
        inputHash: "read-hash",
      },
    ],
    ...overrides,
  };
}

function recoveryFixture(input: {
  suspended?: AgentSessionSuspendedRun;
  result?: AgentSessionRecoveryResult;
  hold?: Promise<void>;
  idle?: Promise<void>;
  streaming?: boolean;
}) {
  let suspended = input.suspended;
  let streaming = input.streaming ?? false;
  const calls: AgentSessionRecoveryOptions[] = [];
  let idleWaits = 0;
  const session = {
    get suspendedRun() { return suspended; },
    get isIdle() { return suspended === undefined; },
    get isStreaming() { return streaming; },
    async waitForIdle() {
      idleWaits += 1;
      await input.idle;
    },
    async recoverInterruptedRun(options: AgentSessionRecoveryOptions = {}) {
      calls.push(options);
      await input.hold;
      const result = input.result ?? {
        recovered: true as const,
        operationId: suspended?.operationId ?? "run-interrupted",
        blocked: [] as const,
      };
      if (result.recovered) suspended = undefined;
      return result;
    },
  };
  return {
    session,
    calls,
    idleWaits: () => idleWaits,
    suspended: () => suspended,
    setSuspended: (value: AgentSessionSuspendedRun | undefined) => { suspended = value; },
    setStreaming: (value: boolean) => { streaming = value; },
  };
}

test("the first post-interrupt submission abandons only unfinished effects without replay", async () => {
  const fixture = recoveryFixture({ suspended: interruptedRun() });

  assert.deepEqual(await recoverInterruptedRunBeforeSubmission(fixture.session, "run-interrupted"), {
    operationId: "run-interrupted",
    abandonedEffects: [{ effectId: "effect-write", name: "write" }],
  });
  assert.deepEqual(fixture.calls, [{
    resolutions: [{ effectId: "effect-write", outcome: "abandoned" }],
  }]);
  assert.equal(fixture.suspended(), undefined);

  assert.equal(await recoverInterruptedRunBeforeSubmission(fixture.session, undefined), undefined);
  assert.equal(fixture.calls.length, 1, "recovery must be single-shot after the run is settled");
});

test("an interrupting command recovers only the exact operation it cancelled before dispatch", async () => {
  const order: string[] = [];
  const fixture = recoveryFixture({
    suspended: interruptedRun({ cancelled: false }),
    streaming: true,
  });

  const recovery = await interruptInteractiveRunForCommand({
    session: fixture.session,
    command: "/new",
    terminal: { notify(message) { order.push(`notify:${message}`); } },
    async interrupt() {
      order.push("interrupt");
      fixture.setSuspended(interruptedRun({ cancelled: true }));
      fixture.setStreaming(false);
    },
  });
  order.push("dispatch");

  assert.equal(recovery?.operationId, "run-interrupted");
  assert.deepEqual(fixture.calls, [{
    resolutions: [{ effectId: "effect-write", outcome: "abandoned" }],
  }]);
  assert.deepEqual(order, [
    "interrupt",
    "notify:Recovered interrupted operation run-interrupted after cancellation; abandoned 1 unfinished tool call without replay.",
    "dispatch",
  ]);
});

test("recover and exit commands preserve suspended state for their own handlers", async () => {
  for (const command of ["/recover", "/quit", "/exit"]) {
    const fixture = recoveryFixture({
      suspended: interruptedRun({ cancelled: false }),
      streaming: true,
    });
    await interruptInteractiveRunForCommand({
      session: fixture.session,
      command,
      terminal: { notify() {} },
      async interrupt() {
        fixture.setSuspended(interruptedRun({ cancelled: true }));
        fixture.setStreaming(false);
      },
    });
    assert.equal(fixture.calls.length, 0, command);
    assert.equal(fixture.suspended()?.operationId, "run-interrupted", command);
  }
});

test("concurrent post-interrupt submissions share one recovery operation", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const fixture = recoveryFixture({ suspended: interruptedRun(), hold });

  const first = recoverInterruptedRunBeforeSubmission(fixture.session, "run-interrupted");
  const second = recoverInterruptedRunBeforeSubmission(fixture.session, "run-interrupted");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fixture.calls.length, 1);
  release();

  assert.deepEqual(await first, {
    operationId: "run-interrupted",
    abandonedEffects: [{ effectId: "effect-write", name: "write" }],
  });
  assert.equal(await second, undefined, "only the recovery owner reports the lifecycle event");
  assert.equal(fixture.calls.length, 1);
});

test("rapid Esc then Enter waits for active settlement before one recovery", async () => {
  let releaseIdle!: () => void;
  const idle = new Promise<void>((resolve) => { releaseIdle = resolve; });
  const fixture = recoveryFixture({
    suspended: interruptedRun({ cancelled: false }),
    idle,
    streaming: true,
  });

  const recovering = recoverInterruptedRunBeforeSubmission(fixture.session, "run-interrupted");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fixture.idleWaits(), 1);
  assert.equal(fixture.calls.length, 0);

  fixture.setSuspended(interruptedRun({ cancelled: true }));
  fixture.setStreaming(false);
  releaseIdle();
  assert.equal((await recovering)?.operationId, "run-interrupted");
  assert.equal(fixture.calls.length, 1);
});

test("waiting for settlement honors interactive lifecycle cancellation", async () => {
  const fixture = recoveryFixture({
    suspended: interruptedRun({ cancelled: false }),
    idle: new Promise<void>(() => undefined),
  });
  const lifecycle = new AbortController();
  const recovering = recoverInterruptedRunBeforeSubmission(fixture.session, "run-interrupted", lifecycle.signal);
  lifecycle.abort(new Error("interactive session replaced"));

  await assert.rejects(recovering, /interactive session replaced/u);
  assert.equal(fixture.calls.length, 0);
});

test("automatic recovery refuses a non-cancelled operation and leaves it untouched", async () => {
  const fixture = recoveryFixture({
    suspended: interruptedRun({ cancelled: false }),
  });

  await assert.rejects(
    recoverInterruptedRunBeforeSubmission(fixture.session, "run-interrupted"),
    /has not finished cancelling.*submission was not sent.*\/recover/iu,
  );
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.suspended()?.operationId, "run-interrupted");
});

test("blocked recovery remains explicit and does not consume the suspended run", async () => {
  const fixture = recoveryFixture({
    suspended: interruptedRun(),
    result: {
      recovered: false,
      operationId: "run-interrupted",
      blocked: [{ effectId: "effect-write", name: "write", reason: "journal unavailable" }],
    },
  });

  await assert.rejects(
    recoverInterruptedRunBeforeSubmission(fixture.session, "run-interrupted"),
    /run-interrupted.*write.*journal unavailable.*submission was not sent.*\/recover/isu,
  );
  assert.equal(fixture.suspended()?.operationId, "run-interrupted");
});

test("a cancelled run without this host's operation marker remains explicit", async () => {
  const fixture = recoveryFixture({ suspended: interruptedRun({ cancelled: true }) });

  await assert.rejects(
    recoverInterruptedRunBeforeSubmission(fixture.session, undefined),
    /run-interrupted requires explicit recovery.*submission was not sent.*\/recover/isu,
  );
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.suspended()?.operationId, "run-interrupted");
});

test("a local marker cannot authorize recovery of another operation", async () => {
  const fixture = recoveryFixture({ suspended: interruptedRun({ cancelled: true }) });

  await assert.rejects(
    recoverInterruptedRunBeforeSubmission(fixture.session, "run-from-replaced-session"),
    /run-interrupted requires explicit recovery/iu,
  );
  assert.equal(fixture.calls.length, 0);
});

test("Esc cannot grant local authority for an already-cancelled suspended run", () => {
  assert.equal(localInterruptionMarker({
    isStreaming: false,
    suspendedRun: interruptedRun({ cancelled: true }),
  }), undefined);
  assert.equal(localInterruptionMarker({
    isStreaming: true,
    suspendedRun: interruptedRun({ cancelled: true }),
  }), undefined);
  assert.equal(localInterruptionMarker({
    isStreaming: true,
    suspendedRun: interruptedRun({ cancelled: false }),
  }), "run-interrupted");
});

test("explicit /recover waits for settlement without making an automatic decision", async () => {
  let releaseIdle!: () => void;
  const idle = new Promise<void>((resolve) => { releaseIdle = resolve; });
  const fixture = recoveryFixture({ suspended: interruptedRun({ cancelled: false }), idle });

  assert.equal(isInteractiveRecoveryCommand(" /recover "), true);
  assert.equal(isInteractiveRecoveryCommand("/recover abandon effect-write"), true);
  assert.equal(isInteractiveRecoveryCommand("/recovery"), false);
  const waiting = waitForInterruptedRunSettlement(fixture.session);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fixture.idleWaits(), 1);
  assert.equal(fixture.calls.length, 0);
  releaseIdle();
  await waiting;
  assert.equal(fixture.calls.length, 0, "manual recovery must retain operator control");
});

test("recovery failure restoration preserves submitted text and image payloads", () => {
  const restored: unknown[] = [];
  restoreInterruptedSubmission({
    restoreQueuedMessages(messages) {
      restored.push(structuredClone(messages));
      return messages.length;
    },
  }, {
    text: "continue safely",
    mode: "follow_up",
    images: [{
      block: { type: "image", mediaType: "image/png", data: "aW1hZ2U=" },
      label: "input.png",
      coordinates: {
        width: 1,
        height: 1,
        originalWidth: 1,
        originalHeight: 1,
        scaleX: 1,
        scaleY: 1,
        orientationApplied: false,
        resized: false,
        converted: false,
      },
    }],
    recoveredImages: [{ type: "image", mediaType: "image/jpeg", url: "https://example.test/input.jpg" }],
  });
  assert.deepEqual(restored, [[{
    mode: "follow_up",
    text: "continue safely",
    images: [
      { type: "image", mediaType: "image/png", data: "aW1hZ2U=" },
      { type: "image", mediaType: "image/jpeg", url: "https://example.test/input.jpg" },
    ],
  }]]);
  assert.match(formatInteractiveInterruptionRecovery({
    operationId: "run-interrupted",
    abandonedEffects: [{ effectId: "effect-write", name: "write" }],
  }), /abandoned 1 unfinished tool call without replay/u);
});

test("shared interactive dispatch recovers a rapid local Esc once, then submits once", async () => {
  let releaseIdle!: () => void;
  const idle = new Promise<void>((resolve) => { releaseIdle = resolve; });
  const fixture = recoveryFixture({
    suspended: interruptedRun({ cancelled: false }),
    idle,
    streaming: true,
  });
  const notifications: Array<{ message: string; kind: string | undefined }> = [];
  const restored: unknown[] = [];
  let idleDispatches = 0;
  let activeDispatches = 0;
  let markerClears = 0;
  const dispatched = dispatchInteractiveSubmissionAfterInterruption({
    session: fixture.session,
    locallyInterruptedOperationId: "run-interrupted",
    clearLocalInterruptionMarker: () => { markerClears += 1; },
    text: "continue",
    draft: { text: "continue" },
    terminal: {
      notify(message, kind) { notifications.push({ message, kind }); },
      restoreQueuedMessages(messages) { restored.push(messages); return messages.length; },
    },
    canDispatchIdle: () => fixture.session.isIdle,
    async dispatchIdle() { idleDispatches += 1; },
    async dispatchActive() { activeDispatches += 1; },
    updateContext() {},
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(idleDispatches, 0);
  fixture.setSuspended(interruptedRun({ cancelled: true }));
  fixture.setStreaming(false);
  releaseIdle();
  await dispatched;

  assert.equal(idleDispatches, 1);
  assert.equal(activeDispatches, 0);
  assert.equal(markerClears, 1);
  assert.deepEqual(restored, []);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]?.message ?? "", /without replay/u);
  assert.equal(notifications[0]?.kind, "status");
  assert.deepEqual(fixture.calls, [{
    resolutions: [{ effectId: "effect-write", outcome: "abandoned" }],
  }]);
});

test("safe /help does not grant recovery and shell input remains blocked and restored", async () => {
  const fixture = recoveryFixture({ suspended: interruptedRun({ cancelled: true }) });
  const restored: unknown[] = [];
  let idleDispatches = 0;
  const terminal = {
    notify() {},
    restoreQueuedMessages(messages: readonly unknown[]) { restored.push(structuredClone(messages)); return messages.length; },
  };
  const common = {
    session: fixture.session,
    locallyInterruptedOperationId: undefined,
    clearLocalInterruptionMarker() {},
    terminal,
    canDispatchIdle: () => false,
    async dispatchIdle() { idleDispatches += 1; },
    async dispatchActive() { assert.fail("suspended input must not route to active steering"); },
    updateContext() {},
  };

  await dispatchInteractiveSubmissionAfterInterruption({
    ...common,
    text: "/help",
    draft: { text: "/help" },
  });
  assert.equal(idleDispatches, 1);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.suspended()?.operationId, "run-interrupted");

  await assert.rejects(dispatchInteractiveSubmissionAfterInterruption({
    ...common,
    text: "!pwd",
    draft: { text: "!pwd" },
  }), /must be recovered before this command.*submission was not sent/isu);
  assert.equal(idleDispatches, 1);
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual(restored, [[{ mode: "steer", text: "!pwd" }]]);
});

test("ordinary active steering bypasses interruption recovery", async () => {
  const fixture = recoveryFixture({
    suspended: interruptedRun({ cancelled: false }),
    streaming: true,
  });
  let idleDispatches = 0;
  let activeDispatches = 0;
  await dispatchInteractiveSubmissionAfterInterruption({
    session: fixture.session,
    locallyInterruptedOperationId: undefined,
    clearLocalInterruptionMarker() {},
    text: "change direction",
    draft: { text: "change direction", mode: "steer" },
    terminal: { notify() {}, restoreQueuedMessages: (messages) => messages.length },
    canDispatchIdle: () => false,
    async dispatchIdle() { idleDispatches += 1; },
    async dispatchActive() { activeDispatches += 1; },
    updateContext() {},
  });
  assert.equal(idleDispatches, 0);
  assert.equal(activeDispatches, 1);
  assert.equal(fixture.calls.length, 0);
});

test("idle dispatch does not read a session after the command replaces it", async () => {
  let replaced = false;
  let markerClears = 0;
  let contextUpdates = 0;
  const session = {
    get suspendedRun() {
      if (replaced) throw new Error("Session store is not initialized");
      return undefined;
    },
    get isIdle() { return true; },
    get isStreaming() { return false; },
    async waitForIdle() {},
    async recoverInterruptedRun() {
      assert.fail("a healthy idle session must not enter recovery");
    },
  };

  await dispatchInteractiveSubmissionAfterInterruption({
    session,
    locallyInterruptedOperationId: undefined,
    clearLocalInterruptionMarker() { markerClears += 1; },
    text: "/new",
    draft: { text: "/new" },
    terminal: { notify() {}, restoreQueuedMessages: (messages) => messages.length },
    canDispatchIdle: () => true,
    async dispatchIdle() { replaced = true; },
    async dispatchActive() { assert.fail("an idle command must not use active dispatch"); },
    updateContext() { contextUpdates += 1; },
  });

  assert.equal(markerClears, 1);
  assert.equal(contextUpdates, 1);
});
