# SDK

`rigyn/sdk` creates one directly composed `AgentSession`. It uses the same JSONL session manager, resource loader, provider/model runtime, tools, extensions, settings, compaction, and retry behavior as the command-line application.

```ts
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "rigyn/sdk";

declare const modelRuntime: ModelRuntime;

const { session, extensionsResult, modelFallbackMessage } = await createAgentSession({
  cwd: process.cwd(),
  modelRuntime,
  sessionManager: SessionManager.inMemory(process.cwd()),
});

if (modelFallbackMessage) console.error(modelFallbackMessage);

const unsubscribe = session.subscribe((event) => {
  if (event.type === "text_delta") process.stdout.write(event.text);
});

await session.prompt("Inspect this workspace.");
unsubscribe();
await session.close();
```

## `createAgentSession()`

The factory accepts:

- `cwd` and `agentDir`
- `modelRuntime`, `model`, `thinkingLevel`, and `scopedModels`
- `noTools`, `tools`, `excludeTools`, and `customTools`
- `resourceLoader`, `sessionManager`, and `settingsManager`
- `sessionStartEvent` metadata for extension startup

When no `resourceLoader` is supplied, the factory creates a `DefaultResourceLoader` and reloads it once. A caller-supplied loader must already be loaded; the factory consumes it without reloading or replacing it.

The default active built-ins are `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`. Custom and extension tools remain available by default. An explicit `tools` list is an allowlist, and `excludeTools` applies afterward. `noTools: "all"` starts without tools; `noTools: "builtin"` suppresses the default built-ins while retaining custom and extension tools.

The return value is:

```ts
interface CreateAgentSessionResult {
  session: AgentSession;
  extensionsResult: LoadExtensionsResult;
  modelFallbackMessage?: string;
}
```

`LoadExtensionsResult` is the SDK's exported alias for `ResourceExtensionsResult`. It contains the loaded `Extension[]`, path/error diagnostics, and the active `ExtensionRuntime`.

The session owns the default resources created for it. `close()` aborts active work, flushes settings, emits extension shutdown lifecycle events, and releases those resources. Closing is idempotent.

## Sessions and events

Use `SessionManager.inMemory(cwd)` for tests, `SessionManager.create(cwd)` for a new persistent JSONL session, `SessionManager.open(path)` for a specific file, and the list/continue helpers for saved sessions. The manager stores an append-only tree and supports branching, labels, compaction entries, model changes, and thinking-level changes.

`session.sessionManager` is the active mutable manager. Direct hosts can append entries or update the tree through it; extension contexts receive a read-only projection of the active JSONL session.

`session.subscribe(listener)` emits direct lifecycle, message-stream, and tool-execution events after extension reducers have settled. It returns an unsubscribe function. `session.state` is a snapshot with the selected model, thinking level, system prompt, durable messages, active tools, `isStreaming`, the current `streamingMessage`, pending tool-call IDs, and the latest assistant `errorMessage`. Its message and set values are cloned so consumers cannot mutate live state accidentally.

Compaction and branch-summary backoff are visible through three public events. `summarization_retry_scheduled` carries the one-based retry number, configured retry count, delay, and bounded error message. `summarization_retry_attempt_start` identifies the summarizer; its `compaction` form also carries the compaction reason. `summarization_retry_finished` closes retry activity after at least one delay was scheduled. These events describe transient summary-generation retries; protocol failures and failures after response content has started are not replayed.

`session.agent` is the mutable low-level agent contract backed by the session engine. Assigning `state.model`, `state.messages`, `state.tools`, `state.systemPrompt`, or `state.thinkingLevel` changes later model turns; `reset()` clears conversation and queues without changing the provider session ID. The stream, API-key, payload/response, context-conversion, tool-call/result, and prepare-next-turn hooks run at their corresponding provider or tool boundaries. Transport, thinking budgets, retry delay, global tool execution mode, and provider `sessionId` are forwarded into each run.

