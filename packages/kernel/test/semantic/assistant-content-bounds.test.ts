import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

import { ASSISTANT_CONTENT_LIMITS } from "../../src/runtime/core/assistant-content-limits.js";
import {
  assistantContentFromProviderState,
  canonicalAssistantContent,
  publicAssistantContent,
  validatedAssistantContent,
} from "../../src/runtime/core/public-assistant-content.js";

const limits = ASSISTANT_CONTENT_LIMITS;

function nestedArguments(levels: number): Record<string, unknown> {
  let value: unknown = true;
  for (let level = 0; level < levels; level += 1) value = { child: value };
  return value as Record<string, unknown>;
}

test("assistant content accepts its exact block limit and rejects one extra block", () => {
  const exact = Array.from({ length: limits.blocks }, (_, index) => ({
    type: "text" as const,
    text: String(index),
  }));

  assert.equal(canonicalAssistantContent(exact).length, limits.blocks);
  assert.equal(validatedAssistantContent(exact).length, limits.blocks);
  assert.throws(
    () => canonicalAssistantContent([...exact, { type: "text", text: "extra" }]),
    /at most 1024 blocks/u,
  );
  assert.throws(
    () => validatedAssistantContent([...exact, { type: "text", text: "extra" }]),
    /at most 1024 blocks/u,
  );

  const sparse: unknown[] = [];
  sparse.length = 1;
  assert.throws(() => canonicalAssistantContent(sparse), /dense|sparse/u);
  assert.throws(() => validatedAssistantContent(sparse), /dense|sparse/u);
});

test("assistant content rejects an oversized outer array before inspecting its blocks", () => {
  let getterCalls = 0;
  const over = new Array<unknown>(10_005).fill(null);
  Object.defineProperty(over, "0", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return { type: "text", text: "unreachable" };
    },
  });
  assert.throws(() => validatedAssistantContent(over), /at most 1024 blocks/u);
  assert.throws(() => canonicalAssistantContent(over), /at most 1024 blocks/u);
  assert.equal(getterCalls, 0);
});

test("assistant content stays below the redactor traversal budget including nested arguments", () => {
  const argumentsAtLimit = {
    items: Array.from({ length: limits.containers - 4 }, () => ({})),
  };
  const exact = [{
    type: "tool_call" as const,
    callId: "bounded-call",
    name: "bounded-tool",
    arguments: argumentsAtLimit,
  }];

  assert.equal(validatedAssistantContent(exact).length, 1);
  assert.equal(canonicalAssistantContent([{
    type: "toolCall",
    id: "bounded-call",
    name: "bounded-tool",
    arguments: argumentsAtLimit,
  }]).length, 1);
  assert.throws(
    () => validatedAssistantContent([{
      ...exact[0],
      arguments: { items: [...argumentsAtLimit.items, {}] },
    }]),
    /8192 (?:JSON )?container/u,
  );
  assert.throws(
    () => canonicalAssistantContent([{
      type: "toolCall",
      id: "bounded-call",
      name: "bounded-tool",
      arguments: { items: [...argumentsAtLimit.items, {}] },
    }]),
    /8192 (?:JSON )?container/u,
  );
});

test("assistant tool arguments align exact JSON value and depth bounds with redaction and V4 persistence", () => {
  const exactValues = Object.fromEntries(
    Array.from({ length: limits.argumentValues - 1 }, (_, index) => [String(index), 0]),
  );
  const overValues = { ...exactValues, extra: 0 };
  const exactDepth = nestedArguments(limits.argumentDepth + 1);
  const overDepth = nestedArguments(limits.argumentDepth + 2);
  const projections = [
    (argumentsValue: Record<string, unknown>) => validatedAssistantContent([{
      type: "tool_call",
      callId: "bounded-call",
      name: "bounded-tool",
      arguments: argumentsValue,
    }]),
    (argumentsValue: Record<string, unknown>) => canonicalAssistantContent([{
      type: "toolCall",
      id: "bounded-call",
      name: "bounded-tool",
      arguments: argumentsValue,
    }]),
  ];

  for (const project of projections) {
    assert.equal(project(exactValues).length, 1);
    assert.throws(() => project(overValues), /at most 8192 JSON values/u);
    assert.equal(project(exactDepth).length, 1);
    assert.throws(() => project(overDepth), /59 levels|62 levels/u);
  }
});

