# Extension capability matrix

The machine-readable [`extension-capabilities.json`](extension-capabilities.json)
maps each supported direct-factory capability to its hosts, public API members,
owned event/result contracts, documentation, examples, and executable tests.
Repository tests validate every referenced path and require every public event
to have exactly one capability owner.

rigyn has one trusted in-process extension model. A package declares direct entries in `package.json`. A successful factory publishes its commands, tools, events, providers, UI, and resources together. A failed candidate publishes nothing. Refresh replaces the complete generation, makes the old API stale, and then runs its disposers.

## Focused examples

| Example | Capability |
| --- | --- |
| `starter` | Commands and tools |
| `lifecycle-events` | Lifecycle observation and disposal |
| `command-controls` | Flags, commands, and shortcuts |
| `tool-rendering` | Built-in tool replacement and rendering |
| `input-guard` | Input transformation and tool-call blocking |
| `ui-surfaces` | Status, header, widget, and overlay components |
| `context-compaction` | Prompt transformation, usage, and compaction |
| `messages-bus` | Shared topics, custom messages, and rendering |
| `model-controls` | Model inspection and thinking selection |
| `provider-override` | Generation-owned provider replacement |
| `raw-editor-ui` | Primary editor replacement through public TUI exports |
| `session-jsonl` | Read-only current-session inspection |
| `session-control` | Explicit session transitions |
| `session-metadata` | Naming, custom entries, labels, and rendering |
| `subprocess-workers` | One-shot and managed asynchronous argv process execution |
| `dynamic-package` | Runtime-discovered skills and prompts |
| `provider-hooks` | Request mutation and complete request/response header observation for trusted direct extensions |
| `runtime-catalog` | Active tools, model selection, discovery, and user-message delivery |
| `session-lifecycle` | Session guards, compaction, tree events, and navigation |
| `provider-catalog` | Custom providers, managed OAuth callbacks, and refreshed catalogs |
| `terminal-workbench` | Terminal input, editor helpers, custom themes, and tool expansion |
| `project-trust` | Invocation-scoped interactive trust decisions |
| `state-and-policy` | Extension-owned workspace memory, task state, and protected-path preflight |

Host names are `tui`, `print`, `json`, `rpc`, `serve`, and `sdk`. Direct SDK and
embedding sessions report the first-class headless `sdk` mode. Only TUI-specific
behavior is marked `tui`. Registrations and session/process contracts work in
any host that binds their required context. Packages must still fail safely when
a dialog or visual component is unavailable.

The HTTP service keeps session identity under its endpoint registry. Extension
commands can navigate the current tree and refresh resources there, but
`newSession`, `fork`, and `switchSession` return `{ cancelled: true }`; clients
create or open another service session through the documented HTTP endpoints.
