import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionStore } from "../../src/storage/index.js";
import { DEFAULT_TUI_LIMITS } from "../../src/tui/controller.js";
import { TuiModel } from "../../src/tui/model.js";

test("structured tool progress survives restart and remains replaceable until completion", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-result-progress-"));
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  const database = join(directory, "sessions.sqlite");
  let store = new SessionStore(database);
  store.createThread({ threadId: "thread_progress", workspaceRoot: directory });
  const run = store.startRun({ threadId: "thread_progress", runId: "run_progress" });
  store.appendEvents({
    threadId: run.threadId,
    runId: run.runId,
    events: [
      { type: "tool_requested", callId: "call_progress", name: "delegate", input: { task: "inspect" }, index: 0 },
      { type: "tool_started", callId: "call_progress", name: "delegate", index: 0 },
      {
        type: "tool_progress",
        callId: "call_progress",
        name: "delegate",
        index: 0,
        sequence: 0,
        progress: {
          type: "result",
          content: "last useful state",
          isError: false,
          metadata: { phase: "running", completed: 3 },
          truncated: true,
        },
      },
    ],
  });
  store.close();

  store = new SessionStore(database);
  const events = store.listEvents(run.threadId);
  const progress = events.find((entry) => entry.event.type === "tool_progress")?.event;
  assert.deepEqual(progress?.type === "tool_progress" ? progress.progress : undefined, {
    type: "result",
    content: "last useful state",
    isError: false,
    metadata: { phase: "running", completed: 3 },
    truncated: true,
  });

  const model = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxToolPreviewBytes: 128 });
  for (const event of events) model.apply(event);
  assert.deepEqual(model.entries[0]?.toolData?.partialResult, {
    content: "last useful state",
    isError: false,
    metadata: { phase: "running", completed: 3 },
    truncated: true,
  });

  const completed = store.appendEvent({
    threadId: run.threadId,
    runId: run.runId,
    event: {
      type: "tool_completed",
      callId: "call_progress",
      name: "delegate",
      index: 0,
      isError: false,
      preview: "delegate complete",
    },
  });
  model.apply(completed);
  assert.equal(model.entries[0]?.toolData?.partialResult, undefined);
  assert.equal(model.entries[0]?.toolData?.result?.content, "delegate complete");
  store.close();
});
