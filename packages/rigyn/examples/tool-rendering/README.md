# Tool replacement and rendering

This example deliberately replaces the built-in `read` tool with a harmless,
bounded implementation. It also supplies tool-call and tool-result renderers
from `rigyn/tui`.

```text
rigyn install ./packages/rigyn/examples/tool-rendering
```

Use it only to test replacement precedence. Removing the package restores the
host tool.
