import {
  AgentSession,
  ExternalToolBackend,
  ModelReferenceResolutionError,
  ProviderRegistry,
  SessionManager,
  WorkspaceBoundary,
  analyzeCacheEffectiveness,
  createHarnessRuntime,
  imageCoordinateHint,
  isNormalizedUsage,
  normalizedContextTokens,
  normalizedTotalTokens,
  parseExtensionGalleryIndex,
  parseModelReasoningReference,
  sniffImageMediaType,
  type AdapterEvent,
  type HarnessRuntime,
  type HarnessTool,
  type ImageCoordinateMetadata,
  type JsonValue,
  type ModelInfo,
  type ProviderAdapter,
  type ProviderRequest,
  type ResourceClaim,
  type RpcCommand,
  type RpcResponse,
  type RuntimeEvent,
  type ToolResult,
} from "rigyn";

const capability = {
  value: "supported",
  source: "configuration",
  observedAt: "2026-07-20T00:00:00.000Z",
} as const;

export const provider: ProviderAdapter = {
  id: "consumer-offline",
  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    signal.throwIfAborted();
    yield { type: "response_start", model: request.model };
    yield { type: "text_delta", part: 0, text: "ready" };
    yield {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "ready" } },
    };
  },
  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    signal.throwIfAborted();
    return [{
      id: "consumer-model",
      provider: this.id,
      capabilities: { tools: capability, reasoning: capability, images: capability },
    }];
  },
};

export const tool: HarnessTool = {
  definition: {
    name: "consumer_tool",
    description: "Public consumer contract",
    inputSchema: { type: "object", additionalProperties: false },
  },
  validate(_input: JsonValue) {},
  resources(): ResourceClaim[] { return []; },
  async execute(): Promise<ToolResult> { return { content: "ready", isError: false }; },
};

const coordinates: ImageCoordinateMetadata = {
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

const usage = { inputTokens: 10, cacheReadTokens: 90, totalTokens: 100 };
void [
  analyzeCacheEffectiveness([usage]),
  isNormalizedUsage(usage),
  normalizedContextTokens(usage),
  normalizedTotalTokens(usage),
  parseModelReasoningReference("consumer-offline/consumer-model"),
  parseExtensionGalleryIndex({ schemaVersion: 1, packages: [] }),
  sniffImageMediaType(Buffer.from([0x42, 0x4d])),
  imageCoordinateHint(coordinates),
  ModelReferenceResolutionError,
  ExternalToolBackend,
  WorkspaceBoundary,
];

const runtimeFactory: (options?: Parameters<typeof createHarnessRuntime>[0]) => Promise<HarnessRuntime> = createHarnessRuntime;
void runtimeFactory;

declare const session: AgentSession;
const manager: ReturnType<typeof SessionManager.inMemory> = SessionManager.inMemory(process.cwd());
const registry = new ProviderRegistry([provider]);
const command: RpcCommand = { id: "consumer", type: "get_state" };
declare const response: RpcResponse;
declare const event: RuntimeEvent;
void [session.sessionId, manager.getSessionId(), registry, command.type, response.type, event.type];
