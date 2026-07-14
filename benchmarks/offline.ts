import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  HarnessService,
  ProviderRegistry,
  SessionStore,
  type AdapterEvent,
  type EventEnvelope,
  type NormalizedUsage,
  type ProviderAdapter,
  type ProviderRequest,
} from "../src/index.js";
import {
  createScriptedProvider,
  type ScriptedProviderStep,
} from "../src/testing/index.js";

const execute = promisify(execFile);
const PROVIDER_ID = "benchmark-offline";
const MODEL_ID = "benchmark-model";
const USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const satisfies readonly (keyof NormalizedUsage)[];

export interface BenchmarkUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  costUsd: string | null;
}

export interface BenchmarkTaskReport {
  id: string;
  checks: BenchmarkCheck[];
  completed: boolean;
  passed: boolean;
  runAttempts: number;
  harnessRuns: number;
  providerAttempts: number;
  providerRetries: number;
  steps: number;
  toolCalls: number;
  toolCallErrors: number;
  parallelToolBatches: number;
  compactions: number;
  toolCallsInDoubt: number;
  usage: BenchmarkUsage;
  failure?: string;
}

export type BenchmarkCheck =
  | "file-creation"
  | "model-visible-tool-recovery"
  | "multi-file-work"
  | "mutation-preservation"
  | "parallel-tool-batch"
  | "session-continuation"
  | "tool-error-recovery"
  | "transport-retry"
  | "unknown-tool-recovery"
  | "verification";

export interface BenchmarkReport {
  schemaVersion: 2;
  suite: "offline-v2";
  purpose: "harness-plumbing";
  deterministic: true;
  tasks: BenchmarkTaskReport[];
  probes: {
    compaction: {
      passed: boolean;
      completed: number;
      sourceMessages: number;
    };
    crashRecovery: {
      passed: boolean;
      recoveredRuns: number;
      repairedToolCalls: number;
      inDoubtToolCalls: number;
      reconstructedToolCalls: number;
    };
  };
  summary: {
    taskCount: number;
    completed: number;
    passed: number;
    completionRate: number;
    passAt1: number;
    runAttempts: number;
    harnessRuns: number;
    providerAttempts: number;
    providerRetries: number;
    toolCalls: number;
    toolCallErrors: number;
    parallelToolBatches: number;
    compactions: number;
    toolCallsInDoubt: number;
    usage: BenchmarkUsage;
  };
}

interface OfflineTask {
  id: string;
  checks: readonly BenchmarkCheck[];
  prompts: readonly string[];
  files: Readonly<Record<string, string>>;
  scripts: readonly ScriptedProviderStep[];
  failFirstProviderAttempt?: boolean;
  verify(workspace: string): Promise<boolean>;
}

function usage(
  inputTokens: number,
  outputTokens: number,
  cost: string,
): NormalizedUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost,
  };
}

function requireToolRecovery(
  request: ProviderRequest,
  callId: string,
  summaryIncludes: string,
  nextActionIncludes: string,
): void {
  const result = request.messages
    .flatMap((message) => message.content)
    .find((block) => block.type === "tool_result" && block.callId === callId);
  if (result?.type !== "tool_result") throw new Error(`missing tool result for ${callId}`);
  if (!result.isError || result.status !== "error") {
    throw new Error(`tool result ${callId} did not expose an error status`);
  }
  if (result.summary?.toLowerCase().includes(summaryIncludes.toLowerCase()) !== true) {
    throw new Error(`tool result ${callId} did not expose a useful summary`);
  }
  if (result.nextActions?.some((action) => action.toLowerCase().includes(nextActionIncludes.toLowerCase())) !== true) {
    throw new Error(`tool result ${callId} did not expose a recovery action`);
  }
}

function requestText(request: ProviderRequest, role: "user" | "assistant"): string[] {
  return request.messages
    .filter((message) => message.role === role)
    .flatMap((message) => message.content)
    .flatMap((block) => block.type === "text" ? [block.text] : []);
}

