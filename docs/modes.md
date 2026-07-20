# In-process modes

`rigyn/modes` supplies ready-made print, terminal, and RPC adapters for applications that already own a Rigyn runtime. A mode borrows that owner: it never loads configuration, opens another session database, creates a second extension generation, or closes the owner.

## Print mode

`runPrintMode()` accepts an `EmbeddingHarness`, a `RigynSdk`, or an existing session handle. It creates or opens one session, runs every prompt on that same branch, and returns the structured results. Text mode writes each final answer; JSON mode writes one normalized `EventEnvelope` per line.

```js
import { createRigynSdk } from "rigyn/sdk";
import { runPrintMode } from "rigyn/modes";

await using rigyn = await createRigynSdk({
  workspace: process.cwd(),
  defaultSelection: { provider: "YOUR_PROVIDER", model: "YOUR_MODEL" },
});

const result = await runPrintMode(rigyn, {
  prompts: ["Inspect the tests.", "Propose the smallest verified fix."],
  format: "text",
});
console.error(`session: ${result.threadId}`);
```

Pass `session: { threadId, branch? }` to continue a durable session. Supplying an existing session handle instead of an owner also works; a separate session target is then rejected so ownership cannot be ambiguous. A custom async `write` function can route output without replacing `process.stdout`.

## Interactive mode

`runInteractiveMode()` owns a `TuiController` and provides the core terminal conversation loop: submit, streamed event rendering, steering, `/follow`, cancellation, image submission, and `/exit`. `InteractiveMode` is also exported when a host already owns a session and needs explicit `run()` or `close()` control.

```js
import { createEmbeddingHarness } from "rigyn/embedding";
import { runInteractiveMode } from "rigyn/modes";

await using rigyn = await createEmbeddingHarness({ workspace: process.cwd() });
await runInteractiveMode(rigyn, {
  session: { name: "embedded-terminal" },
  run: { selection: { provider: "YOUR_PROVIDER", model: "YOUR_MODEL" } },
});
```

The narrow adapter intentionally has no provider-login policy, durable-history repaint, resource router, or runtime-extension UI authority. Applications that already own a `HarnessRuntime` can opt into those bindings without starting another runtime:

```js
import { createHarnessRuntime } from "rigyn";
import { runOwnedInteractiveMode } from "rigyn/modes";

await using runtime = await createHarnessRuntime({ workspace: process.cwd() });
await runOwnedInteractiveMode(runtime, {
  session: { name: "owned-terminal" },
  historyEvents: 4096,
});
```

`runOwnedInteractiveMode()` takes an exclusive in-process lease and leaves the runtime open. It repaints a bounded recent event tail on startup and session replacement; binds the active runtime generation's tool, session, and editor renderers; exposes extension dialogs, advanced/native UI, shortcuts, completions, and editor middleware; dispatches session lifecycle events; and rebinds all of those contracts after transactional reload. It routes registered runtime commands, extension templates, prompts, portable skills, and input middleware before a model run. Provider authentication is delegated to the existing credential broker and interactive authorization flow, so extensions never receive credentials or private stores.

The built-in owned-mode router advertises only commands it actually handles: `/model`, `/resume`, `/new`, `/name`, `/compact`, `/reload`, `/login`, `/logout`, `/session`, `/resources`, `/clone`, `/copy`, `/hotkeys`, and `/quit`. Model items carry catalog-declared reasoning levels, and session picker actions support bounded search/pagination, rename, delete, and resume. Unknown slash commands fail visibly instead of reaching the model.

Some commands are application policy rather than runtime mechanics. `delegatedCommands` can bind `settings`, `llama`, `scoped-models`, `export`, `share`, `changelog`, `import`, `context`, `fork`, `tree`, and `trust`; only supplied handlers appear in the command picker. This prevents an embedding library from silently choosing file destinations, changing project trust, or inventing branch-selection and preference policy. `delegatedActions` similarly supplies platform image paste, durable queue dequeue/discard, and provider/file picker actions. Missing action authority produces a visible warning. The callbacks receive the bounded interactive context—terminal, current session, session replacement/submission, cancellation, and close—not the credential broker, service, or session store.

`historyEvents` and `historyBytes` may reduce or raise repaint bounds within the store's compiled guardrails. Repaint never becomes the canonical context reconstruction path; the complete durable session remains in the owner even when older presentation events are omitted.

Closing either interactive mode aborts its active run and restores the terminal. It does not close the session owner or runtime. The host can reload, reuse, or close that owner afterward.

## In-process RPC mode

RPC intentionally exposes broader session, model, and authentication operations, so `RpcMode` borrows the advanced `HarnessRuntime` rather than the narrow embedding facade. Requests use the existing exhaustive `RpcMethodMap`; there is no JSON serialization or subprocess between the caller and dispatcher.

```js
import { createHarnessRuntime } from "rigyn";
import { runRpcMode } from "rigyn/modes";

await using runtime = await createHarnessRuntime({ workspace: process.cwd() });
const health = await runRpcMode(runtime, async (rpc) => {
  const stop = rpc.subscribe(({ method, params }) => {
    if (method === "run.event") console.log(params);
  });
  try {
    return await rpc.request("health");
  } finally {
    stop();
  }
});
```

`createRpcMode()` or `new RpcMode()` returns a longer-lived peer. `close()` disconnects that peer and drains dispatcher-owned work without closing the runtime. `runRpcMode()` is the scoped form and always closes the peer after its callback settles.

`RpcMode` requires the owner returned by `createHarnessRuntime()`. The public object still does not expose the extension host or network transport; an internal, exclusive lease binds those authorities directly to the standard dispatcher. Runtime-extension commands, negotiated UI, input and shell hooks, session lifecycle events, and remote credential revocation therefore use the same contracts as the CLI RPC host without becoming public object fields. A second in-process RPC mode for the same runtime is rejected until the first closes, preventing competing peers from replacing the single extension UI/shutdown binding.

## Runtime boundary

These modes have the same Node-only boundary as the rest of Rigyn. Node.js 22 is not supported because its bundled SQLite is below Rigyn's SQLite 3.51.3 durability floor. Bun is not supported because it does not provide the required `node:sqlite` API. The declared Node.js 24.15+/26+ engine range therefore remains intentional rather than an untested packaging restriction.
