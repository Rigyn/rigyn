import {
  isBashToolResult,
  isEditToolResult,
  isFindToolResult,
  isGrepToolResult,
  isLsToolResult,
  isReadToolResult,
  isToolCallEventType,
  isWriteToolResult,
  type AfterProviderResponseEvent,
  type AgentEndEvent,
  type AgentSettledEvent,
  type AgentStartEvent,
  type BashToolCallEvent,
  type BashToolResultEvent,
  type BeforeAgentStartEvent,
  type BeforeAgentStartEventResult,
  type BeforeProviderHeadersEvent,
  type BeforeProviderRequestEvent,
  type BeforeProviderRequestEventResult,
  type CompactionFileOperations,
  type CompactionPreparation,
  type CompactionSettings,
  type ContextEvent,
  type ContextEventResult,
  type CustomToolCallEvent,
  type CustomToolResultEvent,
  type EditToolCallEvent,
  type EditToolResultEvent,
  type Extension,
  type ExtensionActions,
  type ExtensionAPI,
  type ExtensionCommandContextActions,
  type ExtensionContextActions,
  type ExtensionError,
  type ExtensionEvent,
  type ExtensionEventMap,
  type ExtensionEventResultMap,
  type ExtensionFactory,
  type ExtensionHandler,
  type ExtensionMode,
  type ExtensionRuntime,
  type FindToolCallEvent,
  type FindToolResultEvent,
  type GrepToolCallEvent,
  type GrepToolResultEvent,
  type InlineExtension,
  type InputEvent,
  type InputEventResult,
  type LoadExtensionsResult,
  type LsToolCallEvent,
  type LsToolResultEvent,
  type MessageEndEvent,
  type MessageEndEventResult,
  type MessageStartEvent,
  type MessageUpdateEvent,
  type ModelSelectEvent,
  type ProjectTrustContext,
  type ProjectTrustEvent,
  type ProjectTrustEventDecision,
  type ProjectTrustEventResult,
  type ProjectTrustHandler,
  type ReadToolCallEvent,
  type ReadToolResultEvent,
  type ResourcesDiscoverEvent,
  type ResourcesDiscoverResult,
  type SessionBeforeCompactEvent,
  type SessionBeforeCompactResult,
  type SessionBeforeForkEvent,
  type SessionBeforeForkResult,
  type SessionBeforeSwitchEvent,
  type SessionBeforeSwitchResult,
  type SessionBeforeTreeEvent,
  type SessionBeforeTreeResult,
  type SessionCompactEvent,
  type SessionInfoChangedEvent,
  type SessionShutdownEvent,
  type SessionStartEvent,
  type SessionTreeEvent,
  type ThinkingLevelSelectEvent,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ToolExecutionEndEvent,
  type ToolExecutionStartEvent,
  type ToolExecutionUpdateEvent,
  type ToolResultEvent,
  type ToolResultEventResult,
  type TreePreparation,
  type TurnEndEvent,
  type TurnStartEvent,
  type UserBashEvent,
  type UserBashEventResult,
  type WriteToolCallEvent,
  type WriteToolResultEvent,
} from "rigyn/extensions";

export interface ExtensionApiExportFixture {
  api: ExtensionAPI;
  factory: ExtensionFactory;
  inline: InlineExtension;
  extension: Extension;
  error: ExtensionError;
  actions: ExtensionActions;
  contextActions: ExtensionContextActions;
  commandContextActions: ExtensionCommandContextActions;
  runtime: ExtensionRuntime;
  loadResult: LoadExtensionsResult;
}

