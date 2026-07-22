# Raw editor UI extension

This trusted TUI-only package imports `Editor` from the stable `rigyn/tui` host module. `/example-editor-enable` replaces the primary editor; `/example-editor-disable` restores it. Generation shutdown and reload also restore the host editor.

```text
rigyn install ./packages/rigyn/examples/raw-editor-ui
```

Raw editor replacement is powerful. Preserve submission, cancellation, accessibility, paste, and keybinding behavior in production extensions.
