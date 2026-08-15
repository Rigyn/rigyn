# UI surfaces

This example adds generation-owned content to the interactive TUI.

```text
rigyn install ./packages/rigyn/examples/ui-surfaces
```

- `/example-ui-panel` mounts status, header, and widget content.
- `/example-ui-overlay` opens a centered component that closes on Enter or
  Escape.

The status is compact text in the shared footer status row. The widget is a
separate content block above the editor; use a widget when placement and a
dedicated row matter.

At session start, the extension wraps the active autocomplete provider with
three bounded snippets: `:todo`, `:note`, and `:review`. Unmatched input goes
to the previous provider. Applying a completion keeps that provider's editing
behavior. An aborted request returns no suggestions.

The host removes the autocomplete layer and every mounted surface on refresh or
unload.
