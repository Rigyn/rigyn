# Architecture

Rigyn is a single-process application with three front ends—interactive TUI, print/JSON CLI, and newline-delimited JSON RPC—over one provider-neutral service and event store.

## Request path

```text
input
  -> CLI/TUI/RPC normalization
  -> session selection and durable input lease
  -> instructions, skills, extensions, and active tools
  -> context projection and budget check
  -> provider adapter stream
  -> text/reasoning/tool-call events
  -> conflict-aware tool execution
  -> durable results and next model turn
  -> terminal outcome and queue drain
```

Every front end calls the same `HarnessService`. This keeps session, compaction, provider, extension, and tool semantics identical in interactive and automated use.

## Runtime generation

Startup resolves platform paths and canonicalizes the workspace before loading a runtime generation:

1. global configuration;
2. saved project trust;
3. trusted project configuration;
4. network transport and proxy settings;
5. provider adapters and auth bindings;
6. installed and loose extensions;
7. skills, prompts, themes, and instruction roots;
8. tool registrations and extension listeners.

`/reload` builds and validates a candidate generation first. The service freezes its provider, tool, skill, extension, trust, compaction, retry, and child-run resources into one immutable generation and changes one pointer only after validation. A failed commit restores the previous pointer; then a successful swap disposes the old extension code and network transport. Session store identity is stable across reload, and a database-path change is rejected until restart.

## Core agent

The core loop consumes canonical messages, a provider adapter, a tool registry, and run limits. It does not know terminal widgets or provider-specific wire formats.

Each run:

- persists its start before requesting a model;
- projects provider-compatible context;
- streams normalized assistant and usage events;
- assembles fragmented tool-call JSON with stable IDs;
- validates every invocation against the tool schema;
- schedules non-conflicting tools in parallel and sequential tools as barriers;
- persists progress and results;
- continues until a terminal provider reason, cancellation, failure, or the 64-turn default `maxSteps` limit (which hosts may override explicitly).

Finish reasons and provider errors are normalized without discarding upstream request IDs or retry metadata. Retry behavior is narrow: transient failures before an unsafe partial response may retry; an authoritative context overflow may trigger one compaction retry.

## Canonical context

The canonical message model separates visible text, images, tool calls, tool results, and provider-owned opaque blocks. Projection is deterministic and non-mutating.

Tool-call/result integrity is enforced across history. Invalid historical fragments are excluded, while a pending call in the active turn remains visible to execution and recovery. Provider-only continuation state crosses a model boundary only when the provider and fingerprint remain compatible.

Instruction discovery, skill metadata, prompt expansion, image normalization, and extension context reducers all complete before the provider request. Byte and count limits bound provider inputs, persisted artifacts, process output, and returned tool observations.

## Compaction

Context budgeting uses live model metadata and normalized observed usage when valid. The planner first elides old tool output, then chooses only complete and tool-safe turn groups. A summary is source-bound by exact message IDs and stored as an event, along with file-activity continuity. Recent turns remain verbatim.

This design makes compaction resumable and auditable: a restart sees the same summary boundary, and a later compaction can receive the previous summary separately instead of summarizing a summary as ordinary chat.

## Providers and authentication

Each adapter implements the same streaming and model-catalog contracts while owning its wire serialization:

- OpenAI Responses and ChatGPT subscription transport;
- Anthropic Messages;
- Gemini Interactions and Generate Content;
- Vertex, Azure OpenAI, Bedrock, Mistral, OpenRouter, Ollama, GitHub Copilot, and compatible chat endpoints.

Adapters preserve native tool-call structure, reasoning visibility, usage, caching, and compatible continuation state. Model capabilities carry evidence and provenance rather than optimistic booleans.

Authentication is separate from adapters. A provider binding maps a provider ID to a credential ID and its legal methods. The credential broker resolves invocation, stored profile, environment, or ambient identity sources. Refresh and revocation are provider-specific but return the same credential contract. Secrets are never placed in configuration or session events.

## Tools and processes

The built-in action space is intentionally small. `read`, `write`, `edit`, and `bash` are active by default; `grep`, `find`, and `ls` are available when requested. Runtime extensions use the same tool contract.

