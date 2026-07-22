# UI surfaces

`/example-ui-panel` mounts generation-owned status, header, and widget content. `/example-ui-overlay` opens a centered component that closes on Enter or Escape.

At session start, the extension also wraps the active autocomplete provider with three bounded snippet completions: `:todo`, `:note`, and `:review`. Unmatched input delegates to the previous provider, completion application preserves its editing behavior, and an aborted request returns no suggestions. The host removes the autocomplete layer and all mounts on reload or unload.
