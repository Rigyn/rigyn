import assert from "node:assert/strict";
import test from "node:test";

import type { EventEnvelope, RuntimeEvent } from "../../src/core/events.js";
import type { NormalizedUsage } from "../../src/core/types.js";
import {
  RuntimeObservability,
  resolveObservabilityLevel,
  type ObservabilityRecord,
  type ObservabilitySink,
} from "../../src/core/observability.js";
import { runtimeOpenAICodexTransportObserver } from "../../src/providers/openai-codex-observability.js";

class MemorySink implements ObservabilitySink {
  readonly records: ObservabilityRecord[] = [];
  record(record: ObservabilityRecord): void { this.records.push(record); }
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

function envelope(
  event: RuntimeEvent,
  sequence: number,
  runId: string | undefined = "secret-run-id",
  threadId = "secret-session-id",
): EventEnvelope {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    threadId,
    runId,
    sequence,
    timestamp: "2026-08-08T12:00:00.000Z",
    event,
  };
}

test("runtime observability rejects snapshot intervals outside the Node timer range", () => {
  const sink = new MemorySink();
  for (const snapshotIntervalMs of [0, 1.5, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    assert.throws(
      () => new RuntimeObservability(sink, { mode: "sdk", snapshotIntervalMs }),
      /snapshotIntervalMs must be an integer from 1 through 2147483647/u,
    );
  }
});

test("runtime observability keeps only allowlisted metadata and local aliases", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "interactive",
    level: "debug",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
    now: () => new Date("2026-08-08T12:00:01.000Z"),
  });
  const secret = "PROMPT_SENTINEL https://user:password@example.invalid/private sk-proj-abcdefghijklmnop";
  const failure = "ERROR_DIAGNOSTIC_SENTINEL sk-proj-qrstuvwxyz012345";
  observer.observe(envelope({
    type: "run_started",
    provider: secret,
    model: secret,
    reasoningEffort: "high",
  }, 0));
  observer.observe(envelope({
    type: "message_appended",
    message: {
      id: "secret-message-id",
      role: "user",
      content: [{ type: "text", text: secret }],
      createdAt: "2026-08-08T12:00:00.000Z",
    },
    providerState: { secret } as never,
    providerStateSerialized: secret,
    toolDefinitionFingerprint: secret,
  }, 1));
  observer.observe(envelope({
    type: "provider_response_started",
    step: 0,
    model: secret,
    responseId: "secret-response-id",
    requestId: "secret-request-id",
  }, 2));
  observer.observe(envelope({
    type: "tool_started",
    callId: "secret-call-id",
    name: secret,
    index: 0,
    input: { path: secret },
    recoveryMode: "repeatable",
  }, 3));
  observer.observe(envelope({
    type: "tool_progress",
    callId: "secret-call-id",
    name: secret,
    index: 0,
    sequence: 1,
    progress: { type: "result", content: secret, isError: false, metadata: { secret } },
  }, 4));
  observer.observe(envelope({
    type: "tool_completed",
    callId: "secret-call-id",
    name: secret,
    index: 0,
    isError: false,
    preview: secret,
    result: { type: "tool_result", callId: "secret-call-id", name: secret, content: secret, isError: false },
  }, 5));
  observer.observe(envelope({
    type: "run_failed",
    error: { category: "internal", message: failure },
  }, 6));
  await observer.close();

  const serialized = JSON.stringify(sink.records);
  for (const forbidden of [
    "PROMPT_SENTINEL", "password", "abcdefghijklmnop", "secret-session-id", "secret-run-id",
    "secret-message-id", "secret-response-id", "secret-request-id", "secret-call-id", "ERROR_DIAGNOSTIC_SENTINEL",
    "qrstuvwxyz012345",
  ]) assert.doesNotMatch(serialized, new RegExp(forbidden, "u"));
  assert.deepEqual(
    [...new Set(sink.records.filter((record) => record.kind === "event").map((record) => record.name))],
    ["run_started", "message_appended", "provider_response_started", "tool_started", "tool_completed", "run_failed"],
  );
  assert.equal(sink.records.filter((record) => record.kind === "event").every((record) => record.correlation?.session === "s1"), true);
  assert.equal(sink.records.some((record) => record.kind === "metrics_snapshot"), true);
});

test("error level suppresses informational records and aggregate snapshots", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "sdk",
    level: "error",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  observer.event("sdk", "informational");
  observer.event("sdk", "failed", {}, "error");
  observer.snapshot();
  await observer.close();
  assert.deepEqual(sink.records.map((record) => record.name), ["failed"]);
});

test("provider failures retain safe diagnostics without provider-controlled text", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "interactive",
    level: "error",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  observer.observe(envelope({
    type: "run_failed",
    error: {
      category: "network",
      message: "PROMPT_BODY_SENTINEL WebSocket handshake failed for sk-proj-abcdefghijklmnop",
      providerCode: "WS_CONNECT_TIMEOUT",
      requestId: "request-visible-to-local-support",
      retryAfterMs: 2_000,
      retryable: true,
      partial: false,
      diagnostics: {
        status: 504,
        headers: { "content-type": "application/json", "x-request-id": "response-request" },
      },
      raw: { body: "RAW_PROVIDER_BODY_SENTINEL" },
    },
  }, 1));
  await observer.close();
  const record = sink.records.find((candidate) => candidate.name === "run_failed");
  assert.equal(record?.fields.category, "network");
  assert.equal(record?.fields.error_message, undefined);
  assert.equal(record?.fields.provider_code, "WS_CONNECT_TIMEOUT");
  assert.equal(record?.fields.request_id, "request-visible-to-local-support");
  assert.equal(record?.fields.response_status, 504);
  assert.equal(record?.fields.response_request_id, "response-request");
  assert.doesNotMatch(JSON.stringify(record), /PROMPT_BODY_SENTINEL|RAW_PROVIDER_BODY_SENTINEL|abcdefghijklmnop/u);
});

