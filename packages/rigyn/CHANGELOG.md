# Changelog

## Unreleased

## [0.1.0] - 2026-08-15

First public release of rigyn.

### Added

- Kimi Code is a first-class provider with its current four maintained coding
  models, membership API-key authentication, device account login, schema
  normalization, session affinity, and visible streamed reasoning.
- Native account login is available for ChatGPT/Codex, Anthropic, GitHub
  Copilot, Kimi Code, xAI, and OpenRouter. Login discovery is aligned across
  TUI, print, JSON, RPC, serve, SDK, and embedding hosts, and the public models
  API can represent provider-account credential acquisition directly.
- The reasoning control contract is limited to provider-accepted levels through
  `max`. Standalone Bedrock transports preserve signed and redacted
  continuation state while exposing only provider-approved reasoning summaries.

- Interactive, print, JSON, RPC, loopback serve, SDK, and embedding hosts share
  one agent runtime and one generation-owned extension harness.
- V4 session journals preserve operations, queued steer and follow-up messages,
  tool effects, branches, checkpoints, compaction state, and crash recovery.
  Active-run submissions appear immediately and reconcile once with their
  durable queue records.
- The terminal provides one rich viewport for streaming text, public reasoning,
  the seven built-in tools, extension surfaces, compaction receipts, and a
  compact status dock. Scroll anchors and gutter backgrounds keep filled rows
  aligned, and transient run notices do not displace durable transcript rows.
  The hardware cursor is visible by default, with explicit setting and
  environment opt-outs. Thinking is visible by default, and `Ctrl+T` toggles
  live and completed thinking visibility. A successful transcript selection
  copy clears its highlight and shows a short-lived popup; a failed copy keeps
  the selection visible and reports a warning. Up/Down navigation wraps through
  slash commands, and model or reasoning changes made during a response apply
  atomically to the next accepted operation, including a queued follow-up,
  without relabeling the request already in flight. Overlapping model choices
  are generation-owned so only the latest selection can publish, persist, or
  notify. Built-in slash commands respond during an active turn: run-safe
  commands execute directly,
  while session-changing commands cancel and recover the exact local operation
  before executing. Tree browsing cancels only after a target is selected, and
  sessions blocked by an uncertain tool effect still open or resume before
  configured model selection so explicit recovery remains reachable. The
  bare `/recover` retries safe recovery before abandoning any remaining blocked
  effects without replay. Print and JSON replacement sessions recover before
  their next prompt, while public SDK factories preserve the interrupted
  model and thinking selection and defer a differing request until explicit
  recovery succeeds.
- Running Write cards offer `Ctrl+O` when earlier bounded source is retained
  and expand immediately to their retained head and tail. Running Edit cards
  remain header-only while collapsed and expose only complete bounded
  replacement previews when expanded. Completed Write cards show the first
  three retained source rows and offer `Ctrl+O` when additional bounded source
  is available. Read, Bash, Grep, Find, ls, Edit, extension, startup, skill,
  summary, and Markdown views apply honest retained-detail bounds before
  terminal wrapping. Collapsed tool cards keep one expansion affordance as
  their final detail row.
- Buffered provider streams yield by event count and elapsed processing time,
  while paced redraws keep scrolling, steering, queue visibility, and turn
  cancellation responsive.
- Output-aware compaction preserves recent complete turns and tool pairs. A
  final provider projection that exceeds its budget after system and extension
  processing receives one bounded automatic compaction and same-step
  reprojection before a closed failure.
- Built-in tools share one coordinator for schema validation, interception,
  authorization, resource scheduling, cancellation, recovery, observability,
  bounded result projection, and all-results termination semantics.
- Trusted extensions can define tools, providers, commands, flags, shortcuts,
  renderers, themes, skills, prompt templates, lifecycle hooks, shared events,
  managed processes, resource discovery, and rich UI components through public
  package exports.
- Extension activation is transactional: candidate listeners, shared-event
  emissions, tools, UI ownership, processes, and disposers remain private until
  commit. Rollback publishes nothing; successful publication is deterministic;
  refresh and shutdown dispose only the owning generation.
- Extension JSON boundaries use detached, descriptor-safe, pre-bounded
  snapshots. Proxies, accessors, custom prototypes, cycles, sparse arrays,
  inherited serializers, and structurally oversized graphs fail without
  executing owner-controlled code. Live local and supplied-bus payloads use the
  same boundary, including arbitrary bounded topics such as `error`.
- Direct and SDK tool guards support exact plain-data allow or block decisions,
  bounded reasons, and a blocked-result termination hint. Session switch and
  fork guards fail closed on malformed decisions; tree and compaction reducers
  isolate malformed transforms and continue with later valid listeners.
- Public provider extensions receive bounded request, tool-schema, stream,
  continuation-state, diagnostics, usage, and terminal-content adapters in both
  translation directions. Protocol lifecycle, indexes, cardinality, field
  sizes, tool arguments, and terminal reconciliation are validated before use.
- Rich TUI ownership is source- and generation-specific. Print, JSON, and serve
  expose headless UI fallbacks; RPC exposes its documented structural dialog
  and presentation bridge; SDK and embedding hosts retain the same session,
  command, recovery, and authorization lifecycle without terminal-only APIs.
- Ordered model-cycle scopes and per-model thinking selections are shared by
  rich and accessible TUI, RPC, SDK, and direct sessions. An explicit disabled
  scope and a configured scope with no usable models remain disabled instead
  of widening to the full catalog; live catalog changes are reprojected before
  the scope is observed or cycled. RPC set/cycle controls preserve invocation
  order even when model discovery overlaps.
- Reviewed model metadata keeps total context, generated-output, and published
  input ceilings as independent values. Live discovery is authoritative, while
  dynamic or unpublished limits remain unknown instead of being inferred.
  Missing or malformed context metadata uses a conservative 128,000-token
  execution budget without fabricating catalog metadata.
