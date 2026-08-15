import {
  createAssistantMessageEventStream,
  type AgentMessage,
  type Api,
  type ApiKeyAuth,
  type ApiKeyCredential,
  type ApiStreamOptions,
  type AssistantContent,
  type AssistantMessage,
  type AssistantMessageDiagnostic,
  type AssistantMessageDiagnosticError,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type AuthCheck,
  type AuthContext,
  type AuthInteraction,
  type AuthMethod,
  type AuthNotification,
  type AuthPrompt,
  type AuthResult,
  type AuthType,
  type CacheRetention,
  type ConstrainedSampling,
  type ConstrainedSamplingConfig,
  type Context,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type CustomMessage,
  type GeneratedImage,
  type GrammarConstraint,
  type GrammarFormat,
  type GrammarSamplingConfig,
  type GrammarSyntax,
  type ImageContent,
  type ImageModel,
  type ImageProvider,
  type ImageRequest,
  type ImageResult,
  type JsonSchemaConstraint,
  type KnownApi,
  type Message,
  type Model,
  type ModelCompatibility,
  type ModelCost,
  type ModelCostTier,
  type ModelId,
  type ModelReasoningEffort,
  type Models,
  type ModelsApiStreamOptions,
  type ModelsRefreshOptions,
  type ModelsRefreshResult,
  type ModelsSimpleStreamOptions,
  type ModelsStreamTransforms,
  type MutableModels,
  type OAuthAuth,
  type OAuthCredential,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type Provider,
  type ProviderAccountAuth,
  type ProviderApiKeyCredential,
  type ProviderAuth,
  type ProviderAuthCheck,
  type ProviderCatalogCacheEntry,
  type ProviderCatalogStore,
  type ProviderHeaders,
  type ProviderId,
  type ProviderState,
  type ProviderStateSource,
  type PushableAssistantMessageEventStream,
  type RefreshModelsContext,
  type RequestDiagnostic,
  type ResolvedAuth,
  type ResponseDiagnostic,
  type RetryCallbacks,
  type RetryPolicy,
  type SimpleStreamOptions,
  type StopReason,
  type StreamFn,
  type StreamOptions,
  type TextContent,
  type ThinkingBudgets,
  type ThinkingContent,
  type ThinkingLevel,
  type Tool,
  type ToolCall,
  type ToolChoice,
  type ToolResultMessage,
  type Transport,
  type Usage,
  type UsageCost,
  type UserMessage,
} from "../src/index.js";

