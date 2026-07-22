# Changelog

Release-impacting changes are recorded here. The version policy and release procedure are in [`docs/releasing.md`](docs/releasing.md).

## Unreleased

## [0.5.0] - 2026-07-22

### Added

- Added Kimi Code subscription OAuth with bounded device authorization, rotating refresh tokens, host overrides, and API-key coexistence.
- Added public assistant-call retry helpers, kernel compaction and branch-summary retry policy/events, retained-tail session checkpoints, and a configurable default stream function.
- Added a deterministic, commit-exact source release archive with checksums and a clean-install rebuild gate before package publication.

### Changed

- Made Rigyn's maintained fallback catalog the only bundled chat-model source, preserving its reasoning metadata while live discovery remains authoritative.
- Deferred live model discovery until after the interactive terminal is visible while retaining cached model hydration at startup and resource-only `/reload` behavior.
- Restored the shared `Ctrl+O` tool-output expansion binding and made source installation build and verify the matching macOS or Windows terminal helper.

### Fixed

- Normalized Node-native `Request` objects before the npm Undici transport, eliminating `Failed to parse URL from [object Request]` during Codex WebSocket-to-SSE fallback.
- Preserved the exact per-model `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` thinking choices through the interactive picker and request bridge.
- Made `/reload` preserve the editor draft, block input transactionally, report the exact refreshed resources, and recover cleanly after failure.
- Fixed Escape cancellation and exit routing, shrink-to-empty repainting, software-cursor cleanup, CRLF rendering, and atomic paste undo in the terminal UI.
- Retried transient compaction and branch-summary failures without replaying partial output, exposing complete retry lifecycle events across TUI, terminal, RPC, and SDK surfaces.
- Preserved retained-tail compaction ancestry in memory and JSONL sessions, and tightened CLI required-value, management-command, settings, trust, and documentation diagnostics.
- Added the Anthropic subscription-billing warning with a persistent opt-out while keeping credential reads silent and secret-free.

## [0.4.4] - 2026-07-22

### Fixed

- Preserved exact per-model reasoning-effort support across the runtime bridge so advertised `xhigh` and `max` levels remain selectable instead of being clamped after `high`.
- Let Escape cancel active questions and pickers before idle interrupt handling, and decoded adjacent Escape bytes as separate key events without closing the terminal UI.
- Resolved the concrete Node executable before isolating self-contained XDG directories so launchers keep working with version-manager shims such as mise.

## [0.4.3] - 2026-07-21

### Fixed

- Separated extension module-load and activation deadlines in package activation coverage so slow Windows runners test the intended phase without a timing race.

## [0.4.2] - 2026-07-21

### Fixed

- Preserved standalone release archives stored beneath the hidden artifact directory during GitHub Actions upload.
- Canonicalized supplied session workspaces before runtime identity checks so standalone startup remains stable across Windows path aliases and casing.

## [0.4.1] - 2026-07-21

### Fixed

- Allowed standalone release builders to hydrate pinned production dependencies when a fresh runner cache is empty while preserving offline runtime verification.
- Increased packed-install phase budgets to accommodate runner timing variance without weakening the overall test ceiling.

## [0.4.0] - 2026-07-21

### Added

- Added an independent `rigyn/images` generation surface with a broker-compatible provider collection, explicit API registry, maintained OpenRouter image catalog, lazy SDK transport, bounded retries and responses, structured usage/cost, payload/response hooks, and never-reject one-shot results.
- Added direct-session snapshots for the current streaming message, pending tool calls, and latest assistant error while retaining access to the active mutable JSONL session manager.
- Added a session-backed low-level `agent` contract with mutable model, messages, tools, prompt, and thinking state; reset and queue control; provider transport, retry, and reasoning settings; and operative stream, authentication, context, tool, and next-turn hooks.
- Replaced the single echo-process sample with a concurrent subprocess-agent example covering specialization, ephemeral CLI children, structured event validation, recursion prevention, cancellation, failure isolation, and bounded aggregation.

### Breaking

