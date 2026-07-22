# Sessions and context

Rigyn stores each durable conversation as one append-only JSONL file. The file is the source of truth: there is no session database, background index, or separate memory service.

## Session lifecycle

Interactive commands:

```text
/new                 start a new session
/resume [REFERENCE]  select or open a saved session
/name NAME           set the session name
/session             show the active file and model selection
/tree                 navigate the in-file history tree
/fork                 create a separate session from an earlier point
/clone                duplicate the active branch into a separate session
/compact [FOCUS]      compact older context, optionally with a focus
/export [FILE]        export the active session
```

The equivalent startup options include `--continue`, `--resume`, `--session`, `--session-id`, `--fork`, `--session-dir`, and `--no-session`. Catalogs and pickers are scoped to the launch workspace unless `--all` is selected. Exact IDs, unambiguous ID prefixes, exact names, and explicit `.jsonl` paths are accepted; ambiguous references fail. Selecting an explicit path, name, or ID owned by another workspace requires confirmation and forks it into the launch workspace instead of silently adopting the recorded workspace.

Starting a new session does not silently copy facts from unrelated sessions. `/resume` restores a previous conversation; durable cross-session memory is an extension concern and must remain explicit to the user.

## Storage layout

With the default data directory, sessions are grouped by canonical workspace beneath:

```text
~/.rigyn/agent/sessions/
```

`RIGYN_CODING_AGENT_DIR` changes the agent root. `--session-dir` can select a different session directory for one invocation.

The first non-empty line is the session header:

```json
{"type":"session","version":3,"id":"...","timestamp":"...","cwd":"..."}
```

Every later line is an immutable entry with its own `id`, `parentId`, and timestamp. Entry kinds include messages, model and thinking-level changes, compactions, branch summaries, extension entries/messages, labels, and session-name changes. A `parentId` of `null` starts a root; multiple children create branches. The active leaf is reconstructed from the file.

Version 1 and 2 files are migrated to version 3 when opened. Migration rewrites only the selected session file. Keep ordinary backups before opening old pre-release data with a newer build.

## Resume and discovery

`SessionManager.list(cwd)` scans only the canonical directory for that workspace. `SessionManager.listAll()` scans every workspace directory below the configured session root. Listing reads at most ten files concurrently and derives names, previews, timestamps, and message counts from the files themselves; it does not depend on a mutable database index. Results use a stable path tie-breaker when activity times match, and catalog pagination rejects a missing cursor instead of restarting at the first page.

`--continue` opens the most recently modified session in the current workspace. `--resume` opens the interactive selector. `--all` preserves their explicit all-workspace behavior. An explicit cross-workspace `--session` selection is confirmed and copied into a new file owned by the current workspace; `--fork` performs that copy directly.

`rigyn sessions doctor` scans the canonical JSONL files and reports invalid files with their diagnostics. `--all` checks every workspace. The command does not create a database index, rewrite damaged records, or offer an index-repair mode.

## Crash behavior

Entries are appended as complete JSON records followed by a newline. Only an unterminated final fragment from an interrupted write is ignored. Before the next append, that fragment is removed; a valid final JSON record that only lacks its newline is preserved and separated from the new entry. Malformed newline-terminated JSON is reported with its line number and the file is left unchanged, so corruption earlier in the history is never mistaken for crash recovery. Rigyn does not replay an unfinished external side effect merely because the terminal closed.

Only one process should actively append to a particular session file. Separate processes should use separate sessions or coordinate through a higher-level extension. Session files are private local data and may contain prompts, model output, tool arguments/results, file paths, and provider-visible content.

## Context reconstruction

The active branch is followed from the current leaf through `parentId` links. Context reconstruction then:

- applies the latest reachable model and thinking-level selections;
- starts from the latest reachable compaction boundary;
- preserves valid user, assistant, tool-call, and tool-result ordering;
- includes visible extension messages intended for model context;
- includes branch summaries when navigation carries work across branches;
- excludes extension state records that are not model messages.

Provider-specific request conversion happens after this canonical branch context is built. Provider continuation state is sent only through a compatible provider transport.

## Compaction

Automatic compaction runs near the selected model's context limit. Manual `/compact [FOCUS]` uses the same planner and extension lifecycle. A compaction entry stores the generated summary, the first retained entry ID, tokens before compaction, optional normalized summary-model usage, and optional details. That usage contributes to session statistics. Original entries remain in the JSONL file and can still be reached through the tree; compaction changes the projected context, not the historical file.

Branch navigation can similarly append a summary of the abandoned path before moving the active leaf. Existing entries are never rewritten to create a branch.

See [Context compaction](compaction.md) for the planner, thresholds, extension events, and usage accounting.

## Extension-owned entries

Trusted direct extensions can append custom state or custom messages through the session API. Both use the same append-only tree and therefore follow the selected branch. Custom state is not inserted into model context. Custom messages enter model context; their `display` field controls transcript visibility. Registered entry and message renderers are resolved from the active extension generation for both live appends and resumed history, so reload does not rewrite or duplicate session data.

Extensions receive the active session manager through their generation-bound context. A captured context becomes stale after reload or session replacement and must not be reused.

## Export and sharing

The live session file is already machine-readable JSONL. `exportToJsonl()` copies that file without changing identities or content. Self-contained HTML presentation exports contain transcript material and must be treated as sensitive.

Rigyn does not promise that an ordinary export is anonymized. Inspect any exported file before sharing it, especially tool output, paths, prompts, and extension-authored content. See [Session export](session-export.md) for the exact behavior.
