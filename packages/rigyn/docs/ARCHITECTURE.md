# Architecture

rigyn is a single-process application with three front ends—interactive TUI, print/JSON CLI, and newline-delimited JSON RPC—over one provider-neutral `AgentSession` and append-only session manager.

## Request path

```text
input
  -> CLI/TUI/RPC normalization
  -> session selection and active JSONL branch
  -> instructions, skills, extensions, and active tools
  -> context projection and budget check
  -> provider adapter stream
  -> text/reasoning/tool-call events
  -> conflict-aware tool execution
  -> appended results and next model turn
  -> terminal outcome and queue drain
```

Every front end binds the same `AgentSession`. This keeps session, compaction, provider, extension, and tool semantics identical in interactive and automated use.

## Runtime generation

Startup resolves platform paths and canonicalizes the workspace before loading a runtime generation:

1. global configuration;
2. saved project trust;
3. trusted project configuration;
4. network transport and proxy settings;
5. provider adapters and auth bindings;
6. installed and loose extensions;
7. skills, prompts, custom themes, and instruction roots;
8. tool registrations and extension listeners.

`/reload` first emits `session_shutdown` to the active generation, then builds and validates its replacement. The resource pointer changes only after preparation succeeds, and the prior generation is then disposed. A failed replacement is disposed and the previous generation receives `session_start` again. The `SessionManager` object and active JSONL file remain stable across a resource-only reload.

## Core agent

The core loop consumes canonical messages, a provider adapter, a tool registry, and run limits. It does not know terminal widgets or provider-specific wire formats.

Each run:

- appends user input before requesting a model;
- projects provider-compatible context;
- streams normalized assistant and usage events;
- assembles fragmented tool-call JSON with stable IDs;
- validates every invocation against the tool schema;
- schedules non-conflicting tools in parallel and sequential tools as barriers;
- appends assistant messages, tool progress, and results;
- continues until a terminal provider reason, cancellation, failure, or an explicitly configured `maxSteps` limit.

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

The built-in action space is intentionally small. `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` are active by default across the CLI, RPC, and direct SDK. Runtime extensions use the same tool contract.

The process runner spawns directly without a shell wrapper unless the tool itself requests the configured shell. It owns timeouts, cancellation, process-tree termination, ordered output callbacks, byte limits, and secret redaction. Large output returns a bounded tail and a path to a private local artifact. Artifact files use an owner-only directory and `0600` mode, are capped at 64 MiB each, and are pruned by age, count, and aggregate size whenever the shell tool starts. The result explicitly reports when the safety cap truncates the artifact.

File mutation coordination uses canonical physical paths so aliases of the same file cannot race. Exact edit plans are checked against the original content, and every replacement must validate before the file is written.

## Storage and recovery

Each durable session is one version 3 JSONL file beneath the configured session directory. The header records session identity and workspace; every later entry has an ID, parent ID, timestamp, and typed payload. Parent links form the session tree. Forks and tree navigation select or copy reachable ancestry without rewriting old entries.

Complete lines are the crash boundary. An unterminated final fragment is ignored on read and removed before the next append; a valid final record missing only its newline is preserved. Malformed newline-terminated JSON stops the read with a file-and-line diagnostic and is never repaired implicitly. Directory scans use bounded concurrency, deterministic path tie-breaking, and explicit pagination cursors. The file contains conversation history, model/thinking changes, compactions, branch summaries, labels, and extension-owned entries/messages. There is no SQLite store, schema index, lease table, or durable multi-process run queue; session doctor reports invalid JSONL files without rebuilding an index.

## Extensions and packages

Package metadata contributes direct factory files, skills, prompts, and custom themes. Runtime activation is staged and deterministic. Direct factories can register tools, commands, shortcuts, flags, providers, UI renderers, events, and durable extension state.

The package manager accepts local, npm, and Git sources. It bounds downloads and extraction, validates manifests and paths, records provenance, and atomically swaps staged installs. Project packages are trust-gated. A trusted `.rigyn/packages.json` declaration resolves only through an intentional update into an immutable `.rigyn/packages.lock.json`; startup reconciliation consumes exact locked versions, revisions, and digests without following moving sources. The declarative installed set is privately staged and swapped as one recoverable transaction, with lifecycle scripts disabled and declaration filters applied deterministically.

## TUI

The terminal renderer owns an inline transcript, editor, overlay stack, pickers, status line, widgets, notifications, and structural tool/session blocks. Components render semantic roles through the built-in `mono` or operational `signal` palette, or a selected discovered custom theme.

Input decoding handles bracketed paste, wide Unicode, mouse-free navigation, queued messages, image paste, external editor handoff, and resize. Slow work is asynchronous; the editor remains responsive while model catalogs and streams update.

## Public API and RPC

The repository is organized as independently testable models, kernel, terminal, and product-runtime packages. The user-facing `rigyn` package owns CLI, session, extension, and product integration while lower packages remain reusable. RPC uses one JSON object per line, typed method dispatch, correlated requests, cancellation, and ordered event notifications. [The RPC reference](rpc.md) describes the public protocol.

The package is a Node.js 24.15+/26+ local-runtime library. None of its entry points is a browser contract, even when an entry point includes structurally portable types. Browser front ends remain separate clients and communicate with the local process through RPC or a private localhost extension bridge.

## Verification

The test suite combines focused unit tests with JSONL recovery and migration fixtures, provider wire fixtures, extension reload and package transactions, TUI component tests, PTY terminal scenarios, public API compilation, built-distribution execution, and isolated packed-artifact installation. Release checks run against built JavaScript rather than only TypeScript source.

The deterministic [benchmark suite](https://github.com/rigyn/rigyn/blob/main/packages/rigyn/benchmarks/README.md) complements correctness tests with offline outcome checks and startup/reload/resume regression guards. A separate opt-in same-task runner compares two CLIs with one model and verifier without making unsupported superiority claims. CI also enforces independent line, branch, and function floors for the five highest-risk modules rather than one misleading repository-wide percentage.
