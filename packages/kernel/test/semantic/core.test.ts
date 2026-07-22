import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import {
  Agent,
  AgentHarness,
  EventStream,
  InMemorySessionRepo,
  JsonlSessionRepo,
  Session,
  InMemorySessionStorage,
  agentLoop,
  buildSessionContext,
  createAssistantEventStream,
  createCustomMessage,
  estimateContextTokens,
  formatPromptTemplateInvocation,
  loadPromptTemplates,
  loadSkills,
  prepareCompaction,
  serializeConversation,
  truncateHead,
  truncateTail,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Models,
  type StreamFn,
} from "../../src/index.js";
import { NodeExecutionEnv } from "../../src/node.js";

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "test",
  provider: "test",
  baseUrl: "http://localhost.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage, stopReason, timestamp: Date.now() };
}
function streamOf(message: AssistantMessage, delay = 0): AssistantMessageEventStream {
  const stream = createAssistantEventStream();
  setTimeout(() => stream.push(message.stopReason === "error" || message.stopReason === "aborted" ? { type: "error", reason: message.stopReason, error: message } : { type: "done", reason: message.stopReason, message }), delay);
  return stream;
}
const convert = (messages: AgentMessage[]) => messages.filter((message): message is Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }> => message.role === "user" || message.role === "assistant" || message.role === "toolResult");

test("loop emits the canonical prompt and turn lifecycle", async () => {
  const prompt: AgentMessage = { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 };
  const events: AgentEvent[] = [];
  const stream = agentLoop([prompt], { systemPrompt: "system", messages: [] }, { model, convertToLlm: convert }, undefined, () => streamOf(assistant([{ type: "text", text: "world" }])));
  for await (const event of stream) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["agent_start", "turn_start", "message_start", "message_end", "message_start", "message_end", "turn_end", "agent_end"]);
  assert.deepEqual((await stream.result()).map((message) => message.role), ["user", "assistant"]);
});

test("tool arguments are prepared, validated once, then may be mutated by the hook", async () => {
  const schema = Type.Object({ value: Type.Number() }, { additionalProperties: false });
  let received: unknown;
  const tool: AgentTool<typeof schema> = {
    name: "number",
    label: "Number",
    description: "records a number",
    parameters: schema,
    prepareArguments: () => ({ value: 1 }),
    async execute(_id, args) { received = args; return { content: [{ type: "text", text: "ok" }], details: {}, terminate: true }; },
  };
  const result = agentLoop([{ role: "user", content: "go", timestamp: 1 }], { systemPrompt: "", messages: [], tools: [tool] }, {
    model,
    convertToLlm: convert,
    beforeToolCall: async ({ args }) => { (args as { value: unknown }).value = "mutated after validation"; return undefined; },
  }, undefined, () => streamOf(assistant([{ type: "toolCall", id: "c1", name: "number", arguments: { ignored: true } }], "toolUse")));
  for await (const _ of result) {}
  assert.deepEqual(received, { value: "mutated after validation" });
});

test("parallel tools end in completion order and persist results in source order", async () => {
  const schema = Type.Object({});
  const makeTool = (name: string, delay: number): AgentTool<typeof schema> => ({ name, label: name, description: name, parameters: schema, async execute() { await new Promise((resolve) => setTimeout(resolve, delay)); return { content: [{ type: "text", text: name }], details: {}, terminate: true }; } });
  const events: AgentEvent[] = [];
  const loop = agentLoop([{ role: "user", content: "go", timestamp: 1 }], { systemPrompt: "", messages: [], tools: [makeTool("slow", 20), makeTool("fast", 1)] }, { model, convertToLlm: convert }, undefined, () => streamOf(assistant([{ type: "toolCall", id: "a", name: "slow", arguments: {} }, { type: "toolCall", id: "b", name: "fast", arguments: {} }], "toolUse")));
  for await (const event of loop) events.push(event);
  assert.deepEqual(events.filter((event) => event.type === "tool_execution_end").map((event) => event.type === "tool_execution_end" ? event.toolCallId : ""), ["b", "a"]);
  assert.deepEqual((await loop.result()).filter((message) => message.role === "toolResult").map((message) => message.role === "toolResult" ? message.toolCallId : ""), ["a", "b"]);
});

test("length-truncated tool calls are rejected without execution", async () => {
  let executed = false;
  const schema = Type.Object({});
  const tool: AgentTool<typeof schema> = { name: "unsafe", label: "unsafe", description: "unsafe", parameters: schema, async execute() { executed = true; return { content: [], details: {} }; } };
  const loop = agentLoop([{ role: "user", content: "go", timestamp: 1 }], { systemPrompt: "", messages: [], tools: [tool] }, { model, convertToLlm: convert, shouldStopAfterTurn: () => true }, undefined, () => streamOf(assistant([{ type: "toolCall", id: "a", name: "unsafe", arguments: {} }], "length")));
  for await (const _ of loop) {}
  assert.equal(executed, false);
  const toolResult = (await loop.result()).find((message) => message.role === "toolResult");
  assert.equal(toolResult?.role, "toolResult");
  if (toolResult?.role === "toolResult") assert.match(toolResult.content[0]?.type === "text" ? toolResult.content[0].text : "", /output token limit/);
});

