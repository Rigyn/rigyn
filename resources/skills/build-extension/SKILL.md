---
name: build-extension
description: Design, implement, repair, or package production-quality Rigyn extensions/plugins, tools, commands, skills, prompts, themes, providers, terminal UI, and local web dashboards. Use for extension/package authoring or when an existing extension is incomplete, unsafe, or fails after installation.
compatibility: Rigyn 0.1 or later; Node.js 24.15+ or 26+ for runtime extensions.
allowed-tools: read bash edit write grep find ls
---

# Build an extension

Use this workflow for an extension or shareable package. The goal is a useful product with a narrow contract, not a decorative scaffold.

## Locate the authoritative material

This skill is installed inside the Rigyn package. Resolve every relative link from this `SKILL.md` directory.

1. Read [extension API documentation](../../../docs/extensions.md) completely.
2. Read [package documentation](../../../docs/packages.md) when the result will be installed, shared, fetched from npm or Git, or use third-party dependencies.
   Read [package discovery metadata](../../../docs/package-gallery.md) when the result will be published or indexed.
3. Read [TUI documentation](../../../docs/tui.md) for terminal components, dialogs, widgets, renderers, shortcuts, or custom presentation.
   For input assistance, start from [`examples/input-assist`](../../../examples/input-assist) and use generation-owned autocomplete/editor middleware rather than terminal internals.
4. Choose one base from the routing table, then inspect the focused example for every runtime capability the package actually uses. Read each selected manifest, runtime, README, every test that is present, and directly referenced files—not only the first file. Use `examples/package-starter/activation.test.mjs` as the public-loader pattern when a focused example has no test of its own.
5. Use [the tested capability matrix](../../../docs/extension-capabilities.md) to confirm that every required host surface has documentation and verification in this installed build.
6. Read [the runtime event reference](../../../docs/extension-events.md) when the package observes or transforms lifecycle events. Choose the narrowest event boundary and follow its result, failure, and cancellation contract.
7. When a documented signature remains ambiguous, inspect the installed declarations under `../../../dist/extensions/` or, in a source checkout, the matching implementation under `../../../src/extensions/`. Do not invent API methods.

The package documentation, examples, and declarations beside this skill are authoritative for the installed version. Do not rely on remembered APIs from another harness.

Treat every bundled example and installed documentation file as read-only reference material. Create the requested extension in a new package directory inside the user's active workspace. Never edit, rename, or build the user's requested product inside the installed Rigyn package or its bundled examples unless the user explicitly asked to maintain that exact example.

## Route by requested capability

| Need | Start here |
| --- | --- |
| Small installable package | `../../../examples/package-starter/` |
| Model-callable tool and observation format | `../../../examples/custom-tool/` |
| Tool-call guard or tool-result transform | `../../../examples/tool-lifecycle/` |
| Dynamic active-tool catalog or loader | `../../../examples/dynamic-tools/` |
| Custom session compaction lifecycle | `../../../examples/custom-compaction/` |
| Fixed MCP stdio server boundary | `../../../examples/mcp-stdio/` |
| Provider adapter and model catalog | `../../../examples/custom-provider/` |
| Provider adapter with API key, OAuth, or ambient authentication | `../../../examples/brokered-provider/` |
| Durable extension-owned session state | `../../../examples/session-notes/` |
| Durable state schema migration | `../../../examples/state-migration/` |
| Communication between runtime entries | `../../../examples/shared-events/` |
| Reload failure and disposal | `../../../examples/reload-safety/` |
| Model-callable tools plus durable state or lifecycle events | `../../../examples/reference-package/` as the base, then `../../../examples/custom-tool/` and `../../../examples/session-notes/` for their focused contracts |
| Several contribution types in one offline package | `../../../examples/reference-package/` |
| Browser dashboard controlling live sessions | `../../../examples/package-starter/`, `../../../docs/extensions.md`, and [dashboard checklist](references/dashboard.md) |

