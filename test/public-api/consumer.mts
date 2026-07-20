import { resolve } from "node:path";

import {
  analyzeCacheEffectiveness,
  isNormalizedUsage,
  MODEL_REASONING_EFFORTS,
  modelReasoningEfforts,
  modelReferenceFailureMessage,
  normalizeModelReasoningEffort,
  normalizedContextTokens,
  normalizedTotalTokens,
  parseModelReasoningReference,
  createHarnessRuntime,
  imageCoordinateHint,
  HarnessService,
  MistralConversationsAdapter,
  ModelReferenceResolutionError,
  ProviderRegistry,
  sniffImageMediaType,
  WorkspaceBoundary,
  ExternalToolBackend,
  extensionGalleryInstallSource,
  parseExtensionGalleryIndex,
  type AdapterEvent,
  type CacheEffectiveness,
  type EventEnvelope,
  type HarnessOptions,
  type HarnessResourceCatalog,
  type HarnessSessionPage,
  type HarnessTranscriptPage,
  type HarnessRuntime,
  type HarnessTool,
  type JsonValue,
  type ImageCoordinateMetadata,
  type ModelCatalogStatus,
  type ModelCatalogStore,
  type ModelCompatibility,
  type ModelInfo,
  type ModelReasoningEffort,
  type ModelReferenceResolution,
  type ModelPricing,
  type MistralConversationsConfig,
  type ProviderAuthDescriptor,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderRegistryOptions,
  type PromptCompositionMetadata,
  type RpcOversizedEvent,
  type RoutedProviderStateProvenance,
  type ResourceClaim,
  type ResolvedModelSelection,
  type ResolveModelSelectionOptions,
  type RunOptions,
  type RuntimeAdvancedUiApi,
  type RuntimeAdvancedUiHostHandler,
  type RuntimeAdvancedUiKeyObserver,
  type RuntimeAdvancedUiOperation,
  type RuntimeAdvancedUiSlot,
  type RuntimeAdvancedUiWorkingIndicator,
  type RuntimeExtensionApi,
  type RuntimeExtensionDataPaths,
  type RuntimeAutocompleteCompletion,
  type RuntimeEditorMiddlewareResult,
  type RuntimeChildRunResult,
  type RuntimeChildEvent,
  type RuntimeChildSession,
  type RuntimeShutdownRequestResult,
  type RuntimeExtensionListenerContext,
  type RuntimeExtensionMessageAppendInput,
  type RuntimeExtensionMessageRecord,
  type RuntimeExtensionMessagesReadInput,
  type RuntimeDiscoverableResource,
  type RuntimeDiscoveryView,
  type RuntimeSessionUsageSnapshot,
  type RuntimeSystemPromptSnapshot,
  type RuntimeResourcesDiscoverEvent,
  type RuntimeResourcesDiscoverResult,
  type RuntimeExtensionSessionRenderer,
  type RuntimeExtensionStateAppendInput,
  type RuntimeExtensionStateCompareAndAppendInput,
  type RuntimeExtensionStateCompareAndAppendResult,
  type RuntimeExtensionStateReadInput,
  type RuntimeExtensionStateRecord,
  type RuntimeEntryLabelRecord,
  type RuntimeSessionNameRecord,
  type RuntimeToolCatalogEntry,
  type RuntimeCommandDescription,
  type RuntimeCommandRegistration,
  type RuntimeInputEvent,
  type RuntimeToolRegistration,
  type RuntimeToolContext,
  type RuntimeToolRenderView,
  type RpcExtensionUiRequest,
  type RpcCurrentSession,
  type RpcForkMessagePage,
  type RpcMethodResult,
  type RpcModelCycleResult,
  type RpcNotificationParams,
  type RpcRunStartParams,
  type RpcSessionCopyResult,
  type RpcSessionForkResult,
  type RpcThinkingCycleResult,
  type RpcThreadState,
  type RpcThreadStatistics,
  type RuntimeSessionBeforeCompactEvent,
  type RuntimeToolCallEvent,
  type RuntimeUiComponentFactory,
  type RuntimeUiCustomOptions,
  type RuntimeUiMarkdownOptions,
  type RuntimeUiOverlayHandle,
  type RuntimeUiPanelOptions,
  type RuntimeUiStackOptions,
  type RuntimeUiTextOptions,
  type RuntimeUiView,
  type SessionStore,
  type SessionExportRecord,
  type ToolResult,
  type ToolDefinition,
  type ToolExecutionMode,
  type ToolExecutionBackend,
  type ExternalToolBackendOptions,
  type ExtensionGalleryIndex,
  type ToolInputPreparer,
} from "rigyn";

