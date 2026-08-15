# rigyn

**Rig your agent. Own the runtime.**

rigyn is an open, local-first agent harness for people who want control over how their agent works. Its lean core
provides an extensible agent runtime, bounded coding tools, persistent sessions, multiple host surfaces, and a trusted
extension system designed to be built on. Start it in a
project, drive it through the terminal, JSON, RPC, HTTP, or SSE, embed it through the Node.js API, or build a different
agent experience on the same runtime.

Instead of putting every possible workflow into core, rigyn supplies the foundation for the agent you want. Skills and
prompt templates add reusable guidance; trusted extensions can add tools, commands, providers, authentication methods,
durable state, events, and structural UI. **rigyn is not the finished agent. It is the harness you build yours with.**

"Local-first" describes where the runtime, tools, configuration, credentials, and append-only session files live.
Requests still go to the provider you select unless you use a local provider. `bash` and runtime extensions run with
your operating-system user privileges. Built-in local shell execution drops accidentally inherited common
credential-shaped environment entries and authenticated URLs while retaining ordinary build environment such as
`PATH`. This is not an isolation boundary, and trusted extensions can deliberately add environment entries, so review
installed code.

This repository implements the agent loop, canonical provider mappings, normalized events, and subscription
transports. Exact-pinned official SDKs act only as transport adapters for supported protocols. Those adapters cover
OpenAI and compatible routes, Anthropic API-key calls, and Google Gemini.
Provider-specific OAuth, subscription, and local transports that do not use those SDKs stay within rigyn. Other
dependencies provide HTTP transport, image conversion, YAML parsing, ignore matching, and the bundled ripgrep
executable.

The project is pre-1.0. Standalone archives include the pinned runtime and are the default installation path.
Building from source requires Node.js 26.7.0 or newer.

New here? Follow the [five-minute getting-started guide](docs/getting-started.md), read the
[architecture guide](docs/ARCHITECTURE.md), or use the [documentation map](docs/README.md) to find a specific topic.
Focused references cover the [CLI](docs/cli-reference.md), [keybindings](docs/keybindings.md), and
[terminal setup](docs/terminal-setup.md).

## Install

Use the one-line installer for your platform. It detects x64 or arm64, downloads only the matching standalone archive
from the latest GitHub release, verifies its SHA-256 digest, validates every archive path, and atomically installs a
per-user launcher.

