# RPC protocol and typed client

`rigyn rpc` serves strict newline-delimited JSON-RPC 2.0 over standard input and output. Each line is one UTF-8 JSON object. Requests are concurrent, so clients must correlate responses by `id` rather than output order. Diagnostics stay on standard error. The process owns one workspace and rejects cross-workspace thread access.

## Transport and envelopes

- Input and output are UTF-8, one JSON object per LF-delimited line. CRLF input is accepted.
- A line may not exceed 16 MiB. Invalid UTF-8 and over-limit lines terminate framing instead of being partially parsed.
- Requests use `{ "jsonrpc": "2.0", "id", "method", "params"? }`. IDs are `null`, safe integers, or strings of at most 1,024 bytes.
- Responses contain exactly one of `result` or `error`. Server notifications omit `id`.
- Requests may complete out of order. A peer can have at most 64 server-side request handlers in flight in the stdio host.
- Standard output is protocol-only. Human diagnostics and startup failures use standard error.
- JSON-RPC notifications sent by a client have no response, but methods that mutate durable state should be sent as requests so failures are observable.

Node.js consumers can use the packaged client from `rigyn/interfaces`:

```ts
import { spawnRpcClient } from "rigyn/interfaces";

const { client } = spawnRpcClient({
  command: "rigyn",
  args: ["rpc", "--workspace", process.cwd()],
});

const initialized = await client.request("initialize");
const off = client.onNotification("run.event", (event) => {
  console.log(event.sequence, event.event.type);
});

const started = await client.request("run.start", {
  model: "openai/gpt-5.6-sol",
  prompt: "Inspect package.json",
});
const completed = await client.request("run.wait", { threadId: started.threadId });

off();
await client.request("shutdown");
await client.close();
```

`RpcClient.request()` is typed by `RpcMethodMap`; `onNotification()` is typed by `RpcNotificationMap`. Aborting a request signal stops only the local wait because JSON-RPC has no generic cancellation method. Use `run.cancel` or `extension.command.cancel` to cancel corresponding server work. Closing an owned spawned client terminates its child process and rejects every pending request.

Call `initialize` first when writing a long-lived client. Its capability object is the source of truth for optional limits and surfaces. `health`, `version`, and `capabilities` are also available before initialization. The server does not silently emulate a capability that is absent.

Durable subscriptions replay events after an optional sequence cursor and then hand off to live delivery:

```ts
const subscription = await client.subscribeEvents(
  { threadId, afterSequence: lastSequence },
  (event) => saveCursor(event.sequence),
  { onError: console.error },
);

await subscription.unsubscribe();
```

Replay is ordered by durable event sequence. The subscribe response reports `replayedThrough`; notifications that race with that response are buffered by the typed client during the replay/live handoff. Consumers should persist the highest processed sequence and reconnect with `afterSequence`. `events.error` means that subscription stopped; it does not invalidate the thread.

## Notifications

<!-- rpc-notifications:start -->
| Notification | Payload | When |
| --- | --- | --- |
| `run.event` | EventEnvelope | Live durable or streaming event for a caller-owned run. |
| `run.finished` | HarnessRun | Caller-owned run completed and its wait result is available. |
| `run.failed` | { threadId, message } | Caller-owned run rejected before producing a normal result. |
| `thread.compacted` | { threadId, result } | Manual compaction completed. |
| `thread.compactionFailed` | { threadId, message } | Manual compaction failed. |
| `extension.warning` | { phase, message } | A bounded extension lifecycle observer failed. |
| `extension.ui.request` | RpcExtensionUiRequest | Correlated UI request owned by this RPC peer. |
| `events.event` | { subscriptionId, event } | Replay or live event for a durable subscription. |
| `events.error` | { subscriptionId, cursor, reason } | A durable event subscription stopped at a cursor. |
<!-- rpc-notifications:end -->

`run.event` is best-effort live presentation for the peer that owns the run. Use `events.subscribe` when reconnectable delivery matters. `run.finished` and `run.failed` are convenience notifications; `run.wait` remains the correlated completion contract.

## Errors

Every remote error has `{ code, message, data? }`. The packaged client raises `RpcRemoteError` and preserves those fields. Messages are secret-redacted by the stdio host. Do not branch on message text.

<!-- rpc-errors:start -->
| Code | Name | Meaning |
| ---: | --- | --- |
| `-32700` | `parse` | The input line is not valid bounded JSON-RPC input. |
| `-32601` | `method_not_found` | The requested method is not advertised or implemented. |
| `-32602` | `invalid_params_or_state` | Parameters, ownership, workspace scope, capability state, or operation state are invalid. |
<!-- rpc-errors:end -->

