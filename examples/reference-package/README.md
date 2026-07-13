# Reference package

This package is a compact, offline demonstration of Rigyn extensions. It contributes:

- a trusted runtime extension with a custom tool, structural tool renderer, slash command, active-tool control, and read-only tool/command catalog checks;
- a deterministic local provider and model that require no credentials or network;
- a typed CLI flag, argument completions, and an `Alt+R` shortcut;
- activation status, widget, title, and notification UI;
- durable custom session state and messages with structural renderers, plus session and event listeners with cleanup;
- a prompt template, a progressively loaded skill, and a custom theme.

Runtime extensions execute as trusted local code. Review a package before installing it.
The `reference_echo` tool also demonstrates the model-observation contract used by production tools: bounded domain output in `content`, plus top-level `status`, `summary`, and `nextActions` fields.

From this `reference-package` directory, install the example for the current user:

```sh
rigyn install .
```

Inspect the installed package and its declared resources:

```sh
rigyn list
rigyn --list-models reference-offline
```

Exercise the real agent loop entirely offline. `--tools` opts the custom tool into the minimal default tool set, while `--no-session` keeps the test conversation in memory and never creates a durable session:

```sh
rigyn "package check" \
  --provider reference-offline \
  --model reference-offline-v1 \
  --tools reference_echo \
  --no-session \
  --print
```

The final line should be:

```text
Reference offline model completed the tool round trip: reference:package check
```

For interactive use, start chat with the same provider and model. Then try `/reference-demo hello`; it activates `reference_echo` for the session before queuing the prompt. `Alt+R` inserts a reference prompt, and `--reference-prefix custom` changes the tool prefix. Also try `/reference-review an extension API`, `/skill:reference-package-guide verify this package`, and select `reference-ocean` in `/settings`. The session-start entry demonstrates conflict-safe durable extension state with `api.session.compareAndAppendState`, plus transcript rendering across restarts.

Remove the installed copy when finished:

```sh
rigyn remove reference-package
```
