# Keybindings

rigyn maps keyboard input to named actions instead of hard-coding keys in each screen. Run `/hotkeys` to see the
active high-level bindings. A terminal emulator or multiplexer may consume a chord before rigyn receives it. Test a
missing binding outside the multiplexer first.

## Message delivery, cancellation, and expansion

Enter starts a turn while idle. During an active run, Enter submits the draft as steering for the current run.
`Alt+Enter` submits a follow-up while active and inserts a newline while idle. Steering and follow-up queues each use
the configured `one-at-a-time` or `all` delivery mode.

`Alt+Up` removes all queued steering and follow-up messages and restores them, with their images and original order, to the editor. The queue remains visible above the composer until it is restored. `/follow MESSAGE` is the command form of follow-up delivery.

Escape is routed in this order:

1. A focused bounded component, or a raw component with `handleInput`, receives it.
2. A pending dialog or picker is cancelled.
3. The host interrupt handler may consume it.
4. An active run restores all queued messages to the editor, then cancels.
5. While idle with an empty editor, two presses within 500 ms run the configured `doubleEscapeAction`, which defaults to `tree`; `fork` and `none` are also supported.

`Ctrl+C` cancels a picker. Otherwise it clears the draft and attachments. Press it twice within 500 ms while the
editor is empty to exit. `Ctrl+D` deletes forward in a nonempty editor and exits when the editor is empty. Completed
built-in tool rows start collapsed. `Ctrl+O` expands bounded retained tool output and bounded startup, skill, extension,
branch-summary, and compaction detail. Press it again to collapse them back to compact receipts.
While collapsed, active Write shows its newest source rows and active Edit stays header-only. Expanding shows Write's
bounded retained head and tail, and shows Edit only after a complete old/new pair has been parsed; it never invents a
partial diff. The same state controls future, resumed, completed, and user-shell tool rendering. The terminal retains
at most 64 KiB of text for each tool result and renders at most 120 expanded rows per retained detail section.

## Complete action catalog

The following 82 IDs are the complete `KEYBINDING_ACTIONS` catalog. An unbound action is supported but has no default chord. Platform-specific defaults are called out explicitly.

### Editor and input

| Action ID | Meaning | Default |
| --- | --- | --- |
| `tui.editor.cursorUp` | Move up a visual row; at a single-line boundary, recall older history | `up` |
| `tui.editor.cursorDown` | Move down a visual row; at a single-line boundary, recall newer history | `down` |
| `tui.editor.cursorLeft` | Move left one grapheme | `left`, `ctrl+b` |
| `tui.editor.cursorRight` | Move right one grapheme | `right`, `ctrl+f` |
| `tui.editor.cursorWordLeft` | Move left by word | `alt+left`, `ctrl+left`, `alt+b` |
| `tui.editor.cursorWordRight` | Move right by word | `alt+right`, `ctrl+right`, `alt+f` |
| `tui.editor.cursorLineStart` | Move to logical line start | `home`, `ctrl+a` |
| `tui.editor.cursorLineEnd` | Move to logical line end | `end`, `ctrl+e` |
| `tui.editor.jumpForward` | Arm a forward jump to the next typed character | `ctrl+]` |
| `tui.editor.jumpBackward` | Arm a backward jump to the next typed character | `ctrl+alt+]` |
| `tui.editor.pageUp` | Move a multiline editor page up, otherwise scroll transcript up | `pageup` |
| `tui.editor.pageDown` | Move a multiline editor page down, otherwise scroll transcript down | `pagedown` |
| `tui.editor.deleteCharBackward` | Delete one grapheme backward | `backspace` |
| `tui.editor.deleteCharForward` | Delete one grapheme forward | `delete` |
| `tui.editor.deleteWordBackward` | Kill the previous word | `ctrl+w`, `alt+backspace` |
| `tui.editor.deleteWordForward` | Kill the next word | `alt+d`, `alt+delete` |
| `tui.editor.deleteToLineStart` | Kill to logical line start | `ctrl+u` |
| `tui.editor.deleteToLineEnd` | Kill to logical line end | `ctrl+k` |
| `tui.editor.yank` | Insert the newest kill-ring entry | `ctrl+y` |
| `tui.editor.yankPop` | Replace the last yank with the next kill-ring entry | `alt+y` |
| `tui.editor.undo` | Undo one editor transaction | `ctrl+z` |
| `tui.editor.redo` | Redo one editor transaction | `ctrl+shift+z` |
| `tui.input.newLine` | Insert a newline in the multiline editor | `shift+enter`, `ctrl+j` |
| `tui.input.submit` | Submit the current editor value | `enter` |
| `tui.input.tab` | Open/apply autocomplete, then command or file completion | `tab` |
| `tui.input.copy` | Reserve the terminal copy-selection action for public editor components | `ctrl+c` |

