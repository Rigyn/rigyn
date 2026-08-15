import { spawnSync } from "node:child_process";
import type { EventEnvelope, RuntimeEvent } from "../../src/core/events.js";
import { TuiController } from "../../src/tui/controller.js";

const terminal = new TuiController({ handleSignals: false });
let sequence = 0;
let expansionKeys = 0;

function render(event: RuntimeEvent): void {
  sequence += 1;
  terminal.render({
    eventId: `evt_${sequence}`,
    threadId: "thr_inline_expand_resize",
    runId: "run_inline_expand_resize",
    sequence,
    timestamp: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
    event,
  } as EventEnvelope);
}

terminal.start();
render({
  type: "message_appended",
  message: {
    id: "pty-user",
    role: "user",
    content: [{ type: "text", text: "inspect pty chronology" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  },
});
render({
  type: "message_appended",
  message: {
    id: "pty-tool-request",
    role: "assistant",
    content: [{
      type: "tool_call",
      callId: "pty-call",
      name: "read",
      arguments: { path: "pty.txt" },
    }],
    stopReason: "tool_calls",
    createdAt: "2026-01-01T00:00:01.000Z",
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
      content: [
        "pty-visible-head",
        ...Array.from({ length: 9 }, (_, index) => `pty-detail-${index + 1}`),
        "pty-expanded-tail",
      ].join("\n"),
      isError: false,
    }],
    createdAt: "2026-01-01T00:00:02.000Z",
  },
});
render({
  type: "message_appended",
  message: {
    id: "pty-final",
    role: "assistant",
    content: [{ type: "text", text: "pty-final-answer" }],
    stopReason: "stop",
    createdAt: "2026-01-01T00:00:03.000Z",
  },
});
render({ type: "assistant_completed", finishReason: "stop" });

process.stdin.on("data", (chunk: Buffer | string) => {
  const selected = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  for (const byte of selected) {
    if (byte !== 15) continue;
    expansionKeys += 1;
    if (expansionKeys === 1) {
      setTimeout(() => {
        spawnSync("stty", ["cols", "72", "rows", "18"], { stdio: "inherit" });
        process.stdout.emit("resize");
        terminal.setTransientStatus("pty-width-resized");
        terminal.renderNow();
      }, 25);
    } else if (expansionKeys === 2) {
      setTimeout(() => {
        terminal.close();
        process.stdout.write("pty-expand-resize-complete\n");
      }, 25);
    }
  }
});

await new Promise<void>((resolve) => process.once("beforeExit", resolve));