- Renamed the reusable workspace packages to `@rigyn/models`, `@rigyn/kernel`, and `@rigyn/terminal`. Replace imports of the former scoped package names with those mappings; the `rigyn` package and every documented `rigyn/*` subpath remain stable. The companion model utility is now `rigyn-models`.
- `@rigyn/terminal` now permits only its documented root and `package.json` exports. Replace unsupported deep imports with `@rigyn/terminal` or the supported `rigyn/tui` surface.
- Runtime packages now declare their supported host range through `peerDependencies.rigyn`; invalid or incompatible ranges fail before activation. `engines.rigyn` remains report metadata only.
- Removed the unpublished owned-runtime lease helper from the earlier application layout. Public print, RPC, interactive, embedding, and direct-extension entry points now share `AgentSessionRuntime` and the JSONL session manager directly.
- Removed the superseded session-rendering runtime-event cascade and its schema-key renderer contract. Direct extensions now persist `CustomEntry` and `CustomMessage` values once in the JSONL tree and render those same entries through `registerEntryRenderer` and `registerMessageRenderer` during live display and resume.

Migration from the 0.3 public owners:

| 0.3 API | 0.4 replacement |
| --- | --- |
| Construct `HarnessService` with `SessionStore`. | Use `createAgentSession()` with `SessionManager` for one direct session, or `createAgentSessionRuntime()` when the host must replace sessions. |
| Call `runPrintMode(ModeSessionSource, { prompts, format, ... })` and consume `PrintModeResult`. | Call `runPrintMode(AgentSessionRuntime, { mode, messages, initialMessage, initialImages, write })` and consume its numeric exit status. The mode disposes the supplied runtime. |
| Call `runInteractiveMode()` or `runOwnedInteractiveMode()`. | Construct `new InteractiveMode(runtime, options)`, call `run()`, and dispose the borrowed runtime separately after the terminal owner exits. |
| Use `RpcMode`, `createRpcMode()`, or callback-form `runRpcMode()`. | Pass an already-created `AgentSessionRuntime` to the process-owning `runRpcMode(runtime)` adapter, or use `RpcClient` for a correlated client. |
| Register a `RuntimeExtensionApi` package and its bounded session-state/message renderers. | Export an `ExtensionFactory` that receives `ExtensionAPI`; read the callback's `sessionManager`, mutate through `appendEntry()` or `sendMessage()`, and render those durable values with `registerEntryRenderer()` or `registerMessageRenderer()`. |

Legacy `RIGYN_AI_AUTH_FILE` and `~/.rigyn-ai/oauth.json` settings continue to migrate as compatibility fallbacks. New configuration should use the current model credential locations.

### Changed

- Interactive startup now records the installed version locally, stays quiet on first use, and shows only newly installed release sections after an update; compact notices remain optional and `/changelog` remains complete.
- Removed inert analytics and install-telemetry preferences that did not correspond to any network behavior. Rigyn does not send install or usage telemetry.
- Steering and follow-up methods now return promises across the direct, public-runtime, and embedding surfaces. Persisted application/editor keybindings now share one live manager with the terminal and trusted direct extension UI, including after `/reload`.
- `AgentSession.modelRuntime` now exposes the public asynchronous `ModelRuntime` used by the session, including model availability, authentication lifecycle, reload, and streaming, while the internal registry remains available only through its compatibility boundary.
- Trusted direct TUI objects now use the public runtime identity while delegating redraws, input draining, dimensions, enhanced-keyboard and color state, overlays, cursor and shrink preferences, and named theme persistence to the active host generation.

### Fixed

- Made native TUI releases build and load each declared macOS and Windows x64/arm64 helper on a matching runner, collect the complete set before staging, assert every helper is packed, and load the matching helper again from the installed release archive.
- Stopped failed, aborted, cancelled, and transient assistant attempts from being replayed into later provider requests while preserving their durable session history.
- Propagated every public per-model compatibility setting through extension registration and configured models into the Chat Completions, Responses, and Messages wire adapters.
- Made npm and Git package updates cancellation-aware and set-atomic, activation-tested temporary Git refreshes before swap, resolved branch/tag collisions deterministically, and rejected checkout races against the advertised revision.

