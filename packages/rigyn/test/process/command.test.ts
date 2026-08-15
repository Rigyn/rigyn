import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCommandArgv } from "../../src/process/command.js";

test("Windows batch commands are rejected before cmd.exe can interpret arguments", () => {
  for (const command of [String.raw`C:\tools\server.CMD`, String.raw`C:\tools\hook.bAt`]) {
    assert.throws(
      () => normalizeCommandArgv([command, "literal&whoami"], { platform: "win32", environment: {} }),
      /batch command wrappers are unsupported/u,
    );
  }
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
