import assert from "node:assert/strict";
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
  const envelope = await protectWindowsCredentialKey(key, { runner, command: "powershell.exe" });
  assert.equal(isWindowsDpapiEnvelope(envelope), true);
  assert.equal(envelope, `dpapi:v1:${protectedValue}`);
  assert.equal(calls[0]?.input, `${key.toString("base64")}\n`);
  assert.doesNotMatch(JSON.stringify(calls[0]?.args), new RegExp(key.toString("base64"), "u"));
  assert.match(calls[0]?.args?.at(-1) ?? "", /CurrentUser/u);

  const restored = await unprotectWindowsCredentialKey(envelope, { runner, command: "powershell.exe" });
  assert.deepEqual(restored, key);
  assert.equal(calls[1]?.input, `${protectedValue}\n`);
  assert.match(calls[1]?.args?.at(-1) ?? "", /Unprotect/u);
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
      assert.doesNotMatch(String(error), new RegExp(secret, "u"));
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

