# Rigyn

Rigyn is a local-first terminal coding agent. It combines a fast inline TUI, direct model-provider protocol adapters, durable branching sessions, automatic context compaction, and a packageable extension system.

The agent loop and provider wire clients are implemented in this repository without provider SDKs. Small third-party dependencies are used for HTTP transport, image conversion, JSONC/YAML parsing, ignore matching, and the bundled ripgrep executable.

The project is pre-release. Node.js 24.15 or a current Node.js 26-or-newer release is required.

## Install

From npm after the first package release:

```sh
npx --yes rigyn@latest self-install
rigyn
```

From the public source checkout today:

```sh
git clone https://github.com/Rigyn/rigyn.git
cd rigyn
node scripts/install-user.mjs
rigyn
```

The installer creates a self-contained installation under `$HOME/.rigyn`. It copies the required build inputs into installation-owned staging, builds there, and removes the staging copy afterward. The master source checkout is read-only during installation. The packaged application, production dependencies, executable, configuration, sessions, credentials, cache, and temporary artifacts stay under the installation directory. On Linux and macOS, a tiny managed command launcher at `$HOME/.local/bin/rigyn` makes the private installation available from any directory. The installer does not use npm's global package directory, link the application back to the source checkout, change the current workspace, or edit shell startup files.

Installing does not require `npm install` in the master checkout. For development only, run `npm install`, `npm run check`, and `npm run dev --` from the checkout.

Update or remove the self-contained installation from any directory:

```sh
rigyn self-update
rigyn uninstall --yes
```

Uninstall is marker-verified and removes the installed application, configuration, OAuth/API-key profiles, sessions, cache, and its managed command. It never deletes the source checkout or unrelated files.

See [installation and platform troubleshooting](docs/install.md) for Linux, macOS, Windows, WSL, Termux, tmux, command-path, OAuth-browser, and native-dependency guidance.

## First run

Start the interface, connect a provider, and select one of that provider's currently available models:

```text
rigyn
/login
/model
```

`/login` offers only the authentication methods supported by the selected provider: subscription OAuth, browser or device OAuth, an environment credential, an API key, a cloud identity, or a local connection. Stored secrets use the operating-system keychain when it is available and an encrypted local store otherwise.

The model picker refreshes connected provider catalogs and does not fill the screen with a static universal model list. Disconnected cached choices are hidden, while available models support fuzzy search, context-window metadata, and exact deployment IDs for providers without a listing endpoint.

You can also run a single prompt and exit:

```sh
rigyn -p "Read this repository and explain its architecture"
rigyn --model PROVIDER/MODEL:high -p "Fix the failing tests"
rigyn @issue.md "Implement this issue"
```

Files beginning with `@` are included as prompt references. In the TUI, typing `@` opens workspace file completion. Supported images can be pasted or attached and are resized and normalized before provider submission.

## Terminal workflow

The default coding tools are:

- `read` — read text or supported images with bounded continuation;
- `bash` — execute a command in the active workspace with streamed, bounded output;
- `edit` — apply one or more exact replacements atomically;
- `write` — create or replace a file, including missing parent directories.

`grep`, `find`, and `ls` are available as opt-in tools. For example:

```sh
rigyn --tools read,grep,find,ls -p "Review the source tree"
```

Absolute paths work when a task genuinely spans outside the starting directory. Commands and tools run with the invoking user's normal operating-system access; there is no repetitive tool-approval dialog. Project trust applies only to executable project-local configuration and extensions.

Useful interactive commands are:

```text
/settings                 /model [PROVIDER/MODEL]
/scoped-models            /login [PROVIDER]
/logout [PROVIDER]        /new
/resume                   /session
/name [NAME]              /fork
/clone [NAME]             /tree
/compact [INSTRUCTIONS]   /reload
/export [FILE]            /import [FILE]
/copy                     /hotkeys
/trust                    /quit
```

Type `/` to open the command palette. `! command` runs a user shell command without sending it to the model. While a response is active, normal submissions steer the current run and the follow-up shortcut queues work for the next turn. Queue behavior is configurable as one-at-a-time or all-at-once.

The interface includes immediate animated work/retry/compaction status, streaming text and provider-supplied reasoning summaries, expandable tool calls and results, token/cache/cost status, model and thinking-level cycling, current/all-workspace session switching, transcript scrolling, external-editor support, command and path completion, image-or-text clipboard paste, queued-input recovery, and configurable keybindings. `Ctrl+T` expands or collapses reasoning summaries, `Ctrl+O` expands tool details, and `Shift+Tab` cycles thinking levels supported by the selected model. Ctrl+Z restores the terminal before suspending on Unix; Ctrl+C twice exits; double-Escape on an empty editor follows `doubleEscapeAction`. Run `/hotkeys` for bindings in the current installation.

## Sessions and continuity

Sessions are saved automatically and scoped to the current workspace. A session records messages, tool calls and results, provider continuation state, usage, model selection, extension-owned state, branches, and run outcomes in SQLite.

