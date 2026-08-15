import type { EventEnvelope, RuntimeEvent } from "../../src/core/events.js";
import { TuiController } from "../../src/tui/controller.js";

const terminal = new TuiController({ handleSignals: false });
let sequence = 0;

function render(event: RuntimeEvent): void {
  sequence += 1;
  terminal.render({
    eventId: `evt_${sequence}`,
    threadId: "thr_live_stream",
    runId: "run_live_stream",
    sequence,
    timestamp: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
    event,
  } as EventEnvelope);
}

terminal.start();
render({ type: "run_started", provider: "openai", model: "gpt-test" });
render({ type: "assistant_started", step: 1 });
render({ type: "reasoning_delta", text: "pty-reasoning-live", part: 0, visibility: "summary" });
render({ type: "text_delta", text: "pty-text-live", part: 0 });
render({ type: "tool_call_started", index: 0, name: "read" });
render({ type: "tool_call_delta", index: 0, jsonFragment: "{\"path\":\"pty-live-fragment" });
terminal.renderNow();
await new Promise<void>((resolve) => setImmediate(resolve));
process.stdout.write("\npty-before-canonical\n");

render({
  type: "tool_call_completed",
  index: 0,
  id: "pty-call",
  name: "read",
  rawArguments: "{\"path\":\"pty-live-fragment.ts\"}",
  arguments: { path: "pty-live-fragment.ts" },
});
render({
  type: "message_appended",
  message: {
    id: "pty-assistant-tool",
    role: "assistant",
    content: [
      { type: "text", text: "pty-text-live" },
      { type: "tool_call", callId: "pty-call", name: "read", arguments: { path: "pty-live-fragment.ts" } },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
  },
});
render({ type: "assistant_completed", finishReason: "tool_calls" });
render({ type: "tool_requested", callId: "pty-call", name: "read", input: { path: "pty-live-fragment.ts" }, index: 0 });
render({ type: "tool_started", callId: "pty-call", name: "read", input: {}, index: 0, recoveryMode: "repeatable" });
render({
  type: "tool_progress",
  callId: "pty-call",
  name: "read",
  index: 0,
  sequence: 0,
  progress: {
    type: "output",
    stream: "stdout",
    delta: "pty-tool-progress",
    stdoutBytes: 17,
    stderrBytes: 0,
  },
});
terminal.renderNow();
await new Promise<void>((resolve) => setImmediate(resolve));
process.stdout.write("\npty-before-tool-complete\n");

render({
  type: "tool_completed",
  callId: "pty-call",
  name: "read",
  index: 0,
  isError: false,
  preview: "pty-tool-complete",
  result: {
    type: "tool_result",
    callId: "pty-call",
    name: "read",
    content: "pty-tool-complete",
    isError: false,
  },
});
render({
  type: "message_appended",
  message: {
    id: "pty-tool-result",
    role: "tool",
    content: [{
      type: "tool_result",
      callId: "pty-call",
      name: "read",
      content: "pty-tool-complete",
      isError: false,
    }],
    createdAt: "2026-01-01T00:00:00.000Z",
  },
});
render({ type: "assistant_started", step: 2 });
render({ type: "text_delta", text: "pty-final-answer", part: 0 });
render({
  type: "message_appended",
  message: {
    id: "pty-final-message",
    role: "assistant",
    content: [{ type: "text", text: "pty-final-answer" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  },
});
render({ type: "assistant_completed", finishReason: "stop" });
render({ type: "run_completed", finishReason: "stop" });
terminal.renderNow();
await new Promise<void>((resolve) => setImmediate(resolve));
terminal.close();
process.stdout.write("pty-live-stream-complete\n");
