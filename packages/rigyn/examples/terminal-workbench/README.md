# Terminal workbench

`/example-terminal-workbench THEME` demonstrates terminal input interception, editor text read/write/paste, modal editing, theme catalog lookup and selection, and tool-output expansion. The installed input handler consumes only `Ctrl+Alt+E`; every other byte is returned unchanged. Reloading or closing the generation removes the handler.

This package requires the interactive terminal UI.

```text
rigyn install ./packages/rigyn/examples/terminal-workbench
```
