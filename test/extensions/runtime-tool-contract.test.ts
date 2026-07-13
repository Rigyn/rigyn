import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { loadRuntimeExtensions, type RuntimeExtensionHost } from "../../src/extensions/runtime.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { DirectProcessRunner } from "../../src/process/index.js";
import { HarnessService } from "../../src/service/harness.js";
import { SessionStore } from "../../src/storage/store.js";
import { ScriptedProvider } from "../../src/testing/scripted-provider.js";
import { sha256 } from "../../src/tools/hash.js";
import { ToolCoordinator, ToolRegistry, WorkspaceBoundary } from "../../src/tools/index.js";
import type { ToolContext, ToolInvocation } from "../../src/tools/types.js";

type Cleanup = () => void | Promise<void>;
const cleanupStacks = new WeakMap<TestContext, Cleanup[]>();

function afterCleanup(t: TestContext, cleanup: Cleanup): void {
  let stack = cleanupStacks.get(t);
  if (stack === undefined) {
    stack = [];
    cleanupStacks.set(t, stack);
    t.after(async () => {
      for (let index = stack!.length - 1; index >= 0; index -= 1) await stack![index]!();
    });
  }
  stack.push(cleanup);
}

async function fixture(t: TestContext, source: string): Promise<{
  context: ToolContext;
  host: RuntimeExtensionHost;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-tool-contract-"));
  afterCleanup(t, async () => await rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "extension.mjs");
  await writeFile(sourcePath, source);
  const host = await loadRuntimeExtensions([{
    extensionId: "tool-contract",
    sourcePath,
    sha256: sha256(source),
  }], { workspace: root });
  afterCleanup(t, async () => await host.close());
  return {
    host,
    root,
    context: {
      workspace: await WorkspaceBoundary.create(root),
      runner: new DirectProcessRunner(),
      signal: new AbortController().signal,
      runId: "run-tool-contract",
      threadId: "thread-tool-contract",
    },
  };
}

function runtimeInterceptors(host: RuntimeExtensionHost) {
  return {
    beforeCall: async (invocation: ToolInvocation, context: ToolContext) =>
      await host.reduceToolCall({ ...invocation, threadId: context.threadId, runId: context.runId, branch: "main" }, context.signal),
    afterResult: async (invocation: ToolInvocation, result: Parameters<RuntimeExtensionHost["reduceToolResult"]>[0]["result"], context: ToolContext) =>
      await host.reduceToolResult({ invocation, result }, context.signal),
  };
}

test("runtime tool recovery fields use the host's bounded top-level contract", async (t) => {
  const source = `export default (api) => {
    const register = (name, result) => api.registerTool({
      name,
      description: name,
      inputSchema: { type: "object" },
      execute() { return result; }
    });
    register("valid_result", { content: "details", isError: false, status: "warning", summary: "Needs review", nextActions: ["Inspect the warning"] });
    register("invalid_status", { content: "details", isError: false, status: "not_found" });
    register("invalid_summary", { content: "details", isError: false, summary: "" });
    register("invalid_actions", { content: "details", isError: false, nextActions: [42] });
  };\n`;
  const { context, host } = await fixture(t, source);
  const coordinator = new ToolCoordinator(new ToolRegistry(host.tools()));
  const results = await coordinator.execute([
    { callId: "valid-result", name: "valid_result", input: {}, index: 0 },
    { callId: "invalid-status", name: "invalid_status", input: {}, index: 1 },
    { callId: "invalid-summary", name: "invalid_summary", input: {}, index: 2 },
    { callId: "invalid-actions", name: "invalid_actions", input: {}, index: 3 },
  ], context);

  assert.equal(results[0]?.result.isError, false);
  assert.equal(results[0]?.result.status, "warning");
  assert.equal(results[0]?.result.summary, "Needs review");
  assert.deepEqual(results[0]?.result.nextActions, ["Inspect the warning"]);
  assert.ok(results.slice(1).every((entry) => entry.result.isError));
  assert.match(results[1]?.result.content ?? "", /status must be success, warning, or error/u);
  assert.match(results[2]?.result.content ?? "", /summary must be a non-empty string/u);
  assert.match(results[3]?.result.content ?? "", /nextActions\[0\] must be a non-empty string/u);
});