`agent.subscribe()` emits the low-level `AgentEvent` sequence, including prompt and assistant message events. Use `session.subscribe()` for the broader coding-session lifecycle such as compaction, retry, queue, session-entry, and settings events. A `prepareNextTurn` context may replace messages, the system prompt, or the complete tool set; a new tool registry is installed atomically after the completed tool batch and before the next provider request.

`session.modelRuntime` is the public asynchronous `ModelRuntime` used by the session. When the factory receives a `ModelRuntime`, the property preserves that exact object. It exposes model snapshots and asynchronous availability refresh, authentication/login/logout, configuration reload, and `stream()`/`streamSimple()` rather than the internal synchronous registry.

`continue()` resumes from an existing non-assistant history tail without appending an empty user message. `steer()` and `followUp()` return promises and expand prompt templates before queueing. The direct session also exposes prompting, abort, model/thinking selection, active-tool selection, compaction, bash execution, tree navigation, statistics, and HTML export.

## Custom resources

Create and reload a `DefaultResourceLoader` before passing it when you need explicit extension, skill, prompt-template, theme, or context-file paths:

```ts
import { createAgentSession, DefaultResourceLoader, SettingsManager } from "rigyn/sdk";

const cwd = process.cwd();
const agentDir = "/custom/agent";
const settingsManager = SettingsManager.inMemory();
const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  additionalExtensionPaths: ["./extension.ts"],
});
await resourceLoader.reload();

const { session } = await createAgentSession({
  cwd,
  agentDir,
  settingsManager,
  resourceLoader,
});
```

For session replacement (`new`, resume, fork, clone), use `AgentSessionRuntime`. It recreates cwd-bound services and rebinds the active session rather than mutating a stale session object in place.

## Direct settings management

`SettingsManager` reads strict, sparse JSON from two scopes:

1. `<agentDir>/settings.json` for global settings;
2. `<cwd>/.rigyn/settings.json` for trusted-project settings.

Project values override global values. Arrays and scalar values replace the earlier scope; settings objects such as `terminal`, `images`, `retry`, `compaction`, and `branchSummary` merge their immediate keys. An untrusted project is not read and cannot be written. Calling `setProjectTrusted(true)` loads its settings, while changing it back to `false` removes project values from the effective view.

Files contain only explicit choices. Missing files stay missing during reads, and getters supply runtime defaults without materializing a complete configuration. Comments are not accepted. A malformed file is left untouched, its last valid in-memory scope remains active across `reload()`, and the error is available through `drainErrors()`.

```ts
import { SettingsManager } from "rigyn/sdk";

const settings = SettingsManager.create(process.cwd(), "/custom/agent", {
  projectTrusted: true,
});

settings.setDefaultModelAndProvider("provider-id", "model-id");
settings.setDefaultThinkingLevel("high");
settings.setShowImages(false);

// Setters change the effective in-memory value immediately and queue a write.
await settings.flush();

for (const problem of settings.drainErrors()) {
  console.error(`${problem.scope}: ${problem.error.message}`);
}
```

Queued writes lock and re-read the selected file before merging. Fields changed externally are preserved unless the same setter changed that field. Nested setters update only their named child key, so changing `terminal.showImages`, for example, does not overwrite an externally edited `terminal.imageWidthCells`.

`applyOverrides()` adds an invocation-only layer above the file scopes. It changes neither file and is discarded by `reload()`. Use `SettingsManager.inMemory(initial)` for tests or ephemeral hosts and `SettingsManager.fromStorage(storage)` for a custom locked storage implementation.

The public accessors cover:

- model selection, thinking level, transport, steering, and follow-up modes;
- compaction, branch-summary, retry, HTTP-idle, and WebSocket-connect settings;
- theme, reasoning visibility, cache notices, editor, shell, startup, tree, padding, cursor, terminal, Markdown, image, and warning preferences;
- package, extension, skill, prompt-template, and theme resource paths, including project-scoped setters;
- local changelog display, session directory, enabled-model patterns, npm command argv, proxy, and project-trust policy.

The manager never stores API keys, OAuth tokens, or other provider credentials.
