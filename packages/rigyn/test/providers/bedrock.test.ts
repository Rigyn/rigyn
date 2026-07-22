import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  providerRequest.model = "anthropic.claude-sonnet-4-20250514-v1:0";
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

test("Bedrock defaults supported models to short caching and maps per-call inference and tool choices", async () => {
  const captured: Record<string, unknown>[] = [];
  const adapter = new BedrockAdapter({
    region: "us-east-1",
    signer: (unsigned) => unsigned,
    fetch: fakeFetch(async (incoming) => {
      captured.push(await incoming.json() as Record<string, unknown>);
      return successfulBedrockResponse();
    }),
  });

  const supported = request("bedrock");
  supported.model = "anthropic.claude-sonnet-4-20250514-v1:0";
  supported.temperature = 0.25;
  supported.toolChoice = "required";
  supported.tools = [{ name: "read", description: "Read", inputSchema: { type: "object" } }];
  await collect(adapter.stream(supported, new AbortController().signal));

  const disabled = request("bedrock");
  disabled.model = supported.model;
  disabled.cacheRetention = "none";
  disabled.toolChoice = "none";
  disabled.tools = supported.tools;
  await collect(adapter.stream(disabled, new AbortController().signal));

  const downgraded = request("bedrock");
  downgraded.model = supported.model;
  downgraded.cacheRetention = "long";
  downgraded.modelSettings = { compatibility: { supportsLongCacheRetention: false } };
  await collect(adapter.stream(downgraded, new AbortController().signal));

  assert.deepEqual(captured[0]?.inferenceConfig, { temperature: 0.25 });
  assert.deepEqual((captured[0]?.toolConfig as Record<string, unknown>)?.toolChoice, { any: {} });
  assert.deepEqual(
    (captured[0]?.messages as Array<{ content: unknown[] }>).at(-1)?.content.at(-1),
    { cachePoint: { type: "default" } },
  );
  assert.equal(captured[1]?.toolConfig, undefined);
  assert.deepEqual(
    (captured[1]?.messages as Array<{ content: unknown[] }>).at(-1)?.content,
    [{ text: "hello" }],
  );
  assert.deepEqual(
    (captured[2]?.messages as Array<{ content: unknown[] }>).at(-1)?.content.at(-1),
    { cachePoint: { type: "default" } },
  );
});

