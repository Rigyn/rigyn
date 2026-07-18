import assert from "node:assert/strict";
import test from "node:test";
import { TuiModel } from "../../src/tui/model.js";
import { DEFAULT_TUI_LIMITS } from "../../src/tui/controller.js";
import { envelope } from "./helpers.js";

function richReplayEvents() {
  return [
    envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1),
    envelope({ type: "model_selected", provider: "openai", model: "gpt-test", reasoningEffort: "high" }, 2),
    envelope({ type: "assistant_started", step: 1 }, 3),
    envelope({ type: "reasoning_delta", text: "Inspect the saved work", part: 0, visibility: "summary" }, 4),
    envelope({ type: "text_delta", text: "Reading files", part: 0 }, 5),
    envelope({
      type: "message_appended",
      message: {
        id: "assistant-rich",
        role: "assistant",
        content: [{ type: "text", text: "Reading files" }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    }, 6),
    envelope({ type: "assistant_completed", finishReason: "tool_calls" }, 7),
    envelope({
      type: "tool_requested",
      callId: "call-rich",
      name: "read",
      input: { path: "src/index.ts" },
      index: 0,
    }, 8),
    envelope({ type: "tool_started", callId: "call-rich", name: "read", index: 0 }, 9),
    envelope({
      type: "tool_progress",
      callId: "call-rich",
      name: "read",
      index: 0,
      sequence: 0,
      progress: { type: "result", content: "partial source", isError: false, metadata: { lines: 1 } },
    }, 10),
    envelope({
      type: "tool_completed",
      callId: "call-rich",
      name: "read",
      index: 0,
      isError: false,
      preview: "complete source",
      result: {
        type: "tool_result",
        callId: "call-rich",
        name: "read",
        content: "complete source",
        isError: false,
        metadata: { lines: 2 },
      },
    }, 11),
    envelope({
      type: "message_appended",
      message: {
        id: "tool-rich",
        role: "tool",
        content: [{
          type: "tool_result",
          callId: "call-rich",
          name: "read",
          content: "complete source",
          isError: false,
          metadata: { lines: 2 },
        }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    }, 12),
    envelope({
      type: "extension_state",
      extensionId: "owner.extension",
      schemaVersion: 1,
      key: "counter",
      value: { count: 2 },
    }, 13),
    envelope({
      type: "extension_message",
      extensionId: "owner.extension",
      schemaVersion: 1,
      kind: "hidden",
      messageId: "hidden-rich",
      payload: { private: true },
      modelContext: false,
      transcript: false,
    }, 14),
    envelope({
      type: "extension_message",
      extensionId: "owner.extension",
      schemaVersion: 1,
      kind: "visible",
      messageId: "visible-rich",
      payload: { renderer: true },
      modelContext: false,
      transcript: { text: "Visible extension status" },
    }, 15),
    envelope({
      type: "usage",
      semantics: "final",
      usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 80, cost: "0.01" },
    }, 16),
    envelope({ type: "warning", code: "fixture", message: "Retained warning" }, 17),
    envelope({ type: "run_completed", finishReason: "stop" }, 18),
  ];
}

test("TUI model folds streaming and tool events into bounded transcript entries", () => {
  const model = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxTranscriptBytes: 200, maxToolPreviewBytes: 40 });
  model.apply(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  model.apply(envelope({ type: "text_delta", text: "hello\u001b[2J ", part: 0 }, 2));
  model.apply(envelope({ type: "text_delta", text: "world", part: 0 }, 3));
  model.apply(envelope({ type: "tool_requested", callId: "call_1", name: "read", input: { path: "src/a.ts" }, index: 0 }, 4));
  model.apply(envelope({ type: "tool_started", callId: "call_1", name: "read", index: 0 }, 5));
  model.apply(envelope({ type: "tool_completed", callId: "call_1", name: "read", index: 0, isError: false, preview: "line 1\nline 2" }, 6));
  assert.equal(model.entries[0]?.text, "hello world");
  assert.equal(model.entries[0]?.hasToolCalls, true);
  assert.deepEqual(model.entries[1], {
    id: "tool:call_1",
    kind: "tool",
    callId: "call_1",
    title: "read",
    summary: "src/a.ts",
    text: "line 1\nline 2",
    toolData: {
      input: { path: "src/a.ts" },
      result: { content: "line 1\nline 2", isError: false },
    },
    status: "completed",
    expanded: true,
  });
  assert.equal(model.toggleTool("call_1"), true);
  assert.equal(model.entries[1]?.expanded, false);
});

test("bulk replay produces the same rich transcript state as sequential event application", () => {
  const events = richReplayEvents();
  const sequential = new TuiModel(DEFAULT_TUI_LIMITS);
  const bulk = new TuiModel(DEFAULT_TUI_LIMITS);

  for (const event of events) sequential.apply(event);
  bulk.applyAll(events);

  assert.deepEqual(bulk.entries, sequential.entries);
  assert.deepEqual(bulk.committableEntries(), sequential.committableEntries());
  assert.deepEqual(bulk.context, sequential.context);
  assert.deepEqual(bulk.usage, sequential.usage);
  assert.equal(bulk.notice, sequential.notice);
});

test("bulk replay keeps a realistic ten-thousand-event tool history bounded", () => {
  const events = [];
  let sequence = 0;
  for (let index = 0; index < 2_500; index += 1) {
    const callId = `bulk-${index}`;
    events.push(
      envelope({
        type: "tool_requested",
        callId,
        name: "read",
        input: { path: `src/fixture-${index}.ts` },
        index: 0,
      }, sequence += 1),
      envelope({ type: "tool_started", callId, name: "read", index: 0 }, sequence += 1),
      envelope({
        type: "tool_progress",
        callId,
        name: "read",
        index: 0,
        sequence: 0,
        progress: {
          type: "result",
          content: `partial result ${index}`,
          isError: false,
          metadata: { index, phase: "running" },
        },
      }, sequence += 1),
      envelope({
        type: "tool_completed",
        callId,
        name: "read",
        index: 0,
        isError: false,
        preview: `completed result ${index}`,
      }, sequence += 1),
    );
  }
  const model = new TuiModel(DEFAULT_TUI_LIMITS);

  model.applyAll(events);

  assert.equal(events.length, 10_000);
  assert.equal(model.entries.length, DEFAULT_TUI_LIMITS.maxTranscriptEntries);
  assert.equal(model.entries[0]?.callId, "bulk-500");
  assert.equal(model.entries.at(-1)?.callId, "bulk-2499");
  assert.match(model.notice ?? "", /Older transcript entries were discarded/u);
});

test("TUI keeps forward-compatible provider telemetry out of the user transcript", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({
    type: "warning",
    code: "unknown_provider_event",
    message: "Provider emitted an unknown event",
    details: { type: "response.future_metadata" },
  }, 1));
  model.apply(envelope({ type: "warning", code: "actionable", message: "Visible warning" }, 2));

  assert.deepEqual(model.entries.map((entry) => [entry.title, entry.text]), [["actionable", "Visible warning"]]);
});

