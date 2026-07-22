import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Type } from "typebox";
import {
  Agent,
  JsonlSessionStorage,
  Session,
  SessionError,
  agentLoop,
  createAssistantEventStream,
  executeShellWithCapture,
  findCutPoint,
  formatPromptTemplateInvocation,
  formatSkillsForSystemPrompt,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type ExecutionEnv,
  type Model,
  type Result,
  type SessionTreeEntry,
  type ShellExecOptions,
} from "../../src/index.js";
import { NodeExecutionEnv } from "../../src/node.js";

const model: Model = {
  id: "boundary-model",
  name: "Boundary Model",
  api: "boundary",
  provider: "boundary",
  baseUrl: "http://localhost.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_096,
};

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason,
    timestamp: Date.now(),
    usage,
  };
}

function streamOf(value: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantEventStream();
  queueMicrotask(() => stream.push(
    value.stopReason === "error" || value.stopReason === "aborted"
      ? { type: "error", reason: value.stopReason, error: value }
      : { type: "done", reason: value.stopReason, message: value },
  ));
  return stream;
}

function text(message: AgentMessage): string {
  if (message.role !== "user") return "";
  return typeof message.content === "string"
    ? message.content
    : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function temp(t: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("steering drains before follow-ups and both preserve FIFO order", async () => {
  const steering = [
    { role: "user" as const, content: "steer-one", timestamp: 2 },
    { role: "user" as const, content: "steer-two", timestamp: 3 },
  ];
  const followUps = [
    { role: "user" as const, content: "follow-one", timestamp: 4 },
    { role: "user" as const, content: "follow-two", timestamp: 5 },
  ];
  const requests: string[][] = [];
  let steeringReads = 0;
  const loop = agentLoop(
    [{ role: "user", content: "start", timestamp: 1 }],
    { messages: [] },
    {
      model,
      convertToLlm: (messages) => messages.filter((message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult"),
      getSteeringMessages: async () => steeringReads++ === 0 ? [] : steering.splice(0, 1),
      getFollowUpMessages: async () => followUps.splice(0, 1),
    },
    undefined,
    (_activeModel, context) => {
      requests.push(context.messages.filter((message): message is Extract<AgentMessage, { role: "user" }> => message.role === "user").map(text));
      return streamOf(assistant([{ type: "text", text: "ok" }]));
    },
  );

  for await (const _event of loop) {}

  assert.deepEqual(requests, [
    ["start"],
    ["start", "steer-one"],
    ["start", "steer-one", "steer-two"],
    ["start", "steer-one", "steer-two", "follow-one"],
    ["start", "steer-one", "steer-two", "follow-one", "follow-two"],
  ]);
});

test("an aborted sequential tool batch does not start later tools", async () => {
  const schema = Type.Object({});
  const entered = deferred();
  let secondStarted = false;
  const first: AgentTool<typeof schema> = {
    name: "first",
    label: "First",
    description: "Wait for cancellation",
    parameters: schema,
    async execute(_id, _args, signal) {
      entered.resolve();
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("cancelled");
    },
  };
  const second: AgentTool<typeof schema> = {
    name: "second",
    label: "Second",
    description: "Must not start",
    parameters: schema,
    async execute() {
      secondStarted = true;
      return { content: [], details: {} };
    },
  };
  let requests = 0;
  const agent = new Agent({
    initialState: { model, tools: [first, second] },
    toolExecution: "sequential",
    streamFunction: (_activeModel, _context, options) => {
      requests += 1;
      if (requests === 1) return streamOf(assistant([
        { type: "toolCall", id: "one", name: first.name, arguments: {} },
        { type: "toolCall", id: "two", name: second.name, arguments: {} },
      ], "toolUse"));
      return streamOf(assistant([], options?.signal?.aborted ? "aborted" : "stop"));
    },
  });
  const events: AgentEvent[] = [];
  agent.subscribe((event) => { events.push(event); });

  const run = agent.prompt("run");
  await entered.promise;
  agent.abort();
  await run;

  assert.equal(secondStarted, false);
  assert.deepEqual(events.filter((event) => event.type === "tool_execution_start").map((event) => event.type === "tool_execution_start" ? event.toolCallId : ""), ["one"]);
  assert.deepEqual(events.filter((event) => event.type === "tool_execution_end").map((event) => event.type === "tool_execution_end" ? event.toolCallId : ""), ["one"]);
  assert.equal(agent.state.messages.at(-1)?.role === "assistant" ? agent.state.messages.at(-1)?.stopReason : undefined, "aborted");
});

test("a missing parallel tool is isolated from valid siblings", async () => {
  const schema = Type.Object({});
  let validRan = false;
  const valid: AgentTool<typeof schema> = {
    name: "valid",
    label: "Valid",
    description: "Valid operation",
    parameters: schema,
    async execute() {
      validRan = true;
      return { content: [{ type: "text", text: "valid result" }], details: {}, terminate: true };
    },
  };
  const loop = agentLoop(
    [{ role: "user", content: "run", timestamp: 1 }],
    { messages: [], tools: [valid] },
    {
      model,
      convertToLlm: (messages) => messages.filter((message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult"),
      shouldStopAfterTurn: () => true,
    },
    undefined,
    () => streamOf(assistant([
      { type: "toolCall", id: "missing", name: "missing", arguments: {} },
      { type: "toolCall", id: "valid", name: valid.name, arguments: {} },
    ], "toolUse")),
  );

  for await (const _event of loop) {}

  const results = (await loop.result()).filter((message) => message.role === "toolResult");
  assert.equal(validRan, true);
  assert.deepEqual(results.map((message) => message.role === "toolResult" ? [message.toolCallId, message.isError] : []), [
    ["missing", true],
    ["valid", false],
  ]);
});

test("a settled parallel tool ignores updates while a sibling remains active", async () => {
  const schema = Type.Object({});
  const slowEntered = deferred();
  const releaseSlow = deferred();
  let lateUpdate: (() => void) | undefined;
  const fast: AgentTool<typeof schema> = {
    name: "fast",
    label: "Fast",
    description: "Finishes first",
    parameters: schema,
    async execute(_id, _args, _signal, onUpdate) {
      lateUpdate = () => onUpdate?.({ content: [{ type: "text", text: "late" }], details: {} });
      return { content: [], details: {}, terminate: true };
    },
  };
  const slow: AgentTool<typeof schema> = {
    name: "slow",
    label: "Slow",
    description: "Finishes last",
    parameters: schema,
    async execute() {
      slowEntered.resolve();
      await releaseSlow.promise;
      return { content: [], details: {}, terminate: true };
    },
  };
  const agent = new Agent({
    initialState: { model, tools: [fast, slow] },
    streamFunction: () => streamOf(assistant([
      { type: "toolCall", id: "fast", name: fast.name, arguments: {} },
      { type: "toolCall", id: "slow", name: slow.name, arguments: {} },
    ], "toolUse")),
  });
  const updates: string[] = [];
  agent.subscribe((event) => {
    if (event.type === "tool_execution_update") updates.push(event.toolCallId);
  });

  const run = agent.prompt("run");
  await slowEntered.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  lateUpdate?.();
  releaseSlow.resolve();
  await run;

  assert.deepEqual(updates, []);
});

test("JSONL storage rejects malformed entries and restores an explicit branch leaf", async (t) => {
  const root = await temp(t, "rigyn-agent-jsonl-boundary-");
  const env = new NodeExecutionEnv({ cwd: root });
  const header = { type: "session", version: 3, id: "session", timestamp: new Date().toISOString(), cwd: root };
  await env.writeFile("malformed.jsonl", `${JSON.stringify(header)}\n{bad}\n`);
  await assert.rejects(
    JsonlSessionStorage.open(env, join(root, "malformed.jsonl")),
    (error: unknown) => error instanceof SessionError && error.code === "invalid_entry",
  );

  const storage = await JsonlSessionStorage.create(env, join(root, "branch.jsonl"), { cwd: root, sessionId: "branch" });
  const session = new Session(storage);
  const rootId = await session.appendMessage({ role: "user", content: "root", timestamp: 1 });
  await session.appendMessage({ role: "user", content: "discarded", timestamp: 2 });
  await session.moveTo(rootId);
  const branchId = await session.appendMessage({ role: "user", content: "branch", timestamp: 3 });

  const reopened = new Session(await JsonlSessionStorage.open(env, join(root, "branch.jsonl")));
  assert.equal(await reopened.getLeafId(), branchId);
  assert.deepEqual((await reopened.getBranch()).flatMap((entry) => entry.type === "message" ? [text(entry.message)] : []), ["root", "branch"]);
  assert.ok((await reopened.getEntries()).some((entry) => entry.type === "leaf" && entry.targetId === rootId));
});

test("compaction cut points preserve a whole recent turn and mark split turns", () => {
  const entries: SessionTreeEntry[] = [
    { type: "message", id: "u1", parentId: null, timestamp: "1", message: { role: "user", content: "old", timestamp: 1 } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2", message: assistant([{ type: "text", text: "x".repeat(80) }]) },
    { type: "message", id: "u2", parentId: "a1", timestamp: "3", message: { role: "user", content: "recent", timestamp: 3 } },
    { type: "message", id: "a2", parentId: "u2", timestamp: "4", message: assistant([{ type: "text", text: "y".repeat(80) }]) },
  ];

  assert.deepEqual(findCutPoint(entries, 0, entries.length, 21), {
    firstKeptEntryIndex: 2,
    turnStartIndex: -1,
    isSplitTurn: false,
  });
  assert.deepEqual(findCutPoint(entries, 0, entries.length, 10), {
    firstKeptEntryIndex: 3,
    turnStartIndex: 2,
    isSplitTurn: true,
  });
});

test("resource and prompt formatting escape metadata and expand supported argument forms", () => {
  const formatted = formatSkillsForSystemPrompt([{
    name: "read<&\"'",
    description: "use > carefully",
    content: "not embedded",
    filePath: "/tmp/<skill>&.md",
  }]);
  assert.match(formatted, /<name>read&lt;&amp;&quot;&apos;<\/name>/u);
  assert.match(formatted, /<description>use &gt; carefully<\/description>/u);
  assert.match(formatted, /<location>\/tmp\/&lt;skill&gt;&amp;\.md<\/location>/u);
  assert.doesNotMatch(formatted, /not embedded/u);

  assert.equal(formatPromptTemplateInvocation({ name: "args", content: "$1|$2|$@|${@:2}|${@:2:2}" }, ["one", "two", "three"]), "one|two|one two three|two three|two three");
});

test("Node execution cancellation settles as aborted", async (t) => {
  const root = await temp(t, "rigyn-agent-cancel-");
  const env = new NodeExecutionEnv({ cwd: root });
  const controller = new AbortController();
  const running = env.exec("sleep 10", { abortSignal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  const result = await running;
  assert.equal(!result.ok && result.error.code, "aborted");
});

test("shell capture ignores output callbacks after execution settles", async (t) => {
  const root = await temp(t, "rigyn-agent-late-output-");
  const files = new NodeExecutionEnv({ cwd: root });
  let onStdout: ((chunk: string) => void) | undefined;
  const env = new Proxy(files, {
    get(target, property, receiver) {
      if (property !== "exec") return Reflect.get(target, property, receiver);
      return async (_command: string, options: ShellExecOptions = {}): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, never>> => {
        onStdout = options.onStdout;
        options.onStdout?.("before\n");
        return { ok: true, value: { stdout: "before\n", stderr: "", exitCode: 0 } };
      };
    },
  }) as ExecutionEnv;
  const observed: string[] = [];

  const captured = await executeShellWithCapture(env, "ignored", { onChunk: (chunk) => observed.push(chunk) });
  onStdout?.("after\n");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(captured.ok && captured.value.output, "before\n");
  assert.deepEqual(observed, ["before\n"]);
  if (captured.ok && captured.value.fullOutputPath) {
    assert.doesNotMatch(await readFile(captured.value.fullOutputPath, "utf8"), /after/u);
  }
});
