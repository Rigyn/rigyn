# CLI command and flag reference

Run `rigyn --help` for the installed version's authoritative summary. Run `rigyn COMMAND --help` for a subcommand.
In the interactive TUI, run `/help` to show the interactive command list.
Options may come before prompt text. `@FILE` arguments attach prompt references.

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
| `--max-output-tokens NUMBER` | Bound output per model turn, clamped to a known model ceiling |
| `--offline` | Disable automatic network resolution; selected moving npm or Git package updates fail before work starts |
| `--verbose` | Show expanded startup details |
| `-h`, `--help` | Show command help |
| `-v`, `--version` | Show the installed version |

With terminal input and output, omitting both `--print` and `--mode` starts the interactive TUI. An explicit `--mode text` selects one-shot text output; `--print` is its shortcut.

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

The seven built-ins—`read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`—are active by default in interactive,
print, JSON, RPC, and serve modes. Interactive, print, JSON, and RPC invocations accept `--tools LIST` as an
allowlist. `--no-tools` disables every tool. `--no-builtin-tools` keeps only extension tools.
`--exclude-tools LIST` removes selected names. Serve uses the persisted tool policy. Repeat `--extension`, `--skill`,
`--prompt-template`, or `--theme` to add resources for one ordinary agent invocation; `rigyn serve` accepts
repeatable `--extension` but not the skill, prompt-template, or theme flags.

Automatic discovery can be disabled independently with `--no-extensions`, `--no-skills`, `--no-prompt-templates`, and `--no-themes`. `--no-context-files` disables global and project instruction discovery. `--system-prompt TEXT` replaces the built-in prompt; `--append-system-prompt TEXT` adds to it.

`--approve` trusts project-local resources for this invocation and `--no-approve` ignores them. Neither option grants an operating-system sandbox.

## Administrative commands

Options accepted by an administrative command may precede its command name. An incompatible or repeated leading
option fails before agent or session startup. A `--` before a command-like word keeps that word in the ordinary agent
invocation; a `--` after the command ends option parsing for that administrative command.

| Command | Purpose |
| --- | --- |
| `install SOURCE [-l\|--local]` | Install a user or project package |
| `remove SOURCE [-l\|--local]` | Remove an installed package |
| `update [SOURCE] [--all]` | Update installed packages |
| `list [-l\|--local] [--json]` | List package state |
| `config [-l\|--local]` | Select enabled package resources |
| `config path [--scope user\|project] [--json]` | Print the exact settings path without creating it |
| `config edit [--scope user\|project]` | Transactionally edit user or trusted-project settings |
| `config validate [--scope user\|project] [--json]` | Validate the selected merged settings scope without writing files |
| `serve [--host HOST] [--port PORT]` | Run the authenticated local HTTP and SSE service |
| `packages check` | Validate trusted project declarations and locks |
| `packages reconcile` | Restore the exact immutable locked package set without resolving moving sources |
| `packages update ID...` | Intentionally resolve selected declared packages, rewrite the lock, and reconcile |
| `packages update --all` | Intentionally resolve and lock project packages |
| `extensions doctor [--offline]` | Activate already-trusted extensions and diagnose their runtime resources |
| `extensions author validate\|inspect\|smoke\|refresh\|report PACKAGE` | Run one author check or the combined report described in [Packages](packages.md#author-verification) |
| `extensions author pack PACKAGE DESTINATION` | Verify and write one reviewed package archive into the destination directory; JSON reports its exact path and SHA-256 |
| `extensions author index GALLERY.json` | Validate a package-gallery index as described in [Package gallery](package-gallery.md) |
| `sessions doctor [--json] [--all] [--workspace DIR] [--session-dir DIR]` | Validate session headers and trees |
| `diagnostics [FILE]` | Create a bounded redacted support report |
| `logs [--json]` | Show bounded metadata for local logs, redraw diagnostics, support files, crashes, and sessions without reading contents |
| `stats [--json]` | Summarize bounded metadata-only aggregates from recognized local logs |
| `completions bash\|zsh\|fish` | Print a static completion script for the selected shell |
| `self-install` | Create a source-built private installation; unavailable inside a standalone release |
| `self-update` | Update a source-built private installation; a standalone release reports its installer command |
| `uninstall --yes` | Fully remove a source-built or standalone installation and its managed state |
| `self-uninstall --yes` | Alias for `uninstall --yes` |

`-l` and `--local` are equivalent project-scope selectors for `install`,
`remove`, `list`, and `config`.

Package dependency lifecycle scripts stay disabled unless you explicitly pass `--allow-scripts` to a reviewed
install or update.

Session doctor uses the same directory precedence as a runtime session: explicit `--session-dir`,
`RIGYN_SESSION_DIR`, then effective trusted configuration. Without `--all`, it reports sessions for the selected
workspace; `--all` scans every workspace in the default root or every session in the resolved custom directory.

## Local stats

`rigyn stats [--json]` reads only aggregate snapshots from recognized private log files. It selects the latest
valid cumulative snapshot for each runtime observer before summing, so periodic snapshots and rotated segments are not
double-counted. Unsupported token, cost, and provider-duration values are omitted. Cache hit percentage is cache
read tokens divided by input, cache-read, and cache-write prompt tokens. Bounded or malformed input produces a
visible partial source summary instead of silently claiming complete coverage. It never reads session or message
content. See [Local diagnostics](diagnostics.md) for the privacy-ordered workflow and the additional validation
surfaces. The JSON field `source.processes` keeps its original name for schema
compatibility, but counts retained runtime-observer streams rather than
operating-system processes.

## Shell completion

Completion generation is static: it reads the same command, option, and fixed-value metadata as the CLI parser and
does not load providers, models, sessions, extensions, or user-controlled shell data. Load it for the current shell:

```sh
# Bash
source <(rigyn completions bash)

# Zsh (after compinit)
source <(rigyn completions zsh)

# Fish
rigyn completions fish | source
```

For persistent Bash or Fish completion, save the generated output in the shell's user completion directory:

```sh
mkdir -p "${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions"
rigyn completions bash > "${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions/rigyn"

mkdir -p "$HOME/.zfunc"
rigyn completions zsh > "$HOME/.zfunc/_rigyn"

mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/fish/completions"
rigyn completions fish > "${XDG_CONFIG_HOME:-$HOME/.config}/fish/completions/rigyn.fish"
```

For Zsh, add `$HOME/.zfunc` to `fpath` before `compinit` runs.

## Local HTTP and SSE service

```text
rigyn serve [--host HOST] [--port PORT] [--workspace DIR] [--session-dir DIR]
```

The default address is `127.0.0.1:4317`. `--host` accepts only `127.0.0.1`,
`localhost`, or `::1`. Set `RIGYN_SERVE_TOKEN` before startup. The command
does not accept the token as a flag. See
[HTTP and SSE service](serve.md) for endpoints, reconnect behavior, and
security limits.

## Export and model listing

`--list-models [TEXT]` lists connected provider models and exits. With `--mode json`, the model listing is one compact
JSON array followed by LF; it is metadata output, not a session event stream. `--export SESSION.jsonl [OUTPUT.html]`
creates a standalone HTML transcript. Add `--redact` to produce a sharing copy that still requires human review.

Exit status is zero after success. It is nonzero for invalid arguments, startup failures, or failed administrative
operations. In JSON and RPC modes, standard output contains only protocol data. Diagnostics go to standard error.
