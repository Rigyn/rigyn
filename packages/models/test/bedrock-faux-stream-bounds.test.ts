import assert from "node:assert/strict";
import test from "node:test";
import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import {
  createFauxTransport,
  fauxModel,
} from "../src/index.ts";
import { createBedrockConverseTransport } from "../src/api/bedrock-converse-stream.ts";
import { collect, model, userContext } from "./black-box-helpers.ts";

const ASSISTANT_FIELD_BYTES = 4 * 1024 * 1024;

function bedrockClient(events: readonly Record<string, unknown>[]): BedrockRuntimeClient {
  return {
    async send() {
      return {
        stream: (async function* () {
          for (const event of events) yield event;
        })(),
      };
    },
  } as unknown as BedrockRuntimeClient;
}

test("Faux bounds streamed fields, aggregate content, and tool identities", async () => {
  const field = await collect(createFauxTransport(() => ({
    text: ["x".repeat(ASSISTANT_FIELD_BYTES), "y"],
  }))(fauxModel, userContext(), {}));
  assert.equal(field.terminal.stopReason, "error");
  assert.match(field.terminal.errorMessage ?? "", /text content exceeded 4 MiB/u);
  assert.equal(field.events.filter((event) => event.type === "start").length, 1);

  const aggregate = await collect(createFauxTransport(() => ({
    thinking: "t".repeat(3 * 1024 * 1024),
    text: "x".repeat(3 * 1024 * 1024),
    toolCalls: [{ name: "tool", argumentChunks: ["a".repeat(3 * 1024 * 1024)] }],
  }))(fauxModel, userContext(), {}));
  assert.equal(aggregate.terminal.stopReason, "error");
  assert.match(aggregate.terminal.errorMessage ?? "", /assistant content exceeded 8 MiB/iu);

  const identity = await collect(createFauxTransport(() => ({
    toolCalls: [{ id: "i".repeat(1_025), name: "tool" }],
  }))(fauxModel, userContext(), {}));
  assert.equal(identity.terminal.stopReason, "error");
  assert.match(identity.terminal.errorMessage ?? "", /invalid tool-call ID/iu);
});

test("Bedrock bounds streamed fields, aggregate content, and tool identities", async () => {
  const selected = model("bedrock-converse-stream");
  const field = await collect(createBedrockConverseTransport({ client: bedrockClient([
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "x".repeat(ASSISTANT_FIELD_BYTES) } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "y" } } },
  ]) })(selected, userContext(), {}));
  assert.equal(field.terminal.stopReason, "error");
  assert.match(field.terminal.errorMessage ?? "", /text content exceeded 4 MiB/u);

  const aggregate = await collect(createBedrockConverseTransport({ client: bedrockClient([
    { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "t".repeat(3 * 1024 * 1024) } } } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { text: "x".repeat(3 * 1024 * 1024) } } },
    { contentBlockStart: { contentBlockIndex: 2, start: { toolUse: { toolUseId: "id", name: "tool" } } } },
    { contentBlockDelta: { contentBlockIndex: 2, delta: { toolUse: { input: "a".repeat(3 * 1024 * 1024) } } } },
  ]) })(model("bedrock-converse-stream", {
    id: "anthropic.claude-3-7-sonnet-v1:0",
    reasoning: true,
  }), userContext(), { reasoning: "high" }));
  assert.equal(aggregate.terminal.stopReason, "error");
  assert.match(aggregate.terminal.errorMessage ?? "", /assistant content exceeded 8 MiB/iu);

  const identity = await collect(createBedrockConverseTransport({ client: bedrockClient([
    { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "i".repeat(1_025), name: "tool" } } } },
  ]) })(selected, userContext(), {}));
  assert.equal(identity.terminal.stopReason, "error");
  assert.match(identity.terminal.errorMessage ?? "", /invalid tool-call ID/iu);
});