test("TUI model updates one bounded tool card for live progress and clears it at completion", () => {
  const model = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxToolPreviewBytes: 24 });
  model.apply(envelope({
    type: "tool_requested",
    callId: "call_live",
    name: "shell",
    input: { command: "build" },
    index: 0,
  }, 1));
  model.apply(envelope({ type: "tool_started", callId: "call_live", name: "shell", index: 0 }, 2));
  model.apply(envelope({
    type: "tool_progress",
    callId: "call_live",
    name: "shell",
    index: 0,
    sequence: 0,
    progress: { type: "output", stream: "stdout", delta: "", stdoutBytes: 0, stderrBytes: 0, elapsedMs: 10_000 },
  }, 3));
  assert.match(model.entries[0]?.text ?? "", /Still running · 10s/u);
  model.apply(envelope({
    type: "tool_progress",
    callId: "call_live",
    name: "shell",
    index: 0,
    sequence: 1,
    progress: { type: "output", stream: "stdout", delta: "compile\u001b[2J one\n", stdoutBytes: 13, stderrBytes: 0 },
  }, 4));
  model.apply(envelope({
    type: "tool_progress",
    callId: "call_live",
    name: "shell",
    index: 0,
    sequence: 2,
    progress: {
      type: "output",
      stream: "stderr",
      delta: "warning that is deliberately long",
      stdoutBytes: 13,
      stderrBytes: 33,
      truncated: true,
    },
  }, 5));

  assert.equal(model.entries.length, 1);
  assert.equal(model.entries[0]?.id, "tool:call_live");
  assert.equal(model.entries[0]?.status, "running");
  assert.equal(model.entries[0]?.expanded, false);
  assert.doesNotMatch(model.entries[0]?.text ?? "", /\u001b/u);
  assert.match(model.entries[0]?.text ?? "", /stderr \(33 bytes\)/u);
  assert.match(model.entries[0]?.text ?? "", /deliberately long/u);
  assert.doesNotMatch(model.entries[0]?.text ?? "", /compile one/u, "live output should retain the newest tail");
  assert.match(model.entries[0]?.text ?? "", /live output truncated/u);
  const progress = model.entries[0]?.toolData?.progress;
  assert.ok(Buffer.byteLength(`${progress?.stdout ?? ""}${progress?.stderr ?? ""}`, "utf8") <= 24);

  model.apply(envelope({
    type: "tool_completed",
    callId: "call_live",
    name: "shell",
    index: 0,
    isError: false,
    preview: "Command exited 0.",
  }, 6));
  assert.equal(model.entries.length, 1);
  assert.equal(model.entries[0]?.id, "tool:call_live");
  assert.equal(model.entries[0]?.text, "Command exited 0.");
  assert.equal(model.entries[0]?.toolData?.progress, undefined);
  assert.equal(model.entries[0]?.expanded, true);
});

