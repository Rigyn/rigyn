# Maintain rigyn core, TUI, and providers

Use this reference only when the user explicitly asks to change the rigyn source repository. For ordinary customization, use [Configuration](configuration.md) or [Extensions](extensions.md).

## Establish the source contract

1. Resolve the user's target before treating any package path as editable source. Record `rigyn --version` and
   `node --version`. A real checkout must have its repository root, expected workspace files, and current revision
   available from Git; record `git rev-parse --show-toplevel`, `git rev-parse HEAD`, and `git status --short` without
   changing the worktree.
2. Treat a standalone runtime, `node_modules` package, downloaded archive, and generated `dist/` tree as read-only
   evidence. Do not edit them, fetch or clone another checkout, or assume they match a different local repository.
   If no source checkout was explicitly placed in scope, ask for its path before proposing a core change.
3. Change core only in the explicitly requested, trusted checkout. Preserve unrelated worktree changes and read the
   nearest repository `AGENTS.md` completely.
4. Read [Architecture](../../../../docs/ARCHITECTURE.md) and [Development from source](../../../../docs/development.md).
5. Read the domain guide: [Terminal UI](../../../../docs/tui.md), [Sessions](../../../../docs/sessions.md), [Compaction](../../../../docs/compaction.md), [Providers](../../../../docs/providers.md), or [Provider authoring](../../../../docs/provider-authoring.md).
6. Search the live checkout for the current implementation. Inspect its tests, public declarations, and one adjacent
   implementation instead of relying on remembered paths or behavior.
7. Define the invariant and reproduce the defect with a focused test before changing behavior.

Change source, tests, docs, resources, or generation inputs. Never edit generated `dist/` output as source.

## Locate the source

- Public direct-extension declarations live in `packages/rigyn/src/extensions/direct.ts`; activation, ownership, events, and generation cleanup live in `packages/rigyn/src/extensions/runtime.ts`; the host-managed extension config store lives in `packages/rigyn/src/extensions/config-store.ts`.
- Native and portable package discovery live in `packages/rigyn/src/core/package-manager.ts` and `packages/rigyn/src/core/portable-plugin.ts`; locked project-package transactions live in `packages/rigyn/src/extensions/project-packages.ts`; shared resource assembly lives in `packages/rigyn/src/core/resource-loader.ts`.
- Extension UI and RPC projections live in `packages/rigyn/src/tui/direct-ui.ts` and `packages/rigyn/src/interfaces/rpc-extension-ui.ts`.
- CLI and SDK composition live in `packages/rigyn/src/cli/runtime.ts` and `packages/rigyn/src/sdk/index.ts`; shared session policy lives in `packages/rigyn/src/service/agent-session.ts`.
- Start conformance work in `packages/rigyn/test/extensions/`, `packages/rigyn/test/tui/direct-ui.test.ts`, and `packages/rigyn/test/cli/runtime-direct-extensions.test.ts`. Follow imports to the narrowest adjacent test instead of editing a generated declaration.

## Preserve runtime boundaries

- Keep `AgentSession` as the shared product runtime for interactive, print, JSON, RPC, serve, SDK, and embedding composition.
- Route every tool execution through the coordinator. Preserve validation before and after extension input transformation, resource claims, cancellation, bounded output, and lifecycle events.
- Keep sessions append-only. Derived state must rebuild from the V4 journal; a failed write must not publish a new entry or leaf.
- Preserve opaque provider state byte-for-byte and expose only provider-authorized public reasoning.
- Keep credentials behind the authentication boundary and out of logs, sessions, diagnostics, tool results, and errors.
- Keep extension contracts transport-neutral. Core, interface, provider, and terminal adapters must not create a second execution engine.
- Keep file boundaries centralized and make requested isolation fail closed.

## Terminal UI changes

- Preserve one owner for the complete mutable terminal surface. Do not add ad hoc writes around the live renderer.
- Keep the transcript, composer, tool updates, visible reasoning, picker, overlays, resize, scroll, cancellation, refresh, and resume paths consistent.
- Preserve extension message renderers, entry renderers, themes, components, overlays, editor replacement, shortcuts, and generation cleanup.
- Treat every rendered string as untrusted. Strip terminal controls, clamp width and height, and test ASCII, Unicode, narrow, wide, resize, shrink-to-empty, and accessibility paths.
- Test live mutation and the completed/resumed projection separately. A successful tool may change presentation state only after its durable completion event.
- Use a real PTY for input, paste, resize, scroll, Escape, and terminal-protocol behavior. An in-memory snapshot cannot prove those paths.

## Provider and transport changes

- Keep product-integrated adapters in the rigyn provider layer and reusable protocol transports in the model package.
- Update both paths when they intentionally share a wire contract, then add conformance coverage that prevents drift.
- Keep provider selection, authentication, live discovery, offline fallback, thinking-level mapping, streaming text, public reasoning, tool calls, usage, cache accounting, cancellation, and retry semantics explicit.
- Do not add a provider identity merely because a protocol adapter exists. Keep the bundled catalog to reviewed active entries.
- Never log or persist raw requests, response bodies, authentication headers, OAuth state, secret-bearing URLs, or hidden reasoning.
- Verify the default automatic cached-WebSocket path and its safe SSE fallback independently, plus explicit SSE and strict WebSocket modes, including malformed frames, UTF-8 boundaries, idle timeout, cancellation, fallback, and continuation state.

## Sessions and compaction

- Preserve the exact recent suffix and valid tool-call/result pairs when building a compacted projection.
- Commit a summary only after generation and validation succeed. Cancellation or malformed output must leave the prior branch active.
- Keep cache accounting tied to the active request and branch. Do not infer durable history from append order alone.
- Test open, resume, fork, tree navigation, writer replacement, crash recovery, compaction, refresh, and invalid-file behavior through the same runtime used by public modes.

## Finish

Run the smallest focused test after each change. Then follow [Testing and release](testing-release.md). Update public docs and declarations whenever behavior or an exported contract changes. Build the exact runtime before asking the user to exit and relaunch the same durable session; `/refresh` reloads resources, not changed source modules. Never trigger the relaunch implicitly. Keep the implementation and prose entirely rigyn-owned.
