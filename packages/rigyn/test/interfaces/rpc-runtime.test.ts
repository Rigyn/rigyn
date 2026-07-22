import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEvent } from "../../src/core/events.js";
import { RpcRuntimeDispatcher, type RpcSessionRuntime } from "../../src/interfaces/rpc-runtime.js";
import type { ProviderModel } from "../../src/providers/models.js";
import type { AgentSession, AgentSessionPromptOptions, AgentSessionRun } from "../../src/service/agent-session.js";
import type { SessionEntry, SessionTreeNode } from "../../src/storage/types.js";

type Listener = (event: RuntimeEvent) => void | Promise<void>;

interface Fixture {
  runtime: RpcSessionRuntime;
  outputs: object[];
  prompts: Array<{ message: string; options: AgentSessionPromptOptions }>;
  calls: Array<{ method: string; args: unknown[] }>;
  emit(event: string | object): Promise<void>;
  setPrompt(handler: (message: string, options: AgentSessionPromptOptions) => Promise<AgentSessionRun>): void;
  forks: Array<{ entryId: string; position?: "before" | "at" }>;
}

const MODEL: ProviderModel = {
  id: "model",
  name: "Model",
  api: "openai-responses",
  provider: "provider",
  baseUrl: "https://provider.invalid/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.75 },
  contextWindow: 32_000,
  maxTokens: 4_096,
};

const ENTRIES: SessionEntry[] = [
  {
    type: "thinking_level_change",
    id: "entry-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    thinkingLevel: "off",
  },
  {
    type: "thinking_level_change",
    id: "entry-2",
    parentId: "entry-1",
    timestamp: "2026-01-01T00:00:01.000Z",
    thinkingLevel: "high",
  },
];

const TREE: SessionTreeNode[] = [{ entry: ENTRIES[0]!, children: [{ entry: ENTRIES[1]!, children: [] }] }];

