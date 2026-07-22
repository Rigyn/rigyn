# Session JSONL format

Rigyn stores durable sessions as append-only version 3 JSON Lines files. The first complete line is the session header; every later complete line is one entry. The active branch is derived from parent links rather than from line order alone.

```jsonl
{"type":"session","version":3,"id":"demo","timestamp":"2026-07-21T12:00:00.000Z","cwd":"/work/project"}
{"type":"message","id":"entry-1","parentId":null,"timestamp":"2026-07-21T12:00:01.000Z","message":{"id":"message-1","role":"user","content":[{"type":"text","text":"Review the change"}],"createdAt":"2026-07-21T12:00:01.000Z"}}
{"type":"model_change","id":"entry-2","parentId":"entry-1","timestamp":"2026-07-21T12:00:02.000Z","provider":"provider","modelId":"model"}
```

## Header

The header has `type: "session"`, `version`, `id`, creation `timestamp`, and the original `cwd`. A fork may also record `parentSession`. New files use version 3; older versions are compatibility inputs rather than authoring targets.

## Entry envelope

Every entry has a unique `id`, a `parentId` that is either another entry ID or `null`, and an ISO timestamp. The common entry types are:

| Type | Purpose |
| --- | --- |
| `message` | User, assistant, tool, shell, or extension conversation content |
| `model_change` | Provider and model selected from this point |
| `thinking_level_change` | Thinking level selected from this point |
| `compaction` | Durable summary plus the first retained entry |
| `branch_summary` | Summary attached while moving between branches |
| `custom` | Extension-owned durable state, omitted from model context |
| `custom_message` | Extension-owned content reconstructed into context |
| `label` | Latest label change for a target entry |
| `session_info` | Session display-name change |

Usage, provider continuation state, tool calls, and tool results are preserved inside their owning messages. Consumers must preserve unknown JSON-safe fields when round-tripping and must not expose hidden provider reasoning.

## Recovery and branching

Appending is the only normal mutation. A branch is the chain obtained by following `parentId` from a selected leaf to the root. Tree navigation changes the selected leaf; it does not rewrite abandoned entries. Labels and session names are new entries, so their latest applicable value wins.

An interrupted final write can leave one incomplete trailing line. Readers ignore that trailing fragment while retaining every earlier complete entry. Corruption in a completed line is different: run `rigyn sessions doctor` and preserve the original file for diagnosis.

Extensions should use `context.sessionManager` for reads and `appendEntry`, `sendMessage`, naming, and labeling APIs for writes. Do not open and modify the live file directly. Use the [session export contract](session-export.md) for interchange and redacted sharing.