export const OFFLINE_CORPUS: readonly OfflineTask[] = [
  {
    id: "create-file-after-transport-retry",
    checks: ["transport-retry", "file-creation"],
    prompts: ["Create greeting.txt containing exactly hello from the harness followed by a newline."],
    files: {},
    failFirstProviderAttempt: true,
    scripts: [
      {
        kind: "turn",
        content: [{
          type: "tool_call",
          id: "write-greeting",
          name: "write",
          arguments: { path: "greeting.txt", content: "hello from the harness\n" },
        }],
        usage: usage(10, 5, "0.001"),
      },
      {
        kind: "turn",
        content: [{ type: "text", text: "Created greeting.txt." }],
        usage: usage(12, 4, "0.0008"),
      },
    ],
    async verify(workspace) {
      return await readFile(join(workspace, "greeting.txt"), "utf8") === "hello from the harness\n";
    },
  },
  {
    id: "repair-code-after-tool-error",
    checks: ["tool-error-recovery", "model-visible-tool-recovery", "verification"],
    prompts: ["Fix the implementation so the included test passes, then run that test."],
    files: {
      "math.mjs": "export function add(left, right) {\n  return left - right;\n}\n",
      "math.test.mjs": [
        "import assert from \"node:assert/strict\";",
        "import test from \"node:test\";",
        "import { add } from \"./math.mjs\";",
        "test(\"adds two numbers\", () => assert.equal(add(2, 3), 5));",
        "",
      ].join("\n"),
    },
    scripts: [
      {
        kind: "turn",
        content: [{
          type: "tool_call",
          id: "incorrect-edit",
          name: "edit",
          arguments: {
            path: "math.mjs",
            edits: [{ oldText: "return left * right;", newText: "return left + right;" }],
          },
        }],
        usage: usage(20, 5, "0.001"),
      },
      ({ request }) => {
        requireToolRecovery(request, "incorrect-edit", "could not find the exact text", "correct the request");
        return {
          kind: "turn",
          content: [{
            type: "tool_call",
            id: "correct-edit",
            name: "edit",
            arguments: {
              path: "math.mjs",
              edits: [{ oldText: "return left - right;", newText: "return left + right;" }],
            },
          }],
          usage: usage(24, 5, "0.0012"),
        };
      },
      {
        kind: "turn",
        content: [{
          type: "tool_call",
          id: "run-test",
          name: "bash",
          arguments: { command: "node --test math.test.mjs" },
        }],
        usage: usage(30, 6, "0.0015"),
      },
      {
        kind: "turn",
        content: [{ type: "text", text: "Fixed add and confirmed the test passes." }],
        usage: usage(35, 4, "0.0016"),
      },
    ],
    async verify(workspace) {
      try {
        await execute(process.execPath, ["--test", "math.test.mjs"], { cwd: workspace, timeout: 10_000 });
        return (await readFile(join(workspace, "math.mjs"), "utf8")).includes("return left + right;");
      } catch {
        return false;
      }
    },
  },
  {
    id: "parallel-multi-file-change",
    checks: ["multi-file-work", "parallel-tool-batch", "mutation-preservation", "verification"],
    prompts: ["Add a greeting module and its test without changing unrelated files, then run the test."],
    files: {
      "src/config.mjs": "export const prefix = \"hello\";\n",
      "untouched.txt": "preserve this exact content\n",
    },
    scripts: [
      {
        kind: "turn",
        content: [
          {
            type: "tool_call",
            id: "write-module",
            name: "write",
            arguments: {
              path: "src/greeting.mjs",
              content: "import { prefix } from \"./config.mjs\";\nexport const greeting = (name) => `${prefix}, ${name}!`;\n",
            },
          },
          {
            type: "tool_call",
            id: "write-module-test",
            name: "write",
            arguments: {
              path: "test/greeting.test.mjs",
              content: [
                "import assert from \"node:assert/strict\";",
                "import test from \"node:test\";",
                "import { greeting } from \"../src/greeting.mjs\";",
                "test(\"greets by name\", () => assert.equal(greeting(\"Ada\"), \"hello, Ada!\"));",
                "",
              ].join("\n"),
            },
          },
        ],
        usage: usage(40, 8, "0.002"),
      },
      {
        kind: "turn",
        content: [{
          type: "tool_call",
          id: "run-greeting-test",
          name: "bash",
          arguments: { command: "node --test test/greeting.test.mjs" },
        }],
        usage: usage(48, 5, "0.0024"),
      },
      {
        kind: "turn",
        content: [{ type: "text", text: "Added both files, preserved unrelated content, and ran the test." }],
        usage: usage(52, 4, "0.0026"),
      },
    ],
    async verify(workspace) {
      try {
        await execute(process.execPath, ["--test", "test/greeting.test.mjs"], { cwd: workspace, timeout: 10_000 });
        return await readFile(join(workspace, "src", "config.mjs"), "utf8") === "export const prefix = \"hello\";\n" &&
          await readFile(join(workspace, "untouched.txt"), "utf8") === "preserve this exact content\n";
      } catch {
        return false;
      }
    },
  },
  {
    id: "recover-from-unknown-tool",
    checks: ["unknown-tool-recovery", "model-visible-tool-recovery", "file-creation"],
    prompts: ["Create recovery.txt with the exact requested content."],
    files: {},
    scripts: [
      {
        kind: "turn",
        content: [{
          type: "tool_call",
          id: "unknown-patch",
          name: "patch_file",
          arguments: { path: "recovery.txt", content: "recovered\n" },
        }],
        usage: usage(18, 4, "0.0009"),
      },
      ({ request }) => {
        requireToolRecovery(request, "unknown-patch", "unknown or inactive tool", "write");
        return {
          kind: "turn",
          content: [{
            type: "tool_call",
            id: "known-write",
            name: "write",
            arguments: { path: "recovery.txt", content: "recovered\n" },
          }],
          usage: usage(22, 5, "0.0011"),
        };
      },
      {
        kind: "turn",
        content: [{ type: "text", text: "Recovered with an active tool." }],
        usage: usage(24, 4, "0.0012"),
      },
    ],
    async verify(workspace) {
      return await readFile(join(workspace, "recovery.txt"), "utf8") === "recovered\n";
    },
  },
  {
    id: "continue-existing-session",
    checks: ["session-continuation"],
    prompts: [
      "Create journal.txt with a first durable line.",
      "Continue this session by adding the second durable line.",
    ],
    files: {},
    scripts: [
      {
        kind: "turn",
        content: [{
          type: "tool_call",
          id: "session-write",
          name: "write",
          arguments: { path: "journal.txt", content: "first\n" },
        }],
        usage: usage(16, 4, "0.0008"),
      },
      {
        kind: "turn",
        content: [{ type: "text", text: "The first durable line is saved." }],
        usage: usage(20, 4, "0.001"),
      },
      ({ request }) => {
        const users = requestText(request, "user");
        const assistants = requestText(request, "assistant");
        if (!users.includes("Create journal.txt with a first durable line.") ||
            !users.includes("Continue this session by adding the second durable line.") ||
            !assistants.includes("The first durable line is saved.")) {
          throw new Error("continued request did not contain the durable prior conversation");
        }
        const priorResult = request.messages
          .flatMap((message) => message.content)
          .find((block) => block.type === "tool_result" && block.callId === "session-write");
        if (priorResult?.type !== "tool_result" || priorResult.status !== "success") {
          throw new Error("continued request did not contain the prior successful tool result");
        }
        return {
          kind: "turn",
          content: [{
            type: "tool_call",
            id: "session-edit",
            name: "edit",
            arguments: {
              path: "journal.txt",
              edits: [{ oldText: "first\n", newText: "first\nsecond\n" }],
            },
          }],
          usage: usage(28, 5, "0.0014"),
        };
      },
      {
        kind: "turn",
        content: [{ type: "text", text: "The existing session now includes both durable lines." }],
        usage: usage(32, 4, "0.0016"),
      },
    ],
    async verify(workspace) {
      return await readFile(join(workspace, "journal.txt"), "utf8") === "first\nsecond\n";
    },
  },
] as const;