test("prepared runtime input is revalidated and becomes the sole resource, durable, reducer, execution, and result value", async (t) => {
  const source = `export default (api) => {
    const log = (phase, value) => globalThis.__runtimeToolContractLog.push([phase, structuredClone(value)]);
    api.registerTool({
      name: "compat_tool",
      description: "normalizes a legacy path",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path", "mode"],
        properties: { path: { type: "string" }, mode: { type: "string" } }
      },
      prepareInput(input) {
        log("prepare", input);
        input.path = "normalized/" + input.legacy;
        input.mode = "prepared";
        delete input.legacy;
        return input;
      },
      validate(input) { log("validate", input); },
      resources(input) {
        log("resources", input);
        return [{ kind: "file", key: input.path, mode: "read" }];
      },
      execute(input) {
        log("execute", input);
        return { content: input.path + ":" + input.mode, isError: false };
      }
    });
    api.on("tool_call", (event) => {
      log("identity", { threadId: event.threadId, runId: event.runId, branch: event.branch });
      log("reducer", event.input);
      event.input.path += ".reduced";
      event.input.mode = "final";
    });
    api.on("tool_result", (event) => {
      log("result", event.invocation.input);
      return { content: event.result.content + ":post" };
    });
  };\n`;
  const log: Array<[string, unknown]> = [];
  (globalThis as Record<string, unknown>).__runtimeToolContractLog = log;
  t.after(() => { delete (globalThis as Record<string, unknown>).__runtimeToolContractLog; });
  const { context, host } = await fixture(t, source);
  assert.deepEqual(host.diagnostics(), []);
  const received: ToolInvocation[] = [];
  const completed: ToolInvocation[] = [];
  const coordinator = new ToolCoordinator(
    new ToolRegistry(host.tools()),
    {},
    undefined,
    runtimeInterceptors(host),
  );

  const rawInput = { legacy: "note.txt" };
  const [result] = await coordinator.execute(
    [{ callId: "compat-call", name: "compat_tool", input: rawInput, index: 0 }],
    context,
    {
      received(invocation) {
        received.push(structuredClone(invocation));
        log.push(["received", structuredClone(invocation.input)]);
      },
      completed(entry) { completed.push(structuredClone(entry.invocation)); },
    },
  );

  const finalInput = { path: "normalized/note.txt.reduced", mode: "final" };
  assert.deepEqual(received.map((entry) => entry.input), [finalInput]);
  assert.deepEqual(result?.invocation.input, finalInput);
  assert.deepEqual(completed.map((entry) => entry.input), [finalInput]);
  assert.equal(result?.result.isError, false);
  assert.equal(result?.result.content, "normalized/note.txt.reduced:final:post");
  assert.deepEqual(log, [
    ["prepare", { legacy: "note.txt" }],
    ["validate", { path: "normalized/note.txt", mode: "prepared" }],
    ["identity", { threadId: "thread-tool-contract", runId: "run-tool-contract", branch: "main" }],
    ["reducer", { path: "normalized/note.txt", mode: "prepared" }],
    ["validate", finalInput],
    ["received", finalInput],
    ["resources", finalInput],
    ["execute", finalInput],
    ["result", finalInput],
  ]);
});

test("prepared runtime input is persisted durably after all input reducers", async (t) => {
  const source = `export default (api) => {
    api.registerTool({
      name: "durable_prepared",
      description: "durable prepared input",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "string" } }
      },
      prepareInput(input) { return { value: "prepared:" + input.legacy }; },
      execute(input) { return { content: input.value, isError: false }; }
    });
    api.on("tool_call", (event) => { event.input.value += ":reduced"; });
  };\n`;
  const { host, root } = await fixture(t, source);
  const provider = new ScriptedProvider({
    id: "durable-prepared-provider",
    models: [{ id: "durable-prepared-model", capabilities: { tools: "supported" } }],
    scripts: [
      {
        kind: "turn",
        content: [{
          type: "tool_call",
          id: "durable-prepared-call",
          name: "durable_prepared",
          arguments: { legacy: "value" },
        }],
        terminal: { type: "finish", reason: "tool_calls" },
      },
      { kind: "turn", content: [{ type: "text", text: "finished" }] },
    ],
  });
  const store = new SessionStore(join(root, "sessions.sqlite"));
  afterCleanup(t, () => store.close());
  const service = new HarnessService({
    store,
    workspace: root,
    providers: new ProviderRegistry([provider]),
    runtimeExtensions: host,
    extraTools: host.tools(),
    projectTrusted: false,
  });
  await service.initialize({ skills: [] });
  afterCleanup(t, async () => await service.close("runtime_tool_contract_cleanup"));

  const run = await service.run({
    prompt: "run the compatibility tool",
    provider: provider.id,
    model: "durable-prepared-model",
  });
  const requested = store.listEvents(run.threadId).find((entry) => entry.event.type === "tool_requested");
  assert.deepEqual(requested?.event.type === "tool_requested" ? requested.event.input : undefined, {
    value: "prepared:value:reduced",
  });
  const wire = JSON.stringify(provider.capturedRequests()[1]);
  assert.match(wire, /prepared:value:reduced/u);
});

