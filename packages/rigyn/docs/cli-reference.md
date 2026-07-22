# CLI command and flag reference

Run `rigyn --help` for the installed version's authoritative summary and `rigyn COMMAND --help` for a subcommand. Options may precede prompt text; `@FILE` arguments attach prompt references.

## Interactive and one-shot invocation

```text
rigyn [OPTIONS] [@FILES...] [MESSAGES...]
```

| Flag | Meaning |
| --- | --- |
| `-p`, `--print` | Process the prompt non-interactively and exit |
| `--mode text\|json\|rpc` | Select final text, event JSON, or newline-delimited RPC |
| `--workspace DIR` | Set the project workspace |
| `--provider NAME` | Select a provider |
| `--model PATTERN` | Select a model or provider/model pair |
| `--models PATTERNS` | Set the comma-separated model cycle |
| `--thinking LEVEL` | Select `off` through `max` |
| `--api-key KEY` | Supply an invocation-only key; it is not persisted |
| `--no-browser` | Print OAuth URLs without opening a browser |
| `--max-steps NUMBER` | Bound model turns in one run |
| `--max-output-tokens NUMBER` | Bound requested output tokens |
| `--offline` | Skip startup network refreshes |
| `--verbose` | Show expanded startup details |

## Sessions

| Flag | Meaning |
| --- | --- |
| `-c`, `--continue` | Continue the latest session in scope |
| `-r`, `--resume` | Open the session picker |
| `--session REF` | Resume an exact or unambiguous reference |
| `--session-id ID` | Use or create an exact project session ID |
| `--fork REF` | Create an independent continuation |
| `--session-dir DIR` | Override session storage and lookup directory |
| `--all` | Search across workspaces for session selection |
| `--no-session` | Use an ephemeral conversation |
| `-n`, `--name NAME` | Set the session display name |

## Tools and resources

The seven built-ins—`read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`—are active by default in interactive, print, JSON, and RPC modes. `--tools LIST` is an allowlist. `--no-tools` disables every tool, while `--no-builtin-tools` keeps extension tools and `--exclude-tools LIST` removes selected names. Repeat `--extension`, `--skill`, `--prompt-template`, or `--theme` to add invocation-only resources.

Automatic discovery can be disabled independently with `--no-extensions`, `--no-skills`, `--no-prompt-templates`, and `--no-themes`. `--no-context-files` disables global and project instruction discovery. `--system-prompt TEXT` replaces the built-in prompt; `--append-system-prompt TEXT` adds to it.

`--approve` trusts project-local resources for this invocation and `--no-approve` ignores them. Neither option grants an operating-system sandbox.

## Administrative commands

| Command | Purpose |
| --- | --- |
| `install SOURCE [-l]` | Install a user or project package |
| `remove SOURCE [-l]` | Remove an installed package |
| `update [SOURCE] [--all]` | Update installed packages |
| `list [-l] [--json]` | List package state |
| `config [-l]` | Select enabled package resources |
| `config path [--scope user\|project]` | Print the exact settings path without creating it |
| `config edit [--scope user\|project]` | Transactionally edit user or trusted-project settings |
| `packages check` | Validate trusted project declarations and locks |
| `packages reconcile` | Restore the exact immutable locked package set without resolving moving sources |
| `packages update ID...` | Intentionally resolve selected declared packages, rewrite the lock, and reconcile |
| `packages update --all` | Intentionally resolve and lock project packages |
| `extensions doctor` | Diagnose extension resource discovery |
| `extensions author report PACKAGE` | Verify an authoring package through the production loader |
| `sessions doctor [--json]` | Validate session headers and trees |
| `diagnostics [FILE]` | Create a bounded redacted support report |
| `self-install`, `self-update` | Manage the private installation |
| `uninstall --yes` | Remove installation-owned application and state |

Package dependency lifecycle scripts remain disabled unless `--allow-scripts` is explicitly supplied to the reviewed install or update transaction.

## Export and model listing

`--list-models [TEXT]` lists connected provider models and exits. `--export SESSION.jsonl [OUTPUT.html]` creates a standalone HTML transcript. Add `--redact` to produce a sharing copy that still requires human review.

Exit status is zero for successful command completion and nonzero for invalid arguments, startup failures, or failed administrative operations. In JSON and RPC modes, keep standard output reserved for protocol data; diagnostics go to standard error.
