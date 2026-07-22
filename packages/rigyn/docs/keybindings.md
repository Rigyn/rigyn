# Keybindings

Rigyn resolves keyboard input by named action rather than by hard-coding keys in individual screens. Run `/hotkeys` to see the active high-level bindings in the current terminal. Terminal emulators and multiplexers may consume a chord before Rigyn receives it, so diagnose a missing binding outside the multiplexer first.

## Everyday bindings

| Action | Default |
| --- | --- |
| Submit input | `Enter` |
| Insert a newline | `Shift+Enter` or `Ctrl+J` |
| Interrupt the active operation | `Escape` |
| Clear the editor; press twice quickly while empty to exit | `Ctrl+C` |
| Exit on an empty editor | `Ctrl+D` |
| Queue a follow-up message | `Alt+Enter` |
| Open the external editor | `Ctrl+G` |
| Select a model | `Ctrl+L` or `Alt+M` |
| Cycle models | `Ctrl+P` / `Ctrl+Shift+P` |
| Cycle thinking level | `Shift+Tab` |
| Expand or collapse thinking | `Ctrl+T` |
| Expand or collapse completed tool output | `Ctrl+O` |
| Open the session picker | `Alt+S` |

The editor also recognizes familiar movement and deletion chords such as `Ctrl+A`, `Ctrl+E`, `Ctrl+B`, `Ctrl+F`, `Ctrl+W`, `Ctrl+U`, and `Ctrl+K`. Selection dialogs use arrows or Tab, Enter to confirm, and Escape to cancel.

## Key notation

Names are case-insensitive and normalize modifier order. Supported modifiers are `ctrl`, `shift`, `alt`, `super`, `hyper`, and `meta`; write combinations as `ctrl+shift+p`. Named keys include arrows, navigation keys, function keys, keypad keys, `enter`, `escape`, `space`, and `tab`. A single action can own more than one chord.

Embedding code can construct and pass the public `Keybindings` object to the terminal controller. Overrides replace the defaults for the named action; an empty array intentionally leaves an action unbound. Unknown action names, malformed chords, and conflicts within the same input scope should be treated as configuration errors.

## Persisted overrides

Put application and editor overrides in `<agent-directory>/keybindings.json`. The default path is `~/.rigyn/agent/keybindings.json`; when `RIGYN_CODING_AGENT_DIR` is set, the file lives directly in that directory. The file is a JSON object whose keys are stable action IDs and whose values are one chord or an array of chords. `KEYBINDING_ACTIONS` and `DEFAULT_KEYBINDINGS` from `rigyn/tui` expose the complete accepted action set and its defaults; `/hotkeys` shows the common high-level bindings active in the current terminal. For example:

```json
{
  "app.model.select": "alt+k",
  "tui.editor.cursorWordLeft": ["alt+left", "alt+b"]
}
```

Both interactive entry points load this file. `/reload` validates and applies disk changes to host actions, built-in editor components, and direct extension UI as one live keymap. A malformed or oversized file fails the reload instead of silently falling back to unrelated defaults.

Runtime extensions register standalone shortcuts with `registerShortcut`. Host actions retain precedence, and conflicting extension shortcuts are not activated. Use a chord that is both visible in the package README and unlikely to be intercepted by the target terminal.

## Terminal diagnosis

If a key does not work:

1. Run `/hotkeys` and confirm the expected action.
2. Test the chord in the same terminal without tmux, screen, or an IDE keybinding layer.
3. Check whether the terminal sends a distinct sequence for modified Enter, Tab, or Escape.
4. Prefer a simpler chord when a remote shell cannot preserve enhanced keyboard sequences.

See [Terminal setup](terminal-setup.md) for tmux and platform recipes.
