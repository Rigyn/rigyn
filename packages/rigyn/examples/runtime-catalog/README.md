# Runtime catalog controls

This example shows bounded runtime discovery and explicit host selection.

```text
rigyn install ./packages/rigyn/examples/runtime-catalog
```

- `/example-runtime-catalog` reports active and available tools, registered
  commands, and the bounded command, prompt, and skill discovery view.
- `/example-runtime-select` activates the first available tool, confirms the
  current model through the host, and sends a user message as a follow-up.

These commands change the live harness. Use this package in a disposable
authoring workspace.