function fixture(entries: SessionEntry[] = ENTRIES, tree: SessionTreeNode[] = TREE): Fixture {
  const listeners = new Set<Listener>();
  const outputs: object[] = [];
  const prompts: Array<{ message: string; options: AgentSessionPromptOptions }> = [];
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const forks: Array<{ entryId: string; position?: "before" | "at" }> = [];
  const record = (method: string, ...args: unknown[]): void => { calls.push({ method, args }); };
  let promptHandler = async (_message: string, options: AgentSessionPromptOptions): Promise<AgentSessionRun> => {
    options.preflightResult?.(true);
    return { sessionId: "session", results: [] };
  };
  let rebind: ((session: AgentSession) => Promise<void>) | undefined;
  const manager = {
    getLeafId() { return entries.at(-1)?.id ?? null; },
    getEntries() { return structuredClone(entries); },
    getTree() { return structuredClone(tree); },
  };
  const session = {
    prompt(message: string, options: AgentSessionPromptOptions) {
      prompts.push({ message, options });
      return promptHandler(message, options);
    },
    subscribe(listener: Listener) { listeners.add(listener); return () => listeners.delete(listener); },
    onEvent(listener: Listener) { listeners.add(listener); return () => listeners.delete(listener); },
    get sessionManager() { return manager; },
    get sessionId() { return "session"; },
    get messages() { return []; },
    get model() { return { provider: MODEL.provider, api: MODEL.api, id: MODEL.id }; },
    get modelRegistry() {
      return {
        find(provider: string, id: string) { return provider === MODEL.provider && id === MODEL.id ? MODEL : undefined; },
        async getAvailable() { return [MODEL]; },
      };
    },
    get extensionRunner() {
      return {
        getRegisteredCommands() {
          return [{
            name: "extension-command",
            invocationName: "extension-command",
            description: "Extension command",
            sourceInfo: {
              path: "/tmp/extension.mjs",
              source: "extension",
              scope: "temporary",
              origin: "package",
            },
          }];
        },
      };
    },
    get promptTemplates() {
      return [{
        name: "prompt-command",
        description: "Prompt command",
        sourceInfo: { path: "/tmp/prompt.md", source: "prompt", scope: "temporary", origin: "top-level" },
      }];
    },
    get resourceLoader() {
      return {
        getSkills() {
          return {
            skills: [{
              name: "skill-command",
              description: "Skill command",
              sourceInfo: { path: "/tmp/SKILL.md", source: "skill", scope: "temporary", origin: "top-level" },
            }],
          };
        },
      };
    },
    get thinkingLevel() { return "high"; },
    get isStreaming() { return false; },
    get isCompacting() { return false; },
    get steeringMode() { return "all"; },
    get followUpMode() { return "one-at-a-time"; },
    get sessionFile() { return "/tmp/session.jsonl"; },
    get sessionName() { return "Session"; },
    get autoCompactionEnabled() { return true; },
    get pendingMessageCount() { return 0; },
    async abort() { record("abort"); },
    steer(...args: unknown[]) { record("steer", ...args); },
    followUp(...args: unknown[]) { record("followUp", ...args); },
    setThinkingLevel(...args: unknown[]) { record("setThinkingLevel", ...args); },
    cycleThinkingLevel() { record("cycleThinkingLevel"); return "xhigh"; },
    getAvailableThinkingLevels() { record("getAvailableThinkingLevels"); return ["off", "high", "xhigh"]; },
    setSteeringMode(...args: unknown[]) { record("setSteeringMode", ...args); },
    setFollowUpMode(...args: unknown[]) { record("setFollowUpMode", ...args); },
    async compact(...args: unknown[]) { record("compact", ...args); return { sessionId: "session", results: [] }; },
    setAutoCompactionEnabled(...args: unknown[]) { record("setAutoCompactionEnabled", ...args); },
    setAutoRetryEnabled(...args: unknown[]) { record("setAutoRetryEnabled", ...args); },
    abortRetry() { record("abortRetry"); },
    async executeBash(...args: unknown[]) {
      record("executeBash", ...args);
      return { output: "done", exitCode: 0, cancelled: false, truncated: false };
    },
    abortBash() { record("abortBash"); },
    getSessionStats() {
      record("getSessionStats");
      return {
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session",
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 2,
        usage: {},
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
        usageBreakdown: [],
      };
    },
    async exportToHtml(...args: unknown[]) { record("exportToHtml", ...args); return "/tmp/session.html"; },
    async cycleModel() {
      record("cycleModel");
      return { model: MODEL, thinkingLevel: "high", isScoped: true };
    },
    async setModel(...args: unknown[]) { record("setModel", ...args); },
    getUserMessagesForForking() { record("getUserMessagesForForking"); return [{ entryId: "entry-1", text: "hello" }]; },
    getLastAssistantText() { record("getLastAssistantText"); return "answer"; },
    setSessionName(...args: unknown[]) { record("setSessionName", ...args); },
  } as unknown as AgentSession;
  const runtime: RpcSessionRuntime = {
    session,
    async newSession(...args) { record("newSession", ...args); await rebind?.(session); return { cancelled: false }; },
    async switchSession(...args) { record("switchSession", ...args); await rebind?.(session); return { cancelled: false }; },
    async fork(entryId, options) {
      record("fork", entryId, options);
      forks.push({ entryId, ...(options?.position === undefined ? {} : { position: options.position }) });
      await rebind?.(session);
      return { cancelled: false };
    },
    setRebindSession(callback) { rebind = callback; },
    setBeforeSessionInvalidate() {},
  };
  return {
    runtime,
    outputs,
    prompts,
    calls,
    forks,
    setPrompt(handler) { promptHandler = handler; },
    async emit(value) {
      const event = (typeof value === "string" ? { type: value } : value) as RuntimeEvent;
      for (const listener of listeners) await listener(event);
    },
  };
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("RPC prompt responds only after successful preflight and emits raw agent events", async () => {
  const value = fixture();
  value.setPrompt(async (_message, options) => {
    options.preflightResult?.(true);
    options.preflightResult?.(true);
    return { sessionId: "session", results: [] };
  });
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();

  assert.equal(await dispatcher.dispatch({ id: "req_1", type: "prompt", message: "hello" }), undefined);
  await turn();
  assert.deepEqual(value.outputs, [{ id: "req_1", type: "response", command: "prompt", success: true }]);
  await value.emit("agent_end");
  assert.deepEqual(value.outputs[1], { type: "agent_end" });
  await dispatcher.close();
});

test("RPC forwards branch-summary retry lifecycle events without reshaping them", async () => {
  const value = fixture();
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();
  const events = [
    {
      type: "summarization_retry_scheduled",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2_000,
      errorMessage: "connection reset",
    },
    { type: "summarization_retry_attempt_start", source: "branchSummary" },
    { type: "summarization_retry_finished" },
  ];

  for (const event of events) await value.emit(event);

  assert.deepEqual(value.outputs, events);
  await dispatcher.close();
});

test("RPC prompt reports failures before preflight and preserves streaming behavior", async () => {
  const value = fixture();
  value.setPrompt(async () => { throw new Error("preflight failed"); });
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();
  assert.equal(await dispatcher.dispatch({ id: "req_fail", type: "prompt", message: "bad" }), undefined);
  await turn();
  assert.deepEqual(value.outputs, [{
    id: "req_fail",
    type: "response",
    command: "prompt",
    success: false,
    error: "preflight failed",
  }]);

  value.outputs.length = 0;
  value.setPrompt(async (_message, options) => {
    options.preflightResult?.(true);
    return { sessionId: "session", results: [] };
  });
  await dispatcher.dispatch({ id: "req_queue", type: "prompt", message: "next", streamingBehavior: "followUp" });
  await turn();
  assert.equal(value.prompts.at(-1)?.options.streamingBehavior, "followUp");
  assert.deepEqual(value.outputs, [{ id: "req_queue", type: "response", command: "prompt", success: true }]);
  await dispatcher.close();
});

test("RPC model, state, thinking, and queue commands preserve direct session semantics", async () => {
  const value = fixture();
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();

  assert.deepEqual(await dispatcher.dispatch({ id: "state", type: "get_state" }), {
    id: "state",
    type: "response",
    command: "get_state",
    success: true,
    data: {
      model: MODEL,
      thinkingLevel: "high",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "all",
      followUpMode: "one-at-a-time",
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session",
      sessionName: "Session",
      autoCompactionEnabled: true,
      messageCount: 0,
      pendingMessageCount: 0,
    },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "set-model", type: "set_model", provider: "provider", modelId: "model" }), {
    id: "set-model", type: "response", command: "set_model", success: true, data: MODEL,
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "missing-model", type: "set_model", provider: "provider", modelId: "missing" }), {
    id: "missing-model", type: "response", command: "set_model", success: false,
    error: "Model not found: provider/missing",
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "cycle-model", type: "cycle_model" }), {
    id: "cycle-model", type: "response", command: "cycle_model", success: true,
    data: { model: MODEL, thinkingLevel: "high", isScoped: true },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "models", type: "get_available_models" }), {
    id: "models", type: "response", command: "get_available_models", success: true, data: { models: [MODEL] },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "set-thinking", type: "set_thinking_level", level: "high" }), {
    id: "set-thinking", type: "response", command: "set_thinking_level", success: true,
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "cycle-thinking", type: "cycle_thinking_level" }), {
    id: "cycle-thinking", type: "response", command: "cycle_thinking_level", success: true, data: { level: "xhigh" },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "thinking-levels", type: "get_available_thinking_levels" }), {
    id: "thinking-levels", type: "response", command: "get_available_thinking_levels", success: true,
    data: { levels: ["off", "high", "xhigh"] },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "steering-mode", type: "set_steering_mode", mode: "one-at-a-time" }), {
    id: "steering-mode", type: "response", command: "set_steering_mode", success: true,
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "follow-up-mode", type: "set_follow_up_mode", mode: "all" }), {
    id: "follow-up-mode", type: "response", command: "set_follow_up_mode", success: true,
  });

  assert.deepEqual(value.calls, [
    { method: "setModel", args: [MODEL] },
    { method: "cycleModel", args: [] },
    { method: "setThinkingLevel", args: ["high"] },
    { method: "cycleThinkingLevel", args: [] },
    { method: "getAvailableThinkingLevels", args: [] },
    { method: "setSteeringMode", args: ["one-at-a-time"] },
    { method: "setFollowUpMode", args: ["all"] },
  ]);
  await dispatcher.close();
});

