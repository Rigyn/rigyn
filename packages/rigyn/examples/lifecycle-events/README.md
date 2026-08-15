# Run lifecycle events

This example observes agent, turn, message, and tool-execution events. The
handlers collect operational counts without changing messages or results.

```text
rigyn install ./packages/rigyn/examples/lifecycle-events
/example-lifecycle-status
```

`/example-lifecycle-status` reports counts for the current runtime generation.
Cleanup is registered with `onDispose`, so no counter survives refresh.
