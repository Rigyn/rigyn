# Extension events

Direct factories subscribe with `rigyn.on(name, handler)`. The names and payloads below are the public contract exported from `rigyn/extensions`; internal durable-event envelopes and provider-native stream objects are not extension APIs.

```js
export default function activate(rigyn) {
  rigyn.on("agent_settled", (_event, context) => {
    context.ui.setStatus("example", "last run settled");
  });
}
```

Every listener belongs to one activation generation. A failed activation commits no listeners. Reload and shutdown make the generation stale, abort pending callbacks, remove listeners, and then run `onDispose` callbacks. Listener payloads are bounded host projections; treat all model, tool, session, and provider text as untrusted.

## Event catalog

| Event | Purpose | Allowed result |
| --- | --- | --- |
| `project_trust` | Ask whether a protected project may load. It receives only the target path and a limited confirmation context. | `{ trusted: "yes" | "no" | "undecided", remember? }` |
| `resources_discover` | Add package-relative skill, prompt, or theme paths at startup or reload. | `{ skillPaths?, promptPaths?, themePaths? }` |
| `session_start` | Observe startup, reload, new, resume, or fork. | none |
| `session_info_changed` | Observe a committed session-name change. | none |
| `session_before_switch` | Guard a new or resume transition. | `{ cancel?: boolean }` |
| `session_before_fork` | Guard a fork and optionally suppress conversation restoration. | `{ cancel?, skipConversationRestore? }` |
| `session_before_compact` | Guard compaction or provide a validated complete compaction result. | `{ cancel?, compaction? }` |
| `session_compact` | Observe committed compaction. | none |
| `session_shutdown` | Observe quit, reload, new, resume, or fork teardown. | none |
| `session_before_tree` | Guard tree navigation or provide summary/instruction/label overrides. | `{ cancel?, summary?, customInstructions?, replaceInstructions?, label? }` |
| `session_tree` | Observe a committed tree navigation. | none |
| `context` | Replace the canonical message list for the next provider step. | `{ messages? }` |
| `before_agent_start` | Append one custom message and/or replace the current system prompt. | `{ message?, systemPrompt? }` |
| `agent_start`, `agent_end`, `agent_settled` | Observe complete agent-run lifecycle. | none |
| `turn_start`, `turn_end` | Observe normalized provider turns. | none |
| `message_start`, `message_update` | Observe provider-neutral assistant streaming snapshots. | none |
| `message_end` | Replace validated fields of a canonical message without changing its role or identity. | `{ message? }` |
| `tool_execution_start`, `tool_execution_update`, `tool_execution_end` | Observe tool execution lifecycle and partial results. | none |
| `tool_call` | Mutate the cloned tool input and/or block execution before final schema validation. | `{ block?, reason? }` |
| `tool_result` | Replace validated content, details, error state, or normalized usage. | `{ content?, details?, isError?, usage? }` |
| `input` | Continue, transform, or consume accepted interactive/RPC/extension input. | `continue`, `transform`, or `handled` result |
| `user_bash` | Supply a bounded synthetic result or an execution implementation for `!`/`!!`. | `{ result? , operations? }` |
| `model_select`, `thinking_level_select` | Observe validated model or reasoning selection. | none |
| `before_provider_request` | Inspect a detached provider-native JSON body and optionally replace the complete body before transport. | JSON-safe replacement body |
| `before_provider_headers` | Mutate the complete assembled outgoing headers; assign `null` to remove a header. | none |
| `after_provider_response` | Observe status and complete normalized response headers. | none |

The TypeScript declarations are authoritative for the fields within each payload and result. Invalid results are rejected or diagnosed; they are never committed as unchecked host state.

Provider header hooks belong to the trusted direct-extension tier. They can observe authentication and cookie headers, just as installed in-process code can already inspect process memory and environment variables. Bounded core diagnostics and session exports remain allowlisted and redacted.

## Ordering and failure rules

- Listeners run in deterministic extension load and registration order.
- Transform results chain: a later listener sees the validated output of the previous listener.
- First cancellation or blocking results stop the guarded action where documented.
- Tool-input mutations are cloned, attributed, and fully schema-validated before execution.
- Observer failures cannot roll back work already committed by the host.
- Caller cancellation and generation replacement abort waiting handlers.
- A handler must bound retained state and must not keep payload objects after its generation ends.

## Callback context

Ordinary listeners receive the same generation-bound context family as commands: `cwd`, `mode`, `hasUI`, project trust, read-only current `sessionManager`, model catalog/current model, UI, cancellation, idle state, context usage, compaction, and the current system prompt. Session transitions and reload are command-only operations.

Check `context.hasUI` before opening a dialog or custom component. Event handlers may run in print, JSON, RPC, or embedding hosts.

## Shared topics

`rigyn.events` is a separate process-local topic bus:

```js
const stop = rigyn.events.on("index-ready", (value) => {
  // consume bounded extension-owned data
});
rigyn.onDispose(stop);
rigyn.events.emit("index-ready", { count: 3 });
```

Topics are not durable session events and do not cross processes. Use `appendEntry` or `sendMessage` when information must appear in or survive with the current session.

The executable examples are [`lifecycle-events`](../examples/lifecycle-events/README.md), [`input-guard`](../examples/input-guard/README.md), [`context-compaction`](../examples/context-compaction/README.md), and [`messages-bus`](../examples/messages-bus/README.md).
