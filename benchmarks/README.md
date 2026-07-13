# Outcome benchmarks

The offline benchmark exercises the real `HarnessService`, durable event stream, built-in coding tools, and `SessionStore` recovery logic. Every report identifies its purpose as `harness-plumbing`. It does not call a model API, read credentials, evaluate prompts, or claim to measure model intelligence.

Run it from a source checkout:

```sh
npm run benchmark:offline
```

The command prints one JSON document conforming to [`report.schema.json`](report.schema.json) and exits non-zero when a corpus task or probe fails. Each task reports explicit `checks` instead of implying broader capability. The deterministic corpus covers:

- create a file after a retryable pre-response transport failure;
- recover from an unsuccessful edit after confirming that the model-visible result contains an error status, root-cause summary, and safe next action;
- create two files in one non-conflicting tool batch, run their test through `bash`, and preserve unrelated files byte-for-byte;
- recover from an unknown tool name after confirming that the available-tool guidance reached the next provider request;
- continue the same durable session across two harness runs, including prior user, assistant, and tool-result context;
- compact durable multi-turn history through the normal service path;
- reopen an interrupted SQLite run and confirm an already-started tool is marked in doubt instead of replayed.

The report measures outcomes instead of source size:

| Field | Meaning |
| --- | --- |
| `completionRate` | Fraction of tasks that reached a durable `run_completed` event. |
| `passAt1` | Fraction whose external verifier passed on the first complete scenario attempt. |
| `runAttempts` | End-to-end scenario attempts. The deterministic suite currently performs one per task. |
| `harnessRuns` | Actual `HarnessService.run()` calls; continuation scenarios may contain more than one. |
| `providerAttempts` / `providerRetries` | Provider stream attempts and safe pre-response retries. |
| `toolCalls` / `toolCallErrors` | Executed calls and error results observed before recovery. |
| `parallelToolBatches` | Assistant steps where multiple non-conflicting tool lifecycles were active together in one coordinator wave. This is an overlap signal, not a wall-clock speed claim. |
| `compactions` / `toolCallsInDoubt` | Durable safety signals observed during task runs. Probe details are reported separately. |
| `usage` | Provider-normalized tokens and USD cost. A `null` field means the provider did not make that value knowable; it is never silently treated as zero. |

Within one provider response, cumulative/final usage snapshots replace earlier snapshots and incremental events add to them. Completed response segments are then summed, so streaming telemetry is not double-counted.

The fixed scripted provider makes orchestration regressions reproducible across machines. A live-provider comparison should be a separate opt-in run with the same task/verifier contract, model identity recorded outside this deterministic report, and multiple samples; do not mix stochastic live results into the offline baseline or describe this report as model-quality evidence.

## Offline extension-authoring verifier

Run the managed-package authoring verifier without credentials or model calls:

```sh
npm run benchmark:extensions
```

Its versioned report conforms to [`extension-authoring-report.schema.json`](extension-authoring-report.schema.json). Candidate packages pass through the real managed install, public discovery, runtime activation, clean close, reload, and removal path. The corpus checks a command package, a structured-tool package that follows an intentionally invalid first attempt, and a package combining skill, prompt, theme, and runtime contributions.

`passAt1` is the fraction accepted on the first candidate. `passAt3` is the fraction accepted within three candidates. This deterministic suite measures the verifier and recovery workflow, not an agent's ability to write code. Use the opt-in dogfood run below for stochastic model authoring quality.

## Opt-in coding-agent dogfood

The live dogfood suite uses the real `HarnessService`, built-in coding tools, current configured provider credentials, extension loader, and managed package lifecycle. It is disabled during normal tests and makes no model calls unless the explicit gate is set:

```sh
RIGYN_LIVE_DOGFOOD=1 npm run test:dogfood
```

The default provider is `openai`. Select another connected provider or require one exact live-discovered model without placing credentials on the command line:

```sh
RIGYN_LIVE_DOGFOOD=1 \
RIGYN_LIVE_PROVIDER=anthropic \
RIGYN_LIVE_MODEL=claude-sonnet-4-6 \
npm run test:dogfood
```

This is a paid, stochastic evaluation. It repairs an isolated broken repository and independently runs its tests, then asks the agent to use the bundled `build-extension` skill and documentation to author a new structured-tool package. The verifier—not the model—installs that package under a temporary managed root, discovers and activates it, invokes its structured tool, closes and reloads the host, invokes it again, and removes the install.

Each model run has a six-minute wall limit, a fixed model-turn limit (16 for repair and 28 for authoring), at most 2,048 output tokens per turn, and a 64K context ceiling. The suite cancels after a shared provider-reported cost above USD 2; when a provider does not report normalized cost, the wall, turn, context, and output bounds still apply. Diagnostics contain only provider/model identity, finish state, tool names, warning codes, normalized usage totals, and reported cost—never credential material or raw provider payloads. Workspaces, sessions, package installs, extension hosts, and verification subprocesses are temporary and cleaned up on success or failure.
