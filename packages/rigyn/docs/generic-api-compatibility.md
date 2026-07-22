# Generic coding-agent API compatibility

Rigyn exposes generic coding-agent names from the package root and the relevant public subpath. They use the existing Rigyn session, model, extension, tool, image, compaction, and terminal modules; they do not create a second runtime architecture.

## Classification

### Direct aliases and re-exports

- Session and CLI: `AgentSessionConfig`, `AgentSessionRuntime`, `AgentSessionRuntimeDiagnostic`, `Args`, `CreateAgentSessionRuntimeFactory`, `CreateAgentSessionRuntimeResult`, `ModelCycleResult`, `PromptOptions`, `SessionStats`, `createAgentSessionRuntime`, and `parseArgs`.
- Tools and protocols: `EditDiffResult`, `ExtensionRunner`, `RpcExtensionUIRequest`, `RpcExtensionUIResponse`, `TruncationOptions`, `TruncationResult`, `formatSize`, `truncateHead`, `truncateTail`, `withFileMutationQueue`, `wrapRegisteredTool`, and `wrapRegisteredTools`.
- Constants and UI types: `AppKeybinding`, `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`, `ThemeColor`, and `VERSION`.

### Thin Rigyn adapters

- Session and models: `AgentSessionServices`, `CreateAgentSessionFromServicesOptions`, `CreateAgentSessionServicesOptions`, `CreateModelRuntimeOptions`, `ModelRuntime`, `ModelRuntimeAuthOverrides`, `ModelScopeDiagnostic`, `ParsedSkillBlock`, `ResolveCliModelResult`, `ResolveModelScopeResult`, `ScopedModel`, `createAgentSessionFromServices`, `createAgentSessionServices`, `parseSkillBlock`, `resolveCliModel`, and `resolveModelScopeWithDiagnostics`.
- Compaction: `BranchPreparation`, `BranchSummaryResult`, `CollectEntriesResult`, `CutPointResult`, `DEFAULT_COMPACTION_SETTINGS`, `FileOperations`, `GenerateBranchSummaryOptions`, `calculateContextTokens`, `collectEntriesForBranchSummary`, `compact`, `convertToLlm`, `estimateTokens`, `findCutPoint`, `findTurnStartIndex`, `generateBranchSummary`, `generateSummary`, `generateSummaryWithUsage`, `getLastAssistantUsage`, `prepareBranchEntries`, `serializeConversation`, and `shouldCompact`.
- Terminal UI: `AssistantMessageComponent`, `BashExecutionComponent`, `BorderedLoader`, `BranchSummaryMessageComponent`, `CompactionSummaryMessageComponent`, `CustomEditor`, `CustomMessageComponent`, `DynamicBorder`, `ExtensionEditorComponent`, `ExtensionInputComponent`, `ExtensionSelectorComponent`, `FooterComponent`, `LoginDialogComponent`, `ModelSelectorComponent`, `OAuthSelectorComponent`, `RenderDiffOptions`, `SessionSelectorComponent`, `SettingsCallbacks`, `SettingsConfig`, `SettingsSelectorComponent`, `ShowImagesSelectorComponent`, `SkillInvocationMessageComponent`, `ThemeSelectorComponent`, `ThinkingSelectorComponent`, `ToolExecutionComponent`, `ToolExecutionOptions`, `TreeSelectorComponent`, `UserMessageComponent`, `UserMessageSelectorComponent`, `VisualTruncateResult`, `getLanguageFromPath`, `getMarkdownTheme`, `getSelectListTheme`, `getSettingsListTheme`, `highlightCode`, `initTheme`, `keyHint`, `keyText`, `rawKeyHint`, `renderDiff`, and `truncateToVisualLines`.
- Files, images, extensions, and modes: `InteractiveMode`, `InteractiveModeOptions`, `MainOptions`, `ProjectTrustDecision`, `ProjectTrustStore`, `ProjectTrustStoreEntry`, `ProjectTrustUpdate`, `ResizedImage`, `convertToPng`, `copyToClipboard`, `createExtensionRuntime`, `discoverAndLoadExtensions`, `formatDimensionNote`, `getDocsPath`, `getExamplesPath`, `getPackageDir`, `getReadmePath`, `getShellConfig`, `hasTrustRequiringProjectResources`, `main`, `parseFrontmatter`, `readStoredCredential`, `resizeImage`, `runRpcMode`, `stripFrontmatter`, and `truncateLine`.

### Excluded branded surface

- The audit's character-specific component is intentionally not exported. It is not a generic coding-agent contract, and adding it would introduce an external product identity into Rigyn.

## Deliberate native contracts

- `ProjectTrustStore` keeps Rigyn's async, canonicalized, lock-protected trust operations. Its `get`, `getEntry`, `set`, and `setMany` methods therefore return promises.
- Compaction helpers use Rigyn's `ContextSummarizer` and normalized usage contracts.
- `runRpcMode` owns an already-created `AgentSessionRuntime` and serves the correlated RPC protocol until shutdown. The executable `rigyn/rpc-entry` remains unchanged.
- `InteractiveMode` provides an embeddable prompt loop. The full application UI, command palette, reload flow, and project-trust prompts remain owned by `main`.
- `MainOptions.extensionFactories` accepts trusted in-process extensions and carries them through every runtime generation and management path that constructs extension resources.
- `ModelRuntime` uses Rigyn credential and provider-model stores. Create-time refresh is offline unless `allowModelNetwork` is set; transport-specific timeout policy remains with the provider transport.
