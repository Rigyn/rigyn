import assert from "node:assert/strict";
import test from "node:test";

import { commandShellArgv, commandShellCandidates, resolveCommandShell } from "../../src/process/command-shell.js";

test("Windows command shell discovery prefers PATH then common Bash installations", async () => {
  const environment = {
    Path: String.raw`C:\Tools;"C:\Program Files\Custom Bin";relative`,
    ProgramFiles: String.raw`C:\Program Files`,
    LOCALAPPDATA: String.raw`C:\Users\me\AppData\Local`,
    SystemDrive: "C:",
  };
  assert.deepEqual(commandShellCandidates({ platform: "win32", environment }).slice(0, 5), [
    String.raw`C:\Tools\bash.exe`,
    String.raw`C:\Program Files\Custom Bin\bash.exe`,
    String.raw`C:\Program Files\Git\bin\bash.exe`,
    String.raw`C:\Program Files\Git\usr\bin\bash.exe`,
    String.raw`C:\Users\me\AppData\Local\Programs\Git\bin\bash.exe`,
  ]);
  const inspected: string[] = [];
  const selected = await resolveCommandShell({
    platform: "win32",
    environment,
    inspect: async (candidate) => {
      inspected.push(candidate);
      return candidate.endsWith(String.raw`Git\bin\bash.exe`) ? candidate : undefined;
    },
  });
  assert.equal(selected, String.raw`C:\Program Files\Git\bin\bash.exe`);
  assert.deepEqual(inspected, commandShellCandidates({ platform: "win32", environment }).slice(0, 3));
});

test("configured command shell is absolute, authoritative, and uses -c", async () => {
  const configuredPath = String.raw`C:\PortableGit\bin\bash.exe`;
  assert.deepEqual(await commandShellArgv("printf hello", {
    platform: "win32",
    configuredPath,
    inspect: async (candidate) => candidate,
  }), [configuredPath, "-c", "printf hello"]);
  await assert.rejects(resolveCommandShell({
    platform: "win32",
    configuredPath,
    inspect: async () => undefined,
  }), /Configured shellPath is not an executable file/u);
  await assert.rejects(resolveCommandShell({
    platform: "win32",
    configuredPath: "relative/bash.exe",
    inspect: async () => undefined,
  }), /absolute path/u);
});

test("missing Windows Bash reports an actionable setup error", async () => {
  await assert.rejects(resolveCommandShell({
    platform: "win32",
    environment: {},
    inspect: async () => undefined,
  }), /Git for Windows.*shellPath/u);
});
