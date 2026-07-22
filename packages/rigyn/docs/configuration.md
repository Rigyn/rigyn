# Settings

Rigyn has one persisted settings model: sparse, strict JSON managed by `SettingsManager`.
Comments and trailing commas are not accepted. Missing files and missing keys mean defaults; Rigyn does not generate a second “effective configuration” document.

## Locations and precedence

```text
~/.rigyn/agent/settings.json              global settings
~/.rigyn/agent/keybindings.json           global application and editor bindings
$RIGYN_CODING_AGENT_DIR/settings.json     global settings with a custom agent directory
$RIGYN_CODING_AGENT_DIR/keybindings.json  bindings with a custom agent directory
WORKSPACE/.rigyn/settings.json            trusted project settings
```

The self-contained launcher sets `RIGYN_CODING_AGENT_DIR` to `INSTALL_ROOT/agent`, so its settings, authentication, sessions, resources, and model catalog stay under that installation root.

Global settings load first. Trusted project settings override them. Nested setting objects merge one level deep; arrays and scalar values replace. Project settings are not read and cannot be written until the workspace is trusted. `defaultProjectTrust` is global-only even if a project file contains that key.

`/reload` requires an idle session and blocks interactive input while it completes. It waits for pending writes, rereads both active settings scopes and `keybindings.json`, then rebuilds extensions, skills, prompt templates, themes, and context files without switching the active JSONL session. Model state is rehydrated from cached catalogs only; `/reload` never waits for live provider discovery. A parse failure is reported and leaves the last valid in-memory settings scope intact. Writes lock the file and merge only the fields changed in-process into the latest disk contents, so unrelated external edits survive.

Credentials are stored separately in `auth.json`. Sessions are append-only JSONL files under `sessions/`. Provider/model declarations and authentication commands are not settings: use the model registry and trusted provider extensions described in [Providers](providers.md).

Keybindings are stored separately because they configure both the application and the low-level editor. See [Keybindings](keybindings.md) for the complete action map and file format. `/reload` applies keybinding changes together with settings and extension resources.

## Supported settings

| Key | Default | Purpose |
| --- | --- | --- |
| `defaultProvider` | none | Preferred provider when no session selection exists. |
| `defaultModel` | none | Preferred model ID. |
| `defaultThinkingLevel` | model default | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `transport` | `auto` | OpenAI Codex transport: `auto`, `sse`, `websocket`, or `websocket-cached`. |
| `steeringMode` | `one-at-a-time` | Drain steering messages `one-at-a-time` or `all`. |
| `followUpMode` | `one-at-a-time` | Drain follow-up messages `one-at-a-time` or `all`. |
| `theme` | terminal default | Theme name. A value containing `/` is reserved for paired selection and is not treated as one theme name. |
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
| `themes` | `[]` | Additional theme files or directories. |
| `enableSkillCommands` | `true` | Register discovered skills as slash commands. |
| `terminal.showImages` | `true` | Render supported terminal images. |
| `terminal.imageWidthCells` | `60` | Preferred terminal image width. |
| `terminal.clearOnShrink` | `false` | Clear and redraw after terminal shrink. |
| `terminal.showTerminalProgress` | `false` | Show terminal-level progress state. |
| `images.autoResize` | `true` | Resize provider-bound images to safe bounds. |
| `images.blockImages` | `false` | Prevent images from being sent to providers. |
| `enabledModels` | all available | Provider/model glob patterns used for model cycling. |
| `doubleEscapeAction` | `tree` | `tree`, `fork`, or `none`. |
| `treeFilterMode` | `default` | `default`, `no-tools`, `user-only`, `labeled-only`, or `all`. |
| `thinkingBudgets` | provider defaults | Optional `minimal`, `low`, `medium`, and `high` token budgets. |
| `editorPaddingX` | `0` | Composer horizontal padding, clamped from 0 through 3. |
| `outputPad` | `1` | Transcript horizontal padding: 0 or 1. |
| `autocompleteMaxVisible` | `5` | Visible autocomplete rows, clamped from 3 through 20. |
| `showHardwareCursor` | `false` | Preserve a positioned terminal cursor for IME use. |
| `markdown.codeBlockIndent` | two spaces | Indentation used for rendered code blocks. |
| `warnings.anthropicExtraUsage` | `true` | Warn once per interactive process when an Anthropic model uses subscription credentials; set `false` to suppress. |
| `sessionDir` | `<agentDir>/sessions` | Alternate session directory; `~` is expanded. |
| `httpProxy` | environment/default dispatcher | Proxy URL for Rigyn-managed HTTP clients. |
| `httpIdleTimeoutMs` | `300000` | Header/body idle timeout; `0` or `"disabled"` disables it. |
| `websocketConnectTimeoutMs` | provider default | WebSocket connect timeout; `0` or `"disabled"` disables it. |
| `collapseChangelog` | `false` | Prefer a condensed changelog display. |

Rigyn does not send install or usage telemetry. Secrets, OAuth tokens, and provider request headers never belong in settings.

The first interactive startup records the installed version without replaying old release notes. After an update, startup shows only release sections newer than the recorded version. Set `collapseChangelog` to `true` for a one-line update notice; `/changelog` always shows the complete packaged changelog.

## Sparse example

```json
{
  "defaultProvider": "openai-codex",
  "defaultModel": "MODEL_ID",
  "defaultThinkingLevel": "high",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "packages": [
    "npm:@scope/reviewed-package"
  ]
}
```

Keep only intentional overrides. A packaged copy of this example is available at [`../resources/settings.example.json`](../resources/settings.example.json).

## Package-resource selector

`rigyn config` opens the package-resource selector. It updates only the `packages` setting in the selected global or trusted-project scope. It does not print or maintain another configuration format.

## Migration from prerelease configuration

The former prerelease configuration surface is no longer read. Move ordinary preferences to the settings keys above. Move custom providers, model metadata, OAuth clients, arbitrary request headers, credential commands, and external execution policy to a reviewed provider or tool extension. This prevents provider authority and secrets from becoming an accidental second settings system.
