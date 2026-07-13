# Embedding Rigyn

`rigyn/embedding` is the recommended in-process Node.js boundary. Its task-focused owners expose runs, cancellation, idle waiting, resource discovery, reload, and cleanup without returning credential stores, auth registries, provider registries, session stores, or the underlying service.

## Configured owner

```js
import { createEmbeddingHarness } from "rigyn/embedding";

await using harness = await createEmbeddingHarness({
  workspace: process.cwd(),
  extensions: true,
});

const resources = await harness.resourceCatalog();
const run = await harness.run({
  prompt: "Inspect this workspace and summarize the failing tests.",
  provider: "provider-id",
  model: "model-id",
});
console.log(run.results.at(-1)?.finalText);
```

The configured owner loads the same configuration, brokered credentials, providers, extensions, and durable sessions as the CLI, but keeps those authorities private. `reload()` prepares a candidate extension/resource generation before committing it; a preparation failure leaves the active generation intact.

The older root `createHarnessRuntime()` API remains supported for advanced hosts that genuinely need direct service, store, provider-registry, or auth-registry access. Prefer the narrower owner for applications because it has a smaller authority and compatibility surface.

## Deterministic in-memory preset

`createInMemoryHarness()` is intended for unit tests and small provider-neutral integrations:

```js
import { createInMemoryHarness } from "rigyn/embedding";
import { createScriptedProvider } from "rigyn/testing";

const provider = createScriptedProvider({
  id: "fixture",
  models: [{ id: "fixture-model" }],
  scripts: [{
    kind: "turn",
    content: [{ type: "text", text: "offline answer" }],
  }],
});

await using harness = await createInMemoryHarness({
  provider,
  model: "fixture-model",
});
const first = await harness.run({ prompt: "first turn" });
const resumed = await harness.run({
  threadId: first.threadId,
  prompt: "continue the same in-memory session",
});
```

This preset does not load configuration, credentials, extensions, a model-catalog cache, context files, or a filesystem session database. It uses one SQLite `:memory:` store with a fixed test clock and owner-local deterministic session IDs, disables built-in filesystem and shell tools, discovers no skills, and accepts only caller-supplied provider adapters and optional host tools. The exact default provider/model pair is verified during creation. Additional adapters require an explicit `{ selection: { provider, model } }` on a run.

Injected providers and tools remain owned by the caller and are never returned by the harness. Close the harness before disposing or reusing those dependencies. A provider that internally reads environment variables is also the caller's responsibility; the preset itself performs no credential lookup.

## Lifecycle and cancellation

Both owners follow the same bounded lifecycle:

1. `start()` reserves or creates a session and returns its `threadId`, result promise, and `cancel()` function.
2. A second active run on the same thread is rejected; separate threads may run concurrently.
3. `waitForIdle(signal?)` includes starts still being prepared and every owned active run. Its optional signal cancels only the wait.
4. `close()` rejects new starts, cancels owned runs, waits for settlement, then releases runtime resources. It is idempotent. `await using` calls the same close path.

The in-memory preset also combines every run signal with a 30-second default hard deadline and the owner close signal. Set `timeoutMs` at creation to another value from 1 ms through 10 minutes. Calling a run handle's `cancel()` affects only that thread. Calling `close()` affects every run owned by that harness.

The three focused runnable examples are:

- [`embedding-runtime.mjs`](../examples/embedding-runtime.mjs): configured provider and durable session lifecycle;
- [`embedding-in-memory.mjs`](../examples/embedding-in-memory.mjs): credential-free scripted run;
- [`embedding-cancellation.mjs`](../examples/embedding-cancellation.mjs): per-run cancellation.

## Node-only boundary

Every embedding entry point targets Node.js 24.15+ or 26+. There is intentionally no browser bundle: an embedded harness can own filesystem, process, provider, and credential authority even when the narrow facade does not reveal those objects. Browser clients should use the typed RPC host so that authority remains in a trusted local Node.js process. A browser-safe protocol/types package should be added only when a real client requires one.

Extensions loaded by the configured owner execute in the same trusted Node.js process. Package trust, credential brokering, workspace boundaries, and external execution backends still apply, but extensions are not a JavaScript sandbox. Embedding provides no interactive extension UI; use the typed RPC host when an external client needs negotiated dialogs or extension-command dispatch.
