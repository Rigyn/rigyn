# rigyn

rigyn is a local-first coding agent that runs in your terminal. Start it inside a project, describe an outcome, and the selected model can inspect files, run commands, and apply edits through rigyn's bounded tools. The conversation, tool history, branches, model choice, and extension state are saved locally so work can continue in a later terminal.

rigyn is both an interactive application and an extensible runtime. The same installation supports an interactive terminal workflow, one-shot commands, JSON events, a newline-delimited command protocol, and an in-process Node.js API. Skills add on-demand instructions; prompt templates add reusable tasks; custom themes change presentation; and trusted extension packages can add tools, commands, providers, authentication methods, durable state, and structural UI directly to the active harness.

"Local-first" describes where the runtime, tools, configuration, credentials, and append-only session files live. Requests still go to the model provider you select unless you use a local provider. `bash` and runtime extensions execute with your operating-system user privileges, so rigyn is not an isolation boundary and installed code should be reviewed.

The agent loop, canonical provider mappings, normalized events, and subscription transports are implemented in this repository. Exact-pinned official SDKs act only as transport adapters where a supported protocol uses them, including OpenAI and compatible routes, Anthropic API-key calls, AWS Bedrock, Google Gemini and Vertex, and Mistral. Provider-specific OAuth, subscription, and local transports that do not use those adapters stay within rigyn. Other third-party dependencies provide HTTP transport, image conversion, YAML parsing, ignore matching, and the bundled ripgrep executable.

The project is pre-release. Standalone archives include the pinned runtime. Source and package-archive installations
require Node.js 24.15 or a current Node.js 26-or-newer release.

New here? Follow the [five-minute getting-started guide](docs/getting-started.md), or use the [documentation map](docs/README.md) to find a specific topic. Focused references cover the [CLI](docs/cli-reference.md), [keybindings](docs/keybindings.md), and [terminal setup](docs/terminal-setup.md).

## Install

With a supported Node.js 24.15+ or 26+ runtime and npm installed, use the one-line installer for your platform. It
downloads and verifies the complete package graph from the latest GitHub release before creating a private per-user
copy.

Linux or macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/rigyn/rigyn/main/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/rigyn/rigyn/main/install.ps1 | iex
```

Neither command needs an npm account or resolves a rigyn package from the npm registry. The equivalent version-pinned
manual command is:

```sh
npm exec --yes \
  --package=https://github.com/rigyn/rigyn/releases/download/v0.5.1/rigyn-terminal-0.5.1.tgz \
  --package=https://github.com/rigyn/rigyn/releases/download/v0.5.1/rigyn-models-0.5.1.tgz \
  --package=https://github.com/rigyn/rigyn/releases/download/v0.5.1/rigyn-kernel-0.5.1.tgz \
  --package=https://github.com/rigyn/rigyn/releases/download/v0.5.1/rigyn-0.5.1.tgz \
  -- rigyn self-install