The process runner spawns directly without a shell wrapper unless the tool itself requests the configured shell. It owns timeouts, cancellation, process-tree termination, ordered output callbacks, byte limits, and secret redaction. Large output returns a bounded tail and a path to a private local artifact. Artifact files use an owner-only directory and `0600` mode, are capped at 64 MiB each, and are pruned by age, count, and aggregate size whenever the shell tool starts. The result explicitly reports when the safety cap truncates the artifact.

File mutation coordination uses canonical physical paths so aliases of the same file cannot race. Exact edit plans are checked against the original content, and every replacement must validate before the file is written.

## Storage and recovery

SQLite stores threads, runs, immutable events, branches, artifacts, and durable queued input. Foreign keys, unique sequence numbers, and a one-active-run index encode invariants in the database rather than only in application code.

The service persists transition events around provider and tool boundaries. Recovery can therefore distinguish never-started work from work whose side effects are unknown. Unknown tool outcomes are surfaced; they are not automatically replayed.

Sessions are workspace-bound but share one indexed store by default. Service-level metadata and transcript queries, lifecycle and branch commands, durable input queues, tree and clone operations, and run/artifact inspection pass through a lazy workspace-and-branch-scoped facade before touching storage. The runner's conversation/event sink, artifact writer, and runtime-owner lease/recovery protocols retain direct store ownership because they are storage infrastructure rather than user-session access. Forks and tree navigation move branch heads without rewriting ancestry. Extension-owned state and messages are namespaced and schema-versioned within the same event graph.

## Extensions and packages

Declarative extension manifests contribute skills, prompts, commands, themes, and runtime entry points. Runtime activation is staged and deterministic. The API can register tools, commands, shortcuts, flags, providers, auth descriptors, UI renderers, events, and durable extension state.

The package manager accepts local, npm, and Git sources. It bounds downloads and extraction, validates manifests and paths, records provenance, and atomically swaps staged installs. Project packages are trust-gated. A trusted `.rigyn/packages.json` declaration resolves only through an intentional update into an immutable `.rigyn/packages.lock.json`; startup reconciliation consumes exact locked versions, revisions, and digests without following moving sources. The declarative installed set is privately staged and swapped as one recoverable transaction, with lifecycle scripts disabled and declaration filters applied deterministically.

## TUI

The terminal renderer owns an inline transcript, editor, overlay stack, pickers, status line, widgets, notifications, and structural tool/session blocks. Components render semantic roles that themes map to terminal styles.

Input decoding handles bracketed paste, wide Unicode, mouse-free navigation, queued messages, image paste, external editor handoff, and resize. Slow work is asynchronous; the editor remains responsive while model catalogs and streams update.

## Public API and RPC

The package exports its auth, configuration, context, core, embedding, extension, image, interface, mode, network, process, prompt, provider, SDK, service, storage, testing, tool, and TUI layers through explicit ESM subpaths with declarations. These are module boundaries within one package, not separately versioned packages. RPC uses one JSON object per line and exposes the same session, run, auth, model, and resource operations as the service. A typed complete method registry owns dispatch; unknown names never fall through. Durable history supports exclusive-cursor pages, and subscription replay freezes a branch-head snapshot and advances in bounded batches before handing off ordered live events. Notifications carry normalized durable or streaming events. The `rigyn/interfaces` subpath includes the exhaustive method/notification type maps and a Node.js client with request correlation, local wait cancellation, durable event-subscription helpers, and optional subprocess ownership; `rigyn/modes` adds borrowed-owner in-process adapters. [The RPC reference](rpc.md) is mechanically checked against the dispatcher contract.

The package is a Node.js 24.15+/26+ local-runtime library. None of its entry points is a browser contract, even when an entry point includes structurally portable types. Browser front ends remain separate clients and communicate with the local process through RPC or a private localhost extension bridge.

## Verification

The test suite combines focused unit tests with SQLite crash recovery, provider wire fixtures, extension reload and package transactions, TUI component tests, PTY terminal scenarios, public API compilation, built-distribution execution, and an isolated packed-artifact install. Release checks run against built JavaScript rather than only TypeScript source.

The deterministic [benchmark suite](https://github.com/Rigyn/rigyn/blob/main/benchmarks/README.md) complements correctness tests with offline outcome checks and startup/reload/resume regression guards. A separate opt-in same-task runner compares two CLIs with one model and verifier without making unsupported superiority claims. CI also enforces independent line, branch, and function floors for the five highest-risk modules rather than one misleading repository-wide percentage.
