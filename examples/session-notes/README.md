# Session notes example

This package stores one append-only, extension-owned value in the current session. The command accepts inline text or opens the supported multiline editor, and the renderer reconstructs a structural transcript view after restart.

From this `session-notes` directory:

```sh
rigyn install .
rigyn
```

Run `/session-note remember to test cancellation`, then run `/session-note` to edit the latest value. Each save uses `api.session.compareAndAppendState` with the prior state event ID, retries visible conflicts, and appends a new revision without rewriting core events or losing an update from another harness process. Remove the package with `rigyn remove session-notes-example`.

Interactive editing requires the TUI. A headless host rejects the editor call explicitly instead of hanging, so automation should pass the note as the command argument. The package targets extension manifest schema 1 and Rigyn 0.1.x.
