# Outcome benchmarks

The offline benchmark exercises the real `AgentSession`, durable JSONL session flow, built-in coding tools, and `SessionManager` recovery logic. Every report identifies its purpose as `harness-plumbing`. It does not call a model API, read credentials, evaluate prompts, or claim to measure model intelligence.

Run it from the repository root:

```sh
npm run benchmark:offline --workspace rigyn
```

The command prints one JSON document conforming to [`report.schema.json`](report.schema.json) and exits non-zero when a corpus task or probe fails. Each task reports explicit `checks` instead of implying broader capability. The deterministic corpus covers:

- create a file after a retryable pre-response transport failure;
- recover from an unsuccessful edit after confirming that the model-visible result contains an error status, root-cause summary, and safe next action;
- create two files in one non-conflicting tool batch, run their test through `bash`, and preserve unrelated files byte-for-byte;
- recover from an unknown tool name after confirming that the available-tool guidance reached the next provider request;
- continue the same durable session across two harness runs, including prior user, assistant, and tool-result context;
- compact durable multi-turn history through the normal service path;
- reopen an interrupted JSONL session, discard the incomplete trailing fragment, and preserve every prior complete entry exactly once.

The report measures outcomes instead of source size:

| Field | Meaning |
| --- | --- |
| `completionRate` | Fraction of tasks that reached a durable `run_completed` event. |
| `passAt1` | Fraction whose external verifier passed on the first complete scenario attempt. |
| `runAttempts` | End-to-end scenario attempts. The deterministic suite currently performs one per task. |
| `harnessRuns` | Actual `AgentSession.prompt()` calls; continuation scenarios may contain more than one. |
| `providerAttempts` / `providerRetries` | Provider stream attempts and safe pre-response retries. |
| `toolCalls` / `toolCallErrors` | Executed calls and error results observed before recovery. |
| `parallelToolBatches` | Assistant steps where multiple non-conflicting tool lifecycles were active together in one coordinator wave. This is an overlap signal, not a wall-clock speed claim. |
| `compactions` / `toolCallsInDoubt` | Durable safety signals observed during task runs. Probe details are reported separately. |
| `usage` | Provider-normalized tokens and USD cost. A `null` field means the provider did not make that value knowable; it is never silently treated as zero. |

Within one provider response, cumulative/final usage snapshots replace earlier snapshots and incremental events add to them. Completed response segments are then summed, so streaming telemetry is not double-counted.

The fixed scripted provider makes orchestration regressions reproducible across machines. A live-provider comparison should be a separate opt-in run with the same task/verifier contract, model identity recorded outside this deterministic report, and multiple samples; do not mix stochastic live results into the offline baseline or describe this report as model-quality evidence.

## Runtime regression guard

Run the credential-free runtime benchmark with deterministic fixtures:

```sh
npm run benchmark:runtime --workspace rigyn
```

The versioned JSON report conforms to [`runtime-performance-report.schema.json`](runtime-performance-report.schema.json). Its eleven scenarios sample cold startup with 0, 10, and 50 runtime extensions; reload one high-end fixture containing eight runtime entries and 256 commands; reopen durable sessions and project conversation context from 100 and 10,000 message events; and replay those same small and large histories through the real cursor-paged RPC subscription path. Three additional cold-page fixtures cover 20,000 events on one branch, 16,000 unrelated sibling-branch events, and 10,000 tool-progress events. Each requests one event and enforces a 16-row JavaScript materialization budget, so the benchmark deterministically rejects a return to whole-thread scanning independently of machine speed. The large RPC replay deliberately uses one event per page to catch branch-path queries whose cost grows with the complete remaining history instead of the requested cursor page. Every replay wait is bounded by its scenario ceiling, so a stalled cursor fails locally instead of consuming the outer CI timeout. Fixture creation and cleanup are outside the reported intervals.

Wall-clock results depend on the machine and are not product-quality scores. The generous per-scenario ceilings are freeze and catastrophic-regression guards, not latency promises. CI runs three samples on one Linux/Node combination; use `RIGYN_BENCHMARK_SAMPLES=1` through `10` to choose a local sample count.

## Opt-in same-task comparison

[`compare-live.example.json`](compare-live.example.json) shows the closed configuration accepted by the comparative runner. Configure exactly two CLIs with the same `{prompt}`, `{provider}`, and `{model}` placeholders, then explicitly enable the paid external run:

```sh
RIGYN_LIVE_COMPARE=1 npm run benchmark:compare --workspace rigyn -- --config ./my-comparison.json
```

