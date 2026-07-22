# Settings

rigyn has one editable settings document managed by `SettingsManager`. A self-contained install creates the global file from the complete packaged `resources/settings.example.json` whenever it is missing; `rigyn config edit` opens that same complete template when the user-scope file is missing. Existing files are preserved on reinstall and update.

Comments and trailing commas are not accepted. Every supported persistent preference is present in the scaffold. `null` means inherit rigyn's dynamic, provider, environment, or platform default; it is not passed into the runtime. Unknown keys are retained but have no effect. Missing files and missing keys also mean defaults, and rigyn does not generate a second “effective configuration” document.

## Locations and precedence

```text
~/.rigyn/agent/settings.json              global settings
$RIGYN_CODING_AGENT_DIR/settings.json     global settings with a custom agent directory
WORKSPACE/.rigyn/settings.json            trusted project settings
```

The self-contained launcher sets `RIGYN_CODING_AGENT_DIR` to `INSTALL_ROOT/agent`, so its settings, authentication, sessions, resources, and model catalog stay under that installation root.

Global settings load first. Trusted project settings override them. Nested setting objects merge recursively; arrays and scalar values replace. A nested or top-level `null` inherits the lower-precedence/default value. Project settings are not read and cannot be written until the workspace is trusted. `defaultProjectTrust` is global-only even if a project file contains that key.

`/reload` requires an idle session and blocks interactive input while it completes. It waits for pending writes, rereads both active settings scopes (including `keybindings`) and the legacy `keybindings.json`, then rebuilds extensions, skills, prompt templates, themes, and context files without switching the active JSONL session. Model state is rehydrated from cached catalogs only; `/reload` never waits for live provider discovery. A parse failure is reported and leaves the last valid in-memory settings scope intact. Writes lock the file and merge only the fields changed in-process into the latest disk contents, so unrelated external edits survive.

Credentials are stored separately in `auth.json`. Sessions are append-only JSONL files under `sessions/`. They are intentionally not configuration and never belong in `settings.json`. Provider/model declarations and authentication commands are also not settings: use the model registry and trusted provider extensions described in [Providers](providers.md).

The CLI owns `models.json` as its durable discovered-model catalog snapshot and may rewrite it after catalog refreshes. Its top level is `{ "version": 1, "savedAt": "...", "providers": [...] }`. The SDK compatibility `ModelRuntime` does not parse that file as configuration.

`ModelRuntime.create()` instead reads optional editable provider declarations from `model-providers.json`. That document has a provider-keyed top level such as `{ "providers": { "company": { "baseUrl": "...", "api": "openai-completions", "models": [...] } } }`. The CLI does not read `model-providers.json`; CLI provider customization remains extension-owned. An explicit SDK `modelsPath` still selects another provider-configuration file, and `modelsPath: null` disables it.

There is no automatic rename or copy from `models.json`, because that path may contain a live CLI catalog that must be preserved. An SDK-only installation that previously placed provider declarations there should move that provider-keyed document to `model-providers.json` before starting the CLI.

Application and editor overrides live under the `keybindings` object in `settings.json`, so ordinary configuration stays in one file. A pre-0.5.1 `keybindings.json` remains a compatibility input; values in `settings.json` take precedence. See [Keybindings](keybindings.md) for the action map and chord format. `/reload` applies keybinding changes together with settings and extension resources.

## Agent instructions

Use `AGENTS.md` to personalize the agent without changing the built-in system prompt:

```text
~/.rigyn/agent/AGENTS.md              global instructions
$RIGYN_CODING_AGENT_DIR/AGENTS.md     global instructions with a custom agent directory
ANCESTOR/AGENTS.md                    project or directory-specific instructions
```

A self-contained install scaffolds the global `AGENTS.md` from the packaged template whenever it is missing. Edit it
directly and run `/reload` in an active session; reinstall and update preserve the customized file byte-for-byte.

rigyn loads the global file first, then one instruction file from each ancestor directory in filesystem-root-to-working-directory order. More specific instructions therefore appear later. `/reload` rereads the active files, and `--no-context-files` disables instruction-file discovery for one invocation. Instruction files are prompt text; they do not grant extension trust or additional operating-system authority.

## Locate or edit settings

The settings commands default to user scope:

```sh
rigyn config path
rigyn config edit
rigyn config path --scope project
rigyn config edit --scope project
```

`path` prints the exact file path without creating it; add `--json` for structured output. `edit` opens the selected file with `externalEditor`, `$VISUAL`, `$EDITOR`, or the platform editor. When user settings are missing it starts from the complete packaged template. It accepts only valid JSON whose top level is an object. The edit is committed under the settings lock only when the on-disk file still matches the version opened in the editor, so invalid JSON, editor failure, or a concurrent change leaves the original untouched. Project scope targets `WORKSPACE/.rigyn/settings.json` and honors `--workspace DIR`; editing that scope requires a trusted workspace (or the invocation-only `--approve`). `-l` is the short project-scope form.

## Supported settings

