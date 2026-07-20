import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  BedrockAdapter,
  decodeAwsEventStream,
  signAwsRequest,
  type AwsEventStreamMessage,
} from "../../src/providers/bedrock.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { ProviderWireInterceptorRegistry } from "../../src/providers/wire.js";
import { byteChunks, collect, fakeFetch, readable, request, streamResponse, terminalCount } from "./helpers.js";

test("AWS event-stream decoder validates and reconstructs arbitrarily split frames", async () => {
  const bytes = concat(
    awsFrame({ ":message-type": "event", ":event-type": "messageStart" }, { role: "assistant" }),
    awsFrame({ ":message-type": "event", ":event-type": "messageStop" }, { stopReason: "end_turn" }),
  );
  const messages: AwsEventStreamMessage[] = [];
  for await (const message of decodeAwsEventStream(readable(byteChunks(bytes)))) messages.push(message);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.headers[":event-type"], "messageStart");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(messages[1]?.payload)), { stopReason: "end_turn" });
});

test("Bedrock adapter maps Converse event stream through metadata terminal", async () => {
  let posted: Record<string, unknown> | undefined;
  const bytes = concat(
    awsFrame({ ":message-type": "event", ":event-type": "messageStart" }, { role: "assistant" }),
    awsFrame(
      { ":message-type": "event", ":event-type": "contentBlockStart" },
      { contentBlockIndex: 0, start: {} },
    ),
    awsFrame(
      { ":message-type": "event", ":event-type": "contentBlockDelta" },
      { contentBlockIndex: 0, delta: { text: "bedrock" } },
    ),
    awsFrame(
      { ":message-type": "event", ":event-type": "contentBlockStop" },
      { contentBlockIndex: 0 },
    ),
    awsFrame({ ":message-type": "event", ":event-type": "messageStop" }, { stopReason: "end_turn" }),
    awsFrame(
      { ":message-type": "event", ":event-type": "metadata" },
      {
        usage: {
          inputTokens: 200,
          outputTokens: 100,
          totalTokens: 1_100,
          cacheReadInputTokens: 700,
          cacheWriteInputTokens: 100,
        },
      },
    ),
  );
  const adapter = new BedrockAdapter({
    region: "ca-central-1",
    signer: (unsigned) => unsigned,
    promptCache: "1h",
    fetch: fakeFetch(async (incoming) => {
      posted = await incoming.json() as Record<string, unknown>;
      return streamResponse(byteChunks(bytes, [1, 7, 2, 19, 3]), { "content-type": "application/vnd.amazon.eventstream" });
    }),
  });
  const providerRequest = request("bedrock");
  providerRequest.messages.unshift({
    id: "system-cache",
    role: "system",
    content: [{ type: "text", text: "Stable coding instructions" }],
    createdAt: new Date(0).toISOString(),
  });
  providerRequest.tools = [{
    name: "read",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  }];
  const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
  assert.equal(terminalCount(events), 1);
  assert.deepEqual(
    events.filter((event) => event.type === "text_delta").map((event) => (event.type === "text_delta" ? event.text : "")),
    ["bedrock"],
  );
  const end = events.at(-1);
  assert.equal(end?.type === "response_end" ? end.reason : undefined, "stop");
  const usage = events.find((event) => event.type === "usage");
  assert.deepEqual(usage?.type === "usage" ? usage.usage : undefined, {
    raw: {
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 1_100,
      cacheReadInputTokens: 700,
      cacheWriteInputTokens: 100,
    },
    inputTokens: 200,
    outputTokens: 100,
    cacheReadTokens: 700,
    cacheWriteTokens: 100,
    totalTokens: 1_100,
  });
  const cachePoint = { cachePoint: { type: "default", ttl: "1h" } };
  assert.deepEqual((posted?.system as unknown[] | undefined)?.at(-1), cachePoint);
  assert.deepEqual(((posted?.toolConfig as { tools?: unknown[] } | undefined)?.tools)?.at(-1), cachePoint);
  const messages = posted?.messages as Array<{ content?: unknown[] }> | undefined;
  assert.deepEqual(messages?.at(-1)?.content?.at(-1), cachePoint);
});

