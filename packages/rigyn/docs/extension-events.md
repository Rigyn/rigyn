# Extension events

Direct factories subscribe with `rigyn.on(name, handler)`. The names and payloads below are the public contract exported from `rigyn/extensions`. Internal durable-event envelopes and provider-native stream objects are not extension APIs.

```js
export default function activate(rigyn) {
  rigyn.on("agent_settled", (_event, context) => {
    context.ui.setStatus("example", "last run settled");
  });
}
```

Every listener belongs to one activation generation. A failed initial activation
commits no listeners. Refresh sends `session_shutdown` to the live generation,
then prepares a candidate while retaining the previous generation as its
rollback target. If candidate preparation or its factory fails before
publication, rigyn disposes it, rebinds the previous generation, and sends
`session_start` to that generation again. Once the candidate resource
generation is published, the previous generation is no longer recoverable. A
failure in the published generation's `session_start` disables and closes that
incomplete generation; a later refresh must publish a fresh generation. After
a successful refresh, or during final shutdown, the previous generation
follows this retirement sequence:

1. make the generation stale;
2. abort pending callbacks;
3. remove listeners;
4. run `onDispose` callbacks.

Listener payloads are bounded host projections. Treat all model, tool, session, and provider text as untrusted.

## Event catalog

| Event | Purpose | Allowed result |
| --- | --- | --- |
| `project_trust` | Ask whether a protected project may load. It receives only the target path and a limited confirmation context. | `{ trusted: "yes" \| "no" \| "undecided", remember? }` |
| `resources_discover` | Add package-relative skill, prompt, or custom-theme paths at startup or refresh. | `{ skillPaths?, promptPaths?, themePaths? }` |
| `session_start` | Observe startup, refresh, new, resume, or fork. | none |
| `session_info_changed` | Observe a committed session-name change. | none |
| `session_before_switch` | Guard a new or resume transition. | `{ cancel?: boolean, reason?: string }` |
| `session_before_fork` | Guard a fork. | `{ cancel?: boolean, reason?: string }` |
| `session_before_compact` | Guard compaction or provide a validated complete compaction result. | `{ cancel?, compaction? }` |
| `session_compact` | Observe committed compaction. | none |
| `session_shutdown` | Observe quit, refresh, new, resume, or fork teardown. | none |
| `session_before_tree` | Guard tree navigation or provide summary/instruction/label overrides. | `{ cancel?, summary?, customInstructions?, replaceInstructions?, label? }` |
| `session_tree` | Observe a committed tree navigation. | none |
| `context` | Replace the canonical message list for the next provider step. | `{ messages? }` |
| `before_agent_start` | Append one custom message and/or replace the current system prompt. | `{ message?, systemPrompt? }` |
| `agent_start`, `agent_end`, `agent_settled` | Observe complete agent-run lifecycle. | none |
| `turn_start`, `turn_end` | Observe normalized provider turns. | none |
| `message_start`, `message_update` | Observe provider-neutral assistant streaming snapshots. | none |
| `message_end` | Replace validated fields of a canonical message without changing its role or identity. | `{ message? }` |
| `tool_execution_start`, `tool_execution_update`, `tool_execution_end` | Observe tool execution lifecycle and partial results. | none |
| `tool_call` | Mutate the cloned, initially validated tool input and/or block execution. | `{ block?, reason?, terminate? }` |
| `tool_result` | Replace validated content, details, error state, or normalized usage. | `{ content?, details?, isError?, usage? }` |
| `input` | Continue, transform, or consume accepted interactive/RPC/serve/extension input. | `continue`, `transform`, or `handled` result |
| `user_bash` | Supply a bounded synthetic result or a `BashOperations` execution implementation for `!`/`!!`. | `{ result?, operations? }` |
| `model_select`, `thinking_level_select` | Observe validated model or reasoning selection. | none |
| `before_provider_request` | Inspect a detached provider-native JSON body and optionally replace the complete body before transport. | JSON-safe replacement body |
| `before_provider_headers` | Mutate the complete assembled outgoing headers; assign `null` to remove a header. | none |
| `after_provider_response` | Observe status and complete normalized response headers. | none |

