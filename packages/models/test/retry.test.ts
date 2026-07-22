import assert from "node:assert/strict";
import test from "node:test";

import { retryAssistantCall, type RetryCallbacks, type RetryPolicy } from "../src/index.js";
import { fauxAssistantMessage } from "../src/providers/faux.js";

const transient = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "service unavailable" });
const quota = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 insufficient_quota" });

test("retryAssistantCall retries transient failures and awaits callbacks in lifecycle order", async () => {
  const events: string[] = [];
  let calls = 0;
  const result = await retryAssistantCall(async () => {
    events.push(`produce:${calls}`);
    calls += 1;
    return calls === 1 ? transient() : fauxAssistantMessage("recovered");
  }, { enabled: true, maxRetries: 3, baseDelayMs: 0 }, undefined, {
    async onRetryScheduled(attempt, maxAttempts, delayMs, errorMessage) {
      await Promise.resolve();
      events.push(`scheduled:${attempt}:${maxAttempts}:${delayMs}:${errorMessage}`);
    },
    async onRetryAttemptStart() {
      await Promise.resolve();
      events.push("attempt-start");
    },
    async onRetryFinished(success, attempt, finalError) {
      await Promise.resolve();
      events.push(`finished:${success}:${attempt}:${String(finalError)}`);
    },
  });

  assert.deepEqual(result.content, [{ type: "text", text: "recovered" }]);
  assert.equal(calls, 2);
  assert.deepEqual(events, [
    "produce:0",
    "scheduled:1:3:0:service unavailable",
    "attempt-start",
    "produce:1",
    "finished:true:1:undefined",
  ]);
});

test("retryAssistantCall treats maxRetries as retries after the initial call", async () => {
  let calls = 0;
  const scheduled: Array<[number, number, number, string]> = [];
  const attempts: string[] = [];
  const finished: Array<[boolean, number, string?]> = [];
  const result = await retryAssistantCall(async () => {
    calls += 1;
    return transient();
  }, { enabled: true, maxRetries: 2, baseDelayMs: 1 }, undefined, {
    onRetryScheduled: (...event) => { scheduled.push(event); },
    onRetryAttemptStart: () => { attempts.push("start"); },
    onRetryFinished: (...event) => { finished.push(event); },
  });

  assert.equal(result.stopReason, "error");
  assert.equal(calls, 3);
  assert.deepEqual(scheduled, [
    [1, 2, 1, "service unavailable"],
    [2, 2, 2, "service unavailable"],
  ]);
  assert.deepEqual(attempts, ["start", "start"]);
  assert.deepEqual(finished, [[false, 2, "service unavailable"]]);
});

test("retryAssistantCall returns quota failures and disabled policies without retry callbacks", async (t) => {
  for (const current of [
    { name: "quota", policy: { enabled: true, maxRetries: 3, baseDelayMs: 0 } satisfies RetryPolicy, message: quota() },
    { name: "disabled", policy: { enabled: false, maxRetries: 3, baseDelayMs: 0 } satisfies RetryPolicy, message: transient() },
    { name: "undefined", policy: undefined, message: transient() },
  ]) {
    await t.test(current.name, async () => {
      let calls = 0;
      const events: string[] = [];
      const callbacks: RetryCallbacks = {
        onRetryScheduled: () => { events.push("scheduled"); },
        onRetryAttemptStart: () => { events.push("started"); },
        onRetryFinished: () => { events.push("finished"); },
      };
      const result = await retryAssistantCall(async () => {
        calls += 1;
        return current.message;
      }, current.policy, undefined, callbacks);
      assert.equal(result, current.message);
      assert.equal(calls, 1);
      assert.deepEqual(events, []);
    });
  }
});

test("retryAssistantCall normalizes a signal aborted before retry sleep", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const events: string[] = [];
  const result = await retryAssistantCall(async () => {
    calls += 1;
    return transient();
  }, { enabled: true, maxRetries: 2, baseDelayMs: 100 }, controller.signal, {
    onRetryScheduled: () => { events.push("scheduled"); },
    onRetryAttemptStart: () => { events.push("started"); },
    onRetryFinished: (success, attempt, finalError) => {
      events.push(`finished:${success}:${attempt}:${String(finalError)}`);
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.stopReason, "aborted");
  assert.equal(Object.hasOwn(result, "errorMessage"), false);
  assert.deepEqual(events, ["scheduled", "finished:false:1:service unavailable"]);
});

test("retryAssistantCall aborts an active backoff without starting another call", async () => {
  const controller = new AbortController();
  let calls = 0;
  let attemptStarts = 0;
  const finished: Array<[boolean, number, string?]> = [];
  const result = await retryAssistantCall(async () => {
    calls += 1;
    return transient();
  }, { enabled: true, maxRetries: 2, baseDelayMs: 200 }, controller.signal, {
    onRetryScheduled() {
      setTimeout(() => controller.abort(), 5);
    },
    onRetryAttemptStart() {
      attemptStarts += 1;
    },
    onRetryFinished(...event) {
      finished.push(event);
    },
  });

  assert.equal(calls, 1);
  assert.equal(attemptStarts, 0);
  assert.equal(result.stopReason, "aborted");
  assert.equal(Object.hasOwn(result, "errorMessage"), false);
  assert.deepEqual(finished, [[false, 1, "service unavailable"]]);
});

test("retryAssistantCall reports an aborted retried response without retrying again", async () => {
  let calls = 0;
  const finished: Array<[boolean, number, string?]> = [];
  const result = await retryAssistantCall(async () => {
    calls += 1;
    return calls === 1 ? transient() : fauxAssistantMessage("", { stopReason: "aborted" });
  }, { enabled: true, maxRetries: 3, baseDelayMs: 0 }, undefined, {
    onRetryFinished(...event) {
      finished.push(event);
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.stopReason, "aborted");
  assert.deepEqual(finished, [[false, 1]]);
});
