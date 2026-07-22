import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CanonicalMessage } from "../../src/core/types.js";
import {
  bindDirectProviderWireLifecycle,
  loadDirectExtensions,
} from "../../src/extensions/runtime.js";
import { ProviderWireInterceptorRegistry } from "../../src/providers/wire.js";

const DIRECT_EVENTS = [
  "resources_discover",
  "project_trust",
  "session_start",
  "session_info_changed",
  "session_shutdown",
  "session_before_switch",
  "session_before_fork",
  "session_before_tree",
  "session_tree",
  "session_before_compact",
  "session_compact",
  "before_agent_start",
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "tool_call",
  "tool_result",
  "context",
  "input",
  "model_select",
  "thinking_level_select",
  "before_provider_request",
  "before_provider_headers",
  "after_provider_response",
  "user_bash",
] as const;

function message(id: string, role: CanonicalMessage["role"], text: string): CanonicalMessage {
  return {
    id,
    role,
    content: [{ type: "text", text }],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

test("direct factories receive every public event and reducer results alter host behavior", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-direct-events-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const seen: string[] = [];
  const payloads = new Map<string, unknown>();
  const observe = (name: string) => (event: { type: string }): void => {
    seen.push(event.type);
    payloads.set(name, event);
  };
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "event-conformance",
      factory(rigyn) {
        rigyn.on("resources_discover", (event) => {
          observe("resources_discover")(event);
          return { skillPaths: ["skills"], promptPaths: ["prompts"], themePaths: ["themes"] };
        });
        rigyn.on("project_trust", (event) => {
          observe("project_trust")(event);
          return { trusted: "yes", remember: true };
        });
        rigyn.on("session_start", observe("session_start"));
        rigyn.on("session_info_changed", observe("session_info_changed"));
        rigyn.on("session_shutdown", observe("session_shutdown"));
        rigyn.on("session_before_switch", (event) => {
          observe("session_before_switch")(event);
          return { cancel: true };
        });
        rigyn.on("session_before_fork", (event) => {
          observe("session_before_fork")(event);
          return { cancel: true, skipConversationRestore: true };
        });
        rigyn.on("session_before_tree", (event) => {
          observe("session_before_tree")(event);
          return {
            summary: { summary: "extension tree summary", details: { source: "extension" } },
            customInstructions: "focus on the selected branch",
            replaceInstructions: true,
            label: "selected",
          };
        });
        rigyn.on("session_tree", observe("session_tree"));
        rigyn.on("session_before_compact", (event) => {
          observe("session_before_compact")(event);
          return {
            compaction: {
              summary: "extension compact summary",
              firstKeptEntryId: "entry-keep",
              tokensBefore: 42,
              estimatedTokensAfter: 12,
              details: { source: "extension" },
            },
          };
        });
        rigyn.on("session_compact", observe("session_compact"));
        rigyn.on("before_agent_start", (event) => {
          observe("before_agent_start")(event);
          return {
            systemPrompt: `${event.systemPrompt}\nextension prompt`,
            message: { customType: "injected", content: "extension context", display: false },
          };
        });
        rigyn.on("agent_start", observe("agent_start"));
        rigyn.on("agent_end", observe("agent_end"));
        rigyn.on("agent_settled", observe("agent_settled"));
        rigyn.on("turn_start", observe("turn_start"));
        rigyn.on("turn_end", observe("turn_end"));
        rigyn.on("message_start", observe("message_start"));
        rigyn.on("message_update", observe("message_update"));
        rigyn.on("message_end", (event) => {
          observe("message_end")(event);
          return event.message.role === "assistant"
            ? { message: { ...event.message, content: [...event.message.content, { type: "text", text: "extension display" }] } }
            : undefined;
        });
        rigyn.on("tool_execution_start", observe("tool_execution_start"));
        rigyn.on("tool_execution_update", observe("tool_execution_update"));
        rigyn.on("tool_execution_end", observe("tool_execution_end"));
        rigyn.on("tool_call", (event) => {
          observe("tool_call")(event);
          const input = event.input as Record<string, unknown>;
          input.checked = true;
          if (input.block === true) return { block: true, reason: "extension policy" };
        });
        rigyn.on("tool_result", (event) => {
          observe("tool_result")(event);
          return {
            content: [...event.content, { type: "text", text: ":extension" }],
            details: { source: "extension" },
            isError: true,
          };
        });
        rigyn.on("context", (event) => {
          observe("context")(event);
          return { messages: event.messages.filter((entry) => entry.role !== "toolResult") };
        });
        rigyn.on("input", (event) => {
          observe("input")(event);
          return {
            action: "transform",
            text: `${event.text}:extension`,
            ...(event.images === undefined ? {} : { images: event.images }),
          };
        });
        rigyn.on("model_select", observe("model_select"));
        rigyn.on("thinking_level_select", observe("thinking_level_select"));
        rigyn.on("before_provider_request", (event) => {
          observe("before_provider_request")(event);
          return { ...(event.payload as Record<string, unknown>), extension: true };
        });
        rigyn.on("before_provider_headers", (event) => {
          observe("before_provider_headers")(event);
          event.headers["x-added"] = "yes";
          event.headers["x-remove"] = null;
        });
        rigyn.on("after_provider_response", observe("after_provider_response"));
        rigyn.on("user_bash", (event) => {
          observe("user_bash")(event);
          return event.command === "handled"
            ? { result: { output: "extension output", exitCode: 7, cancelled: false, truncated: false } }
            : undefined;
        });
      },
    }],
  });
  context.after(async () => await host.close());

  const user = message("msg-user", "user", "hello");
  const assistant = message("msg-assistant", "assistant", "answer");
  const tool = message("msg-tool", "tool", "tool output");
  const compactionEntry = {
    type: "compaction" as const,
    id: "compaction-1",
    parentId: "entry-keep",
    timestamp: "2026-01-01T00:00:00.000Z",
    summary: "summary",
    firstKeptEntryId: "entry-keep",
    tokensBefore: 42,
  };

  assert.deepEqual(await host.resolveProjectTrust({ workspace: root, cwd: root }), {
    decision: "yes",
    remember: true,
  });
  const resources = await host.discoverResources("startup");
  assert.deepEqual(resources.skillPaths.map((entry) => entry.path), ["skills"]);
  assert.deepEqual(resources.promptPaths.map((entry) => entry.path), ["prompts"]);
  assert.deepEqual(resources.themePaths.map((entry) => entry.path), ["themes"]);

  await host.dispatch("session_start", { reason: "startup" } as never);
  await host.dispatch("session_info_changed", { name: "named session" } as never);
  await host.dispatch("session_shutdown", { reason: "quit" } as never);
  assert.deepEqual(await host.reduceSessionBeforeSwitch({ reason: "resume", targetSessionFile: "/tmp/session.jsonl" } as never), {
    cancel: true,
  });
  assert.deepEqual(await host.reduceSessionBeforeFork({ entryId: "entry-keep", position: "at" } as never), {
    cancel: true,
    skipConversationRestore: true,
  });
  const treeSignal = new AbortController().signal;
  assert.deepEqual(await host.reduceSessionBeforeTree({
    preparation: {
      targetId: "entry-keep",
      oldLeafId: "entry-old",
      commonAncestorId: null,
      entriesToSummarize: [],
      userWantsSummary: true,
    },
    signal: treeSignal,
  }), {
    summary: { summary: "extension tree summary", details: { source: "extension" } },
    customInstructions: "focus on the selected branch",
    replaceInstructions: true,
    label: "selected",
  });
  await host.dispatch("session_tree", { newLeafId: "entry-keep", oldLeafId: "entry-old" } as never);
  const compactSignal = new AbortController().signal;
  assert.deepEqual(await host.reduceSessionBeforeCompact({
    preparation: {
      firstKeptEntryId: "entry-keep",
      messagesToSummarize: [user],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 42,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 8, keepRecentTokens: 16 },
    },
    branchEntries: [],
    reason: "manual",
    willRetry: false,
    signal: compactSignal,
  }), {
    compaction: {
      summary: "extension compact summary",
      firstKeptEntryId: "entry-keep",
      tokensBefore: 42,
      estimatedTokensAfter: 12,
      details: { source: "extension" },
    },
  });
  await host.dispatch("session_compact", {
    compactionEntry,
    fromExtension: true,
    reason: "manual",
    willRetry: false,
  } as never);

  const beforeAgent = await host.reduceBeforeAgentStart({
    threadId: "thread-1",
    runId: "run-1",
    branch: "main",
    step: 1,
    prompt: "build",
    systemPrompt: "base prompt",
    systemPromptOptions: { cwd: root, selectedTools: [] },
  });
  assert.equal(beforeAgent.systemPrompt, "base prompt\nextension prompt");
  assert.deepEqual(beforeAgent.messages.map((entry) => entry.customType), ["injected"]);

  await host.dispatch("agent_start", {} as never);
  await host.dispatch("agent_end", { messages: [assistant] } as never);
  await host.dispatch("agent_settled", {} as never);
  await host.dispatch("turn_start", { turnIndex: 0, timestamp: 1 } as never);
  await host.dispatch("turn_end", { turnIndex: 0, message: assistant, toolResults: [] } as never);
  await host.dispatch("message_start", { message: assistant } as never);
  await host.dispatch("message_update", {
    message: assistant,
    assistantMessageEvent: { type: "text_delta", delta: "answer" },
  } as never);
  const ended = await host.reduceMessageEnd({
    threadId: "thread-1",
    runId: "run-1",
    branch: "main",
    step: 1,
    message: assistant,
  });
  const finalBlock = ended.content.at(-1);
  assert.equal(finalBlock?.type, "text");
  assert.equal(finalBlock?.type === "text" ? finalBlock.text : undefined, "extension display");
  await host.dispatch("tool_execution_start", { toolCallId: "call-1", toolName: "demo", args: { value: 1 } } as never);
  await host.dispatch("tool_execution_update", {
    toolCallId: "call-1",
    toolName: "demo",
    args: { value: 1 },
    partialResult: { content: "working" },
  } as never);
  await host.dispatch("tool_execution_end", {
    toolCallId: "call-1",
    toolName: "demo",
    args: { value: 1 },
    result: { content: "done", isError: false },
    isError: false,
  } as never);

  const runScope = { threadId: "thread-1", runId: "run-1", branch: "main", step: 1 };
  const allowed = await host.reduceToolCall({
    ...runScope,
    callId: "call-1",
    name: "demo",
    input: { value: 1 },
    index: 0,
  });
  assert.deepEqual(allowed.invocation.input, { value: 1, checked: true });
  assert.equal(allowed.blocked, false);
  const blocked = await host.reduceToolCall({
    ...runScope,
    callId: "call-2",
    name: "demo",
    input: { block: true },
    index: 1,
  });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, "extension policy");
  assert.deepEqual(await host.reduceToolResult({
    ...runScope,
    invocation: allowed.invocation,
    result: { content: "base", isError: false },
  }), {
    content: "base:extension",
    contentBlocks: [
      { type: "text", text: "base" },
      { type: "text", text: ":extension" },
    ],
    isError: true,
    metadata: { source: "extension" },
  });
  assert.deepEqual((await host.reduceContext({ ...runScope, messages: [user, tool] })).map((entry) => entry.id), ["msg-user"]);
  assert.deepEqual(await host.reduceInput({
    threadId: "thread-1",
    branch: "main",
    text: "hello",
    source: "interactive",
  }), { action: "transform", text: "hello:extension" });

  const model = {
    id: "fixture-model",
    name: "Fixture model",
    api: "openai_responses" as const,
    provider: "fixture",
    baseUrl: "https://example.test/v1",
    reasoning: true,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 4_096,
  };
  await host.dispatch("model_select", { model, previousModel: undefined, source: "set" } as never);
  await host.dispatch("thinking_level_select", { level: "high", previousLevel: "medium" } as never);
  assert.deepEqual(await host.reduceBeforeUserShell({ command: "handled", cwd: root, hidden: true }), {
    action: "handled",
    command: "handled",
    cwd: root,
    result: { text: "extension output", exitCode: 7 },
  });

  const request = await host.applyBeforeProviderRequestPayload({ model: "fixture-model" });
  assert.deepEqual(request, { model: "fixture-model", extension: true });
  const headers = { "x-remove": "yes" } as Record<string, string | null>;
  await host.applyBeforeProviderHeaders(headers);
  assert.deepEqual(headers, { "x-remove": null, "x-added": "yes" });
  await host.observeAfterProviderResponse(201, { "x-request-id": "request-1" });

  assert.deepEqual([...new Set(seen)].sort(), [...DIRECT_EVENTS].sort());
  assert.equal((payloads.get("session_info_changed") as { name: string }).name, "named session");
  assert.equal((payloads.get("session_compact") as { compactionEntry: { summary: string } }).compactionEntry.summary, "summary");
  assert.equal((payloads.get("tool_execution_update") as { partialResult: { content: string } }).partialResult.content, "working");
  assert.equal((payloads.get("after_provider_response") as { status: number }).status, 201);
});

