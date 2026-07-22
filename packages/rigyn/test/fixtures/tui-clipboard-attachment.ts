import { createHash } from "node:crypto";

import { TuiController } from "../../src/tui/controller.js";

function png(width: number, height: number): Buffer {
  const data = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.writeUInt32BE(13, 8);
  data.write("IHDR", 12, "ascii");
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

const bytes = png(12, 8);
const controller = new TuiController({
  input: process.stdin,
  output: process.stdout,
  environment: { TERM: "xterm-256color", NO_COLOR: "1", RIGYN_SYNC_UPDATE: "0" },
  handleSignals: false,
  onAction: (action) => {
    if (action.type !== "paste_image") return;
    controller.attachInputImage({
      block: { type: "image", mediaType: "image/png", data: bytes.toString("base64") },
      label: "clipboard-pty",
      coordinates: {
        originalWidth: 12,
        originalHeight: 8,
        width: 12,
        height: 8,
        scaleX: 1,
        scaleY: 1,
        orientationApplied: false,
        resized: false,
        converted: false,
      },
    });
  },
});

controller.start();
try {
  const answer = await controller.question("Clipboard prompt: ");
  const images = controller.takeSubmittedImages();
  controller.close();
  const digest = createHash("sha256").update(Buffer.from(images[0]?.block.data ?? "", "base64")).digest("hex").slice(0, 12);
  process.stdout.write(`clipboard-pty:${answer}:${images.length}:${digest}\n`);
} catch (error) {
  controller.close();
  process.stdout.write(`clipboard-pty-error:${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
