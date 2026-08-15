# Root API aliases and adapters

rigyn exposes convenient names from the package root and the relevant public subpaths. These names use rigyn's existing session, model, extension, tool, image, compaction, and terminal modules. They do not create a second runtime.

## Classification

### Direct aliases and re-exports

- Session and CLI: `AgentSessionRuntime`, `AgentSessionRuntimeDiagnostic`, `Args`, `CreateAgentSessionRuntimeFactory`, `CreateAgentSessionRuntimeResult`, `ModelCycleResult`, `PromptOptions`, `SessionStats`, `createAgentSessionRuntime`, and `parseArgs`.
- Direct-extension authoring: `CommandCompletion`, `CommandOptions`, `CustomMessageDeliveryOptions`, `ExtensionConfigDataRoots`, `ExtensionConfigReadOptions`, `ExtensionConfigScope`, `ExtensionConfigSnapshot`, `ExtensionConfigStore`, `ExtensionConfigStoreOptions`, `ExtensionConfigWriteOptions`, `ExtensionEventMap`, `ExtensionEventResultMap`, `ExtensionMessage`, `ExtensionModelRegistry`, `ExtensionOAuthConfig`, `ExtensionProviderConfig`, `ExtensionProviderModelConfig`, `ExtensionThinkingLevel`, `FlagOptions`, `FooterFactory`, `ForkOptions`, `NavigateTreeOptions`, `ReplacementOptions`, `ShortcutOptions`, `SwitchSessionOptions`, and `UserMessageDeliveryOptions`. Their canonical focused import is `rigyn/extensions`.
- Tools and protocols: `EditDiffResult`, `ExtensionRunner`, `RpcExtensionUIRequest`, `RpcExtensionUIResponse`, `TruncationOptions`, `TruncationResult`, `formatSize`, `truncateHead`, `truncateTail`, `withFileMutationQueue`, `wrapRegisteredTool`, and `wrapRegisteredTools`.
- Constants and UI types: `AppKeybinding`, `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`, `ThemeColor`, and `VERSION`.

### Thin rigyn adapters

- Session and models: `AgentSessionConfig`, `AgentSessionServices`, `CreateAgentSessionFromServicesOptions`, `CreateAgentSessionServicesOptions`, `CreateModelRuntimeOptions`, `ModelInfo`, `ModelRuntime`, `ModelRuntimeAuthOverrides`, `ModelScopeDiagnostic`, `ParsedSkillBlock`, `ResolveCliModelResult`, `ResolveModelScopeResult`, `ScopedModel`, `createAgentSessionFromServices`, `createAgentSessionServices`, `parseSkillBlock`, `resolveCliModel`, and `resolveModelScopeWithDiagnostics`.
- Compaction: `BranchPreparation`, `BranchSummaryResult`, `CollectEntriesResult`, `CutPointResult`, `DEFAULT_COMPACTION_SETTINGS`, `FileOperations`, `GenerateBranchSummaryOptions`, `calculateContextTokens`, `collectEntriesForBranchSummary`, `compact`, `convertToLlm`, `estimateTokens`, `findCutPoint`, `findTurnStartIndex`, `generateBranchSummary`, `generateSummary`, `generateSummaryWithUsage`, `getLastAssistantUsage`, `prepareBranchEntries`, `serializeConversation`, and `shouldCompact`.
- Terminal UI components: `AssistantMessageComponent`, `BashExecutionComponent`, `BorderedLoader`, `BranchSummaryMessageComponent`, `CompactionSummaryMessageComponent`, `CustomEditor`, and `CustomMessageComponent`. The same group exposes `DynamicBorder`, `ExtensionEditorComponent`, `ExtensionInputComponent`, `ExtensionSelectorComponent`, `FooterComponent`, `KeybindingsManager`, `LoginDialogComponent`, `ModelSelectorComponent`, `OAuthSelectorComponent`, `RenderDiffOptions`, `SessionSelectorComponent`, `SettingsCallbacks`, `SettingsConfig`, `SettingsSelectorComponent`, `ShowImagesSelectorComponent`, `SkillInvocationMessageComponent`, `ThemeSelectorComponent`, `ThinkingSelectorComponent`, `ToolExecutionComponent`, `ToolExecutionOptions`, `TreeSelectorComponent`, `UserMessageComponent`, `UserMessageSelectorComponent`, `VisualTruncateResult`, `getLanguageFromPath`, `getMarkdownTheme`, `getSelectListTheme`, `getSettingsListTheme`, `highlightCode`, `initTheme`, `keyHint`, `keyText`, `rawKeyHint`, `renderDiff`, and `truncateToVisualLines`.
- Files, images, extensions, and modes: `InteractiveMode`, `InteractiveModeOptions`, `MainOptions`, `ProjectTrustDecision`, `ProjectTrustStore`, `ProjectTrustStoreEntry`, `ProjectTrustUpdate`, `ResizedImage`, `convertToPng`, `copyToClipboard`, `createExtensionRuntime`, `discoverAndLoadExtensions`, `formatDimensionNote`, `getDocsPath`, `getExamplesPath`, `getPackageDir`, `getReadmePath`, `getShellConfig`, `hasTrustRequiringProjectResources`, `main`, `parseFrontmatter`, `readStoredCredential`, `readStoredCredentialAsync`, `resizeImage`, `runPrintMode`, `runRpcMode`, `stripFrontmatter`, and `truncateLine`.

