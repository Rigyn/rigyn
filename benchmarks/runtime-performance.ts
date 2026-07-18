import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { loadRuntime, type LoadedRuntime } from "../src/cli/runtime.js";
import type { RuntimeEvent } from "../src/core/events.js";
import { RpcRuntimeDispatcher, type RpcRuntimePeer } from "../src/interfaces/rpc-runtime.js";
import type { RpcRequest } from "../src/interfaces/rpc.js";
import { StoredConversation } from "../src/service/session-runtime.js";

const DEFAULT_SAMPLES = 3;
const STARTUP_EXTENSION_COUNTS = [0, 10, 50] as const;
const LARGE_PACKAGE_ENTRY_COUNT = 8;
const COMMANDS_PER_LARGE_ENTRY = 32;

export interface RuntimePerformanceScenario {
  id: string;
  operation: "startup" | "reload" | "resume" | "rpc-replay" | "event-page";
  fixture: {
    extensionCount?: number;
    runtimeEntryCount?: number;
    commandCount?: number;
    eventCount?: number;
    pageLimit?: number;
    branchCount?: number;
    toolProgressCount?: number;
    cold?: boolean;
    materializedRowBudget?: number;
  };
  samplesMs: number[];
  minimumMs: number;
  medianMs: number;
  p95Ms: number;
  maximumMs: number;
  ceilingMs: number;
  passed: boolean;
}

export interface RuntimePerformanceReport {
  schemaVersion: 1;
  suite: "runtime-performance-v1";
  purpose: "runtime-regression-guard";
  deterministicFixtures: true;
  samplesPerScenario: number;
  environment: {
    platform: NodeJS.Platform;
    architecture: string;
    node: string;
  };
  scenarios: RuntimePerformanceScenario[];
  summary: {
    scenarios: number;
    passed: number;
  };
}

export interface RuntimePerformanceOptions {
  samples?: number;
}

interface MeasurementFixture {
  root: string;
  workspace: string;
  configHome: string;
  stateHome: string;
}

async function fixture(prefix: string): Promise<MeasurementFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const workspace = join(root, "workspace");
  const configHome = join(root, "config");
  const stateHome = join(root, "state");
  await mkdir(workspace, { recursive: true });
  await mkdir(configHome, { mode: 0o700 });
  await mkdir(stateHome, { mode: 0o700 });
  await mkdir(join(configHome, "rigyn"), { mode: 0o700 });
  await mkdir(join(configHome, "rigyn", "extensions"), { mode: 0o700 });
  return { root, workspace, configHome, stateHome };
}

