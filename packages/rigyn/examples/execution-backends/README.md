# External executor adapters

These adapters connect rigyn's versioned external-tool protocol to a boundary
that you operate. Starting another process does not create isolation by
itself.

- `linux-container.mjs` starts one locked-down Linux container for each claimed
  tool call. Build an image that contains
  `dist/bin/tool-backend-worker.js`. Then supply the absolute container-engine
  path, immutable image reference, and host workspace.
- `remote-ssh.mjs` sends one request to a fixed Node executable and worker
  module on a fixed SSH destination. It requires an explicit private key and
  known-hosts file. It disables configuration loading, forwarding, and
  interactive authentication.

Neither adapter inherits the host environment. Each accepts one bounded JSON
request on standard input and returns one bounded JSON response on standard
output. Both fail closed.

Review the worker image or remote host. Mount only the intended workspace.
Keep provider credentials outside the execution boundary.

See [the external backend guide](../../docs/execution-backends.md) for complete configuration examples.
