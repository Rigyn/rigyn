# Custom compaction example

This package replaces the normal model-generated summary with a deterministic, bounded role outline. It preserves the first and last portions of large compaction ranges, identifies tool calls and results, omits opaque provider state, records structural metadata, and leaves the harness responsible for the durable compaction event.

From this `custom-compaction` directory:

```sh
rigyn install .
rigyn
```

Build some session history, then run `/compact focus on decisions and remaining work`. A successful override reports `Custom bounded compaction checkpoint saved.` Remove the package with `rigyn remove custom-compaction-example`.

This deterministic strategy is an authoring reference, not a universal replacement for semantic summarization. Use it only when a bounded audit-style outline is preferable to a provider summary. Cancellation is checked before any summary is returned. The package targets extension manifest schema 1 and Rigyn 0.1.x.