test("WebSocket handshake status is distinct from the provider failure response status", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "interactive",
    level: "error",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  observer.observe(envelope({
    type: "run_failed",
    error: {
      category: "network",
      message: "provider-controlled close reason",
      retryable: true,
      partial: true,
      diagnostics: { status: 101, headers: {} },
    },
  }, 1));
  await observer.close();

  const record = sink.records.find((candidate) => candidate.name === "run_failed");
  assert.equal(record?.fields.websocket_handshake_status, 101);
  assert.equal(record?.fields.response_status, undefined);
  assert.doesNotMatch(JSON.stringify(record), /provider-controlled close reason/u);
});

test("Codex transport observations serialize only the fixed local metadata schema", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "interactive",
    level: "debug",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  let activeObserver: RuntimeObservability | undefined;
  const observe = runtimeOpenAICodexTransportObserver(() => activeObserver);
  observe({ type: "selected", transport: "sse", sessionFallbackUsed: false });
  activeObserver = observer;
  observe({ type: "selected", transport: "websocket", cachedSocketReused: true, handshakeStatus: 101 });
  observe({
    type: "websocket_failed",
    failureClass: "close",
    closeCode: 1011,
    transportCode: "ECONNRESET",
    partialOutput: true,
    outputBoundary: "hidden_provider_reasoning",
  });
  observe({
    type: "session_fallback_activated",
    failureClass: "close",
    partialOutput: true,
    outputBoundary: "hidden_provider_reasoning",
  });
  observe({ type: "selected", transport: "sse", sessionFallbackUsed: true });
  await observer.close();

  const records = sink.records.filter((record) => record.kind === "event");
  assert.deepEqual(records.map((record) => [record.name, record.fields]), [
    ["codex_transport_selected", {
      transport: "websocket",
      cached_socket_reused: true,
      websocket_handshake_status: 101,
    }],
    ["codex_websocket_failed", {
      failure_class: "close",
      partial_output: true,
      output_boundary: "hidden_provider_reasoning",
      websocket_close_code: 1011,
      transport_code: "ECONNRESET",
    }],
    ["codex_session_fallback_activated", {
      failure_class: "close",
      partial_output: true,
      output_boundary: "hidden_provider_reasoning",
    }],
    ["codex_transport_selected", { transport: "sse", session_fallback_used: true }],
  ]);
});

test("provider metadata keeps opaque tokens but rejects echoed text", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "interactive",
    level: "error",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  observer.observe(envelope({
    type: "run_failed",
    error: {
      category: "provider",
      message: "PROVIDER_MESSAGE_SENTINEL",
      providerCode: "CODE PROMPT_SENTINEL",
      requestId: "REQUEST\tPROMPT_SENTINEL",
      retryable: false,
      partial: false,
      diagnostics: {
        status: 502,
        headers: {
          "content-type": "application/json; prompt=CONTENT_TYPE_SENTINEL",
          "x-request-id": "HEADER PROMPT_SENTINEL",
          "cf-ray": "EDGE\nPROMPT_SENTINEL",
        },
      },
    },
  }, 1));
  await observer.close();

  const record = sink.records.find((candidate) => candidate.name === "run_failed");
  assert.equal(record?.fields.response_status, 502);
  assert.equal(record?.fields.response_content_type, "application/json");
  assert.equal(record?.fields.provider_code, undefined);
  assert.equal(record?.fields.request_id, undefined);
  assert.equal(record?.fields.response_request_id, undefined);
  assert.equal(record?.fields.response_edge_id, undefined);
  assert.doesNotMatch(
    JSON.stringify(record),
    /PROVIDER_MESSAGE_SENTINEL|PROMPT_SENTINEL|CONTENT_TYPE_SENTINEL/u,
  );
});

test("provider retry and compaction failures do not record provider-controlled text", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "interactive",
    level: "info",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  observer.observe(envelope({
    type: "retry_scheduled",
    attempt: 2,
    delayMs: 1_000,
    category: "rate_limit",
    errorMessage: "RETRY_PROVIDER_BODY_SENTINEL",
    phase: "model",
  }, 1));
  observer.observe(envelope({
    type: "compaction_failed",
    reason: "threshold",
    aborted: false,
    willRetry: false,
    category: "overloaded",
    errorMessage: "COMPACTION_PROVIDER_BODY_SENTINEL",
  }, 2));
  observer.observe(envelope({
    type: "retry_scheduled",
    attempt: 3,
    delayMs: 2_000,
    category: "CATEGORY PROMPT_SENTINEL",
    errorMessage: "SECOND_RETRY_PROVIDER_BODY_SENTINEL",
  }, 3));
  await observer.close();

  const retries = sink.records.filter((candidate) => candidate.name === "retry_scheduled");
  assert.equal(retries[0]?.fields.category, "rate_limit");
  assert.equal(retries[0]?.fields.error_message, undefined);
  assert.equal(retries[1]?.fields.category, "provider");
  const compaction = sink.records.find((candidate) => candidate.name === "compaction_failed");
  assert.equal(compaction?.fields.category, "overloaded");
  assert.equal(compaction?.fields.error_message, undefined);
  assert.doesNotMatch(
    JSON.stringify(sink.records),
    /RETRY_PROVIDER_BODY_SENTINEL|COMPACTION_PROVIDER_BODY_SENTINEL|CATEGORY PROMPT_SENTINEL/u,
  );
});

