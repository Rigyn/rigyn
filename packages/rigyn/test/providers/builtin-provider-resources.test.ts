import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderAdapter } from "../../src/core/types.js";
import type { NetworkTransport } from "../../src/net/index.js";
import { BuiltinProviderResources } from "../../src/providers/builtin-provider-resources.js";

function fixtureResource(calls: { adapters: number; networks: number }) {
  return {
    adapter: {
      id: "fixture",
      async *stream() {},
      async listModels() { return []; },
      dispose() { calls.adapters += 1; },
    } satisfies ProviderAdapter,
    network: {
      fetch: globalThis.fetch,
      info: { proxied: false, noProxyConfigured: false },
      async close() { calls.networks += 1; },
    } satisfies NetworkTransport,
  };
}

test("built-in provider resources retain matching transports until explicit close", async () => {
  const resources = new BuiltinProviderResources();
  const calls = { adapters: 0, networks: 0 };
  let creates = 0;
  const create = () => {
    creates += 1;
    return fixtureResource(calls);
  };

  const first = resources.acquire("same-runtime", create);
  const second = resources.acquire("same-runtime", create);
  assert.equal(first.adapter, second.adapter);
  assert.equal(creates, 1);
  assert.equal(await first.release(), undefined);
  assert.equal(await second.release(), undefined);
  assert.deepEqual(calls, { adapters: 0, networks: 0 });
  assert.equal(resources.signal.aborted, false);

  await resources.close();
  await resources.close();
  assert.equal(resources.signal.aborted, true);
  assert.match(String(resources.signal.reason), /Built-in model resources are closed/u);
  assert.deepEqual(calls, { adapters: 1, networks: 1 });
  assert.throws(() => resources.acquire("same-runtime", create), /closed/u);
});

test("built-in provider resources bound unmatched transports and clean request-owned entries", async () => {
  const resources = new BuiltinProviderResources(1);
  const retainedCalls = { adapters: 0, networks: 0 };
  const requestCalls = { adapters: 0, networks: 0 };
  resources.acquire("retained", () => fixtureResource(retainedCalls));
  const requestOwned = resources.acquire("other", () => fixtureResource(requestCalls));

  const primary = { error: new Error("stream failed") };
  assert.equal(await requestOwned.release(primary), primary);
  assert.deepEqual(requestCalls, { adapters: 1, networks: 1 });
  await resources.close();
  assert.deepEqual(retainedCalls, { adapters: 1, networks: 1 });
});
