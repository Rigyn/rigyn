import assert from "node:assert/strict";
import test from "node:test";
import type { EventEnvelope } from "../../src/core/events.js";
import type { NormalizedUsage } from "../../src/core/types.js";
import {
  formatCompactionUsageReceipt,
  MAX_RETAINED_MUTATION_PREVIEW_ROWS,
  TuiModel,
} from "../../src/tui/model.js";
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
    envelope({ type: "tool_started", callId: "call-rich", name: "read", input: {}, index: 0, recoveryMode: "repeatable" }, 9),
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
      type: "usage",
      semantics: "final",
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 80,
        cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
      },
    }, 13),
    envelope({ type: "warning", code: "fixture", message: "Retained warning" }, 14),
    envelope({ type: "run_completed", finishReason: "stop" }, 15),
  ];
}

function cacheRun(
  model: TuiModel,
  options: {
    id: string;
    sequence: number;
    usage?: NormalizedUsage;
    provider?: string;
    model?: string;
    responseModel?: string;
    api?: "openai-responses" | "anthropic-messages";
    instructionFingerprint?: string;
    toolFingerprint?: string;
  },
): void {
  const provider = options.provider ?? "anthropic";
  const selectedModel = options.model ?? "claude-test";
  const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, options.sequence)).toISOString();
  let sequence = options.sequence;
  const apply = (event: Parameters<TuiModel["apply"]>[0]["event"]): void => {
    model.apply({ ...envelope(event, sequence), runId: options.id });
    sequence += 1;
  };
  apply({
    type: "run_started",
    provider,
    model: selectedModel,
    ...(options.instructionFingerprint === undefined
      ? {}
      : {
          promptComposition: {
            bytes: 1,
            sha256: options.instructionFingerprint,
            sources: [],
            tools: [],
            skills: [],
            truncated: false,
          },
        }),
  });
  apply({ type: "assistant_started", step: 1 });
  if (options.responseModel !== undefined) {
    apply({ type: "provider_response_started", step: 1, model: options.responseModel });
  }
  if (options.usage !== undefined) apply({ type: "usage", semantics: "final", usage: options.usage });
  apply({
    type: "message_appended",
    message: {
      id: `assistant-${options.id}`,
      role: "assistant",
      content: [{ type: "text", text: options.id }],
      createdAt,
      provider,
      model: selectedModel,
      ...(options.api === undefined ? {} : { api: options.api }),
      ...(options.responseModel === undefined ? {} : { responseModel: options.responseModel }),
      ...(options.usage === undefined ? {} : { usage: options.usage }),
    },
    ...(options.toolFingerprint === undefined
      ? {}
      : { toolDefinitionFingerprint: options.toolFingerprint }),
  });
  apply({ type: "assistant_completed", finishReason: "stop" });
  apply({ type: "run_completed", finishReason: "stop" });
}

test("TUI model folds streaming and tool events into bounded transcript entries", () => {
  const model = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxTranscriptBytes: 200, maxToolPreviewBytes: 40 });
  model.apply(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  model.apply(envelope({ type: "text_delta", text: "hello\u001b[2J ", part: 0 }, 2));
  model.apply(envelope({ type: "text_delta", text: "world", part: 0 }, 3));
  model.apply(envelope({ type: "tool_requested", callId: "call_1", name: "read", input: { path: "src/a.ts" }, index: 0 }, 4));
  model.apply(envelope({ type: "tool_started", callId: "call_1", name: "read", input: {}, index: 0, recoveryMode: "repeatable" }, 5));
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
      argsComplete: true,
      executionStarted: true,
      input: { path: "src/a.ts" },
      result: { content: "line 1\nline 2", isError: false },
    },
    status: "completed",
    expanded: false,
  });
  assert.equal(model.toggleTool("call_1"), true);
  assert.equal(model.entries[1]?.expanded, true);
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
      envelope({ type: "tool_started", callId, name: "read", input: {}, index: 0, recoveryMode: "repeatable" }, sequence += 1),
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
  model.apply(envelope({ type: "tool_started", callId: "call_live", name: "shell", input: {}, index: 0, recoveryMode: "never_repeat" }, 2));
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
  assert.ok(Buffer.byteLength(progress?.output ?? "", "utf8") <= 24);
  assert.match(progress?.output ?? "", /deliberately long/u);

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
  assert.equal(model.entries[0]?.expanded, false);
});

test("TUI model ignores duplicate and stale progress sequences for one tool call", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({
    type: "tool_requested",
    callId: "sequenced-progress",
    name: "bash",
    input: { command: "build" },
    index: 0,
  }, 1));
  model.apply(envelope({
    type: "tool_started",
    callId: "sequenced-progress",
    name: "bash",
    input: { command: "build" },
    index: 0,
    recoveryMode: "never_repeat",
  }, 2));
  for (const [eventSequence, progressSequence, delta, stdoutBytes] of [
    [3, 1, "new", 3],
    [4, 1, "duplicate", 30],
    [5, 0, "stale", 50],
    [6, 2, "er", 2],
  ] as const) {
    model.apply(envelope({
      type: "tool_progress",
      callId: "sequenced-progress",
      name: "bash",
      index: 0,
      sequence: progressSequence,
      progress: { type: "output", stream: "stdout", delta, stdoutBytes, stderrBytes: 0 },
    }, eventSequence));
  }

  assert.equal(model.entries[0]?.toolData?.progress?.stdout, "newer");
  assert.equal(model.entries[0]?.toolData?.progress?.output, "newer");
  assert.equal(model.entries[0]?.toolData?.progress?.stdoutBytes, 3);
  model.apply(envelope({
    type: "tool_completed",
    callId: "sequenced-progress",
    name: "bash",
    index: 0,
    isError: false,
    preview: "complete",
  }, 7));
  model.apply(envelope({
    type: "tool_progress",
    callId: "sequenced-progress",
    name: "bash",
    index: 0,
    sequence: 3,
    progress: { type: "output", stream: "stdout", delta: "late", stdoutBytes: 7, stderrBytes: 0 },
  }, 8));
  assert.equal(model.entries[0]?.status, "completed");
  assert.equal(model.entries[0]?.text, "complete");
  assert.equal(model.entries[0]?.toolData?.progress, undefined);
});

test("TUI model preserves stdout and stderr in arrival order for live shell display", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({
    type: "tool_requested",
    callId: "merged-progress",
    name: "bash",
    input: { command: "build" },
    index: 0,
  }, 1));
  model.apply(envelope({
    type: "tool_started",
    callId: "merged-progress",
    name: "bash",
    input: { command: "build" },
    index: 0,
    recoveryMode: "never_repeat",
  }, 2));
  for (const [eventSequence, stream, delta, stdoutBytes, stderrBytes] of [
    [3, "stdout", "compile\n", 8, 0],
    [4, "stderr", "warning\n", 8, 8],
    [5, "stdout", "done\n", 13, 8],
  ] as const) {
    model.apply(envelope({
      type: "tool_progress",
      callId: "merged-progress",
      name: "bash",
      index: 0,
      sequence: eventSequence,
      progress: { type: "output", stream, delta, stdoutBytes, stderrBytes },
    }, eventSequence));
  }

  assert.equal(model.entries[0]?.toolData?.progress?.output, "compile\nwarning\ndone\n");
});

test("interleaved parallel tool progress keeps stable cards through out-of-order completion", () => {
  const model = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxToolPreviewBytes: 96 });
  model.apply(envelope({
    type: "tool_requested",
    callId: "first",
    name: "shell",
    input: { command: "first command" },
    index: 0,
  }, 1));
  model.apply(envelope({
    type: "tool_requested",
    callId: "second",
    name: "shell",
    input: { command: "second command" },
    index: 1,
  }, 2));
  model.apply(envelope({ type: "tool_started", callId: "first", name: "shell", input: {}, index: 0, recoveryMode: "never_repeat" }, 3));
  model.apply(envelope({ type: "tool_started", callId: "second", name: "shell", input: {}, index: 1, recoveryMode: "never_repeat" }, 4));
  model.apply(envelope({
    type: "tool_progress",
    callId: "first",
    name: "shell",
    index: 0,
    sequence: 0,
    progress: { type: "output", stream: "stdout", delta: "first live", stdoutBytes: 10, stderrBytes: 0 },
  }, 5));
  model.apply(envelope({
    type: "tool_progress",
    callId: "second",
    name: "shell",
    index: 1,
    sequence: 0,
    progress: { type: "output", stream: "stderr", delta: "second live", stdoutBytes: 0, stderrBytes: 11 },
  }, 6));
  model.apply(envelope({
    type: "tool_completed",
    callId: "second",
    name: "shell",
    index: 1,
    isError: false,
    preview: "second final",
  }, 7));

  assert.deepEqual(model.entries.map((entry) => [entry.callId, entry.status]), [
    ["first", "running"],
    ["second", "completed"],
  ]);
  assert.equal(model.entries[0]?.toolData?.progress?.stdout, "first live");
  assert.equal(model.entries[1]?.text, "second final");

  model.apply(envelope({
    type: "tool_completed",
    callId: "first",
    name: "shell",
    index: 0,
    isError: false,
    preview: "first final",
  }, 8));
  assert.deepEqual(model.entries.map((entry) => [entry.callId, entry.status, entry.text]), [
    ["first", "completed", "first final"],
    ["second", "completed", "second final"],
  ]);
  assert.ok(model.entries.every((entry) => entry.toolData?.progress === undefined));
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
  model.apply(envelope({ type: "tool_started", callId: "call_native", name: "delegate", input: {}, index: 0, recoveryMode: "never_repeat" }, 2));
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
  assert.equal(model.entries[0]?.expanded, false);
});

test("terminal runs release progress sequencing state and retain an interruption marker", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  model.apply(envelope({ type: "tool_requested", callId: "reused-call", name: "bash", input: {}, index: 0 }, 2));
  model.apply(envelope({
    type: "tool_progress",
    callId: "reused-call",
    name: "bash",
    index: 0,
    sequence: 9,
    progress: { type: "output", stream: "stdout", delta: "old", stdoutBytes: 3, stderrBytes: 0 },
  }, 3));
  model.apply(envelope({ type: "run_cancelled", reason: "operator stopped the run" }, 4));

  assert.equal(model.entries.some((entry) => entry.callId === "reused-call"), false);
  assert.equal(model.entries.find((entry) => entry.title === "Interrupted")?.text, "operator stopped the run");

  model.apply(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 5));
  model.apply(envelope({ type: "tool_requested", callId: "reused-call", name: "bash", input: {}, index: 0 }, 6));
  model.apply(envelope({
    type: "tool_progress",
    callId: "reused-call",
    name: "bash",
    index: 0,
    sequence: 1,
    progress: { type: "output", stream: "stdout", delta: "fresh", stdoutBytes: 5, stderrBytes: 0 },
  }, 7));

  assert.equal(model.entries.find((entry) => entry.callId === "reused-call")?.toolData?.progress?.output, "fresh");
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
      argsComplete: true,
      executionStarted: true,
      input: { query: "needle", path: "src" },
      result: { content: "first result\nsecond result", isError: false },
    },
    status: "completed",
    expanded: false,
  });
});

test("write tool cards retain bounded sanitized source visibility through completion", () => {
  const maximum = 96;
  const model = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxToolPreviewBytes: maximum });
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
    summary: "src/new.ts · 2 lines · 44 bytes",
    inputPreview: "+ const first = 1;\n+ const second = 2;\n+ ",
    toolData: {
      argsComplete: true,
      executionStarted: false,
      input: { path: "src/new.ts", content: "const first = 1;\nconst second = 2;\n" },
    },
    text: "",
    status: "pending",
    expanded: false,
  });
  const requestedEntry = model.entries[0]!;
  assert.ok(Buffer.byteLength(requestedEntry.summary ?? "", "utf8") <= maximum);
  assert.ok(Buffer.byteLength(requestedEntry.inputPreview ?? "", "utf8") <= maximum);
  assert.ok(Buffer.byteLength(JSON.stringify(requestedEntry.toolData?.input), "utf8") <= maximum);
  assert.doesNotMatch(JSON.stringify(requestedEntry), /\u001b|\[31m|\[0m/u);
  const requestedPreview = requestedEntry.inputPreview;
  const requestedInput = requestedEntry.toolData?.input;

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
  assert.equal(model.entries[0]?.expanded, false);
  assert.equal(model.entries[0]?.inputPreview, requestedPreview);
  assert.deepEqual(model.entries[0]?.toolData?.input, requestedInput);
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
  assert.equal(model.entries[0]?.inputPreview, requestedPreview);
});

test("newline-heavy write summaries count mixed line endings without expanding retained previews", () => {
  const maximum = 128;
  const content = "x\r\ny\rz\n".repeat(100_000);
  const model = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxToolPreviewBytes: maximum });

  model.apply(envelope({
    type: "tool_requested",
    callId: "call_many_lines",
    name: "write",
    input: { path: "src/many-lines.ts", content },
    index: 0,
  }, 1));

  const entry = model.entries[0];
  assert.equal(entry?.summary, "src/many-lines.ts · 300,000 lines · 700,000 bytes");
  assert.ok(Buffer.byteLength(entry?.inputPreview ?? "", "utf8") <= maximum);
  assert.deepEqual(entry?.toolData?.input, { path: "src/many-lines.ts" });
});

test("write previews enforce the retained row bound without dropping exact-boundary input", () => {
  const preview = (rows: number): string => {
    const model = new TuiModel(DEFAULT_TUI_LIMITS);
    model.apply(envelope({
      type: "tool_requested",
      callId: `call_${rows}`,
      name: "write",
      input: { path: "src/rows.ts", content: Array.from({ length: rows }, () => "x").join("\n") },
      index: 0,
    }, 1));
    return model.entries[0]?.inputPreview ?? "";
  };

  const boundary = preview(MAX_RETAINED_MUTATION_PREVIEW_ROWS);
  assert.equal(boundary.split("\n").length, MAX_RETAINED_MUTATION_PREVIEW_ROWS);
  assert.doesNotMatch(boundary, /retained source rows? hidden/u);

  const overflow = preview(MAX_RETAINED_MUTATION_PREVIEW_ROWS + 3_000);
  assert.equal(overflow.split("\n").length, MAX_RETAINED_MUTATION_PREVIEW_ROWS);
  assert.match(overflow, /3,001 retained source rows hidden; ending follows/u);
});

test("edit inputs render bounded source diffs while failures remain visible", () => {
  const maximum = 256;
  const model = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxToolPreviewBytes: maximum });
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
  assert.equal(
    model.entries[0]?.inputPreview,
    "--- old\n- old one\n- old two\n+++ new\n+ new one\n+ new two",
  );
  assert.equal(model.entries[0]?.summary, "src/a.ts · 2 to 2 lines · 15 to 15 bytes");
  assert.deepEqual(model.entries[0]?.toolData?.input, {
    path: "src/a.ts",
    oldText: "old one\nold two",
    newText: "new one\nnew two",
  });
  assert.ok(Buffer.byteLength(model.entries[0]?.inputPreview ?? "", "utf8") <= maximum);
  assert.ok(Buffer.byteLength(JSON.stringify(model.entries[0]?.toolData?.input), "utf8") <= maximum);
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