test("internal compaction failures retain classification without free-form text", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "interactive",
    level: "error",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  observer.observe(envelope({
    type: "compaction_failed",
    reason: "manual",
    aborted: false,
    willRetry: false,
    category: "internal",
    errorMessage: "Local compaction setup failed for sk-proj-abcdefghijklmnop",
  }, 1));
  await observer.close();

  const record = sink.records.find((candidate) => candidate.name === "compaction_failed");
  assert.equal(record?.fields.category, "internal");
  assert.equal(record?.fields.error_message, undefined);
  assert.doesNotMatch(JSON.stringify(record), /Local compaction setup failed|abcdefghijklmnop/u);
});

test("runtime warnings retain fixed metadata without arbitrary warning text", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "interactive",
    level: "info",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  observer.observe(envelope({
    type: "warning",
    code: "extension_run_after",
    message: "EXTENSION_PROMPT_SENTINEL",
    details: { private: "DETAIL_SENTINEL" },
  }, 1));
  observer.observe(envelope({
    type: "warning",
    code: "WARNING_CODE_PROMPT_SENTINEL",
    message: "second warning",
  }, 2));
  await observer.close();

  const records = sink.records.filter((candidate) => candidate.name === "warning");
  assert.equal(records[0]?.fields.code, "extension_run_after");
  assert.equal(records[0]?.fields.has_details, true);
  assert.equal(records[0]?.fields.message, undefined);
  assert.equal(records[1]?.fields.code, "runtime_warning");
  assert.doesNotMatch(
    JSON.stringify(records),
    /EXTENSION_PROMPT_SENTINEL|DETAIL_SENTINEL|WARNING_CODE_PROMPT_SENTINEL|second warning/u,
  );
});

test("cancellation and in-doubt records omit free-form reasons", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "interactive",
    level: "info",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  observer.observe(envelope({
    type: "tool_in_doubt",
    callId: "private-call",
    name: "bash",
    index: 4,
    reason: "TOOL_REASON_PROMPT_SENTINEL",
  }, 1));
  observer.observe(envelope({
    type: "run_cancelled",
    reason: "CANCEL_REASON_PROMPT_SENTINEL",
  }, 2));
  await observer.close();

  const tool = sink.records.find((candidate) => candidate.name === "tool_in_doubt");
  assert.equal(tool?.fields.index, 4);
  assert.equal(tool?.fields.reason, undefined);
  const cancelled = sink.records.find((candidate) => candidate.name === "run_cancelled");
  assert.equal(cancelled?.fields.reason, undefined);
  assert.doesNotMatch(JSON.stringify([tool, cancelled]), /TOOL_REASON_PROMPT_SENTINEL|CANCEL_REASON_PROMPT_SENTINEL/u);
});

test("the environment overrides only recognized observability levels", () => {
  assert.equal(resolveObservabilityLevel(undefined, {}), "debug");
  assert.equal(resolveObservabilityLevel("info", {}), "info");
  assert.equal(resolveObservabilityLevel("info", { RIGYN_LOG_LEVEL: "debug" }), "debug");
  assert.equal(resolveObservabilityLevel("debug", { RIGYN_LOG_LEVEL: "off" }), "off");
  assert.throws(
    () => resolveObservabilityLevel("info", { RIGYN_LOG_LEVEL: "verbose" }),
    /RIGYN_LOG_LEVEL must be off, error, info, or debug/u,
  );
});

test("caller-owned sinks retain safe debug metadata by default", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "sdk",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  observer.event("sdk", "debug_default", { payload_bytes: 7 }, "debug");
  await observer.close();
  assert.equal(sink.records.some((record) => record.name === "debug_default"), true);
});

test("observer sink failures never escape into the runtime", async () => {
  const observer = new RuntimeObservability({
    record() { throw new Error("record failed"); },
    async flush() { throw new Error("flush failed"); },
    async close() { throw new Error("close failed"); },
  }, { mode: "serve", snapshotIntervalMs: 60_000 });
  assert.doesNotThrow(() => observer.event("serve", "runtime_started"));
  assert.doesNotThrow(() => observer.snapshot());
  await assert.doesNotReject(observer.flush());
  await assert.doesNotReject(observer.close());
});

test("concurrent observer closes wait for the same sink cleanup", async () => {
  let releaseClose!: () => void;
  const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
  const observer = new RuntimeObservability({
    record() {},
    async flush() {},
    async close() { await closeGate; },
  }, { mode: "serve", snapshotIntervalMs: 60_000 });

  const first = observer.close();
  let secondSettled = false;
  const second = observer.close().finally(() => { secondSettled = true; });
  await Promise.resolve();
  assert.equal(secondSettled, false);

  releaseClose();
  await Promise.all([first, second]);
});

test("session correlation aliases remain bounded across long-running session switches", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "interactive",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  for (let index = 0; index <= 1_024; index += 1) {
    observer.observe(envelope(
      { type: "warning", code: "fixture", message: "bounded alias" },
      index,
      undefined,
      `thread-${index}`,
    ));
  }
  observer.observe(envelope(
    { type: "warning", code: "fixture", message: "revisited alias" },
    1_025,
    undefined,
    "thread-0",
  ));
  await observer.close();

  const events = sink.records.filter((record) => record.kind === "event");
  assert.equal(events[0]?.correlation?.session, "s1");
  assert.equal(events.at(-1)?.correlation?.session, "s1026");
});

