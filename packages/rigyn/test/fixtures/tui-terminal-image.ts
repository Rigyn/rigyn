import { TuiController } from "../../src/tui/controller.js";
import type { EventEnvelope } from "../../src/core/events.js";

function png(): Buffer {
  const data = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.writeUInt32BE(13, 8);
  data.write("IHDR", 12, "ascii");
  data.writeUInt32BE(20, 16);
  data.writeUInt32BE(10, 20);
  return data;
}

const controller = new TuiController({ handleSignals: false });
controller.start();
const event: EventEnvelope = {
  eventId: "terminal-image-pty-event",
  threadId: "terminal-image-pty-thread",
  runId: "terminal-image-pty-run",
  sequence: 1,
  timestamp: "2026-01-01T00:00:00.000Z",
  schemaVersion: 1,
  event: {
    type: "message_appended",
    message: {
      id: "terminal-image-pty-message",
      role: "user",
      content: [
        { type: "text", text: "terminal-image-pty-caption" },
        { type: "image", mediaType: "image/png", data: png().toString("base64") },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  },
};
controller.render(event);
await new Promise<void>((resolve) => setImmediate(resolve));
controller.close();
process.stdout.write("terminal-image-pty-complete\n");
