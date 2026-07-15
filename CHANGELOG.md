# Changelog

Release-impacting changes are recorded here. The version policy and release procedure are in [`docs/releasing.md`](docs/releasing.md).

## Unreleased

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
