import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { CanonicalMessage } from "../../src/core/types.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { HarnessService } from "../../src/service/harness.js";
import {
  HARNESS_TRANSCRIPT_LIMITS,
  parseHarnessTranscriptPage,
} from "../../src/service/transcript.js";
import { SessionStore } from "../../src/storage/store.js";

function message(
  id: string,
  role: CanonicalMessage["role"],
  text: string,
  extra: Partial<CanonicalMessage> = {},
): CanonicalMessage {
  return {
    id,
    role,
    content: [{ type: "text", text }],
    createdAt: "2026-07-12T00:00:00.000Z",
    ...extra,
  };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "harness-transcript-replay-"));
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const service = new HarnessService({ store, workspace: root, providers: new ProviderRegistry() });
  await service.initialize({ skills: [] });
  t.after(async () => {
    await service.close("transcript_replay_test");
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, service };
}

test("transcript replay is branch-correct, cursor-paginated, and transcript-visible only", async (t) => {
  const { root, store, service } = await fixture(t);
  const thread = store.createThread({ threadId: "transcript-thread", workspaceRoot: root });
  store.appendEvent({
    threadId: thread.threadId,
    event: { type: "message_appended", message: message("system", "system", "SYSTEM_SECRET", { purpose: "instructions" }) },
  });
  store.appendEvent({
    threadId: thread.threadId,
    event: { type: "message_appended", message: message("user", "user", "common user") },
  });
  const forkPoint = store.appendEvent({
    threadId: thread.threadId,
    event: {
      type: "message_appended",
      message: {
        ...message("assistant", "assistant", "safe assistant"),
        content: [
          { type: "text", text: "safe assistant" },
          { type: "image", mediaType: "image/png", data: "IMAGE_DATA_SECRET" },
          {
            type: "provider_opaque",
            provider: "openai",
            mediaType: "application/json",
            value: { hidden: "OPAQUE_SECRET" },
            serialized: "OPAQUE_SERIALIZED_SECRET",
          },
        ],
      },
      providerState: { kind: "openai_responses", outputItems: [{ hidden: "PROVIDER_STATE_SECRET" }] },
      providerStateSerialized: "{\"kind\":\"openai_responses\",\"outputItems\":[{\"hidden\":\"PROVIDER_STATE_SECRET\"}]}",
    },
  });
  store.forkBranch({ threadId: thread.threadId, newBranch: "experiment", atEventId: forkPoint.eventId });

  store.appendEvent({
    threadId: thread.threadId,
    event: { type: "reasoning_delta", text: "visible reasoning summary", part: 0, visibility: "summary" },
  });
  store.appendEvent({
    threadId: thread.threadId,
    event: { type: "reasoning_delta", text: "PROVIDER_TRACE_SECRET", part: 0, visibility: "provider_trace" },
  });
  store.appendEvent({
    threadId: thread.threadId,
    event: {
      type: "tool_requested",
      callId: "call-1",
      name: "fetch",
      index: 0,
      input: { authorization: "Bearer TOOL_INPUT_SECRET", headers: { "x-api-key": "TOOL_HEADER_SECRET" } },
    },
  });
  store.appendEvent({
    threadId: thread.threadId,
    event: {
      type: "tool_completed",
      callId: "call-1",
      name: "fetch",
      index: 0,
      isError: false,
      preview: "completed safely; api_key=TOOL_PREVIEW_SECRET",
      result: {
        type: "tool_result",
        callId: "call-1",
        name: "fetch",
        content: "RAW_TOOL_RESULT_SECRET",
        isError: false,
        status: "success",
        summary: "summary safely",
        nextActions: ["NEXT_ACTION_SECRET"],
        images: [{ type: "image", mediaType: "image/jpeg", url: "https://secret.invalid/image?token=URL_SECRET" }],
        metadata: { authorization: "METADATA_SECRET" },
      },
    },
  });
  store.appendEvent({
    threadId: thread.threadId,
    event: {
      type: "usage",
      semantics: "final",
      usage: { inputTokens: 4, raw: { authorization: "USAGE_SECRET" } },
    },
  });
  store.appendEvent({
    threadId: thread.threadId,
    event: {
      type: "extension_state",
      extensionId: "fixture",
      schemaVersion: 1,
      key: "private",
      value: { password: "EXTENSION_STATE_SECRET" },
    },
  });
  store.appendEvent({
    threadId: thread.threadId,
    event: {
      type: "extension_message",
      extensionId: "fixture",
      schemaVersion: 1,
      kind: "private",
      messageId: "extension-private",
      payload: { secret: "EXTENSION_PAYLOAD_SECRET" },
      modelContext: { role: "system", text: "EXTENSION_CONTEXT_SECRET" },
      transcript: false,
    },
  });
  store.appendEvent({
    threadId: thread.threadId,
    event: {
      type: "extension_message",
      extensionId: "fixture",
      schemaVersion: 1,
      kind: "visible",
      messageId: "extension-visible",
      payload: { secret: "VISIBLE_PAYLOAD_SECRET" },
      modelContext: { role: "user", text: "VISIBLE_CONTEXT_SECRET" },
      transcript: { text: "visible extension message" },
    },
  });
  store.appendEvent({
    threadId: thread.threadId,
    event: {
      type: "compaction_completed",
      summary: message("compaction", "assistant", "COMPACTION_CONTEXT_SECRET", { purpose: "compaction" }),
      sourceMessageIds: ["user", "assistant"],
      extensionMetadata: { secret: "COMPACTION_METADATA_SECRET" },
    },
  });
  store.appendEvent({
    threadId: thread.threadId,
    event: {
      type: "run_failed",
      error: {
        category: "provider",
        message: "failed safely; Authorization: Bearer RUN_ERROR_SECRET",
        retryable: false,
        partial: false,
        raw: { headers: { authorization: "RAW_ERROR_SECRET" } },
      },
    },
  });
  store.appendEvent({
    threadId: thread.threadId,
    branch: "experiment",
    event: {
      type: "branch_summary_created",
      summary: message("branch-summary", "user", "visible branch summary", { purpose: "compaction" }),
      sourceBranch: "main",
      sourceEventIds: [forkPoint.eventId],
    },
  });
  store.appendEvent({
    threadId: thread.threadId,
    branch: "experiment",
    event: { type: "message_appended", message: message("experiment-user", "user", "experiment only") },
  });

  const main = await service.getTranscript({ threadId: thread.threadId, branch: "main", limit: 256 });
  const experiment = await service.getTranscript({ threadId: thread.threadId, branch: "experiment", limit: 256 });
  const mainWire = JSON.stringify(main);
  const experimentWire = JSON.stringify(experiment);
  assert.match(mainWire, /common user|safe assistant|visible reasoning summary|visible extension message|summary safely/u);
  assert.match(experimentWire, /common user|safe assistant|visible branch summary|experiment only/u);
  assert.doesNotMatch(mainWire, /experiment only/u);
  assert.doesNotMatch(experimentWire, /visible reasoning summary|visible extension message/u);
  for (const secret of [
    "SYSTEM_SECRET", "IMAGE_DATA_SECRET", "OPAQUE_SECRET", "OPAQUE_SERIALIZED_SECRET", "PROVIDER_STATE_SECRET",
    "PROVIDER_TRACE_SECRET", "TOOL_INPUT_SECRET", "TOOL_HEADER_SECRET", "TOOL_PREVIEW_SECRET", "RAW_TOOL_RESULT_SECRET",
    "NEXT_ACTION_SECRET", "URL_SECRET", "METADATA_SECRET", "USAGE_SECRET", "EXTENSION_STATE_SECRET",
    "EXTENSION_PAYLOAD_SECRET", "EXTENSION_CONTEXT_SECRET", "VISIBLE_PAYLOAD_SECRET", "VISIBLE_CONTEXT_SECRET",
    "COMPACTION_CONTEXT_SECRET", "COMPACTION_METADATA_SECRET", "RUN_ERROR_SECRET", "RAW_ERROR_SECRET",
  ]) assert.doesNotMatch(mainWire, new RegExp(secret, "u"));
  assert.doesNotMatch(mainWire, /providerState|provider_opaque|modelContext|authorization|headers|callback|rawArguments|"payload"|"raw"|"data"|"url"/u);
  assert.deepEqual(
    main.entries.flatMap((entry) => entry.images ?? []),
    [
      { mediaType: "image/png", source: "embedded" },
      { mediaType: "image/jpeg", source: "remote" },
    ],
  );

  const seen: number[] = [];
  let afterSequence: number | undefined;
  do {
    const page = await service.getTranscript({
      threadId: thread.threadId,
      branch: "main",
      limit: 2,
      ...(afterSequence === undefined ? {} : { afterSequence }),
    });
    seen.push(...page.entries.map((entry) => entry.sequence));
    if (!page.hasMore) break;
    assert.ok(page.nextSequence !== undefined && page.nextSequence > (afterSequence ?? -1));
    afterSequence = page.nextSequence;
  } while (true);
  assert.deepEqual(seen, main.entries.map((entry) => entry.sequence));
  assert.equal(new Set(seen).size, seen.length);
});

