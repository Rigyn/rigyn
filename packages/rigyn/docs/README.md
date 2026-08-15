# rigyn documentation

rigyn is a local-first terminal harness and an extensible agent runtime. If this is your first visit, start with
[Getting started](getting-started.md). It covers installation, workspaces, providers, tools, sessions, extensions,
data locations, updates, and removal in one workflow.

## Use rigyn

- [Getting started](getting-started.md) — install, connect a model, run a task, resume it, and add reusable behavior.
- [Terminal workflow](../README.md#terminal-workflow) — built-in tools, interactive commands, queues, status, and key shortcuts.
- [CLI command and flag reference](cli-reference.md) — invocation modes, session flags, resource controls, and administrative commands.
- [Keybindings](keybindings.md) — default actions, key notation, extension shortcuts, and input diagnosis.
- [Terminal setup](terminal-setup.md) — Linux, macOS, Windows, WSL, Termux, SSH, and tmux recipes.
- [Installation and platform troubleshooting](install.md) — requirements, command paths, Linux, macOS, Windows, WSL, Termux, and tmux.
- [Providers and authentication](providers.md) — built-in providers, OAuth and API keys, environment credentials, model catalogs, and custom endpoints.
- [Kimi Code](kimi-code.md) — account and membership-key login, current coding models, cache affinity, and catalog limits.
- [Sessions and context](sessions.md) — workspace scope, resume, branching, crash recovery, storage, and context budgeting.
- [Context compaction](compaction.md) — automatic and manual compaction behavior.
- [Configuration](configuration.md) — paths, precedence, settings, keybindings, instructions, and project trust.
- [Instruction and system-prompt files](context-files.md) — automatic context precedence, prompt replacement, append files, and bounded discovery APIs.
- [Environment variables](environment-variables.md) — process configuration and shell-tool session identity.
- [Shell aliases and startup commands](shell-aliases.md) — configure deterministic non-interactive shell initialization.
- [Runtime cookbook](cookbook.md) — short recipes for common interactive and automated tasks.
- [Troubleshooting](troubleshooting.md), [Platform notes](platforms.md), and [Local diagnostics](diagnostics.md) — investigate local failures without exposing credentials or session content.
- [Session export contract](session-export.md) — readable exports and settled V4 journal projections.
- [Session JSONL format](session-jsonl.md) — strict V4 headers, commits, replay, queues, and recovery.

## Extend rigyn

- [Extensions](extensions.md) — runtime API, discovery, trust, tools, commands, providers, authentication, durable state, and lifecycle.
- [Extension API reference](extension-api.md) — complete registration, callback, lifecycle, session, UI, and process contracts.
- [Provider authoring](provider-authoring.md) — custom providers, model metadata, authentication, streaming, request hooks, and testing.
- [Package authoring and local gallery](packages.md) — package formats, install sources, dependencies, project locks, provenance, testing, and release guidance.
- [Extension capability matrix](extension-capabilities.md) — public extension surfaces, supported hosts, examples, and conformance coverage.
- [Extension TUI](tui.md) — structural components, overlays, tool and session renderers, themes, input, focus, and lifecycle.
- [Runtime extension events](extension-events.md) — event payloads, ordering, bounds, cancellation, and failure isolation.
- [Package discovery index](package-gallery.md) — public gallery metadata and deterministic discovery checks.
- [Extension authentication threat model](extension-auth-threat-model.md) — credential brokering and extension authority boundaries.
- [Resource catalog](resource-catalog.md) — bounded introspection of tools, commands, prompts, skills, custom themes, providers, packages, and diagnostics.
- [Prompt templates](prompt-templates.md), [Skills](skills.md), and [Themes](themes.md) — authoring formats, discovery, precedence, and safety boundaries.
- [Subprocess worker example](../examples/subprocess-workers/README.md) — run a bounded argv-based worker protocol from a trusted direct extension.

## Automate or embed rigyn

- [RPC protocol and typed client](rpc.md) — newline-delimited commands, raw agent events, sessions, cancellation, and extension UI.
- [HTTP and SSE service](serve.md) — authenticated local session control, live events, reconnect, and security limits.
- [JSON event stream](json.md) — parse one-shot session events from standard output.
- [Embedding rigyn](embedding.md) — owned in-process runtime lifecycle and task-focused examples.
- [SDK composition](sdk.md) — compose providers, tools, extensions, resources, context defaults, and lifecycle without exposing runtime internals.
- [Run modes](modes.md) — terminal, one-shot, RPC, local service, and in-process surfaces with explicit lifecycle ownership.
- [Public Node.js API policy](public-api.md) — supported package exports and compatibility rules.
- [Root API aliases and adapters](api-aliases.md) — convenient package-root names, thin adapters, and native contracts.
- [Image generation](image-generation.md) — separate image models, brokered providers, one-shot generation, hooks, bounds, and custom APIs.
- [External execution backends](execution-backends.md) — route declared model tools through an explicit external boundary.
- [External execution backend adapters](../examples/execution-backends/README.md) — use the packaged container and SSH protocol adapters.

## Understand and contribute

- [Architecture](ARCHITECTURE.md) — component boundaries and the request lifecycle.
- [Source development](development.md) — repository setup, focused checks, complete validation, paths, and terminal debugging.
- [Live provider contract tests](live-provider-testing.md) — opt-in credentialed provider verification.
- [Provider model catalog maintenance](provider-model-catalog.md) — maintained fallbacks, lossless direct projection, and drift checks.
- [Release policy and procedure](releasing.md) — deterministic staging, verification, and publication.
- [Contributing](https://github.com/rigyn/rigyn/blob/main/CONTRIBUTING.md), [Security](../SECURITY.md), [Changelog](../CHANGELOG.md), and [License](../LICENSE) — project policies and release-visible changes.
