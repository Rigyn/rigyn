import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanonicalMessage, ContentBlock, ToolCallBlock, ToolResultBlock } from "../../src/core/types.js";
import { buildContextProjection, projectMessagesForProvider } from "../../src/context/index.js";

const timestamp = "2026-01-01T00:00:00.000Z";

function message(
  id: string,
  role: CanonicalMessage["role"],
  content: ContentBlock[],
  provider?: string,
): CanonicalMessage {
  return { id, role, content, createdAt: timestamp, ...(provider === undefined ? {} : { provider }) };
}

function textMessage(id: string, role: CanonicalMessage["role"], text: string): CanonicalMessage {
  return message(id, role, [{ type: "text", text }]);
}

function toolCall(messages: readonly CanonicalMessage[], id: string): ToolCallBlock {
  const block = messages.flatMap((entry) => entry.content).find(
    (entry): entry is ToolCallBlock => entry.type === "tool_call" && entry.name === id,
  );
  assert.ok(block, `missing tool call ${id}`);
  return block;
}

function toolResult(messages: readonly CanonicalMessage[], id: string): ToolResultBlock {
  const block = messages.flatMap((entry) => entry.content).find(
    (entry): entry is ToolResultBlock => entry.type === "tool_result" && entry.name === id,
  );
  assert.ok(block, `missing tool result ${id}`);
  return block;
}

test("unsafe source tool IDs are deterministically normalized with their matching results", () => {
  const unsafeId = `call_source|${"+/=unsafe".repeat(80)}`;
  const messages = [
    textMessage("u1", "user", "inspect"),
    message("a1", "assistant", [
      { type: "tool_call", callId: unsafeId, name: "read", arguments: { path: "file.ts" } },
    ], "openai-codex"),
    message("t1", "tool", [
      { type: "tool_result", callId: unsafeId, name: "read", content: "contents", isError: false },
    ]),
    textMessage("u2", "user", "continue"),
  ];
  const original = structuredClone(messages);

  const first = projectMessagesForProvider(messages, "anthropic");
  const second = projectMessagesForProvider(messages, "anthropic");
  const call = toolCall(first, "read");
  const result = toolResult(first, "read");

  assert.match(call.callId, /^[A-Za-z0-9_-]+$/u);
  assert.ok(call.callId.length <= 64);
  assert.notEqual(call.callId, unsafeId);
  assert.equal(result.callId, call.callId);
  assert.deepEqual(second, first);
  assert.deepEqual(messages, original);
  assert.equal(messages[1]?.content[0]?.type, "tool_call");
  assert.equal(messages[1]?.content[0]?.type === "tool_call" ? messages[1].content[0].callId : "", unsafeId);
});

test("valid unique tool IDs and complete groups retain their original objects", () => {
  const messages = [
    textMessage("u1", "user", "inspect"),
    message("a1", "assistant", [
      { type: "tool_call", callId: "call_valid-1", name: "read", arguments: { path: "file.ts" } },
    ]),
    message("t1", "tool", [
      { type: "tool_result", callId: "call_valid-1", name: "read", content: "contents", isError: false },
    ]),
    textMessage("u2", "user", "continue"),
  ];

  const projected = projectMessagesForProvider(messages, "openai");
  assert.deepEqual(projected, messages);
  projected.forEach((entry, index) => assert.strictEqual(entry, messages[index]));
  assert.strictEqual(projected[1]?.content[0], messages[1]?.content[0]);
  assert.strictEqual(projected[2]?.content[0], messages[2]?.content[0]);
});

