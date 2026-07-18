# MCP stdio example

This package lazily starts one fixed local Node process as a real MCP stdio boundary. It performs `initialize`, sends `notifications/initialized`, verifies `tools/list`, calls `reverse_text`, bounds frames, stderr, and request time, propagates cancellation, and stops the child on extension reload or shutdown.

From this `mcp-stdio` directory:

```sh
rigyn install .
rigyn
```

Ask the model to call `mcp_reverse_text` with `Rigyn`. The model-visible JSON contains `{"text":"nygiR"}`. Remove the package with `rigyn remove mcp-stdio-example`.

The external process is justified by the MCP transport boundary. The runtime launches the package's fixed `server.mjs` with direct argv, never invokes a shell or another `rigyn`, inherits no environment variables, makes no network requests, and requires no credentials. Production MCP packages should make the server command explicit configuration, retain these bounds and cleanup rules, and validate the server's advertised capabilities before exposing tools. The package targets extension manifest schema 1 and the public APIs documented for the installed Rigyn build.
