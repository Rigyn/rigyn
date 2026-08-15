# Project trust decision

This example participates in project trust only when an interactive UI is
available. It displays the exact workspace path and asks whether rigyn should
load executable project resources.

```text
rigyn install ./packages/rigyn/examples/project-trust
```

An approval lasts only for the current invocation because the example does not
set `remember`.

A trust extension must come from an already trusted user or explicit source.
A project cannot authorize its own extension code.
