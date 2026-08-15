import {
  ExecutionError,
  FileError,
  createBashTool,
  createExecutionTools,
  uuidv7,
  type AfterToolCallContext,
  type AfterToolCallResult,
  type AgentContext,
  type AgentEvent,
  type AgentLoopTurnUpdate,
  type AgentMessage,
  type AgentTool,
  type AssistantMessage,
  type AssistantMessageEvent,
  type BashExecutionMessage,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type CustomMessage,
  type ExecutionEnv,
  type ExecutionToolContext,
  type FileInfo,
  type Model,
  type PrepareNextTurnContext,
  type ShellExecOptions,
  type ShellExecResult,
  type ToolCall,
  type ToolExecutionMode,
  type ToolResultMessage,
  type ThinkingLevel,
  type Usage,
} from "../src/index.js";
import type {
  FileAccess,
  FileErrorCode,
  FileKind,
  FileWriteContent,
} from "../src/capabilities/filesystem.js";
import type { ExecutionErrorCode, ShellRunner } from "../src/capabilities/process.js";

const maximumThinking: ThinkingLevel = "max";
// @ts-expect-error ultra is not a canonical Rigyn thinking level.
const removedThinking: ThinkingLevel = "ultra";
void [maximumThinking, removedThinking];

// @ts-expect-error FileKind is an implementation-module export, not a root package export.
import type { FileKind as RootFileKind } from "../src/index.js";
// @ts-expect-error FileErrorCode is an implementation-module export, not a root package export.
import type { FileErrorCode as RootFileErrorCode } from "../src/index.js";
// @ts-expect-error FileWriteContent is an implementation-module export, not a root package export.
import type { FileWriteContent as RootFileWriteContent } from "../src/index.js";
// @ts-expect-error FileAccess is an implementation-module export, not a root package export.
import type { FileAccess as RootFileAccess } from "../src/index.js";
// @ts-expect-error ExecutionErrorCode is an implementation-module export, not a root package export.
import type { ExecutionErrorCode as RootExecutionErrorCode } from "../src/index.js";
// @ts-expect-error ShellRunner is an implementation-module export, not a root package export.
import type { ShellRunner as RootShellRunner } from "../src/index.js";
import type {
  AdapterError,
  AdapterEvent,
  AssistantContentBlock,
  CanonicalMessage,
  CapabilityValue,
  ContentBlock,
  FinishReason,
  ImageBlock,
  ModelCacheAffinity,
  ModelCacheMode,
  ModelCacheTier,
  ModelCapability,
  ModelChatTemplateValue,
  ModelChatTemplateVariable,
  ModelCompatibility,
  ModelEvidence,
  ModelInfo,
  ModelMetadataSource,
  ModelModality,
  ModelOpenRouterRouting,
  ModelPricing,
  ModelPricingTier,
  ModelProtocolFamily,
  ModelReasoningFormat,
  ModelRequestCompatibility,
  ModelSessionAffinity,
  ModelSessionAffinityFormat,
  ModelTokenPrices,
  ModelVercelGatewayRouting,
  NormalizedUsage,
  OpaqueBlock,
  OutboundImagePolicy,
  PromptCompositionMetadata,
  PromptCompositionSource,
  PromptCompositionSourceKind,
  ProviderAdapter,
  ProviderCacheRetention,
  ProviderId,
  ProviderModelRequestSettings,
  ProviderRequest,
  ProviderResponseDiagnostics,
  ProviderResponseFailureMetadata,
  ProviderState,
  ProviderStateSource,
  ProviderToolDefinition,
  RoutedProviderStateProvenance,
  TextBlock,
  ThinkingBlock,
  ThinkingBudgets,
  ToolCallBlock,
  ToolResultBlock,
  UsageCost,
} from "../src/runtime/index.js";

