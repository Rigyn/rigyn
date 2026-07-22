export { SecretRedactor } from "./auth/redaction.js";
export { HarnessError } from "./core/errors.js";
export { analyzeCacheEffectiveness } from "./core/cache-diagnostics.js";
export {
  MAX_NORMALIZED_USAGE_RAW_BYTES,
  isNormalizedUsage,
  normalizedContextTokens,
  normalizedTotalTokens,
} from "./core/usage.js";
export {
  applyUsagePricing,
  calculateUsageCost,
  mergeUsagePricingContext,
  withUsagePricing,
} from "./providers/pricing.js";
export type { UsagePricingContext } from "./providers/pricing.js";
export {
  DEFAULT_PREPROCESS_MAX_HEIGHT,
  DEFAULT_PREPROCESS_MAX_WIDTH,
  DEFAULT_PREPROCESS_OUTPUT_BYTES,
  MAX_PREPROCESS_INPUT_BYTES,
  OPENROUTER_IMAGE_MODELS,
  ImagesModelsError,
  builtinImagesModels,
  builtinImagesProviders,
  clearImagesApiProviders,
  createImagesModels,
  createImagesProvider,
  createOpenRouterImagesApi,
  createOpenRouterImagesGenerator,
  ensureBuiltInImagesApiProviders,
  generateImages,
  generateOpenRouterImages,
  getImageModel,
  getImageModels,
  getImageProviders,
  getImagesApiProvider,
  imageCoordinateHint,
  minimalClipboardEnvironment,
  openrouterImagesProvider,
  preprocessImage,
  readClipboardImage,
  registerBuiltInImagesApiProviders,
  registerImagesApiProvider,
  runClipboardCommand,
  sniffImageMediaType,
  unregisterImagesApiProvider,
} from "./images/index.js";
export { createNetworkTransport } from "./net/fetch.js";
export { FileModelCatalogStore } from "./providers/model-catalog-store.js";
export {
  MODEL_REASONING_EFFORTS,
  ModelReferenceResolutionError,
  ProviderRegistry,
  applyMaintainedModelMetadata,
  modelReasoningEfforts,
  modelReferenceFailureMessage,
  normalizeModelReasoningEffort,
  parseModelReasoningReference,
} from "./providers/registry.js";
export { AgentSession } from "./service/agent-session.js";
export {
  HARNESS_RESOURCE_CATALOG_LIMITS,
  HARNESS_RESOURCE_CATALOG_SCHEMA_VERSION,
  buildHarnessResourceCatalog,
  parseHarnessResourceCatalog,
} from "./service/resource-catalog.js";
export {
  HARNESS_TRANSCRIPT_LIMITS,
  HARNESS_TRANSCRIPT_SCHEMA_VERSION,
  parseHarnessTranscriptPage,
} from "./service/transcript.js";
export { createHarnessRuntime } from "./public-runtime.js";
export { SessionManager } from "./storage/session-manager.js";
export { WorkspaceBoundary } from "./tools/paths.js";
export { ExternalToolBackend } from "./tools/backend.js";
export { RIGYN_VERSION } from "./version.js";
export { extensionGalleryInstallSource, parseExtensionGalleryIndex } from "./extensions/gallery.js";
export {
  PROJECT_PACKAGE_DECLARATION,
  PROJECT_PACKAGE_INSTALL_ROOT,
  PROJECT_PACKAGE_LOCK,
  ProjectPackageManager,
  parseProjectPackageDeclaration,
  parseProjectPackageLock,
  projectPackageDeclarationSha256,
} from "./extensions/project-packages.js";
export type {
  InstalledProjectPackage,
  ProjectPackageCatalogEntry,
  ProjectPackageCheckResult,
  ProjectPackageCheckStatus,
  ProjectPackageCommand,
  ProjectPackageCommands,
  ProjectPackageDeclaration,
  ProjectPackageDeclarationEntry,
  ProjectPackageDeclarationSource,
  ProjectPackageLock,
  ProjectPackageLockEntry,
  ProjectPackageManagerOptions,
  ProjectPackageProvenance,
  ProjectPackageReconcileResult,
  ProjectPackageResolvedSource,
  ProjectPackageUpdateOptions,
} from "./extensions/project-packages.js";