test("Agent queues steering one at a time and waits for async subscribers", async () => {
  let calls = 0;
  const agent = new Agent({ initialState: { model }, streamFunction: () => streamOf(assistant([{ type: "text", text: String(++calls) }])) });
  agent.steer({ role: "user", content: "steer one", timestamp: 2 });
  agent.steer({ role: "user", content: "steer two", timestamp: 3 });
  let endObserved = false;
  agent.subscribe(async (event) => { if (event.type === "agent_end") { await new Promise((resolve) => setTimeout(resolve, 5)); endObserved = true; } });
  await agent.prompt("start");
  assert.equal(calls, 2);
  assert.equal(endObserved, true);
  assert.equal(agent.state.isStreaming, false);
});

test("memory sessions preserve tree branches, state changes, labels, and compaction projection", async () => {
  const session = new Session(new InMemorySessionStorage());
  const root = await session.appendMessage({ role: "user", content: "root", timestamp: 1 });
  await session.appendModelChange("one", "m1");
  await session.appendThinkingLevelChange("high");
  const assistantId = await session.appendMessage(assistant([{ type: "text", text: "answer" }]));
  await session.appendLabel(assistantId, "first");
  const initialContext = await session.buildContext();
  assert.equal(initialContext.model?.provider, "test");
  assert.equal(initialContext.model?.modelId, "test-model");
  assert.equal(initialContext.thinkingLevel, "high");
  await session.moveTo(root);
  await session.appendMessage({ role: "user", content: "branch", timestamp: 2 });
  assert.equal(await session.getLabel(assistantId), "first");
  const context = await session.buildContext();
  assert.equal(context.model, null);
  assert.equal(context.thinkingLevel, "off");
  assert.equal(context.messages.at(-1)?.role, "user");
  const projected = buildSessionContext(await session.getBranch());
  assert.equal(projected.messages.length, context.messages.length);
});

test("version 3 JSONL repositories round-trip metadata and forks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-agent-jsonl-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = new NodeExecutionEnv({ cwd: root });
  const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: "sessions" });
  const session = await repo.create({ cwd: "/workspace", metadata: { source: "test" } });
  const userId = await session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
  await session.appendMessage(assistant([{ type: "text", text: "ok" }]));
  const listed = await repo.list({ cwd: "/workspace" });
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0]?.metadata, { source: "test" });
  const header = JSON.parse((await readFile(listed[0]!.path, "utf8")).split("\n")[0]!);
  assert.equal(header.version, 3);
  const fork = await repo.fork(listed[0]!, { cwd: "/workspace", entryId: userId, position: "before" });
  assert.equal((await fork.getEntries()).length, 0);
});

test("session storage preserves opaque provider state without rendering it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-agent-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = new NodeExecutionEnv({ cwd: root });
  const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: "sessions" });
  const session = await repo.create({ cwd: "/workspace" });
  const providerState = {
    source: { api: model.api, provider: model.provider, model: model.id },
    value: { assistantBlocks: [{ type: "future_block", opaque: "never-render-this-state" }] },
  };
  const diagnostics = [{ type: "provider_response", message: "Provider response received", timestamp: 42, details: { response: { status: 200, headers: { "x-request-id": "req_42" } } } }];
  const message: AssistantMessage = { ...assistant([{ type: "text", text: "visible" }]), responseId: "response_42", responseModel: "wire-model", diagnostics, providerState };
  await session.appendMessage(message);

  const metadata = (await repo.list({ cwd: "/workspace" }))[0]!;
  const reopened = await repo.open(metadata);
  const stored = (await reopened.getEntries()).find((entry) => entry.type === "message")?.message;
  assert.deepEqual(stored, message);
  assert.equal(serializeConversation([message]), "[Assistant]: visible");
  assert.doesNotMatch(serializeConversation([message]), /never-render-this-state|req_42/u);
});

test("Node execution environment returns results for filesystem, shell, and aborts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-agent-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = new NodeExecutionEnv({ cwd: root });
  assert.equal((await env.writeFile("nested/a.txt", "one")).ok, true);
  assert.equal((await env.appendFile("nested/a.txt", " two")).ok, true);
  assert.equal((await env.readTextFile("nested/a.txt")).ok && (await env.readTextFile("nested/a.txt")).value, "one two");
  const shell = await env.exec("printf hello && printf err >&2", { env: { RIGYN_TEST: "yes" } });
  assert.equal(shell.ok, true);
  if (shell.ok) assert.deepEqual({ stdout: shell.value.stdout, stderr: shell.value.stderr, exitCode: shell.value.exitCode }, { stdout: "hello", stderr: "err", exitCode: 0 });
  const controller = new AbortController(); controller.abort();
  const missing = await env.readTextFile("missing", controller.signal);
  assert.equal(!missing.ok && missing.error.code, "aborted");
});

