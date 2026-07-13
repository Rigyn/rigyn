import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCommandArgv } from "../../src/process/command.js";

test("Windows batch commands use structured ComSpec argv without changing arguments", () => {
  const argv = normalizeCommandArgv([
    String.raw`C:\Program Files\Harness Tools\server.CMD`,
    "--stdio",
    "literal & value",
  ], {
    platform: "win32",
    environment: { cOmSpEc: String.raw`C:\Windows\System32\cmd.exe` },
  });

  assert.deepEqual(argv, [
    String.raw`C:\Windows\System32\cmd.exe`,
    "/d",
    "/s",
    "/v:off",
    "/c",
    String.raw`C:\Program Files\Harness Tools\server.CMD`,
    "--stdio",
    "literal & value",
  ]);
});

test("Windows batch normalization covers bat files and has a bounded ComSpec fallback", () => {
  assert.deepEqual(
    normalizeCommandArgv([String.raw`C:\tools\hook.bAt`, "one"], { platform: "win32", environment: {} }),
    ["cmd.exe", "/d", "/s", "/v:off", "/c", String.raw`C:\tools\hook.bAt`, "one"],
  );
});

test("ordinary Windows executables and non-Windows batch paths remain direct argv", () => {
  const executable = [String.raw`C:\Program Files\Editor\editor.exe`, "--wait"];
  const batch = [String.raw`C:\tools\server.cmd`, "--stdio"];
  assert.deepEqual(normalizeCommandArgv(executable, { platform: "win32", environment: {} }), executable);
  assert.deepEqual(normalizeCommandArgv(batch, { platform: "linux", environment: {} }), batch);
});

test("command normalization rejects an empty or NUL command", () => {
  assert.throws(() => normalizeCommandArgv([]), /non-empty command/u);
  assert.throws(() => normalizeCommandArgv(["bad\0command"]), /without NUL/u);
});