/** Compile-time inventory of every type assembled by the public runtime contract barrel. */
export interface PublicRuntimeContractTypeInventory {
  identity: {
    ProviderId: ProviderId;
    OutboundImagePolicy: OutboundImagePolicy;
    FinishReason: FinishReason;
  };
  content: {
    TextBlock: TextBlock;
    ThinkingBlock: ThinkingBlock;
    ImageBlock: ImageBlock;
    ToolCallBlock: ToolCallBlock;
    ToolResultBlock: ToolResultBlock;
    OpaqueBlock: OpaqueBlock;
    ContentBlock: ContentBlock;
    AssistantContentBlock: AssistantContentBlock;
    CanonicalMessage: CanonicalMessage;
    ProviderToolDefinition: ProviderToolDefinition;
  };
  usage: {
    NormalizedUsage: NormalizedUsage;
    UsageCost: UsageCost;
  };
  promptComposition: {
    PromptCompositionSourceKind: PromptCompositionSourceKind;
    PromptCompositionSource: PromptCompositionSource;
    PromptCompositionMetadata: PromptCompositionMetadata;
  };
  diagnosticsAndState: {
    AdapterError: AdapterError;
    ProviderResponseDiagnostics: ProviderResponseDiagnostics;
    ProviderResponseFailureMetadata: ProviderResponseFailureMetadata;
    RoutedProviderStateProvenance: RoutedProviderStateProvenance;
    ProviderStateSource: ProviderStateSource;
    ProviderState: ProviderState;
  };
  adapterEvents: {
    AdapterEvent: AdapterEvent;
  };
  models: {
    CapabilityValue: CapabilityValue;
    ModelMetadataSource: ModelMetadataSource;
    ModelEvidence: ModelEvidence<unknown>;
    ModelCapability: ModelCapability;
    ModelProtocolFamily: ModelProtocolFamily;
    ModelModality: ModelModality;
    ModelCacheMode: ModelCacheMode;
    ModelCacheAffinity: ModelCacheAffinity;
    ModelCacheTier: ModelCacheTier;
    ProviderCacheRetention: ProviderCacheRetention;
    ModelSessionAffinity: ModelSessionAffinity;
    ModelCompatibility: ModelCompatibility;
    ModelTokenPrices: ModelTokenPrices;
    ModelPricingTier: ModelPricingTier;
    ModelPricing: ModelPricing;
    ModelInfo: ModelInfo;
    ModelReasoningFormat: ModelReasoningFormat;
    ModelSessionAffinityFormat: ModelSessionAffinityFormat;
    ModelChatTemplateVariable: ModelChatTemplateVariable;
    ModelChatTemplateValue: ModelChatTemplateValue;
    ModelOpenRouterRouting: ModelOpenRouterRouting;
    ModelVercelGatewayRouting: ModelVercelGatewayRouting;
    ModelRequestCompatibility: ModelRequestCompatibility;
  };
  requests: {
    ProviderModelRequestSettings: ProviderModelRequestSettings;
    ProviderRequest: ProviderRequest;
    ThinkingBudgets: ThinkingBudgets;
    ProviderAdapter: ProviderAdapter;
  };
}

/** Compile-time inventory of every retained filesystem, process, and lifecycle declaration. */
export interface CapabilityContractTypeInventory {
  filesystem: {
    FileKind: FileKind;
    FileInfo: FileInfo;
    FileErrorCode: FileErrorCode;
    FileError: FileError;
    FileWriteContent: FileWriteContent;
    FileAccess: FileAccess;
  };
  process: {
    ExecutionErrorCode: ExecutionErrorCode;
    ExecutionError: ExecutionError;
    ShellExecOptions: ShellExecOptions;
    ShellExecResult: ShellExecResult;
    ShellRunner: ShellRunner;
    ExecutionEnv: ExecutionEnv;
  };
  lifecycle: {
    AgentContext: AgentContext;
    BeforeToolCallContext: BeforeToolCallContext;
    AfterToolCallContext: AfterToolCallContext;
    AfterToolCallResult: AfterToolCallResult;
    PrepareNextTurnContext: PrepareNextTurnContext;
    AgentLoopTurnUpdate: AgentLoopTurnUpdate;
    ToolExecutionMode: ToolExecutionMode;
    AgentEvent: AgentEvent;
  };
}

/** These aliases compile only while internal capability names remain absent from the root barrel. */
export type InternalRootLeakProbe = [
  RootFileKind,
  RootFileErrorCode,
  RootFileWriteContent,
  RootFileAccess,
  RootExecutionErrorCode,
  RootShellRunner,
];

