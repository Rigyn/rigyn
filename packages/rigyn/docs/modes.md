# Run modes

rigyn has interactive, print, and RPC command-line modes. `rigyn/modes` exposes reusable adapters with explicit, different ownership rules.

## Print mode

`runPrintMode()` receives an `AgentSessionRuntime`, runs the supplied messages against its active session, and disposes the runtime before returning an exit status. This ownership rule makes the CLI path deterministic: providers, tools, extensions, subprocesses, and session files have one shutdown owner.

```ts
import { createAgentSessionRuntime } from "./my-runtime-factory.js";
import { runPrintMode } from "rigyn/modes";

const runtime = await createAgentSessionRuntime();
const exitCode = await runPrintMode(runtime, {
  mode: "text",
  initialMessage: "Inspect the tests.",
  messages: ["Propose the smallest verified fix."],
});
process.exitCode = exitCode;
```

`mode: "text"` writes the final assistant text and returns `0` on success or `1` on a provider/runtime failure. `mode: "json"` writes the session header followed by public `AgentSessionEvent` records as newline-delimited JSON. `initialImages` attaches images only to `initialMessage`.

By default output is written to stdout with backpressure-aware ordering. Embedded hosts may supply `write(text)` to route complete text or JSON records to their own stream without replacing global process output.

`runPrintMode()` is a low-level owner API. Use `rigyn/embedding` when the caller must keep a session alive after one run, subscribe without transferring runtime ownership, or issue steering and follow-up messages.

## Interactive mode

Run `rigyn` without `--print` or `--mode rpc`. The CLI constructs the session owner, hydrates cached model state, loads resources, binds extension UI, then starts the terminal interface. Live model discovery begins in the background only after that interface is visible, so an offline or slow provider cannot hold the terminal before its first render. Session replacement recreates the session-local runtime. `/reload` instead keeps the active session, blocks input until completion, rebinds keybindings, extensions, skills, prompt templates, custom themes, and context files, and refreshes model state from cached catalogs without waiting for the network.

`InteractiveMode` is public for terminal hosts that already own an `AgentSessionRuntime` and terminal dependencies. It closes the terminal it creates or receives, but it does not dispose the supplied runtime. Most integrations should use the embedding facade or RPC instead of taking over terminal process state.

## RPC mode

Run:

```sh
rigyn --mode rpc
```

RPC reads direct command objects from standard input and emits responses, raw agent events, and extension UI requests on standard output. Records are separated only by LF. CRLF input is accepted by stripping one trailing CR; internal CR, U+2028, and U+2029 remain payload characters. A final unterminated record is processed at end-of-input.

`runRpcMode()` accepts an `AgentSessionRuntime`, serves the correlated RPC protocol, and owns that runtime's shutdown.

Use `RpcClient` from `rigyn/interfaces` to launch and control the subprocess from Node.js. See [RPC](rpc.md) for every command and response.
