import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  copyToNativeClipboard,
  readClipboardText,
} from "../../src/images/clipboard-text.js";
import type { ClipboardCommandSpec } from "../../src/images/clipboard.js";

test("clipboard text uses the detected native reader with bounded argv execution", async () => {
  const calls: ClipboardCommandSpec[] = [];
  const result = await readClipboardText({
    platform: "linux",
    environment: { WAYLAND_DISPLAY: "wayland-0" },
    runner: async (spec) => {
      calls.push(spec);
      return {
        ok: true,
        stdout: Buffer.from("clipboard text"),
        exitCode: 0,
        timedOut: false,
        outputLimited: false,
        aborted: false,
      };
    },
  });
  assert.deepEqual(result, { text: "clipboard text", backend: "wayland" });
  assert.equal(calls[0]?.command, "wl-paste");
  assert.deepEqual(calls[0]?.args, ["--no-newline", "--type", "text/plain;charset=utf-8"]);
});

test("native clipboard copy writes exact text and rejects oversized payloads", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-clipboard-text-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const command = join(root, "wl-copy");
  await writeFile(command, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
writeFileSync(process.env.HOME + "/copied.txt", Buffer.concat(chunks));
`);
  await chmod(command, 0o700);
  const backend = await copyToNativeClipboard("exact\nclipboard", {
    platform: "linux",
    environment: { PATH: `${root}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, WAYLAND_DISPLAY: "wayland-0" },
  });
  assert.equal(backend, "wayland");
  assert.equal(await readFile(join(root, "copied.txt"), "utf8"), "exact\nclipboard");
  await assert.rejects(copyToNativeClipboard("x".repeat(100 * 1024 + 1)), /100 KiB/u);
});
