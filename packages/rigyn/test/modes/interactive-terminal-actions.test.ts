import assert from "node:assert/strict";
import test from "node:test";

import { SettingsManager } from "../../src/core/settings-manager.js";
import { attachClipboardImage } from "../../src/modes/interactive-terminal-actions.js";
import type { TuiInputImageAttachment } from "../../src/tui/types.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function terminalFixture() {
  const attachments: TuiInputImageAttachment[] = [];
  const notifications: Array<{ message: string; kind?: string }> = [];
  const blocked: Array<[string | undefined, string | undefined]> = [];
  const insertedText: string[] = [];
  return {
    attachments,
    notifications,
    blocked,
    insertedText,
    terminal: {
      attachInputImage(attachment: TuiInputImageAttachment) {
        attachments.push(attachment);
        return attachments.length;
      },
      notify(message: string, kind?: "status" | "warning" | "error") {
        notifications.push({ message, ...(kind === undefined ? {} : { kind }) });
      },
      setInputBlocked(message?: string, label?: string) {
        blocked.push([message, label]);
      },
      insertClipboardText(text: string) {
        insertedText.push(text);
      },
    },
  };
}

test("clipboard image action validates and attaches image bytes without exposing them in output", async () => {
  const fixture = terminalFixture();
  const settings = SettingsManager.inMemory({ images: { autoResize: true } });
  const attached = await attachClipboardImage(fixture.terminal, settings, undefined, {
    async readClipboardImage() {
      return {
        image: { bytes: PNG_1X1, mediaType: "image/png", backend: "wayland" },
        diagnostics: [],
      };
    },
  });

  assert.equal(attached, true);
  assert.equal(fixture.attachments.length, 1);
  assert.equal(fixture.attachments[0]?.label, "clipboard");
  assert.equal(fixture.attachments[0]?.coordinates.width, 1);
  assert.deepEqual(fixture.blocked, [["Reading clipboard…", "clipboard"], [undefined, undefined]]);
  assert.match(fixture.notifications[0]?.message ?? "", /Attached clipboard image/u);
  assert.equal(fixture.notifications.some((entry) => entry.message.includes(PNG_1X1.toString("base64"))), false);
});

test("clipboard image action reports unavailable and policy-blocked inputs without attaching data", async () => {
  const unavailable = terminalFixture();
  const settings = SettingsManager.inMemory();
  let reads = 0;
  assert.equal(await attachClipboardImage(unavailable.terminal, settings, undefined, {
    async readClipboardImage() {
      reads += 1;
      return {
        diagnostics: [{ backend: "x11", outcome: "empty", detail: "Clipboard has no image" }],
      };
    },
    async readClipboardText() { return {}; },
  }), false);
  assert.equal(reads, 1);
  assert.deepEqual(unavailable.attachments, []);
  assert.deepEqual(unavailable.notifications, [{ message: "Clipboard has no image", kind: "warning" }]);
  assert.deepEqual(unavailable.blocked, [["Reading clipboard…", "clipboard"], [undefined, undefined]]);

  const blocked = terminalFixture();
  const blockedSettings = SettingsManager.inMemory({ images: { blockImages: true } });
  assert.equal(await attachClipboardImage(blocked.terminal, blockedSettings, undefined, {
    async readClipboardImage() {
      reads += 1;
      return { diagnostics: [] };
    },
    async readClipboardText() { return {}; },
  }), false);
  assert.equal(reads, 1, "blocked image input must not touch the system clipboard");
  assert.deepEqual(blocked.notifications, [{ message: "Image inputs are disabled in settings", kind: "warning" }]);
  assert.deepEqual(blocked.blocked, [["Reading clipboard…", "clipboard"], [undefined, undefined]]);
});

test("clipboard image action inserts text at the editor cursor when no image is available", async () => {
  const fixture = terminalFixture();
  const settings = SettingsManager.inMemory();
  const attached = await attachClipboardImage(fixture.terminal, settings, undefined, {
    async readClipboardImage() {
      return { diagnostics: [{ backend: "x11", outcome: "empty", detail: "Clipboard has no image" }] };
    },
    async readClipboardText() {
      return { text: "clipboard text", backend: "wayland" };
    },
  });

  assert.equal(attached, true);
  assert.deepEqual(fixture.attachments, []);
  assert.deepEqual(fixture.insertedText, ["clipboard text"]);
  assert.deepEqual(fixture.notifications, []);
  assert.deepEqual(fixture.blocked, [["Reading clipboard…", "clipboard"], [undefined, undefined]]);
});
