# Extension capability matrix

The machine-readable [`extension-capabilities.json`](extension-capabilities.json) maps the supported direct factory surface to hosts, documentation, focused examples, and executable tests. Repository tests validate every referenced path.

Rigyn has one trusted in-process extension model. Packages declare direct entries in `package.json`; successful factories register commands, tools, events, providers, UI, and resources in the active process. Failed candidates commit nothing. Reload replaces a complete generation and runs its disposers after making the old API stale.

The twenty-two examples are intentionally focused:

- `starter`: commands and tools;
- `lifecycle-events`: lifecycle observation and disposal;
- `command-controls`: flags, commands, and shortcuts;
- `tool-rendering`: built-in tool replacement and rendering;
- `input-guard`: input transformation and tool-call blocking;
- `ui-surfaces`: status, header, widget, and overlay components;
- `context-compaction`: prompt transformation, usage, and compaction;
- `messages-bus`: shared topics, custom messages, and rendering;
- `model-controls`: model inspection and thinking selection;
- `provider-override`: generation-owned provider replacement;
- `raw-editor-ui`: primary editor replacement through public TUI exports;
- `session-jsonl`: read-only current-session inspection;
- `session-control`: explicit session transitions;
- `session-metadata`: naming, custom entries, labels, and rendering;
- `subprocess-workers`: bounded argv-based process execution;
- `dynamic-package`: runtime-discovered skills and prompts.
- `provider-hooks`: request mutation plus complete request/response header observation for trusted direct extensions;
- `runtime-catalog`: active tools, model selection, discovery, and user-message delivery;
- `session-lifecycle`: session guards, compaction, tree events, and navigation;
- `provider-catalog`: custom providers, managed OAuth callbacks, and refreshed catalogs;
- `terminal-workbench`: terminal input, editor helpers, themes, and tool expansion;
- `project-trust`: invocation-scoped interactive trust decisions.

Host names are `tui`, `print`, `json`, `rpc`, and `embedding`. UI-only behavior is marked only for `tui`; registrations and session/process contracts are available wherever the host binds their required context. A package must still provide safe headless behavior when a dialog or visual component is unavailable.