test("normalized multi-edit calls show bounded diffs and prefer the completed authoritative patch", () => {
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

  const requestedPreview = model.entries[0]?.inputPreview ?? "";
  assert.match(requestedPreview, /- first old[\s\S]*\+ first new[\s\S]*- second old[\s\S]*\+ second new/u);
  assert.doesNotMatch(requestedPreview, /ignored malformed entry|\u001b/u);
  assert.ok(Buffer.byteLength(requestedPreview, "utf8") <= maximum);
  assert.match(model.entries[0]?.summary ?? "", /^src\/a\.ts · 2 edits · 2 to 2 lines · /u);
  assert.deepEqual(model.entries[0]?.toolData?.input, { path: "src/a.ts" });
  assert.ok(Buffer.byteLength(JSON.stringify(model.entries[0]?.toolData?.input), "utf8") <= maximum);

  const authoritative = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-first old\n+first final";
  model.apply(envelope({
    type: "tool_completed",
    callId: "call_multi_edit",
    name: "edit",
    index: 0,
    isError: false,
    preview: "Applied 2 replacements",
    result: {
      type: "tool_result",
      callId: "call_multi_edit",
      name: "edit",
      content: "Applied 2 replacements",
      isError: false,
      metadata: { replacements: 2, diff: "   ", patch: authoritative },
    },
  }, 2));

  assert.equal(model.entries[0]?.inputPreview, authoritative);
  assert.ok(Buffer.byteLength(model.entries[0]?.inputPreview ?? "", "utf8") <= maximum);
  assert.doesNotMatch(model.entries[0]?.inputPreview ?? "", /second new/u);
  assert.equal(model.entries[0]?.text, "");
});

test("normalized multi-edit previews cap visible structure while retaining bounded renderer data", () => {
  const maximum = 16 * 1_024;
  const edits = Array.from({ length: 33 }, (_, index) => ({
    oldText: `old ${index + 1}`,
    newText: `new ${index + 1}`,
  }));
  const model = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxToolPreviewBytes: maximum });
  model.apply(envelope({
    type: "tool_requested",
    callId: "call_many_edits",
    name: "edit",
    input: {
      path: "src/a.ts",
      edits,
    },
    index: 0,
  }, 1));

  const preview = model.entries[0]?.inputPreview ?? "";
  assert.match(preview, /old 32[\s\S]*new 32/u);
  assert.doesNotMatch(preview, /old 33|new 33/u);
  assert.match(preview, /… 1 additional edit not shown/u);
  assert.ok(Buffer.byteLength(preview, "utf8") <= maximum);
  assert.match(model.entries[0]?.summary ?? "", /^src\/a\.ts · 33 edits · 33 to 33 lines · /u);
  assert.deepEqual(model.entries[0]?.toolData?.input, { path: "src/a.ts", edits });
  assert.ok(Buffer.byteLength(JSON.stringify(model.entries[0]?.toolData?.input), "utf8") <= maximum);
});

test("tool input and result previews strip ANSI and stay inside their byte budget", () => {
  const maximum = 48;
  const model = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxToolPreviewBytes: maximum });
  model.apply(envelope({
    type: "tool_requested",
    callId: "call_write",
    name: "write",
    input: { path: "\u001b[31mlong.ts\u001b[0m", content: `\u001b[2J${"🙂 value\t".repeat(30)}` },
    index: 0,
  }, 1));
  const inputPreview = model.entries[0]?.inputPreview ?? "";
  assert.ok(Buffer.byteLength(inputPreview, "utf8") <= maximum);
  assert.doesNotMatch(inputPreview, /\u001b|\t|\ufffd/u);
  assert.match(inputPreview, /^\+ 🙂 valu/u);
  assert.match(inputPreview, /truncated/u);
  assert.ok(Buffer.byteLength(model.entries[0]?.summary ?? "", "utf8") <= maximum);
  assert.doesNotMatch(model.entries[0]?.summary ?? "", /\u001b/u);
  assert.equal(model.entries[0]?.summary, "long.ts · 1 line · 334 bytes");
  assert.deepEqual(model.entries[0]?.toolData?.input, { path: "long.ts" });
  assert.doesNotMatch(JSON.stringify(model.entries[0]?.toolData?.input), /🙂|value/u);

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
  const model = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxTranscriptBytes: 240, maxToolPreviewBytes: 80 });
  model.apply(envelope({ type: "warning", code: "old", message: "old viewport row".repeat(20) }, 1));
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
    argsComplete: true,
    executionStarted: true,
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
  assert.deepEqual(oversized.entries[0]?.toolData, {
    argsComplete: true,
    executionStarted: false,
  });
});

test("direct tool renderer images use one aggregate retained-memory budget", () => {
  const model = new TuiModel({
    ...DEFAULT_TUI_LIMITS,
    maxTranscriptBytes: 1_024,
    maxToolPreviewBytes: 64,
  });
  const appendResult = (callId: string, data: string, sequence: number): void => {
    model.apply(envelope({
      type: "tool_completed",
      callId,
      name: "image-tool",
      index: sequence,
      isError: false,
      preview: "image ready",
      result: {
        type: "tool_result",
        callId,
        name: "image-tool",
        content: "image ready",
        contentBlocks: [
          { type: "text", text: "image ready" },
          { type: "image", mediaType: "image/png", data },
        ],
        isError: false,
      },
    }, sequence));
  };

  appendResult("first-image", "a".repeat(2_048), 1);
  const first = model.entries[0]!;
  assert.equal(model.directToolResultContent(first)?.[1]?.type, "image");

  appendResult("second-image", "b".repeat(2_048), 2);
  const second = model.entries[1]!;
  assert.equal(model.directToolResultContent(first), undefined);
  assert.equal(model.directToolResultContent(second)?.[1]?.type, "image");

  model.clearTranscript();
  assert.equal(model.directToolResultContent(second), undefined);
});

test("direct session entries retain only safe transcript metadata in the TUI model", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.applySessionEntry({
    type: "custom",
    id: "entry-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "private_state",
    data: { secret: "must not enter the transcript model" },
  });
  model.applySessionEntry({
    type: "custom_message",
    id: "entry-2",
    parentId: "entry-1",
    timestamp: "2026-01-01T00:00:01.000Z",
    customType: "hidden",
    content: "hidden fallback",
    details: { secret: "hidden payload" },
    display: false,
  });
  model.applySessionEntry({
    type: "custom_message",
    id: "entry-3",
    parentId: "entry-2",
    timestamp: "2026-01-01T00:00:02.000Z",
    customType: "visible",
    content: "visible\u001b[2J fallback",
    details: { secret: "renderer-only payload" },
    display: true,
  });

  assert.deepEqual(model.entries, [
    {
      id: "entry-1",
      kind: "status",
      text: "",
      expanded: false,
      expandable: true,
      extension: { type: "entry", customType: "private_state" },
    },
    {
      id: "entry-3",
      kind: "status",
      text: "visible fallback",
      expanded: false,
      expandable: true,
      extension: { type: "message", customType: "visible" },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(model.entries), /must not enter|hidden payload|renderer-only payload/u);
});

test("live custom-message envelopes defer to the direct session row and match resume", () => {
  const entry = {
    type: "custom_message" as const,
    id: "entry-custom-live",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "notice",
    content: "one visible row",
    details: { renderer: true },
    display: true,
  };
  const envelopeWithCustomMessage = envelope({
    type: "message_appended",
    message: {
      id: "message-custom-live",
      role: "user",
      content: [{ type: "text", text: "one visible row" }],
      createdAt: entry.timestamp,
      custom: {
        customType: entry.customType,
        display: true,
        details: { renderer: true },
        timestamp: Date.parse(entry.timestamp),
      },
    },
  }, 1);
  const live = new TuiModel(DEFAULT_TUI_LIMITS);
  live.apply(envelopeWithCustomMessage);
  live.applySessionEntry(entry);

  const resumed = new TuiModel(DEFAULT_TUI_LIMITS);
  resumed.applyAll([entry]);

  assert.deepEqual(live.entries, resumed.entries);
  assert.deepEqual(live.entries, [{
    id: entry.id,
    kind: "status",
    text: entry.content,
    expanded: false,
    expandable: true,
    extension: { type: "message", customType: entry.customType },
  }]);
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
    maxTranscriptBytes: 220,
    maxToolPreviewBytes: 60,
  });
  model.apply(envelope({ type: "warning", code: "old", message: "1234567890".repeat(30) }, 1));
  model.apply(envelope({
    type: "tool_requested",
    callId: "call_write",
    name: "write",
    input: { path: "a.ts", content: "x".repeat(200) },
    index: 0,
  }, 2));
  assert.deepEqual(model.entries.map((entry) => entry.id), ["tool:call_write"]);
  assert.equal(model.notice, "Older transcript entries were discarded from the viewport");
  const entry = model.entries[0]!;
  assert.ok(Buffer.byteLength(entry.summary ?? "", "utf8") <= 60);
  assert.ok(Buffer.byteLength(entry.inputPreview ?? "", "utf8") <= 60);
  assert.match(entry.inputPreview ?? "", /^\+ x/u);
  assert.match(entry.inputPreview ?? "", /earlier input hidden; newest input follows/u);
  assert.deepEqual(entry.toolData?.input, { path: "a.ts" });
  assert.doesNotMatch(JSON.stringify(entry.toolData?.input), /x{16}/u);
  const retainedBytes = Buffer.byteLength(
    `${entry.sourceMessageId ?? ""}${entry.title ?? ""}${entry.summary ?? ""}${entry.compactText ?? ""}${entry.inputPreview ?? ""}${entry.text}${JSON.stringify(entry.toolData)}`,
    "utf8",
  );
  assert.ok(retainedBytes <= 220);
});

test("TUI projects stored skill invocations into a collapsible card and a separate user request", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({
    type: "message_appended",
    message: {
      id: "expanded-user",
      role: "user",
      content: [{
        type: "text",
        text: [
          '<skill name="review" location="/tmp/review/SKILL.md">',
          "Inspect the implementation.",
          "</skill>",
          "",
          "check this",
        ].join("\n"),
      }],
      displayText: "/skill:review check this",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 1));
  assert.deepEqual(model.entries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    summary: entry.summary,
    text: entry.text,
    expanded: entry.expanded,
    expandable: entry.expandable,
    card: entry.card,
  })), [
    {
      id: "expanded-user:skill",
      kind: "status",
      title: "Skill",
      summary: "review",
      text: "Inspect the implementation.",
      expanded: false,
      expandable: true,
      card: "skill",
    },
    {
      id: "expanded-user",
      kind: "user",
      title: undefined,
      summary: undefined,
      text: "check this",
      expanded: undefined,
      expandable: undefined,
      card: undefined,
    },
  ]);

  assert.equal(model.toggleTool(), true);
  assert.equal(model.entries[0]?.expanded, true);
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
  assert.equal(projected.expanded, false);
  assert.match(projected.text, /LATEST FAILURE/u);
  assert.match(projected.text, /stderr detail/u);
  assert.match(projected.text, /earlier output truncated/u);
  assert.doesNotMatch(projected.text, /\u001b|\[User shell command\]|\$ npm test/u);
  assert.ok(Buffer.byteLength(projected.text, "utf8") <= 80);
  assert.deepEqual(projected.toolData?.input, { command: "npm test" });
  assert.equal(projected.toolData?.result?.isError, true);
  assert.deepEqual(projected.toolData?.result?.metadata, { exitCode: 7, truncated: true });
  assert.equal(model.toggleTool(projected.callId), true);
  assert.equal(projected.expanded, true);

  model.apply(envelope({
    type: "message_appended",
    message: {
      id: "ordinary-marker",
      role: "user",
      content: [{ type: "text", text: "[User shell command]\nnot a harness shell record" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 3));
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
  assert.deepEqual(tool?.toolData?.result?.contentBlocks, [
    { type: "text", text: "image read" },
    { type: "image", mediaType: "image/png", index: 1 },
  ]);
  assert.doesNotMatch(JSON.stringify(tool?.toolData), new RegExp(privatePayload, "u"));
});

test("tool expansion toggles all rows together unless a call is selected", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  for (const [sequence, callId] of [[1, "call_1"], [2, "call_2"]] as const) {
    model.apply(envelope({ type: "tool_requested", callId, name: "read", input: { path: callId }, index: sequence }, sequence));
    model.apply(envelope({ type: "tool_completed", callId, name: "read", index: sequence, isError: false, preview: `${callId}\nresult` }, sequence + 10));
  }
  assert.deepEqual(model.entries.map((entry) => entry.expanded), [false, false]);
  assert.equal(model.toggleTool(), true);
  assert.deepEqual(model.entries.map((entry) => entry.expanded), [true, true]);
  assert.equal(model.toggleTool(), true);
  assert.deepEqual(model.entries.map((entry) => entry.expanded), [false, false]);
  assert.equal(model.toggleTool("call_2"), true);
  assert.deepEqual(model.entries.map((entry) => entry.expanded), [false, true]);
});

test("global tool expansion applies to a tool that starts streaming after the toggle", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({ type: "tool_requested", callId: "first", name: "read", input: { path: "first" }, index: 0 }, 1));
  model.apply(envelope({ type: "tool_completed", callId: "first", name: "read", index: 0, isError: false, preview: "first result" }, 2));
  assert.equal(model.entries[0]?.expanded, false);

  assert.equal(model.toggleTool(), true);
  model.apply(envelope({ type: "tool_requested", callId: "live", name: "shell", input: { command: "run" }, index: 1 }, 3));
  model.apply(envelope({ type: "tool_started", callId: "live", name: "shell", input: {}, index: 1, recoveryMode: "never_repeat" }, 4));
  assert.equal(model.entries[1]?.status, "running");
  assert.equal(model.entries[1]?.expanded, true);
  model.apply(envelope({
    type: "tool_progress",
    callId: "live",
    name: "shell",
    index: 1,
    sequence: 0,
    progress: { type: "output", stream: "stdout", delta: "live", stdoutBytes: 4, stderrBytes: 0 },
  }, 5));
  assert.equal(model.entries[1]?.expanded, true);
  model.apply(envelope({ type: "tool_completed", callId: "live", name: "shell", index: 1, isError: false, preview: "live result" }, 6));
  assert.deepEqual(model.entries.map((entry) => entry.expanded), [true, true]);

  assert.equal(model.toggleTool(), true);
  assert.deepEqual(model.entries.map((entry) => entry.expanded), [false, false]);
});

test("per-call tool expansion survives progress and completion updates", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({ type: "tool_requested", callId: "live", name: "shell", input: { command: "run" }, index: 0 }, 1));
  assert.equal(model.toggleTool("live"), true);
  model.apply(envelope({ type: "tool_started", callId: "live", name: "shell", input: {}, index: 0, recoveryMode: "never_repeat" }, 2));
  model.apply(envelope({
    type: "tool_progress",
    callId: "live",
    name: "shell",
    index: 0,
    sequence: 0,
    progress: { type: "output", stream: "stdout", delta: "live", stdoutBytes: 4, stderrBytes: 0 },
  }, 3));
  assert.equal(model.entries[0]?.expanded, true);
  model.apply(envelope({ type: "tool_completed", callId: "live", name: "shell", index: 0, isError: false, preview: "done" }, 4));
  assert.equal(model.entries[0]?.expanded, true);
});

