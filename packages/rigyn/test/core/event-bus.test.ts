import assert from "node:assert/strict";
import test from "node:test";

import { createEventBus } from "../../src/core/event-bus.js";

test("event bus supports independent subscriptions, disposal, and clearing", async () => {
  const bus = createEventBus();
  const seen: unknown[] = [];
  const off = bus.on("resource", async (value) => { seen.push(value); });
  bus.emit("resource", 1);
  await new Promise((resolve) => setImmediate(resolve));
  off();
  bus.emit("resource", 2);
  bus.on("resource", (value) => { seen.push(value); });
  bus.clear();
  bus.emit("resource", 3);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [1]);
});

test("event bus treats error as an ordinary topic and permits the supported listener volume without warnings", { concurrency: false }, async () => {
  const bus = createEventBus();
  const warnings: unknown[][] = [];
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = ((...args: unknown[]) => { warnings.push(args); }) as typeof process.emitWarning;
  try {
    assert.doesNotThrow(() => bus.emit("error", { phase: "without-listener" }));
    let deliveries = 0;
    for (let index = 0; index < 64; index += 1) {
      bus.on("many", () => { deliveries += 1; });
    }
    bus.emit("many", null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(deliveries, 64);
    assert.deepEqual(warnings, []);
  } finally {
    process.emitWarning = originalEmitWarning;
    bus.clear();
  }
});

test("event bus reports rejected handlers without exposing the channel or thrown value", { concurrency: false }, async () => {
  const bus = createEventBus();
  const reports: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { reports.push(args); };
  try {
    bus.on("secret-channel-value", async () => {
      throw new Error("secret-handler-value");
    });
    bus.emit("secret-channel-value", null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(reports, [["Event handler failed"]]);
    assert.equal(JSON.stringify(reports).includes("secret"), false);
  } finally {
    console.error = originalConsoleError;
    bus.clear();
  }
});
