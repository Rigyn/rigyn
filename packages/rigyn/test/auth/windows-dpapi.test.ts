import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { SecretRedactor } from "../../src/auth/redaction.js";
import {
  isWindowsDpapiEnvelope,
  protectWindowsCredentialKey,
  unprotectWindowsCredentialKey,
  type WindowsDpapiRunner,
} from "../../src/auth/windows-dpapi.js";

test("Windows DPAPI keeps the credential key out of argv and round-trips a current-user envelope", async () => {
  const key = Buffer.alloc(32, 17);
  const protectedValue = Buffer.alloc(96, 23).toString("base64");
  const environment = {
    SystemRoot: "C:\\Windows",
    TEMP: "C:\\Temp",
    OPENAI_API_KEY: "must-not-reach-powershell",
  };
  const calls: Parameters<WindowsDpapiRunner>[0][] = [];
  const runner: WindowsDpapiRunner = async (options) => {
    calls.push(options);
    const script = options.args?.at(-1) ?? "";
    return {
      exitCode: 0,
      stdout: script.includes("::Protect") ? protectedValue : key.toString("base64"),
      stderr: "",
    };
  };
  const envelope = await protectWindowsCredentialKey(key, { runner, command: "powershell.exe", environment });
  assert.equal(isWindowsDpapiEnvelope(envelope), true);
  assert.equal(envelope, `dpapi:v1:${protectedValue}`);
  assert.equal(calls[0]?.input, undefined);
  assert.equal(JSON.stringify(calls[0]?.args).includes(key.toString("base64")), false);
  assert.equal(calls[0]?.environment?.RIGYN_DPAPI_INPUT, key.toString("base64"));
  assert.match(
    calls[0]?.args?.at(-1) ?? "",
    /^\$source=\$env:RIGYN_DPAPI_INPUT;\$env:RIGYN_DPAPI_INPUT=\$null;\[void\]\[System\.Reflection\.Assembly\]::Load\('System\.Security,/u,
  );
  assert.match(calls[0]?.args?.at(-1) ?? "", /CurrentUser/u);
  assert.equal(calls[0]?.environment?.SystemRoot, environment.SystemRoot);
  assert.equal(calls[0]?.environment?.TEMP, environment.TEMP);
  assert.equal(calls[0]?.environment?.OPENAI_API_KEY, undefined);
  assert.equal(calls[0]?.timeoutMs, 10_000);

  const restored = await unprotectWindowsCredentialKey(envelope, { runner, command: "powershell.exe", environment });
  assert.deepEqual(restored, key);
  assert.equal(calls[1]?.input, undefined);
  assert.equal(calls[1]?.environment?.RIGYN_DPAPI_INPUT, protectedValue);
  assert.match(calls[1]?.args?.at(-1) ?? "", /Unprotect/u);
});

test("Windows DPAPI performs a real current-user Protect and Unprotect round trip", {
  skip: process.platform !== "win32",
}, async () => {
  const key = randomBytes(32);
  const envelope = await protectWindowsCredentialKey(key);
  assert.equal(isWindowsDpapiEnvelope(envelope), true);
  assert.equal(envelope.includes(key.toString("base64")), false);
  assert.deepEqual(await unprotectWindowsCredentialKey(envelope), key);
});

test("Windows DPAPI validates envelopes, plaintext size, and redacts command failures", async () => {
  await assert.rejects(unprotectWindowsCredentialKey("raw-key"), /supported DPAPI envelope/u);
  await assert.rejects(unprotectWindowsCredentialKey("dpapi:v1:not base64"), /bounded base64/u);
  await assert.rejects(protectWindowsCredentialKey(Buffer.alloc(31)), /exactly 32 bytes/u);

  const secret = Buffer.alloc(32, 41).toString("base64");
  const redactor = new SecretRedactor();
  await assert.rejects(
    protectWindowsCredentialKey(Buffer.from(secret, "base64"), {
      command: "powershell.exe",
      redactor,
      runner: async () => ({ exitCode: 1, stdout: "", stderr: `failure ${secret}` }),
    }),
    (error: unknown) => {
      assert.match(String(error), /failure/u);
      assert.equal(String(error).includes(secret), false);
      return true;
    },
  );

  const protectedValue = Buffer.alloc(64, 2).toString("base64");
  await assert.rejects(
    unprotectWindowsCredentialKey(`dpapi:v1:${protectedValue}`, {
      command: "powershell.exe",
      runner: async () => ({ exitCode: 0, stdout: Buffer.alloc(16).toString("base64"), stderr: "" }),
    }),
    /32-byte credential key/u,
  );
});
