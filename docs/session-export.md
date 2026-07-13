# Session JSONL export contract

The machine-readable session interchange format is newline-delimited JSON. Each non-empty line is one complete JSON object; records never span lines.

New exports begin with:

```json
{"type":"format","value":{"format":"rigyn/session-jsonl","schemaVersion":1}}
```

The remaining record order is stable for schema version 1:

1. one `thread` record;
2. zero or more `run` records;
3. zero or more `event` records in ascending durable sequence order;
4. zero or more `artifact` records in creation order.

Record envelopes are:

```text
format   { type: "format", value: { format, schemaVersion } }
thread   { type: "thread", value: ThreadRecord }
run      { type: "run", value: RunRecord }
event    { type: "event", branch: string, value: EventEnvelope }
artifact { type: "artifact", value: ArtifactRecordWithBase64Content }
```

`artifact.value.content` is standard base64. Its decoded bytes must match the exported `byteLength` and `sha256` metadata. Event and record fields use the public `rigyn/storage` types for this release.

## Import behavior

Import creates a new thread in the caller-selected workspace. It preserves branch names, timestamps, visible messages, event ancestry, labels, artifacts, and supported lifecycle events. Thread, run, event, message, and artifact identities may be remapped so the imported graph cannot collide with existing data. Stored workspace ownership is never adopted from the file.

Provider continuation state attached to messages, `provider_opaque` content blocks, provider response/request IDs, provider-trace reasoning text, warning detail payloads, and raw provider usage/error payloads are excluded from exports. Visible text, image, tool-call, and tool-result blocks remain portable. A trace event becomes a visible omission marker so event ancestry remains linear. Import applies the same filtering to external and legacy writers, including summaries. These values are provider-private execution material, not a portable conversation contract. Malformed ancestry, duplicate event IDs, duplicate thread records, forward run references, invalid base64, oversized records, and unsupported format versions fail the import. A partially created thread is deleted on failure.

The importer still accepts the older headerless JSONL shape as a legacy version-zero input. A file with a `format` record must put it first and may contain it only once. Unknown named formats or schema versions fail before a thread is created; they are never guessed.

## Compatibility policy

Within schema version 1, readers must ignore record types they do not consume and must not depend on JSON object key order. Required record meanings and ordering will not be changed in place. An incompatible shape requires a new `schemaVersion`, an importer migration or explicit refusal, tests for both directions, and a release note. Rigyn may add optional fields when an older reader can safely ignore them.

JSONL export is an archive/interchange surface, not the live storage engine. Normal operation remains on the transactional SQLite store.
