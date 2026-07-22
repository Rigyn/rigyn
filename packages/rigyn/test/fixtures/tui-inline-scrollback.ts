import type { EventEnvelope, RuntimeEvent } from "../../src/core/events.js";
import { TuiController } from "../../src/tui/controller.js";

const terminal = new TuiController({ handleSignals: false });
let sequence = 0;

function render(runId: string, event: RuntimeEvent): void {
  sequence += 1;
  terminal.render({
    eventId: `evt_${sequence}`,
    threadId: "thr_inline_scroll",
    runId,
    sequence,
    timestamp: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
    event,
  } as EventEnvelope);
}

terminal.start();
for (let index = 0; index < 30; index += 1) {
  const suffix = String(index).padStart(2, "0");
  const runId = `run_${suffix}`;
  render(runId, {
    type: "message_appended",
    message: {
      id: `user_${suffix}`,
      role: "user",
      content: [{ type: "text", text: `scroll-user-${suffix}` }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  });
  render(runId, { type: "assistant_started", step: 1 });
  render(runId, { type: "text_delta", text: `scroll-agent-${suffix}`, part: 0 });
  render(runId, {
    type: "message_appended",
    message: {
      id: `assistant_${suffix}`,
      role: "assistant",
      content: [{ type: "text", text: `scroll-agent-${suffix}` }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  });
  render(runId, { type: "assistant_completed", finishReason: "stop" });
}
await new Promise<void>((resolve) => setImmediate(resolve));
terminal.close();
process.stdout.write("inline-scrollback-complete\n");