async function withEnvironment<T>(value: MeasurementFixture, operation: () => Promise<T>): Promise<T> {
  const previous = {
    config: process.env.XDG_CONFIG_HOME,
    state: process.env.XDG_STATE_HOME,
    credentialKey: process.env.RIGYN_CREDENTIAL_KEY,
  };
  process.env.XDG_CONFIG_HOME = value.configHome;
  process.env.XDG_STATE_HOME = value.stateHome;
  process.env.RIGYN_CREDENTIAL_KEY = Buffer.alloc(32, 23).toString("base64url");
  try {
    return await operation();
  } finally {
    if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.config;
    if (previous.state === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous.state;
    if (previous.credentialKey === undefined) delete process.env.RIGYN_CREDENTIAL_KEY;
    else process.env.RIGYN_CREDENTIAL_KEY = previous.credentialKey;
  }
}

function runtimeOptions(workspace: string) {
  return {
    workspace,
    extensions: true,
    extensionRuntime: true,
    skills: false,
    promptTemplates: false,
    themes: false,
    recover: false,
    managedExtensionLifecycle: false,
  } as const;
}

async function writeExtension(root: string, id: string, source: string): Promise<void> {
  const directory = join(root, id);
  await mkdir(join(directory, "runtime"), { recursive: true });
  await writeFile(join(directory, "extension.json"), `${JSON.stringify({
    schemaVersion: 1,
    id,
    name: `Benchmark ${id}`,
    version: "1.0.0",
    contributions: { runtime: [{ path: "runtime/index.mjs" }] },
  }, null, 2)}\n`);
  await writeFile(join(directory, "runtime", "index.mjs"), source);
}

function commandExtensionSource(id: string): string {
  return `export default (api) => api.registerCommand({ name: ${JSON.stringify(`bench-${id}`)}, execute() { return "ok"; } });\n`;
}

async function startupSample(extensionCount: number): Promise<number> {
  const value = await fixture(`rigyn-startup-${extensionCount}-`);
  let runtime: LoadedRuntime | undefined;
  try {
    const extensionRoot = join(value.configHome, "rigyn", "extensions");
    for (let index = 0; index < extensionCount; index += 1) {
      const id = `startup-${String(index).padStart(2, "0")}`;
      await writeExtension(extensionRoot, id, commandExtensionSource(id));
    }
    return await withEnvironment(value, async () => {
      const started = performance.now();
      runtime = await loadRuntime(runtimeOptions(value.workspace));
      const elapsed = performance.now() - started;
      if (runtime.runtimeExtensions.commands().length !== extensionCount) {
        throw new Error(`Startup fixture activated ${runtime.runtimeExtensions.commands().length} of ${extensionCount} commands`);
      }
      return elapsed;
    });
  } finally {
    await runtime?.close().catch(() => undefined);
    await rm(value.root, { recursive: true, force: true });
  }
}

function largeEntrySource(entry: number, version: string): string {
  const registrations = Array.from({ length: COMMANDS_PER_LARGE_ENTRY }, (_, index) => {
    const name = `large-${entry}-${index}`;
    return `api.registerCommand({ name: ${JSON.stringify(name)}, execute() { return ${JSON.stringify(version)}; } });`;
  }).join("\n  ");
  return `export default function activate(api) {\n  ${registrations}\n}\n`;
}

async function writeLargePackage(extensionRoot: string, version: string): Promise<void> {
  const directory = join(extensionRoot, "large-package");
  await mkdir(join(directory, "runtime"), { recursive: true });
  const runtime = Array.from({ length: LARGE_PACKAGE_ENTRY_COUNT }, (_, index) => ({ path: `runtime/entry-${index}.mjs` }));
  await writeFile(join(directory, "extension.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: "large-package",
    name: "Large benchmark package",
    version: "1.0.0",
    contributions: { runtime },
  }, null, 2)}\n`);
  for (let index = 0; index < LARGE_PACKAGE_ENTRY_COUNT; index += 1) {
    await writeFile(join(directory, "runtime", `entry-${index}.mjs`), largeEntrySource(index, version));
  }
}

async function reloadSample(): Promise<number> {
  const value = await fixture("rigyn-reload-large-");
  let runtime: LoadedRuntime | undefined;
  try {
    const extensionRoot = join(value.configHome, "rigyn", "extensions");
    await writeLargePackage(extensionRoot, "before");
    return await withEnvironment(value, async () => {
      runtime = await loadRuntime(runtimeOptions(value.workspace));
      await writeLargePackage(extensionRoot, "after");
      const started = performance.now();
      await runtime.reload();
      const elapsed = performance.now() - started;
      const expected = LARGE_PACKAGE_ENTRY_COUNT * COMMANDS_PER_LARGE_ENTRY;
      if (runtime.runtimeExtensions.commands().length !== expected) {
        throw new Error(`Reload fixture activated ${runtime.runtimeExtensions.commands().length} of ${expected} commands`);
      }
      return elapsed;
    });
  } finally {
    await runtime?.close().catch(() => undefined);
    await rm(value.root, { recursive: true, force: true });
  }
}

function messageEvent(index: number): RuntimeEvent {
  return {
    type: "message_appended",
    message: {
      id: `benchmark-message-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `Deterministic resume fixture message ${index}` }],
      createdAt: new Date(index * 1_000).toISOString(),
    },
  };
}

async function seedSession(value: MeasurementFixture, eventCount: number): Promise<string> {
  let runtime: LoadedRuntime | undefined;
  return await withEnvironment(value, async () => {
    try {
      runtime = await loadRuntime(runtimeOptions(value.workspace));
      const thread = await runtime.service.createSession({ threadId: `resume-${eventCount}` });
      for (let offset = 0; offset < eventCount; offset += 500) {
        runtime.store.appendEvents({
          threadId: thread.threadId,
          events: Array.from(
            { length: Math.min(500, eventCount - offset) },
            (_, index) => messageEvent(offset + index),
          ),
        });
      }
      return thread.threadId;
    } finally {
      await runtime?.close().catch(() => undefined);
    }
  });
}

