# Changelog

Release-impacting changes are recorded here. The version policy and release procedure are in [`docs/releasing.md`](docs/releasing.md).

## Unreleased

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

- Updated the exact-pinned OpenAI and Anthropic provider SDK transports to 6.48.0 and 0.112.3 after focused contract and live-provider verification.
- Runtime resources now commit or roll back as one immutable generation, extension session access passes through a workspace/branch-scoped facade, and RPC dispatch uses a typed complete method registry.
- Managed extension runtime imports now resolve only `rigyn/extensions`, `rigyn/providers`, and `rigyn/tui` through the active host, preventing a separately installed package from loading a second host instance.
- Restored the released inline transcript, composer, user-row, and picker geometry while keeping reasoning and picker help width-bounded and presenting completed tool output through compact transparent status rails without an expansion shortcut.
- Session storage now upgrades to schema 18. Schema 17 preserves indexed branch incarnations for exact cursor paging, and schema 18 atomically classifies host-owned runtime-child sessions without exporting that internal ownership marker. The migration is transactional, but a database opened by 0.2.0 cannot be reopened by 0.1.x; back up the state database first if rollback to an older release may be required.
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

- Child-run defaults and operator maxima are configurable through `childRuns`; extension per-call limits remain compatible and `/reload` applies the next validated policy without restarting the harness.
- First-time self-contained installations create a complete commented public-configuration reference, and `rigyn config show --effective` reports merged values and stable config-level defaults without exposing credentials.

### Security

- Child delegation retains compiled ceilings of 16 concurrent runs, 256 model steps, a one-hour timeout, and 8 MiB of returned text. Recursive child delegation remains permanently disabled.

## [0.1.4] - 2026-07-15

### Fixed

- Large, tool-heavy sessions resume and switch without quadratic transcript folding; retained transcript bytes are tracked incrementally and the terminal redraws the rebuilt session once.
- Runtime reloads preserve the active transcript while rebinding extension presentation, and extension package-lock waits now honor cancellation instead of blocking reload behind the full lock deadline.
- Accessibility-mode session replacement preserves visible history even when later durable events do not render transcript output.

## [0.1.3] - 2026-07-14

### Fixed

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
- Runtime snapshots, resource discovery, and child-run results now use bounded contracts across TUI, print, JSON, RPC, and embedding hosts; interactive extension UI is shared by TUI and negotiated RPC owners, while graceful shutdown is acknowledged by TUI, RPC, and embedding owners.
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
