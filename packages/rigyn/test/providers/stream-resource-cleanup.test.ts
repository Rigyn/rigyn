import assert from "node:assert/strict";
import test from "node:test";

import { cleanupProviderStreamResources } from "../../src/providers/stream-resource-cleanup.js";

test("provider stream cleanup always closes the network and preserves the primary failure", async () => {
  const primary = { error: new Error("primary stream failure") };
  let networkClosed = false;
  const result = await cleanupProviderStreamResources(primary, {
    id: "cleanup-fixture",
    async *stream() {},
    async listModels() { return []; },
    dispose() { throw new Error("adapter cleanup failure"); },
  }, {
    fetch: globalThis.fetch,
    info: { proxied: false, noProxyConfigured: false },
    async close() {
      networkClosed = true;
      throw new Error("network cleanup failure");
    },
  });

  assert.equal(networkClosed, true);
  assert.equal(result, primary);
});

test("provider stream cleanup reports cleanup failure when the stream succeeded", async () => {
  const failure = new Error("adapter cleanup failure");
  const result = await cleanupProviderStreamResources(undefined, {
    id: "cleanup-fixture",
    async *stream() {},
    async listModels() { return []; },
    dispose() { throw failure; },
  }, undefined);

  assert.equal(result?.error, failure);
});