test("Bedrock and Faux retain detached cumulative partials across fragmented text", async () => {
  const faux = await collect(createFauxTransport(() => ({ text: ["a", "b"] }))(
    fauxModel,
    userContext(),
    {},
  ));
  const fauxDeltas = faux.events.filter((event) => event.type === "text_delta");
  assert.equal(fauxDeltas[0]?.partial.content[0]?.type === "text" ? fauxDeltas[0].partial.content[0].text : "", "a");
  assert.equal(fauxDeltas[1]?.partial.content[0]?.type === "text" ? fauxDeltas[1].partial.content[0].text : "", "ab");
  if (fauxDeltas[0]?.partial.content[0]?.type === "text") fauxDeltas[0].partial.content[0].text = "mutated";
  assert.equal(fauxDeltas[1]?.partial.content[0]?.type === "text" ? fauxDeltas[1].partial.content[0].text : "", "ab");

  const bedrock = await collect(createBedrockConverseTransport({ client: bedrockClient([
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "a" } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "b" } } },
    { messageStop: { stopReason: "end_turn" } },
    { metadata: {} },
  ]) })(model("bedrock-converse-stream"), userContext(), {}));
  const bedrockDeltas = bedrock.events.filter((event) => event.type === "text_delta");
  assert.equal(bedrockDeltas[0]?.partial.content[0]?.type === "text" ? bedrockDeltas[0].partial.content[0].text : "", "a");
  assert.equal(bedrockDeltas[1]?.partial.content[0]?.type === "text" ? bedrockDeltas[1].partial.content[0].text : "", "ab");
  if (bedrockDeltas[0]?.partial.content[0]?.type === "text") bedrockDeltas[0].partial.content[0].text = "mutated";
  assert.equal(bedrockDeltas[1]?.partial.content[0]?.type === "text" ? bedrockDeltas[1].partial.content[0].text : "", "ab");
});

test("Faux preserves highly fragmented chunks without overflowing its delivery queue", async () => {
  const pieces = Array.from({ length: 5_000 }, () => "x");
  const result = await collect(createFauxTransport(() => ({ text: pieces }))(
    fauxModel,
    userContext(),
    {},
  ));
  assert.equal(result.terminal.stopReason, "stop");
  assert.equal(result.terminal.content[0]?.type === "text" ? result.terminal.content[0].text.length : 0, pieces.length);
  assert.equal(result.events.filter((event) => event.type === "text_delta").length, pieces.length);
});

test("Bedrock and Faux do not deep-clone cumulative text for every partial", async (t) => {
  const originalStructuredClone = globalThis.structuredClone;
  let wholeMessageClones = 0;
  globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
    if (typeof value === "object" && value !== null && "role" in value && value.role === "assistant") {
      wholeMessageClones += 1;
    }
    return originalStructuredClone(value, options);
  }) as typeof structuredClone;
  t.after(() => { globalThis.structuredClone = originalStructuredClone; });

  const pieces = Array.from({ length: 1_024 }, () => "x".repeat(256));
  const faux = await collect(createFauxTransport(() => ({ text: pieces }))(
    fauxModel,
    userContext(),
    {},
  ));
  const bedrock = await collect(createBedrockConverseTransport({ client: bedrockClient([
    ...pieces.map((text) => ({ contentBlockDelta: { contentBlockIndex: 0, delta: { text } } })),
    { messageStop: { stopReason: "end_turn" } },
    { metadata: {} },
  ]) })(model("bedrock-converse-stream"), userContext(), {}));

  assert.equal(wholeMessageClones, 0);
  assert.equal(faux.terminal.content[0]?.type === "text" ? faux.terminal.content[0].text.length : 0, 256 * 1_024);
  assert.equal(bedrock.terminal.content[0]?.type === "text" ? bedrock.terminal.content[0].text.length : 0, 256 * 1_024);
});

test("Bedrock fails closed on malformed final tool JSON", async () => {
  for (const input of ["{invalid", "[]", "null", "42"]) {
    const result = await collect(createBedrockConverseTransport({ client: bedrockClient([
      { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "id", name: "tool" } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input } } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
    ]) })(model("bedrock-converse-stream"), userContext(), {}));

    assert.equal(result.terminal.stopReason, "error");
    assert.match(result.terminal.errorMessage ?? "", /valid JSON object/u);
    assert.equal(result.events.some((event) => event.type === "toolcall_end"), false);
  }
});

test("Bedrock requires messageStop then metadata and closes an open tool at metadata", async () => {
  const incomplete = await collect(createBedrockConverseTransport({ client: bedrockClient([
    { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "id", name: "tool" } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: "{\"q\":1}" } } } },
    { messageStop: { stopReason: "tool_use" } },
  ]) })(model("bedrock-converse-stream"), userContext(), {}));
  assert.equal(incomplete.terminal.stopReason, "error");
  assert.match(incomplete.terminal.errorMessage ?? "", /ended before metadata/u);
  assert.equal(incomplete.events.some((event) => event.type === "toolcall_end"), false);

  const terminal = await collect(createBedrockConverseTransport({ client: bedrockClient([
    { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "id", name: "tool" } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: "{\"q\":1}" } } } },
    { messageStop: { stopReason: "tool_use" } },
    { metadata: { usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 4, cacheWriteInputTokens: 3, totalTokens: 10 } } },
  ]) })(model("bedrock-converse-stream"), userContext(), {}));
  assert.equal(terminal.terminal.stopReason, "toolUse");
  assert.deepEqual(terminal.terminal.content, [{ type: "toolCall", id: "id", name: "tool", arguments: { q: 1 } }]);
  assert.deepEqual(terminal.events.map((event) => event.type), [
    "start", "toolcall_start", "toolcall_delta", "toolcall_end", "done",
  ]);
  assert.deepEqual(terminal.terminal.usage, {
    input: 2,
    output: 1,
    cacheRead: 4,
    cacheWrite: 3,
    totalTokens: 10,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
});