### Security

- Hardened package sources against npm option injection, file-identity and Git-authority collisions, unsafe refs and decoded URL paths, ambient Git hooks/configuration/filters/pagers/credential helpers, SSH configuration proxies, unbounded output/time, and orphaned process trees. Private HTTPS helper authentication is intentionally unavailable; SSH agents and default keys remain supported with real host URLs.

## [0.3.0] - 2026-07-19

### Added

- Added application-stable `rigyn/sdk` and `rigyn/modes` entry points for programmatic composition, print mode, correlated RPC mode, and an exclusive owned-runtime terminal host with bounded transcript repaint, model/session controls, authentication, reload, extension UI, commands, prompts, and skills.
- Added generation-owned extension contracts for structural and decoded-input UI, raw terminal access, provider replacement and wire interception, managed authentication, bounded raw-session reads, live prompt snapshots, effective configuration, child-specific instructions, provider disposal, and cursor-paged durable messages.
- Added unified command/prompt/skill discovery, historical usage/cache/cost summaries, system-prompt snapshots, model/thinking lifecycle events, finalized response events, project-trust participation, user-message delivery, and semantic conformance coverage for every public extension API member.
- Added generic credential-conditioned message-gateway transport, declarative model request compatibility, managed AWS and Google credential chains, xAI subscription authentication, local GGUF and router model management, normalized provider response diagnostics, and additional protocol edge coverage.
- Added automatic light/dark theme pairs, terminal background detection, active custom-theme hot reload, cancellable retry controls, typed RPC model/thinking/session/compaction conveniences, and bounded container and fixed-SSH execution examples.
- Expanded the packaged authoring corpus with advanced UI, child specialization, paged memory, prompt inspection, provider lifecycle, resource discovery, review workflow, session analytics/tools, trusted native host, and SDK composition examples.

### Changed

- Managed package installation now activation-tests the staged candidate before commit, publishes one immutable resource generation, expands the stable host-module map, and retains transactional rollback and lifecycle disposal across startup, reload, and removal.
- Provider routing now applies explicit per-model protocol and request metadata without model-name guessing; official SDKs remain transport adapters behind Rigyn's canonical requests, normalized streams, retry policy, credential broker, and redaction boundaries.
- The terminal interface now presents complete retained tool output, width-bounded reasoning summaries, automatic theme changes, richer editor navigation and kill-ring behavior, stable overlays, terminal images, responsive narrow layouts, and extension-owned structural presentation without raw terminal authority by default.
- Configuration templates and effective output now document every public setting, including retry, theme pairing, provider transport, model compatibility, child-run policy, execution backends, and operator controls, without storing credentials.

### Fixed

- Fixed fresh owned-runtime interactive sessions failing their first prompt without a manual model choice, and stopped an initial run selection from overriding later `/model` changes.
- Fixed reload and resume stalls across large extension sets and long session histories by keeping activation candidate-first, replay cursor-paged, transcript materialization bounded, and generation cleanup cancellable.
- Fixed provider edge cases involving early stream closure, retry eligibility, redacted reasoning, partial tool input, refusal detail, continuation state, request compatibility, cache accounting, and response telemetry.
- Fixed retry-delay cancellation, retry enable/disable propagation, theme watcher recovery, credential-scoped gateway catalog races, and executor process-tree cleanup on cancellation and output overflow.

### Security

- Added exact-origin authenticated fetch plus generation-owned credential, provider, session, host, UI, and terminal handles for trusted runtime extensions; credential-store handles, mutable session stores, and refresh tokens remain host-owned outside managed authentication callbacks.
- Hardened managed auth callbacks, cloud metadata access, external credential commands, extension provider overrides, raw session pages, process execution, and package activation with explicit bounds, generation ownership, redaction, cancellation, and rollback.

## [0.2.0] - 2026-07-18

### Added