const oversizedEvent = {
  reason: "event_exceeds_serialized_byte_limit",
  sequence: 2,
  serializedBytes: 2_000_000,
  maximumBytes: 1_000_000,
  resumeAfterSequence: 2,
} satisfies RpcOversizedEvent;
void oversizedEvent;

declare const publicRunHandle: Awaited<ReturnType<HarnessRuntime["start"]>>;
const retryCancellationAccepted: boolean = publicRunHandle.cancelRetry();
void retryCancellationAccepted;

const routedStateProvenance = {
  provider: "company",
  model: "public-model",
  delegate: "wire",
  upstreamModel: "upstream-model",
  protocolFamily: "openai-responses",
  scope: "00000000-0000-4000-8000-000000000000",
} satisfies RoutedProviderStateProvenance;
void routedStateProvenance;

declare const childSession: RuntimeChildSession;
declare const childEvent: RuntimeChildEvent;
declare const runtimeToolContext: RuntimeToolContext;
declare const runtimeToolView: RuntimeToolRenderView;
void [childSession.threadId, childEvent.sequence, runtimeToolContext.mode, runtimeToolView.isPartial];

declare const sessionExportRecord: SessionExportRecord;
void sessionExportRecord.type;

const mistralConversationsConfig = {
  store: false,
  fetch: (async () => new Response(null, { status: 204 })) as typeof fetch,
} satisfies MistralConversationsConfig;
const mistralConversations = new MistralConversationsAdapter(mistralConversationsConfig);
void mistralConversations.deleteConversation;

const rpcExtensionUiRequest: RpcExtensionUiRequest = {
  id: "consumer-ui",
  extensionId: "consumer",
  method: "confirm",
  title: "Confirm",
  message: "Continue?",
  timeoutMs: 1_000,
};
void rpcExtensionUiRequest;
declare const rpcThreadState: RpcThreadState;
declare const rpcThreadStatistics: RpcThreadStatistics;
void rpcThreadState.pendingMessageCount;
void rpcThreadStatistics.tokens.cacheRead;
declare const typedRpcHealth: RpcMethodResult<"health">;
declare const typedRpcResources: RpcMethodResult<"resources.list">;
declare const typedRpcRun: RpcRunStartParams;
declare const typedRpcEvent: RpcNotificationParams<"events.event">;
void [typedRpcHealth.status, typedRpcResources.schemaVersion, typedRpcRun.model, typedRpcEvent.subscriptionId];
declare const typedCurrentSession: RpcCurrentSession;
declare const typedForkMessages: RpcForkMessagePage;
declare const typedModelCycle: RpcModelCycleResult;
declare const typedThinkingCycle: RpcThinkingCycleResult;
declare const typedSessionCopy: RpcSessionCopyResult;
declare const typedSessionFork: RpcSessionForkResult;
void [
  typedCurrentSession.branch,
  typedForkMessages.nextCursor,
  typedModelCycle.availableModels,
  typedThinkingCycle.levels,
  typedSessionCopy.events,
  typedSessionFork.selectedText,
];

const cache: CacheEffectiveness = analyzeCacheEffectiveness([{ inputTokens: 10, cacheReadTokens: 90 }]);
void cache.status;
const normalizedUsage = { inputTokens: 10, cacheReadTokens: 90, totalTokens: 100 };
void isNormalizedUsage(normalizedUsage);
void normalizedContextTokens(normalizedUsage);
void normalizedTotalTokens(normalizedUsage);
const runtimeFactory: (options?: Parameters<typeof createHarnessRuntime>[0]) => Promise<HarnessRuntime> = createHarnessRuntime;
void runtimeFactory;
declare const publicRuntime: HarnessRuntime;
const publicCatalog: Promise<HarnessResourceCatalog> = publicRuntime.resourceCatalog();
void publicCatalog;