test("RPC run-control, compaction, retry, and bash commands call the direct session API", async () => {
  const value = fixture();
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();

  const commands = [
    { command: { id: "steer", type: "steer", message: "now" } as const, expected: { id: "steer", type: "response", command: "steer", success: true } },
    { command: { id: "follow", type: "follow_up", message: "later" } as const, expected: { id: "follow", type: "response", command: "follow_up", success: true } },
    { command: { id: "abort", type: "abort" } as const, expected: { id: "abort", type: "response", command: "abort", success: true } },
    {
      command: { id: "compact", type: "compact", customInstructions: "preserve decisions" } as const,
      expected: { id: "compact", type: "response", command: "compact", success: true, data: { sessionId: "session", results: [] } },
    },
    { command: { id: "auto-compact", type: "set_auto_compaction", enabled: false } as const, expected: { id: "auto-compact", type: "response", command: "set_auto_compaction", success: true } },
    { command: { id: "auto-retry", type: "set_auto_retry", enabled: false } as const, expected: { id: "auto-retry", type: "response", command: "set_auto_retry", success: true } },
    { command: { id: "abort-retry", type: "abort_retry" } as const, expected: { id: "abort-retry", type: "response", command: "abort_retry", success: true } },
    {
      command: { id: "bash", type: "bash", command: "echo done", excludeFromContext: true } as const,
      expected: { id: "bash", type: "response", command: "bash", success: true, data: { output: "done", exitCode: 0, cancelled: false, truncated: false } },
    },
    { command: { id: "abort-bash", type: "abort_bash" } as const, expected: { id: "abort-bash", type: "response", command: "abort_bash", success: true } },
  ];
  for (const item of commands) assert.deepEqual(await dispatcher.dispatch(item.command), item.expected);

  assert.deepEqual(value.calls, [
    { method: "steer", args: ["now", undefined] },
    { method: "followUp", args: ["later", undefined] },
    { method: "abort", args: [] },
    { method: "compact", args: ["preserve decisions"] },
    { method: "setAutoCompactionEnabled", args: [false] },
    { method: "setAutoRetryEnabled", args: [false] },
    { method: "abortRetry", args: [] },
    { method: "executeBash", args: ["echo done", undefined, { excludeFromContext: true }] },
    { method: "abortBash", args: [] },
  ]);
  await dispatcher.close();
});