- Added exact per-model routed-provider composition across the supported protocol families, with explicit metadata and fail-closed continuation-state isolation instead of model-name guessing.
- Added bounded extension editor rendering, schema-revalidated tool-input transforms with durable extension attribution, and redacted provider-response diagnostics containing response/request IDs, status, and allowlisted headers.
- Added exclusive-cursor RPC history pages and snapshot-bounded subscription replay for very large sessions, replacing eager history materialization with a bounded default page.
- Added a session-oriented embedding facade and `/context` prompt-composition provenance without exposing stores, registries, credentials, or prompt bodies.
- Added deterministic startup/reload/resume performance guards, an opt-in same-task two-harness comparison runner, and independent CI coverage floors for the five highest-risk modules.

### Breaking

- `thread.events` now always returns a bounded `RpcEventPage`; callers must follow `nextCursor` while `hasMore` is true instead of relying on the former eager event-array response.

### Changed

- Reorganized the exact-pinned provider transports behind the standalone `@rigyn/models` package while retaining focused request, streaming, retry, caching, and normalization coverage.
- Runtime resources now commit or roll back as one immutable generation, extension session access passes through a workspace/branch-scoped facade, and RPC dispatch uses a typed complete method registry.
- Managed extension runtime imports now resolve only `rigyn/extensions`, `rigyn/providers`, and `rigyn/tui` through the active host, preventing a separately installed package from loading a second host instance.
- Restored the released inline transcript, composer, user-row, and picker geometry while keeping reasoning and picker help width-bounded and presenting completed tool output through compact transparent status rails without an expansion shortcut.
- Session storage now uses append-only version 3 JSONL trees with durable parent links, branch navigation, model/thinking changes, custom entries, and compaction summaries. Older version 1 and 2 session files are upgraded in memory and rewritten only after a successful load.
- Portable JSONL archives now use schema version 2 and identify each event's branch incarnation. The importer continues to accept schema version 1 and headerless legacy archives.

### Fixed

- Preserved deleted-and-recreated same-name branch history across JSONL export/import without making archived events reachable from the active branch.
- Bounded RPC replay/live handoff and client callback queues, made unsubscribe idempotent and draining, and kept reconnect cursors exact across oversized events, writer failures, and stop races.
- Applied the same portable redaction to RPC history, replay, and live events, and paged extension transcript reads directly from stable storage snapshots instead of materializing long branches.
- Cancelled hung resource-catalog readers during reload and close while retaining transferred run leases, so stale generation work cannot block disposal or expire an active run handoff.
- Bounded release-command output and cleanup on Node 26, including timeout wakeup, residual process groups, Linux detached descendants, and parent-signal forwarding.
- Made the default agent prompt treat failed verification as unfinished work and require inspection, correction, and a successful rerun before claiming completion.

## [0.1.7] - 2026-07-17

### Fixed

- Made runtime reload atomic, cancellable, and deadline-bounded across extension lifecycle handlers, UI commits, provider disposal, network shutdown, and old-generation cleanup, so a stalled extension cannot freeze the active session or overlapping reloads.
- Made session catalogs and previews lazy and bounded interactive transcript replay to recent presentation data, keeping startup, workspace switching, and resume responsive without deleting durable history or reducing provider context and exports.
- Added fenced runtime ownership and race-safe abandoned-work recovery to the session database, preventing stale or crashed processes from renewing ownership or mutating work after another runtime has recovered it.
- Moved extension-package operation leases out of repositories and into private per-user state, with canonical path identity, cancellation, crash recovery, and file-identity validation.
- Bounded graceful termination and provider-network cleanup so uncooperative subprocesses, dispatchers, and extension providers cannot indefinitely delay shutdown.

### Security

- Hardened SQLite migrations, runtime leases, artifact writes, and package-mutation locks against concurrent-process races, unsafe shared directories, symlink substitution, and stale file-descriptor replacement.

## [0.1.6] - 2026-07-16

### Changed

- Updated the exact-pinned official OpenAI SDK transport to 6.47.0 after focused provider, resilience, live streaming, full-suite, and packed-artifact validation.
- Strengthened bundled extension-authoring guidance and package release checks for generation disposal, cancellation-safe queues, bounded parseable output, explicit user approval, complete durable scans, dependency-tree limits, archive isolation, and live installed-package smoke tests.
- Updated installation guidance for the active npm distribution while retaining version-pinned GitHub archive and checksum verification paths.