test("global tool expansion also controls later persisted user-shell cards", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({ type: "tool_requested", callId: "first", name: "read", input: { path: "first" }, index: 0 }, 1));
  model.apply(envelope({ type: "tool_completed", callId: "first", name: "read", index: 0, isError: false, preview: "first" }, 2));
  assert.equal(model.toggleTool(), true);

  model.apply(envelope({
    type: "message_appended",
    message: {
      id: "expanded-shell",
      role: "user",
      content: [{ type: "text", text: "[User shell command]\n$ printf expanded\nexpanded\nexit 0" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 3));
  assert.equal(model.entries.at(-1)?.expanded, true);

  assert.equal(model.toggleTool(), true);
  model.apply(envelope({
    type: "message_appended",
    message: {
      id: "collapsed-shell",
      role: "user",
      content: [{ type: "text", text: "[User shell command]\n$ printf collapsed\ncollapsed\nexit 0" }],
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  }, 4));
  assert.equal(model.entries.at(-1)?.expanded, false);
});

test("global tool expansion survives transcript replacement and applies to replayed tools", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({
    type: "tool_requested",
    callId: "before-refresh",
    name: "read",
    input: { path: "before.ts" },
    index: 0,
  }, 1));
  assert.equal(model.toggleTool(), true);
  assert.equal(model.toolOutputExpanded, true);

  model.clearTranscript();
  model.apply(envelope({
    type: "message_appended",
    message: {
      id: "after-refresh",
      role: "tool",
      content: [{
        type: "tool_result",
        callId: "after-refresh",
        name: "read",
        content: "replayed result",
        isError: false,
      }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 2));

  assert.equal(model.toolOutputExpanded, true);
  assert.equal(model.entries[0]?.callId, "after-refresh");
  assert.equal(model.entries[0]?.expanded, true);
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

test("completed standalone tools become committable without a model run terminal event", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({ type: "tool_requested", callId: "shell-1", name: "bash", input: { command: "pwd" }, index: 0 }, 1));
  model.apply(envelope({ type: "tool_started", callId: "shell-1", name: "bash", input: { command: "pwd" }, index: 0, recoveryMode: "repeatable" }, 2));
  model.apply(envelope({ type: "tool_completed", callId: "shell-1", name: "bash", index: 0, isError: false, preview: "/tmp\n" }, 3));

  assert.deepEqual(model.committableEntries(), []);
  assert.equal(model.settleStandaloneTool("shell-1"), true);
  assert.deepEqual(model.committableEntries(), model.entries);
  assert.equal(model.settleStandaloneTool("shell-1"), false);
});

test("streaming tool-call arguments appear immediately and reconcile to one canonical card", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  model.apply(envelope({ type: "assistant_started", step: 1 }, 2));
  model.apply(envelope({ type: "tool_call_started", index: 0, name: "read" }, 3));

  const draft = model.entries.find((entry) => entry.kind === "tool");
  assert.equal(draft?.title, "read");
  assert.equal(draft?.status, "pending");
  assert.equal(draft?.toolData?.argsComplete, false);
  assert.equal(draft?.toolData?.executionStarted, false);
  assert.equal(model.context.activity?.phase, "Planning read");

  model.apply(envelope({ type: "tool_call_delta", index: 0, jsonFragment: "{\"path\":\"src/" }, 4));
  model.apply(envelope({ type: "tool_call_delta", index: 0, jsonFragment: "main.ts\"}" }, 5));
  const liveArguments = model.entries.find((entry) => entry.kind === "tool");
  assert.equal(liveArguments?.summary, "src/main.ts");
  assert.deepEqual(liveArguments?.toolData?.input, { path: "src/main.ts" });
  assert.equal(liveArguments?.inputPreview, undefined);

  model.apply(envelope({
    type: "tool_call_completed",
    index: 0,
    name: "read",
    rawArguments: "{\"path\":\"src/main.ts\"}",
    arguments: { path: "src/main.ts" },
  }, 6));
  const completedArguments = model.entries.find((entry) => entry.kind === "tool");
  assert.equal(completedArguments?.status, "pending");
  assert.equal(completedArguments?.toolData?.argsComplete, true);
  assert.equal(completedArguments?.toolData?.executionStarted, false);
  model.apply(envelope({
    type: "message_appended",
    message: {
      id: "assistant-streamed-tool",
      role: "assistant",
      content: [{
        type: "tool_call",
        callId: "generated-call",
        name: "read",
        arguments: { path: "src/main.ts" },
        rawArguments: "{\"path\":\"src/main.ts\"}",
      }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 7));
  model.apply(envelope({ type: "assistant_completed", finishReason: "tool_calls" }, 8));
  model.apply(envelope({
    type: "tool_requested",
    callId: "generated-call",
    name: "read",
    input: { path: "src/main.ts" },
    index: 0,
  }, 9));

  const tools = model.entries.filter((entry) => entry.kind === "tool");
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.id, "assistant-streamed-tool:tool:0");
  assert.equal(tools[0]?.callId, "generated-call");
  assert.deepEqual(tools[0]?.toolData?.input, { path: "src/main.ts" });
  assert.equal(tools[0]?.toolData?.argsComplete, true);
  assert.equal(tools[0]?.toolData?.executionStarted, false);
});

test("malformed extension argument deltas retain the bounded raw fallback", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  model.apply(envelope({ type: "assistant_started", step: 1 }, 2));
  model.apply(envelope({ type: "tool_call_started", index: 0, name: "custom_live" }, 3));
  model.apply(envelope({ type: "tool_call_delta", index: 0, jsonFragment: "{bad" }, 4));

  const entry = model.entries.find((candidate) => candidate.kind === "tool");
  assert.equal(entry?.toolData?.input, undefined);
  assert.equal(entry?.inputPreview, "{bad");
});

test("live mutation targets use top-level canonical path priority", () => {
  const cases = [
    {
      input: { metadata: { path: "nested-fake.ts" }, path: "src/real.ts", content: "visible source" },
      expectedPath: "src/real.ts",
    },
    {
      input: { file: "fallback.ts", file_path: "secondary.ts", path: "src/preferred.ts", content: "visible source" },
      expectedPath: "src/preferred.ts",
    },
  ];

  for (const [index, selected] of cases.entries()) {
    const model = new TuiModel(DEFAULT_TUI_LIMITS);
    model.apply(envelope({ type: "assistant_started", step: 1 }, 1));
    model.apply(envelope({ type: "tool_call_started", index: 0, name: "write" }, 2));
    model.apply(envelope({
      type: "tool_call_delta",
      index: 0,
      jsonFragment: JSON.stringify(selected.input),
    }, 3));

    const entry = model.entries[0];
    assert.match(entry?.summary ?? "", new RegExp(`^${selected.expectedPath.replaceAll(".", "\\.")} · receiving`, "u"), `${index}`);
    assert.match(entry?.inputPreview ?? "", /visible source/u, `${index}`);
    assert.doesNotMatch(entry?.summary ?? "", /nested-fake|fallback|secondary/u, `${index}`);
  }
});

test("live mutation previews ignore fields inherited through partial JSON __proto__ input", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  const rawArguments = "{\"__proto__\":{\"path\":\"ghost.ts\",\"content\":\"ghost source\"}}";
  model.apply(envelope({ type: "assistant_started", step: 1 }, 1));
  model.apply(envelope({ type: "tool_call_started", index: 0, name: "write" }, 2));
  model.apply(envelope({ type: "tool_call_delta", index: 0, jsonFragment: rawArguments }, 3));

  const entry = model.entries[0];
  assert.equal(entry?.summary, `receiving ${Buffer.byteLength(rawArguments, "utf8")} argument bytes`);
  assert.equal(entry?.inputPreview, undefined);
  assert.deepEqual(entry?.toolData?.input, {});
  assert.doesNotMatch(JSON.stringify(entry), /ghost/u);
});

test("tool summaries and completed mutation patches ignore inherited fields", () => {
  const generic = new TuiModel(DEFAULT_TUI_LIMITS);
  const inheritedInput = Object.create({ path: "ghost.ts" }) as { path: string };
  generic.apply(envelope({
    type: "tool_requested",
    callId: "call_inherited_input",
    name: "custom",
    input: inheritedInput,
    index: 0,
  }, 1));
  assert.equal(generic.entries[0]?.summary, undefined);
  assert.doesNotMatch(JSON.stringify(generic.entries[0]), /ghost/u);

  const edit = new TuiModel(DEFAULT_TUI_LIMITS);
  edit.apply(envelope({
    type: "tool_requested",
    callId: "call_inherited_diff",
    name: "edit",
    input: { path: "src/real.ts", oldText: "before", newText: "after" },
    index: 0,
  }, 1));
  const requestedPreview = edit.entries[0]?.inputPreview;
  const inheritedMetadata = Object.create({ diff: "GHOST INHERITED DIFF" }) as { diff: string };
  edit.apply(envelope({
    type: "tool_completed",
    callId: "call_inherited_diff",
    name: "edit",
    index: 0,
    isError: false,
    preview: "edited",
    result: {
      type: "tool_result",
      callId: "call_inherited_diff",
      name: "edit",
      content: "edited",
      isError: false,
      metadata: inheritedMetadata,
    },
  }, 2));
  assert.equal(edit.entries[0]?.inputPreview, requestedPreview);
  assert.doesNotMatch(edit.entries[0]?.inputPreview ?? "", /GHOST/u);
});

test("long streaming write arguments keep one card with a stable source head and advancing tail", () => {
  const maximum = 160;
  const model = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxToolPreviewBytes: maximum });
  model.apply(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  model.apply(envelope({ type: "assistant_started", step: 1 }, 2));
  model.apply(envelope({ type: "tool_call_started", index: 0, name: "write" }, 3));
  const firstContent = `HEAD${"a".repeat(6 * 1024)}TAIL_ONE`;
  model.apply(envelope({
    type: "tool_call_delta",
    index: 0,
    jsonFragment: `{"path":"large.txt","content":"${firstContent}`,
  }, 4));

  const beforeEntry = model.entries.find((entry) => entry.kind === "tool");
  const before = beforeEntry?.summary ?? "";
  const beforePreview = beforeEntry?.inputPreview ?? "";
  assert.match(before, /^large\.txt · receiving [\d,]+ argument bytes$/u);
  assert.match(beforePreview, /^\+ HEAD/u);
  assert.match(beforePreview, /earlier input hidden; newest input follows/u);
  assert.match(beforePreview, /TAIL_ONE$/u);
  assert.ok(Buffer.byteLength(beforePreview, "utf8") <= maximum);
  assert.doesNotMatch(beforePreview, /[{}"]|path|content/u);
  assert.ok(Buffer.byteLength(JSON.stringify(beforeEntry?.toolData?.input), "utf8") <= maximum);
  assert.ok(Buffer.byteLength(before, "utf8") <= maximum);

  const secondContent = `${"b".repeat(6 * 1024)}TAIL_TWO`;
  model.apply(envelope({
    type: "tool_call_delta",
    index: 0,
    jsonFragment: `${secondContent}\"}`,
  }, 5));
  const afterEntry = model.entries.find((entry) => entry.kind === "tool");
  const after = afterEntry?.summary ?? "";
  assert.match(after, /^large\.txt · receiving [\d,]+ argument bytes$/u);
  assert.strictEqual(afterEntry, beforeEntry);
  assert.match(afterEntry?.inputPreview ?? "", /^\+ HEAD/u);
  assert.match(afterEntry?.inputPreview ?? "", /earlier input hidden; newest input follows/u);
  assert.match(afterEntry?.inputPreview ?? "", /TAIL_TWO$/u);
  assert.doesNotMatch(afterEntry?.inputPreview ?? "", /TAIL_ONE/u);
  assert.notEqual(afterEntry?.inputPreview, beforePreview);
  assert.notEqual(after, before);
  assert.ok(Buffer.byteLength(after, "utf8") <= maximum);

  const content = `${firstContent}${secondContent}`;
  model.apply(envelope({
    type: "tool_call_completed",
    index: 0,
    name: "write",
    rawArguments: JSON.stringify({ path: "large.txt", content }),
    arguments: { path: "large.txt", content },
  }, 6));
  const completedEntry = model.entries.find((entry) => entry.kind === "tool");
  assert.strictEqual(completedEntry, beforeEntry);
  assert.equal(model.entries.filter((entry) => entry.kind === "tool").length, 1);
  const completedPreview = completedEntry?.inputPreview ?? "";
  assert.match(completedPreview, /^\+ HEAD/u);
  assert.match(completedPreview, /earlier input hidden; newest input follows/u);
  assert.match(completedPreview, /TAIL_TWO$/u);
  assert.ok(Buffer.byteLength(completedPreview, "utf8") <= maximum);
  assert.deepEqual(completedEntry?.toolData?.input, { path: "large.txt" });
  assert.equal(completedEntry?.toolData?.argsComplete, true);
});

test("many small live argument deltas retain only the visible draft window", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  model.apply(envelope({ type: "assistant_started", step: 1 }, 2));
  model.apply(envelope({ type: "tool_call_started", index: 0, name: "custom" }, 3));
  for (let index = 0; index < 600; index += 1) {
    model.apply(envelope({
      type: "tool_call_delta",
      index: 0,
      jsonFragment: index === 599 ? `${"x".repeat(240)}LIVE_TAIL` : "x".repeat(256),
    }, index + 4));
  }
  const preview = model.entries.find((entry) => entry.kind === "tool")?.inputPreview ?? "";
  assert.ok(Buffer.byteLength(preview, "utf8") <= 4 * 1024);
  assert.match(preview, /earlier input hidden; newest input follows/u);
  assert.match(preview, /LIVE_TAIL$/u);
});

test("rolling tool arguments stay Unicode-safe at tiny limits and on large completion payloads", () => {
  const tiny = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxToolPreviewBytes: 8 });
  tiny.apply(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  tiny.apply(envelope({ type: "assistant_started", step: 1 }, 2));
  tiny.apply(envelope({ type: "tool_call_started", index: 0, name: "custom" }, 3));
  tiny.apply(envelope({ type: "tool_call_delta", index: 0, jsonFragment: "界🙂e\u0301界🙂" }, 4));
  const tinyPreview = tiny.entries.find((entry) => entry.kind === "tool")?.inputPreview ?? "";
  assert.ok(Buffer.byteLength(tinyPreview, "utf8") <= 8);
  assert.doesNotMatch(tinyPreview, /\ufffd/u);

  const boundaryMaximum = 160;
  const boundaryMarker = "\n… earlier input hidden; newest input follows\n";
  const boundaryHeadBytes = Math.floor(
    (boundaryMaximum - Buffer.byteLength(boundaryMarker, "utf8")) / 3,
  );
  const boundary = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxToolPreviewBytes: boundaryMaximum });
  boundary.apply(envelope({
    type: "tool_call_completed",
    index: 0,
    name: "custom",
    rawArguments: `${"\0".repeat(boundaryHeadBytes + 4 * 1024 - 1)}🙂${"z".repeat(240)}TAIL`,
  }, 1));
  const boundaryPreview = boundary.entries.find((entry) => entry.kind === "tool")?.inputPreview ?? "";
  assert.doesNotMatch(boundaryPreview, /\ufffd/u);
  assert.match(boundaryPreview, /TAIL/u);

  const maximum = 64 * 1024;
  const large = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxToolPreviewBytes: maximum });
  large.apply(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  large.apply(envelope({ type: "assistant_started", step: 1 }, 2));
  large.apply(envelope({ type: "tool_call_completed", index: 0, name: "custom", rawArguments: `{"value":"${"a".repeat(4 * 1024 * 1024)}TAIL"}` }, 3));
  const largePreview = large.entries.find((entry) => entry.kind === "tool")?.inputPreview ?? "";
  assert.ok(Buffer.byteLength(largePreview, "utf8") <= maximum);
  assert.match(largePreview, /^\{"value":/u);
  assert.match(largePreview, /TAIL"\}$/u);

  const live = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxToolPreviewBytes: maximum });
  live.apply(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  live.apply(envelope({ type: "assistant_started", step: 1 }, 2));
  live.apply(envelope({ type: "tool_call_started", index: 0, name: "custom" }, 3));
  live.apply(envelope({
    type: "tool_call_delta",
    index: 0,
    jsonFragment: `{"value":"${"a".repeat(4 * 1024 * 1024)}LIVE_TAIL"}`,
  }, 4));
  const livePreview = live.entries.find((entry) => entry.kind === "tool")?.inputPreview ?? "";
  assert.ok(Buffer.byteLength(livePreview, "utf8") <= maximum);
  assert.match(livePreview, /^\{"value":/u);
  assert.match(livePreview, /LIVE_TAIL"\}$/u);
});

test("canonical replay and requested tools retain bounded previews for oversized generic arguments", () => {
  const maximum = 160;
  const argumentsValue = { value: `${"a".repeat(4 * 1024 * 1024)}TAIL_SENTINEL` };
  const model = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxToolPreviewBytes: maximum });
  model.apply(envelope({
    type: "message_appended",
    message: {
      id: "assistant-replayed-tool",
      role: "assistant",
      content: [{ type: "tool_call", callId: "replayed-call", name: "custom", arguments: argumentsValue }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 1));

  const preview = model.entries.find((entry) => entry.kind === "tool")?.inputPreview ?? "";
  assert.match(preview, /^\{"value":/u);
  assert.match(preview, /earlier input hidden; newest input follows/u);
  assert.match(preview, /TAIL_SENTINEL"\}$/u);
  assert.ok(Buffer.byteLength(preview, "utf8") <= maximum);

  const requested = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxToolPreviewBytes: maximum });
  requested.apply(envelope({
    type: "tool_requested",
    callId: "requested-call",
    name: "custom",
    input: argumentsValue,
    index: 0,
  }, 1));
  const requestedPreview = requested.entries.find((entry) => entry.kind === "tool")?.inputPreview ?? "";
  assert.match(requestedPreview, /^\{"value":/u);
  assert.match(requestedPreview, /earlier input hidden; newest input follows/u);
  assert.match(requestedPreview, /TAIL_SENTINEL"\}$/u);
  assert.ok(Buffer.byteLength(requestedPreview, "utf8") <= maximum);

  const writeArguments = { path: "large.txt", content: `FIRST${"a".repeat(4 * 1024 * 1024)}WRITE_TAIL` };
  const write = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxToolPreviewBytes: maximum });
  write.apply(envelope({
    type: "tool_call_completed",
    index: 0,
    name: "write",
    rawArguments: JSON.stringify(writeArguments),
    arguments: writeArguments,
  }, 1));
  const writePreview = write.entries.find((entry) => entry.kind === "tool")?.inputPreview ?? "";
  const writeEntry = write.entries.find((entry) => entry.kind === "tool");
  assert.match(writePreview, /^\+ FIRST/u);
  assert.match(writePreview, /earlier input hidden; newest input follows/u);
  assert.match(writePreview, /WRITE_TAIL$/u);
  assert.ok(Buffer.byteLength(writePreview, "utf8") <= maximum);
  assert.match(writeEntry?.summary ?? "", /^large\.txt · 1 line · [\d,]+ bytes$/u);
  assert.deepEqual(writeEntry?.toolData?.input, { path: "large.txt" });
  assert.doesNotMatch(JSON.stringify(writeEntry?.toolData?.input), /FIRST|WRITE_TAIL|a{16}/u);
});

test("tool ownership stays with the active assistant source and ignores user shell runs", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  const active = (event: Parameters<TuiModel["apply"]>[0]["event"], sequence: number) => {
    model.apply({ ...envelope(event, sequence), runId: "agent-run" });
  };
  active({ type: "run_started", provider: "openai", model: "gpt-test" }, 1);
  active({ type: "assistant_started", step: 1 }, 2);
  active({ type: "text_delta", text: "first part", part: 0 }, 3);
  active({ type: "tool_call_started", index: 0, name: "read" }, 4);
  for (let sequence = 5; sequence < 105; sequence += 1) {
    active({ type: "tool_call_delta", index: 0, jsonFragment: "x" }, sequence);
  }
  active({ type: "text_delta", text: "second part", part: 1 }, 105);
  assert.ok(model.entries.filter((entry) => entry.kind === "assistant").every((entry) => entry.hasToolCalls === true));

  active({ type: "run_completed", finishReason: "stop" }, 106);
  const priorAssistant = model.entries.find((entry) => entry.kind === "assistant");
  assert.equal(priorAssistant?.hasToolCalls, true);
  model.apply({
    ...envelope({
      type: "tool_requested",
      callId: "user-shell",
      name: "bash",
      input: { command: "pwd" },
      index: 0,
    }, 107),
    runId: "shell-run",
  });
  assert.equal(priorAssistant?.hasToolCalls, true);

  const unmarked = new TuiModel(DEFAULT_TUI_LIMITS);
  unmarked.apply(envelope({
    type: "message_appended",
    message: {
      id: "previous-answer",
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 1));
  unmarked.apply({
    ...envelope({ type: "tool_requested", callId: "shell", name: "bash", input: { command: "pwd" }, index: 0 }, 2),
    runId: "shell-run",
  });
  assert.equal(unmarked.entries.find((entry) => entry.kind === "assistant")?.hasToolCalls, undefined);
});

test("completed streamed text replaces partial parts without duplicating content", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({ type: "assistant_started", step: 1 }, 1));
  model.apply(envelope({ type: "text_delta", text: "hel", part: 0 }, 2));
  model.apply(envelope({ type: "text_delta", text: "world", part: 1 }, 3));
  assert.deepEqual(model.entries.map((entry) => entry.text), ["hel", "world"]);

  model.apply(envelope({ type: "text_completed", text: "hello ", part: 0 }, 4));
  model.apply(envelope({ type: "text_completed", text: "world", part: 1 }, 5));
  assert.deepEqual(model.entries.map((entry) => entry.text), ["hello ", "world"]);
});

test("context-limit recovery discards only the current noncanonical assistant attempt", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({
    type: "message_appended",
    message: {
      id: "durable-assistant",
      role: "assistant",
      content: [
        { type: "text", text: "Retain this answer." },
        { type: "tool_call", callId: "discarded-call", name: "read", arguments: { path: "durable.ts" } },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 1));
  model.apply(envelope({ type: "assistant_completed", finishReason: "tool_calls" }, 2));
  model.apply(envelope({
    type: "message_appended",
    message: {
      id: "durable-tool-result",
      role: "tool",
      content: [{
        type: "tool_result",
        callId: "discarded-call",
        name: "read",
        content: "durable file",
        isError: false,
      }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 3));
  model.apply(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 4));
  model.apply(envelope({ type: "assistant_started", step: 1 }, 5));
  model.apply(envelope({
    type: "reasoning_delta",
    text: "discarded reasoning",
    part: 0,
    visibility: "summary",
  }, 6));
  model.apply(envelope({ type: "tool_call_started", index: 0, id: "discarded-call", name: "read" }, 7));
  model.apply(envelope({
    type: "tool_call_delta",
    index: 0,
    jsonFragment: "{\"path\":\"discarded.ts\"}",
  }, 8));
  model.apply(envelope({ type: "text_delta", text: "discarded answer", part: 0 }, 9));

  assert.equal(model.entries.some((entry) => entry.text.includes("discarded")), true);
  assert.equal(model.entries.some((entry) => entry.status === "pending"), true);

  model.apply(envelope({ type: "assistant_completed", finishReason: "context_limit" }, 10));

  assert.deepEqual(model.entries.map((entry) => [entry.id, entry.text, entry.status]), [
    ["durable-assistant", "Retain this answer.", undefined],
    ["durable-assistant:tool:1", "durable file", "completed"],
  ]);
  assert.deepEqual(model.entries[1]?.toolData, {
    argsComplete: true,
    executionStarted: true,
    input: { path: "durable.ts" },
    result: { content: "durable file", isError: false },
  });
  assert.deepEqual(model.committableEntries(), model.entries);

  model.apply(envelope({ type: "assistant_started", step: 2 }, 11));
  model.apply(envelope({ type: "text_delta", text: "Recovered answer.", part: 0 }, 12));
  model.apply(envelope({
    type: "message_appended",
    message: {
      id: "recovered-assistant",
      role: "assistant",
      content: [{ type: "text", text: "Recovered answer." }],
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  }, 13));
  model.apply(envelope({ type: "assistant_completed", finishReason: "stop" }, 14));
  model.apply(envelope({ type: "run_completed", finishReason: "stop" }, 15));

  assert.deepEqual(model.entries.map((entry) => [entry.id, entry.text, entry.status]), [
    ["durable-assistant", "Retain this answer.", undefined],
    ["durable-assistant:tool:1", "durable file", "completed"],
    ["recovered-assistant", "Recovered answer.", undefined],
  ]);
});

test("canonical context-limit messages stay out of live and replayed transcripts", () => {
  const contextLimitMessage = {
    id: "context-limit-assistant",
    role: "assistant" as const,
    content: [
      { type: "thinking" as const, thinking: "discarded canonical reasoning", visibility: "summary" as const },
      { type: "text" as const, text: "discarded canonical answer" },
      { type: "tool_call" as const, callId: "context-limit-read", name: "read", arguments: { path: "discarded.ts" } },
    ],
    stopReason: "context_limit" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  const live = new TuiModel(DEFAULT_TUI_LIMITS);
  live.apply(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  live.apply(envelope({ type: "assistant_started", step: 1 }, 2));
  live.apply(envelope({
    type: "reasoning_delta",
    text: "discarded canonical reasoning",
    part: 0,
    visibility: "summary",
  }, 3));
  live.apply(envelope({ type: "text_delta", text: "discarded canonical answer", part: 1 }, 4));
  live.apply(envelope({ type: "tool_call_started", index: 2, id: "context-limit-read", name: "read" }, 5));
  live.apply(envelope({ type: "message_appended", message: contextLimitMessage }, 6));
  live.apply(envelope({ type: "assistant_completed", finishReason: "context_limit" }, 7));
  assert.deepEqual(live.entries, []);
  assert.deepEqual(live.committableEntries(), []);

  const replay = new TuiModel(DEFAULT_TUI_LIMITS);
  replay.apply(envelope({ type: "message_appended", message: contextLimitMessage }, 1));
  replay.apply(envelope({ type: "assistant_completed", finishReason: "context_limit" }, 2));
  assert.deepEqual(replay.entries, []);
  assert.deepEqual(replay.committableEntries(), []);
});

test("output-limit completion keeps partial assistant text and appends one bounded warning", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({ type: "assistant_started", step: 1 }, 1));
  model.apply(envelope({ type: "text_delta", text: "Partial answer", part: 0 }, 2));
  const completion = envelope({ type: "assistant_completed", finishReason: "length" }, 3);
  model.apply(completion);
  model.apply(completion);

  assert.deepEqual(model.entries.map((entry) => ({
    kind: entry.kind,
    text: entry.text,
    streaming: entry.streaming,
  })), [
    { kind: "assistant", text: "Partial answer", streaming: false },
    {
      kind: "warning",
      text: "The response reached the model's output-token limit and may be incomplete.",
      streaming: undefined,
    },
  ]);
  assert.deepEqual(model.committableEntries(), model.entries);
});

test("replayed output-limit messages restore the incomplete-response warning", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({
    type: "message_appended",
    message: {
      id: "limited-assistant",
      role: "assistant",
      content: [{ type: "text", text: "Persisted partial answer" }],
      stopReason: "length",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 1));
  model.apply(envelope({ type: "assistant_completed", finishReason: "length" }, 2));

  assert.deepEqual(model.entries.map((entry) => [entry.kind, entry.text]), [
    ["assistant", "Persisted partial answer"],
    ["warning", "The response reached the model's output-token limit and may be incomplete."],
  ]);
});

test("historical tool calls remain addressable until their canonical result arrives", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({
    type: "message_appended",
    message: {
      id: "assistant-pending-tool",
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect the file." },
        { type: "tool_call", callId: "historical-read", name: "read", arguments: { path: "src/main.ts" } },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 1));
  model.apply(envelope({ type: "assistant_completed", finishReason: "tool_calls" }, 2));

  assert.deepEqual(model.entries.map((entry) => [entry.id, entry.status]), [
    ["assistant-pending-tool", undefined],
    ["assistant-pending-tool:tool:1", "pending"],
  ]);
  assert.equal(model.entries[0]?.hasToolCalls, true);
  assert.deepEqual(model.entries[1]?.toolData?.input, { path: "src/main.ts" });
  assert.deepEqual(model.committableEntries().map((entry) => entry.id), ["assistant-pending-tool"]);

  model.apply(envelope({
    type: "message_appended",
    message: {
      id: "historical-result",
      role: "tool",
      content: [{
        type: "tool_result",
        callId: "historical-read",
        name: "read",
        content: "export const ready = true;",
        isError: false,
      }],
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  }, 3));

  assert.equal(model.entries.filter((entry) => entry.callId === "historical-read").length, 1);
  assert.equal(model.entries[1]?.status, "completed");
  assert.equal(model.entries[1]?.text, "export const ready = true;");
  assert.deepEqual(model.committableEntries().map((entry) => entry.id), [
    "assistant-pending-tool",
    "assistant-pending-tool:tool:1",
  ]);
});

for (const [label, terminalEvent] of [
  ["completed", { type: "run_completed", finishReason: "stop" }],
  ["failed", { type: "run_failed", error: { category: "internal", message: "run failed" } }],
  ["cancelled", { type: "run_cancelled", reason: "operator cancelled" }],
] as const) {
  test(`${label} runs settle canonical tools, remove drafts, and accept a late durable result`, () => {
    const model = new TuiModel(DEFAULT_TUI_LIMITS);
    model.apply(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
    model.apply(envelope({ type: "assistant_started", step: 1 }, 2));
    model.apply(envelope({
      type: "message_appended",
      message: {
        id: `${label}-assistant`,
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect the file." },
          { type: "tool_call", callId: `${label}-read`, name: "read", arguments: { path: "src/main.ts" } },
        ],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    }, 3));
    model.apply(envelope({ type: "assistant_completed", finishReason: "tool_calls" }, 4));
    model.apply(envelope({
      type: "tool_started",
      callId: `${label}-read`,
      name: "read",
      input: { path: "src/main.ts" },
      index: 0,
      recoveryMode: "repeatable",
    }, 5));
    model.apply(envelope({
      type: "tool_progress",
      callId: `${label}-read`,
      name: "read",
      index: 0,
      sequence: 1,
      progress: {
        type: "output",
        stream: "stdout",
        delta: "partial output",
        stdoutBytes: 14,
        stderrBytes: 0,
      },
    }, 6));
    model.apply(envelope({ type: "tool_call_started", index: 1, id: `${label}-draft`, name: "read" }, 7));
    model.apply(envelope(terminalEvent, 8));

    const settled = model.entries.find((entry) => entry.callId === `${label}-read`);
    assert.equal(settled?.status, "in_doubt");
    assert.equal(settled?.toolData?.progress, undefined);
    assert.equal(model.entries.some((entry) => entry.callId?.startsWith("draft:") === true), false);
    assert.equal(model.entries.some((entry) => entry.status === "pending" || entry.status === "running"), false);

    model.apply(envelope({
      type: "message_appended",
      message: {
        id: `${label}-late-result`,
        role: "tool",
        content: [{
          type: "tool_result",
          callId: `${label}-read`,
          name: "read",
          content: "export const ready = true;",
          isError: false,
        }],
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    }, 9));

    assert.equal(model.entries.filter((entry) => entry.callId === `${label}-read`).length, 1);
    assert.equal(model.entries.find((entry) => entry.callId === `${label}-read`)?.status, "completed");
  });
}

test("reused provider tool-call IDs create independent chronological cards across turns", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  const appendToolCall = (messageId: string, path: string, sequence: number): void => {
    model.apply(envelope({
      type: "message_appended",
      message: {
        id: messageId,
        role: "assistant",
        content: [{ type: "tool_call", callId: "reused-call", name: "read", arguments: { path } }],
        createdAt: `2026-01-01T00:00:0${sequence}.000Z`,
      },
    }, sequence));
    model.apply(envelope({ type: "assistant_completed", finishReason: "tool_calls" }, sequence + 1));
  };
  const appendToolResult = (messageId: string, content: string, sequence: number): void => {
    model.apply(envelope({
      type: "message_appended",
      message: {
        id: messageId,
        role: "tool",
        content: [{
          type: "tool_result",
          callId: "reused-call",
          name: "read",
          content,
          isError: false,
        }],
        createdAt: `2026-01-01T00:00:0${sequence}.000Z`,
      },
    }, sequence));
  };

  appendToolCall("assistant-first", "first.ts", 1);
  appendToolResult("tool-first", "first result", 3);
  appendToolCall("assistant-second", "second.ts", 4);
  appendToolResult("tool-second", "second result", 6);

  assert.deepEqual(model.entries.map((entry) => ({
    id: entry.id,
    callId: entry.callId,
    text: entry.text,
    status: entry.status,
  })), [
    { id: "assistant-first:tool:0", callId: "reused-call", text: "first result", status: "completed" },
    { id: "assistant-second:tool:0", callId: "reused-call", text: "second result", status: "completed" },
  ]);
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

test("TUI model releases assistant replay ownership after every projected row is discarded", () => {
  const projected = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxTranscriptEntries: 2 });
  const reasoningAndTool = envelope({
    type: "message_appended",
    message: {
      id: "assistant-reasoning-tool",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Inspect the file", visibility: "summary" },
        { type: "tool_call", callId: "reasoning-tool-call", name: "read", arguments: { path: "src/main.ts" } },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 1);

  projected.apply(reasoningAndTool);
  assert.deepEqual(projected.entries.map((entry) => entry.id), [
    "assistant-reasoning-tool:reasoning:0",
    "assistant-reasoning-tool:tool:1",
  ]);
  projected.addLocal("status", "evict reasoning");
  projected.apply(reasoningAndTool);
  assert.deepEqual(projected.entries.map((entry) => entry.id), ["assistant-reasoning-tool:tool:1", "local:1"]);
  projected.addLocal("status", "evict tool");
  projected.apply(reasoningAndTool);
  assert.deepEqual(projected.entries.map((entry) => entry.id), [
    "assistant-reasoning-tool:reasoning:0",
    "assistant-reasoning-tool:tool:1",
  ]);

  const toolOnly = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxTranscriptEntries: 1 });
  const toolMessage = envelope({
    type: "message_appended",
    message: {
      id: "assistant-tool-only",
      role: "assistant",
      content: [
        { type: "tool_call", callId: "tool-only-call", name: "read", arguments: { path: "src/main.ts" } },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 2);
  toolOnly.apply(toolMessage);
  assert.deepEqual(toolOnly.entries.map((entry) => entry.id), ["assistant-tool-only:tool:0"]);
  toolOnly.addLocal("status", "evict tool-only row");
  toolOnly.apply(toolMessage);
  assert.deepEqual(toolOnly.entries.map((entry) => entry.id), ["assistant-tool-only:tool:0"]);
});

test("TUI usage exposes provider cache data and keeps generated output out of context pressure", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.setContext({ contextWindowTokens: 20_000 });
  model.apply({ ...envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1), runId: "usage" });
  model.apply({ ...envelope({ type: "assistant_started", step: 1 }, 2), runId: "usage" });
  model.apply({ ...envelope({
    type: "usage",
    semantics: "final",
    usage: { inputTokens: 10_000, outputTokens: 200, cacheReadTokens: 8_000, cacheWriteTokens: 1_000, cacheWrite1hTokens: 600 },
  }, 3), runId: "usage" });
  assert.deepEqual(model.usage?.total, {
    inputTokens: 10_000,
    outputTokens: 200,
    cacheReadTokens: 8_000,
    cacheWriteTokens: 1_000,
    cacheWrite1hTokens: 600,
    totalTokens: 19_200,
  });
  assert.equal(model.usage?.latestCacheHitRate, undefined);
  model.apply({ ...envelope({ type: "assistant_completed", finishReason: "stop" }, 4), runId: "usage" });
  assert.ok(Math.abs((model.usage?.latestCacheHitRate ?? 0) - 42.10526315789473) < 0.000001);
  assert.equal(model.context.contextTokens, 19_000);
});

test("TUI usage aggregates runs without double-counting cumulative updates", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply({ ...envelope({ type: "usage", semantics: "cumulative", usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } } }, 1), runId: "run_one" });
  model.apply({ ...envelope({ type: "usage", semantics: "final", usage: { inputTokens: 120, outputTokens: 20, cacheReadTokens: 90, cost: { input: 0.02, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 } } }, 2), runId: "run_one" });
  model.apply({ ...envelope({ type: "usage", semantics: "incremental", usage: { inputTokens: 30, outputTokens: 5, cacheWriteTokens: 10, cost: { input: 0.005, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.005 } } }, 3), runId: "run_two" });
  model.apply({ ...envelope({ type: "usage", semantics: "incremental", usage: { inputTokens: 20, outputTokens: 5, cost: { input: 0.005, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.005 } } }, 4), runId: "run_two" });
  assert.deepEqual(model.usage, {
    total: {
      inputTokens: 170,
      outputTokens: 30,
      cost: { input: 0.03, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    },
    reportedTotal: {
      inputTokens: 170,
      outputTokens: 30,
      cacheReadTokens: 90,
      cacheWriteTokens: 10,
      totalTokens: 300,
      cost: { input: 0.03, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    },
    reportedPromptInputTokens: 270,
  });
});

test("TUI usage accumulates every model request in a multi-step run", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  const apply = (event: Parameters<TuiModel["apply"]>[0]["event"], sequence: number): void => {
    model.apply({ ...envelope(event, sequence), runId: "multi-step" });
  };
  apply({ type: "run_started", provider: "openai", model: "gpt-test" }, 1);
  apply({ type: "assistant_started", step: 1 }, 2);
  apply({
    type: "usage",
    semantics: "final",
    usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  }, 3);
  apply({ type: "assistant_completed", finishReason: "tool_calls" }, 4);
  apply({ type: "assistant_started", step: 2 }, 5);
  apply({
    type: "usage",
    semantics: "final",
    usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
  }, 6);
  apply({ type: "assistant_completed", finishReason: "stop" }, 7);
  apply({ type: "run_completed", finishReason: "stop" }, 8);

  assert.deepEqual(model.usage?.total, {
    inputTokens: 300,
    outputTokens: 30,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 330,
  });
  assert.equal(model.context.contextTokens, 200);
});

test("TUI usage accounting stays bounded across a long controller lifetime", { timeout: 4_000 }, () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  let sequence = 0;
  const apply = (runId: string, event: Parameters<TuiModel["apply"]>[0]["event"]): void => {
    sequence += 1;
    model.apply({ ...envelope(event, sequence), runId });
  };

  for (let index = 0; index < 8_000; index += 1) {
    const runId = `usage-soak-${index}`;
    apply(runId, { type: "run_started", provider: "fixture", model: "fixture" });
    apply(runId, { type: "assistant_started", step: 1 });
    apply(runId, { type: "usage", semantics: "final", usage: { inputTokens: 1 } });
    apply(runId, { type: "run_completed", finishReason: "stop" });
  }

  assert.equal(model.usage?.total.inputTokens, 8_000);
});

test("TUI hydrates durable usage and keeps compaction usage out of context pressure", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.setUsageBaseline({ inputTokens: 500, outputTokens: 50 }, 80);
  assert.equal(model.usage?.latestCacheHitRate, 80);
  model.apply({ ...envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1), runId: "compact" });
  model.apply({ ...envelope({ type: "compaction_started", reason: "threshold" }, 2), runId: "compact" });
  model.apply({
    ...envelope({ type: "usage", semantics: "final", usage: { inputTokens: 100, outputTokens: 10 } }, 3),
    runId: "compact",
  });

  assert.deepEqual(model.usage?.total, {
    inputTokens: 600,
    outputTokens: 60,
  });
  assert.equal(model.usage?.latestCacheHitRate, 80);
  assert.equal(model.context.contextTokens, 0);
});

test("compaction start replaces stale provider usage with the projected context pressure", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.setContext({ contextWindowTokens: 272_000 });
  model.apply(envelope({
    type: "usage",
    semantics: "final",
    usage: { inputTokens: 125_936, cacheReadTokens: 0, cacheWriteTokens: 0 },
  }, 1));
  assert.equal(model.context.contextTokens, 125_936);

  model.apply(envelope({
    type: "compaction_started",
    reason: "overflow",
    estimatedTokensBefore: 237_505,
  }, 2));

  assert.equal(model.context.contextTokens, 237_505);
  assert.equal(model.entries.at(-1)?.text, "Reason: overflow · 237,505 projected tokens");
});

test("compaction completion keeps projected post-compaction pressure until fresh provider usage", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.setContext({ contextWindowTokens: 272_000 });
  model.apply(envelope({
    type: "compaction_started",
    reason: "overflow",
    estimatedTokensBefore: 237_505,
  }, 1));
  model.apply(envelope({
    type: "compaction_completed",
    summary: {
      id: "projected-summary",
      role: "assistant",
      content: [{ type: "text", text: "Retained checkpoint" }],
      purpose: "compaction",
      createdAt: "2026-08-08T00:00:00.000Z",
    },
    sourceMessageIds: ["old"],
    firstKeptMessageId: "kept",
    tokensBefore: 237_505,
    estimatedTokensAfter: 54_656,
    reason: "overflow",
    willRetry: true,
    fromExtension: false,
  }, 2));

  assert.equal(model.context.contextTokens, 54_656);
  model.setContext({ active: true, status: "streaming" });
  assert.equal(model.context.contextTokens, 54_656);
  model.apply(envelope({ type: "assistant_started", step: 2 }, 3));
  model.apply(envelope({
    type: "usage",
    semantics: "final",
    usage: { inputTokens: 60_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  }, 4));
  assert.equal(model.context.contextTokens, 60_000);

  const legacy = new TuiModel(DEFAULT_TUI_LIMITS);
  legacy.apply(envelope({ type: "compaction_started", estimatedTokensBefore: 90_000 }, 1));
  legacy.apply(envelope({
    type: "compaction_completed",
    summary: {
      id: "legacy-summary",
      role: "assistant",
      content: [{ type: "text", text: "Legacy checkpoint" }],
      purpose: "compaction",
      createdAt: "2026-08-08T00:00:00.000Z",
    },
    sourceMessageIds: ["old"],
    firstKeptMessageId: "kept",
    tokensBefore: 90_000,
    fromExtension: false,
  }, 2));
  assert.equal(legacy.context.contextTokens, undefined);
});

test("live usage preserves the last completed cache hit rate until the current request completes", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.setUsageBaseline({ inputTokens: 20, cacheReadTokens: 80, outputTokens: 5 }, 80);
  model.apply({
    ...envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1),
    runId: "cache-freshness",
  });
  model.apply({
    ...envelope({ type: "assistant_started", step: 1 }, 2),
    runId: "cache-freshness",
  });
  model.apply({
    ...envelope({
      type: "usage",
      semantics: "final",
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 0 },
    }, 3),
    runId: "cache-freshness",
  });

  assert.equal(model.usage?.latestCacheHitRate, 80);
  model.apply({
    ...envelope({ type: "assistant_completed", finishReason: "stop" }, 4),
    runId: "cache-freshness",
  });
  assert.equal(model.usage?.latestCacheHitRate, 90);
});

