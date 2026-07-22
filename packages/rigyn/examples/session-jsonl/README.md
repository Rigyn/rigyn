# Session JSONL extension

`/example-session-summary` reads the current session through the read-only session manager supplied to the command context. It demonstrates session header, entry, and leaf inspection without opening or mutating the JSONL file directly.

```text
rigyn install ./packages/rigyn/examples/session-jsonl
```

Session entries may contain user or model text. Treat them as private and untrusted.