test("assistant content rejects cyclic and accessor arguments with bounded inspection", () => {
  const root = join(import.meta.dirname, "../..");
  const child = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    `
      import { validatedAssistantContent } from "./src/runtime/core/public-assistant-content.ts";
      const argumentsValue = {};
      argumentsValue.self = argumentsValue;
      try {
        validatedAssistantContent([{ type: "tool_call", callId: "cycle", name: "cycle", arguments: argumentsValue }]);
        process.exitCode = 2;
      } catch (error) {
        process.stdout.write(error instanceof Error ? error.message : String(error));
      }
    `,
  ], { cwd: root, encoding: "utf8", timeout: 2_000 });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0);
  assert.match(child.stdout, /must not contain cycles/u);

  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() { throw new Error("must not run"); },
  });
  assert.throws(
    () => validatedAssistantContent([{
      type: "tool_call",
      callId: "accessor",
      name: "accessor",
      arguments: accessor,
    }]),
    /enumerable data properties|accessors/u,
  );

  const sparse: unknown[] = [];
  sparse.length = limits.containers + 1;
  assert.throws(
    () => validatedAssistantContent([{
      type: "tool_call",
      callId: "sparse",
      name: "sparse",
      arguments: sparse,
    }]),
    /8192 array items|dense arrays/u,
  );

  const smallSparse: unknown[] = [];
  smallSparse.length = 2;
  assert.throws(
    () => validatedAssistantContent([{
      type: "tool_call",
      callId: "small-sparse",
      name: "small-sparse",
      arguments: { items: smallSparse },
    }]),
    /dense arrays|sparse arrays/u,
  );
  assert.throws(
    () => canonicalAssistantContent([{
      type: "toolCall",
      id: "small-sparse",
      name: "small-sparse",
      arguments: { items: smallSparse },
    }]),
    /dense arrays|sparse arrays/u,
  );
});

test("assistant content rejects hostile envelopes without invoking caller code", () => {
  for (const project of [canonicalAssistantContent, validatedAssistantContent]) {
    let calls = 0;
    const block = { type: "text" };
    Object.defineProperty(block, "text", {
      enumerable: true,
      get() {
        calls += 1;
        return "must not run";
      },
    });
    assert.throws(() => project([block]), /enumerable data properties|accessor/u);
    assert.equal(calls, 0);

    const outer: unknown[] = [];
    Object.defineProperty(outer, "0", {
      configurable: true,
      enumerable: true,
      get() {
        calls += 1;
        return { type: "text", text: "must not run" };
      },
    });
    outer.length = 1;
    assert.throws(() => project(outer), /enumerable data properties|accessor/u);
    assert.equal(calls, 0);

    const proxied = new Proxy([{ type: "text", text: "must not inspect" }], {
      getOwnPropertyDescriptor() {
        calls += 1;
        throw new Error("must not run");
      },
    });
    assert.throws(() => project(proxied), /proxies/u);
    assert.equal(calls, 0);
  }
});

test("assistant content rejects exotic JSON shapes without invoking toJSON", () => {
  const projections = [
    (argumentsValue: unknown) => validatedAssistantContent([{
      type: "tool_call",
      callId: "bounded-call",
      name: "bounded-tool",
      arguments: argumentsValue,
    }]),
    (argumentsValue: unknown) => canonicalAssistantContent([{
      type: "toolCall",
      id: "bounded-call",
      name: "bounded-tool",
      arguments: argumentsValue,
    }]),
  ];

  for (const project of projections) {
    let calls = 0;
    const inherited = Object.create({
      toJSON() {
        calls += 1;
        return { leaked: true };
      },
    }) as Record<string, unknown>;
    inherited.value = 1;
    assert.throws(() => project(inherited), /JSON-safe|plain objects/u);
    assert.equal(calls, 0);

    const symbol = { value: 1, [Symbol("hidden")]: true };
    assert.throws(() => project(symbol), /symbol keys/u);

    const nonEnumerable = { value: 1 };
    Object.defineProperty(nonEnumerable, "hidden", { value: true });
    assert.throws(() => project(nonEnumerable), /enumerable data properties/u);
  }
});

