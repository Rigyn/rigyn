# Embedding rigyn

`rigyn/embedding` exposes one active session through a narrow in-process Node.js facade. It supports prompts, streaming subscriptions, cancellation, steering, follow-ups, model selection, refresh, and cleanup. It never returns credential stores or authentication material.

## Configured harness

`createEmbeddingHarness()` loads the same settings, brokered credentials, providers, trusted extensions, resources, session policy, and seven default built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`) as the CLI:

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

The configured harness owns one session at a time. It uses the same session identity, context, and JSONL persistence as the terminal application. Extension callbacks receive the first-class headless `sdk` mode, so they can distinguish embedding ownership from print and JSON without assuming an interactive UI.

Pass `toolAuthorizationHandler` to either `createEmbeddingHarness()` or `createInMemoryHarness()` when the embedding host must approve model-requested tool effects. The handler uses the exact one-shot contract described in [SDK composition](sdk.md#host-owned-tool-authorization), remains installed when a configured harness refreshes its session, and defaults to allow when omitted.

Pass `observabilitySink` to either factory when the host needs the bounded,
metadata-only runtime records described in [Local diagnostics](diagnostics.md).
Embedding creates no CLI log destination when the option is omitted. The sink
remains caller-owned; closing the harness does not close it.

`resolveModel()` uses provider catalog metadata. Pass an explicit `api` only for a caller-supplied model whose catalog cannot declare its wire protocol.

`refresh()` prepares a candidate extension/resource generation before committing it. The `harness.session` object remains valid when refresh replaces the underlying agent session; its accessors and methods resolve the current session at call time.

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

This preset:

- does not load credentials, configuration, extensions, context files, skills, or filesystem sessions;
- uses in-memory session and settings managers;
- activates the same seven built-in tools by default;
- performs no ambient credential lookup.

Pass `enabledTools` as an exact allowlist. `excludeTools` applies afterward. Use `noTools: "all" | "builtin"` to suppress tools. Add caller-owned `HarnessTool` or public `ToolDefinition` values through `customTools`; `defineTool()` and tool-factory results are accepted directly. The older `tools` spelling remains a compatibility alias. Supply more caller-owned providers through `additionalProviders`.

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

For embedding and direct SDK sessions, an abort reason is diagnostic text, not a machine correlation ID. Before V4 and event publication, rigyn trims it, redacts registered secrets, and bounds it to 4 KiB of UTF-8.

Starting a second overlapping run on the same session is rejected. The configured runtime can still be hosted in multiple processes or independent harness instances when true concurrent sessions are required.

An aborted or crashed run can remain suspended when a dispatched tool's
external outcome is uncertain. After active work settles, inspect
`session.suspendedRun`. Call `recoverInterruptedRun()` without resolutions
first so only the tool's stored repeatable or reconciliation policy can run.
If the result lists blocked effects, the host must verify each outcome and
submit an explicit decision:

```ts
await harness.session.waitForIdle();
const suspended = harness.session.suspendedRun;
if (suspended !== undefined) {
  const safe = await harness.session.recoverInterruptedRun();
  if (!safe.recovered) {
    await harness.session.recoverInterruptedRun({
      resolutions: [{
        effectId: "EFFECT_ID_VERIFIED_BY_HOST",
        outcome: "abandoned",
      }],
    });
  }
}
```

The example's `abandoned` choice is appropriate only when the embedding host
has made that decision. It prevents replay; it does not prove that an external
action stopped or was undone. `abort()`, `run()`, refresh, and session reopen
never choose an outcome automatically. A host that verified success or failure
can instead supply a matching bounded tool result.

## Session controls

The session facade exposes:

| Area | Members |
| --- | --- |
| State | `id`, `cwd`, `model`, `isIdle`, `suspendedRun` |
| Model | `resolveModel()`, `setModel()`, `setThinkingLevel()` |
| Metadata | `setName()` |
| Events | `subscribe()` for canonical event envelopes |
| Runs | `run()`, `start()`, `steer()`, `followUp()`, `abort()`, `waitForIdle()`, `recoverInterruptedRun()` |

It intentionally does not expose raw credentials, provider registry mutation, or the writable JSONL store. Use the advanced root `createHarnessRuntime()` only when a host explicitly needs lower-level runtime ownership.

## Lifecycle

`close()` rejects further use, cancels owned session work, and releases runtime resources. It is idempotent. `await using` invokes the same path through `Symbol.asyncDispose`.

Injected providers and tools remain caller-owned; close the harness before disposing them. Reopen a persisted configured session through a new harness after process restart rather than retaining an object across owner lifetimes.

The runnable examples are:

- [`embedding-runtime.mjs`](../examples/embedding-runtime.mjs) — configured provider and durable session;
- [`embedding-in-memory.mjs`](../examples/embedding-in-memory.mjs) — credential-free scripted run;
- [`embedding-cancellation.mjs`](../examples/embedding-cancellation.mjs) — per-run cancellation.

## Node-only boundary

Every embedding entry point requires Node.js 26.7.0 or newer. There is no browser bundle. An embedded runtime can own filesystem, process, provider, credential, and extension authority even though the facade does not reveal those objects.

Browser clients should use the typed RPC interface or the authenticated
loopback service through a reviewed same-origin bridge. Both choices keep
authority in a trusted local process.

Extensions loaded by the configured harness execute in the same trusted Node.js process. Package trust, credential brokering, workspace boundaries, and external execution backends still apply, but extensions are not a JavaScript sandbox.
