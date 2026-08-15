import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

import { readSessionV4FileSync } from "@rigyn/kernel/session-v4";

type Scenario = "accepted" | "prepared" | "settled" | "never_repeat" | "repeatable" | "reconcile";
type Mode = "start" | "recover-crash" | "inspect-resolve";

interface ScenarioPaths {
  root: string;
  workspace: string;
  sessionDirectory: string;
  counterFile: string;
  agentDirectory: string;
}

interface FixtureMessage {
  phase: string;
  sessionFile: string;
}

interface InspectionMessage extends FixtureMessage {
  phase: "inspection-complete";
  before: { recovered: boolean; blocked: number; blockedEffectId?: string };
  effectBefore: { id: string; status: string; dispatchCount: number };
  resolved: { recovered: boolean; blocked: number };
  effectStatusAfter?: string;
  operationStatusAfter?: string;
}

interface BoundaryRecoveryMessage extends FixtureMessage {
  phase: "boundary-recovery-complete";
  recovery: { recovered: boolean; blocked: number };
  repeated: { recovered: boolean; blocked: number };
}

interface RunningFixture {
  child: ChildProcess;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  diagnostic(): string;
}

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/agent-session-process-death.ts", import.meta.url));
const sigkillUnavailable = process.platform === "win32";

async function createScenarioPaths(context: TestContext, scenario: Scenario): Promise<ScenarioPaths> {
  const root = await mkdtemp(join(tmpdir(), `rigyn-v4-process-death-${scenario}-`));
  const paths = {
    root,
    workspace: join(root, "workspace"),
    sessionDirectory: join(root, "sessions"),
    counterFile: join(root, "effects.jsonl"),
    agentDirectory: join(root, "agent"),
  };
  await mkdir(paths.workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));
  return paths;
}

function startFixture(
  context: TestContext,
  paths: ScenarioPaths,
  scenario: Scenario,
  mode: Mode,
  sessionFile?: string,
): RunningFixture {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    RIGYN_HOME: paths.agentDirectory,
    RIGYN_OFFLINE: "1",
    RIGYN_PROCESS_DEATH_WORKSPACE: paths.workspace,
    RIGYN_PROCESS_DEATH_SESSION_DIRECTORY: paths.sessionDirectory,
    RIGYN_PROCESS_DEATH_COUNTER: paths.counterFile,
    ...(sessionFile === undefined ? {} : { RIGYN_PROCESS_DEATH_SESSION_FILE: sessionFile }),
  };
  delete environment.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--import", "tsx", fixture, mode, scenario], {
    cwd: packageRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  context.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  return {
    child,
    exit,
    diagnostic: () => `stdout:\n${stdout}\nstderr:\n${stderr}`,
  };
}

async function waitForPhase(
  running: RunningFixture,
  phase: string,
  timeoutMs = 30_000,
): Promise<FixtureMessage> {
  return await new Promise<FixtureMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      running.child.kill("SIGKILL");
      reject(new Error(`Timed out waiting for ${phase}\n${running.diagnostic()}`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      running.child.off("message", onMessage);
      running.child.off("exit", onExit);
    };
    const onMessage = (value: unknown): void => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return;
      const message = value as Partial<FixtureMessage>;
      if (message.phase !== phase || typeof message.sessionFile !== "string") return;
      cleanup();
      resolve(message as FixtureMessage);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(
        `Fixture exited before ${phase} (code=${String(code)}, signal=${signal ?? "none"})\n${running.diagnostic()}`,
      ));
    };
    running.child.on("message", onMessage);
    running.child.once("exit", onExit);
  });
}

async function crashAtPhase(
  context: TestContext,
  paths: ScenarioPaths,
  scenario: Scenario,
  mode: "start" | "recover-crash",
  phase: string,
  sessionFile?: string,
): Promise<FixtureMessage> {
  const running = startFixture(context, paths, scenario, mode, sessionFile);
  const message = await waitForPhase(running, phase);
  assert.equal(running.child.kill("SIGKILL"), true, running.diagnostic());
  assert.deepEqual(await running.exit, { code: null, signal: "SIGKILL" }, running.diagnostic());
  return message;
}

