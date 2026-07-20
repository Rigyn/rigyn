# Sessions and context

Rigyn treats continuity as durable event history, not as a transcript file that is rewritten after every turn.

## Session lifecycle

By default, a new workspace conversation is stored in the global SQLite database and indexed by canonical workspace path. Use:

```text
/new       create a fresh session
/resume    select a saved session
/session   inspect the current session
/context   inspect content-free prompt, tool, instruction-source, and skill provenance for the latest run
/name      change its display name
/fork      continue from an earlier event on a new branch
/clone     copy the current reachable history into a new session
/tree      navigate history and branches
/export [--redact] [FILE]
           write a presentation export; --redact creates a review-required share copy
/share [FILE]
           create a redacted local copy, or a secret GitHub gist when FILE is omitted
/import    import a session export
```

`/context` reads only the latest reachable run on the current branch. It reports hashes, byte counts, tool names, and redacted source/skill identities for the host-composed prompt without displaying instruction or prompt bodies. It does not fall back to older metadata when the latest run lacks provenance, and it labels that case explicitly. Runtime `before_agent_start` extensions may transform the prompt after the recorded host composition, so this report is provenance rather than a provider-request dump and is not a share-safety guarantee.

The CLI equivalents include `--continue`, `--resume`, `--session`, `--session-id`, `--fork`, `--workspace`, `--session-dir`, `--name`, and `--no-session`. Add `--all` to `--continue`, `--resume`, or `--session` to search every indexed workspace instead of only the selected launch workspace. For example:

```sh
rigyn --continue --all --workspace ~/another-project
```

Machine-readable JSONL exports start with an explicit format and schema version. See [Session JSONL export contract](session-export.md) for record ordering, import identity remapping, limits, and compatibility guarantees.

From a shell, `rigyn --export share.html --redact` and `rigyn --export share.md --redact` create presentation-only copies that remove tool payloads, persisted `!` shell shortcut output, images, artifacts, structural IDs, and exact timestamps while redacting known secret patterns and workspace/home roots. Redacted JSONL is refused before output creation. This reduces accidental disclosure but does not guarantee anonymization; review the entire copy before sharing it.

In the TUI, `/share FILE` writes the same owner-only redacted presentation copy. Bare `/share` creates a secret GitHub gist through an authenticated `gh` installation, reports its URL, and deletes the temporary local file. This is an explicit external publication action: redaction lowers accidental disclosure risk but cannot prove anonymity, so review the resulting gist before distributing its link. If `gh` is unavailable or unauthenticated, use `/share FILE` and upload only after manual review.

Session lookup is workspace-scoped unless `--all` is used or an explicit verified database reference is supplied. Exact IDs and unambiguous partial IDs are accepted; ambiguous references fail instead of guessing.

The all-workspace catalog is a derived private index, not the source of session history. Every durable launch refreshes its current workspace. When that index is absent or empty, Rigyn backfills every still-existing durable workspace recorded in the shared session database, so upgrading an older installation does not hide prior projects. If the derived index alone has an invalid schema or SQLite corruption, Rigyn discards and rebuilds it automatically; it never treats source-session corruption, a busy database, or an unsafe path as rebuildable. Missing or replaced workspace paths are skipped with a warning and are verified again before any cross-workspace resume.

Resuming a session and remembering across sessions are different contracts. `/resume`, `--continue`, and `--session` restore the exact durable thread, including its branch, model, thinking level, summaries, and recent history. A new session does not silently import facts from unrelated conversations. Cross-session recall is an opt-in extension concern: use the bounded `api.listSessions` plus `api.getTranscript` surface and store any derived index under the extension's owned data path. This keeps private history scoped and makes memory behavior visible and removable.

Interactive resume rebuilds only a bounded recent transcript projection so a very large saved thread cannot freeze the terminal. Older events remain in the canonical session, continue to participate in provider-context reconstruction and exports, and are never deleted by this display limit.

## Event model

The store records immutable, monotonically sequenced events. Branches point to event heads, runs record lifecycle state, and artifacts hold bounded binary outputs. A canonical message may contain text, images, tool calls, tool results, or provider-owned opaque state. Provider state is projected only back to its compatible adapter.

SQLite foreign keys prevent branches, runs, events, and artifacts from crossing thread boundaries. Only one non-terminal run may exist for a thread. Writes use transactions and a busy timeout, and database files and sidecars are created with private permissions. The runtime requires SQLite 3.51.3 or newer and refuses an older embedded SQLite before opening a durable session.

