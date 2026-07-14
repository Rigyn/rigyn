# Changelog

Release-impacting changes are recorded here. The version policy and release procedure are in [`docs/releasing.md`](docs/releasing.md).

## Unreleased

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
