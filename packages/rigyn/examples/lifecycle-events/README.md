# Run lifecycle events

Observes the complete agent, turn, message, and tool-execution lifecycle, then reports generation-local counts through `/example-lifecycle-status`. The handlers collect operational telemetry without changing messages or results. Cleanup is registered with `onDispose`, so no counters survive reload.

```text
rigyn install ./packages/rigyn/examples/lifecycle-events
/example-lifecycle-status
```