test("Bedrock rejects metadata before messageStop", async () => {
  const result = await collect(createBedrockConverseTransport({ client: bedrockClient([
    { metadata: { usage: { inputTokens: 2, outputTokens: 1 } } },
    { messageStop: { stopReason: "end_turn" } },
  ]) })(model("bedrock-converse-stream"), userContext(), {}));
  assert.equal(result.terminal.stopReason, "error");
  assert.match(result.terminal.errorMessage ?? "", /metadata arrived before messageStop/u);
});

test("Bedrock bounds hidden provider reasoning in the assistant aggregate", async () => {
  const hidden = new Uint8Array(3 * 1024 * 1024);
  const result = await collect(createBedrockConverseTransport({ client: bedrockClient([
    { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { redactedContent: hidden } } } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { reasoningContent: { redactedContent: hidden } } } },
    { contentBlockDelta: { contentBlockIndex: 2, delta: { reasoningContent: { redactedContent: hidden } } } },
    { messageStop: { stopReason: "end_turn" } },
  ]) })(model("bedrock-converse-stream"), userContext(), {}));
  assert.equal(result.terminal.stopReason, "error");
  assert.match(result.terminal.errorMessage ?? "", /assistant content exceeded 8 MiB/iu);
});

test("Bedrock and Faux reject over-complex tool arguments", async () => {
  const argumentsValue = { items: Array.from({ length: 9_000 }, (_, index) => index) };
  const raw = JSON.stringify(argumentsValue);
  const bedrock = await collect(createBedrockConverseTransport({ client: bedrockClient([
    { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "id", name: "tool" } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: raw } } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: "tool_use" } },
  ]) })(model("bedrock-converse-stream"), userContext(), {}));
  assert.equal(bedrock.terminal.stopReason, "error");
  assert.match(bedrock.terminal.errorMessage ?? "", /8192 JSON values/u);

  const faux = await collect(createFauxTransport(() => ({
    toolCalls: [{ name: "tool", arguments: argumentsValue }],
  }))(fauxModel, userContext(), {}));
  assert.equal(faux.terminal.stopReason, "error");
  assert.match(faux.terminal.errorMessage ?? "", /8192 JSON values/u);
});

test("Faux final tool arguments exactly match its streamed JSON", async () => {
  const malformed = await collect(createFauxTransport(() => ({
    toolCalls: [{ name: "tool", arguments: { q: 1 }, argumentChunks: ["{invalid"] }],
  }))(fauxModel, userContext(), {}));
  assert.equal(malformed.terminal.stopReason, "error");
  assert.match(malformed.terminal.errorMessage ?? "", /valid JSON object/u);
  assert.equal(malformed.events.some((event) => event.type === "toolcall_end"), false);

  const valid = await collect(createFauxTransport(() => ({
    toolCalls: [{ name: "tool", arguments: { ignored: true }, argumentChunks: ["{\"q\":", "1}"] }],
  }))(fauxModel, userContext(), {}));
  assert.equal(valid.terminal.stopReason, "toolUse");
  assert.deepEqual(valid.terminal.content, [{ type: "toolCall", id: "faux_tool_0", name: "tool", arguments: { q: 1 } }]);
});

test("Faux observes cancellation during a fragmented response", async () => {
  const controller = new AbortController();
  const stream = createFauxTransport(() => ({ text: Array.from({ length: 2_000 }, () => "x") }))(
    fauxModel,
    userContext(),
    { signal: controller.signal },
  );
  const events = [];
  for await (const event of stream) {
    events.push(event);
    if (event.type === "text_delta") controller.abort();
  }
  const terminal = await stream.result();
  assert.equal(terminal.stopReason, "aborted");
  assert.equal(terminal.errorMessage, undefined);
  assert.equal(terminal.content[0]?.type === "text" ? terminal.content[0].text.length : 0, 256);
  assert.equal(events.filter((event) => event.type === "text_delta").length, 256);
});