test("TUI usage distinguishes unavailable cache counters from explicit zero", () => {
  const missing = new TuiModel(DEFAULT_TUI_LIMITS);
  missing.setUsageBaseline({
    inputTokens: 20,
    outputTokens: 5,
    cacheReadTokens: 80,
    cacheWriteTokens: 0,
    totalTokens: 105,
  }, 80);
  missing.apply({
    ...envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1),
    runId: "missing-cache",
  });
  missing.apply({
    ...envelope({ type: "assistant_started", step: 1 }, 2),
    runId: "missing-cache",
  });
  missing.apply({
    ...envelope({
      type: "usage",
      semantics: "final",
      usage: { inputTokens: 100, outputTokens: 10 },
    }, 3),
    runId: "missing-cache",
  });
  missing.apply({
    ...envelope({ type: "assistant_completed", finishReason: "stop" }, 4),
    runId: "missing-cache",
  });
  assert.deepEqual(missing.usage?.total, { inputTokens: 120, outputTokens: 15 });
  assert.equal(missing.usage?.latestCacheHitRate, undefined);

  const zero = new TuiModel(DEFAULT_TUI_LIMITS);
  zero.setUsageBaseline({
    inputTokens: 20,
    outputTokens: 5,
    cacheReadTokens: 80,
    cacheWriteTokens: 0,
    totalTokens: 105,
  }, 80);
  zero.apply({
    ...envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1),
    runId: "zero-cache",
  });
  zero.apply({
    ...envelope({ type: "assistant_started", step: 1 }, 2),
    runId: "zero-cache",
  });
  zero.apply({
    ...envelope({
      type: "usage",
      semantics: "final",
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 110,
      },
    }, 3),
    runId: "zero-cache",
  });
  assert.equal(zero.usage?.latestCacheHitRate, 80);
  zero.apply({
    ...envelope({ type: "assistant_completed", finishReason: "stop" }, 4),
    runId: "zero-cache",
  });
  assert.deepEqual(zero.usage?.total, {
    inputTokens: 120,
    outputTokens: 15,
    cacheReadTokens: 80,
    cacheWriteTokens: 0,
    totalTokens: 215,
  });
  assert.equal(zero.usage?.latestCacheHitRate, 0);
});