async function resumeSample(eventCount: number): Promise<number> {
  const value = await fixture(`rigyn-resume-${eventCount}-`);
  let runtime: LoadedRuntime | undefined;
  try {
    const threadId = await seedSession(value, eventCount);
    return await withEnvironment(value, async () => {
      const started = performance.now();
      runtime = await loadRuntime(runtimeOptions(value.workspace));
      const thread = runtime.store.getThread(threadId);
      const conversation = await new StoredConversation(runtime.store).loadContext(
        threadId,
        thread.defaultBranch,
        "fixture",
        AbortSignal.timeout(30_000),
      );
      const elapsed = performance.now() - started;
      if (conversation.messages.length !== eventCount) {
        throw new Error(`Resume fixture projected ${conversation.messages.length} of ${eventCount} messages`);
      }
      return elapsed;
    });
  } finally {
    await runtime?.close().catch(() => undefined);
    await rm(value.root, { recursive: true, force: true });
  }
}

type ColdPageFixture = "single-branch" | "unrelated-branches" | "tool-progress";

interface ColdPageSeed {
  threadId: string;
  branch: string;
  afterSequence: number;
  expectedEventId: string;
}

function appendBenchmarkWarnings(runtime: LoadedRuntime, threadId: string, count: number, branch?: string): string {
  let eventId: string | undefined;
  for (let offset = 0; offset < count; offset += 500) {
    const events = runtime.store.appendEvents({
      threadId,
      ...(branch === undefined ? {} : { branch }),
      events: Array.from({ length: Math.min(500, count - offset) }, (_, index) => ({
        type: "warning" as const,
        code: `benchmark-warning-${offset + index}`,
        message: `benchmark-warning-${offset + index}`,
      })),
    });
    eventId = events.at(-1)?.eventId;
  }
  if (eventId === undefined) throw new Error("Cold page warning fixture produced no events");
  return eventId;
}

async function seedColdPageSession(value: MeasurementFixture, kind: ColdPageFixture): Promise<ColdPageSeed> {
  let runtime: LoadedRuntime | undefined;
  return await withEnvironment(value, async () => {
    try {
      runtime = await loadRuntime(runtimeOptions(value.workspace));
      const thread = await runtime.service.createSession({ threadId: `cold-page-${kind}` });
      if (kind === "single-branch") {
        const expectedEventId = appendBenchmarkWarnings(runtime, thread.threadId, 20_000);
        return { threadId: thread.threadId, branch: "main", afterSequence: 19_999, expectedEventId };
      }
      if (kind === "unrelated-branches") {
        const root = runtime.store.appendEvent({
          threadId: thread.threadId,
          event: { type: "warning", code: "root", message: "root" },
        });
        runtime.store.forkBranch({ threadId: thread.threadId, newBranch: "target", atEventId: root.eventId });
        const target = runtime.store.appendEvent({
          threadId: thread.threadId,
          branch: "target",
          event: { type: "warning", code: "target", message: "target" },
        });
        for (let index = 0; index < 32; index += 1) {
          const branch = `sibling-${index}`;
          runtime.store.forkBranch({ threadId: thread.threadId, newBranch: branch, atEventId: root.eventId });
          appendBenchmarkWarnings(runtime, thread.threadId, 500, branch);
        }
        return {
          threadId: thread.threadId,
          branch: "target",
          afterSequence: root.sequence,
          expectedEventId: target.eventId,
        };
      }
      let expectedEventId: string | undefined;
      for (let offset = 0; offset < 10_000; offset += 500) {
        const events = runtime.store.appendEvents({
          threadId: thread.threadId,
          events: Array.from({ length: 500 }, (_, index) => {
            const sequence = offset + index;
            return {
              type: "tool_progress" as const,
              callId: "benchmark-call",
              name: "shell",
              index: 0,
              sequence,
              progress: {
                type: "output" as const,
                stream: "stdout" as const,
                delta: "x",
                stdoutBytes: sequence + 1,
                stderrBytes: 0,
              },
            };
          }),
        });
        expectedEventId = events.at(-1)?.eventId;
      }
      if (expectedEventId === undefined) throw new Error("Cold page progress fixture produced no events");
      return { threadId: thread.threadId, branch: "main", afterSequence: 9_999, expectedEventId };
    } finally {
      await runtime?.close().catch(() => undefined);
    }
  });
}

