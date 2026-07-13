import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";

import {
  minimalClipboardEnvironment,
  readClipboardImage,
  runClipboardCommand,
  type ClipboardCommandResult,
  type ClipboardCommandRunner,
  type ClipboardCommandSpec,
} from "../../src/images/clipboard.js";

function pngHeader(width = 1, height = 1): Buffer {
  const data = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.writeUInt32BE(13, 8);
  data.write("IHDR", 12, "ascii");
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

function jpegHeader(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
}

function success(stdout: Uint8Array): ClipboardCommandResult {
  return { ok: true, stdout, exitCode: 0, timedOut: false, outputLimited: false, aborted: false };
}

function missing(): ClipboardCommandResult {
  return {
    ok: false,
    stdout: new Uint8Array(),
    exitCode: null,
    errorCode: "ENOENT",
    timedOut: false,
    outputLimited: false,
    aborted: false,
  };
}

test("Wayland selects the preferred advertised image type with fixed argv", async () => {
  const calls: ClipboardCommandSpec[] = [];
  const runner: ClipboardCommandRunner = async (spec) => {
    calls.push(spec);
    if (spec.args[0] === "--list-types") return success(Buffer.from("text/plain\nimage/jpeg\nimage/png\n"));
    return success(pngHeader());
  };
  const result = await readClipboardImage({
    platform: "linux",
    environment: { PATH: "/bin", WAYLAND_DISPLAY: "wayland-1", XDG_RUNTIME_DIR: "/run/user/1" },
    runner,
    osRelease: "Linux",
  });
  assert.equal(result.image?.backend, "wayland");
  assert.equal(result.image?.mediaType, "image/png");
  assert.deepEqual(calls.map((call) => [call.command, ...call.args]), [
    ["wl-paste", "--list-types"],
    ["wl-paste", "--no-newline", "--type", "image/png"],
  ]);
  assert.equal(calls[1]?.maxOutputBytes, 32 * 1024 * 1024);
});

test("Wayland falls back to X11 and trusts bytes rather than the advertised MIME", async () => {
  const runner: ClipboardCommandRunner = async (spec) => {
    if (spec.command === "wl-paste") return missing();
    if (spec.args.includes("TARGETS")) return success(Buffer.from("image/png\n"));
    return success(jpegHeader());
  };
  const result = await readClipboardImage({
    platform: "linux",
    environment: { WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0" },
    runner,
    osRelease: "Linux",
  });
  assert.equal(result.image?.backend, "x11");
  assert.equal(result.image?.mediaType, "image/jpeg");
  assert.equal(result.diagnostics.some((entry) => entry.outcome === "invalid" && entry.detail.includes("advertised")), true);
});

test("WSL and Windows use bounded noninteractive PowerShell argv", async () => {
  for (const selected of [
    { platform: "linux" as const, environment: { WSL_DISTRO_NAME: "Ubuntu" } },
    { platform: "win32" as const, environment: { SystemRoot: "C:\\Windows" } },
  ]) {
    const calls: ClipboardCommandSpec[] = [];
    const result = await readClipboardImage({
      ...selected,
      osRelease: "Linux",
      runner: async (spec) => {
        calls.push(spec);
        return success(pngHeader());
      },
    });
    assert.equal(result.image?.backend, "powershell");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, "powershell.exe");
    assert.deepEqual(calls[0]?.args.slice(0, 5), ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command"]);
    assert.equal(calls[0]?.args.length, 6);
  }
});

test("Termux is detected without pretending its normal text clipboard is an image", async () => {
  const result = await readClipboardImage({
    platform: "linux",
    environment: { TERMUX_VERSION: "0.119", PREFIX: "/data/data/com.termux/files/usr" },
    osRelease: "Android",
    runner: async () => success(Buffer.from("clipboard text")),
  });
  assert.equal(result.image, undefined);
  assert.equal(result.diagnostics.some((entry) => entry.backend === "termux" && entry.detail.includes("text")), true);
});

test("macOS writes into a private temporary file passed as one argv value", async () => {
  let destination = "";
  const result = await readClipboardImage({
    platform: "darwin",
    environment: { PATH: "/usr/bin" },
    runner: async (spec) => {
      assert.equal(spec.command, "osascript");
      assert.equal(spec.args[0], "-e");
      destination = spec.args.at(-1) ?? "";
      await writeFile(destination, pngHeader());
      return success(Buffer.from("ok\n"));
    },
  });
  assert.equal(result.image?.backend, "macos");
  assert.equal(result.image?.mediaType, "image/png");
  assert.match(destination, /rigyn-clipboard-/u);
});

test("minimal helper environment drops credentials and runtime injection", () => {
  assert.deepEqual(minimalClipboardEnvironment({
    PATH: "/bin",
    DISPLAY: ":0",
    NODE_OPTIONS: "--require attacker.js",
    OPENAI_API_KEY: "secret",
    LANG: "user-controlled",
  }), { PATH: "/bin", DISPLAY: ":0", LANG: "C", LC_ALL: "C" });
});

test("command runner enforces output and time bounds without a shell", async () => {
  const environment = { PATH: process.env.PATH };
  const limited = await runClipboardCommand({
    command: process.execPath,
    args: ["-e", "process.stdout.write(Buffer.alloc(1024))"],
    environment,
    timeoutMs: 2_000,
    maxOutputBytes: 16,
  });
  assert.equal(limited.ok, false);
  assert.equal(limited.outputLimited, true);
  assert.equal(limited.stdout.byteLength, 0);

  const timedOut = await runClipboardCommand({
    command: process.execPath,
    args: ["-e", "setTimeout(() => undefined, 10_000)"],
    environment,
    timeoutMs: 50,
    maxOutputBytes: 16,
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.timedOut, true);
});
