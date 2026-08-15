import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseSessionV4CommitDraft } from "@rigyn/kernel/session-v4";

import { DirectProcessRunner } from "../../src/process/index.js";
import {
  MAX_TOOL_INPUT_BYTES,
  MAX_TOOL_RESULT_METADATA_BYTES,
  ToolCoordinator,
  ToolRegistry,
  WorkspaceBoundary,
} from "../../src/tools/index.js";
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

function deeplyNestedValue(depth: number): unknown {
  let value: unknown = "leaf";
  for (let index = 0; index < depth; index += 1) value = { child: value };
  return value;
}

test("tool inputs reject custom serializers and oversized values before execution", async (t) => {
  let executions = 0;
  const tool: HarnessTool = {
    definition: {
      name: "input_boundary",
      description: "input boundary",
      inputSchema: { type: "object" },
    },
    validate() {},
    resources() { return []; },
    async execute() {
      executions += 1;
      return { content: "must not execute", isError: false };
    },
  };
  const coordinator = new ToolCoordinator(new ToolRegistry([tool]));
  const context = await toolContext(t);
  let toJsonCalls = 0;
  const inheritedToJson = Object.assign(Object.create({
    toJSON() {
      toJsonCalls += 1;
      return { rewritten: true };
    },
  }) as Record<string, unknown>, { original: true });

  const [customSerializer] = await coordinator.execute([{
    callId: "custom-serializer",
    name: "input_boundary",
    input: inheritedToJson as never,
    index: 0,
  }], context);
  assert.match(customSerializer?.result.content ?? "", /plain objects and (?:vanilla )?arrays/u);
  assert.equal(toJsonCalls, 0);

  const [oversized] = await coordinator.execute([{
    callId: "oversized",
    name: "input_boundary",
    input: { value: "x".repeat(MAX_TOOL_INPUT_BYTES + 1) },
    index: 1,
  }], context);
  assert.match(oversized?.result.content ?? "", new RegExp(`exceeds ${MAX_TOOL_INPUT_BYTES} (?:UTF-8 )?bytes`, "u"));
  assert.equal(executions, 0);
});

test("tool interception applies trusted mutations and reduces results before redaction and completion", async (t) => {
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
  const transformed: string[][] = [];
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
        return {
          invocation: { ...invocation, input: { value: "patched" } },
          blocked: false,
          transformations: [{ actor: "fixture-extension" }],
        };
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
      transformed(_invocation, audit) { transformed.push(audit.map((entry) => entry.actor)); },
      received(invocation) { received.push(invocation); },
      completed(entry) { completed.push(entry.result.content); },
    },
  );

  assert.deepEqual(seen, ["execute:patched"]);
  assert.deepEqual(received.map((entry) => entry.input), [{ value: "patched" }]);
  assert.deepEqual(transformed, [["fixture-extension"]]);
  assert.equal(result[0]?.result.content, "patched:[redacted]");
  assert.deepEqual(result[0]?.result.metadata, { patched: "[redacted]" });
  assert.deepEqual(completed, ["patched:[redacted]"]);
});

