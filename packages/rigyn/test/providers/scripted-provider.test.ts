import assert from "node:assert/strict";
import { test } from "node:test";

import type { AdapterEvent, ProviderRequest } from "../../src/core/types.js";
import { createScriptedProvider } from "../../src/testing/scripted-provider.js";

const request = (): ProviderRequest => ({
  provider: "scripted",
  model: "scripted-model",
  messages: [],
  tools: [],
});

async function events(stream: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const values: AdapterEvent[] = [];
  for await (const event of stream) values.push(event);
  return values;
}

test("script factories settle hostile thrown values without inspection", async () => {
  let traps = 0;
  const failure = new Proxy(new Error("script failed"), {
    getPrototypeOf() {
      traps += 1;
      throw new Error("script rejection was inspected");
    },
  });
  const provider = createScriptedProvider({ scripts: [() => { throw failure; }] });

  const output = await events(provider.stream(request(), new AbortController().signal));

  assert.equal(traps, 0);
  assert.equal(output.length, 1);
  assert.equal(output[0]?.type, "error");
  if (output[0]?.type === "error") {
    assert.equal(output[0].error.category, "protocol");
    assert.equal(output[0].error.message, "Script factory failed: [Thrown object]");
  }
});

test("request validation settles hostile thrown values without inspection", async () => {
  let traps = 0;
  const failure = new Proxy(new Error("request failed"), {
    getPrototypeOf() {
      traps += 1;
      throw new Error("request rejection was inspected");
    },
  });
  const provider = createScriptedProvider();
  const hostile = new Proxy(request(), {
    get(target, property, receiver) {
      if (property === "provider") throw failure;
      return Reflect.get(target, property, receiver);
    },
  });

  const output = await events(provider.stream(hostile, new AbortController().signal));

  assert.equal(traps, 0);
  assert.equal(output.length, 1);
  assert.equal(output[0]?.type, "error");
  if (output[0]?.type === "error") {
    assert.equal(output[0].error.category, "invalid_request");
    assert.equal(output[0].error.message, "[Thrown object]");
  }
});

test("cancellation settles hostile abort reasons without inspection", async () => {
  let traps = 0;
  const failure = new Proxy(new Error("cancelled"), {
    getPrototypeOf() {
      traps += 1;
      throw new Error("abort reason was inspected");
    },
  });
  const controller = new AbortController();
  controller.abort(failure);
  const provider = createScriptedProvider();

  const output = await events(provider.stream(request(), controller.signal));

  assert.equal(traps, 0);
  assert.equal(output.length, 1);
  assert.equal(output[0]?.type, "error");
  if (output[0]?.type === "error") {
    assert.equal(output[0].error.category, "cancelled");
    assert.equal(output[0].error.message, "[Thrown object]");
  }
});
