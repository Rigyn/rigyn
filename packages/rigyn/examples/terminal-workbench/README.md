# Terminal workbench

This package requires the interactive terminal UI.

```text
rigyn install ./packages/rigyn/examples/terminal-workbench
```

`/example-terminal-workbench THEME` shows:

- terminal input interception;
- editor read, write, and paste operations;
- modal editing;
- theme lookup and selection;
- tool-output expansion.

The input handler consumes only `Ctrl+Alt+E`. It returns every other byte
unchanged. Refreshing or closing the runtime generation removes the handler.
