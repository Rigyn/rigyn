# RPC protocol and typed client

Run `rigyn --mode rpc` to embed one Rigyn session in another process. Standard input accepts commands and extension-UI responses. Standard output emits command responses, raw agent events, and extension-UI requests. Every record is one UTF-8 JSON object followed by LF.

## Transport

- Split records on `\n` only. U+2028 and U+2029 are ordinary characters inside JSON strings.
- CRLF input is accepted by removing the trailing `\r` from a record.
- Input is decoded with the platform UTF-8 stream decoder, which replaces malformed byte sequences. The protocol does not invent a record-size limit; embedders that accept untrusted input should apply their own transport bound.
- Standard output is protocol-only. Human diagnostics use standard error.
- Commands may overlap. Correlate each response with the command's optional string `id`.

A successful response is:

```json
{"id":"req_1","type":"response","command":"get_state","success":true,"data":{}}
```

A failed response is:

```json
{"id":"req_1","type":"response","command":"get_state","success":false,"error":"reason"}
```

An unknown command retains its `id` and command name in the failure response. Invalid JSON produces a failure whose command is `parse` and which has no ID.

## Node.js client

`RpcClient` starts the packaged CLI through the current Node.js executable. It rejects pending commands if the child exits or its input fails, and it delivers every non-response record to `onEvent()` listeners.

```ts
import { RpcClient } from "rigyn/interfaces";

const client = new RpcClient({
  cwd: process.cwd(),
  provider: "YOUR_PROVIDER",
  model: "YOUR_MODEL",
});

await client.start();
const off = client.onEvent((event) => {
  console.log(event.type);
});

const events = await client.promptAndWait("Inspect package.json");
console.log(events.at(-1)?.type);

off();
await client.stop();
```

`promptAndWait()` subscribes before sending the prompt, so it cannot miss a fast completion. `waitForIdle()` and `collectEvents()` settle on the raw `agent_settled` event, after terminal cleanup and queued work have finished. Each command has a 30-second response timeout; event-wait helpers accept their own timeout.

## Commands

All command records have an optional string `id` and a `type`.

### Prompting and queues

| Type | Fields | Result |
| --- | --- | --- |
| `prompt` | `message`, `images?`, `streamingBehavior?` | Acknowledged after prompt preflight succeeds; agent events follow. |
| `steer` | `message`, `images?` | Queues steering input for the active run. |
| `follow_up` | `message`, `images?` | Queues follow-up input. |
| `abort` | none | Cancels the active operation and waits for it to settle. |
| `set_steering_mode` | `mode` | Selects `all` or `one-at-a-time`. |
| `set_follow_up_mode` | `mode` | Selects `all` or `one-at-a-time`. |

When `prompt.streamingBehavior` is `steer` or `followUp`, a prompt received during an active run is queued through that path and acknowledged. Without it, a second simultaneous prompt fails.

### State, model, and thinking

| Type | Fields | Result data |
| --- | --- | --- |
| `get_state` | none | Current model, thinking, stream/compaction state, queue modes, session identity, and counts. |
| `set_model` | `provider`, `modelId` | The selected available model. |
| `cycle_model` | none | The next scoped model and thinking level, or `null`. |
| `get_available_models` | none | `{ models }`. |
| `set_thinking_level` | `level` | none |
| `cycle_thinking_level` | none | `{ level }` or `null`. |
| `get_available_thinking_levels` | none | `{ levels }`. |

### Compaction, retry, and shell

| Type | Fields | Result data |
| --- | --- | --- |
| `compact` | `customInstructions?` | The completed compaction run. |
| `set_auto_compaction` | `enabled` | none |
| `set_auto_retry` | `enabled` | none |
| `abort_retry` | none | none |
| `bash` | `command`, `excludeFromContext?` | Shell output, exit code, cancellation, and truncation metadata. |
| `abort_bash` | none | none |

### Sessions

| Type | Fields | Result data |
| --- | --- | --- |
| `new_session` | `parentSession?` | `{ cancelled }`. |
| `switch_session` | `sessionPath` | `{ cancelled }`. |
| `fork` | `entryId` | `{ text, cancelled }`; the selected user text can be restored to an editor. |
| `clone` | none | Clones through the current leaf and returns `{ cancelled }`. |
| `get_fork_messages` | none | Visible user-message fork candidates. |
| `get_entries` | `since?`, `afterSequence?`, `limit?` | A bounded append-order entry page plus cursor and current-leaf metadata. |
| `get_tree` | none | Session tree and current leaf ID. |
| `get_session_stats` | none | Message/tool counts, normalized usage, cost, and context use. |
| `get_last_assistant_text` | none | `{ text }`, using `null` when absent. |
| `set_session_name` | `name` | none |
| `export_html` | `outputPath?` | `{ path }`. |
| `get_messages` | none | Reconstructed current-session messages. |

Session replacement runs the same extension cancellation guards and lifecycle teardown as the interactive host. Successful replacement rebinds extensions and raw event delivery to the new session before the response is returned.

`get_entries` returns at most 512 entries by default and accepts `limit` from 1 through 2048. Use either the stable exclusive entry ID in `since` or the prior page's `nextSequence` in `afterSequence`; supplying both is an error. The response also includes `sequenceStart`, `nextSequence`, `hasMore`, and `totalEntries`, so clients can consume very large append-only histories without one oversized response.

### Discoverable commands

`get_commands` returns extension commands, prompt templates, and skills. Each record includes its invocation name, description when present, kind (`extension`, `prompt`, or `skill`), and source metadata.

## Raw events

Agent events are emitted directly, not wrapped in an RPC notification envelope. Consumers receive the same `type` records as the session event stream. Summary backoff is bracketed by `summarization_retry_scheduled`, `summarization_retry_attempt_start`, and `summarization_retry_finished`; the scheduled event carries retry count, delay, and a bounded error message. A prompt's success response confirms acceptance. `agent_end` closes the agent run; `agent_settled` is the authoritative idle boundary after cleanup, compaction, retry, and queued follow-up handling.

## Extension UI

An extension can emit:

- blocking `select`, `confirm`, `input`, and `editor` requests;
- presentation updates for `notify`, `setStatus`, `setWidget`, `setTitle`, and `set_editor_text`.

Each output record has `type: "extension_ui_request"` and a unique string `id`. Reply to a blocking request with exactly one of:

```json
{"type":"extension_ui_response","id":"REQUEST_ID","value":"selection or text"}
{"type":"extension_ui_response","id":"REQUEST_ID","confirmed":true}
{"type":"extension_ui_response","id":"REQUEST_ID","cancelled":true}
```

Raw terminal input, arbitrary terminal components, custom overlays, autocomplete providers, and theme switching are not serialized in RPC mode.

## Shutdown

Closing standard input shuts down the owned session and its runtime generation. `RpcClient.stop()` sends `SIGTERM`, waits up to one second, and escalates to `SIGKILL` if necessary. On Node.js 26 the CLI relays file descriptor 0 through a bounded child process to avoid the runtime's inherited-stdin regression; this does not change protocol records.
