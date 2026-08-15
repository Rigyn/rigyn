import { appendFileSync } from "node:fs";

import type {
  AdapterEvent,
  ModelInfo,
  ModelProtocolFamily,
  ProviderAdapter,
  ProviderRequest,
} from "../../src/core/types.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { AgentSession, type AgentSessionModel } from "../../src/service/agent-session.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import type { HarnessTool, ToolRecoveryContract } from "../../src/tools/types.js";

type BoundaryScenario = "accepted" | "prepared" | "settled";
type Scenario = BoundaryScenario | "never_repeat" | "repeatable" | "reconcile";
type Mode = "start" | "recover-crash" | "inspect-resolve";

const TIME = "2026-08-09T12:00:00.000Z";
const PROVIDER = "process-death-fixture";
const MODEL = "process-death-model";
const API: ModelProtocolFamily = "openai-chat-completions";
const supported = { value: "supported", source: "provider", observedAt: TIME } as const;
const MODEL_INFO: ModelInfo = {
  id: MODEL,
  provider: PROVIDER,
  capabilities: { tools: supported, reasoning: supported, images: supported },
  compatibility: {
    protocolFamily: { value: API, source: "provider", observedAt: TIME },
  },
};
const SELECTED_MODEL: AgentSessionModel = {
  provider: PROVIDER,
  api: API,
  id: MODEL,
  info: MODEL_INFO,
};

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function selectedScenario(value: string | undefined): Scenario {
  if (
    value === "accepted" ||
    value === "prepared" ||
    value === "settled" ||
    value === "never_repeat" ||
    value === "repeatable" ||
    value === "reconcile"
  ) return value;
  throw new Error(`Unknown process-death scenario ${JSON.stringify(value)}`);
}

function isBoundaryScenario(scenario: Scenario): scenario is BoundaryScenario {
  return scenario === "accepted" || scenario === "prepared" || scenario === "settled";
}

function selectedMode(value: string | undefined): Mode {
  if (value === "start" || value === "recover-crash" || value === "inspect-resolve") return value;
  throw new Error(`Unknown process-death mode ${JSON.stringify(value)}`);
}

async function announce(message: Record<string, unknown>): Promise<void> {
  if (process.send === undefined) throw new Error("The process-death fixture requires an IPC channel");
  await new Promise<void>((resolve, reject) => {
    process.send!(message, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

async function blockAfter(message: Record<string, unknown>): Promise<never> {
  await announce(message);
  setInterval(() => undefined, 60_000);
  return await new Promise<never>(() => undefined);
}

class FixtureProvider implements ProviderAdapter {
  readonly id = PROVIDER;
  #requests = 0;

  constructor(private readonly toolName: string) {}

  async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
    this.#requests += 1;
    yield { type: "response_start", model: request.model };
    if (this.#requests === 1) {
      yield { type: "tool_call_start", index: 0, id: "process-death-call", name: this.toolName };
      yield {
        type: "tool_call_end",
        index: 0,
        id: "process-death-call",
        name: this.toolName,
        rawArguments: '{"value":"durable"}',
        arguments: { value: "durable" },
      };
      yield {
        type: "response_end",
        reason: "tool_calls",
        state: { kind: "chat_completions", assistantMessage: {} },
      };
      return;
    }
    yield { type: "text_delta", part: 0, text: "unexpected continuation" };
    yield {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: {} },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [structuredClone(MODEL_INFO)];
  }
}

function appendCounter(counterFile: string, event: string, mode: Mode): void {
  appendFileSync(counterFile, `${JSON.stringify({ event, mode, pid: process.pid })}\n`);
}

function installBoundaryStop(
  manager: SessionManager,
  scenario: BoundaryScenario,
  counterFile: string,
): void {
  const commitChanges = manager.commitChanges.bind(manager);
  let stopped = false;
  manager.commitChanges = (...args: Parameters<SessionManager["commitChanges"]>) => {
    const committed = commitChanges(...args);
    if (stopped) return committed;
    const boundaryReached = args[0].some((change) => {
      if (scenario === "accepted") return change.type === "run_accepted";
      if (scenario === "prepared") return change.type === "tool_effect_prepared";
      return change.type === "run_checkpoint" &&
        change.data !== null &&
        typeof change.data === "object" &&
        !Array.isArray(change.data) &&
        change.data["phase"] === "tool_effect_settled";
    });
    if (!boundaryReached) return committed;
    stopped = true;
    const event = scenario === "accepted"
      ? "operation-accepted-boundary"
      : scenario === "prepared"
        ? "tool-effect-prepared-boundary"
        : "tool-effect-settled-boundary";
    appendCounter(counterFile, event, "start");
    process.kill(process.pid, "SIGSTOP");
    return committed;
  };
}

function fixtureTool(
  scenario: Scenario,
  mode: Mode,
  sessionFile: string,
  counterFile: string,
): HarnessTool {
  const name = `process_death_${scenario}`;
  const recovery: ToolRecoveryContract = scenario === "reconcile"
    ? {
        mode: "reconcile",
        async recover() {
          appendCounter(counterFile, "reconcile_recover", mode);
          if (mode === "recover-crash") {
            return await blockAfter({ phase: "reconcile-recovery-started", sessionFile });
          }
          return { status: "not_applied" };
        },
      }
    : { mode: scenario === "repeatable" ? "repeatable" : "never_repeat" };
  return {
    definition: {
      name,
      description: `${name} deterministic crash-recovery fixture`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "string" } },
      },
    },
    recovery,
    validate(input) {
      if (
        input === null ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        typeof input.value !== "string"
      ) {
        throw new TypeError("value must be a string");
      }
    },
    resources() {
      return [];
    },
    async execute() {
      appendCounter(counterFile, "tool_execute", mode);
      if (scenario === "settled") return { content: "durable tool result", isError: false };
      if (mode === "start") {
        return await blockAfter({ phase: "initial-tool-side-effect", sessionFile });
      }
      if (scenario === "repeatable" && mode === "recover-crash") {
        return await blockAfter({ phase: "repeatable-recovery-side-effect", sessionFile });
      }
      return { content: "unexpected execution", isError: true };
    },
  };
}

