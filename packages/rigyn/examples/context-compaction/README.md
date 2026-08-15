# Context and compaction

This example adds one bounded instruction during `before_agent_start`. It also
shows how an extension can inspect context pressure and request host-owned
compaction.

```text
rigyn install ./packages/rigyn/examples/context-compaction
```

After `/refresh`:

- `/example-context` reports the host context estimate and current system-prompt
  length without exposing the prompt text.
- `/example-context compact` asks the host to compact with custom guidance.

The extension requests compaction. The host still owns planning, summary
validation, persistence, and lifecycle events.