test("public assistant projections validate exported caller inputs before reading them", () => {
  let calls = 0;
  const block = { type: "text" };
  Object.defineProperty(block, "text", {
    enumerable: true,
    get() {
      calls += 1;
      return "must not run";
    },
  });
  assert.throws(() => publicAssistantContent([block] as never), /enumerable data properties|accessor/u);
  assert.equal(calls, 0);

  const state = { assistantContent: [] };
  Object.defineProperty(state, "kind", {
    enumerable: true,
    get() {
      calls += 1;
      return "extension_stream";
    },
  });
  assert.throws(() => assistantContentFromProviderState(state as never), /continuation state|data properties|accessor/u);
  assert.equal(calls, 0);
});

test("assistant content enforces per-field and aggregate byte limits", () => {
  const exactField = "x".repeat(limits.fieldBytes);
  assert.equal(validatedAssistantContent([{ type: "text", text: exactField }])[0]?.type, "text");
  assert.throws(
    () => validatedAssistantContent([{ type: "text", text: `${exactField}x` }]),
    /text content 0 exceeds 4194304 bytes/u,
  );
  assert.throws(
    () => canonicalAssistantContent([{ type: "text", text: `${exactField}x` }]),
    /text content 0 exceeds 4194304 bytes/u,
  );

  assert.equal(validatedAssistantContent([
    { type: "text", text: exactField },
    { type: "thinking", thinking: exactField },
  ]).length, 2);
  assert.throws(
    () => validatedAssistantContent([
      { type: "text", text: exactField },
      { type: "thinking", thinking: exactField },
      { type: "text", text: "x" },
    ]),
    /exceeds 8388608 aggregate bytes/u,
  );
  assert.throws(
    () => canonicalAssistantContent([
      { type: "text", text: exactField },
      { type: "thinking", thinking: exactField },
      { type: "text", text: "x" },
    ]),
    /exceeds 8388608 aggregate bytes/u,
  );

  const exactArguments = { value: "x".repeat(limits.fieldBytes - Buffer.byteLength('{"value":""}', "utf8")) };
  assert.equal(validatedAssistantContent([{
    type: "tool_call",
    callId: "bounded-call",
    name: "bounded-tool",
    arguments: exactArguments,
    rawArguments: exactField,
  }]).length, 1);
  assert.throws(
    () => validatedAssistantContent([{
      type: "tool_call",
      callId: "bounded-call",
      name: "bounded-tool",
      arguments: { value: `${exactArguments.value}x` },
    }]),
    /serialized arguments 0 exceeds 4194304 bytes/u,
  );
  assert.throws(
    () => validatedAssistantContent([{
      type: "tool_call",
      callId: "bounded-call",
      name: "bounded-tool",
      arguments: {},
      rawArguments: `${exactField}x`,
    }]),
    /raw arguments 0 exceeds 4194304 bytes/u,
  );

  assert.equal(limits.contentBytes, limits.fieldBytes * 2);
});

test("assistant content keeps the exact field boundary for JSON-escaped control text", () => {
  const exactField = "\u0001".repeat(limits.fieldBytes);
  const selected = validatedAssistantContent([{ type: "text", text: exactField }]);
  assert.equal(selected[0]?.type, "text");
  assert.equal(selected[0]?.type === "text" ? Buffer.byteLength(selected[0].text, "utf8") : 0, limits.fieldBytes);
});