test("reused tool IDs are made unique across turns without breaking result correlation", () => {
  const pair = (prefix: string): CanonicalMessage[] => [
    textMessage(`${prefix}-u`, "user", prefix),
    message(`${prefix}-a`, "assistant", [
      { type: "tool_call", callId: "call_reused", name: `${prefix}-tool`, arguments: {} },
    ]),
    message(`${prefix}-t`, "tool", [
      { type: "tool_result", callId: "call_reused", name: `${prefix}-tool`, content: prefix, isError: false },
    ]),
  ];
  const messages = [...pair("first"), ...pair("second"), textMessage("next", "user", "next")];

  const projected = projectMessagesForProvider(messages, "bedrock");
  const firstCall = toolCall(projected, "first-tool");
  const secondCall = toolCall(projected, "second-tool");
  assert.equal(firstCall.callId, "call_reused");
  assert.notEqual(secondCall.callId, firstCall.callId);
  assert.equal(toolResult(projected, "first-tool").callId, firstCall.callId);
  assert.equal(toolResult(projected, "second-tool").callId, secondCall.callId);
});

test("historical incomplete, mismatched, duplicate, and orphan tool blocks are filtered", () => {
  const messages = [
    textMessage("u1", "user", "old turn"),
    message("a1", "assistant", [
      { type: "text", text: "working" },
      { type: "tool_call", callId: "missing", name: "missing-tool", arguments: {} },
      { type: "tool_call", callId: "paired", name: "paired-tool", arguments: {} },
      { type: "tool_call", callId: "paired", name: "duplicate-call", arguments: {} },
      { type: "tool_call", callId: "wrong-name", name: "expected-name", arguments: {} },
    ]),
    message("t1", "tool", [
      { type: "tool_result", callId: "orphan", name: "orphan-tool", content: "orphan", isError: true },
      { type: "tool_result", callId: "paired", name: "paired-tool", content: "ok", isError: false },
      { type: "tool_result", callId: "paired", name: "paired-tool", content: "duplicate", isError: false },
      { type: "tool_result", callId: "wrong-name", name: "different-name", content: "bad", isError: false },
    ]),
    textMessage("a2", "assistant", "old turn finished"),
    textMessage("u2", "user", "new turn"),
  ];

  const projected = projectMessagesForProvider(messages, "openai");
  const blocks = projected.flatMap((entry) => entry.content);
  const calls = blocks.filter((entry): entry is ToolCallBlock => entry.type === "tool_call");
  const results = blocks.filter((entry): entry is ToolResultBlock => entry.type === "tool_result");
  assert.deepEqual(calls.map((entry) => [entry.callId, entry.name]), [["paired", "paired-tool"]]);
  assert.deepEqual(results.map((entry) => [entry.callId, entry.name, entry.content]), [["paired", "paired-tool", "ok"]]);
  assert.ok(projected.some((entry) => entry.id === "a1" && entry.content.some((block) => block.type === "text")));
  assert.equal(blocks.some((entry) => entry.type === "tool_call" && entry.callId === "missing"), false);
  assert.equal(blocks.some((entry) => entry.type === "tool_result" && entry.callId === "orphan"), false);
});

test("a pending call in the current turn is retained and remains visible to compaction", () => {
  const messages = [
    textMessage("u1", "user", "current turn"),
    message("a1", "assistant", [
      { type: "tool_call", callId: "pending", name: "shell", arguments: { command: "sleep" } },
    ]),
  ];

  const projection = buildContextProjection(messages, "openai");
  assert.strictEqual(projection.messages[1], messages[1]);
  assert.deepEqual(projection.groups[0]?.pendingToolCallIds, ["pending"]);
});

