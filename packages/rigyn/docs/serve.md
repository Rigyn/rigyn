# HTTP and SSE service

Use `rigyn serve` when a trusted local program must control rigyn through HTTP.
The service uses the same `AgentSession`, kernel runtime engine,
`ToolCoordinator`, compactor, and V4 journal as the interactive, print, JSON,
RPC, and SDK modes. It does not create a second agent loop, queue, compactor,
or session store.

The service is for one local operator. It is not a public, multi-tenant server.

Each registered HTTP session keeps one immutable service identity. A direct
extension command cannot replace that identity: `newSession`, `fork`, and
`switchSession` return `{ cancelled: true }` in this host. Use `POST
/v1/sessions` or `POST /v1/sessions/open` to register another session. Extension
commands can still navigate the current session tree and refresh resources.

The command-line service does not synthesize per-tool approval prompts. A Node.js host invoking `main(["serve", ...], { toolAuthorizationHandler })` can install the same host-owned authorization callback used by the SDK; it is forwarded to every created or opened service session. Omission preserves allow behavior. See [SDK composition](sdk.md#host-owned-tool-authorization).

## Start the service

Set a bearer token in the process environment. Do not put the token in a
command-line argument.

```sh
export RIGYN_SERVE_TOKEN="replace-this-with-a-long-random-secret"
rigyn serve
```

The default address is `http://127.0.0.1:4317`.
The CLI accepts only `127.0.0.1`, `localhost`, or `::1`. It rejects a host
that can listen on an external network interface. It pins `localhost` to
`127.0.0.1` instead of trusting system name resolution.

Use these options when necessary:

```sh
rigyn serve --host 127.0.0.1 --port 4317 \
  --workspace /path/to/project \
  --session-dir /path/to/sessions
```

Use `--approve` or `--no-approve` to make the project-resource trust decision
for this invocation. Use `--offline`, `--no-extensions`, or repeat
`--extension PATH` to control runtime resources.

Run `rigyn serve --help` for the installed command summary.

New sessions use the configured default model and thinking level. Opened
sessions use their restored selection first. Before serving a new
installation, run rigyn interactively and use `/login` and `/model`.

## Authentication

Every request requires this header:

```text
Authorization: Bearer YOUR_TOKEN
```

This rule also applies to `GET /health`. A client receives `401 Unauthorized`
when the token is absent or incorrect.

The token grants access to model requests and local tools. Keep it secret. Use
32 through 4,096 ASCII token68 characters. A token68 value uses letters,
digits, `-`, `.`, `_`, `~`, `+`, or `/`. It can have `=` padding at the end.
Do not write the token in a URL, repository, session file, or client log.

## Endpoints

All request and response bodies use JSON unless the endpoint is an SSE stream.
Send `Content-Type: application/json` with each JSON request.

| Method and path | Purpose |
| --- | --- |
| `GET /health` | Check that the authenticated service is running. |
| `POST /v1/sessions` | Create and register a session. |
| `POST /v1/sessions/open` | Open and register an existing durable session. |
| `GET /v1/sessions/:id` | Read a bounded session-state summary. |
| `DELETE /v1/sessions/:id` | Close the session runtime and release its service resources. |
| `POST /v1/sessions/:id/prompts` | Accept a prompt for the session. |
| `POST /v1/sessions/:id/cancel` | Cancel active work for the session. |
| `GET /v1/sessions/:id/recovery` | Read a suspended operation and its tool-effect IDs and statuses. |
| `POST /v1/sessions/:id/recovery` | Attempt safe recovery or submit explicit effect resolutions. |
| `GET /v1/sessions/:id/events` | Stream session events with SSE. |

URL-encode the session ID when you put it in a path.

### Create a session

Send an empty object to use the command workspace. You can also select a
workspace in the request.

```sh
curl -sS http://127.0.0.1:4317/v1/sessions \
  -H "Authorization: Bearer $RIGYN_SERVE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"workspace":"/path/to/project"}'
```

The response has status `201`. It contains the session ID and a bounded state
summary. The service subscribes to events before it starts the runtime. Startup
and recovery events are therefore available for SSE replay.

Startup attempts only recovery actions allowed by each tool's stored policy.
If an effect still needs an explicit decision, the session remains registered
and the summary reports `hasSuspendedRun: true`; use the recovery endpoints
before sending another prompt.

The client connection and service shutdown cancel session creation. If startup
does not finish, the service aborts and closes any runtime that the factory
created. It does not register a partial session.

### Open a durable session

```sh
curl -sS http://127.0.0.1:4317/v1/sessions/open \
  -H "Authorization: Bearer $RIGYN_SERVE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"SESSION_ID","workspace":"/path/to/project"}'
```

The response has status `200`. A missing session returns `404`. If the service
already owns that session, it returns the current state summary.

Only one writer can own a durable session file. Do not open the same session in
another rigyn process at the same time.

The client connection and service shutdown also cancel an in-progress open.
The service aborts and closes an unregistered runtime after cancellation,
startup failure, an ID mismatch, or a registration conflict.

### Read session state

`GET /v1/sessions/:id` returns operational state. The summary contains the
optional `model`, `thinkingLevel`, `isStreaming`, `isCompacting`,
`isRetrying`, `messageCount`, `toolCount`, `pendingMessageCount`, and
`hasSuspendedRun` fields. `pendingMessageCount` is the queue count. It is
separate from the current transcript `messageCount`. The summary does not
contain transcript messages, tool definitions, or the system prompt.

### Send a prompt

```sh
curl -sS http://127.0.0.1:4317/v1/sessions/SESSION_ID/prompts \
  -H "Authorization: Bearer $RIGYN_SERVE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Inspect this project and report the test command.","delivery":"follow_up"}'
```

`delivery` is optional. Its default is `follow_up`. A follow-up waits in the
canonical next-run queue when work is active. Use `steer` to deliver the
message to the active run instead.

The service returns status `202` only after prompt preflight accepts the
message. A rejected preflight does not return `202`. The acceptance response
does not mean that the model run is complete. Read the event stream to observe
text, reasoning, tools, usage, errors, and completion.

### Cancel active work

```sh
curl -sS http://127.0.0.1:4317/v1/sessions/SESSION_ID/cancel \
  -H "Authorization: Bearer $RIGYN_SERVE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"The caller stopped the task."}'
```

The `reason` field is optional.

### Recover an interrupted run

Cancellation can leave a dispatched tool effect with an uncertain external
outcome. `GET /v1/sessions/:id/recovery` returns `suspendedRun: null` when no
operation is suspended. Otherwise it returns the operation ID, acceptance
time, cancellation flag, attempt count, claimed queue IDs, and bounded tool
effects that still require settlement. Each effect includes `effectId`,
`callId`, `name`, `policy`, `status`,
`step`, `index`, and `inputHash`.
Prompt submission returns `409` while this recovery is still required.

First ask rigyn to apply only the effect's stored safe-recovery policy:

```sh
curl -sS -X POST \
  http://127.0.0.1:4317/v1/sessions/SESSION_ID/recovery \
  -H "Authorization: Bearer $RIGYN_SERVE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

The response contains `{ "sessionId", "recovery" }`. A recovery value with
`recovered: false` lists the blocked effect IDs, tool names, and reasons. The
service does not choose an outcome for them.

After the controlling program independently verifies an effect, it can submit
one resolution for that exact ID:

```json
{
  "resolutions": [
    { "effectId": "EFFECT_ID", "outcome": "abandoned" }
  ]
}
```

`abandoned` records a decision not to replay the effect. It does not assert
that an external action stopped, succeeded, failed, or was undone. A
`succeeded` resolution instead requires
`{"content":"verified result","isError":false}` in `result`; a `failed`
resolution requires `isError: true`. The request, resolution, and result
records are closed: unknown fields, duplicate effect IDs, mismatched results,
and a result attached to `abandoned` are rejected with status `400`.
A syntactically valid resolution for an effect that is no longer unsettled in
the current operation returns `409`; read the status again before retrying.

Opening a journal after a crash uses the same rule. Safe recovery is attempted,
but an uncertain effect remains reachable through these authenticated
endpoints until the caller supplies a decision. No HTTP or SSE path implicitly
abandons it.

### Close a session

```sh
curl -sS -X DELETE \
  http://127.0.0.1:4317/v1/sessions/SESSION_ID \
  -H "Authorization: Bearer $RIGYN_SERVE_TOKEN"
```

The service ends the session's SSE streams, cancels active work, closes the
runtime, and releases the open-session slot. It does not delete the durable V4
journal. Use the open endpoint to open that journal again.

## Event stream and reconnect

Open the stream before or after you send a prompt:

```sh
curl -N http://127.0.0.1:4317/v1/sessions/SESSION_ID/events \
  -H "Authorization: Bearer $RIGYN_SERVE_TOKEN"
```

Each normal SSE record has:

- a numeric `id`;
- an `event` name that matches the rigyn event type;
- a `data` value that contains one JSON `EventEnvelope`.

Save the last received ID. Send it in `Last-Event-ID` after a connection
failure:

```sh
curl -N http://127.0.0.1:4317/v1/sessions/SESSION_ID/events \
  -H "Authorization: Bearer $RIGYN_SERVE_TOKEN" \
  -H "Last-Event-ID: 42"
```

The service replays retained events after that ID. Replay storage is bounded
and exists only in memory. The service sends a `replay_gap` event when the
requested records are no longer available. Read the current session state
after a replay gap.

A `replay_gap` record has its own `id`. Save that ID as the new cursor. This
rule also applies when the replay buffer contains no normal event. A later
reconnect then continues after the known gap instead of reporting the same gap
again.

When a socket applies backpressure, the service keeps at most 256 queued
records or 1 MiB for that client and waits up to five seconds for it to drain.
It disconnects the client on timeout or overflow. Reconnect with the last saved
ID. The service then replays the events that are still in its bounded buffer.

The durable V4 journal stores session execution state. It does not store the
HTTP replay buffer. After a service restart, call the open endpoint and start a
new event stream.

## Default limits

The CLI uses these service defaults:

| Limit | Default |
| --- | --- |
| JSON request body | 64 KiB |
| Open sessions | 32 |
| SSE clients for one session | 8 |
| Retained SSE records for one session | 256 |
| Retained SSE bytes for one session | 8 MiB |

Library callers can set `maxBodyBytes`, `maxSessions`,
`maxClientsPerSession`, `maxReplayEvents`, and `maxReplayBytes` in
`StartServeServerOptions`. Each value must be a positive safe integer. The CLI
does not expose these limits as command-line flags.

## Security and scope

The service has these deliberate limits:

- It uses HTTP and SSE. It does not use WebSocket.
- The CLI binds only to loopback.
- It does not provide TLS or CORS.
- It does not provide users, roles, tenants, or permission scopes.
- It does not use SQLite. Durable sessions remain V4 JSONL journals.

For access from another machine, keep the CLI loopback binding and use a
reviewed encrypted tunnel. A browser client needs a trusted same-origin bridge
because the service does not enable CORS. A programmatic
`startServeServer()` caller owns any different network binding and its
encryption, authentication, and firewall boundary.

On shutdown, the service stops its event streams, cancels active work, and
closes every session that it owns.
