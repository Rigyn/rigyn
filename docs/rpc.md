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
import { spawnRigynRpcClient } from "rigyn/interfaces";

const { client } = spawnRigynRpcClient({
  args: ["--workspace", process.cwd()],
});

const initialized = await client.request("initialize");
const off = client.onNotification("run.event", (event) => {
  console.log(event.sequence, event.event.type);
});

const started = await client.request("run.start", {
  provider: "YOUR_PROVIDER",
  model: "YOUR_MODEL",
  prompt: "Inspect package.json",
});
const completed = await client.request("run.wait", { threadId: started.threadId });

off();
await client.request("shutdown");
await client.close();
```

`spawnRigynRpcClient()` resolves the CLI shipped in the same package and launches it through the current Node.js executable. It does not depend on `PATH`, a shell, or the platform-specific `rigyn`/`rigyn.cmd` command shim. Its `args` are appended after the `rpc` subcommand, so the example above should pass only RPC flags: `args: ["--workspace", process.cwd()]`. Use the lower-level `spawnRpcClient()` only for an explicit executable-plus-argument transport that you own.

`RpcClient.request()` is typed by `RpcMethodMap`; `onNotification()` is typed by `RpcNotificationMap`. Aborting a request signal stops only the local wait because JSON-RPC has no generic cancellation method. Use `run.cancel`, `shell.cancel`, or `extension.command.cancel` to cancel corresponding server work. Closing an owned spawned client terminates its child process and rejects every pending request.

Standalone user-shell work has an explicit cancellation handle and does not start an agent run:

```ts
const thread = await client.request("thread.create", { name: "automation" });
const shell = client.runShell({
  threadId: thread.threadId,
  command: "npm test",
});

// The run ID is available before the command settles.
console.log(shell.runId);
// From another callback: await shell.cancel("superseded");
const shellResult = await shell.result;
```

`runShell()` generates a bounded caller-known run ID unless one is supplied. Its request remains pending until the command settles, while `shell.cancel` can be sent concurrently. Locally aborting only the result wait does not cancel the command; call `cancel()` explicitly. The initial `cwd` must resolve inside the server workspace, but this is path scoping rather than process isolation: the command still runs with the Rigyn process user's permissions. Visible results are appended to the selected thread as user-shell context. Set `excludeFromContext: true` for an execution whose redacted result must not enter the transcript.

Call `initialize` first when writing a long-lived client. Its capability object is the source of truth for optional limits and surfaces. `health`, `version`, and `capabilities` are also available before initialization. The server does not silently emulate a capability that is absent.

Durable subscriptions replay events after an optional sequence cursor and then hand off to live delivery:

```ts
const subscription = await client.subscribeEvents(
  { threadId, afterSequence: lastSequence, limit: 256 },
  (event) => saveCursor(event.sequence),
  { onError: console.error, maxPendingEvents: 1024, maxPendingBytes: 8 * 1024 * 1024 },
);