test("tool completion redacts display fields and omits secret-bearing semantic fields", async (t) => {
  const secret = "tool-result-secret";
  const tool: HarnessTool = {
    definition: {
      name: "result_fields",
      description: "result fields",
      inputSchema: { type: "object" },
    },
    validate() {},
    resources() { return []; },
    async execute() {
      return {
        content: secret,
        isError: false,
        summary: secret,
        nextActions: [`retry ${secret}`],
        addedToolNames: ["safe_tool", secret],
        artifacts: [
          { id: "safe", path: "/tmp/safe", mediaType: "text/plain", bytes: 1 },
          { id: secret, path: "/tmp/secret", mediaType: "text/plain", bytes: 1 },
          { id: "secret-path", path: `/tmp/${secret}`, mediaType: "text/plain", bytes: 1 },
          { id: "secret-media", path: "/tmp/media", mediaType: `x/${secret}`, bytes: 1 },
          { id: "control\0id", path: "/tmp/control", mediaType: "text/plain", bytes: 1 },
        ],
        metadata: { value: secret },
      };
    },
  };
  let completed: import("../../src/tools/types.js").ToolInvocationResult | undefined;
  const coordinator = new ToolCoordinator(
    new ToolRegistry([tool]),
    { completed(entry) { completed = entry; } },
    {
      text: (value) => value.replaceAll(secret, "[redacted]"),
      value: (value) => JSON.parse(JSON.stringify(value).replaceAll(secret, "[redacted]")),
    },
  );

  const [result] = await coordinator.execute(
    [{ callId: "call", name: "result_fields", input: {}, index: 0 }],
    await toolContext(t),
  );

  assert.equal(result?.result.content, "[redacted]");
  assert.equal(result?.result.summary, "[redacted]");
  assert.deepEqual(result?.result.nextActions, ["retry [redacted]"]);
  assert.deepEqual(result?.result.addedToolNames, ["safe_tool"]);
  assert.deepEqual(result?.result.artifacts, [
    { id: "safe", path: "/tmp/safe", mediaType: "text/plain", bytes: 1 },
  ]);
  assert.deepEqual(result?.result.metadata, { value: "[redacted]" });
  assert.deepEqual(completed, result);
});

test("malformed reduced metadata cannot reject or unbalance a completed tool batch", async (t) => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() { throw new Error("metadata accessor must stay isolated"); },
  });
  const cases = [
    { name: "deep", value: deeplyNestedValue(20_000), invalid: true },
    { name: "cyclic", value: cyclic, invalid: true },
    { name: "accessor", value: accessor, invalid: true },
    { name: "oversized", value: { value: "x".repeat(MAX_TOOL_RESULT_METADATA_BYTES + 1) }, invalid: false },
  ];
  const context = await toolContext(t);

  for (const value of cases) {
    let executions = 0;
    let completions = 0;
    const tool: HarnessTool = {
      definition: { name: "metadata_boundary", description: "metadata boundary", inputSchema: { type: "object" } },
      validate() {},
      resources() { return []; },
      async execute() {
        executions += 1;
        return { content: "kept result", isError: false };
      },
    };
    const coordinator = new ToolCoordinator(new ToolRegistry([tool]), {}, undefined, {
      afterResult(_invocation, result) {
        return { ...result, metadata: value.value as never };
      },
    });

    const result = await coordinator.execute(
      [{ callId: `metadata-${value.name}`, name: tool.definition.name, input: {}, index: 0 }],
      context,
      { completed() { completions += 1; } },
    );

    assert.equal(executions, 1, value.name);
    assert.equal(completions, 1, value.name);
    assert.equal(result[0]?.result.content, "kept result", value.name);
    assert.equal(result[0]?.result.isError, false, value.name);
    assert.equal((result[0]?.result.metadata as { truncated?: boolean } | undefined)?.truncated, true, value.name);
    assert.equal(
      (result[0]?.result.metadata as { invalid?: boolean } | undefined)?.invalid,
      value.invalid ? true : undefined,
      value.name,
    );
  }
});