test("transcript replay enforces entry, byte, workspace, and cancellation bounds", async (t) => {
  const { root, store, service } = await fixture(t);
  const thread = store.createThread({ threadId: "bounded-transcript", workspaceRoot: root });
  for (let index = 0; index < 80; index += 1) {
    store.appendEvent({
      threadId: thread.threadId,
      event: {
        type: "message_appended",
        message: message(`message-${index}`, "assistant", `${index}:` + "x".repeat(80_000)),
      },
    });
  }
  const page = await service.getTranscript({ threadId: thread.threadId, limit: HARNESS_TRANSCRIPT_LIMITS.maxEntries });
  assert.ok(page.entries.length > 0 && page.entries.length < 80);
  assert.equal(page.hasMore, true);
  assert.equal(page.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= HARNESS_TRANSCRIPT_LIMITS.maxBytes);
  assert.ok(page.entries.every((entry) => entry.text === undefined || Buffer.byteLength(entry.text, "utf8") <= HARNESS_TRANSCRIPT_LIMITS.maxTextBytes));

  await assert.rejects(service.getTranscript({ threadId: thread.threadId, limit: 0 }), /limit/u);
  await assert.rejects(service.getTranscript({ threadId: thread.threadId, afterSequence: -1 }), /afterSequence/u);
  await assert.rejects(service.getTranscript({ threadId: thread.threadId, branch: "missing" }), /Unknown branch/u);
  const other = store.createThread({ threadId: "other-workspace", workspaceRoot: join(root, "other") });
  await assert.rejects(service.getTranscript({ threadId: other.threadId }), /workspace/u);
  const controller = new AbortController();
  controller.abort(new Error("cancel transcript"));
  await assert.rejects(service.getTranscript({ threadId: thread.threadId, signal: controller.signal }), /cancel transcript/u);
});

