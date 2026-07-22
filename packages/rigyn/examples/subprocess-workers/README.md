# Subprocess workers extension

This installable authoring example registers the model-callable `example_subagent` tool and the `/example-workers TASK` command. Agent definitions are discovered from the package's `agents/*.md` files on each invocation, so adding a bounded definition does not require changing the extension module.

```text
rigyn install ./packages/rigyn/examples/subprocess-workers
```

The tool accepts exactly one execution shape:

- `{ agent, task }` runs one specialist.
- `{ tasks: [{ agent, task }, ...] }` runs up to four independent specialists concurrently and keeps one failure from discarding successful reports.
- `{ chain: [{ agent, task }, ...] }` runs in order, adds the previous bounded report to the next task, and stops after a failed step.

Each child receives its discovered instructions and tool allowlist, the same workspace, a turn limit, a timeout, the parent cancellation signal, and an ephemeral session. Automatic extensions are disabled in children, preventing recursive worker activation. Cancellation is propagated instead of converted into an ordinary worker failure.

Child JSON event streams and returned text are bounded and validated. The tool reports bounded per-worker completion updates through `onUpdate`; the public process helper returns buffered output, so this example does not claim token-by-token child streaming. Valid assistant usage is aggregated across turns and workers and attached to the tool result. `/example-workers` runs every discovered specialist in parallel and reports the same failure-isolated summary in the terminal.

The bundled definitions are read-only. The example deliberately leaves final synthesis and file mutation to the parent agent.
