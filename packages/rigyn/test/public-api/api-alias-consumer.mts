import type * as Root from "rigyn";
import type * as Auth from "rigyn/auth";
import type * as Config from "rigyn/config";
import type * as Context from "rigyn/context";
import type * as Core from "rigyn/core";
import type * as Extensions from "rigyn/extensions";
import type * as Images from "rigyn/images";
import type * as Interfaces from "rigyn/interfaces";
import type * as Modes from "rigyn/modes";
import type * as Process from "rigyn/process";
import type * as Providers from "rigyn/providers";
import type * as Service from "rigyn/service";
import type * as Tools from "rigyn/tools";
import type * as Tui from "rigyn/tui";
import {
  KeybindingsManager as SharedKeybindingsManager,
  TUI_KEYBINDINGS,
  type KeybindingsConfig,
} from "@rigyn/terminal";

declare const sharedKeybindings: SharedKeybindingsManager;
sharedKeybindings.matches("", "app.clear");
sharedKeybindings.matches("", "tui.editor.redo");
const rawTerminalKeybindings = new SharedKeybindingsManager(TUI_KEYBINDINGS);
declare const applicationKeybindingsConstructor: typeof Root.KeybindingsManager;
const applicationKeybindings = new applicationKeybindingsConstructor();
const effectiveApplicationBindings: KeybindingsConfig = applicationKeybindings.getEffectiveConfig();
const compatibleApplicationKeybindings = new applicationKeybindingsConstructor(TUI_KEYBINDINGS);
compatibleApplicationKeybindings.matches("", "tui.input.submit");

type GenericName =
  | "AgentSessionConfig" | "AgentSessionRuntime" | "AgentSessionRuntimeDiagnostic" | "AgentSessionServices"
  | "AppKeybinding" | "Args" | "AssistantMessageComponent" | "BashExecutionComponent" | "BorderedLoader"
  | "BranchPreparation" | "BranchSummaryMessageComponent" | "BranchSummaryResult" | "CollectEntriesResult"
  | "CompactionSummaryMessageComponent" | "CreateAgentSessionFromServicesOptions" | "CreateAgentSessionRuntimeFactory"
  | "CreateAgentSessionRuntimeResult" | "CreateAgentSessionServicesOptions" | "CreateModelRuntimeOptions"
  | "CustomEditor" | "CustomMessageComponent" | "CutPointResult" | "DEFAULT_COMPACTION_SETTINGS"
  | "DEFAULT_MAX_BYTES" | "DEFAULT_MAX_LINES" | "DynamicBorder" | "EditDiffResult" | "ExtensionEditorComponent"
  | "ExtensionInputComponent" | "ExtensionRunner" | "ExtensionSelectorComponent" | "FileOperations" | "FooterComponent"
  | "GenerateBranchSummaryOptions" | "InteractiveMode" | "InteractiveModeOptions" | "LoginDialogComponent"
  | "MainOptions" | "ModelCycleResult" | "ModelInfo" | "ModelRuntime" | "ModelRuntimeAuthOverrides" | "ModelScopeDiagnostic"
  | "ModelSelectorComponent" | "OAuthSelectorComponent" | "ParsedSkillBlock" | "ProjectTrustDecision"
  | "ProjectTrustStore" | "ProjectTrustStoreEntry" | "ProjectTrustUpdate" | "PromptOptions" | "RenderDiffOptions"
  | "ResizedImage" | "ResolveCliModelResult" | "ResolveModelScopeResult" | "RpcExtensionUIRequest"
  | "RpcExtensionUIResponse" | "ScopedModel" | "SessionSelectorComponent" | "SessionStats" | "SettingsCallbacks"
  | "SettingsConfig" | "SettingsSelectorComponent" | "ShowImagesSelectorComponent" | "SkillInvocationMessageComponent"
  | "ThemeColor" | "ThemeSelectorComponent" | "ThinkingSelectorComponent" | "ToolExecutionComponent"
  | "ToolAuthorizationContext" | "ToolAuthorizationDecision" | "ToolAuthorizationHandler"
  | "ToolAuthorizationOwner" | "ToolAuthorizationRequest" | "ToolExecutionOptions" | "TreeSelectorComponent"
  | "TruncationOptions" | "TruncationResult"
  | "UserMessageComponent" | "UserMessageSelectorComponent" | "VERSION" | "VisualTruncateResult"
  | "calculateContextTokens" | "collectEntriesForBranchSummary" | "compact" | "convertToLlm" | "convertToPng"
  | "copyToClipboard" | "createAgentSessionFromServices" | "createAgentSessionRuntime" | "createAgentSessionServices"
  | "createExtensionRuntime" | "discoverAndLoadExtensions" | "estimateTokens" | "findCutPoint" | "findTurnStartIndex"
  | "formatDimensionNote" | "formatSize" | "generateBranchSummary" | "generateSummary" | "generateSummaryWithUsage"
  | "getDocsPath" | "getExamplesPath" | "getLanguageFromPath" | "getLastAssistantUsage" | "getMarkdownTheme"
  | "getPackageDir" | "getReadmePath" | "getSelectListTheme" | "getSettingsListTheme" | "getShellConfig"
  | "hasTrustRequiringProjectResources" | "highlightCode" | "initTheme" | "keyHint" | "keyText" | "main"
  | "parseArgs" | "parseFrontmatter" | "parseSkillBlock" | "prepareBranchEntries" | "rawKeyHint"
  | "readStoredCredential" | "readStoredCredentialAsync" | "renderDiff" | "resizeImage" | "resolveCliModel" | "resolveModelScopeWithDiagnostics"
  | "runRpcMode" | "serializeConversation" | "shouldCompact" | "stripFrontmatter" | "truncateHead"
  | "truncateLine" | "truncateTail" | "truncateToVisualLines" | "withFileMutationQueue"
  | "wrapRegisteredTool" | "wrapRegisteredTools";