| Key | Default | Purpose |
| --- | --- | --- |
| `lastChangelogVersion` | none | rigyn-managed marker for startup release notes; normally do not edit. |
| `defaultProvider` | none | Preferred provider when no session selection exists. |
| `defaultModel` | none | Preferred model ID. |
| `defaultThinkingLevel` | model default | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `transport` | `auto` | OpenAI Codex transport: `auto`, `sse`, `websocket`, or `websocket-cached`. |
| `steeringMode` | `one-at-a-time` | Drain steering messages `one-at-a-time` or `all`. |
| `followUpMode` | `one-at-a-time` | Drain follow-up messages `one-at-a-time` or `all`. |
| `theme` | `mono` | Built-in `mono` or `signal`, or a discovered custom theme name. A `LIGHT/DARK` pair may select two themes automatically. |
| `compaction.enabled` | `true` | Enable automatic compaction. |
| `compaction.reserveTokens` | `16384` | Reserve output room when deriving the compaction threshold. |
| `compaction.keepRecentTokens` | `20000` | Recent context retained verbatim where possible. |
| `branchSummary.reserveTokens` | `16384` | Output room reserved for branch summaries. |
| `branchSummary.skipPrompt` | `false` | Skip the optional summary question during tree navigation. |
| `retry.enabled` | `true` | Enable replay-safe transient retries. |
| `retry.maxRetries` | `3` | Maximum retry count. |
| `retry.baseDelayMs` | `2000` | Initial retry delay. |
| `retry.provider.timeoutMs` | provider default | Optional provider timeout. |
| `retry.provider.maxRetries` | provider default | Optional provider-specific retry count. |
| `retry.provider.maxRetryDelayMs` | `60000` | Maximum retry delay. |
| `hideThinkingBlock` | `false` | Hide expanded reasoning content in the transcript. |
| `showCacheMissNotices` | `false` | Show significant provider-reported cache misses. |
| `externalEditor` | `$VISUAL`, `$EDITOR`, or platform editor | External editor command. |
| `shellPath` | platform shell | Shell path; `~` is expanded. |
| `shellCommandPrefix` | none | Trusted operator prefix run in the same shell invocation. |
| `quietStartup` | `false` | Suppress the normal startup report. |
| `defaultProjectTrust` | `ask` | Global-only trust default: `ask`, `always`, or `never`. |
| `npmCommand` | platform npm | Executable plus fixed argv prefix for package operations. |
| `packages` | `[]` | npm, Git, or local package sources and optional resource filters. |
| `extensions` | `[]` | Additional extension files or directories. |
| `skills` | `[]` | Additional skill files or directories. |
| `prompts` | `[]` | Additional prompt-template files or directories. |
| `themes` | `[]` | Additional custom theme files or directories. |
| `enableSkillCommands` | `true` | Register discovered skills as slash commands. |
| `tools.enabled` | all built-in and extension tools | Persistent tool allowlist; `null` keeps every available tool enabled. Invocation flags take precedence. |
| `tools.excluded` | `[]` | Persistent tool exclusions, combined with `--exclude-tools`. |
| `terminal.showImages` | `true` | Render supported terminal images. |
| `terminal.imageWidthCells` | `60` | Preferred terminal image width. |
| `terminal.clearOnShrink` | `false` | Clear and redraw after terminal shrink. |
| `terminal.showTerminalProgress` | `false` | Show terminal-level progress state. |
| `images.autoResize` | `true` | Resize provider-bound images to safe bounds. |
| `images.blockImages` | `false` | Prevent images from being sent to providers. |
| `enabledModels` | all available | Provider/model glob patterns used for model cycling. |
| `doubleEscapeAction` | `tree` | `tree`, `fork`, or `none`. |
| `treeFilterMode` | `default` | `default`, `no-tools`, `user-only`, `labeled-only`, or `all`. |
| `thinkingBudgets` | provider defaults | Optional `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` token budgets. |
| `editorPaddingX` | `0` | Composer horizontal padding, clamped from 0 through 3. |
| `outputPad` | `1` | Transcript horizontal padding: 0 or 1. |
| `autocompleteMaxVisible` | `5` | Visible autocomplete rows, clamped from 3 through 20. |
| `showHardwareCursor` | `false` | Preserve a positioned terminal cursor for IME use. |
| `markdown.codeBlockIndent` | two spaces | Indentation used for rendered code blocks. |
| `warnings.anthropicExtraUsage` | `true` | Warn once per interactive process when an Anthropic model uses subscription credentials; set `false` to suppress. |
| `sessionDir` | `<agentDir>/sessions` | Alternate session directory; `~` is expanded. |
| `httpProxy` | environment/default dispatcher | Proxy URL for rigyn-managed HTTP clients. |
| `httpIdleTimeoutMs` | `300000` | Header/body idle timeout; `0` or `"disabled"` disables it. |
| `websocketConnectTimeoutMs` | provider default | WebSocket connect timeout; `0` or `"disabled"` disables it. |
| `collapseChangelog` | `false` | Prefer a condensed changelog display. |
| `keybindings` | platform defaults | Complete application/editor action map. `null` on an action keeps its built-in binding; `[]` unbinds it. |

rigyn does not send install or usage telemetry. Secrets, OAuth tokens, and provider request headers never belong in settings.

The first interactive startup records the installed version without replaying old release notes. After an update, startup shows only release sections newer than the recorded version. Set `collapseChangelog` to `true` for a one-line update notice; `/changelog` always shows the complete packaged changelog.

## Complete editable template

The installed `settings.json` is a directly editable copy of [`../resources/settings.example.json`](../resources/settings.example.json). It lists every persistent setting and every keybinding action. Leave dynamic values as `null`, replace them with an accepted value to override the default, and run `/reload` after editing. Project settings may stay sparse because they are override documents rather than the main user configuration.

## Package-resource selector

`rigyn config` opens the package-resource selector. It updates only the `packages` setting in the selected global or trusted-project scope. It does not print or maintain another configuration format.

## Migration from prerelease configuration

The former prerelease configuration surface is no longer read. Move ordinary preferences to the settings keys above. Move custom providers, model metadata, OAuth clients, arbitrary request headers, credential commands, and external execution policy to a reviewed provider or tool extension. This prevents provider authority and secrets from becoming an accidental second settings system.