```sh
rigyn --continue                 # latest session in this workspace
rigyn --resume                   # interactive session picker
rigyn --session PARTIAL_ID       # exact or unambiguous partial ID
rigyn --fork SESSION             # independent continuation
rigyn --no-session               # ephemeral conversation
```

`/tree` can move to an earlier event and optionally summarize the abandoned branch. `/clone` creates a new durable session. Interrupted runs are recovered conservatively: tool calls that may already have changed the machine are marked as having an unknown outcome rather than silently replayed. Queued input is leased durably so a crash does not duplicate or discard it.

See [Sessions and context](docs/sessions.md), the [session export contract](docs/session-export.md), and [context compaction](docs/compaction.md) for the durable storage and budgeting model.

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

Built-in adapters cover OpenAI Responses, ChatGPT subscription OAuth, Anthropic Messages, GitHub Copilot, Gemini Interactions and Generate Content, Vertex AI, Azure OpenAI, Amazon Bedrock, OpenRouter, Mistral chat and conversations, Ollama, and OpenAI-compatible endpoints. Presets are included for Groq, Together, DeepSeek, Cerebras, xAI, Fireworks, Hugging Face, Vercel AI Gateway, Z.AI Coding Plan, Kimi For Coding, and MiniMax.

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

For authentication behavior, provider-specific configuration, custom OAuth registrations, and OpenAI-compatible endpoints, see [Providers](docs/providers.md).

## Extensions, skills, prompts, themes, and packages

Resources may be loaded from user scope, a trusted project's `.rigyn` directory, an explicit CLI path, or an installed package.

```sh
rigyn install ./my-package
rigyn install npm:@scope/my-package
rigyn install git:https://example.com/owner/repository.git
rigyn install ssh://git@example.com/owner/private-repository.git#v1
rigyn --package npm:@scope/my-package -p "Try this package without installing it"
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

Managed packages support production dependencies with lifecycle scripts disabled by default. A reviewed install, update, or invocation-only package may opt in for that transaction with `--allow-scripts`; source-package prepare/pack scripts remain disabled. Host compatibility ranges, immutable npm/Git pins, source provenance, SSH-agent authentication, and private per-package module trees are enforced by the package manager. See the package guide for the `rigyn` package.json convention and configurable npm/Git wrapper argv.

Start with [Extensions](docs/extensions.md), [package authoring and the local gallery](docs/packages.md), the [public discovery index](docs/package-gallery.md), the [extension TUI contract](docs/tui.md), the complete offline [reference package](examples/reference-package/README.md), and the focused [custom overlay](examples/custom-overlay.mjs).

For an agent-built package, enter `/build-extension <request>`. The bundled prompt loads an on-demand authoring skill that reads the installed API docs, selects a capability-specific example, defines a visible acceptance contract, and verifies the package through its actual install and reload path.

## Configuration

Global configuration is JSONC:

```text
$XDG_CONFIG_HOME/rigyn/config.jsonc
```

Project configuration is read only after trust is granted. Interactive startup can remember trust or distrust for an exact workspace, or apply either choice only to that launch. The global-only `defaultProjectTrust` setting accepts `ask`, `always`, or `never`; `/settings` changes its next-launch value. `--approve` and `--no-approve` remain invocation-only overrides:

```text
WORKSPACE/.rigyn/config.jsonc
```

Example:

```jsonc
{
  "defaultProvider": "openai-codex",
  "defaultModel": "MODEL_ID",
  "thinking": "high",
  "scopedModels": [
    "openai-codex/MODEL_ID:high",
    "anthropic/MODEL_ID"
  ],
  "autoCompaction": true,
  "compactionRetainRecentTurns": 2,
  "providers": {
    "openai": {
      "kind": "openai",
      "promptCacheRetention": "24h"
    },
    "anthropic": {
      "kind": "anthropic",
      "promptCache": "1h"
    }
  }
}
```

Settings changed in the TUI preserve existing JSONC comments. The complete key list and resource paths are in [Configuration](docs/configuration.md).

## Automation and embedding

`-p --mode text` prints the final response for a one-shot run, `-p --mode json` emits normalized events, and `rigyn rpc` starts newline-delimited JSON RPC over standard input and output. One-shot prompts may invoke installed runtime commands, declarative commands, prompt templates, and skills with the same slash forms used in chat. The package also exports the provider-neutral service, event, provider, tool, extension, storage, context, and TUI contracts for embedding.

For an in-process Node.js integration, the task-focused `rigyn/embedding` owner keeps credential, provider-registry, store, and service authority private while owning cancellation, reload, and cleanup. It uses the same configured providers and brokered credentials as the CLI:

```js
import { createEmbeddingHarness } from "rigyn/embedding";

