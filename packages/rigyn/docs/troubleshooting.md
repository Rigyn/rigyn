# Troubleshooting

Start with `rigyn diagnostics ./support.json` and `rigyn extensions doctor`. The support file excludes credential values, session content, configuration values, and resource bodies while recording local probe timings, path ownership, resource summaries, and bounded errors.

## No model appears in the picker

Run `/login`, choose the intended provider, and then reopen `/model`. The picker lists models currently available from connected provider catalogs; it does not show a universal static catalog. Use `rigyn --list-models` for the same verified view. `rigyn --offline --list-models` can inspect fallback metadata, but does not prove availability. If a provider cannot list deployments, register an exact model catalog through a reviewed provider extension and select it explicitly with `/model PROVIDER/MODEL` or `--model PROVIDER/MODEL`.

## OAuth login completes but the harness stays disconnected

Confirm that the browser/device flow returned to the same provider profile, then run `/login` and inspect provider status again. Check system time, proxy configuration, keychain availability, and whether a corporate browser stripped the loopback callback. Do not paste tokens into a support bundle or issue report.

## A package installs but contributes nothing

Run:

```sh
rigyn extensions doctor
rigyn extensions show PACKAGE_ID
```

Check declared resource paths, package resource filters, project trust, and runtime activation diagnostics. Declare the supported host range through `peerDependencies.rigyn`; an incompatible or invalid range is rejected before activation. `engines.rigyn` is report metadata only. Project packages are inert until trust and immutable-lock reconciliation succeed. Dependency lifecycle scripts remain disabled unless an imperative, reviewed transaction explicitly enables them.

## Reload keeps the old behavior

`/reload` sends `session_shutdown` to the current generation before it activates a complete candidate. A candidate error disposes that candidate and restarts the previous generation. Read the reload diagnostic, fix the candidate, and reload again. A changed session directory requires a process restart.

## A long command appears frozen

Tool progress includes elapsed time even during quiet commands. Press Escape/Ctrl+C once to cancel the active operation. The process runner terminates the owned process tree and continues draining bounded output. Full truncated output, when available, is stored in a private temporary artifact named by the tool result.

## Context compacts earlier than expected

Check model catalog metadata, configured budgets, output reserve, and large tool results. A provider-reported overflow may force one safe compaction retry. See [Context compaction](compaction.md).

## RPC client stops receiving replies

RPC is one UTF-8 JSON object per LF-delimited line. Correlate concurrent responses by `id` and keep diagnostics on stderr. The transport does not advertise a record-size limit, so a host accepting untrusted input must impose its own bound. Raw event subscriptions are process-local and have no replay cursor; use `get_entries` with `afterSequence` to page durable session history after reconnecting. Malformed JSON and duplicate or stale UI replies fail closed.

## Session import fails

Verify that JSONL begins with a `type: "session"` header and that every completed non-empty line is valid JSON. Malformed newline-terminated JSON and a workspace mismatch are rejected; version 1 and 2 records are migrated when opened. The current reader is not a complete schema validator for every entry field, so import only a trusted rigyn export. `/import` copies the selected file into the active session directory before opening it; keep a backup and inspect private content first.