## [0.1.5] - 2026-07-15

### Added

- First-time self-contained installations create a complete commented public-configuration reference, and `rigyn config show --effective` reports merged values and stable config-level defaults without exposing credentials.

### Security


## [0.1.4] - 2026-07-15

### Fixed

- Large, tool-heavy sessions resume and switch without quadratic transcript folding; retained transcript bytes are tracked incrementally and the terminal redraws the rebuilt session once.
- Runtime reloads preserve the active transcript while rebinding extension presentation, and extension package-lock waits now honor cancellation instead of blocking reload behind the full lock deadline.
- Accessibility-mode session replacement preserves visible history even when later durable events do not render transcript output.

## [0.1.3] - 2026-07-14

### Fixed

- Direct command discovery now includes extension commands, prompt templates, and skill commands in host order, and same-owner live tool or command re-registration replaces the active definition.
- Trusted direct provider hooks now receive the complete assembled request headers and normalized response headers, while bounded core diagnostics and exported session data remain redacted.
- Managed extension packages treat a compatible `rigyn` peer as supplied by the active host, preserve optional peer metadata for other packages, and reject an incompatible host range before invoking npm. This prevents a nested Rigyn installation from exhausting the bounded dependency-tree staging limit.
- OpenAI Responses reasoning summaries retain their provider output-item boundaries even when each item restarts at summary index zero, so separate progress summaries render as separate terminal rows instead of growing horizontally.

## [0.1.2] - 2026-07-14

### Added

- Review-required redacted HTML and Markdown session exports preserve visible conversation prose while omitting tool payloads, artifacts, provider-private data, identifiers, timestamps, and known secrets.

### Changed

- Completed tool cards show all retained detail automatically while in-progress output remains bounded; the default tool-expansion shortcut is removed, user messages have clearer separation, and assistant text uses a neutral terminal color.
- Agent runs now default to 64 model invocations and model-initiated shell commands default to a 600-second timeout; explicit positive overrides remain supported.
- Runtime extension commands are documented and verified across interactive, print, JSON, and RPC hosts.

### Fixed

- Tagged release retries inspect existing drafts through the release CLI instead of GitHub's published-tag endpoint, so a failed npm publication can resume without deleting release state.
- Uninstalling without `--yes` reports one concise confirmation instruction instead of a child-process stack trace.
- Cross-extension tool-name collisions keep the first owner and report both conflicting packages without crashing activation; late duplicate registration by the same extension remains an error.
- Structured secret redaction preserves shared non-cyclic object values, keeps serialized provider state synchronized with its redacted representation, and normalizes malformed Anthropic tool inputs before transport.

## [0.1.1] - 2026-07-14

### Changed

- First-party OpenAI Responses and Anthropic API-key requests use exact-pinned official SDK transports while Rigyn retains canonical mapping, streaming bounds, retry policy, OAuth transports, and normalized events.

## [0.1.0] - 2026-07-13

### Added

- Provider-neutral coding-agent loop with direct provider protocol adapters, streaming tool execution, durable sessions, branching, compaction, model selection, and usage reporting.
- Self-contained per-user installation, update, and marker-verified removal without a global npm install.
- Runtime extensions, managed packages, skills, prompts, themes, typed RPC, embedding APIs, and offline authoring examples.
- Cross-platform terminal interface with cancellation, transcript recovery, model/authentication pickers, structural tool rendering, and configurable keybindings.
- Bounded process execution, transcript replay, and extension-owned durable state.
- Release, security, contribution, platform-installation, and public-API governance for the first public preview.
- Fail-closed external tool-execution backends with explicit workspace/tool authority, bounded protocol messages, cancellation, and a reference worker.
- Host-managed child runs with exact model and backend selection, bounded usage/artifacts, concurrency and recursion limits, normalized events, and cancellation.
- Immutable trust-gated project package reconciliation, public gallery metadata, extension author validate/inspect/pack/smoke/reload/report commands, and focused protocol examples.
- Extension autocomplete/editor middleware, working-state controls, live themes, shared Agent Skills roots, redacted diagnostics, stable session export, property tests, and extension-authoring benchmarks.
- A narrow Node.js embedding facade and deterministic in-memory preset with bounded cancellation, public type/dist coverage, and focused runnable examples.