const fileKind: FileKind = "symlink";
const fileInfo: FileInfo = {
  name: "notes.txt",
  path: "/workspace/notes.txt",
  kind: "file",
  size: 12,
  mtimeMs: 1,
};
const fileErrorCode: FileErrorCode = "permission_denied";
const fileError = new FileError(fileErrorCode, "blocked", fileInfo.path, { operation: "read" });
async function* fileChunks(): AsyncIterable<Uint8Array> {
  yield new Uint8Array([1, 2, 3]);
}
const streamedFile: FileWriteContent = fileChunks();
const fileAccess: FileAccess = {
  cwd: "/workspace",
  async absolutePath(path) { return { ok: true, value: path }; },
  async canonicalPath(path) { return { ok: true, value: path }; },
  async fileInfo(_path, _signal) { return { ok: true, value: fileInfo }; },
  async listDir(_path, _signal) { return { ok: true, value: [fileInfo] }; },
  async exists(_path, _signal) { return { ok: true, value: true }; },
  async readTextFile(_path, _signal, _maxBytes) { return { ok: true, value: "ready" }; },
  async readTextLines(_path, _options) { return { ok: true, value: ["ready"] }; },
  async readBinaryFile(_path, _signal, _maxBytes) { return { ok: true, value: new Uint8Array() }; },
  async writeFile(_path, _content, _signal) { return { ok: true, value: undefined }; },
  async replaceFile(_path, _content, _signal) { return { ok: true, value: undefined }; },
  async appendFile(_path, _content, _signal) { return { ok: true, value: undefined }; },
  async createDir(_path, _options, _signal) { return { ok: true, value: undefined }; },
  async createTempFile(_options) { return { ok: true, value: { path: "/tmp/capture" } }; },
};
void [fileKind, fileError, streamedFile, fileAccess];

// @ts-expect-error FileKind excludes socket-like entries.
const invalidFileKind: FileKind = "socket";
void invalidFileKind;

// @ts-expect-error FileInfo requires modification-time metadata.
const incompleteFileInfo: FileInfo = {
  name: "notes.txt",
  path: "/workspace/notes.txt",
  kind: "file",
  size: 12,
};
void incompleteFileInfo;

// @ts-expect-error FileErrorCode is a closed failure vocabulary.
const invalidFileErrorCode: FileErrorCode = "busy";
void invalidFileErrorCode;

// @ts-expect-error FileError accepts only the declared failure vocabulary.
const invalidFileError = new FileError("busy", "try later");
void invalidFileError;

// @ts-expect-error FileError metadata is immutable after construction.
fileError.code = "unknown";

// @ts-expect-error FileWriteContent excludes arbitrary numeric values.
const invalidFileContent: FileWriteContent = 42;
void invalidFileContent;

// @ts-expect-error FileAccess requires canonical path resolution.
const incompleteFileAccess: FileAccess = { ...fileAccess, canonicalPath: undefined };
void incompleteFileAccess;

const executionErrorCode: ExecutionErrorCode = "callback_error";
const executionError = new ExecutionError(executionErrorCode, "callback failed", { stream: "stdout" });
const shellOptions: ShellExecOptions = {
  cwd: "/workspace",
  env: { RIGYN_TEST: "1", OPTIONAL: undefined },
  timeout: 5,
  abortSignal: new AbortController().signal,
  onStdout(chunk) { void chunk; },
  onStderr(chunk) { void chunk; },
};
const shellResult: ShellExecResult = { stdout: "ready\n", stderr: "", exitCode: 0 };
const executionEnvironment: ExecutionEnv = {
  ...fileAccess,
  async exec(_command, _options) { return { ok: true, value: shellResult }; },
  async cleanup() {},
};
const shellRunner: ShellRunner = executionEnvironment;
void [executionError, shellOptions, shellRunner];

// @ts-expect-error ExecutionErrorCode is a closed failure vocabulary.
const invalidExecutionErrorCode: ExecutionErrorCode = "nonzero_exit";
void invalidExecutionErrorCode;

// @ts-expect-error ExecutionError accepts only the declared failure vocabulary.
const invalidExecutionError = new ExecutionError("nonzero_exit", "failed");
void invalidExecutionError;

// @ts-expect-error ExecutionError metadata is immutable after construction.
executionError.code = "unknown";

const invalidShellOptions: ShellExecOptions = {
  env: {
    // @ts-expect-error Shell environment values are strings or undefined.
    RIGYN_TEST: 1,
  },
};
void invalidShellOptions;

