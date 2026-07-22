# Project trust decision

Participates in project trust only when an interactive UI is available. It displays the exact workspace path and asks whether project-local executable resources should load. A positive decision applies only to the current invocation because the example does not set `remember`.

Trust extensions must come from an already trusted user or explicit source; a project cannot authorize its own extension code.

```text
rigyn install ./packages/rigyn/examples/project-trust
```