const imageCoordinates: ImageCoordinateMetadata = {
  originalWidth: 2,
  originalHeight: 2,
  width: 1,
  height: 1,
  scaleX: 2,
  scaleY: 2,
  orientationApplied: false,
  resized: true,
  converted: false,
};
void imageCoordinateHint(imageCoordinates);
void sniffImageMediaType(Buffer.from([0x42, 0x4d]));

const catalogStore: ModelCatalogStore = {
  async read() { return undefined; },
  async write(_value) {},
};
const catalogOptions = { catalogStore, cacheTtlMs: 30_000 } satisfies ProviderRegistryOptions;
const modelCompatibility = {
  protocolFamily: { value: "openai-chat-completions", source: "maintained", observedAt: "2026-07-10T00:00:00.000Z" },
  deferredTools: { value: "supported", source: "maintained", observedAt: "2026-07-12T00:00:00.000Z" },
} satisfies ModelCompatibility;
const deferredTool = {
  name: "catalog_lookup",
  description: "Look up an entry",
  inputSchema: { type: "object" },
  loading: "deferred",
} satisfies ToolDefinition;
const modelPricing = {
  currency: "USD",
  unit: "per_million_tokens",
  source: "provider",
  observedAt: "2026-07-10T00:00:00.000Z",
  input: 1,
} satisfies ModelPricing;
void modelCompatibility;
void deferredTool;
void modelPricing;
const reasoningEffort: ModelReasoningEffort = normalizeModelReasoningEffort("none");
const missingModel: ModelReferenceResolution = { query: "missing", match: "none", candidates: [] };
const resolutionError = new ModelReferenceResolutionError(missingModel);
const customSelection: ResolvedModelSelection = {
  provider: "consumer-offline",
  model: "custom-v1",
  match: "custom",
  reasoningEffort,
};
const selectionOptions = { provider: "consumer-offline", refresh: false } satisfies ResolveModelSelectionOptions;
declare const catalogModel: ModelInfo;
void MODEL_REASONING_EFFORTS;
void modelReasoningEfforts(catalogModel);
void modelReferenceFailureMessage(missingModel);
void resolutionError.resolution;
void parseModelReasoningReference("provider/model:high");
void customSelection;
void selectionOptions;
export function catalogIsStale(status: ModelCatalogStatus): boolean {
  return status.stale;
}

const extensionAuth = {
  provider: "consumer-offline",
  methods: [{ kind: "api_key", label: "Consumer key" }],
  request: { origins: ["https://consumer.example.test"], apiKey: { header: "x-api-key" } },
} satisfies ProviderAuthDescriptor;
void extensionAuth;