test("RPC session navigation, history, export, and discovery commands preserve values", async () => {
  const value = fixture();
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();

  assert.deepEqual(await dispatcher.dispatch({ id: "new", type: "new_session", parentSession: "/tmp/parent.jsonl" }), {
    id: "new", type: "response", command: "new_session", success: true, data: { cancelled: false },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "stats", type: "get_session_stats" }), {
    id: "stats", type: "response", command: "get_session_stats", success: true,
    data: {
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session",
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 2,
      usage: {},
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      usageBreakdown: [],
    },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "html", type: "export_html", outputPath: "/tmp/export.html" }), {
    id: "html", type: "response", command: "export_html", success: true, data: { path: "/tmp/session.html" },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "switch", type: "switch_session", sessionPath: "/tmp/other.jsonl" }), {
    id: "switch", type: "response", command: "switch_session", success: true, data: { cancelled: false },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "fork", type: "fork", entryId: "entry-1" }), {
    id: "fork", type: "response", command: "fork", success: true, data: { text: "", cancelled: false },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "fork-messages", type: "get_fork_messages" }), {
    id: "fork-messages", type: "response", command: "get_fork_messages", success: true,
    data: { messages: [{ entryId: "entry-1", text: "hello" }] },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "entries", type: "get_entries" }), {
    id: "entries", type: "response", command: "get_entries", success: true,
    data: {
      entries: ENTRIES,
      leafId: "entry-2",
      sequenceStart: 1,
      nextSequence: 2,
      hasMore: false,
      totalEntries: 2,
    },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "entries-since", type: "get_entries", since: "entry-1" }), {
    id: "entries-since", type: "response", command: "get_entries", success: true,
    data: {
      entries: [ENTRIES[1]],
      leafId: "entry-2",
      sequenceStart: 2,
      nextSequence: 2,
      hasMore: false,
      totalEntries: 2,
    },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "entries-page", type: "get_entries", afterSequence: 0, limit: 1 }), {
    id: "entries-page", type: "response", command: "get_entries", success: true,
    data: {
      entries: [ENTRIES[0]],
      leafId: "entry-2",
      sequenceStart: 1,
      nextSequence: 1,
      hasMore: true,
      totalEntries: 2,
    },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "entries-missing", type: "get_entries", since: "missing" }), {
    id: "entries-missing", type: "response", command: "get_entries", success: false, error: "Entry not found: missing",
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "entries-conflict", type: "get_entries", since: "entry-1", afterSequence: 1 }), {
    id: "entries-conflict", type: "response", command: "get_entries", success: false,
    error: "Use either since or afterSequence, not both",
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "entries-limit", type: "get_entries", limit: 0 }), {
    id: "entries-limit", type: "response", command: "get_entries", success: false,
    error: "get_entries limit must be between 1 and 2048",
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "tree", type: "get_tree" }), {
    id: "tree", type: "response", command: "get_tree", success: true, data: { tree: TREE, leafId: "entry-2" },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "last", type: "get_last_assistant_text" }), {
    id: "last", type: "response", command: "get_last_assistant_text", success: true, data: { text: "answer" },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "name", type: "set_session_name", name: "  renamed  " }), {
    id: "name", type: "response", command: "set_session_name", success: true,
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "empty-name", type: "set_session_name", name: "  " }), {
    id: "empty-name", type: "response", command: "set_session_name", success: false, error: "Session name cannot be empty",
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "messages", type: "get_messages" }), {
    id: "messages", type: "response", command: "get_messages", success: true, data: { messages: [] },
  });
  const commands = await dispatcher.dispatch({ id: "commands", type: "get_commands" });
  if (commands?.success !== true || commands.command !== "get_commands" || !("data" in commands) || commands.data === null) {
    assert.fail("get_commands did not return its command catalog");
  }
  assert.deepEqual(commands.data.commands.map((command) => [command.name, command.source]), [
    ["extension-command", "extension"],
    ["prompt-command", "prompt"],
    ["skill:skill-command", "skill"],
  ]);

  assert.equal(value.calls.some((entry) => entry.method === "newSession" && (entry.args[0] as { parentSession?: string }).parentSession === "/tmp/parent.jsonl"), true);
  assert.equal(value.calls.some((entry) => entry.method === "switchSession" && entry.args[0] === "/tmp/other.jsonl"), true);
  assert.equal(value.calls.some((entry) => entry.method === "setSessionName" && entry.args[0] === "renamed"), true);
  assert.deepEqual(value.forks, [{ entryId: "entry-1" }]);
  await dispatcher.close();
});