function decimal(value: string): { coefficient: bigint; scale: number } {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(value);
  if (match === null) throw new Error("Benchmark cost is not a normalized decimal");
  const fraction = match[2] ?? "";
  let coefficient = BigInt(`${match[1]}${fraction}`);
  let scale = fraction.length - Number(match[3] ?? "0");
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { coefficient, scale };
}

function formatDecimal(coefficient: bigint, scale: number): string {
  if (coefficient === 0n) return "0";
  const digits = coefficient.toString().padStart(scale + 1, "0");
  if (scale === 0) return digits;
  const fraction = digits.slice(-scale).replace(/0+$/u, "");
  return fraction === "" ? digits.slice(0, -scale) : `${digits.slice(0, -scale)}.${fraction}`;
}

function addDecimal(left: string, right: string): string {
  const first = decimal(left);
  const second = decimal(right);
  const scale = Math.max(first.scale, second.scale);
  return formatDecimal(
    first.coefficient * 10n ** BigInt(scale - first.scale) +
      second.coefficient * 10n ** BigInt(scale - second.scale),
    scale,
  );
}

function emptyUsage(): BenchmarkUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: "0",
  };
}

function unknownUsage(): BenchmarkUsage {
  return {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    costUsd: null,
  };
}

function addUsage(left: BenchmarkUsage, right: BenchmarkUsage): BenchmarkUsage {
  const result = unknownUsage();
  for (const field of USAGE_FIELDS) {
    const first = left[field];
    const second = right[field];
    result[field] = first === null || second === null ? null : first + second;
  }
  result.costUsd = left.costUsd === null || right.costUsd === null
    ? null
    : addDecimal(left.costUsd, right.costUsd);
  return result;
}