test("aggregate usage de-duplicates one attempt but counts later provider attempts", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "json",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  const attempt = (number: number): RuntimeEvent => ({
    type: "provider_attempt_started",
    step: number - 1,
    attempt: 1,
    provider: "private-provider",
    model: "private-model",
    toolNames: [],
    toolsetFingerprint: "private-fingerprint",
  });
  observer.observe(envelope(attempt(1), 1));
  observer.observe(envelope({ type: "usage", semantics: "incremental", usage: { inputTokens: 2 } }, 2));
  observer.observe(envelope({ type: "usage", semantics: "final", usage: { inputTokens: 5 } }, 3));
  observer.observe(envelope(attempt(2), 4));
  observer.observe(envelope({ type: "usage", semantics: "final", usage: { inputTokens: 7 } }, 5));
  await observer.close();
  const snapshot = sink.records.findLast((record) => record.kind === "metrics_snapshot");
  assert.equal(snapshot?.fields.input_tokens, 12);
});

test("aggregate usage reconciles decreasing cumulative and final replacements", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "json",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  observer.observe(envelope({
    type: "provider_attempt_started",
    step: 0,
    attempt: 1,
    provider: "private-provider",
    model: "private-model",
    toolNames: [],
    toolsetFingerprint: "private-fingerprint",
  }, 1));
  observer.observe(envelope({
    type: "usage",
    semantics: "cumulative",
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12 },
    },
  }, 2));
  observer.observe(envelope({
    type: "usage",
    semantics: "final",
    usage: {
      inputTokens: 5,
      outputTokens: 1,
      totalTokens: 6,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, total: 6 },
    },
  }, 3));
  observer.observe(envelope({ type: "assistant_completed", finishReason: "stop" }, 4));
  await observer.close();

  const fields = sink.records.findLast((record) => record.kind === "metrics_snapshot")?.fields;
  assert.equal(fields?.input_tokens, 5);
  assert.equal(fields?.output_tokens, 1);
  assert.equal(fields?.total_tokens, 6);
  assert.equal(fields?.cache_read_tokens, 0);
  assert.equal(fields?.cache_write_tokens, 0);
  assert.equal(fields?.cost_input, 5);
  assert.equal(fields?.cost_output, 1);
  assert.equal(fields?.cost_total, 6);
  assert.equal(fields?.input_tokens_complete, true);
  assert.equal(fields?.cost_complete, true);
});

test("incremental token fields compose while incomplete incremental cost stays reported", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "json",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  observer.observe(envelope({
    type: "provider_attempt_started",
    step: 0,
    attempt: 1,
    provider: "private-provider",
    model: "private-model",
    toolNames: [],
    toolsetFingerprint: "private-fingerprint",
  }, 1));
  observer.observe(envelope({
    type: "usage",
    semantics: "incremental",
    usage: {
      inputTokens: 2,
      cacheReadTokens: 0,
      cost: { input: 0.2, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.2 },
    },
  }, 2));
  observer.observe(envelope({
    type: "usage",
    semantics: "incremental",
    usage: { outputTokens: 1, cacheWriteTokens: 0 },
  }, 3));
  observer.observe(envelope({ type: "assistant_completed", finishReason: "stop" }, 4));
  await observer.close();

  const fields = sink.records.findLast((record) => record.kind === "metrics_snapshot")?.fields;
  assert.equal(fields?.input_tokens, 2);
  assert.equal(fields?.input_tokens_complete, true);
  assert.equal(fields?.output_tokens, 1);
  assert.equal(fields?.output_tokens_complete, true);
  assert.equal(fields?.cache_read_tokens, 0);
  assert.equal(fields?.cache_read_tokens_complete, true);
  assert.equal(fields?.cache_write_tokens, 0);
  assert.equal(fields?.cache_write_tokens_complete, true);
  assert.equal(fields?.cost_total, undefined);
  assert.equal(fields?.cost_total_reported, 0.2);
  assert.equal(fields?.cost_complete, false);
});

