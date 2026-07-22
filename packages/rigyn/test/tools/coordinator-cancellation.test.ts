import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DirectProcessRunner } from "../../src/process/index.js";
import {
  ToolCoordinator,
  ToolRegistry,
  WorkspaceBoundary,
} from "../../src/tools/index.js";
import type {
  HarnessTool,
  ResourceClaim,
  ToolContext,
  ToolInvocationResult,
  ToolResult,
} from "../../src/tools/types.js";
import type {
  ToolCoordinatorInterceptor,
  ToolCoordinatorObserver,
} from "../../src/tools/coordinator.js";

type LifecyclePhase =
  | "prepareInput"
  | "beforeCall"
  | "received"
  | "resources"
  | "started"
  | "execute"
  | "progress"
  | "afterResult"
  | "completed";

function nonCooperativeGate() {
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const pending = new Promise<never>(() => undefined);
  return {
    entered,
    wait<T = never>(): Promise<T> {
      markEntered();
      return pending;
    },
  };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 1_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function context(
  t: { after(callback: () => Promise<void>): void },
  signal: AbortSignal,
): Promise<ToolContext> {
  const root = await mkdtemp(join(tmpdir(), "harness-tool-cancellation-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return {
    workspace: await WorkspaceBoundary.create(root),
    runner: new DirectProcessRunner(),
    signal,
    runId: "run",
    threadId: "thread",
  };
}

for (const phase of [
  "prepareInput",
  "beforeCall",
  "received",
  "resources",
  "started",
  "execute",
  "progress",
  "afterResult",
  "completed",
] as const satisfies readonly LifecyclePhase[]) {
  test(`coordinator aborts a non-cooperative ${phase} hook`, async (t) => {
    const gate = nonCooperativeGate();
    const controller = new AbortController();
    const tool: HarnessTool = {
      definition: { name: "blocked", description: "blocked lifecycle hook", inputSchema: { type: "object" } },
      ...(phase === "prepareInput"
        ? { prepareInput: async () => await gate.wait() }
        : {}),
      validate() {},
      async resources() {
        return phase === "resources" ? await gate.wait<ResourceClaim[]>() : [];
      },
      async execute(_input, selected) {
        if (phase === "execute") return await gate.wait<ToolResult>();
        if (phase === "progress") {
          selected.reportProgress?.({
            type: "result",
            content: "working",
            isError: false,
          });
        }
        return { content: "done", isError: false };
      },
    };
    const configuredObserver: ToolCoordinatorObserver = {
      ...(phase === "received" ? { received: async () => await gate.wait() } : {}),
      ...(phase === "progress" ? { progress: async () => await gate.wait() } : {}),
    };
    const executionObserver: ToolCoordinatorObserver = {
      ...(phase === "started" ? { started: async () => await gate.wait() } : {}),
      ...(phase === "completed" ? { completed: async () => await gate.wait() } : {}),
    };
    const interceptor: ToolCoordinatorInterceptor = {
      ...(phase === "beforeCall" ? { beforeCall: async () => await gate.wait() } : {}),
      ...(phase === "afterResult" ? { afterResult: async () => await gate.wait() } : {}),
    };
    const coordinator = new ToolCoordinator(
      new ToolRegistry([tool]),
      configuredObserver,
      undefined,
      interceptor,
    );
    const running = coordinator.execute(
      [{ callId: "blocked", name: "blocked", input: {}, index: 0 }],
      await context(t, controller.signal),
      executionObserver,
    );

    await within(gate.entered, `${phase} hook entry`);
    const reason = new Error(`cancel ${phase}`);
    controller.abort(reason);
    await assert.rejects(
      within(running, `${phase} cancellation`),
      (error) => error === reason,
    );
  });
}

test("an aborted non-cooperative tool releases the batch and applies queued active tools", async (t) => {
  const gate = nonCooperativeGate();
  const controller = new AbortController();
  const hung: HarnessTool = {
    definition: { name: "hung", description: "never settles", inputSchema: { type: "object" } },
    validate() {},
    resources() { return []; },
    async execute() { return await gate.wait<ToolResult>(); },
  };
  const recovery: HarnessTool = {
    definition: { name: "recovery", description: "recovers", inputSchema: { type: "object" } },
    validate() {},
    resources() { return []; },
    async execute() { return { content: "recovered", isError: false }; },
  };
  const coordinator = new ToolCoordinator(
    new ToolRegistry([hung, recovery]),
    {},
    undefined,
    {},
    { activeTools: ["hung"] },
  );
  const running = coordinator.execute(
    [{ callId: "hung", name: "hung", input: {}, index: 0 }],
    await context(t, controller.signal),
  );

  await within(gate.entered, "hung tool entry");
  assert.deepEqual(coordinator.queueActiveTools(["recovery"]), ["recovery"]);
  assert.throws(() => coordinator.turnSnapshot(), /while a tool batch is executing/u);
  const reason = new Error("cancel hung tool");
  controller.abort(reason);
  await assert.rejects(within(running, "hung tool cancellation"), (error) => error === reason);

  assert.deepEqual(coordinator.turnSnapshot(), {
    definitions: [recovery.definition],
    names: ["recovery"],
    revision: 1,
    changed: true,
  });
  const result: ToolInvocationResult[] = await coordinator.execute(
    [{ callId: "recovery", name: "recovery", input: {}, index: 0 }],
    await context(t, new AbortController().signal),
  );
  assert.equal(result[0]?.result.content, "recovered");
});