test("TUI calculates the latest cache percentage when a provider reports reads without writes", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply({
    ...envelope({ type: "run_started", provider: "google", model: "gemini-test" }, 1),
    runId: "read-only-cache",
  });
  model.apply({
    ...envelope({ type: "assistant_started", step: 1 }, 2),
    runId: "read-only-cache",
  });
  model.apply({
    ...envelope({
      type: "usage",
      semantics: "final",
      usage: {
        inputTokens: 200,
        outputTokens: 10,
        cacheReadTokens: 800,
        totalTokens: 1_010,
      },
    }, 3),
    runId: "read-only-cache",
  });
  model.apply({
    ...envelope({ type: "assistant_completed", finishReason: "stop" }, 4),
    runId: "read-only-cache",
  });

  assert.equal(model.usage?.latestCacheHitRate, 80);
});

test("TUI usage exposes the latest reported cache counters and clears them when the newest request omits them", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  const apply = (runId: string, sequence: number, event: Parameters<TuiModel["apply"]>[0]["event"]): void => {
    model.apply({ ...envelope(event, sequence), runId });
  };

  apply("initially-omitted-cache", 1, { type: "run_started", provider: "google", model: "gemini-test" });
  apply("initially-omitted-cache", 2, { type: "assistant_started", step: 1 });
  apply("initially-omitted-cache", 3, {
    type: "usage",
    semantics: "final",
    usage: { inputTokens: 100, outputTokens: 10 },
  });
  apply("initially-omitted-cache", 4, { type: "assistant_completed", finishReason: "stop" });
  apply("initially-omitted-cache", 5, { type: "run_completed", finishReason: "stop" });

  apply("reported-cache", 6, { type: "run_started", provider: "google", model: "gemini-test" });
  apply("reported-cache", 7, { type: "assistant_started", step: 1 });
  apply("reported-cache", 8, {
    type: "usage",
    semantics: "final",
    usage: { inputTokens: 200, outputTokens: 10, cacheReadTokens: 800 },
  });
  apply("reported-cache", 9, { type: "assistant_completed", finishReason: "stop" });
  apply("reported-cache", 10, { type: "run_completed", finishReason: "stop" });

  assert.equal(model.usage?.latestCacheReadTokens, 800);
  assert.equal(model.usage?.latestCacheWriteTokens, undefined);

  apply("omitted-cache", 11, { type: "run_started", provider: "google", model: "gemini-test" });
  apply("omitted-cache", 12, { type: "assistant_started", step: 1 });
  apply("omitted-cache", 13, {
    type: "usage",
    semantics: "final",
    usage: { inputTokens: 1_000, outputTokens: 10 },
  });
  apply("omitted-cache", 14, { type: "assistant_completed", finishReason: "stop" });

  assert.equal(model.usage?.latestCacheReadTokens, undefined);
  assert.equal(model.usage?.latestCacheWriteTokens, undefined);
});

