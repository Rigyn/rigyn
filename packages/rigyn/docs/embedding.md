# Embedding Rigyn

`rigyn/embedding` exposes one active Rigyn session through a narrow in-process Node.js facade. It supports prompting, streaming event subscriptions, cancellation, steering, follow-ups, model selection, reload, and cleanup without returning credential stores or authentication material.

## Configured harness

`createEmbeddingHarness()` loads the same settings, brokered credentials, providers, tools, trusted extensions, resources, and session policy as the CLI:

```ts
import { createEmbeddingHarness } from "rigyn/embedding";

await using harness = await createEmbeddingHarness({
  workspace: process.cwd(),
  extensions: true,
});

const model = await harness.session.resolveModel("MODEL_ID", {
  provider: "PROVIDER_ID",
});
await harness.session.setModel(model);

const unsubscribe = harness.session.subscribe(({ event }) => {
  if (event.type === "text_delta") process.stdout.write(event.text);
});

try {
  const first = await harness.session.run({
    prompt: "Inspect this workspace and summarize the failing tests.",
  });
  console.log(first.results.at(-1)?.finalText);

  // A second run continues the same active session.
  await harness.session.run({ prompt: "Propose the smallest verified fix." });
} finally {
  unsubscribe();
}
```

The configured harness owns one session at a time. Session identity, context, and JSONL persistence are the same as in the terminal application. `resolveModel()` uses provider catalog metadata; pass an explicit `api` only for a caller-supplied model whose catalog cannot declare its wire protocol.

`reload()` prepares a candidate extension/resource generation before committing it. The `harness.session` object remains valid when reload replaces the underlying agent session; its accessors and methods resolve the current session at call time.

## Deterministic in-memory harness

`createInMemoryHarness()` is intended for tests and small provider-neutral integrations. The caller supplies a provider and the exact wire protocol:

```ts
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
  api: "openai-chat-completions",
});

const first = await harness.session.run({ prompt: "first turn" });
const second = await harness.session.run({ prompt: "continue this session" });
console.log(first.results.at(-1)?.finalText, second.results.at(-1)?.finalText);
```

This preset does not load credentials, configuration, extensions, context files, skills, or filesystem sessions. It uses an in-memory session manager, has no built-in coding tools unless `tools` are supplied, and performs no ambient credential lookup. Additional caller-owned providers may be supplied through `additionalProviders`.

## Active-run controls

`run()` waits for completion. `start()` returns immediately with the session ID, result promise, and controls for aborting the run or cancelling an active retry delay:

```ts
const handle = harness.session.start({ prompt: "Run a long analysis." });

setTimeout(() => handle.abort("host timeout"), 5_000);
const result = await handle.result;
```

While a run is active:

- `steer(text, images?)` returns a promise after inserting user guidance according to the steering queue mode;
- `followUp(text, images?)` returns a promise after queueing a later user turn;
- `abort(reason?)` cancels the active run;
- `waitForIdle()` settles only after active provider and tool work finishes.

Starting a second overlapping run on the same session is rejected. The configured runtime can still be hosted in multiple processes or independent harness instances when true concurrent sessions are required.

## Session controls

The session facade exposes:

- `id`, `cwd`, `model`, and `isIdle`;
- `resolveModel()` and `setModel()`;
- `setThinkingLevel()` and `setName()`;
- `subscribe()` for canonical event envelopes;
- `run()`, `start()`, `steer()`, `followUp()`, `abort()`, and `waitForIdle()`.

It intentionally does not expose raw credentials, provider registry mutation, or the writable JSONL store. Use the advanced root `createHarnessRuntime()` only when a host explicitly needs lower-level runtime ownership.

## Lifecycle

`close()` rejects further use, cancels owned work through the underlying session, and releases runtime resources. It is safe to call more than once. `await using` invokes the same close path through `Symbol.asyncDispose`.

Injected providers and tools remain caller-owned; close the harness before disposing them. Reopen a persisted configured session through a new harness after process restart rather than retaining an object across owner lifetimes.

The runnable examples are:

- [`embedding-runtime.mjs`](../examples/embedding-runtime.mjs) — configured provider and durable session;
- [`embedding-in-memory.mjs`](../examples/embedding-in-memory.mjs) — credential-free scripted run;
- [`embedding-cancellation.mjs`](../examples/embedding-cancellation.mjs) — per-run cancellation.

## Node-only boundary

Every embedding entry point targets Node.js 24.15+ or 26+. There is no browser bundle: an embedded runtime can own filesystem, process, provider, credential, and extension authority even though the facade does not reveal those objects. Browser clients should use the typed RPC interface so authority remains in a trusted local process.

Extensions loaded by the configured harness execute in the same trusted Node.js process. Package trust, credential brokering, workspace boundaries, and external execution backends still apply, but extensions are not a JavaScript sandbox.