Do not combine examples indiscriminately. Select one base, but for a multi-capability package inspect every focused contract it uses and borrow only those required pieces.

## Establish the product contract

Before writing files, state a compact acceptance matrix:

- **User entry point:** slash command, tool call, shortcut, startup behavior, prompt, or theme selection.
- **Visible outcome:** the information or action the user receives; for UI, list the primary empty, loading, success, and failure states.
- **Host authority:** exact runtime API operations the extension needs.
- **State:** what survives reload or restart, its schema version, and what is intentionally ephemeral.
- **External boundary:** filesystem, process, network, browser, credentials, or none.
- **Verification:** deterministic test and real install/reload smoke command.

Ask one focused question only when a missing choice materially changes the product. Otherwise choose the smallest coherent interpretation and record it.

## Choose the least-powerful contribution

Prefer declarative resources when code is unnecessary:

- A `SKILL.md` is an on-demand workflow with references or helper assets.
- A Markdown prompt is a repeatable task template.
- A JSON theme changes semantic presentation.
- A runtime module is justified for tools, events, state, providers, commands with behavior, or interactive UI.

Use a package root that can be installed as a complete unit. A focused package commonly contains:

```text
extension.json
README.md
runtime/index.mjs       # only when behavior requires code
skills/<name>/SKILL.md  # only when a skill is part of the product
prompts/<name>.md       # only when a prompt is part of the product
themes/<name>.json      # only when a theme is part of the product
test/<name>.test.mjs    # or a repository-native focused test
package.json            # for registry metadata or dependencies
```

Use normalized relative paths in `extension.json`. Keep stable identifiers lowercase and namespaced enough to avoid collisions. Declare only actual contributions.

For an npm-oriented third-party package, use the documented `rigyn` resource declarations or documented conventional directories. Put runtime libraries in `dependencies`, keep build-only tooling in `devDependencies`, and make the packed artifact contain every declared file. Never assume source-only files will exist after packaging.

## Implementation quality bar

### Runtime lifecycle

- Make activation deterministic and cheap. Start long-lived work lazily unless the feature must be active immediately.
- Register cleanup for servers, timers, watchers, event listeners, temporary files, and subprocesses.
- In `onDispose`, release or await only extension-owned raw resources. Generation-bound API, UI, auth, session, command, and tool surfaces are already inactive and must not be called from a disposer.
- Propagate cancellation through tools, commands, provider calls, session actions, and process execution.
- A cancelled queued or running operation must settle only itself and leave a serialized queue usable by a later operation. Test cancellation before start followed by a successful call.
- Bound time, concurrency, request sizes, output sizes, queues, retained state, and in-memory collections.
- Treat reload as normal: a failed candidate must not corrupt the previous generation, and a successful reload must not leave the old generation alive.

### Tools and model observations

- Give each tool one clear job and a closed, narrow JSON schema.
- Validate before side effects. Use sequential execution or resource claims when calls can conflict.
- Return the host's top-level `status` (`success`, `warning`, or `error`), one-line `summary`, and actionable `nextActions`; keep bounded domain data in `content`. Do not bury recovery fields inside JSON content, invent additional statuses, or emit placeholder artifacts.
- On error, provide a root-cause hint, a safe retry step, and a stop condition. Never expose credentials or unbounded raw output.
- Bound aggregate result bytes as well as item counts; many individually valid rows can still overflow model context.
- Bound JSON fields and items before `JSON.stringify`. Never byte-slice serialized JSON; overflow output must remain parseable and explicitly identify truncation.
- Add a renderer only when it improves scanability; the text observation must remain useful in headless and RPC modes.
- For long-running tools, publish bounded replaceable native results through `context.reportProgress({ type: "result", ... })`, aggregate or throttle rapid updates, and return the complete terminal result. Render loading and completion through the same tool renderer using `view.isPartial`; do not build a parallel transcript surface.

### State and events