test("successful metered requests without complete usage invalidate exact TUI totals", () => {
  const baseline = {
    inputTokens: 20,
    outputTokens: 5,
    cacheReadTokens: 80,
    cacheWriteTokens: 0,
    totalTokens: 105,
  };

  const assistant = new TuiModel(DEFAULT_TUI_LIMITS);
  assistant.setUsageBaseline(baseline, 80);
  assistant.apply({
    ...envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1),
    runId: "assistant-without-usage",
  });
  assistant.apply({
    ...envelope({ type: "assistant_started", step: 1 }, 2),
    runId: "assistant-without-usage",
  });
  assistant.apply({
    ...envelope({ type: "assistant_completed", finishReason: "stop" }, 3),
    runId: "assistant-without-usage",
  });
  assert.deepEqual(assistant.usage?.total, {});
  assert.deepEqual(assistant.usage?.reportedTotal, baseline);
  assert.equal(assistant.usage?.latestCacheHitRate, undefined);

  const incomplete = new TuiModel(DEFAULT_TUI_LIMITS);
  incomplete.setUsageBaseline(baseline, 80);
  incomplete.apply({
    ...envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1),
    runId: "incomplete-without-usage",
  });
  incomplete.apply({
    ...envelope({ type: "assistant_started", step: 1 }, 2),
    runId: "incomplete-without-usage",
  });
  incomplete.apply({
    ...envelope({ type: "assistant_completed", finishReason: "incomplete" }, 3),
    runId: "incomplete-without-usage",
  });
  assert.deepEqual(incomplete.usage?.total, {});
  assert.deepEqual(incomplete.usage?.reportedTotal, baseline);
  assert.equal(incomplete.usage?.latestCacheHitRate, undefined);

  const compaction = new TuiModel(DEFAULT_TUI_LIMITS);
  compaction.setUsageBaseline(baseline, 80);
  compaction.apply({
    ...envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1),
    runId: "compaction-without-usage",
  });
  compaction.apply({
    ...envelope({ type: "compaction_started", reason: "manual" }, 2),
    runId: "compaction-without-usage",
  });
  compaction.apply({
    ...envelope({
      type: "compaction_completed",
      summary: {
        id: "summary-without-usage",
        role: "assistant",
        content: [{ type: "text", text: "summary" }],
        purpose: "compaction",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      sourceMessageIds: ["old"],
      firstKeptMessageId: "kept",
      tokensBefore: 105,
      fromExtension: false,
    }, 3),
    runId: "compaction-without-usage",
  });
  assert.deepEqual(compaction.usage?.total, {});
  assert.equal(compaction.usage?.latestCacheHitRate, 80);

  const branch = new TuiModel(DEFAULT_TUI_LIMITS);
  branch.setUsageBaseline(baseline, 80);
  branch.apply({
    ...envelope({ type: "usage", semantics: "final", usage: {} }, 1),
    runId: "branch-without-usage",
  });
  branch.apply({
    ...envelope({
      type: "branch_summary_created",
      sourceBranch: "discarded",
      sourceEventIds: ["old"],
      summary: {
        id: "branch-summary-without-usage",
        role: "user",
        content: [{ type: "text", text: "summary" }],
        purpose: "compaction",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    }, 2),
    runId: "branch-without-usage",
  });
  assert.deepEqual(branch.usage?.total, {});
  assert.equal(branch.usage?.latestCacheHitRate, 80);
});

test("later complete usage keeps exact fields and lower-bounds fields omitted by an earlier request", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  const apply = (runId: string, sequence: number, event: EventEnvelope["event"]): void => model.apply({
    ...envelope(event, sequence),
    runId,
  });

  apply("partial-request", 1, { type: "run_started", provider: "fixture", model: "usage-model" });
  apply("partial-request", 2, { type: "assistant_started", step: 1 });
  apply("partial-request", 3, {
    type: "usage",
    semantics: "final",
    usage: { inputTokens: 20 },
  });
  apply("partial-request", 4, { type: "assistant_completed", finishReason: "stop" });
  apply("partial-request", 5, { type: "run_completed", finishReason: "stop" });

  apply("complete-request", 6, { type: "run_started", provider: "fixture", model: "usage-model" });
  apply("complete-request", 7, { type: "assistant_started", step: 1 });
  apply("complete-request", 8, {
    type: "usage",
    semantics: "final",
    usage: { inputTokens: 30, outputTokens: 5 },
  });
  apply("complete-request", 9, { type: "assistant_completed", finishReason: "stop" });

  assert.equal(model.usage?.total.inputTokens, 50);
  assert.equal(model.usage?.total.outputTokens, undefined);
  assert.equal(model.usage?.reportedTotal?.outputTokens, 5);
});

test("exact derived prompt totals retain independently reported cache lower bounds", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  const apply = (runId: string, sequence: number, event: EventEnvelope["event"]): void => model.apply({
    ...envelope(event, sequence),
    runId,
  });

  apply("reported-cache", 1, { type: "run_started", provider: "fixture", model: "usage-model" });
  apply("reported-cache", 2, { type: "assistant_started", step: 1 });
  apply("reported-cache", 3, {
    type: "usage",
    semantics: "final",
    usage: { outputTokens: 10, totalTokens: 100, cacheReadTokens: 80 },
  });
  apply("reported-cache", 4, { type: "assistant_completed", finishReason: "stop" });
  apply("reported-cache", 5, { type: "run_completed", finishReason: "stop" });

  apply("omitted-cache", 6, { type: "run_started", provider: "fixture", model: "usage-model" });
  apply("omitted-cache", 7, { type: "assistant_started", step: 1 });
  apply("omitted-cache", 8, {
    type: "usage",
    semantics: "final",
    usage: { outputTokens: 10, totalTokens: 100 },
  });
  apply("omitted-cache", 9, { type: "assistant_completed", finishReason: "stop" });

  assert.deepEqual(model.usage?.total, { outputTokens: 20, totalTokens: 200 });
  assert.deepEqual(model.usage?.reportedTotal, {
    outputTokens: 20,
    totalTokens: 200,
    cacheReadTokens: 80,
  });
  assert.equal(model.usage?.promptInputTokens, 180);
});

test("unmetered extension summaries preserve totals while explicit empty usage invalidates them", () => {
  const baseline = {
    inputTokens: 20,
    outputTokens: 5,
    cacheReadTokens: 80,
    cacheWriteTokens: 0,
    totalTokens: 105,
  };
  const compactionEvent = (usage?: NormalizedUsage) => ({
    type: "compaction_completed" as const,
    summary: {
      id: "extension-summary",
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "summary" }],
      purpose: "compaction" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    sourceMessageIds: ["old"],
    firstKeptMessageId: "kept",
    tokensBefore: 105,
    fromExtension: true,
    ...(usage === undefined ? {} : { usage }),
  });
  const branchEvent = (usage?: NormalizedUsage) => ({
    type: "branch_summary_created" as const,
    sourceBranch: "discarded",
    sourceEventIds: ["old"],
    summary: {
      id: "extension-branch-summary",
      role: "user" as const,
      content: [{ type: "text" as const, text: "summary" }],
      purpose: "compaction" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    ...(usage === undefined ? {} : { usage }),
  });

  for (const [name, event] of [
    ["compaction", compactionEvent()],
    ["branch", branchEvent()],
  ] as const) {
    const model = new TuiModel(DEFAULT_TUI_LIMITS);
    model.setUsageBaseline(baseline, 80);
    model.apply({ ...envelope(event, 1), runId: `unmetered-${name}` });
    assert.deepEqual(model.usage?.total, baseline);
    assert.equal(model.usage?.latestCacheHitRate, 80);
  }

  for (const [name, event] of [
    ["compaction", compactionEvent({})],
    ["branch", branchEvent({})],
  ] as const) {
    const model = new TuiModel(DEFAULT_TUI_LIMITS);
    model.setUsageBaseline(baseline, 80);
    model.apply({ ...envelope(event, 1), runId: `metered-${name}` });
    assert.deepEqual(model.usage?.total, {});
    assert.equal(model.usage?.latestCacheHitRate, 80);
  }
});

test("summary usage participates in exact totals without replacing the last normal-request cache rate", () => {
  const baseline = {
    inputTokens: 20,
    outputTokens: 5,
    cacheReadTokens: 80,
    cacheWriteTokens: 0,
    totalTokens: 105,
  };
  const summaryUsage = {
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 110,
  };
  const expected = {
    inputTokens: 120,
    outputTokens: 15,
    cacheReadTokens: 80,
    cacheWriteTokens: 0,
    totalTokens: 215,
  };

  const compaction = new TuiModel(DEFAULT_TUI_LIMITS);
  compaction.setUsageBaseline(baseline, 80);
  compaction.apply({
    ...envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1),
    runId: "compaction-with-usage",
  });
  compaction.apply({
    ...envelope({ type: "compaction_started", reason: "manual" }, 2),
    runId: "compaction-with-usage",
  });
  compaction.apply({
    ...envelope({
      type: "compaction_completed",
      summary: {
        id: "summary-with-usage",
        role: "assistant",
        content: [{ type: "text", text: "summary" }],
        purpose: "compaction",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      sourceMessageIds: ["old"],
      firstKeptMessageId: "kept",
      tokensBefore: 105,
      fromExtension: true,
      usage: summaryUsage,
    }, 3),
    runId: "compaction-with-usage",
  });
  assert.deepEqual(compaction.usage?.total, expected);
  assert.equal(compaction.usage?.latestCacheHitRate, 80);

  const branch = new TuiModel(DEFAULT_TUI_LIMITS);
  branch.setUsageBaseline(baseline, 80);
  branch.apply({
    ...envelope({
      type: "branch_summary_created",
      sourceBranch: "discarded",
      sourceEventIds: ["old"],
      summary: {
        id: "branch-summary-with-usage",
        role: "user",
        content: [{ type: "text", text: "summary" }],
        purpose: "compaction",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      usage: summaryUsage,
    }, 1),
    runId: "branch-with-usage",
  });
  assert.deepEqual(branch.usage?.total, expected);
  assert.equal(branch.usage?.latestCacheHitRate, 80);
});

test("TUI replaces cumulative usage within an attempt and aggregates retry attempts independently", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  const apply = (event: Parameters<TuiModel["apply"]>[0]["event"], sequence: number): void => {
    model.apply({ ...envelope(event, sequence), runId: "retried-request" });
  };
  apply({ type: "run_started", provider: "openai", model: "gpt-test" }, 1);
  apply({ type: "assistant_started", step: 1 }, 2);
  apply({
    type: "usage",
    semantics: "cumulative",
    usage: {
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 110,
    },
  }, 3);
  apply({
    type: "usage",
    semantics: "final",
    usage: {
      inputTokens: 120,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 140,
    },
  }, 4);
  apply({ type: "retry_attempt_started", attempt: 2, provider: "openai", model: "gpt-test", step: 1 }, 5);
  apply({
    type: "usage",
    semantics: "final",
    usage: {
      inputTokens: 30,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 35,
    },
  }, 6);
  apply({ type: "assistant_completed", finishReason: "stop" }, 7);
  apply({ type: "run_completed", finishReason: "stop" }, 8);

  assert.deepEqual(model.usage, {
    total: {
      inputTokens: 150,
      outputTokens: 25,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 175,
    },
    promptInputTokens: 150,
    latestCacheHitRate: 0,
  });
});

test("failed and cancelled assistant requests do not fabricate usage observations", () => {
  const baseline = {
    inputTokens: 20,
    outputTokens: 5,
    cacheReadTokens: 80,
    cacheWriteTokens: 0,
    totalTokens: 105,
  };
  for (const [finishReason, terminal] of [
    ["error", { type: "run_failed", error: { category: "internal", message: "failed" } }],
    ["cancelled", { type: "run_cancelled", reason: "cancelled" }],
  ] as const) {
    const model = new TuiModel(DEFAULT_TUI_LIMITS);
    model.setUsageBaseline(baseline, 80);
    const runId = `unsuccessful-${finishReason}`;
    model.apply({
      ...envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1),
      runId,
    });
    model.apply({ ...envelope({ type: "assistant_started", step: 1 }, 2), runId });
    model.apply({ ...envelope({ type: "assistant_completed", finishReason }, 3), runId });
    model.apply({ ...envelope(terminal, 4), runId });
    assert.deepEqual(model.usage?.total, baseline);
    assert.equal(model.usage?.latestCacheHitRate, 80);
  }
});

