# Getting started

This guide takes a new installation from an empty terminal to a useful, resumable coding session. For a complete topic list, see the [documentation map](README.md).

## What rigyn does

rigyn connects a model to a small set of tools running on your computer:

1. You enter a task in the terminal interface or as a one-shot command.
2. rigyn sends the conversation and tool definitions to the selected provider.
3. The model may request file reads, shell commands, or edits.
4. rigyn executes those requests locally, returns bounded results to the model, and renders the work as it happens.
5. rigyn saves the session locally so you can continue, branch, compact, or export it later.

The default tools are `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`. The same default applies to interactive, print, JSON, RPC, and direct SDK sessions. They run with the permissions of the user who launched rigyn. Project trust controls whether project-local configuration and executable extensions load; it does not approve individual shell commands or create a sandbox.

Model requests leave your machine when you choose a hosted provider. Use a local provider such as Ollama when the model must also run locally.

## 1. Install rigyn

For a private per-user installation, first install a supported 64-bit Node.js 24.15+ or 26+ runtime and npm:

```sh
node --version
npm --version
```

Then run the one-line installer for your platform.

Linux or macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/rigyn/rigyn/main/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/rigyn/rigyn/main/install.ps1 | iex
```

The installers fetch and verify all four package archives from the latest GitHub release. They require no npm account
and do not resolve rigyn from the npm registry. The equivalent version-pinned manual command is:

```sh
npm exec --yes \
  --package=https://github.com/rigyn/rigyn/releases/download/v0.6.0/rigyn-terminal-0.6.0.tgz \
  --package=https://github.com/rigyn/rigyn/releases/download/v0.6.0/rigyn-models-0.6.0.tgz \
  --package=https://github.com/rigyn/rigyn/releases/download/v0.6.0/rigyn-kernel-0.6.0.tgz \
  --package=https://github.com/rigyn/rigyn/releases/download/v0.6.0/rigyn-0.6.0.tgz \
  -- rigyn self-install