type RootNames = keyof typeof Root;
type ReferenceRootValueName =
  | "CONFIG_DIR_NAME" | "CURRENT_SESSION_VERSION" | "DefaultPackageManager" | "DefaultResourceLoader"
  | "KeybindingsManager" | "ModelRegistry" | "RpcClient" | "SettingsManager" | "buildContextEntries"
  | "buildSessionContext" | "createAgentSession" | "createBashTool" | "createBashToolDefinition"
  | "createCodingTools" | "createEditTool" | "createEditToolDefinition" | "createEventBus" | "createFindTool"
  | "createFindToolDefinition" | "createGrepTool" | "createGrepToolDefinition" | "createLocalBashOperations"
  | "createLsTool" | "createLsToolDefinition" | "createReadOnlyTools" | "createReadTool"
  | "createReadToolDefinition" | "createSyntheticSourceInfo" | "createWriteTool" | "createWriteToolDefinition"
  | "formatSkillsForPrompt" | "generateDiffString" | "generateUnifiedPatch" | "getAgentDir"
  | "getLatestCompactionEntry" | "loadProjectContextFiles" | "loadSkills" | "loadSkillsFromDir"
  | "sessionEntryToContextMessages";
const referenceRootValuesAreComplete = true satisfies ReferenceRootValueName extends RootNames ? true : false;
const rpcModelInfo = {
  provider: "fixture",
  id: "fixture-model",
  contextWindow: 128_000,
  reasoning: true,
} satisfies Root.ModelInfo;
declare const catalogModelInfo: Core.ModelInfo;
const catalogModelCapabilities: {
  tools: Core.ModelCapability;
  reasoning: Core.ModelCapability;
  images: Core.ModelCapability;
} = catalogModelInfo.capabilities;
const projectTrustReadsAsynchronously = true satisfies (
  ReturnType<InstanceType<typeof Root.ProjectTrustStore>["get"]> extends Promise<Root.ProjectTrustDecision> ? true : false
);
declare const interactiveMode: InstanceType<typeof Root.InteractiveMode>;
interactiveMode.renderInitialMessages();
const pendingInteractiveInput: Promise<string> = interactiveMode.getUserInput();
interactiveMode.clearEditor();
interactiveMode.showError("failed");
interactiveMode.showWarning("warning");
interactiveMode.showNewVersionNotification({ version: "1.2.3", packageName: "rigyn", note: "Changes" });
interactiveMode.showPackageUpdateNotification(["example"]);
const publicToolShell: Root.ToolDefinition["renderShell"] = "default";
const mainOptions = {
  toolAuthorizationHandler: () => ({ decision: "allow_once" as const }),
} satisfies Root.MainOptions;
const fullscreenOptions: Tui.FullscreenTUIOptions = { mouse: true, wheelScrollLines: 4 };
const altScreenOptions: Tui.TuiAltScreenOptions = fullscreenOptions;
const modelAuthFreshness = { minOAuthValidityMs: 30_000 } satisfies Root.ModelRuntimeAuthOverrides;
const scopedModelResolutionIsAsync = true satisfies (
  ReturnType<typeof Root.resolveModelScopeWithDiagnostics> extends Promise<Root.ResolveModelScopeResult>
    ? true
    : false
);
const scopedModelResultShape = true satisfies (
  Root.ResolveModelScopeResult extends {
    scopedModels: Root.ScopedModel[];
    diagnostics: Root.ModelScopeDiagnostic[];
  } ? true : false
);
type CliModelOptions = Parameters<typeof Root.resolveCliModel>[0];
const cliModelInputShape = true satisfies (
  CliModelOptions extends {
    cliProvider?: string;
    cliModel?: string;
    cliThinking?: Root.ModelReasoningEffort;
  } ? true : false
);
const cliModelResultShape = true satisfies (
  Root.ResolveCliModelResult extends {
    model: unknown;
    warning: string | undefined;
    error: string | undefined;
  } ? true : false
);
declare const agentSessionConstructor: typeof Root.AgentSession;
declare const agentSessionConfig: Root.AgentSessionConfig;
const createdAgentSession: Promise<Root.AgentSession> =
  agentSessionConstructor.create(agentSessionConfig);
