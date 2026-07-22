# Rigyn

Rigyn is a local-first coding agent for the terminal. Launch it inside a project, describe an outcome, and the selected model can inspect files, run commands, and edit code through bounded tools. Sessions, branches, model choices, usage, and extension state are stored locally so work can continue in a later terminal.

Rigyn supports multiple model providers and their available authentication methods, including OAuth where the provider offers it. It includes an interactive TUI with one built-in monochrome theme, one-shot and JSON modes, resumable append-only JSONL sessions, context compaction, image input, skills, prompt templates, custom themes, and trusted TypeScript extension packages. Extensions run inside the active harness and can add tools, commands, providers, authentication, state, events, and UI.

Runtime extensions and `bash` execute with your operating-system user privileges. Review executable packages before enabling them; Rigyn is not a process sandbox.

The `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` tools are active by default across interactive, print,
JSON, RPC, and direct SDK sessions.

## Install and start

With a supported Node.js 24.15+ or 26+ runtime and npm installed, one command installs the complete verified GitHub
release into a private per-user directory:

```sh
curl -fsSL https://raw.githubusercontent.com/Rigyn/rigyn/main/install.sh | sh
```

On Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/Rigyn/rigyn/main/install.ps1 | iex
```

Neither command needs an npm account or downloads a Rigyn package from the npm registry. To install without Node.js
or npm, download the standalone archive for your platform from the
[v0.5.1 GitHub release](https://github.com/Rigyn/rigyn/releases/tag/v0.5.1), verify it against the release
`SHA256SUMS`, and extract it. The archive includes its own Node.js runtime and production dependencies.

```sh
tar -xzf rigyn-v0.5.1-linux-x64.tar.gz
cd /path/to/your/project
/path/to/rigyn-v0.5.1-linux-x64/bin/rigyn
```

Use `bin/rigyn` on Linux or macOS and `bin\rigyn.cmd` on Windows. The
[complete product guide](packages/rigyn/README.md) covers every platform, a private per-user installation from the
same GitHub release, and source installation.

On first run, use `/login` to connect a provider and `/model` to select one of its currently available models. The
directory where Rigyn starts is the workspace unless `--workspace DIR` is supplied. User state lives under
`$HOME/.rigyn`; the standalone executable stays in the extracted archive, while the optional private installer also
places the application there. Neither route uses npm's global package directory or redirects execution into this
source checkout.

Useful commands include `/settings`, `/model`, `/scoped-models`, `/new`, `/resume`, `/tree`, `/compact`, `/reload`, `/export`, `/share`, and `/hotkeys`. A one-shot task can be run with:

```sh
rigyn -p "Review this project and explain its architecture"
```

The private installer creates editable `~/.rigyn/agent/AGENTS.md` and `settings.json` templates and preserves them on updates. Personal instructions load first from that `AGENTS.md` (or
`$RIGYN_CODING_AGENT_DIR/AGENTS.md`), then from project `AGENTS.md` files in ancestor order. Run
`rigyn config path` to locate the complete user settings document, `rigyn config edit` to edit it safely, or add
`--scope project` for the trusted workspace settings file.

Read the complete product guide for providers, sessions, configuration, terminal controls, extensions, embedding,
RPC, security boundaries, and troubleshooting. The [documentation map](packages/rigyn/docs/README.md) links every
focused reference.

## Packages

- [`rigyn`](packages/rigyn) — the terminal application, session runtime, extension host, and public application API.
- [`@rigyn/models`](packages/models) — canonical messages, model metadata, provider transports, OAuth helpers, and streaming utilities.
- [`@rigyn/kernel`](packages/kernel) — the reusable agent loop and queue/lifecycle primitives.
- [`@rigyn/terminal`](packages/terminal) — terminal input, rendering, components, layout, themes, and native helpers.

## Development

```sh
npm install
npm run check
```

The repository root is a private workspace container. Release tooling uploads only validated artifacts to GitHub
Releases. See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the
[release procedure](packages/rigyn/docs/releasing.md).

## License

Rigyn is released under the [MIT License](LICENSE).
