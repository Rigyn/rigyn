import {
  AgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionImportFileNotFoundError,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createTool,
  defineTool,
  loadPromptTemplates,
  loadSkill,
  loadSkills,
  withFileMutationQueue,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type AgentSessionAgent,
  type AgentSessionRuntimeLifecycle,
  type AgentSessionRuntimeServices,
  type HarnessTool,
  type ModelRuntime,
  type PromptTemplate,
  type ProviderModel,
  type ResourceLoader,
  type SessionBranchQuery,
  type SessionGuardResult,
  type Skill,
  type Tool,
  type ToolExecutionBackend,
  type ToolAuthorizationHandler,
  type ToolDefinition,
} from "rigyn/sdk";
import type { AgentEvent } from "@rigyn/kernel";
import { Type } from "typebox";
import type {
  ProviderToolDefinition,
  ToolDefinition as RootToolDefinition,
} from "rigyn";
import type { ProviderToolDefinition as CoreToolDefinition } from "rigyn/core";
import type { ToolDefinition as ExtensionToolDefinition } from "rigyn/extensions";
import type { ToolDefinition as ToolsToolDefinition } from "rigyn/tools";

const harnessTool: HarnessTool = {
  definition: {
    name: "consumer_harness_probe",
    description: "SDK HarnessTool consumer type probe",
    inputSchema: { type: "object", additionalProperties: false },
  },
  validate() {},
  resources() { return []; },
  async execute() { return { content: "ready", isError: false }; },
};

const customTool = defineTool({
  name: "consumer_probe",
  label: "Consumer probe",
  description: "SDK direct tool consumer type probe",
  parameters: Type.Object({}, { additionalProperties: false }),
  async execute(_toolCallId, _input, _signal, _onUpdate, context) {
    return { content: [{ type: "text", text: context.cwd }], details: {} };
  },
});
const directDefinition: ToolDefinition = customTool;
const rootDefinition: RootToolDefinition = directDefinition;
const extensionDefinition: ExtensionToolDefinition = directDefinition;
const toolsDefinition: ToolsToolDefinition = directDefinition;
declare const providerDefinition: ProviderToolDefinition;
const coreDefinition: CoreToolDefinition = providerDefinition;
const factoryTool: Tool = createTool("read", process.cwd());
declare const promptTemplate: PromptTemplate;
declare const skill: Skill;

declare const modelRuntime: ModelRegistry;
declare const model: ProviderModel;
declare const resourceLoader: ResourceLoader;
declare const toolBackend: ToolExecutionBackend;
const toolAuthorizationHandler: ToolAuthorizationHandler = async (request, context) => {
  context.signal.throwIfAborted();
  void [
    request.invocation.name,
    request.resources,
    request.backendId,
    request.recovered,
    context.workspaceRoot,
    context.owner.kind,
  ];
  return { decision: "allow_once" };
};
const sessionManager = SessionManager.inMemory(process.cwd());
const branchQuery: SessionBranchQuery = { type: "message", limit: 1 };
const branchEntry = sessionManager.findEntryOnBranch(branchQuery);
const settingsManager = SettingsManager.inMemory();

const options = {
  cwd: process.cwd(),
  agentDir: process.cwd(),
  modelRuntime,
  model,
  thinkingLevel: "medium",
  scopedModels: [{ model, thinkingLevel: "high" }],
  modelCyclingEnabled: true,
  tools: ["read", "consumer_harness_probe", "consumer_probe"],
  excludeTools: ["write"],
  customTools: [harnessTool, customTool, factoryTool],
  toolBackend,
  toolAuthorizationHandler,
  resourceLoader,
  sessionManager,
  settingsManager,
  sessionStartEvent: { type: "session_start", reason: "startup" },
} satisfies CreateAgentSessionOptions;

const factory: (input?: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult> = createAgentSession;
declare const created: CreateAgentSessionResult;
const session: AgentSession = created.session;
const modelCyclingEnabled: boolean = session.modelCyclingEnabled;
session.setScopedModels(session.scopedModels, { cyclingEnabled: modelCyclingEnabled });
const agent: AgentSessionAgent = session.agent;
const runtime: ModelRuntime = session.modelRuntime;
const runtimeClose: Promise<void> = runtime.close();
const runtimeDispose: Promise<void> = runtime[Symbol.asyncDispose]();
declare const runtimeLifecycle: AgentSessionRuntimeLifecycle;
declare const runtimeServices: AgentSessionRuntimeServices;
declare const guardResult: SessionGuardResult;
const importFailure: Error = new SessionImportFileNotFoundError("missing-session.jsonl");
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
void [
  factory,
  runtimeClose,
  runtimeDispose,
  options,
  agent,
  runtime,
  runtimeLifecycle,
  runtimeServices,
  guardResult,
  branchEntry,
  importFailure,
  directDefinition,
  rootDefinition,
  extensionDefinition,
  toolsDefinition,
  coreDefinition,
  promptTemplate,
  skill,
  loadPromptTemplates,
  loadSkills,
  loadSkill,
  withFileMutationQueue,
  DefaultResourceLoader,
  created.extensionsResult.runtime,
];