/** Compile-time inventory of every type assembled by contracts.ts. */
export interface PublicContractTypeInventory {
  content: {
    AgentMessage: AgentMessage;
    AssistantContent: AssistantContent;
    AssistantMessage: AssistantMessage;
    AssistantMessageDiagnostic: AssistantMessageDiagnostic;
    AssistantMessageDiagnosticError: AssistantMessageDiagnosticError;
    Context: Context;
    CustomMessage: CustomMessage;
    ImageContent: ImageContent;
    Message: Message;
    ProviderState: ProviderState;
    ProviderStateSource: ProviderStateSource;
    StopReason: StopReason;
    TextContent: TextContent;
    ThinkingContent: ThinkingContent;
    ToolCall: ToolCall;
    ToolResultMessage: ToolResultMessage;
    UserMessage: UserMessage;
  };
  models: {
    Api: Api;
    ApiStreamOptions: ApiStreamOptions;
    AssistantMessageEvent: AssistantMessageEvent;
    AssistantMessageEventStream: AssistantMessageEventStream;
    CacheRetention: CacheRetention;
    ConstrainedSampling: ConstrainedSampling;
    ConstrainedSamplingConfig: ConstrainedSamplingConfig;
    GrammarConstraint: GrammarConstraint;
    GrammarFormat: GrammarFormat;
    GrammarSamplingConfig: GrammarSamplingConfig;
    GrammarSyntax: GrammarSyntax;
    JsonSchemaConstraint: JsonSchemaConstraint;
    KnownApi: KnownApi;
    Model: Model;
    ModelCompatibility: ModelCompatibility;
    ModelCost: ModelCost;
    ModelCostTier: ModelCostTier;
    ModelId: ModelId;
    ModelReasoningEffort: ModelReasoningEffort;
    ModelsApiStreamOptions: ModelsApiStreamOptions;
    ModelsSimpleStreamOptions: ModelsSimpleStreamOptions;
    ProviderHeaders: ProviderHeaders;
    ProviderId: ProviderId;
    PushableAssistantMessageEventStream: PushableAssistantMessageEventStream;
    RequestDiagnostic: RequestDiagnostic;
    ResponseDiagnostic: ResponseDiagnostic;
    SimpleStreamOptions: SimpleStreamOptions;
    StreamFn: StreamFn;
    StreamOptions: StreamOptions;
    ThinkingBudgets: ThinkingBudgets;
    ThinkingLevel: ThinkingLevel;
    Tool: Tool;
    ToolChoice: ToolChoice;
    Transport: Transport;
    Usage: Usage;
    UsageCost: UsageCost;
  };
  providers: {
    ApiKeyAuth: ApiKeyAuth;
    ApiKeyCredential: ApiKeyCredential;
    AuthCheck: AuthCheck;
    AuthContext: AuthContext;
    AuthInteraction: AuthInteraction;
    AuthMethod: AuthMethod;
    AuthNotification: AuthNotification;
    AuthPrompt: AuthPrompt;
    AuthResult: AuthResult;
    AuthType: AuthType;
    Credential: Credential;
    CredentialInfo: CredentialInfo;
    CredentialStore: CredentialStore;
    Models: Models;
    ModelsRefreshOptions: ModelsRefreshOptions;
    ModelsRefreshResult: ModelsRefreshResult;
    ModelsStreamTransforms: ModelsStreamTransforms;
    MutableModels: MutableModels;
    OAuthAuth: OAuthAuth;
    OAuthCredential: OAuthCredential;
    OAuthCredentials: OAuthCredentials;
    OAuthLoginCallbacks: OAuthLoginCallbacks;
    Provider: Provider;
    ProviderAccountAuth: ProviderAccountAuth;
    ProviderApiKeyCredential: ProviderApiKeyCredential;
    ProviderAuth: ProviderAuth;
    ProviderAuthCheck: ProviderAuthCheck;
    ProviderCatalogCacheEntry: ProviderCatalogCacheEntry;
    ProviderCatalogStore: ProviderCatalogStore;
    RefreshModelsContext: RefreshModelsContext;
    ResolvedAuth: ResolvedAuth;
  };
  imagesAndRetry: {
    GeneratedImage: GeneratedImage;
    ImageModel: ImageModel;
    ImageProvider: ImageProvider;
    ImageRequest: ImageRequest;
    ImageResult: ImageResult;
    RetryCallbacks: RetryCallbacks;
    RetryPolicy: RetryPolicy;
  };
}

const responseModel: Model<"openai-responses"> = {
  id: "response-model",
  name: "Response model",
  api: "openai-responses",
  provider: "typed",
  baseUrl: "https://example.test/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 },
  contextWindow: 128_000,
  maxTokens: 16_000,
};

const anthropicModel: Model<"anthropic-messages"> = {
  ...responseModel,
  id: "anthropic-model",
  api: "anthropic-messages",
};

// @ts-expect-error Model requires an explicit provider identity.
const modelWithoutProvider: Model<"openai-responses"> = { ...responseModel, provider: undefined };
void modelWithoutProvider;

const textContent: TextContent = { type: "text", text: "hello" };
const userMessage: UserMessage = { role: "user", content: [textContent], timestamp: 1 };
const toolCall: ToolCall = { type: "toolCall", id: "call", name: "lookup", arguments: {} };
void userMessage;
void toolCall;

// @ts-expect-error Content blocks require their discriminant.
const textWithoutDiscriminant: TextContent = { text: "hello" };
// @ts-expect-error Text content cannot use the image discriminant.
const textWithWrongDiscriminant: TextContent = { type: "image", text: "hello" };
// @ts-expect-error Public messages require a timestamp.
const userWithoutTimestamp: UserMessage = { role: "user", content: "hello" };
// @ts-expect-error Tool calls require parsed object arguments.
const toolCallWithoutArguments: ToolCall = { type: "toolCall", id: "call", name: "lookup" };
void textWithoutDiscriminant;
void textWithWrongDiscriminant;
void userWithoutTimestamp;
void toolCallWithoutArguments;