test("tool result metadata stays inside the exact AgentSession V4 persistence depth", async (t) => {
  const context = await toolContext(t);
  for (const value of [
    { depth: 124, invalid: false },
    { depth: 125, invalid: true },
    { depth: 1_000, invalid: true },
  ]) {
    const metadata = deeplyNestedValue(value.depth);
    let resultProgress = 0;
    const tool: HarnessTool = {
      definition: { name: "v4_metadata", description: "V4 metadata", inputSchema: { type: "object" } },
      validate() {},
      resources() { return []; },
      async execute(_input, executionContext) {
        executionContext.reportProgress?.({
          type: "result",
          content: "partial result",
          isError: false,
          metadata: metadata as never,
        });
        return { content: "kept result", isError: false };
      },
    };
    const coordinator = new ToolCoordinator(new ToolRegistry([tool]), {}, undefined, {
      afterResult(_invocation, result) {
        return { ...result, metadata: metadata as never };
      },
    });
    const [completed] = await coordinator.execute(
      [{ callId: `depth-${value.depth}`, name: tool.definition.name, input: {}, index: 0 }],
      context,
      { progress(update) { if (update.progress.type === "result") resultProgress += 1; } },
    );
    assert.ok(completed);
    assert.equal(resultProgress, value.invalid ? 0 : 1, `progress depth ${value.depth}`);
    assert.equal(
      (completed.result.metadata as { invalid?: boolean } | undefined)?.invalid,
      value.invalid ? true : undefined,
      `depth ${value.depth}`,
    );

    assert.doesNotThrow(() => parseSessionV4CommitDraft({
      commitId: `commit-depth-${value.depth}`,
      committedAt: "2026-08-09T00:00:00.000Z",
      changes: [{
        type: "tool_effect_finished",
        effectId: `effect-depth-${value.depth}`,
        finishedAt: "2026-08-09T00:00:00.000Z",
        outcome: "succeeded",
        result: {
          type: "tool_result",
          callId: `depth-${value.depth}`,
          name: tool.definition.name,
          content: completed.result.content,
          isError: completed.result.isError,
          ...(completed.result.status === undefined ? {} : { status: completed.result.status }),
          ...(completed.result.summary === undefined ? {} : { summary: completed.result.summary }),
          ...(completed.result.metadata === undefined ? {} : { metadata: completed.result.metadata }),
        },
      }],
    }), `depth ${value.depth}`);
  }
});

test("malformed reduced usage and progress metadata stay isolated from completion", async (t) => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() { throw new Error("usage accessor must stay isolated"); },
  });
  const invalidUsageRaw = [deeplyNestedValue(20_000), cyclic, accessor];
  const context = await toolContext(t);

  for (const [index, raw] of invalidUsageRaw.entries()) {
    let completions = 0;
    const progress: string[] = [];
    const tool: HarnessTool = {
      definition: { name: "usage_boundary", description: "usage boundary", inputSchema: { type: "object" } },
      validate() {},
      resources() { return []; },
      async execute(_input, executionContext) {
        executionContext.reportProgress?.({
          type: "output",
          stream: "stdout",
          delta: "before",
          stdoutBytes: 6,
          stderrBytes: 0,
        });
        executionContext.reportProgress?.({
          type: "result",
          content: "ignored",
          isError: false,
          metadata: raw as never,
        });
        executionContext.reportProgress?.({
          type: "output",
          stream: "stdout",
          delta: "after",
          stdoutBytes: 11,
          stderrBytes: 0,
        });
        return { content: "kept result", isError: false };
      },
    };
    const coordinator = new ToolCoordinator(new ToolRegistry([tool]), {}, undefined, {
      afterResult(_invocation, result) {
        return {
          ...result,
          usage: { inputTokens: 1, totalTokens: 1, raw: raw as never },
        };
      },
    });

    const result = await coordinator.execute(
      [{ callId: `usage-${index}`, name: tool.definition.name, input: {}, index: 0 }],
      context,
      {
        progress(update) {
          progress.push(update.progress.type === "output" ? update.progress.delta : "unexpected result progress");
        },
        completed() { completions += 1; },
      },
    );

    assert.deepEqual(progress, ["before", "after"]);
    assert.equal(completions, 1);
    assert.equal(result[0]?.result.content, "kept result");
    assert.equal(result[0]?.result.isError, false);
    assert.equal(result[0]?.result.usage, undefined);
  }
});