test("Bedrock replays private assistant state only for the exact selected model boundary", async () => {
  const selected = model("bedrock-converse-stream", {
    id: "new-model",
    provider: "new-provider",
  });
  for (const mismatch of [
    { api: "bedrock-converse-stream", provider: "new-provider", model: "old-model" },
    { api: "bedrock-converse-stream", provider: "old-provider", model: "new-model" },
    { api: "openai-responses", provider: "new-provider", model: "new-model" },
  ] as const) {
    let commandInput: { messages?: Array<{ content: unknown[] }> } | undefined;
    const client = {
      async send(command: { input: typeof commandInput }) {
        commandInput = command.input;
        return { stream: (async function* () {
          yield { messageStop: { stopReason: "end_turn" } };
          yield { metadata: {} };
        })() };
      },
    } as unknown as BedrockRuntimeClient;
    const historical = {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "public answer" },
        { type: "thinking" as const, thinking: "portable summary", thinkingSignature: "old-signature" },
        { type: "thinking" as const, thinking: "redacted private", thinkingSignature: "redacted-signature", redacted: true },
      ],
      ...mismatch,
      usage: {},
      stopReason: "stop" as const,
      timestamp: 2,
      providerState: {
        source: mismatch,
        value: [{ reasoningContent: { reasoningText: {
          text: "opaque old private",
          signature: "opaque-old-signature",
        } } }],
      },
    };
    const transport = createBedrockConverseTransport({ client });
    await collect(transport(selected, {
      messages: [
        ...userContext().messages,
        historical,
        { role: "user", content: "continue", timestamp: 3 },
      ],
    }, {}));

    const replay = commandInput?.messages?.[1]?.content;
    assert.deepEqual(replay, [
      { text: "public answer" },
      { text: "portable summary" },
    ]);
    assert.doesNotMatch(JSON.stringify(replay), /opaque|signature|redacted private/u);
  }
});

test("Bedrock serializes supported user images as exact binary content blocks", async () => {
  let commandInput: { messages?: Array<{ content: unknown[] }> } | undefined;
  const client = {
    async send(command: { input: typeof commandInput }) {
      commandInput = command.input;
      return { stream: (async function* () {
        yield { messageStop: { stopReason: "end_turn" } };
        yield { metadata: {} };
      })() };
    },
  } as unknown as BedrockRuntimeClient;
  const transport = createBedrockConverseTransport({ client });

  const result = await collect(transport(model("bedrock-converse-stream"), {
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "inspect" },
        { type: "image", mimeType: "image/png", data: "AQID" },
        { type: "image", mimeType: "image/jpeg", data: "BAU=" },
        { type: "image", mimeType: "image/gif", data: "Bg==" },
        { type: "image", mimeType: "image/webp", data: "BwgJ" },
      ],
      timestamp: 1,
    }],
  }, {}));

  assert.equal(result.terminal.stopReason, "stop");
  assert.deepEqual(commandInput?.messages?.[0]?.content, [
    { text: "inspect" },
    { image: { format: "png", source: { bytes: Uint8Array.from([1, 2, 3]) } } },
    { image: { format: "jpeg", source: { bytes: Uint8Array.from([4, 5]) } } },
    { image: { format: "gif", source: { bytes: Uint8Array.from([6]) } } },
    { image: { format: "webp", source: { bytes: Uint8Array.from([7, 8, 9]) } } },
  ]);
});

test("Bedrock rejects unsupported, malformed, oversized, and excessive user images", async () => {
  const oversized = "A".repeat(5 * 1024 * 1024 + 4);
  const cases = [
    {
      content: [{ type: "image" as const, mimeType: "image/svg+xml", data: "AQID" }],
      pattern: /supported MIME type/u,
    },
    {
      content: [{ type: "image" as const, mimeType: "image/png", data: "AQID\n" }],
      pattern: /canonical base64/u,
    },
    {
      content: [{ type: "image" as const, mimeType: "image/png", data: "AQI" }],
      pattern: /canonical base64/u,
    },
    {
      content: [{ type: "image" as const, mimeType: "image/png", data: oversized }],
      pattern: /3\.75 MiB/u,
    },
    {
      content: Array.from({ length: 21 }, () => ({ type: "image" as const, mimeType: "image/png", data: "AQID" })),
      pattern: /at most 20 images/u,
    },
  ];

  for (const selected of cases) {
    let sent = false;
    const client = {
      async send() {
        sent = true;
        return { stream: (async function* () {})() };
      },
    } as unknown as BedrockRuntimeClient;
    const result = await collect(createBedrockConverseTransport({ client })(
      model("bedrock-converse-stream"),
      { messages: [{ role: "user", content: selected.content, timestamp: 1 }] },
      {},
    ));
    assert.equal(result.terminal.stopReason, "error");
    assert.match(result.terminal.errorMessage ?? "", selected.pattern);
    assert.equal(sent, false);
  }
});

