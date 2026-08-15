# Local diagnostics

rigyn keeps three kinds of local operational data separate:

```text
<rigynHome>/logs/          continuous metadata-only JSONL records
<rigynHome>/diagnostics/   space reserved for user-requested diagnostic bundles
<rigynHome>/crash/         private redacted failure reports
```

Session journals remain under `<rigynHome>/sessions/`. None of these records is
sent to a remote telemetry service.

## Privacy-ordered diagnosis

A request to diagnose rigyn does not cause any of these files to enter model context automatically. Start with the
installed `rigyn --help` and relevant `rigyn COMMAND --help`, then use the narrowest non-mutating command:

1. `rigyn logs --json` reports recognized file paths and metadata without reading their records.
2. `rigyn stats --json` reads only bounded aggregate snapshots from those recognized logs.
3. `rigyn diagnostics` collects bounded static configuration and resource status without reading logs, crash reports,
   credentials, or sessions.
4. `rigyn config validate --json` checks user configuration. Validate project scope only when it is already trusted.
5. `rigyn sessions doctor --json` validates journal structure without rewriting journals or printing conversation
   content.

These five commands are appropriate read-only starting points when the user places the corresponding Rigyn home or
workspace in scope. Ask before reading raw log records, crash files, or session content. If content is necessary,
select one relevant file and a bounded time or line range rather than ingesting a directory. Never edit a live session
journal. Review and redact every artifact before sharing it.

`rigyn extensions doctor --json --offline` is a separate executable probe. Run it only when extension behavior is
implicated and the user explicitly authorizes activating the already-trusted extension runtime. It may initialize
runtime state, and trusted extension code can perform its own side effects. Never grant project trust merely to run
doctor. Omit `--offline` only when network-dependent extension behavior is necessary and separately authorized.

## Continuous local logs

CLI, TUI, JSON, RPC, and serve runtimes enable local observability at `debug` by
default. Debug adds bounded lifecycle metadata, never prompts, responses, tool
payloads, credentials, or resource content. Use `observability.level` in the global `config.json`, or the
process-only `RIGYN_LOG_LEVEL` override, to select `off`, `error`, `info`, or
`debug` when less local disk activity is preferred. Project settings cannot
change this level. SDK and embedding sessions stay silent unless the caller
supplies an `observabilitySink`.

Find the directory and recognized files without reading their records:

```sh
rigyn logs
rigyn logs --json
```

Both reports expose the fixed redraw-debug path and the diagnostics, crash-report, and effective session directories.
Only recognized continuous-log files are listed with size and modification metadata; the command does not enumerate
or open redraw, diagnostic, crash, or session content. The session path follows `RIGYN_SESSION_DIR`, then a valid
global `sessionDir`, then the default session root. Use `rigyn sessions doctor` for structural session validation.
Log-directory scans inspect at most 10,000 entries. JSON reports set `partial` and human output reports
`Listing: partial` when more entries exist, so an unrelated-file flood cannot make listing unbounded or appear
complete.

All CLI runtime observers in one operating-system process share one JSONL
segment series. A segment rotates at 8 MiB. A process retains four segments,
and startup removes recognized log files older
than seven days. Startup also trims recognized files to leave room within a
128-file and 128 MiB directory policy; concurrent writers can temporarily
exceed that boundary until the next startup pass. Once a segment exists, its
writer attempts a metadata-only mtime heartbeat once per minute. Cleanup treats
segments refreshed within five minutes as potentially active and does not
remove them for age or quota. A normal close or crash stops that heartbeat, so
the segment becomes eligible after the grace period. Unrecognized files are
never removed. Startup retention uses the same 10,000-entry scan bound; when a
scan is partial it can remove individually expired recognized files but defers
the global count and byte quota until a complete scan. The queue is bounded. A
full queue or storage failure drops observability records instead of delaying
or stopping agent work. On POSIX,
the directory uses mode `0700` and files use `0600`; symbolic-link destinations
are rejected.

Records contain fixed lifecycle names, mode, timestamps, process-local aliases,
durations, counts, byte sizes, result states, normalized token/cache/cost
accounting, and five-minute or shutdown aggregate snapshots. Failure and warning
records omit free-form messages, cancellation reasons, and in-doubt explanations;
they retain fixed codes, normalized categories, counts, booleans, and durations.
Provider failures may also include bounded response metadata that the provider
adapter already marked safe, such as status, a validated bare media type, and
transport codes or request identifiers that match the bounded opaque-token
grammar. Nonconforming values are omitted.

