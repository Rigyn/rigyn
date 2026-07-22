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
import type { KeybindingsManager as SharedKeybindingsManager } from "@rigyn/terminal";

declare const sharedKeybindings: SharedKeybindingsManager;
sharedKeybindings.matches("", "app.clear");
sharedKeybindings.matches("", "tui.editor.redo");

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
  | "MainOptions" | "ModelCycleResult" | "ModelRuntime" | "ModelRuntimeAuthOverrides" | "ModelScopeDiagnostic"
  | "ModelSelectorComponent" | "OAuthSelectorComponent" | "ParsedSkillBlock" | "ProjectTrustDecision"
  | "ProjectTrustStore" | "ProjectTrustStoreEntry" | "ProjectTrustUpdate" | "PromptOptions" | "RenderDiffOptions"
  | "ResizedImage" | "ResolveCliModelResult" | "ResolveModelScopeResult" | "RpcExtensionUIRequest"
  | "RpcExtensionUIResponse" | "ScopedModel" | "SessionSelectorComponent" | "SessionStats" | "SettingsCallbacks"
  | "SettingsConfig" | "SettingsSelectorComponent" | "ShowImagesSelectorComponent" | "SkillInvocationMessageComponent"
  | "ThemeColor" | "ThemeSelectorComponent" | "ThinkingSelectorComponent" | "ToolExecutionComponent"
  | "ToolExecutionOptions" | "TreeSelectorComponent" | "TruncationOptions" | "TruncationResult"
  | "UserMessageComponent" | "UserMessageSelectorComponent" | "VERSION" | "VisualTruncateResult"
  | "calculateContextTokens" | "collectEntriesForBranchSummary" | "compact" | "convertToLlm" | "convertToPng"
  | "copyToClipboard" | "createAgentSessionFromServices" | "createAgentSessionRuntime" | "createAgentSessionServices"
  | "createExtensionRuntime" | "discoverAndLoadExtensions" | "estimateTokens" | "findCutPoint" | "findTurnStartIndex"
  | "formatDimensionNote" | "formatSize" | "generateBranchSummary" | "generateSummary" | "generateSummaryWithUsage"
  | "getDocsPath" | "getExamplesPath" | "getLanguageFromPath" | "getLastAssistantUsage" | "getMarkdownTheme"
  | "getPackageDir" | "getReadmePath" | "getSelectListTheme" | "getSettingsListTheme" | "getShellConfig"
  | "hasTrustRequiringProjectResources" | "highlightCode" | "initTheme" | "keyHint" | "keyText" | "main"
  | "parseArgs" | "parseFrontmatter" | "parseSkillBlock" | "prepareBranchEntries" | "rawKeyHint"
  | "readStoredCredential" | "renderDiff" | "resizeImage" | "resolveCliModel" | "resolveModelScopeWithDiagnostics"
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
  | "migrateSessionEntries" | "parseSessionEntries" | "sessionEntryToContextMessages";
const referenceRootValuesAreComplete = true satisfies ReferenceRootValueName extends RootNames ? true : false;
const projectTrustReadsSynchronously = true satisfies (
  ReturnType<InstanceType<typeof Root.ProjectTrustStore>["get"]> extends Root.ProjectTrustDecision ? true : false
);
type PublicNames = RootNames | keyof typeof Auth | keyof typeof Config | keyof typeof Context | keyof typeof Core
  | keyof typeof Extensions | keyof typeof Images | keyof typeof Interfaces | keyof typeof Modes | keyof typeof Process
  | keyof typeof Providers | keyof typeof Service | keyof typeof Tools | keyof typeof Tui;
declare const genericName: GenericName;
declare const publicName: PublicNames;
void [genericName, publicName, referenceRootValuesAreComplete, projectTrustReadsSynchronously];

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