## Database schema upgrades

The session database has an integer SQLite schema version and an ordered `schema_migrations` history. A fresh database is created directly at the current schema. An existing supported database is upgraded through every retained intermediate migration in one `BEGIN IMMEDIATE` transaction; data changes, migration-history rows, and `PRAGMA user_version` commit together or all roll back. A database from a newer Rigyn build is refused before migration metadata is written.

Rigyn is pre-1.0, so the supported upgrade floor is explicit rather than implied. This build uses schema 18 and supports a direct upgrade from schema 13. Schema 18 adds host-owned runtime-child classification that is committed atomically with child session creation and is not part of session export; schema 17 added indexed branch incarnations so cursor paging remains exact when a deleted branch name is reused without scanning unrelated history. Schemas 1 through 12 predate the retained migration history and are refused without schema changes; use the corresponding older build to upgrade or export them before opening the result with this build. Keep a backup before crossing pre-release versions.

From schema 13 onward, schema changes must append an ordered migration instead of replacing an older step. Each step has a predecessor fixture and rollback coverage. Raising the upgrade floor before 1.0 requires an explicit release note and a documented export or intermediate-upgrade path.

Normal session writes remain append-only. The schema 13 compatibility migration is a bounded exception for retired pre-release records: it preserves event IDs, sequence numbers, timestamps, and ancestry, removes one obsolete message-purpose field, and replaces removed subsystem events with visible tombstone warnings. It does not rewrite unaffected events.

## Database diagnostics and index repair

Run `rigyn sessions doctor` with every Rigyn process closed when a session database is suspected of corruption. Doctor is read-only and runs SQLite's full integrity check, a foreign-key check, and an exact schema-version check. `--json` returns the bounded structured report.

If doctor reports only rebuildable index damage, run `rigyn sessions repair --reindex --yes`. Repair creates a private, uniquely named pre-repair backup beside `sessions.sqlite`, rebuilds indexes inside a transaction, and commits only after the full integrity and foreign-key checks pass. A failed check rolls the repair back and retains the backup path shown in the error. The command never deletes data or attempts general page recovery; restore a verified backup for table/page damage or foreign-key violations.

## Crash recovery

Each active runtime holds a UUID lease in SQLite. The process ID is stored only for diagnostics; ownership is fenced by the UUID and a monotonically increasing generation, with a renewable expiry. Active runs and in-flight queue items carry that ownership token. A second live runtime can read the same database but cannot recover or mutate another live runtime's work. Clean shutdown closes the lease. An expiry makes abandoned work eligible for recovery, but the same generation may renew late after a suspend or event-loop delay when no recovery won the SQLite write race. Recovery atomically closes an expired owner before claiming its work, so a stale generation cannot renew or write afterward.

On startup, unfinished runs are inspected against their durable events:

- a tool that was planned but never started can be retried by a later run;
- a tool that started but did not durably finish is marked as an unknown outcome;
- a completed result is never replayed merely because the process died afterward;
- malformed durable events stop recovery rather than causing a partial repair.

Steering and follow-up messages use a durable queue with explicit leases. Recovery returns only genuinely undelivered items to the queue and preserves order across branches.

## Context projection

Before a provider call, reachable history is projected into a valid request:

- system instructions remain ordered and provider-neutral;
- tool calls stay paired with exactly one matching result;
- orphaned, duplicate, abandoned, or malformed historical tool blocks are removed;
- the active turn may retain a pending call needed for execution;
- provider-owned opaque blocks are kept only for the matching provider;
- unsupported or blocked images become bounded markers rather than leaked payload data.

The token estimator uses normalized text and structural overhead. When the provider reports authoritative usage for the same request fingerprint, that observation may raise the conservative estimate but never lower it unsafely.

## Automatic compaction

The model catalog supplies the context window and output limit when possible. Otherwise the fallback window is 128,000 tokens. The default output reserve is 16,384 tokens.

Compaction proceeds in stages:

1. bound old tool results while keeping call/result structure;
2. group messages into complete turns;
3. keep roughly 20,000 recent tokens and at least two recent turns;
4. summarize only an older, complete, tool-safe prefix;
5. store the summary and its exact source message IDs as durable events;
6. retry the request once when a typed provider context-overflow error requires it.