test("Bedrock does not emit explicit cache points for unsupported models", async () => {
  let posted: Record<string, unknown> | undefined;
  const adapter = new BedrockAdapter({
    region: "us-east-1",
    signer: (unsigned) => unsigned,
    fetch: fakeFetch(async (incoming) => {
      posted = await incoming.json() as Record<string, unknown>;
      return successfulBedrockResponse();
    }),
  });
  await collect(adapter.stream(request("bedrock"), new AbortController().signal));
  assert.deepEqual(posted?.messages, [{ role: "user", content: [{ text: "hello" }] }]);
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

test("Bedrock request shaping preserves adaptive and bounded token-budget reasoning", async () => {
  const captured: Record<string, unknown>[] = [];
  const adapter = new BedrockAdapter({
    region: "us-east-1",
    signer: (unsigned) => unsigned,
    fetch: fakeFetch(async (incoming) => {
      captured.push(await incoming.json() as Record<string, unknown>);
      return successfulBedrockResponse();
    }),
  });
  const adaptive = request("bedrock");
  adaptive.model = "anthropic.claude-opus-4-8-v1:0";
  adaptive.reasoningEffort = "xhigh";
  await collect(adapter.stream(adaptive, new AbortController().signal));

  const fixed = request("bedrock");
  fixed.model = "anthropic.claude-3-7-sonnet-v1:0";
  fixed.reasoningEffort = "high";
  fixed.maxOutputTokens = 5_000;
  fixed.thinkingBudgets = { high: 20_000 };
  await collect(adapter.stream(fixed, new AbortController().signal));

  assert.deepEqual(captured[0]?.additionalModelRequestFields, {
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "xhigh" },
  });
  assert.deepEqual(captured[1]?.additionalModelRequestFields, {
    thinking: { type: "enabled", budget_tokens: 3_976, display: "summarized" },
    anthropic_beta: ["interleaved-thinking-2025-05-14"],
  });
});

test("Bedrock omits unsupported GovCloud display fields and normalizes empty and consecutive tool messages", async () => {
  let posted: Record<string, unknown> | undefined;
  const adapter = new BedrockAdapter({
    region: "us-gov-west-1",
    signer: (unsigned) => unsigned,
    thinkingDisplay: "summarized",
    interleavedThinking: false,
    fetch: fakeFetch(async (incoming) => {
      posted = await incoming.json() as Record<string, unknown>;
      return successfulBedrockResponse();
    }),
  });
  const providerRequest = request("bedrock");
  providerRequest.model = "anthropic.claude-3-7-sonnet-v1:0";
  providerRequest.cacheRetention = "none";
  providerRequest.reasoningEffort = "low";
  providerRequest.messages = [
    { id: "empty-user", role: "user", content: [{ type: "text", text: "   " }], createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "empty-assistant", role: "assistant", content: [], createdAt: "2026-01-01T00:00:01.000Z" },
    {
      id: "tool-one",
      role: "tool",
      content: [{ type: "tool_result", callId: "call-1", name: "read", content: "", isError: false }],
      createdAt: "2026-01-01T00:00:02.000Z",
    },
    {
      id: "tool-two",
      role: "tool",
      content: [{ type: "tool_result", callId: "call-2", name: "bash", content: "failed", isError: true }],
      createdAt: "2026-01-01T00:00:03.000Z",
    },
  ];
  await collect(adapter.stream(providerRequest, new AbortController().signal));

  assert.deepEqual(posted?.additionalModelRequestFields, {
    thinking: { type: "enabled", budget_tokens: 2_048 },
  });
  assert.deepEqual(posted?.messages, [
    { role: "user", content: [{ text: "<empty>" }] },
    {
      role: "user",
      content: [
        { toolResult: { toolUseId: "call-1", content: [{ text: "<empty>" }], status: "success" } },
        { toolResult: { toolUseId: "call-2", content: [{ text: "failed" }], status: "error" } },
      ],
    },
  ]);
});

test("Bedrock resolves ARN, explicit, environment, and standard-endpoint regions in order", async () => {
  const observed: Array<{ region: string; url: string }> = [];
  const run = async (
    config: ConstructorParameters<typeof BedrockAdapter>[0],
    model: string,
  ): Promise<void> => {
    const adapter = new BedrockAdapter({
      ...config,
      signer(unsigned, context) {
        observed.push({ region: context.region, url: unsigned.url });
        return unsigned;
      },
      fetch: fakeFetch(() => successfulBedrockResponse()),
    });
    const providerRequest = request("bedrock");
    providerRequest.model = model;
    await collect(adapter.stream(providerRequest, new AbortController().signal));
  };

  await run({ region: "ca-central-1", environment: { AWS_REGION: "eu-west-1" } },
    "arn:aws-us-gov:bedrock:us-gov-west-1:123456789012:application-inference-profile/example");
  await run({ region: "ca-central-1", environment: { AWS_REGION: "eu-west-1" } }, "anthropic.claude-test");
  await run({ environment: { AWS_REGION: "eu-west-1" } }, "anthropic.claude-test");
  await run({ environment: {}, runtimeEndpoint: "https://bedrock-runtime.ap-southeast-2.amazonaws.com" }, "anthropic.claude-test");

  assert.deepEqual(observed.map(({ region }) => region), [
    "us-gov-west-1",
    "ca-central-1",
    "eu-west-1",
    "ap-southeast-2",
  ]);
  assert.match(observed[0]!.url, /^https:\/\/bedrock-runtime\.us-gov-west-1\.amazonaws\.com\//u);
  assert.match(observed[2]!.url, /^https:\/\/bedrock-runtime\.eu-west-1\.amazonaws\.com\//u);
});

test("Bedrock resolves a named profile region and falls back deterministically", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-bedrock-region-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "config");
  await writeFile(configPath, "[profile team]\nregion = eu-central-1\n");
  const observed: Array<{ region: string; url: string }> = [];
  const run = async (environment: NodeJS.ProcessEnv): Promise<void> => {
    const adapter = new BedrockAdapter({
      environment,
      signer(unsigned, signerContext) {
        observed.push({ region: signerContext.region, url: unsigned.url });
        return unsigned;
      },
      fetch: fakeFetch(() => successfulBedrockResponse()),
    });
    await collect(adapter.stream(request("bedrock"), new AbortController().signal));
  };

  await run({ AWS_PROFILE: "team", AWS_CONFIG_FILE: configPath });
  await run({ AWS_CONFIG_FILE: join(directory, "missing") });

  assert.deepEqual(observed.map(({ region }) => region), ["eu-central-1", "us-east-1"]);
  assert.match(observed[0]!.url, /^https:\/\/bedrock-runtime\.eu-central-1\.amazonaws\.com\//u);
  assert.match(observed[1]!.url, /^https:\/\/bedrock-runtime\.us-east-1\.amazonaws\.com\//u);
});

test("provider registry rejects duplicate adapters", () => {
  const adapter = new BedrockAdapter({ region: "us-east-1", signer: (unsigned) => unsigned });
  const registry = new ProviderRegistry([adapter]);
  assert.equal(registry.get("bedrock"), adapter);
  assert.throws(() => registry.register(adapter), /already registered/);
});

function successfulBedrockResponse(): Response {
  return streamResponse(byteChunks(concat(
    awsFrame({ ":message-type": "event", ":event-type": "messageStart" }, { role: "assistant" }),
    awsFrame({ ":message-type": "event", ":event-type": "messageStop" }, { stopReason: "end_turn" }),
    awsFrame({ ":message-type": "event", ":event-type": "metadata" }, { usage: { inputTokens: 1, outputTokens: 1 } }),
  )), { "content-type": "application/vnd.amazon.eventstream" });
}

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