test("tool completion snapshots hostile result fields without running accessors or rejecting the batch", async (t) => {
  type HostileCase = {
    name: string;
    result(accessed: () => void): unknown;
    expectedContent?: string;
    expectedError?: boolean;
  };
  const cases: HostileCase[] = [
    {
      name: "top-level accessors",
      result(accessed) {
        const value: Record<string, unknown> = { content: "kept result", isError: false };
        for (const field of [
          "contentBlocks",
          "nextActions",
          "addedToolNames",
          "artifacts",
          "usage",
          "metadata",
        ]) {
          Object.defineProperty(value, field, {
            enumerable: true,
            get() {
              accessed();
              throw new Error(`${field} accessor must not run`);
            },
          });
        }
        return value;
      },
    },
    {
      name: "top-level proxy getter",
      result(accessed) {
        return new Proxy({ content: "kept result", isError: false }, {
          get(target, property, receiver) {
            if (property === "then") return Reflect.get(target, property, receiver);
            accessed();
            throw new Error("top-level proxy getter must not run");
          },
        });
      },
    },
    {
      name: "uninspectable top-level proxy",
      result() {
        return new Proxy({ content: "kept result", isError: false }, {
          ownKeys() { throw new Error("top-level proxy cannot be inspected"); },
        });
      },
      expectedContent: "Tool returned invalid non-string content",
      expectedError: true,
    },
    {
      name: "content-block array proxy",
      result(accessed) {
        const contentBlocks = new Proxy([], {
          get(target, property, receiver) {
            if (property === "length") {
              accessed();
              throw new Error("contentBlocks length getter must not run");
            }
            return Reflect.get(target, property, receiver);
          },
        });
        return { content: "kept result", isError: false, contentBlocks };
      },
    },
    {
      name: "next-action array accessor",
      result(accessed) {
        const nextActions: unknown[] = [];
        Object.defineProperty(nextActions, "0", {
          enumerable: true,
          get() {
            accessed();
            throw new Error("nextActions accessor must not run");
          },
        });
        nextActions.length = 1;
        return { content: "kept result", isError: false, nextActions };
      },
    },
    {
      name: "added-tool array accessor",
      result(accessed) {
        const addedToolNames: unknown[] = [];
        Object.defineProperty(addedToolNames, "0", {
          enumerable: true,
          get() {
            accessed();
            throw new Error("addedToolNames accessor must not run");
          },
        });
        addedToolNames.length = 1;
        return { content: "kept result", isError: false, addedToolNames };
      },
    },
    {
      name: "artifact field accessor",
      result(accessed) {
        const artifact: Record<string, unknown> = {
          path: "/tmp/result",
          mediaType: "text/plain",
          bytes: 1,
        };
        Object.defineProperty(artifact, "id", {
          enumerable: true,
          get() {
            accessed();
            throw new Error("artifact id accessor must not run");
          },
        });
        return { content: "kept result", isError: false, artifacts: [artifact] };
      },
    },
    {
      name: "usage field accessor",
      result(accessed) {
        const usage: Record<string, unknown> = { inputTokens: 1, totalTokens: 1 };
        Object.defineProperty(usage, "raw", {
          enumerable: true,
          get() {
            accessed();
            throw new Error("usage raw accessor must not run");
          },
        });
        return { content: "kept result", isError: false, usage };
      },
    },
    {
      name: "revoked image array proxy",
      result() {
        const images = Proxy.revocable([], {});
        images.revoke();
        return { content: "kept result", isError: false, images: images.proxy };
      },
      expectedContent: "Tool returned invalid image content",
      expectedError: true,
    },
  ];
  const context = await toolContext(t);

  for (const value of cases) {
    let accesses = 0;
    let executions = 0;
    let completions = 0;
    const tool: HarnessTool = {
      definition: { name: "hostile_result", description: "hostile result", inputSchema: { type: "object" } },
      validate() {},
      resources() { return []; },
      async execute() {
        executions += 1;
        return { content: "executed", isError: false };
      },
    };
    const coordinator = new ToolCoordinator(new ToolRegistry([tool]), {}, undefined, {
      afterResult() { return value.result(() => { accesses += 1; }) as never; },
    });

    const [result] = await coordinator.execute(
      [{ callId: `hostile-${value.name}`, name: tool.definition.name, input: {}, index: 0 }],
      context,
      { completed() { completions += 1; } },
    );

    assert.equal(accesses, 0, value.name);
    assert.equal(executions, 1, value.name);
    assert.equal(completions, 1, value.name);
    assert.equal(result?.result.content, value.expectedContent ?? "kept result", value.name);
    assert.equal(result?.result.isError, value.expectedError ?? false, value.name);
  }
});