### Changed

- Adopted Rigyn as the sole public product, package, command, configuration, state, project-resource, extension-package, RPC, and schema identity.
- Released the project under the MIT License and included the license in source, package, installation, and release verification paths.
- Clean-checkout tests now rebuild generated distribution files before exercising examples that import public package entry points.
- Canonical bundled schema identifiers use stable Rigyn URNs rather than an unowned web domain.
- Runtime snapshots, resource discovery, and delegated-process results now use bounded contracts across TUI, print, JSON, RPC, and embedding hosts; interactive extension UI is shared by TUI and negotiated RPC owners, while graceful shutdown is acknowledged by TUI, RPC, and embedding owners.
- Release staging, dependency policy, packed-file verification, platform guidance, RPC documentation, troubleshooting, and compaction documentation now form one deterministic release gate.
- Provider credential resolution, package reloads, extension-requested shutdown, login prompts, and lifecycle subprocesses now propagate cancellation through their active network, process, and UI work.
- Model pickers and post-login defaults use successful live discovery as the available set, while retained or cached IDs remain usable internally without being presented as current entitlements.
- Invalid derived cross-workspace session indexes rebuild from untouched durable session history; busy, unsafe, and source-database failures remain fail-closed.
- The public RPC client can launch the packaged CLI through Node on every supported platform without depending on a shell or command shim.
- Added a new-user getting-started path and documentation map covering workspaces, providers, sessions, tools, skills, extensions, packages, data ownership, updates, and removal.
- Windows credential encryption now avoids PowerShell module discovery, keeps its child environment minimal, and completes under the original bounded timeout.
- Native image processing now loads only inside its worker, preventing Windows self-update and uninstall from locking the previous application's Sharp DLLs.
- Versioned GitHub archives can be installed directly with `npm exec`; npm publication is an explicit independently authorized release step.
- Release artifact transfer now preserves the hidden ownership marker required by every platform-verification job.
- Release metadata parsing now canonicalizes checkout line endings before cross-platform artifact verification.
- Native dependency release smoke tests now exit before temporary installations are removed, avoiding mapped-DLL cleanup failures on Windows.

### Security

- TTY credential prompts now disable terminal echo and attach their bounded input listener before rendering the prompt.
- External-process environment filtering now preserves required Windows variables and rejects unsafe additions independent of name casing.
- Runtime extensions now authenticate provider requests through an exact-origin host broker. The brokered auth API never returns provider credentials, authorization headers, cloud signing keys, or reusable secret handles; installed extension code remains trusted same-process code as documented in the threat model.
- External execution rejects missing, malformed, oversized, timed-out, or unauthorized backend results without retrying the tool locally.
- Project package fetch and activation require trust, exact immutable versions or revisions, integrity verification, disabled lifecycle scripts, atomic reconciliation, and rollback.
- Linux keychain selection now requires a functional Secret Service probe and preserves only the desktop-session environment needed by `secret-tool`; unavailable services fall back to the encrypted local store.
- Windows batch wrappers are rejected at structured command boundaries instead of passing untrusted arguments through `cmd.exe` metacharacter parsing.

### Breaking

- Pre-release installations, stored credentials, sessions, project resources, and third-party package declarations using an earlier namespace do not migrate automatically; install Rigyn fresh and reconnect the required accounts and resources.
- Removed the extractable `RuntimeExtensionApi.auth.resolve()` credential API. Provider extensions must declare their bounded request policy and call `api.auth.fetch(provider, input, init?, signal?)`; see [`docs/extensions.md`](docs/extensions.md) and [`docs/extension-auth-threat-model.md`](docs/extension-auth-threat-model.md).
