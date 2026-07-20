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
| Permission-gated structural header, widget, footer, or working presentation | `../../../examples/advanced-ui/` |
| Reviewed native UI, provider transport, credential, raw-session, or host-configuration integration | `../../../examples/trusted-native-host/` |
| Model-callable tool, observation format, and dependency-free package test | `../../../examples/custom-tool/` |
| Tool-call guard or tool-result transform | `../../../examples/tool-lifecycle/` |
| Dynamic active-tool catalog or loader | `../../../examples/dynamic-tools/` |
| Custom session compaction lifecycle | `../../../examples/custom-compaction/` |
| Fixed MCP stdio server boundary | `../../../examples/mcp-stdio/` |
| Parallel child delegation or agent-style tool | `../../../examples/child-coordinator/` |
| One focused child with child-specific instructions | `../../../examples/child-specialist/` |
| Paged namespaced extension messages or memory | `../../../examples/paged-memory/` |
| Historical token, cache, cost, or duration summaries | `../../../examples/session-analytics/` |
| Provider disable, replacement, or live disposal | `../../../examples/provider-lifecycle/` |
| Unified command, prompt, and skill discovery | `../../../examples/resource-discovery/` |
| Safe system-prompt metadata inspection | `../../../examples/prompt-inspector/` |
| Child review plus durable completion state | `../../../examples/review-workflow/` |
| Session search, transcript paging, or naming | `../../../examples/session-tools/` |
| Destructive or privileged action requiring approval | `../../../examples/approval-gate/` |
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
- **Host authority:** exact runtime API operations and manifest permissions the extension needs.
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

Managed runtime code may value-import only the exact host modules `rigyn/context`, `rigyn/core`, `rigyn/extensions`, `rigyn/images`, `rigyn/net`, `rigyn/process`, `rigyn/prompts`, `rigyn/providers`, `rigyn/testing`, `rigyn/tools`, and `rigyn/tui`. Do not import the package root or invent deeper host subpaths. Keep `rigyn` as a peer and development dependency for declarations and standalone tests, not as a nested production runtime.

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
- Return required `content` as a string and required `isError` as a boolean. Serialize structured domain data with `JSON.stringify(...)`; never return an object or array directly as `content`. Put the host's top-level `status` (`success`, `warning`, or `error`), one-line `summary`, and actionable `nextActions` beside those required fields. Do not bury recovery fields inside JSON content, invent additional statuses, or emit placeholder artifacts.
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
- In a lifecycle or input listener, use `context.session` when present for callback-bound identity, model/usage/prompt inspection, idle or pending-message checks, abort, and compaction. Do not capture a mutable active-session pointer or assume every non-session event has this surface.
- Build streaming UI from the accumulated provider-neutral `message_start.message` and `message_update.message` snapshots. Treat `tool_call_end` as finalized canonical input, `turn_end` as the assistant-plus-tool-result boundary, and `agent_end.messagesTruncated` as authoritative before consuming its bounded run history. Do not retain native provider stream objects.
- For branch-aware tool guards, use the `tool_call` event's host-supplied `threadId`, `runId`, and resolved `branch`. Never put session identity in a model-controlled tool schema or infer it from a mutable global pointer.
- For branch-aware tool execution or `api.runChild`, use the tool context's host-supplied `threadId`, `runId`, and `branch`; do not add those identifiers to model-controlled input.
- For durable read-modify-write state, use `api.session.compareAndAppendState` with the prior record's `eventId` (or `null` when absent) and a bounded conflict retry. Do not pair `readState` with a blind `appendState` for counters, memory, plans, or indexes.
- Record each logical message from one canonical event, filter accepted roles explicitly, and avoid a mutable global "active session" pointer. RPC and embedded hosts can run or switch more than one session.
- Use `api.runChild` for bounded agent delegation. Supply an explicit tool allowlist (`[]` for model-only work), choose fresh or stable-fork context deliberately, and default to ephemeral sessions. Use bounded `systemPrompt` only when the child genuinely needs a replacement role; prefer `appendSystemPrompt` for task-specific guidance so normal host instructions remain present. The host always retains the no-recursive-delegation invariant. Omitted limits use the active host `childRuns` policy (stock defaults are 32 model turns and ten minutes); set lower `maxSteps` or `timeoutMs` only when the delegated task is intentionally narrower. Never implement delegation by launching `rigyn`, its RPC mode, or another copy of the active harness.
- For visible foreground delegation, use `runChild.onStart` for stable child identity and coalesce safe `runChild.onEvent` updates into native tool progress. Keep the tool call pending until the child settles, then return one terminal result so the parent loop continues. Do not forward every token delta or keep a second in-memory transcript.
- For a parallel child batch, use one controller and identity slot per child, aggregate progress into the parent tool row, and await `Promise.allSettled` before returning. Implement detached background jobs only when explicitly requested; then own bounded job state, cancellation, durable completion, failure observation, and generation disposal rather than dropping a `runChild` promise.
- Use `api.getDiscoveryView()` when an extension needs one command/prompt/skill picker. Keep `api.getCommands()` only for synchronous runtime-command discovery. Page older namespaced messages by passing the first returned `eventId` as `beforeEventId`; never scan an unbounded session history.
- Use `api.getSessionUsage()` for restart-safe token/cache/cost totals and `api.getSystemPromptSnapshot()` only when prompt inspection is necessary. The latter is redacted but still contains project instructions, so do not copy it into diagnostics or external requests by default.
- Keep the disposer returned by `api.registerProvider()` when a provider can be disabled before generation shutdown. Await it once; it is idempotent and ownership-scoped.
- Treat captured transcript/session text as untrusted before persistence. Cross-workspace reads or mutations require an explicit user action and scope check, even when the model knows an object ID.
- For a session browser or dashboard, page `api.listSessions` to choose a current-workspace `threadId`, then page `api.getTranscript`. Do not scan the session database, enumerate another workspace, or search raw event payloads.
- Prefer the host session namespace for concurrent durable state. If an external file or database is required, validate every record, coordinate independent processes, use collision-safe atomic commits, surface write failures, and drain pending writes during shutdown and disposal.
- Delete unseen durable rows only after a complete scan. Cancellation, errors, or configured bounds make a scan incomplete and must preserve rows the scan did not observe.