test("tool completion snapshots artifacts retained by the tool", async (t) => {
  const artifact = { id: "before", path: "/tmp/before", mediaType: "text/plain", bytes: 1 };
  const tool: HarnessTool = {
    definition: {
      name: "artifact_alias",
      description: "artifact alias",
      inputSchema: { type: "object" },
    },
    validate() {},
    resources() { return []; },
    async execute() {
      return { content: "ok", isError: false, artifacts: [artifact] };
    },
  };
  let completed: import("../../src/tools/types.js").ToolInvocationResult | undefined;
  const [result] = await new ToolCoordinator(
    new ToolRegistry([tool]),
    { completed(entry) { completed = entry; } },
  ).execute(
    [{ callId: "call", name: "artifact_alias", input: {}, index: 0 }],
    await toolContext(t),
  );

  artifact.id = "after";
  artifact.path = "/tmp/after";
  artifact.mediaType = "x/after";
  artifact.bytes = 999;

  const expected = [{ id: "before", path: "/tmp/before", mediaType: "text/plain", bytes: 1 }];
  assert.deepEqual(result?.result.artifacts, expected);
  assert.deepEqual(completed?.result.artifacts, expected);
  assert.notEqual(result?.result.artifacts?.[0], artifact);
});

test("tool completion omits oversized artifact fields and bounds aggregate artifact strings", async (t) => {
  const field = "x".repeat(2_048);
  const artifacts = [
    { id: "x".repeat(4_097), path: "/tmp/oversized", mediaType: "text/plain", bytes: 1 },
    ...Array.from({ length: 11 }, () => ({ id: field, path: field, mediaType: field, bytes: 1 })),
  ];
  const tool: HarnessTool = {
    definition: {
      name: "bounded_artifacts",
      description: "bounded artifacts",
      inputSchema: { type: "object" },
    },
    validate() {},
    resources() { return []; },
    async execute() { return { content: "ok", isError: false, artifacts }; },
  };

  const [result] = await new ToolCoordinator(new ToolRegistry([tool])).execute(
    [{ callId: "call", name: "bounded_artifacts", input: {}, index: 0 }],
    await toolContext(t),
  );

  assert.equal(result?.result.artifacts?.length, 10);
  assert.equal(result?.result.artifacts?.some((entry) => entry.id.length > 4_096), false);
  assert.equal(
    result?.result.artifacts?.reduce((total, entry) =>
      total + Buffer.byteLength(entry.id) + Buffer.byteLength(entry.path) + Buffer.byteLength(entry.mediaType), 0),
    60 * 1_024,
  );
});

test("tool completion applies the aggregate artifact-string budget across a dense batch", async (t) => {
  const field = "x".repeat(2_048);
  const tool: HarnessTool = {
    definition: {
      name: "dense_artifacts",
      description: "dense artifacts",
      inputSchema: { type: "object" },
    },
    validate() {},
    resources() { return []; },
    async execute() {
      return {
        content: "ok",
        isError: false,
        artifacts: Array.from({ length: 6 }, () => ({ id: field, path: field, mediaType: field, bytes: 1 })),
      };
    },
  };

  const results = await new ToolCoordinator(new ToolRegistry([tool])).execute(
    Array.from({ length: 8 }, (_, index) => ({
      callId: `call-${index}`,
      name: "dense_artifacts",
      input: {},
      index,
    })),
    await toolContext(t),
  );

  assert.deepEqual(results.map((entry) => entry.result.artifacts?.length), Array(8).fill(5));
  const aggregate = results.reduce((total, entry) => total + (entry.result.artifacts ?? []).reduce(
    (subtotal, artifact) => subtotal + Buffer.byteLength(artifact.id) +
      Buffer.byteLength(artifact.path) + Buffer.byteLength(artifact.mediaType),
    0,
  ), 0);
  assert.equal(aggregate, 240 * 1_024);
  assert.ok(aggregate <= 256 * 1_024);
});