test("explicitly unsupported images become bounded non-secret text markers", () => {
  const image = {
    type: "image" as const,
    mediaType: `image/custom-${"x".repeat(300)}\nsecret-label`,
    data: "private-base64-data",
    url: "https://secret.example/image.png?token=secret",
  };
  const messages = [message("u1", "user", [{ type: "text", text: "describe" }, image])];

  const supported = projectMessagesForProvider(messages, "anthropic");
  assert.strictEqual(supported[0], messages[0]);
  assert.strictEqual(supported[0]?.content[1], image);

  const unsupported = projectMessagesForProvider(messages, "anthropic", { supportsImages: false });
  assert.equal(unsupported[0]?.content.some((block) => block.type === "image"), false);
  const marker = unsupported[0]?.content.findLast((block) => block.type === "text");
  assert.equal(marker?.type, "text");
  const text = marker?.type === "text" ? marker.text : "";
  assert.match(text, /^\[Image omitted:/u);
  assert.ok(text.length <= 96);
  assert.doesNotMatch(text, /private-base64-data|secret\.example|token=secret/u);
  assert.strictEqual(messages[0]?.content[1], image);
});

test("outbound image policy blocks sources independently of model capability while unknown remains allowed", () => {
  const data = "blocked-base64-sentinel";
  const url = "https://private.example.test/image.png?sentinel=blocked-url";
  const messages = [message("u1", "user", [
    { type: "image", mediaType: "image/png", data },
    { type: "image", mediaType: "image/jpeg", url },
  ])];

  const unknown = projectMessagesForProvider(messages, "openai", { outboundImages: "allow" });
  assert.strictEqual(unknown[0], messages[0]);

  for (const options of [
    { outboundImages: "block" as const, supportsImages: true },
    { outboundImages: "allow" as const, supportsImages: false },
  ]) {
    const projected = projectMessagesForProvider(messages, "openai", options);
    const serialized = JSON.stringify(projected);
    assert.equal(projected.flatMap((entry) => entry.content).some((block) => block.type === "image"), false);
    assert.doesNotMatch(serialized, /blocked-base64-sentinel|blocked-url|private\.example/u);
    assert.match(serialized, /Image omitted/u);
  }
  assert.throws(
    () => projectMessagesForProvider(messages, "openai", { outboundImages: "invalid" as "allow" }),
    /allow or block/u,
  );
});

test("unsupported tool-result images stay correlated and downgrade without exposing payloads", () => {
  const image = { type: "image" as const, mediaType: "image/png", data: "private-image-payload" };
  const messages = [
    textMessage("u1", "user", "inspect"),
    message("a1", "assistant", [
      { type: "tool_call", callId: "read-image", name: "read", arguments: { path: "pixel.png" } },
    ]),
    message("t1", "tool", [{
      type: "tool_result",
      callId: "read-image",
      name: "read",
      content: "attached",
      isError: false,
      images: [image],
    }]),
  ];
  const supported = projectMessagesForProvider(messages, "anthropic");
  assert.strictEqual(supported[2], messages[2]);

  const unsupported = projectMessagesForProvider(messages, "anthropic", { supportsImages: false });
  const result = unsupported[2]?.content[0];
  assert.equal(result?.type, "tool_result");
  assert.equal(result?.type === "tool_result" ? result.images : undefined, undefined);
  assert.match(result?.type === "tool_result" ? result.content : "", /Image omitted: image\/png/u);
  assert.doesNotMatch(result?.type === "tool_result" ? result.content : "", /private-image-payload/u);
  assert.strictEqual(messages[2]?.content[0]?.type === "tool_result" ? messages[2].content[0].images?.[0] : undefined, image);
});

test("foreign provider-only blocks are removed without discarding visible assistant text", () => {
  const opaque = {
    type: "provider_opaque" as const,
    provider: "openai",
    mediaType: "application/json",
    value: { encrypted: "state" },
  };
  const messages = [
    textMessage("u1", "user", "question"),
    message("a1", "assistant", [{ type: "text", text: "visible answer" }, opaque], "openai"),
    message("a2", "assistant", [opaque], "openai"),
  ];

  const foreign = projectMessagesForProvider(messages, "anthropic");
  assert.deepEqual(foreign.map((entry) => entry.id), ["u1", "a1"]);
  assert.deepEqual(foreign[1]?.content, [{ type: "text", text: "visible answer" }]);

  const source = projectMessagesForProvider(messages, "openai");
  assert.deepEqual(source, messages);
  source.forEach((entry, index) => assert.strictEqual(entry, messages[index]));
});

test("provider provenance alone never causes visible assistant text to be guessed as failed", () => {
  const messages = [
    textMessage("u1", "user", "question"),
    message("a1", "assistant", [{ type: "text", text: "possibly partial but statusless" }], "openai"),
  ];
  const projected = projectMessagesForProvider(messages, "anthropic");
  assert.strictEqual(projected[1], messages[1]);
});