Linux or macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/rigyn/rigyn/v0.1.0/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/rigyn/rigyn/v0.1.0/install.ps1 | iex
```

Neither command needs Node.js, npm, an npm account, or the npm registry. Linux and macOS need `curl`, `tar`, and a
SHA-256 utility. Current Windows includes the required PowerShell and `tar.exe`.

For a portable copy, download the standalone archive matching your platform from the
[v0.1.0 GitHub release](https://github.com/rigyn/rigyn/releases/tag/v0.1.0), verify it against `SHA256SUMS`, and
extract it. The archive includes its own Node.js runtime and complete production dependency graph. Run `bin/rigyn`
on Linux or macOS and `bin\rigyn.cmd` on Windows.

To remove a portable copy, close its processes and delete the extracted archive directory. The managed
`rigyn uninstall --yes` command does not claim or delete an arbitrary portable directory; portable user state remains
under `~/.rigyn` until you intentionally remove or reuse it.

From the public source checkout today:

```sh
git clone https://github.com/rigyn/rigyn.git
cd rigyn
npm run install:user
rigyn
```

On macOS and Windows, a source install compiles and verifies the matching native helpers before packaging the private
installation. On macOS, put `cc` and `swiftc` on `PATH`, normally through the Xcode Command Line Tools. On Windows,
use an architecture-matching MSVC developer shell with `cl` on `PATH`. Linux source installs do not compile native
helpers.

By default, `$HOME/.rigyn` is the runtime and state root for the one-line installation: versioned runtimes
live in `runtime`, the launcher in `bin`, and configuration, credentials, sessions, logs, diagnostics, crash reports, and resources live directly
under the same root. On Linux and macOS, the installer also maintains
one managed command symlink at `$HOME/.local/bin/rigyn` that points to `$HOME/.rigyn/bin/rigyn`. Windows runs
`$HOME\.rigyn\bin\rigyn.cmd` directly.

The installer creates an empty, user-owned
`$HOME/.rigyn/AGENTS.md` and an editable `config.json` when they are
missing. An update never overwrites them. By default, configuration,
credentials, sessions, and cache remain under
`$HOME/.rigyn`. Ordinary updates under `$HOME/.rigyn/runtime` retain other version directories. The installer does not use npm, link execution to the source
checkout, change the workspace, or edit shell startup files.

Installing does not require `npm install` in the source checkout. For development only, run `npm install`, `npm run check`, and `npm run dev --workspace rigyn --` from the checkout.

Update a standalone installation by rerunning the same one-line installer. `rigyn self-update` detects a standalone
runtime and prints that exact verified command instead of silently switching distribution formats. Old version
directories are retained so an operator can inspect or remove them after the new launcher works.

A source-built private installation keeps its marker-verified lifecycle commands:

```sh
rigyn self-update
rigyn uninstall --yes
```

The uninstall command fully purges either installation form and its managed state; see
[installation and platform troubleshooting](docs/install.md). Removal is ownership-verified and never
deletes the source checkout or unrelated workspaces.

See [installation and platform troubleshooting](docs/install.md) for Linux, macOS, Windows, WSL, Termux, tmux, command-path, OAuth-browser, and native-dependency guidance.

## First run

Change to the project you want rigyn to work on and start the interface:

```sh
cd /path/to/your/project
rigyn
```

```text
/login
/model
```

The directory where you launch rigyn is the workspace unless you pass `--workspace DIR`. The installed command works
from any directory and does not redirect execution to the source checkout. Workspace scope controls project
instructions, trusted project resources, tool working directories, and the default session list. It is not a
filesystem sandbox.

`/login` offers only methods supported by the selected provider. These may include browser or device account login,
an environment credential, an API key, a cloud identity, or a local connection. Native account flows are available
for ChatGPT/Codex, Anthropic, GitHub Copilot, Kimi Code, xAI, and OpenRouter; see the provider guide for protocol,
billing, and client-registration details. The five `RIGYN_*_OAUTH_CLIENT_ID` settings override the bundled public-client IDs.

The CLI prefers the current user's Linux Secret Service when it passes a non-destructive write/read/delete probe. On
Windows it encrypts the credential file with a random key protected by current-user DPAPI. On macOS it uses Keychain
Services through a packaged Security-framework helper whose bounded protocol carries secrets only on standard input
and output, never in process arguments or environment variables. Initial setup falls back to the owner-only, atomically
written `auth.json` store when a stronger platform backend cannot be created. Once migration starts, a durable
nonsecret marker pins that agent directory to its stronger backend so a later outage fails closed instead of creating
a second plaintext store. Plaintext is removed only after every credential has been copied to and verified in the
stronger backend.

The model picker refreshes connected provider catalogs. It hides disconnected, cached-only, and configured-only
choices instead of showing a static universal list. For a provider without a listing endpoint, select an exact
configured deployment with `/model PROVIDER/MODEL` or `--model PROVIDER/MODEL`.

You can also run a single prompt and exit:

```sh
rigyn -p "Read this repository and explain its architecture"
rigyn --model PROVIDER/MODEL:high -p "Fix the failing tests"
rigyn -p @issue.md "Implement this issue"
```

Files beginning with `@` are included as prompt references. In the TUI, typing `@` opens workspace file completion.
Supported images can be pasted or attached. rigyn resizes and normalizes them before provider submission.

## Terminal workflow

The default coding tools are:

- `read` — read text or supported images with bounded continuation;
- `bash` (`$` in live TUI activity) — execute a command in the active workspace with streamed, bounded output;
- `edit` — apply one or more exact replacements atomically;
- `write` — create or replace a file, including missing parent directories;
- `grep` — search file contents with bounded output;
- `find` — find workspace paths by name or pattern;
- `ls` — list directory entries with bounded metadata.

All seven built-ins are active by default in interactive, print, JSON, RPC, serve, and direct SDK sessions. For
interactive, print, JSON, and RPC invocations, use `--tools` as an allowlist, `--exclude-tools` to remove selected
names, `--no-builtin-tools` to retain only extension tools, or `--no-tools` to disable every tool. Serve sessions use
the persisted tool policy; SDK callers use their session options. For example, this read-only invocation narrows the
active set:

```sh
rigyn --tools read,grep,find,ls -p "Review the source tree"
```

Absolute paths work when a task spans outside the starting directory. Commands and tools run with the invoking user's
normal operating-system access. The default CLI does not install a per-command approval dialog; SDK and embedding
hosts can supply a host-owned one-shot tool authorization handler. Project trust applies only to executable
project-local configuration and extensions. Model-invoked `bash` receives current non-secret `RIGYN_*` session
identity after inherited credentials and stale session metadata are removed. User-entered `!` and `!!` commands do
not receive that session identity.

Useful interactive commands are:

```text
/help                     /settings                   /model [PROVIDER/MODEL]
/thinking [LEVEL]         /scoped-models              /login [PROVIDER]
/logout [PROVIDER]        /new                       /resume [--all|SESSION]
/session                  /context                   /resources
/name [NAME]              /fork                      /clone [NAME]
/tree
/compact [INSTRUCTIONS]   /refresh
/recover [abandon EFFECT_ID]
/export [--redact] [FILE] /share                     /import <FILE>
/copy                     /hotkeys
/changelog                /trust                     /quit
```

Type `/` to open the command palette. `! command` runs a user shell command and adds its bounded result to the
session and model context; `!! command` runs it without adding the result to model context. During an active response,
normal submissions steer the current run. The follow-up shortcut queues work for the next turn. Each queue can
deliver one message at a time or all messages at once. Interactive `!` and `!!`
commands have a fixed ten-minute execution limit; SDK shell calls are unbounded
unless `timeoutMs` is provided.

`/clear` is a hidden alias for `/new`. Both start a new session with empty conversation and queues while retaining
the selected model and reasoning level. The previous durable session remains available through `/resume`; neither
command merely erases terminal rows or rewrites earlier history.

The interface includes the monochrome `mono` theme and the operational `signal` theme. User and trusted-project
custom themes remain selectable. `signal` separates reasoning, active tools, outcomes, warnings, diffs, selections,
and status while keeping the same text and structural cues.

The rich viewport updates answer, boxed visible reasoning blocks, and one stable card per tool call as events arrive.
Tool rows move through pending, running, progress, completed, failed, and in-doubt states. A collapsed active Write card
keeps its target and newest source rows visible and offers `Ctrl+O` when earlier bounded source is retained; expansion
shows the retained head and tail immediately. A collapsed active Edit card stays on its semantic target/status header,
while expansion shows only complete old/new replacement pairs already available in its bounded preview. Raw or
incomplete argument JSON is never rendered. Completed Write cards show the first three bounded source rows and a
truthful `Ctrl+O` affordance when more is retained, or remain summary-only when no source is available. Completed Edit
cards retain a bounded diff, and every expanded tool detail remains bounded.
Automatic line and accessibility fallbacks render the same lifecycle as bounded append-only text. The interface also shows retry,
compaction, token, cache, and cost status and supports model and thinking-level cycling, session switching, transcript
scrolling, an external editor, completion, clipboard paste, queued-input recovery, and configurable keybindings.
Its two-row status dock keeps live phase, elapsed time, retry, and cancel state separate from the grouped model, thinking,
context, token, cache, and cost telemetry. Complete low-priority fields disappear cleanly when the terminal is narrow.

`Ctrl+T` expands or collapses visible reasoning. `Shift+Tab` cycles levels supported by the selected model.
Model and reasoning controls remain available during an active response. Each accepted operation keeps its original tuple; a new selection applies atomically to the next accepted operation, including a queued follow-up, without changing or relabeling the provider request already in flight. An explicitly installed low-level `agent.prepareNextTurn` hook is the deliberate exception: it may select the tuple for a later provider turn inside that operation.
`Ctrl+Z` undoes one editor transaction. Process suspension remains a remappable action. Press `Ctrl+C` twice to exit.
Double-Escape on an empty editor follows `doubleEscapeAction`. Run `/hotkeys` to see the active bindings.

## Sessions and continuity

Sessions are saved automatically as strict append-only V4 JSONL journals and
scoped to the current workspace. They record conversation nodes, selected
state, accepted runs, durable queues, checkpoints, tool-effect recovery,
provider continuation state, usage, branches, and compaction summaries.

```sh
rigyn --continue                 # latest session in this workspace
rigyn --resume                   # interactive session picker
rigyn --session PARTIAL_ID       # exact or unambiguous partial ID
rigyn --fork SESSION             # independent continuation
rigyn --no-session               # ephemeral conversation
```

`/tree` can move to an earlier node and optionally summarize the abandoned
branch. `/clone` creates a new durable session. Commits append immutable nodes
and move the selected head, so switching branches never rewrites history. On
reopen, rigyn ignores an unterminated tail and rejects invalid committed
records.

Interactive, print, JSON, and serve modes attempt safe recovery before they accept
new work. An uncertain tool effect blocks the session instead of being repeated
without proof. In the TUI, typing `/recover` retries safe recovery and then
records any remaining blocked effects as abandoned without replay;
`/recover abandon EFFECT_ID` keeps one-effect control. RPC
and SDK hosts can inspect the suspended run and submit the same recovery
decision through their public APIs. The authenticated serve resource and the
narrow embedding facade expose equivalent explicit recovery without inferring
an outcome after restart.

See [Sessions and context](docs/sessions.md), the [session JSONL format](docs/session-jsonl.md), the [session export contract](docs/session-export.md), and [context compaction](docs/compaction.md) for the durable storage and budgeting model.

## Context, compaction, and token savings

Every request is projected for the selected provider while preserving complete tool-call/result groups. The context
budget uses live model metadata when available and a conservative 128,000-token execution fallback otherwise; that
fallback does not fabricate or display model metadata. The default policy reserves
15% of the context window for output, then also respects any independent provider-published maximum input ceiling,
and aims to keep 20% of the resulting trigger as recent history. The summary
target is 5% of the context window, clamped from 1,024 through 8,192 tokens. If no safe token boundary exists, it
falls back to two complete recent turns. Normal provider requests keep complete projected tool results. Only the
temporary input used to create a compaction summary bounds old tool-result text. Older complete history can be
replaced by a durable summary; stored JSONL remains unchanged.

An explicit output-token request is clamped to the selected model's reviewed or live ceiling. Completed normal and
summary responses are checked against that effective ceiling: positive provider usage is authoritative, while zero
or missing usage uses conservative text, reasoning, and tool-argument estimation. Unknown output ceilings stay
unknown rather than being guessed.

An explicit context-window override cannot bypass an independent reviewed or live maximum input ceiling. Provider
and extension model declarations carry that ceiling separately from the total context window and output maximum.

Automatic compaction is on by default and can also be triggered with `/compact`. A final projection that grows after system or extension processing, or a provider-reported context overflow, can force one safe compaction retry even when an earlier local token estimate was low. Repeated overflow on the unchanged context fails; successful provider or tool progress permits a later independent recovery.

Provider caching is used where the protocol supports it:

- OpenAI and ChatGPT subscription requests keep a stable session cache key and report cached-token usage;
- Anthropic places explicit cache breakpoints on stable system, tool, and recent message prefixes, with configurable `5m` or `1h` TTL;
- OpenRouter supports explicit cache points when enabled;
- Gemini and compatible providers preserve and report provider-managed cache usage when available.

Caching reduces repeated-input billing and latency; compaction reduces the amount of history that must remain in each request. They are complementary rather than interchangeable.

## Providers

The built-in model picker contains exactly 12 provider identities: OpenAI Codex, OpenAI, Anthropic, Google,
OpenRouter, GitHub Copilot, xAI, DeepSeek, Kimi Code, Ollama, OpenCode Zen, and OpenCode Go. Google is the public identity
for the runtime's Gemini adapter. OpenCode Zen routes explicit model metadata across Messages, Generate Content,
Chat Completions, and Responses. OpenCode Go has a separate credential identity, uses reviewed per-model Messages,
Chat Completions, or Responses routes, and filters those routes through its authenticated model listing. xAI uses
Responses. Ollama discovers local models without a key.

Trusted extensions and SDK hosts can register other services through the generic provider and protocol APIs. Those
registrations do not become default providers or add environment variables to the built-in credential map.

Common environment variables are recognized automatically:

```text
OPENAI_API_KEY             ANTHROPIC_API_KEY
ANTHROPIC_AUTH_TOKEN       ANTHROPIC_OAUTH_TOKEN
GEMINI_API_KEY             OPENROUTER_API_KEY
COPILOT_GITHUB_TOKEN       XAI_API_KEY
DEEPSEEK_API_KEY           KIMI_CODE_API_KEY
OLLAMA_API_KEY
OPENCODE_API_KEY           OPENCODE_GO_API_KEY
RIGYN_OPENAI_CODEX_OAUTH_CLIENT_ID
RIGYN_ANTHROPIC_OAUTH_CLIENT_ID
RIGYN_GITHUB_COPILOT_OAUTH_CLIENT_ID
RIGYN_KIMI_CODE_OAUTH_CLIENT_ID
RIGYN_XAI_OAUTH_CLIENT_ID
```

For authentication behavior, provider-specific configuration, custom OAuth registrations, and OpenAI-compatible endpoints, see [Providers](docs/providers.md). Kimi Code model and cache behavior is detailed in [Kimi Code](docs/kimi-code.md). The independent [`rigyn/images` API](docs/image-generation.md) provides brokered one-shot image generation and a separate image-model catalog without placing image-only routes in the chat picker.

## Extensions, skills, prompts, themes, and packages

Resources may be loaded from user scope, a trusted project's `.rigyn` directory, an explicit CLI path, or an installed package.

```sh
rigyn install ./my-package
rigyn install npm:@scope/my-package
rigyn install git:https://example.com/owner/repository.git
rigyn install ssh://git@example.com/owner/private-repository.git#v1
rigyn --extension ./my-package/extensions/index.mjs -p "Try this extension without installing it"
rigyn list
rigyn config
rigyn update --all
rigyn remove SOURCE
```

An extension package can contribute:

- runtime tools, slash commands, shortcuts, typed flags, providers, auth methods, tool renderers, and lifecycle listeners;
- durable extension-owned session state and transcript entries with structural renderers;
- progressively disclosed Agent Skills;
- prompt templates with positional arguments and defaults;
- terminal themes.

Runtime extensions are trusted local code with the same Node.js and operating-system access as the harness.
Project-local executable resources are ignored until the workspace is trusted. Declarative user resources do not
trigger repeated prompts.

Trusted direct extensions integrate external protocols; there is no core catch-all configuration file. The
[subprocess worker example](examples/subprocess-workers/README.md) runs specialized rigyn children concurrently. It
demonstrates structured output validation, recursion prevention, timeouts, cancellation, bounded aggregation, and
failure isolation.

Managed packages support production dependencies, with lifecycle scripts disabled by default. A reviewed install or
update may enable them for that transaction with `--allow-scripts`; source-package prepare and pack scripts remain
disabled. The package manager enforces immutable npm or Git pins, source provenance, SSH-agent authentication, and
private per-package module trees.

Authoring tools report optional `engines.rigyn` metadata, but the loader does not use it as an activation gate. Test
the packed package against each supported host release. See the package guide for the `rigyn` `package.json`
convention and configurable npm or Git wrapper arguments.

Start with [Extensions](docs/extensions.md), [package authoring and the focused examples](docs/packages.md), the [public discovery index](docs/package-gallery.md), the [extension TUI contract](docs/tui.md), the minimal [starter package](examples/starter/README.md), and the trusted [raw editor example](examples/raw-editor-ui/README.md). Declarative authoring has standalone guides for [prompt templates](docs/prompt-templates.md), [skills](docs/skills.md), and [themes](docs/themes.md).

For rigyn configuration, extension authoring, source maintenance, general project development, diagnostics, and release work, enter
`/skill:rigyn-dev <request>`. The single bundled development skill routes to version-matched installed docs and
declarations or to the active project's checked-in workflow. It never invents build commands or deployment authority.
Its extension workflow selects a focused example, defines a visible acceptance contract, and verifies the package
through its real install and `/refresh` path.

## Configuration

Persistent settings use one strict JSON document:

```text
~/.rigyn/config.json              normal installation
$RIGYN_HOME/config.json           custom Rigyn home
WORKSPACE/.rigyn/config.json      trusted project overrides
```

The installer creates a portable, non-null global baseline when the settings file is missing. It exposes safe,
stable defaults people commonly edit while leaving environment-, provider-, model-, and path-derived values omitted.
Missing keys inherit their runtime defaults; existing explicit `null` values remain compatible but are not generated.
Global settings load first. A trusted project's settings then override nested objects recursively; arrays and scalar
values replace earlier values. A new project file starts with only `$schema`, so merely opening it cannot override the
global baseline.

The packaged baseline points editors to the versioned
[`config-v1.json`](resources/schemas/config-v1.json) schema. `$schema` is metadata only. Editors can flag unknown
core keys, while the runtime preserves unknown extension-owned fields for forward compatibility.

The schema documents persistent tool policy and the keybinding object; the keybinding guide lists the stable action
names. Invalid JSON is reported without replacing the last valid in-memory values. Credential state remains in the
selected platform backend or private auth file, sessions remain JSONL files, and provider or model declarations
belong to the model registry or trusted extensions.

Project settings are neither read nor writable before trust. The active Rigyn home always remains user scope, even
when the current workspace would give its `.rigyn` directory the same path. In that case, project-scoped config
commands and `/trust` report that project scope is unavailable instead of writing user-scope state. The global-only
`defaultProjectTrust` setting accepts `ask`, `always`, or `never`; `--approve` and `--no-approve` remain invocation-only
overrides. The interactive `ask` selector starts with project resources disabled for the current launch.

The self-contained installer creates an empty, user-owned
`~/.rigyn/AGENTS.md` when it is missing and preserves it on updates.
Personal agent instructions belong there, or in
`$RIGYN_HOME/AGENTS.md` when that directory is overridden. Project
instructions belong in `AGENTS.md` files along the path to the active working
directory. rigyn appends the global file first and project files from the
outermost ancestor to the working directory, so more specific instructions
appear later. `/refresh` rereads them.

Example:

```json
{
  "defaultProvider": "openai-codex",
  "defaultModel": "MODEL_ID",
  "defaultThinkingLevel": "high",
  "compaction": {
    "enabled": true,
    "triggerPercent": 85
  }
}
```

`rigyn config` selects enabled resources from installed packages. `rigyn config path` prints the exact user settings
path, `rigyn config edit` opens it through the configured external editor, and `rigyn config validate` checks every
known setting without changing either file. Add `--scope project` for `WORKSPACE/.rigyn/config.json`; editing or
validating that scope requires project trust. Edits validate every known setting while preserving unknown fields,
then commit under the settings lock only if the file did not change while the editor was open. The complete settings
contract and resource paths are in [Configuration](docs/configuration.md), with the installed global baseline at
[`resources/config.example.json`](resources/config.example.json) and the complete editor contract in the schema.

## Automation and embedding

`rigyn --mode text` prints the final response for a one-shot run; `-p` is its shortcut. `rigyn --mode json` emits normalized events.
`rigyn --mode rpc` starts newline-delimited JSON RPC over standard input and output. `rigyn serve` starts an
authenticated loopback HTTP and SSE service over the same session runtime. One-shot prompts may invoke
installed runtime commands, declarative commands, prompt templates, and skills with the same slash forms used in
chat. The package also exports provider-neutral service, event, provider, tool, extension, storage, context, and TUI
contracts for embedding.

For an in-process Node.js integration, `rigyn/embedding` owns cancellation, refresh, and cleanup while keeping
credential and provider-registry authority private. `rigyn/sdk` composes one direct `AgentSession` from
caller-selected providers, tools, extensions, resources, settings, and storage.

`rigyn/modes` exposes adapters with separate ownership rules. Print mode disposes the runtime it receives.
Interactive mode borrows a runtime and owns its terminal. RPC mode accepts and owns an existing
`AgentSessionRuntime`. Configured embedding uses the CLI `loadRuntime` composition. The zero-argument SDK creates a
standalone `ModelRuntime` backed by `auth.json` and `model-providers.json`; it does not install the CLI
`ProviderAuthRegistry` or its OAuth registrations. Callers can instead pass a `ModelRuntime`. When no
saved/configured/scoped model selects otherwise, the SDK chooses stable `gpt-5.6-sol`:

```js
import { createEmbeddingHarness } from "rigyn/embedding";

