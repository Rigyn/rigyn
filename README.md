# Rigyn

Rigyn is a local-first coding agent for the terminal. Launch it inside a project, describe an outcome, and the selected model can inspect files, run commands, and edit code through bounded tools. Sessions, branches, model choices, usage, and extension state are stored locally so work can continue in a later terminal.

Rigyn supports multiple model providers and their available authentication methods, including OAuth where the provider offers it. It includes an interactive TUI, one-shot and JSON modes, resumable append-only JSONL sessions, context compaction, image input, skills, prompt templates, themes, and trusted TypeScript extension packages. Extensions run inside the active harness and can add tools, commands, providers, authentication, state, events, and UI.

Runtime extensions and `bash` execute with your operating-system user privileges. Review executable packages before enabling them; Rigyn is not a process sandbox.

## Install and start

Node.js 24.15 or a current Node.js 26-or-newer release is required.

```sh
npm exec --yes --package=rigyn@latest -- rigyn self-install
cd /path/to/your/project
rigyn
```

On first run, use `/login` to connect a provider and `/model` to select one of its currently available models. The directory where Rigyn starts is the workspace unless `--workspace DIR` is supplied. A self-contained installation lives under `$HOME/.rigyn`; it does not use npm's global package directory or redirect execution into this source checkout.

Useful commands include `/settings`, `/model`, `/scoped-models`, `/new`, `/resume`, `/tree`, `/compact`, `/reload`, `/export`, `/share`, and `/hotkeys`. A one-shot task can be run with:

```sh
rigyn -p "Review this project and explain its architecture"
```

Read the [complete product guide](packages/rigyn/README.md) for installation alternatives, providers, sessions, configuration, terminal controls, extensions, embedding, RPC, security boundaries, and troubleshooting. The [documentation map](packages/rigyn/docs/README.md) links every focused reference.

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

The repository root is a private workspace container. Release tooling publishes only validated workspace packages. See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the [release procedure](packages/rigyn/docs/releasing.md).

## License

Rigyn is released under the [MIT License](LICENSE).
