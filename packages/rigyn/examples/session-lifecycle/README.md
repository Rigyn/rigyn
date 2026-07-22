# Session transition lifecycle

Observes pre-switch, pre-fork, pre-compaction, compaction, pre-tree, tree, metadata, and shutdown events without cancelling host operations. The pre-tree handler supplies concise custom instructions while leaving summarization to the host. `/example-session-lifecycle` reports the ordered events observed by the current generation.

`/example-session-navigate ENTRY_ID` demonstrates a host-owned tree move. `/example-session-compact` requests compaction; both operations remain subject to normal idle and session checks.

```text
rigyn install ./packages/rigyn/examples/session-lifecycle
```
