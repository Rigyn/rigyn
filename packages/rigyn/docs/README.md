# Rigyn documentation

Rigyn is a local-first terminal coding agent and an extensible agent runtime. If this is your first visit, start with [Getting started](getting-started.md). It explains the workspace model, provider connection, tools, session continuity, extensions, data locations, updates, and removal as one end-to-end workflow.

## Use Rigyn

- [Getting started](getting-started.md) — install, connect a model, run a task, resume it, and add reusable behavior.
- [Terminal workflow](../README.md#terminal-workflow) — built-in tools, interactive commands, queues, status, and key shortcuts.
- [CLI command and flag reference](cli-reference.md) — invocation modes, session flags, resource controls, and administrative commands.
- [Keybindings](keybindings.md) — default actions, key notation, extension shortcuts, and input diagnosis.
- [Terminal setup](terminal-setup.md) — Linux, macOS, Windows, WSL, Termux, SSH, and tmux recipes.
- [Installation and platform troubleshooting](install.md) — requirements, command paths, Linux, macOS, Windows, WSL, Termux, and tmux.
- [Providers and authentication](providers.md) — built-in providers, OAuth and API keys, environment credentials, model catalogs, and custom endpoints.
- [Sessions and context](sessions.md) — workspace scope, resume, branching, crash recovery, storage, and context budgeting.
- [Context compaction](compaction.md) — automatic and manual compaction behavior.
- [Configuration](configuration.md) — paths, precedence, settings, keybindings, instructions, and project trust.
- [Runtime cookbook](cookbook.md) — short recipes for common interactive and automated tasks.
- [Troubleshooting](troubleshooting.md), [Platform notes](platforms.md), and [Local diagnostics](diagnostics.md) — investigate local failures without exposing credentials or session content.
- [Session export contract](session-export.md) — readable exports and the round-trip JSONL format.
- [Session JSONL format](session-jsonl.md) — version 3 headers, entries, branches, recovery, and extension-safe access.

## Extend Rigyn

- [Extensions](extensions.md) — runtime API, discovery, trust, tools, commands, providers, authentication, durable state, and lifecycle.
- [Package authoring and local gallery](packages.md) — package formats, install sources, dependencies, project locks, provenance, testing, and release guidance.
- [Extension capability matrix](extension-capabilities.md) — public extension surfaces, supported hosts, examples, and conformance coverage.
- [Extension TUI](tui.md) — structural components, overlays, tool and session renderers, themes, input, focus, and lifecycle.
- [Runtime extension events](extension-events.md) — event payloads, ordering, bounds, cancellation, and failure isolation.
- [Package discovery index](package-gallery.md) — public gallery metadata and deterministic discovery checks.
- [Extension authentication threat model](extension-auth-threat-model.md) — credential brokering and extension authority boundaries.
- [Resource catalog](resource-catalog.md) — bounded introspection of tools, commands, prompts, skills, themes, providers, packages, and diagnostics.
- [Prompt templates](prompt-templates.md), [Skills](skills.md), and [Themes](themes.md) — authoring formats, discovery, precedence, and safety boundaries.
- [Subprocess worker example](../examples/subprocess-workers/README.md) — run a bounded argv-based worker protocol from a trusted direct extension.

## Automate or embed Rigyn

- [RPC protocol and typed client](rpc.md) — newline-delimited commands, raw agent events, sessions, cancellation, and extension UI.
- [Embedding Rigyn](embedding.md) — owned in-process runtime lifecycle and task-focused examples.
- [SDK composition](sdk.md) — compose providers, tools, extensions, resources, context defaults, and lifecycle without exposing runtime internals.
- [In-process modes](modes.md) — ready-made print, terminal, and RPC adapters with explicit lifecycle ownership.
- [Public Node.js API policy](public-api.md) — supported package exports and compatibility rules.
- [Generic coding-agent API compatibility](generic-api-compatibility.md) — portable aliases, adapters, and deliberate native-contract differences.
- [Image generation](image-generation.md) — separate image models, brokered providers, one-shot generation, hooks, bounds, and custom APIs.
- [External execution backends](execution-backends.md) — route declared model tools through an explicit external boundary.

## Understand and contribute

- [Architecture](ARCHITECTURE.md) — component boundaries and the request lifecycle.
- [Live provider contract tests](live-provider-testing.md) — opt-in credentialed provider verification.
- [Provider model catalog maintenance](provider-model-catalog.md) — maintained fallbacks, lossless direct projection, and drift checks.
- [Release policy and procedure](releasing.md) — deterministic staging, verification, and publication.
- [Contributing](https://github.com/Rigyn/rigyn/blob/main/CONTRIBUTING.md), [Security](../SECURITY.md), [Changelog](../CHANGELOG.md), and [License](../LICENSE) — project policies and release-visible changes.
