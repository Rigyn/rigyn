import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEvent } from "../../src/core/events.js";
import type { CanonicalMessage, ContentBlock } from "../../src/core/types.js";
import {
  MAX_THREAD_PREVIEW_MESSAGE_COUNT,
  MAX_THREAD_PREVIEW_RECENT_MESSAGES,
  MAX_THREAD_PREVIEW_SEARCH_BYTES,
  SessionStore,
} from "../../src/storage/store.js";

const timestamp = "2026-07-10T00:00:00.000Z";

function message(id: string, role: CanonicalMessage["role"], content: ContentBlock[], displayText?: string): CanonicalMessage {
  return {
    id,
    role,
    content,
    createdAt: timestamp,
    ...(displayText === undefined ? {} : { displayText }),
  };
}

function textMessage(id: string, role: CanonicalMessage["role"], text: string, displayText?: string): CanonicalMessage {
  return message(id, role, [{ type: "text", text }], displayText);
}

test("thread previews follow reachable branch history while retaining the picker latest-run rule", () => {
  const store = new SessionStore(":memory:");
  try {
    store.createThread({ threadId: "preview-branches" });
    const root = store.appendEvent({
      threadId: "preview-branches",
      event: {
        type: "message_appended",
        message: textMessage("root-user", "user", "root searchable", "Displayed root prompt"),
      },
    });
    store.appendEvent({
      threadId: "preview-branches",
      event: { type: "message_appended", message: textMessage("main-assistant", "assistant", "main-only answer") },
    });
    store.forkBranch({
      threadId: "preview-branches",
      newBranch: "experiment",
      atEventId: root.eventId,
    });
    store.appendEvent({
      threadId: "preview-branches",
      branch: "experiment",
      event: { type: "message_appended", message: textMessage("experiment-user", "user", "experiment-only prompt") },
    });
    store.forkBranch({
      threadId: "preview-branches",
      newBranch: "empty",
      atEventId: null,
    });

    const firstRun = store.startRun({
      threadId: "preview-branches",
      branch: "main",
      runId: "run-a",
      provider: "openai",
      model: "gpt-test",
    });
    store.appendEvent({
      threadId: "preview-branches",
      branch: "main",
      runId: firstRun.runId,
      event: { type: "run_cancelled", reason: "fixture" },
    });
    const latestRun = store.startRun({
      threadId: "preview-branches",
      branch: "experiment",
      runId: "run-z",
      provider: "anthropic",
      model: "claude-test",
    });
    store.appendEvent({
      threadId: "preview-branches",
      branch: "experiment",
      runId: latestRun.runId,
      event: { type: "run_cancelled", reason: "fixture" },
    });

    const main = store.getThreadPreview("preview-branches", { branch: "main" });
    assert.equal(main.branch, "main");
    assert.equal(main.hasUserMessage, true);
    assert.equal(main.firstPrompt, "Displayed root prompt");
    assert.equal(main.messageCount, 2);
    assert.equal(main.messageCountTruncated, false);
    assert.match(main.recentSearchText, /root searchable/u);
    assert.match(main.recentSearchText, /main-only answer/u);
    assert.doesNotMatch(main.recentSearchText, /experiment-only/u);
    assert.equal(main.latestProvider, "anthropic");
    assert.equal(main.latestModel, "claude-test");

    const experiment = store.getThreadPreview("preview-branches", { branch: "experiment" });
    assert.equal(experiment.messageCount, 2);
    assert.match(experiment.recentSearchText, /root searchable/u);
    assert.match(experiment.recentSearchText, /experiment-only prompt/u);
    assert.doesNotMatch(experiment.recentSearchText, /main-only/u);

    const empty = store.getThreadPreview("preview-branches", { branch: "empty" });
    assert.equal(empty.hasUserMessage, false);
    assert.equal(empty.messageCount, 0);
    assert.equal(empty.firstPrompt, undefined);
    assert.equal(empty.recentSearchText, "");

    store.setDefaultBranch("preview-branches", "experiment");
    assert.equal(store.getThreadPreview("preview-branches").branch, "experiment");
  } finally {
    store.close();
  }
});