// @ts-expect-error ShellExecResult always reports stderr.
const incompleteShellResult: ShellExecResult = { stdout: "ready", exitCode: 0 };
void incompleteShellResult;

// @ts-expect-error ShellRunner must return a typed execution result.
const invalidShellRunner: ShellRunner = { async exec() { return "ready"; } };
void invalidShellRunner;

// @ts-expect-error ExecutionEnv includes process execution as well as file access.
const fileOnlyEnvironment: ExecutionEnv = fileAccess;
void fileOnlyEnvironment;

declare const assistantMessage: AssistantMessage;
declare const assistantMessageEvent: AssistantMessageEvent;
declare const model: Model;
declare const tool: AgentTool;
declare const toolCall: ToolCall;
declare const toolResultMessage: ToolResultMessage;
declare const usage: Usage;

const agentContext: AgentContext = { systemPrompt: "system", messages: [], tools: [tool] };
const beforeToolCallContext: BeforeToolCallContext = {
  assistantMessage,
  toolCall,
  args: { path: "notes.txt" },
  context: agentContext,
};
const afterToolCallContext: AfterToolCallContext = {
  ...beforeToolCallContext,
  result: {
    content: [{ type: "text", text: "ready" }],
    details: { reviewed: true },
    usage,
    addedToolNames: ["search"],
    terminate: false,
  },
  isError: false,
};
const afterToolCallResult: AfterToolCallResult = {
  content: [{ type: "text", text: "updated" }],
  details: { reviewed: true },
  isError: false,
  usage,
  terminate: false,
};
const nextTurnContext: PrepareNextTurnContext = {
  message: assistantMessage,
  toolResults: [toolResultMessage],
  context: agentContext,
  newMessages: [],
};
const turnUpdate: AgentLoopTurnUpdate = {
  model,
  thinkingLevel: "high",
  context: agentContext,
};
const executionMode: ToolExecutionMode = "parallel";
const lifecycleEvents: AgentEvent[] = [
  { type: "agent_start" },
  { type: "agent_end", messages: [], willRetry: false },
  { type: "turn_start", turnIndex: 0, timestamp: 1 },
  { type: "turn_end", turnIndex: 0, message: assistantMessage, toolResults: [toolResultMessage] },
  { type: "message_start", message: assistantMessage },
  { type: "message_update", message: assistantMessage, assistantMessageEvent },
  { type: "message_end", message: assistantMessage },
  { type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: {} },
  { type: "tool_execution_update", toolCallId: "call-1", toolName: "read", partialResult: "working" },
  { type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: "ready", isError: false },
];
void [
  beforeToolCallContext,
  afterToolCallContext,
  afterToolCallResult,
  nextTurnContext,
  turnUpdate,
  executionMode,
  lifecycleEvents,
];

// @ts-expect-error AgentContext requires a message collection.
const incompleteAgentContext: AgentContext = { systemPrompt: "system" };
void incompleteAgentContext;

// @ts-expect-error BeforeToolCallContext requires the selected tool call.
const incompleteBeforeToolCall: BeforeToolCallContext = {
  assistantMessage,
  args: {},
  context: agentContext,
};
void incompleteBeforeToolCall;

const incompleteAfterToolCall: AfterToolCallContext = {
  ...beforeToolCallContext,
  // @ts-expect-error Completed tool results require details.
  result: { content: [] },
  isError: false,
};
void incompleteAfterToolCall;

const invalidAfterToolCallResult: AfterToolCallResult = {
  // @ts-expect-error Hook replacements accept text and image content only.
  content: [{ type: "audio", data: "" }],
};
void invalidAfterToolCallResult;

// @ts-expect-error PrepareNextTurnContext requires the newly produced messages.
const incompleteNextTurnContext: PrepareNextTurnContext = {
  message: assistantMessage,
  toolResults: [],
  context: agentContext,
};
void incompleteNextTurnContext;

const invalidTurnUpdate: AgentLoopTurnUpdate = {
  // @ts-expect-error A replacement context requires both prompt and messages.
  context: { systemPrompt: "replacement" },
};
void invalidTurnUpdate;

// @ts-expect-error Tool execution supports only parallel or sequential scheduling.
const invalidExecutionMode: ToolExecutionMode = "serial";
void invalidExecutionMode;

