# Session transition lifecycle

This example observes session switch, fork, compaction, tree, metadata, and
shutdown events. It does not cancel host operations. The pre-tree handler adds
short custom instructions, but the host still performs summarization.

```text
rigyn install ./packages/rigyn/examples/session-lifecycle
```

- `/example-session-lifecycle` reports the ordered events seen by the current
  runtime generation.
- `/example-session-navigate ENTRY_ID` requests a host-owned tree move.
- `/example-session-compact` requests host-owned compaction.

Normal idle-state and session checks still apply to both operations.