export interface ExtensionEventExportFixture {
  afterProviderResponse: AfterProviderResponseEvent;
  agentEnd: AgentEndEvent;
  agentSettled: AgentSettledEvent;
  agentStart: AgentStartEvent;
  bashCall: BashToolCallEvent;
  bashResult: BashToolResultEvent;
  beforeAgentStart: BeforeAgentStartEvent;
  beforeAgentStartResult: BeforeAgentStartEventResult;
  beforeProviderHeaders: BeforeProviderHeadersEvent;
  beforeProviderRequest: BeforeProviderRequestEvent;
  beforeProviderRequestResult: BeforeProviderRequestEventResult;
  compactionFileOperations: CompactionFileOperations;
  compactionPreparation: CompactionPreparation;
  compactionSettings: CompactionSettings;
  context: ContextEvent;
  contextResult: ContextEventResult;
  customCall: CustomToolCallEvent;
  customResult: CustomToolResultEvent;
  editCall: EditToolCallEvent;
  editResult: EditToolResultEvent;
  event: ExtensionEvent;
  eventMap: ExtensionEventMap;
  eventResultMap: ExtensionEventResultMap;
  findCall: FindToolCallEvent;
  findResult: FindToolResultEvent;
  grepCall: GrepToolCallEvent;
  grepResult: GrepToolResultEvent;
  input: InputEvent;
  inputResult: InputEventResult;
  lsCall: LsToolCallEvent;
  lsResult: LsToolResultEvent;
  messageEnd: MessageEndEvent;
  messageEndResult: MessageEndEventResult;
  messageStart: MessageStartEvent;
  messageUpdate: MessageUpdateEvent;
  modelSelect: ModelSelectEvent;
  projectTrustContext: ProjectTrustContext;
  projectTrustDecision: ProjectTrustEventDecision;
  projectTrustEvent: ProjectTrustEvent;
  projectTrustResult: ProjectTrustEventResult;
  readCall: ReadToolCallEvent;
  readResult: ReadToolResultEvent;
  resourcesDiscover: ResourcesDiscoverEvent;
  resourcesDiscoverResult: ResourcesDiscoverResult;
  sessionBeforeCompact: SessionBeforeCompactEvent;
  sessionBeforeCompactResult: SessionBeforeCompactResult;
  sessionBeforeFork: SessionBeforeForkEvent;
  sessionBeforeForkResult: SessionBeforeForkResult;
  sessionBeforeSwitch: SessionBeforeSwitchEvent;
  sessionBeforeSwitchResult: SessionBeforeSwitchResult;
  sessionBeforeTree: SessionBeforeTreeEvent;
  sessionBeforeTreeResult: SessionBeforeTreeResult;
  sessionCompact: SessionCompactEvent;
  sessionInfoChanged: SessionInfoChangedEvent;
  sessionShutdown: SessionShutdownEvent;
  sessionStart: SessionStartEvent;
  sessionTree: SessionTreeEvent;
  thinkingLevelSelect: ThinkingLevelSelectEvent;
  toolCall: ToolCallEvent;
  toolCallResult: ToolCallEventResult;
  toolExecutionEnd: ToolExecutionEndEvent;
  toolExecutionStart: ToolExecutionStartEvent;
  toolExecutionUpdate: ToolExecutionUpdateEvent;
  toolResult: ToolResultEvent;
  toolResultResult: ToolResultEventResult;
  treePreparation: TreePreparation;
  turnEnd: TurnEndEvent;
  turnStart: TurnStartEvent;
  userBash: UserBashEvent;
  userBashResult: UserBashEventResult;
  writeCall: WriteToolCallEvent;
  writeResult: WriteToolResultEvent;
}

const extensionApiMembers = [
  "appendEntry",
  "config",
  "events",
  "exec",
  "getActiveTools",
  "getAllTools",
  "getCommands",
  "getDiscoveryView",
  "getFlag",
  "getSessionName",
  "getThinkingLevel",
  "on",
  "onDispose",
  "processes",
  "registerCommand",
  "registerEntryRenderer",
  "registerFlag",
  "registerMarkdownTransformer",
  "registerMessageRenderer",
  "registerProvider",
  "registerShortcut",
  "registerTool",
  "sendMessage",
  "sendUserMessage",
  "setActiveTools",
  "setLabel",
  "setModel",
  "setSessionName",
  "setThinkingLevel",
  "unregisterProvider",
] as const satisfies readonly (keyof ExtensionAPI)[];
type MissingExtensionApiMember = Exclude<keyof ExtensionAPI, (typeof extensionApiMembers)[number]>;
const noMissingExtensionApiMembers: Record<MissingExtensionApiMember, never> = {};

const extensionEventNames = [
  "resources_discover",
  "project_trust",
  "session_start",
  "session_info_changed",
  "session_before_switch",
  "session_before_fork",
  "session_before_tree",
  "session_tree",
  "session_before_compact",
  "session_compact",
  "session_shutdown",
  "context",
  "before_provider_request",
  "before_provider_headers",
  "after_provider_response",
  "before_agent_start",
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "model_select",
  "thinking_level_select",
  "input",
  "user_bash",
  "tool_call",
  "tool_result",
] as const satisfies readonly (keyof ExtensionEventMap)[];
type MissingExtensionEvent = Exclude<keyof ExtensionEventMap, (typeof extensionEventNames)[number]>;
const noMissingExtensionEvents: Record<MissingExtensionEvent, never> = {};