- Effective output ceilings apply to ordinary turns, compaction, and branch
  summaries. Chat Completions routes use each service's documented output-limit
  field, and model switches do not carry an absent output limit forward.
- Twelve built-in provider identities support API-key and subscription sign-in,
  live model discovery, reasoning levels, retry policy, SSE streaming, and
  explicit transport controls.
- OpenCode Go has an independent provider and stored credential identity,
  `OPENCODE_GO_API_KEY` followed by the documented shared environment fallback,
  authenticated availability filtering, reviewed model limits, and explicit
  per-model Responses, Messages, or Chat Completions routing. Its Kimi Chat
  routes supply Moonshot-required property types on a detached tool-schema wire
  copy, so valid enum-only extension schemas remain usable without changing
  non-Kimi requests.
- OpenAI Codex `auto` transport starts with a cached WebSocket, falls back to
  full-context HTTPS/SSE after eligible pre-output transport failures, and
  keeps the session, endpoint, and account identity on SSE after a successful
  fallback or a semantic-boundary failure, with at most 1,024 recent identities
  retained for the adapter lifetime. Failures already classified as
  authentication errors and provider-declared response failures are not replayed
  across transports;
  an SSE fallback that fails before a successful terminal does not pin the
  identity.
  Valid empty lifecycle placeholders remain replay-safe; visible text or
  summary reasoning, hidden provider reasoning, tool drafts, and malformed,
  unknown, or opaque state are not replayed. HTTP body disconnects receive one
  retry only before semantic output. The configured HTTP response-idle limit
  also governs Codex WebSocket response messages. Explicit SSE and strict
  WebSocket modes remain available.
- Local Codex transport diagnostics expose only transport choice, cached-socket
  reuse, fallback state, bounded failure class and output boundary, partial-output
  state, a validated numeric close code, and an allowlisted native transport
  code when available; request content, credentials, URLs, headers, bodies,
  close reasons, and session IDs stay excluded.
- Stored credentials use Linux Secret Service, macOS Keychain Services, or a
  Windows DPAPI-protected envelope with fail-closed backend pinning. OAuth
  library consumers can inject their own store, while the interactive product
  uses the platform-backed credential broker and bounded cross-process locks.
- Global and trusted-project configuration share one versioned schema. Trusted
  extensions receive bounded compare-and-swap configuration and
  generation-owned processes; `/refresh` applies resource changes to the
  current session.
- Local metadata-only logs, metrics, crash reports, and diagnostic bundles are
  bounded, private, redacted, and separate from V4 session content. `rigyn
  stats` summarizes aggregate snapshots without opening session history.
- Ready-made terminal, interactive, print, and RPC surfaces redact registered
  secrets from human diagnostics and structured dispatcher failures without
  changing their public severity, event, command, identifier, or response
  fields.
- Extension package archives and HTML or JSONL session exports create complete
  private files exclusively and refuse existing paths, links, or partial
  publication. Bare `npm:file:` archives retain a validated source-to-package
  identity, recover compatible pre-receipt installs, and remain discoverable
  when multiple archives are configured. Conflicting sources that declare one
  package name fail before replacement. Standalone HTML keeps embedded and
  downloadable V4 payloads byte-exact and does not load external image
  references.
- Static Bash, Zsh, and Fish completions derive from the CLI command catalog
  without starting the runtime. The `rigyn-dev` skill documents configuration,
  extensions, internals, testing, and release operation.
- Release artifacts include four npm-compatible package archives, six locked
  standalone runtimes, a source archive, checksums, an SPDX SBOM, attestations,
  and verified install, update, and uninstall scripts. Production dependency
  graphs and installed bytes are checked independently on every target.

- The maintained catalog contains 145 current models across 12 built-in
  providers. Provider-owned protocol, context, output, pricing, modality,
  caching, and reasoning evidence is kept distinct from unknown capabilities.
- Compaction removes only stale pre-compaction local errors, retains errors
  emitted while the summary is running, and reports unavailable cache-read
  telemetry without inventing a zero value. Final system and extension context
  rewrites retain a valid provider usage baseline without crediting removed
  messages toward new content. The TUI keeps prompt `in`, generated `out`, and
  context occupancy concise without qualifier or compaction-policy glyphs.
  `last cache` reflects the newest completed non-summary model request:
  explicit cold zero stays `0.0%`, omitted telemetry is `n/a`, and exact and
  reported aggregate counters remain available through the session interfaces.

- OAuth menus expose only usable authentication paths. Direct and compatibility
  provider registries expose the same usable methods, and login cancellation
  cannot persist a late credential.
- Automatic tool reconciliation durably claims an external recovery attempt
  before invoking it, validates bounded results before settlement, and cannot
  replay a reconciler after process death. Manual SDK recovery applies the same
  tool-result bounds.
- Failed or pre-aborted extension refresh generations are quarantined instead
  of remaining partially active, and HTTP serve prompt admission is bounded,
  FIFO, cancellable, and drained during shutdown.
- Completed nonzero, timeout, signal, and cancellation Bash outcomes retain
  their exit state, output bounds, and spill artifact metadata through session
  events, journaling, SDK calls, and RPC.
- Sparse live model catalogs remain usable in memory without being serialized
  into an invalid persistent cache.

- Built-in refresh, revocation, and GitHub Copilot enterprise-host routing pin
  trusted endpoints and client metadata instead of trusting mutable stored
  credential fields. Authentication-state errors pass through secret
  redaction.
- Provider-private Responses reasoning text stays out of public events while
  explicit summaries and provider-documented public reasoning from Kimi,
  DeepSeek, xAI, and Ollama remain visible and replayable.