async function waitForCounterEvent(
  running: RunningFixture,
  paths: ScenarioPaths,
  event: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const rows = (await readFile(paths.counterFile, "utf8")).split("\n").filter((line) => line !== "");
      if (rows.some((line) => {
        try { return (JSON.parse(line) as { event?: unknown }).event === event; }
        catch { return false; }
      })) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      const result = await running.exit;
      throw new Error(
        `Fixture exited before ${event} (code=${String(result.code)}, signal=${result.signal ?? "none"})\n${running.diagnostic()}`,
      );
    }
    if (Date.now() >= deadline) {
      running.child.kill("SIGKILL");
      throw new Error(`Timed out waiting for ${event}\n${running.diagnostic()}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function crashAtBoundary(
  context: TestContext,
  paths: ScenarioPaths,
  scenario: "accepted" | "prepared" | "settled",
  boundary: string,
): Promise<FixtureMessage> {
  const running = startFixture(context, paths, scenario, "start");
  const ready = await waitForPhase(running, "boundary-session-ready");
  await waitForCounterEvent(running, paths, boundary);
  assert.equal(running.child.kill("SIGKILL"), true, running.diagnostic());
  assert.deepEqual(await running.exit, { code: null, signal: "SIGKILL" }, running.diagnostic());
  return ready;
}

async function inspectAndResolve(
  context: TestContext,
  paths: ScenarioPaths,
  scenario: Scenario,
  sessionFile: string,
): Promise<InspectionMessage> {
  const running = startFixture(context, paths, scenario, "inspect-resolve", sessionFile);
  const message = await waitForPhase(running, "inspection-complete") as InspectionMessage;
  assert.deepEqual(await running.exit, { code: 0, signal: null }, running.diagnostic());
  return message;
}

async function recoverBoundary(
  context: TestContext,
  paths: ScenarioPaths,
  scenario: "accepted" | "prepared" | "settled",
  sessionFile: string,
): Promise<BoundaryRecoveryMessage> {
  const running = startFixture(context, paths, scenario, "inspect-resolve", sessionFile);
  const message = await waitForPhase(running, "boundary-recovery-complete") as BoundaryRecoveryMessage;
  assert.deepEqual(await running.exit, { code: 0, signal: null }, running.diagnostic());
  return message;
}

function assertJournalEffect(sessionFile: string, status: string, dispatchCount: number): void {
  const state = readSessionV4FileSync(sessionFile).state;
  const effects = [...state.toolEffects.values()];
  assert.equal(effects.length, 1);
  assert.equal(effects[0]?.status, status);
  assert.equal(effects[0]?.dispatchIds.length, dispatchCount);
}

function assertInspection(
  inspection: InspectionMessage,
  expectedStatus: string,
  expectedDispatchCount: number,
): void {
  assert.deepEqual(inspection.before, {
    recovered: false,
    blocked: 1,
    blockedEffectId: inspection.effectBefore.id,
  });
  assert.equal(inspection.effectBefore.status, expectedStatus);
  assert.equal(inspection.effectBefore.dispatchCount, expectedDispatchCount);
  assert.deepEqual(inspection.resolved, { recovered: true, blocked: 0 });
  assert.equal(inspection.effectStatusAfter, "abandoned");
  assert.equal(inspection.operationStatusAfter, "cancelled");
}

async function counterEvents(paths: ScenarioPaths): Promise<Array<{ event: string; mode: string }>> {
  return (await readFile(paths.counterFile, "utf8")).trim().split("\n").map((line) => {
    const row = JSON.parse(line) as { event: string; mode: string };
    return { event: row.event, mode: row.mode };
  });
}

function assertBoundaryRecovery(message: BoundaryRecoveryMessage): void {
  assert.deepEqual(message.recovery, { recovered: true, blocked: 0 });
  assert.deepEqual(message.repeated, { recovered: false, blocked: 0 });
}

test("a kill immediately after durable operation acceptance recovers the prompt exactly once", {
  skip: sigkillUnavailable ? "Windows does not expose POSIX SIGKILL process semantics" : false,
}, async (context) => {
  const paths = await createScenarioPaths(context, "accepted");
  const crashed = await crashAtBoundary(
    context,
    paths,
    "accepted",
    "operation-accepted-boundary",
  );
  let state = readSessionV4FileSync(crashed.sessionFile).state;
  const operation = [...state.operations.values()].at(-1);
  assert.ok(operation);
  assert.equal(operation.status, "accepted");
  assert.equal(state.branches.get(state.primaryBranchId)?.openOperationId, operation.id);
  assert.notEqual(operation.promptNodeId, null);
  assert.equal(state.nodes.has(operation.promptNodeId!), false);
  assert.equal(state.toolEffects.size, 0);

  assertBoundaryRecovery(await recoverBoundary(context, paths, "accepted", crashed.sessionFile));
  state = readSessionV4FileSync(crashed.sessionFile).state;
  assert.equal(state.operations.get(operation.id)?.status, "cancelled");
  assert.equal(state.branches.get(state.primaryBranchId)?.openOperationId, null);
  const prompt = state.nodes.get(operation.promptNodeId!);
  assert.equal(prompt?.nodeType, "message");
  assert.equal(prompt?.role, "user");
  assert.deepEqual(
    (prompt?.content as { content?: unknown }).content,
    [{ type: "text", text: "enter the durable tool boundary" }],
  );
  assert.deepEqual(await counterEvents(paths), [
    { event: "operation-accepted-boundary", mode: "start" },
  ]);
});

test("a kill after tool preparation but before dispatch never executes the tool", {
  skip: sigkillUnavailable ? "Windows does not expose POSIX SIGKILL process semantics" : false,
}, async (context) => {
  const paths = await createScenarioPaths(context, "prepared");
  const crashed = await crashAtBoundary(
    context,
    paths,
    "prepared",
    "tool-effect-prepared-boundary",
  );
  let state = readSessionV4FileSync(crashed.sessionFile).state;
  const operation = [...state.operations.values()].at(-1)!;
  const effect = [...state.toolEffects.values()].at(-1)!;
  assert.equal(operation.status, "running");
  assert.equal(state.branches.get(state.primaryBranchId)?.openOperationId, operation.id);
  assert.equal(effect.status, "prepared");
  assert.equal(effect.dispatchIds.length, 0);
  assert.equal(state.nodes.has(effect.resultNodeId), false);

  assertBoundaryRecovery(await recoverBoundary(context, paths, "prepared", crashed.sessionFile));
  state = readSessionV4FileSync(crashed.sessionFile).state;
  assert.equal(state.operations.get(operation.id)?.status, "cancelled");
  assert.equal(state.branches.get(state.primaryBranchId)?.openOperationId, null);
  assert.equal(state.toolEffects.get(effect.id)?.status, "not_applied");
  assert.equal(state.toolEffects.get(effect.id)?.dispatchIds.length, 0);
  assert.equal(state.nodes.has(effect.resultNodeId), true);
  assert.deepEqual(await counterEvents(paths), [
    { event: "tool-effect-prepared-boundary", mode: "start" },
  ]);
});

test("a kill after durable tool settlement materializes its result without re-execution", {
  skip: sigkillUnavailable ? "Windows does not expose POSIX SIGKILL process semantics" : false,
}, async (context) => {
  const paths = await createScenarioPaths(context, "settled");
  const crashed = await crashAtBoundary(
    context,
    paths,
    "settled",
    "tool-effect-settled-boundary",
  );
  let state = readSessionV4FileSync(crashed.sessionFile).state;
  const operation = [...state.operations.values()].at(-1)!;
  const effect = [...state.toolEffects.values()].at(-1)!;
  assert.equal(operation.status, "running");
  assert.equal(state.branches.get(state.primaryBranchId)?.openOperationId, operation.id);
  assert.equal(effect.status, "succeeded");
  assert.equal(effect.dispatchIds.length, 1);
  assert.equal(
    (effect.result as { content?: unknown } | undefined)?.content,
    "durable tool result",
  );
  assert.equal(state.nodes.has(effect.resultNodeId), false);
  assert.equal(operation.checkpointIds.some((id) => {
    const data = state.checkpoints.get(id)?.data as { phase?: unknown } | undefined;
    return data?.phase === "tool_effect_settled";
  }), true);

  assertBoundaryRecovery(await recoverBoundary(context, paths, "settled", crashed.sessionFile));
  state = readSessionV4FileSync(crashed.sessionFile).state;
  assert.equal(state.operations.get(operation.id)?.status, "cancelled");
  assert.equal(state.branches.get(state.primaryBranchId)?.openOperationId, null);
  assert.equal(state.toolEffects.get(effect.id)?.status, "succeeded");
  assert.equal(state.toolEffects.get(effect.id)?.dispatchIds.length, 1);
  const result = state.nodes.get(effect.resultNodeId);
  assert.equal(result?.nodeType, "message");
  assert.equal(result?.role, "tool");
  assert.equal(
    (result?.content as { content?: Array<{ content?: unknown }> }).content?.[0]?.content,
    "durable tool result",
  );
  assert.deepEqual(await counterEvents(paths), [
    { event: "tool_execute", mode: "start" },
    { event: "tool-effect-settled-boundary", mode: "start" },
  ]);
});

test("a killed never-repeat tool stays in doubt without replay until explicit resolution", {
  skip: sigkillUnavailable ? "Windows does not expose POSIX SIGKILL process semantics" : false,
}, async (context) => {
  const paths = await createScenarioPaths(context, "never_repeat");
  const crashed = await crashAtPhase(
    context,
    paths,
    "never_repeat",
    "start",
    "initial-tool-side-effect",
  );
  assertJournalEffect(crashed.sessionFile, "dispatched", 1);

  const inspection = await inspectAndResolve(context, paths, "never_repeat", crashed.sessionFile);
  assertInspection(inspection, "in_doubt", 1);
  assert.deepEqual(await counterEvents(paths), [{ event: "tool_execute", mode: "start" }]);
});

test("a second crash during repeatable recovery never permits a third dispatch", {
  skip: sigkillUnavailable ? "Windows does not expose POSIX SIGKILL process semantics" : false,
}, async (context) => {
  const paths = await createScenarioPaths(context, "repeatable");
  const initial = await crashAtPhase(
    context,
    paths,
    "repeatable",
    "start",
    "initial-tool-side-effect",
  );
  assertJournalEffect(initial.sessionFile, "dispatched", 1);
  await crashAtPhase(
    context,
    paths,
    "repeatable",
    "recover-crash",
    "repeatable-recovery-side-effect",
    initial.sessionFile,
  );
  assertJournalEffect(initial.sessionFile, "dispatched", 2);

  const inspection = await inspectAndResolve(context, paths, "repeatable", initial.sessionFile);
  assertInspection(inspection, "in_doubt", 2);
  assert.deepEqual(await counterEvents(paths), [
    { event: "tool_execute", mode: "start" },
    { event: "tool_execute", mode: "recover-crash" },
  ]);
});

test("a crash after reconcile recovery starts never invokes the reconciler again", {
  skip: sigkillUnavailable ? "Windows does not expose POSIX SIGKILL process semantics" : false,
}, async (context) => {
  const paths = await createScenarioPaths(context, "reconcile");
  const initial = await crashAtPhase(
    context,
    paths,
    "reconcile",
    "start",
    "initial-tool-side-effect",
  );
  assertJournalEffect(initial.sessionFile, "dispatched", 1);
  await crashAtPhase(
    context,
    paths,
    "reconcile",
    "recover-crash",
    "reconcile-recovery-started",
    initial.sessionFile,
  );
  assertJournalEffect(initial.sessionFile, "recovery_started", 1);

  const inspection = await inspectAndResolve(context, paths, "reconcile", initial.sessionFile);
  assertInspection(inspection, "recovery_started", 1);
  assert.deepEqual(await counterEvents(paths), [
    { event: "tool_execute", mode: "start" },
    { event: "reconcile_recover", mode: "recover-crash" },
  ]);
});