rigyn
```

This uses npm's one-shot package executor with version-pinned GitHub assets; it does not create a global npm
installation or download a rigyn package from the npm registry.

To install without Node.js or npm, download the standalone archive matching your platform from the
[v0.5.1 GitHub release](https://github.com/rigyn/rigyn/releases/tag/v0.5.1), verify it against `SHA256SUMS`, and
extract it. The archive includes its own Node.js runtime and complete production dependency graph. Run `bin/rigyn`
on Linux or macOS and `bin\rigyn.cmd` on Windows.

From the public source checkout today:

```sh
git clone https://github.com/rigyn/rigyn.git
cd rigyn
npm run install:user
rigyn
```

On macOS and Windows, a source install compiles and verifies the matching terminal input helper before packaging the private installation. Put `cc` on `PATH` on macOS (normally through the Xcode Command Line Tools), or run from an architecture-matching MSVC developer shell with `cl` on `PATH` on Windows. Linux source installs do not compile a terminal helper.

The installer creates a self-contained installation under `$HOME/.rigyn`. It copies the required build inputs into installation-owned staging, builds there, and removes the staging copy afterward. It scaffolds editable `agent/AGENTS.md` and `agent/settings.json` files from the packaged templates whenever either file is missing; reinstall and update never overwrite an existing copy. The master source checkout is read-only during installation. The packaged application, production dependencies, executable, configuration, sessions, credentials, cache, and temporary artifacts stay under the installation directory. On Linux and macOS, a tiny managed command launcher at `$HOME/.local/bin/rigyn` makes the private installation available from any directory. The installer does not use npm's global package directory, link the application back to the source checkout, change the current workspace, or edit shell startup files.

Installing does not require `npm install` in the master checkout. For development only, run `npm install`, `npm run check`, and `npm run dev --workspace rigyn --` from the checkout.

Update or remove any self-contained installation from any directory:

```sh
rigyn self-update
rigyn uninstall --yes
```

`self-update` resolves the latest public GitHub release, verifies the complete package graph against that release's
manifest and SHA-256 metadata, and refuses an implicit downgrade. The installer replaces only its marker-owned
application files.

Uninstall is marker-verified and removes the installed application, configuration, OAuth/API-key profiles, sessions, cache, and its managed command. It never deletes the source checkout or unrelated files.

See [installation and platform troubleshooting](docs/install.md) for Linux, macOS, Windows, WSL, Termux, tmux, command-path, OAuth-browser, and native-dependency guidance.

## First run

Change to the project you want rigyn to work on, start the interface, connect a provider, and select one of that provider's currently available models:

```sh
cd /path/to/your/project
rigyn
```

```text
/login
/model
```

The directory where you launch rigyn is the workspace unless you pass `--workspace DIR`. The self-contained command works from any directory and does not redirect execution to the rigyn source checkout. Workspace scope controls project instructions, trusted project resources, tool working directories, and the default session list; it is not a filesystem sandbox.

`/login` offers only the authentication methods supported by the selected provider: subscription OAuth, browser or device OAuth, an environment credential, an API key, a cloud identity, or a local connection. Self-contained installs keep stored secrets in the installation's encrypted local credential store; on Windows its key is protected with DPAPI. Source and portable runs without an existing local key probe the current user's macOS Keychain or Linux Secret Service and create a private encrypted fallback when the desktop service is unavailable.

The model picker refreshes connected provider catalogs and does not fill the screen with a static universal model list. Disconnected, cached, and configured-only choices are hidden. Providers without a listing endpoint can use an exact configured deployment selected by typing `/model PROVIDER/MODEL` or passing `--model PROVIDER/MODEL`.

You can also run a single prompt and exit:

```sh
rigyn -p "Read this repository and explain its architecture"
rigyn --model PROVIDER/MODEL:high -p "Fix the failing tests"
rigyn -p @issue.md "Implement this issue"
```

Files beginning with `@` are included as prompt references. In the TUI, typing `@` opens workspace file completion. Supported images can be pasted or attached and are resized and normalized before provider submission.

## Terminal workflow

The default coding tools are:

- `read` — read text or supported images with bounded continuation;
- `bash` — execute a command in the active workspace with streamed, bounded output;
- `edit` — apply one or more exact replacements atomically;
- `write` — create or replace a file, including missing parent directories;
- `grep` — search file contents with bounded output;
- `find` — find workspace paths by name or pattern;
- `ls` — list directory entries with bounded metadata.

All seven built-ins are active by default in interactive, print, JSON, RPC, and direct SDK sessions. Use `--tools` as
an allowlist, `--exclude-tools` to remove selected names, `--no-builtin-tools` to retain only extension tools, or
`--no-tools` to disable every tool. For example, this read-only invocation narrows the active set:

```sh
rigyn --tools read,grep,find,ls -p "Review the source tree"
```

Absolute paths work when a task genuinely spans outside the starting directory. Commands and tools run with the invoking user's normal operating-system access; there is no repetitive tool-approval dialog. Project trust applies only to executable project-local configuration and extensions.

Useful interactive commands are:

```text
/settings                 /model [PROVIDER/MODEL]
/scoped-models            /login [PROVIDER]
/logout [PROVIDER]        /new
/resume                   /session                   /context
/name [NAME]              /fork
/clone [NAME]             /tree
/compact [INSTRUCTIONS]   /reload
/export [FILE]            /share [FILE]              /import [FILE]
/copy                     /hotkeys
/changelog                /trust                     /quit
```

Type `/` to open the command palette. `! command` runs a user shell command without sending it to the model. While a response is active, normal submissions steer the current run and the follow-up shortcut queues work for the next turn. Queue behavior is configurable as one-at-a-time or all-at-once.

The interface includes the default monochrome `mono` theme and the operational `signal` theme; discovered user and trusted-project custom themes remain selectable. `signal` visually separates reasoning, active tools, outcomes, warnings, diffs, selections, and status while retaining the same textual and structural cues. The TUI also includes immediate animated work/retry/compaction status, streaming text and provider-supplied reasoning summaries, bounded live tool output, complete retained tool details after completion, token/cache/cost status, model and thinking-level cycling, current/all-workspace session switching, transcript scrolling, external-editor support, command and path completion, image-or-text clipboard paste, queued-input recovery, and configurable keybindings. `Ctrl+T` expands or collapses reasoning summaries, and `Shift+Tab` cycles thinking levels supported by the selected model. Ctrl+Z restores the terminal before suspending on Unix; Ctrl+C twice exits; double-Escape on an empty editor follows `doubleEscapeAction`. Run `/hotkeys` for bindings in the current installation.

## Sessions and continuity

Sessions are saved automatically as append-only version 3 JSONL files and scoped to the current workspace. A session records messages, tool calls and results, provider continuation state, usage, model selection, extension-owned entries, branches, and compaction summaries.

```sh
rigyn --continue                 # latest session in this workspace
rigyn --resume                   # interactive session picker
rigyn --session PARTIAL_ID       # exact or unambiguous partial ID
rigyn --fork SESSION             # independent continuation
rigyn --no-session               # ephemeral conversation
```

`/tree` can move to an earlier entry and optionally summarize the abandoned branch. `/clone` creates a new durable session. Each new record is appended and linked to its parent, so switching branches never rewrites existing history. A trailing partial JSON line from an interrupted append is ignored when the session is reopened; completed entries remain intact.

See [Sessions and context](docs/sessions.md), the [session JSONL format](docs/session-jsonl.md), the [session export contract](docs/session-export.md), and [context compaction](docs/compaction.md) for the durable storage and budgeting model.

## Context, compaction, and token savings

Every request is projected for the selected provider while preserving complete tool-call/result groups. The context budget uses live model metadata when available and a conservative fallback otherwise. The default policy reserves 16,384 tokens for output, keeps roughly 20,000 tokens of recent history plus at least two recent turns, and compacts older complete turns into a durable summary. Old tool output is elided before conversation history is discarded.

Automatic compaction is on by default and can also be triggered with `/compact`. Provider-reported context overflow can force one safe retry even when a local token estimate was low.

Provider caching is used where the protocol supports it:

- OpenAI and ChatGPT subscription requests keep a stable session cache key and report cached-token usage;
- Anthropic places explicit cache breakpoints on stable system, tool, and recent message prefixes, with configurable `5m` or `1h` TTL;
- Bedrock and OpenRouter support explicit cache points when enabled;
- Mistral chat can use a stable session cache key;
- Gemini and compatible providers preserve and report provider-managed cache usage when available.

Caching reduces repeated-input billing and latency; compaction reduces the amount of history that must remain in each request. They are complementary rather than interchangeable.

## Providers

Built-in adapters cover OpenAI Responses, ChatGPT subscription OAuth, Anthropic Messages, GitHub Copilot, Gemini Interactions and Generate Content, Vertex AI, Azure OpenAI, Amazon Bedrock, OpenRouter, Mistral Conversations, Ollama, and OpenAI-compatible endpoints. Presets are included for Groq, Together, DeepSeek, Cerebras, xAI (per-model Responses/Chat routing plus device OAuth), mixed-protocol Fireworks, Hugging Face, the Messages-compatible Vercel AI Gateway, Z.AI Coding Plan, Kimi For Coding, and MiniMax.

Vertex and Azure OpenAI require a provider entry with their project or endpoint. Bedrock requires a configured region, or it is added automatically when `AWS_REGION` or `AWS_DEFAULT_REGION` is set. The other named adapters and presets are preconfigured; credentials still determine whether they are connected.

Common environment variables are recognized automatically:

```text
OPENAI_API_KEY             ANTHROPIC_API_KEY
GEMINI_API_KEY             OPENROUTER_API_KEY
MISTRAL_API_KEY            AZURE_OPENAI_API_KEY
COPILOT_GITHUB_TOKEN       AWS_BEARER_TOKEN_BEDROCK
GROQ_API_KEY               TOGETHER_API_KEY
DEEPSEEK_API_KEY           CEREBRAS_API_KEY
XAI_API_KEY                FIREWORKS_API_KEY
HF_TOKEN                   OLLAMA_API_KEY
AI_GATEWAY_API_KEY         ZAI_API_KEY
ZAI_CODING_CN_API_KEY      KIMI_API_KEY
MINIMAX_API_KEY            MINIMAX_CN_API_KEY
```

For authentication behavior, provider-specific configuration, custom OAuth registrations, and OpenAI-compatible endpoints, see [Providers](docs/providers.md). The independent [`rigyn/images` API](docs/image-generation.md) provides brokered one-shot image generation and a separate image-model catalog without placing image-only routes in the chat picker.

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
rigyn remove PACKAGE_ID
```