test("Bedrock links consecutive text and image tool results to their tool uses", async () => {
  let commandInput: { messages?: Array<{ role: string; content: unknown[] }> } | undefined;
  const client = {
    async send(command: { input: typeof commandInput }) {
      commandInput = command.input;
      return { stream: (async function* () {
        yield { messageStop: { stopReason: "end_turn" } };
        yield { metadata: {} };
      })() };
    },
  } as unknown as BedrockRuntimeClient;
  const selected = model("bedrock-converse-stream");
  const result = await collect(createBedrockConverseTransport({ client })(selected, {
    messages: [
      ...userContext("inspect").messages,
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "pixel.png" } },
          { type: "toolCall", id: "call-2", name: "bash", arguments: { command: "false" } },
        ],
        api: selected.api,
        provider: selected.provider,
        model: selected.id,
        usage: {},
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [
          { type: "text", text: "attached pixel.png" },
          { type: "image", mimeType: "image/png", data: "AQID" },
        ],
        isError: false,
        timestamp: 3,
      },
      {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "bash",
        content: [],
        isError: true,
        timestamp: 4,
      },
    ],
  }, {}));

  assert.equal(result.terminal.stopReason, "stop");
  assert.deepEqual(commandInput?.messages, [
    { role: "user", content: [{ text: "inspect" }] },
    { role: "assistant", content: [
      { toolUse: { toolUseId: "call-1", name: "read", input: { path: "pixel.png" } } },
      { toolUse: { toolUseId: "call-2", name: "bash", input: { command: "false" } } },
    ] },
    { role: "user", content: [
      { toolResult: {
        toolUseId: "call-1",
        content: [
          { text: "attached pixel.png" },
          { image: { format: "png", source: { bytes: Uint8Array.from([1, 2, 3]) } } },
        ],
        status: "success",
      } },
      { toolResult: {
        toolUseId: "call-2",
        content: [{ text: "<empty>" }],
        status: "error",
      } },
    ] },
  ]);
});

test("Bedrock rejects malformed tool-result IDs, content, status, and images before sending", async () => {
  const cases: Array<{ message: unknown; pattern: RegExp }> = [
    {
      message: { role: "toolResult", toolCallId: "", toolName: "tool", content: [], isError: false, timestamp: 2 },
      pattern: /tool-call ID/u,
    },
    {
      message: { role: "toolResult", toolName: "tool", content: [], isError: false, timestamp: 2 },
      pattern: /tool-call ID/u,
    },
    {
      message: { role: "toolResult", toolCallId: "x".repeat(1_025), toolName: "tool", content: [], isError: false, timestamp: 2 },
      pattern: /tool-call ID/u,
    },
    {
      message: { role: "toolResult", toolCallId: "bad\nID", toolName: "tool", content: [], isError: false, timestamp: 2 },
      pattern: /tool-call ID/u,
    },
    {
      message: { role: "toolResult", toolCallId: "call", toolName: "tool", content: "not-an-array", isError: false, timestamp: 2 },
      pattern: /tool-result content/u,
    },
    {
      message: { role: "toolResult", toolCallId: "call", toolName: "tool", isError: false, timestamp: 2 },
      pattern: /tool-result content/u,
    },
    {
      message: { role: "toolResult", toolCallId: "call", toolName: "tool", content: [{ type: "unknown" }], isError: false, timestamp: 2 },
      pattern: /tool-result content block/u,
    },
    {
      message: { role: "toolResult", toolCallId: "call", toolName: "tool", content: [], isError: "false", timestamp: 2 },
      pattern: /isError/u,
    },
    {
      message: {
        role: "toolResult",
        toolCallId: "call",
        toolName: "tool",
        content: [{ type: "image", mimeType: "image/png", data: "not base64" }],
        isError: false,
        timestamp: 2,
      },
      pattern: /canonical base64/u,
    },
  ];

  for (const selected of cases) {
    let sent = false;
    const client = {
      async send() {
        sent = true;
        return { stream: (async function* () {})() };
      },
    } as unknown as BedrockRuntimeClient;
    const result = await collect(createBedrockConverseTransport({ client })(
      model("bedrock-converse-stream"),
      { messages: [...userContext().messages, selected.message] } as never,
      {},
    ));
    assert.equal(result.terminal.stopReason, "error");
    assert.match(result.terminal.errorMessage ?? "", selected.pattern);
    assert.equal(sent, false);
  }
});
