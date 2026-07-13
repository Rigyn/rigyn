import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DirectProcessRunner } from "../../src/process/index.js";
import { ToolCoordinator, ToolRegistry, WorkspaceBoundary } from "../../src/tools/index.js";
import type { HarnessTool, ToolContext, ToolInvocation } from "../../src/tools/types.js";

async function toolContext(t: { after(callback: () => Promise<void>): void }): Promise<ToolContext> {
  const root = await mkdtemp(join(tmpdir(), "harness-tool-interceptor-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return {
    workspace: await WorkspaceBoundary.create(root),
    runner: new DirectProcessRunner(),
    signal: new AbortController().signal,
    runId: "run",
    threadId: "thread",
  };
}

test("tool interception revalidates mutations and reduces results before redaction and completion", async (t) => {
  const seen: string[] = [];
  const tool: HarnessTool = {
    definition: {
      name: "echo",
      description: "echo",
      inputSchema: { type: "object", required: ["value"], properties: { value: { type: "string" } } },
    },
    validate(input) {
      if (input === null || typeof input !== "object" || Array.isArray(input) || typeof input.value !== "string") {
        throw new Error("value must be a string");
      }
    },
    resources() { return []; },
    async execute(input) {
      seen.push(`execute:${(input as { value: string }).value}`);
      return { content: (input as { value: string }).value, isError: false, metadata: { original: "SECRET" } };
    },
  };
  const received: ToolInvocation[] = [];
  const completed: string[] = [];
  const coordinator = new ToolCoordinator(
    new ToolRegistry([tool]),
    {},
    {
      text: (value) => value.replaceAll("SECRET", "[redacted]"),
      value: (value) => JSON.parse(JSON.stringify(value).replaceAll("SECRET", "[redacted]")),
    },
    {
      beforeCall(invocation) {
        return { invocation: { ...invocation, input: { value: "patched" } }, blocked: false };
      },
      afterResult(_invocation, result) {
        return { ...result, content: `${result.content}:SECRET`, metadata: { patched: "SECRET" } };
      },
    },
  );
  const result = await coordinator.execute(
    [{ callId: "call", name: "echo", input: { value: "original" }, index: 0 }],
    await toolContext(t),
    {
      received(invocation) { received.push(invocation); },
      completed(entry) { completed.push(entry.result.content); },
    },
  );

  assert.deepEqual(seen, ["execute:patched"]);
  assert.deepEqual(received.map((entry) => entry.input), [{ value: "patched" }]);
  assert.equal(result[0]?.result.content, "patched:[redacted]");
  assert.deepEqual(result[0]?.result.metadata, { patched: "[redacted]" });
  assert.deepEqual(completed, ["patched:[redacted]"]);
});

test("blocked, identity-changing, and schema-invalid tool reductions never execute", async (t) => {
  let executions = 0;
  const tool: HarnessTool = {
    definition: { name: "guarded", description: "guarded", inputSchema: { type: "object" } },
    validate(input) {
      if (input === null || typeof input !== "object" || Array.isArray(input) || input.ok !== true) throw new Error("ok required");
    },
    resources() { return []; },
    async execute() { executions += 1; return { content: "unsafe", isError: false }; },
  };
  const cases = [
    {
      name: "blocked",
      beforeCall: (invocation: ToolInvocation) => ({ invocation, blocked: true, reason: "protected" }),
      pattern: /protected/u,
    },
    {
      name: "identity",
      beforeCall: (invocation: ToolInvocation) => ({ invocation: { ...invocation, name: "other" }, blocked: false }),
      pattern: /cannot change call identity/u,
    },
    {
      name: "schema",
      beforeCall: (invocation: ToolInvocation) => ({ invocation: { ...invocation, input: { ok: false } }, blocked: false }),
      pattern: /ok required/u,
    },
  ];

  for (const entry of cases) {
    const coordinator = new ToolCoordinator(
      new ToolRegistry([tool]),
      {},
      undefined,
      { beforeCall: entry.beforeCall },
    );
    const result = await coordinator.execute(
      [{ callId: `call-${entry.name}`, name: "guarded", input: { ok: true }, index: 0 }],
      await toolContext(t),
    );
    assert.equal(result[0]?.result.isError, true);
    assert.match(result[0]?.result.content ?? "", entry.pattern);
  }
  assert.equal(executions, 0);
});

test("blocked reductions validate before durable observation and throwing preparers retain a canonical baseline", async (t) => {
  let executions = 0;
  const observed: ToolInvocation[] = [];
  const raw = { ok: true, value: "original" };
  const tool: HarnessTool = {
    definition: { name: "prepared_guard", description: "prepared guard", inputSchema: { type: "object" } },
    prepareInput(input) {
      if (input !== null && typeof input === "object" && !Array.isArray(input) && input.value === "throw") {
        input.value = "mutated-before-throw";
        throw new Error("preparation failed");
      }
      return input;
    },
    validate(input) {
      if (input === null || typeof input !== "object" || Array.isArray(input) || input.ok !== true) {
        throw new Error("ok required");
      }
    },
    resources() { return []; },
    async execute() { executions += 1; return { content: "unsafe", isError: false }; },
  };
  const invalidBlocked = new ToolCoordinator(
    new ToolRegistry([tool]),
    {},
    undefined,
    {
      beforeCall(invocation) {
        return { invocation: { ...invocation, input: { ok: false } }, blocked: true, reason: "must not mask validation" };
      },
    },
  );
  const [blocked] = await invalidBlocked.execute(
    [{ callId: "blocked-invalid", name: "prepared_guard", input: raw, index: 0 }],
    await toolContext(t),
    { received(invocation) { observed.push(structuredClone(invocation)); } },
  );
  assert.match(blocked?.result.content ?? "", /ok required/u);
  assert.doesNotMatch(blocked?.result.content ?? "", /must not mask validation/u);
  assert.deepEqual(observed[0]?.input, { ok: false });

  const throwing = new ToolCoordinator(new ToolRegistry([tool]));
  const throwingRaw = { ok: true, value: "throw" };
  const [failed] = await throwing.execute(
    [{ callId: "prepare-throw", name: "prepared_guard", input: throwingRaw, index: 0 }],
    await toolContext(t),
    { received(invocation) { observed.push(structuredClone(invocation)); } },
  );
  assert.match(failed?.result.content ?? "", /preparation failed/u);
  assert.deepEqual(throwingRaw, { ok: true, value: "throw" });
  assert.deepEqual(observed[1]?.input, { ok: true, value: "throw" });
  assert.equal(executions, 0);
});