An extension package can contribute:

- runtime tools, slash commands, shortcuts, typed flags, providers, auth methods, tool renderers, and lifecycle listeners;
- durable extension-owned session state and transcript entries with structural renderers;
- progressively disclosed Agent Skills;
- prompt templates with positional arguments and defaults;
- terminal themes.

Runtime extensions are trusted local code and can use the same Node.js and operating-system access as the harness. Project-local executable resources are ignored until the workspace is trusted; declarative user resources do not trigger repeated prompts.

External protocols are integrated by trusted direct extensions rather than a core catch-all configuration file. The [subprocess worker example](examples/subprocess-workers/README.md) runs specialized rigyn children concurrently and demonstrates structured output validation, recursion prevention, timeouts, cancellation, bounded aggregation, and failure isolation.

Managed packages support production dependencies with lifecycle scripts disabled by default. A reviewed install or update may opt in for that transaction with `--allow-scripts`; source-package prepare/pack scripts remain disabled. Immutable npm/Git pins, source provenance, SSH-agent authentication, and private per-package module trees are enforced by the package manager. Authoring tools report optional `engines.rigyn` metadata, but the current loader does not treat it as an activation gate; verify the packed package against each supported host release. See the package guide for the `rigyn` package.json convention and configurable npm/Git wrapper argv.