test("TUI model keeps replaceable structured progress on the native tool card until completion", () => {
  const model = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxToolPreviewBytes: 64 });
  model.apply(envelope({
    type: "tool_requested",
    callId: "call_native",
    name: "delegate",
    input: { task: "inspect" },
    index: 0,
  }, 1));
  model.apply(envelope({ type: "tool_started", callId: "call_native", name: "delegate", index: 0 }, 2));
  model.apply(envelope({
    type: "tool_progress",
    callId: "call_native",
    name: "delegate",
    index: 0,
    sequence: 0,
    progress: {
      type: "result",
      content: "child\u001b[2J running",
      isError: false,
      metadata: { state: "running", completed: 1 },
    },
  }, 3));

  assert.equal(model.entries[0]?.status, "running");
  assert.deepEqual(model.entries[0]?.toolData?.partialResult, {
    content: "child running",
    isError: false,
    metadata: { state: "running", completed: 1 },
  });
  assert.equal(Object.hasOwn(model.entries[0]?.toolData ?? {}, "result"), false);

  model.apply(envelope({
    type: "tool_completed",
    callId: "call_native",
    name: "delegate",
    index: 0,
    isError: false,
    preview: "child complete",
  }, 4));
  assert.equal(model.entries[0]?.toolData?.partialResult, undefined);
  const completed = model.entries.at(0);
  assert.equal(completed?.toolData?.result?.content, "child complete");
});

test("completed shell cards retain the latest output instead of the provider preview head", () => {
  const model = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxToolPreviewBytes: 96 });
  model.apply(envelope({
    type: "tool_requested",
    callId: "call_tail",
    name: "bash",
    input: { command: "npm test" },
    index: 0,
  }, 1));
  model.apply(envelope({
    type: "tool_completed",
    callId: "call_tail",
    name: "bash",
    index: 0,
    isError: true,
    preview: "old output from the beginning",
    result: {
      type: "tool_result",
      callId: "call_tail",
      name: "bash",
      content: `${"old\n".repeat(40)}LATEST FAILURE\nCommand exited with code 1`,
      isError: true,
      metadata: { exitCode: 1, durationMs: 61_000, truncated: true, fullOutputPath: "/tmp/full.log" },
    },
  }, 2));

  assert.match(model.entries[0]?.text ?? "", /LATEST FAILURE/u);
  assert.match(model.entries[0]?.text ?? "", /Command exited with code 1/u);
  assert.doesNotMatch(model.entries[0]?.text ?? "", /old output from the beginning/u);
  assert.equal(model.entries[0]?.expanded, true);
});

test("TUI model merges canonical tool results into the lifecycle row", () => {
  const model = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxToolPreviewBytes: 40 });
  model.apply(envelope({
    type: "tool_requested",
    callId: "call_1",
    name: "search",
    input: { query: "needle", path: "src" },
    index: 0,
  }, 1));
  model.apply(envelope({
    type: "tool_completed",
    callId: "call_1",
    name: "search",
    index: 0,
    isError: false,
    preview: "first result\nsecond result",
  }, 2));
  model.apply(envelope({
    type: "message_appended",
    message: {
      id: "message_tool_1",
      role: "tool",
      createdAt: "2026-01-01T00:00:00.000Z",
      content: [{
        type: "tool_result",
        callId: "call_1",
        name: "search",
        content: "first result\nsecond result",
        isError: false,
      }],
    },
  }, 3));

  assert.equal(model.entries.length, 1);
  assert.deepEqual(model.entries[0], {
    id: "tool:call_1",
    kind: "tool",
    callId: "call_1",
    title: "search",
    summary: "needle in src",
    text: "first result\nsecond result",
    toolData: {
      input: { query: "needle", path: "src" },
      result: { content: "first result\nsecond result", isError: false },
    },
    status: "completed",
    expanded: true,
  });
});

test("mutation tool cards preserve bounded input through completion and hide successful result boilerplate", () => {
  const model = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxToolPreviewBytes: 96 });
  const requested = envelope({
    type: "tool_requested",
    callId: "call_write",
    name: "write",
    input: { path: "src/new.ts", content: "const first = 1;\n\u001b[31mconst second = 2;\u001b[0m\n" },
    index: 0,
  }, 1);
  model.apply(requested);
  assert.deepEqual(model.entries[0], {
    id: "tool:call_write",
    kind: "tool",
    callId: "call_write",
    title: "write",
    summary: "src/new.ts",
    inputPreview: "+ const first = 1;\n+ const second = 2;\n+ ",
    toolData: { input: { path: "src/new.ts", content: "const first = 1;\nconst second = 2;\n" } },
    text: "",
    status: "pending",
    expanded: false,
  });

  const completed = envelope({
    type: "tool_completed",
    callId: "call_write",
    name: "write",
    index: 0,
    isError: false,
    preview: `Updated src/new.ts (42 bytes, sha256 ${"a".repeat(64)})`,
  }, 2);
  model.apply(completed);
  assert.equal(model.entries[0]?.status, "completed");
  assert.equal(model.entries[0]?.text, "");
  assert.equal(model.entries[0]?.expanded, true);
  assert.match(model.entries[0]?.toolData?.result?.content ?? "", /sha256/u);
  assert.match(completed.event.type === "tool_completed" ? completed.event.preview : "", /sha256/u);

  model.apply(envelope({
    type: "message_appended",
    message: {
      id: "message_tool_write",
      role: "tool",
      createdAt: "2026-01-01T00:00:00.000Z",
      content: [{
        type: "tool_result",
        callId: "call_write",
        name: "write",
        content: `Updated src/new.ts (42 bytes, sha256 ${"a".repeat(64)})`,
        isError: false,
      }],
    },
  }, 3));
  assert.equal(model.entries[0]?.text, "");
});

