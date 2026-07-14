# Getting started

This guide takes a new installation from an empty terminal to a useful, resumable coding session. For a complete topic list, see the [documentation map](README.md).

## What Rigyn does

Rigyn connects a model to a small set of tools running on your computer:

1. You enter a task in the terminal interface or as a one-shot command.
2. Rigyn sends the conversation and tool definitions to the selected provider.
3. The model may request file reads, shell commands, or edits.
4. Rigyn executes those requests locally, returns bounded results to the model, and renders the work as it happens.
5. Rigyn saves the session locally so you can continue, branch, compact, or export it later.

The default tools are `read`, `bash`, `edit`, and `write`. They run with the permissions of the user who launched Rigyn. Project trust controls whether project-local configuration and executable extensions load; it does not approve individual shell commands or create a sandbox.

Model requests leave your machine when you choose a hosted provider. Use a local provider such as Ollama when the model must also run locally.

## 1. Install Rigyn

Rigyn requires a supported 64-bit Node.js 24.15+ or 26+ runtime and npm:

```sh
node --version
npm --version
```

After the first npm release, install a private per-user copy:

```sh
npx --yes rigyn@latest self-install
rigyn --version
```

Until then, install from the public source checkout:

```sh
git clone https://github.com/Rigyn/rigyn.git
cd rigyn
node scripts/install-user.mjs
rigyn --version
```

Both routes create a self-contained installation under `~/.rigyn`. They do not create a global npm package or link the executable back to the source checkout. On Linux and macOS the command launcher is `~/.local/bin/rigyn`; on Windows it is `%USERPROFILE%\.rigyn\bin\rigyn.cmd`. See [Installation and platform troubleshooting](install.md) if the command is not on `PATH`.

## 2. Open a workspace

Launch Rigyn from the project you want it to work on:

```sh
cd /path/to/your/project
rigyn
```

The launch directory becomes the workspace. It determines the starting directory for tools, the project instruction and resource roots, and which sessions `/resume` shows by default. You can launch the global `rigyn` command from any directory; it does not run inside or modify the Rigyn source checkout merely because that checkout was used for installation.

To select a different workspace without changing the shell directory:

```sh
rigyn --workspace /path/to/your/project
```

Tools can still use absolute paths when needed. Workspace scope is organization and trust context, not an operating-system boundary.

## 3. Connect a provider and choose a model

In the terminal interface, enter:

```text
/login
/model
```

`/login` shows the authentication methods implemented for each provider. Depending on the provider, this may be subscription OAuth, browser or device OAuth, an API key, an environment credential, a cloud identity, or a local connection. `/model` refreshes connected catalogs and shows models currently available to the active credentials.

Useful checks are:

```sh
rigyn --list-models
rigyn --list-models PROVIDER
```

You can choose a model for one invocation without changing the saved default:

```sh
rigyn --model PROVIDER/MODEL:high
```

The optional suffix selects a supported thinking level. See [Providers and authentication](providers.md) for provider IDs, environment variables, OAuth behavior, custom endpoints, and model metadata.

## 4. Give Rigyn a task

Start with a task that has a concrete result and a verification step:

```text
Explain how this project starts, then identify the smallest safe fix for the failing test. Do not edit yet.
```

After reviewing the answer, ask it to implement and verify the change. Rigyn displays model text, reasoning summaries when supplied by the provider, tool calls, bounded command output, edits, token usage, cache usage, and cost metadata when known. `Ctrl+O` expands tool details and `Ctrl+T` expands reasoning summaries.

Type `/` for the command palette or `/hotkeys` for the active key map. Prefix a command with `!` to run it yourself without sending it to the model:

```text
! git status --short
```

For a read-only review, restrict the available tools:

```sh
rigyn --no-session --tools read,grep,find,ls --print \
  "Review this repository and cite concrete file paths. Do not modify files."
```

`--tools` is an allowlist. `--no-session` disables conversation persistence; neither option creates an OS sandbox.

## 5. Continue or branch the work

Sessions are saved automatically. To continue the most recent session in the current workspace:

```sh
rigyn --continue
```

To choose one:

```sh
rigyn --resume
```

Inside the interface, use `/resume`, `/new`, `/name`, `/tree`, `/fork`, and `/clone`. The normal picker is workspace-scoped. Use `/resume --all` or the CLI `rigyn --resume --all` to search indexed sessions from every workspace.

Automatic context compaction keeps long sessions within the selected model's context window. `/compact` triggers it explicitly. See [Sessions and context](sessions.md), [Context compaction](compaction.md), and the [session export contract](session-export.md) for recovery, branching, retention, import, and export behavior.

## 6. Add reusable behavior

Rigyn separates four resource types:

- A **skill** is on-demand instruction content. Only its name and description stay in the base prompt; full guidance loads when relevant.
- A **prompt template** is a reusable slash command with arguments and defaults.
- A **theme** changes terminal presentation without adding runtime authority.
- A **runtime extension** is trusted code that can add tools, commands, providers, authentication, state, events, shortcuts, and structural UI.

A **package** distributes one or more of those resources. Installed runtime extensions activate inside the current Rigyn process and extend that harness; they do not need to launch a second Rigyn instance.

Install and inspect a reviewed package with:

```sh
rigyn install ./my-package
rigyn list
rigyn extensions doctor
rigyn remove my-package
```

Use `rigyn --package ./my-package` for one invocation without persisting the package. Runtime extensions are ordinary Node.js code with your user's access, so review the package, its runtime entries, and production dependencies first. Dependency lifecycle scripts remain disabled unless you explicitly add `--allow-scripts` for that transaction.

To have Rigyn build a package, enter `/build-extension <request>` in a disposable workspace. The bundled authoring workflow uses installed API documentation and verifies the result through the real install, reload, and remove path. See [Extensions](extensions.md), [Package authoring and the local gallery](packages.md), and the [Extension TUI](tui.md).

## 7. Know where data lives

The self-contained launcher keeps application and user data under `~/.rigyn`:

```text
~/.rigyn/app/                 installed application
~/.rigyn/config/rigyn/        configuration, credentials, trust, user resources
~/.rigyn/state/rigyn/         sessions and model catalogs
~/.rigyn/cache/               installation and runtime caches
```

Direct development runs use the normal XDG locations instead:

```text
~/.config/rigyn/              configuration, credentials, trust, user resources
~/.local/state/rigyn/         sessions and model catalogs
```

`XDG_CONFIG_HOME` and `XDG_STATE_HOME` replace those roots when set. Run `rigyn config` to open package-resource configuration and `/settings` for common interactive settings. The complete locations, precedence, keybindings, instructions, and trust behavior are in [Configuration](configuration.md).

## 8. Update, diagnose, or remove

After the npm package is published, update from any directory. Every installation can run the remaining diagnostic and removal commands:

```sh
rigyn self-update
rigyn diagnostics ./rigyn-support.json
rigyn extensions doctor
rigyn uninstall --yes
```

`self-update` installs `rigyn@latest`; before that package exists, update the source checkout and rerun `node scripts/install-user.mjs`. Close other running Rigyn processes before update or uninstall. Uninstall removes the marker-verified self-contained application and its configuration, credentials, sessions, cache, and managed command. It does not delete the source checkout or your project workspaces.

For common failures, see [Troubleshooting](troubleshooting.md), [Platform notes](platforms.md), and [Local diagnostics](diagnostics.md).

## Where to go next

- Learn the terminal workflow: [README terminal workflow](../README.md#terminal-workflow) and [Runtime cookbook](cookbook.md).
- Build structural terminal UI for an extension: [Extension TUI](tui.md).
- Configure providers and models: [Providers and authentication](providers.md).
- Understand persistence: [Sessions and context](sessions.md) and [Context compaction](compaction.md).
- Install or author extensions: [Extensions](extensions.md) and [Packages](packages.md).
- Automate or embed Rigyn: [RPC](rpc.md), [Embedding](embedding.md), and [Public API](public-api.md).
- Understand the implementation: [Architecture](ARCHITECTURE.md).