test("aggregate usage demotes unsafe independent sums while preserving exact zero", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "json",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  const attempt = (step: number): RuntimeEvent => ({
    type: "provider_attempt_started",
    step,
    attempt: 1,
    provider: "private-provider",
    model: "private-model",
    toolNames: [],
    toolsetFingerprint: "private-fingerprint",
  });
  const usage: NormalizedUsage = {
    inputTokens: Number.MAX_SAFE_INTEGER,
    outputTokens: 0,
    totalTokens: Number.MAX_SAFE_INTEGER,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: Number.MAX_SAFE_INTEGER,
    serverToolCalls: Number.MAX_SAFE_INTEGER,
    durationMs: Number.MAX_SAFE_INTEGER,
    cost: {
      input: Number.MAX_VALUE,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: Number.MAX_VALUE,
    },
  };
  observer.observe(envelope(attempt(0), 1));
  observer.observe(envelope({ type: "usage", semantics: "final", usage }, 2));
  observer.observe(envelope({ type: "assistant_completed", finishReason: "stop" }, 3));
  observer.observe(envelope(attempt(1), 4));
  observer.observe(envelope({ type: "usage", semantics: "final", usage }, 5));
  observer.observe(envelope({ type: "assistant_completed", finishReason: "stop" }, 6));
  await observer.close();

  const fields = sink.records.findLast((record) => record.kind === "metrics_snapshot")?.fields;
  assert.equal(fields?.usage_scopes, 2);
  assert.equal(fields?.input_tokens, undefined);
  assert.equal(fields?.input_tokens_reported, Number.MAX_SAFE_INTEGER);
  assert.equal(fields?.input_tokens_complete, false);
  assert.equal(fields?.total_tokens, undefined);
  assert.equal(fields?.total_tokens_reported, Number.MAX_SAFE_INTEGER);
  assert.equal(fields?.total_tokens_complete, false);
  assert.equal(fields?.output_tokens, 0);
  assert.equal(fields?.output_tokens_complete, true);
  assert.equal(fields?.cache_read_tokens, 0);
  assert.equal(fields?.cache_write_tokens, 0);
  assert.equal(fields?.cost_input, undefined);
  assert.equal(fields?.cost_total, undefined);
  assert.equal(fields?.cost_input_reported, Number.MAX_VALUE);
  assert.equal(fields?.cost_output_reported, 0);
  assert.equal(fields?.cost_cache_read_reported, 0);
  assert.equal(fields?.cost_cache_write_reported, 0);
  assert.equal(fields?.cost_total_reported, Number.MAX_VALUE);
  assert.equal(fields?.cost_complete, false);
  assert.equal(fields?.reasoning_tokens, Number.MAX_SAFE_INTEGER);
  assert.equal(fields?.server_tool_calls, Number.MAX_SAFE_INTEGER);
  assert.equal(fields?.provider_duration_ms, Number.MAX_SAFE_INTEGER);
  assert.equal(Number.isSafeInteger(fields?.reasoning_tokens), true);
  assert.equal(Number.isSafeInteger(fields?.server_tool_calls), true);
  assert.equal(Number.isSafeInteger(fields?.provider_duration_ms), true);
});

test("an active overflowed scope recovers after a safe final replacement", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "json",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  const attempt = (step: number): RuntimeEvent => ({
    type: "provider_attempt_started",
    step,
    attempt: 1,
    provider: "private-provider",
    model: "private-model",
    toolNames: [],
    toolsetFingerprint: "private-fingerprint",
  });
  const maximum: NormalizedUsage = {
    inputTokens: Number.MAX_SAFE_INTEGER,
    outputTokens: 0,
    totalTokens: Number.MAX_SAFE_INTEGER,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: {
      input: Number.MAX_VALUE,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: Number.MAX_VALUE,
    },
  };
  const zero: NormalizedUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  observer.observe(envelope(attempt(0), 1));
  observer.observe(envelope({ type: "usage", semantics: "final", usage: maximum }, 2));
  observer.observe(envelope({ type: "assistant_completed", finishReason: "stop" }, 3));
  observer.observe(envelope(attempt(1), 4));
  observer.observe(envelope({ type: "usage", semantics: "cumulative", usage: maximum }, 5));
  observer.observe(envelope({ type: "usage", semantics: "final", usage: zero }, 6));
  observer.observe(envelope({ type: "assistant_completed", finishReason: "stop" }, 7));
  await observer.close();

  const fields = sink.records.findLast((record) => record.kind === "metrics_snapshot")?.fields;
  assert.equal(fields?.input_tokens, Number.MAX_SAFE_INTEGER);
  assert.equal(fields?.input_tokens_reported, undefined);
  assert.equal(fields?.input_tokens_complete, true);
  assert.equal(fields?.total_tokens, Number.MAX_SAFE_INTEGER);
  assert.equal(fields?.total_tokens_complete, true);
  assert.equal(fields?.output_tokens, 0);
  assert.equal(fields?.cache_read_tokens, 0);
  assert.equal(fields?.cache_write_tokens, 0);
  assert.equal(fields?.cost_input, Number.MAX_VALUE);
  assert.equal(fields?.cost_total, Number.MAX_VALUE);
  assert.equal(fields?.cost_input_reported, undefined);
  assert.equal(fields?.cost_complete, true);
});

test("aggregate snapshots distinguish reported zero usage from unavailable telemetry", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "json",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  observer.observe(envelope({
    type: "usage",
    semantics: "final",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      durationMs: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }, 1));
  await observer.close();

  const snapshot = sink.records.findLast((record) => record.kind === "metrics_snapshot");
  assert.equal(snapshot?.fields.input_tokens_observed, true);
  assert.equal(snapshot?.fields.output_tokens_observed, true);
  assert.equal(snapshot?.fields.cache_telemetry_observed, true);
  assert.equal(snapshot?.fields.cache_read_tokens, 0);
  assert.equal(snapshot?.fields.cache_write_tokens, 0);
  assert.equal(snapshot?.fields.cache_read_tokens_complete, true);
  assert.equal(snapshot?.fields.cache_write_tokens_complete, true);
  assert.equal(snapshot?.fields.cache_read_tokens_observed, true);
  assert.equal(snapshot?.fields.cache_write_tokens_observed, true);
  assert.equal(snapshot?.fields.cost_observed, true);
  assert.equal(snapshot?.fields.provider_duration_observed, true);
});

test("aggregate cache totals expose incomplete counters only as reported partials", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "json",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  const attempt: RuntimeEvent = {
    type: "provider_attempt_started",
    step: 0,
    attempt: 1,
    provider: "private-provider",
    model: "private-model",
    toolNames: [],
    toolsetFingerprint: "private-fingerprint",
  };
  observer.observe(envelope(attempt, 1));
  observer.observe(envelope({
    type: "usage",
    semantics: "final",
    usage: { inputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0 },
  }, 2));
  observer.observe(envelope({ ...attempt, step: 1 }, 3));
  observer.observe(envelope({
    type: "usage",
    semantics: "final",
    usage: { inputTokens: 8, cacheWriteTokens: 2 },
  }, 4));
  await observer.close();

  const fields = sink.records.findLast((record) => record.kind === "metrics_snapshot")?.fields;
  assert.equal(fields?.cache_read_tokens, undefined);
  assert.equal(fields?.cache_read_tokens_reported, 5);
  assert.equal(fields?.cache_read_tokens_complete, false);
  assert.equal(fields?.cache_read_tokens_observed, true);
  assert.equal(fields?.cache_write_tokens, 2);
  assert.equal(fields?.cache_write_tokens_reported, undefined);
  assert.equal(fields?.cache_write_tokens_complete, true);
  assert.equal(fields?.cache_write_tokens_observed, true);
});