const assistant: AssistantMessage = {
  role: "assistant",
  content: [],
  api: responseModel.api,
  provider: responseModel.provider,
  model: responseModel.id,
  usage: {
    input: 1,
    output: 1,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1,
};

const startEvent: AssistantMessageEvent = { type: "start", partial: { ...assistant, stopReason: "pending" } };
const doneEvent: AssistantMessageEvent = { type: "done", reason: "stop", message: assistant };
// @ts-expect-error A done event cannot retain the pending stop reason.
const pendingDoneEvent: AssistantMessageEvent = { type: "done", reason: "pending", message: assistant };
// @ts-expect-error An error event requires the canonical assistant error value.
const errorWithoutMessage: AssistantMessageEvent = { type: "error", reason: "error" };
void doneEvent;
void pendingDoneEvent;
void errorWithoutMessage;

const writableStream: PushableAssistantMessageEventStream = createAssistantMessageEventStream();
writableStream.push(startEvent);
const readableStream: AssistantMessageEventStream = writableStream;
void readableStream.result();
// @ts-expect-error Provider consumers receive a read-only stream boundary.
readableStream.push(startEvent);
// @ts-expect-error Provider consumers cannot fail a read-only stream boundary.
readableStream.fail(new Error("closed"));

const transport: Transport = "auto";
const cacheRetention: CacheRetention = "short";
const options: SimpleStreamOptions = {
  apiKey: "test-only",
  transport,
  cacheRetention,
  toolChoice: { type: "function", function: { name: "lookup" } },
  env: { REGION: "test" },
  onPayload: async (payload, selected) => selected.id ? payload : undefined,
  onResponse: async (response, selected) => {
    void response.status;
    void selected.provider;
  },
};
void options;

const responseOptions: ApiStreamOptions<"openai-responses"> = { api: "openai-responses" };
// @ts-expect-error API-specific stream options preserve the selected API.
const anthropicOptionsForResponse: ApiStreamOptions<"openai-responses"> = { api: "anthropic-messages" };
void responseOptions;
void anthropicOptionsForResponse;

const responseStream: StreamFn<"openai-responses"> = (selected, selectedContext, selectedOptions) => {
  const selectedApi: "openai-responses" = selected.api;
  const optionApi: "openai-responses" | undefined = selectedOptions?.api;
  void selectedApi;
  void optionApi;
  void selectedContext.messages;
  return createAssistantMessageEventStream();
};
void responseStream;

const store: CredentialStore = {
  async read(): Promise<Credential | undefined> { return undefined; },
  async list() { return []; },
  async modify(_provider, update) { return update(undefined); },
  async delete() {},
};

const listedCredentials: Promise<readonly CredentialInfo[]> = store.list();
void listedCredentials;

declare const credentialInfos: readonly CredentialInfo[];
// @ts-expect-error Credential inventories are read-only snapshots.
credentialInfos.push({ providerId: "typed", type: "api_key" });

const apiKeyCredential: ApiKeyCredential = { type: "api_key", env: { TYPED_KEY: "value" } };
const legacyOAuthCredentials: OAuthCredentials = { access: "access", refresh: "refresh", expires: 1 };
const normalizedOAuthCredential: OAuthCredential = {
  type: "oauth",
  access: "access",
  refresh: "refresh",
  expires: 1,
  accountId: "provider-owned",
};
const normalizedCredential: Credential = normalizedOAuthCredential;
void apiKeyCredential;
void legacyOAuthCredentials;
void normalizedCredential;

// @ts-expect-error Stored OAuth credentials require the normalized discriminator.
const oauthWithoutStoredDiscriminant: OAuthCredential = { access: "access", refresh: "refresh", expires: 1 };
// @ts-expect-error The Credential union accepts only normalized OAuth values.
const unnormalizedStoredCredential: Credential = { access: "access", refresh: "refresh", expires: 1 };
// @ts-expect-error Credential-store updates must return normalized credentials.
void store.modify("typed", () => ({ access: "access", refresh: "refresh", expires: 1 }));
void oauthWithoutStoredDiscriminant;
void unnormalizedStoredCredential;

const apiKeyAuth: ApiKeyAuth = {
  name: "Typed key",
  async login() { return { type: "api_key", key: "typed" }; },
  async resolve({ ctx, credential }: { ctx: AuthContext; credential?: ApiKeyCredential }) {
    const value = credential?.key ?? await ctx.env("TYPED_KEY");
    return value ? { auth: { apiKey: value }, source: "typed" } : undefined;
  },
};
const providerAccountAuth: ProviderAccountAuth = {
  name: "Typed account",
  loginLabel: "Sign in to provider account",
  async login() { return { type: "api_key", key: "account-key" }; },
};
const accountAuthMethod: AuthMethod = providerAccountAuth;
void accountAuthMethod;
// @ts-expect-error API-key authentication requires a resolver.
const apiKeyAuthWithoutResolver: ApiKeyAuth = { name: "Incomplete" };
// @ts-expect-error Provider-account login must return a persisted credential shape.
const providerAccountWithoutCredential: ProviderAccountAuth = { name: "Incomplete", async login() { return "token"; } };
void apiKeyAuthWithoutResolver;
void providerAccountWithoutCredential;

declare const authCheck: AuthCheck;
if (authCheck.ok) {
  const checkedType: "api_key" | "oauth" = authCheck.type;
  void checkedType;
} else {
  void authCheck.message;
  // @ts-expect-error Failed auth checks do not claim a credential type.
  void authCheck.type;
}

const selectPrompt: AuthPrompt = {
  type: "select",
  message: "Choose an account",
  options: [{ id: "one", label: "One" }],
};
// @ts-expect-error Select prompts require their options.
const selectPromptWithoutOptions: AuthPrompt = { type: "select", message: "Choose" };
void selectPrompt;
void selectPromptWithoutOptions;

const provider: Provider<"openai-responses"> = {
  id: "typed",
  name: "Typed",
  auth: {
    apiKey: apiKeyAuth,
    providerAccount: providerAccountAuth,
  },
  getModels: () => [responseModel],
  stream() { return createAssistantMessageEventStream(); },
  streamSimple() { return createAssistantMessageEventStream(); },
};
provider.stream(responseModel, { messages: [] }, responseOptions);
// @ts-expect-error A protocol-specific provider rejects another API's model.
provider.stream(anthropicModel, { messages: [] });
// @ts-expect-error Provider identity is read-only.
provider.id = "replacement";
// @ts-expect-error Provider catalog containers are read-only.
provider.getModels().push(responseModel);
provider.getModels()[0]!.name = "mutable clone";

declare const models: Models;
const modelSnapshot = models.getModels();
// Public snapshots expose mutable model clones inside read-only containers.
modelSnapshot[0]!.name = "caller-owned clone";
// @ts-expect-error Public model snapshot containers are read-only.
modelSnapshot.push(responseModel);

const requestDiagnostic: RequestDiagnostic = {
  url: "https://example.test/v1",
  method: "POST",
  headers: { authorization: "redacted" },
  attempt: 1,
};
// @ts-expect-error Diagnostic header snapshots are read-only.
requestDiagnostic.headers.authorization = "replacement";

const imageModel: ImageModel = {
  id: "image-model",
  name: "Image model",
  provider: "images",
  baseUrl: "https://images.example.test/v1",
  sizes: ["1024x1024"],
};
const imageRequest: ImageRequest = { prompt: "A small lighthouse", background: "transparent" };
const imageProvider: ImageProvider = {
  id: "images",
  name: "Images",
  models: [imageModel],
  async generate(selected, request) {
    void request.prompt;
    return { images: [{ url: "https://example.test/image.png" }], model: selected.id, provider: selected.provider };
  },
};
void imageProvider.generate(imageModel, imageRequest);
// @ts-expect-error Image requests require a prompt.
const imageRequestWithoutPrompt: ImageRequest = { size: "1024x1024" };
// @ts-expect-error Image backgrounds use the documented closed vocabulary.
const imageRequestWithInvalidBackground: ImageRequest = { prompt: "test", background: "solid" };
// @ts-expect-error Image-provider model containers are read-only.
imageProvider.models.push(imageModel);
imageProvider.models[0]!.name = "mutable image clone";
void imageRequestWithoutPrompt;
void imageRequestWithInvalidBackground;

const retryPolicy: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 100 };
// @ts-expect-error Retry policies require an explicit enabled decision.
const retryPolicyWithoutEnabled: RetryPolicy = { maxRetries: 3, baseDelayMs: 100 };
void retryPolicy;
void retryPolicyWithoutEnabled;

const legacyCompatibility: ModelCompatibility = { supportsPromptCaching: false };
void legacyCompatibility;