Start with [Extensions](docs/extensions.md), [package authoring and the focused examples](docs/packages.md), the [public discovery index](docs/package-gallery.md), the [extension TUI contract](docs/tui.md), the minimal [starter package](examples/starter/README.md), and the trusted [raw editor example](examples/raw-editor-ui/README.md). Declarative authoring has standalone guides for [prompt templates](docs/prompt-templates.md), [skills](docs/skills.md), and [themes](docs/themes.md).

For an agent-built package, enter `/build-extension <request>`. The bundled prompt loads an on-demand authoring skill that reads the installed API docs, selects a capability-specific example, defines a visible acceptance contract, and verifies the package through its actual install and reload path.

## Configuration

Persistent settings use one strict JSON document:

```text
~/.rigyn/agent/settings.json              normal installation
$RIGYN_CODING_AGENT_DIR/settings.json     custom agent directory
WORKSPACE/.rigyn/settings.json            trusted project overrides
```

The self-contained installer scaffolds the global settings file from the complete packaged template when it is missing. `null` inherits dynamic/platform defaults without entering the runtime. Missing files and keys still mean defaults in portable or custom-agent-directory runs. Global settings load first; a trusted project's settings then override them recursively. Arrays and scalar values replace. The document includes persistent tool policy and the complete keybinding map. Invalid JSON is reported without replacing the last valid in-memory values. Credentials remain in `auth.json`, sessions remain JSONL files, and provider/model declarations belong to the model registry or trusted extensions rather than the settings file.