OpenAI Codex transport diagnostics use three fixed event shapes. `codex_transport_selected` records `transport` plus
either `cached_socket_reused` and `websocket_handshake_status`, or `session_fallback_used`.
`codex_websocket_failed` records `failure_class`, `partial_output`, and optional `output_boundary`, validated numeric
`websocket_close_code`, and allowlisted `transport_code`. `codex_session_fallback_activated` records `failure_class`,
`partial_output`, and optional `output_boundary`. The boundary is one of `visible_text`,
`visible_summary_reasoning`, `hidden_provider_reasoning`, `tool_draft`, or `unknown_or_opaque`; therefore
`partial_output: true` can describe non-visible provider state and does not necessarily mean that response text was
rendered. WebSocket status `101` is labeled `websocket_handshake_status`; it is never reported as the failed response
status, and the close code remains a separate field. These events never record a URL, close reason, raw native error,
header, request or response body, credential, prompt or response content, or session ID.

Records do not
intentionally contain prompts, model or reasoning text, tool inputs or results,
provider state, arbitrary response headers, or raw provider bodies. Session-event
projection happens only after the corresponding session transition is durable.
The exact run failure remains available in the active UI and private V4 session
journal. Fatal process messages and safely retained stack fields live in private
crash reports. Both surfaces require explicit, scoped access during diagnosis.

## Aggregate local stats

Summarize the latest valid cumulative snapshot for each recognized runtime observer with:

```sh
rigyn stats
rigyn stats --json
```

The command reads bounded aggregate snapshot records, not session or message content. It reports run, main-model-attempt,
retry, compaction, and tool-failure totals, plus usage, cache, cost, and provider duration only when those measurements
are available. Cache-read and cache-write totals are independently exact only when every contributing request reported
that counter. Otherwise JSON uses `cacheReadReported` or `cacheWriteReported`, and the text report labels the known sum
as partial; an absent counter is never presented as zero. Its cache-hit percentage is aggregate across the selected
process snapshots only when both cache counters are complete; the TUI's `last cache N.N%` is only
the latest completed non-summary model request. Its `source.partial`, skipped-file, and skipped-record fields make
incomplete evidence visible, including a truncated 10,000-entry log-directory scan. It does not upload anything.

For JSON schema compatibility, `source.processes` is the number of retained
runtime-observer aggregate streams. It is not a count of operating-system
processes; one process can host multiple independent sessions, especially in
serve mode.

The JSON `requests` field and underlying `provider_attempts` snapshot field count main model-step attempts. They do not
count the separate provider calls used to create compaction or branch summaries; those operations have their own
lifecycle counters, while any reported summary usage is still included in aggregate usage, cache, cost, and duration.

## Crash reports

An uncaught or top-level CLI process failure writes one bounded report under
`<rigynHome>/crash/`. It includes the mode, timestamp, process instance, failure
origin, and a redacted error name, message, code, bounded cause chain, and stack
when the stack is available as a safe own data field. Ordinary Node.js `Error`
stacks may be accessor-backed and are intentionally omitted rather than read.
Unlike continuous logs, these private crash artifacts can contain fatal
diagnostic messages and safely retained stacks.
Rigyn retains the newest 32 recognized crash reports found by a bounded 10,000-entry pruning scan and leaves unrelated
files untouched. A directory containing more entries can temporarily retain additional reports rather than delaying
fatal error handling with an unbounded scan.
These details can contain local paths or other operational context even after
credential redaction. Keep the directory private and inspect a report before
sharing it.

## On-demand support bundle

Run a credential-free local support probe with:

```sh
rigyn diagnostics
```

The command writes one JSON document to standard output. To create a private file instead:

```sh
rigyn diagnostics ./rigyn-support.json
```

File creation is exclusive and owner-only. An existing file is never replaced.

The bundle contains the rigyn and Node versions, operating-system identity, project-trust status, configuration key
names, file metadata, extension and skill summaries, bounded loader diagnostics, and probe times. Timings use a
monotonic process clock. They help diagnose one run and are not cross-machine benchmarks.

The collector never opens the credential store, session JSONL files, or operational log files for content. For static validation, it reads
bounded configuration, manifest, contribution, and skill-frontmatter data. It does not include configuration values,
descriptions, instructions, templates, custom themes, or runtime code. It never executes extension code.

Paths below the workspace become `<workspace>`. Paths below the home directory become `~`. Known secret shapes,
authenticated URL user information, and credential-like query parameters are redacted again before serialization.

Treat the output as private operational data. Package IDs, skill names, platform details, and project resource names
can reveal how a machine is configured. Review the JSON before sharing it.

Useful fields:

- `configuration.*.status` separates absent, ignored, valid, and invalid files without copying their values.
- `paths.*.kind`, `mode`, and `ownerOnly` expose common ownership and symlink problems.
- `resources.*Diagnostics` identify malformed or shadowed resources through bounded codes, messages, and normalized paths.
- `observability` reports only the configured level and recognized log-file count, bytes, and newest modification time.
- `timingsMs` shows which static probe was slow.
- `errors` isolates a failed probe while preserving the rest of the bundle.