test("thread previews cap counts and bytes without loading complete event or run arrays", () => {
  const store = new SessionStore(":memory:");
  try {
    store.createThread({ threadId: "preview-large" });
    const events: RuntimeEvent[] = Array.from({ length: 40 }, (_, index) => ({
      type: "message_appended",
      message: textMessage(
        `large-${index}`,
        index % 2 === 0 ? "user" : "assistant",
        `${index === 0 ? "first prompt" : index >= 37 ? `recent-${index}` : `old-${index}`} ${"x".repeat(8 * 1024)}`,
      ),
    }));
    store.appendEvents({ threadId: "preview-large", events });

    const instance = store as SessionStore & {
      listEvents: () => never;
      listRuns: () => never;
    };
    instance.listEvents = () => {
      throw new Error("getThreadPreview must not call listEvents");
    };
    instance.listRuns = () => {
      throw new Error("getThreadPreview must not call listRuns");
    };

    const preview = store.getThreadPreview("preview-large", {
      messageCountLimit: 16,
      recentMessageLimit: 3,
      searchByteLimit: 1_024,
    });
    assert.equal(preview.hasUserMessage, true);
    assert.equal(preview.messageCount, 16);
    assert.equal(preview.messageCountTruncated, true);
    assert.equal(preview.searchTruncated, true);
    assert.ok(Buffer.byteLength(preview.firstPrompt ?? "", "utf8") <= 512);
    assert.match(preview.firstPrompt ?? "", /^first prompt/u);
    assert.ok(Buffer.byteLength(preview.recentSearchText, "utf8") <= 1_024);
    assert.match(preview.recentSearchText, /recent-37/u);
    assert.doesNotMatch(preview.recentSearchText, /old-36/u);
  } finally {
    store.close();
  }
});

test("thread preview search caps the number of message parts and preserves UTF-8 boundaries", () => {
  const store = new SessionStore(":memory:");
  try {
    store.createThread({ threadId: "preview-parts" });
    store.appendEvent({
      threadId: "preview-parts",
      event: {
        type: "message_appended",
        message: message(
          "many-parts",
          "user",
          Array.from({ length: 600 }, (_, index) => ({ type: "text" as const, text: `part-${index}` })),
        ),
      },
    });
    const capped = store.getThreadPreview("preview-parts");
    assert.equal(capped.searchTruncated, true);
    assert.match(capped.recentSearchText, /^part-0/u);
    assert.doesNotMatch(capped.recentSearchText, /part-599/u);
    assert.ok(Buffer.byteLength(capped.recentSearchText, "utf8") <= MAX_THREAD_PREVIEW_SEARCH_BYTES);

    store.createThread({ threadId: "preview-unicode" });
    store.appendEvent({
      threadId: "preview-unicode",
      event: { type: "message_appended", message: textMessage("unicode", "user", "😀😀") },
    });
    const unicode = store.getThreadPreview("preview-unicode", { searchByteLimit: 5 });
    assert.equal(unicode.recentSearchText, "😀");
    assert.equal(Buffer.byteLength(unicode.recentSearchText, "utf8"), 4);
    assert.equal(unicode.searchTruncated, true);
    assert.doesNotMatch(unicode.recentSearchText, /�/u);
  } finally {
    store.close();
  }
});

test("thread preview limits and branch references are validated", () => {
  const store = new SessionStore(":memory:");
  try {
    store.createThread({ threadId: "preview-validation" });
    store.appendEvent({
      threadId: "preview-validation",
      event: { type: "message_appended", message: textMessage("validation", "user", "prompt") },
    });

    assert.throws(
      () => store.getThreadPreview("preview-validation", { messageCountLimit: 0 }),
      /messageCountLimit must be an integer/u,
    );
    assert.throws(
      () => store.getThreadPreview("preview-validation", { messageCountLimit: MAX_THREAD_PREVIEW_MESSAGE_COUNT + 1 }),
      /messageCountLimit/u,
    );
    assert.throws(
      () => store.getThreadPreview("preview-validation", { recentMessageLimit: 0 }),
      /recentMessageLimit must be an integer/u,
    );
    assert.throws(
      () => store.getThreadPreview("preview-validation", { recentMessageLimit: MAX_THREAD_PREVIEW_RECENT_MESSAGES + 1 }),
      /recentMessageLimit/u,
    );
    assert.throws(
      () => store.getThreadPreview("preview-validation", { searchByteLimit: -1 }),
      /searchByteLimit must be an integer/u,
    );
    assert.throws(
      () => store.getThreadPreview("preview-validation", { searchByteLimit: MAX_THREAD_PREVIEW_SEARCH_BYTES + 1 }),
      /searchByteLimit/u,
    );
    assert.throws(
      () => store.getThreadPreview("preview-validation", { searchByteLimit: 1.5 }),
      /searchByteLimit must be an integer/u,
    );
    assert.throws(
      () => store.getThreadPreview("preview-validation", { branch: "../escape" }),
      /Invalid branch name/u,
    );
    assert.throws(
      () => store.getThreadPreview("preview-validation", { branch: "missing" }),
      /Unknown branch/u,
    );
    assert.throws(() => store.getThreadPreview("missing-thread"), /Unknown thread/u);

    const noSearch = store.getThreadPreview("preview-validation", { searchByteLimit: 0 });
    assert.equal(noSearch.recentSearchText, "");
    assert.equal(noSearch.searchTruncated, true);
  } finally {
    store.close();
  }
});