### Credentials and external systems

- For ordinary provider integrations, declare exact authenticated request origins and the required API-key, bearer, or AWS signing policy in the provider auth descriptor. Send requests through `api.auth.fetch`; credential bytes then remain behind the host broker. Start from `examples/brokered-provider`.
- Never reflect remote response bodies, headers, or credential-bearing URLs into model-visible errors. Return a bounded local category and recovery step instead.
- A model-controlled boolean is not user approval. Use native `context.ui.confirm` for trust, destructive actions, or external execution, and fail closed when interactive UI is unavailable.
- Execute argv arrays for fixed programs; do not interpolate untrusted input into a shell command.
- Treat installed runtime modules and their dependencies as trusted code. Document network, process, filesystem, and credential authority in the README.
- Measure both packed output and the complete production dependency tree against Rigyn's entry-count, file-size, aggregate-byte, nesting-depth, and operation-time limits. Choose smaller dependencies or output; never ship package-local `node_modules` or relax host limits to make a package fit.

### Reviewed native tier

Use `api.native` only when the ordinary API cannot implement the product. The package must pass the trusted local or managed-package review and declare each exact permission it uses; a manifest declaration never makes an untrusted project executable.

- `nativeUi` grants decoded input interception, complete editor replacement/wrapping, autocomplete wrapping, persistent component mounts above or below the editor, complete header/footer replacement, paste, resolved theme objects, and generation-owned application of validated SGR-only themes. It does not grant raw terminal bytes or unvalidated ANSI output.
- `providerOverride` grants a generation-owned complete replacement or a field-level `api.native.providers.overlay` for display name, secure base URL, headers, models, catalog loading, or streaming behavior. Prefer an overlay when retaining the host adapter and authentication. `providerWire` grants request-dependent JSON/destination/header transformation and response-header observation; use a host-applied `baseUrl` patch to preserve private query values without seeing them. Credential-bearing request fields and response bodies remain hidden.
- `credentialAccess` allows `api.native.credentials.resolve()` to return the active access credential and derived headers. Request it only when brokered `api.auth.fetch` cannot implement the integration. Never print, persist, send to extension output, or retain the result beyond the bounded operation; refresh tokens and credential-store handles are never returned.
- `sessionRaw` grants bounded canonical event/run pages and process-local unredacted prompt snapshots. It is not a mutable store handle and does not widen workspace or branch ownership.
- `hostConfiguration` grants effective host paths/settings and validated user or trusted-project configuration updates. Do not use it as a general file-write bypass.