const harness = await createEmbeddingHarness({ workspace: process.cwd() });
try {
  const model = await harness.session.resolveModel("YOUR_MODEL", {
    provider: "YOUR_PROVIDER",
  });
  await harness.session.setModel(model);

  const unsubscribe = harness.session.subscribe(({ event }) => {
    if (event.type === "text_delta") process.stdout.write(event.text);
  });
  await harness.session.run({
    prompt: "Inspect this project and report the test command",
  });
  await harness.session.run({
    prompt: "Now run that test command",
  });
  unsubscribe();
} finally {
  await harness.close();
}
```

The packaged [`examples/embedding-runtime.mjs`](examples/embedding-runtime.mjs) provides the same configured
lifecycle as a runnable file. From the repository root, run
`node packages/rigyn/examples/embedding-runtime.mjs <provider> <model> <prompt>`.
[`examples/embedding-in-memory.mjs`](examples/embedding-in-memory.mjs) demonstrates the credential-free test preset,
and [`examples/embedding-cancellation.mjs`](examples/embedding-cancellation.mjs) demonstrates bounded cancellation.

Call `harness.session.start()` instead of `run()` when you need an immediate handle with `sessionId`, `result`,
`abort()`, and `cancelRetry()`. Advanced hosts can use the root `createHarnessRuntime()` when they need direct
`AgentSession`, `SessionManager`, prompt-handle, event, model-selection, and refresh access.
After cancellation, embedding hosts can inspect `harness.session.suspendedRun`
and call `recoverInterruptedRun()`; no embedding lifecycle method implicitly
abandons an uncertain tool effect.

Existing layers are available as explicit ESM subpaths under `rigyn/<layer>`. The layer may be `auth`, `config`,
`context`, `core`, `embedding`, `extensions`, `images`, `interfaces`, `modes`, `net`, `process`, `prompts`,
`providers`, `sdk`, `service`, `serve`, `storage`, `testing`, `tools`, or `tui`. Each subpath resolves to built JavaScript and
TypeScript declarations. Consumers can depend on one layer without importing the root barrel.

The supported entry points and compatibility rules are defined in the [public Node.js API policy](docs/public-api.md). Mode ownership and examples are in [In-process modes](docs/modes.md). Paths inside `dist/` are not public imports.

All package entry points require Node.js 26.7.0 or newer. No root or subpath is
browser-safe, including entry points that contain provider-neutral types. A browser interface should talk to a
trusted local Node process over RPC, the authenticated loopback service through a same-origin bridge, or a private
localhost extension bridge. Browser code should not bundle harness
modules directly.

```sh
rigyn --mode rpc
rigyn --mode json "Inspect package.json"
RIGYN_SERVE_TOKEN="YOUR_LONG_RANDOM_TOKEN_AT_LEAST_32_CHARS" rigyn serve
rigyn --export session.jsonl conversation.html
```

RPC is strict LF-delimited command JSON over standard input and output. Commands use a `type` and optional string
`id`. Responses use `type: "response"`, preserve the ID, and include the command name. Agent events stream as raw
records. Node.js clients can use the typed `RpcClient` export from `rigyn/interfaces`. See
[RPC protocol and typed client](docs/rpc.md) for commands, sessions, events, cancellation, and extension UI.

```jsonl
{"id":"req_1","type":"get_state"}
{"id":"req_2","type":"set_model","provider":"YOUR_PROVIDER","modelId":"YOUR_MODEL"}
{"id":"req_3","type":"prompt","message":"Inspect package.json"}
{"id":"req_4","type":"get_session_stats"}
```

Prompt acknowledgement is emitted after preflight succeeds; raw agent events then report progress and completion. Request handling may overlap, so correlate responses by their string IDs rather than output order.

The local service creates or opens sessions, accepts prompts, cancels work,
reads state, exposes explicit interrupted-run recovery, and streams the same
public event envelopes through SSE. It binds to
`127.0.0.1:4317` by default, and the CLI accepts loopback hosts only. It has no
WebSocket, CORS, public multi-tenant
policy, or SQLite backend. See [HTTP and SSE service](docs/serve.md).

## Development

```sh
npm install
npm run typecheck
npm run typecheck:test --workspace rigyn
npm test
npm run benchmark:offline --workspace rigyn
npm run benchmark:extensions --workspace rigyn
npm run benchmark:runtime --workspace rigyn
npm run test:coverage:risk
npm run build
npm run check
```

`npm run check` type-checks source and tests, runs the full unit and PTY suite, builds distributable JavaScript and
declarations, compiles an external consumer, and tests the built package. It also installs a packed artifact into an
isolated home for an offline end-to-end run.

`npm run benchmark:offline --workspace rigyn` runs a credential-free, deterministic harness corpus through the real
service and tools. Its versioned JSON report tracks completion, pass@1, multi-file and continuation scenarios,
provider or tool recovery, parallel tool batches, mutation preservation, verification, usage and cost, compaction,
and crash recovery. It does not measure model intelligence. See
[Outcome benchmarks](https://github.com/rigyn/rigyn/blob/main/packages/rigyn/benchmarks/README.md) for metric
definitions and limits.

`npm run benchmark:extensions --workspace rigyn` is a second credential-free verifier. It runs extension candidates through managed install, public discovery, activation, refresh, and removal and reports pass@1/pass@3 with zero model calls.

`npm run benchmark:runtime --workspace rigyn` measures eleven deterministic scenarios against generous
freeze-regression ceilings. These cover startup, large-package refresh, small and large session resume, bounded
cold-history paging, and cursor-paged RPC replay.

`npm run test:coverage:risk` aggregates subprocess-aware coverage. It enforces separate line, branch, and function
floors for the extension runtime, CLI, TUI controller, agent session, JSONL session manager, and HTTP/SSE transport. The paid
`npm run benchmark:compare --workspace rigyn` command is opt-in. It gives two CLIs the same model, task files, and
external verifier; it does not claim one harness is better without evidence. See
[Outcome benchmarks](https://github.com/rigyn/rigyn/blob/main/packages/rigyn/benchmarks/README.md).

The high-level component map is in [Architecture](docs/ARCHITECTURE.md). Practical operations are covered by the [cookbook](docs/cookbook.md), [local diagnostics and operational logs](docs/diagnostics.md), [troubleshooting guide](docs/troubleshooting.md), and [platform notes](docs/platforms.md).

Contribution expectations, security reporting, release-visible changes, and the deterministic release procedure are in [CONTRIBUTING.md](https://github.com/rigyn/rigyn/blob/main/CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md), and [docs/releasing.md](docs/releasing.md).

## License

rigyn is released under the [MIT License](LICENSE).