The summarizer receives any previous durable summary separately, allowing iterative compaction without recursively inflating it. Opaque provider state is removed from summary input. The summary cannot introduce tool calls or claim source IDs outside the plan.

Manual `/compact [INSTRUCTIONS]` uses the same planner and can request a focus. Runtime extensions can guard or replace a planned summary through the session compaction events.

See [Context compaction](compaction.md) for configuration, selection rules, cache interaction, and troubleshooting.

## Branch navigation

`/tree` can move the branch head to a selected historical event. If requested, the harness generates a bounded summary of the abandoned path and attaches it at the continuation point. Branch navigation never mutates existing events, so the original path remains inspectable and resumable.

Programmatic navigation can add `summaryInstructions`; `replaceInstructions: true` makes a non-empty instruction override the default summarizer prompt instead of appending a focus. Before mutation, `session_before_tree` receives the target, old leaf, common ancestor, and the exact bounded/redacted event projections selected as summary input. It may cancel, provide a bounded summary, or override the instructions, replace flag, and label. The final non-cancelling result wins as one object, and omitted fields fall back to the caller's values.

A label targets the new summary when one is created. Without a summary—including an empty abandoned path—it targets the selected event, and the fork plus label event commit atomically. Empty labels suppress label creation. An empty abandoned path does not call the summary provider, but the guard still runs and navigation can proceed.

Session selections for provider, model, and thinking level are also evented. They survive restart and follow reachable branch history rather than leaking from an unrelated branch.

Extension-owned state follows the same reachable branch history. `api.session.compareAndAppendState` compares the prior state event ID and appends the replacement in one SQLite write transaction, so separate harness processes cannot silently lose a read-modify-write update. An omitted branch resolves to the thread's canonical default branch and is returned in both committed records and conflict results.

Namespaced extension messages use backward opaque pagination. The first `api.session.readMessages` call returns the latest bounded chronological page. Passing that page's first `eventId` as `beforeEventId` returns the preceding page only when the cursor belongs to the same reachable branch, extension ID, schema version, and optional message kind. See [`paged-memory`](../examples/paged-memory/README.md) for a focused cursor loop.

`api.getSessionUsage({ threadId, branch? })` reconstructs normalized token, cache, duration, server-tool, and cost totals from durable usage events, so the result remains available after a process restart. It also returns provider-neutral cache-effectiveness counters without estimating money saved. `api.getSystemPromptSnapshot` exposes the latest durable host instruction message only through an explicit branch query and credential-pattern redaction; provider state, authentication material, and request headers remain unavailable. The focused [`session-analytics`](../examples/session-analytics/README.md) and [`prompt-inspector`](../examples/prompt-inspector/README.md) packages demonstrate the two boundaries; [`session-tools`](../examples/session-tools/README.md) combines workspace-scoped discovery with bounded transcript paging.

## Safe transcript replay

Runtime extensions discover selectable sessions through `api.listSessions({ search?, cursor?, limit?, signal? })`, not by opening SQLite. Pages contain only bounded name, ID, default-branch, and timestamp metadata for the service's canonical current workspace. Search matches names and IDs rather than raw event payloads, and an opaque pagination cursor cannot widen workspace scope.

Extensions that need conversation history then use `api.getTranscript`, not the raw event store. The caller names a returned thread and optional branch, then follows the exclusive `nextSequence` cursor while `hasMore` is true. The service first verifies that the session belongs to the active workspace and that the branch exists.

Replay pages are capped at 256 entries and one MiB. They contain only transcript-visible text, structural tool status/summaries, visible extension messages, safe summary/status rows, timestamps, event IDs, sequence numbers, and image media metadata without image content or locations. System instructions, provider continuation and opaque state, provider-trace reasoning, extension state/payloads, tool arguments and raw output, raw usage/errors, credentials, headers, and callbacks remain outside this API.

An explicitly trusted package may request `sessionRaw` and use `api.native.session.read` when the transcript projection is insufficient. The caller still names an exact thread/branch and follows bounded sequence pages; the result contains canonical durable event envelopes, run records, saved model selection, and—when requested—provider-neutral compacted context. It is a snapshot rather than a mutable store handle, so branch and transaction ownership remain with the host. `api.native.session.getSystemPrompt` returns an unredacted prompt only while it remains in the current process; Rigyn never reconstructs or persists that secret-bearing value merely to satisfy a later query. Generation abort invalidates both APIs.