For a `message_update` carrying `toolcall_delta`, the event's `delta` is the
guaranteed live tool-argument representation. The parsed tool-call `arguments`
object is authoritative at `toolcall_end` and `tool_execution_start`, after the
JSON is complete.

The TypeScript declarations are authoritative for every payload and result field. Invalid results are rejected or diagnosed. They are never committed as unchecked host state.

`tool_call` may return `terminate: true` only as a hint on a blocked call. It
skips the automatic next model turn only when every finalized result in the
provider-requested batch is terminating. A hint on an allowed call is ignored,
and queued steering or follow-up input still takes precedence.

Provider header hooks belong to the trusted direct-extension tier. They can observe authentication and cookie headers, just as installed in-process code can already inspect process memory and environment variables. Bounded core diagnostics and session exports remain allowlisted and redacted.

## Ordering and failure rules

- Listeners run in deterministic extension load and registration order.
- `session_shutdown` settles listeners in that same sequential order under one shared shutdown deadline; later listeners do not receive a fresh timeout budget.
- Transform results chain: a later listener sees the validated output of the previous listener.
- First cancellation or blocking results stop the guarded action where documented.
- A malformed `session_before_switch` or `session_before_fork` result is diagnosed
  and cancels that transition. Malformed tree or compaction transforms are
  diagnosed and skipped so a later valid listener may still contribute.
- A successful listener's persistent UI remains generation-owned after its
  dispatch deadline is released. Caller cancellation or a deadline reached while
  the listener is still running aborts that in-flight UI context.
- Tool input is schema-validated before listeners run. Listener transformations are schema-validated and tool-validated again before resource claims or execution.
- Observer failures cannot roll back work already committed by the host.
- Caller cancellation and generation replacement abort waiting handlers.
- A handler must bound retained state and must not keep payload objects after its generation ends.

## Callback context

Ordinary listeners receive the same generation-bound context family as commands:

- `cwd`, `mode`, `hasUI`, and project trust;
- the read-only current `sessionManager`;
- the model catalog, current model, immutable `scopedModels`, and selected `thinkingLevel`;
- UI, cancellation, idle state, context usage, compaction, and the current system prompt.

Session transitions and refresh are command-only operations.

Check `context.hasUI` before opening a dialog or custom component. Event
handlers may run with `tui`, `print`, `json`, `rpc`, `serve`, or `sdk` mode.
SDK and embedding sessions use the headless `sdk` mode.

## Shared topics

`rigyn.events` is a separate process-local topic bus:

```js
const stop = rigyn.events.on("index-ready", (value) => {
  // consume bounded extension-owned data
});
rigyn.onDispose(stop);
rigyn.events.emit("index-ready", { count: 3 });
```

Subscriptions and emissions made by the factory are part of its activation
transaction. On success, rigyn publishes those listeners in registration order
and then delivers the queued emissions in call order, so a factory may observe
its own activation-time emission. On failure, neither listeners nor emissions
escape the candidate. Activation-time payloads are JSON snapshots limited to 1
MiB each, 4 MiB total, and 1,024 queued emissions.

Live emissions use the same detached, descriptor-only JSON snapshot and 1 MiB
per-payload limit. Payloads delivered by a supplied event bus are snapshotted and
validated again before the extension handler runs. The queue-count and aggregate
byte limits apply only during activation.

Topics are not durable session events and do not cross processes. Use `appendEntry` or `sendMessage` when information must appear in or survive with the current session.

The executable examples are [`lifecycle-events`](../examples/lifecycle-events/README.md), [`input-guard`](../examples/input-guard/README.md), [`context-compaction`](../examples/context-compaction/README.md), and [`messages-bus`](../examples/messages-bus/README.md).