await subscription.unsubscribe();
```

Replay is ordered by durable event sequence. The optional `limit` controls the bounded internal replay batch size (default 256, maximum 1024); the subscription automatically continues every historical batch and then hands off to live delivery. The subscribe response reports the fixed snapshot as `replayedThrough` and describes its initial batch with the exclusive `nextCursor` and `hasMore` fields. Notifications that race with that response are buffered by the typed client during the replay/live handoff. The typed client invokes one subscription callback at a time in notification order without creating an unbounded callback chain. `maxPendingEvents` and `maxPendingBytes` bound accepted callback work, defaulting to 1024 events and 8 MiB; their compiled maxima are 16384 events and 64 MiB. Exceeding either limit stops the remote subscription, drains already accepted callbacks in order, and reports the failure through `onError`. Calling `unsubscribe()` immediately detaches notification listeners, asks the server to stop once, drains callbacks for events already accepted, and resolves after both the drain and server acknowledgement; repeated calls share that completion. Server-side unsubscribe is idempotent, including when `events.error` won the stop race.

Each replay or live subscription notification must fit the advertised `maxSerializedEventBytes`. The replay/live handoff also obeys the advertised `maxPendingLiveEvents` and `maxPendingLiveBytes` bounds before retaining an event. If one durable event cannot fit, the server stops before it and emits `events.error` with `blocked: { reason, sequence, serializedBytes, maximumBytes, resumeAfterSequence }`; the initial subscribe result also contains `blocked` when the first replay page detects it. A transport or writer failure also attempts an `events.error` notification. In every case the reported cursor remains on the last event whose `events.event` notification completed successfully. Advancing `afterSequence` to `resumeAfterSequence` explicitly skips a blocked event; reconnecting with the unchanged cursor encounters it again. Consumers should persist the highest processed sequence and reconnect with `afterSequence`. `events.error` means that subscription stopped; it does not invalidate the thread.

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
| `events.error` | { subscriptionId, cursor, reason, blocked? } | A durable event subscription stopped at a cursor. |
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

Runs, user-shell commands, queue leases, extension commands, and blocking extension UI requests are owned by the peer that created them. Another peer cannot wait, cancel, acknowledge, or answer them. Disconnect cancels peer-owned active work, releases its queue leases, and cancels its UI requests; durable thread events and recoverable queued input remain.

`run.cancel`, `shell.cancel`, and `extension.command.cancel` acknowledge a cancellation request; final settlement is observed through `run.wait`, the pending `shell.run` response, notifications, or command completion. `run.retry.cancel` is narrower: it returns `{ accepted: true }` only while a retry delay is scheduled and leaves the run itself open to settle with the original provider failure. `retry.get` and `retry.set` inspect or change the process-local automatic retry toggle; persist `providerRetry.enabled` in `config.jsonc` when the choice must survive a restart. `shutdown` enters draining state, cancels active work, acknowledges `{ shuttingDown: true }`, then asks the stdio host to close input. During drain, only `health` and `run.wait` remain accepted.

## Sessions, branches, and exports

Thread methods are scoped to the server workspace. A branch argument defaults to the thread default branch. `thread.events` always returns `{ events, nextCursor, hasMore, blocked? }`; the cursor is exclusive, the default page is 256 events, and the hard maximum is 1024. Results also stay below the advertised serialized-byte ceiling. Count and byte limits may therefore produce fewer events than requested while setting `hasMore`. If one event alone exceeds `maxSerializedEventBytes`, the page excludes it, leaves `nextCursor` before it, and reports the same bounded `blocked` metadata described above. Advancing to `blocked.resumeAfterSequence` is an explicit decision to skip that event. Event pages, durable subscription notifications, and live `run.event` notifications use the same portable projection: provider continuation state, opaque provider blocks, provider-private reasoning text, raw usage/error payloads, response identifiers, and arbitrary warning details are omitted before byte accounting or delivery. `thread.fork` creates a branch inside a thread. `thread.forkMessages` provides exclusive-cursor pages of visible user-message candidates for clients that implement a fork picker; each preview is UTF-8 bounded and reports truncation. `thread.export` returns inline data only within the advertised byte limit; use the CLI export command for larger sessions.

`thread.state` reports activity (including `operation: "shell"`), queue counts, current selection, and the effective automatic-compaction policy. `thread.model.set` and `thread.thinking.set` validate and durably update an idle thread without creating an agent run; both reject active agent or user-shell work instead of racing it. `thread.model.cycle` follows the configured scoped-model order in either direction and preserves a compatible thinking level. `thread.thinking.cycle` follows the selected model's declared levels. Either cycle returns `null` when there is nothing meaningful to select. `thread.autoCompaction.set` is a process-local branch override: an active run observes it before subsequent compaction decisions, `/reload` preserves it, and a process restart returns to the configured default. `thread.stats` reports bounded aggregate counts and normalized usage. `thread.lastAssistantText` returns visible assistant text only and rejects an over-limit result rather than returning a silent partial.

The `session.*` methods are ergonomic helpers over the multi-thread protocol. Each connected client has an independent, non-durable current thread-and-branch pointer; `run.start`, `session.new`, `session.switch`, `session.clone`, and `session.fork` update it. Disconnect clears only that pointer, never the durable session. Clone copies and selects the complete current branch path. Fork validates a user-message candidate, copies only the path before that message, and returns its bounded display text so a client can put it back in an editor. Both copy operations require the source thread to be idle. Clients that do not want current-session state can continue using the lower-level `thread.*` methods exclusively.

## Runs and durable input queues

`run.start` either creates a thread or binds an existing workspace thread, validates the exact model/provider/tool selection, persists the user turn, and returns the thread ID. At most one nonterminal run exists per thread. `run.wait` is owner-scoped and may be called while the dispatcher is draining.

Steering and follow-up input are persisted before acceptance. Queue inspection is bounded and paginated. If one item cannot fit a response, the result describes it as `blocked` and leaves it durable. `run.dequeue` leases one item; clients must call `run.dequeue.ack` after safely consuming it or `run.dequeue.release` to make it available again. A disconnect releases outstanding leases. Recovered items are never replayed automatically.

## Models and authentication

Model operations separate durable catalog status, listing, refresh, reference resolution, and idle-thread selection. Resolution rejects ambiguous references, and selection rejects a registered provider without usable active authentication. Authentication reads return secret-free state. `auth.set` is the only method whose request intentionally carries a reusable secret; it is appropriate only over this trusted local stdio channel. `auth.delete` may optionally attempt remote revocation, and cancellation does not silently delete a credential whose requested revocation did not complete.

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
| `thread.events` | threadId, branch?, afterSequence?, limit? | RpcEventPage | Read a bounded cursor page of durable events on a branch. |
| `thread.state` | threadId, branch? | RpcThreadState | Read active state, selection, and pending counts. |
| `thread.stats` | threadId, branch? | RpcThreadStatistics | Read message, run, usage, and context statistics. |
| `thread.lastAssistantText` | threadId, branch? | { text } | Read bounded text from the latest assistant message. |
| `thread.fork` | threadId, newBranch, fromBranch?, atEventId? | BranchRecord or cancelled | Fork a branch at a durable event. |
| `thread.forkMessages` | threadId, branch?, afterSequence?, limit? | RpcForkMessagePage | Read a bounded cursor page of user-message fork candidates. |
| `thread.name` | threadId, name | ThreadRecord | Set a thread name. |
| `thread.delete` | threadId | { deleted } | Delete a workspace thread. |
| `thread.export` | threadId, format?, branch? | RpcThreadExportResult | Export bounded JSONL, Markdown, or HTML. |
| `thread.compact` | threadId, provider, model, branch?, budgets? | AgentRunResult | Run manual context compaction. |
| `thread.model.set` | threadId, reference, branch?, provider?, reasoningEffort?, refresh? | RuntimeModelSelection | Persist an idle thread model selection without starting a run. |
| `thread.model.cycle` | threadId, branch?, direction?, refresh? | RpcModelCycleResult or null | Cycle an idle thread through its configured model scope. |
| `thread.thinking.set` | threadId, reasoningEffort, branch? | RuntimeModelSelection | Persist an idle thread thinking level without starting a run. |
| `thread.thinking.cycle` | threadId, branch? | RpcThinkingCycleResult or null | Cycle an idle thread through levels supported by its selected model. |
| `thread.autoCompaction.set` | threadId, branch?, enabled | { threadId, branch, enabled } | Set the automatic-compaction policy for subsequent RPC runs on a thread branch. |
| `session.current` | none | RpcCurrentSession or null | Read this client's current-session pointer. |
| `session.new` | name?, parentCurrent? | RpcCurrentSession | Create and select a new current session for this client. |
| `session.switch` | threadId, branch? | RpcCurrentSession | Select a workspace session as this client's current session. |
| `session.clone` | name? | RpcSessionCopyResult | Clone and select the complete current session path. |
| `session.fork` | eventId, name? | RpcSessionForkResult | Fork before a current-path user message and select the new session. |
| `events.subscribe` | threadId, branch?, afterSequence?, limit? | RpcEventSubscriptionResult | Start bounded-batch replayable durable-event delivery. |
| `events.unsubscribe` | subscriptionId | { unsubscribed } | Stop an event subscription. |
| `run.start` | RpcRunStartParams | { threadId, handled? } | Start a caller-owned agent run. |
| `run.wait` | threadId | HarnessRun or AgentRunResult | Wait for a caller-owned run or compaction. |
| `run.cancel` | threadId, reason? | { accepted } | Cancel a caller-owned run. |
| `run.retry.cancel` | threadId | { accepted } | Cancel only a caller-owned scheduled retry delay. |
| `run.steer` | threadId, message, images? | { accepted, handled? } | Queue steering input for an active run. |
| `run.followUp` | threadId, message, images? | { accepted, handled? } | Queue follow-up input for an active run. |
| `run.queue` | threadId, branch?, offset?, limit? | RpcQueueResult | Inspect bounded durable queued input. |
| `run.dequeue` | threadId, branch? | RpcDequeueResult | Lease one durable queued input item. |
| `run.dequeue.ack` | leaseId | { accepted } | Acknowledge and remove a queue lease. |
| `run.dequeue.release` | leaseId | { accepted } | Release a queue lease without removing it. |
| `run.queueModes.get` | threadId | queue modes | Read active run queue modes. |
| `run.queueModes.set` | threadId, steeringMode?, followUpMode? | queue modes | Change active run queue modes. |
| `retry.get` | none | { enabled } | Read the process-local automatic retry toggle. |
| `retry.set` | enabled | { enabled } | Change the process-local automatic retry toggle. |
| `shell.run` | runId, threadId, command, branch?, cwd?, excludeFromContext?, timeoutMs? | RpcUserShellRunResult | Run a bounded caller-owned user shell command. |
| `shell.cancel` | runId, reason? | { accepted } | Cancel a caller-owned user shell command. |
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
