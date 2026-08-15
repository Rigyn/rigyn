import { appendFileSync } from "node:fs";

import type { EventEnvelope, RuntimeEvent } from "../../src/core/events.js";
import { TuiController } from "../../src/tui/controller.js";

const markerPath = process.env.RIGYN_CTRL_O_PTY_MARKERS;
if (markerPath === undefined || markerPath === "") throw new Error("RIGYN_CTRL_O_PTY_MARKERS is required");

const terminal = new TuiController({ handleSignals: false });
let sequence = 0;

function mark(value: string): void {
  appendFileSync(markerPath!, `${value}\n`);
}

function render(event: RuntimeEvent): void {
  sequence += 1;
  terminal.render({
    eventId: `evt_${sequence}`,
    threadId: "thr_ctrl_o_pty",
    runId: "run_ctrl_o_pty",
    sequence,
    timestamp: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
    event,
  } as EventEnvelope);
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function completeRead(callId: string, content: string, index: number): void {
  render({
    type: "tool_completed",
    callId,
    name: "read",
    index,
    isError: false,
    preview: content,
    result: {
      type: "tool_result",
      callId,
      name: "read",
      content,
      isError: false,
    },
  });
  render({
    type: "message_appended",
    message: {
      id: `${callId}-result`,
      role: "tool",
      content: [{ type: "tool_result", callId, name: "read", content, isError: false }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  });
}

try {
  terminal.start();
  render({ type: "run_started", provider: "local-pty", model: "deterministic-tool-stream" });
  render({
    type: "tool_requested",
    callId: "current-tool",
    name: "read",
    input: { path: "current-tool.txt" },
    index: 0,
  });
  render({ type: "tool_started", callId: "current-tool", name: "read", input: {}, index: 0, recoveryMode: "repeatable" });
  const liveOutput = Array.from({ length: 6 }, (_, index) => `current-live-${index + 1}`).join("\n");
  render({
    type: "tool_progress",
    callId: "current-tool",
    name: "read",
    index: 0,
    sequence: 0,
    progress: {
      type: "output",
      stream: "stdout",
      delta: liveOutput,
      stdoutBytes: Buffer.byteLength(liveOutput),
      stderrBytes: 0,
    },
  });
  terminal.renderNow();
  mark(`ready:${terminal.getToolOutputExpanded()}`);

  await waitFor(
    () => terminal.getToolOutputExpanded(),
    "Ctrl+O did not expand the running tool",
  );
  mark(`expanded:${terminal.getToolOutputExpanded()}`);

  const currentContent = [
    ...Array.from({ length: 11 }, (_, index) => `current-result-${index + 1}`),
    "current-expanded-tail-sentinel",
  ].join("\n");
  completeRead("current-tool", currentContent, 0);

  render({
    type: "tool_requested",
    callId: "later-tool",
    name: "read",
    input: { path: "later-tool.txt" },
    index: 1,
  });
  render({ type: "tool_started", callId: "later-tool", name: "read", input: {}, index: 1, recoveryMode: "repeatable" });
  const laterContent = [
    ...Array.from({ length: 11 }, (_, index) => `later-result-${index + 1}`),
    "later-inherited-tail-sentinel",
  ].join("\n");
  completeRead("later-tool", laterContent, 1);
  terminal.renderNow();
  mark(`later:${terminal.getToolOutputExpanded()}`);

  await waitFor(
    () => !terminal.getToolOutputExpanded(),
    "the second Ctrl+O did not collapse every tool",
  );
  terminal.renderNow();
  mark(`collapsed:${terminal.getToolOutputExpanded()}`);

  terminal.close();
  process.stdout.write("ctrl-o-pty-complete\n");
} catch (error) {
  terminal.close();
  process.stderr.write(`ctrl-o-pty-error:${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
