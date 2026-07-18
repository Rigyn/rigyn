# Session JSONL export contract

The machine-readable session interchange format is newline-delimited JSON. Each non-empty line is one complete JSON object; records never span lines.

## Review-required share copies

Use `rigyn --export share.html --redact` or `rigyn --export share.md --redact` for a presentation-only copy intended for manual review before sharing. In the TUI, use `/export --redact [FILE]`; omitting the file writes `rigyn-share.html` in the workspace.

A redacted share copy keeps ordinary user and assistant prose plus transcript-visible extension prose. It applies Rigyn's secret-pattern redactor, replaces the active workspace and home roots with placeholders, normalizes line endings, removes terminal control characters, and omits tool arguments, raw tool results, persisted `!` shell shortcut output, images, provider-opaque blocks, artifacts, structural IDs, and exact timestamps. Markdown message bodies use dynamically sized code fences so embedded HTML, links, headings, and backticks remain reviewable text instead of active presentation markup. Redacted HTML and Markdown each have a 64 MiB output limit. Every copy includes `Redacted share copy; review before publishing.`

Redaction is a risk-reduction aid, not a guarantee of anonymization. Prose can contain names, business data, indirect identifiers, or secrets that do not match a known pattern, so inspect the complete file before publishing it. The `--redact` option supports HTML and Markdown only. Rigyn rejects a redacted `.jsonl` request before creating the output file because JSONL is a round-trip archive rather than a share presentation.

Normal HTML, Markdown, and JSONL exports are unchanged and can contain sensitive session material.

New exports begin with:

```json
{"type":"format","value":{"format":"rigyn/session-jsonl","schemaVersion":2}}
```

The remaining record order is stable for schema version 2:

1. one `thread` record;
2. zero or more `run` records;
3. zero or more `event` records in ascending durable sequence order;
4. zero or more `artifact` records in creation order.

Record envelopes are:

```text
format   { type: "format", value: { format, schemaVersion } }
thread   { type: "thread", value: ThreadRecord }
run      { type: "run", value: RunRecord }
event    { type: "event", branch: string, branchIncarnation: number, value: EventEnvelope }
artifact { type: "artifact", value: ArtifactRecordWithBase64Content }
```

`artifact.value.content` is standard base64. Its decoded bytes must match the exported `byteLength` and `sha256` metadata. Event and record fields use the public `rigyn/storage` types for this release.

## Import behavior

Import creates a new thread in the caller-selected workspace. It preserves branch names, timestamps, visible messages, event ancestry, labels, artifacts, and supported lifecycle events. Thread, run, event, message, and artifact identities may be remapped so the imported graph cannot collide with existing data. Stored workspace ownership is never adopted from the file.

`branchIncarnation` is a bounded positive integer. It distinguishes archived events from a deleted branch when a later branch reuses the same name. Import validates linear ancestry within each incarnation, consecutive incarnation changes, and reachable fork parents before reconstructing the active branch set.

Provider continuation state attached to messages, `provider_opaque` content blocks, provider response/request IDs, response-header diagnostics, provider-trace reasoning text, warning detail payloads, and raw provider usage/error payloads are excluded from exports. Visible text, image, tool-call, and tool-result blocks remain portable. A trace event becomes a visible omission marker so event ancestry remains linear. Import applies the same filtering to external and legacy writers, including summaries. These values are provider-private execution material, not a portable conversation contract. Malformed ancestry, duplicate event IDs, duplicate thread records, forward run references, invalid base64, oversized records, and unsupported format versions fail the import. A partially created thread is deleted on failure.

The importer still accepts schema version 1 and the older headerless JSONL shape. Those formats predate branch-incarnation metadata and retain their original single-incarnation behavior. A file with a `format` record must put it first and may contain it only once. Unknown named formats or schema versions fail before a thread is created; they are never guessed.

## Compatibility policy

Within schema version 2, readers must ignore record types they do not consume and must not depend on JSON object key order. Required record meanings and ordering will not be changed in place. An incompatible shape requires a new `schemaVersion`, an importer migration or explicit refusal, tests for both directions, and a release note. Rigyn may add optional fields when an older reader can safely ignore them.

JSONL export is an archive/interchange surface, not the live storage engine. Normal operation remains on the transactional SQLite store.