Each sample receives an independent temporary copy of the same task files and the same external verifier. Commands run without a shell, with bounded output, a process-tree timeout, and inherited credentials that are never included in the report. The report conforms to [`comparative-live-report.schema.json`](comparative-live-report.schema.json) and records completion, verifier outcome, wall time, retained/output byte counts, and—when exposed by the CLI—steps, tool errors, normalized token/cache usage, and cost.

Harness and task IDs become directory names beneath that temporary root. They must start with a letter or digit and may contain only letters, digits, dots, underscores, and hyphens; path separators and parent-directory components are rejected before any files are created.

Use `rigyn-jsonl` for rigyn's `--json` event stream. A peer wrapper may emit one final JSON line using `json-summary`, with this shape:

```json
{"completed":true,"steps":3,"toolErrors":0,"usage":{"inputTokens":100,"outputTokens":20,"totalTokens":120,"cacheReadTokens":50,"cacheWriteTokens":0,"reasoningTokens":0,"costUsd":"0.01"}}
```

Use `none` when the peer exposes no structured metrics; unavailable values remain `null`, never zero. Run multiple samples before interpreting stochastic results. The runner deliberately makes no superiority claim.

## Risk-focused coverage

Run the subprocess-aware native V8 guard for the five highest-risk modules:

```sh
npm run test:coverage:risk
```

[`risk-coverage.config.json`](risk-coverage.config.json) keeps independent line, branch, and function baselines for extension activation, CLI orchestration, TUI state, service orchestration, and durable storage. Three canonical test groups measure the runtime, CLI/TUI, and service/storage targets through c8's subprocess-aware Monocart reporter. The gate reads Monocart's native V8 line, branch, and function percentages directly; it does not synthesize untouched sources or convert the results through Istanbul/LCOV. Grouping prevents intentionally isolated TypeScript loader and PTY process identities from overwriting an unrelated target's source map. The managed-package host-import fixture remains in the normal test suite and in the service/storage measurement, but is excluded exactly from the runtime group because its isolated loader deliberately creates a second identity for that module.

There is no repository-wide vanity threshold. Credentialed live tests are excluded by directory; platform-gated paths continue to run where their normal CI platform supports them. Every configured target belongs to exactly one group, prefixes must select existing tests, and exact exclusions must name an existing test inside that group. Baselines should rise with meaningful tests and should not be lowered merely to make a regression pass.

## Offline extension-authoring verifier

Run the managed-package authoring verifier without credentials or model calls:

```sh
npm run benchmark:extensions --workspace rigyn
```

Its versioned report conforms to [`extension-authoring-report.schema.json`](extension-authoring-report.schema.json). Candidate packages pass through the real managed install, public discovery, runtime activation, clean close, reload, and removal path. The corpus checks a command package, a structured-tool package that follows an intentionally invalid first attempt, and a package combining skill, prompt, theme, and runtime contributions.

`passAt1` is the fraction accepted on the first candidate. `passAt3` is the fraction accepted within three candidates. This deterministic suite measures the verifier and recovery workflow, not an agent's ability to write code. Use the opt-in dogfood run below for stochastic model authoring quality.

## Opt-in coding-agent dogfood

The live dogfood suite uses the real `AgentSession` runtime, built-in coding tools, current configured provider credentials, extension loader, and managed package lifecycle. It is disabled during normal tests and makes no model calls unless the explicit gate is set:

```sh
RIGYN_LIVE_DOGFOOD=1 npm run test:dogfood --workspace rigyn
```

The default provider is `openai`. Select another connected provider or require one exact live-discovered model without placing credentials on the command line:

```sh
RIGYN_LIVE_DOGFOOD=1 \
RIGYN_LIVE_PROVIDER=anthropic \
RIGYN_LIVE_MODEL=claude-sonnet-4-6 \
npm run test:dogfood --workspace rigyn
```

This is a paid, stochastic evaluation. It repairs an isolated broken repository and independently runs its tests, then asks the agent to use the bundled `build-extension` skill and documentation to author a new structured-tool package. The verifier—not the model—installs that package under a temporary managed root, discovers and activates it, invokes its structured tool, closes and reloads the host, invokes it again, and removes the install.

Each model run has a six-minute wall limit, a fixed model-turn limit (16 for repair and 28 for authoring), at most 2,048 output tokens per turn, and a 64K context ceiling. The suite cancels after a shared provider-reported cost above USD 2; when a provider does not report normalized cost, the wall, turn, context, and output bounds still apply. Diagnostics contain only provider/model identity, finish state, tool names, warning codes, normalized usage totals, and reported cost—never credential material or raw provider payloads. Workspaces, sessions, package installs, extension hosts, and verification subprocesses are temporary and cleaned up on success or failure.
