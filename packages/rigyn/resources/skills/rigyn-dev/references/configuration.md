# Configure rigyn

Use the configuration that belongs to the active rigyn version. Read [Settings](../../../../docs/configuration.md), [Keybindings](../../../../docs/keybindings.md), [Environment variables](../../../../docs/environment-variables.md), and [Context files](../../../../docs/context-files.md) as needed. Use the packaged [`config-v1.json`](../../../schemas/config-v1.json) schema to discover every persistent key; [`config.example.json`](../../../config.example.json) is the portable, non-null global baseline.

## Choose the correct surface

| Need | Surface |
| --- | --- |
| Global persistent preference | `~/.rigyn/config.json` or `$RIGYN_HOME/config.json` |
| Trusted workspace override | `WORKSPACE/.rigyn/config.json` |
| Global user instructions | `~/.rigyn/AGENTS.md` or `$RIGYN_HOME/AGENTS.md` |
| Directory-specific instructions | `AGENTS.md` along the path to the working directory |
| Extension, skill, prompt, or theme content | Its own file or package, referenced by `config.json` when necessary |
| Provider credential | The rigyn credential backend, never `config.json` |
| Session history | The append-only session store, never `config.json` |

Do not create a second settings format or place executable resource bodies, model catalogs, credentials, or session content in `config.json`.

## Edit safely

1. Run `rigyn config path` to resolve user scope, or add `--scope project` for the trusted workspace scope.
2. Run `rigyn config validate`, or `rigyn config validate --scope project`, before editing so an existing invalid document is not mistaken for a regression. Add `--json` when another tool needs structured output.
3. Prefer `rigyn config edit`; it validates every known setting, preserves unknown fields, and commits only if the file did not change concurrently.
4. For a direct file edit, preserve unrelated keys and the existing JSON style. The generated global baseline exposes
   stable editable defaults; settings derived from the environment, provider, model, or a local path remain omitted
   until the user intentionally overrides them. Existing `null` values remain valid and mean inherit.
5. Keep project settings limited to intentional overrides. A newly created project file contains only `$schema`.
   Never move a global-only setting into project scope.
6. Keep credentials, secret headers, and credential commands out of the document.
7. Run the same `rigyn config validate` command after editing, then run `/refresh` in an idle interactive session. Confirm that it reports the refreshed resources and retains the current session.

An invalid candidate must leave the previous in-memory settings active. Do not repair a parse error by replacing the file with defaults or deleting unknown user keys.

## Refresh versus restart

`/refresh` is the normal path for settings, keybindings, extensions, skills, prompt templates, themes, and `AGENTS.md` files. It waits for pending writes, blocks new input, prepares a candidate generation, and keeps the previous generation usable if preparation fails.

Restart only for process-bound state: a Node or native-helper update, a launcher change, an environment value inherited at process start, or a runtime failure that makes `/refresh` unavailable. Preserve the current session when restarting.

## Personalization

The installed global `AGENTS.md` is deliberately empty. Do not populate it with this skill or with generic rules. Add user instructions only when the user supplies or requests them, and keep project instructions in the applicable project tree.

## Verify

- Run `rigyn config validate` for the edited scope and require a successful result.
- Confirm the target scope and project-trust state.
- Run `/refresh` and inspect the reported resources.
- Exercise the changed setting or keybinding.
- For a source change to configuration behavior, run the focused settings, CLI configuration, trust, refresh, and keybinding tests described in [Testing and release](testing-release.md).