### Selection and picker navigation

| Action ID | Meaning | Default |
| --- | --- | --- |
| `tui.select.up` | Move selection up | `up`, `shift+tab` |
| `tui.select.down` | Move selection down | `down`, `tab` |
| `tui.select.pageUp` | Move selection up by a page | `pageup` |
| `tui.select.pageDown` | Move selection down by a page; at the session boundary, request more rows | `pagedown` |
| `tui.select.confirm` | Confirm the selected value | `enter` |
| `tui.select.cancel` | Cancel the current picker, dialog, or completion list | `escape`, `ctrl+c` |

Picker text fields also accept printable text, paste, Backspace, Delete, and `Ctrl+U`. Left and Right change settings
values. In the session tree, they page by ten rows. The model picker uses Tab to switch between scoped and complete
catalogs when a scope exists.

### Transcript navigation

These actions operate on the retained transcript. They do not replace editor navigation.

| Action ID | Meaning | Default |
| --- | --- | --- |
| `tui.transcript.pageUp` | Scroll toward earlier transcript rows | `pageup` |
| `tui.transcript.pageDown` | Scroll toward later transcript rows | `pagedown` |
| `tui.transcript.previousPrompt` | Jump to the preceding marked user or final assistant message | `ctrl+shift+up` |
| `tui.transcript.nextPrompt` | Jump to the following marked user or final assistant message | `ctrl+shift+down` |
| `tui.transcript.top` | Go to the earliest retained transcript row | `ctrl+home` |
| `tui.transcript.bottom` | Return to the newest transcript row and follow new output | `ctrl+end` |

### Application, model, message, and session entry points

| Action ID | Meaning | Default |
| --- | --- | --- |
| `app.interrupt` | Cancel the active run or active cancellable operation | `escape` |
| `app.clear` | Clear the draft; press twice quickly while empty to exit | `ctrl+c` |
| `app.exit` | Exit; the default `Ctrl+D` deletes forward while the draft is nonempty | `ctrl+d` |
| `app.suspend` | Suspend the process after restoring terminal state | Unbound |
| `app.editor.external` | Edit the draft with the configured external editor | `ctrl+g` |
| `app.model.select` | Open the model picker | `ctrl+l` |
| `app.model.cycleForward` | Select the next model in the active cycle scope | `ctrl+p` |
| `app.model.cycleBackward` | Select the previous model in the active cycle scope | `ctrl+shift+p` |
| `app.thinking.cycle` | Cycle through thinking levels supported by the selected model | `shift+tab` |
| `app.thinking.toggle` | Expand or collapse live and completed reasoning blocks | `ctrl+t` |
| `app.tools.expand` | Expand or collapse tool output and startup details | `ctrl+o` |
| `app.message.followUp` | Queue a follow-up while active; insert a newline while idle | `alt+enter` |
| `app.message.dequeue` | Restore all queued messages to the editor | `alt+up` |
| `app.message.copy` | Copy the latest assistant text; in the tree, copy the selected entry | `ctrl+x` |
| `app.clipboard.pasteImage` | Attach an image from the system clipboard | POSIX: `ctrl+v`; Windows: `alt+v` |
| `app.session.resume` | Open the session picker | Unbound |
| `app.session.new` | Run `/new` | Unbound |
| `app.session.tree` | Run `/tree` | Unbound |
| `app.session.fork` | Run `/fork` | Unbound |

### Session picker

These actions are scoped to the session picker and may reuse chords owned by the editor.

| Action ID | Meaning | Default |
| --- | --- | --- |
| `app.session.toggleScope` | Toggle current-workspace and all-workspaces search | `ctrl+a` |
| `app.session.togglePath` | Show or hide session paths | `ctrl+p` |
| `app.session.toggleSort` | Cycle threaded, recent, and relevance ordering | `ctrl+s` |
| `app.session.toggleNamedFilter` | Toggle named-only sessions | `ctrl+n` |
| `app.session.delete` | Open deletion confirmation for the selected non-active session | `ctrl+d` |
| `app.session.deleteNoninvasive` | Delete the selected session when the query is empty; otherwise delete the previous query word | `ctrl+backspace` |

