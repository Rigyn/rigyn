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

`XDG_CONFIG_HOME` and `XDG_STATE_HOME` replace the corresponding roots when set. A trusted project may add `.rigyn/config.jsonc`, `.rigyn/extensions`, `.rigyn/skills`, `.rigyn/prompts`, `.rigyn/themes`, and compatible `.agents/skills`, `.claude/skills`, and `.codex/skills` resources. Compatible project skill discovery is disabled until the workspace is trusted.

Skill roots are evaluated in deterministic order: bundled and native user roots; `~/.agents/skills`, `~/.claude/skills`, and `~/.codex/skills`; extension-contributed roots; trusted project `.rigyn/skills`, `.agents/skills`, `.claude/skills`, and `.codex/skills`; configured `skillRoots`; then invocation-only skill paths. Later roots win collisions. Diagnostics identify the winning and shadowed manifest and root paths so precedence is never silent.

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
| `theme` | string | built-in default | TUI theme name. |
| `thinking` | string | `off` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Unsupported levels are constrained by model metadata. |
| `steeringMode` | string | `one-at-a-time` | Drain steering input `one-at-a-time` or `all`. |
| `followUpMode` | string | `one-at-a-time` | Drain follow-up input `one-at-a-time` or `all`. |
| `doubleEscapeAction` | string | `tree` | Open `tree`, open `fork`, or do `none` when Escape is pressed twice on an empty editor. |
| `defaultProjectTrust` | string | `ask` | Global-only fallback for undecided workspaces: `ask`, `always`, or `never`. `/settings` changes the next-launch behavior. |
| `outboundImages` | string | `allow` | `allow` or `block` image submission to providers. |
| `scopedModels` | string[] | `[]` | Provider/model patterns used by the model cycle keys. A `:thinking` suffix is supported. |
| `databasePath` | string | state directory database | Alternate SQLite session database. |
| `shellPath` | absolute path | platform shell | Shell used by `bash` and `!` shortcuts. |
| `npmCommand` | string[] | platform npm | Executable and fixed argv prefix used for package fetches and production dependencies. |
| `gitCommand` | string[] | `git` | Executable and fixed argv prefix used for package clones and revision checks. |
| `executionBackend` | object | host-local tools | Optional fail-closed external/remote executor for explicitly claimed model tools. |
| `contextTokenBudget` | integer | model metadata | Manual input budget override when applicable. |
| `summaryTokenBudget` | integer | derived | Maximum compaction summary budget. |
| `autoCompaction` | boolean | `true` | Compact safely before context exhaustion. |
| `providerRetry` | object | `{ maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 30000, jitter: 0.2 }` | Bounded retry policy for transient provider failures. `/settings` exposes `maxAttempts`; delay and jitter tuning remain config-only. |
| `compactionRetainRecentTurns` | integer | `2` | Minimum recent complete turns kept verbatim. |
| `compactionToolResultBytes` | integer | `4096` | Maximum retained bytes for each old tool result. |
| `maxSteps` | integer | `64` | Maximum model turns in one run. Configure a larger positive integer for deliberately longer tasks. |
| `childRuns` | object | bounded defaults below | Defaults and operator maxima for in-process `runChild` delegation. |
| `skillRoots` | string[] | `[]` | Additional skill files or directories. |
| `extensionRoots` | string[] | `[]` | Additional extension roots. |
| `packageResources` | object | `{}` | Per-package resource filters written by `rigyn config`. |
| `providers` | object | built-in providers | Provider overrides and custom endpoints. |
| `models` | object[] | maintained/live catalogs | Explicit model metadata. |
| `oauthRegistrations` | object | `{}` | Custom PKCE or device OAuth clients. |
| `httpTransport` | object | `{}` | Proxy and network timeout controls. |

Package-manager command values are argv arrays, not shell command strings. For example, `"npmCommand": ["mise", "exec", "node@24", "--", "npm"]` selects a version-manager wrapper without enabling shell interpolation. On Windows, configure a native executable or an interpreter plus script path; `.cmd` and `.bat` wrappers are rejected because they require shell parsing. Package installation still adds bounded arguments and disables lifecycle scripts by default; `--allow-scripts` is an explicit, per-transaction exception for reviewed production dependencies.

Model-initiated `bash` commands default to a 600-second timeout when the tool call omits `timeout`. A tool call can request a different positive timeout explicitly.

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
2. from workspace root toward the current directory, the first existing file in this order for each directory: `AGENTS.override.md`, `AGENTS.md`, then `CLAUDE.md`.

Only one instruction file loads from each directory. An override wins over a normal instruction file, and `AGENTS.md` wins over the compatibility `CLAUDE.md` fallback in that same directory. `--no-context-files` disables automatic discovery for one invocation.

Project trust gates project configuration and executable project resources. The startup chooser can remember trust or distrust for the exact workspace, trust its parent recursively, or make either decision for only the current launch. Saved exact decisions override inherited parent trust. Existing positive-only trust files are read safely and upgraded when the next decision is written.

`defaultProjectTrust` is read only from the global configuration. `ask` opens the chooser when an undecided interactive workspace contains protected resources; `always` enables those resources for that launch; `never` keeps them disabled. Neither `always` nor `never` writes a workspace decision. `/settings` persists this global default for the next launch. Use `/trust` to save trust from an active session, `--approve` to trust for one invocation, or `--no-approve` to ignore project-local resources for one invocation. Project trust is not a per-tool permission system.