test("local SigV4 signer is deterministic and retains the request body", async () => {
  const request = new Request("https://bedrock-runtime.us-east-1.amazonaws.com/model/test/converse-stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"messages":[]}',
  });
  const signed = await signAwsRequest(
    request,
    { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
    { region: "us-east-1", service: "bedrock", target: "runtime" },
    new Date("2026-07-09T12:34:56.000Z"),
  );
  assert.equal(signed.headers.get("x-amz-date"), "20260709T123456Z");
  assert.match(signed.headers.get("authorization") ?? "", /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
  assert.match(signed.headers.get("authorization") ?? "", /\/us-east-1\/bedrock\/aws4_request/);
  assert.equal(await signed.text(), '{"messages":[]}');
});

test("Bedrock wire mutations are applied before SigV4 signing and responses are observed", async () => {
  const bytes = concat(
    awsFrame({ ":message-type": "event", ":event-type": "messageStart" }, { role: "assistant" }),
    awsFrame({ ":message-type": "event", ":event-type": "messageStop" }, { stopReason: "end_turn" }),
    awsFrame({ ":message-type": "event", ":event-type": "metadata" }, { usage: { inputTokens: 1, outputTokens: 1 } }),
  );
  const wire = new ProviderWireInterceptorRegistry();
  let responseStatus: number | undefined;
  wire.register("bedrock", {
    interceptRequest(observed) {
      assert.equal(observed.headers.authorization, undefined);
      assert.equal(observed.headers["x-amz-date"], undefined);
      return {
        body: { ...(observed.body as Record<string, unknown>), requestMetadata: { wire: "patched" } },
        headers: { "x-wire-signed": "yes" },
      };
    },
    observeResponse(observed) {
      responseStatus = observed.status;
    },
  });
  let transported: Request | undefined;
  const adapter = new BedrockAdapter({
    region: "us-east-1",
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
    now: () => new Date("2026-07-09T12:34:56.000Z"),
    wire,
    fetch: fakeFetch((incoming) => {
      transported = incoming;
      return streamResponse(byteChunks(bytes), {
        "content-type": "application/vnd.amazon.eventstream",
        "x-amzn-requestid": "bedrock-request",
      });
    }),
  });

  const events = await collect(adapter.stream(request("bedrock"), new AbortController().signal));

  assert.equal(terminalCount(events), 1);
  const bodyText = await transported!.clone().text();
  assert.deepEqual(JSON.parse(bodyText), {
    messages: [{ role: "user", content: [{ text: "hello" }] }],
    requestMetadata: { wire: "patched" },
  });
  assert.equal(transported!.headers.get("x-wire-signed"), "yes");
  assert.equal(
    transported!.headers.get("x-amz-content-sha256"),
    createHash("sha256").update(bodyText).digest("hex"),
  );
  assert.match(transported!.headers.get("authorization") ?? "", /SignedHeaders=[^,]*x-wire-signed/u);
  assert.equal(responseStatus, 200);
});

test("provider registry rejects duplicate adapters", () => {
  const adapter = new BedrockAdapter({ region: "us-east-1", signer: (unsigned) => unsigned });
  const registry = new ProviderRegistry([adapter]);
  assert.equal(registry.get("bedrock"), adapter);
  assert.throws(() => registry.register(adapter), /already registered/);
});

function awsFrame(headers: Record<string, string>, payloadValue: unknown): Uint8Array {
  const headerBytes = concat(
    ...Object.entries(headers).map(([name, value]) => {
      const nameBytes = new TextEncoder().encode(name);
      const valueBytes = new TextEncoder().encode(value);
      const output = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
      output[0] = nameBytes.length;
      output.set(nameBytes, 1);
      output[1 + nameBytes.length] = 7;
      new DataView(output.buffer).setUint16(2 + nameBytes.length, valueBytes.length);
      output.set(valueBytes, 4 + nameBytes.length);
      return output;
    }),
  );
  const payload = new TextEncoder().encode(JSON.stringify(payloadValue));
  const totalLength = 12 + headerBytes.length + payload.length + 4;
  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, totalLength);
  view.setUint32(4, headerBytes.length);
  view.setUint32(8, crc32(frame.subarray(0, 8)));
  frame.set(headerBytes, 12);
  frame.set(payload, 12 + headerBytes.length);
  view.setUint32(totalLength - 4, crc32(frame.subarray(0, totalLength - 4)));
  return frame;
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ value) & 0xff] ?? 0);
  return (crc ^ 0xffffffff) >>> 0;
}