test("skills and prompt templates load with frontmatter and invocation substitution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-agent-resources-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const promptsRoot = join(root, "prompts");
  const skillsRoot = join(root, "skills");
  const env = new NodeExecutionEnv({ cwd: root });
  await env.createDir(promptsRoot, { recursive: true });
  await env.createDir(skillsRoot, { recursive: true });
  await writeFile(join(promptsRoot, "template.md"), "---\ndescription: Template\n---\nHello $1 $@");
  await writeFile(join(skillsRoot, "SKILL.md"), "---\nname: resources\ndescription: Resource work\n---\nInstructions");
  const templates = await loadPromptTemplates(env, promptsRoot);
  assert.equal(templates.promptTemplates.length, 1);
  assert.equal(formatPromptTemplateInvocation(templates.promptTemplates[0]!, ["A", "B"]), "Hello A A B");
  const skills = await loadSkills(env, skillsRoot);
  assert.equal(skills.skills[0]?.name, "resources");
});

test("truncation and compaction estimates preserve UTF-8 and recent context", async () => {
  const head = truncateHead("😀😀\nlast", { maxBytes: 8, maxLines: 10 });
  assert.equal(head.content, "😀😀");
  const tail = truncateTail("first\n😀😀😀", { maxBytes: 8, maxLines: 10 });
  assert.equal(tail.lastLinePartial, true);
  const storage = new InMemorySessionStorage();
  const session = new Session(storage);
  await session.appendMessage({ role: "user", content: "x".repeat(100), timestamp: 1 });
  await session.appendMessage(assistant([{ type: "text", text: "y".repeat(100) }]));
  await session.appendMessage({ role: "user", content: "recent", timestamp: 2 });
  const prepared = prepareCompaction(await session.getBranch(), { enabled: true, reserveTokens: 100, keepRecentTokens: 1 });
  assert.equal(prepared.ok, true);
  assert.ok(estimateContextTokens((await session.buildContext()).messages).tokens > 0);
});

test("AgentHarness persists direct turns and emits save points", async () => {
  const repo = new InMemorySessionRepo();
  const session = await repo.create();
  const models: Models = {
    streamSimple: () => streamOf(assistant([{ type: "text", text: "done" }])),
    async completeSimple() { return assistant([{ type: "text", text: "summary" }]); },
  };
  const harness = new AgentHarness({ env: new NodeExecutionEnv({ cwd: process.cwd() }), session, models, model });
  const observed: string[] = [];
  harness.subscribe((event) => observed.push(event.type));
  const response = await harness.prompt("work");
  assert.equal(response.stopReason, "stop");
  assert.equal((await session.getBranch()).filter((entry) => entry.type === "message").length, 2);
  assert.ok(observed.includes("save_point"));
  assert.equal(observed.at(-1), "settled");
});

test("before-agent custom messages remain custom in history and become user context only at the provider boundary", async () => {
  const repo = new InMemorySessionRepo();
  const session = await repo.create();
  let providerRoles: string[] = [];
  let providerText = "";
  const models: Models = {
    streamSimple(_model, context) {
      providerRoles = context.messages.map((message) => message.role);
      providerText = context.messages.flatMap((message) => {
        if (message.role !== "user") return [];
        return typeof message.content === "string"
          ? [message.content]
          : message.content.flatMap((part) => part.type === "text" ? [part.text] : []);
      }).join("\n");
      return streamOf(assistant([{ type: "text", text: "done" }]));
    },
    async completeSimple() { return assistant([{ type: "text", text: "summary" }]); },
  };
  const harness = new AgentHarness({ env: new NodeExecutionEnv({ cwd: process.cwd() }), session, models, model });
  harness.on("before_agent_start", () => ({
    messages: [createCustomMessage("extension-note", "injected context", false, { source: "test" }, new Date(10).toISOString())],
  }));

  await harness.prompt("work");

  assert.deepEqual(providerRoles, ["user", "user"]);
  assert.match(providerText, /work\ninjected context/);
  const persisted = (await session.getBranch()).filter((entry) => entry.type === "message");
  assert.equal(persisted[1]?.type === "message" ? persisted[1].message.role : undefined, "custom");
  if (persisted[1]?.type === "message" && persisted[1].message.role === "custom") {
    assert.equal(persisted[1].message.customType, "extension-note");
    assert.deepEqual(persisted[1].message.details, { source: "test" });
  }
});

test("EventStream resolves terminal results and ends iteration", async () => {
  const stream = new EventStream<{ done: boolean; value: number }, number>((event) => event.done, (event) => event.value);
  stream.push({ done: false, value: 1 }); stream.push({ done: true, value: 2 });
  const values: number[] = []; for await (const event of stream) values.push(event.value);
  assert.deepEqual(values, [1, 2]); assert.equal(await stream.result(), 2);
});
