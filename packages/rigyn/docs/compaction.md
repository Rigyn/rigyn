# Context compaction

Compaction keeps a long session usable without pretending that an abbreviated context is the complete transcript. Durable history is not deleted; the provider request is rebuilt from a source-bound summary plus recent verbatim turns.

## When it runs

Automatic compaction compares a conservative context estimate with the selected model's discovered context window and output reserve. It can run before a request reaches the limit. A typed provider context-overflow response can trigger one additional compact-and-retry path even when the local estimate was low. When a successful response reports usage beyond the threshold, rigyn keeps that answer and compacts afterward without requesting it again. `/compact [focus]` requests the same machinery manually.

The relevant configuration is:

```jsonc
{
  "autoCompaction": true,
  "contextTokenBudget": 128000,
  "summaryTokenBudget": 4096,
  "compactionRetainRecentTurns": 2,
  "compactionToolResultBytes": 4096
}
```

Omit manual token budgets to use current model metadata. A larger context window delays compaction; it does not remove the need to reserve output space or bound unusually large tool results.

## Selection rules

The planner first bounds older tool output, then groups history into complete turns. It never cuts between a tool call and its result. At least the configured number of recent turns stays verbatim, and only an older complete prefix can be summarized.

The summary request receives:

- the exact selected source messages;
- the previous durable summary separately, when one exists;
- bounded file-activity continuity;
- optional manual focus instructions.

Opaque provider continuation state and provider-trace reasoning are not summary input. A replacement summary cannot add tool calls or claim source message IDs outside the plan.

On success, a `compaction_completed` event records the summary, exact `sourceMessageIds`, recomputed post-compaction token estimate, and normalized summary-model usage when available. The manual `compact()` result exposes the same committed summary, cut point, token estimates, usage, and optional details. An extension-provided summary may supply normalized usage; rigyn validates it before committing it.

Generated-summary usage contributes to session token, cache, and cost statistics. Usage from before the latest compaction boundary is not reused to trigger a later post-response compaction.

If automatic summary generation fails or is cancelled, the original history and any successful assistant answer remain authoritative and the run continues without a half-finished summary. Manual compaction instead rejects and emits one terminal `compaction_end` event whose `aborted` and `errorMessage` fields describe the outcome.

## Caching and compaction

Provider prompt caching and compaction solve different problems. Caching can reduce the price and latency of a repeated prefix while leaving the full prefix in the context window. Compaction shortens the requested history but changes the prefix. A stable session often benefits from caching before pressure grows, followed by compaction at a deliberate phase boundary.

## Diagnosing unexpected compaction

Check the selected model's catalog context window, any manual `contextTokenBudget`, the output reserve, unusually large tool results, and whether the provider returned a typed overflow. The TUI footer shows current context pressure; `thread.stats` and runtime snapshots provide bounded estimates to RPC and extension clients. Session exports retain the durable compaction events for offline inspection.
