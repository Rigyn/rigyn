# Session metadata

This example changes session metadata through host-owned APIs.

```text
rigyn install ./packages/rigyn/examples/session-metadata
```

`/example-session-metadata NAME [ENTRY_ID]` sets the session name, appends a
custom entry, optionally labels an existing entry, and renders the custom
entry. The extension never opens or rewrites the session file.