test("tool lifecycle starts with effective transformed input and balances immediate failures", async (t) => {
  const trace: string[] = [];
  const tool: HarnessTool = {
    definition: {
      name: "echo",
      description: "echo",
      inputSchema: { type: "object", required: ["value"], properties: { value: { type: "string" } } },
    },
    recovery: { mode: "repeatable" },
    validate(input) {
      if (input === null || typeof input !== "object" || Array.isArray(input) || typeof input.value !== "string") {
        throw new Error("value must be a string");
      }
    },
    resources() { return []; },
    async execute(input) {
      trace.push(`execute:${(input as { value: string }).value}`);
      return { content: "ok", isError: false };
    },
  };
  const coordinator = new ToolCoordinator(
    new ToolRegistry([tool]),
    {},
    undefined,
    {
      beforeCall(invocation) {
        const value = (invocation.input as { value: string }).value;
        trace.push(`call:${invocation.callId}:${value}`);
        return {
          invocation: { ...invocation, input: { value: `${value}-patched` } },
          blocked: invocation.callId === "blocked",
          ...(invocation.callId === "blocked" ? { reason: "blocked" } : {}),
        };
      },
    },
  );

  const results = await coordinator.execute([
    { callId: "valid", name: "echo", input: { value: "original" }, index: 0 },
    { callId: "blocked", name: "echo", input: { value: "guarded" }, index: 1 },
    { callId: "invalid", name: "echo", input: {}, index: 2 },
    { callId: "unknown", name: "missing", input: { value: "unused" }, index: 3 },
  ], await toolContext(t), {
    started(invocation) {
      trace.push(`start:${invocation.callId}:${JSON.stringify(invocation.input)}:${invocation.recoveryMode}`);
    },
    dispatching(invocation) {
      trace.push(`dispatch:${invocation.callId}:${JSON.stringify(invocation.input)}:${invocation.recoveryMode}`);
    },
    completed(entry) {
      trace.push(`end:${entry.invocation.callId}`);
    },
  });

  assert.deepEqual(trace, [
    "call:valid:original",
    'start:valid:{"value":"original-patched"}:repeatable',
    "call:blocked:guarded",
    'start:blocked:{"value":"guarded-patched"}:repeatable',
    "end:blocked",
    "start:invalid:{}:repeatable",
    "end:invalid",
    'start:unknown:{"value":"unused"}:never_repeat',
    "end:unknown",
    'dispatch:valid:{"value":"original-patched"}:repeatable',
    "execute:original-patched",
    "end:valid",
  ]);
  assert.deepEqual(results.map((entry) => entry.result.isError), [false, true, true, true]);
});

test("legacy host interceptors retain input replacement compatibility with audit attribution", async (t) => {
  const transformed: string[][] = [];
  const executed: unknown[] = [];
  const tool: HarnessTool = {
    definition: { name: "legacy", description: "legacy", inputSchema: { type: "object" } },
    validate(input) {
      if (input === null || typeof input !== "object" || Array.isArray(input) || typeof input.value !== "string") {
        throw new Error("value required");
      }
    },
    resources() { return []; },
    async execute(input) {
      executed.push(structuredClone(input));
      return { content: "ok", isError: false };
    },
  };
  const coordinator = new ToolCoordinator(
    new ToolRegistry([tool]),
    {},
    undefined,
    {
      beforeCall(invocation) {
        return { invocation: { ...invocation, input: { value: "patched" } }, blocked: false };
      },
    },
  );

  const [result] = await coordinator.execute(
    [{ callId: "legacy-call", name: "legacy", input: { value: "original" }, index: 0 }],
    await toolContext(t),
    { transformed(_invocation, audit) { transformed.push(audit.map((entry) => entry.actor)); } },
  );

  assert.equal(result?.result.isError, false);
  assert.deepEqual(executed, [{ value: "patched" }]);
  assert.deepEqual(transformed, [["host"]]);
});

