# Troubleshooting

Start with `rigyn diagnostics ./support.json` and `rigyn extensions doctor`. The support file excludes credential values, session content, configuration values, and resource bodies while recording local probe timings, path ownership, resource summaries, and bounded errors.

## No model appears in the picker

Run `/login`, choose the intended provider, and then reopen `/model`. The picker lists models currently available from connected provider catalogs; it does not show a universal static catalog. Use `rigyn --list-models` for a noninteractive view. If a provider cannot list deployments, add an exact model entry in configuration.

## OAuth login completes but the harness stays disconnected

Confirm that the browser/device flow returned to the same provider profile, then run `/login` and inspect provider status again. Check system time, proxy configuration, keychain availability, and whether a corporate browser stripped the loopback callback. Do not paste tokens into a support bundle or issue report.

## A package installs but contributes nothing

Run:

```sh
rigyn extensions doctor
rigyn extensions show PACKAGE_ID
```

Check host-version compatibility, manifest paths, package resource filters, project trust, and runtime activation diagnostics. Project packages are inert until trust and immutable-lock reconciliation succeed. Dependency lifecycle scripts remain disabled unless an imperative, reviewed transaction explicitly enables them.

## Reload keeps the old behavior

`/reload` activates a complete candidate generation before replacing the current one. A candidate error leaves the old generation running. Read the reload diagnostic, fix the candidate, and reload again. A changed session database path requires a process restart.

## A long command appears frozen

Tool progress includes elapsed time even during quiet commands. Press Escape/Ctrl+C once to cancel the active operation. The process runner terminates the owned process tree and continues draining bounded output. Full truncated output, when available, is stored in a private temporary artifact named by the tool result.

## Context compacts earlier than expected

Check model catalog metadata, configured budgets, output reserve, and large tool results. A provider-reported overflow may force one safe compaction retry. See [Context compaction](compaction.md).

## RPC client stops receiving replies

RPC is one UTF-8 JSON object per LF-delimited line. Correlate concurrent responses by `id`, keep diagnostics on stderr, and respect the advertised maximum line size. Reconnect event subscriptions with their durable cursor. Invalid UTF-8, oversized frames, duplicate/stale UI replies, and malformed JSON fail closed.

## Session import fails

Verify that JSONL begins with the supported format record, contains one linear parent chain per branch, references runs only after `run_started`, and contains valid bounded base64 artifacts. Legacy headerless exports remain accepted. Unsupported versioned inputs are refused rather than guessed.
