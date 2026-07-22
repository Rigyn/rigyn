import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentMessage, ToolResultMessage } from "@rigyn/kernel";

import type { CanonicalMessage, NormalizedUsage, ProviderState, ToolResultBlock } from "../../src/core/types.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import {
  canonicalMessage,
  canonicalUsage,
  extensionMessage,
  extensionSessionManager,
  extensionToolResult,
  extensionUsage,
} from "../../src/extensions/session-contract.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { AgentSession, type AgentSessionEvent } from "../../src/service/agent-session.js";
import { SessionManager } from "../../src/storage/session-manager.js";

const normalizedUsage: NormalizedUsage = {
  inputTokens: 7,
  outputTokens: 3,
  cacheReadTokens: 2,
  cacheWriteTokens: 1,
  cacheWrite1hTokens: 1,
  reasoningTokens: 2,
  totalTokens: 13,
  cost: { input: 0.07, output: 0.06, cacheRead: 0.002, cacheWrite: 0.004, total: 0.136 },
};

test("extension usage conversion preserves cache, reasoning, and cost semantics", () => {
  const exposed = extensionUsage(normalizedUsage);
  assert.deepEqual(exposed, {
    input: 7,
    output: 3,
    cacheRead: 2,
    cacheWrite: 1,
    cacheWrite1h: 1,
    reasoning: 2,
    totalTokens: 13,
    cost: { input: 0.07, output: 0.06, cacheRead: 0.002, cacheWrite: 0.004, total: 0.136 },
  });
  assert.deepEqual(canonicalUsage(exposed), normalizedUsage);
  assert.throws(
    () => canonicalUsage({ ...exposed, totalTokens: 12 }),
    /totalTokens must equal/u,
  );
});

test("message conversion uses public image and assistant message contracts without losing host state", () => {
  const user: CanonicalMessage = {
    id: "message-user",
    role: "user",
    content: [
      { type: "text", text: "inspect" },
      { type: "image", mediaType: "image/png", data: "aW1hZ2U=" },
    ],
    createdAt: "2026-07-21T00:00:00.000Z",
  };
  const publicUser = extensionMessage(user);
  assert.equal(publicUser.role, "user");
  assert.deepEqual(publicUser.content, [
    { type: "text", text: "inspect" },
    { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
  ]);
  assert.deepEqual(canonicalMessage(publicUser, user), user);

  const assistant: CanonicalMessage & { providerState: ProviderState } = {
    id: "message-assistant",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private plan", thinkingSignature: "thinking-signature", redacted: true },
      { type: "text", text: "done", textSignature: "text-signature" },
      {
        type: "tool_call",
        callId: "call-signed",
        name: "inspect",
        arguments: { path: "README.md" },
        thoughtSignature: "tool-signature",
      },
    ],
    createdAt: "2026-07-21T00:00:01.000Z",
    provider: "custom-provider",
    model: "custom-model",
    api: "gateway-messages",
    publicApi: "custom-stream",
    responseModel: "custom-model-revision",
    responseId: "custom-response",
    diagnostics: [{
      type: "provider_response",
      message: "Provider response received",
      details: { response: { status: 200, headers: { "x-request-id": "custom-request" } } },
      timestamp: Date.parse("2026-07-21T00:00:01.000Z"),
    }],
    providerState: { kind: "gateway_messages", assistantContent: [{ continuation: "opaque" }] },
    usage: normalizedUsage,
    stopReason: "stop",
  };
  const publicAssistant = extensionMessage(assistant);
  if (publicAssistant.role !== "assistant") assert.fail("Expected an assistant message");
  assert.equal(publicAssistant.api, "custom-stream");
  assert.equal(publicAssistant.responseModel, "custom-model-revision");
  assert.equal(publicAssistant.responseId, "custom-response");
  assert.deepEqual(publicAssistant.diagnostics, assistant.diagnostics);
  assert.deepEqual(publicAssistant.content, [
    { type: "thinking", thinking: "private plan", thinkingSignature: "thinking-signature", redacted: true },
    { type: "text", text: "done", textSignature: "text-signature" },
    {
      type: "toolCall",
      id: "call-signed",
      name: "inspect",
      arguments: { path: "README.md" },
      thoughtSignature: "tool-signature",
    },
  ]);
  assert.deepEqual(publicAssistant.providerState?.value, {
    kind: "gateway_messages",
    assistantContent: [{ continuation: "opaque" }],
  });
  assert.deepEqual(canonicalMessage(publicAssistant, assistant), assistant);
  assert.throws(
    () => canonicalMessage({ ...publicAssistant, responseId: "forged-response" }, assistant),
    /response metadata is host-owned/u,
  );
  assert.throws(
    () => canonicalMessage({
      ...publicAssistant,
      diagnostics: [{
        type: "forged",
        message: "api_key=sk-proj-forged-secret-value",
        timestamp: Date.now(),
      }],
    }, assistant),
    /response metadata is host-owned/u,
  );
  const { providerState: _providerState, ...withoutProviderState } = publicAssistant;
  assert.throws(
    () => canonicalMessage(withoutProviderState, undefined),
    /response metadata cannot be introduced/u,
  );
});