test("blocked and identity-changing tool reductions never execute", async (t) => {
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

test("transformed tool input is revalidated before resource claims or execution", async (t) => {
  const executed: unknown[] = [];
  const tool: HarnessTool = {
    definition: { name: "trusted", description: "trusted", inputSchema: { type: "object" } },
    validate(input) {
      if (input === null || typeof input !== "object" || Array.isArray(input) || input.ok !== true) {
        throw new Error("ok required");
      }
    },
    resources() { return []; },
    async execute(input) {
      executed.push(structuredClone(input));
      return { content: "executed", isError: false };
    },
  };
  const coordinator = new ToolCoordinator(
    new ToolRegistry([tool]),
    {},
    undefined,
    {
      beforeCall(invocation) {
        return { invocation: { ...invocation, input: { ok: false } }, blocked: false };
      },
    },
  );

  const [result] = await coordinator.execute(
    [{ callId: "trusted-call", name: "trusted", input: { ok: true }, index: 0 }],
    await toolContext(t),
  );
  assert.equal(result?.result.isError, true);
  assert.match(result?.result.content ?? "", /ok required/u);
  assert.deepEqual(executed, []);
});

test("blocked transformed reductions still validate and preserve their audit record", async (t) => {
  let executions = 0;
  const observed: ToolInvocation[] = [];
  const transformed: string[][] = [];
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
        return {
          invocation: { ...invocation, input: { ok: false } },
          blocked: true,
          reason: "blocked after transformation",
          transformations: [{ actor: "invalid-transform" }],
        };
      },
    },
  );
  const [blocked] = await invalidBlocked.execute(
    [{ callId: "blocked-invalid", name: "prepared_guard", input: raw, index: 0 }],
    await toolContext(t),
    {
      transformed(_invocation, audit) { transformed.push(audit.map((entry) => entry.actor)); },
      received(invocation) { observed.push(structuredClone(invocation)); },
    },
  );
  assert.match(blocked?.result.content ?? "", /ok required/u);
  assert.deepEqual(observed[0]?.input, { ok: false });
  assert.deepEqual(blocked?.invocation.input, { ok: false });
  assert.deepEqual(transformed, [["invalid-transform"]]);

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

test("audit observer failure never exposes the transformed input as received", async (t) => {
  let executions = 0;
  const received: ToolInvocation[] = [];
  const tool: HarnessTool = {
    definition: { name: "audited", description: "audited", inputSchema: { type: "object" } },
    validate(input) {
      if (input === null || typeof input !== "object" || Array.isArray(input) || typeof input.value !== "string") {
        throw new Error("value required");
      }
    },
    resources() { return []; },
    async execute() { executions += 1; return { content: "unsafe", isError: false }; },
  };
  const coordinator = new ToolCoordinator(
    new ToolRegistry([tool]),
    {},
    undefined,
    {
      beforeCall(invocation) {
        return {
          invocation: { ...invocation, input: { value: "transformed" } },
          blocked: false,
          transformations: [{ actor: "fixture-extension" }],
        };
      },
    },
  );

  const [failed] = await coordinator.execute(
    [{ callId: "audit-failure", name: "audited", input: { value: "original" }, index: 0 }],
    await toolContext(t),
    {
      transformed() { throw new Error("audit sink failed"); },
      received(invocation) { received.push(structuredClone(invocation)); },
    },
  );

  assert.match(failed?.result.content ?? "", /audit sink failed/u);
  assert.deepEqual(failed?.invocation.input, { value: "original" });
  assert.deepEqual(received.map((entry) => entry.input), [{ value: "original" }]);
  assert.equal(executions, 0);
});
