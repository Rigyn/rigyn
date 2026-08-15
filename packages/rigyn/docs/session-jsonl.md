# Session JSONL format

rigyn stores each durable session as one strict V4 JSON Lines journal. The
journal is the source of truth for conversation history, selected state,
accepted runs, queues, checkpoints, and tool-effect recovery.

![rigyn session tree and compaction boundary](assets/session-tree.svg)

## File shape

The first line is the session header:

```jsonl
{"record":"session","version":4,"sessionId":"demo","createdAt":"2026-07-29T12:00:00.000Z","workspace":"/work/project","cwd":"/work/project"}
```

Each later line is one commit:

```jsonl
{"record":"commit","sequence":1,"commitId":"commit-1","committedAt":"2026-07-29T12:00:01.000Z","changes":[{"type":"conversation_node","node":{"id":"user-1","parentId":null,"nodeType":"message","role":"user","content":{"id":"message-1","role":"user","content":[{"type":"text","text":"Review the change"}],"createdAt":"2026-07-29T12:00:01.000Z"},"createdAt":"2026-07-29T12:00:01.000Z"}},{"type":"head","branchId":"main","nodeId":"user-1"}]}
```

Every record must:

- be valid UTF-8 JSON;
- be one plain object;
- end with LF, not CRLF;
- use only the fields allowed for its record and change type;
- stay within the journal size and JSON-shape limits.

The limits are 16 MiB per record, 256 MiB per file, 100,000 commit rows,
128 nested JSON levels, and 100,000 JSON values per record.

## Header

The header has this exact shape:

```ts
interface SessionV4Header {
  record: "session";
  version: 4;
  sessionId: string;
  createdAt: string;
  workspace: string;
  cwd: string;
  parent?: {
    sessionId: string;
    originOperationId?: string;
    originToolEffectId?: string;
    purpose?: string;
  };
}
```

`parent` records provenance for a linked child or fork. It does not load or
execute the parent session.

## Commits

A commit has this exact envelope:

```ts
interface SessionV4Commit {
  record: "commit";
  sequence: number;
  commitId: string;
  committedAt: string;
  changes: [SessionV4Change, ...SessionV4Change[]];
}
```

Sequences start at `1` and increase by one. A commit ID can be retried only
with the same sequence, timestamp, and changes. An exact duplicate is
idempotent. Reusing the ID with different data fails.

Changes apply in array order. This lets one commit make an atomic transition,
such as adding a message node and selecting it as the new head.

## Conversation tree

Conversation nodes share these fields:

```ts
interface SessionV4NodeBase {
  id: string;
  parentId: string | null;
  createdAt: string;
  operationId?: string;
}
```

`parentId` creates an immutable tree. `null` starts a root. The journal
currently exposes one selected branch named `main`; its head points to the
active node. Moving the head creates or selects another path without rewriting
nodes.

| `nodeType` | Stored data |
| --- | --- |
| `message` | role and JSON-safe canonical message content |
| `model_change` | provider and model IDs |
| `thinking_change` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `tools_change` | active tool names and their fingerprint |
| `compaction` | summary and retained node IDs |
| `branch_summary` | summarized source range and summary |
| `extension_context` | extension-owned content that may enter model context |
| `extension_state` | extension-owned durable state that does not enter model context |
| `shell` | command, working directory, and result |

State changes outside the tree set the selected head, session name, or node
label.

## Run journal

An accepted run records:

- its operation ID and branch;
- the prompt reservation and source head;
- its accepted time and request snapshot;
- provider, model, thinking level, tool names, and toolset fingerprint.

Later changes record provider attempts, cancellation, checkpoints, and the
terminal outcome. The reducer permits only one open operation in the session.
Nodes owned by a run carry that operation ID.

The product writes a run checkpoint after each durable message, after each
settled tool effect, and after a compaction is durable. Each checkpoint names
its phase and the related durable ID. These checkpoints describe completed
boundaries. They do not replace the conversation nodes or tool-effect records.

The acceptance record exists before provider work starts. A terminal record
closes the operation only after its required tool effects and result nodes are
settled.

## Durable queues

Queue changes record steering, follow-up, and next-run work:

1. `queue_added` reserves an entry and target node.
2. `queue_claimed` binds it to an accepted operation.
3. `queue_finished` marks it consumed or cancelled.

The reducer keeps queue state separate from conversation nodes. This prevents
a restart from silently losing accepted work.

## Tool effects

A tool effect moves through explicit transitions:

1. `tool_effect_prepared`
2. `tool_effect_dispatched`
3. a terminal finish, reconciliation, or manual resolution

Preparation stores the effective input, its canonical SHA-256 hash, the
provider call ID, the invocation and effect IDs, the reserved result node, the
toolset fingerprint, and one recovery policy:

- `repeatable`: recovery may repeat verified work;
- `reconcile`: recovery checks external state before deciding;
- `never_repeat`: recovery needs an explicit decision.

If a process stops after dispatch but before settlement, the effect becomes
in doubt. rigyn does not blindly repeat it. New work remains blocked until the
effect is reconciled or resolved according to its policy.

Opening an interrupted session can run safe automatic recovery. A repeatable
effect can run again only when its stored tool selection and input still
match. A reconcile effect uses its registered recovery handler. An unresolved
or `never_repeat` effect requires an explicit resolution. Interactive, RPC,
and SDK hosts expose that decision without editing the journal by hand.

## Replay and crash boundaries

Only LF-terminated records are committed. On open:

- a trailing unterminated fragment is ignored;
- a writable open truncates that fragment before the next append;
- malformed or invalid LF-terminated data fails with its line number;
- a missing or invalid header fails;
- invalid sequence, ancestry, ownership, queue, operation, or tool-effect
  transitions fail.

The writer validates the transition, appends the complete line, synchronizes
the file, then publishes the new in-memory state. Session creation also
synchronizes the parent directory when the platform supports it.

The product owns a writer lease. A second live writer for the same session is
rejected. A read-only snapshot can inspect the file without taking that lease.

## Context reconstruction

The reducer first reconstructs the complete state. Product projection then:

1. follows parent links from the selected head;
2. applies the latest reachable model, thinking, and tool selections;
3. starts compacted context at the recorded retained boundary;
4. keeps valid user, assistant, tool-call, and tool-result order;
5. includes extension context and omits extension state.

Provider conversion happens after this canonical context exists. Provider
continuation state is reused only across a compatible provider, protocol,
model, and tool-definition boundary.

## Public projection

`SessionManager` returns product-facing `SessionHeader` and `SessionEntry`
objects for navigation, extension callbacks, RPC, and presentation. Those
objects are a projection of reduced V4 state. They are not raw journal rows.

Use `@rigyn/kernel/session-v4` for the raw schema, reader, writers, validation,
and reducer. Use `rigyn/storage` for product session discovery, context
projection, and tree operations.

## Export contract

An ordinary HTML export of a durable file embeds the exact source journal.
`AgentSession.exportToJsonl()` creates a new, valid V4 journal for the selected
conversation branch. The new journal is settled: it can be resumed as
conversation history, but it does not carry an active operation, pending
queue, checkpoint, or tool-effect recovery state.

A redacted JSONL export is also a settled V4 journal. It preserves structural
IDs and references while removing recognized secrets from payload fields.

Do not edit a live journal behind its manager. Session data can contain source
code, prompts, model output, tool input and output, local paths, images, and
extension data. Inspect a redacted copy before sharing it.