test("provider transport gives trusted direct hooks assembled request and complete response headers", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-direct-wire-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const observed: Array<{ status: number; headers: Record<string, string> }> = [];
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    inlineExtensions: [(rigyn) => {
      rigyn.on("before_provider_request", (event) => ({
        ...(event.payload as Record<string, unknown>),
        extension: true,
      }));
      rigyn.on("before_provider_headers", (event) => {
        assert.equal(event.headers.authorization, "Bearer secret");
        event.headers.authorization = "Bearer extension-replacement";
        event.headers["x-added"] = "yes";
        event.headers["x-remove"] = null;
      });
      rigyn.on("after_provider_response", (event) => {
        observed.push({
          status: event.status,
          headers: { ...event.headers },
        });
      });
    }],
  });
  const wire = new ProviderWireInterceptorRegistry();
  const unbind = bindDirectProviderWireLifecycle(host, wire);
  context.after(async () => {
    unbind();
    await host.close();
  });

  let outgoingBody: unknown;
  let outgoingHeaders: Headers | undefined;
  const wrapped = wire.wrapFetch("fixture", async (input, init) => {
    const request = new Request(input, init);
    outgoingBody = await request.clone().json();
    outgoingHeaders = new Headers(request.headers);
    return new Response("{}", {
      status: 201,
      headers: {
        "content-type": "application/json",
        "set-cookie": "secret-cookie",
        "x-request-id": "request-1",
      },
    });
  });
  await wire.withScope({ threadId: "thread-1", runId: "run-1", branch: "main", step: 1 }, async () => {
    await wrapped("https://example.test/v1/responses?api_key=secret", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-remove": "yes",
      },
      body: JSON.stringify({ model: "fixture-model" }),
    });
  });

  assert.deepEqual(outgoingBody, { model: "fixture-model", extension: true });
  assert.equal(outgoingHeaders?.get("authorization"), "Bearer extension-replacement");
  assert.equal(outgoingHeaders?.get("x-added"), "yes");
  assert.equal(outgoingHeaders?.has("x-remove"), false);
  assert.deepEqual(observed, [{
    status: 201,
    headers: {
      "content-type": "application/json",
      "set-cookie": "secret-cookie",
      "x-request-id": "request-1",
    },
  }]);
});