test("mutation previews show edit and patch structure while retaining failed results", () => {
  const model = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxToolPreviewBytes: 256 });
  model.apply(envelope({
    type: "tool_requested",
    callId: "call_edit",
    name: "edit",
    input: { path: "src/a.ts", oldText: "old one\nold two", newText: "new one\nnew two" },
    index: 0,
  }, 1));
  model.apply(envelope({
    type: "tool_completed",
    callId: "call_edit",
    name: "edit",
    index: 0,
    isError: true,
    preview: "\u001b[31mEdit precondition failed: file content changed\u001b[0m",
  }, 2));
  assert.equal(model.entries[0]?.inputPreview, "--- old\n- old one\n- old two\n+++ new\n+ new one\n+ new two");
  assert.equal(model.entries[0]?.text, "Edit precondition failed: file content changed");
  assert.equal(model.entries[0]?.status, "failed");

  model.apply(envelope({
    type: "tool_requested",
    callId: "call_patch",
    name: "apply_patch",
    input: { patch: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch" },
    index: 1,
  }, 3));
  assert.equal(
    model.entries[1]?.inputPreview,
    "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch",
  );
});

test("normalized multi-edit calls render bounded diffs and prefer the completed authoritative patch", () => {
  const maximum = 180;
  const model = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxToolPreviewBytes: maximum });
  model.apply(envelope({
    type: "tool_requested",
    callId: "call_multi_edit",
    name: "edit",
    input: {
      path: "src/a.ts",
      edits: [
        { oldText: "first old", newText: "first new" },
        { oldText: "\u001b[31msecond old\u001b[0m", newText: "second new" },
        { oldText: 42, newText: "ignored malformed entry" },
      ],
    },
    index: 0,
  }, 1));

  const requested = model.entries[0]?.inputPreview ?? "";
  assert.match(requested, /- first old[\s\S]*\+ first new[\s\S]*- second old[\s\S]*\+ second new/u);
  assert.doesNotMatch(requested, /ignored malformed entry|\u001b/u);
  assert.ok(Buffer.byteLength(requested, "utf8") <= maximum);

  const authoritative = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-first old\n+first final";
  model.apply(envelope({
    type: "tool_completed",
    callId: "call_multi_edit",
    name: "edit",
    index: 0,
    isError: false,
    preview: "Successfully replaced 2 blocks",
    result: {
      type: "tool_result",
      callId: "call_multi_edit",
      name: "edit",
      content: "Successfully replaced 2 blocks",
      isError: false,
      metadata: { replacements: 2, diff: "   ", patch: authoritative },
    },
  }, 2));

  assert.equal(model.entries[0]?.inputPreview, authoritative);
  assert.equal(model.entries[0]?.text, "");
});

test("normalized multi-edit previews disclose edits omitted by the structural cap", () => {
  const model = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxToolPreviewBytes: 16 * 1_024 });
  model.apply(envelope({
    type: "tool_requested",
    callId: "call_many_edits",
    name: "edit",
    input: {
      path: "src/a.ts",
      edits: Array.from({ length: 33 }, (_, index) => ({
        oldText: `old ${index + 1}`,
        newText: `new ${index + 1}`,
      })),
    },
    index: 0,
  }, 1));

  const preview = model.entries[0]?.inputPreview ?? "";
  assert.match(preview, /old 32[\s\S]*new 32/u);
  assert.doesNotMatch(preview, /old 33|new 33/u);
  assert.match(preview, /… 1 additional edit not shown/u);
});