const advancedUiSlot: RuntimeAdvancedUiSlot = "widget";
const advancedUiIndicator = {
  frames: [".", "..", "..."],
  intervalMs: 120,
} satisfies RuntimeAdvancedUiWorkingIndicator;
const advancedUiKeyObserver: RuntimeAdvancedUiKeyObserver = (event) => {
  void [event.key, event.text, event.ctrl, event.alt, event.shift];
};
const advancedUiContract = {
  setComponent(_slot, _key, _factory) {},
  setWorkingIndicator(_value) {},
  setHiddenReasoningLabel(_value) {},
  getToolOutputExpanded() { return false; },
  setToolOutputExpanded(_expanded) {},
  observeKeys(_observer) { return () => {}; },
} satisfies RuntimeAdvancedUiApi;
const advancedUiHost = {
  apply(_operation) {},
  getToolOutputExpanded() { return false; },
} satisfies RuntimeAdvancedUiHostHandler;
const advancedUiOperationKinds = [
  "component",
  "working_indicator",
  "hidden_reasoning_label",
  "tool_output_expanded",
  "key_observer",
] satisfies readonly RuntimeAdvancedUiOperation["type"][];
const discoverableResource = {
  kind: "skill",
  name: "consumer-skill",
  description: "A bounded public discovery fixture",
  scope: "workspace",
  trusted: true,
  disableModelInvocation: false,
} satisfies RuntimeDiscoverableResource;
const discoverySnapshot = {
  resources: [discoverableResource],
  truncated: false,
  omitted: { commands: 0, prompts: 0, skills: 0 },
} satisfies RuntimeDiscoveryView;
const historicalUsageSnapshot = {
  threadId: "consumer-thread",
  branch: "main",
  runCount: 1,
  responseCount: 1,
  usageEventCount: 1,
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 4, cost: "0.001" },
  cache: {
    status: "mixed",
    samples: 1,
    observedInputTokens: 10,
    uncachedInputTokens: 6,
    cacheReadTokens: 4,
    cacheWriteTokens: 0,
    reuseRatio: 0.4,
  },
} satisfies RuntimeSessionUsageSnapshot;
const safePromptSnapshot = {
  threadId: "consumer-thread",
  branch: "main",
  text: "Bounded redacted instructions",
  bytes: 29,
  sha256: "a".repeat(64),
  redacted: true,
} satisfies RuntimeSystemPromptSnapshot;
void [
  advancedUiSlot,
  advancedUiIndicator,
  advancedUiKeyObserver,
  advancedUiContract,
  advancedUiHost,
  advancedUiOperationKinds,
  discoverySnapshot,
  historicalUsageSnapshot,
  safePromptSnapshot,
];

declare const extensionApi: RuntimeExtensionApi;
const extensionDataPaths: RuntimeExtensionDataPaths = extensionApi.dataPaths;
void [extensionDataPaths.user, extensionDataPaths.workspace];
const extensionCatalogPromise: Promise<HarnessResourceCatalog> = extensionApi.getResourceCatalog();
void extensionCatalogPromise;
const extensionDiscoveryPromise: Promise<RuntimeDiscoveryView> = extensionApi.getDiscoveryView();
void extensionDiscoveryPromise;
const extensionSessionsPromise: Promise<HarnessSessionPage> = extensionApi.listSessions({ search: "consumer", limit: 20 });
void extensionSessionsPromise;
const extensionTranscriptPromise: Promise<HarnessTranscriptPage> = extensionApi.getTranscript({
  threadId: "consumer-thread",
  branch: "main",
  limit: 64,
});
void extensionTranscriptPromise;
declare const extensionListenerContext: RuntimeExtensionListenerContext;
extensionListenerContext.signal.throwIfAborted();
void extensionListenerContext.extensionId;
extensionListenerContext.ui.notify("listener UI");
const theme = extensionListenerContext.ui.getTheme();
void theme;
extensionApi.ui.setWorkingMessage("consumer working");
extensionApi.ui.setWorkingVisible(true);
extensionApi.ui.registerAutocompleteProvider(({ cursor }): RuntimeAutocompleteCompletion[] => [{
  start: cursor,
  end: cursor,
  value: "consumer",
}]);
extensionApi.ui.registerEditorMiddleware((): RuntimeEditorMiddlewareResult => ({ action: "pass" }));
extensionApi.on("resources_discover", (event: RuntimeResourcesDiscoverEvent): RuntimeResourcesDiscoverResult => ({
  skillPaths: event.reason === "startup" ? ["skills"] : [],
  promptPaths: ["prompts"],
  themePaths: ["themes"],
}));
const extensionToolMode: ToolExecutionMode = "sequential";
const prepareExtensionToolInput: ToolInputPreparer = (input, context) => {
  context.signal.throwIfAborted();
  return input;
};
const extensionTool = {
  name: "consumer_extension_tool",
  description: "Prepared sequential extension tool",
  inputSchema: { type: "object" },
  loading: "deferred",
  prepareInput: prepareExtensionToolInput,
  executionMode: extensionToolMode,
  execute: async (_input, context) => {
    context.signal.throwIfAborted();
    void [context.threadId, context.runId, context.branch];
    return { content: "ok", isError: false };
  },
} satisfies RuntimeToolRegistration;
extensionApi.registerTool(extensionTool);
const terminatingToolResult = { content: "complete", isError: false, terminate: true } satisfies ToolResult;
void terminatingToolResult;
const extensionStateAppend = {
  threadId: "consumer-thread",
  branch: "main",
  schemaVersion: 1,
  key: "consumer_state",
  value: { enabled: true },
} satisfies RuntimeExtensionStateAppendInput;
const extensionStateRead = {
  threadId: "consumer-thread",
  schemaVersion: 1,
  key: "consumer_state",
} satisfies RuntimeExtensionStateReadInput;
const extensionStateCompareAndAppend = {
  ...extensionStateAppend,
  expectedEventId: null,
} satisfies RuntimeExtensionStateCompareAndAppendInput;
const extensionMessageAppend = {
  threadId: "consumer-thread",
  schemaVersion: 1,
  kind: "consumer_message",
  payload: { source: "consumer" },
  modelContext: { role: "system", text: "consumer context" },
  transcript: { text: "consumer display" },
} satisfies RuntimeExtensionMessageAppendInput;
const extensionMessagesRead = {
  threadId: "consumer-thread",
  schemaVersion: 1,
  kind: "consumer_message",
  limit: 10,
  beforeEventId: "event-cursor",
} satisfies RuntimeExtensionMessagesReadInput;
const extensionSessionRenderer = {
  renderState(entry) {
    return { lines: [{ spans: [{ text: `${entry.key}:${entry.schemaVersion}`, role: "accent" }] }] };
  },
  renderMessage(entry) {
    return { lines: [{ spans: [{ text: entry.kind, role: "muted" }] }] };
  },
} satisfies RuntimeExtensionSessionRenderer;
extensionApi.session.registerRenderers(1, extensionSessionRenderer);
const extensionStatePromise: Promise<RuntimeExtensionStateRecord> = extensionApi.session.appendState(extensionStateAppend);
const extensionStateComparePromise: Promise<RuntimeExtensionStateCompareAndAppendResult> =
  extensionApi.session.compareAndAppendState(extensionStateCompareAndAppend);