Every native handle is generation-owned. Propagate caller cancellation and treat `api.signal` abort as immediate revocation. Use returned provider/UI disposers only for an earlier opt-out while the generation is active; unload already revokes them, so do not call generation-bound handles from `onDispose`. Release only extension-owned raw resources there. Verification must cover an undeclared permission, an untrusted entry, caller and generation abort, failed candidate activation, successful reload, and final unload; no privileged registration or secret-bearing value may survive those boundaries. Start from `examples/trusted-native-host` and review `docs/extension-auth-threat-model.md` before requesting the tier.

### User experience

- Provide one obvious entry point and concise startup feedback.
- Design empty, loading, active, success, cancelled, disconnected, and error states for interactive products.
- Make destructive or irreversible actions explicit; routine read and navigation actions should remain frictionless.
- Prefer meaningful information hierarchy over a grid of placeholder cards. A dashboard must expose live session value and real controls, not merely prove that a web server starts.
- Use ordinary structural UI unless persistent terminal chrome is essential. For `api.ui.advanced`, declare `"permissions": { "advancedUi": true }`, require the package to pass the trusted local or managed-package policy, and start from `examples/advanced-ui`. The tier permits bounded header/footer components, widgets above or below the editor, complete structural header/footer replacement, working frames, the collapsed-reasoning label, a generation-owned tool-expansion override, and non-consuming sanitized key observation. Component factories may resolve asynchronously; pending factories consume no rows and are discarded safely after unload. The tier never permits raw terminal bytes, ANSI, screen ownership, secret input, key consumption, or submission control. Rely on generation cleanup and keyed restoration; do not mutate host internals or reproduce the terminal loop.

### Local imports and test location

- Resolve every relative module specifier from the file that contains the import, never from the shell's current directory. For example, `test/tool.test.mjs` imports `runtime/index.mjs` with `../runtime/index.mjs`, not `../../runtime/index.mjs`.
- When `rigyn` is not installed as a resolvable package dependency, a package-local test must not import `rigyn`, `rigyn/extensions`, or another `rigyn/*` subpath. Import the package's local runtime entry and activate it with the smallest host stub needed by that test. Use `examples/custom-tool/test/runtime.test.mjs` as the dependency-free pattern. Exercise the real loader only after the package is installed into a Rigyn host or when a declared development dependency makes the public host modules resolvable.
- Before running a package test, change to the package root and confirm that the expected runtime, manifest, and test files exist there. Run the exact package-local command from that directory, such as `node --test test/*.test.mjs` or `npm test`.
- Treat a non-zero test status, missing module, empty test discovery, or a command run from the wrong directory as a failed verification. Fix the package and rerun the exact command; never report completion from a partial or assumed command result.

## Build and verify

1. Inspect repository conventions and current tests before editing.
2. Choose a fresh output directory in the active workspace and confirm it is not a bundled example or an installed-package path.
3. Implement the smallest end-to-end vertical slice that reaches the visible outcome.
4. Add a deterministic focused test using the real loader/host contract when it is resolvable, or the documented dependency-free activation pattern before installation. Cover malformed input and cancellation or cleanup when relevant. For every tool result, assert that `content` is a string, `isError` is a boolean, and parsed JSON has the promised shape. Resolve local imports from the test file and run it from the package root.
   The documented package-local test command must also pass from an ordinary user shell. Do not make it depend on `RIGYN_INSTALL_DIR` or another environment variable that exists only inside an active harness process. If `rigyn/extensions` is not installed as a resolvable development dependency, `npm test` must remain dependency-free: import the local runtime, use a minimal host stub, and exercise the real loader later through the documented `rigyn --package` or managed-install smoke path.
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
- undeclared or untrusted native permissions, stale native handles, failed-candidate rollback, caller/generation abort, and reload/unload cleanup when using `api.native`;
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
