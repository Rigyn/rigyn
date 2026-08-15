# Shell aliases and startup commands

The `bash` tool starts a Bash-compatible shell with `-c`. It does not start an interactive login shell, so it does not
load interactive startup files or aliases automatically.

For predictable behavior, put non-interactive aliases or functions in a dedicated file. Load it through the global
`shellCommandPrefix` setting:

```json
{
  "shellPath": "/bin/bash",
  "shellCommandPrefix": "shopt -s expand_aliases\n[ ! -f ~/.bash_aliases ] || source ~/.bash_aliases"
}
```

The prefix and requested command run in one shell invocation, with the prefix first. `shellPath` must be an absolute
executable path. On Windows, select an installed Git Bash executable when it is not already discoverable.

Shell functions and scripts are usually more reliable than aliases because they do not depend on alias-expansion
parsing. Keep the prefix small and deterministic. The prefix is executable operator configuration. It applies to
model-invoked `bash` commands and interactive shell commands. Do not place secrets or unreviewed remote startup logic
in it.

Edit the exact global settings file with:

```sh
rigyn config edit --scope user
```

See [Configuration](configuration.md) for precedence and [Environment variables](environment-variables.md#shell-tool-session-identity) for the session metadata exposed to commands.