- Store durable state through the extension session namespace, with an explicit schema version and stable keys.
- Use `api.dataPaths.user` or `api.dataPaths.workspace` only for a real external file/database or generated resource that does not fit session state. Never write durable data into the installed package, invent a home-directory path, or persist credentials. Own atomicity, locking, bounds, validation, migration, and cleanup for every external file.
- Reconstruct behavior from durable records rather than process memory when restart continuity matters.
- Keep model context and transcript presentation separate. Do not add noisy status records to model context.
- Mark genuinely large, rarely used tool definitions with `loading: "deferred"`. Treat it as a provider-neutral hint: verified provider families may use native tool search, and all other cases safely receive the full definition.
- Make event handlers deterministic, bounded, abortable, and idempotent where retries or reload can repeat work.
- For branch-aware tool guards, use the `tool_call` event's host-supplied `threadId`, `runId`, and resolved `branch`. Never put session identity in a model-controlled tool schema or infer it from a mutable global pointer.
- For branch-aware tool execution or `api.runChild`, use the tool context's host-supplied `threadId`, `runId`, and `branch`; do not add those identifiers to model-controlled input.
- For durable read-modify-write state, use `api.session.compareAndAppendState` with the prior record's `eventId` (or `null` when absent) and a bounded conflict retry. Do not pair `readState` with a blind `appendState` for counters, memory, plans, or indexes.
- Record each logical message from one canonical event, filter accepted roles explicitly, and avoid a mutable global "active session" pointer. RPC and embedded hosts can run or switch more than one session.
- Use `api.runChild` for bounded agent delegation. Supply an explicit tool allowlist (`[]` for model-only work), choose fresh or stable-fork context deliberately, and default to ephemeral sessions. Omitted limits use the active host `childRuns` policy (stock defaults are 32 model turns and ten minutes); set lower `maxSteps` or `timeoutMs` only when the delegated task is intentionally narrower. Never implement delegation by launching `rigyn`, its RPC mode, or another copy of the active harness.
- For visible foreground delegation, use `runChild.onStart` for stable child identity and coalesce safe `runChild.onEvent` updates into native tool progress. Keep the tool call pending until the child settles, then return one terminal result so the parent loop continues. Do not forward every token delta or keep a second in-memory transcript.
- For a parallel child batch, use one controller and identity slot per child, aggregate progress into the parent tool row, and await `Promise.allSettled` before returning. Implement detached background jobs only when explicitly requested; then own bounded job state, cancellation, durable completion, failure observation, and generation disposal rather than dropping a `runChild` promise.
- Treat captured transcript/session text as untrusted before persistence. Cross-workspace reads or mutations require an explicit user action and scope check, even when the model knows an object ID.
- For a session browser or dashboard, page `api.listSessions` to choose a current-workspace `threadId`, then page `api.getTranscript`. Do not scan the session database, enumerate another workspace, or search raw event payloads.
- Prefer the host session namespace for concurrent durable state. If an external file or database is required, validate every record, coordinate independent processes, use collision-safe atomic commits, surface write failures, and drain pending writes during shutdown and disposal.
- Delete unseen durable rows only after a complete scan. Cancellation, errors, or configured bounds make a scan incomplete and must preserve rows the scan did not observe.

### Credentials and external systems

- Declare exact authenticated request origins and the required API-key, bearer, or AWS signing policy in the provider auth descriptor. Send requests only through `api.auth.fetch`. Credential bytes remain behind the host broker and must never be requested, printed, persisted, or included in extension output. Start from `examples/brokered-provider`.
- Never reflect remote response bodies, headers, or credential-bearing URLs into model-visible errors. Return a bounded local category and recovery step instead.
- A model-controlled boolean is not user approval. Use native `context.ui.confirm` for trust, destructive actions, or external execution, and fail closed when interactive UI is unavailable.
- Execute argv arrays for fixed programs; do not interpolate untrusted input into a shell command.
- Treat installed runtime modules and their dependencies as trusted code. Document network, process, filesystem, and credential authority in the README.
- Measure both packed output and the complete production dependency tree against Rigyn's entry-count, file-size, aggregate-byte, nesting-depth, and operation-time limits. Choose smaller dependencies or output; never ship package-local `node_modules` or relax host limits to make a package fit.