### Model cycle scope editor

| Action ID | Meaning | Default |
| --- | --- | --- |
| `app.models.reorderUp` | Move an enabled model earlier in the cycle | `alt+up` |
| `app.models.reorderDown` | Move an enabled model later in the cycle | `alt+down` |
| `app.models.save` | Save the current cycle scope and order | `ctrl+s` |
| `app.models.enableAll` | Include every current and future model | `ctrl+a` |
| `app.models.clearAll` | Clear the explicit cycle scope | `ctrl+x` |
| `app.models.toggleProvider` | Enable or clear every model from the selected row's provider | `ctrl+p` |

Enter or Space toggles the selected model. Reordering requires an explicit enabled set; the special all-models selection must first be materialized or narrowed.

### Session tree

| Action ID | Meaning | Default |
| --- | --- | --- |
| `app.tree.editLabel` | Edit or remove the selected entry label | `shift+l` |
| `app.tree.toggleLabelTimestamp` | Show or hide label timestamps | `shift+t` |
| `app.tree.filter.default` | Use the default tree filter | `ctrl+d` |
| `app.tree.filter.noTools` | Hide tool entries | `ctrl+t` |
| `app.tree.filter.userOnly` | Show user entries only | `ctrl+u` |
| `app.tree.filter.labeledOnly` | Show labeled entries only | `ctrl+l` |
| `app.tree.filter.all` | Show all entries | `ctrl+a` |
| `app.tree.filter.cycleForward` | Select the next tree filter | `ctrl+o` |
| `app.tree.filter.cycleBackward` | Select the previous tree filter | `ctrl+shift+o` |
| `app.tree.foldOrUp` | Fold visible children, otherwise jump to the previous branch endpoint | `ctrl+left`, `alt+left` |
| `app.tree.unfoldOrDown` | Unfold the selected entry, otherwise jump to the next branch endpoint | `ctrl+right`, `alt+right` |
| `app.tree.togglePath` | Toggle active-path-only and all-branches views | `ctrl+p` |

## Key notation

Names are case-insensitive, and rigyn normalizes modifier order. Supported modifiers are `ctrl`, `shift`, `alt`,
`super`, `hyper`, and `meta`. Write combinations as `ctrl+shift+p`. Named keys include arrows, navigation keys,
function keys, keypad keys, `enter`, `escape`, `space`, and `tab`. One action can own more than one chord.

Embedding code can pass a public `Keybindings` object to the terminal controller. An override replaces the default for
that action. An empty array leaves it unbound. Unknown action names and malformed chords are rejected.
`Keybindings.conflicts()` reports duplicate chords within the editor, selection, session, model-scope, and tree
scopes. Avoid these conflicts because precedence depends on the active screen. The shared `Ctrl+C` ownership of
`tui.input.copy` and `app.clear` is intentional.

## Persisted overrides

Edit the `keybindings` object in `<rigyn-home>/config.json`. The default path is
`~/.rigyn/config.json`. If `RIGYN_HOME` is set, the file lives in that directory.

A fresh global configuration contains an empty `keybindings` object, which keeps every platform default. A newly
created project override omits it for the same result. Add only the actions you want to change, with one chord or an
array of chords. Use an empty array to unbind the action. `KEYBINDING_ACTIONS` and `DEFAULT_KEYBINDINGS` from
`rigyn/tui` expose the accepted actions and defaults. `/hotkeys` shows the common active bindings. For example:

```json
{
  "keybindings": {
    "app.model.select": "alt+k",
    "tui.editor.cursorWordLeft": ["alt+left", "alt+b"]
  }
}
```

Both interactive entry points load this object. `/refresh` validates and applies changes to host actions, built-in
editor components, and direct extension UI as one live keymap.

Runtime extensions register standalone shortcuts with `registerShortcut`. Host actions keep precedence. Conflicting
extension shortcuts are not activated. Document the chord in the package README and choose one the target terminal is
unlikely to intercept.

## Terminal diagnosis

If a key does not work:

1. Run `/hotkeys` and confirm the expected action.
2. Test the chord in the same terminal without tmux, screen, or an IDE keybinding layer.
3. Check whether the terminal sends a distinct sequence for modified Enter, Tab, or Escape.
4. Prefer a simpler chord when a remote shell cannot preserve enhanced keyboard sequences.

See [Terminal setup](terminal-setup.md) for tmux and platform recipes.