// The package root retains the complete generic coding-agent contract. The
// focused subpaths below remain available for consumers that prefer narrower
// dependency boundaries.
export { CONFIG_DIR_NAME, getAgentDir } from "./config/paths.js";
export {
  DefaultPackageManager,
  type PackageManager,
  type PathMetadata,
  type ProgressCallback,
  type ProgressEvent,
  type ResolvedPaths,
  type ResolvedResource,
} from "./core/package-manager.js";
export {
  DefaultResourceLoader,
  loadProjectContextFiles,
  type ResourceExtensionsResult,
  type ResourceLoader,
} from "./core/resource-loader.js";
export {
  SettingsManager,
  type DefaultProjectTrust,
  type ImageSettings,
  type PackageSource,
  type RetrySettings,
  type SettingsManagerCreateOptions,
} from "./core/settings-manager.js";
export {
  formatSkillsForPrompt,
  loadSkills,
  loadSkillsFromDir,
  type LoadSkillsFromDirOptions,
  type LoadSkillsResult,
  type Skill,
  type SkillFrontmatter,
} from "./core/skills.js";
export type { PromptTemplate } from "./core/prompt-templates.js";
export type { BuildSystemPromptOptions } from "./core/system-prompt.js";
export { createEventBus, type EventBus, type EventBusController } from "./core/event-bus.js";
export type { ResourceCollision, ResourceDiagnostic } from "./core/diagnostics.js";
export type { SlashCommandInfo, SlashCommandSource } from "./core/slash-commands.js";
export { createSyntheticSourceInfo, type SourceInfo } from "./core/source-info.js";
export {
  createAgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
} from "./sdk/index.js";
export { ModelRegistry } from "./providers/public-model-registry.js";
export type {
  ProviderConfigInput,
  ResolvedRequestAuth,
} from "./providers/public-model-registry.js";
export {
  createBashTool,
  createBashToolDefinition,
  createLocalBashOperations,
  type BashOperations,
  type BashSpawnContext,
  type BashSpawnHook,
  type BashToolDetails,
  type BashToolInput,
  type BashToolOptions,
} from "./tools/builtins/shell.js";
export {
  createEditTool,
  createEditToolDefinition,
  type EditOperations,
  type EditToolDetails,
  type EditToolInput,
  type EditToolOptions,
} from "./tools/builtins/edit.js";
export {
  createFindTool,
  createFindToolDefinition,
  type FindOperations,
  type FindToolDetails,
  type FindToolInput,
  type FindToolOptions,
} from "./tools/builtins/find.js";
export {
  createGrepTool,
  createGrepToolDefinition,
  type GrepOperations,
  type GrepToolDetails,
  type GrepToolInput,
  type GrepToolOptions,
} from "./tools/builtins/grep.js";
export {
  createLsTool,
  createLsToolDefinition,
  type LsOperations,
  type LsToolDetails,
  type LsToolInput,
  type LsToolOptions,
} from "./tools/builtins/ls.js";
export {
  createReadTool,
  createReadToolDefinition,
  type ReadOperations,
  type ReadToolDetails,
  type ReadToolInput,
  type ReadToolOptions,
} from "./tools/builtins/read.js";
export {
  createWriteTool,
  createWriteToolDefinition,
  type WriteOperations,
  type WriteToolInput,
  type WriteToolOptions,
} from "./tools/builtins/write.js";
export {
  createCodingTools,
  createReadOnlyTools,
  type ToolsOptions,
} from "./tools/catalog.js";
export { generateDiffString, generateUnifiedPatch } from "./tools/edit-diff.js";
export {
  buildContextEntries,
  buildSessionContext,
  getLatestCompactionEntry,
  migrateSessionEntries,
  parseSessionEntries,
  sessionEntryToContextMessages,
} from "./storage/session-manager.js";
export { CURRENT_SESSION_VERSION } from "./storage/types.js";
export {
  RpcClient,
  type RpcClientOptions,
  type RpcEventListener,
} from "./interfaces/rpc-client.js";
export { KeybindingsManager } from "./tui/index.js";
export type { ReadonlyFooterDataProvider } from "./tui/footer-data.js";
export { Theme } from "./tui/theme.js";