### User experience

- Provide one obvious entry point and concise startup feedback.
- Design empty, loading, active, success, cancelled, disconnected, and error states for interactive products.
- Make destructive or irreversible actions explicit; routine read and navigation actions should remain frictionless.
- Prefer meaningful information hierarchy over a grid of placeholder cards. A dashboard must expose live session value and real controls, not merely prove that a web server starts.

## Build and verify

1. Inspect repository conventions and current tests before editing.
2. Choose a fresh output directory in the active workspace and confirm it is not a bundled example or an installed-package path.
3. Implement the smallest end-to-end vertical slice that reaches the visible outcome.
4. Add a deterministic focused test using the real loader/host contract. Cover malformed input and cancellation or cleanup when relevant.
   The documented package-local test command must also pass from an ordinary user shell. Do not make it depend on `RIGYN_INSTALL_DIR` or another environment variable that exists only inside an active harness process. If `rigyn/extensions` is not installed as a resolvable development dependency, keep `npm test` dependency-free and exercise the real loader through the documented `rigyn --package` or managed-install smoke path.
5. Treat the clean source, exact packed archive, and exact installed copy as three separate verification surfaces. Before the source report, remove package-local `node_modules`, archives, generated state, and test credentials. Run `rigyn extensions author report PACKAGE`, the focused test, typecheck, and the repository's normal verification command; then run the author report again on the exact unpacked archive.
6. Install the exact archive through the normal package command. For a local npm archive use `rigyn install "npm:file:///absolute/path/package.tgz"`, not an ambiguous relative source.
7. Run extension diagnostics, exercise the documented entry point, reload it, and exercise it again.
8. Remove the test installation and confirm cleanup. Do not leave global state or background processes behind.
9. When publication is requested, run `rigyn extensions author pack PACKAGE DESTINATION`, inspect the exact archive, and verify that declared paths, runtime dependencies, README commands, version, and integrity data match it.
10. Execute every README command exactly as written. A command-like phrase that falls through to agent input is a failed smoke test; inspect for surviving child processes before completion.
11. For disposable install tests, invoke the intended Rigyn binary and inspect each `packageRoot` from `rigyn list --json`; every root must be inside the disposable installation. Environment variables alone do not prove state isolation.
12. When a package contributes model-callable tools or a provider and credentials are available, run one bounded real provider/model turn through the exact installed copy. Direct host invocation cannot expose reserved tool names, provider-wire schema failures, or tool-search incompatibilities; if the live turn cannot run, report that caveat explicitly.

Do not declare success after activation alone. The feature must perform its user-visible job through the installed copy.

## Failure checks

Test the applicable cases:

- malformed manifest or missing declared asset;
- duplicate command, tool, provider, prompt, theme, or state identifier;
- malformed tool input and provider/network failure;
- cancellation during active work;
- activation failure and reload failure;
- repeated activation/reload without duplicated listeners or servers;
- restart with existing durable state;
- two independent runtime/store instances writing concurrently;
- duplicate event capture, unsupported message roles, and cross-workspace access or deletion;
- package install from a separate directory, plus remove;
- unavailable interactive UI in a headless host;
- stale autocomplete/editor callbacks after reload, malformed ranges, oversized replacements, and protected application shortcuts;
- oversized or hostile browser/process input when an external boundary exists.
- every documented CLI command dispatching once without recursive child launches.
- child-run timeout, cancellation, output truncation, unavailable tools, ephemeral cleanup, and recursive-delegation rejection when the package delegates model work.

## Completion report

Report:

- the user-visible behavior delivered;
- package root and entry point;
- files and host capabilities used;
- focused tests and install/reload evidence;
- any authority, dependency, compatibility, or publication caveat that remains.

Do not call a sample production-ready when the real install path, reload, failure behavior, or documented entry point was not exercised.
