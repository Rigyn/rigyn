import assert from "node:assert/strict";
import test from "node:test";

import type { AdapterEvent } from "../../src/core/types.js";
import {
  ProviderStreamProjector,
  projectProviderStream,
  type ProviderStreamEnvelope,
} from "../../src/providers/index.js";

async function collect(source: AsyncIterable<ProviderStreamEnvelope>): Promise<ProviderStreamEnvelope[]> {
  const result: ProviderStreamEnvelope[] = [];
  for await (const event of source) result.push(event);
  return result;
}

async function* events(values: readonly AdapterEvent[]): AsyncIterable<AdapterEvent> {
  yield* values;
}

test("provider stream projection preserves a typed interleaved stream without private provider state", async () => {
  const projected = await collect(projectProviderStream("example-provider", events([
    {
      type: "response_start",
      model: "example-model",
      responseId: "response-1",
      requestId: "request-1",
      diagnostics: {
        status: 200,
        headers: {
          "x-request-id": "request-1",
          authorization: "Bearer transport-secret",
          "set-cookie": "session=transport-secret",
        },
      },
    },
    { type: "text_delta", part: 0, text: "visible" },
    { type: "tool_call_start", index: 1, id: "call-1", name: "write" },
    { type: "reasoning_delta", part: 0, text: "inspect", visibility: "summary" },
    { type: "tool_call_delta", index: 1, jsonFragment: "{\"path\":\"/tmp/out" },
    { type: "tool_call_start", index: 2, name: "read" },
    { type: "tool_call_delta", index: 2, jsonFragment: "{\"path\":\"/tmp/in\"}" },
    { type: "tool_call_delta", index: 1, jsonFragment: "\",\"content\":\"ok\"}" },
    {
      type: "tool_call_end",
      index: 1,
      id: "call-1",
      name: "write",
      rawArguments: "{\"path\":\"/tmp/out\",\"content\":\"ok\"}",
      arguments: { path: "/tmp/out", content: "ok" },
    },
    {
      type: "usage",
      semantics: "final",
      usage: {
        inputTokens: 8,
        outputTokens: 2,
        totalTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        raw: { bearer: "transport-secret" },
      },
    },
    {
      type: "unknown_provider_event",
      provider: "example-provider",
      raw: { authorization: "transport-secret" },
    },
    {
      type: "response_end",
      reason: "tool_calls",
      rawReason: "tool_use",
      state: {
        kind: "chat_completions",
        assistantMessage: { authorization: "transport-secret" },
      },
    },
  ])));

  assert.deepEqual(projected.map((entry) => entry.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(projected.every((entry) => entry.schemaVersion === 1 && entry.provider === "example-provider"), true);
  assert.deepEqual(projected[0], {
    schemaVersion: 1,
    provider: "example-provider",
    sequence: 1,
    event: {
      type: "response_start",
      model: "example-model",
      responseId: "response-1",
      requestId: "request-1",
      diagnostics: { status: 200, headers: { "x-request-id": "request-1" } },
    },
  });
  assert.deepEqual(projected[4]?.event, {
    type: "tool_call_delta",
    index: 1,
    delta: "{\"path\":\"/tmp/out",
    partial: {
      index: 1,
      id: "call-1",
      name: "write",
      rawArguments: "{\"path\":\"/tmp/out",
      arguments: { path: "/tmp/out" },
    },
  });
  assert.deepEqual(projected[6]?.event, {
    type: "tool_call_delta",
    index: 2,
    delta: "{\"path\":\"/tmp/in\"}",
    partial: {
      index: 2,
      name: "read",
      rawArguments: "{\"path\":\"/tmp/in\"}",
      arguments: { path: "/tmp/in" },
    },
  });
  assert.deepEqual(projected[8]?.event, {
    type: "tool_call_end",
    index: 1,
    toolCall: {
      index: 1,
      id: "call-1",
      name: "write",
      rawArguments: "{\"path\":\"/tmp/out\",\"content\":\"ok\"}",
      arguments: { path: "/tmp/out", content: "ok" },
    },
  });
  assert.deepEqual(projected[9]?.event, {
    type: "usage",
    semantics: "final",
    usage: {
      inputTokens: 8,
      outputTokens: 2,
      totalTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  });
  assert.deepEqual(projected[10]?.event, {
    type: "response_end",
    reason: "tool_calls",
    rawReason: "tool_use",
  });
  assert.equal(JSON.stringify(projected).includes("transport-secret"), false);
});

test("provider stream projection exposes bounded error metadata and redacted diagnostics", () => {
  const projector = new ProviderStreamProjector("example-provider");
  const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
  const projected = projector.project({
    type: "error",
    error: {
      category: "authentication",
      message: `authorization: Bearer ${secret}`,
      httpStatus: 401,
      providerCode: "invalid_api_key",
      requestId: "request-2",
      retryAfterMs: 250,
      retryable: false,
      partial: true,
      bodyStarted: true,
      diagnostics: {
        status: 401,
        headers: {
          "x-request-id": "request-2",
          cookie: `session=${secret}`,
          "x-api-key": secret,
        },
      },
      raw: { token: secret },
    },
  });

  assert.deepEqual(projected, {
    schemaVersion: 1,
    provider: "example-provider",
    sequence: 1,
    event: {
      type: "error",
      error: {
        category: "authentication",
        message: "authorization: Bearer [REDACTED]",
        httpStatus: 401,
        providerCode: "invalid_api_key",
        requestId: "request-2",
        retryAfterMs: 250,
        retryable: false,
        partial: true,
        bodyStarted: true,
        diagnostics: { status: 401, headers: { "x-request-id": "request-2" } },
      },
    },
  });
  assert.equal(JSON.stringify(projected).includes(secret), false);
});

test("provider stream projection rejects malformed normalized metadata", () => {
  const projector = new ProviderStreamProjector("example-provider");
  assert.throws(
    () => projector.project({
      type: "usage",
      semantics: "final",
      usage: { inputTokens: -1 },
    }),
    /invalid normalized usage/u,
  );
  assert.throws(
    () => projector.project({ type: "tool_call_delta", index: -1, jsonFragment: "{}" }),
    /tool call index/u,
  );
});

test("provider stream projection preserves an explicit null tool argument value", () => {
  const projector = new ProviderStreamProjector("example-provider");
  const projected = projector.project({
    type: "tool_call_end",
    index: 0,
    name: "nullable",
    rawArguments: "{}",
    arguments: null,
  });
  assert.deepEqual(projected?.event, {
    type: "tool_call_end",
    index: 0,
    toolCall: { index: 0, name: "nullable", rawArguments: "{}", arguments: null },
  });
});
