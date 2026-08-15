# Troubleshooting

Start with the privacy-ordered workflow in [Local diagnostics](diagnostics.md). Use non-content logs, stats, support,
configuration, and session checks before opening private records. Run `rigyn extensions doctor --offline` only after
the user authorizes executing the already-trusted extension runtime; trusted code can have its own side effects. A support file excludes credential values, session content,
configuration values, log and crash content, and resource bodies; it records local probe timings, path ownership,
resource summaries, and bounded errors.

## No model appears in the picker

Run `/login`, choose the provider, and reopen `/model`. The picker lists models from connected provider catalogs. It
does not show a universal static catalog. Use `rigyn --list-models` for the same verified view.
`rigyn --offline --list-models` can inspect fallback metadata, but does not prove availability. If a provider cannot
list deployments, register an exact catalog through a reviewed provider extension. Then select it with
`/model PROVIDER/MODEL` or `--model PROVIDER/MODEL`.

## OAuth login completes but the harness stays disconnected

Confirm that the browser/device flow returned to the same provider profile, then run `/login` and inspect provider
status again. Check system time, proxy configuration, and whether a corporate browser stripped the loopback callback.
Do not paste tokens into a support bundle or issue report.

## A package installs but contributes nothing

Run:

```sh
rigyn extensions doctor --offline
rigyn extensions show PACKAGE_ID
```

Check declared resource paths, package filters, project trust, and activation diagnostics. Declare the supported host
range through `peerDependencies.rigyn`; an incompatible or invalid range is rejected before activation.
`engines.rigyn` is report metadata only. Project packages remain inactive until trust and immutable-lock
reconciliation succeed. Dependency lifecycle scripts stay disabled unless a reviewed transaction explicitly enables
them.

## Refresh keeps the old behavior

`/refresh` sends `session_shutdown` to the current generation before activating a complete candidate. If the candidate
fails, rigyn disposes it and restarts the previous generation. Read the diagnostic, fix the candidate, and refresh
again. Changing the session directory requires a process restart.

## A long command appears frozen

Tool progress shows elapsed time even during quiet commands. Press Escape or Ctrl+C once to cancel the active
operation. The process runner terminates the owned process tree and continues to drain bounded output. When full
truncated output is available, the tool result names its private temporary artifact. See
[Bash overflow artifacts](install.md#bash-overflow-artifacts) for its limits, retention, and uninstall behavior.

## Context compacts earlier than expected

Check model catalog metadata, configured budgets, output reserve, and large tool results. A provider-reported overflow may force one safe compaction retry. See [Context compaction](compaction.md).

## OpenAI Codex reports a WebSocket failure

With `transport: auto`, Rigyn retries through HTTPS/SSE only after an eligible pre-output transport failure. Failures
already classified as authentication errors and provider-declared response failures are not replayed across transports.
An SSE fallback that fails before a successful terminal does not pin the identity, so an HTTP/SSE authorization failure
during fallback leaves it eligible to try WebSocket again after credentials recover. After a fallback succeeds, the
session, endpoint, and account identity stays on SSE for subsequent requests in the adapter lifetime, subject to the
bounded recent-identity limit. If visible or hidden reasoning, response text, a tool draft, or
unknown provider state was already received, Rigyn does not replay the same turn because repeating it may be unsafe;
the identity switches to SSE immediately for its next request. Set `transport: sse` to disable WebSocket use explicitly.
Local diagnostics record only bounded failure
class, semantic boundary, close code, and an allowlisted native transport code when available; they never include the
URL, close reason, credentials, or request and response content.

## RPC client stops receiving replies

RPC uses one UTF-8 JSON object per LF-delimited line. Correlate concurrent responses by `id` and keep diagnostics on
stderr. The transport has no advertised record-size limit, so a host that accepts untrusted input must set its own
bound. Raw event subscriptions are process-local and have no replay cursor. After reconnecting, use `get_entries`
with `afterSequence` to page durable history. Malformed JSON and duplicate or stale UI replies fail closed.

## Session import fails

Verify that JSONL begins with a strict V4 `record: "session"` header. Every
later LF-terminated line must be a valid ordered commit. Invalid UTF-8, JSON,
schema, sequence, ancestry, operation, queue, or tool-effect transitions are
rejected. `/import` copies the selected file into the active session directory
before opening it. Keep a backup and inspect private content first. If the
stored working directory no longer exists, interactive mode asks whether to
continue in the current directory and retries only after approval.
