import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_NORMALIZED_USAGE_RAW_BYTES,
  boundedUsageRaw,
  isJsonValue,
  isNormalizedUsage,
  toJsonValue,
  validateProviderState,
} from "../../src/runtime/index.js";

function nestedObject(depth: number): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current = root;
  for (let index = 0; index < depth; index++) {
    const next: Record<string, unknown> = {};
    current["next"] = next;
    current = next;
  }
  return root;
}

test("public JSON guards are iterative, nonthrowing, and preserve repeated acyclic values", () => {
  const deep = nestedObject(20_000);
  const shared = { value: true };
  assert.equal(isJsonValue(deep), true);
  assert.equal(toJsonValue(deep), deep);
  assert.equal(isJsonValue({ left: shared, right: shared }), true);

  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  assert.equal(isJsonValue(cyclic), false);
  assert.throws(() => toJsonValue(cyclic), {
    name: "TypeError",
    message: "Value is not JSON-serializable",
  });

  const sparse = new Array<unknown>(1);
  assert.equal(isJsonValue(sparse), false);

  let getterCalls = 0;
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return true;
    },
  });
  assert.equal(isJsonValue(accessor), false);
  assert.equal(getterCalls, 0);

  const hostile = new Proxy({}, {
    ownKeys() {
      throw new Error("hostile reflection");
    },
  });
  assert.equal(isJsonValue(hostile), false);
});

test("normalized usage rejects hostile raw JSON without throwing", () => {
  const deep = nestedObject(20_000);
  assert.equal(isNormalizedUsage({ raw: deep }), false);

  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  assert.equal(isNormalizedUsage({ raw: cyclic }), false);

  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      throw new Error("must not run");
    },
  });
  assert.equal(isNormalizedUsage({ raw: accessor }), false);
  assert.equal(isNormalizedUsage({ raw: new Array<unknown>(1) }), false);

  let outerGetterCalls = 0;
  const outerAccessor: Record<string, unknown> = {};
  Object.defineProperty(outerAccessor, "raw", {
    enumerable: true,
    get() {
      outerGetterCalls += 1;
      throw new Error("must not run");
    },
  });
  assert.equal(isNormalizedUsage(outerAccessor), false);
  assert.equal(outerGetterCalls, 0);

  let proxyTrapCalls = 0;
  const hostileUsage = new Proxy({}, {
    ownKeys() {
      proxyTrapCalls += 1;
      throw new Error("hostile reflection");
    },
  });
  assert.equal(isNormalizedUsage(hostileUsage), false);
  assert.equal(proxyTrapCalls, 0);

  let toJsonCalls = 0;
  const inheritedToJson = Object.assign(Object.create({
    toJSON() {
      toJsonCalls += 1;
      return { coerced: true };
    },
  }) as Record<string, unknown>, { safe: true });
  assert.equal(isNormalizedUsage({ raw: inheritedToJson }), false);
  assert.equal(toJsonCalls, 0);

  const exactPayloadBytes = MAX_NORMALIZED_USAGE_RAW_BYTES - Buffer.byteLength('{"payload":""}', "utf8");
  assert.equal(isNormalizedUsage({ raw: { payload: "x".repeat(exactPayloadBytes) } }), true);
  assert.equal(isNormalizedUsage({ raw: { payload: "x".repeat(exactPayloadBytes + 1) } }), false);
  assert.equal(isNormalizedUsage({ raw: Array.from({ length: 8_193 }, () => null) }), false);
});

test("bounded raw usage never invokes hostile serialization hooks", () => {
  let toJsonCalls = 0;
  const inheritedToJson = Object.assign(Object.create({
    toJSON() {
      toJsonCalls += 1;
      return { coerced: true };
    },
  }) as Record<string, unknown>, { safe: true });
  assert.deepEqual(boundedUsageRaw(inheritedToJson as never), { invalid: true, truncated: true });
  assert.equal(toJsonCalls, 0);

  let proxyTrapCalls = 0;
  const hostile = new Proxy({}, {
    ownKeys() {
      proxyTrapCalls += 1;
      return [];
    },
  });
  assert.deepEqual(boundedUsageRaw(hostile), { invalid: true, truncated: true });
  assert.equal(proxyTrapCalls, 0);
});

test("provider state validation enforces discriminator and provenance agreement", () => {
  const source = {
    kind: "chat_completions" as const,
    assistantMessage: { role: "assistant" },
    source: {
      provider: "provider",
      model: "model",
      api: "openai-chat-completions" as const,
    },
    routed: {
      provider: "provider",
      model: "model",
      delegate: "delegate",
      upstreamModel: "upstream",
      protocolFamily: "openai-chat-completions" as const,
      scope: "scope",
    },
  };
  const selected = validateProviderState(source);
  assert.equal(selected.api, "openai-chat-completions");
  assert.equal(selected.serialized, JSON.stringify(source));
  assert.notEqual(selected.state, source);

  assert.throws(() => validateProviderState({
    ...source,
    source: { ...source.source, api: "anthropic-messages" },
  }), TypeError);
  assert.throws(() => validateProviderState({
    ...source,
    routed: { ...source.routed, protocolFamily: "anthropic-messages" },
  }), TypeError);
});

test("public JSON guards reject reflective and prototype hazards without executing user code", () => {
  let trapCalls = 0;
  const proxy = new Proxy({ safe: true }, {
    getPrototypeOf() {
      trapCalls += 1;
      throw new Error("must-not-run");
    },
    ownKeys() {
      trapCalls += 1;
      throw new Error("must-not-run");
    },
  });
  assert.equal(isJsonValue(proxy), false);
  assert.throws(() => toJsonValue(proxy), /not JSON-serializable/u);
  assert.equal(trapCalls, 0);

  let toJsonCalls = 0;
  const inherited = Object.assign(Object.create({
    toJSON() {
      toJsonCalls += 1;
      return { rewritten: true };
    },
  }) as Record<string, unknown>, { safe: true });
  assert.equal(isJsonValue(inherited), false);
  assert.throws(() => toJsonValue(inherited), /not JSON-serializable/u);

  const hidden = { safe: true };
  Object.defineProperty(hidden, "toJSON", {
    value() {
      toJsonCalls += 1;
      return { rewritten: true };
    },
  });
  assert.equal(isJsonValue(hidden), false);
  assert.throws(() => toJsonValue(hidden), /not JSON-serializable/u);
  assert.equal(toJsonCalls, 0);

  const symbol = Symbol("hidden");
  assert.equal(isJsonValue({ safe: true, [symbol]: "hidden" }), false);

  const extraArray = [true] as unknown[] & { extra?: boolean };
  extraArray.extra = true;
  assert.equal(isJsonValue(extraArray), false);

  const inheritedArray = [true];
  Object.setPrototypeOf(inheritedArray, Object.create(Array.prototype));
  assert.equal(isJsonValue(inheritedArray), false);

  let arrayGetterCalls = 0;
  const accessorArray: unknown[] = [];
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    get() {
      arrayGetterCalls += 1;
      return true;
    },
  });
  accessorArray.length = 1;
  assert.equal(isJsonValue(accessorArray), false);
  assert.equal(arrayGetterCalls, 0);

  const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { safe: true });
  assert.equal(isJsonValue(nullPrototype), true);
  assert.equal(toJsonValue(nullPrototype), nullPrototype);
});