test("prepared and intercepted inputs are detached from asynchronously mutated owner objects", async (t) => {
  const source = `export default (api) => {
    const seen = (phase, input) => globalThis.__runtimeOwnedInputLog.push([phase, structuredClone(input)]);
    api.registerTool({
      name: "owned_input",
      description: "owner detachment fixture",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "string" } }
      },
      prepareInput() { return globalThis.__runtimeOwnedPrepared; },
      validate(input) { seen("validate", input); },
      resources(input) { seen("resources", input); return []; },
      execute(input) { seen("execute", input); return { content: input.value, isError: false }; }
    });
  };\n`;
  const prepared = { value: "prepared" };
  const intercepted = { value: "intercepted" };
  const log: Array<[string, unknown]> = [];
  Object.assign(globalThis as Record<string, unknown>, {
    __runtimeOwnedPrepared: prepared,
    __runtimeOwnedInputLog: log,
  });
  t.after(() => {
    delete (globalThis as Record<string, unknown>).__runtimeOwnedPrepared;
    delete (globalThis as Record<string, unknown>).__runtimeOwnedInputLog;
  });
  const { context, host } = await fixture(t, source);
  const received: unknown[] = [];
  const coordinator = new ToolCoordinator(
    new ToolRegistry(host.tools()),
    {},
    undefined,
    {
      async beforeCall(invocation) {
        queueMicrotask(() => { prepared.value = "late-prepared-mutation"; });
        await Promise.resolve();
        assert.deepEqual(invocation.input, { value: "prepared" });
        return { invocation: { ...invocation, input: intercepted }, blocked: false };
      },
    },
  );

  const [result] = await coordinator.execute(
    [{ callId: "owned-call", name: "owned_input", input: {}, index: 0 }],
    context,
    {
      async received(invocation) {
        queueMicrotask(() => { intercepted.value = "late-interceptor-mutation"; });
        await Promise.resolve();
        received.push(structuredClone(invocation.input));
      },
    },
  );

  assert.equal(prepared.value, "late-prepared-mutation");
  assert.equal(intercepted.value, "late-interceptor-mutation");
  assert.deepEqual(received, [{ value: "intercepted" }]);
  assert.deepEqual(result?.invocation.input, { value: "intercepted" });
  assert.equal(result?.result.content, "intercepted");
  assert.deepEqual(log, [
    ["validate", { value: "prepared" }],
    ["validate", { value: "intercepted" }],
    ["resources", { value: "intercepted" }],
    ["execute", { value: "intercepted" }],
  ]);
});