async function coldEventPageSample(kind: ColdPageFixture): Promise<number> {
  const value = await fixture(`rigyn-cold-page-${kind}-`);
  let runtime: LoadedRuntime | undefined;
  try {
    const seeded = await seedColdPageSession(value, kind);
    return await withEnvironment(value, async () => {
      runtime = await loadRuntime(runtimeOptions(value.workspace));
      const database = runtime.store.database;
      const originalPrepare = database.prepare;
      let materializedRows = 0;
      database.prepare = ((sql: string) => {
        const statement = originalPrepare.call(database, sql);
        return new Proxy(statement, {
          get(target, property) {
            if (property === "all") {
              return (...parameters: Parameters<typeof target.all>) => {
                const rows = target.all(...parameters);
                materializedRows += rows.length;
                return rows;
              };
            }
            const selected = Reflect.get(target, property, target) as unknown;
            return typeof selected === "function" ? selected.bind(target) : selected;
          },
        });
      }) as typeof database.prepare;
      let page: ReturnType<typeof runtime.store.listEventPage>;
      const started = performance.now();
      try {
        page = runtime.store.listEventPage(seeded.threadId, seeded.branch, {
          afterSequence: seeded.afterSequence,
          limit: 1,
        });
      } finally {
        database.prepare = originalPrepare;
      }
      const elapsed = performance.now() - started;
      if (page.events[0]?.eventId !== seeded.expectedEventId || page.events.length !== 1) {
        throw new Error(`Cold page fixture ${kind} returned the wrong event`);
      }
      if (materializedRows > 16) {
        throw new Error(`Cold page fixture ${kind} materialized ${materializedRows} rows`);
      }
      return elapsed;
    });
  } finally {
    await runtime?.close().catch(() => undefined);
    await rm(value.root, { recursive: true, force: true });
  }
}

async function rpcReplaySample(eventCount: number, pageLimit: number, timeoutMs: number): Promise<number> {
  const value = await fixture(`rigyn-rpc-replay-${eventCount}-`);
  let runtime: LoadedRuntime | undefined;
  let dispatcher: RpcRuntimeDispatcher | undefined;
  try {
    const threadId = await seedSession(value, eventCount);
    return await withEnvironment(value, async () => {
      runtime = await loadRuntime(runtimeOptions(value.workspace));
      let delivered = 0;
      let resolveDelivered!: () => void;
      const allDelivered = new Promise<void>((resolve) => { resolveDelivered = resolve; });
      const peer: RpcRuntimePeer = {
        id: `benchmark-rpc-replay-${eventCount}`,
        async notification(method): Promise<void> {
          if (method !== "events.event") return;
          delivered += 1;
          if (delivered === eventCount) resolveDelivered();
        },
      };
      dispatcher = new RpcRuntimeDispatcher({ runtime });
      const started = performance.now();
      const subscribed = await dispatcher.dispatch(peer, {
        jsonrpc: "2.0",
        id: 1,
        method: "events.subscribe",
        params: { threadId, afterSequence: 0, limit: pageLimit },
      } satisfies RpcRequest) as { subscriptionId: string };
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          allDelivered,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(
              `RPC replay timed out after ${timeoutMs}ms with ${delivered} of ${eventCount} events delivered`,
            )), timeoutMs);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      const elapsed = performance.now() - started;
      await dispatcher.dispatch(peer, {
        jsonrpc: "2.0",
        id: 2,
        method: "events.unsubscribe",
        params: { subscriptionId: subscribed.subscriptionId },
      });
      if (delivered !== eventCount) throw new Error(`RPC replay delivered ${delivered} of ${eventCount} events`);
      return elapsed;
    });
  } finally {
    await dispatcher?.close("benchmark complete").catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    await rm(value.root, { recursive: true, force: true });
  }
}