const eventResults = {
  resources_discover: { skillPaths: ["skills"] },
  project_trust: { trusted: "undecided" },
  session_start: undefined,
  session_info_changed: undefined,
  session_before_switch: { cancel: false },
  session_before_fork: { cancel: false },
  session_before_tree: { cancel: false },
  session_tree: undefined,
  session_before_compact: { cancel: false },
  session_compact: undefined,
  session_shutdown: undefined,
  context: { messages: [] },
  before_provider_request: null,
  before_provider_headers: undefined,
  after_provider_response: undefined,
  before_agent_start: { systemPrompt: "bounded" },
  agent_start: undefined,
  agent_end: undefined,
  agent_settled: undefined,
  turn_start: undefined,
  turn_end: undefined,
  message_start: undefined,
  message_update: undefined,
  message_end: {},
  tool_execution_start: undefined,
  tool_execution_update: undefined,
  tool_execution_end: undefined,
  model_select: undefined,
  thinking_level_select: undefined,
  input: { action: "continue" },
  user_bash: {
    command: "transformed",
    cwd: "/workspace",
    result: {
      output: "",
      isError: true,
      cancelled: false,
      timedOut: true,
      signal: "SIGTERM",
      truncated: false,
    },
  },
  tool_call: { block: false },
  tool_result: { isError: false },
} satisfies { [K in keyof ExtensionEventResultMap]: ExtensionEventResultMap[K] };

declare const api: ExtensionAPI;
declare const resultEvent: ToolResultEvent;

api.on("project_trust", (event, context) => {
  const type: "project_trust" = event.type;
  const mode: ExtensionMode = context.mode;
  void type;
  void mode;
  void context.ui.confirm("Trust", event.cwd);
  // @ts-expect-error Trust handlers receive only the limited trust context.
  context.compact();
  return { trusted: "undecided" };
});

api.on("input", (event, context) => {
  const type: "input" = event.type;
  void type;
  context.compact();
  return { action: "transform", text: event.text };
});

const trustHandler: ProjectTrustHandler = (_event, context) => {
  const mode: ExtensionMode = context.mode;
  return { trusted: mode === "tui" ? "undecided" : "no" };
};

function registerEvent<K extends keyof ExtensionEventMap>(name: K, handler: ExtensionHandler<K>): void {
  api.on(name, handler);
}

registerEvent("session_before_fork", (event) => {
  const position: "before" | "at" = event.position;
  return { cancel: position === "before" };
});

// @ts-expect-error Unknown events are not part of the public map.
api.on("theme_change", () => {});
// @ts-expect-error Input handlers cannot return an unrecognized action.
api.on("input", () => ({ action: "rewrite", text: "invalid" }));
// @ts-expect-error Tool guards can block; they cannot authorize a call.
api.on("tool_call", () => ({ decision: "allow_once" }));

if (isToolCallEventType(resultEvent, "custom_tool")) {
  const name: "custom_tool" = resultEvent.toolName;
  void name;
}
if (isBashToolResult(resultEvent)) {
  const command: string = resultEvent.input.command;
  // @ts-expect-error Bash input does not expose a file path.
  resultEvent.input.path;
  void command;
}
if (isReadToolResult(resultEvent)) {
  const path: string = resultEvent.input.path;
  void path;
}
if (isEditToolResult(resultEvent)) {
  const edits: Array<{ oldText: string; newText: string }> = resultEvent.input.edits;
  void edits;
}
if (isWriteToolResult(resultEvent)) {
  const content: string = resultEvent.input.content;
  void content;
}
if (isGrepToolResult(resultEvent)) {
  const name: string = resultEvent.toolName;
  void name;
}
if (isFindToolResult(resultEvent)) {
  const name: string = resultEvent.toolName;
  void name;
}
if (isLsToolResult(resultEvent)) {
  const name: string = resultEvent.toolName;
  void name;
}

const modes = ["tui", "print", "json", "rpc", "serve", "sdk"] as const satisfies readonly ExtensionMode[];
// @ts-expect-error Embedding uses the public sdk mode rather than a seventh literal.
const invalidMode: ExtensionMode = "embedding";

void [
  eventResults,
  extensionApiMembers,
  extensionEventNames,
  invalidMode,
  modes,
  noMissingExtensionApiMembers,
  noMissingExtensionEvents,
  trustHandler,
];