test("assistant diagnostics are redacted before public extension projection", () => {
  const exposed = extensionMessage({
    id: "message-secret-diagnostic",
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    createdAt: "2026-07-21T00:00:01.000Z",
    provider: "provider",
    model: "model",
    diagnostics: [{
      type: "provider_failure",
      message: "api_key=sk-proj-abcdefghijklmnop",
      details: {
        authorization: "Bearer sk-proj-abcdefghijklmnop",
        nested: { access_token: "sk-proj-abcdefghijklmnop" },
      },
      timestamp: Date.parse("2026-07-21T00:00:01.000Z"),
    }],
  });
  if (exposed.role !== "assistant") assert.fail("Expected an assistant message");
  assert.deepEqual(exposed.diagnostics, [{
    type: "provider_failure",
    message: "api_key=[REDACTED]",
    details: {
      authorization: "[REDACTED]",
      nested: { access_token: "[REDACTED]" },
    },
    timestamp: Date.parse("2026-07-21T00:00:01.000Z"),
  }]);
  assert.throws(() => extensionMessage({
    id: "message-oversized-diagnostic",
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    createdAt: "2026-07-21T00:00:01.000Z",
    diagnostics: [{
      type: "provider_failure",
      message: "x".repeat(4 * 1024 + 1),
      timestamp: Date.parse("2026-07-21T00:00:01.000Z"),
    }],
  }), /byte limit/u);
  assert.throws(() => extensionMessage({
    id: "message-non-json-diagnostic",
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    createdAt: "2026-07-21T00:00:01.000Z",
    diagnostics: [{
      type: "provider_failure",
      message: "failed",
      details: { invalid: undefined },
      timestamp: Date.parse("2026-07-21T00:00:01.000Z"),
    }],
  }), /JSON-safe/u);
});

test("signed assistant content survives JSONL persistence and public session projection", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-signed-session-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, join(root, "sessions"), { id: "signed" });
  manager.appendMessage({
    id: "signed-assistant",
    role: "assistant",
    provider: "signed-provider",
    model: "signed-model",
    api: "gateway-messages",
    content: [
      { type: "thinking", thinking: "plan", thinkingSignature: "thinking-signature", redacted: true },
      { type: "text", text: "answer", textSignature: "text-signature" },
      {
        type: "tool_call",
        callId: "signed-call",
        name: "read",
        arguments: { path: "README.md" },
        thoughtSignature: "tool-signature",
      },
    ],
    createdAt: "2026-07-21T00:00:00.000Z",
    stopReason: "tool_calls",
  });

  const reopened = SessionManager.open(manager.getSessionFile()!);
  const entry = extensionSessionManager(reopened).getEntries()[0];
  assert.equal(entry?.type, "message");
  assert.deepEqual(entry?.type === "message" ? entry.message : undefined, {
    role: "assistant",
    provider: "signed-provider",
    model: "signed-model",
    api: "rigyn-messages",
    content: [
      { type: "thinking", thinking: "plan", thinkingSignature: "thinking-signature", redacted: true },
      { type: "text", text: "answer", textSignature: "text-signature" },
      {
        type: "toolCall",
        id: "signed-call",
        name: "read",
        arguments: { path: "README.md" },
        thoughtSignature: "tool-signature",
      },
    ],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.parse("2026-07-21T00:00:00.000Z"),
  });
});

