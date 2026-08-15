# @rigyn/kernel

`@rigyn/kernel` is rigyn's reusable execution layer. It provides the canonical runtime engine, streaming agent
protocol, tool execution, context projection, strict session-v4 journal and recovery reducer, resource helpers, and
portable execution interfaces.

The package does not own credentials, provider registration, terminal UI, permissions, MCP, or product process
orchestration. Model and stream primitives come from `@rigyn/models`.

![rigyn package dependency layers](assets/package-layers.svg)

## Runtime engine

The canonical engine is available from `@rigyn/kernel/runtime`. It owns provider turns, tool batches, steering and
follow-up delivery, compaction decisions, retry boundaries, operation identity, and lifecycle events. Product modes
adapt the same engine instead of implementing separate run loops.

Direct hosts supply provider, conversation, tool, and event ports. The `rigyn` product package supplies those ports
for interactive, one-shot print, JSON, RPC, local HTTP/SSE service, and SDK surfaces.

The exported `@rigyn/kernel/runtime/*` modules are low-level first-party package seams consumed by the `rigyn`
product. External hosts should prefer the reviewed aggregate at `@rigyn/kernel/runtime` instead of coupling to those
deeper implementation paths.

## Execution tools

The root export inventory is capability-oriented: outcome and error types, portable file/process access, tool and
agent-lifecycle contracts, message constructors and conversation conversion, resource discovery, bounded text and
shell capture, execution tools, and proxy streaming are independent modules aggregated by the package entry point.
Node filesystem/process ownership remains behind `@rigyn/kernel/node`.

Tools use TypeBox schemas and may stream bounded partial results through `onUpdate`:

```ts
import { Type } from "@rigyn/models";
import type { AgentTool } from "@rigyn/kernel";

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

`createReadTool()`, `createWriteTool()`, `createEditTool()`, and `createBashTool()` expose reusable file and shell
tools. `createExecutionTools()` returns all four. They serialize mutations to the same file, bound large output,
support image reads and atomic edits, and accept an injected `ExecutionToolContext`.

The portable read tool rejects sources above 16 MiB before decoding or image encoding. Custom environments should
honor `readBinaryFile(..., maxBytes)`; the tool checks the returned size again.

## Session journal

The `@rigyn/kernel/session-v4` entry point provides the strict journal schema, validation, reader, synchronous and
asynchronous writers, and pure recovery reducer:

```ts
import {
  SessionV4Writer,
  readSessionV4FileSync,
  reduceSessionV4Commit,
} from "@rigyn/kernel/session-v4";
```

A session has one exact header followed by LF-terminated commit records. Each commit contains an ordered, non-empty
change set. The reducer reconstructs conversation nodes, the selected head, operations, attempts, durable queues,
checkpoints, and tool-effect recovery state. Writers validate and reduce before appending, sync durable bytes before
publication, and make commit-ID retries idempotent.

Tool effects declare one recovery policy:

- `repeatable`: a verified in-doubt effect may run again;
- `reconcile`: recovery checks external state before deciding;
- `never_repeat`: recovery requires an explicit resolution.

The current runtime exposes one primary branch and one active operation per session. Immutable node identities and
branch-scoped state leave room for linked child sessions without adding another execution engine.

## Resources

The root package exports skill loading, prompt-template loading, system-prompt assembly, bounded truncation, shared
message construction and conversion, lifecycle hook contracts, and execution tools.

Prompt-template discovery reads at most 1 MiB per Markdown file, 16 MiB across one load, and 1,024 files. Sourced
loads share the same aggregate budget instead of multiplying it per source.

## Node entry point

Node-specific filesystem and process behavior is isolated behind a separate export:

```ts
import { NodeExecutionEnv } from "@rigyn/kernel/node";
```

This keeps the root package usable with another `ExecutionEnv` and makes filesystem access explicit.
On Windows, `NodeExecutionEnv` launches each command in a kernel-owned, non-breakaway Job Object so cancellation and
cleanup terminate the complete command tree even when the command shell exits first.

## Errors and cancellation

Provider responses end with `stop`, `length`, `toolUse`, `error`, or `aborted`. Use `AbortSignal` and `RunControl`
for provider and tool cancellation. Await the active `RuntimeEngine.run()` promise before disposing external resources.