rigyn --version
```

This uses npm's one-shot package executor with version-pinned GitHub assets rather than a global npm installation.

Alternatively, the standalone GitHub archive for your platform includes its own runtime and needs neither Node.js nor
npm; extract it and run `bin/rigyn` (`bin\rigyn.cmd` on Windows).

To install from the public source checkout instead:

```sh
git clone https://github.com/rigyn/rigyn.git
cd rigyn
npm run install:user
rigyn --version
```

The managed one-line installer and source-install route create a self-contained installation under `~/.rigyn`. They do not create a global npm package or link the executable back to the source checkout. On Linux and macOS the command launcher is `~/.local/bin/rigyn`; on Windows it is `%USERPROFILE%\.rigyn\bin\rigyn.cmd`. See [Installation and platform troubleshooting](install.md) if the command is not on `PATH`.

## 2. Open a workspace

Launch rigyn from the project you want it to work on:

```sh
cd /path/to/your/project
rigyn
```

The launch directory becomes the workspace. It determines the starting directory for tools, the project instruction and resource roots, and which sessions `/resume` shows by default. You can launch the global `rigyn` command from any directory; it does not run inside or modify the rigyn source checkout merely because that checkout was used for installation.

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

## 4. Give rigyn a task

Start with a task that has a concrete result and a verification step:

```text
Explain how this project starts, then identify the smallest safe fix for the failing test. Do not edit yet.
```

After reviewing the answer, ask it to implement and verify the change. rigyn displays model text, reasoning summaries when supplied by the provider, bounded live command output, complete retained tool details after completion, edits, token usage, cache usage, and cost metadata when known. `Ctrl+T` expands reasoning summaries.

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

Use `--max-steps NUMBER` to bound model turns for this invocation and
`--max-output-tokens NUMBER` to bound the output requested for each model turn.
Both require positive safe integers. `--max-steps` adds a bound only for the
current invocation; without it, the outer agent loop has no fixed step count.

## 5. Continue or branch the work

Sessions are saved automatically. To continue the most recent session in the current workspace:

```sh
rigyn --continue
```

To choose one:

```sh
rigyn --resume
```

Inside the interface, use `/resume`, `/new`, `/name`, `/tree`, `/fork`, and `/clone`. The normal picker is workspace-scoped. Use `/resume --all` or the CLI `rigyn --resume --all` to search saved sessions from every workspace.

Automatic context compaction keeps long sessions within the selected model's context window. `/compact` triggers it explicitly. See [Sessions and context](sessions.md), [Context compaction](compaction.md), and the [session export contract](session-export.md) for recovery, branching, retention, import, and export behavior.

## 6. Add reusable behavior

rigyn separates four resource types:

- A **skill** is on-demand instruction content. Only its name and description stay in the base prompt; full guidance loads when relevant.
- A **prompt template** is a reusable slash command with arguments and defaults.
- A **theme** is a terminal presentation resource; rigyn ships the default monochrome `mono` and operational `signal` themes, and can discover custom themes.
- A **runtime extension** is trusted code that can add tools, commands, providers, authentication, state, events, shortcuts, and structural UI.

A **package** distributes one or more of those resources. Installed runtime extensions activate inside the current rigyn process and extend that harness; they do not need to launch a second rigyn instance.

Install and inspect a reviewed package with:

```sh
rigyn install ./my-package
rigyn list
rigyn extensions doctor
rigyn remove my-package
```

Use `rigyn --extension ./my-package/extensions/index.mjs` for one invocation without persisting the package. Runtime extensions are ordinary Node.js code with your user's access, so review the package, its runtime entries, and production dependencies first. Dependency lifecycle scripts may be enabled only for reviewed install or update transactions with `--allow-scripts`.

To have rigyn build a package, enter `/build-extension <request>` in a disposable workspace. The bundled authoring workflow uses installed API documentation and verifies the result through the real install, reload, and remove path. See [Extensions](extensions.md), [Package authoring and the local gallery](packages.md), and the [Extension TUI](tui.md).

## 7. Know where data lives

The self-contained launcher keeps application and user data under `~/.rigyn`:

```text
~/.rigyn/app/                 installed application
~/.rigyn/agent/               settings, auth, sessions, models, and user resources
~/.rigyn/cache/               installation and runtime caches
```

Direct development runs use the normal agent directory:

```text
~/.rigyn/agent/
```

Set `RIGYN_CODING_AGENT_DIR` to choose another root. A self-contained install scaffolds `AGENTS.md` and `settings.json` inside its agent directory and preserves both on reinstall or update. Put personal instructions in `AGENTS.md`; project `AGENTS.md` files load afterward from outer ancestors through the active working directory. Run `rigyn config path` to print the settings location and `rigyn config edit` to open it transactionally. Add `--scope project` for the trusted workspace file. `rigyn config` without an action selects resources from installed packages, and `/settings` covers common interactive preferences. The complete locations, precedence, keybindings, instructions, and trust behavior are in [Settings](configuration.md).

## 8. Update, diagnose, or remove

Update from any directory. Every installation can run the remaining diagnostic and removal commands:

```sh
rigyn self-update
rigyn diagnostics ./rigyn-support.json
rigyn extensions doctor
rigyn uninstall --yes
```

`self-update` downloads and verifies the latest public GitHub release. Close other running rigyn processes before
update or uninstall. Uninstall removes the marker-verified self-contained application and its configuration,
credentials, sessions, cache, and managed command. It does not delete the source checkout or your project workspaces.

For common failures, see [Troubleshooting](troubleshooting.md), [Platform notes](platforms.md), and [Local diagnostics](diagnostics.md).

## Where to go next

- Learn the terminal workflow: [README terminal workflow](../README.md#terminal-workflow) and [Runtime cookbook](cookbook.md).
- Build structural terminal UI for an extension: [Extension TUI](tui.md).
- Configure providers and models: [Providers and authentication](providers.md).
- Understand persistence: [Sessions and context](sessions.md) and [Context compaction](compaction.md).
- Install or author extensions: [Extensions](extensions.md) and [Packages](packages.md).
- Automate or embed rigyn: [RPC](rpc.md), [Embedding](embedding.md), and [Public API](public-api.md).
- Understand the implementation: [Architecture](ARCHITECTURE.md).