test("aggregate cache totals do not turn entirely missing telemetry into zero", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "json",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  observer.observe(envelope({
    type: "provider_attempt_started",
    step: 0,
    attempt: 1,
    provider: "private-provider",
    model: "private-model",
    toolNames: [],
    toolsetFingerprint: "private-fingerprint",
  }, 1));
  observer.observe(envelope({ type: "usage", semantics: "final", usage: { inputTokens: 10 } }, 2));
  await observer.close();

  const fields = sink.records.findLast((record) => record.kind === "metrics_snapshot")?.fields;
  assert.equal(fields?.cache_read_tokens, undefined);
  assert.equal(fields?.cache_write_tokens, undefined);
  assert.equal(fields?.cache_read_tokens_reported, undefined);
  assert.equal(fields?.cache_write_tokens_reported, undefined);
  assert.equal(fields?.cache_read_tokens_complete, false);
  assert.equal(fields?.cache_write_tokens_complete, false);
  assert.equal(fields?.cache_read_tokens_observed, false);
  assert.equal(fields?.cache_write_tokens_observed, false);
});

test("aggregate snapshots expose partial usage when a successful metered request omits telemetry", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "json",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  const attempt = (step: number): RuntimeEvent => ({
    type: "provider_attempt_started",
    step,
    attempt: 1,
    provider: "private-provider",
    model: "private-model",
    toolNames: [],
    toolsetFingerprint: "private-fingerprint",
  });
  observer.observe(envelope(attempt(0), 1));
  observer.observe(envelope({
    type: "usage",
    semantics: "final",
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
    },
  }, 2));
  observer.observe(envelope({ type: "assistant_completed", finishReason: "stop" }, 3));
  observer.observe(envelope({
    type: "tool_completed",
    callId: "ordinary-tool",
    name: "tool",
    index: 0,
    isError: false,
    preview: "ok",
    result: { type: "tool_result", callId: "ordinary-tool", name: "tool", content: "ok", isError: false },
  }, 4));
  observer.observe(envelope(attempt(1), 5));
  observer.observe(envelope({ type: "assistant_completed", finishReason: "stop" }, 6));
  await observer.close();

  const fields = sink.records.findLast((record) => record.kind === "metrics_snapshot")?.fields;
  assert.equal(fields?.usage_scopes, 2);
  for (const name of ["input", "output", "total"] as const) {
    assert.equal(fields?.[`${name}_tokens`], undefined);
    assert.equal(fields?.[`${name}_tokens_reported`], name === "input" ? 10 : name === "output" ? 2 : 12);
    assert.equal(fields?.[`${name}_tokens_complete`], false);
    assert.equal(fields?.[`${name}_tokens_observed`], true);
  }
  assert.equal(fields?.cost_total, undefined);
  assert.equal(fields?.cost_total_reported, 0.3);
  assert.equal(fields?.cost_complete, false);
  assert.equal(fields?.cost_observed, true);
});

test("aggregate provider totals remain exact independently of partial cache telemetry", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "json",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  const attempt = (step: number): RuntimeEvent => ({
    type: "provider_attempt_started",
    step,
    attempt: 1,
    provider: "private-provider",
    model: "private-model",
    toolNames: [],
    toolsetFingerprint: "private-fingerprint",
  });
  observer.observe(envelope(attempt(0), 1));
  observer.observe(envelope({
    type: "usage",
    semantics: "final",
    usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  }, 2));
  observer.observe(envelope({ type: "assistant_completed", finishReason: "stop" }, 3));
  observer.observe(envelope(attempt(1), 4));
  observer.observe(envelope({
    type: "usage",
    semantics: "final",
    usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
  }, 5));
  observer.observe(envelope({ type: "assistant_completed", finishReason: "stop" }, 6));
  await observer.close();

  const fields = sink.records.findLast((record) => record.kind === "metrics_snapshot")?.fields;
  assert.equal(fields?.total_tokens, 9);
  assert.equal(fields?.total_tokens_reported, undefined);
  assert.equal(fields?.total_tokens_complete, true);
  assert.equal(fields?.cache_read_tokens, undefined);
  assert.equal(fields?.cache_read_tokens_reported, 0);
  assert.equal(fields?.cache_read_tokens_complete, false);
});

