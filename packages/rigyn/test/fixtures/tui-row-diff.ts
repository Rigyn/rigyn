import type { EventEnvelope } from "../../src/core/events.js";
import { TuiController } from "../../src/tui/controller.js";
import type { RuntimeUiComponentHost } from "../../src/tui/components.js";

const terminal = new TuiController({ handleSignals: false });
terminal.start();
terminal.render({
  eventId: "evt_committed",
  threadId: "thr_surface",
  runId: "run_surface",
  sequence: 1,
  timestamp: "2026-01-01T00:00:00.000Z",
  schemaVersion: 1,
  event: {
    type: "message_appended",
    message: {
      id: "committed",
      role: "user",
      content: [{ type: "text", text: "row-diff-committed" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  },
} as EventEnvelope);
await new Promise<void>((resolve) => setImmediate(resolve));

let rows = ["surface-initial"];
let host: RuntimeUiComponentHost<string> | undefined;
const result = terminal.custom<string>((selectedHost) => {
  host = selectedHost;
  return {
    render: () => ({
      lines: rows.map((text) => ({ spans: [{ text, role: "accent" as const }] })),
      cursor: { row: Math.max(0, rows.length - 1), column: 0 },
    }),
  };
});
await new Promise<void>((resolve) => setImmediate(resolve));
rows = ["surface-expanded-0", "surface-expanded-1", "surface-expanded-2"];
host?.requestRender();
await new Promise<void>((resolve) => setImmediate(resolve));
rows = ["surface-shrunk"];
host?.requestRender();
await new Promise<void>((resolve) => setImmediate(resolve));
host?.close("done");
await result;
await new Promise<void>((resolve) => setImmediate(resolve));
terminal.close();
process.stdout.write("row-diff-pty-complete\n");