test("tool input and result previews strip ANSI and stay inside their byte budget", () => {
  const maximum = 48;
  const model = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxToolPreviewBytes: maximum });
  model.apply(envelope({
    type: "tool_requested",
    callId: "call_write",
    name: "write",
    input: { path: "long.ts", content: `\u001b[2J${"🙂 value\t".repeat(30)}` },
    index: 0,
  }, 1));
  const inputPreview = model.entries[0]?.inputPreview ?? "";
  assert.ok(Buffer.byteLength(inputPreview, "utf8") <= maximum);
  assert.doesNotMatch(inputPreview, /\u001b/u);
  assert.match(inputPreview, /truncated/u);

  model.apply(envelope({
    type: "tool_requested",
    callId: "call_shell",
    name: "shell",
    input: { command: "printf output" },
    index: 1,
  }, 2));
  model.apply(envelope({
    type: "tool_completed",
    callId: "call_shell",
    name: "shell",
    index: 1,
    isError: false,
    preview: `\u001b[31m${"output\t".repeat(30)}\u001b[0m`,
  }, 3));
  const resultPreview = model.entries[1]?.text ?? "";
  assert.ok(Buffer.byteLength(resultPreview, "utf8") <= maximum);
  assert.doesNotMatch(resultPreview, /\u001b/u);
  assert.match(resultPreview, /truncated/u);
});

test("tool renderer data is JSON-safe, sanitized, bounded, and counted in transcript limits", () => {
  const model = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxTranscriptBytes: 145, maxToolPreviewBytes: 80 });
  model.apply(envelope({ type: "warning", code: "old", message: "old viewport row" }, 1));
  model.apply(envelope({
    type: "tool_requested",
    callId: "call_data",
    name: "probe",
    input: { label: "safe\u001b]2;owned\u0007", nested: { value: 3 } },
    index: 0,
  }, 2));
  model.apply(envelope({
    type: "tool_completed",
    callId: "call_data",
    name: "probe",
    index: 0,
    isError: false,
    preview: "done",
    result: {
      type: "tool_result",
      callId: "call_data",
      name: "probe",
      content: "done\u001b[31m!\u001b[0m",
      isError: false,
      metadata: { note: "meta\u001b[2J" },
    },
  }, 3));
  assert.deepEqual(model.entries.at(-1)?.toolData, {
    input: { label: "safe", nested: { value: 3 } },
    result: { content: "done!", isError: false, metadata: { note: "meta" } },
  });
  assert.deepEqual(model.entries.map((entry) => entry.id), ["tool:call_data"]);

  const oversized = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxToolPreviewBytes: 16 });
  oversized.apply(envelope({
    type: "tool_requested",
    callId: "large",
    name: "probe",
    input: { payload: "x".repeat(100) },
    index: 0,
  }, 1));
  assert.equal(oversized.entries[0]?.toolData, undefined);
});

test("extension session entries retain only safe transcript metadata in the TUI model", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({
    type: "extension_state",
    extensionId: "owner.extension",
    schemaVersion: 2,
    key: "private_state",
    value: { secret: "must not enter the transcript model" },
  }, 1));
  model.apply(envelope({
    type: "extension_message",
    extensionId: "owner.extension",
    schemaVersion: 2,
    kind: "hidden",
    messageId: "hidden-message",
    payload: { secret: "hidden payload" },
    modelContext: false,
    transcript: false,
  }, 2));
  model.apply(envelope({
    type: "extension_message",
    extensionId: "owner.extension",
    schemaVersion: 2,
    kind: "visible",
    messageId: "visible-message",
    payload: { secret: "renderer-only payload" },
    modelContext: false,
    transcript: { text: "visible\u001b[2J fallback" },
  }, 3));

  assert.deepEqual(model.entries, [
    {
      id: "evt_1",
      kind: "status",
      text: "",
      extension: { type: "state", extensionId: "owner.extension", schemaVersion: 2, key: "private_state" },
    },
    {
      id: "evt_3",
      kind: "status",
      text: "visible fallback",
      extension: { type: "message", extensionId: "owner.extension", schemaVersion: 2, key: "visible" },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(model.entries), /must not enter|hidden payload|renderer-only payload/u);
});

test("successful non-mutation tools retain their bounded output cards", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  for (const [index, name] of ["shell", "read", "search", "list", "web_fetch"].entries()) {
    const callId = `call_${name}`;
    model.apply(envelope({ type: "tool_requested", callId, name, input: {}, index }, index * 2 + 1));
    model.apply(envelope({
      type: "tool_completed",
      callId,
      name,
      index,
      isError: false,
      preview: `${name} output sha256 remains visible`,
    }, index * 2 + 2));
  }
  assert.deepEqual(
    model.entries.map((entry) => entry.text),
    ["shell", "read", "search", "list", "web_fetch"].map((name) => `${name} output sha256 remains visible`),
  );
});

test("mutation input previews participate in the transcript byte limit", () => {
  const model = new TuiModel({
    ...DEFAULT_TUI_LIMITS,
    maxTranscriptBytes: 80,
    maxToolPreviewBytes: 60,
  });
  model.apply(envelope({ type: "warning", code: "old", message: "1234567890" }, 1));
  model.apply(envelope({
    type: "tool_requested",
    callId: "call_write",
    name: "write",
    input: { path: "a.ts", content: "x".repeat(200) },
    index: 0,
  }, 2));
  assert.deepEqual(model.entries.map((entry) => entry.id), ["tool:call_write"]);
  const entry = model.entries[0]!;
  assert.ok(Buffer.byteLength(`${entry.title ?? ""}${entry.summary ?? ""}${entry.inputPreview ?? ""}${entry.text}`, "utf8") <= 80);
});