test("unknown commands preserve IDs and clone forks the selected leaf at its exact position", async () => {
  const value = fixture();
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();
  assert.deepEqual(await dispatcher.dispatch({ id: "req_unknown", type: "future" }), {
    id: "req_unknown",
    type: "response",
    command: "future",
    success: false,
    error: "Unknown command: future",
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "req_clone", type: "clone" }), {
    id: "req_clone",
    type: "response",
    command: "clone",
    success: true,
    data: { cancelled: false },
  });
  assert.deepEqual(value.forks, [{ entryId: "entry-2", position: "at" }]);
  await dispatcher.close();
});

test("RPC entry history is chunked by default and resumes from an append-order sequence", async () => {
  const entries: SessionEntry[] = Array.from({ length: 600 }, (_, index) => ({
    type: "thinking_level_change",
    id: `entry-${index + 1}`,
    parentId: index === 0 ? null : `entry-${index}`,
    timestamp: new Date(1_700_000_000_000 + index).toISOString(),
    thinkingLevel: "off",
  }));
  const value = fixture(entries, []);
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();

  const first = await dispatcher.dispatch({ id: "first", type: "get_entries" });
  if (first?.success !== true || first.command !== "get_entries" || !("data" in first)) assert.fail("missing first page");
  assert.equal(first.data.entries.length, 512);
  assert.equal(first.data.nextSequence, 512);
  assert.equal(first.data.hasMore, true);

  const second = await dispatcher.dispatch({ id: "second", type: "get_entries", afterSequence: first.data.nextSequence });
  if (second?.success !== true || second.command !== "get_entries" || !("data" in second)) assert.fail("missing second page");
  assert.equal(second.data.entries.length, 88);
  assert.equal(second.data.entries[0]?.id, "entry-513");
  assert.equal(second.data.nextSequence, 600);
  assert.equal(second.data.hasMore, false);
  await dispatcher.close();
});