`readStoredCredential()` is the deprecated synchronous reader for legacy plaintext `auth.json` files.
`readStoredCredentialAsync()` follows the durable backend selection used by the CLI.

`discoverAndLoadExtensions()` is a low-level helper for a caller that has already approved project-local executable code. It does not prompt for or establish project trust; application entry points should use the normal trust-aware resource loader.

Canonical persisted `BashExecutionMessage`, `BranchSummaryMessage`, `CompactionSummaryMessage`, and `LabelEntry` shapes are deliberately scoped to `rigyn/storage`. Direct extensions receive the public session projection from `rigyn/extensions`; callback signatures are expressed by `ExtensionAPI`, `ExtensionActions`, `ExtensionEventMap`, and `ExtensionEventResultMap` rather than separate per-method handler aliases.

## Deliberate native contracts

- `ProjectTrustStore` uses the CLI's canonicalized, lock-protected `trusted-workspaces.json` authority. Its `get`, `getEntry`, `set`, and `setMany` methods return promises.
- Compaction helpers use rigyn's `ContextSummarizer` and normalized usage contracts.
- `runPrintMode` owns an already-created `AgentSessionRuntime`. It emits either assistant text or public JSON events, then disposes the runtime. Its embedded host owns process signals, cancellation, and process exit.
- `runRpcMode` owns an already-created `AgentSessionRuntime`. It serves the correlated RPC protocol until shutdown. The executable `rigyn/rpc-entry` remains unchanged.
- `InteractiveMode` provides an embeddable prompt loop. The full application UI, command palette, refresh flow, and project-trust prompts remain owned by `main`.
- `MainOptions.extensionFactories` accepts trusted in-process extensions and carries them through every runtime generation and management path that constructs extension resources.
- `ModelRuntime` uses rigyn credential and provider-model stores. Its default editable provider configuration is `model-providers.json`, separate from the CLI-owned `models.json` catalog. An explicit `modelsPath` remains supported. Create-time refresh is offline unless `allowModelNetwork` is set. Transport-specific timeout policy stays with the provider transport.
- Root `ModelInfo` is the stable RPC model summary with provider, ID, context window, optional maximum input ceiling, and reasoning support. The richer provider-runtime `ModelInfo` remains available from `rigyn/core`.
- Root `KeybindingsManager` accepts application action overrides or terminal definitions and exposes `getEffectiveConfig()`. The low-level terminal manager remains available as `KeybindingsManager` from `rigyn/tui` and `@rigyn/terminal`; `loadKeybindings()` from `rigyn/tui` is the explicit bounded file loader for embedding hosts.