test("tool-attributed usage is an independent scope while ordinary tools do not invalidate telemetry", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "json",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  observer.observe(envelope({
    type: "provider_attempt_started",
    step: 0,
    attempt: 1,
    provider: "private-provider",
    model: "private-model",
    toolNames: [],
    toolsetFingerprint: "private-fingerprint",
  }, 1));
  observer.observe(envelope({
    type: "usage",
    semantics: "final",
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
  }, 2));
  observer.observe(envelope({ type: "assistant_completed", finishReason: "stop" }, 3));
  observer.observe(envelope({
    type: "message_appended",
    message: {
      id: "ordinary-tool",
      role: "tool",
      content: [{ type: "tool_result", callId: "ordinary", name: "tool", content: "ok", isError: false }],
      createdAt: "2026-08-08T12:00:00.000Z",
    },
  }, 4));
  observer.observe(envelope({
    type: "message_appended",
    message: {
      id: "metered-tool",
      role: "tool",
      content: [{ type: "tool_result", callId: "metered", name: "tool", content: "ok", isError: false }],
      createdAt: "2026-08-08T12:00:01.000Z",
      usage: { inputTokens: 3, totalTokens: 3 },
    },
  }, 5));
  await observer.close();

  const fields = sink.records.findLast((record) => record.kind === "metrics_snapshot")?.fields;
  assert.equal(fields?.usage_scopes, 2);
  assert.equal(fields?.input_tokens, 13);
  assert.equal(fields?.input_tokens_complete, true);
  assert.equal(fields?.output_tokens, undefined);
  assert.equal(fields?.output_tokens_reported, 2);
  assert.equal(fields?.output_tokens_complete, false);
  assert.equal(fields?.total_tokens, 15);
  assert.equal(fields?.total_tokens_complete, true);
});

test("an unmetered extension compaction does not invalidate exact provider telemetry", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "json",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  observer.observe(envelope({
    type: "provider_attempt_started",
    step: 0,
    attempt: 1,
    provider: "private-provider",
    model: "private-model",
    toolNames: [],
    toolsetFingerprint: "private-fingerprint",
  }, 1));
  observer.observe(envelope({
    type: "usage",
    semantics: "final",
    usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
  }, 2));
  observer.observe(envelope({ type: "assistant_completed", finishReason: "stop" }, 3));
  observer.observe(envelope({ type: "compaction_started", reason: "manual" }, 4));
  observer.observe(envelope({
    type: "compaction_completed",
    summary: {
      id: "private-summary-id",
      role: "assistant",
      content: [{ type: "text", text: "private summary" }],
      createdAt: "2026-08-08T12:00:00.000Z",
    },
    sourceMessageIds: [],
    firstKeptMessageId: "private-kept-id",
    tokensBefore: 10,
    reason: "manual",
    willRetry: false,
    fromExtension: true,
  }, 5));
  await observer.close();

  const fields = sink.records.findLast((record) => record.kind === "metrics_snapshot")?.fields;
  assert.equal(fields?.input_tokens, 4);
  assert.equal(fields?.input_tokens_complete, true);
  assert.equal(fields?.total_tokens, 5);
  assert.equal(fields?.total_tokens_complete, true);
});

test("branch summaries distinguish unmetered extensions from metered requests with missing usage", async () => {
  for (const metered of [false, true]) {
    const sink = new MemorySink();
    const observer = new RuntimeObservability(sink, {
      mode: "json",
      processInstance: "0123456789abcdef",
      snapshotIntervalMs: 60_000,
    });
    observer.observe(envelope({
      type: "provider_attempt_started",
      step: 0,
      attempt: 1,
      provider: "private-provider",
      model: "private-model",
      toolNames: [],
      toolsetFingerprint: "private-fingerprint",
    }, 1, "main-run"));
    observer.observe(envelope({
      type: "usage",
      semantics: "final",
      usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
    }, 2, "main-run"));
    observer.observe(envelope({ type: "assistant_completed", finishReason: "stop" }, 3, "main-run"));
    if (metered) {
      observer.observe(envelope({ type: "usage", semantics: "final", usage: {} }, 4, "summary-run"));
    }
    observer.observe(envelope({
      type: "branch_summary_created",
      summary: {
        id: "private-summary-id",
        role: "user",
        content: [{ type: "text", text: "private summary" }],
        createdAt: "2026-08-08T12:00:00.000Z",
      },
      sourceBranch: "private-source",
      sourceEventIds: [],
    }, 5, "summary-run"));
    observer.releaseCorrelation("summary-run");
    await observer.close();

    const fields = sink.records.findLast((record) => record.kind === "metrics_snapshot")?.fields;
    assert.equal(fields?.input_tokens, metered ? undefined : 4);
    assert.equal(fields?.input_tokens_reported, metered ? 4 : undefined);
    assert.equal(fields?.input_tokens_complete, !metered);
  }
});

test("aggregate usage keeps model and compaction requests in separate accounting scopes", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "interactive",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  observer.observe(envelope({
    type: "provider_attempt_started",
    step: 0,
    attempt: 1,
    provider: "private-provider",
    model: "private-model",
    toolNames: [],
    toolsetFingerprint: "private-fingerprint",
  }, 1));
  observer.observe(envelope({ type: "usage", semantics: "final", usage: { inputTokens: 100 } }, 2));
  observer.observe(envelope({ type: "compaction_started", reason: "threshold" }, 3));
  observer.observe(envelope({ type: "usage", semantics: "final", usage: { inputTokens: 25 } }, 4));
  observer.observe(envelope({
    type: "compaction_completed",
    summary: {
      id: "private-summary-id",
      role: "assistant",
      content: [{ type: "text", text: "private summary" }],
      createdAt: "2026-08-08T12:00:00.000Z",
    },
    sourceMessageIds: ["private-source-id"],
    firstKeptMessageId: "private-kept-id",
    tokensBefore: 1_000,
    reason: "threshold",
    willRetry: false,
    fromExtension: false,
    usage: { inputTokens: 25 },
  }, 5));
  await observer.close();
  const snapshot = sink.records.findLast((record) => record.kind === "metrics_snapshot");
  assert.equal(snapshot?.fields.input_tokens, 125);
  assert.doesNotMatch(JSON.stringify(sink.records), /private summary|private-summary-id|private-source-id|private-kept-id/u);
});

