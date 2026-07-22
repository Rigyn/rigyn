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
