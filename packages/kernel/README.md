# @rigyn/kernel

`@rigyn/kernel` is Rigyn's reusable agent runtime. It contains the streaming agent loop, tool execution, steering and follow-up queues, a higher-level `AgentHarness`, append-only version 3 JSONL sessions, in-memory sessions, compaction, skills, prompt templates, and a Node execution environment.

The package deliberately does not own credentials, provider registration, a terminal UI, coding tools, permissions, MCP, or process orchestration. Model and streaming primitives come from `@rigyn/models`; applications inject a `StreamFn` or `Models` instance.

## Agent

Use `Agent` when the application owns persistence and resources:

```ts
import { Agent } from "@rigyn/kernel";

const agent = new Agent({
  initialState: {
    model,
    systemPrompt: "Answer concisely.",
    tools: [readTool],
    thinkingLevel: "medium",
  },
  streamFunction,
});

const unsubscribe = agent.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await agent.prompt("Explain this module.");
unsubscribe();
```

`prompt()` rejects overlapping turns. While a turn is active, call `steer()` to affect the current run or `followUp()` to enqueue work after it. Queue modes are `"all"` and `"one-at-a-time"`. `abort()` cancels the active stream and `waitForIdle()` provides a stable shutdown boundary.

Tools use TypeBox schemas and may stream bounded partial results through `onUpdate`:

```ts
import { Type, type AgentTool } from "@rigyn/kernel";

const readTool: AgentTool = {
  name: "read",
  label: "Read",
  description: "Read a text file",
  parameters: Type.Object({ path: Type.String() }),
  async execute(_id, { path }) {
    return { content: [{ type: "text", text: await readText(path) }], details: { path } };
  },
};
```

`beforeToolCall`, `afterToolCall`, `transformContext`, and `prepareNextTurnWithContext` are the bounded interception points. A tool may request termination in its result; tool execution may be sequential or parallel.

## AgentHarness

Use `AgentHarness` when the runtime should also coordinate a session tree, resources, compaction, model state, and lifecycle hooks:

```ts
import {
  AgentHarness,
  MemorySessionStorage,
  Session,
} from "@rigyn/kernel";

const session = new Session(new MemorySessionStorage());
const harness = new AgentHarness({
  env,
  session,
  models,
  model,
  tools: [readTool],
  activeToolNames: ["read"],
});

harness.on("before_provider_request", ({ streamOptions }) => ({
  streamOptions: { ...streamOptions, cacheRetention: "short" },
}));

const response = await harness.prompt("Inspect the project.");
```

The harness provides:

- durable model, thinking-level, active-tool, label, and custom entries;
- prompt-template and skill invocation;
- current-turn steering, post-turn follow-ups, and next-turn messages;
- provider request, payload, response, tool, context, compaction, and tree hooks;
- compaction and branch navigation with optional generated summaries;
- deterministic idle, abort, save-point, and settled lifecycle events.

Mutations requested by lifecycle handlers are flushed at save points, so event listeners do not have to write into the session concurrently with the loop.

## Sessions

`Session` is storage-neutral. `MemorySessionStorage` is useful for tests and embedding. `JsonlSessionStorage` persists an append-only tree whose active leaf can move without rewriting history.

```ts
import { JsonlSessionStorage, Session } from "@rigyn/kernel";
import { NodeExecutionEnv } from "@rigyn/kernel/node";

const env = new NodeExecutionEnv({ cwd: process.cwd() });
const storage = await JsonlSessionStorage.create(env, "./sessions/thread.jsonl", {
  cwd: process.cwd(),
  sessionId: crypto.randomUUID(),
});
const session = new Session(storage);

await session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
const context = await session.buildContext();
```

Compaction and branch-summary entries become projected context messages. New harness compactions persist `retainedTail`, the materialized `AgentMessage[]` kept after the summary, so the compaction entry is a self-contained context checkpoint. Message reconstruction stops its ancestry walk at that checkpoint and projects the summary, retained tail, and later entries; state reconstruction still reads the active ancestry so the nearest model, thinking level, and active tools survive a checkpoint and reopen. Older entries that only contain `firstKeptEntryId` retain their ancestry-based behavior.

`CompactionPreparation` exposes the planned `retainedTail`, and generated `CompactionResult`/`CompactResult` values carry it through to storage. A `session_before_compact` hook may likewise return a complete retained-tail checkpoint without a `firstKeptEntryId`. Custom entry types remain inert unless the application supplies an explicit projector. Storage validates identifiers, parent relationships, headers, and the active leaf before exposing a session.

## Compaction and resources

The root export includes token estimation, compaction preparation and execution, branch-summary preparation, skill loading, prompt-template loading, and system-prompt assembly. These are independent building blocks; applications can use them without constructing `AgentHarness`.

## Node entry point

Node-specific filesystem and process behavior is isolated behind a separate export:

```ts
import { NodeExecutionEnv } from "@rigyn/kernel/node";
```

This keeps the root package usable with another `ExecutionEnv` and makes filesystem access explicit.

## Errors and cancellation

Agent streams end with `stop`, `length`, `toolUse`, `error`, or `aborted`. `AgentHarnessError` adds stable categories for invalid arguments, busy/invalid state, sessions, hooks, compaction, and branch summaries. Callers should use an `AbortSignal` for provider and tool cancellation and should await `waitForIdle()` before disposing external resources.