// @ts-expect-error Turn-start events require an index and timestamp.
const incompleteAgentEvent: AgentEvent = { type: "turn_start", timestamp: 1 };
void incompleteAgentEvent;

const generatedId: string = uuidv7();
void generatedId;

interface SessionToolContext extends ExecutionToolContext {
  sessionId: string;
}
const executionTools = createExecutionTools<SessionToolContext>();
const preparedBash = createBashTool<SessionToolContext>({
  prepare(execution, context) {
    execution.env.RIGYN_SESSION_ID = context.sessionId;
  },
});
void executionTools;
void preparedBash;

const reasoningCompatibility: ModelRequestCompatibility = {
  maxTokensField: "max_completion_tokens",
  supportsReasoningSummaries: true,
  exposesReasoningText: false,
  supportsThinkingDisplay: true,
  reasoningFormat: "openai",
  chatTemplateParameters: {
    enable_thinking: { $var: "thinking.enabled", omitWhenOff: true },
  },
  deferredToolsMode: "kimi",
  cacheControlFormat: "anthropic",
  cacheControlTtl: "1h",
  sessionAffinityFormat: "openai-nosession",
  openRouterRouting: {
    allow_fallbacks: false,
    data_collection: "deny",
    sort: { by: "price", partition: null },
  },
  vercelGatewayRouting: { only: ["provider/model"] },
};
void reasoningCompatibility;

const openRouterRouting: ModelOpenRouterRouting = {
  require_parameters: true,
  max_price: { prompt: "0.50", completion: 1 },
  preferred_min_throughput: { p50: 20, p99: 5 },
};
void openRouterRouting;

const protocolEvidence: ModelEvidence<ModelProtocolFamily> = {
  value: "openai-responses",
  source: "observed",
  observedAt: "2026-08-12T00:00:00.000Z",
};
void protocolEvidence;

// @ts-expect-error Model evidence requires the observation timestamp.
const evidenceWithoutTimestamp: ModelEvidence<ModelProtocolFamily> = {
  value: "openai-responses",
  source: "observed",
};
void evidenceWithoutTimestamp;

const invalidCompatibility: ModelRequestCompatibility = {
  // @ts-expect-error The output-token field must be one of the documented wire names.
  maxTokensField: "max_output_tokens",
};
void invalidCompatibility;

const invalidRouting: ModelOpenRouterRouting = {
  // @ts-expect-error OpenRouter data collection is an allow-or-deny wire value.
  data_collection: "retain",
};
void invalidRouting;

const blockedToolCall: BeforeToolCallResult = { block: true, terminate: true };
void blockedToolCall;

const completedCommand: BashExecutionMessage = {
  role: "bashExecution",
  timestamp: 1,
  command: "pwd",
  output: "/workspace",
  cancelled: false,
  truncated: false,
  exitCode: 0,
};

const timedOutCommand: BashExecutionMessage = {
  role: "bashExecution",
  timestamp: 1,
  command: "slow command",
  output: "partial",
  isError: true,
  cancelled: false,
  timedOut: true,
  signal: "SIGTERM",
  truncated: false,
  exitCode: undefined,
};
void timedOutCommand;

const extensionNotice: CustomMessage<{ source: string }> = {
  role: "custom",
  timestamp: 2,
  customType: "notice",
  content: "ready",
  display: true,
  details: { source: "extension" },
};

const publicMessages: AgentMessage[] = [completedCommand, extensionNotice];
void publicMessages;

const textBlock: ContentBlock = { type: "text", text: "ready" };
const canonicalMessage: CanonicalMessage = {
  id: "message-1",
  role: "assistant",
  content: [textBlock],
  createdAt: "2026-08-12T00:00:00.000Z",
};
void canonicalMessage;

// @ts-expect-error Canonical content blocks require a discriminant.
const contentWithoutDiscriminant: ContentBlock = { text: "ready" };
void contentWithoutDiscriminant;

// @ts-expect-error Canonical messages require durable creation metadata.
const messageWithoutCreatedAt: CanonicalMessage = {
  id: "message-2",
  role: "user",
  content: [textBlock],
};
void messageWithoutCreatedAt;

