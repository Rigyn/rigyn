# Configuration

Project package declarations are deliberately separate from configuration. Put them in `.rigyn/packages.json` and commit the generated `.rigyn/packages.lock.json`; both remain ignored until workspace trust. See [Package authoring and local gallery](packages.md#trusted-project-declarations-and-immutable-locks) for their strict source schemas and `packages check`, `reconcile`, and `update` workflow.

Rigyn reads comment-friendly JSONC configuration. Unknown keys are rejected so misspellings do not silently change behavior.

A first-time self-contained installation creates a complete commented `config.jsonc` reference. Every stable public key is represented, with defaults, allowed values, or valid override examples where the value is provider- or environment-dependent. Commented entries do not freeze defaults or change behavior, and existing configuration is never overwritten. Run `rigyn config show --effective` to print the merged, validated public configuration with stable config-level defaults for the selected workspace. Provider-internal model behavior, live session selection, and environment-derived proxy credentials are outside that command's scope. Credentials and OAuth tokens are stored separately and never appear in either output.

## Locations and precedence

On Linux and other XDG systems, the default paths are:

```text
~/.config/rigyn/config.jsonc              global configuration
~/.config/rigyn/keybindings.json          keybindings
~/.config/rigyn/AGENTS.md                  user instructions
~/.config/rigyn/SYSTEM.md                  user operating prompt override
~/.config/rigyn/APPEND_SYSTEM.md           user operating prompt addition
~/.config/rigyn/skills/                    user skills
~/.agents/skills/                                 compatible user skills
~/.claude/skills/                                 compatible user skills
~/.codex/skills/                                  compatible user skills
~/.config/rigyn/extensions/                user extensions
~/.config/rigyn/prompts/                   user prompt templates
~/.config/rigyn/themes/                    user themes
~/.config/rigyn/trusted-workspaces.json    project trust
~/.local/state/rigyn/sessions.sqlite       durable sessions
~/.local/state/rigyn/models.json           cached model catalogs
```

`XDG_CONFIG_HOME` and `XDG_STATE_HOME` replace the corresponding roots when set. A trusted project may add `.rigyn/config.jsonc`, `.rigyn/extensions`, `.rigyn/skills`, `.rigyn/prompts`, `.rigyn/themes`, and compatible `.agents/skills`, `.claude/skills`, and `.codex/skills` resources. When Rigyn starts inside a Git repository, trusted `.agents/skills` roots are discovered from the repository root through the launch directory. Compatible project skill discovery is disabled until the workspace is trusted.

Skill roots are evaluated in deterministic order: bundled and native user roots; `~/.agents/skills`, `~/.claude/skills`, and `~/.codex/skills`; extension-contributed roots; trusted project `.rigyn/skills`; ancestor `.agents/skills` roots from repository root to launch directory; launch-directory `.claude/skills` and `.codex/skills`; configured `skillRoots`; then invocation-only skill paths. Later roots win collisions. Diagnostics identify the winning and shadowed manifest and root paths so precedence is never silent.

The self-contained `$HOME/.rigyn/bin/rigyn` launcher sets those roots to `$HOME/.rigyn/config` and `$HOME/.rigyn/state`. Its configuration therefore lives under `$HOME/.rigyn/config/rigyn`, and its sessions and model cache live under `$HOME/.rigyn/state/rigyn`. Direct development runs continue to use the normal XDG defaults unless you override them.

Layers are merged in this order:

1. global configuration;
2. trusted project configuration;
3. invocation flags.

Object keys merge recursively. Later scalar and array values replace earlier values. `/reload` applies resource and configuration changes without replacing the active session; changing the database path requires a restart.

## Top-level settings

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `defaultProvider` | string | `openai` | Provider selected when a session has no saved selection. |
| `defaultModel` | string | none | Default model ID for `defaultProvider`. |
| `theme` | string | `light/dark` | TUI theme name, or `LIGHT/DARK` to follow the detected terminal background. |
| `thinking` | string | `off` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Unsupported levels are constrained by model metadata. |
| `thinkingBudgets` | object | provider defaults | Optional `minimal`, `low`, `medium`, and `high` token budgets for provider protocols that accept numeric reasoning budgets. Adaptive/level-only protocols ignore them. |
| `steeringMode` | string | `one-at-a-time` | Drain steering input `one-at-a-time` or `all`. |
| `followUpMode` | string | `one-at-a-time` | Drain follow-up input `one-at-a-time` or `all`. |
| `doubleEscapeAction` | string | `tree` | Open `tree`, open `fork`, or do `none` when Escape is pressed twice on an empty editor. |
| `quietStartup` | boolean | `false` | Hide the startup report. `--verbose` shows it for one launch. |
| `hideThinkingBlock` | boolean | `false` | Replace reasoning content with its compact label in the transcript. |
| `externalEditor` | string | `$VISUAL`, `$EDITOR`, or platform editor | Explicit executable and arguments for external editing. Quotes group arguments; no shell is used. |
| `treeFilterMode` | string | `default` | Initial `/tree` filter: `default`, `no-tools`, `user-only`, `labeled-only`, or `all`. |
| `editorPaddingX` | integer | `0` | Left and right composer padding from 0 through 3 cells. |
| `outputPad` | integer | `0` | Left and right transcript padding: 0 or 1 cell. |
| `autocompleteMaxVisible` | integer | viewport-derived | Optional autocomplete height from 3 through 20 rows. |
| `showHardwareCursor` | boolean | `true` | Show the terminal cursor in the composer. |
| `terminal` | object | `{ showImages: true, imageWidthCells: 80, clearOnShrink: false }` | Image display, preview width, and full redraw-on-shrink controls. |
| `markdown` | object | `{ codeBlockIndent: "" }` | Markdown presentation controls; `codeBlockIndent` accepts zero through eight spaces. |
| `branchSummary` | object | `{ reserveTokens: 16384, skipPrompt: false }` | Reserve model context for summary output; set `skipPrompt` to move through `/tree` without offering model-generated branch context. |
| `images` | object | `{ autoResize: true }` | Resize provider-bound images to fit 2000×2000. `false` preserves dimensions when compiled edge, pixel, and output-byte guardrails permit. |
| `enableSkillCommands` | boolean | `true` | Discover and expand `/skill:name` commands. Skills remain available to the agent when disabled. |
| `showCacheMissNotices` | boolean | `false` | Show a local warning after an observable provider-cache miss of at least 20,000 reusable prompt tokens. |
| `warnings` | object | `{ anthropicExtraUsage: true }` | Control one-time operator notices; `anthropicExtraUsage` applies when Anthropic OAuth is selected. |
| `defaultProjectTrust` | string | `ask` | Global-only fallback for undecided workspaces: `ask`, `always`, or `never`. `/settings` changes the next-launch behavior. |
| `outboundImages` | string | `allow` | `allow` or `block` image submission to providers. |
| `scopedModels` | string[] | `[]` | Provider/model patterns used by the model cycle keys. A `:thinking` suffix is supported. |
| `databasePath` | string | state directory database | Alternate SQLite session database. |
| `shellPath` | absolute path | platform shell | Shell used by `bash` and `!` shortcuts. |
| `shellCommandPrefix` | string | none | Trusted shell source prepended in the same shell invocation to model `bash` and `!`/`!!` commands. |
| `npmCommand` | string[] | platform npm | Executable and fixed argv prefix used for package fetches and production dependencies. |
| `gitCommand` | string[] | `git` | Executable and fixed argv prefix used for package clones and revision checks. |
| `executionBackend` | object | host-local tools | Optional fail-closed external/remote executor for explicitly claimed model tools. |
| `contextTokenBudget` | integer | model metadata | Manual input budget override when applicable. |
| `summaryTokenBudget` | integer | derived | Maximum compaction summary budget. |
| `autoCompaction` | boolean | `true` | Compact safely before context exhaustion. |
| `compaction` | object | `{ reserveTokens: 16384, keepRecentTokens: 20000 }` | Reserve output space when deriving the compaction trigger and keep this many recent tokens verbatim where possible. |
| `providerRetry` | object | `{ enabled: true, maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 30000, jitter: 0.2 }` | Bounded retry policy for transient provider failures. `/settings` exposes `enabled` and `maxAttempts`; delay and jitter tuning remain config-only. |
| `compactionRetainRecentTurns` | integer | `2` | Minimum recent complete turns kept verbatim. |
| `compactionToolResultBytes` | integer | `4096` | Maximum retained bytes for each old tool result. |
| `maxSteps` | integer | `64` | Maximum model turns in one run. Configure a larger positive integer for deliberately longer tasks. |
| `childRuns` | object | bounded defaults below | Defaults and operator maxima for in-process `runChild` delegation. |
| `skillRoots` | string[] | `[]` | Additional skill files or directories. |
| `extensionRoots` | string[] | `[]` | Additional extension roots. |
| `promptRoots` | string[] | `[]` | Up to 32 additional prompt files, directories, or bounded glob patterns. Re-scanned by `/reload`. |
| `themeRoots` | string[] | `[]` | Up to 32 additional theme files, directories, or bounded glob patterns. Re-scanned by `/reload`. |
| `packageResources` | object | `{}` | Per-package resource filters written by `rigyn config`. |
| `providers` | object | built-in providers | Fixed-protocol overrides, custom endpoints, credential-conditioned message gateways, and exact declarative multi-protocol routes. |
| `models` | object[] | maintained/live catalogs | Explicit model metadata. |
| `oauthRegistrations` | object | `{}` | Custom PKCE or device OAuth clients. |
| `credentialCommands` | object | `{}` | Bounded argv-only provider credential helpers with explicit environment forwarding and in-memory TTLs. |
| `httpTransport` | object | `{}` | Proxy and network timeout controls. |

`providerRetry.enabled` defaults to `true`. Changing it in `/settings` applies immediately to the current process and is persisted for later launches. While a retry delay is visible, Escape cancels only that scheduled retry; it does not send a whole-run abort. Programmatic runtimes expose the same narrow action through each run handle's `cancelRetry()` method.

Package-manager command values are argv arrays, not shell command strings. For example, `"npmCommand": ["mise", "exec", "node@24", "--", "npm"]` selects a version-manager wrapper without enabling shell interpolation. On Windows, configure a native executable or an interpreter plus script path; `.cmd` and `.bat` wrappers are rejected because they require shell parsing. Package installation still adds bounded arguments and disables lifecycle scripts by default; `--allow-scripts` is an explicit, per-transaction exception for reviewed production dependencies.

Built-in fixed and multi-protocol providers need no entry under `providers`; authenticate them with `/login` or their documented environment variables. The complete preset list, regional credential names, routed-model behavior, and provider-specific setup values are in [Providers and authentication](providers.md). Entries under `providers` replace a preset intentionally or define a custom endpoint; unknown kinds, profiles, route protocols, and fields fail validation.

Model-initiated `bash` commands default to a 600-second timeout when the tool call omits `timeout`. A tool call can request a different positive timeout explicitly.

`shellCommandPrefix` is executable shell source from trusted operator configuration. Rigyn joins it to the requested command with a newline inside the existing shell invocation; it does not add a second shell or expose the prefix as model-authored command text. It applies to local and configured execution-backend `bash` calls and to interactive shell shortcuts.

## External credential commands

`credentialCommands` connects a provider ID to an executable that obtains a short-lived API key or bearer token from an external credential manager. Rigyn invokes the configured argv directly without a shell, gives it a minimal process environment, forwards only explicitly named variables, bounds its time and output, redacts failures, and reaps the full process tree on timeout or cancellation. The command must print exactly one JSON object:

```json
{ "type": "api_key", "apiKey": "...", "accountId": "optional" }
```

or:

```json
{ "type": "bearer", "accessToken": "...", "expiresAt": 1780000000000, "accountId": "optional", "subject": "optional" }
```

Configuration contains only the executable contract, never its returned secret. Stored/OAuth profiles remain higher precedence, and a configured command runs before the built-in environment-variable fallback. Results are cached in memory for `cacheTtlMs` (default 60 seconds), but never beyond a bearer credential's safe pre-expiry window; zero disables caching. A successful `/reload` atomically replaces command definitions and clears the old cache.

```jsonc
{
  "credentialCommands": {
    "company": {
      "argv": ["/absolute/path/to/company-credential-helper", "--json"],
      "environment": ["COMPANY_PROFILE", "COMPANY_REGION"],
      "timeoutMs": 10000,
      "maxOutputBytes": 16384,
      "cacheTtlMs": 60000
    }
  }
}
```

## Child runs

`childRuns` controls in-process child sessions created by trusted extensions. Existing extensions remain compatible: their per-call `maxSteps`, `timeoutMs`, and `outputLimitBytes` requests still work when they are no larger than the active operator maxima. Omitted values use the configured defaults.

```jsonc
{
  "childRuns": {
    "maxConcurrent": 4,
    "defaultMaxSteps": 32,
    "maxSteps": 64,
    "defaultTimeoutMs": 600000,
    "maxTimeoutMs": 600000,
    "defaultOutputLimitBytes": 65536,
    "maxOutputLimitBytes": 1048576
  }
}
```

Defaults must not exceed their corresponding maxima. Rigyn also enforces compiled safety ceilings of 16 concurrent children, 256 model steps, a 3,600,000 millisecond timeout, and 8,388,608 returned bytes. These absolute guardrails are not configuration defaults and cannot be raised. An active child does not accept steering or follow-up turns, so the step limit bounds the entire child operation rather than each queued turn. Nested child delegation remains disabled across persistence and restart: a parent may run bounded sibling children, but a child cannot recursively create another child. Changes apply to subsequent child runs after `/reload`; reload remains unavailable while any parent or child run is active.

## External tool execution boundary

`executionBackend` routes only its declared model tools through one fixed executable and JSON protocol. The executable and host working directory must already exist and be absolute. The backend receives no inherited process environment. Its `workspace` is the path visible inside the remote host, container, VM, or sandbox—not a claim that Rigyn created isolation.

```jsonc
{
  "executionBackend": {
    "id": "workspace-vm",
    "argv": ["/usr/bin/bwrap", "--ro-bind", "/usr", "/usr", "--", "/opt/rigyn/bin/tool-worker"],
    "cwd": "/var/empty",
    "workspace": "/workspace",
    "tools": { "read": "read", "grep": "read", "find": "read", "ls": "read", "write": "write", "edit": "write", "bash": "write" },
    "timeoutMs": 600000,
    "outputLimitBytes": 2097152
  }
}
```

The command must implement the versioned protocol documented in [External execution backends](execution-backends.md). Once a tool is claimed, startup or execution errors are returned as visible tool failures and never retry on the host. Trusted runtime extension JavaScript and explicit `api.exec` calls are still ordinary host processes; route model tools through a real OS/container/remote boundary and review extension code separately.

## Model metadata

Explicit model entries are useful for private deployments or endpoints that cannot list models:

```jsonc
{
  "models": [
    {
      "provider": "company",
      "id": "code-model",
      "displayName": "Company Code Model",
      "contextTokens": 131072,
      "maxOutputTokens": 16384,
      "tools": true,
      "reasoning": true,
      "images": false,
      "reasoningEfforts": ["off", "low", "medium", "high"],
      "headers": { "x-tenant": "engineering" },
      "reasoningEffortMap": { "low": "lite", "medium": "standard", "high": "intense" },
      "requestCompatibility": {
        "maxTokensField": "max_tokens",
        "reasoningFormat": "chat-template",
        "chatTemplateParameters": {
          "enable_thinking": { "$var": "thinking.enabled" },
          "reasoning_level": { "$var": "thinking.effort", "omitWhenOff": true }
        },
        "cacheControlFormat": "anthropic",
        "cacheControlTtl": "1h",
        "sendSessionAffinityHeaders": true,
        "sessionAffinityFormat": "openai-nosession"
      },
      "pricing": {
        "input": 1.25,
        "output": 10,
        "cacheRead": 0.125,
        "cacheWrite": 1.5625,
        "cacheWrite5m": 1.5625,
        "cacheWrite1h": 2.5,
        "validUntil": "2027-01-01T00:00:00.000Z",
        "tiers": [
          {
            "name": "long-context",
            "minimumInputTokens": 200001,
            "input": 2.5,
            "output": 15
          }
        ]
      }
    }
  ]
}
```

Pricing values are USD per million tokens. Tiers replace only the listed rates when the normalized input volume falls inside their inclusive bounds. `cacheWrite5m` and `cacheWrite1h` preserve providers whose cache lifetime changes the write price. `validUntil` is exclusive; expired promotional pricing becomes unknown instead of silently under-reporting cost. Every optional capability remains unknown when omitted; the harness does not invent support.

Model request compatibility is exact-ID metadata for Chat Completions endpoints. It is never inferred from a model name. `headers` accepts bounded non-secret headers such as tenant or routing labels; authorization, API-key, cookie, credential, and transport-control headers are rejected because authentication remains in the credential broker. `reasoningEffortMap` maps Rigyn's canonical levels to provider strings, while `null` removes a level from model selection. When `reasoningEfforts` is also present, a listed level cannot map to `null`.

`requestCompatibility` supports these bounded wire differences:

- `supportsUsageInStreaming`, `maxTokensField`, and `supportsReasoningEffort` override specific request fields.
- `reasoningFormat` selects `openai`, `openrouter`, `deepseek`, `together`, `zai`, `qwen`, `qwen-chat-template`, `chat-template`, `string-thinking`, or `ant-ling` serialization. `chat-template` requires `chatTemplateParameters`; `$var` values resolve from the selected reasoning state without arbitrary body mutation.
- `cacheControlFormat: "anthropic"` marks the first instruction, last tool, and last user/assistant text. `cacheControlTtl` is `5m` or `1h`.
- `sendSessionAffinityHeaders` enables an explicit `openai`, `openai-nosession`, or `openrouter` header format. Unsafe or overlong session IDs are replaced by a stable digest before becoming headers.
- `openRouterRouting` accepts the provider-selection fields documented by OpenRouter. `vercelGatewayRouting` accepts `only` and `order`. A model cannot configure both routing dialects.

These settings are injected after extension request reducers and are not copied into model catalogs, session events, telemetry, or prompt metadata. Existing provider profiles keep their current behavior when no exact model override is present.

## Network transport

```jsonc
{
  "httpTransport": {
    "proxy": {
      "http": "http://proxy.example:8080",
      "https": "http://proxy.example:8080",
      "all": false,
      "noProxy": "localhost,127.0.0.1,.internal.example"
    },
    "connectTimeoutMs": 10000,
    "headersTimeoutMs": 300000,
    "bodyTimeoutMs": 300000
  }
}
```

Proxy values may be URLs or `false`. Proxy credentials are not written to logs. Standard proxy environment variables are also respected by the transport layer.

## Keybindings

Run `/hotkeys` to see the active map. Overrides use action IDs in `keybindings.json`:

```json
{
  "app.model.select": ["ctrl+l", "ctrl+q"],
  "tui.input.newLine": ["shift+enter", "ctrl+j"]
}
```

Invalid bindings are reported and the built-in map remains available. Conflicting bindings remain active but produce a startup warning naming the affected input scope and actions, so intentional overlaps are possible without hiding unreachable actions.
Use an empty array to unbind an action. Conflicts are checked within the editor, generic selector, session selector, model-scope selector, and tree selector independently, so the same key may safely serve different overlays.

Application actions include `app.suspend`, `app.session.new`, `app.session.tree`, `app.session.fork`, `app.session.resume`, and all scoped-model save/all/clear/provider controls. Run `/hotkeys` for the active editor bindings; selector overlays show their own active bindings inline.

## Instructions and trust

Instructions load in deterministic order:

1. the user-level `AGENTS.md`;
2. from the filesystem root toward the current directory, the first existing file in this order for each directory: `AGENTS.override.md`, `AGENTS.md`, then `CLAUDE.md`.

Only one instruction file loads from each directory. An override wins over a normal instruction file, and `AGENTS.md` wins over the compatibility `CLAUDE.md` fallback in that same directory. `--no-context-files` disables automatic discovery for one invocation.

For operating-prompt files, a trusted project `.rigyn/SYSTEM.md` or `.rigyn/APPEND_SYSTEM.md` takes precedence over the corresponding user-level file. User-level files remain available in untrusted workspaces; project files do not. An explicit `--system-prompt` replaces automatic `SYSTEM.md` selection, while explicit append prompts follow the selected automatic append file.

Project trust gates project configuration and executable project resources. The startup chooser can remember trust or distrust for the exact workspace, trust its parent recursively, or make either decision for only the current launch. Saved exact decisions override inherited parent trust. Existing positive-only trust files are read safely and upgraded when the next decision is written.

`defaultProjectTrust` is read only from the global configuration. `ask` opens the chooser when an undecided interactive workspace contains protected resources; `always` enables those resources for that launch; `never` keeps them disabled. Neither `always` nor `never` writes a workspace decision. `/settings` persists this global default for the next launch. Use `/trust` to save trust from an active session, `--approve` to trust for one invocation, or `--no-approve` to ignore project-local resources for one invocation. Project trust is not a per-tool permission system.
