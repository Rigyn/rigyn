# External executor adapters

These adapters implement Rigyn's versioned external-tool protocol around a boundary you operate. They do not claim that launching another process creates isolation.

- `linux-container.mjs` starts one locked-down Linux container per claimed tool call. Build an image containing Rigyn's `dist/bin/tool-backend-worker.js`, then supply the absolute container-engine path, immutable image reference, and host workspace.
- `remote-ssh.mjs` sends one request to a fixed Node executable and worker module on a fixed SSH destination. It requires an explicit private key and known-hosts file and disables configuration loading, forwarding, and interactive authentication.

Both adapters inherit no host environment, accept one bounded JSON request on stdin, forward one bounded JSON response on stdout, and fail closed. Review the worker image or remote host, mount only the intended workspace, and keep provider credentials outside the execution boundary.

See [the external backend guide](../../docs/execution-backends.md) for complete configuration examples.
