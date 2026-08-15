# Session JSONL extension

This example reads session data through the read-only session manager supplied
to the command context.

```text
rigyn install ./packages/rigyn/examples/session-jsonl
```

`/example-session-summary` inspects the session header, entries, and active
leaf. It does not open or modify the JSONL file directly.

Session entries may contain user or model text. Treat them as private and
untrusted.