function percentile(values: readonly number[], fraction: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)]!;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function scenario(
  id: string,
  operation: RuntimePerformanceScenario["operation"],
  fixtureValue: RuntimePerformanceScenario["fixture"],
  samples: number[],
  ceilingMs: number,
): RuntimePerformanceScenario {
  const roundedSamples = samples.map(rounded);
  return {
    id,
    operation,
    fixture: fixtureValue,
    samplesMs: roundedSamples,
    minimumMs: rounded(Math.min(...samples)),
    medianMs: rounded(percentile(samples, 0.5)),
    p95Ms: rounded(percentile(samples, 0.95)),
    maximumMs: rounded(Math.max(...samples)),
    ceilingMs,
    passed: Math.max(...samples) <= ceilingMs,
  };
}

async function measure(samples: number, operation: () => Promise<number>): Promise<number[]> {
  const values: number[] = [];
  for (let index = 0; index < samples; index += 1) values.push(await operation());
  return values;
}

export async function runRuntimePerformanceBenchmark(
  options: RuntimePerformanceOptions = {},
): Promise<RuntimePerformanceReport> {
  const samples = options.samples ?? DEFAULT_SAMPLES;
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 10) {
    throw new RangeError("Runtime performance samples must be from 1 through 10");
  }
  const scenarios: RuntimePerformanceScenario[] = [];
  for (const extensionCount of STARTUP_EXTENSION_COUNTS) {
    scenarios.push(scenario(
      `startup-${extensionCount}-extensions`,
      "startup",
      { extensionCount },
      await measure(samples, async () => await startupSample(extensionCount)),
      extensionCount === 50 ? 30_000 : extensionCount === 10 ? 15_000 : 10_000,
    ));
  }
  scenarios.push(scenario(
    "reload-large-package",
    "reload",
    {
      extensionCount: 1,
      runtimeEntryCount: LARGE_PACKAGE_ENTRY_COUNT,
      commandCount: LARGE_PACKAGE_ENTRY_COUNT * COMMANDS_PER_LARGE_ENTRY,
    },
    await measure(samples, reloadSample),
    30_000,
  ));
  scenarios.push(scenario(
    "cold-page-20000-single-branch",
    "event-page",
    { eventCount: 20_000, pageLimit: 1, branchCount: 1, cold: true, materializedRowBudget: 16 },
    await measure(samples, async () => await coldEventPageSample("single-branch")),
    2_000,
  ));
  scenarios.push(scenario(
    "cold-page-16002-unrelated-branches",
    "event-page",
    { eventCount: 16_002, pageLimit: 1, branchCount: 34, cold: true, materializedRowBudget: 16 },
    await measure(samples, async () => await coldEventPageSample("unrelated-branches")),
    2_000,
  ));
  scenarios.push(scenario(
    "cold-page-10000-tool-progress",
    "event-page",
    {
      eventCount: 10_000,
      pageLimit: 1,
      branchCount: 1,
      toolProgressCount: 10_000,
      cold: true,
      materializedRowBudget: 16,
    },
    await measure(samples, async () => await coldEventPageSample("tool-progress")),
    2_000,
  ));
  for (const eventCount of [100, 10_000] as const) {
    const replayPageLimit = eventCount === 10_000 ? 1 : 16;
    const replayCeilingMs = eventCount === 10_000 ? 20_000 : 10_000;
    scenarios.push(scenario(
      `resume-${eventCount}-events`,
      "resume",
      { eventCount },
      await measure(samples, async () => await resumeSample(eventCount)),
      eventCount === 10_000 ? 20_000 : 10_000,
    ));
    scenarios.push(scenario(
      `rpc-replay-${eventCount}-events`,
      "rpc-replay",
      { eventCount, pageLimit: replayPageLimit },
      await measure(samples, async () => await rpcReplaySample(eventCount, replayPageLimit, replayCeilingMs)),
      replayCeilingMs,
    ));
  }
  return {
    schemaVersion: 1,
    suite: "runtime-performance-v1",
    purpose: "runtime-regression-guard",
    deterministicFixtures: true,
    samplesPerScenario: samples,
    environment: { platform: process.platform, architecture: process.arch, node: process.version },
    scenarios,
    summary: { scenarios: scenarios.length, passed: scenarios.filter((entry) => entry.passed).length },
  };
}

async function main(): Promise<void> {
  const configured = process.env.RIGYN_BENCHMARK_SAMPLES;
  const report = await runRuntimePerformanceBenchmark({
    ...(configured === undefined ? {} : { samples: Number(configured) }),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.summary.passed !== report.summary.scenarios) process.exitCode = 1;
}

const invoked = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) await main();