test("TUI renders the submitted command instead of an expanded prompt payload", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({
    type: "message_appended",
    message: {
      id: "expanded-user",
      role: "user",
      content: [{ type: "text", text: "<skill>large internal instructions</skill>" }],
      displayText: "/skill:review check this",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 1));
  assert.equal(model.entries[0]?.text, "/skill:review check this");
});

test("persisted user shell messages project into bounded shell cards without mutating canonical history", () => {
  const model = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxToolPreviewBytes: 80 });
  const message = {
    id: "user-shell-message",
    role: "user" as const,
    content: [{
      type: "text" as const,
      text: `[User shell command]\n$ npm test\n${"old output\n".repeat(20)}LATEST FAILURE\n[31mstderr detail[0m\n… output truncated\nexit 7`,
    }],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const original = structuredClone(message);

  model.apply(envelope({ type: "message_appended", message }, 1));

  assert.deepEqual(message, original);
  assert.equal(model.entries.length, 1);
  const projected = model.entries[0]!;
  assert.equal(projected.id, message.id);
  assert.equal(projected.kind, "tool");
  assert.equal(projected.callId, `user-shell:${message.id}`);
  assert.equal(projected.title, "shell");
  assert.equal(projected.summary, "npm test");
  assert.equal(projected.status, "failed");
  assert.equal(projected.expanded, true);
  assert.match(projected.text, /LATEST FAILURE/u);
  assert.match(projected.text, /stderr detail/u);
  assert.match(projected.text, /earlier output truncated/u);
  assert.doesNotMatch(projected.text, /\u001b|\[User shell command\]|\$ npm test/u);
  assert.ok(Buffer.byteLength(projected.text, "utf8") <= 80);
  assert.deepEqual(projected.toolData?.input, { command: "npm test" });
  assert.equal(projected.toolData?.result?.isError, true);
  assert.deepEqual(projected.toolData?.result?.metadata, { exitCode: 7, truncated: true });
  assert.equal(model.toggleTool(projected.callId), true);
  assert.equal(projected.expanded, false);

  model.apply(envelope({
    type: "message_appended",
    message: {
      id: "ordinary-marker",
      role: "user",
      content: [{ type: "text", text: "[User shell command]\nnot a harness shell record" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 2));
  assert.equal(model.entries.at(-1)?.kind, "user");
});

test("TUI model correlates user and tool-result images without copying payloads into text or tool JSON", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  const privatePayload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
  model.apply(envelope({
    type: "message_appended",
    message: {
      id: "user-image",
      role: "user",
      content: [
        { type: "text", text: "inspect" },
        { type: "image", mediaType: "image/png", data: privatePayload },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 1));
  assert.equal(model.entries[0]?.text, "inspect");
  assert.equal(model.entries[0]?.images?.[0]?.key, "user-image:image:0");
  assert.doesNotMatch(model.entries[0]?.text ?? "", new RegExp(privatePayload, "u"));

  model.apply(envelope({
    type: "tool_completed",
    callId: "read-image",
    name: "read",
    index: 0,
    isError: false,
    preview: "image read",
    result: {
      type: "tool_result",
      callId: "read-image",
      name: "read",
      content: "image read",
      isError: false,
      images: [{ type: "image", mediaType: "image/png", data: privatePayload }],
    },
  }, 2));
  const tool = model.entries.find((entry) => entry.callId === "read-image");
  assert.equal(tool?.images?.[0]?.key, "tool:read-image:image:0");
  assert.doesNotMatch(JSON.stringify(tool?.toolData), new RegExp(privatePayload, "u"));
});

test("tool expansion toggles all rows together unless a call is selected", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  for (const [sequence, callId] of [[1, "call_1"], [2, "call_2"]] as const) {
    model.apply(envelope({ type: "tool_requested", callId, name: "read", input: { path: callId }, index: sequence }, sequence));
    model.apply(envelope({ type: "tool_completed", callId, name: "read", index: sequence, isError: false, preview: `${callId}\nresult` }, sequence + 10));
  }
  assert.deepEqual(model.entries.map((entry) => entry.expanded), [true, true]);
  assert.equal(model.toggleTool(), true);
  assert.deepEqual(model.entries.map((entry) => entry.expanded), [false, false]);
  assert.equal(model.toggleTool(), true);
  assert.deepEqual(model.entries.map((entry) => entry.expanded), [true, true]);
  assert.equal(model.toggleTool("call_2"), true);
  assert.deepEqual(model.entries.map((entry) => entry.expanded), [true, false]);
});

test("startup help stays outside session history and expands with tool output", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.setStartup("compact help", "expanded help");
  model.apply(envelope({
    type: "message_appended",
    message: { id: "user-startup", role: "user", content: [{ type: "text", text: "hello" }], createdAt: "2026-01-01T00:00:00.000Z" },
  }, 1));

  assert.deepEqual(model.entries.map((entry) => [entry.kind, entry.expanded]), [
    ["startup", false],
    ["user", undefined],
  ]);
  assert.deepEqual(model.committableEntries().map((entry) => entry.id), ["startup", "user-startup"]);
  assert.equal(model.toggleTool(), true);
  assert.equal(model.entries[0]?.expanded, true);

  model.clearTranscript();
  assert.deepEqual(model.entries.map((entry) => entry.kind), ["startup"]);
});

test("only canonical completed rows become committable and multi-step text stays distinct", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({
    type: "message_appended",
    message: { id: "user_1", role: "user", content: [{ type: "text", text: "start" }], createdAt: "2026-01-01T00:00:00.000Z" },
  }, 1));
  model.apply(envelope({ type: "assistant_started", step: 1 }, 2));
  model.apply(envelope({ type: "text_delta", text: "first answer", part: 0 }, 3));
  assert.deepEqual(model.committableEntries().map((entry) => entry.id), ["user_1"]);
  model.apply(envelope({
    type: "message_appended",
    message: { id: "assistant_1", role: "assistant", content: [{ type: "text", text: "first answer" }], createdAt: "2026-01-01T00:00:00.000Z" },
  }, 4));
  model.apply(envelope({ type: "assistant_completed", finishReason: "tool_calls" }, 5));
  assert.equal(model.notice, undefined);
  model.apply(envelope({ type: "tool_requested", callId: "call_1", name: "read", input: { path: "README.md" }, index: 0 }, 6));
  model.apply(envelope({ type: "tool_completed", callId: "call_1", name: "read", index: 0, isError: false, preview: "preview" }, 7));
  assert.equal(model.committableEntries().at(-1)?.text, "first answer");
  model.apply(envelope({
    type: "message_appended",
    message: {
      id: "tool_1",
      role: "tool",
      content: [{ type: "tool_result", callId: "call_1", name: "read", content: "canonical result", isError: false }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 8));
  model.apply(envelope({ type: "assistant_started", step: 2 }, 9));
  model.apply(envelope({ type: "text_delta", text: "second ", part: 0 }, 10));
  model.apply(envelope({ type: "text_delta", text: "answer", part: 1 }, 11));
  model.apply(envelope({
    type: "message_appended",
    message: { id: "assistant_2", role: "assistant", content: [{ type: "text", text: "second answer" }], createdAt: "2026-01-01T00:00:00.000Z" },
  }, 12));
  model.apply(envelope({ type: "assistant_completed", finishReason: "stop" }, 13));
  model.apply(envelope({ type: "run_completed", finishReason: "stop" }, 14));
  assert.equal(model.notice, undefined);
  assert.deepEqual(
    model.entries.filter((entry) => entry.kind === "assistant").map((entry) => entry.text),
    ["first answer", "second answer"],
  );
  assert.equal(model.entries.filter((entry) => entry.kind === "tool").length, 1);
  assert.equal(model.committableEntries().length, model.entries.length);
});

test("TUI model drops old viewport data when its byte budget is exceeded", () => {
  const model = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxTranscriptBytes: 20, maxTranscriptEntries: 2 });
  model.apply(envelope({ type: "warning", code: "one", message: "1234567890" }, 1));
  model.apply(envelope({ type: "warning", code: "two", message: "abcdefghij" }, 2));
  model.apply(envelope({ type: "warning", code: "three", message: "klmnopqrst" }, 3));
  assert.ok(model.entries.length <= 2);
  assert.match(model.notice ?? "", /discarded/u);
});

test("TUI model releases durable assistant IDs when bounded rows are discarded", () => {
  const model = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxTranscriptEntries: 1 });
  const committed = envelope({
    type: "message_appended",
    message: {
      id: "assistant-durable",
      role: "assistant",
      content: [{ type: "text", text: "durable answer" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 3);

  model.apply(envelope({ type: "assistant_started", step: 1 }, 1));
  model.apply(envelope({ type: "text_delta", text: "streaming answer", part: 0 }, 2));
  model.apply(committed);
  model.apply(envelope({ type: "assistant_completed", finishReason: "stop" }, 4));
  assert.equal(model.entries[0]?.id, "assistant-durable");
  assert.equal(model.entries[0]?.text, "durable answer");

  model.apply(envelope({ type: "warning", code: "replacement", message: "newer row" }, 5));
  assert.deepEqual(model.entries.map((entry) => entry.id), ["evt_5"]);

  model.apply(committed);
  assert.deepEqual(model.entries.map((entry) => entry.id), ["assistant-durable"]);
});

test("TUI usage exposes provider cache reads and writes", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.setContext({ contextWindowTokens: 20_000 });
  model.apply(envelope({
    type: "usage",
    semantics: "final",
    usage: { inputTokens: 10_000, outputTokens: 200, cacheReadTokens: 8_000, cacheWriteTokens: 1_000 },
  }, 1));
  assert.deepEqual(model.usage?.total, {
    inputTokens: 10_000,
    outputTokens: 200,
    cacheReadTokens: 8_000,
    cacheWriteTokens: 1_000,
  });
  assert.ok(Math.abs((model.usage?.latestCacheHitRate ?? 0) - 42.10526315789473) < 0.000001);
  assert.equal(model.context.contextTokens, 19_000);
});

test("TUI usage aggregates runs without double-counting cumulative updates", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply({ ...envelope({ type: "usage", semantics: "cumulative", usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, cost: "0.01" } }, 1), runId: "run_one" });
  model.apply({ ...envelope({ type: "usage", semantics: "final", usage: { inputTokens: 120, outputTokens: 20, cacheReadTokens: 90, cost: "0.02" } }, 2), runId: "run_one" });
  model.apply({ ...envelope({ type: "usage", semantics: "incremental", usage: { inputTokens: 30, outputTokens: 5, cacheWriteTokens: 10, cost: "0.005" } }, 3), runId: "run_two" });
  model.apply({ ...envelope({ type: "usage", semantics: "incremental", usage: { inputTokens: 20, outputTokens: 5, cost: "0.005" } }, 4), runId: "run_two" });
  assert.deepEqual(model.usage, {
    total: { inputTokens: 170, outputTokens: 30, cacheReadTokens: 90, cacheWriteTokens: 10, cost: "0.03" },
    latestCacheHitRate: 0,
  });
});

test("same-model run startup preserves the last authoritative context pressure until new usage arrives", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.setContext({ provider: "openai", model: "gpt-test", contextWindowTokens: 20_000 });
  model.apply(envelope({
    type: "usage",
    semantics: "final",
    usage: { inputTokens: 10_000, cacheReadTokens: 8_000, cacheWriteTokens: 1_000 },
  }, 1));
  assert.equal(model.context.contextTokens, 19_000);

  model.apply(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 2));
  assert.equal(model.context.contextTokens, 19_000);

  model.apply(envelope({ type: "run_started", provider: "anthropic", model: "claude-test" }, 3));
  assert.equal(model.context.contextTokens, 0);
});

