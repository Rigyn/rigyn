import {
  AgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type AgentSessionAgent,
  type ModelRuntime,
  type ProviderModel,
  type ResourceLoader,
  type ToolExecutionBackend,
  type ToolDefinition,
} from "rigyn/sdk";
import type { Agent, AgentEvent, AgentState } from "@rigyn/kernel";

const customTool: ToolDefinition = {
  definition: {
    name: "consumer_probe",
    description: "SDK consumer type probe",
    inputSchema: { type: "object", additionalProperties: false },
  },
  validate() {},
  resources() { return []; },
  async execute() { return { content: "ready", isError: false }; },
};

declare const modelRuntime: ModelRegistry;
declare const model: ProviderModel;
declare const resourceLoader: ResourceLoader;
declare const toolBackend: ToolExecutionBackend;
const sessionManager = SessionManager.inMemory(process.cwd());
const settingsManager = SettingsManager.inMemory();

const options = {
  cwd: process.cwd(),
  agentDir: process.cwd(),
  modelRuntime,
  model,
  thinkingLevel: "medium",
  scopedModels: [{ model, thinkingLevel: "high" }],
  tools: ["read", "consumer_probe"],
  excludeTools: ["write"],
  customTools: [customTool],
  toolBackend,
  resourceLoader,
  sessionManager,
  settingsManager,
  sessionStartEvent: { type: "session_start", reason: "startup" },
} satisfies CreateAgentSessionOptions;

const factory: (input?: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult> = createAgentSession;
declare const created: CreateAgentSessionResult;
const session: AgentSession = created.session;
const agent: AgentSessionAgent = session.agent;
const lowLevelAgent: Pick<Agent, keyof Agent> = agent;
const lowLevelState: AgentState = agent.state;
const runtime: ModelRuntime = session.modelRuntime;
const unsubscribeAgent = agent.subscribe((event: AgentEvent, signal: AbortSignal) => {
  void [event.type, signal.aborted];
});
agent.state.systemPrompt = "consumer prompt";
agent.sessionId = "consumer-provider-session";
agent.transport = "auto";
agent.toolExecution = "parallel";
const unsubscribe = session.subscribe((event) => { void event.type; });
unsubscribe();
unsubscribeAgent();
void [factory, options, agent, lowLevelAgent, lowLevelState, runtime, DefaultResourceLoader, created.extensionsResult.runtime];