const extensionStateReadPromise: Promise<RuntimeExtensionStateRecord | undefined> = extensionApi.session.readState(extensionStateRead);
const extensionMessagePromise: Promise<RuntimeExtensionMessageRecord> = extensionApi.session.appendMessage(extensionMessageAppend);
const extensionMessagesPromise: Promise<RuntimeExtensionMessageRecord[]> = extensionApi.session.readMessages(extensionMessagesRead);
void [extensionStatePromise, extensionStateComparePromise, extensionStateReadPromise, extensionMessagePromise, extensionMessagesPromise];
extensionApi.events.on("consumer.updated", (payload, context) => { void [payload, context.signal]; });
void extensionApi.events.emit("consumer.updated", { ready: true });
void extensionApi.sendUserMessage({
  threadId: "consumer-thread",
  text: "continue",
  delivery: "follow_up",
});
void extensionApi.sendMessage(extensionMessageAppend);
void extensionApi.getSession({ threadId: "consumer-thread" });
const extensionChild: Promise<RuntimeChildRunResult> = extensionApi.runChild({
  threadId: "consumer-thread",
  prompt: "inspect the focused failure",
  context: "fresh",
  tools: ["read", "grep"],
  appendSystemPrompt: "Report evidence before recommendations.",
  execution: { backend: "inherit", requireAllTools: true },
});
void extensionChild.then((result) => {
  void [result.model.provider, result.execution.backend, result.usage?.totalTokens, result.artifacts[0]?.sha256, result.artifactsTruncated];
});
const extensionShutdown: Promise<RuntimeShutdownRequestResult> = extensionApi.requestShutdown({ reason: "consumer request" });
const promptComposition = {
  bytes: 0,
  sha256: "a".repeat(64),
  sources: [],
  tools: ["read"],
  skills: [],
  truncated: false,
} satisfies PromptCompositionMetadata;
void extensionApi.getSessionTree({ threadId: "consumer-thread" });
const extensionToolCatalog: Promise<RuntimeToolCatalogEntry[]> = extensionApi.getAllTools({ threadId: "consumer-thread" });
const extensionCommandCatalog: RuntimeCommandDescription[] = extensionApi.getCommands();
const extensionUsage: Promise<RuntimeSessionUsageSnapshot> = extensionApi.getSessionUsage({ threadId: "consumer-thread" });
const extensionPrompt: Promise<RuntimeSystemPromptSnapshot | undefined> = extensionApi.getSystemPromptSnapshot({ threadId: "consumer-thread" });
const extensionName: Promise<RuntimeSessionNameRecord> = extensionApi.setSessionName({
  threadId: "consumer-thread",
  name: "consumer session",
});
const extensionLabel: Promise<RuntimeEntryLabelRecord> = extensionApi.setEntryLabel({
  threadId: "consumer-thread",
  targetEventId: "event-1",
  label: "checkpoint",
});
void [extensionToolCatalog, extensionCommandCatalog, extensionUsage, extensionPrompt, extensionName, extensionLabel, extensionChild, extensionShutdown, promptComposition];
void extensionApi.setModel({
  threadId: "consumer-thread",
  provider: "consumer-offline",
  model: "consumer-model",
});
void extensionApi.exec({ command: "node", args: ["--version"] });
const extensionCommand = {
  name: "consumer-command",
  getArgumentCompletions: async (prefix: string) => [{ value: `${prefix}value` }],
  execute: async ({ args }) => ({ prompt: args }),
} satisfies RuntimeCommandRegistration;
extensionApi.registerCommand(extensionCommand);
void extensionApi.registerProviderAuth.bind(extensionApi, extensionAuth);
void extensionApi.auth.fetch.bind(extensionApi.auth, "consumer-offline");
extensionApi.registerFlag({ name: "consumer-mode", type: "string", default: "safe" });
extensionApi.registerShortcut({ shortcut: "ctrl+shift+c", execute(context) { void context.threadId; } });
extensionApi.on("input", (event: RuntimeInputEvent) => ({ action: "transform", text: event.text.trim() }));
extensionApi.on("context", (event) => ({ messages: event.messages }));
extensionApi.on("message_end", (event) => ({ message: event.message }));
extensionApi.on("agent_start", (event) => { void [event.threadId, event.runId, event.provider, event.model]; });
extensionApi.on("agent_end", (event) => { void [event.threadId, event.runId, event.outcome.status]; });
extensionApi.on("agent_settled", (event) => { void event.outcome; });
extensionApi.on("turn_start", (event) => { void [event.step, event.messageCount, event.toolCount]; });
extensionApi.on("turn_end", (event) => { void [event.step, event.outcome.status]; });
extensionApi.on("message_start", (event) => { void [event.step, event.role]; });
extensionApi.on("message_update", (event) => {
  if (event.kind === "text" || event.kind === "reasoning") void [event.delta, event.part];
  else if (event.kind === "tool_call_start") void [event.index, event.id, event.name];
  else if (event.kind === "tool_call_delta") void [event.index, event.jsonFragment];
  else void [event.index, event.id, event.name, event.rawArguments, event.arguments, event.parseError];
});
extensionApi.on("tool_call", (event: RuntimeToolCallEvent) => {
  void [event.callId, event.threadId, event.runId, event.branch];
  return { block: false };
});
extensionApi.on("tool_result", (event) => ({ content: event.result.content }));
extensionApi.on("tool_execution_start", (event) => { void event.invocation.callId; });
extensionApi.on("tool_execution_update", (event) => {
  if (event.phase === "progress") {
    void [event.sequence, event.progress.type === "output" ? event.progress.delta : event.progress.content];
  }
  else void event.invocation.name;
});
extensionApi.on("tool_execution_end", (event) => { void event.outcome.status; });
extensionApi.on("model_select", (event) => { void [event.provider, event.model, event.source]; });
extensionApi.on("thinking_level_select", (event) => { void [event.level, event.source]; });
extensionApi.on("session_shutdown", (event) => { void [event.reason, event.workspace]; });
extensionApi.on("session_info_changed", (event) => { void [event.threadId, event.branch, event.name]; });
extensionApi.on("user_shell", (event) => { void [event.command, event.result.exitCode]; });
extensionApi.on("event", (event) => {
  if ("event" in event) void event.event.type;
  else void event.result.text;
});
extensionApi.on("session_before_compact", (event: RuntimeSessionBeforeCompactEvent) => ({
  compaction: { text: `consumer summary for ${event.plan.sourceMessageIds.length} messages` },
}));
const customUi = ((host) => ({
  render(context) {
    return { lines: [{ spans: [{ text: `${context.width}:${host.signal.aborted}`, role: "accent" }] }] };
  },
  handleKey(event) {
    if (event.key === "escape") host.close("closed");
    return true;
  },
})) satisfies RuntimeUiComponentFactory<string>;
const customUiOptions = { overlay: true, overlayOptions: { anchor: "center", width: "60%" } } satisfies RuntimeUiCustomOptions;
declare const customUiHandle: RuntimeUiOverlayHandle<string>;
const componentTextOptions = { role: "accent", wrap: true } satisfies RuntimeUiTextOptions;
const componentMarkdownOptions = { role: "assistant" } satisfies RuntimeUiMarkdownOptions;
const componentStackOptions = { gap: 1 } satisfies RuntimeUiStackOptions;
const componentPanelOptions = { title: "Consumer", padding: 1 } satisfies RuntimeUiPanelOptions;
declare const componentView: RuntimeUiView;
void [
  customUi,
  customUiOptions,
  customUiHandle.result,
  componentTextOptions,
  componentMarkdownOptions,
  componentStackOptions,
  componentPanelOptions,
  componentView.render,
];
void extensionApi.getFlag("consumer-mode");
const capability = {
  value: "unknown",
  source: "configuration",
  observedAt: "2026-01-01T00:00:00.000Z",
} as const;