test("TUI model can explicitly clear a stale provider and model selection", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.setContext({ provider: "openai", model: "gpt-test", thinkingSupported: true, workspace: "/tmp/work" });
  model.clearModelContext();
  assert.deepEqual(model.context, { active: false, status: "idle", workspace: "/tmp/work" });
});

test("TUI marks an interrupted tool with an unknown outcome as in doubt", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({ type: "tool_requested", callId: "call_1", name: "write", input: {}, index: 0 }, 1));
  model.apply(envelope({ type: "tool_started", callId: "call_1", name: "write", index: 0 }, 2));
  model.apply(envelope({
    type: "tool_in_doubt",
    callId: "call_1",
    name: "write",
    index: 0,
    reason: "The process stopped before completion was recorded.",
  }, 3));
  assert.equal(model.entries[0]?.status, "in_doubt");
  assert.match(model.entries[0]?.text ?? "", /before completion/u);
  assert.equal(model.entries[0]?.expanded, true);
});

test("reasoning summaries default collapsed and toggle together", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({ type: "reasoning_delta", text: "first reasoning summary", part: 0, visibility: "summary" }, 1));
  model.apply(envelope({ type: "reasoning_delta", text: "second reasoning summary", part: 1, visibility: "summary" }, 2));
  assert.deepEqual(model.entries.map((entry) => entry.expanded), [false, false]);
  assert.equal(model.toggleReasoning(), true);
  assert.deepEqual(model.entries.map((entry) => entry.expanded), [true, true]);
});