test("invalid prepared or subsequently mutated input fails closed before policy and execution", async (t) => {
  const source = `export default (api) => {
    const register = (name, prepareInput) => api.registerTool({
      name,
      description: name,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "string" } }
      },
      prepareInput,
      resources() { globalThis.__runtimeInvalidPrepared.push("resources:" + name); return []; },
      execute() { globalThis.__runtimeInvalidPrepared.push("execute:" + name); return { content: "unsafe", isError: false }; }
    });
    register("invalid_json", () => ({ value: undefined }));
    register("invalid_null", () => null);
    register("invalid_schema", () => ({ value: 42 }));
    register("invalid_reduced", () => ({ value: "valid" }));
    api.on("tool_call", (event) => {
      globalThis.__runtimeInvalidPrepared.push("reducer:" + event.name);
      if (event.name === "invalid_reduced") event.input.value = 42;
    });
  };\n`;
  const phases: string[] = [];
  (globalThis as Record<string, unknown>).__runtimeInvalidPrepared = phases;
  t.after(() => { delete (globalThis as Record<string, unknown>).__runtimeInvalidPrepared; });
  const { context, host } = await fixture(t, source);
  const coordinator = new ToolCoordinator(
    new ToolRegistry(host.tools()),
    {},
    undefined,
    runtimeInterceptors(host),
  );

  const results = await coordinator.execute([
    { callId: "invalid-json", name: "invalid_json", input: {}, index: 0 },
    { callId: "invalid-null", name: "invalid_null", input: {}, index: 1 },
    { callId: "invalid-schema", name: "invalid_schema", input: {}, index: 2 },
    { callId: "invalid-reduced", name: "invalid_reduced", input: {}, index: 3 },
  ], context);

  assert.equal(results.length, 4);
  assert.ok(results.every((entry) => entry.result.isError));
  assert.match(results[0]?.result.content ?? "", /non-JSON input/u);
  assert.match(results[1]?.result.content ?? "", /Expected object/u);
  assert.match(results[2]?.result.content ?? "", /Expected string/u);
  assert.match(results[3]?.result.content ?? "", /Expected string/u);
  assert.deepEqual(phases, ["reducer:invalid_reduced"]);
});

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("a sequential runtime tool is a failure-isolated barrier while neighboring safe tools remain parallel", { timeout: 5_000 }, async (t) => {
  const source = `export default (api) => {
    const register = (name, executionMode, fails = false) => api.registerTool({
      name,
      description: name,
      inputSchema: { type: "object" },
      ...(executionMode === undefined ? {} : { executionMode }),
      async execute() {
        await globalThis.__runtimeToolSchedule(name);
        if (fails) throw new Error("isolated sequential failure");
        return { content: name, isError: false };
      }
    });
    register("parallel_before_a", "parallel");
    register("parallel_before_b");
    register("sequential_middle", "sequential", true);
    register("parallel_after_a", "parallel");
    register("parallel_after_b");
  };\n`;
  const { context, host } = await fixture(t, source);
  const names = [
    "parallel_before_a",
    "parallel_before_b",
    "sequential_middle",
    "parallel_after_a",
    "parallel_after_b",
  ];
  const started = new Map(names.map((name) => [name, deferred()]));
  const released = new Map(names.map((name) => [name, deferred()]));
  const timeline: string[] = [];
  (globalThis as Record<string, unknown>).__runtimeToolSchedule = async (name: string) => {
    timeline.push(`start:${name}`);
    started.get(name)!.resolve();
    await released.get(name)!.promise;
    timeline.push(`end:${name}`);
  };
  t.after(() => { delete (globalThis as Record<string, unknown>).__runtimeToolSchedule; });
  const coordinator = new ToolCoordinator(
    new ToolRegistry(host.tools()),
  );
  const execution = coordinator.execute(names.map((name, index) => ({
    callId: `call-${index}`,
    name,
    input: {},
    index,
  })), context);

  await Promise.all([started.get("parallel_before_a")!.promise, started.get("parallel_before_b")!.promise]);
  assert.deepEqual(new Set(timeline), new Set(["start:parallel_before_a", "start:parallel_before_b"]));
  released.get("parallel_before_a")!.resolve();
  released.get("parallel_before_b")!.resolve();

  await started.get("sequential_middle")!.promise;
  assert.equal(timeline.some((entry) => entry.startsWith("start:parallel_after_")), false);
  released.get("sequential_middle")!.resolve();

  await Promise.all([started.get("parallel_after_a")!.promise, started.get("parallel_after_b")!.promise]);
  released.get("parallel_after_a")!.resolve();
  released.get("parallel_after_b")!.resolve();
  const results = await execution;

  assert.deepEqual(results.map((entry) => entry.invocation.name), names);
  assert.deepEqual(results.map((entry) => entry.result.isError), [false, false, true, false, false]);
  assert.match(results[2]?.result.content ?? "", /isolated sequential failure/u);
  const middleStart = timeline.indexOf("start:sequential_middle");
  const middleEnd = timeline.indexOf("end:sequential_middle");
  assert.ok(middleStart > timeline.indexOf("end:parallel_before_a"));
  assert.ok(middleStart > timeline.indexOf("end:parallel_before_b"));
  assert.ok(middleEnd < timeline.indexOf("start:parallel_after_a"));
  assert.ok(middleEnd < timeline.indexOf("start:parallel_after_b"));
});

test("runtime activation rejects malformed preparation and execution-mode registrations transactionally", async (t) => {
  const malformedPreparation = `export default (api) => {
    api.registerTool({
      name: "first_tool",
      description: "must roll back",
      inputSchema: { type: "object" },
      execute() { return { content: "first", isError: false }; }
    });
    api.registerTool({
      name: "bad_tool",
      description: "invalid preparation",
      inputSchema: { type: "object" },
      prepareInput: "not-a-function",
      execute() { return { content: "bad", isError: false }; }
    });
  };\n`;
  const malformedMode = `export default (api) => {
    api.registerTool({
      name: "first_tool",
      description: "must roll back",
      inputSchema: { type: "object" },
      execute() { return { content: "first", isError: false }; }
    });
    api.registerTool({
      name: "bad_tool",
      description: "invalid mode",
      inputSchema: { type: "object" },
      executionMode: "serial",
      execute() { return { content: "bad", isError: false }; }
    });
  };\n`;
  const preparation = await fixture(t, malformedPreparation);
  const mode = await fixture(t, malformedMode);
  assert.deepEqual(preparation.host.tools(), []);
  assert.match(preparation.host.diagnostics()[0]?.message ?? "", /prepareInput must be a function/u);
  assert.deepEqual(mode.host.tools(), []);
  assert.match(mode.host.diagnostics()[0]?.message ?? "", /executionMode is invalid/u);
});