// Generic coding-agent compatibility surface. These are thin facades over the
// same modules used by Rigyn's CLI and SDK; no second runtime is constructed.
export { VERSION, getDocsPath, getExamplesPath, getPackageDir, getReadmePath } from "./config/paths.js";
export {
  ProjectTrustStore,
  hasTrustRequiringProjectResources,
  type ProjectTrustDecision,
  type ProjectTrustStoreEntry,
  type ProjectTrustUpdate,
} from "./config/project-trust.js";
export { readStoredCredential } from "./auth/auth-storage.js";
export { parseFrontmatter, stripFrontmatter } from "./core/frontmatter.js";
export {
  DEFAULT_COMPACTION_SETTINGS,
  calculateContextTokens,
  collectEntriesForBranchSummary,
  compact,
  convertToLlm,
  estimateContextTokens,
  estimateTokens,
  findCutPoint,
  findTurnStartIndex,
  generateBranchSummary,
  generateSummary,
  generateSummaryWithUsage,
  getLastAssistantUsage,
  prepareBranchEntries,
  prepareCompaction,
  serializeConversation,
  shouldCompact,
  SUMMARIZATION_SYSTEM_PROMPT,
  type BranchPreparation,
  type BranchSummaryDetails,
  type BranchSummaryResult,
  type CollectEntriesResult,
  type CompactionDetails,
  type CompactionPreparation,
  type CompactionResult,
  type CompactionSettings,
  type ContextUsageEstimate,
  type CutPointResult,
  type FileOperations,
  type GenerateBranchSummaryOptions,
  type ReadonlyCompactionSessionManager,
} from "./context/public-compaction.js";
export {
  convertToPng,
  copyToClipboard,
  formatDimensionNote,
  resizeImage,
  type ResizedImage,
} from "./images/helpers.js";
export { getShellConfig } from "./process/shell-config.js";
export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  truncateLine,
  truncateTail,
  type TruncationOptions,
  type TruncationResult,
} from "./tools/truncate.js";
export { withFileMutationQueue } from "./tools/file-mutation-queue.js";
export { type EditDiffResult } from "./tools/edit-diff.js";
export { wrapRegisteredTool, wrapRegisteredTools } from "./tools/direct-tool.js";
export {
  createExtensionRuntime,
  discoverAndLoadExtensions,
  ExtensionRunner,
} from "./extensions/compat.js";
export {
  AgentSessionRuntime,
  createAgentSessionRuntime,
  type AgentSessionRuntimeDiagnostic,
  type CreateAgentSessionRuntimeFactory,
  type CreateAgentSessionRuntimeResult,
} from "./service/agent-session-runtime.js";
export {
  createAgentSessionFromServices,
  createAgentSessionServices,
  type AgentSessionServices,
  type CreateAgentSessionFromServicesOptions,
  type CreateAgentSessionServicesOptions,
} from "./service/agent-session-services.js";
export {
  parseSkillBlock,
  type AgentSessionConfig,
  type ModelCycleResult,
  type ParsedSkillBlock,
  type PromptOptions,
  type SessionStats,
} from "./service/agent-session.js";
export {
  ModelRuntime,
  resolveCliModel,
  resolveModelScopeWithDiagnostics,
  type CreateModelRuntimeOptions,
  type ModelRuntimeAuthOverrides,
  type ModelScopeDiagnostic,
  type ResolveCliModelResult,
  type ResolveModelScopeResult,
  type ScopedModel,
} from "./providers/model-compat.js";
export {
  AssistantMessageComponent,
  BashExecutionComponent,
  BorderedLoader,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomEditor,
  CustomMessageComponent,
  DynamicBorder,
  ExtensionEditorComponent,
  ExtensionInputComponent,
  ExtensionSelectorComponent,
  FooterComponent,
  LoginDialogComponent,
  ModelSelectorComponent,
  OAuthSelectorComponent,
  renderDiff,
  SessionSelectorComponent,
  SettingsSelectorComponent,
  ShowImagesSelectorComponent,
  SkillInvocationMessageComponent,
  ThemeSelectorComponent,
  ThinkingSelectorComponent,
  ToolExecutionComponent,
  TreeSelectorComponent,
  truncateToVisualLines,
  UserMessageComponent,
  UserMessageSelectorComponent,
  type AppKeybinding,
  type RenderDiffOptions,
  type SettingsCallbacks,
  type SettingsConfig,
  type ToolExecutionOptions,
  type VisualTruncateResult,
} from "./tui/public-components.js";
export {
  getLanguageFromPath,
  getMarkdownTheme,
  getSelectListTheme,
  getSettingsListTheme,
  highlightCode,
  initTheme,
  keyHint,
  keyText,
  rawKeyHint,
  type ThemeColor,
} from "./tui/public-theme.js";
export { InteractiveMode, type InteractiveModeOptions } from "./modes/interactive-mode.js";
export { runPrintMode, type PrintModeOptions } from "./modes/print-mode.js";
export { runRpcMode } from "./modes/rpc-mode.js";
export { main, type MainOptions } from "./cli/main.js";
export { parseArgs, type Args } from "./cli/args.js";
export type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "./interfaces/rpc-extension-ui.js";