const runtime = await createEmbeddingHarness({ workspace: process.cwd() });
try {
  const run = await runtime.run({
    provider: "YOUR_PROVIDER",
    model: "YOUR_MODEL",
    prompt: "Inspect this project and report the test command",
    onEvent({ event }) {
      if (event.type === "text_delta") process.stdout.write(event.text);
    },
  });

  // Continue the same durable session by passing run.threadId to another call.
  await runtime.run({
    threadId: run.threadId,
    provider: "YOUR_PROVIDER",
    model: "YOUR_MODEL",
    prompt: "Now run that test command",
  });
} finally {
  await runtime.close();
}
```

The packaged [`examples/embedding-runtime.mjs`](examples/embedding-runtime.mjs) is the same configured lifecycle as a runnable file: `node examples/embedding-runtime.mjs <provider> <model> <prompt>`. [`examples/embedding-in-memory.mjs`](examples/embedding-in-memory.mjs) and [`examples/embedding-cancellation.mjs`](examples/embedding-cancellation.mjs) demonstrate the credential-free test preset and bounded cancellation. Call `runtime.start()` instead of `run()` when you need an immediate handle with `threadId`, `result`, and `cancel()`. The advanced root `createHarnessRuntime()` remains available to hosts that explicitly need its underlying registries and service.

Existing layers are available as explicit ESM subpaths under `rigyn/<layer>`, where `<layer>` is `auth`, `config`, `context`, `core`, `embedding`, `extensions`, `images`, `interfaces`, `net`, `process`, `prompts`, `providers`, `service`, `storage`, `testing`, `tools`, or `tui`. Each subpath resolves to its built JavaScript and TypeScript declarations, so consumers can depend on one layer without importing the root barrel.

The supported entry points and compatibility rules are defined in the [public Node.js API policy](docs/public-api.md). Paths inside `dist/` are not public imports.

All package entry points intentionally target the supported local Node.js runtime (24.15+ or 26+). No root or subpath is declared browser-safe, including entry points that contain provider-neutral types. A browser interface should talk to a trusted local Node process over the newline-delimited RPC interface or a private localhost extension bridge; browser code should not bundle the harness modules directly.

```sh
rigyn rpc
rigyn --mode json -p "Inspect package.json"
rigyn --export session.html
```

RPC is strict LF-delimited JSON-RPC 2.0 over standard input/output. Start with `initialize`, then use `run.start`; it responds with a `threadId`, emits `run.event` notifications while work proceeds, and emits `run.finished` when the run settles. `run.wait` waits for the caller-owned run, and passing the same `threadId` to another `run.start` continues that session. The `initialize` response advertises the supported session, queue, compaction, model, authentication, extension, export, and event capabilities.

Node.js clients can use the typed `RpcClient` and `spawnRpcClient` exports from `rigyn/interfaces`. The complete method, notification, cancellation, extension-UI, and durable-subscription contract is in [RPC protocol and typed client](docs/rpc.md).

```json
{"jsonrpc":"2.0","id":1,"method":"initialize"}
{"jsonrpc":"2.0","id":2,"method":"run.start","params":{"provider":"YOUR_PROVIDER","model":"YOUR_MODEL","prompt":"Inspect package.json"}}
{"jsonrpc":"2.0","id":3,"method":"run.wait","params":{"threadId":"THREAD_ID_FROM_RUN_START"}}
{"jsonrpc":"2.0","id":4,"method":"shutdown"}
```

Send each object only after handling the response needed by the next one; request handling is concurrent and response IDs, rather than output order, provide correlation. For durable reconnectable event consumption, call `events.subscribe` with a `threadId` and optional `afterSequence` cursor.

## Development

```sh
npm install
npm run typecheck
npm run typecheck:test
npm test
npm run benchmark:offline
npm run benchmark:extensions
npm run build
npm run check
```

`npm run check` type-checks source and tests, executes the full unit and PTY suite, builds distributable JavaScript and declarations, compiles an external consumer, tests the built package, and installs a packed artifact into an isolated home for an offline end-to-end run.

`npm run benchmark:offline` runs a credential-free, deterministic harness-plumbing corpus through the real service and tools. Its versioned JSON report tracks completion, pass@1, multi-file and continuation scenarios, provider/tool recovery, parallel tool batches, mutation preservation, verification, usage/cost, compaction, and crash recovery. It does not measure model intelligence. See [Outcome benchmarks](benchmarks/README.md) for metric definitions and limitations.

`npm run benchmark:extensions` is a second credential-free verifier. It runs extension candidates through managed install, public discovery, activation, reload, and removal and reports pass@1/pass@3 with zero model calls.

The high-level component map is in [Architecture](docs/ARCHITECTURE.md). Practical operations are covered by the [cookbook](docs/cookbook.md), [local diagnostics](docs/diagnostics.md), [troubleshooting guide](docs/troubleshooting.md), and [platform notes](docs/platforms.md).

Contribution expectations, security reporting, release-visible changes, and the deterministic release procedure are in [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md), and [docs/releasing.md](docs/releasing.md).

## License

Rigyn is released under the [MIT License](LICENSE).