Project settings are neither read nor writable before trust. The global-only `defaultProjectTrust` setting accepts `ask`, `always`, or `never`; `--approve` and `--no-approve` remain invocation-only overrides.

The self-contained installer creates a ready-to-edit personal template at `~/.rigyn/agent/AGENTS.md` and preserves it on updates. Personal agent instructions belong there, or in
`$RIGYN_CODING_AGENT_DIR/AGENTS.md` when that directory is overridden. Project instructions belong in `AGENTS.md`
files along the path to the active working directory. rigyn appends the global file first and project files from the
outermost ancestor to the working directory, so more specific instructions appear later. `/reload` rereads them.

Example:

```json
{
  "defaultProvider": "openai-codex",
  "defaultModel": "MODEL_ID",
  "defaultThinkingLevel": "high",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

`rigyn config` selects enabled resources from installed packages. `rigyn config path` prints the exact user settings
path and `rigyn config edit` opens it through the configured external editor. Add `--scope project` to either command
for `WORKSPACE/.rigyn/settings.json`; editing that scope requires project trust. Edits validate a top-level JSON object
and commit under the settings lock only if the file did not change while the editor was open. The complete settings
contract and resource paths are in [Configuration](docs/configuration.md), with the complete installed template at
[`resources/settings.example.json`](resources/settings.example.json).

## Automation and embedding

`-p --mode text` prints the final response for a one-shot run, `-p --mode json` emits normalized events, and `rigyn --mode rpc` starts newline-delimited JSON RPC over standard input and output. One-shot prompts may invoke installed runtime commands, declarative commands, prompt templates, and skills with the same slash forms used in chat. The package also exports the provider-neutral service, event, provider, tool, extension, storage, context, and TUI contracts for embedding.

For an in-process Node.js integration, the task-focused `rigyn/embedding` owner keeps credential and provider-registry authority private while owning cancellation, reload, and cleanup. `rigyn/sdk` independently composes one direct `AgentSession` from caller-selected providers, tools, extensions, resources, settings, and storage. `rigyn/modes` exposes adapters with distinct lifecycle rules: print mode disposes the runtime it receives, interactive mode borrows a runtime while owning its terminal, and RPC mode accepts and owns an already-created `AgentSessionRuntime`. The configured embedding and default SDK paths use the CLI's provider and credential construction:

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

The packaged [`examples/embedding-runtime.mjs`](examples/embedding-runtime.mjs) is the same configured lifecycle as a runnable file. From the repository root, run `node packages/rigyn/examples/embedding-runtime.mjs <provider> <model> <prompt>`. [`examples/embedding-in-memory.mjs`](examples/embedding-in-memory.mjs) and [`examples/embedding-cancellation.mjs`](examples/embedding-cancellation.mjs) demonstrate the credential-free test preset and bounded cancellation. Call `harness.session.start()` instead of `run()` when you need an immediate handle with `sessionId`, `result`, `abort()`, and `cancelRetry()`. The advanced root `createHarnessRuntime()` remains available to hosts that need direct `AgentSession`, `SessionManager`, prompt-handle, event, model-selection, and reload access.

Existing layers are available as explicit ESM subpaths under `rigyn/<layer>`, where `<layer>` is `auth`, `config`, `context`, `core`, `embedding`, `extensions`, `images`, `interfaces`, `modes`, `net`, `process`, `prompts`, `providers`, `sdk`, `service`, `storage`, `testing`, `tools`, or `tui`. Each subpath resolves to its built JavaScript and TypeScript declarations, so consumers can depend on one layer without importing the root barrel.

The supported entry points and compatibility rules are defined in the [public Node.js API policy](docs/public-api.md). Mode ownership and examples are in [In-process modes](docs/modes.md). Paths inside `dist/` are not public imports.

All package entry points intentionally target the supported local Node.js runtime (24.15+ or 26+). No root or subpath is declared browser-safe, including entry points that contain provider-neutral types. A browser interface should talk to a trusted local Node process over the newline-delimited RPC interface or a private localhost extension bridge; browser code should not bundle the harness modules directly.

```sh
rigyn --mode rpc
rigyn --mode json -p "Inspect package.json"
rigyn --export session.jsonl conversation.html
```

RPC is strict LF-delimited command JSON over standard input/output. Commands use a `type` and optional string `id`; responses use `type: "response"`, preserve that ID, and include the command name. Agent events stream as raw event records. Node.js clients can use the typed `RpcClient` export from `rigyn/interfaces`. The complete command, session, event, cancellation, and extension-UI contract is in [RPC protocol and typed client](docs/rpc.md).

```json
{"id":"req_1","type":"get_state"}
{"id":"req_2","type":"set_model","provider":"YOUR_PROVIDER","modelId":"YOUR_MODEL"}
{"id":"req_3","type":"prompt","message":"Inspect package.json"}
{"id":"req_4","type":"get_session_stats"}
```

Prompt acknowledgement is emitted after preflight succeeds; raw agent events then report progress and completion. Request handling may overlap, so correlate responses by their string IDs rather than output order.

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

`npm run check` type-checks source and tests, executes the full unit and PTY suite, builds distributable JavaScript and declarations, compiles an external consumer, tests the built package, and installs a packed artifact into an isolated home for an offline end-to-end run.

`npm run benchmark:offline --workspace rigyn` runs a credential-free, deterministic harness-plumbing corpus through the real service and tools. Its versioned JSON report tracks completion, pass@1, multi-file and continuation scenarios, provider/tool recovery, parallel tool batches, mutation preservation, verification, usage/cost, compaction, and crash recovery. It does not measure model intelligence. See [Outcome benchmarks](https://github.com/rigyn/rigyn/blob/main/packages/rigyn/benchmarks/README.md) for metric definitions and limitations.

`npm run benchmark:extensions --workspace rigyn` is a second credential-free verifier. It runs extension candidates through managed install, public discovery, activation, reload, and removal and reports pass@1/pass@3 with zero model calls.

`npm run benchmark:runtime --workspace rigyn` measures eleven deterministic startup, large-package reload, small/large session resume, bounded cold-history paging, and cursor-paged RPC replay scenarios against generous freeze-regression ceilings. `npm run test:coverage:risk` aggregates subprocess-aware coverage and enforces separate line, branch, and function floors for the extension runtime, CLI, TUI controller, agent session, and JSONL session manager. The paid `npm run benchmark:compare --workspace rigyn` command is opt-in and gives two CLIs the same model, task files, and external verifier; it does not claim one harness is better without evidence. See [Outcome benchmarks](https://github.com/rigyn/rigyn/blob/main/packages/rigyn/benchmarks/README.md).

The high-level component map is in [Architecture](docs/ARCHITECTURE.md). Practical operations are covered by the [cookbook](docs/cookbook.md), [local diagnostics](docs/diagnostics.md), [troubleshooting guide](docs/troubleshooting.md), and [platform notes](docs/platforms.md).

Contribution expectations, security reporting, release-visible changes, and the deterministic release procedure are in [CONTRIBUTING.md](https://github.com/rigyn/rigyn/blob/main/CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md), and [docs/releasing.md](docs/releasing.md).

## License

rigyn is released under the [MIT License](LICENSE).