test("transcript replay pages long invisible histories without materializing the branch", async (t) => {
  const { root, store, service } = await fixture(t);
  const thread = store.createThread({ threadId: "paged-transcript", workspaceRoot: root });
  const appendInvisible = (offset: number): void => {
    for (let start = 0; start < 2_048; start += 512) {
      store.appendEvents({
        threadId: thread.threadId,
        events: Array.from({ length: 512 }, (_, index) => ({
          type: "warning" as const,
          code: "unknown_provider_event",
          message: `hidden-${offset + start + index}`,
        })),
      });
    }
  };
  appendInvisible(0);
  store.appendEvent({
    threadId: thread.threadId,
    event: { type: "message_appended", message: message("first-visible", "assistant", "first visible") },
  });
  appendInvisible(2_048);
  store.appendEvent({
    threadId: thread.threadId,
    event: { type: "message_appended", message: message("second-visible", "assistant", "second visible") },
  });

  const listEvents = store.listEvents.bind(store);
  const listEventPage = store.listEventPage.bind(store);
  let fullHistoryReads = 0;
  let pageReads = 0;
  let largestRequestedPage = 0;
  store.listEvents = () => {
    fullHistoryReads += 1;
    throw new Error("Transcript replay must not read the complete branch");
  };
  store.listEventPage = (threadId, branch, options) => {
    pageReads += 1;
    largestRequestedPage = Math.max(largestRequestedPage, options.limit);
    const page = listEventPage(threadId, branch, options);
    assert.ok(page.events.length <= HARNESS_TRANSCRIPT_LIMITS.maxEntries);
    return page;
  };
  try {
    const first = await service.getTranscript({ threadId: thread.threadId, limit: 1 });
    assert.deepEqual(first.entries.map((entry) => entry.text), ["first visible"]);
    assert.equal(first.hasMore, true);
    assert.ok(first.nextSequence !== undefined);

    const second = await service.getTranscript({
      threadId: thread.threadId,
      afterSequence: first.nextSequence,
      limit: 1,
    });
    assert.deepEqual(second.entries.map((entry) => entry.text), ["second visible"]);
    assert.equal(second.hasMore, false);
  } finally {
    store.listEvents = listEvents;
    store.listEventPage = listEventPage;
  }
  assert.equal(fullHistoryReads, 0);
  assert.ok(pageReads > 16, `expected multiple bounded reads, received ${pageReads}`);
  assert.equal(largestRequestedPage, HARNESS_TRANSCRIPT_LIMITS.maxEntries);
});

test("transcript page parser rejects owner-controlled and private wire fields", () => {
  const page = {
    schemaVersion: 1 as const,
    threadId: "thread",
    branch: "main",
    entries: [],
    hasMore: false,
    truncated: false,
  };
  assert.deepEqual(parseHarnessTranscriptPage(page), page);
  assert.throws(() => parseHarnessTranscriptPage({ ...page, providerState: { secret: true } }), /unknown/u);
  assert.throws(() => parseHarnessTranscriptPage({ ...page, truncated: true }), /inconsistent/u);
  assert.throws(() => parseHarnessTranscriptPage({
    ...page,
    entries: [{
      eventId: "event",
      sequence: 1,
      timestamp: "2026-07-12T00:00:00.000Z",
      kind: "message",
      role: "assistant",
      text: "safe",
      providerStateSerialized: "secret",
    }],
  }), /unknown/u);
  let invoked = false;
  const entries: unknown[] = [];
  Object.defineProperty(entries, "0", {
    enumerable: true,
    get() {
      invoked = true;
      return {};
    },
  });
  entries.length = 1;
  assert.throws(() => parseHarnessTranscriptPage({ ...page, entries }), /data entries/u);
  assert.equal(invoked, false);
  assert.throws(() => parseHarnessTranscriptPage({ ...page, callback() {} }), /unknown/u);
});