export type { AgentRunResult, QueuedRunMessage, QueueMode } from "./core/agent.js";
export type {
  CreateHarnessRuntimeOptions,
  HarnessRunHandle,
  HarnessRuntime,
} from "./public-runtime.js";
export type {
  HarnessResourceBuiltinCommand,
  HarnessResourceCatalog,
  HarnessResourceCatalogSources,
  HarnessResourceDiagnostic,
  HarnessResourceExtension,
  HarnessResourceModel,
  HarnessResourceOwner,
  HarnessResourcePackage,
  HarnessResourcePackageProvenance,
  HarnessResourcePrompt,
  HarnessResourceProvider,
  HarnessResourceRuntimeCommand,
  HarnessResourceSkill,
  HarnessResourceTemplateCommand,
  HarnessResourceTheme,
  HarnessResourceTool,
} from "./service/resource-catalog.js";
export type {
  HarnessTranscriptEntry,
  HarnessTranscriptEntryBase,
  HarnessTranscriptExtensionEntry,
  HarnessTranscriptImage,
  HarnessTranscriptMessageEntry,
  HarnessTranscriptPage,
  HarnessTranscriptReasoningEntry,
  HarnessTranscriptRequest,
  HarnessTranscriptStatusEntry,
  HarnessTranscriptSummaryEntry,
  HarnessTranscriptToolEntry,
} from "./service/transcript.js";
export type { CacheEffectiveness, CacheEffectivenessStatus } from "./core/cache-diagnostics.js";
export type {
  ExtensionGalleryContributionCounts,
  ExtensionGalleryIndex,
  ExtensionGalleryMedia,
  ExtensionGalleryPackage,
  ExtensionGallerySource,
} from "./extensions/gallery.js";
export type {
  AssistantImages,
  ClipboardBackend,
  ClipboardCommandResult,
  ClipboardCommandRunner,
  ClipboardCommandSpec,
  ClipboardDiagnostic,
  ClipboardImage,
  ClipboardImageOptions,
  ClipboardImageResult,
  CreateImagesModelsOptions,
  CreateImagesProviderOptions,
  ImagesApi,
  ImagesApiProvider,
  ImagesAuthOverrides,
  ImagesAuthResult,
  ImagesContext,
  ImagesCredentialResolver,
  ImagesEnvironment,
  ImagesFunction,
  ImagesHeaders,
  ImagesImageContent,
  ImagesInputContent,
  ImagesModel,
  ImagesModelPricing,
  ImagesModels,
  ImagesModelsErrorCode,
  ImagesOptions,
  ImagesOutputContent,
  ImagesProvider,
  ImagesProviderAuth,
  ImagesProviderId,
  ImagesProviderResponse,
  ImagesStopReason,
  ImagesTextContent,
  ImagesUsage,
  ImageCoordinateMetadata,
  ImagePreprocessExecutionOptions,
  ImagePreprocessOptions,
  PreprocessedImage,
  ProviderImages,
  ProviderImagesOptions,
  MutableImagesModels,
  OpenRouterImagesDependencies,
  SniffedImageMediaType,
} from "./images/index.js";
export type {
  EventEnvelope,
  EventSink,
  RunState,
  RuntimeEvent,
  ToolProgress,
  ToolResultProgress,
  ToolUpdate,
} from "./core/events.js";
export type {
  ArtifactId,
  EventId,
  MessageId,
  RunId,
  ThreadId,
  ToolCallId,
} from "./core/ids.js";
export type { JsonPrimitive, JsonValue } from "./core/json.js";
export type {
  AdapterError,
  AdapterEvent,
  CanonicalMessage,
  CapabilityValue,
  ContentBlock,
  FinishReason,
  ImageBlock,
  ModelCapability,
  ModelCacheAffinity,
  ModelCacheMode,
  ModelCacheTier,
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
  PromptCompositionMetadata,
  PromptCompositionSource,
  PromptCompositionSourceKind,
  OpaqueBlock,
  OutboundImagePolicy,
  ProviderAdapter,
  ProviderId,
  ProviderModelRequestSettings,
  ProviderRequest,
  ProviderResponseDiagnostics,
  ProviderResponseFailureMetadata,
  ProviderState,
  RoutedProviderStateProvenance,
  TextBlock,
  ToolCallBlock,
  ToolDefinition,
  ToolResultBlock,
  ThinkingBudgets,
} from "./core/types.js";
export type { ModelCatalogStore } from "./providers/model-catalog-store.js";
export type {
  ConfiguredModel,
  ConfiguredModelPricing,
  ModelCatalogError,
  ModelCatalogProvenance,
  ModelCatalogRefreshResult,
  ModelCatalogStatus,
  ModelListOptions,
  ModelReferenceMatch,
  ModelReferenceOptions,
  ModelReferenceResolution,
  ModelReasoningEffort,
  ProviderAdapterOverlay,
  ProviderRegistryOptions,
  ResolvedModelSelection,
} from "./providers/registry.js";
export { discoverSkills, discoverSkillsDetailed, loadSkill } from "./context/skills.js";
export { sharedUserSkillRoots, sharedWorkspaceSkillRoots } from "./context/skill-roots.js";
export type {
  LoadedSkill,
  SkillDiagnostic,
  SkillDiagnosticCode,
  SkillDiagnosticSeverity,
  SkillDiscoveryOptions,
  SkillDiscoveryResult,
  SkillMetadata,
  SkillRoot,
} from "./context/skills.js";
export type {
  NetworkProxyOptions,
  NetworkTransport,
  NetworkTransportInfo,
  NetworkTransportOptions,
} from "./net/fetch.js";
export type {
  RpcExtensionUiRequest,
  RpcExtensionUiResponse,
  RpcCommand,
  RpcCommandType,
  RpcInputRecord,
  RpcResponse,
  RpcSessionState,
  RpcSlashCommand,
} from "./interfaces/index.js";
export * from "./extensions/direct.js";
export type {
  CommandResult,
  CommandSpec,
  ProcessRunner,
} from "./process/types.js";
export type {
  AgentSessionEvent,
  AgentSessionEventListener,
  AgentSessionModel,
  AgentSessionOptions,
  AgentSessionPromptOptions,
  AgentSessionRun,
} from "./service/agent-session.js";
export type {
  NewSessionOptions,
  SessionCustomData,
  SessionHeader,
  SessionInfo,
  SessionListProgress,
} from "./storage/types.js";
export type {
  ArtifactWriter,
  HarnessTool,
  ResourceClaim,
  ResourceMode,
  ToolArtifact,
  ToolContext,
  ToolExecutionMode,
  ToolInputPreparer,
  ToolInvocation,
  ToolInvocationProgress,
  ToolInvocationResult,
  ToolResult,
} from "./tools/types.js";
export type {
  ExternalToolBackendOptions,
  ToolBackendRequest,
  ToolExecutionBackend,
} from "./tools/backend.js";