test("TUI renders a durable branch summary as a bounded status card", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({
    type: "branch_summary_created",
    sourceBranch: "main",
    sourceEventIds: ["event-source"],
    summary: {
      id: "message-summary",
      role: "user",
      purpose: "compaction",
      createdAt: "2026-07-10T00:00:00.000Z",
      content: [{ type: "text", text: "[Abandoned branch summary]\nKeep the exact decision." }],
    },
  }, 1));
  assert.deepEqual(model.entries, [{
    id: "evt_1",
    kind: "status",
    title: "Branch summary",
    text: "[Abandoned branch summary]\nKeep the exact decision.",
  }]);
});

test("TUI activity follows preparation, retry, compaction, and completion", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  assert.equal(model.context.activity?.phase, "Preparing request");
  assert.equal(model.context.activity?.cancellable, true);

  model.apply(envelope({ type: "retry_scheduled", attempt: 2, delayMs: 5_000, category: "rate_limit" }, 2));
  assert.equal(model.context.activity?.phase, "Retrying rate_limit");
  assert.equal(model.context.activity?.attempt, 2);
  assert.ok((model.context.activity?.retryAt ?? 0) > Date.now());

  model.apply(envelope({ type: "compaction_started" }, 3));
  assert.equal(model.context.activity?.phase, "Compacting context");

  model.apply(envelope({ type: "run_completed", finishReason: "stop" }, 4));
  assert.equal(model.context.activity, undefined);
});
