# External execution backends

Rigyn can route selected model tools through a fixed external process while retaining its normal schema validation, scheduling, output bounds, artifact policy, and redaction. This is a routing contract. Isolation exists only when the configured executable establishes a real container, VM, OS sandbox, or remote boundary.

For every invocation the harness starts the configured argv without a shell and without inheriting its environment, writes one JSON object to stdin, waits within the configured timeout/output bound, and accepts one JSON object from stdout.

Request:

```json
{"schemaVersion":1,"tool":"read","input":{"path":"README.md"},"workspace":"/workspace"}
```

Response:

```json
{"schemaVersion":1,"result":{"content":"...","isError":false,"status":"success"}}
```

Unknown fields, malformed JSON, a nonzero exit, signals, timeout, truncation, invalid tool results, and unavailable executables fail visibly. A claimed tool never falls back to local execution. Each configured tool also declares `read` or `write` scheduler authority; this must reflect the strongest effect it can perform.

The distribution includes `dist/bin/tool-backend-worker.js` as a reference protocol worker. Running that worker directly is not isolation. Place it behind the boundary command and mount or map the configured virtual workspace deliberately. Do not forward API keys, OAuth files, SSH agents, cloud metadata access, or the parent environment unless the deployment explicitly requires and protects them.

The external backend governs model tool calls and host-managed child runs that inherit it. Trusted runtime extensions are JavaScript loaded into the host process, and `api.exec` is explicit extension process authority; neither is silently presented as sandboxed.
