# Extension capability matrix

The machine-readable companion [`extension-capabilities.json`](extension-capabilities.json) maps every major extension surface to its supported hosts, authoritative documentation, focused references, and verification tests. Repository tests validate every path and public API member so the authoring kit cannot silently point to deleted or invented functionality.

Each row uses one of the audit states: `implemented`, `intentionally-different`, `missing`, or `rejected-for-safety`. Optional products that remain extensions are intentionally different, not missing core behavior. A rejected capability is a boundary the host deliberately refuses to expose.

Packages are containers; their runtime modules, tools, providers, commands, events, state, skills, prompts, and themes are loaded by the active Rigyn process. An ordinary extension does not launch another Rigyn process. External processes are used only when the extension's actual boundary requires one, such as a fixed command, an MCP stdio server, or an explicitly isolated executor.

All hosts project discovery through one bounded resource catalog. Provider-native deferred tool search is an optimization for explicitly deferred definitions on verified model families; unsupported, disabled, proxied, and unknown cases keep the portable full-definition behavior.

Runtime extensions can reconstruct a reconnect snapshot through the bounded, branch-safe `api.getTranscript` projection. It exposes only transcript-visible presentation data and cursor metadata; raw event envelopes and provider/credential state remain host-private.

Extensions choose a reconnect target through bounded current-workspace `api.listSessions` metadata and keep non-session files below host-created `api.dataPaths` roots. These paths are outside installed package contents in production and never contain host credentials.

Bundled examples are read-only authoring references. The `build-extension` skill directs the agent to choose the smallest relevant example and create the requested package in a fresh directory inside the active workspace. It must then verify the exact package through install, reload, execution, and removal.

The `extensions author` developer commands validate and inspect a temporary managed copy, exercise activation/disposal and candidate-first repeated activation, inspect the exact npm pack file set, build an explicitly requested archive, and normalize public discovery metadata. These checks never install into the user's active package roots. See [Package discovery index](package-gallery.md).

Rigyn intentionally does not bundle a dashboard or subagent product. Those are optional packages that users can create or install. The core supplies the extension, session, UI, RPC, package, and process contracts needed to implement them without editing the harness. Agent-style packages delegate through the bounded in-process `api.runChild` contract; they do not launch a second harness process. Child results report normalized usage, execution routing, and bounded artifact metadata. Extensions can request graceful host shutdown through an acknowledged policy gate; they cannot terminate the owner directly.

Host names mean:

- `tui`: interactive terminal host;
- `print` and `json`: headless single-run hosts;
- `rpc`: a correlated RPC client, including negotiated extension UI;
- `embedding`: the public in-process owner API.

An omitted host means that the capability is not directly available there. Interactive dialogs need a TUI or negotiated RPC UI owner; they reject instead of hanging in print, JSON, or embedding hosts. The matrix separates commands, shortcuts, flags, tool renderers, session focus, shutdown, and reload because those surfaces intentionally have different host lifecycles.