The server intentionally uses `-32602` for both malformed parameters and invalid current state, including a foreign run owner, stale queue lease, unknown thread, unavailable provider, or unsupported UI operation. Inspect capabilities and refresh state before retrying. Transport closure, malformed server responses, unknown response IDs, and invalid notification envelopes are local `RpcClientProtocolError` or `RpcClientClosedError` failures rather than remote error responses.

## Ownership, cancellation, and shutdown

Runs, queue leases, extension commands, and blocking extension UI requests are owned by the peer that created them. Another peer cannot wait, cancel, acknowledge, or answer them. Disconnect cancels peer-owned active work, releases its queue leases, and cancels its UI requests; durable thread events and recoverable queued input remain.

`run.cancel` and `extension.command.cancel` acknowledge a cancellation request; final settlement is observed through `run.wait`, notifications, or command completion. `shutdown` enters draining state, cancels active work, acknowledges `{ shuttingDown: true }`, then asks the stdio host to close input. During drain, only `health` and `run.wait` remain accepted.

## Sessions, branches, and exports

Thread methods are scoped to the server workspace. A branch argument defaults to the thread default branch. `thread.events` returns durable normalized envelopes; it never returns credential material or provider-private hidden reasoning. `thread.fork` creates a branch inside a thread, while extension session cloning is a separate in-process API. `thread.export` returns inline data only within the advertised byte limit; use the CLI export command for larger sessions.

`thread.state` reports activity, queue counts, and current selection. `thread.stats` reports bounded aggregate counts and normalized usage. `thread.lastAssistantText` returns visible assistant text only and rejects an over-limit result rather than returning a silent partial.

## Runs and durable input queues

`run.start` either creates a thread or binds an existing workspace thread, validates the exact model/provider/tool selection, persists the user turn, and returns the thread ID. At most one nonterminal run exists per thread. `run.wait` is owner-scoped and may be called while the dispatcher is draining.

Steering and follow-up input are persisted before acceptance. Queue inspection is bounded and paginated. If one item cannot fit a response, the result describes it as `blocked` and leaves it durable. `run.dequeue` leases one item; clients must call `run.dequeue.ack` after safely consuming it or `run.dequeue.release` to make it available again. A disconnect releases outstanding leases. Recovered items are never replayed automatically.

## Models and authentication

Model operations separate durable catalog status, listing, refresh, and reference resolution. Resolution rejects ambiguous references. Authentication reads return secret-free state. `auth.set` is the only method whose request intentionally carries a reusable secret; it is appropriate only over this trusted local stdio channel. `auth.delete` may optionally attempt remote revocation, and cancellation does not silently delete a credential whose requested revocation did not complete.

## Resources, commands, and extension UI

`resources.list` returns the same immutable bounded catalog used by embedding and runtime extensions. `commands.list` combines built-ins, runtime commands, prompt templates, and skills; source prompt bodies are not returned. `extension.command.run` creates a peer-owned operation and can issue correlated `extension.ui.request` notifications.

Each blocking UI request carries its request ID, extension owner, deadline, and expected response kind. Reply exactly once with `extension.ui.respond`. Late, duplicate, malformed, foreign-peer, and stale-generation responses reject. A client that does not advertise or service extension UI should not invoke commands that require it. Editor text is peer-local presentation state.

## Method reference

This table is rendered from `RPC_METHOD_REFERENCE`. A conformance test compares its names with every dispatcher `case` and compares this section byte-for-byte with `renderRpcMethodReference()`, so adding or removing a server method requires updating the typed contract and this reference together.

