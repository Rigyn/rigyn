# Raw editor UI extension

This trusted TUI-only package imports `Editor` from the stable `rigyn/tui`
host module.

```text
rigyn install ./packages/rigyn/examples/raw-editor-ui
```

- `/example-editor-enable` replaces the primary editor.
- `/example-editor-disable` restores the host editor.
- Generation shutdown and refresh also restore the host editor.

Raw editor replacement controls the complete composer. A production replacement must preserve
submission, cancellation, accessibility, paste, and keybinding behavior.
