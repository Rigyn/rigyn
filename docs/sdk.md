# SDK composition

`rigyn/sdk` is the application-level composition boundary for a persistent in-process Rigyn owner. It accepts configured extension entries and packages, caller-owned provider adapters and tools, skill/prompt/theme resources, context defaults, and lifecycle-aware composition factories. It delegates runs, sessions, persistence, concurrency, reload, and cancellation to the normal Rigyn runtime.

```js
import { createRigynSdk } from "rigyn/sdk";

await using rigyn = await createRigynSdk({
  workspace: process.cwd(),
  defaultSelection: { provider: "provider-id", model: "model-id" },
  extensions: {
    paths: ["./extensions/review/runtime/index.mjs"],
    packages: ["./packages/team-tools"],
  },
  resources: {
    skillPaths: ["./skills"],
    promptTemplatePaths: ["./prompts"],
    templates: [{ id: "audit", template: "Audit this request:\n\n{{input}}" }],
  },
  context: {
    appendSystemPrompt: [{ text: "Prefer the smallest verified change.", source: "host policy" }],
  },
});

const result = await rigyn.run({
  prompt: rigyn.renderPrompt("audit", "Inspect the current patch."),
});
console.log(result.results.at(-1)?.finalText);
```

## Composition sources

- `extensions.paths` loads trusted invocation-only runtime entry files through the normal extension loader.
- `extensions.packages` installs invocation-only local, npm, or Git packages into a temporary managed root. Package scripts remain disabled unless `allowPackageScripts` is explicitly true.
- `extensions.factories` and `resources.loaders` are bounded programmatic composition hooks. They may return providers, tools, already-discovered skill metadata, SDK-local prompt templates, resource paths, context defaults, and a disposer. They do not receive credential stores, provider registries, session stores, or mutable agent state.
- A factory that needs the full runtime extension API should return an extension entry path or package source instead of recreating extension activation inside the host application.

Provider adapters supplied programmatically remain caller-owned. Rigyn registers them for each active resource generation but does not dispose them. Programmatic tools and skills are owned by the SDK composition layer; replacement is transactional and never removes unrelated host or extension resources.

`reload()` first commits the normal validated runtime generation, then reapplies the programmatic provider/tool/skill composition before resolving. File/package extensions and loose resource paths are reloaded by the normal runtime. A configured provider ID cannot collide with a programmatic provider ID.

## Settings and authority

`runDefaults`, `defaultSelection`, and `context` provide per-owner task defaults. `runtime` accepts the supported embedding decisions `projectTrusted`, `recover`, and `sessionDirectory`. Arbitrary in-memory `HarnessConfig` replacement is intentionally unsupported: configured providers, credentials, retry policy, execution backends, child-run limits, and other host settings continue through validated user/project configuration and normal reload.

The returned owner exposes tasks, safe session handles, bounded transcripts/catalogs, local SDK templates, reload, and cleanup. It does not expose credentials, auth brokers, provider registries, SQLite stores, `HarnessService`, or raw agent state. Close it with `await using` or `close()`; factory abort signals fire before reverse-order disposers run.

`runPrintMode()` and the narrow `runInteractiveMode()` from [`rigyn/modes`](modes.md) accept the SDK owner directly. They borrow its session factory and preserve its defaults, programmatic composition, and lifecycle; neither mode creates or closes another SDK/runtime instance. `runOwnedInteractiveMode()` and in-process RPC remain advanced `HarnessRuntime` boundaries because they bind authentication, runtime-extension UI, model, reload, and broad session policy through an exclusive owner lease.