test("cache diagnostics reject requests with incomplete cache telemetry", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.setShowCacheMissNotices(true);
  cacheRun(model, {
    id: "incomplete-cache-baseline",
    sequence: 1,
    usage: { cacheReadTokens: 0, cacheWriteTokens: 30_000 },
  });
  cacheRun(model, {
    id: "after-incomplete-cache",
    sequence: 10,
    usage: { inputTokens: 31_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  assert.equal(model.entries.some((entry) => entry.title === "Cache reuse estimate"), false);
});

test("compaction receipts report cache efficiency without inventing provider counters", () => {
  assert.equal(
    formatCompactionUsageReceipt({
      inputTokens: 2_930,
      cacheReadTokens: 35_584,
      cacheWriteTokens: 0,
      outputTokens: 3_449,
    }),
    "summary request · prompt 38,514 · cache read 35,584 (92.4% of this request) · cache write 0 · output 3,449",
  );
  assert.equal(
    formatCompactionUsageReceipt({ inputTokens: 12_000, outputTokens: 800 }),
    "summary request · prompt not reported · cache read telemetry unavailable for summary · cache write telemetry unavailable for summary · output 800",
  );
  assert.equal(
    formatCompactionUsageReceipt({ inputTokens: 0, cacheReadTokens: 0 }),
    "summary request · prompt not reported · cache read 0 · cache write telemetry unavailable for summary · output not reported",
  );
});

test("compaction cards keep request metrics out of the compact transcript label", () => {
  const usage = {
    inputTokens: 29_092,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 1_359,
  };
  const receipt = "summary request · prompt 29,092 · cache read 0 (0.0% of this request) · cache write 0 · output 1,359";
  const durable = new TuiModel(DEFAULT_TUI_LIMITS);
  durable.applySessionSummary({
    type: "session_summary",
    id: "durable-compaction",
    summaryType: "compaction",
    text: "Retained summary body",
    tokensBefore: 230_607,
    usage,
  });
  assert.equal(durable.entries[0]?.compactText, "230,607 tokens before");
  assert.equal(durable.entries[0]?.summary, receipt);
  assert.equal(durable.entries[0]?.text, "Retained summary body");

  const live = new TuiModel(DEFAULT_TUI_LIMITS);
  live.apply(envelope({ type: "compaction_started", reason: "manual" }, 1));
  live.apply(envelope({
    type: "compaction_completed",
    summary: {
      id: "live-compaction",
      role: "assistant",
      content: [{ type: "text", text: "Retained summary body" }],
      purpose: "compaction",
      createdAt: "2026-08-08T00:00:00.000Z",
    },
    sourceMessageIds: ["one", "two"],
    firstKeptMessageId: "two",
    tokensBefore: 230_607,
    fromExtension: false,
    usage,
  }, 2));
  assert.equal(live.entries[0]?.compactText, "230,607 tokens before");
  assert.equal(live.entries[0]?.summary, receipt);
  assert.equal(live.entries[0]?.text, "Retained summary body");
});

test("live and resumed compactions retain the same bounded safe details", () => {
  const retained = `summary head\u001b[31m\n${"detail ".repeat(24_000)}summary tail`;
  const durable = new TuiModel(DEFAULT_TUI_LIMITS);
  durable.applySessionSummary({
    type: "session_summary",
    id: "durable-bounded-compaction",
    summaryType: "compaction",
    text: retained,
    tokensBefore: 230_607,
    usage: { inputTokens: 29_092, outputTokens: 1_359 },
  });

  const live = new TuiModel(DEFAULT_TUI_LIMITS);
  live.apply(envelope({ type: "compaction_started", reason: "manual" }, 1));
  live.apply(envelope({
    type: "compaction_completed",
    summary: {
      id: "live-bounded-compaction",
      role: "assistant",
      content: [{ type: "text", text: retained }],
      purpose: "compaction",
      createdAt: "2026-08-08T00:00:00.000Z",
    },
    sourceMessageIds: ["one", "two"],
    firstKeptMessageId: "two",
    tokensBefore: 230_607,
    fromExtension: false,
    usage: { inputTokens: 29_092, outputTokens: 1_359 },
  }, 2));

  const resumedEntry = durable.entries[0];
  const liveEntry = live.entries[0];
  assert.equal(liveEntry?.compactText, resumedEntry?.compactText);
  assert.equal(liveEntry?.summary, resumedEntry?.summary);
  assert.equal(liveEntry?.text, resumedEntry?.text);
  assert.match(liveEntry?.text ?? "", /^summary head/u);
  assert.doesNotMatch(liveEntry?.text ?? "", /\u001b/u);
  assert.ok(Buffer.byteLength(liveEntry?.text ?? "", "utf8") <= 128 * 1024);
});

test("cache miss notices are opt-in, bounded, and reset after compaction", () => {
  const hidden = new TuiModel(DEFAULT_TUI_LIMITS);
  cacheRun(hidden, {
    id: "hidden-one",
    sequence: 1,
    usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 25_000 },
  });
  cacheRun(hidden, {
    id: "hidden-two",
    sequence: 10,
    usage: { inputTokens: 25_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  assert.equal(hidden.entries.some((entry) => entry.title === "Cache reuse estimate"), false);

  const visible = new TuiModel(DEFAULT_TUI_LIMITS);
  visible.setShowCacheMissNotices(true);
  cacheRun(visible, {
    id: "visible-one",
    sequence: 1,
    usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 25_000 },
  });
  cacheRun(visible, {
    id: "visible-two",
    sequence: 10,
    usage: { inputTokens: 25_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  const visibleNotice = visible.entries.find((entry) => entry.title === "Cache reuse estimate");
  assert.equal(visibleNotice?.kind, "status");
  assert.match(visibleNotice?.text ?? "", /read 0\.0% of its prompt from cache/u);
  assert.match(visibleNotice?.text ?? "", /up to 25,000 prior-prompt tokens were not cache-read/u);
  assert.match(visibleNotice?.text ?? "", /Later requests may recover/u);
  assert.doesNotMatch(visibleNotice?.text ?? "", /billed/u);

  const costOnly = new TuiModel(DEFAULT_TUI_LIMITS, () => 0.3);
  costOnly.setShowCacheMissNotices(true);
  cacheRun(costOnly, {
    id: "cost-one",
    sequence: 1,
    usage: {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 19_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0.19, total: 0.19 },
    },
  });
  cacheRun(costOnly, {
    id: "cost-two",
    sequence: 10,
    usage: {
      inputTokens: 19_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: { input: 0.19, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.19 },
    },
  });
  assert.match(
    costOnly.entries.find((entry) => entry.title === "Cache reuse estimate")?.text ?? "",
    /up to 19,000 prior-prompt tokens were not cache-read · estimated added cost \$0\.18/u,
  );

  const reset = new TuiModel(DEFAULT_TUI_LIMITS);
  reset.setShowCacheMissNotices(true);
  cacheRun(reset, {
    id: "reset-one",
    sequence: 1,
    usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 25_000 },
  });
  reset.apply(envelope({
    type: "compaction_completed",
    summary: {
      id: "cache-summary",
      role: "user",
      content: [{ type: "text", text: "summary" }],
      createdAt: "2026-01-01T00:04:00.000Z",
      purpose: "compaction",
    },
    sourceMessageIds: ["older"],
    firstKeptMessageId: "newer",
    tokensBefore: 25_000,
    fromExtension: false,
  }, 4));
  cacheRun(reset, {
    id: "reset-two",
    sequence: 10,
    usage: { inputTokens: 25_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  assert.equal(reset.entries.some((entry) => entry.title === "Cache reuse estimate"), false);

  const branched = new TuiModel(DEFAULT_TUI_LIMITS);
  branched.setShowCacheMissNotices(true);
  cacheRun(branched, {
    id: "branch-one",
    sequence: 1,
    usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 25_000 },
  });
  branched.apply(envelope({
    type: "branch_summary_created",
    sourceBranch: "discarded",
    sourceEventIds: ["older"],
    summary: {
      id: "branch-cache-summary",
      role: "user",
      content: [{ type: "text", text: "branch summary" }],
      createdAt: "2026-01-01T00:00:05.000Z",
      purpose: "compaction",
    },
  }, 8));
  cacheRun(branched, {
    id: "branch-two",
    sequence: 10,
    usage: { inputTokens: 25_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  assert.equal(branched.entries.some((entry) => entry.title === "Cache reuse estimate"), false);
});

test("cache diagnostics inspect every completed model request in a tool loop", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.setShowCacheMissNotices(true);
  const apply = (event: Parameters<TuiModel["apply"]>[0]["event"], sequence: number): void => {
    model.apply({ ...envelope(event, sequence), runId: "tool-loop" });
  };
  apply({ type: "run_started", provider: "anthropic", model: "claude-test" }, 1);
  apply({ type: "assistant_started", step: 1 }, 2);
  apply({
    type: "message_appended",
    message: {
      id: "tool-loop-first",
      role: "assistant",
      content: [{ type: "tool_call", callId: "inspect", name: "read", arguments: { path: "a.ts" } }],
      createdAt: "2026-01-01T00:00:10.000Z",
      provider: "anthropic",
      model: "claude-test",
      usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 30_000 },
    },
  }, 3);
  apply({ type: "assistant_completed", finishReason: "tool_calls" }, 4);
  apply({ type: "assistant_started", step: 2 }, 5);
  apply({
    type: "message_appended",
    message: {
      id: "tool-loop-second",
      role: "assistant",
      content: [{ type: "tool_call", callId: "verify", name: "read", arguments: { path: "b.ts" } }],
      createdAt: "2026-01-01T00:00:20.000Z",
      provider: "anthropic",
      model: "claude-test",
      usage: { inputTokens: 0, cacheReadTokens: 30_000, cacheWriteTokens: 2_000 },
    },
  }, 6);
  apply({ type: "assistant_completed", finishReason: "tool_calls" }, 7);
  apply({ type: "assistant_started", step: 3 }, 8);
  apply({
    type: "message_appended",
    message: {
      id: "tool-loop-third",
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      createdAt: "2026-01-01T00:00:30.000Z",
      provider: "anthropic",
      model: "claude-test",
      usage: { inputTokens: 33_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  }, 9);
  apply({ type: "assistant_completed", finishReason: "stop" }, 10);

  assert.match(model.entries.find((entry) => entry.title === "Cache reuse estimate")?.text ?? "", /up to 32,000 prior-prompt tokens were not cache-read/u);
});

test("cache diagnostics reset the comparison epoch when the routed model changes", () => {
  const pricedModels: string[] = [];
  const model = new TuiModel(DEFAULT_TUI_LIMITS, (_provider, pricedModel) => {
    pricedModels.push(pricedModel);
    return 0.1;
  });
  model.setShowCacheMissNotices(true);
  cacheRun(model, {
    id: "routed-first",
    sequence: 1,
    provider: "openai",
    model: "requested-model",
    responseModel: "provider-model-a",
    usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 30_000 },
  });
  cacheRun(model, {
    id: "routed-second",
    sequence: 10,
    provider: "openai",
    model: "requested-model",
    responseModel: "provider-model-b",
    usage: { inputTokens: 31_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });

  assert.equal(model.entries.some((entry) => entry.title === "Cache reuse estimate"), false);
  assert.deepEqual(pricedModels, ["requested-model", "requested-model"]);
});

test("cache diagnostics reset the comparison epoch when the provider changes", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.setShowCacheMissNotices(true);
  cacheRun(model, {
    id: "provider-first",
    sequence: 1,
    provider: "provider-a",
    model: "shared-model",
    usage: { cacheWriteTokens: 30_000 },
  });
  cacheRun(model, {
    id: "provider-second",
    sequence: 10,
    provider: "provider-b",
    model: "shared-model",
    usage: { inputTokens: 31_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  assert.equal(model.entries.some((entry) => entry.title === "Cache reuse estimate"), false);
});

test("cache diagnostics reset TUI comparisons across instruction, tool, and API boundaries", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.setShowCacheMissNotices(true);
  cacheRun(model, {
    id: "boundary-first",
    sequence: 1,
    api: "openai-responses",
    instructionFingerprint: "instructions-a",
    toolFingerprint: "tools-a",
    usage: { inputTokens: 30_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  cacheRun(model, {
    id: "boundary-instructions",
    sequence: 10,
    api: "openai-responses",
    instructionFingerprint: "instructions-b",
    toolFingerprint: "tools-a",
    usage: { inputTokens: 31_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  cacheRun(model, {
    id: "boundary-tools",
    sequence: 20,
    api: "openai-responses",
    instructionFingerprint: "instructions-b",
    toolFingerprint: "tools-b",
    usage: { inputTokens: 32_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  cacheRun(model, {
    id: "boundary-api",
    sequence: 30,
    api: "anthropic-messages",
    instructionFingerprint: "instructions-b",
    toolFingerprint: "tools-b",
    usage: { inputTokens: 33_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  assert.equal(model.entries.some((entry) => entry.title === "Cache reuse estimate"), false);

  cacheRun(model, {
    id: "boundary-same",
    sequence: 40,
    api: "anthropic-messages",
    instructionFingerprint: "instructions-b",
    toolFingerprint: "tools-b",
    usage: { inputTokens: 34_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  assert.match(
    model.entries.find((entry) => entry.title === "Cache reuse estimate")?.text ?? "",
    /up to 33,000 prior-prompt tokens were not cache-read/u,
  );
});

test("missing request usage and failed or cancelled runs clear cache comparisons", () => {
  const missing = new TuiModel(DEFAULT_TUI_LIMITS);
  missing.setShowCacheMissNotices(true);
  cacheRun(missing, {
    id: "baseline",
    sequence: 1,
    usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 30_000 },
  });
  cacheRun(missing, { id: "missing", sequence: 10 });
  cacheRun(missing, {
    id: "after-missing",
    sequence: 20,
    usage: { inputTokens: 31_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  assert.equal(missing.entries.some((entry) => entry.title === "Cache reuse estimate"), false);

  const failed = new TuiModel(DEFAULT_TUI_LIMITS);
  failed.setShowCacheMissNotices(true);
  cacheRun(failed, {
    id: "before-failure",
    sequence: 30,
    usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 30_000 },
  });
  failed.apply({
    ...envelope({ type: "run_started", provider: "anthropic", model: "claude-test" }, 40),
    runId: "failed",
  });
  failed.apply({
    ...envelope({ type: "run_failed", error: { category: "internal", message: "failed" } }, 41),
    runId: "failed",
  });
  cacheRun(failed, {
    id: "after-failure",
    sequence: 50,
    usage: { inputTokens: 31_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  assert.equal(failed.entries.some((entry) => entry.title === "Cache reuse estimate"), false);

  const cancelled = new TuiModel(DEFAULT_TUI_LIMITS);
  cancelled.setShowCacheMissNotices(true);
  cacheRun(cancelled, {
    id: "before-cancel",
    sequence: 60,
    usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 30_000 },
  });
  cancelled.apply({
    ...envelope({ type: "run_started", provider: "anthropic", model: "claude-test" }, 70),
    runId: "cancelled",
  });
  cancelled.apply({
    ...envelope({ type: "run_cancelled", reason: "cancelled" }, 71),
    runId: "cancelled",
  });
  cacheRun(cancelled, {
    id: "after-cancel",
    sequence: 80,
    usage: { inputTokens: 31_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  assert.equal(cancelled.entries.some((entry) => entry.title === "Cache reuse estimate"), false);
});

test("session replay rebuilds cache comparisons and resets them at durable summaries", () => {
  const assistant = (
    id: string,
    sequence: number,
    usage: { inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number },
  ) => envelope({
    type: "message_appended",
    message: {
      id,
      role: "assistant",
      content: [{ type: "text", text: id }],
      createdAt: `2026-01-01T00:00:${String(sequence).padStart(2, "0")}.000Z`,
      provider: "anthropic",
      model: "claude-test",
      usage,
    },
  }, sequence);

  const resumed = new TuiModel(DEFAULT_TUI_LIMITS);
  resumed.setShowCacheMissNotices(true);
  resumed.applyAll([
    assistant("resume-write", 1, { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 30_000 }),
    assistant("resume-miss", 2, { inputTokens: 31_000, cacheReadTokens: 0, cacheWriteTokens: 0 }),
  ]);
  assert.equal(resumed.entries.filter((entry) => entry.title === "Cache reuse estimate").length, 1);

  const compacted = new TuiModel(DEFAULT_TUI_LIMITS);
  compacted.setShowCacheMissNotices(true);
  compacted.applyAll([
    assistant("before-summary", 1, { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 30_000 }),
    {
      type: "session_summary",
      id: "durable-summary",
      summaryType: "compaction",
      text: "Retained checkpoint",
      tokensBefore: 30_000,
    },
    assistant("after-summary", 2, { inputTokens: 31_000, cacheReadTokens: 0, cacheWriteTokens: 0 }),
  ]);
  assert.equal(compacted.entries.some((entry) => entry.title === "Cache reuse estimate"), false);
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
  model.apply(envelope({ type: "tool_started", callId: "call_1", name: "write", input: {}, index: 0, recoveryMode: "never_repeat" }, 2));
  model.apply(envelope({
    type: "tool_in_doubt",
    callId: "call_1",
    name: "write",
    index: 0,
    reason: "The process stopped before completion was recorded.",
  }, 3));
  assert.equal(model.entries[0]?.status, "in_doubt");
  assert.match(model.entries[0]?.text ?? "", /before completion/u);
  assert.equal(model.entries[0]?.expanded, false);
});

test("reasoning summaries stream visibly, stay open on completion, and retain elapsed duration", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply({
    ...envelope({ type: "reasoning_started", part: 0, visibility: "summary" }, 1),
    timestamp: "2026-01-01T00:00:01.000Z",
  });
  model.apply({
    ...envelope({ type: "reasoning_delta", text: "first reasoning summary", part: 0, visibility: "summary" }, 2),
    timestamp: "2026-01-01T00:00:02.000Z",
  });
  assert.equal(model.entries[0]?.streaming, true);
  assert.equal(model.entries[0]?.reasoningStartedAt, Date.parse("2026-01-01T00:00:01.000Z"));
  model.apply({
    ...envelope({
      type: "reasoning_completed",
      text: "first reasoning summary",
      part: 0,
      visibility: "summary",
    }, 3),
    timestamp: "2026-01-01T00:00:05.200Z",
  });
  assert.equal(model.entries[0]?.streaming, false);
  assert.equal(model.entries[0]?.expanded, true);
  assert.equal(model.entries[0]?.reasoningDurationMs, 4_200);

  assert.equal(model.toggleReasoning(), true);
  assert.equal(model.entries[0]?.expanded, false);
  assert.equal(model.toggleReasoning(), true);
  assert.equal(model.entries[0]?.expanded, true);

  // New live runs follow the current controller-local expansion preference.
  model.apply(envelope({ type: "reasoning_delta", text: "future reasoning summary", part: 1, visibility: "summary" }, 4));
  assert.equal(model.entries[1]?.streaming, true);
  assert.equal(model.entries[1]?.expanded, true);

  // Committed (non-streaming) reasoning from a replayed message stays visible.
  const replayed = new TuiModel(DEFAULT_TUI_LIMITS);
  replayed.apply(envelope({
    type: "message_appended",
    message: {
      id: "committed-reasoning",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "committed summary", visibility: "summary" },
        { type: "text", text: "answer" },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 5));
  assert.equal(replayed.entries[0]?.expanded, true);
});

test("terminal run states settle an unfinished reasoning stream", () => {
  for (const state of ["completed", "failed", "cancelled"] as const) {
    const model = new TuiModel(DEFAULT_TUI_LIMITS);
    model.apply({
      ...envelope({ type: "reasoning_delta", text: state, part: 0, visibility: "summary" }, 1),
      timestamp: "2026-01-01T00:00:01.000Z",
    });
    model.apply({
      ...envelope({ type: "run_state", state }, 2),
      timestamp: "2026-01-01T00:00:03.000Z",
    });
    assert.equal(model.entries[0]?.streaming, false);
    assert.equal(model.entries[0]?.expanded, true);
    assert.equal(model.entries[0]?.reasoningDurationMs, 2_000);

    const empty = new TuiModel(DEFAULT_TUI_LIMITS);
    empty.apply(envelope({ type: "reasoning_started", part: 0, visibility: "summary" }, 1));
    empty.apply(envelope({ type: "run_state", state }, 2));
    assert.equal(empty.entries.length, 0);
  }
});

test("empty completed reasoning does not leave an empty transcript card", () => {
  const empty = new TuiModel(DEFAULT_TUI_LIMITS);
  empty.apply(envelope({ type: "reasoning_started", part: 0, visibility: "summary" }, 1));
  empty.apply(envelope({
    type: "reasoning_completed",
    text: "",
    part: 0,
    visibility: "summary",
  }, 2));
  assert.equal(empty.entries.length, 0);

  const accumulated = new TuiModel(DEFAULT_TUI_LIMITS);
  accumulated.apply(envelope({
    type: "reasoning_delta",
    text: "retained public summary",
    part: 0,
    visibility: "summary",
  }, 1));
  accumulated.apply(envelope({
    type: "reasoning_completed",
    text: "",
    part: 0,
    visibility: "summary",
  }, 2));
  assert.equal(accumulated.entries[0]?.text, "retained public summary");
  assert.equal(accumulated.entries[0]?.streaming, false);
});

test("reasoning toggle collapses a live block and preserves it through completion", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  assert.equal(model.toggleReasoning(), false);
  model.apply(envelope({ type: "reasoning_started", part: 0, visibility: "summary" }, 1));
  assert.equal(model.entries[0]?.expanded, true);
  assert.equal(model.toggleReasoning(), true);
  assert.equal(model.entries[0]?.expanded, false);
  model.apply(envelope({ type: "reasoning_delta", text: "live", part: 0, visibility: "summary" }, 2));
  assert.equal(model.entries[0]?.streaming, true);
  assert.equal(model.entries[0]?.expanded, false);
  model.apply(envelope({
    type: "reasoning_completed",
    text: "live",
    part: 0,
    visibility: "summary",
  }, 3));
  assert.equal(model.entries[0]?.streaming, false);
  assert.equal(model.entries[0]?.expanded, false);
  model.apply(envelope({
    type: "message_appended",
    message: {
      id: "durable-reasoning",
      role: "assistant",
      content: [{ type: "thinking", thinking: "live", visibility: "summary" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 4));
  assert.equal(model.entries[0]?.expanded, false);
  assert.equal(model.toggleReasoning(), true);
  assert.equal(model.entries[0]?.expanded, true);
});

test("reasoning toggle applies to every public reasoning block including the live block", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  for (let part = 0; part < 3; part += 1) {
    model.apply(envelope({
      type: "reasoning_completed",
      text: `reasoning ${part}`,
      part,
      visibility: "summary",
    }, part + 1));
  }
  model.apply(envelope({
    type: "reasoning_delta",
    text: "still streaming",
    part: 3,
    visibility: "summary",
  }, 4));

  assert.equal(model.toggleReasoning(), true);
  assert.deepEqual(model.entries.map((entry) => entry.expanded), [false, false, false, false]);
  model.apply(envelope({
    type: "reasoning_started",
    part: 4,
    visibility: "summary",
  }, 5));
  assert.equal(model.entries[4]?.expanded, false);
  assert.equal(model.toggleReasoning(), true);
  assert.deepEqual(model.entries.map((entry) => entry.expanded), [true, true, true, true, true]);
});

test("completed narratives place trailing public reasoning before the final answer", () => {
  const message = {
    id: "interleaved-assistant",
    role: "assistant" as const,
    content: [
      { type: "thinking" as const, thinking: "reasoning before", visibility: "summary" as const },
      { type: "text" as const, text: "final answer" },
      { type: "thinking" as const, thinking: "reasoning after", visibility: "summary" as const },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const replay = new TuiModel(DEFAULT_TUI_LIMITS);
  replay.apply(envelope({ type: "message_appended", message }, 10));
  assert.deepEqual(replay.entries.map((entry) => [entry.kind, entry.text]), [
    ["reasoning", "reasoning before"],
    ["reasoning", "reasoning after"],
    ["assistant", "final answer"],
  ]);

  const streaming = new TuiModel(DEFAULT_TUI_LIMITS);
  streaming.apply(envelope({ type: "assistant_started", step: 1 }, 11));
  streaming.apply(envelope({ type: "reasoning_delta", part: 0, text: "reasoning before", visibility: "summary" }, 12));
  streaming.apply(envelope({ type: "text_delta", part: 0, text: "final answer" }, 13));
  streaming.apply(envelope({ type: "reasoning_delta", part: 1, text: "reasoning after", visibility: "summary" }, 14));
  streaming.apply(envelope({ type: "reasoning_delta", part: 3, text: "omitted live reasoning", visibility: "summary" }, 15));
  assert.deepEqual(streaming.entries.map((entry) => [entry.kind, entry.text]), [
    ["reasoning", "reasoning before"],
    ["reasoning", "reasoning after"],
    ["reasoning", "omitted live reasoning"],
    ["assistant", "final answer"],
  ]);

  streaming.apply(envelope({ type: "message_appended", message }, 16));
  streaming.apply(envelope({ type: "assistant_completed", finishReason: "stop" }, 17));
  assert.deepEqual(streaming.entries.map((entry) => [entry.kind, entry.text]), [
    ["reasoning", "reasoning before"],
    ["reasoning", "reasoning after"],
    ["assistant", "final answer"],
  ]);
  assert.deepEqual(streaming.committableEntries(), streaming.entries);
});

test("live reasoning preserves an existing tool boundary", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({ type: "assistant_started", step: 1 }, 1));
  model.apply(envelope({ type: "text_delta", part: 0, text: "I will inspect the file." }, 2));
  model.apply(envelope({ type: "tool_call_started", index: 0, id: "read-1", name: "read" }, 3));
  model.apply(envelope({ type: "text_delta", part: 1, text: "The read is queued." }, 4));
  model.apply(envelope({ type: "reasoning_delta", part: 0, text: "Waiting for the result.", visibility: "summary" }, 5));

  assert.deepEqual(model.entries.map((entry) => [entry.kind, entry.text]), [
    ["assistant", "I will inspect the file."],
    ["tool", ""],
    ["reasoning", "Waiting for the result."],
    ["assistant", "The read is queued."],
  ]);
  assert.ok(model.entries.filter((entry) => entry.kind === "assistant").every((entry) => entry.hasToolCalls === true));
});

test("assistant messages with tools keep trailing public reasoning above the final answer", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({
    type: "message_appended",
    message: {
      id: "assistant-tool-chronology",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan the read", visibility: "summary" },
        { type: "text", text: "I will inspect the file." },
        { type: "tool_call", callId: "chronology-read", name: "read", arguments: { path: "src/main.ts" } },
        { type: "text", text: "The read is queued." },
        { type: "thinking", thinking: "wait for the result", visibility: "summary" },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 1));

  assert.deepEqual(model.entries.map((entry) => [entry.kind, entry.text, entry.callId]), [
    ["reasoning", "plan the read", undefined],
    ["assistant", "I will inspect the file.", undefined],
    ["tool", "", "chronology-read"],
    ["reasoning", "wait for the result", undefined],
    ["assistant", "The read is queued.", undefined],
  ]);
  assert.ok(model.entries.filter((entry) => entry.kind === "assistant").every((entry) => entry.hasToolCalls === true));
});

test("global tool expansion keeps extension details and durable summaries aligned", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.applySessionEntry({
    type: "custom",
    id: "extension-entry",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "fixture",
    data: { value: true },
  });
  model.applySessionEntry({
    type: "custom_message",
    id: "extension-message",
    parentId: "extension-entry",
    timestamp: "2026-01-01T00:00:01.000Z",
    customType: "fixture-message",
    content: "details",
    display: true,
  });
  model.applySessionSummary({
    type: "session_summary",
    id: "compaction-summary",
    summaryType: "compaction",
    text: "Retained compaction details",
    tokensBefore: 12_345,
  });
  model.applySessionSummary({
    type: "session_summary",
    id: "branch-summary",
    summaryType: "branch_summary",
    text: "Retained branch details",
  });

  assert.deepEqual(model.entries.map((entry) => entry.expanded), [false, false, false, false]);
  assert.equal(model.toggleTool(), true);
  assert.deepEqual(model.entries.map((entry) => entry.expanded), [true, true, true, true]);
  assert.equal(model.toggleTool(), true);
  assert.deepEqual(model.entries.map((entry) => entry.expanded), [false, false, false, false]);
});

test("provider traces stay hidden while explicit reasoning summaries replay", () => {
  const live = new TuiModel(DEFAULT_TUI_LIMITS);
  live.apply(envelope({
    type: "reasoning_delta",
    text: "provider planning",
    part: 0,
    visibility: "provider_trace",
  }, 1));
  assert.equal(live.entries.length, 0);
  live.apply(envelope({
    type: "reasoning_completed",
    text: "provider planning",
    part: 0,
    visibility: "provider_trace",
    redacted: true,
  }, 2));
  assert.equal(live.entries.length, 0);
  live.apply(envelope({
    type: "reasoning_delta",
    text: "safe provider summary",
    part: 1,
    visibility: "provider_trace",
  }, 3));
  assert.equal(live.entries.length, 0);
  live.apply(envelope({
    type: "reasoning_completed",
    text: "safe provider summary",
    part: 1,
    visibility: "provider_trace",
  }, 4));
  assert.equal(live.entries.length, 0);
  live.apply(envelope({
    type: "reasoning_completed",
    text: "safe summary",
    part: 2,
    visibility: "summary",
  }, 5));
  assert.equal(live.entries[0]?.text, "safe summary");

  const replay = new TuiModel(DEFAULT_TUI_LIMITS);
  replay.apply(envelope({
    type: "message_appended",
    message: {
      id: "assistant-replay",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "durable planning", visibility: "provider_trace" },
        { type: "thinking", thinking: "durable summary", visibility: "summary" },
        { type: "text", text: "durable answer" },
      ],
      createdAt: "2026-07-28T00:00:00.000Z",
    },
  }, 6));
  assert.deepEqual(replay.entries.map((entry) => [entry.kind, entry.text]), [
    ["reasoning", "durable summary"],
    ["assistant", "durable answer"],
  ]);

  const bounded = new TuiModel({ ...DEFAULT_TUI_LIMITS, maxTranscriptEntries: 1 });
  const reasoningOnly = envelope({
    type: "message_appended",
    message: {
      id: "reasoning-only",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "first durable thought", visibility: "provider_trace" },
        { type: "thinking", thinking: "second durable thought", visibility: "provider_trace" },
      ],
      createdAt: "2026-07-28T00:00:00.000Z",
    },
  }, 7);
  bounded.apply(reasoningOnly);
  assert.equal(bounded.entries.length, 0);
  bounded.addLocal("status", "evict the reasoning row");
  bounded.apply(reasoningOnly);
  assert.equal(bounded.entries[0]?.text, "evict the reasoning row");
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
    expanded: false,
    expandable: true,
    card: "branch_summary",
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

test("a new model turn clears transient local status rows but retains warnings and errors", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.applySessionSummary({
    type: "session_summary",
    id: "retained-compaction",
    summaryType: "compaction",
    text: "Retained context summary",
    tokensBefore: 12_345,
  });
  model.addLocal("status", "Exported session.html");
  model.addLocal("status", "Connected provider");
  model.addLocal("warning", "Review this warning");
  model.addLocal("error", "Resolve this error");

  model.apply(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));

  assert.deepEqual(model.entries.map((entry) => entry.text), [
    "Retained context summary",
    "Review this warning",
    "Resolve this error",
  ]);
});

test("retry attempts and compaction failures remain visible in the transcript", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({
    type: "retry_scheduled",
    attempt: 2,
    delayMs: 500,
    category: "network",
    phase: "model",
  }, 1));
  model.apply(envelope({
    type: "retry_attempt_started",
    attempt: 2,
    provider: "openai",
    model: "gpt-test",
    step: 1,
  }, 2));
  assert.equal(model.entries.length, 1);
  assert.match(model.entries[0]?.text ?? "", /Attempt 2 started/u);
  assert.equal(model.context.activity?.phase, "Retry attempt 2");

  model.apply(envelope({ type: "compaction_started", reason: "threshold" }, 3));
  model.apply(envelope({
    type: "compaction_failed",
    reason: "threshold",
    aborted: false,
    willRetry: false,
    errorMessage: "summary service unavailable",
  }, 4));
  const compaction = model.entries.find((entry) => entry.title === "Compaction failed");
  assert.equal(compaction?.kind, "error");
  assert.equal(compaction?.status, "failed");
  assert.equal(compaction?.text, "summary service unavailable");
});

test("TUI exposes the complete branch-summary retry lifecycle", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);

  model.apply(envelope({
    type: "summarization_retry_scheduled",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 2_000,
    errorMessage: "connection reset",
  }, 1));
  assert.equal(model.context.activity?.phase, "Retrying branch summary");
  assert.equal(model.context.activity?.attempt, 1);
  assert.ok((model.context.activity?.retryAt ?? 0) > Date.now());
  assert.match(model.entries.at(-1)?.text ?? "", /connection reset/u);

  model.apply(envelope({ type: "summarization_retry_attempt_start", source: "branchSummary" }, 2));
  assert.equal(model.context.activity?.phase, "Summarizing abandoned branch");
  assert.equal(model.context.activity?.retryAt, undefined);

  model.apply(envelope({ type: "summarization_retry_finished" }, 3));
  assert.equal(model.context.active, false);
  assert.equal(model.context.activity, undefined);
});

test("TUI keeps an active compaction cancellable after its summary retry finishes", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);

  model.apply(envelope({ type: "compaction_started", reason: "threshold" }, 1));
  model.apply(envelope({
    type: "summarization_retry_scheduled",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 2_000,
    errorMessage: "connection reset",
  }, 2));
  assert.equal(model.entries.at(-1)?.title, "Compaction retry");
  assert.equal(model.context.activity?.phase, "Retrying compaction");
  const entriesAfterSummaryRetry = model.entries.length;
  model.apply(envelope({
    type: "retry_scheduled",
    attempt: 2,
    maxAttempts: 3,
    delayMs: 2_000,
    category: "network",
    phase: "compaction",
  }, 3));
  assert.equal(model.entries.length, entriesAfterSummaryRetry);
  assert.equal(model.context.activity?.phase, "Retrying compaction");

  model.apply(envelope({
    type: "summarization_retry_attempt_start",
    source: "compaction",
    reason: "threshold",
  }, 4));
  model.apply(envelope({ type: "summarization_retry_finished" }, 5));
  assert.equal(model.context.active, true);
  assert.equal(model.context.activity?.phase, "Compacting context");
  assert.equal(model.context.activity?.cancellable, true);

  model.apply(envelope({
    type: "compaction_completed",
    summary: {
      id: "summary",
      role: "user",
      content: [{ type: "text", text: "summary" }],
      createdAt: "2026-07-22T00:00:00.000Z",
      purpose: "compaction",
    },
    sourceMessageIds: ["older"],
    firstKeptMessageId: "newer",
    tokensBefore: 1_000,
    fromExtension: false,
  }, 6));
  assert.equal(model.context.activity?.phase, "Continuing after compaction");
});