function projectAdapterEvent(event: AdapterEvent): string | undefined {
  if (event.type === "text_delta") {
    const text: string = event.text;
    // @ts-expect-error Discriminant narrowing excludes response-start fields.
    const model: string = event.model;
    void model;
    return text;
  }
  if (event.type === "response_end") {
    const stateKind: string = event.state.kind;
    return stateKind;
  }
  return undefined;
}
void projectAdapterEvent;

// @ts-expect-error Text deltas require the streamed text field.
const textDeltaWithoutText: AdapterEvent = { type: "text_delta", part: 0 };
void textDeltaWithoutText;

// @ts-expect-error Terminal response events require replayable provider state.
const responseEndWithoutState: AdapterEvent = { type: "response_end", reason: "stop" };
void responseEndWithoutState;

const responseDiagnostics: ProviderResponseDiagnostics = {
  status: 429,
  headers: { "retry-after": "1" },
};
void responseDiagnostics;

const publicFailure: ProviderResponseFailureMetadata = {
  category: "rate_limit",
  message: "try later",
  httpStatus: 429,
  retryable: true,
  partial: false,
};
void publicFailure;

const failureWithRaw: ProviderResponseFailureMetadata = {
  category: "provider",
  message: "provider failed",
  retryable: false,
  partial: false,
  // @ts-expect-error Raw provider payloads cannot cross the public failure-metadata boundary.
  raw: { secret: "provider body" },
};
void failureWithRaw;

const failureWithTransportDiagnostics: ProviderResponseFailureMetadata = {
  category: "provider",
  message: "provider failed",
  retryable: false,
  partial: false,
  // @ts-expect-error Transport diagnostics are projected separately from public failure metadata.
  diagnostics: responseDiagnostics,
};
void failureWithTransportDiagnostics;

const modelCapability: ModelCapability = {
  value: "supported",
  source: "configuration",
  observedAt: "2026-08-12T00:00:00.000Z",
};

const requestSettings: ProviderModelRequestSettings = {
  displayName: "Typed model",
  headers: { "x-feature": "enabled" },
  reasoningEffortMap: { low: "low", off: null },
  compatibility: reasoningCompatibility,
};

const providerRequest: ProviderRequest = {
  provider: "typed-provider",
  model: "typed-model",
  api: "openai-responses",
  messages: [canonicalMessage],
  tools: [],
  toolChoice: { type: "function", function: { name: "lookup" } },
  cacheRetention: "long",
  thinkingBudgets: { minimal: 128, high: 2_048 },
  modelSettings: requestSettings,
};
void providerRequest;

const invalidRequestSettings: ProviderModelRequestSettings = {
  headers: {
    // @ts-expect-error Request-setting header values are strings.
    "x-feature": true,
  },
};
void invalidRequestSettings;

// @ts-expect-error Provider requests require both canonical messages and tool definitions.
const requestWithoutMessages: ProviderRequest = {
  provider: "typed-provider",
  model: "typed-model",
  tools: [],
};
void requestWithoutMessages;

const providerAdapter: ProviderAdapter = {
  id: "typed-provider",
  async *stream(request, signal): AsyncIterable<AdapterEvent> {
    signal.throwIfAborted();
    yield { type: "response_start", model: request.model };
  },
  async listModels(signal) {
    signal.throwIfAborted();
    return [{
      id: "typed-model",
      provider: "typed-provider",
      capabilities: {
        tools: modelCapability,
        reasoning: modelCapability,
        images: modelCapability,
      },
    }];
  },
};
void providerAdapter;

// @ts-expect-error Public provider adapters must expose model discovery.
const adapterWithoutModels: ProviderAdapter = {
  id: "typed-provider",
  async *stream(): AsyncIterable<AdapterEvent> {
    yield { type: "text_delta", part: 0, text: "ready" };
  },
};
void adapterWithoutModels;

// @ts-expect-error `display` is part of the required public custom-message contract.
const missingDisplay: CustomMessage = {
  role: "custom",
  timestamp: 3,
  customType: "notice",
  content: "hidden",
};
void missingDisplay;

// @ts-expect-error `exitCode` remains present even when its value is undefined.
const missingExitCode: BashExecutionMessage = {
  role: "bashExecution",
  timestamp: 4,
  command: "sleep 1",
  output: "",
  cancelled: true,
  truncated: false,
};
void missingExitCode;