<!-- rpc-methods:start -->
| Method | Parameters | Result | Purpose |
| --- | --- | --- | --- |
| `initialize` | none | RpcInitializeResult | Negotiate version and capabilities. |
| `health` | none | RpcHealthResult | Inspect server health and active client/run counts. |
| `version` | none | RpcVersionResult | Read the server package version. |
| `capabilities` | none | RPC capability object | Read capability negotiation data without initialization. |
| `thread.create` | name?, parentThreadId?, parentRunId? | ThreadRecord | Create a workspace-bound thread. |
| `thread.list` | none | ThreadRecord[] | List workspace threads. |
| `thread.get` | threadId | { thread, runs } | Read a thread and its runs. |
| `thread.events` | threadId, branch? | EventEnvelope[] | Read durable events on a branch. |
| `thread.state` | threadId, branch? | RpcThreadState | Read active state, selection, and pending counts. |
| `thread.stats` | threadId, branch? | RpcThreadStatistics | Read message, run, usage, and context statistics. |
| `thread.lastAssistantText` | threadId, branch? | { text } | Read bounded text from the latest assistant message. |
| `thread.fork` | threadId, newBranch, fromBranch?, atEventId? | BranchRecord or cancelled | Fork a branch at a durable event. |
| `thread.name` | threadId, name | ThreadRecord | Set a thread name. |
| `thread.delete` | threadId | { deleted } | Delete a workspace thread. |
| `thread.export` | threadId, format?, branch? | RpcThreadExportResult | Export bounded JSONL, Markdown, or HTML. |
| `thread.compact` | threadId, provider, model, branch?, budgets? | AgentRunResult | Run manual context compaction. |
| `events.subscribe` | threadId, branch?, afterSequence? | { subscriptionId, replayedThrough } | Start replayable durable-event delivery. |
| `events.unsubscribe` | subscriptionId | { unsubscribed } | Stop an event subscription. |
| `run.start` | RpcRunStartParams | { threadId, handled? } | Start a caller-owned agent run. |
| `run.wait` | threadId | HarnessRun or AgentRunResult | Wait for a caller-owned run or compaction. |
| `run.cancel` | threadId, reason? | { accepted } | Cancel a caller-owned run. |
| `run.steer` | threadId, message, images? | { accepted, handled? } | Queue steering input for an active run. |
| `run.followUp` | threadId, message, images? | { accepted, handled? } | Queue follow-up input for an active run. |
| `run.queue` | threadId, branch?, offset?, limit? | RpcQueueResult | Inspect bounded durable queued input. |
| `run.dequeue` | threadId, branch? | RpcDequeueResult | Lease one durable queued input item. |
| `run.dequeue.ack` | leaseId | { accepted } | Acknowledge and remove a queue lease. |
| `run.dequeue.release` | leaseId | { accepted } | Release a queue lease without removing it. |
| `run.queueModes.get` | threadId | queue modes | Read active run queue modes. |
| `run.queueModes.set` | threadId, steeringMode?, followUpMode? | queue modes | Change active run queue modes. |
| `models.list` | provider?, refresh? | ModelInfo[] | List configured or discovered models. |
| `models.status` | provider? | ModelCatalogStatus[] | Inspect durable model-catalog status. |
| `models.refresh` | provider? | ModelCatalogRefreshResult or [] | Refresh one or all model catalogs. |
| `models.resolve` | reference, provider?, refresh?, reasoningEffort? | ModelReferenceResolution | Resolve an exact or unambiguous model reference. |
| `auth.status` | provider? | ProviderAuthState or [] | Inspect secret-free provider auth state. |
| `auth.profiles` | provider | CredentialProfileState | List secret-free credential profiles. |
| `auth.select` | provider, profile | ProviderAuthState | Select a stored credential profile. |
| `auth.fallback` | provider | ProviderAuthState | Select environment or ambient fallback auth. |
| `auth.set` | provider, kind, secret, accountId?, profile? | ProviderCredentialSaveResult | Store and select an API-key or bearer credential. |
| `auth.delete` | provider, profile?, revokeRemote? | logout/delete result | Delete local auth, optionally revoking remotely. |
| `resources.list` | none | HarnessResourceCatalog | Read the bounded callback-free harness resource catalog. |
| `commands.list` | none | RpcCommandCatalog | Discover built-in, extension, prompt, and skill commands. |
| `extension.command.list` | none | RuntimeCommandDescription[] | List executable runtime-extension commands. |
| `extension.command.run` | name, args?, threadId?, branch?, timeoutMs?, operationId? | RpcExtensionCommandResult | Run a runtime-extension command with RPC UI. |
| `extension.command.cancel` | operationId | { accepted } | Cancel a caller-owned extension command. |
| `extension.ui.respond` | RpcExtensionUiResponse | { accepted } | Answer a correlated extension UI request. |
| `extension.ui.editorText.update` | value | { accepted } | Update RPC client editor text. |
| `extension.ui.editorText.get` | none | { value } | Read RPC client editor text. |
| `shutdown` | none | { shuttingDown } | Drain operations and stop the stdio server. |
<!-- rpc-methods:end -->

Authentication responses contain secret-free state. `auth.set` necessarily sends a secret to the trusted local RPC server; do not log requests, persist wire transcripts, or expose this method through an unauthenticated remote bridge. RPC clients must also handle `extension.ui.request` ownership and timeouts exactly as advertised by `initialize.capabilities`.

`initialize.capabilities.extensionUi` advertises every supported operation. Extension UI notifications include bounded `working_message` and `working_visible` presentation updates. `theme_get` and `theme_set` are correlated requests; clients respond with `value` containing JSON `{ "name": string, "available": string[] }`. Custom terminal components, overlays, input middleware, and autocomplete providers are not serialized over RPC and reject explicitly.