type RuntimeFactoryInput = Parameters<Root.CreateAgentSessionRuntimeFactory>[0];
type RuntimeFactoryServices = Awaited<ReturnType<Root.CreateAgentSessionRuntimeFactory>>["services"];
type LegacyMinimalRuntimeFactory = (
  input: RuntimeFactoryInput,
) => Promise<{ session: Root.AgentSession; services: RuntimeFactoryServices }>;
const legacyRuntimeFactoryRemainsCompatible = true satisfies (
  LegacyMinimalRuntimeFactory extends Root.CreateAgentSessionRuntimeFactory ? true : false
);
type PublicNames = RootNames | keyof typeof Auth | keyof typeof Config | keyof typeof Context | keyof typeof Core
  | keyof typeof Extensions | keyof typeof Images | keyof typeof Interfaces | keyof typeof Modes | keyof typeof Process
  | keyof typeof Providers | keyof typeof Service | keyof typeof Tools | keyof typeof Tui;
declare const genericName: GenericName;
declare const publicName: PublicNames;
void [
  genericName,
  publicName,
  referenceRootValuesAreComplete,
  rpcModelInfo,
  catalogModelCapabilities,
  projectTrustReadsAsynchronously,
  pendingInteractiveInput,
  publicToolShell,
  mainOptions,
  fullscreenOptions,
  altScreenOptions,
  rawTerminalKeybindings,
  applicationKeybindings,
  effectiveApplicationBindings,
  modelAuthFreshness,
  scopedModelResolutionIsAsync,
  scopedModelResultShape,
  cliModelInputShape,
  cliModelResultShape,
  createdAgentSession,
  legacyRuntimeFactoryRemainsCompatible,
];

export type {
  AgentSessionConfig,
  AgentSessionRuntimeDiagnostic,
  AgentSessionServices,
  AppKeybinding,
  Args,
  BranchPreparation,
  BranchSummaryResult,
  CollectEntriesResult,
  CreateAgentSessionFromServicesOptions,
  CreateAgentSessionRuntimeFactory,
  CreateAgentSessionRuntimeResult,
  CreateAgentSessionServicesOptions,
  CreateModelRuntimeOptions,
  CutPointResult,
  EditDiffResult,
  FileOperations,
  GenerateBranchSummaryOptions,
  InteractiveModeOptions,
  MainOptions,
  ModelCycleResult,
  ModelRuntimeAuthOverrides,
  ModelScopeDiagnostic,
  ParsedSkillBlock,
  ProjectTrustDecision,
  ProjectTrustStoreEntry,
  ProjectTrustUpdate,
  PromptOptions,
  RenderDiffOptions,
  ResizedImage,
  ResolveCliModelResult,
  ResolveModelScopeResult,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  ScopedModel,
  SessionStats,
  SettingsCallbacks,
  SettingsConfig,
  ThemeColor,
  ToolAuthorizationContext,
  ToolAuthorizationDecision,
  ToolAuthorizationHandler,
  ToolAuthorizationOwner,
  ToolAuthorizationRequest,
  ToolExecutionOptions,
  TruncationOptions,
  TruncationResult,
  VisualTruncateResult,
  BashOperations,
  BashSpawnContext,
  BashSpawnHook,
  BashToolDetails,
  BashToolInput,
  BashToolOptions,
  BuildSystemPromptOptions,
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  DefaultProjectTrust,
  EditOperations,
  EditToolDetails,
  EditToolInput,
  EditToolOptions,
  EventBus,
  EventBusController,
  FindOperations,
  FindToolDetails,
  FindToolInput,
  FindToolOptions,
  GrepOperations,
  GrepToolDetails,
  GrepToolInput,
  GrepToolOptions,
  ImageSettings,
  LoadSkillsFromDirOptions,
  LoadSkillsResult,
  LsOperations,
  LsToolDetails,
  LsToolInput,
  LsToolOptions,
  PackageManager,
  PackageSource,
  PathMetadata,
  ProgressCallback,
  ProgressEvent,
  PromptTemplate,
  ReadOperations,
  ReadToolDetails,
  ReadToolInput,
  ReadToolOptions,
  ReadonlyFooterDataProvider,
  ResolvedPaths,
  ResolvedResource,
  ResourceCollision,
  ResourceDiagnostic,
  ResourceLoader,
  RetrySettings,
  RpcClientOptions,
  RpcEventListener,
  SettingsManagerCreateOptions,
  Skill,
  SkillFrontmatter,
  SlashCommandInfo,
  SlashCommandSource,
  SourceInfo,
  Theme,
  ToolsOptions,
  WriteOperations,
  WriteToolInput,
  WriteToolOptions,
} from "rigyn";

declare const bashToolDetails: Root.BashToolDetails;
if (bashToolDetails.truncation !== undefined) {
  const truncated: boolean = bashToolDetails.truncation.truncated;
  void truncated;
}