const workspace = resolve(".");
const emptyGallery: ExtensionGalleryIndex = parseExtensionGalleryIndex({ schemaVersion: 1, packages: [] });
void [emptyGallery.packages, extensionGalleryInstallSource];
const externalBackendOptions = {
  id: "consumer-boundary",
  argv: [process.execPath] as [string],
  cwd: workspace,
  workspace: "/workspace",
  tools: { read: "read" },
} satisfies ExternalToolBackendOptions;
const externalBackend: ToolExecutionBackend = new ExternalToolBackend(externalBackendOptions);
void externalBackend.id;

const provider: ProviderAdapter = {
  id: "consumer-offline",
  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    signal.throwIfAborted();
    yield { type: "response_start", model: request.model };
    yield { type: "text_delta", part: 0, text: "ok" };
    yield {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "ok" } },
    };
  },
  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    signal.throwIfAborted();
    return [{
      id: "consumer-v1",
      provider: this.id,
      capabilities: { tools: capability, reasoning: capability, images: capability },
    }];
  },
};

const tool: HarnessTool = {
  definition: {
    name: "consumer_tool",
    description: "Offline consumer contract tool",
    inputSchema: { type: "object", additionalProperties: false },
  },
  prepareInput: prepareExtensionToolInput,
  executionMode: extensionToolMode,
  validate(_input: JsonValue): void {},
  resources(): ResourceClaim[] {
    return [];
  },
  async execute(_input, context): Promise<ToolResult> {
    context.signal.throwIfAborted();
    return { content: "ok", isError: false };
  },
};

export function constructConsumer(store: SessionStore): HarnessService {
  const options: HarnessOptions = {
    store,
    workspace,
    providers: new ProviderRegistry([provider], catalogOptions),
    projectTrusted: false,
    userInstructions: { text: "Stay offline.", source: "consumer" },
    skillRoots: [{ path: workspace, scope: "workspace", trusted: true }],
    extraTools: [tool],
  };
  const service = new HarnessService(options);
  const run: RunOptions = {
    prompt: "consumer contract",
    provider: provider.id,
    model: "consumer-v1",
    onEvent(event: EventEnvelope): void {
      void event.sequence;
    },
  };
  void service.run.bind(service, run);
  void service.listSessions({ limit: 20 });
  void WorkspaceBoundary.create;
  return service;
}