async function openAgent(
  manager: SessionManager,
  scenario: Scenario,
  mode: Mode,
  sessionFile: string,
  counterFile: string,
): Promise<AgentSession> {
  const tool = fixtureTool(scenario, mode, sessionFile, counterFile);
  return await AgentSession.create({
    sessionManager: manager,
    providers: new ProviderRegistry([new FixtureProvider(tool.definition.name)]),
    settingsManager: SettingsManager.inMemory(),
    tools: [tool],
    allowedToolNames: [tool.definition.name],
    model: SELECTED_MODEL,
  });
}

async function start(scenario: Scenario, workspace: string, sessionDirectory: string, counterFile: string): Promise<void> {
  const manager = SessionManager.create(workspace, sessionDirectory, { id: `process-death-${scenario}` });
  const sessionFile = manager.getSessionFile();
  if (sessionFile === undefined) throw new Error("Persistent process-death fixture has no session file");
  if (isBoundaryScenario(scenario)) {
    installBoundaryStop(manager, scenario, counterFile);
    await announce({ phase: "boundary-session-ready", sessionFile });
  }
  const session = await openAgent(manager, scenario, "start", sessionFile, counterFile);
  await session.prompt("enter the durable tool boundary", {
    allowedTools: [`process_death_${scenario}`],
  });
  throw new Error("The process-death tool returned instead of blocking");
}

async function recoverBoundary(scenario: BoundaryScenario, sessionFile: string, counterFile: string): Promise<void> {
  const manager = SessionManager.open(sessionFile);
  const session = await openAgent(manager, scenario, "inspect-resolve", sessionFile, counterFile);
  const recovery = await session.recoverInterruptedRun();
  const repeated = await session.recoverInterruptedRun();
  await session.close();
  await announce({
    phase: "boundary-recovery-complete",
    sessionFile,
    recovery: { recovered: recovery.recovered, blocked: recovery.blocked.length },
    repeated: { recovered: repeated.recovered, blocked: repeated.blocked.length },
  });
}

async function recoverAndCrash(scenario: Scenario, sessionFile: string, counterFile: string): Promise<void> {
  if (scenario === "never_repeat") throw new Error("never_repeat does not have an automatic recovery crash phase");
  const manager = SessionManager.open(sessionFile);
  const session = await openAgent(manager, scenario, "recover-crash", sessionFile, counterFile);
  const result = await session.recoverInterruptedRun();
  await announce({ phase: "unexpected-recovery-return", result, sessionFile });
  await session.close();
  process.exitCode = 2;
}

async function inspectAndResolve(scenario: Scenario, sessionFile: string, counterFile: string): Promise<void> {
  const manager = SessionManager.open(sessionFile);
  const session = await openAgent(manager, scenario, "inspect-resolve", sessionFile, counterFile);
  const before = await session.recoverInterruptedRun();
  const stateBefore = manager.getV4State();
  const effectBefore = [...stateBefore.toolEffects.values()].at(-1);
  if (effectBefore === undefined) throw new Error("Interrupted process-death run has no tool effect");
  const resolved = await session.recoverInterruptedRun({
    resolutions: [{ effectId: effectBefore.id, outcome: "abandoned" }],
  });
  const stateAfter = manager.getV4State();
  const effectAfter = stateAfter.toolEffects.get(effectBefore.id);
  const operationAfter = stateAfter.operations.get(effectBefore.operationId);
  const inspection = {
    phase: "inspection-complete",
    sessionFile,
    before: {
      recovered: before.recovered,
      blocked: before.blocked.length,
      blockedEffectId: before.blocked[0]?.effectId,
    },
    effectBefore: {
      id: effectBefore.id,
      status: effectBefore.status,
      dispatchCount: effectBefore.dispatchIds.length,
    },
    resolved: {
      recovered: resolved.recovered,
      blocked: resolved.blocked.length,
    },
    effectStatusAfter: effectAfter?.status,
    operationStatusAfter: operationAfter?.status,
  };
  await session.close();
  await announce(inspection);
}

async function main(): Promise<void> {
  const mode = selectedMode(process.argv[2]);
  const scenario = selectedScenario(process.argv[3]);
  const counterFile = requiredEnvironment("RIGYN_PROCESS_DEATH_COUNTER");
  if (mode === "start") {
    await start(
      scenario,
      requiredEnvironment("RIGYN_PROCESS_DEATH_WORKSPACE"),
      requiredEnvironment("RIGYN_PROCESS_DEATH_SESSION_DIRECTORY"),
      counterFile,
    );
    return;
  }
  const sessionFile = requiredEnvironment("RIGYN_PROCESS_DEATH_SESSION_FILE");
  if (mode === "recover-crash") await recoverAndCrash(scenario, sessionFile, counterFile);
  else if (isBoundaryScenario(scenario)) await recoverBoundary(scenario, sessionFile, counterFile);
  else await inspectAndResolve(scenario, sessionFile, counterFile);
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