test("tool results retain ordered content, details, usage, and dynamically added tools", () => {
  const block: ToolResultBlock = {
    type: "tool_result",
    callId: "call-1",
    name: "inspect",
    content: "firstlast",
    contentBlocks: [
      { type: "text", text: "first" },
      { type: "image", mediaType: "image/jpeg", data: "aW1hZ2U=" },
      { type: "text", text: "last" },
    ],
    metadata: { path: "result.txt" },
    addedToolNames: ["follow_up"],
    isError: false,
  };
  const canonical: CanonicalMessage = {
    id: "message-tool",
    role: "tool",
    content: [block],
    createdAt: "2026-07-21T00:00:02.000Z",
    usage: normalizedUsage,
  };
  const exposed = extensionToolResult(canonical, block);
  assert.deepEqual(exposed.content, [
    { type: "text", text: "first" },
    { type: "image", mimeType: "image/jpeg", data: "aW1hZ2U=" },
    { type: "text", text: "last" },
  ]);
  assert.deepEqual(exposed.details, { path: "result.txt" });
  assert.deepEqual(exposed.addedToolNames, ["follow_up"]);
  assert.deepEqual(exposed.usage, extensionUsage(normalizedUsage));

  const roundTrip = canonicalMessage(exposed, canonical);
  assert.equal(roundTrip.role, "tool");
  assert.deepEqual(roundTrip.content[0], { ...block, images: [block.contentBlocks![1]] });
  assert.deepEqual(roundTrip.usage, normalizedUsage);
});

test("extension session facade projects a canonical tool batch as individual public messages", () => {
  const manager = SessionManager.inMemory("/tmp", { id: "session-contract" });
  const userId = manager.appendMessage({
    id: "message-user",
    role: "user",
    content: [{ type: "text", text: "run both" }],
    createdAt: "2026-07-21T00:00:00.000Z",
  });
  const toolId = manager.appendMessage({
    id: "message-tools",
    role: "tool",
    content: [
      { type: "tool_result", callId: "call-1", name: "one", content: "first", isError: false },
      { type: "tool_result", callId: "call-2", name: "two", content: "second", isError: true },
    ],
    createdAt: "2026-07-21T00:00:01.000Z",
  });
  const session = extensionSessionManager(manager);
  const entries = session.getEntries();
  assert.deepEqual(entries.map((entry) => entry.type === "message" ? entry.message.role : entry.type), [
    "user",
    "toolResult",
    "toolResult",
  ]);
  assert.equal(entries[1]?.id, toolId);
  assert.equal(entries[1]?.parentId, userId);
  assert.equal(entries[2]?.id, `${toolId}~1`);
  assert.equal(entries[2]?.parentId, toolId);
  assert.equal(session.getLeafId(), `${toolId}~1`);
  assert.deepEqual(
    entries.slice(1).map((entry) => (entry as { message: ToolResultMessage }).message.toolName),
    ["one", "two"],
  );

  const publicMessage: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: "continue" }],
    timestamp: Date.parse("2026-07-21T00:00:02.000Z"),
  };
  session.appendMessage(publicMessage);
  assert.equal(manager.getLeafEntry()?.type, "message");
  const leaf = session.getLeafEntry();
  assert.deepEqual(leaf?.type === "message" ? leaf.message : undefined, publicMessage);
});

test("AgentSession publishes queue and committed-session lifecycle events", async (context) => {
  const cwd = await mkdtemp(join(tmpdir(), "rigyn-session-events-"));
  context.after(async () => await rm(cwd, { recursive: true, force: true }));
  const session = await AgentSession.create({
    sessionManager: SessionManager.inMemory(cwd, { id: "public-events" }),
    providers: new ProviderRegistry(),
    workspace: cwd,
    settingsManager: SettingsManager.inMemory(),
  });
  context.after(async () => await session.close());
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => { events.push(event); });

  session.appendCustomEntry("marker", { ready: true });
  session.setSessionName("Contract test");
  const thinkingLevel = session.thinkingLevel === "low" ? "high" : "low";
  session.setThinkingLevel(thinkingLevel);
  session.steer("queued message");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.ok(events.some((event) => event.type === "entry_appended" && event.entry.type === "custom"));
  assert.ok(events.some((event) => event.type === "session_info_changed" && event.name === "Contract test"));
  assert.ok(events.some((event) => event.type === "thinking_level_changed" && event.level === thinkingLevel));
  assert.ok(events.some((event) => (
    event.type === "queue_update" && event.steering.includes("queued message")
  )));
});