function normalizedUsage(value: NormalizedUsage | undefined): BenchmarkUsage {
  if (value === undefined) return unknownUsage();
  return {
    inputTokens: value.inputTokens ?? null,
    outputTokens: value.outputTokens ?? null,
    totalTokens: value.totalTokens ?? null,
    cacheReadTokens: value.cacheReadTokens ?? null,
    cacheWriteTokens: value.cacheWriteTokens ?? null,
    reasoningTokens: value.reasoningTokens ?? null,
    costUsd: value.cost ?? null,
  };
}

function addNormalizedUsage(left: NormalizedUsage | undefined, right: NormalizedUsage): NormalizedUsage {
  const result: NormalizedUsage = {};
  for (const field of USAGE_FIELDS) {
    const first = left?.[field];
    const second = right[field];
    if (first !== undefined || second !== undefined) result[field] = (first ?? 0) + (second ?? 0);
  }
  if (left?.cost !== undefined || right.cost !== undefined) {
    result.cost = addDecimal(left?.cost ?? "0", right.cost ?? "0");
  }
  return result;
}

class EventMetrics {
  retries = 0;
  toolCalls = 0;
  toolCallErrors = 0;
  compactions = 0;
  toolCallsInDoubt = 0;
  readonly #completedRunIds = new Set<string>();
  readonly #stepsByRun = new Map<string, number>();
  readonly #currentStepByRun = new Map<string, number>();
  readonly #activeToolsByStep = new Map<string, Set<string>>();
  readonly #parallelToolSteps = new Set<string>();
  #segments: BenchmarkUsage[] = [];
  #currentUsage: NormalizedUsage | undefined;

