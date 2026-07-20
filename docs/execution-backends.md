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

## Linux container adapter

The packaged [`linux-container.mjs`](../examples/execution-backends/linux-container.mjs) adapter accepts an absolute Docker- or Podman-compatible engine, an immutable image reference, and one host workspace. It creates one container per tool call with networking disabled, a read-only root filesystem, all Linux capabilities removed, no-new-privileges enabled, bounded processes/memory/CPU, and only the selected workspace mounted read-write. The host workspace cannot contain a comma because the engine's `--mount` grammar uses commas as separators.

Build an image whose `/app` directory contains the package's complete `dist/` tree. The adapter starts `node /app/dist/bin/tool-backend-worker.js` inside it. Pin the base image and resulting image by digest in production; this minimal Dockerfile only demonstrates the required layout:

```dockerfile
FROM node:24-bookworm-slim
WORKDIR /app
COPY dist ./dist
```

Create a dedicated existing launch directory such as `/var/empty/rigyn-backend`, then use absolute paths in `config.jsonc`:

```jsonc
{
  "executionBackend": {
    "id": "workspace-container",
    "argv": [
      "/usr/bin/node",
      "/opt/rigyn/examples/execution-backends/linux-container.mjs",
      "--engine", "/usr/bin/docker",
      "--image", "registry.example/rigyn-worker@sha256:REPLACE_WITH_DIGEST",
      "--host-workspace", "/home/alice/project"
    ],
    "cwd": "/var/empty/rigyn-backend",
    "workspace": "/workspace",
    "tools": {
      "read": "read", "grep": "read", "find": "read", "ls": "read",
      "write": "write", "edit": "write", "bash": "write"
    },
    "timeoutMs": 600000,
    "outputLimitBytes": 2097152
  }
}
```

The configured host workspace must be the same directory mounted by the adapter, while `executionBackend.workspace` must remain `/workspace`. Do not mount the container engine socket, credential directories, or broader host paths into the worker image.

## Fixed SSH adapter

The packaged [`remote-ssh.mjs`](../examples/execution-backends/remote-ssh.mjs) adapter pins the SSH executable, destination, identity, known-hosts database, remote Node executable, worker module, and workspace. It ignores user SSH configuration, disables interactive authentication and forwarding, and requires strict host-key verification. Remote paths accept only conservative absolute POSIX syntax because OpenSSH constructs the remote command through the login shell.

Install the complete matching Rigyn `dist/` tree on the remote machine and ensure the configured workspace exists. The SSH account needs only the filesystem and process authority intended for tool execution; it should not have provider credentials or privilege escalation. A complete host configuration is:

```jsonc
{
  "executionBackend": {
    "id": "workspace-ssh",
    "argv": [
      "/usr/bin/node",
      "/opt/rigyn/examples/execution-backends/remote-ssh.mjs",
      "--ssh", "/usr/bin/ssh",
      "--host", "rigyn-worker@build.example",
      "--identity", "/home/alice/.ssh/rigyn_worker",
      "--known-hosts", "/home/alice/.ssh/rigyn_known_hosts",
      "--remote-node", "/usr/bin/node",
      "--remote-worker", "/opt/rigyn/dist/bin/tool-backend-worker.js",
      "--remote-workspace", "/srv/rigyn/workspace"
    ],
    "cwd": "/var/empty/rigyn-backend",
    "workspace": "/srv/rigyn/workspace",
    "tools": {
      "read": "read", "grep": "read", "find": "read", "ls": "read",
      "write": "write", "edit": "write", "bash": "write"
    },
    "timeoutMs": 600000,
    "outputLimitBytes": 2097152
  }
}
```

Test the SSH account and known-hosts entry before enabling the backend; the adapter deliberately cannot prompt for a password or host-key decision. `executionBackend.workspace` and `--remote-workspace` must be identical.

## Relay termination guarantees

Both adapters validate a bounded request before starting their executor and retain at most 16 MiB of response plus 16 KiB of diagnostics. Cancellation, timeout-driven adapter termination, terminal interruption, or response overflow terminates the executor process tree and waits for it to close; a stubborn tree is killed after a bounded grace period. This behavior is covered without requiring Docker or SSH by the adapter conformance tests.
