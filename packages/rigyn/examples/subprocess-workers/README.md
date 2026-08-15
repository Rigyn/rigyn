# Subprocess workers extension

This authoring example registers the model-callable `example_subagent` tool
and the `/example-workers TASK` command. It loads agent definitions from
`agents/*.md` on every invocation. You can therefore add a bounded specialist
without changing the extension module.

```text
rigyn install ./packages/rigyn/examples/subprocess-workers
```

## Execution shapes

The tool accepts exactly one execution shape:

- `{ agent, task }` runs one specialist.
- `{ tasks: [{ agent, task }, ...] }` runs up to four independent specialists
  at the same time. One failure does not discard successful reports.
- `{ chain: [{ agent, task }, ...] }` runs specialists in order. Each task
  receives the previous bounded report. The chain stops after a failed step.

Each child receives:

- the discovered instructions and tool allowlist;
- the same workspace;
- a turn limit and timeout;
- the parent cancellation signal;
- an ephemeral session.

The specialist policy is part of the child's system prompt. The delegated task
remains a separate user message.

Automatic extensions are disabled in each child. This prevents recursive
worker activation. Cancellation stays cancellation instead of becoming an
ordinary worker failure.

## Results and progress

The extension validates and bounds every child JSON event stream and returned
text. `onUpdate` reports bounded completion snapshots. Each snapshot includes:

- execution mode;
- completed and total counts;
- worker name and outcome;
- turn and event counts;
- output bytes;
- validated usage, when available.

The final tool result is authoritative. It contains ordered reports and
aggregated usage.

The public process helper returns buffered output. This example does not claim
token-by-token child streaming. A package that needs live child events must own
a streaming process. It must validate and combine incremental protocol
records, cap bytes and events, propagate cancellation, and still return one
complete final result.

`/example-workers` runs every discovered specialist in parallel and displays
the same failure-isolated summary in the terminal.

`/example-process TEXT` demonstrates the generation-owned `rigyn.processes`
service separately: it performs a shell-free spawn, waits with the command's
cancellation signal, and captures at most 16 KiB from each output stream.

The bundled specialists are read-only. Final synthesis and file changes remain
the parent agent's responsibility.