  observe(envelope: EventEnvelope): void {
    const event = envelope.event;
    if (event.type === "assistant_started" || event.type === "compaction_started") this.#finishSegment();
    const runId = envelope.runId ?? `${envelope.threadId}:unscoped`;
    if (event.type === "assistant_started") {
      this.#stepsByRun.set(runId, Math.max(this.#stepsByRun.get(runId) ?? 0, event.step));
      this.#currentStepByRun.set(runId, event.step);
    }
    else if (event.type === "retry_scheduled") this.retries += 1;
    else if (event.type === "tool_requested") {
      this.toolCalls += 1;
    }
    else if (event.type === "tool_started") {
      const key = `${runId}:${this.#currentStepByRun.get(runId) ?? 0}`;
      const active = this.#activeToolsByStep.get(key) ?? new Set<string>();
      active.add(event.callId);
      this.#activeToolsByStep.set(key, active);
      if (active.size > 1) this.#parallelToolSteps.add(key);
    }
    else if (event.type === "tool_completed") {
      const key = `${runId}:${this.#currentStepByRun.get(runId) ?? 0}`;
      this.#activeToolsByStep.get(key)?.delete(event.callId);
      if (event.isError) this.toolCallErrors += 1;
    }
    else if (event.type === "tool_in_doubt") this.toolCallsInDoubt += 1;
    else if (event.type === "compaction_completed") this.compactions += 1;
    else if (event.type === "run_completed") this.#completedRunIds.add(runId);
    else if (event.type === "usage") {
      this.#currentUsage = event.semantics === "incremental"
        ? addNormalizedUsage(this.#currentUsage, event.usage)
        : { ...event.usage };
    }
  }

  get completedRuns(): number {
    return this.#completedRunIds.size;
  }

  get steps(): number {
    return [...this.#stepsByRun.values()].reduce((sum, count) => sum + count, 0);
  }

  get parallelToolBatches(): number {
    return this.#parallelToolSteps.size;
  }

  usage(): BenchmarkUsage {
    this.#finishSegment();
    if (this.#segments.length === 0) return unknownUsage();
    return this.#segments.reduce(addUsage, emptyUsage());
  }

  #finishSegment(): void {
    if (this.#currentUsage === undefined) return;
    this.#segments.push(normalizedUsage(this.#currentUsage));
    this.#currentUsage = undefined;
  }
}

class CountingProvider implements ProviderAdapter {
  readonly id = PROVIDER_ID;
  attempts = 0;
  #failNext: boolean;

  constructor(
    private readonly delegate: ProviderAdapter,
    failFirst: boolean,
  ) {
    this.#failNext = failFirst;
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    this.attempts += 1;
    if (this.#failNext) {
      this.#failNext = false;
      const error = new TypeError("deterministic pre-response transport failure") as TypeError & { code: string };
      error.code = "ECONNRESET";
      throw error;
    }
    yield* this.delegate.stream(request, signal);
  }

  async listModels(signal: AbortSignal) {
    return await this.delegate.listModels!(signal);
  }
}

async function populate(workspace: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const destination = join(workspace, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
  }
}

function stableFailure(error: unknown, workspace: string): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replaceAll(workspace, "<workspace>").slice(0, 1_024);
}

async function runTask(task: OfflineTask, root: string): Promise<BenchmarkTaskReport> {
  const workspace = join(root, task.id);
  await mkdir(workspace, { recursive: true });
  await populate(workspace, task.files);
  const scripted = createScriptedProvider({
    id: PROVIDER_ID,
    models: [{ id: MODEL_ID, contextTokens: 32_000, maxOutputTokens: 1_024 }],
    scripts: task.scripts,
  });
  const provider = new CountingProvider(scripted, task.failFirstProviderAttempt === true);
  const store = new SessionStore(":memory:");
  const service = new HarnessService({
    store,
    workspace,
    providers: new ProviderRegistry([provider]),
    projectTrusted: true,
    retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 },
  });
  const metrics = new EventMetrics();
  let failure: string | undefined;
  let verified = false;
  let harnessRuns = 0;
  try {
    await service.initialize({ skills: [] });
    let threadId: string | undefined;
    for (const prompt of task.prompts) {
      harnessRuns += 1;
      const run = await service.run({
        ...(threadId === undefined ? {} : { threadId }),
        prompt,
        provider: provider.id,
        model: MODEL_ID,
        onEvent: (event) => metrics.observe(event),
      });
      threadId = run.threadId;
    }
    verified = await task.verify(workspace);
  } catch (error) {
    failure = stableFailure(error, workspace);
  } finally {
    await service.close("offline_benchmark").catch(() => undefined);
    store.close();
  }
  return {
    id: task.id,
    checks: [...task.checks],
    completed: metrics.completedRuns === task.prompts.length,
    passed: metrics.completedRuns === task.prompts.length && verified,
    runAttempts: 1,
    harnessRuns,
    providerAttempts: provider.attempts,
    providerRetries: metrics.retries,
    steps: metrics.steps,
    toolCalls: metrics.toolCalls,
    toolCallErrors: metrics.toolCallErrors,
    parallelToolBatches: metrics.parallelToolBatches,
    compactions: metrics.compactions,
    toolCallsInDoubt: metrics.toolCallsInDoubt,
    usage: metrics.usage(),
    ...(failure === undefined ? {} : { failure }),
  };
}

async function runCompactionProbe(root: string): Promise<BenchmarkReport["probes"]["compaction"]> {
  const workspace = join(root, "compaction-probe");
  await mkdir(workspace, { recursive: true });
  const provider = createScriptedProvider({
    id: "benchmark-compaction",
    models: [{ id: MODEL_ID, contextTokens: 32_000, maxOutputTokens: 1_024 }],
    scripts: [
      { kind: "turn", content: [{ type: "text", text: "First durable answer." }], usage: usage(8, 3, "0") },
      { kind: "turn", content: [{ type: "text", text: "Second durable answer." }], usage: usage(12, 3, "0") },
      { kind: "turn", content: [{ type: "text", text: "Both prior turns completed without unresolved work." }], usage: usage(16, 8, "0") },
    ],
  });
  const store = new SessionStore(":memory:");
  const service = new HarnessService({
    store,
    workspace,
    providers: new ProviderRegistry([provider]),
    compactionRetainRecentTurns: 0,
  });
  const events: EventEnvelope[] = [];
  try {
    await service.initialize({ skills: [] });
    const first = await service.run({
      prompt: "Remember the first result.",
      provider: provider.id,
      model: MODEL_ID,
      noBuiltinTools: true,
    });
    await service.run({
      threadId: first.threadId,
      prompt: "Remember the second result.",
      provider: provider.id,
      model: MODEL_ID,
      noBuiltinTools: true,
    });
    await service.run({
      threadId: first.threadId,
      prompt: "",
      provider: provider.id,
      model: MODEL_ID,
      noBuiltinTools: true,
      manualCompaction: true,
      contextTokenBudget: 32_000,
      summaryTokenBudget: 256,
      onEvent: (event) => { events.push(event); },
    });
    const completed = events.filter((entry) => entry.event.type === "compaction_completed");
    const sourceMessages = completed.reduce((sum, entry) =>
      sum + (entry.event.type === "compaction_completed" ? entry.event.sourceMessageIds.length : 0), 0);
    return { passed: completed.length === 1 && sourceMessages > 0, completed: completed.length, sourceMessages };
  } catch {
    return { passed: false, completed: 0, sourceMessages: 0 };
  } finally {
    await service.close("offline_benchmark_compaction").catch(() => undefined);
    store.close();
  }
}

async function runCrashRecoveryProbe(root: string): Promise<BenchmarkReport["probes"]["crashRecovery"]> {
  const workspace = join(root, "recovery-workspace");
  const database = join(root, "recovery.sqlite");
  await mkdir(workspace, { recursive: true });
  let store = new SessionStore(database);
  store.createThread({ threadId: "benchmark-recovery-thread", workspaceRoot: workspace });
  const run = store.startRun({
    threadId: "benchmark-recovery-thread",
    runId: "benchmark-recovery-run",
    provider: PROVIDER_ID,
    model: MODEL_ID,
  });
  store.appendEvents({
    threadId: run.threadId,
    runId: run.runId,
    events: [
      { type: "tool_requested", callId: "benchmark-in-doubt", name: "write", input: { path: "result.txt", content: "done" }, index: 0 },
      { type: "tool_started", callId: "benchmark-in-doubt", name: "write", index: 0 },
    ],
  });
  store.close();
  store = new SessionStore(database);
  try {
    const recovered = store.recoverAbandonedRuns(workspace);
    return {
      passed: recovered.recoveredRunIds.length === 1 && recovered.inDoubtToolCallIds.length === 1,
      recoveredRuns: recovered.recoveredRunIds.length,
      repairedToolCalls: recovered.repairedToolCallIds.length,
      inDoubtToolCalls: recovered.inDoubtToolCallIds.length,
      reconstructedToolCalls: recovered.reconstructedToolCallIds.length,
    };
  } finally {
    store.close();
  }
}

function aggregateUsage(tasks: readonly BenchmarkTaskReport[]): BenchmarkUsage {
  if (tasks.length === 0) return unknownUsage();
  return tasks.map((task) => task.usage).reduce(addUsage, emptyUsage());
}

export async function runOfflineBenchmark(): Promise<BenchmarkReport> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rigyn-benchmark-")));
  try {
    const tasks: BenchmarkTaskReport[] = [];
    for (const task of OFFLINE_CORPUS) tasks.push(await runTask(task, root));
    const compaction = await runCompactionProbe(root);
    const crashRecovery = await runCrashRecoveryProbe(root);
    const completed = tasks.filter((task) => task.completed).length;
    const passed = tasks.filter((task) => task.passed).length;
    const taskCount = tasks.length;
    return {
      schemaVersion: 2,
      suite: "offline-v2",
      purpose: "harness-plumbing",
      deterministic: true,
      tasks,
      probes: { compaction, crashRecovery },
      summary: {
        taskCount,
        completed,
        passed,
        completionRate: taskCount === 0 ? 0 : completed / taskCount,
        passAt1: taskCount === 0 ? 0 : tasks.filter((task) => task.passed && task.runAttempts === 1).length / taskCount,
        runAttempts: tasks.reduce((sum, task) => sum + task.runAttempts, 0),
        harnessRuns: tasks.reduce((sum, task) => sum + task.harnessRuns, 0),
        providerAttempts: tasks.reduce((sum, task) => sum + task.providerAttempts, 0),
        providerRetries: tasks.reduce((sum, task) => sum + task.providerRetries, 0),
        toolCalls: tasks.reduce((sum, task) => sum + task.toolCalls, 0),
        toolCallErrors: tasks.reduce((sum, task) => sum + task.toolCallErrors, 0),
        parallelToolBatches: tasks.reduce((sum, task) => sum + task.parallelToolBatches, 0),
        compactions: tasks.reduce((sum, task) => sum + task.compactions, 0),
        toolCallsInDoubt: tasks.reduce((sum, task) => sum + task.toolCallsInDoubt, 0),
        usage: aggregateUsage(tasks),
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const report = await runOfflineBenchmark();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.summary.passed !== report.summary.taskCount || !report.probes.compaction.passed || !report.probes.crashRecovery.passed) {
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) await main();