test("summary retry boundaries count final usage from every provider attempt", async () => {
  for (const source of ["compaction", "branchSummary"] as const) {
    const sink = new MemorySink();
    const observer = new RuntimeObservability(sink, {
      mode: "interactive",
      processInstance: "0123456789abcdef",
      snapshotIntervalMs: 60_000,
    });
    let sequence = 0;
    if (source === "compaction") {
      observer.observe(envelope({ type: "compaction_started", reason: "threshold" }, ++sequence));
    }
    observer.observe(envelope({
      type: "usage",
      semantics: "final",
      usage: { inputTokens: 100, cacheReadTokens: 50 },
    }, ++sequence));
    observer.observe(envelope(source === "compaction"
      ? { type: "summarization_retry_attempt_start", source, reason: "threshold" }
      : { type: "summarization_retry_attempt_start", source }, ++sequence));
    observer.observe(envelope({
      type: "usage",
      semantics: "final",
      usage: { inputTokens: 80, cacheReadTokens: 40 },
    }, ++sequence));
    await observer.close();

    const snapshot = sink.records.findLast((record) => record.kind === "metrics_snapshot");
    assert.equal(snapshot?.fields.input_tokens, 180, source);
    assert.equal(snapshot?.fields.cache_read_tokens, 90, source);
  }
});

test("compaction start observability reports the projected context pressure", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "interactive",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  observer.observe(envelope({
    type: "compaction_started",
    reason: "overflow",
    willRetry: true,
    estimatedTokensBefore: 237_505,
  }, 1));
  await observer.close();

  const started = sink.records.find((record) => record.kind === "event" && record.name === "compaction_started");
  assert.equal(started?.fields.estimated_tokens_before, 237_505);
  assert.equal(started?.fields.compaction_reason, "overflow");
  assert.equal(started?.fields.will_retry, true);
});

test("auxiliary correlation release drops aliases and final-usage accounting without a run terminal", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "sdk",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  const branchSummary = (sequence: number): EventEnvelope => envelope({
    type: "branch_summary_created",
    summary: {
      id: `summary-${sequence}`,
      role: "user",
      content: [{ type: "text", text: "bounded summary" }],
      createdAt: "2026-08-08T12:00:00.000Z",
    },
    sourceBranch: "root",
    sourceEventIds: [],
    usage: { inputTokens: 5 },
  }, sequence, "auxiliary-summary");

  observer.observe(branchSummary(1));
  const release = Reflect.get(observer, "releaseCorrelation");
  assert.equal(typeof release, "function");
  Reflect.apply(release as (...args: unknown[]) => unknown, observer, ["auxiliary-summary"]);
  observer.observe(branchSummary(2));
  observer.snapshot();
  await observer.close();

  const summaries = sink.records.filter((record) => record.name === "branch_summary_created");
  assert.deepEqual(summaries.map((record) => record.correlation?.run), ["r1", "r2"]);
  const snapshot = sink.records.find((record) => record.kind === "metrics_snapshot");
  assert.equal(snapshot?.fields.branch_summaries, 2);
  assert.equal(snapshot?.fields.input_tokens, 10);
  assert.equal(snapshot?.fields.runs_started, 0);
  assert.equal(snapshot?.fields.runs_completed, 0);
  assert.equal(snapshot?.fields.runs_failed, 0);
  assert.equal(snapshot?.fields.runs_cancelled, 0);
  assert.equal(snapshot?.fields.active_runs, 0);
});

test("run termination releases unfinished tool observations", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "interactive",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  observer.observe(envelope({ type: "run_started", provider: "fixture", model: "fixture" }, 1));
  observer.observe(envelope({
    type: "tool_started",
    callId: "unfinished-call",
    name: "bash",
    index: 0,
    input: { command: "sleep 1" },
    recoveryMode: "repeatable",
  }, 2));
  observer.observe(envelope({ type: "run_cancelled", reason: "user" }, 3));
  observer.snapshot();
  await observer.close();

  const snapshots = sink.records.filter((record) => record.kind === "metrics_snapshot");
  assert.equal(snapshots[0]?.fields.active_runs, 0);
  assert.equal(snapshots[0]?.fields.active_tools, 0);
});

test("progress observed without a start cannot release another run's active tool", async () => {
  const sink = new MemorySink();
  const observer = new RuntimeObservability(sink, {
    mode: "interactive",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
  });
  observer.observe(envelope({ type: "run_started", provider: "fixture", model: "fixture" }, 1, "active-run"));
  observer.observe(envelope({
    type: "tool_started",
    callId: "active-call",
    name: "bash",
    index: 0,
    input: { command: "sleep 1" },
    recoveryMode: "repeatable",
  }, 2, "active-run"));
  observer.observe(envelope({ type: "run_started", provider: "fixture", model: "fixture" }, 3, "partial-run"));
  observer.observe(envelope({
    type: "tool_progress",
    callId: "partial-call",
    name: "bash",
    index: 0,
    sequence: 1,
    progress: { type: "result", content: "partial", isError: false },
  }, 4, "partial-run"));
  observer.observe(envelope({ type: "run_cancelled", reason: "user" }, 5, "partial-run"));
  observer.snapshot();
  await observer.close();

  const snapshots = sink.records.filter((record) => record.kind === "metrics_snapshot");
  assert.equal(snapshots[0]?.fields.active_runs, 1);
  assert.equal(snapshots[0]?.fields.active_tools, 1);
});
